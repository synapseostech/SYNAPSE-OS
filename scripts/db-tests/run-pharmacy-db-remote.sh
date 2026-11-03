#!/usr/bin/env bash
# Database-backed pharmacy suites against an isolated REMOTE acceptance project.
#
# There is no disposable-stack provisioning here: the target is a Supabase
# project the owner created and populated with the pharmacy migration chain.
# This script only validates the target, seeds a synthetic tenant, and runs the
# suites that survive the move from localhost to a hosted PostgREST.
#
#   SYNAPSE_PHARMACY_DB_REMOTE=1 \
#   SYNAPSE_E2E_ACCEPTANCE_PROJECT_REF=<20-char ref> \
#   SYNAPSE_E2E_SUPABASE_URL=https://<ref>.supabase.co \
#   SYNAPSE_E2E_SERVICE_ROLE_KEY=... SYNAPSE_E2E_ANON_KEY=... \
#   bash scripts/db-tests/run-pharmacy-db-remote.sh [suites...]
#
# Suites (default: refund rls concurrency)
#
#   refund       reverse_pharmacy_sale / adjust_pharmacy_batch_stock behaviour
#   rls          tenant isolation under a real signed-in user JWT
#   concurrency  last-unit oversell and concurrent ledger/till writes
#
# Not runnable on a remote project from this script:
#   reconciliation  checks local evidence files, not a database
#   purchases/suppliers/balances  the existing coverage shells into the Docker
#     stack; there is no PostgREST-only runner yet, so claiming them here would
#     be false evidence.
#
# What it guarantees:
#   - refuses production, an undeclared remote project, or a mixed target
#   - clears every alias that could silently redirect a suite elsewhere
#   - probes reachability and the required tables/RPCs before any write
#   - never prints a key, and never reads .env.local or .env.e2e-acceptance
#
# Exit codes: 0 all selected suites passed, 1 setup/validation failure,
# 2 one or more suites failed.
set -euo pipefail
cd "${BASH_SOURCE[0]%/*}/../.."

REFUSED() { echo "REFUSED: $*" >&2; exit 1; }

[ "${SYNAPSE_PHARMACY_DB_REMOTE:-}" = "1" ] ||
  REFUSED "set SYNAPSE_PHARMACY_DB_REMOTE=1 to confirm this targets a remote disposable project."

if [ -n "${SYNAPSE_PHARM_DB_HARNESS:-}${LOCAL_API_URL:-}${LOCAL_SERVICE_ROLE_KEY:-}" ]; then
  REFUSED "a local harness environment is exported. Run this in a clean shell, not one sourced from supabase status."
fi

for name in SYNAPSE_E2E_SUPABASE_URL SYNAPSE_E2E_SERVICE_ROLE_KEY SYNAPSE_E2E_ANON_KEY; do
  [ -n "${!name:-}" ] || REFUSED "$name is empty."
done

# A suite that inherits one of these can write to a project the target block
# never saw. Clear them before anything runs.
unset SUPABASE_URL NEXT_PUBLIC_SUPABASE_URL SUPABASE_SERVICE_ROLE_KEY NEXT_PUBLIC_SUPABASE_ANON_KEY \
  DATABASE_URL DIRECT_DATABASE_URL SUPABASE_DB_URL SUPABASE_ACCESS_TOKEN \
  PGHOST PGPORT PGUSER PGPASSWORD PGDATABASE PGSSLMODE
unset LOCAL_API_URL LOCAL_SERVICE_ROLE_KEY

echo "=== validating the remote acceptance target ==="
# The Bash tool has no DNS; run this from a host shell (the desktop terminal tab
# uses host networking) or the probe exits 2 with "network unreachable".
node scripts/e2e-acceptance-db-target.mjs --probe --schema || {
  status=$?
  echo >&2
  case "$status" in
    1) echo "Setup stopped: the target is not an unambiguous disposable project." >&2 ;;
    2) echo "Setup stopped: the project is unreachable (paused, deleted, or no DNS in this shell)." >&2 ;;
    3) echo "Setup stopped: the project is missing pharmacy tables or RPCs; apply the migration chain first." >&2 ;;
    *) echo "Setup stopped: target validation exited $status." >&2 ;;
  esac
  exit 1
}

TARGET_REF="$(node --input-type=module -e '
  import { resolveAcceptanceTarget } from "./scripts/e2e-acceptance-isolation.mjs"
  process.stdout.write(resolveAcceptanceTarget(process.env).projectRef)
')"

export SUPABASE_URL="$SYNAPSE_E2E_SUPABASE_URL"
export NEXT_PUBLIC_SUPABASE_URL="$SYNAPSE_E2E_SUPABASE_URL"
export SUPABASE_SERVICE_ROLE_KEY="$SYNAPSE_E2E_SERVICE_ROLE_KEY"
export NEXT_PUBLIC_SUPABASE_ANON_KEY="$SYNAPSE_E2E_ANON_KEY"
export SYNAPSE_E2E_ACCEPTANCE_PROJECT_REF="$TARGET_REF"

SUITES=()
if [ "$#" -eq 0 ]; then
  SUITES=(refund rls concurrency)
else
  for suite in "$@"; do
    case "$suite" in
      refund|rls|concurrency) SUITES+=("$suite") ;;
      reconciliation) REFUSED "reconciliation reads local evidence files; run npm run db:reconciliation:check." ;;
      purchases|suppliers|balances) REFUSED "$suite has no PostgREST runner yet; it would not be remote evidence." ;;
      *) REFUSED "unknown suite: $suite (expected refund, rls or concurrency)" ;;
    esac
  done
fi

run_suite() {
  case "$1" in
    refund)
      (cd apps/pharmacy && npx vitest run lib/pharmacy-refund-rpc.integration.test.ts)
      ;;
    rls)
      (cd apps/pharmacy && npx vitest run lib/pharmacy-rls-tenant-isolation.integration.test.ts)
      ;;
    concurrency)
      node scripts/db-tests/seed-pharmacy-acceptance-fixture.mjs
      LOCAL_API_URL="$SUPABASE_URL" LOCAL_SERVICE_ROLE_KEY="$SUPABASE_SERVICE_ROLE_KEY" \
        node --test scripts/db-tests/pharmacy-concurrency.local.test.mjs
      ;;
  esac
}

declare -a RESULTS=()
FAILED=0
for suite in "${SUITES[@]}"; do
  echo
  echo "=== remote acceptance: $suite ==="
  if run_suite "$suite"; then
    RESULTS+=("PASS  $suite")
  else
    RESULTS+=("FAIL  $suite")
    FAILED=$((FAILED + 1))
  fi
done

echo
echo "=== remote acceptance evidence ==="
echo "target:        project $TARGET_REF (declared; production refused)"
echo "engine:        not observable through PostgREST (read it in the dashboard SQL editor)"
echo "migrations:    not observable through PostgREST; --schema proves the objects exist, not their history"
echo "target check:  passed (read-only probe + required tables/RPCs) before the first write"
for line in "${RESULTS[@]}"; do echo "suite:         $line"; done
echo "evidence-kind: hosted Supabase over PostgREST (NOT local, NOT WebAssembly)"

if [ "$FAILED" -gt 0 ]; then
  echo
  echo "Remote acceptance finished with $FAILED failing suite(s)." >&2
  exit 2
fi
echo
echo "Remote acceptance completed for: ${SUITES[*]}"
