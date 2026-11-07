// Package plannerday computes the HOHE planner day: the calendar date in an explicit
// time zone, shifted back one day before the configured rollover time. The device's
// default time zone is never consulted.
//
// A planner day is written YYYY-MM-DD. Arithmetic on days is calendar arithmetic on the
// date alone, so a DST transition can never skip or repeat a day.
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
		y, m, d := local.Date()
		local = time.Date(y, m, d-1, 12, 0, 0, 0, loc)
	}
	return local.Format("2006-01-02")
}

// Start returns the instant planner day d begins: its rollover time in loc. On a DST
// night where that wall time does not exist, Go normalizes it forward, which is the
// first instant the day can begin.
func Start(d string, loc *time.Location, r Rollover) (time.Time, error) {
	t, err := time.ParseInLocation("2006-01-02", d, loc)
	if err != nil {
		return time.Time{}, err
	}
	y, m, dd := t.Date()
	return time.Date(y, m, dd, int(r)/60, int(r)%60, 0, 0, loc), nil
}

// Valid reports whether s is a well-formed YYYY-MM-DD date.
func Valid(s string) bool {
	if len(s) != 10 {
		return false
	}
	_, err := time.Parse("2006-01-02", s)
	return err == nil
}

func parse(d string) time.Time {
	t, err := time.Parse("2006-01-02", d)
	if err != nil {
		panic(fmt.Sprintf("plannerday: invalid day %q", d))
	}
	return t
}

// AddDays returns day d moved by n calendar days.
func AddDays(d string, n int) string {
	return parse(d).AddDate(0, 0, n).Format("2006-01-02")
}

// Between returns the number of calendar days from a to b (negative if b is earlier).
func Between(a, b string) int {
	return int(parse(b).Sub(parse(a)).Hours() / 24)
}

// MinutesOfDay returns t's local wall-clock time in loc, in minutes after midnight.
func MinutesOfDay(t time.Time, loc *time.Location) int {
	l := t.In(loc)
	return l.Hour()*60 + l.Minute()
}
