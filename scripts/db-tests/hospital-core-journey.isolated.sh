#!/usr/bin/env bash
# Feature-contract test for supabase/migrations/20261120140000_hospital_core_journey.sql
# on a disposable PostgreSQL 16 (Docker, or local binaries when Docker cannot
# fetch the image). It builds only the columns the migration reads and writes
# (shapes copied from production, read-only introspection 2026-11-20), applies
# the migration verbatim twice (idempotency) and checks the rules:
#   staff context, patient search, payment race/idempotency/receipts,
#   insurance cover + draft claim, admit/discharge with bed locking, grants,
#   tenant isolation.
#
# Run: bash scripts/db-tests/hospital-core-journey.isolated.sh
set -euo pipefail
cd "$(dirname "$0")/../.."
name="synapse-hospital-core-test-$$"
export PGHOST=127.0.0.1 PGUSER=postgres PGDATABASE=postgres
export PGPASSWORD="$(openssl rand -hex 24)"
datadir=""
pgbin=""
cleanup() {
  docker rm -f "$name" >/dev/null 2>&1 || true
  if [ -n "$datadir" ]; then
    "$pgbin/pg_ctl" -D "$datadir" -m immediate stop >/dev/null 2>&1 || true
    rm -rf "$(dirname "$datadir")"
  fi
}
trap cleanup EXIT

if docker run --name "$name" --label synapse.disposable-test=true -d \
    -e POSTGRES_PASSWORD="$PGPASSWORD" -p 127.0.0.1::5432 postgres:16-alpine >/dev/null 2>&1; then
  export PGPORT="$(docker port "$name" 5432/tcp | awk -F: '{print $NF}')"
else
  pgbin="$(ls -d /usr/lib/postgresql/*/bin 2>/dev/null | sort -V | tail -1)"
  [ -x "$pgbin/initdb" ] || { echo "Neither Docker nor local PostgreSQL binaries are available" >&2; exit 1; }
  root="$(mktemp -d)"
  pwfile="$root/pw"; printf '%s' "$PGPASSWORD" > "$pwfile"
  "$pgbin/initdb" -D "$root/data" -U postgres --pwfile="$pwfile" -A scram-sha-256 >/dev/null
  rm -f "$pwfile"
  datadir="$root/data"
  export PGPORT="$(python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1])')"
  "$pgbin/pg_ctl" -D "$datadir" -o "-p $PGPORT -k $datadir -c listen_addresses=127.0.0.1" -l "$datadir/log" -w start >/dev/null
fi
for attempt in {1..30}; do
  if pg_isready -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" >/dev/null 2>&1; then break; fi
  sleep 1
done

psql -X -q -v ON_ERROR_STOP=1 <<'SQL'
create role anon nologin;
create role authenticated nologin;
create role service_role nologin bypassrls;
grant usage on schema public to anon, authenticated, service_role;
create schema extensions;
create extension pg_trgm schema public;
create schema auth;
create function auth.uid() returns uuid language sql stable as
  $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;

create table public.tenants (id uuid primary key, slug text, facility_type text);
create table public.hospitals (id uuid primary key, subdomain text);
create table public.profiles (
  id uuid primary key, email text, role text, full_name text, tenant_id uuid, hospital_id uuid,
  is_deleted boolean default false
);
create function public.current_tenant_id() returns uuid language sql stable security definer set search_path = public as
  $$ select tenant_id from profiles where id = auth.uid() limit 1 $$;
grant execute on function public.current_tenant_id() to authenticated;
create table public.synapse_sessions (
  id uuid primary key default gen_random_uuid(), user_id uuid, token_hash text unique,
  expires_at timestamptz, revoked_at timestamptz
);
create table public.capabilities (
  id uuid primary key default gen_random_uuid(), module text, resource text, action text, description text,
  unique (module, resource, action)
);
create table public.role_capabilities (
  id uuid primary key default gen_random_uuid(), role text, facility_type text,
  capability_id uuid references public.capabilities(id), unique (role, facility_type, capability_id)
);
insert into public.capabilities (module, resource, action) values
  ('opd','queue','read'), ('opd','triage','assign'), ('lab','order','read'),
  ('billing','payment','record'), ('billing','invoice','read'), ('ipd','admission','create'), ('ipd','admission','read');

