-- Proof of 20261122090000_lab_panels on top of the core-flow scenario (03).
-- Every check raises on failure; the run prints LAB_PANELS_SCENARIO_PASS.
\set ON_ERROR_STOP on
set client_min_messages = warning;

\ir ../../../supabase/migrations/20261122090000_lab_panels.sql
-- Idempotent: applying it twice changes nothing and does not fail.
\ir ../../../supabase/migrations/20261122090000_lab_panels.sql

do $$
declare
  v jsonb; v_fbc uuid; v_lft uuid; v_patient uuid; v_enc uuid; v_n int; v_comp uuid; v_hb uuid;
  v_lab uuid := '11111111-1111-4111-8111-111111111111';
  v_admin uuid := 'b1111111-1111-4111-8111-111111111111';
  v_tech uuid := 'b2222222-2222-4222-8222-222222222222';
  v_spec uuid := 'c5555555-5555-4555-8555-555555555555';
begin
  -- existing FBC catalogue entry was given its components; LFT and RFT can be seeded
  if jsonb_array_length((select components from lab_test_catalog where tenant_id = v_lab and code = 'FBC')) <> 10 then raise exception 'FBC backfill'; end if;
  v_n := lab_seed_starter_catalog(v_lab);
  if v_n <> 2 then raise exception 'seed adds LFT and RFT only, got %', v_n; end if;
  if jsonb_array_length((select components from lab_test_catalog where tenant_id = v_lab and code = 'RFT')) <> 6 then raise exception 'RFT components'; end if;
  begin
    update lab_test_catalog set components = '{"not":"an array"}'::jsonb where tenant_id = v_lab and code = 'GLU';
    raise exception 'non-array components accepted';
  exception when check_violation then null; end;

  -- walk-in FBC: one panel order + 10 component orders, one charge
  v := lab_create_walk_in(jsonb_build_object(
    'tenant_id', v_lab, 'hospital_id', 'a1111111-1111-4111-8111-111111111111', 'actor_id', v_admin, 'actor_role', 'lab_admin',
    'patient', jsonb_build_object('full_name', 'Okello Peter', 'sex', 'M', 'dob', '1985-01-01', 'mrn', 'KLA-PANEL-1'),
    'catalog_ids', (select jsonb_agg(id) from lab_test_catalog where tenant_id = v_lab and code = 'FBC'),
    'order_source', 'walk_in'));
  if jsonb_array_length(v->'orders') <> 1 then raise exception 'walk-in returns (and so bills) the panel once: %', v->'orders'; end if;
  v_patient := (v->'patient'->>'id')::uuid; v_enc := (v->>'encounterId')::uuid;
  select id into v_fbc from lab_orders where encounter_id = v_enc and panel_order_id is null;
  if (select panel_code from lab_orders where id = v_fbc) <> 'FBC' then raise exception 'panel code on header'; end if;
  select count(*) into v_n from lab_orders where panel_order_id = v_fbc;
  if v_n <> 10 then raise exception 'FBC components: %', v_n; end if;
  if exists (select 1 from lab_orders where panel_order_id = v_fbc and (section <> 'haematology' or order_source <> 'walk_in' or patient_id <> v_patient or encounter_id <> v_enc or panel_code <> 'FBC' or loinc_code is null)) then raise exception 'component fields'; end if;
  if (select count(*) from lab_orders where encounter_id = v_enc) <> 11 then raise exception 'only header + components'; end if;
  -- components never expand again, even when their LOINC matches a catalogue test
  select id into v_hb from lab_orders where panel_order_id = v_fbc and loinc_code = '718-7';
  if (select catalog_test_id from lab_orders where id = v_hb) is null then raise exception 'component got catalogue entry by LOINC'; end if;
  if exists (select 1 from lab_orders where panel_order_id in (select id from lab_orders where panel_order_id = v_fbc)) then raise exception 'nested expansion'; end if;

  -- hospital-style insert of LFT (existing contract) expands too
  insert into lab_orders (tenant_id, encounter_id, patient_id, loinc_code, test_name, ordered_by, workflow_status, urgency)
  values (v_lab, v_enc, v_patient, '24325-3', 'LFT', v_admin, 'ORDERED', 'STAT') returning id into v_lft;
  if (select count(*) from lab_orders where panel_order_id = v_lft and section = 'chemistry' and urgency = 'STAT') <> 8 then raise exception 'LFT expansion'; end if;

  -- collecting the panel collects every component with the same accession and specimen
  perform lab_commit_action(jsonb_build_object('tenant_id', v_lab, 'order_id', v_fbc, 'actor_id', v_tech, 'expected_status', 'ORDERED',
    'order', jsonb_build_object('workflow_status', 'COLLECTED', 'status', 'collected', 'accession_number', 'LAB-20261122-000009', 'barcode', 'LAB-20261122-000009', 'specimen_id', v_spec),
    'specimen', jsonb_build_object('id', v_spec, 'patient_id', v_patient, 'encounter_id', v_enc, 'accession_number', 'LAB-20261122-000009', 'specimen_type', 'blood', 'container', 'EDTA (purple)'),
    'audit', jsonb_build_object('action', 'LAB_SPECIMEN_COLLECTED')));
  if exists (select 1 from lab_orders where panel_order_id = v_fbc and (workflow_status <> 'COLLECTED' or accession_number <> 'LAB-20261122-000009' or specimen_id <> v_spec or collected_at is null)) then raise exception 'collect propagation'; end if;

  perform lab_commit_action(jsonb_build_object('tenant_id', v_lab, 'order_id', v_fbc, 'actor_id', v_tech, 'expected_status', 'COLLECTED',
    'order', jsonb_build_object('workflow_status', 'RECEIVED', 'status', 'processing', 'accession_number', 'LAB-20261122-000009', 'specimen_id', v_spec),
    'specimen_patch', jsonb_build_object('status', 'in_lab'), 'audit', jsonb_build_object('action', 'LAB_SPECIMEN_RECEIVED')));
  if exists (select 1 from lab_orders where panel_order_id = v_fbc and workflow_status <> 'RECEIVED') then raise exception 'receive propagation'; end if;

  -- a component result moves the panel to PROCESSING; the other components stay RECEIVED
  perform lab_commit_action(jsonb_build_object('tenant_id', v_lab, 'order_id', v_hb, 'actor_id', v_tech, 'expected_status', 'RECEIVED',
    'order', jsonb_build_object('workflow_status', 'VERIFICATION_PENDING', 'status', 'resulted', 'accession_number', 'LAB-20261122-000009', 'specimen_id', v_spec),
    'result', jsonb_build_object('id', gen_random_uuid(), 'patient_id', v_patient, 'encounter_id', v_enc, 'loinc_code', '718-7', 'test_name', 'Haemoglobin', 'value', '9.1', 'result_value', '9.1', 'unit', 'g/dL', 'status', 'preliminary', 'version', 1, 'entered_by', v_tech),
    'audit', jsonb_build_object('action', 'LAB_RESULT_ENTERED')));
  if (select workflow_status from lab_orders where id = v_fbc) <> 'PROCESSING' then raise exception 'panel processing: %', (select workflow_status from lab_orders where id = v_fbc); end if;
  if (select count(*) from lab_orders where panel_order_id = v_fbc and workflow_status = 'RECEIVED') <> 9 then raise exception 'siblings untouched'; end if;

  -- rejecting the panel now must not move the resulted component
  update lab_orders set workflow_status = 'REJECTED', rejection_reason = 'HAEMOLYSED' where id = v_lft;
  if (select count(*) from lab_orders where panel_order_id = v_lft and workflow_status = 'REJECTED' and rejection_reason = 'HAEMOLYSED') <> 8 then raise exception 'reject propagation'; end if;

  -- every FBC component released (one cancelled) -> panel RELEASED with verified_at
  update lab_orders set workflow_status = 'CANCELLED' where panel_order_id = v_fbc and loinc_code = '731-0';
  update lab_orders set workflow_status = 'RELEASED' where panel_order_id = v_fbc and workflow_status <> 'CANCELLED';
  if (select workflow_status from lab_orders where id = v_fbc) <> 'RELEASED' or (select verified_at from lab_orders where id = v_fbc) is null then raise exception 'panel release rollup'; end if;
  if (select workflow_status from lab_orders where id = v_hb) <> 'RELEASED' then raise exception 'component release'; end if;

  -- a panel with every component cancelled is not "released"
  insert into lab_orders (tenant_id, encounter_id, patient_id, loinc_code, test_name, ordered_by, workflow_status)
  values (v_lab, v_enc, v_patient, '24362-6', 'RFT', v_admin, 'ORDERED') returning id into v_comp;
  update lab_orders set workflow_status = 'CANCELLED' where id = v_comp;
  if exists (select 1 from lab_orders where panel_order_id = v_comp and workflow_status <> 'CANCELLED') then raise exception 'cancel propagation'; end if;
  if (select workflow_status from lab_orders where id = v_comp) <> 'CANCELLED' then raise exception 'cancelled panel moved'; end if;

  -- an ordinary test is untouched by all of this
  if exists (select 1 from lab_orders o where o.tenant_id = v_lab and o.loinc_code = '2345-7' and (o.panel_code is not null or o.panel_order_id is not null)) then raise exception 'ordinary test touched'; end if;
end $$;

do $$
begin
  if has_function_privilege('authenticated', 'public.lab_panel_components(text)', 'execute')
     or has_function_privilege('anon', 'public.lab_orders_expand_panel()', 'execute') then raise exception 'panel function grants too wide'; end if;
end $$;

select 'LAB_PANELS_SCENARIO_PASS' as result;
