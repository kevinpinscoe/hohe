# HOHE server

> The HOHE application server: a single Go binary holding the planner model, its SQLite
> database, the JSON API, login, the capture API and the embedded PWA.

## Status

**In development (Phase 3).** The server is complete enough to test end to end. Its PWA client
lives in [`../web/`](../web/); an image build copies the client's `web/dist/` into
`web/static/` here. The committed `web/static/index.html` is a placeholder for server-only
builds and tests.

## Quick Start

```bash
go test -race ./...
mkdir -p /tmp/hohe-dev
printf 'a long local dev password\n' | go run ./cmd/hohe hash-password   # prints a bcrypt hash
```

Write `/tmp/hohe-dev.json` (local development only; `persistent: false` skips the storage
guard and `secureCookies: false` allows plain HTTP):

```json
{
  "listen": "127.0.0.1:8080",
  "dataDir": "/tmp/hohe-dev",
  "persistent": false,
  "loginPasswordBcrypt": "<the hash>",
  "captureTokens": [],
  "secureCookies": false,
  "sessionDays": 90
}
```

```bash
go run ./cmd/hohe serve --config /tmp/hohe-dev.json
curl -s http://127.0.0.1:8080/healthz
```

## Requirements

- Go 1.27.3 or later (the module requires it; `GOTOOLCHAIN=auto` downloads it)
- No C toolchain: SQLite is the pure-Go `modernc.org/sqlite`

## Configuration

One JSON file, mounted read-only. It holds **hashes only**, never a raw password or token.

| Key | Meaning |
| --- | --- |
| `listen` | Listen address (default `:8080`) |
| `dataDir` | Directory holding `hohe.sqlite3` and `sessions.sqlite3` |
| `persistent` | Turns on the storage guard. Required for any real data |
| `sentinelId` | Expected first line of `<dataDir>/.hohe-data-sentinel` |
| `requireMountpoint` | The data directory must itself be a mount point |
| `loginPasswordBcrypt` | bcrypt hash of the login password (`$2a$`, `$2b$` or `$2y$`) |
| `captureTokens` | `[{"name": "...", "sha256": "<hex>"}]`, one per revocable capture token |
| `publicOrigin` | e.g. `https://hohe.example.com`; requests with another `Origin` are refused |
| `secureCookies` | Must be `true` behind HTTPS |
| `sessionDays` | Sliding session lifetime (default 90) |

## Common Commands

```bash
hohe serve --config FILE                      # run
hohe healthcheck [--url URL]                  # container health check
hohe snapshot --config FILE --out FILE        # consistent VACUUM INTO snapshot, verified; never overwrites
hohe verify-snapshot FILE                     # integrity check and counts
hohe init-data --dir DIR --sentinel-id ID     # write the sentinel into a new, empty data directory
hohe hash-password < password-on-stdin        # bcrypt hash for the config
hohe-capture [--priority B] [--day YYYY-MM-DD] [--deadline YYYY-MM-DD] TITLE   # needs HOHE_URL and a token file
```

### Capture helper outcomes

`hohe-capture` ends in exactly one of three outcomes:

| Exit | Message | Meaning |
| --- | --- | --- |
| 0 | `Captured: "…" → …` | The server's response confirmed the task. A rerun with the same key says "already captured earlier with this key; not duplicated" |
| 1 | `Not captured: …` | Definitely not accepted: the server refused it, or the request never reached the server |
| 3 | `Capture not confirmed: …` | Unknown. The request was sent, but no confirming response came back (a timeout, a dropped connection, or a 5xx). The server may have accepted it |

Network failures are retried automatically with the same idempotency key. After a failure,
the key is printed: rerunning with `--key KEY` retries the same capture without risking a
duplicate.

## How It Works

**The model** (`internal/domain`) follows the HOHE proposal:

- A task keeps one identity; each day it appears on is a **placement**. Priority (A/B/C) is
  independent of placement.
- **Reserved ranks.** A number held by a closed entry stays reserved for that day and letter.
  Reorders and typed numbers use only free numbers, so no two entries ever share one.
