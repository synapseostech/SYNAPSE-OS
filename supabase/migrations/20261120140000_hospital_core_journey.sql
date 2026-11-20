-- Hospital core patient journey: registration search, cashier with insurance,
-- admission and discharge, and a one-call staff context.
--
-- Prepared, not applied. Additive and idempotent. Every function here is
-- SECURITY DEFINER, pins search_path, takes the tenant from the caller's
-- server-side context (never from the request body) and is executable by
-- service_role only.
--
-- 1. Capability seed. Promotes supabase/proposed/20260928_opd_encounter_sign_
--    disposition_capabilities (never applied: production has no
--    opd.encounter.sign/close/disposition, opd.result.review or
--    opd.prescription.cancel row, so those routes are 403 for every role) and
--    adds the cashier, insurance and discharge grants a small clinic needs.
-- 2. hospital_staff_context(): session + profile + tenant + hospital in one
--    round trip (was 3-4 sequential PostgREST calls on every hospital request).
-- 3. hospital_search_patients(): MRN, NIN, phone (last 9 digits, so 07.. and
--    +2567.. match) and name in one indexed query.
-- 4. Insurance cover on invoices + hospital_apply_invoice_cover().
-- 5. hospital_record_payment(): invoice row lock, idempotency, per-tenant
--    daily receipt sequence and billing-task completion in one transaction
--    (the JS path read the balance, inserted, then wrote paid_amount, so two
--    cashiers could both take the same balance).
-- 6. hospital_admissions + hospital_admit_patient()/hospital_discharge_patient()
--    (admission had no record of its own and no discharge at all).

-- ---------------------------------------------------------------------------
-- 1. Capabilities
-- ---------------------------------------------------------------------------
insert into public.capabilities (module, resource, action, description) values
  ('opd',     'encounter',    'sign',        'Sign OPD encounter'),
  ('opd',     'encounter',    'disposition', 'Record OPD encounter disposition'),
  ('opd',     'encounter',    'close',       'Close OPD encounter'),
  ('opd',     'result',       'review',      'Review OPD lab result'),
  ('opd',     'prescription', 'cancel',      'Cancel OPD prescription'),
  ('lab',     'order',        'cancel',      'Cancel a cancellable Lab order'),
  ('billing', 'insurance',    'apply',       'Apply insurance cover to an invoice'),
  ('ipd',     'admission',    'discharge',   'Discharge an admitted patient')
on conflict (module, resource, action) do nothing;

insert into public.role_capabilities (role, facility_type, capability_id)
select g.role, g.facility_type, c.id
from (values
  -- Clinicians (doctor, clinical officer): sign, close, disposition, review, cancel.
  ('doctor',           'hospital', 'opd', 'encounter',    'sign'),
  ('doctor',           'hospital', 'opd', 'encounter',    'disposition'),
  ('doctor',           'hospital', 'opd', 'encounter',    'close'),
  ('doctor',           'hospital', 'opd', 'result',       'review'),
  ('doctor',           'hospital', 'opd', 'prescription', 'cancel'),
  ('doctor',           'hospital', 'opd', 'queue',        'read'),
  ('doctor',           'hospital', 'lab', 'order',        'read'),
  ('doctor',           'hospital', 'lab', 'order',        'cancel'),
  ('clinical_officer', 'hospital', 'opd', 'encounter',    'sign'),
  ('clinical_officer', 'hospital', 'opd', 'encounter',    'disposition'),
  ('clinical_officer', 'hospital', 'opd', 'encounter',    'close'),
  ('clinical_officer', 'hospital', 'opd', 'result',       'review'),
  ('clinical_officer', 'hospital', 'opd', 'prescription', 'cancel'),
  ('clinical_officer', 'hospital', 'opd', 'queue',        'read'),
  ('clinical_officer', 'hospital', 'opd', 'triage',       'assign'),
  ('clinical_officer', 'hospital', 'lab', 'order',        'read'),
  ('clinical_officer', 'hospital', 'lab', 'order',        'cancel'),
  ('lab_scientist',    'hospital', 'lab', 'order',        'cancel'),
  -- Nurses do OPD triage and vitals.
  ('nurse',            'hospital', 'opd', 'triage',       'assign'),
  ('nurse',            'hospital', 'opd', 'queue',        'read'),
  -- Cashier takes payments and applies insurance cover; billing officer too.
  ('cashier',          'hospital', 'billing', 'payment',   'record'),
  ('cashier',          'hospital', 'billing', 'insurance', 'apply'),
  ('billing_officer',  'hospital', 'billing', 'insurance', 'apply'),
  ('claims_officer',   'hospital', 'billing', 'insurance', 'apply'),
  ('claims_officer',   'hospital', 'billing', 'invoice',   'read'),
  ('hospital_admin',   'hospital', 'billing', 'invoice',   'read'),
  -- Admission and discharge: clinicians admit and discharge, nurses see the ward.
  ('clinical_officer', 'hospital', 'ipd', 'admission', 'create'),
  ('doctor',           'hospital', 'ipd', 'admission', 'read'),
  ('clinical_officer', 'hospital', 'ipd', 'admission', 'read'),
  ('doctor',           'hospital', 'ipd', 'admission', 'discharge'),
  ('clinical_officer', 'hospital', 'ipd', 'admission', 'discharge')
) as g(role, facility_type, module, resource, action)
join public.capabilities c
  on c.module = g.module and c.resource = g.resource and c.action = g.action
