# Goose work order — the changes that are required

**Written:** 2026-10-26
**Repo:** `SYNAPSE-OS` (npm workspaces + Turborepo, Node 22)
**Branch:** `integration/synapse-2026-10-09`, HEAD `c9e53e37`
**Tree state at handover:** 48 modified tracked files, 60 untracked files, nothing committed. Everything described here was verified by reading the tree on 2026-10-26; no figure below is inherited from a document.

Read these three files before touching anything. They are short and they explain why the code looks the way it does:

- `docs/decisions/CONNECTOR_RUNTIME_2026-10-25.md`
- `docs/decisions/ACCOUNTING_PERIOD_CLOSE_2026-10-25.md`
- `docs/audits/REMEDIATION_HANDOVER_2026-10-25.md`, Part 5 and Part 6

---

## Ground rules — these are not negotiable

1. **Never commit, push, merge, rebase, amend or rewrite history. Never deploy.** Work in the tree and leave it dirty for review.
2. **Never connect to, or mutate, any remote, staging, linked or shared database. Never apply a migration anywhere, including a local stack, unless the owner explicitly asks for that run in the same message.** Migrations in this repo are files awaiting dispatch; treat `supabase/migrations/*` as read-only unless a task below says otherwise.
3. **Never run destructive Git commands.** No `reset --hard`, `clean`, `stash`, `checkout -- <path>`. The tree contains a large amount of pre-existing uncommitted work; a clean-looking tree means you destroyed someone's work.
4. **Never print secrets, never use real patient data, never invent clinical data.** No drug dosages, no interaction tables, no catalogue entries.
5. **A static test never proves a runtime control.** Several documents in this repo exist because someone asserted the opposite. If you cannot execute something, say "not executed" rather than "verified".
6. Match the surrounding style. No new dependencies, no reformatting of files you are not changing, no drive-by renames.

---

## Task 1 — the cron job that is declared but never scheduled

This is the highest-value item and the smallest diff.

`apps/web/vercel.json` declares three crons:

```json
[{"path":"/api/cron/billing-sweep","schedule":"15 21 * * *"},
 {"path":"/api/cron/mobile-alerts","schedule":"0 6 * * *"},
 {"path":"/api/cron/dhis2-export","schedule":"0 23 * * *"}]
```

The root `vercel.json` declares one: `billing-sweep`.

`scripts/vercel-crons.test.mjs` says so itself, in its first two lines: *"The synapse-os Vercel project builds from the repo root (Root Directory "."), so only the ROOT vercel.json is read; crons declared in apps/web/vercel.json are never scheduled."* The test then only asserts the root file, so nothing fails and nothing notices.

The consequence is concrete: `apps/web/src/app/api/cron/dhis2-export/route.ts` carries the docstring *"Schedule: 02:00 Africa/Kampala = 23:00 UTC (see vercel.json)"* and has never run on a schedule. The nightly DHIS2 aggregate export does not happen. `mobile-alerts` is in the same position, and its own docstring does not claim otherwise.

**Do this.**

- Move `dhis2-export` into the root `vercel.json` with its existing schedule.
- Remove the `crons` array from `apps/web/vercel.json` entirely, with a one-line comment in the root file recording that the app-level file is not read.
- Add a test in `scripts/vercel-crons.test.mjs` that reads **both** files and fails if `apps/web/vercel.json` declares any cron at all. That is the fix that stops this recurring; adding the missing entry alone is not.
- Leave `mobile-alerts` unscheduled and say so in your report. Vercel Hobby allows two cron jobs per project, and this test's own docstring references that limit. Promoting it needs a decision about which of the existing two to give up — that is the owner's call, not yours.

**Do not** delete the `mobile-alerts` route, and do not fold the two jobs into one dispatcher.

## Task 2 — make the evidence-drift guard able to detect drift

`scripts/evidence-drift.test.mjs` pins `migrationCount: 194` and `gitHead: c9e53e37…`. `npm run db:check` now reports **197** files. The test passes anyway, because `EXPECTED` is compared to `artifacts/readiness/evidence.json`, and that file still records 194 — the guard compares a snapshot to a constant and never to the thing it is supposed to be guarding.

