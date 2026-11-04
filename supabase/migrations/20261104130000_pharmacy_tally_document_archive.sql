-- 20261104130000_pharmacy_tally_document_archive
--
-- The archive tables for docs/pharmacy/TALLY_DOCUMENT_CHAIN_DESIGN.md §5:
-- orders, delivery notes, receipt notes, rejections and stock journals are
-- classified by the import but never staged today, because
-- `tallyVoucherSourceType` maps only the eight types that post to the ledger.
-- These three tables give those documents somewhere to land that cannot be
-- mistaken for a live document:
--
--   * nothing reads them for stock, FEFO, balances or any workflow;
--   * `authenticated` has SELECT and nothing else — no INSERT, UPDATE or
--     DELETE grant, and no policy for those commands, so row security denies
--     them twice over;
--   * writes come from the service role during the archive apply only.
--
-- The design deliberately does not add a trigger that refuses updates. The
-- guarantee is the grant matrix and the absence of a route that writes a
-- document, both of which are visible here. A future trigger may harden it;
-- this migration does not pretend one exists.
--
-- Gate 0 (§3) has not been answered — no real Tally export has been probed
-- yet. That is why this is PREPARED ONLY and not applied anywhere by this
-- change. Q2 may show that a linkage field is missing or named differently;
-- `linked_source_key`/`linked_voucher_number` carry only what Tally supplied
-- and stay null otherwise, so an unanswered field costs a column, not a
-- schema rewrite.
--
-- Tenant isolation follows 20261102130000, the current house pattern:
-- `tenant_id = any (public.pharmacy_caller_tenants()) or
-- public.is_platform_admin()`, scoped `TO authenticated`.

begin;

-- ---------------------------------------------------------------------------
-- 1. The documents.
--
-- `source_key` is the dedupe identity: the voucher GUID when the export
-- carries one, else the remote id, else a content hash the caller computes.
-- `unique (tenant_id, company_key, source_key)` makes the apply idempotent on
-- re-run, which is what lets a wider period be appended later without
-- deleting anything.
--
-- `voucher_type` is exactly what Tally printed; `voucher_kind` is the
-- normalised value from `classifyTallyVoucherType`. Both are stored because
-- the reader shows the first and reasons about the second.
-- ---------------------------------------------------------------------------
create table if not exists public.pharmacy_tally_documents (
  id                    uuid primary key default gen_random_uuid(),
  tenant_id             uuid not null references public.tenants(id) on delete cascade,
  session_id            uuid not null references public.pharmacy_import_sessions(id) on delete restrict,
  company_key           text not null,
  source_key            text not null,
  source_guid           text,
  source_remote_id      text,
  voucher_type          text not null,
  voucher_kind          text not null,
  voucher_number        text,
  voucher_date          date not null,
  party_name            text,
  narration             text,
  currency              text,
  -- Null when the document carries no value at all (an order, a delivery
  -- note before billing). Never 0 in place of "no value".
  total_amount          numeric,
  is_cancelled          boolean not null default false,
  is_pre_conversion     boolean not null default false,
  -- Filled only when Tally supplied a reference. Nothing here is inferred
  -- from a date, a party or a number pattern.
  linked_source_key     text,
  linked_voucher_number text,
  imported_at           timestamptz not null default now(),
  constraint pharmacy_tally_documents_kind_check check (
    voucher_kind in (
      'sales', 'purchase', 'receipt', 'payment', 'contra', 'journal',
      'credit_note', 'debit_note', 'order', 'inventory_note',
      'stock_journal', 'other'
    )
  ),
  constraint pharmacy_tally_documents_identity_key
    unique (tenant_id, company_key, source_key),
  -- Redundant with the primary key, but a composite foreign key needs a
  -- unique constraint to point at.
  constraint pharmacy_tally_documents_id_tenant_key unique (id, tenant_id)
);

