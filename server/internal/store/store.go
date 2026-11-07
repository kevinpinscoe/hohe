// Package store persists HOHE's model in SQLite, through a pure-Go driver, in WAL mode.
//
// The authoritative database is hohe.sqlite3. Login sessions live in a separate file,
// sessions.sqlite3, so a database backup never contains them (losing them means logging
// in again). Secret values are never stored in either.
package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/kevinpinscoe/hohe/server/internal/domain"

	_ "modernc.org/sqlite" // registers the "sqlite" driver
)

// File names inside the data directory.
const (
	DBFile       = "hohe.sqlite3"
	SessionsFile = "sessions.sqlite3"
)

// SchemaVersion is the current schema version (PRAGMA user_version).
const SchemaVersion = 1

var migrations = []string{
	// 1: initial schema
	`CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
	CREATE TABLE tasks (id TEXT PRIMARY KEY, state TEXT NOT NULL, data TEXT NOT NULL);
	CREATE TABLE placements (id TEXT PRIMARY KEY, task_id TEXT NOT NULL, day TEXT NOT NULL, data TEXT NOT NULL);
	CREATE INDEX placements_task ON placements(task_id);
	CREATE INDEX placements_day ON placements(day);
	CREATE TABLE events (seq INTEGER PRIMARY KEY, at TEXT NOT NULL, day TEXT NOT NULL, kind TEXT NOT NULL,
		task_id TEXT NOT NULL, placement_id TEXT NOT NULL, op_id TEXT NOT NULL, data TEXT NOT NULL);
	CREATE INDEX events_task ON events(task_id);
	CREATE TABLE ops (op_id TEXT PRIMARY KEY, device_id TEXT NOT NULL, received_at TEXT NOT NULL, result TEXT NOT NULL);
	CREATE TABLE conflicts (id TEXT PRIMARY KEY, status TEXT NOT NULL, data TEXT NOT NULL);
	CREATE TABLE settings (id INTEGER PRIMARY KEY CHECK (id = 1), data TEXT NOT NULL);
	CREATE TABLE planning (id INTEGER PRIMARY KEY CHECK (id = 1), data TEXT NOT NULL);
	CREATE TABLE ledger (day TEXT PRIMARY KEY, run_at TEXT NOT NULL, catch_up INTEGER NOT NULL);
	CREATE TABLE group_revs (day TEXT NOT NULL, letter TEXT NOT NULL, rev INTEGER NOT NULL, PRIMARY KEY (day, letter));`,
}

// Store is an open HOHE database.
type Store struct {
	db  *sql.DB
	dir string
}

// Open opens (creating if needed) the database in dir and migrates it.
func Open(dir string) (*Store, error) {
	path := filepath.Join(dir, DBFile)
	db, err := openDB(path)
	if err != nil {
		return nil, err
	}
	s := &Store{db: db, dir: dir}
	if err := s.migrate(); err != nil {
		db.Close()
		return nil, err
	}
	return s, nil
}

func openDB(path string) (*sql.DB, error) {
	dsn := "file:" + path + "?_pragma=journal_mode(WAL)&_pragma=synchronous(FULL)&_pragma=foreign_keys(ON)&_pragma=busy_timeout(5000)"
	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(1) // one writer; the service serializes access anyway
	if err := db.Ping(); err != nil {
		db.Close()
		return nil, fmt.Errorf("open %s: %w", path, err)
	}
	return db, nil
}

// Close closes the database.
func (s *Store) Close() error { return s.db.Close() }

func (s *Store) migrate() error {
	var v int
	if err := s.db.QueryRow(`PRAGMA user_version`).Scan(&v); err != nil {
		return err
	}
	if v > SchemaVersion {
		return fmt.Errorf("database schema %d is newer than this build (%d); deploy the matching image", v, SchemaVersion)
	}
	for i := v; i < SchemaVersion; i++ {
		tx, err := s.db.Begin()
		if err != nil {
			return err
		}
		if _, err := tx.Exec(migrations[i]); err != nil {
			tx.Rollback()
			return fmt.Errorf("migration %d: %w", i+1, err)
		}
		if _, err := tx.Exec(fmt.Sprintf(`PRAGMA user_version = %d`, i+1)); err != nil {
			tx.Rollback()
			return err
		}
		if err := tx.Commit(); err != nil {
			return err
		}
	}
	return nil
}

