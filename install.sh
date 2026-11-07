#!/usr/bin/env sh
set -e

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"

if ! command -v node >/dev/null 2>&1; then
  echo "[ERROR] Node.js is required to install Antigravity Context Ring." >&2
  exit 1
fi

exec node "$SCRIPT_DIR/manage.mjs" install
