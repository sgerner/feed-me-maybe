#!/bin/sh
set -eu

DB_PATH="${DATABASE_URL:-/data/feed-me-maybe.db}"
DB_DIR="$(dirname "$DB_PATH")"

mkdir -p "$DB_DIR"

if [ "$(id -u)" = "0" ]; then
  chown -R node:node "$DB_DIR" 2>/dev/null || true
  if command -v su >/dev/null 2>&1; then
    exec su -s /bin/sh node -c 'exec "$@"' -- "$@"
  fi
  if command -v runuser >/dev/null 2>&1; then
    exec runuser -u node -- "$@"
  fi
fi

exec "$@"
