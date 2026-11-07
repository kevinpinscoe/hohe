package domain

import (
	"errors"
	"fmt"
	"strings"
	"unicode/utf8"

	"github.com/kevinpinscoe/hohe/server/internal/plannerday"
)

// Limits that keep a misbehaving client from exhausting the server.
const (
	MaxTitleBytes = 500
	MaxNotesBytes = 20000
	MaxTags       = 20
	MaxTagBytes   = 50
	MaxIDBytes    = 100
	MaxBatch      = 500
)

// Op types.
const (
	OpCapture     = "capture" // a task, optionally placed (title only is the norm)
	OpCreate      = "create"  // alias of capture used by "add to this day"
	OpAssign      = "assign"  // place a task on a day, optionally with a letter
	OpPlanIt      = "planIt"  // place a task on a day keeping its letter (suggestions)
	OpEdit        = "edit"
	OpComplete    = "complete"
	OpReopen      = "reopen"
	OpForward     = "forward"
	OpBackToDump  = "backToDump"
	OpDelete      = "delete"
	OpRestore     = "restore"
	OpDelegate    = "delegate"
	OpInProgress  = "inProgress"
	OpKeepToday   = "keepToday"
	OpSetRank     = "setRank"
	OpReorder     = "reorder"
	OpSnooze      = "snooze"
	OpPause       = "pauseSuggestions"
	OpResume      = "resumeSuggestions"
	OpDismissCard = "dismissCard"
	OpDesignate   = "designate"
	OpMarkPlanned = "markPlanned"
	OpSetting     = "setting"
	OpCorrect     = "correct"
	OpResolve     = "resolve"
)

// Editable task fields, each with its own revision.
var editableFields = map[string]bool{
	"title": true, "notes": true, "priority": true, "deadline": true, "effort": true,
	"tags": true, "delegate": true, "followUp": true,
}

// ApplyOp applies one operation. Replaying an op id returns its original result.
func (tx *Tx) ApplyOp(op Op) Result {
	if op.ID == "" {
		return Result{Status: Rejected, Reason: "missing op id"}
	}
	if len(op.ID) > MaxIDBytes {
		return Result{Status: Rejected, Reason: "op id too long"}
	}
	if rec := tx.opRecord(op.ID); rec != nil {
		r := rec.Result
		r.Replayed = true
		return r
	}
	return tx.applyFresh(op)
}

// applyFresh applies op without the replay check (used when a held op is released).
func (tx *Tx) applyFresh(op Op) Result {
	prev := tx.curOp
	tx.curOp = op.ID
	defer func() { tx.curOp = prev }()
	r := tx.dispatch(op)
	r.OpID = op.ID
	r.ServerPlannerDay = tx.day
	if op.ClientPlannerDay != "" && op.ClientPlannerDay != tx.day {
		r.PlannerDayMismatch = true
	}
	tx.recordOp(op, r)
	return r
}

func reject(format string, a ...any) Result {
	return Result{Status: Rejected, Reason: fmt.Sprintf(format, a...)}
}

func (tx *Tx) dispatch(op Op) Result {
	switch op.Type {
	case OpCapture, OpCreate:
		return tx.opCapture(op)
	case OpAssign, OpPlanIt:
		return tx.lifecycle(op, tx.doAssign)
	case OpEdit:
		return tx.opEdit(op)
	case OpComplete:
		return tx.lifecycle(op, tx.doComplete)
	case OpReopen:
		return tx.opReopen(op)
	case OpForward:
		return tx.lifecycle(op, tx.doForward)
	case OpBackToDump:
		return tx.lifecycle(op, tx.doBackToDump)
	case OpDelete:
		return tx.opDelete(op)
	case OpRestore:
		return tx.opRestore(op)
	case OpDelegate:
		return tx.lifecycle(op, tx.doDelegate)
	case OpInProgress:
		return tx.lifecycle(op, tx.doInProgress)
	case OpKeepToday:
		return tx.lifecycle(op, tx.doKeepToday)
	case OpSetRank:
		return tx.opSetRank(op)
	case OpReorder:
		return tx.opReorder(op)
	case OpSnooze, OpPause, OpResume, OpDismissCard, OpDesignate, OpMarkPlanned:
		return tx.opPlanning(op)
	case OpSetting:
		return tx.opSetting(op)
	case OpCorrect:
		return tx.opCorrect(op)
	case OpResolve:
		return tx.opResolve(op)
	default:
		return reject("unknown op type %q", op.Type)
	}
}

// ── capture ────────────────────────────────────────────────────────────────

