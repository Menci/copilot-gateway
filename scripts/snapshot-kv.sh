#!/usr/bin/env bash
# Snapshot the live prod Deno.Kv SQLite into ./.canary-data/kv.sqlite3
# using SQLite's online .backup (safe while prod is running).
#
# Locates the prod KV file by inspecting the systemd unit's main PID and
# picking the open kv.sqlite3 fd. This avoids hardcoding the hash dir.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEST_DIR="${ROOT}/.canary-data"
DEST="${DEST_DIR}/kv.sqlite3"

UNIT="${UNIT:-copilot-gateway.service}"
PID="$(systemctl show -p MainPID --value "${UNIT}" 2>/dev/null || true)"

if [[ -z "${PID}" || "${PID}" == "0" ]]; then
  echo "[snapshot-kv] cannot find PID for ${UNIT}; is it running?" >&2
  exit 1
fi

# Find the open kv.sqlite3 fd (not -shm/-wal). Needs sudo because the unit
# runs as a different user / fd visibility is restricted.
SRC="$(sudo lsof -p "${PID}" 2>/dev/null \
  | awk '/kv\.sqlite3$/ {print $NF; exit}')"

if [[ -z "${SRC}" ]]; then
  echo "[snapshot-kv] could not locate prod kv.sqlite3 via lsof" >&2
  exit 1
fi

echo "[snapshot-kv] prod KV: ${SRC}"
mkdir -p "${DEST_DIR}"
rm -f "${DEST}" "${DEST}-shm" "${DEST}-wal"

# Use SQLite's online backup. Run sqlite3 inside an alpine container so we
# don't depend on a host sqlite install. The DB lives under the prod user's
# home, so we sudo to read it; then chown the result back to ourselves.
SRC_DIR="$(dirname "${SRC}")"
SRC_BASE="$(basename "${SRC}")"
sudo docker run --rm \
  -v "${SRC_DIR}:/src" \
  -v "${DEST_DIR}:/dst" \
  alpine:3.20 sh -c "apk add --no-cache sqlite >/dev/null && sqlite3 /src/${SRC_BASE} \".backup '/dst/$(basename "${DEST}")'\""
sudo chown "$(id -u):$(id -g)" "${DEST}"

SIZE="$(stat -c %s "${DEST}")"
echo "[snapshot-kv] wrote ${DEST} (${SIZE} bytes)"
