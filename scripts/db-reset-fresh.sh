#!/usr/bin/env bash
# Fresh-environment schema bootstrap for local Supabase.
# Does not apply historical supabase/migrations/*.sql
# Does not seed data
# Does not touch remote projects (never omit --local equivalents; this uses 127.0.0.1:54322 only)
set -euo pipefail
cd "$(dirname "$0")/.."

SCHEMA_FILE="${SYNAPSE_FRESH_SCHEMA_FILE:-supabase/bootstrap/canonical_public_schema.sql}"
PGHOST="${PGHOST:-127.0.0.1}"
PGPORT="${PGPORT:-54322}"
PGUSER="${PGUSER:-postgres}"
PGDATABASE="${PGDATABASE:-postgres}"
export PGPASSWORD="${PGPASSWORD:-postgres}"

if [[ ! -f "$SCHEMA_FILE" ]]; then
  echo "missing canonical schema: $SCHEMA_FILE" >&2
  exit 1
fi

if ! pg_isready -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" >/dev/null 2>&1; then
  echo "local Postgres is not running on ${PGHOST}:${PGPORT}. Start it with: npx supabase start" >&2
  exit 1
fi

psql -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" -d "$PGDATABASE" -v ON_ERROR_STOP=1 <<'SQL'
DROP SCHEMA IF EXISTS public CASCADE;
CREATE SCHEMA public;
GRANT USAGE ON SCHEMA public TO postgres, anon, authenticated, service_role;
GRANT ALL ON SCHEMA public TO postgres, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO postgres, anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO postgres, anon, authenticated, service_role;
-- Do NOT grant FUNCTIONS to anon here: the canonical snapshot revokes PUBLIC and
-- grants specific roles (authenticated/service_role) on each function, and an anon
-- default-privilege entry would silently survive the snapshot's REVOKE ... FROM
-- PUBLIC, leaving anon able to EXECUTE every function the snapshot creates —
-- including service_role-only RPCs such as adjust_pharmacy_batch_stock. Functions
-- that must be anon-callable carry an explicit GRANT ... TO "anon" in the snapshot.
--
-- REVOKE first: ALTER DEFAULT PRIVILEGES ... GRANT is additive, so on a reused
-- volume a previous (pre-fix) `anon` default entry persists unless it is revoked.
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON FUNCTIONS FROM anon;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON FUNCTIONS TO postgres, authenticated, service_role;
CREATE EXTENSION IF NOT EXISTS "pg_trgm" WITH SCHEMA public;
CREATE EXTENSION IF NOT EXISTS "vector" WITH SCHEMA public;
CREATE EXTENSION IF NOT EXISTS "pgcrypto" WITH SCHEMA extensions;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA extensions;
SQL

echo "Applying canonical public schema from $SCHEMA_FILE"
psql -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" -d "$PGDATABASE" -v ON_ERROR_STOP=1 -q -f "$SCHEMA_FILE"

psql -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" -d "$PGDATABASE" -v ON_ERROR_STOP=1 <<'SQL'
-- The canonical snapshot is a pg_dump of production, which itself carries
-- `ALTER DEFAULT PRIVILEGES ... GRANT ALL ON FUNCTIONS TO anon`
-- (canonical_public_schema.sql:26325). Apply it here: re-revoke anon so the
-- post-snapshot migration chain does not inherit the production default.
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON FUNCTIONS FROM anon;

DO $$
DECLARE
  required text[] := ARRAY[
    'tenants','hospitals','profiles','persons','person_identifiers','patients','encounters',
    'auth_otps','synapse_sessions','vitals','lab_orders','lab_results','clinical_prescriptions',
    'pharmacy_product_batches','billing_payments'
  ];
  missing text[] := '{}';
  t text;
  n bigint;
BEGIN
  FOREACH t IN ARRAY required LOOP
    IF to_regclass('public.' || t) IS NULL THEN
      missing := missing || t;
    END IF;
  END LOOP;
  IF cardinality(missing) > 0 THEN
    RAISE EXCEPTION 'critical tables missing: %', missing;
  END IF;

  FOREACH t IN ARRAY required LOOP
    EXECUTE format('SELECT count(*) FROM public.%I', t) INTO n;
    IF n <> 0 THEN
      RAISE EXCEPTION 'fresh bootstrap is not empty: %.count=%', t, n;
    END IF;
  END LOOP;
END $$;
SQL

echo "FRESH_BOOTSTRAP_OK"
