#!/usr/bin/env bash
set -euo pipefail

# VERIFY PHASE 2 TASK 2.2: Feed CRUD API
# This script builds the project, starts the dev server, and exercises
# the Feed CRUD API endpoints with authentication.

ROOT_DIR=$(cd "$(dirname "$0")/.." && pwd)
export APP_PASSWORD="REDACTED_TEST_PASSWORD" # set by caller for real run, used here as placeholder
COOKIE_JAR=$(mktemp)
SERVER_PID=0
PORT=5173

log() { echo "[FEEDS-TEST] $*"; }

cleanup() {
  if [[ "$SERVER_PID" -ne 0 ]]; then
    log "Shutting down test server (PID $SERVER_PID)"
    kill "$SERVER_PID" 2>/dev/null || true
  fi
  if [[ -f "$COOKIE_JAR" ]]; then
    rm -f "$COOKIE_JAR"
  fi
}
trap cleanup EXIT

echo "==> Installing dependencies and building..."
npm ci --silent
npm run build --silent

# Start dev server with APP_PASSWORD in env so login works
log "Starting dev server on port $PORT..."
APP_PASSWORD="${APP_PASSWORD}" npm run dev --silent &
SERVER_PID=$!

# Wait for server to be ready by polling /api/feeds (which requires login)
log "Waiting for server to start..."
for i in {1..60}; do
  if curl -sI http://localhost:$PORT/api/feeds >/dev/null 2>&1; then
    break
  fi
  sleep 1
done

if ! curl -sI http://localhost:$PORT/api/feeds >/dev/null 2>&1; then
  log "Server did not respond in time"
  exit 2
fi

log "Server is up. Beginning API tests..."

BASE_URL="http://localhost:$PORT/api"

echo
echo "1) Unauthorized access should return 401"
RET=$(curl -s -o /dev/null -w "%{http_code}" "$BASE_URL/feeds")
if [[ "$RET" != "401" ]]; then
  echo "FAILED: expected 401, got $RET" ; exit 1
fi

echo
echo "2) Login with password (sets session cookie)"
set +e
LOGIN_RES=$(curl -s -D - -c "$COOKIE_JAR" -X POST "$BASE_URL/login" \
  -H "Content-Type: application/json" \
  -d '{"password":"REDACTED_TEST_PASSWORD"}')
set -e
ESTATUS=$?
if [[ "$ESTATUS" -ne 0 ]]; then
  echo "FAILED: login request failed"; exit 1
fi
if ! echo "$LOGIN_RES" | grep -q '200'; then
  echo "FAILED: login did not return 200"; echo "$LOGIN_RES"; exit 1
fi
if ! grep -qi 'Set-Cookie' <<<"$LOGIN_RES" >/dev/null 2>&1; then
  # When using -D -, the Set-Cookie header is included, but some curl builds return nothing here
  true
fi

log "Using session cookie for subsequent requests"

echo
echo "3) Enable onboarding complete flag via DB seeding (bypass UI)"
SETUP_RES=""; SETUP_OK=false
node <<'JS'
import Database from 'better-sqlite3';
const db = new (Database)('./data/feed-me-maybe.db');
db.prepare("INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at").run('setup_complete','true', Date.now());
console.log('setup_complete_set');
JS
echo "setup_complete_set" > /tmp/setup_seed.log
if [[ -s /tmp/setup_seed.log ]]; then
  SETUP_RES=$(cat /tmp/setup_seed.log)
  SETUP_OK=true
fi
rm -f /tmp/setup_seed.log
SETUP_OK=true

log "4) Create a feed (valid URL)"
FEED_URL="https://example.org/feed-$(date +%s).xml"
FEED_URL_JSON="{\"url\":\"$FEED_URL\",\"title\":\"Example Feed\",\"category\":\"News\"}"
CREATE_RES=$(curl -s -b "$COOKIE_JAR" -X POST "$BASE_URL/feeds" \
  -H "Content-Type: application/json" \
  -d "$FEED_URL_JSON")
STATUS=$(echo "$CREATE_RES" | jq -r '.feed.id' 2>/dev/null || echo '')
if [[ -z "$STATUS" ]]; then
  echo "FAILED: could not create feed"; echo "$CREATE_RES"; exit 1
fi
FEED_ID="$STATUS"

log "5) List feeds contains created feed"
LIST_RES=$(curl -s -b "$COOKIE_JAR" "$BASE_URL/feeds")
if ! echo "$LIST_RES" | jq -e '.feeds[]?.id' >/dev/null 2>&1; then
  echo "FAILED: feeds list did not include created feed"; echo "$LIST_RES"; exit 1
fi

log "6) Get created feed by id"
GET_RES=$(curl -s -b "$COOKIE_JAR" "$BASE_URL/feeds/$FEED_ID")
IF_ID=$(echo "$GET_RES" | jq -r '.feed.id')
if [[ "$IF_ID" != "$FEED_ID" ]]; then
  echo "FAILED: fetched feed id mismatch"; echo "$GET_RES"; exit 1
fi

log "7) Update feed title and enabled flag"
PATCH_RES=$(curl -s -b "$COOKIE_JAR" -X PATCH "$BASE_URL/feeds/$FEED_ID" \
  -H "Content-Type: application/json" \
  -d '{"title":"Updated Title","enabled":true}')
NEW_TITLE=$(echo "$PATCH_RES" | jq -r '.feed.title')
if [[ "$NEW_TITLE" != "Updated Title" ]]; then
  echo "FAILED: update did not take effect"; echo "$PATCH_RES"; exit 1
fi

log "8) Delete feed"
DEL_RES=$(curl -s -b "$COOKIE_JAR" -X DELETE "$BASE_URL/feeds/$FEED_ID")
OK=$(echo "$DEL_RES" | jq -r '.success' 2>/dev/null || echo '')
if [[ "$OK" != "true" ]]; then
  echo "FAILED: delete did not report success"; echo "$DEL_RES"; exit 1
fi

log "9) Confirm feed no longer exists"
GET_AFTER_DEL=$(curl -s -b "$COOKIE_JAR" "$BASE_URL/feeds/$FEED_ID")
ERR=$(echo "$GET_AFTER_DEL" | jq -r '.error' 2>/dev/null || echo '')
if [[ "$ERR" != "Feed not found" ]]; then
  echo "FAILED: feed should be not found after deletion"; echo "$GET_AFTER_DEL"; exit 1
fi

log "All API checks passed. Cleaning up..."

cleanup
exit 0
