-- 20261103103000_tally_ledger_accounts_rpc
--
-- The Tally cut-over seeds the chart of accounts, then adds the client's own
-- ledgers so the opening journal and every voucher can post against them.
-- `apps/pharmacy/lib/tally/apply.ts` did that second step with a direct
-- `.insert()` on `pharmacy_accounting_accounts`.
--
-- That cannot work. `20261022160000_pharmacy_accounting_ledger.sql` locks the
-- whole accounting surface down (lines 969-971):
--
--   revoke all on public.pharmacy_accounting_accounts
--     from public, anon, authenticated, service_role;
--   grant select on public.pharmacy_accounting_accounts to service_role;
--
-- Writes are meant to go through security-definer functions, as
-- `seed_pharmacy_accounting_accounts` and `post_pharmacy_accounting_journal`
-- do. A service-role insert is refused with
-- `permission denied for table pharmacy_accounting_accounts`, so the cut-over
-- died in its first stage — before it posted anything.
--
-- This function is the missing writer. It is the only way an imported ledger
-- enters the table, so the table itself stays closed to direct writes.
--
-- The caller cannot mint a system account: `system_key` is always null and
-- `is_system` always false. A Tally code that collides with a seeded account
-- is skipped by the `(tenant_id, code)` conflict clause, which is what the
-- importer already relied on.
--
-- PREPARED, not applied to any environment by the change that added this file.

begin;

create or replace function public.add_pharmacy_accounting_accounts(
  p_tenant_id uuid,
  p_accounts jsonb
)
returns integer
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_inserted integer := 0;
begin
  if p_tenant_id is null or not exists (select 1 from public.tenants where id = p_tenant_id) then
    raise exception 'ACCOUNTING_TENANT_NOT_FOUND';
  end if;

  if p_accounts is null or jsonb_typeof(p_accounts) <> 'array' then
    raise exception 'ACCOUNTING_ACCOUNTS_INVALID';
  end if;

  with incoming as (
    select
      entry->>'code'           as code,
      entry->>'name'           as name,
      entry->>'account_type'   as account_type,
      entry->>'normal_balance' as normal_balance
    from jsonb_array_elements(p_accounts) as entry
  ),
  inserted as (
    insert into public.pharmacy_accounting_accounts
      (tenant_id, code, name, account_type, normal_balance, system_key, is_system)
    select p_tenant_id, code, name, account_type, normal_balance, null, false
    from incoming
    on conflict (tenant_id, code) do nothing
    returning 1
  )
  select count(*) into v_inserted from inserted;

  return v_inserted;
end;
$function$;

revoke all on function public.add_pharmacy_accounting_accounts(uuid, jsonb)
  from public, anon, authenticated;
grant execute on function public.add_pharmacy_accounting_accounts(uuid, jsonb)
  to service_role;

commit;
