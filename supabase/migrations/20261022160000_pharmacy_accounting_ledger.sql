-- Pharmacy accrual ledger foundation.
-- Operational sales and received supplier purchases post balanced, immutable
-- journal entries once. Existing activity is not backfilled automatically.

alter table public.pharmacy_credit_ledger
  add column if not exists payment_method text not null default 'cash';

create table if not exists public.pharmacy_accounting_accounts (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  code text not null,
  name text not null,
  account_type text not null check (account_type in ('asset', 'liability', 'equity', 'income', 'expense')),
  normal_balance text not null check (normal_balance in ('debit', 'credit')),
  system_key text,
  parent_id uuid references public.pharmacy_accounting_accounts(id),
  is_system boolean not null default false,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  unique (tenant_id, code)
);

create unique index if not exists pharmacy_accounting_accounts_system_key_uidx
  on public.pharmacy_accounting_accounts (tenant_id, system_key)
  where system_key is not null;

create table if not exists public.pharmacy_accounting_periods (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  period_start date not null,
  period_end date not null,
  status text not null default 'open' check (status in ('open', 'closed')),
  closed_by uuid references public.profiles(id),
  closed_at timestamptz,
  created_at timestamptz not null default now(),
  check (period_end >= period_start),
  unique (tenant_id, period_start, period_end)
);

create table if not exists public.pharmacy_accounting_journal_entries (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  entry_no text not null,
  entry_date date not null,
  source_type text not null,
  source_id text not null,
  description text not null,
  currency text not null,
  total_debit numeric(18, 2) not null check (total_debit > 0),
  total_credit numeric(18, 2) not null check (total_credit > 0),
  created_by uuid references public.profiles(id),
  created_at timestamptz not null default now(),
  unique (tenant_id, entry_no),
  unique (tenant_id, source_type, source_id),
  check (total_debit = total_credit)
);

create index if not exists pharmacy_accounting_journal_entries_date_idx
  on public.pharmacy_accounting_journal_entries (tenant_id, entry_date desc, created_at desc);

create table if not exists public.pharmacy_accounting_journal_lines (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  journal_entry_id uuid not null references public.pharmacy_accounting_journal_entries(id) on delete restrict,
  account_id uuid not null references public.pharmacy_accounting_accounts(id) on delete restrict,
  description text,
  debit numeric(18, 2) not null default 0 check (debit >= 0),
  credit numeric(18, 2) not null default 0 check (credit >= 0),
  created_at timestamptz not null default now(),
  check (not (debit > 0 and credit > 0)),
  check (debit > 0 or credit > 0)
);

create index if not exists pharmacy_accounting_journal_lines_account_idx
  on public.pharmacy_accounting_journal_lines (tenant_id, account_id, journal_entry_id);

create table if not exists public.pharmacy_bank_statement_imports (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  file_name text not null,
  currency text not null,
  idempotency_key text not null,
  content_hash text not null,
  imported_by uuid references public.profiles(id),
  imported_at timestamptz not null default now(),
  unique (tenant_id, idempotency_key)
);

create unique index if not exists pharmacy_bank_statement_imports_content_uidx
  on public.pharmacy_bank_statement_imports (tenant_id, content_hash);

create table if not exists public.pharmacy_bank_statement_lines (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  import_id uuid not null references public.pharmacy_bank_statement_imports(id) on delete cascade,
  line_number integer not null check (line_number > 0),
  statement_date date not null,
  description text not null,
  reference text,
  currency text not null,
  amount numeric(18, 2) not null check (amount <> 0),
  matched_journal_line_id uuid references public.pharmacy_accounting_journal_lines(id) on delete restrict,
  matched_by uuid references public.profiles(id),
  matched_at timestamptz,
  created_at timestamptz not null default now(),
  unique (import_id, line_number)
);

create unique index if not exists pharmacy_bank_statement_matched_line_uidx
  on public.pharmacy_bank_statement_lines (tenant_id, matched_journal_line_id)
  where matched_journal_line_id is not null;
create index if not exists pharmacy_bank_statement_lines_date_idx
  on public.pharmacy_bank_statement_lines (tenant_id, statement_date desc, created_at desc);

create or replace function public.seed_pharmacy_accounting_accounts(p_tenant_id uuid)
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  if p_tenant_id is null or not exists (select 1 from public.tenants where id = p_tenant_id) then
    raise exception 'ACCOUNTING_TENANT_NOT_FOUND';
  end if;

  insert into public.pharmacy_accounting_accounts
    (tenant_id, code, name, account_type, normal_balance, system_key, is_system)
  values
    (p_tenant_id, '1000', 'Cash on hand', 'asset', 'debit', 'CASH_ON_HAND', true),
    (p_tenant_id, '1010', 'Bank account', 'asset', 'debit', 'BANK', true),
    (p_tenant_id, '1020', 'Mobile money clearing', 'asset', 'debit', 'MOBILE_MONEY_CLEARING', true),
    (p_tenant_id, '1030', 'Card clearing', 'asset', 'debit', 'CARD_CLEARING', true),
    (p_tenant_id, '1100', 'Accounts receivable', 'asset', 'debit', 'ACCOUNTS_RECEIVABLE', true),
    (p_tenant_id, '1200', 'Inventory', 'asset', 'debit', 'INVENTORY', true),
    (p_tenant_id, '1300', 'Input VAT receivable', 'asset', 'debit', 'INPUT_VAT', true),
    (p_tenant_id, '2000', 'Accounts payable', 'liability', 'credit', 'ACCOUNTS_PAYABLE', true),
    (p_tenant_id, '2100', 'Output VAT payable', 'liability', 'credit', 'OUTPUT_VAT', true),
    (p_tenant_id, '3000', 'Opening balance equity', 'equity', 'credit', 'OPENING_BALANCE_EQUITY', true),
    (p_tenant_id, '3100', 'Retained earnings', 'equity', 'credit', 'RETAINED_EARNINGS', true),
    (p_tenant_id, '4000', 'Sales revenue', 'income', 'credit', 'SALES_REVENUE', true),
    (p_tenant_id, '4010', 'Sales discounts', 'income', 'debit', 'SALES_DISCOUNTS', true),
    (p_tenant_id, '5000', 'Cost of goods sold', 'expense', 'debit', 'COST_OF_GOODS_SOLD', true),
    (p_tenant_id, '5100', 'Operating expenses', 'expense', 'debit', 'OPERATING_EXPENSES', true)
  on conflict (tenant_id, system_key) where system_key is not null do nothing;
