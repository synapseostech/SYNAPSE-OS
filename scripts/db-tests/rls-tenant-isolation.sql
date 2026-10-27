-- RLS tenant-isolation proof for the SEC-01 repair.
--
-- Executed and passed on a disposable PostgreSQL 16 database on 2026-10-25.
-- That proves the migrations behave as asserted on an empty disposable database;
-- production remains unverified. Run it with
-- scripts/db-tests/run-rls-isolation.sh and capture the output before claiming
-- the repair is verified in production.
--
-- Expects to run as a superuser on an EMPTY disposable database that already has
-- the roles anon / authenticated / service_role and auth.uid() (the runner
-- creates those first). It bootstraps its own minimal schema, so it never needs
-- the full migration chain — and it refuses to run if app schema already exists.
--
-- What it proves, in order:
--   1. the tautology is real: an authenticated user in tenant A reads tenant B's
--      rows on all ten tables, and can write them;
--   2. `anon` is denied cleanly, before as well as after the repair. The original
--      policy inlines the profile subquery (`SELECT <table>.tenant_id FROM
--      profiles WHERE profiles.id = auth.uid()`), which evaluates to NULL for a
--      caller with no JWT and yields zero rows — not an error. The
--      `permission denied for function current_tenant_id()` failure belongs to a
--      repair that omits the role clause, which is why the migration checks for
--      it; asserting it here would be asserting a state that never existed.
--   3. the prepared migration closes the tenant hole without inventing policies
--      and without touching the per-table platform_admin_bypass / public-read
--      policies;
--   4. what it does NOT close. Permissive policies are OR'd, so a correct tenant
--      predicate does not neutralise its neighbours:
--        * "Public read products" is USING (true) — in the SNAPSHOT state;
--          20261003160000_profiles_privileged_columns_guard.sql drops it, and
--          step 17 re-checks the post-drop state;
--        * "Admins full access products/items/cylinders" test profiles.is_admin
--          only, with no tenant predicate — modelled below, and step 14b proves
--          an admin in tenant A reads and writes tenant B's order_items;
--        * the telemedicine staff read/update policies test the caller's role
--          only, with no tenant predicate — modelled below, and step 14b proves
--          a tenant-A clinician reads a tenant-B patient's intake case.
--      Those are SEC-02 and need a product decision, so the harness asserts the
--      residual behaviour explicitly instead of pretending the repair fixed it.
--      The policies are reproduced as they exist in the current chain; nothing
--      here changes a clinical or administrative access rule.
--
-- It does NOT prove the fail-closed path for a missing policy: that path raises,
-- and a raise inside \i would abort the harness. It is asserted statically in
-- scripts/rls-tenant-isolation.test.mjs instead.

\set ON_ERROR_STOP on

-- FIDELITY (post 2.2). Every production policy that survives the repair and
-- applies to the ten tables is now modelled: sync_conflicts_hospital_isolation,
-- "Users view own cylinders", "Users can view own order items", the three
-- "Admins full access products/items/cylinders" policies, the telemedicine
-- staff policies, and platform_admin_bypass. The orders/restaurants admin
-- policies are also modelled because 20261026130000 alters them and is applied
-- by step 18. Still unprovable in a fixture: the real PostgREST claim shape for
-- service-role requests (the runner emulates service_role via SET ROLE +
-- bypassrls, not a PostgREST request) and any production data distribution
-- (NULL tenants, orphaned tenant ids).

-- 0. Refuse to run anywhere that already looks like SynapseOS. This file creates
--    roles-visible tables and rewrites RLS policies; running it against a real
--    database would be destructive. public.profiles exists in every real
--    environment, so this is a hard stop before any DDL.
do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'profiles'
  ) then
    raise exception 'refusing to run: public.profiles already exists. This harness bootstraps its own schema and must only run against an empty disposable database.';
  end if;
end $$;

-- 1. Minimal schema: the ten affected tables, profiles, and the two helpers,
--    shaped exactly as 20260613104631_emergency_auth_rls_convergence.sql does
--    (SECURITY DEFINER, STABLE, search_path pinned).
create table public.profiles (
  id uuid primary key,
  tenant_id uuid,
  role text,
  -- `is_admin` and `hospital_id` are referenced by permissive policies that
  -- survive the repair, so the fixture needs them or those policies cannot be
  -- reproduced and step 14b would prove nothing.
  is_admin boolean not null default false,
  hospital_id uuid
);

create function public.current_tenant_id() returns uuid
language sql security definer stable set search_path = public as $$
  select tenant_id from public.profiles where id = auth.uid() limit 1;
$$;

create function public.is_platform_admin() returns boolean
language sql security definer stable set search_path = public as $$
  select exists (select 1 from public.profiles where id = auth.uid() and role = 'platform_admin');
$$;

do $$
declare
  t text;
  v_tables text[] := array[
    'encounter_orders', 'encounters', 'gas_cylinders', 'hospital_drug_orders',
    'order_items', 'products', 'sync_conflicts', 'telemedicine_intake_cases',
    'telemedicine_intake_messages', 'vitals'
  ];
