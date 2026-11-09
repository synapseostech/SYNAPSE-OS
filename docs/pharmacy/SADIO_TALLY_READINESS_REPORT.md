# SADIO PHARMACY — archive readiness and reconciliation report

Read-only assessment of the customer's export, measured 2026-11-09 against the
implementation on `feat/sadio-tally-migration`. No archive file was modified.
No database was written. No production import, merge or deployment was
performed.

**Verdict: the archive is accepted and fully accounted for; importing it as
delivered is NO-GO.** Two source-side gaps stop an apply — no masters and no
closing figures — and five quantity-less stock lines block separately. The
absent batch expiry, also a property of the export, no longer blocks: the
operator may accept it explicitly, and the import then keeps Tally's batch names
with no date. Nothing was silently dropped: every voucher and every stock line
lands in exactly one accounted outcome, listed below.

## 1. Archive identity

| | |
|---|---|
| File | `SADIO_TALLY_FULL_OCT2025_OCT2026_20261106-215050.zip` |
| SHA-256 | `0ece85f2a4d8b81ef280330e175a5d85561377b8cf0a164a5318478f71675a34` |
| Compressed / uncompressed | 5,246,978 / 237,445,945 bytes |
| Company | SADIO PHARMACY, read from `EXPORT_SUMMARY.txt` |
| Documents | 13 monthly exports + manifest + summary |
| Voucher dates | 2025-10-17 to 2026-10-31 |
| Effective dates | 2025-07-01 to 2026-10-31 (wider than the posting period) |

## 2. Integrity and reconciliation

| Check | Result |
|---|---|
| Archive status | `verified` |
| Manifest vouchers vs parsed vouchers | 26,064 = 26,064 |
| Manifest files vs export files | 13 = 13 |
| Missing declared files | 0 |
| Undeclared files | 0 |
| Ignored entries | 0 |
| Whole-archive parse failures | 0 |
| Per-file discrepancies | 0 in all 13 files |
| Control characters stripped | 285,850 (counted, not silent) |
| Duplicate voucher GUIDs | 0 |

Every manifest row also declares `SUCCESS`, and each row's voucher count, first
date and last date match the file it names. The reader is an independent
counter: it does not trust the manifest, it compares against it.

## 3. Per-file coverage

| File | Bytes | Vouchers | Inventory lines | Batch allocs | First date | Last date | Control chars |
|---|---:|---:|---:|---:|---|---|---:|
| 2025-10-full.xml | 4,469,022 | 508 | 908 | 908 | 2025-10-17 | 2025-10-31 | 5,549 |
| 2025-11-full.xml | 15,366,098 | 1,660 | 3,207 | 3,207 | 2025-11-01 | 2025-11-30 | 19,119 |
| 2025-12-full.xml | 15,212,620 | 1,634 | 3,052 | 3,052 | 2025-12-01 | 2025-12-31 | 18,466 |
| 2026-01-full.xml | 17,768,107 | 1,903 | 3,790 | 3,790 | 2026-01-01 | 2026-01-31 | 21,923 |
| 2026-02-full.xml | 15,735,092 | 1,678 | 3,297 | 3,297 | 2026-02-01 | 2026-02-28 | 19,312 |
| 2026-03-full.xml | 19,460,116 | 2,176 | 3,728 | 3,728 | 2026-03-01 | 2026-03-31 | 23,240 |
| 2026-04-full.xml | 21,103,630 | 2,289 | 4,108 | 4,108 | 2026-04-01 | 2026-04-30 | 25,185 |
| 2026-05-full.xml | 19,957,400 | 2,192 | 3,840 | 3,840 | 2026-05-01 | 2026-05-31 | 23,814 |
| 2026-06-full.xml | 22,594,260 | 2,483 | 4,408 | 4,408 | 2026-06-01 | 2026-06-30 | 27,162 |
| 2026-07-full.xml | 23,244,454 | 2,513 | 4,594 | 4,594 | 2026-07-01 | 2026-07-31 | 27,922 |
| 2026-08-full.xml | 21,145,419 | 2,367 | 3,992 | 3,992 | 2026-08-01 | 2026-08-31 | 25,120 |
| 2026-09-full.xml | 19,956,644 | 2,281 | 3,642 | 3,642 | 2026-09-01 | 2026-09-30 | 23,437 |
| 2026-10-full.xml | 21,431,364 | 2,380 | 4,161 | 4,161 | 2026-10-01 | 2026-10-31 | 25,601 |
| **Total** | **237,445,945** | **26,064** | **46,727** | **46,727** | | | **285,850** |

