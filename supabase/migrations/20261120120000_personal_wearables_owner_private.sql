-- My Synapse Health: wearable readings (Android Health Connect, Apple HealthKit).
--
-- Privacy model, enforced here and in the BFF:
--
--   * Personal health belongs to a person, not to a facility. These tables are
--     keyed by owner_profile_id only. There is deliberately no tenant_id column,
--     so no facility-scoped policy, report or admin screen has a column to match
--     on. A pharmacy or hospital admin cannot read a staff member's readings,
--     even though both profiles belong to the same tenant.
--   * Do NOT add a tenant_id column or any policy that references a tenant, a
--     role or is_admin. Anonymised facility wellbeing, if it is ever built, must
--     be a separate aggregate with a minimum cohort size, never row access.
--   * Readings are only accepted while a consent row exists
--     (personal_wearable_connections). Disconnecting deletes that row, and the
--     foreign key cascades every reading for that provider.
--   * Deleting the profile deletes everything (ON DELETE CASCADE).
--   * RLS is enabled and FORCED. anon and PUBLIC hold no privileges. The only
--     client policy is owner = (select auth.uid()), evaluated once per query. The app and web reach these tables
--     through the service-role BFF (/api/mobile/health/*, /api/health/*), which
--     takes the owner from the verified session token and never from the request.
--   * No SECURITY DEFINER functions are introduced.

create table if not exists public.personal_wearable_connections (
  owner_profile_id uuid not null references public.profiles(id) on delete cascade,
  provider text not null check (provider in ('health_connect', 'healthkit')),
  scopes text[] not null default '{}'::text[],
  consent_version text not null,
  consented_at timestamptz not null default now(),
  last_synced_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (owner_profile_id, provider)
);

comment on table public.personal_wearable_connections is
  'Owner-private wearable consent. No tenant column by design: facility admins must never reach personal health. See migration 20261120120000.';

create table if not exists public.personal_wearable_daily (
  owner_profile_id uuid not null,
  provider text not null,
  metric text not null check (metric in (
    'steps',
    'heart_rate',
    'resting_heart_rate',
    'sleep_minutes',
    'active_calories',
    'distance_m',
    'weight_kg',
    'oxygen_saturation'
  )),
  day date not null,
  value numeric not null check (value >= 0),
  min_value numeric,
  max_value numeric,
  sample_count integer not null default 1 check (sample_count >= 0),
  unit text not null,
  updated_at timestamptz not null default now(),
  primary key (owner_profile_id, provider, metric, day),
  foreign key (owner_profile_id, provider)
    references public.personal_wearable_connections(owner_profile_id, provider)
    on delete cascade
);

comment on table public.personal_wearable_daily is
  'Owner-private daily wearable summaries. No tenant column by design. Cascades from personal_wearable_connections on disconnect.';

create index if not exists personal_wearable_daily_owner_day
  on public.personal_wearable_daily (owner_profile_id, day desc);

alter table public.personal_wearable_connections enable row level security;
alter table public.personal_wearable_connections force row level security;
alter table public.personal_wearable_daily enable row level security;
alter table public.personal_wearable_daily force row level security;

revoke all on table public.personal_wearable_connections from public;
revoke all on table public.personal_wearable_daily from public;
revoke all on table public.personal_wearable_connections from anon;
revoke all on table public.personal_wearable_daily from anon;
revoke all on table public.personal_wearable_connections from authenticated;
revoke all on table public.personal_wearable_daily from authenticated;

grant select, insert, update, delete on table public.personal_wearable_connections to authenticated;
grant select, insert, update, delete on table public.personal_wearable_daily to authenticated;
grant all on table public.personal_wearable_connections to service_role;
grant all on table public.personal_wearable_daily to service_role;

drop policy if exists personal_wearable_connections_owner on public.personal_wearable_connections;
create policy personal_wearable_connections_owner on public.personal_wearable_connections
  for all to authenticated
  using (owner_profile_id = (select auth.uid()))
  with check (owner_profile_id = (select auth.uid()));

drop policy if exists personal_wearable_daily_owner on public.personal_wearable_daily;
create policy personal_wearable_daily_owner on public.personal_wearable_daily
  for all to authenticated
  using (owner_profile_id = (select auth.uid()))
  with check (owner_profile_id = (select auth.uid()));
