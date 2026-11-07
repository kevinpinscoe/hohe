// Package auth is HOHE's single-user login and its revocable capture tokens.
//
// The login password is checked against a bcrypt hash; a successful login creates a
// session whose random token goes to the browser in an HttpOnly, Secure, SameSite=Strict
// cookie, and only the token's SHA-256 is stored. Capture tokens are configured by their
// SHA-256 alone. No raw secret is ever stored by HOHE or written to its database.
package auth

import (
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"strings"
	"sync"
	"time"

	"golang.org/x/crypto/bcrypt"
)

// CaptureToken is one named, revocable capture token, configured by its SHA-256 (hex).
type CaptureToken struct {
	Name   string `json:"name"`
	SHA256 string `json:"sha256"`
}

// Hash returns the hex SHA-256 of a token.
func Hash(token string) string {
	sum := sha256.Sum256([]byte(token))
	return hex.EncodeToString(sum[:])
}

// NewToken returns a random 256-bit URL-safe token.
func NewToken() string {
	var b [32]byte
	if _, err := rand.Read(b[:]); err != nil {
		panic(err)
	}
	return base64.RawURLEncoding.EncodeToString(b[:])
}

// CheckCapture returns the name of the capture token that matches, or "".
func CheckCapture(tokens []CaptureToken, presented string) string {
	if presented == "" {
		return ""
	}
	h := []byte(Hash(presented))
	name := ""
	for _, t := range tokens {
		want := []byte(strings.ToLower(t.SHA256))
		if len(want) == len(h) && subtle.ConstantTimeCompare(want, h) == 1 {
			name = t.Name
		}
	}
	return name
}

// ErrLocked means too many failed logins; wait and retry.
var ErrLocked = errors.New("too many failed logins; try again later")

// ErrBadPassword means the password did not match.
var ErrBadPassword = errors.New("wrong password")

// Limiter slows password guessing: after MaxFailures failures within Window, logins are
// refused for Lockout. Single user, so the limit is global.
type Limiter struct {
	MaxFailures int
	Window      time.Duration
	Lockout     time.Duration

	mu       sync.Mutex
	failures []time.Time
	until    time.Time
}

// NewLimiter returns the default limiter: 5 failures in 15 minutes locks for 15 minutes.
func NewLimiter() *Limiter {
	return &Limiter{MaxFailures: 5, Window: 15 * time.Minute, Lockout: 15 * time.Minute}
}

// CheckPassword verifies pw against the bcrypt hash, under the limiter.
func (l *Limiter) CheckPassword(hash, pw string, now time.Time) error {
	l.mu.Lock()
	if now.Before(l.until) {
		l.mu.Unlock()
		return ErrLocked
	}
	l.mu.Unlock()
	err := bcrypt.CompareHashAndPassword([]byte(hash), []byte(pw))
	l.mu.Lock()
	defer l.mu.Unlock()
	if err == nil {
		l.failures = nil
		return nil
	}
	keep := l.failures[:0]
	for _, f := range l.failures {
		if now.Sub(f) < l.Window {
			keep = append(keep, f)
		}
	}
	l.failures = append(keep, now)
	if len(l.failures) >= l.MaxFailures {
		l.until = now.Add(l.Lockout)
		l.failures = nil
	}
	return ErrBadPassword
}

// ValidHash reports whether h is a usable bcrypt hash.
func ValidHash(h string) bool {
	_, err := bcrypt.Cost([]byte(h))
	return err == nil
}