func validLetter(l string) bool { return l == "" || l == "A" || l == "B" || l == "C" }
func validEffort(e string) bool { return e == "" || e == "S" || e == "M" || e == "L" }

func cleanTitle(s string) (string, error) {
	s = strings.TrimSpace(s)
	if s == "" {
		return "", errors.New("empty title")
	}
	if len(s) > MaxTitleBytes || !utf8.ValidString(s) {
		return "", errors.New("title too long or not valid text")
	}
	return s, nil
}

// CaptureInput is a capture from the capture API or the client. Optional fields are set
// only when supplied; they are never inferred.
type CaptureInput struct {
	TaskID   string
	Title    string
	Letter   string
	Day      string
	Rank     int
	Deadline string
	Effort   string
	Source   string
	By       string
}

func (tx *Tx) opCapture(op Op) Result {
	in := CaptureInput{TaskID: op.TaskID, Title: op.Title, Day: op.Day, Rank: op.Rank, Source: "device:" + op.DeviceID, By: ByKevin}
	if op.Letter != nil {
		in.Letter = *op.Letter
	}
	if op.Deadline != nil {
		in.Deadline = *op.Deadline
	}
	if op.Effort != nil {
		in.Effort = *op.Effort
	}
	return tx.Capture(in)
}

// Capture creates a task. A title alone lands in the Task Dump.
func (tx *Tx) Capture(in CaptureInput) Result {
	title, err := cleanTitle(in.Title)
	if err != nil {
		return reject("%v", err)
	}
	if !validLetter(in.Letter) {
		return reject("priority must be A, B, C or empty")
	}
	if !validEffort(in.Effort) {
		return reject("effort must be S, M, L or empty")
	}
	if in.Day != "" && !plannerday.Valid(in.Day) {
		return reject("day must be YYYY-MM-DD")
	}
	if in.Deadline != "" && !plannerday.Valid(in.Deadline) {
		return reject("deadline must be YYYY-MM-DD")
	}
	id := in.TaskID
	if id == "" {
		id = NewTaskID()
	}
	if len(id) > MaxIDBytes {
		return reject("task id too long")
	}
	if existing := tx.task(id); existing != nil {
		if existing.State == StatePurged {
			return reject("task id %s belongs to a purged task and cannot be reused", id)
		}
		return reject("task id %s is already in use", id)
	}
	t := &Task{ID: id, Title: title, Priority: in.Letter, Deadline: in.Deadline, Effort: in.Effort,
		Tags: []string{}, State: StateActive, CreatedDay: tx.day, CreatedAt: tx.stamp(), Source: in.Source,
		Revisions: map[string]int{}, Rev: 1}
	for f := range editableFields {
		t.Revisions[f] = 1
	}
	tx.putNewTask(t)
	tx.event("created", id, "", map[string]any{"title": title, "priority": in.Letter, "deadline": in.Deadline,
		"effort": in.Effort, "source": in.Source})
	r := Result{Status: Applied, TaskID: id, Revision: 1}
	if in.Day != "" {
		by := in.By
		if by == "" {
			by = ByKevin
		}
		p := tx.addPlacement(Placement{TaskID: id, Day: in.Day, Letter: in.Letter, By: by, Touched: true})
		tx.bumpGroup(in.Day, in.Letter)
		tx.event("placed", id, p.ID, map[string]any{"day": in.Day, "letter": in.Letter})
		r.PlacementID = p.ID
		if in.Rank > 0 && in.Letter != "" {
			if msg := tx.setRank(p, in.Rank); msg != "" {
				r.Notice = msg
			}
		}
	}
	return r
}

// ── lifecycle ops and their staleness rules ───────────────────────────────

type lifecycleFn func(op Op, t *Task, open *Placement) Result

// lifecycle runs fn after the terminal-state and stale-placement checks (§11.4):
// completed wins over a stale op; a deleted task stays deleted; a purged task is final;
// an op based on a placement another device has since changed goes to the tray, while a
// placement merely carried by rollover is followed to its successor.
func (tx *Tx) lifecycle(op Op, fn lifecycleFn) Result {
	t := tx.task(op.TaskID)
	if t == nil {
		return reject("unknown task %s", op.TaskID)
	}
	if r, done := tx.terminalCheck(op, t); done {
		return r
	}
	open := tx.openPlacement(t.ID)
	if r, done := tx.basePlacementCheck(op, t, open); done {
		return r
	}
	return fn(op, t, open)
}

