-- 20261102120000_pharmacy_policy_tenant_scope
--
-- PREPARED ONLY — NOT APPLIED TO ANY DATABASE.
--
-- Nineteen `pharmacy_*_tenant_isolation` policies (and
-- `pharmacy_notifications_own_or_admin`) are permissive policies of the shape
--
--   USING (tenant_id = (select tenant_id from profiles where id = auth.uid())
--          OR (select is_admin from profiles where id = auth.uid()) = true)
--
-- `profiles.is_admin` marks a tenant administrator; it is not the platform
-- administrator flag. `profiles.role = 'platform_admin'` is. Because the policy
-- branches on is_admin alone — with no tenant predicate on that branch — any
-- tenant administrator can read and write every other tenant's pharmacy rows
-- through PostgREST with their own JWT and the public anon key. This is the same
-- defect class 20261026130000_scope_admin_policies_to_tenant repaired for the
-- ten SEC-01 tables; the pharmacy tables were outside that scope.
--
-- The repair keeps platform support reach and removes the tenant bypass:
--
--   TO authenticated
--   USING      (tenant_id = public.current_tenant_id() or public.is_platform_admin())
--   WITH CHECK (tenant_id = public.current_tenant_id() or public.is_platform_admin())
--
-- `TO authenticated` is mandatory. The predicate calls
-- public.current_tenant_id(), which `anon` deliberately cannot execute
-- (20260613104742_lock_down_auth_rls_helpers_anon_execute.sql); a policy left at
-- the implicit PUBLIC default would raise `permission denied for function` for
-- anonymous callers instead of denying cleanly. The policies carried no WITH
-- CHECK before, so INSERT/UPDATE were checked with the USING expression; making
-- it explicit keeps that behaviour while the expression is now tenant-scoped.
--
-- pharmacy_notifications_own_or_admin keeps its own-row branch, which is a
-- personal-inbox rule rather than a tenant bypass, and gains the same tenant
-- and platform branches.
--
-- DECISION POINT: a tenant administrator is assumed to be tenant-scoped, exactly
-- as decided for the SEC-01 repair. If some is_admin user must operate across
-- pharmacy tenants, that requirement has to be expressed as role
-- 'platform_admin', not by widening this predicate back.
--
-- ATOMICITY. One `do` block, so every alteration and the self-check commit or
-- roll back together under every applier. IDEMPOTENT: ALTER POLICY is
-- idempotent, so a replay is a no-op. FAIL CLOSED: a missing expected policy, or
-- any pharmacy policy still testing profiles.is_admin, raises instead of
-- leaving a partial repair.

do $$
declare
  v_i int;
  v_missing text[] := array[]::text[];
  v_altered int;
  r record;
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
    'pharmacy_user_settings_tenant_isolation'
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
    'pharmacy_user_settings'
  ];
begin
  if array_length(v_policies, 1) <> array_length(v_tables, 1) then
    raise exception 'policy/table arrays are misaligned — refusing to scope the wrong policy';
  end if;

  for v_i in 1..array_length(v_policies, 1) loop
    if not exists (
      select 1
      from pg_policies
      where schemaname = 'public'
        and tablename = v_tables[v_i]
        and policyname = v_policies[v_i]
    ) then
      v_missing := v_missing || (v_tables[v_i] || '.' || v_policies[v_i]);
    else
      execute format(
        'alter policy %I on public.%I to authenticated '
        'using (tenant_id = public.current_tenant_id() or public.is_platform_admin()) '
        'with check (tenant_id = public.current_tenant_id() or public.is_platform_admin())',
        v_policies[v_i], v_tables[v_i]
      );
      raise notice 'pharmacy policy scoped to tenant: public.%.%', v_tables[v_i], v_policies[v_i];
    end if;
  end loop;

  if not exists (
    select 1
    from pg_policies
    where schemaname = 'public'
      and tablename = 'pharmacy_notifications'
      and policyname = 'pharmacy_notifications_own_or_admin'
  ) then
    v_missing := v_missing || 'pharmacy_notifications.pharmacy_notifications_own_or_admin';
  else
    execute
      'alter policy "pharmacy_notifications_own_or_admin" on public.pharmacy_notifications to authenticated '
      'using (profile_id = auth.uid() or tenant_id = public.current_tenant_id() or public.is_platform_admin()) '
      'with check (profile_id = auth.uid() or tenant_id = public.current_tenant_id() or public.is_platform_admin())';
    raise notice 'pharmacy policy scoped to tenant: public.pharmacy_notifications.pharmacy_notifications_own_or_admin';
  end if;

  if array_length(v_missing, 1) is not null then
    raise exception 'expected pharmacy policies are missing: % — refusing to leave a partial repair',
      array_to_string(v_missing, ', ');
  end if;

  -- Self-check in the same statement (same transaction) as the alterations.
  for r in
    select tablename, policyname, qual, with_check, roles
    from pg_policies
    where schemaname = 'public'
      and (tablename = any (v_tables) or tablename = 'pharmacy_notifications')
      and policyname = any (v_policies || array['pharmacy_notifications_own_or_admin'])
  loop
    if r.qual is null
      or position('current_tenant_id' in r.qual) = 0
      or position('is_platform_admin' in r.qual) = 0
    then
      raise exception 'pharmacy policy %.% is still not tenant-scoped in USING (%)',
        r.tablename, r.policyname, r.qual;
    end if;
    if r.with_check is null
      or position('current_tenant_id' in r.with_check) = 0
      or position('is_platform_admin' in r.with_check) = 0
    then
      raise exception 'pharmacy policy %.% is still not tenant-scoped in WITH CHECK (%)',
        r.tablename, r.policyname, r.with_check;
    end if;
    if r.roles is null
      or 'public' = any (r.roles)
      or 'anon' = any (r.roles)
      or not ('authenticated' = any (r.roles))
    then
      raise exception 'pharmacy policy %.% has roles %, expected {authenticated}',
        r.tablename, r.policyname, r.roles;
    end if;
  end loop;

  select count(*) into v_altered
  from pg_policies
  where schemaname = 'public'
    and (tablename = any (v_tables) or tablename = 'pharmacy_notifications')
    and policyname = any (v_policies || array['pharmacy_notifications_own_or_admin'])
    and roles = array['authenticated']::name[];

  if v_altered <> array_length(v_policies, 1) + 1 then
    raise exception 'expected % pharmacy policies scoped to authenticated, found %',
      array_length(v_policies, 1) + 1, v_altered;
  end if;

  -- No pharmacy policy anywhere may keep an unscoped tenant-administrator
  -- branch. `is_platform_admin` does not contain the substring `is_admin`, so
  -- this cannot be satisfied by the platform branch.
  for r in
    select tablename, policyname
    from pg_policies
    where schemaname = 'public'
      and tablename like 'pharmacy\_%'
      and (coalesce(qual, '') like '%is_admin%' or coalesce(with_check, '') like '%is_admin%')
  loop
    raise exception 'pharmacy policy %.% still tests profiles.is_admin — a tenant administrator would bypass tenant isolation',
      r.tablename, r.policyname;
  end loop;

  raise notice '% pharmacy policies scoped to tenant and self-checked', v_altered;
end
$$;