// Load reads the whole model.
func (s *Store) Load() (*domain.State, error) {
	st := domain.NewState()
	rows, err := s.db.Query(`SELECT data FROM tasks`)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var data string
		if err := rows.Scan(&data); err != nil {
			rows.Close()
			return nil, err
		}
		var t domain.Task
		if err := json.Unmarshal([]byte(data), &t); err != nil {
			rows.Close()
			return nil, fmt.Errorf("task: %w", err)
		}
		if t.Tags == nil {
			t.Tags = []string{}
		}
		if t.Revisions == nil {
			t.Revisions = map[string]int{}
		}
		st.Tasks[t.ID] = &t
	}
	rows.Close()

	rows, err = s.db.Query(`SELECT data FROM placements ORDER BY rowid`)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var data string
		if err := rows.Scan(&data); err != nil {
			rows.Close()
			return nil, err
		}
		var p domain.Placement
		if err := json.Unmarshal([]byte(data), &p); err != nil {
			rows.Close()
			return nil, fmt.Errorf("placement: %w", err)
		}
		st.AddLoadedPlacement(&p)
	}
	rows.Close()

	rows, err = s.db.Query(`SELECT data FROM conflicts ORDER BY rowid`)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var data string
		if err := rows.Scan(&data); err != nil {
			rows.Close()
			return nil, err
		}
		var c domain.Conflict
		if err := json.Unmarshal([]byte(data), &c); err != nil {
			rows.Close()
			return nil, fmt.Errorf("conflict: %w", err)
		}
		if c.HeldOps == nil {
			c.HeldOps = []domain.Op{}
		}
		if c.Actions == nil {
			c.Actions = []string{}
		}
		st.AddLoadedConflict(&c)
	}
	rows.Close()

	rows, err = s.db.Query(`SELECT op_id, device_id, received_at, result FROM ops`)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var r domain.OpRecord
		var res string
		if err := rows.Scan(&r.OpID, &r.DeviceID, &r.ReceivedAt, &res); err != nil {
			rows.Close()
			return nil, err
		}
		if err := json.Unmarshal([]byte(res), &r.Result); err != nil {
			rows.Close()
			return nil, err
		}
		st.Ops[r.OpID] = &r
	}
	rows.Close()

	var data string
	switch err := s.db.QueryRow(`SELECT data FROM settings WHERE id = 1`).Scan(&data); {
	case errors.Is(err, sql.ErrNoRows):
	case err != nil:
		return nil, err
	default:
		set := domain.DefaultSettings()
		if err := json.Unmarshal([]byte(data), &set); err != nil {
			return nil, err
		}
		if set.Revisions == nil {
			set.Revisions = map[string]int{}
		}
		st.Settings = set
	}
	switch err := s.db.QueryRow(`SELECT data FROM planning WHERE id = 1`).Scan(&data); {
	case errors.Is(err, sql.ErrNoRows):
	case err != nil:
		return nil, err
	default:
		pl := st.Planning
		if err := json.Unmarshal([]byte(data), &pl); err != nil {
			return nil, err
		}
		if pl.Designations == nil {
			pl.Designations = map[string]string{}
		}
		if pl.Snoozes == nil {
			pl.Snoozes = map[string]string{}
		}
		if pl.PlannedDays == nil {
			pl.PlannedDays = []string{}
		}
		st.Planning = pl
	}

	rows, err = s.db.Query(`SELECT day, run_at, catch_up FROM ledger`)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var e domain.LedgerEntry
		var cu int
		if err := rows.Scan(&e.Day, &e.RunAt, &cu); err != nil {
			rows.Close()
			return nil, err
		}
		e.CatchUp = cu != 0
		st.SetLoadedLedger(e)
	}
	rows.Close()

	rows, err = s.db.Query(`SELECT day, letter, rev FROM group_revs`)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var k domain.GroupKey
		var r int
		if err := rows.Scan(&k.Day, &k.Letter, &r); err != nil {
			rows.Close()
			return nil, err
		}
		st.GroupRevs[k] = r
	}
	rows.Close()

	for key, dst := range map[string]*int64{"seq": &st.Seq} {
		var v string
		err := s.db.QueryRow(`SELECT value FROM meta WHERE key = ?`, key).Scan(&v)
		if err == nil {
			*dst, _ = strconv.ParseInt(v, 10, 64)
		} else if !errors.Is(err, sql.ErrNoRows) {
			return nil, err
		}
	}
	if err := s.db.QueryRow(`SELECT COALESCE(MAX(seq), 0) FROM events`).Scan(&st.EventSeq); err != nil {
		return nil, err
	}
	return st, nil
}

