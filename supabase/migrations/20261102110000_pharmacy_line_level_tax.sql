-- Line-level VAT persisted on the sale, computed and validated by the server.
--
-- Until now a sale carried one header `tax_amount` and nothing per line, so a
-- receipt, a sales report or a VAT return could not say which line was taxable,
-- at what rate, or which part of the sale was exempt or zero-rated. Worse, the
-- header figure came from the caller: the browser till and the phone each compute
-- tax themselves (`packages/db/src/pos-tax.ts`), and the RPC stored whatever it
-- was handed.
--
-- This migration makes the database the authority:
--
--   * `pharmacy_pos_sale_items` keeps the classification, rate, base and tax for
--     every line, so historical receipts and reports survive a later rate change
--     or a product being reclassified.
--   * `complete_pharmacy_sale` reads `pharmacy_settings` and
--     `pharmacy_products.vat_category` itself, computes each row's tax, stores it,
--     and sets the header from the sum. A caller-supplied `p_tax_amount` that
--     disagrees by more than five cents is refused with `TAX_MISMATCH` rather
--     than persisted.
--   * `pharmacy_settings.vat_rate` is widened from bare `numeric` to
--     `numeric(8,4)`, matching the unit and precision of the legacy `tax_rate`
--     column widened by 20261102100000_pharmacy_settings_tax_rate_precision.sql.
--     The unit stays a PERCENTAGE (18 means 18%).
--
-- Rounding rule, identical in SQL and in packages/db/src/pos-tax.ts: tax is
-- rounded to 2dp PER SALE-ITEM ROW and the header is the sum of the rows. A
-- whole-sale base would leave the header a cent away from the lines that make it
-- up once a line spans two batches.
--
-- History is not rewritten. The new columns are NULL for every sale that already
-- exists; NULL means "this row predates line-level tax", and reports fall back to
-- the sale header for those. Backfilling from the product's current category
-- would invent a classification the sale may never have had.
--
-- Also fixes a live defect in the same function: the insert omitted
-- `discount_reason` and `discount_approved_by`, so any line discount tripped
-- `chk_discount_requires_reason` (20260718183718) at runtime. The snapshot
-- columns added by that migration are now populated too.
--
-- Forward-safe: additive columns with no default churn, CREATE OR REPLACE only.
-- Rollback: re-apply the definition from
-- 20261031120000_pharmacy_sale_allow_negative_stock.sql and drop the columns
-- added here.
--
-- Applying this to a live database is an operator action and was NOT performed
-- by the change that added this file.

-- ── Sale-line tax snapshot ────────────────────────────────────────────────

alter table public.pharmacy_pos_sale_items
  add column if not exists vat_category   text,
  add column if not exists tax_rate       numeric(8,4),
  add column if not exists taxable_amount numeric(12,2),
  add column if not exists tax_amount     numeric(12,2),
  add column if not exists tax_source     text;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'chk_pos_sale_item_vat_category'
      and conrelid = 'public.pharmacy_pos_sale_items'::regclass
  ) then
    alter table public.pharmacy_pos_sale_items
      add constraint chk_pos_sale_item_vat_category
      check (vat_category is null or vat_category in ('standard','exempt','zero_rated'));
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'chk_pos_sale_item_tax_source'
      and conrelid = 'public.pharmacy_pos_sale_items'::regclass
  ) then
    alter table public.pharmacy_pos_sale_items
      add constraint chk_pos_sale_item_tax_source
      check (tax_source is null or tax_source in ('vat','legacy','none'));
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'chk_pos_sale_item_tax_rate'
      and conrelid = 'public.pharmacy_pos_sale_items'::regclass
  ) then
    alter table public.pharmacy_pos_sale_items
      add constraint chk_pos_sale_item_tax_rate
      check (tax_rate is null or (tax_rate >= 0 and tax_rate <= 100));
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'chk_pos_sale_item_tax_amounts'
      and conrelid = 'public.pharmacy_pos_sale_items'::regclass
  ) then
    alter table public.pharmacy_pos_sale_items
      add constraint chk_pos_sale_item_tax_amounts
      check (
        (taxable_amount is null or taxable_amount >= 0)
        and (tax_amount is null or tax_amount >= 0)
      );
  end if;
end $$;

