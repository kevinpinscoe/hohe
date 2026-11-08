#!/usr/bin/env bash
# Stop and remove the HOHE container. The data directory and config.json are KEPT: they hold
# the planner's data. Remove them yourself only after taking and verifying a snapshot.
set -euo pipefail
cd "$(dirname "$0")"
docker compose down
echo "Stopped. Kept: config.json and ${HOHE_DATA_DIR:-./data}."
echo "Remove an image with: docker rmi ghcr.io/kevinpinscoe/hohe:app-sha-<commit>"
