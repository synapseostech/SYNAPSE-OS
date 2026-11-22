-- Lab panels (FBC, LFT, RFT/U&E): one sample, several tests.
--
-- A catalogue test with `components` is a panel. Ordering it, by any route
-- (OPD, walk-in, referral, consultation screen), inserts the panel order as
-- usual; this trigger then adds one component order per analyte, linked by
-- panel_order_id. Each component is an ordinary single-result order, so the
-- result, verification, report, amendment and critical-value flow is
-- unchanged and analyser results land per analyte (matched by LOINC).
--
-- The panel order carries the sample: collecting, receiving, rejecting or
-- cancelling it moves its pre-analytic components with it (same accession,
-- same specimen) in the same transaction. Its status then follows the
-- components: PROCESSING once any is resulted, RELEASED once every component
-- is released, amended, rejected or cancelled and at least one was released.
--
-- Billing is unchanged: the panel order is priced once; components are not
-- billed (they are inserted here, not by the routes that bill).
-- Production had 0 lab orders when this was written. Idempotent.

begin;

alter table public.lab_test_catalog
  add column if not exists components jsonb not null default '[]'::jsonb;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'lab_test_catalog_components_array') then
    alter table public.lab_test_catalog
      add constraint lab_test_catalog_components_array
      check (jsonb_typeof(components) = 'array' and jsonb_array_length(components) <= 40);
  end if;
end $$;

alter table public.lab_orders
  add column if not exists panel_order_id uuid references public.lab_orders(id) on delete cascade,
  add column if not exists panel_code text;

create index if not exists lab_orders_panel_idx
  on public.lab_orders (tenant_id, panel_order_id)
  where panel_order_id is not null;

-- ---------------------------------------------------------------------------
-- Expand a panel order into its component orders.
-- ---------------------------------------------------------------------------
create or replace function public.lab_orders_expand_panel()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_code text;
  v_components jsonb;
  c jsonb;
begin
  if new.panel_order_id is not null or new.catalog_test_id is null then
    return null;
  end if;
  select code, components into v_code, v_components
  from public.lab_test_catalog
  where id = new.catalog_test_id and tenant_id = new.tenant_id;
  if v_components is null or jsonb_array_length(v_components) = 0 then
    return null;
  end if;

  update public.lab_orders set panel_code = v_code where id = new.id and tenant_id = new.tenant_id;

  for c in select * from jsonb_array_elements(v_components) loop
    insert into public.lab_orders (
      tenant_id, encounter_id, patient_id, person_id, loinc_code, test_name, urgency,
      status, workflow_status, ordered_by, ordered_at, insurance_covered, correlation_id,
      care_plan_id, is_synthetic, simulation_run_id, data_classification, section,
      order_source, referral_source, panel_order_id, panel_code)
    values (
      new.tenant_id, new.encounter_id, new.patient_id, new.person_id,
      nullif(c->>'loinc', ''), coalesce(nullif(c->>'name', ''), 'Component'), new.urgency,
      new.status, new.workflow_status, new.ordered_by, new.ordered_at, new.insurance_covered,
      new.correlation_id, new.care_plan_id, new.is_synthetic, new.simulation_run_id,
      new.data_classification, coalesce(nullif(c->>'section', ''), new.section),
      new.order_source, new.referral_source, new.id, v_code);
  end loop;
  return null;
end;
$$;

revoke all on function public.lab_orders_expand_panel() from public, anon, authenticated;

drop trigger if exists lab_orders_expand_panel on public.lab_orders;
create trigger lab_orders_expand_panel
  after insert on public.lab_orders
  for each row execute function public.lab_orders_expand_panel();

