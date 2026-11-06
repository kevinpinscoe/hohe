package store

import (
	"testing"
	"time"
)

func newStore(t *testing.T) *Store {
	t.Helper()
	s := New(func(time.Time) string { return "2026-11-06" })
	s.Reset(true)
	return s
}

func rev(n int) *int { return &n }

func one(t *testing.T, s *Store, op Op) Result {
	t.Helper()
	r := s.Apply([]Op{op})
	if len(r) != 1 {
		t.Fatalf("want 1 result, got %d", len(r))
	}
	return r[0]
}

func TestCaptureReplayIsDuplicateSafe(t *testing.T) {
	s := newStore(t)
	op := Op{ID: "op-1", DeviceID: "phone", Type: "capture", Value: "Buy synthetic milk"}
	first := one(t, s, op)
	if first.Status != Applied || first.Replayed {
		t.Fatalf("first: %+v", first)
	}
	again := s.Apply([]Op{op, op})
	for _, r := range again {
		if r.Status != Applied || !r.Replayed || r.Task.ID != first.Task.ID {
			t.Fatalf("replay: %+v", r)
		}
	}
	tasks, _, st := s.Snapshot()
	n := 0
	for _, tk := range tasks {
		if tk.Title == "Buy synthetic milk" {
			n++
		}
	}
	if n != 1 {
		t.Fatalf("captured %d times, want 1", n)
	}
	if st.OpsReplayed != 2 || st.OpsApplied != 1 {
		t.Fatalf("stats: %+v", st)
	}
}

// The proposal's acceptance example: the phone edits a title offline based on revision 1
// (the seed's revision); the desktop edits the same title online first. The server keeps
// the desktop's value and the phone's edit goes to the conflict tray with both values.
func TestOldOfflineEditGoesToConflictTray(t *testing.T) {
	s := newStore(t)
	desk := one(t, s, Op{ID: "d-1", DeviceID: "desktop", Type: "edit", TaskID: "seed-1", Field: "title", Value: "Desktop title", BaseRevision: rev(1)})
	if desk.Status != Applied || desk.Revision != 2 {
		t.Fatalf("desktop: %+v", desk)
	}
	phone := one(t, s, Op{ID: "p-1", DeviceID: "phone", Type: "edit", TaskID: "seed-1", Field: "title", Value: "Phone title", BaseRevision: rev(1)})
	if phone.Status != Conflict || phone.ConflictID == "" {
		t.Fatalf("phone: %+v", phone)
	}
	tasks, cs, _ := s.Snapshot()
	if tasks[0].Title != "Desktop title" {
		t.Fatalf("server value lost: %q", tasks[0].Title)
	}
	if len(cs) != 1 || cs[0].ServerValue != "Desktop title" || cs[0].ProposedValue != "Phone title" || cs[0].Status != "open" {
		t.Fatalf("conflict tray: %+v", cs)
	}
	// Kevin chooses "use mine": a new op against the current revision.
	mine := one(t, s, Op{ID: "p-2", DeviceID: "phone", Type: "edit", TaskID: "seed-1", Field: "title", Value: "Phone title", BaseRevision: rev(2), Resolves: phone.ConflictID})
	if mine.Status != Applied || mine.Revision != 3 {
		t.Fatalf("use mine: %+v", mine)
	}
	_, cs, _ = s.Snapshot()
	if cs[0].Status != "resolved-mine" {
		t.Fatalf("conflict not resolved: %+v", cs[0])
	}
}

func TestDifferentFieldsMerge(t *testing.T) {
	s := newStore(t)
	a := one(t, s, Op{ID: "a", Type: "edit", TaskID: "seed-2", Field: "title", Value: "New title", BaseRevision: rev(1)})
	b := one(t, s, Op{ID: "b", Type: "edit", TaskID: "seed-2", Field: "notes", Value: "New notes", BaseRevision: rev(1)})
	if a.Status != Applied || b.Status != Applied {
		t.Fatalf("a=%+v b=%+v", a, b)
	}
}

func TestSameValueIsNoop(t *testing.T) {
	s := newStore(t)
	one(t, s, Op{ID: "a", Type: "edit", TaskID: "seed-2", Field: "title", Value: "Same", BaseRevision: rev(1)})
	r := one(t, s, Op{ID: "b", Type: "edit", TaskID: "seed-2", Field: "title", Value: "Same", BaseRevision: rev(1)})
	if r.Status != Noop {
		t.Fatalf("want noop, got %+v", r)
	}
}

