# SADIO PHARMACY — Tally migration engineering report

Date: 2026-11-09. Branch: `feat/sadio-tally-migration`. Nothing was merged,
pushed or deployed, and no production or shared database was contacted. The
customer's ZIP and XML files were read only.

## 1. Outcome

The archive is fully ingested and reconciled; **the migration itself is NO-GO on
this package.** Every one of the 26,064 vouchers and 46,727 stock lines is
accounted for, but three source-side gaps block apply:

1. **No masters** — 0 ledgers, groups or stock items. Apply is blocked by
   `TALLY_MASTERS_MISSING`, and every sales line would fail product matching.
2. **No batch expiry** — 0 of 46,727 allocations carry one. The operator may now
   accept this explicitly (`batchExpiry: "not-supplied"`); the 4,529 receipts
   are then imported with Tally's batch names and no expiry, and the plan
   carries one warning stating the counts and what cannot be done with that
   stock. The 5 quantity-less lines still block either way.
3. **No closing figures** — all 1,867 reconciliation rows are `not-available`,
   so closing parity with Tally cannot be demonstrated.

Accepting the absent expiry is a recorded operating decision, not an inference:
the review screen asks for it, the plan stores it, preflight shows it as a
non-blocking warning, and the import discloses it. No date is invented and no
receipt is dropped.

None of this is hidden: each is a blocking finding with a count, a reason and a
named remedy. The detailed evidence is in
[SADIO_TALLY_READINESS_REPORT.md](SADIO_TALLY_READINESS_REPORT.md), and the
field-by-field coverage is in
[SADIO_TALLY_FIELD_MATRIX.md](SADIO_TALLY_FIELD_MATRIX.md).

## 2. Deliverables

| # | Deliverable | Where |
|---|---|---|
| 1 | Gap analysis | [SADIO_TALLY_FIELD_MATRIX.md](SADIO_TALLY_FIELD_MATRIX.md), §Fields the archive does not carry |
| 2 | Field coverage matrix | [SADIO_TALLY_FIELD_MATRIX.md](SADIO_TALLY_FIELD_MATRIX.md) |
| 3 | Archive coverage and reconciliation | [SADIO_TALLY_READINESS_REPORT.md](SADIO_TALLY_READINESS_REPORT.md), §2–§5 |
| 4 | ZIP/XML ingestion | `packages/db/src/tally-zip.ts`, `tally-archive.ts`; bounded and manifest-checked |
| 5 | Staging and idempotency | `pharmacy_tally_replay_movements` unique key; movement chunks in `plan.ts`/`apply.ts` |
| 6 | Rollback | Compensating RPC in `20261106120000_pharmacy_tally_stock_replay.sql`; **executed and proven** on a disposable PostgreSQL 15.19 stack (§4) |
| 7 | Regression tests | `apps/pharmacy/lib/tally/archive-regression.test.ts`, `packages/db/src/tally-zip.test.ts` |
| 8 | Unrecoverable source data | [SADIO_TALLY_READINESS_REPORT.md](SADIO_TALLY_READINESS_REPORT.md), §8 |
| 9 | Readiness report | [SADIO_TALLY_READINESS_REPORT.md](SADIO_TALLY_READINESS_REPORT.md) |
| 10 | Files and migrations | §3 below |
| 11 | Commands and results | §4 below |
| 12 | Go/no-go | §6 below |

## 3. Changes in this branch

All changes are uncommitted on the feature branch.

**Archive and parsing**

- `packages/db/src/tally-zip.ts` — bounded ZIP reader (64 MB archive, 256
  entries, 200:1 ratio; refuses ZIP64, encryption, spanning, unsafe names,
  duplicates, CRC mismatches).
- `packages/db/src/tally-archive.ts` — per-file streaming, manifest
  reconciliation, company from the summary, control-character accounting.
- `packages/db/src/tally-xml-rows.ts` — header `STATUS` guard; `ENTEREDBY` and
  cost-centre parsing; inventory/batch rows; per-line deemed-positive.

**Normalisation, replay and mapping**

- `packages/db/src/tally-normalise.ts` — replay mode, movements, ordering,
  per-code `exceptionCounts`, aggregate attribution warnings recorded before
  the 500-exception cap, and the explicit `batchExpiry: "not-supplied"` mode
  (a receipt with no expiry is kept with Tally's batch name and no date, and
  one aggregate warning states the counts and consequences).
- `packages/db/src/tally-replay.ts` — pure simulation, FEFO, SET resolution,
  reconciliation rows, blocking findings, and the historical cost each sale
  line's stock removed (per batch value). A line the replay cannot fully fill
  is marked incomplete and carries no partial cost.
- `apps/pharmacy/lib/tally/apply.ts` — writes that cost to
  `pharmacy_transaction_items.cost_price`, so the profit report uses each
  sale's own historical cost instead of today's product cost.
