-- Clinical Intelligence Wave 1 — advisory audit / override log (expand-safe).
-- DO NOT apply to production until ops approval. Feature flag remains OFF.
-- Additive only: new table + RLS; no destructive changes.

create table if not exists public.clinical_ai_advice_events (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id),
  clinician_id uuid not null,
  patient_id text,
  encounter_id text,
  recommendation_id text,
  task text not null default 'clinical_copilot',
  provider text,
  model text,
  decision text check (decision is null or decision in ('ACCEPT','MODIFY','REJECT','DEFER')),
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists clinical_ai_advice_events_tenant_created_idx
  on public.clinical_ai_advice_events (tenant_id, created_at desc);

alter table public.clinical_ai_advice_events enable row level security;

-- No anon/authenticated policies: service-role / SECURITY DEFINER writers only for Wave 1.
comment on table public.clinical_ai_advice_events is
  'Wave 1 clinical AI advisory/override audit. AI never writes diagnoses or orders here.';
