-- 20261102130200_complete_pharmacy_sale_single_overload
--
-- `20260703185455` created `complete_pharmacy_sale` with eleven parameters.
-- `20260810093356` added `p_idempotency_key` with a default, which is a
-- different signature, so `create or replace` left both in the catalogue and
-- every later definition replaced only the twelve-parameter one.
--
-- The surviving eleven-parameter function still carries the pre-idempotency
-- body. Any call that names or supplies eleven or fewer arguments matches both
-- candidates and PostgreSQL refuses it:
--
--   function public.complete_pharmacy_sale(...) is not unique
--
-- PostgREST surfaces that as PGRST203 rather than as a sale. All three
-- application callers currently pass `p_idempotency_key` explicitly, so the
-- shipped paths work; the risk is a new caller that omits it, and any raw-SQL
-- caller. It is also a stale copy of the pricing, stock and tax rules sitting
-- beside the live one, which is the kind of thing that eventually gets called
-- by accident.
--
-- The two signatures were read off the catalogue on PostgreSQL 18.6 while
-- running scripts/db-tests/run-pharmacy-db-pglite.mjs; no other overload of
-- this name exists. Dropping the eleven-parameter one leaves exactly one.
--
-- PREPARED, not applied to any environment by the change that added this file.

begin;

drop function if exists public.complete_pharmacy_sale(
  uuid, uuid, jsonb, text, uuid, uuid, text, numeric, numeric, uuid, uuid
);

-- Self-check: a second overload reappearing would restore the ambiguity.
do $$
declare
  v_count int;
begin
  select count(*) into v_count
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname = 'complete_pharmacy_sale';

  if v_count <> 1 then
    raise exception
      'complete_pharmacy_sale should have exactly one overload, found %', v_count;
  end if;
end
$$;

commit;
