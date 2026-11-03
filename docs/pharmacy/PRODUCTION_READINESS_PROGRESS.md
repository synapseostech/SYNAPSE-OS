# Pharmacy production readiness — progress ledger

Living record of the continuous production-readiness work on the pharmacy
application. Update it after every substantial workstream; it is the single
place that answers “what is actually true right now”.

**Status vocabulary.** `PASS` — executed here, evidence recorded. `FAIL` —
executed here and wrong. `BLOCKED` — cannot advance without the owner, external
access or a decision. `NOT TESTED` — no execution attempted. `PARTIAL` — some
paths executed, others not.

**Rules this ledger obeys.**

- A documentation statement is not proof of a capability.
- A mocked test is not proof of a real integration.
- A green local build is not proof of deployment readiness.
- Nothing is marked `PASS` from reading code alone.

Last updated: **2026-11-01**.

---

## 1. Baseline

| Item | Value |
|---|---|
| Repository | `/home/ebrine/Desktop/SYNAPSE-OS` |
| Branch | `feat/tally-bridge-command` |
| `HEAD` | `85b6732fb497009017dcbbf288a8bb1d5aa219eb` |
| Working tree at baseline | 21 modified, 32 untracked (dirty before this work began; preserved) |
| Pharmacy app | `apps/pharmacy`, Next.js, dev port 3002 |
| Runtime available here | node v24.22.2, npm 11.19.1, no pnpm, no PHP |
| Migrations | 210 files under `supabase/migrations/` at the latest `db:check` (209 timestamped, plus `demo_schema_init.sql`), the newest being `20261102130200_complete_pharmacy_sale_single_overload.sql` |
| Fresh-DB source | `supabase/bootstrap/canonical_public_schema.sql` (scripts/db-reset-fresh.sh does **not** replay migrations); CI's db-acceptance job loads the snapshot **and** every migration newer than `20260920190000` |
| CI gate on `main` | `.github/workflows/ci.yml` (PR + push), includes “Pharmacy verification” and “Tally import parsers” |

### Environment limitations (not product defects)

| Limitation | Effect | Working substitute |
|---|---|---|
| Supported Node/npm versions are unavailable | This host has Node 24.22.2/npm 11.19.1; the repo requests Node 22.x/npm 10.9.7 | All 18 release-gate stages pass on these versions after `test:tally` was switched to `node --import tsx --test` (`RELEASE_GATE=PASS`, §5). CI still runs the supported pair; the version skew is unverified, not fatal |
| No Windows host | Installer, ACLs, shortcuts, UAC, launcher, uninstall cannot be executed | Documented procedure only; see `TALLY_CONTROLLED_WINDOWS_TEST_RUNBOOK.md` |
| No TallyPrime / Tally.ERP 9 | No live XML gateway | Not executable here. Both editions are coded as named targets and the review discloses that neither is verified; the per-edition checklist in `TALLY_PRIME_ERP9_ACCEPTANCE.md` is the only route to evidence |
| **No Supabase stack can be executed** | PostgREST, GoTrue, Storage and a second connection are all unavailable, so the `concurrency` suite and any HTTP-level proof stay unproven | A real PostgreSQL 18.6 engine is now available in-process (below), and the chain plus the tenant-isolation assertions execute on it. See §5 |

Tests that require Windows, real Tally, staging/production access, or a browser
are recorded as `NOT TESTED` here — never as `PASS`.

**The database environment, re-measured on 2026-11-01** (not assumed):

| Check | Result |
|---|---|
| `command -v postgres`, `initdb`, `pg_ctl`; `find /usr /opt /snap /var/lib` | all missing — `postgresql-client-16` installs a `psql` client and no server |
| `docker info` (socket present at `/var/run/docker.sock`, mode `srw-rw---- nobody:nogroup`) | `permission denied while trying to connect to the docker API`. The invoking user is in `nogroup` and the socket is writable by that group, but a direct `net.connect` returns `EPERM`: the sandbox refuses the socket, not the filesystem. `dangerouslyDisableSandbox` is unavailable in this session, so this is not a permission the workspace can grant itself |
| `sudo -n true` | fails, and the process carries `no_new_privs` |
| Network egress (apt, npm registry, ftp.postgresql.org) | refused by the session allowlist; `allowed_domains` cannot widen it here |
| `ss -ltn` for 5432, 54321, 54322 | nothing listening |
| npm cache | holds `@electric-sql/pglite@0.5.11` (8.8 MB tarball) with `pgcrypto`, `uuid-ossp` and 40 other contrib extensions; no `pglite-socket`, `embedded-postgres` or `pg-mem` |
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `NEXT_PUBLIC_SUPABASE_URL` | all unset, so the HTTP integration suites skip without attempting a connection |

Consequence: the only engine obtainable here is **PGlite — PostgreSQL compiled
to WebAssembly**, run in-process from the cached tarball, installed into a
scratch directory outside the repository. It is the real engine: the planner,
executor, constraint system, triggers, `SECURITY DEFINER` and row-level security
all run in PostgreSQL's own C code, and the runs in §5 are execution, not
simulation. What it cannot do is hold two connections at once, serve PostgREST,
or provide `pgvector`; the runner prints those deviations at the start of every
run, and `scripts/db-tests/PGLITE-SETUP.md` documents the exact setup.
Concurrency-sensitive claims therefore remain unproven, and the HTTP-level
suites remain skipped.

Earlier revisions of this ledger described a disposable server
(`/usr/lib/postgresql/16/bin`) whose `initdb`/`pg_ctl` output appears in this
session’s history; that server and its data directory are gone (only
`postgresql-client-16` remains installed), so those claims cannot be re-verified
and stay marked `PARTIAL` rather than `PASS`.

---

## 2. Gate dashboard

| Gate | Area | Status | Why |
|---|---|---|---|
| **A** | Pharmacy product completeness | PARTIAL | Web/POS route tests and build checks pass, but no real browser journey; mobile VAT totals and discount allocation are now computed by the shared engine and executed as unit tests, and the mobile receipt now refuses to be left before a print decision is recorded (unit-tested, never run on a device). The web POS mandatory-print decision can no longer be dismissed with Escape (fixed this pass) but has not been exercised in a browser |
| **B** | Database, accounting & inventory integrity | PARTIAL | The canonical snapshot plus every post-cutoff migration reconstruct on a real PostgreSQL 18.6 engine (in-process WASM), and the sale, tax, journal, refund, receivable, purchase, supplier and till paths now execute there with independently computed expected figures — 44/44 assertions (§5, 2026-11-01). Still unexecuted: the vitest refund/adjustment suite, concurrency, and anything through PostgREST. That suite encodes rollback, duplicate/concurrent reversal, tenant checks, FEFO history, recall safety and stock restoration — but **none of its cases runs here** (no Supabase stack), so they are NOT EXECUTED. PR-007's repair is now observed in SQL (the refund returns the tendered portion and reverses the receivable in one transaction) as well as in the tree; the RPC-over-PostgREST cases for it have still not run. The legacy order-refund fallback, which handed back the tax/discount-exclusive line sum, is fixed and unit-tested; its arithmetic is proven, its database effect is not. Broader workflow acceptance is untested |
| **C** | Tally migration (Prime + ERP 9) | NOT TESTED | No Tally instance; extraction/review exercised only by unit tests |
| **D** | Windows bridge & installer | NOT TESTED | No Windows host; package integrity verified on Linux only |
| **E** | Independence from Tally | PARTIAL — AC-9 does not pass | Two AC-9 layers now execute: an import-graph guard proving no operating module can reach the Tally importer, and a real POS sale handler that completes with the cut-over switch off while every outbound request is poisoned (§5, 2026-11-01). AC-9 still requires a completed apply of real data and the six steps in a browser on the client's PC with the bridge demonstrably stopped; none of that has run, so a migration still cannot count |
| **F** | Security & multi-tenancy | PARTIAL | RPC actor/tenant checks and grants verified locally; the mobile-auth deactivation bypass (PR-008) found and fixed, with two mutation-tested cases. Row-level security now executes on a real PostgreSQL 18.6 engine: 18 assertions covering cross-tenant read/write, tenant admins, both membership sources (active and withdrawn), archived profiles, anonymous callers, privilege self-promotion and storage, 18/18 with the access repair and 13/18 without it (§5, 2026-11-01) — so the suite is shown to discriminate. Still open: none of those migrations has been applied to a real environment, the vitest JWT suites need a Supabase stack, and there is no penetration test, staging run or production access |
| **G** | Production infrastructure & operations | PARTIAL | Readiness/liveness probes reviewed and fixed (PR-003); deployment gate claim corrected (PR-004); no production access |

A gate is `PASS` only when every item under it has executed evidence.

---

## 3. Defect register

| ID | Severity | Area | Status |
|---|---|---|---|
| PR-001 | High | POS money integrity | Fixed, regression-tested |
| PR-002 | Blocker | Database reproducibility | Remediated in tree (migration + snapshot + guard fix); behavioural proof not executed here |
| PR-003 | Medium | Information disclosure | Fixed, regression-tested |
| PR-004 | Medium | Deployment documentation | Corrected |
| PR-005 | High | Receipt printing control | Partial: web attempts and POS reprints are tenant-audited; the silent Escape bypass of the mandatory print decision was closed, and the mobile receipt now gates back / hardware back / swipe-back on the same decision; physical output remains unknown and neither surface has been driven on a browser or a device |
| PR-006 | High | Tax / VAT integrity | Partial: one shared calculation used by the web POS, both sale routes and (since this pass) the mobile till, with web and mobile product classification; open items are per-line persisted tax (migration prepared, unapplied) and the mobile till never having been observed on a device |
| PR-007 | High | Refunds of partial/credit sales | Fixed in tree, not DB-verified: the refund RPC now returns only the cash tendered and posts a `'refund'` credit-ledger movement that reverses the outstanding balance in the same transaction; an unposted balance is reported instead of refunded. Static and mock tests pass; the five database cases that would prove it are **not executed** |
| PR-008 | High | Multi-tenant access control | Fixed, mutation-tested: a staff member with rows in two pharmacies bypassed the mobile deactivation check for both |
| PR-009 | High | Reporting / VAT | Fixed, regression-tested: the sales report summed tax-inclusive POS totals as net (revenue overstated by the VAT), reported POS discounts as 0, and grouped all profit under “Uncategorized” |
| PR-010 | Medium | Information disclosure | Fixed, regression-tested: the purchases report returned the raw database error text to the client |
| PR-011 | High | Multi-tenant access control | Repair prepared, statically pinned, **not applied and not executed against a database**: nineteen pharmacy policies satisfied `profiles.is_admin` with no tenant predicate, so a tenant administrator could read and write any tenant's pharmacy rows with the public anon key |
| PR-012 | High | Multi-tenant access control | Repair prepared, statically pinned, **not applied and not executed against a database**: findings F1–F8 of `SECURITY_TENANT_ISOLATION_AUDIT.md` — anonymous read of pending invitations, deactivated/deleted accounts keeping row access, membership modelled as one pointer instead of a set, twenty-seven policies defaulting to `PUBLIC`, two row-secured tables with no policy, four policies resolving tenancy through an inline `profiles` subquery, JWT self-promotion to platform administrator, and `pharmacy_assert_actor` accepting a deleted profile |

### PR-001 — client-supplied tax could reduce a sale

`apps/pharmacy/app/api/admin/pos/complete-sale/route.ts` forwarded
`body.taxAmount` to `complete_pharmacy_sale` unvalidated.
`20261031120000_pharmacy_sale_allow_negative_stock.sql` computes
`v_total := v_subtotal - v_discount + coalesce(p_tax_amount, 0)` and only rejects
a total below zero. A cashier with `pos.sell` could therefore send
`taxAmount: -300` on a 1000 sale and complete it at 700 — an unaudited 30%
discount that never passes the supervisor-approval threshold, because the
threshold is computed from line discounts only.

The route now rejects a non-finite or negative `taxAmount` with
`400 INVALID_TAX_AMOUNT` before the RPC runs. Tests:
`route.test.ts` → “client-supplied tax” (4 cases).

> Superseded by PR-006: the server now computes the tax and only accepts a
> client figure that agrees with it.

### PR-006 — tax was client-supplied and the VAT columns were unused

Traced end to end before changing anything:

| Layer | Before |
|---|---|
| `pharmacy_settings` | `vat_enabled` (default **false**), `vat_rate` (default 18), legacy `tax_rate` `numeric(5,4)` (default 0) |
| `pharmacy_products` | `vat_category` `NOT NULL DEFAULT 'exempt'`, CHECK `standard | exempt | zero_rated` |
| Settings API | returns `taxRate`, `vatEnabled`, `vatRate`; the mobile API writes `vat_enabled`/`vat_rate`; the web settings page has no VAT controls |
| Inventory API | did not select or return `vat_category`; product create/update did not accept it |
| Web POS | `taxAmount = total × taxRate / 100` from the legacy column, sent to the route as gospel |
| Mobile POS | hardcoded `taxAmount: 0` |
| Routes | web route forwarded `body.taxAmount` (only a negativity check, PR-001); mobile route forwarded it with **no** check at all |
| Reports | sum stored `tax_amount`, so only as right as what was written |

Three consequences: the mobile route was an open door for a negative or
inflated tax; `vat_category` was write-only (nothing selected it), so VAT could
never apply to a product; and no layer agreed on which setting was
authoritative.

**Unit convention, established before any schema change.** Both `tax_rate` and
`vat_rate` are **percentages**: `18` means 18%. Every consumer divides by 100 —
`computePharmacySaleTax` computes `base * rate / 100` for both the VAT and the
legacy path (lines 105 and 131), the POS preview does `total * (taxRate / 100)`,
and neither settings API converts on read or write. No layer treats either
column as a fraction, and no stored value is rescaled by the precision
migration.

**Fixed.** `packages/db/src/pos-tax.ts` is now the single implementation, used
by the web POS, the web sale route and the mobile sale route.

- **VAT on** (`vat_enabled = true`): rate is `vat_rate`; only lines whose
  product is `standard` are taxed. `exempt` and `zero_rated` are not, and an
  unknown or null category is treated as exempt — the column default — so no
  product becomes taxable because a row was unclassified.
- **VAT off**: the legacy `tax_rate` applies to the whole discounted base,
  exactly as the POS did, so no existing tenant's totals move.
- **No settings**: zero tax. Nothing invents a rate.
- **Invalid rate** (missing, non-numeric, outside 0–100): the sale is refused
  with `422 INVALID_TAX_CONFIGURATION`, naming the field. The till shows
  “Tax settings are invalid” and does not complete the sale.
- **Client figure**: the server computes the tax and writes *its* value. The web
  route rejects a disagreeing figure with `409 TAX_AMOUNT_MISMATCH` and the
  expected amount, because the cashier has already quoted the customer that
  total. The mobile route keeps the sale and uses the server value, returning
  `taxAdjusted: true`, because the phone has no VAT breakdown and refusing
  would stop a VAT-enabled pharmacy selling from the app; a negative or
  non-numeric figure is still `400 INVALID_TAX_AMOUNT` on both.
- **Base**: one tax line per cart line, net of its line discount, with batch
  splits summed back, so tax is charged on what the customer actually pays.
- **Product classification**: `GET /api/admin/inventory` now returns
  `vatCategory`, and product create/update accept an optional `vatCategory`.
  An edit that omits it leaves the classification untouched rather than
  resetting it to exempt. Web inventory create/edit screens expose
  `standard`, `exempt` and `zero_rated`; the earlier claim that this UI was
  missing was incorrect. The mobile POS catalogue response returns the
  category (`GET /api/mobile/pharmacy/pos/products` selects `vat_category` and
  maps it to `vatCategory`, `null` when unclassified).
- **Settings boundary**: `POST /api/admin/settings` used to write
  `tax_rate: data.taxRate ?? 0` unchecked. The historical `numeric(5,4)`
  column overflowed on a 18% setting. The new
  `20261102100000_pharmacy_settings_tax_rate_precision.sql` widens it to
  `numeric(8,4)` without rescaling stored values; the API accepts percentage
  rates from 0 to 100 and returns an explicit 422 if an older database still
  overflows. VAT rates are also checked in 0–100. The settings APIs preserve
  omitted VAT fields, so a screen without VAT controls cannot silently switch
  VAT off.
- **Web settings UI**: the page’s only tax control was “Tax Rate (%)”, wired to
  the legacy column, so a web-only pharmacy could not enable VAT at all. It now
  carries a “Charge VAT” switch and a VAT rate field (writing
  `vat_enabled`/`vat_rate`), keeps the legacy rate visible and labelled with
  the legacy rate, and surfaces the server’s validation message instead of a
  generic “Failed to save settings”.

**Representation established from code; existing production records not
inspected.** `tax_rate` is a percentage: `18` means 18%, evidenced by the web
POS `taxRate / 100` calculation and the shared `computePharmacySaleTax`
contract. The precision migration widens the type but does not rescale values.
No production data was read, and there is no production database access here to
sample the distribution of existing stored values; therefore that distribution
still needs an authorized read-only check before any data migration or VAT
cut-over.

VAT remains opt-in (`vat_enabled` defaults false); products default to exempt.
When VAT is off, the existing legacy percentage remains in effect. When on,
only explicitly `standard` products are taxed; exempt and zero-rated products
are not. Invalid settings block server completion. The web route rejects a
client total that differs from its server quote, while mobile completion
reconciles to the server amount and returns `taxAdjusted`.

Tests (all executed, see §4): `packages/db/src/pos-tax.test.ts` (12),
`apps/pharmacy/app/api/admin/pos/complete-sale/route.test.ts` (32, of which 7
are the new server-authoritative-tax cases),
`apps/pharmacy/app/api/admin/settings/route.test.ts` (7, of which 5 are the new
tax-configuration cases), and
`apps/web/src/app/api/mobile/pharmacy/pos/complete-sale/route.test.ts` (10, of
which 4 are new). Together they cover exempt products, discounted bases,
rounding, zero tax, missing and invalid configuration, negative, excessive and
manipulated client values, and the server value reaching the settlement.

**Mutation-checked.** Removing the `standard`-only filter from
`computePharmacySaleTax` makes 3 of the 12 `pos-tax` tests and 1 of the 32 route
tests fail; restoring it makes them pass again (file hash identical before and
after). Removing the negative-tax guard makes all 3 `INVALID_TAX_AMOUNT` cases
fail. The regression tests do catch the defects they describe.

**Mobile till — fixed in this pass.** The app was the one layer still outside
the shared tax engine: it hardcoded `taxAmount: 0` and put the whole cart
discount on the first line. Both changed, without a new dependency:

- `apps/app/lib/pos-pricing.ts` (new, zero imports so it loads under both Metro
  and `node --test`) exports `roundMoney` and `allocateCartDiscount`, which
  splits a cart discount across lines in proportion to line net, clamps it to
  the cart, and pushes the rounding remainder onto the last line so the parts
  sum to the discount exactly. The cart now sends a per-line `discountAmount`,
  so a mixed taxable/exempt cart is taxed on the base the cashier quoted.
- `apps/app/app/pos.tsx` imports `computePharmacySaleTax` from
  `packages/db/src/pos-tax` — the same function the web POS and both sale
  routes use — and computes the preview from each line's discounted net and
  `vatCategory`. The footer shows `VAT (n%)` when tax is due, and the Total row
  and the pending offline receipt both carry the VAT-inclusive figure.
