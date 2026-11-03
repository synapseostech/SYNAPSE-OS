#!/usr/bin/env bash
# Disposable Supabase stack for the database-backed pharmacy proof suites.
#
# PREPARED ONLY — this script has not been executed. Running it provisions
# containers and DROPs the public schema of the stack it starts. It refuses to
# run without an explicit, per-invocation opt-in:
#
#   SYNAPSE_PHARM_DB_HARNESS=1 bash scripts/db-tests/run-pharmacy-db-harness.sh [suites...]
#
# Suites (default: all): refund rls concurrency reconciliation
#
#   refund          reverse_pharmacy_sale / adjust_pharmacy_batch_stock behaviour
#   rls             tenant isolation under a real signed-in user JWT
#   concurrency     last-unit oversell and concurrent refunds through PostgREST
#   reconciliation  accounting/inventory evidence check (db:reconciliation:check)
#
# What it does, and why in this order:
#   1. Refuses if any Supabase container is already running, so a developer's
#      local database is never touched.
#   2. Starts a stack from a throwaway workdir with its own project_id, so the
#      containers and volumes are separate from the repository's stack.
#   3. Applies the canonical snapshot (scripts/db-reset-fresh.sh), then every
#      migration after SNAPSHOT_CUTOFF, exactly as CI's db-acceptance job does.
#      The historical archive cannot be replayed from an empty database, which
#      is why the snapshot is the base.
#   4. Asserts the function ACL surface, then exports the local API URL and keys.
#      The harness refuses any API URL that is not loopback.
#   5. Runs the selected suites with SUPABASE_URL / SERVICE_ROLE_KEY / ANON_KEY.
#   6. Stops the stack with --no-backup and deletes the temporary workdir.
#
# It never connects to a remote project: SUPABASE_ACCESS_TOKEN / SUPABASE_DB_URL
# and the usual PG*/DATABASE_URL overrides are cleared before anything starts.
set -euo pipefail
cd "${BASH_SOURCE[0]%/*}/../.."
# shellcheck source=lib/supabase-preflight.sh
. scripts/db-tests/lib/supabase-preflight.sh

if [ "${SYNAPSE_PHARM_DB_HARNESS:-}" != "1" ]; then
  cat >&2 <<'MSG'
REFUSED: this provisions a disposable Supabase stack and drops the public schema
inside it. It is not part of the release gate and must be authorised per run:

  SYNAPSE_PHARM_DB_HARNESS=1 bash scripts/db-tests/run-pharmacy-db-harness.sh

Nothing was started and no database was touched.
MSG
  exit 2
fi

missing_tools=()
for tool in psql pg_isready supabase npm; do
  command -v "$tool" >/dev/null 2>&1 || missing_tools+=("$tool")
