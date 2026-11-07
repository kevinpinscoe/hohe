package domain

import (
	"fmt"
	"sort"
	"strconv"
	"time"

	"github.com/kevinpinscoe/hohe/server/internal/plannerday"
)

// reservedRanks are the numbers held by closed entries in one day+letter group. They stay
// reserved for that day, so numbers are never duplicated (§5.3).
func (tx *Tx) reservedRanks(day, letter string) map[int]bool {
	out := map[int]bool{}
	for _, p := range tx.placementsOnDay(day) {
		if p.Letter == letter && !p.Open() && p.Rank > 0 {
			out[p.Rank] = true
		}
	}
	return out
}

func (tx *Tx) openInGroup(day, letter string) []*Placement {
	var out []*Placement
	for _, p := range tx.placementsOnDay(day) {
		if p.Letter == letter && p.Open() {
			out = append(out, p)
		}
	}
	sortGroup(out)
	return out
}

// sortGroup orders a group: numbered by rank, then unnumbered, then by id.
func sortGroup(ps []*Placement) {
	sort.SliceStable(ps, func(i, j int) bool {
		ri, rj := ps[i].Rank, ps[j].Rank
		if ri == 0 {
			ri = 1 << 30
		}
		if rj == 0 {
			rj = 1 << 30
		}
		if ri != rj {
			return ri < rj
		}
		return ps[i].ID < ps[j].ID
	})
}

// setRank applies a typed number. A reserved number is refused (the message is returned);
// a number held by an open entry moves that entry, and every open entry ranked after it,
// to the next numbers that are not reserved.
func (tx *Tx) setRank(pl *Placement, rank int) string {
	if pl.Letter == "" {
		return "Give the task a letter first."
	}
	if rank < 1 || rank > 999 {
		return "Numbers run from 1 to 999."
	}
	reserved := tx.reservedRanks(pl.Day, pl.Letter)
	if reserved[rank] {
		return fmt.Sprintf("%s%d is already used that day by a closed entry. Numbers stay unique for the day.", pl.Letter, rank)
	}
	var others []*Placement
	for _, p := range tx.openInGroup(pl.Day, pl.Letter) {
		if p.ID != pl.ID && p.Rank > 0 {
			others = append(others, p)
		}
	}
	m := tx.mutPlacement(pl.ID)
	m.Rank, m.Touched = rank, true
	m.Rev++
	holder := false
	for _, p := range others {
		if p.Rank == rank {
			holder = true
		}
	}
	if holder {
		taken := map[int]bool{rank: true}
		for r := range reserved {
			taken[r] = true
		}
		var shift []*Placement
		for _, p := range others {
			if p.Rank < rank {
				taken[p.Rank] = true
			} else {
				shift = append(shift, p)
			}
		}
		n := rank
		for _, p := range shift { // already sorted by rank
			for n++; taken[n]; n++ {
			}
			taken[n] = true
			sp := tx.mutPlacement(p.ID)
			sp.Rank = n
			sp.Rev++
		}
	}
	tx.bumpGroup(pl.Day, pl.Letter)
	tx.event("ranked", pl.TaskID, pl.ID, map[string]any{"day": pl.Day, "letter": pl.Letter, "rank": rank})
	return ""
}

func (tx *Tx) opSetRank(op Op) Result {
	pl := tx.placement(op.PlacementID)
	if pl == nil {
		return reject("unknown placement %s", op.PlacementID)
	}
	t := tx.task(pl.TaskID)
	if r, done := tx.terminalCheck(op, t); done {
		return r
	}
	if !pl.Open() {
		open := tx.openPlacement(t.ID)
		if open == nil || !tx.carriedOnlyByRollover(pl, open) {
			return tx.toTray(op, t, KindPlacement,
				fmt.Sprintf("This entry for %s was changed on another device (%s).", pl.Day, describeOutcome(pl)),
				[]string{ResolveDiscard})
		}
		// A rank is for one day; a carried-in entry arrives unnumbered, so the old number no
		// longer applies. Nothing to do.
		return Result{Status: Noop, TaskID: t.ID, PlacementID: open.ID, Reason: "the entry was carried to a new day"}
	}
	if msg := tx.setRank(pl, op.Rank); msg != "" {
		return Result{Status: Rejected, TaskID: t.ID, PlacementID: pl.ID, Reason: msg}
	}
	return Result{Status: Applied, TaskID: t.ID, PlacementID: pl.ID, Revision: tx.groupRev(GroupKey{pl.Day, pl.Letter})}
}

