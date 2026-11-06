#!/usr/bin/env bash
# Stop and remove the HOHE spike. The spike keeps no volumes: its data is in memory only.
set -euo pipefail
cd "$(dirname "$0")"
docker compose down
echo "Stopped. config.json kept. Remove the image with: docker rmi ghcr.io/kevinpinscoe/hohe"
