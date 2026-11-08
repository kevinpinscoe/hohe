# RUNBOOK — HOHE Phase 2 spike

Operational reference for the **Phase 2 technical spike** image (`spike/`). Its `compose.yml`,
`example-config.json`, `install.sh` and `uninstall.sh` live beside this file in `spike/`; run them
from there. The repository root now holds the HOHE application's ([../RUNBOOK.md](../RUNBOOK.md)). The spike is
temporary and holds **synthetic data in memory only**. It is not the HOHE application.

## Purpose and Capabilities

A single static Go binary that serves a JSON API and an embedded installable PWA, to test:

- installing the PWA to a phone's Home Screen and keeping its storage;
- capturing offline into an IndexedDB outbound queue, then replaying on reconnect;
- duplicate-safe replay (each operation has a unique id; a resend returns the original result);
- a stale same-field edit going to a conflict tray with both values;
- the planner day computed in an **explicit** time zone, independent of the browser default.

Restarting or recreating the container **loses all data**. Durable storage is not tested here.

## Prerequisites

- Docker Engine 24 or later with the Compose plugin; `linux/amd64` or `linux/arm64`.
- About 20 MB of memory at rest; the compose file limits it to 128 MB.

## Image

- Registry: `ghcr.io/kevinpinscoe/hohe`.
- Tags: `sha-<full source commit>`, one per change to `spike/` on `main`. There are no semver
  tags and no `latest`.
- Always deploy by digest. Resolve it:

```bash
docker pull ghcr.io/kevinpinscoe/hohe:sha-<commit>
docker inspect --format '{{index .RepoDigests 0}}' ghcr.io/kevinpinscoe/hohe:sha-<commit>
# use: ghcr.io/kevinpinscoe/hohe:sha-<commit>@sha256:<digest>
```

Published by `.github/workflows/spike-image.yml` after `spike-ci.yml` passes.

## Install and First Run

```bash
HOHE_IMAGE=ghcr.io/kevinpinscoe/hohe:sha-<commit>@sha256:<digest> ./install.sh
HOHE_IMAGE=ghcr.io/kevinpinscoe/hohe:sha-<commit>@sha256:<digest> HOST_PORT=8080 docker compose up -d
curl -s http://127.0.0.1:8080/healthz      # ok
```

The port binds `127.0.0.1` only. Put a TLS reverse proxy in front of it for any other client;
service workers and `navigator.storage.persist()` need HTTPS.

## Configuration

`config.json` is mounted read-only at `/config/config.json`. It is optional; every key has a
default. There are no environment variables and no secrets.

| Key | Default | Meaning |
| --- | --- | --- |
| `listen_addr` | `":8080"` | Listen address inside the container |
| `time_zone` | `"America/New_York"` | IANA zone for the planner day (server authoritative; copied by clients) |
| `rollover` | `"03:00"` | Time of day the planner day changes, `HH:MM` |
| `seed_synthetic` | `true` | Load three synthetic tasks at start |
| `allow_reset` | `false` in `example-config.json` (`true` if no file) | Enable `POST /api/admin/reset` |
| `log_level` | `"info"` | `info` or `debug` |

## Health Check

- `GET /healthz` returns `200` and `ok` when the store answers and the planner day computes;
  otherwise `503`.
- The image `HEALTHCHECK` runs `/hohe-spike --healthcheck` (exit `0` healthy) every 30 s,
  3 retries.

## Monitoring

| Signal | Detail |
| --- | --- |
| Health | `GET /healthz` → `200 ok` |
| Start marker | log line `"msg":"SERVER STARTED"` with version, time zone and `storage: in-memory, synthetic only` |
| Stop marker | `"msg":"SERVER STOPPED"` |
| Per batch | `"msg":"ops"` with the batch size, status counts and replay count — never task text |
| Exit codes | `0` clean shutdown; `1` listener or shutdown error; `2` bad configuration |

The spike is a long-running service, not a job: there is no completion marker or heartbeat. A
silent failure looks like a healthy `/healthz` with clients stuck at "N changes waiting to
sync"; check for `ops` log lines when clients are syncing.

## Version Verification

```bash
docker run --rm ghcr.io/kevinpinscoe/hohe@sha256:<digest> --version   # the source commit
curl -s http://127.0.0.1:8080/version                                 # {"version":"<commit>"}
```

The PWA shows the version in its diagnostics panel and footer.

## Upgrade, Rollback and Recovery

- **Upgrade:** set `HOHE_IMAGE` to the new `sha-<commit>@sha256:<digest>`, then
  `docker compose up -d`. Data is lost on recreation; clients keep their unsynced queue and
  replay it.
- **Rollback:** set `HOHE_IMAGE` back to the previous digest and `docker compose up -d`.
- **After a bad upgrade:** roll back as above. Nothing on disk needs repair, because there is
  no data on disk.

## Logs

JSON lines on stdout: `docker compose logs -f hohe`.

## Backup, Restore and Restore Testing

There is nothing to back up: the spike holds synthetic data in memory only, by design. Phase 3
introduces real storage with its own backup, restore and restore-test procedure.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| Container unhealthy | `docker compose logs hohe`; exit code `2` means a bad `config.json` |
| PWA will not install or persist | It must be served over HTTPS with a trusted certificate |
| Changes stay "waiting to sync" | Is "Pause sync" ticked? Does `POST /api/ops` reach the server (proxy logs)? |
| Planner day looks wrong | Diagnostics panel: compare the explicit zone's day with the server's |

The image is distroless (no shell). To inspect it, run a debug sidecar on the same network, or
run the binary with `--version` / `--healthcheck`.

## Security Notes

- Runs as `nonroot`, with a read-only root filesystem, all capabilities dropped and
  `no-new-privileges` in `compose.yml`.
- **No application login.** Anyone who can reach the port can read and change the synthetic
  data. Expose it only on an already restricted network.
- Content-Security-Policy `default-src 'self'`, `frame-ancestors 'none'`; request bodies are
  limited to 1 MiB and 500 operations per batch.

## Supply-Chain Attestations

Every published digest carries an SPDX SBOM and SLSA provenance (`mode=max`) as registry
attestations, and a keyless Cosign signature from the workflow.

```bash
REF=ghcr.io/kevinpinscoe/hohe@sha256:<digest>
docker buildx imagetools inspect "$REF" --format '{{ json .SBOM }}'        # SBOM
docker buildx imagetools inspect "$REF" --format '{{ json .Provenance }}'  # provenance
cosign verify "$REF" \
  --certificate-identity-regexp '^https://github.com/kevinpinscoe/hohe/\.github/workflows/spike-image\.yml@' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com
grype "$REF"                                                                # known CVEs
```

**SBOM blind spots for this image:** the final stage is a single static binary on distroless,
so the Go module and standard-library inventory comes from the build-stage SBOM
(`AdditionalSPDXs`), not the final-stage one. The CVE gate (Grype, high and above, blocking)
scans `linux/amd64` only; an `arm64`-only difference is not gated.

**Rebuild policy:** an image is rebuilt on every change to `spike/` and can be rebuilt on
demand (`workflow_dispatch`) for a base-image or Go security update.

## Agent Reference

This repository does not carry an `AGENTS.md`. The items an agent needs are above: start, stop
and restart (`docker compose up -d` / `down` / `restart hohe`), health (`curl -s
http://127.0.0.1:8080/healthz`), logs, version, non-interactive upgrade (set `HOHE_IMAGE`,
`docker compose up -d`), backup and restore (none), and the SBOM and CVE commands.

## Uninstall

`./uninstall.sh` stops and removes the container. Nothing persistent is left behind except
`config.json`.