// terminalCheck sends an op against a completed, deleted or purged task to the tray.
func (tx *Tx) terminalCheck(op Op, t *Task) (Result, bool) {
	switch t.State {
	case StatePurged:
		return tx.toTray(op, t, KindPurged, "This task was purged. Nothing is left to apply this change to.",
			[]string{ResolveDiscard}), true
	case StateDeleted:
		return tx.toTray(op, t, KindDeleted, "This task was deleted on another device.",
			[]string{ResolveRestoreAndApply, ResolveDiscard}), true
	case StateCompleted:
		if op.Type == OpComplete {
			return Result{Status: Noop, TaskID: t.ID, Reason: "already completed"}, true
		}
		return tx.toTray(op, t, KindLifecycle, "This task was completed. A completed task is never un-completed by a stale change.",
			[]string{ResolveReopenAndApply, ResolveDiscard}), true
	}
	return Result{}, false
}

// basePlacementCheck compares the placement the client saw with the current one.
func (tx *Tx) basePlacementCheck(op Op, t *Task, open *Placement) (Result, bool) {
	if op.BasePlacementID == "" {
		return Result{}, false
	}
	if open != nil && open.ID == op.BasePlacementID {
		return Result{}, false
	}
	base := tx.placement(op.BasePlacementID)
	if base == nil || base.TaskID != t.ID {
		return reject("unknown base placement %s", op.BasePlacementID), true
	}
	if tx.carriedOnlyByRollover(base, open) {
		return Result{}, false // rollover moved it on; follow it
	}
	if op.Type == OpComplete {
		return Result{}, false // completion wins (§11.4); doComplete records what it superseded
	}
	return tx.toTray(op, t, KindPlacement,
		fmt.Sprintf("This task's entry for %s was changed on another device (%s).", base.Day, describeOutcome(base)),
		[]string{ResolveApplyAnyway, ResolveDiscard}), true
}

// carriedOnlyByRollover reports whether base leads to open through rollover carries alone.
func (tx *Tx) carriedOnlyByRollover(base, open *Placement) bool {
	if open == nil {
		return false
	}
	chain := tx.placementsOfTask(base.TaskID)
	cur := base
	for i := 0; i < len(chain)+1; i++ {
		if cur.ID == open.ID {
			return true
		}
		if cur.Outcome != OutcomeCarried {
			return false
		}
		var next *Placement
		for _, p := range chain {
			if p.Day == cur.Target && p.By == ByRollover && p.ID != cur.ID {
				next = p
				break
			}
		}
		if next == nil {
			return false
		}
		cur = next
	}
	return false
}

func describeOutcome(p *Placement) string {
	switch p.Outcome {
	case OutcomeOpen:
		return "still open"
	case OutcomeForwarded:
		return "forwarded to " + p.Target
	case OutcomeCarried:
		return "carried to " + p.Target
	case OutcomeDelegated:
		return "delegated"
	case OutcomeReturned:
		return "returned to the Dump"
	default:
		return p.Outcome
	}
}

func (tx *Tx) toTray(op Op, t *Task, kind, msg string, actions []string) Result {
	c := tx.addConflict(Conflict{Kind: kind, OpID: op.ID, DeviceID: op.DeviceID, TaskID: t.ID, Message: msg,
		Actions: actions, Op: op, ProposedValue: op.Value, ServerValue: t.State})
	tx.event("conflict", t.ID, "", map[string]any{"conflictId": c.ID, "kind": kind, "opType": op.Type})
	return Result{Status: InTray, TaskID: t.ID, ConflictID: c.ID, Reason: msg}
}

func (tx *Tx) closePlacement(p *Placement, outcome, target string) *Placement {
	m := tx.mutPlacement(p.ID)
	m.Outcome = outcome
	m.Target = target
	m.Touched = true
	m.InProgress = false
	m.ClosedAt = tx.stamp()
	m.Rev++
	tx.bumpGroup(m.Day, m.Letter)
	tx.event("placement."+outcome, p.TaskID, p.ID, map[string]any{"day": p.Day, "letter": p.Letter, "rank": p.Rank, "target": target})
	return m
}

func (tx *Tx) touchTask(t *Task) *Task {
	m := tx.mutTask(t.ID)
	m.Rev++
	return m
}

func (tx *Tx) futureOrToday(day string) bool { return day >= tx.day }

