# Tally replay hardening — 2026-11-15

What stopped a real full-history Tally import from completing, what was changed,
and the evidence. Companion to
[TALLY_MIGRATION_ACCEPTANCE_CRITERIA.md](./TALLY_MIGRATION_ACCEPTANCE_CRITERIA.md)
and [SADIO_TALLY_READINESS_REPORT.md](./SADIO_TALLY_READINESS_REPORT.md).

Nothing here touched a shared, staging, production or customer database. No
customer data was used: every figure below comes from synthetic exports.

## Summary

The replay engine, the database write path, rollback and AC-9 already worked on
the small synthetic fixtures. At customer scale, in the shape the SADIO re-export
will take (masters with opening stock and closing figures, every allocation
named `Primary Batch`, no expiry), four defects meant the import could never be
applied:

| # | Defect | Effect on a SADIO-shaped history |
|---|---|---|
| 1 | Closing **value** was compared on the replay's moving batch average. Tally's default costing method, **Average Cost**, is an annual weighted average: (year opening value + inward value) ÷ (year opening quantity + inward quantity), unaffected by sales. | A false value difference on almost every item whose purchase price changed after a sale. |
| 2 | Under the operator's accepted `batchExpiry: "not-supplied"`, voucher receipts were replayed without expiry, but **opening stock without expiry was still dropped** (`OPENING_STOCK_WITHOUT_EXPIRY`, no batch created). | The replay started from zero stock, so early sales ran negative. |
| 3 | A stock item master's opening batch was read only from `ACTUALQTY`/`BILLEDQTY`. Tally's master format states it as `OPENINGBALANCE` inside `BATCHALLOCATIONS.LIST`. | Every batch-wise opening position read as quantity-less, so none was received even with (2) fixed. |
| 4 | The portal's 30-minute idle sign-out counts only mouse/keyboard/scroll. A customer-scale apply runs longer than that while the operator watches. | The apply stopped with HTTP 401 mid-history (reproduced at step 162 of ~300). |

Measured on the same 26,359-voucher synthetic history (below), unmodified main
produced **12,089 blocking items** — 10,912 negative-stock findings, 2,167 item
differences, and the stock total. The gate accepts at most 1,000 written
acknowledgements (`REPLAY_ACK_LIMIT`), so the import could not be applied by any
operator. After the changes: **0 blocking, every row `match`.**

## Changes

| Area | File | Change |
|---|---|---|
| Parser | `packages/db/src/tally-xml-rows.ts` | Reads `COSTINGMETHOD` on stock items, `STARTINGFROM` on the company record, and a master batch's `OPENINGBALANCE`. |
| Consolidation | `apps/pharmacy/lib/tally/consolidate.ts` | Carries the financial-year start across staged files. |
| Plan | `packages/db/src/tally-normalise.ts` | Carries `costingMethod` and `financialYearStart`. Under replay + `not-supplied`, opening batches without expiry are receivable, and an item kept without batches opens as one unnamed batch (Apply names it `TALLY-OPEN-…`). Counted into the existing `REPLAY_BATCH_EXPIRY_NOT_SUPPLIED` disclosure. Default (`source`) and opening-mode behaviour unchanged. |
| Reconciliation | `packages/db/src/tally-replay.ts` | `costingBasis()` and `averageCostPositions()`. Average Cost items are valued per financial year with Tally's five-decimal rate rounding; At Zero Cost at zero; every other method, and an export that states none, keeps the batch basis (unchanged). With no financial-year start in the export the value row is `not-available` with a reason — never a pass, never a guessed year. Rows carry `basis` and `note`. The stock total is summed on the same basis. |
| Export | `apps/tally-bridge/scripts/tally-export-history.ps1` | Asks Tally for `CostingMethod` on stock items and records `StartingFrom` as `<STARTINGFROM>` in the masters company record when Tally answers. |
| Apply | `apps/pharmacy/app/api/admin/tally/[id]/{apply,preview,sources}/route.ts` | `export const maxDuration = 60`. A 250-movement step takes ~8 s on loopback (13 s worst), more with real network latency; no limit was set before. |
| Portal | `apps/pharmacy/hooks/use-idle-logout.ts`, `app/portal/tally-import/page.tsx` | `holdIdleLogout()`: while the page's apply loop runs, the idle timer restarts instead of signing out. Released in `finally`; normal idle rules resume after the apply. |
| Dev tooling | `apps/tally-bridge/scripts/fake-tally.mjs` | Answers the script's company-period request. |
| Rehearsal | `scripts/tally-fixtures/scale-history.mjs`, `scripts/db-tests/tally-scale.local.test.mjs` | Customer-scale generator with independently computed closing figures, and the portal journey that applies it. |

## Evidence

### Unit and integration

