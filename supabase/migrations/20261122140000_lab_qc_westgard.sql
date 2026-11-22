-- 20261122140000_lab_qc_westgard
--
-- PREPARED ONLY — NOT APPLIED TO ANY DATABASE BY THIS CHANGE.
--
-- Internal quality control (IQC) with Westgard multirules.
--
--   lab_qc_materials   one control level of one analyte (LOINC): lot, level,
--                      target mean and SD, expiry, optional analyser. Holds the
--                      status of its latest run, so the release guard is one
--                      indexed lookup.
--   lab_qc_runs        one measured control value: z-score, the rules it broke,
--                      accepted / warning / rejected, and the corrective action
--                      written against a rejection. Levels measured together
--                      share a batch_id.
--
-- Functions (service_role only, SECURITY INVOKER):
--   lab_qc_record(p)   validates the materials, evaluates the Westgard rules
--                      and writes the runs, the material status and the audit
--                      row in ONE transaction. The material rows are locked, so
--                      two benches recording the same control are evaluated
--                      one after the other, never against stale history.
--
-- Rules (z = (value - mean) / SD):
--   1_2s  warning   one control beyond 2 SD
--   1_3s  reject    one control beyond 3 SD
--   2_2s  reject    two controls beyond 2 SD on the same side: the same level
--                   in two consecutive runs, or two levels in one batch
--   R_4s  reject    in one batch, one level beyond +2 SD and another beyond
--                   -2 SD
--   4_1s  reject    four consecutive runs of one level beyond 1 SD, same side
--   10_x  reject    ten consecutive runs of one level on the same side of the
--                   mean
-- History for 2_2s, 4_1s and 10_x is the level's runs since its last rejection:
-- a rejection is followed by corrective action, and the rules start again.
--
-- Release guard: while any active control of an analyte has a rejected latest
-- run, a trigger on lab_orders refuses to move an order for that LOINC to
-- VERIFIED or RELEASED (LAB_QC_LOCKED, errcode LB423). Amendments are not
-- blocked: they correct results that were already released. The lock clears
-- when the failed level is run again and passes, or when the control is
-- switched off (for example, an expired lot).
--
-- Capabilities: lab.qc.record (bench staff), lab.qc.manage (set up controls:
-- lab scientists, lab admins, hospital admins).
--
-- Free-tier notes: every foreign key is indexed; rule history reads at most
-- the last 10 runs of a level through (material_id, run_at desc, id desc).

begin;

-- ---------------------------------------------------------------------------
-- 1. Control materials
-- ---------------------------------------------------------------------------