// doAssign places a task on a day (from the Dump or another day), optionally changing its
// letter. planIt is the same with the task's own letter: planning never promotes.
func (tx *Tx) doAssign(op Op, t *Task, open *Placement) Result {
	if !plannerday.Valid(op.Day) {
		return reject("day must be YYYY-MM-DD")
	}
	letter := t.Priority
	if op.Type == OpAssign && op.Letter != nil {
		letter = *op.Letter
		if !validLetter(letter) {
			return reject("priority must be A, B, C or empty")
		}
		if letter != t.Priority {
			if r, ok := tx.fieldBaseCheck(op, t, "priority", letter); !ok {
				return r
			}
			tx.setPriority(t, letter)
		}
	}
	if open != nil && open.Day == op.Day {
		m := tx.mutPlacement(open.ID)
		if m.Letter != letter {
			tx.bumpGroup(m.Day, m.Letter)
			m.Letter, m.Rank = letter, 0
			tx.bumpGroup(m.Day, letter)
		}
		m.Touched = true
		m.Rev++
		return Result{Status: Applied, TaskID: t.ID, PlacementID: m.ID}
	}
	if open != nil {
		tx.closePlacement(open, OutcomeForwarded, op.Day)
	}
	p := tx.addPlacement(Placement{TaskID: t.ID, Day: op.Day, Letter: letter, By: ByKevin, Touched: true})
	tx.bumpGroup(op.Day, letter)
	tx.touchTask(t)
	tx.event("placed", t.ID, p.ID, map[string]any{"day": op.Day, "letter": letter, "via": op.Type})
	return Result{Status: Applied, TaskID: t.ID, PlacementID: p.ID}
}

func (tx *Tx) doComplete(op Op, t *Task, open *Placement) Result {
	r := Result{Status: Applied, TaskID: t.ID}
	if open != nil && op.BasePlacementID != "" && open.ID != op.BasePlacementID {
		base := tx.placement(op.BasePlacementID)
		if base != nil && !tx.carriedOnlyByRollover(base, open) {
			c := tx.addConflict(Conflict{Kind: KindSuperseded, OpID: op.ID, DeviceID: op.DeviceID, TaskID: t.ID,
				Message: fmt.Sprintf("Completed from another device. The change made elsewhere (%s) was superseded: completion wins.", describeOutcome(base)),
				Actions: []string{ResolveDismiss}, Op: op})
			r.ConflictID = c.ID
			r.Notice = c.Message
		}
	}
	m := tx.touchTask(t)
	m.State = StateCompleted
	m.CompletedDay = tx.day
	if op.ClientPlannerDay != "" && plannerday.Valid(op.ClientPlannerDay) && op.ClientPlannerDay <= tx.day {
		m.CompletedDay = op.ClientPlannerDay
	}
	if open != nil {
		tx.closePlacement(open, OutcomeCompleted, "")
		r.PlacementID = open.ID
	}
	tx.event("completed", t.ID, r.PlacementID, map[string]any{"day": m.CompletedDay})
	return r
}

func (tx *Tx) opReopen(op Op) Result {
	t := tx.task(op.TaskID)
	if t == nil {
		return reject("unknown task %s", op.TaskID)
	}
	switch t.State {
	case StatePurged:
		return tx.toTray(op, t, KindPurged, "This task was purged.", []string{ResolveDiscard})
	case StateDeleted:
		return tx.toTray(op, t, KindDeleted, "This task was deleted.", []string{ResolveRestoreAndApply, ResolveDiscard})
	case StateCompleted:
	default:
		return Result{Status: Noop, TaskID: t.ID, Reason: "not completed"}
	}
	return tx.reopen(t)
}

// reopen is the explicit undo of a completion. A completion made on today's entry reopens
// that entry; an older one sends the task back to the Dump, leaving history unchanged.
func (tx *Tx) reopen(t *Task) Result {
	m := tx.touchTask(t)
	m.State = StateActive
	m.CompletedDay = ""
	r := Result{Status: Applied, TaskID: t.ID}
	ps := tx.placementsOfTask(t.ID)
	if n := len(ps); n > 0 {
		last := ps[n-1]
		if last.Outcome == OutcomeCompleted && last.Day >= tx.day {
			p := tx.mutPlacement(last.ID)
			p.Outcome, p.ClosedAt = OutcomeOpen, ""
			p.Rev++
			tx.bumpGroup(p.Day, p.Letter)
			r.PlacementID = p.ID
		}
	}
	tx.event("reopened", t.ID, r.PlacementID, nil)
	return r
}

func (tx *Tx) doForward(op Op, t *Task, open *Placement) Result {
	if !plannerday.Valid(op.Day) {
		return reject("day must be YYYY-MM-DD")
	}
	if !tx.futureOrToday(op.Day) {
		return reject("cannot forward to a past day (%s)", op.Day)
	}
	if open == nil {
		return tx.doAssign(Op{ID: op.ID, Type: OpPlanIt, TaskID: t.ID, Day: op.Day}, t, nil)
	}
	if open.Day == op.Day {
		return Result{Status: Noop, TaskID: t.ID, PlacementID: open.ID}
	}
	tx.closePlacement(open, OutcomeForwarded, op.Day)
	p := tx.addPlacement(Placement{TaskID: t.ID, Day: op.Day, Letter: open.Letter, By: ByKevin, Touched: true})
	tx.bumpGroup(op.Day, open.Letter)
	tx.touchTask(t)
	return Result{Status: Applied, TaskID: t.ID, PlacementID: p.ID}
}

