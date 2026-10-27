-- 20261025120000_tenant_isolation_policy_repair
--
-- PREPARED ONLY — NOT APPLIED TO ANY DATABASE.
--
-- Repairs the ten self-referential `tenant_isolation` policies catalogued as
-- SEC-01 in docs/audits/PRODUCTION_READINESS_PROGRAMME_2026-10-24.md.
--
-- The defect: each policy is declared `FOR ALL` with a correlated subquery that
-- selects the row's own column, so the predicate reduces to `tenant_id = tenant_id`.
--
--   CREATE POLICY "tenant_isolation" ON public.encounters
--     USING (("tenant_id" = ( SELECT "encounters"."tenant_id"
--        FROM public.profiles WHERE profiles.id = auth.uid() )));
--
-- For any authenticated user who has a profile row the predicate is true for
-- every row of the table, in every tenant, for SELECT/INSERT/UPDATE/DELETE (a
-- FOR ALL policy with no WITH CHECK applies USING to written rows as well).
--
-- The repair replaces the self-reference with the helper that policies created
-- by later migrations already use, adds an explicit WITH CHECK so writes are
-- constrained as well as reads, and scopes the policy to the `authenticated`
-- role:
--
--   TO         authenticated
--   USING      (tenant_id = public.current_tenant_id())
--   WITH CHECK (tenant_id = public.current_tenant_id())
--
-- The helper comes from 20260613104631_emergency_auth_rls_convergence.sql:
-- SECURITY DEFINER, STABLE, search_path pinned to public, resolving
-- profiles.tenant_id for auth.uid(), LIMIT 1. The command stays FOR ALL and the
-- per-table `platform_admin_bypass`, admin and owner-scoped policies are left in
-- place, so platform administrators and the existing customer-facing read
-- policies keep working.
--
-- WHY `TO authenticated` IS PART OF THE REPAIR. The policies as written have no
-- role clause, which means PUBLIC — including `anon`. But anon deliberately has
-- no EXECUTE on current_tenant_id(): 20260613104742_lock_down_auth_rls_helpers_anon_execute.sql
-- revokes it, and 20260613104631 grants it only to authenticated and
-- service_role. Once the predicate calls the helper, a policy left at the
-- implicit PUBLIC default would stop denying and start erroring: PostgreSQL
-- raises `permission denied for function current_tenant_id()` during policy
-- evaluation. That matters most for `products`, which holds GRANT ALL for anon.
-- Tenant isolation is meaningless for a caller with no tenant, so the policy is
-- scoped to authenticated and anon keeps exactly the access its own policies
-- grant. Note that this trap is created by the repair itself: the original
-- policies inline the profile subquery and therefore deny anon cleanly with zero
-- rows. The self-check below fails the migration if the role clause is missing.
--
-- FAIL CLOSED ON A MISSING POLICY. All ten policies are expected to exist in
-- every environment, because they are part of the canonical snapshot that fresh
-- environments are built from. If one is absent the migration raises instead of
-- skipping it: a partial repair that silently leaves a table without a tenant
-- predicate is worse than a failed migration. Re-running the file is still safe
-- (ALTER POLICY is idempotent), so a failure is repaired by fixing the cause and
-- applying again.
--
-- ATOMICITY. The alterations and the verification are deliberately a SINGLE `do`
-- block, so they run as one statement and therefore commit or roll back
-- together under every applier: psql autocommit, `psql -v ON_ERROR_STOP=1 -f`
-- (the CI path), the harness's `\i`, and `supabase db push`. Explicit
-- `begin;`/`commit;` is deliberately NOT used — the Supabase CLI already wraps
-- each migration file in a transaction, and a COMMIT inside the file would end
-- that wrapper early and let later statements run outside it. Within one
-- transaction the self-check reads the catalog after the ALTERs, as intended.
--
-- ORDERING NOTE. Do not apply this before every writer is known to supply a
-- tenant. WITH CHECK rejects rows whose tenant_id is neither supplied nor
-- derivable. The auto_set_tenant_id() BEFORE INSERT trigger covers all ten of
-- these tables: it fills NEW.tenant_id from the caller's profile when the value
-- is NULL. Under a service-role client there is no JWT subject, the trigger
-- leaves tenant_id NULL, and that row then becomes invisible to every
-- authenticated reader. That is a product question (who owns a patient-initiated
-- record), not something this migration can answer.
--
-- TELEMEDICINE INTAKE IS THE SHARPEST CASE, because it is patient-initiated and
-- because the repair does not constrain it at all. Both tables also carry
-- permissive patient/staff policies, and permissive policies are OR'd for USING
-- and for WITH CHECK:
--
--   * INSERT — telemedicine_intake_cases_user_insert checks only
--     auth.role() = 'authenticated' AND user_id = auth.uid(). It contains no
--     tenant clause, so it satisfies WITH CHECK on its own even when this
--     policy's WITH CHECK is false or NULL. A patient can therefore create an
--     intake case with any tenant_id, including one belonging to another
--     hospital, or with NULL when auto_set_tenant_id() cannot derive it.
--   * SELECT — telemedicine_intake_cases_user_read and
--     telemedicine_intake_messages_user_read check the caller's profile role
--     only, so every clinician reads every tenant's cases and messages. A
--     NULL-tenant case stays visible to staff, so this repair does not create an
--     invisible queue here; it also does not separate tenants here.
--
-- The decision required before applying this to a real environment is therefore
-- who owns a patient-initiated record and how that is enforced: pin the tenant
-- at intake from the patient's profile, from the hospital the intake link was
-- issued for, or from a service-role route that sets tenant_id explicitly — and
-- then add a tenant predicate to the staff policies if cross-tenant clinical
-- access is not intended. That is a product and clinical-access decision, not
-- something this migration can make. The harness demonstrates both directions
-- (step 14b) instead of implying the ten tables are isolated.
--
-- PRE-FLIGHT (read-only, run against the target before applying; none of these
-- were executed while writing this migration). A non-zero null_tenant count on
-- `products` means catalogue rows disappear for authenticated users once
-- "Public read products" is dropped by 20261003160000_profiles_privileged_columns_guard.sql:
--
--   select 'products' as t, count(*) filter (where tenant_id is null) as null_tenant,
--          count(*) as total from public.products
--   union all select 'order_items', count(*) filter (where tenant_id is null), count(*) from public.order_items
--   union all select 'gas_cylinders', count(*) filter (where tenant_id is null), count(*) from public.gas_cylinders
--   union all select 'encounter_orders', count(*) filter (where tenant_id is null), count(*) from public.encounter_orders
--   union all select 'encounters', count(*) filter (where tenant_id is null), count(*) from public.encounters
--   union all select 'hospital_drug_orders', count(*) filter (where tenant_id is null), count(*) from public.hospital_drug_orders
--   union all select 'vitals', count(*) filter (where tenant_id is null), count(*) from public.vitals
--   union all select 'sync_conflicts', count(*) filter (where tenant_id is null), count(*) from public.sync_conflicts
--   union all select 'telemedicine_intake_cases', count(*) filter (where tenant_id is null), count(*) from public.telemedicine_intake_cases
--   union all select 'telemedicine_intake_messages', count(*) filter (where tenant_id is null), count(*) from public.telemedicine_intake_messages;
--
-- Also check for orphaned tenancy (a tenant_id with no tenants row), which the
-- predicate treats as simply not-equal:
--
--   select count(*) from public.products p
--    where p.tenant_id is not null
--      and not exists (select 1 from public.tenants t where t.id = p.tenant_id);
--
-- VERIFICATION. Run scripts/db-tests/run-rls-isolation.sh (requires Docker, a
-- disposable PostgreSQL 16 and the psql/pg_isready client tools). The harness is
-- the only place the RLS behaviour is asserted; it executed and passed on a
-- disposable PostgreSQL 16 database on 2026-10-25. Production remains
-- unverified. Applying this file proves nothing about production on its own.
--
-- WHERE THIS MIGRATION RUNS. It is never applied to a remote database
-- automatically. `.github/workflows/db-production.yml` is the only path to
-- production and is manual: workflow_dispatch, an explicit PRODUCTION
-- confirmation, a RECONCILED attestation and a pinned 40-character SHA, with
-- `supabase db push` behind two explicit booleans. It IS applied automatically
-- by `.github/workflows/deploy.yml` to the disposable Supabase stack that job
-- starts on the runner (127.0.0.1:54322) as part of the post-snapshot migration
-- loop — so CI will execute this DDL on a real schema on the next push to main,
-- and any failure there stops the release. That is intended, and it is not
-- evidence that the migration has been proven.