// opReorder renumbers a group's open entries in the given order, using the lowest numbers
// that are not reserved. A stale reorder is rebased: its relative order is kept for the
// entries present in both, and entries it did not know are appended in their current order
// (§11.4), with a notice.
func (tx *Tx) opReorder(op Op) Result {
	if !plannerday.Valid(op.Day) {
		return reject("day must be YYYY-MM-DD")
	}
	letter := ""
	if op.Letter != nil {
		letter = *op.Letter
	}
	if letter == "" || !validLetter(letter) {
		return reject("reorder needs a letter group")
	}
	if len(op.Order) > MaxBatch {
		return reject("too many entries")
	}
	k := GroupKey{op.Day, letter}
	cur := tx.groupRev(k)
	open := tx.openInGroup(op.Day, letter)
	inGroup := map[string]*Placement{}
	for _, p := range open {
		inGroup[p.ID] = p
	}
	var order []string
	seen := map[string]bool{}
	for _, id := range op.Order {
		if _, ok := inGroup[id]; ok && !seen[id] {
			order = append(order, id)
			seen[id] = true
		}
	}
	stale := op.BaseRevision != nil && *op.BaseRevision != cur
	if !stale && len(order) != len(op.Order) {
		return reject("the order lists entries that are not open in %s %s", op.Day, letter)
	}
	if len(order) == 0 {
		return Result{Status: Noop, Reason: "none of the entries are still open in this group"}
	}
	for _, p := range open {
		if !seen[p.ID] {
			order = append(order, p.ID)
		}
	}
	reserved := tx.reservedRanks(op.Day, letter)
	n := 0
	for _, id := range order {
		for n++; reserved[n]; n++ {
		}
		if p := tx.placement(id); p.Rank != n || !p.Touched {
			m := tx.mutPlacement(id)
			m.Rank, m.Touched = n, true
			m.Rev++
		}
	}
	tx.bumpGroup(op.Day, letter)
	tx.event("reordered", "", "", map[string]any{"day": op.Day, "letter": letter, "order": order, "rebased": stale})
	r := Result{Status: Applied, Revision: tx.groupRev(k)}
	if stale {
		r.Notice = "Reordered from another device: your order was kept for the entries in both, and new entries were added after them."
	}
	return r
}

// ── planning state ─────────────────────────────────────────────────────────

func (tx *Tx) opPlanning(op Op) Result {
	pl := tx.mutPlanning()
	set := tx.settingsView()
	switch op.Type {
	case OpSnooze:
		t := tx.task(op.TaskID)
		if t == nil {
			return reject("unknown task %s", op.TaskID)
		}
		until := op.Day
		if until == "" {
			until = plannerday.AddDays(tx.day, set.SnoozeDays)
		}
		if !plannerday.Valid(until) || until <= tx.day {
			return reject("snooze needs a future day")
		}
		pl.Snoozes[t.ID] = until
		tx.event("snoozed", t.ID, "", map[string]any{"until": until})
	case OpPause:
		until := op.Day
		if until == "" {
			until = plannerday.AddDays(tx.day, set.SnoozeDays)
		}
		if !plannerday.Valid(until) || until <= tx.day {
			return reject("pause needs a future day")
		}
		pl.PausedUntil = until
		tx.event("suggestionsPaused", "", "", map[string]any{"until": until})
	case OpResume:
		pl.PausedUntil = ""
		tx.event("suggestionsResumed", "", "", nil)
	case OpDismissCard:
		d := op.Day
		if d == "" {
			d = tx.day
		}
		pl.CardDismissedDay = d
	case OpDesignate:
		if !plannerday.Valid(op.Day) {
			return reject("day must be YYYY-MM-DD")
		}
		v, _ := op.Value.(string)
		switch v {
		case "":
			delete(pl.Designations, op.Day)
		case "room", "full", "rest":
			pl.Designations[op.Day] = v
		default:
			return reject("designation must be room, full, rest or empty")
		}
		tx.event("designated", "", "", map[string]any{"day": op.Day, "value": v})
	case OpMarkPlanned:
		d := op.Day
		if d == "" {
			d = tx.day
		}
		for _, x := range pl.PlannedDays {
			if x == d {
				return Result{Status: Noop}
			}
		}
		pl.PlannedDays = append(pl.PlannedDays, d)
		sort.Strings(pl.PlannedDays)
	}
	return Result{Status: Applied}
}

// ── settings ───────────────────────────────────────────────────────────────

func (tx *Tx) opSetting(op Op) Result {
	set := tx.settingsView()
	cur := set.Revisions[op.Field]
	val, err := normalizeSetting(op.Field, op.Value)
	if err != nil {
		return reject("%v", err)
	}
	old := settingValue(set, op.Field)
	if op.BaseRevision != nil && *op.BaseRevision != cur {
		if equalValue(old, val) {
			return Result{Status: Noop, Revision: cur}
		}
		c := tx.addConflict(Conflict{Kind: KindSetting, OpID: op.ID, DeviceID: op.DeviceID, Field: op.Field,
			ServerValue: old, ServerRevision: cur, ProposedValue: val, BaseRevision: *op.BaseRevision,
			Message: fmt.Sprintf("Setting %s was changed on another device.", op.Field),
			Actions: []string{ResolveKeepServer, ResolveUseMine}, Op: op})
		return Result{Status: InTray, ConflictID: c.ID, Revision: cur, Reason: c.Message}
	}
	m := tx.mutSettings()
	applySetting(m, op.Field, val)
	m.Revisions[op.Field] = cur + 1
	tx.event("setting", "", "", map[string]any{"field": op.Field, "from": old, "to": val})
	return Result{Status: Applied, Revision: cur + 1}
}

