-- Function ACL surface assertions for the chain-built disposable database.
--
-- Proves the bootstrap default-privilege fix (A5) propagated to the WHOLE
-- function surface, by exact set equality against the snapshot's explicit
-- grants.
--
-- Arithmetic (re-derivable from source, no run required):
--   49  snapshot `GRANT ALL ON FUNCTION ... TO "anon"` statements
--       (supabase/bootstrap/canonical_public_schema.sql)
--   −11 revoked by 20261003150000_revoke_exposed_security_definer_functions.sql
--   − 4 revoked by 20261002180000_revoke_public_billing_rpc_execute.sql
--       (activate_subscription_payment, advance_all_subscriptions,
--        advance_subscription_state, log_subscription_event)
--   =34 expected anon-granted functions in the final chain.
--
-- Hard assertions:
--   1. Set equality: the functions in public with an explicit `anon` EXECUTE
--      entry equal the 34 exactly. A missing signature is an under-grant; an
--      extra signature is a finding (under the A5 bug every function would
--      carry an anon entry from the default-privilege line).
--   2. The 15 revoked signatures are not anon-executable and carry no explicit
--      anon entry.
--   3. Spot checks: current_tenant_id and adjust_pharmacy_batch_stock are not
--      anon-executable.
--   4. The actual security property: no SECURITY DEFINER function in public
--      that is OUTSIDE the 34 may be anon-executable. SECURITY INVOKER
--      functions run as the caller and are gated by RLS; SECURITY DEFINER
--      functions are not, so an anon-reachable definer outside the allowlist
--      is a real escalation finding (named individually).
--   5. The generator: the public FUNCTION default must grant EXECUTE to
--      neither anon nor PUBLIC. Assertions 1-4 describe the objects that
--      exist; this one describes what the next migration will produce.
--      20261026160000_revoke_anon_default_function_privileges.sql is what
--      makes it true, and it fails loudly if the pg_default_acl row is absent
--      so the check can never pass vacuously.
--
-- Reported (NOTICE), not asserted: service_role entries, the anon∩service_role
-- overlap, the count of non-definer functions anon can reach via the PUBLIC
-- default (moves with extensions/migrations — never pinned), and the
-- public_default_anon_exec count (pre-existing, expected to match production).
--
-- Wired into .github/workflows/deploy.yml (db-acceptance) so it re-runs with
-- every chain build, after the post-cutoff migration loop. There is no npm run
-- entry point: this assertion is only meaningful against a chain-built database.

\set ON_ERROR_STOP on

do $$
declare
  r record;
  s_count int;
  a_count int;
  overlap_count int;
  missing text[] := '{}';
  extra text[] := '{}';
  revoked_bad text[] := '{}';
  revoked_with_anon text[] := '{}';
  default_acl_rows int;
  default_acl_bad int;
  definer_bad text[] := '{}';
  invoker_public_count int;
  expected text[] := array['_set_consult_queue_updated_at()', 'allocate_lab_accession(uuid,text,text)', 'assign_synapse_id()', 'billing_grace_days()', 'bump_record_version()', 'check_death_sentinel(uuid)', 'claim_next_consult(uuid)', 'expand_facility_types(text)', 'expand_roles(text)', 'find_duplicate_patients(uuid,text,date,character varying,character varying,double precision)', 'forbid_platform_audit_mutation()', 'generate_synapse_id()', 'get_available_beds(character varying,uuid)', 'get_queue_position(uuid)', 'guard_hospital_seed_reset()', 'guard_pos_sale_item_mutation()', 'guard_pos_sale_mutation()', 'guard_signed_encounter_update()', 'is_admin(uuid)', 'match_ucg_guidelines(vector,double precision,integer)', 'persons_assign_synapse_id()', 'pos_sale_item_before_insert()', 'recompute_differential(uuid)', 'resolve_tenant_from_host(text)', 'same_tenant(uuid)', 'set_bed_status_change_ts()', 'set_death_reg_updated_at()', 'set_expert_rules_updated_at()', 'set_generic_updated_at()', 'set_referral_updated_at()', 'set_telemedicine_updated_at()', 'set_tenant_domain_updated_at()', 'set_updated_at()', 'update_updated_at_column()'];
  revoked text[] := array['activate_subscription_payment(uuid,text)', 'advance_all_subscriptions(text)', 'advance_subscription_state(uuid,text)', 'apply_encounter_amendment(uuid,uuid,text,text,text,uuid)', 'auto_set_tenant_id()', 'current_staff_site_ids()', 'custom_access_token_hook(jsonb)', 'fn_sync_network_inventory()', 'handle_new_user()', 'handle_new_user_profile()', 'has_capability(text,text,text,text,text)', 'has_feature(uuid,text)', 'has_patient_consent(uuid,text,uuid)', 'is_platform_operator()', 'log_subscription_event(uuid,text,text,text,text,jsonb)'];
