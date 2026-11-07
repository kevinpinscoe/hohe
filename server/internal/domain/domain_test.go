package domain

import (
	"fmt"
	"testing"
	"time"

	"github.com/kevinpinscoe/hohe/server/internal/plannerday"
)

// world drives a State through committed transactions at controlled times.
type world struct {
	t   *testing.T
	s   *State
	now time.Time
	loc *time.Location
	n   int
}

func newWorld(t *testing.T, at string) *world {
	t.Helper()
	loc, _ := time.LoadLocation("America/New_York")
	w := &world{t: t, s: NewState(), loc: loc}
	w.at(at)
	w.roll()
	return w
}

// at sets the clock to a local New York wall time "2026-11-03 10:00".
func (w *world) at(local string) {
	tm, err := time.ParseInLocation("2006-01-02 15:04", local, w.loc)
	if err != nil {
		w.t.Fatal(err)
	}
	w.now = tm
}

func (w *world) day() string {
	r, _ := plannerday.ParseRollover(w.s.Settings.Rollover)
	return plannerday.Day(w.now, w.loc, r)
}

func (w *world) tx() *Tx { return w.s.Begin(w.now, w.day()) }

func (w *world) roll() []string {
	tx := w.tx()
	d := tx.Rollover()
	tx.Apply()
	return d
}

func (w *world) op(o Op) Result {
	w.t.Helper()
	if o.ID == "" {
		w.n++
		o.ID = fmt.Sprintf("op-%d", w.n)
	}
	if o.DeviceID == "" {
		o.DeviceID = "phone"
	}
	tx := w.tx()
	tx.Rollover()
	r := tx.ApplyOp(o)
	tx.Apply()
	return r
}

func (w *world) must(o Op) Result {
	w.t.Helper()
	r := w.op(o)
	if r.Status != Applied {
		w.t.Fatalf("%s: got %s (%s)", o.Type, r.Status, r.Reason)
	}
	return r
}

func str(s string) *string { return &s }
func intp(i int) *int      { return &i }

// add creates a task planned on day with a letter, returning its id and placement id.
func (w *world) add(title, letter, day string) (string, string) {
	w.t.Helper()
	r := w.must(Op{Type: OpCreate, Title: title, Letter: str(letter), Day: day})
	return r.TaskID, r.PlacementID
}

func (w *world) open(taskID string) *Placement {
	return w.tx().openPlacement(taskID)
}

func (w *world) rank(taskID string) string {
	p := w.open(taskID)
	if p == nil {
		return "-"
	}
	return fmt.Sprintf("%s%d", p.Letter, p.Rank)
}

func (w *world) task(id string) *Task { return w.s.Tasks[id] }

func TestCompletingA1LeavesA2(t *testing.T) {
	w := newWorld(t, "2026-11-03 10:00")
	d := w.day()
	a1, p1 := w.add("one", "A", d)
	a2, p2 := w.add("two", "A", d)
	w.must(Op{Type: OpSetRank, PlacementID: p1, Rank: 1})
	w.must(Op{Type: OpSetRank, PlacementID: p2, Rank: 2})
	w.must(Op{Type: OpComplete, TaskID: a1})
	if got := w.rank(a2); got != "A2" {
		t.Fatalf("A2 became %s", got)
	}
}

