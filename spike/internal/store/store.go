// Package store is the HOHE Phase 2 spike's in-memory, synthetic-only data store.
//
// It implements the parts of the proposal's synchronization model the spike must prove:
// operations with unique ids (duplicate-safe replay), per-field revisions, a conflict tray
// for a stale same-field edit, and queued edits that depend on an earlier queued edit being
// held with it. Nothing is persisted: restarting the process loses everything.
package store

import (
	"errors"
	"fmt"
	"sort"
	"strings"
	"sync"
	"time"
)

// Editable task fields. Revisions are tracked per field.
var editableFields = map[string]bool{"title": true, "notes": true, "priority": true}

// Limits that keep a misbehaving client from exhausting memory.
const (
	MaxTasks      = 1000
	MaxOps        = 20000
	MaxValueBytes = 2000
)

// Task is one synthetic task.
type Task struct {
	ID         string         `json:"id"`
	Title      string         `json:"title"`
	Notes      string         `json:"notes"`
	Priority   string         `json:"priority"`
	PlannerDay string         `json:"plannerDay"`
	Revisions  map[string]int `json:"revisions"`
	CreatedBy  string         `json:"createdBy"`
}

func (t *Task) get(field string) string {
	switch field {
	case "title":
		return t.Title
	case "notes":
		return t.Notes
	default:
		return t.Priority
	}
}

func (t *Task) set(field, v string) {
	switch field {
	case "title":
		t.Title = v
	case "notes":
		t.Notes = v
	default:
		t.Priority = v
	}
}

func (t *Task) clone() *Task {
	c := *t
	c.Revisions = make(map[string]int, len(t.Revisions))
	for k, v := range t.Revisions {
		c.Revisions[k] = v
	}
	return &c
}

// Op is one client operation.
type Op struct {
	ID               string `json:"id"`
	DeviceID         string `json:"deviceId"`
	Type             string `json:"type"` // "capture" or "edit"
	TaskID           string `json:"taskId,omitempty"`
	Field            string `json:"field,omitempty"`
	Value            string `json:"value"`
	BaseRevision     *int   `json:"baseRevision,omitempty"`
	DependsOn        string `json:"dependsOn,omitempty"`
	Resolves         string `json:"resolves,omitempty"`
	ClientPlannerDay string `json:"clientPlannerDay,omitempty"`
	ClientTime       string `json:"clientTime,omitempty"`
}

// Result statuses.
const (
	Applied  = "applied"
	Noop     = "noop"
	Conflict = "conflict"
	Held     = "held"
	Rejected = "rejected"
)

// Result is the outcome of one operation. A replayed operation returns its original
// result with Replayed set.
type Result struct {
	OpID               string `json:"opId"`
	Status             string `json:"status"`
	Replayed           bool   `json:"replayed"`
	Task               *Task  `json:"task,omitempty"`
	Revision           int    `json:"revision,omitempty"`
	ConflictID         string `json:"conflictId,omitempty"`
	Reason             string `json:"reason,omitempty"`
	ServerPlannerDay   string `json:"serverPlannerDay,omitempty"`
	PlannerDayMismatch bool   `json:"plannerDayMismatch,omitempty"`
}

// ConflictEntry is one item in the conflict tray.
type ConflictEntry struct {
	ID             string `json:"id"`
	OpID           string `json:"opId"`
	DeviceID       string `json:"deviceId"`
	TaskID         string `json:"taskId"`
	Field          string `json:"field"`
	ServerValue    string `json:"serverValue"`
	ServerRevision int    `json:"serverRevision"`
	ProposedValue  string `json:"proposedValue"`
	BaseRevision   int    `json:"baseRevision"`
	HeldOps        []Op   `json:"heldOps"`
	Status         string `json:"status"` // "open", "resolved-server", "resolved-mine"
	CreatedAt      string `json:"createdAt"`
}

// Stats are counters the Phase 2 checks read.
type Stats struct {
	OpsApplied      int `json:"opsApplied"`
	OpsReplayed     int `json:"opsReplayed"`
	ConflictsOpened int `json:"conflictsOpened"`
	OpsHeld         int `json:"opsHeld"`
}

// Store holds everything in memory, guarded by one mutex.
type Store struct {
	mu        sync.Mutex
	tasks     map[string]*Task
	order     []string
	results   map[string]Result
	conflicts map[string]*ConflictEntry
	corder    []string
	stats     Stats
	seq       int
	dayFn     func(time.Time) string
	now       func() time.Time
}

// New returns an empty store. dayFn computes the server planner day for an instant.
func New(dayFn func(time.Time) string) *Store {
	s := &Store{dayFn: dayFn, now: time.Now}
	s.reset()
	return s
}