## 4. Voucher inventory

Raw voucher types, and what the plan produces from each:

| Tally `VCHTYPE` | Vouchers | Inventory lines | Plan outcome |
|---|---:|---:|---|
| Cash Sale | 24,286 | 40,545 | Sales mirrors; stock out |
| Credit Sale | 2 | 2 | Sales mirrors; stock out |
| Purchase | 1,320 | 4,530 | Purchase mirrors; stock in |
| Physical Stock | 454 | 1,647 | Stock adjustment (SET) |
| Payment | 1 | 2 | Stock adjustment, disclosed as non-trade |
| Stock Journal | 1 | 1 | Stock in |
| **Total** | **26,064** | **46,727** | |

Plan counts: 25,609 posted vouchers, 0 skipped, 24,288 sales, 1,319 purchases,
0 opening lines. The one-voucher differences are explained below; nothing is
unaccounted for.

Ledger side: 26,930 voucher-level ledger lines across 28 ledger names, giving 31
plan accounts — 1 cash, 3 sales, 27 expense. There are no parties, because the
export carries no party masters. All 27 supplier ledgers are inferred from the
debit side of purchases (`PARTY_INFERRED`, 1,319) and classified as expense
because there is no master to say they are sundry creditors.

Stock side: 1,837 distinct item names, 46,727 batch allocations, exactly one per
inventory line. 46,723 allocations are named `Primary Batch`, 4 are named
`524039`; **none of the 46,727 carries an expiry date**. The only godown is
`Main Location`.

**Batch names are not identities in this export.** `Primary Batch` is Tally's
default label, reused across items and across receipts that — once real
expiries are supplied — will not share one expiry. `pharmacy_product_batches`
is unique on `(product_id, batch_number)`, and that constraint is not weakened.
The replay policy is therefore explicit and disclosed, never silent:

- the **earliest receipt** under a reused name keeps Tally's name and expiry;
- every **later receipt** with a different expiry is stored under a
  deterministic key `TALLY-RPL-<16 hex>` derived from its movement id and
  expiry, marked `allocation: "synthetic"`;
- a **sale that names only the shared name and no expiry** cannot say which
  expiry left the shelf, so it is allocated first-expiry-first-out across the
  real batches (`allocation: "fefo"`), earliest expiry first;
- one aggregate warning, `REPLAY_BATCH_IDENTITY_RECONSTRUCTED`, states how many
  names collided, how many receipts were displaced and how many sales were
  allocated by FEFO. Per-record disclosure sits on each movement's `allocation`
  and batch number.

The archive cannot trigger this today because it has no expiries at all; a
re-export with expiries will. `apps/pharmacy/lib/tally/full-history-fixture.ts`
is the synthetic export that exercises it end to end.

## 5. Where every stock line goes

| Outcome | Lines | Detail |
|---|---:|---|
| `sale_out` movements | 40,547 | 40,545 Cash Sale + 2 Credit Sale |
| `physical_adjust` movements | 1,646 | 259 are zero-quantity SETs, recorded as zero deltas |
| Blocked: no expiry | 4,529 | 4,526 purchase + 2 payment + 1 stock journal |
| Blocked: no quantity | 5 | 4 purchase + 1 physical stock |
| **Total** | **46,727** | Equals the archive reader's count exactly |

The arithmetic closes: 40,547 + 1,646 + 4,529 + 5 = 46,727. Movement count after
consolidation is 42,193 events ordered `date-then-export-order`.

Under the operator-accepted `batchExpiry: "not-supplied"` policy the 4,529
"blocked: no expiry" lines become `purchase_in` / inbound `physical_adjust` /
`stock_journal_in` movements carrying Tally's batch name and no date. Only the five quantity-less
lines remain blocked, and the movement total rises to 46,722
(`sale_out` 40,547 + `physical_adjust` 1,646 + receipts 4,529).

Signed quantities: `sale_out` −268,755 units, `physical_adjust` +62,321 units
before SET resolution.

The five quantity-less lines, named so the operator can fix them at source:

