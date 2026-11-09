# SADIO PHARMACY — Tally source field coverage matrix

This matrix records what the customer's own package carries and what the
importer does with each field. It is evidence, not a target design: every row
was measured from the archive below on 2026-11-09, read-only.

| | |
|---|---|
| Archive | `SADIO_TALLY_FULL_OCT2025_OCT2026_20261106-215050.zip` |
| SHA-256 | `0ece85f2a4d8b81ef280330e175a5d85561377b8cf0a164a5318478f71675a34` |
| Size | 5,246,978 bytes compressed / 237,445,945 bytes uncompressed |
| Contents | 13 monthly XML exports, `EXPORT_MANIFEST.csv`, `EXPORT_SUMMARY.txt` |
| Company | SADIO PHARMACY (from `EXPORT_SUMMARY.txt`) |
| Period covered | 2025-10-17 to 2026-10-31 (first and last voucher dates) |

## Status vocabulary

| Status | Meaning |
|---|---|
| **Imported** | Read, carried in the staged plan, and written to its Synapse target. |
| **Derived** | Computed from source values under a stated rule, because the source states no such field. |
| **Defaulted** | Absent from the export; a documented fallback is used and disclosed. |
| **Recorded, unused** | Read and kept in the plan/source record, but no Synapse field consumes it yet. |
| **Not in export** | The tag occurs zero times in all 13 files. |
| **Disclosed, not mapped** | Real data the export carries that Synapse has no place for; a warning names the count. |
| **Refused** | Present but not importable; a blocking or warning code names it per record. |

"Imported" describes the staging pipeline. Apply can still refuse an individual
record for a reason listed in the readiness report.

## Package level

| Source | What this archive carries | Status | Synapse effect |
|---|---|---|---|
| Zip entries | 15 files: 13 exports, manifest, summary; no undeclared or ignored entries | Imported | Bounded, per-entry streaming (`tally-zip.ts`, `tally-archive.ts`) |
| `EXPORT_MANIFEST.csv` | 13 rows, status `SUCCESS`, 26,064 vouchers declared | Imported | Independent reconciliation gate |
| `EXPORT_SUMMARY.txt` | `Company: SADIO PHARMACY` | Imported | Company scope for staging and plan identity |
| `<HEADER><STATUS>` | `1` in every file | Imported | A status other than `1` refuses the file (`MIGRATION_XML_STATUS_FAILED`) |
| `<COMPANYNAME>` | 0 occurrences | Defaulted | Company is taken from the summary |
| `<SVFROMDATE>` / `<SVTODATE>` | 0 occurrences | Defaulted | Period is the one supplied with the upload; the export cannot contradict it |
| `<CURRENCYNAME>` | 0 occurrences | Defaulted | `UGX` (`options.currency ?? document.currency ?? "UGX"`) |
| `<LEDGER>` masters | 0 occurrences | Not in export | Accounts inferred from voucher lines; `TALLY_MASTERS_MISSING` blocks apply |
| `<GROUP>` masters | 0 occurrences | Not in export | Account roles inferred (cash, sales, expense) |
| `<STOCKITEM>` masters | 0 occurrences | Not in export | Product names from voucher lines only; no product codes, units or opening batches |
| `<UNIT>` / `<GODOWN>` masters | 0 occurrences | Not in export | No unit conversion; no warehouse dimension |
| Opening/closing ledger and stock summaries | 0 occurrences | Not in export | Reconciliation rows report `not-available` |
| Control characters inside XML text | 285,850 across the 13 files | Imported with count | Rewritten so the document is valid XML; the count is reported per file |
| `<TAXNAME>` / `<VATAMOUNT>` / `<VATEXPAMOUNT>` | 0 occurrences | Not in export | Tax is derived from VAT-role ledger lines, of which there are none |

## Voucher header

26,064 vouchers. Each tag below was counted across all 13 files.