begin
  foreach t in array v_tables loop
    execute format(
      'create table public.%I (id uuid primary key default gen_random_uuid(), tenant_id uuid, label text)',
      t
    );
    execute format('alter table public.%I enable row level security', t);
    -- Mirror the production grant shape, which is part of the defect surface:
    -- anon holds ALL on these tables (302 tables grant ALL to anon), so RLS is
    -- the only thing standing between an anonymous caller and the rows.
    execute format('grant select, insert, update, delete on public.%I to anon, authenticated, service_role', t);
  end loop;
end $$;

grant usage on schema public to anon, authenticated, service_role;
grant select, insert, update, delete on public.profiles to anon, authenticated, service_role;

-- The telemedicine policies join on user_id / case_id, so the fixture needs those
-- two columns. Nothing else about those tables' shape matters to these policies.
alter table public.telemedicine_intake_cases add column user_id uuid;
alter table public.telemedicine_intake_messages add column case_id uuid;

-- Columns referenced by the surviving permissive policies the fixture now
-- models: customer_id on gas_cylinders, order_id on order_items, hospital_id on
-- sync_conflicts, and a minimal orders table the order_items policy joins
-- through. orders/restaurants also exist so 20261026130000 can be applied
-- verbatim in step 18 (it alters their admin policies and fails closed if one
-- is absent). All new columns default NULL and no orders rows are seeded, so the
-- policies grant nothing extra to the fixture users: the expected counts in
-- steps 5a/5b/7/9/10/11 were re-derived with this fixture and are unchanged —
-- a justified result, not a patched number.
alter table public.gas_cylinders add column customer_id uuid;
alter table public.order_items add column order_id uuid;
alter table public.sync_conflicts add column hospital_id uuid;

create table public.orders (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid,
  tenant_id uuid
);
alter table public.orders enable row level security;
grant select, insert, update, delete on public.orders to anon, authenticated, service_role;

create table public.restaurants (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid,
  label text
);
alter table public.restaurants enable row level security;
grant select, insert, update, delete on public.restaurants to anon, authenticated, service_role;

-- auto_set_tenant_id(), exactly as the snapshot defines it, attached BEFORE
-- INSERT to all ten tables. This is the trigger behind finding F1: under a
-- service-role client auth.uid() is NULL, so it writes NULL. The fixture needs
-- it so the harness can show what a service-role insert actually stores.
create function public.auto_set_tenant_id() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.tenant_id is null then
    new.tenant_id := (select tenant_id from public.profiles where id = auth.uid());
  end if;
  return new;
end;
$$;

do $$
declare
  t text;
  v_tables text[] := array[
    'encounter_orders', 'encounters', 'gas_cylinders', 'hospital_drug_orders',
    'order_items', 'products', 'sync_conflicts', 'telemedicine_intake_cases',
    'telemedicine_intake_messages', 'vitals'
  ];
begin
  foreach t in array v_tables loop
    execute format(
      'create trigger %I before insert on public.%I for each row execute function public.auto_set_tenant_id()',
      'set_tenant_id_' || t, t
    );
  end loop;
end $$;

-- 2. Mirror the helper EXECUTE model from 20260613104631 + 20260613104742.
--    This is what makes the pre-repair PUBLIC policy scope a live trap for anon
--    rather than a harmless no-op, so it must be in place BEFORE the
--    reproduction, not after.
revoke all on function public.current_tenant_id() from public;
revoke all on function public.current_tenant_id() from anon;
grant execute on function public.current_tenant_id() to authenticated, service_role;

revoke all on function public.is_platform_admin() from public;
revoke all on function public.is_platform_admin() from anon;
grant execute on function public.is_platform_admin() to authenticated, service_role;

-- 3. Reproduce the defect exactly as the canonical snapshot has it, including
--    the neighbouring permissive policies the repair must not disturb.
do $$
declare
  t text;
  v_tables text[] := array[
    'encounter_orders', 'encounters', 'gas_cylinders', 'hospital_drug_orders',
    'order_items', 'products', 'sync_conflicts', 'telemedicine_intake_cases',
    'telemedicine_intake_messages', 'vitals'
  ];
begin
  foreach t in array v_tables loop
    -- The tautology: no TO clause (=> PUBLIC), subquery selects the row's own
    -- column, so the predicate is `tenant_id = tenant_id`.
    execute format(
      'create policy "tenant_isolation" on public.%I using (("tenant_id" = ( select %I."tenant_id" from public.profiles where profiles.id = auth.uid() )))',
      t, t
    );
    -- Every one of the ten carries this in production.
    execute format(
      'create policy "platform_admin_bypass" on public.%I using (exists (select 1 from public.profiles where profiles.id = auth.uid() and profiles.role = ''platform_admin''::text))',
      t
    );
  end loop;
end $$;

-- products is deliberately world-readable in production (SEC-02). Reproduce it:
-- a correct tenant predicate will NOT remove this exposure.
create policy "Public read products" on public.products for select using (true);

