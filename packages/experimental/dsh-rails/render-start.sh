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

# DSH rejects wildcard bind addresses. Pick a concrete local interface.
# Render routes to the container port, so any concrete address works.
HOST="127.0.0.1"
if command -v hostname >/dev/null 2>&1; then
  CANDIDATE="$(hostname -i 2>/dev/null | awk '{print $1}' || true)"
  if [ -n "$CANDIDATE" ] && [ "$CANDIDATE" != "127.0.0.1" ] && [ "$CANDIDATE" != "::1" ]; then
    HOST="$CANDIDATE"
  fi
fi

exec pnpm dsh --profile web --host "$HOST" --port "${PORT:-3080}" --no-open