end;
$function$;

create or replace function public.post_pharmacy_accounting_journal(
  p_tenant_id uuid,
  p_source_type text,
  p_source_id text,
  p_entry_date date,
  p_description text,
  p_currency text,
  p_created_by uuid,
  p_lines jsonb
)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_existing public.pharmacy_accounting_journal_entries%rowtype;
  v_entry_id uuid;
  v_entry_no text;
  v_debit numeric(18, 2);
  v_credit numeric(18, 2);
  v_line jsonb;
  v_account_id uuid;
  v_debit_line numeric(18, 2);
  v_credit_line numeric(18, 2);
  v_date date := coalesce(p_entry_date, (timezone('Africa/Kampala', now()))::date);
begin
  if p_source_type is null or length(trim(p_source_type)) = 0
    or p_source_id is null or length(trim(p_source_id)) = 0 then
    raise exception 'ACCOUNTING_SOURCE_REQUIRED';
  end if;
  if p_currency is null or length(trim(p_currency)) < 3 then
    raise exception 'ACCOUNTING_CURRENCY_REQUIRED';
  end if;
  if jsonb_typeof(p_lines) is distinct from 'array' or jsonb_array_length(p_lines) < 2 then
    raise exception 'ACCOUNTING_LINES_REQUIRED';
  end if;

  perform public.seed_pharmacy_accounting_accounts(p_tenant_id);

  if exists (
    select 1 from public.pharmacy_accounting_periods
    where tenant_id = p_tenant_id and status = 'closed'
      and v_date between period_start and period_end
  ) then
    raise exception 'ACCOUNTING_PERIOD_CLOSED: %', v_date;
  end if;

  v_debit := 0;
  v_credit := 0;
  for v_line in select value from jsonb_array_elements(p_lines)
  loop
    v_account_id := (v_line->>'account_id')::uuid;
    v_debit_line := round(coalesce((v_line->>'debit')::numeric, 0), 2);
    v_credit_line := round(coalesce((v_line->>'credit')::numeric, 0), 2);

    if v_debit_line < 0 or v_credit_line < 0
      or (v_debit_line > 0 and v_credit_line > 0)
      or (v_debit_line = 0 and v_credit_line = 0) then
      raise exception 'ACCOUNTING_INVALID_LINE';
    end if;
    if not exists (
      select 1 from public.pharmacy_accounting_accounts
      where id = v_account_id and tenant_id = p_tenant_id and is_active
    ) then
      raise exception 'ACCOUNTING_ACCOUNT_NOT_FOUND';
    end if;
    v_debit := v_debit + v_debit_line;
    v_credit := v_credit + v_credit_line;
  end loop;

  if v_debit <= 0 or v_debit <> v_credit then
    raise exception 'ACCOUNTING_UNBALANCED: debit %, credit %', v_debit, v_credit;
  end if;

  perform pg_advisory_xact_lock(hashtext(p_tenant_id::text || ':pharmacy_accounting:' || v_date::text));
  insert into public.pharmacy_accounting_journal_entries
    (tenant_id, entry_no, entry_date, source_type, source_id, description, currency,
     total_debit, total_credit, created_by)
  values
    (p_tenant_id,
     'JE-' || to_char(v_date, 'YYYYMMDD') || '-' ||
       lpad((select (count(*) + 1)::text
         from public.pharmacy_accounting_journal_entries
         where tenant_id = p_tenant_id and entry_date = v_date), 6, '0'),
     v_date, trim(p_source_type), trim(p_source_id), coalesce(nullif(trim(p_description), ''), trim(p_source_type)),
     upper(trim(p_currency)), v_debit, v_credit, p_created_by)
  on conflict (tenant_id, source_type, source_id) do nothing
  returning id into v_entry_id;

  if v_entry_id is null then
    select * into v_existing
    from public.pharmacy_accounting_journal_entries
    where tenant_id = p_tenant_id and source_type = trim(p_source_type) and source_id = trim(p_source_id);
    return jsonb_build_object('id', v_existing.id, 'entry_no', v_existing.entry_no, 'replayed', true);
  end if;

  for v_line in select value from jsonb_array_elements(p_lines)
  loop
    insert into public.pharmacy_accounting_journal_lines
      (tenant_id, journal_entry_id, account_id, description, debit, credit)
    values
      (p_tenant_id, v_entry_id, (v_line->>'account_id')::uuid,
       nullif(trim(v_line->>'description'), ''),
       round(coalesce((v_line->>'debit')::numeric, 0), 2),
       round(coalesce((v_line->>'credit')::numeric, 0), 2));
  end loop;

  select entry_no into v_entry_no
  from public.pharmacy_accounting_journal_entries
  where id = v_entry_id and tenant_id = p_tenant_id;

  if trim(p_source_type) = 'manual' then
    insert into public.pharmacy_audit_logs
      (tenant_id, profile_id, action, entity, entity_id, details)
    values
      (p_tenant_id, p_created_by, 'ACCOUNTING_MANUAL_JOURNAL_POSTED',
       'PHARMACY_ACCOUNTING_JOURNAL', v_entry_id::text,
       jsonb_build_object('entry_no', v_entry_no, 'entry_date', v_date,
         'description', p_description, 'line_count', jsonb_array_length(p_lines))::text);
  end if;

  return jsonb_build_object('id', v_entry_id, 'entry_no', v_entry_no, 'replayed', false);