func TestReservedRanks(t *testing.T) {
	w := newWorld(t, "2026-11-03 10:00")
	d := w.day()
	a1, p1 := w.add("one", "A", d)
	a2, p2 := w.add("two", "A", d)
	a3, p3 := w.add("three", "A", d)
	for i, p := range []string{p1, p2, p3} {
		w.must(Op{Type: OpSetRank, PlacementID: p, Rank: i + 1})
	}
	w.must(Op{Type: OpComplete, TaskID: a1})
	// Reorder the open A2 and A3 so A3 comes first.
	w.must(Op{Type: OpReorder, Day: d, Letter: str("A"), Order: []string{p3, p2}})
	if w.rank(a3) != "A2" || w.rank(a2) != "A3" {
		t.Fatalf("after reorder: three=%s two=%s", w.rank(a3), w.rank(a2))
	}
	if p := w.s.Placements[p1]; p.Rank != 1 || p.Outcome != OutcomeCompleted {
		t.Fatalf("completed A1 changed: %+v", p)
	}
	// Typing the reserved A1 is refused.
	r := w.op(Op{Type: OpSetRank, PlacementID: p2, Rank: 1})
	if r.Status != Rejected {
		t.Fatalf("reserved rank accepted: %+v", r)
	}
	// Typing a number held by an open task moves that task on.
	w.must(Op{Type: OpSetRank, PlacementID: p2, Rank: 2})
	if w.rank(a2) != "A2" || w.rank(a3) != "A3" {
		t.Fatalf("after typed rank: two=%s three=%s", w.rank(a2), w.rank(a3))
	}
	// Soft-deleted and forwarded entries reserve too.
	w.must(Op{Type: OpDelete, TaskID: a2})
	if r := w.op(Op{Type: OpSetRank, PlacementID: p3, Rank: 2}); r.Status != Rejected {
		t.Fatalf("rank reserved by a deleted entry accepted: %+v", r)
	}
	assertUniqueRanks(t, w, d)
}

func assertUniqueRanks(t *testing.T, w *world, day string) {
	t.Helper()
	seen := map[string]bool{}
	for _, p := range w.tx().placementsOnDay(day) {
		if p.Rank == 0 {
			continue
		}
		k := fmt.Sprintf("%s%d", p.Letter, p.Rank)
		if seen[k] {
			t.Fatalf("duplicate rank %s on %s", k, day)
		}
		seen[k] = true
	}
}

func TestUndatedCTaskNeverCarried(t *testing.T) {
	w := newWorld(t, "2026-11-03 10:00")
	r := w.must(Op{Type: OpCapture, Title: "someday soon", Letter: str("C")})
	w.at("2026-11-05 10:00")
	w.roll()
	if n := len(w.tx().placementsOfTask(r.TaskID)); n != 0 {
		t.Fatalf("undated C task has %d placements", n)
	}
}

func TestCompletingCDoesNotPromote(t *testing.T) {
	w := newWorld(t, "2026-11-03 10:00")
	r := w.must(Op{Type: OpCapture, Title: "c thing", Letter: str("C")})
	w.must(Op{Type: OpPlanIt, TaskID: r.TaskID, Day: w.day()})
	w.must(Op{Type: OpComplete, TaskID: r.TaskID})
	if w.task(r.TaskID).Priority != "C" {
		t.Fatal("planning or completing promoted a C task")
	}
	ps := w.tx().placementsOfTask(r.TaskID)
	if len(ps) != 1 || ps[0].Letter != "C" || ps[0].Outcome != OutcomeCompleted {
		t.Fatalf("history: %+v", ps)
	}
}

func TestBackToDumpKeepsPriority(t *testing.T) {
	w := newWorld(t, "2026-11-03 10:00")
	id, _ := w.add("x", "B", w.day())
	w.must(Op{Type: OpBackToDump, TaskID: id})
	if w.task(id).Priority != "B" || w.open(id) != nil {
		t.Fatal("back to dump lost the priority or kept the placement")
	}
}

// The acceptance example from §15: a Tuesday task carries through Wednesday to Thursday.
func TestCarryHistory(t *testing.T) {
	w := newWorld(t, "2026-11-03 10:00") // Tuesday
	id, tue := w.add("carry me", "B", w.day())
	w.at("2026-11-04 03:05") // Wednesday, just after the live rollover
	w.roll()
	wed := w.open(id)
	if wed == nil || wed.Day != "2026-11-04" || wed.By != ByRollover || wed.CatchUp {
		t.Fatalf("Wednesday entry: %+v", wed)
	}
	view := w.tx().View() // Kevin views Wednesday while its entry is open
	_ = view
	w.at("2026-11-05 03:05") // Thursday
	w.roll()
	w2 := w.s.Placements[wed.ID]
	if w2.Outcome != OutcomeCarried || w2.Target != "2026-11-05" {
		t.Fatalf("Wednesday after Thursday's rollover: %+v", w2)
	}
	if n := carriedCount(w, id); n != 2 {
		t.Fatalf("carried badge ×%d, want ×2", n)
	}
	tueBefore := *w.s.Placements[tue]
	wedBefore := *w.s.Placements[wed.ID]
	w.must(Op{Type: OpComplete, TaskID: id})
	w.must(Op{Type: OpEdit, TaskID: id, Field: "title", Value: "renamed", BaseRevision: intp(1)})
	if *w.s.Placements[tue] != tueBefore || *w.s.Placements[wed.ID] != wedBefore {
		t.Fatal("closed carried placements changed after completion")
	}
	if w.task(id).State != StateCompleted {
		t.Fatal("not completed")
	}
}