-- The rest of the SEC-02 neighbours, reproduced as the current migration chain
-- has them. All permissive, all OR'd with tenant_isolation, so the repair does
-- not constrain any of them. Step 14b demonstrates this rather than assuming it.
-- These are the production definitions; the harness changes no access rule.

-- profiles.is_admin only, no tenant predicate.
create policy "Admins full access products" on public.products
  for all using (exists (select 1 from public.profiles
                          where profiles.id = auth.uid() and profiles.is_admin = true));
create policy "Admins full access items" on public.order_items
  for all using (exists (select 1 from public.profiles
                          where profiles.id = auth.uid() and profiles.is_admin = true));
create policy "Admins full access cylinders" on public.gas_cylinders
  for all using (exists (select 1 from public.profiles
                          where profiles.id = auth.uid() and profiles.is_admin = true));

-- Caller's role only, no tenant predicate.
create policy "telemedicine_intake_cases_user_insert" on public.telemedicine_intake_cases
  for insert with check ("auth"."role"() = 'authenticated' and user_id = auth.uid());
create policy "telemedicine_intake_cases_user_read" on public.telemedicine_intake_cases
  for select using ("auth"."role"() = 'authenticated' and (user_id = auth.uid() or exists (
    select 1 from public.profiles p where p.id = auth.uid()
      and p.role = any (array['admin', 'receptionist', 'doctor', 'nurse', 'clinician']))));
create policy "telemedicine_intake_cases_user_update" on public.telemedicine_intake_cases
  for update using ("auth"."role"() = 'authenticated' and (user_id = auth.uid() or exists (
    select 1 from public.profiles p where p.id = auth.uid()
      and p.role = any (array['admin', 'receptionist', 'doctor', 'nurse', 'clinician']))))
  with check ("auth"."role"() = 'authenticated' and (user_id = auth.uid() or exists (
    select 1 from public.profiles p where p.id = auth.uid()
      and p.role = any (array['admin', 'receptionist', 'doctor', 'nurse', 'clinician']))));
create policy "telemedicine_intake_messages_user_insert" on public.telemedicine_intake_messages
  for insert with check ("auth"."role"() = 'authenticated' and exists (
    select 1 from public.telemedicine_intake_cases c
     where c.id = telemedicine_intake_messages.case_id
       and (c.user_id = auth.uid() or exists (
         select 1 from public.profiles p where p.id = auth.uid()
           and p.role = any (array['admin', 'receptionist', 'doctor', 'nurse', 'clinician'])))));
create policy "telemedicine_intake_messages_user_read" on public.telemedicine_intake_messages
  for select using ("auth"."role"() = 'authenticated' and exists (
    select 1 from public.telemedicine_intake_cases c
     where c.id = telemedicine_intake_messages.case_id
       and (c.user_id = auth.uid() or exists (
         select 1 from public.profiles p where p.id = auth.uid()
           and p.role = any (array['admin', 'receptionist', 'doctor', 'nurse', 'clinician'])))));

-- The three remaining permissive neighbours, modelled verbatim from the
-- snapshot so the fixture matches production.
create policy "sync_conflicts_hospital_isolation" on public.sync_conflicts
  using (hospital_id = (select p.hospital_id from public.profiles p
                        where p.id = auth.uid() limit 1));

create policy "Users view own cylinders" on public.gas_cylinders
  for select using (auth.uid() = customer_id);

create policy "Users can view own order items" on public.order_items
  for select using (exists (
    select 1 from public.orders
    where orders.id = order_items.order_id
      and orders.customer_id = auth.uid()));

-- orders/restaurants admin policies are outside the ten-table scope but share
-- the F3 defect class; 20261026130000 alters them, so they must exist here for
-- the migration's fail-closed check and for step 18.
create policy "Admins full access orders" on public.orders
  for all using (exists (select 1 from public.profiles
                          where profiles.id = auth.uid() and profiles.is_admin = true));
create policy "Admins full access restaurants" on public.restaurants
  for all using (exists (select 1 from public.profiles
                          where profiles.id = auth.uid() and profiles.is_admin = true));

-- 4. Synthetic tenants. No real data of any kind.
insert into public.profiles (id, tenant_id, role, is_admin, hospital_id) values
  ('00000000-0000-4000-8000-00000000000a', '11111111-1111-4111-8111-111111111111', 'hospital_admin', false, '99999999-9999-4999-8999-999999999999'),
  ('00000000-0000-4000-8000-00000000000b', '22222222-2222-4222-8222-222222222222', 'hospital_admin', false, null),
  ('00000000-0000-4000-8000-00000000000c', '11111111-1111-4111-8111-111111111111', 'platform_admin', false, null),
  ('00000000-0000-4000-8000-00000000000d', null, 'hospital_admin', false, null),
  -- Added for the SEC-02 demonstrations: a tenant-A administrator, a tenant-A
  -- clinician, and a tenant-B patient whose intake case the clinician must not
  -- be able to read but can.
  ('00000000-0000-4000-8000-000000000011', '11111111-1111-4111-8111-111111111111', 'hospital_admin', true, null),
  ('00000000-0000-4000-8000-00000000000e', '11111111-1111-4111-8111-111111111111', 'doctor', false, null),
  ('00000000-0000-4000-8000-000000000010', '22222222-2222-4222-8222-222222222222', 'patient', false, null),
  -- Added for step 19: a tenant-A patient whose intake case is inserted by the
  -- service-role and must inherit tenant A via the owner trigger.
  ('00000000-0000-4000-8000-000000000012', '11111111-1111-4111-8111-111111111111', 'patient', false, null);

