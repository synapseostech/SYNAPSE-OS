# Tally cut-over — dry-run report

The report that must be completed and signed off **before** anyone presses
Apply. Until Apply, nothing reaches the pharmacy ledger.

## What the dry run does and does not write

| Stage | Writes |
|---|---|
| Probe (`tally-probe.ps1`) | Nothing. Local files on the Tally computer only. |
| Upload | One `pharmacy_import_sessions` row and one source file in the `pharmacy-imports` bucket. No ledger data. |
| Preview | A normalised plan (JSON chunks) in the same bucket; the session moves to `review`. No ledger data. |
| Mapping / reconciling | Session metadata only. No ledger data. |
| **Apply** | Accounts, stock, sales, purchases and opening balances. **This is the only stage that touches the pharmacy ledger.** |

So the dry run is not write-free: it creates an import session and plan files.
It is ledger-free. Say so plainly in the sign-off.

---

## Part 1 — Inputs

| Field | Value |
|---|---|
| Tally edition and build | |
| Tally company name (exactly) | |
| Company pinned at bridge start (`SYNAPSE_TALLY_COMPANY`) | |
| Source route (bridge / XML upload / template) | |
| Cut-over mode (opening balances + history / closing balances only) | |
| Export period from – to | |
| `SYNAPSE_TALLY_TO_DATE` (closing balances are as at this date) | |
| Cut-over date entered on the page | |
| Probe report verdict (closing balances found? which tag?) | |
| Source file size | |

## Part 2 — Masters

Read from the review screen and the plan summary.

| Field | Expected | Actual |
|---|---|---|
| Ledgers read (`counts.ledgers`) | | |
| Groups (`counts.groups`) | | |
| Stock items (`counts.stockItems`) | | |
| Accounts mapped without an override | | |
| Accounts left unclassified | | |
| Parties recognised (debtors/creditors) | | |
| Unknown or duplicate accounts | | |

## Part 3 — Opening position

| Field | Value |
|---|---|
| Opening date | |
| Total debit | |
| Total credit | |
| Difference (must be 0) | |
| Opening lines (`counts.openingLines`) | |
| Ledgers with no closing balance (closing mode only) | |

## Part 4 — Stock

| Field | Value |
|---|---|
| Opening stock value (Tally) | |
| Closing stock value (Tally) | |
| Items with an opening value | |
| Items with a closing value | |
| Stock items posted | |
| Batches dropped for being dated at the period start | |

## Part 5 — Vouchers

| Field | Value |
|---|---|
| Vouchers in the export (`counts.vouchers`) | |
| Posted (`counts.postedVouchers`) | |
| Skipped (`counts.skippedVouchers`) | |
| Sales built (`counts.sales`) | |
| Purchases built (`counts.purchases`) | |
| Skipped by type — stock journal | |
| Skipped by type — delivery/receipt note | |
| Skipped by type — order | |
| Skipped by type — other | |

Every skipped voucher must be listed with its type and count. A skipped voucher
is data that will not exist in Synapse; the owner decides whether that is
acceptable before signing.

## Part 6 — Exceptions

Copy every exception from the review screen.

| Code | Severity | Count | Owner's decision |
|---|---|---|---|
| | | | |

## Part 7 — Gates

All must be yes before Apply. One no stops the cut-over.

| # | Gate | Yes / No |
|---|---|---|
| G1 | The probe found the company list (discovery works on this Tally build) | |
| G2 | Closing-balance tags are present **and** the importer reads that exact tag | |
| G3 | The company the plan was built from is the company that will receive it | |
| G4 | Opening debit equals opening credit | |
| G5 | Stock quantities and values are non-zero where Tally shows stock | |
| G6 | Every skipped voucher has been reviewed and accepted by the owner | |
| G7 | The source file is no larger than 25 MB **and** no more than 2,000,000 tags **and** no more than 250,000 records | |
| G8 | The target tenant does not already hold stock or transactions | |
| G9 | A backup of the Tally company has been taken by the dealer | |
| G10 | Both the masters and the Day Book named the pinned company | |

The three limits behind G7 fail differently, which is why all three are listed:

- **Over 25 MB** — the upload is refused. Loud.
- **Over 2,000,000 tags** — the parser throws `MIGRATION_XML_TOO_COMPLEX`. Loud.
- **Over 250,000 records** — the parser records the truncation on the document
  (reason, limit and the number of records actually processed), the normaliser
  raises a blocking `SOURCE_TRUNCATED` exception, and Apply refuses with
  `TALLY_SOURCE_TRUNCATED`. The upload itself is never modified; the plan keeps
  what was read so the operator can see it, but that plan cannot be applied. Measured on the repo fixture (992 bytes and 39
  tags per voucher), 25 MB is reached at roughly 26,000 vouchers and 2,000,000
  tags at roughly 50,000 — so size normally fails first. The probe reports the
  real numbers.
- **Cut short before the closing `</ENVELOPE>`** — a partial download or a
  failed copy. The parser refuses it (`MIGRATION_XML_INCOMPLETE`) and the page
  asks for a fresh export; it is never imported as if it were a shorter period.

There is a fourth limit the size gates do not cover: the bridge waits **60
seconds per request** (masters, then Day Book separately) and abandons the
request when that expires. The probe waits 30 minutes, so a Day Book that takes
longer than 60 s will fail through the bridge even when it fits in 25 MB. The
probe records the seconds each request took and warns when either exceeds 60 s;
it also prints them in the at-a-glance block. Compare those numbers against 60 s
before agreeing a cut-over, and prefer the XML-upload route when they exceed it.

G10 exists because the bridge now refuses any response that does not name the
company it came from. The probe reports whether this Tally build does.

G2 is the gate this repository cannot currently pass on its own: the importer
reads `<CLOSEBALANCE>` and no test has shown a real Tally export containing it.
The probe report answers it.

## Part 8 — Sign-off

| | |
|---|---|
| Prepared by | |
| Date | |
| Owner's decision | proceed / narrow the period / use a different route |
| Apply window agreed | |

## After Apply

- The cut-over locks itself: no second Tally import is accepted for the tenant.
- **There is no rollback in the code.** Undoing an applied cut-over means
  restoring the database from a backup taken before Apply. That is why G9 exists.
- Re-running Apply is resumable within the same session while the claim holds;
  it is not a way to start over.
