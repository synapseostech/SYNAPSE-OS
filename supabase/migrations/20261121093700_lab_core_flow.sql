-- 20261121093700_lab_core_flow
--
-- PREPARED ONLY — NOT APPLIED TO ANY DATABASE BY THIS CHANGE.
--
-- Synapse Lab end to end, in a hospital and as a standalone laboratory.
-- See docs/lab/LAB_CORE_FLOW_AUDIT_2026-11-20.md for the audit behind it.
--
--   lab_test_catalog          the tests a tenant offers: code, LOINC, section,
--                             specimen, container, unit, price, turnaround
--   lab_reference_ranges      gains tenant_id: a tenant's own interval wins over
--                             the national pack (tenant_id null)
--   lab_orders                gains section, catalog_test_id, order_source,
--                             referral_source; a trigger fills section and
--                             catalog_test_id from the catalogue, so orders sent
--                             by the hospital flow keep the existing contract
--   lab_result_staging        gains reviewed_by, reviewed_at, clinical_result_id,
--                             rejection_reason, which the staging routes already
--                             read and write (they failed without them)
--   lab_report_deliveries     who was told that a report is ready, how, and when
--
-- Functions (service_role only, SECURITY INVOKER, so RLS and grants are not
-- widened):
--   lab_access(...)           session + profile + facility + capability +
--                             module + subscription in ONE round trip
--   lab_order_bundle(...)     order, result, specimen, patient sex/age,
--                             reference ranges, catalogue entry and latest
--                             report in ONE round trip
--   lab_commit_action(p)      writes order, specimen, result, amendment,
--                             critical acknowledgement, report and the audit row
--                             in ONE transaction, guarded by the order's
--                             expected workflow status (a concurrent change
--                             raises LB409 and nothing is written)
--   lab_seed_starter_catalog  a starter test list for a new laboratory, no prices
--
-- Capabilities: adds lab.order.cancel, lab.report.read, lab.report.notify,
-- lab.catalog.manage; grants lab_tech@laboratory and
-- lab_manager/lab_supervisor the same as their peers; REMOVES result.verify from
-- lab_tech@hospital (the action route already refused it by role, so this only
-- makes the database agree; verification is for scientists and lab admins).
--
-- Free-tier notes: every new foreign key is indexed; worklists page by
-- (tenant, section, status, ordered_at, id); policies use (select ...) so auth
-- helpers run once per query.

begin;

-- ---------------------------------------------------------------------------
-- 1. Test catalogue
-- ---------------------------------------------------------------------------

create table if not exists public.lab_test_catalog (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  code text not null check (char_length(code) between 1 and 40),
  loinc_code text check (loinc_code is null or char_length(loinc_code) between 1 and 40),
  name text not null check (char_length(name) between 2 and 200),
  section text not null default 'general' check (section in (
    'haematology', 'chemistry', 'microbiology', 'serology', 'parasitology',
    'urinalysis', 'immunology', 'molecular', 'histology', 'general'
  )),
  specimen_type text not null default 'blood',
  container text,
  unit text,
  price numeric(12, 2) check (price is null or price >= 0),
  currency text not null default 'UGX',
  turnaround_minutes integer check (turnaround_minutes is null or turnaround_minutes > 0),
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, code)
);

-- One active entry per LOINC per tenant, so an order's LOINC resolves to one test.
create unique index if not exists lab_test_catalog_tenant_loinc_active_uidx
  on public.lab_test_catalog (tenant_id, loinc_code)
  where loinc_code is not null and is_active;

alter table public.lab_test_catalog enable row level security;
alter table public.lab_test_catalog force row level security;
revoke all on public.lab_test_catalog from public, anon;
revoke insert, update, delete, truncate on public.lab_test_catalog from authenticated;
grant select on public.lab_test_catalog to authenticated;
grant all on public.lab_test_catalog to service_role;

drop policy if exists lab_test_catalog_tenant_read on public.lab_test_catalog;
create policy lab_test_catalog_tenant_read on public.lab_test_catalog
  for select to authenticated
  using (tenant_id = (select public.current_tenant_id()) or (select public.is_platform_admin()));

-- ---------------------------------------------------------------------------
-- 2. Reference ranges per tenant (null tenant = national pack)
-- ---------------------------------------------------------------------------

alter table public.lab_reference_ranges
  add column if not exists tenant_id uuid references public.tenants(id) on delete cascade,
  add column if not exists created_at timestamptz not null default now();

drop index if exists public.lab_reference_ranges_natural_key;
create unique index if not exists lab_reference_ranges_natural_key_v2
  on public.lab_reference_ranges (
    coalesce(tenant_id, '00000000-0000-0000-0000-000000000000'::uuid),
    loinc_code,
    coalesce(sex, ''),
    coalesce(age_min_years, -1),
    coalesce(age_max_years, -1),
    country_pack
  );
create index if not exists lab_reference_ranges_tenant_loinc_idx
  on public.lab_reference_ranges (tenant_id, loinc_code);
create index if not exists lab_reference_ranges_loinc_idx
  on public.lab_reference_ranges (loinc_code) where tenant_id is null;

alter table public.lab_reference_ranges enable row level security;
revoke all on public.lab_reference_ranges from public, anon;
revoke insert, update, delete, truncate on public.lab_reference_ranges from authenticated;
grant select on public.lab_reference_ranges to authenticated;
grant all on public.lab_reference_ranges to service_role;

