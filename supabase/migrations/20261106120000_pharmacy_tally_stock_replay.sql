-- 20261106120000_pharmacy_tally_stock_replay
--
-- The write path for the replay mode of the Tally import (Phase C of
-- docs/pharmacy/TALLY_MIGRATION_ARCHITECTURE.md's replay plan). Three objects:
--
--   1. `pharmacy_tally_replay_movements` — append-only provenance for every
--      stock movement the replay applied. It is the idempotency barrier: the
--      unique key on (tenant_id, session_id, source_type, source_id,
--      line_index, batch_index) means a repeated chunk or a resumed session
--      inserts nothing and, crucially, touches no stock. The session is part
--      of the key so a fresh import after a rollback can apply the same export
--      again; overlap with an earlier un-reversed session is refused by the
--      function's second check.
--
--   2. `apply_pharmacy_tally_replay_movement(...)` — the one sanctioned way to
--      move stock as history. It deliberately accepts batches that are already
--      expired and backdates `received_date`, because the movement happened
--      then. `receive_pharmacy_stock` is NOT weakened: it keeps refusing an
--      expired receipt and keeps stamping today, and replay never calls it.
--
--   3. `pharmacy_tally_replay_actuals(p_tenant_id)` — the closing-state read
--      used by the `replay-closing` stage. It is an RPC rather than PostgREST
--      reads because PostgREST silently caps a response at 1000 rows; a
--      truncated product list would make the closing comparison pass on a
--      figure nobody checked.
--
-- Why not `receive_pharmacy_stock` + `complete_pharmacy_sale`: those carry
-- today's clock and create receipts and prescriptions that never existed.
-- Replay writes movements, journals stay on `postJournal`, and Tally mirrors
-- stay on `mirrorSale`/`mirrorPurchase`. No POS sale row is created here.
--
-- Immutability: the provenance rows are UPDATE-proof and DELETE-proof while
-- their session still exists, matching the ledger's rule in 20261022160000
-- that a correction is a new entry, not an edit. The owner kept that guard for
-- mirror rows, and the same reasoning applies here.
--
-- The tenant purge (`purge_pharmacy_tenant_data`, 20261104120000) deletes
-- import sessions from a fixed target list and disables only eight named
-- triggers. This table is therefore NOT on that list: its `on delete cascade`
-- removes the provenance with the session, and the guard below permits a
-- DELETE precisely when the owning session is already gone. That keeps the
-- purge working without asking it to know this table's trigger name.
--
-- PREPARED ONLY: this migration has not been applied to any database by this
-- change. The owner runs it on a non-production database first.
--
-- Tenant isolation follows 20261102130000, the current house pattern:
-- `tenant_id = any (public.pharmacy_caller_tenants()) or
-- public.is_platform_admin()`, scoped `TO authenticated`.

begin;

-- ---------------------------------------------------------------------------
-- 1. Provenance.
--
-- The identity is the movement's place in the export, not its date, product or
-- amount: `(source_type, source_id, line_index, batch_index)`. `movement_id`
-- is stored for the audit trail and for joining a finding back to a voucher,
-- but it is not the key — opening movements are built inline and their ids
-- repeat across stock items.
--
-- `quantity_delta` is signed whole units. A physical-stock SET was already
-- resolved to a delta by the simulation, so replay is a pure application of
-- signed deltas and re-running it in any order is still a no-op.
-- ---------------------------------------------------------------------------
create table if not exists public.pharmacy_tally_replay_movements (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references public.tenants(id) on delete cascade,
  session_id     uuid not null references public.pharmacy_import_sessions(id) on delete cascade,
  movement_id    text not null,
  source_type    text not null,
  source_id      text not null,
  source_guid    text,
  line_index     integer not null,
  batch_index    integer not null,
  movement_kind  text not null,
  movement_date  date not null,
  product_id     uuid not null references public.pharmacy_products(id) on delete cascade,
  batch_id       uuid references public.pharmacy_product_batches(id) on delete set null,
  batch_number   text not null,
  expiry_date    date,
  godown         text,
  quantity_delta integer not null,
  rate           numeric(14, 2) not null default 0,
  amount         numeric(14, 2) not null default 0,
  allocation     text not null,
  -- Set only on a compensating row: it points at the movement it undoes, so
  -- "was this undone?" is a fact on the row rather than an inference from sums.
  reverses_movement_id uuid references public.pharmacy_tally_replay_movements(id) on delete set null,
  created_at     timestamptz not null default now(),
  constraint pharmacy_tally_replay_movements_kind_check check (
    movement_kind in (
      'opening', 'purchase_in', 'sale_out', 'return_in', 'return_out',
      'stock_journal_in', 'stock_journal_out', 'physical_adjust'
    )
  ),
  constraint pharmacy_tally_replay_movements_allocation_check check (
    allocation in ('explicit', 'fefo', 'synthetic')
  ),
  constraint pharmacy_tally_replay_movements_delta_check
    check (quantity_delta <> 0),
  -- The session is part of the key because a rollback makes a fresh import
  -- legitimate: the same export applied again by a new session is history
  -- being rebuilt, not a duplicate. Overlap with an earlier session is caught
  -- by the barrier below, which asks whether the key still stands.
  constraint pharmacy_tally_replay_movements_identity_key
    unique (tenant_id, session_id, source_type, source_id, line_index, batch_index)
);

create index if not exists idx_pharmacy_tally_replay_movements_session
  on public.pharmacy_tally_replay_movements (tenant_id, session_id);

create index if not exists idx_pharmacy_tally_replay_movements_product
  on public.pharmacy_tally_replay_movements (tenant_id, product_id, movement_date);

-- ---------------------------------------------------------------------------
-- 2. Append-only guard.
--
-- UPDATE is always refused. DELETE is refused while the owning session exists,
-- so a correction is a new movement, never an edit of applied history. The
-- cascade from the session delete runs after the parent row is gone, which is
-- exactly the case this permits.
-- ---------------------------------------------------------------------------
create or replace function public.guard_pharmacy_tally_replay_movement()
returns trigger
language plpgsql
security definer
set search_path to ''
as $function$
begin
  if tg_op = 'DELETE' and not exists (
    select 1 from public.pharmacy_import_sessions s where s.id = old.session_id
  ) then
    return old;
  end if;
  raise exception 'TALLY_REPLAY_MOVEMENTS_IMMUTABLE: a replay movement is recorded history; apply a correcting movement instead';
end;
$function$;

drop trigger if exists pharmacy_tally_replay_movements_immutable
  on public.pharmacy_tally_replay_movements;
create trigger pharmacy_tally_replay_movements_immutable
  before update or delete on public.pharmacy_tally_replay_movements
  for each row execute function public.guard_pharmacy_tally_replay_movement();

-- ---------------------------------------------------------------------------
-- 3. The movement write.
--
-- One call carries one movement and every batch it touched. A sale line with
-- no batch allocation is resolved to several batches by FEFO, and those takes
-- must commit together: a call per take would leave a half-consumed line if the
-- request died between them, and the provenance row would then claim the whole
-- line was applied.
--
-- Order of operations matters:
--
--   a. verify the session is this tenant's Tally session;
--   b. if a provenance row already exists for this movement's place in the
--      export, return `replayed: true` and change nothing — this check is
--      before any batch is created so a re-run cannot leave stray batches;
--   c. lock the product and check the movement's total against it;
--   d. for each allocation: resolve/create the batch, check its own total,
--      insert the provenance row, move the batch;
--   e. move the product by the summed delta.
--
-- Every failure raises, so the provenance rows roll back with the rest of the
-- transaction and a retry can succeed. A caught error after (d) would mark a
-- movement applied that never was, which is why there is no exception block
-- around the writes.
--
-- The batch key is `(product_id, batch_number)` because that is the table's
-- unique constraint (20260608134937). A second expiry for the same number is
-- refused, not silently reused: widening that key is a domain decision, not
-- something a replay may do.
-- ---------------------------------------------------------------------------
create or replace function public.apply_pharmacy_tally_replay_movement(
  p_tenant_id uuid,
  p_session_id uuid,
  p_movement_id text,
  p_source_type text,
  p_source_id text,
  p_source_guid text,
  p_line_index integer,
  p_movement_kind text,
  p_movement_date date,
  p_product_id uuid,
  p_allocation text,
  p_godown text,
  p_allocations jsonb,
  p_allow_negative boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_session_source text;
  v_session_mapping jsonb;
  v_product public.pharmacy_products%rowtype;
  v_batch public.pharmacy_product_batches%rowtype;
  v_batch_id uuid;
  v_inserted_id uuid;
  v_kla_today date := (timezone('Africa/Kampala', now()))::date;
  v_product_quantity integer;
  v_item jsonb;
  v_batch_number text;
  v_expiry_date date;
  v_batch_index integer;
  v_delta integer;
  v_rate numeric;
  v_amount numeric;
  v_total_delta integer := 0;
  v_applied jsonb := '[]'::jsonb;
  v_quantity_after integer;
  v_first_batch_index integer;
begin
  if p_tenant_id is null or p_session_id is null then
    raise exception 'REPLAY_SESSION_REQUIRED: a replay movement must name its import session';
  end if;
  if p_allocations is null
     or jsonb_typeof(p_allocations) <> 'array'
     or jsonb_array_length(p_allocations) = 0 then
    raise exception 'REPLAY_BATCH_REQUIRED: a replay movement must name the batch it moves';
  end if;

  select s.source_system, s.ai_mapping into v_session_source, v_session_mapping
  from public.pharmacy_import_sessions s
  where s.id = p_session_id and s.tenant_id = p_tenant_id;

  -- The same test the app uses (`isTallyCutoverSession`): `source_system` may be
  -- null for a Tally upload, and the format the Tally flow writes is what
  -- actually marks one. A generic importer session must never move stock here.
  if coalesce(v_session_source, 'Tally') <> 'Tally'
     or coalesce(v_session_mapping ->> 'format', '') not in ('xml', 'xlsx', 'xls', 'csv') then
    raise exception 'REPLAY_SESSION_NOT_TALLY: session % is not a Tally import of this pharmacy', p_session_id;
  end if;

  -- The idempotency barrier. A provenance row at this place in the export
  -- means the movement and every batch it touched were already applied, so the
  -- call returns before creating a batch or moving a unit. Checking here rather
  -- than per allocation matters: a re-run that re-resolved FEFO against today's
  -- batches would otherwise leave empty batches behind before discovering the
  -- conflict.
  --
  -- The check names the movement's first allocation, not the whole line. One
  -- voucher line with several batch allocations is several movements sharing
  -- (source_id, line_index), and a line-wide check would report the second one
  -- as already applied and leave its stock unwritten. The first allocation's
  -- index is stable across a re-run: explicit movements keep their export
  -- index, and a FEFO movement always starts at 0.
  v_first_batch_index := coalesce((p_allocations -> 0 ->> 'batch_index')::integer, 0);

  -- Within this session the key is proof the movement landed.
  if exists (
    select 1
    from public.pharmacy_tally_replay_movements m
    where m.tenant_id = p_tenant_id
      and m.session_id = p_session_id
      and m.source_type = p_source_type
      and m.source_id = p_source_id
      and m.line_index = p_line_index
      and m.batch_index = v_first_batch_index
  ) then
    return jsonb_build_object(
      'replayed', true,
      'movement_id', p_movement_id,
      'allocations', '[]'::jsonb,
      'product_quantity_after', null
    );
  end if;

  -- A continuation whose export reaches back into the previous period sees
  -- keys an earlier session already applied. Applying them again would double
  -- the stock, so an un-reversed row from another session is overlap and is
  -- skipped. A reversed row does not count: it was undone, and applying it
  -- again is exactly what a fresh import after a rollback must be able to do.
  if exists (
    select 1
    from public.pharmacy_tally_replay_movements m
    where m.tenant_id = p_tenant_id
      and m.session_id <> p_session_id
      and m.source_type = p_source_type
      and m.source_id = p_source_id
      and m.line_index = p_line_index
      and m.batch_index = v_first_batch_index
      and not exists (
        select 1
        from public.pharmacy_tally_replay_movements r
        where r.reverses_movement_id = m.id
      )
  ) then
    return jsonb_build_object(
      'replayed', true,
      'movement_id', p_movement_id,
      'allocations', '[]'::jsonb,
      'product_quantity_after', null
    );
  end if;

  select * into v_product
  from public.pharmacy_products
  where id = p_product_id and tenant_id = p_tenant_id
  for update;

  if not found then
    raise exception 'PRODUCT_NOT_FOUND: %', p_product_id;
  end if;

  -- Sum before moving anything: a movement whose total is covered must not be
  -- refused because one of its batches alone would go negative (an allocation
  -- can legitimately start from an empty batch and be refilled).
  for v_item in select * from jsonb_array_elements(p_allocations) loop
    v_delta := trunc(coalesce((v_item ->> 'quantity_delta')::numeric, 0))::integer;
    if v_delta = 0 then
      raise exception 'INVALID_QUANTITY: a replay allocation must move a non-zero whole quantity';
    end if;
    v_total_delta := v_total_delta + v_delta;
  end loop;

  if coalesce(v_product.quantity, 0) + v_total_delta < 0 and not p_allow_negative then
    raise exception 'REPLAY_NEGATIVE_STOCK: % would go to %',
      v_product.name, coalesce(v_product.quantity, 0) + v_total_delta;
  end if;

  for v_item in select * from jsonb_array_elements(p_allocations) loop
    v_batch_number := nullif(trim(v_item ->> 'batch_number'), '');
    v_batch_index := coalesce((v_item ->> 'batch_index')::integer, 0);
    v_delta := trunc(coalesce((v_item ->> 'quantity_delta')::numeric, 0))::integer;
    v_expiry_date := nullif(v_item ->> 'expiry_date', '')::date;
    v_rate := nullif(v_item ->> 'rate', '')::numeric;
    v_amount := nullif(v_item ->> 'amount', '')::numeric;

    if v_batch_number is null then
      raise exception 'REPLAY_BATCH_REQUIRED: a replay movement must name the batch it moves';
    end if;

    select * into v_batch
    from public.pharmacy_product_batches
    where tenant_id = p_tenant_id
      and product_id = p_product_id
      and batch_number = v_batch_number
    for update;

    if found then
      -- A line that states no expiry does not disagree with the stored one: it
      -- moves the batch that is already named, and an OUT line never restates
      -- the expiry it is leaving. Only two stated, different expiries are a
      -- second expiry for one batch number, and that stays refused.
      if v_expiry_date is not null
         and v_batch.expiry_date is distinct from v_expiry_date then
        raise exception 'BATCH_EXPIRY_CONFLICT: batch % of % is recorded as expiring % and the export says %',
          v_batch_number, v_product.name, v_batch.expiry_date, v_expiry_date;
      end if;
      v_batch_id := v_batch.id;
      v_quantity_after := v_batch.quantity;
    else
      -- Either the export buys into a batch this pharmacy has never held, or an
      -- OUT movement names a batch older than the export window. A batch with
      -- no expiry in the export is stored far-future rather than null (the
      -- column is NOT NULL) so FEFO and the expired-batch checks treat it as
      -- usable; the provenance row keeps the true expiry, including its absence.
      insert into public.pharmacy_product_batches
        (tenant_id, product_id, batch_number, quantity, initial_quantity,
         expiry_date, received_date, cost_price, is_active, status)
      values
        (p_tenant_id, p_product_id, v_batch_number, 0,
         greatest(v_delta, 0),
         coalesce(v_expiry_date, date '9999-12-31'),
         timezone('Africa/Kampala', p_movement_date::timestamp),
         coalesce(v_rate, v_product.cost_price, 0),
         true,
         case when v_expiry_date is not null and v_expiry_date < v_kla_today
              then 'expired' else 'active' end)
      returning id into v_batch_id;

      v_quantity_after := 0;
    end if;

    if v_quantity_after + v_delta < 0 and not p_allow_negative then
      raise exception 'REPLAY_NEGATIVE_STOCK: batch % of % would go to %',
        v_batch_number, v_product.name, v_quantity_after + v_delta;
    end if;

    insert into public.pharmacy_tally_replay_movements (
      tenant_id, session_id, movement_id, source_type, source_id, source_guid,
      line_index, batch_index, movement_kind, movement_date, product_id,
      batch_id, batch_number, expiry_date, godown, quantity_delta, rate, amount,
      allocation
    ) values (
      p_tenant_id, p_session_id, p_movement_id, p_source_type, p_source_id, p_source_guid,
      p_line_index, v_batch_index, p_movement_kind, p_movement_date, p_product_id,
      v_batch_id, v_batch_number, v_expiry_date, p_godown, v_delta,
      coalesce(v_rate, 0), coalesce(v_amount, 0), p_allocation
    )
    on conflict (
      tenant_id, session_id, source_type, source_id, line_index, batch_index
    ) do nothing
    returning id into v_inserted_id;

    if v_inserted_id is null then
      -- A concurrent request applied this same allocation after the barrier
      -- above. Raise rather than continue: this transaction's provenance rows
      -- and batch writes must roll back together.
      raise exception 'TALLY_REPLAY_MOVEMENT_CONFLICT: movement % was applied by another request', p_movement_id;
    end if;

    update public.pharmacy_product_batches
    set quantity = quantity + v_delta,
        cost_price = case
          when v_delta > 0 and v_rate is not null then v_rate
          else cost_price
        end,
        updated_at = now()
    where id = v_batch_id;

    v_quantity_after := v_quantity_after + v_delta;
    v_applied := v_applied || jsonb_build_array(jsonb_build_object(
      'batch_id', v_batch_id,
      'batch_number', v_batch_number,
      'batch_index', v_batch_index,
      'quantity_delta', v_delta,
      'quantity_after', v_quantity_after
    ));
  end loop;

  update public.pharmacy_products
  set quantity = coalesce(quantity, 0) + v_total_delta,
      updated_at = now()
  where id = p_product_id
  returning quantity into v_product_quantity;

  return jsonb_build_object(
    'replayed', false,
    'movement_id', p_movement_id,
    'allocations', v_applied,
    'product_quantity_after', v_product_quantity
  );
end;
$function$;

comment on function public.apply_pharmacy_tally_replay_movement(
  uuid, uuid, text, text, text, text, integer, text, date, uuid, text, text,
  jsonb, boolean
) is
  'Applies one historical stock movement from a Tally replay, together with every batch allocation it touches, in one transaction. Idempotent on (tenant, session, source_type, source_id, line_index): a repeated call changes nothing and leaves no batch behind, and a key an un-reversed earlier session applied is skipped as overlap. Accepts expired and backdated batches by design; receive_pharmacy_stock is unchanged.';

-- ---------------------------------------------------------------------------
-- 4. The closing read.
--
-- Stock is compared per item and per named batch; account balances are the
-- debit/credit sums per account, which the caller signs by `normal_balance`
-- the same way `pharmacy_accounting_trial_balance` does. One jsonb payload, so
-- no response cap can quietly truncate the comparison.
--
-- A stock item or account Tally names but this returns no row for is a
-- difference, not a pass — the caller must treat a missing key as expected
-- versus actual 0 and let reconciliation say so.
-- ---------------------------------------------------------------------------
create or replace function public.pharmacy_tally_replay_actuals(p_tenant_id uuid)
returns jsonb
language sql
stable
security definer
set search_path to ''
as $function$
  select jsonb_build_object(
    'products', coalesce((
      select jsonb_agg(jsonb_build_object(
        'product_id', p.id,
        'name', p.name,
        'quantity', coalesce(p.quantity, 0)
      ) order by p.id)
      from public.pharmacy_products p
      where p.tenant_id = p_tenant_id
    ), '[]'::jsonb),
    'batches', coalesce((
      select jsonb_agg(jsonb_build_object(
        'product_id', b.product_id,
        'batch_number', b.batch_number,
        'expiry_date', b.expiry_date,
        'quantity', coalesce(b.quantity, 0)
      ) order by b.product_id, b.batch_number)
      from public.pharmacy_product_batches b
      where b.tenant_id = p_tenant_id
    ), '[]'::jsonb),
    'accounts', coalesce((
      select jsonb_agg(jsonb_build_object(
        'account_id', a.id,
        'code', a.code,
        'name', a.name,
        'normal_balance', a.normal_balance,
        'debit', coalesce(l.debit, 0),
        'credit', coalesce(l.credit, 0)
      ) order by a.code)
      from public.pharmacy_accounting_accounts a
      left join (
        select jl.account_id,
               sum(jl.debit) as debit,
               sum(jl.credit) as credit
        from public.pharmacy_accounting_journal_lines jl
        where jl.tenant_id = p_tenant_id
        group by jl.account_id
      ) l on l.account_id = a.id
      where a.tenant_id = p_tenant_id
    ), '[]'::jsonb)
  );
$function$;

comment on function public.pharmacy_tally_replay_actuals(uuid) is
  'Closing state for the replay-closing stage: per-product quantity, per-batch quantity and per-account debit/credit, in one uncapped payload.';

-- ---------------------------------------------------------------------------
-- 5. Read-only for application roles; service role writes.
-- ---------------------------------------------------------------------------
alter table public.pharmacy_tally_replay_movements enable row level security;

revoke all on public.pharmacy_tally_replay_movements from public, anon, authenticated;
grant select on public.pharmacy_tally_replay_movements to authenticated;
grant select, insert, update, delete on public.pharmacy_tally_replay_movements to service_role;

create policy pharmacy_tally_replay_movements_tenant_read
  on public.pharmacy_tally_replay_movements
  for select
  to authenticated
  using (
    tenant_id = any (public.pharmacy_caller_tenants())
    or public.is_platform_admin()
  );

revoke all on function public.guard_pharmacy_tally_replay_movement() from public, anon, authenticated;
revoke all on function public.apply_pharmacy_tally_replay_movement(
  uuid, uuid, text, text, text, text, integer, text, date, uuid, text, text,
  jsonb, boolean
) from public, anon, authenticated;
revoke all on function public.pharmacy_tally_replay_actuals(uuid) from public, anon, authenticated;

grant execute on function public.apply_pharmacy_tally_replay_movement(
  uuid, uuid, text, text, text, text, integer, text, date, uuid, text, text,
  jsonb, boolean
) to service_role;
grant execute on function public.pharmacy_tally_replay_actuals(uuid) to service_role;

commit;