func carriedCount(w *world, taskID string) int {
	n := 0
	for _, p := range w.tx().placementsOfTask(taskID) {
		switch p.Outcome {
		case OutcomeReturned:
			n = 0
		case OutcomeCarried:
			n++
		}
	}
	return n
}

func TestViewingChangesNothing(t *testing.T) {
	w := newWorld(t, "2026-11-03 10:00")
	w.add("a", "A", w.day())
	w.must(Op{Type: OpCapture, Title: "c", Letter: str("C")})
	tx := w.tx()
	_ = tx.View()
	_ = tx.Suggest(true)
	if !tx.Changes().Empty() {
		t.Fatalf("view produced changes: %+v", tx.Changes())
	}
}

func TestCatchUp(t *testing.T) {
	live := newWorld(t, "2026-11-03 10:00")
	down := newWorld(t, "2026-11-03 10:00")
	for _, w := range []*world{live, down} {
		w.add("t1", "A", w.day())
		w.add("t2", "B", w.day())
	}
	for _, d := range []string{"2026-11-04", "2026-11-05", "2026-11-06"} {
		live.at(d + " 03:01")
		live.roll()
	}
	down.at("2026-11-06 14:00") // down for three planner days
	if days := down.roll(); len(days) != 3 {
		t.Fatalf("catch-up processed %v", days)
	}
	shape := func(w *world, catchUpWant bool) []string {
		var out []string
		v := w.tx().View()
		for _, p := range v.Placements {
			if p.By == ByRollover && p.CatchUp != catchUpWant {
				t.Errorf("placement %s on %s catchUp=%v", p.ID, p.Day, p.CatchUp)
			}
			out = append(out, fmt.Sprintf("%s/%s/%s/%s", w.s.Tasks[p.TaskID].Title, p.Day, p.Outcome, p.Target))
		}
		return out
	}
	a, b := shape(live, false), shape(down, true)
	if fmt.Sprint(a) != fmt.Sprint(b) {
		t.Fatalf("catch-up differs from live:\nlive %v\ndown %v", a, b)
	}
	before := len(down.s.Placements)
	if days := down.roll(); len(days) != 0 || len(down.s.Placements) != before {
		t.Fatal("second catch-up changed something")
	}
}

func TestFutureAndDelegatedDoNotCarry(t *testing.T) {
	w := newWorld(t, "2026-11-03 10:00")
	fut, _ := w.add("future", "A", "2026-11-10")
	del, _ := w.add("delegated", "B", w.day())
	w.must(Op{Type: OpDelegate, TaskID: del, Who: "Sam", Day: "2026-11-06"})
	w.at("2026-11-05 10:00")
	w.roll()
	if p := w.open(fut); p == nil || p.Day != "2026-11-10" {
		t.Fatalf("future task moved: %+v", p)
	}
	if w.open(del) != nil {
		t.Fatal("delegated task carried")
	}
	w.at("2026-11-06 10:00")
	w.roll()
	if p := w.open(del); p == nil || p.Day != "2026-11-06" || w.task(del).State != StateActive {
		t.Fatalf("delegated task not back on its follow-up day: %+v", p)
	}
}