**Do this.** Change the migration-count assertion so it reads `supabase/migrations` directly and compares the recorded figure against the directory, using the same counting rule as `scripts/check-supabase-migrations.mjs` (every `*.sql`, including `demo_schema_init.sql`). Keep `gitHead` pinned — a HEAD pin is meaningful and should fail when the tree moves past the baseline; make its failure message say that regenerating evidence is the remedy rather than that the test is wrong.

Then regenerate `artifacts/readiness/evidence.json` by running `node scripts/collect-evidence.mjs` (it has no npm script alias; it spawns the local gate commands and writes that one file), or update the two changed figures by hand and say which you did.

**Do not** solve this by deleting the assertion or by loosening it to a range.

## Task 3 — observe the outbox; do not pretend to drain it

`public.synapse_domain_events` is written from six files through `persistDomainEventsBestEffort` (`grep -rn "persistDomainEventsBestEffort("` — seven call sites) and read by exactly one route, `apps/web/src/app/api/platform/events/route.ts`. Nothing drains it, so every event ever emitted is still `pending`, and a queue that is never drained is indistinguishable from a healthy quiet one.

The relay that would drain it is built and tested (`packages/interop/src/runtime/relay.ts`, 41 tests) but has **no connector to push to**: no code queries `synapse_adapters` at all, and the Tally integration that exists is an XML *import*, not a push endpoint. Building a worker now would produce a process that wakes up, claims nothing, and returns success — worse than no worker, because it looks like delivery.

**Do this instead.** Add `apps/web/src/app/api/cron/domain-event-health/route.ts`, modelled on `dhis2-export/route.ts` for auth shape: `CRON_SECRET` from env, `503` when unset, `401` on a mismatch of `authorization: Bearer …` or `x-cron-secret`, `maxDuration = 60`. It must:

- select counts grouped by `status` (`pending`, `published`, `failed`, `dead`) for the whole table;
- select the `created_at` of the oldest `pending` row;
- return `ok: false` with status `500` when the oldest pending event is older than a threshold read from `DOMAIN_EVENT_PENDING_ALERT_MINUTES` (default 60), and `ok: true` otherwise;
- never throw on a PostgREST error it can describe — return the error code in the body.

Add `apps/web/src/app/api/cron/domain-event-health/route.test.ts` covering the missing-secret `503`, the bad-secret `401`, the healthy `200`, and the stale-queue `500`, using the same mocking style as `apps/web/src/app/api/cron/billing-sweep/route.test.ts`.

Do not add it to `vercel.json` — the cron slots are Task 1's business, and this route is meant to be poked until someone decides where it runs.

**Do not** write a relay worker, and do not "fix" the fact that the queue is not drained by wiring the durable store to anything. `packages/db/src/domain-event-outbox-store.ts` must not be called by application code until `20261026180000_domain_event_outbox_dispatch.sql` is applied, because it queries `next_attempt_at` and `locked_until`, which do not exist yet.

## Task 4 — lint the packages that now hold the risky code

Only `apps/web` and `apps/pharmacy` define a `lint` script. `npm run lint` at the root is `turbo lint`, which therefore no-ops for all six packages — including `packages/interop`, which now contains a delivery policy layer, and `packages/db`, which contains the durable outbox store.

**Do this.** Add an `eslint.config.mjs` and a `"lint": "eslint . --max-warnings 0"` script to `packages/interop` and `packages/db`, modelled on `apps/web/eslint.config.mjs` (adjust only the `files`/`ignores` paths). Fix what it reports in those two packages. If a rule cannot be satisfied without changing behaviour, disable it in the package config with a comment naming the rule and the reason — do not loosen the root.

Leave the other four packages alone and note them as still unlinted.

## Task 5 — describe the new tables in the generated types

`packages/db/src/types.ts` describes neither `synapse_domain_events` nor the `close_snapshot` column added by `20261026190000`. That is why `createDurableOutboxStore` leaves its generic open and why the periods route needs `as any`.

Neither table appears in `packages/db/src/types.ts` at all — `grep -n pharmacy_accounting_periods packages/db/src/types.ts` returns nothing. There is no database to regenerate from, so add both by hand, from the DDL, in the shape of the neighbouring tables (`Json` is already exported at the top of the file):