-- ---------------------------------------------------------------------------
-- The panel order carries the sample: its pre-analytic steps move the
-- components that have not been resulted yet.
-- ---------------------------------------------------------------------------
create or replace function public.lab_orders_panel_propagate()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.panel_order_id is not null or new.panel_code is null then
    return null;
  end if;
  if new.workflow_status is not distinct from old.workflow_status
     and new.specimen_id is not distinct from old.specimen_id then
    return null;
  end if;
  if coalesce(new.workflow_status, 'ORDERED') not in
     ('COLLECTION_PENDING', 'COLLECTED', 'IN_TRANSIT', 'RECEIVED', 'REJECTED', 'CANCELLED') then
    return null;
  end if;

  update public.lab_orders c set
    workflow_status = new.workflow_status,
    status = new.status,
    accession_number = new.accession_number,
    barcode = new.barcode,
    specimen_id = new.specimen_id,
    collected_at = coalesce(c.collected_at, new.collected_at),
    rejection_reason = case when new.workflow_status = 'REJECTED' then new.rejection_reason else c.rejection_reason end,
    rejection_note = case when new.workflow_status = 'REJECTED' then new.rejection_note else c.rejection_note end
  where c.panel_order_id = new.id
    and c.tenant_id = new.tenant_id
    and coalesce(c.workflow_status, 'ORDERED') in
        ('ORDERED', 'COLLECTION_PENDING', 'COLLECTED', 'IN_TRANSIT', 'RECEIVED');
  return null;
end;
$$;

revoke all on function public.lab_orders_panel_propagate() from public, anon, authenticated;

drop trigger if exists lab_orders_panel_propagate on public.lab_orders;
create trigger lab_orders_panel_propagate
  after update of workflow_status, specimen_id on public.lab_orders
  for each row execute function public.lab_orders_panel_propagate();

-- ---------------------------------------------------------------------------
-- The panel's status follows its components once results arrive.
-- ---------------------------------------------------------------------------
create or replace function public.lab_orders_panel_rollup()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_total integer;
  v_done integer;
  v_released integer;
  v_started integer;
  v_target text;
begin
  if new.panel_order_id is null or new.workflow_status is not distinct from old.workflow_status then
    return null;
  end if;

  select count(*),
         count(*) filter (where workflow_status in ('RELEASED', 'AMENDED', 'REJECTED', 'CANCELLED')),
         count(*) filter (where workflow_status in ('RELEASED', 'AMENDED')),
         count(*) filter (where workflow_status in ('PROCESSING', 'RESULT_ENTERED', 'VERIFICATION_PENDING', 'VERIFIED', 'RELEASED', 'AMENDED'))
    into v_total, v_done, v_released, v_started
  from public.lab_orders
  where panel_order_id = new.panel_order_id and tenant_id = new.tenant_id;

  if v_done = v_total and v_released > 0 then
    v_target := 'RELEASED';
  elsif v_started > 0 then
    v_target := 'PROCESSING';
  else
    return null;
  end if;

  update public.lab_orders set
    workflow_status = v_target,
    status = case when v_target = 'RELEASED' then 'verified' else 'processing' end,
    resulted_at = case when v_target = 'RELEASED' then coalesce(resulted_at, now()) else resulted_at end,
    verified_at = case when v_target = 'RELEASED' then coalesce(verified_at, now()) else verified_at end
  where id = new.panel_order_id
    and tenant_id = new.tenant_id
    and workflow_status is distinct from v_target
    and coalesce(workflow_status, 'ORDERED') not in ('REJECTED', 'CANCELLED');
  return null;
end;
$$;

revoke all on function public.lab_orders_panel_rollup() from public, anon, authenticated;

drop trigger if exists lab_orders_panel_rollup on public.lab_orders;
create trigger lab_orders_panel_rollup
  after update of workflow_status on public.lab_orders
  for each row execute function public.lab_orders_panel_rollup();

