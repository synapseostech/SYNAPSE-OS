-- 20261119160000_pharmacy_stock_take
--
-- PREPARED ONLY — NOT APPLIED TO ANY DATABASE BY THIS CHANGE.
--
-- Physical stock-take that several staff count from their phones and a manager
-- posts. Built for the first count after a Tally cut-over, where the book can
-- hold items below zero because Tally allowed negative stock.
--
--   pharmacy_stock_takes            one count session (whole store or categories)
--   pharmacy_stock_take_counts      what each counter entered, per product and
--                                   batch key; last write per counter wins
--   pharmacy_stock_take_overrides   the manager's recount, which replaces the
--                                   summed counts for one product/batch key
--   pharmacy_stock_take_postings    what posting changed, batch by batch
--
-- A batch key is the batch id (text) for a batch already on the book,
-- 'unbatched' for stock the counter could not tie to a batch, or
-- 'new:<BATCH NUMBER>' for a batch found on the shelf that the book does not
-- know (it must carry an expiry date).
--
-- Posting is one call to post_pharmacy_stock_take, so it commits or rolls back
-- as a whole. For every product that was counted:
--   * a counted batch is set to its counted quantity;
--   * a batch below zero that was not counted (the NEG-STOCK overdraft batch
--     the sale RPC creates) is set to 0 — physical stock cannot be negative;
--   * active batches that were not counted share the 'unbatched' count, the
--     latest expiry kept first (the earliest expiry is assumed sold first);
--     anything left over lands on a COUNT-<reference> batch;
--   * quarantined, damaged, recalled and expired batches that were not counted
--     are left alone — they are not on the selling shelf;
--   * pharmacy_products.quantity becomes the sum of the product's batches, so
--     product and batch totals agree again.
-- Every change writes a PHYSICAL row in pharmacy_stock_adjustments (linked by
-- stock_take_id, created_by and approved_by = the posting manager), one
-- pharmacy_audit_logs row per product, and a pharmacy_stock_take_postings row
-- with book quantity, final quantity and value at cost.
--
-- Products in scope that nobody counted are not changed. The review screen
-- lists them, negative ones first, so they are counted (a 0 is a count).
--
-- Tenant isolation follows 20261102130000: `authenticated` may SELECT rows of
-- its own tenants (`tenant_id = any (public.pharmacy_caller_tenants())` or
-- platform admin). Writes come from the service role through the mobile API.
-- Triggers refuse counts once counting has closed, and refuse overrides once
-- the take is posted or cancelled; the posting RPC locks the take row first, so
-- a late count cannot slip in while it runs.
--
-- Rollback: drop the four tables, the function, the two guard functions, and
-- the stock_take_id column on pharmacy_stock_adjustments. Nothing else changes.

begin;

-- ---------------------------------------------------------------------------
-- 1. Sessions
-- ---------------------------------------------------------------------------
create table if not exists public.pharmacy_stock_takes (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  reference text not null,
  title text not null,
  scope_type text not null default 'all'
    check (scope_type in ('all', 'category')),
  scope_categories text[] not null default '{}',
  blind boolean not null default true,
  status text not null default 'counting'
    check (status in ('counting', 'review', 'posted', 'cancelled')),
  notes text,
  opened_by uuid not null,
  opened_at timestamptz not null default now(),
  closed_by uuid,
  closed_at timestamptz,
  posted_by uuid,
  posted_at timestamptz,
  cancelled_by uuid,
  cancelled_at timestamptz,
  posting_summary jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint pharmacy_stock_takes_reference_unique unique (tenant_id, reference),
  constraint pharmacy_stock_takes_category_scope check (
    scope_type <> 'category' or cardinality(scope_categories) > 0
  )
);

-- One live count per pharmacy: every phone joins the same session.
create unique index if not exists pharmacy_stock_takes_one_open
  on public.pharmacy_stock_takes (tenant_id)
  where status in ('counting', 'review');

create index if not exists idx_pharmacy_stock_takes_tenant_opened
  on public.pharmacy_stock_takes (tenant_id, opened_at desc);

