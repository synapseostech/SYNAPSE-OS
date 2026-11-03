-- Pharmacy refund and stock-adjustment RPCs — restore, correct and harden.
--
-- `reverse_pharmacy_sale` and `adjust_pharmacy_batch_stock` are called by
-- packages/db/src/inventory-rpc.ts, but no migration in supabase/migrations
-- creates them. They reached production out of band, and
-- 20260810093707_pharmacy_pilot_authority_hardening.sql records only a
-- `to_regprocedure(...) is not null` check. The canonical snapshot
-- (supabase/bootstrap/canonical_public_schema.sql, line 287 and line 2398) does
-- carry both bodies, so a snapshot-built database works; the migration chain
-- alone does not reproduce them. This file makes the chain self-sufficient and
-- corrects four defects that the snapshot and the quarantined copy share:
--
--   1. The refund amount was sum(unit_price * quantity). It ignored per-line
--      and sale-level discounts and the tax that complete_pharmacy_sale adds.
--      A discounted sale refunded more money than the customer paid; a taxed
--      sale refunded less. The amount is what /api/admin/refunds hands to the
--      till for cash reconciliation, so it must equal the sale's recorded
--      total_amount.
--   2. Neither function validated the acting profile or its tenancy. Both are
--      SECURITY DEFINER and granted only to service_role, so a caller holding
--      that key could void another tenant's sale by passing its ids, or write a
--      stock adjustment with an actor from a different pharmacy.
--   3. A refund restored pharmacy_products.quantity even when the sold batch
--      row no longer existed, silently making product and batch totals
--      disagree. It now fails closed with BATCH_NOT_FOUND, before committing.
--   4. DECREASE and CORRECTION wrote no pharmacy_audit_logs row, so manual
--      stock changes were attributable only through pharmacy_stock_adjustments.
--   5. The actor check accepted a deactivated pharmacist. It passed on
--      profiles.tenant_id alone, never consulting pharmacy_user_settings.is_active,
--      so the flag the portal and mobile auth enforce could be bypassed by a
--      direct service_role call.
--   6. CORRECTION applied its delta with no floor, so correcting a batch whose
--      product total was already short stored a negative pharmacy_products
--      quantity (the column has no CHECK). It now raises STOCK_DRIFT rather
--      than clamping, which would hide the drift.
--   7. The refund tried to clear stock_decremented on completed sale lines,
--      which the append-only trigger correctly rejects. Sale-row locking and
--      the completed -> voided transition already provide exactly-once safety.
--   8. Refunds locked batches before products, opposite the sale and adjustment
--      RPCs; they now use product-then-batch order. FEFO decreases now record
--      each affected batch, and refunds cannot reactivate recalled/damaged or
--      expired stock.
--
-- Forward-safe: CREATE OR REPLACE with unchanged signatures and return keys, so
-- grants and the TypeScript callers are untouched. No table rewrite.
-- Rollback: re-apply the two definitions from
-- supabase/bootstrap/canonical_public_schema.sql.
--
-- Risks recorded in docs/pharmacy/PRODUCTION_READINESS_PROGRESS.md:
--   * A sale whose batch row has been deleted can no longer be refunded. That
--     is deliberate (the alternative is a silent stock desync); the operator
--     must restore the batch or correct stock explicitly.
--   * Passing an unsupported p_restore_as now raises INVALID_QUANTITY instead
--     of silently coercing to 'quarantined'.
--   * DECREASE no longer floors pharmacy_products.quantity at zero: it refuses
--     a decrease larger than the recorded product quantity rather than
--     decrementing batches and clamping the product total.

create or replace function public.pharmacy_assert_actor(
  p_tenant_id uuid,
  p_actor_id uuid
) returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
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

comment on function public.pharmacy_assert_actor(uuid, uuid) is
  'Rejects a privileged pharmacy RPC call whose actor is not a member of the tenant.';

-- =============================================================================
-- adjust_pharmacy_batch_stock — unchanged signature
-- =============================================================================
create or replace function public.adjust_pharmacy_batch_stock(
  p_tenant_id uuid,
  p_product_id uuid,
  p_quantity integer,
  p_type text,
  p_reason text,
  p_actor_id uuid,
  p_batch_id uuid default null,
  p_batch_number text default null,
  p_expiry_date date default null,
  p_cost_price numeric default null,
  p_restore_as text default 'active'
)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
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
$function$;

comment on function public.adjust_pharmacy_batch_stock(uuid,uuid,integer,text,text,uuid,uuid,text,date,numeric,text) is
  'Batch-aware stock adjustment (INCREASE via receive semantics; DECREASE, CORRECTION, DAMAGE, QUARANTINE, RECALL). Audits every branch and refuses to desync product and batch totals.';

-- =============================================================================
-- reverse_pharmacy_sale — never delete the sale; restore conservatively
-- =============================================================================
create or replace function public.reverse_pharmacy_sale(
  p_tenant_id uuid,
  p_sale_id uuid,
  p_actor_id uuid,
  p_reason text,
  p_restore_as text default 'quarantined'
)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_sale pharmacy_pos_sales%rowtype;
  v_item record;
  v_restore text := lower(coalesce(nullif(trim(p_restore_as), ''), 'quarantined'));
  v_refund_amount numeric := 0;
  v_batch pharmacy_product_batches%rowtype;
  v_prev int;
  v_new int;
  v_kla_today date := (timezone('Africa/Kampala', now()))::date;
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
    raise exception 'PRODUCT_NOT_FOUND: sale %', p_sale_id;
  end if;
  if v_sale.status = 'voided' then
    raise exception 'ALREADY_REFUNDED: sale % already voided', v_sale.receipt_number;
  end if;
  if v_sale.status is distinct from 'completed' then
    raise exception 'SALE_NOT_REFUNDABLE: status=%', v_sale.status;
  end if;

  -- What the customer actually paid: subtotal - discounts + tax.
  v_refund_amount := coalesce(v_sale.total_amount, 0);

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
    format('Voided %s amount %s restore_as=%s reason=%s', v_sale.receipt_number, v_refund_amount, v_restore, p_reason)
  );

  return jsonb_build_object(
    'ok', true,
    'sale_id', p_sale_id,
    'receipt_number', v_sale.receipt_number,
    'refund_amount', v_refund_amount,
    'restore_as', v_restore,
    'status', 'voided'
  );
end;
$function$;

comment on function public.reverse_pharmacy_sale(uuid,uuid,uuid,text,text) is
  'Voids a completed POS sale, restores its stock at most once per line, and reports the sale total as the refund amount.';

-- =============================================================================
-- Least privilege — privileged pharmacy RPCs are service_role only
-- =============================================================================
do $$
declare
  r record;
begin
  for r in
    select p.oid::regprocedure as sig
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in (
        'adjust_pharmacy_batch_stock',
        'reverse_pharmacy_sale',
        'pharmacy_assert_actor'
      )
  loop
    execute format('revoke all on function %s from public', r.sig);
    execute format('revoke all on function %s from anon', r.sig);
    execute format('revoke all on function %s from authenticated', r.sig);
    execute format('grant execute on function %s to service_role', r.sig);
  end loop;
end $$;
