#!/usr/bin/env bash
# Runs the lab core-flow migration scenario on a throwaway local PostgreSQL 16.
# Needs the server binaries (apt install postgresql-16). Nothing else is touched.
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
BIN="${PG_BIN:-/usr/lib/postgresql/16/bin}"
WORK="$(mktemp -d)"; SOCK="$(mktemp -d /tmp/labpg.XXXX)"; PORT="${PG_PORT:-55439}"
trap '"$BIN/pg_ctl" -D "$WORK/data" -m immediate stop >/dev/null 2>&1 || true; rm -rf "$WORK" "$SOCK"' EXIT
"$BIN/initdb" -D "$WORK/data" -U postgres -A trust >/dev/null
"$BIN/pg_ctl" -D "$WORK/data" -o "-p $PORT -k $SOCK -c listen_addresses=''" -l "$WORK/log" -w start >/dev/null
run() { psql -h "$SOCK" -p "$PORT" -U postgres -v ON_ERROR_STOP=1 -q -X "$@"; }
run -f "$DIR/00-preamble.sql" -f "$DIR/01-stub-schema.sql"
(cd "$DIR" && run -f 03-scenario.sql)
