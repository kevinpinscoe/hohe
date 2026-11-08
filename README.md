# HOHE

> A self-hosted ABC123 daily planner PWA with quick capture, daily planning, and gentle task
> suggestions.

HOHE (*Hoc opus hodie est*, "this is the work today", pronounced "Ho-He") is a Franklin
Planner-like daily planner for one-off personal tasks, such as "call Sarah" or "go to the
grocery store", designed to be ADHD-friendly.

## Status

**Proof of concept.** This repository contains two throwaway pieces, both using only
**synthetic, invented tasks** and no real data:

- `prototype/` — the clickable visual prototype (Phase 1). It runs entirely in the browser.
- `spike/` — the **Phase 2 technical spike**: a minimal Go API and a minimal installable PWA
  that test offline capture, duplicate-safe replay of queued operations, a same-field edit
  conflict sent to a conflict tray, and the planner-day boundary computed in an explicit time
  zone. Its server keeps data **in memory only**, so restarting it loses everything; durable
  storage is not part of the spike.

Neither is the HOHE application.

**Phase 3, the HOHE application, is in progress** in `server/` and `web/`:

- `server/` — the Go server with SQLite storage, the full task model, rollover with carry
  history, operation-based sync with a conflict tray, soft delete with purge, suggestions,
  login and the capture API. See [server/README.md](server/README.md).
- `web/` — the PWA client, built on the accepted prototype: it works offline, queues every
  change on the device, and syncs it to the server. The container image, CI publishing and the
  web1 deployment are still to come.

## Purpose

Most to-do lists show every task at once. HOHE follows the paper planner method instead:

- **Capture first.** Anything can be captured with just a title. It lands in the Task Dump
  with no priority and no day.
- **Prioritize with ABC123.** A is vital, B is important, and C needs doing but is neither
  vital nor important. Within a letter on a given day, numbers set the order: A1, A2, B1 and so
  on.
- **Plan one day at a time.** Each day has its own Prioritized Daily Task List. Unfinished
  tasks carry over automatically, with a visible "carried ×*n*" badge.
- **Keep C tasks moving.** A C Review page, and at most one gentle suggestion a day, help
  plan C work onto days marked as having room. A C task stays C when it is planned.

## Quick Start

```bash
git clone https://github.com/kevinpinscoe/hohe.git
cd hohe/prototype
npm install
npm run dev
```

Open the URL Vite prints (normally `http://localhost:5173/`).

To try it on a phone on the same network, start it with `npm run dev -- --host` and open the
printed network address on the phone.

## Requirements

- Node.js 24 (pinned in `mise.toml`; run `mise install` if you use mise)
- A current browser: Safari on iOS, Firefox, LibreWolf, or a Chromium-based browser

## Common Commands

Run these from `prototype/`:

```bash
npm run dev        # development server with hot reload
npm run build      # type-check and build to prototype/dist/
npm run preview    # serve the built prototype
npm test           # model and rendering tests (vitest)
npm run typecheck  # TypeScript only
```

## Using the Prototype

The demo bar at the top has three controls:

- **Plan my day** opens the daily review again.
- **Next day (simulate rollover)** advances the planner day, so automatic carry-over can be
  watched.
- **Reset demo** replaces every change with fresh synthetic tasks.

Changes are kept only in this browser's local storage.

What to try:

| Scenario | Where |
| --- | --- |
| Busy day with long titles | Today: 17 entries across A, B and C |
| Quick capture, then ABC123 assignment | Capture box at the top, then Task Dump → Assign |
| Completion and forwarding | The checkbox completes; the ⋯ menu forwards |
| Plan My Day and carry-over review | Next day, then the review sheet; past pages show "carried Wed → Fri" |
| Reserved ranks | Reorder the A group: the completed A1 keeps its number, and no number is used twice |
| C Review with one suggestion | C Review: "Plan it" plans a C task without changing its letter |

## The Phase 2 Spike

Run it locally (Go 1.27 and Node 24 are pinned in `mise.toml`):

```bash
cd spike
go test -race ./...                         # server tests
TZ=UTC node --test 'web/test/*.test.mjs'    # client tests, under a UTC default zone
go run ./cmd/hohe-spike -config ../example-config.json
```

Open `http://127.0.0.1:8080/`. The page shows the sync state ("All synced" or "N changes
waiting to sync"), the conflict tray, spike controls (pause sync to simulate offline, resend
the last batch to prove duplicates are recognised) and a diagnostics panel (persistent
storage, installed state, the browser's default time zone and the planner day computed in the
explicit one).

Container images are published to `ghcr.io/kevinpinscoe/hohe`, tagged `sha-<commit>`, by
`.github/workflows/spike-image.yml`. See [RUNBOOK.md](RUNBOOK.md).

