#!/usr/bin/env bash
# Install the HOHE application with Docker Compose.
# Usage: HOHE_IMAGE=ghcr.io/kevinpinscoe/hohe:app-sha-<commit>@sha256:<digest> ./install.sh
#
# Prepares ./config.json (from example-config.json) and ./data (owned by the image's nonroot
# uid 65532, with a storage-guard sentinel), then prints the remaining manual steps. It never
# writes a password: run `hohe hash-password` yourself and put only the hash in config.json.
set -euo pipefail
cd "$(dirname "$0")"
IMAGE="${HOHE_IMAGE:?set HOHE_IMAGE to ghcr.io/kevinpinscoe/hohe:app-sha-<commit>@sha256:<digest>}"
DATA="${HOHE_DATA_DIR:-./data}"
command -v docker >/dev/null || { echo "docker is required" >&2; exit 1; }
case "$IMAGE" in *@sha256:*) ;; *) echo "HOHE_IMAGE must be pinned to a digest (…@sha256:…)" >&2; exit 1 ;; esac

echo "Pulling ${IMAGE}…"
docker pull "$IMAGE"
if [ ! -f config.json ]; then
  cp example-config.json config.json
  echo "Created config.json from example-config.json. Fill in loginPasswordBcrypt and sentinelId."
fi
if [ ! -e "$DATA" ]; then
  mkdir -p "$DATA"
  id="hohe-$(date -u +%Y%m%dT%H%M%SZ)"
  docker run --rm --user 0 -v "$(realpath "$DATA")":/data "$IMAGE" init-data --dir /data --sentinel-id "$id"
  echo "Created $DATA with sentinel id $id: put it in config.json as sentinelId."
  echo "Make $DATA writable by uid 65532, e.g.: sudo chown -R 65532:65532 $DATA"
fi
cat <<EOS
Next:
  Hash:    printf '%s\n' '<a password of 12+ characters>' | docker run --rm -i $IMAGE hash-password
  Start:   HOHE_IMAGE=$IMAGE docker compose up -d
  Health:  curl -s http://127.0.0.1:\${HOST_PORT:-8080}/healthz   (expect "ok":true)
  Version: docker run --rm $IMAGE --version
EOS
