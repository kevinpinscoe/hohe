// Package app is the HOHE service: the in-memory model, its SQLite store and the clock,
// under one lock. Every change is written to the database before it becomes visible; if
// the write fails, the change is discarded and the error returned.
package app

import (
	"errors"
	"fmt"
	"sync"
	"time"

	"github.com/kevinpinscoe/hohe/server/internal/domain"
	"github.com/kevinpinscoe/hohe/server/internal/plannerday"
	"github.com/kevinpinscoe/hohe/server/internal/store"
)

// Service owns the model.
type Service struct {
	mu  sync.Mutex
	st  *domain.State
	db  *store.Store
	Now func() time.Time
}

// New loads the model from db and runs any rollover catch-up that is due.
func New(db *store.Store, now func() time.Time) (*Service, error) {
	st, err := db.Load()
	if err != nil {
		return nil, err
	}
	s := &Service{st: st, db: db, Now: now}
	if _, err := s.Tick(); err != nil {
		return nil, err
	}
	return s, nil
}

// day is the current server planner day. Call with s.mu held.
func (s *Service) day(now time.Time) string {
	loc, r, err := s.st.Settings.Location()
	if err != nil {
		loc, _ = time.LoadLocation("America/New_York")
		r, _ = plannerday.ParseRollover("03:00")
	}
	return plannerday.Day(now, loc, r)
}

// begin starts a Tx and runs any rollover due first, so queued operations always apply
// after catch-up (§11.5). Call with s.mu held.
func (s *Service) begin() *domain.Tx {
	now := s.Now()
	tx := s.st.Begin(now, s.day(now))
	tx.Rollover()
	return tx
}

func (s *Service) commit(tx *domain.Tx) error {
	if err := s.db.Commit(tx.Changes()); err != nil {
		return fmt.Errorf("saving: %w", err)
	}
	tx.Apply()
	return nil
}

// Tick runs any rollover that is due and returns the days processed.
func (s *Service) Tick() ([]string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	now := s.Now()
	tx := s.st.Begin(now, s.day(now))
	days := tx.Rollover()
	if len(days) == 0 {
		return nil, nil
	}
	return days, s.commit(tx)
}

// ErrBatch is returned for an oversized batch.
var ErrBatch = errors.New("too many operations in one batch")

// Sync applies a batch of operations in order and returns one result per op plus the
// resulting view. The whole batch commits together.
func (s *Service) Sync(ops []domain.Op) ([]domain.Result, domain.View, error) {
	if len(ops) > domain.MaxBatch {
		return nil, domain.View{}, ErrBatch
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	tx := s.begin()
	results := make([]domain.Result, 0, len(ops))
	for _, op := range ops {
		results = append(results, tx.ApplyOp(op))
	}
	if err := s.commit(tx); err != nil {
		return nil, domain.View{}, err
	}
	return results, s.st.Begin(s.Now(), tx.Day()).View(), nil
}

// View returns the current client view. Viewing changes nothing; only a due rollover is
// written first.
func (s *Service) View() (domain.View, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	tx := s.begin()
	if err := s.commit(tx); err != nil {
		return domain.View{}, err
	}
	return s.st.Begin(s.Now(), tx.Day()).View(), nil
}

// CaptureRequest is one capture through the capture API.
type CaptureRequest struct {
	TokenName      string
	IdempotencyKey string
	Title          string
	Priority       string
	Day            string
	Deadline       string
}

// CaptureResponse confirms what the backend accepted.
type CaptureResponse struct {
	TaskID   string `json:"taskId"`
	Title    string `json:"title"`
	Landed   string `json:"landed"`
	Replayed bool   `json:"replayed"`
}

// Capture creates a task through the capture API. A retry with the same idempotency key
// returns the original result and creates nothing.
func (s *Service) Capture(req CaptureRequest) (CaptureResponse, error) {
	if req.IdempotencyKey == "" || len(req.IdempotencyKey) > 80 {
		return CaptureResponse{}, errors.New("an idempotency key (at most 80 characters) is required")
	}
	op := domain.Op{ID: "capture:" + req.TokenName + ":" + req.IdempotencyKey, DeviceID: "capture:" + req.TokenName,
		Type: domain.OpCapture, Title: req.Title}
	if req.Priority != "" {
		op.Letter = &req.Priority
	}
	op.Day = req.Day
	if req.Deadline != "" {
		op.Deadline = &req.Deadline
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	tx := s.begin()
	var r domain.Result
	if rec := s.st.Ops[op.ID]; rec != nil {
		r = tx.ApplyOp(op) // replay
	} else {
		in := domain.CaptureInput{Title: req.Title, Letter: req.Priority, Day: req.Day, Deadline: req.Deadline,
			Source: "capture:" + req.TokenName, By: domain.ByCapture}
		r = tx.Capture(in)
		r.OpID = op.ID
		r.ServerPlannerDay = tx.Day()
		tx.RecordOp(op, r)
	}
	if err := s.commit(tx); err != nil {
		return CaptureResponse{}, err
	}
	if r.Status != domain.Applied {
		return CaptureResponse{}, errors.New(r.Reason)
	}
	t := s.st.Tasks[r.TaskID]
	landed := "Task Dump"
	if req.Day != "" {
		landed = req.Day
		if req.Priority != "" {
			landed = req.Priority + " on " + req.Day
		}
	} else if req.Priority != "" {
		landed = "Task Dump, priority " + req.Priority
	}
	return CaptureResponse{TaskID: t.ID, Title: t.Title, Landed: landed, Replayed: r.Replayed}, nil
}

// History returns a task's events.
func (s *Service) History(taskID string) ([]domain.Event, error) { return s.db.History(taskID, 0) }

// Export is the full portable JSON export: everything needed to rebuild HOHE's data.
type Export struct {
	Format     string                    `json:"format"`
	ExportedAt string                    `json:"exportedAt"`
	View       domain.View               `json:"state"`
	History    map[string][]domain.Event `json:"history"`
}

// Export returns the full export.
func (s *Service) Export() (Export, error) {
	v, err := s.View()
	if err != nil {
		return Export{}, err
	}
	out := Export{Format: "hohe-export/1", ExportedAt: s.Now().UTC().Format(time.RFC3339), View: v, History: map[string][]domain.Event{}}
	for _, t := range v.Tasks {
		ev, err := s.db.History(t.ID, 0)
		if err != nil {
			return Export{}, err
		}
		out.History[t.ID] = ev
	}
	return out, nil
}

// Health is what /healthz reports.
type Health struct {
	OK               bool   `json:"ok"`
	ServerPlannerDay string `json:"serverPlannerDay"`
	LastRolled       string `json:"lastRolled"`
	RolloverCurrent  bool   `json:"rolloverCurrent"`
	OpenConflicts    int    `json:"openConflicts"`
}

// Health reports whether the rollover for the current planner day has run.
func (s *Service) Health() Health {
	s.mu.Lock()
	defer s.mu.Unlock()
	d := s.day(s.Now())
	n := 0
	for _, c := range s.st.Conflicts {
		if c.Status == "open" {
			n++
		}
	}
	return Health{OK: true, ServerPlannerDay: d, LastRolled: s.st.LastRolled, RolloverCurrent: s.st.LastRolled == d, OpenConflicts: n}
}

// Snapshot writes a verified consistent snapshot of the database.
func (s *Service) Snapshot(dest string) (store.SnapshotInfo, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.db.Snapshot(dest)
}