func normalizeSetting(field string, v any) (any, error) {
	num := func(lo, hi int) (any, error) {
		var n int
		switch x := v.(type) {
		case float64:
			n = int(x)
			if float64(n) != x {
				return nil, fmt.Errorf("%s must be a whole number", field)
			}
		case int:
			n = x
		case string:
			var err error
			if n, err = strconv.Atoi(x); err != nil {
				return nil, fmt.Errorf("%s must be a number", field)
			}
		default:
			return nil, fmt.Errorf("%s must be a number", field)
		}
		if n < lo || n > hi {
			return nil, fmt.Errorf("%s must be between %d and %d", field, lo, hi)
		}
		return n, nil
	}
	s, _ := v.(string)
	switch field {
	case "timeZone":
		if _, err := time.LoadLocation(s); err != nil || s == "" || s == "Local" {
			return nil, fmt.Errorf("unknown time zone %q", s)
		}
		return s, nil
	case "rollover", "cardEarliest":
		if _, err := plannerday.ParseRollover(s); err != nil {
			return nil, err
		}
		return s, nil
	case "weekStart":
		if s != "monday" && s != "sunday" {
			return nil, fmt.Errorf("weekStart must be monday or sunday")
		}
		return s, nil
	case "aWarning":
		return num(1, 50)
	case "minAgeDays":
		return num(0, 365)
	case "deadlineWindowDays":
		return num(0, 90)
	case "snoozeDays":
		return num(1, 365)
	case "deleteRetentionDays":
		return num(1, 3650)
	}
	return nil, fmt.Errorf("unknown setting %q", field)
}

func settingValue(s *Settings, field string) any {
	switch field {
	case "timeZone":
		return s.TimeZone
	case "rollover":
		return s.Rollover
	case "cardEarliest":
		return s.CardEarliest
	case "weekStart":
		return s.WeekStart
	case "aWarning":
		return s.AWarning
	case "minAgeDays":
		return s.MinAgeDays
	case "deadlineWindowDays":
		return s.DeadlineWindowDays
	case "snoozeDays":
		return s.SnoozeDays
	case "deleteRetentionDays":
		return s.DeleteRetentionDays
	}
	return nil
}

func applySetting(s *Settings, field string, v any) {
	switch field {
	case "timeZone":
		s.TimeZone = v.(string)
	case "rollover":
		s.Rollover = v.(string)
	case "cardEarliest":
		s.CardEarliest = v.(string)
	case "weekStart":
		s.WeekStart = v.(string)
	case "aWarning":
		s.AWarning = v.(int)
	case "minAgeDays":
		s.MinAgeDays = v.(int)
	case "deadlineWindowDays":
		s.DeadlineWindowDays = v.(int)
	case "snoozeDays":
		s.SnoozeDays = v.(int)
	case "deleteRetentionDays":
		s.DeleteRetentionDays = v.(int)
	}
}

// ── explicit corrections of closed history ────────────────────────────────

var correctable = map[string]bool{
	OutcomeCompleted: true, OutcomeForwarded: true, OutcomeCarried: true,
	OutcomeDelegated: true, OutcomeReturned: true, OutcomeDeleted: true,
}

// opCorrect changes a closed entry's recorded outcome. It is the only change ever made to
// closed history, it is always explicit, and it is recorded with the old and new values.
// It corrects the record of that day; the task's current state is unchanged.
func (tx *Tx) opCorrect(op Op) Result {
	pl := tx.placement(op.PlacementID)
	if pl == nil {
		return reject("unknown placement %s", op.PlacementID)
	}
	if pl.Open() {
		return reject("only a closed entry can be corrected; use the normal actions on an open one")
	}
	if !correctable[op.Outcome] {
		return reject("unknown outcome %q", op.Outcome)
	}
	if pl.Outcome == op.Outcome {
		return Result{Status: Noop, PlacementID: pl.ID}
	}
	if t := tx.task(pl.TaskID); t != nil && t.State == StatePurged {
		return tx.toTray(op, t, KindPurged, "This task was purged.", []string{ResolveDiscard})
	}
	m := tx.mutPlacement(pl.ID)
	old := m.Outcome
	m.Outcome = op.Outcome
	m.Rev++
	tx.event("corrected", pl.TaskID, pl.ID, map[string]any{"day": pl.Day, "from": old, "to": op.Outcome})
	return Result{Status: Applied, TaskID: pl.TaskID, PlacementID: pl.ID}
}
