package domain

import "sort"

// View is the whole client-facing state. Every list is non-nil, so it always encodes as
// [] or {} and never null (Phase 2 finding 1).
type View struct {
	ServerPlannerDay string         `json:"serverPlannerDay"`
	LastRolled       string         `json:"lastRolled"`
	Settings         Settings       `json:"settings"`
	Planning         Planning       `json:"planning"`
	Tasks            []*Task        `json:"tasks"`
	Placements       []*Placement   `json:"placements"`
	Conflicts        []*Conflict    `json:"conflicts"`
	GroupRevisions   map[string]int `json:"groupRevisions"` // "YYYY-MM-DD/A"
	Suggestion       *Suggestion    `json:"suggestion"`     // for planning today
	Card             *Suggestion    `json:"card"`           // the unsolicited card, if allowed now
	Counts           map[string]int `json:"counts"`
}

// View builds the client view. It changes nothing.
func (tx *Tx) View() View {
	v := View{ServerPlannerDay: tx.day, LastRolled: tx.lastRolled, Settings: tx.settingsView().clone(),
		Planning: tx.planningView().clone(), Tasks: []*Task{}, Placements: []*Placement{}, Conflicts: []*Conflict{},
		GroupRevisions: map[string]int{}, Counts: map[string]int{}}
	for _, id := range tx.allTaskIDs() {
		t := tx.task(id).clone()
		v.Tasks = append(v.Tasks, t)
		v.Counts[t.State]++
	}
	for id := range tx.s.Placements {
		v.Placements = append(v.Placements, tx.placement(id).clone())
	}
	for _, id := range tx.newPlacements {
		v.Placements = append(v.Placements, tx.placements[id].clone())
	}
	sort.Slice(v.Placements, func(i, j int) bool {
		if v.Placements[i].Day != v.Placements[j].Day {
			return v.Placements[i].Day < v.Placements[j].Day
		}
		return v.Placements[i].ID < v.Placements[j].ID
	})
	ids := append(tx.s.ConflictOrder(), tx.newConflicts...)
	for _, id := range ids {
		if c := tx.conflict(id); c != nil && c.Status == "open" {
			v.Conflicts = append(v.Conflicts, c.clone())
		}
	}
	for k, r := range tx.s.GroupRevs {
		v.GroupRevisions[k.Day+"/"+k.Letter] = r
	}
	for k, r := range tx.groupRevs {
		v.GroupRevisions[k.Day+"/"+k.Letter] = r
	}
	v.Suggestion = tx.Suggest(true)
	if tx.CardAllowed() {
		v.Card = tx.Suggest(false)
	}
	return v
}