on conflict (role, facility_type, capability_id) do nothing;

-- ---------------------------------------------------------------------------
-- 2. One-call staff context
-- ---------------------------------------------------------------------------
create or replace function public.hospital_staff_context(p_token_hash text, p_user_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_session record;
  v_profile record;
  v_tenant record;
  v_hospital_id uuid;
begin
  select s.user_id, s.expires_at, s.revoked_at
    into v_session
    from public.synapse_sessions s
   where s.token_hash = p_token_hash
   limit 1;

  if not found
     or v_session.revoked_at is not null
     or v_session.expires_at < now()
     or v_session.user_id is distinct from p_user_id then
    return jsonb_build_object('status', 'session_invalid');
  end if;

  select p.id, p.email, p.role, p.full_name, p.tenant_id, p.hospital_id
    into v_profile
    from public.profiles p
   where p.id = p_user_id;

  if not found or v_profile.tenant_id is null then
    return jsonb_build_object('status', 'no_tenant');
  end if;

  select t.facility_type, t.slug into v_tenant from public.tenants t where t.id = v_profile.tenant_id;

  v_hospital_id := v_profile.hospital_id;
  if v_hospital_id is null and v_tenant.slug is not null then
    select h.id into v_hospital_id from public.hospitals h where h.subdomain = v_tenant.slug limit 1;
  end if;

  return jsonb_build_object(
    'status', 'ok',
    'user_id', v_profile.id,
    'email', v_profile.email,
    'role', v_profile.role,
    'full_name', v_profile.full_name,
    'tenant_id', v_profile.tenant_id,
    'hospital_id', v_hospital_id,
    'facility_type', coalesce(v_tenant.facility_type, 'hospital')
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. Patient search
-- ---------------------------------------------------------------------------
create index if not exists idx_patients_tenant_mrn_upper
  on public.patients (tenant_id, upper(mrn) text_pattern_ops)
  where mrn is not null;

create index if not exists idx_patients_tenant_nin_upper
  on public.patients (tenant_id, upper(nin))
  where nin is not null;

create index if not exists idx_patients_tenant_phone9
  on public.patients (tenant_id, right(regexp_replace(phone, '\D', '', 'g'), 9))
  where phone is not null;

create or replace function public.hospital_search_patients(
  p_tenant_id uuid,
  p_query text,
  p_limit integer default 20
)
returns table (
  id uuid,
  full_name text,
  mrn text,
  dob date,
  sex text,
  phone_last4 text,
  match_kind text
)
language sql
stable
security definer
set search_path = public, extensions
as $$
  with q as (
    select
      btrim(p_query) as raw,
      upper(btrim(p_query)) as up,
      right(regexp_replace(p_query, '\D', '', 'g'), 9) as digits,
      replace(replace(replace(btrim(p_query), '\', '\\'), '%', '\%'), '_', '\_') as esc,
      least(greatest(coalesce(p_limit, 20), 1), 50) as lim
  ),
  hits as (
    select
      p.id,
      p.full_name,
      p.mrn,
      coalesce(p.dob, p.date_of_birth) as dob,
      p.sex,
      right(regexp_replace(coalesce(p.phone, ''), '\D', '', 'g'), 4) as phone_last4,
      case
        when upper(p.mrn) = q.up then 'mrn'
        when p.nin is not null and upper(p.nin) = q.up then 'nin'
        when length(q.digits) = 9 and p.phone is not null
             and right(regexp_replace(p.phone, '\D', '', 'g'), 9) = q.digits then 'phone'
        when upper(p.mrn) like q.up || '%' then 'mrn_prefix'
        else 'name'
      end as match_kind,
      similarity(coalesce(p.full_name, ''), q.raw) as sim
    from public.patients p, q
    where p.tenant_id = p_tenant_id
      and coalesce(p.is_deleted, false) = false
      and length(q.raw) >= 2
      and (
        (p.mrn is not null and upper(p.mrn) like q.up || '%')
        or (p.nin is not null and upper(p.nin) = q.up)
        or (length(q.digits) = 9 and p.phone is not null
            and right(regexp_replace(p.phone, '\D', '', 'g'), 9) = q.digits)
        or (p.full_name is not null and p.full_name ilike '%' || q.esc || '%')
        or (p.full_name is not null and length(q.raw) >= 4 and p.full_name % q.raw)
      )
  )
  select h.id, h.full_name, h.mrn, h.dob, h.sex, nullif(h.phone_last4, ''), h.match_kind
  from hits h, q
  order by
    case h.match_kind when 'mrn' then 0 when 'nin' then 0 when 'phone' then 1 when 'mrn_prefix' then 2 else 3 end,
    h.sim desc,
    h.full_name
  limit (select lim from q);
$$;

-- ---------------------------------------------------------------------------
-- 4. Insurance cover on invoices
-- ---------------------------------------------------------------------------
alter table public.billing_invoices
  add column if not exists insurance_policy_id uuid references public.insurance_policies(id) on delete set null,
  add column if not exists insurer_id uuid references public.insurance_providers(id) on delete set null,
  add column if not exists insurance_cover_amount numeric(12, 2) not null default 0,
  add column if not exists insurance_claim_id uuid references public.insurance_claims(id) on delete set null;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'billing_invoices_insurance_cover_nonneg') then
    alter table public.billing_invoices
      add constraint billing_invoices_insurance_cover_nonneg check (insurance_cover_amount >= 0);
  end if;
end $$;

create index if not exists idx_billing_invoices_insurance_policy
  on public.billing_invoices (insurance_policy_id) where insurance_policy_id is not null;
create index if not exists idx_billing_invoices_insurer
  on public.billing_invoices (insurer_id) where insurer_id is not null;
create index if not exists idx_billing_invoices_insurance_claim
  on public.billing_invoices (insurance_claim_id) where insurance_claim_id is not null;
-- Cashier queue: open invoices per tenant, newest first, keyset-paged.
create index if not exists idx_billing_invoices_tenant_status_created
  on public.billing_invoices (tenant_id, status, created_at desc)
  where is_deleted = false;
create index if not exists idx_insurance_policies_tenant_patient
  on public.insurance_policies (tenant_id, patient_id, status);
create index if not exists idx_insurance_providers_tenant_name
  on public.insurance_providers (tenant_id, lower(name));

create or replace function public.hospital_apply_invoice_cover(
  p_tenant_id uuid,
  p_hospital_id uuid,
  p_invoice_id uuid,
  p_cover_amount numeric,
  p_actor_id uuid,
  p_policy_id uuid default null,
  p_insurer_name text default null,
  p_member_number text default null,
  p_scheme text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_inv record;
  v_policy record;
  v_provider_id uuid;
  v_provider_name text;
  v_claim_id uuid;
  v_claim_status text;
  v_cover numeric(12, 2) := round(coalesce(p_cover_amount, 0), 2);
  v_total numeric(12, 2);
  v_paid numeric(12, 2);
  v_balance numeric(12, 2);
  v_status text;
  v_primary text;
  v_codes text[];
  v_service date;
begin
  select i.* into v_inv
    from public.billing_invoices i
   where i.id = p_invoice_id and i.tenant_id = p_tenant_id and coalesce(i.is_deleted, false) = false
   for update;
  if not found then raise exception 'INVOICE_NOT_FOUND'; end if;
  if v_inv.status = 'void' then raise exception 'INVOICE_VOID'; end if;

  v_total := coalesce(v_inv.total_amount, 0);
  v_paid := coalesce(v_inv.paid_amount, 0);
  if v_cover < 0 then raise exception 'INVALID_AMOUNT'; end if;
  if v_cover > v_total - v_paid + 0.001 then raise exception 'COVER_EXCEEDS_BALANCE'; end if;

  if v_inv.insurance_claim_id is not null then
    select c.id, c.status into v_claim_id, v_claim_status
      from public.insurance_claims c where c.id = v_inv.insurance_claim_id for update;
    if v_claim_status is not null and v_claim_status not in ('draft', 'ready', 'void') then
      raise exception 'CLAIM_ALREADY_SUBMITTED';
    end if;
  end if;

  -- Removing cover voids the draft claim.
  if v_cover = 0 then
    if v_inv.insurance_claim_id is not null then
      update public.insurance_claims set status = 'void', updated_at = now() where id = v_inv.insurance_claim_id;
    end if;
    update public.billing_invoices
       set insurance_policy_id = null, insurer_id = null, insurance_cover_amount = 0, insurance_claim_id = null,
           status = case when v_paid >= v_total - 0.001 and v_total > 0 then 'paid'
                         when v_paid > 0 then 'partially_paid'
                         when status = 'paid' then 'issued' else status end,
           updated_at = now()
     where id = v_inv.id
     returning status into v_status;
    return jsonb_build_object('invoiceId', v_inv.id, 'insuranceCover', 0, 'claimId', null,
      'balanceDue', greatest(0, v_total - v_paid), 'status', v_status);
  end if;

  if v_inv.patient_id is null then raise exception 'INVOICE_HAS_NO_PATIENT'; end if;

  if p_policy_id is not null then
    select pol.* into v_policy
      from public.insurance_policies pol
     where pol.id = p_policy_id and pol.tenant_id = p_tenant_id and pol.patient_id = v_inv.patient_id;
    if not found then raise exception 'POLICY_NOT_FOUND'; end if;
  else
    if nullif(btrim(coalesce(p_insurer_name, '')), '') is null or nullif(btrim(coalesce(p_member_number, '')), '') is null then
      raise exception 'POLICY_REQUIRED';
    end if;
    select pr.id into v_provider_id
      from public.insurance_providers pr
     where pr.tenant_id = p_tenant_id and lower(pr.name) = lower(btrim(p_insurer_name))
     limit 1;
    if v_provider_id is null then
      insert into public.insurance_providers (tenant_id, name, code, is_active)
      values (
        p_tenant_id,
        btrim(p_insurer_name),
        upper(left(regexp_replace(btrim(p_insurer_name), '[^A-Za-z0-9]', '', 'g'), 12)) || '-' || left(replace(gen_random_uuid()::text, '-', ''), 4),
        true
      )
      returning id into v_provider_id;
    end if;
    select pol.* into v_policy
      from public.insurance_policies pol
     where pol.tenant_id = p_tenant_id and pol.patient_id = v_inv.patient_id
       and pol.payer_id = v_provider_id and lower(coalesce(pol.member_id, pol.policy_number)) = lower(btrim(p_member_number))
     order by pol.created_at desc
     limit 1;
    if not found then
      insert into public.insurance_policies (tenant_id, patient_id, payer_id, policy_number, member_id, plan_name, coverage_type, status)
      values (p_tenant_id, v_inv.patient_id, v_provider_id, btrim(p_member_number), btrim(p_member_number),
              nullif(btrim(coalesce(p_scheme, '')), ''), 'outpatient', 'active')
      returning * into v_policy;
    end if;
  end if;

  if v_policy.status is distinct from 'active' or (v_policy.expiry_date is not null and v_policy.expiry_date < current_date) then
    raise exception 'POLICY_INACTIVE';
  end if;

  v_provider_id := coalesce(v_policy.payer_id, v_provider_id);
  select pr.name into v_provider_name from public.insurance_providers pr where pr.id = v_provider_id and pr.tenant_id = p_tenant_id;
  v_provider_name := coalesce(v_provider_name, nullif(btrim(coalesce(p_insurer_name, '')), ''), v_policy.plan_name, 'Insurer');

  select
    (array_agg(d.stem_code order by (d.diagnosis_type = 'primary') desc, d.created_at))[1],
    coalesce(array_agg(d.stem_code order by (d.diagnosis_type = 'primary') desc, d.created_at), '{}')
    into v_primary, v_codes
    from public.encounter_diagnoses d
   where v_inv.encounter_id is not null and d.encounter_id = v_inv.encounter_id
     and d.tenant_id = p_tenant_id and coalesce(d.is_deleted, false) = false and d.stem_code is not null;

  select coalesce(e.visit_date::date, current_date) into v_service
    from public.encounters e where e.id = v_inv.encounter_id and e.tenant_id = p_tenant_id;
  v_service := coalesce(v_service, current_date);

  if v_claim_id is not null and v_claim_status in ('draft', 'ready') then
    update public.insurance_claims
       set insurer_id = v_provider_id, insurer_name = v_provider_name, billed_amount = v_cover,
           patient_responsibility = greatest(0, v_total - v_cover), primary_icd11 = v_primary,
           diagnosis_codes = coalesce(v_codes, '{}'), updated_at = now(), version = version + 1
     where id = v_claim_id;
  else
    insert into public.insurance_claims (
      tenant_id, hospital_id, patient_id, encounter_id, invoice_id, insurer_id, insurer_name, claim_number,
      claim_type, service_from, service_to, billed_amount, patient_responsibility, primary_icd11,
      diagnosis_codes, status, metadata
    ) values (
      p_tenant_id, p_hospital_id, v_inv.patient_id, v_inv.encounter_id, v_inv.id, v_provider_id, v_provider_name,
      'CLM-' || to_char(now(), 'YYYYMMDD') || '-' || upper(left(replace(gen_random_uuid()::text, '-', ''), 8)),
      'professional', v_service, v_service, v_cover, greatest(0, v_total - v_cover), v_primary,
      coalesce(v_codes, '{}'), 'draft',
      jsonb_build_object('source', 'hospital_cashier', 'applied_by', p_actor_id, 'policy_id', v_policy.id)
    )
    returning id into v_claim_id;
  end if;

  v_balance := greatest(0, v_total - v_cover - v_paid);
  update public.billing_invoices
     set insurance_policy_id = v_policy.id, insurer_id = v_provider_id, insurance_cover_amount = v_cover,
         insurance_claim_id = v_claim_id,
         status = case when v_balance <= 0.001 then 'paid' when v_paid > 0 then 'partially_paid'
                       when status = 'draft' then 'issued' else status end,
         updated_at = now()
   where id = v_inv.id
   returning status into v_status;

  return jsonb_build_object(
    'invoiceId', v_inv.id, 'patientId', v_inv.patient_id, 'encounterId', v_inv.encounter_id,
    'policyId', v_policy.id, 'insurerId', v_provider_id, 'insurerName', v_provider_name,
    'insuranceCover', v_cover, 'claimId', v_claim_id, 'totalAmount', v_total, 'paidAmount', v_paid,
    'balanceDue', v_balance, 'status', v_status
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. Atomic payment
-- ---------------------------------------------------------------------------
create table if not exists public.hospital_receipt_counters (
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  receipt_day date not null,
  last_value integer not null default 0,
  primary key (tenant_id, receipt_day)
);
alter table public.hospital_receipt_counters enable row level security;
revoke all on public.hospital_receipt_counters from public, anon, authenticated;
grant select, insert, update, delete on public.hospital_receipt_counters to service_role;

create or replace function public.hospital_record_payment(
  p_tenant_id uuid,
  p_encounter_id uuid,
  p_amount numeric,
  p_payment_method text,
  p_actor_id uuid,
  p_payment_ref text default null,
  p_idempotency_key text default null,
  p_notes text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_inv record;
  v_existing record;
  v_key text := nullif(btrim(coalesce(p_idempotency_key, '')), '');
  v_amount numeric(12, 2) := round(coalesce(p_amount, 0), 2);
  v_total numeric(12, 2);
  v_cover numeric(12, 2);
  v_paid numeric(12, 2);
  v_balance numeric(12, 2);
  v_seq integer;
  v_receipt text;
  v_payment_id uuid := gen_random_uuid();
  v_status text;
  v_task_done boolean := false;
begin
  select i.id, i.patient_id, i.status, i.currency, i.total_amount, i.paid_amount, i.insurance_cover_amount
    into v_inv
    from public.billing_invoices i
   where i.tenant_id = p_tenant_id and i.encounter_id = p_encounter_id and coalesce(i.is_deleted, false) = false
   order by i.created_at desc
   limit 1
   for update;
  if not found then raise exception 'INVOICE_NOT_FOUND'; end if;

  v_total := coalesce(v_inv.total_amount, 0);
  v_cover := coalesce(v_inv.insurance_cover_amount, 0);
  v_paid := coalesce(v_inv.paid_amount, 0);

  -- A retry with the same key returns the original payment, even when the
  -- invoice has since been settled.
  if v_key is not null then
    select bp.id, bp.amount, bp.receipt_number into v_existing
      from public.billing_payments bp
     where bp.tenant_id = p_tenant_id and bp.idempotency_key = v_key;
    if found then
      return jsonb_build_object(
        'paymentId', v_existing.id, 'invoiceId', v_inv.id, 'patientId', v_inv.patient_id,
        'receiptNumber', coalesce(v_existing.receipt_number, ''), 'amount', v_existing.amount,
        'paidAmount', v_paid, 'totalAmount', v_total, 'insuranceCover', v_cover,
        'balanceDue', greatest(0, v_total - v_cover - v_paid), 'status', v_inv.status,
        'created', false, 'billingTaskCompleted', false
      );
    end if;
  end if;

  if v_inv.status = 'void' then raise exception 'INVOICE_VOID'; end if;
  v_balance := v_total - v_cover - v_paid;
  if v_balance <= 0.001 then raise exception 'INVOICE_ALREADY_PAID'; end if;
  if v_amount <= 0 then raise exception 'INVALID_AMOUNT'; end if;
  if v_amount > v_balance + 0.001 then raise exception 'AMOUNT_EXCEEDS_BALANCE'; end if;

  insert into public.hospital_receipt_counters as c (tenant_id, receipt_day, last_value)
  values (p_tenant_id, (now() at time zone 'Africa/Kampala')::date, 1)
  on conflict (tenant_id, receipt_day) do update set last_value = c.last_value + 1
  returning last_value into v_seq;
  v_receipt := 'RCP-' || to_char((now() at time zone 'Africa/Kampala')::date, 'YYYYMMDD') || '-' || lpad(v_seq::text, 4, '0');

  insert into public.billing_payments (
    id, tenant_id, invoice_id, encounter_id, patient_id, amount, currency, payment_method,
    payment_ref, receipt_number, idempotency_key, received_by, notes, is_deleted
  ) values (
    v_payment_id, p_tenant_id, v_inv.id, p_encounter_id, v_inv.patient_id, v_amount,
    coalesce(v_inv.currency, 'UGX'), p_payment_method, p_payment_ref, v_receipt, v_key, p_actor_id, p_notes, false
  );

  v_paid := v_paid + v_amount;
  v_balance := greatest(0, v_total - v_cover - v_paid);
  v_status := case when v_balance <= 0.001 then 'paid' else 'partially_paid' end;

  update public.billing_invoices
     set paid_amount = v_paid, status = v_status, updated_at = now()
   where id = v_inv.id;

  if v_balance <= 0.001 then
    update public.department_tasks
       set status = 'COMPLETED',
           accepted_at = coalesce(accepted_at, now()),
           completed_at = now(),
           assigned_to = coalesce(assigned_to, p_actor_id),
           result_summary = 'Invoice fully paid',
           updated_at = now()
     where tenant_id = p_tenant_id
       and encounter_id = p_encounter_id
       and source_resource = 'billing_invoices'
       and source_id = v_inv.id
       and task_type = 'billing'
       and status in ('REQUESTED', 'ACCEPTED', 'IN_PROGRESS', 'ON_HOLD');
    v_task_done := found;
  end if;

  return jsonb_build_object(
    'paymentId', v_payment_id, 'invoiceId', v_inv.id, 'patientId', v_inv.patient_id,
    'receiptNumber', v_receipt, 'amount', v_amount, 'paidAmount', v_paid, 'totalAmount', v_total,
    'insuranceCover', v_cover, 'balanceDue', v_balance, 'status', v_status,
    'created', true, 'billingTaskCompleted', v_task_done
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- 6. Admission and discharge
-- ---------------------------------------------------------------------------
create table if not exists public.hospital_admissions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  hospital_id uuid not null references public.hospitals(id) on delete cascade,
  patient_id uuid not null references public.patients(id) on delete cascade,
  encounter_id uuid references public.encounters(id) on delete set null,
  bed_id uuid references public.hospital_beds(id) on delete set null,
  ward text,
  reason text not null,
  status text not null default 'admitted' check (status in ('admitted', 'discharged')),
  admitted_by uuid references public.profiles(id) on delete set null,
  admitted_at timestamptz not null default now(),
  discharged_by uuid references public.profiles(id) on delete set null,
  discharged_at timestamptz,
  discharge_disposition text check (discharge_disposition is null or discharge_disposition in
    ('home', 'referred', 'transferred', 'left_against_advice', 'absconded', 'died')),
  discharge_summary text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((status = 'discharged') = (discharged_at is not null))
);

create unique index if not exists hospital_admissions_one_active_per_patient
  on public.hospital_admissions (tenant_id, patient_id) where status = 'admitted';
create unique index if not exists hospital_admissions_one_active_per_bed
  on public.hospital_admissions (bed_id) where status = 'admitted' and bed_id is not null;
create index if not exists hospital_admissions_tenant_status
  on public.hospital_admissions (tenant_id, status, admitted_at desc);
create index if not exists hospital_admissions_hospital_id_idx on public.hospital_admissions (hospital_id);
create index if not exists hospital_admissions_patient_id_idx on public.hospital_admissions (patient_id);
create index if not exists hospital_admissions_encounter_id_idx on public.hospital_admissions (encounter_id) where encounter_id is not null;
create index if not exists hospital_admissions_bed_id_idx on public.hospital_admissions (bed_id) where bed_id is not null;
create index if not exists hospital_admissions_admitted_by_idx on public.hospital_admissions (admitted_by) where admitted_by is not null;
create index if not exists hospital_admissions_discharged_by_idx on public.hospital_admissions (discharged_by) where discharged_by is not null;

alter table public.hospital_admissions enable row level security;
revoke all on public.hospital_admissions from public, anon;
grant select on public.hospital_admissions to authenticated;
grant select, insert, update, delete on public.hospital_admissions to service_role;

do $$
begin
  if not exists (
    select 1 from pg_policies
     where schemaname = 'public' and tablename = 'hospital_admissions' and policyname = 'hospital_admissions_tenant_read'
  ) then
    create policy hospital_admissions_tenant_read
      on public.hospital_admissions
      for select
      to authenticated
      using (tenant_id = (select public.current_tenant_id()));
  end if;
end $$;

create or replace function public.hospital_admit_patient(
  p_tenant_id uuid,
  p_hospital_id uuid,
  p_patient_id uuid,
  p_bed_id uuid,
  p_actor_id uuid,
  p_reason text,
  p_encounter_id uuid default null,
  p_admission_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_bed record;
  v_id uuid := coalesce(p_admission_id, gen_random_uuid());
begin
  perform 1 from public.patients p
   where p.id = p_patient_id and p.tenant_id = p_tenant_id and coalesce(p.is_deleted, false) = false;
  if not found then raise exception 'PATIENT_NOT_FOUND'; end if;

  if p_encounter_id is not null then
    perform 1 from public.encounters e
     where e.id = p_encounter_id and e.tenant_id = p_tenant_id and e.hospital_id = p_hospital_id
       and e.patient_id = p_patient_id and coalesce(e.is_deleted, false) = false;
    if not found then raise exception 'ENCOUNTER_NOT_FOUND'; end if;
  end if;

  select b.id, b.ward, b.status, b.current_patient_id into v_bed
    from public.hospital_beds b
   where b.id = p_bed_id and b.hospital_id = p_hospital_id
     and (b.tenant_id = p_tenant_id or b.tenant_id is null)
     and coalesce(b.is_deleted, false) = false
   for update;
  if not found then raise exception 'BED_NOT_FOUND'; end if;
  if v_bed.current_patient_id is not null then raise exception 'BED_OCCUPIED'; end if;
  if v_bed.status in ('maintenance', 'blocked', 'out_of_service') then raise exception 'BED_UNAVAILABLE'; end if;

  perform 1 from public.hospital_admissions a
   where a.tenant_id = p_tenant_id and a.patient_id = p_patient_id and a.status = 'admitted';
  if found then raise exception 'ALREADY_ADMITTED'; end if;

  insert into public.hospital_admissions (id, tenant_id, hospital_id, patient_id, encounter_id, bed_id, ward, reason, admitted_by)
  values (v_id, p_tenant_id, p_hospital_id, p_patient_id, p_encounter_id, p_bed_id, v_bed.ward, p_reason, p_actor_id);

  update public.hospital_beds
     set current_patient_id = p_patient_id, status = 'occupied', last_status_change = now(), updated_at = now()
   where id = p_bed_id;

  return jsonb_build_object('admissionId', v_id, 'bedId', p_bed_id, 'ward', v_bed.ward,
    'patientId', p_patient_id, 'encounterId', p_encounter_id, 'status', 'admitted');
end;
$$;

create or replace function public.hospital_discharge_patient(
  p_tenant_id uuid,
  p_hospital_id uuid,
  p_admission_id uuid,
  p_actor_id uuid,
  p_disposition text,
  p_summary text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_adm record;
  v_tasks integer := 0;
begin
  select a.* into v_adm
    from public.hospital_admissions a
   where a.id = p_admission_id and a.tenant_id = p_tenant_id and a.hospital_id = p_hospital_id
   for update;
  if not found then raise exception 'ADMISSION_NOT_FOUND'; end if;
  if v_adm.status = 'discharged' then raise exception 'ALREADY_DISCHARGED'; end if;

  update public.hospital_admissions
     set status = 'discharged', discharged_at = now(), discharged_by = p_actor_id,
         discharge_disposition = p_disposition, discharge_summary = p_summary, updated_at = now()
   where id = v_adm.id;

  if v_adm.bed_id is not null then
    update public.hospital_beds
       set current_patient_id = null, status = 'available', last_status_change = now(), updated_at = now()
     where id = v_adm.bed_id and current_patient_id = v_adm.patient_id;
  end if;

  update public.department_tasks
     set status = 'COMPLETED', accepted_at = coalesce(accepted_at, now()), completed_at = now(),
         assigned_to = coalesce(assigned_to, p_actor_id), result_summary = 'Discharged: ' || p_disposition,
         updated_at = now()
   where tenant_id = p_tenant_id and task_type = 'admission' and patient_id = v_adm.patient_id
     and (source_id = v_adm.bed_id or encounter_id = coalesce(v_adm.encounter_id, v_adm.id))
     and status in ('REQUESTED', 'ACCEPTED', 'IN_PROGRESS', 'ON_HOLD');
  get diagnostics v_tasks = row_count;

  return jsonb_build_object('admissionId', v_adm.id, 'patientId', v_adm.patient_id, 'bedId', v_adm.bed_id,
    'encounterId', v_adm.encounter_id, 'status', 'discharged', 'disposition', p_disposition,
    'tasksCompleted', v_tasks);
end;
$$;

-- ---------------------------------------------------------------------------
-- Grants: service_role only.
-- ---------------------------------------------------------------------------
revoke all on function public.hospital_staff_context(text, uuid) from public, anon, authenticated;
revoke all on function public.hospital_search_patients(uuid, text, integer) from public, anon, authenticated;
revoke all on function public.hospital_apply_invoice_cover(uuid, uuid, uuid, numeric, uuid, uuid, text, text, text) from public, anon, authenticated;
revoke all on function public.hospital_record_payment(uuid, uuid, numeric, text, uuid, text, text, text) from public, anon, authenticated;
revoke all on function public.hospital_admit_patient(uuid, uuid, uuid, uuid, uuid, text, uuid, uuid) from public, anon, authenticated;
revoke all on function public.hospital_discharge_patient(uuid, uuid, uuid, uuid, text, text) from public, anon, authenticated;

grant execute on function public.hospital_staff_context(text, uuid) to service_role;
grant execute on function public.hospital_search_patients(uuid, text, integer) to service_role;
grant execute on function public.hospital_apply_invoice_cover(uuid, uuid, uuid, numeric, uuid, uuid, text, text, text) to service_role;
grant execute on function public.hospital_record_payment(uuid, uuid, numeric, text, uuid, text, text, text) to service_role;
grant execute on function public.hospital_admit_patient(uuid, uuid, uuid, uuid, uuid, text, uuid, uuid) to service_role;
grant execute on function public.hospital_discharge_patient(uuid, uuid, uuid, uuid, text, text) to service_role;

notify pgrst, 'reload schema';
