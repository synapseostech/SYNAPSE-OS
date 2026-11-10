# SADIO PHARMACY — Tally re-export brief

This is the operator-facing instruction for producing the export that Synapse can
actually migrate. It is written after a full read-only audit of
`SADIO_TALLY_FULL_OCT2025_OCT2026_20261106-215050.zip` (SHA-256
`0ece85f2a4d8b81ef280330e175a5d85561377b8cf0a164a5318478f71675a34`).

**Do not edit or repackage the original ZIP.** Produce a new export folder and
send that. The original stays as the audit reference.

## 1. Why another export is needed

The current package is complete on its own terms: all 13 monthly files parse,
26,064 of 26,064 manifest vouchers are present, and all 46,727 stock lines are
accounted for. Two properties of the export, not of the importer, block an
apply; a third is strongly preferred:

| # | Missing | Measured | Effect |
|---|---|---|---|
| 1 | Master records | 0 ledgers, 0 ledger groups, 0 stock items | Blocks: no product or account to match |
| 2 | Opening and closing figures | 0 opening balances, 0 closing balances, 0 closing stock | Blocks: parity cannot be proven |
| 3 | Batch expiry | 0 expiry dates on all 46,727 batch allocations | Optional: the operator may accept it, and the 4,529 receipts then import with Tally's batch names and no date |

Without masters there is nothing to match products or accounts to. Without
closing figures, the migration cannot prove its final position equals Tally's.
Without expiry, the import can still run, but that stock cannot be
expiry-tracked, allocated by expiry or recalled by batch expiry; stock received
after the cut-over is unaffected.

The importer will not guess around any of these. It records them as findings
and refuses to complete while a blocking one stands.

## 2. Change these Tally settings before exporting

On the pharmacy computer, with the SADIO PHARMACY company open:

1. **Maintain batch-wise details** — set to **Yes** for the stock items.
2. **Maintain expiry dates for batches** — set to **Yes**, if the pharmacy
   wants expiry-tracked stock. If Tally has never held expiry dates, leave it
   off and say so: the export is still importable in a disclosed no-expiry
   mode (see §4.2).
3. **Use batch-wise details in sales and purchases** — set to **Yes**.

In Tally.ERP 9 these live under the stock item / stock group configuration and
the company's inventory features (F11: Features → Inventory features). In
TallyPrime they are under F1 → Settings → Inventory, and per-item under the
stock item's batch details.

If batch-wise details were never maintained, **stop and say so**. Historical
batch consumption that Tally never recorded cannot be recovered by any export.
Synapse can reconstruct batches first-expiry-first-out with the reconstruction
disclosed, but it will not present that as Tally's own allocation. That is a
decision for the pharmacy owner, not something to be guessed at export time.

## 3. Export procedure

Use the Synapse export script on the same Windows computer as Tally:

```
apps/tally-bridge/scripts/tally-export-history.ps1
```

Run it by right-clicking and choosing **Run with PowerShell**, or:

```powershell
powershell -ExecutionPolicy Bypass -File .\tally-export-history.ps1 -Company "SADIO PHARMACY"
```

It writes one XML per calendar month plus **one masters file** into
`%USERPROFILE%\Desktop\SynapseTallyExport`. The masters file is the part the
current package lacks. It must contain records for:

- **Ledger groups** (`GROUP`) — the chart-of-accounts hierarchy.
- **Ledgers** (`LEDGER`) — including `Cash`, `Bank`, sales ledgers, purchase
  ledgers, expense ledgers, and **party ledgers** under Sundry Debtors and
  Sundry Creditors.
- **Stock items** (`STOCKITEM`) — at minimum `NAME`, `BASEUNITS`, `OPENINGRATE`,
  `OPENINGBALANCE`, `OPENINGVALUE`, and the batch/expiry flags.
- **Stock groups** (`STOCKGROUP`) if the pharmacy uses them.

The script asks for each master type separately because this Tally build answers
"All Masters" with an empty envelope. If the masters file is tiny or contains
only an empty `<ENVELOPE>`, the export did not work; send us the file and do not
proceed.

If the pharmacy uses the Synapse Tally bridge instead of the script, the same
result is produced by `POST /api/tally/export?scope=masters` followed by the
monthly `scope=vouchers` chunks. The bridge refuses a response that does not
name the pinned company, so a wrong-company export cannot be imported silently.