- The tax settings are cached to `AsyncStorage` under
  `synapse.pharmacy.pos.tax.v1` and restored when the settings fetch fails.
  **Fail-closed:** if the device has never read the settings and the network is
  down, `completeSale` refuses with “Tax settings unavailable” rather than
  quoting zero tax and having the server raise the bill at sync.
- A restored draft whose lines predate the VAT preview is repaired by a
  hydration effect that copies `vatCategory` from the catalogue onto matching
  lines, so a draft taken before an upgrade is not silently quoted untaxed.

Executed: `node --experimental-strip-types --test apps/app/lib/pos-pricing.test.ts`
→ 7/7 pass (proportional split, exact remainder sum, cart-order independence,
over-discount clamp, no-discount/empty/NaN, negative-line handling, many-line
rounding); `npx tsc --noEmit` in `apps/app` → exit 0; `npx expo export
--platform android` → exit 0, which is what proves Metro resolves the
`packages/db/src/pos-tax` import. The new route test
`apps/web/src/app/api/mobile/pharmacy/pos/products/route.test.ts` (5 cases:
category passthrough, unclassified → `null`, tenant scoping, auth refusal,
feature-gate refusal) passes, and `npm run test:pharmacy-mobile-api` is 22 files
/ 160 tests, exit 0. A new `test:mobile-app` stage now runs the mobile pricing
test inside `verify:pharm-release`.

**Not executed:** the mobile till has not been run on a device or emulator in
this pass, so the on-screen VAT row, the fail-closed alert and the cached
settings fallback are type-checked and unit-tested but not observed.

**Remaining, recorded not fixed.**

- `20261102100000_pharmacy_settings_tax_rate_precision.sql` is future-dated
  relative to this ledger’s 2026-11-01 update. It does apply in order on the
  WASM engine as part of the §5 chain run, but it has not been applied to any
  real environment, and its release timestamp should be corrected or explicitly
  approved before deployment.
- Tax is stored per sale, not per line: `pharmacy_pos_sales.tax_amount` is a
  total, so a per-rate breakdown on the receipt/report is unavailable without
  a coordinated schema and sale-RPC change. (`20261102110000_pharmacy_line_level_tax.sql`
  adds the per-line columns, but it is prepared and unapplied; until it runs,
  the header total is the only stored tax figure.)
- Production values and the web/mobile VAT settings/product-classification
  journeys have not been inspected/exercised in a browser.

### PR-002 — two RPCs the app calls were not reproducible from the migration chain

**Corrected diagnosis (second pass).** The first report stated that the
canonical snapshot does not define these functions. That was wrong, and the
error came from the guard's matcher rather than from the snapshot. Both
functions are present in `supabase/bootstrap/canonical_public_schema.sql` —
`adjust_pharmacy_batch_stock` at line 287 and `reverse_pharmacy_sale` at line
2453, with `service_role`-only grants — so a snapshot-built database could
always refund. What was true:

- no file in `supabase/migrations/` created either function;
  `20260810093707_pharmacy_pilot_authority_hardening.sql` records production's
  remote ledger only as a `to_regprocedure(...) is not null` check, and a
  boolean is not a definition;
- `scripts/pharmacy-rpc-coverage.test.mjs` matched only
  `function public.name(`. A pg_dump writes
  `CREATE OR REPLACE FUNCTION "public"."name"(` — quoted schema and quoted
  name — so every snapshot definition was invisible to the scan. It also failed
  to see `complete_pharmacy_sale`, which is the tell: the matcher was blind, not
  the snapshot;
- the only chain-side bodies were the quarantined copies
  (`migrations_quarantine_local_only_2026-09-11/20260810120000_...sql`), and
  those bodies carry the defects below.

So the real gap was narrower than first reported but still real: replaying the
migration chain alone produced a database where refunds and stock adjustments
failed at runtime, and both inherited bodies were unsafe.

**Remediation and verification.** New migration
`supabase/migrations/20261101090000_pharmacy_refund_and_adjust_rpcs.sql`:

- adds `pharmacy_assert_actor(tenant, actor)`, which accepts a profile whose
  `profiles.tenant_id` is the tenant or an active
  `pharmacy_user_settings(profile_id, tenant_id)` row, and otherwise raises
  `PERMISSION`;
- recreates both RPCs with **unchanged signatures and return keys**, so grants
  and every call site in `packages/db/src/inventory-rpc.ts` are untouched;
- at this revision the refund amount was `coalesce(sale.total_amount, 0)`,
  including discounts and tax — the gross total, not the tender. That was
  PR-007, and `20261101120000_pharmacy_refund_receivable_reversal.sql`
  supersedes this body (see PR-007 below);
- a sale cannot be refunded twice: the sale row is locked `for update`, items
  are locked in `product_id, id` order, and the locked completed-to-voided
  transition is the idempotency guard;
- an earlier disposable-database execution — not reproducible in the current
  environment, see the blocker in §1 — reportedly exposed a runtime defect
  missed by static checks: updating `stock_decremented` on a completed line
  raised `APPEND_ONLY`. The refund no longer mutates sale lines. The sale
  status transition prevents a second restoration, preserving the append-only
  rule. That the fix holds is **asserted from the source, not observed**: the
  integration case that would confirm it is skipped;
- product locks now precede batch locks, matching the sale and stock-adjustment
  RPC order. An `active` restore is refused for inactive, recalled, damaged or
  expired batches; a quarantined restore preserves a recall/damage state and
  does not reactivate an inactive batch;
- a refund whose sold batch row has gone raises `BATCH_NOT_FOUND` before
  committing instead of restoring the product total alone;
- `DECREASE` refuses `p_quantity > product.quantity` with `INSUFFICIENT_STOCK`
  instead of decrementing batches and clamping the product total at zero, which
  is what allowed the two to drift;
- FEFO `DECREASE` writes one `pharmacy_stock_adjustments` row per affected
  batch, with the batch id and sequential product totals; `CORRECTION` and
  DAMAGE/QUARANTINE/RECALL also write audit rows, and audit errors are not
  swallowed;
- a `do` block revokes PUBLIC/anon/authenticated execute and grants
  `service_role` on all three functions.

The canonical snapshot carries the same corrected RPC behavior. Both function
signatures and JSON return keys are unchanged.

**Guard fixed.** The matcher now accepts both declaration styles, the
`KNOWN_UNDEFINED` pin is removed, and a canary test asserts the matcher sees
`complete_pharmacy_sale`, `reverse_pharmacy_sale` and
`adjust_pharmacy_batch_stock` in the snapshot — the exact blind spot that
produced the wrong diagnosis.

**Database reconstruction and runtime evidence — recorded earlier, NOT
REPRODUCIBLE NOW (status `PARTIAL`, not `PASS`).**

Earlier in this workstream a disposable PostgreSQL server was started from
`/usr/lib/postgresql/16/bin` and the two reconstructions below were run. That
server, its binaries and its data directories no longer exist on this host
(§1 measures the blocker), so none of the results in this subsection can be
re-run or independently checked today. They are preserved as history, not
offered as current evidence.

- `synapse_rpc_fresh_20261101`: rebuilt from the current canonical snapshot,
  then all 35 timestamped migrations after `20260920190000` applied in order.
- `synapse_rpc_replay_20261101`: rebuilt from the saved HEAD snapshot baseline,
  then the same 35 migrations applied in order.
- Reported at the time: identical RPC body hashes and signatures in both; all
  three functions `SECURITY DEFINER`, `search_path=public`, execute denied to
  `anon`/`authenticated` and granted to `service_role`. The *source* still
  shows exactly this, which is why the static tests can check it; the runtime
  grant state is not re-checked here.
- Reported at the time: direct SQL assertions passed for discounted and taxed
  refunds, duplicate reversal, cross-tenant actor denial, unauthorized
  adjustment, overshoot refusal, missing batch, correction plus audit, FEFO
  per-batch history, recalled-batch preservation and rollback after a forced
  failure following stock mutation, and a two-session test serialized
  concurrent refunds. **These are not executed claims in the current
  environment.**
- The reusable rollback assertion is
  `scripts/db-tests/pharmacy-refund-rpc-rollback.sql`; run it only against a
  disposable database. It rolls back its trigger and all test data.
- `npm run test:migration-integrity` → **23 tests, 23 pass** (re-run this turn;
  static). The Vitest RPC integration suite contains cases for concurrent
  duplicate reversal, tenant checks, rollback/retry and recalled stock; its
  default run is skipped because no Supabase stack is reachable. `npm run
  test:migration-integrity` and the RPC definition/coverage suites were re-run
  this turn and pass; they read files, and cannot prove runtime behaviour.

An attempted REST-backed run earlier briefly inserted two synthetic tenant
fixtures in the default local Supabase database before timing out. The exact
rows were verified to have no dependent records and deleted. No production or
remote database was used. Because that local database no longer runs here, the
cleanup cannot be re-verified now; nothing in the repository was left pointing
at it.

**Migration diff and risks for review.**

- The migration replaces two existing RPC bodies, adds one actor helper and
  a least-privilege grant block; the canonical snapshot mirrors the behavior.
- A sale whose batch row was deleted can no longer be refunded; the operator
  must restore the batch or correct stock explicitly. That is deliberate, but
  it is a new failure mode for previously "successful" refunds.
- An unsupported `p_restore_as` now raises `INVALID_QUANTITY` instead of
  silently coercing to `quarantined`. No current caller sends anything else.
- `DECREASE` no longer clamps at zero. A caller that relied on an
  over-decrease succeeding now gets `INSUFFICIENT_STOCK`.
- A partial-payment or credit sale is now refunded at the tendered amount, not
  the gross `total_amount`, and the outstanding balance is reversed by a
  `'refund'` movement keyed `pos-refund:<saleId>` inside the same transaction.
  The POS sale still has no foreign key to the credit ledger — the ledger row
  is matched by `transaction_id = null` plus that idempotency key — so the
  atomicity rests on both writes being in one RPC, not on referential
  integrity. See PR-007.

**Snapshot divergence, recorded not fixed.** The canonical snapshot predates
`20261030140000_pharmacy_batch_selling_price.sql` and
`20261031120000_pharmacy_sale_allow_negative_stock.sql`: it has no
`pharmacy_product_batches.selling_price` column and its `complete_pharmacy_sale`
body is the pre-batch-price version. It is internally consistent, so a
snapshot-only local database still sells, but it exercises older POS pricing
and no NEG-STOCK overdraft. CI and a real deployment apply the later migrations
on top. Do not read a snapshot-only local result as proof of current POS
behaviour.

### PR-007 — refund accounting was wrong for partial and credit sales (fixed in tree)

The web POS encodes `PAID:<amount>|BAL:<due>|M:<method>` in
`pharmacy_pos_sales.payment_ref` and records only cash actually received in the
till. The receivable is posted separately to `pharmacy_credit_ledger` with
`transaction_id = null`; `pharmacy_pos_sales` has no customer/credit-entry
link. `reverse_pharmacy_sale` used to return the full
`pharmacy_pos_sales.total_amount` as the refund and never touched the ledger, so
a partial-payment refund returned more cash than was tendered and a credit-sale
refund returned the gross amount while leaving the customer's debt outstanding.

**What changed** — `supabase/migrations/20261101120000_pharmacy_refund_receivable_reversal.sql`
replaces `reverse_pharmacy_sale` (same signature) so the three records agree:

| Figure | Value |
|---|---|
| `refund_amount` (cash out of the till) | what the customer actually paid, read from the `PAID:` tag with the same fallbacks the accounting trigger uses (`M:CREDIT` → 0, no tag → sale total), clamped to `[0, total]` |
| `receivable_reversal` | the credited part of the same sale, reversed in full |
| `receivable_outstanding` | the unpaid part, when it could not be reversed |

The reversal is a `pharmacy_credit_ledger` row of **type `'refund'`**, written
in the same transaction as the void and keyed `pos-refund:<sale_id>` under the
existing unique `(tenant_id, idempotency_key)`, so a retried refund posts at
most once and returns `ALREADY_REFUNDED`. It deliberately does not go through
`post_pharmacy_credit_entry` — that RPC's overpayment guard would reject a
reversal. A sale whose balance was never posted to the ledger reports
`receivable_unposted: true` instead of refunding cash that was never received.
The ledger `type` check is widened from `('credit','repayment')` to include
`'refund'`; a refund is a settlement and reduces the balance, which is why the
negative (store-credit) balance case is allowed — a customer who had already
repaid part of a credit sale ends up owed that money.

**Every consumer was updated in the same pass**, because a new movement type
that a reader treats as an invoice would age a refund as debt:

- `/api/admin/refunds` GET reports `net_amount` from `decodePaidAmount` (money
  handed back), not the sale total; POST returns `receivableReversal`,
  `creditBalanceAfter` and `receivableUnposted`, and the page toast says all
  three.
- The ageing routes (`apps/pharmacy` and `apps/web` mobile) settle a group on
  `repayment` **or** `refund`.
- The credit ledgers (portal page, `/api/mobile/pharmacy/credit-ledger`, Expo
  screen) render a refund as a settlement with a `−` and no overdue flag.
- A new `type=refunds` financial report (described in §3) splits cash refunded from
  receivable reversed and flags unposted balances; refunded sales no longer
  vanish from reporting without trace.

**Evidence.** Passing here: `lib/pos/partial-payment.test.ts` (decode cases),
`app/api/admin/refunds/route.test.ts` (credit and unposted cases),
`app/api/admin/accounting/ageing/route.test.ts` (3 new cases) and
`app/api/admin/reports/route.test.ts` (4 refund cases) — mock-level, not a
database. The five new cases in
`lib/pharmacy-refund-rpc.integration.test.ts` (part-paid cash + reversal,
fully-credit sale, part-repaid negative balance, unposted receivable, retry
idempotency) are written and **NOT EXECUTED** — they need a Supabase stack, and
this environment has none (the §5 engine run exercises sales, tax, settlement
and reversal, not this RPC). Until they run, the refund money path is correct by
inspection and by contract test, not by execution.

**Reconciliation hardening (this revision).** Reviewing that RPC against the
canonical schema found three gaps, all closed in the tree:

- **A missing sale was reported as a missing product.** The RPC raised
  `PRODUCT_NOT_FOUND` both for a sale that does not exist and for a line whose
  product row is gone, and `/api/admin/refunds` treated that code as "not a POS
  sale" and fell through to the older transaction table — so a sale whose
  product had been deleted answered with the legacy route's misleading
  "Transaction not found". The RPC now raises `SALE_NOT_FOUND` for the first
  case; only that code triggers the legacy fallback. `PRODUCT_NOT_FOUND` is
  answered `409` with a message naming the cause. The Expo route maps the two
  codes the same way (404 vs 409).
- **Unreversed debt was invisible.** The reversal is capped at
  `least(ledger.amount, sale outstanding)`, so a hand-corrected or partial
  posting leaves debt attached to a voided invoice. The RPC now returns
  `receivable_unreversed` and both the portal refund dialog and the Expo refund
  alert state the amount that stays on the customer's account — the Expo screen
  previously said only "Sale voided" and never told the cashier what to hand
  over.
- **The ledger type check could not be replaced on a replay.** The file dropped
  the auto-named original in a loop but then added a constraint by a fixed
  name; a replay over a database that already carries the widened check would
  fail on the duplicate. It is now dropped by name first, then the loop still
  covers an auto-named variant. The canonical snapshot carries the same body,
  so `db-reset-fresh.sh` and a migration replay define the same function.

Evidence added: two contract cases in `scripts/pharmacy-refund-rpc-definitions.test.mjs`
(the two error codes are distinct; the constraint is dropped by name before the
loop), three route cases in `app/api/admin/refunds/route.test.ts`, and three
cases in `lib/pharmacy-refund-rpc.integration.test.ts` (ledger holds less than
the sale's balance → reversal capped and `receivable_unreversed` reports 400 of
900; no payment tag → decoded as fully paid, matching `decodePaidAmount`; a
missing sale reports `SALE_NOT_FOUND`). The integration cases are written and
**NOT EXECUTED** — no Supabase stack in this environment. The `PRODUCT_NOT_FOUND`
branch cannot be provoked under the sale-item foreign key, which is why it is
covered at the route level and stated as such in the test.

**Legacy order refunds handed back the wrong amount (fixed in tree, later pass).**
The `pharmacy_transactions` fallback in `POST /api/admin/refunds` computed the
refund as `Σ unit_price × quantity` — the tax- and discount-exclusive base. A
sale carrying VAT was therefore under-refunded, and a **discounted** sale was
over-refunded: the customer received more cash than they had ever handed over.
`apps/pharmacy/lib/pos/refund-amount.ts` now derives the paid amount from the
header (`total_amount - discount + tax`) and gives a partial request its
proportional share of it, so the parts can never exceed what was paid; a request
covering every line returns the header figure exactly rather than a rounded
share. It reuses `roundMoney` from `partial-payment.ts`.

Executed: `lib/pos/refund-amount.test.ts` (7 cases) and two new cases in
`app/api/admin/refunds/route.test.ts` that drive the legacy branch with a
discounted, taxed transaction (1298 paid from a 1300 line sum — the old formula
returned 1300) and a taxed one (1180 from a 1000 line sum). Mutation-checked:
replacing the paid figure with the line sum fails 8 of those cases; restoring
it returns the file to hash
`9659f127dc4099ba26fbf9ab1db1ce455200d10e408a5cfd0a7ee9efbbc60671` and all 25
refund/accounting tests pass again. The legacy lookup itself still ran against a
mock — the route, not a database, is what was exercised.

**The `net_amount` basis — resolved in this pass.** PR-009 below originally
assumed `pharmacy_transactions.net_amount` excludes tax. The column does not
carry one meaning. The Tally cut-over stores the **pre-tax** voucher total in
it (`lib/tally/apply.ts:606`; the normalise fixture posts goods 450, output VAT
50 and cash 500, so the inventory line amount — and therefore `total` — is
ex-VAT). Both order writers store the order total with `tax = 0`. The edit
route stores `total - discount + tax`, i.e. **tax-inclusive**
(`transactions/[id]/edit/route.ts:157`). Summing the column as revenue was
therefore right for imported rows, harmless for orders, and overstated by the
VAT on any row the edit route had rewritten.

The sales report no longer uses the column for its basis. It sums
`total_amount - discount`, which is the pre-tax line sum in every writer: the
edit route rebuilds `total_amount` from unit prices and computes tax on top of
that sum, orders carry no tax, and Tally's stock-line amounts are gross of the
discount that arrives as a separate `SALES_DISCOUNTS` ledger line. Rows the
report returns still expose the basis as `net_amount`, so the client contract
is unchanged. Regression-tested: a Tally-shaped row (450 goods, 50 VAT) reports
450 sales and 50 tax; an edit-shaped row (`total 2000, discount 100, tax 342,
net 2242`) reports 1900 sales, 100 discount and 342 tax. Mutation-checked:
restoring `net_amount` as the summed figure fails the second case at 2242, and
the file returns to hash
`ef9d7137bb7e12f526ad5b6d0eb8280686ede5c97a8113e100ff0bab75642918`.
The one-query audit below is still worth running against a real database — it
now tells the operator which historical rows went through the edit route,
rather than deciding whether the report is correct:
`select count(*), sum(case when net_amount = total_amount - discount + tax then 1 else 0 end) from pharmacy_transactions where tax > 0`.

