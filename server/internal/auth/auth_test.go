package auth

import (
	"testing"
	"time"

	"golang.org/x/crypto/bcrypt"
)

func TestPasswordAndLimiter(t *testing.T) {
	h, _ := bcrypt.GenerateFromPassword([]byte("correct horse"), bcrypt.MinCost)
	l := NewLimiter()
	now := time.Now()
	if err := l.CheckPassword(string(h), "correct horse", now); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 5; i++ {
		if err := l.CheckPassword(string(h), "nope", now); err != ErrBadPassword {
			t.Fatalf("attempt %d: %v", i, err)
		}
	}
	if err := l.CheckPassword(string(h), "correct horse", now.Add(time.Minute)); err != ErrLocked {
		t.Fatalf("not locked: %v", err)
	}
	if err := l.CheckPassword(string(h), "correct horse", now.Add(16*time.Minute)); err != nil {
		t.Fatalf("lock did not expire: %v", err)
	}
}

// htpasswd -B (a common way to make the hash) writes $2y$ hashes.
func TestAccepts2yHash(t *testing.T) {
	h, _ := bcrypt.GenerateFromPassword([]byte("pw"), bcrypt.MinCost)
	y := "$2y$" + string(h)[4:]
	if !ValidHash(y) {
		t.Fatal("$2y$ hash rejected")
	}
	if err := NewLimiter().CheckPassword(y, "pw", time.Now()); err != nil {
		t.Fatalf("$2y$ hash does not verify: %v", err)
	}
}

func TestCaptureTokens(t *testing.T) {
	tok := NewToken()
	ts := []CaptureToken{{Name: "other", SHA256: Hash("x")}, {Name: "claude-remote", SHA256: Hash(tok)}}
	if got := CheckCapture(ts, tok); got != "claude-remote" {
		t.Fatalf("got %q", got)
	}
	if CheckCapture(ts, "wrong") != "" || CheckCapture(ts, "") != "" || CheckCapture(nil, tok) != "" {
		t.Fatal("bad token accepted")
	}
}
