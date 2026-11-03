# Tally document-chain design

**Status: proposal. Nothing described here is built, and nothing here
authorises a build.** It exists so the decision to carry Tally's non-posting
documents into Pharmacy is made against what is actually possible, not against
what the word "migration" suggests.

Companion documents:

- [TALLY_MIGRATION_ARCHITECTURE.md](./TALLY_MIGRATION_ARCHITECTURE.md) — the current boundary
- [TALLY_MIGRATION_ACCEPTANCE_CRITERIA.md](./TALLY_MIGRATION_ACCEPTANCE_CRITERIA.md) — sign-off, incl. AC-9
- [TALLY_PRIME_ERP9_ACCEPTANCE.md](./TALLY_PRIME_ERP9_ACCEPTANCE.md) — both editions
- [TALLY_UPLOAD_GUIDE.md](./TALLY_UPLOAD_GUIDE.md) — what an operator does
- [FIRST_CUSTOMER_CUTOVER_RUNBOOK.md](./FIRST_CUSTOMER_CUTOVER_RUNBOOK.md) — the two cut-overs

---

## 1. The requirement

The client needs Tally's document chain available in Pharmacy, not only the
ledger postings and closing balances: sales orders becoming delivery notes
becoming invoices, purchase orders becoming receipt notes becoming bills, and
the rejection, stock journal and physical stock entries in between.

Today's importer deliberately does not carry those documents. It reads
`All Masters` and `Day Book`, posts the accounting vouchers, mirrors sales and
purchases, receives opening or closing stock, and reports every other voucher
type as an exception (`VOUCHER_TYPE_UNSUPPORTED`). That is a correct boundary
for an accounting migration and an insufficient one for this requirement.

This document proposes a second, separate import that stores those documents as
history without making them operational.

---

## 2. The document set

| Tally document | Posts to ledgers? | Today | Proposed |
|---|---|---|---|
| Sales invoice | yes | posted, mirrored | unchanged |
| Purchase invoice | yes | posted, mirrored | unchanged |
| Receipt / payment / contra / journal / credit note / debit note | yes | posted | unchanged |
| Sales order | no | exception, discarded | archived |
| Purchase order | no | exception, discarded | archived |
| Delivery note | stock only | exception, discarded | archived |
| Receipt note | stock only | exception, discarded | archived |
| Rejection in / out | stock only | exception, discarded | archived |
| Stock journal | stock only | exception, discarded | archived |
| Physical stock | stock only | exception, discarded | archived |
| Cancelled vouchers | no | skipped (`VOUCHER_CANCELLED`) | archived, marked cancelled |
| Vouchers before the conversion date | — | skipped | archived, marked pre-conversion |
| Multi-currency vouchers | yes | skipped | unchanged: the export carries no exchange rate the importer reads, so a foreign amount cannot be valued |

"Stock only" is the important column: those documents move inventory in Tally
but post nothing to a ledger. They are precisely the ones whose absence makes a
replayed stock figure drift away from Tally's closing stock.

Two periods are in play, and the archive must not blur them. The importer skips
every voucher dated before the conversion date (`VOUCHER_BEFORE_CONVERSION`) —
opening balances carry that period instead. The archive, if it covers the whole
Day Book range, will therefore hold documents that the ledger deliberately does
not contain. That is expected: the archive is a document record, not a trail of
the postings. The review screen should say which period each covers.

---

## 3. Gate 0 — what must be proven first

Three questions, none answerable from this repository, all answerable from one
read-only export of a copy of the client's company.

| # | Question | Why it decides the design |
|---|---|---|
| Q1 | Does Tally's `Day Book` XML export contain order vouchers, or only accounting and inventory vouchers? | The bridge can ask for exactly two reports. If orders are not in `Day Book`, the connector must change before any of this is possible |
| Q2 | Which linkage fields does the XML carry — `REFERENCE`, `VOUCHERREFERENCENUMBER`, `BASICORDER...`, dispatch details, due dates? | Without them the archive is a list of documents, not a chain |
| Q3 | What does Tally's own count of each document type say for the period? | That number is the only independent reconciliation the archive can be held to |

