-- 20261107120000_pharmacy_tally_replay_continuation
--
-- Continuation and compensating rollback for the replay import (Phase D of
-- docs/pharmacy/TALLY_MIGRATION_ARCHITECTURE.md). Three objects:
--
--   1. `pharmacy_tally_replay_checkpoints` — append-only record of the closing
--      position every clean replay reached, one row per company per cutoff
--      date. It is what a later export is allowed to continue from, and what
--      the continuation's opening stages verify the database against instead
--      of re-applying an opening position that is already there.
--
--   2. `record_pharmacy_tally_replay_checkpoint(...)` / the read function —
--      the only way a checkpoint is appended. The RPC refuses one that does
--      not advance the company's period, and is idempotent on the cutoff, so
--      a resumed closing stage appends it once.
--
--   3. `reverse_pharmacy_tally_replay_session(...)` — compensating rollback.
--      Nothing is deleted: each applied movement gets an inverse movement, and
--      the pair is linked by `reverses_movement_id` so the replay barrier knows
--      the original no longer stands. Rollback is refused outright once any
--      post-cut-over operational activity exists, because reversing then would
--      undo real trading, not history.
--
-- The stock replay's identity key is (tenant, session, source_type, source_id,
-- line_index, batch_index) since 20261106120000 was amended to include the
-- session: after a rollback a fresh import must be able to apply the same
-- export again, while overlap with an earlier un-reversed session is skipped
-- by the barrier's second check.
--
-- PREPARED ONLY: this migration has not been applied to any database by this
-- change. The owner runs it on a non-production database first.
--
-- Tenant isolation follows 20261102130000, the current house pattern:
-- `tenant_id = any (public.pharmacy_caller_tenants()) or
-- public.is_platform_admin()`, scoped `TO authenticated`.

begin;

-- ---------------------------------------------------------------------------
-- 1. Checkpoints.
--
-- `closing_state` is the simulated state the closing stage compared the
-- database with — not a copy of the database. Storing the reviewed position
-- means a continuation's opening verification compares against the same
-- figures the previous session was signed off on.
--
-- `previous_id` chains checkpoints for one company even if a cutoff date is
-- later corrected by starting a new import, so the history of what was
-- continued from is never ambiguous.
-- ---------------------------------------------------------------------------
create table if not exists public.pharmacy_tally_replay_checkpoints (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references public.tenants(id) on delete cascade,
  company_key   text not null,
  session_id    uuid not null references public.pharmacy_import_sessions(id) on delete cascade,
  previous_id   uuid references public.pharmacy_tally_replay_checkpoints(id) on delete set null,
  through_date  date not null,
  closing_state jsonb not null default '{}'::jsonb,
  created_at    timestamptz not null default now(),
  constraint pharmacy_tally_replay_checkpoints_identity_key
    unique (tenant_id, company_key, through_date)
);

create index if not exists idx_pharmacy_tally_replay_checkpoints_company
  on public.pharmacy_tally_replay_checkpoints (tenant_id, company_key, through_date desc);

-- ---------------------------------------------------------------------------
-- 2. Append-only guard.
--
-- Same rule as the movement provenance: a correction is a new checkpoint, not
-- an edit of the one a continuation already relied on. DELETE is permitted
-- only once the owning session is gone, which is what the tenant purge's
-- cascade produces without it needing to know this trigger's name.
-- ---------------------------------------------------------------------------
create or replace function public.guard_pharmacy_tally_replay_checkpoint()
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
  raise exception 'TALLY_REPLAY_CHECKPOINTS_IMMUTABLE: a replay checkpoint is recorded history; append a new one instead';
end;
$function$;

drop trigger if exists pharmacy_tally_replay_checkpoints_immutable
  on public.pharmacy_tally_replay_checkpoints;
create trigger pharmacy_tally_replay_checkpoints_immutable
  before update or delete on public.pharmacy_tally_replay_checkpoints
  for each row execute function public.guard_pharmacy_tally_replay_checkpoint();

