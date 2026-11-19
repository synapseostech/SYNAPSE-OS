-- 20261119090000_pharmacy_tally_void_mirrors
--
-- A Tally rollback reversed stock and journals but left the reporting mirrors
-- (pharmacy_transactions / pharmacy_purchases rows noted "Imported from
-- Tally"). Reports kept counting a rolled-back import's sales, and a re-import
-- found the same numbers already there and kept the old rows — with whatever
-- cost of goods the first import wrote — instead of writing fresh ones.
--
-- pharmacy_tally_void_mirrors() marks one import's mirrors as rolled back:
--   - status becomes CANCELLED (reports count COMPLETED sales and exclude
--     cancelled purchases), so nothing is deleted;
--   - the document number gets a "~ROLLBACK-<session>" suffix, which frees the
--     original number for a re-import to write a fresh mirror under;
--   - the note keeps its "Imported from Tally" prefix, so the rows stay
--     read-only afterwards.
--
-- Only rows naming the session in their note, or legacy rows written before
-- notes named a session, are touched. Calling it again changes nothing: a
-- voided row no longer carries its original number.
--
-- The read-only guard allows these updates only while this function has set
-- the transaction-local flag synapse.tally_mirror_void; every other update or
-- delete of a mirror is still refused.
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
  -- The one sanctioned change: a rollback voiding its own mirrors.
  if tg_op = 'UPDATE' and current_setting('synapse.tally_mirror_void', true) = 'on' then
    return new;
  end if;

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

create or replace function public.pharmacy_tally_void_mirrors(
  p_tenant_id uuid,
  p_session_id uuid,
  p_transaction_nos text[],
  p_purchase_nos text[]
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_suffix text := '~ROLLBACK-' || left(p_session_id::text, 8);
  v_stamp text := ' · rolled back ' || to_char(now() at time zone 'Africa/Kampala', 'YYYY-MM-DD');
  v_session_tag text := '· session ' || p_session_id::text;
  v_sales integer := 0;
  v_purchases integer := 0;
begin
  if p_tenant_id is null or p_session_id is null then
    raise exception 'TALLY_VOID_MIRRORS_ARGUMENT_MISSING' using errcode = '22023';
  end if;

  perform set_config('synapse.tally_mirror_void', 'on', true);

  update public.pharmacy_transactions t
     set status = 'CANCELLED',
         transaction_no = t.transaction_no || v_suffix,
         notes = t.notes || v_stamp
   where t.tenant_id = p_tenant_id
     and t.transaction_no = any (coalesce(p_transaction_nos, '{}'))
     and left(coalesce(t.notes, ''), 19) = 'Imported from Tally'
     and (position(v_session_tag in t.notes) > 0 or position('· session ' in t.notes) = 0);
  get diagnostics v_sales = row_count;

  update public.pharmacy_purchases p
     set status = 'CANCELLED',
         purchase_no = p.purchase_no || v_suffix,
         notes = p.notes || v_stamp
   where p.tenant_id = p_tenant_id
     and p.purchase_no = any (coalesce(p_purchase_nos, '{}'))
     and left(coalesce(p.notes, ''), 19) = 'Imported from Tally'
     and (position(v_session_tag in p.notes) > 0 or position('· session ' in p.notes) = 0);
  get diagnostics v_purchases = row_count;

  perform set_config('synapse.tally_mirror_void', 'off', true);

  return jsonb_build_object('salesVoided', v_sales, 'purchasesVoided', v_purchases);
end;
$$;

revoke all on function public.pharmacy_tally_void_mirrors(uuid, uuid, text[], text[]) from public, anon, authenticated;
grant execute on function public.pharmacy_tally_void_mirrors(uuid, uuid, text[], text[]) to service_role;

commit;
