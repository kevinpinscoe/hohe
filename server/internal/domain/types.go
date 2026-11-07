// Package domain is HOHE's authoritative planner model: tasks, daily placements, ranks,
// rollover with carry history, suggestions, operation-based sync with per-field revisions
// and a conflict tray, and soft delete with purge and tombstones.
//
// The model is held in memory and changed only through a Tx. A Tx records every entity it
// changes, so the store can write exactly those rows in one database transaction before the
// change becomes visible (Commit). Rules follow the HOHE proposal (§5–§7, §11.4, §6.5).
package domain

// Letter is a priority letter: "A", "B", "C", or "" for none.
type Letter = string

// Task states. Completed, deleted and purged are terminal unless an explicit reopen or
// restore is used; purged is permanent.
const (
	StateActive    = "active"
	StateWaiting   = "waiting"
	StateCompleted = "completed"
	StateDeleted   = "deleted"
	StatePurged    = "purged"
)

// Placement outcomes. "" means the placement is open.
const (
	OutcomeOpen      = ""
	OutcomeCompleted = "completed"
	OutcomeForwarded = "forwarded"
	OutcomeCarried   = "carried"
	OutcomeDelegated = "delegated"
	OutcomeReturned  = "returned"
	OutcomeDeleted   = "deleted"
)

// Who created a placement.
const (
	ByKevin    = "kevin"
	ByRollover = "rollover"
	ByCapture  = "capture"
	ByImport   = "import"
)

// Task is one task. It keeps one identity for life; each day it appears on is a Placement.
type Task struct {
	ID           string         `json:"id"`
	Title        string         `json:"title"`
	Notes        string         `json:"notes"`
	Priority     Letter         `json:"priority"`
	Deadline     string         `json:"deadline"`
	Effort       string         `json:"effort"` // "", "S", "M", "L"
	Tags         []string       `json:"tags"`
	State        string         `json:"state"`
	Delegate     string         `json:"delegate"`
	FollowUp     string         `json:"followUp"`
	CreatedDay   string         `json:"createdDay"`
	CreatedAt    string         `json:"createdAt"`
	CompletedDay string         `json:"completedDay"`
	DeletedDay   string         `json:"deletedDay"`
	DeletedAt    string         `json:"deletedAt"`
	PurgedAt     string         `json:"purgedAt"`
	Source       string         `json:"source"`
	Revisions    map[string]int `json:"revisions"` // per editable field
	Rev          int            `json:"rev"`       // any change to the task
}

func (t *Task) clone() *Task {
	c := *t
	c.Tags = append([]string{}, t.Tags...)
	c.Revisions = make(map[string]int, len(t.Revisions))
	for k, v := range t.Revisions {
		c.Revisions[k] = v
	}
	return &c
}

// Terminal reports whether no ordinary operation may change the task's lifecycle.
func (t *Task) Terminal() bool {
	return t.State == StateCompleted || t.State == StateDeleted || t.State == StatePurged
}

// Placement is one appearance of a task on one planner day. Closed placements are never
// moved or rewritten, except by an explicit, recorded correction.
type Placement struct {
	ID         string `json:"id"`
	TaskID     string `json:"taskId"`
	Day        string `json:"day"`
	Letter     Letter `json:"letter"`
	Rank       int    `json:"rank"` // 0 = unnumbered
	Outcome    string `json:"outcome"`
	Target     string `json:"target"` // where it was carried, forwarded or delegated to
	By         string `json:"by"`
	CatchUp    bool   `json:"catchUp"` // created by a catch-up rollover
	Touched    bool   `json:"touched"` // Kevin acted on it (ends a carry span)
	InProgress bool   `json:"inProgress"`
	CreatedAt  string `json:"createdAt"`
	ClosedAt   string `json:"closedAt"`
	Rev        int    `json:"rev"`
}

func (p *Placement) clone() *Placement { c := *p; return &c }

// Open reports whether the placement is still open.
func (p *Placement) Open() bool { return p.Outcome == OutcomeOpen }

