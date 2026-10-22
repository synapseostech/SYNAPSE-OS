-- Clinical Intelligence Wave 1 — advisory audit / clinician override log (expand-only).
-- DO NOT apply to production until ops approval. Feature flag remains OFF.
-- Additive only: one new table, one trigger function, indexes, RLS. No existing object changes.
--
-- Integrity model
--   * Tenant-scoped: tenant_id is mandatory; patient, encounter and clinician must belong
--     to that same tenant (enforced by trigger, so a cross-tenant reference cannot be written
--     even by a service-role caller with a bug).
--   * Append-only: UPDATE, DELETE and TRUNCATE are rejected by trigger and revoked at the
--     privilege level. Corrections are new rows.
--   * No anon/authenticated access: RLS on with no policies; service-role server routes only.
--
-- Rollback (only while the table is unused; see docs/CLINICAL_INTELLIGENCE_WAVE1.md):
--   drop table if exists public.clinical_ai_advice_events;
--   drop function if exists public.clinical_ai_advice_events_guard();

create table if not exists public.clinical_ai_advice_events (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id),
  clinician_id uuid not null references public.profiles(id),
  event_type text not null check (event_type in ('advice', 'override')),
  patient_id uuid references public.patients(id),
  encounter_id uuid references public.encounters(id),
  recommendation_id text check (recommendation_id is null or length(recommendation_id) <= 128),
  task text not null default 'clinical_copilot'
    check (task in ('clinical_copilot', 'pathway_copilot', 'coding_copilot')),
  provider text check (provider is null or length(provider) <= 64),
  model text check (model is null or length(model) <= 200),
  decision text check (decision is null or decision in ('ACCEPT', 'MODIFY', 'REJECT', 'DEFER')),
  payload jsonb not null default '{}'::jsonb
    check (jsonb_typeof(payload) = 'object' and pg_column_size(payload) <= 65536),
  created_at timestamptz not null default now(),
  constraint clinical_ai_advice_events_decision_matches_type
    check ((event_type = 'override') = (decision is not null))
);

create index if not exists clinical_ai_advice_events_tenant_created_idx
  on public.clinical_ai_advice_events (tenant_id, created_at desc);
create index if not exists clinical_ai_advice_events_tenant_encounter_idx
  on public.clinical_ai_advice_events (tenant_id, encounter_id, created_at desc)
  where encounter_id is not null;
create index if not exists clinical_ai_advice_events_patient_idx
  on public.clinical_ai_advice_events (patient_id)
  where patient_id is not null;
create index if not exists clinical_ai_advice_events_clinician_idx
  on public.clinical_ai_advice_events (clinician_id);
create index if not exists clinical_ai_advice_events_recommendation_idx
  on public.clinical_ai_advice_events (recommendation_id)
  where recommendation_id is not null;

create or replace function public.clinical_ai_advice_events_guard()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if tg_op <> 'INSERT' then
    raise exception 'clinical_ai_advice_events is append-only (% rejected)', tg_op
      using errcode = '42501';
  end if;

  if not exists (
    select 1 from public.profiles pr
    where pr.id = new.clinician_id and pr.tenant_id = new.tenant_id
  ) then
    raise exception 'clinician does not belong to tenant' using errcode = '23514';
  end if;

  if new.patient_id is not null and not exists (
    select 1 from public.patients p
    where p.id = new.patient_id and p.tenant_id = new.tenant_id
  ) then
    raise exception 'patient does not belong to tenant' using errcode = '23514';
  end if;

  if new.encounter_id is not null and not exists (
    select 1 from public.encounters e
    where e.id = new.encounter_id
      and e.tenant_id = new.tenant_id
      and (new.patient_id is null or e.patient_id = new.patient_id)
  ) then
    raise exception 'encounter does not belong to tenant/patient' using errcode = '23514';
  end if;

  return new;
end;
$$;

revoke all on function public.clinical_ai_advice_events_guard() from public;

drop trigger if exists clinical_ai_advice_events_guard_row on public.clinical_ai_advice_events;
create trigger clinical_ai_advice_events_guard_row
  before insert or update or delete on public.clinical_ai_advice_events
  for each row execute function public.clinical_ai_advice_events_guard();

drop trigger if exists clinical_ai_advice_events_guard_truncate on public.clinical_ai_advice_events;
create trigger clinical_ai_advice_events_guard_truncate
  before truncate on public.clinical_ai_advice_events
  for each statement execute function public.clinical_ai_advice_events_guard();

alter table public.clinical_ai_advice_events enable row level security;

-- No anon/authenticated policies: service-role server routes only for Wave 1.
revoke all on table public.clinical_ai_advice_events from public, anon, authenticated;
grant select, insert on table public.clinical_ai_advice_events to service_role;
revoke update, delete, truncate on table public.clinical_ai_advice_events from service_role;

comment on table public.clinical_ai_advice_events is
  'Wave 1 clinical AI advisory/override audit (append-only, tenant-scoped). AI never writes diagnoses or orders here.';