- `synapse_domain_events` — `supabase/migrations/20260827231417_synapse_exchange_events_and_lab_safety.sql`, plus the two columns added by `20261026180000_domain_event_outbox_dispatch.sql`.
- `pharmacy_accounting_periods` — `supabase/migrations/20261022160000_pharmacy_accounting_ledger.sql`, plus `close_snapshot: Json` from `20261026190000_pharmacy_period_close_integrity.sql`.

Then re-run `npm run type-check` for every workspace that consumes them. If typing `synapse_domain_events` makes `createDurableOutboxStore` produce new errors, fix the types, not the store — the store is unit-tested against behaviour and its generics are deliberate.

## Task 6 — put the close evidence on the screen

`20261026190000` records `close_snapshot` on every close, and the close route returns it, but nothing reads it back: `apps/pharmacy/app/api/admin/accounting/periods/route.ts` selects only `id, period_start, period_end, status, closed_at`.

**Do this.**

- Add `close_snapshot` to that `select`.
- In `apps/pharmacy/app/portal/accounting/page.tsx`, show the recorded figures for a closed period — sales count and total, journal entries, open till sessions, unmatched bank lines — in the periods table or a details row. Keep it plain: no new components, no chart.
- Add `apps/pharmacy/app/api/admin/accounting/periods/readiness/route.test.ts` covering four cases against a mocked `supabaseAdmin`: a bad date returns `400`; a missing RPC (PostgREST `PGRST202`) returns `503`; a payload with an open till returns `200` with `readiness.ready === false` and a blocker whose code is `OPEN_TILL_SESSIONS`; a clean payload returns `200` with `readiness.ready === true`.

**Gate note.** The `close_snapshot` select only works once `20261026190000` is applied. That is the same coupling the readiness route already has, and it is acceptable because both ship together; say so in the file's header comment rather than adding a runtime fallback that would hide a half-applied deployment.

## Task 7 — bring the two decision records back in line

`docs/decisions/CONNECTOR_RUNTIME_2026-10-25.md` says `db:check` reports 196 files; it reports 197. `docs/decisions/ACCOUNTING_PERIOD_CLOSE_2026-10-25.md` quotes gate figures that were true when written — re-run the gates first, then correct any figure that has moved.

Change figures only. Do not rewrite conclusions, and do not touch `docs/audits/*`.

---

## What not to do, in one place

- Do not apply any migration to any database. `20261025120000`, `20261026120000`, `20261026130000`, `20261026160000`, `20261026170000`, `20261026180000` and `20261026190000` are all prepared and unapplied by design, and dispatch is the owner's decision.
- Do not touch `supabase/held/scope_staff_intake_policies_to_tenant.sql`. It is deliberately outside every applying glob, pending a policy decision.
- Do not populate the clinical catalogues (`apps/web/src/lib/clinical-safety/`) or add drug codes. Three of the four catalogues are empty because filling them is a clinical governance act, not an engineering one.
- Do not attempt to resolve the `PUBLIC` permissive policies on `products`, `consult_queue`, `order_items`, `gas_cylinders` or the telemedicine tables. Which reads are legitimate is a product-position question listed in the handover's Part 6.
- Do not run `npm run verify:web` once and call it a build. It performs a full Next build over 288 routes and exceeded the sandbox wall clock twice; run it in the background or in CI and report what it produced, including "nothing".

## Gates to run before you report

```
npm run db:check                     # expect: 197 migration files OK (or 197+your additions)
npm run test:vercel-config           # expect: 2 pass, and 3 after Task 1
npm run test:workflow-safety         # expect: pass
npm run test:interop-runtime         # expect: 41 pass
npm run test:memory-sync-outbox      # expect: 20 pass
npm run test:general --workspace @synapse/pharmacy   # expect: 572+ pass
npm run lint --workspace @synapse/pharmacy
npm run type-check --workspace @synapse/pharmacy
npm run type-check --workspace @synapse/web
npm run test:security-gates          # expect: SECURITY GATES PASS … failures=0
npm run test:routes                  # expect: PASS pages=288 nav_links=73 roadmap=77
```

If a gate fails before you change anything, say so and stop on that item — do not "fix" it to make your change look clean.

## What to report back

For each task: the files you changed, the command you ran, and its actual output. Then a short list of anything you could not verify and why. Mark each task `done`, `blocked` or `not attempted` — no partial credit, and no claim that a test file proves a runtime behaviour.