-- ---------------------------------------------------------------------------
-- 2. Counts
-- ---------------------------------------------------------------------------
create table if not exists public.pharmacy_stock_take_counts (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  stock_take_id uuid not null references public.pharmacy_stock_takes (id) on delete cascade,
  product_id uuid not null references public.pharmacy_products (id),
  batch_key text not null check (
    batch_key = 'unbatched'
    or batch_key like 'new:%'
    or batch_key ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  ),
  batch_id uuid references public.pharmacy_product_batches (id),
  new_batch_number text,
  new_expiry_date date,
  counted_qty integer not null check (counted_qty >= 0),
  counted_by uuid not null,
  device_id text,
  client_entry_id uuid not null,
  counted_at timestamptz not null,
  received_at timestamptz not null default now(),
  note text,
  constraint pharmacy_stock_take_counts_one_per_counter
    unique (stock_take_id, product_id, batch_key, counted_by),
  constraint pharmacy_stock_take_counts_new_batch check (
    batch_key not like 'new:%'
    or (new_batch_number is not null and new_expiry_date is not null)
  ),
  constraint pharmacy_stock_take_counts_batch_ref check (
    (batch_key in ('unbatched') or batch_key like 'new:%') = (batch_id is null)
  )
);

create index if not exists idx_pharmacy_stock_take_counts_take_product
  on public.pharmacy_stock_take_counts (stock_take_id, product_id);
create index if not exists idx_pharmacy_stock_take_counts_tenant
  on public.pharmacy_stock_take_counts (tenant_id);

-- ---------------------------------------------------------------------------
-- 3. Manager overrides (recounts)
-- ---------------------------------------------------------------------------
create table if not exists public.pharmacy_stock_take_overrides (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  stock_take_id uuid not null references public.pharmacy_stock_takes (id) on delete cascade,
  product_id uuid not null references public.pharmacy_products (id),
  batch_key text not null,
  batch_id uuid references public.pharmacy_product_batches (id),
  override_qty integer not null check (override_qty >= 0),
  reason text not null check (length(trim(reason)) > 0),
  set_by uuid not null,
  set_at timestamptz not null default now(),
  constraint pharmacy_stock_take_overrides_unique unique (stock_take_id, product_id, batch_key)
);

create index if not exists idx_pharmacy_stock_take_overrides_tenant
  on public.pharmacy_stock_take_overrides (tenant_id);

-- ---------------------------------------------------------------------------
-- 4. Posting results
-- ---------------------------------------------------------------------------
create table if not exists public.pharmacy_stock_take_postings (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  stock_take_id uuid not null references public.pharmacy_stock_takes (id) on delete cascade,
  product_id uuid not null references public.pharmacy_products (id),
  batch_id uuid references public.pharmacy_product_batches (id),
  book_qty integer not null,
  final_qty integer not null,
  variance integer generated always as (final_qty - book_qty) stored,
  unit_cost numeric(14, 2) not null default 0,
  variance_value numeric(16, 2) generated always as ((final_qty - book_qty) * unit_cost) stored,
  rule text not null check (rule in ('counted', 'negative_cleared', 'uncounted_share', 'count_batch', 'new_batch', 'product_total')),
  posted_at timestamptz not null default now()
);

create index if not exists idx_pharmacy_stock_take_postings_take
  on public.pharmacy_stock_take_postings (stock_take_id, product_id);
create index if not exists idx_pharmacy_stock_take_postings_tenant
  on public.pharmacy_stock_take_postings (tenant_id);

alter table public.pharmacy_stock_adjustments
  add column if not exists stock_take_id uuid references public.pharmacy_stock_takes (id);

create index if not exists idx_pharmacy_stock_adjustments_stock_take
  on public.pharmacy_stock_adjustments (stock_take_id)
  where stock_take_id is not null;

