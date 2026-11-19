#!/usr/bin/env bash
# Feature-contract test for supabase/migrations/20261118120000_pharmacy_stock_take.sql
# on a disposable PostgreSQL 16 (Docker, or local binaries when Docker cannot
# fetch the image). It builds only the pharmacy tables the
# migration touches (not the full chain), applies the migration, and checks the
# posting rules, the guards and tenant isolation.
#
# Run: bash scripts/db-tests/pharmacy-stock-take.isolated.sh
set -euo pipefail
cd "$(dirname "$0")/../.."
name="synapse-stock-take-test-$$"
export PGHOST=127.0.0.1 PGUSER=postgres PGDATABASE=postgres
export PGPASSWORD="$(openssl rand -hex 24)"
datadir=""
cleanup() {
  docker rm -f "$name" >/dev/null 2>&1 || true
  if [ -n "$datadir" ]; then
    "$pgbin/pg_ctl" -D "$datadir" -m immediate stop >/dev/null 2>&1 || true
    rm -rf "$datadir"
  fi
}
trap cleanup EXIT

# A disposable container when Docker can fetch the image; otherwise a throwaway
# cluster from locally installed PostgreSQL binaries.
if docker run --name "$name" --label synapse.disposable-test=true -d \
    -e POSTGRES_PASSWORD="$PGPASSWORD" -p 127.0.0.1::5432 postgres:16-alpine >/dev/null 2>&1; then
  export PGPORT="$(docker port "$name" 5432/tcp | awk -F: '{print $NF}')"
else
  pgbin="$(ls -d /usr/lib/postgresql/*/bin 2>/dev/null | sort -V | tail -1)"
  [ -x "$pgbin/initdb" ] || { echo "Neither Docker nor local PostgreSQL binaries are available" >&2; exit 1; }
  datadir="$(mktemp -d)"
  pwfile="$datadir.pw"; printf '%s' "$PGPASSWORD" > "$pwfile"
  "$pgbin/initdb" -D "$datadir/data" -U postgres --pwfile="$pwfile" -A scram-sha-256 >/dev/null
  rm -f "$pwfile"
  datadir="$datadir/data"
  export PGPORT="$(python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1])')"
  "$pgbin/pg_ctl" -D "$datadir" -o "-p $PGPORT -k $datadir -c listen_addresses=127.0.0.1" -l "$datadir/log" -w start >/dev/null
fi
for attempt in {1..30}; do
  if pg_isready -h "$PGHOST" -p "$PGPORT" -U "$PGUSER" >/dev/null 2>&1; then break; fi
  sleep 1
done

psql -X -q -v ON_ERROR_STOP=1 <<'SQL'
create role anon nologin;
create role authenticated nologin;
create role service_role nologin bypassrls;
grant usage on schema public to anon, authenticated, service_role;

create function public.update_updated_at_column() returns trigger language plpgsql as
$$ begin new.updated_at = now(); return new; end $$;

-- Stand-ins for the tenancy helpers from 20261102130000.
create function public.pharmacy_caller_tenants() returns uuid[] language sql stable as
$$ select coalesce(array[nullif(current_setting('test.tenant', true), '')::uuid], array[]::uuid[]) $$;
create function public.is_platform_admin() returns boolean language sql stable as $$ select false $$;
grant execute on function public.pharmacy_caller_tenants() to authenticated;
grant execute on function public.is_platform_admin() to authenticated;