do $$
declare
  t text;
  v_tables text[] := array[
    'encounter_orders', 'encounters', 'gas_cylinders', 'hospital_drug_orders',
    'order_items', 'products', 'sync_conflicts', 'telemedicine_intake_cases',
    'telemedicine_intake_messages', 'vitals'
  ];
begin
  foreach t in array v_tables loop
    execute format(
      'insert into public.%I (tenant_id, label) values (%L, %L), (%L, %L)',
      t,
      '11111111-1111-4111-8111-111111111111', 'tenant-a',
      '22222222-2222-4222-8222-222222222222', 'tenant-b'
    );
  end loop;
end $$;

-- 5a. Reproduce the defect as tenant A. While the tautology is in place the
--     predicate is true for every row, so A sees both tenants' rows.
set role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-00000000000a', false);
select set_config('request.jwt.claim.role', 'authenticated', false);

do $$
declare
  t text;
  n int;
  v_tables text[] := array[
    'encounter_orders', 'encounters', 'gas_cylinders', 'hospital_drug_orders',
    'order_items', 'products', 'sync_conflicts', 'telemedicine_intake_cases',
    'telemedicine_intake_messages', 'vitals'
  ];
begin
  foreach t in array v_tables loop
    execute format('select count(*) from public.%I', t) into n;
    if n <> 2 then
      raise exception 'reproduction failed: tenant A sees % rows in % (expected 2 while the tautology is in place)', n, t;
    end if;
  end loop;

  -- The write half of the defect: A can rewrite B's row.
  execute 'update public.encounters set label = ''cross-tenant-write'' where tenant_id = ''22222222-2222-4222-8222-222222222222''';
  get diagnostics n = row_count;
  if n <> 1 then
    raise exception 'reproduction failed: cross-tenant UPDATE affected % rows (expected 1)', n;
  end if;
  execute 'update public.encounters set label = ''tenant-b'' where tenant_id = ''22222222-2222-4222-8222-222222222222''';

  raise notice 'SEC-01 reproduced: tenant A reads and writes tenant B rows on all ten tables';
end $$;

-- 5b. Anonymous callers BEFORE the repair. The original policies inline the
--     profile subquery rather than calling current_tenant_id(), so anon does not
--     hit a function-permission error here: with no JWT subject, auth.uid() is
--     NULL, the subquery returns no row, and the predicate evaluates to NULL.
--     The expected result is a clean zero-row denial.
--
--     auth.uid() is read from the `request.jwt.claim.sub` custom setting, and
--     `SET ROLE` does NOT reset custom settings: they are session-scoped. Step
--     5a set the subject to tenant A, so every anon block below MUST clear it
--     explicitly. Leaving it set made "anon" run as tenant A, which made the
--     tautology match and produced a false failure at this step on a real
--     PostgreSQL 16 run.
--
--     The `permission denied for function current_tenant_id()` failure belongs
--     to a repair that changes the predicate but omits `to authenticated` — it
--     is created BY such a repair, not by the original defect. That shape is
--     rejected by the migration's self-check rather than exercised here.
--
--     products is excluded from the loop because "Public read products" is
--     USING (true) at this point in the chain; it is asserted separately.
reset role;
set role anon;
select set_config('request.jwt.claim.sub', '', false);
select set_config('request.jwt.claim.role', '', false);

do $$
declare
  t text;
  n int;
  v_nine text[] := array[
    'encounter_orders', 'encounters', 'gas_cylinders', 'hospital_drug_orders',
    'order_items', 'sync_conflicts', 'telemedicine_intake_cases',
    'telemedicine_intake_messages', 'vitals'
  ];
begin
  foreach t in array v_nine loop
    execute format('select count(*) from public.%I', t) into n;
    if n <> 0 then
      raise exception 'reproduction failed: anon saw % rows in % before the repair (expected a clean zero-row denial)', n, t;
    end if;
  end loop;

  select count(*) from public.products into n;
  if n <> 2 then
    raise exception 'anon should still read the public catalogue before the repair: saw % products (expected 2)', n;
  end if;

  raise notice 'anon: clean zero-row denial on nine tables, public catalogue readable (2 products) before the repair';
end $$;

reset role;

-- 6. Apply the prepared repair file itself — not a copy, not a paraphrase.
\i supabase/migrations/20261025120000_tenant_isolation_policy_repair.sql

-- 7. Post-repair: tenant A is confined to its own rows, on read and on write.
set role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-00000000000a', false);
select set_config('request.jwt.claim.role', 'authenticated', false);

