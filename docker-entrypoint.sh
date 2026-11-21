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

exec "$@"
