package domain

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"sort"
	"time"
)

// State is the whole in-memory model. It is read and changed only by its owner (Service),
// under one lock; every change goes through a Tx.
type State struct {
	Tasks         map[string]*Task
	Placements    map[string]*Placement
	byTask        map[string][]string // placement ids, creation order
	byDay         map[string][]string
	Conflicts     map[string]*Conflict
	conflictOrder []string
	Ops           map[string]*OpRecord
	Settings      Settings
	Planning      Planning
	Ledger        map[string]LedgerEntry
	LastRolled    string // the latest planner day whose rollover has run
	GroupRevs     map[GroupKey]int
	Seq           int64 // server-generated id counter
	EventSeq      int64
}

// NewState returns an empty state with the default settings.
func NewState() *State {
	return &State{
		Tasks: map[string]*Task{}, Placements: map[string]*Placement{},
		byTask: map[string][]string{}, byDay: map[string][]string{},
		Conflicts: map[string]*Conflict{}, Ops: map[string]*OpRecord{},
		Settings: DefaultSettings(), Planning: newPlanning(),
		Ledger: map[string]LedgerEntry{}, GroupRevs: map[GroupKey]int{},
	}
}

// AddLoadedPlacement indexes a placement read from storage.
func (s *State) AddLoadedPlacement(p *Placement) {
	s.Placements[p.ID] = p
	s.byTask[p.TaskID] = append(s.byTask[p.TaskID], p.ID)
	s.byDay[p.Day] = append(s.byDay[p.Day], p.ID)
}

// AddLoadedConflict indexes a conflict read from storage, in order.
func (s *State) AddLoadedConflict(c *Conflict) {
	s.Conflicts[c.ID] = c
	s.conflictOrder = append(s.conflictOrder, c.ID)
}

// SetLoadedLedger records a ledger entry read from storage.
func (s *State) SetLoadedLedger(e LedgerEntry) {
	s.Ledger[e.Day] = e
	if e.Day > s.LastRolled {
		s.LastRolled = e.Day
	}
}

// ConflictOrder returns conflict ids in creation order.
func (s *State) ConflictOrder() []string { return append([]string{}, s.conflictOrder...) }

// Redaction replaces the named fields' values in a task's history events with "purged".
type Redaction struct {
	TaskID string
	Fields []string
}

// Changes are the rows a committed Tx touched. The store writes exactly these.
type Changes struct {
	Tasks      []*Task
	Placements []*Placement
	Conflicts  []*Conflict
	Ops        []*OpRecord
	Settings   *Settings
	Planning   *Planning
	Ledger     []LedgerEntry
	GroupRevs  map[GroupKey]int
	Events     []Event
	Redactions []Redaction
	Seq        int64
	EventSeq   int64
}

// Empty reports whether nothing changed.
func (c *Changes) Empty() bool {
	return len(c.Tasks) == 0 && len(c.Placements) == 0 && len(c.Conflicts) == 0 && len(c.Ops) == 0 &&
		c.Settings == nil && c.Planning == nil && len(c.Ledger) == 0 && len(c.GroupRevs) == 0 &&
		len(c.Events) == 0 && len(c.Redactions) == 0
}

// Tx is a copy-on-write transaction over a State. Reads see the Tx's own changes; nothing
// in the State is touched until Apply.
type Tx struct {
	s   *State
	now time.Time
	day string // the server planner day this Tx runs in

	tasks         map[string]*Task
	placements    map[string]*Placement
	newPlacements []string
	conflicts     map[string]*Conflict
	newConflicts  []string
	ops           map[string]*OpRecord
	opOrder       []string
	settings      *Settings
	planning      *Planning
	ledger        []LedgerEntry
	groupRevs     map[GroupKey]int
	events        []Event
	redactions    []Redaction
	seq           int64
	eventSeq      int64
	lastRolled    string
	curOp         string
}

// Begin starts a Tx at instant now, in server planner day day.
func (s *State) Begin(now time.Time, day string) *Tx {
	return &Tx{
		s: s, now: now.UTC(), day: day,
		tasks: map[string]*Task{}, placements: map[string]*Placement{},
		conflicts: map[string]*Conflict{}, ops: map[string]*OpRecord{},
		groupRevs: map[GroupKey]int{}, seq: s.Seq, eventSeq: s.EventSeq, lastRolled: s.LastRolled,
	}
}

// Day is the Tx's server planner day.
func (tx *Tx) Day() string { return tx.day }

func (tx *Tx) stamp() string { return tx.now.Format(time.RFC3339Nano) }

