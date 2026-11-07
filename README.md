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
├── .github/workflows/     # spike CI and image publishing
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
`npm test` and `npm run build` in `prototype/`.

## Security

The prototype stores nothing outside the browser and sends nothing over the network. The spike
has **no application login**: anyone who can reach its port can read and change its synthetic
data, so run it only where network access is already restricted, and never with real data. Do
not put real personal data in screenshots, fixtures or issues; use synthetic tasks.

## License

MIT. See [LICENSE](LICENSE).