- **Rollover** runs at the configured time in the configured zone. It closes earlier open
  entries as carried and opens their successors, brings delegated tasks back on their
  follow-up day, and purges expired deleted tasks. A ledger makes it idempotent. After
  downtime, a **catch-up** replays each missed day in order, marked as catch-up.
- **Viewing changes nothing.** Only operations and rollover write.

**Sync** is operation-based. Every operation carries a client-generated id, so a replay
returns the original result and is never applied twice.

- Edits carry the field revision they were based on, or depend on an earlier queued
  operation.
- A stale same-field edit keeps the server value and goes to the **conflict tray**, where
  the user chooses explicitly. Later queued edits that depend on it are held with it.
- Completion wins over a stale forward. A deleted task stays deleted, and the edit is offered
  as Restore and apply. A stale reorder is rebased.
- An operation on a **purged** task (a tombstone) is never applied. It goes to the tray with
  Discard only.

**Purge.** Thirty days (configurable) after deletion, a task becomes a tombstone:

- its notes, tags, delegate, effort and source are removed, and redacted to `purged` in its
  history;
- its id, title, letter, placements, rank reservations and history events are kept.

**Storage** is SQLite in WAL mode. Every change is written in one transaction before it
becomes visible.

- Login sessions live in `sessions.sqlite3`, separate from the backed-up `hohe.sqlite3`.
- Only the SHA-256 of each session token is stored.

## API

All responses are JSON. **Lists are never `null`**: an empty list is `[]`.

| Method and path | Auth | Purpose |
| --- | --- | --- |
| `GET /healthz` | none | `ok`, server planner day, `rolloverCurrent`, open conflicts |
| `GET /version` | none | build version and commit |
| `POST /api/login` | client header | `{"password", "device"}`; sets the session cookie |
| `POST /api/logout` | client header | ends the session |
| `GET /api/session` | none | whether this browser is logged in |
| `GET /api/state` | session | the whole client view |
| `POST /api/sync` | session + client header | `{"deviceId", "ops": [...]}` → one result per op, plus the new state |
| `GET /api/history?task=ID` | session | a task's history events |
| `GET /api/export` | session | full JSON export (state and history) |
| `POST /api/capture` | `Authorization: Bearer <capture token>` | `{"title", "idempotencyKey", "priority"?, "day"?, "deadline"?}` |

State-changing requests must send `X-HOHE-Client: 1`. A cross-site form cannot set that
header. If the browser sends an `Origin`, it must match `publicOrigin`.

**Operation types:**

- **Tasks:** `capture`/`create`, `assign`, `planIt`, `edit`, `complete`, `reopen`, `forward`,
  `backToDump`, `delete`, `restore`, `delegate`, `inProgress`, `keepToday`.
- **Ordering:** `setRank`, `reorder`.
- **Planning:** `snooze`, `pauseSuggestions`, `resumeSuggestions`, `dismissCard`,
  `designate`, `markPlanned`.
- **Other:** `setting`, `correct` (an explicit, recorded correction of a closed entry),
  `resolve` (a conflict-tray choice).

Result statuses are `applied`, `noop`, `conflict` (sent to the tray), `held` and `rejected`.

## Testing

```bash
go test -race ./...
TZ=Atlantic/Reykjavik go test ./...    # the zone LibreWolf's resistFingerprinting reports
```

The tests cover proposal §15:

- ordering and reserved ranks;
- the carry-history acceptance example;
- catch-up equivalence and idempotency;
- DST rollovers;
- suggestions and the once-a-day card;
- capture idempotency;
- every sync conflict case;
- purge and tombstones;
- snapshot, restore, login, CSRF and the storage guard.

## Security

- The login password and capture tokens are configured as hashes. Session tokens are stored
  as hashes. None appears in logs.
- Logins are rate limited: five failures in 15 minutes lock logins for 15 minutes.
- Changing the login password (its configured hash) ends every session at the next start.
- Responses carry a strict Content-Security-Policy, `nosniff`, `no-referrer` and
  `frame-ancestors 'none'`.

## License

MIT. See [LICENSE](../LICENSE).