comment on column public.pharmacy_pos_sale_items.vat_category is
  'Product VAT classification at sale time: standard | exempt | zero_rated. NULL = sale predates line-level tax.';
comment on column public.pharmacy_pos_sale_items.tax_rate is
  'Tax rate actually charged on this line, as a PERCENTAGE (18 = 18%).';
comment on column public.pharmacy_pos_sale_items.taxable_amount is
  'The part of this line''s net (after its own discount) the rate applied to.';
comment on column public.pharmacy_pos_sale_items.tax_amount is
  'Tax charged on this line, rounded to 2dp. The sale header is the sum of these.';
comment on column public.pharmacy_pos_sale_items.tax_source is
  'Which setting produced the tax: vat | legacy | none. NULL = predates line-level tax.';

-- ── Sale-header provenance ────────────────────────────────────────────────

alter table public.pharmacy_pos_sales
  add column if not exists tax_source text;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'chk_pos_sale_tax_source'
      and conrelid = 'public.pharmacy_pos_sales'::regclass
  ) then
    alter table public.pharmacy_pos_sales
      add constraint chk_pos_sale_tax_source
      check (tax_source is null or tax_source in ('vat','legacy','none'));
  end if;
end $$;

comment on column public.pharmacy_pos_sales.tax_source is
  'Which setting produced the sale tax: vat | legacy | none. NULL = sale predates it.';

-- ── vat_rate precision ────────────────────────────────────────────────────
-- Bare numeric accepts anything, including a rate of 500 or a value with more
-- decimals than money can honour. Pin it to the same shape as tax_rate.

do $$
declare
  v_typmod integer;
  v_precision integer;
  v_scale integer;
begin
  select a.atttypmod into v_typmod
  from pg_attribute a
  join pg_class c on c.oid = a.attrelid
  join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public'
    and c.relname = 'pharmacy_settings'
    and a.attname = 'vat_rate'
    and a.attnum > 0
    and not a.attisdropped;

  if not found then
    raise exception 'VAT_RATE_MISSING: public.pharmacy_settings.vat_rate does not exist';
  end if;

  if v_typmod = -1 then
    execute 'alter table public.pharmacy_settings alter column vat_rate type numeric(8,4)';
    return;
  end if;

  v_precision := ((v_typmod - 4) >> 16) & 65535;
  v_scale := (v_typmod - 4) & 65535;

  if v_precision >= 8 and v_scale >= 4 then
    return;
  end if;

  execute 'alter table public.pharmacy_settings alter column vat_rate type numeric(8,4)';
end $$;

comment on column public.pharmacy_settings.vat_rate is
  'VAT rate as a PERCENTAGE: 18 means 18%. Used only when vat_enabled is true. Read as base * rate / 100.';

