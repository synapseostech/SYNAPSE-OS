-- End-to-end proof of 20261121093700_lab_core_flow against the stub schema.
-- Every check raises on failure; the run prints LAB_CORE_FLOW_SCENARIO_PASS.
\set ON_ERROR_STOP on
set client_min_messages = warning;

insert into tenants (id, slug, name, facility_type) values
  ('11111111-1111-4111-8111-111111111111', 'kla-lab', 'Kampala Diagnostics', 'laboratory'),
  ('22222222-2222-4222-8222-222222222222', 'other-hosp', 'Other Hospital', 'hospital');
insert into hospitals (id, name, subdomain, facility_kind) values
  ('a1111111-1111-4111-8111-111111111111', 'Kampala Diagnostics', 'kla-lab', 'laboratory'),
  ('a2222222-2222-4222-8222-222222222222', 'Other Hospital', 'other-hosp', 'hospital');
insert into hospital_modules (hospital_id, tenant_id, module_key, is_active) values
  ('a1111111-1111-4111-8111-111111111111', '11111111-1111-4111-8111-111111111111', 'lab', true),
  ('a2222222-2222-4222-8222-222222222222', '22222222-2222-4222-8222-222222222222', 'lab', false);
insert into profiles (id, full_name, role, email, tenant_id) values
  ('b1111111-1111-4111-8111-111111111111', 'Sarah Admin', 'lab_admin', 'a@x.test', '11111111-1111-4111-8111-111111111111'),
  ('b2222222-2222-4222-8222-222222222222', 'Tom Tech', 'lab_tech', 't@x.test', '11111111-1111-4111-8111-111111111111'),
  ('b3333333-3333-4333-8333-333333333333', 'Cash Ier', 'pharmacy_staff', 'c@x.test', '11111111-1111-4111-8111-111111111111'),
  ('b4444444-4444-4444-8444-444444444444', 'Other Doc', 'doctor', 'd@x.test', '22222222-2222-4222-8222-222222222222');
insert into synapse_sessions (user_id, token_hash, app, expires_at, revoked_at) values
  ('b1111111-1111-4111-8111-111111111111', 'hash-admin', 'web', now() + interval '1 hour', null),
  ('b2222222-2222-4222-8222-222222222222', 'hash-tech', 'web', now() + interval '1 hour', null),
  ('b3333333-3333-4333-8333-333333333333', 'hash-cash', 'web', now() + interval '1 hour', null),
  ('b2222222-2222-4222-8222-222222222222', 'hash-revoked', 'web', now() + interval '1 hour', now()),
  ('b4444444-4444-4444-8444-444444444444', 'hash-doc', 'web', now() + interval '1 hour', null);
-- existing production grants the migration builds on (subset)
insert into capabilities (module, resource, action) values ('lab','order','read'),('lab','order','create'),('lab','specimen','collect'),('lab','result','enter'),('lab','result','verify'),('lab','result','read')
  on conflict do nothing;
insert into role_capabilities (role, facility_type, capability_id)
  select r, f, c.id from (values ('lab_admin','laboratory','order','read'),('lab_admin','laboratory','order','create'),('lab_admin','laboratory','specimen','collect'),('lab_admin','laboratory','result','enter'),('lab_admin','laboratory','result','verify'),('lab_tech','hospital','result','verify')) g(r,f,res,act)
  join capabilities c on c.module='lab' and c.resource=g.res and c.action=g.act on conflict do nothing;

\ir ../../../supabase/migrations/20261121093700_lab_core_flow.sql

do $$
declare
  v jsonb; v2 jsonb; v_order uuid; v_order2 uuid; v_patient uuid; v_enc uuid; v_n int; v_result uuid := gen_random_uuid();
  v_lab uuid := '11111111-1111-4111-8111-111111111111';
  v_admin uuid := 'b1111111-1111-4111-8111-111111111111';
  v_tech uuid := 'b2222222-2222-4222-8222-222222222222';
