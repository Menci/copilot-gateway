#!/usr/bin/env bash
# DOCS-ONLY stub. Rolling back means returning to the systemd-managed prod.
set -euo pipefail

cat <<'EOF'
[rollback] This script is intentionally a no-op.

To roll back from a docker-managed prod to systemd:

  # 1. Stop the docker prod container so :8000 is free.
  sudo docker compose stop cpg-prod || true
  sudo docker compose rm -f cpg-prod || true

  # 2. (optional) Re-enable + start the systemd unit. It uses the original
  #    KV file under ~/.cache/deno/location_data/<hash>/ — that file was
  #    NOT modified by docker (docker had its own copy in cpg-prod-data),
  #    so any writes during the docker window are LOST unless you export
  #    them back. See RUNBOOK for the export procedure.
  sudo systemctl enable --now copilot-gateway

  # 3. Verify.
  curl -i http://127.0.0.1:8000/health   # expect 401
  systemctl status copilot-gateway

  # 4. (optional) Wipe the docker prod volume.
  sudo docker volume rm cpg-prod-data || true

EOF
exit 0
