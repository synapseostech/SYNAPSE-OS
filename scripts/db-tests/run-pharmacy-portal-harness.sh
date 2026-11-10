#!/usr/bin/env bash
# Disposable Supabase stack + a running pharmacy portal, for the browser journey.
#
# It provisions containers and DROPs the public schema of the stack it starts,
# so it refuses to run without an explicit, per-invocation opt-in:
#
#   SYNAPSE_PHARM_DB_HARNESS=1 bash scripts/db-tests/run-pharmacy-portal-harness.sh
#
# What it does, in order:
#   1. Refuses on a port conflict and clears every variable that could point a
#      client at a remote project.
#   2. Starts a throwaway Supabase stack on 55320-55327 from its own workdir.
#   3. Applies the canonical snapshot and every later migration.
#   4. Starts `next dev` on 127.0.0.1:3002 with SUPABASE_URL pointed at the
#      stack, the Tally cut-over and replay flags on, and a throwaway JWT secret.
#   5. Runs scripts/db-tests/tally-portal.local.test.mjs, which seeds a
#      synthetic tenant and admin, signs in through the real form, uploads the
#      synthetic full-history export, confirms the sequence, applies it, and
#      checks the sale and its historical cost in the profit report.
#   6. Stops the app, stops the stack with --no-backup, deletes the workdir.
#
# It never connects to a remote project. The seeded tenant is synthetic, the
# credentials are generated for the run, and nothing is printed that could be
# reused against another system.
set -euo pipefail
cd "${BASH_SOURCE[0]%/*}/../.."
# shellcheck source=lib/supabase-preflight.sh
. scripts/db-tests/lib/supabase-preflight.sh

if [ "${SYNAPSE_PHARM_DB_HARNESS:-}" != "1" ]; then
  cat >&2 <<'MSG'
REFUSED: this provisions a disposable Supabase stack, drops the public schema
inside it, and starts a dev server. It must be authorised per run:

  SYNAPSE_PHARM_DB_HARNESS=1 bash scripts/db-tests/run-pharmacy-portal-harness.sh

Nothing was started and no database was touched.
MSG
  exit 2
fi

missing_tools=()
for tool in psql pg_isready supabase npm node; do
  command -v "$tool" >/dev/null 2>&1 || missing_tools+=("$tool")
