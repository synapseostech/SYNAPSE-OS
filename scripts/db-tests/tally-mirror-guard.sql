-- Behavioural check for supabase/migrations/20261102130300_tally_mirror_read_only_guard.sql
--
-- Run against a DISPOSABLE database with every migration applied, as the
-- database superuser (the fixture setup changes session_replication_role):
--
--   psql "$DISPOSABLE_DB_URL" -v ON_ERROR_STOP=1 -f scripts/db-tests/tally-mirror-guard.sql
--
-- Everything runs in one transaction that ends in rollback, so no fixture row
-- survives and no cleanup is needed afterwards. Each assertion raises with a
-- numbered message when it fails; ON_ERROR_STOP aborts the script. A silent run
-- means every assertion held.
--
-- Executed 2026-11-03 as superuser on the local Supabase stack (postgres
-- 17.6.1.104, bootstrapped from the canonical snapshot), with the guard's own
-- DDL taken from its migration file and created inside the same transaction as
-- these fixtures: all eight assertions held, then rollback removed the
-- trigger, the function and every row. Not executed against acceptance or
-- production.

begin;

-- Fixtures skip the accounting, stock and audit triggers that other migrations
-- put on these tables. The behaviour under test is UPDATE and DELETE only, so
-- the inserts should not have to satisfy those workflows.
set local session_replication_role = replica;

create temp table tally_guard_ids (name text primary key, id uuid) on commit drop;

with inserted as (
  insert into public.tenants (slug, name, status)
  values ('tally-guard-' || substr(gen_random_uuid()::text, 1, 8), 'Tally guard test', 'active')
  returning id
)
insert into tally_guard_ids select 'tenant', id from inserted;

with inserted as (
  insert into public.profiles (id, tenant_id, full_name, role)
  values (gen_random_uuid(), (select id from tally_guard_ids where name = 'tenant'), 'Tally guard test', 'pharmacist')
  returning id
)
insert into tally_guard_ids select 'profile', id from inserted;

with inserted as (
  insert into public.pharmacy_products (tenant_id, name, sku, price, cost_price, quantity)
  values (
    (select id from tally_guard_ids where name = 'tenant'),
    'Guard test item',
    'GUARD-' || substr(gen_random_uuid()::text, 1, 8),
    100, 50, 10
  )
  returning id
)
insert into tally_guard_ids select 'product', id from inserted;

with inserted as (
  insert into public.pharmacy_suppliers (tenant_id, name)
  values ((select id from tally_guard_ids where name = 'tenant'), 'Guard test supplier')
  returning id
)
insert into tally_guard_ids select 'supplier', id from inserted;

with inserted as (
  insert into public.pharmacy_transactions
    (tenant_id, transaction_no, cashier_id, total_amount, net_amount, payment_method, status, notes)
  values (
    (select id from tally_guard_ids where name = 'tenant'),
    'GUARD-MIRROR',
    (select id from tally_guard_ids where name = 'profile'),
    100, 100, 'CASH', 'COMPLETED',
    'Imported from Tally (Guard test) — read-only'
  )
  returning id
)
insert into tally_guard_ids select 'mirror_sale', id from inserted;

with inserted as (
  insert into public.pharmacy_transaction_items
    (tenant_id, transaction_id, product_id, quantity, unit_price, total_price)
  values (
    (select id from tally_guard_ids where name = 'tenant'),
    (select id from tally_guard_ids where name = 'mirror_sale'),
    (select id from tally_guard_ids where name = 'product'),
    1, 100, 100
  )
  returning id
)
insert into tally_guard_ids select 'mirror_sale_item', id from inserted;

with inserted as (
  insert into public.pharmacy_transactions
    (tenant_id, transaction_no, cashier_id, total_amount, net_amount, payment_method, status)
  values (
    (select id from tally_guard_ids where name = 'tenant'),
    'GUARD-PLAIN',
    (select id from tally_guard_ids where name = 'profile'),
    100, 100, 'CASH', 'COMPLETED'
  )
  returning id
)
insert into tally_guard_ids select 'plain_sale', id from inserted;

with inserted as (
  insert into public.pharmacy_transaction_items
    (tenant_id, transaction_id, product_id, quantity, unit_price, total_price)
  values (
    (select id from tally_guard_ids where name = 'tenant'),
    (select id from tally_guard_ids where name = 'plain_sale'),
    (select id from tally_guard_ids where name = 'product'),
    1, 100, 100
  )
  returning id
)
insert into tally_guard_ids select 'plain_sale_item', id from inserted;