// Commit writes a Tx's changes in one database transaction.
func (s *Store) Commit(c *domain.Changes) error {
	if c.Empty() {
		return nil
	}
	ctx := context.Background()
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	put := func(q string, args ...any) error {
		_, err := tx.Exec(q, args...)
		return err
	}
	for _, t := range c.Tasks {
		b, _ := json.Marshal(t)
		if err := put(`INSERT INTO tasks (id, state, data) VALUES (?, ?, ?)
			ON CONFLICT(id) DO UPDATE SET state = excluded.state, data = excluded.data`, t.ID, t.State, string(b)); err != nil {
			return err
		}
	}
	for _, p := range c.Placements {
		b, _ := json.Marshal(p)
		if err := put(`INSERT INTO placements (id, task_id, day, data) VALUES (?, ?, ?, ?)
			ON CONFLICT(id) DO UPDATE SET data = excluded.data`, p.ID, p.TaskID, p.Day, string(b)); err != nil {
			return err
		}
	}
	for _, cf := range c.Conflicts {
		b, _ := json.Marshal(cf)
		if err := put(`INSERT INTO conflicts (id, status, data) VALUES (?, ?, ?)
			ON CONFLICT(id) DO UPDATE SET status = excluded.status, data = excluded.data`, cf.ID, cf.Status, string(b)); err != nil {
			return err
		}
	}
	for _, r := range c.Ops {
		b, _ := json.Marshal(r.Result)
		if err := put(`INSERT INTO ops (op_id, device_id, received_at, result) VALUES (?, ?, ?, ?)
			ON CONFLICT(op_id) DO UPDATE SET result = excluded.result`, r.OpID, r.DeviceID, r.ReceivedAt, string(b)); err != nil {
			return err
		}
	}
	if c.Settings != nil {
		b, _ := json.Marshal(c.Settings)
		if err := put(`INSERT INTO settings (id, data) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data`, string(b)); err != nil {
			return err
		}
	}
	if c.Planning != nil {
		b, _ := json.Marshal(c.Planning)
		if err := put(`INSERT INTO planning (id, data) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data`, string(b)); err != nil {
			return err
		}
	}
	for _, e := range c.Ledger {
		cu := 0
		if e.CatchUp {
			cu = 1
		}
		if err := put(`INSERT INTO ledger (day, run_at, catch_up) VALUES (?, ?, ?) ON CONFLICT(day) DO NOTHING`, e.Day, e.RunAt, cu); err != nil {
			return err
		}
	}
	for k, r := range c.GroupRevs {
		if err := put(`INSERT INTO group_revs (day, letter, rev) VALUES (?, ?, ?)
			ON CONFLICT(day, letter) DO UPDATE SET rev = excluded.rev`, k.Day, k.Letter, r); err != nil {
			return err
		}
	}
	for _, e := range c.Events {
		b, _ := json.Marshal(e.Data)
		if err := put(`INSERT INTO events (seq, at, day, kind, task_id, placement_id, op_id, data) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
			e.Seq, e.At, e.Day, e.Kind, e.TaskID, e.PlacementID, e.OpID, string(b)); err != nil {
			return err
		}
	}
	for _, rd := range c.Redactions {
		if err := redact(tx, rd); err != nil {
			return err
		}
	}
	if err := put(`INSERT INTO meta (key, value) VALUES ('seq', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
		strconv.FormatInt(c.Seq, 10)); err != nil {
		return err
	}
	return tx.Commit()
}

// Purged is the marker that replaces a purged field's value in history.
const Purged = "purged"

// redact replaces the purged fields' values in a task's history events. The events, their
// kinds, order and times are kept (§6.5).
func redact(tx *sql.Tx, rd domain.Redaction) error {
	fields := map[string]bool{}
	for _, f := range rd.Fields {
		fields[f] = true
	}
	rows, err := tx.Query(`SELECT seq, data FROM events WHERE task_id = ?`, rd.TaskID)
	if err != nil {
		return err
	}
	type upd struct {
		seq  int64
		data string
	}
	var ups []upd
	for rows.Next() {
		var seq int64
		var data string
		if err := rows.Scan(&seq, &data); err != nil {
			rows.Close()
			return err
		}
		var m map[string]any
		if json.Unmarshal([]byte(data), &m) != nil {
			continue
		}
		changed := false
		for k := range m {
			if fields[k] && m[k] != Purged {
				m[k] = Purged
				changed = true
			}
		}
		if f, ok := m["field"].(string); ok && fields[f] {
			for _, k := range []string{"from", "to"} {
				if _, ok := m[k]; ok && m[k] != Purged {
					m[k] = Purged
					changed = true
				}
			}
		}
		if changed {
			b, _ := json.Marshal(m)
			ups = append(ups, upd{seq, string(b)})
		}
	}
	rows.Close()
	for _, u := range ups {
		if _, err := tx.Exec(`UPDATE events SET data = ? WHERE seq = ?`, u.data, u.seq); err != nil {
			return err
		}
	}
	return nil
}

// History returns a task's events, oldest first.
func (s *Store) History(taskID string, limit int) ([]domain.Event, error) {
	if limit <= 0 || limit > 5000 {
		limit = 5000
	}
	rows, err := s.db.Query(`SELECT seq, at, day, kind, task_id, placement_id, op_id, data FROM events
		WHERE task_id = ? ORDER BY seq LIMIT ?`, taskID, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []domain.Event{}
	for rows.Next() {
		var e domain.Event
		var data string
		if err := rows.Scan(&e.Seq, &e.At, &e.Day, &e.Kind, &e.TaskID, &e.PlacementID, &e.OpID, &data); err != nil {
			return nil, err
		}
		_ = json.Unmarshal([]byte(data), &e.Data)
		out = append(out, e)
	}
	return out, rows.Err()
}

// SnapshotInfo describes a verified snapshot.
type SnapshotInfo struct {
	Path       string `json:"path"`
	Bytes      int64  `json:"bytes"`
	Tasks      int    `json:"tasks"`
	Placements int    `json:"placements"`
	Events     int    `json:"events"`
	Schema     int    `json:"schema"`
}

// Snapshot writes a consistent copy of the live database to dest with VACUUM INTO (never a
// raw copy of live files), then opens the copy and verifies it.
func (s *Store) Snapshot(dest string) (SnapshotInfo, error) {
	if strings.ContainsAny(dest, "'\x00") {
		return SnapshotInfo{}, errors.New("snapshot path must not contain a quote")
	}
	if _, err := os.Stat(dest); err == nil {
		return SnapshotInfo{}, fmt.Errorf("%s already exists; snapshots are never overwritten", dest)
	}
	if _, err := s.db.Exec(`VACUUM INTO '` + dest + `'`); err != nil {
		return SnapshotInfo{}, fmt.Errorf("vacuum into: %w", err)
	}
	return VerifySnapshot(dest)
}

// VerifySnapshot opens a snapshot read-only and checks its integrity and contents.
func VerifySnapshot(path string) (SnapshotInfo, error) {
	info := SnapshotInfo{Path: path}
	fi, err := os.Stat(path)
	if err != nil {
		return info, err
	}
	info.Bytes = fi.Size()
	db, err := sql.Open("sqlite", "file:"+path+"?mode=ro")
	if err != nil {
		return info, err
	}
	defer db.Close()
	var ok string
	if err := db.QueryRow(`PRAGMA integrity_check`).Scan(&ok); err != nil || ok != "ok" {
		return info, fmt.Errorf("integrity check: %v %s", err, ok)
	}
	if err := db.QueryRow(`PRAGMA user_version`).Scan(&info.Schema); err != nil {
		return info, err
	}
	for q, dst := range map[string]*int{
		`SELECT COUNT(*) FROM tasks`: &info.Tasks, `SELECT COUNT(*) FROM placements`: &info.Placements,
		`SELECT COUNT(*) FROM events`: &info.Events,
	} {
		if err := db.QueryRow(q).Scan(dst); err != nil {
			return info, err
		}
	}
	return info, nil
}
