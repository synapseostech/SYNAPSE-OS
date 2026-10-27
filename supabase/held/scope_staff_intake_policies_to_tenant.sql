-- HELD — DO NOT APPLY WITHOUT OWNER SIGN-OFF.
-- This changes clinical access. It also hides any existing telemedicine_intake_*
-- row whose tenant_id IS NULL from clinical staff until the NULL-tenant backlog
-- is resolved. Required decisions: (D1) cross-tenant clinical access policy;
-- (D3) backfill source for NULL-tenant rows.
--
-- scope_staff_intake_policies_to_tenant (was 20261026140000)
--
-- PREPARED ONLY — NOT APPLIED TO ANY DATABASE. This file lives in supabase/held/,
-- OUTSIDE supabase/migrations/, so deploy.yml's post-snapshot migration loop and
-- `supabase db push` cannot pick it up. It stays inert until the decisions above
-- are signed off, then it must be moved back into supabase/migrations/ with a
-- fresh timestamp prefix.
--
-- The four telemedicine staff policies test the caller's profile role only, with
-- no tenant predicate, so every clinician reads and updates every tenant's
-- intake cases and messages, and can attach a message to another tenant's case.
-- This migration adds the tenant test to the staff branch of each policy and
-- scopes them all TO authenticated:
--
--   cases user_read / user_update:
--     user_id = auth.uid() OR (exists(staff profile) AND tenant_id = current_tenant_id())
--   messages user_read / user_insert:
--     parent case: c.user_id = auth.uid() OR (exists(staff profile) AND c.tenant_id = current_tenant_id())
--
-- Ordering: do NOT apply this before the telemedicine writer and the
-- 20261026120000 trigger set tenant_id, and before existing NULL-tenant rows are
-- resolved (D3) — otherwise clinical staff lose sight of patient-initiated rows.
--
-- ATOMICITY. A single `do` block; alterations and self-check commit or roll back
-- together. IDEMPOTENT. FAIL CLOSED on a missing policy.

do $$
declare
  v_i int;
  v_missing text[] := array[]::text[];
  r record;
  v_policies text[] := array[
    'telemedicine_intake_cases_user_read',
    'telemedicine_intake_cases_user_update',
    'telemedicine_intake_messages_user_read',
    'telemedicine_intake_messages_user_insert'
  ];
  v_tables text[] := array[
    'telemedicine_intake_cases',
    'telemedicine_intake_cases',
    'telemedicine_intake_messages',
    'telemedicine_intake_messages'
  ];
begin
  for v_i in 1..array_length(v_policies, 1) loop
    if not exists (
      select 1
      from pg_policies
      where schemaname = 'public'
        and tablename = v_tables[v_i]
        and policyname = v_policies[v_i]
    ) then
      v_missing := v_missing || (v_tables[v_i] || '.' || v_policies[v_i]);
    end if;
  end loop;

  if array_length(v_missing, 1) is not null then
    raise exception 'expected staff intake policies are missing: %', array_to_string(v_missing, ', ');
  end if;

  execute $alter$
  alter policy "telemedicine_intake_cases_user_read" on public.telemedicine_intake_cases
    to authenticated
    using (
      "auth"."role"() = 'authenticated'
      and (
        user_id = auth.uid()
        or (
          exists (
            select 1 from public.profiles p
            where p.id = auth.uid()
              and p.role = any (array['admin','receptionist','doctor','nurse','clinician'])
          )
          and tenant_id = public.current_tenant_id()
        )
      )
    );
  $alter$;

  execute $alter$
  alter policy "telemedicine_intake_cases_user_update" on public.telemedicine_intake_cases
    to authenticated
    using (
      "auth"."role"() = 'authenticated'
      and (
        user_id = auth.uid()
        or (
          exists (
            select 1 from public.profiles p
            where p.id = auth.uid()
              and p.role = any (array['admin','receptionist','doctor','nurse','clinician'])
          )
          and tenant_id = public.current_tenant_id()
        )
      )
    )
    with check (
      "auth"."role"() = 'authenticated'
      and (
        user_id = auth.uid()
        or (
          exists (
            select 1 from public.profiles p
            where p.id = auth.uid()
              and p.role = any (array['admin','receptionist','doctor','nurse','clinician'])
          )
          and tenant_id = public.current_tenant_id()
        )
      )
    );
  $alter$;

  execute $alter$
  alter policy "telemedicine_intake_messages_user_read" on public.telemedicine_intake_messages
    to authenticated
    using (
      "auth"."role"() = 'authenticated'
      and exists (
        select 1 from public.telemedicine_intake_cases c
        where c.id = telemedicine_intake_messages.case_id
          and (
            c.user_id = auth.uid()
            or (
              exists (
                select 1 from public.profiles p
                where p.id = auth.uid()
                  and p.role = any (array['admin','receptionist','doctor','nurse','clinician'])
              )
              and c.tenant_id = public.current_tenant_id()
            )
          )
      )
    );
  $alter$;

  execute $alter$
  alter policy "telemedicine_intake_messages_user_insert" on public.telemedicine_intake_messages
    to authenticated
    with check (
      "auth"."role"() = 'authenticated'
      and exists (
        select 1 from public.telemedicine_intake_cases c
        where c.id = telemedicine_intake_messages.case_id
          and (
            c.user_id = auth.uid()
            or (
              exists (
                select 1 from public.profiles p
                where p.id = auth.uid()
                  and p.role = any (array['admin','receptionist','doctor','nurse','clinician'])
              )
              and c.tenant_id = public.current_tenant_id()
            )
          )
      )
    );
  $alter$;

  -- Self-check in the same statement (same transaction) as the alterations.
  for r in
    select tablename, policyname, qual, with_check, roles
    from pg_policies
    where schemaname = 'public'
      and policyname = any (v_policies)
  loop
    if r.qual is null or position('current_tenant_id' in r.qual) = 0 then
      raise exception 'staff policy %.% no longer references current_tenant_id in USING', r.tablename, r.policyname;
    end if;
    if r.with_check is not null and position('current_tenant_id' in r.with_check) = 0 then
      raise exception 'staff policy %.% no longer references current_tenant_id in WITH CHECK', r.tablename, r.policyname;
    end if;
    if r.roles is null
      or cardinality(r.roles) <> 1
      or r.roles[1] <> 'authenticated'
    then
      raise exception 'staff policy %.% has roles %, expected exactly {authenticated}', r.tablename, r.policyname, r.roles;
    end if;
  end loop;

  raise notice 'four staff intake policies scoped to tenant and self-checked (HELD, not applied)';
end
$$;
