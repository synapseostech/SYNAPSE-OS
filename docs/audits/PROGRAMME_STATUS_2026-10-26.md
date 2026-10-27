# Programme status — what exists, what is proven, what is not

**Date:** 2026-10-26
**Branch:** `integration/synapse-2026-10-09`, HEAD `c9e53e37`, nothing committed
**Purpose:** a baseline for starting real development, not another audit. Everything below was either executed in this environment or read from the tree; where a claim is unproven it says so.

---

## The repo today

197 migration files, 288 web routes, **10 workspaces** — six packages plus `apps/web`, `apps/pharmacy`, `apps/app`, `apps/lab-edge`. Eight of the ten carry a lint script; `apps/app` and `apps/lab-edge` carry none, so "lint 8/8" means eight green out of eight that exist, not out of ten. The working tree carries **76 modified tracked files and 68 untracked** — that is the entire last three days of work, uncommitted by design.

Gates that pass here right now: `db:check` 197 · `test:vercel-config` 4 · `test:workflow-safety` 59 · `test:interop-runtime` 41 · `test:memory-sync-outbox` 20 · `test:security-gates` 41 · `test:evidence-drift` 6 · `test:routes` 288/73/77 · `test:db-acl` 68 definer functions, 0 public grants · pharmacy 576 passed / 15 skipped over 62 files · lint 8/8 workspaces that have a lint script · web and pharmacy type-check · `verify:web` exit 0, 308/308 static pages.

## Workstreams

### 1. Tenancy and row-level security — repair written and proven, not applied

The ten self-referential `tenant_isolation` policies on `encounters`, `vitals`, `encounter_orders`, `hospital_drug_orders`, `order_items`, `products`, `sync_conflicts`, the two telemedicine tables and `gas_cylinders` are readable — and with no `WITH CHECK`, writable — by any authenticated user. `20261025120000_tenant_isolation_policy_repair.sql` rewrites them in place against `current_tenant_id()`, adds `WITH CHECK`, and scopes them `TO authenticated`; it aborts if any expected policy is missing.

That migration has **run and passed on a disposable PostgreSQL 16 database**, steps 1–19, including the anon denial and the two later migrations. It has **never been applied to any environment that matters**. Production still carries the tautology.

Two further prepared migrations sit behind it: `20261026120000` (telemedicine intake tenant ownership via SECURITY DEFINER triggers) and `20261026130000` (the five `Admins full access …` policies scoped to `authenticated`). The staff-intake policies are held at `supabase/held/`, outside every applying glob, pending a decision.

Known and unfixed by design: the `PUBLIC` permissive policies on `products`, `consult_queue`, `order_items`, `gas_cylinders` and the telemedicine tables. Which of those reads are legitimate is a product question, not a code one.

### 2. Privilege defaults — prepared

`canonical_public_schema.sql` re-asserts production's own default: `GRANT ALL ON FUNCTIONS TO anon`. Every function created in production is therefore anon-executable unless revoked. `20261026160000_revoke_anon_default_function_privileges.sql` closes it and cleans the six functions already carrying the grant. Unapplied. Two SECURITY DEFINER triggers in `20261026120000` are only safe *because* this lands first — locally the bootstrap already removed the default, so a local pass cannot prove the production state.

### 3. Import, intake and IDOR containment — built and tested

Import routes gated behind a positive-enable kill switch (`SYNAPSE_ALLOW_PATIENT_IMPORT`, default off → 503); `api/tele/intake` rebuilt with rate limiting, input bounds, owned case IDs, and fail-closed behaviour without `GEMINI_API_KEY`; lab-notify restricted to self-notification; insurance copilot and mobile POS prove ownership rather than trusting a body parameter. Covered by the `test:hardening` and `test:tenancy` suites.

### 4. Clinical safety — code exists, enforcement does not

`apps/web/src/lib/clinical-safety/` implements allergy, interaction and dose evaluation with a policy layer and an audit record. It is **not wired into the prescribe, dispense or POS paths** — the finding that started this work is still true at runtime. Three of the four catalogues are empty, matching is by drug name only (no codes), and the hard-stop-versus-warn policy has not been ratified. `20261026170000_medication_safety_checks_policy_snapshot.sql` is prepared.

