-- 20261104120000_pharmacy_tenant_purge
--
-- One-shot, admin-triggered reset of a single pharmacy tenant's data.
--
-- The portal's Tally cut-over is one-shot: a completed `pharmacy_import_sessions`
-- row locks the upload page (apps/pharmacy/lib/tally/cutover.ts, findCompletedCutover)
-- and nothing in the app can clear it. Re-running an import therefore needs the
-- tenant's previous data gone.
--
-- Three guard families refuse deletes by design, and this function is the only
-- sanctioned way through them:
--   * reject_pharmacy_accounting_mutation      (journal entries/lines, unconditional)
--   * tally_mirror_rows_are_read_only          (Tally-mirrored sales/purchases/items)
--   * guard_pos_sale_mutation + _item_mutation (completed/voided POS sales)
-- ALTER TABLE ... DISABLE TRIGGER is transactional, so a failure rolls back both
-- the deletes and the trigger state. Nothing is disabled for other statements,
-- and the triggers are re-enabled before this function returns.
--
-- What survives: the tenants row, staff logins (pharmacy_profiles, user_settings,
-- staff_permissions), stores, custom domains, onboarding, billing and the
-- append-only platform audit trail.
--
-- PREPARED, not applied to any environment by the change that added this file.

begin;

create or replace function public.purge_pharmacy_tenant_data(
  p_tenant_id uuid,
  p_actor_id uuid,
  p_dry_run boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_facility text;
  v_counts jsonb := '{}'::jsonb;
  v_total bigint := 0;
  v_pair text[];
  v_table text;
  v_where text;
  v_n bigint;
  -- Delete order, children before parents. Each row is {table, WHERE predicate};
  -- `$1` is the tenant id. A table without tenant_id is reached through its parent.
  v_targets constant text[][] := array[
    array['pharmacy_stock_transfer_item_allocations',
          'transfer_item_id in (select i.id from public.pharmacy_stock_transfer_items i join public.pharmacy_stock_transfers t on t.id = i.transfer_id where t.tenant_id = $1)'],
    array['pharmacy_stock_transfer_items',
          'transfer_id in (select id from public.pharmacy_stock_transfers where tenant_id = $1)'],
    array['pharmacy_stock_transfers', 'tenant_id = $1'],
    array['pharmacy_till_cash_events', 'tenant_id = $1'],
    array['pharmacy_refunds', 'tenant_id = $1'],
    array['pharmacy_receipt_reprints', 'tenant_id = $1'],
    array['pharmacy_pos_sale_items', 'tenant_id = $1'],
    array['pharmacy_pos_sales', 'tenant_id = $1'],
    array['pharmacy_cart_items', 'tenant_id = $1'],
    array['pharmacy_carts', 'tenant_id = $1'],
    array['pharmacy_cashier_sessions', 'tenant_id = $1'],
    array['pharmacy_bank_statement_lines', 'tenant_id = $1'],
    array['pharmacy_bank_statement_imports', 'tenant_id = $1'],
    array['pharmacy_accounting_journal_lines', 'tenant_id = $1'],
    array['pharmacy_accounting_journal_entries', 'tenant_id = $1'],
    array['pharmacy_accounting_periods', 'tenant_id = $1'],
    array['pharmacy_accounting_accounts', 'tenant_id = $1'],
    -- The document archive (20261104130000) references import sessions with
    -- ON DELETE RESTRICT, so its rows have to go before the sessions they
    -- name or the reset fails on the first archived document.
    array['pharmacy_tally_document_lines', 'tenant_id = $1'],
    array['pharmacy_tally_documents', 'tenant_id = $1'],
    array['pharmacy_tally_document_imports', 'tenant_id = $1'],
    array['pharmacy_tally_cutover_locks', 'tenant_id = $1'],
    array['pharmacy_import_sessions', 'tenant_id = $1'],
    array['pharmacy_purchase_idempotency', 'tenant_id = $1'],
    array['pharmacy_purchase_attachments', 'tenant_id = $1'],
    array['pharmacy_supplier_returns', 'tenant_id = $1'],
    array['pharmacy_purchase_items',
          'purchase_id in (select id from public.pharmacy_purchases where tenant_id = $1)'],
    array['pharmacy_purchases', 'tenant_id = $1'],
    array['pharmacy_purchase_order_items',
          'purchase_order_id in (select id from public.pharmacy_purchase_orders where tenant_id = $1)'],
    array['pharmacy_purchase_orders', 'tenant_id = $1'],
    array['pharmacy_order_items', 'tenant_id = $1'],
    array['pharmacy_orders', 'tenant_id = $1'],
    array['pharmacy_transaction_edits', 'tenant_id = $1'],
    array['pharmacy_transaction_items',
          'transaction_id in (select id from public.pharmacy_transactions where tenant_id = $1)'],
    -- credit_ledger.transaction_id is NO ACTION, so it has to go before the
    -- transactions it points at.
    array['pharmacy_credit_ledger', 'tenant_id = $1'],
    array['pharmacy_transactions', 'tenant_id = $1'],
    array['refill_reminders', 'tenant_id = $1'],
    array['pharmacy_customers', 'tenant_id = $1'],
    array['pharmacy_clients', 'tenant_id = $1'],
    array['pharmacy_stock_adjustments', 'tenant_id = $1'],
    array['pharmacy_product_packages',
          'product_id in (select id from public.pharmacy_products where tenant_id = $1)'],
    array['pharmacy_product_batches',
          'product_id in (select id from public.pharmacy_products where tenant_id = $1)'],
    array['pharmacy_products', 'tenant_id = $1'],
    -- trg_sync_network_inventory re-upserts OLD product rows on delete, so the
    -- mirror has to be cleared after the products that feed it.
    array['pharmacy_network_inventory', 'pharmacy_tenant_id = $1'],
    array['pharmacy_suppliers', 'tenant_id = $1'],
    array['pharmacy_expenses', 'tenant_id = $1'],
    array['pharmacy_notifications', 'tenant_id = $1'],
    array['pharmacy_inquiries', 'tenant_id = $1'],
    array['pharmacy_sale_idempotency', 'tenant_id = $1'],
    array['pharmacy_settings', 'tenant_id = $1'],
    -- A prescription row belongs to the prescribing tenant and names the
    -- dispensing pharmacy in pharmacy_tenant_id; only the latter is this reset's.
    array['clinical_prescriptions', 'pharmacy_tenant_id = $1'],
    array['offline_mutation_outbox', 'tenant_id = $1'],
    array['synapse_domain_events', 'tenant_id = $1'],
    -- Last, so the audit row written below survives the reset.
    array['pharmacy_audit_logs', 'tenant_id = $1']
  ];
begin
  select t.facility_type
  into v_facility
  from public.tenants t
  where t.id = p_tenant_id;

  if v_facility is null then
    raise exception 'PHARMACY_PURGE_TENANT_NOT_FOUND: %', p_tenant_id
      using errcode = 'P0002';
  end if;
  if v_facility <> 'pharmacy' then
    raise exception 'PHARMACY_PURGE_NOT_PHARMACY: tenant % is a % tenant',
      p_tenant_id, v_facility
      using errcode = '42501';
  end if;

  if not p_dry_run then
    alter table public.pharmacy_accounting_journal_entries
      disable trigger pharmacy_accounting_journal_entries_immutable;
    alter table public.pharmacy_accounting_journal_lines
      disable trigger pharmacy_accounting_journal_lines_immutable;
    alter table public.pharmacy_transactions
      disable trigger trg_tally_mirror_read_only_transactions;
    alter table public.pharmacy_purchases
      disable trigger trg_tally_mirror_read_only_purchases;
    alter table public.pharmacy_transaction_items
      disable trigger trg_tally_mirror_read_only_transaction_items;
    alter table public.pharmacy_purchase_items
      disable trigger trg_tally_mirror_read_only_purchase_items;
    alter table public.pharmacy_pos_sales
      disable trigger trg_guard_pos_sale_mutation;
    alter table public.pharmacy_pos_sale_items
      disable trigger trg_guard_pos_sale_item_mutation;
  end if;

  foreach v_pair slice 1 in array v_targets loop
    v_table := v_pair[1];
    v_where := v_pair[2];

    -- A table this function knows about may not exist yet, because the archive
    -- migration is separate and its order is not guaranteed once the two are
    -- applied out of sequence. Skipping an absent table is the same answer as
    -- an empty one; failing the whole reset is not.
    if to_regclass(format('public.%I', v_table)) is null then
      continue;
    end if;

    if p_dry_run then
      execute format('select count(*) from public.%I where %s', v_table, v_where)
        into v_n
        using p_tenant_id;
    else
      execute format('delete from public.%I where %s', v_table, v_where)
        using p_tenant_id;
      get diagnostics v_n = row_count;
    end if;

    v_total := v_total + v_n;
    v_counts := v_counts || jsonb_build_object(v_table, v_n);
  end loop;

  if not p_dry_run then
    alter table public.pharmacy_accounting_journal_entries
      enable trigger pharmacy_accounting_journal_entries_immutable;
    alter table public.pharmacy_accounting_journal_lines
      enable trigger pharmacy_accounting_journal_lines_immutable;
    alter table public.pharmacy_transactions
      enable trigger trg_tally_mirror_read_only_transactions;
    alter table public.pharmacy_purchases
      enable trigger trg_tally_mirror_read_only_purchases;
    alter table public.pharmacy_transaction_items
      enable trigger trg_tally_mirror_read_only_transaction_items;
    alter table public.pharmacy_purchase_items
      enable trigger trg_tally_mirror_read_only_purchase_items;
    alter table public.pharmacy_pos_sales
      enable trigger trg_guard_pos_sale_mutation;
    alter table public.pharmacy_pos_sale_items
      enable trigger trg_guard_pos_sale_item_mutation;

    insert into public.pharmacy_audit_logs
      (tenant_id, profile_id, action, entity, entity_id, details)
    values
      (p_tenant_id, p_actor_id, 'PHARMACY_DATA_RESET', 'PHARMACY_TENANT',
       p_tenant_id::text, v_counts::text);
  end if;

  return jsonb_build_object(
    'dryRun', p_dry_run,
    'tenantId', p_tenant_id,
    'totalRows', v_total,
    'counts', v_counts
  );
end;
$function$;

comment on function public.purge_pharmacy_tenant_data(uuid, uuid, boolean) is
  'Erases all data of one pharmacy tenant, keeping staff and the tenant row. '
  'p_dry_run=true returns per-table counts without deleting.';

revoke all on function public.purge_pharmacy_tenant_data(uuid, uuid, boolean)
  from public, anon, authenticated;
grant execute on function public.purge_pharmacy_tenant_data(uuid, uuid, boolean)
  to service_role;

commit;