create table public.profiles (id uuid primary key, tenant_id uuid, full_name text);
create table public.pharmacy_user_settings (
  profile_id uuid, tenant_id uuid, is_active boolean default true,
  primary key (tenant_id, profile_id)
);
create table public.pharmacy_products (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  name text not null,
  category text not null default 'General',
  sku text not null default '',
  barcode text,
  price numeric(14,2) not null default 0,
  cost_price numeric(14,2) not null default 0,
  quantity integer not null default 0,
  unit_of_measure text not null default 'Tablet',
  is_active boolean default true,
  updated_at timestamptz default now()
);
create table public.pharmacy_product_batches (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  product_id uuid not null references public.pharmacy_products(id),
  batch_number text not null,
  quantity integer not null,
  initial_quantity integer not null,
  expiry_date date not null,
  received_date timestamptz default now(),
  cost_price numeric(14,2) not null,
  is_active boolean default true,
  notes text,
  status text not null default 'active',
  updated_at timestamptz default now()
);
create table public.pharmacy_stock_adjustments (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  product_id uuid not null,
  quantity integer not null,
  type text not null check (type in ('INCREASE','DECREASE','CORRECTION','PHYSICAL')),
  reason text,
  previous_qty integer not null,
  new_qty integer not null,
  created_by uuid,
  created_at timestamptz default now(),
  batch_id uuid,
  approved_by uuid
);
create table public.pharmacy_audit_logs (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null, profile_id uuid not null, action text not null,
  entity text not null, entity_id text, details text, created_at timestamptz default now()
);
SQL

# pharmacy_assert_actor exactly as the migration chain defines it.
awk '/^create or replace function public.pharmacy_assert_actor\(/,/^\$function\$;/' \
  supabase/migrations/20261101090000_pharmacy_refund_and_adjust_rpcs.sql \
  | psql -X -q -v ON_ERROR_STOP=1

psql -X -q -v ON_ERROR_STOP=1 -f supabase/migrations/20261118120000_pharmacy_stock_take.sql

psql -X -q -v ON_ERROR_STOP=1 <<'SQL'
\set ON_ERROR_STOP on
-- Fixtures -------------------------------------------------------------------
insert into profiles values
  ('00000000-0000-0000-0000-00000000aa01', '00000000-0000-0000-0000-0000000000a1', 'Manager A'),
  ('00000000-0000-0000-0000-00000000aa02', '00000000-0000-0000-0000-0000000000a1', 'Counter A'),
  ('00000000-0000-0000-0000-00000000bb01', '00000000-0000-0000-0000-0000000000b1', 'Manager B');
insert into pharmacy_user_settings (profile_id, tenant_id) values
  ('00000000-0000-0000-0000-00000000aa01', '00000000-0000-0000-0000-0000000000a1'),
  ('00000000-0000-0000-0000-00000000aa02', '00000000-0000-0000-0000-0000000000a1'),
  ('00000000-0000-0000-0000-00000000bb01', '00000000-0000-0000-0000-0000000000b1');

-- tenant A = ...a1. Products:
--  P1 Tally negative: book -5 with a NEG-STOCK batch of -5; counted 10 with no batch.
--  P2 two batches 10 (exp 2027) + 20 (exp 2028); B1 counted 8 + 2 by two people,
--     B2 not counted, 15 counted without a batch -> B2 keeps 15.
--  P3 counted exactly: no stock change.
--  P4 drifted book 5 vs batch 3; counted 3 -> product total aligned.
--  P5 batch E1 counted 4, manager recount 6; a new batch found on the shelf.
--  P6 in scope but not counted: untouched.
insert into pharmacy_products (id, tenant_id, name, quantity, cost_price) values
  ('00000000-0000-0000-0000-0000000000f1', '00000000-0000-0000-0000-0000000000a1', 'P1 negative', -5, 100),
  ('00000000-0000-0000-0000-0000000000f2', '00000000-0000-0000-0000-0000000000a1', 'P2 two batches', 30, 50),
  ('00000000-0000-0000-0000-0000000000f3', '00000000-0000-0000-0000-0000000000a1', 'P3 exact', 12, 10),
  ('00000000-0000-0000-0000-0000000000f4', '00000000-0000-0000-0000-0000000000a1', 'P4 drift', 5, 20),
  ('00000000-0000-0000-0000-0000000000f5', '00000000-0000-0000-0000-0000000000a1', 'P5 recount', 4, 30),
  ('00000000-0000-0000-0000-0000000000f6', '00000000-0000-0000-0000-0000000000a1', 'P6 uncounted', -2, 30),
  ('00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-0000000000b1', 'Tenant B item', 9, 10);
