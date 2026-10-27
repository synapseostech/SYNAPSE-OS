-- 20261026120000_telemedicine_intake_tenant_ownership
--
-- PREPARED ONLY — NOT APPLIED TO ANY DATABASE.
--
-- Fills tenant_id on telemedicine intake rows from the row's owning user, so
-- service-role writers cannot create tenantless intake rows by omission. The
-- route now resolves the tenant explicitly, but this is defence in depth: any
-- other writer (a job, a script, a future route) that omits tenant_id is also
-- covered.
--
-- It does NOT hard-fail on an unresolvable tenant (no profile row, or a profile
-- with a NULL tenant_id). That is a product decision: silently discarding
-- clinical data is worse than storing it tenantless, so the value is left NULL
-- and the row remains visible only through the pre-existing owner/staff
-- policies. Resolving existing NULL rows needs an operator decision and no
-- backfill is performed here.
--
-- ATOMICITY. The functions, the triggers and the self-check are deliberately a
-- SINGLE `do` block, so they run as one statement and commit or roll back
-- together under every applier: psql autocommit, `psql -v ON_ERROR_STOP=1 -f`
-- (the CI path), the harness's `\i`, and `supabase db push`. No explicit
-- begin/commit/rollback is used — the Supabase CLI already wraps each migration
-- file in a transaction and a COMMIT inside would end that wrapper early.
--
-- IDEMPOTENT. `create or replace function` and `create or replace trigger` make
-- re-running a no-op.

do $$
declare
  v_ok boolean;
begin
  execute $fn$
  create or replace function public.set_intake_case_tenant_from_owner()
  returns trigger
  language plpgsql
  security definer
  set search_path = public
  as $body$
  begin
    if new.tenant_id is null and new.user_id is not null then
      select tenant_id into new.tenant_id
      from public.profiles
      where id = new.user_id
      limit 1;
    end if;
    return new;
  end;
  $body$;
  $fn$;

  execute $fn$
  create or replace function public.set_intake_message_tenant_from_case()
  returns trigger
  language plpgsql
  security definer
  set search_path = public
  as $body$
  begin
    if new.tenant_id is null and new.case_id is not null then
      select tenant_id into new.tenant_id
      from public.telemedicine_intake_cases
      where id = new.case_id
      limit 1;

      if new.tenant_id is null then
        select p.tenant_id into new.tenant_id
        from public.telemedicine_intake_cases c
        join public.profiles p on p.id = c.user_id
        where c.id = new.case_id
        limit 1;
      end if;
    end if;
    return new;
  end;
  $body$;
  $fn$;

  execute $fn$
  create or replace trigger intake_case_tenant_from_owner
    before insert on public.telemedicine_intake_cases
    for each row execute function public.set_intake_case_tenant_from_owner();
  $fn$;

  execute $fn$
  create or replace trigger intake_message_tenant_from_case
    before insert on public.telemedicine_intake_messages
    for each row execute function public.set_intake_message_tenant_from_case();
  $fn$;

  revoke all on function public.set_intake_case_tenant_from_owner() from public;
  revoke all on function public.set_intake_message_tenant_from_case() from public;

  -- Self-check, in the same statement (and therefore the same transaction) as
  -- the creations above, so a failure here rolls them back.

  if not exists (
    select 1
    from pg_trigger t
    join pg_class c on c.oid = t.tgrelid
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relname = 'telemedicine_intake_cases'
      and t.tgname = 'intake_case_tenant_from_owner'
  ) then
    raise exception 'trigger intake_case_tenant_from_owner is missing on public.telemedicine_intake_cases after creation';
  end if;

  if not exists (
    select 1
    from pg_trigger t
    join pg_class c on c.oid = t.tgrelid
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relname = 'telemedicine_intake_messages'
      and t.tgname = 'intake_message_tenant_from_case'
  ) then
    raise exception 'trigger intake_message_tenant_from_case is missing on public.telemedicine_intake_messages after creation';
  end if;

  select count(*) = 2 into v_ok
  from pg_proc p
  where p.pronamespace = 'public'::regnamespace
    and p.proname in ('set_intake_case_tenant_from_owner', 'set_intake_message_tenant_from_case')
    and p.prosecdef = true
    and exists (
      select 1
      from unnest(coalesce(p.proconfig, array[]::text[])) cfg
      where cfg like 'search_path=%'
    );

  if not v_ok then
    raise exception 'both intake tenant trigger functions must be SECURITY DEFINER with a pinned search_path';
  end if;

  raise notice 'telemedicine intake tenant ownership triggers installed and self-checked';
end
$$;