- `packages/db/src/tally-replay-rpc.ts` — typed replay/rollback RPC wrappers.
- `packages/db/src/inventory-rpc.ts` — RPC error parsing used by the replay and
  rollback wrappers.

**Application flow**

- `apps/pharmacy/lib/tally/apply.ts` — replay stage machine, movement chunks,
  replay-mode opening stock, `replay-closing` gate.
- `plan.ts`, `preflight.ts`, `chunks.ts`, `manifest.ts`, `source.ts`,
  `storage.ts`, `cutover.ts`, `continuation.ts`, `replay-gate.ts`,
  `stock-sheet.ts`, `auth.ts`, `http.ts`, `types.ts` — plan storage, review
  gates, continuation, stock sheet, auth and error vocabulary.
- `apps/pharmacy/app/api/admin/tally/**` — upload/sources/extract/preview/apply,
  replay report and timeline, rollback, status routes.
- `apps/pharmacy/app/portal/tally-import/page.tsx` — mode choice, timeline,
  reconciliation, apply progress, and (replay only) the operator's explicit
  "this export carries no batch expiry dates" choice. The preview route accepts
  `batchExpiry: "source" | "not-supplied"` and refuses any other value;
  preflight reports the accepted state as a non-blocking warning.

**Migrations (prepared, not applied anywhere)**

- `supabase/migrations/20261106120000_pharmacy_tally_stock_replay.sql` —
  provenance table, movement RPC, closing-actuals RPC, compensating rollback.
- `supabase/migrations/20261107120000_pharmacy_tally_replay_continuation.sql` —
  checkpoint table and continuation guard.
- `supabase/migrations/20261109120000_pharmacy_tally_cutover_lease_claim.sql` —
  fix-forward claim: the row reserves the session only, a live lease names an
  owner, and a stale row is free to take.

**Tests and docs**

- `apps/pharmacy/lib/tally/archive-regression.test.ts` — real-archive suite,
  gated on `SADIO_TALLY_ARCHIVE`.
- `apps/pharmacy/lib/tally/full-history-fixture.ts` — synthetic twelve-month
  replay export with a batch name Tally reuses for two expiries, both sides of
  a stock journal and a physical count. `full-history-fixture.test.ts` drives it
  through the real XML parser and normaliser.
- `apps/pharmacy/lib/tally/bridge-export-replay.test.ts` — a bridge-shaped run
  (masters carrying `CLOSINGBALANCE`/`CLOSINGVALUE`, plus two monthly day books
  whose stated periods end at the cut-over) staged through the same sequence as
  the sources route, consolidated, normalised and replayed. It proves the
  replay cut-off comes from the last day book rather than the masters file's
  later period end, that the replay reaches Tally's own closing position with
  every account and stock row `match` and none `not-available`, and that forcing
  the cut-off to the masters' period end raises a blocking
  `REPLAY_PERIOD_MISMATCH`.
- `scripts/db-tests/tally-replay.local.test.mjs` — 13 real-database tests over
  the disposable harness: apply, idempotent re-run, negative-stock refusal,
  closing read, compensating rollback, fresh re-apply, AC-9 database half, the
  post-cut-over rollback refusal, the first cut-over lease being granted rather
  than refused as busy, and a receipt with no expiry stored far-future while
  provenance keeps the true absence.
- `scripts/db-tests/run-pharmacy-portal-harness.sh` and
  `tally-portal.local.test.mjs` — the journey through the real portal against
  the disposable stack: sign-in, upload, review, apply, the profit report on
  the API and on screen, then a purchase, a sale, a refund and a manual
  adjustment with no Tally connection, plus a foreign-origin request audit.
- `packages/db/src/tally-zip.test.ts` — 13 hostile-archive cases.
- Existing tally suites extended for attribution and replay behaviour.
- This report, the readiness report and the field matrix.
- `package.json` — `test:tally` now also runs `tally-replay.test.ts` and
  `tally-zip.test.ts`, so CI covers them.

Executing the journey found six defects that no unit test had caught, all
fixed in this branch:

1. a replay plan's manifest was rejected as not a manifest, so Apply could not
   start;
2. the portal's Apply gate deferred to a server preflight that cannot see the
   sequence checkbox, and the button never enabled;
3. `claim_pharmacy_tally_cutover_apply` answered `busy` for its own fresh
   lease (fix-forward migration above);
4. a physical count below the books was booked to a synthetic batch and raised
   `REPLAY_NEGATIVE_STOCK` instead of consuming the batches that held the stock;
5. the journals stage was never given the replay target, so every mirrored sale
   line kept `cost_price: null` and the profit report showed total cost 0;
6. a superseded report response could overwrite the request the operator made
   last, drawing a stale period.