insert into pharmacy_product_batches (id, tenant_id, product_id, batch_number, quantity, initial_quantity, expiry_date, cost_price) values
  ('00000000-0000-0000-0000-0000000001a1', '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000f1', 'NEG-STOCK', -5, 0, '2099-12-31', 100),
  ('00000000-0000-0000-0000-0000000002b1', '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000f2', 'B1', 10, 10, '2027-06-30', 50),
  ('00000000-0000-0000-0000-0000000002b2', '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000f2', 'B2', 20, 20, '2028-06-30', 60),
  ('00000000-0000-0000-0000-0000000003c1', '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000f3', 'C1', 12, 12, '2028-01-31', 10),
  ('00000000-0000-0000-0000-0000000004d1', '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000f4', 'D1', 3, 3, '2028-01-31', 20),
  ('00000000-0000-0000-0000-0000000005e1', '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000f5', 'E1', 4, 4, '2028-01-31', 30),
  ('00000000-0000-0000-0000-0000000006f1', '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000f6', 'NEG-STOCK', -2, 0, '2099-12-31', 30),
  ('00000000-0000-0000-0000-000000000ee1', '00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-0000000000e1', 'X1', 9, 9, '2028-01-31', 10);

insert into pharmacy_stock_takes (id, tenant_id, reference, title, opened_by) values
  ('00000000-0000-0000-0000-00000000ca01', '00000000-0000-0000-0000-0000000000a1', 'ST-TEST-01', 'Full count', '00000000-0000-0000-0000-00000000aa01');

-- One open take per pharmacy.
do $$ begin
  insert into pharmacy_stock_takes (tenant_id, reference, title, opened_by) values
    ('00000000-0000-0000-0000-0000000000a1', 'ST-TEST-02', 'Second', '00000000-0000-0000-0000-00000000aa01');
  raise exception 'expected the one-open index to refuse a second open take';
exception when unique_violation then null; end $$;

create function pg_temp.c(p_product text, p_key text, p_batch text, p_qty int, p_by text, p_new text default null, p_exp date default null)
returns void language sql as $$
  insert into pharmacy_stock_take_counts (tenant_id, stock_take_id, product_id, batch_key, batch_id, new_batch_number, new_expiry_date, counted_qty, counted_by, client_entry_id, counted_at)
  values ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-00000000ca01', p_product::uuid, p_key, p_batch::uuid, p_new, p_exp, p_qty, p_by::uuid, gen_random_uuid(), now());
$$;
select pg_temp.c('00000000-0000-0000-0000-0000000000f1', 'unbatched', null, 10, '00000000-0000-0000-0000-00000000aa02');
select pg_temp.c('00000000-0000-0000-0000-0000000000f2', '00000000-0000-0000-0000-0000000002b1', '00000000-0000-0000-0000-0000000002b1', 8, '00000000-0000-0000-0000-00000000aa02');
select pg_temp.c('00000000-0000-0000-0000-0000000000f2', '00000000-0000-0000-0000-0000000002b1', '00000000-0000-0000-0000-0000000002b1', 2, '00000000-0000-0000-0000-00000000aa01');
select pg_temp.c('00000000-0000-0000-0000-0000000000f2', 'unbatched', null, 15, '00000000-0000-0000-0000-00000000aa02');
select pg_temp.c('00000000-0000-0000-0000-0000000000f3', '00000000-0000-0000-0000-0000000003c1', '00000000-0000-0000-0000-0000000003c1', 12, '00000000-0000-0000-0000-00000000aa02');
select pg_temp.c('00000000-0000-0000-0000-0000000000f4', '00000000-0000-0000-0000-0000000004d1', '00000000-0000-0000-0000-0000000004d1', 3, '00000000-0000-0000-0000-00000000aa02');
select pg_temp.c('00000000-0000-0000-0000-0000000000f5', '00000000-0000-0000-0000-0000000005e1', '00000000-0000-0000-0000-0000000005e1', 4, '00000000-0000-0000-0000-00000000aa02');
select pg_temp.c('00000000-0000-0000-0000-0000000000f5', 'new:NEWB1', null, 7, '00000000-0000-0000-0000-00000000aa02', 'NEWB1', '2028-03-31');
insert into pharmacy_stock_take_overrides (tenant_id, stock_take_id, product_id, batch_key, batch_id, override_qty, reason, set_by) values
  ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-00000000ca01', '00000000-0000-0000-0000-0000000000f5',
   '00000000-0000-0000-0000-0000000005e1', '00000000-0000-0000-0000-0000000005e1', 6, 'Recounted top shelf', '00000000-0000-0000-0000-00000000aa01');

