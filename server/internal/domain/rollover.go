package domain

import (
	"time"

	"github.com/kevinpinscoe/hohe/server/internal/plannerday"
)

// CatchUpAfter is how late a rollover may run and still count as live. Anything later is
// marked as catch-up.
const CatchUpAfter = time.Hour

// Location returns the settings' time zone and rollover time.
func (s *Settings) Location() (*time.Location, plannerday.Rollover, error) {
	loc, err := time.LoadLocation(s.TimeZone)
	if err != nil {
		return nil, 0, err
	}
	r, err := plannerday.ParseRollover(s.Rollover)
	if err != nil {
		return nil, 0, err
	}
	return loc, r, nil
}

// Rollover processes every planner day after the last one processed, up to and including
// tx.Day(), in order. Each day closes the open entries of earlier days as carried and
// opens their successor, brings delegated tasks back on their follow-up day, and purges
// tasks past their retention. The ledger makes it idempotent: running it again, or for a
// day already processed, changes nothing. It returns the days processed.
func (tx *Tx) Rollover() []string {
	target := tx.day
	if tx.lastRolled == "" {
		tx.ledgerAdd(target, false) // first start: nothing to carry yet
		return []string{target}
	}
	if target <= tx.lastRolled {
		return nil
	}
	loc, r, err := tx.settingsView().Location()
	var done []string
	for d := plannerday.AddDays(tx.lastRolled, 1); d <= target; d = plannerday.AddDays(d, 1) {
		catchUp := true
		if err == nil {
			if start, e := plannerday.Start(d, loc, r); e == nil && tx.now.Sub(start) <= CatchUpAfter {
				catchUp = false
			}
		}
		tx.rollTo(d, catchUp)
		tx.ledgerAdd(d, catchUp)
		done = append(done, d)
	}
	return done
}

func (tx *Tx) ledgerAdd(day string, catchUp bool) {
	tx.ledger = append(tx.ledger, LedgerEntry{Day: day, RunAt: tx.stamp(), CatchUp: catchUp})
	tx.lastRolled = day
}

func (tx *Tx) rollTo(d string, catchUp bool) {
	prevOp := tx.curOp
	tx.curOp = "rollover:" + d
	defer func() { tx.curOp = prevOp }()
	for _, p := range tx.openPlacementsBefore(d) {
		t := tx.task(p.TaskID)
		if t == nil || t.State != StateActive {
			continue
		}
		m := tx.mutPlacement(p.ID)
		m.Outcome, m.Target, m.InProgress, m.ClosedAt = OutcomeCarried, d, false, tx.stamp()
		m.Rev++
		tx.bumpGroup(m.Day, m.Letter)
		np := tx.addPlacement(Placement{TaskID: p.TaskID, Day: d, Letter: p.Letter, By: ByRollover, CatchUp: catchUp})
		tx.bumpGroup(d, p.Letter)
		tx.event("carried", p.TaskID, np.ID, map[string]any{"from": p.Day, "to": d, "fromPlacement": p.ID, "catchUp": catchUp})
	}
	for _, id := range tx.allTaskIDs() {
		t := tx.task(id)
		if t.State == StateWaiting && t.FollowUp != "" && t.FollowUp <= d {
			m := tx.touchTask(t)
			m.State = StateActive
			np := tx.addPlacement(Placement{TaskID: t.ID, Day: d, Letter: t.Priority, By: ByRollover, CatchUp: catchUp})
			tx.bumpGroup(d, t.Priority)
			tx.event("followUp", t.ID, np.ID, map[string]any{"day": d, "delegate": t.Delegate, "catchUp": catchUp})
		}
	}
	tx.purgeDue(d)
	if pl := tx.planningView(); pl.CardDismissedDay != "" && pl.CardDismissedDay < d {
		tx.mutPlanning().CardDismissedDay = ""
	}
}

// PurgedFields are removed from a task, and redacted from its history, when it is purged.
var PurgedFields = []string{"notes", "tags", "delegate", "effort", "source"}

// purgeDue purges deleted tasks whose retention has run out by planner day d (§6.5). A
// task deleted less than a day ago is never purged, even after the retention is shortened.
func (tx *Tx) purgeDue(d string) {
	ret := tx.settingsView().DeleteRetentionDays
	for _, id := range tx.allTaskIDs() {
		t := tx.task(id)
		if t.State != StateDeleted || t.DeletedDay == "" {
			continue
		}
		if plannerday.Between(t.DeletedDay, d) < ret {
			continue
		}
		if at, err := time.Parse(time.RFC3339Nano, t.DeletedAt); err == nil && tx.now.Sub(at) < 24*time.Hour {
			continue
		}
		tx.purge(t)
	}
}

// purge turns a deleted task into a permanent tombstone. Its id, title, priority letter and
// deletion times stay; its placements, rank reservations and history stay, the history with
// the purged fields' values redacted. It can never be restored or recreated.
func (tx *Tx) purge(t *Task) {
	m := tx.touchTask(t)
	m.State = StatePurged
	m.PurgedAt = tx.stamp()
	m.Notes, m.Tags, m.Delegate, m.Effort, m.Source = "", []string{}, "", "", ""
	tx.redactions = append(tx.redactions, Redaction{TaskID: t.ID, Fields: PurgedFields})
	if _, ok := tx.planningView().Snoozes[t.ID]; ok {
		delete(tx.mutPlanning().Snoozes, t.ID)
	}
	tx.event("purged", t.ID, "", map[string]any{"deletedDay": t.DeletedDay})
}
