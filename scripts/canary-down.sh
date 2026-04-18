#!/usr/bin/env bash
# Tear down the canary container and its data volume.
# Safe to run repeatedly.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${ROOT}"

echo "[canary-down] docker compose down (with volumes)"
sudo docker compose down -v --remove-orphans 2>/dev/null || true

# Belt + suspenders: remove the named volume even if compose missed it.
if sudo docker volume inspect cpg-canary-data >/dev/null 2>&1; then
  sudo docker volume rm cpg-canary-data >/dev/null
  echo "[canary-down] removed volume cpg-canary-data"
fi

# Wipe the local snapshot — it contains real tokens.
if [[ -d .canary-data ]]; then
  rm -rf .canary-data
  echo "[canary-down] wiped .canary-data/"
fi

echo "[canary-down] done"
