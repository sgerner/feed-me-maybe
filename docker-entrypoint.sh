#!/bin/sh
set -eu

DB_PATH="${DATABASE_URL:-/app/data/feed-me-maybe.db}"
DB_DIR="$(dirname "$DB_PATH")"

mkdir -p "$DB_DIR"

if [ "$#" -gt 0 ]; then
  case "$1" in
    node|nodejs)
      ;;
    *.js)
      set -- node "$@"
      ;;
  esac
fi

if [ "$(id -u)" = "0" ]; then
  chown -R node:node "$DB_DIR" 2>/dev/null || true
fi

exec "$@"
