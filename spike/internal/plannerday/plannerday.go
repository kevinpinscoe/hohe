// Package plannerday computes the HOHE planner day: the calendar date in an explicit
// time zone, shifted back one day before the configured rollover time. The device's
// default time zone is never consulted.
package plannerday

import (
	"fmt"
	"time"
)

// Rollover is a time of day, in minutes after local midnight.
type Rollover int

// ParseRollover parses "HH:MM" (24-hour).
func ParseRollover(s string) (Rollover, error) {
	t, err := time.Parse("15:04", s)
	if err != nil {
		return 0, fmt.Errorf("rollover %q: want HH:MM: %w", s, err)
	}
	return Rollover(t.Hour()*60 + t.Minute()), nil
}

// String renders the rollover as "HH:MM".
func (r Rollover) String() string { return fmt.Sprintf("%02d:%02d", int(r)/60, int(r)%60) }

// Day returns the planner day (YYYY-MM-DD) for instant t in loc.
func Day(t time.Time, loc *time.Location, r Rollover) string {
	local := t.In(loc)
	if local.Hour()*60+local.Minute() < int(r) {
		// Calendar arithmetic on the date only, so a DST transition cannot skip or repeat a day.
		y, m, d := local.Date()
		local = time.Date(y, m, d-1, 12, 0, 0, 0, loc)
	}
	return local.Format("2006-01-02")
}
