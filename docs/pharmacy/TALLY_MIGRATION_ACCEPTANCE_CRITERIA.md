# Tally migration acceptance criteria

What must be true before a pharmacy may be declared migrated from Tally, and who
signs it.

This document is the sign-off record. The mechanics live in
[TALLY_MIGRATION_ARCHITECTURE.md](./TALLY_MIGRATION_ARCHITECTURE.md),
[TALLY_PERIOD_SEMANTICS.md](./TALLY_PERIOD_SEMANTICS.md) and
[TALLY_UPLOAD_GUIDE.md](./TALLY_UPLOAD_GUIDE.md); do not repeat them here.

**Governing rule.** Extraction, preview and a green review screen are not
migration. A migration counts only when **AC-9 (independence) passes**. Until
then the outcome is “staged”, not “migrated”.

Vocabulary: `PASS` = demonstrated with evidence attached to this record.
`FAIL` = demonstrated false. `NOT TESTED` = nobody has run it. Never mark an
unrun criterion `PASS`.

---

## 1. Preconditions

| ID | Criterion | Evidence |
|---|---|---|
| AC-0.1 | Cut-over is enabled for exactly one tenant, deliberately, and is not enabled globally | the setting change and its approver |
| AC-0.2 | A Tally company backup taken **before** extraction is stored somewhere other than the machine being migrated | backup file name, host, date |
| AC-0.3 | Tally remains read-only throughout: the bridge performs no accounting writes | bridge version, and the audit in `TALLY_CONNECTOR_SECURITY_AUDIT.md` re-checked at the installed version |
| AC-0.4 | The operator has read `TALLY_UPLOAD_GUIDE.md` and can name the period being migrated | signed acknowledgement |

If AC-0.1 through AC-0.4 are not evidenced, stop. Do not extract.

---

## 2. Extraction completeness

The portal server re-reads every chunk itself; it does not trust the browser’s
report. These criteria correspond to refusals the API actually issues.

| ID | Criterion | Refusal if unmet |
|---|---|---|
| AC-1.1 | Every voucher-range chunk reaches `complete` | `TALLY_EXTRACTION_INCOMPLETE` |
| AC-1.2 | Exactly one masters chunk, read to `complete` | `TALLY_MASTERS_MISSING`, `TALLY_MASTERS_DUPLICATE` |
| AC-1.3 | Each chunk’s company matches the company named at `begin` | `TALLY_BRIDGE_COMPANY_MISMATCH` / `TALLY_BRIDGE_COMPANY_UNVERIFIED` |
| AC-1.4 | No source response was truncated by Tally or the transport | `SOURCE_TRUNCATED`, `TALLY_SOURCE_TRUNCATED` |
| AC-1.5 | No chunk contains a voucher dated outside the range requested for it | `TALLY_CHUNK_DATES_OUTSIDE` |
| AC-1.6 | Chunk ranges start at the period start, end at the period end, and neither overlap nor leave a gap | `TALLY_CHUNK_GAP`, `TALLY_CHUNK_OVERLAP` |
| AC-1.7 | Every chunk was uploaded to its own storage path | `TALLY_CHUNK_PATH_INVALID` |
| AC-1.8 | A restart has not discarded completed work silently | `TALLY_EXTRACTION_HAS_PROGRESS` |

Record: number of chunks, number of split sub-ranges, total vouchers read, and
any chunk that had to be split.

---

## 3. Data that reached the plan

| ID | Criterion | Evidence |
|---|---|---|
| AC-2.1 | Account, party, product and voucher counts in the plan match the extraction summary | the `staged` block written by `finish` |
| AC-2.2 | Coverage is `verified`, or the operator has explicitly acknowledged `unverified` | `manifestCoverage`, and the acknowledgement if `TALLY_UNVERIFIED_NOT_ACKNOWLEDGED` was accepted |
| AC-2.3 | There are zero blocking exceptions | `TALLY_BLOCKING_EXCEPTIONS` |
| AC-2.4 | Every unmapped account was reviewed by a human; none was left to a default silently | the mapping screen output |
| AC-2.5 | Every product SKU override was reviewed | the override list |

A plan that reached review by acknowledging dialogs is not accepted. AC-2.2
must be `verified` for a production cut-over.

---

## 4. Accounting tie-out

Performed by the client’s accountant, against Tally’s own reports, before
applying.