-- A new batch without an expiry is refused.
do $$ begin
  perform pg_temp.c('00000000-0000-0000-0000-0000000000f5', 'new:NOEXP', null, 1, '00000000-0000-0000-0000-00000000aa02', 'NOEXP', null);
  raise exception 'expected new batch without expiry to fail';
exception when check_violation then null; end $$;

-- A count from another tenant against this take is refused.
do $$ begin
  insert into pharmacy_stock_take_counts (tenant_id, stock_take_id, product_id, batch_key, counted_qty, counted_by, client_entry_id, counted_at)
  values ('00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-00000000ca01', '00000000-0000-0000-0000-0000000000e1', 'unbatched', 1, '00000000-0000-0000-0000-00000000bb01', gen_random_uuid(), now());
  raise exception 'expected cross-tenant count to fail';
exception when others then
  if sqlerrm not like 'PERMISSION:%' then raise; end if;
end $$;

-- Posting while still counting is refused.
do $$ begin
  perform post_pharmacy_stock_take('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-00000000ca01', '00000000-0000-0000-0000-00000000aa01');
  raise exception 'expected NOT_IN_REVIEW';
exception when others then
  if sqlerrm not like 'STOCK_TAKE_NOT_IN_REVIEW:%' then raise; end if;
end $$;

update pharmacy_stock_takes set status = 'review' where id = '00000000-0000-0000-0000-00000000ca01';

-- Counts are closed once in review; deletes too.
do $$ begin
  perform pg_temp.c('00000000-0000-0000-0000-0000000000f6', 'unbatched', null, 1, '00000000-0000-0000-0000-00000000aa02');
  raise exception 'expected STOCK_TAKE_CLOSED';
exception when others then
  if sqlerrm not like 'STOCK_TAKE_CLOSED:%' then raise; end if;
end $$;
do $$ begin
  delete from pharmacy_stock_take_counts where product_id = '00000000-0000-0000-0000-0000000000f3';
  raise exception 'expected STOCK_TAKE_CLOSED on delete';
exception when others then
  if sqlerrm not like 'STOCK_TAKE_CLOSED:%' then raise; end if;
end $$;

-- A deactivated or foreign actor cannot post.
do $$ begin
  perform post_pharmacy_stock_take('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-00000000ca01', '00000000-0000-0000-0000-00000000bb01');
  raise exception 'expected PERMISSION';
exception when others then
  if sqlerrm not like 'PERMISSION:%' then raise; end if;
end $$;

-- Post ------------------------------------------------------------------------
create temp table summary as
select post_pharmacy_stock_take('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-00000000ca01', '00000000-0000-0000-0000-00000000aa01') as s;
select s from summary;

do $$
declare
  v jsonb := (select s from summary);
  q int;