done
if [ ${#missing_tools[@]} -gt 0 ]; then
  echo "CANNOT RUN: missing tool(s): ${missing_tools[*]}" >&2
  echo "No stack was started and no database was touched." >&2
  exit 2
fi

# Docker is the one prerequisite with several distinct failure modes, and the
# wrong advice (chmod, usermod) on the wrong one burns an operator's afternoon.
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
if docker ps --format '{{.Names}}' | grep -q '^supabase_'; then
  echo "REFUSED: a Supabase stack is already running:" >&2
  docker ps --format '  {{.Names}}' | grep '^  supabase_' >&2 || true
  echo "Stop it first (supabase stop). The harness will not provision beside it." >&2
  exit 2
fi

# Nothing may redirect the client at a real project.
unset DATABASE_URL DIRECT_DATABASE_URL SUPABASE_DB_URL PGURI PGSERVICE PGSERVICEFILE \
      PGHOST PGHOSTADDR PGPORT PGUSER PGDATABASE PGOPTIONS \
      PGSSLMODE PGREQUIRESSL PGSSLROOTCERT PGSSLCRL \
      SUPABASE_ACCESS_TOKEN SUPABASE_URL NEXT_PUBLIC_SUPABASE_URL \
      SUPABASE_SERVICE_ROLE_KEY NEXT_PUBLIC_SUPABASE_ANON_KEY 2>/dev/null || true

SUITES=("$@")
if [ ${#SUITES[@]} -eq 0 ]; then
  SUITES=(refund rls concurrency reconciliation)
fi
for suite in "${SUITES[@]}"; do
  case "$suite" in
    refund|rls|concurrency|reconciliation) ;;
    *)
      echo "unknown suite: $suite (expected refund, rls, concurrency or reconciliation)" >&2
      exit 2
      ;;
  esac
done

WORK="$(mktemp -d "${TMPDIR:-/tmp}/synapse-pharm-harness.XXXXXX")"
PROJECT_ID="synapse-pharm-harness-$$"
STARTED=false

cleanup() {
  if [ "$STARTED" = true ]; then
    (cd "$WORK" && supabase stop --no-backup) >/dev/null 2>&1 || true
  fi
  rm -rf "$WORK"
}
trap cleanup EXIT

mkdir -p "$WORK/supabase"
# Separate project_id => separate containers and volumes. The developer's
# supabase volume is never opened by this stack.
sed "s/^project_id = .*/project_id = \"$PROJECT_ID\"/" supabase/config.toml > "$WORK/supabase/config.toml"
if ! grep -q "project_id = \"$PROJECT_ID\"" "$WORK/supabase/config.toml"; then
  echo "FAILED: could not rewrite project_id in the temporary config." >&2
  exit 1
fi

echo "Starting disposable Supabase stack ($PROJECT_ID)"
STARTED=true
(cd "$WORK" && supabase start -x studio,imgproxy,edge-runtime,logflare,vector)

ready=false
for _ in $(seq 1 120); do
  if pg_isready -h 127.0.0.1 -p 54322 -U postgres >/dev/null 2>&1; then
    ready=true
    break
  fi
  sleep 1
done
if [ "$ready" != true ]; then
  echo "FAILED: the disposable database did not become ready on 127.0.0.1:54322 within 120s." >&2
  exit 1
fi

# Identify the engine before writing to it. Everything below is a claim about
# *this* server, and the suites are only meaningful if it is the one the stack
# just started.
psql_disposable() {
  PGPASSWORD=postgres psql -h 127.0.0.1 -p 54322 -U postgres -d postgres \
    -v ON_ERROR_STOP=1 -tAq "$@"
}

SERVER_VERSION="$(psql_disposable -c 'select version()')"
SERVER_PORT="$(psql_disposable -c "select current_setting('port')")"
if [ "$SERVER_PORT" != "54322" ]; then
  echo "REFUSED: the server answered on port ${SERVER_PORT:-<none>}, not the disposable 54322." >&2
  exit 1
fi
case "$SERVER_VERSION" in
  *emscripten*|*wasm*)
    echo "REFUSED: that is a WebAssembly PostgreSQL build ($SERVER_VERSION)." >&2
    echo "This harness exists to prove the native stack; use scripts/db-tests/run-pharmacy-db-pglite.mjs." >&2
    exit 1
    ;;
esac

# The policy suites create policies FOR ROLE authenticated/anon and the API
# suites sign in through GoTrue. If those roles are absent the policies attach
# to nothing and a "passing" isolation run would prove nothing at all.
ROLE_COUNT="$(psql_disposable -c "select count(*) from pg_roles where rolname in ('anon','authenticated','service_role')")"
if [ "$ROLE_COUNT" != "3" ]; then
  echo "REFUSED: expected the Supabase roles anon, authenticated and service_role; found $ROLE_COUNT of 3." >&2
  exit 1
fi
echo "Engine: $SERVER_VERSION"
echo "Disposable target: 127.0.0.1:54322 (project $PROJECT_ID), Supabase roles present"

echo "Bootstrapping the canonical snapshot"
PGPASSWORD=postgres bash scripts/db-reset-fresh.sh

echo "Applying post-snapshot migrations"
SNAPSHOT_CUTOFF=20260920190000
applied=0
while IFS= read -r f; do
  version="$(basename "$f" | cut -d_ -f1)"
  if [[ "$version" > "$SNAPSHOT_CUTOFF" ]]; then
    echo "  applying $(basename "$f")"
    PGPASSWORD=postgres psql -h 127.0.0.1 -p 54322 -U postgres -d postgres \
      -v ON_ERROR_STOP=1 -q -f "$f"
    applied=$((applied + 1))
  fi
done < <(ls supabase/migrations/[0-9]*_*.sql | sort)
echo "Applied $applied post-snapshot migrations"

echo "Asserting the function ACL surface"
PGPASSWORD=postgres psql -h 127.0.0.1 -p 54322 -U postgres -d postgres -v ON_ERROR_STOP=1 \
  -f scripts/db-tests/assert-function-acl-surface.sql >/dev/null

status_env="$(mktemp "${TMPDIR:-/tmp}/synapse-pharm-harness.XXXXXX.env")"
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

export SUPABASE_URL="$API_URL"
export NEXT_PUBLIC_SUPABASE_URL="$API_URL"
export SUPABASE_SERVICE_ROLE_KEY="$SERVICE_ROLE_KEY"
export NEXT_PUBLIC_SUPABASE_ANON_KEY="$ANON_KEY"
export LOCAL_API_URL="$API_URL"
export LOCAL_SERVICE_ROLE_KEY="$SERVICE_ROLE_KEY"
export CI=true

run_suite() {
  case "$1" in
    refund)
      (cd apps/pharmacy && npx vitest run lib/pharmacy-refund-rpc.integration.test.ts)
      ;;
    rls)
      (cd apps/pharmacy && npx vitest run lib/pharmacy-rls-tenant-isolation.integration.test.ts)
      ;;
    concurrency)
      # The suite binds to a provisioned "ZZ Synthetic Pharmacy" tenant.
      local existing
      existing="$(node -e '
        const { createClient } = require("@supabase/supabase-js")
        const db = createClient(process.env.LOCAL_API_URL, process.env.LOCAL_SERVICE_ROLE_KEY, { auth: { persistSession: false } })
        db.from("tenants").select("id").ilike("name", "ZZ Synthetic Pharmacy%").limit(1)
          .then(({ data }) => { process.stdout.write(data && data.length ? "yes" : "no") })
          .catch(() => process.stdout.write("no"))
      ')"
      if [ "$existing" != "yes" ]; then
        echo "Provisioning the concurrency fixture tenant"
        node scripts/pharmacy-test-setup.mjs provision --name "ZZ Synthetic Pharmacy Harness" >/dev/null
      fi
      node --test scripts/db-tests/pharmacy-concurrency.local.test.mjs
      ;;
    reconciliation)
      npm run db:reconciliation:check
      ;;
  esac
}

# One failing suite must not hide the others: record each status, run them all,
# then fail the run if any did. A partial result is still evidence.
declare -a RESULTS=()
FAILED=0
for suite in "${SUITES[@]}"; do
  echo
  echo "=== pharmacy db harness: $suite ==="
  if run_suite "$suite"; then
    RESULTS+=("PASS  $suite")
  else
    RESULTS+=("FAIL  $suite")
    FAILED=$((FAILED + 1))
  fi
done

echo
echo "=== pharmacy db harness evidence ==="
echo "engine:        $SERVER_VERSION"
echo "target:        127.0.0.1:54322 (project $PROJECT_ID, disposable)"
echo "migrations:    $applied applied after snapshot cutoff $SNAPSHOT_CUTOFF"
for line in "${RESULTS[@]}"; do echo "suite:         $line"; done
echo "evidence-kind: native PostgreSQL under a disposable Supabase stack (NOT WebAssembly)"

if [ "$FAILED" -gt 0 ]; then
  echo
  echo "Pharmacy DB harness finished with $FAILED failing suite(s)." >&2
  exit 1
fi
echo
echo "Pharmacy DB harness completed for: ${SUITES[*]}"