do $$
declare
  t text;
  n int;
  v_expected int;
  v_tables text[] := array[
    'encounter_orders', 'encounters', 'gas_cylinders', 'hospital_drug_orders',
    'order_items', 'products', 'sync_conflicts', 'telemedicine_intake_cases',
    'telemedicine_intake_messages', 'vitals'
  ];
begin
  foreach t in array v_tables loop
    execute format('select count(*) from public.%I', t) into n;
    -- products keeps its public read policy, so a correct tenant predicate does
    -- not reduce the count there. Asserting 1 would be a false pass.
    if t = 'products' then v_expected := 2; else v_expected := 1; end if;
    if n <> v_expected then
      raise exception 'SELECT isolation failed on %: tenant A sees % rows (expected %)', t, n, v_expected;
    end if;

    -- Cross-tenant INSERT is rejected by WITH CHECK.
    begin
      execute format('insert into public.%I (tenant_id, label) values (%L, %L)',
                     t, '22222222-2222-4222-8222-222222222222', 'smuggled');
      raise exception 'INSERT isolation failed on %: cross-tenant insert was accepted', t;
    exception
      when insufficient_privilege then null;  -- expected: new row violates RLS
    end;

    -- Cross-tenant UPDATE and DELETE touch zero rows.
    execute format('update public.%I set label = %L where tenant_id = %L',
                   t, 'tampered', '22222222-2222-4222-8222-222222222222');
    get diagnostics n = row_count;
    if n <> 0 then
      raise exception 'UPDATE isolation failed on %: % rows changed', t, n;
    end if;

    execute format('delete from public.%I where tenant_id = %L',
                   t, '22222222-2222-4222-8222-222222222222');
    get diagnostics n = row_count;
    if n <> 0 then
      raise exception 'DELETE isolation failed on %: % rows deleted', t, n;
    end if;
  end loop;

  raise notice 'RLS tenant isolation PASSED on all ten tables (select/insert/update/delete)';
end $$;

-- 8. Same-tenant writes must still work, otherwise the repair is a denial of
--    service dressed as a fix.
do $$
declare
  n int;
begin
  insert into public.encounters (tenant_id, label) values
    ('11111111-1111-4111-8111-111111111111', 'tenant-a-new');
  get diagnostics n = row_count;
  if n <> 1 then
    raise exception 'same-tenant INSERT failed: % rows inserted', n;
  end if;

  update public.encounters set label = 'tenant-a-edited'
   where tenant_id = '11111111-1111-4111-8111-111111111111' and label <> 'tenant-a-edited';
  get diagnostics n = row_count;
  if n <> 2 then
    raise exception 'same-tenant UPDATE failed: % rows changed (expected 2)', n;
  end if;

  select count(*) from public.encounters into n;
  if n <> 2 then
    raise exception 'tenant A should now see its own 2 rows, saw %', n;
  end if;

  raise notice 'same-tenant read/write still works after the repair';
end $$;

-- 9. Tenant B still sees its own rows (the repair must not over-restrict).
reset role;
set role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-00000000000b', false);
select set_config('request.jwt.claim.role', 'authenticated', false);

do $$
declare
  t text;
  n int;
  v_expected int;
  v_tables text[] := array[
    'encounter_orders', 'encounters', 'gas_cylinders', 'hospital_drug_orders',
    'order_items', 'products', 'sync_conflicts', 'telemedicine_intake_cases',
    'telemedicine_intake_messages', 'vitals'
  ];
begin
  foreach t in array v_tables loop
    execute format('select count(*) from public.%I', t) into n;
    if t = 'products' then v_expected := 2; else v_expected := 1; end if;
    if n <> v_expected then
      raise exception 'tenant B lost access to its own rows in %: saw % (expected %)', t, n, v_expected;
    end if;
  end loop;
  raise notice 'tenant B retains its own rows on all ten tables';
end $$;

-- 10. No tenant context. Two shapes: an authenticated session with no JWT
--     subject, and a real user whose profile row has a NULL tenant_id. Both must
--     fail closed (zero rows), not raise and not leak.
select set_config('request.jwt.claim.sub', '', false);
do $$
declare
  t text;
  n int;
  v_expected int;
  v_tables text[] := array[
    'encounter_orders', 'encounters', 'gas_cylinders', 'hospital_drug_orders',
    'order_items', 'products', 'sync_conflicts', 'telemedicine_intake_cases',
    'telemedicine_intake_messages', 'vitals'
  ];
begin
  foreach t in array v_tables loop
    execute format('select count(*) from public.%I', t) into n;
    -- products still carries "Public read products" (USING (true)) at this point
    -- in the chain, so two rows are correct here and asserting zero would be a
    -- test bug rather than a stronger check. It is dropped in step 17, and step
    -- 17 then asserts the clean zero. Every other table must be zero.
    if t = 'products' then v_expected := 2; else v_expected := 0; end if;
    if n <> v_expected then
      raise exception 'missing tenant context leaked % rows from % (expected %)', n, t, v_expected;
    end if;
  end loop;
  raise notice 'no JWT subject: zero rows on the nine, public catalogue still readable (products=2)';
end $$;

select set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-00000000000d', false);
do $$
declare
  n int;
