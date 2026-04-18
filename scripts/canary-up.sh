#!/usr/bin/env bash
# Bring up the canary container on :8001.
#  1. build image with the requested tag
#  2. snapshot prod KV
#  3. start canary via docker compose
#  4. seed the canary volume with the KV snapshot
#  5. restart canary so it picks up the seeded KV
#  6. wait for healthcheck
#
# Usage: ./scripts/canary-up.sh [tag]   (default: dev)
set -euo pipefail

TAG="${1:-dev}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${ROOT}"

# Make sure we have an env-file; create a minimal one from .secrets if absent.
if [[ ! -f .env.docker ]]; then
  echo "[canary-up] .env.docker missing; bootstrapping from .secrets"
  if [[ -f .secrets ]]; then
    # Pull only well-known keys; never copy unknown content blindly.
    {
      grep -E '^(ADMIN_KEY|PORT)=' .secrets || true
      echo "PORT=8000"
    } | awk '!seen[$0]++' > .env.docker
  else
    cp .env.docker.example .env.docker
  fi
fi

cleanup_on_fail() {
  local rc=$?
  if (( rc != 0 )); then
    echo "[canary-up] FAILED (rc=${rc}); tearing down"
    "${ROOT}/scripts/canary-down.sh" || true
  fi
}
trap cleanup_on_fail EXIT

export CPG_TAG="${TAG}"

echo "[canary-up] building image copilot-gateway:${TAG}"
sudo docker compose build cpg-canary

echo "[canary-up] snapshotting prod KV"
"${ROOT}/scripts/snapshot-kv.sh"

echo "[canary-up] starting canary (will seed KV after volume is created)"
# First boot: create the volume by starting then stopping; we then inject
# the snapshot before the real boot.
sudo docker compose up -d cpg-canary
sleep 1
sudo docker compose stop cpg-canary >/dev/null

# Seed the volume with the KV snapshot (volume = cpg-canary-data).
SNAP="${ROOT}/.canary-data/kv.sqlite3"
if [[ -s "${SNAP}" ]]; then
  echo "[canary-up] seeding cpg-canary-data with KV snapshot"
  sudo docker run --rm \
    -v cpg-canary-data:/data \
    -v "${ROOT}/.canary-data:/snap:ro" \
    --entrypoint sh \
    alpine:3.20 -c "cp /snap/kv.sqlite3 /data/kv.sqlite3 && chown 1000:1000 /data/kv.sqlite3"
else
  echo "[canary-up] WARNING: snapshot empty; canary will start with fresh KV"
fi

echo "[canary-up] starting canary for real"
sudo docker compose up -d cpg-canary

echo -n "[canary-up] waiting for healthcheck "
for i in $(seq 1 30); do
  status="$(sudo docker inspect -f '{{.State.Health.Status}}' cpg-canary 2>/dev/null || echo unknown)"
  if [[ "${status}" == "healthy" ]]; then
    echo " healthy ✓"
    break
  fi
  echo -n "."
  sleep 2
  if (( i == 30 )); then
    echo " timed out (status=${status})"
    sudo docker logs --tail 50 cpg-canary || true
    exit 1
  fi
done

trap - EXIT
echo "[canary-up] canary up on http://localhost:8001  (tag=${TAG})"
echo "[canary-up] next: ./scripts/smoke-test.sh"
