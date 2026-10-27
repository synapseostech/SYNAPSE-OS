-- PREPARED ONLY — NOT APPLIED.
--
-- `close_pharmacy_accounting_period` closes a period and then refuses every
-- posting dated inside it with `ACCOUNTING_PERIOD_CLOSED`. That is the right
-- control, but it is applied blind: the function checks the dates, the overlap
-- and nothing else.
--
-- The failure that matters is a till session still open at close. Pharmacy cash
-- events are written when the till closes (`pharmacy_till_cash_events`), not when
-- the sale happened, and the close posts them through
-- `post_pharmacy_accounting_journal` with `p_entry_date` equal to the business
-- date of the shift. A supervisor closing the month on the 1st while a cashier
-- still has the 30th's till open therefore locks that till out of its own period:
-- the cashier sees `ACCOUNTING_PERIOD_CLOSED` on the till close screen, the day's
-- cash never reaches the ledger, and the variance sits unexplained.
--
-- This migration:
--   1. adds `close_snapshot` to `pharmacy_accounting_periods` so every close
--      records the figures it was signed off on;
--   2. adds `pharmacy_accounting_close_readiness(...)`, a read-only function that
--      returns those figures. The app renders it through
--      apps/pharmacy/lib/accounting/close-readiness.ts, so the operator sees the
--      same numbers before committing;
--   3. replaces the close function so it refuses to close with a till still open
--      and stores the snapshot it assessed;
--   4. adds the two indexes those queries need, since neither existed: open till
--      sessions had only single-column indexes, and sales were indexed by
--      `created_at` alone with no tenant prefix.
--
-- The till predicate below mirrors `tillBlocksPeriodClose()` in
-- apps/pharmacy/lib/accounting/close-readiness.ts: not closed, no close time, and
-- opened on or before the period end. That module is the readable statement of
-- the rule and its test pins it; this is the enforcement copy. If one changes,
-- both must.
--
-- Additive and re-runnable: one non-null column whose constant default PG11+
-- records in the catalogue without rewriting the table, two `create or replace`
-- functions with unchanged signatures (so existing grants survive), and no change
-- to any row or policy.
--
-- Apply through the normal dispatch path with the rest of the pending set.

alter table if exists public.pharmacy_accounting_periods
  add column if not exists close_snapshot jsonb not null default '{}'::jsonb;

comment on column public.pharmacy_accounting_periods.close_snapshot is
  'Figures assessed when the period was closed. Raw facts, not rendered messages, so the close can be explained later.';

-- Two indexes for the close-readiness queries below. Both are plain (not
-- CONCURRENTLY) because a migration runs in a transaction; on a pilot-scale
-- pharmacy the tables are small enough that the write lock is momentary. The
-- first is partial, so it holds only the handful of tills that are actually open
-- rather than every shift ever recorded.
create index if not exists pharmacy_cashier_sessions_open_idx
  on public.pharmacy_cashier_sessions (tenant_id, opened_at)
  where status <> 'closed' and closed_at is null;

create index if not exists pharmacy_pos_sales_tenant_status_created_idx
  on public.pharmacy_pos_sales (tenant_id, status, created_at);

create or replace function public.pharmacy_accounting_close_readiness(
  p_tenant_id uuid,
  p_period_start date,
  p_period_end date
)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_today date := (timezone('Africa/Kampala', now()))::date;
  v_sessions jsonb;
  v_blocking integer;
  v_unmatched_lines integer;
  v_unmatched_value numeric(18, 2);
  v_journal_entries integer;
  v_journal_debit numeric(18, 2);
  v_sales_count integer;
  v_sales_total numeric(18, 2);
  v_cash_sales_total numeric(18, 2);
