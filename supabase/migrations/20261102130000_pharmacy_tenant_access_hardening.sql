-- 20261102130000_pharmacy_tenant_access_hardening
--
-- Second pass over pharmacy row security after 20261102120000_pharmacy_policy_tenant_scope.
-- That migration removed the profiles.is_admin bypass. Reviewing the remaining
-- policies against the product requirements found six gaps it did not cover:
--
-- 1. `public_invite_lookup` on pharmacy_onboarding is a SELECT policy with no
--    tenant predicate and no role restriction, and the table is granted to
--    `anon`. Anyone holding the public anon key could read every pending
--    pharmacy invitation — including `invite_token`, `admin_email` and
--    `admin_name` — and redeem another pharmacy's invitation. Both invitation
--    pages read the table with the service role, so the policy protects no
--    flow and only widens exposure.
--
-- 2. `current_tenant_id()` reads `profiles.tenant_id` without consulting
--    `profiles.is_deleted`, so an archived account keeps its tenant's rows for
--    as long as a JWT lives. The same is true of `custom_access_token_hook`,
--    which re-mints the tenant claim from the deleted profile.
--
-- 3. Pharmacy membership is not `profiles.tenant_id`. A person can hold one
--    `pharmacy_user_settings` row per pharmacy and active
--    `staff_scope_assignments` at several facilities; the application's
--    workspace switch and `resolveSessionScope` already honour that, but row
--    security did not. A signed-in user working at a second pharmacy read
--    nothing there, and a staff row explicitly deactivated
--    (`pharmacy_user_settings.is_active = false`) did not withdraw access.
--    `public.pharmacy_caller_tenants()` is the single place that answers
--    "which pharmacy tenants may this caller see?" and every pharmacy policy
--    now asks it.
--
-- 4. Twenty-seven policies on pharmacy tables omitted `TO`, which defaults to
--    PUBLIC and therefore includes `anon`. Several of them call helper
--    functions whose EXECUTE is revoked from anon, so an anonymous query fails
--    with a permission error rather than returning no rows — fail-closed, but
--    an error an anonymous caller can provoke. All pharmacy policies are now
--    `TO authenticated`.
--
-- 5. `pharmacy_receipt_reprints` and `pharmacy_sale_idempotency` had row
--    security enabled and no policy at all: every non-service-role read was
--    denied. They now carry the same tenant policy as their siblings.
--
-- 6. `pharmacy_assert_actor` accepted a `profiles` row without checking
--    `is_deleted`, so a deleted account still counted as a member when no
--    pharmacy_settings row existed.
--
-- Deliberately not changed here:
--   * `complete_pharmacy_sale` is called by the hospital dispense route with
--     the clinician's id and a pharmacy tenant that is not the clinician's
--     tenant, so `pharmacy_assert_actor` would reject a legitimate flow. Its
--     caller already re-derives the tenant from the session, and pharmacy
--     sessions are refused for deactivated staff in `lib/auth.ts`.
--   * Storage has no policy on the private `pharmacy-imports` bucket, which
--     denies anon and authenticated outright. Signed URLs are issued per
--     tenant path by the service role.
--
-- This file is PREPARED ONLY. It is not applied anywhere by this change.

begin;

-- ---------------------------------------------------------------------------
-- 1. The pharmacy tenants a caller may act in.
--
-- SECURITY DEFINER because it reads membership tables that are themselves
-- row-secured; `auth.uid()` still resolves the caller from the request JWT.
-- Empty array for a deleted profile, a missing profile or an anonymous caller,
-- and an explicit `is_active = false` staff row always wins over the home
-- tenant pointer.
-- ---------------------------------------------------------------------------
create or replace function public.pharmacy_caller_tenants()
returns uuid[]
language sql
stable
security definer
set search_path to 'public'
as $function$
  with me as (
    select p.id, p.tenant_id
    from public.profiles p
    where p.id = auth.uid()
      and coalesce(p.is_deleted, false) = false
  ),
  staff as (
    select s.tenant_id, s.is_active
    from public.pharmacy_user_settings s
    join me on me.id = s.profile_id
  ),
  withdrawn as (
    select distinct s.tenant_id
    from staff s
    where s.is_active is false
  )
  select coalesce(array_agg(distinct allowed.tenant_id), '{}'::uuid[])
  from (
    select me.tenant_id
    from me
    where me.tenant_id is not null
    union
    select s.tenant_id
    from staff s
    where s.is_active is not false and s.tenant_id is not null
    union
    select a.tenant_id
    from public.staff_scope_assignments a
    join me on me.id = a.profile_id
    where a.is_active and a.tenant_id is not null
    union
    select st.tenant_id
    from public.staff_scope_assignments a
    join me on me.id = a.profile_id
    join public.pharmacy_stores st on st.id = a.site_id
    where a.is_active and st.tenant_id is not null
  ) allowed
  where allowed.tenant_id is not null
    and allowed.tenant_id not in (select w.tenant_id from withdrawn w);