end;
$function$;

create or replace function public.pharmacy_accounting_trial_balance(
  p_tenant_id uuid,
  p_from date default null,
  p_to date default null
)
returns table (
  currency text,
  account_id uuid,
  code text,
  name text,
  account_type text,
  normal_balance text,
  debit numeric,
  credit numeric,
  balance numeric
)
language sql
stable
security definer
set search_path to 'public'
as $function$
  select
    e.currency,
    a.id,
    a.code,
    a.name,
    a.account_type,
    a.normal_balance,
    round(sum(l.debit), 2) as debit,
    round(sum(l.credit), 2) as credit,
    round(case when a.normal_balance = 'debit'
      then sum(l.debit) - sum(l.credit)
      else sum(l.credit) - sum(l.debit)
    end, 2) as balance
  from public.pharmacy_accounting_journal_entries e
  join public.pharmacy_accounting_journal_lines l
    on l.journal_entry_id = e.id and l.tenant_id = e.tenant_id
  join public.pharmacy_accounting_accounts a
    on a.id = l.account_id and a.tenant_id = e.tenant_id
  where e.tenant_id = p_tenant_id
    and (p_from is null or e.entry_date >= p_from)
    and (p_to is null or e.entry_date <= p_to)
  group by e.currency, a.id, a.code, a.name, a.account_type, a.normal_balance
  order by e.currency, a.code
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

  insert into public.pharmacy_accounting_periods
    (tenant_id, period_start, period_end, status, closed_by, closed_at)
  values (p_tenant_id, p_period_start, p_period_end, 'closed', p_closed_by, now())
  returning * into v_period;

  insert into public.pharmacy_audit_logs
    (tenant_id, profile_id, action, entity, entity_id, details)
  values
    (p_tenant_id, p_closed_by, 'ACCOUNTING_PERIOD_CLOSED',
     'PHARMACY_ACCOUNTING_PERIOD', v_period.id::text,
     jsonb_build_object('period_start', p_period_start, 'period_end', p_period_end)::text);

  return jsonb_build_object('id', v_period.id, 'period_start', v_period.period_start,
    'period_end', v_period.period_end, 'status', v_period.status);
end;
$function$;

create or replace function public.reject_pharmacy_accounting_mutation()
returns trigger
language plpgsql
set search_path to 'public'
as $function$
begin
  raise exception 'ACCOUNTING_RECORDS_IMMUTABLE: post a reversing entry instead';
end;
$function$;

drop trigger if exists pharmacy_accounting_journal_entries_immutable on public.pharmacy_accounting_journal_entries;
create trigger pharmacy_accounting_journal_entries_immutable
  before update or delete on public.pharmacy_accounting_journal_entries
  for each row execute function public.reject_pharmacy_accounting_mutation();

drop trigger if exists pharmacy_accounting_journal_lines_immutable on public.pharmacy_accounting_journal_lines;
create trigger pharmacy_accounting_journal_lines_immutable
  before update or delete on public.pharmacy_accounting_journal_lines
  for each row execute function public.reject_pharmacy_accounting_mutation();

create or replace function public.post_pharmacy_pos_sale_to_ledger()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_accounts jsonb;
  v_lines jsonb := '[]'::jsonb;
  v_paid numeric(18, 2);
  v_receivable numeric(18, 2);
  v_cost numeric(18, 2);
  v_cash_account text;
  v_payment_match text[];
  v_currency text;
  v_entry_date date := (timezone('Africa/Kampala', new.created_at))::date;