drop policy if exists lab_reference_ranges_read on public.lab_reference_ranges;
create policy lab_reference_ranges_read on public.lab_reference_ranges
  for select to authenticated
  using (tenant_id is null or tenant_id = (select public.current_tenant_id()) or (select public.is_platform_admin()));

-- Generic adult intervals for the national pack. Every laboratory must review
-- these against its own analysers and population before go-live; a tenant row
-- for the same LOINC/sex/age replaces the pack value for that tenant.
insert into public.lab_reference_ranges
  (loinc_code, test_name, unit, sex, low, high, critical_low, critical_high)
values
  ('718-7',  'Haemoglobin',      'g/dL',     'M', 13.0, 17.0, 7.0,  20.0),
  ('718-7',  'Haemoglobin',      'g/dL',     'F', 12.0, 15.0, 7.0,  20.0),
  ('4544-3', 'Haematocrit',      '%',        'M', 40,   50,   20,   60),
  ('4544-3', 'Haematocrit',      '%',        'F', 36,   46,   20,   60),
  ('777-3',  'Platelets',        '10*9/L',   null, 150, 400,  20,   1000),
  ('2160-0', 'Creatinine',       'umol/L',   'M', 62,   106,  null, 700),
  ('2160-0', 'Creatinine',       'umol/L',   'F', 44,   80,   null, 700),
  ('3094-0', 'Urea',             'mmol/L',   null, 2.5, 7.8,  null, 35),
  ('1742-6', 'ALT',              'U/L',      null, 0,   41,   null, null),
  ('1975-2', 'Total bilirubin',  'umol/L',   null, 0,   21,   null, 340),
  ('1988-5', 'C-reactive protein','mg/L',    null, 0,   5,    null, null),
  ('4548-4', 'HbA1c',            '%',        null, 4.0, 6.0,  null, null),
  ('2075-0', 'Chloride',         'mmol/L',   null, 98,  107,  80,   120)
on conflict do nothing;

-- ---------------------------------------------------------------------------
-- 3. Orders: section, catalogue link, source
-- ---------------------------------------------------------------------------

alter table public.lab_orders
  add column if not exists section text,
  add column if not exists catalog_test_id uuid references public.lab_test_catalog(id) on delete set null,
  add column if not exists order_source text not null default 'hospital',
  add column if not exists referral_source text;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'lab_orders_order_source_check') then
    alter table public.lab_orders
      add constraint lab_orders_order_source_check check (order_source in ('hospital', 'walk_in', 'referral'));
  end if;
end $$;

create or replace function public.lab_orders_fill_from_catalog()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_catalog record;
begin
  if new.catalog_test_id is null and new.loinc_code is not null then
    select id, section into v_catalog
    from public.lab_test_catalog
    where tenant_id = new.tenant_id and loinc_code = new.loinc_code and is_active
    limit 1;
    if found then
      new.catalog_test_id := v_catalog.id;
      new.section := coalesce(new.section, v_catalog.section);
    end if;
  elsif new.catalog_test_id is not null and new.section is null then
    select section into new.section from public.lab_test_catalog
    where id = new.catalog_test_id and tenant_id = new.tenant_id;
  end if;
  new.section := coalesce(new.section, 'general');
  return new;
end;
$$;

revoke all on function public.lab_orders_fill_from_catalog() from public, anon, authenticated;

drop trigger if exists lab_orders_fill_from_catalog on public.lab_orders;
create trigger lab_orders_fill_from_catalog
  before insert on public.lab_orders
  for each row execute function public.lab_orders_fill_from_catalog();

-- Paged worklists: by section and status, newest first, id as tie-breaker.
create index if not exists lab_orders_worklist_section_idx
  on public.lab_orders (tenant_id, section, workflow_status, ordered_at desc, id desc)
  where is_synthetic = false;
create index if not exists lab_orders_worklist_idx
  on public.lab_orders (tenant_id, workflow_status, ordered_at desc, id desc)
  where is_synthetic = false;
create index if not exists lab_orders_catalog_test_id_idx on public.lab_orders (catalog_test_id) where catalog_test_id is not null;
create index if not exists lab_orders_encounter_id_idx on public.lab_orders (encounter_id);
create index if not exists lab_orders_patient_id_idx on public.lab_orders (tenant_id, patient_id);

-- Hot paths the bundle and ingest follow.
create index if not exists lab_specimens_lab_order_idx on public.lab_specimens (tenant_id, lab_order_id);
create index if not exists lab_specimens_patient_id_idx on public.lab_specimens (patient_id);
create index if not exists lab_results_patient_id_idx on public.lab_results (patient_id);
create index if not exists lab_results_critical_open_idx
  on public.lab_results (tenant_id, created_at desc)
  where is_critical and critical_scientist_ack_at is null;
create index if not exists lab_reports_clinical_result_id_idx on public.lab_reports (clinical_result_id);
create index if not exists lab_reports_supersedes_idx on public.lab_reports (supersedes_report_id) where supersedes_report_id is not null;
create index if not exists lab_result_amendments_result_idx on public.lab_result_amendments (tenant_id, result_id);
create index if not exists lab_critical_acks_result_idx on public.lab_critical_acknowledgements (tenant_id, result_id);