func (tx *Tx) doBackToDump(op Op, t *Task, open *Placement) Result {
	if open == nil {
		return Result{Status: Noop, TaskID: t.ID, Reason: "already in the Dump"}
	}
	tx.closePlacement(open, OutcomeReturned, "")
	tx.touchTask(t)
	return Result{Status: Applied, TaskID: t.ID, PlacementID: open.ID}
}

func (tx *Tx) doDelegate(op Op, t *Task, open *Placement) Result {
	who := strings.TrimSpace(op.Who)
	if who == "" || len(who) > MaxTitleBytes {
		return reject("delegate needs a name")
	}
	if !plannerday.Valid(op.Day) || op.Day <= tx.day {
		return reject("follow-up day must be a future YYYY-MM-DD")
	}
	m := tx.touchTask(t)
	m.State, m.Delegate, m.FollowUp = StateWaiting, who, op.Day
	m.Revisions["delegate"]++
	m.Revisions["followUp"]++
	if open != nil {
		tx.closePlacement(open, OutcomeDelegated, op.Day)
	}
	tx.event("delegated", t.ID, "", map[string]any{"who": who, "followUp": op.Day})
	return Result{Status: Applied, TaskID: t.ID}
}

func (tx *Tx) doInProgress(op Op, t *Task, open *Placement) Result {
	if open == nil {
		return reject("task is not on a day")
	}
	v := !open.InProgress
	if op.Bool != nil {
		v = *op.Bool
	}
	if v == open.InProgress {
		return Result{Status: Noop, TaskID: t.ID, PlacementID: open.ID}
	}
	m := tx.mutPlacement(open.ID)
	m.InProgress, m.Touched = v, true
	m.Rev++
	tx.event("inProgress", t.ID, open.ID, map[string]any{"value": v})
	return Result{Status: Applied, TaskID: t.ID, PlacementID: open.ID}
}

func (tx *Tx) doKeepToday(op Op, t *Task, open *Placement) Result {
	if open == nil {
		return reject("task is not on a day")
	}
	if open.Touched {
		return Result{Status: Noop, TaskID: t.ID, PlacementID: open.ID}
	}
	m := tx.mutPlacement(open.ID)
	m.Touched = true
	m.Rev++
	tx.event("kept", t.ID, open.ID, nil)
	return Result{Status: Applied, TaskID: t.ID, PlacementID: open.ID}
}

func (tx *Tx) opDelete(op Op) Result {
	t := tx.task(op.TaskID)
	if t == nil {
		return reject("unknown task %s", op.TaskID)
	}
	switch t.State {
	case StatePurged, StateDeleted:
		return Result{Status: Noop, TaskID: t.ID, Reason: "already deleted"}
	}
	m := tx.touchTask(t)
	m.State, m.DeletedDay, m.DeletedAt = StateDeleted, tx.day, tx.stamp()
	r := Result{Status: Applied, TaskID: t.ID}
	if open := tx.openPlacement(t.ID); open != nil {
		tx.closePlacement(open, OutcomeDeleted, "")
		r.PlacementID = open.ID
	}
	tx.event("deleted", t.ID, r.PlacementID, nil)
	return r
}

func (tx *Tx) opRestore(op Op) Result {
	t := tx.task(op.TaskID)
	if t == nil {
		return reject("unknown task %s", op.TaskID)
	}
	switch t.State {
	case StatePurged:
		return tx.toTray(op, t, KindPurged, "This task was purged and can no longer be restored.", []string{ResolveDiscard})
	case StateDeleted:
		return tx.restore(t)
	}
	return Result{Status: Noop, TaskID: t.ID, Reason: "not deleted"}
}

// restore undoes a soft delete. The entry it was deleted from reopens only if its day is
// today or later; otherwise the task returns to the Dump.
func (tx *Tx) restore(t *Task) Result {
	m := tx.touchTask(t)
	m.State, m.DeletedDay, m.DeletedAt = StateActive, "", ""
	if m.CompletedDay != "" {
		m.State = StateCompleted
	}
	r := Result{Status: Applied, TaskID: t.ID}
	ps := tx.placementsOfTask(t.ID)
	if n := len(ps); n > 0 {
		last := ps[n-1]
		if last.Outcome == OutcomeDeleted && last.Day >= tx.day {
			p := tx.mutPlacement(last.ID)
			p.Outcome, p.ClosedAt = OutcomeOpen, ""
			p.Rev++
			tx.bumpGroup(p.Day, p.Letter)
			r.PlacementID = p.ID
		}
	}
	tx.event("restored", t.ID, r.PlacementID, nil)
	return r
}

