-- Proof of 20261122140000_lab_qc_westgard on top of the core-flow (03) and panel (04) scenarios.
-- Every check raises on failure; the run prints LAB_QC_SCENARIO_PASS.
\set ON_ERROR_STOP on
set client_min_messages = warning;

\ir ../../../supabase/migrations/20261122140000_lab_qc_westgard.sql
-- Idempotent: applying it twice changes nothing and does not fail.
\ir ../../../supabase/migrations/20261122140000_lab_qc_westgard.sql

-- Test helper: record one batch (levels and values in the same order), N hours ago.
create function pg_temp.qc(p_mats uuid[], p_vals text[], p_hours_ago numeric) returns jsonb language sql as $$
  select public.lab_qc_record(jsonb_build_object(
    'tenant_id', '11111111-1111-4111-8111-111111111111',
    'actor_id', 'b2222222-2222-4222-8222-222222222222', 'actor_role', 'lab_tech',
    'run_at', now() - make_interval(secs => p_hours_ago * 3600),
    'results', (select jsonb_agg(jsonb_build_object('material_id', m, 'value', v) order by o)
                from unnest(p_mats, p_vals) with ordinality as t(m, v, o))))
$$;
create function pg_temp.rules(v jsonb, i int) returns text[] language sql as $$
  select coalesce(array(select x from jsonb_array_elements_text(v->'runs'->i->'rules') x order by 1), '{}')
$$;
-- Expect lab_qc_record to fail with this SQLSTATE.
create function pg_temp.qc_fails(p jsonb, p_state text) returns void language plpgsql as $$
begin
  perform public.lab_qc_record(p);
  raise exception 'expected % for %', p_state, p;
exception when others then
  if sqlstate <> p_state then raise exception 'expected %, got % (%)', p_state, sqlstate, sqlerrm; end if;
end $$;

insert into lab_qc_materials (id, tenant_id, loinc_code, analyte_name, unit, material_name, lot_number, level, target_mean, target_sd, expires_on) values
  -- Haemoglobin: L1 mean 6.0 SD 0.2, L2 mean 12.0 SD 0.3
  ('d1111111-1111-4111-8111-111111111111', '11111111-1111-4111-8111-111111111111', '718-7', 'Haemoglobin', 'g/dL', 'Haematology control', 'H-2026-11', 'L1', 6.0, 0.2, current_date + 90),
  ('d2222222-2222-4222-8222-222222222222', '11111111-1111-4111-8111-111111111111', '718-7', 'Haemoglobin', 'g/dL', 'Haematology control', 'H-2026-11', 'L2', 12.0, 0.3, current_date + 90),
  -- Glucose L1 mean 5.5 SD 0.25
  ('d3333333-3333-4333-8333-333333333333', '11111111-1111-4111-8111-111111111111', '2345-7', 'Glucose', 'mmol/L', 'Chemistry control', 'C-77', 'L1', 5.5, 0.25, current_date + 90),
  -- an expired lot
  ('d4444444-4444-4444-8444-444444444444', '11111111-1111-4111-8111-111111111111', '718-7', 'Haemoglobin', 'g/dL', 'Haematology control', 'H-2026-08', 'L3', 16.0, 0.4, current_date - 1),
  -- another tenant's control
  ('d5555555-5555-4555-8555-555555555555', '22222222-2222-4222-8222-222222222222', '718-7', 'Haemoglobin', 'g/dL', 'Other control', 'X-1', 'L1', 6.0, 0.2, null);

do $$
declare
  v jsonb; v_order uuid; v_glu_order uuid; v_patient uuid; v_enc uuid; v_at timestamptz;
  v_lab uuid := '11111111-1111-4111-8111-111111111111';
  v_admin uuid := 'b1111111-1111-4111-8111-111111111111';
  l1 uuid := 'd1111111-1111-4111-8111-111111111111';
  l2 uuid := 'd2222222-2222-4222-8222-222222222222';
  glu uuid := 'd3333333-3333-4333-8333-333333333333';
  old_lot uuid := 'd4444444-4444-4444-8444-444444444444';
  foreign_mat uuid := 'd5555555-5555-4555-8555-555555555555';
  base jsonb := jsonb_build_object('tenant_id', '11111111-1111-4111-8111-111111111111', 'actor_id', 'b2222222-2222-4222-8222-222222222222');