$function$;

revoke all on function public.pharmacy_caller_tenants() from public;
grant execute on function public.pharmacy_caller_tenants() to authenticated;
grant execute on function public.pharmacy_caller_tenants() to service_role;

-- ---------------------------------------------------------------------------
-- 2. An archived profile is not a pharmacy member.
-- ---------------------------------------------------------------------------
create or replace function public.current_tenant_id()
returns uuid
language sql
stable
security definer
set search_path to 'public'
as $$
  select tenant_id
  from profiles
  where id = auth.uid()
    and coalesce(is_deleted, false) = false
  limit 1;
$$;

-- is_platform_admin() is the platform bypass every pharmacy policy now calls.
-- It read profiles.role with no is_deleted guard, so an archived platform
-- administrator kept platform reach for every request carrying a live JWT.
-- This narrows an existing grant; no caller gains access from it.
create or replace function public.is_platform_admin()
returns boolean
language sql
stable
security definer
set search_path to 'public'
as $$
  select exists (
    select 1 from public.profiles
    where id = auth.uid()
      and role = 'platform_admin'
      and coalesce(is_deleted, false) = false
  );
$$;

-- CREATE OR REPLACE drops a SET clause the previous definition carried, so the
-- search_path pinned by 20261003150000 must be restated here or this recreation
-- silently un-pins it.
create or replace function public.custom_access_token_hook(event jsonb)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_tenant_id uuid;
begin
  select tenant_id into v_tenant_id
  from public.profiles
  where id = (event->>'user_id')::uuid
    and coalesce(is_deleted, false) = false;

  if v_tenant_id is not null then
    return jsonb_set(event, '{claims,tenant_id}', to_jsonb(v_tenant_id::text));
  end if;
  return event;
end;
$$;

create or replace function public.pharmacy_assert_actor(p_tenant_id uuid, p_actor_id uuid)
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  if p_tenant_id is null then
    raise exception 'PERMISSION: tenant is required';
  end if;
  if p_actor_id is null then
    raise exception 'PERMISSION: an acting user is required';
  end if;
  -- A pharmacy staff row wins when there is one: it carries the activation
  -- flag the portal and mobile auth enforce. Checking profiles first let a
  -- deactivated pharmacist through on tenant_id alone.
  if exists (
    select 1 from pharmacy_user_settings
    where profile_id = p_actor_id and tenant_id = p_tenant_id
  ) then
    if exists (
      select 1 from pharmacy_user_settings
      where profile_id = p_actor_id and tenant_id = p_tenant_id and is_active
    ) then
      return;
    end if;
    raise exception 'PERMISSION: actor % is deactivated for this pharmacy', p_actor_id;
  end if;
  if exists (
    select 1 from profiles
    where id = p_actor_id and tenant_id = p_tenant_id
      and coalesce(is_deleted, false) = false
  ) then
    return;
  end if;
  raise exception 'PERMISSION: actor % is not a member of this pharmacy', p_actor_id;
end;
$function$;

-- ---------------------------------------------------------------------------
-- 3. The invitation table is not public.
-- ---------------------------------------------------------------------------
drop policy if exists "public_invite_lookup" on public.pharmacy_onboarding;
revoke all on table public.pharmacy_onboarding from anon;