Two pre-existing untracked files in the repository root, `app.json` (16 bytes,
`{"expo":{}}`) and `controlchars.json` (empty), are not part of this work and
were left untouched. An empty `supabase/migrations/.mcp.json` is untracked for
the same reason and is likewise left out of the change set.

## 4. Commands executed and results

| Command | Result |
|---|---|
| Read-only probes over the customer ZIP (`node --import tsx`) | `status: verified`; 26,064 = 26,064; 13/13 files; 0 discrepancies |
| `SADIO_TALLY_ARCHIVE=… npx vitest run lib/tally/archive-regression.test.ts` | 4/4 pass (48.2 s), including the no-expiry import of the customer archive |
| `cd packages/db && node --import tsx --test src/tally-*.test.ts` | 133/133 pass, 0 fail |
| `npx vitest run lib/tally app/api/admin/tally` in `apps/pharmacy` | 600 pass, 4 skipped, 0 fail (40 files passed, 1 skipped) |
| `npx vitest run lib/tally` in `apps/pharmacy` | 412 pass, 4 skipped, 0 fail (29 files passed, 1 skipped), including the bridge-shaped replay test |
| `npm run test:tally` | 133 pass, 1 skipped, 0 fail |
| `npm run verify:pharmacy` | **exit 0** — type-check and lint clean; `test:general` 1,440 pass, 53 skipped, 0 fail (127 files passed, 8 skipped; the 53 skips are the `*.local` and `*.integration` suites that need a database or the real archive, plus the 4 gated archive tests); tally-bridge 133 pass, 1 skipped; `next build` compiled successfully in 52 s |
| `npm run type-check --workspace @synapse/pharmacy` | pass |
| `npm run lint --workspace @synapse/pharmacy` | pass, 0 warnings |
| `npm run lint --workspace @synapse/db` | pass, 0 warnings |
| `npm run db:check` | 217 migration files OK |
| `SYNAPSE_PHARM_DB_HARNESS=1 bash scripts/db-tests/run-pharmacy-db-harness.sh refund tally` | **refund 20/20 and tally 13/13 pass** on PostgreSQL 15.19 native, project `synapse-pharm-harness-636830`, 48 migrations after snapshot cutoff `20260920190000`, function ACL assertion passed |
| `SYNAPSE_PHARM_DB_HARNESS=1 bash scripts/db-tests/run-pharmacy-portal-harness.sh` | **14/14 journey subtests pass, `journey: PASS`**, on PostgreSQL 15.19, project `synapse-pharm-portal-518014`, 48 migrations after snapshot cutoff, portal at `127.0.0.1:3002` |
| `node --experimental-strip-types scripts/tally-fixtures/generate.ts` | wrote `test-pharmacy-full-history.xml` (12,625 bytes) beside the cut-over fixtures |
| `npm run test:migration-integrity` | 68/68 pass, 0 fail |
| `node scripts/collect-evidence.mjs` | Regenerated `artifacts/readiness/evidence.json` at HEAD `dc8e2c9a`: 217 migrations, all six suites exit 0, `disposableDb.result: pass` (tally 13/13, refund 20/20, portal journey 14/14 on PostgreSQL 15.19). The delimited evidence block in the two remediation audit documents was refreshed from the same file |
| `npm run test:evidence-drift` | 6/6 pass after regeneration; the pinned baseline HEAD moved from `0a641069` to `dc8e2c9a` |

### What the harness proved, exactly

The disposable stack applies the prepared migrations to a throwaway PostgreSQL
15.19 instance on ports 55320–55327 and runs the suite over PostgREST with the
service role. Each line below is an executed test, not an inference:

1. an inbound movement creates the batch at its historical `received_date`;
2. a second expiry under the same batch number is refused and leaves no batch;
3. a differently named batch keeps its own expiry;
4. a sale leaves the batch it names;
5. re-sending an applied movement is a no-op and writes no second provenance row;
6. a movement past stock on hand is refused;
7. the closing read returns products and batches in one payload;
8. rollback writes three compensating movements (never deletes) and returns
   stock and every batch to zero;
9. a fresh session re-applies the same export after the rollback;
10. a sale completes from imported stock with no Tally connection — the database
    half of AC-9 — receipt `R-\d{8}-\d{4}`, total 20,000;
11. rollback is refused once post-cut-over trading exists, and the refusal
    writes nothing;
12. the first cut-over lease is granted rather than refused as busy, and a
    stale lease is free to take;
13. a receipt that states no expiry still moves stock: the batch row is stored
    far-future (`9999-12-31`) so FEFO and the expired-batch checks treat it as
    usable, while the provenance row keeps the true absence (`expiry_date
    null`, `allocation: "explicit"`).

The `refund` suite executes 20 cases over the same stack, five of them the
PR-007 partial and credit-sale refunds (cash handed back equals what was paid,
the receivable is reversed, and nothing is reversed beyond the ledger).

