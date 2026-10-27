-- 20261026130000_scope_admin_policies_to_tenant
--
-- PREPARED ONLY — NOT APPLIED TO ANY DATABASE.
--
-- The five `Admins full access …` policies are FOR ALL with no tenant predicate
-- and no role clause (=> PUBLIC), testing only profiles.is_admin. Permissive
-- policies OR together, so a correct `tenant_isolation` does not constrain them:
-- any tenant administrator can read and write every tenant's products,
-- order_items, gas_cylinders, orders and restaurants.
--
-- This migration scopes each policy to the caller's own tenant and to
-- `authenticated`:
--
--   TO authenticated
--   USING      (tenant_id = public.current_tenant_id()
--               and exists (select 1 from public.profiles p
--                            where p.id = auth.uid() and p.is_admin))
--   WITH CHECK (tenant_id = public.current_tenant_id()
--               and exists (select 1 from public.profiles p
--                            where p.id = auth.uid() and p.is_admin))
--
-- `TO authenticated` is mandatory, not cosmetic: the predicate now calls
-- public.current_tenant_id(), which `anon` deliberately cannot EXECUTE
-- (20260613104742_lock_down_auth_rls_helpers_anon_execute.sql). A policy left at
-- the implicit PUBLIC default would raise `permission denied for function
-- current_tenant_id()` for anonymous callers instead of denying cleanly.
--
-- This is a separate decision point: `platform_admin_bypass` is untouched, so
-- platform administrators keep cross-tenant reach. Tenant administrators are
-- assumed to be tenant-scoped; if some is_admin user must operate across tenant
-- boundaries, hold this migration until that is decided.
--
-- `Admins full access orders` (public.orders) and
-- `Admins full access restaurants` (public.restaurants) are OUTSIDE the ten-table
-- SEC-01 scope but share the identical defect class. A reviewer can drop those
-- two statements without affecting the other three.
--
-- ATOMICITY. A single `do` block, so the alterations and the self-check commit
-- or roll back together under every applier. IDEMPOTENT: ALTER POLICY is
-- idempotent, so re-running is a no-op. FAIL CLOSED: a missing expected policy
-- raises instead of being skipped.

do $$
declare
  v_i int;
  v_policy text;
  v_table text;
  v_missing text[] := array[]::text[];
  v_found int;
  r record;
  v_policies text[] := array[
    'Admins full access products',
    'Admins full access items',
    'Admins full access cylinders',
    'Admins full access orders',
    'Admins full access restaurants'
  ];
  v_tables text[] := array[
    'products',
    'order_items',
    'gas_cylinders',
    'orders',
    'restaurants'
  ];
begin
  for v_i in 1..array_length(v_policies, 1) loop
    v_policy := v_policies[v_i];
    v_table := v_tables[v_i];

    if not exists (
      select 1
      from pg_policies
      where schemaname = 'public'
        and tablename = v_table
        and policyname = v_policy
    ) then
      v_missing := v_missing || (v_table || '.' || v_policy);
    else
      execute format(
        'alter policy %I on public.%I to authenticated '
        'using (tenant_id = public.current_tenant_id() '
        '       and exists (select 1 from public.profiles p where p.id = auth.uid() and p.is_admin)) '
        'with check (tenant_id = public.current_tenant_id() '
        '       and exists (select 1 from public.profiles p where p.id = auth.uid() and p.is_admin))',
        v_policy, v_table
      );
      raise notice 'admin policy scoped to tenant: public.%.%', v_table, v_policy;
    end if;
  end loop;

  if array_length(v_missing, 1) is not null then
    raise exception 'expected admin policies are missing: % — refusing to leave a partial repair',
      array_to_string(v_missing, ', ');
  end if;

  -- Self-check in the same statement (same transaction) as the alterations.
  for r in
    select tablename, policyname, qual, with_check, roles
    from pg_policies
    where schemaname = 'public'
      and policyname = any (v_policies)
  loop
    if r.qual is null or position('current_tenant_id' in r.qual) = 0 then
      raise exception 'admin policy %.% no longer references current_tenant_id in USING', r.tablename, r.policyname;
    end if;
    if r.with_check is null or position('current_tenant_id' in r.with_check) = 0 then
      raise exception 'admin policy %.% no longer references current_tenant_id in WITH CHECK', r.tablename, r.policyname;
    end if;
    if r.roles is null
      or 'public' = any (r.roles)
      or 'anon' = any (r.roles)
      or not ('authenticated' = any (r.roles))
    then
      raise exception 'admin policy %.% has roles %, expected {authenticated}', r.tablename, r.policyname, r.roles;
    end if;
  end loop;

  select count(*) into v_found
  from pg_policies
  where schemaname = 'public'
    and policyname = any (v_policies)
    and roles = array['authenticated']::name[];

  if v_found <> array_length(v_policies, 1) then
    raise exception 'expected % admin policies scoped to authenticated, found %', array_length(v_policies, 1), v_found;
  end if;

  raise notice 'five admin policies scoped to tenant and self-checked';
end
$$;
