-- 20261119120000_rls_auth_calls_once_per_query
--
-- Supabase's performance advisor (auth_rls_initplan) flagged 391 row level
-- security policies that call auth.uid(), auth.jwt(), auth.role() or
-- current_setting('request.jwt.claims', true) directly. Postgres evaluates a
-- bare call once for every row a query touches; wrapped as a scalar subquery,
--   (select auth.uid())
-- it is evaluated once per query and reused (an InitPlan). The value is the
-- same for every row of one statement, so what each policy allows does not
-- change — only how often it is computed.
--
-- The policies were written across many migrations and some environments
-- carry ones the repository does not. Rather than restating 384 policies
-- (and failing on any database where one differs), this rewrites, in place,
-- every public policy whose USING or WITH CHECK expression still holds a bare
-- call. A call already wrapped — Postgres stores it as "( SELECT auth.uid() AS
-- uid)" — is left alone, so running this again changes nothing.
--
-- ALTER POLICY keeps each policy's name, command, roles and permissive or
-- restrictive kind; only the expressions are replaced.
--
-- PREPARED, not applied to any environment by the change that added this file.

begin;

do $$
declare
  r record;
  v_using text;
  v_check text;
  v_count integer := 0;
  v_pattern constant text := '(?<!SELECT )(auth\.(uid|jwt|role|email)\(\)|current_setting\()';
begin
  for r in
    select schemaname, tablename, policyname, qual, with_check
    from pg_policies
    where schemaname = 'public'
      and (coalesce(qual, '') ~ v_pattern or coalesce(with_check, '') ~ v_pattern)
  loop
    v_using := r.qual;
    v_check := r.with_check;

    if v_using is not null then
      v_using := regexp_replace(v_using, '(?<!SELECT )auth\.(uid|jwt|role|email)\(\)', '(select auth.\1())', 'g');
      v_using := regexp_replace(v_using, '(?<!SELECT )(current_setting\(''[^'']*''::text(, (true|false))?\))', '(select \1)', 'g');
    end if;
    if v_check is not null then
      v_check := regexp_replace(v_check, '(?<!SELECT )auth\.(uid|jwt|role|email)\(\)', '(select auth.\1())', 'g');
      v_check := regexp_replace(v_check, '(?<!SELECT )(current_setting\(''[^'']*''::text(, (true|false))?\))', '(select \1)', 'g');
    end if;

    if v_using is not null and v_check is not null then
      execute format('alter policy %I on %I.%I using (%s) with check (%s)',
        r.policyname, r.schemaname, r.tablename, v_using, v_check);
    elsif v_using is not null then
      execute format('alter policy %I on %I.%I using (%s)',
        r.policyname, r.schemaname, r.tablename, v_using);
    elsif v_check is not null then
      execute format('alter policy %I on %I.%I with check (%s)',
        r.policyname, r.schemaname, r.tablename, v_check);
    end if;
    v_count := v_count + 1;
  end loop;

  raise notice 'rls_auth_calls_once_per_query: % policies rewritten', v_count;
end;
$$;

-- Nothing may be left behind: a bare call that survived means a form the
-- rewrite did not recognise, and the migration should stop rather than pass.
do $$
declare
  v_left integer;
begin
  select count(*) into v_left
  from pg_policies
  where schemaname = 'public'
    and (coalesce(qual, '') ~ '(?<!SELECT )auth\.(uid|jwt|role|email)\(\)'
      or coalesce(with_check, '') ~ '(?<!SELECT )auth\.(uid|jwt|role|email)\(\)');
  if v_left > 0 then
    raise exception 'RLS_AUTH_REWRITE_INCOMPLETE: % policies still call auth.* per row', v_left;
  end if;
end;
$$;

commit;