// Three queued edits from one device: the first conflicts, the second depends on it (same
// field) and is held with it, the third touches another field and applies.
func TestDependentQueuedEditIsHeld(t *testing.T) {
	s := newStore(t)
	one(t, s, Op{ID: "srv", Type: "edit", TaskID: "seed-3", Field: "title", Value: "Server", BaseRevision: rev(1)})
	res := s.Apply([]Op{
		{ID: "q1", Type: "edit", TaskID: "seed-3", Field: "title", Value: "Phone v1", BaseRevision: rev(1)},
		{ID: "q2", Type: "edit", TaskID: "seed-3", Field: "title", Value: "Phone v2", DependsOn: "q1"},
		{ID: "q3", Type: "edit", TaskID: "seed-3", Field: "notes", Value: "Phone notes", BaseRevision: rev(1)},
	})
	if res[0].Status != Conflict || res[1].Status != Held || res[2].Status != Applied {
		t.Fatalf("statuses: %s %s %s", res[0].Status, res[1].Status, res[2].Status)
	}
	if res[1].ConflictID != res[0].ConflictID {
		t.Fatal("held op not attached to its conflict")
	}
	// Keep server: the held op is discarded with the rejected edit.
	c, err := s.KeepServer(res[0].ConflictID)
	if err != nil || c.Status != "resolved-server" || len(c.HeldOps) != 1 {
		t.Fatalf("keep server: %+v %v", c, err)
	}
	tasks, _, _ := s.Snapshot()
	if tasks[2].Title != "Server" || tasks[2].Notes != "Phone notes" {
		t.Fatalf("task: %+v", tasks[2])
	}
}

func TestUseMineReleasesHeldEditsInOrder(t *testing.T) {
	s := newStore(t)
	one(t, s, Op{ID: "srv", Type: "edit", TaskID: "seed-3", Field: "title", Value: "Server", BaseRevision: rev(1)})
	res := s.Apply([]Op{
		{ID: "q1", Type: "edit", TaskID: "seed-3", Field: "title", Value: "Phone v1", BaseRevision: rev(1)},
		{ID: "q2", Type: "edit", TaskID: "seed-3", Field: "title", Value: "Phone v2", DependsOn: "q1"},
	})
	one(t, s, Op{ID: "m", Type: "edit", TaskID: "seed-3", Field: "title", Value: "Phone v1", BaseRevision: rev(2), Resolves: res[0].ConflictID})
	tasks, _, _ := s.Snapshot()
	if tasks[2].Title != "Phone v2" || tasks[2].Revisions["title"] != 4 {
		t.Fatalf("held edit not released in order: %+v", tasks[2])
	}
}

func TestRejections(t *testing.T) {
	s := newStore(t)
	for _, op := range []Op{
		{ID: "e1", Type: "capture", Value: "   "},
		{ID: "e2", Type: "edit", TaskID: "nope", Field: "title", Value: "x", BaseRevision: rev(1)},
		{ID: "e3", Type: "edit", TaskID: "seed-1", Field: "id", Value: "x", BaseRevision: rev(1)},
		{ID: "e4", Type: "edit", TaskID: "seed-1", Field: "title", Value: "x"},
		{ID: "e5", Type: "bogus"},
		{ID: "e6", Type: "edit", TaskID: "seed-1", Field: "title", Value: "x", DependsOn: "missing"},
	} {
		if r := one(t, s, op); r.Status != Rejected {
			t.Errorf("%s: want rejected, got %+v", op.ID, r)
		}
	}
	if r := one(t, s, Op{Type: "capture", Value: "x"}); r.Status != Rejected {
		t.Errorf("missing id accepted: %+v", r)
	}
}

func TestPlannerDayMismatchFlagged(t *testing.T) {
	s := newStore(t)
	r := one(t, s, Op{ID: "c", Type: "capture", Value: "x", ClientPlannerDay: "2026-11-05"})
	if !r.PlannerDayMismatch || r.ServerPlannerDay != "2026-11-06" || r.Task.PlannerDay != "2026-11-06" {
		t.Fatalf("mismatch handling: %+v", r)
	}
}