-- ---------------------------------------------------------------------------
-- 4. Every pharmacy policy scoped to the caller's pharmacy tenants.
--
-- Standard predicate for a table whose tenant column is `tenant_id`.
-- ---------------------------------------------------------------------------
do $$
declare
  v_policies text[] := array[
    'pharmacy_audit_logs_tenant_isolation',
    'pharmacy_clients_tenant_isolation',
    'pharmacy_customers_tenant_isolation',
    'pharmacy_inquiries_tenant_isolation',
    'pharmacy_order_items_tenant_isolation',
    'pharmacy_orders_tenant_isolation',
    'pharmacy_product_batches_tenant_isolation',
    'pharmacy_product_packages_tenant_isolation',
    'pharmacy_products_tenant_isolation',
    'pharmacy_purchase_order_items_tenant_isolation',
    'pharmacy_purchase_orders_tenant_isolation',
    'pharmacy_settings_tenant_isolation',
    'pharmacy_stock_adjustments_tenant_isolation',
    'pharmacy_suppliers_tenant_isolation',
    'pharmacy_transaction_edits_tenant_isolation',
    'pharmacy_transaction_items_tenant_isolation',
    'pharmacy_transactions_tenant_isolation',
    'pharmacy_user_settings_tenant_isolation',
    'pharmacy_cart_items_tenant',
    'pharmacy_carts_tenant',
    'pharmacy_cashier_sessions_tenant',
    'pharmacy_pos_sale_items_tenant',
    'pharmacy_pos_sale_items_tenant_isolation',
    'pharmacy_pos_sales_tenant',
    'pharmacy_pos_sales_tenant_isolation',
    'pharmacy_refunds_tenant',
    'pharmacy_stock_transfers_tenant_isolation',
    'pharmacy_stores_tenant_isolation',
    'tenant_isolation',
    -- `20260921120000` created these five without a TO clause, so they default
    -- to PUBLIC; the self-check below aborts until they are scoped here.
    'pharmacy_purchases_tenant_isolation',
    'pharmacy_purchase_items_tenant_isolation',
    'pharmacy_purchase_idempotency_tenant_isolation',
    'pharmacy_purchase_attachments_tenant_isolation',
    'pharmacy_supplier_returns_tenant_isolation'
  ];
  v_tables text[] := array[
    'pharmacy_audit_logs',
    'pharmacy_clients',
    'pharmacy_customers',
    'pharmacy_inquiries',
    'pharmacy_order_items',
    'pharmacy_orders',
    'pharmacy_product_batches',
    'pharmacy_product_packages',
    'pharmacy_products',
    'pharmacy_purchase_order_items',
    'pharmacy_purchase_orders',
    'pharmacy_settings',
    'pharmacy_stock_adjustments',
    'pharmacy_suppliers',
    'pharmacy_transaction_edits',
    'pharmacy_transaction_items',
    'pharmacy_transactions',
    'pharmacy_user_settings',
    'pharmacy_cart_items',
    'pharmacy_carts',
    'pharmacy_cashier_sessions',
    'pharmacy_pos_sale_items',
    'pharmacy_pos_sale_items',
    'pharmacy_pos_sales',
    'pharmacy_pos_sales',
    'pharmacy_refunds',
    'pharmacy_stock_transfers',
    'pharmacy_stores',
    'pharmacy_stores',
    'pharmacy_purchases',
    'pharmacy_purchase_items',
    'pharmacy_purchase_idempotency',
    'pharmacy_purchase_attachments',
    'pharmacy_supplier_returns'
  ];
  -- `tenant_isolation` also exists on non-pharmacy tables; the table name in
  -- the ALTER is what keeps this list scoped to the four pharmacy tables below.
  v_extra_tables text[] := array[
    'pharmacy_credit_ledger',
    'pharmacy_expenses',
    'pharmacy_import_sessions',
    'pharmacy_staff_permissions'
  ];
  v_predicate constant text :=
    'tenant_id = any (public.pharmacy_caller_tenants()) or public.is_platform_admin()';
  v_missing text[] := '{}';
  v_altered integer := 0;
  i integer;
  t text;