-- ---------------------------------------------------------------------------
-- 4. Staging review columns the routes already use
-- ---------------------------------------------------------------------------

alter table public.lab_result_staging
  add column if not exists reviewed_by uuid references public.profiles(id) on delete set null,
  add column if not exists reviewed_at timestamptz,
  add column if not exists clinical_result_id uuid references public.lab_results(id) on delete set null,
  add column if not exists rejection_reason text;

create index if not exists lab_result_staging_review_idx on public.lab_result_staging (tenant_id, status, created_at desc);
create index if not exists lab_result_staging_device_id_idx on public.lab_result_staging (device_id);
create index if not exists lab_result_staging_message_id_idx on public.lab_result_staging (device_message_id);
create index if not exists lab_result_staging_order_idx on public.lab_result_staging (tenant_id, lab_order_id) where lab_order_id is not null;
create index if not exists lab_result_staging_reviewed_by_idx on public.lab_result_staging (reviewed_by) where reviewed_by is not null;
create index if not exists lab_result_staging_clinical_result_idx on public.lab_result_staging (clinical_result_id) where clinical_result_id is not null;

-- ---------------------------------------------------------------------------
-- 5. Report deliveries (patient / referrer notification log)
-- ---------------------------------------------------------------------------

create table if not exists public.lab_report_deliveries (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  report_id uuid not null references public.lab_reports(id) on delete cascade,
  report_version integer not null,
  channel text not null check (channel in ('push', 'sms', 'email', 'print', 'portal')),
  recipient_hint text,
  status text not null default 'QUEUED' check (status in ('QUEUED', 'SENT', 'FAILED', 'SKIPPED')),
  detail text,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  unique (report_id, report_version, channel)
);

create index if not exists lab_report_deliveries_tenant_idx on public.lab_report_deliveries (tenant_id, created_at desc);
create index if not exists lab_report_deliveries_created_by_idx on public.lab_report_deliveries (created_by) where created_by is not null;

alter table public.lab_report_deliveries enable row level security;
alter table public.lab_report_deliveries force row level security;
revoke all on public.lab_report_deliveries from public, anon;
revoke insert, update, delete, truncate on public.lab_report_deliveries from authenticated;
grant select on public.lab_report_deliveries to authenticated;
grant all on public.lab_report_deliveries to service_role;

drop policy if exists lab_report_deliveries_tenant_read on public.lab_report_deliveries;
create policy lab_report_deliveries_tenant_read on public.lab_report_deliveries
  for select to authenticated
  using (tenant_id = (select public.current_tenant_id()) or (select public.is_platform_admin()));

-- ---------------------------------------------------------------------------
-- 6. Capabilities
-- ---------------------------------------------------------------------------

insert into public.capabilities (module, resource, action, description) values
  ('lab', 'order', 'cancel', 'Cancel a laboratory order with a reason'),
  ('lab', 'report', 'read', 'Read and print released laboratory reports'),
  ('lab', 'report', 'notify', 'Tell a patient or referrer that a report is ready'),
  ('lab', 'catalog', 'manage', 'Edit the test catalogue, prices and reference ranges')
on conflict (module, resource, action) do nothing;

with grants(role, facility_type, resource, action) as (
  values
    -- everyday bench work
    ('lab_tech', 'laboratory', 'order', 'read'),
    ('lab_tech', 'laboratory', 'order', 'create'),
    ('lab_tech', 'laboratory', 'specimen', 'collect'),
    ('lab_tech', 'laboratory', 'result', 'enter'),
    ('lab_tech', 'laboratory', 'result', 'read'),
    ('lab_tech', 'laboratory', 'report', 'read'),
    ('lab_tech', 'hospital', 'report', 'read'),
    ('lab_technician', 'laboratory', 'report', 'read'),
    ('lab_technician', 'hospital', 'report', 'read'),
    -- seniors: verify, release, report, notify, cancel
    ('lab_scientist', 'any', 'report', 'read'),
    ('lab_scientist', 'any', 'report', 'notify'),
    ('lab_scientist', 'any', 'order', 'cancel'),
    ('lab_admin', 'any', 'report', 'read'),
    ('lab_admin', 'any', 'report', 'notify'),
    ('lab_admin', 'any', 'order', 'cancel'),
    ('lab_admin', 'any', 'catalog', 'manage'),
    ('hospital_admin', 'hospital', 'catalog', 'manage'),
    ('hospital_admin', 'hospital', 'report', 'read'),
    ('hospital_admin', 'hospital', 'order', 'read'),
    -- clinicians read their patients' orders and reports
    ('doctor', 'hospital', 'order', 'read'),
    ('doctor', 'hospital', 'report', 'read'),
    ('doctor', 'hospital', 'order', 'cancel'),
    ('clinical_officer', 'hospital', 'order', 'read'),
    ('clinical_officer', 'hospital', 'report', 'read'),
    ('clinical_officer', 'hospital', 'order', 'cancel'),
    -- reception desk in a standalone lab (registers walk-ins; billing follows the order)
    ('receptionist', 'laboratory', 'order', 'create'),
    ('receptionist', 'laboratory', 'order', 'read')
)
insert into public.role_capabilities (role, facility_type, capability_id)
select g.role, g.facility_type, c.id
from grants g
join public.capabilities c on c.module = 'lab' and c.resource = g.resource and c.action = g.action
on conflict (role, facility_type, capability_id) do nothing;