func TestRolloverAcrossDST(t *testing.T) {
	for _, c := range []struct{ start, before, after, want string }{
		{"2026-10-31 10:00", "2026-11-01 02:59", "2026-11-01 03:00", "2026-11-01"}, // fall back
		{"2027-03-13 10:00", "2027-03-14 01:59", "2027-03-14 03:00", "2027-03-14"}, // spring forward
	} {
		w := newWorld(t, c.start)
		id, _ := w.add("dst", "A", w.day())
		w.at(c.before)
		if days := w.roll(); len(days) != 0 {
			t.Fatalf("rolled early at %s: %v", c.before, days)
		}
		w.at(c.after)
		if days := w.roll(); len(days) != 1 || days[0] != c.want {
			t.Fatalf("at %s rolled %v", c.after, days)
		}
		if p := w.open(id); p.Day != c.want || p.CatchUp {
			t.Fatalf("%+v", p)
		}
	}
}

func TestSuggestions(t *testing.T) {
	w := newWorld(t, "2026-09-20 10:00")
	old := w.must(Op{Type: OpCapture, Title: "old C", Letter: str("C")}).TaskID
	w.at("2026-10-10 10:00")
	w.roll()
	young := w.must(Op{Type: OpCapture, Title: "young C, deadline soon", Letter: str("C"), Deadline: str("2026-10-14")}).TaskID
	w.must(Op{Type: OpCapture, Title: "young C", Letter: str("C")})
	w.at("2026-10-12 10:00")
	w.roll()
	tx := w.tx()
	if s := tx.Suggest(false); s != nil {
		t.Fatalf("suggested onto an unmarked day: %+v", s)
	}
	s := tx.Suggest(true)
	if s == nil || s.TaskID != young || s.Day != "2026-10-12" {
		t.Fatalf("deadline exception should win while planning today: %+v", s)
	}
	w.must(Op{Type: OpDesignate, Day: "2026-10-12", Value: "full"})
	w.must(Op{Type: OpDesignate, Day: "2026-10-13", Value: "room"})
	w.must(Op{Type: OpDesignate, Day: "2026-10-14", Value: "rest"})
	s = w.tx().Suggest(true)
	if s == nil || s.Day != "2026-10-13" {
		t.Fatalf("should target only the room day: %+v", s)
	}
	w.must(Op{Type: OpSnooze, TaskID: young})
	s = w.tx().Suggest(true)
	if s == nil || s.TaskID != old {
		t.Fatalf("snoozing one task should leave others: %+v", s)
	}
	w.must(Op{Type: OpPause})
	if s := w.tx().Suggest(true); s != nil {
		t.Fatal("paused suggestions still suggested")
	}
}

func TestCardTimeAndOncePerDay(t *testing.T) {
	w := newWorld(t, "2026-11-03 06:59")
	if w.tx().CardAllowed() {
		t.Fatal("card before 07:00")
	}
	w.at("2026-11-03 07:00")
	if !w.tx().CardAllowed() {
		t.Fatal("card not allowed at 07:00")
	}
	w.must(Op{Type: OpDismissCard})
	w.at("2026-11-03 23:00")
	if w.tx().CardAllowed() {
		t.Fatal("second card the same day")
	}
	w.at("2026-11-04 01:30") // still planner day 11-03
	if w.tx().CardAllowed() {
		t.Fatal("card after midnight on the same planner day")
	}
	w.at("2026-11-04 07:05")
	w.roll()
	if !w.tx().CardAllowed() {
		t.Fatal("card not allowed the next planner day")
	}
}

func TestCaptureAndReplay(t *testing.T) {
	w := newWorld(t, "2026-11-03 10:00")
	r := w.must(Op{ID: "cap-1", Type: OpCapture, Title: "  Call Sarah  "})
	tk := w.task(r.TaskID)
	if tk.Title != "Call Sarah" || tk.Priority != "" || w.open(r.TaskID) != nil {
		t.Fatalf("capture: %+v", tk)
	}
	again := w.op(Op{ID: "cap-1", Type: OpCapture, Title: "Call Sarah"})
	if !again.Replayed || again.TaskID != r.TaskID || len(w.s.Tasks) != 1 {
		t.Fatalf("replay created a duplicate: %+v", again)
	}
	if r := w.op(Op{Type: OpCapture, Title: "   "}); r.Status != Rejected {
		t.Fatal("empty title accepted")
	}
	if r := w.op(Op{Type: OpCapture, TaskID: tk.ID, Title: "dup"}); r.Status != Rejected {
		t.Fatal("reused task id accepted")
	}
	r2 := w.must(Op{Type: OpCapture, Title: "B for Saturday", Letter: str("B"), Day: "2026-11-07", Deadline: str("2026-11-08")})
	if p := w.open(r2.TaskID); p == nil || p.Day != "2026-11-07" || p.Letter != "B" || w.task(r2.TaskID).Deadline != "2026-11-08" {
		t.Fatal("optional capture fields not applied")
	}
}