## The Phase 3 Server

```bash
cd server
go test -race ./...     # domain, store, API and guard tests
go run ./cmd/hohe help  # subcommands: serve, healthcheck, snapshot, verify-snapshot, init-data, hash-password
```

The API, the operations it accepts, its configuration and its data files are described in
[server/README.md](server/README.md).

## The Phase 3 Client

```bash
cd web
npm ci
npm test           # type-checked unit, queue and rendering tests (vitest, fake IndexedDB)
npm run build      # type-check and build to web/dist/, including the service worker
npm run e2e        # browser tests against the real Go server (installed Chrome)
npm run dev        # development server; proxies /api to a local `hohe serve` on :8080
```

The server embeds the client: an image build copies `web/dist/` into `server/web/static/`.
The committed `server/web/static/index.html` is only a placeholder for server-only builds.

`npm run e2e` builds the server with the client embedded, in a temporary directory, and runs
it on `127.0.0.1:18089` with a throwaway data directory and synthetic tasks. Set
`HOHE_E2E_CHANNEL=chromium` to use Playwright's own Chromium instead of installed Chrome. These
are automated Chromium results; iPhone (Safari) behaviour is verified separately on the device.

## Repository Layout

```text
hohe/
├── prototype/             # visual prototype (Preact + TypeScript + Vite)
│   ├── index.html
│   ├── package.json
│   ├── tsconfig.json
│   ├── vite.config.ts
│   └── src/
│       ├── app.tsx        # shell: capture bar, navigation, demo controls, undo
│       ├── ctx.ts         # shared view context and dialog types
│       ├── dates.ts       # planner-day helpers (explicit time zone, 03:00 rollover)
│       ├── day.tsx        # the daily page and the suggestion card
│       ├── dialogs.tsx    # action menu, rank picker, forward/delegate/assign/plan sheets
│       ├── lists.tsx      # Task Dump, C Review, Plan My Day
│       ├── model.ts       # task model: placements, reserved ranks, carry history, suggestions
│       ├── model.test.ts  # acceptance scenarios for the model
│       ├── render.test.tsx # every page and dialog renders
│       ├── seed.ts        # synthetic demonstration tasks
│       ├── main.tsx
│       └── styles.css
├── spike/                 # Phase 2 technical spike (Go API + minimal PWA)
│   ├── cmd/hohe-spike/    # entry point: --version, --healthcheck, -config
│   ├── internal/store/    # in-memory store: ops, revisions, replay, conflict tray
│   ├── internal/plannerday/ # planner day in an explicit time zone
│   ├── internal/server/   # JSON API and static PWA
│   ├── web/static/        # the PWA: app, sync queue, IndexedDB, service worker
│   ├── web/test/          # client unit tests (node --test)
│   └── Dockerfile
├── server/                # Phase 3 application server (Go, SQLite)
│   ├── cmd/hohe/          # the server and its maintenance subcommands
│   ├── cmd/hohe-capture/  # capture helper for voice capture through a Claude Code session
│   ├── internal/domain/   # task model, ranks, rollover, sync and conflicts, purge, suggestions
│   ├── internal/store/    # SQLite persistence, history, snapshots, login sessions
│   ├── internal/app/      # the service: model, store and clock under one lock
│   ├── internal/api/      # HTTP API, login, capture API, static PWA
│   ├── internal/auth/     # password check, rate limit, session and capture tokens
│   ├── internal/guard/    # storage guard: refuses an absent or wrong data directory
│   ├── internal/config/   # runtime configuration file
│   ├── internal/plannerday/ # planner day in an explicit time zone
│   ├── web/               # embeds the built client (web/dist) into the binary
│   └── README.md
├── web/                   # Phase 3 PWA client (Preact + TypeScript + Vite)
│   ├── src/
│   │   ├── app.tsx        # shell: capture, navigation, sync status, login, update prompt
│   │   ├── day.tsx, lists.tsx, dialogs.tsx # the pages and sheets (from the prototype)
│   │   ├── status.tsx     # sync summary, banners, conflict tray, rejected and pending lists
│   │   ├── settings.tsx   # versions, storage persistence, settings, guarded logout/clear
│   │   ├── store.ts       # controller: IndexedDB copy, sync scheduling, login, cross-tab reload
│   │   ├── intents.ts     # user actions → queued server operations and their dependencies
│   │   ├── sync.ts        # sync engine: device-wide lock, batches, placement-id mapping
│   │   ├── db.ts          # IndexedDB: confirmed state, the queue, rejected actions
│   │   ├── local.ts       # display state = confirmed state + pending operations
│   │   ├── model.ts       # task model queries and optimistic operations
│   │   ├── api.ts         # HTTP calls with a bounded timeout
│   │   ├── update.ts      # service-worker registration and the update prompt
│   │   └── *.test.ts(x)   # unit, queue and rendering tests
│   ├── sw/sw.js           # service worker source (version and asset list added at build)
│   ├── e2e/               # browser tests and the real-server harness (Playwright)
│   └── public/            # manifest and icons
├── .github/workflows/     # CI (spike, app server and client) and spike image publishing
├── compose.yml            # run the spike image
├── example-config.json    # every spike config key
├── install.sh / uninstall.sh
├── .gitignore
├── LICENSE
├── mise.toml
├── README.md
└── RUNBOOK.md
```