begin
  if new.status <> 'completed' or new.total_amount <= 0 then
    return new;
  end if;
  if tg_op = 'UPDATE' and old.total_amount > 0 then
    return new;
  end if;

  perform public.seed_pharmacy_accounting_accounts(new.tenant_id);
  select jsonb_object_agg(system_key, id) into v_accounts
  from public.pharmacy_accounting_accounts
  where tenant_id = new.tenant_id and system_key is not null;

  select currency into v_currency
  from public.pharmacy_settings where tenant_id = new.tenant_id limit 1;
  v_currency := coalesce(v_currency, 'UGX');

  v_payment_match := regexp_match(coalesce(new.payment_ref, ''), 'PAID:([0-9]+([.][0-9]+)?)');
  if v_payment_match is not null then
    v_paid := coalesce(v_payment_match[1]::numeric, 0);
  elsif lower(new.payment_method) = 'credit' then
    v_paid := 0;
  else
    v_paid := new.total_amount;
  end if;
  v_paid := least(greatest(round(v_paid, 2), 0), new.total_amount);
  v_receivable := new.total_amount - v_paid;

  v_cash_account := case lower(new.payment_method)
    when 'mobile_money' then 'MOBILE_MONEY_CLEARING'
    when 'mobile money' then 'MOBILE_MONEY_CLEARING'
    when 'card' then 'CARD_CLEARING'
    when 'bank_transfer' then 'BANK'
    when 'bank transfer' then 'BANK'
    when 'insurance' then 'ACCOUNTS_RECEIVABLE'
    else 'CASH_ON_HAND'
  end;

  if v_paid > 0 then
    v_lines := v_lines || jsonb_build_array(jsonb_build_object(
      'account_id', v_accounts->>v_cash_account, 'debit', v_paid, 'credit', 0,
      'description', 'Settlement for receipt ' || coalesce(new.receipt_number, new.id::text)));
  end if;
  if v_receivable > 0 then
    v_lines := v_lines || jsonb_build_array(jsonb_build_object(
      'account_id', v_accounts->>'ACCOUNTS_RECEIVABLE', 'debit', v_receivable, 'credit', 0,
      'description', 'Customer balance for receipt ' || coalesce(new.receipt_number, new.id::text)));
  end if;
  if new.subtotal > 0 then
    v_lines := v_lines || jsonb_build_array(jsonb_build_object(
      'account_id', v_accounts->>'SALES_REVENUE', 'debit', 0, 'credit', new.subtotal,
      'description', 'Gross sales for receipt ' || coalesce(new.receipt_number, new.id::text)));
  end if;
  if new.discount_total > 0 then
    v_lines := v_lines || jsonb_build_array(jsonb_build_object(
      'account_id', v_accounts->>'SALES_DISCOUNTS', 'debit', new.discount_total, 'credit', 0,
      'description', 'Discounts for receipt ' || coalesce(new.receipt_number, new.id::text)));
  end if;
  if new.tax_amount > 0 then
    v_lines := v_lines || jsonb_build_array(jsonb_build_object(
      'account_id', v_accounts->>'OUTPUT_VAT', 'debit', 0, 'credit', new.tax_amount,
      'description', 'Output VAT for receipt ' || coalesce(new.receipt_number, new.id::text)));
  end if;

  select round(coalesce(sum(i.quantity * coalesce(b.cost_price, p.cost_price, 0)), 0), 2)
  into v_cost
  from public.pharmacy_pos_sale_items i
  join public.pharmacy_products p on p.id = i.product_id and p.tenant_id = i.tenant_id
  left join public.pharmacy_product_batches b on b.id = i.batch_id and b.tenant_id = i.tenant_id
  where i.tenant_id = new.tenant_id and i.sale_id = new.id;

  if v_cost > 0 then
    v_lines := v_lines || jsonb_build_array(
      jsonb_build_object('account_id', v_accounts->>'COST_OF_GOODS_SOLD', 'debit', v_cost, 'credit', 0,
        'description', 'Cost of goods sold for receipt ' || coalesce(new.receipt_number, new.id::text)),
      jsonb_build_object('account_id', v_accounts->>'INVENTORY', 'debit', 0, 'credit', v_cost,
        'description', 'Inventory relieved for receipt ' || coalesce(new.receipt_number, new.id::text))
    );
  end if;

  perform public.post_pharmacy_accounting_journal(
    new.tenant_id, 'sale', new.id::text, v_entry_date,
    'POS sale ' || coalesce(new.receipt_number, new.id::text),
    v_currency, new.cashier_id, v_lines
  );
  return new;
end;
$function$;

drop trigger if exists pharmacy_pos_sale_accounting_post on public.pharmacy_pos_sales;
create trigger pharmacy_pos_sale_accounting_post
  after insert or update of total_amount on public.pharmacy_pos_sales
  for each row execute function public.post_pharmacy_pos_sale_to_ledger();

create or replace function public.post_pharmacy_purchase_to_ledger()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_accounts jsonb;
  v_lines jsonb := '[]'::jsonb;
  v_paid numeric(18, 2);
  v_payable numeric(18, 2);
  v_inventory numeric(18, 2);
  v_cash_account text;
begin
  if new.status <> 'RECEIVED' or new.total <= 0 then
    return new;
  end if;
  if new.amount_paid < 0 or new.amount_paid > new.total
    or new.amount_paid <> round(new.amount_paid, 2) then
    raise exception 'ACCOUNTING_PURCHASE_PAYMENT_AMOUNT_INVALID';
  end if;
  if tg_op = 'UPDATE' and old.status = 'RECEIVED' then
    return new;
  end if;

  perform public.seed_pharmacy_accounting_accounts(new.tenant_id);
  select jsonb_object_agg(system_key, id) into v_accounts
  from public.pharmacy_accounting_accounts
  where tenant_id = new.tenant_id and system_key is not null;

  v_paid := least(greatest(round(coalesce(new.amount_paid, 0), 2), 0), new.total);
  v_payable := new.total - v_paid;
  v_inventory := greatest(round(coalesce(new.subtotal, 0) - coalesce(new.discount, 0) + coalesce(new.other_cost, 0), 2), 0);
  v_cash_account := case lower(coalesce(new.payment_method, 'cash'))
    when 'mobile_money' then 'MOBILE_MONEY_CLEARING'
    when 'mobile money' then 'MOBILE_MONEY_CLEARING'
    when 'card' then 'CARD_CLEARING'
    when 'bank_transfer' then 'BANK'
    when 'bank transfer' then 'BANK'
    else 'CASH_ON_HAND'
  end;

  if v_inventory > 0 then
    v_lines := v_lines || jsonb_build_array(jsonb_build_object(
      'account_id', v_accounts->>'INVENTORY', 'debit', v_inventory, 'credit', 0,
      'description', 'Stock received for purchase ' || new.purchase_no));
  end if;
  if new.tax > 0 then
    v_lines := v_lines || jsonb_build_array(jsonb_build_object(
      'account_id', v_accounts->>'INPUT_VAT', 'debit', new.tax, 'credit', 0,
      'description', 'Input VAT for purchase ' || new.purchase_no));
  end if;
  if v_paid > 0 then
    v_lines := v_lines || jsonb_build_array(jsonb_build_object(
      'account_id', v_accounts->>v_cash_account, 'debit', 0, 'credit', v_paid,
      'description', 'Supplier payment for purchase ' || new.purchase_no));
  end if;
  if v_payable > 0 then
    v_lines := v_lines || jsonb_build_array(jsonb_build_object(
      'account_id', v_accounts->>'ACCOUNTS_PAYABLE', 'debit', 0, 'credit', v_payable,
      'description', 'Supplier balance for purchase ' || new.purchase_no));
  end if;

  perform public.post_pharmacy_accounting_journal(
    new.tenant_id, 'purchase', new.id::text, new.purchase_date,
    'Supplier purchase ' || new.purchase_no, new.currency, new.received_by, v_lines
  );
  return new;