// §15: an old offline edit reconnects after a newer server edit.
func TestStaleSameFieldEdit(t *testing.T) {
	w := newWorld(t, "2026-11-03 10:00")
	id := w.must(Op{Type: OpCapture, Title: "rev1"}).TaskID
	w.must(Op{Type: OpEdit, TaskID: id, Field: "title", Value: "rev2", BaseRevision: intp(1)})
	w.must(Op{Type: OpEdit, TaskID: id, Field: "title", Value: "rev3", BaseRevision: intp(2)})
	// Phone offline based on revision 3; desktop edits online to revision 4.
	w.must(Op{DeviceID: "desk", Type: OpEdit, TaskID: id, Field: "title", Value: "desk", BaseRevision: intp(3)})
	r := w.op(Op{ID: "phone-edit", Type: OpEdit, TaskID: id, Field: "title", Value: "phone", BaseRevision: intp(3)})
	if r.Status != InTray || w.task(id).Title != "desk" {
		t.Fatalf("stale edit: %+v title=%s", r, w.task(id).Title)
	}
	c := w.s.Conflicts[r.ConflictID]
	if c.ServerValue != "desk" || c.ProposedValue != "phone" || c.ServerRevision != 4 || len(c.HeldOps) != 0 {
		t.Fatalf("conflict: %+v", c)
	}
	v := w.tx().View()
	if len(v.Conflicts) != 1 || v.Conflicts[0].HeldOps == nil {
		t.Fatal("tray must list the conflict with a non-nil heldOps")
	}
	w.must(Op{Type: OpResolve, Resolves: c.ID, Value: ResolveUseMine})
	if tk := w.task(id); tk.Title != "phone" || tk.Revisions["title"] != 5 {
		t.Fatalf("use mine: %+v", tk)
	}
	// Replaying the original stale op returns its original result.
	if again := w.op(Op{ID: "phone-edit", Type: OpEdit, TaskID: id, Field: "title", Value: "phone", BaseRevision: intp(3)}); !again.Replayed || again.Status != InTray {
		t.Fatalf("replay: %+v", again)
	}
}

func TestQueuedEditsHeldWithConflict(t *testing.T) {
	w := newWorld(t, "2026-11-03 10:00")
	id := w.must(Op{Type: OpCapture, Title: "t"}).TaskID
	w.must(Op{DeviceID: "desk", Type: OpEdit, TaskID: id, Field: "title", Value: "desk", BaseRevision: intp(1)})
	r1 := w.op(Op{ID: "q1", Type: OpEdit, TaskID: id, Field: "title", Value: "p1", BaseRevision: intp(1)})
	r2 := w.op(Op{ID: "q2", Type: OpEdit, TaskID: id, Field: "title", Value: "p2", DependsOn: "q1"})
	r3 := w.op(Op{ID: "q3", Type: OpEdit, TaskID: id, Field: "notes", Value: "n", BaseRevision: intp(1)})
	if r1.Status != InTray || r2.Status != Held || r3.Status != Applied {
		t.Fatalf("q1=%s q2=%s q3=%s", r1.Status, r2.Status, r3.Status)
	}
	if c := w.s.Conflicts[r1.ConflictID]; len(c.HeldOps) != 1 || c.HeldOps[0].ID != "q2" {
		t.Fatalf("held ops: %+v", c.HeldOps)
	}
	w.must(Op{Type: OpResolve, Resolves: r1.ConflictID, Value: ResolveUseMine})
	if tk := w.task(id); tk.Title != "p2" {
		t.Fatalf("held edit not released in order: title=%s", tk.Title)
	}
}

