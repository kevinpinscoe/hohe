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
