# RUNBOOK — copilot-gateway dockerization & canary

This document covers how to safely build, test, and (eventually) promote a
docker image of copilot-gateway, **without disturbing the systemd-managed
production instance on `:8000`**.

---

## TL;DR

```bash
# Build + start canary on :8001 with a snapshot of prod's KV
./scripts/canary-up.sh dev

# Verify
./scripts/smoke-test.sh
docker stats --no-stream cpg-canary
docker logs --tail 50 cpg-canary

# Tear down (always do this when you're done — canary holds real tokens)
./scripts/canary-down.sh
```

---

## Architecture

| Surface | Where it runs | KV file |
|---|---|---|
| **Prod** (live) | systemd unit `copilot-gateway.service`, user `xyg` | `~/.cache/deno/location_data/<hash>/kv.sqlite3` (Deno picks the hash) |
| **Canary** (this work) | docker container `cpg-canary` on `:8001` | `/data/kv.sqlite3` inside the container, backed by the named volume `cpg-canary-data` (a *copy* of prod's KV) |

Important: **Deno.Kv is single-writer.** You cannot have prod and canary both
writing to the same SQLite file. The canary always works against an isolated
*snapshot*, never the live prod KV.

The `KV_PATH` env var (added in `main.ts`) controls where Deno.Kv lives:

- unset → Deno's default (`~/.cache/deno/location_data/<hash>/`). Used by systemd.
- set → that exact path. Used inside the container (`/data/kv.sqlite3`).

---

## Canary lifecycle

### 1. Bring it up

```bash
./scripts/canary-up.sh <tag>     # tag defaults to "dev"
```

What this does, in order:

1. Bootstraps `.env.docker` from `.secrets` if missing (only `ADMIN_KEY` + `PORT`).
2. `docker compose build cpg-canary` → tags `copilot-gateway:<tag>`.
3. `scripts/snapshot-kv.sh`:
   - reads prod's MainPID from systemd
   - `lsof` finds the open `kv.sqlite3` fd
   - `sqlite3 .backup` → `./.canary-data/kv.sqlite3` (online, safe while prod runs)
4. Briefly starts then stops the container so the named volume `cpg-canary-data` exists.
5. Copies the snapshot into the volume (`alpine` one-shot, `chown 1000:1000`).
6. `docker compose up -d cpg-canary`.
7. Polls `docker inspect`'s health status until it goes `healthy` (or 60s timeout).

If anything fails, the script's `trap` calls `canary-down.sh`.

### 2. Verify

```bash
./scripts/smoke-test.sh
```

- `GET /health` → expects **401** (proves auth middleware is wired)
- `GET /admin/stats` (or sibling admin paths) with the admin key from `.secrets`
  → expects **200** (proves the KV snapshot is intact and tokens are reachable)

The admin key is read straight from `.secrets`, never echoed.

Other manual checks worth running:

```bash
docker stats --no-stream cpg-canary           # RSS, CPU
docker logs --tail 100 cpg-canary             # access log (Hono's logger)
docker exec cpg-canary ls -la /data           # volume contents
sqlite3 ./.canary-data/kv.sqlite3 '.tables'   # inspect snapshot from host
```

### 3. Tear down

```bash
./scripts/canary-down.sh
```

This runs `docker compose down -v --remove-orphans`, removes the
`cpg-canary-data` volume, and wipes `./.canary-data/` from the host. **Always
run this when you're done** — both the volume and the snapshot contain real
tokens.

---

## Promotion (canary → prod)

`scripts/promote.sh` is intentionally a **docs-only stub**. The actual flip is
manual because:

1. Deno.Kv is single-writer; you must `systemctl stop copilot-gateway` before
   any docker container takes over `:8000`.
2. Snapshot timing matters — take it *after* systemd is stopped, or you'll
   lose any in-flight writes.

Run `./scripts/promote.sh` to print the full step-by-step.

---

## Rollback

`scripts/rollback.sh` is also docs-only. Run it for the printed steps.

The crucial caveat: **writes that happened to the docker prod volume are NOT
mirrored back to the systemd KV file.** If you need them, dump them out of
`cpg-prod-data` (via `docker run --rm -v cpg-prod-data:/data alpine sqlite3 ...`)
*before* re-enabling systemd.

---

## Data destruction guarantee

The canary container's KV lives only in:

- the named docker volume `cpg-canary-data`, and
- the host file `./.canary-data/kv.sqlite3` (the snapshot).

`canary-down.sh` removes both. Nothing else on disk references the canary KV.
There is no tmpfs trickery; cleanup is explicit and idempotent.

---

## Known limitations / gotchas

- **Single-writer KV.** No A/B traffic split. Promotion is a hard cutover.
- **No bind-mount of the prod KV.** Always snapshot. Never `-v ~/.cache/deno/...:/data`.
- **`.dockerignore` excludes `.secrets`** — secrets live on the host only, injected via `.env.docker`.
- **`/health` returns 401 by design** when auth is enforced. The HEALTHCHECK accepts both 200 and 401 to be future-proof.
- **`deno check` shows pre-existing type errors** in `src/routes/`. They are not introduced by dockerization and the runtime works fine; they predate this branch.
- **sudo required** for `docker` commands and for `lsof` against the systemd PID. Scripts call `sudo` explicitly so the failure mode is obvious.

---

## File map

```
Dockerfile               multi-stage, alpine-based, runs as deno:1000
docker-compose.yml       cpg-canary (live), cpg-prod (commented out)
.dockerignore            keeps secrets/runtime junk out of the image
.env.docker.example      template; copy to .env.docker (gitignored)
scripts/snapshot-kv.sh   online sqlite3 .backup of the prod KV
scripts/canary-up.sh     end-to-end canary boot
scripts/canary-down.sh   tear down + wipe
scripts/smoke-test.sh    /health 401 + /admin/* 200
scripts/promote.sh       docs-only stub
scripts/rollback.sh      docs-only stub
```