Filling those catalogues is a clinical governance act. It is not an engineering task and should not be done by one.

### 5. Interoperability — runtime built, nothing to push to

`packages/interop/src/runtime/` has the contract, exponential backoff with jitter, circuit breaker, cursor handling and an at-least-once relay, all deterministic and all tested (41 tests). `packages/db/src/domain-event-outbox-store.ts` persists claims, leases and attempts.

What does not exist: a worker, a push connector, and anything that reads `synapse_adapters`. `synapse_domain_events` is written from six files and drained by nothing, so every event ever emitted is still `pending`. `20261026180000_domain_event_outbox_dispatch.sql` adds the columns the durable store needs and is unapplied — so the store cannot be wired up yet without failing at runtime. The Tally integration is an XML *import*, not a push endpoint.

### 6. Pharmacy operations — close-out control built, SQL unapplied

Period close previously locked a date range without checking whether a till was open, stranding that day's cash in an unclosable till. There is now a pure readiness rule (`close-readiness.ts`, 17 tests), an endpoint, and a screen that disables the close button while a blocker stands and fails closed if the check cannot be answered. The database half — `pharmacy_accounting_close_readiness` plus the `ACCOUNTING_PERIOD_OPEN_TILLS` refusal inside the advisory lock — is in `20261026190000`, unapplied. So today the UI is a courtesy and the database still allows the mistake.

### 7. Delivery plumbing and code health — done this week

`dhis2-export` was declared in a `vercel.json` that Vercel never reads; it now runs from the root file. `mobile-alerts` remains scheduled nowhere, because Hobby allows two cron slots and both are taken — an owner decision. A domain-event health route was added (unwired), the evidence-drift guard was taught to read the directory instead of a constant and split out of the security-gates suite, `artifacts/readiness/evidence.json` was brought under git so the CI step can run on a clean checkout, `packages/db` and `packages/interop` lint with both rules on, and the four remaining packages gained lint at all. `packages/db/src/types.ts` now describes `synapse_domain_events` and `pharmacy_accounting_periods`. `verify:web` was re-run after these changes and returns exit 0 with 308/308 static pages, so the web build is current rather than assumed.

## The gate that matters

Seven migrations are written, reviewed and unapplied:

```
20261025120000  tenant isolation policy repair
20261026120000  telemedicine intake tenant ownership
20261026130000  admin policies scoped to tenant
20261026160000  revoke anon default function privileges
20261026170000  medication safety policy snapshot
20261026180000  domain event outbox dispatch
20261026190000  pharmacy period close integrity
```

Each was deliberately left unapplied. Nothing in sections 1, 2, 5 or 6 is real in production until they run, in that order, with `20261026160000` before `20261026120000`. The tenant repair is proven on a disposable database and on nothing else; the other six have never been executed anywhere.

## What is genuinely absent

No relay worker. No push connector. No clinical enforcement on a write path. No drug codes. No applied migration. No production or staging verification of any kind — this programme has never touched a real environment and the documents say so throughout. `packages/db` has no `type-check` script, so its `src` is checked only through its consumers. `apps/app` and `apps/lab-edge` have no lint script at all, so two of the ten workspaces are unchecked by any static gate.

## What "serious development" should mean next

The binding constraint is not code volume — it is that six of seven prepared migrations have never been executed, so every feature built on them is unproven by construction. The productive order is therefore:

1. **Get one authorised database.** A disposable stack is enough to execute all seven in order and record what happens. That converts six unknowns into facts and is worth more than any new module.
2. **Clinical enforcement**, once the policy decision exists — because it is the only item on this list where the current state can hurt a patient today.
3. **The connector worker and a first push connector**, once dispatch columns exist — the runtime is already there and idle.
4. **Pharmacy depth** on top of a working close.

Anything built before step 1 adds to the pile of code that cannot be called working.

Step 1 is also the one step that cannot be started under the standing rules. No database is contacted, and no migration is executed against anything, unless the owner asks for that specific run in the same message. So the branch is at a genuine standstill rather than a queue of work: steps 2–4 all sit on the unapplied SQL, and building them now would produce exactly the unprovable code this document warns about. The next movement is an authorised disposable stack plus a named run.