with inserted as (
  insert into public.pharmacy_purchases
    (tenant_id, purchase_no, supplier_id, total, status, notes)
  values (
    (select id from tally_guard_ids where name = 'tenant'),
    'GUARD-MIRROR-P',
    (select id from tally_guard_ids where name = 'supplier'),
    100, 'DRAFT',
    'Imported from Tally (Guard test) — read-only'
  )
  returning id
)
insert into tally_guard_ids select 'mirror_purchase', id from inserted;

with inserted as (
  insert into public.pharmacy_purchase_items
    (tenant_id, purchase_id, product_id, product_name, quantity, unit_cost, line_total)
  values (
    (select id from tally_guard_ids where name = 'tenant'),
    (select id from tally_guard_ids where name = 'mirror_purchase'),
    (select id from tally_guard_ids where name = 'product'),
    'Guard test item', 1, 100, 100
  )
  returning id
)
insert into tally_guard_ids select 'mirror_purchase_item', id from inserted;

set local session_replication_role = origin;

do $$
declare
  v_tenant        uuid := (select id from tally_guard_ids where name = 'tenant');
  v_mirror_sale   uuid := (select id from tally_guard_ids where name = 'mirror_sale');
  v_mirror_item   uuid := (select id from tally_guard_ids where name = 'mirror_sale_item');
  v_plain_sale    uuid := (select id from tally_guard_ids where name = 'plain_sale');
  v_mirror_purch  uuid := (select id from tally_guard_ids where name = 'mirror_purchase');
  v_blocked       boolean;
  v_count         integer;
begin
  -- 1. A mirror sale cannot be deleted.
  v_blocked := false;
  begin
    delete from public.pharmacy_transactions where id = v_mirror_sale;
  exception when insufficient_privilege then
    v_blocked := true;
  end;
  if not v_blocked then
    raise exception 'ASSERTION 1 FAILED: a Tally mirror sale was deleted';
  end if;

  -- 2. A mirror sale's line cannot be deleted directly.
  v_blocked := false;
  begin
    delete from public.pharmacy_transaction_items where id = v_mirror_item;
  exception when insufficient_privilege then
    v_blocked := true;
  end;
  if not v_blocked then
    raise exception 'ASSERTION 2 FAILED: a line of a Tally mirror sale was deleted directly';
  end if;

  -- 3. A mirror sale cannot be updated.
  v_blocked := false;
  begin
    update public.pharmacy_transactions set net_amount = 1 where id = v_mirror_sale;
  exception when insufficient_privilege then
    v_blocked := true;
  end;
  if not v_blocked then
    raise exception 'ASSERTION 3 FAILED: a Tally mirror sale was updated';
  end if;

  -- 4. A mirror purchase cannot be deleted or updated.
  v_blocked := false;
  begin
    delete from public.pharmacy_purchases where id = v_mirror_purch;
  exception when insufficient_privilege then
    v_blocked := true;
  end;
  if not v_blocked then
    raise exception 'ASSERTION 4 FAILED: a Tally mirror purchase was deleted';
  end if;

  v_blocked := false;
  begin
    update public.pharmacy_purchases set notes = 'changed' where id = v_mirror_purch;
  exception when insufficient_privilege then
    v_blocked := true;
  end;
  if not v_blocked then
    raise exception 'ASSERTION 5 FAILED: a Tally mirror purchase was updated';
  end if;

  -- 6. An ordinary sale is untouched by the guard: update and delete succeed,
  --    and its lines go with it.
  update public.pharmacy_transactions set net_amount = 100 where id = v_plain_sale;
  delete from public.pharmacy_transactions where id = v_plain_sale;

  select count(*) into v_count
  from public.pharmacy_transaction_items
  where transaction_id = v_plain_sale;
  if v_count <> 0 then
    raise exception 'ASSERTION 6 FAILED: a plain sale''s lines survived its delete (% left)', v_count;
  end if;

  -- 7. A tenant teardown still cascades through the guard.
  delete from public.tenants where id = v_tenant;

  select count(*) into v_count
  from public.pharmacy_transactions where tenant_id = v_tenant;
  if v_count <> 0 then
    raise exception 'ASSERTION 7 FAILED: % sale row(s) survived the tenant delete', v_count;
  end if;

  select count(*) into v_count
  from public.pharmacy_purchases where tenant_id = v_tenant;
  if v_count <> 0 then
    raise exception 'ASSERTION 8 FAILED: % purchase row(s) survived the tenant delete', v_count;
  end if;

  raise notice 'tally mirror guard: all assertions held';
end
$$;

rollback;