begin
  select count(*) from public.encounters into n;
  if n <> 0 then
    raise exception 'a profile with NULL tenant_id saw % rows (expected 0)', n;
  end if;
  raise notice 'profile with NULL tenant_id: zero rows visible';
end $$;

-- 11. A real platform admin must still reach every tenant through the untouched
--     platform_admin_bypass policy. This is the "permissive policies still OR
--     together" check — the repair must not neutralise its neighbours.
select set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-00000000000c', false);
do $$
declare
  n int;
begin
  select count(*) from public.encounters into n;
  if n <> 3 then
    raise exception 'platform admin saw % rows in encounters (expected 3: 2 tenant A + 1 tenant B)', n;
  end if;
  raise notice 'platform_admin_bypass still grants cross-tenant read';
end $$;

-- 12. Anonymous callers after the repair: no error, no leak, and the public
--     catalogue keeps working exactly as its own policy says it should.
reset role;
set role anon;
select set_config('request.jwt.claim.sub', '', false);
select set_config('request.jwt.claim.role', '', false);

do $$
declare
  n int;
  t text;
  v_tables text[] := array[
    'encounter_orders', 'encounters', 'gas_cylinders', 'hospital_drug_orders',
    'order_items', 'sync_conflicts', 'telemedicine_intake_cases',
    'telemedicine_intake_messages', 'vitals'
  ];
begin
  -- Before the repair this raised permission denied for function
  -- current_tenant_id(); it must now deny cleanly.
  foreach t in array v_tables loop
    execute format('select count(*) from public.%I', t) into n;
    if n <> 0 then
      raise exception 'anon saw % rows in % (expected 0)', n, t;
    end if;
  end loop;

  select count(*) from public.products into n;
  if n <> 2 then
    raise exception 'anon lost the public product catalogue: saw % rows (expected 2 via "Public read products")', n;
  end if;

  raise notice 'anon: clean deny on the nine, public read preserved on products';
end $$;

-- Anon writes must be refused. products has no public write policy.
do $$
begin
  begin
    insert into public.products (tenant_id, label) values
      ('11111111-1111-4111-8111-111111111111', 'anon-write');
    raise exception 'anon INSERT into products was accepted';
  exception
    when insufficient_privilege then null;  -- expected
  end;
  raise notice 'anon cannot write products';
end $$;

reset role;

-- 13. Service role bypasses RLS by design (bypassrls), and must still do so.
set role service_role;
do $$
declare
  n int;
begin
  select count(*) from public.encounters into n;
  if n <> 3 then
    raise exception 'service_role saw % rows in encounters (expected 3 with bypassrls)', n;
  end if;
  raise notice 'service_role still bypasses RLS';
end $$;
reset role;

-- 14. Policy metadata: the scope must be authenticated, not PUBLIC. This is the
--     assertion that would have caught the missing TO clause.
do $$
declare
  r record;
begin
  for r in
    select tablename, roles
    from pg_policies
    where schemaname = 'public' and policyname = 'tenant_isolation'
  loop
    if r.roles is null
      or 'public' = any (r.roles)
      or 'anon' = any (r.roles)
      or not ('authenticated' = any (r.roles))
    then
      raise exception 'tenant_isolation on public.% has roles %, expected {authenticated}', r.tablename, r.roles;
    end if;
  end loop;

  if (select count(*) from pg_policies
       where schemaname = 'public' and policyname = 'tenant_isolation') <> 10 then
    raise exception 'expected exactly 10 tenant_isolation policies, found %',
      (select count(*) from pg_policies where schemaname = 'public' and policyname = 'tenant_isolation');
  end if;
  raise notice 'policy metadata: 10 tenant_isolation policies, all scoped to authenticated';
end $$;

-- 14b. The SEC-02 neighbours still bypass the tenant boundary after a correct
--      repair. These assertions PASS, and they are not defects in the migration:
--      they make the residual exposure visible so nobody reads step 7 and
--      concludes the ten tables are isolated. Changing any of them would change
--      an administrative or clinical access rule, which needs a product decision
--      and is out of scope here.

-- A tenant-B patient's intake case, plus a message attached to it.
insert into public.telemedicine_intake_cases (id, tenant_id, user_id, label)
values ('33333333-3333-4333-8333-333333333333',
        '22222222-2222-4222-8222-222222222222',
        '00000000-0000-4000-8000-000000000010',
        'patient-b-intake');
insert into public.telemedicine_intake_messages (tenant_id, case_id, label)
values ('22222222-2222-4222-8222-222222222222',
        '33333333-3333-4333-8333-333333333333',
        'patient-b-message');

-- Administrator in tenant A. "Admins full access items" tests profiles.is_admin
-- only, with no tenant predicate.
reset role;
set role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-000000000011', false);
select set_config('request.jwt.claim.role', 'authenticated', false);

do $$
declare
  n int;