// ── edits with per-field revisions ────────────────────────────────────────

var errHeld = errors.New("held")

// base resolves the revision an edit was based on: explicit, or the revision produced by
// the earlier queued op it depends on. errHeld means that op is in the conflict tray.
func (tx *Tx) base(op Op) (int, *Conflict, error) {
	if op.DependsOn != "" {
		dep := tx.opRecord(op.DependsOn)
		if dep == nil {
			return 0, nil, fmt.Errorf("unknown dependency %s", op.DependsOn)
		}
		switch dep.Result.Status {
		case Applied, Noop:
			return dep.Result.Revision, nil, nil
		case InTray, Held:
			c := tx.conflict(dep.Result.ConflictID)
			if c != nil && c.Status == "open" {
				return 0, c, errHeld
			}
			return 0, nil, fmt.Errorf("dependency %s was resolved (%s)", op.DependsOn, statusOf(c))
		default:
			return 0, nil, fmt.Errorf("dependency %s was %s", op.DependsOn, dep.Result.Status)
		}
	}
	if op.BaseRevision == nil {
		return 0, nil, errors.New("edit needs baseRevision or dependsOn")
	}
	return *op.BaseRevision, nil, nil
}

func statusOf(c *Conflict) string {
	if c == nil {
		return "unknown"
	}
	return c.Status
}

func (tx *Tx) opEdit(op Op) Result {
	t := tx.task(op.TaskID)
	if t == nil {
		return reject("unknown task %s", op.TaskID)
	}
	if !editableFields[op.Field] {
		return reject("field %q is not editable", op.Field)
	}
	switch t.State {
	case StatePurged:
		return tx.toTray(op, t, KindPurged, "This task was purged. Nothing is left to apply this edit to.", []string{ResolveDiscard})
	case StateDeleted:
		return tx.toTray(op, t, KindDeleted, "This task was deleted on another device.", []string{ResolveRestoreAndApply, ResolveDiscard})
	}
	val, err := normalizeField(op.Field, op.Value)
	if err != nil {
		return reject("%v", err)
	}
	base, held, err := tx.base(op)
	if errors.Is(err, errHeld) {
		hc := tx.mutConflict(held.ID)
		hc.HeldOps = append(hc.HeldOps, op)
		return Result{Status: Held, TaskID: t.ID, ConflictID: held.ID, Reason: "depends on an operation in the conflict tray"}
	}
	if err != nil {
		return reject("%v", err)
	}
	cur := t.Revisions[op.Field]
	if base == cur {
		tx.setField(t, op.Field, val)
		r := Result{Status: Applied, TaskID: t.ID, Revision: cur + 1}
		if op.Resolves != "" {
			if c := tx.conflict(op.Resolves); c != nil && c.Status == "open" {
				tx.markResolved(c.ID, ResolveUseMine)
				tx.releaseHeld(c.ID)
			}
		}
		return r
	}
	if equalValue(fieldValue(t, op.Field), val) {
		return Result{Status: Noop, TaskID: t.ID, Revision: cur} // already the server's value
	}
	c := tx.addConflict(Conflict{Kind: KindField, OpID: op.ID, DeviceID: op.DeviceID, TaskID: t.ID, Field: op.Field,
		ServerValue: fieldValue(t, op.Field), ServerRevision: cur, ProposedValue: val, BaseRevision: base,
		Message: fmt.Sprintf("%s was changed on another device (revision %d) after this edit's base (revision %d).", op.Field, cur, base),
		Actions: []string{ResolveKeepServer, ResolveUseMine}, Op: op})
	tx.event("conflict", t.ID, "", map[string]any{"conflictId": c.ID, "kind": KindField, "field": op.Field})
	return Result{Status: InTray, TaskID: t.ID, ConflictID: c.ID, Revision: cur, Reason: c.Message}
}