-- lab_manager and lab_supervisor (used by instrument, staging and mapping
-- screens) get exactly what lab_admin has.
insert into public.role_capabilities (role, facility_type, capability_id)
select r.role, rc.facility_type, rc.capability_id
from public.role_capabilities rc
cross join (values ('lab_manager'), ('lab_supervisor')) as r(role)
join public.capabilities c on c.id = rc.capability_id and c.module = 'lab'
where rc.role = 'lab_admin'
on conflict (role, facility_type, capability_id) do nothing;

-- Verification is a senior step. lab_tech@hospital held it by mistake.
delete from public.role_capabilities rc
using public.capabilities c
where rc.capability_id = c.id
  and c.module = 'lab' and c.resource = 'result' and c.action = 'verify'
  and rc.role in ('lab_tech', 'lab_technician');

-- ---------------------------------------------------------------------------
-- 7. lab_access: one round trip for every guard a lab route needs
-- ---------------------------------------------------------------------------

create or replace function public.lab_access(
  p_token_hash text,
  p_profile_id uuid,
  p_resource text,
  p_action text
) returns jsonb
language plpgsql
stable
set search_path = public
as $$
declare
  v_session record;
  v_profile record;
  v_tenant record;
  v_hospital_id uuid;
  v_facility text;
  v_module_active boolean;
  v_feature text;
  v_platform boolean;
begin
  select id, user_id, expires_at, revoked_at into v_session
  from public.synapse_sessions where token_hash = p_token_hash;
  if not found or v_session.revoked_at is not null or v_session.expires_at < now()
     or v_session.user_id is distinct from p_profile_id then
    return jsonb_build_object('ok', false, 'status', 401, 'error', 'Session expired');
  end if;

  select id, email, role, full_name, tenant_id, hospital_id into v_profile
  from public.profiles where id = p_profile_id and coalesce(is_deleted, false) = false;
  if not found or v_profile.tenant_id is null then
    return jsonb_build_object('ok', false, 'status', 403, 'error', 'No tenant context');
  end if;

  select id, slug, name, facility_type into v_tenant from public.tenants where id = v_profile.tenant_id;
  v_facility := coalesce(v_tenant.facility_type, 'hospital');
  v_platform := v_profile.role in ('platform_admin', 'superadmin');
  if v_facility not in ('hospital', 'laboratory') and not v_platform then
    return jsonb_build_object('ok', false, 'status', 403, 'error', 'Hospital or laboratory facility required');
  end if;

  v_hospital_id := v_profile.hospital_id;
  if v_hospital_id is null and v_tenant.slug is not null then
    select id into v_hospital_id from public.hospitals where subdomain = v_tenant.slug limit 1;
  end if;
  if v_hospital_id is null then
    return jsonb_build_object('ok', false, 'status', 403, 'error', 'No hospital context');
  end if;

  -- Same rule as requireCapability(): platform operators bypass only outside
  -- hospital facilities.
  if p_resource is not null and not (v_platform and v_facility <> 'hospital') and not public.has_capability(
       v_profile.role, v_facility, 'lab', p_resource, p_action) then
    return jsonb_build_object('ok', false, 'status', 403, 'error', 'Forbidden',
      'capability', 'lab.' || p_resource || '.' || p_action);
  end if;

  select coalesce(bool_or(is_active), false) into v_module_active
  from public.hospital_modules where hospital_id = v_hospital_id and module_key = 'lab';
  if not v_module_active then
    return jsonb_build_object('ok', false, 'status', 403, 'error', 'module_disabled', 'module_key', 'lab',
      'message', 'Module ''lab'' is not enabled for this facility.');
  end if;

  select entry->>'feature_key' into v_feature
  from public.platform_billing_config cfg,
       jsonb_array_elements(case when jsonb_typeof(cfg.value) = 'array' then cfg.value else '[]'::jsonb end) entry
  where cfg.key = 'hospital_module_registry' and entry->>'key' = 'lab'
  limit 1;
  if v_feature is not null and not public.has_feature(v_profile.tenant_id, v_feature) then
    return jsonb_build_object('ok', false, 'status', 402, 'error', 'subscription_required', 'feature', v_feature);
  end if;

  return jsonb_build_object(
    'ok', true,
    'ctx', jsonb_build_object(
      'userId', v_profile.id,
      'email', coalesce(v_profile.email, ''),
      'role', v_profile.role,
      'tenantId', v_profile.tenant_id,
      'hospitalId', v_hospital_id,
      'facilityType', v_facility,
      'facilityName', v_tenant.name,
      'fullName', v_profile.full_name
    )
  );
end;
$$;

revoke all on function public.lab_access(text, uuid, text, text) from public, anon, authenticated;
grant execute on function public.lab_access(text, uuid, text, text) to service_role;

-- ---------------------------------------------------------------------------
-- 8. lab_order_bundle: everything one action needs, one round trip
-- ---------------------------------------------------------------------------