-- ── complete_pharmacy_sale: tax is computed here, not trusted from the caller ─

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
  v_row_discount numeric;
  v_disc_applied boolean;
  v_discount_reason text;
  v_discount_approved_by uuid;
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
  v_vat_enabled boolean := false;
  v_vat_rate numeric;
  v_legacy_rate numeric;
  v_tax_source text := 'none';
  v_tax_rate numeric := 0;
  v_tax_total numeric := 0;
  v_line_category text;
  v_line_taxable numeric;
  v_line_tax numeric;
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

  -- Tax configuration is read once, here. The till's own figure is only a
  -- cross-check: what gets stored is what this function computes.
  select coalesce(s.vat_enabled, false), s.vat_rate, s.tax_rate
  into v_vat_enabled, v_vat_rate, v_legacy_rate
  from public.pharmacy_settings s
  where s.tenant_id = p_tenant_id;

  if v_vat_enabled then
    if v_vat_rate is null or v_vat_rate < 0 or v_vat_rate > 100 then
      raise exception 'INVALID_TAX_CONFIGURATION: VAT is enabled but vat_rate is missing or outside 0-100';
    end if;
    v_tax_source := 'vat';
    v_tax_rate := v_vat_rate;
  elsif v_legacy_rate is not null then
    if v_legacy_rate < 0 or v_legacy_rate > 100 then
      raise exception 'INVALID_TAX_CONFIGURATION: tax_rate is outside 0-100';
    end if;
    if v_legacy_rate <> 0 then
      v_tax_source := 'legacy';
      v_tax_rate := v_legacy_rate;
    end if;
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
    0, 0, 0, 0,
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

    v_discount_reason := nullif(trim(coalesce(v_item->>'discount_reason', '')), '');
    if v_line_discount > 0 and v_discount_reason is null then
      raise exception 'DISCOUNT_REASON_REQUIRED for %', v_product.name;
    end if;
    v_discount_approved_by := nullif(v_item->>'discount_approved_by', '')::uuid;

    -- The classification is the product's, snapshotted at sale time so a later
    -- reclassification cannot rewrite what this sale was.
    v_line_category := coalesce(nullif(v_product.vat_category, ''), 'exempt');
    if v_line_category not in ('standard', 'exempt', 'zero_rated') then
      v_line_category := 'exempt';
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

      v_row_discount := case when not v_disc_applied then v_line_discount else 0 end;
      v_line_taxable := case
        when v_tax_source = 'legacy' then v_take * v_unit_price - v_row_discount
        when v_tax_source = 'vat' and v_line_category = 'standard' then v_take * v_unit_price - v_row_discount
        else 0
      end;
      v_line_tax := round(v_line_taxable * v_tax_rate / 100, 2);

      insert into pharmacy_pos_sale_items (
        id, sale_id, tenant_id, product_id, batch_id, quantity, unit_price,
        list_price, discount_amount, discount_reason, discount_approved_by,
        batch_number_snapshot, batch_expiry_snapshot,
        vat_category, tax_rate, taxable_amount, tax_amount, tax_source,
        stock_decremented
      ) values (
        gen_random_uuid(), v_sale_id, p_tenant_id, v_product.id, v_batch.id,
        v_take, v_unit_price,
        v_batch_price, v_row_discount, v_discount_reason, v_discount_approved_by,
        v_batch.batch_number, v_batch.expiry_date,
        v_line_category, v_tax_rate, v_line_taxable, v_line_tax, v_tax_source,
        true
      );

      v_tax_total := v_tax_total + v_line_tax;
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

      v_row_discount := case when not v_disc_applied then v_line_discount else 0 end;
      v_line_taxable := case
        when v_tax_source = 'legacy' then v_qty_needed * v_unit_price - v_row_discount
        when v_tax_source = 'vat' and v_line_category = 'standard' then v_qty_needed * v_unit_price - v_row_discount
        else 0
      end;
      v_line_tax := round(v_line_taxable * v_tax_rate / 100, 2);

      insert into pharmacy_pos_sale_items (
        id, sale_id, tenant_id, product_id, batch_id, quantity, unit_price,
        list_price, discount_amount, discount_reason, discount_approved_by,
        batch_number_snapshot, batch_expiry_snapshot,
        vat_category, tax_rate, taxable_amount, tax_amount, tax_source,
        stock_decremented
      ) values (
        gen_random_uuid(), v_sale_id, p_tenant_id, v_product.id, v_neg_batch_id,
        v_qty_needed, v_unit_price,
        v_unit_price, v_row_discount, v_discount_reason, v_discount_approved_by,
        'NEG-STOCK', '2099-12-31'::date,
        v_line_category, v_tax_rate, v_line_taxable, v_line_tax, v_tax_source,
        true
      );

      v_tax_total := v_tax_total + v_line_tax;
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

  -- The caller's figure is a cross-check, never the record. Zero means the
  -- caller did not compute tax at all (hospital dispense passes 0 and prices
  -- from the catalogue), and a zero claim cannot lower what is stored — the
  -- server figure is what lands in the row either way. Any other figure must
  -- agree; five cents absorbs the rounding a batch split can add.
  if coalesce(p_tax_amount, 0) > 0
     and abs(coalesce(p_tax_amount, 0) - v_tax_total) > 0.05 then
    raise exception 'TAX_MISMATCH: caller supplied %, server computed %', coalesce(p_tax_amount, 0), v_tax_total;
  end if;

  v_discount := coalesce(p_discount_total, 0) + v_item_discounts;
  v_total := v_subtotal - v_discount + v_tax_total;
  if v_total < 0 then
    raise exception 'NEGATIVE_TOTAL: discount exceeds subtotal';
  end if;

  update pharmacy_pos_sales
  set subtotal = v_subtotal,
      discount_total = v_discount,
      tax_amount = v_tax_total,
      tax_source = v_tax_source,
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
    'tax_amount', v_tax_total,
    'tax_source', v_tax_source,
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