| Tally tag | What this archive carries | Status | Synapse effect |
|---|---|---|---|
| `<GUID>` | 26,064 | Imported | Source identity and provenance (`sourceId = companyKey:guid`) |
| `<MASTERID>` | 26,064 | Imported | Used as `remoteId` when `REMOTEID` is absent |
| `<ALTERID>` | 26,064 | Not used | Tally's revision counter has no Synapse meaning |
| `VCHTYPE` attribute | Cash Sale 24,286; Purchase 1,320; Physical Stock 454; Credit Sale 2; Payment 1; Stock Journal 1 | Imported | Classified by `classifyTallyVoucherType` |
| `<VOUCHERNUMBER>` | Present | Imported | Transaction/purchase number; fallback is the last 8 characters of the source id |
| `<DATE>` | 26,064, from 2025-10-17 to 2026-10-31 | Imported | Voucher date, replay ordering key, period membership |
| `<EFFECTIVEDATE>` | 26,064; differs from `<DATE>` on 814 | Recorded, unused | The Day Book date is `<DATE>`; the 814 legal-date differences are disclosed here, not silently applied |
| `<NARRATION>` | Present on some vouchers and stock lines | Imported | Journal/description text (trimmed to 300/500 characters) |
| `<PARTYLEDGERNAME>` | All 26,064 occurrences are `Cash` | Imported | Sale party. Purchases state none, so the supplier is derived from the debit ledger |
| Purchase supplier ledger | 27 distinct names, 1,321 lines | Derived | `PARTY_INFERRED` on 1,319 purchase vouchers; with no masters they are classified as expense, not payable |
| `<ENTEREDBY>` | 26,064: `user` 10,885; `sam` 7,637; `uncle egidio` 4,661; `admin` 2,008; case variants make 7 spellings | Disclosed, not mapped | `ENTERED_BY_NOT_MAPPED` warning names the users; Synapse cannot map Tally user names to staff accounts |
| `<ISCOSTCENTRE>` / `<COSTCENTRENAME>` | `Yes` on 18,006 vouchers; 9 centres (Patience 5,178; Sharon 4,428; Apuuli 4,002; Ronald Araali 1,845; Recheal 884; Safari 819; Famous 807; Gloria 36; Mutegeki S 7) | Disclosed, not mapped | `COST_CENTRE_NOT_MAPPED` warning; Synapse has no cost-centre dimension |
| `<COSTCENTREALLOCATIONS.LIST>` | 30,196 allocation records | Recorded, unused | Allocation amounts are part of the cost-centre dimension above |
| `<ISCANCELLED>` | `No` on all 26,064 | Imported | A `Yes` voucher would be excluded with `VOUCHER_CANCELLED` |
| `<ISPOSTDATED>` | `No` on all 26,064 | Not in export (non-default) | No post-dated voucher needs special handling |
| `<ISOPTIONAL>` | `No` on all 26,064 | Not in export (non-default) | No optional voucher in this archive |
| `<ISDELETED>` | `No` on all 26,064 | Not in export (non-default) | No deleted voucher in this archive |
| `<DISCOUNT>` (inventory line) | 46,727 occurrences, all `0` | Not read | Sales discount is derived from `SALES_DISCOUNTS` ledger lines; there are none, so it is zero |
| Linkage tags (`REFERENCE`, `BASICORDERREF`, …) | Present on some vouchers, names recorded on the voucher | Recorded, unused | Order-to-invoice chaining is not part of this cut-over |
| Credit Sale vouchers | 2; both debit `Cash` and credit `SALES A/C` | Derived | Mirrored as cash sales because the ledger, not the type label, evidences the receipt |

## Ledger lines

| Tally element | What this archive carries | Status | Synapse effect |
|---|---|---|---|
| Voucher-level ledger lines | 26,930 lines across 28 names: `Cash` 25,609 plus 27 supplier names 1,321 | Imported | Journals, sale receipts and purchase postings |
| `<LEDGERNAME>` | 31 plan accounts: cash 1, sales 3, expense 27 | Imported | Missing masters produce `LEDGER_INFERRED` 30 and `LEDGER_MISSING` 1 (`Cash`) |
| `<ISDEEMEDPOSITIVE>` | Present | Imported | Determines debit/credit; the amount sign is the fallback |
| `<AMOUNT>` | Present on every line | Imported | Decimal arithmetic in minor units; voucher balance is enforced |
| `<BILLALLOCATIONS.LIST>` | Present on some party lines | Recorded, unused | Bill-wise settlement detail has no cut-over target |
| Sales revenue allocations | 40,547 across `SALES A/C` 40,450, `Shalom Pharmarcy` 61, `Shalom Pharmacy` 36 | Imported | Sale revenue; the two misspellings are separate accounts and are disclosed by inference |

## Inventory lines and batches

46,727 inventory lines, 1,837 distinct stock-item names, 46,727 batch
allocations (exactly one per line).