func TestKeepServerDiscardsHeld(t *testing.T) {
	w := newWorld(t, "2026-11-03 10:00")
	id := w.must(Op{Type: OpCapture, Title: "t"}).TaskID
	w.must(Op{DeviceID: "desk", Type: OpEdit, TaskID: id, Field: "title", Value: "desk", BaseRevision: intp(1)})
	r1 := w.op(Op{ID: "q1", Type: OpEdit, TaskID: id, Field: "title", Value: "p1", BaseRevision: intp(1)})
	w.op(Op{ID: "q2", Type: OpEdit, TaskID: id, Field: "title", Value: "p2", DependsOn: "q1"})
	w.must(Op{Type: OpResolve, Resolves: r1.ConflictID, Value: ResolveKeepServer})
	if w.task(id).Title != "desk" || w.s.Ops["q2"].Result.Status != Rejected {
		t.Fatal("keep server should keep desk and reject the held edit")
	}
}

func TestIndependentFieldsMerge(t *testing.T) {
	w := newWorld(t, "2026-11-03 10:00")
	id := w.must(Op{Type: OpCapture, Title: "t"}).TaskID
	w.must(Op{DeviceID: "desk", Type: OpEdit, TaskID: id, Field: "deadline", Value: "2026-11-09", BaseRevision: intp(1)})
	w.must(Op{Type: OpEdit, TaskID: id, Field: "title", Value: "phone title", BaseRevision: intp(1)})
	if tk := w.task(id); tk.Title != "phone title" || tk.Deadline != "2026-11-09" {
		t.Fatalf("%+v", tk)
	}
}

func TestCompleteWinsOverForward(t *testing.T) {
	// Forward arrives after the completion: it goes to the tray, the task stays completed.
	w := newWorld(t, "2026-11-03 10:00")
	id, p := w.add("t", "A", w.day())
	w.must(Op{Type: OpComplete, TaskID: id, BasePlacementID: p})
	r := w.op(Op{DeviceID: "desk", Type: OpForward, TaskID: id, Day: "2026-11-05", BasePlacementID: p})
	if r.Status != InTray || w.task(id).State != StateCompleted {
		t.Fatalf("stale forward: %+v", r)
	}
	// Forward applied first, then a stale completion: completion still wins, with a notice.
	w2 := newWorld(t, "2026-11-03 10:00")
	id2, p2 := w2.add("t", "A", w2.day())
	w2.must(Op{DeviceID: "desk", Type: OpForward, TaskID: id2, Day: "2026-11-05", BasePlacementID: p2})
	r2 := w2.must(Op{Type: OpComplete, TaskID: id2, BasePlacementID: p2})
	if w2.task(id2).State != StateCompleted || r2.ConflictID == "" || w2.s.Conflicts[r2.ConflictID].Kind != KindSuperseded {
		t.Fatalf("completion after forward: %+v", r2)
	}
}

func TestDeleteAgainstEdit(t *testing.T) {
	w := newWorld(t, "2026-11-03 10:00")
	id, _ := w.add("t", "A", w.day())
	w.must(Op{DeviceID: "desk", Type: OpDelete, TaskID: id})
	r := w.op(Op{Type: OpEdit, TaskID: id, Field: "title", Value: "edited", BaseRevision: intp(1)})
	if r.Status != InTray || w.task(id).State != StateDeleted {
		t.Fatalf("edit resurrected a deleted task: %+v", r)
	}
	c := w.s.Conflicts[r.ConflictID]
	if fmt.Sprint(c.Actions) != fmt.Sprint([]string{ResolveRestoreAndApply, ResolveDiscard}) {
		t.Fatalf("actions %v", c.Actions)
	}
	w.must(Op{Type: OpResolve, Resolves: c.ID, Value: ResolveRestoreAndApply})
	if tk := w.task(id); tk.State != StateActive || tk.Title != "edited" || w.open(id) == nil {
		t.Fatalf("restore and apply: %+v", tk)
	}
}