begin
  if array_length(v_policies, 1) <> array_length(v_tables, 1) then
    raise exception 'pharmacy policy list is misaligned: % policies, % tables',
      array_length(v_policies, 1), array_length(v_tables, 1);
  end if;

  for i in 1..array_length(v_policies, 1) loop
    if not exists (
      select 1 from pg_policies
      where schemaname = 'public'
        and tablename = v_tables[i]
        and policyname = v_policies[i]
    ) then
      v_missing := v_missing || (v_tables[i] || '.' || v_policies[i]);
      continue;
    end if;
    execute format(
      'alter policy %I on public.%I to authenticated using (%s) with check (%s)',
      v_policies[i], v_tables[i], v_predicate, v_predicate
    );
    v_altered := v_altered + 1;
  end loop;

  foreach t in array v_extra_tables loop
    if not exists (
      select 1 from pg_policies
      where schemaname = 'public' and tablename = t and policyname = 'tenant_isolation'
    ) then
      v_missing := v_missing || (t || '.tenant_isolation');
      continue;
    end if;
    execute format(
      'alter policy %I on public.%I to authenticated using (%s) with check (%s)',
      'tenant_isolation', t, v_predicate, v_predicate
    );
    v_altered := v_altered + 1;
  end loop;

  if array_length(v_missing, 1) > 0 then
    raise exception 'expected pharmacy policies are missing: %', array_to_string(v_missing, ', ');
  end if;
  if v_altered <> array_length(v_policies, 1) + array_length(v_extra_tables, 1) then
    raise exception 'only % of % pharmacy policies were scoped', v_altered,
      array_length(v_policies, 1) + array_length(v_extra_tables, 1);
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- 5. Policies that keep their own branch beside the tenant predicate.
-- ---------------------------------------------------------------------------
alter policy "pharmacy_notifications_own_or_admin" on public.pharmacy_notifications
  to authenticated
  using (
    profile_id = auth.uid()
    or tenant_id = any (public.pharmacy_caller_tenants())
    or public.is_platform_admin()
  )
  with check (
    profile_id = auth.uid()
    or tenant_id = any (public.pharmacy_caller_tenants())
    or public.is_platform_admin()
  );

-- A customer's own standing order, and the pharmacy's view of it.
alter policy "tenant_pharmacy_orders" on public.pharmacy_orders
  to authenticated
  using (
    tenant_id = any (public.pharmacy_caller_tenants())
    or patient_id = auth.uid()
    or public.is_platform_admin()
  )
  with check (
    tenant_id = any (public.pharmacy_caller_tenants())
    or patient_id = auth.uid()
    or public.is_platform_admin()
  );

alter policy "tenant_pharmacy_inventory" on public.pharmacy_network_inventory
  to authenticated
  using (
    pharmacy_tenant_id = any (public.pharmacy_caller_tenants())
    or public.is_platform_admin()
  )
  with check (
    pharmacy_tenant_id = any (public.pharmacy_caller_tenants())
    or public.is_platform_admin()
  );

alter policy "tenant_pharmacy_profiles" on public.pharmacy_profiles
  to authenticated
  using (
    tenant_id = any (public.pharmacy_caller_tenants())
    or public.is_platform_admin()
  )
  with check (
    tenant_id = any (public.pharmacy_caller_tenants())
    or public.is_platform_admin()
  );

alter policy "pharmacy_custom_domains_tenant_read" on public.pharmacy_custom_domains
  to authenticated
  using (
    tenant_id = any (public.pharmacy_caller_tenants())
    or public.is_platform_admin()
  );

alter policy "pharmacy_admin_own" on public.pharmacy_onboarding
  to authenticated
  using (tenant_id = any (public.pharmacy_caller_tenants()));

alter policy "pharmacy_user_update_onboarding" on public.pharmacy_onboarding
  to authenticated
  using (tenant_id = any (public.pharmacy_caller_tenants()))
  with check (tenant_id = any (public.pharmacy_caller_tenants()));

-- ---------------------------------------------------------------------------
-- 6. Platform-only and parent-scoped policies: no expression change, but they
--    must not be reachable by anon.
-- ---------------------------------------------------------------------------
alter policy "platform_admin_full" on public.pharmacy_onboarding
  to authenticated
  using (public.is_platform_admin());

alter policy "platform_admin_bypass" on public.pharmacy_stores
  to authenticated
  using (public.is_platform_admin());

alter policy "platform_admin_pharmacy_inventory" on public.pharmacy_network_inventory
  to authenticated
  using (public.is_platform_admin());

alter policy "platform_admin_pharmacy_profiles" on public.pharmacy_profiles
  to authenticated
  using (public.is_platform_admin());

alter policy "pharmacy_custom_domains_platform_admin" on public.pharmacy_custom_domains
  to authenticated
  using (public.is_platform_admin())
  with check (public.is_platform_admin());

-- The two transfer child tables have no tenant column of their own, so their
-- predicate follows the transfer header. It still called the single-tenant
-- current_tenant_id(), which would have shown a multi-pharmacy user the
-- transfer but not its lines.
alter policy "pharmacy_stock_transfer_item_allocations_via_parent"
  on public.pharmacy_stock_transfer_item_allocations
  to authenticated
  using (
    public.is_platform_admin()
    or exists (
      select 1
      from public.pharmacy_stock_transfer_items ti
      join public.pharmacy_stock_transfers tr on tr.id = ti.transfer_id
      where ti.id = pharmacy_stock_transfer_item_allocations.transfer_item_id
        and tr.tenant_id = any (public.pharmacy_caller_tenants())
    )
  )
  with check (
    public.is_platform_admin()
    or exists (
      select 1
      from public.pharmacy_stock_transfer_items ti
      join public.pharmacy_stock_transfers tr on tr.id = ti.transfer_id
      where ti.id = pharmacy_stock_transfer_item_allocations.transfer_item_id
        and tr.tenant_id = any (public.pharmacy_caller_tenants())
    )
  );