begin
  -- 1. Set equality: anon entries == expected.
  for r in
    select e.sig from unnest(expected) e(sig)
    where not exists (
      select 1 from pg_proc p
      cross join lateral aclexplode(p.proacl) a
      where p.pronamespace = 'public'::regnamespace
        and a.grantee = 'anon'::regrole and a.privilege_type = 'EXECUTE'
        and p.oid::regprocedure::text = e.sig
    )
  loop
    missing := missing || r.sig;
  end loop;

  for r in
    select p.oid::regprocedure::text as sig from pg_proc p
    cross join lateral aclexplode(p.proacl) a
    where p.pronamespace = 'public'::regnamespace
      and a.grantee = 'anon'::regrole and a.privilege_type = 'EXECUTE'
      and not (p.oid::regprocedure::text = any(expected))
    group by p.oid
  loop
    extra := extra || r.sig;
  end loop;

  -- 2. The 15 revoked must not be anon-executable and carry no anon entry.
  for r in
    select rv.sig from unnest(revoked) rv(sig)
    where to_regprocedure(rv.sig) is not null
      and has_function_privilege('anon', to_regprocedure(rv.sig), 'EXECUTE')
  loop
    revoked_bad := revoked_bad || r.sig;
  end loop;
  for r in
    select rv.sig from unnest(revoked) rv(sig)
    where to_regprocedure(rv.sig) is not null
      and exists (
        select 1 from pg_proc p
        cross join lateral aclexplode(p.proacl) a
        where p.oid = to_regprocedure(rv.sig)
          and a.grantee = 'anon'::regrole and a.privilege_type = 'EXECUTE'
      )
  loop
    revoked_with_anon := revoked_with_anon || r.sig;
  end loop;

  -- 3. Spot checks.
  if has_function_privilege('anon', 'public.current_tenant_id()', 'EXECUTE') then
    raise exception 'spot check failed: anon can execute current_tenant_id';
  end if;
  if has_function_privilege('anon', 'public.adjust_pharmacy_batch_stock(uuid,uuid,integer,text,text,uuid,uuid,text,date,numeric,text)', 'EXECUTE') then
    raise exception 'spot check failed: anon can execute adjust_pharmacy_batch_stock';
  end if;

  -- 4. SECURITY DEFINER functions outside the allowlist must not be
  --    anon-executable.
  for r in
    select p.oid::regprocedure::text as sig from pg_proc p
    where p.pronamespace = 'public'::regnamespace
      and p.prosecdef
      and not (p.oid::regprocedure::text = any(expected))
      and has_function_privilege('anon', p.oid, 'EXECUTE')
  loop
    definer_bad := definer_bad || r.sig;
  end loop;

  -- 5. The public FUNCTION default must not grant EXECUTE to anon or PUBLIC.
  --    This is the generator, as distinct from the objects it produced: without
  --    it, every function a future migration creates is anon-callable the
  --    moment it exists, and no per-object assertion can see that.
  select count(*) into default_acl_rows
  from pg_default_acl d
  join pg_namespace n on n.oid = d.defaclnamespace
  where n.nspname = 'public'
    and d.defaclobjtype = 'f'
    and d.defaclrole = 'postgres'::regrole;

  if default_acl_rows = 0 then
    raise exception 'cannot verify: no pg_default_acl row for (postgres, public, functions); the default-privilege check would pass vacuously';
  end if;

  select count(*) into default_acl_bad
  from pg_default_acl d
  join pg_namespace n on n.oid = d.defaclnamespace
  cross join lateral aclexplode(d.defaclacl) a
  where n.nspname = 'public'
    and d.defaclobjtype = 'f'
    and d.defaclrole = 'postgres'::regrole
    and a.privilege_type = 'EXECUTE'
    and (a.grantee = 'anon'::regrole or a.grantee = 0);

  if default_acl_bad > 0 then
    raise exception 'the public function default still grants EXECUTE to anon/PUBLIC (% entries); every future function is anon-callable until this is revoked', default_acl_bad;
  end if;

  select count(*) into invoker_public_count
  from pg_proc p
  where p.pronamespace = 'public'::regnamespace
    and not p.prosecdef
    and has_function_privilege('anon', p.oid, 'EXECUTE')
    and not exists (
      select 1 from aclexplode(p.proacl) a
      where a.grantee = 'anon'::regrole and a.privilege_type = 'EXECUTE'
    );

  if cardinality(missing) > 0 then
    raise exception 'under-grant: expected anon-granted functions missing an anon entry: %', array_to_string(missing, ', ');
  end if;
  if cardinality(extra) > 0 then
    raise exception 'finding: functions carry an explicit anon entry but are not in the expected set: %', array_to_string(extra, ', ');
  end if;
  if cardinality(revoked_bad) > 0 then
    raise exception 'revoked function is anon-executable: %', array_to_string(revoked_bad, ', ');
  end if;
  if cardinality(revoked_with_anon) > 0 then
    raise exception 'revoked function still carries an explicit anon entry: %', array_to_string(revoked_with_anon, ', ');
  end if;
  if cardinality(definer_bad) > 0 then
    raise exception 'SECURITY DEFINER function outside the allowlist is anon-executable: %', array_to_string(definer_bad, ', ');
  end if;

  select count(*) into a_count from (
    select p.oid from pg_proc p join lateral aclexplode(p.proacl) a on true
    where p.pronamespace = 'public'::regnamespace
      and a.grantee = 'anon'::regrole and a.privilege_type = 'EXECUTE'
    group by p.oid
  ) t;
  select count(*) into s_count from (
    select p.oid from pg_proc p join lateral aclexplode(p.proacl) a on true
    where p.pronamespace = 'public'::regnamespace
      and a.grantee = 'service_role'::regrole and a.privilege_type = 'EXECUTE'
    group by p.oid
  ) t;
  select count(*) into overlap_count from (
    select p.oid from pg_proc p join lateral aclexplode(p.proacl) a on true
    where p.pronamespace = 'public'::regnamespace
      and a.grantee = 'anon'::regrole and a.privilege_type = 'EXECUTE'
      and exists (
        select 1 from aclexplode(p.proacl) b
        where b.grantee = 'service_role'::regrole and b.privilege_type = 'EXECUTE'
      )
    group by p.oid
  ) t;

  raise notice 'ACL_SURFACE service_role_entries=% anon_entries=% overlap=% invoker_public_default_anon_exec=%', s_count, a_count, overlap_count, invoker_public_count;
end $$;

-- P: functions anon can execute only via the PUBLIC default (no explicit anon
-- grant). Pre-existing quantity, expected to match production.
select count(*) as public_default_anon_exec
from pg_proc p
where p.pronamespace = 'public'::regnamespace
  and has_function_privilege('anon', p.oid, 'EXECUTE')
  and not exists (
    select 1 from aclexplode(p.proacl) a
    where a.grantee = 'anon'::regrole and a.privilege_type = 'EXECUTE'
  );