| Voucher | Date | Line | Item | Line value |
|---|---|---|---:|---:|
| Purchase 74 | 2025-11-04 | 2 | Swazi Tab 500mg (Azithromycin) | 20,000 |
| Purchase 122 | 2025-11-16 | 0 | Savlon 200mls | 10,500 |
| Purchase 351 | 2026-01-25 | 5 | A.Plaster 2 | 8,000 |
| Purchase 351 | 2026-01-25 | 6 | Normal Saline Infusion | 17,000 |
| Physical Stock 123 | 2026-02-13 | 19 | Furosimide Uk 40mg | 276 |

Purchase 122 has no other usable stock line, which is why 1,320 purchase
vouchers produce 1,319 purchase mirrors. Its ledger journal is still present;
only the stock mirror is missing, and `STOCK_LINE_WITHOUT_QUANTITY` names it.

## 6. Findings

6.1 and 6.3 stop apply; both are properties of the delivered export. 6.2 no
longer stops apply when the operator explicitly accepts the absent expiry; the
default remains blocking.

### 6.1 No masters — `TALLY_MASTERS_MISSING`

The package contains 0 ledgers, 0 groups and 0 stock items. Masters are not
inferred from vouchers and then treated as real; the manifest problem is
recorded and the preflight extraction check is blocking, so apply cannot start.
Consequences if the block were removed by force:

- `LEDGER_INFERRED` on 30 ledgers and `LEDGER_MISSING` on `Cash` (1).
- 0 parties, so every payment and receipt points at an account, not a party.
- Every one of the 40,547 sale stock lines would fail product resolution as
  `PRODUCT_MISSING` at apply. This is a code-path conclusion from
  `apply.ts`, not an executed run.

### 6.2 No batch expiry — `REPLAY_MOVEMENT_EXPIRY_MISSING` (4,529) by default

Every inbound movement is refused by default because Synapse's batch table
requires an expiry. Split: 4,526 purchase, 2 payment, 1 stock journal.
`EXPIRYPERIOD` and `MFDON` are also absent, so there is no fallback. The
operator can turn this block off by stating that the export carries no expiry
(see the measured alternative below); the source gap is then disclosed, not
hidden.

This blocks the migration downstream as well: with no receipts replayed, the
40,547 sales run against no stock. The default simulation reports 34,803
blocking `REPLAY_NEGATIVE_STOCK` findings and 1,332
`REPLAY_UNKNOWN_BATCH_FOR_OUT` warnings (sales naming `Primary Batch`, which was
never received). Those numbers are the honest consequence of the missing
expiry, not a second defect.

**Measured alternative.** With the operator's explicit
`batchExpiry: "not-supplied"` choice, re-running this archive captures all
46,722 movements (4,529 receipts among them, each keeping Tally's batch name and
no expiry) and raises one aggregate warning instead of 4,529 exceptions.
Negative-stock findings fall to 6,087 and unknown-batch warnings to 826, but
reconciliation is still 0 match and 1,867 `not-available`: the opening stock
Tally holds in its masters is not in this export, so early sales still run
against nothing. Accepting the absent expiry is therefore necessary for a
batchless import but not sufficient on its own.

### 6.3 No closing figures — reconciliation cannot pass

The export carries no opening or closing ledger balances and no opening or
closing stock values. All 1,867 reconciliation rows are `not-available`, so
closing parity with Tally cannot be demonstrated. A `not-available` row is never
counted as a pass.

### 6.4 Secondary findings

| Finding | Count | Effect |
|---|---:|---|
| `STOCK_LINE_WITHOUT_QUANTITY` | 3 vouchers / 4 lines | Those lines are not replayed; the vouchers' other lines are |
| `REPLAY_MOVEMENT_WITHOUT_QUANTITY` | 5 | Blocking per movement |
| `REPLAY_INVENTORY_ON_NON_TRADE_VOUCHER` | 1 | Payment voucher with 2 stock lines recorded as adjustments, not assumed to be a purchase |
| `COST_UNKNOWN` | 1 | Sales vouchers state no cost of sale, so the replay derives it from the batches each line removed at their purchase rates. The warning names that policy; a line the replay cannot cost (part of it had no stock to come from) keeps the product's recorded cost and is not given a partial figure |
| Credit Sale vouchers with a `Cash` debit | 2 | Mirrored as cash sales because the ledger, not the type label, evidences the receipt |
| `EFFECTIVEDATE` ≠ `DATE` | 814 | Disclosed; the Day Book date is the posting date |