create table public.patients (
  id uuid primary key default gen_random_uuid(), tenant_id uuid not null references public.tenants(id),
  hospital_id uuid, mrn text, full_name text, dob date, date_of_birth date, sex text,
  phone text, nin text, is_deleted boolean default false, created_at timestamptz default now()
);
create table public.encounters (
  id uuid primary key default gen_random_uuid(), tenant_id uuid, hospital_id uuid, patient_id uuid,
  visit_date timestamptz default now(), is_deleted boolean default false
);
create table public.encounter_diagnoses (
  id uuid primary key default gen_random_uuid(), tenant_id uuid, encounter_id uuid, stem_code text,
  diagnosis_type text, is_deleted boolean default false, created_at timestamptz default now()
);
create table public.billing_invoices (
  id uuid primary key default gen_random_uuid(), tenant_id uuid, patient_id uuid references public.patients(id),
  encounter_id uuid references public.encounters(id), invoice_number text,
  status text not null default 'draft' check (status in ('draft','issued','partially_paid','paid','void')),
  total_amount numeric not null default 0, paid_amount numeric not null default 0, currency text not null default 'UGX',
  is_deleted boolean default false, created_at timestamptz default now(), updated_at timestamptz default now()
);
create table public.billing_payments (
  id uuid primary key default gen_random_uuid(), tenant_id uuid not null, invoice_id uuid not null references public.billing_invoices(id),
  encounter_id uuid, patient_id uuid, amount numeric(12,2) not null check (amount > 0), currency text not null default 'UGX',
  payment_method text not null, payment_ref text, receipt_number text, idempotency_key text, received_by uuid, notes text,
  is_deleted boolean not null default false, created_at timestamptz not null default now()
);
create unique index on public.billing_payments (tenant_id, idempotency_key) where idempotency_key is not null;
create table public.insurance_providers (
  id uuid primary key default gen_random_uuid(), tenant_id uuid not null, name text not null, code text not null,
  is_active boolean not null default true, created_at timestamptz not null default now()
);
create table public.insurance_policies (
  id uuid primary key default gen_random_uuid(), tenant_id uuid not null, patient_id uuid references public.patients(id),
  payer_id uuid, policy_number text not null, member_id text, plan_name text, coverage_type text not null default 'inpatient',
  expiry_date date, status text not null default 'active', created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create table public.insurance_claims (
  id uuid primary key default gen_random_uuid(), tenant_id uuid, hospital_id uuid not null, patient_id uuid not null,
  encounter_id uuid, invoice_id uuid, insurer_id uuid, insurer_name text not null, claim_number text,
  claim_type text not null default 'professional', service_from date not null, service_to date not null,
  billed_amount numeric not null default 0, patient_responsibility numeric, primary_icd11 text,
  diagnosis_codes text[] not null default '{}',
  status text not null default 'draft' check (status in ('draft','ready','submitted','acknowledged','adjudicated','paid','denied','appealed','written_off','void')),
  version integer not null default 1, metadata jsonb not null default '{}', created_at timestamptz default now(), updated_at timestamptz default now()
);
create table public.department_tasks (
  id uuid primary key default gen_random_uuid(), tenant_id uuid, patient_id uuid, encounter_id uuid,
  task_type text, status text, source_resource text, source_id uuid, accepted_at timestamptz,
  completed_at timestamptz, assigned_to uuid, result_summary text, updated_at timestamptz
);
create table public.hospital_beds (
  id uuid primary key default gen_random_uuid(), hospital_id uuid not null, tenant_id uuid, bed_number text not null,
  ward text not null, status text not null default 'available', current_patient_id uuid references public.patients(id),
  last_status_change timestamptz, updated_at timestamptz, is_deleted boolean default false
);
SQL

PGOPTIONS="-c client_min_messages=warning" psql -X -q -v ON_ERROR_STOP=1 -f supabase/migrations/20261120140000_hospital_core_journey.sql
# Re-applying must be a no-op.
PGOPTIONS="-c client_min_messages=warning" psql -X -q -v ON_ERROR_STOP=1 -f supabase/migrations/20261120140000_hospital_core_journey.sql

psql -X -q -v ON_ERROR_STOP=1 <<'SQL'
\set ON_ERROR_STOP 1
create function pg_temp.expect_error(p_sql text, p_message text) returns void language plpgsql as $$
begin
  begin
    execute p_sql;
  exception when others then
    if sqlerrm <> p_message then
      raise exception 'expected %, got %', p_message, sqlerrm;
    end if;
    return;
  end;
  raise exception 'expected error % but statement succeeded: %', p_message, p_sql;
end $$;

-- Fixture: two tenants, one hospital each.
insert into tenants values
  ('a0000000-0000-4000-8000-000000000001', 'clinic-a', 'hospital'),
  ('b0000000-0000-4000-8000-000000000001', 'clinic-b', 'hospital');
insert into hospitals values
  ('a0000000-0000-4000-8000-0000000000a1', 'clinic-a'),
  ('b0000000-0000-4000-8000-0000000000b1', 'clinic-b');
insert into profiles (id, email, role, full_name, tenant_id, hospital_id) values
  ('a0000000-0000-4000-8000-00000000c001', 'cash@a', 'cashier', 'Cashier A', 'a0000000-0000-4000-8000-000000000001', null),
  ('b0000000-0000-4000-8000-00000000c001', 'doc@b', 'doctor', 'Doctor B', 'b0000000-0000-4000-8000-000000000001', 'b0000000-0000-4000-8000-0000000000b1');
insert into synapse_sessions (user_id, token_hash, expires_at, revoked_at) values
  ('a0000000-0000-4000-8000-00000000c001', 'hash-ok', now() + interval '1 day', null),
  ('a0000000-0000-4000-8000-00000000c001', 'hash-expired', now() - interval '1 minute', null),
  ('a0000000-0000-4000-8000-00000000c001', 'hash-revoked', now() + interval '1 day', now());

-- 1. Capability seed.
do $$ begin
  assert (select count(*) from capabilities where (module, resource, action) in
          (('opd','encounter','sign'),('opd','encounter','close'),('opd','encounter','disposition'),
           ('opd','result','review'),('opd','prescription','cancel'),('billing','insurance','apply'),
           ('ipd','admission','discharge'))) = 7, 'capabilities seeded';
  assert exists (select 1 from role_capabilities rc join capabilities c on c.id = rc.capability_id
                 where rc.role = 'cashier' and c.module = 'billing' and c.resource = 'payment' and c.action = 'record'),
         'cashier can record payments';
  assert exists (select 1 from role_capabilities rc join capabilities c on c.id = rc.capability_id
                 where rc.role = 'nurse' and c.module = 'opd' and c.resource = 'triage' and c.action = 'assign'),
         'nurse can triage';
  assert not exists (select 1 from role_capabilities rc join capabilities c on c.id = rc.capability_id
                 where rc.role in ('receptionist','cashier') and c.module = 'opd' and c.resource = 'encounter' and c.action = 'sign'),
         'reception and cashier cannot sign';
end $$;

-- 2. Staff context.
do $$
declare r jsonb;
begin
  r := hospital_staff_context('hash-ok', 'a0000000-0000-4000-8000-00000000c001');
  assert r->>'status' = 'ok', 'valid session: ' || r::text;
  assert r->>'hospital_id' = 'a0000000-0000-4000-8000-0000000000a1', 'hospital resolved from tenant slug';
  assert r->>'role' = 'cashier' and r->>'facility_type' = 'hospital';
  assert hospital_staff_context('hash-expired', 'a0000000-0000-4000-8000-00000000c001')->>'status' = 'session_invalid', 'expired';
  assert hospital_staff_context('hash-revoked', 'a0000000-0000-4000-8000-00000000c001')->>'status' = 'session_invalid', 'revoked';
  assert hospital_staff_context('hash-ok', 'b0000000-0000-4000-8000-00000000c001')->>'status' = 'session_invalid', 'token of another user';
  assert hospital_staff_context('nope', 'a0000000-0000-4000-8000-00000000c001')->>'status' = 'session_invalid', 'unknown token';
end $$;

-- 3. Patient search.
insert into patients (id, tenant_id, mrn, full_name, dob, sex, phone, nin) values
  ('a0000000-0000-4000-8000-0000000000f1', 'a0000000-0000-4000-8000-000000000001', 'A1-0001', 'Nakato Sarah', '1990-01-02', 'F', '0772 123456', 'CF90012345ABCD'),
  ('a0000000-0000-4000-8000-0000000000f2', 'a0000000-0000-4000-8000-000000000001', 'A1-0002', 'Okello John', '1985-05-05', 'M', '+256701999888', null),
  ('a0000000-0000-4000-8000-0000000000f3', 'a0000000-0000-4000-8000-000000000001', 'A1-0003', 'Nakato_Gone', null, 'F', null, null),
  ('b0000000-0000-4000-8000-0000000000f1', 'b0000000-0000-4000-8000-000000000001', 'B1-0001', 'Nakato Sarah', '1990-01-02', 'F', '0772123456', null);
update patients set is_deleted = true where id = 'a0000000-0000-4000-8000-0000000000f3';
do $$
declare n int; k text;
begin
  select count(*) into n from hospital_search_patients('a0000000-0000-4000-8000-000000000001', 'nakato', 20);
  assert n = 1, 'name search stays in tenant and skips deleted rows, got ' || n;
  select match_kind into k from hospital_search_patients('a0000000-0000-4000-8000-000000000001', '+256 772 123456', 20);
  assert k = 'phone', 'phone matches across 07/+256 formats';
  select match_kind into k from hospital_search_patients('a0000000-0000-4000-8000-000000000001', '0701999888', 20);
  assert k = 'phone';
  select match_kind into k from hospital_search_patients('a0000000-0000-4000-8000-000000000001', 'cf90012345abcd', 20);
  assert k = 'nin', 'NIN is case-insensitive';
  select match_kind into k from hospital_search_patients('a0000000-0000-4000-8000-000000000001', 'a1-0002', 20);
  assert k = 'mrn';
  select count(*) into n from hospital_search_patients('a0000000-0000-4000-8000-000000000001', 'A1-', 20);
  assert n = 2, 'MRN prefix';
  select count(*) into n from hospital_search_patients('a0000000-0000-4000-8000-000000000001', '%', 20);
  assert n = 0, 'LIKE wildcards are escaped';
  select count(*) into n from hospital_search_patients('a0000000-0000-4000-8000-000000000001', 'Okelo Jon', 20);
  assert n = 1, 'trigram catches a misspelt name';
  select count(*) into n from hospital_search_patients('a0000000-0000-4000-8000-000000000001', 'A1-', 1);
  assert n = 1, 'limit applies';
end $$;

-- 4/5. Billing: invoice of 50 000 for patient p1.
insert into encounters (id, tenant_id, hospital_id, patient_id) values
  ('a0000000-0000-4000-8000-0000000000e1', 'a0000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-0000000000a1', 'a0000000-0000-4000-8000-0000000000f1'),
  ('a0000000-0000-4000-8000-0000000000e2', 'a0000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-0000000000a1', 'a0000000-0000-4000-8000-0000000000f2');
insert into encounter_diagnoses (tenant_id, encounter_id, stem_code, diagnosis_type) values
  ('a0000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-0000000000e1', '1F40', 'primary'),
  ('a0000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-0000000000e1', 'CA40', 'secondary');
insert into billing_invoices (id, tenant_id, patient_id, encounter_id, total_amount, status) values
  ('a0000000-0000-4000-8000-000000000091', 'a0000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-0000000000f1', 'a0000000-0000-4000-8000-0000000000e1', 50000, 'draft'),
  ('a0000000-0000-4000-8000-000000000092', 'a0000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-0000000000f2', 'a0000000-0000-4000-8000-0000000000e2', 10000, 'draft');
insert into department_tasks (tenant_id, patient_id, encounter_id, task_type, status, source_resource, source_id) values
  ('a0000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-0000000000f1', 'a0000000-0000-4000-8000-0000000000e1', 'billing', 'REQUESTED', 'billing_invoices', 'a0000000-0000-4000-8000-000000000091');

do $$
declare r jsonb; r2 jsonb; cid uuid;
begin
  -- Cover from a new insurer: provider, policy and a draft claim are created.
  r := hospital_apply_invoice_cover('a0000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-0000000000a1',
        'a0000000-0000-4000-8000-000000000091', 30000, 'a0000000-0000-4000-8000-00000000c001',
        null, 'Jubilee Health', 'JUB-778', 'Corporate');
  assert (r->>'balanceDue')::numeric = 20000, 'patient owes the uncovered part: ' || r::text;
  assert r->>'status' = 'issued';
  cid := (r->>'claimId')::uuid;
  assert (select status from insurance_claims where id = cid) = 'draft';
  assert (select primary_icd11 from insurance_claims where id = cid) = '1F40', 'primary diagnosis on the claim';
  assert (select diagnosis_codes from insurance_claims where id = cid) = array['1F40','CA40'];
  assert (select count(*) from insurance_providers) = 1;
  -- Same insurer + member reuses the policy and updates the same claim.
  r2 := hospital_apply_invoice_cover('a0000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-0000000000a1',
        'a0000000-0000-4000-8000-000000000091', 35000, 'a0000000-0000-4000-8000-00000000c001',
        null, 'jubilee health', 'jub-778', null);
  assert r2->>'claimId' = r->>'claimId' and r2->>'policyId' = r->>'policyId', 'policy and claim reused';
  assert (select billed_amount from insurance_claims where id = cid) = 35000;
  assert (select count(*) from insurance_policies) = 1;
  -- Cover cannot exceed the invoice.
  perform pg_temp.expect_error($q$ select hospital_apply_invoice_cover('a0000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-0000000000a1',
        'a0000000-0000-4000-8000-000000000091', 50001, null, null, 'Jubilee Health', 'JUB-778') $q$, 'COVER_EXCEEDS_BALANCE');
  -- Another tenant cannot touch the invoice or use the policy.
  perform pg_temp.expect_error($q$ select hospital_apply_invoice_cover('b0000000-0000-4000-8000-000000000001', 'b0000000-0000-4000-8000-0000000000b1',
        'a0000000-0000-4000-8000-000000000091', 1000, null, null, 'X', 'Y') $q$, 'INVOICE_NOT_FOUND');
  perform pg_temp.expect_error(format($q$ select hospital_apply_invoice_cover('a0000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-0000000000a1',
        'a0000000-0000-4000-8000-000000000092', 1000, null, %L) $q$, r->>'policyId'), 'POLICY_NOT_FOUND');
  perform pg_temp.expect_error($q$ select hospital_apply_invoice_cover('a0000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-0000000000a1',
        'a0000000-0000-4000-8000-000000000092', 1000, null) $q$, 'POLICY_REQUIRED');
end $$;

do $$
declare r jsonb; r2 jsonb;
begin
  -- Patient owes 15 000 after 35 000 cover.
  perform pg_temp.expect_error($q$ select hospital_record_payment('a0000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-0000000000e1',
        15001, 'cash', null) $q$, 'AMOUNT_EXCEEDS_BALANCE');
  r := hospital_record_payment('a0000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-0000000000e1',
        10000, 'cash', 'a0000000-0000-4000-8000-00000000c001', null, 'key-1');
  assert r->>'status' = 'partially_paid' and (r->>'balanceDue')::numeric = 5000, r::text;
  assert r->>'receiptNumber' like 'RCP-________-0001', 'first receipt of the day: ' || (r->>'receiptNumber');
  -- Retry with the same key returns the same payment and records nothing.
  r2 := hospital_record_payment('a0000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-0000000000e1',
        10000, 'cash', null, null, 'key-1');
  assert r2->>'paymentId' = r->>'paymentId' and (r2->>'created')::boolean = false;
  assert (select count(*) from billing_payments) = 1;
  -- Settling the balance completes the billing task.
  r := hospital_record_payment('a0000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-0000000000e1',
        5000, 'mobile_money', 'a0000000-0000-4000-8000-00000000c001', 'MTN-123', 'key-2');
  assert r->>'status' = 'paid' and (r->>'balanceDue')::numeric = 0 and (r->>'billingTaskCompleted')::boolean, r::text;
  assert r->>'receiptNumber' like 'RCP-________-0002', 'receipts are sequential';
  assert (select status from department_tasks where source_id = 'a0000000-0000-4000-8000-000000000091') = 'COMPLETED';
  perform pg_temp.expect_error($q$ select hospital_record_payment('a0000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-0000000000e1',
        1, 'cash', null) $q$, 'INVOICE_ALREADY_PAID');
  -- The same key after settlement still answers with the original payment.
  r2 := hospital_record_payment('a0000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-0000000000e1',
        10000, 'cash', null, null, 'key-1');
  assert (r2->>'created')::boolean = false;
  -- Cover is locked once the claim is submitted.
  update insurance_claims set status = 'submitted';
  perform pg_temp.expect_error($q$ select hospital_apply_invoice_cover('a0000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-0000000000a1',
        'a0000000-0000-4000-8000-000000000091', 0, null) $q$, 'CLAIM_ALREADY_SUBMITTED');
  -- Another tenant sees no invoice for the encounter.
  perform pg_temp.expect_error($q$ select hospital_record_payment('b0000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-0000000000e2',
        1, 'cash', null) $q$, 'INVOICE_NOT_FOUND');
end $$;

-- 6. Admission and discharge.
insert into hospital_beds (id, hospital_id, tenant_id, bed_number, ward) values
  ('a0000000-0000-4000-8000-0000000000d1', 'a0000000-0000-4000-8000-0000000000a1', 'a0000000-0000-4000-8000-000000000001', 'M-01', 'Male ward'),
  ('a0000000-0000-4000-8000-0000000000d2', 'a0000000-0000-4000-8000-0000000000a1', 'a0000000-0000-4000-8000-000000000001', 'M-02', 'Male ward'),
  ('b0000000-0000-4000-8000-0000000000d1', 'b0000000-0000-4000-8000-0000000000b1', 'b0000000-0000-4000-8000-000000000001', 'B-01', 'Ward B');
insert into department_tasks (tenant_id, patient_id, encounter_id, task_type, status, source_resource, source_id) values
  ('a0000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-0000000000f2', 'a0000000-0000-4000-8000-0000000000e2', 'admission', 'REQUESTED', 'hospital_beds', 'a0000000-0000-4000-8000-0000000000d1');
do $$
declare r jsonb; d jsonb;
begin
  r := hospital_admit_patient('a0000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-0000000000a1',
        'a0000000-0000-4000-8000-0000000000f2', 'a0000000-0000-4000-8000-0000000000d1',
        'a0000000-0000-4000-8000-00000000c001', 'Severe malaria', 'a0000000-0000-4000-8000-0000000000e2');
  assert r->>'ward' = 'Male ward';
  assert (select current_patient_id from hospital_beds where id = 'a0000000-0000-4000-8000-0000000000d1') = 'a0000000-0000-4000-8000-0000000000f2';
  perform pg_temp.expect_error($q$ select hospital_admit_patient('a0000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-0000000000a1',
        'a0000000-0000-4000-8000-0000000000f1', 'a0000000-0000-4000-8000-0000000000d1', null, 'x') $q$, 'BED_OCCUPIED');
  perform pg_temp.expect_error($q$ select hospital_admit_patient('a0000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-0000000000a1',
        'a0000000-0000-4000-8000-0000000000f2', 'a0000000-0000-4000-8000-0000000000d2', null, 'x') $q$, 'ALREADY_ADMITTED');
  perform pg_temp.expect_error($q$ select hospital_admit_patient('a0000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-0000000000a1',
        'a0000000-0000-4000-8000-0000000000f1', 'b0000000-0000-4000-8000-0000000000d1', null, 'x') $q$, 'BED_NOT_FOUND');
  perform pg_temp.expect_error($q$ select hospital_admit_patient('a0000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-0000000000a1',
        'b0000000-0000-4000-8000-0000000000f1', 'a0000000-0000-4000-8000-0000000000d2', null, 'x') $q$, 'PATIENT_NOT_FOUND');
  perform pg_temp.expect_error($q$ select hospital_admit_patient('a0000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-0000000000a1',
        'a0000000-0000-4000-8000-0000000000f1', 'a0000000-0000-4000-8000-0000000000d2', null, 'x', 'a0000000-0000-4000-8000-0000000000e2') $q$, 'ENCOUNTER_NOT_FOUND');
  perform pg_temp.expect_error(format($q$ select hospital_discharge_patient('b0000000-0000-4000-8000-000000000001', 'b0000000-0000-4000-8000-0000000000b1',
        %L, null, 'home') $q$, r->>'admissionId'), 'ADMISSION_NOT_FOUND');

  d := hospital_discharge_patient('a0000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-0000000000a1',
        (r->>'admissionId')::uuid, 'a0000000-0000-4000-8000-00000000c001', 'home', 'Recovered on ACTs');
  assert (d->>'tasksCompleted')::int = 1, d::text;
  assert (select current_patient_id is null and status = 'available' from hospital_beds where id = 'a0000000-0000-4000-8000-0000000000d1');
  perform pg_temp.expect_error(format($q$ select hospital_discharge_patient('a0000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-0000000000a1',
        %L, null, 'home') $q$, r->>'admissionId'), 'ALREADY_DISCHARGED');
  perform pg_temp.expect_error(format($q$ select hospital_discharge_patient('a0000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-0000000000a1',
        %L, null, 'teleported') $q$, (hospital_admit_patient('a0000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-0000000000a1',
        'a0000000-0000-4000-8000-0000000000f2', 'a0000000-0000-4000-8000-0000000000d2', null, 'readmit'))->>'admissionId'),
        'new row for relation "hospital_admissions" violates check constraint "hospital_admissions_discharge_disposition_check"');
end $$;

-- Grants: functions and new tables are service_role only.
do $$
declare f text;
begin
  foreach f in array array[
    'public.hospital_staff_context(text,uuid)',
    'public.hospital_search_patients(uuid,text,integer)',
    'public.hospital_apply_invoice_cover(uuid,uuid,uuid,numeric,uuid,uuid,text,text,text)',
    'public.hospital_record_payment(uuid,uuid,numeric,text,uuid,text,text,text)',
    'public.hospital_admit_patient(uuid,uuid,uuid,uuid,uuid,text,uuid,uuid)',
    'public.hospital_discharge_patient(uuid,uuid,uuid,uuid,text,text)'] loop
    assert not has_function_privilege('anon', f, 'execute'), f || ' anon';
    assert not has_function_privilege('authenticated', f, 'execute'), f || ' authenticated';
    assert has_function_privilege('service_role', f, 'execute'), f || ' service_role';
  end loop;
  assert not has_table_privilege('anon', 'public.hospital_admissions', 'select');
  assert not has_table_privilege('authenticated', 'public.hospital_receipt_counters', 'select');
end $$;

-- RLS: an authenticated session reads only its own tenant's admissions.
insert into hospital_admissions (tenant_id, hospital_id, patient_id, reason) values
  ('b0000000-0000-4000-8000-000000000001', 'b0000000-0000-4000-8000-0000000000b1', 'b0000000-0000-4000-8000-0000000000f1', 'B admission');
set role authenticated;
select set_config('request.jwt.claim.sub', 'b0000000-0000-4000-8000-00000000c001', false);
do $$ begin
  assert (select count(*) from hospital_admissions) = 1, 'tenant B sees only its admission';
  assert (select reason from hospital_admissions) = 'B admission';
end $$;
reset role;
SQL

echo "hospital-core-journey: all checks passed"