create or replace function public.lab_order_bundle(
  p_tenant_id uuid,
  p_order_id uuid,
  p_hospital_id uuid default null
) returns jsonb
language sql
stable
set search_path = public
as $$
  select case when o.id is null then null else jsonb_build_object(
    'order', to_jsonb(o),
    'results', coalesce((
      select jsonb_agg(to_jsonb(r) order by r.version desc)
      from public.lab_results r
      where r.tenant_id = o.tenant_id and r.lab_order_id = o.id
    ), '[]'::jsonb),
    'specimen', (
      select to_jsonb(s) from public.lab_specimens s
      where s.tenant_id = o.tenant_id and (s.id = o.specimen_id or s.lab_order_id = o.id)
      order by (s.id = o.specimen_id) desc, s.created_at desc limit 1
    ),
    'patient', (
      select jsonb_build_object('id', p.id, 'fullName', p.full_name, 'mrn', p.mrn, 'sex', p.sex,
        'dob', p.dob, 'phone', p.phone, 'personId', p.person_id)
      from public.patients p where p.id = o.patient_id
    ),
    'encounterHospitalId', (select e.hospital_id from public.encounters e where e.id = o.encounter_id),
    'ranges', coalesce((
      select jsonb_agg(to_jsonb(rr) order by (rr.tenant_id is null), rr.sex nulls last, rr.age_min_years nulls last)
      from public.lab_reference_ranges rr
      where rr.loinc_code = o.loinc_code and (rr.tenant_id = o.tenant_id or rr.tenant_id is null)
    ), '[]'::jsonb),
    'catalog', (select to_jsonb(c) from public.lab_test_catalog c where c.id = o.catalog_test_id),
    -- Names for the printed report (who entered, who authorised).
    'people', coalesce((
      select jsonb_object_agg(pr.id, pr.full_name)
      from public.profiles pr
      where pr.id in (
        select x.person from public.lab_results r2,
          lateral (values (r2.verified_by), (r2.entered_by)) as x(person)
        where r2.tenant_id = o.tenant_id and r2.lab_order_id = o.id and x.person is not null)
    ), '{}'::jsonb),
    'latestReport', (
      select jsonb_build_object('id', lr.id, 'version', lr.version, 'status', lr.status)
      from public.lab_reports lr
      where lr.tenant_id = o.tenant_id and lr.lab_order_id = o.id
      order by lr.version desc limit 1
    )
  ) end
  from (select 1) one
  left join public.lab_orders o
    on o.id = p_order_id and o.tenant_id = p_tenant_id
   and (p_hospital_id is null or not exists (
         select 1 from public.encounters e
         where e.id = o.encounter_id and e.hospital_id is not null and e.hospital_id <> p_hospital_id));
$$;