-- ---------------------------------------------------------------------------
-- 5. Guards: counts only while counting; overrides only before posting; the
-- child row's tenant must be its session's tenant.
-- ---------------------------------------------------------------------------
create or replace function public.pharmacy_stock_take_child_guard()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_take pharmacy_stock_takes%rowtype;
  v_take_id uuid;
  v_tenant_id uuid;
begin
  if tg_op = 'DELETE' then
    v_take_id := old.stock_take_id;
    v_tenant_id := old.tenant_id;
  else
    v_take_id := new.stock_take_id;
    v_tenant_id := new.tenant_id;
  end if;
  -- FOR SHARE waits for a posting that holds the row FOR UPDATE, then sees
  -- the status it committed.
  select * into v_take from pharmacy_stock_takes
  where id = v_take_id
  for share;
  if not found then
    -- The session itself is being deleted (cascade); nothing to guard.
    if tg_op = 'DELETE' then return old; end if;
    raise exception 'STOCK_TAKE_NOT_FOUND: %', v_take_id;
  end if;
  if v_take.tenant_id <> v_tenant_id then
    raise exception 'PERMISSION: stock take % belongs to another pharmacy', v_take_id;
  end if;
  if tg_table_name = 'pharmacy_stock_take_counts' and v_take.status <> 'counting' then
    raise exception 'STOCK_TAKE_CLOSED: counting has closed for %', v_take.reference;
  end if;
  if tg_table_name = 'pharmacy_stock_take_overrides' and v_take.status not in ('counting', 'review') then
    raise exception 'STOCK_TAKE_CLOSED: % is %', v_take.reference, v_take.status;
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$function$;

drop trigger if exists pharmacy_stock_take_counts_guard on public.pharmacy_stock_take_counts;
create trigger pharmacy_stock_take_counts_guard
  before insert or update or delete on public.pharmacy_stock_take_counts
  for each row execute function public.pharmacy_stock_take_child_guard();

drop trigger if exists pharmacy_stock_take_overrides_guard on public.pharmacy_stock_take_overrides;
create trigger pharmacy_stock_take_overrides_guard
  before insert or update or delete on public.pharmacy_stock_take_overrides
  for each row execute function public.pharmacy_stock_take_child_guard();

drop trigger if exists set_pharmacy_stock_takes_updated_at on public.pharmacy_stock_takes;
create trigger set_pharmacy_stock_takes_updated_at
  before update on public.pharmacy_stock_takes
  for each row execute function public.update_updated_at_column();