func TestCompetingReordersRebased(t *testing.T) {
	w := newWorld(t, "2026-11-03 10:00")
	d := w.day()
	_, p1 := w.add("1", "B", d)
	_, p2 := w.add("2", "B", d)
	_, p3 := w.add("3", "B", d)
	w.must(Op{Type: OpReorder, Day: d, Letter: str("B"), Order: []string{p1, p2, p3}})
	base := w.s.GroupRevs[GroupKey{d, "B"}]
	// Desk adds a fourth entry and reorders; the phone's stale reorder arrives after.
	_, p4 := w.add("4", "B", d)
	w.must(Op{DeviceID: "desk", Type: OpReorder, Day: d, Letter: str("B"), Order: []string{p4, p1, p2, p3}})
	r := w.must(Op{Type: OpReorder, Day: d, Letter: str("B"), Order: []string{p3, p2, p1}, BaseRevision: intp(base)})
	if r.Notice == "" {
		t.Fatal("rebased reorder should carry a notice")
	}
	got := []int{w.s.Placements[p3].Rank, w.s.Placements[p2].Rank, w.s.Placements[p1].Rank, w.s.Placements[p4].Rank}
	if fmt.Sprint(got) != "[1 2 3 4]" {
		t.Fatalf("rebased ranks %v", got)
	}
	assertUniqueRanks(t, w, d)
}

func TestCarriedEntryFollowedNotConflicted(t *testing.T) {
	w := newWorld(t, "2026-11-03 10:00")
	id, p := w.add("t", "A", w.day())
	w.at("2026-11-04 10:00")
	w.roll()
	// The phone was offline and still saw Tuesday's entry.
	r := w.op(Op{Type: OpForward, TaskID: id, Day: "2026-11-06", BasePlacementID: p})
	if r.Status != Applied {
		t.Fatalf("a rollover carry is not a conflict: %+v", r)
	}
}

func TestPlacementChangedElsewhereGoesToTray(t *testing.T) {
	w := newWorld(t, "2026-11-03 10:00")
	id, p := w.add("t", "A", w.day())
	w.must(Op{DeviceID: "desk", Type: OpBackToDump, TaskID: id, BasePlacementID: p})
	w.must(Op{DeviceID: "desk", Type: OpAssign, TaskID: id, Day: "2026-11-08"})
	r := w.op(Op{Type: OpForward, TaskID: id, Day: "2026-11-05", BasePlacementID: p})
	if r.Status != InTray || w.s.Conflicts[r.ConflictID].Kind != KindPlacement {
		t.Fatalf("%+v", r)
	}
}

func TestPurgeAndTombstone(t *testing.T) {
	w := newWorld(t, "2026-11-03 10:00")
	d := w.day()
	id, p := w.add("secret-ish title", "A", d)
	w.must(Op{Type: OpSetRank, PlacementID: p, Rank: 1})
	w.must(Op{Type: OpEdit, TaskID: id, Field: "notes", Value: "private notes", BaseRevision: intp(1)})
	w.must(Op{ID: "old-op", Type: OpEdit, TaskID: id, Field: "tags", Value: []any{"x"}, BaseRevision: intp(1)})
	w.must(Op{Type: OpDelete, TaskID: id})
	w.at("2026-12-02 10:00") // 29 days: not yet
	w.roll()
	if w.task(id).State != StateDeleted {
		t.Fatal("purged early")
	}
	w.at("2026-12-03 10:00") // 30 days
	tx := w.tx()
	tx.Rollover()
	ch := tx.Changes()
	tx.Apply()
	tk := w.task(id)
	if tk.State != StatePurged || tk.Notes != "" || len(tk.Tags) != 0 || tk.Title != "secret-ish title" {
		t.Fatalf("tombstone: %+v", tk)
	}
	if len(ch.Redactions) != 1 || ch.Redactions[0].TaskID != id {
		t.Fatalf("redactions %+v", ch.Redactions)
	}
	// The placement and its reservation survive.
	pl := w.s.Placements[p]
	if pl.Rank != 1 || pl.Outcome != OutcomeDeleted || pl.Day != d {
		t.Fatalf("placement changed: %+v", pl)
	}
	// A stale offline op cannot bring it back; Discard is the only action.
	r := w.op(Op{Type: OpEdit, TaskID: id, Field: "title", Value: "back?", BaseRevision: intp(1)})
	if r.Status != InTray || fmt.Sprint(w.s.Conflicts[r.ConflictID].Actions) != "[discard]" {
		t.Fatalf("op on purged task: %+v", r)
	}
	for _, typ := range []string{OpRestore, OpComplete, OpForward} {
		if r := w.op(Op{Type: typ, TaskID: id, Day: "2026-12-05"}); r.Status != InTray {
			t.Fatalf("%s on purged task: %+v", typ, r)
		}
	}
	if r := w.op(Op{Type: OpCapture, TaskID: id, Title: "recreate"}); r.Status != Rejected {
		t.Fatal("capture recreated a purged id")
	}
	if again := w.op(Op{ID: "old-op", Type: OpEdit, TaskID: id, Field: "tags", Value: []any{"x"}, BaseRevision: intp(1)}); !again.Replayed || again.Status != Applied {
		t.Fatalf("old op replay: %+v", again)
	}
}

