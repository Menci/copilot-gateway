# syntax=docker/dockerfile:1.7
# Multi-stage Dockerfile for copilot-gateway (Deno 2.7.12 + Hono + Deno.Kv).
# Builder warms the dep cache; final image is alpine-based for size.

ARG DENO_VERSION=2.7.12

# ---------- builder ----------
FROM denoland/deno:alpine-${DENO_VERSION} AS builder

WORKDIR /app

# Lockfile + manifest first for layer caching, then sources.
COPY deno.json deno.lock ./
COPY main.ts ./
COPY src ./src
COPY migrations ./migrations

# Pre-warm dependency cache. Done as root (alpine image starts as root).
RUN deno cache --unstable-kv main.ts

# ---------- final ----------
FROM denoland/deno:alpine-${DENO_VERSION}

WORKDIR /app

# Bring in cached deps + source from builder.
COPY --from=builder /deno-dir /deno-dir
COPY --from=builder /app /app

# Data dir for Deno.Kv. Owned by the bundled non-root deno user (uid 1000).
RUN mkdir -p /data && chown -R deno:deno /data /app /deno-dir

USER deno

ENV KV_PATH=/data/kv.sqlite3 \
    PORT=8000 \
    DENO_DIR=/deno-dir

EXPOSE 8000

# /health returns 401 when auth is enforced (proves both liveness AND that
# the auth middleware is wired). 200 also accepted for future-proofing.
HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=5 \
  CMD wget -q -O /dev/null --server-response http://127.0.0.1:8000/health 2>&1 \
      | grep -E "HTTP/.* (200|401)" >/dev/null || exit 1

ENTRYPOINT ["deno", "run", \
  "--allow-net", "--allow-env", \
  "--allow-read=/data", "--allow-write=/data", \
  "--unstable-kv", "main.ts"]