func (s *Store) reset() {
	s.tasks = map[string]*Task{}
	s.order = nil
	s.results = map[string]Result{}
	s.conflicts = map[string]*ConflictEntry{}
	s.corder = nil
	s.stats = Stats{}
	s.seq = 0
}

// Reset clears everything and loads the synthetic seed.
func (s *Store) Reset(seed bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.reset()
	if seed {
		day := s.dayFn(s.now())
		for i, title := range []string{"Water the synthetic ferns", "Call the imaginary dentist", "Sort the example receipts"} {
			id := fmt.Sprintf("seed-%d", i+1)
			s.tasks[id] = &Task{ID: id, Title: title, Priority: []string{"A", "B", "C"}[i], PlannerDay: day,
				Revisions: map[string]int{"title": 1, "notes": 1, "priority": 1}, CreatedBy: "seed"}
			s.order = append(s.order, id)
		}
	}
}

// Snapshot returns copies of all tasks, open and closed conflicts, and stats.
func (s *Store) Snapshot() ([]*Task, []*ConflictEntry, Stats) {
	s.mu.Lock()
	defer s.mu.Unlock()
	tasks := make([]*Task, 0, len(s.order))
	for _, id := range s.order {
		tasks = append(tasks, s.tasks[id].clone())
	}
	cs := make([]*ConflictEntry, 0, len(s.corder))
	for _, id := range s.corder {
		c := *s.conflicts[id]
		// Copy into a non-nil slice: an empty list must encode as [] (not null), which the
		// client renders directly.
		c.HeldOps = append([]Op{}, c.HeldOps...)
		cs = append(cs, &c)
	}
	return tasks, cs, s.stats
}

// Apply processes a batch in order and returns one result per op.
func (s *Store) Apply(ops []Op) []Result {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]Result, 0, len(ops))
	for _, op := range ops {
		out = append(out, s.applyOne(op))
	}
	return out
}

func (s *Store) applyOne(op Op) Result {
	if op.ID == "" {
		return Result{Status: Rejected, Reason: "missing op id"}
	}
	if prev, ok := s.results[op.ID]; ok {
		s.stats.OpsReplayed++
		prev.Replayed = true
		if prev.Task != nil {
			if t, ok := s.tasks[prev.Task.ID]; ok {
				prev.Task = t.clone() // current state; the outcome itself is the original
			}
		}
		return prev
	}
	if len(s.results) >= MaxOps {
		return Result{OpID: op.ID, Status: Rejected, Reason: "spike operation limit reached"}
	}
	if len(op.Value) > MaxValueBytes {
		return s.record(op, Result{OpID: op.ID, Status: Rejected, Reason: "value too long"})
	}
	serverDay := s.dayFn(s.now())
	var r Result
	switch op.Type {
	case "capture":
		r = s.capture(op, serverDay)
	case "edit":
		r = s.edit(op)
	default:
		r = Result{OpID: op.ID, Status: Rejected, Reason: fmt.Sprintf("unknown op type %q", op.Type)}
	}
	r.ServerPlannerDay = serverDay
	if op.ClientPlannerDay != "" && op.ClientPlannerDay != serverDay {
		r.PlannerDayMismatch = true
	}
	return s.record(op, r)
}

func (s *Store) record(op Op, r Result) Result {
	s.results[op.ID] = r
	if r.Status == Applied || r.Status == Noop {
		s.stats.OpsApplied++
	}
	return r
}

func (s *Store) capture(op Op, serverDay string) Result {
	title := strings.TrimSpace(op.Value)
	if title == "" {
		return Result{OpID: op.ID, Status: Rejected, Reason: "empty title"}
	}
	if len(s.tasks) >= MaxTasks {
		return Result{OpID: op.ID, Status: Rejected, Reason: "spike task limit reached"}
	}
	s.seq++
	id := fmt.Sprintf("t-%d", s.seq)
	t := &Task{ID: id, Title: title, PlannerDay: serverDay,
		Revisions: map[string]int{"title": 1, "notes": 1, "priority": 1}, CreatedBy: op.DeviceID}
	s.tasks[id] = t
	s.order = append(s.order, id)
	return Result{OpID: op.ID, Status: Applied, Task: t.clone(), Revision: 1}
}

var errHeld = errors.New("held")