-- ---------------------------------------------------------------------------
-- 2. The lines.
--
-- `stock_item_name` is Tally's name, never rewritten. `product_id` is a
-- display convenience resolved by SKU then exact name; a line that cannot be
-- matched keeps null and its Tally name. No product is created from here.
--
-- `batches` is JSON because it is archival — it is never read by FEFO, stock
-- reporting or the sale path.
--
-- The foreign key is composite on (document_id, tenant_id) rather than
-- document_id alone. A line whose tenant_id disagreed with its document's
-- would be shown to the wrong tenant by the policy below, and the service
-- role writes these rows. The constraint makes that unrepresentable.
-- ---------------------------------------------------------------------------
create table if not exists public.pharmacy_tally_document_lines (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references public.tenants(id) on delete cascade,
  document_id     uuid not null,
  line_no         integer not null,
  stock_item_name text not null,
  product_id      uuid references public.pharmacy_products(id) on delete set null,
  quantity        numeric,
  unit            text,
  rate            numeric,
  amount          numeric,
  godown          text,
  batches         jsonb not null default '[]'::jsonb,
  constraint pharmacy_tally_document_lines_document_fkey
    foreign key (document_id, tenant_id)
    references public.pharmacy_tally_documents (id, tenant_id)
    on delete cascade,
  constraint pharmacy_tally_document_lines_line_key unique (document_id, line_no),
  constraint pharmacy_tally_document_lines_line_no_check check (line_no > 0),
  constraint pharmacy_tally_document_lines_batches_check
    check (jsonb_typeof(batches) = 'array')
);

-- ---------------------------------------------------------------------------
-- 3. The apply checkpoint.
--
-- Deliberately not in `pharmacy_import_sessions.progress`: a document pass is
-- a separate pass (§8) that may run after the cut-over has completed, and
-- sharing the progress blob would let an offset from one corrupt the other.
--
-- No policy and no grant to `authenticated`: this is machinery, not a
-- document. Progress reaches the operator through the route that owns it.
-- ---------------------------------------------------------------------------
create table if not exists public.pharmacy_tally_document_imports (
  tenant_id  uuid not null references public.tenants(id) on delete cascade,
  session_id uuid not null references public.pharmacy_import_sessions(id) on delete restrict,
  stage      text not null default 'pending',
  progress   jsonb not null default '{}'::jsonb,
  started_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (tenant_id, session_id),
  constraint pharmacy_tally_document_imports_stage_check check (
    stage in ('pending', 'running', 'complete', 'failed')
  )
);

-- ---------------------------------------------------------------------------
-- 4. Indexes for the reader the design specifies: search by date, type,
-- number and party, with lines joined per document.
-- ---------------------------------------------------------------------------
create index if not exists idx_pharmacy_tally_documents_tenant_date
  on public.pharmacy_tally_documents (tenant_id, voucher_date desc, id);

create index if not exists idx_pharmacy_tally_documents_tenant_kind
  on public.pharmacy_tally_documents (tenant_id, voucher_kind);

create index if not exists idx_pharmacy_tally_documents_tenant_number
  on public.pharmacy_tally_documents (tenant_id, voucher_number);

create index if not exists idx_pharmacy_tally_documents_tenant_party
  on public.pharmacy_tally_documents (tenant_id, party_name);

create index if not exists idx_pharmacy_tally_document_lines_tenant_product
  on public.pharmacy_tally_document_lines (tenant_id, product_id);

-- ---------------------------------------------------------------------------
-- 5. Read-only for application roles.
--
-- SELECT only for `authenticated`; the service role writes during apply and
-- bypasses row security. RLS is enabled on all three, and no INSERT, UPDATE
-- or DELETE policy exists — so even a future grant of those commands would
-- still be denied until a policy is added on purpose.
-- ---------------------------------------------------------------------------
alter table public.pharmacy_tally_documents enable row level security;
alter table public.pharmacy_tally_document_lines enable row level security;
alter table public.pharmacy_tally_document_imports enable row level security;

revoke all on public.pharmacy_tally_documents from public, anon, authenticated;
revoke all on public.pharmacy_tally_document_lines from public, anon, authenticated;
revoke all on public.pharmacy_tally_document_imports from public, anon, authenticated;

grant select on public.pharmacy_tally_documents to authenticated;
grant select on public.pharmacy_tally_document_lines to authenticated;

grant select, insert, update, delete on public.pharmacy_tally_documents to service_role;
grant select, insert, update, delete on public.pharmacy_tally_document_lines to service_role;
grant select, insert, update, delete on public.pharmacy_tally_document_imports to service_role;

create policy pharmacy_tally_documents_tenant_read
  on public.pharmacy_tally_documents
  for select
  to authenticated
  using (
    tenant_id = any (public.pharmacy_caller_tenants())
    or public.is_platform_admin()
  );

create policy pharmacy_tally_document_lines_tenant_read
  on public.pharmacy_tally_document_lines
  for select
  to authenticated
  using (
    tenant_id = any (public.pharmacy_caller_tenants())
    or public.is_platform_admin()
  );

commit;
