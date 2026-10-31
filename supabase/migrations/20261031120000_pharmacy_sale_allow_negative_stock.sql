-- Allow an opted-in POS line to oversell into a NEG-STOCK overdraft batch.
--
-- Restores the overdraft path removed by
-- 20261002130000_pharmacy_sale_deny_negative_stock.sql, on top of the
-- batch-priced 12-argument definition from
-- 20261030140000_pharmacy_batch_selling_price.sql (same signature, so grants
-- and callers are unchanged).
--
-- A line opts in with "allow_overdraft": true. Every other caller keeps the
-- previous behaviour, so hospital dispense and any direct RPC caller still get
-- INSUFFICIENT_STOCK. An overdraft line may also omit batch_id, in which case
-- FEFO runs across all sellable batches and only the shortfall goes negative.
--
-- Forward-safe: CREATE OR REPLACE only, no table rewrite. Rollback: re-apply
-- the complete_pharmacy_sale definition from
-- 20261030140000_pharmacy_batch_selling_price.sql.

create or replace function public.complete_pharmacy_sale(
  p_tenant_id uuid,
  p_cashier_id uuid,
  p_items jsonb,
  p_payment_method text,
  p_session_id uuid default null,
  p_cart_id uuid default null,
  p_payment_ref text default null,
  p_discount_total numeric default 0,
  p_tax_amount numeric default 0,
  p_patient_id uuid default null,
  p_confirmed_by uuid default null,
  p_idempotency_key text default null
) returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_sale_id uuid := gen_random_uuid();
  v_item jsonb;
  v_product pharmacy_products%rowtype;
  v_batch pharmacy_product_batches%rowtype;
  v_qty_needed int;
  v_taken int;
  v_take int;
  v_unit_price numeric;
  v_batch_price numeric;
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
  v_allow_overdraft boolean;
  v_named_batch boolean;
  v_neg_batch_id uuid;
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

  insert into pharmacy_pos_sales (
    id, tenant_id, session_id, cart_id, cashier_id, patient_id, receipt_number,
    subtotal, discount_total, tax_amount, total_amount,
    payment_method, payment_ref, status, confirmed_by, confirmed_at
  ) values (
    v_sale_id, p_tenant_id, p_session_id, p_cart_id, p_cashier_id, p_patient_id, v_receipt,
    0, 0, coalesce(p_tax_amount, 0), 0,
    p_payment_method, p_payment_ref, 'pending', null, null
  );

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

    v_allow_overdraft := coalesce((v_item->>'allow_overdraft')::boolean, false);
    v_named_batch := nullif(v_item->>'batch_id', '') is not null;
    if not v_named_batch and not v_allow_overdraft then
      raise exception 'BATCH_ALLOCATION_REQUIRED: sale lines must identify their priced batch';
    end if;

    v_qty_needed := (v_item->>'quantity')::int;
    if v_qty_needed is null or v_qty_needed <= 0 then
      raise exception 'INVALID_QUANTITY for %', v_product.name;
    end if;

    v_unit_price := (v_item->>'unit_price')::numeric;
    if v_unit_price is null or v_unit_price < 0 then
      raise exception 'INVALID_PRICE for %', v_product.name;
    end if;
    v_line_discount := coalesce((v_item->>'discount_amount')::numeric, 0);
    if v_line_discount < 0 then
      raise exception 'INVALID_DISCOUNT for %', v_product.name;
    end if;
    v_disc_applied := false;
    v_taken := 0;

    for v_batch in
      select * from pharmacy_product_batches
      where product_id = v_product.id
        and tenant_id = p_tenant_id
        and (id = (v_item->>'batch_id')::uuid or (v_allow_overdraft and not v_named_batch))
        and is_active
        and coalesce(status, 'active') = 'active'
        and quantity > 0
        and (expiry_date is null or expiry_date >= v_kla_today)
        and batch_number <> 'NEG-STOCK'
      order by expiry_date asc nulls last, received_date asc
      for update
    loop
      v_batch_price := coalesce(v_batch.selling_price, v_product.price);
      -- A named batch must still match the price the cart charged. A FEFO line
      -- is priced once by the caller and may span batches at different prices.
      if v_named_batch and v_unit_price is distinct from v_batch_price then
        raise exception 'BATCH_PRICE_CHANGED: refresh the cart and retry';
      end if;
      if v_line_discount > v_unit_price * v_qty_needed then
        raise exception 'INVALID_DISCOUNT: discount exceeds the priced batch line';
      end if;

      v_take := least(v_batch.quantity, v_qty_needed);
      update pharmacy_product_batches
      set quantity = quantity - v_take, updated_at = now()
      where id = v_batch.id;

      insert into pharmacy_pos_sale_items (
        id, sale_id, tenant_id, product_id, batch_id, quantity, unit_price,
        discount_amount, stock_decremented
      ) values (
        gen_random_uuid(), v_sale_id, p_tenant_id, v_product.id, v_batch.id,
        v_take, v_unit_price,
        case when not v_disc_applied then v_line_discount else 0 end,
        true
      );

      v_subtotal := v_subtotal + (v_take * v_unit_price);
      if not v_disc_applied then
        v_item_discounts := v_item_discounts + v_line_discount;
        v_disc_applied := true;
      end if;
      v_qty_needed := v_qty_needed - v_take;
      v_taken := v_taken + v_take;
    end loop;

    -- Opted-in lines carry the shortfall into the product's NEG-STOCK
    -- overdraft batch, so book stock goes negative instead of the sale failing.
    if v_qty_needed > 0 then
      if not v_allow_overdraft then
        raise exception 'INSUFFICIENT_STOCK: % short by % units', v_product.name, v_qty_needed;
      end if;

      select id into v_neg_batch_id
      from pharmacy_product_batches
      where tenant_id = p_tenant_id
        and product_id = v_product.id
        and batch_number = 'NEG-STOCK'
      limit 1
      for update;

      if v_neg_batch_id is null then
        insert into pharmacy_product_batches (
          id, tenant_id, product_id, batch_number, quantity, initial_quantity,
          expiry_date, received_date, cost_price, selling_price, is_active, status
        ) values (
          gen_random_uuid(), p_tenant_id, v_product.id, 'NEG-STOCK', 0, 0,
          '2099-12-31'::date, v_kla_today, coalesce(v_product.cost_price, 0),
          v_unit_price, true, 'active'
        ) returning id into v_neg_batch_id;
      end if;

      update pharmacy_product_batches
      set quantity = coalesce(quantity, 0) - v_qty_needed, updated_at = now()
      where id = v_neg_batch_id;

      insert into pharmacy_pos_sale_items (
        id, sale_id, tenant_id, product_id, batch_id, quantity, unit_price,
        discount_amount, stock_decremented
      ) values (
        gen_random_uuid(), v_sale_id, p_tenant_id, v_product.id, v_neg_batch_id,
        v_qty_needed, v_unit_price,
        case when not v_disc_applied then v_line_discount else 0 end,
        true
      );

      v_subtotal := v_subtotal + (v_qty_needed * v_unit_price);
      if not v_disc_applied then
        v_item_discounts := v_item_discounts + v_line_discount;
        v_disc_applied := true;
      end if;
      v_taken := v_taken + v_qty_needed;
    end if;

    update pharmacy_products
    set quantity = coalesce(quantity, 0) - v_taken, updated_at = now()
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
$function$;