**The cut-over date.** The script starts at the company's own books beginning
and ends today, so it exports the whole history, not only the last twelve
months. `-To` sets the day the migration stops; leave it unset to use today, or
pass the date the pharmacy will start trading in Synapse:

```powershell
powershell -ExecutionPolicy Bypass -File .\tally-export-history.ps1 -Company "SADIO PHARMACY" -To 20261130
```

Every voucher file carries that date as its end, and the portal takes it as the
replay cut-off, so it needs no separate entry. The import only compares Tally's
closing figures when they belong to that same date: if Tally reports balances
for another period (typically its financial-year end), the preview blocks with
`REPLAY_PERIOD_MISMATCH` rather than accepting a figure for the wrong day. Set
Tally's current period to the cut-over date — or set `-To` to the date the
balances belong to — and export again. The script also sends that date to Tally
when it asks for the masters, so a build that honours it answers with the
balances as on the cut-off.

## 4. Required content, field by field

### 4.1 Masters

| Record | Required fields | Why |
|---|---|---|
| `LEDGER` | `NAME`, `PARENT`, `OPENINGBALANCE`, `CLOSINGBALANCE` (if exported) | account identity, classification, opening/closing parity |
| Party ledger | `NAME`, `PARENT` = Sundry Debtors/Creditors, `LEDGERPHONE`/`LEDGERCONTACT` if held | customer and supplier identity; today every sale names `Cash` |
| `STOCKITEM` | `NAME`, `BASEUNITS`, `OPENINGRATE`, `OPENINGBALANCE`, `OPENINGVALUE` | unit of measure, opening quantity and value |
| `STOCKITEM` batch flags | `ISBATCHWISEON`, `ISEXPIRYON` (or the build's equivalents) | proves expiry is maintained, not merely absent |
| `GROUP` | `NAME`, `PARENT` | account hierarchy and correct normal balance |

### 4.2 Vouchers

Every voucher the pharmacy posted from the beginning of its books through the
cutoff date, in monthly slices. The existing 13 files cover 2025-10-17 to
2026-10-31; the re-export should cover the **full books period**, not only the
period that was requested last time.

For every inventory line, the export must carry:

| Field | Tally element | Required |
|---|---|---|
| Item name | `STOCKITEMNAME` | yes |
| Actual quantity | `ACTUALQTY` | yes — see §5 for the five lines that are missing it |
| Billed quantity | `BILLEDQTY` | if different from actual |
| Rate | `RATE` | yes |
| Amount | `AMOUNT` | yes |
| Batch name | `BATCHALLOCATIONS.LIST/BATCHNAME` | yes on every inbound line |
| Batch expiry | `BATCHALLOCATIONS.LIST/EXPIRYDATE` | preferred on every inbound line; if genuinely not held, the operator may accept the absence at review |
| Manufacturing date | `MFDON` | if held |
| Godown | `GODOWNNAME` | if more than `Main Location` is used |
| Deemed positive | `ISDEEMEDPOSITIVE` | yes, so direction is stated rather than inferred |

The reader already handles both `INVENTORYENTRIES.LIST` and
`ALLINVENTORYENTRIES.LIST`, and the `INVENTORYENTRIESIN` / `INVENTORYENTRIESOUT`
forms used by stock journals and transfers.

### 4.3 Opening and closing position

The masters file asks Tally for each ledger's `OPENINGBALANCE` and
`CLOSINGBALANCE` and each stock item's opening and closing quantity and value,
so the export carries the figures the import reconciles against. They are
whatever Tally reports for the period the run exported; if they belong to a
different date than the file names, the import refuses to compare rather than
treating them as the cutoff's. The documents below are the independent check:
they let the pharmacy's accountant confirm that the totals the import reports
are Tally's own.

At the cutoff date, supply:

1. **Trial Balance** as on the cutoff (XML preferred; CSV or PDF accepted as
   evidence, XML for machine comparison).
2. **Stock Summary** as on the cutoff, item by item, with quantity and value.
3. **Batch-wise stock** (item, batch, expiry, quantity) at the cutoff, if the
   build can produce it.
4. **Party outstanding** (Sundry Debtors and Creditors) at the cutoff.

Without these, every reconciliation row the import cannot match to a document
stays `not-available`, which is never counted as a pass.

## 5. Corrections needed at source

These five stock lines have a value but no quantity. They cannot be replayed as
written, and Synapse will not invent a quantity:

| Voucher | Date | Line | Item | Line value |
|---|---|---|---:|---:|
| Purchase 74 | 2025-11-04 | 2 | Swazi Tab 500mg (Azithromycin) | 20,000 |
| Purchase 122 | 2025-11-16 | 0 | Savlon 200mls | 10,500 |
| Purchase 351 | 2026-01-25 | 5 | A.Plaster 2 | 8,000 |
| Purchase 351 | 2026-01-25 | 6 | Normal Saline Infusion | 17,000 |
| Physical Stock 123 | 2026-02-13 | 19 | Furosimide Uk 40mg | 276 |

Correct the quantity in Tally (by altering the voucher, or by a correcting
entry dated in the same period), then re-export. If the quantity genuinely
cannot be established, say so in writing; the line will be reported as
unavailable rather than guessed.

Also confirm the two **Credit Sale** vouchers. Both debit `Cash`, so the
importer mirrors them as cash sales: the ledger, not the voucher-type label, is
the evidence of receipt. If they were genuinely credit sales, the debtor ledger
must be present in the masters export so the receivable is recorded.

## 6. Batch identity — the one policy decision to confirm

Tally identifies a batch by name. Synapse stores one row per
`(product, batch number)` and records one expiry for it. If Tally holds two
different expiries under the same batch name (for example many receipts all
called `Primary Batch`), the two systems cannot represent that as one batch.

On receipt Synapse will:

- keep the first expiry under the Tally name;
- give each later collision a deterministic key derived from that receipt
  (clearly marked, never a Tally name it did not have);
- allocate sales that name a colliding batch first-expiry-first-out, and
  disclose every such line in the review.

It will **not** merge two expiries into one batch, and it will **not** silently
claim Tally allocated a sale to a particular batch when Tally's own records
cannot tell them apart.

If the pharmacy needs exact historical batch allocation, the only way to get it
is genuine unique batch names and expiry in Tally. Confirm which of these is
true:

- [ ] Tally holds unique batch names per received batch (exact replay).
- [ ] Tally holds generic names such as `Primary Batch` (reconstruction, disclosed).
- [ ] Tally holds no batch details at all (batch history is unrecoverable; decide
      whether item-level history with reconstructed batches is acceptable).

## 7. Pre-send checklist

Run these checks before uploading. Each one catches a failure that would
otherwise surface only after a long import:

- [ ] The export folder contains one masters file and one XML per month.
- [ ] The masters file contains `GROUP`, `LEDGER` and `STOCKITEM` records, and
      the stock item count matches the item count in Tally's Stock Summary.
- [ ] Every purchase line in the XML contains a non-empty `BATCHALLOCATIONS.LIST`
      with both `BATCHNAME` and `EXPIRYDATE`.
- [ ] `tally-export-history.ps1` printed `Batch allocations: N; with an expiry
      date: M`. If M is lower than N the run still succeeded: the portal asks
      you to confirm that the export genuinely carries no expiry before it will
      import those receipts. Turn expiry on in Tally and export again if you
      want that stock tracked.
- [ ] The five lines in §5 now carry a quantity, or their absence is confirmed.
- [ ] The month files together cover the full books period with no gap.
- [ ] The Trial Balance, Stock Summary and party outstanding at the cutoff are
      included.
- [ ] The files are in one ZIP. Do not rename, edit or repackage individual XML
      files after export.

## 8. What happens on receipt

1. Synapse re-reads the archive read-only and reconciles every file against the
   manifest.
2. It parses masters first, then every voucher and stock line.
3. It reports, before any write: item counts, batch/expiry coverage, opening and
   closing parity, negative-stock findings, every line it cannot replay, and the
   batch-identity policy that applies.
4. Apply stays blocked while any blocking difference remains. A warning the
   operator acknowledges is recorded with a reason and repeated in the audit
   entry; it is never silently cleared.
5. Rollback is compensating and is refused once post-cut-over trading exists.

Nothing in this process modifies the customer's Tally data. The export script
reads over loopback only and writes files to the Desktop.