// fieldBaseCheck applies the per-field revision rule to a lifecycle op that also changes a
// field (assign with a letter). ok=false returns the tray result.
func (tx *Tx) fieldBaseCheck(op Op, t *Task, field string, val any) (Result, bool) {
	if op.BaseRevision == nil {
		return Result{}, true
	}
	cur := t.Revisions[field]
	if *op.BaseRevision == cur || equalValue(fieldValue(t, field), val) {
		return Result{}, true
	}
	c := tx.addConflict(Conflict{Kind: KindField, OpID: op.ID, DeviceID: op.DeviceID, TaskID: t.ID, Field: field,
		ServerValue: fieldValue(t, field), ServerRevision: cur, ProposedValue: val, BaseRevision: *op.BaseRevision,
		Message: fmt.Sprintf("%s was changed on another device (revision %d) after this change's base (revision %d).", field, cur, *op.BaseRevision),
		Actions: []string{ResolveKeepServer, ResolveUseMine}, Op: op})
	return Result{Status: InTray, TaskID: t.ID, ConflictID: c.ID, Revision: cur, Reason: c.Message}, false
}

func normalizeField(field string, v any) (any, error) {
	str := func() (string, error) {
		if v == nil {
			return "", nil
		}
		s, ok := v.(string)
		if !ok {
			return "", fmt.Errorf("%s must be text", field)
		}
		return s, nil
	}
	switch field {
	case "title":
		s, err := str()
		if err != nil {
			return nil, err
		}
		return cleanTitle(s)
	case "notes":
		s, err := str()
		if err != nil || len(s) > MaxNotesBytes {
			return nil, errors.New("notes must be text, at most 20000 bytes")
		}
		return s, nil
	case "priority":
		s, err := str()
		if err != nil || !validLetter(s) {
			return nil, errors.New("priority must be A, B, C or empty")
		}
		return s, nil
	case "effort":
		s, err := str()
		if err != nil || !validEffort(s) {
			return nil, errors.New("effort must be S, M, L or empty")
		}
		return s, nil
	case "deadline", "followUp":
		s, err := str()
		if err != nil || (s != "" && !plannerday.Valid(s)) {
			return nil, fmt.Errorf("%s must be YYYY-MM-DD or empty", field)
		}
		return s, nil
	case "delegate":
		s, err := str()
		if err != nil || len(s) > MaxTitleBytes {
			return nil, errors.New("delegate must be short text")
		}
		return strings.TrimSpace(s), nil
	case "tags":
		var out []string
		switch x := v.(type) {
		case nil:
		case []string:
			out = x
		case []any:
			for _, e := range x {
				s, ok := e.(string)
				if !ok {
					return nil, errors.New("tags must be a list of text")
				}
				out = append(out, s)
			}
		default:
			return nil, errors.New("tags must be a list of text")
		}
		clean := []string{}
		seen := map[string]bool{}
		for _, s := range out {
			s = strings.TrimSpace(s)
			if s == "" || seen[s] {
				continue
			}
			if len(s) > MaxTagBytes {
				return nil, errors.New("a tag is too long")
			}
			seen[s] = true
			clean = append(clean, s)
		}
		if len(clean) > MaxTags {
			return nil, errors.New("too many tags")
		}
		return clean, nil
	}
	return nil, fmt.Errorf("field %q is not editable", field)
}

func fieldValue(t *Task, field string) any {
	switch field {
	case "title":
		return t.Title
	case "notes":
		return t.Notes
	case "priority":
		return t.Priority
	case "deadline":
		return t.Deadline
	case "effort":
		return t.Effort
	case "tags":
		return append([]string{}, t.Tags...)
	case "delegate":
		return t.Delegate
	case "followUp":
		return t.FollowUp
	}
	return nil
}

func equalValue(a, b any) bool {
	as, aok := a.([]string)
	bs, bok := b.([]string)
	if aok || bok {
		if !aok || !bok || len(as) != len(bs) {
			return false
		}
		for i := range as {
			if as[i] != bs[i] {
				return false
			}
		}
		return true
	}
	return a == b
}

// setField writes a validated value and advances that field's revision.
func (tx *Tx) setField(t *Task, field string, val any) {
	if field == "priority" {
		tx.setPriority(t, val.(string))
		return
	}
	m := tx.touchTask(t)
	old := fieldValue(m, field)
	switch field {
	case "title":
		m.Title = val.(string)
	case "notes":
		m.Notes = val.(string)
	case "deadline":
		m.Deadline = val.(string)
	case "effort":
		m.Effort = val.(string)
	case "tags":
		m.Tags = val.([]string)
	case "delegate":
		m.Delegate = val.(string)
	case "followUp":
		m.FollowUp = val.(string)
	}
	m.Revisions[field]++
	tx.event("edited", t.ID, "", map[string]any{"field": field, "from": old, "to": val})
}