end;
$function$;

drop trigger if exists pharmacy_purchase_accounting_post on public.pharmacy_purchases;
create trigger pharmacy_purchase_accounting_post
  after insert or update of status on public.pharmacy_purchases
  for each row execute function public.post_pharmacy_purchase_to_ledger();

create or replace function public.post_pharmacy_credit_repayment_to_ledger()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_accounts jsonb;
  v_cash_account text;
  v_currency text;
begin
  if new.type <> 'repayment' then
    return new;
  end if;

  perform public.seed_pharmacy_accounting_accounts(new.tenant_id);
  select jsonb_object_agg(system_key, id) into v_accounts
  from public.pharmacy_accounting_accounts
  where tenant_id = new.tenant_id and system_key is not null;

  v_cash_account := case lower(coalesce(new.payment_method, 'cash'))
    when 'mobile_money' then 'MOBILE_MONEY_CLEARING'
    when 'mobile money' then 'MOBILE_MONEY_CLEARING'
    when 'card' then 'CARD_CLEARING'
    when 'bank_transfer' then 'BANK'
    when 'bank transfer' then 'BANK'
    else 'CASH_ON_HAND'
  end;

  select currency into v_currency
  from public.pharmacy_settings where tenant_id = new.tenant_id limit 1;

  perform public.post_pharmacy_accounting_journal(
    new.tenant_id,
    'customer_receipt',
    new.id::text,
    (timezone('Africa/Kampala', new.created_at))::date,
    'Customer repayment' || case when new.customer_id is not null then ' ' || new.customer_id::text else '' end,
    coalesce(v_currency, 'UGX'),
    new.created_by,
    jsonb_build_array(
      jsonb_build_object('account_id', v_accounts->>v_cash_account, 'debit', new.amount, 'credit', 0,
        'description', 'Customer payment received'),
      jsonb_build_object('account_id', v_accounts->>'ACCOUNTS_RECEIVABLE', 'debit', 0, 'credit', new.amount,
        'description', 'Customer receivable settled')
    )
  );
  return new;
end;
$function$;

drop trigger if exists pharmacy_credit_repayment_accounting_post on public.pharmacy_credit_ledger;
create trigger pharmacy_credit_repayment_accounting_post
  after insert on public.pharmacy_credit_ledger
  for each row execute function public.post_pharmacy_credit_repayment_to_ledger();

create or replace function public.post_pharmacy_supplier_payment_to_ledger()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_delta numeric(18, 2);
  v_accounts jsonb;
  v_cash_account text;
begin
  if new.status <> 'RECEIVED' then
    return new;
  end if;

  v_delta := round(coalesce(new.amount_paid, 0) - coalesce(old.amount_paid, 0), 2);
  if v_delta = 0 then
    return new;
  end if;
  if v_delta < 0 or new.amount_paid > new.total
    or new.amount_paid <> round(new.amount_paid, 2) then
    raise exception 'ACCOUNTING_SUPPLIER_PAYMENT_AMOUNT_INVALID';
  end if;

  perform public.seed_pharmacy_accounting_accounts(new.tenant_id);
  select jsonb_object_agg(system_key, id) into v_accounts
  from public.pharmacy_accounting_accounts
  where tenant_id = new.tenant_id and system_key is not null;

  v_cash_account := case lower(coalesce(new.payment_method, 'cash'))
    when 'mobile_money' then 'MOBILE_MONEY_CLEARING'
    when 'mobile money' then 'MOBILE_MONEY_CLEARING'
    when 'card' then 'CARD_CLEARING'
    when 'bank_transfer' then 'BANK'
    when 'bank transfer' then 'BANK'
    else 'CASH_ON_HAND'
  end;

  perform public.post_pharmacy_accounting_journal(
    new.tenant_id,
    'supplier_payment',
    new.id::text || ':' || to_char(new.amount_paid, 'FM999999999990.00'),
    (timezone('Africa/Kampala', now()))::date,
    'Payment to supplier for purchase ' || new.purchase_no,
    new.currency,
    new.received_by,
    jsonb_build_array(
      jsonb_build_object('account_id', v_accounts->>'ACCOUNTS_PAYABLE', 'debit', v_delta, 'credit', 0,
        'description', 'Supplier payable settled'),
      jsonb_build_object('account_id', v_accounts->>v_cash_account, 'debit', 0, 'credit', v_delta,
        'description', 'Supplier payment')
    )
  );
  return new;
end;
$function$;

drop trigger if exists pharmacy_supplier_payment_accounting_post on public.pharmacy_purchases;
create trigger pharmacy_supplier_payment_accounting_post
  after update of amount_paid on public.pharmacy_purchases
  for each row execute function public.post_pharmacy_supplier_payment_to_ledger();

