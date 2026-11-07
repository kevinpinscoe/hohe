package plannerday

import (
	"testing"
	"time"
)

func TestDay(t *testing.T) {
	ny, err := time.LoadLocation("America/New_York")
	if err != nil {
		t.Fatal(err)
	}
	r, _ := ParseRollover("03:00")
	cases := []struct {
		name, utc, want string
	}{
		{"afternoon", "2026-11-06T20:00:00Z", "2026-11-06"},
		{"just before rollover (02:59 EST)", "2026-11-07T07:59:00Z", "2026-11-06"},
		{"at rollover (03:00 EST)", "2026-11-07T08:00:00Z", "2026-11-07"},
		{"UTC already next day, NY evening", "2026-11-07T03:30:00Z", "2026-11-06"},
		// 2026-11-01: clocks fall back 02:00 EDT -> 01:00 EST. 01:30 occurs twice.
		{"fall-back first 01:30 (EDT)", "2026-11-01T05:30:00Z", "2026-10-31"},
		{"fall-back second 01:30 (EST)", "2026-11-01T06:30:00Z", "2026-10-31"},
		{"fall-back 03:00 EST", "2026-11-01T08:00:00Z", "2026-11-01"},
		// 2027-03-14: clocks spring forward 02:00 EST -> 03:00 EDT; 02:xx never exists.
		{"spring-forward 01:59 EST", "2027-03-14T06:59:00Z", "2027-03-13"},
		{"spring-forward 03:00 EDT", "2027-03-14T07:00:00Z", "2027-03-14"},
	}
	for _, c := range cases {
		at, err := time.Parse(time.RFC3339, c.utc)
		if err != nil {
			t.Fatal(err)
		}
		if got := Day(at, ny, r); got != c.want {
			t.Errorf("%s: Day(%s) = %s, want %s", c.name, c.utc, got, c.want)
		}
	}
}

func TestParseRollover(t *testing.T) {
	if _, err := ParseRollover("25:00"); err == nil {
		t.Error("25:00 accepted")
	}
	r, err := ParseRollover("03:00")
	if err != nil || r.String() != "03:00" {
		t.Errorf("round trip: %v %v", r, err)
	}
}

func TestDayArithmetic(t *testing.T) {
	if got := AddDays("2026-11-01", 1); got != "2026-11-02" {
		t.Errorf("AddDays across fall-back = %s", got)
	}
	if got := AddDays("2027-03-13", 2); got != "2027-03-15" {
		t.Errorf("AddDays across spring-forward = %s", got)
	}
	if got := Between("2026-10-31", "2026-11-02"); got != 2 {
		t.Errorf("Between = %d", got)
	}
	if got := Between("2026-11-02", "2026-10-31"); got != -2 {
		t.Errorf("Between negative = %d", got)
	}
	for _, bad := range []string{"", "2026-1-1", "2026-13-01", "2026-02-30", "x"} {
		if Valid(bad) {
			t.Errorf("Valid(%q) = true", bad)
		}
	}
}

func TestStart(t *testing.T) {
	ny, _ := time.LoadLocation("America/New_York")
	r, _ := ParseRollover("03:00")
	s, err := Start("2026-11-01", ny, r)
	if err != nil {
		t.Fatal(err)
	}
	if s.UTC().Format(time.RFC3339) != "2026-11-01T08:00:00Z" {
		t.Errorf("Start fall-back day = %s", s.UTC())
	}
	if Day(s, ny, r) != "2026-11-01" || Day(s.Add(-time.Minute), ny, r) != "2026-10-31" {
		t.Error("Start is not the day boundary")
	}
}