func (tx *Tx) nextID(prefix string) string {
	tx.seq++
	return fmt.Sprintf("%s-%d", prefix, tx.seq)
}

// NewTaskID returns a fresh random task id.
func NewTaskID() string {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		panic(err)
	}
	return hex.EncodeToString(b[:])
}

// ── reads ──────────────────────────────────────────────────────────────────

func (tx *Tx) task(id string) *Task {
	if t, ok := tx.tasks[id]; ok {
		return t
	}
	return tx.s.Tasks[id]
}

func (tx *Tx) placement(id string) *Placement {
	if p, ok := tx.placements[id]; ok {
		return p
	}
	return tx.s.Placements[id]
}

func (tx *Tx) conflict(id string) *Conflict {
	if c, ok := tx.conflicts[id]; ok {
		return c
	}
	return tx.s.Conflicts[id]
}

func (tx *Tx) opRecord(id string) *OpRecord {
	if r, ok := tx.ops[id]; ok {
		return r
	}
	return tx.s.Ops[id]
}

func (tx *Tx) settingsView() *Settings {
	if tx.settings != nil {
		return tx.settings
	}
	return &tx.s.Settings
}

func (tx *Tx) planningView() *Planning {
	if tx.planning != nil {
		return tx.planning
	}
	return &tx.s.Planning
}

func (tx *Tx) groupRev(k GroupKey) int {
	if v, ok := tx.groupRevs[k]; ok {
		return v
	}
	return tx.s.GroupRevs[k]
}

// placementsOfTask returns the task's placements, oldest first by day then creation.
func (tx *Tx) placementsOfTask(taskID string) []*Placement {
	var out []*Placement
	for _, id := range tx.s.byTask[taskID] {
		out = append(out, tx.placement(id))
	}
	for _, id := range tx.newPlacements {
		if p := tx.placements[id]; p.TaskID == taskID {
			out = append(out, p)
		}
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].Day < out[j].Day })
	return out
}

func (tx *Tx) placementsOnDay(day string) []*Placement {
	var out []*Placement
	for _, id := range tx.s.byDay[day] {
		out = append(out, tx.placement(id))
	}
	for _, id := range tx.newPlacements {
		if p := tx.placements[id]; p.Day == day {
			out = append(out, p)
		}
	}
	return out
}

// allOpenPlacements returns every open placement on a day before `before`.
func (tx *Tx) openPlacementsBefore(before string) []*Placement {
	var out []*Placement
	for id := range tx.s.Placements {
		if p := tx.placement(id); p.Open() && p.Day < before {
			out = append(out, p)
		}
	}
	for _, id := range tx.newPlacements {
		if p := tx.placements[id]; p.Open() && p.Day < before {
			out = append(out, p)
		}
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Day != out[j].Day {
			return out[i].Day < out[j].Day
		}
		return out[i].ID < out[j].ID
	})
	return out
}

func (tx *Tx) openPlacement(taskID string) *Placement {
	for _, p := range tx.placementsOfTask(taskID) {
		if p.Open() {
			return p
		}
	}
	return nil
}

func (tx *Tx) allTaskIDs() []string {
	ids := make([]string, 0, len(tx.s.Tasks)+len(tx.tasks))
	for id := range tx.s.Tasks {
		ids = append(ids, id)
	}
	for id := range tx.tasks {
		if _, ok := tx.s.Tasks[id]; !ok {
			ids = append(ids, id)
		}
	}
	sort.Strings(ids)
	return ids
}

// ── writes ─────────────────────────────────────────────────────────────────

func (tx *Tx) mutTask(id string) *Task {
	if t, ok := tx.tasks[id]; ok {
		return t
	}
	t := tx.s.Tasks[id].clone()
	tx.tasks[id] = t
	return t
}

func (tx *Tx) putNewTask(t *Task) { tx.tasks[t.ID] = t }

func (tx *Tx) mutPlacement(id string) *Placement {
	if p, ok := tx.placements[id]; ok {
		return p
	}
	p := tx.s.Placements[id].clone()
	tx.placements[id] = p
	return p
}

func (tx *Tx) addPlacement(p Placement) *Placement {
	p.ID = tx.nextID("p")
	p.CreatedAt = tx.stamp()
	p.Rev = 1
	np := &p
	tx.placements[p.ID] = np
	tx.newPlacements = append(tx.newPlacements, p.ID)
	return np
}

func (tx *Tx) mutConflict(id string) *Conflict {
	if c, ok := tx.conflicts[id]; ok {
		return c
	}
	c := tx.s.Conflicts[id].clone()
	tx.conflicts[id] = c
	return c
}