-- ---------------------------------------------------------------------------
-- Starter catalogue: FBC becomes a panel; LFT and RFT/U&E are added.
-- Components carry LOINC, so reference ranges and analyser mappings apply.
-- ---------------------------------------------------------------------------
create or replace function public.lab_panel_components(p_code text)
returns jsonb
language sql
immutable
set search_path = public
as $$
  select case upper(p_code)
    when 'FBC' then jsonb_build_array(
      jsonb_build_object('loinc', '6690-2', 'name', 'White cell count', 'unit', '10*9/L'),
      jsonb_build_object('loinc', '789-8', 'name', 'Red cell count', 'unit', '10*12/L'),
      jsonb_build_object('loinc', '718-7', 'name', 'Haemoglobin', 'unit', 'g/dL'),
      jsonb_build_object('loinc', '4544-3', 'name', 'Haematocrit', 'unit', '%'),
      jsonb_build_object('loinc', '787-2', 'name', 'MCV', 'unit', 'fL'),
      jsonb_build_object('loinc', '785-6', 'name', 'MCH', 'unit', 'pg'),
      jsonb_build_object('loinc', '786-4', 'name', 'MCHC', 'unit', 'g/dL'),
      jsonb_build_object('loinc', '777-3', 'name', 'Platelet count', 'unit', '10*9/L'),
      jsonb_build_object('loinc', '751-8', 'name', 'Neutrophils', 'unit', '10*9/L'),
      jsonb_build_object('loinc', '731-0', 'name', 'Lymphocytes', 'unit', '10*9/L'))
    when 'LFT' then jsonb_build_array(
      jsonb_build_object('loinc', '1742-6', 'name', 'ALT', 'unit', 'U/L'),
      jsonb_build_object('loinc', '1920-8', 'name', 'AST', 'unit', 'U/L'),
      jsonb_build_object('loinc', '6768-6', 'name', 'Alkaline phosphatase', 'unit', 'U/L'),
      jsonb_build_object('loinc', '2324-2', 'name', 'GGT', 'unit', 'U/L'),
      jsonb_build_object('loinc', '1975-2', 'name', 'Total bilirubin', 'unit', 'umol/L'),
      jsonb_build_object('loinc', '1968-7', 'name', 'Direct bilirubin', 'unit', 'umol/L'),
      jsonb_build_object('loinc', '2885-2', 'name', 'Total protein', 'unit', 'g/L'),
      jsonb_build_object('loinc', '1751-7', 'name', 'Albumin', 'unit', 'g/L'))
    when 'RFT' then jsonb_build_array(
      jsonb_build_object('loinc', '2951-2', 'name', 'Sodium', 'unit', 'mmol/L'),
      jsonb_build_object('loinc', '2823-3', 'name', 'Potassium', 'unit', 'mmol/L'),
      jsonb_build_object('loinc', '2075-0', 'name', 'Chloride', 'unit', 'mmol/L'),
      jsonb_build_object('loinc', '1963-8', 'name', 'Bicarbonate', 'unit', 'mmol/L'),
      jsonb_build_object('loinc', '3094-0', 'name', 'Urea', 'unit', 'mmol/L'),
      jsonb_build_object('loinc', '2160-0', 'name', 'Creatinine', 'unit', 'umol/L'))
    else '[]'::jsonb
  end;
$$;

revoke all on function public.lab_panel_components(text) from public, anon, authenticated;
grant execute on function public.lab_panel_components(text) to service_role;

-- Existing catalogues: an FBC entry with no components gets the standard ones.
update public.lab_test_catalog
   set components = public.lab_panel_components('FBC'), updated_at = now()
 where upper(code) = 'FBC' and components = '[]'::jsonb;