### PR-003 — `/api/ready` leaked the database error

The readiness probe is unauthenticated and returned `error.message` verbatim,
which for a driver failure can contain the database host, user and failure
reason. It now logs the detail server-side and returns the fixed string
`database probe failed`, keeping the `checks.database.ok` contract that
`scripts/e2e-acceptance-doctor.mjs` reads. Tests:
`apps/pharmacy/app/api/ready/route.test.ts` (3 cases).

### PR-004 — the deployment doc described a gate the repo does not implement

`docs/deploy.md` stated that each `vercel.json` runs `ignoreCommand` to cancel a
deploy when verification fails, and that “Pharmacy uses
`node ../../scripts/vercel-build-gate.mjs pharmacy`”. In fact:

- `apps/pharmacy/vercel.json` has no `ignoreCommand`;
- `scripts/vercel-build-gate.mjs` never runs verification — it decides from
  `VERCEL_ENV` and the branch name only, and ignores its argument;
- it deliberately builds every `production` deployment.

`docs/deploy.md` now states this accurately and names CI as the real gate.

### PR-005 — “Require receipt print” does nothing

`pharmacy_settings.mandatory_receipt_print` is `NOT NULL DEFAULT true`
(`20260718183806_tenant_tax_efris_settings_and_vat_category.sql:14`). It is:

- returned by `GET /api/admin/settings` as `mandatoryReceiptPrint`
  (`!== false`, so absent means enforced);
- returned and written by the mobile settings API
  (`apps/web/src/app/api/mobile/pharmacy/settings/route.ts:47,109`);
- exposed to the mobile app as a toggle labelled **“Require receipt print”**
  (`apps/app/app/settings.tsx:147`);
- typed on the web POS client (`app/portal/pos/page.tsx:128`).

At the start of this work it was not read by the web POS, so its default-on
setting did not control cashier behavior. The web flow now requires an explicit
post-sale print decision. The mobile app still does not enforce it.

That matters because the column arrived with the tenant tax/EFRIS settings. A
pharmacy that relies on it to meet a receipt obligation is relying on a control
that is not wired.

**Decision (implemented in tree).** “Require receipt print” means *the cashier
must make an explicit print decision after the sale is committed*. It does not
mean *the sale is withheld until a printer succeeds*, because:

- the sale, its items, its stock movement and its payment are already committed
  by `complete_pharmacy_sale` before the browser can reach a printer, so gating
  completion would turn a printer fault into lost revenue and a retry into a
  duplicate sale;
- a browser cannot report physical success. `window.print()` returns when the
  dialog closes, whether or not a device printed, and `afterprint` only means
  “dialog closed”. Success-gating would therefore either always pass or always
  fail — neither is a control.

So there are exactly two exits from the post-sale prompt: **print now**, or
**printer unavailable**. Both are recorded server-side. Neither changes the
sale. Escape used to be a silent third exit — `usePosKeyboardShortcuts`'s
`onClose` called `resetPendingPrintFlow()` whenever the prompt was open, so a
cashier could dismiss the mandatory decision without recording anything. That
path is now closed: Escape on the mandatory prompt does nothing, and Escape on
the client-name dialog does what its left button does (`recordPrinterUnavailable`
when enforcement is on). This is a source-level fix, not an executed one.

What changed:

- `apps/pharmacy/lib/pos/receipt-print.ts` — `resolveReceiptPrintPolicy()`.
  Absent settings enforce (`mandatoryReceiptPrint !== false`), matching the DB
  default of `true`; a page that has not loaded settings must not silently
  allow a skip. Mandatory supersedes `autoPrintReceipt`, because auto-print has
  no place for the cashier to report a broken printer.
- `apps/pharmacy/app/portal/pos/page.tsx` — the prompt’s dismiss action becomes
  **Printer unavailable** when printing is mandatory, the client-name dialog’s
  Cancel does the same, and the auto-print branch now keys off the resolved
  policy. Both paths record an outcome through the new endpoint. A print that
  the cashier requests reports `requested`, not `printed`. Escape no longer
  bypasses the prompt (see above), and a network failure while reporting the
  outcome now raises the same “Print attempt not fully recorded” toast as a
  non-OK response, instead of failing silently in the console.
- `apps/pharmacy/app/api/admin/pos/sales/[id]/print-status/route.ts` —
  `POST`, `pos.sell`, tenant-scoped. Writes only `print_failed` and
  `updated_at` on `pharmacy_pos_sales`, plus a
  `POS_RECEIPT_PRINT_REQUESTED` / `POS_RECEIPT_PRINT_FAILED` audit row
  (free-text reason trimmed and capped at 200 characters). It deliberately
  **never writes `printed_at`**: nothing in a browser can witness paper, so the
  column stays null rather than becoming a false success claim. The endpoint
  accepts only `requested` or `failed` and rejects `"printed"` with 400. It
  never touches totals, payments, stock or sale status. An audit-write failure
  returns **503** with `code: PRINT_AUDIT_FAILED` and `attemptRecorded: true` —
  the sale-level outcome is already saved, so the cashier is told the audit
  could not be confirmed, not that the sale failed. A 404 is returned for a sale
  outside the caller’s tenant. A successful response states
  `physicalPrintConfirmed: false`.
- `apps/pharmacy/app/portal/transactions/page.tsx` — reprint attempts for
  `source=pos` are also submitted to the tenant-scoped status endpoint. Legacy
  order prints are not represented as POS sale attempts.

**State semantics — what the system can and cannot distinguish.**

| State | Evidence | Distinguishable? |
|---|---|---|
| Sale completed | `pharmacy_pos_sales.status='completed'`, `confirmed_by`/`confirmed_at` | Yes, in the database |
| Print requested | `print_failed=false` plus a `POS_RECEIPT_PRINT_REQUESTED` audit row with its timestamp | Yes |
| Print dialog opened | none — `window.print()` and `afterprint` report only that the dialog closed | **No.** The API records the cashier's request, never the dialog |
| Physical outcome unknown | the default for every attempt: `printed_at` stays null and the response says `physicalPrintConfirmed: false` | Yes, as an explicit "not confirmed" |
| Detectable failure | `print_failed=true` plus a `POS_RECEIPT_PRINT_FAILED` row carrying the trimmed reason (or "printer unavailable") | Yes |
| Reprint | a later REQUESTED/FAILED row against the same sale; no new `pharmacy_pos_sales` row and no financial write | Yes, by attempt history — the row cannot tell first print from reprint |

A later `requested` attempt clears `print_failed` because the column records
the *last reported attempt*, not "this receipt never printed". The audit trail
keeps every earlier failure.

The failure message tells the cashier the sale is saved, that no money needs to
be taken again, and that the receipt can be reprinted from the sale in
Transactions. Reprints print the stored sale and create no new financial
transaction.

**Mobile POS — the exit is now gated (this pass).** `apps/app/app/pos.tsx` reads
`mandatoryReceiptPrint` from `/api/mobile/pharmacy/settings`; with it off, a synced
sale shows a “View receipt” action and records no print outcome. The mobile
settings screen still offers the “Require receipt print” toggle. The
bearer-token `/api/mobile/pharmacy/sales/[saleId]/print-status` route and the
receipt screen now exist, and this pass closed the last way past them: the
header back button, the Android back key and the iOS swipe-back all left the
receipt without a decision.

What changed:

- `apps/app/lib/receipt-print-gate.ts` — `resolveReceiptExit()`. A decision is
  owed only for a `completed` sale in a mandatory pharmacy with no recorded
  outcome; a refunded, voided or still-loading receipt is never blocked, so the
  gate cannot trap a cashier on a sale that has no receipt to hand over.
- `apps/app/app/receipt/[saleId].tsx` — the header back button and
  `BackHandler`'s `hardwareBackPress` both route through one handler; while the
  decision is owed it shows an alert with `cancelable: false` (Android cannot
  dismiss it with back or an outside tap) offering **Print now**,
  **Printer unavailable** and **Stay**. Both exits record before leaving.
  `navigation.setOptions({ gestureEnabled: false })` closes the iOS swipe path
  while the decision is outstanding.
- Leaving is never held on the network. The sale is already committed, so a
  recording that fails is reported and the cashier still leaves — the same
  trade-off `recordPrinterUnavailable` makes on the web till.

**Not executed on a device.** The gate helper is unit-tested (6 cases,
mutation-checked: the suite fails if `resolveReceiptExit` returns `leave` where
it must return `decide`), and `apps/app` type-checks. No phone has run this
screen, so whether this router version honours `gestureEnabled` is read from the
type definitions, not observed.

**Not executed in a browser.** The policy helper (9 tests) and status endpoint
(13 tests, including tenant scoping and audit failure) are unit-tested, and the
POS/Transactions pages type-check and lint. The dialog behaviour —
that the prompt cannot be dismissed without recording an outcome, and that the
toast appears — was **not** exercised against a running till in this
environment. Treat the UI as reviewed, not verified.

### PR-008 — mobile auth’s deactivation check was not tenant-scoped

`apps/web/src/lib/mobile-pharmacy-auth.ts` enforced deactivation with:

```ts
.from('pharmacy_user_settings')
.select('is_active')
.eq('profile_id', payload.sub)
.maybeSingle()
```

`pharmacy_user_settings` is unique on `(tenant_id, profile_id)`
(`pharmacy_user_settings_tenant_id_profile_id_key`), so a staff member who
belongs to two pharmacies has two rows. PostgREST answers `maybeSingle()` on
more than one match with `PGRST116` and a null body; the handler destructured
only `data`, so the error was discarded and `settings?.is_active === false`
never fired. **Deactivating that staff member at pharmacy B left them admitted
at both**, with a still-valid bearer token. The DB-side mirror of this check
(`pharmacy_assert_actor`) was already tenant-scoped, so the money RPCs were
never exposed — only the route gate.

Fixed by adding `.eq('tenant_id', tenantId)`, which the unique constraint makes
deterministic, and by destructuring `error` and logging it. A transient read
failure still fails open (locking every till out during a blip is worse than a
brief gap, and the RPC still refuses), but it is no longer silent.

The test file’s mock previously returned whatever row it was told to and could
not have caught this. It now stores `(profile_id, tenant_id, is_active)` rows,
applies the `eq()` filters, and returns `PGRST116` on multiple matches, which
is what PostgREST does. Two cases were added: the lookup filters on the caller’s
tenant, and a user deactivated in one pharmacy is refused while still active in
another. **Both fail when the tenant filter is removed** (mutation-tested).

19 tests pass across the three mobile-auth suites.

### PR-009 — the sales report mixed tax-inclusive and tax-exclusive totals

Found during the broader product pass, not one of the five claims.

`app/api/admin/reports/route.ts` folds POS sales and web/order sales into one
`transactions` array and sums `net_amount`. For POS rows the route
copied `pharmacy_pos_sales.total_amount` straight in — and that column is stored
**tax-inclusive**: `complete_pharmacy_sale` computes
`v_total := v_subtotal - v_discount + coalesce(p_tax_amount, 0)`
(`supabase/migrations/20261030140000_pharmacy_batch_selling_price.sql:349`).
So with VAT on, “Total Sales” already contained the VAT and the “Tax” card beside
it showed the same VAT again; a pharmacy could read revenue overstated by the
tax amount.

For order and Tally rows the same sum read `pharmacy_transactions.net_amount`
directly. That column does not mean one thing across writers — see PR-007 — so
on a row the edit route had rewritten the VAT landed in revenue a second time.

The same route also reported POS discounts as 0. `complete-sale` passes
`p_discount_total: 0` on purpose (“Line discounts live on rpc items;
p_discount_total must stay 0 or RPC double-counts”), so
`pharmacy_pos_sales.discount_total` is empty by design and the real discounts are
on `pharmacy_pos_sale_items.discount_amount`, which the report never read.

Fixed in the tree: POS rows are mapped to `total_amount - tax_amount` and
`pharmacy_transactions` rows to `total_amount - discount`, so every row is
summed on the same tax-exclusive, net-of-discount basis, and the summary adds
the POS line discounts to `totalDiscount`. `app/api/admin/reports/route.test.ts`
covers this in nine sales cases (of the file’s 16): net sales and tax are
1000/180 for a 1180 sale with 180 VAT, the line discount of 50 is counted, the
Tally-shaped and edit-shaped rows above are asserted, every table is filtered on
the caller’s tenant, and the `status = 'completed'` filters that keep voided
sales out are asserted. Before the change the first two cases fail (1180 and
0). The other cases belong to the two defects below and to the refunds report.

Two more defects turned up in the same read of the route:

- **Profit by category was always one bucket.** The bucket key was the literal
  `"Uncategorized"`, so every product's profit landed there even though the
  ledger query already selects `pharmacy_products.category`. Fixed to use the
  product's category (falling back to `Uncategorized`); `sale-ledger.ts`'s item
  type now declares `category`. Two cases cover it.
- **PR-010 — the purchases report returned the raw database error.**
  `{ error: error.message }` at 500 is the same leak PR-003 fixed in
  `/api/ready`; it now
  logs the error and returns `Failed to load purchases`. One case asserts the
  table name never reaches the client.

**Refunds report added (PR-007 follow-through).** `type=refunds` answers the
gap recorded in the previous revision: a refunded sale used to disappear from
the sales report without appearing anywhere. The report never sums a refund
into one "refunded" figure, because the three amounts are not the same money:
it reports `cashRefunded` (what left the till, via `decodePaidAmount`),
`receivableReversed` (credit-ledger `'refund'` rows, matched by
`pos-refund:<saleId>`), `refundedValue` (the sale totals), and per-row
`receivableUnposted` for a balance that was never in the ledger. Order refunds
(`pharmacy_transactions` with status `REFUNDED`) are counted separately as
`excludedOrderRefunds` with a note, since they are not POS sales. Four cases in
`reports/route.test.ts`.

Still not fixed, recorded: the inventory report body and the purchases success
path have no test beyond the error path.

### PR-011 — a tenant administrator could read and write every tenant's pharmacy rows

Found while preparing the tenant-isolation proof, not by a failing test: the
database would have passed every existing suite.

Nineteen policies — the eighteen `pharmacy_*_tenant_isolation` policies and
`pharmacy_notifications_own_or_admin` — were permissive policies of the shape

```sql
USING (tenant_id = (select tenant_id from profiles where id = auth.uid())
       OR (select is_admin from profiles where id = auth.uid()) = true)
```

`profiles.is_admin` marks a **tenant** administrator. Because the second branch
has no tenant predicate, it satisfies the policy for every row in every tenant.
Platform reach is a different flag (`profiles.role = 'platform_admin'`, exposed
as `public.is_platform_admin()`), and the newer pharmacy policies already use
it. This is the same defect class
`20261026130000_scope_admin_policies_to_tenant` repaired for the ten SEC-01
tables; the pharmacy tables were outside that scope in both the initial policy
set (`20260608135056_pharmacy_rls_policies.sql`) and the repair.

**Impact.** The anon key is public — it ships in the pharmacy bundle
(`apps/pharmacy/lib/supabase/client.ts`). Any authenticated user whose profile
carries `is_admin = true` could query PostgREST directly with their own JWT and
read or write another pharmacy's products, prices, cost prices, stock, suppliers,
purchase orders, customers, sales transactions, settings and audit log. The
primary data path is server-side with the service role and explicit tenant
filters, so the normal screens do not exploit it; the database was the only
thing standing between one tenant's administrator and another tenant's data,
and it was not standing.

**Repair (prepared, not applied).**
`supabase/migrations/20261102120000_pharmacy_policy_tenant_scope.sql` rewrites
all nineteen policies in one `do` block:

```sql
alter policy … to authenticated
  using      (tenant_id = public.current_tenant_id() or public.is_platform_admin())
  with check (tenant_id = public.current_tenant_id() or public.is_platform_admin())
```

`pharmacy_notifications_own_or_admin` keeps its own-row branch
(`profile_id = auth.uid()`) and gains the same tenant and platform branches.
`TO authenticated` is mandatory: `current_tenant_id()` cannot be executed by
`anon`, so a policy left at the implicit PUBLIC default would raise
`permission denied for function` for anonymous callers instead of denying
cleanly. The policies carried no `WITH CHECK` before, so writes were checked
against the read expression; making it explicit preserves that while scoping it.
The block fails closed: a missing expected policy, a policy still not
tenant-scoped, a PUBLIC/anon role, or any remaining pharmacy policy that tests
`profiles.is_admin` raises instead of leaving a partial repair. The canonical
snapshot carries the same nineteen policies, so `db-reset-fresh.sh` and a
migration replay produce the same database.

**Decision recorded.** A tenant administrator is assumed to be tenant-scoped,
matching the SEC-01 repair. An `is_admin` user who needs to work across
pharmacies must hold `role = 'platform_admin'`; widening the predicate back is
not the way to grant that.

**Evidence.** `scripts/pharmacy-policy-tenant-scope.test.mjs` (15 cases, wired
into `test:migration-integrity`) asserts statically that no pharmacy policy in
the snapshot tests `is_admin`, that every scoped policy is
`authenticated`-only with both a tenant and a platform branch and a
`WITH CHECK`, that the repair migration covers every policy name, that it fails
closed, that no later migration re-widens a policy, and that the effective
definition in replay order is the scoped one. (The suite was rewritten under
PR-012: the original six cases could not see `ALTER POLICY` at all.)
`lib/pharmacy-rls-tenant-isolation.integration.test.ts` (14 cases) is the
database-backed proof: a real `auth.admin.createUser` user per tenant signs in
with the anon key and exercises PostgREST under its own JWT. It asserts that a
tenant administrator sees only their tenant's products, cannot insert into
another tenant, cannot move a row into another tenant, can still write in their
own, that a platform administrator keeps cross-tenant reach, that an anonymous
caller reads zero rows cleanly, and that `pharmacy_customers` follows the same
rule. These seven cases are **NOT EXECUTED** here — they need PostgREST and
GoTrue, which this environment lacks — and a skipped run is not evidence.

### PR-012 — the remaining tenant-isolation gaps behind PR-011

PR-011 scoped nineteen policies to `current_tenant_id()`. Auditing the rest of
the surface — every pharmacy policy, the account columns those policies read,
the security-definer helpers, the API authorisation layer and the storage
bucket — found eight further defects. Full evidence, file/line citations and
reasoning are in
[SECURITY_TENANT_ISOLATION_AUDIT.md](./SECURITY_TENANT_ISOLATION_AUDIT.md);
this entry records them in the register.