create or replace function public.post_pharmacy_sale_reversal_to_ledger()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_original public.pharmacy_accounting_journal_entries%rowtype;
  v_lines jsonb;
begin
  if new.status not in ('voided', 'refunded') or old.status = new.status then
    return new;
  end if;

  select * into v_original
  from public.pharmacy_accounting_journal_entries
  where tenant_id = new.tenant_id and source_type = 'sale' and source_id = new.id::text;
  if not found then
    return new;
  end if;

  select jsonb_agg(jsonb_build_object(
    'account_id', account_id,
    'debit', credit,
    'credit', debit,
    'description', coalesce(description, 'Reversal of sale ' || coalesce(new.receipt_number, new.id::text))
  ) order by id)
  into v_lines
  from public.pharmacy_accounting_journal_lines
  where tenant_id = new.tenant_id and journal_entry_id = v_original.id;

  perform public.post_pharmacy_accounting_journal(
    new.tenant_id,
    'sale_reversal',
    new.id::text,
    (timezone('Africa/Kampala', coalesce(new.voided_at, new.updated_at, now())))::date,
    'Reversal of POS sale ' || coalesce(new.receipt_number, new.id::text) || ': ' || coalesce(new.voided_reason, 'refund'),
    v_original.currency,
    coalesce(new.confirmed_by, new.cashier_id),
    v_lines
  );
  return new;
end;
$function$;

drop trigger if exists pharmacy_sale_reversal_accounting_post on public.pharmacy_pos_sales;
create trigger pharmacy_sale_reversal_accounting_post
  after update of status on public.pharmacy_pos_sales
  for each row execute function public.post_pharmacy_sale_reversal_to_ledger();

create or replace function public.import_pharmacy_bank_statement(
  p_tenant_id uuid,
  p_file_name text,
  p_currency text,
  p_imported_by uuid,
  p_idempotency_key text,
  p_rows jsonb
)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_import public.pharmacy_bank_statement_imports%rowtype;
  v_row jsonb;
  v_row_date date;
  v_row_amount numeric;
  v_row_currency text;
  v_line_number integer;
  v_count integer := 0;
  v_content_hash text;
begin
  if p_tenant_id is null or nullif(trim(p_file_name), '') is null
    or nullif(trim(p_idempotency_key), '') is null or p_currency is null
    or upper(trim(p_currency)) !~ '^[A-Z]{3}$'
    or jsonb_typeof(p_rows) is distinct from 'array' then
    raise exception 'BANK_IMPORT_INVALID';
  end if;
  if jsonb_array_length(p_rows) < 1 or jsonb_array_length(p_rows) > 5000 then
    raise exception 'BANK_IMPORT_INVALID';
  end if;
  v_content_hash := md5(upper(trim(p_currency)) || ':' || p_rows::text);

  select * into v_import
  from public.pharmacy_bank_statement_imports
  where tenant_id = p_tenant_id and idempotency_key = trim(p_idempotency_key);
  if found then
    if v_import.content_hash <> v_content_hash then
      raise exception 'BANK_IMPORT_IDEMPOTENCY_CONFLICT';
    end if;
    return jsonb_build_object('id', v_import.id, 'replayed', true);
  end if;
  select * into v_import
  from public.pharmacy_bank_statement_imports
  where tenant_id = p_tenant_id and content_hash = v_content_hash;
  if found then
    return jsonb_build_object('id', v_import.id, 'replayed', true);
  end if;

  insert into public.pharmacy_bank_statement_imports
    (tenant_id, file_name, currency, idempotency_key, content_hash, imported_by)
  values
    (p_tenant_id, left(trim(p_file_name), 255), upper(trim(p_currency)), trim(p_idempotency_key), v_content_hash, p_imported_by)
  on conflict do nothing
  returning * into v_import;
  if v_import.id is null then
    select * into v_import
    from public.pharmacy_bank_statement_imports
    where tenant_id = p_tenant_id and idempotency_key = trim(p_idempotency_key);
    if found then
      if v_import.content_hash <> v_content_hash then
        raise exception 'BANK_IMPORT_IDEMPOTENCY_CONFLICT';
      end if;
      return jsonb_build_object('id', v_import.id, 'replayed', true);
    end if;
    select * into v_import
    from public.pharmacy_bank_statement_imports
    where tenant_id = p_tenant_id and content_hash = v_content_hash;
    if not found then
      raise exception 'BANK_IMPORT_IDEMPOTENCY_CONFLICT';
    end if;
    return jsonb_build_object('id', v_import.id, 'replayed', true);
  end if;

  for v_row in select value from jsonb_array_elements(p_rows)
  loop
    if jsonb_typeof(v_row) is distinct from 'object' then
      raise exception 'BANK_IMPORT_INVALID_ROW';
    end if;
    v_line_number := (v_row->>'lineNumber')::integer;
    v_row_date := (v_row->>'date')::date;
    v_row_amount := round((v_row->>'amount')::numeric, 2);
    v_row_currency := upper(coalesce(nullif(trim(v_row->>'currency'), ''), upper(trim(p_currency))));
    if v_line_number is null or v_line_number < 1 or v_row_date is null or v_row_amount is null
      or nullif(trim(v_row->>'description'), '') is null
      or v_row_amount = 0
      or v_row_currency <> upper(trim(p_currency)) then
      raise exception 'BANK_IMPORT_INVALID_ROW';
    end if;
    if (v_row->>'amount')::numeric <> v_row_amount then
      raise exception 'BANK_IMPORT_AMOUNT_PRECISION';
    end if;

    insert into public.pharmacy_bank_statement_lines
      (tenant_id, import_id, line_number, statement_date, description, reference, currency, amount)
    values
      (p_tenant_id, v_import.id, v_line_number, v_row_date,
       left(trim(v_row->>'description'), 500),
       nullif(left(trim(v_row->>'reference'), 200), ''),
       v_row_currency, v_row_amount);
    v_count := v_count + 1;
  end loop;

  insert into public.pharmacy_audit_logs
    (tenant_id, profile_id, action, entity, entity_id, details)
  values
    (p_tenant_id, p_imported_by, 'ACCOUNTING_BANK_STATEMENT_IMPORTED',
     'PHARMACY_BANK_STATEMENT_IMPORT', v_import.id::text,
     jsonb_build_object('file_name', v_import.file_name, 'line_count', v_count, 'currency', v_import.currency)::text);

  return jsonb_build_object('id', v_import.id, 'line_count', v_count, 'replayed', false);
