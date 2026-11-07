package store

import (
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/kevinpinscoe/hohe/server/internal/domain"
)

func commit(t *testing.T, s *Store, st *domain.State, now time.Time, day string, ops ...domain.Op) []domain.Result {
	t.Helper()
	tx := st.Begin(now, day)
	tx.Rollover()
	var rs []domain.Result
	for _, o := range ops {
		rs = append(rs, tx.ApplyOp(o))
	}
	if err := s.Commit(tx.Changes()); err != nil {
		t.Fatal(err)
	}
	tx.Apply()
	return rs
}

func TestRoundTrip(t *testing.T) {
	dir := t.TempDir()
	s, err := Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	st, err := s.Load()
	if err != nil {
		t.Fatal(err)
	}
	now := time.Date(2026, 11, 3, 15, 0, 0, 0, time.UTC)
	a := "A"
	rs := commit(t, s, st, now, "2026-11-03",
		domain.Op{ID: "1", DeviceID: "d", Type: domain.OpCreate, Title: "one", Letter: &a, Day: "2026-11-03"},
		domain.Op{ID: "2", DeviceID: "d", Type: domain.OpCapture, Title: "two"},
	)
	commit(t, s, st, now, "2026-11-03",
		domain.Op{ID: "3", DeviceID: "d", Type: domain.OpSetRank, PlacementID: rs[0].PlacementID, Rank: 1},
		domain.Op{ID: "4", DeviceID: "d", Type: domain.OpDesignate, Day: "2026-11-04", Value: "room"},
	)
	s.Close()

	s2, err := Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer s2.Close()
	st2, err := s2.Load()
	if err != nil {
		t.Fatal(err)
	}
	if len(st2.Tasks) != 2 || len(st2.Placements) != 1 || st2.Placements[rs[0].PlacementID].Rank != 1 {
		t.Fatalf("reload: %d tasks %d placements", len(st2.Tasks), len(st2.Placements))
	}
	if st2.Planning.Designations["2026-11-04"] != "room" || st2.LastRolled != "2026-11-03" || st2.Seq != st.Seq {
		t.Fatalf("planning/ledger/seq not restored: %+v %s %d", st2.Planning, st2.LastRolled, st2.Seq)
	}
	if r := st2.Ops["2"]; r == nil || r.Result.Status != domain.Applied {
		t.Fatal("op record not restored, replay would duplicate")
	}
	// A replay after restart returns the original result.
	tx := st2.Begin(now, "2026-11-03")
	if r := tx.ApplyOp(domain.Op{ID: "2", Type: domain.OpCapture, Title: "two"}); !r.Replayed {
		t.Fatal("replay after restart was not recognized")
	}
}

