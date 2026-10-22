#!/usr/bin/env bash
# Start DeepSeek Harness (web profile) on Render with the Rails plugin patch.
set -euo pipefail

export DSH_HOME="${DSH_HOME:-/var/dsh-home}"
export DSH_RAILS_WORK_ROOT="${DSH_RAILS_WORK_ROOT:-/var/dsh-rails}"

mkdir -p "$DSH_HOME/profiles/web"
mkdir -p "$DSH_RAILS_WORK_ROOT"

# Initialize the web profile so DSH creates cordis.yml and other required files.
# The patch is applied afterwards; it is safe to overwrite cordis.patch.yml.
pnpm dsh --profile web --help >/dev/null 2>&1 || true

cp packages/experimental/dsh-rails/profile.patch.yml "$DSH_HOME/profiles/web/cordis.patch.yml"

# Render only routes to a port bound on 0.0.0.0, and DSH refuses wildcard
# binds. DSH listens on loopback; render-proxy.mjs owns 0.0.0.0:$PORT.
export PORT="${PORT:-10000}"
export DSH_UPSTREAM_PORT="${DSH_UPSTREAM_PORT:-3080}"

# Admit the public onrender.com hostname through the /api Host/Origin fence
# and print the public URL (with token) instead of the loopback one.
DSH_ARGS=(--profile web --host 127.0.0.1 --port "$DSH_UPSTREAM_PORT" --no-open)
if [ -n "${RENDER_EXTERNAL_HOSTNAME:-}" ]; then
  DSH_ARGS+=(--trusted-host "$RENDER_EXTERNAL_HOSTNAME" --public-url "https://$RENDER_EXTERNAL_HOSTNAME/")
fi

pnpm dsh "${DSH_ARGS[@]}" &
DSH_PID=$!
node packages/experimental/dsh-rails/render-proxy.mjs &
PROXY_PID=$!

trap 'kill -TERM "$DSH_PID" "$PROXY_PID" 2>/dev/null || true' TERM INT

# Exit as soon as either process stops so Render restarts the service.
while kill -0 "$DSH_PID" 2>/dev/null && kill -0 "$PROXY_PID" 2>/dev/null; do
  sleep 2
done
kill -TERM "$DSH_PID" "$PROXY_PID" 2>/dev/null || true
wait || true
exit 1
