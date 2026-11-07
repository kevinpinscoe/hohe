package store

import (
	"database/sql"
	"errors"
	"path/filepath"
	"time"
)

// Sessions holds login sessions in their own database file, outside the backed-up one. Only
// the SHA-256 of each session token is stored, never the token.
type Sessions struct{ db *sql.DB }

// OpenSessions opens (creating if needed) the sessions database in dir.
func OpenSessions(dir string) (*Sessions, error) {
	db, err := openDB(filepath.Join(dir, SessionsFile))
	if err != nil {
		return nil, err
	}
	if _, err := db.Exec(`CREATE TABLE IF NOT EXISTS sessions (
		hash TEXT PRIMARY KEY, created_at TEXT NOT NULL, expires_at TEXT NOT NULL, last_seen TEXT NOT NULL, label TEXT NOT NULL);
		CREATE TABLE IF NOT EXISTS sessions_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`); err != nil {
		db.Close()
		return nil, err
	}
	return &Sessions{db: db}, nil
}

// Close closes the sessions database.
func (s *Sessions) Close() error { return s.db.Close() }

// Create stores a session by its token hash.
func (s *Sessions) Create(hash, label string, now, expires time.Time) error {
	ts := now.UTC().Format(time.RFC3339)
	_, err := s.db.Exec(`INSERT INTO sessions (hash, created_at, expires_at, last_seen, label) VALUES (?, ?, ?, ?, ?)`,
		hash, ts, expires.UTC().Format(time.RFC3339), ts, label)
	return err
}

// ErrNoSession means the session is unknown or expired.
var ErrNoSession = errors.New("no such session")

// Touch validates a session and slides its expiry forward to newExpiry.
func (s *Sessions) Touch(hash string, now, newExpiry time.Time) error {
	var exp string
	if err := s.db.QueryRow(`SELECT expires_at FROM sessions WHERE hash = ?`, hash).Scan(&exp); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return ErrNoSession
		}
		return err
	}
	t, err := time.Parse(time.RFC3339, exp)
	if err != nil || !now.Before(t) {
		_, _ = s.db.Exec(`DELETE FROM sessions WHERE hash = ?`, hash)
		return ErrNoSession
	}
	_, err = s.db.Exec(`UPDATE sessions SET last_seen = ?, expires_at = ? WHERE hash = ?`,
		now.UTC().Format(time.RFC3339), newExpiry.UTC().Format(time.RFC3339), hash)
	return err
}

// Delete ends one session.
func (s *Sessions) Delete(hash string) error {
	_, err := s.db.Exec(`DELETE FROM sessions WHERE hash = ?`, hash)
	return err
}

// DeleteAll ends every session (used when the login password changes).
func (s *Sessions) DeleteAll() error {
	_, err := s.db.Exec(`DELETE FROM sessions`)
	return err
}

// ResetIfCredentialChanged ends every session when the login credential's fingerprint differs
// from the one recorded when the sessions were created, then records the new one. Changing
// the login password therefore logs every device out. It reports whether a reset happened.
func (s *Sessions) ResetIfCredentialChanged(fingerprint string) (bool, error) {
	var cur string
	err := s.db.QueryRow(`SELECT value FROM sessions_meta WHERE key = 'credential'`).Scan(&cur)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return false, err
	}
	if err == nil && cur == fingerprint {
		return false, nil
	}
	tx, err := s.db.Begin()
	if err != nil {
		return false, err
	}
	defer tx.Rollback()
	if _, err := tx.Exec(`DELETE FROM sessions`); err != nil {
		return false, err
	}
	if _, err := tx.Exec(`INSERT INTO sessions_meta (key, value) VALUES ('credential', ?)
		ON CONFLICT(key) DO UPDATE SET value = excluded.value`, fingerprint); err != nil {
		return false, err
	}
	return true, tx.Commit()
}

// Prune removes expired sessions.
func (s *Sessions) Prune(now time.Time) error {
	_, err := s.db.Exec(`DELETE FROM sessions WHERE expires_at <= ?`, now.UTC().Format(time.RFC3339))
	return err
}