begin
  -- P1: negative cleared, counted 10 on a COUNT batch.
  select quantity into q from pharmacy_products where id = '00000000-0000-0000-0000-0000000000f1';
  if q <> 10 then raise exception 'P1 quantity % <> 10', q; end if;
  select quantity into q from pharmacy_product_batches where id = '00000000-0000-0000-0000-0000000001a1';
  if q <> 0 then raise exception 'P1 NEG-STOCK % <> 0', q; end if;
  select quantity into q from pharmacy_product_batches where product_id = '00000000-0000-0000-0000-0000000000f1' and batch_number = 'COUNT-ST-TEST-01';
  if q <> 10 then raise exception 'P1 count batch % <> 10', q; end if;

  -- P2: B1 = 8 + 2, B2 keeps 15 of 20, total 25.
  select quantity into q from pharmacy_product_batches where id = '00000000-0000-0000-0000-0000000002b1';
  if q <> 10 then raise exception 'P2 B1 % <> 10', q; end if;
  select quantity into q from pharmacy_product_batches where id = '00000000-0000-0000-0000-0000000002b2';
  if q <> 15 then raise exception 'P2 B2 % <> 15', q; end if;
  select quantity into q from pharmacy_products where id = '00000000-0000-0000-0000-0000000000f2';
  if q <> 25 then raise exception 'P2 total % <> 25', q; end if;

  -- P3 unchanged and no adjustment written.
  select quantity into q from pharmacy_products where id = '00000000-0000-0000-0000-0000000000f3';
  if q <> 12 then raise exception 'P3 % <> 12', q; end if;
  if exists (select 1 from pharmacy_stock_adjustments where product_id = '00000000-0000-0000-0000-0000000000f3') then
    raise exception 'P3 should have no adjustment';
  end if;

  -- P4 product total aligned to its batch.
  select quantity into q from pharmacy_products where id = '00000000-0000-0000-0000-0000000000f4';
  if q <> 3 then raise exception 'P4 % <> 3', q; end if;
  if not exists (select 1 from pharmacy_stock_take_postings where product_id = '00000000-0000-0000-0000-0000000000f4' and rule = 'product_total') then
    raise exception 'P4 missing product_total posting';
  end if;

  -- P5 recount wins (6) and the found batch is created (7): 13.
  select quantity into q from pharmacy_product_batches where id = '00000000-0000-0000-0000-0000000005e1';
  if q <> 6 then raise exception 'P5 E1 % <> 6', q; end if;
  select quantity into q from pharmacy_product_batches where product_id = '00000000-0000-0000-0000-0000000000f5' and batch_number = 'NEWB1' and expiry_date = '2028-03-31';
  if q <> 7 then raise exception 'P5 new batch % <> 7', q; end if;
  select quantity into q from pharmacy_products where id = '00000000-0000-0000-0000-0000000000f5';
  if q <> 13 then raise exception 'P5 total % <> 13', q; end if;

  -- P6 not counted: untouched, still negative.
  select quantity into q from pharmacy_products where id = '00000000-0000-0000-0000-0000000000f6';
  if q <> -2 then raise exception 'P6 % <> -2', q; end if;

  -- Product totals equal their batches for every counted product.
  if exists (
    select 1 from pharmacy_products p
    where p.tenant_id = '00000000-0000-0000-0000-0000000000a1'
      and p.id <> '00000000-0000-0000-0000-0000000000f6'
      and p.quantity <> (select coalesce(sum(quantity), 0) from pharmacy_product_batches b where b.product_id = p.id)
  ) then raise exception 'product and batch totals disagree after posting'; end if;

  -- Every adjustment is PHYSICAL, linked, approved by the manager.
  if exists (select 1 from pharmacy_stock_adjustments where stock_take_id is distinct from '00000000-0000-0000-0000-00000000ca01'
             or type <> 'PHYSICAL' or approved_by <> '00000000-0000-0000-0000-00000000aa01') then
    raise exception 'adjustment not linked/approved';
  end if;
  -- Adjustments per product add up to the change in its total.
  if (select sum(quantity) from pharmacy_stock_adjustments where product_id = '00000000-0000-0000-0000-0000000000f1') <> 15
     or (select sum(quantity) from pharmacy_stock_adjustments where product_id = '00000000-0000-0000-0000-0000000000f2') <> -5
     or (select sum(quantity) from pharmacy_stock_adjustments where product_id = '00000000-0000-0000-0000-0000000000f4') <> -2
     or (select sum(quantity) from pharmacy_stock_adjustments where product_id = '00000000-0000-0000-0000-0000000000f5') <> 9 then
    raise exception 'adjustments do not add up to the product changes';
  end if;

  if (v ->> 'productsCounted')::int <> 5 then raise exception 'productsCounted %', v ->> 'productsCounted'; end if;
  if (v ->> 'productsChanged')::int <> 4 then raise exception 'productsChanged %', v ->> 'productsChanged'; end if;
  if (v ->> 'negativesCleared')::int <> 1 then raise exception 'negativesCleared %', v ->> 'negativesCleared'; end if;
  -- P1 +15 units, P2 -5, P4 -2, P5 +9  => gained 24, lost 7.
  if (v ->> 'unitsGained')::int <> 24 then raise exception 'unitsGained %', v ->> 'unitsGained'; end if;
  if (v ->> 'unitsLost')::int <> 7 then raise exception 'unitsLost %', v ->> 'unitsLost'; end if;
  -- Value: P1 +5*100 (NEG) +10*100 = 1500; P2 B2 -5*60 = -300; P4 -2*20 = -40;
  -- P5 +2*30 + 7*30 = 270. Gained 1770, lost 340.
  if (v ->> 'valueGained')::numeric <> 1770 then raise exception 'valueGained %', v ->> 'valueGained'; end if;
  if (v ->> 'valueLost')::numeric <> 340 then raise exception 'valueLost %', v ->> 'valueLost'; end if;

  if (select status from pharmacy_stock_takes where id = '00000000-0000-0000-0000-00000000ca01') <> 'posted' then
    raise exception 'take not posted';
  end if;
  -- Tenant B untouched.
  if (select quantity from pharmacy_products where id = '00000000-0000-0000-0000-0000000000e1') <> 9 then
    raise exception 'tenant B changed';
  end if;
