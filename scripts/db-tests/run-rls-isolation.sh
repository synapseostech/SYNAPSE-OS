#!/usr/bin/env bash
# Disposable PostgreSQL proof for the SEC-01 tenant-isolation repair.
#
# Executed and passed on a disposable PostgreSQL 16 database on 2026-10-25.
# Production remains unverified. Any claim that the repair works on production
# must be backed by a captured run against that environment.
#
# Fails closed at every step: no docker, no client tools, no published port, no
# ready server, or any assertion failure inside the SQL all exit non-zero and say
# the proof did not run. It can never be mistaken for a pass.
#
# Safety: the container listens on a random loopback port only, all inherited
# PG*/DATABASE_URL variables are cleared first so nothing can redirect the
# connection, and the SQL harness itself aborts if public.profiles already
# exists. It must not be run against a shared or production database.
set -euo pipefail
# Pure-bash dirname: the fail-closed test below runs this script with an empty
# PATH, and an external `dirname` would abort before the CANNOT PROVE message.
cd "${BASH_SOURCE[0]%/*}/../.."

if ! command -v docker >/dev/null 2>&1; then
  echo "CANNOT PROVE: docker is not installed, so the tenant-isolation repair was not verified." >&2
  exit 2
fi
for tool in psql pg_isready; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "CANNOT PROVE: $tool is not installed, so the tenant-isolation repair was not verified." >&2
    exit 2
  fi
done
if ! docker info >/dev/null 2>&1; then
  echo "CANNOT PROVE: docker exists but its daemon is not reachable." >&2
  exit 2
fi
# Pulling an image is provisioning. Do it only with explicit authorization, so a
# routine test run cannot quietly download software.
if ! docker image inspect postgres:16-alpine >/dev/null 2>&1; then
  if [ "${SYNAPSE_ALLOW_IMAGE_PULL:-}" != "1" ]; then
    echo "CANNOT PROVE: the postgres:16-alpine image is not present locally. Set SYNAPSE_ALLOW_IMAGE_PULL=1 to authorize pulling it." >&2
    exit 2
  fi
fi

migration="supabase/migrations/20261025120000_tenant_isolation_policy_repair.sql"
if [ ! -f "$migration" ]; then
  echo "CANNOT PROVE: $migration is missing, so there is nothing to apply." >&2
  exit 2
fi

# Clear anything that could point the client at a real server.
unset DATABASE_URL DIRECT_DATABASE_URL SUPABASE_DB_URL PGURI PGSERVICE \
      PGSERVICEFILE PGOPTIONS PGHOSTADDR PGSSLMODE PGREQUIRESSL PGSSLCERT \
      PGSSLKEY PGSSLROOTCERT PGSSLCRL PGKRBSRVNAME PGGSSENCMODE PGCLIENTENCODING \
      SUPAHOST DB_HOST 2>/dev/null || true

name="synapse-rls-isolation-$$"
export PGHOST=127.0.0.1 PGUSER=postgres PGDATABASE=postgres
export PGPASSWORD="$(openssl rand -hex 24)"
export PGSSLMODE=disable

cleanup() { docker rm -f "$name" >/dev/null 2>&1 || true; }
trap cleanup EXIT

docker run --name "$name" --label synapse.disposable-test=true -d \
  --network bridge \
  -e POSTGRES_PASSWORD="$PGPASSWORD" -p 127.0.0.1::5432 postgres:16-alpine >/dev/null

port_line="$(docker port "$name" 5432/tcp 2>/dev/null | head -n1 || true)"
if [ -z "$port_line" ]; then
  echo "CANNOT PROVE: docker published no port for the disposable container." >&2
  exit 2
fi
PGPORT="${port_line##*:}"
case "$PGPORT" in
  ''|*[!0-9]*)
    echo "CANNOT PROVE: could not parse a numeric host port from '${port_line}'." >&2
    exit 2
    ;;
esac
export PGPORT

ready=false
for _ in $(seq 1 60); do
  if pg_isready -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" >/dev/null 2>&1; then
    ready=true
    break
  fi
  sleep 1
done
if [ "$ready" != true ]; then
  echo "CANNOT PROVE: disposable PostgreSQL did not become ready on 127.0.0.1:${PGPORT} within 60s." >&2
  docker logs --tail 40 "$name" >&2 || true
  exit 2
fi

psql -X -v ON_ERROR_STOP=1 <<'SQL'
create role anon nologin;
create role authenticated nologin;
create role service_role nologin bypassrls;
create schema auth;
create function auth.uid() returns uuid language sql stable as
$$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
-- The telemedicine staff policies call auth.role(), so the fixture needs it too.
create function auth."role"() returns text language sql stable as
$$ select nullif(current_setting('request.jwt.claim.role', true), '') $$;
grant usage on schema auth to anon, authenticated, service_role;
grant usage on schema public to anon, authenticated, service_role;
SQL

log="$(mktemp)"
trap 'cleanup; rm -f "$log"' EXIT

# The SQL harness applies $migration itself via \i, so the file that runs is the
# tracked migration and not a copy. Capture everything: notices carry the proof
# statements, and the absent-policy notice below is asserted explicitly.
if ! psql -X -v ON_ERROR_STOP=1 -f scripts/db-tests/rls-tenant-isolation.sql 2>&1 | tee "$log"; then
  echo "FAILED: the tenant-isolation assertions failed. Output above; nothing was proven." >&2
  exit 1
fi

if ! grep -q 'RLS tenant isolation PASSED on all ten tables' "$log"; then
  echo "FAILED: the per-table isolation assertions did not run to completion." >&2
  exit 1
fi
if ! grep -q 'admin bypass reproduced' "$log"; then
  echo "FAILED: the is_admin cross-tenant demonstration did not run." >&2
  exit 1
fi
if ! grep -q 'staff-role bypass reproduced' "$log"; then
  echo "FAILED: the telemedicine staff-role demonstration did not run." >&2
  exit 1
fi
if ! grep -q 'patient intake write is unconstrained' "$log"; then
  echo "FAILED: the patient-initiated intake write demonstration did not run." >&2
  exit 1
fi
if ! grep -q 'Residual after the repair' "$log"; then
  echo "FAILED: the harness did not reach its residual-exposure summary." >&2
  exit 1
fi
if ! grep -q 'clean zero-row deny on products' "$log"; then
  echo "FAILED: the current-source anon/product assertion did not run." >&2
  exit 1
fi
if ! grep -q 'neighbouring policies untouched' "$log"; then
  echo "FAILED: the harness did not assert that neighbouring policies were left intact." >&2
  exit 1
fi
if ! grep -q 'admin policies scoped to tenant' "$log"; then
  echo "FAILED: the admin-policy scoping migration did not run to completion." >&2
  exit 1
fi
if ! grep -q 'service-role intake insert inherits tenant' "$log"; then
  echo "FAILED: the intake tenant-ownership trigger did not run to completion." >&2
  exit 1
fi

echo "RLS tenant-isolation proof PASSED on a disposable database"