| ID | Criterion | Tolerance |
|---|---|---|
| AC-3.1 | Closing stock value, per product, matches Tally’s closing stock valuation | exact to the currency’s minor unit |
| AC-3.2 | Closing stock quantity, per product, matches Tally | exact |
| AC-3.3 | Party balances (receivables and payables) match Tally | exact |
| AC-3.4 | Sales total for the migrated period matches Tally’s sales register | exact |
| AC-3.5 | Purchase total for the migrated period matches Tally’s purchase register | exact |
| AC-3.6 | VAT/tax totals match Tally’s tax summary, or the tenant has documented that VAT is computed outside the system | exact or documented exclusion |
| AC-3.7 | Every difference is listed with a reason and accepted in writing | list attached |

If any of AC-3.1 to AC-3.6 differs and is not explained, do not apply.

> For a balances-only cut-over (mode `closing`), vouchers are not read. AC-3.1
> and AC-3.2 become the whole of the tie-out, and AC-3.4 to AC-3.6 are recorded
> as “not applicable — balances-only cut-over”, signed as such.

---

## 5. Applying

| ID | Criterion | Refusal if unmet |
|---|---|---|
| AC-4.1 | The apply runs once, under the tenant’s cut-over lock | `TALLY_CUTOVER_BUSY`, `TALLY_CUTOVER_IN_PROGRESS`, `TALLY_CUTOVER_LOCK_UNAVAILABLE` |
| AC-4.2 | The plan belongs to the session being applied | `TALLY_RESUME_SESSION_MISMATCH` |
| AC-4.3 | The reservation names this session | `TALLY_RESUME_OWNER_MISMATCH` |
| AC-4.4 | The manifest passes `canApplyManifest` | `TALLY_MANIFEST_INCOMPLETE`, `TALLY_MANIFEST_INVALID` |
| AC-4.5 | A completed cut-over cannot be re-applied | `CUTOVER_ALREADY_COMPLETE` |
| AC-4.6 | The apply is audited | the `TALLY_AUDIT_FAILED` path did not fire |

Record: session id, lock holder, start and end timestamps, final stage.

---

## 6. Post-apply verification

| ID | Criterion | Evidence |
|---|---|---|
| AC-5.1 | Catalogue reflects the migrated products | product count before/after |
| AC-5.2 | Opening quantities equal the accepted closing stock from AC-3.1/AC-3.2 | reconciliation output |
| AC-5.3 | A test sale succeeds and decrements the correct batch | receipt and stock movement |
| AC-5.4 | A refund succeeds — **blocked in fresh environments, see §8** | receipt |
| AC-5.5 | A manual stock adjustment succeeds — **blocked in fresh environments, see §8** | adjustment record |
| AC-5.6 | Reports for the migrated period are readable | report screenshots |

---

## 7. Independence (the criterion that makes it a migration)

**AC-9 — the disconnect test.** With the Tally bridge stopped and the client’s
PC unreachable:

1. The pharmacy signs in.
2. A sale is completed.
3. A purchase is recorded.
4. Stock levels update.
5. Reports for the migrated period render.
6. No screen blocks, hangs or errors waiting on Tally.

`PASS` requires all six, performed with the bridge demonstrably not running.

Nothing in the application may require Tally after cut-over. The bridge is an
import tool, not a dependency.

---

## 8. Known blockers at the time of writing

These are recorded so nobody signs a migration that cannot be supported.

| Blocker | Effect | Reference |
|---|---|---|
| Refund/stock RPCs now replay and pass disposable-database behavior checks, but partial/credit-sale refunds do not atomically reverse tender and receivables | Do not accept partial/credit refund accounting until PR-007 is fixed and independently tested | `PRODUCTION_READINESS_PROGRESS.md` PR-007 |
| Windows bridge not yet exercised on a Windows host | extraction has not been demonstrated against a real Tally install | `TALLY_CONTROLLED_WINDOWS_TEST_RUNBOOK.md` |

The prior PR-002 blocker (definitions missing from the replay chain) is
resolved in the working tree and verified in two disposable local
reconstructions. That evidence does not establish a deployed production
migration state; the release must still reconcile the migration ledger before
deployment.

---

## 9. Sign-off

All rows must be `PASS` (or an explicitly accepted, recorded exclusion) before
the pharmacy is described as migrated.

| Role | Name | Result | Date | Signature |
|---|---|---|---|---|
| Pharmacy owner / director | | | | |
| Client accountant (AC-3) | | | | |
| SYNAPSE operator (AC-1, AC-2, AC-4, AC-5) | | | | |
| SYNAPSE engineer (AC-0, AC-9) | | | | |

**Final outcome** — circle one:

- `MIGRATED` — every criterion `PASS`, AC-9 included.
- `STAGED` — extracted and applied, AC-9 not passed.
- `REJECTED` — a criterion failed and was not accepted.

A record left blank is `STAGED` at best, whatever the screenshots show.
