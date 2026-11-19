-- 20261119140000_index_foreign_keys
--
-- Supabase's advisor reports 502 public foreign keys with no index on their
-- column. Indexing all of them would spend disk (the project runs on the free
-- plan's 500 MB) and slow every write, so this indexes two groups only:
--
-- 1. Every single-column foreign key whose ON DELETE is CASCADE or SET NULL
--    (220). Deleting a parent row — a tenant, a profile, an import session —
--    makes Postgres find the children through that column; with no index it
--    scans the whole child table for each parent row. Tenant deletes measured
--    0.8-1.5 s each in pg_stat_statements.
--
-- 2. Foreign keys the application follows on hot paths, on tables that
--    already hold tens of thousands of rows:
--      journal lines by entry and by account (ledger, day book, reports),
--      replay movements by session and by the movement they reverse
--      (rollback), sale and purchase lines by batch, products by supplier.
--
-- Both groups are found from the catalogue, not restated, so the migration
-- works on any environment and adds nothing where an index already leads
-- with the column. Index names are deterministic, so running it again
-- changes nothing.
--
-- It also drops two exact duplicates the advisor reported, keeping the index
-- that backs a constraint (or the older name) in each pair.
--
-- PREPARED, not applied to any environment by the change that added this file.

begin;

do $$
declare
  r record;
  v_created integer := 0;
begin
  for r in
    select distinct cl.relname as tbl, a.attname as col
    from pg_constraint c
    join pg_class cl on cl.oid = c.conrelid
    join pg_attribute a on a.attrelid = c.conrelid and a.attnum = c.conkey[1]
    where c.contype = 'f'
      and c.connamespace = 'public'::regnamespace
      and array_length(c.conkey, 1) = 1
      and not exists (
        select 1 from pg_index i where i.indrelid = c.conrelid and i.indkey[0] = c.conkey[1]
      )
      and (
        c.confdeltype in ('c', 'n')
        or (cl.relname, a.attname) in (
          ('pharmacy_accounting_journal_lines', 'journal_entry_id'),
          ('pharmacy_accounting_journal_lines', 'account_id'),
          ('pharmacy_tally_replay_movements', 'session_id'),
          ('pharmacy_tally_replay_movements', 'reverses_movement_id'),
          ('pharmacy_tally_replay_movements', 'product_id'),
          ('pharmacy_transaction_items', 'batch_id'),
          ('pharmacy_purchase_items', 'batch_id'),
          ('pharmacy_products', 'supplier_id')
        )
      )
  loop
    execute format('create index if not exists %I on public.%I (%I)',
      left(r.tbl || '_' || r.col, 50) || '_fk_' || substr(md5(r.tbl || '.' || r.col), 1, 6), r.tbl, r.col);
    v_created := v_created + 1;
  end loop;
  raise notice 'index_foreign_keys: % indexes created', v_created;
end;
$$;

-- Exact duplicates. Each drop is skipped where the pair is not both present,
-- and never touches an index that backs a constraint.
do $$
declare
  v_pair record;
begin
  for v_pair in
    select * from (values
      ('hospitals', 'idx_hospitals_subdomain', 'hospitals_subdomain_key'),
      ('role_capabilities', 'idx_role_capabilities_role', 'role_capabilities_role_idx')
    ) as t(tbl, drop_name, keep_name)
  loop
    if exists (select 1 from pg_indexes where schemaname = 'public' and indexname = v_pair.drop_name)
       and exists (select 1 from pg_indexes where schemaname = 'public' and indexname = v_pair.keep_name)
       and not exists (
         select 1 from pg_constraint where conindid = format('public.%I', v_pair.drop_name)::regclass
       )
    then
      execute format('drop index public.%I', v_pair.drop_name);
    end if;
  end loop;
end;
$$;

commit;