begin
  -- set-up constraints
  begin
    insert into lab_qc_materials (tenant_id, loinc_code, analyte_name, material_name, lot_number, level, target_mean, target_sd)
    values (v_lab, '718-7', 'Haemoglobin', 'dup', 'H-2026-11', 'L1', 6, 0.2);
    raise exception 'duplicate active control accepted';
  exception when unique_violation then null; end;
  begin
    insert into lab_qc_materials (tenant_id, loinc_code, analyte_name, material_name, lot_number, level, target_mean, target_sd)
    values (v_lab, '718-7', 'Haemoglobin', 'zero sd', 'Z', 'L1', 6, 0);
    raise exception 'zero SD accepted';
  exception when check_violation then null; end;

  -- refused input writes nothing
  perform pg_temp.qc_fails(base || jsonb_build_object('results', jsonb_build_array(jsonb_build_object('material_id', foreign_mat, 'value', 6))), 'LB404');
  perform pg_temp.qc_fails(base || jsonb_build_object('results', jsonb_build_array(jsonb_build_object('material_id', old_lot, 'value', 16))), 'LB409');
  perform pg_temp.qc_fails(base || jsonb_build_object('results', jsonb_build_array(jsonb_build_object('material_id', l1, 'value', 6), jsonb_build_object('material_id', glu, 'value', 5.5))), 'LB400');
  perform pg_temp.qc_fails(base || jsonb_build_object('results', jsonb_build_array(jsonb_build_object('material_id', l1, 'value', 6), jsonb_build_object('material_id', l1, 'value', 6.1))), 'LB400');
  perform pg_temp.qc_fails(base || jsonb_build_object('results', jsonb_build_array(jsonb_build_object('material_id', l1, 'value', 'high'))), 'LB400');
  perform pg_temp.qc_fails(base || jsonb_build_object('results', '[]'::jsonb), 'LB400');
  perform pg_temp.qc_fails(base || jsonb_build_object('run_at', now() + interval '1 day', 'results', jsonb_build_array(jsonb_build_object('material_id', l1, 'value', 6))), 'LB400');
  if exists (select 1 from lab_qc_runs) then raise exception 'refused batch wrote runs'; end if;

  -- in control: both levels accepted, z-scores stored, audit row written
  v := pg_temp.qc(array[l1, l2], array['6.1', '11.8'], 100);
  if v->>'status' <> 'accepted' or (v->'runs'->0->>'z')::numeric <> 0.5 or (v->'runs'->1->>'z')::numeric <> round(-0.2 / 0.3, 4) then raise exception 'accepted batch: %', v; end if;
  if (select count(*) from lab_qc_runs where batch_id = (v->>'batchId')::uuid and status = 'accepted') <> 2 then raise exception 'batch rows'; end if;
  if (select last_run_status from lab_qc_materials where id = l1) <> 'accepted' then raise exception 'material status'; end if;
  if not exists (select 1 from audit_log where action = 'LAB_QC_RECORDED' and record_id = v->>'batchId') then raise exception 'audit row'; end if;

  -- 1_2s alone is a warning
  v := pg_temp.qc(array[l1], array['6.5'], 99);
  if v->>'status' <> 'warning' or pg_temp.rules(v, 0) <> array['1_2s'] then raise exception '1_2s: %', v; end if;

  -- 2_2s across runs: L1 beyond +2 SD twice in a row
  v := pg_temp.qc(array[l1], array['6.45'], 98);
  if v->>'status' <> 'rejected' or pg_temp.rules(v, 0) <> array['2_2s'] then raise exception '2_2s across runs: %', v; end if;
  if (select last_run_status from lab_qc_materials where id = l1) <> 'rejected' then raise exception 'material not locked'; end if;

  -- the lock: a haemoglobin result cannot be authorised or released, by any path
  select patient_id, encounter_id into v_patient, v_enc from lab_orders where tenant_id = v_lab and panel_order_id is null limit 1;
  insert into lab_orders (tenant_id, encounter_id, patient_id, loinc_code, test_name, ordered_by, workflow_status)
  values (v_lab, v_enc, v_patient, '718-7', 'Haemoglobin', v_admin, 'RESULT_ENTERED') returning id into v_order;
  begin
    update lab_orders set workflow_status = 'VERIFIED' where id = v_order;
    raise exception 'verified while QC rejected';
  exception when sqlstate 'LB423' then
    if sqlerrm not like 'LAB_QC_LOCKED%Haemoglobin L1%' then raise exception 'lock message: %', sqlerrm; end if;
  end;
  begin
    perform lab_commit_action(jsonb_build_object('tenant_id', v_lab, 'order_id', v_order, 'actor_id', v_admin, 'expected_status', 'RESULT_ENTERED',
      'order', jsonb_build_object('workflow_status', 'RELEASED', 'status', 'verified'),
      'audit', jsonb_build_object('action', 'LAB_RESULT_AUTHORISED')));
    raise exception 'released through lab_commit_action while QC rejected';
  exception when sqlstate 'LB423' then null; end;
  if (select workflow_status from lab_orders where id = v_order) <> 'RESULT_ENTERED' then raise exception 'order moved'; end if;
  -- other moves, other analytes and other tenants are not blocked
  update lab_orders set workflow_status = 'VERIFICATION_PENDING' where id = v_order;
  update lab_orders set workflow_status = 'RESULT_ENTERED' where id = v_order;
  insert into lab_orders (tenant_id, encounter_id, patient_id, loinc_code, test_name, ordered_by, workflow_status)
  values (v_lab, v_enc, v_patient, '2345-7', 'Glucose', v_admin, 'RESULT_ENTERED') returning id into v_glu_order;
  update lab_orders set workflow_status = 'VERIFIED' where id = v_glu_order;

  -- corrective action, rerun passes: the lock clears and rule history restarts
  update lab_qc_runs set corrective_action = 'Recalibrated, fresh control vial', corrected_by = v_admin, corrected_at = now()
  where material_id = l1 and status = 'rejected';
  v := pg_temp.qc(array[l1], array['6.42'], 97);  -- +2.1 SD: would be 2_2s with the rejected run, but history restarted
  if v->>'status' <> 'warning' then raise exception 'history should restart after a rejection: %', v; end if;
  update lab_orders set workflow_status = 'VERIFIED' where id = v_order;

  -- a back-dated entry does not overwrite the newest status
  v := pg_temp.qc(array[l2], array['13.5'], 200);  -- +5 SD, 200 h ago
  if v->>'status' <> 'rejected' or pg_temp.rules(v, 0) <> array['1_3s'] then raise exception '1_3s: %', v; end if;
  if (select last_run_status from lab_qc_materials where id = l2) <> 'accepted' then raise exception 'back-dated run overwrote status'; end if;

  -- R_4s: one level beyond +2 SD, the other beyond -2 SD in one batch
  v := pg_temp.qc(array[l1, l2], array['6.5', '11.25'], 96);
  if v->>'status' <> 'rejected' or not ('R_4s' = any(pg_temp.rules(v, 0))) or not ('R_4s' = any(pg_temp.rules(v, 1))) then raise exception 'R_4s: %', v; end if;

  -- 2_2s within a batch: both levels beyond +2 SD
  v := pg_temp.qc(array[l1, l2], array['6.0', '12.0'], 95);  -- reset both
  if v->>'status' <> 'accepted' then raise exception 'reset batch: %', v; end if;
  v := pg_temp.qc(array[l1, l2], array['6.44', '12.65'], 94);
  if v->>'status' <> 'rejected' or pg_temp.rules(v, 0) <> array['2_2s'] or pg_temp.rules(v, 1) <> array['2_2s'] then raise exception '2_2s within batch: %', v; end if;

  -- 4_1s: four consecutive L2 runs beyond +1 SD
  v := pg_temp.qc(array[l2], array['12.36'], 90);
  v := pg_temp.qc(array[l2], array['12.4'], 89);
  v := pg_temp.qc(array[l2], array['12.33'], 88);
  if v->>'status' <> 'accepted' then raise exception '3 x 1s still accepted: %', v; end if;
  v := pg_temp.qc(array[l2], array['12.45'], 87);
  if v->>'status' <> 'rejected' or pg_temp.rules(v, 0) <> array['4_1s'] then raise exception '4_1s: %', v; end if;

  -- 10_x: ten consecutive glucose runs above the mean (each within 1 SD)
  for i in 1 .. 9 loop
    v := pg_temp.qc(array[glu], array['5.6'], 80 - i);
    if v->>'status' <> 'accepted' then raise exception 'run % of 10_x accepted early: %', i, v; end if;
  end loop;
  v := pg_temp.qc(array[glu], array['5.62'], 70);
  if v->>'status' <> 'rejected' or pg_temp.rules(v, 0) <> array['10_x'] then raise exception '10_x: %', v; end if;

  -- switching the failed control off (for example a used-up lot) clears the lock
  update lab_orders set workflow_status = 'RESULT_ENTERED' where id = v_glu_order;
  begin
    update lab_orders set workflow_status = 'RELEASED' where id = v_glu_order;
    raise exception 'glucose released while QC rejected';
  exception when sqlstate 'LB423' then null; end;
  update lab_qc_materials set is_active = false where id = glu;
  update lab_orders set workflow_status = 'RELEASED' where id = v_glu_order;
  perform pg_temp.qc_fails(base || jsonb_build_object('results', jsonb_build_array(jsonb_build_object('material_id', glu, 'value', 5.5))), 'LB409');

  -- capabilities
  if not has_capability('lab_tech', 'laboratory', 'lab', 'qc', 'record') or has_capability('lab_tech', 'laboratory', 'lab', 'qc', 'manage') then raise exception 'lab_tech qc grants'; end if;
  if not has_capability('lab_admin', 'hospital', 'lab', 'qc', 'manage') or not has_capability('hospital_admin', 'hospital', 'lab', 'qc', 'manage') then raise exception 'manager qc grants'; end if;
  if has_capability('doctor', 'hospital', 'lab', 'qc', 'record') or has_capability('receptionist', 'laboratory', 'lab', 'qc', 'record') then raise exception 'qc granted too widely'; end if;
end $$;

do $$
begin
  if has_function_privilege('authenticated', 'public.lab_qc_record(jsonb)', 'execute')
     or has_function_privilege('anon', 'public.lab_qc_record(jsonb)', 'execute')
     or has_function_privilege('authenticated', 'public.lab_orders_qc_guard()', 'execute') then raise exception 'qc function grants too wide'; end if;
  if has_table_privilege('authenticated', 'public.lab_qc_runs', 'insert') or has_table_privilege('authenticated', 'public.lab_qc_materials', 'update') then raise exception 'qc table writes open to API roles'; end if;
end $$;

select 'LAB_QC_SCENARIO_PASS' as result;