alter policy "pharmacy_stock_transfer_items_via_parent"
  on public.pharmacy_stock_transfer_items
  to authenticated
  using (
    public.is_platform_admin()
    or exists (
      select 1
      from public.pharmacy_stock_transfers tr
      where tr.id = pharmacy_stock_transfer_items.transfer_id
        and tr.tenant_id = any (public.pharmacy_caller_tenants())
    )
  )
  with check (
    public.is_platform_admin()
    or exists (
      select 1
      from public.pharmacy_stock_transfers tr
      where tr.id = pharmacy_stock_transfer_items.transfer_id
        and tr.tenant_id = any (public.pharmacy_caller_tenants())
    )
  );

-- ---------------------------------------------------------------------------
-- 7. Tables that had row security and no policy.
-- ---------------------------------------------------------------------------
drop policy if exists "pharmacy_receipt_reprints_tenant_isolation"
  on public.pharmacy_receipt_reprints;
create policy "pharmacy_receipt_reprints_tenant_isolation"
  on public.pharmacy_receipt_reprints
  to authenticated
  using (
    tenant_id = any (public.pharmacy_caller_tenants())
    or public.is_platform_admin()
  )
  with check (
    tenant_id = any (public.pharmacy_caller_tenants())
    or public.is_platform_admin()
  );

drop policy if exists "pharmacy_sale_idempotency_tenant_isolation"
  on public.pharmacy_sale_idempotency;
create policy "pharmacy_sale_idempotency_tenant_isolation"
  on public.pharmacy_sale_idempotency
  to authenticated
  using (
    tenant_id = any (public.pharmacy_caller_tenants())
    or public.is_platform_admin()
  )
  with check (
    tenant_id = any (public.pharmacy_caller_tenants())
    or public.is_platform_admin()
  );

-- ---------------------------------------------------------------------------
-- 8. Self-check. Anything left open aborts the whole migration.
-- ---------------------------------------------------------------------------
do $$
declare
  v_open text[];
  v_wide text[];
begin
  select coalesce(array_agg(p.tablename || '.' || p.policyname), '{}')
  into v_open
  from pg_policies p
  where p.schemaname = 'public'
    and p.tablename like 'pharmacy\_%'
    and (
      'public' = any (p.roles)
      or 'anon' = any (p.roles)
    );

  if array_length(v_open, 1) > 0 then
    raise exception 'pharmacy policies still reachable by anon or PUBLIC: %',
      array_to_string(v_open, ', ');
  end if;

  select coalesce(array_agg(p.tablename || '.' || p.policyname), '{}')
  into v_wide
  from pg_policies p
  where p.schemaname = 'public'
    and p.tablename like 'pharmacy\_%'
    and (
      coalesce(p.qual, '') like '%is_admin%'
      or coalesce(p.with_check, '') like '%is_admin%'
      or coalesce(p.qual, '') like '%same_tenant%'
      or coalesce(p.with_check, '') like '%same_tenant%'
      or coalesce(p.qual, '') like '%current_tenant_id%'
      or coalesce(p.with_check, '') like '%current_tenant_id%'
      or coalesce(p.qual, '') like '%''platform_admin''%'
      or coalesce(p.with_check, '') like '%''platform_admin''%'
    );

  if array_length(v_wide, 1) > 0 then
    raise exception 'pharmacy policies still use a non-tenant predicate: %',
      array_to_string(v_wide, ', ');
  end if;

  if not exists (
    select 1 from pg_proc pr
    join pg_namespace n on n.oid = pr.pronamespace
    where n.nspname = 'public'
      and pr.proname = 'pharmacy_caller_tenants'
      and pr.prosecdef
  ) then
    raise exception 'pharmacy_caller_tenants() is missing or is not security definer';
  end if;

  if has_function_privilege('anon', 'public.pharmacy_caller_tenants()', 'execute') then
    raise exception 'anon can execute pharmacy_caller_tenants()';
  end if;
end
$$;

commit;