The current parser does not read order-linkage or dispatch fields at all
(`readVoucher` in `packages/db/src/tally-xml-rows.ts` keeps type, number, date,
party, narration, currency, cancellation, ledger lines and inventory lines). So
Q2 is as much a question about the parser as about Tally.

**Until Q1 and Q2 are answered, §5 onward is a shape that may not fit the
data.** The probe procedure is §13.

---

## 4. The decision: an archive, not operational tables

Synapse already has documents that resemble some of these — purchase orders
with `received_quantity`, purchases with `supplier_receipt_ref` and
`purchase_order_id`, supplier returns, stock adjustments, stock transfers. The
temptation is to map Tally's history into them.

It should not be done, for four reasons:

| Reason | Detail |
|---|---|
| Workflow | `pharmacy_purchase_orders` is a live document with statuses and buttons. A 2023 order imported as `CONFIRMED` is actionable: someone can receive it again |
| Missing shape | `pharmacy_supplier_returns` is a header-only lifecycle stub with no lines, products or quantities |
| Invented values | `pharmacy_stock_adjustments` requires `previous_qty` and `new_qty`; a historical Tally entry does not carry either, so importing it means fabricating a running balance |
| Double effect | receipts and delivery notes already had their stock effect inside the migrated period. Re-inserting them into receiving tables would apply it twice unless every path is suppressed |

An archive table carries what Tally carried, does nothing when written, and
cannot be mistaken for something to act on. That is the guarantee the client is
asking for.

---

## 5. Data model

Three tables. Not a migration yet — this is the proposed shape for review.

```sql
create table public.pharmacy_tally_documents (
  id                      uuid primary key default gen_random_uuid(),
  tenant_id               uuid not null references public.tenants(id) on delete cascade,
  session_id              uuid not null references public.pharmacy_import_sessions(id) on delete restrict,
  company_key             text not null,
  source_key              text not null,          -- guid, remoteId, or content hash
  source_guid             text,
  source_remote_id        text,
  voucher_type            text not null,          -- exactly what Tally printed
  voucher_kind            text not null,          -- normalised: sales | purchase | receipt | ... | order | inventory_note | stock_journal
  voucher_number          text,
  voucher_date            date not null,
  party_name              text,
  narration               text,
  currency                text,
  total_amount            numeric,                -- null when the document carries no value
  is_cancelled            boolean not null default false,
  is_pre_conversion       boolean not null default false,
  linked_source_key       text,                   -- filled only when Tally supplied a reference
  linked_voucher_number   text,
  imported_at             timestamptz not null default now(),
  unique (tenant_id, company_key, source_key)
);

create table public.pharmacy_tally_document_lines (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null references public.tenants(id) on delete cascade,
  document_id      uuid not null references public.pharmacy_tally_documents(id) on delete cascade,
  line_no          integer not null,
  stock_item_name  text not null,                 -- Tally's name, never rewritten
  product_id       uuid references public.pharmacy_products(id) on delete set null,
  quantity         numeric,
  unit             text,
  rate             numeric,
  amount           numeric,
  godown           text,
  batches          jsonb not null default '[]',   -- name, expiry, quantity, amount — as exported
  unique (document_id, line_no)
);

create table public.pharmacy_tally_document_imports (
  tenant_id    uuid not null references public.tenants(id) on delete cascade,
  session_id   uuid not null references public.pharmacy_import_sessions(id) on delete restrict,
  stage        text not null default 'pending',
  progress     jsonb not null default '{}',
  started_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  primary key (tenant_id, session_id)
);
```

Rules the schema enforces, and one it does not:

- `product_id` is a display convenience, resolved by SKU then exact name. A
  document line whose item cannot be matched keeps `product_id` null and its
  Tally name; no product is created and no name is corrected.
- `batches` is JSON because it is archival. It is never read by FEFO, stock
  reporting or the sale path.
- Read-only is **not** enforced by a trigger. It is enforced by there being no
  route that updates a document and no grant beyond `select` for
  `authenticated`, with writes from the service role during apply only. A
  future trigger could harden it; the design does not pretend one exists.

Tenant isolation follows the current house pattern, which is no longer the
per-table predicate the older migrations wrote. `20261102130000` settled on
`tenant_id = any (public.pharmacy_caller_tenants()) or public.is_platform_admin()`,
scopes every policy `TO authenticated`, and aborts the migration when a listed
pharmacy table has none. The three new tables must join that mechanism, not
invent a fourth variant.