-- ---------------------------------------------------------------------------
-- 3. Append a checkpoint.
--
-- Called by the closing stage only after the database matched the reviewed
-- position. Three properties matter:
--
--   a. it is idempotent on (company, cutoff), so a closing stage re-run after
--      a crash between the check and `complete` appends nothing new;
--   b. a cutoff that does not advance the company's period is refused, so a
--      stale export cannot claim to continue from where another already did;
--   c. the session must be the tenant's Tally session, the same test the
--      movement write uses.
-- ---------------------------------------------------------------------------
create or replace function public.record_pharmacy_tally_replay_checkpoint(
  p_tenant_id uuid,
  p_session_id uuid,
  p_company_key text,
  p_through_date date,
  p_closing_state jsonb
)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_session_source text;
  v_session_mapping jsonb;
  v_previous public.pharmacy_tally_replay_checkpoints%rowtype;
  v_existing public.pharmacy_tally_replay_checkpoints%rowtype;
  v_inserted_id uuid;
begin
  if p_tenant_id is null or p_session_id is null then
    raise exception 'TALLY_CHECKPOINT_SESSION_REQUIRED: a checkpoint must name its import session';
  end if;
  if nullif(trim(p_company_key), '') is null then
    raise exception 'TALLY_CHECKPOINT_COMPANY_REQUIRED: a checkpoint must name its company';
  end if;
  if p_through_date is null then
    raise exception 'TALLY_CHECKPOINT_DATE_REQUIRED: a checkpoint must state the date it closes at';
  end if;

  select s.source_system, s.ai_mapping into v_session_source, v_session_mapping
  from public.pharmacy_import_sessions s
  where s.id = p_session_id and s.tenant_id = p_tenant_id;

  if coalesce(v_session_source, 'Tally') <> 'Tally'
     or coalesce(v_session_mapping ->> 'format', '') not in ('xml', 'xlsx', 'xls', 'csv') then
    raise exception 'TALLY_CHECKPOINT_NOT_TALLY: session % is not a Tally import of this pharmacy', p_session_id;
  end if;

  select * into v_existing
  from public.pharmacy_tally_replay_checkpoints c
  where c.tenant_id = p_tenant_id
    and c.company_key = p_company_key
    and c.through_date = p_through_date;

  if found then
    -- A different session claiming an already-recorded cutoff is the stale
    -- case, not the idempotent one: it means two imports think they closed the
    -- same period.
    if v_existing.session_id <> p_session_id then
      raise exception 'TALLY_CHECKPOINT_TAKEN: % is already recorded as closed at % by session %',
        p_company_key, p_through_date, v_existing.session_id;
    end if;
    return jsonb_build_object(
      'id', v_existing.id,
      'company_key', v_existing.company_key,
      'through_date', v_existing.through_date,
      'previous_id', v_existing.previous_id,
      'created', false
    );
  end if;

  select * into v_previous
  from public.pharmacy_tally_replay_checkpoints c
  where c.tenant_id = p_tenant_id
    and c.company_key = p_company_key
  order by c.through_date desc
  limit 1;

  if found and p_through_date <= v_previous.through_date then
    raise exception 'TALLY_CHECKPOINT_NOT_ADVANCING: % already reaches % and this session closes at %',
      p_company_key, v_previous.through_date, p_through_date;
  end if;

  insert into public.pharmacy_tally_replay_checkpoints (
    tenant_id, company_key, session_id, previous_id, through_date, closing_state
  ) values (
    p_tenant_id, p_company_key, p_session_id,
    case when v_previous.id is not null then v_previous.id else null end,
    p_through_date, coalesce(p_closing_state, '{}'::jsonb)
  )
  on conflict (tenant_id, company_key, through_date) do nothing
  returning id into v_inserted_id;

  if v_inserted_id is null then
    -- A concurrent closing won the race between the read above and this
    -- insert. Re-read: if it was this session, that is the same idempotent
    -- case; if it was another, say so rather than pretending success.
    select * into v_existing
    from public.pharmacy_tally_replay_checkpoints c
    where c.tenant_id = p_tenant_id
      and c.company_key = p_company_key
      and c.through_date = p_through_date;

    if not found or v_existing.session_id <> p_session_id then
      raise exception 'TALLY_CHECKPOINT_TAKEN: % was recorded at % by another request',
        p_company_key, p_through_date;
    end if;
    return jsonb_build_object(
      'id', v_existing.id,
      'company_key', v_existing.company_key,
      'through_date', v_existing.through_date,
      'previous_id', v_existing.previous_id,
      'created', false
    );
  end if;

  return jsonb_build_object(
    'id', v_inserted_id,
    'company_key', p_company_key,
    'through_date', p_through_date,
    'previous_id', case when v_previous.id is not null then v_previous.id else null end,
    'created', true
  );