## How It Works

### The Phase 3 client

The client shows the last state the server confirmed, with this device's pending changes
applied on top. The two are stored separately in IndexedDB, so refreshing from the server
never overwrites a queued change.

- **Saved before shown.** Each action is written to IndexedDB as one or more server
  operations, and appears on screen only after that write has committed. If the write fails,
  the change is refused and any typed text stays in its field.
- **Ids chosen on the device.** A new task gets a UUID, which the server keeps as its id, so
  later queued operations name it directly. A new placement gets a local id. The sync stops
  each batch after the operation that creates such a placement, takes the server's placement
  id from that operation's result (a resend returns the same result), and rewrites later
  operations before sending them. "Capture offline → edit → assign B1 → reconnect" works
  this way.
- **Dependencies.** An edit names the queued edit of the same field it builds on, or else the
  revision the server last confirmed. A priority change is always an edit, never part of an
  assignment, so the chain stays unbroken.
- **Edit dialogs keep their baseline.** An edit or assign dialog records each field's value
  and base when it opens, and sends only the fields that were actually changed, built on that
  baseline. A refresh while the dialog is open therefore never rebases the edit: a field
  changed elsewhere goes to the conflict tray instead of being overwritten, and an untouched
  field is not sent at all.
- **One sync at a time.** A Web Lock shared by every tab and the installed app makes sure only
  one of them sends the queue. An operation is removed from the queue in the same transaction
  that stores the server's answer. Closing the app mid-request just resends the operation,
  and the server answers with the original result.
- **Visible state.** Each answer is one of: saved on the server, waiting to sync, a conflict
  needing a choice (the conflict tray: Keep server, Use mine, Restore and apply, Reopen and
  apply, Apply anyway, Discard), or a rejected action needing attention. "All synced" appears
  only when nothing is in any of the last three.
- **Sessions.** A login failure stops the sync and keeps the queue. HOHE asks for the password
  and then resumes.
- **Log out and Clear this device.** Both count pending changes and rejected actions. They
  offer Sync now, Export to a file, or Discard, and Discard names both counts. Rejected
  actions must be exported before Discard is offered. Clearing takes the same lock as a sync,
  so it waits for a sync in any tab to finish. Immediately before clearing it checks again:
  if another tab added work after the confirmation, nothing is cleared and HOHE asks again
  with the new counts. Each clear moves an epoch counter on, so a sync answer still in flight
  is never stored afterwards. The other tabs stop syncing and ask for login. Clear this device
  also forgets the device id.
- **Updates.** Each version caches its own complete shell, and a new version waits until
  "Update now" is chosen; HOHE never reloads by itself. The first install replaces the
  Phase 2 spike's service worker at the same address and deletes the spike's cached files.
  IndexedDB is never touched by an update.

### The prototype

The prototype holds one state object in memory and in `localStorage`. The model in
`prototype/src/model.ts` follows the same rules the real application will use:

- **Priority and placement are independent.** A task can be A, B or C with no day, and a
  daily number exists only inside one letter group on one day.
- **One task, many placements.** Each day a task appears on is a placement record. Rollover
  closes an unfinished placement as "carried" and opens a new one on the next day. Closed
  placements are never rewritten, so past pages stay as they ended.
- **Reserved ranks.** Numbers held by completed or otherwise closed entries stay reserved for
  that day, so reordering never creates a duplicate.
- **Suggestions respect capacity.** Only days marked "room available" (or today, while
  planning) receive suggestions. An approaching deadline bypasses the minimum age.

## Development Workflow

Changes are made on a feature branch and merged through a pull request. Before committing, run
`npm test` and `npm run build` in `prototype/` or `web/` for the part you changed, and
`npm run e2e` in `web/` for client or server changes.

## Security

The prototype stores nothing outside the browser and sends nothing over the network. The spike
has **no application login**: anyone who can reach its port can read and change its synthetic
data, so run it only where network access is already restricted, and never with real data.
The Phase 3 server requires a login for its API, accepts captures only with a configured
capture token, and stores only hashes of the password and tokens. Do
not put real personal data in screenshots, fixtures or issues; use synthetic tasks.

## License

MIT. See [LICENSE](LICENSE).