begin
  select count(*) into n from public.order_items
   where tenant_id = '22222222-2222-4222-8222-222222222222';
  if n <> 1 then
    raise exception 'admin bypass not reproduced: is_admin in tenant A saw % tenant-B order_items (expected 1)', n;
  end if;

  -- The same permissive FOR ALL policy also permits the write: its USING
  -- expression doubles as the WITH CHECK, and permissive policies are OR'd, so
  -- tenant_isolation's new WITH CHECK is not required to pass.
  insert into public.order_items (tenant_id, label)
  values ('22222222-2222-4222-8222-222222222222', 'admin-cross-tenant-insert');

  raise notice 'admin bypass reproduced: profiles.is_admin reads and writes another tenant order_items';
end $$;

-- Clinician in tenant A. The telemedicine staff policies test the caller's role
-- only, with no tenant predicate.
reset role;
set role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-00000000000e', false);
select set_config('request.jwt.claim.role', 'authenticated', false);

do $$
declare
  n int;
begin
  select count(*) into n from public.telemedicine_intake_cases
   where id = '33333333-3333-4333-8333-333333333333';
  if n <> 1 then
    raise exception 'staff-role bypass not reproduced: a tenant-A doctor could not read the tenant-B patient case';
  end if;

  select count(*) into n from public.telemedicine_intake_messages
   where case_id = '33333333-3333-4333-8333-333333333333';
  if n <> 1 then
    raise exception 'staff-role bypass not reproduced: a tenant-A doctor could not read the tenant-B patient message';
  end if;

  raise notice 'staff-role bypass reproduced: a tenant-A clinician reads another tenant intake case and message';
end $$;
reset role;

-- The write half of the intake exposure, and the reason the migration header
-- calls patient-initiated intake the sharpest case: user_insert has no tenant
-- clause, so it satisfies WITH CHECK on its own and tenant_isolation cannot
-- constrain the tenant the patient chooses. Nothing here is introduced by the
-- repair; it is reproduced so the residual is not mistaken for a fix.
set role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-000000000010', false);
select set_config('request.jwt.claim.role', 'authenticated', false);

do $$
declare
  n int;
begin
  insert into public.telemedicine_intake_cases (id, tenant_id, user_id, label)
  values ('44444444-4444-4444-8444-444444444444',
          '11111111-1111-4111-8111-111111111111',
          '00000000-0000-4000-8000-000000000010',
          'patient-b-wrote-into-tenant-a');

  select count(*) into n from public.telemedicine_intake_cases
   where id = '44444444-4444-4444-8444-444444444444';
  if n <> 1 then
    raise exception 'patient intake write bypass not reproduced: the tenant-A-labelled case was not created';
  end if;

  raise notice 'patient intake write is unconstrained: a tenant-B patient created a tenant-A case';
end $$;
reset role;

-- 15. Re-application is idempotent: the same file applied a second time leaves
--     the same ten policies, all scoped to authenticated.
--
--     The fail-closed path for a MISSING policy is deliberately not exercised
--     here. It raises, and a raise inside \i would abort this harness, so it is
--     asserted statically in scripts/rls-tenant-isolation.test.mjs.
\i supabase/migrations/20261025120000_tenant_isolation_policy_repair.sql

do $$
declare
  n int;
begin
  select count(*) into n from pg_policies
   where schemaname = 'public' and policyname = 'tenant_isolation'
     and roles = array['authenticated']::name[];
  if n <> 10 then
    raise exception 're-application changed the repaired policies: % scoped to authenticated (expected 10)', n;
  end if;
  raise notice 're-application is idempotent: 10 tenant_isolation policies, all scoped to authenticated';
end $$;

-- 16. The repair must leave the neighbouring policies untouched. If it silently
--     dropped or rewrote one, that is a behavioural change nobody signed off.
do $$
declare
  n int;
begin
  select count(*) into n from pg_policies
   where schemaname = 'public' and tablename = 'products' and policyname = 'Public read products';
  if n <> 1 then
    raise exception 'the repair disturbed "Public read products"';
  end if;

  select count(*) into n from pg_policies
   where schemaname = 'public' and policyname = 'platform_admin_bypass';
  if n <> 10 then
    raise exception 'expected 10 platform_admin_bypass policies, found %', n;
  end if;

  raise notice 'neighbouring policies untouched (platform_admin_bypass x10, Public read products)';
end $$;

-- 17. Current-source state. The snapshot above predates
--     20261003160000_profiles_privileged_columns_guard.sql, which drops
--     "Public read products" (and "queue_read_by_token" on consult_queue,
--     "Public read restaurants"). Fresh environments are built from the snapshot
--     and then have every later migration applied, so the state that actually
--     ships has no public product read. Apply the same drop here and require
--     anon to get a clean zero-row deny rather than an error — which is exactly
--     what the `TO authenticated` clause buys.
drop policy if exists "Public read products" on public.products;

set role anon;
select set_config('request.jwt.claim.sub', '', false);
select set_config('request.jwt.claim.role', '', false);
do $$
declare
  n int;
begin
  select count(*) from public.products into n;
  if n <> 0 then
    raise exception 'anon saw % products after the public policy was dropped (expected 0)', n;
  end if;
  raise notice 'current-source state: anon gets a clean zero-row deny on products (no function-permission error)';
end $$;
reset role;