revoke all on function public.pharmacy_stock_take_child_guard() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 6. Posting
-- ---------------------------------------------------------------------------
create or replace function public.post_pharmacy_stock_take(
  p_tenant_id uuid,
  p_stock_take_id uuid,
  p_actor_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_take pharmacy_stock_takes%rowtype;
  v_product pharmacy_products%rowtype;
  v_batch pharmacy_product_batches%rowtype;
  v_pid uuid;
  r record;
  v_reason text;
  v_today date := (timezone('Africa/Kampala', now()))::date;
  v_counted jsonb;
  v_new_ids uuid[];
  v_unbatched int;
  v_remaining int;
  v_target int;
  v_delta int;
  v_running int;
  v_prev int;
  v_new int;
  v_cost numeric;
  v_rule text;
  v_batch_id uuid;
  v_count_batch text;
  v_products int := 0;
  v_changed_products int := 0;
  v_changes int := 0;
  v_units_gained bigint := 0;
  v_units_lost bigint := 0;
  v_value_gained numeric := 0;
  v_value_lost numeric := 0;
  v_negatives_cleared int := 0;
  v_product_changes int;
  v_pvalue numeric;
  v_summary jsonb;
begin
  perform public.pharmacy_assert_actor(p_tenant_id, p_actor_id);

  select * into v_take from pharmacy_stock_takes
  where id = p_stock_take_id and tenant_id = p_tenant_id
  for update;
  if not found then
    raise exception 'STOCK_TAKE_NOT_FOUND: %', p_stock_take_id;
  end if;
  if v_take.status = 'posted' then
    return coalesce(v_take.posting_summary, '{}'::jsonb) || jsonb_build_object('replay', true);
  end if;
  if v_take.status <> 'review' then
    raise exception 'STOCK_TAKE_NOT_IN_REVIEW: close counting on % before posting (status %)',
      v_take.reference, v_take.status;
  end if;

  v_reason := 'Stock take ' || v_take.reference;
  v_count_batch := 'COUNT-' || v_take.reference;

  -- Product order matches the sale and adjustment RPCs: product, then batch.
  for v_pid in
    select product_id from pharmacy_stock_take_counts
    where stock_take_id = v_take.id and tenant_id = p_tenant_id
    union
    select product_id from pharmacy_stock_take_overrides
    where stock_take_id = v_take.id and tenant_id = p_tenant_id
    order by 1
  loop
    select * into v_product from pharmacy_products
    where id = v_pid and tenant_id = p_tenant_id
    for update;
    if not found then
      raise exception 'PRODUCT_NOT_FOUND: %', v_pid;
    end if;

    v_products := v_products + 1;
    v_product_changes := 0;
    v_pvalue := 0;
    v_prev := coalesce(v_product.quantity, 0);
    v_running := v_prev;
    v_counted := '{}'::jsonb;
    v_new_ids := array[]::uuid[];
    v_unbatched := 0;

    -- Final quantity per batch key: the manager's override, else the sum of
    -- every counter's entry (two people counting two shelves add up).
    for r in
      with keys as (
        select batch_key from pharmacy_stock_take_counts
        where stock_take_id = v_take.id and product_id = v_pid
        union
        select batch_key from pharmacy_stock_take_overrides
        where stock_take_id = v_take.id and product_id = v_pid
      ),
      summed as (
        select batch_key,
               sum(counted_qty)::int as qty,
               max(new_batch_number) as new_batch_number,
               max(new_expiry_date) as new_expiry_date
        from pharmacy_stock_take_counts
        where stock_take_id = v_take.id and product_id = v_pid
        group by batch_key
      )
      select k.batch_key,
             coalesce(o.override_qty, s.qty, 0) as qty,
             s.new_batch_number,
             s.new_expiry_date
      from keys k
      left join summed s on s.batch_key = k.batch_key
      left join pharmacy_stock_take_overrides o
        on o.stock_take_id = v_take.id and o.product_id = v_pid and o.batch_key = k.batch_key
      order by k.batch_key
    loop
      if r.batch_key = 'unbatched' then
        v_unbatched := v_unbatched + r.qty;
      elsif r.batch_key like 'new:%' then
        -- A batch number the counter typed may already be on the book.
        select id into v_batch_id from pharmacy_product_batches
        where tenant_id = p_tenant_id and product_id = v_pid
          and upper(trim(batch_number)) = upper(trim(coalesce(r.new_batch_number, substr(r.batch_key, 5))))
        order by received_date desc nulls last
        limit 1;
        if v_batch_id is not null then
          v_counted := jsonb_set(
            v_counted, array[v_batch_id::text],
            to_jsonb(coalesce((v_counted ->> v_batch_id::text)::int, 0) + r.qty)
          );
        elsif r.qty > 0 then
          if r.new_expiry_date is null then
            raise exception 'INVALID_QUANTITY: new batch % needs an expiry date', r.batch_key;
          end if;
          v_cost := coalesce(v_product.cost_price, 0);
          insert into pharmacy_product_batches (
            tenant_id, product_id, batch_number, quantity, initial_quantity,
            expiry_date, received_date, cost_price, is_active, status, notes
          ) values (
            p_tenant_id, v_pid, upper(trim(coalesce(r.new_batch_number, substr(r.batch_key, 5)))),
            r.qty, r.qty, r.new_expiry_date, now(), v_cost, true,
            case when r.new_expiry_date < v_today then 'expired' else 'active' end,
            'Found during ' || v_reason
          )
          returning id into v_batch_id;
          v_new_ids := v_new_ids || v_batch_id;
          insert into pharmacy_stock_adjustments (
            tenant_id, product_id, batch_id, quantity, type, reason,
            previous_qty, new_qty, created_by, approved_by, stock_take_id
          ) values (
            p_tenant_id, v_pid, v_batch_id, r.qty, 'PHYSICAL', v_reason || ' (batch found on shelf)',
            v_running, v_running + r.qty, p_actor_id, p_actor_id, v_take.id
          );
          insert into pharmacy_stock_take_postings (
            tenant_id, stock_take_id, product_id, batch_id, book_qty, final_qty, unit_cost, rule
          ) values (p_tenant_id, v_take.id, v_pid, v_batch_id, 0, r.qty, v_cost, 'new_batch');
          v_running := v_running + r.qty;
          v_pvalue := v_pvalue + r.qty * v_cost;
          v_product_changes := v_product_changes + 1;
        end if;
      else
        v_counted := jsonb_set(
          v_counted, array[r.batch_key],
          to_jsonb(coalesce((v_counted ->> r.batch_key)::int, 0) + r.qty)
        );
      end if;
    end loop;

    v_remaining := v_unbatched;

    -- Latest expiry first, so uncounted stock is kept on the freshest batches.
    for v_batch in
      select * from pharmacy_product_batches
      where tenant_id = p_tenant_id and product_id = v_pid
        and not (id = any (v_new_ids))
      order by expiry_date desc nulls first, received_date desc nulls last, id
      for update
    loop
      v_target := null;
      if v_counted ? v_batch.id::text then
        v_target := (v_counted ->> v_batch.id::text)::int;
        v_rule := 'counted';
      elsif coalesce(v_batch.quantity, 0) < 0 then
        v_target := 0;
        v_rule := 'negative_cleared';
      elsif coalesce(v_batch.status, 'active') in ('active', 'exhausted')
            and (v_batch.expiry_date is null or v_batch.expiry_date >= v_today) then
        v_target := least(coalesce(v_batch.quantity, 0), v_remaining);
        v_remaining := v_remaining - v_target;
        v_rule := 'uncounted_share';
      end if;

      if v_target is null then
        continue;
      end if;
      v_delta := v_target - coalesce(v_batch.quantity, 0);
      v_cost := coalesce(nullif(v_batch.cost_price, 0), v_product.cost_price, 0);

      if v_delta <> 0 or v_rule = 'counted' then
        insert into pharmacy_stock_take_postings (
          tenant_id, stock_take_id, product_id, batch_id, book_qty, final_qty, unit_cost, rule
        ) values (
          p_tenant_id, v_take.id, v_pid, v_batch.id, coalesce(v_batch.quantity, 0), v_target, v_cost, v_rule
        );
      end if;
      if v_delta = 0 then
        continue;
      end if;

      update pharmacy_product_batches
      set quantity = v_target,
          status = case
            when v_target <= 0 and coalesce(status, 'active') = 'active' then 'exhausted'
            when v_target > 0 and coalesce(status, 'active') = 'exhausted' then 'active'
            else status
          end,
          is_active = case when v_target > 0 then true else is_active end,
          updated_at = now()
      where id = v_batch.id;

      insert into pharmacy_stock_adjustments (
        tenant_id, product_id, batch_id, quantity, type, reason,
        previous_qty, new_qty, created_by, approved_by, stock_take_id
      ) values (
        p_tenant_id, v_pid, v_batch.id, v_delta, 'PHYSICAL', v_reason,
        v_running, v_running + v_delta, p_actor_id, p_actor_id, v_take.id
      );
      v_running := v_running + v_delta;
      v_product_changes := v_product_changes + 1;
      v_pvalue := v_pvalue + v_delta * v_cost;
    end loop;

    -- Counted stock that no batch could hold goes on one count batch.
    if v_remaining > 0 then
      v_cost := coalesce(v_product.cost_price, 0);
      insert into pharmacy_product_batches (
        tenant_id, product_id, batch_number, quantity, initial_quantity,
        expiry_date, received_date, cost_price, is_active, status, notes
      ) values (
        p_tenant_id, v_pid, v_count_batch, v_remaining, v_remaining,
        '2099-12-31'::date, now(), v_cost, true, 'active',
        'Counted without a batch during ' || v_reason || '; expiry unknown'
      )
      returning id into v_batch_id;
      insert into pharmacy_stock_adjustments (
        tenant_id, product_id, batch_id, quantity, type, reason,
        previous_qty, new_qty, created_by, approved_by, stock_take_id
      ) values (
        p_tenant_id, v_pid, v_batch_id, v_remaining, 'PHYSICAL', v_reason || ' (no batch identified)',
        v_running, v_running + v_remaining, p_actor_id, p_actor_id, v_take.id
      );
      insert into pharmacy_stock_take_postings (
        tenant_id, stock_take_id, product_id, batch_id, book_qty, final_qty, unit_cost, rule
      ) values (p_tenant_id, v_take.id, v_pid, v_batch_id, 0, v_remaining, v_cost, 'count_batch');
      v_running := v_running + v_remaining;
      v_pvalue := v_pvalue + v_remaining * v_cost;
      v_product_changes := v_product_changes + 1;
    end if;

    -- The product total becomes the sum of its batches.
    select coalesce(sum(quantity), 0)::int into v_new
    from pharmacy_product_batches
    where tenant_id = p_tenant_id and product_id = v_pid;

    if v_new <> v_running then
      -- The book total had drifted from its batches before the count.
      insert into pharmacy_stock_adjustments (
        tenant_id, product_id, batch_id, quantity, type, reason,
        previous_qty, new_qty, created_by, approved_by, stock_take_id
      ) values (
        p_tenant_id, v_pid, null, v_new - v_running, 'PHYSICAL',
        v_reason || ' (product total aligned to batches)',
        v_running, v_new, p_actor_id, p_actor_id, v_take.id
      );
      insert into pharmacy_stock_take_postings (
        tenant_id, stock_take_id, product_id, batch_id, book_qty, final_qty, unit_cost, rule
      ) values (
        p_tenant_id, v_take.id, v_pid, null, v_running, v_new,
        coalesce(v_product.cost_price, 0), 'product_total'
      );
      v_pvalue := v_pvalue + (v_new - v_running) * coalesce(v_product.cost_price, 0);
      v_product_changes := v_product_changes + 1;
    end if;

    if v_new <> v_prev then
      update pharmacy_products set quantity = v_new, updated_at = now() where id = v_pid;
    end if;
    -- Units and value are netted per product, as the review screen shows them.
    if v_new > v_prev then
      v_units_gained := v_units_gained + (v_new - v_prev);
    else
      v_units_lost := v_units_lost + (v_prev - v_new);
    end if;
    if v_pvalue > 0 then
      v_value_gained := v_value_gained + v_pvalue;
    else
      v_value_lost := v_value_lost - v_pvalue;
    end if;
    if v_prev < 0 and v_new >= 0 then
      v_negatives_cleared := v_negatives_cleared + 1;
    end if;
    if v_product_changes > 0 then
      v_changed_products := v_changed_products + 1;
      v_changes := v_changes + v_product_changes;
      insert into pharmacy_audit_logs (tenant_id, profile_id, action, entity, entity_id, details)
      values (
        p_tenant_id, p_actor_id, 'stock.take', 'pharmacy_products', v_pid::text,
        jsonb_build_object(
          'stock_take_id', v_take.id, 'reference', v_take.reference,
          'previous_qty', v_prev, 'new_qty', v_new, 'changes', v_product_changes
        )::text
      );
    end if;
  end loop;

  v_summary := jsonb_build_object(
    'ok', true,
    'stockTakeId', v_take.id,
    'reference', v_take.reference,
    'productsCounted', v_products,
    'productsChanged', v_changed_products,
    'adjustments', v_changes,
    'unitsGained', v_units_gained,
    'unitsLost', v_units_lost,
    'valueGained', round(v_value_gained, 2),
    'valueLost', round(v_value_lost, 2),
    'netValue', round(v_value_gained - v_value_lost, 2),
    'negativesCleared', v_negatives_cleared,
    'postedAt', now()
  );

  update pharmacy_stock_takes
  set status = 'posted', posted_by = p_actor_id, posted_at = now(), posting_summary = v_summary
  where id = v_take.id;

  insert into pharmacy_audit_logs (tenant_id, profile_id, action, entity, entity_id, details)
  values (
    p_tenant_id, p_actor_id, 'stock_take.post', 'pharmacy_stock_takes', v_take.id::text,
    v_summary::text
  );

  return v_summary;
end;
$function$;

comment on function public.post_pharmacy_stock_take(uuid, uuid, uuid) is
  'Posts a reviewed stock take in one transaction: counted batches set to their count, negative batches cleared, product totals realigned to batches, every change recorded as a PHYSICAL adjustment.';

revoke all on function public.post_pharmacy_stock_take(uuid, uuid, uuid) from public;
revoke all on function public.post_pharmacy_stock_take(uuid, uuid, uuid) from anon;
revoke all on function public.post_pharmacy_stock_take(uuid, uuid, uuid) from authenticated;
grant execute on function public.post_pharmacy_stock_take(uuid, uuid, uuid) to service_role;

-- ---------------------------------------------------------------------------
-- 7. Row security: tenant-scoped reads, service-role writes.
-- ---------------------------------------------------------------------------
alter table public.pharmacy_stock_takes enable row level security;
alter table public.pharmacy_stock_take_counts enable row level security;
alter table public.pharmacy_stock_take_overrides enable row level security;
alter table public.pharmacy_stock_take_postings enable row level security;

revoke all on public.pharmacy_stock_takes from public, anon, authenticated;
revoke all on public.pharmacy_stock_take_counts from public, anon, authenticated;
revoke all on public.pharmacy_stock_take_overrides from public, anon, authenticated;
revoke all on public.pharmacy_stock_take_postings from public, anon, authenticated;

grant select on public.pharmacy_stock_takes to authenticated;
grant select on public.pharmacy_stock_take_counts to authenticated;
grant select on public.pharmacy_stock_take_overrides to authenticated;
grant select on public.pharmacy_stock_take_postings to authenticated;

grant select, insert, update, delete on public.pharmacy_stock_takes to service_role;
grant select, insert, update, delete on public.pharmacy_stock_take_counts to service_role;
grant select, insert, update, delete on public.pharmacy_stock_take_overrides to service_role;
grant select, insert, update, delete on public.pharmacy_stock_take_postings to service_role;

drop policy if exists pharmacy_stock_takes_tenant_read on public.pharmacy_stock_takes;
create policy pharmacy_stock_takes_tenant_read
  on public.pharmacy_stock_takes
  for select
  to authenticated
  using (
    tenant_id = any (public.pharmacy_caller_tenants())
    or public.is_platform_admin()
  );

drop policy if exists pharmacy_stock_take_counts_tenant_read on public.pharmacy_stock_take_counts;
create policy pharmacy_stock_take_counts_tenant_read
  on public.pharmacy_stock_take_counts
  for select
  to authenticated
  using (
    tenant_id = any (public.pharmacy_caller_tenants())
    or public.is_platform_admin()
  );

drop policy if exists pharmacy_stock_take_overrides_tenant_read on public.pharmacy_stock_take_overrides;
create policy pharmacy_stock_take_overrides_tenant_read
  on public.pharmacy_stock_take_overrides
  for select
  to authenticated
  using (
    tenant_id = any (public.pharmacy_caller_tenants())
    or public.is_platform_admin()
  );

drop policy if exists pharmacy_stock_take_postings_tenant_read on public.pharmacy_stock_take_postings;
create policy pharmacy_stock_take_postings_tenant_read
  on public.pharmacy_stock_take_postings
  for select
  to authenticated
  using (
    tenant_id = any (public.pharmacy_caller_tenants())
    or public.is_platform_admin()
  );

commit;
