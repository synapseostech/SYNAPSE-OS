#!/usr/bin/env bash
# NULL-tenant operator preflight — fail-closed wrapper around
# scripts/db-tests/nulls-preflight.sql.
#
# Requires SYNAPSE_PREFLIGHT_DATABASE_URL, an authorised READ-ONLY target
# (a replica, staging database, or restored copy — never the production primary).
#
# Safety model:
#   * psql parses the connection URI itself; this script never extracts or
#     echoes a password (no shell assignment from URL contents).
#   * The linked production project ref is refused wherever it appears in the
#     URL (direct, pooler, or direct-connection host forms).
#   * A Supabase hosted host is only permitted with a named sign-off
#     (SYNAPSE_PREFLIGHT_SIGNOFF); a ref-free Supabase host is refused because
#     it cannot be shown not to be production.
#   * Read-only is enforced at connection time via
#     PGOPTIONS='-c default_transaction_read_only=on' and verified by a DO block
#     before any data is read.
#   * The log header is written from values observed from the server, and the
#     run only counts when nulls-preflight.sql emits its success marker.
set -euo pipefail
cd "${BASH_SOURCE[0]%/*}/../.."

if [[ -z "${SYNAPSE_PREFLIGHT_DATABASE_URL:-}" ]]; then
  echo "BLOCKED: SYNAPSE_PREFLIGHT_DATABASE_URL is not set." >&2
  echo "Run this only against an authorised read-only target (a replica, staging database, or a restored copy)." >&2
  exit 2
fi

URL="${SYNAPSE_PREFLIGHT_DATABASE_URL}"

# Refuse the linked production project by its reference. Matching anywhere in
# the URL covers the direct, pooler, and direct-connection host forms.
if [[ "$URL" == *"qfqakzmjatszisuqjwon"* ]]; then
  echo "REFUSED: the target URL contains the linked production project ref qfqakzmjatszisuqjwon." >&2
  exit 2
fi

# Hostname, for the Supabase policy check only. psql parses the URI itself; the
# password is never read out of the URL here.
HOST="$(node -e 'try { process.stdout.write(new URL(process.argv[1]).hostname) } catch { process.exit(1) }' "$URL" 2>/dev/null || true)"

PROJECT_REF=""
case "$HOST" in
  *.supabase.co|*.supabase.com)
    # The project ref is a 20-character token somewhere in the hostname.
    PROJECT_REF="$(grep -oE '[a-z0-9]{20}' <<<"$HOST" | head -n1 || true)"
    if [[ -z "$PROJECT_REF" ]]; then
      echo "REFUSED: target host $HOST is a Supabase hosted host but carries no project ref, so it cannot be shown not to be production." >&2
      exit 2
    fi
    if [[ -z "${SYNAPSE_PREFLIGHT_SIGNOFF:-}" ]]; then
      echo "REFUSED: target host $HOST is a Supabase hosted host (project ref $PROJECT_REF) and SYNAPSE_PREFLIGHT_SIGNOFF is not set." >&2
      echo "Set SYNAPSE_PREFLIGHT_SIGNOFF to the name of whoever authorised this read-only target." >&2
      exit 2
    fi
    ;;
esac

# Capability check last: a missing client must not mask a policy decision, and
# the fail-closed self-test must be independent of ambient tooling.
if ! command -v psql >/dev/null 2>&1; then
  echo "CANNOT PROVE: psql is not installed." >&2
  exit 2
fi

UTC_TS="$(date -u +%Y%m%dT%H%M%SZ)"
LOG="artifacts/readiness/nulls-preflight-${UTC_TS}.log"
mkdir -p artifacts/readiness

# Enforce read-only at connection time, before any statement runs.
export PGOPTIONS="-c default_transaction_read_only=on"

# First connection: verify read-only and observe the connection facts, so the
# header records reality rather than intent.
if ! OBSERVED="$(psql "$URL" -X -v ON_ERROR_STOP=1 -At \
  -c "do \$\$ begin
        if current_setting('transaction_read_only') <> 'on' then
          raise exception 'preflight aborted: session is not read-only (transaction_read_only=%)', current_setting('transaction_read_only');
        end if;
      end \$\$;" \
  -c "select current_database() || E'\\t' || current_user || E'\\t' || coalesce(inet_server_addr()::text,'') || E'\\t' || inet_server_port() || E'\\t' || current_setting('transaction_read_only');" 2>&1)"; then
  echo "preflight connection failed: $OBSERVED" >&2
  exit 1
fi

DB_NAME="$(cut -f1 <<<"$OBSERVED")"
DB_ROLE="$(cut -f2 <<<"$OBSERVED")"
DB_ADDR="$(cut -f3 <<<"$OBSERVED")"
DB_PORT="$(cut -f4 <<<"$OBSERVED")"
DB_RO="$(cut -f5 <<<"$OBSERVED")"

{
  echo "# NULL-tenant preflight"
  echo "# target_hostname: ${HOST:-<unknown>}"
  echo "# target_host: ${DB_ADDR}:${DB_PORT}"
  echo "# target_role: ${DB_ROLE}"
  echo "# target_database: ${DB_NAME}"
  echo "# transaction_read_only: ${DB_RO}"
  echo "# project_ref: ${PROJECT_REF:-<not-supabase>}"
  echo "# signoff: ${SYNAPSE_PREFLIGHT_SIGNOFF:-<none>}"
  echo "# timestamp_utc: ${UTC_TS}"
  echo "#"
} > "$LOG"

# Second connection: run the read-only preflight. Its final marker line is the
# only evidence the runner accepts as a completed run.
psql "$URL" -X -v ON_ERROR_STOP=1 -f scripts/db-tests/nulls-preflight.sql 2>&1 | tee -a "$LOG"

if ! grep -q 'NULLS_PREFLIGHT_COMPLETE' "$LOG"; then
  echo "FAILED: the preflight did not complete (success marker missing). See $LOG" >&2
  exit 1
fi

echo "NULL preflight complete; log: $LOG"