## 7. Exception inventory (exact per-code counts)

Measured from the full replay normalisation of all 13 files:

Default expiry policy (`batchExpiry: "source"`):

```json
{
  "ENTERED_BY_NOT_MAPPED": 1,
  "COST_CENTRE_NOT_MAPPED": 1,
  "LEDGER_MISSING": 1,
  "LEDGER_INFERRED": 30,
  "REPLAY_MOVEMENT_EXPIRY_MISSING": 4529,
  "REPLAY_INVENTORY_ON_NON_TRADE_VOUCHER": 1,
  "REPLAY_MOVEMENT_WITHOUT_QUANTITY": 5,
  "COST_UNKNOWN": 1,
  "PARTY_INFERRED": 1319,
  "STOCK_LINE_WITHOUT_QUANTITY": 3
}
```

Operator-accepted absence (`batchExpiry: "not-supplied"`):

```json
{
  "ENTERED_BY_NOT_MAPPED": 1,
  "COST_CENTRE_NOT_MAPPED": 1,
  "LEDGER_MISSING": 1,
  "LEDGER_INFERRED": 30,
  "REPLAY_INVENTORY_ON_NON_TRADE_VOUCHER": 1,
  "REPLAY_MOVEMENT_WITHOUT_QUANTITY": 5,
  "REPLAY_BATCH_EXPIRY_NOT_SUPPLIED": 1,
  "COST_UNKNOWN": 1,
  "PARTY_INFERRED": 1319,
  "STOCK_LINE_WITHOUT_QUANTITY": 3
}
```

`ENTERED_BY_NOT_MAPPED`, `COST_CENTRE_NOT_MAPPED` and
`REPLAY_BATCH_EXPIRY_NOT_SUPPLIED` are aggregate disclosures recorded once with
the true population in their message (26,064 vouchers name a Tally user; 18,006
carry a cost centre; 4,529 receipts across 1,387 products carry no expiry), so
the per-record exception cap cannot hide them. `EXCEPTION_LIMIT_REACHED`
accompanies the capped list because 1,319 `PARTY_INFERRED` findings exceed the
500-entry listing limit; the counts above remain exact.

## 8. Data the package cannot provide

No import rule can recover these from this archive; they must be supplied or
accepted as unavailable:

- Ledger, group and stock-item masters: names, product codes, units, MRP,
  opening batches.
- Batch expiry and manufacturing dates for all 46,727 allocations. The batch
  names are present ("Primary Batch" and similar) and are imported as they
  stand; what the archive does not carry is the expiry, and the operator may
  accept that absence explicitly (see §6.2).
- Tally's opening and closing ledger balances and stock values.
- Customer identity: every sale names `Cash`; there are no debtor ledgers.
- Tax ledgers and VAT amounts.
- Historical cost of goods sold as a field on sales vouchers. The replay
  derives it from the purchase rates of the batches each sale line removed;
  a line it cannot fully cost is disclosed rather than estimated.
- A stock-location dimension beyond `Main Location`.
- Tally user attribution (26,064 vouchers) and cost centres (18,006 vouchers;
  30,196 allocations), which have no Synapse dimension.

## 9. What is required before a real import

1. **Re-export with masters.** Include ledger groups, ledgers, stock items with
   units, and parties. Without masters, supplier ledgers stay classified as
   expense and every sale line fails product matching. `tally-export-history.ps1`
   already asks Tally for these records, so one run of the script produces the
   masters file and the monthly vouchers together.
2. **Supply batch expiry, or accept its absence.** Re-exporting with
   batch/expiry enabled lets the 4,529 receipts be expiry-tracked; the
   StockBatches sheet can only fill opening and closing stock, not voucher
   movements. If the expiry genuinely is not held in Tally, the operator can
   instead record `batchExpiry: "not-supplied"` at review: the receipts are then
   imported with Tally's batch names and no expiry, one non-blocking warning
   states the counts and consequences, and no date is invented. The script
   reports the coverage it measured and no longer treats an absence as a
   failure of the run.