end;
$function$;

comment on function public.record_pharmacy_tally_replay_checkpoint(
  uuid, uuid, text, date, jsonb
) is
  'Appends the closing position a clean Tally replay reached. Idempotent on (tenant, company, cutoff) for the same session; refuses a cutoff that does not advance the company period or is already claimed by another session.';

-- ---------------------------------------------------------------------------
-- 4. Read the latest checkpoint.
--
-- One function serves the continuation guard (does this company have a
-- position to continue from, and does this session continue it?) and the
-- opening verification. Rows are returned whole because `closing_state` is
-- what the verification compares against.
-- ---------------------------------------------------------------------------
create or replace function public.pharmacy_tally_replay_checkpoint(
  p_tenant_id uuid,
  p_company_key text
)
returns jsonb
language sql
stable
security definer
set search_path to ''
as $function$
  select jsonb_build_object(
    'id', c.id,
    'company_key', c.company_key,
    'session_id', c.session_id,
    'previous_id', c.previous_id,
    'through_date', c.through_date,
    'closing_state', c.closing_state,
    'created_at', c.created_at
  )
  from public.pharmacy_tally_replay_checkpoints c
  where c.tenant_id = p_tenant_id
    and c.company_key = p_company_key
  order by c.through_date desc
  limit 1;
$function$;

comment on function public.pharmacy_tally_replay_checkpoint(uuid, text) is
  'The latest replay checkpoint a company reached, with the closing state a continuation verifies against. Null when the company has none.';