done
if [ ${#missing_tools[@]} -gt 0 ]; then
  echo "CANNOT RUN: missing tool(s): ${missing_tools[*]}" >&2
  echo "No stack was started and no database was touched." >&2
  exit 2
fi

docker_err="$(mktemp "${TMPDIR:-/tmp}/synapse-docker-info.XXXXXX")"
trap 'rm -f "$docker_err"' EXIT
if ! docker info >/dev/null 2>"$docker_err"; then
  code="$(supabase_preflight_classify "$docker_err")"
  {
    echo "CANNOT RUN: the disposable stack could not be provisioned ($code)."
    echo
    cat "$docker_err"
    echo
    supabase_preflight_explain "$code"
  } >&2
  exit 2
fi
rm -f "$docker_err"
trap - EXIT

HARNESS_API_PORT="${HARNESS_API_PORT:-55321}"
HARNESS_DB_PORT="${HARNESS_DB_PORT:-55322}"
HARNESS_SHADOW_PORT="${HARNESS_SHADOW_PORT:-55320}"
HARNESS_STUDIO_PORT="${HARNESS_STUDIO_PORT:-55323}"
HARNESS_INBUCKET_PORT="${HARNESS_INBUCKET_PORT:-55324}"
HARNESS_ANALYTICS_PORT="${HARNESS_ANALYTICS_PORT:-55327}"
PORTAL_PORT="${PORTAL_PORT:-3002}"

port_in_use() {
  (exec 3<>"/dev/tcp/127.0.0.1/$1") >/dev/null 2>&1
}
conflicts=()
for p in "$HARNESS_API_PORT" "$HARNESS_DB_PORT" "$HARNESS_SHADOW_PORT" \
         "$HARNESS_STUDIO_PORT" "$HARNESS_INBUCKET_PORT" "$HARNESS_ANALYTICS_PORT" \
         "$PORTAL_PORT"; do
  port_in_use "$p" && conflicts+=("$p")
done
if [ ${#conflicts[@]} -gt 0 ]; then
  echo "REFUSED: harness port(s) already in use: ${conflicts[*]}" >&2
  echo "Free those ports or override HARNESS_*_PORT / PORTAL_PORT." >&2
  exit 2
fi

unset DATABASE_URL DIRECT_DATABASE_URL SUPABASE_DB_URL PGURI PGSERVICE PGSERVICEFILE \
      PGHOST PGHOSTADDR PGPORT PGUSER PGDATABASE PGOPTIONS \
      PGSSLMODE PGREQUIRESSL PGSSLROOTCERT PGSSLCRL \
      SUPABASE_ACCESS_TOKEN SUPABASE_URL NEXT_PUBLIC_SUPABASE_URL \
      SUPABASE_SERVICE_ROLE_KEY NEXT_PUBLIC_SUPABASE_ANON_KEY 2>/dev/null || true

WORK="$(mktemp -d "${TMPDIR:-/tmp}/synapse-pharm-portal.XXXXXX")"
PROJECT_ID="synapse-pharm-portal-$$"
STARTED=false
APP_PID=""

cleanup() {
  if [ -n "$APP_PID" ]; then
    # `next dev` runs under npm: killing npm alone leaves the server holding the
    # port, so the whole process group goes.
    kill -- -"$APP_PID" 2>/dev/null || kill "$APP_PID" 2>/dev/null || true
    wait "$APP_PID" 2>/dev/null || true
  fi
  if [ "$STARTED" = true ]; then
    (cd "$WORK" && supabase stop --no-backup) >/dev/null 2>&1 || true
  fi
  rm -rf "$WORK"
}
trap cleanup EXIT

mkdir -p "$WORK/supabase"
sed -e "s/^project_id = .*/project_id = \"$PROJECT_ID\"/" \
    -e "s/^port = 54321$/port = $HARNESS_API_PORT/" \
    -e "s/^port = 54322$/port = $HARNESS_DB_PORT/" \
    -e "s/^shadow_port = 54320$/shadow_port = $HARNESS_SHADOW_PORT/" \
    -e "s/^port = 54323$/port = $HARNESS_STUDIO_PORT/" \
    supabase/config.toml > "$WORK/supabase/config.toml"
cat >> "$WORK/supabase/config.toml" <<CFG

[inbucket]
port = $HARNESS_INBUCKET_PORT

[analytics]
enabled = false
port = $HARNESS_ANALYTICS_PORT
CFG

echo "Starting disposable Supabase stack ($PROJECT_ID)"
HARNESS_STARTED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
STARTED=true
(cd "$WORK" && supabase start -x studio,imgproxy,edge-runtime,logflare,vector)

ready=false
for _ in $(seq 1 120); do
  if pg_isready -h 127.0.0.1 -p "$HARNESS_DB_PORT" -U postgres >/dev/null 2>&1; then
    ready=true
    break
  fi
  sleep 1
done
if [ "$ready" != true ]; then
  echo "FAILED: the disposable database did not become ready on 127.0.0.1:$HARNESS_DB_PORT within 120s." >&2
  exit 1
fi

psql_disposable() {
  PGPASSWORD=postgres psql -h 127.0.0.1 -p "$HARNESS_DB_PORT" -U postgres -d postgres \
    -v ON_ERROR_STOP=1 -tAq "$@"
}

SERVER_VERSION="$(psql_disposable -c 'select version()')"
STARTED_AFTER="$(psql_disposable -c "select pg_postmaster_start_time() > timestamptz '${HARNESS_STARTED_AT}'")"
if [ "$STARTED_AFTER" != "t" ]; then
  echo "REFUSED: the server on 127.0.0.1:$HARNESS_DB_PORT started before this harness." >&2
  exit 1
fi

ROLE_COUNT="$(psql_disposable -c "select count(*) from pg_roles where rolname in ('anon','authenticated','service_role')")"
if [ "$ROLE_COUNT" != "3" ]; then
  echo "REFUSED: expected the Supabase roles anon, authenticated and service_role; found $ROLE_COUNT of 3." >&2
  exit 1
fi
echo "Engine: $SERVER_VERSION"

echo "Bootstrapping the canonical snapshot"
PGPASSWORD=postgres PGPORT="$HARNESS_DB_PORT" bash scripts/db-reset-fresh.sh

echo "Applying post-snapshot migrations"
SNAPSHOT_CUTOFF=20260920190000
applied=0
while IFS= read -r f; do
  version="$(basename "$f" | cut -d_ -f1)"
  if [[ "$version" > "$SNAPSHOT_CUTOFF" ]]; then
    echo "  applying $(basename "$f")"
    PGPASSWORD=postgres psql -h 127.0.0.1 -p "$HARNESS_DB_PORT" -U postgres -d postgres \
      -v ON_ERROR_STOP=1 -q -f "$f"
    applied=$((applied + 1))
  fi
done < <(ls supabase/migrations/[0-9]*_*.sql | sort)
echo "Applied $applied post-snapshot migrations"

status_env="$(mktemp "${TMPDIR:-/tmp}/synapse-pharm-portal.XXXXXX.env")"
trap 'cleanup; rm -f "$status_env"' EXIT
(cd "$WORK" && supabase status -o env) > "$status_env"
set -a
# shellcheck disable=SC1090
. "$status_env"
set +a

API_URL="${API_URL:-}"
SERVICE_ROLE_KEY="${SERVICE_ROLE_KEY:-}"
ANON_KEY="${ANON_KEY:-${PUBLISHABLE_KEY:-}}"
if [ -z "$API_URL" ] || [ -z "$SERVICE_ROLE_KEY" ] || [ -z "$ANON_KEY" ]; then
  echo "FAILED: the disposable stack did not report API_URL / SERVICE_ROLE_KEY / ANON_KEY." >&2
  exit 1
fi
case "$API_URL" in
  http://127.0.0.1:*|http://localhost:*) ;;
  *)
    echo "REFUSED: the disposable stack reported a non-loopback API URL ($API_URL)." >&2
    exit 1
    ;;
esac

# Throwaway credentials for this run only. They are exported, never printed.
PORTAL_EMAIL="portal-acceptance-$$@synapseos.invalid"
PORTAL_PASSWORD="$(node -e "process.stdout.write(require('node:crypto').randomBytes(18).toString('base64url'))")"
JWT_SECRET="$(node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('hex'))")"

export SUPABASE_URL="$API_URL"
export NEXT_PUBLIC_SUPABASE_URL="$API_URL"
export SUPABASE_SERVICE_ROLE_KEY="$SERVICE_ROLE_KEY"
export NEXT_PUBLIC_SUPABASE_ANON_KEY="$ANON_KEY"
export NEXT_PUBLIC_PHARMACY_APP_URL="http://127.0.0.1:$PORTAL_PORT"
export SYNAPSE_JWT_SECRET="$JWT_SECRET"
export SYNAPSE_TALLY_CUTOVER_ENABLED="true"
export SYNAPSE_TALLY_REPLAY_ENABLED="true"
export NODE_ENV="development"
export LOCAL_API_URL="$API_URL"
export LOCAL_SERVICE_ROLE_KEY="$SERVICE_ROLE_KEY"
export LOCAL_ANON_KEY="$ANON_KEY"
export PORTAL_BASE_URL="http://127.0.0.1:$PORTAL_PORT"
export PORTAL_EMAIL
export PORTAL_PASSWORD

echo "Starting the pharmacy portal on $PORTAL_BASE_URL"
setsid npm run dev --workspace @synapse/pharmacy > "$WORK/next.log" 2>&1 &
APP_PID=$!

up=false
for _ in $(seq 1 240); do
  if ! kill -0 "$APP_PID" 2>/dev/null; then
    echo "FAILED: the portal process exited while starting. Last lines:" >&2
    tail -40 "$WORK/next.log" >&2 || true
    exit 1
  fi
  if node -e "fetch(process.argv[1]).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" \
       "$PORTAL_BASE_URL/login" 2>/dev/null; then
    up=true
    break
  fi
  sleep 1
done
if [ "$up" != true ]; then
  echo "FAILED: the portal did not answer on $PORTAL_BASE_URL/login within 240s. Last lines:" >&2
  tail -60 "$WORK/next.log" >&2 || true
  exit 1
fi

echo
echo "=== pharmacy portal harness: tally import journey ==="
if node --test scripts/db-tests/tally-portal.local.test.mjs; then
  result=0
else
  result=$?
fi

if [ "$result" -ne 0 ]; then
  # The workdir is deleted on exit; keep the server log so a failure can be read.
  cp "$WORK/next.log" "${TMPDIR:-/tmp}/synapse-portal-next.log" 2>/dev/null || true
  echo "Server log kept at ${TMPDIR:-/tmp}/synapse-portal-next.log" >&2
fi

echo
echo "=== pharmacy portal harness evidence ==="
echo "engine:     $SERVER_VERSION"
echo "target:     $API_URL (project $PROJECT_ID, disposable)"
echo "portal:     $PORTAL_BASE_URL"
echo "migrations: $applied applied after snapshot cutoff $SNAPSHOT_CUTOFF"
echo "journey:    $([ "$result" -eq 0 ] && echo PASS || echo FAIL)"
exit "$result"
