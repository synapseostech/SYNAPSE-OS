-- PR-007: reversing a POS sale must also reverse the customer's receivable.
--
-- `reverse_pharmacy_sale` reported `pharmacy_pos_sales.total_amount` as the
-- refund and stopped there. For a sale bought on credit — or partly paid — the
-- customer had not handed over that money: the unpaid part sits in
-- pharmacy_credit_ledger and is chased by the credit ledger, ageing and
-- customer statement screens. Voiding the sale left the invoice voided but the
-- debt standing, and returned the till the full total as cash out.
--
-- The sale row does record what was actually paid. complete-sale encodes
-- `PAID:<amount>|BAL:<amount>|M:<method>` into pharmacy_pos_sales.payment_ref,
-- and post_pharmacy_pos_sale_to_ledger already parses the same tag to decide
-- the cash and receivables legs of the accounting journal. This file makes the
-- refund use that same parse so the three records agree:
--
--   cash refunded      = what the customer paid
--   receivable         = the credited part of the same sale, reversed in full
--   sale total         = cash refunded + receivable reversed
--
-- Reversing the receivable in full — not just what is still outstanding —
-- is what keeps the customer's net position correct when they had already
-- repaid part of it before the return: the repaid money becomes a negative
-- (store-credit) balance the pharmacy owes them, instead of vanishing.
--
-- The reversal is a ledger row of type 'refund', written in the same
-- transaction as the void and keyed `pos-refund:<sale_id>`, so a retry can
-- never post it twice. It is not routed through post_pharmacy_credit_entry:
-- that function exists for operator-entered credit and repayments, and its
-- overpayment guard would reject a reversal.
--
-- Behaviour change: `refund_amount` in the returned jsonb is now the cash to
-- hand back. For a fully paid sale it is unchanged (the sale total). For a
-- credit sale it is 0, which is also what the till should record. The
-- receivable side is reported as `receivable_reversal`, and a sale whose
-- balance was never posted to the ledger reports `receivable_unposted: true`
-- with `receivable_outstanding` instead of silently refunding cash that was
-- never received. Any unpaid part the ledger could not reverse — because it
-- was never posted, or because the posted credit is smaller than the sale's
-- balance — is reported as `receivable_unreversed` so it is not lost. A sale
-- that does not exist raises SALE_NOT_FOUND, distinct from PRODUCT_NOT_FOUND
-- for a line whose product row is gone: only the former means the caller may
-- look the id up in the older transaction table.
--
-- Forward-safe: CREATE OR REPLACE with the same signature and return keys plus
-- new ones. No table rewrite; the type check is widened, not replaced with
-- narrower values. Rollback: re-apply reverse_pharmacy_sale from
-- supabase/migrations/20261101090000_pharmacy_refund_and_adjust_rpcs.sql and
-- restore the ('credit', 'repayment') check.
--
-- Not applied here. This is a review artefact for a migration run the owner
-- schedules.

-- =============================================================================
-- The credit ledger needs a movement that is neither a credit nor a repayment
-- =============================================================================
-- Drop by name first: a replay over a database that already ran this file
-- leaves the widened check under this name, and the add below would then fail
-- on the duplicate rather than replace it.
alter table public.pharmacy_credit_ledger
  drop constraint if exists pharmacy_credit_ledger_type_check;

do $$
declare
  c record;
begin
  -- The original check was declared inline and so carries an auto-generated
  -- name. Match on the definition rather than guess the name.
  for c in
    select conname
    from pg_constraint
    where conrelid = 'public.pharmacy_credit_ledger'::regclass
      and contype = 'c'
      and pg_get_constraintdef(oid) ilike '%repayment%'
  loop
    execute format('alter table public.pharmacy_credit_ledger drop constraint %I', c.conname);
  end loop;
end;
$$;

alter table public.pharmacy_credit_ledger
  add constraint pharmacy_credit_ledger_type_check
  check (type in ('credit', 'repayment', 'refund'));

comment on constraint pharmacy_credit_ledger_type_check on public.pharmacy_credit_ledger is
  'credit increases the receivable, repayment and refund reduce it.';

-- =============================================================================
-- reverse_pharmacy_sale — same signature, receivable-aware
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
    -- Distinct from a missing product line below: the caller resolves a missing
    -- sale against the older transaction table, and must not do that when the
    -- sale exists but one of its lines lost its product row.
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

  -- What the void leaves standing. The reversal is capped at both what the
  -- ledger actually holds and the sale's unpaid part, so a ledger that posted
  -- less than the sale's balance leaves debt attached to a voided invoice. The
  -- operator sees the amount instead of discovering it in the ageing report.
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
$function$;

comment on function public.reverse_pharmacy_sale(uuid,uuid,uuid,text,text) is
  'Voids a completed POS sale, restores its stock at most once per line, hands back the cash the customer paid, and reverses the sale''s receivable in the credit ledger.';

-- =============================================================================
-- Least privilege — re-asserted, because a replaced function's grants are not
-- guaranteed to stay as they were
-- =============================================================================
revoke all on function public.reverse_pharmacy_sale(uuid, uuid, uuid, text, text) from public;
revoke all on function public.reverse_pharmacy_sale(uuid, uuid, uuid, text, text) from anon;
revoke all on function public.reverse_pharmacy_sale(uuid, uuid, uuid, text, text) from authenticated;
grant execute on function public.reverse_pharmacy_sale(uuid, uuid, uuid, text, text) to service_role;