end;
$function$;

create or replace function public.pharmacy_accounting_bank_match_candidates(p_tenant_id uuid)
returns table (
  journal_line_id uuid,
  journal_entry_id uuid,
  entry_no text,
  entry_date date,
  description text,
  currency text,
  amount numeric
)
language sql
stable
security definer
set search_path to 'public'
as $function$
  select l.id, e.id, e.entry_no, e.entry_date, e.description, e.currency,
    round(l.debit - l.credit, 2)
  from public.pharmacy_accounting_journal_lines l
  join public.pharmacy_accounting_journal_entries e
    on e.id = l.journal_entry_id and e.tenant_id = l.tenant_id
  join public.pharmacy_accounting_accounts a
    on a.id = l.account_id and a.tenant_id = l.tenant_id
  where l.tenant_id = p_tenant_id and a.system_key = 'BANK'
    and not exists (
      select 1 from public.pharmacy_bank_statement_lines s
      where s.tenant_id = l.tenant_id and s.matched_journal_line_id = l.id
    )
    and exists (
      select 1 from public.pharmacy_bank_statement_lines s
      where s.tenant_id = l.tenant_id and s.matched_journal_line_id is null
        and s.currency = e.currency and s.amount = round(l.debit - l.credit, 2)
    )
  order by e.entry_date desc, e.created_at desc
  limit 5000
$function$;

create or replace function public.match_pharmacy_bank_statement_line(
  p_tenant_id uuid,
  p_statement_line_id uuid,
  p_journal_line_id uuid,
  p_matched_by uuid
)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_statement public.pharmacy_bank_statement_lines%rowtype;
  v_amount numeric(18, 2);
  v_currency text;
  v_entry_id uuid;
begin
  select * into v_statement
  from public.pharmacy_bank_statement_lines
  where id = p_statement_line_id and tenant_id = p_tenant_id
  for update;
  if not found then
    raise exception 'BANK_STATEMENT_LINE_NOT_FOUND';
  end if;
  if v_statement.matched_journal_line_id is not null then
    if v_statement.matched_journal_line_id = p_journal_line_id then
      return jsonb_build_object('id', v_statement.id, 'replayed', true);
    end if;
    raise exception 'BANK_STATEMENT_LINE_ALREADY_MATCHED';
  end if;

  select round(l.debit - l.credit, 2), e.currency, e.id
  into v_amount, v_currency, v_entry_id
  from public.pharmacy_accounting_journal_lines l
  join public.pharmacy_accounting_journal_entries e
    on e.id = l.journal_entry_id and e.tenant_id = l.tenant_id
  join public.pharmacy_accounting_accounts a
    on a.id = l.account_id and a.tenant_id = l.tenant_id
  where l.id = p_journal_line_id and l.tenant_id = p_tenant_id and a.system_key = 'BANK'
  for update of l;
  if not found then
    raise exception 'BANK_JOURNAL_LINE_NOT_FOUND';
  end if;
  if v_amount <> v_statement.amount or v_currency <> v_statement.currency then
    raise exception 'BANK_MATCH_AMOUNT_MISMATCH';
  end if;

  update public.pharmacy_bank_statement_lines
  set matched_journal_line_id = p_journal_line_id,
      matched_by = p_matched_by,
      matched_at = now()
  where id = p_statement_line_id and tenant_id = p_tenant_id;

  insert into public.pharmacy_audit_logs
    (tenant_id, profile_id, action, entity, entity_id, details)
  values
    (p_tenant_id, p_matched_by, 'ACCOUNTING_BANK_LINE_MATCHED',
     'PHARMACY_BANK_STATEMENT_LINE', p_statement_line_id::text,
     jsonb_build_object('journal_line_id', p_journal_line_id, 'journal_entry_id', v_entry_id)::text);

  return jsonb_build_object('id', p_statement_line_id, 'journal_entry_id', v_entry_id, 'replayed', false);
end;
$function$;

do $$
declare
  v_table text;
begin
  foreach v_table in array array[
    'pharmacy_accounting_accounts',
    'pharmacy_accounting_periods',
    'pharmacy_accounting_journal_entries',
    'pharmacy_accounting_journal_lines',
    'pharmacy_bank_statement_imports',
    'pharmacy_bank_statement_lines'
  ] loop
    execute format('alter table public.%I enable row level security', v_table);
    execute format('revoke all on public.%I from public, anon, authenticated, service_role', v_table);
    execute format('grant select on public.%I to service_role', v_table);
  end loop;
end $$;

revoke all on function public.seed_pharmacy_accounting_accounts(uuid) from public, anon, authenticated;
grant execute on function public.seed_pharmacy_accounting_accounts(uuid) to service_role;
revoke all on function public.post_pharmacy_accounting_journal(uuid, text, text, date, text, text, uuid, jsonb)
  from public, anon, authenticated;