create table if not exists public.lab_qc_materials (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  loinc_code text not null check (loinc_code ~ '^[0-9]{1,7}-[0-9]$'),
  analyte_name text not null check (char_length(analyte_name) between 2 and 200),
  unit text check (unit is null or char_length(unit) <= 40),
  material_name text not null check (char_length(material_name) between 2 and 200),
  lot_number text not null check (char_length(lot_number) between 1 and 60),
  level text not null check (level in ('L1', 'L2', 'L3')),
  target_mean numeric not null,
  target_sd numeric not null check (target_sd > 0),
  expires_on date,
  device_id uuid references public.lab_devices(id) on delete set null,
  is_active boolean not null default true,
  last_run_at timestamptz,
  last_run_status text check (last_run_status in ('accepted', 'warning', 'rejected')),
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- One active control per analyte, level and lot.
create unique index if not exists lab_qc_materials_active_uidx
  on public.lab_qc_materials (tenant_id, loinc_code, level, lot_number)
  where is_active;
create index if not exists lab_qc_materials_lock_idx
  on public.lab_qc_materials (tenant_id, loinc_code)
  where is_active and last_run_status = 'rejected';
create index if not exists lab_qc_materials_device_id_idx on public.lab_qc_materials (device_id) where device_id is not null;
create index if not exists lab_qc_materials_created_by_idx on public.lab_qc_materials (created_by) where created_by is not null;

alter table public.lab_qc_materials enable row level security;
alter table public.lab_qc_materials force row level security;
revoke all on public.lab_qc_materials from public, anon;
revoke insert, update, delete, truncate on public.lab_qc_materials from authenticated;
grant select on public.lab_qc_materials to authenticated;
grant all on public.lab_qc_materials to service_role;

drop policy if exists lab_qc_materials_tenant_read on public.lab_qc_materials;
create policy lab_qc_materials_tenant_read on public.lab_qc_materials
  for select to authenticated
  using (tenant_id = (select public.current_tenant_id()) or (select public.is_platform_admin()));

-- ---------------------------------------------------------------------------
-- 2. Control runs
-- ---------------------------------------------------------------------------

create table if not exists public.lab_qc_runs (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  material_id uuid not null references public.lab_qc_materials(id) on delete cascade,
  batch_id uuid not null,
  value numeric not null,
  target_mean numeric not null,
  target_sd numeric not null check (target_sd > 0),
  z_score numeric not null,
  rules text[] not null default '{}',
  status text not null check (status in ('accepted', 'warning', 'rejected')),
  comment text check (comment is null or char_length(comment) <= 500),
  corrective_action text check (corrective_action is null or char_length(corrective_action) <= 1000),
  corrected_by uuid references public.profiles(id) on delete set null,
  corrected_at timestamptz,
  run_at timestamptz not null default now(),
  entered_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now()
);

create index if not exists lab_qc_runs_history_idx on public.lab_qc_runs (material_id, run_at desc, id desc);
create index if not exists lab_qc_runs_tenant_idx on public.lab_qc_runs (tenant_id, run_at desc);
create index if not exists lab_qc_runs_batch_idx on public.lab_qc_runs (batch_id);
create index if not exists lab_qc_runs_entered_by_idx on public.lab_qc_runs (entered_by) where entered_by is not null;
create index if not exists lab_qc_runs_corrected_by_idx on public.lab_qc_runs (corrected_by) where corrected_by is not null;

alter table public.lab_qc_runs enable row level security;
alter table public.lab_qc_runs force row level security;
revoke all on public.lab_qc_runs from public, anon;
revoke insert, update, delete, truncate on public.lab_qc_runs from authenticated;
grant select on public.lab_qc_runs to authenticated;
grant all on public.lab_qc_runs to service_role;

drop policy if exists lab_qc_runs_tenant_read on public.lab_qc_runs;
create policy lab_qc_runs_tenant_read on public.lab_qc_runs
  for select to authenticated
  using (tenant_id = (select public.current_tenant_id()) or (select public.is_platform_admin()));

-- ---------------------------------------------------------------------------
-- 3. lab_qc_record: evaluate Westgard rules and save a batch
-- ---------------------------------------------------------------------------
--
-- p = { tenant_id, actor_id, actor_role, comment?, run_at?,
--       results: [{ material_id, value }, ...] }   (1-3 levels of one analyte)

create or replace function public.lab_qc_record(p jsonb)
returns jsonb
language plpgsql
set search_path = public
as $$
declare
  v_tenant uuid := (p->>'tenant_id')::uuid;
  v_actor uuid := (p->>'actor_id')::uuid;
  v_batch uuid := gen_random_uuid();
  v_run_at timestamptz := coalesce(nullif(p->>'run_at', '')::timestamptz, now());
  v_comment text := nullif(btrim(coalesce(p->>'comment', '')), '');
  v_loinc text;
  v_item jsonb;
  v_mat public.lab_qc_materials;
  v_value numeric;
  v_z numeric;
  v_rules text[];
  v_status text;
  v_hist numeric[];
  v_n int;
  v_batch_status text := 'accepted';
  v_out jsonb := '[]'::jsonb;
  v_ids uuid[] := '{}';
  v_zs numeric[] := '{}';
  v_max numeric;
  v_min numeric;
  v_pos int;
  v_neg int;
  v_run_id uuid;
begin
  if v_tenant is null or v_actor is null or jsonb_typeof(p->'results') <> 'array' then
    raise exception 'LAB_QC_INCOMPLETE' using errcode = 'LB400';
  end if;
  v_n := jsonb_array_length(p->'results');
  if v_n < 1 or v_n > 3 then
    raise exception 'LAB_QC_LEVELS: record one to three control levels at a time' using errcode = 'LB400';
  end if;
  if v_run_at > now() + interval '5 minutes' then
    raise exception 'LAB_QC_FUTURE_RUN' using errcode = 'LB400';
  end if;

  -- Lock the materials (in a fixed order, so two batches cannot deadlock) and
  -- check them before anything is written.
  perform 1 from public.lab_qc_materials m
  where m.tenant_id = v_tenant
    and m.id in (select (e->>'material_id')::uuid from jsonb_array_elements(p->'results') e)
  order by m.id
  for update;

  if (select count(distinct e->>'material_id') from jsonb_array_elements(p->'results') e) <> v_n then
    raise exception 'LAB_QC_DUPLICATE_LEVEL' using errcode = 'LB400';
  end if;

  -- Pass 1: z-scores and the single-level rules.
  for v_item in select * from jsonb_array_elements(p->'results') loop
    select * into v_mat from public.lab_qc_materials
    where id = (v_item->>'material_id')::uuid and tenant_id = v_tenant;
    if not found then
      raise exception 'LAB_QC_MATERIAL_NOT_FOUND' using errcode = 'LB404';
    end if;
    if not v_mat.is_active then
      raise exception 'LAB_QC_MATERIAL_INACTIVE: % % is switched off', v_mat.analyte_name, v_mat.level using errcode = 'LB409';
    end if;
    if v_mat.expires_on is not null and v_mat.expires_on < v_run_at::date then
      raise exception 'LAB_QC_LOT_EXPIRED: lot % of % % expired on %', v_mat.lot_number, v_mat.analyte_name, v_mat.level, v_mat.expires_on using errcode = 'LB409';
    end if;
    if v_loinc is null then
      v_loinc := v_mat.loinc_code;
    elsif v_loinc <> v_mat.loinc_code then
      raise exception 'LAB_QC_MIXED_ANALYTES: record one analyte per batch' using errcode = 'LB400';
    end if;
    begin
      v_value := (v_item->>'value')::numeric;
    exception when others then
      raise exception 'LAB_QC_VALUE_INVALID: enter a number for % %', v_mat.analyte_name, v_mat.level using errcode = 'LB400';
    end;
    if v_value is null then
      raise exception 'LAB_QC_VALUE_INVALID: enter a number for % %', v_mat.analyte_name, v_mat.level using errcode = 'LB400';
    end if;

    v_z := round((v_value - v_mat.target_mean) / v_mat.target_sd, 4);
    v_rules := '{}';

    -- History since the last rejection, newest first, at most 9 runs.
    select coalesce(array_agg(h.z_score order by h.run_at desc, h.id desc), '{}') into v_hist
    from (
      select q.z_score, q.run_at, q.id from public.lab_qc_runs q
      where q.material_id = v_mat.id
        and q.run_at > coalesce((select max(x.run_at) from public.lab_qc_runs x where x.material_id = v_mat.id and x.status = 'rejected'), '-infinity'::timestamptz)
        and q.run_at <= v_run_at
      order by q.run_at desc, q.id desc
      limit 9
    ) h;

    if abs(v_z) > 3 then v_rules := v_rules || '1_3s'::text; end if;
    if coalesce(array_length(v_hist, 1), 0) >= 1
       and ((v_z > 2 and v_hist[1] > 2) or (v_z < -2 and v_hist[1] < -2)) then
      v_rules := v_rules || '2_2s'::text;
    end if;
    if coalesce(array_length(v_hist, 1), 0) >= 3
       and ((v_z > 1 and v_hist[1] > 1 and v_hist[2] > 1 and v_hist[3] > 1)
         or (v_z < -1 and v_hist[1] < -1 and v_hist[2] < -1 and v_hist[3] < -1)) then
      v_rules := v_rules || '4_1s'::text;
    end if;
    if coalesce(array_length(v_hist, 1), 0) >= 9
       and ((v_z > 0 and (select bool_and(h > 0) from unnest(v_hist) h))
         or (v_z < 0 and (select bool_and(h < 0) from unnest(v_hist) h))) then
      v_rules := v_rules || '10_x'::text;
    end if;

    v_ids := v_ids || v_mat.id;
    v_zs := v_zs || v_z;
    v_out := v_out || jsonb_build_object('material_id', v_mat.id, 'value', v_value, 'mean', v_mat.target_mean, 'sd', v_mat.target_sd, 'z', v_z, 'rules', to_jsonb(v_rules));
  end loop;

  -- Pass 2: rules across the levels of this batch.
  if v_n >= 2 then
    select max(z), min(z) into v_max, v_min from unnest(v_zs) z;
    if v_max > 2 and v_min < -2 then
      for i in 0 .. v_n - 1 loop
        if (v_out->i->>'z')::numeric > 2 or (v_out->i->>'z')::numeric < -2 then
          v_out := jsonb_set(v_out, array[i::text, 'rules'], (v_out->i->'rules') || '"R_4s"');
        end if;
      end loop;
    end if;
    v_pos := (select count(*) from unnest(v_zs) z where z > 2);
    v_neg := (select count(*) from unnest(v_zs) z where z < -2);
    for i in 0 .. v_n - 1 loop
      v_z := (v_out->i->>'z')::numeric;
      if ((v_z > 2 and v_pos >= 2) or (v_z < -2 and v_neg >= 2)) and not (v_out->i->'rules') ? '2_2s' then
        v_out := jsonb_set(v_out, array[i::text, 'rules'], (v_out->i->'rules') || '"2_2s"');
      end if;
    end loop;
  end if;

  -- Pass 3: status, write.
  for i in 0 .. v_n - 1 loop
    v_z := (v_out->i->>'z')::numeric;
    v_rules := array(select jsonb_array_elements_text(v_out->i->'rules'));
    if array_length(v_rules, 1) is not null then
      v_status := 'rejected';
    elsif abs(v_z) > 2 then
      v_rules := array['1_2s'];
      v_status := 'warning';
    else
      v_status := 'accepted';
    end if;
    if v_status = 'rejected' or (v_status = 'warning' and v_batch_status = 'accepted') then
      v_batch_status := v_status;
    end if;

    insert into public.lab_qc_runs (tenant_id, material_id, batch_id, value, target_mean, target_sd, z_score, rules, status, comment, run_at, entered_by)
    values (v_tenant, (v_out->i->>'material_id')::uuid, v_batch, (v_out->i->>'value')::numeric,
      (v_out->i->>'mean')::numeric, (v_out->i->>'sd')::numeric, v_z, v_rules, v_status, v_comment, v_run_at, v_actor)
    returning id into v_run_id;

    -- The material keeps the status of its newest run (a back-dated entry does not overwrite it).
    update public.lab_qc_materials
    set last_run_at = v_run_at, last_run_status = v_status, updated_at = now()
    where id = (v_out->i->>'material_id')::uuid
      and (last_run_at is null or last_run_at <= v_run_at);

    v_out := jsonb_set(v_out, array[i::text], (v_out->i) || jsonb_build_object('id', v_run_id,'rules', to_jsonb(v_rules), 'status', v_status));
  end loop;

  insert into public.audit_log (tenant_id, user_id, user_role, action, table_name, record_id, new_value)
  values (v_tenant, v_actor, p->>'actor_role', 'LAB_QC_RECORDED', 'lab_qc_runs', v_batch::text,
    jsonb_build_object('loinc', v_loinc, 'status', v_batch_status, 'runs', v_out));

  return jsonb_build_object('batchId', v_batch, 'loinc', v_loinc, 'status', v_batch_status, 'runs', v_out);
end;
$$;

revoke all on function public.lab_qc_record(jsonb) from public, anon, authenticated;
grant execute on function public.lab_qc_record(jsonb) to service_role;

-- ---------------------------------------------------------------------------
-- 4. Release guard
-- ---------------------------------------------------------------------------

create or replace function public.lab_orders_qc_guard()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_names text;
begin
  if new.loinc_code is null
     or new.workflow_status is not distinct from old.workflow_status
     or new.workflow_status not in ('VERIFIED', 'RELEASED') then
    return new;
  end if;
  select string_agg(distinct m.analyte_name || ' ' || m.level, ', ') into v_names
  from public.lab_qc_materials m
  where m.tenant_id = new.tenant_id
    and m.loinc_code = new.loinc_code
    and m.is_active
    and m.last_run_status = 'rejected';
  if v_names is not null then
    raise exception 'LAB_QC_LOCKED: quality control failed for % — fix the cause and rerun the control before authorising', v_names
      using errcode = 'LB423';
  end if;
  return new;
end;
$$;

revoke all on function public.lab_orders_qc_guard() from public, anon, authenticated;

drop trigger if exists lab_orders_qc_guard on public.lab_orders;
create trigger lab_orders_qc_guard
  before update of workflow_status on public.lab_orders
  for each row execute function public.lab_orders_qc_guard();

-- ---------------------------------------------------------------------------
-- 5. Capabilities
-- ---------------------------------------------------------------------------

insert into public.capabilities (module, resource, action, description) values
  ('lab', 'qc', 'record', 'Record quality-control runs and corrective actions; view QC charts'),
  ('lab', 'qc', 'manage', 'Set up quality-control materials: lot, level, target mean and SD')
on conflict (module, resource, action) do nothing;

with grants(role, facility_type, action) as (
  values
    ('lab_tech', 'any', 'record'),
    ('lab_technician', 'any', 'record'),
    ('lab_scientist', 'any', 'record'),
    ('lab_scientist', 'any', 'manage'),
    ('lab_admin', 'any', 'record'),
    ('lab_admin', 'any', 'manage'),
    ('lab_manager', 'any', 'record'),
    ('lab_manager', 'any', 'manage'),
    ('lab_supervisor', 'any', 'record'),
    ('lab_supervisor', 'any', 'manage'),
    ('hospital_admin', 'hospital', 'record'),
    ('hospital_admin', 'hospital', 'manage')
)
insert into public.role_capabilities (role, facility_type, capability_id)
select g.role, g.facility_type, c.id
from grants g
join public.capabilities c on c.module = 'lab' and c.resource = 'qc' and c.action = g.action
on conflict (role, facility_type, capability_id) do nothing;

commit;