Writes come from the service role during apply only. `authenticated` gets
`select` and nothing else.

---

## 6. Extraction and reconciliation

The documents come from the same chunks the vouchers come from, so nothing new
is fetched when the export is already being read.

- `mode = "closing"` currently skips the Day Book entirely. Document archiving
  needs it anyway, so the combination becomes: balances from `All Masters`,
  documents from `Day Book`, no vouchers posted. That is a third cut-over shape
  and should be named as one in the review screen rather than inferred.
- The document count joins the chunk manifest's reconciliation. A chunk whose
  documents were not independently counted stays `unverified`, exactly as a
  chunk of vouchers does today. It is disclosed, never upgraded.
- The raw XML stays in the private storage bucket, which is what makes a
  document pass possible after a cut-over has already been applied (§8).

---

## 7. Plan and review

`TallyCutoverPlan` gains a `documents` array and a count per kind. The preview
payload (`apps/pharmacy/lib/tally/preview.ts`) gains a sibling of the voucher
table:

| Column | Source |
|---|---|
| Date | `voucher_date` |
| Type | `voucher_type` as printed, with the normalised kind beside it |
| Number | `voucher_number` |
| Party | `party_name` |
| Lines | count of `document_lines` |
| Value | `total_amount`, or "—" |
| Status | cancelled / pre-conversion / linked |

The review screen must state, in the same place the operator is deciding,
which mode they selected and what it means: with documents archived and no
vouchers posted, history is readable but does not affect balances.

---

## 8. Apply

A new stage in `TALLY_STAGE_ORDER`, after `journals` and before `complete`:

```
accounts → parties → products → opening-journal → opening-stock → journals → documents → complete
```

It is resumable on the same offset/chunk discipline as `journals`, writes only
the three tables above, and is idempotent on
`unique (tenant_id, company_key, source_key)`. Its checkpoint lives in
`pharmacy_tally_document_imports`, not in the cut-over session's progress blob,
so a document pass and a cut-over apply cannot corrupt each other's offsets.

The one-shot problem: `CUTOVER_ALREADY_COMPLETE` blocks every import route once
a tenant is cut over, and a tenant cannot be re-imported. A tenant already
migrated on today's build therefore can never receive the archive — unless the
document pass is allowed to run under its own lock, after the cut-over.

The proposal is a separate pass with its own guard:

- it refuses unless the tenant already has a completed cut-over session, or is
  running as part of the same apply;
- it is append-only and idempotent, so a second run over a wider period adds
  documents and deletes none;
- it never touches the ledger, stock or any operational table.

This is the only way to give an already-migrated tenant the chain, and it is
also a new write surface on a completed tenant. It needs its own review, not a
reuse of the cut-over lock.

---

## 9. What the archive must never do

1. Change a product, batch, quantity or ledger balance. The acceptance test for
   this is a before/after comparison of every affected table, not a code review.
2. Create a product, customer or supplier.
3. Feed any Synapse workflow: no order can be received, no note can be posted,
   no document can be edited or deleted through the application.
4. Rewrite Tally's text. Names, numbers, narrations and units are stored as
   exported. Where a value is unusable, the row is skipped with an exception —
   it is not corrected.
5. Carry clinical data. Tally has none; nothing in this design creates a
   prescription, diagnosis or dosage.

---

## 10. Exceptions

The existing exception mechanism carries over with document-specific codes. The
rule is unchanged: a document that cannot be stored faithfully is reported,
never forced.

| Code | Meaning |
|---|---|
| `DOCUMENT_TYPE_UNSUPPORTED` | A voucher type neither posted nor archived |
| `DOCUMENT_NO_LINES` | A note or order with no inventory lines in the export |
| `DOCUMENT_ID_DUPLICATE` | Two documents share an identity |
| `DOCUMENT_BEFORE_PERIOD` | Outside the reviewed range |
| `DOCUMENT_MULTI_CURRENCY` | Carries a currency the company does not trade in |
| `DOCUMENT_FIELD_MISSING` | A field the chain needs (reference, party) is absent |

Unreadable quantities and amounts keep the existing `QUANTITY_UNREADABLE` and
`AMOUNT_UNREADABLE` warnings rather than inventing a zero.