func (tx *Tx) addConflict(c Conflict) *Conflict {
	c.ID = tx.nextID("c")
	c.Status = "open"
	c.CreatedAt = tx.stamp()
	if c.HeldOps == nil {
		c.HeldOps = []Op{}
	}
	if c.Actions == nil {
		c.Actions = []string{}
	}
	nc := &c
	tx.conflicts[c.ID] = nc
	tx.newConflicts = append(tx.newConflicts, c.ID)
	return nc
}

func (tx *Tx) mutSettings() *Settings {
	if tx.settings == nil {
		c := tx.s.Settings.clone()
		tx.settings = &c
	}
	return tx.settings
}

func (tx *Tx) mutPlanning() *Planning {
	if tx.planning == nil {
		c := tx.s.Planning.clone()
		tx.planning = &c
	}
	return tx.planning
}

func (tx *Tx) bumpGroup(day, letter string) {
	if letter == "" {
		return
	}
	k := GroupKey{day, letter}
	tx.groupRevs[k] = tx.groupRev(k) + 1
}

func (tx *Tx) recordOp(op Op, r Result) {
	if op.ID == "" {
		return
	}
	if _, seen := tx.ops[op.ID]; !seen {
		tx.opOrder = append(tx.opOrder, op.ID)
	}
	tx.ops[op.ID] = &OpRecord{OpID: op.ID, DeviceID: op.DeviceID, ReceivedAt: tx.stamp(), Result: r}
}

func (tx *Tx) forgetOp(id string) { delete(tx.ops, id) }

func (tx *Tx) event(kind, taskID, placementID string, data map[string]any) {
	tx.eventSeq++
	if data == nil {
		data = map[string]any{}
	}
	tx.events = append(tx.events, Event{Seq: tx.eventSeq, At: tx.stamp(), Day: tx.day, Kind: kind,
		TaskID: taskID, PlacementID: placementID, OpID: tx.curOp, Data: data})
}

// Changes returns what this Tx would write.
func (tx *Tx) Changes() *Changes {
	c := &Changes{Settings: tx.settings, Planning: tx.planning, Ledger: tx.ledger,
		GroupRevs: tx.groupRevs, Events: tx.events, Redactions: tx.redactions,
		Seq: tx.seq, EventSeq: tx.eventSeq}
	for _, id := range sortedKeys(tx.tasks) {
		c.Tasks = append(c.Tasks, tx.tasks[id])
	}
	for _, id := range sortedKeys(tx.placements) {
		c.Placements = append(c.Placements, tx.placements[id])
	}
	for _, id := range sortedKeys(tx.conflicts) {
		c.Conflicts = append(c.Conflicts, tx.conflicts[id])
	}
	for _, id := range tx.opOrder {
		if r, ok := tx.ops[id]; ok {
			c.Ops = append(c.Ops, r)
		}
	}
	return c
}

// Apply makes the Tx's changes visible in its State. Call only after they are durable.
func (tx *Tx) Apply() {
	s := tx.s
	for id, t := range tx.tasks {
		s.Tasks[id] = t
	}
	newP := map[string]bool{}
	for _, id := range tx.newPlacements {
		newP[id] = true
	}
	for id, p := range tx.placements {
		s.Placements[id] = p
		if newP[id] {
			s.byTask[p.TaskID] = append(s.byTask[p.TaskID], id)
			s.byDay[p.Day] = append(s.byDay[p.Day], id)
		}
	}
	newC := map[string]bool{}
	for _, id := range tx.newConflicts {
		newC[id] = true
	}
	for id, c := range tx.conflicts {
		s.Conflicts[id] = c
	}
	for _, id := range tx.newConflicts {
		s.conflictOrder = append(s.conflictOrder, id)
	}
	for id, r := range tx.ops {
		s.Ops[id] = r
	}
	if tx.settings != nil {
		s.Settings = *tx.settings
	}
	if tx.planning != nil {
		s.Planning = *tx.planning
	}
	for _, e := range tx.ledger {
		s.Ledger[e.Day] = e
	}
	s.LastRolled = tx.lastRolled
	for k, v := range tx.groupRevs {
		s.GroupRevs[k] = v
	}
	s.Seq = tx.seq
	s.EventSeq = tx.eventSeq
}

func sortedKeys[V any](m map[string]V) []string {
	ks := make([]string, 0, len(m))
	for k := range m {
		ks = append(ks, k)
	}
	sort.Strings(ks)
	return ks
}

// RecordOp records an op's result, so a replay of its id returns it.
func (tx *Tx) RecordOp(op Op, r Result) { tx.recordOp(op, r) }
