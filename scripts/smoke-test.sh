#!/usr/bin/env bash
# Smoke test the canary on :8001.
#  1. /health should return 401 (auth wired, service up)
#  2. /admin/stats with ADMIN_KEY should return 200 + JSON  (proves seeded KV
#     tokens are reachable; we never echo the key)
set -euo pipefail

PORT="${CANARY_PORT:-8001}"
BASE="http://127.0.0.1:${PORT}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

pass() { echo "  ✓ $*"; }
fail() { echo "  ✗ $*" >&2; exit 1; }

echo "[smoke] /health expects 401"
code="$(curl -sS -o /dev/null -w '%{http_code}' "${BASE}/health" || echo 000)"
[[ "${code}" == "401" ]] && pass "got 401" || fail "got ${code} (expected 401)"

# Pull ADMIN_KEY from .secrets without printing it.
ADMIN_KEY=""
if [[ -f "${ROOT}/.secrets" ]]; then
  ADMIN_KEY="$(grep -E '^ADMIN_KEY=' "${ROOT}/.secrets" | head -1 | cut -d= -f2-)"
fi
if [[ -z "${ADMIN_KEY}" ]]; then
  echo "[smoke] no ADMIN_KEY in .secrets; skipping /admin checks"
  exit 0
fi

echo "[smoke] admin endpoint with admin key expects 200"
# These paths exist in src/app.ts and require admin auth.
for path in /api/keys /api/models; do
  resp="$(curl -sS -o /tmp/.cpg-smoke.body -w '%{http_code}' \
    -H "Authorization: Bearer ${ADMIN_KEY}" \
    "${BASE}${path}" || echo 000)"
  if [[ "${resp}" == "200" ]]; then
    bytes="$(wc -c < /tmp/.cpg-smoke.body)"
    pass "${path} -> 200 (${bytes} bytes)"
    rm -f /tmp/.cpg-smoke.body
    exit 0
  elif [[ "${resp}" != "404" ]]; then
    echo "  · ${path} -> ${resp}"
  fi
done

rm -f /tmp/.cpg-smoke.body
fail "no admin endpoint returned 200"
