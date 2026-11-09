# SADIO PHARMACY — data required to complete the Tally migration

Date: 2026-11-09. This sheet lists exactly what the import is missing and how to
produce it. Nothing in SYNAPSE needs to change for these items: each one is
refused by name today, and supplying the data turns the refusal off.

## What was already received and checked

- `SADIO_TALLY_FULL_OCT2025_OCT2026_20261106-215050.zip`
  (SHA-256 `0ece85f2a4d8b81ef280330e175a5d85561377b8cf0a164a5318478f71675a34`),
  13 monthly XML files, company **SADIO PHARMACY**, October 2025 – October 2026.
- 26,064 vouchers and 46,727 stock lines parsed. File count, voucher count and
  manifest totals reconcile with zero discrepancies. Nothing is lost or
  approximated on our side.

## What the export does not carry, and what to send

| # | Missing | Count observed | What to supply |
|---|---|---|---|
| 1 | Masters — ledgers, groups, stock items, units, godowns | 0 | A masters export for the same company and period. Without it, apply stops at `TALLY_MASTERS_MISSING` and no sales line can be matched to a product |
| 2 | Batch expiry on inbound stock | 0 of 46,727 allocations carry `EXPIRYDATE` | Optional. Re-export the vouchers with batch-wise details **on** so every inward stock line carries an expiry date; without it the 4,529 receipts import with batch names and no date once the operator accepts that mode |
| 3 | Closing figures at the cutoff | all 1,867 reconciliation rows `not-available` | Tally's own closing stock quantity and value per item (and per batch where held), ledger closing balances, party balances, and the sales, purchase and VAT register totals for the period |
| 4 | Quantity on five stock lines | 5 lines state no quantity | Correct the vouchers at source and re-export, or confirm the voucher numbers so they can be recorded as an accepted exception |

### 1. Masters

In Tally: *Gateway of Tally → Display More Reports → Masters*, or the masters
export the bridge requests at the start of a run. Export ledgers, groups, stock
items, units and godowns. The masters must come from the same company as the
vouchers, not a renamed copy.

### 2. Batch expiry (preferred, not essential)

This one is optional: if enabling it is not possible, say so and we will import
the stock with Tally's batch names and no expiry. That stock cannot then be
expiry-tracked, allocated by expiry or recalled by batch expiry; stock received
after the cut-over is unaffected, and nothing else about the migration changes.

Before exporting, enable on every stock item: **Maintain batch-wise details**
and **Use expiry dates for batches**. Then re-export the vouchers (the same
thirteen months is fine). Each inward line should read, in XML terms,
`BATCHALLOCATIONS.LIST → BATCHNAME` plus a non-empty `EXPIRYDATE`. The export
script (`tally-export-history.ps1`) now counts batch lines against lines that
carry an expiry and prints both numbers at the end of a run — please include
that output with the delivery.

If the expiry of some historic batches genuinely is not held in Tally, say so
and send the opening and closing batch lists (batch name, expiry, quantity,
rate) in the StockBatches sheet instead. They will be recorded as supplied,
never guessed.

### 3. Closing figures

Give the cutoff date precisely. Then send, as Tally prints or exports them:

- **Stock Summary** at the cutoff, showing closing quantity and closing value
  per stock item (and per batch if Tally holds it);
- **Trial Balance / Group Summary** at the cutoff, showing every ledger's
  closing balance;
- **Party balances** — receivables and payables, per party;
- **Sales Register**, **Purchase Register** and **VAT summary** totals for the
  migrated period.

The closing stock and ledger balances must also be present in the **XML
masters export** — those machine-readable figures are what the import compares
its replayed position against (AC-10). The printed reports are what the
accountant uses to tie the same numbers out (AC-3). A figure the export does not
carry is recorded as `not-available` and blocks completion; it is never treated
as a pass.

### 4. Quantity-less lines

The preview reports these as `QUANTITY_UNREADABLE`, attached to the voucher,
date and file each came from. Either correct them in Tally and re-export, or
accept them in writing as excluded.

## Preconditions to confirm with the delivery

- A Tally company backup taken **before** extraction, stored somewhere other
  than the pharmacy's computer (file name, host, date).
- The period being migrated, in writing, and the company name as Tally holds
  it.
- Cut-over enabled for this one tenant only.
- No accounting writes were made to Tally during extraction.

## What happens when the data arrives

Upload the new ZIP through the portal (or run the bridge on the Windows PC).
The preview must show **zero blocking exceptions** and manifest coverage
`verified`. If anything remains, the preview names it by file, voucher, date and
field — send that list back and it becomes the next round of this sheet.