| # | Defect | Severity |
|---|---|---|
| F1 | `public_invite_lookup` lets `anon` list every pending pharmacy invitation, including `invite_token` and `admin_email`; no application path used the policy | HIGH |
| F2 | `current_tenant_id()`, `is_platform_admin()` and `custom_access_token_hook` ignore `profiles.is_deleted`; `current_tenant_id()` also ignores `pharmacy_user_settings.is_active`, so a deactivated or archived account keeps RLS access | HIGH |
| F3 | Membership was one `profiles.tenant_id` pointer, not the set the application already models; a pharmacist at a second pharmacy read nothing there, and an `is_active = false` staff row withdrew nothing | HIGH |
| F4 | 27 pharmacy policies had no `TO` clause, so they applied to `PUBLIC` | MEDIUM |
| F5 | `pharmacy_receipt_reprints` and `pharmacy_sale_idempotency` had RLS enabled and zero policies | MEDIUM |
| F6 | Four policies implemented their own `profiles` subquery instead of calling a helper, none consulting `is_deleted` | MEDIUM |
| F7 | `profiles_update_own_or_platform` constrains no columns, so any JWT holder could `update profiles set role = 'platform_admin' where id = auth.uid()` and satisfy every platform bypass in the schema — the whole model defeated in one statement | HIGH |
| F8 | `pharmacy_assert_actor`'s profiles fallback accepted a deleted profile | LOW |

**Impact of F7.** This is the one that turns every other finding from
defence-in-depth into a live path: a tenant administrator cannot read another
tenant's rows through PR-011's policies, but they can make themselves a platform
administrator and then legitimately read them all. It also undoes
`20261026130000`'s SEC-01 scoping for the same reason.

**Repair (prepared, not applied).**

- `supabase/migrations/20261102130000_pharmacy_tenant_access_hardening.sql` —
  adds `public.pharmacy_caller_tenants()` (the set of tenants the caller may act
  in, excluding any tenant whose staff row is `is_active = false` or whose
  profile is deleted, `SECURITY DEFINER`, not executable by `anon`); makes
  `current_tenant_id()`, `is_platform_admin()` and the token hook reject deleted
  profiles; makes `pharmacy_assert_actor` refuse a deactivated actor; drops
  `public_invite_lookup` and revokes `anon` on `pharmacy_onboarding`; rewrites
  every pharmacy policy to `TO authenticated` with the caller-tenant predicate
  on both `USING` and `WITH CHECK`; gives the two unpolicied tables a policy;
  and self-checks fail-closed.