// Event is one append-only history entry.
type Event struct {
	Seq         int64          `json:"seq"`
	At          string         `json:"at"`
	Day         string         `json:"day"`
	Kind        string         `json:"kind"`
	TaskID      string         `json:"taskId"`
	PlacementID string         `json:"placementId"`
	OpID        string         `json:"opId"`
	Data        map[string]any `json:"data"`
}

// Settings are Kevin's editable settings. Each has its own revision.
type Settings struct {
	TimeZone            string         `json:"timeZone"`
	Rollover            string         `json:"rollover"`
	AWarning            int            `json:"aWarning"`
	MinAgeDays          int            `json:"minAgeDays"`
	DeadlineWindowDays  int            `json:"deadlineWindowDays"`
	SnoozeDays          int            `json:"snoozeDays"`
	CardEarliest        string         `json:"cardEarliest"`
	DeleteRetentionDays int            `json:"deleteRetentionDays"`
	WeekStart           string         `json:"weekStart"`
	Revisions           map[string]int `json:"revisions"`
}

// DefaultSettings are the defaults Kevin decided on 2026-11-07 (proposal §16).
func DefaultSettings() Settings {
	return Settings{
		TimeZone: "America/New_York", Rollover: "03:00", AWarning: 4, MinAgeDays: 14,
		DeadlineWindowDays: 7, SnoozeDays: 7, CardEarliest: "07:00", DeleteRetentionDays: 30,
		WeekStart: "monday", Revisions: map[string]int{},
	}
}

func (s Settings) clone() Settings {
	c := s
	c.Revisions = make(map[string]int, len(s.Revisions))
	for k, v := range s.Revisions {
		c.Revisions[k] = v
	}
	return c
}

// Planning is the suggestion and day-designation state.
type Planning struct {
	Designations     map[string]string `json:"designations"` // day -> room|full|rest
	Snoozes          map[string]string `json:"snoozes"`      // taskId -> snoozed until (day)
	PausedUntil      string            `json:"pausedUntil"`
	CardDismissedDay string            `json:"cardDismissedDay"`
	PlannedDays      []string          `json:"plannedDays"` // Plan My Day done or skipped
}

func (p Planning) clone() Planning {
	c := p
	c.Designations = make(map[string]string, len(p.Designations))
	for k, v := range p.Designations {
		c.Designations[k] = v
	}
	c.Snoozes = make(map[string]string, len(p.Snoozes))
	for k, v := range p.Snoozes {
		c.Snoozes[k] = v
	}
	c.PlannedDays = append([]string{}, p.PlannedDays...)
	return c
}

func newPlanning() Planning {
	return Planning{Designations: map[string]string{}, Snoozes: map[string]string{}, PlannedDays: []string{}}
}

// Rollover ledger entry: a planner day whose rollover has been processed.
type LedgerEntry struct {
	Day     string `json:"day"`
	RunAt   string `json:"runAt"`
	CatchUp bool   `json:"catchUp"`
}

// Conflict tray entry kinds.
const (
	KindField      = "field"      // a stale same-field edit
	KindLifecycle  = "lifecycle"  // an operation against a completed task
	KindDeleted    = "deleted"    // an operation against a deleted task
	KindPurged     = "purged"     // an operation against a purged task (Discard only)
	KindPlacement  = "placement"  // the placement it was based on was changed by another device
	KindReorder    = "reorder"    // a reorder that could not be rebased safely
	KindSuperseded = "superseded" // informational: a forward superseded by a completion
	KindSetting    = "setting"    // a stale same-setting edit
)

// Conflict resolutions.
const (
	ResolveKeepServer      = "keep-server"
	ResolveUseMine         = "use-mine"
	ResolveDiscard         = "discard"
	ResolveRestoreAndApply = "restore-and-apply"
	ResolveReopenAndApply  = "reopen-and-apply"
	ResolveApplyAnyway     = "apply-anyway"
	ResolveDismiss         = "dismiss"
)

