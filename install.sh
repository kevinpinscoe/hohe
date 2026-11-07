#!/usr/bin/env bash
# Install the HOHE Phase 2 spike locally with Docker Compose (synthetic data only).
# Usage: HOHE_IMAGE=ghcr.io/kevinpinscoe/hohe:sha-<commit>@sha256:<digest> ./install.sh
set -euo pipefail
cd "$(dirname "$0")"
IMAGE="${HOHE_IMAGE:-ghcr.io/kevinpinscoe/hohe}"

command -v docker >/dev/null || { echo "docker is required" >&2; exit 1; }
echo "Pulling ${IMAGE}..."
docker pull "$IMAGE"
if [ ! -f config.json ]; then
  cp example-config.json config.json
  echo "Created config.json from example-config.json."
fi
echo "Start:   HOHE_IMAGE=${IMAGE} HOST_PORT=8080 docker compose up -d"
echo "Health:  curl -s http://127.0.0.1:8080/healthz   (expect: ok)"
echo "Version: docker run --rm ${IMAGE} --version"
echo "Pin:     docker inspect --format '{{index .RepoDigests 0}}' ${IMAGE}"