// setPriority changes the letter; an open entry moves to the end of its new group, unnumbered.
func (tx *Tx) setPriority(t *Task, letter string) {
	m := tx.touchTask(t)
	old := m.Priority
	m.Priority = letter
	m.Revisions["priority"]++
	tx.event("edited", t.ID, "", map[string]any{"field": "priority", "from": old, "to": letter})
	if open := tx.openPlacement(t.ID); open != nil && open.Letter != letter {
		p := tx.mutPlacement(open.ID)
		tx.bumpGroup(p.Day, p.Letter)
		p.Letter, p.Rank, p.Touched = letter, 0, true
		p.Rev++
		tx.bumpGroup(p.Day, letter)
	}
}

// ── conflict resolution ───────────────────────────────────────────────────

func (tx *Tx) markResolved(id, action string) {
	c := tx.mutConflict(id)
	c.Status = "resolved:" + action
	c.ResolvedAt = tx.stamp()
	tx.event("resolved", c.TaskID, "", map[string]any{"conflictId": id, "action": action})
}

// releaseHeld re-applies a resolved conflict's held ops in queue order. The first builds
// on the resolving change's revision; each later one on the one before it.
func (tx *Tx) releaseHeld(id string) {
	c := tx.mutConflict(id)
	held := c.HeldOps
	c.HeldOps = []Op{}
	for _, op := range held {
		tx.forgetOp(op.ID)
		if op.DependsOn == c.OpID {
			if t := tx.task(op.TaskID); t != nil {
				rev := t.Revisions[op.Field]
				op.DependsOn = ""
				op.BaseRevision = &rev
			}
		}
		tx.applyFresh(op)
	}
}

// discardHeld rejects a conflict's held ops; they are shown with the conflict.
func (tx *Tx) discardHeld(id string) {
	c := tx.mutConflict(id)
	for _, op := range c.HeldOps {
		tx.recordOp(op, Result{OpID: op.ID, Status: Rejected, Reason: "discarded with conflict " + id, ConflictID: id})
	}
}

// opResolve applies Kevin's explicit choice for a tray entry (op.Resolves, op.Value).
func (tx *Tx) opResolve(op Op) Result {
	c := tx.conflict(op.Resolves)
	if c == nil {
		return reject("unknown conflict %s", op.Resolves)
	}
	if c.Status != "open" {
		return Result{Status: Noop, Reason: "conflict already " + c.Status, ConflictID: c.ID}
	}
	action, _ := op.Value.(string)
	allowed := false
	for _, a := range c.Actions {
		if a == action {
			allowed = true
		}
	}
	if !allowed {
		return reject("action %q is not offered for this conflict", action)
	}
	r := Result{Status: Applied, ConflictID: c.ID, TaskID: c.TaskID}
	switch action {
	case ResolveKeepServer, ResolveDiscard, ResolveDismiss:
		tx.markResolved(c.ID, action)
		tx.discardHeld(c.ID)
	case ResolveUseMine:
		orig := c.Op
		orig.ID = op.ID + ":mine"
		t := tx.task(c.TaskID)
		if t == nil || t.State == StatePurged {
			return reject("task is gone")
		}
		if orig.Type == OpSetting {
			rev := tx.settingsView().Revisions[orig.Field]
			orig.BaseRevision = &rev
		} else {
			rev := t.Revisions[c.Field]
			orig.BaseRevision = &rev
		}
		orig.DependsOn = ""
		orig.Resolves = ""
		sub := tx.applyFresh(orig)
		if sub.Status != Applied && sub.Status != Noop {
			return Result{Status: Rejected, ConflictID: c.ID, Reason: "could not apply: " + sub.Reason}
		}
		r.Revision = sub.Revision
		tx.markResolved(c.ID, action)
		tx.releaseHeld(c.ID)
	case ResolveRestoreAndApply, ResolveReopenAndApply, ResolveApplyAnyway:
		t := tx.task(c.TaskID)
		if t == nil || t.State == StatePurged {
			return reject("task is gone")
		}
		if action == ResolveRestoreAndApply && t.State == StateDeleted {
			tx.restore(t)
		}
		if action == ResolveReopenAndApply && t.State == StateCompleted {
			tx.reopen(t)
		}
		orig := c.Op
		orig.ID = op.ID + ":apply"
		orig.BasePlacementID = ""
		if orig.Type == OpEdit {
			rev := tx.task(c.TaskID).Revisions[orig.Field]
			orig.BaseRevision, orig.DependsOn = &rev, ""
		}
		sub := tx.applyFresh(orig)
		if sub.Status != Applied && sub.Status != Noop {
			return Result{Status: Rejected, ConflictID: c.ID, Reason: "could not apply: " + sub.Reason}
		}
		tx.markResolved(c.ID, action)
		tx.releaseHeld(c.ID)
	}
	return r
}