-- 18. Apply the admin-policy scoping migration (20261026130000) verbatim and
--     prove the residual cross-tenant admin reach is closed while same-tenant
--     admin access and platform_admin_bypass survive.
\i supabase/migrations/20261026130000_scope_admin_policies_to_tenant.sql

set role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-000000000011', false);
select set_config('request.jwt.claim.role', 'authenticated', false);

do $$
declare
  n int;
begin
  -- (a) the tenant-A admin can no longer read tenant-B order_items.
  select count(*) into n from public.order_items
   where tenant_id = '22222222-2222-4222-8222-222222222222';
  if n <> 0 then
    raise exception 'admin policy not scoped: is_admin in tenant A still sees % tenant-B order_items (expected 0)', n;
  end if;

  -- (b) a cross-tenant INSERT under that admin is rejected.
  begin
    insert into public.order_items (tenant_id, label)
    values ('22222222-2222-4222-8222-222222222222', 'admin-cross-tenant-after');
    raise exception 'admin policy not scoped: cross-tenant INSERT was accepted';
  exception
    when insufficient_privilege then null;  -- expected
  end;

  -- (c) same-tenant admin read and write still succeed.
  select count(*) into n from public.order_items
   where tenant_id = '11111111-1111-4111-8111-111111111111';
  if n <> 1 then
    raise exception 'same-tenant admin lost access: saw % tenant-A order_items (expected 1)', n;
  end if;

  insert into public.order_items (tenant_id, label)
  values ('11111111-1111-4111-8111-111111111111', 'admin-same-tenant-insert');
  get diagnostics n = row_count;
  if n <> 1 then
    raise exception 'same-tenant admin INSERT failed: % rows inserted', n;
  end if;

  raise notice 'admin policies scoped to tenant: cross-tenant access denied, same-tenant admin access preserved';
end $$;
reset role;

-- (d) platform_admin_bypass is unaffected.
set role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-00000000000c', false);
select set_config('request.jwt.claim.role', 'authenticated', false);
do $$
declare
  n int;
begin
  select count(*) into n from public.order_items
   where tenant_id = '22222222-2222-4222-8222-222222222222';
  if n <> 2 then
    raise exception 'platform_admin_bypass disturbed: platform admin saw % tenant-B order_items (expected 2)', n;
  end if;
  raise notice 'platform_admin_bypass still grants cross-tenant read after the admin-policy scope';
end $$;
reset role;

-- 19. Apply the intake tenant-ownership trigger migration (20261026120000) and
--     prove a service-role insert inherits the tenant from the row's owner,
--     which auto_set_tenant_id() alone cannot do (auth.uid() is NULL under
--     service_role).
\i supabase/migrations/20261026120000_telemedicine_intake_tenant_ownership.sql

set role service_role;
do $$
declare
  v_case uuid := '55555555-5555-4555-8555-555555555555';
  v_tenant uuid;
begin
  insert into public.telemedicine_intake_cases (id, user_id, label)
  values (v_case, '00000000-0000-4000-8000-000000000012', 'service-role-intake');

  select tenant_id into v_tenant from public.telemedicine_intake_cases where id = v_case;
  if v_tenant is distinct from '11111111-1111-4111-8111-111111111111'::uuid then
    raise exception 'service-role intake insert did not inherit tenant A: got %', v_tenant;
  end if;

  insert into public.telemedicine_intake_messages (id, case_id, label)
  values ('66666666-6666-4666-8666-666666666666', v_case, 'service-role-message');

  select tenant_id into v_tenant from public.telemedicine_intake_messages
   where id = '66666666-6666-4666-8666-666666666666';
  if v_tenant is distinct from '11111111-1111-4111-8111-111111111111'::uuid then
    raise exception 'service-role intake message did not inherit tenant A: got %', v_tenant;
  end if;

  raise notice 'service-role intake insert inherits tenant from the row owner';
end $$;
reset role;

-- 20261026140000_scope_staff_intake_policies_to_tenant.sql is deliberately NOT
-- applied here: it is HELD pending owner sign-off (D1/D3), and exercising it
-- would change clinical access inside a harness that must only prove the
-- prepared migrations.

\echo 'RLS tenant-isolation harness completed: SEC-01 reproduced and repaired'
\echo 'Residual after the repair, in the CURRENT migration chain:'
\echo '  - products/order_items/gas_cylinders: "Admins full access ..." tests profiles.is_admin only, no tenant predicate'
\echo '    (open after 20261025120000 alone; demonstrated in step 14b: an admin reads AND writes another tenant order_items)'
\echo '    (closed by 20261026130000; proven in step 18: cross-tenant access denied, same-tenant admin access preserved)'
\echo '  - telemedicine_intake_cases/messages: staff read/update policies test role only, no tenant predicate'
\echo '    (still open; addressed by supabase/held/scope_staff_intake_policies_to_tenant.sql pending D1 and D3)'
\echo '  - "Public read products" / "queue_read_by_token" are dropped by 20261003160000 in source;'
\echo '    whether that migration is applied to any given environment is UNVERIFIED here.'