One defect was found and fixed by this run: the movement RPC compared a batch's
recorded expiry against a null expiry on outbound lines and raised
`BATCH_EXPIRY_CONFLICT`. Only a *stated*, differing expiry is a conflict now.

The four skipped pharmacy tests are the real-archive suite without
`SADIO_TALLY_ARCHIVE` set; with it set all four pass.

## 5. Not done, and why

| Item | Status | Reason |
|---|---|---|
| Apply the migration to a database | **Executed** | Disposable harness `scripts/db-tests/run-pharmacy-db-harness.sh`; 48 migrations applied, ACL assertion passed |
| Prove rollback | **Executed** | 13/13 suite tests, including compensating rollback and post-cut-over refusal |
| AC-9 disconnect test — database half | **Executed** | A sale completes from imported stock with no Tally connection |
| AC-9 disconnect test — portal and sign-in half | **Executed** | `run-pharmacy-portal-harness.sh`: 14/14 subtests, `journey: PASS`. Sign-in, purchase, sale, refund, adjustment, the migrated period's report on screen, no console error, and no request to any origin other than the app and its own database. No Tally bridge exists on the harness host |
| Replay the full customer ZIP end to end against a database | Not executed | The archive has no masters, so no product catalogue can be built and apply is blocked at preflight. The expiry gap is now an explicit operator choice; the 5 quantity-less lines still block. The synthetic full-history fixture covers the replay path instead |
| AC-0 preconditions | Not tested | No tenant was cut-over-enabled, no Tally backup was supplied for storage, and no acknowledgement was signed |
| AC-3 accounting tie-out | Not tested | The client's accountant has not tied out any figure, and the export carries no closing figures to tie out |
| AC-10 parity on the customer archive | Not tested | All 1,867 reconciliation rows are `not-available`; there is nothing to compare against |
| Batch/expiry coverage check in `tally-export-history.ps1` | Not executed | There is no PowerShell host on this machine; the script runs on the pharmacy's Windows computer. The check is one pass over each written file counting `BATCHALLOCATIONS.LIST` blocks against those that carry a non-empty `EXPIRYDATE`. It reports the two numbers at the end of the export and, when expiry is missing, prints how the portal imports that export instead of failing the run — a no-expiry export is now importable with the operator's explicit choice, so it is not an export defect |
| Real SADIO import | Not performed | Prohibited by the brief |
| Merge, push, deploy | Not performed | Prohibited by the brief and the standing order |

The database harness proves the SQL and the RPC contract; the portal harness
proves the screens and the API routes against them. The report says "not
executed" for anything neither covers.

## 6. Go / no-go

| Decision | Verdict |
|---|---|
| Accept and stage this ZIP | **GO** — bounded ingestion, manifest parity, no silent drops |
| Show the operator the blockers in the portal | **GO** |
| Operate the portal after a cut-over with no Tally | **GO on the disposable stack** — 14/14 journey subtests, AC-9's six steps executed |
| Apply this package to a live pharmacy | **NO-GO** — no masters and no closing parity. Absent expiry is an accepted operating limitation, not a blocker, when the operator turns it on |
| Claim rollback works | **YES, with a stated limit** — proven on the disposable stack for replay movements; never run against the customer's data or a production project |
| Production import / merge / deploy | Not attempted |

To turn this into a GO, the customer must supply a masters-inclusive export and
Tally's closing balances and stock at the cutoff. One run of
`apps/tally-bridge/scripts/tally-export-history.ps1` on the pharmacy's Windows
computer produces both: it writes the masters file (ledger groups, ledgers with
opening and closing balances, stock items with opening/closing quantity and
value, units, godowns) and one XML per month of vouchers. Batch expiry for the
inbound voucher lines is optional: without it the operator may accept the
no-expiry mode, and imported stock then keeps Tally's batch names but cannot be
expiry-tracked, allocated by expiry or recalled by batch expiry (stock received
after the cut-over is unaffected). A previous run of this script on the same
ERP 9 build wrote 14 monthly files and 2,025 stock items
([TALLY_PERIOD_SEMANTICS.md](TALLY_PERIOD_SEMANTICS.md), "What the pharmacy's
ERP 9 build settled"), so the per-type masters collection is known to answer;
whether `CLOSINGBALANCE` comes back in it is what the first run will show, and
if the figures are dated to another period the import refuses to compare rather
than treating them as the cutoff's. The five quantity-less lines should be
corrected at source. The importer will then re-run the same reconciliation and
refuse to complete until every blocking difference is resolved. The request to
send SADIO and their Tally operator is
[SADIO_TALLY_DATA_REQUEST.md](SADIO_TALLY_DATA_REQUEST.md), and the run itself is
in [SADIO_TALLY_REEXPORT_BRIEF.md](SADIO_TALLY_REEXPORT_BRIEF.md).