revoke all on function public.lab_order_bundle(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.lab_order_bundle(uuid, uuid, uuid) to service_role;

-- ---------------------------------------------------------------------------
-- 9. lab_commit_action: one transaction for every write of one action
-- ---------------------------------------------------------------------------

create or replace function public.lab_commit_action(p jsonb)
returns jsonb
language plpgsql
set search_path = public
as $$
declare
  v_tenant uuid := (p->>'tenant_id')::uuid;
  v_order_id uuid := (p->>'order_id')::uuid;
  v_actor uuid := (p->>'actor_id')::uuid;
  o jsonb := p->'order';
  s jsonb := p->'specimen';
  sp jsonb := p->'specimen_patch';
  r jsonb := p->'result';
  a jsonb := p->'amendment';
  k jsonb := p->'ack';
  rep jsonb := p->'report';
  au jsonb := p->'audit';
  v_report_id uuid;
  v_status text;
begin
  if v_tenant is null or v_order_id is null or v_actor is null or o is null then
    raise exception 'LAB_COMMIT_INCOMPLETE' using errcode = 'LB400';
  end if;

  -- Specimen first: the order points at it.
  if s is not null and s <> 'null'::jsonb then
    insert into public.lab_specimens as ls (
      id, tenant_id, patient_id, person_id, encounter_id, lab_order_id, accession_number,
      barcode, specimen_type, container, status, collected_at, collected_by, updated_at)
    values (
      (s->>'id')::uuid, v_tenant, (s->>'patient_id')::uuid, nullif(s->>'person_id', '')::uuid,
      (s->>'encounter_id')::uuid, v_order_id, s->>'accession_number', s->>'barcode',
      coalesce(s->>'specimen_type', 'blood'), s->>'container', 'collected',
      coalesce((s->>'collected_at')::timestamptz, now()), v_actor, now())
    on conflict (id) do nothing;
  end if;

  update public.lab_orders set
    workflow_status = o->>'workflow_status',
    status = o->>'status',
    accession_number = o->>'accession_number',
    barcode = o->>'barcode',
    specimen_id = nullif(o->>'specimen_id', '')::uuid,
    rejection_reason = o->>'rejection_reason',
    rejection_note = o->>'rejection_note',
    collected_at = case when o->>'workflow_status' = 'COLLECTED' then coalesce(collected_at, now()) else collected_at end,
    resulted_at = case when o->>'workflow_status' in ('RESULT_ENTERED', 'VERIFICATION_PENDING') then now() else resulted_at end,
    -- verify, or verify + release in one step (authorise)
    verified_at = case when o->>'workflow_status' in ('VERIFIED', 'RELEASED') and verified_at is null then now() else verified_at end,
    verified_by = case when o->>'workflow_status' in ('VERIFIED', 'RELEASED') and verified_by is null then v_actor else verified_by end
  where id = v_order_id and tenant_id = v_tenant
    and coalesce(workflow_status, 'ORDERED') = p->>'expected_status'
  returning workflow_status into v_status;

  if not found then
    raise exception 'LAB_STALE_ORDER' using errcode = 'LB409',
      detail = 'The order changed since it was loaded; reload and try again.';
  end if;

  if sp is not null and sp <> 'null'::jsonb then
    update public.lab_specimens set
      status = coalesce(sp->>'status', status),
      received_at = case when sp->>'status' = 'in_lab' then coalesce(received_at, now()) else received_at end,
      condition = coalesce(sp->>'condition', condition),
      updated_at = now()
    where tenant_id = v_tenant and lab_order_id = v_order_id
      and (sp->>'id' is null or id = (sp->>'id')::uuid);
  end if;

  if r is not null and r <> 'null'::jsonb then
    insert into public.lab_results as lr (
      id, tenant_id, lab_order_id, patient_id, encounter_id, loinc_code, test_name, value,
      result_value, unit, reference_range, status, is_critical, is_abnormal, numeric_value,
      flag, abnormal_flag, analyzer, verified_by, verified_at, provenance, result_source,
      version, is_synthetic, released_to_patient_at, entered_by, lab_technician_id, entered_at, notes)
    values (
      (r->>'id')::uuid, v_tenant, v_order_id, (r->>'patient_id')::uuid, (r->>'encounter_id')::uuid,
      r->>'loinc_code', r->>'test_name', r->>'value', r->>'result_value', r->>'unit',
      r->>'reference_range', r->>'status', coalesce((r->>'is_critical')::boolean, false),
      coalesce((r->>'is_abnormal')::boolean, false), (r->>'numeric_value')::numeric,
      r->>'flag', r->>'abnormal_flag', r->>'analyzer', nullif(r->>'verified_by', '')::uuid,
      (r->>'verified_at')::timestamptz, r->>'provenance', r->>'result_source',
      coalesce((r->>'version')::integer, 1), coalesce((r->>'is_synthetic')::boolean, false),
      (r->>'released_to_patient_at')::timestamptz, nullif(r->>'entered_by', '')::uuid,
      nullif(r->>'entered_by', '')::uuid, case when r ? 'entered_by' then now() else null end,
      r->>'notes')
    on conflict (id) do update set
      value = excluded.value,
      result_value = excluded.result_value,
      unit = excluded.unit,
      reference_range = excluded.reference_range,
      status = excluded.status,
      is_critical = excluded.is_critical,
      is_abnormal = excluded.is_abnormal,
      numeric_value = excluded.numeric_value,
      flag = excluded.flag,
      abnormal_flag = excluded.abnormal_flag,
      analyzer = coalesce(excluded.analyzer, lr.analyzer),
      verified_by = coalesce(excluded.verified_by, lr.verified_by),
      verified_at = coalesce(excluded.verified_at, lr.verified_at),
      provenance = excluded.provenance,
      result_source = coalesce(excluded.result_source, lr.result_source),
      version = excluded.version,
      released_to_patient_at = coalesce(excluded.released_to_patient_at, lr.released_to_patient_at),
      entered_by = coalesce(excluded.entered_by, lr.entered_by),
      lab_technician_id = coalesce(excluded.lab_technician_id, lr.lab_technician_id),
      entered_at = coalesce(excluded.entered_at, lr.entered_at),
      notes = coalesce(excluded.notes, lr.notes),
      updated_at = now()
    where lr.tenant_id = v_tenant and lr.lab_order_id = v_order_id;
  end if;

  if a is not null and a <> 'null'::jsonb then
    insert into public.lab_result_amendments (
      id, tenant_id, result_id, lab_order_id, previous_value, previous_status, new_value, reason, amended_by, amended_at)
    values (
      (a->>'id')::uuid, v_tenant, (a->>'result_id')::uuid, v_order_id, a->>'previous_value',
      a->>'previous_status', a->>'new_value', a->>'reason', v_actor, now())
    on conflict (id) do nothing;
  end if;

  if k is not null and k <> 'null'::jsonb then
    insert into public.lab_critical_acknowledgements (
      id, tenant_id, result_id, lab_order_id, patient_id, acknowledged_by, note)
    values (
      (k->>'id')::uuid, v_tenant, (k->>'result_id')::uuid, v_order_id, (k->>'patient_id')::uuid, v_actor, k->>'note')
    on conflict (id) do nothing;
    update public.lab_results set
      critical_scientist_ack_at = coalesce(critical_scientist_ack_at, now()),
      critical_scientist_ack_by = coalesce(critical_scientist_ack_by, v_actor)
    where id = (k->>'result_id')::uuid and tenant_id = v_tenant;
  end if;

  if rep is not null and rep <> 'null'::jsonb then
    insert into public.lab_reports (
      id, tenant_id, facility_id, patient_id, encounter_id, lab_order_id, clinical_result_id,
      accession, status, version, report_type, generated_at, generated_by, verified_by,
      released_at, supersedes_report_id, amendment_reason, template_version, html_snapshot, content_hash)
    values (
      (rep->>'id')::uuid, v_tenant, nullif(rep->>'facility_id', '')::uuid, (rep->>'patient_id')::uuid,
      nullif(rep->>'encounter_id', '')::uuid, v_order_id, (rep->>'clinical_result_id')::uuid,
      rep->>'accession', rep->>'status', (rep->>'version')::integer, 'LAB_RESULT',
      (rep->>'released_at')::timestamptz, v_actor, nullif(rep->>'verified_by', '')::uuid,
      (rep->>'released_at')::timestamptz,
      (select id from public.lab_reports where tenant_id = v_tenant and lab_order_id = v_order_id
        and version < (rep->>'version')::integer order by version desc limit 1),
      rep->>'amendment_reason', rep->>'template_version', rep->>'html_snapshot', rep->>'content_hash')
    on conflict (tenant_id, lab_order_id, version) do nothing
    returning id into v_report_id;
    if v_report_id is null then
      select id into v_report_id from public.lab_reports
      where tenant_id = v_tenant and lab_order_id = v_order_id and version = (rep->>'version')::integer;
    end if;
  end if;

  if au is not null and au <> 'null'::jsonb then
    insert into public.audit_log (tenant_id, user_id, user_role, action, table_name, record_id, new_value)
    values (v_tenant, v_actor, p->>'actor_role', au->>'action', coalesce(au->>'table_name', 'lab_orders'),
      coalesce(au->>'record_id', v_order_id::text), au->'new_value');
  end if;

  return jsonb_build_object('orderStatus', v_status, 'reportId', v_report_id);
end;
$$;

revoke all on function public.lab_commit_action(jsonb) from public, anon, authenticated;
grant execute on function public.lab_commit_action(jsonb) to service_role;

-- ---------------------------------------------------------------------------
-- 10. Starter catalogue for a new laboratory (no prices: the lab sets them)
-- ---------------------------------------------------------------------------

create or replace function public.lab_seed_starter_catalog(p_tenant_id uuid)
returns integer
language sql
set search_path = public
as $$
  with inserted as (
    insert into public.lab_test_catalog (tenant_id, code, loinc_code, name, section, specimen_type, container, unit, turnaround_minutes)
    values
      (p_tenant_id, 'FBC',   '58410-2', 'Full blood count',             'haematology',  'blood', 'EDTA (purple)',  null,      120),
      (p_tenant_id, 'HB',    '718-7',   'Haemoglobin',                  'haematology',  'blood', 'EDTA (purple)',  'g/dL',    60),
      (p_tenant_id, 'PLT',   '777-3',   'Platelet count',               'haematology',  'blood', 'EDTA (purple)',  '10*9/L',  60),
      (p_tenant_id, 'WBC',   '6690-2',  'White cell count',             'haematology',  'blood', 'EDTA (purple)',  '10*9/L',  60),
      (p_tenant_id, 'MRDT',  '58413-6', 'Malaria Pf antigen (RDT)',     'parasitology', 'blood', 'EDTA (purple)',  null,      30),
      (p_tenant_id, 'GLU',   '2345-7',  'Blood glucose',                'chemistry',    'blood', 'Fluoride (grey)','mmol/L',  30),
      (p_tenant_id, 'HBA1C', '4548-4',  'HbA1c',                        'chemistry',    'blood', 'EDTA (purple)',  '%',       240),
      (p_tenant_id, 'CREA',  '2160-0',  'Creatinine',                   'chemistry',    'blood', 'Plain (red)',    'umol/L',  240),
      (p_tenant_id, 'UREA',  '3094-0',  'Urea',                         'chemistry',    'blood', 'Plain (red)',    'mmol/L',  240),
      (p_tenant_id, 'NA',    '2951-2',  'Sodium',                       'chemistry',    'blood', 'Plain (red)',    'mmol/L',  240),
      (p_tenant_id, 'K',     '2823-3',  'Potassium',                    'chemistry',    'blood', 'Plain (red)',    'mmol/L',  240),
      (p_tenant_id, 'ALT',   '1742-6',  'ALT',                          'chemistry',    'blood', 'Plain (red)',    'U/L',     240),
      (p_tenant_id, 'TBIL',  '1975-2',  'Total bilirubin',              'chemistry',    'blood', 'Plain (red)',    'umol/L',  240),
      (p_tenant_id, 'CRP',   '1988-5',  'C-reactive protein',           'immunology',   'blood', 'Plain (red)',    'mg/L',    240),
      (p_tenant_id, 'HIV',   '75622-1', 'HIV 1+2 rapid test',           'serology',     'blood', 'EDTA (purple)',  null,      30),
      (p_tenant_id, 'HCG',   '2106-3',  'Pregnancy test (urine hCG)',   'serology',     'urine', 'Urine cup',      null,      30),
      (p_tenant_id, 'URINE', '24356-8', 'Urinalysis',                   'urinalysis',   'urine', 'Urine cup',      null,      60),
      (p_tenant_id, 'STOOL', '10701-0', 'Stool microscopy (ova/cysts)', 'parasitology', 'stool', 'Stool cup',      null,      120)
    on conflict do nothing
    returning 1
  )
  select count(*)::integer from inserted;
$$;

revoke all on function public.lab_seed_starter_catalog(uuid) from public, anon, authenticated;
grant execute on function public.lab_seed_starter_catalog(uuid) to service_role;

-- ---------------------------------------------------------------------------
-- 11. lab_create_walk_in: patient (new or existing) + visit + every test
--     ordered, in ONE transaction (the referral route used to insert three
--     times and delete by hand when a later insert failed)
-- ---------------------------------------------------------------------------

create or replace function public.lab_create_walk_in(p jsonb)
returns jsonb
language plpgsql
set search_path = public
as $$
declare
  v_tenant uuid := (p->>'tenant_id')::uuid;
  v_hospital uuid := (p->>'hospital_id')::uuid;
  v_actor uuid := (p->>'actor_id')::uuid;
  v_patient public.patients%rowtype;
  v_encounter uuid := gen_random_uuid();
  v_source text := coalesce(p->>'order_source', 'walk_in');
  v_urgency text := coalesce(p->>'urgency', 'ROUTINE');
  v_orders jsonb := '[]'::jsonb;
  v_test record;
  v_order_id uuid;
begin
  if v_tenant is null or v_hospital is null or v_actor is null then
    raise exception 'LAB_WALK_IN_INCOMPLETE' using errcode = 'LB400';
  end if;
  if v_source not in ('walk_in', 'referral') then
    raise exception 'LAB_WALK_IN_SOURCE' using errcode = 'LB400';
  end if;

  if nullif(p->'patient'->>'id', '') is not null then
    select * into v_patient from public.patients
    where id = (p->'patient'->>'id')::uuid and tenant_id = v_tenant and coalesce(is_deleted, false) = false;
    if not found then
      raise exception 'LAB_PATIENT_NOT_FOUND' using errcode = 'LB404';
    end if;
  else
    insert into public.patients (tenant_id, hospital_id, mrn, full_name, dob, sex, phone, is_deleted, is_synthetic, data_classification)
    values (v_tenant, v_hospital, p->'patient'->>'mrn', p->'patient'->>'full_name',
      nullif(p->'patient'->>'dob', '')::date, nullif(p->'patient'->>'sex', ''), nullif(p->'patient'->>'phone', ''),
      false, false, 'production')
    returning * into v_patient;
  end if;

  insert into public.encounters (id, tenant_id, hospital_id, patient_id, clinician_id, chief_complaint, metadata, correlation_id, status, is_deleted, is_synthetic)
  values (v_encounter, v_tenant, v_hospital, v_patient.id, v_actor,
    left(coalesce(p->>'chief_complaint', 'Laboratory visit'), 500),
    jsonb_build_object('encounter_type', case when v_source = 'referral' then 'LAB_REFERRAL' else 'LAB_WALK_IN' end,
      'referral_source', nullif(p->>'referral_source', '')),
    v_encounter, 'open', false, false);

  for v_test in
    select c.id as catalog_id, c.loinc_code, c.name, c.section, c.price, c.currency
    from jsonb_array_elements_text(coalesce(p->'catalog_ids', '[]'::jsonb)) as ids(id)
    join public.lab_test_catalog c on c.id = ids.id::uuid and c.tenant_id = v_tenant and c.is_active
    union all
    select null, t->>'loinc_code', t->>'test_name', null, null, null
    from jsonb_array_elements(coalesce(p->'free_tests', '[]'::jsonb)) as t
  loop
    v_order_id := gen_random_uuid();
    insert into public.lab_orders (id, tenant_id, encounter_id, patient_id, person_id, loinc_code, test_name, urgency,
      status, workflow_status, ordered_by, ordered_at, correlation_id, is_synthetic, data_classification,
      catalog_test_id, section, order_source, referral_source)
    values (v_order_id, v_tenant, v_encounter, v_patient.id, v_patient.person_id, v_test.loinc_code, v_test.name, v_urgency,
      'ordered', 'ORDERED', v_actor, now(), v_encounter, false, 'clinical',
      v_test.catalog_id, v_test.section, v_source, nullif(p->>'referral_source', ''));
    v_orders := v_orders || jsonb_build_object('id', v_order_id, 'testName', v_test.name, 'loincCode', v_test.loinc_code,
      'catalogTestId', v_test.catalog_id, 'price', v_test.price, 'currency', v_test.currency);
  end loop;

  if jsonb_array_length(v_orders) = 0 then
    raise exception 'LAB_WALK_IN_NO_TESTS' using errcode = 'LB400';
  end if;

  insert into public.audit_log (tenant_id, user_id, user_role, action, table_name, record_id, new_value)
  values (v_tenant, v_actor, p->>'actor_role', 'LAB_WALK_IN_REGISTERED', 'encounters', v_encounter::text,
    jsonb_build_object('patientId', v_patient.id, 'source', v_source, 'tests', jsonb_array_length(v_orders),
      'newPatient', nullif(p->'patient'->>'id', '') is null));

  return jsonb_build_object(
    'patient', jsonb_build_object('id', v_patient.id, 'mrn', v_patient.mrn, 'full_name', v_patient.full_name),
    'encounterId', v_encounter,
    'orders', v_orders);
end;
$$;

revoke all on function public.lab_create_walk_in(jsonb) from public, anon, authenticated;
grant execute on function public.lab_create_walk_in(jsonb) to service_role;

commit;