do $$
declare
  v_table text;
  v_missing text[] := array[]::text[];
  v_tables text[] := array[
    'encounter_orders',
    'encounters',
    'gas_cylinders',
    'hospital_drug_orders',
    'order_items',
    'products',
    'sync_conflicts',
    'telemedicine_intake_cases',
    'telemedicine_intake_messages',
    'vitals'
  ];
  v_found int;
  r record;
begin
  foreach v_table in array v_tables loop
    if not exists (
      select 1
      from pg_policies
      where schemaname = 'public'
        and tablename = v_table
        and policyname = 'tenant_isolation'
    ) then
      v_missing := v_missing || v_table;
    else
      execute format(
        'alter policy "tenant_isolation" on public.%I to authenticated '
        'using (tenant_id = public.current_tenant_id()) '
        'with check (tenant_id = public.current_tenant_id())',
        v_table
      );
      raise notice 'tenant_isolation repaired on public.%', v_table;
    end if;
  end loop;

  -- Fail closed. Proceeding past this point would leave a table with no tenant
  -- predicate at all while reporting a successful migration.
  if array_length(v_missing, 1) is not null then
    raise exception 'tenant_isolation is absent on public.% — refusing to leave a partial repair. Restore the upstream policy (supabase/bootstrap/canonical_public_schema.sql) or exclude the table deliberately, then re-run.',
      array_to_string(v_missing, ', ');
  end if;

  -- Self-check, in the same statement (and therefore the same transaction) as
  -- the alterations above, so a failure here rolls them back.
  --
  -- Four properties per policy: it no longer repeats its own column; it actually
  -- calls the helper (without this a `USING (true)` mistake would pass every
  -- other check); it constrains writes as well as reads; and it is scoped to
  -- authenticated rather than PUBLIC.
  for r in
    select tablename, qual, with_check, roles
    from pg_policies
    where schemaname = 'public'
      and policyname = 'tenant_isolation'
      and tablename = any (v_tables)
  loop
    if r.qual is null then
      raise exception 'tenant_isolation on public.% has no USING predicate after repair', r.tablename;
    end if;
    if position(r.tablename || '.tenant_id' in r.qual) > 0
      or position('tenant_id = tenant_id' in r.qual) > 0
    then
      raise exception 'tenant_isolation on public.% is still self-referential: %', r.tablename, r.qual;
    end if;
    if position('current_tenant_id' in r.qual) = 0 then
      raise exception 'tenant_isolation on public.% does not reference public.current_tenant_id(): %', r.tablename, r.qual;
    end if;
    if r.with_check is null then
      raise exception 'tenant_isolation on public.% has no WITH CHECK after repair', r.tablename;
    end if;
    if position('current_tenant_id' in r.with_check) = 0 then
      raise exception 'tenant_isolation on public.% has a WITH CHECK that does not reference public.current_tenant_id(): %', r.tablename, r.with_check;
    end if;
    if r.roles is null
      or 'public' = any (r.roles)
      or 'anon' = any (r.roles)
    then
      raise exception 'tenant_isolation on public.% still applies to % ; it must be scoped TO authenticated because anon has no EXECUTE on public.current_tenant_id()',
        r.tablename, r.roles;
    end if;
    if not ('authenticated' = any (r.roles)) then
      raise exception 'tenant_isolation on public.% does not apply to authenticated: %', r.tablename, r.roles;
    end if;
  end loop;

  select count(*) into v_found
  from pg_policies
  where schemaname = 'public'
    and policyname = 'tenant_isolation'
    and tablename = any (v_tables);

  if v_found <> 10 then
    raise exception 'expected 10 tenant_isolation policies after the repair, found %', v_found;
  end if;

  raise notice 'tenant isolation repaired and self-checked on all ten tables';
end
$$;

-- ROLLBACK TEMPLATE (per table, restores the pre-repair definition verbatim).
-- Kept as a comment so it can never run by accident; the authoritative previous
-- text is in supabase/bootstrap/canonical_public_schema.sql.
--
-- `to public` is required in the rollback: ALTER POLICY leaves clauses it does
-- not mention unchanged, so omitting it would keep the `authenticated` scope.
--
-- alter policy "tenant_isolation" on public.<table>
--   to public
--   using (("tenant_id" = ( select "<table>"."tenant_id" from public.profiles
--            where profiles.id = auth.uid() )));