create or replace function public.lab_seed_starter_catalog(p_tenant_id uuid)
returns integer
language sql
set search_path = public
as $$
  with inserted as (
    insert into public.lab_test_catalog (tenant_id, code, loinc_code, name, section, specimen_type, container, unit, turnaround_minutes, components)
    values
      (p_tenant_id, 'FBC',   '58410-2', 'Full blood count',             'haematology',  'blood', 'EDTA (purple)',  null,      120, public.lab_panel_components('FBC')),
      (p_tenant_id, 'LFT',   '24325-3', 'Liver function tests',         'chemistry',    'blood', 'Plain (red)',    null,      240, public.lab_panel_components('LFT')),
      (p_tenant_id, 'RFT',   '24362-6', 'Renal function / U&E',         'chemistry',    'blood', 'Plain (red)',    null,      240, public.lab_panel_components('RFT')),
      (p_tenant_id, 'HB',    '718-7',   'Haemoglobin',                  'haematology',  'blood', 'EDTA (purple)',  'g/dL',    60,  '[]'::jsonb),
      (p_tenant_id, 'PLT',   '777-3',   'Platelet count',               'haematology',  'blood', 'EDTA (purple)',  '10*9/L',  60,  '[]'::jsonb),
      (p_tenant_id, 'WBC',   '6690-2',  'White cell count',             'haematology',  'blood', 'EDTA (purple)',  '10*9/L',  60,  '[]'::jsonb),
      (p_tenant_id, 'MRDT',  '58413-6', 'Malaria Pf antigen (RDT)',     'parasitology', 'blood', 'EDTA (purple)',  null,      30,  '[]'::jsonb),
      (p_tenant_id, 'GLU',   '2345-7',  'Blood glucose',                'chemistry',    'blood', 'Fluoride (grey)','mmol/L',  30,  '[]'::jsonb),
      (p_tenant_id, 'HBA1C', '4548-4',  'HbA1c',                        'chemistry',    'blood', 'EDTA (purple)',  '%',       240, '[]'::jsonb),
      (p_tenant_id, 'CREA',  '2160-0',  'Creatinine',                   'chemistry',    'blood', 'Plain (red)',    'umol/L',  240, '[]'::jsonb),
      (p_tenant_id, 'UREA',  '3094-0',  'Urea',                         'chemistry',    'blood', 'Plain (red)',    'mmol/L',  240, '[]'::jsonb),
      (p_tenant_id, 'NA',    '2951-2',  'Sodium',                       'chemistry',    'blood', 'Plain (red)',    'mmol/L',  240, '[]'::jsonb),
      (p_tenant_id, 'K',     '2823-3',  'Potassium',                    'chemistry',    'blood', 'Plain (red)',    'mmol/L',  240, '[]'::jsonb),
      (p_tenant_id, 'ALT',   '1742-6',  'ALT',                          'chemistry',    'blood', 'Plain (red)',    'U/L',     240, '[]'::jsonb),
      (p_tenant_id, 'TBIL',  '1975-2',  'Total bilirubin',              'chemistry',    'blood', 'Plain (red)',    'umol/L',  240, '[]'::jsonb),
      (p_tenant_id, 'CRP',   '1988-5',  'C-reactive protein',           'immunology',   'blood', 'Plain (red)',    'mg/L',    240, '[]'::jsonb),
      (p_tenant_id, 'HIV',   '75622-1', 'HIV 1+2 rapid test',           'serology',     'blood', 'EDTA (purple)',  null,      30,  '[]'::jsonb),
      (p_tenant_id, 'HCG',   '2106-3',  'Pregnancy test (urine hCG)',   'serology',     'urine', 'Urine cup',      null,      30,  '[]'::jsonb),
      (p_tenant_id, 'URINE', '24356-8', 'Urinalysis',                   'urinalysis',   'urine', 'Urine cup',      null,      60,  '[]'::jsonb),
      (p_tenant_id, 'STOOL', '10701-0', 'Stool microscopy (ova/cysts)', 'parasitology', 'stool', 'Stool cup',      null,      120, '[]'::jsonb)
    on conflict do nothing
    returning 1
  )
  select count(*)::integer from inserted;
$$;

revoke all on function public.lab_seed_starter_catalog(uuid) from public, anon, authenticated;
grant execute on function public.lab_seed_starter_catalog(uuid) to service_role;

commit;
