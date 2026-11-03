-- SYNAPSE-OS canonical public schema for FRESH environments only.
-- Schema-only dump of production project qfqakzmjatszisuqjwon public schema.
-- Captured 2026-09-19 via `supabase db dump --linked --schema public`.
-- Contains NO table data (no COPY / INSERT). Do not treat this as a seed.
-- Do NOT add this file to supabase/migrations/ — production already has its ledger.
-- Fresh databases: scripts/db-reset-fresh.sh
-- Historical files in supabase/migrations/ remain the production history archive.

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;


CREATE SCHEMA IF NOT EXISTS "public";


ALTER SCHEMA "public" OWNER TO "pg_database_owner";


COMMENT ON SCHEMA "public" IS 'standard public schema';



CREATE OR REPLACE FUNCTION "public"."_set_consult_queue_updated_at"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$;


ALTER FUNCTION "public"."_set_consult_queue_updated_at"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."accept_facility_invitation_existing_user"("p_token_hash" "text", "p_session_profile_id" "uuid") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_invite record;
  v_profile record;
  v_result jsonb;
begin
  if p_token_hash is null or p_session_profile_id is null then
    raise exception 'INVALID_INPUT' using errcode = 'P0001';
  end if;

  select * into v_invite
  from public.facility_invitations
  where token_hash = p_token_hash
  for update;

  if not found then
    raise exception 'INVITE_NOT_FOUND' using errcode = 'P0001';
  end if;

  if v_invite.status = 'REVOKED' then
    raise exception 'INVITE_REVOKED' using errcode = 'P0001';
  end if;
  if v_invite.status = 'ACCEPTED' then
    raise exception 'INVITE_ALREADY_USED' using errcode = 'P0001';
  end if;
  if v_invite.expires_at < now() then
    update public.facility_invitations set status = 'EXPIRED', updated_at = now() where id = v_invite.id;
    raise exception 'INVITE_EXPIRED' using errcode = 'P0001';
  end if;
  if v_invite.status not in ('PENDING', 'SENT') then
    raise exception 'INVITE_ALREADY_USED' using errcode = 'P0001';
  end if;

  select * into v_profile from public.profiles where id = p_session_profile_id;
  if not found then
    raise exception 'PROFILE_NOT_FOUND' using errcode = 'P0001';
  end if;

  -- The wrong authenticated recipient must never be able to redeem an
  -- invitation addressed to a different email, even with a valid token.
  if lower(v_profile.email) <> lower(v_invite.email) then
    raise exception 'WRONG_RECIPIENT' using errcode = 'P0001';
  end if;

  -- profiles.tenant_id is a legacy single "home tenant" pointer. It is never
  -- overwritten here; the invited facility is granted only by the canonical
  -- scoped assignment below.

  -- Re-validate the invited department against the facility at acceptance
  -- time — a department may have been removed or moved since the invite was
  -- issued, and an existing assignment elsewhere must never stand in as
  -- proof that this department/role was actually granted.
  if v_invite.department_id is not null and not exists (
    select 1 from public.departments where id = v_invite.department_id and tenant_id = v_invite.tenant_id
  ) then
    raise exception 'DEPARTMENT_OUT_OF_SCOPE' using errcode = 'P0001';
  end if;

  insert into public.staff_scope_assignments (profile_id, tenant_id, role, department_id, is_active)
  values (v_profile.id, v_invite.tenant_id, v_invite.role, v_invite.department_id, true)
  on conflict (profile_id, role, coalesce(organization_id, '00000000-0000-0000-0000-000000000000'::uuid), coalesce(tenant_id, '00000000-0000-0000-0000-000000000000'::uuid), coalesce(site_id, '00000000-0000-0000-0000-000000000000'::uuid), coalesce(department_id, '00000000-0000-0000-0000-000000000000'::uuid))
  where is_active
  do nothing;

  update public.facility_invitations
  set status = 'ACCEPTED', accepted_at = now(), redeemed_by = v_profile.id, profile_id = v_profile.id, updated_at = now()
  where id = v_invite.id and status in ('PENDING', 'SENT');

  if not found then
    raise exception 'INVITE_ALREADY_USED' using errcode = 'P0001';
  end if;

  insert into public.facility_invitation_audit (invitation_id, event, actor_profile_id, metadata)
  values (v_invite.id, 'ACCEPTED_EXISTING_USER', v_profile.id, jsonb_build_object('tenant_id', v_invite.tenant_id, 'role', v_invite.role, 'department_id', v_invite.department_id));

  v_result := jsonb_build_object('ok', true, 'profile_id', v_profile.id, 'tenant_id', v_invite.tenant_id);
  return v_result;
end;
$$;


ALTER FUNCTION "public"."accept_facility_invitation_existing_user"("p_token_hash" "text", "p_session_profile_id" "uuid") OWNER TO "postgres";


COMMENT ON FUNCTION "public"."accept_facility_invitation_existing_user"("p_token_hash" "text", "p_session_profile_id" "uuid") IS 'Transactional invitation acceptance for an already-authenticated existing profile. Never writes password_hash. Rolls back entirely on any failure.';



CREATE OR REPLACE FUNCTION "public"."accept_facility_invitation_new_account"("p_token_hash" "text", "p_profile_id" "uuid", "p_password_hash" "text", "p_full_name" "text", "p_first_name" "text", "p_last_name" "text") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_invite public.facility_invitations%rowtype;
  v_existing public.profiles%rowtype;
begin
  if p_token_hash is null or length(trim(p_token_hash)) = 0 then
    raise exception 'INVALID_INPUT' using errcode = 'P0001';
  end if;
  if p_profile_id is null then
    raise exception 'INVALID_INPUT' using errcode = 'P0001';
  end if;
  if p_password_hash is null or length(trim(p_password_hash)) = 0 then
    raise exception 'INVALID_INPUT' using errcode = 'P0001';
  end if;

  select * into v_invite
  from public.facility_invitations
  where token_hash = p_token_hash
  for update;

  if not found then
    raise exception 'INVITE_NOT_FOUND' using errcode = 'P0001';
  end if;

  if v_invite.status = 'REVOKED' then
    raise exception 'INVITE_REVOKED' using errcode = 'P0001';
  end if;
  if v_invite.status = 'ACCEPTED' then
    raise exception 'INVITE_ALREADY_USED' using errcode = 'P0001';
  end if;
  if v_invite.expires_at < now() then
    update public.facility_invitations set status = 'EXPIRED', updated_at = now() where id = v_invite.id;
    raise exception 'INVITE_EXPIRED' using errcode = 'P0001';
  end if;
  if v_invite.status not in ('PENDING', 'SENT') then
    raise exception 'INVITE_ALREADY_USED' using errcode = 'P0001';
  end if;

  select * into v_existing from public.profiles where lower(email) = lower(v_invite.email);
  if found then
    raise exception 'IDENTITY_EXISTS' using errcode = 'P0001';
  end if;

  if v_invite.department_id is not null and not exists (
    select 1 from public.departments where id = v_invite.department_id and tenant_id = v_invite.tenant_id
  ) then
    raise exception 'DEPARTMENT_OUT_OF_SCOPE' using errcode = 'P0001';
  end if;

  insert into public.profiles (
    id, email, full_name, first_name, last_name, role, tenant_id, hospital_id,
    password_hash, must_change_password, onboarding_complete, verification_status,
    email_verified_at, created_by
  ) values (
    p_profile_id, v_invite.email, p_full_name, p_first_name, p_last_name, v_invite.role, v_invite.tenant_id, null,
    p_password_hash, false, false, 'pending',
    now(), null
  );

  insert into public.staff_scope_assignments (profile_id, tenant_id, role, department_id, is_active)
  values (p_profile_id, v_invite.tenant_id, v_invite.role, v_invite.department_id, true)
  on conflict (profile_id, role, coalesce(organization_id, '00000000-0000-0000-0000-000000000000'::uuid), coalesce(tenant_id, '00000000-0000-0000-0000-000000000000'::uuid), coalesce(site_id, '00000000-0000-0000-0000-000000000000'::uuid), coalesce(department_id, '00000000-0000-0000-0000-000000000000'::uuid))
  where is_active
  do nothing;

  update public.facility_invitations
  set status = 'ACCEPTED', accepted_at = now(), redeemed_by = p_profile_id, profile_id = p_profile_id, updated_at = now()
  where id = v_invite.id and status in ('PENDING', 'SENT');

  if not found then
    raise exception 'INVITE_ALREADY_USED' using errcode = 'P0001';
  end if;

  insert into public.facility_invitation_audit (invitation_id, event, actor_profile_id, metadata)
  values (v_invite.id, 'ACCEPTED_NEW_ACCOUNT', p_profile_id, jsonb_build_object('tenant_id', v_invite.tenant_id, 'role', v_invite.role, 'department_id', v_invite.department_id));

  return jsonb_build_object('profile_id', p_profile_id, 'tenant_id', v_invite.tenant_id);
end;
$$;


ALTER FUNCTION "public"."accept_facility_invitation_new_account"("p_token_hash" "text", "p_profile_id" "uuid", "p_password_hash" "text", "p_full_name" "text", "p_first_name" "text", "p_last_name" "text") OWNER TO "postgres";


COMMENT ON FUNCTION "public"."accept_facility_invitation_new_account"("p_token_hash" "text", "p_profile_id" "uuid", "p_password_hash" "text", "p_full_name" "text", "p_first_name" "text", "p_last_name" "text") IS 'Transactional invitation acceptance that creates a brand-new profile. Never sets onboarding_complete=true and never sets a professional-credential field. Rolls back entirely on any failure.';



CREATE OR REPLACE FUNCTION "public"."activate_subscription_payment"("p_payment_id" "uuid", "p_actor" "text" DEFAULT 'webhook'::"text") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  pay subscription_payments%ROWTYPE;
  sub tenant_subscriptions%ROWTYPE;
  v_period_end timestamptz;
BEGIN
  SELECT * INTO pay FROM subscription_payments WHERE id = p_payment_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'payment_not_found');
  END IF;
  IF pay.status = 'successful' THEN
    RETURN jsonb_build_object('ok', true, 'idempotent', true);
  END IF;

  v_period_end := COALESCE(pay.period_end, now() + interval '1 month');

  UPDATE subscription_payments SET
    status = 'successful',
    confirmed_at = now()
  WHERE id = p_payment_id;

  SELECT * INTO sub FROM tenant_subscriptions WHERE tenant_id = pay.tenant_id FOR UPDATE;

  IF FOUND THEN
    UPDATE tenant_subscriptions SET
      plan_id = COALESCE(pay.plan_id, sub.plan_id),
      status = 'active',
      current_period_start = COALESCE(pay.period_start, now()),
      current_period_end = v_period_end,
      grace_until = NULL,
      last_payment_at = now(),
      updated_at = now()
    WHERE tenant_id = pay.tenant_id;
    PERFORM log_subscription_event(
      pay.tenant_id, sub.status, 'active', 'payment_confirmed', p_actor,
      jsonb_build_object('payment_id', p_payment_id, 'amount_ugx', pay.amount_ugx)
    );
  ELSE
    INSERT INTO tenant_subscriptions (
      tenant_id, plan_id, status,
      current_period_start, current_period_end, last_payment_at
    ) VALUES (
      pay.tenant_id, pay.plan_id, 'active',
      COALESCE(pay.period_start, now()), v_period_end, now()
    );
    PERFORM log_subscription_event(
      pay.tenant_id, NULL, 'active', 'payment_confirmed_new_sub', p_actor,
      jsonb_build_object('payment_id', p_payment_id)
    );
  END IF;

  UPDATE tenants SET status = 'active', updated_at = now() WHERE id = pay.tenant_id;

  RETURN jsonb_build_object('ok', true, 'tenant_id', pay.tenant_id, 'period_end', v_period_end);
END;
$$;


ALTER FUNCTION "public"."activate_subscription_payment"("p_payment_id" "uuid", "p_actor" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."adjust_pharmacy_batch_stock"("p_tenant_id" "uuid", "p_product_id" "uuid", "p_quantity" integer, "p_type" "text", "p_reason" "text", "p_actor_id" "uuid", "p_batch_id" "uuid" DEFAULT NULL::"uuid", "p_batch_number" "text" DEFAULT NULL::"text", "p_expiry_date" "date" DEFAULT NULL::"date", "p_cost_price" numeric DEFAULT NULL::numeric, "p_restore_as" "text" DEFAULT 'active'::"text") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_product pharmacy_products%rowtype;
  v_batch pharmacy_product_batches%rowtype;
  v_type text := upper(trim(coalesce(p_type, '')));
  v_prev int;
  v_new int;
  v_current int;
  v_delta int;
  v_kla_today date := (timezone('Africa/Kampala', now()))::date;
  v_needed int;
  v_take int;
begin
  perform public.pharmacy_assert_actor(p_tenant_id, p_actor_id);

  if p_reason is null or length(trim(p_reason)) = 0 then
    raise exception 'INVALID_QUANTITY: adjustment reason is required';
  end if;

  select * into v_product from pharmacy_products
  where id = p_product_id and tenant_id = p_tenant_id for update;
  if not found then
    raise exception 'PRODUCT_NOT_FOUND: %', p_product_id;
  end if;

  -- INCREASE must go through receive semantics (genuine batch + expiry).
  if v_type = 'INCREASE' then
    if p_quantity is null or p_quantity <= 0 then
      raise exception 'INVALID_QUANTITY: increase quantity must be positive';
    end if;
    return public.receive_pharmacy_stock(
      p_tenant_id, p_product_id,
      coalesce(p_batch_number, ''),
      p_quantity, p_expiry_date, p_cost_price, p_actor_id,
      null, null, null, null, null, p_reason
    );
  end if;

  if v_type in ('DAMAGE', 'QUARANTINE', 'RECALL') then
    if p_batch_id is null then
      raise exception 'BATCH_NOT_FOUND: batch_id is required for %', v_type;
    end if;
    select * into v_batch from pharmacy_product_batches
    where id = p_batch_id and tenant_id = p_tenant_id and product_id = p_product_id
    for update;
    if not found then
      raise exception 'BATCH_NOT_FOUND: %', p_batch_id;
    end if;

    update pharmacy_product_batches
    set status = case v_type
          when 'DAMAGE' then 'damaged'
          when 'QUARANTINE' then 'quarantined'
          when 'RECALL' then 'recalled'
        end,
        is_active = case when v_type = 'RECALL' then false else is_active end,
        damaged_reason = case when v_type = 'DAMAGE' then p_reason else damaged_reason end,
        quarantine_reason = case when v_type = 'QUARANTINE' then p_reason else quarantine_reason end,
        recalled_at = case when v_type = 'RECALL' then now() else recalled_at end,
        updated_at = now()
    where id = v_batch.id;

    insert into pharmacy_audit_logs (tenant_id, profile_id, action, entity, entity_id, details)
    values (
      p_tenant_id, p_actor_id, 'stock.' || lower(v_type),
      'pharmacy_product_batches', v_batch.id,
      format('product=%s qty=%s reason=%s', p_product_id, v_batch.quantity, p_reason)
    );

    return jsonb_build_object('ok', true, 'batch_id', v_batch.id, 'status', lower(v_type));
  end if;

  if v_type = 'DECREASE' then
    if p_quantity is null or p_quantity <= 0 then
      raise exception 'INVALID_QUANTITY: decrease quantity must be positive';
    end if;

    -- Refuse a decrease the recorded product total cannot cover. Decrementing
    -- batches first and clamping the product total at zero is what let the two
    -- drift apart.
    v_prev := coalesce(v_product.quantity, 0);
    if p_quantity > v_prev then
      raise exception 'INSUFFICIENT_STOCK: short by % units', p_quantity - v_prev;
    end if;
    v_current := v_prev;

    v_needed := p_quantity;

    if p_batch_id is not null then
      select * into v_batch from pharmacy_product_batches
      where id = p_batch_id and tenant_id = p_tenant_id and product_id = p_product_id
      for update;
      if not found then
        raise exception 'BATCH_NOT_FOUND: %', p_batch_id;
      end if;
      if v_batch.quantity < v_needed then
        raise exception 'INSUFFICIENT_BATCH: only % units on batch', v_batch.quantity;
      end if;
      update pharmacy_product_batches
      set quantity = quantity - v_needed,
          status = case when quantity - v_needed <= 0 then 'exhausted' else status end,
          updated_at = now()
      where id = v_batch.id;
      v_take := v_needed;
      insert into pharmacy_stock_adjustments (
        tenant_id, product_id, batch_id, quantity, type, reason, previous_qty, new_qty, created_by
      ) values (
        p_tenant_id, p_product_id, v_batch.id, v_take, 'DECREASE', p_reason,
        v_current, v_current - v_take, p_actor_id
      );
      v_current := v_current - v_take;
    else
      -- FEFO decrease across sellable batches
      for v_batch in
        select * from pharmacy_product_batches
        where product_id = p_product_id and tenant_id = p_tenant_id
          and is_active and coalesce(status, 'active') = 'active' and quantity > 0
          and (expiry_date is null or expiry_date >= v_kla_today)
        order by expiry_date asc nulls last, received_date asc
        for update
      loop
        exit when v_needed <= 0;
        v_take := least(v_batch.quantity, v_needed);
        update pharmacy_product_batches
        set quantity = quantity - v_take,
            status = case when quantity - v_take <= 0 then 'exhausted' else status end,
            updated_at = now()
        where id = v_batch.id;
        insert into pharmacy_stock_adjustments (
          tenant_id, product_id, batch_id, quantity, type, reason, previous_qty, new_qty, created_by
        ) values (
          p_tenant_id, p_product_id, v_batch.id, v_take, 'DECREASE', p_reason,
          v_current, v_current - v_take, p_actor_id
        );
        v_current := v_current - v_take;
        v_needed := v_needed - v_take;
      end loop;
      if v_needed > 0 then
        raise exception 'INSUFFICIENT_STOCK: short by % units', v_needed;
      end if;
    end if;

    v_new := v_current;
    update pharmacy_products set quantity = v_new, updated_at = now() where id = p_product_id;

    insert into pharmacy_audit_logs (tenant_id, profile_id, action, entity, entity_id, details)
    values (
      p_tenant_id, p_actor_id, 'stock.decrease', 'pharmacy_products', p_product_id,
      format('batch=%s qty=%s reason=%s', coalesce(p_batch_id::text, 'fefo'), p_quantity, p_reason)
    );

    return jsonb_build_object('ok', true, 'previous_qty', v_prev, 'new_qty', v_new, 'decreased', p_quantity);
  end if;

  if v_type = 'CORRECTION' then
    -- Batch-scoped absolute correction only — never invent batches.
    if p_batch_id is null then
      raise exception 'BATCH_NOT_FOUND: CORRECTION requires batch_id (do not correct product.quantity alone)';
    end if;
    if p_quantity is null or p_quantity < 0 then
      raise exception 'INVALID_QUANTITY: correction quantity must be >= 0';
    end if;
    select * into v_batch from pharmacy_product_batches
    where id = p_batch_id and tenant_id = p_tenant_id and product_id = p_product_id
    for update;
    if not found then
      raise exception 'BATCH_NOT_FOUND: %', p_batch_id;
    end if;

    v_delta := p_quantity - coalesce(v_batch.quantity, 0);
    update pharmacy_product_batches
    set quantity = p_quantity,
        status = case
          when p_quantity <= 0 then 'exhausted'
          when coalesce(status, 'active') = 'exhausted' then 'active'
          else status
        end,
        expiry_date = coalesce(p_expiry_date, expiry_date),
        cost_price = coalesce(p_cost_price, cost_price),
        updated_at = now()
    where id = v_batch.id;

    -- The delta is applied exactly. Clamping at zero is what made the product
    -- total disagree with the sum of its batches; a negative result means the
    -- two had already drifted. Refuse it rather than storing negative stock.
    v_prev := coalesce(v_product.quantity, 0);
    v_new := v_prev + v_delta;
    if v_new < 0 then
      raise exception 'STOCK_DRIFT: product total % cannot absorb a batch correction of %; reconcile product and batch totals first', v_prev, v_delta;
    end if;
    update pharmacy_products set quantity = v_new, updated_at = now() where id = p_product_id;

    insert into pharmacy_stock_adjustments (
      tenant_id, product_id, batch_id, quantity, type, reason, previous_qty, new_qty, created_by
    ) values (
      p_tenant_id, p_product_id, v_batch.id, v_delta, 'CORRECTION', p_reason,
      v_prev, v_new, p_actor_id
    );

    insert into pharmacy_audit_logs (tenant_id, profile_id, action, entity, entity_id, details)
    values (
      p_tenant_id, p_actor_id, 'stock.correction', 'pharmacy_product_batches', v_batch.id,
      format('product_qty %s->%s delta=%s batch=%s reason=%s', v_prev, v_new, v_delta, v_batch.id, p_reason)
    );

    return jsonb_build_object(
      'ok', true, 'batch_id', v_batch.id,
      'batch_quantity', p_quantity, 'previous_qty', v_prev, 'new_qty', v_new
    );
  end if;

  raise exception 'INVALID_QUANTITY: unsupported adjustment type %', p_type;
end;
$$;


ALTER FUNCTION "public"."adjust_pharmacy_batch_stock"("p_tenant_id" "uuid", "p_product_id" "uuid", "p_quantity" integer, "p_type" "text", "p_reason" "text", "p_actor_id" "uuid", "p_batch_id" "uuid", "p_batch_number" "text", "p_expiry_date" "date", "p_cost_price" numeric, "p_restore_as" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."adjust_pharmacy_stock"("p_tenant_id" "uuid", "p_product_id" "uuid", "p_delta" integer, "p_reason" "text", "p_actor" "uuid", "p_batch_id" "uuid" DEFAULT NULL::"uuid", "p_set_status" "text" DEFAULT NULL::"text") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_product pharmacy_products%rowtype;
  v_batch pharmacy_product_batches%rowtype;
  v_prev_product integer;
  v_new_product integer;
  v_remaining integer;
  v_take integer;
begin
  if p_reason is null or length(trim(p_reason)) = 0 then
    raise exception 'REASON_REQUIRED: a reason is required for every stock adjustment';
  end if;
  if p_set_status is not null and p_set_status not in ('active','quarantined','damaged','recalled','expired') then
    raise exception 'INVALID_STATUS: %', p_set_status;
  end if;

  select * into v_product from pharmacy_products
  where id = p_product_id and tenant_id = p_tenant_id for update;
  if not found then
    raise exception 'PRODUCT_NOT_FOUND: %', p_product_id;
  end if;
  v_prev_product := coalesce(v_product.quantity, 0);

  if p_batch_id is not null then
    select * into v_batch from pharmacy_product_batches
    where id = p_batch_id and tenant_id = p_tenant_id and product_id = p_product_id for update;
    if not found then
      raise exception 'BATCH_NOT_FOUND: %', p_batch_id;
    end if;

    update pharmacy_product_batches
    set quantity = greatest(coalesce(quantity,0) + p_delta, 0),
        status = coalesce(p_set_status, status),
        updated_at = now()
    where id = p_batch_id;

  elsif p_delta < 0 then
    -- FEFO deduction across sellable batches.
    v_remaining := abs(p_delta);
    for v_batch in
      select * from pharmacy_product_batches
      where product_id = p_product_id and tenant_id = p_tenant_id
        and coalesce(status,'active') = 'active' and quantity > 0
      order by expiry_date asc nulls last, received_date asc
      for update
    loop
      exit when v_remaining = 0;
      v_take := least(v_batch.quantity, v_remaining);
      update pharmacy_product_batches
      set quantity = quantity - v_take, updated_at = now()
      where id = v_batch.id;
      v_remaining := v_remaining - v_take;
    end loop;
    if v_remaining > 0 then
      raise exception 'INSUFFICIENT_STOCK: % short by % units for adjustment', v_product.name, v_remaining;
    end if;
  else
    raise exception 'REQUIRES_BATCH: stock increases must enter through receiving (batch + expiry)';
  end if;

  -- Keep product.quantity authoritative (= sum of batches).
  v_new_product := public.recompute_pharmacy_product_quantity(p_tenant_id, p_product_id);

  insert into pharmacy_stock_adjustments
    (tenant_id, product_id, quantity, type, reason, previous_qty, new_qty, created_by)
  values
    (p_tenant_id, p_product_id, p_delta,
     case when p_delta >= 0 then 'INCREASE' else 'DECREASE' end,
     p_reason, v_prev_product, v_new_product, p_actor);

  begin
    insert into pharmacy_audit_logs (tenant_id, profile_id, action, entity, entity_id, details)
    values (p_tenant_id, p_actor, 'STOCK_ADJUSTMENT', 'pharmacy_products', p_product_id,
            jsonb_build_object('delta', p_delta, 'reason', p_reason, 'batch_id', p_batch_id,
                               'previous', v_prev_product, 'new', v_new_product, 'set_status', p_set_status));
  exception when undefined_table then
    null;
  end;

  return jsonb_build_object('ok', true, 'product_id', p_product_id,
                            'previous_quantity', v_prev_product, 'new_quantity', v_new_product);
end;
$$;


ALTER FUNCTION "public"."adjust_pharmacy_stock"("p_tenant_id" "uuid", "p_product_id" "uuid", "p_delta" integer, "p_reason" "text", "p_actor" "uuid", "p_batch_id" "uuid", "p_set_status" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."advance_all_subscriptions"("p_actor" "text" DEFAULT 'cron'::"text") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  r record;
  v_changed integer := 0;
  v_checked integer := 0;
  v_result text;
BEGIN
  FOR r IN SELECT tenant_id FROM tenant_subscriptions LOOP
    v_checked := v_checked + 1;
    v_result := advance_subscription_state(r.tenant_id, p_actor);
    IF v_result NOT IN ('no_subscription') THEN
      v_changed := v_changed + 1;
    END IF;
  END LOOP;
  RETURN jsonb_build_object('checked', v_checked, 'processed', v_changed, 'at', now());
END;
$$;


ALTER FUNCTION "public"."advance_all_subscriptions"("p_actor" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."advance_subscription_state"("p_tenant_id" "uuid", "p_actor" "text" DEFAULT 'cron'::"text") RETURNS "text"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  sub tenant_subscriptions%ROWTYPE;
  v_grace_days integer;
  v_new_status text;
BEGIN
  SELECT * INTO sub FROM tenant_subscriptions WHERE tenant_id = p_tenant_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN 'no_subscription';
  END IF;

  v_grace_days := billing_grace_days();
  v_new_status := sub.status;

  IF sub.status IN ('trialing', 'trial')
     AND sub.trial_ends IS NOT NULL
     AND now() >= sub.trial_ends THEN
    v_new_status := 'past_due';
    UPDATE tenant_subscriptions SET
      status = v_new_status,
      grace_until = now() + (v_grace_days || ' days')::interval,
      updated_at = now()
    WHERE tenant_id = p_tenant_id;
    PERFORM log_subscription_event(p_tenant_id, sub.status, v_new_status, 'trial_ended', p_actor);
    RETURN v_new_status;
  END IF;

  IF sub.status = 'active'
     AND sub.current_period_end IS NOT NULL
     AND now() >= sub.current_period_end THEN
    v_new_status := 'past_due';
    UPDATE tenant_subscriptions SET
      status = v_new_status,
      grace_until = now() + (v_grace_days || ' days')::interval,
      updated_at = now()
    WHERE tenant_id = p_tenant_id;
    PERFORM log_subscription_event(p_tenant_id, sub.status, v_new_status, 'period_ended', p_actor);
    RETURN v_new_status;
  END IF;

  IF sub.status = 'past_due'
     AND sub.grace_until IS NOT NULL
     AND now() >= sub.grace_until THEN
    v_new_status := 'suspended';
    UPDATE tenant_subscriptions SET
      status = v_new_status,
      updated_at = now()
    WHERE tenant_id = p_tenant_id;
    PERFORM log_subscription_event(p_tenant_id, sub.status, v_new_status, 'grace_expired', p_actor);
    RETURN v_new_status;
  END IF;

  RETURN sub.status;
END;
$$;


ALTER FUNCTION "public"."advance_subscription_state"("p_tenant_id" "uuid", "p_actor" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."allocate_lab_accession"("p_tenant_id" "uuid", "p_facility_code" "text", "p_day" "text") RETURNS "text"
    LANGUAGE "plpgsql"
    AS $$
DECLARE
  v_next INTEGER;
BEGIN
  INSERT INTO public.lab_accession_counters (tenant_id, facility_code, day_key, last_value)
  VALUES (p_tenant_id, upper(p_facility_code), p_day, 1)
  ON CONFLICT (tenant_id, facility_code, day_key)
  DO UPDATE SET last_value = public.lab_accession_counters.last_value + 1
  RETURNING last_value INTO v_next;
  RETURN upper(p_facility_code) || '-' || p_day || '-' || lpad(v_next::text, 6, '0');
END;
$$;


ALTER FUNCTION "public"."allocate_lab_accession"("p_tenant_id" "uuid", "p_facility_code" "text", "p_day" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."apply_encounter_amendment"("p_tenant_id" "uuid", "p_encounter_id" "uuid", "p_field" "text", "p_new_value" "text", "p_reason" "text", "p_amended_by" "uuid") RETURNS "uuid"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_encounter public.encounters%ROWTYPE;
  v_previous text;
  v_amendment_id uuid := gen_random_uuid();
BEGIN
  SELECT * INTO v_encounter
  FROM public.encounters
  WHERE id = p_encounter_id AND tenant_id = p_tenant_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'ENCOUNTER_NOT_FOUND';
  END IF;
  IF v_encounter.is_signed IS NOT TRUE THEN
    RAISE EXCEPTION 'ENCOUNTER_NOT_SIGNED';
  END IF;
  IF length(trim(COALESCE(p_reason, ''))) < 3 THEN
    RAISE EXCEPTION 'AMENDMENT_REASON_REQUIRED';
  END IF;

  IF p_field = 'chief_complaint' THEN
    v_previous := COALESCE(v_encounter.chief_complaint, '');
  ELSIF p_field = 'clinical_stage' THEN
    v_previous := COALESCE(v_encounter.clinical_stage, '');
  ELSIF p_field = 'clinical_note' THEN
    v_previous := COALESCE(v_encounter.metadata->>'clinical_note', '');
  ELSE
    RAISE EXCEPTION 'INVALID_AMENDMENT_FIELD';
  END IF;

  IF v_previous IS NOT DISTINCT FROM p_new_value THEN
    RAISE EXCEPTION 'AMENDMENT_NO_CHANGE';
  END IF;

  INSERT INTO public.encounter_amendments (
    id, tenant_id, encounter_id, field_name,
    previous_value, new_value, reason, amended_by
  ) VALUES (
    v_amendment_id, p_tenant_id, p_encounter_id, p_field,
    v_previous, p_new_value, trim(p_reason), p_amended_by
  );

  PERFORM set_config('synapse.encounter_amendment', '1', true);

  IF p_field = 'chief_complaint' THEN
    UPDATE public.encounters
    SET chief_complaint = p_new_value,
        updated_at = now(),
        version = COALESCE(version, 0) + 1
    WHERE id = p_encounter_id;
  ELSIF p_field = 'clinical_stage' THEN
    UPDATE public.encounters
    SET clinical_stage = p_new_value,
        updated_at = now(),
        version = COALESCE(version, 0) + 1
    WHERE id = p_encounter_id;
  ELSIF p_field = 'clinical_note' THEN
    UPDATE public.encounters
    SET metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('clinical_note', p_new_value),
        updated_at = now(),
        version = COALESCE(version, 0) + 1
    WHERE id = p_encounter_id;
  END IF;

  RETURN v_amendment_id;
END;
$$;


ALTER FUNCTION "public"."apply_encounter_amendment"("p_tenant_id" "uuid", "p_encounter_id" "uuid", "p_field" "text", "p_new_value" "text", "p_reason" "text", "p_amended_by" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."assign_synapse_id"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
BEGIN
  IF NEW.synapse_id IS NULL THEN
    NEW.synapse_id := generate_synapse_id();
  END IF;
  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."assign_synapse_id"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."auto_set_tenant_id"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
BEGIN
  IF NEW.tenant_id IS NULL THEN
    NEW.tenant_id := (
      SELECT tenant_id FROM public.profiles WHERE id = auth.uid()
    );
  END IF;
  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."auto_set_tenant_id"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."billing_grace_days"() RETURNS integer
    LANGUAGE "sql" STABLE
    AS $$
  SELECT COALESCE((value->>'grace_days')::integer, 5)
  FROM platform_billing_config
  WHERE key = 'subscription'
  LIMIT 1;
$$;


ALTER FUNCTION "public"."billing_grace_days"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."bump_record_version"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
BEGIN
  NEW.version = OLD.version + 1;
  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."bump_record_version"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."check_death_sentinel"("p_hospital_id" "uuid") RETURNS TABLE("alert_type" "text", "trigger_count" bigint, "window_hours" integer, "icd11_codes" "text"[], "earliest_death" timestamp with time zone, "latest_death" timestamp with time zone)
    LANGUAGE "sql" STABLE
    AS $$
  SELECT
    'death_cluster'::TEXT                             AS alert_type,
    COUNT(*)::BIGINT                                  AS trigger_count,
    72                                                AS window_hours,
    ARRAY_AGG(DISTINCT underlying_cause_icd11)        AS icd11_codes,
    MIN(died_at)                                      AS earliest_death,
    MAX(died_at)                                      AS latest_death
  FROM public.death_registrations
  WHERE hospital_id  = p_hospital_id
    AND (is_unexplained = true OR is_infectious = true)
    AND died_at       >= NOW() - INTERVAL '72 hours'
  HAVING COUNT(*) >= 3;
$$;


ALTER FUNCTION "public"."check_death_sentinel"("p_hospital_id" "uuid") OWNER TO "postgres";

SET default_tablespace = '';

SET default_table_access_method = "heap";


CREATE TABLE IF NOT EXISTS "public"."consult_queue" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "token" "text" DEFAULT "encode"("extensions"."gen_random_bytes"(24), 'hex'::"text") NOT NULL,
    "case_id" "uuid",
    "guest_key" "text",
    "chief_complaint" "text",
    "specialty_requested" "text",
    "urgency" "text" DEFAULT 'routine'::"text" NOT NULL,
    "status" "text" DEFAULT 'waiting'::"text" NOT NULL,
    "position" integer,
    "estimated_wait_minutes" integer,
    "assigned_doctor_id" "uuid",
    "claimed_at" timestamp with time zone,
    "completed_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "consult_queue_status_check" CHECK (("status" = ANY (ARRAY['waiting'::"text", 'assigned'::"text", 'completed'::"text", 'cancelled'::"text"]))),
    CONSTRAINT "consult_queue_urgency_check" CHECK (("urgency" = ANY (ARRAY['routine'::"text", 'priority'::"text", 'urgent'::"text"])))
);


ALTER TABLE "public"."consult_queue" OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."claim_next_consult"("p_doctor_id" "uuid") RETURNS SETOF "public"."consult_queue"
    LANGUAGE "plpgsql"
    AS $$
DECLARE
  v_row consult_queue;
BEGIN
  SELECT * INTO v_row
  FROM consult_queue
  WHERE status = 'waiting'
  ORDER BY
    CASE urgency WHEN 'urgent' THEN 0 WHEN 'priority' THEN 1 ELSE 2 END,
    created_at ASC
  LIMIT 1
  FOR UPDATE SKIP LOCKED;

  IF v_row.id IS NULL THEN
    RETURN;
  END IF;

  UPDATE consult_queue
  SET status            = 'assigned',
      assigned_doctor_id = p_doctor_id,
      claimed_at        = NOW()
  WHERE id = v_row.id
  RETURNING * INTO v_row;

  RETURN NEXT v_row;
END;
$$;


ALTER FUNCTION "public"."claim_next_consult"("p_doctor_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."complete_pharmacy_sale"("p_tenant_id" "uuid", "p_cashier_id" "uuid", "p_items" "jsonb", "p_payment_method" "text", "p_session_id" "uuid" DEFAULT NULL::"uuid", "p_cart_id" "uuid" DEFAULT NULL::"uuid", "p_payment_ref" "text" DEFAULT NULL::"text", "p_discount_total" numeric DEFAULT 0, "p_tax_amount" numeric DEFAULT 0, "p_patient_id" "uuid" DEFAULT NULL::"uuid", "p_confirmed_by" "uuid" DEFAULT NULL::"uuid") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_sale_id uuid := gen_random_uuid();
  v_item jsonb;
  v_product pharmacy_products%rowtype;
  v_batch pharmacy_product_batches%rowtype;
  v_qty_needed int;
  v_taken int;
  v_take int;
  v_unit_price numeric;
  v_line_discount numeric;
  v_disc_applied boolean;
  v_subtotal numeric := 0;
  v_item_discounts numeric := 0;
  v_discount numeric;
  v_total numeric;
  v_receipt text;
  v_seq int;
  v_kla_today date := (timezone('Africa/Kampala', now()))::date;
  v_confirmed_by uuid := coalesce(p_confirmed_by, p_cashier_id);
begin
  if p_items is null or jsonb_array_length(p_items) = 0 then
    raise exception 'SALE_EMPTY: items array is required';
  end if;
  if p_payment_method is null or length(trim(p_payment_method)) = 0 then
    raise exception 'PAYMENT_METHOD_REQUIRED';
  end if;

  perform pg_advisory_xact_lock(hashtext(p_tenant_id::text || ':pos_receipt'));

  select count(*) + 1 into v_seq
  from pharmacy_pos_sales
  where tenant_id = p_tenant_id
    and (timezone('Africa/Kampala', created_at))::date = v_kla_today;

  v_receipt := 'R-' || to_char(v_kla_today, 'YYYYMMDD') || '-' || lpad(v_seq::text, 4, '0');

  insert into pharmacy_pos_sales
    (id, tenant_id, session_id, cart_id, cashier_id, patient_id, receipt_number,
     subtotal, discount_total, tax_amount, total_amount,
     payment_method, payment_ref, status, confirmed_by, confirmed_at)
  values
    (v_sale_id, p_tenant_id, p_session_id, p_cart_id, p_cashier_id, p_patient_id, v_receipt,
     0, 0, coalesce(p_tax_amount, 0), 0,
     p_payment_method, p_payment_ref, 'pending', null, null);

  for v_item in select * from jsonb_array_elements(p_items) loop
    select * into v_product
    from pharmacy_products
    where id = (v_item->>'product_id')::uuid and tenant_id = p_tenant_id
    for update;

    if not found then
      raise exception 'PRODUCT_NOT_FOUND: %', v_item->>'product_id';
    end if;
    if coalesce(v_product.is_active, true) = false then
      raise exception 'PRODUCT_INACTIVE: %', v_product.name;
    end if;

    v_qty_needed := (v_item->>'quantity')::int;
    if v_qty_needed is null or v_qty_needed <= 0 then
      raise exception 'INVALID_QUANTITY for %', v_product.name;
    end if;

    v_unit_price := coalesce((v_item->>'unit_price')::numeric, v_product.price);
    if v_unit_price is null or v_unit_price < 0 then
      raise exception 'INVALID_PRICE for %', v_product.name;
    end if;
    v_line_discount := coalesce((v_item->>'discount_amount')::numeric, 0);
    v_disc_applied := false;
    v_taken := 0;

    for v_batch in
      select * from pharmacy_product_batches
      where product_id = v_product.id
        and tenant_id = p_tenant_id
        and is_active
        and quantity > 0
        and (expiry_date is null or expiry_date >= v_kla_today)
        and ((v_item->>'batch_id') is null or id = (v_item->>'batch_id')::uuid)
      order by expiry_date asc nulls last, received_date asc
      for update
    loop
      exit when v_qty_needed = 0;
      v_take := least(v_batch.quantity, v_qty_needed);

      update pharmacy_product_batches
      set quantity = quantity - v_take, updated_at = now()
      where id = v_batch.id;

      insert into pharmacy_pos_sale_items
        (id, sale_id, tenant_id, product_id, batch_id, quantity, unit_price,
         discount_amount, stock_decremented)
      values
        (gen_random_uuid(), v_sale_id, p_tenant_id, v_product.id, v_batch.id, v_take, v_unit_price,
         case when not v_disc_applied then v_line_discount else 0 end,
         true);

      v_subtotal := v_subtotal + (v_take * v_unit_price);
      if not v_disc_applied then
        v_item_discounts := v_item_discounts + v_line_discount;
        v_disc_applied := true;
      end if;
      v_qty_needed := v_qty_needed - v_take;
      v_taken := v_taken + v_take;
    end loop;

    if v_qty_needed > 0 then
      raise exception 'INSUFFICIENT_STOCK: % short by % units', v_product.name, v_qty_needed;
    end if;

    update pharmacy_products
    set quantity = greatest(quantity - v_taken, 0), updated_at = now()
    where id = v_product.id;
  end loop;

  v_discount := coalesce(p_discount_total, 0) + v_item_discounts;
  v_total := v_subtotal - v_discount + coalesce(p_tax_amount, 0);
  if v_total < 0 then
    raise exception 'NEGATIVE_TOTAL: discount exceeds subtotal';
  end if;

  update pharmacy_pos_sales
  set subtotal = v_subtotal,
      discount_total = v_discount,
      total_amount = v_total,
      status = 'completed',
      confirmed_by = v_confirmed_by,
      confirmed_at = now(),
      updated_at = now()
  where id = v_sale_id;

  return jsonb_build_object(
    'sale_id', v_sale_id,
    'receipt_number', v_receipt,
    'subtotal', v_subtotal,
    'discount_total', v_discount,
    'tax_amount', coalesce(p_tax_amount, 0),
    'total_amount', v_total,
    'status', 'completed'
  );
end;
$$;


ALTER FUNCTION "public"."complete_pharmacy_sale"("p_tenant_id" "uuid", "p_cashier_id" "uuid", "p_items" "jsonb", "p_payment_method" "text", "p_session_id" "uuid", "p_cart_id" "uuid", "p_payment_ref" "text", "p_discount_total" numeric, "p_tax_amount" numeric, "p_patient_id" "uuid", "p_confirmed_by" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."complete_pharmacy_sale"("p_tenant_id" "uuid", "p_cashier_id" "uuid", "p_items" "jsonb", "p_payment_method" "text", "p_session_id" "uuid" DEFAULT NULL::"uuid", "p_cart_id" "uuid" DEFAULT NULL::"uuid", "p_payment_ref" "text" DEFAULT NULL::"text", "p_discount_total" numeric DEFAULT 0, "p_tax_amount" numeric DEFAULT 0, "p_patient_id" "uuid" DEFAULT NULL::"uuid", "p_confirmed_by" "uuid" DEFAULT NULL::"uuid", "p_idempotency_key" "text" DEFAULT NULL::"text") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_sale_id uuid := gen_random_uuid();
  v_item jsonb;
  v_product pharmacy_products%rowtype;
  v_batch pharmacy_product_batches%rowtype;
  v_qty_needed int;
  v_taken int;
  v_take int;
  v_sellable int;
  v_unit_price numeric;
  v_line_discount numeric;
  v_disc_applied boolean;
  v_subtotal numeric := 0;
  v_item_discounts numeric := 0;
  v_discount numeric;
  v_total numeric;
  v_receipt text;
  v_seq int;
  v_kla_today date := (timezone('Africa/Kampala', now()))::date;
  v_confirmed_by uuid := coalesce(p_confirmed_by, p_cashier_id);
  v_key text := nullif(trim(coalesce(p_idempotency_key, '')), '');
  v_prior jsonb;
  v_claim_id uuid;
  v_result jsonb;
begin
  if p_items is null or jsonb_array_length(p_items) = 0 then
    raise exception 'SALE_EMPTY: items array is required';
  end if;
  if p_payment_method is null or length(trim(p_payment_method)) = 0 then
    raise exception 'PAYMENT_METHOD_REQUIRED';
  end if;

  perform pg_advisory_xact_lock(hashtext(p_tenant_id::text || ':pos_receipt'));

  if v_key is not null then
    begin
      insert into public.pharmacy_sale_idempotency (
        tenant_id, idempotency_key, response_payload, created_by
      ) values (
        p_tenant_id, v_key, '{}'::jsonb, p_cashier_id
      )
      returning id into v_claim_id;
    exception when unique_violation then
      select response_payload into v_prior
      from public.pharmacy_sale_idempotency
      where tenant_id = p_tenant_id and idempotency_key = v_key;

      if v_prior is not null and v_prior <> '{}'::jsonb then
        return v_prior;
      end if;
      raise exception 'IDEMPOTENCY_IN_PROGRESS: retry shortly';
    end;
  end if;

  select count(*) + 1 into v_seq
  from pharmacy_pos_sales
  where tenant_id = p_tenant_id
    and (timezone('Africa/Kampala', created_at))::date = v_kla_today;

  v_receipt := 'R-' || to_char(v_kla_today, 'YYYYMMDD') || '-' || lpad(v_seq::text, 4, '0');

  insert into pharmacy_pos_sales
    (id, tenant_id, session_id, cart_id, cashier_id, patient_id, receipt_number,
     subtotal, discount_total, tax_amount, total_amount,
     payment_method, payment_ref, status, confirmed_by, confirmed_at)
  values
    (v_sale_id, p_tenant_id, p_session_id, p_cart_id, p_cashier_id, p_patient_id, v_receipt,
     0, 0, coalesce(p_tax_amount, 0), 0,
     p_payment_method, p_payment_ref, 'pending', null, null);

  for v_item in select * from jsonb_array_elements(p_items) loop
    select * into v_product
    from pharmacy_products
    where id = (v_item->>'product_id')::uuid and tenant_id = p_tenant_id
    for update;

    if not found then
      raise exception 'PRODUCT_NOT_FOUND: %', v_item->>'product_id';
    end if;
    if coalesce(v_product.is_active, true) = false then
      raise exception 'PRODUCT_INACTIVE: %', v_product.name;
    end if;

    v_qty_needed := (v_item->>'quantity')::int;
    if v_qty_needed is null or v_qty_needed <= 0 then
      raise exception 'INVALID_QUANTITY for %', v_product.name;
    end if;

    v_unit_price := coalesce((v_item->>'unit_price')::numeric, v_product.price);
    if v_unit_price is null or v_unit_price < 0 then
      raise exception 'INVALID_PRICE for %', v_product.name;
    end if;
    v_line_discount := coalesce((v_item->>'discount_amount')::numeric, 0);
    v_disc_applied := false;
    v_taken := 0;

    -- FEFO over ONLY sellable batches: active status, non-expired, in stock.
    for v_batch in
      select * from pharmacy_product_batches
      where product_id = v_product.id
        and tenant_id = p_tenant_id
        and is_active
        and coalesce(status, 'active') = 'active'
        and quantity > 0
        and (expiry_date is null or expiry_date >= v_kla_today)
        and ((v_item->>'batch_id') is null or id = (v_item->>'batch_id')::uuid)
      order by expiry_date asc nulls last, received_date asc
      for update
    loop
      exit when v_qty_needed = 0;
      v_take := least(v_batch.quantity, v_qty_needed);

      update pharmacy_product_batches
      set quantity = quantity - v_take, updated_at = now()
      where id = v_batch.id;

      insert into pharmacy_pos_sale_items
        (id, sale_id, tenant_id, product_id, batch_id, quantity, unit_price,
         discount_amount, stock_decremented)
      values
        (gen_random_uuid(), v_sale_id, p_tenant_id, v_product.id, v_batch.id, v_take, v_unit_price,
         case when not v_disc_applied then v_line_discount else 0 end,
         true);

      v_subtotal := v_subtotal + (v_take * v_unit_price);
      if not v_disc_applied then
        v_item_discounts := v_item_discounts + v_line_discount;
        v_disc_applied := true;
      end if;
      v_qty_needed := v_qty_needed - v_take;
      v_taken := v_taken + v_take;
    end loop;

    if v_qty_needed > 0 then
      -- Report the total sellable quantity for the structured POS error contract.
      select coalesce(sum(quantity), 0) into v_sellable
      from pharmacy_product_batches
      where product_id = v_product.id and tenant_id = p_tenant_id
        and is_active and coalesce(status, 'active') = 'active' and quantity > 0
        and (expiry_date is null or expiry_date >= v_kla_today);
      raise exception 'INSUFFICIENT_STOCK: % short by % units (sellable %)',
        v_product.name, v_qty_needed, v_sellable;
    end if;

    update pharmacy_products
    set quantity = greatest(quantity - v_taken, 0), updated_at = now()
    where id = v_product.id;
  end loop;

  v_discount := coalesce(p_discount_total, 0) + v_item_discounts;
  v_total := v_subtotal - v_discount + coalesce(p_tax_amount, 0);
  if v_total < 0 then
    raise exception 'NEGATIVE_TOTAL: discount exceeds subtotal';
  end if;

  update pharmacy_pos_sales
  set subtotal = v_subtotal,
      discount_total = v_discount,
      total_amount = v_total,
      status = 'completed',
      confirmed_by = v_confirmed_by,
      confirmed_at = now(),
      updated_at = now()
  where id = v_sale_id;

  v_result := jsonb_build_object(
    'sale_id', v_sale_id,
    'receipt_number', v_receipt,
    'subtotal', v_subtotal,
    'discount_total', v_discount,
    'tax_amount', coalesce(p_tax_amount, 0),
    'total_amount', v_total,
    'status', 'completed'
  );

  if v_claim_id is not null then
    update public.pharmacy_sale_idempotency
    set sale_id = v_sale_id,
        response_payload = v_result
    where id = v_claim_id;
  end if;

  return v_result;
end;
$$;


ALTER FUNCTION "public"."complete_pharmacy_sale"("p_tenant_id" "uuid", "p_cashier_id" "uuid", "p_items" "jsonb", "p_payment_method" "text", "p_session_id" "uuid", "p_cart_id" "uuid", "p_payment_ref" "text", "p_discount_total" numeric, "p_tax_amount" numeric, "p_patient_id" "uuid", "p_confirmed_by" "uuid", "p_idempotency_key" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."current_hospital_id"() RETURNS "uuid"
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  SELECT hospital_id FROM profiles WHERE id = auth.uid() LIMIT 1;
$$;


ALTER FUNCTION "public"."current_hospital_id"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."current_staff_site_ids"() RETURNS "uuid"[]
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  select coalesce(array_agg(site_id) filter (where site_id is not null), '{}'::uuid[])
  from public.staff_scope_assignments
  where profile_id = auth.uid() and is_active;
$$;


ALTER FUNCTION "public"."current_staff_site_ids"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."current_tenant_id"() RETURNS "uuid"
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  SELECT tenant_id FROM profiles WHERE id = auth.uid() LIMIT 1;
$$;


ALTER FUNCTION "public"."current_tenant_id"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."custom_access_token_hook"("event" "jsonb") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    AS $$
DECLARE
  v_tenant_id UUID;
BEGIN
  SELECT tenant_id INTO v_tenant_id
  FROM public.profiles
  WHERE id = (event->>'user_id')::UUID;

  IF v_tenant_id IS NOT NULL THEN
    RETURN jsonb_set(event, '{claims,tenant_id}', to_jsonb(v_tenant_id::text));
  END IF;
  RETURN event;
END;
$$;


ALTER FUNCTION "public"."custom_access_token_hook"("event" "jsonb") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."expand_facility_types"("p_type" "text") RETURNS SETOF "text"
    LANGUAGE "sql" STABLE
    AS $$
  WITH RECURSIVE ft(t) AS (
    SELECT p_type
    UNION
    SELECT fti.includes
    FROM facility_type_inheritance fti
    JOIN ft ON ft.t = fti.facility_type
  )
  SELECT t FROM ft;
$$;


ALTER FUNCTION "public"."expand_facility_types"("p_type" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."expand_roles"("p_role" "text") RETURNS SETOF "text"
    LANGUAGE "sql" STABLE
    AS $$
  WITH RECURSIVE ex(r) AS (
    SELECT p_role
    UNION
    SELECT rh.inherits
    FROM role_hierarchy rh
    JOIN ex ON ex.r = rh.role
  )
  SELECT r FROM ex;
$$;


ALTER FUNCTION "public"."expand_roles"("p_role" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."find_duplicate_patients"("p_hospital_id" "uuid", "p_full_name" "text", "p_dob" "date" DEFAULT NULL::"date", "p_phone_hash" character varying DEFAULT NULL::character varying, "p_nin_hash" character varying DEFAULT NULL::character varying, "p_similarity_threshold" double precision DEFAULT 0.55) RETURNS TABLE("id" "uuid", "mrn" character varying, "full_name" "text", "dob" "date", "similarity" double precision, "match_reason" "text")
    LANGUAGE "sql" STABLE
    AS $$
  SELECT
    pt.id,
    pt.mrn,
    pt.full_name,
    pt.dob,
    GREATEST(
      COALESCE(similarity(pt.full_name, p_full_name), 0),
      CASE WHEN p_nin_hash   IS NOT NULL AND pt.nin_hash   = p_nin_hash   THEN 1.0 ELSE 0 END,
      CASE WHEN p_phone_hash IS NOT NULL AND pt.phone_hash = p_phone_hash THEN 0.95 ELSE 0 END,
      CASE WHEN p_dob        IS NOT NULL AND pt.dob        = p_dob        THEN 0.8  ELSE 0 END
    )::FLOAT                                                                          AS similarity,
    CASE
      WHEN p_nin_hash   IS NOT NULL AND pt.nin_hash   = p_nin_hash   THEN 'NIN match'
      WHEN p_phone_hash IS NOT NULL AND pt.phone_hash = p_phone_hash THEN 'Phone match'
      WHEN p_dob        IS NOT NULL AND pt.dob        = p_dob
       AND similarity(pt.full_name, p_full_name) > 0.4                 THEN 'Name + DOB match'
      ELSE 'Name similarity'
    END                                                                               AS match_reason
  FROM public.patients pt
  WHERE pt.hospital_id = p_hospital_id
    AND (
      (p_nin_hash   IS NOT NULL AND pt.nin_hash   = p_nin_hash)
      OR (p_phone_hash IS NOT NULL AND pt.phone_hash = p_phone_hash)
      OR (p_dob IS NOT NULL AND pt.dob = p_dob AND similarity(pt.full_name, p_full_name) > 0.4)
      OR (pt.full_name IS NOT NULL AND similarity(pt.full_name, p_full_name) > p_similarity_threshold)
    )
  ORDER BY similarity DESC
  LIMIT 10;
$$;


ALTER FUNCTION "public"."find_duplicate_patients"("p_hospital_id" "uuid", "p_full_name" "text", "p_dob" "date", "p_phone_hash" character varying, "p_nin_hash" character varying, "p_similarity_threshold" double precision) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."fn_sync_network_inventory"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_tenant_id uuid;
  v_is_network boolean;
begin
  v_tenant_id := case when tg_op = 'DELETE' then old.tenant_id else new.tenant_id end;

  select coalesce(is_network_member, false)
    into v_is_network
  from tenants
  where id = v_tenant_id;

  if not coalesce(v_is_network, false) then
    return coalesce(new, old);
  end if;

  if tg_op = 'DELETE' then
    update pharmacy_network_inventory
       set quantity_in_stock = 0,
           last_synced_at = now()
     where pharmacy_tenant_id = v_tenant_id
       and drug_name = lower(trim(coalesce(old.name, 'Unknown')));
    return old;
  end if;

  insert into pharmacy_network_inventory (
    pharmacy_tenant_id,
    drug_name,
    generic_name,
    dosage_form,
    strength,
    quantity_in_stock,
    unit_price_ugx,
    last_synced_at
  ) values (
    v_tenant_id,
    lower(trim(coalesce(new.name, 'Unknown'))),
    coalesce(new.generic_name, new.name, 'Unknown'),
    coalesce(new.dosage_form, 'Other'),
    coalesce(new.strength, ''),
    case when coalesce(new.is_active, true) then coalesce(new.quantity, 0) else 0 end,
    coalesce(new.price, 0),
    now()
  )
  on conflict (pharmacy_tenant_id, drug_name)
  do update set
    generic_name = excluded.generic_name,
    dosage_form = excluded.dosage_form,
    strength = excluded.strength,
    quantity_in_stock = excluded.quantity_in_stock,
    unit_price_ugx = excluded.unit_price_ugx,
    last_synced_at = now();

  return new;
end;
$$;


ALTER FUNCTION "public"."fn_sync_network_inventory"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."forbid_platform_audit_mutation"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
begin
  raise exception 'platform_audit_events is append-only';
end;
$$;


ALTER FUNCTION "public"."forbid_platform_audit_mutation"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."generate_synapse_id"() RETURNS "text"
    LANGUAGE "plpgsql"
    AS $$
DECLARE
  new_id TEXT;
  id_exists BOOLEAN;
BEGIN
  LOOP
    new_id := 'SYN-UG-' || upper(substring(
      replace(replace(encode(gen_random_bytes(4),'base64'),'+','A'),'/','B')
      FROM 1 FOR 6
    ));
    SELECT COUNT(*) > 0 INTO id_exists
    FROM patient_profiles WHERE synapse_id = new_id;
    EXIT WHEN NOT id_exists;
  END LOOP;
  RETURN new_id;
END;
$$;


ALTER FUNCTION "public"."generate_synapse_id"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."generate_synapse_id"("p_country_code" "text") RETURNS "text"
    LANGUAGE "plpgsql"
    AS $_$
declare
  alphabet constant text := '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  raw bytea;
  n numeric;
  i int;
  body text;
  check_idx int;
  candidate text;
  cc text;
  attempts int := 0;
  taken boolean;
begin
  cc := upper(regexp_replace(coalesce(nullif(trim(p_country_code), ''), 'UG'), '[^A-Z]', '', 'g'));
  if length(cc) <> 2 then
    cc := 'UG';
  end if;

  loop
    attempts := attempts + 1;
    raw := gen_random_bytes(5);
    n := 0;
    for i in 0..4 loop
      n := n * 256 + get_byte(raw, i);
    end loop;
    body := '';
    for i in 1..8 loop
      body := substr(alphabet, (n % 32)::int + 1, 1) || body;
      n := trunc(n / 32);
    end loop;
    check_idx := (
      ascii(substr(body, 1, 1)) + ascii(substr(body, 3, 1)) + ascii(substr(body, 5, 1))
      + ascii(substr(body, 8, 1)) + ascii(substr(cc, 1, 1)) + ascii(substr(cc, 2, 1))
    ) % 32;
    candidate := 'SYN-' || cc || '-' || body || substr(alphabet, check_idx + 1, 1);
    taken := exists (select 1 from public.persons where synapse_id = candidate);
    if not taken and to_regclass('public.patient_profiles') is not null then
      execute 'select exists (select 1 from public.patient_profiles where synapse_id = $1)'
        into taken using candidate;
    end if;
    exit when not taken;
    if attempts > 8 then
      raise exception 'SYNAPSE_ID_GENERATION_FAILED';
    end if;
  end loop;
  return candidate;
end;
$_$;


ALTER FUNCTION "public"."generate_synapse_id"("p_country_code" "text") OWNER TO "postgres";


COMMENT ON FUNCTION "public"."generate_synapse_id"("p_country_code" "text") IS 'Person SYNAPSE ID generator. One-arg overload; does not replace live zero-arg generate_synapse_id().';



CREATE OR REPLACE FUNCTION "public"."get_available_beds"("p_bed_type" character varying DEFAULT NULL::character varying, "p_hospital_id" "uuid" DEFAULT NULL::"uuid") RETURNS TABLE("hospital_id" "uuid", "hospital_name" "text", "bed_type" character varying, "available_count" bigint)
    LANGUAGE "sql" STABLE
    AS $$
  SELECT
    hb.hospital_id,
    h.name      AS hospital_name,
    hb.bed_type,
    COUNT(*)    AS available_count
  FROM hospital_beds hb
  JOIN hospitals h ON h.id = hb.hospital_id
  WHERE hb.status = 'available'
    AND (p_bed_type    IS NULL OR hb.bed_type    = p_bed_type)
    AND (p_hospital_id IS NULL OR hb.hospital_id = p_hospital_id)
  GROUP BY hb.hospital_id, h.name, hb.bed_type
  ORDER BY available_count DESC;
$$;


ALTER FUNCTION "public"."get_available_beds"("p_bed_type" character varying, "p_hospital_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."get_queue_position"("p_id" "uuid") RETURNS integer
    LANGUAGE "sql" STABLE
    AS $$
  SELECT COUNT(*)::INT + 1
  FROM consult_queue
  WHERE status = 'waiting'
    AND created_at < (SELECT created_at FROM consult_queue WHERE id = p_id);
$$;


ALTER FUNCTION "public"."get_queue_position"("p_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."guard_hospital_seed_reset"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
DECLARE
  tenant_env text;
BEGIN
  IF NEW.last_reset_at IS DISTINCT FROM OLD.last_reset_at
     AND COALESCE(OLD.is_synthetic, true) = false THEN
    SELECT environment INTO tenant_env
    FROM public.tenants
    WHERE id = NEW.tenant_id;

    IF tenant_env IS NULL OR tenant_env NOT IN ('demo', 'synthetic', 'test') THEN
      RAISE EXCEPTION 'PRODUCTION_HOSPITAL_SEED_RESET_BLOCKED';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."guard_hospital_seed_reset"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."guard_pos_sale_item_mutation"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
DECLARE v_status text;
BEGIN
  SELECT status INTO v_status FROM pharmacy_pos_sales WHERE id = COALESCE(OLD.sale_id, NEW.sale_id);
  IF v_status IN ('completed','voided') THEN
    RAISE EXCEPTION 'APPEND_ONLY: line items of a % sale are immutable', v_status;
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;


ALTER FUNCTION "public"."guard_pos_sale_item_mutation"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."guard_pos_sale_mutation"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status IN ('completed','voided') THEN
      RAISE EXCEPTION 'APPEND_ONLY: completed/voided sales cannot be deleted (sale %)', OLD.receipt_number;
    END IF;
    RETURN OLD;
  END IF;

  -- UPDATE path
  IF OLD.status = 'voided' THEN
    RAISE EXCEPTION 'APPEND_ONLY: voided sales are immutable (sale %)', OLD.receipt_number;
  END IF;

  IF OLD.status = 'completed' THEN
    -- financial identity must never change
    IF NEW.subtotal        IS DISTINCT FROM OLD.subtotal
    OR NEW.discount_total  IS DISTINCT FROM OLD.discount_total
    OR NEW.tax_amount      IS DISTINCT FROM OLD.tax_amount
    OR NEW.total_amount    IS DISTINCT FROM OLD.total_amount
    OR NEW.payment_method  IS DISTINCT FROM OLD.payment_method
    OR NEW.payment_ref     IS DISTINCT FROM OLD.payment_ref
    OR NEW.receipt_number  IS DISTINCT FROM OLD.receipt_number
    OR NEW.tenant_id       IS DISTINCT FROM OLD.tenant_id
    OR NEW.cashier_id      IS DISTINCT FROM OLD.cashier_id
    OR NEW.session_id      IS DISTINCT FROM OLD.session_id
    OR NEW.created_at      IS DISTINCT FROM OLD.created_at THEN
      RAISE EXCEPTION 'APPEND_ONLY: financial fields of a completed sale are immutable (sale %)', OLD.receipt_number;
    END IF;
    -- allowed transitions: receipt artifact updates, or a properly documented void
    IF NEW.status = 'voided' THEN
      IF NEW.voided_reason IS NULL OR NEW.voided_by IS NULL THEN
        RAISE EXCEPTION 'VOID_REQUIRES_AUDIT: voided_reason and voided_by are mandatory (sale %)', OLD.receipt_number;
      END IF;
      NEW.voided_at := COALESCE(NEW.voided_at, now());
    ELSIF NEW.status IS DISTINCT FROM OLD.status THEN
      RAISE EXCEPTION 'APPEND_ONLY: completed sales can only transition to voided (sale %)', OLD.receipt_number;
    END IF;
  END IF;
  RETURN NEW;
END $$;


ALTER FUNCTION "public"."guard_pos_sale_mutation"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."guard_signed_encounter_update"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
BEGIN
  IF OLD.is_signed IS TRUE THEN
    IF (
      NEW.chief_complaint IS DISTINCT FROM OLD.chief_complaint
      OR NEW.clinical_stage IS DISTINCT FROM OLD.clinical_stage
      OR NEW.metadata IS DISTINCT FROM OLD.metadata
    ) AND COALESCE(current_setting('synapse.encounter_amendment', true), '') <> '1' THEN
      RAISE EXCEPTION 'ENCOUNTER_SIGNED_IMMUTABLE'
        USING HINT = 'Use apply_encounter_amendment() to change signed clinical content.';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."guard_signed_encounter_update"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."handle_new_user"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
BEGIN
  INSERT INTO public.profiles (id, full_name, email, is_admin)
  VALUES (
    new.id,
    new.raw_user_meta_data->>'full_name',
    new.email,
    COALESCE((new.raw_user_meta_data->>'is_admin')::boolean, FALSE)
  )
  ON CONFLICT (id) DO UPDATE
  SET full_name = EXCLUDED.full_name,
      email     = EXCLUDED.email,
      is_admin  = EXCLUDED.is_admin;
  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."handle_new_user"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."handle_new_user_profile"() RETURNS "trigger"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  _full_name    text;
  _role         text;
  _department_id uuid;
BEGIN
  _full_name     := nullif(trim(coalesce(new.raw_user_meta_data ->> 'full_name', '')), '');
  _role          := lower(coalesce(new.raw_user_meta_data ->> 'role', 'patient'));
  _department_id := nullif(new.raw_user_meta_data ->> 'department_id', '')::uuid;

  -- Sanitise role — allow all valid roles including platform/founder roles
  IF _role NOT IN (
    'clinician','admin','doctor','nurse','pharmacist','receptionist',
    'lab_technician','radiographer','billing_officer','patient',
    'superadmin','hospital_admin','super_admin','overall_admin',
    'platform_admin','specialist','surgeon','anaesthetist','intensivist',
    'cardiologist','oncologist','psychiatrist','nephrologist','hiv_counselor',
    'art_clinician','obstetrician','paediatrician','theatre_nurse',
    'icu_nurse','chw','social_worker'
  ) THEN
    _role := 'patient';
  END IF;

  INSERT INTO public.profiles (id, full_name, role, department_id)
  VALUES (new.id, _full_name, _role, _department_id)
  ON CONFLICT (id) DO NOTHING;

  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."handle_new_user_profile"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."has_capability"("p_role" "text", "p_facility_type" "text", "p_module" "text", "p_resource" "text", "p_action" "text") RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  SELECT EXISTS (
    SELECT 1
    FROM role_capabilities rc
    JOIN capabilities c ON c.id = rc.capability_id
    WHERE rc.role = p_role
      AND c.module = p_module
      AND c.resource = p_resource
      AND c.action = p_action
      AND (rc.facility_type = p_facility_type OR rc.facility_type = 'any')
  );
$$;


ALTER FUNCTION "public"."has_capability"("p_role" "text", "p_facility_type" "text", "p_module" "text", "p_resource" "text", "p_action" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."has_feature"("p_tenant_id" "uuid", "p_feature" "text") RETURNS boolean
    LANGUAGE "plpgsql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
DECLARE
  v_override boolean;
  v_status   text;
  v_grace    timestamptz;
  v_plan_id  uuid;
  v_has_plan boolean;
  v_readonly text[] := ARRAY[
    'billing.view', 'account.view', 'data.read', 'data.export'
  ];
BEGIN
  SELECT enabled INTO v_override
  FROM tenant_feature_overrides
  WHERE tenant_id = p_tenant_id AND feature_key = p_feature
  LIMIT 1;

  IF FOUND THEN
    RETURN v_override;
  END IF;

  SELECT ts.status, ts.grace_until, ts.plan_id
  INTO v_status, v_grace, v_plan_id
  FROM tenant_subscriptions ts
  WHERE ts.tenant_id = p_tenant_id
  LIMIT 1;

  IF NOT FOUND THEN
    RETURN false;
  END IF;

  IF v_status IN ('active', 'trial', 'trialing') THEN
    SELECT EXISTS (
      SELECT 1 FROM plan_features pf
      WHERE pf.plan_id = v_plan_id AND pf.feature_key = p_feature
    ) INTO v_has_plan;
    RETURN COALESCE(v_has_plan, false);
  END IF;

  IF v_status = 'past_due' AND v_grace IS NOT NULL AND now() < v_grace THEN
    SELECT EXISTS (
      SELECT 1 FROM plan_features pf
      WHERE pf.plan_id = v_plan_id AND pf.feature_key = p_feature
    ) INTO v_has_plan;
    RETURN COALESCE(v_has_plan, false);
  END IF;

  IF v_status IN ('past_due', 'suspended', 'cancelled') THEN
    RETURN p_feature = ANY(v_readonly);
  END IF;

  RETURN false;
END;
$$;


ALTER FUNCTION "public"."has_feature"("p_tenant_id" "uuid", "p_feature" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."has_patient_consent"("p_patient_id" "uuid", "p_module" "text", "p_actor_id" "uuid" DEFAULT "auth"."uid"()) RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    AS $$
  select exists (
    select 1
    from public.patient_consents c
    where c.patient_id   = p_patient_id
      and c.module_name  = p_module
      and c.status       = 'granted'
      and (c.expires_at is null or c.expires_at > now())
  )
  or exists (
    select 1
    from public.patient_access_grants g
    where g.patient_id  = p_patient_id
      and g.granted_to  = p_actor_id
      and g.module_name = p_module
      and g.status      = 'active'
      and (g.valid_until is null or g.valid_until > now())
  );
$$;


ALTER FUNCTION "public"."has_patient_consent"("p_patient_id" "uuid", "p_module" "text", "p_actor_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."is_admin"("_uid" "uuid") RETURNS boolean
    LANGUAGE "sql" STABLE
    AS $$
  select exists (
    select 1
    from public.profiles p
    where p.id = _uid
      and lower(p.role) = 'admin'
  );
$$;


ALTER FUNCTION "public"."is_admin"("_uid" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."is_clinical_staff"() RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  SELECT EXISTS(
    SELECT 1 FROM profiles
    WHERE id = auth.uid()
      AND role IN (
        'doctor',
        'nurse',
        'clinical_officer',
        'radiologist',
        'lab_tech',
        'lab_supervisor',
        'pharmacist',
        'hospital_admin',
        'facility_admin',
        'admin'
      )
  );
$$;


ALTER FUNCTION "public"."is_clinical_staff"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."is_platform_admin"() RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  SELECT EXISTS(
    SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'platform_admin'
  );
$$;


ALTER FUNCTION "public"."is_platform_admin"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."is_platform_operator"() RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public', 'pg_temp'
    AS $$
  select exists (
    select 1 from public.profiles p
    where p.id = auth.uid()
      and p.hospital_id is null
      and (
        p.role in ('superadmin', 'super_admin', 'platform_admin', 'overall_admin')
        or p.platform_control_role in (
          'super_admin', 'platform_admin', 'security_admin', 'integration_admin',
          'release_manager', 'billing_admin', 'customer_success', 'support_admin',
          'clinical_governance', 'read_only_auditor'
        )
      )
  );
$$;


ALTER FUNCTION "public"."is_platform_operator"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."log_subscription_event"("p_tenant_id" "uuid", "p_from_status" "text", "p_to_status" "text", "p_reason" "text", "p_actor" "text", "p_metadata" "jsonb" DEFAULT '{}'::"jsonb") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
BEGIN
  INSERT INTO subscription_events (tenant_id, from_status, to_status, reason, actor, metadata)
  VALUES (p_tenant_id, p_from_status, p_to_status, p_reason, p_actor, p_metadata);
END;
$$;


ALTER FUNCTION "public"."log_subscription_event"("p_tenant_id" "uuid", "p_from_status" "text", "p_to_status" "text", "p_reason" "text", "p_actor" "text", "p_metadata" "jsonb") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."match_ucg_guidelines"("query_embedding" "public"."vector", "match_threshold" double precision DEFAULT 0.65, "match_count" integer DEFAULT 5) RETURNS TABLE("id" "uuid", "guideline_code" character varying, "title" "text", "category" "text", "content" "text", "icd11_codes" "text"[], "similarity" double precision)
    LANGUAGE "sql" STABLE
    AS $$
  select
    id,
    guideline_code,
    title,
    category,
    content,
    icd11_codes,
    1 - (embedding <=> query_embedding) as similarity
  from ucg_guidelines
  where embedding is not null
    and 1 - (embedding <=> query_embedding) > match_threshold
  order by embedding <=> query_embedding
  limit match_count;
$$;


ALTER FUNCTION "public"."match_ucg_guidelines"("query_embedding" "public"."vector", "match_threshold" double precision, "match_count" integer) OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."person_visible_to_tenant"("p_person_id" "uuid", "p_tenant_id" "uuid") RETURNS boolean
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  select exists (
    select 1 from public.person_identifiers i
    where i.person_id = p_person_id
      and i.issuing_facility_id = p_tenant_id
      and i.status = 'active'
  ) or exists (
    select 1 from public.patients p
    where p.person_id = p_person_id and p.tenant_id = p_tenant_id
  ) or exists (
    select 1 from public.pharmacy_customers c
    where c.person_id = p_person_id and c.tenant_id = p_tenant_id
  );
$$;


ALTER FUNCTION "public"."person_visible_to_tenant"("p_person_id" "uuid", "p_tenant_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."persons_assign_synapse_id"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
begin
  if new.synapse_id is null or btrim(new.synapse_id) = '' then
    new.synapse_id := public.generate_synapse_id(new.country_code);
  end if;
  if new.full_name is null or btrim(new.full_name) = '' then
    new.full_name := btrim(concat_ws(' ', new.given_name, new.other_names, new.family_name));
  end if;
  new.updated_at := now();
  return new;
end;
$$;


ALTER FUNCTION "public"."persons_assign_synapse_id"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."pharmacy_assert_actor"("p_tenant_id" "uuid", "p_actor_id" "uuid") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $function$
begin
  if p_tenant_id is null then
    raise exception 'PERMISSION: tenant is required';
  end if;
  if p_actor_id is null then
    raise exception 'PERMISSION: an acting user is required';
  end if;
  -- A pharmacy staff row wins when there is one: it carries the activation
  -- flag the portal and mobile auth enforce. Checking profiles first let a
  -- deactivated pharmacist through on tenant_id alone.
  if exists (
    select 1 from pharmacy_user_settings
    where profile_id = p_actor_id and tenant_id = p_tenant_id
  ) then
    if exists (
      select 1 from pharmacy_user_settings
      where profile_id = p_actor_id and tenant_id = p_tenant_id and is_active
    ) then
      return;
    end if;
    raise exception 'PERMISSION: actor % is deactivated for this pharmacy', p_actor_id;
  end if;
  if exists (
    select 1 from profiles
    where id = p_actor_id and tenant_id = p_tenant_id
  ) then
    return;
  end if;
  raise exception 'PERMISSION: actor % is not a member of this pharmacy', p_actor_id;
end;
$function$;


CREATE OR REPLACE FUNCTION "public"."pos_sale_item_before_insert"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
DECLARE
  v_batch pharmacy_product_batches%ROWTYPE;
  v_prod_manufacturer text;
  v_prod_price numeric;
BEGIN
  SELECT manufacturer, price INTO v_prod_manufacturer, v_prod_price
  FROM pharmacy_products WHERE id = NEW.product_id;

  IF NEW.batch_id IS NOT NULL THEN
    SELECT * INTO v_batch FROM pharmacy_product_batches WHERE id = NEW.batch_id;
    IF FOUND THEN
      IF v_batch.expiry_date IS NOT NULL
         AND v_batch.expiry_date < (now() AT TIME ZONE 'Africa/Kampala')::date THEN
        RAISE EXCEPTION 'EXPIRED_BATCH_BLOCKED: batch % expired % — cannot be sold', v_batch.batch_number, v_batch.expiry_date;
      END IF;
      NEW.batch_number_snapshot       := COALESCE(NEW.batch_number_snapshot, v_batch.batch_number);
      NEW.batch_expiry_snapshot       := COALESCE(NEW.batch_expiry_snapshot, v_batch.expiry_date);
      NEW.batch_manufacturer_snapshot := COALESCE(NEW.batch_manufacturer_snapshot, v_batch.manufacturer, v_prod_manufacturer);
    END IF;
  ELSE
    NEW.batch_manufacturer_snapshot := COALESCE(NEW.batch_manufacturer_snapshot, v_prod_manufacturer);
  END IF;

  NEW.list_price := COALESCE(NEW.list_price, v_prod_price, NEW.unit_price);
  RETURN NEW;
END $$;


ALTER FUNCTION "public"."pos_sale_item_before_insert"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."receive_pharmacy_stock"("p_tenant_id" "uuid", "p_product_id" "uuid", "p_batch_number" "text", "p_quantity" integer, "p_expiry_date" "date", "p_cost_price" numeric DEFAULT NULL::numeric, "p_received_by" "uuid" DEFAULT NULL::"uuid", "p_supplier_ref" "text" DEFAULT NULL::"text", "p_selling_price" numeric DEFAULT NULL::numeric, "p_supplier_id" "uuid" DEFAULT NULL::"uuid", "p_purchase_order_id" "uuid" DEFAULT NULL::"uuid", "p_store_id" "uuid" DEFAULT NULL::"uuid", "p_reason" "text" DEFAULT NULL::"text") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_product pharmacy_products%rowtype;
  v_batch_id uuid;
  v_kla_today date := (timezone('Africa/Kampala', now()))::date;
begin
  if p_batch_number is null or length(trim(p_batch_number)) = 0 then
    raise exception 'REQUIRES_BATCH: a genuine batch number is required to receive stock';
  end if;
  if p_quantity is null or p_quantity <= 0 then
    raise exception 'INVALID_QUANTITY: receiving quantity must be a positive whole number';
  end if;
  if p_expiry_date is null then
    raise exception 'REQUIRES_EXPIRY: a genuine expiry date is required to receive stock';
  end if;
  if p_expiry_date < v_kla_today then
    raise exception 'EXPIRED_RECEIPT: cannot receive stock that is already expired (%)', p_expiry_date;
  end if;

  select * into v_product from pharmacy_products
  where id = p_product_id and tenant_id = p_tenant_id for update;
  if not found then
    raise exception 'PRODUCT_NOT_FOUND: %', p_product_id;
  end if;

  select id into v_batch_id from pharmacy_product_batches
  where tenant_id = p_tenant_id and product_id = p_product_id
    and batch_number = trim(p_batch_number)
    and (expiry_date is not distinct from p_expiry_date)
    and coalesce(status, 'active') in ('active', 'exhausted')
  limit 1
  for update;

  if v_batch_id is not null then
    update pharmacy_product_batches
    set quantity = quantity + p_quantity,
        status = 'active',
        is_active = true,
        cost_price = coalesce(p_cost_price, cost_price),
        updated_at = now()
    where id = v_batch_id;
  else
    insert into pharmacy_product_batches
      (id, tenant_id, product_id, batch_number, quantity, initial_quantity,
       expiry_date, received_date, cost_price, is_active, status)
    values
      (gen_random_uuid(), p_tenant_id, p_product_id, trim(p_batch_number), p_quantity, p_quantity,
       p_expiry_date, v_kla_today, p_cost_price, true, 'active')
    returning id into v_batch_id;
  end if;

  update pharmacy_products
  set quantity = coalesce(quantity, 0) + p_quantity,
      price = coalesce(p_selling_price, price),
      cost_price = coalesce(p_cost_price, cost_price),
      updated_at = now()
  where id = p_product_id;

  begin
    insert into pharmacy_stock_adjustments (
      tenant_id, product_id, quantity, type, reason, previous_qty, new_qty, created_by
    ) values (
      p_tenant_id, p_product_id, p_quantity, 'INCREASE',
      coalesce(p_reason, format('Received batch %s', trim(p_batch_number))),
      greatest(coalesce(v_product.quantity, 0), 0),
      greatest(coalesce(v_product.quantity, 0), 0) + p_quantity,
      p_received_by
    );
  exception when undefined_table then
    null;
  end;

  begin
    insert into pharmacy_audit_logs (tenant_id, profile_id, action, entity, entity_id, details)
    values (
      p_tenant_id, p_received_by, 'stock.received', 'pharmacy_product_batches', v_batch_id,
      jsonb_build_object(
        'product_id', p_product_id,
        'batch_number', trim(p_batch_number),
        'quantity', p_quantity,
        'expiry_date', p_expiry_date,
        'cost_price', p_cost_price,
        'selling_price', p_selling_price,
        'supplier_ref', p_supplier_ref,
        'supplier_id', p_supplier_id,
        'purchase_order_id', p_purchase_order_id,
        'store_id', p_store_id,
        'reason', p_reason
      )::text
    );
  exception
    when undefined_table then null;
    when others then
      begin
        insert into pharmacy_audit_logs (tenant_id, profile_id, action, entity, entity_id, details)
        values (
          p_tenant_id, p_received_by, 'stock.received', 'pharmacy_product_batches', v_batch_id,
          format('Received %s units batch %s (expiry %s)', p_quantity, trim(p_batch_number), p_expiry_date)
        );
      exception when others then null;
      end;
  end;

  return jsonb_build_object(
    'ok', true,
    'batch_id', v_batch_id,
    'product_id', p_product_id,
    'received', p_quantity
  );
end;
$$;


ALTER FUNCTION "public"."receive_pharmacy_stock"("p_tenant_id" "uuid", "p_product_id" "uuid", "p_batch_number" "text", "p_quantity" integer, "p_expiry_date" "date", "p_cost_price" numeric, "p_received_by" "uuid", "p_supplier_ref" "text", "p_selling_price" numeric, "p_supplier_id" "uuid", "p_purchase_order_id" "uuid", "p_store_id" "uuid", "p_reason" "text") OWNER TO "postgres";


COMMENT ON FUNCTION "public"."receive_pharmacy_stock"("p_tenant_id" "uuid", "p_product_id" "uuid", "p_batch_number" "text", "p_quantity" integer, "p_expiry_date" "date", "p_cost_price" numeric, "p_received_by" "uuid", "p_supplier_ref" "text", "p_selling_price" numeric, "p_supplier_id" "uuid", "p_purchase_order_id" "uuid", "p_store_id" "uuid", "p_reason" "text") IS 'Authoritative stock-in: creates/tops-up a real sellable batch and syncs product.quantity.';



CREATE OR REPLACE FUNCTION "public"."receive_pharmacy_stock_transfer"("p_tenant_id" "uuid", "p_transfer_id" "uuid", "p_actor_id" "uuid") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_transfer pharmacy_stock_transfers%rowtype;
  v_alloc record;
  v_to_batch_id uuid;
  v_kla_today date := (timezone('Africa/Kampala', now()))::date;
  v_units_received int := 0;
  v_allocations_received int := 0;
begin
  select * into v_transfer from pharmacy_stock_transfers
  where id = p_transfer_id and tenant_id = p_tenant_id
  for update;
  if not found then
    raise exception 'TRANSFER_NOT_FOUND: %', p_transfer_id;
  end if;
  if v_transfer.status is distinct from 'in_transit' then
    raise exception 'INVALID_TRANSFER_STATE: expected in_transit, got %', v_transfer.status;
  end if;

  for v_alloc in
    select a.*, ti.product_id
    from pharmacy_stock_transfer_item_allocations a
    join pharmacy_stock_transfer_items ti on ti.id = a.transfer_item_id
    where ti.transfer_id = p_transfer_id
      and a.to_batch_id is null
    order by a.created_at asc
  loop
    select id into v_to_batch_id from pharmacy_product_batches
    where tenant_id = p_tenant_id
      and product_id = v_alloc.product_id
      and batch_number = v_alloc.batch_number
      and (expiry_date is not distinct from v_alloc.expiry_date)
      and store_id = v_transfer.to_store_id
      and coalesce(status, 'active') in ('active', 'exhausted')
    limit 1
    for update;

    if v_to_batch_id is not null then
      update pharmacy_product_batches
      set quantity = quantity + v_alloc.quantity,
          status = 'active',
          is_active = true,
          updated_at = now()
      where id = v_to_batch_id;
    else
      insert into pharmacy_product_batches
        (id, tenant_id, product_id, batch_number, quantity, initial_quantity,
         expiry_date, received_date, cost_price, is_active, status, store_id)
      values
        (gen_random_uuid(), p_tenant_id, v_alloc.product_id, v_alloc.batch_number, v_alloc.quantity, v_alloc.quantity,
         v_alloc.expiry_date, v_kla_today, v_alloc.cost_price, true, 'active', v_transfer.to_store_id)
      returning id into v_to_batch_id;
    end if;

    update pharmacy_stock_transfer_item_allocations
    set to_batch_id = v_to_batch_id
    where id = v_alloc.id;

    v_units_received := v_units_received + v_alloc.quantity;
    v_allocations_received := v_allocations_received + 1;
  end loop;

  if v_allocations_received = 0 then
    raise exception 'TRANSFER_EMPTY: transfer % has no shipped allocations to receive', p_transfer_id;
  end if;

  update pharmacy_stock_transfers
  set status = 'received',
      received_by = p_actor_id,
      received_at = now(),
      updated_at = now()
  where id = p_transfer_id;

  begin
    insert into pharmacy_audit_logs (tenant_id, profile_id, action, entity, entity_id, details)
    values (
      p_tenant_id, p_actor_id, 'stock_transfer.received', 'pharmacy_stock_transfers', p_transfer_id,
      jsonb_build_object(
        'from_store_id', v_transfer.from_store_id,
        'to_store_id', v_transfer.to_store_id,
        'allocations', v_allocations_received,
        'units', v_units_received
      )::text
    );
  exception when undefined_table then null;
  end;

  return jsonb_build_object(
    'ok', true,
    'transfer_id', p_transfer_id,
    'status', 'received',
    'allocations_received', v_allocations_received,
    'units_received', v_units_received
  );
end;
$$;


ALTER FUNCTION "public"."receive_pharmacy_stock_transfer"("p_tenant_id" "uuid", "p_transfer_id" "uuid", "p_actor_id" "uuid") OWNER TO "postgres";


COMMENT ON FUNCTION "public"."receive_pharmacy_stock_transfer"("p_tenant_id" "uuid", "p_transfer_id" "uuid", "p_actor_id" "uuid") IS 'Receives an in_transit stock transfer at to_store_id: re-creates/tops-up the genuine source batch (batch_number + expiry_date + cost_price) at the destination so FEFO ordering is preserved across stores.';



CREATE OR REPLACE FUNCTION "public"."recompute_differential"("p_session_id" "uuid") RETURNS "void"
    LANGUAGE "plpgsql"
    AS $$
DECLARE
  hyp             RECORD;
  log_prior_odds  numeric;
  log_post_odds   numeric;
  lr_sum          numeric;
  post_prob       numeric;
  exp_harm        numeric;
  sess_tenant_id  uuid;
BEGIN
  SELECT tenant_id INTO sess_tenant_id FROM reasoning_sessions WHERE id = p_session_id;

  FOR hyp IN
    SELECT id, prior_probability, harm_if_missed, cant_miss
    FROM reasoning_hypotheses
    WHERE session_id = p_session_id AND status = 'active'
  LOOP
    -- log(prior_odds) = log(p / (1-p)); clamp to avoid log(0)
    log_prior_odds := LN(
      GREATEST(0.0001, hyp.prior_probability) /
      GREATEST(0.0001, 1.0 - hyp.prior_probability)
    );

    -- Sum of log(LR) for all evidence affecting this hypothesis
    SELECT COALESCE(SUM(LN(GREATEST(0.0001, ei.likelihood_ratio))), 0.0)
    INTO lr_sum
    FROM reasoning_evidence_impact ei
    WHERE ei.hypothesis_id = hyp.id
      AND ei.session_id    = p_session_id;

    log_post_odds := log_prior_odds + lr_sum;

    -- Sigmoid: P = 1 / (1 + e^(-log_odds))
    post_prob := 1.0 / (1.0 + EXP(-log_post_odds));
    post_prob := GREATEST(0.0001, LEAST(0.9999, post_prob));

    exp_harm := post_prob * hyp.harm_if_missed;

    UPDATE reasoning_hypotheses
    SET posterior_probability = post_prob,
        expected_harm         = exp_harm,
        updated_at            = now()
    WHERE id = hyp.id;
  END LOOP;

  -- Rank: cant_miss first, then by expected_harm DESC
  WITH ranked AS (
    SELECT id,
      ROW_NUMBER() OVER (
        ORDER BY cant_miss DESC, expected_harm DESC NULLS LAST
      ) AS rn
    FROM reasoning_hypotheses
    WHERE session_id = p_session_id AND status = 'active'
  )
  UPDATE reasoning_hypotheses h
  SET rank = ranked.rn
  FROM ranked
  WHERE h.id = ranked.id;

  -- Audit
  INSERT INTO reasoning_audit (session_id, tenant_id, event_type, actor_id, payload)
  VALUES (p_session_id, sess_tenant_id, 'differential_recomputed', NULL,
    jsonb_build_object('recomputed_at', now()::text));
END;
$$;


ALTER FUNCTION "public"."recompute_differential"("p_session_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."recompute_pharmacy_product_quantity"("p_tenant_id" "uuid", "p_product_id" "uuid") RETURNS integer
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_sum integer;
begin
  select coalesce(sum(quantity), 0) into v_sum
  from pharmacy_product_batches
  where tenant_id = p_tenant_id and product_id = p_product_id;

  update pharmacy_products
  set quantity = v_sum, updated_at = now()
  where id = p_product_id and tenant_id = p_tenant_id;

  return v_sum;
end;
$$;


ALTER FUNCTION "public"."recompute_pharmacy_product_quantity"("p_tenant_id" "uuid", "p_product_id" "uuid") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."report_unbatched_positive_stock"("p_tenant_id" "uuid") RETURNS TABLE("product_id" "uuid", "name" "text", "product_quantity" integer, "physical_quantity" bigint, "unbatched_quantity" bigint)
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
  select s.product_id, s.name, s.product_quantity, s.physical_quantity, s.unbatched_quantity
  from public.pharmacy_inventory_summary s
  where s.tenant_id = p_tenant_id
    and s.unbatched_quantity > 0
  order by s.unbatched_quantity desc;
$$;


ALTER FUNCTION "public"."report_unbatched_positive_stock"("p_tenant_id" "uuid") OWNER TO "postgres";


COMMENT ON FUNCTION "public"."report_unbatched_positive_stock"("p_tenant_id" "uuid") IS 'Legacy products with positive product.quantity not backed by batch rows. These are NOT sellable until received with genuine batch data.';



CREATE OR REPLACE FUNCTION "public"."resolve_tenant_from_host"("input_host" "text") RETURNS TABLE("hospital_id" "uuid", "tenant_key" "text", "domain" "text", "matched_subdomain" "text", "is_active" boolean)
    LANGUAGE "sql" STABLE
    AS $$
  with normalized as (
    select lower(split_part(trim(input_host), ':', 1)) as host
  )
  select
    td.hospital_id,
    td.tenant_key,
    td.domain,
    split_part(n.host, '.', 1) as matched_subdomain,
    td.is_active
  from normalized n
  join public.tenant_domains td on lower(td.domain) = n.host
  where td.is_active = true

  union all

  select
    h.id as hospital_id,
    lower(h.subdomain) as tenant_key,
    lower(h.subdomain || '.' || split_part(n.host, '.', 2) || '.' || split_part(n.host, '.', 3)) as domain,
    split_part(n.host, '.', 1) as matched_subdomain,
    true as is_active
  from normalized n
  join public.hospitals h on lower(h.subdomain) = split_part(n.host, '.', 1)
  where n.host like '%.%.%'

  limit 1;
$$;


ALTER FUNCTION "public"."resolve_tenant_from_host"("input_host" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."reverse_pharmacy_sale"("p_tenant_id" "uuid", "p_sale_id" "uuid", "p_actor_id" "uuid", "p_reason" "text", "p_restore_as" "text" DEFAULT 'quarantined'::"text") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_sale pharmacy_pos_sales%rowtype;
  v_item record;
  v_restore text := lower(coalesce(nullif(trim(p_restore_as), ''), 'quarantined'));
  v_refund_amount numeric := 0;
  v_paid numeric := 0;
  v_outstanding numeric := 0;
  v_batch pharmacy_product_batches%rowtype;
  v_prev int;
  v_new int;
  v_kla_today date := (timezone('Africa/Kampala', now()))::date;
  v_credit public.pharmacy_credit_ledger%rowtype;
  v_have_credit boolean := false;
  v_reversal numeric := 0;
  v_unreversed numeric := 0;
  v_unposted boolean := false;
  v_balance numeric := 0;
  v_balance_after numeric := null;
  v_payment_match text[];
begin
  perform public.pharmacy_assert_actor(p_tenant_id, p_actor_id);

  if p_reason is null or length(trim(p_reason)) = 0 then
    raise exception 'INVALID_QUANTITY: refund reason is required';
  end if;
  if v_restore not in ('active', 'quarantined') then
    raise exception 'INVALID_QUANTITY: restore_as must be active or quarantined';
  end if;

  -- The row lock serialises concurrent refunds of the same sale: the second
  -- caller blocks here, then sees status = 'voided' and gets ALREADY_REFUNDED.
  select * into v_sale from pharmacy_pos_sales
  where id = p_sale_id and tenant_id = p_tenant_id
  for update;
  if not found then
    raise exception 'SALE_NOT_FOUND: sale %', p_sale_id;
  end if;
  if v_sale.status = 'voided' then
    raise exception 'ALREADY_REFUNDED: sale % already voided', v_sale.receipt_number;
  end if;
  if v_sale.status is distinct from 'completed' then
    raise exception 'SALE_NOT_REFUNDABLE: status=%', v_sale.status;
  end if;

  -- What the customer actually paid. The tag and the fallbacks are exactly the
  -- ones post_pharmacy_pos_sale_to_ledger uses for the sale's cash leg, so the
  -- amount handed back here can never disagree with what the journal posted.
  v_payment_match := regexp_match(coalesce(v_sale.payment_ref, ''), 'PAID:([0-9]+([.][0-9]+)?)');
  if v_payment_match is not null then
    v_paid := coalesce(v_payment_match[1]::numeric, 0);
  elsif lower(coalesce(v_sale.payment_method, '')) = 'credit' then
    v_paid := 0;
  else
    v_paid := coalesce(v_sale.total_amount, 0);
  end if;
  v_paid := least(greatest(round(v_paid, 2), 0), greatest(coalesce(v_sale.total_amount, 0), 0));

  v_refund_amount := v_paid;
  v_outstanding := round(greatest(coalesce(v_sale.total_amount, 0) - v_paid, 0), 2);

  -- Match the sale and adjustment RPC lock order: product before batch. Rows
  -- are ordered by product, so multi-product refunds use the same lock order.
  for v_item in
    select * from pharmacy_pos_sale_items
    where sale_id = p_sale_id and tenant_id = p_tenant_id
    order by product_id, id
    for update
  loop
    -- The per-line flag is what makes stock restoration idempotent: a line is
    -- restored at most once, and lines that never decremented stock are left
    -- alone.
    if not coalesce(v_item.stock_decremented, false) then
      continue;
    end if;

    select quantity into v_prev from pharmacy_products
    where id = v_item.product_id and tenant_id = p_tenant_id for update;
    if not found then
      raise exception 'PRODUCT_NOT_FOUND: %', v_item.product_id;
    end if;
    v_prev := coalesce(v_prev, 0);

    if v_item.batch_id is not null then
      select * into v_batch from pharmacy_product_batches
      where id = v_item.batch_id
        and tenant_id = p_tenant_id
        and product_id = v_item.product_id
      for update;
      if not found then
        raise exception 'BATCH_NOT_FOUND: batch % for product % on sale % no longer exists',
          v_item.batch_id, v_item.product_id, v_sale.receipt_number;
      end if;
      if v_restore = 'active' and (
        not v_batch.is_active
        or coalesce(v_batch.status, 'active') not in ('active', 'exhausted')
        or (v_batch.expiry_date is not null and v_batch.expiry_date < v_kla_today)
      ) then
        raise exception 'BATCH_NOT_RESTORABLE: batch % is recalled, damaged, inactive, or expired; retry with quarantined stock',
          v_item.batch_id;
      end if;

      update pharmacy_product_batches
      set quantity = quantity + v_item.quantity,
          status = case
            when coalesce(v_batch.status, 'active') in ('recalled', 'damaged') then v_batch.status
            when v_restore = 'active' then 'active'
            else 'quarantined'
          end,
          is_active = v_batch.is_active,
          quarantine_reason = case
            when coalesce(v_batch.status, 'active') in ('recalled', 'damaged') then v_batch.quarantine_reason
            when v_restore = 'quarantined' then coalesce(p_reason, 'Returned from sale void')
            else quarantine_reason
          end,
          updated_at = now()
      where id = v_item.batch_id
        and tenant_id = p_tenant_id
        and product_id = v_item.product_id;
    end if;

    v_new := v_prev + v_item.quantity;
    update pharmacy_products
    set quantity = v_new, updated_at = now()
    where id = v_item.product_id and tenant_id = p_tenant_id;

    insert into pharmacy_stock_adjustments (
      tenant_id, product_id, batch_id, quantity, type, reason, previous_qty, new_qty, created_by
    ) values (
      p_tenant_id, v_item.product_id, v_item.batch_id, v_item.quantity, 'INCREASE',
      format('Refund %s (%s): %s', v_sale.receipt_number, v_restore, p_reason),
      v_prev, v_new, p_actor_id
    );

  end loop;

  -- The balance the POS settle step posted for this sale, if it posted one.
  -- complete-sale writes it under the sale's idempotency key, so the link is
  -- exact even though pharmacy_credit_ledger.transaction_id points at
  -- pharmacy_transactions and cannot store a POS sale id.
  select * into v_credit
  from public.pharmacy_credit_ledger
  where tenant_id = p_tenant_id
    and idempotency_key = 'pos-sale:' || p_sale_id::text
  for update;
  v_have_credit := found;

  if v_have_credit and v_credit.customer_id is not null then
    perform 1 from public.pharmacy_customers
    where id = v_credit.customer_id and tenant_id = p_tenant_id
    for update;

    if not found then
      -- The customer row is gone; the ledger's foreign key would reject the
      -- reversal. Fail closed on the receivable and report it instead.
      v_unposted := v_outstanding > 0;
    else
      select balance_after into v_balance
      from public.pharmacy_credit_ledger
      where tenant_id = p_tenant_id and customer_id = v_credit.customer_id
      order by created_at desc, id desc
      limit 1;
      v_balance := coalesce(v_balance, 0);

      -- Never reverse more than the sale's unpaid part, even if the ledger row
      -- disagrees with the sale: the refund must not create value that was
      -- never invoiced. Going below zero is intended and means the customer has
      -- a credit with the pharmacy (they had already repaid part of the sale).
      v_reversal := round(least(coalesce(v_credit.amount, 0), v_outstanding), 2);

      if v_reversal > 0 then
        v_balance_after := round(v_balance - v_reversal, 2);
        insert into public.pharmacy_credit_ledger (
          tenant_id, customer_id, transaction_id, amount, type, balance_after,
          due_date, notes, created_by, created_at, idempotency_key, payment_method
        ) values (
          p_tenant_id, v_credit.customer_id, null, v_reversal, 'refund', v_balance_after,
          null,
          format('Refund %s: %s', v_sale.receipt_number, p_reason),
          p_actor_id, clock_timestamp(),
          'pos-refund:' || p_sale_id::text,
          'credit'
        );
      end if;
    end if;
  elsif v_outstanding > 0 then
    -- The sale left a balance but nothing was ever posted to the credit ledger
    -- (complete-sale warns and continues when that posting fails). Refund only
    -- the money that was received and tell the operator what is still on the
    -- books, rather than paying out cash the customer never handed over.
    v_unposted := true;
  end if;

  v_unreversed := round(greatest(v_outstanding - v_reversal, 0), 2);

  update pharmacy_pos_sales
  set status = 'voided',
      voided_reason = p_reason,
      voided_by = p_actor_id,
      voided_at = now(),
      updated_at = now()
  where id = p_sale_id and tenant_id = p_tenant_id;

  insert into pharmacy_audit_logs (tenant_id, profile_id, action, entity, entity_id, details)
  values (
    p_tenant_id, p_actor_id, 'REFUND_POS_SALE', 'POS_SALE', p_sale_id,
    format('Voided %s: cash %s, receivable reversed %s%s, restore_as=%s reason=%s',
      v_sale.receipt_number,
      v_refund_amount,
      v_reversal,
      case when v_unposted then format(', receivable %s not on ledger', v_outstanding) else '' end,
      v_restore,
      p_reason)
  );

  return jsonb_build_object(
    'ok', true,
    'sale_id', p_sale_id,
    'receipt_number', v_sale.receipt_number,
    'refund_amount', v_refund_amount,
    'receivable_reversal', v_reversal,
    'receivable_outstanding', v_outstanding,
    'receivable_unreversed', v_unreversed,
    'receivable_unposted', v_unposted,
    'customer_id', case when v_have_credit then v_credit.customer_id else null end,
    'credit_balance_after', v_balance_after,
    'restore_as', v_restore,
    'status', 'voided'
  );
end;
$$;


ALTER FUNCTION "public"."reverse_pharmacy_sale"("p_tenant_id" "uuid", "p_sale_id" "uuid", "p_actor_id" "uuid", "p_reason" "text", "p_restore_as" "text") OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."same_tenant"("p_tenant_id" "uuid") RETURNS boolean
    LANGUAGE "sql" STABLE
    AS $$
  SELECT coalesce(
    (auth.jwt() ->> 'tenant_id')::uuid = p_tenant_id,
    false
  );
$$;


ALTER FUNCTION "public"."same_tenant"("p_tenant_id" "uuid") OWNER TO "postgres";


COMMENT ON FUNCTION "public"."same_tenant"("p_tenant_id" "uuid") IS 'Reads tenant_id from Supabase Auth JWT. Returns false for custom-auth (synapse_session) users, which is the safe default. All tenant isolation for custom-auth users is enforced server-side via supabaseAdmin (service role) + token payload validation in TypeScript.';



CREATE OR REPLACE FUNCTION "public"."set_bed_status_change_ts"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
BEGIN
  IF OLD.status IS DISTINCT FROM NEW.status THEN
    NEW.last_status_change = NOW();
  END IF;
  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."set_bed_status_change_ts"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."set_death_reg_updated_at"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$;


ALTER FUNCTION "public"."set_death_reg_updated_at"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."set_expert_rules_updated_at"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
begin
  new.updated_at = timezone('utc', now());
  return new;
end;
$$;


ALTER FUNCTION "public"."set_expert_rules_updated_at"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."set_generic_updated_at"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
begin
  new.updated_at = timezone('utc', now());
  return new;
end;
$$;


ALTER FUNCTION "public"."set_generic_updated_at"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."set_referral_updated_at"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$;


ALTER FUNCTION "public"."set_referral_updated_at"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."set_telemedicine_updated_at"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
begin
  new.updated_at = timezone('utc', now());
  return new;
end;
$$;


ALTER FUNCTION "public"."set_telemedicine_updated_at"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."set_tenant_domain_updated_at"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
begin
  new.updated_at = timezone('utc', now());
  return new;
end;
$$;


ALTER FUNCTION "public"."set_tenant_domain_updated_at"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."set_updated_at"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
begin
  new.updated_at = now();
  return new;
end;
$$;


ALTER FUNCTION "public"."set_updated_at"() OWNER TO "postgres";


CREATE OR REPLACE FUNCTION "public"."ship_pharmacy_stock_transfer"("p_tenant_id" "uuid", "p_transfer_id" "uuid", "p_actor_id" "uuid") RETURNS "jsonb"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO 'public'
    AS $$
declare
  v_transfer pharmacy_stock_transfers%rowtype;
  v_main_store_id uuid;
  v_item record;
  v_batch pharmacy_product_batches%rowtype;
  v_product_name text;
  v_needed int;
  v_take int;
  v_kla_today date := (timezone('Africa/Kampala', now()))::date;
  v_items_shipped int := 0;
  v_units_shipped int := 0;
begin
  select * into v_transfer from pharmacy_stock_transfers
  where id = p_transfer_id and tenant_id = p_tenant_id
  for update;
  if not found then
    raise exception 'TRANSFER_NOT_FOUND: %', p_transfer_id;
  end if;
  if v_transfer.status is distinct from 'draft' then
    raise exception 'INVALID_TRANSFER_STATE: expected draft, got %', v_transfer.status;
  end if;

  select id into v_main_store_id from pharmacy_stores
  where tenant_id = p_tenant_id and store_type = 'main'
  limit 1;

  if not exists (select 1 from pharmacy_stock_transfer_items where transfer_id = p_transfer_id) then
    raise exception 'TRANSFER_EMPTY: transfer % has no items', p_transfer_id;
  end if;

  for v_item in
    select * from pharmacy_stock_transfer_items
    where transfer_id = p_transfer_id
    order by created_at asc
  loop
    v_needed := v_item.quantity;
    if v_needed is null or v_needed <= 0 then
      raise exception 'INVALID_QUANTITY: transfer item % has no quantity', v_item.id;
    end if;

    select name into v_product_name from pharmacy_products
    where id = v_item.product_id and tenant_id = p_tenant_id;
    if v_product_name is null then
      raise exception 'PRODUCT_NOT_FOUND: %', v_item.product_id;
    end if;

    if v_item.from_batch_id is not null then
      select * into v_batch from pharmacy_product_batches
      where id = v_item.from_batch_id
        and tenant_id = p_tenant_id
        and product_id = v_item.product_id
        and (store_id = v_transfer.from_store_id or (store_id is null and v_transfer.from_store_id = v_main_store_id))
      for update;
      if not found then
        raise exception 'BATCH_NOT_FOUND: %', v_item.from_batch_id;
      end if;
      if coalesce(v_batch.status, 'active') <> 'active' then
        raise exception 'INSUFFICIENT_BATCH: batch % is not active (status %)', v_batch.batch_number, v_batch.status;
      end if;
      if v_batch.quantity < v_needed then
        raise exception 'INSUFFICIENT_BATCH: % only has % units, % requested', v_batch.batch_number, v_batch.quantity, v_needed;
      end if;

      update pharmacy_product_batches
      set quantity = quantity - v_needed,
          status = case when quantity - v_needed <= 0 then 'exhausted' else status end,
          updated_at = now()
      where id = v_batch.id;

      insert into pharmacy_stock_transfer_item_allocations
        (transfer_item_id, from_batch_id, batch_number, expiry_date, cost_price, quantity)
      values
        (v_item.id, v_batch.id, v_batch.batch_number, v_batch.expiry_date, v_batch.cost_price, v_needed);

      v_units_shipped := v_units_shipped + v_needed;
    else
      for v_batch in
        select * from pharmacy_product_batches
        where product_id = v_item.product_id
          and tenant_id = p_tenant_id
          and coalesce(is_active, true)
          and coalesce(status, 'active') = 'active'
          and quantity > 0
          and (expiry_date is null or expiry_date >= v_kla_today)
          and (store_id = v_transfer.from_store_id or (store_id is null and v_transfer.from_store_id = v_main_store_id))
        order by expiry_date asc nulls last, received_date asc
        for update
      loop
        exit when v_needed <= 0;
        v_take := least(v_batch.quantity, v_needed);

        update pharmacy_product_batches
        set quantity = quantity - v_take,
            status = case when quantity - v_take <= 0 then 'exhausted' else status end,
            updated_at = now()
        where id = v_batch.id;

        insert into pharmacy_stock_transfer_item_allocations
          (transfer_item_id, from_batch_id, batch_number, expiry_date, cost_price, quantity)
        values
          (v_item.id, v_batch.id, v_batch.batch_number, v_batch.expiry_date, v_batch.cost_price, v_take);

        v_needed := v_needed - v_take;
        v_units_shipped := v_units_shipped + v_take;
      end loop;

      if v_needed > 0 then
        raise exception 'INSUFFICIENT_STOCK: % short by % units at source store', v_product_name, v_needed;
      end if;
    end if;

    v_items_shipped := v_items_shipped + 1;
  end loop;

  update pharmacy_stock_transfers
  set status = 'in_transit',
      shipped_by = p_actor_id,
      shipped_at = now(),
      updated_at = now()
  where id = p_transfer_id;

  begin
    insert into pharmacy_audit_logs (tenant_id, profile_id, action, entity, entity_id, details)
    values (
      p_tenant_id, p_actor_id, 'stock_transfer.shipped', 'pharmacy_stock_transfers', p_transfer_id,
      jsonb_build_object(
        'from_store_id', v_transfer.from_store_id,
        'to_store_id', v_transfer.to_store_id,
        'items', v_items_shipped,
        'units', v_units_shipped
      )::text
    );
  exception when undefined_table then null;
  end;

  return jsonb_build_object(
    'ok', true,
    'transfer_id', p_transfer_id,
    'status', 'in_transit',
    'items_shipped', v_items_shipped,
    'units_shipped', v_units_shipped
  );
end;
$$;


ALTER FUNCTION "public"."ship_pharmacy_stock_transfer"("p_tenant_id" "uuid", "p_transfer_id" "uuid", "p_actor_id" "uuid") OWNER TO "postgres";


COMMENT ON FUNCTION "public"."ship_pharmacy_stock_transfer"("p_tenant_id" "uuid", "p_transfer_id" "uuid", "p_actor_id" "uuid") IS 'Ships a draft stock transfer: FEFO-deducts sellable batches at from_store_id (never product.quantity) and records the exact source batches in pharmacy_stock_transfer_item_allocations for receiving.';



CREATE OR REPLACE FUNCTION "public"."synapse_remote_migration_head"() RETURNS TABLE("version" "text", "name" "text")
    LANGUAGE "sql" STABLE SECURITY DEFINER
    SET "search_path" TO 'supabase_migrations', 'public'
    AS $$
  select sm.version::text, sm.name
  from supabase_migrations.schema_migrations as sm
  order by sm.version desc
  limit 1;
$$;


ALTER FUNCTION "public"."synapse_remote_migration_head"() OWNER TO "postgres";


COMMENT ON FUNCTION "public"."synapse_remote_migration_head"() IS 'Control-plane only: latest applied supabase_migrations.schema_migrations row.';



CREATE OR REPLACE FUNCTION "public"."update_updated_at_column"() RETURNS "trigger"
    LANGUAGE "plpgsql"
    AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;


ALTER FUNCTION "public"."update_updated_at_column"() OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."aefi_reports" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "patient_id" "uuid" NOT NULL,
    "hospital_id" "uuid",
    "chw_id" "uuid",
    "vaccine_name" "text" NOT NULL,
    "vaccine_batch" "text",
    "vaccination_date" "date" NOT NULL,
    "onset_date" "date" NOT NULL,
    "event_type" "text" NOT NULL,
    "severity" "text" NOT NULL,
    "description" "text" NOT NULL,
    "outcome" "text",
    "reported_by" "uuid",
    "submitted_to_moh" boolean DEFAULT false NOT NULL,
    "moh_reference" "text",
    "created_at" timestamp with time zone DEFAULT "timezone"('utc'::"text", "now"()) NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "timezone"('utc'::"text", "now"()) NOT NULL,
    "tenant_id" "uuid",
    "created_by" "uuid",
    "is_deleted" boolean DEFAULT false,
    CONSTRAINT "aefi_reports_event_type_check" CHECK (("event_type" = ANY (ARRAY['local_reaction'::"text", 'fever'::"text", 'convulsion'::"text", 'anaphylaxis'::"text", 'death'::"text", 'hospitalisation'::"text", 'other'::"text"]))),
    CONSTRAINT "aefi_reports_outcome_check" CHECK (("outcome" = ANY (ARRAY['recovered'::"text", 'recovering'::"text", 'not_recovered'::"text", 'sequelae'::"text", 'fatal'::"text", 'unknown'::"text"]))),
    CONSTRAINT "aefi_reports_severity_check" CHECK (("severity" = ANY (ARRAY['mild'::"text", 'moderate'::"text", 'severe'::"text", 'fatal'::"text"])))
);


ALTER TABLE "public"."aefi_reports" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."ai_health_chats" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "session_id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "role" "text" NOT NULL,
    "content" "text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"(),
    CONSTRAINT "ai_health_chats_role_check" CHECK (("role" = ANY (ARRAY['user'::"text", 'assistant'::"text"])))
);


ALTER TABLE "public"."ai_health_chats" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."allergens_catalog" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "name" "text" NOT NULL,
    "category" "text" NOT NULL,
    "reactions" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "severity" "text" NOT NULL,
    "alternative_drugs" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "timezone"('utc'::"text", "now"()) NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "timezone"('utc'::"text", "now"()) NOT NULL,
    "tenant_id" "uuid",
    "created_by" "uuid",
    "is_deleted" boolean DEFAULT false,
    CONSTRAINT "allergens_catalog_category_check" CHECK (("category" = ANY (ARRAY['DRUG'::"text", 'FOOD'::"text", 'ENVIRONMENTAL'::"text", 'LATEX'::"text"]))),
    CONSTRAINT "allergens_catalog_severity_check" CHECK (("severity" = ANY (ARRAY['MILD'::"text", 'MODERATE'::"text", 'SEVERE'::"text", 'FATAL'::"text"])))
);


ALTER TABLE "public"."allergens_catalog" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."apk_waitlist" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "email" "text" NOT NULL,
    "notified" boolean DEFAULT false,
    "created_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."apk_waitlist" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."app_vitals" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "patient_id" "uuid",
    "heart_rate" integer,
    "spo2" numeric(5,1),
    "steps_today" integer,
    "blood_pressure_systolic" integer,
    "blood_pressure_diastolic" integer,
    "temperature" numeric(4,1),
    "weight" numeric(5,1),
    "source" "text" DEFAULT 'manual_entry'::"text",
    "recorded_at" timestamp with time zone DEFAULT "now"(),
    "tenant_id" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."app_vitals" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."audit_events" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "tenant_id" "uuid" NOT NULL,
    "user_id" "uuid",
    "action" "text" NOT NULL,
    "resource_type" "text" NOT NULL,
    "resource_id" "text",
    "previous_value" "jsonb",
    "new_value" "jsonb",
    "ip_address" "text",
    "user_agent" "text",
    "occurred_at" timestamp with time zone DEFAULT "now"(),
    "created_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."audit_events" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."audit_log" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "table_name" "text",
    "action" "text",
    "record_id" "text",
    "user_id" "uuid",
    "user_role" "text",
    "old_value" "jsonb",
    "new_value" "jsonb",
    "created_at" timestamp with time zone DEFAULT "timezone"('utc'::"text", "now"()) NOT NULL,
    "tenant_id" "uuid",
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "created_by" "uuid",
    "is_deleted" boolean DEFAULT false
);


ALTER TABLE "public"."audit_log" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."auth_otps" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "channel" "text" NOT NULL,
    "target" "text" NOT NULL,
    "otp_hash" "text" NOT NULL,
    "expires_at" timestamp with time zone DEFAULT ("now"() + '00:10:00'::interval) NOT NULL,
    "used" boolean DEFAULT false NOT NULL,
    "attempts" integer DEFAULT 0 NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "auth_otps_channel_check" CHECK (("channel" = ANY (ARRAY['phone'::"text", 'email'::"text"])))
);


ALTER TABLE "public"."auth_otps" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."bed_assignments" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "bed_id" "uuid" NOT NULL,
    "patient_id" "uuid",
    "encounter_id" "uuid",
    "admitted_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "discharged_at" timestamp with time zone,
    "admission_reason" "text",
    "assigned_by" "uuid",
    "discharged_by" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "tenant_id" "uuid",
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "created_by" "uuid",
    "is_deleted" boolean DEFAULT false
);


ALTER TABLE "public"."bed_assignments" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."beta_access_requests" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "email" "text" NOT NULL,
    "full_name" "text",
    "organization" "text",
    "role" "text",
    "region" "text",
    "district" "text",
    "phone" "text",
    "notes" "text",
    "source" "text",
    "status" "text" DEFAULT 'new'::"text" NOT NULL,
    "admin_reply" "text",
    "reviewed_by" "uuid",
    "reviewed_at" timestamp with time zone,
    "replied_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "timezone"('utc'::"text", "now"()) NOT NULL,
    "tenant_id" "uuid",
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "created_by" "uuid",
    "is_deleted" boolean DEFAULT false,
    CONSTRAINT "beta_access_requests_status_check" CHECK (("status" = ANY (ARRAY['new'::"text", 'reviewing'::"text", 'approved'::"text", 'waitlisted'::"text", 'declined'::"text"])))
);


ALTER TABLE "public"."beta_access_requests" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."billing_invoices" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "patient_id" "uuid",
    "encounter_id" "uuid",
    "invoice_number" "text",
    "status" "text" DEFAULT 'draft'::"text" NOT NULL,
    "total_amount" numeric DEFAULT 0 NOT NULL,
    "paid_amount" numeric DEFAULT 0 NOT NULL,
    "currency" "text" DEFAULT 'UGX'::"text" NOT NULL,
    "notes" "text",
    "created_at" timestamp with time zone DEFAULT "timezone"('utc'::"text", "now"()) NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "timezone"('utc'::"text", "now"()) NOT NULL,
    "tenant_id" "uuid",
    "created_by" "uuid",
    "is_deleted" boolean DEFAULT false,
    CONSTRAINT "billing_invoices_status_check" CHECK (("status" = ANY (ARRAY['draft'::"text", 'issued'::"text", 'partially_paid'::"text", 'paid'::"text", 'void'::"text"])))
);


ALTER TABLE "public"."billing_invoices" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."billing_line_items" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "invoice_id" "uuid" NOT NULL,
    "item_name" "text" NOT NULL,
    "qty" numeric DEFAULT 1 NOT NULL,
    "unit_price" numeric DEFAULT 0 NOT NULL,
    "total_price" numeric GENERATED ALWAYS AS (("qty" * "unit_price")) STORED,
    "notes" "text",
    "created_at" timestamp with time zone DEFAULT "timezone"('utc'::"text", "now"()) NOT NULL,
    "tenant_id" "uuid",
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "created_by" "uuid",
    "is_deleted" boolean DEFAULT false
);


ALTER TABLE "public"."billing_line_items" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."billing_payments" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "tenant_id" "uuid" NOT NULL,
    "invoice_id" "uuid" NOT NULL,
    "encounter_id" "uuid",
    "patient_id" "uuid",
    "amount" numeric(12,2) NOT NULL,
    "currency" "text" DEFAULT 'UGX'::"text" NOT NULL,
    "payment_method" "text" NOT NULL,
    "payment_ref" "text",
    "receipt_number" "text",
    "idempotency_key" "text",
    "received_by" "uuid",
    "notes" "text",
    "is_deleted" boolean DEFAULT false NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "billing_payments_amount_check" CHECK (("amount" > (0)::numeric))
);


ALTER TABLE "public"."billing_payments" OWNER TO "postgres";


COMMENT ON TABLE "public"."billing_payments" IS 'Hospital encounter payments against billing_invoices. Idempotent via (tenant_id, idempotency_key).';



CREATE TABLE IF NOT EXISTS "public"."blood_deferrals" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "person_id" "uuid" NOT NULL,
    "reason" "text" NOT NULL,
    "starts_on" "date" DEFAULT CURRENT_DATE NOT NULL,
    "ends_on" "date",
    "is_permanent" boolean DEFAULT false NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."blood_deferrals" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."blood_donation_profiles" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "person_id" "uuid" NOT NULL,
    "donor_number" "text",
    "blood_group_fact_id" "uuid",
    "contact_consent" boolean DEFAULT false NOT NULL,
    "next_eligible_on" "date",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."blood_donation_profiles" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."blood_donations" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "person_id" "uuid" NOT NULL,
    "facility_id" "uuid",
    "donated_on" "date" NOT NULL,
    "donation_type" "text" DEFAULT 'whole_blood'::"text" NOT NULL,
    "units" numeric(6,2) DEFAULT 1 NOT NULL,
    "screening_status" "text" DEFAULT 'pending'::"text" NOT NULL,
    "adverse_reaction" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "blood_donations_donation_type_check" CHECK (("donation_type" = ANY (ARRAY['whole_blood'::"text", 'plasma'::"text", 'platelets'::"text", 'autologous'::"text", 'other'::"text"]))),
    CONSTRAINT "blood_donations_screening_status_check" CHECK (("screening_status" = ANY (ARRAY['pending'::"text", 'cleared'::"text", 'deferred'::"text", 'reactive'::"text", 'unknown'::"text"])))
);


ALTER TABLE "public"."blood_donations" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."body_register" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "tenant_id" "uuid" NOT NULL,
    "body_ref" "text",
    "body_name" "text",
    "admission_date" timestamp with time zone DEFAULT "now"(),
    "referred_from" "text",
    "condition_on_arrival" "text",
    "storage_bay" "text",
    "cause_of_death" "text",
    "is_forensic" boolean DEFAULT false,
    "post_mortem_done" boolean DEFAULT false,
    "post_mortem_notes" "text",
    "released" boolean DEFAULT false,
    "released_to" "text",
    "released_relationship" "text",
    "released_date" "date",
    "id_document_verified" boolean DEFAULT false,
    "police_notified" boolean DEFAULT false,
    "notes" "text",
    "created_by" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."body_register" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."calls" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "room_name" "text" NOT NULL,
    "caller_id" "uuid",
    "callee_id" "uuid",
    "caller_synapse_id" "text",
    "callee_synapse_id" "text",
    "status" "text" DEFAULT 'ringing'::"text",
    "started_at" timestamp with time zone,
    "ended_at" timestamp with time zone,
    "duration_seconds" integer,
    "call_type" "text" DEFAULT 'video'::"text",
    "created_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."calls" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."capabilities" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "module" "text" NOT NULL,
    "resource" "text" NOT NULL,
    "action" "text" NOT NULL,
    "description" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."capabilities" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."care_team_handovers" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "hospital_id" "uuid" NOT NULL,
    "department_id" "uuid",
    "shift_type" "text" NOT NULL,
    "shift_start" timestamp with time zone NOT NULL,
    "shift_end" timestamp with time zone,
    "handed_off_by" "uuid",
    "outgoing_team" "uuid"[] DEFAULT '{}'::"uuid"[] NOT NULL,
    "received_by" "uuid",
    "incoming_team" "uuid"[] DEFAULT '{}'::"uuid"[] NOT NULL,
    "status" "text" DEFAULT 'in_progress'::"text" NOT NULL,
    "summary_text" "text",
    "submitted_at" timestamp with time zone,
    "acknowledged_at" timestamp with time zone,
    "patient_count" integer DEFAULT 0 NOT NULL,
    "critical_count" integer DEFAULT 0 NOT NULL,
    "pending_task_count" integer DEFAULT 0 NOT NULL,
    "metadata" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "timezone"('utc'::"text", "now"()) NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "timezone"('utc'::"text", "now"()) NOT NULL,
    "tenant_id" "uuid",
    "created_by" "uuid",
    "is_deleted" boolean DEFAULT false,
    CONSTRAINT "care_team_handovers_shift_type_check" CHECK (("shift_type" = ANY (ARRAY['day'::"text", 'evening'::"text", 'night'::"text", 'custom'::"text"]))),
    CONSTRAINT "care_team_handovers_status_check" CHECK (("status" = ANY (ARRAY['in_progress'::"text", 'submitted'::"text", 'acknowledged'::"text", 'archived'::"text"])))
);


ALTER TABLE "public"."care_team_handovers" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."cds_alerts" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "encounter_id" "uuid",
    "patient_id" "uuid",
    "trigger_source" "text",
    "trigger_type" "text",
    "severity" "text",
    "category" "text",
    "title" "text",
    "message" "text",
    "recommendation" "text",
    "status" "text" DEFAULT 'active'::"text" NOT NULL,
    "payload" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "timezone"('utc'::"text", "now"()) NOT NULL,
    "tenant_id" "uuid",
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "created_by" "uuid",
    "is_deleted" boolean DEFAULT false,
    CONSTRAINT "cds_alerts_status_check" CHECK (("status" = ANY (ARRAY['active'::"text", 'acknowledged'::"text", 'dismissed'::"text", 'resolved'::"text"])))
);


ALTER TABLE "public"."cds_alerts" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."cds_rules" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "icd_code" "text" NOT NULL,
    "differential_diagnoses" "jsonb",
    "essential_features" "jsonb",
    "suggested_labs" "jsonb",
    "suggested_drugs" "jsonb",
    "safety_alerts" "jsonb",
    "created_at" timestamp with time zone DEFAULT "timezone"('utc'::"text", "now"()) NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "timezone"('utc'::"text", "now"()) NOT NULL,
    "tenant_id" "uuid",
    "created_by" "uuid",
    "is_deleted" boolean DEFAULT false
);


ALTER TABLE "public"."cds_rules" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."chw_visits" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "campaign_id" "uuid",
    "chw_id" "uuid" NOT NULL,
    "patient_id" "uuid",
    "hospital_id" "uuid",
    "visit_date" "date" NOT NULL,
    "visit_type" "text" NOT NULL,
    "outcome" "text" DEFAULT 'completed'::"text" NOT NULL,
    "gps_lat" numeric(10,7),
    "gps_lng" numeric(10,7),
    "village" "text",
    "vitals" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "muac_cm" numeric(4,1),
    "findings" "text",
    "actions_taken" "text",
    "referral_needed" boolean DEFAULT false NOT NULL,
    "referral_reason" "text",
    "referred_to" "text",
    "follow_up_date" "date",
    "photos" "text"[] DEFAULT '{}'::"text"[] NOT NULL,
    "metadata" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "timezone"('utc'::"text", "now"()) NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "timezone"('utc'::"text", "now"()) NOT NULL,
    "tenant_id" "uuid",
    "created_by" "uuid",
    "is_deleted" boolean DEFAULT false,
    CONSTRAINT "chw_visits_outcome_check" CHECK (("outcome" = ANY (ARRAY['completed'::"text", 'no_show'::"text", 'refused'::"text", 'referred'::"text", 'deceased'::"text"]))),
    CONSTRAINT "chw_visits_visit_type_check" CHECK (("visit_type" = ANY (ARRAY['follow_up'::"text", 'anc'::"text", 'immunization'::"text", 'growth_monitoring'::"text", 'screening'::"text", 'referral_follow_up'::"text", 'other'::"text"])))
);


ALTER TABLE "public"."chw_visits" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."claim_line_items" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "claim_id" "uuid" NOT NULL,
    "service_date" "date" NOT NULL,
    "procedure_code" "text" NOT NULL,
    "procedure_name" "text",
    "quantity" integer DEFAULT 1 NOT NULL,
    "unit_price" numeric(10,2) NOT NULL,
    "total_price" numeric(10,2) NOT NULL,
    "allowed_amount" numeric(10,2),
    "paid_amount" numeric(10,2),
    "ndc_code" "text",
    "modifier_codes" "text"[] DEFAULT '{}'::"text"[] NOT NULL,
    "status" "text" DEFAULT 'included'::"text" NOT NULL,
    "denial_reason" "text",
    "revenue_code" "text",
    "created_at" timestamp with time zone DEFAULT "timezone"('utc'::"text", "now"()) NOT NULL,
    "tenant_id" "uuid",
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "created_by" "uuid",
    "is_deleted" boolean DEFAULT false,
    CONSTRAINT "claim_line_items_status_check" CHECK (("status" = ANY (ARRAY['included'::"text", 'denied'::"text", 'adjusted'::"text", 'bundled'::"text"])))
);


ALTER TABLE "public"."claim_line_items" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."claim_resubmissions" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "claim_id" "uuid" NOT NULL,
    "resubmission_type" "text" DEFAULT 'corrected'::"text" NOT NULL,
    "resubmitted_at" timestamp with time zone DEFAULT "timezone"('utc'::"text", "now"()) NOT NULL,
    "resubmitted_by" "uuid",
    "reason" "text" NOT NULL,
    "supporting_docs" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "new_claim_id" "uuid",
    "outcome" "text",
    "outcome_at" timestamp with time zone,
    "notes" "text",
    "created_at" timestamp with time zone DEFAULT "timezone"('utc'::"text", "now"()) NOT NULL,
    "tenant_id" "uuid",
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "created_by" "uuid",
    "is_deleted" boolean DEFAULT false,
    CONSTRAINT "claim_resubmissions_outcome_check" CHECK (("outcome" = ANY (ARRAY['approved'::"text", 'denied'::"text", 'pending'::"text", NULL::"text"]))),
    CONSTRAINT "claim_resubmissions_resubmission_type_check" CHECK (("resubmission_type" = ANY (ARRAY['corrected'::"text", 'void'::"text", 'appeal'::"text", 'second_level_appeal'::"text"])))
);


ALTER TABLE "public"."claim_resubmissions" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."clinical_intelligence_decisions" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "session_id" "uuid" NOT NULL,
    "tenant_id" "uuid" NOT NULL,
    "encounter_id" "uuid" NOT NULL,
    "actor_id" "uuid" NOT NULL,
    "recommendation_index" integer DEFAULT 0 NOT NULL,
    "decision" "text" NOT NULL,
    "reason" "text",
    "modified_display" "text",
    "created_at" timestamp with time zone DEFAULT "timezone"('utc'::"text", "now"()) NOT NULL,
    CONSTRAINT "clinical_intelligence_decisions_decision_check" CHECK (("decision" = ANY (ARRAY['ACCEPT'::"text", 'MODIFY'::"text", 'REJECT'::"text", 'DEFER'::"text"])))
);


ALTER TABLE "public"."clinical_intelligence_decisions" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."clinical_intelligence_sessions" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "tenant_id" "uuid" NOT NULL,
    "facility_id" "uuid" NOT NULL,
    "patient_id" "uuid",
    "encounter_id" "uuid" NOT NULL,
    "actor_id" "uuid",
    "model" "text" NOT NULL,
    "model_version" "text" NOT NULL,
    "prompt_version" "text" NOT NULL,
    "context_snapshot" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "response" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "missing_information" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "red_flags" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "suggested_pathway_slug" "text",
    "correlation_id" "text",
    "created_at" timestamp with time zone DEFAULT "timezone"('utc'::"text", "now"()) NOT NULL
);


ALTER TABLE "public"."clinical_intelligence_sessions" OWNER TO "postgres";


COMMENT ON TABLE "public"."clinical_intelligence_sessions" IS 'Advisory intelligence snapshots. Never used as confirmed diagnoses.';



CREATE TABLE IF NOT EXISTS "public"."clinical_note_embeddings" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "tenant_id" "uuid" NOT NULL,
    "patient_id" "uuid" NOT NULL,
    "encounter_id" "uuid",
    "note_type" "text",
    "source_table" "text",
    "source_id" "uuid",
    "content_text" "text" NOT NULL,
    "content_tsvector" "tsvector" GENERATED ALWAYS AS ("to_tsvector"('"english"'::"regconfig", "content_text")) STORED,
    "embedding" "public"."vector"(1536),
    "recorded_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."clinical_note_embeddings" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."clinical_notes" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "tenant_id" "uuid" NOT NULL,
    "encounter_id" "uuid" NOT NULL,
    "patient_id" "uuid" NOT NULL,
    "note_type" "text" NOT NULL,
    "content" "text" NOT NULL,
    "authored_by" "uuid" NOT NULL,
    "is_signed" boolean DEFAULT false NOT NULL,
    "signed_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "version" integer DEFAULT 1 NOT NULL,
    CONSTRAINT "clinical_notes_note_type_check" CHECK (("note_type" = ANY (ARRAY['soap'::"text", 'progress'::"text", 'discharge'::"text", 'consult'::"text", 'procedure'::"text", 'nursing'::"text", 'pharmacy'::"text", 'imaging'::"text"])))
);


ALTER TABLE "public"."clinical_notes" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."clinical_pathway_templates" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "hospital_id" "uuid",
    "name" "text" NOT NULL,
    "slug" "text" NOT NULL,
    "category" "text" NOT NULL,
    "icd11_codes" "text"[] DEFAULT '{}'::"text"[] NOT NULL,
    "description" "text",
    "is_active" boolean DEFAULT true NOT NULL,
    "is_system" boolean DEFAULT false NOT NULL,
    "version" integer DEFAULT 1 NOT NULL,
    "steps" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "triggers" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "checklist" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "auto_orders" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "alert_rules" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "created_by" "uuid",
    "created_at" timestamp with time zone DEFAULT "timezone"('utc'::"text", "now"()) NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "timezone"('utc'::"text", "now"()) NOT NULL,
    "tenant_id" "uuid",
    "is_deleted" boolean DEFAULT false,
    CONSTRAINT "clinical_pathway_templates_category_check" CHECK (("category" = ANY (ARRAY['emergency'::"text", 'sepsis'::"text", 'maternity'::"text", 'pediatrics'::"text", 'chronic'::"text", 'surgical'::"text", 'infectious'::"text", 'cardiac'::"text", 'respiratory'::"text", 'other'::"text"])))
);


ALTER TABLE "public"."clinical_pathway_templates" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."clinical_prescriptions" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "tenant_id" "uuid" NOT NULL,
    "pharmacy_tenant_id" "uuid",
    "patient_id" "uuid",
    "person_id" "uuid",
    "encounter_id" "uuid",
    "care_plan_id" "uuid",
    "medication_display" "text" NOT NULL,
    "dose" "text",
    "quantity" numeric DEFAULT 1 NOT NULL,
    "unit" "text" DEFAULT 'unit'::"text" NOT NULL,
    "prescriber_id" "uuid",
    "verifier_id" "uuid",
    "dispenser_id" "uuid",
    "status" "text" DEFAULT 'active'::"text" NOT NULL,
    "hospital_drug_order_id" "uuid",
    "pharmacy_order_id" "uuid",
    "correlation_id" "uuid",
    "is_synthetic" boolean DEFAULT false NOT NULL,
    "simulation_run_id" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "clinical_prescriptions_status_check" CHECK (("status" = ANY (ARRAY['active'::"text", 'verified'::"text", 'dispensed'::"text", 'cancelled'::"text", 'returned'::"text"])))
);


ALTER TABLE "public"."clinical_prescriptions" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."community_health_workers" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "hospital_id" "uuid" NOT NULL,
    "profile_id" "uuid",
    "chw_code" "text" NOT NULL,
    "full_name" "text" NOT NULL,
    "phone" "text" NOT NULL,
    "village" "text",
    "sub_county" "text",
    "district" "text",
    "region" "text",
    "coverage_area" "text",
    "is_active" boolean DEFAULT true NOT NULL,
    "training_level" "text" DEFAULT 'basic'::"text" NOT NULL,
    "languages" "text"[] DEFAULT '{}'::"text"[] NOT NULL,
    "joined_at" "date",
    "metadata" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "timezone"('utc'::"text", "now"()) NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "timezone"('utc'::"text", "now"()) NOT NULL,
    "tenant_id" "uuid",
    "created_by" "uuid",
    "is_deleted" boolean DEFAULT false,
    CONSTRAINT "community_health_workers_training_level_check" CHECK (("training_level" = ANY (ARRAY['basic'::"text", 'intermediate'::"text", 'advanced'::"text", 'supervisor'::"text"])))
);


ALTER TABLE "public"."community_health_workers" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."consent_audit_log" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "patient_id" "uuid" NOT NULL,
    "consent_id" "uuid",
    "grant_id" "uuid",
    "action" "text" NOT NULL,
    "actor_id" "uuid",
    "actor_role" "text",
    "module_name" "text",
    "detail" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "ip_address" "inet",
    "created_at" timestamp with time zone DEFAULT "timezone"('utc'::"text", "now"()) NOT NULL,
    "tenant_id" "uuid",
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "created_by" "uuid",
    "is_deleted" boolean DEFAULT false,
    CONSTRAINT "consent_audit_log_action_check" CHECK (("action" = ANY (ARRAY['consent_granted'::"text", 'consent_withdrawn'::"text", 'consent_expired'::"text", 'access_granted'::"text", 'access_revoked'::"text", 'access_denied'::"text", 'record_accessed'::"text", 'record_exported'::"text"])))
);


ALTER TABLE "public"."consent_audit_log" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."cross_tenant_access" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "granting_tenant_id" "uuid" NOT NULL,
    "accessing_tenant_id" "uuid" NOT NULL,
    "patient_id" "uuid" NOT NULL,
    "referral_id" "uuid",
    "access_type" "text" NOT NULL,
    "granted_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "expires_at" timestamp with time zone NOT NULL,
    "revoked_at" timestamp with time zone,
    "is_active" boolean DEFAULT true NOT NULL,
    CONSTRAINT "cross_tenant_access_access_type_check" CHECK (("access_type" = ANY (ARRAY['read'::"text", 'referral'::"text", 'consult'::"text"])))
);


ALTER TABLE "public"."cross_tenant_access" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."data_breach_incidents" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "hospital_id" "uuid",
    "title" "text" NOT NULL,
    "severity" "text" NOT NULL,
    "incident_date" timestamp with time zone NOT NULL,
    "discovered_at" timestamp with time zone DEFAULT "timezone"('utc'::"text", "now"()) NOT NULL,
    "description" "text" NOT NULL,
    "affected_records" integer DEFAULT 0 NOT NULL,
    "data_types" "text"[] DEFAULT '{}'::"text"[] NOT NULL,
    "root_cause" "text",
    "containment_actions" "text",
    "notification_required" boolean DEFAULT false NOT NULL,
    "notified_regulator" boolean DEFAULT false NOT NULL,
    "notified_at" timestamp with time zone,
    "status" "text" DEFAULT 'open'::"text" NOT NULL,
    "reported_by" "uuid",
    "resolved_by" "uuid",
    "resolved_at" timestamp with time zone,
    "dpo_review" "text",
    "created_at" timestamp with time zone DEFAULT "timezone"('utc'::"text", "now"()) NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "timezone"('utc'::"text", "now"()) NOT NULL,
    "tenant_id" "uuid",
    "created_by" "uuid",
    "is_deleted" boolean DEFAULT false,
    CONSTRAINT "data_breach_incidents_severity_check" CHECK (("severity" = ANY (ARRAY['low'::"text", 'medium'::"text", 'high'::"text", 'critical'::"text"]))),
    CONSTRAINT "data_breach_incidents_status_check" CHECK (("status" = ANY (ARRAY['open'::"text", 'investigating'::"text", 'contained'::"text", 'closed'::"text", 'reported'::"text"])))
);


ALTER TABLE "public"."data_breach_incidents" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."data_export_jobs" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "hospital_id" "uuid",
    "requested_by" "uuid" NOT NULL,
    "export_type" "text" NOT NULL,
    "scope" "text" DEFAULT 'hospital'::"text" NOT NULL,
    "filters" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "is_deidentified" boolean DEFAULT true NOT NULL,
    "deidentify_config" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "format" "text" DEFAULT 'csv'::"text" NOT NULL,
    "status" "text" DEFAULT 'queued'::"text" NOT NULL,
    "row_count" bigint,
    "file_size_bytes" bigint,
    "storage_path" "text",
    "download_url" "text",
    "download_expires_at" timestamp with time zone,
    "error_message" "text",
    "started_at" timestamp with time zone,
    "completed_at" timestamp with time zone,
    "expires_at" timestamp with time zone,
    "approved_by" "uuid",
    "approved_at" timestamp with time zone,
    "metadata" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "timezone"('utc'::"text", "now"()) NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "timezone"('utc'::"text", "now"()) NOT NULL,
    "tenant_id" "uuid",
    "created_by" "uuid",
    "is_deleted" boolean DEFAULT false,
    CONSTRAINT "data_export_jobs_export_type_check" CHECK (("export_type" = ANY (ARRAY['patient_records'::"text", 'encounters'::"text", 'lab_results'::"text", 'billing'::"text", 'surveillance'::"text", 'clinical_pathways'::"text", 'anonymised_research'::"text", 'audit_log'::"text", 'full_backup'::"text", 'custom'::"text"]))),
    CONSTRAINT "data_export_jobs_format_check" CHECK (("format" = ANY (ARRAY['csv'::"text", 'json'::"text", 'fhir_r4'::"text", 'xlsx'::"text", 'parquet'::"text"]))),
    CONSTRAINT "data_export_jobs_scope_check" CHECK (("scope" = ANY (ARRAY['hospital'::"text", 'patient'::"text", 'date_range'::"text", 'custom'::"text"]))),
    CONSTRAINT "data_export_jobs_status_check" CHECK (("status" = ANY (ARRAY['queued'::"text", 'running'::"text", 'completed'::"text", 'failed'::"text", 'cancelled'::"text", 'expired'::"text"])))
);


ALTER TABLE "public"."data_export_jobs" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."data_retention_policies" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "hospital_id" "uuid",
    "table_name" "text" NOT NULL,
    "module_name" "text" NOT NULL,
    "retention_days" integer NOT NULL,
    "action_on_expiry" "text" DEFAULT 'archive'::"text" NOT NULL,
    "legal_basis" "text" DEFAULT 'operational'::"text" NOT NULL,
    "is_active" boolean DEFAULT true NOT NULL,
    "last_run_at" timestamp with time zone,
    "notes" "text",
    "created_at" timestamp with time zone DEFAULT "timezone"('utc'::"text", "now"()) NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "timezone"('utc'::"text", "now"()) NOT NULL,
    "tenant_id" "uuid",
    "created_by" "uuid",
    "is_deleted" boolean DEFAULT false,
    CONSTRAINT "data_retention_policies_action_on_expiry_check" CHECK (("action_on_expiry" = ANY (ARRAY['archive'::"text", 'anonymise'::"text", 'delete'::"text", 'flag_review'::"text"]))),
    CONSTRAINT "data_retention_policies_legal_basis_check" CHECK (("legal_basis" = ANY (ARRAY['operational'::"text", 'legal_hold'::"text", 'research'::"text", 'patient_request'::"text", 'regulatory'::"text"])))
);


ALTER TABLE "public"."data_retention_policies" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."death_registrations" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "hospital_id" "uuid" NOT NULL,
    "patient_id" "uuid",
    "mrn" character varying(40),
    "full_name" "text",
    "age_years" integer,
    "sex" character varying(10),
    "ward" character varying(60),
    "immediate_cause" "text" NOT NULL,
    "antecedent_cause_1" "text",
    "antecedent_cause_2" "text",
    "underlying_cause" "text",
    "underlying_cause_icd11" character varying(20),
    "contributing_conditions" "text",
    "is_unexplained" boolean DEFAULT false NOT NULL,
    "is_infectious" boolean DEFAULT false NOT NULL,
    "is_notifiable" boolean DEFAULT false NOT NULL,
    "admitted_at" timestamp with time zone,
    "died_at" timestamp with time zone NOT NULL,
    "registered_at" timestamp with time zone DEFAULT "now"(),
    "certifying_doctor_id" "uuid",
    "registered_by" "uuid",
    "district_notified" boolean DEFAULT false,
    "district_notified_at" timestamp with time zone,
    "notes" "text",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "tenant_id" "uuid",
    "created_by" "uuid",
    "is_deleted" boolean DEFAULT false
);


ALTER TABLE "public"."death_registrations" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."death_reports" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "encounter_id" "uuid",
    "patient_id" "uuid",
    "underlying_cause_code" "text" NOT NULL,
    "sequence" "text"[] DEFAULT '{}'::"text"[] NOT NULL,
    "reported_at" timestamp with time zone DEFAULT "timezone"('utc'::"text", "now"()) NOT NULL,
    "reported_by" "uuid",
    "tenant_id" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "created_by" "uuid",
    "is_deleted" boolean DEFAULT false
);


ALTER TABLE "public"."death_reports" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."deidentification_profiles" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "hospital_id" "uuid",
    "name" "text" NOT NULL,
    "description" "text",
    "is_default" boolean DEFAULT false NOT NULL,
    "is_system" boolean DEFAULT false NOT NULL,
    "field_rules" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "is_active" boolean DEFAULT true NOT NULL,
    "created_by" "uuid",
    "created_at" timestamp with time zone DEFAULT "timezone"('utc'::"text", "now"()) NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "timezone"('utc'::"text", "now"()) NOT NULL,
    "tenant_id" "uuid",
    "is_deleted" boolean DEFAULT false
);


ALTER TABLE "public"."deidentification_profiles" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."demo_departments" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "name" "text" NOT NULL,
    "code" "text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."demo_departments" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."demo_encounter_orders" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "encounter_id" "uuid",
    "order_type" "text" NOT NULL,
    "description" "text" NOT NULL,
    "status" "text" DEFAULT 'pending'::"text",
    "created_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."demo_encounter_orders" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."demo_encounters" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "patient_id" "uuid",
    "department_id" "uuid",
    "chief_complaint" "text",
    "diagnosis" "text",
    "notes" "text",
    "status" "text" DEFAULT 'open'::"text",
    "doctor_id" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."demo_encounters" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."demo_lab_results" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "encounter_id" "uuid",
    "patient_id" "uuid",
    "test_name" "text" NOT NULL,
    "result_value" "text",
    "unit" "text",
    "status" "text" DEFAULT 'pending'::"text",
    "created_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."demo_lab_results" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."demo_patients" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "mrn" "text" NOT NULL,
    "full_name" "text" NOT NULL,
    "dob" "date",
    "sex" "text",
    "phone" "text",
    "nin" "text",
    "district" "text",
    "department_id" "uuid",
    "triage_status" "text" DEFAULT 'green'::"text",
    "arrived_at" timestamp with time zone DEFAULT "now"(),
    "is_deleted" boolean DEFAULT false,
    "created_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."demo_patients" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."demo_vitals" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "patient_id" "uuid",
    "encounter_id" "uuid",
    "bp_systolic" integer,
    "bp_diastolic" integer,
    "heart_rate" integer,
    "temperature" numeric(4,1),
    "spo2" integer,
    "weight_kg" numeric(5,1),
    "recorded_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."demo_vitals" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."denial_analytics_daily" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "hospital_id" "uuid" NOT NULL,
    "insurer_id" "uuid",
    "report_date" "date" NOT NULL,
    "total_claims" integer DEFAULT 0 NOT NULL,
    "total_denied" integer DEFAULT 0 NOT NULL,
    "total_paid" numeric(14,2) DEFAULT 0 NOT NULL,
    "total_billed" numeric(14,2) DEFAULT 0 NOT NULL,
    "denial_rate" numeric(5,2),
    "top_denial_codes" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "timezone"('utc'::"text", "now"()) NOT NULL,
    "tenant_id" "uuid",
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "created_by" "uuid",
    "is_deleted" boolean DEFAULT false
);


ALTER TABLE "public"."denial_analytics_daily" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."department_tasks" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "tenant_id" "uuid" NOT NULL,
    "facility_id" "uuid",
    "hospital_id" "uuid",
    "patient_id" "uuid",
    "person_id" "uuid",
    "encounter_id" "uuid",
    "requester_id" "uuid",
    "owner_department" "text" NOT NULL,
    "owner_role" "text",
    "task_type" "text" NOT NULL,
    "priority" "text" DEFAULT 'ROUTINE'::"text" NOT NULL,
    "status" "text" DEFAULT 'REQUESTED'::"text" NOT NULL,
    "title" "text" NOT NULL,
    "description" "text",
    "source_resource" "text",
    "source_id" "uuid",
    "correlation_id" "uuid",
    "causation_id" "uuid",
    "idempotency_key" "text",
    "due_at" timestamp with time zone,
    "accepted_at" timestamp with time zone,
    "completed_at" timestamp with time zone,
    "cancelled_at" timestamp with time zone,
    "assigned_to" "uuid",
    "result_summary" "text",
    "metadata" "jsonb" DEFAULT '{}'::"jsonb",
    "is_synthetic" boolean DEFAULT false NOT NULL,
    "simulation_run_id" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "department_tasks_priority_check" CHECK (("priority" = ANY (ARRAY['STAT'::"text", 'URGENT'::"text", 'ROUTINE'::"text", 'LOW'::"text"]))),
    CONSTRAINT "department_tasks_status_check" CHECK (("status" = ANY (ARRAY['REQUESTED'::"text", 'ACCEPTED'::"text", 'IN_PROGRESS'::"text", 'ON_HOLD'::"text", 'COMPLETED'::"text", 'CANCELLED'::"text", 'FAILED'::"text"])))
);


ALTER TABLE "public"."department_tasks" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."departments" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "name" "text" NOT NULL,
    "dept_type" "text" DEFAULT 'opd'::"text" NOT NULL,
    "is_active" boolean DEFAULT true NOT NULL,
    "created_at" timestamp with time zone DEFAULT "timezone"('utc'::"text", "now"()) NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "timezone"('utc'::"text", "now"()) NOT NULL,
    "tenant_id" "uuid",
    "created_by" "uuid",
    "is_deleted" boolean DEFAULT false,
    "hospital_id" "uuid"
);


ALTER TABLE "public"."departments" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."device_alerts" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "device_id" "uuid" NOT NULL,
    "reading_id" "uuid",
    "patient_id" "uuid",
    "hospital_id" "uuid",
    "alert_type" "text" NOT NULL,
    "severity" "text" NOT NULL,
    "message" "text" NOT NULL,
    "status" "text" DEFAULT 'new'::"text" NOT NULL,
    "triggered_at" timestamp with time zone DEFAULT "timezone"('utc'::"text", "now"()) NOT NULL,
    "acknowledged_by" "uuid",
    "acknowledged_at" timestamp with time zone,
    "resolved_at" timestamp with time zone,
    "metadata" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "tenant_id" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "created_by" "uuid",
    "is_deleted" boolean DEFAULT false,
    CONSTRAINT "device_alerts_severity_check" CHECK (("severity" = ANY (ARRAY['info'::"text", 'warning'::"text", 'critical'::"text"]))),
    CONSTRAINT "device_alerts_status_check" CHECK (("status" = ANY (ARRAY['new'::"text", 'acknowledged'::"text", 'resolved'::"text"])))
);


ALTER TABLE "public"."device_alerts" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."device_readings" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "device_id" "uuid" NOT NULL,
    "patient_id" "uuid",
    "encounter_id" "uuid",
    "hospital_id" "uuid",
    "read_at" timestamp with time zone DEFAULT "timezone"('utc'::"text", "now"()) NOT NULL,
    "reading_type" "text" NOT NULL,
    "value" numeric,
    "unit" "text",
    "value_text" "text",
    "raw_payload" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "is_critical" boolean DEFAULT false NOT NULL,
    "alert_sent" boolean DEFAULT false NOT NULL,
    "tenant_id" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "created_by" "uuid",
    "is_deleted" boolean DEFAULT false
);


ALTER TABLE "public"."device_readings" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."dhis2_data_element_mappings" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "tenant_id" "uuid",
    "icd11_stem_code" "text" NOT NULL,
    "dhis2_data_element_id" "text" NOT NULL,
    "display_name" "text",
    "hmis_code" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."dhis2_data_element_mappings" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."dhis2_export_attempt_log" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "job_id" "uuid",
    "tenant_id" "uuid" NOT NULL,
    "status" "text" NOT NULL,
    "mode" "text" DEFAULT 'simulation'::"text" NOT NULL,
    "records_exported" integer DEFAULT 0 NOT NULL,
    "message" "text",
    "metadata" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."dhis2_export_attempt_log" OWNER TO "postgres";


COMMENT ON TABLE "public"."dhis2_export_attempt_log" IS 'Append-only attempt audit for DHIS2 aggregate exports.';



CREATE TABLE IF NOT EXISTS "public"."dhis2_export_jobs" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "tenant_id" "uuid" NOT NULL,
    "facility_id" "uuid",
    "status" "text" DEFAULT 'pending'::"text" NOT NULL,
    "mode" "text" DEFAULT 'simulation'::"text" NOT NULL,
    "period" "text" NOT NULL,
    "org_unit" "text" NOT NULL,
    "data_set" "text",
    "payload" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "idempotency_key" "text" NOT NULL,
    "attempt_count" integer DEFAULT 0 NOT NULL,
    "last_error" "text",
    "is_synthetic" boolean DEFAULT false NOT NULL,
    "created_by" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "started_at" timestamp with time zone,
    "completed_at" timestamp with time zone,
    CONSTRAINT "dhis2_export_jobs_mode_check" CHECK (("mode" = ANY (ARRAY['live'::"text", 'simulation'::"text"]))),
    CONSTRAINT "dhis2_export_jobs_status_check" CHECK (("status" = ANY (ARRAY['pending'::"text", 'running'::"text", 'succeeded'::"text", 'failed'::"text", 'dead'::"text"])))
);


ALTER TABLE "public"."dhis2_export_jobs" OWNER TO "postgres";


COMMENT ON TABLE "public"."dhis2_export_jobs" IS 'Outbound DHIS2 aggregate DataValueSet jobs. Payload is privacy-gated counts only — never PatientContextPacket.';



CREATE TABLE IF NOT EXISTS "public"."dhis2_export_log" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "tenant_id" "uuid",
    "export_date" "date",
    "records_exported" integer DEFAULT 0 NOT NULL,
    "status" "text",
    "error_message" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "job_id" "uuid"
);


ALTER TABLE "public"."dhis2_export_log" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."dhis2_org_unit_mappings" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "tenant_id" "uuid",
    "facility_id" "uuid",
    "local_org_key" "text" NOT NULL,
    "dhis2_org_unit_id" "text" NOT NULL,
    "display_name" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."dhis2_org_unit_mappings" OWNER TO "postgres";


COMMENT ON TABLE "public"."dhis2_org_unit_mappings" IS 'Local facility to DHIS2 org-unit mappings. OU_SIM_FACILITY is simulation-only; MoH UIDs are required for production.';



CREATE TABLE IF NOT EXISTS "public"."diagnoses" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "icd_code" "text" NOT NULL,
    "title" "text" NOT NULL,
    "definition" "text",
    "chapter" "text",
    "created_at" timestamp with time zone DEFAULT "timezone"('utc'::"text", "now"()) NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "timezone"('utc'::"text", "now"()) NOT NULL,
    "tenant_id" "uuid",
    "created_by" "uuid",
    "is_deleted" boolean DEFAULT false
);


ALTER TABLE "public"."diagnoses" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."diet_logs" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "logged_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "meal_type" "text",
    "food_name" "text" NOT NULL,
    "portion_description" "text",
    "estimated_calories" integer,
    "protein_g" numeric,
    "carbs_g" numeric,
    "fat_g" numeric,
    "image_url" "text",
    "ai_analysis" "jsonb",
    "created_at" timestamp with time zone DEFAULT "now"(),
    CONSTRAINT "diet_logs_meal_type_check" CHECK (("meal_type" = ANY (ARRAY['breakfast'::"text", 'lunch'::"text", 'dinner'::"text", 'snack'::"text", 'drink'::"text"])))
);


ALTER TABLE "public"."diet_logs" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."doctor_availability_log" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "provider_id" "uuid" NOT NULL,
    "event" "text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "doctor_availability_log_event_check" CHECK (("event" = ANY (ARRAY['online'::"text", 'offline'::"text", 'idle'::"text", 'busy'::"text"])))
);


ALTER TABLE "public"."doctor_availability_log" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."domain_event_consumers" (
    "consumer_id" "text" NOT NULL,
    "tenant_id" "uuid" NOT NULL,
    "checkpoint_at" timestamp with time zone DEFAULT "timezone"('utc'::"text", "now"()) NOT NULL,
    "last_event_id" "text",
    "status" "text" DEFAULT 'active'::"text" NOT NULL,
    "lag_seconds" integer,
    "last_error" "text",
    "updated_at" timestamp with time zone DEFAULT "timezone"('utc'::"text", "now"()) NOT NULL,
    CONSTRAINT "domain_event_consumers_status_check" CHECK (("status" = ANY (ARRAY['active'::"text", 'paused'::"text", 'failed'::"text"])))
);


ALTER TABLE "public"."domain_event_consumers" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."domain_events" (
    "event_id" "text" NOT NULL,
    "event_type" "text" NOT NULL,
    "event_version" integer DEFAULT 1 NOT NULL,
    "schema_version" integer DEFAULT 1 NOT NULL,
    "tenant_id" "uuid" NOT NULL,
    "facility_id" "uuid",
    "patient_id" "uuid",
    "encounter_id" "uuid",
    "actor_id" "uuid",
    "actor_type" "text" NOT NULL,
    "source_module" "text" NOT NULL,
    "source_system" "text" DEFAULT 'synapse'::"text" NOT NULL,
    "correlation_id" "text" NOT NULL,
    "causation_id" "text",
    "idempotency_key" "text" NOT NULL,
    "occurred_at" timestamp with time zone NOT NULL,
    "recorded_at" timestamp with time zone DEFAULT "timezone"('utc'::"text", "now"()) NOT NULL,
    "payload" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "processing_status" "text" DEFAULT 'pending'::"text" NOT NULL,
    "attempts" integer DEFAULT 0 NOT NULL,
    "last_error" "text",
    "processed_at" timestamp with time zone,
    "next_attempt_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "timezone"('utc'::"text", "now"()) NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "timezone"('utc'::"text", "now"()) NOT NULL,
    CONSTRAINT "domain_events_actor_type_check" CHECK (("actor_type" = ANY (ARRAY['human'::"text", 'system'::"text", 'adapter'::"text", 'intelligence'::"text", 'device'::"text"]))),
    CONSTRAINT "domain_events_attempts_check" CHECK (("attempts" >= 0)),
    CONSTRAINT "domain_events_event_version_check" CHECK (("event_version" > 0)),
    CONSTRAINT "domain_events_processing_status_check" CHECK (("processing_status" = ANY (ARRAY['pending'::"text", 'processing'::"text", 'processed'::"text", 'failed'::"text", 'dead_lettered'::"text", 'skipped'::"text"]))),
    CONSTRAINT "domain_events_schema_version_check" CHECK (("schema_version" > 0)),
    CONSTRAINT "domain_events_source_module_check" CHECK (("source_module" = ANY (ARRAY['core'::"text", 'clinical'::"text", 'pathways'::"text", 'intelligence'::"text", 'terminology'::"text", 'lab'::"text", 'pharmacy'::"text", 'imaging'::"text", 'insurance'::"text", 'exchange'::"text", 'publichealth'::"text", 'edge'::"text", 'platform'::"text", 'timeline'::"text"])))
);


ALTER TABLE "public"."domain_events" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."drug_contraindications" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "drug_code" "text" NOT NULL,
    "drug_name" "text" NOT NULL,
    "condition_icd11" "text" NOT NULL,
    "condition_name" "text" NOT NULL,
    "severity" "text" NOT NULL,
    "reason" "text" NOT NULL,
    "alternative" "text",
    "source" "text" DEFAULT 'internal'::"text" NOT NULL,
    "is_active" boolean DEFAULT true NOT NULL,
    "created_at" timestamp with time zone DEFAULT "timezone"('utc'::"text", "now"()) NOT NULL,
    "tenant_id" "uuid",
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "created_by" "uuid",
    "is_deleted" boolean DEFAULT false,
    CONSTRAINT "drug_contraindications_severity_check" CHECK (("severity" = ANY (ARRAY['relative'::"text", 'absolute'::"text"])))
);


ALTER TABLE "public"."drug_contraindications" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."drug_dose_adjustments" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "drug_code" "text" NOT NULL,
    "drug_name" "text" NOT NULL,
    "organ_type" "text" NOT NULL,
    "reference_range" "text" NOT NULL,
    "standard_dose" "text",
    "adjusted_dose" "text",
    "dose_note" "text",
    "is_avoid" boolean DEFAULT false NOT NULL,
    "source" "text" DEFAULT 'internal'::"text" NOT NULL,
    "is_active" boolean DEFAULT true NOT NULL,
    "created_at" timestamp with time zone DEFAULT "timezone"('utc'::"text", "now"()) NOT NULL,
    "tenant_id" "uuid",
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "created_by" "uuid",
    "is_deleted" boolean DEFAULT false,
    CONSTRAINT "drug_dose_adjustments_organ_type_check" CHECK (("organ_type" = ANY (ARRAY['renal'::"text", 'hepatic'::"text", 'weight'::"text", 'age'::"text"])))
);


ALTER TABLE "public"."drug_dose_adjustments" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."drug_interactions" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "drug_a_code" "text" NOT NULL,
    "drug_a_name" "text" NOT NULL,
    "drug_b_code" "text" NOT NULL,
    "drug_b_name" "text" NOT NULL,
    "severity" "text" NOT NULL,
    "mechanism" "text",
    "clinical_effect" "text" NOT NULL,
    "management" "text",
    "reference_sources" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "source" "text" DEFAULT 'internal'::"text" NOT NULL,
    "is_active" boolean DEFAULT true NOT NULL,
    "created_at" timestamp with time zone DEFAULT "timezone"('utc'::"text", "now"()) NOT NULL,
    "tenant_id" "uuid",
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "created_by" "uuid",
    "is_deleted" boolean DEFAULT false,
    CONSTRAINT "drug_interactions_severity_check" CHECK (("severity" = ANY (ARRAY['minor'::"text", 'moderate'::"text", 'major'::"text", 'contraindicated'::"text"])))
);


ALTER TABLE "public"."drug_interactions" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."drug_interactions_catalog" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "drug1_atc" "text" NOT NULL,
    "drug2_atc" "text" NOT NULL,
    "severity" "text" NOT NULL,
    "mechanism" "text" NOT NULL,
    "recommendation" "text" NOT NULL,
    "alternative" "text",
    "created_at" timestamp with time zone DEFAULT "timezone"('utc'::"text", "now"()) NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "timezone"('utc'::"text", "now"()) NOT NULL,
    "tenant_id" "uuid",
    "created_by" "uuid",
    "is_deleted" boolean DEFAULT false,
    CONSTRAINT "drug_interactions_catalog_severity_check" CHECK (("severity" = ANY (ARRAY['MILD'::"text", 'MODERATE'::"text", 'SEVERE'::"text", 'FATAL'::"text"])))
);


ALTER TABLE "public"."drug_interactions_catalog" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."drug_inventory" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "tenant_id" "uuid" NOT NULL,
    "generic_name" "text" NOT NULL,
    "brand_name" "text",
    "formulation" "text",
    "category" "text",
    "atc_code" "text",
    "strength" "text",
    "dosage_form" "text",
    "batch_number" "text",
    "quantity_in_stock" integer DEFAULT 0 NOT NULL,
    "reorder_level" integer DEFAULT 10 NOT NULL,
    "unit_price_ugx" numeric(12,2),
    "expiry_date" "date",
    "supplier" "text",
    "received_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."drug_inventory" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."drug_shortage_alerts" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "drug_name" "text" NOT NULL,
    "generic_name" "text",
    "drug_code" "text",
    "alert_level" "text" NOT NULL,
    "affected_districts" "text"[] DEFAULT '{}'::"text"[] NOT NULL,
    "pharmacy_count_affected" integer DEFAULT 0 NOT NULL,
    "is_active" boolean DEFAULT true NOT NULL,
    "created_by" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "resolved_at" timestamp with time zone,
    CONSTRAINT "drug_shortage_alerts_alert_level_check" CHECK (("alert_level" = ANY (ARRAY['watch'::"text", 'warning'::"text", 'critical'::"text"])))
);


ALTER TABLE "public"."drug_shortage_alerts" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."emergency_access_events" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "person_id" "uuid" NOT NULL,
    "actor_id" "uuid",
    "actor_role" "text",
    "facility_id" "uuid",
    "access_method" "text" DEFAULT 'break_glass'::"text" NOT NULL,
    "fields_disclosed" "text"[] DEFAULT '{}'::"text"[] NOT NULL,
    "reason" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "emergency_access_events_access_method_check" CHECK (("access_method" = ANY (ARRAY['break_glass'::"text", 'qr_token'::"text", 'operator_assisted'::"text"])))
);


ALTER TABLE "public"."emergency_access_events" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."emergency_profiles" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "person_id" "uuid" NOT NULL,
    "show_name" boolean DEFAULT true NOT NULL,
    "show_blood_group" boolean DEFAULT false NOT NULL,
    "show_allergies" boolean DEFAULT false NOT NULL,
    "show_conditions" boolean DEFAULT false NOT NULL,
    "show_medications" boolean DEFAULT false NOT NULL,
    "show_emergency_contact" boolean DEFAULT true NOT NULL,
    "access_token_hash" "text",
    "token_expires_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."emergency_profiles" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."encounter_amendments" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "tenant_id" "uuid" NOT NULL,
    "encounter_id" "uuid" NOT NULL,
    "field_name" "text" NOT NULL,
    "previous_value" "text" DEFAULT ''::"text" NOT NULL,
    "new_value" "text" NOT NULL,
    "reason" "text" NOT NULL,
    "amended_by" "uuid",
    "amended_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "encounter_amendments_field_check" CHECK (("field_name" = ANY (ARRAY['chief_complaint'::"text", 'clinical_stage'::"text", 'clinical_note'::"text"])))
);


ALTER TABLE "public"."encounter_amendments" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."encounter_diagnoses" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "encounter_id" "uuid" NOT NULL,
    "stem_code" "text" NOT NULL,
    "cluster_code" "text" NOT NULL,
    "title" "text" NOT NULL,
    "certainty" "text",
    "diagnosis_type" "text",
    "foundation_uri" "text",
    "created_at" timestamp with time zone DEFAULT "timezone"('utc'::"text", "now"()) NOT NULL,
    "tenant_id" "uuid",
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "created_by" "uuid",
    "is_deleted" boolean DEFAULT false,
    "icd_release" "text",
    "linearization_uri" "text",
    "selected_by" "uuid",
    "suggested_by" "text",
    "intelligence_session_id" "uuid",
    CONSTRAINT "encounter_diagnoses_certainty_check" CHECK (("certainty" = ANY (ARRAY['suspected'::"text", 'confirmed'::"text", 'differential'::"text"]))),
    CONSTRAINT "encounter_diagnoses_diagnosis_type_check" CHECK (("diagnosis_type" = ANY (ARRAY['primary'::"text", 'secondary'::"text", 'comorbidity'::"text", 'complication'::"text"])))
);


ALTER TABLE "public"."encounter_diagnoses" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."encounter_orders" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "encounter_id" "uuid" NOT NULL,
    "encounter_diagnosis_id" "uuid",
    "order_type" "text" NOT NULL,
    "code" "text" NOT NULL,
    "name" "text" NOT NULL,
    "status" "text" DEFAULT 'pending'::"text",
    "created_at" timestamp with time zone DEFAULT "timezone"('utc'::"text", "now"()) NOT NULL,
    "version" integer DEFAULT 1 NOT NULL,
    "tenant_id" "uuid",
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "created_by" "uuid",
    "is_deleted" boolean DEFAULT false,
    CONSTRAINT "encounter_orders_order_type_check" CHECK (("order_type" = ANY (ARRAY['lab'::"text", 'pharmacy'::"text", 'imaging'::"text"]))),
    CONSTRAINT "encounter_orders_status_check" CHECK (("status" = ANY (ARRAY['pending'::"text", 'completed'::"text", 'cancelled'::"text"])))
);


ALTER TABLE "public"."encounter_orders" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."encounters" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "hospital_id" "uuid",
    "patient_id" "uuid",
    "department_id" "uuid",
    "clinician_id" "uuid",
    "patient_identifier_hash" "text",
    "clinical_stage" "text",
    "visit_date" timestamp with time zone,
    "chief_complaint" "text",
    "metadata" "jsonb",
    "created_at" timestamp with time zone DEFAULT "timezone"('utc'::"text", "now"()) NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "timezone"('utc'::"text", "now"()) NOT NULL,
    "version" integer DEFAULT 1 NOT NULL,
    "tenant_id" "uuid",
    "created_by" "uuid",
    "is_deleted" boolean DEFAULT false,
    "status" "text" DEFAULT 'open'::"text" NOT NULL,
    "person_id" "uuid",
    "correlation_id" "uuid",
    "is_synthetic" boolean DEFAULT false NOT NULL,
    "simulation_run_id" "uuid",
    "is_signed" boolean DEFAULT false NOT NULL,
    "signed_at" timestamp with time zone,
    "signed_by" "uuid",
    "disposition" "text",
    "disposition_reason" "text",
    "disposition_by" "uuid",
    "disposition_at" timestamp with time zone,
    CONSTRAINT "encounters_disposition_check" CHECK ((("disposition" IS NULL) OR ("disposition" = ANY (ARRAY['LOCAL_PHARMACY'::"text", 'EXTERNAL_PHARMACY'::"text", 'NO_MEDICATION'::"text", 'FURTHER_LAB'::"text", 'REFERRAL'::"text", 'FOLLOW_UP'::"text", 'CLINICAL_COMPLETE'::"text"])))),
    CONSTRAINT "encounters_status_check" CHECK (("status" = ANY (ARRAY['open'::"text", 'in_progress'::"text", 'completed'::"text", 'cancelled'::"text"])))
);


ALTER TABLE "public"."encounters" OWNER TO "postgres";


COMMENT ON COLUMN "public"."encounters"."disposition" IS 'Doctor disposition recorded before encounter close (RC1 closeout).';



CREATE TABLE IF NOT EXISTS "public"."expert_rules" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "rule_id" "text" NOT NULL,
    "name" "text" NOT NULL,
    "description" "text",
    "category" "text" NOT NULL,
    "specialty" "text",
    "rule_format" "text" DEFAULT 'JSON_LOGIC'::"text" NOT NULL,
    "rule_content" "jsonb" NOT NULL,
    "variables" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "outcomes" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "source" "text" NOT NULL,
    "source_id" "text",
    "country_code" "text",
    "version" "text" DEFAULT '1.0'::"text" NOT NULL,
    "effective_date" timestamp with time zone DEFAULT "timezone"('utc'::"text", "now"()) NOT NULL,
    "expiry_date" timestamp with time zone,
    "evidence_level" "text",
    "validated_by" "text",
    "validation_date" timestamp with time zone,
    "active" boolean DEFAULT true NOT NULL,
    "priority" integer DEFAULT 10 NOT NULL,
    "metadata" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "timezone"('utc'::"text", "now"()) NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "timezone"('utc'::"text", "now"()) NOT NULL,
    "tenant_id" "uuid",
    "created_by" "uuid",
    "is_deleted" boolean DEFAULT false,
    CONSTRAINT "expert_rules_category_check" CHECK (("category" = ANY (ARRAY['CLINICAL_DIAGNOSIS'::"text", 'CLINICAL_SAFETY'::"text", 'DRUG_INTERACTION'::"text", 'ALLERGY'::"text", 'DOSING_ADJUSTMENT'::"text", 'TRIAGE_SCORING'::"text", 'INSURANCE_TARIFF'::"text"]))),
    CONSTRAINT "expert_rules_evidence_level_check" CHECK (("evidence_level" = ANY (ARRAY['META_ANALYSIS'::"text", 'RANDOMIZED_TRIAL'::"text", 'OBSERVATIONAL'::"text", 'EXPERT_OPINION'::"text"]))),
    CONSTRAINT "expert_rules_rule_format_check" CHECK (("rule_format" = ANY (ARRAY['JSON_LOGIC'::"text", 'ARDEN_MLM'::"text", 'CQL'::"text"]))),
    CONSTRAINT "expert_rules_source_check" CHECK (("source" = ANY (ARRAY['UGANDA_CLINICAL_GUIDELINES'::"text", 'CDR_AGENT'::"text", 'OPENCDS'::"text", 'MDCALC'::"text", 'WHO'::"text", 'INSURER'::"text", 'CUSTOM'::"text"]))),
    CONSTRAINT "expert_rules_specialty_check" CHECK (("specialty" = ANY (ARRAY['EMERGENCY'::"text", 'CARDIOLOGY'::"text", 'INFECTIOUS_DISEASE'::"text", 'PEDIATRICS'::"text", 'OBSTETRICS'::"text", 'PHARMACOLOGY'::"text", 'INTERNAL_MEDICINE'::"text"])))
);


ALTER TABLE "public"."expert_rules" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."facility_domain_records" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "tenant_id" "uuid" NOT NULL,
    "facility_id" "uuid",
    "hostname" "text" NOT NULL,
    "domain_type" "text" DEFAULT 'synapse_subdomain'::"text" NOT NULL,
    "target_project" "text",
    "status" "text" DEFAULT 'NOT_REQUESTED'::"text" NOT NULL,
    "verified_at" timestamp with time zone,
    "last_checked_at" timestamp with time zone,
    "safe_error" "text",
    "verification_requirements" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "metadata" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "facility_domain_records_domain_type_check" CHECK (("domain_type" = ANY (ARRAY['synapse_subdomain'::"text", 'pharmacy_login'::"text", 'pharmacy_subdomain'::"text", 'custom'::"text"]))),
    CONSTRAINT "facility_domain_records_status_check" CHECK (("status" = ANY (ARRAY['NOT_REQUESTED'::"text", 'REQUESTED'::"text", 'PROVISIONING'::"text", 'DNS_PENDING'::"text", 'VERIFIED'::"text", 'ACTIVE'::"text", 'ERROR'::"text"])))
);


ALTER TABLE "public"."facility_domain_records" OWNER TO "postgres";


COMMENT ON TABLE "public"."facility_domain_records" IS 'Domain provisioning evidence for facilities. Never store Vercel bearer tokens.';



CREATE TABLE IF NOT EXISTS "public"."facility_invitation_audit" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "invitation_id" "uuid" NOT NULL,
    "event" "text" NOT NULL,
    "actor_profile_id" "uuid",
    "metadata" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."facility_invitation_audit" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."facility_invitations" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "tenant_id" "uuid" NOT NULL,
    "run_id" "uuid",
    "email" "text" NOT NULL,
    "full_name" "text",
    "role" "text" DEFAULT 'hospital_admin'::"text" NOT NULL,
    "invite_token" "text",
    "status" "text" DEFAULT 'PENDING'::"text" NOT NULL,
    "expires_at" timestamp with time zone NOT NULL,
    "sent_at" timestamp with time zone,
    "accepted_at" timestamp with time zone,
    "revoked_at" timestamp with time zone,
    "last_error" "text",
    "profile_id" "uuid",
    "created_by" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "token_hash" "text",
    "redeemed_by" "uuid",
    "department_id" "uuid",
    CONSTRAINT "facility_invitations_status_check" CHECK (("status" = ANY (ARRAY['PENDING'::"text", 'SENT'::"text", 'ACCEPTED'::"text", 'EXPIRED'::"text", 'FAILED'::"text", 'REVOKED'::"text"]))),
    CONSTRAINT "facility_invitations_token_xor_hash" CHECK (("num_nonnulls"("invite_token", "token_hash") = 1))
);


ALTER TABLE "public"."facility_invitations" OWNER TO "postgres";


COMMENT ON TABLE "public"."facility_invitations" IS 'Single-use expiring hospital admin invitations (custom Synapse auth).';



COMMENT ON COLUMN "public"."facility_invitations"."token_hash" IS 'SHA-256 hash of the single-use invitation secret for hardened, platform-admin-issued invitations. The raw secret is never stored.';



COMMENT ON COLUMN "public"."facility_invitations"."redeemed_by" IS 'Profile that redeemed this invitation, for durable audit.';



CREATE TABLE IF NOT EXISTS "public"."facility_lifecycle_events" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "tenant_id" "uuid" NOT NULL,
    "actor_id" "uuid",
    "action" "text" NOT NULL,
    "from_state" "text" NOT NULL,
    "to_state" "text" NOT NULL,
    "reason" "text",
    "correlation_id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "impact" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."facility_lifecycle_events" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."facility_locations" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "tenant_id" "uuid" NOT NULL,
    "hospital_id" "uuid",
    "department_id" "uuid",
    "parent_id" "uuid",
    "code" "text" NOT NULL,
    "name" "text" NOT NULL,
    "location_type" "text" DEFAULT 'room'::"text" NOT NULL,
    "floor" integer,
    "building" "text",
    "is_active" boolean DEFAULT true NOT NULL,
    "is_synthetic" boolean DEFAULT false NOT NULL,
    "metadata" "jsonb" DEFAULT '{}'::"jsonb",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."facility_locations" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."facility_provisioning_runs" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "tenant_id" "uuid",
    "hospital_id" "uuid",
    "created_by" "uuid",
    "mode" "text" DEFAULT 'REAL'::"text" NOT NULL,
    "status" "text" DEFAULT 'PENDING'::"text" NOT NULL,
    "current_step" "text",
    "started_at" timestamp with time zone,
    "completed_at" timestamp with time zone,
    "failed_at" timestamp with time zone,
    "failure_code" "text",
    "correlation_id" "text" NOT NULL,
    "idempotency_key" "text" NOT NULL,
    "slug" "text" NOT NULL,
    "facility_name" "text" NOT NULL,
    "ownership" "text",
    "facility_level" "text",
    "metadata" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "facility_provisioning_runs_mode_check" CHECK (("mode" = ANY (ARRAY['REAL'::"text", 'SYNTHETIC_ACCEPTANCE'::"text"]))),
    CONSTRAINT "facility_provisioning_runs_status_check" CHECK (("status" = ANY (ARRAY['PENDING'::"text", 'RUNNING'::"text", 'COMPLETE'::"text", 'FAILED'::"text", 'READY_WITH_WARNINGS'::"text", 'ROLLED_BACK'::"text"])))
);


ALTER TABLE "public"."facility_provisioning_runs" OWNER TO "postgres";


COMMENT ON TABLE "public"."facility_provisioning_runs" IS 'Hospital/facility onboarding runs with explicit step status. Modes: REAL | SYNTHETIC_ACCEPTANCE.';



CREATE TABLE IF NOT EXISTS "public"."facility_provisioning_steps" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "run_id" "uuid" NOT NULL,
    "step" "text" NOT NULL,
    "status" "text" DEFAULT 'PENDING'::"text" NOT NULL,
    "started_at" timestamp with time zone,
    "completed_at" timestamp with time zone,
    "error_code" "text",
    "safe_error_message" "text",
    "attempt_count" integer DEFAULT 0 NOT NULL,
    "evidence" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "facility_provisioning_steps_status_check" CHECK (("status" = ANY (ARRAY['PENDING'::"text", 'RUNNING'::"text", 'COMPLETE'::"text", 'FAILED'::"text", 'SKIPPED'::"text", 'ROLLED_BACK'::"text"])))
);


ALTER TABLE "public"."facility_provisioning_steps" OWNER TO "postgres";


COMMENT ON TABLE "public"."facility_provisioning_steps" IS 'Per-step provisioning audit: PENDING|RUNNING|COMPLETE|FAILED|SKIPPED|ROLLED_BACK.';



CREATE TABLE IF NOT EXISTS "public"."facility_referrals" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "from_tenant_id" "uuid" NOT NULL,
    "to_tenant_id" "uuid" NOT NULL,
    "patient_id" "uuid" NOT NULL,
    "encounter_id" "uuid" NOT NULL,
    "status" "text" DEFAULT 'pending'::"text" NOT NULL,
    "speciality" "text" NOT NULL,
    "urgency" "text" DEFAULT 'ROUTINE'::"text" NOT NULL,
    "clinical_summary" "text" NOT NULL,
    "fhir_bundle" "jsonb",
    "consent_obtained" boolean DEFAULT false NOT NULL,
    "consent_method" "text",
    "accepted_by" "uuid",
    "accepted_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "created_by" "uuid",
    "rejected_reason" "text",
    "completed_at" timestamp with time zone,
    "cancelled_at" timestamp with time zone,
    "is_synthetic" boolean DEFAULT false NOT NULL,
    CONSTRAINT "facility_referrals_consent_method_check" CHECK (("consent_method" = ANY (ARRAY['screen'::"text", 'sms_otp'::"text"]))),
    CONSTRAINT "facility_referrals_status_check" CHECK (("status" = ANY (ARRAY['pending'::"text", 'accepted'::"text", 'rejected'::"text", 'completed'::"text", 'cancelled'::"text"]))),
    CONSTRAINT "facility_referrals_urgency_check" CHECK (("urgency" = ANY (ARRAY['IMMEDIATE'::"text", 'URGENT'::"text", 'ROUTINE'::"text"])))
);


ALTER TABLE "public"."facility_referrals" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."facility_resource_logs" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "hospital_id" "uuid",
    "resource_type" "text" NOT NULL,
    "value" numeric NOT NULL,
    "unit" "text",
    "details" "jsonb" DEFAULT '{}'::"jsonb",
    "recorded_by" "uuid",
    "recorded_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."facility_resource_logs" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."facility_type_inheritance" (
    "facility_type" "text" NOT NULL,
    "includes" "text" NOT NULL
);


ALTER TABLE "public"."facility_type_inheritance" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."feature_flags" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "tenant_id" "uuid",
    "feature_key" "text" NOT NULL,
    "is_enabled" boolean DEFAULT false NOT NULL,
    "enabled_by" "uuid",
    "enabled_at" timestamp with time zone,
    "notes" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."feature_flags" OWNER TO "postgres";


COMMENT ON TABLE "public"."feature_flags" IS 'Tenant and global runtime feature flags managed by platform administrators.';



CREATE TABLE IF NOT EXISTS "public"."gas_cylinders" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "customer_id" "uuid",
    "cylinder_size" "text" NOT NULL,
    "status" "text" DEFAULT 'Active'::"text",
    "last_swap" timestamp with time zone DEFAULT "now"(),
    "created_at" timestamp with time zone DEFAULT "now"(),
    "tenant_id" "uuid",
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "created_by" "uuid",
    "is_deleted" boolean DEFAULT false
);


ALTER TABLE "public"."gas_cylinders" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."habit_logs" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "habit_id" "uuid" NOT NULL,
    "user_id" "uuid" NOT NULL,
    "logged_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "value" numeric,
    "note" "text",
    "created_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."habit_logs" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."handover_patient_entries" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "handover_id" "uuid" NOT NULL,
    "patient_id" "uuid" NOT NULL,
    "bed_location" "text",
    "acuity_level" "text" DEFAULT 'stable'::"text" NOT NULL,
    "sbar_situation" "text",
    "sbar_background" "text",
    "sbar_assessment" "text",
    "sbar_recommendation" "text",
    "ai_summary" "text",
    "pending_tasks" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "completed_tasks" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "active_pathways" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "active_orders" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "timezone"('utc'::"text", "now"()) NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "timezone"('utc'::"text", "now"()) NOT NULL,
    "tenant_id" "uuid",
    "created_by" "uuid",
    "is_deleted" boolean DEFAULT false,
    "hospital_id" "uuid",
    CONSTRAINT "handover_patient_entries_acuity_level_check" CHECK (("acuity_level" = ANY (ARRAY['critical'::"text", 'high'::"text", 'moderate'::"text", 'stable'::"text", 'discharge_ready'::"text"])))
);


ALTER TABLE "public"."handover_patient_entries" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."handover_shift_tasks" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "handover_id" "uuid" NOT NULL,
    "title" "text" NOT NULL,
    "task_type" "text" DEFAULT 'general'::"text" NOT NULL,
    "priority" "text" DEFAULT 'normal'::"text" NOT NULL,
    "status" "text" DEFAULT 'pending'::"text" NOT NULL,
    "assigned_to" "uuid",
    "carried_over_to" "uuid",
    "due_at" timestamp with time zone,
    "completed_at" timestamp with time zone,
    "notes" "text",
    "created_at" timestamp with time zone DEFAULT "timezone"('utc'::"text", "now"()) NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "timezone"('utc'::"text", "now"()) NOT NULL,
    "tenant_id" "uuid",
    "created_by" "uuid",
    "is_deleted" boolean DEFAULT false,
    CONSTRAINT "handover_shift_tasks_priority_check" CHECK (("priority" = ANY (ARRAY['urgent'::"text", 'high'::"text", 'normal'::"text", 'low'::"text"]))),
    CONSTRAINT "handover_shift_tasks_status_check" CHECK (("status" = ANY (ARRAY['pending'::"text", 'in_progress'::"text", 'completed'::"text", 'carried_over'::"text", 'cancelled'::"text"]))),
    CONSTRAINT "handover_shift_tasks_task_type_check" CHECK (("task_type" = ANY (ARRAY['medication'::"text", 'review'::"text", 'procedure'::"text", 'documentation'::"text", 'escalation'::"text", 'general'::"text"])))
);


ALTER TABLE "public"."handover_shift_tasks" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."handover_signatures" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "handover_id" "uuid" NOT NULL,
    "signer_id" "uuid" NOT NULL,
    "role" "text" NOT NULL,
    "signed_at" timestamp with time zone DEFAULT "timezone"('utc'::"text", "now"()) NOT NULL,
    "signature" "text",
    "ip_address" "inet",
    "tenant_id" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "created_by" "uuid",
    "is_deleted" boolean DEFAULT false
);


ALTER TABLE "public"."handover_signatures" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."health_bulletins" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "tenant_id" "uuid",
    "title" "text" NOT NULL,
    "body" "text" NOT NULL,
    "severity" "text" DEFAULT 'info'::"text",
    "target_type" "text" DEFAULT 'all'::"text",
    "target_value" "text",
    "created_at" timestamp with time zone DEFAULT "now"(),
    CONSTRAINT "health_bulletins_severity_check" CHECK (("severity" = ANY (ARRAY['info'::"text", 'warning'::"text", 'critical'::"text"])))
);


ALTER TABLE "public"."health_bulletins" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."health_habits" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "name" "text" NOT NULL,
    "category" "text",
    "frequency" "text" DEFAULT 'daily'::"text",
    "target_value" numeric,
    "target_unit" "text",
    "streak_days" integer DEFAULT 0,
    "last_logged_at" timestamp with time zone,
    "is_active" boolean DEFAULT true,
    "created_at" timestamp with time zone DEFAULT "now"(),
    CONSTRAINT "health_habits_category_check" CHECK (("category" = ANY (ARRAY['exercise'::"text", 'sleep'::"text", 'hydration'::"text", 'meditation'::"text", 'medication'::"text", 'custom'::"text"])))
);


ALTER TABLE "public"."health_habits" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."hospital_beds" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "hospital_id" "uuid" NOT NULL,
    "bed_number" character varying(20) NOT NULL,
    "ward" character varying(60) NOT NULL,
    "bed_type" character varying(30) DEFAULT 'general'::character varying NOT NULL,
    "status" character varying(20) DEFAULT 'available'::character varying NOT NULL,
    "floor" integer,
    "room" character varying(30),
    "notes" "text",
    "qr_code" character varying(80),
    "last_cleaned_at" timestamp with time zone,
    "last_status_change" timestamp with time zone DEFAULT "now"(),
    "created_at" timestamp with time zone DEFAULT "now"(),
    "current_patient_id" "uuid",
    "building" "text",
    "updated_at" timestamp with time zone DEFAULT "timezone"('utc'::"text", "now"()) NOT NULL,
    "tenant_id" "uuid",
    "created_by" "uuid",
    "is_deleted" boolean DEFAULT false
);


ALTER TABLE "public"."hospital_beds" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."hospital_drug_orders" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "encounter_id" "uuid" NOT NULL,
    "patient_identifier_hash" "text",
    "drug_name" "text" NOT NULL,
    "atc_code" "text",
    "epharm_product_id" "text",
    "qty_ordered" numeric DEFAULT 1 NOT NULL,
    "unit" "text" DEFAULT 'units'::"text" NOT NULL,
    "unit_price" numeric,
    "status" "text" DEFAULT 'pending'::"text" NOT NULL,
    "notes" "text",
    "created_at" timestamp with time zone DEFAULT "timezone"('utc'::"text", "now"()) NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "timezone"('utc'::"text", "now"()) NOT NULL,
    "version" integer DEFAULT 1 NOT NULL,
    "tenant_id" "uuid",
    "created_by" "uuid",
    "is_deleted" boolean DEFAULT false,
    CONSTRAINT "hospital_drug_orders_status_check" CHECK (("status" = ANY (ARRAY['pending'::"text", 'dispensed'::"text", 'cancelled'::"text"])))
);


ALTER TABLE "public"."hospital_drug_orders" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."hospital_leads" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "hospital_name" "text" NOT NULL,
    "facility_type" "text" DEFAULT 'hospital'::"text" NOT NULL,
    "contact_name" "text",
    "contact_email" "text",
    "contact_phone" "text",
    "location" "text",
    "bed_count" integer,
    "current_system" "text",
    "departments" "text"[] DEFAULT '{}'::"text"[] NOT NULL,
    "notes" "text",
    "status" "text" DEFAULT 'new'::"text" NOT NULL,
    "stage" "text" DEFAULT 'interest'::"text" NOT NULL,
    "source" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "hospital_leads_facility_type_check" CHECK (("facility_type" = ANY (ARRAY['hospital'::"text", 'pharmacy'::"text"]))),
    CONSTRAINT "hospital_leads_stage_check" CHECK (("stage" = ANY (ARRAY['interest'::"text", 'demo'::"text", 'trial'::"text", 'converted'::"text", 'lost'::"text"])))
);


ALTER TABLE "public"."hospital_leads" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."hospital_modules" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "hospital_id" "uuid",
    "tenant_id" "uuid",
    "module_key" "text" NOT NULL,
    "is_active" boolean DEFAULT false,
    "activated_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."hospital_modules" OWNER TO "postgres";


COMMENT ON TABLE "public"."hospital_modules" IS 'Per-hospital module activation registry.';



CREATE TABLE IF NOT EXISTS "public"."hospital_seed_registry" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "tenant_id" "uuid" NOT NULL,
    "hospital_id" "uuid",
    "slug" "text" NOT NULL,
    "seed" bigint NOT NULL,
    "seed_version" "text" DEFAULT '20260830'::"text" NOT NULL,
    "environment" "text" DEFAULT 'demo'::"text" NOT NULL,
    "is_synthetic" boolean DEFAULT true NOT NULL,
    "data_classification" "text" DEFAULT 'synthetic'::"text" NOT NULL,
    "protected_flags" "jsonb" DEFAULT '{"claims": true, "reporting": true, "notifications": true}'::"jsonb" NOT NULL,
    "department_count" integer DEFAULT 0,
    "location_count" integer DEFAULT 0,
    "staff_count" integer DEFAULT 0,
    "patient_count" integer DEFAULT 0,
    "last_seeded_at" timestamp with time zone,
    "last_reset_at" timestamp with time zone,
    "snapshot" "jsonb" DEFAULT '{}'::"jsonb",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."hospital_seed_registry" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."hospital_settings" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "hospital_name" "text",
    "address" "text",
    "phone" "text",
    "email" "text",
    "currency_code" "text" DEFAULT 'UGX'::"text" NOT NULL,
    "tax_rate_percent" numeric DEFAULT 0 NOT NULL,
    "created_at" timestamp with time zone DEFAULT "timezone"('utc'::"text", "now"()) NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "timezone"('utc'::"text", "now"()) NOT NULL,
    "tenant_id" "uuid",
    "created_by" "uuid",
    "is_deleted" boolean DEFAULT false
);


ALTER TABLE "public"."hospital_settings" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."hospitals" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "name" "text" NOT NULL,
    "subdomain" "text" NOT NULL,
    "type" "text" DEFAULT 'general'::"text" NOT NULL,
    "settings" "jsonb",
    "created_at" timestamp with time zone DEFAULT "timezone"('utc'::"text", "now"()) NOT NULL,
    "is_synthetic" boolean DEFAULT false NOT NULL,
    "environment" "text" DEFAULT 'production'::"text" NOT NULL,
    "lifecycle_status" "text" DEFAULT 'active'::"text" NOT NULL,
    "protected_from_billing" boolean DEFAULT false NOT NULL,
    "protected_from_external_reporting" boolean DEFAULT false NOT NULL,
    "facility_kind" "text" DEFAULT 'hospital'::"text" NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "hospitals_environment_check" CHECK (("environment" = ANY (ARRAY['production'::"text", 'staging'::"text", 'demo'::"text", 'development'::"text"]))),
    CONSTRAINT "hospitals_facility_kind_check" CHECK (("facility_kind" = ANY (ARRAY['hospital'::"text", 'health_centre'::"text", 'clinic'::"text", 'pharmacy'::"text", 'laboratory'::"text", 'diagnostic_centre'::"text", 'insurer'::"text"]))),
    CONSTRAINT "hospitals_lifecycle_status_check" CHECK (("lifecycle_status" = ANY (ARRAY['application'::"text", 'approved'::"text", 'onboarding'::"text", 'pilot'::"text", 'active'::"text", 'suspended'::"text", 'offboarded'::"text"]))),
    CONSTRAINT "hospitals_type_check" CHECK (("type" = ANY (ARRAY['national'::"text", 'referral'::"text", 'teaching'::"text", 'general'::"text"])))
);


ALTER TABLE "public"."hospitals" OWNER TO "postgres";


COMMENT ON TABLE "public"."hospitals" IS 'Hospital facility profile (1:1 with tenant id for platform-provisioned hospitals).';



CREATE TABLE IF NOT EXISTS "public"."housekeeping_tasks" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "tenant_id" "uuid" NOT NULL,
    "area" "text" NOT NULL,
    "task_type" "text",
    "task_description" "text",
    "assigned_to" "uuid",
    "scheduled_time" timestamp with time zone,
    "completed" boolean DEFAULT false,
    "completed_at" timestamp with time zone,
    "verified_by" "uuid",
    "verification_notes" "text",
    "notes" "text",
    "created_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."housekeeping_tasks" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."icd11_cache" (
    "stem_code" "text" NOT NULL,
    "title" "text" NOT NULL,
    "foundation_uri" "text" NOT NULL,
    "linearization_uri" "text" NOT NULL,
    "classification" "text" DEFAULT 'ICD-11 MMS'::"text" NOT NULL,
    "release" "text" DEFAULT '2026-01'::"text" NOT NULL,
    "extension_codes" "text"[] DEFAULT '{}'::"text"[] NOT NULL,
    "source" "text" DEFAULT 'seed'::"text" NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."icd11_cache" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."identity_match_candidates" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "person_id" "uuid" NOT NULL,
    "candidate_person_id" "uuid" NOT NULL,
    "confidence" numeric(5,2) NOT NULL,
    "match_signals" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "status" "text" DEFAULT 'pending'::"text" NOT NULL,
    "reviewed_by" "uuid",
    "reviewed_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "identity_match_candidates_confidence_check" CHECK ((("confidence" >= (0)::numeric) AND ("confidence" <= (100)::numeric))),
    CONSTRAINT "identity_match_candidates_status_check" CHECK (("status" = ANY (ARRAY['pending'::"text", 'confirmed_same'::"text", 'confirmed_distinct'::"text", 'merged'::"text", 'dismissed'::"text"]))),
    CONSTRAINT "identity_match_not_self" CHECK (("person_id" <> "candidate_person_id"))
);


ALTER TABLE "public"."identity_match_candidates" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."identity_merge_events" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "surviving_person_id" "uuid" NOT NULL,
    "retired_person_id" "uuid" NOT NULL,
    "actor_id" "uuid",
    "reason" "text",
    "confidence" numeric(5,2),
    "identifiers_retained" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."identity_merge_events" OWNER TO "postgres";


COMMENT ON TABLE "public"."identity_merge_events" IS 'Merge audit. Identifiers of the retired person are retained (status=merged), never discarded.';



CREATE TABLE IF NOT EXISTS "public"."imaging_series" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "study_id" "uuid" NOT NULL,
    "series_uid" "text",
    "series_number" integer,
    "series_description" "text",
    "modality" "text",
    "number_of_images" integer DEFAULT 0 NOT NULL,
    "storage_path" "text",
    "created_at" timestamp with time zone DEFAULT "timezone"('utc'::"text", "now"()) NOT NULL,
    "tenant_id" "uuid",
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "created_by" "uuid",
    "is_deleted" boolean DEFAULT false
);


ALTER TABLE "public"."imaging_series" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."imaging_studies" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "patient_id" "uuid" NOT NULL,
    "encounter_id" "uuid",
    "hospital_id" "uuid",
    "order_id" "uuid",
    "study_uid" "text",
    "accession_number" "text",
    "modality" "text" NOT NULL,
    "body_part" "text",
    "laterality" "text",
    "study_description" "text",
    "study_date" timestamp with time zone DEFAULT "timezone"('utc'::"text", "now"()) NOT NULL,
    "number_of_series" integer DEFAULT 0 NOT NULL,
    "number_of_instances" integer DEFAULT 0 NOT NULL,
    "storage_provider" "text" DEFAULT 'supabase'::"text" NOT NULL,
    "storage_path" "text",
    "thumbnail_path" "text",
    "file_size_bytes" bigint,
    "dicom_json" "jsonb",
    "status" "text" DEFAULT 'uploaded'::"text" NOT NULL,
    "worklist_status" "text" DEFAULT 'pending'::"text" NOT NULL,
    "priority" "text" DEFAULT 'routine'::"text" NOT NULL,
    "is_urgent" boolean DEFAULT false NOT NULL,
    "clinical_indication" "text",
    "metadata" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "created_by" "uuid",
    "created_at" timestamp with time zone DEFAULT "timezone"('utc'::"text", "now"()) NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "timezone"('utc'::"text", "now"()) NOT NULL,
    "tenant_id" "uuid",
    "is_deleted" boolean DEFAULT false,
    CONSTRAINT "imaging_studies_laterality_check" CHECK (("laterality" = ANY (ARRAY['left'::"text", 'right'::"text", 'bilateral'::"text", NULL::"text"]))),
    CONSTRAINT "imaging_studies_modality_check" CHECK (("modality" = ANY (ARRAY['XR'::"text", 'CT'::"text", 'MRI'::"text", 'US'::"text", 'ECHO'::"text", 'NM'::"text", 'PET'::"text", 'MAMMOGRAPHY'::"text", 'FLUOROSCOPY'::"text", 'ANGIO'::"text", 'OTHER'::"text"]))),
    CONSTRAINT "imaging_studies_priority_check" CHECK (("priority" = ANY (ARRAY['stat'::"text", 'urgent'::"text", 'routine'::"text"]))),
    CONSTRAINT "imaging_studies_status_check" CHECK (("status" = ANY (ARRAY['uploading'::"text", 'uploaded'::"text", 'processing'::"text", 'available'::"text", 'error'::"text", 'archived'::"text"]))),
    CONSTRAINT "imaging_studies_storage_provider_check" CHECK (("storage_provider" = ANY (ARRAY['supabase'::"text", 'aws_s3'::"text", 'orthanc'::"text", 'pasteur'::"text", 'other'::"text"]))),
    CONSTRAINT "imaging_studies_worklist_status_check" CHECK (("worklist_status" = ANY (ARRAY['pending'::"text", 'assigned'::"text", 'in_progress'::"text", 'reported'::"text", 'verified'::"text", 'signed_off'::"text"])))
);


ALTER TABLE "public"."imaging_studies" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."imid_access_log" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "imid_code_id" "uuid" NOT NULL,
    "patient_id" "uuid" NOT NULL,
    "accessed_by_ip" "inet",
    "accessed_by_user_agent" "text",
    "access_context" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."imid_access_log" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."imid_codes" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "tenant_id" "uuid",
    "patient_id" "uuid" NOT NULL,
    "code" "text" NOT NULL,
    "qr_data" "text" NOT NULL,
    "is_active" boolean DEFAULT true NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."imid_codes" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."immunization_schedule" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "patient_id" "uuid" NOT NULL,
    "vaccine_name" "text" NOT NULL,
    "vaccine_abbr" "text",
    "loinc_code" "text",
    "due_date" "date" NOT NULL,
    "given_date" "date",
    "status" "text" DEFAULT 'pending'::"text" NOT NULL,
    "site" "text",
    "notes" "text",
    "administered_by" "uuid",
    "created_at" timestamp with time zone DEFAULT "timezone"('utc'::"text", "now"()) NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "timezone"('utc'::"text", "now"()) NOT NULL,
    "tenant_id" "uuid",
    "created_by" "uuid",
    "is_deleted" boolean DEFAULT false,
    CONSTRAINT "immunization_schedule_status_check" CHECK (("status" = ANY (ARRAY['pending'::"text", 'given'::"text", 'missed'::"text", 'contraindicated'::"text"])))
);


ALTER TABLE "public"."immunization_schedule" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."import_batch_rows" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "batch_id" "uuid" NOT NULL,
    "entity" "text" NOT NULL,
    "row_number" integer NOT NULL,
    "source_record" "jsonb" NOT NULL,
    "normalized_record" "jsonb",
    "validation_errors" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "dedupe_key" "text",
    "status" "text" DEFAULT 'staged'::"text" NOT NULL,
    "imported_record_id" "uuid",
    "created_at" timestamp with time zone DEFAULT "timezone"('utc'::"text", "now"()) NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "timezone"('utc'::"text", "now"()) NOT NULL,
    "tenant_id" "uuid",
    "created_by" "uuid",
    "is_deleted" boolean DEFAULT false,
    CONSTRAINT "import_batch_rows_status_check" CHECK (("status" = ANY (ARRAY['staged'::"text", 'validated'::"text", 'rejected'::"text", 'imported'::"text"])))
);


ALTER TABLE "public"."import_batch_rows" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."import_batches" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "hospital_id" "uuid" NOT NULL,
    "created_by" "uuid",
    "source_type" "text" NOT NULL,
    "source_name" "text" NOT NULL,
    "import_scope" "text" DEFAULT 'full'::"text" NOT NULL,
    "status" "text" DEFAULT 'draft'::"text" NOT NULL,
    "total_rows" integer DEFAULT 0 NOT NULL,
    "valid_rows" integer DEFAULT 0 NOT NULL,
    "error_rows" integer DEFAULT 0 NOT NULL,
    "options" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "summary" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "timezone"('utc'::"text", "now"()) NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "timezone"('utc'::"text", "now"()) NOT NULL,
    "started_at" timestamp with time zone,
    "finished_at" timestamp with time zone,
    "tenant_id" "uuid",
    "is_deleted" boolean DEFAULT false,
    CONSTRAINT "import_batches_import_scope_check" CHECK (("import_scope" = ANY (ARRAY['patients_only'::"text", 'encounters_only'::"text", 'orders_only'::"text", 'full'::"text"]))),
    CONSTRAINT "import_batches_source_type_check" CHECK (("source_type" = ANY (ARRAY['csv'::"text", 'xlsx'::"text", 'json'::"text", 'fhir'::"text", 'sql_dump'::"text", 'api'::"text"]))),
    CONSTRAINT "import_batches_status_check" CHECK (("status" = ANY (ARRAY['draft'::"text", 'uploaded'::"text", 'mapping'::"text", 'validating'::"text", 'ready'::"text", 'importing'::"text", 'completed'::"text", 'completed_with_errors'::"text", 'failed'::"text", 'cancelled'::"text"])))
);


ALTER TABLE "public"."import_batches" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."import_column_mappings" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "batch_id" "uuid" NOT NULL,
    "entity" "text" NOT NULL,
    "source_column" "text" NOT NULL,
    "target_column" "text" NOT NULL,
    "transform_rule" "text",
    "is_required" boolean DEFAULT false NOT NULL,
    "created_at" timestamp with time zone DEFAULT "timezone"('utc'::"text", "now"()) NOT NULL,
    "tenant_id" "uuid",
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "created_by" "uuid",
    "is_deleted" boolean DEFAULT false,
    CONSTRAINT "import_column_mappings_entity_check" CHECK (("entity" = ANY (ARRAY['patients'::"text", 'encounters'::"text", 'encounter_diagnoses'::"text", 'encounter_orders'::"text", 'hospital_drug_orders'::"text", 'lab_results'::"text", 'vitals'::"text"])))
);


ALTER TABLE "public"."import_column_mappings" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."insurance_benefits" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "policy_id" "uuid" NOT NULL,
    "tenant_id" "uuid" NOT NULL,
    "benefit_key" "text" NOT NULL,
    "limit_amount" numeric(10,2),
    "used_amount" numeric(10,2) DEFAULT 0 NOT NULL,
    "period" "text" DEFAULT 'annual'::"text" NOT NULL,
    "notes" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."insurance_benefits" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."insurance_claims" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "hospital_id" "uuid" NOT NULL,
    "patient_id" "uuid" NOT NULL,
    "encounter_id" "uuid",
    "invoice_id" "uuid",
    "contract_id" "uuid",
    "insurer_id" "uuid",
    "insurer_name" "text" NOT NULL,
    "claim_number" "text",
    "payer_claim_id" "text",
    "claim_type" "text" DEFAULT 'professional'::"text" NOT NULL,
    "service_from" "date" NOT NULL,
    "service_to" "date" NOT NULL,
    "submitted_at" timestamp with time zone,
    "adjudicated_at" timestamp with time zone,
    "paid_at" timestamp with time zone,
    "billed_amount" numeric(12,2) DEFAULT 0 NOT NULL,
    "allowed_amount" numeric(12,2),
    "paid_amount" numeric(12,2),
    "patient_responsibility" numeric(12,2),
    "adjustment_amount" numeric(12,2),
    "primary_icd11" "text",
    "diagnosis_codes" "text"[] DEFAULT '{}'::"text"[] NOT NULL,
    "procedure_codes" "text"[] DEFAULT '{}'::"text"[] NOT NULL,
    "status" "text" DEFAULT 'draft'::"text" NOT NULL,
    "denial_code" "text",
    "denial_reason" "text",
    "appeal_deadline" "date",
    "resubmission_count" integer DEFAULT 0 NOT NULL,
    "prior_auth_number" "text",
    "version" integer DEFAULT 1 NOT NULL,
    "metadata" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "submitted_by" "uuid",
    "created_at" timestamp with time zone DEFAULT "timezone"('utc'::"text", "now"()) NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "timezone"('utc'::"text", "now"()) NOT NULL,
    "tenant_id" "uuid",
    "created_by" "uuid",
    "is_deleted" boolean DEFAULT false,
    CONSTRAINT "insurance_claims_claim_type_check" CHECK (("claim_type" = ANY (ARRAY['professional'::"text", 'institutional'::"text", 'dental'::"text", 'pharmacy'::"text"]))),
    CONSTRAINT "insurance_claims_status_check" CHECK (("status" = ANY (ARRAY['draft'::"text", 'ready'::"text", 'submitted'::"text", 'acknowledged'::"text", 'adjudicated'::"text", 'paid'::"text", 'denied'::"text", 'appealed'::"text", 'written_off'::"text", 'void'::"text"])))
);


ALTER TABLE "public"."insurance_claims" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."insurance_copilot_audit" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "tenant_id" "uuid" NOT NULL,
    "actor_id" "uuid",
    "action" "text" NOT NULL,
    "patient_id" "uuid",
    "resource_id" "uuid",
    "input" "jsonb",
    "output" "jsonb",
    "ai_model" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."insurance_copilot_audit" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."insurance_coverage_checks" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "tenant_id" "uuid" NOT NULL,
    "policy_id" "uuid",
    "patient_id" "uuid",
    "encounter_id" "uuid",
    "checked_by" "uuid" NOT NULL,
    "check_type" "text" DEFAULT 'eligibility'::"text" NOT NULL,
    "service_code" "text",
    "covered" boolean,
    "copay_amount" numeric(10,2),
    "benefit_limit" numeric(10,2),
    "benefit_used" numeric(10,2),
    "notes" "text",
    "raw_response" "jsonb",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."insurance_coverage_checks" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."insurance_memberships" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "person_id" "uuid" NOT NULL,
    "payer_id" "uuid",
    "payer_name" "text" NOT NULL,
    "member_number" "text" NOT NULL,
    "policy_number" "text",
    "scheme" "text",
    "employer" "text",
    "beneficiary_type" "text" DEFAULT 'primary'::"text",
    "effective_date" "date",
    "expiry_date" "date",
    "status" "text" DEFAULT 'active'::"text" NOT NULL,
    "issuing_facility_id" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "insurance_memberships_beneficiary_type_check" CHECK (("beneficiary_type" = ANY (ARRAY['primary'::"text", 'dependant'::"text", 'spouse'::"text", 'child'::"text", 'other'::"text"]))),
    CONSTRAINT "insurance_memberships_status_check" CHECK (("status" = ANY (ARRAY['active'::"text", 'expired'::"text", 'suspended'::"text", 'cancelled'::"text"])))
);


ALTER TABLE "public"."insurance_memberships" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."insurance_policies" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "tenant_id" "uuid" NOT NULL,
    "patient_id" "uuid",
    "payer_id" "uuid",
    "policy_number" "text" NOT NULL,
    "member_id" "text",
    "group_number" "text",
    "holder_name" "text",
    "holder_dob" "date",
    "effective_date" "date",
    "expiry_date" "date",
    "plan_name" "text",
    "coverage_type" "text" DEFAULT 'inpatient'::"text" NOT NULL,
    "copay_amount" numeric(10,2),
    "deductible" numeric(10,2),
    "max_benefit" numeric(10,2),
    "status" "text" DEFAULT 'active'::"text" NOT NULL,
    "verified_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."insurance_policies" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."insurance_preauthorizations" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "tenant_id" "uuid" NOT NULL,
    "policy_id" "uuid",
    "patient_id" "uuid",
    "encounter_id" "uuid",
    "requested_by" "uuid" NOT NULL,
    "payer_id" "uuid",
    "auth_type" "text" DEFAULT 'inpatient'::"text" NOT NULL,
    "diagnosis_codes" "text"[],
    "procedure_codes" "text"[],
    "estimated_cost" numeric(10,2),
    "clinical_notes" "text",
    "status" "text" DEFAULT 'draft'::"text" NOT NULL,
    "auth_number" "text",
    "approved_amount" numeric(10,2),
    "payer_notes" "text",
    "submitted_at" timestamp with time zone,
    "expires_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "preauth_no_auto_submit" CHECK ((("status" <> 'submitted'::"text") OR ("submitted_at" IS NOT NULL)))
);


ALTER TABLE "public"."insurance_preauthorizations" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."insurance_providers" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "tenant_id" "uuid" NOT NULL,
    "name" "text" NOT NULL,
    "code" "text" NOT NULL,
    "website" "text",
    "phone" "text",
    "email" "text",
    "api_endpoint" "text",
    "api_key_encrypted" "text",
    "is_active" boolean DEFAULT true NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."insurance_providers" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."intelligence_actions" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "tenant_id" "uuid" NOT NULL,
    "recommendation_id" "uuid",
    "clinician_id" "uuid" NOT NULL,
    "decision" "text" NOT NULL,
    "reason" "text",
    "modified_text" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "intelligence_actions_decision_check" CHECK (("decision" = ANY (ARRAY['ACCEPT'::"text", 'MODIFY'::"text", 'REJECT'::"text", 'DEFER'::"text"])))
);


ALTER TABLE "public"."intelligence_actions" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."intelligence_recommendations" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "tenant_id" "uuid" NOT NULL,
    "encounter_id" "uuid",
    "patient_id" "uuid",
    "clinician_id" "uuid",
    "task" "text" NOT NULL,
    "recommendation" "text" NOT NULL,
    "reasoning_summary" "text",
    "proposed_terms" "text"[] DEFAULT '{}'::"text"[] NOT NULL,
    "suggested_pathway_id" "text",
    "confidence" numeric,
    "cannot_miss" boolean DEFAULT false NOT NULL,
    "provenance" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "model" "text",
    "prompt_version" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."intelligence_recommendations" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."interop_connections" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "tenant_id" "uuid" NOT NULL,
    "adapter_type" "text" NOT NULL,
    "display_name" "text" NOT NULL,
    "endpoint_url" "text",
    "credential_ref" "text",
    "mapping" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "is_active" boolean DEFAULT true NOT NULL,
    "last_success_at" timestamp with time zone,
    "last_error" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "interop_connections_adapter_type_check" CHECK (("adapter_type" = ANY (ARRAY['fhir'::"text", 'hl7v2'::"text", 'astm'::"text", 'openmrs'::"text", 'ugandaemr'::"text", 'lis'::"text", 'rest'::"text", 'webhook'::"text", 'other'::"text"])))
);


ALTER TABLE "public"."interop_connections" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."interop_messages" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "connection_id" "uuid",
    "tenant_id" "uuid" NOT NULL,
    "direction" "text" NOT NULL,
    "protocol" "text" NOT NULL,
    "message_type" "text",
    "external_id" "text",
    "payload" "jsonb",
    "raw_payload" "text",
    "validation_status" "text" DEFAULT 'received'::"text" NOT NULL,
    "person_id" "uuid",
    "idempotency_key" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "interop_messages_direction_check" CHECK (("direction" = ANY (ARRAY['inbound'::"text", 'outbound'::"text"]))),
    CONSTRAINT "interop_messages_validation_status_check" CHECK (("validation_status" = ANY (ARRAY['received'::"text", 'valid'::"text", 'invalid'::"text", 'transformed'::"text", 'applied'::"text", 'rejected'::"text"])))
);


ALTER TABLE "public"."interop_messages" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."inventory_items" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "generic_name" "text" NOT NULL,
    "brand_name" "text",
    "atc_code" "text",
    "form" "text" NOT NULL,
    "strength" "text",
    "unit_of_measure" "text" NOT NULL,
    "reorder_level" numeric DEFAULT 0 NOT NULL,
    "unit_price" numeric DEFAULT 0 NOT NULL,
    "currency" "text" DEFAULT 'UGX'::"text" NOT NULL,
    "is_active" boolean DEFAULT true NOT NULL,
    "created_at" timestamp with time zone DEFAULT "timezone"('utc'::"text", "now"()) NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "timezone"('utc'::"text", "now"()) NOT NULL,
    "tenant_id" "uuid",
    "created_by" "uuid",
    "is_deleted" boolean DEFAULT false
);


ALTER TABLE "public"."inventory_items" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."lab_accession_counters" (
    "tenant_id" "uuid" NOT NULL,
    "facility_code" "text" NOT NULL,
    "day_key" "text" NOT NULL,
    "last_value" integer DEFAULT 0 NOT NULL
);


ALTER TABLE "public"."lab_accession_counters" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."lab_analyzer_messages" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "tenant_id" "uuid" NOT NULL,
    "analyzer_id" "text",
    "protocol" "text" DEFAULT 'hl7'::"text" NOT NULL,
    "accession_number" "text",
    "raw_message" "text" NOT NULL,
    "parsed" "jsonb",
    "direction" "text" DEFAULT 'inbound'::"text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "lab_analyzer_messages_direction_check" CHECK (("direction" = ANY (ARRAY['inbound'::"text", 'outbound'::"text"]))),
    CONSTRAINT "lab_analyzer_messages_protocol_check" CHECK (("protocol" = ANY (ARRAY['hl7'::"text", 'astm'::"text", 'tcp'::"text", 'serial'::"text", 'middleware'::"text", 'other'::"text"])))
);


ALTER TABLE "public"."lab_analyzer_messages" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."lab_critical_acknowledgements" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "tenant_id" "uuid" NOT NULL,
    "result_id" "uuid" NOT NULL,
    "lab_order_id" "uuid",
    "patient_id" "uuid",
    "acknowledged_by" "uuid" NOT NULL,
    "acknowledged_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "note" "text",
    "is_synthetic" boolean DEFAULT false NOT NULL
);


ALTER TABLE "public"."lab_critical_acknowledgements" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."lab_device_messages" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "tenant_id" "uuid" NOT NULL,
    "device_id" "uuid",
    "direction" "text" DEFAULT 'inbound'::"text" NOT NULL,
    "protocol" "text" NOT NULL,
    "received_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "raw_payload" "text" NOT NULL,
    "payload_hash" "text" NOT NULL,
    "message_control_id" "text",
    "parse_status" "text" DEFAULT 'RAW'::"text" NOT NULL,
    "processing_status" "text" DEFAULT 'RECEIVED'::"text" NOT NULL,
    "error_code" "text",
    "correlation_id" "text",
    "parsed" "jsonb",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."lab_device_messages" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."lab_device_test_mappings" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "tenant_id" "uuid" NOT NULL,
    "device_id" "uuid" NOT NULL,
    "analyzer_code" "text" NOT NULL,
    "analyzer_name" "text",
    "catalog_test_id" "text",
    "component_id" "text",
    "loinc_code" "text",
    "unit" "text",
    "conversion_factor" numeric DEFAULT 1 NOT NULL,
    "conversion_offset" numeric DEFAULT 0 NOT NULL,
    "active" boolean DEFAULT true NOT NULL,
    "approved_by" "uuid",
    "approved_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."lab_device_test_mappings" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."lab_devices" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "tenant_id" "uuid" NOT NULL,
    "facility_id" "uuid",
    "name" "text" NOT NULL,
    "manufacturer" "text",
    "model" "text",
    "serial_number" "text",
    "device_type" "text" DEFAULT 'analyzer'::"text" NOT NULL,
    "discipline" "text",
    "connection_type" "text" DEFAULT 'MANUAL'::"text" NOT NULL,
    "protocol" "text" DEFAULT 'NONE'::"text" NOT NULL,
    "host" "text",
    "port" integer,
    "serial_port" "text",
    "baud_rate" integer,
    "data_bits" integer,
    "stop_bits" integer,
    "parity" "text",
    "flow_control" "text",
    "mode" "text" DEFAULT 'UNIDIRECTIONAL'::"text" NOT NULL,
    "driver" "text",
    "active" boolean DEFAULT false NOT NULL,
    "validation_status" "text" DEFAULT 'CONFIGURED'::"text" NOT NULL,
    "last_seen_at" timestamp with time zone,
    "last_message_at" timestamp with time zone,
    "health_status" "text" DEFAULT 'unknown'::"text" NOT NULL,
    "configuration" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "capabilities" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."lab_devices" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."lab_instrument_bridges" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "tenant_id" "uuid" NOT NULL,
    "name" "text" NOT NULL,
    "instrument_type" "text",
    "connection_type" "text",
    "connection_config" "jsonb",
    "api_key" "text" NOT NULL,
    "is_active" boolean DEFAULT true NOT NULL,
    "last_seen_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "lab_instrument_bridges_connection_type_check" CHECK (("connection_type" = ANY (ARRAY['serial'::"text", 'tcp'::"text", 'file'::"text", 'hl7_mllp'::"text"])))
);


ALTER TABLE "public"."lab_instrument_bridges" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."lab_orders" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "tenant_id" "uuid" NOT NULL,
    "encounter_id" "uuid" NOT NULL,
    "patient_id" "uuid" NOT NULL,
    "loinc_code" "text",
    "test_name" "text" NOT NULL,
    "urgency" "text" DEFAULT 'ROUTINE'::"text" NOT NULL,
    "status" "text" DEFAULT 'ordered'::"text" NOT NULL,
    "ordered_by" "uuid" NOT NULL,
    "ordered_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "collected_at" timestamp with time zone,
    "resulted_at" timestamp with time zone,
    "verified_at" timestamp with time zone,
    "verified_by" "uuid",
    "insurance_covered" boolean DEFAULT false NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "person_id" "uuid",
    "workflow_status" "text",
    "accession_number" "text",
    "barcode" "text",
    "specimen_id" "uuid",
    "rejection_reason" "text",
    "rejection_note" "text",
    "correlation_id" "uuid",
    "care_plan_id" "uuid",
    "is_synthetic" boolean DEFAULT false NOT NULL,
    "simulation_run_id" "uuid",
    "data_classification" "text",
    "replaces_lab_order_id" "uuid",
    CONSTRAINT "lab_orders_data_classification_check" CHECK ((("data_classification" IS NULL) OR ("data_classification" = ANY (ARRAY['clinical'::"text", 'synthetic'::"text", 'operational'::"text"])))),
    CONSTRAINT "lab_orders_status_check" CHECK (("status" = ANY (ARRAY['ordered'::"text", 'collected'::"text", 'processing'::"text", 'resulted'::"text", 'verified'::"text", 'cancelled'::"text"]))),
    CONSTRAINT "lab_orders_urgency_check" CHECK (("urgency" = ANY (ARRAY['STAT'::"text", 'URGENT'::"text", 'ROUTINE'::"text"])))
);


ALTER TABLE "public"."lab_orders" OWNER TO "postgres";


COMMENT ON COLUMN "public"."lab_orders"."replaces_lab_order_id" IS 'Prior rejected lab order this order recollects; preserves original specimen history.';



CREATE TABLE IF NOT EXISTS "public"."lab_reference_ranges" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "loinc_code" "text" NOT NULL,
    "test_name" "text" NOT NULL,
    "unit" "text" NOT NULL,
    "sex" "text",
    "age_min_years" numeric,
    "age_max_years" numeric,
    "low" numeric NOT NULL,
    "high" numeric NOT NULL,
    "critical_low" numeric,
    "critical_high" numeric,
    "country_pack" "text" DEFAULT 'UG'::"text" NOT NULL
);


ALTER TABLE "public"."lab_reference_ranges" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."lab_reports" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "tenant_id" "uuid" NOT NULL,
    "facility_id" "uuid",
    "patient_id" "uuid" NOT NULL,
    "encounter_id" "uuid",
    "lab_order_id" "uuid" NOT NULL,
    "clinical_result_id" "uuid" NOT NULL,
    "accession" "text" NOT NULL,
    "status" "text" NOT NULL,
    "version" integer DEFAULT 1 NOT NULL,
    "report_type" "text" DEFAULT 'LAB_RESULT'::"text" NOT NULL,
    "generated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "generated_by" "uuid",
    "verified_by" "uuid",
    "released_at" timestamp with time zone NOT NULL,
    "supersedes_report_id" "uuid",
    "amendment_reason" "text",
    "template_version" "text" DEFAULT 'lab-report.v1'::"text" NOT NULL,
    "html_snapshot" "text" NOT NULL,
    "artifact_path" "text",
    "content_hash" "text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "lab_reports_status_check" CHECK (("status" = ANY (ARRAY['FINAL'::"text", 'AMENDED'::"text"]))),
    CONSTRAINT "lab_reports_version_check" CHECK (("version" > 0))
);


ALTER TABLE "public"."lab_reports" OWNER TO "postgres";


COMMENT ON TABLE "public"."lab_reports" IS 'Immutable printable Lab report versions. Release is not delivery; artifacts require tenant-authorized access.';



CREATE TABLE IF NOT EXISTS "public"."lab_result_amendments" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "tenant_id" "uuid" NOT NULL,
    "result_id" "uuid" NOT NULL,
    "lab_order_id" "uuid",
    "previous_value" "text" NOT NULL,
    "previous_status" "text" NOT NULL,
    "new_value" "text" NOT NULL,
    "reason" "text" NOT NULL,
    "amended_by" "uuid",
    "amended_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "is_synthetic" boolean DEFAULT false NOT NULL
);


ALTER TABLE "public"."lab_result_amendments" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."lab_result_staging" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "tenant_id" "uuid" NOT NULL,
    "device_id" "uuid",
    "device_message_id" "uuid",
    "lab_order_id" "uuid",
    "specimen_id" "uuid",
    "accession_number" "text",
    "analyzer_code" "text",
    "mapped_loinc" "text",
    "mapped_test_name" "text",
    "value" "text",
    "unit" "text",
    "flags" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "instrument_flags" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "run_at" timestamp with time zone,
    "status" "text" DEFAULT 'RECEIVED'::"text" NOT NULL,
    "correlation_id" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."lab_result_staging" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."lab_results" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "encounter_id" "uuid" NOT NULL,
    "lab_technician_id" "uuid",
    "loinc_code" "text",
    "code" "text",
    "test_name" "text" NOT NULL,
    "value" "text" NOT NULL,
    "unit" "text",
    "reference_range" "text",
    "flag" "text",
    "notes" "text",
    "created_at" timestamp with time zone DEFAULT "timezone"('utc'::"text", "now"()) NOT NULL,
    "tenant_id" "uuid" NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "created_by" "uuid",
    "is_deleted" boolean DEFAULT false,
    "numeric_value" numeric,
    "abnormal_flag" "text",
    "analyzer" "text",
    "verified_by" "uuid",
    "verified_at" timestamp with time zone,
    "provenance" "text",
    "is_synthetic" boolean DEFAULT false NOT NULL,
    "simulation_run_id" "uuid",
    "result_source" "text",
    "entered_by" "uuid",
    "entered_at" timestamp with time zone DEFAULT "now"(),
    "lab_order_id" "uuid" NOT NULL,
    "patient_id" "uuid" NOT NULL,
    "result_value" "text",
    "status" "text" DEFAULT 'preliminary'::"text" NOT NULL,
    "is_critical" boolean DEFAULT false NOT NULL,
    "is_abnormal" boolean DEFAULT false NOT NULL,
    "version" integer DEFAULT 1 NOT NULL,
    "released_to_patient_at" timestamp with time zone,
    CONSTRAINT "lab_results_status_check" CHECK (("status" = ANY (ARRAY['preliminary'::"text", 'final'::"text", 'corrected'::"text", 'cancelled'::"text"])))
);


ALTER TABLE "public"."lab_results" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."lab_specimens" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "tenant_id" "uuid" NOT NULL,
    "person_id" "uuid",
    "patient_id" "uuid",
    "encounter_id" "uuid",
    "lab_order_id" "uuid",
    "accession_number" "text" NOT NULL,
    "barcode" "text",
    "specimen_type" "text",
    "status" "text" DEFAULT 'collected'::"text" NOT NULL,
    "collected_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "collected_by" "uuid",
    "container" "text",
    "volume_ml" numeric,
    "condition" "text",
    "received_at" timestamp with time zone,
    "parent_specimen_id" "uuid",
    "storage_location" "text",
    CONSTRAINT "lab_specimens_status_check" CHECK (("status" = ANY (ARRAY['ordered'::"text", 'collected'::"text", 'in_lab'::"text", 'on_analyzer'::"text", 'resulted'::"text", 'verified'::"text", 'rejected'::"text", 'disposed'::"text"])))
);


ALTER TABLE "public"."lab_specimens" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."live_feed_sessions" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "synapse_id" "text" NOT NULL,
    "patient_id" "uuid",
    "encounter_id" "uuid",
    "hospital_id" "uuid",
    "tenant_id" "uuid",
    "status" "text" DEFAULT 'active'::"text",
    "started_at" timestamp with time zone DEFAULT "now"(),
    "ended_at" timestamp with time zone,
    "last_ping" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."live_feed_sessions" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."loinc_reference" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "loinc_code" "text" NOT NULL,
    "display_name" "text" NOT NULL,
    "category" "text",
    "specimen" "text",
    "unit" "text",
    "metadata" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "timezone"('utc'::"text", "now"()) NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "timezone"('utc'::"text", "now"()) NOT NULL,
    "tenant_id" "uuid",
    "created_by" "uuid",
    "is_deleted" boolean DEFAULT false
);


ALTER TABLE "public"."loinc_reference" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."maternity_records" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "patient_id" "uuid" NOT NULL,
    "encounter_id" "uuid",
    "gravida" integer,
    "parity" integer,
    "gestational_age_weeks" numeric,
    "risk_flags" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "plan" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "notes" "text",
    "created_at" timestamp with time zone DEFAULT "timezone"('utc'::"text", "now"()) NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "timezone"('utc'::"text", "now"()) NOT NULL,
    "tenant_id" "uuid",
    "created_by" "uuid",
    "is_deleted" boolean DEFAULT false
);


ALTER TABLE "public"."maternity_records" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."medical_devices" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "hospital_id" "uuid" NOT NULL,
    "department_id" "uuid",
    "device_type" "text" NOT NULL,
    "name" "text" NOT NULL,
    "model" "text",
    "serial_number" "text",
    "manufacturer" "text",
    "firmware_version" "text",
    "mac_address" "macaddr",
    "ip_address" "inet",
    "status" "text" DEFAULT 'online'::"text" NOT NULL,
    "last_seen_at" timestamp with time zone,
    "location_tag" "text",
    "bed_id" "uuid",
    "calibration_due" "date",
    "metadata" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "timezone"('utc'::"text", "now"()) NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "timezone"('utc'::"text", "now"()) NOT NULL,
    "tenant_id" "uuid",
    "created_by" "uuid",
    "is_deleted" boolean DEFAULT false,
    CONSTRAINT "medical_devices_device_type_check" CHECK (("device_type" = ANY (ARRAY['vitals_monitor'::"text", 'ecg'::"text", 'pulse_oximeter'::"text", 'glucometer'::"text", 'lab_analyzer'::"text", 'ventilator'::"text", 'infusion_pump'::"text", 'barcode_scanner'::"text", 'rfid_reader'::"text", 'iot_sensor'::"text", 'other'::"text"]))),
    CONSTRAINT "medical_devices_status_check" CHECK (("status" = ANY (ARRAY['online'::"text", 'offline'::"text", 'maintenance'::"text", 'decommissioned'::"text", 'error'::"text"])))
);


ALTER TABLE "public"."medical_devices" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."medication_safety_checks" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "patient_id" "uuid" NOT NULL,
    "encounter_id" "uuid",
    "hospital_id" "uuid",
    "checked_at" timestamp with time zone DEFAULT "timezone"('utc'::"text", "now"()) NOT NULL,
    "drug_orders" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "alerts_raised" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "alert_count" integer DEFAULT 0 NOT NULL,
    "was_overridden" boolean DEFAULT false NOT NULL,
    "override_by" "uuid",
    "override_reason" "text",
    "pharmacist_id" "uuid",
    "created_at" timestamp with time zone DEFAULT "timezone"('utc'::"text", "now"()) NOT NULL,
    "tenant_id" "uuid",
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "created_by" "uuid",
    "is_deleted" boolean DEFAULT false
);


ALTER TABLE "public"."medication_safety_checks" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."menstrual_cycles" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "cycle_start" "date" NOT NULL,
    "cycle_end" "date",
    "period_start" "date" NOT NULL,
    "period_end" "date",
    "flow_intensity" "text",
    "symptoms" "text"[],
    "notes" "text",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    CONSTRAINT "menstrual_cycles_flow_intensity_check" CHECK (("flow_intensity" = ANY (ARRAY['spotting'::"text", 'light'::"text", 'medium'::"text", 'heavy'::"text"])))
);


ALTER TABLE "public"."menstrual_cycles" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."mfa_enrollments" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid",
    "secret" "text" NOT NULL,
    "verified" boolean DEFAULT false,
    "backup_codes" "text"[],
    "created_at" timestamp with time zone DEFAULT "now"(),
    "last_used_at" timestamp with time zone
);


ALTER TABLE "public"."mfa_enrollments" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."mfa_step_up_replays" (
    "enrollment_id" "uuid" NOT NULL,
    "time_step" bigint NOT NULL,
    "session_id" "uuid" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."mfa_step_up_replays" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."mobile_push_tokens" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "tenant_id" "uuid",
    "device_id" "text" NOT NULL,
    "token" "text" NOT NULL,
    "role" "text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."mobile_push_tokens" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."newsletter_subscribers" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "email" "text" NOT NULL,
    "source" "text",
    "subscribed" boolean DEFAULT true NOT NULL,
    "subscribed_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "unsubscribed_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."newsletter_subscribers" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."nin_access_log" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "hospital_id" "uuid" NOT NULL,
    "accessed_by" "uuid" NOT NULL,
    "action" "text" NOT NULL,
    "result" "text",
    "ip_address" "text",
    "created_at" timestamp with time zone DEFAULT "timezone"('utc'::"text", "now"()) NOT NULL,
    "tenant_id" "uuid",
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "created_by" "uuid",
    "is_deleted" boolean DEFAULT false,
    CONSTRAINT "nin_access_log_action_check" CHECK (("action" = ANY (ARRAY['nin_linked'::"text", 'nin_updated'::"text", 'dedup_check'::"text", 'nin_read'::"text"])))
);


ALTER TABLE "public"."nin_access_log" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."notifications" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "title" "text" NOT NULL,
    "message" "text" NOT NULL,
    "priority" "text" DEFAULT 'normal'::"text" NOT NULL,
    "is_read" boolean DEFAULT false NOT NULL,
    "metadata" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "timezone"('utc'::"text", "now"()) NOT NULL,
    "tenant_id" "uuid",
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "created_by" "uuid",
    "is_deleted" boolean DEFAULT false,
    CONSTRAINT "notifications_priority_check" CHECK (("priority" = ANY (ARRAY['low'::"text", 'normal'::"text", 'high'::"text", 'critical'::"text"])))
);


ALTER TABLE "public"."notifications" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."offline_mutation_outbox" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "tenant_id" "uuid" NOT NULL,
    "site_id" "uuid",
    "actor_id" "uuid",
    "mutation_type" "text" NOT NULL,
    "idempotency_key" "text" NOT NULL,
    "payload" "jsonb" NOT NULL,
    "status" "text" DEFAULT 'queued'::"text" NOT NULL,
    "client_device_id" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "applied_at" timestamp with time zone,
    "conflict_reason" "text",
    CONSTRAINT "offline_mutation_outbox_status_check" CHECK (("status" = ANY (ARRAY['queued'::"text", 'syncing'::"text", 'applied'::"text", 'conflict'::"text", 'rejected'::"text"])))
);


ALTER TABLE "public"."offline_mutation_outbox" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."offline_sync_queue" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "tenant_id" "uuid" NOT NULL,
    "user_id" "uuid" NOT NULL,
    "resource_type" "text" NOT NULL,
    "resource_id" "uuid",
    "operation" "text" NOT NULL,
    "payload" "jsonb" NOT NULL,
    "synced_at" timestamp with time zone,
    "conflict_detected" boolean DEFAULT false NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "offline_sync_queue_operation_check" CHECK (("operation" = ANY (ARRAY['insert'::"text", 'update'::"text", 'delete'::"text"])))
);


ALTER TABLE "public"."offline_sync_queue" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."order_items" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "order_id" "uuid",
    "product_id" "uuid",
    "quantity" integer NOT NULL,
    "price_at_time" numeric NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "tenant_id" "uuid",
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "created_by" "uuid",
    "is_deleted" boolean DEFAULT false,
    CONSTRAINT "order_items_quantity_check" CHECK (("quantity" > 0))
);


ALTER TABLE "public"."order_items" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."order_mappings" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "icd_code" "text" NOT NULL,
    "loinc_codes" "text"[],
    "atc_codes" "text"[],
    "created_at" timestamp with time zone DEFAULT "timezone"('utc'::"text", "now"()) NOT NULL,
    "tenant_id" "uuid",
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "created_by" "uuid",
    "is_deleted" boolean DEFAULT false
);


ALTER TABLE "public"."order_mappings" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."orders" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "customer_id" "uuid",
    "restaurant_id" "uuid",
    "status" "text" DEFAULT 'Pending'::"text",
    "total_amount" numeric NOT NULL,
    "delivery_fee" numeric DEFAULT 2000,
    "delivery_address" "text" NOT NULL,
    "lat" numeric,
    "lng" numeric,
    "rider_token" "uuid" DEFAULT "gen_random_uuid"(),
    "created_at" timestamp with time zone DEFAULT "now"(),
    "tenant_id" "uuid",
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "created_by" "uuid",
    "is_deleted" boolean DEFAULT false
);


ALTER TABLE "public"."orders" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."organizations" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "name" "text" NOT NULL,
    "slug" "text" NOT NULL,
    "org_type" "text" DEFAULT 'hospital'::"text" NOT NULL,
    "country_code" "text" DEFAULT 'UG'::"text" NOT NULL,
    "region" "text",
    "district" "text",
    "phone" "text",
    "email" "text",
    "is_active" boolean DEFAULT true NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "organizations_org_type_check" CHECK (("org_type" = ANY (ARRAY['hospital'::"text", 'pharmacy_chain'::"text", 'laboratory'::"text", 'blood_bank'::"text", 'insurance'::"text", 'community'::"text", 'mixed'::"text"])))
);


ALTER TABLE "public"."organizations" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."outbreak_alerts" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "created_by_tenant_id" "uuid",
    "icd11_code" "text" NOT NULL,
    "disease_name" "text" NOT NULL,
    "alert_level" "text" DEFAULT 'INFO'::"text" NOT NULL,
    "affected_districts" "text"[] DEFAULT '{}'::"text"[] NOT NULL,
    "description" "text" NOT NULL,
    "recommendations" "text" NOT NULL,
    "is_active" boolean DEFAULT true NOT NULL,
    "expires_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "outbreak_alerts_alert_level_check" CHECK (("alert_level" = ANY (ARRAY['INFO'::"text", 'WATCH'::"text", 'WARNING'::"text", 'EMERGENCY'::"text"])))
);


ALTER TABLE "public"."outbreak_alerts" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."outreach_campaigns" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "hospital_id" "uuid" NOT NULL,
    "name" "text" NOT NULL,
    "campaign_type" "text" NOT NULL,
    "target_district" "text",
    "target_sub_county" "text",
    "target_age_from" integer,
    "target_age_to" integer,
    "target_gender" "text",
    "target_count" integer,
    "reached_count" integer DEFAULT 0 NOT NULL,
    "start_date" "date" NOT NULL,
    "end_date" "date",
    "status" "text" DEFAULT 'planned'::"text" NOT NULL,
    "budget" numeric(12,2),
    "notes" "text",
    "created_by" "uuid",
    "created_at" timestamp with time zone DEFAULT "timezone"('utc'::"text", "now"()) NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "timezone"('utc'::"text", "now"()) NOT NULL,
    "tenant_id" "uuid",
    "is_deleted" boolean DEFAULT false,
    CONSTRAINT "outreach_campaigns_campaign_type_check" CHECK (("campaign_type" = ANY (ARRAY['immunization'::"text", 'anc_screening'::"text", 'family_planning'::"text", 'malaria_net'::"text", 'deworming'::"text", 'nutrition'::"text", 'tb_screening'::"text", 'hiv_testing'::"text", 'health_education'::"text", 'other'::"text"]))),
    CONSTRAINT "outreach_campaigns_status_check" CHECK (("status" = ANY (ARRAY['planned'::"text", 'active'::"text", 'paused'::"text", 'completed'::"text", 'cancelled'::"text"]))),
    CONSTRAINT "outreach_campaigns_target_gender_check" CHECK (("target_gender" = ANY (ARRAY['M'::"text", 'F'::"text", 'all'::"text", NULL::"text"])))
);


ALTER TABLE "public"."outreach_campaigns" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."partograph_records" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "tenant_id" "uuid" NOT NULL,
    "patient_id" "uuid" NOT NULL,
    "admission_time" timestamp with time zone,
    "entries" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "delivery_time" timestamp with time zone,
    "delivery_type" "text",
    "birth_weight_grams" numeric,
    "apgar_1min" integer,
    "apgar_5min" integer,
    "complications" "text",
    "midwife_id" "uuid",
    "doctor_id" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."partograph_records" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."passport_access_log" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "synapse_id" "text" NOT NULL,
    "accessed_by_user_id" "uuid",
    "accessed_by_hospital_id" "uuid",
    "access_type" "text",
    "share_token" "text",
    "created_at" timestamp with time zone DEFAULT "now"(),
    CONSTRAINT "passport_access_log_access_type_check" CHECK (("access_type" = ANY (ARRAY['self'::"text", 'qr_scan'::"text", 'share_code'::"text", 'direct_transfer'::"text", 'emergency'::"text"])))
);


ALTER TABLE "public"."passport_access_log" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."passport_share_tokens" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "synapse_id" "text" NOT NULL,
    "token" "text" DEFAULT "upper"(SUBSTRING("replace"("replace"("encode"("extensions"."gen_random_bytes"(3), 'base64'::"text"), '+'::"text", 'A'::"text"), '/'::"text", 'B'::"text") FROM 1 FOR 6)) NOT NULL,
    "token_type" "text",
    "granted_to_hospital_id" "uuid",
    "scope" "text"[] DEFAULT ARRAY['basic'::"text", 'visits'::"text", 'medications'::"text", 'allergies'::"text"],
    "max_uses" integer DEFAULT 1,
    "use_count" integer DEFAULT 0,
    "expires_at" timestamp with time zone DEFAULT ("now"() + '24:00:00'::interval),
    "is_revoked" boolean DEFAULT false,
    "created_by" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"(),
    CONSTRAINT "passport_share_tokens_token_type_check" CHECK (("token_type" = ANY (ARRAY['qr'::"text", 'code'::"text", 'transfer'::"text"])))
);


ALTER TABLE "public"."passport_share_tokens" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."password_reset_tokens" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "token_hash" "text" NOT NULL,
    "expires_at" timestamp with time zone NOT NULL,
    "used_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."password_reset_tokens" OWNER TO "postgres";


COMMENT ON TABLE "public"."password_reset_tokens" IS 'One-time custom auth password reset tokens. Only service-role server code may read or mutate rows.';



CREATE TABLE IF NOT EXISTS "public"."pathway_alerts" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "pathway_id" "uuid" NOT NULL,
    "patient_id" "uuid" NOT NULL,
    "hospital_id" "uuid",
    "rule_name" "text" NOT NULL,
    "severity" "text" DEFAULT 'high'::"text" NOT NULL,
    "message" "text" NOT NULL,
    "status" "text" DEFAULT 'active'::"text" NOT NULL,
    "triggered_at" timestamp with time zone DEFAULT "timezone"('utc'::"text", "now"()) NOT NULL,
    "resolved_at" timestamp with time zone,
    "resolved_by" "uuid",
    "metadata" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "tenant_id" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "created_by" "uuid",
    "is_deleted" boolean DEFAULT false,
    CONSTRAINT "pathway_alerts_severity_check" CHECK (("severity" = ANY (ARRAY['info'::"text", 'warning'::"text", 'high'::"text", 'critical'::"text"]))),
    CONSTRAINT "pathway_alerts_status_check" CHECK (("status" = ANY (ARRAY['active'::"text", 'acknowledged'::"text", 'resolved'::"text", 'auto_resolved'::"text"])))
);


ALTER TABLE "public"."pathway_alerts" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."pathway_checklist_items" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "pathway_id" "uuid" NOT NULL,
    "step_order" integer NOT NULL,
    "title" "text" NOT NULL,
    "item_type" "text" DEFAULT 'task'::"text" NOT NULL,
    "status" "text" DEFAULT 'pending'::"text" NOT NULL,
    "completed_by" "uuid",
    "completed_at" timestamp with time zone,
    "skipped_reason" "text",
    "notes" "text",
    "metadata" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "timezone"('utc'::"text", "now"()) NOT NULL,
    "tenant_id" "uuid",
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "created_by" "uuid",
    "is_deleted" boolean DEFAULT false,
    CONSTRAINT "pathway_checklist_items_item_type_check" CHECK (("item_type" = ANY (ARRAY['task'::"text", 'order'::"text", 'alert'::"text", 'assessment'::"text", 'documentation'::"text"]))),
    CONSTRAINT "pathway_checklist_items_status_check" CHECK (("status" = ANY (ARRAY['pending'::"text", 'completed'::"text", 'skipped'::"text", 'overridden'::"text"])))
);


ALTER TABLE "public"."pathway_checklist_items" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."pathway_overrides" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "tenant_id" "uuid" NOT NULL,
    "care_plan_id" "uuid",
    "patient_id" "uuid",
    "encounter_id" "uuid",
    "pathway_id" "text" NOT NULL,
    "pathway_version" "text" NOT NULL,
    "step_id" "text" NOT NULL,
    "recommended_action" "text" NOT NULL,
    "actual_action" "text" NOT NULL,
    "override_reason" "text" NOT NULL,
    "clinician_id" "uuid",
    "occurred_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "patient_context_reference" "text",
    "may_train_models" boolean DEFAULT false NOT NULL,
    "is_synthetic" boolean DEFAULT false NOT NULL
);


ALTER TABLE "public"."pathway_overrides" OWNER TO "postgres";


COMMENT ON COLUMN "public"."pathway_overrides"."may_train_models" IS 'Must remain false unless a separate governance process explicitly permits model use.';



CREATE TABLE IF NOT EXISTS "public"."patient_access_grants" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "patient_id" "uuid" NOT NULL,
    "granted_to" "uuid" NOT NULL,
    "module_name" "text" NOT NULL,
    "access_level" "text" DEFAULT 'read'::"text" NOT NULL,
    "reason" "text" NOT NULL,
    "status" "text" DEFAULT 'active'::"text" NOT NULL,
    "granted_by" "uuid",
    "valid_from" timestamp with time zone DEFAULT "timezone"('utc'::"text", "now"()) NOT NULL,
    "valid_until" timestamp with time zone,
    "revoked_at" timestamp with time zone,
    "revoked_by" "uuid",
    "created_at" timestamp with time zone DEFAULT "timezone"('utc'::"text", "now"()) NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "timezone"('utc'::"text", "now"()) NOT NULL,
    "tenant_id" "uuid",
    "created_by" "uuid",
    "is_deleted" boolean DEFAULT false,
    CONSTRAINT "patient_access_grants_access_level_check" CHECK (("access_level" = ANY (ARRAY['read'::"text", 'write'::"text", 'full'::"text"]))),
    CONSTRAINT "patient_access_grants_status_check" CHECK (("status" = ANY (ARRAY['active'::"text", 'revoked'::"text", 'expired'::"text"])))
);


ALTER TABLE "public"."patient_access_grants" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."patient_allergies" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "patient_id" "uuid" NOT NULL,
    "hospital_id" "uuid",
    "allergen" "text" NOT NULL,
    "allergen_type" "text" DEFAULT 'drug'::"text" NOT NULL,
    "atc_code" "text",
    "reaction" "text",
    "severity" "text" DEFAULT 'unknown'::"text" NOT NULL,
    "onset_date" "date",
    "is_active" boolean DEFAULT true NOT NULL,
    "reported_by" "uuid",
    "verified" boolean DEFAULT false NOT NULL,
    "verified_by" "uuid",
    "notes" "text",
    "created_at" timestamp with time zone DEFAULT "timezone"('utc'::"text", "now"()) NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "timezone"('utc'::"text", "now"()) NOT NULL,
    "tenant_id" "uuid",
    "created_by" "uuid",
    "is_deleted" boolean DEFAULT false,
    CONSTRAINT "patient_allergies_allergen_type_check" CHECK (("allergen_type" = ANY (ARRAY['drug'::"text", 'food'::"text", 'environmental'::"text", 'contrast'::"text", 'latex'::"text", 'other'::"text"]))),
    CONSTRAINT "patient_allergies_severity_check" CHECK (("severity" = ANY (ARRAY['mild'::"text", 'moderate'::"text", 'severe'::"text", 'anaphylaxis'::"text", 'unknown'::"text"])))
);


ALTER TABLE "public"."patient_allergies" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."patient_billing" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "patient_id" "uuid",
    "encounter_id" "uuid",
    "item_name" "text" NOT NULL,
    "amount" numeric DEFAULT 0 NOT NULL,
    "status" "text" DEFAULT 'pending'::"text" NOT NULL,
    "notes" "text",
    "created_at" timestamp with time zone DEFAULT "timezone"('utc'::"text", "now"()) NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "timezone"('utc'::"text", "now"()) NOT NULL,
    "tenant_id" "uuid",
    "created_by" "uuid",
    "is_deleted" boolean DEFAULT false
);


ALTER TABLE "public"."patient_billing" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."patient_clinical_patterns" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "tenant_id" "uuid" NOT NULL,
    "patient_id" "uuid" NOT NULL,
    "pattern_type" "text" NOT NULL,
    "description" "text" NOT NULL,
    "first_seen_at" timestamp with time zone NOT NULL,
    "last_seen_at" timestamp with time zone NOT NULL,
    "occurrence_count" integer DEFAULT 1 NOT NULL,
    "severity" "text" DEFAULT 'moderate'::"text" NOT NULL,
    "icd11_code" "text",
    "evidence" "jsonb",
    "is_resolved" boolean DEFAULT false NOT NULL,
    "resolved_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."patient_clinical_patterns" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."patient_consents" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "patient_id" "uuid" NOT NULL,
    "hospital_id" "uuid",
    "module_name" "text" NOT NULL,
    "consent_type" "text" DEFAULT 'explicit'::"text" NOT NULL,
    "status" "text" DEFAULT 'granted'::"text" NOT NULL,
    "granted_at" timestamp with time zone DEFAULT "timezone"('utc'::"text", "now"()) NOT NULL,
    "expires_at" timestamp with time zone,
    "withdrawn_at" timestamp with time zone,
    "collected_by" "uuid",
    "proxy_name" "text",
    "proxy_relation" "text",
    "notes" "text",
    "language" "text" DEFAULT 'en'::"text" NOT NULL,
    "signature_blob" "text",
    "witness_id" "uuid",
    "ip_address" "inet",
    "device_info" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "timezone"('utc'::"text", "now"()) NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "timezone"('utc'::"text", "now"()) NOT NULL,
    "tenant_id" "uuid",
    "created_by" "uuid",
    "is_deleted" boolean DEFAULT false,
    CONSTRAINT "patient_consents_consent_type_check" CHECK (("consent_type" = ANY (ARRAY['explicit'::"text", 'implied'::"text", 'proxy'::"text"]))),
    CONSTRAINT "patient_consents_module_name_check" CHECK (("module_name" = ANY (ARRAY['clinical_notes'::"text", 'lab_results'::"text", 'imaging'::"text", 'medications'::"text", 'billing'::"text", 'telemedicine'::"text", 'research'::"text", 'third_party'::"text", 'hiv_status'::"text", 'mental_health'::"text", 'reproductive_health'::"text", 'genetics'::"text"]))),
    CONSTRAINT "patient_consents_status_check" CHECK (("status" = ANY (ARRAY['granted'::"text", 'denied'::"text", 'withdrawn'::"text", 'expired'::"text"])))
);


ALTER TABLE "public"."patient_consents" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."patient_history_queries" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "tenant_id" "uuid" NOT NULL,
    "patient_id" "uuid" NOT NULL,
    "queried_by" "uuid" NOT NULL,
    "query_text" "text" NOT NULL,
    "query_embedding" "public"."vector"(1536),
    "filters" "jsonb",
    "ai_summary" "text",
    "ai_model_used" "text",
    "guideline_citations" "text"[],
    "source_count" integer,
    "generated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "is_starred" boolean DEFAULT false NOT NULL
);


ALTER TABLE "public"."patient_history_queries" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."patient_intervention_outcomes" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "tenant_id" "uuid" NOT NULL,
    "patient_id" "uuid" NOT NULL,
    "encounter_id" "uuid",
    "intervention" "text" NOT NULL,
    "intervention_type" "text" DEFAULT 'medication'::"text" NOT NULL,
    "outcome" "text" DEFAULT 'unknown'::"text" NOT NULL,
    "outcome_notes" "text",
    "started_at" timestamp with time zone NOT NULL,
    "evaluated_at" timestamp with time zone,
    "recorded_by" "uuid" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."patient_intervention_outcomes" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."patient_notes" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "clinician_id" "uuid" NOT NULL,
    "patient_identifier_hash" "text" NOT NULL,
    "encrypted_content" "text" NOT NULL,
    "iv" "text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "timezone"('utc'::"text", "now"()) NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "timezone"('utc'::"text", "now"()) NOT NULL,
    "tenant_id" "uuid",
    "created_by" "uuid",
    "is_deleted" boolean DEFAULT false
);


ALTER TABLE "public"."patient_notes" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."patient_pathways" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "patient_id" "uuid" NOT NULL,
    "encounter_id" "uuid",
    "hospital_id" "uuid",
    "template_id" "uuid" NOT NULL,
    "status" "text" DEFAULT 'active'::"text" NOT NULL,
    "started_at" timestamp with time zone DEFAULT "timezone"('utc'::"text", "now"()) NOT NULL,
    "completed_at" timestamp with time zone,
    "abandoned_at" timestamp with time zone,
    "abandoned_reason" "text",
    "current_step" integer DEFAULT 1 NOT NULL,
    "overrides" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "assigned_by" "uuid",
    "created_at" timestamp with time zone DEFAULT "timezone"('utc'::"text", "now"()) NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "timezone"('utc'::"text", "now"()) NOT NULL,
    "tenant_id" "uuid",
    "created_by" "uuid",
    "is_deleted" boolean DEFAULT false,
    CONSTRAINT "patient_pathways_status_check" CHECK (("status" = ANY (ARRAY['active'::"text", 'completed'::"text", 'abandoned'::"text", 'paused'::"text"])))
);


ALTER TABLE "public"."patient_pathways" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."patient_problem_list" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "patient_id" "uuid" NOT NULL,
    "hospital_id" "uuid",
    "icd11_code" "text",
    "icd11_name" "text" NOT NULL,
    "status" "text" DEFAULT 'active'::"text" NOT NULL,
    "onset_date" "date",
    "resolved_date" "date",
    "severity" "text",
    "created_by" "uuid",
    "created_at" timestamp with time zone DEFAULT "timezone"('utc'::"text", "now"()) NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "timezone"('utc'::"text", "now"()) NOT NULL,
    "tenant_id" "uuid",
    "is_deleted" boolean DEFAULT false,
    CONSTRAINT "patient_problem_list_severity_check" CHECK (("severity" = ANY (ARRAY['mild'::"text", 'moderate'::"text", 'severe'::"text"]))),
    CONSTRAINT "patient_problem_list_status_check" CHECK (("status" = ANY (ARRAY['active'::"text", 'resolved'::"text", 'chronic'::"text", 'inactive'::"text"])))
);


ALTER TABLE "public"."patient_problem_list" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."patient_profiles" (
    "id" "uuid" NOT NULL,
    "synapse_id" "text",
    "hospital_id" "uuid",
    "unregistered_hospital" "text",
    "full_name" "text" NOT NULL,
    "first_name" "text",
    "last_name" "text",
    "phone" "text",
    "date_of_birth" "date",
    "sex" "text",
    "blood_group" "text",
    "national_id" "text",
    "emergency_contact_name" "text",
    "emergency_contact_phone" "text",
    "allergies" "jsonb" DEFAULT '[]'::"jsonb",
    "chronic_conditions" "jsonb" DEFAULT '[]'::"jsonb",
    "current_medications" "jsonb" DEFAULT '[]'::"jsonb",
    "immunizations" "jsonb" DEFAULT '[]'::"jsonb",
    "identity_consent" boolean DEFAULT false,
    "passport_pin_hash" "text",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    CONSTRAINT "patient_profiles_sex_check" CHECK (("sex" = ANY (ARRAY['male'::"text", 'female'::"text", 'other'::"text"])))
);


ALTER TABLE "public"."patient_profiles" OWNER TO "postgres";


COMMENT ON TABLE "public"."patient_profiles" IS 'Patient-facing profile records. IDs are owned by Synapse custom auth; rows are not required to exist in auth.users.';



CREATE TABLE IF NOT EXISTS "public"."patient_safety_events" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "encounter_id" "uuid" NOT NULL,
    "encounter_order_id" "uuid",
    "event_type" "text" NOT NULL,
    "severity" "text" NOT NULL,
    "description" "text" NOT NULL,
    "acknowledged_by" "uuid",
    "created_at" timestamp with time zone DEFAULT "timezone"('utc'::"text", "now"()) NOT NULL,
    "tenant_id" "uuid",
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "created_by" "uuid",
    "is_deleted" boolean DEFAULT false,
    CONSTRAINT "patient_safety_events_event_type_check" CHECK (("event_type" = ANY (ARRAY['adverse_drug_reaction'::"text", 'contraindication_warning'::"text", 'medication_error'::"text", 'other'::"text"]))),
    CONSTRAINT "patient_safety_events_severity_check" CHECK (("severity" = ANY (ARRAY['mild'::"text", 'moderate'::"text", 'severe'::"text", 'fatal'::"text"])))
);


ALTER TABLE "public"."patient_safety_events" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."patient_sms_reminders" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "patient_id" "uuid" NOT NULL,
    "hospital_id" "uuid",
    "campaign_id" "uuid",
    "phone_number" "text" NOT NULL,
    "message_type" "text" NOT NULL,
    "message_body" "text" NOT NULL,
    "language" "text" DEFAULT 'en'::"text" NOT NULL,
    "scheduled_at" timestamp with time zone NOT NULL,
    "sent_at" timestamp with time zone,
    "status" "text" DEFAULT 'pending'::"text" NOT NULL,
    "provider" "text" DEFAULT 'africas_talking'::"text" NOT NULL,
    "provider_message_id" "text",
    "error_message" "text",
    "retry_count" integer DEFAULT 0 NOT NULL,
    "created_at" timestamp with time zone DEFAULT "timezone"('utc'::"text", "now"()) NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "timezone"('utc'::"text", "now"()) NOT NULL,
    "tenant_id" "uuid",
    "created_by" "uuid",
    "is_deleted" boolean DEFAULT false,
    CONSTRAINT "patient_sms_reminders_message_type_check" CHECK (("message_type" = ANY (ARRAY['anc_reminder'::"text", 'immunization_due'::"text", 'appointment'::"text", 'medication_refill'::"text", 'follow_up'::"text", 'test_result'::"text", 'campaign_invite'::"text", 'custom'::"text"]))),
    CONSTRAINT "patient_sms_reminders_provider_check" CHECK (("provider" = ANY (ARRAY['africas_talking'::"text", 'twilio'::"text", 'vonage'::"text", 'infobip'::"text", 'mock'::"text"]))),
    CONSTRAINT "patient_sms_reminders_status_check" CHECK (("status" = ANY (ARRAY['pending'::"text", 'sent'::"text", 'delivered'::"text", 'failed'::"text", 'cancelled'::"text"])))
);


ALTER TABLE "public"."patient_sms_reminders" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."patient_timeline_events" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "patient_id" "uuid",
    "hospital_id" "uuid",
    "event_type" "text" NOT NULL,
    "event_date" timestamp with time zone DEFAULT "timezone"('utc'::"text", "now"()) NOT NULL,
    "title" "text" NOT NULL,
    "summary" "text",
    "source_table" "text",
    "source_id" "uuid",
    "severity" "text",
    "tags" "text"[] DEFAULT '{}'::"text"[] NOT NULL,
    "payload" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "created_by" "uuid",
    "created_at" timestamp with time zone DEFAULT "timezone"('utc'::"text", "now"()) NOT NULL,
    "tenant_id" "uuid",
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "is_deleted" boolean DEFAULT false,
    "person_id" "uuid",
    "provenance" "text",
    "site_id" "uuid",
    CONSTRAINT "patient_timeline_events_event_type_check" CHECK (("event_type" = ANY (ARRAY['encounter'::"text", 'vital'::"text", 'lab_result'::"text", 'imaging'::"text", 'medication'::"text", 'procedure'::"text", 'note'::"text", 'discharge'::"text", 'referral'::"text", 'immunization'::"text", 'allergy'::"text", 'diagnosis'::"text", 'surgery'::"text", 'maternity'::"text", 'telemedicine'::"text"]))),
    CONSTRAINT "patient_timeline_events_provenance_check" CHECK ((("provenance" IS NULL) OR ("provenance" = ANY (ARRAY['SELF_REPORTED'::"text", 'PROVIDER_VERIFIED'::"text", 'LAB_VERIFIED'::"text", 'IMPORTED'::"text", 'SYSTEM_GENERATED'::"text"])))),
    CONSTRAINT "patient_timeline_events_severity_check" CHECK (("severity" = ANY (ARRAY['info'::"text", 'warning'::"text", 'critical'::"text"])))
);


ALTER TABLE "public"."patient_timeline_events" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."patient_timeline_pins" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "patient_id" "uuid" NOT NULL,
    "event_id" "uuid" NOT NULL,
    "pinned_by" "uuid" NOT NULL,
    "note" "text",
    "created_at" timestamp with time zone DEFAULT "timezone"('utc'::"text", "now"()) NOT NULL,
    "tenant_id" "uuid",
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "created_by" "uuid",
    "is_deleted" boolean DEFAULT false
);


ALTER TABLE "public"."patient_timeline_pins" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."patient_vitals" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "patient_id" "uuid",
    "synapse_id" "text",
    "encounter_id" "uuid",
    "heart_rate" integer,
    "systolic_bp" integer,
    "diastolic_bp" integer,
    "temperature" numeric,
    "spo2" integer,
    "weight_kg" numeric,
    "blood_glucose" numeric,
    "respiratory_rate" integer,
    "source" "text" DEFAULT 'manual'::"text",
    "device_id" "text",
    "is_live_feed" boolean DEFAULT false,
    "recorded_at" timestamp with time zone DEFAULT "now"(),
    "created_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."patient_vitals" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."patients" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "hospital_id" "uuid",
    "mrn" "text" NOT NULL,
    "uhid" "text",
    "full_name_hash" "text",
    "dob" "date",
    "sex" "text",
    "weight_kg" numeric,
    "height_cm" numeric,
    "blood_group" "text",
    "is_pregnant" boolean DEFAULT false NOT NULL,
    "allergies" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "chronic_conditions" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "current_medications" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "social_history" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "family_history" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "timezone"('utc'::"text", "now"()) NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "timezone"('utc'::"text", "now"()) NOT NULL,
    "phone" "text",
    "nin" "text",
    "nin_hash" character varying(64),
    "nin_last4" character varying(4),
    "phone_hash" character varying(64),
    "phone_last4" character varying(4),
    "village" character varying(100),
    "district" character varying(80),
    "full_name" "text",
    "tenant_id" "uuid",
    "created_by" "uuid",
    "is_deleted" boolean DEFAULT false,
    "income_bracket" "text",
    "education_level" "text",
    "disability_status" "text",
    "ethnicity" "text",
    "employment_status" "text",
    "person_id" "uuid",
    "is_synthetic" boolean DEFAULT false NOT NULL,
    "simulation_run_id" "uuid",
    "data_classification" "text",
    CONSTRAINT "patients_education_level_check" CHECK (("education_level" = ANY (ARRAY['none'::"text", 'primary'::"text", 'secondary'::"text", 'tertiary'::"text"]))),
    CONSTRAINT "patients_income_bracket_check" CHECK (("income_bracket" = ANY (ARRAY['none'::"text", 'low'::"text", 'middle'::"text", 'high'::"text"])))
);


ALTER TABLE "public"."patients" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."payer_contracts" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "hospital_id" "uuid" NOT NULL,
    "insurer_id" "uuid",
    "insurer_name" "text" NOT NULL,
    "contract_type" "text" DEFAULT 'capitation'::"text" NOT NULL,
    "contract_number" "text",
    "effective_date" "date" NOT NULL,
    "expiry_date" "date",
    "submission_method" "text" DEFAULT 'api'::"text" NOT NULL,
    "api_endpoint" "text",
    "api_key_ref" "text",
    "timely_filing_days" integer DEFAULT 180 NOT NULL,
    "clean_claim_rate_target" numeric(5,2) DEFAULT 95.00 NOT NULL,
    "notes" "text",
    "is_active" boolean DEFAULT true NOT NULL,
    "metadata" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "timezone"('utc'::"text", "now"()) NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "timezone"('utc'::"text", "now"()) NOT NULL,
    "tenant_id" "uuid",
    "created_by" "uuid",
    "is_deleted" boolean DEFAULT false,
    CONSTRAINT "payer_contracts_contract_type_check" CHECK (("contract_type" = ANY (ARRAY['capitation'::"text", 'fee_for_service'::"text", 'drg'::"text", 'bundled'::"text", 'hybrid'::"text"]))),
    CONSTRAINT "payer_contracts_submission_method_check" CHECK (("submission_method" = ANY (ARRAY['api'::"text", 'portal'::"text", 'email'::"text", 'paper'::"text"])))
);


ALTER TABLE "public"."payer_contracts" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."pediatric_growth_records" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "patient_id" "uuid" NOT NULL,
    "age_months" integer NOT NULL,
    "weight_kg" numeric,
    "height_cm" numeric,
    "head_circumference_cm" numeric,
    "recorded_at" timestamp with time zone DEFAULT "timezone"('utc'::"text", "now"()) NOT NULL,
    "recorded_by" "uuid",
    "tenant_id" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "created_by" "uuid",
    "is_deleted" boolean DEFAULT false
);


ALTER TABLE "public"."pediatric_growth_records" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."person_clinical_facts" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "person_id" "uuid" NOT NULL,
    "fact_type" "text" NOT NULL,
    "value" "text" NOT NULL,
    "code" "text",
    "code_system" "text",
    "provenance" "text" DEFAULT 'SELF_REPORTED'::"text" NOT NULL,
    "verification_status" "text" DEFAULT 'UNVERIFIED'::"text" NOT NULL,
    "verified_by" "uuid",
    "verified_at" timestamp with time zone,
    "source_facility_id" "uuid",
    "source_system" "text",
    "notes" "text",
    "recorded_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "superseded_by" "uuid",
    CONSTRAINT "person_clinical_facts_fact_type_check" CHECK (("fact_type" = ANY (ARRAY['blood_group'::"text", 'rhesus'::"text", 'allergy'::"text", 'chronic_condition'::"text", 'surgery'::"text", 'current_medication'::"text", 'diagnosis'::"text", 'disability'::"text", 'pregnancy'::"text", 'preferred_language'::"text"]))),
    CONSTRAINT "person_clinical_facts_provenance_check" CHECK (("provenance" = ANY (ARRAY['SELF_REPORTED'::"text", 'PROVIDER_VERIFIED'::"text", 'LAB_VERIFIED'::"text", 'IMPORTED'::"text", 'SYSTEM_GENERATED'::"text"]))),
    CONSTRAINT "person_clinical_facts_verification_status_check" CHECK (("verification_status" = ANY (ARRAY['UNVERIFIED'::"text", 'VERIFIED'::"text", 'DISPUTED'::"text", 'SUPERSEDED'::"text"])))
);


ALTER TABLE "public"."person_clinical_facts" OWNER TO "postgres";


COMMENT ON TABLE "public"."person_clinical_facts" IS 'Minimised clinical profile facts. Self-reported blood group must never appear as clinically verified.';



CREATE TABLE IF NOT EXISTS "public"."person_consent_events" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "consent_id" "uuid" NOT NULL,
    "actor_id" "uuid",
    "action" "text" NOT NULL,
    "from_status" "text",
    "to_status" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."person_consent_events" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."person_consents" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "person_id" "uuid" NOT NULL,
    "purpose" "text" NOT NULL,
    "scope_organization_id" "uuid",
    "scope_facility_id" "uuid",
    "status" "text" DEFAULT 'granted'::"text" NOT NULL,
    "granted_at" timestamp with time zone,
    "expires_at" timestamp with time zone,
    "withdrawn_at" timestamp with time zone,
    "collected_by" "uuid",
    "language" "text",
    "notes" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "person_consents_purpose_check" CHECK (("purpose" = ANY (ARRAY['facility_access'::"text", 'cross_facility_share'::"text", 'research'::"text", 'emergency_profile'::"text", 'blood_donor_contact'::"text", 'dependant_access'::"text", 'insurance_exchange'::"text", 'care_delivery'::"text"]))),
    CONSTRAINT "person_consents_status_check" CHECK (("status" = ANY (ARRAY['granted'::"text", 'denied'::"text", 'withdrawn'::"text", 'expired'::"text"])))
);


ALTER TABLE "public"."person_consents" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."person_contacts" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "person_id" "uuid" NOT NULL,
    "contact_type" "text" NOT NULL,
    "value" "text" NOT NULL,
    "label" "text",
    "provenance" "text" DEFAULT 'SELF_REPORTED'::"text" NOT NULL,
    "is_primary" boolean DEFAULT false NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "person_contacts_contact_type_check" CHECK (("contact_type" = ANY (ARRAY['phone'::"text", 'email'::"text", 'emergency'::"text", 'next_of_kin'::"text"]))),
    CONSTRAINT "person_contacts_provenance_check" CHECK (("provenance" = ANY (ARRAY['SELF_REPORTED'::"text", 'PROVIDER_VERIFIED'::"text", 'LAB_VERIFIED'::"text", 'IMPORTED'::"text", 'SYSTEM_GENERATED'::"text"])))
);


ALTER TABLE "public"."person_contacts" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."person_identifiers" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "person_id" "uuid" NOT NULL,
    "identifier_value" "text" NOT NULL,
    "identifier_type" "text" NOT NULL,
    "issuing_organization_id" "uuid",
    "issuing_facility_id" "uuid",
    "source_system" "text",
    "status" "text" DEFAULT 'active'::"text" NOT NULL,
    "verified_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "person_identifiers_identifier_type_check" CHECK (("identifier_type" = ANY (ARRAY['SYNAPSE_ID'::"text", 'MRN'::"text", 'UHID'::"text", 'OPENMRS'::"text", 'UGANDAEMR'::"text", 'LAB_NUMBER'::"text", 'INSURANCE_MEMBER'::"text", 'DONOR_NUMBER'::"text", 'NIN'::"text", 'PHONE'::"text", 'OTHER'::"text"]))),
    CONSTRAINT "person_identifiers_status_check" CHECK (("status" = ANY (ARRAY['active'::"text", 'superseded'::"text", 'revoked'::"text", 'merged'::"text"]))),
    CONSTRAINT "person_identifiers_value_present" CHECK (("length"("btrim"("identifier_value")) > 0))
);


ALTER TABLE "public"."person_identifiers" OWNER TO "postgres";


COMMENT ON TABLE "public"."person_identifiers" IS 'Facility- and system-local identifiers mapped to one person UUID. Never treat identical strings from different issuers as the same namespace.';



CREATE TABLE IF NOT EXISTS "public"."person_relationships" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "person_id" "uuid" NOT NULL,
    "related_person_id" "uuid" NOT NULL,
    "relationship_type" "text" NOT NULL,
    "can_manage" boolean DEFAULT false NOT NULL,
    "status" "text" DEFAULT 'active'::"text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "ended_at" timestamp with time zone,
    CONSTRAINT "person_relationships_not_self" CHECK (("person_id" <> "related_person_id")),
    CONSTRAINT "person_relationships_relationship_type_check" CHECK (("relationship_type" = ANY (ARRAY['parent'::"text", 'guardian'::"text", 'child'::"text", 'dependant'::"text", 'spouse'::"text", 'sibling'::"text", 'caregiver'::"text", 'other'::"text"]))),
    CONSTRAINT "person_relationships_status_check" CHECK (("status" = ANY (ARRAY['active'::"text", 'ended'::"text", 'revoked'::"text"])))
);


ALTER TABLE "public"."person_relationships" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."persons" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "synapse_id" "text" NOT NULL,
    "given_name" "text",
    "family_name" "text",
    "other_names" "text",
    "full_name" "text" NOT NULL,
    "date_of_birth" "date",
    "sex" "text",
    "preferred_language" "text",
    "district" "text",
    "country_code" "text" DEFAULT 'UG'::"text" NOT NULL,
    "merged_into_person_id" "uuid",
    "is_active" boolean DEFAULT true NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "persons_sex_check" CHECK ((("sex" IS NULL) OR ("sex" = ANY (ARRAY['M'::"text", 'F'::"text", 'I'::"text", 'U'::"text"]))))
);


ALTER TABLE "public"."persons" OWNER TO "postgres";


COMMENT ON TABLE "public"."persons" IS 'Platform-level person. UUID is the immutable identifier. synapse_id is the human-readable SYN-CC-XXXXXXXX label. A person is not owned by a hospital.';



CREATE TABLE IF NOT EXISTS "public"."pharmacy_audit_logs" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "tenant_id" "uuid" NOT NULL,
    "profile_id" "uuid" NOT NULL,
    "action" "text" NOT NULL,
    "entity" "text" NOT NULL,
    "entity_id" "text",
    "details" "text",
    "ip_address" "text",
    "created_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."pharmacy_audit_logs" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."pharmacy_cart_items" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "cart_id" "uuid" NOT NULL,
    "tenant_id" "uuid" NOT NULL,
    "product_id" "uuid" NOT NULL,
    "batch_id" "uuid",
    "quantity" integer NOT NULL,
    "unit_price" numeric(12,2) NOT NULL,
    "discount_amount" numeric(12,2) DEFAULT 0 NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "pharmacy_cart_items_quantity_check" CHECK (("quantity" > 0))
);


ALTER TABLE "public"."pharmacy_cart_items" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."pharmacy_carts" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "tenant_id" "uuid" NOT NULL,
    "session_id" "uuid",
    "cashier_id" "uuid" NOT NULL,
    "prescription_id" "uuid",
    "status" "text" DEFAULT 'active'::"text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."pharmacy_carts" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."pharmacy_cashier_sessions" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "tenant_id" "uuid" NOT NULL,
    "store_id" "uuid",
    "cashier_id" "uuid" NOT NULL,
    "status" "text" DEFAULT 'open'::"text" NOT NULL,
    "opened_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "closed_at" timestamp with time zone,
    "opening_float" numeric(12,2) DEFAULT 0 NOT NULL,
    "closing_float" numeric(12,2),
    "notes" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "expected_cash" numeric,
    "counted_cash" numeric,
    "cash_variance" numeric,
    "closed_by" "uuid",
    "cash_in" numeric DEFAULT 0 NOT NULL,
    "cash_out" numeric DEFAULT 0 NOT NULL,
    "cash_payment_total" numeric DEFAULT 0 NOT NULL,
    "cash_refund_total" numeric DEFAULT 0 NOT NULL,
    "variance_reason" "text",
    "device_id" "text",
    "opened_by" "uuid",
    "till_code" "text",
    CONSTRAINT "pharmacy_cashier_sessions_status_check" CHECK (("status" = ANY (ARRAY['open'::"text", 'active'::"text", 'closing'::"text", 'closed'::"text"])))
);


ALTER TABLE "public"."pharmacy_cashier_sessions" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."pharmacy_clients" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "tenant_id" "uuid" NOT NULL,
    "name" "text" NOT NULL,
    "phone" "text",
    "address" "text",
    "notes" "text",
    "last_visit" timestamp with time zone,
    "is_active" boolean DEFAULT true,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."pharmacy_clients" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."pharmacy_credit_ledger" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "tenant_id" "uuid" NOT NULL,
    "customer_id" "uuid",
    "transaction_id" "uuid",
    "amount" numeric NOT NULL,
    "type" "text" NOT NULL,
    "balance_after" numeric NOT NULL,
    "due_date" "date",
    "notes" "text",
    "created_by" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"(),
    CONSTRAINT "pharmacy_credit_ledger_type_check" CHECK (("type" = ANY (ARRAY['credit'::"text", 'repayment'::"text", 'refund'::"text"])))
);


ALTER TABLE "public"."pharmacy_credit_ledger" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."pharmacy_custom_domains" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "tenant_id" "uuid" NOT NULL,
    "domain" "text" NOT NULL,
    "is_primary" boolean DEFAULT false NOT NULL,
    "verified" boolean DEFAULT false NOT NULL,
    "created_by" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."pharmacy_custom_domains" OWNER TO "postgres";


COMMENT ON TABLE "public"."pharmacy_custom_domains" IS 'Maps a pharmacy tenant''s custom domain(s) to its tenant_id. Service role (server) manages writes; platform admins manage via RLS; tenant members read-only. Resolution is performed server-side via the service role in the pharmacy app.';



CREATE TABLE IF NOT EXISTS "public"."pharmacy_customers" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "tenant_id" "uuid" NOT NULL,
    "email" "text",
    "name" "text" NOT NULL,
    "phone" "text",
    "address" "text",
    "is_active" boolean DEFAULT true,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "password_hash" "text",
    "person_id" "uuid"
);


ALTER TABLE "public"."pharmacy_customers" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."pharmacy_expenses" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "tenant_id" "uuid" NOT NULL,
    "category" "text" NOT NULL,
    "description" "text" NOT NULL,
    "amount" numeric NOT NULL,
    "payment_method" "text",
    "receipt_url" "text",
    "expense_date" "date" DEFAULT CURRENT_DATE,
    "recorded_by" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."pharmacy_expenses" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."pharmacy_import_sessions" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "tenant_id" "uuid" NOT NULL,
    "source_system" "text",
    "file_name" "text",
    "file_url" "text",
    "status" "text" DEFAULT 'pending'::"text",
    "total_rows" integer DEFAULT 0,
    "matched_rows" integer DEFAULT 0,
    "flagged_rows" integer DEFAULT 0,
    "duplicate_rows" integer DEFAULT 0,
    "ai_mapping" "jsonb" DEFAULT '{}'::"jsonb",
    "ai_summary" "text",
    "confirmed_at" timestamp with time zone,
    "completed_at" timestamp with time zone,
    "error_message" "text",
    "created_by" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"(),
    CONSTRAINT "pharmacy_import_sessions_status_check" CHECK (("status" = ANY (ARRAY['pending'::"text", 'mapping'::"text", 'review'::"text", 'importing'::"text", 'complete'::"text", 'failed'::"text"])))
);


ALTER TABLE "public"."pharmacy_import_sessions" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."pharmacy_inquiries" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "tenant_id" "uuid" NOT NULL,
    "profile_id" "uuid",
    "user_email" "text" NOT NULL,
    "user_name" "text" NOT NULL,
    "type" "text" NOT NULL,
    "subject" "text" NOT NULL,
    "message" "text" NOT NULL,
    "status" "text" DEFAULT 'PENDING'::"text" NOT NULL,
    "admin_response" "text",
    "responded_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    CONSTRAINT "pharmacy_inquiries_status_check" CHECK (("status" = ANY (ARRAY['PENDING'::"text", 'RESOLVED'::"text", 'REJECTED'::"text"]))),
    CONSTRAINT "pharmacy_inquiries_type_check" CHECK (("type" = ANY (ARRAY['FEATURE_REQUEST'::"text", 'PASSWORD_RESET'::"text", 'ACCESS_REQUEST'::"text", 'DELETE_REQUEST'::"text", 'OTHER'::"text"])))
);


ALTER TABLE "public"."pharmacy_inquiries" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."pharmacy_product_batches" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "tenant_id" "uuid" NOT NULL,
    "product_id" "uuid" NOT NULL,
    "batch_number" "text" NOT NULL,
    "quantity" integer NOT NULL,
    "initial_quantity" integer NOT NULL,
    "expiry_date" "date" NOT NULL,
    "received_date" timestamp with time zone DEFAULT "now"(),
    "cost_price" numeric(14,2) NOT NULL,
    "is_active" boolean DEFAULT true,
    "notes" "text",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "manufacturer" "text",
    "supplier_invoice_ref" "text",
    "status" "text" DEFAULT 'active'::"text" NOT NULL,
    "quarantine_reason" "text",
    "recalled_at" timestamp with time zone,
    "damaged_reason" "text",
    "store_id" "uuid",
    CONSTRAINT "pharmacy_product_batches_status_check" CHECK (("status" = ANY (ARRAY['active'::"text", 'quarantined'::"text", 'damaged'::"text", 'recalled'::"text", 'expired'::"text", 'exhausted'::"text"])))
);


ALTER TABLE "public"."pharmacy_product_batches" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."pharmacy_products" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "tenant_id" "uuid" NOT NULL,
    "name" "text" NOT NULL,
    "description" "text",
    "category" "text" DEFAULT 'General'::"text" NOT NULL,
    "sku" "text" NOT NULL,
    "barcode" "text",
    "price" numeric(14,2) NOT NULL,
    "cost_price" numeric(14,2) NOT NULL,
    "quantity" integer DEFAULT 0 NOT NULL,
    "reorder_level" integer DEFAULT 10 NOT NULL,
    "unit_of_measure" "text" DEFAULT 'Tablet'::"text" NOT NULL,
    "expiry_date" "date",
    "manufacturer" "text",
    "batch_number" "text",
    "is_active" boolean DEFAULT true,
    "strength" "text",
    "dosage_form" "text",
    "active_ingredient" "text",
    "generic_name" "text",
    "side_effects" "text",
    "storage_instructions" "text",
    "regulatory_id" "text",
    "requires_prescription" boolean DEFAULT false,
    "supplier_id" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "vat_category" "text" DEFAULT 'exempt'::"text" NOT NULL,
    CONSTRAINT "chk_vat_category" CHECK (("vat_category" = ANY (ARRAY['standard'::"text", 'exempt'::"text", 'zero_rated'::"text"])))
);


ALTER TABLE "public"."pharmacy_products" OWNER TO "postgres";


CREATE OR REPLACE VIEW "public"."pharmacy_inventory_summary" WITH ("security_invoker"='true') AS
 WITH "b" AS (
         SELECT "pb"."tenant_id",
            "pb"."product_id",
            "pb"."quantity",
            "pb"."expiry_date",
            COALESCE("pb"."status", 'active'::"text") AS "status",
            ("timezone"('Africa/Kampala'::"text", "now"()))::"date" AS "kla_today"
           FROM "public"."pharmacy_product_batches" "pb"
        )
 SELECT "p"."id" AS "product_id",
    "p"."tenant_id",
    "p"."name",
    COALESCE("p"."quantity", 0) AS "product_quantity",
    COALESCE("sum"("b"."quantity"), (0)::bigint) AS "physical_quantity",
    COALESCE("sum"("b"."quantity") FILTER (WHERE (("b"."status" = 'active'::"text") AND ("b"."quantity" > 0) AND (("b"."expiry_date" IS NULL) OR ("b"."expiry_date" >= "b"."kla_today")))), (0)::bigint) AS "sellable_quantity",
    COALESCE("sum"("b"."quantity") FILTER (WHERE (("b"."expiry_date" IS NOT NULL) AND ("b"."expiry_date" < "b"."kla_today"))), (0)::bigint) AS "expired_quantity",
    COALESCE("sum"("b"."quantity") FILTER (WHERE ("b"."status" = 'quarantined'::"text")), (0)::bigint) AS "quarantined_quantity",
    COALESCE("sum"("b"."quantity") FILTER (WHERE ("b"."status" = 'damaged'::"text")), (0)::bigint) AS "damaged_quantity",
    GREATEST((COALESCE("p"."quantity", 0) - COALESCE("sum"("b"."quantity"), (0)::bigint)), (0)::bigint) AS "unbatched_quantity"
   FROM ("public"."pharmacy_products" "p"
     LEFT JOIN "b" ON ((("b"."product_id" = "p"."id") AND ("b"."tenant_id" = "p"."tenant_id"))))
  GROUP BY "p"."id", "p"."tenant_id", "p"."name", "p"."quantity";


ALTER VIEW "public"."pharmacy_inventory_summary" OWNER TO "postgres";


COMMENT ON VIEW "public"."pharmacy_inventory_summary" IS 'Authoritative batch-derived stock per product. sellable_quantity is the only quantity POS may sell.';



CREATE TABLE IF NOT EXISTS "public"."pharmacy_network_inventory" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "pharmacy_tenant_id" "uuid",
    "drug_name" "text" NOT NULL,
    "generic_name" "text",
    "brand_name" "text",
    "dosage_form" "text",
    "strength" "text",
    "quantity_in_stock" integer DEFAULT 0 NOT NULL,
    "unit_price_ugx" numeric(12,2),
    "is_available" boolean GENERATED ALWAYS AS (("quantity_in_stock" > 0)) STORED,
    "last_synced_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."pharmacy_network_inventory" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."pharmacy_notifications" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "tenant_id" "uuid" NOT NULL,
    "profile_id" "uuid" NOT NULL,
    "type" "text" NOT NULL,
    "title" "text" NOT NULL,
    "message" "text" NOT NULL,
    "related_id" "text",
    "is_read" boolean DEFAULT false,
    "created_at" timestamp with time zone DEFAULT "now"(),
    CONSTRAINT "pharmacy_notifications_type_check" CHECK (("type" = ANY (ARRAY['NEW_ORDER'::"text", 'ORDER_CLAIMED'::"text", 'ORDER_STATUS'::"text", 'SYSTEM'::"text", 'TRANSACTION_EDIT'::"text"])))
);


ALTER TABLE "public"."pharmacy_notifications" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."pharmacy_onboarding" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "tenant_id" "uuid" NOT NULL,
    "current_step" integer DEFAULT 0,
    "invite_token" "text" DEFAULT "encode"("extensions"."gen_random_bytes"(32), 'hex'::"text"),
    "invite_sent_at" timestamp with time zone,
    "invite_expires_at" timestamp with time zone DEFAULT ("now"() + '7 days'::interval),
    "account_created_at" timestamp with time zone,
    "profile_completed_at" timestamp with time zone,
    "store_setup_at" timestamp with time zone,
    "first_product_at" timestamp with time zone,
    "onboarding_completed_at" timestamp with time zone,
    "enrolled_by" "uuid",
    "notes" "text",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "admin_email" "text",
    "admin_name" "text"
);


ALTER TABLE "public"."pharmacy_onboarding" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."pharmacy_order_items" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "tenant_id" "uuid" NOT NULL,
    "order_id" "uuid" NOT NULL,
    "product_id" "uuid",
    "product_name" "text" NOT NULL,
    "quantity" integer NOT NULL,
    "unit_price" numeric(14,2) NOT NULL,
    "total_price" numeric(14,2) NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."pharmacy_order_items" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."pharmacy_orders" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "tenant_id" "uuid" NOT NULL,
    "order_no" "text" NOT NULL,
    "customer_id" "uuid",
    "order_type" "text" DEFAULT 'CUSTOMER'::"text" NOT NULL,
    "total_amount" numeric(14,2) NOT NULL,
    "status" "text" DEFAULT 'PENDING'::"text" NOT NULL,
    "payment_status" "text" DEFAULT 'UNPAID'::"text" NOT NULL,
    "notes" "text",
    "delivery_address" "text",
    "processed_by" "uuid",
    "claimed_by" "uuid",
    "claimed_at" timestamp with time zone,
    "is_online_order" boolean DEFAULT false,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "patient_id" "uuid",
    "items" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "total_ugx" integer DEFAULT 0 NOT NULL,
    "fulfillment_type" "text",
    "payment_ref" "text",
    CONSTRAINT "pharmacy_orders_order_type_check" CHECK (("order_type" = ANY (ARRAY['CUSTOMER'::"text", 'SUPPLIER'::"text"]))),
    CONSTRAINT "pharmacy_orders_payment_status_check" CHECK (("payment_status" = ANY (ARRAY['UNPAID'::"text", 'PARTIAL'::"text", 'PAID'::"text"]))),
    CONSTRAINT "pharmacy_orders_status_check" CHECK (("status" = ANY (ARRAY['PENDING'::"text", 'PROCESSING'::"text", 'READY'::"text", 'COMPLETED'::"text", 'CANCELLED'::"text"])))
);


ALTER TABLE "public"."pharmacy_orders" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."pharmacy_pos_sale_items" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "sale_id" "uuid" NOT NULL,
    "tenant_id" "uuid" NOT NULL,
    "product_id" "uuid" NOT NULL,
    "batch_id" "uuid",
    "quantity" integer NOT NULL,
    "unit_price" numeric(12,2) NOT NULL,
    "discount_amount" numeric(12,2) DEFAULT 0 NOT NULL,
    "line_total" numeric(12,2) GENERATED ALWAYS AS (((("quantity")::numeric * "unit_price") - "discount_amount")) STORED,
    "stock_decremented" boolean DEFAULT false NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "list_price" numeric,
    "discount_reason" "text",
    "discount_approved_by" "uuid",
    "batch_number_snapshot" "text",
    "batch_expiry_snapshot" "date",
    "batch_manufacturer_snapshot" "text",
    CONSTRAINT "chk_discount_requires_reason" CHECK ((("discount_amount" IS NULL) OR ("discount_amount" = (0)::numeric) OR ("discount_reason" IS NOT NULL))),
    CONSTRAINT "pharmacy_pos_sale_items_quantity_check" CHECK (("quantity" > 0))
);


ALTER TABLE "public"."pharmacy_pos_sale_items" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."pharmacy_pos_sales" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "tenant_id" "uuid" NOT NULL,
    "session_id" "uuid",
    "cart_id" "uuid",
    "cashier_id" "uuid" NOT NULL,
    "patient_id" "uuid",
    "prescription_id" "uuid",
    "receipt_number" "text",
    "subtotal" numeric(12,2) NOT NULL,
    "discount_total" numeric(12,2) DEFAULT 0 NOT NULL,
    "tax_amount" numeric(12,2) DEFAULT 0 NOT NULL,
    "total_amount" numeric(12,2) NOT NULL,
    "payment_method" "text" DEFAULT 'cash'::"text" NOT NULL,
    "payment_ref" "text",
    "status" "text" DEFAULT 'completed'::"text" NOT NULL,
    "confirmed_by" "uuid",
    "confirmed_at" timestamp with time zone,
    "voided_reason" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "receipt_pdf_path" "text",
    "printed_at" timestamp with time zone,
    "print_failed" boolean DEFAULT false NOT NULL,
    "voided_by" "uuid",
    "voided_at" timestamp with time zone,
    "terminal_code" "text",
    "is_offline_sale" boolean DEFAULT false NOT NULL,
    "store_id" "uuid",
    CONSTRAINT "pos_sales_confirmed_required" CHECK ((("status" <> 'completed'::"text") OR (("confirmed_by" IS NOT NULL) AND ("confirmed_at" IS NOT NULL))))
);


ALTER TABLE "public"."pharmacy_pos_sales" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."pharmacy_product_packages" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "tenant_id" "uuid" NOT NULL,
    "product_id" "uuid" NOT NULL,
    "name" "text" NOT NULL,
    "units_per_package" integer NOT NULL,
    "price" numeric(14,2) NOT NULL,
    "is_default" boolean DEFAULT false,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."pharmacy_product_packages" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."pharmacy_profiles" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "tenant_id" "uuid",
    "pharmacy_name" "text",
    "license_number" "text",
    "license_expiry" "date",
    "district" "text",
    "physical_address" "text",
    "contact_person" "text",
    "contact_phone" "text",
    "contact_email" "text",
    "default_domain" "text",
    "custom_domain" "text",
    "custom_domain_verified" boolean DEFAULT false NOT NULL,
    "custom_domain_verified_at" timestamp with time zone,
    "vercel_domain_id" "text",
    "is_network_visible" boolean DEFAULT true NOT NULL,
    "delivery_available" boolean DEFAULT false NOT NULL,
    "delivery_radius_km" integer,
    "migrated_from" "text",
    "migration_status" "text" DEFAULT 'pending'::"text" NOT NULL,
    "migration_completed_at" timestamp with time zone,
    "logo_url" "text",
    "theme_color" "text" DEFAULT '#F97316'::"text" NOT NULL,
    "network_joined_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "domain_status" "text" DEFAULT 'default'::"text",
    "domain_verification" "jsonb",
    "domain_error" "text",
    "domain_configured_at" timestamp with time zone,
    "last_domain_check_at" timestamp with time zone
);


ALTER TABLE "public"."pharmacy_profiles" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."pharmacy_purchase_order_items" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "tenant_id" "uuid" NOT NULL,
    "purchase_order_id" "uuid" NOT NULL,
    "product_id" "uuid",
    "product_name" "text" NOT NULL,
    "quantity" integer NOT NULL,
    "unit_price" numeric(14,2) NOT NULL,
    "total_price" numeric(14,2) NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."pharmacy_purchase_order_items" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."pharmacy_purchase_orders" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "tenant_id" "uuid" NOT NULL,
    "order_no" "text" NOT NULL,
    "supplier_id" "uuid" NOT NULL,
    "total_amount" numeric(14,2) NOT NULL,
    "status" "text" DEFAULT 'DRAFT'::"text" NOT NULL,
    "notes" "text",
    "expected_date" "date",
    "email_sent" boolean DEFAULT false,
    "email_sent_at" timestamp with time zone,
    "created_by" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    CONSTRAINT "pharmacy_purchase_orders_status_check" CHECK (("status" = ANY (ARRAY['DRAFT'::"text", 'SENT'::"text", 'CONFIRMED'::"text", 'SHIPPED'::"text", 'RECEIVED'::"text", 'CANCELLED'::"text"])))
);


ALTER TABLE "public"."pharmacy_purchase_orders" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."pharmacy_receipt_reprints" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "tenant_id" "uuid" NOT NULL,
    "sale_id" "uuid" NOT NULL,
    "reprinted_by" "uuid",
    "reason" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."pharmacy_receipt_reprints" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."pharmacy_refunds" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "tenant_id" "uuid" NOT NULL,
    "sale_id" "uuid" NOT NULL,
    "cashier_id" "uuid" NOT NULL,
    "approved_by" "uuid" NOT NULL,
    "reason" "text" NOT NULL,
    "refund_amount" numeric(12,2) NOT NULL,
    "refund_method" "text" DEFAULT 'cash'::"text" NOT NULL,
    "status" "text" DEFAULT 'pending'::"text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."pharmacy_refunds" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."pharmacy_sale_idempotency" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "tenant_id" "uuid" NOT NULL,
    "idempotency_key" "text" NOT NULL,
    "sale_id" "uuid",
    "response_payload" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "created_by" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."pharmacy_sale_idempotency" OWNER TO "postgres";


COMMENT ON TABLE "public"."pharmacy_sale_idempotency" IS 'POS complete-sale idempotency: retries with the same key return the original sale response.';



CREATE TABLE IF NOT EXISTS "public"."pharmacy_settings" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "tenant_id" "uuid" NOT NULL,
    "pharmacy_name" "text" DEFAULT 'Synapse Pharmacy'::"text" NOT NULL,
    "location" "text",
    "contact" "text",
    "email" "text",
    "logo" "text",
    "footer_text" "text",
    "receipt_header" "text",
    "receipt_footer" "text",
    "tax_rate" numeric(8,4) DEFAULT 0 NOT NULL,
    "currency" "text" DEFAULT 'UGX'::"text" NOT NULL,
    "low_stock_threshold" integer DEFAULT 10 NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "printer_type" "text" DEFAULT 'default'::"text" NOT NULL,
    "vat_enabled" boolean DEFAULT false NOT NULL,
    "vat_rate" numeric DEFAULT 18 NOT NULL,
    "efris_enabled" boolean DEFAULT false NOT NULL,
    "efris_tin" "text",
    "efris_device_no" "text",
    "discount_approval_threshold_pct" numeric DEFAULT 5 NOT NULL,
    "mandatory_receipt_print" boolean DEFAULT true NOT NULL,
    "receipt_paper_width" "text" DEFAULT '80'::"text" NOT NULL,
    "receipt_font_scale" numeric DEFAULT 1 NOT NULL,
    "auto_print_receipt" boolean DEFAULT false NOT NULL,
    "legal_name" "text",
    "trading_name" "text",
    "logo_url" "text",
    "tin" "text",
    "nda_license_number" "text",
    "supervising_pharmacist" "text",
    "pharmacist_registration_number" "text",
    "branch_name" "text",
    CONSTRAINT "pharmacy_settings_receipt_paper_width_check" CHECK (("receipt_paper_width" = ANY (ARRAY['58'::"text", '80'::"text", 'a4'::"text"])))
);


ALTER TABLE "public"."pharmacy_settings" OWNER TO "postgres";

COMMENT ON COLUMN "public"."pharmacy_settings"."tax_rate" IS 'Legacy flat tax rate as a PERCENTAGE: 18 means 18%. Read as base * rate / 100. 0 disables tax; VAT settings take priority when vat_enabled is true.';


CREATE TABLE IF NOT EXISTS "public"."pharmacy_staff_permissions" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "tenant_id" "uuid" NOT NULL,
    "staff_id" "uuid" NOT NULL,
    "can_view_inventory" boolean DEFAULT true,
    "can_edit_inventory" boolean DEFAULT false,
    "can_process_sales" boolean DEFAULT true,
    "can_apply_discounts" boolean DEFAULT false,
    "can_access_credit_records" boolean DEFAULT false,
    "can_approve_stock_adjustments" boolean DEFAULT false,
    "can_access_financial_reports" boolean DEFAULT false,
    "can_manage_staff" boolean DEFAULT false,
    "can_access_settings" boolean DEFAULT false,
    "max_discount_percent" numeric DEFAULT 0,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."pharmacy_staff_permissions" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."pharmacy_stock_adjustments" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "tenant_id" "uuid" NOT NULL,
    "product_id" "uuid" NOT NULL,
    "quantity" integer NOT NULL,
    "type" "text" NOT NULL,
    "reason" "text",
    "previous_qty" integer NOT NULL,
    "new_qty" integer NOT NULL,
    "created_by" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "batch_id" "uuid",
    "approved_by" "uuid",
    CONSTRAINT "pharmacy_stock_adjustments_type_check" CHECK (("type" = ANY (ARRAY['INCREASE'::"text", 'DECREASE'::"text", 'CORRECTION'::"text"])))
);


ALTER TABLE "public"."pharmacy_stock_adjustments" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."pharmacy_stock_transfer_item_allocations" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "transfer_item_id" "uuid" NOT NULL,
    "from_batch_id" "uuid" NOT NULL,
    "to_batch_id" "uuid",
    "batch_number" "text" NOT NULL,
    "expiry_date" "date",
    "cost_price" numeric,
    "quantity" integer NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "pharmacy_stock_transfer_item_allocations_quantity_check" CHECK (("quantity" > 0))
);


ALTER TABLE "public"."pharmacy_stock_transfer_item_allocations" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."pharmacy_stock_transfer_items" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "transfer_id" "uuid" NOT NULL,
    "product_id" "uuid" NOT NULL,
    "from_batch_id" "uuid",
    "quantity" integer NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "pharmacy_stock_transfer_items_quantity_check" CHECK (("quantity" > 0))
);


ALTER TABLE "public"."pharmacy_stock_transfer_items" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."pharmacy_stock_transfers" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "tenant_id" "uuid" NOT NULL,
    "from_store_id" "uuid" NOT NULL,
    "to_store_id" "uuid" NOT NULL,
    "status" "text" DEFAULT 'draft'::"text" NOT NULL,
    "requested_by" "uuid",
    "received_by" "uuid",
    "notes" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "received_at" timestamp with time zone,
    "shipped_by" "uuid",
    "shipped_at" timestamp with time zone,
    CONSTRAINT "pharmacy_stock_transfers_distinct_stores" CHECK (("from_store_id" <> "to_store_id")),
    CONSTRAINT "pharmacy_stock_transfers_status_check" CHECK (("status" = ANY (ARRAY['draft'::"text", 'in_transit'::"text", 'received'::"text", 'cancelled'::"text"])))
);


ALTER TABLE "public"."pharmacy_stock_transfers" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."pharmacy_stores" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "name" "text" NOT NULL,
    "store_type" "text" DEFAULT 'main'::"text" NOT NULL,
    "department_id" "uuid",
    "manager_id" "uuid",
    "is_active" boolean DEFAULT true NOT NULL,
    "created_at" timestamp with time zone DEFAULT "timezone"('utc'::"text", "now"()) NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "timezone"('utc'::"text", "now"()) NOT NULL,
    "tenant_id" "uuid",
    "created_by" "uuid",
    "is_deleted" boolean DEFAULT false,
    "parent_store_id" "uuid",
    "address" "text",
    "district" "text",
    "phone" "text",
    "is_warehouse" boolean DEFAULT false,
    CONSTRAINT "pharmacy_stores_store_type_check" CHECK (("store_type" = ANY (ARRAY['main'::"text", 'satellite'::"text", 'ward'::"text"])))
);


ALTER TABLE "public"."pharmacy_stores" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."pharmacy_suppliers" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "tenant_id" "uuid" NOT NULL,
    "name" "text" NOT NULL,
    "email" "text",
    "phone" "text",
    "address" "text",
    "contact_person" "text",
    "notes" "text",
    "is_active" boolean DEFAULT true,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."pharmacy_suppliers" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."pharmacy_transaction_edits" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "tenant_id" "uuid" NOT NULL,
    "transaction_id" "uuid" NOT NULL,
    "edited_by" "uuid" NOT NULL,
    "reason" "text" NOT NULL,
    "previous_data" "jsonb" NOT NULL,
    "new_data" "jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."pharmacy_transaction_edits" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."pharmacy_transaction_items" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "tenant_id" "uuid" NOT NULL,
    "transaction_id" "uuid" NOT NULL,
    "product_id" "uuid" NOT NULL,
    "batch_id" "uuid",
    "quantity" integer NOT NULL,
    "unit_price" numeric(14,2) NOT NULL,
    "cost_price" numeric(14,2),
    "total_price" numeric(14,2) NOT NULL,
    "package_name" "text",
    "package_quantity" integer,
    "created_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."pharmacy_transaction_items" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."pharmacy_transactions" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "tenant_id" "uuid" NOT NULL,
    "transaction_no" "text" NOT NULL,
    "customer_id" "uuid",
    "client_name" "text",
    "client_phone" "text",
    "client_address" "text",
    "cashier_id" "uuid" NOT NULL,
    "total_amount" numeric(14,2) NOT NULL,
    "discount" numeric(14,2) DEFAULT 0 NOT NULL,
    "tax" numeric(14,2) DEFAULT 0 NOT NULL,
    "net_amount" numeric(14,2) NOT NULL,
    "payment_method" "text" NOT NULL,
    "status" "text" DEFAULT 'COMPLETED'::"text" NOT NULL,
    "notes" "text",
    "is_edited" boolean DEFAULT false,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    CONSTRAINT "pharmacy_transactions_payment_method_check" CHECK (("payment_method" = ANY (ARRAY['CASH'::"text", 'CARD'::"text", 'MOBILE_MONEY'::"text", 'BANK_TRANSFER'::"text"]))),
    CONSTRAINT "pharmacy_transactions_status_check" CHECK (("status" = ANY (ARRAY['PENDING'::"text", 'COMPLETED'::"text", 'CANCELLED'::"text", 'REFUNDED'::"text"])))
);


ALTER TABLE "public"."pharmacy_transactions" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."pharmacy_user_settings" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "tenant_id" "uuid" NOT NULL,
    "profile_id" "uuid" NOT NULL,
    "username" "text",
    "pharmacy_role" "text" DEFAULT 'pharmacy_staff'::"text" NOT NULL,
    "permissions" "text"[] DEFAULT '{}'::"text"[],
    "must_change_password" boolean DEFAULT false,
    "two_factor_enabled" boolean DEFAULT false,
    "two_factor_email" "text",
    "is_active" boolean DEFAULT true,
    "created_by" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "store_id" "uuid",
    CONSTRAINT "pharmacy_user_settings_pharmacy_role_check" CHECK (("pharmacy_role" = ANY (ARRAY['pharmacy_ceo'::"text", 'pharmacy_admin'::"text", 'pharmacy_staff'::"text", 'pharmacy_cashier'::"text", 'pharmacist'::"text", 'inventory_officer'::"text", 'pharmacy_store_manager'::"text", 'finance'::"text"])))
);


ALTER TABLE "public"."pharmacy_user_settings" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."phi_access_log" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "hospital_id" "uuid",
    "actor_id" "uuid",
    "actor_role" "text",
    "patient_id" "uuid",
    "access_type" "text" NOT NULL,
    "resource_type" "text" NOT NULL,
    "resource_id" "uuid",
    "ip_address" "inet",
    "user_agent" "text",
    "api_endpoint" "text",
    "purpose" "text",
    "accessed_at" timestamp with time zone DEFAULT "timezone"('utc'::"text", "now"()) NOT NULL,
    "tenant_id" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "created_by" "uuid",
    "is_deleted" boolean DEFAULT false,
    CONSTRAINT "phi_access_log_access_type_check" CHECK (("access_type" = ANY (ARRAY['view'::"text", 'edit'::"text", 'export'::"text", 'print'::"text", 'api'::"text"])))
);


ALTER TABLE "public"."phi_access_log" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."pilot_applications" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "facility_name" "text" NOT NULL,
    "facility_type" "text" NOT NULL,
    "bed_count" integer,
    "contact_name" "text" NOT NULL,
    "contact_email" "text" NOT NULL,
    "contact_phone" "text",
    "country" "text" DEFAULT 'UG'::"text" NOT NULL,
    "district" "text",
    "pain_point" "text",
    "plan" "text",
    "status" "text" DEFAULT 'pending'::"text" NOT NULL,
    "notes" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "pilot_applications_status_check" CHECK (("status" = ANY (ARRAY['pending'::"text", 'reviewing'::"text", 'approved'::"text", 'rejected'::"text", 'provisioned'::"text"])))
);


ALTER TABLE "public"."pilot_applications" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."plan_features" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "plan_id" "uuid" NOT NULL,
    "feature_key" "text" NOT NULL,
    "value" "jsonb",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."plan_features" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."platform_approvals" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "action" "text" NOT NULL,
    "risk_level" "text" NOT NULL,
    "target_type" "text" NOT NULL,
    "target_id" "text",
    "payload" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "reason" "text" NOT NULL,
    "requested_by" "uuid" NOT NULL,
    "requested_at" timestamp with time zone DEFAULT "timezone"('utc'::"text", "now"()) NOT NULL,
    "status" "text" DEFAULT 'requested'::"text" NOT NULL,
    "reviewed_by" "uuid",
    "reviewed_at" timestamp with time zone,
    "review_reason" "text",
    "executed_at" timestamp with time zone,
    "execution_error" "text",
    "correlation_id" "text",
    "created_at" timestamp with time zone DEFAULT "timezone"('utc'::"text", "now"()) NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "timezone"('utc'::"text", "now"()) NOT NULL,
    CONSTRAINT "platform_approvals_risk_level_check" CHECK (("risk_level" = ANY (ARRAY['high'::"text", 'critical'::"text"]))),
    CONSTRAINT "platform_approvals_status_check" CHECK (("status" = ANY (ARRAY['requested'::"text", 'approved'::"text", 'rejected'::"text", 'executed'::"text", 'failed'::"text"])))
);


ALTER TABLE "public"."platform_approvals" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."platform_audit_events" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "actor_id" "uuid",
    "actor_role" "text",
    "action" "text" NOT NULL,
    "resource_type" "text" NOT NULL,
    "resource_id" "uuid",
    "organization_id" "uuid",
    "tenant_id" "uuid",
    "site_id" "uuid",
    "source" "text",
    "device_id" "text",
    "session_id" "text",
    "metadata" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "target_type" "text",
    "target_id" "text",
    "facility_id" "uuid",
    "old_value" "jsonb",
    "new_value" "jsonb",
    "reason" "text",
    "ip" "text",
    "user_agent" "text",
    "correlation_id" "text",
    "risk_level" "text",
    CONSTRAINT "platform_audit_events_risk_level_check" CHECK ((("risk_level" IS NULL) OR ("risk_level" = ANY (ARRAY['low'::"text", 'medium'::"text", 'high'::"text", 'critical'::"text"]))))
);


ALTER TABLE "public"."platform_audit_events" OWNER TO "postgres";


COMMENT ON TABLE "public"."platform_audit_events" IS 'Append-only control-plane audit. Service-role insert only. Not a PHI browser.';



CREATE TABLE IF NOT EXISTS "public"."platform_billing_config" (
    "key" "text" NOT NULL,
    "value" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."platform_billing_config" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."platform_broadcasts" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "audience" "text" DEFAULT 'all_tenants'::"text" NOT NULL,
    "product" "text",
    "tenant_id" "uuid",
    "title" "text" NOT NULL,
    "body" "text" NOT NULL,
    "status" "text" DEFAULT 'draft'::"text" NOT NULL,
    "previewed_by" "uuid",
    "sent_by" "uuid",
    "sent_at" timestamp with time zone,
    "created_by" "uuid",
    "created_at" timestamp with time zone DEFAULT "timezone"('utc'::"text", "now"()) NOT NULL,
    CONSTRAINT "platform_broadcasts_status_check" CHECK (("status" = ANY (ARRAY['draft'::"text", 'previewed'::"text", 'sent'::"text", 'cancelled'::"text"])))
);


ALTER TABLE "public"."platform_broadcasts" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."platform_feature_flags" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "flag" "text" NOT NULL,
    "description" "text" NOT NULL,
    "owner" "text",
    "risk_level" "text" DEFAULT 'low'::"text" NOT NULL,
    "default_enabled" boolean DEFAULT false NOT NULL,
    "environment_values" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "expires_at" timestamp with time zone,
    "created_by" "uuid",
    "updated_by" "uuid",
    "created_at" timestamp with time zone DEFAULT "timezone"('utc'::"text", "now"()) NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "timezone"('utc'::"text", "now"()) NOT NULL,
    CONSTRAINT "platform_feature_flags_risk_level_check" CHECK (("risk_level" = ANY (ARRAY['low'::"text", 'medium'::"text", 'high'::"text", 'critical'::"text"])))
);


ALTER TABLE "public"."platform_feature_flags" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."platform_health_checks" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "target" "text" NOT NULL,
    "check_type" "text" DEFAULT 'http'::"text" NOT NULL,
    "status" "text" NOT NULL,
    "http_status" integer,
    "latency_ms" integer,
    "detail" "text",
    "checked_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "platform_health_checks_status_check" CHECK (("status" = ANY (ARRAY['healthy'::"text", 'degraded'::"text", 'down'::"text", 'not_connected'::"text", 'not_configured'::"text"])))
);


ALTER TABLE "public"."platform_health_checks" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."platform_incidents" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "service" "text" DEFAULT 'platform'::"text" NOT NULL,
    "severity" "text" NOT NULL,
    "status" "text" DEFAULT 'INVESTIGATING'::"text" NOT NULL,
    "impact" "text",
    "started_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "resolved_at" timestamp with time zone,
    "root_cause_reference" "text",
    "updates" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "created_by" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "title" "text",
    "summary" "text",
    "public_summary" "text",
    "affected_services" "text"[] DEFAULT '{}'::"text"[] NOT NULL,
    "affected_tenants" "uuid"[] DEFAULT '{}'::"uuid"[] NOT NULL,
    "detected_at" timestamp with time zone,
    "owner_id" "uuid",
    "root_cause" "text",
    "follow_up" "text",
    "correlation_id" "text",
    "updated_at" timestamp with time zone DEFAULT "timezone"('utc'::"text", "now"()) NOT NULL,
    CONSTRAINT "platform_incidents_severity_check" CHECK (("severity" = ANY (ARRAY['SEV1'::"text", 'SEV2'::"text", 'SEV3'::"text", 'SEV4'::"text"]))),
    CONSTRAINT "platform_incidents_status_check" CHECK (("status" = ANY (ARRAY['INVESTIGATING'::"text", 'IDENTIFIED'::"text", 'MITIGATING'::"text", 'MONITORING'::"text", 'RESOLVED'::"text"])))
);


ALTER TABLE "public"."platform_incidents" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."platform_invitations" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "email" "text" NOT NULL,
    "full_name" "text" NOT NULL,
    "platform_role" "text" NOT NULL,
    "token_hash" "text" NOT NULL,
    "status" "text" DEFAULT 'PENDING'::"text" NOT NULL,
    "invited_by" "uuid",
    "membership_id" "uuid",
    "expires_at" timestamp with time zone NOT NULL,
    "sent_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "accepted_at" timestamp with time zone,
    "resent_count" integer DEFAULT 0 NOT NULL,
    "revoked_at" timestamp with time zone,
    "notes" "text",
    "visibility_scopes" "text"[] DEFAULT '{}'::"text"[] NOT NULL,
    "metadata" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "platform_invitations_status_check" CHECK (("status" = ANY (ARRAY['PENDING'::"text", 'ACCEPTED'::"text", 'REVOKED'::"text", 'EXPIRED'::"text"])))
);


ALTER TABLE "public"."platform_invitations" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."platform_memberships" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "platform_role" "text" NOT NULL,
    "status" "text" DEFAULT 'INVITED'::"text" NOT NULL,
    "invited_by" "uuid",
    "invited_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "accepted_at" timestamp with time zone,
    "expires_at" timestamp with time zone,
    "last_access_at" timestamp with time zone,
    "mfa_required" boolean DEFAULT true NOT NULL,
    "password_change_required" boolean DEFAULT false NOT NULL,
    "notes" "text",
    "metadata" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "platform_memberships_status_check" CHECK (("status" = ANY (ARRAY['INVITED'::"text", 'ACTIVE'::"text", 'SUSPENDED'::"text", 'REVOKED'::"text", 'EXPIRED'::"text"])))
);


ALTER TABLE "public"."platform_memberships" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."platform_module_matrix" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "tenant_id" "uuid" NOT NULL,
    "module_key" "text" NOT NULL,
    "state" "text" DEFAULT 'Disabled'::"text" NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "platform_module_matrix_state_check" CHECK (("state" = ANY (ARRAY['Enabled'::"text", 'Disabled'::"text", 'Pilot'::"text", 'Demo'::"text", 'Development'::"text", 'Unsupported'::"text"])))
);


ALTER TABLE "public"."platform_module_matrix" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."platform_releases" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "product_id" "text" NOT NULL,
    "version" "text" NOT NULL,
    "commit_sha" "text",
    "branch" "text",
    "pr_url" "text",
    "status" "text" DEFAULT 'draft'::"text" NOT NULL,
    "ci_status" "text",
    "notes" "text",
    "rollback_strategy" "text",
    "approved_by" "uuid",
    "approved_at" timestamp with time zone,
    "created_by" "uuid",
    "created_at" timestamp with time zone DEFAULT "timezone"('utc'::"text", "now"()) NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "timezone"('utc'::"text", "now"()) NOT NULL,
    CONSTRAINT "platform_releases_status_check" CHECK (("status" = ANY (ARRAY['draft'::"text", 'candidate'::"text", 'staging'::"text", 'pilot'::"text", 'production'::"text", 'rolled_back'::"text", 'failed'::"text"])))
);


ALTER TABLE "public"."platform_releases" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."platform_support_sessions" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "tenant_id" "uuid" NOT NULL,
    "facility_id" "uuid",
    "reason" "text" NOT NULL,
    "scope" "text" DEFAULT 'tenant_config_read'::"text" NOT NULL,
    "ticket_id" "uuid",
    "requested_by" "uuid" NOT NULL,
    "approved_by" "uuid",
    "status" "text" DEFAULT 'requested'::"text" NOT NULL,
    "expires_at" timestamp with time zone NOT NULL,
    "correlation_id" "text",
    "created_at" timestamp with time zone DEFAULT "timezone"('utc'::"text", "now"()) NOT NULL,
    CONSTRAINT "platform_support_sessions_scope_check" CHECK (("scope" = ANY (ARRAY['tenant_config_read'::"text", 'billing_read'::"text", 'integration_read'::"text"]))),
    CONSTRAINT "platform_support_sessions_status_check" CHECK (("status" = ANY (ARRAY['requested'::"text", 'active'::"text", 'expired'::"text", 'revoked'::"text", 'rejected'::"text"])))
);


ALTER TABLE "public"."platform_support_sessions" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."platform_support_tickets" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "tenant_id" "uuid",
    "facility_id" "uuid",
    "product" "text",
    "priority" "text" DEFAULT 'normal'::"text" NOT NULL,
    "severity" "text",
    "status" "text" DEFAULT 'open'::"text" NOT NULL,
    "subject" "text" NOT NULL,
    "description" "text",
    "owner_id" "uuid",
    "sla_due_at" timestamp with time zone,
    "incident_id" "uuid",
    "created_by" "uuid",
    "created_at" timestamp with time zone DEFAULT "timezone"('utc'::"text", "now"()) NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "timezone"('utc'::"text", "now"()) NOT NULL,
    CONSTRAINT "platform_support_tickets_priority_check" CHECK (("priority" = ANY (ARRAY['low'::"text", 'normal'::"text", 'high'::"text", 'urgent'::"text"]))),
    CONSTRAINT "platform_support_tickets_status_check" CHECK (("status" = ANY (ARRAY['open'::"text", 'in_progress'::"text", 'waiting_customer'::"text", 'escalated'::"text", 'resolved'::"text", 'closed'::"text"])))
);


ALTER TABLE "public"."platform_support_tickets" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."platform_test_runs" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "suite" "text" NOT NULL,
    "test_id" "text" NOT NULL,
    "category" "text" NOT NULL,
    "classification" "text" NOT NULL,
    "environment" "text" NOT NULL,
    "tenant_id" "uuid",
    "facility_id" "uuid",
    "seed" "text",
    "commit_sha" "text",
    "deployment_id" "text",
    "started_by" "uuid",
    "started_at" timestamp with time zone DEFAULT "timezone"('utc'::"text", "now"()) NOT NULL,
    "completed_at" timestamp with time zone,
    "status" "text" DEFAULT 'running'::"text" NOT NULL,
    "duration_ms" integer,
    "evidence" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "logs" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "correlation_id" "text" NOT NULL,
    "is_synthetic" boolean DEFAULT true NOT NULL,
    CONSTRAINT "platform_test_runs_classification_check" CHECK (("classification" = ANY (ARRAY['static'::"text", 'unit'::"text", 'integration'::"text", 'synthetic_e2e'::"text", 'live_safe_probe'::"text", 'manual_device'::"text"]))),
    CONSTRAINT "platform_test_runs_environment_check" CHECK (("environment" = ANY (ARRAY['simulation'::"text", 'staging'::"text", 'production_safe'::"text"]))),
    CONSTRAINT "platform_test_runs_status_check" CHECK (("status" = ANY (ARRAY['pass'::"text", 'fail'::"text", 'blocked'::"text", 'skipped'::"text", 'not_configured'::"text", 'running'::"text"])))
);


ALTER TABLE "public"."platform_test_runs" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."products" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "name" "text" NOT NULL,
    "description" "text",
    "price" numeric NOT NULL,
    "category" "text" NOT NULL,
    "image_url" "text",
    "stock_status" "text" DEFAULT 'In stock'::"text",
    "is_gas" boolean DEFAULT false,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "tenant_id" "uuid",
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "created_by" "uuid",
    "is_deleted" boolean DEFAULT false
);


ALTER TABLE "public"."products" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."professional_leads" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "full_name" "text" NOT NULL,
    "email" "text" NOT NULL,
    "phone" "text",
    "role" "text" NOT NULL,
    "specialty" "text",
    "license_number" "text",
    "hospital_name" "text",
    "location" "text",
    "hospital_type" "text",
    "bed_count" integer,
    "current_system" "text",
    "interests" "text"[] DEFAULT '{}'::"text"[] NOT NULL,
    "message" "text",
    "hear_about_us" "text",
    "status" "text" DEFAULT 'new'::"text" NOT NULL,
    "source" "text" DEFAULT 'apply_professional'::"text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."professional_leads" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."profiles" (
    "id" "uuid" NOT NULL,
    "hospital_id" "uuid",
    "department_id" "uuid",
    "full_name" "text",
    "role" "text" DEFAULT 'clinician'::"text" NOT NULL,
    "phone" "text",
    "rating" numeric,
    "created_at" timestamp with time zone DEFAULT "timezone"('utc'::"text", "now"()) NOT NULL,
    "verification_status" "text" DEFAULT 'pending'::"text" NOT NULL,
    "license_number" "text",
    "specialty_confirmed" "text",
    "years_experience" integer,
    "doc_medical_license_path" "text",
    "doc_id_card_path" "text",
    "is_verified_student" boolean DEFAULT false,
    "is_admin" boolean DEFAULT false,
    "email" "text",
    "tenant_id" "uuid",
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "created_by" "uuid",
    "is_deleted" boolean DEFAULT false,
    "gender" "text",
    "salary_bracket" "text",
    "training_hours" numeric DEFAULT 0,
    "first_name" "text",
    "last_name" "text",
    "email_override" "text",
    "onboarding_complete" boolean DEFAULT false NOT NULL,
    "synapse_id" "text",
    "app_user" boolean DEFAULT false,
    "avatar_url" "text",
    "date_of_birth" "text",
    "blood_type" "text",
    "emergency_contact_name" "text",
    "emergency_contact_phone" "text",
    "last_sign_in_at" timestamp with time zone,
    "password_hash" "text",
    "password_changed_at" timestamp with time zone,
    "must_change_password" boolean DEFAULT false NOT NULL,
    "login_attempts" integer DEFAULT 0 NOT NULL,
    "locked_until" timestamp with time zone,
    "email_verified_at" timestamp with time zone,
    "activation_sent_at" timestamp with time zone,
    "platform_control_role" "text",
    CONSTRAINT "profiles_platform_control_role_check" CHECK ((("platform_control_role" IS NULL) OR ("platform_control_role" = ANY (ARRAY['super_admin'::"text", 'platform_admin'::"text", 'security_admin'::"text", 'integration_admin'::"text", 'release_manager'::"text", 'billing_admin'::"text", 'customer_success'::"text", 'support_admin'::"text", 'clinical_governance'::"text", 'read_only_auditor'::"text"])))),
    CONSTRAINT "profiles_role_check" CHECK (("role" = ANY (ARRAY['clinician'::"text", 'admin'::"text", 'doctor'::"text", 'nurse'::"text", 'pharmacist'::"text", 'receptionist'::"text", 'lab_technician'::"text", 'lab_scientist'::"text", 'lab_admin'::"text", 'radiographer'::"text", 'radiologist'::"text", 'imaging_admin'::"text", 'billing_officer'::"text", 'insurance_officer'::"text", 'patient'::"text", 'superadmin'::"text", 'hospital_admin'::"text", 'super_admin'::"text", 'overall_admin'::"text", 'platform_admin'::"text", 'platform_observer'::"text", 'clinical_officer'::"text", 'specialist'::"text", 'surgeon'::"text", 'anaesthetist'::"text", 'intensivist'::"text", 'cardiologist'::"text", 'oncologist'::"text", 'psychiatrist'::"text", 'nephrologist'::"text", 'hiv_counselor'::"text", 'art_clinician'::"text", 'obstetrician'::"text", 'paediatrician'::"text", 'theatre_nurse'::"text", 'icu_nurse'::"text", 'chw'::"text", 'social_worker'::"text", 'pharmacy_admin'::"text", 'pharmacy_staff'::"text", 'pharmacy_cashier'::"text", 'pharmacy_store_manager'::"text"]))),
    CONSTRAINT "profiles_verification_status_check" CHECK (("verification_status" = ANY (ARRAY['pending'::"text", 'under_review'::"text", 'verified'::"text", 'rejected'::"text"])))
);


ALTER TABLE "public"."profiles" OWNER TO "postgres";


COMMENT ON TABLE "public"."profiles" IS 'Application user profiles. IDs are owned by Synapse custom auth; rows are not required to exist in auth.users.';



COMMENT ON COLUMN "public"."profiles"."role" IS 'platform_admin | hospital_admin | doctor | clinical_officer | nurse | receptionist | pharmacist | lab_tech';



COMMENT ON COLUMN "public"."profiles"."email_verified_at" IS 'Set after the user follows the custom Synapse OS email activation link.';



COMMENT ON COLUMN "public"."profiles"."activation_sent_at" IS 'Timestamp for the latest outbound activation email.';



CREATE TABLE IF NOT EXISTS "public"."provider_verification_checks" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "provider_id" "uuid" NOT NULL,
    "check_type" "text" NOT NULL,
    "status" "text" NOT NULL,
    "details" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "checked_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "timezone"('utc'::"text", "now"()) NOT NULL,
    "tenant_id" "uuid",
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "created_by" "uuid",
    "is_deleted" boolean DEFAULT false,
    CONSTRAINT "provider_verification_checks_check_type_check" CHECK (("check_type" = ANY (ARRAY['document'::"text", 'registry'::"text", 'identity'::"text", 'manual_review'::"text"]))),
    CONSTRAINT "provider_verification_checks_status_check" CHECK (("status" = ANY (ARRAY['pending'::"text", 'passed'::"text", 'failed'::"text"])))
);


ALTER TABLE "public"."provider_verification_checks" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."purchase_orders" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "supplier_id" "uuid" NOT NULL,
    "hospital_id" "uuid" NOT NULL,
    "order_date" "date" DEFAULT CURRENT_DATE NOT NULL,
    "total_amount" numeric DEFAULT 0 NOT NULL,
    "status" "text" DEFAULT 'draft'::"text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "timezone"('utc'::"text", "now"()) NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "timezone"('utc'::"text", "now"()) NOT NULL,
    "tenant_id" "uuid",
    "created_by" "uuid",
    "is_deleted" boolean DEFAULT false,
    CONSTRAINT "purchase_orders_status_check" CHECK (("status" = ANY (ARRAY['draft'::"text", 'sent'::"text", 'received'::"text", 'cancelled'::"text"])))
);


ALTER TABLE "public"."purchase_orders" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."radiology_report_templates" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "hospital_id" "uuid",
    "name" "text" NOT NULL,
    "modality" "text" NOT NULL,
    "body_part" "text",
    "is_system" boolean DEFAULT false NOT NULL,
    "sections" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "created_by" "uuid",
    "is_active" boolean DEFAULT true NOT NULL,
    "created_at" timestamp with time zone DEFAULT "timezone"('utc'::"text", "now"()) NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "timezone"('utc'::"text", "now"()) NOT NULL,
    "tenant_id" "uuid",
    "is_deleted" boolean DEFAULT false
);


ALTER TABLE "public"."radiology_report_templates" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."radiology_reports" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "encounter_id" "uuid" NOT NULL,
    "radiographer_id" "uuid",
    "modality" "text" NOT NULL,
    "body_part" "text",
    "findings" "text" NOT NULL,
    "impression" "text",
    "created_at" timestamp with time zone DEFAULT "timezone"('utc'::"text", "now"()) NOT NULL,
    "hospital_id" "uuid",
    "study_id" "uuid",
    "radiologist_id" "uuid",
    "clinical_history" "text",
    "technique" "text",
    "recommendation" "text",
    "ai_draft_findings" "text",
    "ai_draft_impression" "text",
    "ai_model" "text",
    "ai_confidence" numeric(4,3),
    "ai_generated_at" timestamp with time zone,
    "reported_at" timestamp with time zone,
    "status" "text" DEFAULT 'draft'::"text" NOT NULL,
    "is_critical" boolean DEFAULT false NOT NULL,
    "report_pdf_path" "text",
    "updated_at" timestamp with time zone DEFAULT "timezone"('utc'::"text", "now"()) NOT NULL,
    "tenant_id" "uuid",
    "created_by" "uuid",
    "is_deleted" boolean DEFAULT false
);


ALTER TABLE "public"."radiology_reports" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."reasoning_actions" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "session_id" "uuid" NOT NULL,
    "hypothesis_id" "uuid" NOT NULL,
    "tenant_id" "uuid" NOT NULL,
    "action" "text" NOT NULL,
    "clinician_id" "uuid" NOT NULL,
    "reason" "text",
    "diagnosis_id" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "reasoning_actions_action_check" CHECK (("action" = ANY (ARRAY['confirm'::"text", 'override'::"text", 'reject'::"text"])))
);


ALTER TABLE "public"."reasoning_actions" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."reasoning_audit" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "session_id" "uuid" NOT NULL,
    "tenant_id" "uuid" NOT NULL,
    "event_type" "text" NOT NULL,
    "actor_id" "uuid",
    "payload" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."reasoning_audit" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."reasoning_context_snapshots" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "session_id" "uuid" NOT NULL,
    "tenant_id" "uuid" NOT NULL,
    "patient_id" "uuid" NOT NULL,
    "encounter_id" "uuid",
    "snapshot_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "chief_complaint" "text",
    "age" integer,
    "sex" "text",
    "vitals" "jsonb",
    "active_patterns" "jsonb",
    "recent_outcomes" "jsonb",
    "active_meds" "jsonb",
    "recent_labs" "jsonb",
    "insurance_context" "jsonb",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."reasoning_context_snapshots" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."reasoning_evidence" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "session_id" "uuid" NOT NULL,
    "tenant_id" "uuid" NOT NULL,
    "source" "text" NOT NULL,
    "description" "text" NOT NULL,
    "value" "text",
    "present" boolean DEFAULT true NOT NULL,
    "added_by" "uuid" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "reasoning_evidence_source_check" CHECK (("source" = ANY (ARRAY['symptom'::"text", 'sign'::"text", 'lab'::"text", 'imaging'::"text", 'history'::"text", 'vital'::"text"])))
);


ALTER TABLE "public"."reasoning_evidence" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."reasoning_evidence_impact" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "session_id" "uuid" NOT NULL,
    "hypothesis_id" "uuid" NOT NULL,
    "evidence_id" "uuid" NOT NULL,
    "likelihood_ratio" numeric(10,4) NOT NULL,
    "computed_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "reasoning_evidence_impact_likelihood_ratio_check" CHECK (("likelihood_ratio" > (0)::numeric))
);


ALTER TABLE "public"."reasoning_evidence_impact" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."reasoning_hypotheses" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "session_id" "uuid" NOT NULL,
    "tenant_id" "uuid" NOT NULL,
    "condition_name" "text" NOT NULL,
    "icd11_code" "text",
    "icd11_uri" "text",
    "prior_probability" numeric(6,4) DEFAULT 0.001 NOT NULL,
    "posterior_probability" numeric(6,4),
    "harm_if_missed" numeric(5,4) DEFAULT 0.5 NOT NULL,
    "expected_harm" numeric(5,4),
    "cant_miss" boolean DEFAULT false NOT NULL,
    "status" "text" DEFAULT 'active'::"text" NOT NULL,
    "ai_reasoning" "text",
    "confidence" numeric(5,4),
    "rank" integer,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "reasoning_hypotheses_confidence_check" CHECK ((("confidence" IS NULL) OR (("confidence" >= (0)::numeric) AND ("confidence" <= (1)::numeric)))),
    CONSTRAINT "reasoning_hypotheses_harm_if_missed_check" CHECK ((("harm_if_missed" >= (0)::numeric) AND ("harm_if_missed" <= (1)::numeric))),
    CONSTRAINT "reasoning_hypotheses_posterior_probability_check" CHECK ((("posterior_probability" IS NULL) OR (("posterior_probability" > (0)::numeric) AND ("posterior_probability" < (1)::numeric)))),
    CONSTRAINT "reasoning_hypotheses_prior_probability_check" CHECK ((("prior_probability" > (0)::numeric) AND ("prior_probability" < (1)::numeric))),
    CONSTRAINT "reasoning_hypotheses_status_check" CHECK (("status" = ANY (ARRAY['active'::"text", 'confirmed'::"text", 'overridden'::"text", 'rejected'::"text"])))
);


ALTER TABLE "public"."reasoning_hypotheses" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."reasoning_sessions" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "encounter_id" "uuid" NOT NULL,
    "tenant_id" "uuid" NOT NULL,
    "created_by" "uuid" NOT NULL,
    "status" "text" DEFAULT 'active'::"text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "reasoning_sessions_status_check" CHECK (("status" = ANY (ARRAY['active'::"text", 'completed'::"text", 'abandoned'::"text"])))
);


ALTER TABLE "public"."reasoning_sessions" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."referral_requests" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "from_hospital_id" "uuid" NOT NULL,
    "to_hospital_id" "uuid",
    "patient_id" "uuid",
    "mrn" character varying(40),
    "patient_name" "text",
    "age_years" integer,
    "sex" character varying(10),
    "reason" "text" NOT NULL,
    "diagnosis_icd11" character varying(20),
    "urgency" character varying(20) DEFAULT 'routine'::character varying NOT NULL,
    "bed_type_requested" character varying(30),
    "clinical_summary" "text",
    "status" character varying(30) DEFAULT 'pending'::character varying NOT NULL,
    "declined_reason" "text",
    "bed_id" "uuid",
    "reserved_until" timestamp with time zone,
    "transport_arranged" boolean DEFAULT false,
    "transport_type" character varying(30),
    "departed_at" timestamp with time zone,
    "arrived_at" timestamp with time zone,
    "referred_by" "uuid",
    "accepted_by" "uuid",
    "notes" "text",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "tenant_id" "uuid",
    "created_by" "uuid",
    "is_deleted" boolean DEFAULT false
);


ALTER TABLE "public"."referral_requests" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."refill_reminders" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "tenant_id" "uuid" NOT NULL,
    "customer_id" "uuid",
    "drug_name" "text" NOT NULL,
    "last_dispensed" "date",
    "refill_due_date" "date" NOT NULL,
    "interval_days" integer DEFAULT 30,
    "reminder_sent" boolean DEFAULT false,
    "last_reminder_sent_at" timestamp with time zone,
    "dispensed" boolean DEFAULT false,
    "dispensed_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"()
);


ALTER TABLE "public"."refill_reminders" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."renal_adjustments_catalog" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "drug_atc" "text" NOT NULL,
    "creatinine_clearance_min" integer NOT NULL,
    "creatinine_clearance_max" integer NOT NULL,
    "dose_adjustment" numeric(6,3) NOT NULL,
    "frequency_adjustment" "text",
    "recommendation" "text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "timezone"('utc'::"text", "now"()) NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "timezone"('utc'::"text", "now"()) NOT NULL,
    "tenant_id" "uuid",
    "created_by" "uuid",
    "is_deleted" boolean DEFAULT false
);


ALTER TABLE "public"."renal_adjustments_catalog" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."restaurants" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "name" "text" NOT NULL,
    "rating" numeric DEFAULT 0,
    "delivery_time" "text",
    "image_url" "text",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "tenant_id" "uuid",
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "created_by" "uuid",
    "is_deleted" boolean DEFAULT false
);


ALTER TABLE "public"."restaurants" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."role_capabilities" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "role" "text" NOT NULL,
    "facility_type" "text" DEFAULT 'any'::"text" NOT NULL,
    "capability_id" "uuid" NOT NULL,
    "granted_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."role_capabilities" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."role_hierarchy" (
    "role" "text" NOT NULL,
    "inherits" "text" NOT NULL
);


ALTER TABLE "public"."role_hierarchy" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."rule_executions" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "rule_id" "text" NOT NULL,
    "patient_id" "uuid",
    "encounter_id" "uuid",
    "input_data" "jsonb" NOT NULL,
    "output" "jsonb" NOT NULL,
    "executed_at" timestamp with time zone DEFAULT "timezone"('utc'::"text", "now"()) NOT NULL,
    "triggered_at" timestamp with time zone DEFAULT "timezone"('utc'::"text", "now"()) NOT NULL,
    "was_blocked" boolean DEFAULT false NOT NULL,
    "overridden_by" "uuid",
    "override_reason" "text",
    "metadata" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "tenant_id" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "created_by" "uuid",
    "is_deleted" boolean DEFAULT false
);


ALTER TABLE "public"."rule_executions" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."scan_events" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "device_id" "uuid",
    "hospital_id" "uuid",
    "scanned_by" "uuid",
    "scan_type" "text" NOT NULL,
    "barcode" "text" NOT NULL,
    "barcode_format" "text" DEFAULT 'QR'::"text" NOT NULL,
    "patient_id" "uuid",
    "resolved_entity" "text",
    "resolved_id" "uuid",
    "outcome" "text" DEFAULT 'success'::"text" NOT NULL,
    "detail" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "scanned_at" timestamp with time zone DEFAULT "timezone"('utc'::"text", "now"()) NOT NULL,
    "tenant_id" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "created_by" "uuid",
    "is_deleted" boolean DEFAULT false,
    CONSTRAINT "scan_events_outcome_check" CHECK (("outcome" = ANY (ARRAY['success'::"text", 'not_found'::"text", 'mismatch'::"text", 'error'::"text"]))),
    CONSTRAINT "scan_events_scan_type_check" CHECK (("scan_type" = ANY (ARRAY['medication_verify'::"text", 'stock_receive'::"text", 'stock_dispense'::"text", 'bed_clean'::"text", 'patient_id'::"text", 'asset_track'::"text"])))
);


ALTER TABLE "public"."scan_events" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."score_calculations" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "tenant_id" "uuid" NOT NULL,
    "patient_id" "uuid" NOT NULL,
    "encounter_id" "uuid",
    "score_definition_code" "text" NOT NULL,
    "calculated_by" "uuid",
    "parameters_input" "jsonb" NOT NULL,
    "calculated_value" numeric,
    "calculated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "ai_interpretation" "text",
    "ai_confidence" numeric(3,2),
    "ai_model_used" "text",
    "ai_guideline_citation" "text",
    "final_interpretation" "text",
    "final_severity" "text",
    "overridden_by" "uuid",
    "override_reason" "text",
    "overridden_at" timestamp with time zone,
    "is_self_assessment" boolean DEFAULT false NOT NULL,
    "shared_with_provider" boolean DEFAULT false NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "version" integer DEFAULT 1 NOT NULL,
    CONSTRAINT "score_calculations_final_severity_check" CHECK (("final_severity" = ANY (ARRAY['low'::"text", 'moderate'::"text", 'high'::"text", 'critical'::"text", 'normal'::"text"])))
);


ALTER TABLE "public"."score_calculations" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."score_definitions" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "code" "text" NOT NULL,
    "name" "text" NOT NULL,
    "description" "text",
    "category" "text" NOT NULL,
    "version" "text",
    "parameters" "jsonb" NOT NULL,
    "calculation_logic" "text",
    "interpretation_ranges" "jsonb",
    "reference_url" "text",
    "is_active" boolean DEFAULT true NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."score_definitions" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."sdg_indicators" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "hospital_id" "uuid",
    "goal_number" integer NOT NULL,
    "indicator_key" "text" NOT NULL,
    "value" numeric NOT NULL,
    "unit" "text",
    "metadata" "jsonb" DEFAULT '{}'::"jsonb",
    "recorded_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "sdg_indicators_goal_number_check" CHECK ((("goal_number" >= 1) AND ("goal_number" <= 17)))
);


ALTER TABLE "public"."sdg_indicators" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."sdg_reports" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "hospital_id" "uuid",
    "report_type" "text" NOT NULL,
    "format" "text" DEFAULT 'pdf'::"text" NOT NULL,
    "generated_by" "uuid",
    "storage_path" "text",
    "metadata" "jsonb" DEFAULT '{}'::"jsonb",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."sdg_reports" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."sentinel_alerts" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "hospital_id" "uuid" NOT NULL,
    "alert_type" character varying(40) NOT NULL,
    "trigger_count" integer NOT NULL,
    "window_hours" integer NOT NULL,
    "icd11_codes" "text"[],
    "details" "jsonb",
    "severity" character varying(20) DEFAULT 'high'::character varying,
    "status" character varying(20) DEFAULT 'open'::character varying,
    "acknowledged_by" "uuid",
    "acknowledged_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "tenant_id" "uuid",
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "created_by" "uuid",
    "is_deleted" boolean DEFAULT false
);


ALTER TABLE "public"."sentinel_alerts" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."service_catalog" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "name" "text" NOT NULL,
    "service_type" "text" DEFAULT 'consultation'::"text" NOT NULL,
    "price" numeric DEFAULT 0 NOT NULL,
    "currency" "text" DEFAULT 'UGX'::"text" NOT NULL,
    "is_active" boolean DEFAULT true NOT NULL,
    "created_at" timestamp with time zone DEFAULT "timezone"('utc'::"text", "now"()) NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "timezone"('utc'::"text", "now"()) NOT NULL,
    "tenant_id" "uuid",
    "created_by" "uuid",
    "is_deleted" boolean DEFAULT false
);


ALTER TABLE "public"."service_catalog" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."staff_attendance" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "profile_id" "uuid" NOT NULL,
    "hospital_id" "uuid" NOT NULL,
    "check_in" timestamp with time zone DEFAULT "timezone"('utc'::"text", "now"()) NOT NULL,
    "check_out" timestamp with time zone,
    "status" "text" DEFAULT 'present'::"text" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "timezone"('utc'::"text", "now"()) NOT NULL,
    "tenant_id" "uuid",
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "created_by" "uuid",
    "is_deleted" boolean DEFAULT false,
    CONSTRAINT "staff_attendance_status_check" CHECK (("status" = ANY (ARRAY['present'::"text", 'late'::"text", 'on_leave'::"text"])))
);


ALTER TABLE "public"."staff_attendance" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."staff_invitations" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "tenant_id" "uuid" NOT NULL,
    "email" "text" NOT NULL,
    "role" "text" NOT NULL,
    "token" "text" NOT NULL,
    "invited_by" "uuid",
    "accepted_at" timestamp with time zone,
    "expires_at" timestamp with time zone NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."staff_invitations" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."staff_leave_requests" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "profile_id" "uuid" NOT NULL,
    "leave_type" "text" NOT NULL,
    "start_date" "date" NOT NULL,
    "end_date" "date" NOT NULL,
    "status" "text" DEFAULT 'pending'::"text" NOT NULL,
    "reason" "text",
    "approved_by" "uuid",
    "created_at" timestamp with time zone DEFAULT "timezone"('utc'::"text", "now"()) NOT NULL,
    "tenant_id" "uuid",
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "created_by" "uuid",
    "is_deleted" boolean DEFAULT false,
    CONSTRAINT "staff_leave_requests_leave_type_check" CHECK (("leave_type" = ANY (ARRAY['annual'::"text", 'sick'::"text", 'maternity'::"text", 'paternity'::"text", 'study'::"text", 'emergency'::"text"]))),
    CONSTRAINT "staff_leave_requests_status_check" CHECK (("status" = ANY (ARRAY['pending'::"text", 'approved'::"text", 'declined'::"text"])))
);


ALTER TABLE "public"."staff_leave_requests" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."staff_scope_assignments" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "profile_id" "uuid" NOT NULL,
    "role" "text" NOT NULL,
    "organization_id" "uuid",
    "tenant_id" "uuid",
    "site_id" "uuid",
    "department_id" "uuid",
    "is_active" boolean DEFAULT true NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "staff_scope_has_scope" CHECK ((("organization_id" IS NOT NULL) OR ("tenant_id" IS NOT NULL) OR ("site_id" IS NOT NULL) OR ("department_id" IS NOT NULL)))
);


ALTER TABLE "public"."staff_scope_assignments" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."subscription_events" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "tenant_id" "uuid" NOT NULL,
    "from_status" "text",
    "to_status" "text",
    "reason" "text",
    "actor" "text",
    "metadata" "jsonb" DEFAULT '{}'::"jsonb",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."subscription_events" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."subscription_grants" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "subject_type" "text" NOT NULL,
    "subject_id" "uuid" NOT NULL,
    "tenant_id" "uuid",
    "facility_id" "uuid",
    "plan_id" "uuid",
    "grant_type" "text" DEFAULT 'MANUAL'::"text" NOT NULL,
    "starts_at" timestamp with time zone NOT NULL,
    "ends_at" timestamp with time zone NOT NULL,
    "status" "text" DEFAULT 'SCHEDULED'::"text" NOT NULL,
    "reason" "text" NOT NULL,
    "notes" "text",
    "created_by" "uuid" NOT NULL,
    "approved_by" "uuid",
    "source" "text" DEFAULT 'PLATFORM_ADMIN'::"text" NOT NULL,
    "metadata" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "revoked_at" timestamp with time zone,
    "revoked_by" "uuid",
    "revoke_reason" "text",
    "idempotency_key" "text",
    CONSTRAINT "subscription_grants_check" CHECK (("ends_at" > "starts_at")),
    CONSTRAINT "subscription_grants_grant_type_check" CHECK (("grant_type" = ANY (ARRAY['MANUAL'::"text", 'TRIAL'::"text", 'PROMOTIONAL'::"text", 'COMPASSIONATE'::"text", 'STAFF'::"text", 'PARTNER'::"text", 'PILOT'::"text", 'OTHER'::"text"]))),
    CONSTRAINT "subscription_grants_status_check" CHECK (("status" = ANY (ARRAY['SCHEDULED'::"text", 'ACTIVE'::"text", 'EXPIRED'::"text", 'REVOKED'::"text", 'CANCELLED'::"text"]))),
    CONSTRAINT "subscription_grants_subject_type_check" CHECK (("subject_type" = ANY (ARRAY['USER'::"text", 'TENANT'::"text", 'FACILITY'::"text", 'PHARMACY'::"text", 'LABORATORY'::"text", 'CLINIC'::"text", 'HOSPITAL'::"text", 'ORGANIZATION'::"text"])))
);


ALTER TABLE "public"."subscription_grants" OWNER TO "postgres";


COMMENT ON TABLE "public"."subscription_grants" IS 'Manual entitlement grants. Grants do not represent payments and never modify subscription_payments.';



CREATE TABLE IF NOT EXISTS "public"."subscription_invoices" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "tenant_id" "uuid" NOT NULL,
    "payment_id" "uuid",
    "plan_id" "uuid",
    "invoice_no" "text" NOT NULL,
    "amount_ugx" numeric NOT NULL,
    "currency" "text" DEFAULT 'UGX'::"text" NOT NULL,
    "period_start" timestamp with time zone,
    "period_end" timestamp with time zone,
    "issued_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "metadata" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."subscription_invoices" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."subscription_payments" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "tenant_id" "uuid" NOT NULL,
    "subscription_id" "uuid",
    "plan_id" "uuid",
    "amount_ugx" numeric NOT NULL,
    "currency" "text" DEFAULT 'UGX'::"text" NOT NULL,
    "method" "text",
    "provider" "text" DEFAULT 'flutterwave'::"text" NOT NULL,
    "provider_tx_ref" "text",
    "provider_tx_id" "text",
    "status" "text" DEFAULT 'pending'::"text" NOT NULL,
    "period_start" timestamp with time zone,
    "period_end" timestamp with time zone,
    "raw_payload" "jsonb",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "confirmed_at" timestamp with time zone,
    CONSTRAINT "subscription_payments_status_check" CHECK (("status" = ANY (ARRAY['pending'::"text", 'successful'::"text", 'failed'::"text", 'refunded'::"text"])))
);


ALTER TABLE "public"."subscription_payments" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."subscription_plans" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "slug" "text" NOT NULL,
    "name" "text" NOT NULL,
    "facility_type" "text" NOT NULL,
    "price_usd" numeric(10,2),
    "billing_cycle" "text" DEFAULT 'monthly'::"text" NOT NULL,
    "is_active" boolean DEFAULT true NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "price_ugx" numeric,
    CONSTRAINT "subscription_plans_billing_cycle_check" CHECK (("billing_cycle" = ANY (ARRAY['monthly'::"text", 'quarterly'::"text", 'yearly'::"text"])))
);


ALTER TABLE "public"."subscription_plans" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."suppliers" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "name" "text" NOT NULL,
    "contact_person" "text",
    "email" "text",
    "phone" "text",
    "category" "text",
    "is_active" boolean DEFAULT true NOT NULL,
    "created_at" timestamp with time zone DEFAULT "timezone"('utc'::"text", "now"()) NOT NULL,
    "tenant_id" "uuid",
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "created_by" "uuid",
    "is_deleted" boolean DEFAULT false,
    CONSTRAINT "suppliers_category_check" CHECK (("category" = ANY (ARRAY['pharmaceuticals'::"text", 'lab_supplies'::"text", 'surgical_instruments'::"text", 'general_maintenance'::"text"])))
);


ALTER TABLE "public"."suppliers" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."support_ticket_events" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "ticket_id" "uuid" NOT NULL,
    "actor_id" "uuid",
    "event" "text" NOT NULL,
    "metadata" "jsonb" DEFAULT '{}'::"jsonb",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."support_ticket_events" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."support_tickets" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "tenant_id" "uuid",
    "title" "text" NOT NULL,
    "description" "text",
    "priority" "text" DEFAULT 'medium'::"text" NOT NULL,
    "status" "text" DEFAULT 'open'::"text" NOT NULL,
    "assigned_to" "uuid",
    "resolution_notes" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "support_tickets_priority_check" CHECK (("priority" = ANY (ARRAY['low'::"text", 'medium'::"text", 'high'::"text", 'critical'::"text"]))),
    CONSTRAINT "support_tickets_status_check" CHECK (("status" = ANY (ARRAY['open'::"text", 'in_progress'::"text", 'resolved'::"text", 'closed'::"text"])))
);


ALTER TABLE "public"."support_tickets" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."surgery_schedules" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "patient_id" "uuid" NOT NULL,
    "hospital_id" "uuid" NOT NULL,
    "procedure_name" "text" NOT NULL,
    "surgeon_id" "uuid",
    "anesthesiologist_id" "uuid",
    "scheduled_at" timestamp with time zone NOT NULL,
    "status" "text" DEFAULT 'scheduled'::"text" NOT NULL,
    "checklist_completed" boolean DEFAULT false NOT NULL,
    "post_op_notes" "text",
    "created_at" timestamp with time zone DEFAULT "timezone"('utc'::"text", "now"()) NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "timezone"('utc'::"text", "now"()) NOT NULL,
    "tenant_id" "uuid",
    "created_by" "uuid",
    "is_deleted" boolean DEFAULT false,
    "pre_op_checklist" "jsonb" DEFAULT '{}'::"jsonb",
    "instrument_count_pre" "jsonb" DEFAULT '{}'::"jsonb",
    "instrument_count_post" "jsonb" DEFAULT '{}'::"jsonb",
    "implants_used" "text",
    "intraop_complications" "text",
    "actual_start" timestamp with time zone,
    "actual_end" timestamp with time zone,
    CONSTRAINT "surgery_schedules_status_check" CHECK (("status" = ANY (ARRAY['scheduled'::"text", 'in_progress'::"text", 'completed'::"text", 'cancelled'::"text"])))
);


ALTER TABLE "public"."surgery_schedules" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."surveillance_reports" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "report_ref" "text" DEFAULT ('RPT-'::"text" || "upper"("substring"(("gen_random_uuid"())::"text", 1, 8))),
    "tenant_id" "uuid",
    "is_anonymous" boolean DEFAULT true,
    "symptoms" "text"[] NOT NULL,
    "duration" "text",
    "severity" "text",
    "district" "text",
    "lat" numeric,
    "lng" numeric,
    "household_affected" boolean,
    "recent_travel" boolean,
    "travel_location" "text",
    "reviewed" boolean DEFAULT false,
    "created_at" timestamp with time zone DEFAULT "now"(),
    CONSTRAINT "surveillance_reports_severity_check" CHECK (("severity" = ANY (ARRAY['mild'::"text", 'moderate'::"text", 'severe'::"text"])))
);


ALTER TABLE "public"."surveillance_reports" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."synapse_adapters" (
    "id" "text" NOT NULL,
    "name" "text" NOT NULL,
    "system" "text" NOT NULL,
    "mode" "text" NOT NULL,
    "simulation" boolean DEFAULT true NOT NULL,
    "version" "text" NOT NULL,
    "status" "text" DEFAULT 'simulation'::"text" NOT NULL,
    "last_success_at" timestamp with time zone,
    "last_failure_at" timestamp with time zone,
    "messages_today" integer DEFAULT 0 NOT NULL,
    "failed_today" integer DEFAULT 0 NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "synapse_adapters_mode_check" CHECK (("mode" = ANY (ARRAY['native'::"text", 'overlay'::"text", 'network'::"text"])))
);


ALTER TABLE "public"."synapse_adapters" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."synapse_domain_events" (
    "event_id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "event_type" "text" NOT NULL,
    "version" "text" DEFAULT '1.0.0'::"text" NOT NULL,
    "tenant_id" "uuid" NOT NULL,
    "facility_id" "uuid",
    "actor_id" "uuid",
    "patient_id" "uuid",
    "person_id" "uuid",
    "encounter_id" "uuid",
    "occurred_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "correlation_id" "uuid" NOT NULL,
    "causation_id" "uuid",
    "payload" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "source" "text" NOT NULL,
    "idempotency_key" "text" NOT NULL,
    "is_synthetic" boolean DEFAULT false NOT NULL,
    "simulation_run_id" "uuid",
    "status" "text" DEFAULT 'pending'::"text" NOT NULL,
    "retry_count" integer DEFAULT 0 NOT NULL,
    "last_error" "text",
    "published_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "synapse_domain_events_status_check" CHECK (("status" = ANY (ARRAY['pending'::"text", 'published'::"text", 'failed'::"text", 'dead'::"text"])))
);


ALTER TABLE "public"."synapse_domain_events" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."synapse_sessions" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid" NOT NULL,
    "token_hash" "text" NOT NULL,
    "app" "text" NOT NULL,
    "ip_address" "text",
    "user_agent" "text",
    "expires_at" timestamp with time zone NOT NULL,
    "revoked_at" timestamp with time zone,
    "last_used_at" timestamp with time zone DEFAULT "now"(),
    "created_at" timestamp with time zone DEFAULT "now"(),
    "mfa_assured_at" timestamp with time zone,
    CONSTRAINT "synapse_sessions_app_check" CHECK (("app" = ANY (ARRAY['web'::"text", 'pharmacy'::"text", 'mobile'::"text", 'api'::"text"])))
);


ALTER TABLE "public"."synapse_sessions" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."synapse_simulation_runs" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "seed" bigint NOT NULL,
    "scenario" "text" NOT NULL,
    "tenant_id" "uuid" NOT NULL,
    "actor_id" "uuid",
    "correlation_id" "uuid" NOT NULL,
    "status" "text" DEFAULT 'running'::"text" NOT NULL,
    "pause_at" "text",
    "is_synthetic" boolean DEFAULT true NOT NULL,
    "data_classification" "text" DEFAULT 'synthetic'::"text" NOT NULL,
    "snapshot" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "completed_at" timestamp with time zone,
    CONSTRAINT "synapse_simulation_runs_status_check" CHECK (("status" = ANY (ARRAY['running'::"text", 'paused'::"text", 'completed'::"text", 'failed'::"text"])))
);


ALTER TABLE "public"."synapse_simulation_runs" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."sync_conflicts" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "table_name" character varying(60) NOT NULL,
    "record_id" "uuid" NOT NULL,
    "hospital_id" "uuid",
    "client_version" integer NOT NULL,
    "server_version" integer NOT NULL,
    "client_data" "jsonb" NOT NULL,
    "server_data" "jsonb" NOT NULL,
    "status" character varying(30) DEFAULT 'pending'::character varying NOT NULL,
    "resolution_strategy" character varying(30),
    "resolved_data" "jsonb",
    "resolved_by" "uuid",
    "resolved_at" timestamp with time zone,
    "client_device_id" character varying(80),
    "client_synced_at" timestamp with time zone,
    "auto_resolved" boolean DEFAULT false,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "tenant_id" "uuid",
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "created_by" "uuid",
    "is_deleted" boolean DEFAULT false
);


ALTER TABLE "public"."sync_conflicts" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."sync_idempotency_keys" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "scope" "text" NOT NULL,
    "idempotency_key" "text" NOT NULL,
    "response_payload" "jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "tenant_id" "uuid",
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "created_by" "uuid",
    "is_deleted" boolean DEFAULT false
);


ALTER TABLE "public"."sync_idempotency_keys" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."tele_sessions" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "tenant_id" "uuid",
    "patient_app_user_id" "uuid",
    "doctor_id" "uuid",
    "chatbot_answers" "jsonb",
    "triage_level" "text",
    "triage_score" integer,
    "status" "text" DEFAULT 'chatbot'::"text" NOT NULL,
    "scheduled_at" timestamp with time zone,
    "started_at" timestamp with time zone,
    "ended_at" timestamp with time zone,
    "livekit_room_name" "text",
    "transcript" "text",
    "soap_note" "text",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    CONSTRAINT "tele_sessions_status_check" CHECK (("status" = ANY (ARRAY['chatbot'::"text", 'triaged'::"text", 'booked'::"text", 'in_call'::"text", 'completed'::"text", 'cancelled'::"text"]))),
    CONSTRAINT "tele_sessions_triage_level_check" CHECK (("triage_level" = ANY (ARRAY['emergency'::"text", 'urgent'::"text", 'routine'::"text"])))
);


ALTER TABLE "public"."tele_sessions" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."telemedicine_appointments" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "hospital_id" "uuid" NOT NULL,
    "patient_id" "uuid",
    "provider_id" "uuid" NOT NULL,
    "channel" "text" DEFAULT 'chat'::"text" NOT NULL,
    "status" "text" DEFAULT 'scheduled'::"text" NOT NULL,
    "chief_complaint" "text",
    "triage_summary" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "scheduled_for" timestamp with time zone NOT NULL,
    "started_at" timestamp with time zone,
    "ended_at" timestamp with time zone,
    "meeting_room" "text",
    "meeting_url" "text",
    "notes" "text",
    "created_by" "uuid",
    "created_at" timestamp with time zone DEFAULT "timezone"('utc'::"text", "now"()) NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "timezone"('utc'::"text", "now"()) NOT NULL,
    "tenant_id" "uuid",
    "is_deleted" boolean DEFAULT false,
    CONSTRAINT "telemedicine_appointments_channel_check" CHECK (("channel" = ANY (ARRAY['chat'::"text", 'voice'::"text", 'video'::"text"]))),
    CONSTRAINT "telemedicine_appointments_status_check" CHECK (("status" = ANY (ARRAY['scheduled'::"text", 'confirmed'::"text", 'in_progress'::"text", 'completed'::"text", 'cancelled'::"text", 'no_show'::"text"])))
);


ALTER TABLE "public"."telemedicine_appointments" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."telemedicine_followups" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "case_id" "uuid" NOT NULL,
    "hospital_id" "uuid",
    "followup_type" "text" DEFAULT 'referral_check_in'::"text" NOT NULL,
    "status" "text" DEFAULT 'pending'::"text" NOT NULL,
    "due_at" timestamp with time zone NOT NULL,
    "sent_at" timestamp with time zone,
    "attempts" integer DEFAULT 0 NOT NULL,
    "max_attempts" integer DEFAULT 3 NOT NULL,
    "payload" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "last_error" "text",
    "created_at" timestamp with time zone DEFAULT "timezone"('utc'::"text", "now"()) NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "timezone"('utc'::"text", "now"()) NOT NULL,
    "tenant_id" "uuid",
    "created_by" "uuid",
    "is_deleted" boolean DEFAULT false,
    CONSTRAINT "telemedicine_followups_followup_type_check" CHECK (("followup_type" = ANY (ARRAY['referral_check_in'::"text", 'telemed_no_show'::"text", 'care_plan_check'::"text"]))),
    CONSTRAINT "telemedicine_followups_status_check" CHECK (("status" = ANY (ARRAY['pending'::"text", 'sent'::"text", 'retry'::"text", 'cancelled'::"text", 'failed'::"text"])))
);


ALTER TABLE "public"."telemedicine_followups" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."telemedicine_frontdesk_queue" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "case_id" "uuid" NOT NULL,
    "hospital_id" "uuid",
    "provider_id" "uuid",
    "patient_id" "uuid",
    "status" "text" DEFAULT 'pending'::"text" NOT NULL,
    "missing_fields" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "captured_payload" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "notes" "text",
    "completed_by" "uuid",
    "created_at" timestamp with time zone DEFAULT "timezone"('utc'::"text", "now"()) NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "timezone"('utc'::"text", "now"()) NOT NULL,
    "completed_at" timestamp with time zone,
    "tenant_id" "uuid",
    "created_by" "uuid",
    "is_deleted" boolean DEFAULT false,
    CONSTRAINT "telemedicine_frontdesk_queue_status_check" CHECK (("status" = ANY (ARRAY['pending'::"text", 'in_progress'::"text", 'completed'::"text", 'cancelled'::"text"])))
);


ALTER TABLE "public"."telemedicine_frontdesk_queue" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."telemedicine_intake_cases" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "user_id" "uuid",
    "hospital_id" "uuid",
    "provider_id" "uuid",
    "patient_id" "uuid",
    "status" "text" DEFAULT 'open'::"text" NOT NULL,
    "urgency" "text" DEFAULT 'routine'::"text" NOT NULL,
    "location_text" "text",
    "symptoms" "text",
    "triage_summary" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "recommendation" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "consent_to_register" boolean DEFAULT false NOT NULL,
    "created_at" timestamp with time zone DEFAULT "timezone"('utc'::"text", "now"()) NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "timezone"('utc'::"text", "now"()) NOT NULL,
    "tenant_id" "uuid",
    "created_by" "uuid",
    "is_deleted" boolean DEFAULT false,
    CONSTRAINT "telemedicine_intake_cases_status_check" CHECK (("status" = ANY (ARRAY['open'::"text", 'referred'::"text", 'arriving'::"text", 'completed'::"text", 'cancelled'::"text"]))),
    CONSTRAINT "telemedicine_intake_cases_urgency_check" CHECK (("urgency" = ANY (ARRAY['routine'::"text", 'priority'::"text", 'urgent'::"text"])))
);


ALTER TABLE "public"."telemedicine_intake_cases" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."telemedicine_intake_messages" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "case_id" "uuid" NOT NULL,
    "role" "text" NOT NULL,
    "content" "text" NOT NULL,
    "metadata" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "timezone"('utc'::"text", "now"()) NOT NULL,
    "tenant_id" "uuid",
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "created_by" "uuid",
    "is_deleted" boolean DEFAULT false,
    CONSTRAINT "telemedicine_intake_messages_role_check" CHECK (("role" = ANY (ARRAY['user'::"text", 'assistant'::"text", 'system'::"text"])))
);


ALTER TABLE "public"."telemedicine_intake_messages" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."telemedicine_providers" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "profile_id" "uuid",
    "hospital_id" "uuid",
    "full_name" "text" NOT NULL,
    "specialty" "text" NOT NULL,
    "council" "text",
    "license_number" "text",
    "country_code" "text" DEFAULT 'UG'::"text",
    "years_experience" integer,
    "bio" "text",
    "languages" "text"[] DEFAULT '{}'::"text"[] NOT NULL,
    "consultation_types" "text"[] DEFAULT '{chat,voice,video}'::"text"[] NOT NULL,
    "verification_status" "text" DEFAULT 'pending'::"text" NOT NULL,
    "verification_method" "text" DEFAULT 'manual'::"text" NOT NULL,
    "verification_metadata" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "is_active" boolean DEFAULT false NOT NULL,
    "rating" numeric(3,2),
    "created_at" timestamp with time zone DEFAULT "timezone"('utc'::"text", "now"()) NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "timezone"('utc'::"text", "now"()) NOT NULL,
    "verified_at" timestamp with time zone,
    "verified_by" "uuid",
    "rejection_reason" "text",
    "tenant_id" "uuid",
    "created_by" "uuid",
    "is_deleted" boolean DEFAULT false,
    "is_available" boolean DEFAULT false NOT NULL,
    "last_seen_at" timestamp with time zone,
    CONSTRAINT "telemedicine_providers_verification_method_check" CHECK (("verification_method" = ANY (ARRAY['manual'::"text", 'registry_lookup'::"text", 'hybrid'::"text"]))),
    CONSTRAINT "telemedicine_providers_verification_status_check" CHECK (("verification_status" = ANY (ARRAY['pending'::"text", 'under_review'::"text", 'verified'::"text", 'rejected'::"text"])))
);


ALTER TABLE "public"."telemedicine_providers" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."telemedicine_session_events" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "appointment_id" "uuid" NOT NULL,
    "event_type" "text" NOT NULL,
    "actor_id" "uuid",
    "payload" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "timezone"('utc'::"text", "now"()) NOT NULL,
    "tenant_id" "uuid",
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "created_by" "uuid",
    "is_deleted" boolean DEFAULT false,
    CONSTRAINT "telemedicine_session_events_event_type_check" CHECK (("event_type" = ANY (ARRAY['chat_message'::"text", 'voice_join'::"text", 'voice_leave'::"text", 'video_join'::"text", 'video_leave'::"text", 'call_started'::"text", 'call_ended'::"text", 'system_note'::"text"])))
);


ALTER TABLE "public"."telemedicine_session_events" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."telemedicine_staff_alerts" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "case_id" "uuid" NOT NULL,
    "hospital_id" "uuid",
    "patient_id" "uuid",
    "department" "text" NOT NULL,
    "priority" "text" DEFAULT 'high'::"text" NOT NULL,
    "status" "text" DEFAULT 'new'::"text" NOT NULL,
    "summary" "text" NOT NULL,
    "sbar" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "payload" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "acknowledged_by" "uuid",
    "acknowledged_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "timezone"('utc'::"text", "now"()) NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "timezone"('utc'::"text", "now"()) NOT NULL,
    "tenant_id" "uuid",
    "created_by" "uuid",
    "is_deleted" boolean DEFAULT false,
    CONSTRAINT "telemedicine_staff_alerts_priority_check" CHECK (("priority" = ANY (ARRAY['medium'::"text", 'high'::"text", 'critical'::"text"]))),
    CONSTRAINT "telemedicine_staff_alerts_status_check" CHECK (("status" = ANY (ARRAY['new'::"text", 'acknowledged'::"text", 'resolved'::"text"])))
);

ALTER TABLE ONLY "public"."telemedicine_staff_alerts" REPLICA IDENTITY FULL;


ALTER TABLE "public"."telemedicine_staff_alerts" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."telemedicine_voice_memos" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "case_id" "uuid" NOT NULL,
    "uploaded_by" "uuid",
    "language" "text",
    "mime_type" "text",
    "duration_seconds" integer,
    "audio_base64" "text",
    "transcript_original" "text",
    "transcript_en" "text",
    "translation_engine" "text",
    "metadata" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "timezone"('utc'::"text", "now"()) NOT NULL,
    "tenant_id" "uuid",
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "created_by" "uuid",
    "is_deleted" boolean DEFAULT false
);


ALTER TABLE "public"."telemedicine_voice_memos" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."tenant_domains" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "hospital_id" "uuid" NOT NULL,
    "tenant_key" "text" NOT NULL,
    "domain" "text" NOT NULL,
    "is_primary" boolean DEFAULT false NOT NULL,
    "is_active" boolean DEFAULT true NOT NULL,
    "metadata" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "created_at" timestamp with time zone DEFAULT "timezone"('utc'::"text", "now"()) NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "timezone"('utc'::"text", "now"()) NOT NULL,
    "provisioning_status" "text" DEFAULT 'active'::"text" NOT NULL,
    "dns_target" "text",
    "verification_token" "text",
    "provisioned_at" timestamp with time zone,
    "last_error" "text",
    "tenant_id" "uuid",
    "created_by" "uuid",
    "is_deleted" boolean DEFAULT false,
    CONSTRAINT "tenant_domains_provisioning_status_check" CHECK (("provisioning_status" = ANY (ARRAY['pending'::"text", 'provisioning'::"text", 'active'::"text", 'failed'::"text"]))),
    CONSTRAINT "tenant_domains_tenant_key_format" CHECK (("tenant_key" ~ '^[a-z0-9-]{2,63}$'::"text"))
);


ALTER TABLE "public"."tenant_domains" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."tenant_feature_overrides" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "tenant_id" "uuid" NOT NULL,
    "feature_key" "text" NOT NULL,
    "enabled" boolean DEFAULT true NOT NULL,
    "value" "jsonb",
    "reason" "text",
    "granted_by" "uuid",
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL
);


ALTER TABLE "public"."tenant_feature_overrides" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."tenant_logging_policies" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "hospital_id" "uuid",
    "module_name" "text" NOT NULL,
    "min_level" "text" DEFAULT 'info'::"text" NOT NULL,
    "pii_strategy" "text" DEFAULT 'mask'::"text" NOT NULL,
    "retention_days" integer DEFAULT 365 NOT NULL,
    "enabled_events" "jsonb" DEFAULT '[]'::"jsonb" NOT NULL,
    "sampling_rate" numeric(4,3) DEFAULT 1.000 NOT NULL,
    "created_at" timestamp with time zone DEFAULT "timezone"('utc'::"text", "now"()) NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "timezone"('utc'::"text", "now"()) NOT NULL,
    "tenant_id" "uuid",
    "created_by" "uuid",
    "is_deleted" boolean DEFAULT false,
    CONSTRAINT "tenant_logging_policies_min_level_check" CHECK (("min_level" = ANY (ARRAY['debug'::"text", 'info'::"text", 'warn'::"text", 'error'::"text"]))),
    CONSTRAINT "tenant_logging_policies_pii_strategy_check" CHECK (("pii_strategy" = ANY (ARRAY['mask'::"text", 'allow'::"text", 'redact'::"text"])))
);


ALTER TABLE "public"."tenant_logging_policies" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."tenant_provisioning_jobs" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "hospital_id" "uuid" NOT NULL,
    "tenant_domain_id" "uuid" NOT NULL,
    "requested_by" "uuid",
    "status" "text" DEFAULT 'pending'::"text" NOT NULL,
    "provider" "text" DEFAULT 'manual'::"text" NOT NULL,
    "attempt_count" integer DEFAULT 0 NOT NULL,
    "next_attempt_at" timestamp with time zone,
    "payload" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "result" "jsonb" DEFAULT '{}'::"jsonb" NOT NULL,
    "last_error" "text",
    "created_at" timestamp with time zone DEFAULT "timezone"('utc'::"text", "now"()) NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "timezone"('utc'::"text", "now"()) NOT NULL,
    "completed_at" timestamp with time zone,
    "tenant_id" "uuid",
    "created_by" "uuid",
    "is_deleted" boolean DEFAULT false,
    CONSTRAINT "tenant_provisioning_jobs_provider_check" CHECK (("provider" = ANY (ARRAY['manual'::"text", 'cloudflare'::"text", 'vercel'::"text"]))),
    CONSTRAINT "tenant_provisioning_jobs_status_check" CHECK (("status" = ANY (ARRAY['pending'::"text", 'running'::"text", 'completed'::"text", 'failed'::"text", 'cancelled'::"text"])))
);


ALTER TABLE "public"."tenant_provisioning_jobs" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."tenant_subscriptions" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "tenant_id" "uuid" NOT NULL,
    "plan_id" "uuid" NOT NULL,
    "status" "text" DEFAULT 'active'::"text" NOT NULL,
    "trial_ends" timestamp with time zone,
    "starts_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "ends_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "now"() NOT NULL,
    "current_period_start" timestamp with time zone,
    "current_period_end" timestamp with time zone,
    "grace_until" timestamp with time zone,
    "last_payment_at" timestamp with time zone,
    "cancel_at_period_end" boolean DEFAULT false,
    CONSTRAINT "tenant_subscriptions_status_check" CHECK (("status" = ANY (ARRAY['trialing'::"text", 'active'::"text", 'past_due'::"text", 'suspended'::"text", 'cancelled'::"text"])))
);


ALTER TABLE "public"."tenant_subscriptions" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."tenants" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "slug" "text" NOT NULL,
    "name" "text" NOT NULL,
    "country_code" character(2) DEFAULT 'UG'::"bpchar",
    "region" "text",
    "status" "text" DEFAULT 'provisioning'::"text",
    "plan" "text" DEFAULT 'trial'::"text",
    "settings" "jsonb" DEFAULT '{}'::"jsonb",
    "data_region" "text" DEFAULT 'af-south-1'::"text",
    "trial_ends_at" timestamp with time zone,
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "address" "text",
    "bed_capacity" integer,
    "is_active" boolean DEFAULT true,
    "onboarding_completed" boolean DEFAULT false,
    "onboarding_step" integer DEFAULT 1,
    "facility_type" "text" DEFAULT 'clinic'::"text",
    "email" "text",
    "phone" "text",
    "district" "text",
    "custom_domain" "text",
    "country" "text" DEFAULT 'UG'::"text",
    "default_subdomain" "text",
    "is_network_member" boolean DEFAULT false,
    "network_listing_name" "text",
    "accepts_refill_requests" boolean DEFAULT false,
    "monthly_fee_ugx" integer DEFAULT 0,
    "subscription_start" timestamp with time zone,
    "subscription_end" timestamp with time zone,
    "logo_url" "text",
    "lat" numeric(9,6),
    "lng" numeric(9,6),
    "modules_enabled" "text"[] DEFAULT '{}'::"text"[],
    "tier" "text" DEFAULT 'trial'::"text",
    "sms_credits" integer DEFAULT 0,
    "organization_id" "uuid",
    "parent_tenant_id" "uuid",
    "facility_mode" "text",
    "digital_maturity_level" integer,
    "site_kind" "text",
    "environment" "text",
    "is_synthetic" boolean DEFAULT false NOT NULL,
    "data_classification" "text",
    "lifecycle_status" "text" DEFAULT 'ACTIVE'::"text" NOT NULL,
    CONSTRAINT "tenants_data_classification_check" CHECK ((("data_classification" IS NULL) OR ("data_classification" = ANY (ARRAY['clinical'::"text", 'synthetic'::"text", 'operational'::"text"])))),
    CONSTRAINT "tenants_environment_check" CHECK ((("environment" IS NULL) OR ("environment" = ANY (ARRAY['production'::"text", 'staging'::"text", 'demo'::"text", 'preview'::"text"])))),
    CONSTRAINT "tenants_facility_mode_check" CHECK ((("facility_mode" IS NULL) OR ("facility_mode" = ANY (ARRAY['NATIVE'::"text", 'CONNECTED'::"text", 'HYBRID'::"text", 'SATELLITE'::"text", 'COMMUNITY_ACCESS'::"text"])))),
    CONSTRAINT "tenants_facility_type_check" CHECK (("facility_type" = ANY (ARRAY['hospital'::"text", 'clinic'::"text", 'health_centre'::"text", 'pharmacy'::"text", 'laboratory'::"text", 'lab'::"text", 'imaging_center'::"text", 'dental'::"text", 'mental_health'::"text"]))),
    CONSTRAINT "tenants_lifecycle_status_check" CHECK (("lifecycle_status" = ANY (ARRAY['ACTIVE'::"text", 'SUSPENDED'::"text", 'ARCHIVED'::"text", 'DELETION_PENDING'::"text", 'DELETED'::"text"]))),
    CONSTRAINT "tenants_maturity_check" CHECK ((("digital_maturity_level" IS NULL) OR (("digital_maturity_level" >= 0) AND ("digital_maturity_level" <= 5)))),
    CONSTRAINT "tenants_plan_check" CHECK (("plan" = ANY (ARRAY['trial'::"text", 'starter'::"text", 'professional'::"text", 'enterprise'::"text"]))),
    CONSTRAINT "tenants_site_kind_check" CHECK ((("site_kind" IS NULL) OR ("site_kind" = ANY (ARRAY['main'::"text", 'satellite'::"text", 'warehouse'::"text", 'community_access'::"text", 'branch'::"text"])))),
    CONSTRAINT "tenants_status_check" CHECK (("status" = ANY (ARRAY['provisioning'::"text", 'active'::"text", 'suspended'::"text", 'trial'::"text"])))
);


ALTER TABLE "public"."tenants" OWNER TO "postgres";


COMMENT ON COLUMN "public"."tenants"."facility_mode" IS 'NATIVE = SYNAPSE is primary EMR/HMS; CONNECTED = external HMS retained; HYBRID = mix; SATELLITE / COMMUNITY_ACCESS are scoped sites.';



COMMENT ON COLUMN "public"."tenants"."is_synthetic" IS 'Demo/simulation tenants only. Production reset APIs must refuse tenants where this is false.';



CREATE TABLE IF NOT EXISTS "public"."ucg_guidelines" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "guideline_code" character varying(40) NOT NULL,
    "title" "text" NOT NULL,
    "category" "text" NOT NULL,
    "subcategory" "text",
    "icd11_codes" "text"[] DEFAULT '{}'::"text"[] NOT NULL,
    "content" "text" NOT NULL,
    "source_page" integer,
    "version" character varying(20) DEFAULT '2023'::character varying NOT NULL,
    "embedding" "public"."vector"(768),
    "created_at" timestamp with time zone DEFAULT "now"(),
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "tenant_id" "uuid",
    "created_by" "uuid",
    "is_deleted" boolean DEFAULT false
);


ALTER TABLE "public"."ucg_guidelines" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."verification_documents" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "profile_id" "uuid" NOT NULL,
    "document_type" "text" NOT NULL,
    "document_url" "text" NOT NULL,
    "status" "text" DEFAULT 'pending'::"text" NOT NULL,
    "notes" "text",
    "created_at" timestamp with time zone DEFAULT "timezone"('utc'::"text", "now"()) NOT NULL,
    "updated_at" timestamp with time zone DEFAULT "timezone"('utc'::"text", "now"()) NOT NULL,
    "tenant_id" "uuid",
    "created_by" "uuid",
    "is_deleted" boolean DEFAULT false,
    CONSTRAINT "verification_documents_status_check" CHECK (("status" = ANY (ARRAY['pending'::"text", 'approved'::"text", 'rejected'::"text"])))
);


ALTER TABLE "public"."verification_documents" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."visitor_log" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "tenant_id" "uuid" NOT NULL,
    "visitor_name" "text" NOT NULL,
    "national_id" "text",
    "host_staff_id" "uuid",
    "host_name" "text",
    "purpose" "text",
    "vehicle_reg" "text",
    "time_in" timestamp with time zone DEFAULT "now"(),
    "time_out" timestamp with time zone,
    "badge_number" "text",
    "logged_by" "uuid",
    "notes" "text"
);


ALTER TABLE "public"."visitor_log" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."vitals" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "encounter_id" "uuid" NOT NULL,
    "recorded_by" "uuid",
    "bp_systolic" numeric,
    "bp_diastolic" numeric,
    "heart_rate" numeric,
    "temperature_c" numeric,
    "spo2" numeric,
    "respiratory_rate" numeric,
    "weight_kg" numeric,
    "height_cm" numeric,
    "creatinine" numeric,
    "egfr" numeric,
    "creatinine_clearance" numeric,
    "alt" numeric,
    "ast" numeric,
    "notes" "text",
    "recorded_at" timestamp with time zone DEFAULT "timezone"('utc'::"text", "now"()) NOT NULL,
    "created_at" timestamp with time zone DEFAULT "timezone"('utc'::"text", "now"()) NOT NULL,
    "version" integer DEFAULT 1 NOT NULL,
    "tenant_id" "uuid",
    "updated_at" timestamp with time zone DEFAULT "now"(),
    "created_by" "uuid",
    "is_deleted" boolean DEFAULT false
);


ALTER TABLE "public"."vitals" OWNER TO "postgres";


CREATE TABLE IF NOT EXISTS "public"."wards" (
    "id" "uuid" DEFAULT "gen_random_uuid"() NOT NULL,
    "hospital_id" "uuid" NOT NULL,
    "name" "text" NOT NULL,
    "capacity" integer DEFAULT 20 NOT NULL,
    "is_active" boolean DEFAULT true NOT NULL,
    "created_at" timestamp with time zone DEFAULT "timezone"('utc'::"text", "now"()) NOT NULL
);


ALTER TABLE "public"."wards" OWNER TO "postgres";


ALTER TABLE ONLY "public"."aefi_reports"
    ADD CONSTRAINT "aefi_reports_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."ai_health_chats"
    ADD CONSTRAINT "ai_health_chats_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."allergens_catalog"
    ADD CONSTRAINT "allergens_catalog_name_key" UNIQUE ("name");



ALTER TABLE ONLY "public"."allergens_catalog"
    ADD CONSTRAINT "allergens_catalog_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."apk_waitlist"
    ADD CONSTRAINT "apk_waitlist_email_key" UNIQUE ("email");



ALTER TABLE ONLY "public"."apk_waitlist"
    ADD CONSTRAINT "apk_waitlist_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."app_vitals"
    ADD CONSTRAINT "app_vitals_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."audit_events"
    ADD CONSTRAINT "audit_events_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."audit_log"
    ADD CONSTRAINT "audit_log_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."auth_otps"
    ADD CONSTRAINT "auth_otps_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."bed_assignments"
    ADD CONSTRAINT "bed_assignments_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."beta_access_requests"
    ADD CONSTRAINT "beta_access_requests_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."billing_invoices"
    ADD CONSTRAINT "billing_invoices_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."billing_line_items"
    ADD CONSTRAINT "billing_line_items_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."billing_payments"
    ADD CONSTRAINT "billing_payments_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."blood_deferrals"
    ADD CONSTRAINT "blood_deferrals_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."blood_donation_profiles"
    ADD CONSTRAINT "blood_donation_profiles_person_id_key" UNIQUE ("person_id");



ALTER TABLE ONLY "public"."blood_donation_profiles"
    ADD CONSTRAINT "blood_donation_profiles_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."blood_donations"
    ADD CONSTRAINT "blood_donations_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."body_register"
    ADD CONSTRAINT "body_register_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."calls"
    ADD CONSTRAINT "calls_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."calls"
    ADD CONSTRAINT "calls_room_name_key" UNIQUE ("room_name");



ALTER TABLE ONLY "public"."capabilities"
    ADD CONSTRAINT "capabilities_module_resource_action_key" UNIQUE ("module", "resource", "action");



ALTER TABLE ONLY "public"."capabilities"
    ADD CONSTRAINT "capabilities_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."care_team_handovers"
    ADD CONSTRAINT "care_team_handovers_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."cds_alerts"
    ADD CONSTRAINT "cds_alerts_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."cds_rules"
    ADD CONSTRAINT "cds_rules_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."chw_visits"
    ADD CONSTRAINT "chw_visits_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."claim_line_items"
    ADD CONSTRAINT "claim_line_items_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."claim_resubmissions"
    ADD CONSTRAINT "claim_resubmissions_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."clinical_intelligence_decisions"
    ADD CONSTRAINT "clinical_intelligence_decisions_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."clinical_intelligence_sessions"
    ADD CONSTRAINT "clinical_intelligence_sessions_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."clinical_note_embeddings"
    ADD CONSTRAINT "clinical_note_embeddings_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."clinical_notes"
    ADD CONSTRAINT "clinical_notes_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."clinical_pathway_templates"
    ADD CONSTRAINT "clinical_pathway_templates_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."clinical_pathway_templates"
    ADD CONSTRAINT "clinical_pathway_templates_slug_hospital_id_key" UNIQUE ("slug", "hospital_id");



ALTER TABLE ONLY "public"."clinical_prescriptions"
    ADD CONSTRAINT "clinical_prescriptions_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."community_health_workers"
    ADD CONSTRAINT "community_health_workers_hospital_id_chw_code_key" UNIQUE ("hospital_id", "chw_code");



ALTER TABLE ONLY "public"."community_health_workers"
    ADD CONSTRAINT "community_health_workers_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."consent_audit_log"
    ADD CONSTRAINT "consent_audit_log_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."consult_queue"
    ADD CONSTRAINT "consult_queue_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."consult_queue"
    ADD CONSTRAINT "consult_queue_token_key" UNIQUE ("token");



ALTER TABLE ONLY "public"."cross_tenant_access"
    ADD CONSTRAINT "cross_tenant_access_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."data_breach_incidents"
    ADD CONSTRAINT "data_breach_incidents_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."data_export_jobs"
    ADD CONSTRAINT "data_export_jobs_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."data_retention_policies"
    ADD CONSTRAINT "data_retention_policies_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."data_retention_policies"
    ADD CONSTRAINT "data_retention_policies_table_name_hospital_id_key" UNIQUE ("table_name", "hospital_id");



ALTER TABLE ONLY "public"."death_registrations"
    ADD CONSTRAINT "death_registrations_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."death_reports"
    ADD CONSTRAINT "death_reports_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."deidentification_profiles"
    ADD CONSTRAINT "deidentification_profiles_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."demo_departments"
    ADD CONSTRAINT "demo_departments_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."demo_encounter_orders"
    ADD CONSTRAINT "demo_encounter_orders_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."demo_encounters"
    ADD CONSTRAINT "demo_encounters_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."demo_lab_results"
    ADD CONSTRAINT "demo_lab_results_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."demo_patients"
    ADD CONSTRAINT "demo_patients_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."demo_vitals"
    ADD CONSTRAINT "demo_vitals_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."denial_analytics_daily"
    ADD CONSTRAINT "denial_analytics_daily_hospital_id_insurer_id_report_date_key" UNIQUE ("hospital_id", "insurer_id", "report_date");



ALTER TABLE ONLY "public"."denial_analytics_daily"
    ADD CONSTRAINT "denial_analytics_daily_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."department_tasks"
    ADD CONSTRAINT "department_tasks_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."departments"
    ADD CONSTRAINT "departments_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."device_alerts"
    ADD CONSTRAINT "device_alerts_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."device_readings"
    ADD CONSTRAINT "device_readings_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."dhis2_data_element_mappings"
    ADD CONSTRAINT "dhis2_data_element_mappings_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."dhis2_export_attempt_log"
    ADD CONSTRAINT "dhis2_export_attempt_log_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."dhis2_export_jobs"
    ADD CONSTRAINT "dhis2_export_jobs_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."dhis2_export_log"
    ADD CONSTRAINT "dhis2_export_log_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."dhis2_org_unit_mappings"
    ADD CONSTRAINT "dhis2_org_unit_mappings_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."dhis2_org_unit_mappings"
    ADD CONSTRAINT "dhis2_org_unit_mappings_tenant_id_local_org_key_key" UNIQUE ("tenant_id", "local_org_key");



ALTER TABLE ONLY "public"."diagnoses"
    ADD CONSTRAINT "diagnoses_icd_code_key" UNIQUE ("icd_code");



ALTER TABLE ONLY "public"."diagnoses"
    ADD CONSTRAINT "diagnoses_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."diet_logs"
    ADD CONSTRAINT "diet_logs_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."doctor_availability_log"
    ADD CONSTRAINT "doctor_availability_log_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."domain_event_consumers"
    ADD CONSTRAINT "domain_event_consumers_pkey" PRIMARY KEY ("consumer_id", "tenant_id");



ALTER TABLE ONLY "public"."domain_events"
    ADD CONSTRAINT "domain_events_pkey" PRIMARY KEY ("event_id");



ALTER TABLE ONLY "public"."drug_contraindications"
    ADD CONSTRAINT "drug_contraindications_drug_code_condition_icd11_key" UNIQUE ("drug_code", "condition_icd11");



ALTER TABLE ONLY "public"."drug_contraindications"
    ADD CONSTRAINT "drug_contraindications_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."drug_dose_adjustments"
    ADD CONSTRAINT "drug_dose_adjustments_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."drug_interactions_catalog"
    ADD CONSTRAINT "drug_interactions_catalog_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."drug_interactions_catalog"
    ADD CONSTRAINT "drug_interactions_catalog_unique_pair" UNIQUE ("drug1_atc", "drug2_atc");



ALTER TABLE ONLY "public"."drug_interactions"
    ADD CONSTRAINT "drug_interactions_drug_a_code_drug_b_code_key" UNIQUE ("drug_a_code", "drug_b_code");



ALTER TABLE ONLY "public"."drug_interactions"
    ADD CONSTRAINT "drug_interactions_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."drug_inventory"
    ADD CONSTRAINT "drug_inventory_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."drug_shortage_alerts"
    ADD CONSTRAINT "drug_shortage_alerts_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."emergency_access_events"
    ADD CONSTRAINT "emergency_access_events_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."emergency_profiles"
    ADD CONSTRAINT "emergency_profiles_person_id_key" UNIQUE ("person_id");



ALTER TABLE ONLY "public"."emergency_profiles"
    ADD CONSTRAINT "emergency_profiles_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."encounter_amendments"
    ADD CONSTRAINT "encounter_amendments_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."encounter_diagnoses"
    ADD CONSTRAINT "encounter_diagnoses_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."encounter_orders"
    ADD CONSTRAINT "encounter_orders_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."encounters"
    ADD CONSTRAINT "encounters_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."expert_rules"
    ADD CONSTRAINT "expert_rules_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."expert_rules"
    ADD CONSTRAINT "expert_rules_rule_id_key" UNIQUE ("rule_id");



ALTER TABLE ONLY "public"."facility_domain_records"
    ADD CONSTRAINT "facility_domain_records_hostname_key" UNIQUE ("hostname");



ALTER TABLE ONLY "public"."facility_domain_records"
    ADD CONSTRAINT "facility_domain_records_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."facility_invitation_audit"
    ADD CONSTRAINT "facility_invitation_audit_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."facility_invitations"
    ADD CONSTRAINT "facility_invitations_invite_token_key" UNIQUE ("invite_token");



ALTER TABLE ONLY "public"."facility_invitations"
    ADD CONSTRAINT "facility_invitations_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."facility_lifecycle_events"
    ADD CONSTRAINT "facility_lifecycle_events_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."facility_locations"
    ADD CONSTRAINT "facility_locations_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."facility_locations"
    ADD CONSTRAINT "facility_locations_tenant_id_code_key" UNIQUE ("tenant_id", "code");



ALTER TABLE ONLY "public"."facility_provisioning_runs"
    ADD CONSTRAINT "facility_provisioning_runs_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."facility_provisioning_steps"
    ADD CONSTRAINT "facility_provisioning_steps_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."facility_provisioning_steps"
    ADD CONSTRAINT "facility_provisioning_steps_run_id_step_key" UNIQUE ("run_id", "step");



ALTER TABLE ONLY "public"."facility_referrals"
    ADD CONSTRAINT "facility_referrals_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."facility_resource_logs"
    ADD CONSTRAINT "facility_resource_logs_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."facility_type_inheritance"
    ADD CONSTRAINT "facility_type_inheritance_pkey" PRIMARY KEY ("facility_type", "includes");



ALTER TABLE ONLY "public"."feature_flags"
    ADD CONSTRAINT "feature_flags_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."gas_cylinders"
    ADD CONSTRAINT "gas_cylinders_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."habit_logs"
    ADD CONSTRAINT "habit_logs_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."handover_patient_entries"
    ADD CONSTRAINT "handover_patient_entries_handover_id_patient_id_key" UNIQUE ("handover_id", "patient_id");



ALTER TABLE ONLY "public"."handover_patient_entries"
    ADD CONSTRAINT "handover_patient_entries_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."handover_shift_tasks"
    ADD CONSTRAINT "handover_shift_tasks_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."handover_signatures"
    ADD CONSTRAINT "handover_signatures_handover_id_signer_id_key" UNIQUE ("handover_id", "signer_id");



ALTER TABLE ONLY "public"."handover_signatures"
    ADD CONSTRAINT "handover_signatures_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."health_bulletins"
    ADD CONSTRAINT "health_bulletins_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."health_habits"
    ADD CONSTRAINT "health_habits_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."hospital_beds"
    ADD CONSTRAINT "hospital_beds_hospital_id_bed_number_key" UNIQUE ("hospital_id", "bed_number");



ALTER TABLE ONLY "public"."hospital_beds"
    ADD CONSTRAINT "hospital_beds_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."hospital_beds"
    ADD CONSTRAINT "hospital_beds_qr_code_key" UNIQUE ("qr_code");



ALTER TABLE ONLY "public"."hospital_drug_orders"
    ADD CONSTRAINT "hospital_drug_orders_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."hospital_leads"
    ADD CONSTRAINT "hospital_leads_contact_email_key" UNIQUE ("contact_email");



ALTER TABLE ONLY "public"."hospital_leads"
    ADD CONSTRAINT "hospital_leads_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."hospital_modules"
    ADD CONSTRAINT "hospital_modules_hospital_id_module_key_key" UNIQUE ("hospital_id", "module_key");



ALTER TABLE ONLY "public"."hospital_modules"
    ADD CONSTRAINT "hospital_modules_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."hospital_seed_registry"
    ADD CONSTRAINT "hospital_seed_registry_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."hospital_seed_registry"
    ADD CONSTRAINT "hospital_seed_registry_slug_key" UNIQUE ("slug");



ALTER TABLE ONLY "public"."hospital_settings"
    ADD CONSTRAINT "hospital_settings_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."hospitals"
    ADD CONSTRAINT "hospitals_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."hospitals"
    ADD CONSTRAINT "hospitals_subdomain_key" UNIQUE ("subdomain");



ALTER TABLE ONLY "public"."housekeeping_tasks"
    ADD CONSTRAINT "housekeeping_tasks_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."icd11_cache"
    ADD CONSTRAINT "icd11_cache_pkey" PRIMARY KEY ("stem_code");



ALTER TABLE ONLY "public"."identity_match_candidates"
    ADD CONSTRAINT "identity_match_candidates_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."identity_merge_events"
    ADD CONSTRAINT "identity_merge_events_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."imaging_series"
    ADD CONSTRAINT "imaging_series_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."imaging_studies"
    ADD CONSTRAINT "imaging_studies_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."imaging_studies"
    ADD CONSTRAINT "imaging_studies_study_uid_key" UNIQUE ("study_uid");



ALTER TABLE ONLY "public"."imid_access_log"
    ADD CONSTRAINT "imid_access_log_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."imid_codes"
    ADD CONSTRAINT "imid_codes_code_key" UNIQUE ("code");



ALTER TABLE ONLY "public"."imid_codes"
    ADD CONSTRAINT "imid_codes_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."immunization_schedule"
    ADD CONSTRAINT "immunization_schedule_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."import_batch_rows"
    ADD CONSTRAINT "import_batch_rows_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."import_batches"
    ADD CONSTRAINT "import_batches_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."import_column_mappings"
    ADD CONSTRAINT "import_column_mappings_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."insurance_benefits"
    ADD CONSTRAINT "insurance_benefits_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."insurance_benefits"
    ADD CONSTRAINT "insurance_benefits_policy_id_benefit_key_key" UNIQUE ("policy_id", "benefit_key");



ALTER TABLE ONLY "public"."insurance_claims"
    ADD CONSTRAINT "insurance_claims_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."insurance_copilot_audit"
    ADD CONSTRAINT "insurance_copilot_audit_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."insurance_coverage_checks"
    ADD CONSTRAINT "insurance_coverage_checks_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."insurance_memberships"
    ADD CONSTRAINT "insurance_memberships_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."insurance_policies"
    ADD CONSTRAINT "insurance_policies_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."insurance_preauthorizations"
    ADD CONSTRAINT "insurance_preauthorizations_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."insurance_providers"
    ADD CONSTRAINT "insurance_providers_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."intelligence_actions"
    ADD CONSTRAINT "intelligence_actions_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."intelligence_recommendations"
    ADD CONSTRAINT "intelligence_recommendations_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."interop_connections"
    ADD CONSTRAINT "interop_connections_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."interop_messages"
    ADD CONSTRAINT "interop_messages_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."inventory_items"
    ADD CONSTRAINT "inventory_items_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."lab_accession_counters"
    ADD CONSTRAINT "lab_accession_counters_pkey" PRIMARY KEY ("tenant_id", "facility_code", "day_key");



ALTER TABLE ONLY "public"."lab_analyzer_messages"
    ADD CONSTRAINT "lab_analyzer_messages_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."lab_critical_acknowledgements"
    ADD CONSTRAINT "lab_critical_acknowledgements_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."lab_device_messages"
    ADD CONSTRAINT "lab_device_messages_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."lab_device_test_mappings"
    ADD CONSTRAINT "lab_device_test_mappings_device_id_analyzer_code_key" UNIQUE ("device_id", "analyzer_code");



ALTER TABLE ONLY "public"."lab_device_test_mappings"
    ADD CONSTRAINT "lab_device_test_mappings_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."lab_devices"
    ADD CONSTRAINT "lab_devices_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."lab_instrument_bridges"
    ADD CONSTRAINT "lab_instrument_bridges_api_key_key" UNIQUE ("api_key");



ALTER TABLE ONLY "public"."lab_instrument_bridges"
    ADD CONSTRAINT "lab_instrument_bridges_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."lab_orders"
    ADD CONSTRAINT "lab_orders_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."lab_orders"
    ADD CONSTRAINT "lab_orders_id_tenant_uid" UNIQUE ("id", "tenant_id");



ALTER TABLE ONLY "public"."lab_reference_ranges"
    ADD CONSTRAINT "lab_reference_ranges_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."lab_reports"
    ADD CONSTRAINT "lab_reports_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."lab_reports"
    ADD CONSTRAINT "lab_reports_tenant_id_lab_order_id_version_key" UNIQUE ("tenant_id", "lab_order_id", "version");



ALTER TABLE ONLY "public"."lab_result_amendments"
    ADD CONSTRAINT "lab_result_amendments_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."lab_result_staging"
    ADD CONSTRAINT "lab_result_staging_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."lab_results"
    ADD CONSTRAINT "lab_results_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."lab_results"
    ADD CONSTRAINT "lab_results_tenant_order_uid" UNIQUE ("tenant_id", "lab_order_id");



ALTER TABLE ONLY "public"."lab_specimens"
    ADD CONSTRAINT "lab_specimens_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."live_feed_sessions"
    ADD CONSTRAINT "live_feed_sessions_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."loinc_reference"
    ADD CONSTRAINT "loinc_reference_loinc_code_key" UNIQUE ("loinc_code");



ALTER TABLE ONLY "public"."loinc_reference"
    ADD CONSTRAINT "loinc_reference_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."maternity_records"
    ADD CONSTRAINT "maternity_records_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."medical_devices"
    ADD CONSTRAINT "medical_devices_hospital_id_serial_number_key" UNIQUE ("hospital_id", "serial_number");



ALTER TABLE ONLY "public"."medical_devices"
    ADD CONSTRAINT "medical_devices_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."medication_safety_checks"
    ADD CONSTRAINT "medication_safety_checks_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."menstrual_cycles"
    ADD CONSTRAINT "menstrual_cycles_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."mfa_enrollments"
    ADD CONSTRAINT "mfa_enrollments_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."mfa_enrollments"
    ADD CONSTRAINT "mfa_enrollments_user_id_unique" UNIQUE ("user_id");



ALTER TABLE ONLY "public"."mfa_step_up_replays"
    ADD CONSTRAINT "mfa_step_up_replays_pkey" PRIMARY KEY ("enrollment_id", "time_step");



ALTER TABLE ONLY "public"."mobile_push_tokens"
    ADD CONSTRAINT "mobile_push_tokens_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."mobile_push_tokens"
    ADD CONSTRAINT "mobile_push_tokens_user_id_device_id_key" UNIQUE ("user_id", "device_id");



ALTER TABLE ONLY "public"."newsletter_subscribers"
    ADD CONSTRAINT "newsletter_subscribers_email_key" UNIQUE ("email");



ALTER TABLE ONLY "public"."newsletter_subscribers"
    ADD CONSTRAINT "newsletter_subscribers_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."nin_access_log"
    ADD CONSTRAINT "nin_access_log_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."notifications"
    ADD CONSTRAINT "notifications_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."offline_mutation_outbox"
    ADD CONSTRAINT "offline_mutation_outbox_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."offline_mutation_outbox"
    ADD CONSTRAINT "offline_mutation_outbox_tenant_id_idempotency_key_key" UNIQUE ("tenant_id", "idempotency_key");



ALTER TABLE ONLY "public"."offline_sync_queue"
    ADD CONSTRAINT "offline_sync_queue_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."order_items"
    ADD CONSTRAINT "order_items_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."order_mappings"
    ADD CONSTRAINT "order_mappings_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."orders"
    ADD CONSTRAINT "orders_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."organizations"
    ADD CONSTRAINT "organizations_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."organizations"
    ADD CONSTRAINT "organizations_slug_key" UNIQUE ("slug");



ALTER TABLE ONLY "public"."outbreak_alerts"
    ADD CONSTRAINT "outbreak_alerts_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."outreach_campaigns"
    ADD CONSTRAINT "outreach_campaigns_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."partograph_records"
    ADD CONSTRAINT "partograph_records_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."passport_access_log"
    ADD CONSTRAINT "passport_access_log_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."passport_share_tokens"
    ADD CONSTRAINT "passport_share_tokens_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."passport_share_tokens"
    ADD CONSTRAINT "passport_share_tokens_token_key" UNIQUE ("token");



ALTER TABLE ONLY "public"."password_reset_tokens"
    ADD CONSTRAINT "password_reset_tokens_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."password_reset_tokens"
    ADD CONSTRAINT "password_reset_tokens_token_hash_key" UNIQUE ("token_hash");



ALTER TABLE ONLY "public"."pathway_alerts"
    ADD CONSTRAINT "pathway_alerts_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."pathway_checklist_items"
    ADD CONSTRAINT "pathway_checklist_items_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."pathway_overrides"
    ADD CONSTRAINT "pathway_overrides_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."patient_access_grants"
    ADD CONSTRAINT "patient_access_grants_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."patient_allergies"
    ADD CONSTRAINT "patient_allergies_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."patient_billing"
    ADD CONSTRAINT "patient_billing_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."patient_clinical_patterns"
    ADD CONSTRAINT "patient_clinical_patterns_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."patient_consents"
    ADD CONSTRAINT "patient_consents_patient_id_hospital_id_module_name_key" UNIQUE ("patient_id", "hospital_id", "module_name");



ALTER TABLE ONLY "public"."patient_consents"
    ADD CONSTRAINT "patient_consents_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."patient_history_queries"
    ADD CONSTRAINT "patient_history_queries_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."patient_intervention_outcomes"
    ADD CONSTRAINT "patient_intervention_outcomes_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."patient_notes"
    ADD CONSTRAINT "patient_notes_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."patient_pathways"
    ADD CONSTRAINT "patient_pathways_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."patient_problem_list"
    ADD CONSTRAINT "patient_problem_list_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."patient_profiles"
    ADD CONSTRAINT "patient_profiles_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."patient_profiles"
    ADD CONSTRAINT "patient_profiles_synapse_id_key" UNIQUE ("synapse_id");



ALTER TABLE ONLY "public"."patient_safety_events"
    ADD CONSTRAINT "patient_safety_events_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."patient_sms_reminders"
    ADD CONSTRAINT "patient_sms_reminders_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."patient_timeline_events"
    ADD CONSTRAINT "patient_timeline_events_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."patient_timeline_pins"
    ADD CONSTRAINT "patient_timeline_pins_patient_id_event_id_pinned_by_key" UNIQUE ("patient_id", "event_id", "pinned_by");



ALTER TABLE ONLY "public"."patient_timeline_pins"
    ADD CONSTRAINT "patient_timeline_pins_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."patient_vitals"
    ADD CONSTRAINT "patient_vitals_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."patients"
    ADD CONSTRAINT "patients_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."payer_contracts"
    ADD CONSTRAINT "payer_contracts_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."pediatric_growth_records"
    ADD CONSTRAINT "pediatric_growth_records_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."person_clinical_facts"
    ADD CONSTRAINT "person_clinical_facts_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."person_consent_events"
    ADD CONSTRAINT "person_consent_events_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."person_consents"
    ADD CONSTRAINT "person_consents_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."person_contacts"
    ADD CONSTRAINT "person_contacts_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."person_identifiers"
    ADD CONSTRAINT "person_identifiers_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."person_relationships"
    ADD CONSTRAINT "person_relationships_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."persons"
    ADD CONSTRAINT "persons_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."persons"
    ADD CONSTRAINT "persons_synapse_id_key" UNIQUE ("synapse_id");



ALTER TABLE ONLY "public"."pharmacy_audit_logs"
    ADD CONSTRAINT "pharmacy_audit_logs_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."pharmacy_cart_items"
    ADD CONSTRAINT "pharmacy_cart_items_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."pharmacy_carts"
    ADD CONSTRAINT "pharmacy_carts_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."pharmacy_cashier_sessions"
    ADD CONSTRAINT "pharmacy_cashier_sessions_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."pharmacy_clients"
    ADD CONSTRAINT "pharmacy_clients_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."pharmacy_credit_ledger"
    ADD CONSTRAINT "pharmacy_credit_ledger_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."pharmacy_custom_domains"
    ADD CONSTRAINT "pharmacy_custom_domains_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."pharmacy_customers"
    ADD CONSTRAINT "pharmacy_customers_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."pharmacy_expenses"
    ADD CONSTRAINT "pharmacy_expenses_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."pharmacy_import_sessions"
    ADD CONSTRAINT "pharmacy_import_sessions_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."pharmacy_inquiries"
    ADD CONSTRAINT "pharmacy_inquiries_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."pharmacy_network_inventory"
    ADD CONSTRAINT "pharmacy_network_inventory_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."pharmacy_notifications"
    ADD CONSTRAINT "pharmacy_notifications_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."pharmacy_onboarding"
    ADD CONSTRAINT "pharmacy_onboarding_invite_token_key" UNIQUE ("invite_token");



ALTER TABLE ONLY "public"."pharmacy_onboarding"
    ADD CONSTRAINT "pharmacy_onboarding_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."pharmacy_onboarding"
    ADD CONSTRAINT "pharmacy_onboarding_tenant_id_key" UNIQUE ("tenant_id");



ALTER TABLE ONLY "public"."pharmacy_order_items"
    ADD CONSTRAINT "pharmacy_order_items_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."pharmacy_orders"
    ADD CONSTRAINT "pharmacy_orders_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."pharmacy_orders"
    ADD CONSTRAINT "pharmacy_orders_tenant_id_order_no_key" UNIQUE ("tenant_id", "order_no");



ALTER TABLE ONLY "public"."pharmacy_pos_sale_items"
    ADD CONSTRAINT "pharmacy_pos_sale_items_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."pharmacy_pos_sales"
    ADD CONSTRAINT "pharmacy_pos_sales_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."pharmacy_product_batches"
    ADD CONSTRAINT "pharmacy_product_batches_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."pharmacy_product_batches"
    ADD CONSTRAINT "pharmacy_product_batches_product_id_batch_number_key" UNIQUE ("product_id", "batch_number");



ALTER TABLE ONLY "public"."pharmacy_product_packages"
    ADD CONSTRAINT "pharmacy_product_packages_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."pharmacy_product_packages"
    ADD CONSTRAINT "pharmacy_product_packages_product_id_name_key" UNIQUE ("product_id", "name");



ALTER TABLE ONLY "public"."pharmacy_products"
    ADD CONSTRAINT "pharmacy_products_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."pharmacy_products"
    ADD CONSTRAINT "pharmacy_products_tenant_id_sku_key" UNIQUE ("tenant_id", "sku");



ALTER TABLE ONLY "public"."pharmacy_profiles"
    ADD CONSTRAINT "pharmacy_profiles_custom_domain_key" UNIQUE ("custom_domain");



ALTER TABLE ONLY "public"."pharmacy_profiles"
    ADD CONSTRAINT "pharmacy_profiles_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."pharmacy_profiles"
    ADD CONSTRAINT "pharmacy_profiles_tenant_id_key" UNIQUE ("tenant_id");



ALTER TABLE ONLY "public"."pharmacy_purchase_order_items"
    ADD CONSTRAINT "pharmacy_purchase_order_items_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."pharmacy_purchase_orders"
    ADD CONSTRAINT "pharmacy_purchase_orders_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."pharmacy_purchase_orders"
    ADD CONSTRAINT "pharmacy_purchase_orders_tenant_id_order_no_key" UNIQUE ("tenant_id", "order_no");



ALTER TABLE ONLY "public"."pharmacy_receipt_reprints"
    ADD CONSTRAINT "pharmacy_receipt_reprints_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."pharmacy_refunds"
    ADD CONSTRAINT "pharmacy_refunds_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."pharmacy_sale_idempotency"
    ADD CONSTRAINT "pharmacy_sale_idempotency_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."pharmacy_sale_idempotency"
    ADD CONSTRAINT "pharmacy_sale_idempotency_tenant_key" UNIQUE ("tenant_id", "idempotency_key");



ALTER TABLE ONLY "public"."pharmacy_settings"
    ADD CONSTRAINT "pharmacy_settings_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."pharmacy_settings"
    ADD CONSTRAINT "pharmacy_settings_tenant_id_key" UNIQUE ("tenant_id");



ALTER TABLE ONLY "public"."pharmacy_staff_permissions"
    ADD CONSTRAINT "pharmacy_staff_permissions_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."pharmacy_stock_adjustments"
    ADD CONSTRAINT "pharmacy_stock_adjustments_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."pharmacy_stock_transfer_item_allocations"
    ADD CONSTRAINT "pharmacy_stock_transfer_item_allocations_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."pharmacy_stock_transfer_items"
    ADD CONSTRAINT "pharmacy_stock_transfer_items_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."pharmacy_stock_transfers"
    ADD CONSTRAINT "pharmacy_stock_transfers_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."pharmacy_stores"
    ADD CONSTRAINT "pharmacy_stores_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."pharmacy_suppliers"
    ADD CONSTRAINT "pharmacy_suppliers_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."pharmacy_transaction_edits"
    ADD CONSTRAINT "pharmacy_transaction_edits_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."pharmacy_transaction_items"
    ADD CONSTRAINT "pharmacy_transaction_items_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."pharmacy_transactions"
    ADD CONSTRAINT "pharmacy_transactions_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."pharmacy_transactions"
    ADD CONSTRAINT "pharmacy_transactions_tenant_id_transaction_no_key" UNIQUE ("tenant_id", "transaction_no");



ALTER TABLE ONLY "public"."pharmacy_user_settings"
    ADD CONSTRAINT "pharmacy_user_settings_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."pharmacy_user_settings"
    ADD CONSTRAINT "pharmacy_user_settings_tenant_id_profile_id_key" UNIQUE ("tenant_id", "profile_id");



ALTER TABLE ONLY "public"."pharmacy_user_settings"
    ADD CONSTRAINT "pharmacy_user_settings_username_key" UNIQUE ("username");



ALTER TABLE ONLY "public"."phi_access_log"
    ADD CONSTRAINT "phi_access_log_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."pilot_applications"
    ADD CONSTRAINT "pilot_applications_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."plan_features"
    ADD CONSTRAINT "plan_features_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."plan_features"
    ADD CONSTRAINT "plan_features_plan_id_feature_key_key" UNIQUE ("plan_id", "feature_key");



ALTER TABLE ONLY "public"."platform_approvals"
    ADD CONSTRAINT "platform_approvals_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."platform_audit_events"
    ADD CONSTRAINT "platform_audit_events_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."platform_billing_config"
    ADD CONSTRAINT "platform_billing_config_pkey" PRIMARY KEY ("key");



ALTER TABLE ONLY "public"."platform_broadcasts"
    ADD CONSTRAINT "platform_broadcasts_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."platform_feature_flags"
    ADD CONSTRAINT "platform_feature_flags_flag_key" UNIQUE ("flag");



ALTER TABLE ONLY "public"."platform_feature_flags"
    ADD CONSTRAINT "platform_feature_flags_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."platform_health_checks"
    ADD CONSTRAINT "platform_health_checks_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."platform_incidents"
    ADD CONSTRAINT "platform_incidents_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."platform_invitations"
    ADD CONSTRAINT "platform_invitations_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."platform_memberships"
    ADD CONSTRAINT "platform_memberships_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."platform_module_matrix"
    ADD CONSTRAINT "platform_module_matrix_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."platform_module_matrix"
    ADD CONSTRAINT "platform_module_matrix_tenant_id_module_key_key" UNIQUE ("tenant_id", "module_key");



ALTER TABLE ONLY "public"."platform_releases"
    ADD CONSTRAINT "platform_releases_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."platform_support_sessions"
    ADD CONSTRAINT "platform_support_sessions_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."platform_support_tickets"
    ADD CONSTRAINT "platform_support_tickets_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."platform_test_runs"
    ADD CONSTRAINT "platform_test_runs_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."products"
    ADD CONSTRAINT "products_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."professional_leads"
    ADD CONSTRAINT "professional_leads_email_key" UNIQUE ("email");



ALTER TABLE ONLY "public"."professional_leads"
    ADD CONSTRAINT "professional_leads_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."profiles"
    ADD CONSTRAINT "profiles_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."profiles"
    ADD CONSTRAINT "profiles_synapse_id_key" UNIQUE ("synapse_id");



ALTER TABLE ONLY "public"."provider_verification_checks"
    ADD CONSTRAINT "provider_verification_checks_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."purchase_orders"
    ADD CONSTRAINT "purchase_orders_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."radiology_report_templates"
    ADD CONSTRAINT "radiology_report_templates_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."radiology_reports"
    ADD CONSTRAINT "radiology_reports_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."reasoning_actions"
    ADD CONSTRAINT "reasoning_actions_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."reasoning_audit"
    ADD CONSTRAINT "reasoning_audit_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."reasoning_context_snapshots"
    ADD CONSTRAINT "reasoning_context_snapshots_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."reasoning_evidence_impact"
    ADD CONSTRAINT "reasoning_evidence_impact_hypothesis_id_evidence_id_key" UNIQUE ("hypothesis_id", "evidence_id");



ALTER TABLE ONLY "public"."reasoning_evidence_impact"
    ADD CONSTRAINT "reasoning_evidence_impact_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."reasoning_evidence"
    ADD CONSTRAINT "reasoning_evidence_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."reasoning_hypotheses"
    ADD CONSTRAINT "reasoning_hypotheses_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."reasoning_sessions"
    ADD CONSTRAINT "reasoning_sessions_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."referral_requests"
    ADD CONSTRAINT "referral_requests_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."refill_reminders"
    ADD CONSTRAINT "refill_reminders_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."renal_adjustments_catalog"
    ADD CONSTRAINT "renal_adjustments_catalog_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."restaurants"
    ADD CONSTRAINT "restaurants_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."role_capabilities"
    ADD CONSTRAINT "role_capabilities_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."role_capabilities"
    ADD CONSTRAINT "role_capabilities_role_facility_type_capability_id_key" UNIQUE ("role", "facility_type", "capability_id");



ALTER TABLE ONLY "public"."role_hierarchy"
    ADD CONSTRAINT "role_hierarchy_pkey" PRIMARY KEY ("role", "inherits");



ALTER TABLE ONLY "public"."rule_executions"
    ADD CONSTRAINT "rule_executions_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."scan_events"
    ADD CONSTRAINT "scan_events_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."score_calculations"
    ADD CONSTRAINT "score_calculations_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."score_definitions"
    ADD CONSTRAINT "score_definitions_code_key" UNIQUE ("code");



ALTER TABLE ONLY "public"."score_definitions"
    ADD CONSTRAINT "score_definitions_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."sdg_indicators"
    ADD CONSTRAINT "sdg_indicators_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."sdg_reports"
    ADD CONSTRAINT "sdg_reports_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."sentinel_alerts"
    ADD CONSTRAINT "sentinel_alerts_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."service_catalog"
    ADD CONSTRAINT "service_catalog_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."staff_attendance"
    ADD CONSTRAINT "staff_attendance_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."staff_invitations"
    ADD CONSTRAINT "staff_invitations_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."staff_invitations"
    ADD CONSTRAINT "staff_invitations_token_key" UNIQUE ("token");



ALTER TABLE ONLY "public"."staff_leave_requests"
    ADD CONSTRAINT "staff_leave_requests_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."staff_scope_assignments"
    ADD CONSTRAINT "staff_scope_assignments_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."subscription_events"
    ADD CONSTRAINT "subscription_events_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."subscription_grants"
    ADD CONSTRAINT "subscription_grants_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."subscription_invoices"
    ADD CONSTRAINT "subscription_invoices_invoice_no_key" UNIQUE ("invoice_no");



ALTER TABLE ONLY "public"."subscription_invoices"
    ADD CONSTRAINT "subscription_invoices_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."subscription_payments"
    ADD CONSTRAINT "subscription_payments_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."subscription_payments"
    ADD CONSTRAINT "subscription_payments_provider_tx_ref_key" UNIQUE ("provider_tx_ref");



ALTER TABLE ONLY "public"."subscription_plans"
    ADD CONSTRAINT "subscription_plans_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."subscription_plans"
    ADD CONSTRAINT "subscription_plans_slug_key" UNIQUE ("slug");



ALTER TABLE ONLY "public"."suppliers"
    ADD CONSTRAINT "suppliers_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."support_ticket_events"
    ADD CONSTRAINT "support_ticket_events_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."support_tickets"
    ADD CONSTRAINT "support_tickets_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."surgery_schedules"
    ADD CONSTRAINT "surgery_schedules_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."surveillance_reports"
    ADD CONSTRAINT "surveillance_reports_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."surveillance_reports"
    ADD CONSTRAINT "surveillance_reports_report_ref_key" UNIQUE ("report_ref");



ALTER TABLE ONLY "public"."synapse_adapters"
    ADD CONSTRAINT "synapse_adapters_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."synapse_domain_events"
    ADD CONSTRAINT "synapse_domain_events_idempotency_key_key" UNIQUE ("idempotency_key");



ALTER TABLE ONLY "public"."synapse_domain_events"
    ADD CONSTRAINT "synapse_domain_events_pkey" PRIMARY KEY ("event_id");



ALTER TABLE ONLY "public"."synapse_sessions"
    ADD CONSTRAINT "synapse_sessions_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."synapse_sessions"
    ADD CONSTRAINT "synapse_sessions_token_hash_key" UNIQUE ("token_hash");



ALTER TABLE ONLY "public"."synapse_simulation_runs"
    ADD CONSTRAINT "synapse_simulation_runs_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."sync_conflicts"
    ADD CONSTRAINT "sync_conflicts_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."sync_idempotency_keys"
    ADD CONSTRAINT "sync_idempotency_keys_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."sync_idempotency_keys"
    ADD CONSTRAINT "sync_idempotency_keys_scope_key_unique" UNIQUE ("scope", "idempotency_key");



ALTER TABLE ONLY "public"."tele_sessions"
    ADD CONSTRAINT "tele_sessions_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."telemedicine_appointments"
    ADD CONSTRAINT "telemedicine_appointments_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."telemedicine_followups"
    ADD CONSTRAINT "telemedicine_followups_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."telemedicine_frontdesk_queue"
    ADD CONSTRAINT "telemedicine_frontdesk_queue_case_id_key" UNIQUE ("case_id");



ALTER TABLE ONLY "public"."telemedicine_frontdesk_queue"
    ADD CONSTRAINT "telemedicine_frontdesk_queue_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."telemedicine_intake_cases"
    ADD CONSTRAINT "telemedicine_intake_cases_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."telemedicine_intake_messages"
    ADD CONSTRAINT "telemedicine_intake_messages_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."telemedicine_providers"
    ADD CONSTRAINT "telemedicine_providers_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."telemedicine_session_events"
    ADD CONSTRAINT "telemedicine_session_events_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."telemedicine_staff_alerts"
    ADD CONSTRAINT "telemedicine_staff_alerts_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."telemedicine_voice_memos"
    ADD CONSTRAINT "telemedicine_voice_memos_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."tenant_domains"
    ADD CONSTRAINT "tenant_domains_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."tenant_feature_overrides"
    ADD CONSTRAINT "tenant_feature_overrides_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."tenant_feature_overrides"
    ADD CONSTRAINT "tenant_feature_overrides_tenant_id_feature_key_key" UNIQUE ("tenant_id", "feature_key");



ALTER TABLE ONLY "public"."tenant_logging_policies"
    ADD CONSTRAINT "tenant_logging_policies_hospital_id_module_name_key" UNIQUE ("hospital_id", "module_name");



ALTER TABLE ONLY "public"."tenant_logging_policies"
    ADD CONSTRAINT "tenant_logging_policies_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."tenant_provisioning_jobs"
    ADD CONSTRAINT "tenant_provisioning_jobs_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."tenant_subscriptions"
    ADD CONSTRAINT "tenant_subscriptions_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."tenant_subscriptions"
    ADD CONSTRAINT "tenant_subscriptions_tenant_id_key" UNIQUE ("tenant_id");



ALTER TABLE ONLY "public"."tenants"
    ADD CONSTRAINT "tenants_default_subdomain_key" UNIQUE ("default_subdomain");



ALTER TABLE ONLY "public"."tenants"
    ADD CONSTRAINT "tenants_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."tenants"
    ADD CONSTRAINT "tenants_slug_key" UNIQUE ("slug");



ALTER TABLE ONLY "public"."ucg_guidelines"
    ADD CONSTRAINT "ucg_guidelines_guideline_code_key" UNIQUE ("guideline_code");



ALTER TABLE ONLY "public"."ucg_guidelines"
    ADD CONSTRAINT "ucg_guidelines_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."pharmacy_network_inventory"
    ADD CONSTRAINT "uq_network_inv_tenant_drug" UNIQUE ("pharmacy_tenant_id", "drug_name");



ALTER TABLE ONLY "public"."verification_documents"
    ADD CONSTRAINT "verification_documents_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."visitor_log"
    ADD CONSTRAINT "visitor_log_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."vitals"
    ADD CONSTRAINT "vitals_pkey" PRIMARY KEY ("id");



ALTER TABLE ONLY "public"."wards"
    ADD CONSTRAINT "wards_pkey" PRIMARY KEY ("id");



CREATE INDEX "auth_otps_lookup" ON "public"."auth_otps" USING "btree" ("target", "channel", "used", "expires_at");



CREATE INDEX "auth_otps_rate_limit" ON "public"."auth_otps" USING "btree" ("target", "channel", "created_at");



CREATE INDEX "clinical_prescriptions_pharm_queue_idx" ON "public"."clinical_prescriptions" USING "btree" ("pharmacy_tenant_id", "status", "created_at" DESC);



CREATE INDEX "cne_embedding_idx" ON "public"."clinical_note_embeddings" USING "ivfflat" ("embedding" "public"."vector_cosine_ops") WITH ("lists"='100');



CREATE INDEX "cne_patient_idx" ON "public"."clinical_note_embeddings" USING "btree" ("patient_id");



CREATE INDEX "cne_tsvector_idx" ON "public"."clinical_note_embeddings" USING "gin" ("content_tsvector");



CREATE INDEX "emergency_access_events_person_idx" ON "public"."emergency_access_events" USING "btree" ("person_id", "created_at" DESC);



CREATE INDEX "encounters_tenant_status_idx" ON "public"."encounters" USING "btree" ("tenant_id", "status", "created_at");



CREATE INDEX "facility_invitation_audit_invitation_idx" ON "public"."facility_invitation_audit" USING "btree" ("invitation_id", "created_at");



CREATE UNIQUE INDEX "facility_invitations_token_hash_uidx" ON "public"."facility_invitations" USING "btree" ("token_hash") WHERE ("token_hash" IS NOT NULL);



CREATE INDEX "facility_lifecycle_events_tenant_idx" ON "public"."facility_lifecycle_events" USING "btree" ("tenant_id", "created_at" DESC);



CREATE UNIQUE INDEX "feature_flags_global_key_unique" ON "public"."feature_flags" USING "btree" ("feature_key") WHERE ("tenant_id" IS NULL);



CREATE UNIQUE INDEX "feature_flags_tenant_key_on_conflict" ON "public"."feature_flags" USING "btree" ("tenant_id", "feature_key");



CREATE UNIQUE INDEX "feature_flags_tenant_key_unique" ON "public"."feature_flags" USING "btree" ("tenant_id", "feature_key") WHERE ("tenant_id" IS NOT NULL);



CREATE INDEX "hospital_leads_created_at_idx" ON "public"."hospital_leads" USING "btree" ("created_at" DESC);



CREATE INDEX "hospital_leads_status_idx" ON "public"."hospital_leads" USING "btree" ("status");



CREATE INDEX "identity_match_pending_idx" ON "public"."identity_match_candidates" USING "btree" ("status", "confidence" DESC) WHERE ("status" = 'pending'::"text");



CREATE INDEX "idx_access_grants_grantee" ON "public"."patient_access_grants" USING "btree" ("granted_to", "status", "valid_from" DESC);



CREATE INDEX "idx_access_grants_patient_active" ON "public"."patient_access_grants" USING "btree" ("patient_id", "status", "valid_until");



CREATE INDEX "idx_aefi_hospital_date" ON "public"."aefi_reports" USING "btree" ("hospital_id", "vaccination_date" DESC);



CREATE INDEX "idx_aefi_reports_tid" ON "public"."aefi_reports" USING "btree" ("tenant_id");



CREATE INDEX "idx_allergens_catalog_tid" ON "public"."allergens_catalog" USING "btree" ("tenant_id");



CREATE INDEX "idx_app_vitals_patient" ON "public"."app_vitals" USING "btree" ("patient_id");



CREATE INDEX "idx_app_vitals_recorded" ON "public"."app_vitals" USING "btree" ("recorded_at" DESC);



CREATE INDEX "idx_audit_events_tid" ON "public"."audit_events" USING "btree" ("tenant_id");



CREATE INDEX "idx_audit_log_created_at" ON "public"."audit_log" USING "btree" ("created_at" DESC);



CREATE INDEX "idx_audit_log_table_action" ON "public"."audit_log" USING "btree" ("table_name", "action");



CREATE INDEX "idx_audit_log_tenant_id" ON "public"."audit_log" USING "btree" ("tenant_id", "created_at" DESC);



CREATE INDEX "idx_availability_log_provider" ON "public"."doctor_availability_log" USING "btree" ("provider_id", "created_at" DESC);



CREATE INDEX "idx_batches_fefo" ON "public"."pharmacy_product_batches" USING "btree" ("product_id", "expiry_date") WHERE ("is_active" AND ("quantity" > 0));



CREATE INDEX "idx_bed_assignments_bed" ON "public"."bed_assignments" USING "btree" ("bed_id", "discharged_at" NULLS FIRST);



CREATE INDEX "idx_bed_assignments_patient" ON "public"."bed_assignments" USING "btree" ("patient_id", "admitted_at" DESC);



CREATE INDEX "idx_bed_assignments_tid" ON "public"."bed_assignments" USING "btree" ("tenant_id");



CREATE INDEX "idx_beds_hospital_status" ON "public"."hospital_beds" USING "btree" ("hospital_id", "status", "bed_type");



CREATE INDEX "idx_beta_access_requests_created_at" ON "public"."beta_access_requests" USING "btree" ("created_at" DESC);



CREATE INDEX "idx_beta_access_requests_email" ON "public"."beta_access_requests" USING "btree" ("email");



CREATE INDEX "idx_beta_access_requests_status" ON "public"."beta_access_requests" USING "btree" ("status");



CREATE INDEX "idx_beta_access_requests_tid" ON "public"."beta_access_requests" USING "btree" ("tenant_id");



CREATE INDEX "idx_billing_invoices_created_at" ON "public"."billing_invoices" USING "btree" ("created_at" DESC);



CREATE INDEX "idx_billing_invoices_status" ON "public"."billing_invoices" USING "btree" ("status");



CREATE INDEX "idx_billing_invoices_tid" ON "public"."billing_invoices" USING "btree" ("tenant_id");



CREATE INDEX "idx_billing_line_items_invoice_id" ON "public"."billing_line_items" USING "btree" ("invoice_id");



CREATE INDEX "idx_billing_line_items_tid" ON "public"."billing_line_items" USING "btree" ("tenant_id");



CREATE INDEX "idx_billing_payments_encounter" ON "public"."billing_payments" USING "btree" ("tenant_id", "encounter_id", "created_at" DESC);



CREATE UNIQUE INDEX "idx_billing_payments_idempotency" ON "public"."billing_payments" USING "btree" ("tenant_id", "idempotency_key") WHERE ("idempotency_key" IS NOT NULL);



CREATE INDEX "idx_billing_payments_invoice" ON "public"."billing_payments" USING "btree" ("tenant_id", "invoice_id", "created_at" DESC);



CREATE INDEX "idx_body_register_tenant" ON "public"."body_register" USING "btree" ("tenant_id");



CREATE INDEX "idx_breaches_hospital_status" ON "public"."data_breach_incidents" USING "btree" ("hospital_id", "status", "incident_date" DESC);



CREATE INDEX "idx_calls_callee" ON "public"."calls" USING "btree" ("callee_id");



CREATE INDEX "idx_calls_caller" ON "public"."calls" USING "btree" ("caller_id");



CREATE INDEX "idx_calls_room" ON "public"."calls" USING "btree" ("room_name");



CREATE INDEX "idx_calls_status" ON "public"."calls" USING "btree" ("status");



CREATE INDEX "idx_campaigns_hospital_status" ON "public"."outreach_campaigns" USING "btree" ("hospital_id", "status", "start_date" DESC);



CREATE INDEX "idx_capabilities_module" ON "public"."capabilities" USING "btree" ("module");



CREATE INDEX "idx_care_team_handovers_tid" ON "public"."care_team_handovers" USING "btree" ("tenant_id");



CREATE INDEX "idx_cds_alerts_created_at" ON "public"."cds_alerts" USING "btree" ("created_at" DESC);



CREATE INDEX "idx_cds_alerts_encounter_id" ON "public"."cds_alerts" USING "btree" ("encounter_id");



CREATE INDEX "idx_cds_alerts_status" ON "public"."cds_alerts" USING "btree" ("status");



CREATE INDEX "idx_cds_alerts_tid" ON "public"."cds_alerts" USING "btree" ("tenant_id");



CREATE INDEX "idx_cds_rules_icd_code" ON "public"."cds_rules" USING "btree" ("icd_code");



CREATE INDEX "idx_cds_rules_tid" ON "public"."cds_rules" USING "btree" ("tenant_id");



CREATE INDEX "idx_chw_hospital_active" ON "public"."community_health_workers" USING "btree" ("hospital_id", "is_active", "district");



CREATE INDEX "idx_chw_visits_campaign" ON "public"."chw_visits" USING "btree" ("campaign_id", "visit_date" DESC);



CREATE INDEX "idx_chw_visits_chw_date" ON "public"."chw_visits" USING "btree" ("chw_id", "visit_date" DESC);



CREATE INDEX "idx_chw_visits_patient" ON "public"."chw_visits" USING "btree" ("patient_id", "visit_date" DESC);



CREATE INDEX "idx_chw_visits_tid" ON "public"."chw_visits" USING "btree" ("tenant_id");



CREATE INDEX "idx_claim_line_items_claim" ON "public"."claim_line_items" USING "btree" ("claim_id", "service_date");



CREATE INDEX "idx_claim_line_items_tid" ON "public"."claim_line_items" USING "btree" ("tenant_id");



CREATE INDEX "idx_claim_resubmissions_claim" ON "public"."claim_resubmissions" USING "btree" ("claim_id", "resubmitted_at" DESC);



CREATE INDEX "idx_claim_resubmissions_tid" ON "public"."claim_resubmissions" USING "btree" ("tenant_id");



CREATE INDEX "idx_claims_denial" ON "public"."insurance_claims" USING "btree" ("hospital_id", "denial_code", "adjudicated_at" DESC) WHERE ("status" = 'denied'::"text");



CREATE INDEX "idx_claims_hospital_status" ON "public"."insurance_claims" USING "btree" ("hospital_id", "status", "submitted_at" DESC);



CREATE INDEX "idx_claims_patient" ON "public"."insurance_claims" USING "btree" ("patient_id", "status", "created_at" DESC);



CREATE INDEX "idx_clinical_intelligence_sessions_encounter" ON "public"."clinical_intelligence_sessions" USING "btree" ("encounter_id", "created_at" DESC);



CREATE INDEX "idx_clinical_pathway_templates_tid" ON "public"."clinical_pathway_templates" USING "btree" ("tenant_id");



CREATE INDEX "idx_community_health_workers_tid" ON "public"."community_health_workers" USING "btree" ("tenant_id");



CREATE INDEX "idx_consent_audit_actor" ON "public"."consent_audit_log" USING "btree" ("actor_id", "created_at" DESC);



CREATE INDEX "idx_consent_audit_log_tid" ON "public"."consent_audit_log" USING "btree" ("tenant_id");



CREATE INDEX "idx_consent_audit_patient_date" ON "public"."consent_audit_log" USING "btree" ("patient_id", "created_at" DESC);



CREATE INDEX "idx_consents_hospital_expiry" ON "public"."patient_consents" USING "btree" ("hospital_id", "expires_at") WHERE ("status" = 'granted'::"text");



CREATE INDEX "idx_consents_patient_module" ON "public"."patient_consents" USING "btree" ("patient_id", "module_name", "status");



CREATE INDEX "idx_consult_queue_status" ON "public"."consult_queue" USING "btree" ("status", "created_at");



CREATE INDEX "idx_consult_queue_token" ON "public"."consult_queue" USING "btree" ("token");



CREATE INDEX "idx_data_breach_incidents_tid" ON "public"."data_breach_incidents" USING "btree" ("tenant_id");



CREATE INDEX "idx_data_export_jobs_tid" ON "public"."data_export_jobs" USING "btree" ("tenant_id");



CREATE INDEX "idx_data_retention_policies_tid" ON "public"."data_retention_policies" USING "btree" ("tenant_id");



CREATE INDEX "idx_death_reg_hospital_died" ON "public"."death_registrations" USING "btree" ("hospital_id", "died_at" DESC);



CREATE INDEX "idx_death_reg_sentinel" ON "public"."death_registrations" USING "btree" ("hospital_id", "died_at" DESC) WHERE (("is_unexplained" = true) OR ("is_infectious" = true));



CREATE INDEX "idx_death_registrations_tid" ON "public"."death_registrations" USING "btree" ("tenant_id");



CREATE INDEX "idx_death_reports_patient_id" ON "public"."death_reports" USING "btree" ("patient_id");



CREATE INDEX "idx_death_reports_reported_at" ON "public"."death_reports" USING "btree" ("reported_at" DESC);



CREATE INDEX "idx_death_reports_tid" ON "public"."death_reports" USING "btree" ("tenant_id");



CREATE INDEX "idx_deidentification_profiles_tid" ON "public"."deidentification_profiles" USING "btree" ("tenant_id");



CREATE INDEX "idx_denial_analytics_daily_tid" ON "public"."denial_analytics_daily" USING "btree" ("tenant_id");



CREATE INDEX "idx_department_tasks_encounter" ON "public"."department_tasks" USING "btree" ("encounter_id");



CREATE UNIQUE INDEX "idx_department_tasks_idempotency" ON "public"."department_tasks" USING "btree" ("tenant_id", "idempotency_key") WHERE ("idempotency_key" IS NOT NULL);



CREATE INDEX "idx_department_tasks_owner_dept" ON "public"."department_tasks" USING "btree" ("tenant_id", "owner_department", "status");



CREATE INDEX "idx_department_tasks_patient" ON "public"."department_tasks" USING "btree" ("patient_id");



CREATE INDEX "idx_department_tasks_tenant_status" ON "public"."department_tasks" USING "btree" ("tenant_id", "status");



CREATE UNIQUE INDEX "idx_departments_global_name_unique" ON "public"."departments" USING "btree" ("lower"("name")) WHERE ("tenant_id" IS NULL);



CREATE INDEX "idx_departments_hospital_id" ON "public"."departments" USING "btree" ("hospital_id");



CREATE UNIQUE INDEX "idx_departments_tenant_name_unique" ON "public"."departments" USING "btree" ("tenant_id", "lower"("name")) WHERE ("tenant_id" IS NOT NULL);



COMMENT ON INDEX "public"."idx_departments_tenant_name_unique" IS 'Department names unique per tenant. Hospital A and Hospital B may both have Laboratory.';



CREATE INDEX "idx_departments_tid" ON "public"."departments" USING "btree" ("tenant_id");



CREATE INDEX "idx_device_alerts_hospital_status" ON "public"."device_alerts" USING "btree" ("hospital_id", "status", "triggered_at" DESC);



CREATE INDEX "idx_device_alerts_tid" ON "public"."device_alerts" USING "btree" ("tenant_id");



CREATE INDEX "idx_device_readings_critical" ON "public"."device_readings" USING "btree" ("hospital_id", "is_critical", "read_at" DESC) WHERE ("is_critical" = true);



CREATE INDEX "idx_device_readings_device_time" ON "public"."device_readings" USING "btree" ("device_id", "read_at" DESC);



CREATE INDEX "idx_device_readings_patient_time" ON "public"."device_readings" USING "btree" ("patient_id", "read_at" DESC);



CREATE INDEX "idx_device_readings_tid" ON "public"."device_readings" USING "btree" ("tenant_id");



CREATE INDEX "idx_devices_hospital_type" ON "public"."medical_devices" USING "btree" ("hospital_id", "device_type", "status");



CREATE UNIQUE INDEX "idx_dhis2_de_map_stem" ON "public"."dhis2_data_element_mappings" USING "btree" (COALESCE("tenant_id", '00000000-0000-0000-0000-000000000000'::"uuid"), "icd11_stem_code");



CREATE INDEX "idx_dhis2_export_attempt_log_job" ON "public"."dhis2_export_attempt_log" USING "btree" ("job_id", "created_at" DESC);



CREATE UNIQUE INDEX "idx_dhis2_export_jobs_idempotency" ON "public"."dhis2_export_jobs" USING "btree" ("tenant_id", "idempotency_key");



CREATE INDEX "idx_dhis2_export_jobs_status" ON "public"."dhis2_export_jobs" USING "btree" ("status", "created_at" DESC);



CREATE UNIQUE INDEX "idx_dhis2_org_unit_mappings_global_key" ON "public"."dhis2_org_unit_mappings" USING "btree" ("local_org_key") WHERE ("tenant_id" IS NULL);



CREATE INDEX "idx_diagnoses_tid" ON "public"."diagnoses" USING "btree" ("tenant_id");



CREATE INDEX "idx_domain_events_correlation" ON "public"."domain_events" USING "btree" ("correlation_id", "occurred_at");



CREATE INDEX "idx_domain_events_encounter" ON "public"."domain_events" USING "btree" ("encounter_id", "occurred_at") WHERE ("encounter_id" IS NOT NULL);



CREATE UNIQUE INDEX "idx_domain_events_idempotency" ON "public"."domain_events" USING "btree" ("tenant_id", "event_type", "idempotency_key");



CREATE INDEX "idx_domain_events_patient" ON "public"."domain_events" USING "btree" ("patient_id", "occurred_at" DESC) WHERE ("patient_id" IS NOT NULL);



CREATE INDEX "idx_domain_events_pending" ON "public"."domain_events" USING "btree" ("processing_status", "next_attempt_at", "recorded_at") WHERE ("processing_status" = ANY (ARRAY['pending'::"text", 'failed'::"text"]));



CREATE INDEX "idx_domain_events_type_tenant" ON "public"."domain_events" USING "btree" ("tenant_id", "event_type", "occurred_at" DESC);



CREATE INDEX "idx_dose_adjustments_drug_organ" ON "public"."drug_dose_adjustments" USING "btree" ("drug_code", "organ_type");



CREATE INDEX "idx_drug_contraindications_drug" ON "public"."drug_contraindications" USING "btree" ("drug_code", "severity");



CREATE INDEX "idx_drug_contraindications_tid" ON "public"."drug_contraindications" USING "btree" ("tenant_id");



CREATE INDEX "idx_drug_dose_adjustments_tid" ON "public"."drug_dose_adjustments" USING "btree" ("tenant_id");



CREATE INDEX "idx_drug_interactions_a" ON "public"."drug_interactions" USING "btree" ("drug_a_code", "severity");



CREATE INDEX "idx_drug_interactions_b" ON "public"."drug_interactions" USING "btree" ("drug_b_code", "severity");



CREATE INDEX "idx_drug_interactions_catalog_tid" ON "public"."drug_interactions_catalog" USING "btree" ("tenant_id");



CREATE INDEX "idx_drug_interactions_tid" ON "public"."drug_interactions" USING "btree" ("tenant_id");



CREATE INDEX "idx_drug_inventory_tenant" ON "public"."drug_inventory" USING "btree" ("tenant_id");



CREATE INDEX "idx_encounter_amendments_encounter" ON "public"."encounter_amendments" USING "btree" ("encounter_id", "amended_at" DESC);



CREATE INDEX "idx_encounter_amendments_tenant" ON "public"."encounter_amendments" USING "btree" ("tenant_id");



CREATE INDEX "idx_encounter_diagnoses_created_at" ON "public"."encounter_diagnoses" USING "btree" ("created_at" DESC);



CREATE INDEX "idx_encounter_diagnoses_encounter_id" ON "public"."encounter_diagnoses" USING "btree" ("encounter_id");



CREATE INDEX "idx_encounter_diagnoses_tid" ON "public"."encounter_diagnoses" USING "btree" ("tenant_id");



CREATE INDEX "idx_encounter_orders_encounter_id" ON "public"."encounter_orders" USING "btree" ("encounter_id");



CREATE INDEX "idx_encounter_orders_status" ON "public"."encounter_orders" USING "btree" ("status");



CREATE INDEX "idx_encounter_orders_tid" ON "public"."encounter_orders" USING "btree" ("tenant_id");



CREATE INDEX "idx_encounter_orders_type_status" ON "public"."encounter_orders" USING "btree" ("order_type", "status");



CREATE INDEX "idx_encounters_created_at" ON "public"."encounters" USING "btree" ("created_at" DESC);



CREATE INDEX "idx_encounters_hospital_id" ON "public"."encounters" USING "btree" ("hospital_id");



CREATE INDEX "idx_encounters_patient_id" ON "public"."encounters" USING "btree" ("patient_id");



CREATE INDEX "idx_encounters_patient_identifier_hash" ON "public"."encounters" USING "btree" ("patient_identifier_hash");



CREATE INDEX "idx_encounters_tenant_clinician" ON "public"."encounters" USING "btree" ("tenant_id", "clinician_id", "visit_date" DESC);



CREATE INDEX "idx_encounters_tenant_id" ON "public"."encounters" USING "btree" ("tenant_id");



CREATE INDEX "idx_encounters_tenant_patient" ON "public"."encounters" USING "btree" ("tenant_id", "patient_id", "visit_date" DESC);



CREATE INDEX "idx_expert_rules_active_category" ON "public"."expert_rules" USING "btree" ("active", "category");



CREATE INDEX "idx_expert_rules_effective_date" ON "public"."expert_rules" USING "btree" ("effective_date" DESC);



CREATE INDEX "idx_expert_rules_tid" ON "public"."expert_rules" USING "btree" ("tenant_id");



CREATE INDEX "idx_export_jobs_hospital_status" ON "public"."data_export_jobs" USING "btree" ("hospital_id", "status", "created_at" DESC);



CREATE INDEX "idx_export_jobs_requester" ON "public"."data_export_jobs" USING "btree" ("requested_by", "status", "created_at" DESC);



CREATE INDEX "idx_facility_domain_records_tenant" ON "public"."facility_domain_records" USING "btree" ("tenant_id", "status");



CREATE INDEX "idx_facility_invitations_tenant" ON "public"."facility_invitations" USING "btree" ("tenant_id", "status");



CREATE INDEX "idx_facility_invitations_token" ON "public"."facility_invitations" USING "btree" ("invite_token");



CREATE INDEX "idx_facility_locations_department" ON "public"."facility_locations" USING "btree" ("department_id");



CREATE INDEX "idx_facility_locations_parent" ON "public"."facility_locations" USING "btree" ("parent_id");



CREATE INDEX "idx_facility_locations_tenant" ON "public"."facility_locations" USING "btree" ("tenant_id");



CREATE UNIQUE INDEX "idx_facility_provisioning_runs_idempotency" ON "public"."facility_provisioning_runs" USING "btree" ("idempotency_key");



CREATE INDEX "idx_facility_provisioning_runs_slug" ON "public"."facility_provisioning_runs" USING "btree" ("slug", "created_at" DESC);



CREATE INDEX "idx_facility_provisioning_runs_tenant" ON "public"."facility_provisioning_runs" USING "btree" ("tenant_id");



CREATE INDEX "idx_facility_provisioning_steps_run" ON "public"."facility_provisioning_steps" USING "btree" ("run_id", "step");



CREATE INDEX "idx_facility_referrals_from_tenant" ON "public"."facility_referrals" USING "btree" ("from_tenant_id", "created_at" DESC);



CREATE INDEX "idx_facility_referrals_to_tenant" ON "public"."facility_referrals" USING "btree" ("to_tenant_id", "created_at" DESC);



CREATE INDEX "idx_gas_cylinders_tid" ON "public"."gas_cylinders" USING "btree" ("tenant_id");



CREATE INDEX "idx_handover_entries_handover" ON "public"."handover_patient_entries" USING "btree" ("handover_id", "acuity_level", "patient_id");



CREATE INDEX "idx_handover_patient_entries_tid" ON "public"."handover_patient_entries" USING "btree" ("tenant_id");



CREATE INDEX "idx_handover_shift_tasks_tid" ON "public"."handover_shift_tasks" USING "btree" ("tenant_id");



CREATE INDEX "idx_handover_signatures_tid" ON "public"."handover_signatures" USING "btree" ("tenant_id");



CREATE INDEX "idx_handovers_department" ON "public"."care_team_handovers" USING "btree" ("department_id", "shift_start" DESC);



CREATE INDEX "idx_handovers_hospital_shift" ON "public"."care_team_handovers" USING "btree" ("hospital_id", "shift_start" DESC, "status");



CREATE INDEX "idx_health_bulletins_tid" ON "public"."health_bulletins" USING "btree" ("tenant_id");



CREATE INDEX "idx_hospital_beds_hospital_id" ON "public"."hospital_beds" USING "btree" ("hospital_id");



CREATE INDEX "idx_hospital_beds_status" ON "public"."hospital_beds" USING "btree" ("status");



CREATE INDEX "idx_hospital_beds_tid" ON "public"."hospital_beds" USING "btree" ("tenant_id");



CREATE INDEX "idx_hospital_drug_orders_encounter_id" ON "public"."hospital_drug_orders" USING "btree" ("encounter_id");



CREATE INDEX "idx_hospital_drug_orders_patient_hash" ON "public"."hospital_drug_orders" USING "btree" ("patient_identifier_hash");



CREATE INDEX "idx_hospital_drug_orders_status" ON "public"."hospital_drug_orders" USING "btree" ("status");



CREATE INDEX "idx_hospital_drug_orders_tid" ON "public"."hospital_drug_orders" USING "btree" ("tenant_id");



CREATE INDEX "idx_hospital_modules_tenant" ON "public"."hospital_modules" USING "btree" ("tenant_id", "module_key");



CREATE INDEX "idx_hospital_modules_tid" ON "public"."hospital_modules" USING "btree" ("tenant_id");



CREATE INDEX "idx_hospital_seed_registry_tenant" ON "public"."hospital_seed_registry" USING "btree" ("tenant_id");



CREATE INDEX "idx_hospital_settings_tid" ON "public"."hospital_settings" USING "btree" ("tenant_id");



CREATE UNIQUE INDEX "idx_hospitals_subdomain" ON "public"."hospitals" USING "btree" ("subdomain");



CREATE INDEX "idx_housekeeping_tasks_scheduled_time" ON "public"."housekeeping_tasks" USING "btree" ("scheduled_time");



CREATE INDEX "idx_housekeeping_tasks_tenant" ON "public"."housekeeping_tasks" USING "btree" ("tenant_id");



CREATE INDEX "idx_imaging_series_study" ON "public"."imaging_series" USING "btree" ("study_id", "series_number");



CREATE INDEX "idx_imaging_series_tid" ON "public"."imaging_series" USING "btree" ("tenant_id");



CREATE INDEX "idx_imaging_studies_hospital_worklist" ON "public"."imaging_studies" USING "btree" ("hospital_id", "worklist_status", "priority" DESC, "study_date" DESC);



CREATE INDEX "idx_imaging_studies_modality" ON "public"."imaging_studies" USING "btree" ("hospital_id", "modality", "study_date" DESC);



CREATE INDEX "idx_imaging_studies_patient_date" ON "public"."imaging_studies" USING "btree" ("patient_id", "study_date" DESC);



CREATE INDEX "idx_imaging_studies_tid" ON "public"."imaging_studies" USING "btree" ("tenant_id");



CREATE INDEX "idx_immunization_schedule_due_date" ON "public"."immunization_schedule" USING "btree" ("due_date");



CREATE INDEX "idx_immunization_schedule_patient_id" ON "public"."immunization_schedule" USING "btree" ("patient_id");



CREATE INDEX "idx_immunization_schedule_tid" ON "public"."immunization_schedule" USING "btree" ("tenant_id");



CREATE INDEX "idx_import_batch_rows_batch_status" ON "public"."import_batch_rows" USING "btree" ("batch_id", "status", "row_number");



CREATE INDEX "idx_import_batch_rows_tid" ON "public"."import_batch_rows" USING "btree" ("tenant_id");



CREATE INDEX "idx_import_batches_hospital_status" ON "public"."import_batches" USING "btree" ("hospital_id", "status", "created_at" DESC);



CREATE INDEX "idx_import_batches_tid" ON "public"."import_batches" USING "btree" ("tenant_id");



CREATE INDEX "idx_import_column_mappings_tid" ON "public"."import_column_mappings" USING "btree" ("tenant_id");



CREATE UNIQUE INDEX "idx_import_column_mappings_unique" ON "public"."import_column_mappings" USING "btree" ("batch_id", "entity", "source_column", "target_column");



CREATE INDEX "idx_insurance_claims_tenant_id" ON "public"."insurance_claims" USING "btree" ("tenant_id");



CREATE INDEX "idx_inventory_items_active" ON "public"."inventory_items" USING "btree" ("is_active");



CREATE INDEX "idx_inventory_items_generic_name" ON "public"."inventory_items" USING "btree" ("lower"("generic_name"));



CREATE INDEX "idx_inventory_items_tid" ON "public"."inventory_items" USING "btree" ("tenant_id");



CREATE UNIQUE INDEX "idx_lab_device_messages_dedupe" ON "public"."lab_device_messages" USING "btree" ("tenant_id", "payload_hash", COALESCE("message_control_id", ''::"text"));



CREATE INDEX "idx_lab_devices_tenant" ON "public"."lab_devices" USING "btree" ("tenant_id", "active");



CREATE INDEX "idx_lab_orders_replaces" ON "public"."lab_orders" USING "btree" ("tenant_id", "replaces_lab_order_id") WHERE ("replaces_lab_order_id" IS NOT NULL);



CREATE INDEX "idx_lab_orders_status" ON "public"."lab_orders" USING "btree" ("tenant_id", "status");



CREATE INDEX "idx_lab_orders_tenant" ON "public"."lab_orders" USING "btree" ("tenant_id");



CREATE UNIQUE INDEX "idx_lab_reports_final_order" ON "public"."lab_reports" USING "btree" ("tenant_id", "lab_order_id") WHERE (("status" = 'FINAL'::"text") AND ("version" = 1));



CREATE INDEX "idx_lab_reports_patient" ON "public"."lab_reports" USING "btree" ("tenant_id", "patient_id", "released_at" DESC);



CREATE INDEX "idx_lab_results_created_at" ON "public"."lab_results" USING "btree" ("created_at" DESC);



CREATE INDEX "idx_lab_results_encounter_id" ON "public"."lab_results" USING "btree" ("encounter_id");



CREATE INDEX "idx_lab_results_order" ON "public"."lab_results" USING "btree" ("tenant_id", "lab_order_id");



CREATE INDEX "idx_lab_results_tid" ON "public"."lab_results" USING "btree" ("tenant_id");



CREATE INDEX "idx_live_feed_active" ON "public"."live_feed_sessions" USING "btree" ("synapse_id", "status");



CREATE INDEX "idx_live_feed_sessions_tid" ON "public"."live_feed_sessions" USING "btree" ("tenant_id");



CREATE INDEX "idx_loinc_reference_category" ON "public"."loinc_reference" USING "btree" ("category");



CREATE INDEX "idx_loinc_reference_display_name" ON "public"."loinc_reference" USING "btree" ("display_name");



CREATE INDEX "idx_loinc_reference_tid" ON "public"."loinc_reference" USING "btree" ("tenant_id");



CREATE INDEX "idx_maternity_records_created_at" ON "public"."maternity_records" USING "btree" ("created_at" DESC);



CREATE INDEX "idx_maternity_records_patient_id" ON "public"."maternity_records" USING "btree" ("patient_id");



CREATE INDEX "idx_maternity_records_tid" ON "public"."maternity_records" USING "btree" ("tenant_id");



CREATE INDEX "idx_medical_devices_tid" ON "public"."medical_devices" USING "btree" ("tenant_id");



CREATE INDEX "idx_medication_safety_checks_tid" ON "public"."medication_safety_checks" USING "btree" ("tenant_id");



CREATE INDEX "idx_medsafety_hospital_alerts" ON "public"."medication_safety_checks" USING "btree" ("hospital_id", "alert_count", "checked_at" DESC) WHERE ("alert_count" > 0);



CREATE INDEX "idx_medsafety_patient_date" ON "public"."medication_safety_checks" USING "btree" ("patient_id", "checked_at" DESC);



CREATE INDEX "idx_mfa_enrollments_user_id" ON "public"."mfa_enrollments" USING "btree" ("user_id");



CREATE INDEX "idx_nin_access_log_accessed" ON "public"."nin_access_log" USING "btree" ("accessed_by");



CREATE INDEX "idx_nin_access_log_created" ON "public"."nin_access_log" USING "btree" ("created_at");



CREATE INDEX "idx_nin_access_log_hospital" ON "public"."nin_access_log" USING "btree" ("hospital_id");



CREATE INDEX "idx_nin_access_log_tid" ON "public"."nin_access_log" USING "btree" ("tenant_id");



CREATE INDEX "idx_notifications_is_read" ON "public"."notifications" USING "btree" ("is_read");



CREATE INDEX "idx_notifications_user_id_created_at" ON "public"."notifications" USING "btree" ("user_id", "created_at" DESC);



CREATE INDEX "idx_notifications_user_tenant" ON "public"."notifications" USING "btree" ("user_id", "tenant_id", "is_read", "created_at" DESC);



CREATE INDEX "idx_order_items_tid" ON "public"."order_items" USING "btree" ("tenant_id");



CREATE INDEX "idx_order_mappings_tid" ON "public"."order_mappings" USING "btree" ("tenant_id");



CREATE INDEX "idx_orders_tid" ON "public"."orders" USING "btree" ("tenant_id");



CREATE INDEX "idx_outbreak_active" ON "public"."outbreak_alerts" USING "btree" ("is_active") WHERE ("is_active" = true);



CREATE INDEX "idx_outreach_campaigns_tid" ON "public"."outreach_campaigns" USING "btree" ("tenant_id");



CREATE INDEX "idx_partograph_records_patient" ON "public"."partograph_records" USING "btree" ("patient_id");



CREATE INDEX "idx_partograph_records_tenant" ON "public"."partograph_records" USING "btree" ("tenant_id");



CREATE INDEX "idx_passport_tokens_token" ON "public"."passport_share_tokens" USING "btree" ("token");



CREATE INDEX "idx_pathway_alerts_hospital_status" ON "public"."pathway_alerts" USING "btree" ("hospital_id", "status", "triggered_at" DESC);



CREATE INDEX "idx_pathway_alerts_tid" ON "public"."pathway_alerts" USING "btree" ("tenant_id");



CREATE INDEX "idx_pathway_checklist_items_tid" ON "public"."pathway_checklist_items" USING "btree" ("tenant_id");



CREATE INDEX "idx_pathway_checklist_pathway" ON "public"."pathway_checklist_items" USING "btree" ("pathway_id", "step_order", "status");



CREATE UNIQUE INDEX "idx_pathway_templates_global_slug" ON "public"."clinical_pathway_templates" USING "btree" ("slug") WHERE ("hospital_id" IS NULL);



CREATE INDEX "idx_patient_access_grants_tid" ON "public"."patient_access_grants" USING "btree" ("tenant_id");



CREATE INDEX "idx_patient_allergies_atc" ON "public"."patient_allergies" USING "btree" ("atc_code") WHERE ("atc_code" IS NOT NULL);



CREATE INDEX "idx_patient_allergies_patient" ON "public"."patient_allergies" USING "btree" ("patient_id", "allergen_type", "is_active");



CREATE INDEX "idx_patient_allergies_tid" ON "public"."patient_allergies" USING "btree" ("tenant_id");



CREATE INDEX "idx_patient_billing_encounter_id" ON "public"."patient_billing" USING "btree" ("encounter_id");



CREATE INDEX "idx_patient_billing_tid" ON "public"."patient_billing" USING "btree" ("tenant_id");



CREATE INDEX "idx_patient_consents_tid" ON "public"."patient_consents" USING "btree" ("tenant_id");



CREATE INDEX "idx_patient_notes_tid" ON "public"."patient_notes" USING "btree" ("tenant_id");



CREATE INDEX "idx_patient_pathways_hospital_active" ON "public"."patient_pathways" USING "btree" ("hospital_id", "status", "started_at" DESC);



CREATE INDEX "idx_patient_pathways_patient_active" ON "public"."patient_pathways" USING "btree" ("patient_id", "status", "started_at" DESC);



CREATE INDEX "idx_patient_pathways_tid" ON "public"."patient_pathways" USING "btree" ("tenant_id");



CREATE INDEX "idx_patient_problem_list_tid" ON "public"."patient_problem_list" USING "btree" ("tenant_id");



CREATE INDEX "idx_patient_profiles_hospital_id" ON "public"."patient_profiles" USING "btree" ("hospital_id");



CREATE INDEX "idx_patient_profiles_synapse_id" ON "public"."patient_profiles" USING "btree" ("synapse_id");



CREATE INDEX "idx_patient_safety_events_tid" ON "public"."patient_safety_events" USING "btree" ("tenant_id");



CREATE INDEX "idx_patient_sms_reminders_tid" ON "public"."patient_sms_reminders" USING "btree" ("tenant_id");



CREATE INDEX "idx_patient_timeline_events_tid" ON "public"."patient_timeline_events" USING "btree" ("tenant_id");



CREATE INDEX "idx_patient_timeline_pins_tid" ON "public"."patient_timeline_pins" USING "btree" ("tenant_id");



CREATE INDEX "idx_patient_vitals_patient" ON "public"."patient_vitals" USING "btree" ("patient_id", "recorded_at" DESC);



CREATE INDEX "idx_patients_created_at" ON "public"."patients" USING "btree" ("created_at" DESC);



CREATE INDEX "idx_patients_hospital_id" ON "public"."patients" USING "btree" ("hospital_id");



CREATE UNIQUE INDEX "idx_patients_mrn_hospital_unique" ON "public"."patients" USING "btree" ("hospital_id", "mrn");



CREATE INDEX "idx_patients_name_trgm" ON "public"."patients" USING "gin" ("full_name" "public"."gin_trgm_ops") WHERE ("full_name" IS NOT NULL);



CREATE INDEX "idx_patients_nin" ON "public"."patients" USING "btree" ("nin");



CREATE UNIQUE INDEX "idx_patients_nin_hospital" ON "public"."patients" USING "btree" ("hospital_id", "nin_hash") WHERE ("nin_hash" IS NOT NULL);



CREATE INDEX "idx_patients_phone" ON "public"."patients" USING "btree" ("phone");



CREATE INDEX "idx_patients_tenant_id" ON "public"."patients" USING "btree" ("tenant_id");



CREATE INDEX "idx_payer_contracts_hospital" ON "public"."payer_contracts" USING "btree" ("hospital_id", "is_active", "expiry_date");



CREATE INDEX "idx_payer_contracts_tid" ON "public"."payer_contracts" USING "btree" ("tenant_id");



CREATE INDEX "idx_pediatric_growth_patient_id" ON "public"."pediatric_growth_records" USING "btree" ("patient_id");



CREATE INDEX "idx_pediatric_growth_records_tid" ON "public"."pediatric_growth_records" USING "btree" ("tenant_id");



CREATE INDEX "idx_pharm_adj_product" ON "public"."pharmacy_stock_adjustments" USING "btree" ("product_id");



CREATE INDEX "idx_pharm_adj_tenant" ON "public"."pharmacy_stock_adjustments" USING "btree" ("tenant_id");



CREATE INDEX "idx_pharm_audit_entity" ON "public"."pharmacy_audit_logs" USING "btree" ("tenant_id", "entity", "entity_id");



CREATE INDEX "idx_pharm_audit_profile" ON "public"."pharmacy_audit_logs" USING "btree" ("profile_id");



CREATE INDEX "idx_pharm_audit_tenant" ON "public"."pharmacy_audit_logs" USING "btree" ("tenant_id");



CREATE INDEX "idx_pharm_batch_active" ON "public"."pharmacy_product_batches" USING "btree" ("product_id", "is_active") WHERE ("is_active" = true);



CREATE INDEX "idx_pharm_batch_expiry" ON "public"."pharmacy_product_batches" USING "btree" ("expiry_date");



CREATE INDEX "idx_pharm_batch_product" ON "public"."pharmacy_product_batches" USING "btree" ("product_id");



CREATE INDEX "idx_pharm_clients_name" ON "public"."pharmacy_clients" USING "btree" ("tenant_id", "lower"("name"));



CREATE INDEX "idx_pharm_clients_tenant" ON "public"."pharmacy_clients" USING "btree" ("tenant_id");



CREATE INDEX "idx_pharm_customers_email" ON "public"."pharmacy_customers" USING "btree" ("tenant_id", "email");



CREATE INDEX "idx_pharm_customers_tenant" ON "public"."pharmacy_customers" USING "btree" ("tenant_id");



CREATE INDEX "idx_pharm_edits_txn" ON "public"."pharmacy_transaction_edits" USING "btree" ("transaction_id");



CREATE INDEX "idx_pharm_inquiries_status" ON "public"."pharmacy_inquiries" USING "btree" ("tenant_id", "status");



CREATE INDEX "idx_pharm_inquiries_tenant" ON "public"."pharmacy_inquiries" USING "btree" ("tenant_id");



CREATE INDEX "idx_pharm_notif_profile" ON "public"."pharmacy_notifications" USING "btree" ("profile_id", "is_read");



CREATE INDEX "idx_pharm_notif_tenant" ON "public"."pharmacy_notifications" USING "btree" ("tenant_id");



CREATE INDEX "idx_pharm_order_items_order" ON "public"."pharmacy_order_items" USING "btree" ("order_id");



CREATE INDEX "idx_pharm_order_items_product" ON "public"."pharmacy_order_items" USING "btree" ("product_id");



CREATE INDEX "idx_pharm_orders_customer" ON "public"."pharmacy_orders" USING "btree" ("customer_id");



CREATE INDEX "idx_pharm_orders_status" ON "public"."pharmacy_orders" USING "btree" ("tenant_id", "status");



CREATE INDEX "idx_pharm_orders_tenant" ON "public"."pharmacy_orders" USING "btree" ("tenant_id");



CREATE INDEX "idx_pharm_pkg_product" ON "public"."pharmacy_product_packages" USING "btree" ("product_id");



CREATE INDEX "idx_pharm_po_items_po" ON "public"."pharmacy_purchase_order_items" USING "btree" ("purchase_order_id");



CREATE INDEX "idx_pharm_po_items_product" ON "public"."pharmacy_purchase_order_items" USING "btree" ("product_id");



CREATE INDEX "idx_pharm_po_status" ON "public"."pharmacy_purchase_orders" USING "btree" ("tenant_id", "status");



CREATE INDEX "idx_pharm_po_supplier" ON "public"."pharmacy_purchase_orders" USING "btree" ("supplier_id");



CREATE INDEX "idx_pharm_po_tenant" ON "public"."pharmacy_purchase_orders" USING "btree" ("tenant_id");



CREATE INDEX "idx_pharm_products_active" ON "public"."pharmacy_products" USING "btree" ("tenant_id", "is_active");



CREATE INDEX "idx_pharm_products_low_stock" ON "public"."pharmacy_products" USING "btree" ("tenant_id", "quantity", "reorder_level") WHERE ("quantity" <= "reorder_level");



CREATE INDEX "idx_pharm_products_name" ON "public"."pharmacy_products" USING "btree" ("tenant_id", "lower"("name"));



CREATE INDEX "idx_pharm_products_tenant" ON "public"."pharmacy_products" USING "btree" ("tenant_id");



CREATE INDEX "idx_pharm_suppliers_tenant" ON "public"."pharmacy_suppliers" USING "btree" ("tenant_id");



CREATE INDEX "idx_pharm_txn_cashier" ON "public"."pharmacy_transactions" USING "btree" ("cashier_id");



CREATE INDEX "idx_pharm_txn_customer" ON "public"."pharmacy_transactions" USING "btree" ("customer_id");



CREATE INDEX "idx_pharm_txn_date" ON "public"."pharmacy_transactions" USING "btree" ("tenant_id", "created_at" DESC);



CREATE INDEX "idx_pharm_txn_items_product" ON "public"."pharmacy_transaction_items" USING "btree" ("product_id");



CREATE INDEX "idx_pharm_txn_items_txn" ON "public"."pharmacy_transaction_items" USING "btree" ("transaction_id");



CREATE INDEX "idx_pharm_txn_no" ON "public"."pharmacy_transactions" USING "btree" ("tenant_id", "transaction_no");



CREATE INDEX "idx_pharm_txn_tenant" ON "public"."pharmacy_transactions" USING "btree" ("tenant_id");



CREATE INDEX "idx_pharmacy_credit_ledger_customer" ON "public"."pharmacy_credit_ledger" USING "btree" ("customer_id");



CREATE INDEX "idx_pharmacy_credit_ledger_due_date" ON "public"."pharmacy_credit_ledger" USING "btree" ("due_date");



CREATE INDEX "idx_pharmacy_credit_ledger_tenant" ON "public"."pharmacy_credit_ledger" USING "btree" ("tenant_id");



CREATE INDEX "idx_pharmacy_expenses_date" ON "public"."pharmacy_expenses" USING "btree" ("expense_date");



CREATE INDEX "idx_pharmacy_expenses_tenant" ON "public"."pharmacy_expenses" USING "btree" ("tenant_id");



CREATE INDEX "idx_pharmacy_import_sessions_status" ON "public"."pharmacy_import_sessions" USING "btree" ("status");



CREATE INDEX "idx_pharmacy_import_sessions_tenant" ON "public"."pharmacy_import_sessions" USING "btree" ("tenant_id");



CREATE INDEX "idx_pharmacy_inventory_tenant_drug" ON "public"."pharmacy_network_inventory" USING "btree" ("pharmacy_tenant_id", "drug_name");



CREATE INDEX "idx_pharmacy_orders_tenant_status" ON "public"."pharmacy_orders" USING "btree" ("tenant_id", "status", "created_at" DESC);



CREATE INDEX "idx_pharmacy_product_batches_sellable" ON "public"."pharmacy_product_batches" USING "btree" ("tenant_id", "product_id", "expiry_date") WHERE (("status" = 'active'::"text") AND ("quantity" > 0));



CREATE INDEX "idx_pharmacy_profiles_custom_domain" ON "public"."pharmacy_profiles" USING "btree" ("custom_domain");



CREATE INDEX "idx_pharmacy_profiles_tenant" ON "public"."pharmacy_profiles" USING "btree" ("tenant_id");



CREATE INDEX "idx_pharmacy_staff_permissions_staff" ON "public"."pharmacy_staff_permissions" USING "btree" ("staff_id");



CREATE INDEX "idx_pharmacy_staff_permissions_tenant" ON "public"."pharmacy_staff_permissions" USING "btree" ("tenant_id");



CREATE INDEX "idx_pharmacy_stores_active" ON "public"."pharmacy_stores" USING "btree" ("is_active");



CREATE INDEX "idx_pharmacy_stores_tid" ON "public"."pharmacy_stores" USING "btree" ("tenant_id");



CREATE INDEX "idx_phi_access_actor_date" ON "public"."phi_access_log" USING "btree" ("actor_id", "accessed_at" DESC);



CREATE INDEX "idx_phi_access_hospital_date" ON "public"."phi_access_log" USING "btree" ("hospital_id", "accessed_at" DESC);



CREATE INDEX "idx_phi_access_log_tid" ON "public"."phi_access_log" USING "btree" ("tenant_id");



CREATE INDEX "idx_phi_access_patient_date" ON "public"."phi_access_log" USING "btree" ("patient_id", "accessed_at" DESC);



CREATE INDEX "idx_platform_approvals_status" ON "public"."platform_approvals" USING "btree" ("status", "requested_at" DESC);



CREATE INDEX "idx_platform_audit_action" ON "public"."platform_audit_events" USING "btree" ("action", "created_at" DESC);



CREATE INDEX "idx_platform_audit_actor" ON "public"."platform_audit_events" USING "btree" ("actor_id", "created_at" DESC);



CREATE INDEX "idx_platform_audit_correlation" ON "public"."platform_audit_events" USING "btree" ("correlation_id");



CREATE INDEX "idx_platform_audit_created" ON "public"."platform_audit_events" USING "btree" ("created_at" DESC);



CREATE INDEX "idx_platform_incidents_status" ON "public"."platform_incidents" USING "btree" ("status", "created_at" DESC);



CREATE INDEX "idx_platform_test_runs_correlation" ON "public"."platform_test_runs" USING "btree" ("correlation_id");



CREATE INDEX "idx_platform_test_runs_started" ON "public"."platform_test_runs" USING "btree" ("started_at" DESC);



CREATE INDEX "idx_platform_test_runs_suite" ON "public"."platform_test_runs" USING "btree" ("suite", "started_at" DESC);



CREATE INDEX "idx_pos_sales_tenant_created" ON "public"."pharmacy_pos_sales" USING "btree" ("tenant_id", "created_at" DESC);



CREATE INDEX "idx_problem_list_patient" ON "public"."patient_problem_list" USING "btree" ("patient_id", "status", "onset_date" DESC);



CREATE INDEX "idx_products_tid" ON "public"."products" USING "btree" ("tenant_id");



CREATE INDEX "idx_profiles_app_user" ON "public"."profiles" USING "btree" ("app_user");



CREATE INDEX "idx_profiles_department_id" ON "public"."profiles" USING "btree" ("department_id");



CREATE INDEX "idx_profiles_email_override" ON "public"."profiles" USING "btree" ("email_override");



CREATE INDEX "idx_profiles_hospital_id" ON "public"."profiles" USING "btree" ("hospital_id");



CREATE INDEX "idx_profiles_role" ON "public"."profiles" USING "btree" ("role");



CREATE INDEX "idx_profiles_synapse_id" ON "public"."profiles" USING "btree" ("synapse_id");



CREATE INDEX "idx_profiles_tenant_id" ON "public"."profiles" USING "btree" ("tenant_id");



CREATE INDEX "idx_provider_verification_checks_provider" ON "public"."provider_verification_checks" USING "btree" ("provider_id", "created_at" DESC);



CREATE INDEX "idx_provider_verification_checks_tid" ON "public"."provider_verification_checks" USING "btree" ("tenant_id");



CREATE INDEX "idx_purchase_orders_status" ON "public"."purchase_orders" USING "btree" ("status");



CREATE INDEX "idx_purchase_orders_supplier_id" ON "public"."purchase_orders" USING "btree" ("supplier_id");



CREATE INDEX "idx_purchase_orders_tid" ON "public"."purchase_orders" USING "btree" ("tenant_id");



CREATE INDEX "idx_radiology_report_templates_tid" ON "public"."radiology_report_templates" USING "btree" ("tenant_id");



CREATE INDEX "idx_radiology_reports_critical" ON "public"."radiology_reports" USING "btree" ("hospital_id", "is_critical", "reported_at" DESC) WHERE ("is_critical" = true);



CREATE INDEX "idx_radiology_reports_encounter_id" ON "public"."radiology_reports" USING "btree" ("encounter_id");



CREATE INDEX "idx_radiology_reports_hospital_id" ON "public"."radiology_reports" USING "btree" ("hospital_id") WHERE ("hospital_id" IS NOT NULL);



CREATE INDEX "idx_radiology_reports_hospital_status" ON "public"."radiology_reports" USING "btree" ("hospital_id", "status", "reported_at" DESC);



CREATE INDEX "idx_radiology_reports_radiographer_id" ON "public"."radiology_reports" USING "btree" ("radiographer_id");



CREATE INDEX "idx_radiology_reports_radiologist" ON "public"."radiology_reports" USING "btree" ("radiologist_id", "status", "created_at" DESC);



CREATE INDEX "idx_radiology_reports_tid" ON "public"."radiology_reports" USING "btree" ("tenant_id");



CREATE INDEX "idx_receipt_reprints_sale" ON "public"."pharmacy_receipt_reprints" USING "btree" ("sale_id");



CREATE INDEX "idx_receipt_reprints_tenant_time" ON "public"."pharmacy_receipt_reprints" USING "btree" ("tenant_id", "created_at");



CREATE INDEX "idx_referral_requests_tid" ON "public"."referral_requests" USING "btree" ("tenant_id");



CREATE INDEX "idx_referrals_from_hospital" ON "public"."referral_requests" USING "btree" ("from_hospital_id", "status", "created_at" DESC);



CREATE INDEX "idx_referrals_to_hospital" ON "public"."referral_requests" USING "btree" ("to_hospital_id", "status", "created_at" DESC);



CREATE INDEX "idx_referrals_urgency" ON "public"."referral_requests" USING "btree" ("urgency", "status", "created_at" DESC);



CREATE INDEX "idx_refill_reminders_customer" ON "public"."refill_reminders" USING "btree" ("customer_id");



CREATE INDEX "idx_refill_reminders_due_date" ON "public"."refill_reminders" USING "btree" ("refill_due_date");



CREATE INDEX "idx_refill_reminders_tenant" ON "public"."refill_reminders" USING "btree" ("tenant_id");



CREATE INDEX "idx_renal_adjustments_catalog_drug" ON "public"."renal_adjustments_catalog" USING "btree" ("drug_atc");



CREATE INDEX "idx_renal_adjustments_catalog_tid" ON "public"."renal_adjustments_catalog" USING "btree" ("tenant_id");



CREATE INDEX "idx_report_templates_hospital_modality" ON "public"."radiology_report_templates" USING "btree" ("hospital_id", "modality", "is_active");



CREATE INDEX "idx_restaurants_tid" ON "public"."restaurants" USING "btree" ("tenant_id");



CREATE UNIQUE INDEX "idx_retention_global_table" ON "public"."data_retention_policies" USING "btree" ("table_name") WHERE ("hospital_id" IS NULL);



CREATE INDEX "idx_role_capabilities_role" ON "public"."role_capabilities" USING "btree" ("role");



CREATE INDEX "idx_rule_executions_encounter_id" ON "public"."rule_executions" USING "btree" ("encounter_id", "executed_at" DESC);



CREATE INDEX "idx_rule_executions_patient_id" ON "public"."rule_executions" USING "btree" ("patient_id", "executed_at" DESC);



CREATE INDEX "idx_rule_executions_tid" ON "public"."rule_executions" USING "btree" ("tenant_id");



CREATE INDEX "idx_scan_events_barcode" ON "public"."scan_events" USING "btree" ("barcode", "scanned_at" DESC);



CREATE INDEX "idx_scan_events_hospital_type" ON "public"."scan_events" USING "btree" ("hospital_id", "scan_type", "scanned_at" DESC);



CREATE INDEX "idx_scan_events_tid" ON "public"."scan_events" USING "btree" ("tenant_id");



CREATE INDEX "idx_score_calc_patient" ON "public"."score_calculations" USING "btree" ("patient_id");



CREATE INDEX "idx_sdg_indicators_hospital_goal" ON "public"."sdg_indicators" USING "btree" ("hospital_id", "goal_number", "recorded_at" DESC);



CREATE INDEX "idx_sentinel_alerts_hospital" ON "public"."sentinel_alerts" USING "btree" ("hospital_id", "status", "created_at" DESC);



CREATE INDEX "idx_sentinel_alerts_tid" ON "public"."sentinel_alerts" USING "btree" ("tenant_id");



CREATE INDEX "idx_service_catalog_active" ON "public"."service_catalog" USING "btree" ("is_active");



CREATE INDEX "idx_service_catalog_tid" ON "public"."service_catalog" USING "btree" ("tenant_id");



CREATE INDEX "idx_shift_tasks_handover_priority" ON "public"."handover_shift_tasks" USING "btree" ("handover_id", "priority", "status");



CREATE INDEX "idx_shortage_alerts_active_drug" ON "public"."drug_shortage_alerts" USING "btree" ("is_active", "drug_name");



CREATE INDEX "idx_sms_reminders_patient" ON "public"."patient_sms_reminders" USING "btree" ("patient_id", "created_at" DESC);



CREATE INDEX "idx_sms_reminders_scheduled" ON "public"."patient_sms_reminders" USING "btree" ("status", "scheduled_at") WHERE ("status" = 'pending'::"text");



CREATE INDEX "idx_staff_attendance_check_in" ON "public"."staff_attendance" USING "btree" ("check_in");



CREATE INDEX "idx_staff_attendance_profile_id" ON "public"."staff_attendance" USING "btree" ("profile_id");



CREATE INDEX "idx_staff_attendance_tid" ON "public"."staff_attendance" USING "btree" ("tenant_id");



CREATE INDEX "idx_staff_leave_profile_id" ON "public"."staff_leave_requests" USING "btree" ("profile_id");



CREATE INDEX "idx_staff_leave_requests_tid" ON "public"."staff_leave_requests" USING "btree" ("tenant_id");



CREATE INDEX "idx_sub_events_created" ON "public"."subscription_events" USING "btree" ("created_at" DESC);



CREATE INDEX "idx_sub_events_tenant" ON "public"."subscription_events" USING "btree" ("tenant_id");



CREATE INDEX "idx_sub_invoices_created" ON "public"."subscription_invoices" USING "btree" ("created_at" DESC);



CREATE INDEX "idx_sub_invoices_tenant" ON "public"."subscription_invoices" USING "btree" ("tenant_id");



CREATE INDEX "idx_sub_payments_created" ON "public"."subscription_payments" USING "btree" ("created_at" DESC);



CREATE INDEX "idx_sub_payments_status" ON "public"."subscription_payments" USING "btree" ("status");



CREATE INDEX "idx_sub_payments_tenant" ON "public"."subscription_payments" USING "btree" ("tenant_id");



CREATE INDEX "idx_suppliers_tid" ON "public"."suppliers" USING "btree" ("tenant_id");



CREATE INDEX "idx_support_ticket_events_actor" ON "public"."support_ticket_events" USING "btree" ("actor_id");



CREATE INDEX "idx_support_ticket_events_ticket" ON "public"."support_ticket_events" USING "btree" ("ticket_id");



CREATE INDEX "idx_support_tickets_assigned" ON "public"."support_tickets" USING "btree" ("assigned_to");



CREATE INDEX "idx_support_tickets_created" ON "public"."support_tickets" USING "btree" ("created_at" DESC);



CREATE INDEX "idx_support_tickets_status" ON "public"."support_tickets" USING "btree" ("status");



CREATE INDEX "idx_support_tickets_tenant" ON "public"."support_tickets" USING "btree" ("tenant_id");



CREATE INDEX "idx_surgery_schedules_patient_id" ON "public"."surgery_schedules" USING "btree" ("patient_id");



CREATE INDEX "idx_surgery_schedules_scheduled_at" ON "public"."surgery_schedules" USING "btree" ("scheduled_at");



CREATE INDEX "idx_surgery_schedules_tid" ON "public"."surgery_schedules" USING "btree" ("tenant_id");



CREATE INDEX "idx_surveillance_district" ON "public"."surveillance_reports" USING "btree" ("district", "created_at" DESC);



CREATE INDEX "idx_surveillance_reports_tid" ON "public"."surveillance_reports" USING "btree" ("tenant_id");



CREATE INDEX "idx_surveillance_symptoms" ON "public"."surveillance_reports" USING "gin" ("symptoms");



CREATE INDEX "idx_synapse_sessions_hash" ON "public"."synapse_sessions" USING "btree" ("token_hash");



CREATE INDEX "idx_synapse_sessions_user" ON "public"."synapse_sessions" USING "btree" ("user_id");



CREATE INDEX "idx_synapse_sessions_user_app" ON "public"."synapse_sessions" USING "btree" ("user_id", "app");



CREATE INDEX "idx_sync_conflicts_hospital_status" ON "public"."sync_conflicts" USING "btree" ("hospital_id", "status", "created_at" DESC);



CREATE INDEX "idx_sync_conflicts_table_record" ON "public"."sync_conflicts" USING "btree" ("table_name", "record_id", "created_at" DESC);



CREATE INDEX "idx_sync_conflicts_tid" ON "public"."sync_conflicts" USING "btree" ("tenant_id");



CREATE INDEX "idx_sync_idempotency_keys_created_at" ON "public"."sync_idempotency_keys" USING "btree" ("created_at" DESC);



CREATE INDEX "idx_sync_idempotency_keys_tid" ON "public"."sync_idempotency_keys" USING "btree" ("tenant_id");



CREATE INDEX "idx_telemed_providers_free_available" ON "public"."telemedicine_providers" USING "btree" ("is_available", "verification_status") WHERE ("hospital_id" IS NULL);



CREATE INDEX "idx_telemedicine_appointments_hospital_schedule" ON "public"."telemedicine_appointments" USING "btree" ("hospital_id", "status", "scheduled_for" DESC);



CREATE INDEX "idx_telemedicine_appointments_tid" ON "public"."telemedicine_appointments" USING "btree" ("tenant_id");



CREATE INDEX "idx_telemedicine_followups_case" ON "public"."telemedicine_followups" USING "btree" ("case_id", "created_at" DESC);



CREATE UNIQUE INDEX "idx_telemedicine_followups_case_unique" ON "public"."telemedicine_followups" USING "btree" ("case_id");



CREATE INDEX "idx_telemedicine_followups_due" ON "public"."telemedicine_followups" USING "btree" ("status", "due_at");



CREATE INDEX "idx_telemedicine_followups_tid" ON "public"."telemedicine_followups" USING "btree" ("tenant_id");



CREATE INDEX "idx_telemedicine_frontdesk_queue_hospital" ON "public"."telemedicine_frontdesk_queue" USING "btree" ("hospital_id", "created_at" DESC);



CREATE INDEX "idx_telemedicine_frontdesk_queue_status" ON "public"."telemedicine_frontdesk_queue" USING "btree" ("status", "created_at" DESC);



CREATE INDEX "idx_telemedicine_frontdesk_queue_tid" ON "public"."telemedicine_frontdesk_queue" USING "btree" ("tenant_id");



CREATE INDEX "idx_telemedicine_intake_cases_status" ON "public"."telemedicine_intake_cases" USING "btree" ("status", "created_at" DESC);



CREATE INDEX "idx_telemedicine_intake_cases_tid" ON "public"."telemedicine_intake_cases" USING "btree" ("tenant_id");



CREATE INDEX "idx_telemedicine_intake_cases_user" ON "public"."telemedicine_intake_cases" USING "btree" ("user_id", "created_at" DESC);



CREATE INDEX "idx_telemedicine_intake_messages_case" ON "public"."telemedicine_intake_messages" USING "btree" ("case_id", "created_at");



CREATE INDEX "idx_telemedicine_intake_messages_tid" ON "public"."telemedicine_intake_messages" USING "btree" ("tenant_id");



CREATE UNIQUE INDEX "idx_telemedicine_provider_license_unique" ON "public"."telemedicine_providers" USING "btree" ("lower"(COALESCE("council", ''::"text")), "lower"(COALESCE("license_number", ''::"text"))) WHERE ("license_number" IS NOT NULL);



CREATE INDEX "idx_telemedicine_providers_hospital_status" ON "public"."telemedicine_providers" USING "btree" ("hospital_id", "verification_status", "is_active");



CREATE INDEX "idx_telemedicine_providers_tid" ON "public"."telemedicine_providers" USING "btree" ("tenant_id");



CREATE INDEX "idx_telemedicine_session_events_appointment" ON "public"."telemedicine_session_events" USING "btree" ("appointment_id", "created_at");



CREATE INDEX "idx_telemedicine_session_events_tid" ON "public"."telemedicine_session_events" USING "btree" ("tenant_id");



CREATE INDEX "idx_telemedicine_staff_alerts_case" ON "public"."telemedicine_staff_alerts" USING "btree" ("case_id", "created_at" DESC);



CREATE INDEX "idx_telemedicine_staff_alerts_hospital_status" ON "public"."telemedicine_staff_alerts" USING "btree" ("hospital_id", "status", "created_at" DESC);



CREATE INDEX "idx_telemedicine_staff_alerts_tid" ON "public"."telemedicine_staff_alerts" USING "btree" ("tenant_id");



CREATE INDEX "idx_telemedicine_voice_memos_case" ON "public"."telemedicine_voice_memos" USING "btree" ("case_id", "created_at" DESC);



CREATE INDEX "idx_telemedicine_voice_memos_tid" ON "public"."telemedicine_voice_memos" USING "btree" ("tenant_id");



CREATE INDEX "idx_tenant_domains_active" ON "public"."tenant_domains" USING "btree" ("is_active");



CREATE UNIQUE INDEX "idx_tenant_domains_domain_unique" ON "public"."tenant_domains" USING "btree" ("lower"("domain"));



CREATE INDEX "idx_tenant_domains_hospital_id" ON "public"."tenant_domains" USING "btree" ("hospital_id");



CREATE UNIQUE INDEX "idx_tenant_domains_primary_per_hospital" ON "public"."tenant_domains" USING "btree" ("hospital_id") WHERE ("is_primary" = true);



CREATE UNIQUE INDEX "idx_tenant_domains_tenant_key_unique" ON "public"."tenant_domains" USING "btree" ("lower"("tenant_key"));



CREATE INDEX "idx_tenant_domains_tid" ON "public"."tenant_domains" USING "btree" ("tenant_id");



CREATE UNIQUE INDEX "idx_tenant_logging_policies_global" ON "public"."tenant_logging_policies" USING "btree" ("module_name") WHERE ("hospital_id" IS NULL);



CREATE INDEX "idx_tenant_logging_policies_hospital" ON "public"."tenant_logging_policies" USING "btree" ("hospital_id", "module_name");



CREATE INDEX "idx_tenant_logging_policies_tid" ON "public"."tenant_logging_policies" USING "btree" ("tenant_id");



CREATE INDEX "idx_tenant_provisioning_jobs_hospital" ON "public"."tenant_provisioning_jobs" USING "btree" ("hospital_id", "created_at" DESC);



CREATE UNIQUE INDEX "idx_tenant_provisioning_jobs_one_active" ON "public"."tenant_provisioning_jobs" USING "btree" ("tenant_domain_id") WHERE ("status" = ANY (ARRAY['pending'::"text", 'running'::"text"]));



CREATE INDEX "idx_tenant_provisioning_jobs_status_next" ON "public"."tenant_provisioning_jobs" USING "btree" ("status", "next_attempt_at");



CREATE INDEX "idx_tenant_provisioning_jobs_tid" ON "public"."tenant_provisioning_jobs" USING "btree" ("tenant_id");



CREATE INDEX "idx_timeline_hospital_type" ON "public"."patient_timeline_events" USING "btree" ("hospital_id", "event_type", "event_date" DESC);



CREATE INDEX "idx_timeline_patient_date" ON "public"."patient_timeline_events" USING "btree" ("patient_id", "event_date" DESC);



CREATE INDEX "idx_timeline_source" ON "public"."patient_timeline_events" USING "btree" ("source_table", "source_id");



CREATE INDEX "idx_ucg_guidelines_tid" ON "public"."ucg_guidelines" USING "btree" ("tenant_id");



CREATE INDEX "idx_verification_documents_tid" ON "public"."verification_documents" USING "btree" ("tenant_id");



CREATE INDEX "idx_visitor_log_tenant" ON "public"."visitor_log" USING "btree" ("tenant_id");



CREATE INDEX "idx_visitor_log_time_in" ON "public"."visitor_log" USING "btree" ("time_in");



CREATE INDEX "idx_vitals_encounter_id" ON "public"."vitals" USING "btree" ("encounter_id");



CREATE INDEX "idx_vitals_recorded_at" ON "public"."vitals" USING "btree" ("recorded_at" DESC);



CREATE INDEX "idx_vitals_tenant_id" ON "public"."vitals" USING "btree" ("tenant_id");



CREATE INDEX "idx_wards_hospital_id" ON "public"."wards" USING "btree" ("hospital_id");



CREATE INDEX "insurance_benefits_policy_idx" ON "public"."insurance_benefits" USING "btree" ("policy_id");



CREATE INDEX "insurance_benefits_tenant_idx" ON "public"."insurance_benefits" USING "btree" ("tenant_id");



CREATE INDEX "insurance_copilot_audit_actor_idx" ON "public"."insurance_copilot_audit" USING "btree" ("actor_id");



CREATE INDEX "insurance_copilot_audit_tenant_idx" ON "public"."insurance_copilot_audit" USING "btree" ("tenant_id");



CREATE INDEX "insurance_coverage_checks_encounter_idx" ON "public"."insurance_coverage_checks" USING "btree" ("encounter_id");



CREATE INDEX "insurance_coverage_checks_patient_idx" ON "public"."insurance_coverage_checks" USING "btree" ("patient_id");



CREATE INDEX "insurance_coverage_checks_tenant_idx" ON "public"."insurance_coverage_checks" USING "btree" ("tenant_id");



CREATE UNIQUE INDEX "insurance_memberships_payer_member_uidx" ON "public"."insurance_memberships" USING "btree" (COALESCE("payer_id", '00000000-0000-0000-0000-000000000000'::"uuid"), "lower"("member_number")) WHERE ("status" = 'active'::"text");



CREATE INDEX "insurance_memberships_person_idx" ON "public"."insurance_memberships" USING "btree" ("person_id");



CREATE INDEX "insurance_policies_patient_idx" ON "public"."insurance_policies" USING "btree" ("patient_id");



CREATE INDEX "insurance_policies_policy_num_idx" ON "public"."insurance_policies" USING "btree" ("policy_number");



CREATE INDEX "insurance_policies_tenant_idx" ON "public"."insurance_policies" USING "btree" ("tenant_id");



CREATE INDEX "insurance_preauths_encounter_idx" ON "public"."insurance_preauthorizations" USING "btree" ("encounter_id");



CREATE INDEX "insurance_preauths_patient_idx" ON "public"."insurance_preauthorizations" USING "btree" ("patient_id");



CREATE INDEX "insurance_preauths_status_idx" ON "public"."insurance_preauthorizations" USING "btree" ("status");



CREATE INDEX "insurance_preauths_tenant_idx" ON "public"."insurance_preauthorizations" USING "btree" ("tenant_id");



CREATE INDEX "interop_connections_tenant_idx" ON "public"."interop_connections" USING "btree" ("tenant_id");



CREATE UNIQUE INDEX "interop_messages_idempotency_uidx" ON "public"."interop_messages" USING "btree" ("tenant_id", "idempotency_key") WHERE ("idempotency_key" IS NOT NULL);



CREATE INDEX "interop_messages_tenant_created_idx" ON "public"."interop_messages" USING "btree" ("tenant_id", "created_at" DESC);



CREATE UNIQUE INDEX "lab_orders_one_open_replacement_uidx" ON "public"."lab_orders" USING "btree" ("tenant_id", "replaces_lab_order_id") WHERE (("replaces_lab_order_id" IS NOT NULL) AND (COALESCE("workflow_status", ''::"text") <> ALL (ARRAY['CANCELLED'::"text", 'REJECTED'::"text", 'RELEASED'::"text", 'AMENDED'::"text"])));



COMMENT ON INDEX "public"."lab_orders_one_open_replacement_uidx" IS 'Prevents concurrent duplicate recollection orders against the same rejected parent while a replacement is still open.';



CREATE UNIQUE INDEX "lab_reference_ranges_natural_key" ON "public"."lab_reference_ranges" USING "btree" ("loinc_code", COALESCE("sex", ''::"text"), COALESCE("age_min_years", ('-1'::integer)::numeric), COALESCE("age_max_years", ('-1'::integer)::numeric), "country_pack");



CREATE INDEX "lab_specimens_barcode_idx" ON "public"."lab_specimens" USING "btree" ("barcode");



CREATE UNIQUE INDEX "lab_specimens_tenant_accession_uidx" ON "public"."lab_specimens" USING "btree" ("tenant_id", "accession_number");



CREATE INDEX "mfa_step_up_replays_session_idx" ON "public"."mfa_step_up_replays" USING "btree" ("session_id");



CREATE INDEX "mobile_push_tokens_tenant_id_idx" ON "public"."mobile_push_tokens" USING "btree" ("tenant_id");



CREATE INDEX "mobile_push_tokens_user_id_idx" ON "public"."mobile_push_tokens" USING "btree" ("user_id");



CREATE INDEX "offline_mutation_outbox_status_idx" ON "public"."offline_mutation_outbox" USING "btree" ("tenant_id", "status", "created_at");



CREATE INDEX "organizations_org_type_idx" ON "public"."organizations" USING "btree" ("org_type");



CREATE INDEX "password_reset_tokens_unused_expiry_idx" ON "public"."password_reset_tokens" USING "btree" ("expires_at") WHERE ("used_at" IS NULL);



CREATE INDEX "password_reset_tokens_user_idx" ON "public"."password_reset_tokens" USING "btree" ("user_id");



CREATE INDEX "patient_clinical_patterns_patient_idx" ON "public"."patient_clinical_patterns" USING "btree" ("patient_id");



CREATE INDEX "patient_clinical_patterns_tenant_idx" ON "public"."patient_clinical_patterns" USING "btree" ("tenant_id");



CREATE INDEX "patient_clinical_patterns_type_idx" ON "public"."patient_clinical_patterns" USING "btree" ("pattern_type");



CREATE INDEX "patient_intervention_outcomes_patient_idx" ON "public"."patient_intervention_outcomes" USING "btree" ("patient_id");



CREATE INDEX "patient_intervention_outcomes_tenant_idx" ON "public"."patient_intervention_outcomes" USING "btree" ("tenant_id");



CREATE INDEX "patient_timeline_events_person_idx" ON "public"."patient_timeline_events" USING "btree" ("person_id", "event_date" DESC);



CREATE INDEX "patients_person_id_idx" ON "public"."patients" USING "btree" ("person_id");



CREATE INDEX "person_clinical_facts_person_type_idx" ON "public"."person_clinical_facts" USING "btree" ("person_id", "fact_type") WHERE ("verification_status" <> 'SUPERSEDED'::"text");



CREATE INDEX "person_consents_person_purpose_idx" ON "public"."person_consents" USING "btree" ("person_id", "purpose", "status");



CREATE INDEX "person_contacts_person_idx" ON "public"."person_contacts" USING "btree" ("person_id");



CREATE UNIQUE INDEX "person_identifiers_issuer_namespace_uidx" ON "public"."person_identifiers" USING "btree" (COALESCE("issuing_organization_id", '00000000-0000-0000-0000-000000000000'::"uuid"), COALESCE("issuing_facility_id", '00000000-0000-0000-0000-000000000000'::"uuid"), "identifier_type", "lower"("identifier_value")) WHERE ("status" = 'active'::"text");



CREATE INDEX "person_identifiers_person_idx" ON "public"."person_identifiers" USING "btree" ("person_id");



CREATE INDEX "person_identifiers_value_idx" ON "public"."person_identifiers" USING "btree" ("lower"("identifier_value"));



CREATE UNIQUE INDEX "person_relationships_pair_uidx" ON "public"."person_relationships" USING "btree" ("person_id", "related_person_id", "relationship_type") WHERE ("status" = 'active'::"text");



CREATE INDEX "persons_dob_idx" ON "public"."persons" USING "btree" ("date_of_birth");



CREATE INDEX "persons_full_name_trgm_idx" ON "public"."persons" USING "gin" ("full_name" "public"."gin_trgm_ops");



CREATE INDEX "persons_merged_idx" ON "public"."persons" USING "btree" ("merged_into_person_id") WHERE ("merged_into_person_id" IS NOT NULL);



CREATE INDEX "pharmacy_cart_items_cart_idx" ON "public"."pharmacy_cart_items" USING "btree" ("cart_id");



CREATE INDEX "pharmacy_cart_items_tenant_idx" ON "public"."pharmacy_cart_items" USING "btree" ("tenant_id");



CREATE INDEX "pharmacy_carts_cashier_idx" ON "public"."pharmacy_carts" USING "btree" ("cashier_id");



CREATE INDEX "pharmacy_carts_tenant_idx" ON "public"."pharmacy_carts" USING "btree" ("tenant_id");



CREATE INDEX "pharmacy_cashier_sessions_cashier_idx" ON "public"."pharmacy_cashier_sessions" USING "btree" ("cashier_id");



CREATE UNIQUE INDEX "pharmacy_cashier_sessions_one_open_cashier" ON "public"."pharmacy_cashier_sessions" USING "btree" ("tenant_id", "cashier_id") WHERE ("status" = ANY (ARRAY['open'::"text", 'active'::"text", 'closing'::"text"]));



CREATE INDEX "pharmacy_cashier_sessions_status_idx" ON "public"."pharmacy_cashier_sessions" USING "btree" ("status");



CREATE INDEX "pharmacy_cashier_sessions_tenant_idx" ON "public"."pharmacy_cashier_sessions" USING "btree" ("tenant_id");



CREATE UNIQUE INDEX "pharmacy_custom_domains_domain_key" ON "public"."pharmacy_custom_domains" USING "btree" ("lower"("domain"));



CREATE UNIQUE INDEX "pharmacy_custom_domains_one_primary" ON "public"."pharmacy_custom_domains" USING "btree" ("tenant_id") WHERE "is_primary";



CREATE INDEX "pharmacy_custom_domains_tenant_idx" ON "public"."pharmacy_custom_domains" USING "btree" ("tenant_id");



CREATE INDEX "pharmacy_customers_person_id_idx" ON "public"."pharmacy_customers" USING "btree" ("person_id");



CREATE INDEX "pharmacy_pos_sale_items_sale_idx" ON "public"."pharmacy_pos_sale_items" USING "btree" ("sale_id");



CREATE INDEX "pharmacy_pos_sale_items_tenant_idx" ON "public"."pharmacy_pos_sale_items" USING "btree" ("tenant_id");



CREATE INDEX "pharmacy_pos_sales_cashier_idx" ON "public"."pharmacy_pos_sales" USING "btree" ("cashier_id");



CREATE INDEX "pharmacy_pos_sales_created_idx" ON "public"."pharmacy_pos_sales" USING "btree" ("created_at" DESC);



CREATE INDEX "pharmacy_pos_sales_session_idx" ON "public"."pharmacy_pos_sales" USING "btree" ("session_id");



CREATE INDEX "pharmacy_pos_sales_tenant_idx" ON "public"."pharmacy_pos_sales" USING "btree" ("tenant_id");



CREATE UNIQUE INDEX "pharmacy_pos_sales_tenant_receipt_number_uidx" ON "public"."pharmacy_pos_sales" USING "btree" ("tenant_id", "receipt_number");



COMMENT ON INDEX "public"."pharmacy_pos_sales_tenant_receipt_number_uidx" IS 'Receipt numbers are unique within a pharmacy tenant; independent tenants may reuse the same sequence value.';



CREATE INDEX "pharmacy_product_batches_store_idx" ON "public"."pharmacy_product_batches" USING "btree" ("store_id");



CREATE INDEX "pharmacy_refunds_sale_idx" ON "public"."pharmacy_refunds" USING "btree" ("sale_id");



CREATE INDEX "pharmacy_refunds_tenant_idx" ON "public"."pharmacy_refunds" USING "btree" ("tenant_id");



CREATE INDEX "pharmacy_sale_idempotency_tenant_created_idx" ON "public"."pharmacy_sale_idempotency" USING "btree" ("tenant_id", "created_at" DESC);



CREATE INDEX "pharmacy_stock_transfer_item_allocations_item_idx" ON "public"."pharmacy_stock_transfer_item_allocations" USING "btree" ("transfer_item_id");



CREATE INDEX "pharmacy_stock_transfers_tenant_idx" ON "public"."pharmacy_stock_transfers" USING "btree" ("tenant_id", "created_at" DESC);



CREATE INDEX "plan_features_key_idx" ON "public"."plan_features" USING "btree" ("feature_key");



CREATE INDEX "plan_features_plan_id_idx" ON "public"."plan_features" USING "btree" ("plan_id");



CREATE INDEX "platform_audit_events_resource_idx" ON "public"."platform_audit_events" USING "btree" ("resource_type", "resource_id", "created_at" DESC);



CREATE INDEX "platform_audit_events_tenant_idx" ON "public"."platform_audit_events" USING "btree" ("tenant_id", "created_at" DESC);



CREATE INDEX "platform_invitations_email_status_idx" ON "public"."platform_invitations" USING "btree" ("lower"("email"), "status");



CREATE INDEX "platform_invitations_pending_idx" ON "public"."platform_invitations" USING "btree" ("expires_at") WHERE ("status" = 'PENDING'::"text");



CREATE UNIQUE INDEX "platform_invitations_token_hash_uidx" ON "public"."platform_invitations" USING "btree" ("token_hash");



CREATE INDEX "platform_memberships_expires_idx" ON "public"."platform_memberships" USING "btree" ("expires_at") WHERE (("expires_at" IS NOT NULL) AND ("status" = 'ACTIVE'::"text"));



CREATE INDEX "platform_memberships_status_idx" ON "public"."platform_memberships" USING "btree" ("status", "platform_role");



CREATE UNIQUE INDEX "platform_memberships_user_active_uidx" ON "public"."platform_memberships" USING "btree" ("user_id") WHERE ("status" = ANY (ARRAY['INVITED'::"text", 'ACTIVE'::"text", 'SUSPENDED'::"text"]));



CREATE INDEX "profiles_email_verified_at_idx" ON "public"."profiles" USING "btree" ("email_verified_at") WHERE ("email" IS NOT NULL);



CREATE INDEX "ra_session_idx" ON "public"."reasoning_audit" USING "btree" ("session_id", "created_at");



CREATE INDEX "re_session_idx" ON "public"."reasoning_evidence" USING "btree" ("session_id");



CREATE INDEX "reasoning_context_snapshots_patient_idx" ON "public"."reasoning_context_snapshots" USING "btree" ("patient_id");



CREATE INDEX "reasoning_context_snapshots_session_idx" ON "public"."reasoning_context_snapshots" USING "btree" ("session_id");



CREATE INDEX "reasoning_context_snapshots_tenant_idx" ON "public"."reasoning_context_snapshots" USING "btree" ("tenant_id");



CREATE INDEX "rh_session_idx" ON "public"."reasoning_hypotheses" USING "btree" ("session_id");



CREATE INDEX "role_capabilities_cap_idx" ON "public"."role_capabilities" USING "btree" ("capability_id");



CREATE INDEX "role_capabilities_role_idx" ON "public"."role_capabilities" USING "btree" ("role");



CREATE INDEX "rs_encounter_idx" ON "public"."reasoning_sessions" USING "btree" ("encounter_id");



CREATE INDEX "rs_tenant_idx" ON "public"."reasoning_sessions" USING "btree" ("tenant_id");



CREATE INDEX "staff_scope_assignments_profile_idx" ON "public"."staff_scope_assignments" USING "btree" ("profile_id") WHERE "is_active";



CREATE UNIQUE INDEX "staff_scope_assignments_unique_idx" ON "public"."staff_scope_assignments" USING "btree" ("profile_id", "role", COALESCE("organization_id", '00000000-0000-0000-0000-000000000000'::"uuid"), COALESCE("tenant_id", '00000000-0000-0000-0000-000000000000'::"uuid"), COALESCE("site_id", '00000000-0000-0000-0000-000000000000'::"uuid"), COALESCE("department_id", '00000000-0000-0000-0000-000000000000'::"uuid")) WHERE "is_active";



CREATE INDEX "subscription_grants_active_idx" ON "public"."subscription_grants" USING "btree" ("status", "starts_at", "ends_at");



CREATE UNIQUE INDEX "subscription_grants_idempotency_idx" ON "public"."subscription_grants" USING "btree" ("idempotency_key") WHERE ("idempotency_key" IS NOT NULL);



CREATE INDEX "subscription_grants_subject_idx" ON "public"."subscription_grants" USING "btree" ("subject_type", "subject_id", "starts_at", "ends_at");



CREATE INDEX "subscription_grants_tenant_idx" ON "public"."subscription_grants" USING "btree" ("tenant_id", "status", "ends_at");



CREATE INDEX "synapse_domain_events_correlation_idx" ON "public"."synapse_domain_events" USING "btree" ("correlation_id", "occurred_at");



CREATE INDEX "synapse_domain_events_sim_idx" ON "public"."synapse_domain_events" USING "btree" ("simulation_run_id") WHERE ("simulation_run_id" IS NOT NULL);



CREATE INDEX "synapse_domain_events_tenant_type_idx" ON "public"."synapse_domain_events" USING "btree" ("tenant_id", "event_type", "occurred_at" DESC);



CREATE INDEX "synapse_simulation_runs_tenant_idx" ON "public"."synapse_simulation_runs" USING "btree" ("tenant_id", "created_at" DESC);



CREATE INDEX "tenant_feat_overrides_tenant_idx" ON "public"."tenant_feature_overrides" USING "btree" ("tenant_id");



CREATE INDEX "tenant_subs_plan_id_idx" ON "public"."tenant_subscriptions" USING "btree" ("plan_id");



CREATE INDEX "tenant_subs_tenant_id_idx" ON "public"."tenant_subscriptions" USING "btree" ("tenant_id");



CREATE INDEX "tenants_organization_id_idx" ON "public"."tenants" USING "btree" ("organization_id");



CREATE INDEX "tenants_parent_tenant_id_idx" ON "public"."tenants" USING "btree" ("parent_tenant_id");



CREATE INDEX "ucg_guidelines_category_idx" ON "public"."ucg_guidelines" USING "btree" ("category");



CREATE INDEX "ucg_guidelines_embedding_idx" ON "public"."ucg_guidelines" USING "ivfflat" ("embedding" "public"."vector_cosine_ops") WITH ("lists"='50');



CREATE INDEX "ucg_guidelines_icd11_idx" ON "public"."ucg_guidelines" USING "gin" ("icd11_codes");



CREATE OR REPLACE TRIGGER "persons_assign_synapse_id" BEFORE INSERT OR UPDATE ON "public"."persons" FOR EACH ROW EXECUTE FUNCTION "public"."persons_assign_synapse_id"();



CREATE OR REPLACE TRIGGER "professional_leads_updated_at" BEFORE UPDATE ON "public"."professional_leads" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();



CREATE OR REPLACE TRIGGER "set_pharmacy_clients_updated_at" BEFORE UPDATE ON "public"."pharmacy_clients" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at_column"();



CREATE OR REPLACE TRIGGER "set_pharmacy_customers_updated_at" BEFORE UPDATE ON "public"."pharmacy_customers" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at_column"();



CREATE OR REPLACE TRIGGER "set_pharmacy_inquiries_updated_at" BEFORE UPDATE ON "public"."pharmacy_inquiries" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at_column"();



CREATE OR REPLACE TRIGGER "set_pharmacy_orders_updated_at" BEFORE UPDATE ON "public"."pharmacy_orders" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at_column"();



CREATE OR REPLACE TRIGGER "set_pharmacy_product_batches_updated_at" BEFORE UPDATE ON "public"."pharmacy_product_batches" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at_column"();



CREATE OR REPLACE TRIGGER "set_pharmacy_product_packages_updated_at" BEFORE UPDATE ON "public"."pharmacy_product_packages" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at_column"();



CREATE OR REPLACE TRIGGER "set_pharmacy_products_updated_at" BEFORE UPDATE ON "public"."pharmacy_products" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at_column"();



CREATE OR REPLACE TRIGGER "set_pharmacy_purchase_orders_updated_at" BEFORE UPDATE ON "public"."pharmacy_purchase_orders" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at_column"();



CREATE OR REPLACE TRIGGER "set_pharmacy_settings_updated_at" BEFORE UPDATE ON "public"."pharmacy_settings" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at_column"();



CREATE OR REPLACE TRIGGER "set_pharmacy_suppliers_updated_at" BEFORE UPDATE ON "public"."pharmacy_suppliers" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at_column"();



CREATE OR REPLACE TRIGGER "set_pharmacy_transactions_updated_at" BEFORE UPDATE ON "public"."pharmacy_transactions" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at_column"();



CREATE OR REPLACE TRIGGER "set_pharmacy_user_settings_updated_at" BEFORE UPDATE ON "public"."pharmacy_user_settings" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at_column"();



CREATE OR REPLACE TRIGGER "set_tenant_id_aefi_reports" BEFORE INSERT ON "public"."aefi_reports" FOR EACH ROW EXECUTE FUNCTION "public"."auto_set_tenant_id"();



CREATE OR REPLACE TRIGGER "set_tenant_id_allergens_catalog" BEFORE INSERT ON "public"."allergens_catalog" FOR EACH ROW EXECUTE FUNCTION "public"."auto_set_tenant_id"();



CREATE OR REPLACE TRIGGER "set_tenant_id_audit_log" BEFORE INSERT ON "public"."audit_log" FOR EACH ROW EXECUTE FUNCTION "public"."auto_set_tenant_id"();



CREATE OR REPLACE TRIGGER "set_tenant_id_bed_assignments" BEFORE INSERT ON "public"."bed_assignments" FOR EACH ROW EXECUTE FUNCTION "public"."auto_set_tenant_id"();



CREATE OR REPLACE TRIGGER "set_tenant_id_beta_access_requests" BEFORE INSERT ON "public"."beta_access_requests" FOR EACH ROW EXECUTE FUNCTION "public"."auto_set_tenant_id"();



CREATE OR REPLACE TRIGGER "set_tenant_id_billing_invoices" BEFORE INSERT ON "public"."billing_invoices" FOR EACH ROW EXECUTE FUNCTION "public"."auto_set_tenant_id"();



CREATE OR REPLACE TRIGGER "set_tenant_id_billing_line_items" BEFORE INSERT ON "public"."billing_line_items" FOR EACH ROW EXECUTE FUNCTION "public"."auto_set_tenant_id"();



CREATE OR REPLACE TRIGGER "set_tenant_id_care_team_handovers" BEFORE INSERT ON "public"."care_team_handovers" FOR EACH ROW EXECUTE FUNCTION "public"."auto_set_tenant_id"();



CREATE OR REPLACE TRIGGER "set_tenant_id_cds_alerts" BEFORE INSERT ON "public"."cds_alerts" FOR EACH ROW EXECUTE FUNCTION "public"."auto_set_tenant_id"();



CREATE OR REPLACE TRIGGER "set_tenant_id_cds_rules" BEFORE INSERT ON "public"."cds_rules" FOR EACH ROW EXECUTE FUNCTION "public"."auto_set_tenant_id"();



CREATE OR REPLACE TRIGGER "set_tenant_id_chw_visits" BEFORE INSERT ON "public"."chw_visits" FOR EACH ROW EXECUTE FUNCTION "public"."auto_set_tenant_id"();



CREATE OR REPLACE TRIGGER "set_tenant_id_claim_line_items" BEFORE INSERT ON "public"."claim_line_items" FOR EACH ROW EXECUTE FUNCTION "public"."auto_set_tenant_id"();



CREATE OR REPLACE TRIGGER "set_tenant_id_claim_resubmissions" BEFORE INSERT ON "public"."claim_resubmissions" FOR EACH ROW EXECUTE FUNCTION "public"."auto_set_tenant_id"();



CREATE OR REPLACE TRIGGER "set_tenant_id_clinical_pathway_templates" BEFORE INSERT ON "public"."clinical_pathway_templates" FOR EACH ROW EXECUTE FUNCTION "public"."auto_set_tenant_id"();



CREATE OR REPLACE TRIGGER "set_tenant_id_community_health_workers" BEFORE INSERT ON "public"."community_health_workers" FOR EACH ROW EXECUTE FUNCTION "public"."auto_set_tenant_id"();



CREATE OR REPLACE TRIGGER "set_tenant_id_consent_audit_log" BEFORE INSERT ON "public"."consent_audit_log" FOR EACH ROW EXECUTE FUNCTION "public"."auto_set_tenant_id"();



CREATE OR REPLACE TRIGGER "set_tenant_id_data_breach_incidents" BEFORE INSERT ON "public"."data_breach_incidents" FOR EACH ROW EXECUTE FUNCTION "public"."auto_set_tenant_id"();



CREATE OR REPLACE TRIGGER "set_tenant_id_data_export_jobs" BEFORE INSERT ON "public"."data_export_jobs" FOR EACH ROW EXECUTE FUNCTION "public"."auto_set_tenant_id"();



CREATE OR REPLACE TRIGGER "set_tenant_id_data_retention_policies" BEFORE INSERT ON "public"."data_retention_policies" FOR EACH ROW EXECUTE FUNCTION "public"."auto_set_tenant_id"();



CREATE OR REPLACE TRIGGER "set_tenant_id_death_registrations" BEFORE INSERT ON "public"."death_registrations" FOR EACH ROW EXECUTE FUNCTION "public"."auto_set_tenant_id"();



CREATE OR REPLACE TRIGGER "set_tenant_id_death_reports" BEFORE INSERT ON "public"."death_reports" FOR EACH ROW EXECUTE FUNCTION "public"."auto_set_tenant_id"();



CREATE OR REPLACE TRIGGER "set_tenant_id_deidentification_profiles" BEFORE INSERT ON "public"."deidentification_profiles" FOR EACH ROW EXECUTE FUNCTION "public"."auto_set_tenant_id"();



CREATE OR REPLACE TRIGGER "set_tenant_id_denial_analytics_daily" BEFORE INSERT ON "public"."denial_analytics_daily" FOR EACH ROW EXECUTE FUNCTION "public"."auto_set_tenant_id"();



CREATE OR REPLACE TRIGGER "set_tenant_id_departments" BEFORE INSERT ON "public"."departments" FOR EACH ROW EXECUTE FUNCTION "public"."auto_set_tenant_id"();



CREATE OR REPLACE TRIGGER "set_tenant_id_device_alerts" BEFORE INSERT ON "public"."device_alerts" FOR EACH ROW EXECUTE FUNCTION "public"."auto_set_tenant_id"();



CREATE OR REPLACE TRIGGER "set_tenant_id_device_readings" BEFORE INSERT ON "public"."device_readings" FOR EACH ROW EXECUTE FUNCTION "public"."auto_set_tenant_id"();



CREATE OR REPLACE TRIGGER "set_tenant_id_diagnoses" BEFORE INSERT ON "public"."diagnoses" FOR EACH ROW EXECUTE FUNCTION "public"."auto_set_tenant_id"();



CREATE OR REPLACE TRIGGER "set_tenant_id_drug_contraindications" BEFORE INSERT ON "public"."drug_contraindications" FOR EACH ROW EXECUTE FUNCTION "public"."auto_set_tenant_id"();



CREATE OR REPLACE TRIGGER "set_tenant_id_drug_dose_adjustments" BEFORE INSERT ON "public"."drug_dose_adjustments" FOR EACH ROW EXECUTE FUNCTION "public"."auto_set_tenant_id"();



CREATE OR REPLACE TRIGGER "set_tenant_id_drug_interactions" BEFORE INSERT ON "public"."drug_interactions" FOR EACH ROW EXECUTE FUNCTION "public"."auto_set_tenant_id"();



CREATE OR REPLACE TRIGGER "set_tenant_id_drug_interactions_catalog" BEFORE INSERT ON "public"."drug_interactions_catalog" FOR EACH ROW EXECUTE FUNCTION "public"."auto_set_tenant_id"();



CREATE OR REPLACE TRIGGER "set_tenant_id_encounter_diagnoses" BEFORE INSERT ON "public"."encounter_diagnoses" FOR EACH ROW EXECUTE FUNCTION "public"."auto_set_tenant_id"();



CREATE OR REPLACE TRIGGER "set_tenant_id_encounter_orders" BEFORE INSERT ON "public"."encounter_orders" FOR EACH ROW EXECUTE FUNCTION "public"."auto_set_tenant_id"();



CREATE OR REPLACE TRIGGER "set_tenant_id_encounters" BEFORE INSERT ON "public"."encounters" FOR EACH ROW EXECUTE FUNCTION "public"."auto_set_tenant_id"();



CREATE OR REPLACE TRIGGER "set_tenant_id_expert_rules" BEFORE INSERT ON "public"."expert_rules" FOR EACH ROW EXECUTE FUNCTION "public"."auto_set_tenant_id"();



CREATE OR REPLACE TRIGGER "set_tenant_id_gas_cylinders" BEFORE INSERT ON "public"."gas_cylinders" FOR EACH ROW EXECUTE FUNCTION "public"."auto_set_tenant_id"();



CREATE OR REPLACE TRIGGER "set_tenant_id_handover_patient_entries" BEFORE INSERT ON "public"."handover_patient_entries" FOR EACH ROW EXECUTE FUNCTION "public"."auto_set_tenant_id"();



CREATE OR REPLACE TRIGGER "set_tenant_id_handover_shift_tasks" BEFORE INSERT ON "public"."handover_shift_tasks" FOR EACH ROW EXECUTE FUNCTION "public"."auto_set_tenant_id"();



CREATE OR REPLACE TRIGGER "set_tenant_id_handover_signatures" BEFORE INSERT ON "public"."handover_signatures" FOR EACH ROW EXECUTE FUNCTION "public"."auto_set_tenant_id"();



CREATE OR REPLACE TRIGGER "set_tenant_id_hospital_beds" BEFORE INSERT ON "public"."hospital_beds" FOR EACH ROW EXECUTE FUNCTION "public"."auto_set_tenant_id"();



CREATE OR REPLACE TRIGGER "set_tenant_id_hospital_drug_orders" BEFORE INSERT ON "public"."hospital_drug_orders" FOR EACH ROW EXECUTE FUNCTION "public"."auto_set_tenant_id"();



CREATE OR REPLACE TRIGGER "set_tenant_id_hospital_settings" BEFORE INSERT ON "public"."hospital_settings" FOR EACH ROW EXECUTE FUNCTION "public"."auto_set_tenant_id"();



CREATE OR REPLACE TRIGGER "set_tenant_id_imaging_series" BEFORE INSERT ON "public"."imaging_series" FOR EACH ROW EXECUTE FUNCTION "public"."auto_set_tenant_id"();



CREATE OR REPLACE TRIGGER "set_tenant_id_imaging_studies" BEFORE INSERT ON "public"."imaging_studies" FOR EACH ROW EXECUTE FUNCTION "public"."auto_set_tenant_id"();



CREATE OR REPLACE TRIGGER "set_tenant_id_immunization_schedule" BEFORE INSERT ON "public"."immunization_schedule" FOR EACH ROW EXECUTE FUNCTION "public"."auto_set_tenant_id"();



CREATE OR REPLACE TRIGGER "set_tenant_id_import_batch_rows" BEFORE INSERT ON "public"."import_batch_rows" FOR EACH ROW EXECUTE FUNCTION "public"."auto_set_tenant_id"();



CREATE OR REPLACE TRIGGER "set_tenant_id_import_batches" BEFORE INSERT ON "public"."import_batches" FOR EACH ROW EXECUTE FUNCTION "public"."auto_set_tenant_id"();



CREATE OR REPLACE TRIGGER "set_tenant_id_import_column_mappings" BEFORE INSERT ON "public"."import_column_mappings" FOR EACH ROW EXECUTE FUNCTION "public"."auto_set_tenant_id"();



CREATE OR REPLACE TRIGGER "set_tenant_id_insurance_claims" BEFORE INSERT ON "public"."insurance_claims" FOR EACH ROW EXECUTE FUNCTION "public"."auto_set_tenant_id"();



CREATE OR REPLACE TRIGGER "set_tenant_id_inventory_items" BEFORE INSERT ON "public"."inventory_items" FOR EACH ROW EXECUTE FUNCTION "public"."auto_set_tenant_id"();



CREATE OR REPLACE TRIGGER "set_tenant_id_lab_results" BEFORE INSERT ON "public"."lab_results" FOR EACH ROW EXECUTE FUNCTION "public"."auto_set_tenant_id"();



CREATE OR REPLACE TRIGGER "set_tenant_id_loinc_reference" BEFORE INSERT ON "public"."loinc_reference" FOR EACH ROW EXECUTE FUNCTION "public"."auto_set_tenant_id"();



CREATE OR REPLACE TRIGGER "set_tenant_id_maternity_records" BEFORE INSERT ON "public"."maternity_records" FOR EACH ROW EXECUTE FUNCTION "public"."auto_set_tenant_id"();



CREATE OR REPLACE TRIGGER "set_tenant_id_medical_devices" BEFORE INSERT ON "public"."medical_devices" FOR EACH ROW EXECUTE FUNCTION "public"."auto_set_tenant_id"();



CREATE OR REPLACE TRIGGER "set_tenant_id_medication_safety_checks" BEFORE INSERT ON "public"."medication_safety_checks" FOR EACH ROW EXECUTE FUNCTION "public"."auto_set_tenant_id"();



CREATE OR REPLACE TRIGGER "set_tenant_id_nin_access_log" BEFORE INSERT ON "public"."nin_access_log" FOR EACH ROW EXECUTE FUNCTION "public"."auto_set_tenant_id"();



CREATE OR REPLACE TRIGGER "set_tenant_id_notifications" BEFORE INSERT ON "public"."notifications" FOR EACH ROW EXECUTE FUNCTION "public"."auto_set_tenant_id"();



CREATE OR REPLACE TRIGGER "set_tenant_id_order_items" BEFORE INSERT ON "public"."order_items" FOR EACH ROW EXECUTE FUNCTION "public"."auto_set_tenant_id"();



CREATE OR REPLACE TRIGGER "set_tenant_id_order_mappings" BEFORE INSERT ON "public"."order_mappings" FOR EACH ROW EXECUTE FUNCTION "public"."auto_set_tenant_id"();



CREATE OR REPLACE TRIGGER "set_tenant_id_orders" BEFORE INSERT ON "public"."orders" FOR EACH ROW EXECUTE FUNCTION "public"."auto_set_tenant_id"();



CREATE OR REPLACE TRIGGER "set_tenant_id_outreach_campaigns" BEFORE INSERT ON "public"."outreach_campaigns" FOR EACH ROW EXECUTE FUNCTION "public"."auto_set_tenant_id"();



CREATE OR REPLACE TRIGGER "set_tenant_id_pathway_alerts" BEFORE INSERT ON "public"."pathway_alerts" FOR EACH ROW EXECUTE FUNCTION "public"."auto_set_tenant_id"();



CREATE OR REPLACE TRIGGER "set_tenant_id_pathway_checklist_items" BEFORE INSERT ON "public"."pathway_checklist_items" FOR EACH ROW EXECUTE FUNCTION "public"."auto_set_tenant_id"();



CREATE OR REPLACE TRIGGER "set_tenant_id_patient_access_grants" BEFORE INSERT ON "public"."patient_access_grants" FOR EACH ROW EXECUTE FUNCTION "public"."auto_set_tenant_id"();



CREATE OR REPLACE TRIGGER "set_tenant_id_patient_allergies" BEFORE INSERT ON "public"."patient_allergies" FOR EACH ROW EXECUTE FUNCTION "public"."auto_set_tenant_id"();



CREATE OR REPLACE TRIGGER "set_tenant_id_patient_billing" BEFORE INSERT ON "public"."patient_billing" FOR EACH ROW EXECUTE FUNCTION "public"."auto_set_tenant_id"();



CREATE OR REPLACE TRIGGER "set_tenant_id_patient_consents" BEFORE INSERT ON "public"."patient_consents" FOR EACH ROW EXECUTE FUNCTION "public"."auto_set_tenant_id"();



CREATE OR REPLACE TRIGGER "set_tenant_id_patient_notes" BEFORE INSERT ON "public"."patient_notes" FOR EACH ROW EXECUTE FUNCTION "public"."auto_set_tenant_id"();



CREATE OR REPLACE TRIGGER "set_tenant_id_patient_pathways" BEFORE INSERT ON "public"."patient_pathways" FOR EACH ROW EXECUTE FUNCTION "public"."auto_set_tenant_id"();



CREATE OR REPLACE TRIGGER "set_tenant_id_patient_problem_list" BEFORE INSERT ON "public"."patient_problem_list" FOR EACH ROW EXECUTE FUNCTION "public"."auto_set_tenant_id"();



CREATE OR REPLACE TRIGGER "set_tenant_id_patient_safety_events" BEFORE INSERT ON "public"."patient_safety_events" FOR EACH ROW EXECUTE FUNCTION "public"."auto_set_tenant_id"();



CREATE OR REPLACE TRIGGER "set_tenant_id_patient_sms_reminders" BEFORE INSERT ON "public"."patient_sms_reminders" FOR EACH ROW EXECUTE FUNCTION "public"."auto_set_tenant_id"();



CREATE OR REPLACE TRIGGER "set_tenant_id_patient_timeline_events" BEFORE INSERT ON "public"."patient_timeline_events" FOR EACH ROW EXECUTE FUNCTION "public"."auto_set_tenant_id"();



CREATE OR REPLACE TRIGGER "set_tenant_id_patient_timeline_pins" BEFORE INSERT ON "public"."patient_timeline_pins" FOR EACH ROW EXECUTE FUNCTION "public"."auto_set_tenant_id"();



CREATE OR REPLACE TRIGGER "set_tenant_id_patients" BEFORE INSERT ON "public"."patients" FOR EACH ROW EXECUTE FUNCTION "public"."auto_set_tenant_id"();



CREATE OR REPLACE TRIGGER "set_tenant_id_payer_contracts" BEFORE INSERT ON "public"."payer_contracts" FOR EACH ROW EXECUTE FUNCTION "public"."auto_set_tenant_id"();



CREATE OR REPLACE TRIGGER "set_tenant_id_pediatric_growth_records" BEFORE INSERT ON "public"."pediatric_growth_records" FOR EACH ROW EXECUTE FUNCTION "public"."auto_set_tenant_id"();



CREATE OR REPLACE TRIGGER "set_tenant_id_pharmacy_stores" BEFORE INSERT ON "public"."pharmacy_stores" FOR EACH ROW EXECUTE FUNCTION "public"."auto_set_tenant_id"();



CREATE OR REPLACE TRIGGER "set_tenant_id_phi_access_log" BEFORE INSERT ON "public"."phi_access_log" FOR EACH ROW EXECUTE FUNCTION "public"."auto_set_tenant_id"();



CREATE OR REPLACE TRIGGER "set_tenant_id_products" BEFORE INSERT ON "public"."products" FOR EACH ROW EXECUTE FUNCTION "public"."auto_set_tenant_id"();



CREATE OR REPLACE TRIGGER "set_tenant_id_profiles" BEFORE INSERT ON "public"."profiles" FOR EACH ROW EXECUTE FUNCTION "public"."auto_set_tenant_id"();



CREATE OR REPLACE TRIGGER "set_tenant_id_provider_verification_checks" BEFORE INSERT ON "public"."provider_verification_checks" FOR EACH ROW EXECUTE FUNCTION "public"."auto_set_tenant_id"();



CREATE OR REPLACE TRIGGER "set_tenant_id_purchase_orders" BEFORE INSERT ON "public"."purchase_orders" FOR EACH ROW EXECUTE FUNCTION "public"."auto_set_tenant_id"();



CREATE OR REPLACE TRIGGER "set_tenant_id_radiology_report_templates" BEFORE INSERT ON "public"."radiology_report_templates" FOR EACH ROW EXECUTE FUNCTION "public"."auto_set_tenant_id"();



CREATE OR REPLACE TRIGGER "set_tenant_id_radiology_reports" BEFORE INSERT ON "public"."radiology_reports" FOR EACH ROW EXECUTE FUNCTION "public"."auto_set_tenant_id"();



CREATE OR REPLACE TRIGGER "set_tenant_id_referral_requests" BEFORE INSERT ON "public"."referral_requests" FOR EACH ROW EXECUTE FUNCTION "public"."auto_set_tenant_id"();



CREATE OR REPLACE TRIGGER "set_tenant_id_renal_adjustments_catalog" BEFORE INSERT ON "public"."renal_adjustments_catalog" FOR EACH ROW EXECUTE FUNCTION "public"."auto_set_tenant_id"();



CREATE OR REPLACE TRIGGER "set_tenant_id_restaurants" BEFORE INSERT ON "public"."restaurants" FOR EACH ROW EXECUTE FUNCTION "public"."auto_set_tenant_id"();



CREATE OR REPLACE TRIGGER "set_tenant_id_rule_executions" BEFORE INSERT ON "public"."rule_executions" FOR EACH ROW EXECUTE FUNCTION "public"."auto_set_tenant_id"();



CREATE OR REPLACE TRIGGER "set_tenant_id_scan_events" BEFORE INSERT ON "public"."scan_events" FOR EACH ROW EXECUTE FUNCTION "public"."auto_set_tenant_id"();



CREATE OR REPLACE TRIGGER "set_tenant_id_sentinel_alerts" BEFORE INSERT ON "public"."sentinel_alerts" FOR EACH ROW EXECUTE FUNCTION "public"."auto_set_tenant_id"();



CREATE OR REPLACE TRIGGER "set_tenant_id_service_catalog" BEFORE INSERT ON "public"."service_catalog" FOR EACH ROW EXECUTE FUNCTION "public"."auto_set_tenant_id"();



CREATE OR REPLACE TRIGGER "set_tenant_id_staff_attendance" BEFORE INSERT ON "public"."staff_attendance" FOR EACH ROW EXECUTE FUNCTION "public"."auto_set_tenant_id"();



CREATE OR REPLACE TRIGGER "set_tenant_id_staff_leave_requests" BEFORE INSERT ON "public"."staff_leave_requests" FOR EACH ROW EXECUTE FUNCTION "public"."auto_set_tenant_id"();



CREATE OR REPLACE TRIGGER "set_tenant_id_suppliers" BEFORE INSERT ON "public"."suppliers" FOR EACH ROW EXECUTE FUNCTION "public"."auto_set_tenant_id"();



CREATE OR REPLACE TRIGGER "set_tenant_id_surgery_schedules" BEFORE INSERT ON "public"."surgery_schedules" FOR EACH ROW EXECUTE FUNCTION "public"."auto_set_tenant_id"();



CREATE OR REPLACE TRIGGER "set_tenant_id_sync_conflicts" BEFORE INSERT ON "public"."sync_conflicts" FOR EACH ROW EXECUTE FUNCTION "public"."auto_set_tenant_id"();



CREATE OR REPLACE TRIGGER "set_tenant_id_sync_idempotency_keys" BEFORE INSERT ON "public"."sync_idempotency_keys" FOR EACH ROW EXECUTE FUNCTION "public"."auto_set_tenant_id"();



CREATE OR REPLACE TRIGGER "set_tenant_id_telemedicine_appointments" BEFORE INSERT ON "public"."telemedicine_appointments" FOR EACH ROW EXECUTE FUNCTION "public"."auto_set_tenant_id"();



CREATE OR REPLACE TRIGGER "set_tenant_id_telemedicine_followups" BEFORE INSERT ON "public"."telemedicine_followups" FOR EACH ROW EXECUTE FUNCTION "public"."auto_set_tenant_id"();



CREATE OR REPLACE TRIGGER "set_tenant_id_telemedicine_frontdesk_queue" BEFORE INSERT ON "public"."telemedicine_frontdesk_queue" FOR EACH ROW EXECUTE FUNCTION "public"."auto_set_tenant_id"();



CREATE OR REPLACE TRIGGER "set_tenant_id_telemedicine_intake_cases" BEFORE INSERT ON "public"."telemedicine_intake_cases" FOR EACH ROW EXECUTE FUNCTION "public"."auto_set_tenant_id"();



CREATE OR REPLACE TRIGGER "set_tenant_id_telemedicine_intake_messages" BEFORE INSERT ON "public"."telemedicine_intake_messages" FOR EACH ROW EXECUTE FUNCTION "public"."auto_set_tenant_id"();



CREATE OR REPLACE TRIGGER "set_tenant_id_telemedicine_providers" BEFORE INSERT ON "public"."telemedicine_providers" FOR EACH ROW EXECUTE FUNCTION "public"."auto_set_tenant_id"();



CREATE OR REPLACE TRIGGER "set_tenant_id_telemedicine_session_events" BEFORE INSERT ON "public"."telemedicine_session_events" FOR EACH ROW EXECUTE FUNCTION "public"."auto_set_tenant_id"();



CREATE OR REPLACE TRIGGER "set_tenant_id_telemedicine_staff_alerts" BEFORE INSERT ON "public"."telemedicine_staff_alerts" FOR EACH ROW EXECUTE FUNCTION "public"."auto_set_tenant_id"();



CREATE OR REPLACE TRIGGER "set_tenant_id_telemedicine_voice_memos" BEFORE INSERT ON "public"."telemedicine_voice_memos" FOR EACH ROW EXECUTE FUNCTION "public"."auto_set_tenant_id"();



CREATE OR REPLACE TRIGGER "set_tenant_id_tenant_domains" BEFORE INSERT ON "public"."tenant_domains" FOR EACH ROW EXECUTE FUNCTION "public"."auto_set_tenant_id"();



CREATE OR REPLACE TRIGGER "set_tenant_id_tenant_logging_policies" BEFORE INSERT ON "public"."tenant_logging_policies" FOR EACH ROW EXECUTE FUNCTION "public"."auto_set_tenant_id"();



CREATE OR REPLACE TRIGGER "set_tenant_id_tenant_provisioning_jobs" BEFORE INSERT ON "public"."tenant_provisioning_jobs" FOR EACH ROW EXECUTE FUNCTION "public"."auto_set_tenant_id"();



CREATE OR REPLACE TRIGGER "set_tenant_id_ucg_guidelines" BEFORE INSERT ON "public"."ucg_guidelines" FOR EACH ROW EXECUTE FUNCTION "public"."auto_set_tenant_id"();



CREATE OR REPLACE TRIGGER "set_tenant_id_verification_documents" BEFORE INSERT ON "public"."verification_documents" FOR EACH ROW EXECUTE FUNCTION "public"."auto_set_tenant_id"();



CREATE OR REPLACE TRIGGER "set_tenant_id_vitals" BEFORE INSERT ON "public"."vitals" FOR EACH ROW EXECUTE FUNCTION "public"."auto_set_tenant_id"();



CREATE OR REPLACE TRIGGER "trg_access_grants_updated_at" BEFORE UPDATE ON "public"."patient_access_grants" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();



CREATE OR REPLACE TRIGGER "trg_allergens_catalog_updated_at" BEFORE UPDATE ON "public"."allergens_catalog" FOR EACH ROW EXECUTE FUNCTION "public"."set_expert_rules_updated_at"();



CREATE OR REPLACE TRIGGER "trg_assign_synapse_id" BEFORE INSERT ON "public"."patient_profiles" FOR EACH ROW EXECUTE FUNCTION "public"."assign_synapse_id"();



CREATE OR REPLACE TRIGGER "trg_bed_status_change" BEFORE UPDATE ON "public"."hospital_beds" FOR EACH ROW EXECUTE FUNCTION "public"."set_bed_status_change_ts"();



CREATE OR REPLACE TRIGGER "trg_billing_invoices_updated_at" BEFORE UPDATE ON "public"."billing_invoices" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();



CREATE OR REPLACE TRIGGER "trg_campaigns_updated_at" BEFORE UPDATE ON "public"."outreach_campaigns" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();



CREATE OR REPLACE TRIGGER "trg_cds_rules_updated_at" BEFORE UPDATE ON "public"."cds_rules" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();



CREATE OR REPLACE TRIGGER "trg_chw_updated_at" BEFORE UPDATE ON "public"."community_health_workers" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();



CREATE OR REPLACE TRIGGER "trg_chw_visits_updated_at" BEFORE UPDATE ON "public"."chw_visits" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();



CREATE OR REPLACE TRIGGER "trg_consult_queue_updated_at" BEFORE UPDATE ON "public"."consult_queue" FOR EACH ROW EXECUTE FUNCTION "public"."_set_consult_queue_updated_at"();



CREATE OR REPLACE TRIGGER "trg_death_reg_updated_at" BEFORE UPDATE ON "public"."death_registrations" FOR EACH ROW EXECUTE FUNCTION "public"."set_death_reg_updated_at"();



CREATE OR REPLACE TRIGGER "trg_departments_updated_at" BEFORE UPDATE ON "public"."departments" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();



CREATE OR REPLACE TRIGGER "trg_diagnoses_updated_at" BEFORE UPDATE ON "public"."diagnoses" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();



CREATE OR REPLACE TRIGGER "trg_domain_event_consumers_updated_at" BEFORE UPDATE ON "public"."domain_event_consumers" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();



CREATE OR REPLACE TRIGGER "trg_domain_events_updated_at" BEFORE UPDATE ON "public"."domain_events" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();



CREATE OR REPLACE TRIGGER "trg_drug_interactions_catalog_updated_at" BEFORE UPDATE ON "public"."drug_interactions_catalog" FOR EACH ROW EXECUTE FUNCTION "public"."set_expert_rules_updated_at"();



CREATE OR REPLACE TRIGGER "trg_encounter_orders_version" BEFORE UPDATE ON "public"."encounter_orders" FOR EACH ROW EXECUTE FUNCTION "public"."bump_record_version"();



CREATE OR REPLACE TRIGGER "trg_encounters_version" BEFORE UPDATE ON "public"."encounters" FOR EACH ROW EXECUTE FUNCTION "public"."bump_record_version"();



CREATE OR REPLACE TRIGGER "trg_expert_rules_updated_at" BEFORE UPDATE ON "public"."expert_rules" FOR EACH ROW EXECUTE FUNCTION "public"."set_expert_rules_updated_at"();



CREATE OR REPLACE TRIGGER "trg_export_jobs_updated_at" BEFORE UPDATE ON "public"."data_export_jobs" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();



CREATE OR REPLACE TRIGGER "trg_guard_hospital_seed_reset" BEFORE UPDATE ON "public"."hospital_seed_registry" FOR EACH ROW EXECUTE FUNCTION "public"."guard_hospital_seed_reset"();



CREATE OR REPLACE TRIGGER "trg_guard_pos_sale_item_mutation" BEFORE DELETE OR UPDATE ON "public"."pharmacy_pos_sale_items" FOR EACH ROW EXECUTE FUNCTION "public"."guard_pos_sale_item_mutation"();



CREATE OR REPLACE TRIGGER "trg_guard_pos_sale_mutation" BEFORE DELETE OR UPDATE ON "public"."pharmacy_pos_sales" FOR EACH ROW EXECUTE FUNCTION "public"."guard_pos_sale_mutation"();



CREATE OR REPLACE TRIGGER "trg_guard_signed_encounter_update" BEFORE UPDATE ON "public"."encounters" FOR EACH ROW EXECUTE FUNCTION "public"."guard_signed_encounter_update"();



CREATE OR REPLACE TRIGGER "trg_handover_entries_updated_at" BEFORE UPDATE ON "public"."handover_patient_entries" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();



CREATE OR REPLACE TRIGGER "trg_handovers_updated_at" BEFORE UPDATE ON "public"."care_team_handovers" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();



CREATE OR REPLACE TRIGGER "trg_hospital_beds_updated_at" BEFORE UPDATE ON "public"."hospital_beds" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();



CREATE OR REPLACE TRIGGER "trg_hospital_drug_orders_updated_at" BEFORE UPDATE ON "public"."hospital_drug_orders" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();



CREATE OR REPLACE TRIGGER "trg_hospital_drug_orders_version" BEFORE UPDATE ON "public"."hospital_drug_orders" FOR EACH ROW EXECUTE FUNCTION "public"."bump_record_version"();



CREATE OR REPLACE TRIGGER "trg_hospital_settings_updated_at" BEFORE UPDATE ON "public"."hospital_settings" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();



CREATE OR REPLACE TRIGGER "trg_imaging_studies_updated_at" BEFORE UPDATE ON "public"."imaging_studies" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();



CREATE OR REPLACE TRIGGER "trg_immunization_schedule_updated_at" BEFORE UPDATE ON "public"."immunization_schedule" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();



CREATE OR REPLACE TRIGGER "trg_import_batch_rows_updated_at" BEFORE UPDATE ON "public"."import_batch_rows" FOR EACH ROW EXECUTE FUNCTION "public"."set_generic_updated_at"();



CREATE OR REPLACE TRIGGER "trg_import_batches_updated_at" BEFORE UPDATE ON "public"."import_batches" FOR EACH ROW EXECUTE FUNCTION "public"."set_generic_updated_at"();



CREATE OR REPLACE TRIGGER "trg_insurance_claims_updated_at" BEFORE UPDATE ON "public"."insurance_claims" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();



CREATE OR REPLACE TRIGGER "trg_inventory_items_updated_at" BEFORE UPDATE ON "public"."inventory_items" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();



CREATE OR REPLACE TRIGGER "trg_loinc_reference_updated_at" BEFORE UPDATE ON "public"."loinc_reference" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();



CREATE OR REPLACE TRIGGER "trg_maternity_records_updated_at" BEFORE UPDATE ON "public"."maternity_records" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();



CREATE OR REPLACE TRIGGER "trg_medical_devices_updated_at" BEFORE UPDATE ON "public"."medical_devices" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();



CREATE OR REPLACE TRIGGER "trg_pathway_templates_updated_at" BEFORE UPDATE ON "public"."clinical_pathway_templates" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();



CREATE OR REPLACE TRIGGER "trg_patient_allergies_updated_at" BEFORE UPDATE ON "public"."patient_allergies" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();



CREATE OR REPLACE TRIGGER "trg_patient_billing_updated_at" BEFORE UPDATE ON "public"."patient_billing" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();



CREATE OR REPLACE TRIGGER "trg_patient_consents_updated_at" BEFORE UPDATE ON "public"."patient_consents" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();



CREATE OR REPLACE TRIGGER "trg_patient_notes_updated_at" BEFORE UPDATE ON "public"."patient_notes" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();



CREATE OR REPLACE TRIGGER "trg_patient_pathways_updated_at" BEFORE UPDATE ON "public"."patient_pathways" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();



CREATE OR REPLACE TRIGGER "trg_payer_contracts_updated_at" BEFORE UPDATE ON "public"."payer_contracts" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();



CREATE OR REPLACE TRIGGER "trg_pharmacy_stores_updated_at" BEFORE UPDATE ON "public"."pharmacy_stores" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();



CREATE OR REPLACE TRIGGER "trg_platform_audit_no_update" BEFORE DELETE OR UPDATE ON "public"."platform_audit_events" FOR EACH ROW EXECUTE FUNCTION "public"."forbid_platform_audit_mutation"();



CREATE OR REPLACE TRIGGER "trg_pos_sale_item_before_insert" BEFORE INSERT ON "public"."pharmacy_pos_sale_items" FOR EACH ROW EXECUTE FUNCTION "public"."pos_sale_item_before_insert"();



CREATE OR REPLACE TRIGGER "trg_problem_list_updated_at" BEFORE UPDATE ON "public"."patient_problem_list" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();



CREATE OR REPLACE TRIGGER "trg_purchase_orders_updated_at" BEFORE UPDATE ON "public"."purchase_orders" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();



CREATE OR REPLACE TRIGGER "trg_radiology_reports_updated_at" BEFORE UPDATE ON "public"."radiology_reports" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();



CREATE OR REPLACE TRIGGER "trg_referral_updated_at" BEFORE UPDATE ON "public"."referral_requests" FOR EACH ROW EXECUTE FUNCTION "public"."set_referral_updated_at"();



CREATE OR REPLACE TRIGGER "trg_renal_adjustments_catalog_updated_at" BEFORE UPDATE ON "public"."renal_adjustments_catalog" FOR EACH ROW EXECUTE FUNCTION "public"."set_expert_rules_updated_at"();



CREATE OR REPLACE TRIGGER "trg_retention_updated_at" BEFORE UPDATE ON "public"."data_retention_policies" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();



CREATE OR REPLACE TRIGGER "trg_service_catalog_updated_at" BEFORE UPDATE ON "public"."service_catalog" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();



CREATE OR REPLACE TRIGGER "trg_shift_tasks_updated_at" BEFORE UPDATE ON "public"."handover_shift_tasks" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();



CREATE OR REPLACE TRIGGER "trg_surgery_schedules_updated_at" BEFORE UPDATE ON "public"."surgery_schedules" FOR EACH ROW EXECUTE FUNCTION "public"."set_updated_at"();



CREATE OR REPLACE TRIGGER "trg_sync_network_inventory" AFTER INSERT OR DELETE OR UPDATE OF "quantity", "is_active" ON "public"."pharmacy_products" FOR EACH ROW EXECUTE FUNCTION "public"."fn_sync_network_inventory"();



CREATE OR REPLACE TRIGGER "trg_telemedicine_appointments_updated_at" BEFORE UPDATE ON "public"."telemedicine_appointments" FOR EACH ROW EXECUTE FUNCTION "public"."set_generic_updated_at"();



CREATE OR REPLACE TRIGGER "trg_telemedicine_followups_updated_at" BEFORE UPDATE ON "public"."telemedicine_followups" FOR EACH ROW EXECUTE FUNCTION "public"."set_telemedicine_updated_at"();



CREATE OR REPLACE TRIGGER "trg_telemedicine_frontdesk_queue_updated_at" BEFORE UPDATE ON "public"."telemedicine_frontdesk_queue" FOR EACH ROW EXECUTE FUNCTION "public"."set_telemedicine_updated_at"();



CREATE OR REPLACE TRIGGER "trg_telemedicine_intake_cases_updated_at" BEFORE UPDATE ON "public"."telemedicine_intake_cases" FOR EACH ROW EXECUTE FUNCTION "public"."set_telemedicine_updated_at"();



CREATE OR REPLACE TRIGGER "trg_telemedicine_providers_updated_at" BEFORE UPDATE ON "public"."telemedicine_providers" FOR EACH ROW EXECUTE FUNCTION "public"."set_generic_updated_at"();



CREATE OR REPLACE TRIGGER "trg_telemedicine_staff_alerts_updated_at" BEFORE UPDATE ON "public"."telemedicine_staff_alerts" FOR EACH ROW EXECUTE FUNCTION "public"."set_telemedicine_updated_at"();



CREATE OR REPLACE TRIGGER "trg_tenant_domains_updated_at" BEFORE UPDATE ON "public"."tenant_domains" FOR EACH ROW EXECUTE FUNCTION "public"."set_tenant_domain_updated_at"();



CREATE OR REPLACE TRIGGER "trg_tenant_logging_policies_updated_at" BEFORE UPDATE ON "public"."tenant_logging_policies" FOR EACH ROW EXECUTE FUNCTION "public"."set_telemedicine_updated_at"();



CREATE OR REPLACE TRIGGER "trg_tenant_provisioning_jobs_updated_at" BEFORE UPDATE ON "public"."tenant_provisioning_jobs" FOR EACH ROW EXECUTE FUNCTION "public"."set_generic_updated_at"();



CREATE OR REPLACE TRIGGER "trg_vitals_version" BEFORE UPDATE ON "public"."vitals" FOR EACH ROW EXECUTE FUNCTION "public"."bump_record_version"();



CREATE OR REPLACE TRIGGER "update_aefi_reports_updated_at" BEFORE UPDATE ON "public"."aefi_reports" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at_column"();



CREATE OR REPLACE TRIGGER "update_allergens_catalog_updated_at" BEFORE UPDATE ON "public"."allergens_catalog" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at_column"();



CREATE OR REPLACE TRIGGER "update_audit_log_updated_at" BEFORE UPDATE ON "public"."audit_log" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at_column"();



CREATE OR REPLACE TRIGGER "update_bed_assignments_updated_at" BEFORE UPDATE ON "public"."bed_assignments" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at_column"();



CREATE OR REPLACE TRIGGER "update_beta_access_requests_updated_at" BEFORE UPDATE ON "public"."beta_access_requests" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at_column"();



CREATE OR REPLACE TRIGGER "update_billing_invoices_updated_at" BEFORE UPDATE ON "public"."billing_invoices" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at_column"();



CREATE OR REPLACE TRIGGER "update_billing_line_items_updated_at" BEFORE UPDATE ON "public"."billing_line_items" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at_column"();



CREATE OR REPLACE TRIGGER "update_care_team_handovers_updated_at" BEFORE UPDATE ON "public"."care_team_handovers" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at_column"();



CREATE OR REPLACE TRIGGER "update_cds_alerts_updated_at" BEFORE UPDATE ON "public"."cds_alerts" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at_column"();



CREATE OR REPLACE TRIGGER "update_cds_rules_updated_at" BEFORE UPDATE ON "public"."cds_rules" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at_column"();



CREATE OR REPLACE TRIGGER "update_chw_visits_updated_at" BEFORE UPDATE ON "public"."chw_visits" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at_column"();



CREATE OR REPLACE TRIGGER "update_claim_line_items_updated_at" BEFORE UPDATE ON "public"."claim_line_items" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at_column"();



CREATE OR REPLACE TRIGGER "update_claim_resubmissions_updated_at" BEFORE UPDATE ON "public"."claim_resubmissions" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at_column"();



CREATE OR REPLACE TRIGGER "update_clinical_pathway_templates_updated_at" BEFORE UPDATE ON "public"."clinical_pathway_templates" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at_column"();



CREATE OR REPLACE TRIGGER "update_community_health_workers_updated_at" BEFORE UPDATE ON "public"."community_health_workers" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at_column"();



CREATE OR REPLACE TRIGGER "update_consent_audit_log_updated_at" BEFORE UPDATE ON "public"."consent_audit_log" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at_column"();



CREATE OR REPLACE TRIGGER "update_data_breach_incidents_updated_at" BEFORE UPDATE ON "public"."data_breach_incidents" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at_column"();



CREATE OR REPLACE TRIGGER "update_data_export_jobs_updated_at" BEFORE UPDATE ON "public"."data_export_jobs" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at_column"();



CREATE OR REPLACE TRIGGER "update_data_retention_policies_updated_at" BEFORE UPDATE ON "public"."data_retention_policies" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at_column"();



CREATE OR REPLACE TRIGGER "update_death_registrations_updated_at" BEFORE UPDATE ON "public"."death_registrations" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at_column"();



CREATE OR REPLACE TRIGGER "update_death_reports_updated_at" BEFORE UPDATE ON "public"."death_reports" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at_column"();



CREATE OR REPLACE TRIGGER "update_deidentification_profiles_updated_at" BEFORE UPDATE ON "public"."deidentification_profiles" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at_column"();



CREATE OR REPLACE TRIGGER "update_denial_analytics_daily_updated_at" BEFORE UPDATE ON "public"."denial_analytics_daily" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at_column"();



CREATE OR REPLACE TRIGGER "update_departments_updated_at" BEFORE UPDATE ON "public"."departments" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at_column"();



CREATE OR REPLACE TRIGGER "update_device_alerts_updated_at" BEFORE UPDATE ON "public"."device_alerts" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at_column"();



CREATE OR REPLACE TRIGGER "update_device_readings_updated_at" BEFORE UPDATE ON "public"."device_readings" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at_column"();



CREATE OR REPLACE TRIGGER "update_diagnoses_updated_at" BEFORE UPDATE ON "public"."diagnoses" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at_column"();



CREATE OR REPLACE TRIGGER "update_drug_contraindications_updated_at" BEFORE UPDATE ON "public"."drug_contraindications" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at_column"();



CREATE OR REPLACE TRIGGER "update_drug_dose_adjustments_updated_at" BEFORE UPDATE ON "public"."drug_dose_adjustments" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at_column"();



CREATE OR REPLACE TRIGGER "update_drug_interactions_catalog_updated_at" BEFORE UPDATE ON "public"."drug_interactions_catalog" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at_column"();



CREATE OR REPLACE TRIGGER "update_drug_interactions_updated_at" BEFORE UPDATE ON "public"."drug_interactions" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at_column"();



CREATE OR REPLACE TRIGGER "update_encounter_diagnoses_updated_at" BEFORE UPDATE ON "public"."encounter_diagnoses" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at_column"();



CREATE OR REPLACE TRIGGER "update_encounter_orders_updated_at" BEFORE UPDATE ON "public"."encounter_orders" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at_column"();



CREATE OR REPLACE TRIGGER "update_encounters_updated_at" BEFORE UPDATE ON "public"."encounters" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at_column"();



CREATE OR REPLACE TRIGGER "update_expert_rules_updated_at" BEFORE UPDATE ON "public"."expert_rules" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at_column"();



CREATE OR REPLACE TRIGGER "update_gas_cylinders_updated_at" BEFORE UPDATE ON "public"."gas_cylinders" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at_column"();



CREATE OR REPLACE TRIGGER "update_handover_patient_entries_updated_at" BEFORE UPDATE ON "public"."handover_patient_entries" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at_column"();



CREATE OR REPLACE TRIGGER "update_handover_shift_tasks_updated_at" BEFORE UPDATE ON "public"."handover_shift_tasks" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at_column"();



CREATE OR REPLACE TRIGGER "update_handover_signatures_updated_at" BEFORE UPDATE ON "public"."handover_signatures" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at_column"();



CREATE OR REPLACE TRIGGER "update_hospital_beds_updated_at" BEFORE UPDATE ON "public"."hospital_beds" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at_column"();



CREATE OR REPLACE TRIGGER "update_hospital_drug_orders_updated_at" BEFORE UPDATE ON "public"."hospital_drug_orders" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at_column"();



CREATE OR REPLACE TRIGGER "update_hospital_settings_updated_at" BEFORE UPDATE ON "public"."hospital_settings" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at_column"();



CREATE OR REPLACE TRIGGER "update_hospitals_updated_at" BEFORE UPDATE ON "public"."hospitals" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at_column"();



CREATE OR REPLACE TRIGGER "update_imaging_series_updated_at" BEFORE UPDATE ON "public"."imaging_series" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at_column"();



CREATE OR REPLACE TRIGGER "update_imaging_studies_updated_at" BEFORE UPDATE ON "public"."imaging_studies" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at_column"();



CREATE OR REPLACE TRIGGER "update_immunization_schedule_updated_at" BEFORE UPDATE ON "public"."immunization_schedule" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at_column"();



CREATE OR REPLACE TRIGGER "update_import_batch_rows_updated_at" BEFORE UPDATE ON "public"."import_batch_rows" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at_column"();



CREATE OR REPLACE TRIGGER "update_import_batches_updated_at" BEFORE UPDATE ON "public"."import_batches" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at_column"();



CREATE OR REPLACE TRIGGER "update_import_column_mappings_updated_at" BEFORE UPDATE ON "public"."import_column_mappings" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at_column"();



CREATE OR REPLACE TRIGGER "update_insurance_claims_updated_at" BEFORE UPDATE ON "public"."insurance_claims" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at_column"();



CREATE OR REPLACE TRIGGER "update_inventory_items_updated_at" BEFORE UPDATE ON "public"."inventory_items" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at_column"();



CREATE OR REPLACE TRIGGER "update_lab_results_updated_at" BEFORE UPDATE ON "public"."lab_results" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at_column"();



CREATE OR REPLACE TRIGGER "update_loinc_reference_updated_at" BEFORE UPDATE ON "public"."loinc_reference" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at_column"();



CREATE OR REPLACE TRIGGER "update_maternity_records_updated_at" BEFORE UPDATE ON "public"."maternity_records" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at_column"();



CREATE OR REPLACE TRIGGER "update_medical_devices_updated_at" BEFORE UPDATE ON "public"."medical_devices" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at_column"();



CREATE OR REPLACE TRIGGER "update_medication_safety_checks_updated_at" BEFORE UPDATE ON "public"."medication_safety_checks" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at_column"();



CREATE OR REPLACE TRIGGER "update_nin_access_log_updated_at" BEFORE UPDATE ON "public"."nin_access_log" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at_column"();



CREATE OR REPLACE TRIGGER "update_notifications_updated_at" BEFORE UPDATE ON "public"."notifications" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at_column"();



CREATE OR REPLACE TRIGGER "update_order_items_updated_at" BEFORE UPDATE ON "public"."order_items" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at_column"();



CREATE OR REPLACE TRIGGER "update_order_mappings_updated_at" BEFORE UPDATE ON "public"."order_mappings" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at_column"();



CREATE OR REPLACE TRIGGER "update_orders_updated_at" BEFORE UPDATE ON "public"."orders" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at_column"();



CREATE OR REPLACE TRIGGER "update_outreach_campaigns_updated_at" BEFORE UPDATE ON "public"."outreach_campaigns" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at_column"();



CREATE OR REPLACE TRIGGER "update_pathway_alerts_updated_at" BEFORE UPDATE ON "public"."pathway_alerts" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at_column"();



CREATE OR REPLACE TRIGGER "update_pathway_checklist_items_updated_at" BEFORE UPDATE ON "public"."pathway_checklist_items" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at_column"();



CREATE OR REPLACE TRIGGER "update_patient_access_grants_updated_at" BEFORE UPDATE ON "public"."patient_access_grants" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at_column"();



CREATE OR REPLACE TRIGGER "update_patient_allergies_updated_at" BEFORE UPDATE ON "public"."patient_allergies" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at_column"();



CREATE OR REPLACE TRIGGER "update_patient_billing_updated_at" BEFORE UPDATE ON "public"."patient_billing" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at_column"();



CREATE OR REPLACE TRIGGER "update_patient_consents_updated_at" BEFORE UPDATE ON "public"."patient_consents" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at_column"();



CREATE OR REPLACE TRIGGER "update_patient_notes_updated_at" BEFORE UPDATE ON "public"."patient_notes" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at_column"();



CREATE OR REPLACE TRIGGER "update_patient_pathways_updated_at" BEFORE UPDATE ON "public"."patient_pathways" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at_column"();



CREATE OR REPLACE TRIGGER "update_patient_problem_list_updated_at" BEFORE UPDATE ON "public"."patient_problem_list" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at_column"();



CREATE OR REPLACE TRIGGER "update_patient_safety_events_updated_at" BEFORE UPDATE ON "public"."patient_safety_events" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at_column"();



CREATE OR REPLACE TRIGGER "update_patient_sms_reminders_updated_at" BEFORE UPDATE ON "public"."patient_sms_reminders" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at_column"();



CREATE OR REPLACE TRIGGER "update_patient_timeline_events_updated_at" BEFORE UPDATE ON "public"."patient_timeline_events" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at_column"();



CREATE OR REPLACE TRIGGER "update_patient_timeline_pins_updated_at" BEFORE UPDATE ON "public"."patient_timeline_pins" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at_column"();



CREATE OR REPLACE TRIGGER "update_patients_updated_at" BEFORE UPDATE ON "public"."patients" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at_column"();



CREATE OR REPLACE TRIGGER "update_payer_contracts_updated_at" BEFORE UPDATE ON "public"."payer_contracts" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at_column"();



CREATE OR REPLACE TRIGGER "update_pediatric_growth_records_updated_at" BEFORE UPDATE ON "public"."pediatric_growth_records" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at_column"();



CREATE OR REPLACE TRIGGER "update_pharmacy_stores_updated_at" BEFORE UPDATE ON "public"."pharmacy_stores" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at_column"();



CREATE OR REPLACE TRIGGER "update_phi_access_log_updated_at" BEFORE UPDATE ON "public"."phi_access_log" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at_column"();



CREATE OR REPLACE TRIGGER "update_products_updated_at" BEFORE UPDATE ON "public"."products" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at_column"();



CREATE OR REPLACE TRIGGER "update_profiles_updated_at" BEFORE UPDATE ON "public"."profiles" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at_column"();



CREATE OR REPLACE TRIGGER "update_provider_verification_checks_updated_at" BEFORE UPDATE ON "public"."provider_verification_checks" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at_column"();



CREATE OR REPLACE TRIGGER "update_purchase_orders_updated_at" BEFORE UPDATE ON "public"."purchase_orders" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at_column"();



CREATE OR REPLACE TRIGGER "update_radiology_report_templates_updated_at" BEFORE UPDATE ON "public"."radiology_report_templates" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at_column"();



CREATE OR REPLACE TRIGGER "update_radiology_reports_updated_at" BEFORE UPDATE ON "public"."radiology_reports" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at_column"();



CREATE OR REPLACE TRIGGER "update_referral_requests_updated_at" BEFORE UPDATE ON "public"."referral_requests" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at_column"();



CREATE OR REPLACE TRIGGER "update_renal_adjustments_catalog_updated_at" BEFORE UPDATE ON "public"."renal_adjustments_catalog" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at_column"();



CREATE OR REPLACE TRIGGER "update_restaurants_updated_at" BEFORE UPDATE ON "public"."restaurants" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at_column"();



CREATE OR REPLACE TRIGGER "update_rule_executions_updated_at" BEFORE UPDATE ON "public"."rule_executions" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at_column"();



CREATE OR REPLACE TRIGGER "update_scan_events_updated_at" BEFORE UPDATE ON "public"."scan_events" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at_column"();



CREATE OR REPLACE TRIGGER "update_sentinel_alerts_updated_at" BEFORE UPDATE ON "public"."sentinel_alerts" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at_column"();



CREATE OR REPLACE TRIGGER "update_service_catalog_updated_at" BEFORE UPDATE ON "public"."service_catalog" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at_column"();



CREATE OR REPLACE TRIGGER "update_staff_attendance_updated_at" BEFORE UPDATE ON "public"."staff_attendance" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at_column"();



CREATE OR REPLACE TRIGGER "update_staff_leave_requests_updated_at" BEFORE UPDATE ON "public"."staff_leave_requests" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at_column"();



CREATE OR REPLACE TRIGGER "update_suppliers_updated_at" BEFORE UPDATE ON "public"."suppliers" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at_column"();



CREATE OR REPLACE TRIGGER "update_surgery_schedules_updated_at" BEFORE UPDATE ON "public"."surgery_schedules" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at_column"();



CREATE OR REPLACE TRIGGER "update_sync_conflicts_updated_at" BEFORE UPDATE ON "public"."sync_conflicts" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at_column"();



CREATE OR REPLACE TRIGGER "update_sync_idempotency_keys_updated_at" BEFORE UPDATE ON "public"."sync_idempotency_keys" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at_column"();



CREATE OR REPLACE TRIGGER "update_telemedicine_appointments_updated_at" BEFORE UPDATE ON "public"."telemedicine_appointments" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at_column"();



CREATE OR REPLACE TRIGGER "update_telemedicine_followups_updated_at" BEFORE UPDATE ON "public"."telemedicine_followups" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at_column"();



CREATE OR REPLACE TRIGGER "update_telemedicine_frontdesk_queue_updated_at" BEFORE UPDATE ON "public"."telemedicine_frontdesk_queue" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at_column"();



CREATE OR REPLACE TRIGGER "update_telemedicine_intake_cases_updated_at" BEFORE UPDATE ON "public"."telemedicine_intake_cases" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at_column"();



CREATE OR REPLACE TRIGGER "update_telemedicine_intake_messages_updated_at" BEFORE UPDATE ON "public"."telemedicine_intake_messages" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at_column"();



CREATE OR REPLACE TRIGGER "update_telemedicine_providers_updated_at" BEFORE UPDATE ON "public"."telemedicine_providers" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at_column"();



CREATE OR REPLACE TRIGGER "update_telemedicine_session_events_updated_at" BEFORE UPDATE ON "public"."telemedicine_session_events" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at_column"();



CREATE OR REPLACE TRIGGER "update_telemedicine_staff_alerts_updated_at" BEFORE UPDATE ON "public"."telemedicine_staff_alerts" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at_column"();



CREATE OR REPLACE TRIGGER "update_telemedicine_voice_memos_updated_at" BEFORE UPDATE ON "public"."telemedicine_voice_memos" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at_column"();



CREATE OR REPLACE TRIGGER "update_tenant_domains_updated_at" BEFORE UPDATE ON "public"."tenant_domains" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at_column"();



CREATE OR REPLACE TRIGGER "update_tenant_logging_policies_updated_at" BEFORE UPDATE ON "public"."tenant_logging_policies" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at_column"();



CREATE OR REPLACE TRIGGER "update_tenant_provisioning_jobs_updated_at" BEFORE UPDATE ON "public"."tenant_provisioning_jobs" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at_column"();



CREATE OR REPLACE TRIGGER "update_tenants_updated_at" BEFORE UPDATE ON "public"."tenants" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at_column"();



CREATE OR REPLACE TRIGGER "update_ucg_guidelines_updated_at" BEFORE UPDATE ON "public"."ucg_guidelines" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at_column"();



CREATE OR REPLACE TRIGGER "update_verification_documents_updated_at" BEFORE UPDATE ON "public"."verification_documents" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at_column"();



CREATE OR REPLACE TRIGGER "update_vitals_updated_at" BEFORE UPDATE ON "public"."vitals" FOR EACH ROW EXECUTE FUNCTION "public"."update_updated_at_column"();



ALTER TABLE ONLY "public"."aefi_reports"
    ADD CONSTRAINT "aefi_reports_chw_id_fkey" FOREIGN KEY ("chw_id") REFERENCES "public"."community_health_workers"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."aefi_reports"
    ADD CONSTRAINT "aefi_reports_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."aefi_reports"
    ADD CONSTRAINT "aefi_reports_hospital_id_fkey" FOREIGN KEY ("hospital_id") REFERENCES "public"."hospitals"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."aefi_reports"
    ADD CONSTRAINT "aefi_reports_patient_id_fkey" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."aefi_reports"
    ADD CONSTRAINT "aefi_reports_reported_by_fkey" FOREIGN KEY ("reported_by") REFERENCES "public"."profiles"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."aefi_reports"
    ADD CONSTRAINT "aefi_reports_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."ai_health_chats"
    ADD CONSTRAINT "ai_health_chats_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."allergens_catalog"
    ADD CONSTRAINT "allergens_catalog_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."allergens_catalog"
    ADD CONSTRAINT "allergens_catalog_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."app_vitals"
    ADD CONSTRAINT "app_vitals_patient_id_fkey" FOREIGN KEY ("patient_id") REFERENCES "public"."profiles"("id");



ALTER TABLE ONLY "public"."app_vitals"
    ADD CONSTRAINT "app_vitals_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id");



ALTER TABLE ONLY "public"."audit_events"
    ADD CONSTRAINT "audit_events_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."audit_events"
    ADD CONSTRAINT "audit_events_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."audit_log"
    ADD CONSTRAINT "audit_log_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."audit_log"
    ADD CONSTRAINT "audit_log_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."bed_assignments"
    ADD CONSTRAINT "bed_assignments_assigned_by_fkey" FOREIGN KEY ("assigned_by") REFERENCES "public"."profiles"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."bed_assignments"
    ADD CONSTRAINT "bed_assignments_bed_id_fkey" FOREIGN KEY ("bed_id") REFERENCES "public"."hospital_beds"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."bed_assignments"
    ADD CONSTRAINT "bed_assignments_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."bed_assignments"
    ADD CONSTRAINT "bed_assignments_discharged_by_fkey" FOREIGN KEY ("discharged_by") REFERENCES "public"."profiles"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."bed_assignments"
    ADD CONSTRAINT "bed_assignments_patient_id_fkey" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."bed_assignments"
    ADD CONSTRAINT "bed_assignments_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."beta_access_requests"
    ADD CONSTRAINT "beta_access_requests_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."beta_access_requests"
    ADD CONSTRAINT "beta_access_requests_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."billing_invoices"
    ADD CONSTRAINT "billing_invoices_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."billing_invoices"
    ADD CONSTRAINT "billing_invoices_encounter_id_fkey" FOREIGN KEY ("encounter_id") REFERENCES "public"."encounters"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."billing_invoices"
    ADD CONSTRAINT "billing_invoices_patient_id_fkey" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."billing_invoices"
    ADD CONSTRAINT "billing_invoices_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."billing_line_items"
    ADD CONSTRAINT "billing_line_items_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."billing_line_items"
    ADD CONSTRAINT "billing_line_items_invoice_id_fkey" FOREIGN KEY ("invoice_id") REFERENCES "public"."billing_invoices"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."billing_line_items"
    ADD CONSTRAINT "billing_line_items_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."billing_payments"
    ADD CONSTRAINT "billing_payments_encounter_id_fkey" FOREIGN KEY ("encounter_id") REFERENCES "public"."encounters"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."billing_payments"
    ADD CONSTRAINT "billing_payments_invoice_id_fkey" FOREIGN KEY ("invoice_id") REFERENCES "public"."billing_invoices"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."billing_payments"
    ADD CONSTRAINT "billing_payments_patient_id_fkey" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."billing_payments"
    ADD CONSTRAINT "billing_payments_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."blood_deferrals"
    ADD CONSTRAINT "blood_deferrals_person_id_fkey" FOREIGN KEY ("person_id") REFERENCES "public"."persons"("id");



ALTER TABLE ONLY "public"."blood_donation_profiles"
    ADD CONSTRAINT "blood_donation_profiles_blood_group_fact_id_fkey" FOREIGN KEY ("blood_group_fact_id") REFERENCES "public"."person_clinical_facts"("id");



ALTER TABLE ONLY "public"."blood_donation_profiles"
    ADD CONSTRAINT "blood_donation_profiles_person_id_fkey" FOREIGN KEY ("person_id") REFERENCES "public"."persons"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."blood_donations"
    ADD CONSTRAINT "blood_donations_facility_id_fkey" FOREIGN KEY ("facility_id") REFERENCES "public"."tenants"("id");



ALTER TABLE ONLY "public"."blood_donations"
    ADD CONSTRAINT "blood_donations_person_id_fkey" FOREIGN KEY ("person_id") REFERENCES "public"."persons"("id");



ALTER TABLE ONLY "public"."body_register"
    ADD CONSTRAINT "body_register_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."calls"
    ADD CONSTRAINT "calls_callee_id_fkey" FOREIGN KEY ("callee_id") REFERENCES "public"."profiles"("id");



ALTER TABLE ONLY "public"."calls"
    ADD CONSTRAINT "calls_caller_id_fkey" FOREIGN KEY ("caller_id") REFERENCES "public"."profiles"("id");



ALTER TABLE ONLY "public"."care_team_handovers"
    ADD CONSTRAINT "care_team_handovers_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."care_team_handovers"
    ADD CONSTRAINT "care_team_handovers_department_id_fkey" FOREIGN KEY ("department_id") REFERENCES "public"."departments"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."care_team_handovers"
    ADD CONSTRAINT "care_team_handovers_handed_off_by_fkey" FOREIGN KEY ("handed_off_by") REFERENCES "public"."profiles"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."care_team_handovers"
    ADD CONSTRAINT "care_team_handovers_hospital_id_fkey" FOREIGN KEY ("hospital_id") REFERENCES "public"."hospitals"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."care_team_handovers"
    ADD CONSTRAINT "care_team_handovers_received_by_fkey" FOREIGN KEY ("received_by") REFERENCES "public"."profiles"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."care_team_handovers"
    ADD CONSTRAINT "care_team_handovers_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."cds_alerts"
    ADD CONSTRAINT "cds_alerts_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."cds_alerts"
    ADD CONSTRAINT "cds_alerts_encounter_id_fkey" FOREIGN KEY ("encounter_id") REFERENCES "public"."encounters"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."cds_alerts"
    ADD CONSTRAINT "cds_alerts_patient_id_fkey" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."cds_alerts"
    ADD CONSTRAINT "cds_alerts_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."cds_rules"
    ADD CONSTRAINT "cds_rules_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."cds_rules"
    ADD CONSTRAINT "cds_rules_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."chw_visits"
    ADD CONSTRAINT "chw_visits_campaign_id_fkey" FOREIGN KEY ("campaign_id") REFERENCES "public"."outreach_campaigns"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."chw_visits"
    ADD CONSTRAINT "chw_visits_chw_id_fkey" FOREIGN KEY ("chw_id") REFERENCES "public"."community_health_workers"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."chw_visits"
    ADD CONSTRAINT "chw_visits_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."chw_visits"
    ADD CONSTRAINT "chw_visits_hospital_id_fkey" FOREIGN KEY ("hospital_id") REFERENCES "public"."hospitals"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."chw_visits"
    ADD CONSTRAINT "chw_visits_patient_id_fkey" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."chw_visits"
    ADD CONSTRAINT "chw_visits_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."claim_line_items"
    ADD CONSTRAINT "claim_line_items_claim_id_fkey" FOREIGN KEY ("claim_id") REFERENCES "public"."insurance_claims"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."claim_line_items"
    ADD CONSTRAINT "claim_line_items_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."claim_line_items"
    ADD CONSTRAINT "claim_line_items_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."claim_resubmissions"
    ADD CONSTRAINT "claim_resubmissions_claim_id_fkey" FOREIGN KEY ("claim_id") REFERENCES "public"."insurance_claims"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."claim_resubmissions"
    ADD CONSTRAINT "claim_resubmissions_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."claim_resubmissions"
    ADD CONSTRAINT "claim_resubmissions_new_claim_id_fkey" FOREIGN KEY ("new_claim_id") REFERENCES "public"."insurance_claims"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."claim_resubmissions"
    ADD CONSTRAINT "claim_resubmissions_resubmitted_by_fkey" FOREIGN KEY ("resubmitted_by") REFERENCES "public"."profiles"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."claim_resubmissions"
    ADD CONSTRAINT "claim_resubmissions_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."clinical_intelligence_decisions"
    ADD CONSTRAINT "clinical_intelligence_decisions_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "public"."profiles"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."clinical_intelligence_decisions"
    ADD CONSTRAINT "clinical_intelligence_decisions_encounter_id_fkey" FOREIGN KEY ("encounter_id") REFERENCES "public"."encounters"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."clinical_intelligence_decisions"
    ADD CONSTRAINT "clinical_intelligence_decisions_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "public"."clinical_intelligence_sessions"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."clinical_intelligence_decisions"
    ADD CONSTRAINT "clinical_intelligence_decisions_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."hospitals"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."clinical_intelligence_sessions"
    ADD CONSTRAINT "clinical_intelligence_sessions_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "public"."profiles"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."clinical_intelligence_sessions"
    ADD CONSTRAINT "clinical_intelligence_sessions_encounter_id_fkey" FOREIGN KEY ("encounter_id") REFERENCES "public"."encounters"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."clinical_intelligence_sessions"
    ADD CONSTRAINT "clinical_intelligence_sessions_facility_id_fkey" FOREIGN KEY ("facility_id") REFERENCES "public"."hospitals"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."clinical_intelligence_sessions"
    ADD CONSTRAINT "clinical_intelligence_sessions_patient_id_fkey" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."clinical_intelligence_sessions"
    ADD CONSTRAINT "clinical_intelligence_sessions_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."hospitals"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."clinical_note_embeddings"
    ADD CONSTRAINT "clinical_note_embeddings_encounter_id_fkey" FOREIGN KEY ("encounter_id") REFERENCES "public"."encounters"("id");



ALTER TABLE ONLY "public"."clinical_note_embeddings"
    ADD CONSTRAINT "clinical_note_embeddings_patient_id_fkey" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id");



ALTER TABLE ONLY "public"."clinical_note_embeddings"
    ADD CONSTRAINT "clinical_note_embeddings_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."clinical_notes"
    ADD CONSTRAINT "clinical_notes_authored_by_fkey" FOREIGN KEY ("authored_by") REFERENCES "public"."profiles"("id");



ALTER TABLE ONLY "public"."clinical_notes"
    ADD CONSTRAINT "clinical_notes_encounter_id_fkey" FOREIGN KEY ("encounter_id") REFERENCES "public"."encounters"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."clinical_notes"
    ADD CONSTRAINT "clinical_notes_patient_id_fkey" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id");



ALTER TABLE ONLY "public"."clinical_notes"
    ADD CONSTRAINT "clinical_notes_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."clinical_pathway_templates"
    ADD CONSTRAINT "clinical_pathway_templates_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."profiles"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."clinical_pathway_templates"
    ADD CONSTRAINT "clinical_pathway_templates_hospital_id_fkey" FOREIGN KEY ("hospital_id") REFERENCES "public"."hospitals"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."clinical_pathway_templates"
    ADD CONSTRAINT "clinical_pathway_templates_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."clinical_prescriptions"
    ADD CONSTRAINT "clinical_prescriptions_pharmacy_tenant_id_fkey" FOREIGN KEY ("pharmacy_tenant_id") REFERENCES "public"."tenants"("id");



ALTER TABLE ONLY "public"."clinical_prescriptions"
    ADD CONSTRAINT "clinical_prescriptions_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id");



ALTER TABLE ONLY "public"."community_health_workers"
    ADD CONSTRAINT "community_health_workers_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."community_health_workers"
    ADD CONSTRAINT "community_health_workers_hospital_id_fkey" FOREIGN KEY ("hospital_id") REFERENCES "public"."hospitals"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."community_health_workers"
    ADD CONSTRAINT "community_health_workers_profile_id_fkey" FOREIGN KEY ("profile_id") REFERENCES "public"."profiles"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."community_health_workers"
    ADD CONSTRAINT "community_health_workers_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."consent_audit_log"
    ADD CONSTRAINT "consent_audit_log_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "public"."profiles"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."consent_audit_log"
    ADD CONSTRAINT "consent_audit_log_consent_id_fkey" FOREIGN KEY ("consent_id") REFERENCES "public"."patient_consents"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."consent_audit_log"
    ADD CONSTRAINT "consent_audit_log_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."consent_audit_log"
    ADD CONSTRAINT "consent_audit_log_grant_id_fkey" FOREIGN KEY ("grant_id") REFERENCES "public"."patient_access_grants"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."consent_audit_log"
    ADD CONSTRAINT "consent_audit_log_patient_id_fkey" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."consent_audit_log"
    ADD CONSTRAINT "consent_audit_log_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."consult_queue"
    ADD CONSTRAINT "consult_queue_assigned_doctor_id_fkey" FOREIGN KEY ("assigned_doctor_id") REFERENCES "public"."telemedicine_providers"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."consult_queue"
    ADD CONSTRAINT "consult_queue_case_id_fkey" FOREIGN KEY ("case_id") REFERENCES "public"."telemedicine_intake_cases"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."cross_tenant_access"
    ADD CONSTRAINT "cross_tenant_access_accessing_tenant_id_fkey" FOREIGN KEY ("accessing_tenant_id") REFERENCES "public"."tenants"("id");



ALTER TABLE ONLY "public"."cross_tenant_access"
    ADD CONSTRAINT "cross_tenant_access_granting_tenant_id_fkey" FOREIGN KEY ("granting_tenant_id") REFERENCES "public"."tenants"("id");



ALTER TABLE ONLY "public"."cross_tenant_access"
    ADD CONSTRAINT "cross_tenant_access_patient_id_fkey" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id");



ALTER TABLE ONLY "public"."cross_tenant_access"
    ADD CONSTRAINT "cross_tenant_access_referral_id_fkey" FOREIGN KEY ("referral_id") REFERENCES "public"."facility_referrals"("id");



ALTER TABLE ONLY "public"."data_breach_incidents"
    ADD CONSTRAINT "data_breach_incidents_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."data_breach_incidents"
    ADD CONSTRAINT "data_breach_incidents_hospital_id_fkey" FOREIGN KEY ("hospital_id") REFERENCES "public"."hospitals"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."data_breach_incidents"
    ADD CONSTRAINT "data_breach_incidents_reported_by_fkey" FOREIGN KEY ("reported_by") REFERENCES "public"."profiles"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."data_breach_incidents"
    ADD CONSTRAINT "data_breach_incidents_resolved_by_fkey" FOREIGN KEY ("resolved_by") REFERENCES "public"."profiles"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."data_breach_incidents"
    ADD CONSTRAINT "data_breach_incidents_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."data_export_jobs"
    ADD CONSTRAINT "data_export_jobs_approved_by_fkey" FOREIGN KEY ("approved_by") REFERENCES "public"."profiles"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."data_export_jobs"
    ADD CONSTRAINT "data_export_jobs_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."data_export_jobs"
    ADD CONSTRAINT "data_export_jobs_hospital_id_fkey" FOREIGN KEY ("hospital_id") REFERENCES "public"."hospitals"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."data_export_jobs"
    ADD CONSTRAINT "data_export_jobs_requested_by_fkey" FOREIGN KEY ("requested_by") REFERENCES "public"."profiles"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."data_export_jobs"
    ADD CONSTRAINT "data_export_jobs_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."data_retention_policies"
    ADD CONSTRAINT "data_retention_policies_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."data_retention_policies"
    ADD CONSTRAINT "data_retention_policies_hospital_id_fkey" FOREIGN KEY ("hospital_id") REFERENCES "public"."hospitals"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."data_retention_policies"
    ADD CONSTRAINT "data_retention_policies_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."death_registrations"
    ADD CONSTRAINT "death_registrations_certifying_doctor_id_fkey" FOREIGN KEY ("certifying_doctor_id") REFERENCES "public"."profiles"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."death_registrations"
    ADD CONSTRAINT "death_registrations_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."death_registrations"
    ADD CONSTRAINT "death_registrations_hospital_id_fkey" FOREIGN KEY ("hospital_id") REFERENCES "public"."hospitals"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."death_registrations"
    ADD CONSTRAINT "death_registrations_patient_id_fkey" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."death_registrations"
    ADD CONSTRAINT "death_registrations_registered_by_fkey" FOREIGN KEY ("registered_by") REFERENCES "public"."profiles"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."death_registrations"
    ADD CONSTRAINT "death_registrations_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."death_reports"
    ADD CONSTRAINT "death_reports_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."death_reports"
    ADD CONSTRAINT "death_reports_encounter_id_fkey" FOREIGN KEY ("encounter_id") REFERENCES "public"."encounters"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."death_reports"
    ADD CONSTRAINT "death_reports_patient_id_fkey" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."death_reports"
    ADD CONSTRAINT "death_reports_reported_by_fkey" FOREIGN KEY ("reported_by") REFERENCES "public"."profiles"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."death_reports"
    ADD CONSTRAINT "death_reports_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."deidentification_profiles"
    ADD CONSTRAINT "deidentification_profiles_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."profiles"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."deidentification_profiles"
    ADD CONSTRAINT "deidentification_profiles_hospital_id_fkey" FOREIGN KEY ("hospital_id") REFERENCES "public"."hospitals"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."deidentification_profiles"
    ADD CONSTRAINT "deidentification_profiles_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."demo_encounter_orders"
    ADD CONSTRAINT "demo_encounter_orders_encounter_id_fkey" FOREIGN KEY ("encounter_id") REFERENCES "public"."demo_encounters"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."demo_encounters"
    ADD CONSTRAINT "demo_encounters_department_id_fkey" FOREIGN KEY ("department_id") REFERENCES "public"."demo_departments"("id");



ALTER TABLE ONLY "public"."demo_encounters"
    ADD CONSTRAINT "demo_encounters_patient_id_fkey" FOREIGN KEY ("patient_id") REFERENCES "public"."demo_patients"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."demo_lab_results"
    ADD CONSTRAINT "demo_lab_results_encounter_id_fkey" FOREIGN KEY ("encounter_id") REFERENCES "public"."demo_encounters"("id");



ALTER TABLE ONLY "public"."demo_lab_results"
    ADD CONSTRAINT "demo_lab_results_patient_id_fkey" FOREIGN KEY ("patient_id") REFERENCES "public"."demo_patients"("id");



ALTER TABLE ONLY "public"."demo_patients"
    ADD CONSTRAINT "demo_patients_department_id_fkey" FOREIGN KEY ("department_id") REFERENCES "public"."demo_departments"("id");



ALTER TABLE ONLY "public"."demo_vitals"
    ADD CONSTRAINT "demo_vitals_encounter_id_fkey" FOREIGN KEY ("encounter_id") REFERENCES "public"."demo_encounters"("id");



ALTER TABLE ONLY "public"."demo_vitals"
    ADD CONSTRAINT "demo_vitals_patient_id_fkey" FOREIGN KEY ("patient_id") REFERENCES "public"."demo_patients"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."denial_analytics_daily"
    ADD CONSTRAINT "denial_analytics_daily_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."denial_analytics_daily"
    ADD CONSTRAINT "denial_analytics_daily_hospital_id_fkey" FOREIGN KEY ("hospital_id") REFERENCES "public"."hospitals"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."denial_analytics_daily"
    ADD CONSTRAINT "denial_analytics_daily_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."department_tasks"
    ADD CONSTRAINT "department_tasks_hospital_id_fkey" FOREIGN KEY ("hospital_id") REFERENCES "public"."hospitals"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."department_tasks"
    ADD CONSTRAINT "department_tasks_patient_id_fkey" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."department_tasks"
    ADD CONSTRAINT "department_tasks_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."departments"
    ADD CONSTRAINT "departments_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."departments"
    ADD CONSTRAINT "departments_hospital_id_fkey" FOREIGN KEY ("hospital_id") REFERENCES "public"."hospitals"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."departments"
    ADD CONSTRAINT "departments_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."device_alerts"
    ADD CONSTRAINT "device_alerts_acknowledged_by_fkey" FOREIGN KEY ("acknowledged_by") REFERENCES "public"."profiles"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."device_alerts"
    ADD CONSTRAINT "device_alerts_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."device_alerts"
    ADD CONSTRAINT "device_alerts_device_id_fkey" FOREIGN KEY ("device_id") REFERENCES "public"."medical_devices"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."device_alerts"
    ADD CONSTRAINT "device_alerts_hospital_id_fkey" FOREIGN KEY ("hospital_id") REFERENCES "public"."hospitals"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."device_alerts"
    ADD CONSTRAINT "device_alerts_patient_id_fkey" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."device_alerts"
    ADD CONSTRAINT "device_alerts_reading_id_fkey" FOREIGN KEY ("reading_id") REFERENCES "public"."device_readings"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."device_alerts"
    ADD CONSTRAINT "device_alerts_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."device_readings"
    ADD CONSTRAINT "device_readings_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."device_readings"
    ADD CONSTRAINT "device_readings_device_id_fkey" FOREIGN KEY ("device_id") REFERENCES "public"."medical_devices"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."device_readings"
    ADD CONSTRAINT "device_readings_encounter_id_fkey" FOREIGN KEY ("encounter_id") REFERENCES "public"."encounters"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."device_readings"
    ADD CONSTRAINT "device_readings_hospital_id_fkey" FOREIGN KEY ("hospital_id") REFERENCES "public"."hospitals"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."device_readings"
    ADD CONSTRAINT "device_readings_patient_id_fkey" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."device_readings"
    ADD CONSTRAINT "device_readings_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."dhis2_data_element_mappings"
    ADD CONSTRAINT "dhis2_data_element_mappings_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."dhis2_export_attempt_log"
    ADD CONSTRAINT "dhis2_export_attempt_log_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "public"."dhis2_export_jobs"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."dhis2_export_attempt_log"
    ADD CONSTRAINT "dhis2_export_attempt_log_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."dhis2_export_jobs"
    ADD CONSTRAINT "dhis2_export_jobs_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."dhis2_export_log"
    ADD CONSTRAINT "dhis2_export_log_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "public"."dhis2_export_jobs"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."dhis2_export_log"
    ADD CONSTRAINT "dhis2_export_log_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."dhis2_org_unit_mappings"
    ADD CONSTRAINT "dhis2_org_unit_mappings_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."diagnoses"
    ADD CONSTRAINT "diagnoses_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."diagnoses"
    ADD CONSTRAINT "diagnoses_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."diet_logs"
    ADD CONSTRAINT "diet_logs_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."doctor_availability_log"
    ADD CONSTRAINT "doctor_availability_log_provider_id_fkey" FOREIGN KEY ("provider_id") REFERENCES "public"."telemedicine_providers"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."domain_event_consumers"
    ADD CONSTRAINT "domain_event_consumers_last_event_id_fkey" FOREIGN KEY ("last_event_id") REFERENCES "public"."domain_events"("event_id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."domain_event_consumers"
    ADD CONSTRAINT "domain_event_consumers_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."hospitals"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."domain_events"
    ADD CONSTRAINT "domain_events_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "public"."profiles"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."domain_events"
    ADD CONSTRAINT "domain_events_encounter_id_fkey" FOREIGN KEY ("encounter_id") REFERENCES "public"."encounters"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."domain_events"
    ADD CONSTRAINT "domain_events_facility_id_fkey" FOREIGN KEY ("facility_id") REFERENCES "public"."hospitals"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."domain_events"
    ADD CONSTRAINT "domain_events_patient_id_fkey" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."domain_events"
    ADD CONSTRAINT "domain_events_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."hospitals"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."drug_contraindications"
    ADD CONSTRAINT "drug_contraindications_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."drug_contraindications"
    ADD CONSTRAINT "drug_contraindications_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."drug_dose_adjustments"
    ADD CONSTRAINT "drug_dose_adjustments_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."drug_dose_adjustments"
    ADD CONSTRAINT "drug_dose_adjustments_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."drug_interactions_catalog"
    ADD CONSTRAINT "drug_interactions_catalog_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."drug_interactions_catalog"
    ADD CONSTRAINT "drug_interactions_catalog_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."drug_interactions"
    ADD CONSTRAINT "drug_interactions_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."drug_interactions"
    ADD CONSTRAINT "drug_interactions_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."drug_inventory"
    ADD CONSTRAINT "drug_inventory_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."drug_shortage_alerts"
    ADD CONSTRAINT "drug_shortage_alerts_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."profiles"("id");



ALTER TABLE ONLY "public"."emergency_access_events"
    ADD CONSTRAINT "emergency_access_events_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "public"."profiles"("id");



ALTER TABLE ONLY "public"."emergency_access_events"
    ADD CONSTRAINT "emergency_access_events_facility_id_fkey" FOREIGN KEY ("facility_id") REFERENCES "public"."tenants"("id");



ALTER TABLE ONLY "public"."emergency_access_events"
    ADD CONSTRAINT "emergency_access_events_person_id_fkey" FOREIGN KEY ("person_id") REFERENCES "public"."persons"("id");



ALTER TABLE ONLY "public"."emergency_profiles"
    ADD CONSTRAINT "emergency_profiles_person_id_fkey" FOREIGN KEY ("person_id") REFERENCES "public"."persons"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."encounter_amendments"
    ADD CONSTRAINT "encounter_amendments_encounter_id_fkey" FOREIGN KEY ("encounter_id") REFERENCES "public"."encounters"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."encounter_amendments"
    ADD CONSTRAINT "encounter_amendments_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."encounter_diagnoses"
    ADD CONSTRAINT "encounter_diagnoses_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."encounter_diagnoses"
    ADD CONSTRAINT "encounter_diagnoses_encounter_id_fkey" FOREIGN KEY ("encounter_id") REFERENCES "public"."encounters"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."encounter_diagnoses"
    ADD CONSTRAINT "encounter_diagnoses_intelligence_session_id_fkey" FOREIGN KEY ("intelligence_session_id") REFERENCES "public"."clinical_intelligence_sessions"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."encounter_diagnoses"
    ADD CONSTRAINT "encounter_diagnoses_selected_by_fkey" FOREIGN KEY ("selected_by") REFERENCES "public"."profiles"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."encounter_diagnoses"
    ADD CONSTRAINT "encounter_diagnoses_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."encounter_orders"
    ADD CONSTRAINT "encounter_orders_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."encounter_orders"
    ADD CONSTRAINT "encounter_orders_encounter_diagnosis_id_fkey" FOREIGN KEY ("encounter_diagnosis_id") REFERENCES "public"."encounter_diagnoses"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."encounter_orders"
    ADD CONSTRAINT "encounter_orders_encounter_id_fkey" FOREIGN KEY ("encounter_id") REFERENCES "public"."encounters"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."encounter_orders"
    ADD CONSTRAINT "encounter_orders_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."encounters"
    ADD CONSTRAINT "encounters_clinician_id_fkey" FOREIGN KEY ("clinician_id") REFERENCES "public"."profiles"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."encounters"
    ADD CONSTRAINT "encounters_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."encounters"
    ADD CONSTRAINT "encounters_department_id_fkey" FOREIGN KEY ("department_id") REFERENCES "public"."departments"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."encounters"
    ADD CONSTRAINT "encounters_disposition_by_fkey" FOREIGN KEY ("disposition_by") REFERENCES "public"."profiles"("id");



ALTER TABLE ONLY "public"."encounters"
    ADD CONSTRAINT "encounters_hospital_id_fkey" FOREIGN KEY ("hospital_id") REFERENCES "public"."hospitals"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."encounters"
    ADD CONSTRAINT "encounters_patient_id_fkey" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."encounters"
    ADD CONSTRAINT "encounters_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."expert_rules"
    ADD CONSTRAINT "expert_rules_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."expert_rules"
    ADD CONSTRAINT "expert_rules_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."facility_domain_records"
    ADD CONSTRAINT "facility_domain_records_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."facility_invitation_audit"
    ADD CONSTRAINT "facility_invitation_audit_invitation_id_fkey" FOREIGN KEY ("invitation_id") REFERENCES "public"."facility_invitations"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."facility_invitations"
    ADD CONSTRAINT "facility_invitations_department_id_fkey" FOREIGN KEY ("department_id") REFERENCES "public"."departments"("id");



ALTER TABLE ONLY "public"."facility_invitations"
    ADD CONSTRAINT "facility_invitations_redeemed_by_fkey" FOREIGN KEY ("redeemed_by") REFERENCES "public"."profiles"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."facility_invitations"
    ADD CONSTRAINT "facility_invitations_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "public"."facility_provisioning_runs"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."facility_invitations"
    ADD CONSTRAINT "facility_invitations_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."facility_lifecycle_events"
    ADD CONSTRAINT "facility_lifecycle_events_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id");



ALTER TABLE ONLY "public"."facility_locations"
    ADD CONSTRAINT "facility_locations_department_id_fkey" FOREIGN KEY ("department_id") REFERENCES "public"."departments"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."facility_locations"
    ADD CONSTRAINT "facility_locations_hospital_id_fkey" FOREIGN KEY ("hospital_id") REFERENCES "public"."hospitals"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."facility_locations"
    ADD CONSTRAINT "facility_locations_parent_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "public"."facility_locations"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."facility_locations"
    ADD CONSTRAINT "facility_locations_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."facility_provisioning_runs"
    ADD CONSTRAINT "facility_provisioning_runs_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."facility_provisioning_steps"
    ADD CONSTRAINT "facility_provisioning_steps_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "public"."facility_provisioning_runs"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."facility_referrals"
    ADD CONSTRAINT "facility_referrals_accepted_by_fkey" FOREIGN KEY ("accepted_by") REFERENCES "public"."profiles"("id");



ALTER TABLE ONLY "public"."facility_referrals"
    ADD CONSTRAINT "facility_referrals_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."profiles"("id");



ALTER TABLE ONLY "public"."facility_referrals"
    ADD CONSTRAINT "facility_referrals_encounter_id_fkey" FOREIGN KEY ("encounter_id") REFERENCES "public"."encounters"("id");



ALTER TABLE ONLY "public"."facility_referrals"
    ADD CONSTRAINT "facility_referrals_from_tenant_id_fkey" FOREIGN KEY ("from_tenant_id") REFERENCES "public"."tenants"("id");



ALTER TABLE ONLY "public"."facility_referrals"
    ADD CONSTRAINT "facility_referrals_patient_id_fkey" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id");



ALTER TABLE ONLY "public"."facility_referrals"
    ADD CONSTRAINT "facility_referrals_to_tenant_id_fkey" FOREIGN KEY ("to_tenant_id") REFERENCES "public"."tenants"("id");



ALTER TABLE ONLY "public"."facility_resource_logs"
    ADD CONSTRAINT "facility_resource_logs_hospital_id_fkey" FOREIGN KEY ("hospital_id") REFERENCES "public"."hospitals"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."facility_resource_logs"
    ADD CONSTRAINT "facility_resource_logs_recorded_by_fkey" FOREIGN KEY ("recorded_by") REFERENCES "public"."profiles"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."feature_flags"
    ADD CONSTRAINT "feature_flags_enabled_by_fkey" FOREIGN KEY ("enabled_by") REFERENCES "public"."profiles"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."feature_flags"
    ADD CONSTRAINT "feature_flags_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."gas_cylinders"
    ADD CONSTRAINT "gas_cylinders_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."gas_cylinders"
    ADD CONSTRAINT "gas_cylinders_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "public"."profiles"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."gas_cylinders"
    ADD CONSTRAINT "gas_cylinders_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."habit_logs"
    ADD CONSTRAINT "habit_logs_habit_id_fkey" FOREIGN KEY ("habit_id") REFERENCES "public"."health_habits"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."habit_logs"
    ADD CONSTRAINT "habit_logs_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."handover_patient_entries"
    ADD CONSTRAINT "handover_patient_entries_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."handover_patient_entries"
    ADD CONSTRAINT "handover_patient_entries_handover_id_fkey" FOREIGN KEY ("handover_id") REFERENCES "public"."care_team_handovers"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."handover_patient_entries"
    ADD CONSTRAINT "handover_patient_entries_patient_id_fkey" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."handover_patient_entries"
    ADD CONSTRAINT "handover_patient_entries_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."handover_shift_tasks"
    ADD CONSTRAINT "handover_shift_tasks_assigned_to_fkey" FOREIGN KEY ("assigned_to") REFERENCES "public"."profiles"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."handover_shift_tasks"
    ADD CONSTRAINT "handover_shift_tasks_carried_over_to_fkey" FOREIGN KEY ("carried_over_to") REFERENCES "public"."care_team_handovers"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."handover_shift_tasks"
    ADD CONSTRAINT "handover_shift_tasks_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."handover_shift_tasks"
    ADD CONSTRAINT "handover_shift_tasks_handover_id_fkey" FOREIGN KEY ("handover_id") REFERENCES "public"."care_team_handovers"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."handover_shift_tasks"
    ADD CONSTRAINT "handover_shift_tasks_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."handover_signatures"
    ADD CONSTRAINT "handover_signatures_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."handover_signatures"
    ADD CONSTRAINT "handover_signatures_handover_id_fkey" FOREIGN KEY ("handover_id") REFERENCES "public"."care_team_handovers"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."handover_signatures"
    ADD CONSTRAINT "handover_signatures_signer_id_fkey" FOREIGN KEY ("signer_id") REFERENCES "public"."profiles"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."handover_signatures"
    ADD CONSTRAINT "handover_signatures_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."health_habits"
    ADD CONSTRAINT "health_habits_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."hospital_beds"
    ADD CONSTRAINT "hospital_beds_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."hospital_beds"
    ADD CONSTRAINT "hospital_beds_current_patient_id_fkey" FOREIGN KEY ("current_patient_id") REFERENCES "public"."patients"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."hospital_beds"
    ADD CONSTRAINT "hospital_beds_hospital_id_fkey" FOREIGN KEY ("hospital_id") REFERENCES "public"."hospitals"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."hospital_beds"
    ADD CONSTRAINT "hospital_beds_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."hospital_drug_orders"
    ADD CONSTRAINT "hospital_drug_orders_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."hospital_drug_orders"
    ADD CONSTRAINT "hospital_drug_orders_encounter_id_fkey" FOREIGN KEY ("encounter_id") REFERENCES "public"."encounters"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."hospital_drug_orders"
    ADD CONSTRAINT "hospital_drug_orders_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."hospital_modules"
    ADD CONSTRAINT "hospital_modules_hospital_id_fkey" FOREIGN KEY ("hospital_id") REFERENCES "public"."hospitals"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."hospital_seed_registry"
    ADD CONSTRAINT "hospital_seed_registry_hospital_id_fkey" FOREIGN KEY ("hospital_id") REFERENCES "public"."hospitals"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."hospital_seed_registry"
    ADD CONSTRAINT "hospital_seed_registry_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."hospital_settings"
    ADD CONSTRAINT "hospital_settings_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."hospital_settings"
    ADD CONSTRAINT "hospital_settings_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."housekeeping_tasks"
    ADD CONSTRAINT "housekeeping_tasks_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."identity_match_candidates"
    ADD CONSTRAINT "identity_match_candidates_candidate_person_id_fkey" FOREIGN KEY ("candidate_person_id") REFERENCES "public"."persons"("id");



ALTER TABLE ONLY "public"."identity_match_candidates"
    ADD CONSTRAINT "identity_match_candidates_person_id_fkey" FOREIGN KEY ("person_id") REFERENCES "public"."persons"("id");



ALTER TABLE ONLY "public"."identity_match_candidates"
    ADD CONSTRAINT "identity_match_candidates_reviewed_by_fkey" FOREIGN KEY ("reviewed_by") REFERENCES "public"."profiles"("id");



ALTER TABLE ONLY "public"."identity_merge_events"
    ADD CONSTRAINT "identity_merge_events_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "public"."profiles"("id");



ALTER TABLE ONLY "public"."identity_merge_events"
    ADD CONSTRAINT "identity_merge_events_retired_person_id_fkey" FOREIGN KEY ("retired_person_id") REFERENCES "public"."persons"("id");



ALTER TABLE ONLY "public"."identity_merge_events"
    ADD CONSTRAINT "identity_merge_events_surviving_person_id_fkey" FOREIGN KEY ("surviving_person_id") REFERENCES "public"."persons"("id");



ALTER TABLE ONLY "public"."imaging_series"
    ADD CONSTRAINT "imaging_series_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."imaging_series"
    ADD CONSTRAINT "imaging_series_study_id_fkey" FOREIGN KEY ("study_id") REFERENCES "public"."imaging_studies"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."imaging_series"
    ADD CONSTRAINT "imaging_series_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."imaging_studies"
    ADD CONSTRAINT "imaging_studies_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."profiles"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."imaging_studies"
    ADD CONSTRAINT "imaging_studies_encounter_id_fkey" FOREIGN KEY ("encounter_id") REFERENCES "public"."encounters"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."imaging_studies"
    ADD CONSTRAINT "imaging_studies_hospital_id_fkey" FOREIGN KEY ("hospital_id") REFERENCES "public"."hospitals"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."imaging_studies"
    ADD CONSTRAINT "imaging_studies_patient_id_fkey" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."imaging_studies"
    ADD CONSTRAINT "imaging_studies_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."imid_access_log"
    ADD CONSTRAINT "imid_access_log_imid_code_id_fkey" FOREIGN KEY ("imid_code_id") REFERENCES "public"."imid_codes"("id");



ALTER TABLE ONLY "public"."imid_access_log"
    ADD CONSTRAINT "imid_access_log_patient_id_fkey" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id");



ALTER TABLE ONLY "public"."imid_codes"
    ADD CONSTRAINT "imid_codes_patient_id_fkey" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id");



ALTER TABLE ONLY "public"."imid_codes"
    ADD CONSTRAINT "imid_codes_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id");



ALTER TABLE ONLY "public"."immunization_schedule"
    ADD CONSTRAINT "immunization_schedule_administered_by_fkey" FOREIGN KEY ("administered_by") REFERENCES "public"."profiles"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."immunization_schedule"
    ADD CONSTRAINT "immunization_schedule_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."immunization_schedule"
    ADD CONSTRAINT "immunization_schedule_patient_id_fkey" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."immunization_schedule"
    ADD CONSTRAINT "immunization_schedule_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."import_batch_rows"
    ADD CONSTRAINT "import_batch_rows_batch_id_fkey" FOREIGN KEY ("batch_id") REFERENCES "public"."import_batches"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."import_batch_rows"
    ADD CONSTRAINT "import_batch_rows_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."import_batch_rows"
    ADD CONSTRAINT "import_batch_rows_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."import_batches"
    ADD CONSTRAINT "import_batches_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."profiles"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."import_batches"
    ADD CONSTRAINT "import_batches_hospital_id_fkey" FOREIGN KEY ("hospital_id") REFERENCES "public"."hospitals"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."import_batches"
    ADD CONSTRAINT "import_batches_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."import_column_mappings"
    ADD CONSTRAINT "import_column_mappings_batch_id_fkey" FOREIGN KEY ("batch_id") REFERENCES "public"."import_batches"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."import_column_mappings"
    ADD CONSTRAINT "import_column_mappings_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."import_column_mappings"
    ADD CONSTRAINT "import_column_mappings_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."insurance_benefits"
    ADD CONSTRAINT "insurance_benefits_policy_id_fkey" FOREIGN KEY ("policy_id") REFERENCES "public"."insurance_policies"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."insurance_benefits"
    ADD CONSTRAINT "insurance_benefits_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."insurance_claims"
    ADD CONSTRAINT "insurance_claims_contract_id_fkey" FOREIGN KEY ("contract_id") REFERENCES "public"."payer_contracts"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."insurance_claims"
    ADD CONSTRAINT "insurance_claims_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."insurance_claims"
    ADD CONSTRAINT "insurance_claims_encounter_id_fkey" FOREIGN KEY ("encounter_id") REFERENCES "public"."encounters"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."insurance_claims"
    ADD CONSTRAINT "insurance_claims_hospital_id_fkey" FOREIGN KEY ("hospital_id") REFERENCES "public"."hospitals"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."insurance_claims"
    ADD CONSTRAINT "insurance_claims_invoice_id_fkey" FOREIGN KEY ("invoice_id") REFERENCES "public"."billing_invoices"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."insurance_claims"
    ADD CONSTRAINT "insurance_claims_patient_id_fkey" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."insurance_claims"
    ADD CONSTRAINT "insurance_claims_submitted_by_fkey" FOREIGN KEY ("submitted_by") REFERENCES "public"."profiles"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."insurance_claims"
    ADD CONSTRAINT "insurance_claims_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."insurance_copilot_audit"
    ADD CONSTRAINT "insurance_copilot_audit_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "public"."profiles"("id");



ALTER TABLE ONLY "public"."insurance_copilot_audit"
    ADD CONSTRAINT "insurance_copilot_audit_patient_id_fkey" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id");



ALTER TABLE ONLY "public"."insurance_copilot_audit"
    ADD CONSTRAINT "insurance_copilot_audit_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."insurance_coverage_checks"
    ADD CONSTRAINT "insurance_coverage_checks_checked_by_fkey" FOREIGN KEY ("checked_by") REFERENCES "public"."profiles"("id");



ALTER TABLE ONLY "public"."insurance_coverage_checks"
    ADD CONSTRAINT "insurance_coverage_checks_encounter_id_fkey" FOREIGN KEY ("encounter_id") REFERENCES "public"."encounters"("id");



ALTER TABLE ONLY "public"."insurance_coverage_checks"
    ADD CONSTRAINT "insurance_coverage_checks_patient_id_fkey" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id");



ALTER TABLE ONLY "public"."insurance_coverage_checks"
    ADD CONSTRAINT "insurance_coverage_checks_policy_id_fkey" FOREIGN KEY ("policy_id") REFERENCES "public"."insurance_policies"("id");



ALTER TABLE ONLY "public"."insurance_coverage_checks"
    ADD CONSTRAINT "insurance_coverage_checks_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."insurance_memberships"
    ADD CONSTRAINT "insurance_memberships_issuing_facility_id_fkey" FOREIGN KEY ("issuing_facility_id") REFERENCES "public"."tenants"("id");



ALTER TABLE ONLY "public"."insurance_memberships"
    ADD CONSTRAINT "insurance_memberships_payer_id_fkey" FOREIGN KEY ("payer_id") REFERENCES "public"."insurance_providers"("id");



ALTER TABLE ONLY "public"."insurance_memberships"
    ADD CONSTRAINT "insurance_memberships_person_id_fkey" FOREIGN KEY ("person_id") REFERENCES "public"."persons"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."insurance_policies"
    ADD CONSTRAINT "insurance_policies_patient_id_fkey" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id");



ALTER TABLE ONLY "public"."insurance_policies"
    ADD CONSTRAINT "insurance_policies_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."insurance_preauthorizations"
    ADD CONSTRAINT "insurance_preauthorizations_encounter_id_fkey" FOREIGN KEY ("encounter_id") REFERENCES "public"."encounters"("id");



ALTER TABLE ONLY "public"."insurance_preauthorizations"
    ADD CONSTRAINT "insurance_preauthorizations_patient_id_fkey" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id");



ALTER TABLE ONLY "public"."insurance_preauthorizations"
    ADD CONSTRAINT "insurance_preauthorizations_policy_id_fkey" FOREIGN KEY ("policy_id") REFERENCES "public"."insurance_policies"("id");



ALTER TABLE ONLY "public"."insurance_preauthorizations"
    ADD CONSTRAINT "insurance_preauthorizations_requested_by_fkey" FOREIGN KEY ("requested_by") REFERENCES "public"."profiles"("id");



ALTER TABLE ONLY "public"."insurance_preauthorizations"
    ADD CONSTRAINT "insurance_preauthorizations_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."insurance_providers"
    ADD CONSTRAINT "insurance_providers_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."intelligence_actions"
    ADD CONSTRAINT "intelligence_actions_recommendation_id_fkey" FOREIGN KEY ("recommendation_id") REFERENCES "public"."intelligence_recommendations"("id");



ALTER TABLE ONLY "public"."intelligence_actions"
    ADD CONSTRAINT "intelligence_actions_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id");



ALTER TABLE ONLY "public"."intelligence_recommendations"
    ADD CONSTRAINT "intelligence_recommendations_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id");



ALTER TABLE ONLY "public"."interop_connections"
    ADD CONSTRAINT "interop_connections_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."interop_messages"
    ADD CONSTRAINT "interop_messages_connection_id_fkey" FOREIGN KEY ("connection_id") REFERENCES "public"."interop_connections"("id");



ALTER TABLE ONLY "public"."interop_messages"
    ADD CONSTRAINT "interop_messages_person_id_fkey" FOREIGN KEY ("person_id") REFERENCES "public"."persons"("id");



ALTER TABLE ONLY "public"."interop_messages"
    ADD CONSTRAINT "interop_messages_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id");



ALTER TABLE ONLY "public"."inventory_items"
    ADD CONSTRAINT "inventory_items_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."inventory_items"
    ADD CONSTRAINT "inventory_items_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."lab_accession_counters"
    ADD CONSTRAINT "lab_accession_counters_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."lab_analyzer_messages"
    ADD CONSTRAINT "lab_analyzer_messages_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id");



ALTER TABLE ONLY "public"."lab_critical_acknowledgements"
    ADD CONSTRAINT "lab_critical_acknowledgements_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id");



ALTER TABLE ONLY "public"."lab_device_messages"
    ADD CONSTRAINT "lab_device_messages_device_id_fkey" FOREIGN KEY ("device_id") REFERENCES "public"."lab_devices"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."lab_device_messages"
    ADD CONSTRAINT "lab_device_messages_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."lab_device_test_mappings"
    ADD CONSTRAINT "lab_device_test_mappings_device_id_fkey" FOREIGN KEY ("device_id") REFERENCES "public"."lab_devices"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."lab_device_test_mappings"
    ADD CONSTRAINT "lab_device_test_mappings_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."lab_devices"
    ADD CONSTRAINT "lab_devices_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."lab_instrument_bridges"
    ADD CONSTRAINT "lab_instrument_bridges_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."lab_orders"
    ADD CONSTRAINT "lab_orders_encounter_id_fkey" FOREIGN KEY ("encounter_id") REFERENCES "public"."encounters"("id");



ALTER TABLE ONLY "public"."lab_orders"
    ADD CONSTRAINT "lab_orders_ordered_by_fkey" FOREIGN KEY ("ordered_by") REFERENCES "public"."profiles"("id");



ALTER TABLE ONLY "public"."lab_orders"
    ADD CONSTRAINT "lab_orders_patient_id_fkey" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id");



ALTER TABLE ONLY "public"."lab_orders"
    ADD CONSTRAINT "lab_orders_replaces_lab_order_id_fkey" FOREIGN KEY ("replaces_lab_order_id") REFERENCES "public"."lab_orders"("id");



ALTER TABLE ONLY "public"."lab_orders"
    ADD CONSTRAINT "lab_orders_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."lab_orders"
    ADD CONSTRAINT "lab_orders_verified_by_fkey" FOREIGN KEY ("verified_by") REFERENCES "public"."profiles"("id");



ALTER TABLE ONLY "public"."lab_reports"
    ADD CONSTRAINT "lab_reports_clinical_result_id_fkey" FOREIGN KEY ("clinical_result_id") REFERENCES "public"."lab_results"("id");



ALTER TABLE ONLY "public"."lab_reports"
    ADD CONSTRAINT "lab_reports_supersedes_report_id_fkey" FOREIGN KEY ("supersedes_report_id") REFERENCES "public"."lab_reports"("id");



ALTER TABLE ONLY "public"."lab_reports"
    ADD CONSTRAINT "lab_reports_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."lab_result_amendments"
    ADD CONSTRAINT "lab_result_amendments_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id");



ALTER TABLE ONLY "public"."lab_result_staging"
    ADD CONSTRAINT "lab_result_staging_device_id_fkey" FOREIGN KEY ("device_id") REFERENCES "public"."lab_devices"("id");



ALTER TABLE ONLY "public"."lab_result_staging"
    ADD CONSTRAINT "lab_result_staging_device_message_id_fkey" FOREIGN KEY ("device_message_id") REFERENCES "public"."lab_device_messages"("id");



ALTER TABLE ONLY "public"."lab_result_staging"
    ADD CONSTRAINT "lab_result_staging_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."lab_results"
    ADD CONSTRAINT "lab_results_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."lab_results"
    ADD CONSTRAINT "lab_results_encounter_id_fkey" FOREIGN KEY ("encounter_id") REFERENCES "public"."encounters"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."lab_results"
    ADD CONSTRAINT "lab_results_lab_technician_id_fkey" FOREIGN KEY ("lab_technician_id") REFERENCES "public"."profiles"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."lab_results"
    ADD CONSTRAINT "lab_results_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."lab_results"
    ADD CONSTRAINT "lab_results_lab_order_tenant_fkey" FOREIGN KEY ("lab_order_id", "tenant_id") REFERENCES "public"."lab_orders"("id", "tenant_id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."lab_results"
    ADD CONSTRAINT "lab_results_patient_id_fkey" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id");



ALTER TABLE ONLY "public"."lab_specimens"
    ADD CONSTRAINT "lab_specimens_patient_id_fkey" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id");



ALTER TABLE ONLY "public"."lab_specimens"
    ADD CONSTRAINT "lab_specimens_person_id_fkey" FOREIGN KEY ("person_id") REFERENCES "public"."persons"("id");



ALTER TABLE ONLY "public"."lab_specimens"
    ADD CONSTRAINT "lab_specimens_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id");



ALTER TABLE ONLY "public"."live_feed_sessions"
    ADD CONSTRAINT "live_feed_sessions_hospital_id_fkey" FOREIGN KEY ("hospital_id") REFERENCES "public"."hospitals"("id");



ALTER TABLE ONLY "public"."live_feed_sessions"
    ADD CONSTRAINT "live_feed_sessions_patient_id_fkey" FOREIGN KEY ("patient_id") REFERENCES "public"."patient_profiles"("id");



ALTER TABLE ONLY "public"."loinc_reference"
    ADD CONSTRAINT "loinc_reference_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."loinc_reference"
    ADD CONSTRAINT "loinc_reference_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."maternity_records"
    ADD CONSTRAINT "maternity_records_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."maternity_records"
    ADD CONSTRAINT "maternity_records_encounter_id_fkey" FOREIGN KEY ("encounter_id") REFERENCES "public"."encounters"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."maternity_records"
    ADD CONSTRAINT "maternity_records_patient_id_fkey" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."maternity_records"
    ADD CONSTRAINT "maternity_records_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."medical_devices"
    ADD CONSTRAINT "medical_devices_bed_id_fkey" FOREIGN KEY ("bed_id") REFERENCES "public"."hospital_beds"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."medical_devices"
    ADD CONSTRAINT "medical_devices_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."medical_devices"
    ADD CONSTRAINT "medical_devices_department_id_fkey" FOREIGN KEY ("department_id") REFERENCES "public"."departments"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."medical_devices"
    ADD CONSTRAINT "medical_devices_hospital_id_fkey" FOREIGN KEY ("hospital_id") REFERENCES "public"."hospitals"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."medical_devices"
    ADD CONSTRAINT "medical_devices_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."medication_safety_checks"
    ADD CONSTRAINT "medication_safety_checks_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."medication_safety_checks"
    ADD CONSTRAINT "medication_safety_checks_encounter_id_fkey" FOREIGN KEY ("encounter_id") REFERENCES "public"."encounters"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."medication_safety_checks"
    ADD CONSTRAINT "medication_safety_checks_hospital_id_fkey" FOREIGN KEY ("hospital_id") REFERENCES "public"."hospitals"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."medication_safety_checks"
    ADD CONSTRAINT "medication_safety_checks_override_by_fkey" FOREIGN KEY ("override_by") REFERENCES "public"."profiles"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."medication_safety_checks"
    ADD CONSTRAINT "medication_safety_checks_patient_id_fkey" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."medication_safety_checks"
    ADD CONSTRAINT "medication_safety_checks_pharmacist_id_fkey" FOREIGN KEY ("pharmacist_id") REFERENCES "public"."profiles"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."medication_safety_checks"
    ADD CONSTRAINT "medication_safety_checks_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."menstrual_cycles"
    ADD CONSTRAINT "menstrual_cycles_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."mfa_enrollments"
    ADD CONSTRAINT "mfa_enrollments_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."mfa_step_up_replays"
    ADD CONSTRAINT "mfa_step_up_replays_enrollment_id_fkey" FOREIGN KEY ("enrollment_id") REFERENCES "public"."mfa_enrollments"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."mfa_step_up_replays"
    ADD CONSTRAINT "mfa_step_up_replays_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "public"."synapse_sessions"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."mobile_push_tokens"
    ADD CONSTRAINT "mobile_push_tokens_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."mobile_push_tokens"
    ADD CONSTRAINT "mobile_push_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."nin_access_log"
    ADD CONSTRAINT "nin_access_log_accessed_by_fkey" FOREIGN KEY ("accessed_by") REFERENCES "public"."profiles"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."nin_access_log"
    ADD CONSTRAINT "nin_access_log_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."nin_access_log"
    ADD CONSTRAINT "nin_access_log_hospital_id_fkey" FOREIGN KEY ("hospital_id") REFERENCES "public"."hospitals"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."nin_access_log"
    ADD CONSTRAINT "nin_access_log_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."notifications"
    ADD CONSTRAINT "notifications_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."notifications"
    ADD CONSTRAINT "notifications_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."notifications"
    ADD CONSTRAINT "notifications_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."offline_mutation_outbox"
    ADD CONSTRAINT "offline_mutation_outbox_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "public"."profiles"("id");



ALTER TABLE ONLY "public"."offline_mutation_outbox"
    ADD CONSTRAINT "offline_mutation_outbox_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id");



ALTER TABLE ONLY "public"."offline_sync_queue"
    ADD CONSTRAINT "offline_sync_queue_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id");



ALTER TABLE ONLY "public"."offline_sync_queue"
    ADD CONSTRAINT "offline_sync_queue_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."order_items"
    ADD CONSTRAINT "order_items_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."order_items"
    ADD CONSTRAINT "order_items_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."order_items"
    ADD CONSTRAINT "order_items_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."order_items"
    ADD CONSTRAINT "order_items_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."order_mappings"
    ADD CONSTRAINT "order_mappings_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."order_mappings"
    ADD CONSTRAINT "order_mappings_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."orders"
    ADD CONSTRAINT "orders_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."orders"
    ADD CONSTRAINT "orders_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "public"."profiles"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."orders"
    ADD CONSTRAINT "orders_restaurant_id_fkey" FOREIGN KEY ("restaurant_id") REFERENCES "public"."restaurants"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."orders"
    ADD CONSTRAINT "orders_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."outbreak_alerts"
    ADD CONSTRAINT "outbreak_alerts_created_by_tenant_id_fkey" FOREIGN KEY ("created_by_tenant_id") REFERENCES "public"."tenants"("id");



ALTER TABLE ONLY "public"."outreach_campaigns"
    ADD CONSTRAINT "outreach_campaigns_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."profiles"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."outreach_campaigns"
    ADD CONSTRAINT "outreach_campaigns_hospital_id_fkey" FOREIGN KEY ("hospital_id") REFERENCES "public"."hospitals"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."outreach_campaigns"
    ADD CONSTRAINT "outreach_campaigns_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."partograph_records"
    ADD CONSTRAINT "partograph_records_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."passport_access_log"
    ADD CONSTRAINT "passport_access_log_accessed_by_hospital_id_fkey" FOREIGN KEY ("accessed_by_hospital_id") REFERENCES "public"."hospitals"("id");



ALTER TABLE ONLY "public"."passport_access_log"
    ADD CONSTRAINT "passport_access_log_accessed_by_user_id_fkey" FOREIGN KEY ("accessed_by_user_id") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."passport_share_tokens"
    ADD CONSTRAINT "passport_share_tokens_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."passport_share_tokens"
    ADD CONSTRAINT "passport_share_tokens_granted_to_hospital_id_fkey" FOREIGN KEY ("granted_to_hospital_id") REFERENCES "public"."hospitals"("id");



ALTER TABLE ONLY "public"."password_reset_tokens"
    ADD CONSTRAINT "password_reset_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."pathway_alerts"
    ADD CONSTRAINT "pathway_alerts_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."pathway_alerts"
    ADD CONSTRAINT "pathway_alerts_hospital_id_fkey" FOREIGN KEY ("hospital_id") REFERENCES "public"."hospitals"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."pathway_alerts"
    ADD CONSTRAINT "pathway_alerts_pathway_id_fkey" FOREIGN KEY ("pathway_id") REFERENCES "public"."patient_pathways"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."pathway_alerts"
    ADD CONSTRAINT "pathway_alerts_patient_id_fkey" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."pathway_alerts"
    ADD CONSTRAINT "pathway_alerts_resolved_by_fkey" FOREIGN KEY ("resolved_by") REFERENCES "public"."profiles"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."pathway_alerts"
    ADD CONSTRAINT "pathway_alerts_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."pathway_checklist_items"
    ADD CONSTRAINT "pathway_checklist_items_completed_by_fkey" FOREIGN KEY ("completed_by") REFERENCES "public"."profiles"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."pathway_checklist_items"
    ADD CONSTRAINT "pathway_checklist_items_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."pathway_checklist_items"
    ADD CONSTRAINT "pathway_checklist_items_pathway_id_fkey" FOREIGN KEY ("pathway_id") REFERENCES "public"."patient_pathways"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."pathway_checklist_items"
    ADD CONSTRAINT "pathway_checklist_items_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."pathway_overrides"
    ADD CONSTRAINT "pathway_overrides_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id");



ALTER TABLE ONLY "public"."patient_access_grants"
    ADD CONSTRAINT "patient_access_grants_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."patient_access_grants"
    ADD CONSTRAINT "patient_access_grants_granted_by_fkey" FOREIGN KEY ("granted_by") REFERENCES "public"."profiles"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."patient_access_grants"
    ADD CONSTRAINT "patient_access_grants_granted_to_fkey" FOREIGN KEY ("granted_to") REFERENCES "public"."profiles"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."patient_access_grants"
    ADD CONSTRAINT "patient_access_grants_patient_id_fkey" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."patient_access_grants"
    ADD CONSTRAINT "patient_access_grants_revoked_by_fkey" FOREIGN KEY ("revoked_by") REFERENCES "public"."profiles"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."patient_access_grants"
    ADD CONSTRAINT "patient_access_grants_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."patient_allergies"
    ADD CONSTRAINT "patient_allergies_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."patient_allergies"
    ADD CONSTRAINT "patient_allergies_hospital_id_fkey" FOREIGN KEY ("hospital_id") REFERENCES "public"."hospitals"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."patient_allergies"
    ADD CONSTRAINT "patient_allergies_patient_id_fkey" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."patient_allergies"
    ADD CONSTRAINT "patient_allergies_reported_by_fkey" FOREIGN KEY ("reported_by") REFERENCES "public"."profiles"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."patient_allergies"
    ADD CONSTRAINT "patient_allergies_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."patient_allergies"
    ADD CONSTRAINT "patient_allergies_verified_by_fkey" FOREIGN KEY ("verified_by") REFERENCES "public"."profiles"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."patient_billing"
    ADD CONSTRAINT "patient_billing_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."patient_billing"
    ADD CONSTRAINT "patient_billing_encounter_id_fkey" FOREIGN KEY ("encounter_id") REFERENCES "public"."encounters"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."patient_billing"
    ADD CONSTRAINT "patient_billing_patient_id_fkey" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."patient_billing"
    ADD CONSTRAINT "patient_billing_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."patient_clinical_patterns"
    ADD CONSTRAINT "patient_clinical_patterns_patient_id_fkey" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."patient_clinical_patterns"
    ADD CONSTRAINT "patient_clinical_patterns_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."patient_consents"
    ADD CONSTRAINT "patient_consents_collected_by_fkey" FOREIGN KEY ("collected_by") REFERENCES "public"."profiles"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."patient_consents"
    ADD CONSTRAINT "patient_consents_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."patient_consents"
    ADD CONSTRAINT "patient_consents_hospital_id_fkey" FOREIGN KEY ("hospital_id") REFERENCES "public"."hospitals"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."patient_consents"
    ADD CONSTRAINT "patient_consents_patient_id_fkey" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."patient_consents"
    ADD CONSTRAINT "patient_consents_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."patient_consents"
    ADD CONSTRAINT "patient_consents_witness_id_fkey" FOREIGN KEY ("witness_id") REFERENCES "public"."profiles"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."patient_history_queries"
    ADD CONSTRAINT "patient_history_queries_patient_id_fkey" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id");



ALTER TABLE ONLY "public"."patient_history_queries"
    ADD CONSTRAINT "patient_history_queries_queried_by_fkey" FOREIGN KEY ("queried_by") REFERENCES "public"."profiles"("id");



ALTER TABLE ONLY "public"."patient_history_queries"
    ADD CONSTRAINT "patient_history_queries_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id");



ALTER TABLE ONLY "public"."patient_intervention_outcomes"
    ADD CONSTRAINT "patient_intervention_outcomes_encounter_id_fkey" FOREIGN KEY ("encounter_id") REFERENCES "public"."encounters"("id");



ALTER TABLE ONLY "public"."patient_intervention_outcomes"
    ADD CONSTRAINT "patient_intervention_outcomes_patient_id_fkey" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."patient_intervention_outcomes"
    ADD CONSTRAINT "patient_intervention_outcomes_recorded_by_fkey" FOREIGN KEY ("recorded_by") REFERENCES "public"."profiles"("id");



ALTER TABLE ONLY "public"."patient_intervention_outcomes"
    ADD CONSTRAINT "patient_intervention_outcomes_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."patient_notes"
    ADD CONSTRAINT "patient_notes_clinician_id_fkey" FOREIGN KEY ("clinician_id") REFERENCES "public"."profiles"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."patient_notes"
    ADD CONSTRAINT "patient_notes_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."patient_notes"
    ADD CONSTRAINT "patient_notes_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."patient_pathways"
    ADD CONSTRAINT "patient_pathways_assigned_by_fkey" FOREIGN KEY ("assigned_by") REFERENCES "public"."profiles"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."patient_pathways"
    ADD CONSTRAINT "patient_pathways_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."patient_pathways"
    ADD CONSTRAINT "patient_pathways_encounter_id_fkey" FOREIGN KEY ("encounter_id") REFERENCES "public"."encounters"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."patient_pathways"
    ADD CONSTRAINT "patient_pathways_hospital_id_fkey" FOREIGN KEY ("hospital_id") REFERENCES "public"."hospitals"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."patient_pathways"
    ADD CONSTRAINT "patient_pathways_patient_id_fkey" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."patient_pathways"
    ADD CONSTRAINT "patient_pathways_template_id_fkey" FOREIGN KEY ("template_id") REFERENCES "public"."clinical_pathway_templates"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."patient_pathways"
    ADD CONSTRAINT "patient_pathways_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."patient_problem_list"
    ADD CONSTRAINT "patient_problem_list_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."profiles"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."patient_problem_list"
    ADD CONSTRAINT "patient_problem_list_hospital_id_fkey" FOREIGN KEY ("hospital_id") REFERENCES "public"."hospitals"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."patient_problem_list"
    ADD CONSTRAINT "patient_problem_list_patient_id_fkey" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."patient_problem_list"
    ADD CONSTRAINT "patient_problem_list_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."patient_profiles"
    ADD CONSTRAINT "patient_profiles_hospital_id_fkey" FOREIGN KEY ("hospital_id") REFERENCES "public"."hospitals"("id");



ALTER TABLE ONLY "public"."patient_safety_events"
    ADD CONSTRAINT "patient_safety_events_acknowledged_by_fkey" FOREIGN KEY ("acknowledged_by") REFERENCES "public"."profiles"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."patient_safety_events"
    ADD CONSTRAINT "patient_safety_events_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."patient_safety_events"
    ADD CONSTRAINT "patient_safety_events_encounter_id_fkey" FOREIGN KEY ("encounter_id") REFERENCES "public"."encounters"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."patient_safety_events"
    ADD CONSTRAINT "patient_safety_events_encounter_order_id_fkey" FOREIGN KEY ("encounter_order_id") REFERENCES "public"."encounter_orders"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."patient_safety_events"
    ADD CONSTRAINT "patient_safety_events_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."patient_sms_reminders"
    ADD CONSTRAINT "patient_sms_reminders_campaign_id_fkey" FOREIGN KEY ("campaign_id") REFERENCES "public"."outreach_campaigns"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."patient_sms_reminders"
    ADD CONSTRAINT "patient_sms_reminders_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."patient_sms_reminders"
    ADD CONSTRAINT "patient_sms_reminders_hospital_id_fkey" FOREIGN KEY ("hospital_id") REFERENCES "public"."hospitals"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."patient_sms_reminders"
    ADD CONSTRAINT "patient_sms_reminders_patient_id_fkey" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."patient_sms_reminders"
    ADD CONSTRAINT "patient_sms_reminders_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."patient_timeline_events"
    ADD CONSTRAINT "patient_timeline_events_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."profiles"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."patient_timeline_events"
    ADD CONSTRAINT "patient_timeline_events_hospital_id_fkey" FOREIGN KEY ("hospital_id") REFERENCES "public"."hospitals"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."patient_timeline_events"
    ADD CONSTRAINT "patient_timeline_events_patient_id_fkey" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."patient_timeline_events"
    ADD CONSTRAINT "patient_timeline_events_person_id_fkey" FOREIGN KEY ("person_id") REFERENCES "public"."persons"("id");



ALTER TABLE ONLY "public"."patient_timeline_events"
    ADD CONSTRAINT "patient_timeline_events_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."patient_timeline_pins"
    ADD CONSTRAINT "patient_timeline_pins_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."patient_timeline_pins"
    ADD CONSTRAINT "patient_timeline_pins_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "public"."patient_timeline_events"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."patient_timeline_pins"
    ADD CONSTRAINT "patient_timeline_pins_patient_id_fkey" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."patient_timeline_pins"
    ADD CONSTRAINT "patient_timeline_pins_pinned_by_fkey" FOREIGN KEY ("pinned_by") REFERENCES "public"."profiles"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."patient_timeline_pins"
    ADD CONSTRAINT "patient_timeline_pins_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."patient_vitals"
    ADD CONSTRAINT "patient_vitals_patient_id_fkey" FOREIGN KEY ("patient_id") REFERENCES "public"."patient_profiles"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."patients"
    ADD CONSTRAINT "patients_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."patients"
    ADD CONSTRAINT "patients_hospital_id_fkey" FOREIGN KEY ("hospital_id") REFERENCES "public"."hospitals"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."patients"
    ADD CONSTRAINT "patients_person_id_fkey" FOREIGN KEY ("person_id") REFERENCES "public"."persons"("id");



ALTER TABLE ONLY "public"."patients"
    ADD CONSTRAINT "patients_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."payer_contracts"
    ADD CONSTRAINT "payer_contracts_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."payer_contracts"
    ADD CONSTRAINT "payer_contracts_hospital_id_fkey" FOREIGN KEY ("hospital_id") REFERENCES "public"."hospitals"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."payer_contracts"
    ADD CONSTRAINT "payer_contracts_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."pediatric_growth_records"
    ADD CONSTRAINT "pediatric_growth_records_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."pediatric_growth_records"
    ADD CONSTRAINT "pediatric_growth_records_patient_id_fkey" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."pediatric_growth_records"
    ADD CONSTRAINT "pediatric_growth_records_recorded_by_fkey" FOREIGN KEY ("recorded_by") REFERENCES "public"."profiles"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."pediatric_growth_records"
    ADD CONSTRAINT "pediatric_growth_records_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."person_clinical_facts"
    ADD CONSTRAINT "person_clinical_facts_person_id_fkey" FOREIGN KEY ("person_id") REFERENCES "public"."persons"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."person_clinical_facts"
    ADD CONSTRAINT "person_clinical_facts_source_facility_id_fkey" FOREIGN KEY ("source_facility_id") REFERENCES "public"."tenants"("id");



ALTER TABLE ONLY "public"."person_clinical_facts"
    ADD CONSTRAINT "person_clinical_facts_superseded_by_fkey" FOREIGN KEY ("superseded_by") REFERENCES "public"."person_clinical_facts"("id");



ALTER TABLE ONLY "public"."person_clinical_facts"
    ADD CONSTRAINT "person_clinical_facts_verified_by_fkey" FOREIGN KEY ("verified_by") REFERENCES "public"."profiles"("id");



ALTER TABLE ONLY "public"."person_consent_events"
    ADD CONSTRAINT "person_consent_events_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "public"."profiles"("id");



ALTER TABLE ONLY "public"."person_consent_events"
    ADD CONSTRAINT "person_consent_events_consent_id_fkey" FOREIGN KEY ("consent_id") REFERENCES "public"."person_consents"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."person_consents"
    ADD CONSTRAINT "person_consents_collected_by_fkey" FOREIGN KEY ("collected_by") REFERENCES "public"."profiles"("id");



ALTER TABLE ONLY "public"."person_consents"
    ADD CONSTRAINT "person_consents_person_id_fkey" FOREIGN KEY ("person_id") REFERENCES "public"."persons"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."person_consents"
    ADD CONSTRAINT "person_consents_scope_facility_id_fkey" FOREIGN KEY ("scope_facility_id") REFERENCES "public"."tenants"("id");



ALTER TABLE ONLY "public"."person_consents"
    ADD CONSTRAINT "person_consents_scope_organization_id_fkey" FOREIGN KEY ("scope_organization_id") REFERENCES "public"."organizations"("id");



ALTER TABLE ONLY "public"."person_contacts"
    ADD CONSTRAINT "person_contacts_person_id_fkey" FOREIGN KEY ("person_id") REFERENCES "public"."persons"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."person_identifiers"
    ADD CONSTRAINT "person_identifiers_issuing_facility_id_fkey" FOREIGN KEY ("issuing_facility_id") REFERENCES "public"."tenants"("id");



ALTER TABLE ONLY "public"."person_identifiers"
    ADD CONSTRAINT "person_identifiers_issuing_organization_id_fkey" FOREIGN KEY ("issuing_organization_id") REFERENCES "public"."organizations"("id");



ALTER TABLE ONLY "public"."person_identifiers"
    ADD CONSTRAINT "person_identifiers_person_id_fkey" FOREIGN KEY ("person_id") REFERENCES "public"."persons"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."person_relationships"
    ADD CONSTRAINT "person_relationships_person_id_fkey" FOREIGN KEY ("person_id") REFERENCES "public"."persons"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."person_relationships"
    ADD CONSTRAINT "person_relationships_related_person_id_fkey" FOREIGN KEY ("related_person_id") REFERENCES "public"."persons"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."persons"
    ADD CONSTRAINT "persons_merged_into_person_id_fkey" FOREIGN KEY ("merged_into_person_id") REFERENCES "public"."persons"("id");



ALTER TABLE ONLY "public"."pharmacy_audit_logs"
    ADD CONSTRAINT "pharmacy_audit_logs_profile_id_fkey" FOREIGN KEY ("profile_id") REFERENCES "public"."profiles"("id");



ALTER TABLE ONLY "public"."pharmacy_audit_logs"
    ADD CONSTRAINT "pharmacy_audit_logs_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."pharmacy_cart_items"
    ADD CONSTRAINT "pharmacy_cart_items_batch_id_fkey" FOREIGN KEY ("batch_id") REFERENCES "public"."pharmacy_product_batches"("id");



ALTER TABLE ONLY "public"."pharmacy_cart_items"
    ADD CONSTRAINT "pharmacy_cart_items_cart_id_fkey" FOREIGN KEY ("cart_id") REFERENCES "public"."pharmacy_carts"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."pharmacy_cart_items"
    ADD CONSTRAINT "pharmacy_cart_items_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "public"."pharmacy_products"("id");



ALTER TABLE ONLY "public"."pharmacy_cart_items"
    ADD CONSTRAINT "pharmacy_cart_items_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."pharmacy_carts"
    ADD CONSTRAINT "pharmacy_carts_cashier_id_fkey" FOREIGN KEY ("cashier_id") REFERENCES "public"."profiles"("id");



ALTER TABLE ONLY "public"."pharmacy_carts"
    ADD CONSTRAINT "pharmacy_carts_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "public"."pharmacy_cashier_sessions"("id");



ALTER TABLE ONLY "public"."pharmacy_carts"
    ADD CONSTRAINT "pharmacy_carts_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."pharmacy_cashier_sessions"
    ADD CONSTRAINT "pharmacy_cashier_sessions_cashier_id_fkey" FOREIGN KEY ("cashier_id") REFERENCES "public"."profiles"("id");



ALTER TABLE ONLY "public"."pharmacy_cashier_sessions"
    ADD CONSTRAINT "pharmacy_cashier_sessions_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "public"."pharmacy_stores"("id");



ALTER TABLE ONLY "public"."pharmacy_cashier_sessions"
    ADD CONSTRAINT "pharmacy_cashier_sessions_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."pharmacy_clients"
    ADD CONSTRAINT "pharmacy_clients_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."pharmacy_credit_ledger"
    ADD CONSTRAINT "pharmacy_credit_ledger_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "public"."pharmacy_customers"("id");



ALTER TABLE ONLY "public"."pharmacy_credit_ledger"
    ADD CONSTRAINT "pharmacy_credit_ledger_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."pharmacy_credit_ledger"
    ADD CONSTRAINT "pharmacy_credit_ledger_transaction_id_fkey" FOREIGN KEY ("transaction_id") REFERENCES "public"."pharmacy_transactions"("id");



ALTER TABLE ONLY "public"."pharmacy_custom_domains"
    ADD CONSTRAINT "pharmacy_custom_domains_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."pharmacy_customers"
    ADD CONSTRAINT "pharmacy_customers_person_id_fkey" FOREIGN KEY ("person_id") REFERENCES "public"."persons"("id");



ALTER TABLE ONLY "public"."pharmacy_customers"
    ADD CONSTRAINT "pharmacy_customers_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."pharmacy_expenses"
    ADD CONSTRAINT "pharmacy_expenses_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."pharmacy_import_sessions"
    ADD CONSTRAINT "pharmacy_import_sessions_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."pharmacy_inquiries"
    ADD CONSTRAINT "pharmacy_inquiries_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."pharmacy_network_inventory"
    ADD CONSTRAINT "pharmacy_network_inventory_pharmacy_tenant_id_fkey" FOREIGN KEY ("pharmacy_tenant_id") REFERENCES "public"."tenants"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."pharmacy_notifications"
    ADD CONSTRAINT "pharmacy_notifications_profile_id_fkey" FOREIGN KEY ("profile_id") REFERENCES "public"."profiles"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."pharmacy_notifications"
    ADD CONSTRAINT "pharmacy_notifications_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."pharmacy_onboarding"
    ADD CONSTRAINT "pharmacy_onboarding_enrolled_by_fkey" FOREIGN KEY ("enrolled_by") REFERENCES "public"."profiles"("id");



ALTER TABLE ONLY "public"."pharmacy_onboarding"
    ADD CONSTRAINT "pharmacy_onboarding_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."pharmacy_order_items"
    ADD CONSTRAINT "pharmacy_order_items_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "public"."pharmacy_orders"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."pharmacy_order_items"
    ADD CONSTRAINT "pharmacy_order_items_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "public"."pharmacy_products"("id");



ALTER TABLE ONLY "public"."pharmacy_order_items"
    ADD CONSTRAINT "pharmacy_order_items_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."pharmacy_orders"
    ADD CONSTRAINT "pharmacy_orders_claimed_by_fkey" FOREIGN KEY ("claimed_by") REFERENCES "public"."profiles"("id");



ALTER TABLE ONLY "public"."pharmacy_orders"
    ADD CONSTRAINT "pharmacy_orders_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "public"."pharmacy_customers"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."pharmacy_orders"
    ADD CONSTRAINT "pharmacy_orders_patient_id_fkey" FOREIGN KEY ("patient_id") REFERENCES "public"."profiles"("id");



ALTER TABLE ONLY "public"."pharmacy_orders"
    ADD CONSTRAINT "pharmacy_orders_processed_by_fkey" FOREIGN KEY ("processed_by") REFERENCES "public"."profiles"("id");



ALTER TABLE ONLY "public"."pharmacy_orders"
    ADD CONSTRAINT "pharmacy_orders_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."pharmacy_pos_sale_items"
    ADD CONSTRAINT "pharmacy_pos_sale_items_batch_id_fkey" FOREIGN KEY ("batch_id") REFERENCES "public"."pharmacy_product_batches"("id");



ALTER TABLE ONLY "public"."pharmacy_pos_sale_items"
    ADD CONSTRAINT "pharmacy_pos_sale_items_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "public"."pharmacy_products"("id");



ALTER TABLE ONLY "public"."pharmacy_pos_sale_items"
    ADD CONSTRAINT "pharmacy_pos_sale_items_sale_id_fkey" FOREIGN KEY ("sale_id") REFERENCES "public"."pharmacy_pos_sales"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."pharmacy_pos_sale_items"
    ADD CONSTRAINT "pharmacy_pos_sale_items_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."pharmacy_pos_sales"
    ADD CONSTRAINT "pharmacy_pos_sales_cart_id_fkey" FOREIGN KEY ("cart_id") REFERENCES "public"."pharmacy_carts"("id");



ALTER TABLE ONLY "public"."pharmacy_pos_sales"
    ADD CONSTRAINT "pharmacy_pos_sales_cashier_id_fkey" FOREIGN KEY ("cashier_id") REFERENCES "public"."profiles"("id");



ALTER TABLE ONLY "public"."pharmacy_pos_sales"
    ADD CONSTRAINT "pharmacy_pos_sales_confirmed_by_fkey" FOREIGN KEY ("confirmed_by") REFERENCES "public"."profiles"("id");



ALTER TABLE ONLY "public"."pharmacy_pos_sales"
    ADD CONSTRAINT "pharmacy_pos_sales_patient_id_fkey" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id");



ALTER TABLE ONLY "public"."pharmacy_pos_sales"
    ADD CONSTRAINT "pharmacy_pos_sales_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "public"."pharmacy_cashier_sessions"("id");



ALTER TABLE ONLY "public"."pharmacy_pos_sales"
    ADD CONSTRAINT "pharmacy_pos_sales_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."pharmacy_product_batches"
    ADD CONSTRAINT "pharmacy_product_batches_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "public"."pharmacy_products"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."pharmacy_product_batches"
    ADD CONSTRAINT "pharmacy_product_batches_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."pharmacy_product_packages"
    ADD CONSTRAINT "pharmacy_product_packages_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "public"."pharmacy_products"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."pharmacy_product_packages"
    ADD CONSTRAINT "pharmacy_product_packages_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."pharmacy_products"
    ADD CONSTRAINT "pharmacy_products_supplier_id_fkey" FOREIGN KEY ("supplier_id") REFERENCES "public"."pharmacy_suppliers"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."pharmacy_products"
    ADD CONSTRAINT "pharmacy_products_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."pharmacy_profiles"
    ADD CONSTRAINT "pharmacy_profiles_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."pharmacy_purchase_order_items"
    ADD CONSTRAINT "pharmacy_purchase_order_items_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "public"."pharmacy_products"("id");



ALTER TABLE ONLY "public"."pharmacy_purchase_order_items"
    ADD CONSTRAINT "pharmacy_purchase_order_items_purchase_order_id_fkey" FOREIGN KEY ("purchase_order_id") REFERENCES "public"."pharmacy_purchase_orders"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."pharmacy_purchase_order_items"
    ADD CONSTRAINT "pharmacy_purchase_order_items_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."pharmacy_purchase_orders"
    ADD CONSTRAINT "pharmacy_purchase_orders_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."profiles"("id");



ALTER TABLE ONLY "public"."pharmacy_purchase_orders"
    ADD CONSTRAINT "pharmacy_purchase_orders_supplier_id_fkey" FOREIGN KEY ("supplier_id") REFERENCES "public"."pharmacy_suppliers"("id");



ALTER TABLE ONLY "public"."pharmacy_purchase_orders"
    ADD CONSTRAINT "pharmacy_purchase_orders_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."pharmacy_receipt_reprints"
    ADD CONSTRAINT "pharmacy_receipt_reprints_sale_id_fkey" FOREIGN KEY ("sale_id") REFERENCES "public"."pharmacy_pos_sales"("id");



ALTER TABLE ONLY "public"."pharmacy_refunds"
    ADD CONSTRAINT "pharmacy_refunds_approved_by_fkey" FOREIGN KEY ("approved_by") REFERENCES "public"."profiles"("id");



ALTER TABLE ONLY "public"."pharmacy_refunds"
    ADD CONSTRAINT "pharmacy_refunds_cashier_id_fkey" FOREIGN KEY ("cashier_id") REFERENCES "public"."profiles"("id");



ALTER TABLE ONLY "public"."pharmacy_refunds"
    ADD CONSTRAINT "pharmacy_refunds_sale_id_fkey" FOREIGN KEY ("sale_id") REFERENCES "public"."pharmacy_pos_sales"("id");



ALTER TABLE ONLY "public"."pharmacy_refunds"
    ADD CONSTRAINT "pharmacy_refunds_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."pharmacy_sale_idempotency"
    ADD CONSTRAINT "pharmacy_sale_idempotency_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."pharmacy_settings"
    ADD CONSTRAINT "pharmacy_settings_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."pharmacy_staff_permissions"
    ADD CONSTRAINT "pharmacy_staff_permissions_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."pharmacy_stock_adjustments"
    ADD CONSTRAINT "pharmacy_stock_adjustments_batch_id_fkey" FOREIGN KEY ("batch_id") REFERENCES "public"."pharmacy_product_batches"("id");



ALTER TABLE ONLY "public"."pharmacy_stock_adjustments"
    ADD CONSTRAINT "pharmacy_stock_adjustments_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."profiles"("id");



ALTER TABLE ONLY "public"."pharmacy_stock_adjustments"
    ADD CONSTRAINT "pharmacy_stock_adjustments_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "public"."pharmacy_products"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."pharmacy_stock_adjustments"
    ADD CONSTRAINT "pharmacy_stock_adjustments_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."pharmacy_stock_transfer_item_allocations"
    ADD CONSTRAINT "pharmacy_stock_transfer_item_allocations_transfer_item_id_fkey" FOREIGN KEY ("transfer_item_id") REFERENCES "public"."pharmacy_stock_transfer_items"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."pharmacy_stock_transfer_items"
    ADD CONSTRAINT "pharmacy_stock_transfer_items_transfer_id_fkey" FOREIGN KEY ("transfer_id") REFERENCES "public"."pharmacy_stock_transfers"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."pharmacy_stock_transfers"
    ADD CONSTRAINT "pharmacy_stock_transfers_received_by_fkey" FOREIGN KEY ("received_by") REFERENCES "public"."profiles"("id");



ALTER TABLE ONLY "public"."pharmacy_stock_transfers"
    ADD CONSTRAINT "pharmacy_stock_transfers_requested_by_fkey" FOREIGN KEY ("requested_by") REFERENCES "public"."profiles"("id");



ALTER TABLE ONLY "public"."pharmacy_stock_transfers"
    ADD CONSTRAINT "pharmacy_stock_transfers_shipped_by_fkey" FOREIGN KEY ("shipped_by") REFERENCES "public"."profiles"("id");



ALTER TABLE ONLY "public"."pharmacy_stock_transfers"
    ADD CONSTRAINT "pharmacy_stock_transfers_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id");



ALTER TABLE ONLY "public"."pharmacy_stores"
    ADD CONSTRAINT "pharmacy_stores_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."pharmacy_stores"
    ADD CONSTRAINT "pharmacy_stores_department_id_fkey" FOREIGN KEY ("department_id") REFERENCES "public"."departments"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."pharmacy_stores"
    ADD CONSTRAINT "pharmacy_stores_manager_id_fkey" FOREIGN KEY ("manager_id") REFERENCES "public"."profiles"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."pharmacy_stores"
    ADD CONSTRAINT "pharmacy_stores_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."pharmacy_suppliers"
    ADD CONSTRAINT "pharmacy_suppliers_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."pharmacy_transaction_edits"
    ADD CONSTRAINT "pharmacy_transaction_edits_edited_by_fkey" FOREIGN KEY ("edited_by") REFERENCES "public"."profiles"("id");



ALTER TABLE ONLY "public"."pharmacy_transaction_edits"
    ADD CONSTRAINT "pharmacy_transaction_edits_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."pharmacy_transaction_edits"
    ADD CONSTRAINT "pharmacy_transaction_edits_transaction_id_fkey" FOREIGN KEY ("transaction_id") REFERENCES "public"."pharmacy_transactions"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."pharmacy_transaction_items"
    ADD CONSTRAINT "pharmacy_transaction_items_batch_id_fkey" FOREIGN KEY ("batch_id") REFERENCES "public"."pharmacy_product_batches"("id");



ALTER TABLE ONLY "public"."pharmacy_transaction_items"
    ADD CONSTRAINT "pharmacy_transaction_items_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "public"."pharmacy_products"("id");



ALTER TABLE ONLY "public"."pharmacy_transaction_items"
    ADD CONSTRAINT "pharmacy_transaction_items_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."pharmacy_transaction_items"
    ADD CONSTRAINT "pharmacy_transaction_items_transaction_id_fkey" FOREIGN KEY ("transaction_id") REFERENCES "public"."pharmacy_transactions"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."pharmacy_transactions"
    ADD CONSTRAINT "pharmacy_transactions_cashier_id_fkey" FOREIGN KEY ("cashier_id") REFERENCES "public"."profiles"("id");



ALTER TABLE ONLY "public"."pharmacy_transactions"
    ADD CONSTRAINT "pharmacy_transactions_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "public"."pharmacy_customers"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."pharmacy_transactions"
    ADD CONSTRAINT "pharmacy_transactions_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."pharmacy_user_settings"
    ADD CONSTRAINT "pharmacy_user_settings_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."profiles"("id");



ALTER TABLE ONLY "public"."pharmacy_user_settings"
    ADD CONSTRAINT "pharmacy_user_settings_profile_id_fkey" FOREIGN KEY ("profile_id") REFERENCES "public"."profiles"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."pharmacy_user_settings"
    ADD CONSTRAINT "pharmacy_user_settings_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "public"."pharmacy_stores"("id");



ALTER TABLE ONLY "public"."pharmacy_user_settings"
    ADD CONSTRAINT "pharmacy_user_settings_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."phi_access_log"
    ADD CONSTRAINT "phi_access_log_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "public"."profiles"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."phi_access_log"
    ADD CONSTRAINT "phi_access_log_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."phi_access_log"
    ADD CONSTRAINT "phi_access_log_hospital_id_fkey" FOREIGN KEY ("hospital_id") REFERENCES "public"."hospitals"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."phi_access_log"
    ADD CONSTRAINT "phi_access_log_patient_id_fkey" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."phi_access_log"
    ADD CONSTRAINT "phi_access_log_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."plan_features"
    ADD CONSTRAINT "plan_features_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "public"."subscription_plans"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."platform_approvals"
    ADD CONSTRAINT "platform_approvals_requested_by_fkey" FOREIGN KEY ("requested_by") REFERENCES "public"."profiles"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."platform_approvals"
    ADD CONSTRAINT "platform_approvals_reviewed_by_fkey" FOREIGN KEY ("reviewed_by") REFERENCES "public"."profiles"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."platform_broadcasts"
    ADD CONSTRAINT "platform_broadcasts_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."profiles"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."platform_broadcasts"
    ADD CONSTRAINT "platform_broadcasts_previewed_by_fkey" FOREIGN KEY ("previewed_by") REFERENCES "public"."profiles"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."platform_broadcasts"
    ADD CONSTRAINT "platform_broadcasts_sent_by_fkey" FOREIGN KEY ("sent_by") REFERENCES "public"."profiles"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."platform_feature_flags"
    ADD CONSTRAINT "platform_feature_flags_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."profiles"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."platform_feature_flags"
    ADD CONSTRAINT "platform_feature_flags_updated_by_fkey" FOREIGN KEY ("updated_by") REFERENCES "public"."profiles"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."platform_incidents"
    ADD CONSTRAINT "platform_incidents_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "public"."profiles"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."platform_invitations"
    ADD CONSTRAINT "platform_invitations_invited_by_fkey" FOREIGN KEY ("invited_by") REFERENCES "public"."profiles"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."platform_invitations"
    ADD CONSTRAINT "platform_invitations_membership_id_fkey" FOREIGN KEY ("membership_id") REFERENCES "public"."platform_memberships"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."platform_memberships"
    ADD CONSTRAINT "platform_memberships_invited_by_fkey" FOREIGN KEY ("invited_by") REFERENCES "public"."profiles"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."platform_memberships"
    ADD CONSTRAINT "platform_memberships_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."platform_module_matrix"
    ADD CONSTRAINT "platform_module_matrix_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."platform_releases"
    ADD CONSTRAINT "platform_releases_approved_by_fkey" FOREIGN KEY ("approved_by") REFERENCES "public"."profiles"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."platform_releases"
    ADD CONSTRAINT "platform_releases_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."profiles"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."platform_support_sessions"
    ADD CONSTRAINT "platform_support_sessions_approved_by_fkey" FOREIGN KEY ("approved_by") REFERENCES "public"."profiles"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."platform_support_sessions"
    ADD CONSTRAINT "platform_support_sessions_requested_by_fkey" FOREIGN KEY ("requested_by") REFERENCES "public"."profiles"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."platform_support_sessions"
    ADD CONSTRAINT "platform_support_sessions_ticket_id_fkey" FOREIGN KEY ("ticket_id") REFERENCES "public"."platform_support_tickets"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."platform_support_tickets"
    ADD CONSTRAINT "platform_support_tickets_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."profiles"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."platform_support_tickets"
    ADD CONSTRAINT "platform_support_tickets_incident_id_fkey" FOREIGN KEY ("incident_id") REFERENCES "public"."platform_incidents"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."platform_support_tickets"
    ADD CONSTRAINT "platform_support_tickets_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "public"."profiles"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."platform_test_runs"
    ADD CONSTRAINT "platform_test_runs_started_by_fkey" FOREIGN KEY ("started_by") REFERENCES "public"."profiles"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."products"
    ADD CONSTRAINT "products_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."products"
    ADD CONSTRAINT "products_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."profiles"
    ADD CONSTRAINT "profiles_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."profiles"
    ADD CONSTRAINT "profiles_department_id_fkey" FOREIGN KEY ("department_id") REFERENCES "public"."departments"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."profiles"
    ADD CONSTRAINT "profiles_hospital_id_fkey" FOREIGN KEY ("hospital_id") REFERENCES "public"."hospitals"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."profiles"
    ADD CONSTRAINT "profiles_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."provider_verification_checks"
    ADD CONSTRAINT "provider_verification_checks_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."provider_verification_checks"
    ADD CONSTRAINT "provider_verification_checks_provider_id_fkey" FOREIGN KEY ("provider_id") REFERENCES "public"."telemedicine_providers"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."provider_verification_checks"
    ADD CONSTRAINT "provider_verification_checks_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."purchase_orders"
    ADD CONSTRAINT "purchase_orders_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."purchase_orders"
    ADD CONSTRAINT "purchase_orders_hospital_id_fkey" FOREIGN KEY ("hospital_id") REFERENCES "public"."hospitals"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."purchase_orders"
    ADD CONSTRAINT "purchase_orders_supplier_id_fkey" FOREIGN KEY ("supplier_id") REFERENCES "public"."suppliers"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."purchase_orders"
    ADD CONSTRAINT "purchase_orders_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."radiology_report_templates"
    ADD CONSTRAINT "radiology_report_templates_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."profiles"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."radiology_report_templates"
    ADD CONSTRAINT "radiology_report_templates_hospital_id_fkey" FOREIGN KEY ("hospital_id") REFERENCES "public"."hospitals"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."radiology_report_templates"
    ADD CONSTRAINT "radiology_report_templates_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."radiology_reports"
    ADD CONSTRAINT "radiology_reports_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."radiology_reports"
    ADD CONSTRAINT "radiology_reports_encounter_id_fkey" FOREIGN KEY ("encounter_id") REFERENCES "public"."encounters"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."radiology_reports"
    ADD CONSTRAINT "radiology_reports_radiographer_id_fkey" FOREIGN KEY ("radiographer_id") REFERENCES "public"."profiles"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."radiology_reports"
    ADD CONSTRAINT "radiology_reports_radiologist_id_fkey" FOREIGN KEY ("radiologist_id") REFERENCES "public"."profiles"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."radiology_reports"
    ADD CONSTRAINT "radiology_reports_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."reasoning_actions"
    ADD CONSTRAINT "reasoning_actions_hypothesis_id_fkey" FOREIGN KEY ("hypothesis_id") REFERENCES "public"."reasoning_hypotheses"("id");



ALTER TABLE ONLY "public"."reasoning_actions"
    ADD CONSTRAINT "reasoning_actions_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "public"."reasoning_sessions"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."reasoning_audit"
    ADD CONSTRAINT "reasoning_audit_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "public"."reasoning_sessions"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."reasoning_context_snapshots"
    ADD CONSTRAINT "reasoning_context_snapshots_encounter_id_fkey" FOREIGN KEY ("encounter_id") REFERENCES "public"."encounters"("id");



ALTER TABLE ONLY "public"."reasoning_context_snapshots"
    ADD CONSTRAINT "reasoning_context_snapshots_patient_id_fkey" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id");



ALTER TABLE ONLY "public"."reasoning_context_snapshots"
    ADD CONSTRAINT "reasoning_context_snapshots_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "public"."reasoning_sessions"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."reasoning_context_snapshots"
    ADD CONSTRAINT "reasoning_context_snapshots_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."reasoning_evidence_impact"
    ADD CONSTRAINT "reasoning_evidence_impact_evidence_id_fkey" FOREIGN KEY ("evidence_id") REFERENCES "public"."reasoning_evidence"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."reasoning_evidence_impact"
    ADD CONSTRAINT "reasoning_evidence_impact_hypothesis_id_fkey" FOREIGN KEY ("hypothesis_id") REFERENCES "public"."reasoning_hypotheses"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."reasoning_evidence_impact"
    ADD CONSTRAINT "reasoning_evidence_impact_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "public"."reasoning_sessions"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."reasoning_evidence"
    ADD CONSTRAINT "reasoning_evidence_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "public"."reasoning_sessions"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."reasoning_hypotheses"
    ADD CONSTRAINT "reasoning_hypotheses_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "public"."reasoning_sessions"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."reasoning_sessions"
    ADD CONSTRAINT "reasoning_sessions_encounter_id_fkey" FOREIGN KEY ("encounter_id") REFERENCES "public"."encounters"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."referral_requests"
    ADD CONSTRAINT "referral_requests_accepted_by_fkey" FOREIGN KEY ("accepted_by") REFERENCES "public"."profiles"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."referral_requests"
    ADD CONSTRAINT "referral_requests_bed_id_fkey" FOREIGN KEY ("bed_id") REFERENCES "public"."hospital_beds"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."referral_requests"
    ADD CONSTRAINT "referral_requests_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."referral_requests"
    ADD CONSTRAINT "referral_requests_from_hospital_id_fkey" FOREIGN KEY ("from_hospital_id") REFERENCES "public"."hospitals"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."referral_requests"
    ADD CONSTRAINT "referral_requests_patient_id_fkey" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."referral_requests"
    ADD CONSTRAINT "referral_requests_referred_by_fkey" FOREIGN KEY ("referred_by") REFERENCES "public"."profiles"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."referral_requests"
    ADD CONSTRAINT "referral_requests_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."referral_requests"
    ADD CONSTRAINT "referral_requests_to_hospital_id_fkey" FOREIGN KEY ("to_hospital_id") REFERENCES "public"."hospitals"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."refill_reminders"
    ADD CONSTRAINT "refill_reminders_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "public"."pharmacy_customers"("id");



ALTER TABLE ONLY "public"."refill_reminders"
    ADD CONSTRAINT "refill_reminders_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."renal_adjustments_catalog"
    ADD CONSTRAINT "renal_adjustments_catalog_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."renal_adjustments_catalog"
    ADD CONSTRAINT "renal_adjustments_catalog_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."restaurants"
    ADD CONSTRAINT "restaurants_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."restaurants"
    ADD CONSTRAINT "restaurants_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."role_capabilities"
    ADD CONSTRAINT "role_capabilities_capability_id_fkey" FOREIGN KEY ("capability_id") REFERENCES "public"."capabilities"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."rule_executions"
    ADD CONSTRAINT "rule_executions_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."rule_executions"
    ADD CONSTRAINT "rule_executions_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."scan_events"
    ADD CONSTRAINT "scan_events_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."scan_events"
    ADD CONSTRAINT "scan_events_device_id_fkey" FOREIGN KEY ("device_id") REFERENCES "public"."medical_devices"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."scan_events"
    ADD CONSTRAINT "scan_events_hospital_id_fkey" FOREIGN KEY ("hospital_id") REFERENCES "public"."hospitals"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."scan_events"
    ADD CONSTRAINT "scan_events_patient_id_fkey" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."scan_events"
    ADD CONSTRAINT "scan_events_scanned_by_fkey" FOREIGN KEY ("scanned_by") REFERENCES "public"."profiles"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."scan_events"
    ADD CONSTRAINT "scan_events_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."score_calculations"
    ADD CONSTRAINT "score_calculations_calculated_by_fkey" FOREIGN KEY ("calculated_by") REFERENCES "public"."profiles"("id");



ALTER TABLE ONLY "public"."score_calculations"
    ADD CONSTRAINT "score_calculations_encounter_id_fkey" FOREIGN KEY ("encounter_id") REFERENCES "public"."encounters"("id");



ALTER TABLE ONLY "public"."score_calculations"
    ADD CONSTRAINT "score_calculations_overridden_by_fkey" FOREIGN KEY ("overridden_by") REFERENCES "public"."profiles"("id");



ALTER TABLE ONLY "public"."score_calculations"
    ADD CONSTRAINT "score_calculations_patient_id_fkey" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id");



ALTER TABLE ONLY "public"."score_calculations"
    ADD CONSTRAINT "score_calculations_score_definition_code_fkey" FOREIGN KEY ("score_definition_code") REFERENCES "public"."score_definitions"("code");



ALTER TABLE ONLY "public"."score_calculations"
    ADD CONSTRAINT "score_calculations_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."sdg_indicators"
    ADD CONSTRAINT "sdg_indicators_hospital_id_fkey" FOREIGN KEY ("hospital_id") REFERENCES "public"."hospitals"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."sdg_reports"
    ADD CONSTRAINT "sdg_reports_generated_by_fkey" FOREIGN KEY ("generated_by") REFERENCES "public"."profiles"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."sdg_reports"
    ADD CONSTRAINT "sdg_reports_hospital_id_fkey" FOREIGN KEY ("hospital_id") REFERENCES "public"."hospitals"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."sentinel_alerts"
    ADD CONSTRAINT "sentinel_alerts_acknowledged_by_fkey" FOREIGN KEY ("acknowledged_by") REFERENCES "public"."profiles"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."sentinel_alerts"
    ADD CONSTRAINT "sentinel_alerts_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."sentinel_alerts"
    ADD CONSTRAINT "sentinel_alerts_hospital_id_fkey" FOREIGN KEY ("hospital_id") REFERENCES "public"."hospitals"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."sentinel_alerts"
    ADD CONSTRAINT "sentinel_alerts_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."service_catalog"
    ADD CONSTRAINT "service_catalog_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."service_catalog"
    ADD CONSTRAINT "service_catalog_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."staff_attendance"
    ADD CONSTRAINT "staff_attendance_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."staff_attendance"
    ADD CONSTRAINT "staff_attendance_hospital_id_fkey" FOREIGN KEY ("hospital_id") REFERENCES "public"."hospitals"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."staff_attendance"
    ADD CONSTRAINT "staff_attendance_profile_id_fkey" FOREIGN KEY ("profile_id") REFERENCES "public"."profiles"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."staff_attendance"
    ADD CONSTRAINT "staff_attendance_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."staff_invitations"
    ADD CONSTRAINT "staff_invitations_invited_by_fkey" FOREIGN KEY ("invited_by") REFERENCES "public"."profiles"("id");



ALTER TABLE ONLY "public"."staff_invitations"
    ADD CONSTRAINT "staff_invitations_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."staff_leave_requests"
    ADD CONSTRAINT "staff_leave_requests_approved_by_fkey" FOREIGN KEY ("approved_by") REFERENCES "public"."profiles"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."staff_leave_requests"
    ADD CONSTRAINT "staff_leave_requests_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."staff_leave_requests"
    ADD CONSTRAINT "staff_leave_requests_profile_id_fkey" FOREIGN KEY ("profile_id") REFERENCES "public"."profiles"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."staff_leave_requests"
    ADD CONSTRAINT "staff_leave_requests_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."staff_scope_assignments"
    ADD CONSTRAINT "staff_scope_assignments_department_id_fkey" FOREIGN KEY ("department_id") REFERENCES "public"."departments"("id");



ALTER TABLE ONLY "public"."staff_scope_assignments"
    ADD CONSTRAINT "staff_scope_assignments_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id");



ALTER TABLE ONLY "public"."staff_scope_assignments"
    ADD CONSTRAINT "staff_scope_assignments_profile_id_fkey" FOREIGN KEY ("profile_id") REFERENCES "public"."profiles"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."staff_scope_assignments"
    ADD CONSTRAINT "staff_scope_assignments_site_id_fkey" FOREIGN KEY ("site_id") REFERENCES "public"."pharmacy_stores"("id");



ALTER TABLE ONLY "public"."staff_scope_assignments"
    ADD CONSTRAINT "staff_scope_assignments_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id");



ALTER TABLE ONLY "public"."subscription_events"
    ADD CONSTRAINT "subscription_events_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."subscription_grants"
    ADD CONSTRAINT "subscription_grants_approved_by_fkey" FOREIGN KEY ("approved_by") REFERENCES "public"."profiles"("id");



ALTER TABLE ONLY "public"."subscription_grants"
    ADD CONSTRAINT "subscription_grants_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."profiles"("id");



ALTER TABLE ONLY "public"."subscription_grants"
    ADD CONSTRAINT "subscription_grants_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "public"."subscription_plans"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."subscription_grants"
    ADD CONSTRAINT "subscription_grants_revoked_by_fkey" FOREIGN KEY ("revoked_by") REFERENCES "public"."profiles"("id");



ALTER TABLE ONLY "public"."subscription_grants"
    ADD CONSTRAINT "subscription_grants_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."subscription_invoices"
    ADD CONSTRAINT "subscription_invoices_payment_id_fkey" FOREIGN KEY ("payment_id") REFERENCES "public"."subscription_payments"("id");



ALTER TABLE ONLY "public"."subscription_invoices"
    ADD CONSTRAINT "subscription_invoices_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "public"."subscription_plans"("id");



ALTER TABLE ONLY "public"."subscription_invoices"
    ADD CONSTRAINT "subscription_invoices_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."subscription_payments"
    ADD CONSTRAINT "subscription_payments_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "public"."subscription_plans"("id");



ALTER TABLE ONLY "public"."subscription_payments"
    ADD CONSTRAINT "subscription_payments_subscription_id_fkey" FOREIGN KEY ("subscription_id") REFERENCES "public"."tenant_subscriptions"("id");



ALTER TABLE ONLY "public"."subscription_payments"
    ADD CONSTRAINT "subscription_payments_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."suppliers"
    ADD CONSTRAINT "suppliers_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."suppliers"
    ADD CONSTRAINT "suppliers_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."support_ticket_events"
    ADD CONSTRAINT "support_ticket_events_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "public"."profiles"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."support_ticket_events"
    ADD CONSTRAINT "support_ticket_events_ticket_id_fkey" FOREIGN KEY ("ticket_id") REFERENCES "public"."support_tickets"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."support_tickets"
    ADD CONSTRAINT "support_tickets_assigned_to_fkey" FOREIGN KEY ("assigned_to") REFERENCES "public"."profiles"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."support_tickets"
    ADD CONSTRAINT "support_tickets_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."surgery_schedules"
    ADD CONSTRAINT "surgery_schedules_anesthesiologist_id_fkey" FOREIGN KEY ("anesthesiologist_id") REFERENCES "public"."profiles"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."surgery_schedules"
    ADD CONSTRAINT "surgery_schedules_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."surgery_schedules"
    ADD CONSTRAINT "surgery_schedules_hospital_id_fkey" FOREIGN KEY ("hospital_id") REFERENCES "public"."hospitals"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."surgery_schedules"
    ADD CONSTRAINT "surgery_schedules_patient_id_fkey" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."surgery_schedules"
    ADD CONSTRAINT "surgery_schedules_surgeon_id_fkey" FOREIGN KEY ("surgeon_id") REFERENCES "public"."profiles"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."surgery_schedules"
    ADD CONSTRAINT "surgery_schedules_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."synapse_domain_events"
    ADD CONSTRAINT "synapse_domain_events_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id");



ALTER TABLE ONLY "public"."synapse_sessions"
    ADD CONSTRAINT "synapse_sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "public"."profiles"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."synapse_simulation_runs"
    ADD CONSTRAINT "synapse_simulation_runs_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id");



ALTER TABLE ONLY "public"."sync_conflicts"
    ADD CONSTRAINT "sync_conflicts_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."sync_conflicts"
    ADD CONSTRAINT "sync_conflicts_hospital_id_fkey" FOREIGN KEY ("hospital_id") REFERENCES "public"."hospitals"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."sync_conflicts"
    ADD CONSTRAINT "sync_conflicts_resolved_by_fkey" FOREIGN KEY ("resolved_by") REFERENCES "public"."profiles"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."sync_conflicts"
    ADD CONSTRAINT "sync_conflicts_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."sync_idempotency_keys"
    ADD CONSTRAINT "sync_idempotency_keys_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."sync_idempotency_keys"
    ADD CONSTRAINT "sync_idempotency_keys_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."tele_sessions"
    ADD CONSTRAINT "tele_sessions_doctor_id_fkey" FOREIGN KEY ("doctor_id") REFERENCES "public"."profiles"("id");



ALTER TABLE ONLY "public"."tele_sessions"
    ADD CONSTRAINT "tele_sessions_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id");



ALTER TABLE ONLY "public"."telemedicine_appointments"
    ADD CONSTRAINT "telemedicine_appointments_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "public"."profiles"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."telemedicine_appointments"
    ADD CONSTRAINT "telemedicine_appointments_hospital_id_fkey" FOREIGN KEY ("hospital_id") REFERENCES "public"."hospitals"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."telemedicine_appointments"
    ADD CONSTRAINT "telemedicine_appointments_patient_id_fkey" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."telemedicine_appointments"
    ADD CONSTRAINT "telemedicine_appointments_provider_id_fkey" FOREIGN KEY ("provider_id") REFERENCES "public"."telemedicine_providers"("id") ON DELETE RESTRICT;



ALTER TABLE ONLY "public"."telemedicine_appointments"
    ADD CONSTRAINT "telemedicine_appointments_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."telemedicine_followups"
    ADD CONSTRAINT "telemedicine_followups_case_id_fkey" FOREIGN KEY ("case_id") REFERENCES "public"."telemedicine_intake_cases"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."telemedicine_followups"
    ADD CONSTRAINT "telemedicine_followups_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."telemedicine_followups"
    ADD CONSTRAINT "telemedicine_followups_hospital_id_fkey" FOREIGN KEY ("hospital_id") REFERENCES "public"."hospitals"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."telemedicine_followups"
    ADD CONSTRAINT "telemedicine_followups_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."telemedicine_frontdesk_queue"
    ADD CONSTRAINT "telemedicine_frontdesk_queue_case_id_fkey" FOREIGN KEY ("case_id") REFERENCES "public"."telemedicine_intake_cases"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."telemedicine_frontdesk_queue"
    ADD CONSTRAINT "telemedicine_frontdesk_queue_completed_by_fkey" FOREIGN KEY ("completed_by") REFERENCES "public"."profiles"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."telemedicine_frontdesk_queue"
    ADD CONSTRAINT "telemedicine_frontdesk_queue_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."telemedicine_frontdesk_queue"
    ADD CONSTRAINT "telemedicine_frontdesk_queue_hospital_id_fkey" FOREIGN KEY ("hospital_id") REFERENCES "public"."hospitals"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."telemedicine_frontdesk_queue"
    ADD CONSTRAINT "telemedicine_frontdesk_queue_patient_id_fkey" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."telemedicine_frontdesk_queue"
    ADD CONSTRAINT "telemedicine_frontdesk_queue_provider_id_fkey" FOREIGN KEY ("provider_id") REFERENCES "public"."telemedicine_providers"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."telemedicine_frontdesk_queue"
    ADD CONSTRAINT "telemedicine_frontdesk_queue_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."telemedicine_intake_cases"
    ADD CONSTRAINT "telemedicine_intake_cases_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."telemedicine_intake_cases"
    ADD CONSTRAINT "telemedicine_intake_cases_hospital_id_fkey" FOREIGN KEY ("hospital_id") REFERENCES "public"."hospitals"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."telemedicine_intake_cases"
    ADD CONSTRAINT "telemedicine_intake_cases_patient_id_fkey" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."telemedicine_intake_cases"
    ADD CONSTRAINT "telemedicine_intake_cases_provider_id_fkey" FOREIGN KEY ("provider_id") REFERENCES "public"."telemedicine_providers"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."telemedicine_intake_cases"
    ADD CONSTRAINT "telemedicine_intake_cases_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."telemedicine_intake_cases"
    ADD CONSTRAINT "telemedicine_intake_cases_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth"."users"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."telemedicine_intake_messages"
    ADD CONSTRAINT "telemedicine_intake_messages_case_id_fkey" FOREIGN KEY ("case_id") REFERENCES "public"."telemedicine_intake_cases"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."telemedicine_intake_messages"
    ADD CONSTRAINT "telemedicine_intake_messages_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."telemedicine_intake_messages"
    ADD CONSTRAINT "telemedicine_intake_messages_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."telemedicine_providers"
    ADD CONSTRAINT "telemedicine_providers_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."telemedicine_providers"
    ADD CONSTRAINT "telemedicine_providers_hospital_id_fkey" FOREIGN KEY ("hospital_id") REFERENCES "public"."hospitals"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."telemedicine_providers"
    ADD CONSTRAINT "telemedicine_providers_profile_id_fkey" FOREIGN KEY ("profile_id") REFERENCES "public"."profiles"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."telemedicine_providers"
    ADD CONSTRAINT "telemedicine_providers_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."telemedicine_providers"
    ADD CONSTRAINT "telemedicine_providers_verified_by_fkey" FOREIGN KEY ("verified_by") REFERENCES "public"."profiles"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."telemedicine_session_events"
    ADD CONSTRAINT "telemedicine_session_events_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "public"."profiles"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."telemedicine_session_events"
    ADD CONSTRAINT "telemedicine_session_events_appointment_id_fkey" FOREIGN KEY ("appointment_id") REFERENCES "public"."telemedicine_appointments"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."telemedicine_session_events"
    ADD CONSTRAINT "telemedicine_session_events_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."telemedicine_session_events"
    ADD CONSTRAINT "telemedicine_session_events_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."telemedicine_staff_alerts"
    ADD CONSTRAINT "telemedicine_staff_alerts_acknowledged_by_fkey" FOREIGN KEY ("acknowledged_by") REFERENCES "public"."profiles"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."telemedicine_staff_alerts"
    ADD CONSTRAINT "telemedicine_staff_alerts_case_id_fkey" FOREIGN KEY ("case_id") REFERENCES "public"."telemedicine_intake_cases"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."telemedicine_staff_alerts"
    ADD CONSTRAINT "telemedicine_staff_alerts_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."telemedicine_staff_alerts"
    ADD CONSTRAINT "telemedicine_staff_alerts_hospital_id_fkey" FOREIGN KEY ("hospital_id") REFERENCES "public"."hospitals"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."telemedicine_staff_alerts"
    ADD CONSTRAINT "telemedicine_staff_alerts_patient_id_fkey" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."telemedicine_staff_alerts"
    ADD CONSTRAINT "telemedicine_staff_alerts_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."telemedicine_voice_memos"
    ADD CONSTRAINT "telemedicine_voice_memos_case_id_fkey" FOREIGN KEY ("case_id") REFERENCES "public"."telemedicine_intake_cases"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."telemedicine_voice_memos"
    ADD CONSTRAINT "telemedicine_voice_memos_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."telemedicine_voice_memos"
    ADD CONSTRAINT "telemedicine_voice_memos_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."telemedicine_voice_memos"
    ADD CONSTRAINT "telemedicine_voice_memos_uploaded_by_fkey" FOREIGN KEY ("uploaded_by") REFERENCES "public"."profiles"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."tenant_domains"
    ADD CONSTRAINT "tenant_domains_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."tenant_domains"
    ADD CONSTRAINT "tenant_domains_hospital_id_fkey" FOREIGN KEY ("hospital_id") REFERENCES "public"."hospitals"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."tenant_domains"
    ADD CONSTRAINT "tenant_domains_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."tenant_feature_overrides"
    ADD CONSTRAINT "tenant_feature_overrides_granted_by_fkey" FOREIGN KEY ("granted_by") REFERENCES "public"."profiles"("id");



ALTER TABLE ONLY "public"."tenant_feature_overrides"
    ADD CONSTRAINT "tenant_feature_overrides_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."tenant_logging_policies"
    ADD CONSTRAINT "tenant_logging_policies_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."tenant_logging_policies"
    ADD CONSTRAINT "tenant_logging_policies_hospital_id_fkey" FOREIGN KEY ("hospital_id") REFERENCES "public"."hospitals"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."tenant_logging_policies"
    ADD CONSTRAINT "tenant_logging_policies_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."tenant_provisioning_jobs"
    ADD CONSTRAINT "tenant_provisioning_jobs_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."tenant_provisioning_jobs"
    ADD CONSTRAINT "tenant_provisioning_jobs_hospital_id_fkey" FOREIGN KEY ("hospital_id") REFERENCES "public"."hospitals"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."tenant_provisioning_jobs"
    ADD CONSTRAINT "tenant_provisioning_jobs_requested_by_fkey" FOREIGN KEY ("requested_by") REFERENCES "public"."profiles"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."tenant_provisioning_jobs"
    ADD CONSTRAINT "tenant_provisioning_jobs_tenant_domain_id_fkey" FOREIGN KEY ("tenant_domain_id") REFERENCES "public"."tenant_domains"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."tenant_provisioning_jobs"
    ADD CONSTRAINT "tenant_provisioning_jobs_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."tenant_subscriptions"
    ADD CONSTRAINT "tenant_subscriptions_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "public"."subscription_plans"("id");



ALTER TABLE ONLY "public"."tenant_subscriptions"
    ADD CONSTRAINT "tenant_subscriptions_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."tenants"
    ADD CONSTRAINT "tenants_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id");



ALTER TABLE ONLY "public"."tenants"
    ADD CONSTRAINT "tenants_parent_tenant_id_fkey" FOREIGN KEY ("parent_tenant_id") REFERENCES "public"."tenants"("id");



ALTER TABLE ONLY "public"."ucg_guidelines"
    ADD CONSTRAINT "ucg_guidelines_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."ucg_guidelines"
    ADD CONSTRAINT "ucg_guidelines_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."verification_documents"
    ADD CONSTRAINT "verification_documents_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."verification_documents"
    ADD CONSTRAINT "verification_documents_profile_id_fkey" FOREIGN KEY ("profile_id") REFERENCES "public"."profiles"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."verification_documents"
    ADD CONSTRAINT "verification_documents_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."visitor_log"
    ADD CONSTRAINT "visitor_log_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."vitals"
    ADD CONSTRAINT "vitals_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "auth"."users"("id");



ALTER TABLE ONLY "public"."vitals"
    ADD CONSTRAINT "vitals_encounter_id_fkey" FOREIGN KEY ("encounter_id") REFERENCES "public"."encounters"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."vitals"
    ADD CONSTRAINT "vitals_recorded_by_fkey" FOREIGN KEY ("recorded_by") REFERENCES "public"."profiles"("id") ON DELETE SET NULL;



ALTER TABLE ONLY "public"."vitals"
    ADD CONSTRAINT "vitals_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE CASCADE;



ALTER TABLE ONLY "public"."wards"
    ADD CONSTRAINT "wards_hospital_id_fkey" FOREIGN KEY ("hospital_id") REFERENCES "public"."hospitals"("id") ON DELETE CASCADE;



CREATE POLICY "Admins can manage all documents" ON "public"."verification_documents" USING ("public"."is_admin"("auth"."uid"())) WITH CHECK ("public"."is_admin"("auth"."uid"()));



CREATE POLICY "Admins full access cylinders" ON "public"."gas_cylinders" USING ((EXISTS ( SELECT 1
   FROM "public"."profiles"
  WHERE (("profiles"."id" = "auth"."uid"()) AND ("profiles"."is_admin" = true)))));



CREATE POLICY "Admins full access items" ON "public"."order_items" USING ((EXISTS ( SELECT 1
   FROM "public"."profiles"
  WHERE (("profiles"."id" = "auth"."uid"()) AND ("profiles"."is_admin" = true)))));



CREATE POLICY "Admins full access orders" ON "public"."orders" USING ((EXISTS ( SELECT 1
   FROM "public"."profiles"
  WHERE (("profiles"."id" = "auth"."uid"()) AND ("profiles"."is_admin" = true)))));



CREATE POLICY "Admins full access products" ON "public"."products" USING ((EXISTS ( SELECT 1
   FROM "public"."profiles"
  WHERE (("profiles"."id" = "auth"."uid"()) AND ("profiles"."is_admin" = true)))));



CREATE POLICY "Admins full access restaurants" ON "public"."restaurants" USING ((EXISTS ( SELECT 1
   FROM "public"."profiles"
  WHERE (("profiles"."id" = "auth"."uid"()) AND ("profiles"."is_admin" = true)))));



CREATE POLICY "Own sync queue" ON "public"."offline_sync_queue" USING ((("tenant_id" = "public"."current_tenant_id"()) AND ("user_id" = "auth"."uid"())));



CREATE POLICY "Platform admin manage cross tenant access" ON "public"."cross_tenant_access" USING ("public"."is_platform_admin"());



CREATE POLICY "Platform admin manage outbreak alerts" ON "public"."outbreak_alerts" USING ("public"."is_platform_admin"());



CREATE POLICY "Public read outbreak alerts" ON "public"."outbreak_alerts" FOR SELECT USING (("is_active" = true));



CREATE POLICY "Public read products" ON "public"."products" FOR SELECT USING (true);



CREATE POLICY "Public read restaurants" ON "public"."restaurants" FOR SELECT USING (true);



CREATE POLICY "Referral insert" ON "public"."facility_referrals" FOR INSERT WITH CHECK (("from_tenant_id" = "public"."current_tenant_id"()));



CREATE POLICY "Referral tenant access" ON "public"."facility_referrals" FOR SELECT USING ((("from_tenant_id" = "public"."current_tenant_id"()) OR ("to_tenant_id" = "public"."current_tenant_id"()) OR "public"."is_platform_admin"()));



CREATE POLICY "Referral update" ON "public"."facility_referrals" FOR UPDATE USING ((("from_tenant_id" = "public"."current_tenant_id"()) OR ("to_tenant_id" = "public"."current_tenant_id"())));



CREATE POLICY "Rider access" ON "public"."orders" FOR SELECT USING (true);



CREATE POLICY "Rider update" ON "public"."orders" FOR UPDATE USING (true);



CREATE POLICY "Score definitions public read" ON "public"."score_definitions" FOR SELECT USING (("is_active" = true));



CREATE POLICY "Subscription grants platform writes" ON "public"."subscription_grants" USING ("public"."is_platform_admin"()) WITH CHECK ("public"."is_platform_admin"());



CREATE POLICY "Subscription grants tenant isolation" ON "public"."subscription_grants" FOR SELECT USING ((("tenant_id" = "public"."current_tenant_id"()) OR "public"."is_platform_admin"()));



CREATE POLICY "Tele session tenant access" ON "public"."tele_sessions" USING ((("tenant_id" = "public"."current_tenant_id"()) OR "public"."is_platform_admin"()));



CREATE POLICY "Tenant invitation access" ON "public"."staff_invitations" USING ((("tenant_id" = "public"."current_tenant_id"()) OR "public"."is_platform_admin"()));



CREATE POLICY "Tenant isolation for clinical notes" ON "public"."clinical_notes" USING ((("tenant_id" = "public"."current_tenant_id"()) OR "public"."is_platform_admin"()));



CREATE POLICY "Tenant isolation for drug inventory" ON "public"."drug_inventory" USING ((("tenant_id" = "public"."current_tenant_id"()) OR "public"."is_platform_admin"()));



CREATE POLICY "Tenant isolation for embeddings" ON "public"."clinical_note_embeddings" USING ((("tenant_id" = "public"."current_tenant_id"()) OR "public"."is_platform_admin"()));



CREATE POLICY "Tenant isolation for history queries" ON "public"."patient_history_queries" USING ((("tenant_id" = "public"."current_tenant_id"()) OR "public"."is_platform_admin"()));



CREATE POLICY "Tenant isolation for instrument bridges" ON "public"."lab_instrument_bridges" USING ((("tenant_id" = "public"."current_tenant_id"()) OR "public"."is_platform_admin"()));



CREATE POLICY "Tenant isolation for insurance providers" ON "public"."insurance_providers" USING ((("tenant_id" = "public"."current_tenant_id"()) OR "public"."is_platform_admin"()));



CREATE POLICY "Tenant isolation for lab orders" ON "public"."lab_orders" USING ((("tenant_id" = "public"."current_tenant_id"()) OR "public"."is_platform_admin"()));



CREATE POLICY "Tenant isolation for lab reports" ON "public"."lab_reports" USING ((("tenant_id" = "public"."current_tenant_id"()) OR "public"."is_platform_admin"())) WITH CHECK ((("tenant_id" = "public"."current_tenant_id"()) OR "public"."is_platform_admin"()));



CREATE POLICY "Tenant isolation for scores" ON "public"."score_calculations" USING ((("tenant_id" = "public"."current_tenant_id"()) OR "public"."is_platform_admin"()));



CREATE POLICY "Users can create own orders" ON "public"."orders" FOR INSERT WITH CHECK (("auth"."uid"() = "customer_id"));



CREATE POLICY "Users can insert own app vitals" ON "public"."app_vitals" FOR INSERT WITH CHECK (("auth"."uid"() = "patient_id"));



CREATE POLICY "Users can insert their own calls" ON "public"."calls" FOR INSERT WITH CHECK (("auth"."uid"() = "caller_id"));



CREATE POLICY "Users can see own app vitals" ON "public"."app_vitals" FOR SELECT USING (("auth"."uid"() = "patient_id"));



CREATE POLICY "Users can see their own calls" ON "public"."calls" FOR SELECT USING ((("auth"."uid"() = "caller_id") OR ("auth"."uid"() = "callee_id")));



CREATE POLICY "Users can update their own calls" ON "public"."calls" FOR UPDATE USING ((("auth"."uid"() = "caller_id") OR ("auth"."uid"() = "callee_id")));



CREATE POLICY "Users can upload their own documents" ON "public"."verification_documents" FOR INSERT WITH CHECK (("auth"."uid"() = "profile_id"));



CREATE POLICY "Users can view own order items" ON "public"."order_items" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM "public"."orders"
  WHERE (("orders"."id" = "order_items"."order_id") AND ("orders"."customer_id" = "auth"."uid"())))));



CREATE POLICY "Users can view own orders" ON "public"."orders" FOR SELECT USING (("auth"."uid"() = "customer_id"));



CREATE POLICY "Users can view their own documents" ON "public"."verification_documents" FOR SELECT USING (("auth"."uid"() = "profile_id"));



CREATE POLICY "Users view own cylinders" ON "public"."gas_cylinders" FOR SELECT USING (("auth"."uid"() = "customer_id"));



CREATE POLICY "access_grants_admin_all" ON "public"."patient_access_grants" USING ((("auth"."role"() = 'service_role'::"text") OR (EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."id" = "auth"."uid"()) AND ("p"."role" = 'admin'::"text")))))) WITH CHECK ((("auth"."role"() = 'service_role'::"text") OR (EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."id" = "auth"."uid"()) AND ("p"."role" = 'admin'::"text"))))));



ALTER TABLE "public"."aefi_reports" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."ai_health_chats" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."allergens_catalog" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "allergens_catalog_read_authenticated" ON "public"."allergens_catalog" FOR SELECT USING (("auth"."role"() = 'authenticated'::"text"));



CREATE POLICY "allergies_staff_all" ON "public"."patient_allergies" USING ((("auth"."role"() = 'service_role'::"text") OR (EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."id" = "auth"."uid"()) AND ("p"."role" = ANY (ARRAY['admin'::"text", 'doctor'::"text", 'nurse'::"text", 'pharmacist'::"text"]))))))) WITH CHECK ((("auth"."role"() = 'service_role'::"text") OR (EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."id" = "auth"."uid"()) AND ("p"."role" = ANY (ARRAY['admin'::"text", 'doctor'::"text", 'nurse'::"text", 'pharmacist'::"text"])))))));



CREATE POLICY "anon_insert" ON "public"."apk_waitlist" FOR INSERT WITH CHECK (true);



CREATE POLICY "anon_validate" ON "public"."passport_share_tokens" FOR SELECT USING ((("is_revoked" = false) AND ("expires_at" > "now"()) AND ("use_count" < "max_uses")));



CREATE POLICY "anyone can submit a lead" ON "public"."professional_leads" FOR INSERT TO "authenticated", "anon" WITH CHECK (true);



ALTER TABLE "public"."apk_waitlist" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "app_manage_hospitals_admin" ON "public"."hospitals" USING ("public"."is_admin"("auth"."uid"())) WITH CHECK ("public"."is_admin"("auth"."uid"()));



CREATE POLICY "app_read_hospitals" ON "public"."hospitals" FOR SELECT USING (("auth"."role"() = 'authenticated'::"text"));











































































ALTER TABLE "public"."app_vitals" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."audit_events" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."audit_log" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "audit_log_admin_read" ON "public"."audit_log" FOR SELECT USING ("public"."is_admin"("auth"."uid"()));



CREATE POLICY "audit_log_service_insert" ON "public"."audit_log" FOR INSERT TO "service_role" WITH CHECK (true);



ALTER TABLE "public"."auth_otps" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "auth_otps_own_read" ON "public"."auth_otps" FOR SELECT USING (("target" = ( SELECT "profiles"."email"
   FROM "public"."profiles"
  WHERE ("profiles"."id" = "auth"."uid"())
 LIMIT 1)));



CREATE POLICY "avail_log_doctor_read" ON "public"."doctor_availability_log" FOR SELECT USING (((EXISTS ( SELECT 1
   FROM "public"."telemedicine_providers" "tp"
  WHERE (("tp"."id" = "doctor_availability_log"."provider_id") AND ("tp"."profile_id" = "auth"."uid"())))) OR (( SELECT "profiles"."role"
   FROM "public"."profiles"
  WHERE ("profiles"."id" = "auth"."uid"())) = ANY (ARRAY['admin'::"text", 'super_admin'::"text", 'overall_admin'::"text", 'platform_admin'::"text", 'hospital_admin'::"text"]))));



CREATE POLICY "avail_log_service_write" ON "public"."doctor_availability_log" USING (("auth"."role"() = 'service_role'::"text"));



ALTER TABLE "public"."bed_assignments" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "bed_assignments_hospital_isolation" ON "public"."bed_assignments" USING (("bed_id" IN ( SELECT "hospital_beds"."id"
   FROM "public"."hospital_beds"
  WHERE ("hospital_beds"."hospital_id" = ( SELECT "profiles"."hospital_id"
           FROM "public"."profiles"
          WHERE ("profiles"."id" = "auth"."uid"())
         LIMIT 1)))));



CREATE POLICY "beds_hospital_isolation" ON "public"."hospital_beds" USING (("hospital_id" = ( SELECT "profiles"."hospital_id"
   FROM "public"."profiles"
  WHERE ("profiles"."id" = "auth"."uid"())
 LIMIT 1)));



ALTER TABLE "public"."beta_access_requests" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "beta_access_requests_insert_anon" ON "public"."beta_access_requests" FOR INSERT WITH CHECK (true);



CREATE POLICY "beta_access_requests_read_authenticated" ON "public"."beta_access_requests" FOR SELECT USING (("auth"."role"() = 'authenticated'::"text"));



ALTER TABLE "public"."billing_invoices" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."billing_line_items" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."billing_payments" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "billing_payments_tenant_isolation" ON "public"."billing_payments" USING (("tenant_id" = "public"."current_tenant_id"())) WITH CHECK (("tenant_id" = "public"."current_tenant_id"()));



ALTER TABLE "public"."blood_deferrals" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."blood_donation_profiles" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."blood_donations" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."body_register" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "body_register_tenant" ON "public"."body_register" USING ((("tenant_id" = "public"."current_tenant_id"()) OR "public"."is_platform_admin"()));



CREATE POLICY "breaches_admin_all" ON "public"."data_breach_incidents" USING ((("auth"."role"() = 'service_role'::"text") OR (EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."id" = "auth"."uid"()) AND ("p"."role" = 'admin'::"text")))))) WITH CHECK ((("auth"."role"() = 'service_role'::"text") OR (EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."id" = "auth"."uid"()) AND ("p"."role" = 'admin'::"text"))))));



ALTER TABLE "public"."calls" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "campaigns_staff_all" ON "public"."outreach_campaigns" USING ((("auth"."role"() = 'service_role'::"text") OR (EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."id" = "auth"."uid"()) AND ("p"."hospital_id" = "p"."hospital_id")))))) WITH CHECK ((("auth"."role"() = 'service_role'::"text") OR (EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."id" = "auth"."uid"()) AND ("p"."hospital_id" = "p"."hospital_id") AND ("p"."role" = ANY (ARRAY['admin'::"text", 'nurse'::"text", 'doctor'::"text"])))))));



CREATE POLICY "cap_read_authenticated" ON "public"."capabilities" FOR SELECT USING (("auth"."role"() = 'authenticated'::"text"));



ALTER TABLE "public"."capabilities" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."care_team_handovers" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."cds_alerts" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."cds_rules" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "chw_hospital_staff_all" ON "public"."community_health_workers" USING ((("auth"."role"() = 'service_role'::"text") OR (EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."id" = "auth"."uid"()) AND ("p"."hospital_id" = "p"."hospital_id")))))) WITH CHECK ((("auth"."role"() = 'service_role'::"text") OR (EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."id" = "auth"."uid"()) AND ("p"."hospital_id" = "p"."hospital_id") AND ("p"."role" = ANY (ARRAY['admin'::"text", 'nurse'::"text", 'doctor'::"text"])))))));



ALTER TABLE "public"."chw_visits" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "chw_visits_staff_all" ON "public"."chw_visits" USING ((("auth"."role"() = 'service_role'::"text") OR (EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."id" = "auth"."uid"()) AND ("p"."hospital_id" = "p"."hospital_id")))))) WITH CHECK ((("auth"."role"() = 'service_role'::"text") OR (EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."id" = "auth"."uid"()) AND ("p"."hospital_id" = "p"."hospital_id"))))));



ALTER TABLE "public"."claim_line_items" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."claim_resubmissions" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "claims_billing_staff_all" ON "public"."insurance_claims" USING ((("auth"."role"() = 'service_role'::"text") OR (EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."id" = "auth"."uid"()) AND ("p"."hospital_id" = "p"."hospital_id") AND ("p"."role" = ANY (ARRAY['admin'::"text", 'billing_officer'::"text"]))))))) WITH CHECK ((("auth"."role"() = 'service_role'::"text") OR (EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."id" = "auth"."uid"()) AND ("p"."hospital_id" = "p"."hospital_id") AND ("p"."role" = ANY (ARRAY['admin'::"text", 'billing_officer'::"text"])))))));



ALTER TABLE "public"."clinical_intelligence_decisions" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."clinical_intelligence_sessions" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."clinical_note_embeddings" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."clinical_notes" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."clinical_pathway_templates" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."clinical_prescriptions" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "clinical_prescriptions_tenant_isolation" ON "public"."clinical_prescriptions" USING ((("tenant_id" = "public"."current_tenant_id"()) OR "public"."is_platform_admin"())) WITH CHECK ((("tenant_id" = "public"."current_tenant_id"()) OR "public"."is_platform_admin"()));



ALTER TABLE "public"."community_health_workers" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "consent_audit_immutable_insert" ON "public"."consent_audit_log" FOR INSERT WITH CHECK ((("auth"."role"() = 'service_role'::"text") OR ("auth"."uid"() IS NOT NULL)));



ALTER TABLE "public"."consent_audit_log" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "consent_audit_read" ON "public"."consent_audit_log" FOR SELECT USING ((("auth"."role"() = 'service_role'::"text") OR (EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."id" = "auth"."uid"()) AND ("p"."role" = ANY (ARRAY['admin'::"text", 'doctor'::"text"])))))));



CREATE POLICY "consents_staff_read" ON "public"."patient_consents" FOR SELECT USING ((("auth"."role"() = 'service_role'::"text") OR (EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."id" = "auth"."uid"()) AND ("p"."role" = ANY (ARRAY['admin'::"text", 'doctor'::"text", 'nurse'::"text"])))))));



CREATE POLICY "consents_staff_write" ON "public"."patient_consents" USING ((("auth"."role"() = 'service_role'::"text") OR (EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."id" = "auth"."uid"()) AND ("p"."role" = ANY (ARRAY['admin'::"text", 'doctor'::"text", 'nurse'::"text"]))))))) WITH CHECK ((("auth"."role"() = 'service_role'::"text") OR (EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."id" = "auth"."uid"()) AND ("p"."role" = ANY (ARRAY['admin'::"text", 'doctor'::"text", 'nurse'::"text"])))))));



ALTER TABLE "public"."consult_queue" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."cross_tenant_access" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."data_breach_incidents" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."data_export_jobs" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."data_retention_policies" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "death_reg_hospital_isolation" ON "public"."death_registrations" USING (("hospital_id" = ( SELECT "profiles"."hospital_id"
   FROM "public"."profiles"
  WHERE ("profiles"."id" = "auth"."uid"())
 LIMIT 1)));



ALTER TABLE "public"."death_registrations" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."death_reports" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."deidentification_profiles" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."demo_departments" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "demo_depts_rls" ON "public"."demo_departments" USING ((("auth"."jwt"() ->> 'email'::"text") = 'demo@synapseos.tech'::"text")) WITH CHECK ((("auth"."jwt"() ->> 'email'::"text") = 'demo@synapseos.tech'::"text"));



ALTER TABLE "public"."demo_encounter_orders" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."demo_encounters" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "demo_encounters_rls" ON "public"."demo_encounters" USING ((("auth"."jwt"() ->> 'email'::"text") = 'demo@synapseos.tech'::"text")) WITH CHECK ((("auth"."jwt"() ->> 'email'::"text") = 'demo@synapseos.tech'::"text"));



ALTER TABLE "public"."demo_lab_results" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "demo_lab_results_rls" ON "public"."demo_lab_results" USING ((("auth"."jwt"() ->> 'email'::"text") = 'demo@synapseos.tech'::"text")) WITH CHECK ((("auth"."jwt"() ->> 'email'::"text") = 'demo@synapseos.tech'::"text"));



CREATE POLICY "demo_orders_rls" ON "public"."demo_encounter_orders" USING ((("auth"."jwt"() ->> 'email'::"text") = 'demo@synapseos.tech'::"text")) WITH CHECK ((("auth"."jwt"() ->> 'email'::"text") = 'demo@synapseos.tech'::"text"));



ALTER TABLE "public"."demo_patients" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "demo_patients_rls" ON "public"."demo_patients" USING ((("auth"."jwt"() ->> 'email'::"text") = 'demo@synapseos.tech'::"text")) WITH CHECK ((("auth"."jwt"() ->> 'email'::"text") = 'demo@synapseos.tech'::"text"));



ALTER TABLE "public"."demo_vitals" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "demo_vitals_rls" ON "public"."demo_vitals" USING ((("auth"."jwt"() ->> 'email'::"text") = 'demo@synapseos.tech'::"text")) WITH CHECK ((("auth"."jwt"() ->> 'email'::"text") = 'demo@synapseos.tech'::"text"));



ALTER TABLE "public"."denial_analytics_daily" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "denial_analytics_staff_read" ON "public"."denial_analytics_daily" FOR SELECT USING ((("auth"."role"() = 'service_role'::"text") OR (EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."id" = "auth"."uid"()) AND ("p"."hospital_id" = "p"."hospital_id") AND ("p"."role" = ANY (ARRAY['admin'::"text", 'billing_officer'::"text"])))))));



ALTER TABLE "public"."department_tasks" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "department_tasks_tenant_isolation" ON "public"."department_tasks" USING (("tenant_id" = "public"."current_tenant_id"()));



ALTER TABLE "public"."departments" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."device_alerts" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "device_alerts_staff_read" ON "public"."device_alerts" FOR SELECT USING ((("auth"."role"() = 'service_role'::"text") OR (EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."id" = "auth"."uid"()) AND ("p"."hospital_id" = "p"."hospital_id"))))));



ALTER TABLE "public"."device_readings" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "device_readings_staff_all" ON "public"."device_readings" USING ((("auth"."role"() = 'service_role'::"text") OR (EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."id" = "auth"."uid"()) AND ("p"."hospital_id" = "p"."hospital_id")))))) WITH CHECK (("auth"."role"() = 'service_role'::"text"));



CREATE POLICY "devices_admin_write" ON "public"."medical_devices" USING ((("auth"."role"() = 'service_role'::"text") OR (EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."id" = "auth"."uid"()) AND ("p"."hospital_id" = "p"."hospital_id") AND ("p"."role" = 'admin'::"text")))))) WITH CHECK ((("auth"."role"() = 'service_role'::"text") OR (EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."id" = "auth"."uid"()) AND ("p"."hospital_id" = "p"."hospital_id") AND ("p"."role" = 'admin'::"text"))))));



CREATE POLICY "devices_hospital_staff_read" ON "public"."medical_devices" FOR SELECT USING ((("auth"."role"() = 'service_role'::"text") OR (EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."id" = "auth"."uid"()) AND ("p"."hospital_id" = "p"."hospital_id"))))));



ALTER TABLE "public"."dhis2_data_element_mappings" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."dhis2_export_attempt_log" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "dhis2_export_attempt_log_tenant_isolation" ON "public"."dhis2_export_attempt_log" USING (("tenant_id" = ((("current_setting"('request.jwt.claims'::"text", true))::json ->> 'tenant_id'::"text"))::"uuid")) WITH CHECK (("tenant_id" = ((("current_setting"('request.jwt.claims'::"text", true))::json ->> 'tenant_id'::"text"))::"uuid"));



ALTER TABLE "public"."dhis2_export_jobs" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "dhis2_export_jobs_tenant_isolation" ON "public"."dhis2_export_jobs" USING (("tenant_id" = ((("current_setting"('request.jwt.claims'::"text", true))::json ->> 'tenant_id'::"text"))::"uuid")) WITH CHECK (("tenant_id" = ((("current_setting"('request.jwt.claims'::"text", true))::json ->> 'tenant_id'::"text"))::"uuid"));



ALTER TABLE "public"."dhis2_export_log" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."dhis2_org_unit_mappings" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "dhis2_org_unit_mappings_tenant_isolation" ON "public"."dhis2_org_unit_mappings" USING (("tenant_id" = ((("current_setting"('request.jwt.claims'::"text", true))::json ->> 'tenant_id'::"text"))::"uuid")) WITH CHECK (("tenant_id" = ((("current_setting"('request.jwt.claims'::"text", true))::json ->> 'tenant_id'::"text"))::"uuid"));



ALTER TABLE "public"."diagnoses" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."diet_logs" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."doctor_availability_log" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."domain_event_consumers" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "domain_event_consumers_service_write" ON "public"."domain_event_consumers" TO "service_role" USING (true) WITH CHECK (true);



CREATE POLICY "domain_event_consumers_tenant_read" ON "public"."domain_event_consumers" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."id" = "auth"."uid"()) AND ("p"."hospital_id" = "domain_event_consumers"."tenant_id")))));



ALTER TABLE "public"."domain_events" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "domain_events_service_write" ON "public"."domain_events" TO "service_role" USING (true) WITH CHECK (true);



CREATE POLICY "domain_events_tenant_read" ON "public"."domain_events" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."id" = "auth"."uid"()) AND ("p"."hospital_id" = "domain_events"."tenant_id")))));



CREATE POLICY "dose_adjustments_read" ON "public"."drug_dose_adjustments" FOR SELECT USING ((("is_active" = true) AND (("auth"."role"() = 'service_role'::"text") OR ("auth"."uid"() IS NOT NULL))));



ALTER TABLE "public"."drug_contraindications" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "drug_contraindications_read" ON "public"."drug_contraindications" FOR SELECT USING ((("is_active" = true) AND (("auth"."role"() = 'service_role'::"text") OR ("auth"."uid"() IS NOT NULL))));



ALTER TABLE "public"."drug_dose_adjustments" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."drug_interactions" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."drug_interactions_catalog" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "drug_interactions_catalog_read_authenticated" ON "public"."drug_interactions_catalog" FOR SELECT USING (("auth"."role"() = 'authenticated'::"text"));



CREATE POLICY "drug_interactions_read" ON "public"."drug_interactions" FOR SELECT USING ((("is_active" = true) AND (("auth"."role"() = 'service_role'::"text") OR ("auth"."uid"() IS NOT NULL))));



ALTER TABLE "public"."drug_inventory" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "drug_shortage_admin_write" ON "public"."drug_shortage_alerts" USING (("public"."is_platform_admin"() OR (EXISTS ( SELECT 1
   FROM "public"."profiles"
  WHERE (("profiles"."id" = "auth"."uid"()) AND ("profiles"."role" = 'hospital_admin'::"text"))))));



ALTER TABLE "public"."drug_shortage_alerts" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "drug_shortage_read" ON "public"."drug_shortage_alerts" FOR SELECT USING (("auth"."uid"() IS NOT NULL));



ALTER TABLE "public"."emergency_access_events" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."emergency_profiles" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "emergency_profiles_visible" ON "public"."emergency_profiles" FOR SELECT USING (("public"."is_platform_admin"() OR "public"."person_visible_to_tenant"("person_id", "public"."current_tenant_id"())));



ALTER TABLE "public"."encounter_amendments" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "encounter_amendments_tenant_isolation" ON "public"."encounter_amendments" USING (("tenant_id" = "public"."current_tenant_id"()));



ALTER TABLE "public"."encounter_diagnoses" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."encounter_orders" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."encounters" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."expert_rules" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "expert_rules_mutate_admin" ON "public"."expert_rules" USING ("public"."is_admin"("auth"."uid"())) WITH CHECK ("public"."is_admin"("auth"."uid"()));



CREATE POLICY "expert_rules_read_authenticated" ON "public"."expert_rules" FOR SELECT USING (("auth"."role"() = 'authenticated'::"text"));



CREATE POLICY "export_jobs_admin_all" ON "public"."data_export_jobs" USING ((("auth"."role"() = 'service_role'::"text") OR (EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."id" = "auth"."uid"()) AND ("p"."role" = 'admin'::"text")))))) WITH CHECK ((("auth"."role"() = 'service_role'::"text") OR (EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."id" = "auth"."uid"()) AND ("p"."role" = 'admin'::"text"))))));



CREATE POLICY "export_jobs_own" ON "public"."data_export_jobs" FOR SELECT USING ((("auth"."role"() = 'service_role'::"text") OR ("requested_by" = "auth"."uid"()) OR (EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."id" = "auth"."uid"()) AND ("p"."role" = 'admin'::"text"))))));



ALTER TABLE "public"."facility_domain_records" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."facility_invitation_audit" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "facility_invitation_audit_platform_only" ON "public"."facility_invitation_audit" FOR SELECT USING ("public"."is_platform_admin"());



ALTER TABLE "public"."facility_invitations" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."facility_lifecycle_events" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "facility_lifecycle_events_platform_admin" ON "public"."facility_lifecycle_events" USING ("public"."is_platform_admin"()) WITH CHECK ("public"."is_platform_admin"());



ALTER TABLE "public"."facility_locations" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "facility_locations_tenant_isolation" ON "public"."facility_locations" USING (("tenant_id" = "public"."current_tenant_id"()));



ALTER TABLE "public"."facility_provisioning_runs" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."facility_provisioning_steps" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."facility_referrals" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."facility_resource_logs" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "facility_resource_tenant" ON "public"."facility_resource_logs" USING (("hospital_id" = "public"."current_tenant_id"()));



ALTER TABLE "public"."facility_type_inheritance" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."feature_flags" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "fti_read_authenticated" ON "public"."facility_type_inheritance" FOR SELECT USING (("auth"."role"() = 'authenticated'::"text"));



ALTER TABLE "public"."gas_cylinders" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."habit_logs" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "handover_entries_staff_all" ON "public"."handover_patient_entries" USING ((("auth"."role"() = 'service_role'::"text") OR (EXISTS ( SELECT 1
   FROM ("public"."care_team_handovers" "h"
     JOIN "public"."profiles" "p" ON (("p"."id" = "auth"."uid"())))
  WHERE (("h"."id" = "handover_patient_entries"."handover_id") AND ("p"."hospital_id" = "h"."hospital_id") AND ("p"."role" = ANY (ARRAY['admin'::"text", 'doctor'::"text", 'nurse'::"text", 'clinician'::"text"]))))))) WITH CHECK ((("auth"."role"() = 'service_role'::"text") OR (EXISTS ( SELECT 1
   FROM ("public"."care_team_handovers" "h"
     JOIN "public"."profiles" "p" ON (("p"."id" = "auth"."uid"())))
  WHERE (("h"."id" = "handover_patient_entries"."handover_id") AND ("p"."hospital_id" = "h"."hospital_id") AND ("p"."role" = ANY (ARRAY['admin'::"text", 'doctor'::"text", 'nurse'::"text", 'clinician'::"text"])))))));



ALTER TABLE "public"."handover_patient_entries" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."handover_shift_tasks" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."handover_signatures" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "handovers_staff_all" ON "public"."care_team_handovers" USING ((("auth"."role"() = 'service_role'::"text") OR (EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."id" = "auth"."uid"()) AND ("p"."hospital_id" = "p"."hospital_id") AND ("p"."role" = ANY (ARRAY['admin'::"text", 'doctor'::"text", 'nurse'::"text", 'clinician'::"text"]))))))) WITH CHECK ((("auth"."role"() = 'service_role'::"text") OR (EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."id" = "auth"."uid"()) AND ("p"."hospital_id" = "p"."hospital_id") AND ("p"."role" = ANY (ARRAY['admin'::"text", 'doctor'::"text", 'nurse'::"text", 'clinician'::"text"])))))));



ALTER TABLE "public"."health_bulletins" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "health_bulletins_admin_write" ON "public"."health_bulletins" USING ("public"."is_platform_admin"());



CREATE POLICY "health_bulletins_auth_read" ON "public"."health_bulletins" FOR SELECT USING (("auth"."uid"() IS NOT NULL));



ALTER TABLE "public"."health_habits" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."hospital_beds" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."hospital_drug_orders" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "hospital_isolation" ON "public"."patient_vitals" USING (("patient_id" IN ( SELECT "pp"."id"
   FROM "public"."patient_profiles" "pp"
  WHERE ("pp"."hospital_id" = ( SELECT "p"."hospital_id"
           FROM "public"."profiles" "p"
          WHERE ("p"."id" = "auth"."uid"())
         LIMIT 1)))));



ALTER TABLE "public"."hospital_leads" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "hospital_leads_public_insert" ON "public"."hospital_leads" FOR INSERT WITH CHECK (("status" = 'new'::"text"));



ALTER TABLE "public"."hospital_modules" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "hospital_modules_tenant_isolation" ON "public"."hospital_modules" USING ((("tenant_id" = ((("current_setting"('request.jwt.claims'::"text", true))::json ->> 'tenant_id'::"text"))::"uuid") OR (EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."id" = "auth"."uid"()) AND ("p"."role" = 'platform_admin'::"text"))))));



ALTER TABLE "public"."hospital_seed_registry" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "hospital_seed_registry_platform_read" ON "public"."hospital_seed_registry" FOR SELECT USING ("public"."is_platform_admin"());



CREATE POLICY "hospital_seed_registry_tenant_isolation" ON "public"."hospital_seed_registry" USING (("tenant_id" = "public"."current_tenant_id"()));



ALTER TABLE "public"."hospital_settings" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."hospitals" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "hospitals_tenant_isolation" ON "public"."hospitals" USING ((("id" = ((("current_setting"('request.jwt.claims'::"text", true))::json ->> 'tenant_id'::"text"))::"uuid") OR (EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."id" = "auth"."uid"()) AND ("p"."role" = 'platform_admin'::"text"))))));



ALTER TABLE "public"."housekeeping_tasks" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "housekeeping_tenant" ON "public"."housekeeping_tasks" USING (("tenant_id" = "public"."current_tenant_id"()));



ALTER TABLE "public"."icd11_cache" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."identity_match_candidates" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."identity_merge_events" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."imaging_series" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."imaging_studies" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "imaging_studies_staff_read" ON "public"."imaging_studies" FOR SELECT USING ((("auth"."role"() = 'service_role'::"text") OR (EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."id" = "auth"."uid"()) AND (("p"."hospital_id" = "p"."hospital_id") OR ("p"."role" = 'admin'::"text")))))));



CREATE POLICY "imaging_studies_staff_write" ON "public"."imaging_studies" USING ((("auth"."role"() = 'service_role'::"text") OR (EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."id" = "auth"."uid"()) AND ("p"."role" = ANY (ARRAY['admin'::"text", 'doctor'::"text", 'radiographer'::"text"]))))))) WITH CHECK ((("auth"."role"() = 'service_role'::"text") OR (EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."id" = "auth"."uid"()) AND ("p"."role" = ANY (ARRAY['admin'::"text", 'doctor'::"text", 'radiographer'::"text"])))))));



ALTER TABLE "public"."imid_access_log" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."imid_codes" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."immunization_schedule" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."import_batch_rows" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "import_batch_rows_admin_all" ON "public"."import_batch_rows" USING ((EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."id" = "auth"."uid"()) AND ("p"."role" = 'admin'::"text"))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."id" = "auth"."uid"()) AND ("p"."role" = 'admin'::"text")))));



ALTER TABLE "public"."import_batches" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "import_batches_admin_all" ON "public"."import_batches" USING ((EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."id" = "auth"."uid"()) AND ("p"."role" = 'admin'::"text"))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."id" = "auth"."uid"()) AND ("p"."role" = 'admin'::"text")))));



ALTER TABLE "public"."import_column_mappings" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "import_column_mappings_admin_all" ON "public"."import_column_mappings" USING ((EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."id" = "auth"."uid"()) AND ("p"."role" = 'admin'::"text"))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."id" = "auth"."uid"()) AND ("p"."role" = 'admin'::"text")))));



CREATE POLICY "insert_on_access" ON "public"."passport_access_log" FOR INSERT WITH CHECK (true);



ALTER TABLE "public"."insurance_benefits" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "insurance_benefits_tenant" ON "public"."insurance_benefits" USING ("public"."same_tenant"("tenant_id")) WITH CHECK ("public"."same_tenant"("tenant_id"));



ALTER TABLE "public"."insurance_claims" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."insurance_copilot_audit" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "insurance_copilot_audit_tenant" ON "public"."insurance_copilot_audit" USING ("public"."same_tenant"("tenant_id")) WITH CHECK ("public"."same_tenant"("tenant_id"));



ALTER TABLE "public"."insurance_coverage_checks" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "insurance_coverage_checks_tenant" ON "public"."insurance_coverage_checks" USING ("public"."same_tenant"("tenant_id")) WITH CHECK ("public"."same_tenant"("tenant_id"));



ALTER TABLE "public"."insurance_memberships" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "insurance_memberships_visible" ON "public"."insurance_memberships" USING (("public"."is_platform_admin"() OR "public"."person_visible_to_tenant"("person_id", "public"."current_tenant_id"()))) WITH CHECK (("public"."is_platform_admin"() OR "public"."person_visible_to_tenant"("person_id", "public"."current_tenant_id"())));



ALTER TABLE "public"."insurance_policies" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "insurance_policies_tenant" ON "public"."insurance_policies" USING ("public"."same_tenant"("tenant_id")) WITH CHECK ("public"."same_tenant"("tenant_id"));



ALTER TABLE "public"."insurance_preauthorizations" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "insurance_preauths_tenant" ON "public"."insurance_preauthorizations" USING ("public"."same_tenant"("tenant_id")) WITH CHECK ("public"."same_tenant"("tenant_id"));



ALTER TABLE "public"."insurance_providers" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."intelligence_actions" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."intelligence_recommendations" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."interop_connections" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "interop_connections_tenant_isolation" ON "public"."interop_connections" USING ((("tenant_id" = "public"."current_tenant_id"()) OR "public"."is_platform_admin"())) WITH CHECK ((("tenant_id" = "public"."current_tenant_id"()) OR "public"."is_platform_admin"()));



ALTER TABLE "public"."interop_messages" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "interop_messages_tenant_isolation" ON "public"."interop_messages" USING ((("tenant_id" = "public"."current_tenant_id"()) OR "public"."is_platform_admin"())) WITH CHECK ((("tenant_id" = "public"."current_tenant_id"()) OR "public"."is_platform_admin"()));



ALTER TABLE "public"."inventory_items" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."lab_accession_counters" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."lab_analyzer_messages" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "lab_analyzer_messages_tenant_isolation" ON "public"."lab_analyzer_messages" USING ((("tenant_id" = "public"."current_tenant_id"()) OR "public"."is_platform_admin"())) WITH CHECK ((("tenant_id" = "public"."current_tenant_id"()) OR "public"."is_platform_admin"()));



ALTER TABLE "public"."lab_critical_acknowledgements" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "lab_critical_acknowledgements_tenant_isolation" ON "public"."lab_critical_acknowledgements" USING ((("tenant_id" = "public"."current_tenant_id"()) OR "public"."is_platform_admin"())) WITH CHECK ((("tenant_id" = "public"."current_tenant_id"()) OR "public"."is_platform_admin"()));



ALTER TABLE "public"."lab_device_messages" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."lab_device_test_mappings" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."lab_devices" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."lab_instrument_bridges" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."lab_orders" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."lab_reference_ranges" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."lab_reports" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."lab_result_amendments" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "lab_result_amendments_tenant_isolation" ON "public"."lab_result_amendments" USING ((("tenant_id" = "public"."current_tenant_id"()) OR "public"."is_platform_admin"())) WITH CHECK ((("tenant_id" = "public"."current_tenant_id"()) OR "public"."is_platform_admin"()));



ALTER TABLE "public"."lab_result_staging" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."lab_results" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."lab_specimens" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "lab_specimens_tenant_isolation" ON "public"."lab_specimens" USING ((("tenant_id" = "public"."current_tenant_id"()) OR "public"."is_platform_admin"())) WITH CHECK ((("tenant_id" = "public"."current_tenant_id"()) OR "public"."is_platform_admin"()));



ALTER TABLE "public"."live_feed_sessions" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."loinc_reference" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."maternity_records" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."medical_devices" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."medication_safety_checks" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "medsafety_staff_all" ON "public"."medication_safety_checks" USING ((("auth"."role"() = 'service_role'::"text") OR (EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."id" = "auth"."uid"()) AND ("p"."role" = ANY (ARRAY['admin'::"text", 'doctor'::"text", 'pharmacist'::"text", 'nurse'::"text"]))))))) WITH CHECK ((("auth"."role"() = 'service_role'::"text") OR (EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."id" = "auth"."uid"()) AND ("p"."role" = ANY (ARRAY['admin'::"text", 'doctor'::"text", 'pharmacist'::"text", 'nurse'::"text"])))))));



ALTER TABLE "public"."menstrual_cycles" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."mfa_enrollments" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "mfa_own_all" ON "public"."mfa_enrollments" USING (("user_id" = "auth"."uid"()));



ALTER TABLE "public"."mfa_step_up_replays" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."mobile_push_tokens" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "newsletter_admin_read" ON "public"."newsletter_subscribers" FOR SELECT USING ("public"."is_platform_admin"());



CREATE POLICY "newsletter_public_insert" ON "public"."newsletter_subscribers" FOR INSERT WITH CHECK (true);



ALTER TABLE "public"."newsletter_subscribers" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."nin_access_log" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "nin_access_log_insert_system" ON "public"."nin_access_log" FOR INSERT WITH CHECK (true);



CREATE POLICY "nin_access_log_read_admin" ON "public"."nin_access_log" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."id" = "auth"."uid"()) AND ("p"."hospital_id" = "nin_access_log"."hospital_id") AND ("p"."role" = 'admin'::"text")))));



ALTER TABLE "public"."notifications" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."offline_mutation_outbox" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "offline_mutation_outbox_tenant_isolation" ON "public"."offline_mutation_outbox" USING ((("tenant_id" = "public"."current_tenant_id"()) OR "public"."is_platform_admin"())) WITH CHECK ((("tenant_id" = "public"."current_tenant_id"()) OR "public"."is_platform_admin"()));



ALTER TABLE "public"."offline_sync_queue" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."order_items" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."order_mappings" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."orders" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."organizations" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "organizations_member_read" ON "public"."organizations" FOR SELECT USING (("public"."is_platform_admin"() OR (EXISTS ( SELECT 1
   FROM "public"."tenants" "t"
  WHERE (("t"."organization_id" = "organizations"."id") AND ("t"."id" = "public"."current_tenant_id"()))))));



ALTER TABLE "public"."outbreak_alerts" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."outreach_campaigns" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "own_access_log" ON "public"."passport_access_log" FOR SELECT USING (("accessed_by_user_id" = "auth"."uid"()));



CREATE POLICY "owner_access" ON "public"."passport_share_tokens" USING (("created_by" = "auth"."uid"()));



ALTER TABLE "public"."partograph_records" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "partograph_tenant" ON "public"."partograph_records" USING ((("tenant_id" = "public"."current_tenant_id"()) OR "public"."is_platform_admin"()));



ALTER TABLE "public"."passport_access_log" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."passport_share_tokens" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."password_reset_tokens" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."pathway_alerts" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "pathway_alerts_staff_read" ON "public"."pathway_alerts" FOR SELECT USING ((("auth"."role"() = 'service_role'::"text") OR (EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."id" = "auth"."uid"()) AND ("p"."role" = ANY (ARRAY['admin'::"text", 'doctor'::"text", 'nurse'::"text", 'clinician'::"text"])))))));



ALTER TABLE "public"."pathway_checklist_items" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."pathway_overrides" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "pathway_overrides_tenant_isolation" ON "public"."pathway_overrides" USING ((("tenant_id" = "public"."current_tenant_id"()) OR "public"."is_platform_admin"())) WITH CHECK ((("tenant_id" = "public"."current_tenant_id"()) OR "public"."is_platform_admin"()));



CREATE POLICY "pathway_templates_admin_write" ON "public"."clinical_pathway_templates" USING ((("auth"."role"() = 'service_role'::"text") OR (EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."id" = "auth"."uid"()) AND ("p"."role" = 'admin'::"text")))))) WITH CHECK ((("auth"."role"() = 'service_role'::"text") OR (EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."id" = "auth"."uid"()) AND ("p"."role" = 'admin'::"text"))))));



CREATE POLICY "pathway_templates_read_all" ON "public"."clinical_pathway_templates" FOR SELECT USING (("is_active" = true));



ALTER TABLE "public"."patient_access_grants" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."patient_allergies" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."patient_billing" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."patient_clinical_patterns" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."patient_consents" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."patient_history_queries" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."patient_intervention_outcomes" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."patient_notes" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "patient_notes_admin_only" ON "public"."patient_notes" USING ("public"."is_admin"("auth"."uid"())) WITH CHECK ("public"."is_admin"("auth"."uid"()));



CREATE POLICY "patient_outcomes_tenant" ON "public"."patient_intervention_outcomes" USING ("public"."same_tenant"("tenant_id")) WITH CHECK ("public"."same_tenant"("tenant_id"));



ALTER TABLE "public"."patient_pathways" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "patient_pathways_staff_all" ON "public"."patient_pathways" USING ((("auth"."role"() = 'service_role'::"text") OR (EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."id" = "auth"."uid"()) AND ("p"."role" = ANY (ARRAY['admin'::"text", 'doctor'::"text", 'nurse'::"text", 'clinician'::"text"]))))))) WITH CHECK ((("auth"."role"() = 'service_role'::"text") OR (EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."id" = "auth"."uid"()) AND ("p"."role" = ANY (ARRAY['admin'::"text", 'doctor'::"text", 'nurse'::"text", 'clinician'::"text"])))))));



CREATE POLICY "patient_patterns_tenant" ON "public"."patient_clinical_patterns" USING ("public"."same_tenant"("tenant_id")) WITH CHECK ("public"."same_tenant"("tenant_id"));



ALTER TABLE "public"."patient_problem_list" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."patient_profiles" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "patient_profiles_delete_platform_only" ON "public"."patient_profiles" FOR DELETE USING ("public"."is_platform_admin"());



CREATE POLICY "patient_profiles_insert_own_or_platform" ON "public"."patient_profiles" FOR INSERT WITH CHECK ((("id" = "auth"."uid"()) OR "public"."is_platform_admin"()));



CREATE POLICY "patient_profiles_select_identity_or_care_team" ON "public"."patient_profiles" FOR SELECT USING ((("id" = "auth"."uid"()) OR "public"."is_platform_admin"() OR (("hospital_id" IS NOT NULL) AND ("hospital_id" = "public"."current_hospital_id"()) AND "public"."is_clinical_staff"())));



CREATE POLICY "patient_profiles_update_own_or_platform" ON "public"."patient_profiles" FOR UPDATE USING ((("id" = "auth"."uid"()) OR "public"."is_platform_admin"())) WITH CHECK ((("id" = "auth"."uid"()) OR "public"."is_platform_admin"()));



ALTER TABLE "public"."patient_safety_events" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."patient_sms_reminders" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."patient_timeline_events" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."patient_timeline_pins" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."patient_vitals" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."patients" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."payer_contracts" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "payer_contracts_admin_all" ON "public"."payer_contracts" USING ((("auth"."role"() = 'service_role'::"text") OR (EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."id" = "auth"."uid"()) AND ("p"."hospital_id" = "p"."hospital_id") AND ("p"."role" = 'admin'::"text")))))) WITH CHECK ((("auth"."role"() = 'service_role'::"text") OR (EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."id" = "auth"."uid"()) AND ("p"."hospital_id" = "p"."hospital_id") AND ("p"."role" = 'admin'::"text"))))));



ALTER TABLE "public"."pediatric_growth_records" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."person_clinical_facts" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "person_clinical_facts_visible" ON "public"."person_clinical_facts" USING (("public"."is_platform_admin"() OR "public"."person_visible_to_tenant"("person_id", "public"."current_tenant_id"()))) WITH CHECK (("public"."is_platform_admin"() OR "public"."person_visible_to_tenant"("person_id", "public"."current_tenant_id"()) OR ("source_facility_id" = "public"."current_tenant_id"())));



ALTER TABLE "public"."person_consent_events" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."person_consents" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "person_consents_visible" ON "public"."person_consents" USING (("public"."is_platform_admin"() OR "public"."person_visible_to_tenant"("person_id", "public"."current_tenant_id"()))) WITH CHECK (("public"."is_platform_admin"() OR "public"."person_visible_to_tenant"("person_id", "public"."current_tenant_id"())));



ALTER TABLE "public"."person_contacts" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "person_contacts_visible" ON "public"."person_contacts" USING (("public"."is_platform_admin"() OR "public"."person_visible_to_tenant"("person_id", "public"."current_tenant_id"()))) WITH CHECK (("public"."is_platform_admin"() OR "public"."person_visible_to_tenant"("person_id", "public"."current_tenant_id"())));



ALTER TABLE "public"."person_identifiers" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "person_identifiers_visible" ON "public"."person_identifiers" USING (("public"."is_platform_admin"() OR ("issuing_facility_id" = "public"."current_tenant_id"()) OR "public"."person_visible_to_tenant"("person_id", "public"."current_tenant_id"()))) WITH CHECK (("public"."is_platform_admin"() OR ("issuing_facility_id" = "public"."current_tenant_id"()) OR ("issuing_facility_id" IS NULL)));



ALTER TABLE "public"."person_relationships" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."persons" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "persons_update_visible" ON "public"."persons" FOR UPDATE USING (("public"."is_platform_admin"() OR "public"."person_visible_to_tenant"("id", "public"."current_tenant_id"())));



CREATE POLICY "persons_visible" ON "public"."persons" FOR SELECT USING (("public"."is_platform_admin"() OR "public"."person_visible_to_tenant"("id", "public"."current_tenant_id"())));



CREATE POLICY "persons_write_tenant" ON "public"."persons" FOR INSERT WITH CHECK (("public"."is_platform_admin"() OR ("public"."current_tenant_id"() IS NOT NULL)));



CREATE POLICY "pharmacy_admin_own" ON "public"."pharmacy_onboarding" FOR SELECT USING (("tenant_id" IN ( SELECT "profiles"."tenant_id"
   FROM "public"."profiles"
  WHERE ("profiles"."id" = "auth"."uid"()))));



ALTER TABLE "public"."pharmacy_audit_logs" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "pharmacy_audit_logs_tenant_isolation" ON "public"."pharmacy_audit_logs" TO "authenticated" USING ((("tenant_id" = "public"."current_tenant_id"()) OR "public"."is_platform_admin"())) WITH CHECK ((("tenant_id" = "public"."current_tenant_id"()) OR "public"."is_platform_admin"()));



ALTER TABLE "public"."pharmacy_cart_items" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "pharmacy_cart_items_tenant" ON "public"."pharmacy_cart_items" USING ("public"."same_tenant"("tenant_id")) WITH CHECK ("public"."same_tenant"("tenant_id"));



ALTER TABLE "public"."pharmacy_carts" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "pharmacy_carts_tenant" ON "public"."pharmacy_carts" USING ("public"."same_tenant"("tenant_id")) WITH CHECK ("public"."same_tenant"("tenant_id"));



ALTER TABLE "public"."pharmacy_cashier_sessions" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "pharmacy_cashier_sessions_tenant" ON "public"."pharmacy_cashier_sessions" USING (("public"."is_platform_admin"() OR ("tenant_id" = "public"."current_tenant_id"()))) WITH CHECK (("public"."is_platform_admin"() OR ("tenant_id" = "public"."current_tenant_id"())));



ALTER TABLE "public"."pharmacy_clients" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "pharmacy_clients_tenant_isolation" ON "public"."pharmacy_clients" TO "authenticated" USING ((("tenant_id" = "public"."current_tenant_id"()) OR "public"."is_platform_admin"())) WITH CHECK ((("tenant_id" = "public"."current_tenant_id"()) OR "public"."is_platform_admin"()));



ALTER TABLE "public"."pharmacy_credit_ledger" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."pharmacy_custom_domains" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "pharmacy_custom_domains_platform_admin" ON "public"."pharmacy_custom_domains" TO "authenticated" USING ("public"."is_platform_admin"()) WITH CHECK ("public"."is_platform_admin"());



CREATE POLICY "pharmacy_custom_domains_tenant_read" ON "public"."pharmacy_custom_domains" FOR SELECT TO "authenticated" USING (("tenant_id" = ( SELECT "p"."tenant_id"
   FROM "public"."profiles" "p"
  WHERE ("p"."id" = "auth"."uid"()))));



ALTER TABLE "public"."pharmacy_customers" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "pharmacy_customers_tenant_isolation" ON "public"."pharmacy_customers" TO "authenticated" USING ((("tenant_id" = "public"."current_tenant_id"()) OR "public"."is_platform_admin"())) WITH CHECK ((("tenant_id" = "public"."current_tenant_id"()) OR "public"."is_platform_admin"()));



ALTER TABLE "public"."pharmacy_expenses" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."pharmacy_import_sessions" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."pharmacy_inquiries" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "pharmacy_inquiries_tenant_isolation" ON "public"."pharmacy_inquiries" TO "authenticated" USING ((("tenant_id" = "public"."current_tenant_id"()) OR "public"."is_platform_admin"())) WITH CHECK ((("tenant_id" = "public"."current_tenant_id"()) OR "public"."is_platform_admin"()));



ALTER TABLE "public"."pharmacy_network_inventory" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."pharmacy_notifications" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "pharmacy_notifications_own_or_admin" ON "public"."pharmacy_notifications" TO "authenticated" USING ((("profile_id" = "auth"."uid"()) OR ("tenant_id" = "public"."current_tenant_id"()) OR "public"."is_platform_admin"())) WITH CHECK ((("profile_id" = "auth"."uid"()) OR ("tenant_id" = "public"."current_tenant_id"()) OR "public"."is_platform_admin"()));



ALTER TABLE "public"."pharmacy_onboarding" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."pharmacy_order_items" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "pharmacy_order_items_tenant_isolation" ON "public"."pharmacy_order_items" TO "authenticated" USING ((("tenant_id" = "public"."current_tenant_id"()) OR "public"."is_platform_admin"())) WITH CHECK ((("tenant_id" = "public"."current_tenant_id"()) OR "public"."is_platform_admin"()));



ALTER TABLE "public"."pharmacy_orders" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "pharmacy_orders_tenant_isolation" ON "public"."pharmacy_orders" TO "authenticated" USING ((("tenant_id" = "public"."current_tenant_id"()) OR "public"."is_platform_admin"())) WITH CHECK ((("tenant_id" = "public"."current_tenant_id"()) OR "public"."is_platform_admin"()));



ALTER TABLE "public"."pharmacy_pos_sale_items" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "pharmacy_pos_sale_items_tenant" ON "public"."pharmacy_pos_sale_items" USING ("public"."same_tenant"("tenant_id")) WITH CHECK ("public"."same_tenant"("tenant_id"));



CREATE POLICY "pharmacy_pos_sale_items_tenant_isolation" ON "public"."pharmacy_pos_sale_items" USING ((("tenant_id" = "public"."current_tenant_id"()) OR "public"."is_platform_admin"())) WITH CHECK ((("tenant_id" = "public"."current_tenant_id"()) OR "public"."is_platform_admin"()));



ALTER TABLE "public"."pharmacy_pos_sales" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "pharmacy_pos_sales_tenant" ON "public"."pharmacy_pos_sales" USING ("public"."same_tenant"("tenant_id")) WITH CHECK ("public"."same_tenant"("tenant_id"));



CREATE POLICY "pharmacy_pos_sales_tenant_isolation" ON "public"."pharmacy_pos_sales" USING ((("tenant_id" = "public"."current_tenant_id"()) OR "public"."is_platform_admin"())) WITH CHECK ((("tenant_id" = "public"."current_tenant_id"()) OR "public"."is_platform_admin"()));



ALTER TABLE "public"."pharmacy_product_batches" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "pharmacy_product_batches_tenant_isolation" ON "public"."pharmacy_product_batches" TO "authenticated" USING ((("tenant_id" = "public"."current_tenant_id"()) OR "public"."is_platform_admin"())) WITH CHECK ((("tenant_id" = "public"."current_tenant_id"()) OR "public"."is_platform_admin"()));



ALTER TABLE "public"."pharmacy_product_packages" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "pharmacy_product_packages_tenant_isolation" ON "public"."pharmacy_product_packages" TO "authenticated" USING ((("tenant_id" = "public"."current_tenant_id"()) OR "public"."is_platform_admin"())) WITH CHECK ((("tenant_id" = "public"."current_tenant_id"()) OR "public"."is_platform_admin"()));



ALTER TABLE "public"."pharmacy_products" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "pharmacy_products_tenant_isolation" ON "public"."pharmacy_products" TO "authenticated" USING ((("tenant_id" = "public"."current_tenant_id"()) OR "public"."is_platform_admin"())) WITH CHECK ((("tenant_id" = "public"."current_tenant_id"()) OR "public"."is_platform_admin"()));



ALTER TABLE "public"."pharmacy_profiles" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."pharmacy_purchase_order_items" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "pharmacy_purchase_order_items_tenant_isolation" ON "public"."pharmacy_purchase_order_items" TO "authenticated" USING ((("tenant_id" = "public"."current_tenant_id"()) OR "public"."is_platform_admin"())) WITH CHECK ((("tenant_id" = "public"."current_tenant_id"()) OR "public"."is_platform_admin"()));



ALTER TABLE "public"."pharmacy_purchase_orders" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "pharmacy_purchase_orders_tenant_isolation" ON "public"."pharmacy_purchase_orders" TO "authenticated" USING ((("tenant_id" = "public"."current_tenant_id"()) OR "public"."is_platform_admin"())) WITH CHECK ((("tenant_id" = "public"."current_tenant_id"()) OR "public"."is_platform_admin"()));



ALTER TABLE "public"."pharmacy_receipt_reprints" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."pharmacy_refunds" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "pharmacy_refunds_tenant" ON "public"."pharmacy_refunds" USING ("public"."same_tenant"("tenant_id")) WITH CHECK ("public"."same_tenant"("tenant_id"));



ALTER TABLE "public"."pharmacy_sale_idempotency" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."pharmacy_settings" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "pharmacy_settings_tenant_isolation" ON "public"."pharmacy_settings" TO "authenticated" USING ((("tenant_id" = "public"."current_tenant_id"()) OR "public"."is_platform_admin"())) WITH CHECK ((("tenant_id" = "public"."current_tenant_id"()) OR "public"."is_platform_admin"()));



ALTER TABLE "public"."pharmacy_staff_permissions" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."pharmacy_stock_adjustments" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "pharmacy_stock_adjustments_tenant_isolation" ON "public"."pharmacy_stock_adjustments" TO "authenticated" USING ((("tenant_id" = "public"."current_tenant_id"()) OR "public"."is_platform_admin"())) WITH CHECK ((("tenant_id" = "public"."current_tenant_id"()) OR "public"."is_platform_admin"()));



ALTER TABLE "public"."pharmacy_stock_transfer_item_allocations" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "pharmacy_stock_transfer_item_allocations_via_parent" ON "public"."pharmacy_stock_transfer_item_allocations" USING (("public"."is_platform_admin"() OR (EXISTS ( SELECT 1
   FROM ("public"."pharmacy_stock_transfer_items" "ti"
     JOIN "public"."pharmacy_stock_transfers" "tr" ON (("tr"."id" = "ti"."transfer_id")))
  WHERE (("ti"."id" = "pharmacy_stock_transfer_item_allocations"."transfer_item_id") AND ("tr"."tenant_id" = "public"."current_tenant_id"())))))) WITH CHECK (("public"."is_platform_admin"() OR (EXISTS ( SELECT 1
   FROM ("public"."pharmacy_stock_transfer_items" "ti"
     JOIN "public"."pharmacy_stock_transfers" "tr" ON (("tr"."id" = "ti"."transfer_id")))
  WHERE (("ti"."id" = "pharmacy_stock_transfer_item_allocations"."transfer_item_id") AND ("tr"."tenant_id" = "public"."current_tenant_id"()))))));



ALTER TABLE "public"."pharmacy_stock_transfer_items" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "pharmacy_stock_transfer_items_via_parent" ON "public"."pharmacy_stock_transfer_items" USING (("public"."is_platform_admin"() OR (EXISTS ( SELECT 1
   FROM "public"."pharmacy_stock_transfers" "tr"
  WHERE (("tr"."id" = "pharmacy_stock_transfer_items"."transfer_id") AND ("tr"."tenant_id" = "public"."current_tenant_id"())))))) WITH CHECK (("public"."is_platform_admin"() OR (EXISTS ( SELECT 1
   FROM "public"."pharmacy_stock_transfers" "tr"
  WHERE (("tr"."id" = "pharmacy_stock_transfer_items"."transfer_id") AND ("tr"."tenant_id" = "public"."current_tenant_id"()))))));



ALTER TABLE "public"."pharmacy_stock_transfers" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "pharmacy_stock_transfers_tenant_isolation" ON "public"."pharmacy_stock_transfers" USING ((("tenant_id" = "public"."current_tenant_id"()) OR "public"."is_platform_admin"())) WITH CHECK ((("tenant_id" = "public"."current_tenant_id"()) OR "public"."is_platform_admin"()));



ALTER TABLE "public"."pharmacy_stores" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "pharmacy_stores_tenant_isolation" ON "public"."pharmacy_stores" USING ((("tenant_id" = "public"."current_tenant_id"()) OR "public"."is_platform_admin"())) WITH CHECK ((("tenant_id" = "public"."current_tenant_id"()) OR "public"."is_platform_admin"()));



ALTER TABLE "public"."pharmacy_suppliers" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "pharmacy_suppliers_tenant_isolation" ON "public"."pharmacy_suppliers" TO "authenticated" USING ((("tenant_id" = "public"."current_tenant_id"()) OR "public"."is_platform_admin"())) WITH CHECK ((("tenant_id" = "public"."current_tenant_id"()) OR "public"."is_platform_admin"()));



ALTER TABLE "public"."pharmacy_transaction_edits" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "pharmacy_transaction_edits_tenant_isolation" ON "public"."pharmacy_transaction_edits" TO "authenticated" USING ((("tenant_id" = "public"."current_tenant_id"()) OR "public"."is_platform_admin"())) WITH CHECK ((("tenant_id" = "public"."current_tenant_id"()) OR "public"."is_platform_admin"()));



ALTER TABLE "public"."pharmacy_transaction_items" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "pharmacy_transaction_items_tenant_isolation" ON "public"."pharmacy_transaction_items" TO "authenticated" USING ((("tenant_id" = "public"."current_tenant_id"()) OR "public"."is_platform_admin"())) WITH CHECK ((("tenant_id" = "public"."current_tenant_id"()) OR "public"."is_platform_admin"()));



ALTER TABLE "public"."pharmacy_transactions" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "pharmacy_transactions_tenant_isolation" ON "public"."pharmacy_transactions" TO "authenticated" USING ((("tenant_id" = "public"."current_tenant_id"()) OR "public"."is_platform_admin"())) WITH CHECK ((("tenant_id" = "public"."current_tenant_id"()) OR "public"."is_platform_admin"()));



ALTER TABLE "public"."pharmacy_user_settings" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "pharmacy_user_settings_tenant_isolation" ON "public"."pharmacy_user_settings" TO "authenticated" USING ((("tenant_id" = "public"."current_tenant_id"()) OR "public"."is_platform_admin"())) WITH CHECK ((("tenant_id" = "public"."current_tenant_id"()) OR "public"."is_platform_admin"()));



CREATE POLICY "pharmacy_user_update_onboarding" ON "public"."pharmacy_onboarding" FOR UPDATE USING (("tenant_id" IN ( SELECT "profiles"."tenant_id"
   FROM "public"."profiles"
  WHERE (("profiles"."id" = "auth"."uid"()) AND ("profiles"."tenant_id" IS NOT NULL))))) WITH CHECK (("tenant_id" IN ( SELECT "profiles"."tenant_id"
   FROM "public"."profiles"
  WHERE (("profiles"."id" = "auth"."uid"()) AND ("profiles"."tenant_id" IS NOT NULL)))));



CREATE POLICY "phi_access_admin_read" ON "public"."phi_access_log" FOR SELECT USING ((("auth"."role"() = 'service_role'::"text") OR (EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."id" = "auth"."uid"()) AND ("p"."role" = 'admin'::"text"))))));



CREATE POLICY "phi_access_insert" ON "public"."phi_access_log" FOR INSERT WITH CHECK ((("auth"."role"() = 'service_role'::"text") OR ("auth"."uid"() IS NOT NULL)));



ALTER TABLE "public"."phi_access_log" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."pilot_applications" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."plan_features" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "plan_features_read" ON "public"."plan_features" FOR SELECT USING (true);



CREATE POLICY "platform_admin_bypass" ON "public"."aefi_reports" USING ((EXISTS ( SELECT 1
   FROM "public"."profiles"
  WHERE (("profiles"."id" = "auth"."uid"()) AND ("profiles"."role" = 'platform_admin'::"text")))));



CREATE POLICY "platform_admin_bypass" ON "public"."allergens_catalog" USING ((EXISTS ( SELECT 1
   FROM "public"."profiles"
  WHERE (("profiles"."id" = "auth"."uid"()) AND ("profiles"."role" = 'platform_admin'::"text")))));



CREATE POLICY "platform_admin_bypass" ON "public"."audit_events" USING ((EXISTS ( SELECT 1
   FROM "public"."profiles"
  WHERE (("profiles"."id" = "auth"."uid"()) AND ("profiles"."role" = 'platform_admin'::"text")))));



CREATE POLICY "platform_admin_bypass" ON "public"."audit_log" USING ((EXISTS ( SELECT 1
   FROM "public"."profiles"
  WHERE (("profiles"."id" = "auth"."uid"()) AND ("profiles"."role" = 'platform_admin'::"text")))));



CREATE POLICY "platform_admin_bypass" ON "public"."bed_assignments" USING ((EXISTS ( SELECT 1
   FROM "public"."profiles"
  WHERE (("profiles"."id" = "auth"."uid"()) AND ("profiles"."role" = 'platform_admin'::"text")))));



CREATE POLICY "platform_admin_bypass" ON "public"."beta_access_requests" USING ((EXISTS ( SELECT 1
   FROM "public"."profiles"
  WHERE (("profiles"."id" = "auth"."uid"()) AND ("profiles"."role" = 'platform_admin'::"text")))));



CREATE POLICY "platform_admin_bypass" ON "public"."billing_invoices" USING ((EXISTS ( SELECT 1
   FROM "public"."profiles"
  WHERE (("profiles"."id" = "auth"."uid"()) AND ("profiles"."role" = 'platform_admin'::"text")))));



CREATE POLICY "platform_admin_bypass" ON "public"."billing_line_items" USING ((EXISTS ( SELECT 1
   FROM "public"."profiles"
  WHERE (("profiles"."id" = "auth"."uid"()) AND ("profiles"."role" = 'platform_admin'::"text")))));



CREATE POLICY "platform_admin_bypass" ON "public"."care_team_handovers" USING ((EXISTS ( SELECT 1
   FROM "public"."profiles"
  WHERE (("profiles"."id" = "auth"."uid"()) AND ("profiles"."role" = 'platform_admin'::"text")))));



CREATE POLICY "platform_admin_bypass" ON "public"."cds_alerts" USING ((EXISTS ( SELECT 1
   FROM "public"."profiles"
  WHERE (("profiles"."id" = "auth"."uid"()) AND ("profiles"."role" = 'platform_admin'::"text")))));



CREATE POLICY "platform_admin_bypass" ON "public"."cds_rules" USING ((EXISTS ( SELECT 1
   FROM "public"."profiles"
  WHERE (("profiles"."id" = "auth"."uid"()) AND ("profiles"."role" = 'platform_admin'::"text")))));



CREATE POLICY "platform_admin_bypass" ON "public"."chw_visits" USING ((EXISTS ( SELECT 1
   FROM "public"."profiles"
  WHERE (("profiles"."id" = "auth"."uid"()) AND ("profiles"."role" = 'platform_admin'::"text")))));



CREATE POLICY "platform_admin_bypass" ON "public"."claim_line_items" USING ((EXISTS ( SELECT 1
   FROM "public"."profiles"
  WHERE (("profiles"."id" = "auth"."uid"()) AND ("profiles"."role" = 'platform_admin'::"text")))));



CREATE POLICY "platform_admin_bypass" ON "public"."claim_resubmissions" USING ((EXISTS ( SELECT 1
   FROM "public"."profiles"
  WHERE (("profiles"."id" = "auth"."uid"()) AND ("profiles"."role" = 'platform_admin'::"text")))));



CREATE POLICY "platform_admin_bypass" ON "public"."clinical_pathway_templates" USING ((EXISTS ( SELECT 1
   FROM "public"."profiles"
  WHERE (("profiles"."id" = "auth"."uid"()) AND ("profiles"."role" = 'platform_admin'::"text")))));



CREATE POLICY "platform_admin_bypass" ON "public"."community_health_workers" USING ((EXISTS ( SELECT 1
   FROM "public"."profiles"
  WHERE (("profiles"."id" = "auth"."uid"()) AND ("profiles"."role" = 'platform_admin'::"text")))));



CREATE POLICY "platform_admin_bypass" ON "public"."consent_audit_log" USING ((EXISTS ( SELECT 1
   FROM "public"."profiles"
  WHERE (("profiles"."id" = "auth"."uid"()) AND ("profiles"."role" = 'platform_admin'::"text")))));



CREATE POLICY "platform_admin_bypass" ON "public"."data_breach_incidents" USING ((EXISTS ( SELECT 1
   FROM "public"."profiles"
  WHERE (("profiles"."id" = "auth"."uid"()) AND ("profiles"."role" = 'platform_admin'::"text")))));



CREATE POLICY "platform_admin_bypass" ON "public"."data_export_jobs" USING ((EXISTS ( SELECT 1
   FROM "public"."profiles"
  WHERE (("profiles"."id" = "auth"."uid"()) AND ("profiles"."role" = 'platform_admin'::"text")))));



CREATE POLICY "platform_admin_bypass" ON "public"."data_retention_policies" USING ((EXISTS ( SELECT 1
   FROM "public"."profiles"
  WHERE (("profiles"."id" = "auth"."uid"()) AND ("profiles"."role" = 'platform_admin'::"text")))));



CREATE POLICY "platform_admin_bypass" ON "public"."death_registrations" USING ((EXISTS ( SELECT 1
   FROM "public"."profiles"
  WHERE (("profiles"."id" = "auth"."uid"()) AND ("profiles"."role" = 'platform_admin'::"text")))));



CREATE POLICY "platform_admin_bypass" ON "public"."death_reports" USING ((EXISTS ( SELECT 1
   FROM "public"."profiles"
  WHERE (("profiles"."id" = "auth"."uid"()) AND ("profiles"."role" = 'platform_admin'::"text")))));



CREATE POLICY "platform_admin_bypass" ON "public"."deidentification_profiles" USING ((EXISTS ( SELECT 1
   FROM "public"."profiles"
  WHERE (("profiles"."id" = "auth"."uid"()) AND ("profiles"."role" = 'platform_admin'::"text")))));



CREATE POLICY "platform_admin_bypass" ON "public"."denial_analytics_daily" USING ((EXISTS ( SELECT 1
   FROM "public"."profiles"
  WHERE (("profiles"."id" = "auth"."uid"()) AND ("profiles"."role" = 'platform_admin'::"text")))));



CREATE POLICY "platform_admin_bypass" ON "public"."departments" USING ((EXISTS ( SELECT 1
   FROM "public"."profiles"
  WHERE (("profiles"."id" = "auth"."uid"()) AND ("profiles"."role" = 'platform_admin'::"text")))));



CREATE POLICY "platform_admin_bypass" ON "public"."device_alerts" USING ((EXISTS ( SELECT 1
   FROM "public"."profiles"
  WHERE (("profiles"."id" = "auth"."uid"()) AND ("profiles"."role" = 'platform_admin'::"text")))));



CREATE POLICY "platform_admin_bypass" ON "public"."device_readings" USING ((EXISTS ( SELECT 1
   FROM "public"."profiles"
  WHERE (("profiles"."id" = "auth"."uid"()) AND ("profiles"."role" = 'platform_admin'::"text")))));



CREATE POLICY "platform_admin_bypass" ON "public"."diagnoses" USING ((EXISTS ( SELECT 1
   FROM "public"."profiles"
  WHERE (("profiles"."id" = "auth"."uid"()) AND ("profiles"."role" = 'platform_admin'::"text")))));



CREATE POLICY "platform_admin_bypass" ON "public"."drug_contraindications" USING ((EXISTS ( SELECT 1
   FROM "public"."profiles"
  WHERE (("profiles"."id" = "auth"."uid"()) AND ("profiles"."role" = 'platform_admin'::"text")))));



CREATE POLICY "platform_admin_bypass" ON "public"."drug_dose_adjustments" USING ((EXISTS ( SELECT 1
   FROM "public"."profiles"
  WHERE (("profiles"."id" = "auth"."uid"()) AND ("profiles"."role" = 'platform_admin'::"text")))));



CREATE POLICY "platform_admin_bypass" ON "public"."drug_interactions" USING ((EXISTS ( SELECT 1
   FROM "public"."profiles"
  WHERE (("profiles"."id" = "auth"."uid"()) AND ("profiles"."role" = 'platform_admin'::"text")))));



CREATE POLICY "platform_admin_bypass" ON "public"."drug_interactions_catalog" USING ((EXISTS ( SELECT 1
   FROM "public"."profiles"
  WHERE (("profiles"."id" = "auth"."uid"()) AND ("profiles"."role" = 'platform_admin'::"text")))));



CREATE POLICY "platform_admin_bypass" ON "public"."encounter_diagnoses" USING ((EXISTS ( SELECT 1
   FROM "public"."profiles"
  WHERE (("profiles"."id" = "auth"."uid"()) AND ("profiles"."role" = 'platform_admin'::"text")))));



CREATE POLICY "platform_admin_bypass" ON "public"."encounter_orders" USING ((EXISTS ( SELECT 1
   FROM "public"."profiles"
  WHERE (("profiles"."id" = "auth"."uid"()) AND ("profiles"."role" = 'platform_admin'::"text")))));



CREATE POLICY "platform_admin_bypass" ON "public"."encounters" USING ((EXISTS ( SELECT 1
   FROM "public"."profiles"
  WHERE (("profiles"."id" = "auth"."uid"()) AND ("profiles"."role" = 'platform_admin'::"text")))));



CREATE POLICY "platform_admin_bypass" ON "public"."expert_rules" USING ((EXISTS ( SELECT 1
   FROM "public"."profiles"
  WHERE (("profiles"."id" = "auth"."uid"()) AND ("profiles"."role" = 'platform_admin'::"text")))));



CREATE POLICY "platform_admin_bypass" ON "public"."gas_cylinders" USING ((EXISTS ( SELECT 1
   FROM "public"."profiles"
  WHERE (("profiles"."id" = "auth"."uid"()) AND ("profiles"."role" = 'platform_admin'::"text")))));



CREATE POLICY "platform_admin_bypass" ON "public"."handover_patient_entries" USING ((EXISTS ( SELECT 1
   FROM "public"."profiles"
  WHERE (("profiles"."id" = "auth"."uid"()) AND ("profiles"."role" = 'platform_admin'::"text")))));



CREATE POLICY "platform_admin_bypass" ON "public"."handover_shift_tasks" USING ((EXISTS ( SELECT 1
   FROM "public"."profiles"
  WHERE (("profiles"."id" = "auth"."uid"()) AND ("profiles"."role" = 'platform_admin'::"text")))));



CREATE POLICY "platform_admin_bypass" ON "public"."handover_signatures" USING ((EXISTS ( SELECT 1
   FROM "public"."profiles"
  WHERE (("profiles"."id" = "auth"."uid"()) AND ("profiles"."role" = 'platform_admin'::"text")))));



CREATE POLICY "platform_admin_bypass" ON "public"."hospital_beds" USING ((EXISTS ( SELECT 1
   FROM "public"."profiles"
  WHERE (("profiles"."id" = "auth"."uid"()) AND ("profiles"."role" = 'platform_admin'::"text")))));



CREATE POLICY "platform_admin_bypass" ON "public"."hospital_drug_orders" USING ((EXISTS ( SELECT 1
   FROM "public"."profiles"
  WHERE (("profiles"."id" = "auth"."uid"()) AND ("profiles"."role" = 'platform_admin'::"text")))));



CREATE POLICY "platform_admin_bypass" ON "public"."hospital_settings" USING ((EXISTS ( SELECT 1
   FROM "public"."profiles"
  WHERE (("profiles"."id" = "auth"."uid"()) AND ("profiles"."role" = 'platform_admin'::"text")))));



CREATE POLICY "platform_admin_bypass" ON "public"."imaging_series" USING ((EXISTS ( SELECT 1
   FROM "public"."profiles"
  WHERE (("profiles"."id" = "auth"."uid"()) AND ("profiles"."role" = 'platform_admin'::"text")))));



CREATE POLICY "platform_admin_bypass" ON "public"."imaging_studies" USING ((EXISTS ( SELECT 1
   FROM "public"."profiles"
  WHERE (("profiles"."id" = "auth"."uid"()) AND ("profiles"."role" = 'platform_admin'::"text")))));



CREATE POLICY "platform_admin_bypass" ON "public"."immunization_schedule" USING ((EXISTS ( SELECT 1
   FROM "public"."profiles"
  WHERE (("profiles"."id" = "auth"."uid"()) AND ("profiles"."role" = 'platform_admin'::"text")))));



CREATE POLICY "platform_admin_bypass" ON "public"."import_batch_rows" USING ((EXISTS ( SELECT 1
   FROM "public"."profiles"
  WHERE (("profiles"."id" = "auth"."uid"()) AND ("profiles"."role" = 'platform_admin'::"text")))));



CREATE POLICY "platform_admin_bypass" ON "public"."import_batches" USING ((EXISTS ( SELECT 1
   FROM "public"."profiles"
  WHERE (("profiles"."id" = "auth"."uid"()) AND ("profiles"."role" = 'platform_admin'::"text")))));



CREATE POLICY "platform_admin_bypass" ON "public"."import_column_mappings" USING ((EXISTS ( SELECT 1
   FROM "public"."profiles"
  WHERE (("profiles"."id" = "auth"."uid"()) AND ("profiles"."role" = 'platform_admin'::"text")))));



CREATE POLICY "platform_admin_bypass" ON "public"."insurance_claims" USING ((EXISTS ( SELECT 1
   FROM "public"."profiles"
  WHERE (("profiles"."id" = "auth"."uid"()) AND ("profiles"."role" = 'platform_admin'::"text")))));



CREATE POLICY "platform_admin_bypass" ON "public"."inventory_items" USING ((EXISTS ( SELECT 1
   FROM "public"."profiles"
  WHERE (("profiles"."id" = "auth"."uid"()) AND ("profiles"."role" = 'platform_admin'::"text")))));



CREATE POLICY "platform_admin_bypass" ON "public"."lab_results" USING ((EXISTS ( SELECT 1
   FROM "public"."profiles"
  WHERE (("profiles"."id" = "auth"."uid"()) AND ("profiles"."role" = 'platform_admin'::"text")))));



CREATE POLICY "platform_admin_bypass" ON "public"."live_feed_sessions" USING ((EXISTS ( SELECT 1
   FROM "public"."profiles"
  WHERE (("profiles"."id" = "auth"."uid"()) AND ("profiles"."role" = 'platform_admin'::"text")))));



CREATE POLICY "platform_admin_bypass" ON "public"."loinc_reference" USING ((EXISTS ( SELECT 1
   FROM "public"."profiles"
  WHERE (("profiles"."id" = "auth"."uid"()) AND ("profiles"."role" = 'platform_admin'::"text")))));



CREATE POLICY "platform_admin_bypass" ON "public"."maternity_records" USING ((EXISTS ( SELECT 1
   FROM "public"."profiles"
  WHERE (("profiles"."id" = "auth"."uid"()) AND ("profiles"."role" = 'platform_admin'::"text")))));



CREATE POLICY "platform_admin_bypass" ON "public"."medical_devices" USING ((EXISTS ( SELECT 1
   FROM "public"."profiles"
  WHERE (("profiles"."id" = "auth"."uid"()) AND ("profiles"."role" = 'platform_admin'::"text")))));



CREATE POLICY "platform_admin_bypass" ON "public"."medication_safety_checks" USING ((EXISTS ( SELECT 1
   FROM "public"."profiles"
  WHERE (("profiles"."id" = "auth"."uid"()) AND ("profiles"."role" = 'platform_admin'::"text")))));



CREATE POLICY "platform_admin_bypass" ON "public"."nin_access_log" USING ((EXISTS ( SELECT 1
   FROM "public"."profiles"
  WHERE (("profiles"."id" = "auth"."uid"()) AND ("profiles"."role" = 'platform_admin'::"text")))));



CREATE POLICY "platform_admin_bypass" ON "public"."notifications" USING ((EXISTS ( SELECT 1
   FROM "public"."profiles"
  WHERE (("profiles"."id" = "auth"."uid"()) AND ("profiles"."role" = 'platform_admin'::"text")))));



CREATE POLICY "platform_admin_bypass" ON "public"."order_items" USING ((EXISTS ( SELECT 1
   FROM "public"."profiles"
  WHERE (("profiles"."id" = "auth"."uid"()) AND ("profiles"."role" = 'platform_admin'::"text")))));



CREATE POLICY "platform_admin_bypass" ON "public"."order_mappings" USING ((EXISTS ( SELECT 1
   FROM "public"."profiles"
  WHERE (("profiles"."id" = "auth"."uid"()) AND ("profiles"."role" = 'platform_admin'::"text")))));



CREATE POLICY "platform_admin_bypass" ON "public"."orders" USING ((EXISTS ( SELECT 1
   FROM "public"."profiles"
  WHERE (("profiles"."id" = "auth"."uid"()) AND ("profiles"."role" = 'platform_admin'::"text")))));



CREATE POLICY "platform_admin_bypass" ON "public"."outreach_campaigns" USING ((EXISTS ( SELECT 1
   FROM "public"."profiles"
  WHERE (("profiles"."id" = "auth"."uid"()) AND ("profiles"."role" = 'platform_admin'::"text")))));



CREATE POLICY "platform_admin_bypass" ON "public"."passport_access_log" USING ((EXISTS ( SELECT 1
   FROM "public"."profiles"
  WHERE (("profiles"."id" = "auth"."uid"()) AND ("profiles"."role" = 'platform_admin'::"text")))));



CREATE POLICY "platform_admin_bypass" ON "public"."passport_share_tokens" USING ((EXISTS ( SELECT 1
   FROM "public"."profiles"
  WHERE (("profiles"."id" = "auth"."uid"()) AND ("profiles"."role" = 'platform_admin'::"text")))));



CREATE POLICY "platform_admin_bypass" ON "public"."pathway_alerts" USING ((EXISTS ( SELECT 1
   FROM "public"."profiles"
  WHERE (("profiles"."id" = "auth"."uid"()) AND ("profiles"."role" = 'platform_admin'::"text")))));



CREATE POLICY "platform_admin_bypass" ON "public"."pathway_checklist_items" USING ((EXISTS ( SELECT 1
   FROM "public"."profiles"
  WHERE (("profiles"."id" = "auth"."uid"()) AND ("profiles"."role" = 'platform_admin'::"text")))));



CREATE POLICY "platform_admin_bypass" ON "public"."patient_access_grants" USING ((EXISTS ( SELECT 1
   FROM "public"."profiles"
  WHERE (("profiles"."id" = "auth"."uid"()) AND ("profiles"."role" = 'platform_admin'::"text")))));



CREATE POLICY "platform_admin_bypass" ON "public"."patient_allergies" USING ((EXISTS ( SELECT 1
   FROM "public"."profiles"
  WHERE (("profiles"."id" = "auth"."uid"()) AND ("profiles"."role" = 'platform_admin'::"text")))));



CREATE POLICY "platform_admin_bypass" ON "public"."patient_billing" USING ((EXISTS ( SELECT 1
   FROM "public"."profiles"
  WHERE (("profiles"."id" = "auth"."uid"()) AND ("profiles"."role" = 'platform_admin'::"text")))));



CREATE POLICY "platform_admin_bypass" ON "public"."patient_consents" USING ((EXISTS ( SELECT 1
   FROM "public"."profiles"
  WHERE (("profiles"."id" = "auth"."uid"()) AND ("profiles"."role" = 'platform_admin'::"text")))));



CREATE POLICY "platform_admin_bypass" ON "public"."patient_notes" USING ((EXISTS ( SELECT 1
   FROM "public"."profiles"
  WHERE (("profiles"."id" = "auth"."uid"()) AND ("profiles"."role" = 'platform_admin'::"text")))));



CREATE POLICY "platform_admin_bypass" ON "public"."patient_pathways" USING ((EXISTS ( SELECT 1
   FROM "public"."profiles"
  WHERE (("profiles"."id" = "auth"."uid"()) AND ("profiles"."role" = 'platform_admin'::"text")))));



CREATE POLICY "platform_admin_bypass" ON "public"."patient_problem_list" USING ((EXISTS ( SELECT 1
   FROM "public"."profiles"
  WHERE (("profiles"."id" = "auth"."uid"()) AND ("profiles"."role" = 'platform_admin'::"text")))));



CREATE POLICY "platform_admin_bypass" ON "public"."patient_safety_events" USING ((EXISTS ( SELECT 1
   FROM "public"."profiles"
  WHERE (("profiles"."id" = "auth"."uid"()) AND ("profiles"."role" = 'platform_admin'::"text")))));



CREATE POLICY "platform_admin_bypass" ON "public"."patient_sms_reminders" USING ((EXISTS ( SELECT 1
   FROM "public"."profiles"
  WHERE (("profiles"."id" = "auth"."uid"()) AND ("profiles"."role" = 'platform_admin'::"text")))));



CREATE POLICY "platform_admin_bypass" ON "public"."patient_timeline_events" USING ((EXISTS ( SELECT 1
   FROM "public"."profiles"
  WHERE (("profiles"."id" = "auth"."uid"()) AND ("profiles"."role" = 'platform_admin'::"text")))));



CREATE POLICY "platform_admin_bypass" ON "public"."patient_timeline_pins" USING ((EXISTS ( SELECT 1
   FROM "public"."profiles"
  WHERE (("profiles"."id" = "auth"."uid"()) AND ("profiles"."role" = 'platform_admin'::"text")))));



CREATE POLICY "platform_admin_bypass" ON "public"."patient_vitals" USING ((EXISTS ( SELECT 1
   FROM "public"."profiles"
  WHERE (("profiles"."id" = "auth"."uid"()) AND ("profiles"."role" = 'platform_admin'::"text")))));



CREATE POLICY "platform_admin_bypass" ON "public"."patients" USING ((EXISTS ( SELECT 1
   FROM "public"."profiles"
  WHERE (("profiles"."id" = "auth"."uid"()) AND ("profiles"."role" = 'platform_admin'::"text")))));



CREATE POLICY "platform_admin_bypass" ON "public"."payer_contracts" USING ((EXISTS ( SELECT 1
   FROM "public"."profiles"
  WHERE (("profiles"."id" = "auth"."uid"()) AND ("profiles"."role" = 'platform_admin'::"text")))));



CREATE POLICY "platform_admin_bypass" ON "public"."pediatric_growth_records" USING ((EXISTS ( SELECT 1
   FROM "public"."profiles"
  WHERE (("profiles"."id" = "auth"."uid"()) AND ("profiles"."role" = 'platform_admin'::"text")))));



CREATE POLICY "platform_admin_bypass" ON "public"."pharmacy_stores" USING ((EXISTS ( SELECT 1
   FROM "public"."profiles"
  WHERE (("profiles"."id" = "auth"."uid"()) AND ("profiles"."role" = 'platform_admin'::"text")))));



CREATE POLICY "platform_admin_bypass" ON "public"."phi_access_log" USING ((EXISTS ( SELECT 1
   FROM "public"."profiles"
  WHERE (("profiles"."id" = "auth"."uid"()) AND ("profiles"."role" = 'platform_admin'::"text")))));



CREATE POLICY "platform_admin_bypass" ON "public"."platform_billing_config" USING ((EXISTS ( SELECT 1
   FROM "public"."profiles"
  WHERE (("profiles"."id" = "auth"."uid"()) AND ("profiles"."role" = 'platform_admin'::"text")))));



CREATE POLICY "platform_admin_bypass" ON "public"."products" USING ((EXISTS ( SELECT 1
   FROM "public"."profiles"
  WHERE (("profiles"."id" = "auth"."uid"()) AND ("profiles"."role" = 'platform_admin'::"text")))));



CREATE POLICY "platform_admin_bypass" ON "public"."provider_verification_checks" USING ((EXISTS ( SELECT 1
   FROM "public"."profiles"
  WHERE (("profiles"."id" = "auth"."uid"()) AND ("profiles"."role" = 'platform_admin'::"text")))));



CREATE POLICY "platform_admin_bypass" ON "public"."purchase_orders" USING ((EXISTS ( SELECT 1
   FROM "public"."profiles"
  WHERE (("profiles"."id" = "auth"."uid"()) AND ("profiles"."role" = 'platform_admin'::"text")))));



CREATE POLICY "platform_admin_bypass" ON "public"."radiology_report_templates" USING ((EXISTS ( SELECT 1
   FROM "public"."profiles"
  WHERE (("profiles"."id" = "auth"."uid"()) AND ("profiles"."role" = 'platform_admin'::"text")))));



CREATE POLICY "platform_admin_bypass" ON "public"."radiology_reports" USING ((EXISTS ( SELECT 1
   FROM "public"."profiles"
  WHERE (("profiles"."id" = "auth"."uid"()) AND ("profiles"."role" = 'platform_admin'::"text")))));



CREATE POLICY "platform_admin_bypass" ON "public"."referral_requests" USING ((EXISTS ( SELECT 1
   FROM "public"."profiles"
  WHERE (("profiles"."id" = "auth"."uid"()) AND ("profiles"."role" = 'platform_admin'::"text")))));



CREATE POLICY "platform_admin_bypass" ON "public"."renal_adjustments_catalog" USING ((EXISTS ( SELECT 1
   FROM "public"."profiles"
  WHERE (("profiles"."id" = "auth"."uid"()) AND ("profiles"."role" = 'platform_admin'::"text")))));



CREATE POLICY "platform_admin_bypass" ON "public"."restaurants" USING ((EXISTS ( SELECT 1
   FROM "public"."profiles"
  WHERE (("profiles"."id" = "auth"."uid"()) AND ("profiles"."role" = 'platform_admin'::"text")))));



CREATE POLICY "platform_admin_bypass" ON "public"."rule_executions" USING ((EXISTS ( SELECT 1
   FROM "public"."profiles"
  WHERE (("profiles"."id" = "auth"."uid"()) AND ("profiles"."role" = 'platform_admin'::"text")))));



CREATE POLICY "platform_admin_bypass" ON "public"."scan_events" USING ((EXISTS ( SELECT 1
   FROM "public"."profiles"
  WHERE (("profiles"."id" = "auth"."uid"()) AND ("profiles"."role" = 'platform_admin'::"text")))));



CREATE POLICY "platform_admin_bypass" ON "public"."sentinel_alerts" USING ((EXISTS ( SELECT 1
   FROM "public"."profiles"
  WHERE (("profiles"."id" = "auth"."uid"()) AND ("profiles"."role" = 'platform_admin'::"text")))));



CREATE POLICY "platform_admin_bypass" ON "public"."service_catalog" USING ((EXISTS ( SELECT 1
   FROM "public"."profiles"
  WHERE (("profiles"."id" = "auth"."uid"()) AND ("profiles"."role" = 'platform_admin'::"text")))));



CREATE POLICY "platform_admin_bypass" ON "public"."staff_attendance" USING ((EXISTS ( SELECT 1
   FROM "public"."profiles"
  WHERE (("profiles"."id" = "auth"."uid"()) AND ("profiles"."role" = 'platform_admin'::"text")))));



CREATE POLICY "platform_admin_bypass" ON "public"."staff_leave_requests" USING ((EXISTS ( SELECT 1
   FROM "public"."profiles"
  WHERE (("profiles"."id" = "auth"."uid"()) AND ("profiles"."role" = 'platform_admin'::"text")))));



CREATE POLICY "platform_admin_bypass" ON "public"."suppliers" USING ((EXISTS ( SELECT 1
   FROM "public"."profiles"
  WHERE (("profiles"."id" = "auth"."uid"()) AND ("profiles"."role" = 'platform_admin'::"text")))));



CREATE POLICY "platform_admin_bypass" ON "public"."surgery_schedules" USING ((EXISTS ( SELECT 1
   FROM "public"."profiles"
  WHERE (("profiles"."id" = "auth"."uid"()) AND ("profiles"."role" = 'platform_admin'::"text")))));



CREATE POLICY "platform_admin_bypass" ON "public"."sync_conflicts" USING ((EXISTS ( SELECT 1
   FROM "public"."profiles"
  WHERE (("profiles"."id" = "auth"."uid"()) AND ("profiles"."role" = 'platform_admin'::"text")))));



CREATE POLICY "platform_admin_bypass" ON "public"."sync_idempotency_keys" USING ((EXISTS ( SELECT 1
   FROM "public"."profiles"
  WHERE (("profiles"."id" = "auth"."uid"()) AND ("profiles"."role" = 'platform_admin'::"text")))));



CREATE POLICY "platform_admin_bypass" ON "public"."telemedicine_appointments" USING ((EXISTS ( SELECT 1
   FROM "public"."profiles"
  WHERE (("profiles"."id" = "auth"."uid"()) AND ("profiles"."role" = 'platform_admin'::"text")))));



CREATE POLICY "platform_admin_bypass" ON "public"."telemedicine_followups" USING ((EXISTS ( SELECT 1
   FROM "public"."profiles"
  WHERE (("profiles"."id" = "auth"."uid"()) AND ("profiles"."role" = 'platform_admin'::"text")))));



CREATE POLICY "platform_admin_bypass" ON "public"."telemedicine_frontdesk_queue" USING ((EXISTS ( SELECT 1
   FROM "public"."profiles"
  WHERE (("profiles"."id" = "auth"."uid"()) AND ("profiles"."role" = 'platform_admin'::"text")))));



CREATE POLICY "platform_admin_bypass" ON "public"."telemedicine_intake_cases" USING ((EXISTS ( SELECT 1
   FROM "public"."profiles"
  WHERE (("profiles"."id" = "auth"."uid"()) AND ("profiles"."role" = 'platform_admin'::"text")))));



CREATE POLICY "platform_admin_bypass" ON "public"."telemedicine_intake_messages" USING ((EXISTS ( SELECT 1
   FROM "public"."profiles"
  WHERE (("profiles"."id" = "auth"."uid"()) AND ("profiles"."role" = 'platform_admin'::"text")))));



CREATE POLICY "platform_admin_bypass" ON "public"."telemedicine_providers" USING ((EXISTS ( SELECT 1
   FROM "public"."profiles"
  WHERE (("profiles"."id" = "auth"."uid"()) AND ("profiles"."role" = 'platform_admin'::"text")))));



CREATE POLICY "platform_admin_bypass" ON "public"."telemedicine_session_events" USING ((EXISTS ( SELECT 1
   FROM "public"."profiles"
  WHERE (("profiles"."id" = "auth"."uid"()) AND ("profiles"."role" = 'platform_admin'::"text")))));



CREATE POLICY "platform_admin_bypass" ON "public"."telemedicine_staff_alerts" USING ((EXISTS ( SELECT 1
   FROM "public"."profiles"
  WHERE (("profiles"."id" = "auth"."uid"()) AND ("profiles"."role" = 'platform_admin'::"text")))));



CREATE POLICY "platform_admin_bypass" ON "public"."telemedicine_voice_memos" USING ((EXISTS ( SELECT 1
   FROM "public"."profiles"
  WHERE (("profiles"."id" = "auth"."uid"()) AND ("profiles"."role" = 'platform_admin'::"text")))));



CREATE POLICY "platform_admin_bypass" ON "public"."tenant_domains" USING ((EXISTS ( SELECT 1
   FROM "public"."profiles"
  WHERE (("profiles"."id" = "auth"."uid"()) AND ("profiles"."role" = 'platform_admin'::"text")))));



CREATE POLICY "platform_admin_bypass" ON "public"."tenant_logging_policies" USING ((EXISTS ( SELECT 1
   FROM "public"."profiles"
  WHERE (("profiles"."id" = "auth"."uid"()) AND ("profiles"."role" = 'platform_admin'::"text")))));



CREATE POLICY "platform_admin_bypass" ON "public"."tenant_provisioning_jobs" USING ((EXISTS ( SELECT 1
   FROM "public"."profiles"
  WHERE (("profiles"."id" = "auth"."uid"()) AND ("profiles"."role" = 'platform_admin'::"text")))));



CREATE POLICY "platform_admin_bypass" ON "public"."tenants" USING ((EXISTS ( SELECT 1
   FROM "public"."profiles"
  WHERE (("profiles"."id" = "auth"."uid"()) AND ("profiles"."role" = 'platform_admin'::"text")))));



CREATE POLICY "platform_admin_bypass" ON "public"."ucg_guidelines" USING ((EXISTS ( SELECT 1
   FROM "public"."profiles"
  WHERE (("profiles"."id" = "auth"."uid"()) AND ("profiles"."role" = 'platform_admin'::"text")))));



CREATE POLICY "platform_admin_bypass" ON "public"."verification_documents" USING ((EXISTS ( SELECT 1
   FROM "public"."profiles"
  WHERE (("profiles"."id" = "auth"."uid"()) AND ("profiles"."role" = 'platform_admin'::"text")))));



CREATE POLICY "platform_admin_bypass" ON "public"."vitals" USING ((EXISTS ( SELECT 1
   FROM "public"."profiles"
  WHERE (("profiles"."id" = "auth"."uid"()) AND ("profiles"."role" = 'platform_admin'::"text")))));



CREATE POLICY "platform_admin_bypass" ON "public"."wards" USING ((EXISTS ( SELECT 1
   FROM "public"."profiles"
  WHERE (("profiles"."id" = "auth"."uid"()) AND ("profiles"."role" = 'platform_admin'::"text")))));



CREATE POLICY "platform_admin_full" ON "public"."pharmacy_onboarding" USING ((EXISTS ( SELECT 1
   FROM "public"."profiles"
  WHERE (("profiles"."id" = "auth"."uid"()) AND ("profiles"."role" = 'platform_admin'::"text")))));



CREATE POLICY "platform_admin_full_access" ON "public"."support_ticket_events" USING (false);



CREATE POLICY "platform_admin_full_access" ON "public"."support_tickets" USING (false);



CREATE POLICY "platform_admin_only" ON "public"."hospital_leads" USING ((EXISTS ( SELECT 1
   FROM "public"."profiles"
  WHERE (("profiles"."id" = "auth"."uid"()) AND ("profiles"."role" = 'platform_admin'::"text")))));



CREATE POLICY "platform_admin_pharmacy_inventory" ON "public"."pharmacy_network_inventory" USING ((EXISTS ( SELECT 1
   FROM "public"."profiles"
  WHERE (("profiles"."id" = "auth"."uid"()) AND ("profiles"."role" = 'platform_admin'::"text")))));



CREATE POLICY "platform_admin_pharmacy_profiles" ON "public"."pharmacy_profiles" USING ((EXISTS ( SELECT 1
   FROM "public"."profiles"
  WHERE (("profiles"."id" = "auth"."uid"()) AND ("profiles"."role" = 'platform_admin'::"text")))));



CREATE POLICY "platform_admin_read" ON "public"."apk_waitlist" FOR SELECT USING ((EXISTS ( SELECT 1
   FROM "public"."profiles"
  WHERE (("profiles"."id" = "auth"."uid"()) AND ("profiles"."role" = 'platform_admin'::"text")))));



ALTER TABLE "public"."platform_approvals" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "platform_approvals_service_all" ON "public"."platform_approvals" TO "service_role" USING (true) WITH CHECK (true);



ALTER TABLE "public"."platform_audit_events" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "platform_audit_events_tenant_isolation" ON "public"."platform_audit_events" USING ((("tenant_id" = "public"."current_tenant_id"()) OR "public"."is_platform_admin"())) WITH CHECK ((("tenant_id" = "public"."current_tenant_id"()) OR "public"."is_platform_admin"()));



CREATE POLICY "platform_audit_service_read" ON "public"."platform_audit_events" FOR SELECT TO "service_role" USING (true);



CREATE POLICY "platform_audit_service_write" ON "public"."platform_audit_events" FOR INSERT TO "service_role" WITH CHECK (true);



ALTER TABLE "public"."platform_billing_config" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."platform_broadcasts" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "platform_broadcasts_service_all" ON "public"."platform_broadcasts" TO "service_role" USING (true) WITH CHECK (true);



ALTER TABLE "public"."platform_feature_flags" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "platform_feature_flags_service_all" ON "public"."platform_feature_flags" TO "service_role" USING (true) WITH CHECK (true);



ALTER TABLE "public"."platform_health_checks" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."platform_incidents" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "platform_incidents_service_all" ON "public"."platform_incidents" TO "service_role" USING (true) WITH CHECK (true);



ALTER TABLE "public"."platform_invitations" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "platform_invitations_service" ON "public"."platform_invitations" USING (false) WITH CHECK (false);



ALTER TABLE "public"."platform_memberships" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "platform_memberships_service" ON "public"."platform_memberships" USING (false) WITH CHECK (false);



ALTER TABLE "public"."platform_module_matrix" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "platform_module_matrix_tenant_isolation" ON "public"."platform_module_matrix" USING ((("tenant_id" = "public"."current_tenant_id"()) OR "public"."is_platform_admin"())) WITH CHECK ((("tenant_id" = "public"."current_tenant_id"()) OR "public"."is_platform_admin"()));



ALTER TABLE "public"."platform_releases" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "platform_releases_service_all" ON "public"."platform_releases" TO "service_role" USING (true) WITH CHECK (true);



ALTER TABLE "public"."platform_support_sessions" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "platform_support_sessions_service_all" ON "public"."platform_support_sessions" TO "service_role" USING (true) WITH CHECK (true);



ALTER TABLE "public"."platform_support_tickets" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "platform_support_tickets_service_all" ON "public"."platform_support_tickets" TO "service_role" USING (true) WITH CHECK (true);



ALTER TABLE "public"."platform_test_runs" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "platform_test_runs_service_all" ON "public"."platform_test_runs" TO "service_role" USING (true) WITH CHECK (true);



CREATE POLICY "problem_list_staff_all" ON "public"."patient_problem_list" USING ((("auth"."role"() = 'service_role'::"text") OR (EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."id" = "auth"."uid"()) AND ("p"."role" = ANY (ARRAY['admin'::"text", 'doctor'::"text", 'nurse'::"text", 'clinician'::"text"]))))))) WITH CHECK ((("auth"."role"() = 'service_role'::"text") OR (EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."id" = "auth"."uid"()) AND ("p"."role" = ANY (ARRAY['admin'::"text", 'doctor'::"text", 'nurse'::"text", 'clinician'::"text"])))))));



ALTER TABLE "public"."products" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."professional_leads" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."profiles" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "profiles_delete_platform_only" ON "public"."profiles" FOR DELETE USING ("public"."is_platform_admin"());



CREATE POLICY "profiles_insert_own_or_platform" ON "public"."profiles" FOR INSERT WITH CHECK ((("id" = "auth"."uid"()) OR "public"."is_platform_admin"()));



CREATE POLICY "profiles_select_identity_or_tenant" ON "public"."profiles" FOR SELECT USING ((("id" = "auth"."uid"()) OR "public"."is_platform_admin"() OR (("tenant_id" IS NOT NULL) AND ("tenant_id" = "public"."current_tenant_id"())) OR (("hospital_id" IS NOT NULL) AND ("hospital_id" = "public"."current_hospital_id"()))));



CREATE POLICY "profiles_update_own_or_platform" ON "public"."profiles" FOR UPDATE USING ((("id" = "auth"."uid"()) OR "public"."is_platform_admin"())) WITH CHECK ((("id" = "auth"."uid"()) OR "public"."is_platform_admin"()));



ALTER TABLE "public"."provider_verification_checks" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "provider_verification_checks_admin_mutate" ON "public"."provider_verification_checks" USING ((EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."id" = "auth"."uid"()) AND ("p"."role" = 'admin'::"text"))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."id" = "auth"."uid"()) AND ("p"."role" = 'admin'::"text")))));



CREATE POLICY "provider_verification_checks_read_authenticated" ON "public"."provider_verification_checks" FOR SELECT USING (("auth"."role"() = 'authenticated'::"text"));



CREATE POLICY "public_invite_lookup" ON "public"."pharmacy_onboarding" FOR SELECT USING ((("current_step" = 0) AND ("invite_expires_at" > "now"())));



ALTER TABLE "public"."purchase_orders" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "queue_read_by_token" ON "public"."consult_queue" FOR SELECT USING (true);



CREATE POLICY "queue_service_write" ON "public"."consult_queue" USING (("auth"."role"() = 'service_role'::"text"));



CREATE POLICY "ract_rw_authenticated" ON "public"."reasoning_actions" USING (("auth"."role"() = 'authenticated'::"text"));



ALTER TABLE "public"."radiology_report_templates" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."radiology_reports" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "radiology_reports_read" ON "public"."radiology_reports" FOR SELECT USING ((("auth"."role"() = 'service_role'::"text") OR (EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."id" = "auth"."uid"()) AND (("p"."hospital_id" = "p"."hospital_id") OR ("p"."role" = 'admin'::"text")))))));



CREATE POLICY "radiology_reports_staff_write" ON "public"."radiology_reports" USING ((("auth"."role"() = 'service_role'::"text") OR (EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."id" = "auth"."uid"()) AND ("p"."role" = ANY (ARRAY['admin'::"text", 'doctor'::"text", 'radiographer'::"text"]))))))) WITH CHECK ((("auth"."role"() = 'service_role'::"text") OR (EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."id" = "auth"."uid"()) AND ("p"."role" = ANY (ARRAY['admin'::"text", 'doctor'::"text", 'radiographer'::"text"])))))));



CREATE POLICY "raud_read_authenticated" ON "public"."reasoning_audit" FOR SELECT USING (("auth"."role"() = 'authenticated'::"text"));



CREATE POLICY "rc_read_authenticated" ON "public"."role_capabilities" FOR SELECT USING (("auth"."role"() = 'authenticated'::"text"));



ALTER TABLE "public"."reasoning_actions" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."reasoning_audit" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."reasoning_context_snapshots" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."reasoning_evidence" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."reasoning_evidence_impact" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."reasoning_hypotheses" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."reasoning_sessions" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "reasoning_snapshots_tenant" ON "public"."reasoning_context_snapshots" USING ("public"."same_tenant"("tenant_id")) WITH CHECK ("public"."same_tenant"("tenant_id"));



ALTER TABLE "public"."referral_requests" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "referrals_hospital_isolation" ON "public"."referral_requests" USING ((("from_hospital_id" = ( SELECT "profiles"."hospital_id"
   FROM "public"."profiles"
  WHERE ("profiles"."id" = "auth"."uid"())
 LIMIT 1)) OR ("to_hospital_id" = ( SELECT "profiles"."hospital_id"
   FROM "public"."profiles"
  WHERE ("profiles"."id" = "auth"."uid"())
 LIMIT 1))));



ALTER TABLE "public"."refill_reminders" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "refill_tenant" ON "public"."refill_reminders" USING ((("tenant_id" = "public"."current_tenant_id"()) OR "public"."is_platform_admin"()));



CREATE POLICY "reimp_rw_authenticated" ON "public"."reasoning_evidence_impact" USING (("auth"."role"() = 'authenticated'::"text"));



ALTER TABLE "public"."renal_adjustments_catalog" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "renal_adjustments_catalog_read_authenticated" ON "public"."renal_adjustments_catalog" FOR SELECT USING (("auth"."role"() = 'authenticated'::"text"));



ALTER TABLE "public"."restaurants" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "retention_policies_admin_all" ON "public"."data_retention_policies" USING ((("auth"."role"() = 'service_role'::"text") OR (EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."id" = "auth"."uid"()) AND ("p"."role" = 'admin'::"text")))))) WITH CHECK ((("auth"."role"() = 'service_role'::"text") OR (EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."id" = "auth"."uid"()) AND ("p"."role" = 'admin'::"text"))))));



CREATE POLICY "revi_rw_authenticated" ON "public"."reasoning_evidence" USING (("auth"."role"() = 'authenticated'::"text"));



CREATE POLICY "rh_read_authenticated" ON "public"."role_hierarchy" FOR SELECT USING (("auth"."role"() = 'authenticated'::"text"));



CREATE POLICY "rhyp_rw_authenticated" ON "public"."reasoning_hypotheses" USING (("auth"."role"() = 'authenticated'::"text"));



ALTER TABLE "public"."role_capabilities" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."role_hierarchy" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "rsess_rw_authenticated" ON "public"."reasoning_sessions" USING (("auth"."role"() = 'authenticated'::"text"));



ALTER TABLE "public"."rule_executions" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "rule_executions_admin_only" ON "public"."rule_executions" USING ((EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."id" = "auth"."uid"()) AND ("p"."role" = 'admin'::"text"))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."id" = "auth"."uid"()) AND ("p"."role" = 'admin'::"text")))));



ALTER TABLE "public"."scan_events" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "scan_events_staff_all" ON "public"."scan_events" USING ((("auth"."role"() = 'service_role'::"text") OR (EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."id" = "auth"."uid"()) AND ("p"."hospital_id" = "p"."hospital_id")))))) WITH CHECK ((("auth"."role"() = 'service_role'::"text") OR (EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."id" = "auth"."uid"()) AND ("p"."hospital_id" = "p"."hospital_id"))))));



ALTER TABLE "public"."score_calculations" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."score_definitions" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."sdg_indicators" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "sdg_indicators_isolation" ON "public"."sdg_indicators" FOR SELECT USING (("hospital_id" = ( SELECT "profiles"."hospital_id"
   FROM "public"."profiles"
  WHERE ("profiles"."id" = "auth"."uid"()))));



CREATE POLICY "sdg_platform_admin" ON "public"."sdg_reports" USING ("public"."is_platform_admin"());



ALTER TABLE "public"."sdg_reports" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."sentinel_alerts" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "sentinel_alerts_hospital_isolation" ON "public"."sentinel_alerts" USING (("hospital_id" = ( SELECT "profiles"."hospital_id"
   FROM "public"."profiles"
  WHERE ("profiles"."id" = "auth"."uid"())
 LIMIT 1)));



CREATE POLICY "service role reads all" ON "public"."professional_leads" FOR SELECT USING (("auth"."role"() = 'authenticated'::"text"));



ALTER TABLE "public"."service_catalog" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "sessions_service_insert" ON "public"."synapse_sessions" FOR INSERT WITH CHECK (("auth"."role"() = 'service_role'::"text"));



CREATE POLICY "sms_reminders_service_role" ON "public"."patient_sms_reminders" USING ((("auth"."role"() = 'service_role'::"text") OR (EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."id" = "auth"."uid"()) AND ("p"."hospital_id" = "p"."hospital_id") AND ("p"."role" = ANY (ARRAY['admin'::"text", 'nurse'::"text", 'doctor'::"text"]))))))) WITH CHECK (("auth"."role"() = 'service_role'::"text"));



ALTER TABLE "public"."staff_attendance" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."staff_invitations" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."staff_leave_requests" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."staff_scope_assignments" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "staff_scope_assignments_self_or_admin" ON "public"."staff_scope_assignments" USING (("public"."is_platform_admin"() OR ("profile_id" = "auth"."uid"()) OR ("tenant_id" = "public"."current_tenant_id"()))) WITH CHECK (("public"."is_platform_admin"() OR ("tenant_id" = "public"."current_tenant_id"())));



ALTER TABLE "public"."subscription_events" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "subscription_events_tenant_read" ON "public"."subscription_events" FOR SELECT USING (("tenant_id" IN ( SELECT "profiles"."tenant_id"
   FROM "public"."profiles"
  WHERE ("profiles"."id" = "auth"."uid"()))));



ALTER TABLE "public"."subscription_grants" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."subscription_invoices" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "subscription_invoices_tenant_read" ON "public"."subscription_invoices" FOR SELECT USING (("tenant_id" IN ( SELECT "profiles"."tenant_id"
   FROM "public"."profiles"
  WHERE ("profiles"."id" = "auth"."uid"()))));



ALTER TABLE "public"."subscription_payments" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "subscription_payments_tenant_read" ON "public"."subscription_payments" FOR SELECT USING (("tenant_id" IN ( SELECT "profiles"."tenant_id"
   FROM "public"."profiles"
  WHERE ("profiles"."id" = "auth"."uid"()))));



ALTER TABLE "public"."subscription_plans" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "subscription_plans_read" ON "public"."subscription_plans" FOR SELECT USING (true);



ALTER TABLE "public"."suppliers" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."support_ticket_events" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."support_tickets" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."surgery_schedules" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "surveillance_insert" ON "public"."surveillance_reports" FOR INSERT WITH CHECK (("tenant_id" = "public"."current_tenant_id"()));



CREATE POLICY "surveillance_read" ON "public"."surveillance_reports" FOR SELECT USING ((("tenant_id" = "public"."current_tenant_id"()) OR "public"."is_platform_admin"()));



ALTER TABLE "public"."surveillance_reports" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."synapse_adapters" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."synapse_domain_events" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "synapse_domain_events_tenant_isolation" ON "public"."synapse_domain_events" USING ((("tenant_id" = "public"."current_tenant_id"()) OR "public"."is_platform_admin"())) WITH CHECK ((("tenant_id" = "public"."current_tenant_id"()) OR "public"."is_platform_admin"()));



ALTER TABLE "public"."synapse_sessions" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."synapse_simulation_runs" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "synapse_simulation_runs_tenant_isolation" ON "public"."synapse_simulation_runs" USING ((("tenant_id" = "public"."current_tenant_id"()) OR "public"."is_platform_admin"())) WITH CHECK ((("tenant_id" = "public"."current_tenant_id"()) OR "public"."is_platform_admin"()));



ALTER TABLE "public"."sync_conflicts" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "sync_conflicts_hospital_isolation" ON "public"."sync_conflicts" USING (("hospital_id" = ( SELECT "profiles"."hospital_id"
   FROM "public"."profiles"
  WHERE ("profiles"."id" = "auth"."uid"())
 LIMIT 1)));



ALTER TABLE "public"."sync_idempotency_keys" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "sync_idempotency_keys_service_role_only" ON "public"."sync_idempotency_keys" TO "service_role" USING (true) WITH CHECK (true);



ALTER TABLE "public"."tele_sessions" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."telemedicine_appointments" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "telemedicine_appointments_admin_update" ON "public"."telemedicine_appointments" FOR UPDATE USING (("auth"."role"() = 'authenticated'::"text")) WITH CHECK (("auth"."role"() = 'authenticated'::"text"));



CREATE POLICY "telemedicine_appointments_insert_authenticated" ON "public"."telemedicine_appointments" FOR INSERT WITH CHECK (("auth"."role"() = 'authenticated'::"text"));



CREATE POLICY "telemedicine_appointments_read_authenticated" ON "public"."telemedicine_appointments" FOR SELECT USING (("auth"."role"() = 'authenticated'::"text"));



ALTER TABLE "public"."telemedicine_followups" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "telemedicine_followups_admin_worker_all" ON "public"."telemedicine_followups" USING ((("auth"."role"() = 'service_role'::"text") OR (EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."id" = "auth"."uid"()) AND ("p"."role" = 'admin'::"text")))))) WITH CHECK ((("auth"."role"() = 'service_role'::"text") OR (EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."id" = "auth"."uid"()) AND ("p"."role" = 'admin'::"text"))))));



ALTER TABLE "public"."telemedicine_frontdesk_queue" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "telemedicine_frontdesk_queue_staff_all" ON "public"."telemedicine_frontdesk_queue" USING ((("auth"."role"() = 'authenticated'::"text") AND (EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."id" = "auth"."uid"()) AND ("p"."role" = ANY (ARRAY['admin'::"text", 'receptionist'::"text", 'doctor'::"text", 'nurse'::"text", 'clinician'::"text"]))))))) WITH CHECK ((("auth"."role"() = 'authenticated'::"text") AND (EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."id" = "auth"."uid"()) AND ("p"."role" = ANY (ARRAY['admin'::"text", 'receptionist'::"text", 'doctor'::"text", 'nurse'::"text", 'clinician'::"text"])))))));



ALTER TABLE "public"."telemedicine_intake_cases" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "telemedicine_intake_cases_user_insert" ON "public"."telemedicine_intake_cases" FOR INSERT WITH CHECK ((("auth"."role"() = 'authenticated'::"text") AND ("user_id" = "auth"."uid"())));



CREATE POLICY "telemedicine_intake_cases_user_read" ON "public"."telemedicine_intake_cases" FOR SELECT USING ((("auth"."role"() = 'authenticated'::"text") AND (("user_id" = "auth"."uid"()) OR (EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."id" = "auth"."uid"()) AND ("p"."role" = ANY (ARRAY['admin'::"text", 'receptionist'::"text", 'doctor'::"text", 'nurse'::"text", 'clinician'::"text"]))))))));



CREATE POLICY "telemedicine_intake_cases_user_update" ON "public"."telemedicine_intake_cases" FOR UPDATE USING ((("auth"."role"() = 'authenticated'::"text") AND (("user_id" = "auth"."uid"()) OR (EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."id" = "auth"."uid"()) AND ("p"."role" = ANY (ARRAY['admin'::"text", 'receptionist'::"text", 'doctor'::"text", 'nurse'::"text", 'clinician'::"text"])))))))) WITH CHECK ((("auth"."role"() = 'authenticated'::"text") AND (("user_id" = "auth"."uid"()) OR (EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."id" = "auth"."uid"()) AND ("p"."role" = ANY (ARRAY['admin'::"text", 'receptionist'::"text", 'doctor'::"text", 'nurse'::"text", 'clinician'::"text"]))))))));



ALTER TABLE "public"."telemedicine_intake_messages" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "telemedicine_intake_messages_user_insert" ON "public"."telemedicine_intake_messages" FOR INSERT WITH CHECK ((("auth"."role"() = 'authenticated'::"text") AND (EXISTS ( SELECT 1
   FROM "public"."telemedicine_intake_cases" "c"
  WHERE (("c"."id" = "telemedicine_intake_messages"."case_id") AND (("c"."user_id" = "auth"."uid"()) OR (EXISTS ( SELECT 1
           FROM "public"."profiles" "p"
          WHERE (("p"."id" = "auth"."uid"()) AND ("p"."role" = ANY (ARRAY['admin'::"text", 'receptionist'::"text", 'doctor'::"text", 'nurse'::"text", 'clinician'::"text"])))))))))));



CREATE POLICY "telemedicine_intake_messages_user_read" ON "public"."telemedicine_intake_messages" FOR SELECT USING ((("auth"."role"() = 'authenticated'::"text") AND (EXISTS ( SELECT 1
   FROM "public"."telemedicine_intake_cases" "c"
  WHERE (("c"."id" = "telemedicine_intake_messages"."case_id") AND (("c"."user_id" = "auth"."uid"()) OR (EXISTS ( SELECT 1
           FROM "public"."profiles" "p"
          WHERE (("p"."id" = "auth"."uid"()) AND ("p"."role" = ANY (ARRAY['admin'::"text", 'receptionist'::"text", 'doctor'::"text", 'nurse'::"text", 'clinician'::"text"])))))))))));



ALTER TABLE "public"."telemedicine_providers" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "telemedicine_providers_admin_mutate" ON "public"."telemedicine_providers" USING ((EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."id" = "auth"."uid"()) AND ("p"."role" = 'admin'::"text"))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."id" = "auth"."uid"()) AND ("p"."role" = 'admin'::"text")))));



CREATE POLICY "telemedicine_providers_read_authenticated" ON "public"."telemedicine_providers" FOR SELECT USING (("auth"."role"() = 'authenticated'::"text"));



ALTER TABLE "public"."telemedicine_session_events" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "telemedicine_session_events_insert_authenticated" ON "public"."telemedicine_session_events" FOR INSERT WITH CHECK (("auth"."role"() = 'authenticated'::"text"));



CREATE POLICY "telemedicine_session_events_read_authenticated" ON "public"."telemedicine_session_events" FOR SELECT USING (("auth"."role"() = 'authenticated'::"text"));



ALTER TABLE "public"."telemedicine_staff_alerts" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "telemedicine_staff_alerts_staff_read" ON "public"."telemedicine_staff_alerts" FOR SELECT USING ((("auth"."role"() = 'service_role'::"text") OR (EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."id" = "auth"."uid"()) AND ("p"."role" = ANY (ARRAY['admin'::"text", 'doctor'::"text", 'nurse'::"text", 'front_desk'::"text"])))))));



CREATE POLICY "telemedicine_staff_alerts_staff_update" ON "public"."telemedicine_staff_alerts" FOR UPDATE USING ((("auth"."role"() = 'service_role'::"text") OR (EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."id" = "auth"."uid"()) AND ("p"."role" = ANY (ARRAY['admin'::"text", 'doctor'::"text", 'nurse'::"text", 'front_desk'::"text"]))))))) WITH CHECK ((("auth"."role"() = 'service_role'::"text") OR (EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."id" = "auth"."uid"()) AND ("p"."role" = ANY (ARRAY['admin'::"text", 'doctor'::"text", 'nurse'::"text", 'front_desk'::"text"])))))));



ALTER TABLE "public"."telemedicine_voice_memos" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "telemedicine_voice_memos_access" ON "public"."telemedicine_voice_memos" USING ((("auth"."role"() = 'service_role'::"text") OR ("auth"."role"() = 'authenticated'::"text"))) WITH CHECK ((("auth"."role"() = 'service_role'::"text") OR ("auth"."role"() = 'authenticated'::"text")));



ALTER TABLE "public"."tenant_domains" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "tenant_domains_mutate_admin" ON "public"."tenant_domains" USING ((EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."id" = "auth"."uid"()) AND ("p"."role" = 'admin'::"text"))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."id" = "auth"."uid"()) AND ("p"."role" = 'admin'::"text")))));



CREATE POLICY "tenant_domains_read_authenticated" ON "public"."tenant_domains" FOR SELECT USING (("auth"."role"() = 'authenticated'::"text"));



CREATE POLICY "tenant_feat_overrides_read" ON "public"."tenant_feature_overrides" FOR SELECT USING (("tenant_id" IN ( SELECT "profiles"."tenant_id"
   FROM "public"."profiles"
  WHERE ("profiles"."id" = "auth"."uid"()))));



ALTER TABLE "public"."tenant_feature_overrides" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "tenant_isolation" ON "public"."aefi_reports" USING (("tenant_id" = ( SELECT "profiles"."tenant_id"
   FROM "public"."profiles"
  WHERE ("profiles"."id" = "auth"."uid"()))));



CREATE POLICY "tenant_isolation" ON "public"."allergens_catalog" USING (("tenant_id" = ( SELECT "profiles"."tenant_id"
   FROM "public"."profiles"
  WHERE ("profiles"."id" = "auth"."uid"()))));



CREATE POLICY "tenant_isolation" ON "public"."audit_events" USING (("tenant_id" = ( SELECT "profiles"."tenant_id"
   FROM "public"."profiles"
  WHERE ("profiles"."id" = "auth"."uid"()))));



CREATE POLICY "tenant_isolation" ON "public"."audit_log" USING (("tenant_id" = ( SELECT "profiles"."tenant_id"
   FROM "public"."profiles"
  WHERE ("profiles"."id" = "auth"."uid"()))));



CREATE POLICY "tenant_isolation" ON "public"."bed_assignments" USING (("tenant_id" = ( SELECT "profiles"."tenant_id"
   FROM "public"."profiles"
  WHERE ("profiles"."id" = "auth"."uid"()))));



CREATE POLICY "tenant_isolation" ON "public"."beta_access_requests" USING (("tenant_id" = ( SELECT "profiles"."tenant_id"
   FROM "public"."profiles"
  WHERE ("profiles"."id" = "auth"."uid"()))));



CREATE POLICY "tenant_isolation" ON "public"."billing_invoices" USING (("tenant_id" = ( SELECT "profiles"."tenant_id"
   FROM "public"."profiles"
  WHERE ("profiles"."id" = "auth"."uid"()))));



CREATE POLICY "tenant_isolation" ON "public"."billing_line_items" USING (("tenant_id" = ( SELECT "profiles"."tenant_id"
   FROM "public"."profiles"
  WHERE ("profiles"."id" = "auth"."uid"()))));



CREATE POLICY "tenant_isolation" ON "public"."care_team_handovers" USING (("tenant_id" = ( SELECT "profiles"."tenant_id"
   FROM "public"."profiles"
  WHERE ("profiles"."id" = "auth"."uid"()))));



CREATE POLICY "tenant_isolation" ON "public"."cds_alerts" USING (("tenant_id" = ( SELECT "profiles"."tenant_id"
   FROM "public"."profiles"
  WHERE ("profiles"."id" = "auth"."uid"()))));



CREATE POLICY "tenant_isolation" ON "public"."cds_rules" USING (("tenant_id" = ( SELECT "profiles"."tenant_id"
   FROM "public"."profiles"
  WHERE ("profiles"."id" = "auth"."uid"()))));



CREATE POLICY "tenant_isolation" ON "public"."chw_visits" USING (("tenant_id" = ( SELECT "profiles"."tenant_id"
   FROM "public"."profiles"
  WHERE ("profiles"."id" = "auth"."uid"()))));



CREATE POLICY "tenant_isolation" ON "public"."claim_line_items" USING (("tenant_id" = ( SELECT "profiles"."tenant_id"
   FROM "public"."profiles"
  WHERE ("profiles"."id" = "auth"."uid"()))));



CREATE POLICY "tenant_isolation" ON "public"."claim_resubmissions" USING (("tenant_id" = ( SELECT "profiles"."tenant_id"
   FROM "public"."profiles"
  WHERE ("profiles"."id" = "auth"."uid"()))));



CREATE POLICY "tenant_isolation" ON "public"."clinical_pathway_templates" USING (("tenant_id" = ( SELECT "profiles"."tenant_id"
   FROM "public"."profiles"
  WHERE ("profiles"."id" = "auth"."uid"()))));



CREATE POLICY "tenant_isolation" ON "public"."community_health_workers" USING (("tenant_id" = ( SELECT "profiles"."tenant_id"
   FROM "public"."profiles"
  WHERE ("profiles"."id" = "auth"."uid"()))));



CREATE POLICY "tenant_isolation" ON "public"."consent_audit_log" USING (("tenant_id" = ( SELECT "profiles"."tenant_id"
   FROM "public"."profiles"
  WHERE ("profiles"."id" = "auth"."uid"()))));



CREATE POLICY "tenant_isolation" ON "public"."data_breach_incidents" USING (("tenant_id" = ( SELECT "profiles"."tenant_id"
   FROM "public"."profiles"
  WHERE ("profiles"."id" = "auth"."uid"()))));



CREATE POLICY "tenant_isolation" ON "public"."data_export_jobs" USING (("tenant_id" = ( SELECT "profiles"."tenant_id"
   FROM "public"."profiles"
  WHERE ("profiles"."id" = "auth"."uid"()))));



CREATE POLICY "tenant_isolation" ON "public"."data_retention_policies" USING (("tenant_id" = ( SELECT "profiles"."tenant_id"
   FROM "public"."profiles"
  WHERE ("profiles"."id" = "auth"."uid"()))));



CREATE POLICY "tenant_isolation" ON "public"."death_registrations" USING (("tenant_id" = ( SELECT "profiles"."tenant_id"
   FROM "public"."profiles"
  WHERE ("profiles"."id" = "auth"."uid"()))));



CREATE POLICY "tenant_isolation" ON "public"."death_reports" USING (("tenant_id" = ( SELECT "profiles"."tenant_id"
   FROM "public"."profiles"
  WHERE ("profiles"."id" = "auth"."uid"()))));



CREATE POLICY "tenant_isolation" ON "public"."deidentification_profiles" USING (("tenant_id" = ( SELECT "profiles"."tenant_id"
   FROM "public"."profiles"
  WHERE ("profiles"."id" = "auth"."uid"()))));



CREATE POLICY "tenant_isolation" ON "public"."denial_analytics_daily" USING (("tenant_id" = ( SELECT "profiles"."tenant_id"
   FROM "public"."profiles"
  WHERE ("profiles"."id" = "auth"."uid"()))));



CREATE POLICY "tenant_isolation" ON "public"."departments" USING (("tenant_id" = ( SELECT "profiles"."tenant_id"
   FROM "public"."profiles"
  WHERE ("profiles"."id" = "auth"."uid"()))));



CREATE POLICY "tenant_isolation" ON "public"."device_alerts" USING (("tenant_id" = ( SELECT "profiles"."tenant_id"
   FROM "public"."profiles"
  WHERE ("profiles"."id" = "auth"."uid"()))));



CREATE POLICY "tenant_isolation" ON "public"."device_readings" USING (("tenant_id" = ( SELECT "profiles"."tenant_id"
   FROM "public"."profiles"
  WHERE ("profiles"."id" = "auth"."uid"()))));



CREATE POLICY "tenant_isolation" ON "public"."diagnoses" USING (("tenant_id" = ( SELECT "profiles"."tenant_id"
   FROM "public"."profiles"
  WHERE ("profiles"."id" = "auth"."uid"()))));



CREATE POLICY "tenant_isolation" ON "public"."drug_contraindications" USING (("tenant_id" = ( SELECT "profiles"."tenant_id"
   FROM "public"."profiles"
  WHERE ("profiles"."id" = "auth"."uid"()))));



CREATE POLICY "tenant_isolation" ON "public"."drug_dose_adjustments" USING (("tenant_id" = ( SELECT "profiles"."tenant_id"
   FROM "public"."profiles"
  WHERE ("profiles"."id" = "auth"."uid"()))));



CREATE POLICY "tenant_isolation" ON "public"."drug_interactions" USING (("tenant_id" = ( SELECT "profiles"."tenant_id"
   FROM "public"."profiles"
  WHERE ("profiles"."id" = "auth"."uid"()))));



CREATE POLICY "tenant_isolation" ON "public"."drug_interactions_catalog" USING (("tenant_id" = ( SELECT "profiles"."tenant_id"
   FROM "public"."profiles"
  WHERE ("profiles"."id" = "auth"."uid"()))));



CREATE POLICY "tenant_isolation" ON "public"."encounter_diagnoses" USING (("tenant_id" = ( SELECT "profiles"."tenant_id"
   FROM "public"."profiles"
  WHERE ("profiles"."id" = "auth"."uid"()))));



CREATE POLICY "tenant_isolation" ON "public"."encounter_orders" USING (("tenant_id" = ( SELECT "encounter_orders"."tenant_id"
   FROM "public"."profiles"
  WHERE ("profiles"."id" = "auth"."uid"()))));



CREATE POLICY "tenant_isolation" ON "public"."encounters" USING (("tenant_id" = ( SELECT "encounters"."tenant_id"
   FROM "public"."profiles"
  WHERE ("profiles"."id" = "auth"."uid"()))));



CREATE POLICY "tenant_isolation" ON "public"."expert_rules" USING (("tenant_id" = ( SELECT "profiles"."tenant_id"
   FROM "public"."profiles"
  WHERE ("profiles"."id" = "auth"."uid"()))));



CREATE POLICY "tenant_isolation" ON "public"."gas_cylinders" USING (("tenant_id" = ( SELECT "gas_cylinders"."tenant_id"
   FROM "public"."profiles"
  WHERE ("profiles"."id" = "auth"."uid"()))));



CREATE POLICY "tenant_isolation" ON "public"."handover_patient_entries" USING (("tenant_id" = ( SELECT "profiles"."tenant_id"
   FROM "public"."profiles"
  WHERE ("profiles"."id" = "auth"."uid"()))));



CREATE POLICY "tenant_isolation" ON "public"."handover_shift_tasks" USING (("tenant_id" = ( SELECT "profiles"."tenant_id"
   FROM "public"."profiles"
  WHERE ("profiles"."id" = "auth"."uid"()))));



CREATE POLICY "tenant_isolation" ON "public"."handover_signatures" USING (("tenant_id" = ( SELECT "profiles"."tenant_id"
   FROM "public"."profiles"
  WHERE ("profiles"."id" = "auth"."uid"()))));



CREATE POLICY "tenant_isolation" ON "public"."hospital_beds" USING (("tenant_id" = ( SELECT "profiles"."tenant_id"
   FROM "public"."profiles"
  WHERE ("profiles"."id" = "auth"."uid"()))));



CREATE POLICY "tenant_isolation" ON "public"."hospital_drug_orders" USING (("tenant_id" = ( SELECT "hospital_drug_orders"."tenant_id"
   FROM "public"."profiles"
  WHERE ("profiles"."id" = "auth"."uid"()))));



CREATE POLICY "tenant_isolation" ON "public"."hospital_modules" USING (((("auth"."jwt"() ->> 'tenant_id'::"text"))::"uuid" = "tenant_id"));



CREATE POLICY "tenant_isolation" ON "public"."hospital_settings" USING (("tenant_id" = ( SELECT "profiles"."tenant_id"
   FROM "public"."profiles"
  WHERE ("profiles"."id" = "auth"."uid"()))));



CREATE POLICY "tenant_isolation" ON "public"."imaging_series" USING (("tenant_id" = ( SELECT "profiles"."tenant_id"
   FROM "public"."profiles"
  WHERE ("profiles"."id" = "auth"."uid"()))));



CREATE POLICY "tenant_isolation" ON "public"."imaging_studies" USING (("tenant_id" = ( SELECT "profiles"."tenant_id"
   FROM "public"."profiles"
  WHERE ("profiles"."id" = "auth"."uid"()))));



CREATE POLICY "tenant_isolation" ON "public"."immunization_schedule" USING (("tenant_id" = ( SELECT "profiles"."tenant_id"
   FROM "public"."profiles"
  WHERE ("profiles"."id" = "auth"."uid"()))));



CREATE POLICY "tenant_isolation" ON "public"."import_batch_rows" USING (("tenant_id" = ( SELECT "profiles"."tenant_id"
   FROM "public"."profiles"
  WHERE ("profiles"."id" = "auth"."uid"()))));



CREATE POLICY "tenant_isolation" ON "public"."import_batches" USING (("tenant_id" = ( SELECT "profiles"."tenant_id"
   FROM "public"."profiles"
  WHERE ("profiles"."id" = "auth"."uid"()))));



CREATE POLICY "tenant_isolation" ON "public"."import_column_mappings" USING (("tenant_id" = ( SELECT "profiles"."tenant_id"
   FROM "public"."profiles"
  WHERE ("profiles"."id" = "auth"."uid"()))));



CREATE POLICY "tenant_isolation" ON "public"."insurance_claims" USING (("tenant_id" = ( SELECT "profiles"."tenant_id"
   FROM "public"."profiles"
  WHERE ("profiles"."id" = "auth"."uid"()))));



CREATE POLICY "tenant_isolation" ON "public"."inventory_items" USING (("tenant_id" = ( SELECT "profiles"."tenant_id"
   FROM "public"."profiles"
  WHERE ("profiles"."id" = "auth"."uid"()))));



CREATE POLICY "tenant_isolation" ON "public"."lab_results" USING (("tenant_id" = ( SELECT "profiles"."tenant_id"
   FROM "public"."profiles"
  WHERE ("profiles"."id" = "auth"."uid"()))));



CREATE POLICY "tenant_isolation" ON "public"."live_feed_sessions" USING (("tenant_id" = ( SELECT "p"."tenant_id"
   FROM "public"."profiles" "p"
  WHERE ("p"."id" = "auth"."uid"())
 LIMIT 1)));



CREATE POLICY "tenant_isolation" ON "public"."loinc_reference" USING (("tenant_id" = ( SELECT "profiles"."tenant_id"
   FROM "public"."profiles"
  WHERE ("profiles"."id" = "auth"."uid"()))));



CREATE POLICY "tenant_isolation" ON "public"."maternity_records" USING (("tenant_id" = ( SELECT "profiles"."tenant_id"
   FROM "public"."profiles"
  WHERE ("profiles"."id" = "auth"."uid"()))));



CREATE POLICY "tenant_isolation" ON "public"."medical_devices" USING (("tenant_id" = ( SELECT "profiles"."tenant_id"
   FROM "public"."profiles"
  WHERE ("profiles"."id" = "auth"."uid"()))));



CREATE POLICY "tenant_isolation" ON "public"."medication_safety_checks" USING (("tenant_id" = ( SELECT "profiles"."tenant_id"
   FROM "public"."profiles"
  WHERE ("profiles"."id" = "auth"."uid"()))));



CREATE POLICY "tenant_isolation" ON "public"."nin_access_log" USING (("tenant_id" = ( SELECT "profiles"."tenant_id"
   FROM "public"."profiles"
  WHERE ("profiles"."id" = "auth"."uid"()))));



CREATE POLICY "tenant_isolation" ON "public"."notifications" USING (("tenant_id" = ( SELECT "profiles"."tenant_id"
   FROM "public"."profiles"
  WHERE ("profiles"."id" = "auth"."uid"()))));



CREATE POLICY "tenant_isolation" ON "public"."order_items" USING (("tenant_id" = ( SELECT "order_items"."tenant_id"
   FROM "public"."profiles"
  WHERE ("profiles"."id" = "auth"."uid"()))));



CREATE POLICY "tenant_isolation" ON "public"."order_mappings" USING (("tenant_id" = ( SELECT "profiles"."tenant_id"
   FROM "public"."profiles"
  WHERE ("profiles"."id" = "auth"."uid"()))));



CREATE POLICY "tenant_isolation" ON "public"."orders" USING (("tenant_id" = ( SELECT "profiles"."tenant_id"
   FROM "public"."profiles"
  WHERE ("profiles"."id" = "auth"."uid"()))));



CREATE POLICY "tenant_isolation" ON "public"."outreach_campaigns" USING (("tenant_id" = ( SELECT "profiles"."tenant_id"
   FROM "public"."profiles"
  WHERE ("profiles"."id" = "auth"."uid"()))));



CREATE POLICY "tenant_isolation" ON "public"."pathway_alerts" USING (("tenant_id" = ( SELECT "profiles"."tenant_id"
   FROM "public"."profiles"
  WHERE ("profiles"."id" = "auth"."uid"()))));



CREATE POLICY "tenant_isolation" ON "public"."pathway_checklist_items" USING (("tenant_id" = ( SELECT "profiles"."tenant_id"
   FROM "public"."profiles"
  WHERE ("profiles"."id" = "auth"."uid"()))));



CREATE POLICY "tenant_isolation" ON "public"."patient_access_grants" USING (("tenant_id" = ( SELECT "profiles"."tenant_id"
   FROM "public"."profiles"
  WHERE ("profiles"."id" = "auth"."uid"()))));



CREATE POLICY "tenant_isolation" ON "public"."patient_allergies" USING (("tenant_id" = ( SELECT "profiles"."tenant_id"
   FROM "public"."profiles"
  WHERE ("profiles"."id" = "auth"."uid"()))));



CREATE POLICY "tenant_isolation" ON "public"."patient_billing" USING (("tenant_id" = ( SELECT "profiles"."tenant_id"
   FROM "public"."profiles"
  WHERE ("profiles"."id" = "auth"."uid"()))));



CREATE POLICY "tenant_isolation" ON "public"."patient_consents" USING (("tenant_id" = ( SELECT "profiles"."tenant_id"
   FROM "public"."profiles"
  WHERE ("profiles"."id" = "auth"."uid"()))));



CREATE POLICY "tenant_isolation" ON "public"."patient_notes" USING (("tenant_id" = ( SELECT "profiles"."tenant_id"
   FROM "public"."profiles"
  WHERE ("profiles"."id" = "auth"."uid"()))));



CREATE POLICY "tenant_isolation" ON "public"."patient_pathways" USING (("tenant_id" = ( SELECT "profiles"."tenant_id"
   FROM "public"."profiles"
  WHERE ("profiles"."id" = "auth"."uid"()))));



CREATE POLICY "tenant_isolation" ON "public"."patient_problem_list" USING (("tenant_id" = ( SELECT "profiles"."tenant_id"
   FROM "public"."profiles"
  WHERE ("profiles"."id" = "auth"."uid"()))));



CREATE POLICY "tenant_isolation" ON "public"."patient_safety_events" USING (("tenant_id" = ( SELECT "profiles"."tenant_id"
   FROM "public"."profiles"
  WHERE ("profiles"."id" = "auth"."uid"()))));



CREATE POLICY "tenant_isolation" ON "public"."patient_sms_reminders" USING (("tenant_id" = ( SELECT "profiles"."tenant_id"
   FROM "public"."profiles"
  WHERE ("profiles"."id" = "auth"."uid"()))));



CREATE POLICY "tenant_isolation" ON "public"."patient_timeline_events" USING (("tenant_id" = ( SELECT "profiles"."tenant_id"
   FROM "public"."profiles"
  WHERE ("profiles"."id" = "auth"."uid"()))));



CREATE POLICY "tenant_isolation" ON "public"."patient_timeline_pins" USING (("tenant_id" = ( SELECT "profiles"."tenant_id"
   FROM "public"."profiles"
  WHERE ("profiles"."id" = "auth"."uid"()))));



CREATE POLICY "tenant_isolation" ON "public"."patients" USING (("tenant_id" = ( SELECT "profiles"."tenant_id"
   FROM "public"."profiles"
  WHERE ("profiles"."id" = "auth"."uid"()))));



CREATE POLICY "tenant_isolation" ON "public"."payer_contracts" USING (("tenant_id" = ( SELECT "profiles"."tenant_id"
   FROM "public"."profiles"
  WHERE ("profiles"."id" = "auth"."uid"()))));



CREATE POLICY "tenant_isolation" ON "public"."pediatric_growth_records" USING (("tenant_id" = ( SELECT "profiles"."tenant_id"
   FROM "public"."profiles"
  WHERE ("profiles"."id" = "auth"."uid"()))));



CREATE POLICY "tenant_isolation" ON "public"."pharmacy_credit_ledger" USING (("tenant_id" IN ( SELECT "profiles"."tenant_id"
   FROM "public"."profiles"
  WHERE ("profiles"."id" = "auth"."uid"())
UNION
 SELECT "tenants"."id"
   FROM "public"."tenants"
  WHERE (EXISTS ( SELECT 1
           FROM "public"."profiles"
          WHERE (("profiles"."id" = "auth"."uid"()) AND ("profiles"."role" = 'platform_admin'::"text")))))));



CREATE POLICY "tenant_isolation" ON "public"."pharmacy_expenses" USING (("tenant_id" IN ( SELECT "profiles"."tenant_id"
   FROM "public"."profiles"
  WHERE ("profiles"."id" = "auth"."uid"())
UNION
 SELECT "tenants"."id"
   FROM "public"."tenants"
  WHERE (EXISTS ( SELECT 1
           FROM "public"."profiles"
          WHERE (("profiles"."id" = "auth"."uid"()) AND ("profiles"."role" = 'platform_admin'::"text")))))));



CREATE POLICY "tenant_isolation" ON "public"."pharmacy_import_sessions" USING (("tenant_id" IN ( SELECT "profiles"."tenant_id"
   FROM "public"."profiles"
  WHERE ("profiles"."id" = "auth"."uid"())
UNION
 SELECT "tenants"."id"
   FROM "public"."tenants"
  WHERE (EXISTS ( SELECT 1
           FROM "public"."profiles"
          WHERE (("profiles"."id" = "auth"."uid"()) AND ("profiles"."role" = 'platform_admin'::"text")))))));



CREATE POLICY "tenant_isolation" ON "public"."pharmacy_staff_permissions" USING (("tenant_id" IN ( SELECT "profiles"."tenant_id"
   FROM "public"."profiles"
  WHERE ("profiles"."id" = "auth"."uid"())
UNION
 SELECT "tenants"."id"
   FROM "public"."tenants"
  WHERE (EXISTS ( SELECT 1
           FROM "public"."profiles"
          WHERE (("profiles"."id" = "auth"."uid"()) AND ("profiles"."role" = 'platform_admin'::"text")))))));



CREATE POLICY "tenant_isolation" ON "public"."pharmacy_stores" USING (("tenant_id" = ( SELECT "profiles"."tenant_id"
   FROM "public"."profiles"
  WHERE ("profiles"."id" = "auth"."uid"()))));



CREATE POLICY "tenant_isolation" ON "public"."phi_access_log" USING (("tenant_id" = ( SELECT "profiles"."tenant_id"
   FROM "public"."profiles"
  WHERE ("profiles"."id" = "auth"."uid"()))));



CREATE POLICY "tenant_isolation" ON "public"."products" USING (("tenant_id" = ( SELECT "products"."tenant_id"
   FROM "public"."profiles"
  WHERE ("profiles"."id" = "auth"."uid"()))));



CREATE POLICY "tenant_isolation" ON "public"."provider_verification_checks" USING (("tenant_id" = ( SELECT "profiles"."tenant_id"
   FROM "public"."profiles"
  WHERE ("profiles"."id" = "auth"."uid"()))));



CREATE POLICY "tenant_isolation" ON "public"."purchase_orders" USING (("tenant_id" = ( SELECT "profiles"."tenant_id"
   FROM "public"."profiles"
  WHERE ("profiles"."id" = "auth"."uid"()))));



CREATE POLICY "tenant_isolation" ON "public"."radiology_report_templates" USING (("tenant_id" = ( SELECT "profiles"."tenant_id"
   FROM "public"."profiles"
  WHERE ("profiles"."id" = "auth"."uid"()))));



CREATE POLICY "tenant_isolation" ON "public"."radiology_reports" USING (("tenant_id" = ( SELECT "profiles"."tenant_id"
   FROM "public"."profiles"
  WHERE ("profiles"."id" = "auth"."uid"()))));



CREATE POLICY "tenant_isolation" ON "public"."referral_requests" USING (("tenant_id" = ( SELECT "profiles"."tenant_id"
   FROM "public"."profiles"
  WHERE ("profiles"."id" = "auth"."uid"()))));



CREATE POLICY "tenant_isolation" ON "public"."renal_adjustments_catalog" USING (("tenant_id" = ( SELECT "profiles"."tenant_id"
   FROM "public"."profiles"
  WHERE ("profiles"."id" = "auth"."uid"()))));



CREATE POLICY "tenant_isolation" ON "public"."restaurants" USING (("tenant_id" = ( SELECT "profiles"."tenant_id"
   FROM "public"."profiles"
  WHERE ("profiles"."id" = "auth"."uid"()))));



CREATE POLICY "tenant_isolation" ON "public"."rule_executions" USING (("tenant_id" = ( SELECT "profiles"."tenant_id"
   FROM "public"."profiles"
  WHERE ("profiles"."id" = "auth"."uid"()))));



CREATE POLICY "tenant_isolation" ON "public"."scan_events" USING (("tenant_id" = ( SELECT "profiles"."tenant_id"
   FROM "public"."profiles"
  WHERE ("profiles"."id" = "auth"."uid"()))));



CREATE POLICY "tenant_isolation" ON "public"."sentinel_alerts" USING (("tenant_id" = ( SELECT "profiles"."tenant_id"
   FROM "public"."profiles"
  WHERE ("profiles"."id" = "auth"."uid"()))));



CREATE POLICY "tenant_isolation" ON "public"."service_catalog" USING (("tenant_id" = ( SELECT "profiles"."tenant_id"
   FROM "public"."profiles"
  WHERE ("profiles"."id" = "auth"."uid"()))));



CREATE POLICY "tenant_isolation" ON "public"."staff_attendance" USING (("tenant_id" = ( SELECT "profiles"."tenant_id"
   FROM "public"."profiles"
  WHERE ("profiles"."id" = "auth"."uid"()))));



CREATE POLICY "tenant_isolation" ON "public"."staff_leave_requests" USING (("tenant_id" = ( SELECT "profiles"."tenant_id"
   FROM "public"."profiles"
  WHERE ("profiles"."id" = "auth"."uid"()))));



CREATE POLICY "tenant_isolation" ON "public"."suppliers" USING (("tenant_id" = ( SELECT "profiles"."tenant_id"
   FROM "public"."profiles"
  WHERE ("profiles"."id" = "auth"."uid"()))));



CREATE POLICY "tenant_isolation" ON "public"."surgery_schedules" USING (("tenant_id" = ( SELECT "profiles"."tenant_id"
   FROM "public"."profiles"
  WHERE ("profiles"."id" = "auth"."uid"()))));



CREATE POLICY "tenant_isolation" ON "public"."sync_conflicts" USING (("tenant_id" = ( SELECT "sync_conflicts"."tenant_id"
   FROM "public"."profiles"
  WHERE ("profiles"."id" = "auth"."uid"()))));



CREATE POLICY "tenant_isolation" ON "public"."sync_idempotency_keys" USING (("tenant_id" = ( SELECT "profiles"."tenant_id"
   FROM "public"."profiles"
  WHERE ("profiles"."id" = "auth"."uid"()))));



CREATE POLICY "tenant_isolation" ON "public"."telemedicine_appointments" USING (("tenant_id" = ( SELECT "profiles"."tenant_id"
   FROM "public"."profiles"
  WHERE ("profiles"."id" = "auth"."uid"()))));



CREATE POLICY "tenant_isolation" ON "public"."telemedicine_followups" USING (("tenant_id" = ( SELECT "profiles"."tenant_id"
   FROM "public"."profiles"
  WHERE ("profiles"."id" = "auth"."uid"()))));



CREATE POLICY "tenant_isolation" ON "public"."telemedicine_frontdesk_queue" USING (("tenant_id" = ( SELECT "profiles"."tenant_id"
   FROM "public"."profiles"
  WHERE ("profiles"."id" = "auth"."uid"()))));



CREATE POLICY "tenant_isolation" ON "public"."telemedicine_intake_cases" USING (("tenant_id" = ( SELECT "telemedicine_intake_cases"."tenant_id"
   FROM "public"."profiles"
  WHERE ("profiles"."id" = "auth"."uid"()))));



CREATE POLICY "tenant_isolation" ON "public"."telemedicine_intake_messages" USING (("tenant_id" = ( SELECT "telemedicine_intake_messages"."tenant_id"
   FROM "public"."profiles"
  WHERE ("profiles"."id" = "auth"."uid"()))));



CREATE POLICY "tenant_isolation" ON "public"."telemedicine_providers" USING (("tenant_id" = ( SELECT "profiles"."tenant_id"
   FROM "public"."profiles"
  WHERE ("profiles"."id" = "auth"."uid"()))));



CREATE POLICY "tenant_isolation" ON "public"."telemedicine_session_events" USING (("tenant_id" = ( SELECT "profiles"."tenant_id"
   FROM "public"."profiles"
  WHERE ("profiles"."id" = "auth"."uid"()))));



CREATE POLICY "tenant_isolation" ON "public"."telemedicine_staff_alerts" USING (("tenant_id" = ( SELECT "profiles"."tenant_id"
   FROM "public"."profiles"
  WHERE ("profiles"."id" = "auth"."uid"()))));



CREATE POLICY "tenant_isolation" ON "public"."telemedicine_voice_memos" USING (("tenant_id" = ( SELECT "profiles"."tenant_id"
   FROM "public"."profiles"
  WHERE ("profiles"."id" = "auth"."uid"()))));



CREATE POLICY "tenant_isolation" ON "public"."tenant_domains" USING (("tenant_id" = ( SELECT "profiles"."tenant_id"
   FROM "public"."profiles"
  WHERE ("profiles"."id" = "auth"."uid"()))));



CREATE POLICY "tenant_isolation" ON "public"."tenant_logging_policies" USING (("tenant_id" = ( SELECT "profiles"."tenant_id"
   FROM "public"."profiles"
  WHERE ("profiles"."id" = "auth"."uid"()))));



CREATE POLICY "tenant_isolation" ON "public"."tenant_provisioning_jobs" USING (("tenant_id" = ( SELECT "profiles"."tenant_id"
   FROM "public"."profiles"
  WHERE ("profiles"."id" = "auth"."uid"()))));



CREATE POLICY "tenant_isolation" ON "public"."tenants" USING (("id" = ( SELECT "p"."tenant_id"
   FROM "public"."profiles" "p"
  WHERE ("p"."id" = "auth"."uid"())
 LIMIT 1)));



CREATE POLICY "tenant_isolation" ON "public"."ucg_guidelines" USING (("tenant_id" = ( SELECT "profiles"."tenant_id"
   FROM "public"."profiles"
  WHERE ("profiles"."id" = "auth"."uid"()))));



CREATE POLICY "tenant_isolation" ON "public"."verification_documents" USING (("tenant_id" = ( SELECT "profiles"."tenant_id"
   FROM "public"."profiles"
  WHERE ("profiles"."id" = "auth"."uid"()))));



CREATE POLICY "tenant_isolation" ON "public"."vitals" USING (("tenant_id" = ( SELECT "vitals"."tenant_id"
   FROM "public"."profiles"
  WHERE ("profiles"."id" = "auth"."uid"()))));



CREATE POLICY "tenant_isolation" ON "public"."wards" USING (("hospital_id" = ( SELECT "p"."hospital_id"
   FROM "public"."profiles" "p"
  WHERE ("p"."id" = "auth"."uid"())
 LIMIT 1)));



ALTER TABLE "public"."tenant_logging_policies" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "tenant_logging_policies_admin_all" ON "public"."tenant_logging_policies" USING ((("auth"."role"() = 'service_role'::"text") OR (EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."id" = "auth"."uid"()) AND ("p"."role" = 'admin'::"text")))))) WITH CHECK ((("auth"."role"() = 'service_role'::"text") OR (EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."id" = "auth"."uid"()) AND ("p"."role" = 'admin'::"text"))))));



CREATE POLICY "tenant_pharmacy_inventory" ON "public"."pharmacy_network_inventory" USING (("pharmacy_tenant_id" = ( SELECT "profiles"."tenant_id"
   FROM "public"."profiles"
  WHERE ("profiles"."id" = "auth"."uid"()))));



CREATE POLICY "tenant_pharmacy_orders" ON "public"."pharmacy_orders" USING ((("tenant_id" = ( SELECT "profiles"."tenant_id"
   FROM "public"."profiles"
  WHERE ("profiles"."id" = "auth"."uid"()))) OR ("patient_id" = "auth"."uid"())));



CREATE POLICY "tenant_pharmacy_profiles" ON "public"."pharmacy_profiles" USING (("tenant_id" = ( SELECT "profiles"."tenant_id"
   FROM "public"."profiles"
  WHERE ("profiles"."id" = "auth"."uid"()))));



ALTER TABLE "public"."tenant_provisioning_jobs" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "tenant_provisioning_jobs_admin_all" ON "public"."tenant_provisioning_jobs" USING ((EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."id" = "auth"."uid"()) AND ("p"."role" = 'admin'::"text"))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."id" = "auth"."uid"()) AND ("p"."role" = 'admin'::"text")))));



CREATE POLICY "tenant_subs_read" ON "public"."tenant_subscriptions" FOR SELECT USING (("tenant_id" IN ( SELECT "profiles"."tenant_id"
   FROM "public"."profiles"
  WHERE ("profiles"."id" = "auth"."uid"()))));



ALTER TABLE "public"."tenant_subscriptions" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."tenants" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "timeline_events_staff_insert" ON "public"."patient_timeline_events" FOR INSERT WITH CHECK ((("auth"."role"() = 'service_role'::"text") OR (EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."id" = "auth"."uid"()) AND ("p"."role" = ANY (ARRAY['admin'::"text", 'doctor'::"text", 'nurse'::"text", 'clinician'::"text"])))))));



CREATE POLICY "timeline_events_staff_read" ON "public"."patient_timeline_events" FOR SELECT USING ((("auth"."role"() = 'service_role'::"text") OR (EXISTS ( SELECT 1
   FROM "public"."profiles" "p"
  WHERE (("p"."id" = "auth"."uid"()) AND (("p"."hospital_id" = "p"."hospital_id") OR ("p"."role" = 'admin'::"text")))))));



ALTER TABLE "public"."ucg_guidelines" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "user_own_chats" ON "public"."ai_health_chats" USING (("auth"."uid"() = "user_id"));



CREATE POLICY "user_own_cycles" ON "public"."menstrual_cycles" USING (("auth"."uid"() = "user_id"));



CREATE POLICY "user_own_diet" ON "public"."diet_logs" USING (("auth"."uid"() = "user_id"));



CREATE POLICY "user_own_habit_logs" ON "public"."habit_logs" USING (("auth"."uid"() = "user_id"));



CREATE POLICY "user_own_habits" ON "public"."health_habits" USING (("auth"."uid"() = "user_id"));



CREATE POLICY "users_own_sessions_select" ON "public"."synapse_sessions" FOR SELECT USING (("user_id" = "auth"."uid"()));



ALTER TABLE "public"."verification_documents" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."visitor_log" ENABLE ROW LEVEL SECURITY;


CREATE POLICY "visitor_log_tenant" ON "public"."visitor_log" USING (("tenant_id" = "public"."current_tenant_id"()));



ALTER TABLE "public"."vitals" ENABLE ROW LEVEL SECURITY;


ALTER TABLE "public"."wards" ENABLE ROW LEVEL SECURITY;


GRANT USAGE ON SCHEMA "public" TO "postgres";
GRANT USAGE ON SCHEMA "public" TO "anon";
GRANT USAGE ON SCHEMA "public" TO "authenticated";
GRANT USAGE ON SCHEMA "public" TO "service_role";



GRANT ALL ON FUNCTION "public"."_set_consult_queue_updated_at"() TO "anon";
GRANT ALL ON FUNCTION "public"."_set_consult_queue_updated_at"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."_set_consult_queue_updated_at"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."accept_facility_invitation_existing_user"("p_token_hash" "text", "p_session_profile_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."accept_facility_invitation_existing_user"("p_token_hash" "text", "p_session_profile_id" "uuid") TO "service_role";



REVOKE ALL ON FUNCTION "public"."accept_facility_invitation_new_account"("p_token_hash" "text", "p_profile_id" "uuid", "p_password_hash" "text", "p_full_name" "text", "p_first_name" "text", "p_last_name" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."accept_facility_invitation_new_account"("p_token_hash" "text", "p_profile_id" "uuid", "p_password_hash" "text", "p_full_name" "text", "p_first_name" "text", "p_last_name" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."activate_subscription_payment"("p_payment_id" "uuid", "p_actor" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."activate_subscription_payment"("p_payment_id" "uuid", "p_actor" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."activate_subscription_payment"("p_payment_id" "uuid", "p_actor" "text") TO "service_role";



REVOKE ALL ON FUNCTION "public"."adjust_pharmacy_batch_stock"("p_tenant_id" "uuid", "p_product_id" "uuid", "p_quantity" integer, "p_type" "text", "p_reason" "text", "p_actor_id" "uuid", "p_batch_id" "uuid", "p_batch_number" "text", "p_expiry_date" "date", "p_cost_price" numeric, "p_restore_as" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."adjust_pharmacy_batch_stock"("p_tenant_id" "uuid", "p_product_id" "uuid", "p_quantity" integer, "p_type" "text", "p_reason" "text", "p_actor_id" "uuid", "p_batch_id" "uuid", "p_batch_number" "text", "p_expiry_date" "date", "p_cost_price" numeric, "p_restore_as" "text") TO "service_role";



REVOKE ALL ON FUNCTION "public"."adjust_pharmacy_stock"("p_tenant_id" "uuid", "p_product_id" "uuid", "p_delta" integer, "p_reason" "text", "p_actor" "uuid", "p_batch_id" "uuid", "p_set_status" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."adjust_pharmacy_stock"("p_tenant_id" "uuid", "p_product_id" "uuid", "p_delta" integer, "p_reason" "text", "p_actor" "uuid", "p_batch_id" "uuid", "p_set_status" "text") TO "service_role";
REVOKE ALL ON FUNCTION "public"."pharmacy_assert_actor"("p_tenant_id" "uuid", "p_actor_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."pharmacy_assert_actor"("p_tenant_id" "uuid", "p_actor_id" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."advance_all_subscriptions"("p_actor" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."advance_all_subscriptions"("p_actor" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."advance_all_subscriptions"("p_actor" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."advance_subscription_state"("p_tenant_id" "uuid", "p_actor" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."advance_subscription_state"("p_tenant_id" "uuid", "p_actor" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."advance_subscription_state"("p_tenant_id" "uuid", "p_actor" "text") TO "service_role";



REVOKE ALL ON FUNCTION "public"."allocate_lab_accession"("p_tenant_id" "uuid", "p_facility_code" "text", "p_day" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."allocate_lab_accession"("p_tenant_id" "uuid", "p_facility_code" "text", "p_day" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."allocate_lab_accession"("p_tenant_id" "uuid", "p_facility_code" "text", "p_day" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."allocate_lab_accession"("p_tenant_id" "uuid", "p_facility_code" "text", "p_day" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."apply_encounter_amendment"("p_tenant_id" "uuid", "p_encounter_id" "uuid", "p_field" "text", "p_new_value" "text", "p_reason" "text", "p_amended_by" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."apply_encounter_amendment"("p_tenant_id" "uuid", "p_encounter_id" "uuid", "p_field" "text", "p_new_value" "text", "p_reason" "text", "p_amended_by" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."apply_encounter_amendment"("p_tenant_id" "uuid", "p_encounter_id" "uuid", "p_field" "text", "p_new_value" "text", "p_reason" "text", "p_amended_by" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."assign_synapse_id"() TO "anon";
GRANT ALL ON FUNCTION "public"."assign_synapse_id"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."assign_synapse_id"() TO "service_role";



GRANT ALL ON FUNCTION "public"."auto_set_tenant_id"() TO "anon";
GRANT ALL ON FUNCTION "public"."auto_set_tenant_id"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."auto_set_tenant_id"() TO "service_role";



GRANT ALL ON FUNCTION "public"."billing_grace_days"() TO "anon";
GRANT ALL ON FUNCTION "public"."billing_grace_days"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."billing_grace_days"() TO "service_role";



GRANT ALL ON FUNCTION "public"."bump_record_version"() TO "anon";
GRANT ALL ON FUNCTION "public"."bump_record_version"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."bump_record_version"() TO "service_role";



GRANT ALL ON FUNCTION "public"."check_death_sentinel"("p_hospital_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."check_death_sentinel"("p_hospital_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."check_death_sentinel"("p_hospital_id" "uuid") TO "service_role";



GRANT ALL ON TABLE "public"."consult_queue" TO "anon";
GRANT ALL ON TABLE "public"."consult_queue" TO "authenticated";
GRANT ALL ON TABLE "public"."consult_queue" TO "service_role";



GRANT ALL ON FUNCTION "public"."claim_next_consult"("p_doctor_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."claim_next_consult"("p_doctor_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."claim_next_consult"("p_doctor_id" "uuid") TO "service_role";



REVOKE ALL ON FUNCTION "public"."complete_pharmacy_sale"("p_tenant_id" "uuid", "p_cashier_id" "uuid", "p_items" "jsonb", "p_payment_method" "text", "p_session_id" "uuid", "p_cart_id" "uuid", "p_payment_ref" "text", "p_discount_total" numeric, "p_tax_amount" numeric, "p_patient_id" "uuid", "p_confirmed_by" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."complete_pharmacy_sale"("p_tenant_id" "uuid", "p_cashier_id" "uuid", "p_items" "jsonb", "p_payment_method" "text", "p_session_id" "uuid", "p_cart_id" "uuid", "p_payment_ref" "text", "p_discount_total" numeric, "p_tax_amount" numeric, "p_patient_id" "uuid", "p_confirmed_by" "uuid") TO "service_role";



REVOKE ALL ON FUNCTION "public"."complete_pharmacy_sale"("p_tenant_id" "uuid", "p_cashier_id" "uuid", "p_items" "jsonb", "p_payment_method" "text", "p_session_id" "uuid", "p_cart_id" "uuid", "p_payment_ref" "text", "p_discount_total" numeric, "p_tax_amount" numeric, "p_patient_id" "uuid", "p_confirmed_by" "uuid", "p_idempotency_key" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."complete_pharmacy_sale"("p_tenant_id" "uuid", "p_cashier_id" "uuid", "p_items" "jsonb", "p_payment_method" "text", "p_session_id" "uuid", "p_cart_id" "uuid", "p_payment_ref" "text", "p_discount_total" numeric, "p_tax_amount" numeric, "p_patient_id" "uuid", "p_confirmed_by" "uuid", "p_idempotency_key" "text") TO "service_role";



REVOKE ALL ON FUNCTION "public"."current_hospital_id"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."current_hospital_id"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."current_hospital_id"() TO "service_role";



GRANT ALL ON FUNCTION "public"."current_staff_site_ids"() TO "anon";
GRANT ALL ON FUNCTION "public"."current_staff_site_ids"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."current_staff_site_ids"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."current_tenant_id"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."current_tenant_id"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."current_tenant_id"() TO "service_role";



GRANT ALL ON FUNCTION "public"."custom_access_token_hook"("event" "jsonb") TO "anon";
GRANT ALL ON FUNCTION "public"."custom_access_token_hook"("event" "jsonb") TO "authenticated";
GRANT ALL ON FUNCTION "public"."custom_access_token_hook"("event" "jsonb") TO "service_role";
GRANT ALL ON FUNCTION "public"."custom_access_token_hook"("event" "jsonb") TO "supabase_auth_admin";



GRANT ALL ON FUNCTION "public"."expand_facility_types"("p_type" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."expand_facility_types"("p_type" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."expand_facility_types"("p_type" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."expand_roles"("p_role" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."expand_roles"("p_role" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."expand_roles"("p_role" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."find_duplicate_patients"("p_hospital_id" "uuid", "p_full_name" "text", "p_dob" "date", "p_phone_hash" character varying, "p_nin_hash" character varying, "p_similarity_threshold" double precision) TO "anon";
GRANT ALL ON FUNCTION "public"."find_duplicate_patients"("p_hospital_id" "uuid", "p_full_name" "text", "p_dob" "date", "p_phone_hash" character varying, "p_nin_hash" character varying, "p_similarity_threshold" double precision) TO "authenticated";
GRANT ALL ON FUNCTION "public"."find_duplicate_patients"("p_hospital_id" "uuid", "p_full_name" "text", "p_dob" "date", "p_phone_hash" character varying, "p_nin_hash" character varying, "p_similarity_threshold" double precision) TO "service_role";



GRANT ALL ON FUNCTION "public"."fn_sync_network_inventory"() TO "anon";
GRANT ALL ON FUNCTION "public"."fn_sync_network_inventory"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."fn_sync_network_inventory"() TO "service_role";



GRANT ALL ON FUNCTION "public"."forbid_platform_audit_mutation"() TO "anon";
GRANT ALL ON FUNCTION "public"."forbid_platform_audit_mutation"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."forbid_platform_audit_mutation"() TO "service_role";



GRANT ALL ON FUNCTION "public"."generate_synapse_id"() TO "anon";
GRANT ALL ON FUNCTION "public"."generate_synapse_id"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."generate_synapse_id"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."generate_synapse_id"("p_country_code" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."generate_synapse_id"("p_country_code" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."generate_synapse_id"("p_country_code" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."get_available_beds"("p_bed_type" character varying, "p_hospital_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."get_available_beds"("p_bed_type" character varying, "p_hospital_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_available_beds"("p_bed_type" character varying, "p_hospital_id" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."get_queue_position"("p_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."get_queue_position"("p_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."get_queue_position"("p_id" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."guard_hospital_seed_reset"() TO "anon";
GRANT ALL ON FUNCTION "public"."guard_hospital_seed_reset"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."guard_hospital_seed_reset"() TO "service_role";



GRANT ALL ON FUNCTION "public"."guard_pos_sale_item_mutation"() TO "anon";
GRANT ALL ON FUNCTION "public"."guard_pos_sale_item_mutation"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."guard_pos_sale_item_mutation"() TO "service_role";



GRANT ALL ON FUNCTION "public"."guard_pos_sale_mutation"() TO "anon";
GRANT ALL ON FUNCTION "public"."guard_pos_sale_mutation"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."guard_pos_sale_mutation"() TO "service_role";



GRANT ALL ON FUNCTION "public"."guard_signed_encounter_update"() TO "anon";
GRANT ALL ON FUNCTION "public"."guard_signed_encounter_update"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."guard_signed_encounter_update"() TO "service_role";



GRANT ALL ON FUNCTION "public"."handle_new_user"() TO "anon";
GRANT ALL ON FUNCTION "public"."handle_new_user"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."handle_new_user"() TO "service_role";



GRANT ALL ON FUNCTION "public"."handle_new_user_profile"() TO "anon";
GRANT ALL ON FUNCTION "public"."handle_new_user_profile"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."handle_new_user_profile"() TO "service_role";



GRANT ALL ON FUNCTION "public"."has_capability"("p_role" "text", "p_facility_type" "text", "p_module" "text", "p_resource" "text", "p_action" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."has_capability"("p_role" "text", "p_facility_type" "text", "p_module" "text", "p_resource" "text", "p_action" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."has_capability"("p_role" "text", "p_facility_type" "text", "p_module" "text", "p_resource" "text", "p_action" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."has_feature"("p_tenant_id" "uuid", "p_feature" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."has_feature"("p_tenant_id" "uuid", "p_feature" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."has_feature"("p_tenant_id" "uuid", "p_feature" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."has_patient_consent"("p_patient_id" "uuid", "p_module" "text", "p_actor_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."has_patient_consent"("p_patient_id" "uuid", "p_module" "text", "p_actor_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."has_patient_consent"("p_patient_id" "uuid", "p_module" "text", "p_actor_id" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."is_admin"("_uid" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."is_admin"("_uid" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."is_admin"("_uid" "uuid") TO "service_role";



REVOKE ALL ON FUNCTION "public"."is_clinical_staff"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."is_clinical_staff"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."is_clinical_staff"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."is_platform_admin"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."is_platform_admin"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."is_platform_admin"() TO "service_role";



GRANT ALL ON FUNCTION "public"."is_platform_operator"() TO "anon";
GRANT ALL ON FUNCTION "public"."is_platform_operator"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."is_platform_operator"() TO "service_role";



GRANT ALL ON FUNCTION "public"."log_subscription_event"("p_tenant_id" "uuid", "p_from_status" "text", "p_to_status" "text", "p_reason" "text", "p_actor" "text", "p_metadata" "jsonb") TO "anon";
GRANT ALL ON FUNCTION "public"."log_subscription_event"("p_tenant_id" "uuid", "p_from_status" "text", "p_to_status" "text", "p_reason" "text", "p_actor" "text", "p_metadata" "jsonb") TO "authenticated";
GRANT ALL ON FUNCTION "public"."log_subscription_event"("p_tenant_id" "uuid", "p_from_status" "text", "p_to_status" "text", "p_reason" "text", "p_actor" "text", "p_metadata" "jsonb") TO "service_role";



GRANT ALL ON FUNCTION "public"."match_ucg_guidelines"("query_embedding" "public"."vector", "match_threshold" double precision, "match_count" integer) TO "anon";
GRANT ALL ON FUNCTION "public"."match_ucg_guidelines"("query_embedding" "public"."vector", "match_threshold" double precision, "match_count" integer) TO "authenticated";
GRANT ALL ON FUNCTION "public"."match_ucg_guidelines"("query_embedding" "public"."vector", "match_threshold" double precision, "match_count" integer) TO "service_role";



REVOKE ALL ON FUNCTION "public"."person_visible_to_tenant"("p_person_id" "uuid", "p_tenant_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."person_visible_to_tenant"("p_person_id" "uuid", "p_tenant_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."person_visible_to_tenant"("p_person_id" "uuid", "p_tenant_id" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."persons_assign_synapse_id"() TO "anon";
GRANT ALL ON FUNCTION "public"."persons_assign_synapse_id"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."persons_assign_synapse_id"() TO "service_role";



GRANT ALL ON FUNCTION "public"."pos_sale_item_before_insert"() TO "anon";
GRANT ALL ON FUNCTION "public"."pos_sale_item_before_insert"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."pos_sale_item_before_insert"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."receive_pharmacy_stock"("p_tenant_id" "uuid", "p_product_id" "uuid", "p_batch_number" "text", "p_quantity" integer, "p_expiry_date" "date", "p_cost_price" numeric, "p_received_by" "uuid", "p_supplier_ref" "text", "p_selling_price" numeric, "p_supplier_id" "uuid", "p_purchase_order_id" "uuid", "p_store_id" "uuid", "p_reason" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."receive_pharmacy_stock"("p_tenant_id" "uuid", "p_product_id" "uuid", "p_batch_number" "text", "p_quantity" integer, "p_expiry_date" "date", "p_cost_price" numeric, "p_received_by" "uuid", "p_supplier_ref" "text", "p_selling_price" numeric, "p_supplier_id" "uuid", "p_purchase_order_id" "uuid", "p_store_id" "uuid", "p_reason" "text") TO "service_role";



REVOKE ALL ON FUNCTION "public"."receive_pharmacy_stock_transfer"("p_tenant_id" "uuid", "p_transfer_id" "uuid", "p_actor_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."receive_pharmacy_stock_transfer"("p_tenant_id" "uuid", "p_transfer_id" "uuid", "p_actor_id" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."recompute_differential"("p_session_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."recompute_differential"("p_session_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."recompute_differential"("p_session_id" "uuid") TO "service_role";



REVOKE ALL ON FUNCTION "public"."recompute_pharmacy_product_quantity"("p_tenant_id" "uuid", "p_product_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."recompute_pharmacy_product_quantity"("p_tenant_id" "uuid", "p_product_id" "uuid") TO "service_role";



REVOKE ALL ON FUNCTION "public"."report_unbatched_positive_stock"("p_tenant_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."report_unbatched_positive_stock"("p_tenant_id" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."resolve_tenant_from_host"("input_host" "text") TO "anon";
GRANT ALL ON FUNCTION "public"."resolve_tenant_from_host"("input_host" "text") TO "authenticated";
GRANT ALL ON FUNCTION "public"."resolve_tenant_from_host"("input_host" "text") TO "service_role";



REVOKE ALL ON FUNCTION "public"."reverse_pharmacy_sale"("p_tenant_id" "uuid", "p_sale_id" "uuid", "p_actor_id" "uuid", "p_reason" "text", "p_restore_as" "text") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."reverse_pharmacy_sale"("p_tenant_id" "uuid", "p_sale_id" "uuid", "p_actor_id" "uuid", "p_reason" "text", "p_restore_as" "text") TO "service_role";



GRANT ALL ON FUNCTION "public"."same_tenant"("p_tenant_id" "uuid") TO "anon";
GRANT ALL ON FUNCTION "public"."same_tenant"("p_tenant_id" "uuid") TO "authenticated";
GRANT ALL ON FUNCTION "public"."same_tenant"("p_tenant_id" "uuid") TO "service_role";



GRANT ALL ON FUNCTION "public"."set_bed_status_change_ts"() TO "anon";
GRANT ALL ON FUNCTION "public"."set_bed_status_change_ts"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."set_bed_status_change_ts"() TO "service_role";



GRANT ALL ON FUNCTION "public"."set_death_reg_updated_at"() TO "anon";
GRANT ALL ON FUNCTION "public"."set_death_reg_updated_at"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."set_death_reg_updated_at"() TO "service_role";



GRANT ALL ON FUNCTION "public"."set_expert_rules_updated_at"() TO "anon";
GRANT ALL ON FUNCTION "public"."set_expert_rules_updated_at"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."set_expert_rules_updated_at"() TO "service_role";



GRANT ALL ON FUNCTION "public"."set_generic_updated_at"() TO "anon";
GRANT ALL ON FUNCTION "public"."set_generic_updated_at"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."set_generic_updated_at"() TO "service_role";



GRANT ALL ON FUNCTION "public"."set_referral_updated_at"() TO "anon";
GRANT ALL ON FUNCTION "public"."set_referral_updated_at"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."set_referral_updated_at"() TO "service_role";



GRANT ALL ON FUNCTION "public"."set_telemedicine_updated_at"() TO "anon";
GRANT ALL ON FUNCTION "public"."set_telemedicine_updated_at"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."set_telemedicine_updated_at"() TO "service_role";



GRANT ALL ON FUNCTION "public"."set_tenant_domain_updated_at"() TO "anon";
GRANT ALL ON FUNCTION "public"."set_tenant_domain_updated_at"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."set_tenant_domain_updated_at"() TO "service_role";



GRANT ALL ON FUNCTION "public"."set_updated_at"() TO "anon";
GRANT ALL ON FUNCTION "public"."set_updated_at"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."set_updated_at"() TO "service_role";



REVOKE ALL ON FUNCTION "public"."ship_pharmacy_stock_transfer"("p_tenant_id" "uuid", "p_transfer_id" "uuid", "p_actor_id" "uuid") FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."ship_pharmacy_stock_transfer"("p_tenant_id" "uuid", "p_transfer_id" "uuid", "p_actor_id" "uuid") TO "service_role";



REVOKE ALL ON FUNCTION "public"."synapse_remote_migration_head"() FROM PUBLIC;
GRANT ALL ON FUNCTION "public"."synapse_remote_migration_head"() TO "service_role";



GRANT ALL ON FUNCTION "public"."update_updated_at_column"() TO "anon";
GRANT ALL ON FUNCTION "public"."update_updated_at_column"() TO "authenticated";
GRANT ALL ON FUNCTION "public"."update_updated_at_column"() TO "service_role";



GRANT ALL ON TABLE "public"."aefi_reports" TO "anon";
GRANT ALL ON TABLE "public"."aefi_reports" TO "authenticated";
GRANT ALL ON TABLE "public"."aefi_reports" TO "service_role";



GRANT ALL ON TABLE "public"."ai_health_chats" TO "anon";
GRANT ALL ON TABLE "public"."ai_health_chats" TO "authenticated";
GRANT ALL ON TABLE "public"."ai_health_chats" TO "service_role";



GRANT ALL ON TABLE "public"."allergens_catalog" TO "anon";
GRANT ALL ON TABLE "public"."allergens_catalog" TO "authenticated";
GRANT ALL ON TABLE "public"."allergens_catalog" TO "service_role";



GRANT ALL ON TABLE "public"."apk_waitlist" TO "anon";
GRANT ALL ON TABLE "public"."apk_waitlist" TO "authenticated";
GRANT ALL ON TABLE "public"."apk_waitlist" TO "service_role";



GRANT ALL ON TABLE "public"."app_vitals" TO "anon";
GRANT ALL ON TABLE "public"."app_vitals" TO "authenticated";
GRANT ALL ON TABLE "public"."app_vitals" TO "service_role";



GRANT ALL ON TABLE "public"."audit_events" TO "anon";
GRANT ALL ON TABLE "public"."audit_events" TO "authenticated";
GRANT ALL ON TABLE "public"."audit_events" TO "service_role";



GRANT ALL ON TABLE "public"."audit_log" TO "anon";
GRANT ALL ON TABLE "public"."audit_log" TO "authenticated";
GRANT ALL ON TABLE "public"."audit_log" TO "service_role";



GRANT ALL ON TABLE "public"."auth_otps" TO "anon";
GRANT ALL ON TABLE "public"."auth_otps" TO "authenticated";
GRANT ALL ON TABLE "public"."auth_otps" TO "service_role";



GRANT ALL ON TABLE "public"."bed_assignments" TO "anon";
GRANT ALL ON TABLE "public"."bed_assignments" TO "authenticated";
GRANT ALL ON TABLE "public"."bed_assignments" TO "service_role";



GRANT ALL ON TABLE "public"."beta_access_requests" TO "anon";
GRANT ALL ON TABLE "public"."beta_access_requests" TO "authenticated";
GRANT ALL ON TABLE "public"."beta_access_requests" TO "service_role";



GRANT ALL ON TABLE "public"."billing_invoices" TO "anon";
GRANT ALL ON TABLE "public"."billing_invoices" TO "authenticated";
GRANT ALL ON TABLE "public"."billing_invoices" TO "service_role";



GRANT ALL ON TABLE "public"."billing_line_items" TO "anon";
GRANT ALL ON TABLE "public"."billing_line_items" TO "authenticated";
GRANT ALL ON TABLE "public"."billing_line_items" TO "service_role";



GRANT ALL ON TABLE "public"."billing_payments" TO "anon";
GRANT ALL ON TABLE "public"."billing_payments" TO "authenticated";
GRANT ALL ON TABLE "public"."billing_payments" TO "service_role";



GRANT ALL ON TABLE "public"."blood_deferrals" TO "anon";
GRANT ALL ON TABLE "public"."blood_deferrals" TO "authenticated";
GRANT ALL ON TABLE "public"."blood_deferrals" TO "service_role";



GRANT ALL ON TABLE "public"."blood_donation_profiles" TO "anon";
GRANT ALL ON TABLE "public"."blood_donation_profiles" TO "authenticated";
GRANT ALL ON TABLE "public"."blood_donation_profiles" TO "service_role";



GRANT ALL ON TABLE "public"."blood_donations" TO "anon";
GRANT ALL ON TABLE "public"."blood_donations" TO "authenticated";
GRANT ALL ON TABLE "public"."blood_donations" TO "service_role";



GRANT ALL ON TABLE "public"."body_register" TO "anon";
GRANT ALL ON TABLE "public"."body_register" TO "authenticated";
GRANT ALL ON TABLE "public"."body_register" TO "service_role";



GRANT ALL ON TABLE "public"."calls" TO "anon";
GRANT ALL ON TABLE "public"."calls" TO "authenticated";
GRANT ALL ON TABLE "public"."calls" TO "service_role";



GRANT ALL ON TABLE "public"."capabilities" TO "anon";
GRANT ALL ON TABLE "public"."capabilities" TO "authenticated";
GRANT ALL ON TABLE "public"."capabilities" TO "service_role";



GRANT ALL ON TABLE "public"."care_team_handovers" TO "anon";
GRANT ALL ON TABLE "public"."care_team_handovers" TO "authenticated";
GRANT ALL ON TABLE "public"."care_team_handovers" TO "service_role";



GRANT ALL ON TABLE "public"."cds_alerts" TO "anon";
GRANT ALL ON TABLE "public"."cds_alerts" TO "authenticated";
GRANT ALL ON TABLE "public"."cds_alerts" TO "service_role";



GRANT ALL ON TABLE "public"."cds_rules" TO "anon";
GRANT ALL ON TABLE "public"."cds_rules" TO "authenticated";
GRANT ALL ON TABLE "public"."cds_rules" TO "service_role";



GRANT ALL ON TABLE "public"."chw_visits" TO "anon";
GRANT ALL ON TABLE "public"."chw_visits" TO "authenticated";
GRANT ALL ON TABLE "public"."chw_visits" TO "service_role";



GRANT ALL ON TABLE "public"."claim_line_items" TO "anon";
GRANT ALL ON TABLE "public"."claim_line_items" TO "authenticated";
GRANT ALL ON TABLE "public"."claim_line_items" TO "service_role";



GRANT ALL ON TABLE "public"."claim_resubmissions" TO "anon";
GRANT ALL ON TABLE "public"."claim_resubmissions" TO "authenticated";
GRANT ALL ON TABLE "public"."claim_resubmissions" TO "service_role";



GRANT ALL ON TABLE "public"."clinical_intelligence_decisions" TO "anon";
GRANT ALL ON TABLE "public"."clinical_intelligence_decisions" TO "authenticated";
GRANT ALL ON TABLE "public"."clinical_intelligence_decisions" TO "service_role";



GRANT ALL ON TABLE "public"."clinical_intelligence_sessions" TO "anon";
GRANT ALL ON TABLE "public"."clinical_intelligence_sessions" TO "authenticated";
GRANT ALL ON TABLE "public"."clinical_intelligence_sessions" TO "service_role";



GRANT ALL ON TABLE "public"."clinical_note_embeddings" TO "anon";
GRANT ALL ON TABLE "public"."clinical_note_embeddings" TO "authenticated";
GRANT ALL ON TABLE "public"."clinical_note_embeddings" TO "service_role";



GRANT ALL ON TABLE "public"."clinical_notes" TO "anon";
GRANT ALL ON TABLE "public"."clinical_notes" TO "authenticated";
GRANT ALL ON TABLE "public"."clinical_notes" TO "service_role";



GRANT ALL ON TABLE "public"."clinical_pathway_templates" TO "anon";
GRANT ALL ON TABLE "public"."clinical_pathway_templates" TO "authenticated";
GRANT ALL ON TABLE "public"."clinical_pathway_templates" TO "service_role";



GRANT ALL ON TABLE "public"."clinical_prescriptions" TO "authenticated";
GRANT ALL ON TABLE "public"."clinical_prescriptions" TO "service_role";



GRANT ALL ON TABLE "public"."community_health_workers" TO "anon";
GRANT ALL ON TABLE "public"."community_health_workers" TO "authenticated";
GRANT ALL ON TABLE "public"."community_health_workers" TO "service_role";



GRANT ALL ON TABLE "public"."consent_audit_log" TO "anon";
GRANT ALL ON TABLE "public"."consent_audit_log" TO "authenticated";
GRANT ALL ON TABLE "public"."consent_audit_log" TO "service_role";



GRANT ALL ON TABLE "public"."cross_tenant_access" TO "anon";
GRANT ALL ON TABLE "public"."cross_tenant_access" TO "authenticated";
GRANT ALL ON TABLE "public"."cross_tenant_access" TO "service_role";



GRANT ALL ON TABLE "public"."data_breach_incidents" TO "anon";
GRANT ALL ON TABLE "public"."data_breach_incidents" TO "authenticated";
GRANT ALL ON TABLE "public"."data_breach_incidents" TO "service_role";



GRANT ALL ON TABLE "public"."data_export_jobs" TO "anon";
GRANT ALL ON TABLE "public"."data_export_jobs" TO "authenticated";
GRANT ALL ON TABLE "public"."data_export_jobs" TO "service_role";



GRANT ALL ON TABLE "public"."data_retention_policies" TO "anon";
GRANT ALL ON TABLE "public"."data_retention_policies" TO "authenticated";
GRANT ALL ON TABLE "public"."data_retention_policies" TO "service_role";



GRANT ALL ON TABLE "public"."death_registrations" TO "anon";
GRANT ALL ON TABLE "public"."death_registrations" TO "authenticated";
GRANT ALL ON TABLE "public"."death_registrations" TO "service_role";



GRANT ALL ON TABLE "public"."death_reports" TO "anon";
GRANT ALL ON TABLE "public"."death_reports" TO "authenticated";
GRANT ALL ON TABLE "public"."death_reports" TO "service_role";



GRANT ALL ON TABLE "public"."deidentification_profiles" TO "anon";
GRANT ALL ON TABLE "public"."deidentification_profiles" TO "authenticated";
GRANT ALL ON TABLE "public"."deidentification_profiles" TO "service_role";



GRANT ALL ON TABLE "public"."demo_departments" TO "anon";
GRANT ALL ON TABLE "public"."demo_departments" TO "authenticated";
GRANT ALL ON TABLE "public"."demo_departments" TO "service_role";



GRANT ALL ON TABLE "public"."demo_encounter_orders" TO "anon";
GRANT ALL ON TABLE "public"."demo_encounter_orders" TO "authenticated";
GRANT ALL ON TABLE "public"."demo_encounter_orders" TO "service_role";



GRANT ALL ON TABLE "public"."demo_encounters" TO "anon";
GRANT ALL ON TABLE "public"."demo_encounters" TO "authenticated";
GRANT ALL ON TABLE "public"."demo_encounters" TO "service_role";



GRANT ALL ON TABLE "public"."demo_lab_results" TO "anon";
GRANT ALL ON TABLE "public"."demo_lab_results" TO "authenticated";
GRANT ALL ON TABLE "public"."demo_lab_results" TO "service_role";



GRANT ALL ON TABLE "public"."demo_patients" TO "anon";
GRANT ALL ON TABLE "public"."demo_patients" TO "authenticated";
GRANT ALL ON TABLE "public"."demo_patients" TO "service_role";



GRANT ALL ON TABLE "public"."demo_vitals" TO "anon";
GRANT ALL ON TABLE "public"."demo_vitals" TO "authenticated";
GRANT ALL ON TABLE "public"."demo_vitals" TO "service_role";



GRANT ALL ON TABLE "public"."denial_analytics_daily" TO "anon";
GRANT ALL ON TABLE "public"."denial_analytics_daily" TO "authenticated";
GRANT ALL ON TABLE "public"."denial_analytics_daily" TO "service_role";



GRANT ALL ON TABLE "public"."department_tasks" TO "anon";
GRANT ALL ON TABLE "public"."department_tasks" TO "authenticated";
GRANT ALL ON TABLE "public"."department_tasks" TO "service_role";



GRANT ALL ON TABLE "public"."departments" TO "anon";
GRANT ALL ON TABLE "public"."departments" TO "authenticated";
GRANT ALL ON TABLE "public"."departments" TO "service_role";



GRANT ALL ON TABLE "public"."device_alerts" TO "anon";
GRANT ALL ON TABLE "public"."device_alerts" TO "authenticated";
GRANT ALL ON TABLE "public"."device_alerts" TO "service_role";



GRANT ALL ON TABLE "public"."device_readings" TO "anon";
GRANT ALL ON TABLE "public"."device_readings" TO "authenticated";
GRANT ALL ON TABLE "public"."device_readings" TO "service_role";



GRANT ALL ON TABLE "public"."dhis2_data_element_mappings" TO "anon";
GRANT ALL ON TABLE "public"."dhis2_data_element_mappings" TO "authenticated";
GRANT ALL ON TABLE "public"."dhis2_data_element_mappings" TO "service_role";



GRANT ALL ON TABLE "public"."dhis2_export_attempt_log" TO "anon";
GRANT ALL ON TABLE "public"."dhis2_export_attempt_log" TO "authenticated";
GRANT ALL ON TABLE "public"."dhis2_export_attempt_log" TO "service_role";



GRANT ALL ON TABLE "public"."dhis2_export_jobs" TO "anon";
GRANT ALL ON TABLE "public"."dhis2_export_jobs" TO "authenticated";
GRANT ALL ON TABLE "public"."dhis2_export_jobs" TO "service_role";



GRANT ALL ON TABLE "public"."dhis2_export_log" TO "anon";
GRANT ALL ON TABLE "public"."dhis2_export_log" TO "authenticated";
GRANT ALL ON TABLE "public"."dhis2_export_log" TO "service_role";



GRANT ALL ON TABLE "public"."dhis2_org_unit_mappings" TO "anon";
GRANT ALL ON TABLE "public"."dhis2_org_unit_mappings" TO "authenticated";
GRANT ALL ON TABLE "public"."dhis2_org_unit_mappings" TO "service_role";



GRANT ALL ON TABLE "public"."diagnoses" TO "anon";
GRANT ALL ON TABLE "public"."diagnoses" TO "authenticated";
GRANT ALL ON TABLE "public"."diagnoses" TO "service_role";



GRANT ALL ON TABLE "public"."diet_logs" TO "anon";
GRANT ALL ON TABLE "public"."diet_logs" TO "authenticated";
GRANT ALL ON TABLE "public"."diet_logs" TO "service_role";



GRANT ALL ON TABLE "public"."doctor_availability_log" TO "anon";
GRANT ALL ON TABLE "public"."doctor_availability_log" TO "authenticated";
GRANT ALL ON TABLE "public"."doctor_availability_log" TO "service_role";



GRANT ALL ON TABLE "public"."domain_event_consumers" TO "anon";
GRANT ALL ON TABLE "public"."domain_event_consumers" TO "authenticated";
GRANT ALL ON TABLE "public"."domain_event_consumers" TO "service_role";



GRANT ALL ON TABLE "public"."domain_events" TO "anon";
GRANT ALL ON TABLE "public"."domain_events" TO "authenticated";
GRANT ALL ON TABLE "public"."domain_events" TO "service_role";



GRANT ALL ON TABLE "public"."drug_contraindications" TO "anon";
GRANT ALL ON TABLE "public"."drug_contraindications" TO "authenticated";
GRANT ALL ON TABLE "public"."drug_contraindications" TO "service_role";



GRANT ALL ON TABLE "public"."drug_dose_adjustments" TO "anon";
GRANT ALL ON TABLE "public"."drug_dose_adjustments" TO "authenticated";
GRANT ALL ON TABLE "public"."drug_dose_adjustments" TO "service_role";



GRANT ALL ON TABLE "public"."drug_interactions" TO "anon";
GRANT ALL ON TABLE "public"."drug_interactions" TO "authenticated";
GRANT ALL ON TABLE "public"."drug_interactions" TO "service_role";



GRANT ALL ON TABLE "public"."drug_interactions_catalog" TO "anon";
GRANT ALL ON TABLE "public"."drug_interactions_catalog" TO "authenticated";
GRANT ALL ON TABLE "public"."drug_interactions_catalog" TO "service_role";



GRANT ALL ON TABLE "public"."drug_inventory" TO "anon";
GRANT ALL ON TABLE "public"."drug_inventory" TO "authenticated";
GRANT ALL ON TABLE "public"."drug_inventory" TO "service_role";



GRANT ALL ON TABLE "public"."drug_shortage_alerts" TO "anon";
GRANT ALL ON TABLE "public"."drug_shortage_alerts" TO "authenticated";
GRANT ALL ON TABLE "public"."drug_shortage_alerts" TO "service_role";



GRANT ALL ON TABLE "public"."emergency_access_events" TO "anon";
GRANT ALL ON TABLE "public"."emergency_access_events" TO "authenticated";
GRANT ALL ON TABLE "public"."emergency_access_events" TO "service_role";



GRANT ALL ON TABLE "public"."emergency_profiles" TO "anon";
GRANT ALL ON TABLE "public"."emergency_profiles" TO "authenticated";
GRANT ALL ON TABLE "public"."emergency_profiles" TO "service_role";



GRANT ALL ON TABLE "public"."encounter_amendments" TO "anon";
GRANT ALL ON TABLE "public"."encounter_amendments" TO "authenticated";
GRANT ALL ON TABLE "public"."encounter_amendments" TO "service_role";



GRANT ALL ON TABLE "public"."encounter_diagnoses" TO "anon";
GRANT ALL ON TABLE "public"."encounter_diagnoses" TO "authenticated";
GRANT ALL ON TABLE "public"."encounter_diagnoses" TO "service_role";



GRANT ALL ON TABLE "public"."encounter_orders" TO "anon";
GRANT ALL ON TABLE "public"."encounter_orders" TO "authenticated";
GRANT ALL ON TABLE "public"."encounter_orders" TO "service_role";



GRANT ALL ON TABLE "public"."encounters" TO "anon";
GRANT ALL ON TABLE "public"."encounters" TO "authenticated";
GRANT ALL ON TABLE "public"."encounters" TO "service_role";



GRANT ALL ON TABLE "public"."expert_rules" TO "anon";
GRANT ALL ON TABLE "public"."expert_rules" TO "authenticated";
GRANT ALL ON TABLE "public"."expert_rules" TO "service_role";



GRANT ALL ON TABLE "public"."facility_domain_records" TO "anon";
GRANT ALL ON TABLE "public"."facility_domain_records" TO "authenticated";
GRANT ALL ON TABLE "public"."facility_domain_records" TO "service_role";



GRANT ALL ON TABLE "public"."facility_invitation_audit" TO "anon";
GRANT ALL ON TABLE "public"."facility_invitation_audit" TO "authenticated";
GRANT ALL ON TABLE "public"."facility_invitation_audit" TO "service_role";



GRANT ALL ON TABLE "public"."facility_invitations" TO "anon";
GRANT ALL ON TABLE "public"."facility_invitations" TO "authenticated";
GRANT ALL ON TABLE "public"."facility_invitations" TO "service_role";



GRANT ALL ON TABLE "public"."facility_lifecycle_events" TO "anon";
GRANT ALL ON TABLE "public"."facility_lifecycle_events" TO "authenticated";
GRANT ALL ON TABLE "public"."facility_lifecycle_events" TO "service_role";



GRANT ALL ON TABLE "public"."facility_locations" TO "anon";
GRANT ALL ON TABLE "public"."facility_locations" TO "authenticated";
GRANT ALL ON TABLE "public"."facility_locations" TO "service_role";



GRANT ALL ON TABLE "public"."facility_provisioning_runs" TO "anon";
GRANT ALL ON TABLE "public"."facility_provisioning_runs" TO "authenticated";
GRANT ALL ON TABLE "public"."facility_provisioning_runs" TO "service_role";



GRANT ALL ON TABLE "public"."facility_provisioning_steps" TO "anon";
GRANT ALL ON TABLE "public"."facility_provisioning_steps" TO "authenticated";
GRANT ALL ON TABLE "public"."facility_provisioning_steps" TO "service_role";



GRANT ALL ON TABLE "public"."facility_referrals" TO "anon";
GRANT ALL ON TABLE "public"."facility_referrals" TO "authenticated";
GRANT ALL ON TABLE "public"."facility_referrals" TO "service_role";



GRANT ALL ON TABLE "public"."facility_resource_logs" TO "anon";
GRANT ALL ON TABLE "public"."facility_resource_logs" TO "authenticated";
GRANT ALL ON TABLE "public"."facility_resource_logs" TO "service_role";



GRANT ALL ON TABLE "public"."facility_type_inheritance" TO "anon";
GRANT ALL ON TABLE "public"."facility_type_inheritance" TO "authenticated";
GRANT ALL ON TABLE "public"."facility_type_inheritance" TO "service_role";



GRANT ALL ON TABLE "public"."feature_flags" TO "anon";
GRANT ALL ON TABLE "public"."feature_flags" TO "authenticated";
GRANT ALL ON TABLE "public"."feature_flags" TO "service_role";



GRANT ALL ON TABLE "public"."gas_cylinders" TO "anon";
GRANT ALL ON TABLE "public"."gas_cylinders" TO "authenticated";
GRANT ALL ON TABLE "public"."gas_cylinders" TO "service_role";



GRANT ALL ON TABLE "public"."habit_logs" TO "anon";
GRANT ALL ON TABLE "public"."habit_logs" TO "authenticated";
GRANT ALL ON TABLE "public"."habit_logs" TO "service_role";



GRANT ALL ON TABLE "public"."handover_patient_entries" TO "anon";
GRANT ALL ON TABLE "public"."handover_patient_entries" TO "authenticated";
GRANT ALL ON TABLE "public"."handover_patient_entries" TO "service_role";



GRANT ALL ON TABLE "public"."handover_shift_tasks" TO "anon";
GRANT ALL ON TABLE "public"."handover_shift_tasks" TO "authenticated";
GRANT ALL ON TABLE "public"."handover_shift_tasks" TO "service_role";



GRANT ALL ON TABLE "public"."handover_signatures" TO "anon";
GRANT ALL ON TABLE "public"."handover_signatures" TO "authenticated";
GRANT ALL ON TABLE "public"."handover_signatures" TO "service_role";



GRANT ALL ON TABLE "public"."health_bulletins" TO "anon";
GRANT ALL ON TABLE "public"."health_bulletins" TO "authenticated";
GRANT ALL ON TABLE "public"."health_bulletins" TO "service_role";



GRANT ALL ON TABLE "public"."health_habits" TO "anon";
GRANT ALL ON TABLE "public"."health_habits" TO "authenticated";
GRANT ALL ON TABLE "public"."health_habits" TO "service_role";



GRANT ALL ON TABLE "public"."hospital_beds" TO "anon";
GRANT ALL ON TABLE "public"."hospital_beds" TO "authenticated";
GRANT ALL ON TABLE "public"."hospital_beds" TO "service_role";



GRANT ALL ON TABLE "public"."hospital_drug_orders" TO "anon";
GRANT ALL ON TABLE "public"."hospital_drug_orders" TO "authenticated";
GRANT ALL ON TABLE "public"."hospital_drug_orders" TO "service_role";



GRANT ALL ON TABLE "public"."hospital_leads" TO "anon";
GRANT ALL ON TABLE "public"."hospital_leads" TO "authenticated";
GRANT ALL ON TABLE "public"."hospital_leads" TO "service_role";



GRANT ALL ON TABLE "public"."hospital_modules" TO "anon";
GRANT ALL ON TABLE "public"."hospital_modules" TO "authenticated";
GRANT ALL ON TABLE "public"."hospital_modules" TO "service_role";



GRANT ALL ON TABLE "public"."hospital_seed_registry" TO "anon";
GRANT ALL ON TABLE "public"."hospital_seed_registry" TO "authenticated";
GRANT ALL ON TABLE "public"."hospital_seed_registry" TO "service_role";



GRANT ALL ON TABLE "public"."hospital_settings" TO "anon";
GRANT ALL ON TABLE "public"."hospital_settings" TO "authenticated";
GRANT ALL ON TABLE "public"."hospital_settings" TO "service_role";



GRANT ALL ON TABLE "public"."hospitals" TO "anon";
GRANT ALL ON TABLE "public"."hospitals" TO "authenticated";
GRANT ALL ON TABLE "public"."hospitals" TO "service_role";



GRANT ALL ON TABLE "public"."housekeeping_tasks" TO "anon";
GRANT ALL ON TABLE "public"."housekeeping_tasks" TO "authenticated";
GRANT ALL ON TABLE "public"."housekeeping_tasks" TO "service_role";



GRANT ALL ON TABLE "public"."icd11_cache" TO "authenticated";
GRANT ALL ON TABLE "public"."icd11_cache" TO "service_role";



GRANT ALL ON TABLE "public"."identity_match_candidates" TO "anon";
GRANT ALL ON TABLE "public"."identity_match_candidates" TO "authenticated";
GRANT ALL ON TABLE "public"."identity_match_candidates" TO "service_role";



GRANT ALL ON TABLE "public"."identity_merge_events" TO "anon";
GRANT ALL ON TABLE "public"."identity_merge_events" TO "authenticated";
GRANT ALL ON TABLE "public"."identity_merge_events" TO "service_role";



GRANT ALL ON TABLE "public"."imaging_series" TO "anon";
GRANT ALL ON TABLE "public"."imaging_series" TO "authenticated";
GRANT ALL ON TABLE "public"."imaging_series" TO "service_role";



GRANT ALL ON TABLE "public"."imaging_studies" TO "anon";
GRANT ALL ON TABLE "public"."imaging_studies" TO "authenticated";
GRANT ALL ON TABLE "public"."imaging_studies" TO "service_role";



GRANT ALL ON TABLE "public"."imid_access_log" TO "anon";
GRANT ALL ON TABLE "public"."imid_access_log" TO "authenticated";
GRANT ALL ON TABLE "public"."imid_access_log" TO "service_role";



GRANT ALL ON TABLE "public"."imid_codes" TO "anon";
GRANT ALL ON TABLE "public"."imid_codes" TO "authenticated";
GRANT ALL ON TABLE "public"."imid_codes" TO "service_role";



GRANT ALL ON TABLE "public"."immunization_schedule" TO "anon";
GRANT ALL ON TABLE "public"."immunization_schedule" TO "authenticated";
GRANT ALL ON TABLE "public"."immunization_schedule" TO "service_role";



GRANT ALL ON TABLE "public"."import_batch_rows" TO "anon";
GRANT ALL ON TABLE "public"."import_batch_rows" TO "authenticated";
GRANT ALL ON TABLE "public"."import_batch_rows" TO "service_role";



GRANT ALL ON TABLE "public"."import_batches" TO "anon";
GRANT ALL ON TABLE "public"."import_batches" TO "authenticated";
GRANT ALL ON TABLE "public"."import_batches" TO "service_role";



GRANT ALL ON TABLE "public"."import_column_mappings" TO "anon";
GRANT ALL ON TABLE "public"."import_column_mappings" TO "authenticated";
GRANT ALL ON TABLE "public"."import_column_mappings" TO "service_role";



GRANT ALL ON TABLE "public"."insurance_benefits" TO "anon";
GRANT ALL ON TABLE "public"."insurance_benefits" TO "authenticated";
GRANT ALL ON TABLE "public"."insurance_benefits" TO "service_role";



GRANT ALL ON TABLE "public"."insurance_claims" TO "anon";
GRANT ALL ON TABLE "public"."insurance_claims" TO "authenticated";
GRANT ALL ON TABLE "public"."insurance_claims" TO "service_role";



GRANT ALL ON TABLE "public"."insurance_copilot_audit" TO "anon";
GRANT ALL ON TABLE "public"."insurance_copilot_audit" TO "authenticated";
GRANT ALL ON TABLE "public"."insurance_copilot_audit" TO "service_role";



GRANT ALL ON TABLE "public"."insurance_coverage_checks" TO "anon";
GRANT ALL ON TABLE "public"."insurance_coverage_checks" TO "authenticated";
GRANT ALL ON TABLE "public"."insurance_coverage_checks" TO "service_role";



GRANT ALL ON TABLE "public"."insurance_memberships" TO "anon";
GRANT ALL ON TABLE "public"."insurance_memberships" TO "authenticated";
GRANT ALL ON TABLE "public"."insurance_memberships" TO "service_role";



GRANT ALL ON TABLE "public"."insurance_policies" TO "anon";
GRANT ALL ON TABLE "public"."insurance_policies" TO "authenticated";
GRANT ALL ON TABLE "public"."insurance_policies" TO "service_role";



GRANT ALL ON TABLE "public"."insurance_preauthorizations" TO "anon";
GRANT ALL ON TABLE "public"."insurance_preauthorizations" TO "authenticated";
GRANT ALL ON TABLE "public"."insurance_preauthorizations" TO "service_role";



GRANT ALL ON TABLE "public"."insurance_providers" TO "anon";
GRANT ALL ON TABLE "public"."insurance_providers" TO "authenticated";
GRANT ALL ON TABLE "public"."insurance_providers" TO "service_role";



GRANT ALL ON TABLE "public"."intelligence_actions" TO "authenticated";
GRANT ALL ON TABLE "public"."intelligence_actions" TO "service_role";



GRANT ALL ON TABLE "public"."intelligence_recommendations" TO "authenticated";
GRANT ALL ON TABLE "public"."intelligence_recommendations" TO "service_role";



GRANT ALL ON TABLE "public"."interop_connections" TO "anon";
GRANT ALL ON TABLE "public"."interop_connections" TO "authenticated";
GRANT ALL ON TABLE "public"."interop_connections" TO "service_role";



GRANT ALL ON TABLE "public"."interop_messages" TO "anon";
GRANT ALL ON TABLE "public"."interop_messages" TO "authenticated";
GRANT ALL ON TABLE "public"."interop_messages" TO "service_role";



GRANT ALL ON TABLE "public"."inventory_items" TO "anon";
GRANT ALL ON TABLE "public"."inventory_items" TO "authenticated";
GRANT ALL ON TABLE "public"."inventory_items" TO "service_role";



GRANT ALL ON TABLE "public"."lab_accession_counters" TO "anon";
GRANT ALL ON TABLE "public"."lab_accession_counters" TO "authenticated";
GRANT ALL ON TABLE "public"."lab_accession_counters" TO "service_role";



GRANT ALL ON TABLE "public"."lab_analyzer_messages" TO "anon";
GRANT ALL ON TABLE "public"."lab_analyzer_messages" TO "authenticated";
GRANT ALL ON TABLE "public"."lab_analyzer_messages" TO "service_role";



GRANT ALL ON TABLE "public"."lab_critical_acknowledgements" TO "authenticated";
GRANT ALL ON TABLE "public"."lab_critical_acknowledgements" TO "service_role";



GRANT ALL ON TABLE "public"."lab_device_messages" TO "anon";
GRANT ALL ON TABLE "public"."lab_device_messages" TO "authenticated";
GRANT ALL ON TABLE "public"."lab_device_messages" TO "service_role";



GRANT ALL ON TABLE "public"."lab_device_test_mappings" TO "anon";
GRANT ALL ON TABLE "public"."lab_device_test_mappings" TO "authenticated";
GRANT ALL ON TABLE "public"."lab_device_test_mappings" TO "service_role";



GRANT ALL ON TABLE "public"."lab_devices" TO "anon";
GRANT ALL ON TABLE "public"."lab_devices" TO "authenticated";
GRANT ALL ON TABLE "public"."lab_devices" TO "service_role";



GRANT ALL ON TABLE "public"."lab_instrument_bridges" TO "anon";
GRANT ALL ON TABLE "public"."lab_instrument_bridges" TO "authenticated";
GRANT ALL ON TABLE "public"."lab_instrument_bridges" TO "service_role";



GRANT ALL ON TABLE "public"."lab_orders" TO "anon";
GRANT ALL ON TABLE "public"."lab_orders" TO "authenticated";
GRANT ALL ON TABLE "public"."lab_orders" TO "service_role";



GRANT ALL ON TABLE "public"."lab_reference_ranges" TO "authenticated";
GRANT ALL ON TABLE "public"."lab_reference_ranges" TO "service_role";



GRANT ALL ON TABLE "public"."lab_reports" TO "anon";
GRANT ALL ON TABLE "public"."lab_reports" TO "authenticated";
GRANT ALL ON TABLE "public"."lab_reports" TO "service_role";



GRANT ALL ON TABLE "public"."lab_result_amendments" TO "authenticated";
GRANT ALL ON TABLE "public"."lab_result_amendments" TO "service_role";



GRANT ALL ON TABLE "public"."lab_result_staging" TO "anon";
GRANT ALL ON TABLE "public"."lab_result_staging" TO "authenticated";
GRANT ALL ON TABLE "public"."lab_result_staging" TO "service_role";



GRANT ALL ON TABLE "public"."lab_results" TO "anon";
GRANT ALL ON TABLE "public"."lab_results" TO "authenticated";
GRANT ALL ON TABLE "public"."lab_results" TO "service_role";



GRANT ALL ON TABLE "public"."lab_specimens" TO "anon";
GRANT ALL ON TABLE "public"."lab_specimens" TO "authenticated";
GRANT ALL ON TABLE "public"."lab_specimens" TO "service_role";



GRANT ALL ON TABLE "public"."live_feed_sessions" TO "anon";
GRANT ALL ON TABLE "public"."live_feed_sessions" TO "authenticated";
GRANT ALL ON TABLE "public"."live_feed_sessions" TO "service_role";



GRANT ALL ON TABLE "public"."loinc_reference" TO "anon";
GRANT ALL ON TABLE "public"."loinc_reference" TO "authenticated";
GRANT ALL ON TABLE "public"."loinc_reference" TO "service_role";



GRANT ALL ON TABLE "public"."maternity_records" TO "anon";
GRANT ALL ON TABLE "public"."maternity_records" TO "authenticated";
GRANT ALL ON TABLE "public"."maternity_records" TO "service_role";



GRANT ALL ON TABLE "public"."medical_devices" TO "anon";
GRANT ALL ON TABLE "public"."medical_devices" TO "authenticated";
GRANT ALL ON TABLE "public"."medical_devices" TO "service_role";



GRANT ALL ON TABLE "public"."medication_safety_checks" TO "anon";
GRANT ALL ON TABLE "public"."medication_safety_checks" TO "authenticated";
GRANT ALL ON TABLE "public"."medication_safety_checks" TO "service_role";



GRANT ALL ON TABLE "public"."menstrual_cycles" TO "anon";
GRANT ALL ON TABLE "public"."menstrual_cycles" TO "authenticated";
GRANT ALL ON TABLE "public"."menstrual_cycles" TO "service_role";



GRANT ALL ON TABLE "public"."mfa_enrollments" TO "anon";
GRANT ALL ON TABLE "public"."mfa_enrollments" TO "authenticated";
GRANT ALL ON TABLE "public"."mfa_enrollments" TO "service_role";



GRANT ALL ON TABLE "public"."mfa_step_up_replays" TO "service_role";



GRANT ALL ON TABLE "public"."mobile_push_tokens" TO "anon";
GRANT ALL ON TABLE "public"."mobile_push_tokens" TO "authenticated";
GRANT ALL ON TABLE "public"."mobile_push_tokens" TO "service_role";



GRANT ALL ON TABLE "public"."newsletter_subscribers" TO "anon";
GRANT ALL ON TABLE "public"."newsletter_subscribers" TO "authenticated";
GRANT ALL ON TABLE "public"."newsletter_subscribers" TO "service_role";



GRANT ALL ON TABLE "public"."nin_access_log" TO "anon";
GRANT ALL ON TABLE "public"."nin_access_log" TO "authenticated";
GRANT ALL ON TABLE "public"."nin_access_log" TO "service_role";



GRANT ALL ON TABLE "public"."notifications" TO "anon";
GRANT ALL ON TABLE "public"."notifications" TO "authenticated";
GRANT ALL ON TABLE "public"."notifications" TO "service_role";



GRANT ALL ON TABLE "public"."offline_mutation_outbox" TO "anon";
GRANT ALL ON TABLE "public"."offline_mutation_outbox" TO "authenticated";
GRANT ALL ON TABLE "public"."offline_mutation_outbox" TO "service_role";



GRANT ALL ON TABLE "public"."offline_sync_queue" TO "anon";
GRANT ALL ON TABLE "public"."offline_sync_queue" TO "authenticated";
GRANT ALL ON TABLE "public"."offline_sync_queue" TO "service_role";



GRANT ALL ON TABLE "public"."order_items" TO "anon";
GRANT ALL ON TABLE "public"."order_items" TO "authenticated";
GRANT ALL ON TABLE "public"."order_items" TO "service_role";



GRANT ALL ON TABLE "public"."order_mappings" TO "anon";
GRANT ALL ON TABLE "public"."order_mappings" TO "authenticated";
GRANT ALL ON TABLE "public"."order_mappings" TO "service_role";



GRANT ALL ON TABLE "public"."orders" TO "anon";
GRANT ALL ON TABLE "public"."orders" TO "authenticated";
GRANT ALL ON TABLE "public"."orders" TO "service_role";



GRANT ALL ON TABLE "public"."organizations" TO "anon";
GRANT ALL ON TABLE "public"."organizations" TO "authenticated";
GRANT ALL ON TABLE "public"."organizations" TO "service_role";



GRANT ALL ON TABLE "public"."outbreak_alerts" TO "anon";
GRANT ALL ON TABLE "public"."outbreak_alerts" TO "authenticated";
GRANT ALL ON TABLE "public"."outbreak_alerts" TO "service_role";



GRANT ALL ON TABLE "public"."outreach_campaigns" TO "anon";
GRANT ALL ON TABLE "public"."outreach_campaigns" TO "authenticated";
GRANT ALL ON TABLE "public"."outreach_campaigns" TO "service_role";



GRANT ALL ON TABLE "public"."partograph_records" TO "anon";
GRANT ALL ON TABLE "public"."partograph_records" TO "authenticated";
GRANT ALL ON TABLE "public"."partograph_records" TO "service_role";



GRANT ALL ON TABLE "public"."passport_access_log" TO "anon";
GRANT ALL ON TABLE "public"."passport_access_log" TO "authenticated";
GRANT ALL ON TABLE "public"."passport_access_log" TO "service_role";



GRANT ALL ON TABLE "public"."passport_share_tokens" TO "anon";
GRANT ALL ON TABLE "public"."passport_share_tokens" TO "authenticated";
GRANT ALL ON TABLE "public"."passport_share_tokens" TO "service_role";



GRANT ALL ON TABLE "public"."password_reset_tokens" TO "service_role";



GRANT ALL ON TABLE "public"."pathway_alerts" TO "anon";
GRANT ALL ON TABLE "public"."pathway_alerts" TO "authenticated";
GRANT ALL ON TABLE "public"."pathway_alerts" TO "service_role";



GRANT ALL ON TABLE "public"."pathway_checklist_items" TO "anon";
GRANT ALL ON TABLE "public"."pathway_checklist_items" TO "authenticated";
GRANT ALL ON TABLE "public"."pathway_checklist_items" TO "service_role";



GRANT ALL ON TABLE "public"."pathway_overrides" TO "authenticated";
GRANT ALL ON TABLE "public"."pathway_overrides" TO "service_role";



GRANT ALL ON TABLE "public"."patient_access_grants" TO "anon";
GRANT ALL ON TABLE "public"."patient_access_grants" TO "authenticated";
GRANT ALL ON TABLE "public"."patient_access_grants" TO "service_role";



GRANT ALL ON TABLE "public"."patient_allergies" TO "anon";
GRANT ALL ON TABLE "public"."patient_allergies" TO "authenticated";
GRANT ALL ON TABLE "public"."patient_allergies" TO "service_role";



GRANT ALL ON TABLE "public"."patient_billing" TO "anon";
GRANT ALL ON TABLE "public"."patient_billing" TO "authenticated";
GRANT ALL ON TABLE "public"."patient_billing" TO "service_role";



GRANT ALL ON TABLE "public"."patient_clinical_patterns" TO "anon";
GRANT ALL ON TABLE "public"."patient_clinical_patterns" TO "authenticated";
GRANT ALL ON TABLE "public"."patient_clinical_patterns" TO "service_role";



GRANT ALL ON TABLE "public"."patient_consents" TO "anon";
GRANT ALL ON TABLE "public"."patient_consents" TO "authenticated";
GRANT ALL ON TABLE "public"."patient_consents" TO "service_role";



GRANT ALL ON TABLE "public"."patient_history_queries" TO "anon";
GRANT ALL ON TABLE "public"."patient_history_queries" TO "authenticated";
GRANT ALL ON TABLE "public"."patient_history_queries" TO "service_role";



GRANT ALL ON TABLE "public"."patient_intervention_outcomes" TO "anon";
GRANT ALL ON TABLE "public"."patient_intervention_outcomes" TO "authenticated";
GRANT ALL ON TABLE "public"."patient_intervention_outcomes" TO "service_role";



GRANT ALL ON TABLE "public"."patient_notes" TO "anon";
GRANT ALL ON TABLE "public"."patient_notes" TO "authenticated";
GRANT ALL ON TABLE "public"."patient_notes" TO "service_role";



GRANT ALL ON TABLE "public"."patient_pathways" TO "anon";
GRANT ALL ON TABLE "public"."patient_pathways" TO "authenticated";
GRANT ALL ON TABLE "public"."patient_pathways" TO "service_role";



GRANT ALL ON TABLE "public"."patient_problem_list" TO "anon";
GRANT ALL ON TABLE "public"."patient_problem_list" TO "authenticated";
GRANT ALL ON TABLE "public"."patient_problem_list" TO "service_role";



GRANT ALL ON TABLE "public"."patient_profiles" TO "anon";
GRANT ALL ON TABLE "public"."patient_profiles" TO "authenticated";
GRANT ALL ON TABLE "public"."patient_profiles" TO "service_role";



GRANT ALL ON TABLE "public"."patient_safety_events" TO "anon";
GRANT ALL ON TABLE "public"."patient_safety_events" TO "authenticated";
GRANT ALL ON TABLE "public"."patient_safety_events" TO "service_role";



GRANT ALL ON TABLE "public"."patient_sms_reminders" TO "anon";
GRANT ALL ON TABLE "public"."patient_sms_reminders" TO "authenticated";
GRANT ALL ON TABLE "public"."patient_sms_reminders" TO "service_role";



GRANT ALL ON TABLE "public"."patient_timeline_events" TO "anon";
GRANT ALL ON TABLE "public"."patient_timeline_events" TO "authenticated";
GRANT ALL ON TABLE "public"."patient_timeline_events" TO "service_role";



GRANT ALL ON TABLE "public"."patient_timeline_pins" TO "anon";
GRANT ALL ON TABLE "public"."patient_timeline_pins" TO "authenticated";
GRANT ALL ON TABLE "public"."patient_timeline_pins" TO "service_role";



GRANT ALL ON TABLE "public"."patient_vitals" TO "anon";
GRANT ALL ON TABLE "public"."patient_vitals" TO "authenticated";
GRANT ALL ON TABLE "public"."patient_vitals" TO "service_role";



GRANT ALL ON TABLE "public"."patients" TO "anon";
GRANT ALL ON TABLE "public"."patients" TO "authenticated";
GRANT ALL ON TABLE "public"."patients" TO "service_role";



GRANT ALL ON TABLE "public"."payer_contracts" TO "anon";
GRANT ALL ON TABLE "public"."payer_contracts" TO "authenticated";
GRANT ALL ON TABLE "public"."payer_contracts" TO "service_role";



GRANT ALL ON TABLE "public"."pediatric_growth_records" TO "anon";
GRANT ALL ON TABLE "public"."pediatric_growth_records" TO "authenticated";
GRANT ALL ON TABLE "public"."pediatric_growth_records" TO "service_role";



GRANT ALL ON TABLE "public"."person_clinical_facts" TO "anon";
GRANT ALL ON TABLE "public"."person_clinical_facts" TO "authenticated";
GRANT ALL ON TABLE "public"."person_clinical_facts" TO "service_role";



GRANT ALL ON TABLE "public"."person_consent_events" TO "anon";
GRANT ALL ON TABLE "public"."person_consent_events" TO "authenticated";
GRANT ALL ON TABLE "public"."person_consent_events" TO "service_role";



GRANT ALL ON TABLE "public"."person_consents" TO "anon";
GRANT ALL ON TABLE "public"."person_consents" TO "authenticated";
GRANT ALL ON TABLE "public"."person_consents" TO "service_role";



GRANT ALL ON TABLE "public"."person_contacts" TO "anon";
GRANT ALL ON TABLE "public"."person_contacts" TO "authenticated";
GRANT ALL ON TABLE "public"."person_contacts" TO "service_role";



GRANT ALL ON TABLE "public"."person_identifiers" TO "anon";
GRANT ALL ON TABLE "public"."person_identifiers" TO "authenticated";
GRANT ALL ON TABLE "public"."person_identifiers" TO "service_role";



GRANT ALL ON TABLE "public"."person_relationships" TO "anon";
GRANT ALL ON TABLE "public"."person_relationships" TO "authenticated";
GRANT ALL ON TABLE "public"."person_relationships" TO "service_role";



GRANT ALL ON TABLE "public"."persons" TO "anon";
GRANT ALL ON TABLE "public"."persons" TO "authenticated";
GRANT ALL ON TABLE "public"."persons" TO "service_role";



GRANT ALL ON TABLE "public"."pharmacy_audit_logs" TO "anon";
GRANT ALL ON TABLE "public"."pharmacy_audit_logs" TO "authenticated";
GRANT ALL ON TABLE "public"."pharmacy_audit_logs" TO "service_role";



GRANT ALL ON TABLE "public"."pharmacy_cart_items" TO "anon";
GRANT ALL ON TABLE "public"."pharmacy_cart_items" TO "authenticated";
GRANT ALL ON TABLE "public"."pharmacy_cart_items" TO "service_role";



GRANT ALL ON TABLE "public"."pharmacy_carts" TO "anon";
GRANT ALL ON TABLE "public"."pharmacy_carts" TO "authenticated";
GRANT ALL ON TABLE "public"."pharmacy_carts" TO "service_role";



GRANT ALL ON TABLE "public"."pharmacy_cashier_sessions" TO "anon";
GRANT ALL ON TABLE "public"."pharmacy_cashier_sessions" TO "authenticated";
GRANT ALL ON TABLE "public"."pharmacy_cashier_sessions" TO "service_role";



GRANT ALL ON TABLE "public"."pharmacy_clients" TO "anon";
GRANT ALL ON TABLE "public"."pharmacy_clients" TO "authenticated";
GRANT ALL ON TABLE "public"."pharmacy_clients" TO "service_role";



GRANT ALL ON TABLE "public"."pharmacy_credit_ledger" TO "anon";
GRANT ALL ON TABLE "public"."pharmacy_credit_ledger" TO "authenticated";
GRANT ALL ON TABLE "public"."pharmacy_credit_ledger" TO "service_role";



GRANT ALL ON TABLE "public"."pharmacy_custom_domains" TO "anon";
GRANT ALL ON TABLE "public"."pharmacy_custom_domains" TO "authenticated";
GRANT ALL ON TABLE "public"."pharmacy_custom_domains" TO "service_role";



GRANT ALL ON TABLE "public"."pharmacy_customers" TO "anon";
GRANT ALL ON TABLE "public"."pharmacy_customers" TO "authenticated";
GRANT ALL ON TABLE "public"."pharmacy_customers" TO "service_role";



GRANT ALL ON TABLE "public"."pharmacy_expenses" TO "anon";
GRANT ALL ON TABLE "public"."pharmacy_expenses" TO "authenticated";
GRANT ALL ON TABLE "public"."pharmacy_expenses" TO "service_role";



GRANT ALL ON TABLE "public"."pharmacy_import_sessions" TO "anon";
GRANT ALL ON TABLE "public"."pharmacy_import_sessions" TO "authenticated";
GRANT ALL ON TABLE "public"."pharmacy_import_sessions" TO "service_role";



GRANT ALL ON TABLE "public"."pharmacy_inquiries" TO "anon";
GRANT ALL ON TABLE "public"."pharmacy_inquiries" TO "authenticated";
GRANT ALL ON TABLE "public"."pharmacy_inquiries" TO "service_role";



GRANT ALL ON TABLE "public"."pharmacy_product_batches" TO "anon";
GRANT ALL ON TABLE "public"."pharmacy_product_batches" TO "authenticated";
GRANT ALL ON TABLE "public"."pharmacy_product_batches" TO "service_role";



GRANT ALL ON TABLE "public"."pharmacy_products" TO "anon";
GRANT ALL ON TABLE "public"."pharmacy_products" TO "authenticated";
GRANT ALL ON TABLE "public"."pharmacy_products" TO "service_role";



GRANT ALL ON TABLE "public"."pharmacy_inventory_summary" TO "anon";
GRANT ALL ON TABLE "public"."pharmacy_inventory_summary" TO "authenticated";
GRANT ALL ON TABLE "public"."pharmacy_inventory_summary" TO "service_role";



GRANT ALL ON TABLE "public"."pharmacy_network_inventory" TO "anon";
GRANT ALL ON TABLE "public"."pharmacy_network_inventory" TO "authenticated";
GRANT ALL ON TABLE "public"."pharmacy_network_inventory" TO "service_role";



GRANT ALL ON TABLE "public"."pharmacy_notifications" TO "anon";
GRANT ALL ON TABLE "public"."pharmacy_notifications" TO "authenticated";
GRANT ALL ON TABLE "public"."pharmacy_notifications" TO "service_role";



GRANT ALL ON TABLE "public"."pharmacy_onboarding" TO "anon";
GRANT ALL ON TABLE "public"."pharmacy_onboarding" TO "authenticated";
GRANT ALL ON TABLE "public"."pharmacy_onboarding" TO "service_role";



GRANT ALL ON TABLE "public"."pharmacy_order_items" TO "anon";
GRANT ALL ON TABLE "public"."pharmacy_order_items" TO "authenticated";
GRANT ALL ON TABLE "public"."pharmacy_order_items" TO "service_role";



GRANT ALL ON TABLE "public"."pharmacy_orders" TO "anon";
GRANT ALL ON TABLE "public"."pharmacy_orders" TO "authenticated";
GRANT ALL ON TABLE "public"."pharmacy_orders" TO "service_role";



GRANT ALL ON TABLE "public"."pharmacy_pos_sale_items" TO "anon";
GRANT ALL ON TABLE "public"."pharmacy_pos_sale_items" TO "authenticated";
GRANT ALL ON TABLE "public"."pharmacy_pos_sale_items" TO "service_role";



GRANT ALL ON TABLE "public"."pharmacy_pos_sales" TO "anon";
GRANT ALL ON TABLE "public"."pharmacy_pos_sales" TO "authenticated";
GRANT ALL ON TABLE "public"."pharmacy_pos_sales" TO "service_role";



GRANT ALL ON TABLE "public"."pharmacy_product_packages" TO "anon";
GRANT ALL ON TABLE "public"."pharmacy_product_packages" TO "authenticated";
GRANT ALL ON TABLE "public"."pharmacy_product_packages" TO "service_role";



GRANT ALL ON TABLE "public"."pharmacy_profiles" TO "anon";
GRANT ALL ON TABLE "public"."pharmacy_profiles" TO "authenticated";
GRANT ALL ON TABLE "public"."pharmacy_profiles" TO "service_role";



GRANT ALL ON TABLE "public"."pharmacy_purchase_order_items" TO "anon";
GRANT ALL ON TABLE "public"."pharmacy_purchase_order_items" TO "authenticated";
GRANT ALL ON TABLE "public"."pharmacy_purchase_order_items" TO "service_role";



GRANT ALL ON TABLE "public"."pharmacy_purchase_orders" TO "anon";
GRANT ALL ON TABLE "public"."pharmacy_purchase_orders" TO "authenticated";
GRANT ALL ON TABLE "public"."pharmacy_purchase_orders" TO "service_role";



GRANT ALL ON TABLE "public"."pharmacy_receipt_reprints" TO "anon";
GRANT ALL ON TABLE "public"."pharmacy_receipt_reprints" TO "authenticated";
GRANT ALL ON TABLE "public"."pharmacy_receipt_reprints" TO "service_role";



GRANT ALL ON TABLE "public"."pharmacy_refunds" TO "anon";
GRANT ALL ON TABLE "public"."pharmacy_refunds" TO "authenticated";
GRANT ALL ON TABLE "public"."pharmacy_refunds" TO "service_role";



GRANT ALL ON TABLE "public"."pharmacy_sale_idempotency" TO "anon";
GRANT ALL ON TABLE "public"."pharmacy_sale_idempotency" TO "authenticated";
GRANT ALL ON TABLE "public"."pharmacy_sale_idempotency" TO "service_role";



GRANT ALL ON TABLE "public"."pharmacy_settings" TO "anon";
GRANT ALL ON TABLE "public"."pharmacy_settings" TO "authenticated";
GRANT ALL ON TABLE "public"."pharmacy_settings" TO "service_role";



GRANT ALL ON TABLE "public"."pharmacy_staff_permissions" TO "anon";
GRANT ALL ON TABLE "public"."pharmacy_staff_permissions" TO "authenticated";
GRANT ALL ON TABLE "public"."pharmacy_staff_permissions" TO "service_role";



GRANT ALL ON TABLE "public"."pharmacy_stock_adjustments" TO "anon";
GRANT ALL ON TABLE "public"."pharmacy_stock_adjustments" TO "authenticated";
GRANT ALL ON TABLE "public"."pharmacy_stock_adjustments" TO "service_role";



GRANT ALL ON TABLE "public"."pharmacy_stock_transfer_item_allocations" TO "anon";
GRANT ALL ON TABLE "public"."pharmacy_stock_transfer_item_allocations" TO "authenticated";
GRANT ALL ON TABLE "public"."pharmacy_stock_transfer_item_allocations" TO "service_role";



GRANT ALL ON TABLE "public"."pharmacy_stock_transfer_items" TO "anon";
GRANT ALL ON TABLE "public"."pharmacy_stock_transfer_items" TO "authenticated";
GRANT ALL ON TABLE "public"."pharmacy_stock_transfer_items" TO "service_role";



GRANT ALL ON TABLE "public"."pharmacy_stock_transfers" TO "anon";
GRANT ALL ON TABLE "public"."pharmacy_stock_transfers" TO "authenticated";
GRANT ALL ON TABLE "public"."pharmacy_stock_transfers" TO "service_role";



GRANT ALL ON TABLE "public"."pharmacy_stores" TO "anon";
GRANT ALL ON TABLE "public"."pharmacy_stores" TO "authenticated";
GRANT ALL ON TABLE "public"."pharmacy_stores" TO "service_role";



GRANT ALL ON TABLE "public"."pharmacy_suppliers" TO "anon";
GRANT ALL ON TABLE "public"."pharmacy_suppliers" TO "authenticated";
GRANT ALL ON TABLE "public"."pharmacy_suppliers" TO "service_role";



GRANT ALL ON TABLE "public"."pharmacy_transaction_edits" TO "anon";
GRANT ALL ON TABLE "public"."pharmacy_transaction_edits" TO "authenticated";
GRANT ALL ON TABLE "public"."pharmacy_transaction_edits" TO "service_role";



GRANT ALL ON TABLE "public"."pharmacy_transaction_items" TO "anon";
GRANT ALL ON TABLE "public"."pharmacy_transaction_items" TO "authenticated";
GRANT ALL ON TABLE "public"."pharmacy_transaction_items" TO "service_role";



GRANT ALL ON TABLE "public"."pharmacy_transactions" TO "anon";
GRANT ALL ON TABLE "public"."pharmacy_transactions" TO "authenticated";
GRANT ALL ON TABLE "public"."pharmacy_transactions" TO "service_role";



GRANT ALL ON TABLE "public"."pharmacy_user_settings" TO "anon";
GRANT ALL ON TABLE "public"."pharmacy_user_settings" TO "authenticated";
GRANT ALL ON TABLE "public"."pharmacy_user_settings" TO "service_role";



GRANT ALL ON TABLE "public"."phi_access_log" TO "anon";
GRANT ALL ON TABLE "public"."phi_access_log" TO "authenticated";
GRANT ALL ON TABLE "public"."phi_access_log" TO "service_role";



GRANT ALL ON TABLE "public"."pilot_applications" TO "anon";
GRANT ALL ON TABLE "public"."pilot_applications" TO "authenticated";
GRANT ALL ON TABLE "public"."pilot_applications" TO "service_role";



GRANT ALL ON TABLE "public"."plan_features" TO "anon";
GRANT ALL ON TABLE "public"."plan_features" TO "authenticated";
GRANT ALL ON TABLE "public"."plan_features" TO "service_role";



GRANT ALL ON TABLE "public"."platform_approvals" TO "anon";
GRANT ALL ON TABLE "public"."platform_approvals" TO "authenticated";
GRANT ALL ON TABLE "public"."platform_approvals" TO "service_role";



GRANT ALL ON TABLE "public"."platform_audit_events" TO "anon";
GRANT ALL ON TABLE "public"."platform_audit_events" TO "authenticated";
GRANT ALL ON TABLE "public"."platform_audit_events" TO "service_role";



GRANT ALL ON TABLE "public"."platform_billing_config" TO "anon";
GRANT ALL ON TABLE "public"."platform_billing_config" TO "authenticated";
GRANT ALL ON TABLE "public"."platform_billing_config" TO "service_role";



GRANT ALL ON TABLE "public"."platform_broadcasts" TO "anon";
GRANT ALL ON TABLE "public"."platform_broadcasts" TO "authenticated";
GRANT ALL ON TABLE "public"."platform_broadcasts" TO "service_role";



GRANT ALL ON TABLE "public"."platform_feature_flags" TO "anon";
GRANT ALL ON TABLE "public"."platform_feature_flags" TO "authenticated";
GRANT ALL ON TABLE "public"."platform_feature_flags" TO "service_role";



GRANT ALL ON TABLE "public"."platform_health_checks" TO "authenticated";
GRANT ALL ON TABLE "public"."platform_health_checks" TO "service_role";



GRANT ALL ON TABLE "public"."platform_incidents" TO "authenticated";
GRANT ALL ON TABLE "public"."platform_incidents" TO "service_role";



GRANT ALL ON TABLE "public"."platform_invitations" TO "anon";
GRANT ALL ON TABLE "public"."platform_invitations" TO "authenticated";
GRANT ALL ON TABLE "public"."platform_invitations" TO "service_role";



GRANT ALL ON TABLE "public"."platform_memberships" TO "anon";
GRANT ALL ON TABLE "public"."platform_memberships" TO "authenticated";
GRANT ALL ON TABLE "public"."platform_memberships" TO "service_role";



GRANT ALL ON TABLE "public"."platform_module_matrix" TO "authenticated";
GRANT ALL ON TABLE "public"."platform_module_matrix" TO "service_role";



GRANT ALL ON TABLE "public"."platform_releases" TO "anon";
GRANT ALL ON TABLE "public"."platform_releases" TO "authenticated";
GRANT ALL ON TABLE "public"."platform_releases" TO "service_role";



GRANT ALL ON TABLE "public"."platform_support_sessions" TO "anon";
GRANT ALL ON TABLE "public"."platform_support_sessions" TO "authenticated";
GRANT ALL ON TABLE "public"."platform_support_sessions" TO "service_role";



GRANT ALL ON TABLE "public"."platform_support_tickets" TO "anon";
GRANT ALL ON TABLE "public"."platform_support_tickets" TO "authenticated";
GRANT ALL ON TABLE "public"."platform_support_tickets" TO "service_role";



GRANT ALL ON TABLE "public"."platform_test_runs" TO "anon";
GRANT ALL ON TABLE "public"."platform_test_runs" TO "authenticated";
GRANT ALL ON TABLE "public"."platform_test_runs" TO "service_role";



GRANT ALL ON TABLE "public"."products" TO "anon";
GRANT ALL ON TABLE "public"."products" TO "authenticated";
GRANT ALL ON TABLE "public"."products" TO "service_role";



GRANT ALL ON TABLE "public"."professional_leads" TO "anon";
GRANT ALL ON TABLE "public"."professional_leads" TO "authenticated";
GRANT ALL ON TABLE "public"."professional_leads" TO "service_role";



GRANT ALL ON TABLE "public"."profiles" TO "anon";
GRANT ALL ON TABLE "public"."profiles" TO "authenticated";
GRANT ALL ON TABLE "public"."profiles" TO "service_role";



GRANT ALL ON TABLE "public"."provider_verification_checks" TO "anon";
GRANT ALL ON TABLE "public"."provider_verification_checks" TO "authenticated";
GRANT ALL ON TABLE "public"."provider_verification_checks" TO "service_role";



GRANT ALL ON TABLE "public"."purchase_orders" TO "anon";
GRANT ALL ON TABLE "public"."purchase_orders" TO "authenticated";
GRANT ALL ON TABLE "public"."purchase_orders" TO "service_role";



GRANT ALL ON TABLE "public"."radiology_report_templates" TO "anon";
GRANT ALL ON TABLE "public"."radiology_report_templates" TO "authenticated";
GRANT ALL ON TABLE "public"."radiology_report_templates" TO "service_role";



GRANT ALL ON TABLE "public"."radiology_reports" TO "anon";
GRANT ALL ON TABLE "public"."radiology_reports" TO "authenticated";
GRANT ALL ON TABLE "public"."radiology_reports" TO "service_role";



GRANT ALL ON TABLE "public"."reasoning_actions" TO "anon";
GRANT ALL ON TABLE "public"."reasoning_actions" TO "authenticated";
GRANT ALL ON TABLE "public"."reasoning_actions" TO "service_role";



GRANT ALL ON TABLE "public"."reasoning_audit" TO "anon";
GRANT ALL ON TABLE "public"."reasoning_audit" TO "authenticated";
GRANT ALL ON TABLE "public"."reasoning_audit" TO "service_role";



GRANT ALL ON TABLE "public"."reasoning_context_snapshots" TO "anon";
GRANT ALL ON TABLE "public"."reasoning_context_snapshots" TO "authenticated";
GRANT ALL ON TABLE "public"."reasoning_context_snapshots" TO "service_role";



GRANT ALL ON TABLE "public"."reasoning_evidence" TO "anon";
GRANT ALL ON TABLE "public"."reasoning_evidence" TO "authenticated";
GRANT ALL ON TABLE "public"."reasoning_evidence" TO "service_role";



GRANT ALL ON TABLE "public"."reasoning_evidence_impact" TO "anon";
GRANT ALL ON TABLE "public"."reasoning_evidence_impact" TO "authenticated";
GRANT ALL ON TABLE "public"."reasoning_evidence_impact" TO "service_role";



GRANT ALL ON TABLE "public"."reasoning_hypotheses" TO "anon";
GRANT ALL ON TABLE "public"."reasoning_hypotheses" TO "authenticated";
GRANT ALL ON TABLE "public"."reasoning_hypotheses" TO "service_role";



GRANT ALL ON TABLE "public"."reasoning_sessions" TO "anon";
GRANT ALL ON TABLE "public"."reasoning_sessions" TO "authenticated";
GRANT ALL ON TABLE "public"."reasoning_sessions" TO "service_role";



GRANT ALL ON TABLE "public"."referral_requests" TO "anon";
GRANT ALL ON TABLE "public"."referral_requests" TO "authenticated";
GRANT ALL ON TABLE "public"."referral_requests" TO "service_role";



GRANT ALL ON TABLE "public"."refill_reminders" TO "anon";
GRANT ALL ON TABLE "public"."refill_reminders" TO "authenticated";
GRANT ALL ON TABLE "public"."refill_reminders" TO "service_role";



GRANT ALL ON TABLE "public"."renal_adjustments_catalog" TO "anon";
GRANT ALL ON TABLE "public"."renal_adjustments_catalog" TO "authenticated";
GRANT ALL ON TABLE "public"."renal_adjustments_catalog" TO "service_role";



GRANT ALL ON TABLE "public"."restaurants" TO "anon";
GRANT ALL ON TABLE "public"."restaurants" TO "authenticated";
GRANT ALL ON TABLE "public"."restaurants" TO "service_role";



GRANT ALL ON TABLE "public"."role_capabilities" TO "anon";
GRANT ALL ON TABLE "public"."role_capabilities" TO "authenticated";
GRANT ALL ON TABLE "public"."role_capabilities" TO "service_role";



GRANT ALL ON TABLE "public"."role_hierarchy" TO "anon";
GRANT ALL ON TABLE "public"."role_hierarchy" TO "authenticated";
GRANT ALL ON TABLE "public"."role_hierarchy" TO "service_role";



GRANT ALL ON TABLE "public"."rule_executions" TO "anon";
GRANT ALL ON TABLE "public"."rule_executions" TO "authenticated";
GRANT ALL ON TABLE "public"."rule_executions" TO "service_role";



GRANT ALL ON TABLE "public"."scan_events" TO "anon";
GRANT ALL ON TABLE "public"."scan_events" TO "authenticated";
GRANT ALL ON TABLE "public"."scan_events" TO "service_role";



GRANT ALL ON TABLE "public"."score_calculations" TO "anon";
GRANT ALL ON TABLE "public"."score_calculations" TO "authenticated";
GRANT ALL ON TABLE "public"."score_calculations" TO "service_role";



GRANT ALL ON TABLE "public"."score_definitions" TO "anon";
GRANT ALL ON TABLE "public"."score_definitions" TO "authenticated";
GRANT ALL ON TABLE "public"."score_definitions" TO "service_role";



GRANT ALL ON TABLE "public"."sdg_indicators" TO "anon";
GRANT ALL ON TABLE "public"."sdg_indicators" TO "authenticated";
GRANT ALL ON TABLE "public"."sdg_indicators" TO "service_role";



GRANT ALL ON TABLE "public"."sdg_reports" TO "anon";
GRANT ALL ON TABLE "public"."sdg_reports" TO "authenticated";
GRANT ALL ON TABLE "public"."sdg_reports" TO "service_role";



GRANT ALL ON TABLE "public"."sentinel_alerts" TO "anon";
GRANT ALL ON TABLE "public"."sentinel_alerts" TO "authenticated";
GRANT ALL ON TABLE "public"."sentinel_alerts" TO "service_role";



GRANT ALL ON TABLE "public"."service_catalog" TO "anon";
GRANT ALL ON TABLE "public"."service_catalog" TO "authenticated";
GRANT ALL ON TABLE "public"."service_catalog" TO "service_role";



GRANT ALL ON TABLE "public"."staff_attendance" TO "anon";
GRANT ALL ON TABLE "public"."staff_attendance" TO "authenticated";
GRANT ALL ON TABLE "public"."staff_attendance" TO "service_role";



GRANT ALL ON TABLE "public"."staff_invitations" TO "anon";
GRANT ALL ON TABLE "public"."staff_invitations" TO "authenticated";
GRANT ALL ON TABLE "public"."staff_invitations" TO "service_role";



GRANT ALL ON TABLE "public"."staff_leave_requests" TO "anon";
GRANT ALL ON TABLE "public"."staff_leave_requests" TO "authenticated";
GRANT ALL ON TABLE "public"."staff_leave_requests" TO "service_role";



GRANT ALL ON TABLE "public"."staff_scope_assignments" TO "anon";
GRANT ALL ON TABLE "public"."staff_scope_assignments" TO "authenticated";
GRANT ALL ON TABLE "public"."staff_scope_assignments" TO "service_role";



GRANT ALL ON TABLE "public"."subscription_events" TO "anon";
GRANT ALL ON TABLE "public"."subscription_events" TO "authenticated";
GRANT ALL ON TABLE "public"."subscription_events" TO "service_role";



GRANT ALL ON TABLE "public"."subscription_grants" TO "anon";
GRANT ALL ON TABLE "public"."subscription_grants" TO "authenticated";
GRANT ALL ON TABLE "public"."subscription_grants" TO "service_role";



GRANT ALL ON TABLE "public"."subscription_invoices" TO "anon";
GRANT ALL ON TABLE "public"."subscription_invoices" TO "authenticated";
GRANT ALL ON TABLE "public"."subscription_invoices" TO "service_role";



GRANT ALL ON TABLE "public"."subscription_payments" TO "anon";
GRANT ALL ON TABLE "public"."subscription_payments" TO "authenticated";
GRANT ALL ON TABLE "public"."subscription_payments" TO "service_role";



GRANT ALL ON TABLE "public"."subscription_plans" TO "anon";
GRANT ALL ON TABLE "public"."subscription_plans" TO "authenticated";
GRANT ALL ON TABLE "public"."subscription_plans" TO "service_role";



GRANT ALL ON TABLE "public"."suppliers" TO "anon";
GRANT ALL ON TABLE "public"."suppliers" TO "authenticated";
GRANT ALL ON TABLE "public"."suppliers" TO "service_role";



GRANT ALL ON TABLE "public"."support_ticket_events" TO "anon";
GRANT ALL ON TABLE "public"."support_ticket_events" TO "authenticated";
GRANT ALL ON TABLE "public"."support_ticket_events" TO "service_role";



GRANT ALL ON TABLE "public"."support_tickets" TO "anon";
GRANT ALL ON TABLE "public"."support_tickets" TO "authenticated";
GRANT ALL ON TABLE "public"."support_tickets" TO "service_role";



GRANT ALL ON TABLE "public"."surgery_schedules" TO "anon";
GRANT ALL ON TABLE "public"."surgery_schedules" TO "authenticated";
GRANT ALL ON TABLE "public"."surgery_schedules" TO "service_role";



GRANT ALL ON TABLE "public"."surveillance_reports" TO "anon";
GRANT ALL ON TABLE "public"."surveillance_reports" TO "authenticated";
GRANT ALL ON TABLE "public"."surveillance_reports" TO "service_role";



GRANT ALL ON TABLE "public"."synapse_adapters" TO "authenticated";
GRANT ALL ON TABLE "public"."synapse_adapters" TO "service_role";



GRANT ALL ON TABLE "public"."synapse_domain_events" TO "authenticated";
GRANT ALL ON TABLE "public"."synapse_domain_events" TO "service_role";



GRANT ALL ON TABLE "public"."synapse_sessions" TO "anon";
GRANT ALL ON TABLE "public"."synapse_sessions" TO "authenticated";
GRANT ALL ON TABLE "public"."synapse_sessions" TO "service_role";



GRANT ALL ON TABLE "public"."synapse_simulation_runs" TO "authenticated";
GRANT ALL ON TABLE "public"."synapse_simulation_runs" TO "service_role";



GRANT ALL ON TABLE "public"."sync_conflicts" TO "anon";
GRANT ALL ON TABLE "public"."sync_conflicts" TO "authenticated";
GRANT ALL ON TABLE "public"."sync_conflicts" TO "service_role";



GRANT ALL ON TABLE "public"."sync_idempotency_keys" TO "anon";
GRANT ALL ON TABLE "public"."sync_idempotency_keys" TO "authenticated";
GRANT ALL ON TABLE "public"."sync_idempotency_keys" TO "service_role";



GRANT ALL ON TABLE "public"."tele_sessions" TO "anon";
GRANT ALL ON TABLE "public"."tele_sessions" TO "authenticated";
GRANT ALL ON TABLE "public"."tele_sessions" TO "service_role";



GRANT ALL ON TABLE "public"."telemedicine_appointments" TO "anon";
GRANT ALL ON TABLE "public"."telemedicine_appointments" TO "authenticated";
GRANT ALL ON TABLE "public"."telemedicine_appointments" TO "service_role";



GRANT ALL ON TABLE "public"."telemedicine_followups" TO "anon";
GRANT ALL ON TABLE "public"."telemedicine_followups" TO "authenticated";
GRANT ALL ON TABLE "public"."telemedicine_followups" TO "service_role";



GRANT ALL ON TABLE "public"."telemedicine_frontdesk_queue" TO "anon";
GRANT ALL ON TABLE "public"."telemedicine_frontdesk_queue" TO "authenticated";
GRANT ALL ON TABLE "public"."telemedicine_frontdesk_queue" TO "service_role";



GRANT ALL ON TABLE "public"."telemedicine_intake_cases" TO "anon";
GRANT ALL ON TABLE "public"."telemedicine_intake_cases" TO "authenticated";
GRANT ALL ON TABLE "public"."telemedicine_intake_cases" TO "service_role";



GRANT ALL ON TABLE "public"."telemedicine_intake_messages" TO "anon";
GRANT ALL ON TABLE "public"."telemedicine_intake_messages" TO "authenticated";
GRANT ALL ON TABLE "public"."telemedicine_intake_messages" TO "service_role";



GRANT ALL ON TABLE "public"."telemedicine_providers" TO "anon";
GRANT ALL ON TABLE "public"."telemedicine_providers" TO "authenticated";
GRANT ALL ON TABLE "public"."telemedicine_providers" TO "service_role";



GRANT ALL ON TABLE "public"."telemedicine_session_events" TO "anon";
GRANT ALL ON TABLE "public"."telemedicine_session_events" TO "authenticated";
GRANT ALL ON TABLE "public"."telemedicine_session_events" TO "service_role";



GRANT ALL ON TABLE "public"."telemedicine_staff_alerts" TO "anon";
GRANT ALL ON TABLE "public"."telemedicine_staff_alerts" TO "authenticated";
GRANT ALL ON TABLE "public"."telemedicine_staff_alerts" TO "service_role";



GRANT ALL ON TABLE "public"."telemedicine_voice_memos" TO "anon";
GRANT ALL ON TABLE "public"."telemedicine_voice_memos" TO "authenticated";
GRANT ALL ON TABLE "public"."telemedicine_voice_memos" TO "service_role";



GRANT ALL ON TABLE "public"."tenant_domains" TO "anon";
GRANT ALL ON TABLE "public"."tenant_domains" TO "authenticated";
GRANT ALL ON TABLE "public"."tenant_domains" TO "service_role";



GRANT ALL ON TABLE "public"."tenant_feature_overrides" TO "anon";
GRANT ALL ON TABLE "public"."tenant_feature_overrides" TO "authenticated";
GRANT ALL ON TABLE "public"."tenant_feature_overrides" TO "service_role";



GRANT ALL ON TABLE "public"."tenant_logging_policies" TO "anon";
GRANT ALL ON TABLE "public"."tenant_logging_policies" TO "authenticated";
GRANT ALL ON TABLE "public"."tenant_logging_policies" TO "service_role";



GRANT ALL ON TABLE "public"."tenant_provisioning_jobs" TO "anon";
GRANT ALL ON TABLE "public"."tenant_provisioning_jobs" TO "authenticated";
GRANT ALL ON TABLE "public"."tenant_provisioning_jobs" TO "service_role";



GRANT ALL ON TABLE "public"."tenant_subscriptions" TO "anon";
GRANT ALL ON TABLE "public"."tenant_subscriptions" TO "authenticated";
GRANT ALL ON TABLE "public"."tenant_subscriptions" TO "service_role";



GRANT ALL ON TABLE "public"."tenants" TO "anon";
GRANT ALL ON TABLE "public"."tenants" TO "authenticated";
GRANT ALL ON TABLE "public"."tenants" TO "service_role";



GRANT ALL ON TABLE "public"."ucg_guidelines" TO "anon";
GRANT ALL ON TABLE "public"."ucg_guidelines" TO "authenticated";
GRANT ALL ON TABLE "public"."ucg_guidelines" TO "service_role";



GRANT ALL ON TABLE "public"."verification_documents" TO "anon";
GRANT ALL ON TABLE "public"."verification_documents" TO "authenticated";
GRANT ALL ON TABLE "public"."verification_documents" TO "service_role";



GRANT ALL ON TABLE "public"."visitor_log" TO "anon";
GRANT ALL ON TABLE "public"."visitor_log" TO "authenticated";
GRANT ALL ON TABLE "public"."visitor_log" TO "service_role";



GRANT ALL ON TABLE "public"."vitals" TO "anon";
GRANT ALL ON TABLE "public"."vitals" TO "authenticated";
GRANT ALL ON TABLE "public"."vitals" TO "service_role";



GRANT ALL ON TABLE "public"."wards" TO "anon";
GRANT ALL ON TABLE "public"."wards" TO "authenticated";
GRANT ALL ON TABLE "public"."wards" TO "service_role";



ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON SEQUENCES TO "service_role";






ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON FUNCTIONS TO "service_role";






ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "postgres";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "anon";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "authenticated";
ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public" GRANT ALL ON TABLES TO "service_role";

-- Additive death/mortuary/pathway tables live in
-- supabase/migrations/20260921080000_death_pronouncement_pathways.sql
-- (death_pronouncements, mortuary_bodies, mortuary_storage_slots, patient_care_plans, pathway_overrides).






