-- 20261026160000_revoke_anon_default_function_privileges
--
-- PREPARED ONLY — NOT APPLIED TO ANY DATABASE.
--
-- Closes the generator behind SEC-01's ACL findings: functions created in
-- `public` inherited EXECUTE for PUBLIC, and in production for `anon` as well,
-- so every future function was anon-callable the moment it existed.
--
-- WHY ALTER DEFAULT PRIVILEGES CANNOT DO IT ALONE
--
-- PostgreSQL builds a new function's ACL from acldefault('f', owner), which is
-- {owner=ALL, PUBLIC=EXECUTE}, and then merges the pg_default_acl entries for
-- the creating role onto it. The stored default ACL is a DELTA, not a complete
-- ACL, and aclconcat only adds privileges: removing the `anon` entry from the
-- delta works, but revoking PUBLIC from the delta does not, because there is no
-- entry to remove and the built-in PUBLIC=EXECUTE is re-added at creation time.
--
-- Measured on the db-acceptance stack (PostgreSQL 15): after
-- `alter default privileges ... revoke execute on functions from public`, the
-- pg_default_acl row was byte-identical, and a probe created afterwards still
-- carried {=X/postgres,...}; has_function_privilege('anon', …) was still true.
-- Removing only the `anon` entry (which scripts/db-reset-fresh.sh does) is
-- likewise not enough for the same reason.
--
-- WHAT THIS MIGRATION DOES
--
-- 1. Installs a ddl_command_end event trigger that revokes EXECUTE from PUBLIC
--    and anon on every function created in `public`. This is the part that
--    actually closes the generator; it covers overloads and CREATE OR REPLACE,
--    because both report the tag 'CREATE FUNCTION'.
-- 2. Drops the explicit `anon` entry from the default delta. This half does
--    work (it is a real delta entry), and keeping it at 0 is what makes the
--    snapshot's 34 explicit grants the whole anon surface.
-- 3. Revokes anon on the six functions already created under the old default,
--    which the trigger cannot reach because it is installed after them.
--
-- Consequence to accept deliberately: a future migration that wants anon, or
-- PUBLIC, to execute a function must now say so explicitly with a GRANT *after*
-- the CREATE. That matches how every hardened migration in this tree already
-- behaves (revoke from PUBLIC/anon, grant to the named role). None currently
-- relies on the default.
--
-- The trigger must be installed by a superuser. Where the migration role is not
-- one, this fails loudly here rather than leaving the generator open silently.
--
-- Idempotent: the trigger is dropped and recreated, and re-running the revokes
-- is a warning at most.
--
-- Rollback: drop event trigger synapse_lock_function_default_acl; drop function
-- public.synapse_lock_function_default_acl(); and re-add the anon default if
-- wanted. Those statements are deliberately not written here so the static ACL
-- gate in scripts/check-db-acl.mjs never matches a PUBLIC/anon EXECUTE grant in
-- a migration file.

create or replace function public.synapse_lock_function_default_acl()
returns event_trigger
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $fn$
declare
  r record;
begin
  for r in
    select object_identity
    from pg_event_trigger_ddl_commands()
    where object_type = 'function'
      and schema_name = 'public'
      and object_identity not like 'public.synapse_lock_function_default_acl%'
  loop
    execute format('revoke execute on function %s from public, anon', r.object_identity);
  end loop;
end
$fn$;

revoke all on function public.synapse_lock_function_default_acl() from public, anon;

drop event trigger if exists synapse_lock_function_default_acl;
create event trigger synapse_lock_function_default_acl
  on ddl_command_end
  when tag in ('CREATE FUNCTION')
  execute function public.synapse_lock_function_default_acl();

do $$
declare
  v_sig text;
  v_count int;
  v_probe_anon boolean;
  v_probe_public boolean;
  v_leftover text[] := '{}';