- `supabase/migrations/20261102130100_profiles_privileged_column_guard.sql` —
  a `BEFORE INSERT OR UPDATE` trigger on `profiles` refusing a user JWT (other
  than a platform administrator's) any change to `role`, `is_admin`,
  `platform_control_role`, `tenant_id`, `is_deleted`, `verification_status`,
  `hospital_id` or `department_id`. Requests with no JWT — service role,
  migrations, seeds — pass untouched, and no browser component writes
  `profiles`, so no legitimate flow is affected.

**Constraints deliberately not changed.** `complete_pharmacy_sale` must keep
accepting an actor whose tenant differs from `p_tenant_id`: the hospital
dispense route calls it with the clinician's id and the pharmacy's tenant, which
is a legitimate cross-tenant call. The mutation RPCs remain
`service_role`-only. Both facts are recorded in the audit so a future hardening
pass does not "fix" them into an outage.

**Evidence.** `scripts/pharmacy-policy-tenant-scope.test.mjs` was rewritten
(15 cases, all passing) because the original could not parse `ALTER POLICY` or
the `do`-loop's generated statements and therefore tested almost nothing of
either repair. It now replays the snapshot and every migration in filename
order, resolves each policy's *effective* definition per table, and asserts the
final state. `lib/pharmacy-rls-tenant-isolation.integration.test.ts` grew from 7
to 14 database-backed cases (two-pharmacy staff, deactivated staff, archived
profile, RPC denial with a no-write assertion, self-promotion, storage
isolation) — all **NOT EXECUTED** here.

---

### PR-013 — the access-hardening migration could not be applied to any fresh database

**Severity: HIGH — this was the first blocker in the cutover path. Repaired in
the tree on 2026-11-01; not applied to any real environment.** Found by
execution on a real engine (§5), not by reading.

`20261102130000_pharmacy_tenant_access_hardening.sql` ends with a fail-closed
self-check: no `pharmacy_%` policy may carry the `public` or `anon` role. Its
repair loop walks `v_policies`/`v_tables`
(`20261102130000_pharmacy_tenant_access_hardening.sql:229-290`). Five policies
created earlier by `20260921120000_pharmacy_purchases.sql:156-167` are not in
those arrays:

| Table | Policy | Created at |
|---|---|---|
| `pharmacy_purchases` | `pharmacy_purchases_tenant_isolation` | `20260921120000:161` |
| `pharmacy_purchase_items` | `pharmacy_purchase_items_tenant_isolation` | `20260921120000:161` |
| `pharmacy_purchase_idempotency` | `pharmacy_purchase_idempotency_tenant_isolation` | `20260921120000:161` |
| `pharmacy_purchase_attachments` | `pharmacy_purchase_attachments_tenant_isolation` | `20260921120000:161` |
| `pharmacy_supplier_returns` | `pharmacy_supplier_returns_tenant_isolation` | `20260921120000:161` |

That `do`-loop builds `create policy %I on public.%I for all using (...)` with
**no `TO` clause**, so all five default to `PUBLIC` and therefore include
`anon`. The hardening migration never aligns them, and its self-check then
aborts the whole file. Reproduced twice, with and without the harness's
assumed repair, on PostgreSQL 18.6:

```
FAIL 20261102130000_pharmacy_tenant_access_hardening.sql
     pharmacy policies still reachable by anon or PUBLIC:
     pharmacy_purchase_attachments.pharmacy_purchase_attachments_tenant_isolation,
     pharmacy_purchase_idempotency.pharmacy_purchase_idempotency_tenant_isolation,
     pharmacy_purchase_items.pharmacy_purchase_items_tenant_isolation,
     pharmacy_purchases.pharmacy_purchases_tenant_isolation,
     pharmacy_supplier_returns.pharmacy_supplier_returns_tenant_isolation
```

**Consequence, as measured before the repair.** On a fresh database built the
way `scripts/db-reset-fresh.sh` and CI's `db-acceptance` job build one, 41 of
the 42 post-cutoff migrations applied and this one rolled back. That job applies
each file with `psql -v ON_ERROR_STOP=1` under `set -euo pipefail`
(`.github/workflows/deploy.yml`), so a run over that tree stopped at
`20261102130000` and never reached the refund and RLS suites below — the abort
was a hard failure of the acceptance gate, not a skipped step. Every PR-012
repair lives in this file, so none of F2–F5 or F7 was in effect on any
environment created from that tree. The measured difference, as a signed-in
caller:

| Assertion | Before the repair | After the repair |
|---|---|---|
| a user with `pharmacy_user_settings` at a second pharmacy sees that pharmacy | **FAIL** — sees only their first tenant | PASS |
| an active `staff_scope_assignments` row grants that pharmacy | **FAIL** — granted nothing | PASS |
| a profile with `is_deleted = true` sees nothing | **FAIL** — still reads its tenant's rows | PASS |
| `pharmacy_caller_tenants()` exists, is `SECURITY DEFINER` with a pinned `search_path`, no `anon` EXECUTE | **FAIL** — the function is absent | PASS |
| no `pharmacy_%` policy is reachable by `anon` or `PUBLIC` | **FAIL** — 33 policies are | PASS |
| assertions across the isolation suite | 13/18 | 18/18 |
| migrations applied | 41/42 | 42/42 |

**Repair — made inside the migration, 2026-11-01.** Ten added lines: the five
table names appended to `v_tables` and their five `_tenant_isolation` policy
names appended to `v_policies`, in the same order, so the existing loop applies
the same `TO authenticated` + caller-tenant predicate as their 29 siblings. It
has to be this file: its self-check runs before any later migration would.
Re-measured afterwards on PostgreSQL 18.6 with no injected repair and no option
flags:

| Run | Result |
|---|---|
| `chain` | `42/42` applied, `outcomes: PASS`, exit 0 |
| `isolation` | `42/42`, `18/18` assertions, `outcomes: PASS`, exit 0 |
| `financial` | `42/42`, `44/44` assertions, `outcomes: PASS`, exit 0 (the suite held 18 assertions when this repair landed and has since grown; the original 18 all still pass) |
| `npm run db:history:check`, `npm run test:migration-integrity` | exit 0; 41 tests, 41 pass |
| `npm run verify:pharm-release` | `RELEASE_GATE=PASS`, 18/18 stages |

The runner no longer carries an assumed-repair path: it applies the migration
files exactly as they are, and an unknown option is rejected rather than
ignored. What remains open is not the defect but the application — this file,
like its siblings, has still been applied to no real environment.

**Was PR-013 applied anywhere before the repair? No.** Checked on 2026-11-01
rather than assumed:

| Check | Result |
|---|---|
| `git log --all -- supabase/migrations/20261102130000_pharmacy_tenant_access_hardening.sql` | no commits on any ref; `git status` reports it untracked (`??`) |
| `npm run db:history:check` | exit 0; the file is listed among migrations added since the baseline commit `19ef5d0`, with `lastCommit: null`; remote-ledger reconciliation is reported as `BLOCKED_OPERATOR_CONTROLLED`, because the checker never contacts a database |
| file digest | SHA256 `73175f008de53b5cd27ecf66a2d49298487a155f3d9ffd44cb84f2fe3cd1fbe9` — the same bytes the runner applied |
| transaction shape | one `begin; … commit;` block whose self-check raises, so any attempt rolls back whole; no database can hold the file half-applied |
| reachable environment | none: no PostgreSQL server binaries, no Docker daemon, no working Supabase CLI, nothing listening on 5432/54321/54322/6543, no database credentials in the environment (§5) |

A Supabase project is linked in `supabase/.temp/linked-project.json`; it was
deliberately not contacted. Because no environment records the file as applied,
the repair belongs in the file itself and **no forward repair migration is
required**. A forward migration would have had to fix five policies only in
databases that never ran the broken file, and would leave a fresh install
running the broken one.

**Also found, LOW — a PostgreSQL 18 portability issue.** `20261102120000:146`
and `:176` read `v_policies || 'pharmacy_notifications_own_or_admin'`. On
PostgreSQL ≤ 17 that resolves to the element-append operator; on 18 it resolves
to `anyarray || anyarray` and raises `malformed array literal`. It is harmless
where the file already applied, but it makes the migration non-portable to a
newer server. `|| 'pharmacy_notifications_own_or_admin'::text` selects the same
function on every version. The harness re-reads that one expression with the
cast and says so in its deviation list; the file itself is unchanged.

### PR-014 — the eleven-argument sale overload is still in every database

**Severity: LOW — latent, no current caller hits it.** Found while writing the
financial suite: a call naming fewer than twelve arguments fails with
`function public.complete_pharmacy_sale(...) is not unique`.

`20260703185455` created an eleven-argument `complete_pharmacy_sale` (through
`p_confirmed_by`). `20261030140000` added `p_idempotency_key` with a default,
which is a *different signature*; `create or replace` therefore left both in the
catalogue. Because the twelve-argument version's last parameter has a default,
any call supplying eleven or fewer arguments matches both.

All three application callers — `apps/pharmacy/app/api/admin/pos/complete-sale`,
`apps/web/src/app/api/mobile/pharmacy/pos/complete-sale` and
`apps/web/src/app/api/hospital/pharmacy/dispense` — name `p_idempotency_key`
explicitly, each with a comment saying why, so the shipped paths resolve to one
function. The exposure is any new caller that omits the key, and any raw-SQL
caller: PostgREST returns `PGRST203` rather than a sale.

**Repair — written and executed on the disposable engine.**
`supabase/migrations/20261102130200_complete_pharmacy_sale_single_overload.sql`
drops the eleven-parameter signature and aborts if more than one overload of the
name survives. On PostgreSQL 18.6 the drop leaves exactly one function, a
four-argument call now resolves instead of raising `is not unique`, and both
suites stay green (`42/42` migrations). It has **not** been applied to any real
environment.

---

## 4. What was executed

### Files changed in the working tree

152 paths: 69 tracked files modified (6,784 insertions / 561 deletions) and 83
untracked new files. Nothing is committed. The count moved from 98 earlier in
this sprint because PR-005/006/007 touched the receipt surfaces, the tax path,
the refund callers and both mobile credit-ledger screens, PR-011 added a repair
migration, a JWT proof suite, a policy contract test and the disposable
database harness, the Tally pass added the edition module, its tests and the
per-edition acceptance checklist, and this pass added the disposable-engine
runner, its setup note, the AC-9 disconnect test and the extended financial
suite. Grouped by area:

| Area | Paths | What is in it |
|---|---|---|
| `apps/pharmacy` | 71 | POS, settings, inventory, transactions and Tally-import pages; admin routes for inventory, settings, POS sales, reports, Tally upload/preview/extract/apply; the print-status endpoint and the print banner; `lib/pos/*`, `lib/tally/*` (extraction, chunks, consolidation, preflight, bridge client, `editions.ts` and its test, `disconnect.test.ts`); the refund/adjust RPC integration suite; `pharmacy-rls-tenant-isolation.integration.test.ts` (PR-011); `reports/route.test.ts` (PR-009) |
| `docs` | 17 | This file, the Tally runbooks, guides, acceptance criteria and evidence templates, and the new `TALLY_PRIME_ERP9_ACCEPTANCE.md`; `docs/deploy.md` |
| `apps/web` | 15 | Mobile POS catalogue, complete-sale and settings routes, the print-status route, `mobile-pharmacy-auth.ts` and its three suites (PR-008) |
| `apps/tally-bridge` | 11 | `bridge.mjs`, `cli.mjs`, preflight and check scripts, installer and bridge tests |
| `packages/db` | 11 | `pos-tax.ts`, `receipt-print.ts`, `inventory-rpc.ts`, `tally-xml-rows.ts`, `tally-normalise.ts` and their tests |
| `scripts` | 8 | `verify-pharm-release.mjs`, the RPC coverage and definition contract tests, `pharmacy-policy-tenant-scope.test.mjs` (PR-011), `db-tests/pharmacy-refund-rpc-rollback.sql`, `db-tests/run-pharmacy-db-harness.sh`, `db-tests/run-pharmacy-db-pglite.mjs` (the PostgreSQL 18.6 WASM runner: chain, isolation and financial modes) and `db-tests/PGLITE-SETUP.md` |
| `supabase` | 6 | `20261101090000_pharmacy_refund_and_adjust_rpcs.sql`, `20261101120000_pharmacy_refund_receivable_reversal.sql` (PR-007), `20261102100000_pharmacy_settings_tax_rate_precision.sql`, `20261102110000_pharmacy_line_level_tax.sql` (PR-006), `20261102120000_pharmacy_policy_tenant_scope.sql` (PR-011), `canonical_public_schema.sql` |
| `apps/app` | 10 | Mobile POS, credit-ledger, refunds and receipt screens; `lib/api.ts`; `lib/offline-store-core.ts`; `lib/pos-pricing.ts` + test (PR-006 mobile till); `lib/receipt-print-gate.ts` + test (PR-005 mobile print decision) |
| root | 1 | `package.json` (`test:tally`, `test:tally-bridge`, `test:pharmacy-print`, `test:pharmacy-tax`, `test:mobile-app`, `test:migration-integrity`) |

### Commands run (each executed here unless marked otherwise)

| Command | Result | Date |
|---|---|---|
| `node --import /tmp/claude-1000/ts-resolve.mjs --test packages/db/src/tally-xml.test.ts tally-xml-rows.test.ts tally-map.test.ts tally-normalise.test.ts` | 78 tests, 78 pass, 0 fail | 2026-11-01 |
| `node --import /tmp/claude-1000/ts-resolve.mjs --test packages/db/src/pharmacy-purchases.test.ts` | 18 tests, 18 pass | 2026-11-01 |
| `npx vitest run app/api/admin/pos/complete-sale/route.test.ts` | 32 tests, 32 pass (7 are the PR-006 server-tax cases) | 2026-11-01 |
| `node --import /tmp/claude-1000/ts-resolve.mjs --test packages/db/src/pos-tax.test.ts` | 12 tests, 12 pass | 2026-11-01 |
| `npx vitest run src/app/api/mobile/pharmacy/pos/complete-sale/route.test.ts` (in `apps/web`) | 10 tests, 10 pass (4 are the PR-006 cases) | 2026-11-01 |
| `npx vitest run app/api/admin/settings/route.test.ts` | 9 tests, 9 pass (percentage storage, column-overflow mapping, out-of-range refusal) | 2026-11-01 |
| `npm run test:workflow-safety` | 60 tests, 60 pass | 2026-11-01 |
| `npm run verify:pharm-release` (full gate) | **RELEASE_GATE=FAIL, exit 1** — 10 stages PASS, then `test:tally` could not start `tsx` (see §5) | 2026-11-01 |
| `npm run verify:pharm-release` (full gate, re-run after the PR-005 edits) | same 10 PASS / `test:tally` FAIL / `RELEASE_GATE=FAIL`; `EPERM` this time on `3144.pipe` — no stage regressed (see §5) | 2026-11-01 |
| `npm run verify:pharm-release` (full gate, after `test:tally` switched to the `node --import tsx` loader form) | **RELEASE_GATE=PASS, GATE_EXIT=0** — 14/14 stages PASS in one invocation; log `/tmp/claude-1000/gate-162724.log` (see §5) | 2026-11-01 |
| `npm run verify:pharm-release` (full gate, re-run over the post-PR-007 tree) | **RELEASE_GATE=PASS, GATE_EXIT=0** — 14/14 PASS; 1054 tests pass / 32 skip; log `/tmp/claude-1000/gate-164648.log` (see §5) | 2026-11-01 |
| `npx vitest run lib/pos/partial-payment.test.ts app/api/admin/refunds/route.test.ts app/api/admin/accounting/ageing/route.test.ts` | 18 tests, 18 pass (PR-007 callers) | 2026-11-01 |
| `npx vitest run app/api/admin/refunds/route.test.ts lib/pos/refund-amount.test.ts` | 18 tests, 18 pass (11 route + 7 allocation; two legacy-branch cases are new) | 2026-11-01 |
| mutation: the refund paid figure replaced by the bare line sum | 8 of those 18 fail; restored — file hash back to `9659f127…`, then 25/25 refund+accounting pass | 2026-11-01 |
| `npx vitest run app/api/admin/reports/route.test.ts` | 11 tests, 11 pass (4 are the new refunds-report cases) | 2026-11-01 |
| `npx vitest run lib/pharmacy-refund-rpc.integration.test.ts` | 17 tests **skipped** — no database; **not executed** (the five PR-007 cases are among them) | 2026-11-01 |
| `npm run build --workspace @synapse/pharmacy` (isolated re-run) | exit 0; 111/111 static pages | 2026-11-01 |
| `npx vitest run app/api/ready/route.test.ts` | 3 tests, 3 pass | 2026-11-01 |
| `npm run test:migration-integrity` | 19 tests, 19 pass (history 6, RPC coverage 3, refund contract 10) | 2026-11-01 |
| `npm run verify:pharmacy` | exit 0 — see §5 | 2026-11-01 |
| `npm run db:check` | 203 migration files OK | 2026-11-01 |
| `npm run db:check` (after the PR-007 migration) | 205 migration files OK | 2026-11-01 |
| `npx vitest run lib/pharmacy-refund-rpc.integration.test.ts` (in `apps/pharmacy`) | 12 tests skipped — no database available; **not executed** (includes concurrency, duplicate reversal, tenant isolation, recall safety, rollback) | 2026-11-01 |
| `npx tsc -p apps/pharmacy/tsconfig.json --noEmit` | exit 0 (re-run after the PR-005 edits: exit 0) | 2026-11-01 |
| `npx tsc -p apps/web/tsconfig.json --noEmit` | exit 0 | 2026-11-01 |
| `npx vitest run lib/pos/receipt-print.test.ts "app/api/admin/pos/sales/[id]/print-status/route.test.ts"` (in `apps/pharmacy`) | 22 tests, 22 pass (9 policy + 13 route), re-confirmed after the PR-005 edits | 2026-11-01 |
| `node --test scripts/pharmacy-refund-rpc-definitions.test.mjs scripts/pharmacy-rpc-coverage.test.mjs` | 17 tests, 17 pass (static definition/coverage guards — not a database run) | 2026-11-01 |
| `npx vitest run lib/pos/{sale-ledger,partial-payment,sale-validation,receipt-domain,fefo,fefo.allocate,inventory-rpc,cashier-session}` | 49 tests, 49 pass (7 files) | 2026-11-01 |
| `npx vitest run app/api/admin/{purchases,purchase-orders,refunds}/route.test.ts lib/accounting/voucher-types.test.ts app/api/admin/inventory/supplier-tenant.test.ts "app/api/admin/transactions/[id]/edit/route.test.ts"` | 39 tests, 39 pass | 2026-11-01 |
| `npx vitest run lib/api-auth.test.ts lib/api-auth.actor-gate.test.ts lib/pharmacy-context.test.ts app/api/admin/credit-ledger/route.test.ts` | 45 tests, 45 pass | 2026-11-01 |
| `npx vitest run app/api/admin/foreign-id-404.test.ts app/api/admin/inventory/bulk-upload/route.test.ts` | 6 tests, 6 pass | 2026-11-01 |
| `npx vitest run app/api/admin/reports/route.test.ts` | 7 tests, 7 pass (new suite: PR-009 ×6, PR-010 ×1) | 2026-11-01 |
| `npx tsc --noEmit -p apps/pharmacy` and `npx eslint … reports/route.ts reports/route.test.ts lib/pos/sale-ledger.ts --max-warnings 0` (after PR-009/PR-010) | both exit 0 | 2026-11-01 |
| `npm run test --workspace @synapse/pharmacy` (final, after PR-009/PR-010) | 100 files passed, 6 skipped; 1040 tests passed, 27 skipped of 1067; exit 0 | 2026-11-01 |
| `npm run test --workspace @synapse/pharmacy` (final, after PR-007 and the refunds report) | 101 files passed, 6 skipped; 1054 tests passed, 32 skipped of 1086; exit 0 — run as stage 10 of the gate (`/tmp/claude-1000/gate-164648.log`) | 2026-11-01 |
| `npx vitest run src/lib/mobile-pharmacy-auth` (in `apps/web`) | 19 tests, 19 pass (2 new for PR-008) | 2026-11-01 |
| `npm run build --workspace @synapse/pharmacy` (after the final edits) | exit 0 | 2026-11-01 |
| `npm run verify:web` | exit 0 | 2026-11-01 |
| `node --experimental-strip-types --test apps/app/lib/pos-pricing.test.ts` | 7 tests, 7 pass, exit 0 (PR-006 mobile till) | 2026-11-01 |
| `node --import tsx --test apps/app/lib/pos-pricing.test.ts apps/app/lib/purchase-draft.test.ts` | 11 tests, 11 pass, exit 0 — the runner `test:mobile-app` now uses | 2026-11-01 |
| `npm run test:mobile-app` (after `receipt-print-gate.test.ts` was added) | 17 tests, 17 pass, exit 0 | 2026-11-01 |
| `node --import tsx --test apps/app/lib/receipt-print-gate.test.ts` under a mutation (`decide` → `leave`) | 5 pass, **1 fail** — the suite catches a silently-skipped print decision; file hash `28306964…88107` restored afterwards and 6/6 green again | 2026-11-01 |
| `npx tsc --noEmit` (in `apps/app`) | exit 0 | 2026-11-01 |
| `npx expo export --platform android` (to a scratch dir) | exit 0 — proves Metro resolves the `packages/db/src/pos-tax` import from `apps/app` | 2026-11-01 |
| `npx vitest run apps/web/src/app/api/mobile/pharmacy/pos/products/route.test.ts` | 5 tests, 5 pass | 2026-11-01 |
| `npm run test:pharmacy-mobile-api` | 22 files, 160 tests, 160 pass, exit 0 | 2026-11-01 |
| `npm run export:android --workspace @synapse/app` | exit 0 | 2026-11-01 |
| `npm run lint --workspace @synapse/pharmacy` | exit 0 (`--max-warnings 0`) | 2026-11-01 |
| `npm run lint --workspace @synapse/web` | exit 0 (`--max-warnings 0`) | 2026-11-01 |
| `npm run db:history:check` | exit 0; `remoteReconciliation: BLOCKED_OPERATOR_CONTROLLED` (expected locally) | 2026-11-01 |
| `node --check scripts/verify-pharm-release.mjs` | syntax OK after the change below | 2026-11-01 |
| `npx vitest run app/api/admin/reports/route.test.ts` (after the sales-basis fix) | 16 tests, 16 pass (two new: Tally-shaped row 450/50, edit-shaped row 1900/100/342) | 2026-11-01 |
| mutation: the summed figure put back to raw `net_amount` | 1 fail — `expected 2242 to be 1900`; restored, hash `ef9d7137…2918`, 16/16 green again | 2026-11-01 |
| `npx vitest run lib/tally/editions.test.ts lib/tally/chunks.test.ts` | 70 tests, 70 pass (13 edition cases, including the executed bridge-table parity check) | 2026-11-01 |
| `npx vitest run app/api/admin/tally/` | 110 tests, 110 pass across 7 files (6 new edition cases in extract/preview routes) | 2026-11-01 |
| `npx tsc --noEmit` and `npx eslint lib/tally app/api/admin/tally app/portal/tally-import/page.tsx --max-warnings 0` (in `apps/pharmacy`) | both exit 0 | 2026-11-01 |
| `npx vitest run` (whole pharmacy workspace, after the edition work) | 103 files passed, 7 skipped; 1090 passed, 42 skipped of 1132; exit 0 | 2026-11-01 |
| `npm run verify:pharm-release` (final, over the whole tree including the edition work) | **RELEASE_GATE=PASS**, exit 0 — 17/17 stages in one invocation (see §5) | 2026-11-01 |
| `PGLITE_DIST=… node scripts/db-tests/run-pharmacy-db-pglite.mjs chain` | 42/42 migrations applied, exit 0 — PostgreSQL 18.6 (WASM), no injected repair, no option flags | 2026-11-01 |
| `… run-pharmacy-db-pglite.mjs isolation` | 42/42 applied, 18/18 assertions, exit 0 | 2026-11-01 |
| `… run-pharmacy-db-pglite.mjs financial` | 42/42 applied, 44/44 assertions, exit 0 | 2026-11-01 |
| the same runner and migrations in a scratch copy with the ten PR-013 lines removed | chain 41/42, isolation 13/18, financial fails the five policy assertions — the negative control; the real tree was not modified | 2026-11-01 |
| `npm run db:history:check` | exit 0; PR-013 listed with `lastCommit: null`; `remoteReconciliation: BLOCKED_OPERATOR_CONTROLLED` | 2026-11-01 |
| `npm run test:migration-integrity` | 41 tests, 41 pass, exit 0 | 2026-11-01 |
| `npx vitest run lib/tally/disconnect.test.ts` (in `apps/pharmacy`) | 4 tests, 4 pass — the AC-9 application-layer checks | 2026-11-01 |
| `npx tsc --noEmit` (in `apps/pharmacy`, after the disconnect test) | exit 0 | 2026-11-01 |
| `node --test src/*.test.mjs` (in `apps/tally-bridge`) | 127 tests, 126 pass, 1 skipped (Windows-only process launcher), 0 fail, exit 0 | 2026-11-01 |
| `npx vitest run` (whole `apps/pharmacy` workspace, with the disconnect test) | 105 files passed, 7 skipped; 1105 tests passed, 49 skipped of 1154; exit 0 | 2026-11-01 |
| `npx eslint lib/tally/disconnect.test.ts --max-warnings 0` | exit 0 | 2026-11-01 |
| `npm run verify:pharm-release` (final run, after the disconnect test and the documentation edits) | **RELEASE_GATE=PASS**, exit 0 — 18/18 stages; the pharmacy test stage reports 105 files and 1105 tests including `lib/tally/disconnect.test.ts`; log `/tmp/claude-1000/gate2.log` | 2026-11-01 |

`npm run test:tally` aborted here until the script was switched to the
`node --import tsx` loader form (§5); it now runs and passes inside the gate.
The four db suites it covers were also run directly and passed.

---

## 5. Verification runs

### `npm run verify:pharmacy` — 2026-11-01, exit 0

| Stage | Result |
|---|---|
| `type-check` (`tsc --noEmit`) | passed |
| `lint` (`eslint . --max-warnings 0`) | passed |
| `test:general` (vitest) | **97 files passed, 5 skipped**; **995 tests passed, 15 skipped** of 1010 |
| tally-bridge (`node --test`) | **126 passed, 1 skipped**, 0 failed of 127 |
| `build` (`next build`) | compiled successfully; 111/111 static pages generated |

Exit code 0. This was run against the working tree described in §4, including
the PR-001 and PR-003 changes.

**Superseded by the run below** once PR-005 and PR-006 landed; the numbers in
the table are the earlier tree.

### `npm run test --workspace @synapse/pharmacy` — 2026-11-01 (after PR-006 and the concurrency case)

`99 files passed, 6 skipped` of 105; `1032 tests passed, 25 skipped` of 1057;
exit 0, 50.1 s.

**Re-run after PR-009/PR-010 and the PR-005 edits:** `100 files passed, 6
skipped` of 106; `1040 tests passed, 27 skipped` of 1067; **exit 0**.

**Re-run after PR-007 and the refunds report:** `101 files passed, 6 skipped`
of 107; `1054 tests passed, 32 skipped` of 1086; **exit 0**. The extra file is
`app/api/admin/accounting/ageing/route.test.ts` (3 cases); the other 11 new
passing cases are in `partial-payment` (5), `refunds/route` (2) and
`reports/route` (4), and the five new skips are the PR-007 cases in the refund
integration file. The six skipped files are the database-backed suites below,
all of which need `SUPABASE_URL`/`SUPABASE_SERVICE_ROLE_KEY` and skip
themselves without them — they are not counted as passing. `lint`
(`--max-warnings 0`) and `tsc --noEmit` were re-run after the final edits to
both `apps/pharmacy` and `apps/web`: all four exit 0.

### The database-backed tests that skip without a database

They skip themselves unless `SUPABASE_URL`/`NEXT_PUBLIC_SUPABASE_URL` and
`SUPABASE_SERVICE_ROLE_KEY` are present; the RLS suite additionally needs
`NEXT_PUBLIC_SUPABASE_ANON_KEY` to mint a user JWT:

- `lib/pharmacy-refund-rpc.integration.test.ts` (20 — eight are the PR-007 and
  reconciliation-hardening cases)
- `lib/pharmacy-rls-tenant-isolation.integration.test.ts` (14 — PR-011 plus the
  caller-tenant hardening: two-pharmacy staff, deactivated staff, archived
  profile, RPC denial, self-promotion, storage isolation)
- `lib/platform/hospital-tenant-isolation.test.ts` (6)
- `lib/platform/hospital-rbac-negative.integration.test.ts` (5)
- `lib/platform/hospital-billing-payment.integration.test.ts` (1)
- `lib/platform/hospital-dispense-idempotency.integration.test.ts` (1)
- `lib/platform/malaria-golden-journey.integration.test.ts` (1)
- `lib/pos/sale-ledger.local.test.ts` (1)

They skip honestly — they are not reported as passing. The only place they run
is CI's `db-acceptance` job, which provisions a disposable stack
(`.github/workflows/deploy.yml`: snapshot, then every migration after
`SNAPSHOT_CUTOFF=20260920190000`, ACL assertion, then
`npm run test --workspace @synapse/pharmacy` with the local URL and keys
exported). The local release gate cannot run them, so **Gate F cannot be
`PASS` on local evidence alone**; record them as `NOT TESTED` here until either
CI has run against this tree or the harness below has been authorised and run.
PR-013 used to abort `20261102130000` during that job's migration step, so
these suites were not reached; the migration is repaired, but the job has still
not been run against this tree.
The WASM-engine run in §5 is what executes the policy logic in the meantime; it
is a different engine and a different caller model, not a substitute for the
Supabase run.

#### How the 49 skips classify — 2026-11-01

The pharmacy suite ran here as `1,166 tests: 1,117 passed, 0 failed, 49
skipped` (113 files, 7 of them fully skipped). None of the 49 is a deferred
TODO, a disabled assertion or a test that cannot run anywhere:

| Class | Count | Which | Blocked by |
|---|---|---|---|
| Environment-blocked, mandatory for cut-over | 34 | the 20 refund/stock RPC cases and the 14 RLS-under-JWT cases | no disposable Supabase stack on this host (Docker unreachable) |
| Environment-blocked, not cut-over critical | 14 | the six hospital-tenancy, five RBAC, one billing, one dispense, one malaria case | same |
| Environment-blocked, local-engine only | 1 | `sale-ledger.local.test.ts` | needs `LOCAL_API_URL` + `LOCAL_SERVICE_ROLE_KEY` |
| Optional | 0 | — | — |
| Genuinely skipped (deferred work) | 0 | — | — |

Two things follow, and neither may be softened in the report:

1. **The refund semantics these 34 tests would exercise are proven on a real
   engine at SQL level** — §5's `financial` run executes the reversal path
   through `reverse_pharmacy_sale` itself and checks the cash handed back, the
   receivable reversal, store credit, the cap on what can be reversed, the
   unposted-receivable case, the voided-still-refunded case, the supplier
   balance and till reconciliation. That is the same function, a different
   caller.
2. **They are still not executed here.** The PostgREST/JWT path, the
   JS-client argument marshalling, the concurrency cases (two refunds in
   parallel, "last unit" stock) and the RLS behaviour under a real GoTrue token
   remain `NOT TESTED` until CI's `db-acceptance` job or the harness runs
   against this tree.

#### The suites can no longer reach production by accident

`apps/pharmacy/lib/platform/test-db-guard.ts` now refuses to load when
`SUPABASE_URL` names the production project (`qfqakzmjatszisuqjwon`), because
these suites insert fixtures and an operator shell that already exports the
deployment's credentials would otherwise write to the live database. It throws
rather than skipping, so the run fails loudly instead of reporting a clean skip.
Executed here: with the production URL and a dummy key in the environment,
`npx vitest run lib/platform/ci-db-gate.test.ts` exits 1 at collection with the
refusal, and no connection is attempted. `ci-db-gate.test.ts` also asserts the
refusal literal still equals the one in
`scripts/e2e-acceptance-isolation.mjs`. A disposable project, a loopback
PostgREST and an unset environment all continue to run as before.

### Database-backed suites — exact commands (prepared, not run)

`scripts/db-tests/run-pharmacy-db-harness.sh` mirrors CI's `db-acceptance` job
on the developer's machine. It is **prepared and not executed** here: it
provisions containers and drops the public schema inside them, which the
standing instruction reserves for an explicit per-run authorisation. It
refuses to start without `SYNAPSE_PHARM_DB_HARNESS=1` in the same invocation,
refuses if any `supabase_*` container is already running (so a developer's local
database is untouched), starts the stack from a throwaway workdir with its own
`project_id` (separate containers and volumes), applies the snapshot and
post-snapshot migrations, asserts the function ACL surface, refuses any
non-loopback `API_URL`, and stops the stack with `--no-backup` on exit.

```bash
SYNAPSE_PHARM_DB_HARNESS=1 bash scripts/db-tests/run-pharmacy-db-harness.sh
```

Individual suites:

```bash
SYNAPSE_PHARM_DB_HARNESS=1 bash scripts/db-tests/run-pharmacy-db-harness.sh refund
SYNAPSE_PHARM_DB_HARNESS=1 bash scripts/db-tests/run-pharmacy-db-harness.sh rls
SYNAPSE_PHARM_DB_HARNESS=1 bash scripts/db-tests/run-pharmacy-db-harness.sh concurrency
SYNAPSE_PHARM_DB_HARNESS=1 bash scripts/db-tests/run-pharmacy-db-harness.sh reconciliation
```

**Why it did not run here — the exact prerequisite, re-probed 2026-11-01:**

| Probe | Result |
|---|---|
| `postgres`, `initdb`, `pg_ctl` on PATH | absent |
| anything listening on 5432/5433 | nothing |
| `psql`, `pg_dump` | present, but no server to reach |
| `docker` client | present |
| `docker info` / `docker ps` | `permission denied … /var/run/docker.sock` (socket owned by `nobody:nogroup`) |
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `DATABASE_URL` in the environment | all unset |

The only database configuration on this machine is in the root `.env.local`,
which names the hosted project; connecting to it is prohibited by the standing
instruction (never connect to, or mutate, any remote or shared database), so it
is not a route to these tests either. `supabase start`, which both CI and the
harness use, needs a working Docker daemon.

**External prerequisite:** a machine or runner with either (a) Docker daemon
access for the invoking user, or (b) a PostgreSQL 15+ server plus PostgREST,
GoTrue and Storage — then run the harness (or CI's `db-acceptance` job) against
this tree. Nothing else in the repository can supply it.

The equivalent manual sequence, if the harness is not wanted, is exactly CI's:

```bash
supabase start -x studio,imgproxy,edge-runtime,logflare,vector
PGPASSWORD=postgres bash scripts/db-reset-fresh.sh
for f in $(ls supabase/migrations/[0-9]*_*.sql | sort); do
  v="$(basename "$f" | cut -d_ -f1)"
  [[ "$v" > 20260920190000 ]] && PGPASSWORD=postgres psql -h 127.0.0.1 -p 54322 -U postgres -d postgres -v ON_ERROR_STOP=1 -q -f "$f"
done
PGPASSWORD=postgres psql -h 127.0.0.1 -p 54322 -U postgres -d postgres -v ON_ERROR_STOP=1 -f scripts/db-tests/assert-function-acl-surface.sql
eval "$(supabase status -o env | sed -e 's/^API_URL=/SUPABASE_URL=/' -e 's/^SERVICE_ROLE_KEY=/SUPABASE_SERVICE_ROLE_KEY=/' -e 's/^ANON_KEY=/NEXT_PUBLIC_SUPABASE_ANON_KEY=/')"
(cd apps/pharmacy && npx vitest run lib/pharmacy-refund-rpc.integration.test.ts lib/pharmacy-rls-tenant-isolation.integration.test.ts)
node --test scripts/db-tests/pharmacy-concurrency.local.test.mjs
```

What each suite proves, and its current status:

| Suite | Proves | Status |
|---|---|---|
| `lib/pharmacy-refund-rpc.integration.test.ts` | refund amount is cash actually paid; credit reversal capped at the ledger and at the balance; `receivable_unreversed` and `receivable_unposted`; retry idempotency; stock restored once; FEFO adjustment refuses stock drift; `SALE_NOT_FOUND` vs `PRODUCT_NOT_FOUND` | written, **NOT EXECUTED** |
| `lib/pharmacy-rls-tenant-isolation.integration.test.ts` | a signed-in tenant administrator cannot read, insert or move rows across tenants, and can still write at home; platform administrators keep cross-tenant reach; anonymous callers read nothing; a two-pharmacy pharmacist sees both and a third none; a deactivated staff row withdraws access despite the home pointer; an archived profile loses it; an authenticated caller cannot execute a mutation RPC and no row is written; a JWT subject cannot promote itself to platform administrator; a user JWT cannot download a private-bucket object | written, **NOT EXECUTED** |
| `scripts/db-tests/pharmacy-concurrency.local.test.mjs` | last unit sold twice concurrently yields one sale; concurrent refunds yield one refund | written, **NOT EXECUTED** |
| `npm run db:reconciliation:check` | accounting/inventory evidence check over the repository | static; see §5 |
| migration replay | the whole `supabase/migrations` chain applies cleanly on the snapshot base, and the PR-011 repair runs on a replayed database | written, **NOT EXECUTED** |

The harness does not seed inventory reconciliation fixtures: the inventory
ledger check (`db:reconciliation:check`) is a repository evidence check, not a
live money-path test. A live reconciliation test — sales vs till vs ledger vs
stock after a day of synthetic transactions — remains external work (§6).

### Release gate strengthened

`scripts/verify-pharm-release.mjs` called itself a deterministic release gate
but omitted four checks that CI already runs. Added:

- `db:history:check`
- `test:migration-integrity` (history tests + the new RPC-coverage guard)
- `test:workflow-safety` (60 node tests covering the CI gate, deploy
  provenance and the Vercel build gate)
- `test:tally` (Tally import parsers + bridge tests)

### The `test:tally` abort, and its fix — 2026-11-01

The first full runs of `verify:pharm-release` in this environment reported
`RELEASE_GATE=FAIL, exit 1` with 10 stages PASS and `test:tally` unable to start
at all:

```
Error: listen EPERM: operation not permitted /tmp/claude-1000/tsx-1000/3142.pipe
    at Server.setupListenHandle [as _listen2] (node:net:2368:21)
    at createIpcServer (node_modules/tsx/dist/cli.mjs)
  code: 'EPERM', syscall: 'listen'
```

`tsx`'s **CLI** binds a Unix socket under `$TMPDIR/tsx-<uid>/` to receive the
compiled module graph from its worker, and the sandbox denies `listen` on that
path. Every other stage was unaffected.

That was diagnosed as a harness problem rather than a product problem: the
socket is only the CLI's IPC channel, and the loader form does not open one.
`test:tally` in the root `package.json` now runs

```
node --import tsx --test packages/db/src/tally-xml.test.ts …
```

instead of `tsx --test`. The same four suites, the same runner, no IPC socket —
so the check is no longer silently unexecuted on a sandboxed host. The two
earlier FAIL runs, and the `tee`-masked exit code that went with them, are kept
here as history: a piped gate shows `tee`'s status, not the gate's.

### Full gate run — 2026-11-01, `RELEASE_GATE=PASS`, exit 0

Run in full, in the background, after the fix, with stdout/stderr redirected to
a log file and the exit status appended (`GATE_EXIT=$?`) rather than piped
through `tee`. Log: `/tmp/claude-1000/gate-162724.log` (205 KB). The gate's own
summary, verbatim:

```
  PASS     db:check (migration integrity)
  PASS     db:history:check (migration history)
  PASS     test:migration-integrity (history + RPC coverage)
  PASS     test:workflow-safety (CI gate + deploy provenance)
  PASS     lint @synapse/web
  PASS     lint @synapse/pharmacy
  PASS     type-check @synapse/web
  PASS     type-check @synapse/pharmacy
  PASS     type-check @synapse/app
  PASS     test @synapse/pharmacy (unit/domain/authz/contracts)
  PASS     test:tally (Tally import parsers + bridge)
  PASS     build @synapse/pharmacy
  PASS     verify:web (type-check + Next build)
  PASS     expo export --platform android

RELEASE_GATE=PASS
GATE_EXIT=0
```

All 14 stages executed and passed in one invocation — no stage was run
separately to fill a gap, and the script did not stop early. From the log:
`Test Files 100 passed | 6 skipped (106)`, `Tests 1040 passed | 27 skipped
(1067)` for `@synapse/pharmacy`; pharmacy build 111/111 static pages; web build
308/308; `expo export --platform android` produced one Hermes bundle (6.5 MB)
plus `metadata.json`. `test:tally` PASS in 5,978 ms.

That run predates the final PR-007 caller and refunds-report edits. **The gate
was then re-run in full over the post-PR-007 tree** (log
`/tmp/claude-1000/gate-164648.log`), again as a background job with the exit
status appended, and again produced the same 14 `PASS` rows, `RELEASE_GATE=PASS`
and `GATE_EXIT=0`. Its numbers: `Test Files 101 passed | 6 skipped (107)`,
`Tests 1054 passed | 32 skipped (1086)`; `db:check` 205 migration files OK;
pharmacy build 111/111 static pages in 146 s; web build 308/308 pages; one
Android Hermes bundle (6.5 MB). So the passing result is not a stale snapshot of
an earlier tree — it covers the refund changes described in §3.

**What this proves and what it does not.** It proves the gate script runs to
completion and every configured check passes on this tree. It does **not**
change the 32 skipped tests: they are still database-backed suites that skip
without credentials, so Gate B and Gate F remain `PARTIAL`. `expo export` is a
JS bundle, not an APK — the APK is built by EAS and was not built here.

### Final gate run — the whole tree, including the Tally edition work

The gate was run once more at the end of this pass, over every code and test
change described here (only prose in this file and the architecture note was
touched afterwards, and no gate stage reads documentation), as a background job
with its exit status inspected (`exited with code 0`), not piped through `tee`.
The script's own summary, verbatim:

```
  PASS     db:check (migration integrity)
  PASS     db:history:check (migration history)
  PASS     test:migration-integrity (history + RPC coverage)
  PASS     test:workflow-safety (CI gate + deploy provenance)
  PASS     lint @synapse/web
  PASS     lint @synapse/pharmacy
  PASS     type-check @synapse/web
  PASS     type-check @synapse/pharmacy
  PASS     type-check @synapse/app
  PASS     test @synapse/pharmacy (unit/domain/authz/contracts)
  PASS     test:tally (Tally import parsers + bridge)
  PASS     test:pharmacy-print (shared receipt-print recorder)
  PASS     test:pharmacy-tax (shared tax engine + receipt tax split)
  PASS     test:pharmacy-mobile-api (mobile pharmacy BFF routes)
  PASS     build @synapse/pharmacy
  PASS     verify:web (type-check + Next build)
  PASS     expo export --platform android

RELEASE_GATE=PASS
```

17 stages, all executed in one invocation. The pharmacy suite on this tree, run
directly before the gate: `Test Files 103 passed | 7 skipped (110)`, `Tests
1090 passed | 42 skipped (1132)` — the 42 skips are the database-backed suites
listed in §2 and the local-Postgres cases; they are not passes. The edition work
is inside those numbers: `lib/tally/editions.test.ts` (13 tests, executed,
including one that imports and runs the real bridge module and compares its
install-path table and classifier against the portal's), four new route cases in
`extract/route.test.ts` and two in `preview/route.test.ts`. Node 24.22.2 / npm
11.19.1 again — the supported 22.x / 10.9.7 pair has still not produced a
recorded run here (§5, item 6).

### Gate run after the VAT, refund and mobile-runner work — 2026-11-01

Run as a background job over the tree containing the products-route VAT tests,
the refund allocation helper and its route cases, and the `test:mobile-app`
loader fix. Exit code inspected directly (`exited with code 0`); output
redirected to a file for reading, not piped through `tee`.

Verbatim summary:

```
  PASS     db:check (migration integrity)
  PASS     db:history:check (migration history)
  PASS     test:migration-integrity (history + RPC coverage)
  PASS     test:workflow-safety (CI gate + deploy provenance)
  PASS     lint @synapse/web
  PASS     lint @synapse/pharmacy
  PASS     type-check @synapse/web
  PASS     type-check @synapse/pharmacy
  PASS     type-check @synapse/app
  PASS     test @synapse/pharmacy (unit/domain/authz/contracts)
  PASS     test:tally (Tally import parsers + bridge)
  PASS     test:pharmacy-print (shared receipt-print recorder)
  PASS     test:pharmacy-tax (shared tax engine + receipt tax split)
  PASS     test:pharmacy-mobile-api (mobile pharmacy BFF routes)
  PASS     test:mobile-app (mobile till discount allocation)
  PASS     build @synapse/pharmacy
  PASS     verify:web (type-check + Next build)
  PASS     expo export --platform android

RELEASE_GATE=PASS
```

18 stages, one invocation, 542 s total. Node 24.22.2 / npm 11.19.1 — the
supported 22.x / 10.9.7 pair still has no recorded run here.

Two details about this run that the block above does not show:

- The `test:mobile-app` **label** is the one the script carried before this
  pass. `scripts/verify-pharm-release.mjs` is parsed once at start-up, so the
  label edit made while the gate was running is not reflected in this output.
  The stage's behaviour is unaffected: the gate spawns `npm run test:mobile-app`
  at that moment, and the log records the command it actually ran —
  `node --import tsx --test apps/app/lib/pos-pricing.test.ts
  apps/app/lib/purchase-draft.test.ts` — with `tests 11 / pass 11 / fail 0 /
  skipped 0`. That is the current definition of the script.
- Pharmacy suite totals: `Test Files 104 passed | 7 skipped (111)`,
  `Tests 1099 passed | 49 skipped (1148)`. The 49 skips are the database-backed
  and local-Postgres cases enumerated in §2; **a skipped test is not a pass and
  none of them counts as evidence about the database.**

### Gate run after the mobile receipt-print gate — 2026-11-01

This run supersedes the one above and matches the tree exactly: the stage label
now reads `test:mobile-app (mobile till pricing, purchase draft, receipt print
gate)` and the stage ran all three mobile files (17 tests, 0 skipped). Exit code
`0`, inspected directly; 413 s total; Node 24.22.2 / npm 11.19.1.

```
  PASS     db:check (migration integrity)
  PASS     db:history:check (migration history)
  PASS     test:migration-integrity (history + RPC coverage)
  PASS     test:workflow-safety (CI gate + deploy provenance)
  PASS     lint @synapse/web
  PASS     lint @synapse/pharmacy
  PASS     type-check @synapse/web
  PASS     type-check @synapse/pharmacy
  PASS     type-check @synapse/app
  PASS     test @synapse/pharmacy (unit/domain/authz/contracts)
  PASS     test:tally (Tally import parsers + bridge)
  PASS     test:pharmacy-print (shared receipt-print recorder)
  PASS     test:pharmacy-tax (shared tax engine + receipt tax split)
  PASS     test:pharmacy-mobile-api (mobile pharmacy BFF routes)
  PASS     test:mobile-app (mobile till pricing, purchase draft, receipt print gate)
  PASS     build @synapse/pharmacy
  PASS     verify:web (type-check + Next build)
  PASS     expo export --platform android

RELEASE_GATE=PASS
```

Pharmacy suite: `Test Files 104 passed | 7 skipped (111)`,
`Tests 1099 passed | 49 skipped (1148)`. The 49 skips remain the database-backed
and local-Postgres cases; none of them is evidence about the database.

### Gate run after the sales-report basis fix — 2026-11-01

Re-run over the tree that carries the PR-009 `total_amount - discount` change
and its two new cases. Exit code `0` inspected directly; 18/18 stages PASS;
436 s of stage time; Node 24.22.2 / npm 11.19.1.

```
  PASS     db:check (migration integrity)
  PASS     db:history:check (migration history)
  PASS     test:migration-integrity (history + RPC coverage)
  PASS     test:workflow-safety (CI gate + deploy provenance)
  PASS     lint @synapse/web
  PASS     lint @synapse/pharmacy
  PASS     type-check @synapse/web
  PASS     type-check @synapse/pharmacy
  PASS     type-check @synapse/app
  PASS     test @synapse/pharmacy (unit/domain/authz/contracts)
  PASS     test:tally (Tally import parsers + bridge)
  PASS     test:pharmacy-print (shared receipt-print recorder)
  PASS     test:pharmacy-tax (shared tax engine + receipt tax split)
  PASS     test:pharmacy-mobile-api (mobile pharmacy BFF routes)
  PASS     test:mobile-app (mobile till pricing, purchase draft, receipt print gate)
  PASS     build @synapse/pharmacy
  PASS     verify:web (type-check + Next build)
  PASS     expo export --platform android

RELEASE_GATE=PASS
```

Pharmacy suite: `Test Files 104 passed | 7 skipped (111)`,
`Tests 1101 passed | 49 skipped (1150)` — two more passing cases than the run
above, the two the sales-basis fix added. The 49 skips are unchanged and are
still **not** evidence about the database.

### Gate run after the PR-014 overload migration — 2026-11-01

Re-run over the tree that adds
`supabase/migrations/20261102130200_complete_pharmacy_sale_single_overload.sql`
and the extended database-test runner. `RELEASE_GATE=PASS`, exit 0, all
eighteen stages PASS, including `db:check` (migration integrity),
`db:history:check` and `test:migration-integrity` — so the new file is a
well-formed member of the chain as the repository's own checks see it.

Pharmacy suite re-run on its own for the counts: `Test Files 104 passed |
7 skipped (111)`, `Tests 1101 passed | 49 skipped (1150)` — identical to the
previous run, which is expected: the change is SQL plus a standalone script,
with no TS test added. The 49 skips are still **not** evidence about the
database; the database evidence is the `chain` / `isolation` / `financial`
runs below, executed on PostgreSQL 18.6.

Re-run after the PR-013 repair (ten lines added to
`20261102130000_pharmacy_tenant_access_hardening.sql`, the runner's assumed
repair removed): `RELEASE_GATE=PASS`, exit 0, the same 18 stages. `db:check`
reports 210 migration files; `db:history:check` and `test:migration-integrity`
(41 tests) pass over the edited file.

### Final gate run — after the AC-9 disconnect test — 2026-11-01

`npm run verify:pharm-release` over the tree that adds
`apps/pharmacy/lib/tally/disconnect.test.ts` and the documentation edits:
**`RELEASE_GATE=PASS`, exit 0, 18/18 stages**. The pharmacy test stage reports
`Test Files 105 passed | 7 skipped (112)` and
`Tests 1105 passed | 49 skipped (1154)`, and its output names
`lib/tally/disconnect.test.ts (4 tests)`, so the new guard ran inside the gate
rather than beside it.

An earlier run of the same gate this pass, started before the file existed,
also reported `RELEASE_GATE=PASS` with 104 files / 1101 tests. Both are recorded
because the difference is exactly the new file: four tests and one file.

The 49 skips are unchanged and are still **not** evidence about a database;
the database evidence is the `chain` / `isolation` / `financial` runs above,
all on PostgreSQL 18.6 (WASM).

### Broader product testing — what executed, 2026-11-01

The sprint asked for the whole product, not only the five claims. This is what
actually ran against the working tree (`npx vitest run …` in
`apps/pharmacy`), grouped by area. Every count below is from a run in this
session; nothing is inferred from a file existing.

| Area | Suites executed | Result | Limits |
|---|---|---|---|
| POS sales | `complete-sale/route.test.ts` (32), `sale-validation` (16), `sale-ledger` (1), `receipt-domain` (8), `fefo.allocate` (7) | 64 pass, 0 fail | Route-level mocks; no browser, no database |
| Refunds | `refunds/route.test.ts` (11) + `lib/pos/refund-amount.test.ts` (7) + the 17 cases in `pharmacy-refund-rpc.integration.test.ts` | 18 pass; **17 skipped — not executed** | Route tests cover the cash/credit split, the unposted-balance report and both legacy-branch amounts, against mocks; the database refund money path is still unproven end to end (PR-007) |
| Customer ageing | `accounting/ageing/route.test.ts` (3, new) | 3 pass | A refund settles a receivable like a repayment; refund-oldest-first ordering; over-settlement leaves nothing open. Route-level mocks only |
| Inventory adjustments | `inventory-rpc` (7), `fefo` (7), `inventory/supplier-tenant` (8), `inventory/bulk-upload/route` (4) | 26 pass, 0 fail | The `inventory/route.ts` adjustment endpoint has no direct route test; adjustment correctness rests on the unexecuted DB suite |
| Purchases / receiving | `purchases/route` (2), `purchase-orders/route` (7), `packages/db pharmacy-purchases` (18, run earlier) | 27 pass | Receiving stock movement itself is DB-side and unexecuted |
| Supplier balances | `inventory/supplier-tenant` (8) | 8 pass | Tenant scoping only; no balance/reconciliation arithmetic is covered anywhere |
| Customer credit | `credit-ledger/route` (8), 8 credit references in the complete-sale suite | 8 pass | No dedicated credit-limit or ageing test |
| Partial payments | `partial-payment` (9) | 9 pass | `decodePaidAmount` is now the single shared parse of the `PAID:` tag, used by the refunds route, the reports route and (in SQL) the refund RPC; the fallbacks are asserted against the trigger's own rules |
| Returns | same as refunds | 4 pass / 10 skipped | — |
| Reports | `app/api/admin/reports/route.test.ts` (16) | 16 pass | Covers the sales report, profit-by-category, the purchases error path and the new refunds report; the inventory branch and the purchases success path are still untested. PR-009 and PR-010 were found here and fixed. A refunded sale still does not appear in the sales report as a negative line — it is reported in the refunds report instead, which is where the cash/credit split lives |
| Permissions | `api-auth` (16), `api-auth.actor-gate` (18), `pharmacy-context` (3) | 37 pass | Route-level. RLS is executed separately, on the WASM engine rather than through these suites (§5) |
| Multi-tenant isolation | `supplier-tenant` (8), `foreign-id-404` (2), `mobile-pharmacy-auth` (19, in `apps/web`, run earlier) | pass | The vitest DB-backed isolation suites skip without credentials; the PostgreSQL-engine isolation run (18 assertions) is the executed evidence |
| Audit trails | Asserted inside the refund-definition and print-status suites | static/pass | No database run confirms rows are actually written |
| Backups / recovery | none | **not defined** | The release runbook covers deploy rollback only; no backup, restore or point-in-time recovery procedure is written down or tested here |
| Fresh DB reconstruction | `run-pharmacy-db-pglite.mjs chain` | **executed** — `42/42`, exit 0 | The canonical snapshot and all 42 post-cutoff migrations rebuild on PostgreSQL 18.6 (WASM) from the tree as it stands, with no injected repair |

Two accounting observations from reading the report route:

1. Refunds set the sale to `voided`, and the sales report filters
   `status = 'completed'`, so a refunded sale stops counting as revenue and no
   negative line replaces it in that report. This is not a wrong total — net
   revenue is right — but it leaves a period's refund activity invisible in the
   sales view. The `type=refunds` report now carries it, split into cash
   refunded and receivable reversed; the sales report deliberately still
   excludes voided sales rather than double-counting the reversal.
2. There is no supplier-balance or customer-ageing report at all, so
   "supplier balances" cannot be reconciled from inside the product yet.

### TallyPrime and Tally.ERP 9 as separate targets — this pass

Both editions are now recorded and disclosed end to end; neither is claimed as
verified, because no real installation has been read.

| What changed | Where | Evidence |
|---|---|---|
| One module states each edition's install paths, gateway setup, extraction requirements and review caveats; `verifiedOn` and `evidenceUrl` are `null` for both, and tests assert that a date cannot stand without an existing record naming that date and edition | `apps/pharmacy/lib/tally/editions.ts` | 14 tests executed |
| The manifest records `edition` (`prime` / `erp9` / `unknown`) and rejects any other value; absent on older manifests | `lib/tally/chunks.ts` | round-trip and rejection tests executed |
| The bridge's edition reaches the server on `begin`; every extract response and `ai_mapping` write carries the disclosure and its warnings; the same happens on the preview path | `app/api/admin/tally/[id]/extract/route.ts`, `.../preview/route.ts` | route tests executed (4 new cases: known edition, normalised spelling, unknown edition, reload from the saved manifest) |
| The review screen names the edition under the numbers and shows the unverified warning | `app/portal/tally-import/page.tsx` | type-checked and linted; **not driven in a browser** |
| The portal's install-path table is pinned to the bridge's own table and classifier by test — the real bridge module is imported and executed, not copied | `lib/tally/editions.test.ts` | executed |
| Per-edition external acceptance checklist, including what each run must capture to set `verifiedOn` | `docs/pharmacy/TALLY_PRIME_ERP9_ACCEPTANCE.md` | document only |
| Both editions added as named targets in the architecture note | `docs/pharmacy/TALLY_MIGRATION_ARCHITECTURE.md` | document only |

What this does **not** establish: that TallyPrime or Tally.ERP 9 emits the field
set the parser expects. The suite's XML is a contract fixture. The checklist is
the only route to that evidence, and it has not been run — the external table
below still governs.

### The migration chain and tenant isolation on a real PostgreSQL engine — 2026-11-01

Engine: `PostgreSQL 18.6 (PGlite 0.5.11) on wasm32-unknown-emscripten`, loaded
from the cached npm tarball into a scratch directory. No repository dependency
was added. The base is `supabase/bootstrap/canonical_public_schema.sql`,
followed by every migration after `SNAPSHOT_CUTOFF = 20260920190000`, exactly as
`run-pharmacy-db-harness.sh` orders them.

```bash
PGLITE_DIST=… node scripts/db-tests/run-pharmacy-db-pglite.mjs chain
PGLITE_DIST=… node scripts/db-tests/run-pharmacy-db-pglite.mjs isolation
```

| Run | Result |
|---|---|
| `chain` | `42/42` applied, `outcomes: PASS`, exit 0 |
| `isolation` | `42/42` applied, `18/18` assertions pass, `outcomes: PASS`, exit 0 |

Those are the post-repair numbers, measured on the tree with the five purchase
policies added to the hardening migration (PR-013). Before that repair the same
two commands reported `41/42` and `13/18`, with the five missing access rules
and 33 anon-reachable policies listed as the failures — the suite was shown to
discriminate before it was made to pass.

**The policy delta is bounded.** The hardening migration creates exactly two
policies (`pharmacy_receipt_reprints_tenant_isolation`,
`pharmacy_sale_idempotency_tenant_isolation`), drops exactly one
(`public_invite_lookup` on `pharmacy_onboarding`, deliberately: it let `anon`
enumerate invitations, and the migration revokes `anon` on that table in the
same block), and every other change is `alter policy … to authenticated` with
the caller-tenant predicate. So applying it removes no access rule that any
signed-in pharmacy user relied on; it narrows the role list and the predicate.

The eighteen assertions cover the dimensions Priority 2 names: cross-tenant
reads and writes; a tenant administrator confined to its own pharmacy; a
multi-pharmacy pharmacist through `pharmacy_user_settings` and again through
`staff_scope_assignments`; an inactive staff row and a withdrawn scope
assignment each removing access; a deleted profile reading nothing; `anon`
reading nothing; a JWT subject unable to write its own `role` or `tenant_id`;
`pharmacy_caller_tenants()` being `SECURITY DEFINER` with a pinned
`search_path` and no `EXECUTE` for `anon`; a caller reading no row of
`storage.objects`; and a platform administrator still reaching every tenant.

The five assertions that fail without the repair fail the way a real caller
would experience it — a second-pharmacy pharmacist seeing only their first
tenant, a deleted profile still reading tenant B, a scoped worker granted
nothing, the helper absent entirely, and 33 pharmacy policies still held by
`anon` — so the suite discriminates rather than passing vacuously.

Deviations, printed by the runner itself: no Supabase stack; `pgvector` absent
so `"public"."vector"(n)` becomes `text` and two `ivfflat` indexes are skipped;
one migration is re-read with an explicit `::text` cast for PostgreSQL 18.

### The sale, tax and ledger contract on a real engine — 2026-11-01

```bash
PGLITE_DIST=… node scripts/db-tests/run-pharmacy-db-pglite.mjs financial
```

`42/42` migrations applied from the tree as it stands, `44/44` assertions pass,
`outcomes: PASS`, exit 0.
Every expected figure is computed in the runner from the sale inputs — line
quantities, prices, discount, the 18% rate, batch costs — and compared with what
the database returns. Nothing is read out of the database to form its own
expectation.

| What was exercised | Independently expected | Result |
|---|---|---|
| two-line sale, one standard-rated and one exempt | subtotal 3500, discount 100, taxable 1900, tax 342, total 3742 | matches the RPC result and the stored row |
| line-level tax | standard row taxes its net-of-discount base; exempt row has zero base and zero tax | matches |
| journal balance | debits = credits = total + discount + COGS = 5942 | matches |
| output VAT, revenue, discount, inventory | 342, 3500, 100, 2100 | each posted to its own account |
| caller's tax figure | any figure disagreeing with the server by more than 0.05 | `TAX_MISMATCH` refusal |
| idempotency key replay | same `sale_id`, one sale row, one journal | matches |
| a short-argument sale call | one `complete_pharmacy_sale` overload, so the call resolves (PR-014) | matches |
| a line spanning two batches | one row per batch, each taxed on its own rounded base; total 1179.99 | matches |
| partly paid sale (`PAID:2000` of 2242) | cash 2000, receivables 242, journal balanced | matches |
| reversal | every batch quantity restored; reversal journal mirrors the sale so the pair nets to zero | matches |

#### Refund, receivable, credit, purchase, supplier and till paths

The same run now carries 26 further assertions, all on a one-line sale whose
figures the runner derives itself (subtotal 1900, tax 342, total 2242):

| Scenario | Independently expected | Result |
|---|---|---|
| fully-credit sale | receivables debit 2242, cash 0 | matches |
| refund of a fully-credit sale | no cash returned; `receivable_reversal` 2242; customer balance 0; ledger rows `credit` (`pos-sale:<id>`) and `refund` (`pos-refund:<id>`) | matches; the reversal mirrors the receivable, so every account nets to zero |
| part-paid sale (1000 of 2242) | cash 1000, receivables 1242 | matches |
| refund of a part-paid sale | 1000 returned in cash, 1242 reversed | matches |
| part-repaid sale (400 repayment, then refund) | `credit_balance_after` −400 (store credit), ledger `credit`/`repayment`/`refund` at 2242/1842/−400 | matches |
| receivable posted short (ledger 500 against 1242 owed) | reversal 500, `receivable_unreversed` 742 | matches |
| receivable never posted | `receivable_unposted` true, outstanding = sale total, sale `voided` | matches |
| received purchase (subtotal 1000, tax 180, paid 380) | INVENTORY 1000, INPUT_VAT 180, CASH credit 380, ACCOUNTS_PAYABLE credit 800, journal balanced | matches |
| supplier payment of the 800 balance | AP debit 800, cash credit 800, AP nets to zero | matches |
| till: cash sale | event applied, replay refused `DUPLICATE`, no `NO_CASH` | matches |
| till: refund and totals | cash payment 2242, cash refund 500, expected drawer 2242, two events | matches |
| five purchase-table policies | exactly one policy per table, role list exactly `{authenticated}`, both `USING` and `WITH CHECK` name `pharmacy_caller_tenants()`, `anon` and `authenticated` cannot select or write | matches |

**Negative control.** The purchase-policy assertions were shown to discriminate:
a scratch copy of the runner and migrations with the ten PR-013 lines removed
reports the five policies still reachable by `anon` and drops to `41/42` chain
and `13/18` isolation. The real tree was not modified to produce that.

**What this does not establish.** Concurrency. PGlite holds one connection, so
the `concurrency` suite (last-unit oversell, concurrent refunds) cannot run and
is not claimed. PostgREST/GoTrue HTTP behaviour and the production PostgreSQL
major version are equally unproven. The `pharmacy_transactions.net_amount`
normalisation lives in the report route, not the database; it is covered by the
route's unit tests and by the contract recorded above, not by this run.

One contract gap surfaced while writing these assertions and is recorded rather
than repaired: `pharmacy_purchases.balance` and `payment_status` are written by
the purchase route
(`apps/pharmacy/app/api/admin/purchases/[id]/route.ts:146`), not by a trigger.
A direct SQL update to `amount_paid` leaves the stored balance stale. The
scenario above therefore receives the purchase through the same transition the
route performs. Whether to move that arithmetic into the database is a product
decision, not something to change silently under a test pass.

### The disconnect test (AC-9) — the layer this repository can execute

`apps/pharmacy/lib/tally/disconnect.test.ts` was written this pass. It exists
because AC-9 is the criterion that separates a migration from an extraction, and
until now nothing in the repository tested it by that name.

| Test | What it executes | Result |
|---|---|---|
| import-graph guard | every non-test `.ts`/`.tsx` file under `apps/pharmacy`, outside the four Tally surfaces (`lib/tally`, `app/api/admin/tally`, `app/portal/tally-import`, `components/tally`), is scanned for an import naming `tally`; the only permitted specifier is the pure string predicate in `lib/tally/types` | zero offenders |
| surface guard | the I/O modules (`bridge-command`, `extraction`, `live-extraction`, `apply`, `cutover`, `reconcile`) are found by file name and must sit inside an allowed surface | holds; if one moves, the guard above cannot go quiet over its new location |
| kill switch | `tallyCutoverEnabled` returns false for an explicit `"false"`, false for a production default, true only when nothing disables it | matches |
| a sale with the bridge off | `POST /api/admin/pos/complete-sale` through the real route handler, `SYNAPSE_TALLY_CUTOVER_ENABLED=false`, and `fetch` replaced by a spy that throws on any call | 200; RPC called with the server-computed tax; **zero** outbound requests |

`npx vitest run lib/tally/disconnect.test.ts` → 4/4 passed. `npx tsc --noEmit`
in `apps/pharmacy` → exit 0. The guard's sensitivity was checked separately:
`@/lib/tally/extraction` and `@/lib/tally/bridge-command` are rejected,
`@/lib/tally/types` is allowed.

The structural reason this holds: the portal never calls the bridge. The Windows
bridge pushes to a portal upload URL, and the only Tally information the
operating routes read is a note string (`isTallyMirrorNote`) that marks an
imported row read-only. There is no `fetch` in any non-test file under
`lib/tally`. `apps/web` — which serves the mobile BFF, including the mobile
complete-sale route — contains no import of a Tally module at all (grep, not a
guard; the guard above covers `apps/pharmacy` only).

**What this does not prove — and must not be quoted as proving.** AC-9's six
steps are: sign in, complete a sale, record a purchase, watch stock update,
render the migrated period, and confirm no screen waits on Tally. The sale
(step 2) ran through its real handler; the purchase and stock movement (steps
3-4) ran in SQL in the financial suite; steps 1, 5 and 6 need a browser on the
client's PC with the bridge stopped. **Those three have not been performed, so
AC-9 does not pass and no migration counts.**

### Cut-over hardening pass — 2026-11-01 23:01, `RELEASE_GATE=PASS`, exit 0

Four changes landed in this pass, each with an executed check:

| Change | Why | Executed evidence |
|---|---|---|
| `TallyEditionProfile.evidenceUrl` added; `editionDisclosure` exposes it | A `verifiedOn` date with no acceptance record is a claim without evidence | `lib/tally/editions.test.ts` 14/14; the new test fails if the date and the record disagree, if the record is missing, or if it does not name the date and edition label |
| `test-db-guard.ts` refuses the production project | These suites insert fixtures; an operator shell exporting the deployment's credentials would write to the live database | with the production URL and a dummy key set, `ci-db-gate.test.ts` exits 1 at collection with the refusal and no connection is attempted; unset or disposable URLs are unchanged |
| `scripts/report-pharmacy-skips.mjs` + `test:pharmacy-skips` gate stage | vitest exits 0 when a suite skips itself, so a coverage loss could arrive as a green gate | classifier 8/8; run against the real suite it prints the 49 skips as eight declared `environment-blocked` files and exits 0; an undeclared skip, an invalid class and a pending-count mismatch each exit 1 |
| `PHARMACY_WINDOWS_ACCEPTANCE.md` + runner skip reasons (earlier in this pass) | Operational acceptance must be runnable and its non-runs visible | `test:workflow-safety` 83/83; operations layer reports 11 skipped with `NOT RUN — WINDOWS HOST REQUIRED` in the Playwright JSON |

Full gate, in this working tree, `npm run verify:pharm-release`
(`/tmp/claude-1000/gate-225438.log`), 19/19 stages `PASS`:

| Stage | Result |
|---|---|
| db:check / db:history:check / test:migration-integrity | PASS — 205 files; 54 tests |
| test:workflow-safety | 83/83 |
| lint + type-check (web, pharmacy, app) | PASS |
| test @synapse/pharmacy | 106 files passed, 7 skipped; **1,117 passed, 49 skipped** of 1,166; plus `fefo` 3/3 |
| test:pharmacy-skips | 49 skips, all declared |
| test:tally | parsers 78/78; bridge 126/127 passed, 1 skipped (Windows-only process launcher) |
| test:pharmacy-print / tax / mobile-api / mobile-app | 11, 23, 160, 17 — all pass |
| build @synapse/pharmacy, verify:web, expo export android | PASS |

Database engine re-runs in the same pass, all on **PostgreSQL 18.6 (PGlite
0.5.11), WASM** — not Supabase, not a native server:

| Mode | Result |
|---|---|
| `chain` | 42/42 post-cutoff migrations applied, exit 0 |
| `isolation` | 18/18 checks, exit 0 |
| `financial` | 44/44 checks, exit 0 — including the fully-credit, part-paid and part-repaid refunds, the receivable cap, the unposted receivable, supplier balance and till reconciliation |

`scripts/db-tests/run-pharmacy-db-pglite.mjs concurrency` does not exist: a
single-connection engine cannot prove the two-concurrent-refunds or last-unit
oversell cases, and those stay unproven. The PostgREST/JWT suites stay
`NOT TESTED` (see §5).

### Why no native PostgreSQL or Supabase run happened — the exact blocker

Probed on 2026-11-01, in this environment:

| Probe | Result |
|---|---|
| `postgres`, `pg_ctl`, `initdb` | absent (only the `/usr/bin/psql` client is installed) |
| `docker info` | exit 1 — `permission denied while trying to connect to the docker API at unix:///var/run/docker.sock` |
| `supabase --version` | exit 1, printing a minified bundle rather than a version; the CLI at `~/.supabase/bin/supabase` cannot start |
| listening ports | nothing on 5432, 54321, 54322 or 6543 |
| environment | no `SUPABASE_*`, `DATABASE_URL` or `PG*` variable set |

No production or shared credential was used, and the linked project in
`supabase/.temp/linked-project.json` was not contacted.

**What an operator with the right access must do**, in order:

1. Provide a Docker daemon the current user can reach (or PostgreSQL 15/17
   server binaries plus a disposable cluster).
2. `supabase start` in this repository, which applies nothing by itself.
3. Export `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` for that **local**
   stack and run
   `SYNAPSE_PHARM_DB_HARNESS=1 bash scripts/db-tests/run-pharmacy-db-harness.sh`.
   That is the only path that executes the refund/adjustment suite, the
   concurrency suite and the PostgREST-level RLS suites; it also re-applies the
   chain to a second engine, which is the "supported second run" the mandate
   asks for.
4. Record the run's output beside this file; until then those suites are
   NOT EXECUTED, and the WASM results above stay separate from them.

### Cut-over race fix, post-cut-over refusals and telemetry proof — 2026-11-02 00:19, `RELEASE_GATE=PASS`, exit 0

Four changes landed in this pass, each with an executed check. The gate below
ran after every source and test edit; only documentation changed while it was
running, and no gate stage reads documentation.

| Change | Why | Executed evidence |
|---|---|---|
| Apply route re-reads the session **under the lease** and refuses stale state | The row was read before the lease was taken. A request that waited out a concurrent apply could re-run a completed cut-over, or overwrite an interrupted one's checkpoint with an empty progress | `apply/route.test.ts` 46/46, including three new tests: completed-under-lease replays `alreadyComplete`; an interrupted import whose status moved is refused with `TALLY_STATE_CHANGED`; a manifest replaced while waiting is refused; each asserts no `applyChunk`, no session update, and claim→release RPC order |
| The lease mock now mirrors `claim_pharmacy_tally_cutover_apply` | The mock returned `acquired` for any row, but the SQL returns `invalid_session` unless `source_system = 'Tally'`. The old "Sage" test asserted a 200 that production could never return | That test now expects 404 `TALLY_SESSION_NOT_FOUND` and asserts no stage plan is loaded and no chunk is applied |
| Post-cut-over refusals are executable tests, not just present code | Preview, mapping and extract all refuse once a cut-over is complete, but nothing proved it | `preview/route.test.ts` 18/18, `mapping` and `extract` suites — each refuses with 409 `TALLY_CUTOVER_COMPLETE` and writes nothing |
| Pageview scrubbers redact the credential in a link path | `scrubPageview` and the inline bootstrap dropped query and fragment but kept `/reset-password/<token>`, `/invite/<token>` and `/invite/facility/<token>` — the token would have reached Vercel Analytics in production | `events.test.ts` 20/20, including a test that *executes* the generated inline script and feeds it a token path; both scrubbers redact to `[token]` |

Full gate, in this working tree, `npm run verify:pharm-release`
(`/tmp/claude-1000/gate-final3.log`), **19/19 stages `PASS`, `RELEASE_GATE=PASS`,
`GATE_EXIT=0`**:

| Stage | Result |
|---|---|
| db:check / db:history:check / test:migration-integrity | PASS — 54/54 migration-integrity tests |
| test:workflow-safety | 83/83 |
| lint + type-check (web, pharmacy, app) | PASS |
| test @synapse/pharmacy | 108 files passed, 7 skipped (115); **1,171 passed, 49 skipped, 0 failed** of 1,220; plus `fefo` 3/3 |
| test:pharmacy-skips | 1,171 passed, 49 skipped, 0 failed — every skip declared and classified |
| test:tally | parsers 78/78; bridge 126/127 passed, 1 skipped (Windows-only process launcher) |
| test:pharmacy-print / tax / mobile-api / mobile-app | 11/11; 23 node + 18 vitest; 22 files, 160 tests; 17/17 |
| build @synapse/pharmacy, verify:web, expo export android | PASS |

The pharmacy total moved from 1,163 to **1,171 passed** (+8), matching the eight
new tests exactly: three apply-route races, one each for preview/mapping/extract,
and two telemetry. Skips are unchanged at 49.

**Telemetry, proven in a real browser and not merely in code.** With the dev
server started under `NEXT_PUBLIC_VERCEL_INSIGHTS=1`, the checked-out page had
`window.va` and `window.si` as functions, one queued entry each, both loader
scripts requested, the inline bootstrap present, and a registered `beforeSend`
that returned `http://localhost/login` for a URL carrying `?token=…` and
`/reset-password/[token]` for a reset link. With the flag unset, nothing was
installed. Both loaders returned the local 404 page, which is the exact
distinction this section must keep: **the code integration works; no production
data was collected, because no production deployment was visited.**

**Vercel account actions remain unexecuted.** The precise list, the team-id
mismatch between `.vercel/project.json` and `scripts/sync-vercel-projects.mjs`,
the two held Hobby cron slots, and the unverified costs are recorded in
`VERCEL_PLATFORM_ENABLEMENT.md` ("Precise action list"). No Vercel API was
called to prepare it.

---

## 6. Next actions

1. **Run the refund/adjustment suite against a disposable database.** The
   migration and snapshot mirror are in the tree and the static contract is
   green; `apps/pharmacy/lib/pharmacy-refund-rpc.integration.test.ts` (12 cases:
   recorded total, duplicate reversal, concurrency, recall safety, cross-tenant
   refund, cross-tenant adjustment, overshoot, missing batch, correction + audit,
   FEFO history, rollback + retry, missing reason) must execute before Gate B can
   move past `PARTIAL`. **None of the twelve has run.** Their database
   behaviour is no longer wholly unobserved: the five refund/credit scenarios in
   §5 exercise `reverse_pharmacy_sale` directly and pass. What remains is the
   RPC through PostgREST, the duplicate/concurrent and rollback cases, and the
   authorisation cases — none of which one PGlite connection or a mocked client
   can produce.
2. **The two reconstruction tests are now partly executed.** (A) fresh install
   from `canonical_public_schema.sql` plus every migration in order runs on the
   WASM engine and reports `42/42`, exit 0, after PR-013 was repaired inside
   `20261102130000` and the runner's assumed-repair path removed. (B) replay
   from the supported baseline has not been attempted; it needs a real Supabase
   stack. (A) is the stronger half — it is the path `db-reset-fresh.sh` and
   CI's `db-acceptance` job use — but it is still a different engine from
   Supabase's.
3. **Exercise PR-005 in a browser.** Open the POS against a disposable database,
   complete a sale with `mandatory_receipt_print` on, and confirm: the prompt
   cannot be dismissed silently — including with **Escape**, which bypassed it
   until this turn's fix; “Printer unavailable” writes `print_failed = true` and
   a `POS_RECEIPT_PRINT_FAILED` audit row; a requested print leaves
   `print_failed = false`, leaves `printed_at` **null**, and writes a
   `POS_RECEIPT_PRINT_REQUESTED` row; reprinting from Transactions creates no
   new sale and does record an attempt. `window.print()` still proves nothing
   about paper — the sprint’s rule holds.
4. **VAT: line-level tax is implemented, and unverified in a browser.**
   `20261102110000_pharmacy_line_level_tax.sql` adds the classification, rate,
   base and tax to every `pharmacy_pos_sale_items` row, makes
   `complete_pharmacy_sale` compute them from `pharmacy_settings` and
   `pharmacy_products.vat_category` instead of trusting the caller, and sets the
   header from the sum of the rows with a `TAX_MISMATCH` refusal beyond a
   five-cent disagreement. `20261102100000_pharmacy_settings_tax_rate_precision.sql`
   widens the rate storage. The migration and the TypeScript tax helpers are
   statically tested; **the SQL side has not executed against a database**, and
   the new product-classification control in the inventory dialogs has not been
   driven in a browser. The sales report now sums every source on one
   tax-exclusive, net-of-discount basis (`total_amount - discount` for till and
   order rows, `total_amount - tax_amount` for POS rows) and is unit-tested on
   that basis, but it has never been run against real rows (PR-007, PR-009).
5. Confirm GitHub branch protection requires the CI `verify` job on `main`;
   `docs/deploy.md` now says CI is the gate, and that is only true if the branch
   is protected.
6. Re-run `npm run verify:pharm-release` on the supported Node 22.x/npm 10.9.7
   pair and in CI. It exited zero here on Node 24.22.2/npm 11.19.1 (§5); the
   supported pair has not produced a recorded run.

### External tests still required (nothing in this repository can supply them)

| Area | Evidence needed |
|---|---|
| Tally company discovery | One real Tally Prime and one ERP 9 instance: the bridge’s company list matches `Gateway of Tally → Company Info` exactly, including renamed and multi-company setups |
| Edition identification | On each edition, `/status`, `/companies` and the portal's review screen must agree on `prime` / `erp9`; an `unknown` for a correctly installed copy fails detection. Run the checklist in `TALLY_PRIME_ERP9_ACCEPTANCE.md` per edition and fill in its evidence file |
| Opening/closing balances | Balances-only cut-over against a real company, with the operator reconciling every closing figure to Tally’s own Stock Summary |
| Voucher extraction | A full `Day Book` export for a known range, compared line-for-line against a manual voucher count from Tally — not a parse-success check |
| Reconciliation | Extract twice for the same period and confirm identical counts and totals; then compare against Tally’s own report totals |
| Resume/retry | Kill the bridge mid-extraction and resume; confirm no voucher is duplicated or lost, and that the range bookkeeping matches |
| Windows installation | The packaged installer, the six setup screens, the three Start Menu shortcuts and UAC elevation, on a real Windows host — reviewed from code and static tests only |
| Network isolation | Tally’s HTTP gateway reachable on loopback only; confirm the bridge cannot be reached from another machine on the LAN |
| Migration persistence | A completed apply survives a server restart and a portal redeploy; staged rows and the applied plan are not lost |
| Disconnect independence (AC-9) | With the bridge stopped and the client PC unreachable: sign in, complete a sale, record a purchase, watch stock update, render migrated-period reports, and confirm no screen waits on Tally. Two layers now execute (§5): the import graph is proven closed to the Tally importer, and a sale completes through its handler with every outbound request poisoned. The browser steps — sign-in, reports, "no screen waits" — and a completed apply of real data are still required, so the criterion does not pass |

Tally remains read-only throughout. No real client data is imported to produce
any of this.

### Remaining critical/high defects

| Item | Severity | Why it is still open |
|---|---|---|
| PR-007 — partial/credit refunds | High | Code fixed in tree (tendered cash refunded, receivable reversed by a `'refund'` ledger row in the same RPC) and route/unit tests pass, but the five database cases that would observe it have not executed. The residual risk is now “unproven”, not “known wrong” |
| PR-002 / Gate B — RPC evidence | Blocker for release confidence | Sale, per-line tax, journal posting, partial payment and reversal are observed on a real engine (44/44, §5), including stock restoration on reversal, an idempotent replay, and the refund, receivable, purchase, supplier and till paths. `FOR UPDATE` contention and exactly-once under concurrency remain argued from the code, not observed — one connection cannot exercise them, and the duplicate/concurrent cases have not run through PostgREST |
| PR-005 — receipt printing | High | Web enforcement was tightened (Escape no longer bypasses it) and the mobile receipt now gates every exit on a print decision, but no browser has driven the web flow, no phone has run the mobile one, and physical output is not knowable from either surface by design |
| Refunds report coverage | Medium | The `type=refunds` report exists and is tested against mocks; it has never run against real rows, and it reports POS refunds only (order refunds are counted, not itemised) |
| `pharmacy_transactions.net_amount` basis | Low — **resolved for the report** | The column means different things across writers (Tally import: pre-tax; edit route: `total - discount + tax`), so the sales report no longer sums it and uses `total_amount - discount` instead (PR-007, PR-009). Other readers of the column — sale history display, the edit route itself, order refunds — still see whichever meaning their writer left. The one-query audit in PR-007 lists how many historical rows went through the edit route; it does not change the report |
| Gates C/D/E — Tally and Windows | Blocker for that migration | Not exercised at all; see the external table above |
| Gate F — RLS/RBAC | High | The vitest isolation suites (18 cases: 6 tenant-isolation, 5 RBAC-negative, 7 pharmacy RLS) still skip without credentials. The equivalent proof executed on the WASM engine instead: 18 assertions, 18/18 with the repair and 13/18 without it, so the gap PR-011 found was real and the repair closes it on that engine. Not proven: the same behaviour through PostgREST/GoTrue |
| PR-011 / PR-012 — pharmacy tenant isolation | High | Repair executed against a real engine (§5) and shown to close 18/18 access rules that fail 5/18 without it; the 14-case JWT proof still has not run, and neither migration has been applied to any real environment |
| `apps/app/lib/*.test.ts` runner | Low — **resolved** | The suite needs the `tsx` loader: under `node --experimental-strip-types --test` its extensionless imports (`../../../packages/db/src/pharmacy-purchases` → `./inventory-rpc`) raise `ERR_MODULE_NOT_FOUND`. Under `node --import tsx --test` both mobile files run green (11 tests), so `test:mobile-app` now uses that loader and covers `purchase-draft.test.ts` too — previously a file that had never executed. Note the `tsx` **binary** cannot start in this sandbox (`EPERM` on `/tmp/claude-1000/tsx-1000/*.pipe`); the `node --import tsx` form is the one that works |

### Recommended next action

**Run the disposable harness, then the skipped suites.** The stack it needs is
now reproducible locally:

```bash
SYNAPSE_PHARM_DB_HARNESS=1 bash scripts/db-tests/run-pharmacy-db-harness.sh
```

That provisions a separate Supabase stack, applies the snapshot plus every
post-snapshot migration (including the PR-011 policy repair), and executes the
refund, RLS, concurrency and reconciliation suites. It is the only way Gates B
and F move past `PARTIAL`, and the only way the PR-011 repair stops being a
static claim. The release gate itself does not need a database —
`RELEASE_GATE=PASS` was recorded on 2026-11-01 once `test:tally` stopped needing
the `tsx` CLI (§5) — but a green gate over skipped database tests is not
evidence about the database. CI's `db-acceptance` job runs the same suites on
every push and pull request to `main`; a local run is what makes it evidence
before then.

---

## 7. Final acceptance — the ten questions

The Windows/Tally acceptance phase ends on ten questions. They are answered
here against executed evidence only; "the code looks right" is not an answer.

| # | Question | Answer | Evidence |
|---|---|---|---|
| 1 | Can it be logged into and operated from a Windows computer? | **NOT TESTED** | The bridge is written, built and statically reviewed on Linux; no Windows host has run it, and the installer has never been executed |
| 2 | Which Windows browser tests passed? | **None** | No browser on any platform has driven the portal, POS or migration review; route and unit tests only |
| 3 | Is physical printing verified? | **No** | `window.print()` is invoked and the audit row is written from mocks; no paper output has been observed, on Windows or anywhere. Both surfaces now require an explicit print decision — web at the prompt, mobile at every exit from the receipt — but neither has been driven on real hardware (PR-005) |
| 4 | Is TallyPrime verified? | **No** | No Tally instance is reachable; XML parsing, mapping and bridging are unit-tested, which is not the same claim |
| 5 | Is Tally.ERP 9 verified? | **No** | Same as 4, independently: the ERP 9 path has its own checklist (`TALLY_PRIME_ERP9_ACCEPTANCE.md`) and no edition has produced a `verifiedOn` date |
| 6 | Has a full rehearsal passed? | **No** | No rehearsal has been executed: no Supabase stack (only the in-process engine), no Tally company, no Windows install, no apply |
| 7 | Does the pharmacy operate with Tally closed? | **PARTIAL — AC-9 does not pass** | Proven this pass: no operating module can reach the Tally importer, and a sale completes through its handler with the cut-over switch off and every outbound request poisoned (§5). Not proven: AC-9 steps 1, 5 and 6 in a browser with the bridge stopped, or any of it after a real apply. Nothing observed yet justifies calling the system Tally-independent |
| 8 | What blocks a first cutover? | **Five blocks** | (a) the PR-011/PR-012/PR-013/PR-014 migrations are written, executed on a disposable WASM engine and still applied nowhere real; (b) the Supabase-stack suites (refund RPC, concurrency, PostgREST-level RLS) have not run — the engine proves policy logic, not the HTTP path; (c) no real Tally Prime or ERP 9 instance has been exercised, so balances are unreconciled; (d) the Windows bridge and installer have never run on Windows; (e) the disconnect test's browser half — and any run against applied data — has not been performed |
| 9 | What is the exact next action? | **Run the disposable Supabase harness, then the per-edition checklist** | `SYNAPSE_PHARM_DB_HARNESS=1 bash scripts/db-tests/run-pharmacy-db-harness.sh` closes (b) and re-proves (a) over HTTP; a Tally host plus `TALLY_PRIME_ERP9_ACCEPTANCE.md` closes (c); a Windows host closes (d); the same Windows host with Tally stopped closes (e) |
| 10 | Has native PostgreSQL or Supabase execution been completed? | **No** | Nothing in this environment can host it: no server binaries, no reachable Docker daemon, a Supabase CLI that exits 1, no listener on any database port, no credentials (§5). Every database result in this document is PostgreSQL 18.6 on WASM and is labelled as such |

### This cycle's ten questions

| # | Question | Answer | Evidence |
|---|---|---|---|
| 1 | Does a clean database complete all migrations? | **Yes, on PostgreSQL 18.6 (WASM)** | `chain` 42/42, exit 0, with no injected repair and no option flags. The same tree on Supabase's server version has not been run |
| 2 | Is PR-013 fixed without weakening security? | **Yes, as measured** | the ten added lines put the five purchase policies through the same loop as their 29 siblings (`TO authenticated`, caller-tenant predicate, `WITH CHECK`); isolation 18/18; the five policy rules hold; the negative control drops to 41/42 and 13/18. No assertion removed, no check disabled, no integrity bypass |
| 3 | Is PR-014 applied successfully in the disposable environment? | **Yes** | `20261102130200` is the 42nd migration; the catalogue has exactly one `complete_pharmacy_sale`; a short-argument call resolves. Applied to no real environment |
| 4 | Are all 18 security assertions still passing? | **Yes** | `isolation` 18/18 after this pass's changes |
| 5 | Are all financial assertions passing? | **Yes** | `financial` 44/44, exit 0 |
| 6 | Has native PostgreSQL or Supabase execution been completed? | **No** | §5, "Why no native PostgreSQL or Supabase run happened" |
| 7 | What is still required to open Pharmacy on Windows? | **Four external inputs** | a provisioned tenant on a running stack (sign-in needs Supabase); a Windows PC with a supported browser; the printer and paper width; the bridge installer run on that host, per `TALLY_CONTROLLED_WINDOWS_TEST_RUNBOOK.md` |
| 8 | What remains for TallyPrime and ERP 9? | **One read-only run per edition** | `TALLY_PRIME_ERP9_ACCEPTANCE.md`: company discovery, edition detection, closing-balance reconciliation, a voucher-extraction count against Tally's own Day Book, resume after a kill. Only then can `verifiedOn` be set |
| 9 | What prevents the full disposable cutover rehearsal? | **Three missing inputs** | no Supabase stack (no Docker, no server binaries), no real Tally company to extract, no Windows host for the bridge. The WASM engine can rehearse the SQL half only — it cannot exercise HTTP, auth or two-connection behaviour |
| 10 | What is the next concrete action towards the first customer cutover? | **Run the disposable Supabase harness** | `SYNAPSE_PHARM_DB_HARNESS=1 bash scripts/db-tests/run-pharmacy-db-harness.sh` on a host with a reachable Docker daemon; it closes the HTTP, auth, concurrency and second-engine gaps in one run |

### Requirement classification

| Area | Verdict | Basis |
|---|---|---|
| POS sale, tax, receipt rendering | **PARTIAL** | Shared tax engine and receipt domain executed as tests; no browser journey; no device |
| Refunds and accounting (POS + legacy orders) | **PARTIAL** | Route and allocation tests pass (18); the database effect is unobserved |
| Tenant isolation | **PARTIAL** — applied nowhere | Repair executed on PostgreSQL 18.6: 18/18 access rules pass with it, 13/18 without (§5). Nothing is proven through Supabase's HTTP stack, and the migrations cannot be applied without the owner's authorisation |
| Sale, tax and accounting journal | **PARTIAL** — applied nowhere | 44/44 assertions on PostgreSQL 18.6 with independently computed figures, now covering refunds, receivables, credit balances, purchases, supplier balances and the till; no concurrency and no PostgREST |
| Independence from Tally (AC-9) | **PARTIAL** — does not pass | Import graph and a poisoned-network sale execute (§5); the browser steps and a real apply do not |
| Tally migration (Prime) | **NOT TESTED** | No instance |
| Tally migration (ERP 9) | **NOT TESTED** | No instance |
| Windows bridge and installer | **NOT TESTED** | No host |
| Mobile app (till, offline, draft, receipt-print gate) | **PARTIAL** | 17 mobile unit tests plus the BFF suites (160) pass; never installed on a device |
| Release gate | **PASS (local)** | `npm run verify:pharm-release` exit 0 on this tree; see §5 for exactly which stages executed and which tests inside them skipped |

**Release recommendation: not ready for a customer cutover, and not ready to
apply migrations.** Everything that can be proven without a database, a Tally
installation and a Windows machine has been proven; those three are the
remaining inputs, and none of them is in this environment. The product is
suitable for supervised internal demonstration against disposable data only.

---

## 8. Related documents

- [PRODUCTION_RELEASE_RUNBOOK.md](./PRODUCTION_RELEASE_RUNBOOK.md)
- [SECURITY_TENANT_ISOLATION_AUDIT.md](./SECURITY_TENANT_ISOLATION_AUDIT.md) —
  findings F1–F8, the two prepared migrations that close them, and the honest
  statement that no DB-backed assertion was executed
- [CLIENT_ONBOARDING_CHECKLIST.md](./CLIENT_ONBOARDING_CHECKLIST.md)
- [CLIENT_PRODUCTION_READINESS.md](./CLIENT_PRODUCTION_READINESS.md)
- [TALLY_MIGRATION_ACCEPTANCE_CRITERIA.md](./TALLY_MIGRATION_ACCEPTANCE_CRITERIA.md)
- [TALLY_CONTROLLED_WINDOWS_TEST_RUNBOOK.md](./TALLY_CONTROLLED_WINDOWS_TEST_RUNBOOK.md)
- [TALLY_CONNECTOR_SECURITY_AUDIT.md](./TALLY_CONNECTOR_SECURITY_AUDIT.md)
- [TALLY_MIGRATION_ARCHITECTURE.md](./TALLY_MIGRATION_ARCHITECTURE.md)
- [TALLY_PRIME_ERP9_ACCEPTANCE.md](./TALLY_PRIME_ERP9_ACCEPTANCE.md) — the
  per-edition external checklist; passing it is the only way an edition's
  `verifiedOn` date can be set
- [TALLY_UPLOAD_GUIDE.md](./TALLY_UPLOAD_GUIDE.md)