// base resolves the revision an edit was based on: either explicit, or the revision its
// dependency produced. errHeld means the dependency is in the conflict tray.
func (s *Store) base(op Op) (int, *ConflictEntry, error) {
	if op.DependsOn != "" {
		dep, ok := s.results[op.DependsOn]
		if !ok {
			return 0, nil, fmt.Errorf("unknown dependency %s", op.DependsOn)
		}
		switch dep.Status {
		case Applied, Noop:
			return dep.Revision, nil, nil
		case Conflict:
			return 0, s.conflicts[dep.ConflictID], errHeld
		case Held:
			return 0, s.conflicts[dep.ConflictID], errHeld
		default:
			return 0, nil, fmt.Errorf("dependency %s was %s", op.DependsOn, dep.Status)
		}
	}
	if op.BaseRevision == nil {
		return 0, nil, errors.New("edit needs baseRevision or dependsOn")
	}
	return *op.BaseRevision, nil, nil
}

func (s *Store) edit(op Op) Result {
	t, ok := s.tasks[op.TaskID]
	if !ok {
		return Result{OpID: op.ID, Status: Rejected, Reason: "unknown task"}
	}
	if !editableFields[op.Field] {
		return Result{OpID: op.ID, Status: Rejected, Reason: fmt.Sprintf("field %q is not editable", op.Field)}
	}
	if op.Field == "title" && strings.TrimSpace(op.Value) == "" {
		return Result{OpID: op.ID, Status: Rejected, Reason: "empty title"}
	}
	base, held, err := s.base(op)
	if errors.Is(err, errHeld) {
		held.HeldOps = append(held.HeldOps, op)
		s.stats.OpsHeld++
		return Result{OpID: op.ID, Status: Held, ConflictID: held.ID, Task: t.clone(),
			Reason: "depends on an operation in the conflict tray"}
	}
	if err != nil {
		return Result{OpID: op.ID, Status: Rejected, Reason: err.Error()}
	}
	cur := t.Revisions[op.Field]
	if base == cur {
		t.set(op.Field, op.Value)
		t.Revisions[op.Field] = cur + 1
		if op.Resolves != "" {
			if c, ok := s.conflicts[op.Resolves]; ok && c.Status == "open" {
				c.Status = "resolved-mine"
				defer s.releaseHeld(c)
			}
		}
		return Result{OpID: op.ID, Status: Applied, Task: t.clone(), Revision: cur + 1}
	}
	if t.get(op.Field) == op.Value {
		// The server already holds this value: nothing to do, and not a conflict.
		return Result{OpID: op.ID, Status: Noop, Task: t.clone(), Revision: cur}
	}
	s.seq++
	c := &ConflictEntry{ID: fmt.Sprintf("c-%d", s.seq), OpID: op.ID, DeviceID: op.DeviceID, TaskID: t.ID,
		Field: op.Field, ServerValue: t.get(op.Field), ServerRevision: cur, ProposedValue: op.Value,
		BaseRevision: base, HeldOps: []Op{}, Status: "open", CreatedAt: s.now().UTC().Format(time.RFC3339)}
	s.conflicts[c.ID] = c
	s.corder = append(s.corder, c.ID)
	s.stats.ConflictsOpened++
	return Result{OpID: op.ID, Status: Conflict, ConflictID: c.ID, Task: t.clone(), Revision: cur,
		Reason: fmt.Sprintf("%s changed on the server (revision %d) after this edit's base (revision %d)", op.Field, cur, base)}
}

// releaseHeld re-applies a resolved conflict's held operations in their queue order. The
// first builds on the resolving edit's new revision; each later one on the one before it.
// Called with s.mu held.
func (s *Store) releaseHeld(c *ConflictEntry) {
	held := c.HeldOps
	c.HeldOps = []Op{}
	for _, op := range held {
		delete(s.results, op.ID)
		if op.DependsOn != "" {
			if dep, ok := s.results[op.DependsOn]; ok && dep.Status == Conflict {
				rev := s.tasks[op.TaskID].Revisions[op.Field]
				op.DependsOn = ""
				op.BaseRevision = &rev
			}
		}
		s.applyOne(op)
	}
}

// ErrNotFound is returned for an unknown conflict.
var ErrNotFound = errors.New("not found")

// KeepServer resolves a conflict by keeping the server value. Held operations that depended
// on the rejected edit are discarded with it, and returned so the client can show them.
func (s *Store) KeepServer(id string) (*ConflictEntry, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	c, ok := s.conflicts[id]
	if !ok {
		return nil, ErrNotFound
	}
	if c.Status != "open" {
		return nil, fmt.Errorf("conflict %s is %s", id, c.Status)
	}
	c.Status = "resolved-server"
	out := *c
	for _, op := range c.HeldOps {
		s.results[op.ID] = Result{OpID: op.ID, Status: Rejected, Reason: "discarded with conflict " + id}
	}
	c.HeldOps = []Op{}
	return &out, nil
}

// SortedConflictIDs is a test helper.
func (s *Store) SortedConflictIDs() []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	ids := append([]string(nil), s.corder...)
	sort.Strings(ids)
	return ids
}