begin
  -- access: one call answers session + capability + module
  v := lab_access('hash-admin', v_admin, 'result', 'verify');
  if not (v->>'ok')::boolean or v->'ctx'->>'facilityType' <> 'laboratory' or v->'ctx'->>'hospitalId' <> 'a1111111-1111-4111-8111-111111111111' then raise exception 'access admin: %', v; end if;
  v := lab_access('hash-tech', v_tech, 'result', 'verify');
  if (v->>'ok')::boolean or (v->>'status')::int <> 403 then raise exception 'tech must not verify: %', v; end if;
  v := lab_access('hash-tech', v_tech, 'specimen', 'collect');
  if not (v->>'ok')::boolean then raise exception 'lab_tech@laboratory should collect after migration: %', v; end if;
  v := lab_access('hash-revoked', v_tech, 'order', 'read');
  if (v->>'status')::int <> 401 then raise exception 'revoked session: %', v; end if;
  v := lab_access('hash-admin', v_tech, 'order', 'read');
  if (v->>'status')::int <> 401 then raise exception 'session/subject mismatch must fail: %', v; end if;
  v := lab_access('hash-cash', 'b3333333-3333-4333-8333-333333333333', 'order', 'read');
  if (v->>'status')::int <> 403 then raise exception 'pharmacy role refused: %', v; end if;
  v := lab_access('hash-doc', 'b4444444-4444-4444-8444-444444444444', 'order', 'read');
  if v->>'error' <> 'module_disabled' then raise exception 'module gate: %', v; end if;
  if exists (select 1 from role_capabilities rc join capabilities c on c.id=rc.capability_id where rc.role='lab_tech' and c.resource='result' and c.action='verify') then raise exception 'lab_tech verify grant should be gone'; end if;

  -- catalogue
  v_n := lab_seed_starter_catalog(v_lab);
  if v_n < 15 then raise exception 'seed count %', v_n; end if;
  if lab_seed_starter_catalog(v_lab) <> 0 then raise exception 'seed must be idempotent'; end if;
  update lab_test_catalog set price = 15000 where tenant_id = v_lab and code = 'GLU';

  -- walk-in: patient + visit + two tests in one call
  v := lab_create_walk_in(jsonb_build_object(
    'tenant_id', v_lab, 'hospital_id', 'a1111111-1111-4111-8111-111111111111', 'actor_id', v_admin, 'actor_role', 'lab_admin',
    'patient', jsonb_build_object('full_name', 'Nakato Jane', 'sex', 'F', 'dob', '1990-04-02', 'mrn', 'KLA-TEST-1'),
    'catalog_ids', (select jsonb_agg(id) from lab_test_catalog where tenant_id = v_lab and code in ('GLU','MRDT')),
    'order_source', 'walk_in', 'referral_source', 'Dr Okello, Mengo clinic'));
  if jsonb_array_length(v->'orders') <> 2 then raise exception 'walk-in orders: %', v; end if;
  v_patient := (v->'patient'->>'id')::uuid; v_enc := (v->>'encounterId')::uuid;
  select id into v_order from lab_orders where encounter_id = v_enc and loinc_code = '2345-7';
  if (select section from lab_orders where id = v_order) <> 'chemistry' then raise exception 'section from catalogue'; end if;
  if (select order_source from lab_orders where id = v_order) <> 'walk_in' then raise exception 'source'; end if;
  if not exists (select 1 from audit_log where action = 'LAB_WALK_IN_REGISTERED' and record_id = v_enc::text) then raise exception 'walk-in audit'; end if;

  -- walk-in with an unknown patient of another tenant is refused, and nothing is written
  begin
    perform lab_create_walk_in(jsonb_build_object('tenant_id', '22222222-2222-4222-8222-222222222222', 'hospital_id', 'a2222222-2222-4222-8222-222222222222', 'actor_id', 'b4444444-4444-4444-8444-444444444444', 'patient', jsonb_build_object('id', v_patient), 'catalog_ids', '[]'::jsonb, 'free_tests', '[{"test_name":"x","loinc_code":"1-1"}]'::jsonb));
    raise exception 'cross-tenant patient accepted';
  exception when sqlstate 'LB404' then null; end;

  -- hospital-style insert (existing contract, no section) gets its section from the trigger
  insert into lab_orders (tenant_id, encounter_id, patient_id, loinc_code, test_name, ordered_by, workflow_status, correlation_id)
  values (v_lab, v_enc, v_patient, '58410-2', 'FBC', v_admin, 'ORDERED', v_enc) returning id into v_order2;
  if (select section from lab_orders where id = v_order2) <> 'haematology' then raise exception 'trigger section'; end if;

  -- bundle: one call, tenant-scoped
  v := lab_order_bundle(v_lab, v_order, 'a1111111-1111-4111-8111-111111111111');
  if v->'order'->>'id' <> v_order::text or v->'patient'->>'sex' <> 'F' or v->'catalog'->>'code' <> 'GLU' or jsonb_array_length(v->'ranges') < 1 then raise exception 'bundle: %', v; end if;
  if lab_order_bundle('22222222-2222-4222-8222-222222222222', v_order, null) is not null then raise exception 'bundle leaked across tenants'; end if;
  if lab_order_bundle(v_lab, v_order, 'a2222222-2222-4222-8222-222222222222') is not null then raise exception 'bundle leaked across hospitals'; end if;

  -- tenant range wins over national pack
  insert into lab_reference_ranges (tenant_id, loinc_code, test_name, unit, low, high, critical_low, critical_high) values (v_lab, '2345-7', 'Glucose', 'mmol/L', 4.0, 7.0, 2.5, 25);
  v := lab_order_bundle(v_lab, v_order, null);
  if (v->'ranges'->0->>'tenant_id') is distinct from v_lab::text then raise exception 'tenant range first: %', v->'ranges'; end if;

  -- commit collect: specimen + order + audit in one transaction
  v := lab_commit_action(jsonb_build_object('tenant_id', v_lab, 'order_id', v_order, 'actor_id', v_tech, 'actor_role', 'lab_tech', 'expected_status', 'ORDERED',
    'order', jsonb_build_object('workflow_status', 'COLLECTED', 'status', 'collected', 'accession_number', 'LAB-20261121-000001', 'barcode', 'LAB-20261121-000001', 'specimen_id', 'c1111111-1111-4111-8111-111111111111'),
    'specimen', jsonb_build_object('id', 'c1111111-1111-4111-8111-111111111111', 'patient_id', v_patient, 'encounter_id', v_enc, 'accession_number', 'LAB-20261121-000001', 'barcode', 'LAB-20261121-000001', 'specimen_type', 'blood', 'container', 'Fluoride (grey)'),
    'audit', jsonb_build_object('action', 'LAB_SPECIMEN_COLLECTED')));
  if v->>'orderStatus' <> 'COLLECTED' then raise exception 'collect: %', v; end if;
  if (select collected_by from lab_specimens where id = 'c1111111-1111-4111-8111-111111111111') <> v_tech then raise exception 'collected_by'; end if;

  -- a second writer with the old status loses, and its specimen insert is rolled back too
  begin
    perform lab_commit_action(jsonb_build_object('tenant_id', v_lab, 'order_id', v_order, 'actor_id', v_admin, 'expected_status', 'ORDERED',
      'order', jsonb_build_object('workflow_status', 'COLLECTED', 'status', 'collected', 'accession_number', 'LAB-20261121-000002'),
      'specimen', jsonb_build_object('id', 'c2222222-2222-4222-8222-222222222222', 'patient_id', v_patient, 'encounter_id', v_enc, 'accession_number', 'LAB-20261121-000002'),
      'audit', jsonb_build_object('action', 'LAB_SPECIMEN_COLLECTED')));
    raise exception 'stale write accepted';
  exception when sqlstate 'LB409' then null; end;
  if exists (select 1 from lab_specimens where id = 'c2222222-2222-4222-8222-222222222222') then raise exception 'stale specimen kept'; end if;

  -- receive -> enter -> authorise (+ report) -> amend twice
  perform lab_commit_action(jsonb_build_object('tenant_id', v_lab, 'order_id', v_order, 'actor_id', v_tech, 'expected_status', 'COLLECTED',
    'order', jsonb_build_object('workflow_status', 'RECEIVED', 'status', 'processing', 'accession_number', 'LAB-20261121-000001', 'specimen_id', 'c1111111-1111-4111-8111-111111111111'),
    'specimen_patch', jsonb_build_object('status', 'in_lab'), 'audit', jsonb_build_object('action', 'LAB_SPECIMEN_RECEIVED')));
  if (select status from lab_specimens where id = 'c1111111-1111-4111-8111-111111111111') <> 'in_lab' then raise exception 'receive specimen'; end if;
  perform lab_commit_action(jsonb_build_object('tenant_id', v_lab, 'order_id', v_order, 'actor_id', v_tech, 'expected_status', 'RECEIVED',
    'order', jsonb_build_object('workflow_status', 'VERIFICATION_PENDING', 'status', 'resulted', 'accession_number', 'LAB-20261121-000001', 'specimen_id', 'c1111111-1111-4111-8111-111111111111'),
    'result', jsonb_build_object('id', v_result, 'patient_id', v_patient, 'encounter_id', v_enc, 'loinc_code', '2345-7', 'test_name', 'Blood glucose', 'value', '28', 'result_value', '28', 'unit', 'mmol/L', 'status', 'preliminary', 'is_critical', true, 'is_abnormal', true, 'flag', 'CRIT', 'abnormal_flag', 'CRIT', 'version', 1, 'entered_by', v_tech, 'result_source', 'MANUAL'),
    'audit', jsonb_build_object('action', 'LAB_RESULT_ENTERED')));
  if (select lab_technician_id from lab_results where id = v_result) <> v_tech then raise exception 'entered_by'; end if;
  v := lab_commit_action(jsonb_build_object('tenant_id', v_lab, 'order_id', v_order, 'actor_id', v_admin, 'expected_status', 'VERIFICATION_PENDING',
    'order', jsonb_build_object('workflow_status', 'RELEASED', 'status', 'verified', 'accession_number', 'LAB-20261121-000001', 'specimen_id', 'c1111111-1111-4111-8111-111111111111'),
    'result', jsonb_build_object('id', v_result, 'patient_id', v_patient, 'encounter_id', v_enc, 'loinc_code', '2345-7', 'test_name', 'Blood glucose', 'value', '28', 'result_value', '28', 'status', 'final', 'is_critical', true, 'is_abnormal', true, 'version', 1, 'verified_by', v_admin, 'verified_at', now(), 'released_to_patient_at', now(), 'provenance', 'LAB_VERIFIED'),
    'report', jsonb_build_object('id', gen_random_uuid(), 'facility_id', 'a1111111-1111-4111-8111-111111111111', 'patient_id', v_patient, 'encounter_id', v_enc, 'clinical_result_id', v_result, 'accession', 'LAB-20261121-000001', 'status', 'FINAL', 'version', 1, 'released_at', now(), 'verified_by', v_admin, 'template_version', 'lab-report.v2', 'html_snapshot', '<html></html>', 'content_hash', 'h1'),
    'audit', jsonb_build_object('action', 'LAB_RESULT_AUTHORISED')));
  if v->>'reportId' is null then raise exception 'report id: %', v; end if;
  if (select lab_technician_id from lab_results where id = v_result) <> v_tech then raise exception 'entered_by lost on authorise'; end if;
  if (select verified_by from lab_orders where id = v_order) is distinct from v_admin then raise exception 'authorise must stamp verified_by'; end if;
  -- repeating the same report version is a no-op that returns the existing id
  v2 := lab_commit_action(jsonb_build_object('tenant_id', v_lab, 'order_id', v_order, 'actor_id', v_admin, 'expected_status', 'RELEASED',
    'order', jsonb_build_object('workflow_status', 'RELEASED', 'status', 'verified', 'accession_number', 'LAB-20261121-000001', 'specimen_id', 'c1111111-1111-4111-8111-111111111111'),
    'report', jsonb_build_object('id', gen_random_uuid(), 'patient_id', v_patient, 'clinical_result_id', v_result, 'accession', 'LAB-20261121-000001', 'status', 'FINAL', 'version', 1, 'released_at', now(), 'template_version', 'lab-report.v2', 'html_snapshot', '<html></html>', 'content_hash', 'h1'),
    'audit', jsonb_build_object('action', 'LAB_REPORT_RELEASED')));
  if v2->>'reportId' <> v->>'reportId' then raise exception 'report idempotency % vs %', v2, v; end if;
  -- amendment v2 supersedes v1
  perform lab_commit_action(jsonb_build_object('tenant_id', v_lab, 'order_id', v_order, 'actor_id', v_admin, 'expected_status', 'RELEASED',
    'order', jsonb_build_object('workflow_status', 'AMENDED', 'status', 'verified', 'accession_number', 'LAB-20261121-000001', 'specimen_id', 'c1111111-1111-4111-8111-111111111111'),
    'result', jsonb_build_object('id', v_result, 'patient_id', v_patient, 'encounter_id', v_enc, 'test_name', 'Blood glucose', 'value', '8.2', 'result_value', '8.2', 'status', 'corrected', 'version', 2),
    'amendment', jsonb_build_object('id', gen_random_uuid(), 'result_id', v_result, 'previous_value', '28', 'previous_status', 'final', 'new_value', '8.2', 'reason', 'transcription error'),
    'report', jsonb_build_object('id', gen_random_uuid(), 'patient_id', v_patient, 'clinical_result_id', v_result, 'accession', 'LAB-20261121-000001', 'status', 'AMENDED', 'version', 2, 'released_at', now(), 'amendment_reason', 'transcription error', 'template_version', 'lab-report.v2', 'html_snapshot', '<html>v2</html>', 'content_hash', 'h2'),
    'audit', jsonb_build_object('action', 'LAB_RESULT_AMENDED')));
  if (select supersedes_report_id from lab_reports where lab_order_id = v_order and version = 2) <> (v->>'reportId')::uuid then raise exception 'supersedes'; end if;
  if (select count(*) from lab_result_amendments where result_id = v_result) <> 1 then raise exception 'amendment row'; end if;
  if (select count(*) from audit_log where tenant_id = v_lab and action like 'LAB_%') < 6 then raise exception 'audit trail'; end if;

  -- another tenant can never write into this order
  begin
    perform lab_commit_action(jsonb_build_object('tenant_id', '22222222-2222-4222-8222-222222222222', 'order_id', v_order, 'actor_id', 'b4444444-4444-4444-8444-444444444444', 'expected_status', 'AMENDED',
      'order', jsonb_build_object('workflow_status', 'RELEASED', 'status', 'verified'), 'audit', jsonb_build_object('action', 'X')));
    raise exception 'cross-tenant commit accepted';
  exception when sqlstate 'LB409' then null; end;
end $$;

-- API roles cannot call the functions or write the new tables.
do $$
begin
  if has_function_privilege('anon', 'public.lab_commit_action(jsonb)', 'execute') or has_function_privilege('authenticated', 'public.lab_access(text,uuid,text,text)', 'execute')
     or has_function_privilege('authenticated', 'public.lab_create_walk_in(jsonb)', 'execute') then raise exception 'function grants too wide'; end if;
  if has_table_privilege('authenticated', 'public.lab_test_catalog', 'insert') or has_table_privilege('anon', 'public.lab_test_catalog', 'select')
     or has_table_privilege('authenticated', 'public.lab_reference_ranges', 'update') then raise exception 'table grants too wide'; end if;
  if not has_function_privilege('service_role', 'public.lab_commit_action(jsonb)', 'execute') then raise exception 'service role grant missing'; end if;
end $$;

select 'LAB_CORE_FLOW_SCENARIO_PASS' as result;