---

## 11. Linkage — what can and cannot be rebuilt

If Q2 shows Tally exports reference fields, the archive stores them verbatim in
`linked_*`, and the reader can show "this delivery note belongs to that order".

If it does not, no link can be honestly reconstructed. Date and party ordering
is a plausible guess, not a chain, and the design must not present one document
as the child of another on that basis. In that case the archive is a complete
*list* of documents in date order — still an improvement over nothing, and not
what the client asked for. That gap has to be stated to them before the work
starts, not discovered after.

Order status (partially delivered, closed) is likewise not reconstructible from
a document list; it is derived, not stored.

---

## 12. Acceptance criteria

Added to `TALLY_MIGRATION_ACCEPTANCE_CRITERIA.md` when this is accepted:

| # | Criterion |
|---|---|
| D1 | The stored document count equals Tally's own count per type for the period, or the difference is disclosed as unverified with a reason |
| D2 | Applying the document stage changes no product, batch, opening balance, journal or transaction row — compared before and after |
| D3 | For a sample of at least ten documents per type, lines, quantities, rates and batches match the printed Tally document |
| D4 | Cancelled vouchers appear as cancelled rather than disappearing |
| D5 | Running the pass twice adds nothing and deletes nothing |
| D6 | A document with no Tally identifier receives a stable content key and an exception, and does not duplicate on re-run |
| D7 | No application route accepts a document id for editing, deleting, posting or receiving |
| D8 | A second tenant cannot read the first tenant's documents, proven with two signed-in identities |

D2 and D5 are the two that matter most; both are executable and both can fail
loudly.

---

## 13. The Windows probe

One session on a copy of the client's company, never the live company, never a
write.

1. Copy the Tally company to a folder on the client PC and open the copy.
2. Pick a period containing at least one order, one delivery note, one receipt
   note, one rejection, one stock journal and one physical stock entry.
3. Run the bridge's `All Masters` and `Day Book` export for that period through
   the existing read-only path.
4. Record, without pasting XML or ledger values: whether each document type
   appears at all; which of the linkage fields from §3 Q2 are present on one
   example of each; Tally's own per-type count for the period.
5. Record the answers in §19 of
   [TALLY_WINDOWS_TEST_EVIDENCE_TEMPLATE.md](./TALLY_WINDOWS_TEST_EVIDENCE_TEMPLATE.md),
   which holds the per-type presence table, the field matrix and the conclusion
   form.

The probe should also capture one per-type register exported to XML by hand —
the Sales Order register, say. The upload path accepts a file an operator
exports, and the parser looks for `<VOUCHER>` nodes rather than a report name,
so part of the gap may close without touching the connector. That is a thing to
test, not a thing this design asserts.

If Q1 comes back "orders are not in the Day Book", the answer is not a workaround
in this design. It is a connector change — additional reports or a TDL
collection per voucher type — with its own acceptance on both TallyPrime and
ERP 9, and it should be priced before the client is told the chain is coming.

---

## 14. Work breakdown and sequencing

In order; each blocks the next.

1. **Probe** (§13). No code.
2. **Parser fields** for the linkage Q2 confirms, with fixtures.
3. **Schema, RLS and isolation tests** for the three tables.
4. **Normalise** the documents into the plan, with counts and exceptions.
5. **Preview and review** surface, including the mode statement.
6. **Apply stage**, resumable and idempotent.
7. **Reader** — search by date, type, number, party; document detail with lines
   and batches.
8. **Acceptance run** (§12), then the Windows evidence in §13 re-run against the
   real company.

Out of scope for this design: writing anything back to Tally; attachments and
scanned copies; cost-centre allocations, budgets and payroll; converting
archived documents into live Synapse workflows; synchronisation of any kind.

---

## 15. What this design cannot tell you

- Whether the documents are in the export at all — that is §13.
- Whether linkage fields survive Tally's XML — also §13.
- Whether the client accepts a list of documents without links, if Q2 comes
  back empty.
- Whether the archive is worth its cost for a company whose order history is
  short and whose invoice history is what it actually uses.
- Whether an already-cut-over tenant should be reopened for a document pass.
  §8 proposes the mechanism; the decision is the owner's.