3. **Provide or accept the absence of closing figures.** To prove parity, the
   export needs Tally's closing balances and closing stock at the cutoff. The
   script's masters file asks for `OPENINGBALANCE`/`CLOSINGBALANCE` on every
   ledger and opening/closing quantity and value on every stock item; the
   accountant's Trial Balance and Stock Summary confirm those totals
   independently.
4. **Confirm the period and cutoff** and confirm the two Credit Sale vouchers
   are cash sales, as their ledgers indicate.
5. **Correct the five quantity-less lines at source** or confirm they are to be
   treated as unavailable.

## 10. Rollback and isolation

- The import writes only to the tenant that owns the session; every new table
  has RLS and the source rows are immutable by trigger.
- Rollback is designed as compensating entries through the same movement
  primitive, not deletion, and is refused when later operational activity
  exists.
- **Rollback has been executed and proven on a disposable database.**
  `scripts/db-tests/run-pharmacy-db-harness.sh` starts a throwaway Supabase
  stack on native PostgreSQL 15.19 (its own ports, its own project id), applies
  the prepared migrations and runs `scripts/db-tests/tally-replay.local.test.mjs`.
  All 13 tests pass, including: apply, idempotent re-run, negative-stock
  refusal, compensating rollback to zero, re-apply in a fresh session, a sale
  from imported stock with no Tally connection (AC-9, database half), rollback
  refused once post-cut-over trading exists, and a receipt with no expiry stored
  far-future while provenance keeps the true absence. Nothing was applied to a
  shared, staging, production or customer database.
- **Portal half executed too.** `scripts/db-tests/run-pharmacy-portal-harness.sh`
  drives the real portal against its own disposable stack: sign-in, upload,
  review, apply, the migrated period's report on screen, then a purchase, a
  sale, a refund and a manual adjustment with no Tally connection. 14/14
  subtests pass (`journey: PASS`).
- **Not proven:** a full replay of the customer archive against a database. Its
  own missing masters and closing figures block it at preflight; accepting the
  absent expiry removes the expiry block but not those two. The synthetic
  full-history fixture covers the replay path instead, and
  `bridge-export-replay.test.ts` covers the shape the re-export will take:
  masters with closing balances plus monthly day books, staged through the
  portal's own sequence and replayed to Tally's closing position with every
  reconciliation row `match`. It also pins the cut-off rule — the last day
  book's end, never the masters file's stated period end.

## 11. Verification status

| Check | Result |
|---|---|
| Read-only archive ingestion of all 13 files | Executed, `verified` |
| Manifest reconciliation 26,064 / 26,064 | Executed |
| Replay normalisation of the archive | Executed |
| Real-archive regression suite (`SADIO_TALLY_ARCHIVE=… vitest`) | Executed — 4/4 pass, including the no-expiry import |
| `packages/db` tally suite, including new ZIP bounds tests | Executed — 133/133 pass |
| Pharmacy tally suite | Executed — 600 pass, 4 skipped (archive suite skips without the env var) |
| `npm run test:tally` (CI gate) | Executed — 133 pass, 1 skipped, 0 fail |
| Pharmacy type-check | Executed — pass |
| Pharmacy and `packages/db` lint | Executed — pass, 0 warnings |
| `npm run db:check` | Executed — 217 migration files OK |
| Apply against a disposable database | Executed — 48 migrations, ACL assertion passed, PostgreSQL 15.19 native |
| Rollback against a disposable database | Executed — compensating movements, stock returned to zero |
| AC-9 disconnect test, database half | Executed — 13/13 harness tests |
| AC-9 disconnect test, portal half | Executed — 14/14 journey subtests, `journey: PASS` |
| Export-time batch/expiry coverage check (`tally-export-history.ps1`) | Not executed — no PowerShell host on this machine; runs on the pharmacy's Windows computer. The check now reports missing expiry as information rather than failing the run, matching the accepted `not-supplied` mode |
| Real SADIO import | Not performed, by instruction |

## 12. Go / no-go

| Decision | Verdict |
|---|---|
| Accept and stage this ZIP | **GO** — bounded, reconciled, every line accounted for |
| Let the operator review the archive in the portal | **GO** — blockers and disclosures are visible |
| Apply this package to a live pharmacy | **NO-GO** — no masters and no closing parity. Absent expiry is an accepted operating limitation, not a blocker, when the operator turns it on |
| Roll back after an apply | **Proven on the disposable stack**; not run on customer or production data |
| Production import / merge / deploy | Not attempted |
