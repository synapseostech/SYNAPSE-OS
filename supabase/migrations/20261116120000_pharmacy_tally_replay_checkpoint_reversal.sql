-- 20261116120000_pharmacy_tally_replay_checkpoint_reversal
--
-- A rolled-back replay must stop holding its period.
--
-- 20261107120000 made a checkpoint append-only and unique per company and
-- cutoff date, and its rollback reverses the session's stock but leaves the
-- checkpoint as it was. The next import of the same export then replays
-- cleanly, passes the closing check, and is refused at the very last step:
-- TALLY_CHECKPOINT_TAKEN, because the reversed session still "closes" that
-- date. The same stale row also answers the continuation guard and the
-- rollback's newest-checkpoint test as if it were still in force.
--
-- Nothing is deleted here either. A checkpoint gains `reversed_at`, which the
-- rollback stamps once; the append-only guard lets exactly that one change
-- through and still refuses every other. Uniqueness, the record function, the
-- read function and the rollback's own checks then consider only checkpoints
-- that are not reversed, so the reversed one stays as history and the next
-- import can close the same period.
--
-- PREPARED ONLY: written for review. It has not been applied to any database
-- by this change; the owner runs it on a non-production database first.

begin;

-- ---------------------------------------------------------------------------
-- 1. The mark.
-- ---------------------------------------------------------------------------
alter table public.pharmacy_tally_replay_checkpoints
  add column if not exists reversed_at timestamptz;

comment on column public.pharmacy_tally_replay_checkpoints.reversed_at is
  'Set once, by reverse_pharmacy_tally_replay_session, when the session that reached this checkpoint was rolled back. A reversed checkpoint is history: it no longer closes its period.';

-- ---------------------------------------------------------------------------
-- 2. Append-only, except for stamping the mark once.
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
  -- The one permitted update: a rollback marking the checkpoint reversed.
  -- Every other column must be unchanged, and the mark is never cleared.
  if tg_op = 'UPDATE'
     and old.reversed_at is null
     and new.reversed_at is not null
     and (to_jsonb(new) - 'reversed_at') = (to_jsonb(old) - 'reversed_at') then
    return new;
  end if;
  raise exception 'TALLY_REPLAY_CHECKPOINTS_IMMUTABLE: a replay checkpoint is recorded history; append a new one instead';
end;
$function$;

-- ---------------------------------------------------------------------------
-- 3. Backfill: checkpoints of sessions already rolled back.
--
-- A session counts as rolled back when the app recorded it (`reversedAt`) or
-- when the stock rollback wrote its inverse movements.
-- ---------------------------------------------------------------------------
update public.pharmacy_tally_replay_checkpoints c
set reversed_at = coalesce(
  (
    select nullif(s.ai_mapping ->> 'reversedAt', '')::timestamptz
    from public.pharmacy_import_sessions s
    where s.id = c.session_id
  ),
  now()
)
where c.reversed_at is null
  and (
    exists (
      select 1 from public.pharmacy_import_sessions s
      where s.id = c.session_id
        and nullif(s.ai_mapping ->> 'reversedAt', '') is not null
    )
    or exists (
      select 1 from public.pharmacy_tally_replay_movements m
      where m.session_id = c.session_id
        and m.tenant_id = c.tenant_id
        and m.source_type = 'tally_replay_reversal'
    )
  );

-- ---------------------------------------------------------------------------
-- 4. One checkpoint in force per company and cutoff.
-- ---------------------------------------------------------------------------
alter table public.pharmacy_tally_replay_checkpoints
  drop constraint if exists pharmacy_tally_replay_checkpoints_identity_key;

create unique index if not exists pharmacy_tally_replay_checkpoints_in_force_key
  on public.pharmacy_tally_replay_checkpoints (tenant_id, company_key, through_date)
  where reversed_at is null;

-- ---------------------------------------------------------------------------
-- 5. Record a checkpoint: only checkpoints in force count.
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
    and c.through_date = p_through_date
    and c.reversed_at is null;

  if found then
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
    and c.reversed_at is null
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
  on conflict (tenant_id, company_key, through_date) where reversed_at is null do nothing
  returning id into v_inserted_id;

  if v_inserted_id is null then
    select * into v_existing
    from public.pharmacy_tally_replay_checkpoints c
    where c.tenant_id = p_tenant_id
      and c.company_key = p_company_key
      and c.through_date = p_through_date
      and c.reversed_at is null;

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
  'Appends the closing position a clean Tally replay reached. Idempotent on (tenant, company, cutoff) for the same session; refuses a cutoff that does not advance the company period or is already claimed by another session. Reversed checkpoints are ignored.';

-- ---------------------------------------------------------------------------
-- 6. The latest checkpoint in force.
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
    and c.reversed_at is null
  order by c.through_date desc
  limit 1;
$function$;

comment on function public.pharmacy_tally_replay_checkpoint(uuid, text) is
  'The latest replay checkpoint in force for a company, with the closing state a continuation verifies against. Null when the company has none; a reversed checkpoint is never returned.';

-- ---------------------------------------------------------------------------
-- 7. Rollback stamps its checkpoint, and a repeat is a no-op.
--
-- Unchanged from 20261107120000 except: the newest-checkpoint test considers
-- only checkpoints in force; a session whose checkpoint is already reversed
-- answers with what was reversed instead of refusing; and the checkpoint is
-- stamped reversed once its stock has been undone.
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

  -- Already rolled back: the stock was undone when the mark was stamped. A
  -- retried request (the journals half failed, say) gets the same answer.
  if v_checkpoint.reversed_at is not null then
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
      'batches_updated', 0,
      'products_updated', 0,
      'already_reversed', true
    );
  end if;

  select * into v_latest
  from public.pharmacy_tally_replay_checkpoints c
  where c.tenant_id = p_tenant_id
    and c.company_key = v_checkpoint.company_key
    and c.reversed_at is null
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

  -- The session no longer closes its period: the next import may.
  update public.pharmacy_tally_replay_checkpoints
  set reversed_at = now()
  where id = v_checkpoint.id
    and reversed_at is null;

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
  'Compensating rollback of one replay session''s stock: an inverse movement per applied movement, linked by reverses_movement_id, never a delete. Marks the session''s checkpoint reversed so the period can be imported again; a repeat answers already_reversed. Refused once the company has been continued past this checkpoint or any post-cut-over journal, sale, purchase or replay movement exists.';

-- ---------------------------------------------------------------------------
-- 8. Privileges are unchanged; re-stated because the functions were replaced.
-- ---------------------------------------------------------------------------
revoke all on function public.guard_pharmacy_tally_replay_checkpoint() from public, anon, authenticated;
revoke all on function public.record_pharmacy_tally_replay_checkpoint(uuid, uuid, text, date, jsonb) from public, anon, authenticated;
revoke all on function public.pharmacy_tally_replay_checkpoint(uuid, text) from public, anon, authenticated;
revoke all on function public.reverse_pharmacy_tally_replay_session(uuid, uuid) from public, anon, authenticated;

grant execute on function public.record_pharmacy_tally_replay_checkpoint(uuid, uuid, text, date, jsonb) to service_role;
grant execute on function public.pharmacy_tally_replay_checkpoint(uuid, text) to service_role;
grant execute on function public.reverse_pharmacy_tally_replay_session(uuid, uuid) to service_role;

commit;
