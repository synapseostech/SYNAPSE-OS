-- 20261102130300_tally_mirror_read_only_guard
--
-- Sales and purchases mirrored from Tally are reporting history: their ledger
-- entry came from the Tally voucher, and `apps/pharmacy/lib/tally/apply.ts`
-- stamps the note `Imported from Tally (<company>) — read-only`. The portal
-- refuses to edit them, and the bulk reset handler that deleted every
-- transaction has been removed. Neither stops a direct statement from a
-- service-role script: `delete from pharmacy_transactions` still erased them.
--
-- This guard makes the marker enforceable. It is a row trigger because RLS
-- does not apply to the service role, and revoking DELETE would break the
-- deletes the portal does need.
--
-- The prefix is 19 characters (lib/tally/types.ts TALLY_MIRROR_NOTE_PREFIX);
-- the note continues with the company name, so equality or a bare LIKE would
-- miss every row.
--
-- PREPARED, not applied to any environment by the change that added this file.

begin;

create or replace function public.tally_mirror_rows_are_read_only()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_is_mirror boolean := false;
begin
  if tg_table_name = 'pharmacy_transactions' then
    v_is_mirror := left(coalesce(old.notes, ''), 19) = 'Imported from Tally';
  elsif tg_table_name = 'pharmacy_purchases' then
    v_is_mirror := left(coalesce(old.notes, ''), 19) = 'Imported from Tally';
  elsif tg_table_name = 'pharmacy_transaction_items' then
    v_is_mirror := exists (
      select 1
      from public.pharmacy_transactions t
      where t.id = old.transaction_id
        and left(coalesce(t.notes, ''), 19) = 'Imported from Tally'
    );
  elsif tg_table_name = 'pharmacy_purchase_items' then
    v_is_mirror := exists (
      select 1
      from public.pharmacy_purchases p
      where p.id = old.purchase_id
        and left(coalesce(p.notes, ''), 19) = 'Imported from Tally'
    );
  end if;

  if not v_is_mirror then
    if tg_op = 'UPDATE' then
      return new;
    end if;
    return old;
  end if;

  -- A tenant teardown deletes the tenants row first and lets the FK cascade
  -- remove the rest. Blocking that would make an imported tenant impossible to
  -- remove. The check runs before the cascade can reach any of these tables.
  if tg_op = 'DELETE'
     and not exists (select 1 from public.tenants t where t.id = old.tenant_id) then
    return old;
  end if;

  raise exception
    'TALLY_MIRROR_READ_ONLY: % rows imported from Tally cannot be %',
    tg_table_name, lower(tg_op)
    using errcode = '42501';
end;
$$;

drop trigger if exists trg_tally_mirror_read_only_transactions on public.pharmacy_transactions;
create trigger trg_tally_mirror_read_only_transactions
  before update or delete on public.pharmacy_transactions
  for each row execute function public.tally_mirror_rows_are_read_only();

drop trigger if exists trg_tally_mirror_read_only_purchases on public.pharmacy_purchases;
create trigger trg_tally_mirror_read_only_purchases
  before update or delete on public.pharmacy_purchases
  for each row execute function public.tally_mirror_rows_are_read_only();

drop trigger if exists trg_tally_mirror_read_only_transaction_items on public.pharmacy_transaction_items;
create trigger trg_tally_mirror_read_only_transaction_items
  before update or delete on public.pharmacy_transaction_items
  for each row execute function public.tally_mirror_rows_are_read_only();

drop trigger if exists trg_tally_mirror_read_only_purchase_items on public.pharmacy_purchase_items;
create trigger trg_tally_mirror_read_only_purchase_items
  before update or delete on public.pharmacy_purchase_items
  for each row execute function public.tally_mirror_rows_are_read_only();

commit;
