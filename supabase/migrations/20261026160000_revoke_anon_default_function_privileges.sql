-- 20261026160000_revoke_anon_default_function_privileges
--
-- PREPARED ONLY — NOT APPLIED TO ANY DATABASE.
--
-- Closes the generator behind SEC-01's ACL findings: the `public` default
-- privileges for functions, which production still carries exactly as dumped at
-- supabase/bootstrap/canonical_public_schema.sql:26324-26327.
--
-- WHY REMOVING THE `anon` ENTRY ALONE DOES NOT FIX IT
--
-- PostgreSQL builds a new function's ACL from acldefault('f', owner) — which is
-- {owner=ALL, PUBLIC=EXECUTE} — and then ADDS the pg_default_acl entries for the
-- creating role. It does not replace them. So with the production default in
-- place, a new function ends up with PUBLIC=EXECUTE *plus* explicit entries for
-- postgres, anon, authenticated and service_role. Revoking only the `anon`
-- entry (which is what scripts/db-reset-fresh.sh does) removes one redundant
-- line from the ACL and leaves `anon` still able to EXECUTE the function via
-- PUBLIC. `has_function_privilege('anon', …)` returns true either way.
--
-- That is why the chain build reports anon_entries = 34 (the snapshot's explicit
-- grants) while public_default_anon_exec = 152: the 152 are functions anon
-- reaches through PUBLIC alone.
--
-- WHAT THIS MIGRATION CHANGES, AND WHAT IT DOES NOT
--
-- It changes ONLY the default applied to functions `postgres` creates in
-- `public` from now on. ALTER DEFAULT PRIVILEGES is not retroactive: every
-- function that already exists keeps the ACL it has, so this migration cannot
-- widen or narrow any current access. It removes the footgun for future
-- migrations — in particular 20261026120000, which creates two SECURITY DEFINER
-- trigger functions that would otherwise be anon-callable in production while
-- passing the ACL assertion locally.
--
-- Consequence to accept deliberately: a future migration that wants anon, or
-- PUBLIC, to execute a function must now say so explicitly with a GRANT. That
-- matches how every hardened migration in this tree already behaves (revoke
-- from PUBLIC/anon, grant to the named role). None currently relies on the
-- default.
--
-- Idempotent: re-running is a warning at most ("no privileges could be
-- revoked"), never an error.
--
-- Rollback: re-add `GRANT EXECUTE ON FUNCTIONS TO PUBLIC` (and `TO anon`) with
-- ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public. The explicit
-- statements are deliberately not written here so the static ACL gate in
-- scripts/check-db-acl.mjs never matches a PUBLIC EXECUTE grant in a migration
-- file.

do $$
declare
  v_sig text;
  v_count int;
  v_probe_anon boolean;
  v_probe_public boolean;
  v_leftover text[] := '{}';
begin
  -- 1. Stop new functions inheriting PUBLIC EXECUTE. This is the actual fix.
  execute 'alter default privileges for role postgres in schema public '
       || 'revoke execute on functions from public';

  -- 2. Drop the redundant `anon` entry from the default ACL, so the explicit
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
  --    postgres/authenticated/service_role, and PostgreSQL stores the
  --    MATERIALISED default ACL in it — including the implicit PUBLIC entry.
  --    If no row exists the check cannot be trusted, so that is an error too
  --    rather than a silent pass.
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

  -- 4b. Self-check (behavioural). The catalogue check above depends on my
  --     reading of how PostgreSQL materialises default ACLs. This one does not:
  --     create a function under the new default and ask the server directly
  --     whether anon and PUBLIC can execute it, then remove it again.
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
    raise exception 'a function created under the current default is still executable by anon=% public=% — the default-privilege revoke did not take effect',
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