func TestPurgeRespectsOneDayMinimum(t *testing.T) {
	w := newWorld(t, "2026-11-03 10:00")
	id := w.must(Op{Type: OpCapture, Title: "t"}).TaskID
	w.must(Op{Type: OpSetting, Field: "deleteRetentionDays", Value: float64(1), BaseRevision: intp(0)})
	w.at("2026-11-03 20:00")
	w.must(Op{Type: OpDelete, TaskID: id})
	w.at("2026-11-04 04:00") // a new planner day, but only 8 hours later
	w.roll()
	if w.task(id).State != StateDeleted {
		t.Fatal("purged less than a day after deletion")
	}
}

func TestSettingsRevisions(t *testing.T) {
	w := newWorld(t, "2026-11-03 10:00")
	w.must(Op{DeviceID: "desk", Type: OpSetting, Field: "aWarning", Value: float64(5), BaseRevision: intp(0)})
	r := w.op(Op{Type: OpSetting, Field: "aWarning", Value: float64(3), BaseRevision: intp(0)})
	if r.Status != InTray || w.s.Settings.AWarning != 5 {
		t.Fatalf("%+v", r)
	}
	if r := w.op(Op{Type: OpSetting, Field: "timeZone", Value: "Mars/Olympus", BaseRevision: intp(0)}); r.Status != Rejected {
		t.Fatal("bad time zone accepted")
	}
}

func TestCorrectionIsExplicitAndRecorded(t *testing.T) {
	w := newWorld(t, "2026-11-03 10:00")
	id, p := w.add("t", "A", w.day())
	w.at("2026-11-04 10:00")
	w.roll()
	tx := w.tx()
	r := tx.ApplyOp(Op{ID: "fix", Type: OpCorrect, PlacementID: p, Outcome: OutcomeCompleted})
	ch := tx.Changes()
	tx.Apply()
	if r.Status != Applied || w.s.Placements[p].Outcome != OutcomeCompleted {
		t.Fatalf("%+v", r)
	}
	found := false
	for _, e := range ch.Events {
		if e.Kind == "corrected" && e.Data["from"] == OutcomeCarried {
			found = true
		}
	}
	if !found || w.task(id).State != StateActive {
		t.Fatal("correction not recorded, or it changed the task's current state")
	}
}

func TestDefaults(t *testing.T) {
	s := DefaultSettings()
	if s.TimeZone != "America/New_York" || s.Rollover != "03:00" || s.AWarning != 4 || s.MinAgeDays != 14 ||
		s.DeadlineWindowDays != 7 || s.SnoozeDays != 7 || s.CardEarliest != "07:00" || s.DeleteRetentionDays != 30 {
		t.Fatalf("defaults drifted from Kevin's 2026-11-07 decisions: %+v", s)
	}
}