// Conflict is one entry in the conflict tray. Nothing in the tray is discarded silently.
type Conflict struct {
	ID             string   `json:"id"`
	Kind           string   `json:"kind"`
	OpID           string   `json:"opId"`
	DeviceID       string   `json:"deviceId"`
	TaskID         string   `json:"taskId"`
	Field          string   `json:"field"`
	ServerValue    any      `json:"serverValue"`
	ServerRevision int      `json:"serverRevision"`
	ProposedValue  any      `json:"proposedValue"`
	BaseRevision   int      `json:"baseRevision"`
	Message        string   `json:"message"`
	Actions        []string `json:"actions"`
	Op             Op       `json:"op"`
	HeldOps        []Op     `json:"heldOps"`
	Status         string   `json:"status"` // open, or resolved:<action>
	CreatedAt      string   `json:"createdAt"`
	ResolvedAt     string   `json:"resolvedAt"`
}

func (c *Conflict) clone() *Conflict {
	d := *c
	d.Actions = append([]string{}, c.Actions...)
	d.HeldOps = append([]Op{}, c.HeldOps...)
	return &d
}

// Op is one client operation. Every op carries a client-generated unique id, so replay is
// duplicate-safe. Fields are used according to Type.
type Op struct {
	ID       string `json:"id"`
	DeviceID string `json:"deviceId"`
	Type     string `json:"type"`

	TaskID      string `json:"taskId,omitempty"`
	PlacementID string `json:"placementId,omitempty"`
	// BasePlacementID is the open placement the client saw when it made a lifecycle op.
	BasePlacementID string `json:"basePlacementId,omitempty"`

	Title    string   `json:"title,omitempty"`
	Field    string   `json:"field,omitempty"`
	Value    any      `json:"value,omitempty"`
	Letter   *string  `json:"letter,omitempty"`
	Rank     int      `json:"rank,omitempty"`
	Day      string   `json:"day,omitempty"`
	Deadline *string  `json:"deadline,omitempty"`
	Effort   *string  `json:"effort,omitempty"`
	Who      string   `json:"who,omitempty"`
	Order    []string `json:"order,omitempty"`
	Outcome  string   `json:"outcome,omitempty"`
	Bool     *bool    `json:"bool,omitempty"`

	BaseRevision *int   `json:"baseRevision,omitempty"`
	DependsOn    string `json:"dependsOn,omitempty"`
	Resolves     string `json:"resolves,omitempty"`

	ClientPlannerDay string `json:"clientPlannerDay,omitempty"`
	ClientTime       string `json:"clientTime,omitempty"`
}

// Result statuses.
const (
	Applied  = "applied"
	Noop     = "noop"
	InTray   = "conflict"
	Held     = "held"
	Rejected = "rejected"
)

// Result is the outcome of one operation. A replayed op returns its original result with
// Replayed set.
type Result struct {
	OpID               string `json:"opId"`
	Status             string `json:"status"`
	Replayed           bool   `json:"replayed"`
	TaskID             string `json:"taskId,omitempty"`
	PlacementID        string `json:"placementId,omitempty"`
	Revision           int    `json:"revision,omitempty"`
	ConflictID         string `json:"conflictId,omitempty"`
	Reason             string `json:"reason,omitempty"`
	Notice             string `json:"notice,omitempty"`
	ServerPlannerDay   string `json:"serverPlannerDay,omitempty"`
	PlannerDayMismatch bool   `json:"plannerDayMismatch,omitempty"`
}

// OpRecord is a processed operation, kept permanently (with the tombstones) so a replay of
// any op id, however old, returns its original result.
type OpRecord struct {
	OpID       string `json:"opId"`
	DeviceID   string `json:"deviceId"`
	ReceivedAt string `json:"receivedAt"`
	Result     Result `json:"result"`
}

// GroupKey identifies one letter group on one day.
type GroupKey struct{ Day, Letter string }