end $$;

-- Posting again replays the summary and changes nothing.
do $$
declare v jsonb; n int := (select count(*) from pharmacy_stock_adjustments);
begin
  v := post_pharmacy_stock_take('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-00000000ca01', '00000000-0000-0000-0000-00000000aa01');
  if (v ->> 'replay')::boolean is not true then raise exception 'expected replay'; end if;
  if (select count(*) from pharmacy_stock_adjustments) <> n then raise exception 'replay wrote adjustments'; end if;
end $$;

-- Overrides are closed once posted.
do $$ begin
  update pharmacy_stock_take_overrides set override_qty = 1;
  raise exception 'expected STOCK_TAKE_CLOSED for override after post';
exception when others then
  if sqlerrm not like 'STOCK_TAKE_CLOSED:%' then raise; end if;
end $$;

-- Row security: authenticated reads only its tenant, writes nothing, and
-- cannot call the posting function.
grant usage on schema public to authenticated;
set role authenticated;
select set_config('test.tenant', '00000000-0000-0000-0000-0000000000b1', false);
do $$ begin
  if (select count(*) from pharmacy_stock_takes) <> 0 then raise exception 'tenant B sees tenant A take'; end if;
  if (select count(*) from pharmacy_stock_take_counts) <> 0 then raise exception 'tenant B sees tenant A counts'; end if;
end $$;
select set_config('test.tenant', '00000000-0000-0000-0000-0000000000a1', false);
do $$ begin
  if (select count(*) from pharmacy_stock_takes) <> 1 then raise exception 'tenant A cannot read its take'; end if;
  if (select count(*) from pharmacy_stock_take_postings) = 0 then raise exception 'tenant A cannot read postings'; end if;
end $$;
do $$ begin
  insert into pharmacy_stock_takes (tenant_id, reference, title, opened_by)
  values ('00000000-0000-0000-0000-0000000000a1', 'ST-X', 'x', '00000000-0000-0000-0000-00000000aa01');
  raise exception 'authenticated must not insert';
exception when insufficient_privilege then null; end $$;
do $$ begin
  perform post_pharmacy_stock_take('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-00000000ca01', '00000000-0000-0000-0000-00000000aa01');
  raise exception 'authenticated must not post';
exception when insufficient_privilege then null; end $$;
reset role;
SQL

echo "pharmacy stock take: all database checks passed"
