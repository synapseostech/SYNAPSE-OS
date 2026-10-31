-- Store each batch's retail price and use it as the POS source of truth.
-- Existing batches inherit the current catalog price so deployed inventory keeps
-- its existing sale price until an operator assigns a batch-specific price.

alter table public.pharmacy_product_batches
  add column if not exists selling_price numeric(14, 2);

update public.pharmacy_product_batches b
set selling_price = p.price
from public.pharmacy_products p
where p.id = b.product_id
  and b.selling_price is null;

-- Receiving stock updates the batch price, not the shared catalog sale price.
create or replace function public.receive_pharmacy_stock(
  p_tenant_id uuid,
  p_product_id uuid,
  p_batch_number text,
  p_quantity integer,
  p_expiry_date date,
  p_cost_price numeric default null,
  p_received_by uuid default null,
  p_supplier_ref text default null,
  p_selling_price numeric default null,
  p_supplier_id uuid default null,
  p_purchase_order_id uuid default null,
  p_store_id uuid default null,
  p_reason text default null
) returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
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
  if p_selling_price is not null and p_selling_price < 0 then
    raise exception 'INVALID_PRICE: selling price cannot be negative';
  end if;

  select * into v_product
  from pharmacy_products
  where id = p_product_id and tenant_id = p_tenant_id
  for update;
  if not found then
    raise exception 'PRODUCT_NOT_FOUND: %', p_product_id;
  end if;

  if p_supplier_id is not null and not exists (
    select 1 from pharmacy_suppliers where id = p_supplier_id and tenant_id = p_tenant_id
  ) then
    raise exception 'SUPPLIER_NOT_FOUND: %', p_supplier_id;
  end if;
  if p_purchase_order_id is not null and not exists (
    select 1 from pharmacy_purchase_orders where id = p_purchase_order_id and tenant_id = p_tenant_id
  ) then
    raise exception 'PURCHASE_ORDER_NOT_FOUND: %', p_purchase_order_id;
  end if;
  if p_store_id is not null and not exists (
    select 1 from pharmacy_stores where id = p_store_id and tenant_id = p_tenant_id
  ) then
    raise exception 'STORE_NOT_FOUND: %', p_store_id;
  end if;

  select id into v_batch_id
  from pharmacy_product_batches
  where tenant_id = p_tenant_id
    and product_id = p_product_id
    and batch_number = trim(p_batch_number)
    and expiry_date is not distinct from p_expiry_date
    and coalesce(status, 'active') in ('active', 'exhausted')
  limit 1
  for update;

  if v_batch_id is not null then
    update pharmacy_product_batches
    set quantity = quantity + p_quantity,
        status = 'active',
        is_active = true,
        cost_price = coalesce(p_cost_price, cost_price),
        selling_price = coalesce(p_selling_price, selling_price, v_product.price),
        updated_at = now()
    where id = v_batch_id;
  else
    insert into pharmacy_product_batches (
      id, tenant_id, product_id, batch_number, quantity, initial_quantity,
      expiry_date, received_date, cost_price, selling_price, is_active, status
    ) values (
      gen_random_uuid(), p_tenant_id, p_product_id, trim(p_batch_number),
      p_quantity, p_quantity, p_expiry_date, v_kla_today,
      coalesce(p_cost_price, v_product.cost_price, 0),
      coalesce(p_selling_price, v_product.price),
      true, 'active'
    )
    returning id into v_batch_id;
  end if;

  update pharmacy_products
  set quantity = coalesce(quantity, 0) + p_quantity,
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
$function$;

-- POS items are split by batch by the API route. The RPC locks that exact batch
-- and checks its current price before decrementing stock.
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
    if nullif(v_item->>'batch_id', '') is null then
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
        and id = (v_item->>'batch_id')::uuid
        and is_active
        and coalesce(status, 'active') = 'active'
        and quantity > 0
        and (expiry_date is null or expiry_date >= v_kla_today)
        and batch_number <> 'NEG-STOCK'
      for update
    loop
      v_batch_price := coalesce(v_batch.selling_price, v_product.price);
      if v_unit_price is distinct from v_batch_price then
        raise exception 'BATCH_PRICE_CHANGED: refresh the cart and retry';
      end if;
      if v_line_discount > v_batch_price * v_qty_needed then
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

    if v_qty_needed > 0 then
      raise exception 'INSUFFICIENT_STOCK: % short by % units', v_product.name, v_qty_needed;
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
