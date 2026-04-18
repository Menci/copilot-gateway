#!/usr/bin/env bash
# DOCS-ONLY stub. Promoting the canary to prod requires:
#  1. human eyeballs on smoke-test results
#  2. sudo to flip systemd off / on
#  3. a deliberate decision about KV ownership (single-writer!)
#
# We refuse to do this automatically. Below are the manual steps.
set -euo pipefail

cat <<'EOF'
[promote] This script is intentionally a no-op.

To promote a canary image to production:

  # 1. Verify the canary
  ./scripts/canary-up.sh <tag>
  ./scripts/smoke-test.sh

  # 2. Stop systemd prod (frees :8000 and the prod KV file lock).
  #    Deno.Kv is single-writer — you MUST stop it before docker takes over.
  sudo systemctl stop copilot-gateway

  # 3. Snapshot the now-quiescent prod KV one more time.
  ./scripts/snapshot-kv.sh

  # 4. Edit docker-compose.yml: uncomment the cpg-prod service block, set
  #    CPG_PROD_TAG=<tag>, seed cpg-prod-data with the snapshot the same way
  #    canary-up.sh seeds cpg-canary-data.

  # 5. Bring up prod via compose.
  CPG_PROD_TAG=<tag> sudo docker compose up -d cpg-prod

  # 6. Verify :8000 returns 401 + admin endpoints work.
  curl -i http://127.0.0.1:8000/health

  # 7. Disable systemd unit so it doesn't fight docker on reboot.
  sudo systemctl disable copilot-gateway

  # If anything looks off: ./scripts/rollback.sh

EOF
exit 0