grant execute on function public.post_pharmacy_accounting_journal(uuid, text, text, date, text, text, uuid, jsonb)
  to service_role;
revoke all on function public.pharmacy_accounting_trial_balance(uuid, date, date)
  from public, anon, authenticated;
grant execute on function public.pharmacy_accounting_trial_balance(uuid, date, date)
  to service_role;
revoke all on function public.close_pharmacy_accounting_period(uuid, date, date, uuid)
  from public, anon, authenticated;
grant execute on function public.close_pharmacy_accounting_period(uuid, date, date, uuid)
  to service_role;
revoke all on function public.reject_pharmacy_accounting_mutation() from public, anon, authenticated;
revoke all on function public.post_pharmacy_pos_sale_to_ledger() from public, anon, authenticated;
revoke all on function public.post_pharmacy_purchase_to_ledger() from public, anon, authenticated;
revoke all on function public.post_pharmacy_credit_repayment_to_ledger() from public, anon, authenticated;
revoke all on function public.post_pharmacy_supplier_payment_to_ledger() from public, anon, authenticated;
revoke all on function public.post_pharmacy_sale_reversal_to_ledger() from public, anon, authenticated;
revoke all on function public.import_pharmacy_bank_statement(uuid, text, text, uuid, text, jsonb)
  from public, anon, authenticated;
grant execute on function public.import_pharmacy_bank_statement(uuid, text, text, uuid, text, jsonb)
  to service_role;
revoke all on function public.pharmacy_accounting_bank_match_candidates(uuid)
  from public, anon, authenticated;
grant execute on function public.pharmacy_accounting_bank_match_candidates(uuid)
  to service_role;
revoke all on function public.match_pharmacy_bank_statement_line(uuid, uuid, uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.match_pharmacy_bank_statement_line(uuid, uuid, uuid, uuid)
  to service_role;

drop function if exists public.post_pharmacy_credit_entry(uuid, uuid, text, numeric, uuid, date, text, uuid, text);
create function public.post_pharmacy_credit_entry(
  p_tenant_id uuid,
  p_customer_id uuid,
  p_type text,
  p_amount numeric,
  p_transaction_id uuid default null,
  p_due_date date default null,
  p_notes text default null,
  p_created_by uuid default null,
  p_idempotency_key text default null,
  p_payment_method text default 'cash'
)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_key text := nullif(trim(coalesce(p_idempotency_key, '')), '');
  v_existing public.pharmacy_credit_ledger%rowtype;
  v_balance numeric;
  v_after numeric;
  v_row public.pharmacy_credit_ledger%rowtype;
  v_payment_method text := lower(trim(coalesce(p_payment_method, 'cash')));
begin
  if p_type not in ('credit', 'repayment') then
    raise exception 'INVALID_TYPE: %', p_type;
  end if;
  if p_amount is null or p_amount <= 0 then
    raise exception 'INVALID_AMOUNT: amount must be greater than zero';
  end if;
  if p_amount <> round(p_amount, 2) then
    raise exception 'INVALID_AMOUNT: at most two decimal places are supported';
  end if;
  if v_payment_method not in ('cash', 'card', 'mobile_money', 'mobile money', 'bank_transfer', 'bank transfer', 'credit') then
    raise exception 'INVALID_PAYMENT_METHOD';
  end if;

  perform 1 from public.pharmacy_customers
    where id = p_customer_id and tenant_id = p_tenant_id
    for update;
  if not found then
    raise exception 'CUSTOMER_NOT_FOUND';
  end if;

  if v_key is not null then
    select * into v_existing from public.pharmacy_credit_ledger
      where tenant_id = p_tenant_id and idempotency_key = v_key;
    if found then
      if v_existing.customer_id is distinct from p_customer_id
        or v_existing.type is distinct from p_type
        or v_existing.amount is distinct from round(p_amount, 2)
        or lower(coalesce(v_existing.payment_method, 'cash')) is distinct from v_payment_method then
        raise exception 'IDEMPOTENCY_CONFLICT';
      end if;
      return to_jsonb(v_existing) || jsonb_build_object('replayed', true);
    end if;
  end if;

  select balance_after into v_balance from public.pharmacy_credit_ledger
    where tenant_id = p_tenant_id and customer_id = p_customer_id
    order by created_at desc, id desc
    limit 1;
  v_balance := coalesce(v_balance, 0);

  if p_type = 'repayment' and p_amount > v_balance then
    raise exception 'OVERPAYMENT: repayment % exceeds outstanding balance %', p_amount, v_balance;
  end if;
  v_after := case when p_type = 'credit' then v_balance + p_amount else v_balance - p_amount end;

  insert into public.pharmacy_credit_ledger
    (tenant_id, customer_id, transaction_id, amount, type, balance_after,
     due_date, notes, created_by, created_at, idempotency_key, payment_method)
  values
    (p_tenant_id, p_customer_id, p_transaction_id, p_amount, p_type, v_after,
     p_due_date, p_notes, p_created_by, clock_timestamp(), v_key, v_payment_method)
  returning * into v_row;

  return to_jsonb(v_row) || jsonb_build_object('replayed', false);
end;
$function$;
revoke all on function public.post_pharmacy_credit_entry(uuid, uuid, text, numeric, uuid, date, text, uuid, text, text)
  from public, anon, authenticated;
grant execute on function public.post_pharmacy_credit_entry(uuid, uuid, text, numeric, uuid, date, text, uuid, text, text)
  to service_role;

select public.seed_pharmacy_accounting_accounts(id) from public.tenants where facility_type = 'pharmacy';