| Tally element | What this archive carries | Status | Synapse effect |
|---|---|---|---|
| `<STOCKITEMNAME>` | 1,837 distinct names | Imported | Matched to products; unmatched names are `PRODUCT_MISSING` at apply |
| `<ACTUALQTY>` | 46,723 readable; 4 purchase lines and 1 physical-stock line have no quantity | Imported / Refused | Immaterial values refused; 5 lines blocked (`REPLAY_MOVEMENT_WITHOUT_QUANTITY`, `STOCK_LINE_WITHOUT_QUANTITY` on 3 vouchers) |
| `<RATE>` | Present on every line | Imported | Selling rate on sales, cost rate on purchases. A replay derives each sale line's historical cost from the batches it removed at those purchase rates and writes it to the profit report; a line the replay cannot cost falls back to the product's recorded cost, disclosed by `COST_UNKNOWN` |
| `<AMOUNT>` | Present on every line | Imported | Line value; `amount` on movements and mirrors |
| `<ISDEEMEDPOSITIVE>` | Present per line | Imported | Movement direction, before the voucher-kind fallback |
| `<BATCHNAME>` | 46,723 `Primary Batch`; 4 `524039` | Imported | Not an identity: one name can carry more than one expiry. Earliest receipt keeps the name; later differing expiries get `TALLY-RPL-<hash>`; a sale naming only the shared name and no expiry allocates FEFO. Disclosed once as `REPLAY_BATCH_IDENTITY_RECONSTRUCTED` |
| `<EXPIRYDATE>` | 0 of 46,727 | Refused by default; imported when the operator states the export has none | Default: every stock receipt is blocked (`REPLAY_MOVEMENT_EXPIRY_MISSING`, 4,529 movements). With `batchExpiry: "not-supplied"` the receipts import with their batch names and no date; the batch row stores `9999-12-31` so FEFO treats it as usable, provenance keeps the absence, and one aggregate warning discloses it |
| `<MFDON>` | 0 occurrences | Not in export | No manufacturing date available |
| `<EXPIRYPERIOD>` | 0 occurrences | Not in export | No fallback expiry available |
| `<GODOWNNAME>` | `Main Location` only | Recorded, unused | One stock location; no warehouse dimension |
| `<UNIT>` / `<BASEUNITS>` on the line | Not carried on inventory lines | Not in export | Unit comes from stock-item masters, which are absent |
| `<MRPRATE>` | 0 occurrences | Not in export | No selling price separate from the transaction rate |
| `<ACCOUNTINGALLOCATIONS.LIST>` | Present on sale lines | Imported | Revenue allocation to `SALES A/C` |

## What the replay pipeline does with the lines

| Outcome | Lines | Detail |
|---|---|---|
| Sale movements | 40,547 | `sale_out`; 40,545 Cash Sale + 2 Credit Sale |
| Physical-stock adjustments | 1,646 | `physical_adjust`; 259 lines are legitimate zero counts that set an item to zero |
| Refused: no expiry | 4,529 | 4,526 purchase + 2 payment + 1 stock journal, all inbound. Imported as receipts under `batchExpiry: "not-supplied"`, leaving only the 5 quantity-less lines blocked |
| Refused: no quantity | 5 | 4 purchase + 1 physical stock |
| **Total** | **46,727** | Equals the archive reader's count exactly |

Net movement quantities: `sale_out` −268,755 units; `physical_adjust` +62,321
units. These are signed deltas before `physical_adjust` SET semantics are
resolved during simulation.

## Fields the archive does not carry

The following are absent from every document, so no import rule can recover
them from this package:

- Ledger, group and stock-item masters, including product codes, units, MRP and
  opening batch details.
- Batch expiry and manufacturing dates for all 46,727 allocations. Batch names
  are present and imported; the expiry may be accepted as absent.
- Tally's opening and closing ledger balances and opening/closing stock values.
- Customer identity: every sale names `Cash`; there are no debtor ledgers.
- Tax amounts and tax ledgers.
- Historical cost of goods sold as a field on sales vouchers. The replay
  derives it from the batches each sale removed and their purchase rates; it
  is not read from the sale document.
- A stock location dimension beyond `Main Location`.

## Fields carried but not representable in Synapse

- The Tally user who entered each voucher (all 26,064; 7 spellings).
- Cost centres and their allocation amounts (18,006 vouchers; 30,196
  allocations).
- The legal effective date where it differs from the posting date (814
  vouchers).
- Tally revision metadata (`ALTERID`) and order/linkage references.

Each of these is disclosed by an aggregate warning or recorded on the plan; none
is silently dropped.