begin
  -- 1. Self-check: the generator lock must actually be installed and enabled.
  select count(*) into v_count
  from pg_event_trigger
  where evtname = 'synapse_lock_function_default_acl'
    and evtevent = 'ddl_command_end'
    and evtenabled <> 'D';

  if v_count <> 1 then
    raise exception 'cannot verify: event trigger synapse_lock_function_default_acl is missing or disabled; new functions would inherit PUBLIC EXECUTE';
  end if;

  -- 2. Drop the redundant `anon` entry from the default delta, so the explicit
  --    anon surface stays exactly the 34 signatures the snapshot grants.
  execute 'alter default privileges for role postgres in schema public '
       || 'revoke all on functions from anon';

  -- 3. Revoke anon on the six functions already created under the old default.
  --    All six are SECURITY INVOKER except the two intake triggers, and a
  --    trigger function cannot be invoked through PostgREST without a NEW row,
  --    so this is hygiene rather than a live vulnerability — but leaving them
  --    contradicts the assertion's own allowlist.
  foreach v_sig in array array[
    'public.clinical_documents_protect_signed()',
    'public.death_pronouncements_protect_signed()',
    'public.profiles_guard_privileged_columns()',
    'public.set_intake_case_tenant_from_owner()',
    'public.set_intake_message_tenant_from_case()',
    'public._grant_hospital_cap(text,text,text,text,text)'
  ] loop
    if to_regprocedure(v_sig) is not null then
      execute format('revoke execute on function %s from anon', v_sig);
    end if;
  end loop;

  -- 4. Self-check (catalogue). The default ACL row for (postgres, public,
  --    'f') exists because the bootstrap grants default privileges to
  --    postgres/authenticated/service_role. If no row exists the check cannot
  --    be trusted, so that is an error too rather than a silent pass.
  select count(*) into v_count
  from pg_default_acl d
  join pg_namespace n on n.oid = d.defaclnamespace
  where n.nspname = 'public'
    and d.defaclobjtype = 'f'
    and d.defaclrole = 'postgres'::regrole;

  if v_count = 0 then
    raise exception 'cannot verify: no pg_default_acl row for (postgres, public, functions); the default-ACL self-check would pass vacuously';
  end if;

  select count(*) into v_count
  from pg_default_acl d
  join pg_namespace n on n.oid = d.defaclnamespace
  cross join lateral aclexplode(d.defaclacl) a
  where n.nspname = 'public'
    and d.defaclobjtype = 'f'
    and d.defaclrole = 'postgres'::regrole
    and a.privilege_type = 'EXECUTE'
    and (a.grantee = 'anon'::regrole or a.grantee = 0);

  if v_count > 0 then
    raise exception 'default-privilege revoke did not take effect: % EXECUTE entries for anon/PUBLIC remain on the public function default', v_count;
  end if;

  -- 4b. Self-check (behavioural). The catalogue checks above depend on reading
  --     pg_default_acl correctly. This one does not: create a function under
  --     the current default, ask the server whether anon and PUBLIC can execute
  --     it, then remove it. It is the check that caught the earlier version of
  --     this migration, whose ALTER DEFAULT PRIVILEGES never took effect.
  begin
    execute 'create function public.__synapse_acl_default_probe() returns integer '
         || 'language sql as $probe$ select 1 $probe$';
    select has_function_privilege('anon', 'public.__synapse_acl_default_probe()', 'EXECUTE')
      into v_probe_anon;
    -- PUBLIC is not a role, so has_function_privilege cannot take it. Inspect
    -- the probe's own ACL instead: grantee 0 is PUBLIC.
    select count(*) into v_count
    from pg_proc p
    cross join lateral aclexplode(p.proacl) a
    where p.oid = 'public.__synapse_acl_default_probe()'::regprocedure
      and a.grantee = 0
      and a.privilege_type = 'EXECUTE';
    v_probe_public := v_count > 0;
    execute 'drop function public.__synapse_acl_default_probe()';
  exception when others then
    execute 'drop function if exists public.__synapse_acl_default_probe()';
    raise;
  end;

  if v_probe_anon or v_probe_public then
    raise exception 'a function created under the current default is still executable by anon=% public=% — the generator is not locked',
      v_probe_anon, v_probe_public;
  end if;

  -- 5. Self-check: the six must not retain an explicit anon entry.
  foreach v_sig in array array[
    'public.clinical_documents_protect_signed()',
    'public.death_pronouncements_protect_signed()',
    'public.profiles_guard_privileged_columns()',
    'public.set_intake_case_tenant_from_owner()',
    'public.set_intake_message_tenant_from_case()',
    'public._grant_hospital_cap(text,text,text,text,text)'
  ] loop
    if to_regprocedure(v_sig) is not null then
      select count(*) into v_count
      from pg_proc p
      cross join lateral aclexplode(p.proacl) a
      where p.oid = to_regprocedure(v_sig)
        and a.grantee = 'anon'::regrole
        and a.privilege_type = 'EXECUTE';
      if v_count > 0 then
        v_leftover := v_leftover || v_sig;
      end if;
    end if;
  end loop;

  if cardinality(v_leftover) > 0 then
    raise exception 'anon still holds EXECUTE on: %', array_to_string(v_leftover, ', ');
  end if;
end
$$;