begin
  if p_tenant_id is null or p_period_start is null or p_period_end is null then
    raise exception 'ACCOUNTING_PERIOD_INVALID';
  end if;
  if p_period_end < p_period_start then
    raise exception 'ACCOUNTING_PERIOD_INVALID';
  end if;

  -- Only unclosed sessions are interesting here, and there are at most one per
  -- cashier thanks to pharmacy_cashier_sessions_one_open_cashier.
  --
  -- The timestamps are compared as a half-open range on `timestamptz` rather
  -- than cast to a date per row: `opened_at < local midnight after period_end`
  -- is the same statement as "business date <= period_end", but only the range
  -- form can use pharmacy_cashier_sessions_open_idx.
  select coalesce(
           jsonb_agg(
             jsonb_build_object(
               'status', s.status,
               'openedOn', (s.opened_at at time zone 'Africa/Kampala')::date,
               'closedOn', case
                 when s.closed_at is null then null
                 else (s.closed_at at time zone 'Africa/Kampala')::date
               end,
               'tillCode', s.till_code
             ) order by s.opened_at
           ),
           '[]'::jsonb
         ),
         count(*) filter (
           where s.opened_at < ((p_period_end + 1)::timestamp at time zone 'Africa/Kampala')
         )
    into v_sessions, v_blocking
  from public.pharmacy_cashier_sessions s
  where s.tenant_id = p_tenant_id
    and s.status <> 'closed'
    and s.closed_at is null;

  select count(*), coalesce(sum(abs(b.amount)), 0)
    into v_unmatched_lines, v_unmatched_value
  from public.pharmacy_bank_statement_lines b
  where b.tenant_id = p_tenant_id
    and b.matched_journal_line_id is null
    and b.statement_date between p_period_start and p_period_end;

  select count(*), coalesce(sum(e.total_debit), 0)
    into v_journal_entries, v_journal_debit
  from public.pharmacy_accounting_journal_entries e
  where e.tenant_id = p_tenant_id
    and e.entry_date between p_period_start and p_period_end;

  select count(*),
         coalesce(sum(s.total_amount), 0),
         coalesce(sum(s.total_amount) filter (where s.payment_method = 'cash'), 0)
    into v_sales_count, v_sales_total, v_cash_sales_total
  from public.pharmacy_pos_sales s
  where s.tenant_id = p_tenant_id
    and s.status = 'completed'
    and s.created_at >= (p_period_start::timestamp at time zone 'Africa/Kampala')
    and s.created_at < ((p_period_end + 1)::timestamp at time zone 'Africa/Kampala');

  return jsonb_build_object(
    'periodStart', p_period_start,
    'periodEnd', p_period_end,
    'assessedOn', v_today,
    'tillSessions', v_sessions,
    'openTillSessions', v_blocking,
    'journalEntries', v_journal_entries,
    'journalDebitTotal', v_journal_debit,
    'salesCount', v_sales_count,
    'salesTotal', v_sales_total,
    'cashSalesTotal', v_cash_sales_total,
    'unmatchedBankLines', v_unmatched_lines,
    'unmatchedBankValue', v_unmatched_value
  );
end;
$function$;

create or replace function public.close_pharmacy_accounting_period(
  p_tenant_id uuid,
  p_period_start date,
  p_period_end date,
  p_closed_by uuid
)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_period public.pharmacy_accounting_periods%rowtype;
  v_snapshot jsonb;
  v_blocking integer;
begin
  if p_tenant_id is null or p_period_start is null or p_period_end is null
    or p_period_end < p_period_start then
    raise exception 'ACCOUNTING_PERIOD_INVALID';
  end if;
  if p_period_end >= (timezone('Africa/Kampala', now()))::date then
    raise exception 'ACCOUNTING_PERIOD_NOT_ENDED';
  end if;

  perform pg_advisory_xact_lock(hashtext(p_tenant_id::text || ':pharmacy_accounting_periods'));
  if exists (
    select 1 from public.pharmacy_accounting_periods
    where tenant_id = p_tenant_id and status = 'closed'
      and daterange(period_start, period_end, '[]') && daterange(p_period_start, p_period_end, '[]')
  ) then
    raise exception 'ACCOUNTING_PERIOD_OVERLAP';
  end if;

  -- Assessed inside the lock, so the figures recorded below are the figures the
  -- till check was made against.
  v_snapshot := public.pharmacy_accounting_close_readiness(p_tenant_id, p_period_start, p_period_end);
  v_blocking := coalesce((v_snapshot->>'openTillSessions')::integer, 0);
  if v_blocking > 0 then
    raise exception 'ACCOUNTING_PERIOD_OPEN_TILLS: % till session(s) opened on or before %', v_blocking, p_period_end;
  end if;

  insert into public.pharmacy_accounting_periods
    (tenant_id, period_start, period_end, status, closed_by, closed_at, close_snapshot)
  values (p_tenant_id, p_period_start, p_period_end, 'closed', p_closed_by, now(), v_snapshot)
  returning * into v_period;

  insert into public.pharmacy_audit_logs
    (tenant_id, profile_id, action, entity, entity_id, details)
  values
    (p_tenant_id, p_closed_by, 'ACCOUNTING_PERIOD_CLOSED',
     'PHARMACY_ACCOUNTING_PERIOD', v_period.id::text,
     jsonb_build_object(
       'period_start', p_period_start,
       'period_end', p_period_end,
       'snapshot', v_snapshot
     )::text);

  return jsonb_build_object('id', v_period.id, 'period_start', v_period.period_start,
    'period_end', v_period.period_end, 'status', v_period.status,
    'close_snapshot', v_period.close_snapshot);
end;
$function$;

-- The close function keeps its signature, so the grants from
-- 20261022160000_pharmacy_accounting_ledger.sql still apply. The readiness
-- function is new and needs its own.
revoke all on function public.pharmacy_accounting_close_readiness(uuid, date, date)
  from public, anon, authenticated;
grant execute on function public.pharmacy_accounting_close_readiness(uuid, date, date)
  to service_role;
