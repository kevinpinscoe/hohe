package domain

import (
	"fmt"
	"sort"

	"github.com/kevinpinscoe/hohe/server/internal/plannerday"
)

var effortPoints = map[string]int{"": 1, "S": 1, "M": 2, "L": 3}

// Suggestion proposes planning one C task onto one day. "Plan it" keeps the task C.
type Suggestion struct {
	TaskID string `json:"taskId"`
	Title  string `json:"title"`
	Day    string `json:"day"`
	Reason string `json:"reason"`
}

// DayLoad is the effort of a day's open entries (S=1, M=2, L=3; unset counts as S).
func (tx *Tx) DayLoad(day string) int {
	n := 0
	for _, p := range tx.placementsOnDay(day) {
		if p.Open() {
			if t := tx.task(p.TaskID); t != nil {
				n += effortPoints[t.Effort]
			}
		}
	}
	return n
}

// Suggest returns at most one suggestion, or nil. It changes nothing.
//
//   - Candidates are active C tasks with no open entry, not snoozed, at least the minimum
//     age old, unless a deadline falls within the deadline window.
//   - Order: nearest deadline, then oldest.
//   - Target days: today only while Kevin is planning it (and it is not full or rest), and
//     the next seven days he marked "room available". Unmarked days are never assumed free.
//   - Among those, the least loaded day on or before the deadline.
func (tx *Tx) Suggest(planningToday bool) *Suggestion {
	set := tx.settingsView()
	pl := tx.planningView()
	if pl.PausedUntil != "" && pl.PausedUntil > tx.day {
		return nil
	}
	type cand struct {
		t        *Task
		deadline int
		age      int
	}
	var cands []cand
	for _, id := range tx.allTaskIDs() {
		t := tx.task(id)
		if t.State != StateActive || t.Priority != "C" || tx.openPlacement(t.ID) != nil {
			continue
		}
		if until, ok := pl.Snoozes[t.ID]; ok && until > tx.day {
			continue
		}
		age := plannerday.Between(t.CreatedDay, tx.day)
		dl := 1 << 30
		if t.Deadline != "" {
			dl = plannerday.Between(tx.day, t.Deadline)
		}
		soon := t.Deadline != "" && dl <= set.DeadlineWindowDays
		if !soon && age < set.MinAgeDays {
			continue
		}
		cands = append(cands, cand{t, dl, age})
	}
	if len(cands) == 0 {
		return nil
	}
	sort.SliceStable(cands, func(i, j int) bool {
		if cands[i].deadline != cands[j].deadline {
			return cands[i].deadline < cands[j].deadline
		}
		if cands[i].age != cands[j].age {
			return cands[i].age > cands[j].age
		}
		return cands[i].t.ID < cands[j].t.ID
	})
	var days []string
	if planningToday {
		if d := pl.Designations[tx.day]; d != "full" && d != "rest" {
			days = append(days, tx.day)
		}
	}
	for i := 1; i <= 7; i++ {
		d := plannerday.AddDays(tx.day, i)
		if pl.Designations[d] == "room" {
			days = append(days, d)
		}
	}
	if len(days) == 0 {
		return nil
	}
	c := cands[0]
	usable := days
	if c.t.Deadline != "" {
		var u []string
		for _, d := range days {
			if d <= c.t.Deadline {
				u = append(u, d)
			}
		}
		if len(u) > 0 {
			usable = u
		}
	}
	sort.SliceStable(usable, func(i, j int) bool {
		li, lj := tx.DayLoad(usable[i]), tx.DayLoad(usable[j])
		if li != lj {
			return li < lj
		}
		return usable[i] < usable[j]
	})
	reason := fmt.Sprintf("waiting %d days", c.age)
	if c.t.Deadline != "" && c.deadline <= set.DeadlineWindowDays {
		reason = fmt.Sprintf("due in %d days", c.deadline)
	}
	return &Suggestion{TaskID: c.t.ID, Title: c.t.Title, Day: usable[0], Reason: reason}
}

// CardAllowed reports whether the one unsolicited card may show now: not before the
// configured earliest time, and not after it was dismissed (or acted on) today.
func (tx *Tx) CardAllowed() bool {
	set := tx.settingsView()
	pl := tx.planningView()
	if pl.CardDismissedDay == tx.day {
		return false
	}
	loc, _, err := set.Location()
	if err != nil {
		return false
	}
	earliest, err := plannerday.ParseRollover(set.CardEarliest)
	if err != nil {
		return false
	}
	// The planner day runs past midnight until the rollover; a time after midnight but
	// before rollover is later in that planner day than any evening time.
	r, _ := plannerday.ParseRollover(set.Rollover)
	m := plannerday.MinutesOfDay(tx.now, loc)
	if m < int(r) {
		m += 24 * 60
	}
	return m >= int(earliest)
}
