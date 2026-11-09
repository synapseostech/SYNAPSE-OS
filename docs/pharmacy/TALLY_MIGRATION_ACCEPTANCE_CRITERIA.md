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
| AC-5.4 | A refund succeeds | refund receipt from the portal journey (`journey: PASS`) |
| AC-5.5 | A manual stock adjustment succeeds | adjustment record from the portal journey |
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

**What is proven today:** all six steps, in 14 subtests of
`scripts/db-tests/tally-portal.local.test.mjs` against a disposable
PostgreSQL 15.19 stack and the real portal (`journey: PASS`): sign-in through
the login form, a purchase and a sale recorded with no Tally bridge on the
host, stock levels moved, the migrated period's report drawn on screen
(`USh 19,000` gross profit on `49,000` revenue), no console error, and no
request to any origin other than the app and its own database. The database
half — a sale leaving the imported batch it names — is also covered by
`scripts/db-tests/tally-replay.local.test.mjs`. AC-9 remains open only as an
operator step on the customer's own network; the application side is
demonstrated.

**AC-10 — replay parity.** A full-history import may complete only when the
state it produced equals Tally's own closing figures for the same cutoff:
per-item quantity exactly, per-item value and every ledger balance within
0.01, every party balance, and total stock value. A row the export does not
carry is `not-available`, never a pass. Any real difference blocks completion
and names the earliest divergent date and source voucher.

Evidence: `packages/db/src/tally-replay.ts` reconciliation rows; the
`replay-closing` stage refuses `TALLY_REPLAY_CLOSING_MISMATCH`; the synthetic
full-history fixture exercises the path. **Not yet proven on a customer
archive** — the SADIO export carries no closing figures at all.

---

## 8. Known blockers at the time of writing

These are recorded so nobody signs a migration that cannot be supported.

| Blocker | Effect | Reference |
|---|---|---|
| Windows bridge not yet exercised on a Windows host | extraction has not been demonstrated against a real Tally install | `TALLY_CONTROLLED_WINDOWS_TEST_RUNBOOK.md` |

The PR-007 blocker (partial and credit-sale refunds not atomically reversing
tender and receivables) is resolved: `pharmacy-refund-rpc.integration.test.ts`
executes 20 cases against a disposable PostgreSQL stack — five of them the
PR-007 partial and credit-sale refunds — and all pass.

The prior PR-002 blocker (definitions missing from the replay chain) is
resolved in the working tree and verified in two disposable local
reconstructions. That evidence does not establish a deployed production
migration state; the release must still reconcile the migration ledger before
deployment.

---

## 9. Evidence status, 2026-11-09

Every row below was executed on this date unless marked otherwise. "Synthetic"
means the twelve-month full-history fixture (`full-history-fixture.ts`), which
carries masters, batch expiry and closing figures. The SADIO archive carries
masters and closing figures for neither, and its batch expiry may be accepted
as absent by an explicit operator choice (`batchExpiry: "not-supplied"`), which
is recorded in the plan and shown in preflight as a non-blocking warning.

| Criterion | Status | Evidence, or why not |
|---|---|---|
| AC-0.1–AC-0.4 | **NOT TESTED** | Customer-side preconditions: no tenant was enabled, no Tally backup was supplied, and no acknowledgement was signed. Nothing was extracted from a live Tally install |
| AC-1.1–AC-1.8 | **NOT TESTED** | These describe the bridge's chunked extraction; no Windows host exists here. The archive as supplied was verified separately — 13/13 files, 26,064 = 26,064 vouchers, 0 discrepancies, bounded and CRC-checked — in the readiness report |
| AC-2.1, AC-2.2 | **PASS** | Plan counts equal the extraction summary; manifest coverage `verified` |
| AC-2.3 | **FAIL for SADIO, by design** | `TALLY_MASTERS_MISSING` blocks apply. Accepting the absent expiry removes the 4,529 expiry exceptions (verified on the archive: 0 remain), but the 5 quantity-less lines still block. Apply refused, as it must |
| AC-2.4, AC-2.5 | **NOT TESTED** | No masters reached the mapping screen, so no mapping or SKU override was reviewed |
| AC-3.1–AC-3.7 | **NOT TESTED** | The client's accountant has not tied out any figure; the export carries no closing figures to tie out |
| AC-4.1–AC-4.6 | **PASS (synthetic)** | Portal journey: one apply under the cut-over lock, reservation matched, manifest accepted, second apply a no-op, audit path did not fire |
| AC-5.1, AC-5.3–AC-5.6 | **PASS (synthetic)** | Portal journey: catalogue built, a sale left the named batch, refund and manual adjustment succeeded, the migrated period's report drew on screen |
| AC-5.2 | **NOT TESTED** | Requires accepted closing stock from AC-3.1/AC-3.2, which does not exist for SADIO |
| AC-9 | **PASS on the disposable stack** | All six steps in `tally-portal.local.test.mjs`, `journey: PASS`; the operator run on the pharmacy's own network is still required |
| AC-10 (synthetic) | **PASS** | Reconciliation rows match and the `replay-closing` stage completes on the fixture |
| AC-10 (SADIO archive) | **NOT TESTED** | All 1,867 reconciliation rows are `not-available`; there is nothing to compare against |

---

## 10. Sign-off

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