func TestSnapshotAndRedaction(t *testing.T) {
	dir := t.TempDir()
	s, _ := Open(dir)
	defer s.Close()
	st, _ := s.Load()
	now := time.Date(2026, 11, 3, 15, 0, 0, 0, time.UTC)
	rs := commit(t, s, st, now, "2026-11-03", domain.Op{ID: "1", DeviceID: "d", Type: domain.OpCapture, Title: "t"})
	id := rs[0].TaskID
	one := 1
	commit(t, s, st, now, "2026-11-03",
		domain.Op{ID: "2", DeviceID: "d", Type: domain.OpEdit, TaskID: id, Field: "notes", Value: "private", BaseRevision: &one},
		domain.Op{ID: "3", DeviceID: "d", Type: domain.OpDelete, TaskID: id})
	later := now.AddDate(0, 0, 31)
	commit(t, s, st, later, "2026-12-04")
	if st.Tasks[id].State != domain.StatePurged {
		t.Fatal("not purged")
	}
	ev, err := s.History(id, 0)
	if err != nil {
		t.Fatal(err)
	}
	kinds := []string{}
	for _, e := range ev {
		kinds = append(kinds, e.Kind)
		if e.Kind == "edited" && (e.Data["to"] != Purged || e.Data["from"] != Purged) {
			t.Fatalf("notes not redacted: %+v", e.Data)
		}
	}
	if strings.Join(kinds, ",") != "created,edited,deleted,purged" {
		t.Fatalf("history kinds: %v", kinds)
	}
	snap := filepath.Join(t.TempDir(), "hohe-20261204-0705.sqlite3")
	info, err := s.Snapshot(snap)
	if err != nil {
		t.Fatal(err)
	}
	if info.Tasks != 1 || info.Schema != SchemaVersion || info.Events != 4 {
		t.Fatalf("snapshot %+v", info)
	}
	if _, err := s.Snapshot(snap); err == nil {
		t.Fatal("snapshot overwrote an existing file")
	}
	// The snapshot holds no sessions table: sessions live in their own file.
	sess, err := OpenSessions(dir)
	if err != nil {
		t.Fatal(err)
	}
	sess.Create("h", "test", now, now.Add(time.Hour))
	sess.Close()
	snap2 := filepath.Join(t.TempDir(), "again.sqlite3")
	s.Snapshot(snap2)
	db, _ := openDB(snap2)
	defer db.Close()
	var n int
	db.QueryRow(`SELECT COUNT(*) FROM sqlite_master WHERE name = 'sessions'`).Scan(&n)
	if n != 0 {
		t.Fatal("sessions leaked into the backed-up database")
	}
}

func TestRestoredSnapshotLoads(t *testing.T) {
	dir := t.TempDir()
	s, _ := Open(dir)
	st, _ := s.Load()
	now := time.Date(2026, 11, 3, 15, 0, 0, 0, time.UTC)
	commit(t, s, st, now, "2026-11-03", domain.Op{ID: "1", DeviceID: "d", Type: domain.OpCapture, Title: "keep me"})
	restoreDir := t.TempDir()
	if _, err := s.Snapshot(filepath.Join(restoreDir, DBFile)); err != nil {
		t.Fatal(err)
	}
	s.Close()
	r, err := Open(restoreDir)
	if err != nil {
		t.Fatal(err)
	}
	defer r.Close()
	st2, err := r.Load()
	if err != nil || len(st2.Tasks) != 1 {
		t.Fatalf("restored instance: %v %d", err, len(st2.Tasks))
	}
}

func TestSessions(t *testing.T) {
	s, err := OpenSessions(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	now := time.Now()
	s.Create("h1", "phone", now, now.Add(time.Hour))
	if err := s.Touch("h1", now.Add(30*time.Minute), now.Add(2*time.Hour)); err != nil {
		t.Fatal(err)
	}
	if err := s.Touch("h1", now.Add(3*time.Hour), now.Add(4*time.Hour)); err != ErrNoSession {
		t.Fatalf("expired session accepted: %v", err)
	}
	if err := s.Touch("nope", now, now); err != ErrNoSession {
		t.Fatal("unknown session accepted")
	}
}

func TestSessionsResetOnCredentialChange(t *testing.T) {
	dir := t.TempDir()
	s, err := OpenSessions(dir)
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now()
	if reset, _ := s.ResetIfCredentialChanged("fp1"); !reset {
		t.Fatal("first start should record the fingerprint")
	}
	s.Create("h1", "phone", now, now.Add(time.Hour))
	if reset, _ := s.ResetIfCredentialChanged("fp1"); reset {
		t.Fatal("unchanged credential reset sessions")
	}
	if err := s.Touch("h1", now, now.Add(time.Hour)); err != nil {
		t.Fatal("session lost without a credential change")
	}
	s.Close()
	s, _ = OpenSessions(dir)
	defer s.Close()
	if reset, _ := s.ResetIfCredentialChanged("fp2"); !reset {
		t.Fatal("changed credential did not reset")
	}
	if err := s.Touch("h1", now, now.Add(time.Hour)); err != ErrNoSession {
		t.Fatal("session survived a password change")
	}
}