| Suite | Result |
|---|---|
| `npm run test:tally` | 152 / 152 (was 137; new valuation, opening-stock and parser tests) and bridge 133 / 133 |
| Pharmacy vitest | 1,443 pass, 53 skipped, 1 fail — `workbook.test.ts` serial-date case, which fails identically on unmodified main in this environment (the SheetJS CDN is blocked here, so `xlsx` 0.18.5 stood in for 0.20.3) |
| `lib/tally/average-cost-replay.test.ts` | 4 / 4 — script-shaped masters + day books through staging, consolidation, plan, replay, reconcile |
| Pharmacy type-check, lint | pass, 0 warnings |
| `test:routes`, `test:security-gates` | pass |
| Mutation check | removing each fix makes its tests fail (parser 2, valuation 7, year rollover 1) |

### Real database (native PostgreSQL 16 + PostgREST 12, no Docker)

Docker registries are unreachable from this workspace, so the harness was
reproduced natively: canonical snapshot plus all 48 post-cutoff migrations
applied with 0 failures; PostgREST behind a loopback stand-in for the Supabase
gateway with a minimal storage emulator. Deviations: no pgvector (vector columns
become text, so the ACL assertion reports the one vector-typed function), no
GoTrue (the portal signs in with its own password hash, so none is needed).

| Suite | Result |
|---|---|
| `tally-replay.local.test.mjs` | 13 / 13 |
| `tally-portal.local.test.mjs` (real portal, headless Chrome) | 14 / 14, `journey: PASS` |

### PowerShell export script

Run under PowerShell 7.4.6 on Linux against `fake-tally.mjs`: parses with 0
errors; writes masters + three day books; carries `COSTINGMETHOD`; writes
`<STARTINGFROM>20250701</STARTINGFROM>` when Tally answers, omits it cleanly when
Tally does not. Its output staged through the portal chain yields
`financialYearStart = 2025-07-01` and `costingMethod = "Avg. Cost"` on the plan.

### Customer scale

`scale-history.mjs --sales-per-day=70`: 1,800 items (1,091 with opening stock),
26,359 vouchers (24,554 cash sales, 1,340 purchases from 27 suppliers, 465
physical counts), 46,924 stock lines, 2025-10-17 to 2026-10-31, crossing the
1 July financial-year boundary; purchase prices drift ±15 %.

| | Unmodified main | This change |
|---|---:|---:|
| Item rows `match` | 1,433 / 3,600 | 3,600 / 3,600 |
| Stock total | difference | match |
| Ledger rows `match` | 32 / 32 | 32 / 32 |
| Blocking items | 12,089 | 0 |
| In-memory preview | 2.7 s | 2.5 s |

Through the real portal and database (`tally-scale.local.test.mjs`, production
build of the portal, headless Chrome, nobody touching the page):

| Step | Result |
|---|---|
| Stage 14 files through `upload-url` + `sources` | pass; slowest 374 ms |
| Preview (replay, `not-supplied`) | pass in 4.7 s; 0 blockers, 0 blocking exceptions |
| Apply from the page's own button | 296 requests, all HTTP 200, no failures recorded; closing check passed |
| Stock-history steps (250 movements each) | 192 steps, mean 4.75 s, p95 8.1 s, worst 8.6 s |
| Whole apply | ≈ 24 minutes |
| Database after apply | all 1,800 products hold Tally's closing quantity exactly |

Before the idle-logout fix the same journey was signed out by the page at
request 162 (~35 minutes into a dev-server run) and stopped with HTTP 401.

## What this does not prove

- **That Tally computes Average Cost exactly as modelled.** The rule follows
  Tally's published Average Cost description and its five-decimal worked
  example. Two choices are this repository's reading and must be confirmed on a
  real install: sales returns and physical counts do not move the rate, and the
  year opens at the prior year's closing rate. The scale generator uses the same
  model, so its value match proves the implementation equals the model, not that
  the model equals Tally. The quantity match is independent arithmetic.
- **That `StartingFrom` is the financial-year start on every Tally build.** If a
  build answers nothing, value rows read `not-available` rather than pass.
- **Batch expiry tag.** The parser and the script's coverage check read
  `EXPIRYDATE`. If a Tally build writes batch expiry only as `EXPIRYPERIOD`, a
  pharmacy that does keep expiries would see them as absent. SADIO keeps none, so
  it is unaffected; check on the first expiry-tracking customer.
- **Production timing.** Loopback steps took ~8 s; production adds network
  latency per RPC. `maxDuration = 60` gives headroom on every Vercel plan, but the
  first real apply should be watched in the function logs.
- The live bridge (`bridge.mjs`) master collections were not changed; the folder
  export is the supported route.
- Nothing here substitutes for AC-0 to AC-3 and AC-9 on the customer's own
  machine and network, or for the accountant's sign-off.