-- ---------------------------------------------------------------------------
-- 5. Compensating rollback of stock.
--
-- Never a delete. Every provenance row this session applied gets an inverse
-- row in the same table, linked by `reverses_movement_id`, and the batch and
-- product quantities move by the negated delta. The inverse row's identity
-- names the original so a repeated rollback is a no-op, and the replay barrier
-- ignores reversed originals so a fresh import can apply the export again.
--
-- Reversal order is the reverse of application order. Undoing a purchase
-- before the sale it fed would take the product negative on the way, even
-- though the final state is the checkpoint's; reversing newest-first never
-- dips below what was actually held.
--
-- Refusals:
--   * the session is not this tenant's, is not complete, or has no checkpoint;
--   * a later checkpoint exists for the company (roll the newest one back
--     first — otherwise a continuation would be left applied on top of a
--     rolled-back base);
--   * any post-cut-over activity exists: a journal, sale, purchase or replay
--     movement dated after the checkpoint. Rolling back then would undo real
--     trading. The operator is told to recover by hand.
-- ---------------------------------------------------------------------------
create or replace function public.reverse_pharmacy_tally_replay_session(
  p_tenant_id uuid,
  p_session_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_session public.pharmacy_import_sessions%rowtype;
  v_checkpoint public.pharmacy_tally_replay_checkpoints%rowtype;
  v_latest public.pharmacy_tally_replay_checkpoints%rowtype;
  v_movement public.pharmacy_tally_replay_movements%rowtype;
  v_batch_quantity integer;
  v_product_ids uuid[] := array[]::uuid[];
  v_product_deltas integer[] := array[]::integer[];
  v_position integer;
  v_inverse_id uuid;
  v_batches integer := 0;
  v_products integer := 0;
begin
  if p_tenant_id is null or p_session_id is null then
    raise exception 'TALLY_REVERSAL_SESSION_REQUIRED: a rollback must name its import session';
  end if;

  select * into v_session
  from public.pharmacy_import_sessions s
  where s.id = p_session_id and s.tenant_id = p_tenant_id;

  if not found
     or coalesce(v_session.source_system, 'Tally') <> 'Tally'
     or coalesce(v_session.ai_mapping ->> 'format', '') not in ('xml', 'xlsx', 'xls', 'csv') then
    raise exception 'TALLY_REVERSAL_NOT_TALLY: session % is not a Tally import of this pharmacy', p_session_id;
  end if;

  if v_session.status <> 'complete' then
    raise exception 'TALLY_REVERSAL_NOT_COMPLETE: session % is % and has no applied history to reverse',
      p_session_id, v_session.status;
  end if;

  select * into v_checkpoint
  from public.pharmacy_tally_replay_checkpoints c
  where c.tenant_id = p_tenant_id
    and c.session_id = p_session_id
  order by c.through_date desc
  limit 1;

  if not found then
    raise exception 'TALLY_REVERSAL_NO_CHECKPOINT: session % closed without a replay checkpoint', p_session_id;
  end if;

  select * into v_latest
  from public.pharmacy_tally_replay_checkpoints c
  where c.tenant_id = p_tenant_id
    and c.company_key = v_checkpoint.company_key
  order by c.through_date desc
  limit 1;

  if v_latest.id <> v_checkpoint.id then
    raise exception 'TALLY_REVERSAL_NOT_NEWEST: % has since been continued to % by session %; roll that session back first',
      v_checkpoint.company_key, v_latest.through_date, v_latest.session_id;
  end if;

  if exists (
    select 1 from public.pharmacy_accounting_journal_entries e
    where e.tenant_id = p_tenant_id
      and e.entry_date > v_checkpoint.through_date
  ) then
    raise exception 'TALLY_REVERSAL_ACTIVITY: accounting journals dated after % exist; reversing now would undo trading, so this import must be recovered by hand',
      v_checkpoint.through_date;
  end if;

  if exists (
    select 1 from public.pharmacy_transactions t
    where t.tenant_id = p_tenant_id
      and (t.created_at at time zone 'Africa/Kampala')::date > v_checkpoint.through_date
  ) then
    raise exception 'TALLY_REVERSAL_ACTIVITY: sales dated after % exist; reversing now would undo trading, so this import must be recovered by hand',
      v_checkpoint.through_date;
  end if;

  if exists (
    select 1 from public.pharmacy_purchases p
    where p.tenant_id = p_tenant_id
      and p.purchase_date > v_checkpoint.through_date
  ) then
    raise exception 'TALLY_REVERSAL_ACTIVITY: purchases dated after % exist; reversing now would undo trading, so this import must be recovered by hand',
      v_checkpoint.through_date;
  end if;

  if exists (
    select 1 from public.pharmacy_tally_replay_movements m
    where m.tenant_id = p_tenant_id
      and m.session_id <> p_session_id
      and m.movement_date > v_checkpoint.through_date
  ) then
    raise exception 'TALLY_REVERSAL_ACTIVITY: replay movements dated after % exist; reversing now would undo a continuation, so roll it back first',
      v_checkpoint.through_date;
  end if;

  for v_movement in
    select m.*
    from public.pharmacy_tally_replay_movements m
    where m.tenant_id = p_tenant_id
      and m.session_id = p_session_id
      and m.source_type <> 'tally_replay_reversal'
      and not exists (
        select 1
        from public.pharmacy_tally_replay_movements r
        where r.reverses_movement_id = m.id
      )
    order by m.movement_date desc, m.created_at desc, m.id desc
  loop
    -- The inverse row's identity names the original, so one rollback per
    -- session is enough no matter how often the request is retried.
    insert into public.pharmacy_tally_replay_movements (
      tenant_id, session_id, movement_id, source_type, source_id, source_guid,
      line_index, batch_index, movement_kind, movement_date, product_id,
      batch_id, batch_number, expiry_date, godown, quantity_delta, rate, amount,
      allocation, reverses_movement_id
    ) values (
      p_tenant_id, p_session_id,
      'REVERSAL:' || v_movement.movement_id,
      'tally_replay_reversal',
      'tally_replay_reversal:' || v_movement.source_type || ':' || v_movement.source_id,
      v_movement.source_guid,
      v_movement.line_index, v_movement.batch_index, 'physical_adjust',
      v_movement.movement_date, v_movement.product_id, v_movement.batch_id,
      v_movement.batch_number, v_movement.expiry_date, v_movement.godown,
      -v_movement.quantity_delta, v_movement.rate, v_movement.amount,
      v_movement.allocation, v_movement.id
    )
    on conflict (
      tenant_id, session_id, source_type, source_id, line_index, batch_index
    ) do nothing
    returning id into v_inverse_id;

    if v_inverse_id is null then
      continue;
    end if;

    if v_movement.batch_id is not null then
      select quantity into v_batch_quantity
      from public.pharmacy_product_batches b
      where b.id = v_movement.batch_id
      for update;

      if found then
        if v_batch_quantity - v_movement.quantity_delta < 0 then
          raise exception 'TALLY_REVERSAL_NEGATIVE_STOCK: batch % of this import would go to %; the stock no longer matches the import and must be recovered by hand',
            v_movement.batch_number, v_batch_quantity - v_movement.quantity_delta;
        end if;

        update public.pharmacy_product_batches
        set quantity = quantity - v_movement.quantity_delta,
            updated_at = now()
        where id = v_movement.batch_id;

        v_batches := v_batches + 1;
      end if;
    end if;

    -- Product totals are accumulated and written once at the end: a movement
    -- whose batch is already gone still reduces the product by its delta.
    v_position := array_position(v_product_ids, v_movement.product_id);
    if v_position is null then
      v_product_ids := v_product_ids || v_movement.product_id;
      v_product_deltas := v_product_deltas || (-v_movement.quantity_delta);
    else
      v_product_deltas[v_position] := v_product_deltas[v_position] - v_movement.quantity_delta;
    end if;
  end loop;

  for v_position in 1 .. coalesce(array_length(v_product_ids, 1), 0) loop
    update public.pharmacy_products
    set quantity = coalesce(quantity, 0) + v_product_deltas[v_position],
        updated_at = now()
    where id = v_product_ids[v_position]
      and tenant_id = p_tenant_id
      and coalesce(quantity, 0) + v_product_deltas[v_position] >= 0;

    if not found then
      raise exception 'TALLY_REVERSAL_NEGATIVE_STOCK: a product of this import would go below zero; the stock no longer matches the import and must be recovered by hand';
    end if;

    v_products := v_products + 1;
  end loop;

  return jsonb_build_object(
    'session_id', p_session_id,
    'company_key', v_checkpoint.company_key,
    'through_date', v_checkpoint.through_date,
    'movements_reversed', (
      select count(*)
      from public.pharmacy_tally_replay_movements m
      where m.tenant_id = p_tenant_id
        and m.session_id = p_session_id
        and m.source_type = 'tally_replay_reversal'
    ),
    'batches_updated', v_batches,
    'products_updated', v_products
  );
end;
$function$;

comment on function public.reverse_pharmacy_tally_replay_session(uuid, uuid) is
  'Compensating rollback of one replay session''s stock: an inverse movement per applied movement, linked by reverses_movement_id, never a delete. Refused once the company has been continued past this checkpoint or any post-cut-over journal, sale, purchase or replay movement exists.';

-- ---------------------------------------------------------------------------
-- 6. Let a valid continuation take the cut-over lock.
--
-- The lock names the applying session and is never cleared on completion, so
-- without this a continuation of a completed import could never apply. The
-- takeover is narrow: the requesting session must itself record the lock's
-- session as its `continuationOf`. The old payload is re-issued unchanged
-- apart from that clause.
-- ---------------------------------------------------------------------------
create or replace function public.claim_pharmacy_tally_cutover_apply(
  p_tenant_id uuid,
  p_session_id uuid,
  p_lease_token uuid
)
returns text
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_session_id uuid;
  v_lease_token uuid;
  v_lease_expires_at timestamptz;
begin
  if p_lease_token is null then
    raise exception 'Tally apply lease token is required';
  end if;

  if not exists (
    select 1
    from public.pharmacy_import_sessions
    where id = p_session_id
      and tenant_id = p_tenant_id
      and source_system = 'Tally'
  ) then
    return 'invalid_session';
  end if;

  insert into public.pharmacy_tally_cutover_locks (
    tenant_id,
    session_id,
    lease_token,
    lease_expires_at
  )
  values (
    p_tenant_id,
    p_session_id,
    p_lease_token,
    clock_timestamp() + interval '15 minutes'
  )
  on conflict (tenant_id) do nothing;

  select session_id, lease_token, lease_expires_at
  into v_session_id, v_lease_token, v_lease_expires_at
  from public.pharmacy_tally_cutover_locks
  where tenant_id = p_tenant_id
  for update;

  if v_session_id is distinct from p_session_id then
    -- A continuation of the session the lock names takes it over. The
    -- completed session can no longer apply, so leaving the lock there would
    -- make every continuation report "owned by another session".
    if not exists (
      select 1
      from public.pharmacy_import_sessions s
      where s.id = p_session_id
        and s.tenant_id = p_tenant_id
        and s.ai_mapping ->> 'continuationOf' = v_session_id::text
    ) then
      return 'owned_by_another_session';
    end if;

    update public.pharmacy_tally_cutover_locks
    set session_id = p_session_id,
        lease_token = null,
        lease_expires_at = null
    where tenant_id = p_tenant_id;

    select session_id, lease_token, lease_expires_at
    into v_session_id, v_lease_token, v_lease_expires_at
    from public.pharmacy_tally_cutover_locks
    where tenant_id = p_tenant_id
    for update;
  end if;

  if v_lease_token is not null and v_lease_expires_at > clock_timestamp() then
    return 'busy';
  end if;

  update public.pharmacy_tally_cutover_locks
  set lease_token = p_lease_token,
      lease_expires_at = clock_timestamp() + interval '15 minutes'
  where tenant_id = p_tenant_id;

  return 'acquired';
end;
$function$;

-- ---------------------------------------------------------------------------
-- 7. Read-only for application roles; service role writes.
-- ---------------------------------------------------------------------------
alter table public.pharmacy_tally_replay_checkpoints enable row level security;

revoke all on public.pharmacy_tally_replay_checkpoints from public, anon, authenticated;
grant select on public.pharmacy_tally_replay_checkpoints to authenticated;
grant select, insert, update, delete on public.pharmacy_tally_replay_checkpoints to service_role;

create policy pharmacy_tally_replay_checkpoints_tenant_read
  on public.pharmacy_tally_replay_checkpoints
  for select
  to authenticated
  using (
    tenant_id = any (public.pharmacy_caller_tenants())
    or public.is_platform_admin()
  );

revoke all on function public.guard_pharmacy_tally_replay_checkpoint() from public, anon, authenticated;
revoke all on function public.record_pharmacy_tally_replay_checkpoint(uuid, uuid, text, date, jsonb) from public, anon, authenticated;
revoke all on function public.pharmacy_tally_replay_checkpoint(uuid, text) from public, anon, authenticated;
revoke all on function public.reverse_pharmacy_tally_replay_session(uuid, uuid) from public, anon, authenticated;
revoke all on function public.claim_pharmacy_tally_cutover_apply(uuid, uuid, uuid) from public, anon, authenticated;

grant execute on function public.record_pharmacy_tally_replay_checkpoint(uuid, uuid, text, date, jsonb) to service_role;
grant execute on function public.pharmacy_tally_replay_checkpoint(uuid, text) to service_role;
grant execute on function public.reverse_pharmacy_tally_replay_session(uuid, uuid) to service_role;
grant execute on function public.claim_pharmacy_tally_cutover_apply(uuid, uuid, uuid) to service_role;

commit;
