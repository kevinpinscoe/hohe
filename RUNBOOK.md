# RUNBOOK — HOHE application

Operational reference for the **HOHE application image**: the Go server (`server/`) with the
PWA client (`web/`) embedded. The Phase 2 spike has its own runbook (see
[Subdirectory Runbooks](#subdirectory-runbooks)).

**Status (2026-11-08):** the image is built and published by CI, and has been **deployed on web1**
(tailnet only) since 2026-11-08, image `app-sha-249b481`. Monitoring, daily snapshots with an
off-host copy, and a restore verification are in place. The outage and restart tests and iPhone
acceptance are still outstanding under
[POE-72](https://youtrack.kevininscoe.com/issue/POE-72). Sections that describe one of those
say so.

## Purpose and Capabilities

A single static Go binary on distroless that serves:

- the JSON API: login, state, operation-based sync with a conflict tray, history, export;
- the capture API for revocable capture tokens (`POST /api/capture`);
- the installable PWA, which works offline and syncs a queue of operations when it can.

Data is SQLite in WAL mode under `/data`: `hohe.sqlite3` (the planner) and
`sessions.sqlite3` (login sessions, deliberately separate and not backed up). A storage guard
refuses to start in persistent mode on an absent or wrong data directory.

## Prerequisites

- Docker Engine 24 or later with the Compose plugin; `linux/amd64` or `linux/arm64`.
- A TLS reverse proxy in front of it. Service workers, secure cookies and
  `navigator.storage.persist()` need HTTPS.
- A data directory writable by the image's `nonroot` user (uid `65532`). For real data, it
  must be on encrypted storage (proposal §11.3).
- About 30 MB of memory at rest; `compose.yml` limits it to 256 MB.

## Image

- Registry: `ghcr.io/kevinpinscoe/hohe`.
- Tags: `app-sha-<full source commit>`, one per change to `server/`, `web/` or the
  `Dockerfile` on `main`. There are no semver tags and no `latest`. The spike's images in the
  same repository are tagged `sha-<commit>`.
- Always deploy by digest:

```bash
docker pull ghcr.io/kevinpinscoe/hohe:app-sha-<commit>
docker inspect --format '{{index .RepoDigests 0}}' ghcr.io/kevinpinscoe/hohe:app-sha-<commit>
# use: ghcr.io/kevinpinscoe/hohe:app-sha-<commit>@sha256:<digest>
```

Published by `.github/workflows/app-image.yml` after `app-ci.yml` passes. Every PR touching
the image also builds and smoke-tests it (App CI, `image-build`).

## Install and First Run

```bash
HOHE_IMAGE=ghcr.io/kevinpinscoe/hohe:app-sha-<commit>@sha256:<digest> ./install.sh
```

`install.sh` refuses an unpinned image. It creates `config.json` from `example-config.json`,
and creates `./data` (or `$HOHE_DATA_DIR`) with a storage-guard sentinel. It never handles a
password. Then:

1. Hash the login password (12 characters or more), and put only the hash in
   `config.json` as `loginPasswordBcrypt`:

   ```bash
   docker run --rm -i "$HOHE_IMAGE" hash-password    # type the password, then Enter
   ```

2. Put the sentinel id `install.sh` printed in `sentinelId`, and set `publicOrigin` to the
   site's `https://` origin.
3. Make the data directory writable by uid `65532`: `sudo chown -R 65532:65532 ./data`.
   On an SELinux host, label it for containers first (see your host's SELinux rules). Do not
   relabel a home directory.
4. Start it and check it:

   ```bash
   HOHE_IMAGE=... docker compose up -d
   curl -s http://127.0.0.1:8080/healthz        # {"ok":true,...}
   ```

The port binds `127.0.0.1` only.

## Configuration

`config.json` is mounted read-only at `/config/config.json`. It holds **hashes only**: never a
raw password or token. There are no environment variables.

| Key | Default | Meaning |
| --- | --- | --- |
| `listen` | `":8080"` | Listen address inside the container |
| `dataDir` | `"/data"` | Directory holding `hohe.sqlite3` and `sessions.sqlite3` |
| `persistent` | `false` (`true` in `example-config.json`) | Turns on the storage guard. Required for real data |
| `sentinelId` | — | Expected first line of `<dataDir>/.hohe-data-sentinel`; required when `persistent` |
| `requireMountpoint` | `false` | The data directory must itself be a mount point |
| `loginPasswordBcrypt` | — (required) | bcrypt hash from `hohe hash-password` |
| `captureTokens` | `[]` | `[{"name": "...", "sha256": "<hex>"}]`, one per revocable capture token |
| `publicOrigin` | `""` | e.g. `https://hohe.example.com`; requests with another `Origin` are refused |
| `secureCookies` | `false` (`true` in `example-config.json`) | Must be `true` behind HTTPS |
| `sessionDays` | `90` | Sliding session lifetime, 1–400 |

Changing `loginPasswordBcrypt` ends every session at the next start.

## Health Check

- `GET /healthz` returns `200` when the model and store answer, for example:

  ```json
  {"ok":true,"serverPlannerDay":"2026-11-08","lastRolled":"2026-11-08","rolloverCurrent":true,
   "openConflicts":0,"plannerTimeZone":"America/New_York","rollover":"03:00",
   "plannerDayStart":"2026-11-08T08:00:00Z","plannerSettingsValid":true}
  ```

- **Planner timing**, for monitors that judge rollover without knowing the settings:
  - `plannerTimeZone` and `rollover` are the settings in force. They are editable in Settings,
    so a monitor must read them here rather than assume `America/New_York` `03:00`.
  - `plannerDayStart` is the instant (RFC 3339, UTC) the current planner day began. It is
    computed with the same function as the planner day itself, so it follows DST: 03:00 New
    York is `08:00Z` in winter and `07:00Z` in summer. On a night where the rollover's wall
    time does not exist, it is the first instant the day can begin.
  - `rolloverCurrent:false` with `serverPlannerDay` already advanced means the day has begun
    but its rollover has not run yet. The live ticker runs every minute, so this is normal
    for up to a minute after `plannerDayStart` and a failure well after it. The grace period
    is the monitor's to choose; `/healthz` never runs a rollover itself.
  - `plannerSettingsValid:false` means the stored time zone or rollover is unusable and the
    defaults are in force.
- The image `HEALTHCHECK` runs `/hohe healthcheck`, which requires that answer (exit `0`),
  every 30 s with 3 retries.

## Monitoring

**Not yet established for a deployment** (outstanding under POE-72). The signals the image
offers:

| Signal | Detail |
| --- | --- |
| Health | `GET /healthz` → `"ok":true`; `rolloverCurrent:false` long after `plannerDayStart` means rollover is stuck |
| Start marker | log line `"msg":"listening"` with version, commit and `persistent` |
| Rollover | `"msg":"rollover"` with the days processed, after each rollover or catch-up |
| Conflicts | `openConflicts` in `/healthz` |
| Exit codes | `0` clean shutdown; `1` any error, including a bad `config.json` or a storage-guard refusal; `2` usage error |

HOHE is a long-running service, not a job, so it has no completion marker. A silent failure
looks like a healthy `/healthz` while clients stay at "N changes waiting to sync". Check the
reverse proxy's log for `POST /api/sync` answers.

## Version Verification

```bash
docker run --rm ghcr.io/kevinpinscoe/hohe@sha256:<digest> --version   # <commit> <commit>
curl -s http://127.0.0.1:8080/version                                 # {"version":"<commit>",...}
```

The PWA shows its own version in the footer and Settings, and the server's version in
Settings.

## Upgrade, Rollback and Recovery

- **Upgrade:** take and verify a snapshot (below), set `HOHE_IMAGE` to the new
  `app-sha-<commit>@sha256:<digest>`, then `docker compose up -d`. Data persists in `/data`.
  Clients keep their queue across the restart, and installed apps offer **Update now**
  without reloading by themselves.
- **Rollback:** set `HOHE_IMAGE` back to the previous digest and `docker compose up -d`. If
  the newer version changed the data, restore the pre-upgrade snapshot as well.
- **Recovery** from a damaged database: restore the latest verified snapshot (below).

## Logs

JSON lines on stdout: `docker compose logs -f hohe`. Task text never appears in logs.

## Backup, Restore and Restore Testing

**Backup jobs are not yet deployed** (outstanding under POE-72: daily snapshots, 7 days kept
on web1, pulled to the FLDW at `/home/backups/hohe/`, 30 days plus four monthly LTR points).
The image provides the tools:

The destination directory must already exist and be writable by uid `65532`. The image has
no shell, so create it on the host (for example `data/snapshots`). Tested 2026-11-08 against a
local build: snapshot and verify succeed, and a missing directory fails with exit `1`.

```bash
# A consistent online snapshot (VACUUM INTO), verified; it never overwrites a file.
docker compose exec hohe /hohe snapshot --config /config/config.json --out /data/snapshots/hohe-<UTC>.sqlite3
docker compose exec hohe /hohe verify-snapshot /data/snapshots/hohe-<UTC>.sqlite3   # integrity and counts
```

Both print the snapshot's JSON summary, including `createdAt`: when it was taken (RFC 3339,
UTC, the instant just before `VACUUM INTO` began). It is stored **inside** the snapshot, in a
one-row `snapshot_meta` table, so copying, pulling or verifying an old snapshot reports its
real age, never the time of the copy or the check. A file's modification time is not
evidence of a snapshot's age. A snapshot made before this field existed verifies with an
empty `createdAt`, which a monitor must treat as unknown, not fresh. A database restored from
a snapshot keeps the table harmlessly, and its next snapshot replaces it.

**Restore**:

1. `docker compose stop hohe`.
2. Move `hohe.sqlite3`, `hohe.sqlite3-wal` and `hohe.sqlite3-shm` aside.
3. Copy the verified snapshot in as `hohe.sqlite3`, owned by `65532:65532`.
4. `docker compose start hohe`.
5. Check: `/healthz` answers `ok`, and the counts from `verify-snapshot` match what the app
   shows. `sessions.sqlite3` is not part of the snapshot, so devices log in again.

**Restore verification was demonstrated on 2026-11-08** with image `app-sha-249b481`, using
disposable instances only:

- An off-host copy of a web1 snapshot was restored into a fresh instance: a new data directory
  from `init-data`, the snapshot as `hohe.sqlite3`, and a temporary password. `/healthz`
  answered `ok`, login worked, and the export's task, placement and event counts equalled
  `verify-snapshot`'s.
- Round trip: tasks were captured into that instance, snapshotted with `hohe snapshot`, and
  restored into a second instance. Its `/api/export` equalled the first instance's exactly (state
  and history, apart from `exportedAt`).

Replacing the database of a live instance (steps 1–4 above) has not been exercised. It is
needed only for a real recovery. The repeatable test is `backup-hohe/restore-test.sh` in the
operator's host-administration repository.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| Exits at start | `docker compose logs hohe`: a config error, or a storage-guard refusal (wrong or missing sentinel, not a mount point) |
| `permission denied` under `/data` | The data directory must be writable by uid `65532` |
| Login refused with "too many attempts" | Five failures lock logins for 15 minutes |
| Every request refused "cross-origin" | `publicOrigin` must match the site's origin exactly |
| PWA will not install or persist | It must be served over HTTPS with a trusted certificate |
| Changes stay "waiting to sync" | The Sync page shows the reason. Check that `POST /api/sync` reaches the server |

The image is distroless (no shell). To inspect it, run the binary's subcommands
(`--version`, `healthcheck`, `verify-snapshot`) or use a debug sidecar.

## Security Notes

- Runs as `nonroot`, with a read-only root filesystem, all capabilities dropped and
  `no-new-privileges` in `compose.yml`.
- Single-user login with an `HttpOnly`, `SameSite=Strict` session cookie (`__Host-` prefixed
  when `secureCookies`). Only token hashes are stored. Logins are rate limited.
- State-changing requests need `X-HOHE-Client: 1` and a matching `Origin`. Responses carry a
  strict Content-Security-Policy, `nosniff`, `no-referrer` and `frame-ancestors 'none'`.
- Capture tokens are separate and revocable: remove the token's entry from `captureTokens` and
  restart.

## Supply-Chain Attestations

Every published digest carries an SPDX SBOM and SLSA provenance (`mode=max`) as registry
attestations, and a keyless Cosign signature from the workflow. A Grype gate blocks the push
of an image with high or critical CVEs.

```bash
REF=ghcr.io/kevinpinscoe/hohe@sha256:<digest>
docker buildx imagetools inspect "$REF" --format '{{ json .SBOM }}'        # SBOM
docker buildx imagetools inspect "$REF" --format '{{ json .Provenance }}'  # provenance
cosign verify "$REF" \
  --certificate-identity-regexp '^https://github.com/kevinpinscoe/hohe/\.github/workflows/app-image\.yml@refs/heads/main$' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com
grype "$REF"                                                                # known CVEs
```

**SBOM blind spots for this image:** the final stage is a static binary on distroless, so the
Go modules come from the build-stage SBOM, and the client's npm dependencies (bundled into
the binary's embedded files) come from the client-stage SBOM. Both are in
`AdditionalSPDXs`, not the final-stage document. The CVE gate scans `linux/amd64` only, so an
`arm64`-only difference is not gated.

**Rebuild policy:** an image is rebuilt on every change to `server/`, `web/` or the
`Dockerfile`, and can be rebuilt on demand (`workflow_dispatch`) for a base-image or Go
security update.

## Automation Reference

This repository does not carry an `AGENTS.md` (KDA-31). What an agent needs is above:

- start, stop and restart: `docker compose up -d` / `down` / `restart hohe`;
- health: `curl -s http://127.0.0.1:8080/healthz`;
- logs, version, and a non-interactive upgrade: set `HOHE_IMAGE`, then
  `docker compose up -d`;
- snapshot and verification: `hohe snapshot` / `hohe verify-snapshot`;
- the SBOM, provenance, signature and CVE commands.

An agent never handles the login password or a capture token. It sees only their hashes in
`config.json`.

## Uninstall

`./uninstall.sh` stops and removes the container. `config.json` and the data directory are
kept. Remove them only after taking and verifying a snapshot.

## Subdirectory Runbooks

- [spike/RUNBOOK.md](spike/RUNBOOK.md): the Phase 2 technical spike (synthetic, in-memory),
  until it is retired.

## Related Documentation

- [README.md](README.md): what HOHE is, and how to develop and test it.
- [server/README.md](server/README.md): the API, operations, configuration and data files.
