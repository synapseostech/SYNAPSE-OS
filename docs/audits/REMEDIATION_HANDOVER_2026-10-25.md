# Remediation Handover — SYNAPSE-OS

**Date:** 2026-10-25
**Scope:** Local working tree only. Nothing was committed, pushed, deployed, migrated or applied to any database.
**Baseline:** branch `integration/synapse-2026-10-09`, HEAD `c9e53e37` (2026-10-22), plus the pre-existing uncommitted changes that were already in the tree before this work started. (`485ffaf3`, "fix(pharmacy): atomic credit ledger and till cash (DB-level)", 2026-10-02, is an ancestor of HEAD and is where the credit-ledger idempotency contract was introduced — it is not the baseline commit.)

This document is the handover for the remediation mission: seven finding groups (A–G) reconciled, fixes implemented where a local code change was safe, and everything else recorded as either unproven or as an owner decision. It is written to be read in one sitting by whoever picks the work up next.

---

## Part 1 — What changed

Twenty tracked files were modified and sixteen new files were added (this document is the seventeenth). The changes fall into four implementation areas plus the test and gate work that pins them. Every edit is additive or a tightening of an existing check; no migration was rewritten, no policy was deleted, and no business rule was changed silently. Where a change does alter observable behaviour, it is called out in Part 6 as a decision for the owner.

**Finding group A — profiles privileged columns.** The guard migration `20261003160000_profiles_privileged_columns_guard.sql` was left exactly as it was, and the forward-looking static gate was taught to enforce the same rule for every migration at or after that cutoff. `scripts/check-security-gates.mjs` now fails on a blanket `grant all|update on profiles to anon|authenticated|public`, and separately fails on an `update (col, …)` grant naming a privileged column without the guard's column list. Both rules are pinned by tests.

**Finding group B — tenant isolation.** `supabase/migrations/20261025120000_tenant_isolation_policy_repair.sql` is new and **prepared only, not applied anywhere**. It loops the ten affected tables and rewrites the existing `tenant_isolation` policy in place to `to authenticated using (tenant_id = public.current_tenant_id()) with check (tenant_id = public.current_tenant_id())`. The `TO authenticated` clause is part of the repair, not cosmetic: the policies as written have no role clause, which means `PUBLIC`, and `anon` has no `EXECUTE` on `public.current_tenant_id()` because `20260613104742_lock_down_auth_rls_helpers_anon_execute.sql` revoked it — so a `PUBLIC`-scoped predicate raises `permission denied for function current_tenant_id()` for anonymous readers instead of denying cleanly, which would break the deliberately public `products` catalogue. The migration alters only policies that already exist and **fails closed** if any of the ten is missing: it collects the absent names and raises, rather than emitting a notice and completing a partial repair. The alterations and the self-check are one `do $$ … $$;` statement, so they commit or roll back together under psql, `psql -f`, the harness's `\i` and `supabase db push`; explicit `begin;`/`commit;` is deliberately avoided because the Supabase CLI already wraps each migration file. The self-check raises if a self-referential predicate, a missing `WITH CHECK`, a predicate or check that does not call `current_tenant_id()`, or a non-`authenticated` role list survives. Static proof of the defect and of the migration's target set is in `scripts/rls-tenant-isolation.test.mjs`; a disposable-database harness that reproduces the tautology, asserts the **clean zero-row anonymous denial** the original policies actually produce (the `EXECUTE` trap is what a repair omitting `to authenticated` would create, and the migration's self-check rejects that shape), then asserts SELECT/INSERT/UPDATE/DELETE isolation, same-tenant access, no-tenant fail-closed behaviour, platform-admin bypass, service-role bypass, anon behaviour, the residual `products` public read, and the SEC-02 bypasses the repair does not fix (`is_admin` cross-tenant read/write, staff-role cross-tenant intake reads, unconstrained patient-initiated intake writes) is in `scripts/db-tests/rls-tenant-isolation.sql`, with a fail-closed runner at `scripts/db-tests/run-rls-isolation.sh`.

**Finding group C — telemedicine intake.** `apps/web/src/app/api/tele/intake/route.ts` is substantially reworked. It now rate-limits every caller (keyed on the authenticated user, or the client address when anonymous), bounds the conversation to 40 messages of 2 000 characters each and the stored symptom text to 2 000 characters, validates that a supplied `caseId` is a UUID and belongs to the caller before appending to it, returns 503 with `AI_UNAVAILABLE` instead of throwing when `GEMINI_API_KEY` is missing, and maps the model's four-level urgency onto the three values the database column actually allows. Persistence failures are logged and reported through a `persisted` flag rather than being swallowed. `apps/web/src/app/tele/intake/page.tsx` was updated to match.

**Finding group D — patient import.** A new server-side module `apps/web/src/lib/import/` provides the shared pieces: `guard.ts` (a positive-enable kill switch on `SYNAPSE_ALLOW_PATIENT_IMPORT`, hospital staff context, a `patient:write` capability check, and tenant-owned batch loading that reports another tenant's batch as not found), `csv.ts` (a parser with quoted-field and delimiter handling), and `map-row.ts` (header normalisation and row mapping). The four import routes (`start`, `upload`, `execute`, `status/[batchId]`) now all pass through that guard, scope every query by `tenant_id`, reject a `hospitalId` that does not match the authenticated facility, cap uploads at 5 MB and `.csv`/`.txt` only, cap a single execute run at 2 000 rows, and rate-limit on the authenticated principal rather than a spoofable header. The import wizard page `apps/web/src/app/os/[slug]/migrate/page.tsx` was updated to the new error contract.

**Finding group E — pharmacy and finance.** `apps/pharmacy/app/api/admin/pos/complete-sale/route.ts` now proves a client-supplied `patientId` belongs to the tenant before the sale references it, returning 404 `PATIENT_NOT_FOUND`, and passes the validated value to the RPC. No other pharmacy logic, pricing, or dispensing path was touched. The two stale credit-ledger tests were corrected (see Part 2) and two contract tests were added.

**Finding group F — clinical safety and offline.** `apps/web/src/app/api/lab/notify/route.ts` no longer accepts an arbitrary `userId` from the request body and no longer resolves a patient to `patients.created_by`. A caller may only notify their own account (403 otherwise), and a named patient must belong to the caller's tenant (404 otherwise). `apps/web/src/lib/insurance/copilot.ts` now proves policy ownership before reading benefits, and proves the encounter belongs to both the tenant and the named patient before reading its diagnoses; when the encounter cannot be verified the draft says so rather than emitting a note built from unverified data.

**Finding group G — CI and release gates.** `scripts/check-security-gates.mjs` was rewritten into an importable analyser with a `pathToFileURL` direct-run guard, and gained a detector for self-referential tenant policies plus a detector for RLS that is enabled dynamically inside a `do $$ … $$` block. `scripts/vercel-build-gate.test.mjs` was rewritten to pin the real branch-family matrix. `scripts/e2e-hospital-browser.mjs` now fails closed when no target URL is configured instead of reporting success. `scripts/release-deployment-smoke.mjs` extracts the release workflow's inline smoke shell into a testable module that fails closed on a missing `PRODUCTION_URL` or a malformed `RELEASE_SHA`. `.github/workflows/release.yml` calls it, and `.github/workflows/ci.yml` gains two steps so the new suites actually run.

**Test and tooling additions.** `package.json` gains `test:hardening`, extends `test:workflow-safety` and extends `test:security-gates` to run the new unit tests before the gate. `packages/db/src/types.ts` gains the missing `feature_flags` table definition, which removes the five pre-existing `apps/web` typecheck errors without touching the user-modified route that queries it.

---

## Part 2 — Why these changes were needed

Each group traces to a defect that was either exploitable or made a workflow silently unusable. The mechanics matter because they determine how confident we can be that the fix addresses the real problem.

**Group B is a total tenant-isolation failure.** The ten `tenant_isolation` policies are `FOR ALL` with no `WITH CHECK` and no `TO` clause, and their predicate is a correlated subquery that selects the row's own `tenant_id` — `tenant_id = (select <table>.tenant_id from profiles where profiles.id = auth.uid())`. Because the subquery's `<table>.<column>` resolves to the row being evaluated, the predicate reduces to `tenant_id = tenant_id`, which is true for every row. Any authenticated user with a profile row can read, insert, update and delete across all tenants in those ten tables. The correct helper (`public.current_tenant_id()`, SECURITY DEFINER, STABLE, pinned search path) already existed; the policies simply never used it. The repair therefore restores the intended predicate rather than inventing new behaviour.

**Group C was worse than an authorization gap: the persistence path was dead.** The route inserted `status: 'in_progress'` and later `'triaged'`, but `telemedicine_intake_cases_status_check` permits only `open`, `referred`, `arriving`, `completed`, `cancelled`. It inserted message roles `patient` and `ai`, but `telemedicine_intake_messages_role_check` permits only `user`, `assistant`, `system`. It also wrote `patient_id: userId`, where `patient_id` is a foreign key to `public.patients(id)` and the value supplied was an `auth.users` id. All three violated constraints, and because none of those call sites checked the returned error, every intake conversation failed to persist while the API reported success. The rework fixes the constraint violations, and the new tests assert the exact values written.

**Group D's import surface had no tenant containment and no server-side gate.** The batch id was accepted from the client without an ownership check, queries were not tenant-scoped, and the feature was reachable in any environment. The kill switch is deliberately positive-enable, matching the existing `SYNAPSE_ALLOW_HARD_PURGE` convention: unset, empty, `0`, `false` or a typo all mean disabled.

**Group E's credit-ledger tests were stale, not the code.** The route was hardened in `485ffaf3` to require an `Idempotency-Key` on repayments, and the portal at `apps/pharmacy/app/portal/credit-ledger/page.tsx` generates and sends one on every POST. Two committed tests posted repayments without the header and expected 201. A third test, "rejects a repayment when nothing is owed", was passing vacuously — it got its 400 from the key guard rather than from the overpayment check it claimed to exercise. All three now send the header and assert the path they describe, and two new tests pin the contract itself: a repayment with no key is rejected before the ledger is touched, and a key supplied in the body is accepted as well as in the header. The route was not modified.

**Group F's lab-notify route was an open notification relay.** Accepting `userId` from the body let any authenticated user push notifications to any other user, and the `created_by` fallback resolved a patient to the staff member who registered them rather than to the patient's own login. The insurance copilot read benefits for a policy id without proving the policy belonged to the tenant, and built a claim note from an encounter that was never checked against the tenant or the patient.

**Group G's gates were fail-open.** The hospital browser smoke exited 0 when it had not verified anything. The release smoke treated a missing `PRODUCTION_URL` as a skip. The security gate could not distinguish RLS enabled dynamically in a loop from RLS never enabled, so it produced six false findings on a migration that was in fact correct — which is exactly how a gate gets annotated away instead of fixed.

---

## Part 3 — Evidence per finding group

This section separates what is actually proven from what is only asserted. Static tests prove the shape of SQL and the behaviour of TypeScript; they do not prove anything about a running PostgreSQL instance.

| Group | What is proven | By what | What is not proven |
| --- | --- | --- | --- |
| A | The guard migration exists at `20261003160000_profiles_privileged_columns_guard.sql`; a blanket or privileged-column `profiles` grant fails the gate; an allowlisted privileged-column grant passes. | `scripts/check-security-gates.test.mjs` (privileged profiles column grants, blanket profiles grant), gate CLI pass at cutoff `20261003160000` | That the guard is present and effective in production — needs `supabase migration list --linked` and a live privilege read |
| B | The snapshot's self-referential `tenant_isolation` set is exactly the ten known tables; the migration names exactly those ten; it sets `TO authenticated` plus `USING` and `WITH CHECK` to `public.current_tenant_id()`, and the self-check raises if the role list is not `{authenticated}`; it never drops a policy and never creates one for a table that lacks it; it raises rather than leaving a tautology; no workflow applies it to a remote or production database (`db-production.yml` is manual and attestation-gated; `deploy.yml` applies it only to the disposable stack it starts itself). | `scripts/rls-tenant-isolation.test.mjs` (12 tests), `npm run db:check`, `npm run db:history:check` | That the repair works on production PostgreSQL data. The disposable harness passed on 2026-10-25, but production remains unverified. |
| C | Rate limiting, input bounds, UUID validation, 503 on missing key, ownership check on `caseId`, the five-to-three urgency mapping, and the exact persisted values (`status: open`, roles `user`/`assistant`, no `patient_id`). | `apps/web/src/app/api/tele/intake/route.test.ts` (296 lines) | That the live model returns the shapes the tests assume; that real conversations persist end to end |
| D | Kill switch is default-deny; capability and staff context are enforced; cross-tenant batch reads return 404; file type and size limits; row cap; tenant scoping on every query. | `apps/web/src/lib/import/import-routes.test.ts` (549 lines), `csv.test.ts`, `map-row.test.ts` | That a real CSV from a real legacy system maps correctly — no production-shaped fixture was available or used |
| E | A non-owned `patientId` yields 404 before the RPC; repayments require an idempotency key; the overpayment path still returns `OVERPAYMENT` with the correct balance; a replay posts once. | `apps/pharmacy/app/api/admin/pos/complete-sale/route.test.ts`, `apps/pharmacy/app/api/admin/credit-ledger/route.test.ts` (8 tests) | Database-level concurrency, which the pre-existing `scripts/db-tests/pharmacy-concurrency.local.test.mjs` covers only against a local Postgres that is not available here |
| F | A caller cannot notify another user; a patient from another tenant is not found; a policy from another tenant yields "not found for this facility"; an unverifiable encounter produces an explicitly unverified draft. | `apps/web/src/app/api/lab/notify/route.test.ts`, `apps/web/src/lib/insurance/copilot.test.ts` | Nothing about the downstream delivery of a notification, which is not exercised |
| G | The branch matrix (main, master, release/, hotfix/, clinical/, staging/, integration/, fix/, feat/ build; unrecognised branches skip and are named); the smoke fails closed with no target and with a bad URL; a 401/403/2xx/3xx probe passes and a 503 or an unreachable host fails; the security gate recognises dynamic RLS and self-referential policies. | `scripts/vercel-build-gate.test.mjs`, `scripts/e2e-hospital-smoke.test.mjs`, `scripts/release-deployment-smoke.test.mjs`, `scripts/check-security-gates.test.mjs` | That the Vercel project's configured `ignoreCommand` matches the tested module, and that the release workflow's real environment supplies `PRODUCTION_URL` |

---

## Part 4 — Validation results

Everything below was run in this working tree after the final edit, and the figures were refreshed on 2026-10-25 after the implementation pass recorded in the closure report's §11. Nothing was skipped silently; the skipped items are listed with their reason. The gate figures are generated into `artifacts/readiness/evidence.json` and reproduced in the block below; no count is restated by hand, and `scripts/evidence-drift.test.mjs` asserts the block matches the file exactly.

<!-- evidence:begin -->
source: artifacts/readiness/evidence.json
timestamp: 2026-10-31T20:21:16.143Z
git.branch: feat/clinical-intelligence-land
git.head: 63fb422e5d6a64fbcd3f2ce3be325722722e33a5
migrationCount: 202
suites.rls-tenant-isolation.tests: 21
suites.security-gates.banner: SECURITY GATES PASS cutoff=20261003160000 migrations=15 failures=0
suites.security-gates.exitCode: 0
suites.hardening.tests: 74
suites.tenancy.tests: 59
suites.workflow-safety.tests: 60
suites.rls-matrix.tests: 10
dbAcl.definerFunctions: 74
dbAcl.publicGrants: 0
dbAcl.possibleImplicitPublic: 21
dbAcl.liveCheck: SKIPPED_NO_DATABASE_ACL_URL
routeIntegrity.pages: 289
routeIntegrity.navLinks: 73
routeIntegrity.roadmap: 77
disposableDb.result: not_provided
<!-- evidence:end -->

`npm run db:check` accepts the migration set, including the repair at `20261025120000_tenant_isolation_policy_repair.sql` and the two migrations added after this handover was written, `20261026120000_telemedicine_intake_tenant_ownership.sql` and `20261026130000_scope_admin_policies_to_tenant.sql`. `npm run db:history:check` exits 0 and reports `remoteReconciliation: BLOCKED_OPERATOR_CONTROLLED`, which is the correct status when no linked database is accessible.

The full pharmacy suite, run from `apps/pharmacy` because that package has its own Vitest config and alias resolution, passes with its database-backed integration files skipped. The skips are the integration suites that require `SUPABASE_URL` and a service-role key.

`npm run type-check` and `npm run lint` pass for every workspace, with `--max-warnings 0` on lint.

One environment note that will bite a fresh checkout: ESLint 9 on this repo crashes with `Cannot set properties of undefined (setting 'defaultMeta')` until `node scripts/nest-eslint-ajv6.mjs` has run, because `@eslint/eslintrc` needs ajv 6 while Expo and Metro need ajv 8. The repo's `postinstall` already runs it, so this only affects environments where the patch was skipped. It was applied to `node_modules` here; no repository file was changed for it.

---

## Part 5 — What was not done and what is not proven

**The tenant-isolation repair has since been executed — on a disposable database, not on production.** This paragraph originally said it had never run, because Docker and PostgreSQL are unavailable in the sandbox working this tree. It was then run by the owner on their own machine, through `sg docker`: the first attempt failed at step 5b because `SET ROLE anon` does not clear the session-scoped `request.jwt.claim.sub` setting, and the second attempt passed end to end (steps 1–19, exit 0) on PostgreSQL 16, 2026-10-25. The runner still fails closed — exit code 2 and `CANNOT PROVE` — when it cannot start a database, and `scripts/rls-tenant-isolation.test.mjs` asserts that behaviour. The result is evidence about SQL behaviour on an empty database and no evidence about production data or production policy state; see `docs/audits/REMEDIATION_CLOSURE_2026-10-25.md` §5 and §11.

**Nothing was applied to any linked, shared or production database.** No linked diff was taken, no SQL was executed against a remote instance, and no ACL was changed. The disposable harness started and destroyed its own local PostgreSQL 16 container; the migrations are otherwise files in the working tree.

**The ten tenancy policies are still broken in production** until that migration is reviewed and applied. The static test proves the migration targets the right policies with the right predicate; it does not reduce the exposure by itself.

**Pre-existing `SEC-02` was not fixed, and its state depends on which evidence you look at.** The canonical snapshot does carry `USING (true)` policies on `products` ("Public read products") and `consult_queue` ("queue_read_by_token"). Migration `20261003160000_profiles_privileged_columns_guard.sql` **drops both**, and also drops "Public read restaurants" — so in source the current chain has no world-readable policy on those tables. Whether that migration has been applied to any given environment is **unverified** (`npm run db:history:check` reports `remoteReconciliation: BLOCKED_OPERATOR_CONTROLLED`; `npm run test:db-acl` reports `live_check=SKIPPED_NO_DATABASE_ACL_URL`). `hospital_drug_orders` carries **no** public policy at all — only `platform_admin_bypass` and the tautology. Beyond the snapshot-era policies, several co-located permissive policies are cross-tenant in the current chain and are dropped by nothing: "Admins full access products/order_items/gas_cylinders" test `profiles.is_admin` only, and the telemedicine staff read/update policies test the caller's role only. Because permissive policies are OR'd, a correct tenant predicate does not neutralise any of them. Two of those are now addressed in source but applied nowhere: `20261026130000_scope_admin_policies_to_tenant.sql` adds the caller's tenant to both clauses of the five `Admins full access …` policies while keeping the `is_admin` test, and the telemedicine staff-role policies are written but held at `supabase/held/scope_staff_intake_policies_to_tenant.sql`, outside every applying glob, pending the owner decision. Fixing the rest changes which records the product permits, which is an owner decision, not a mechanical repair.

**No `RESTRICTIVE` policy work was done.** The schema has zero restrictive policies; adding a spine of them is an architecture change, not a remediation.

**The web production build was not verified in this session.** Typecheck and lint pass for every workspace, and the route-integrity and secret gates pass, but `npm run verify:web` (which performs a full Next build across 288 routes) exceeded the sandbox's per-command wall clock, and a detached retry was reaped when its parent call returned. No build output was produced — `apps/web/.next` still holds 2026-10-22 artifacts — so there is no partial result to interpret. Treat the web build as unverified until CI runs it.

**No production verification was performed for group A.** The guard migration's presence in the ledger is proven locally; its effect in production is not.

**Nothing was committed.** All changes are in the working tree for review, as instructed.

---

## Part 6 — Decisions the owner must make

These are the points where a local fix would have meant choosing a product position. Each is a question, not a recommendation.

**Apply the tenant-isolation repair, and when.** The migration is safe by construction — it only alters existing policies and raises if the result is still wrong — but applying it is a production database change. It also needs a decision about migration-history bookkeeping in the linked project, which this environment cannot inspect.

**Decide the fate of the `PUBLIC` / role-only permissive policies on `products`, `consult_queue`, `order_items`, `gas_cylinders` and the telemedicine tables.** Any read that currently succeeds through `using (true)`, through `profiles.is_admin`, or through a staff-role check will stop working if those policies are tightened. Which of those reads are legitimate product surfaces — and whether a tenant admin or a clinician may see another facility's records — needs an answer from whoever owns the catalogue, ordering and telemedicine flows.

**Decide whether patient import is enabled anywhere.** The kill switch defaults to off, so all four import endpoints now return 503 `IMPORT_DISABLED` on any deployment that does not set `SYNAPSE_ALLOW_PATIENT_IMPORT` to `1`, `true`, `yes` or `on`. This is a deliberate fail-closed choice, and it changes deploy behaviour: if import is currently used in production, the variable must be set before this ships.

**Confirm the telemedicine status vocabulary.** Intake cases are now created with `status: 'open'`, which is the only value the check constraint permits for a new case. If downstream screens or reports expect the old (never-persisted) `in_progress` or `triaged` values, they were reading data that could never exist — but the expectation should be confirmed rather than assumed.

**Confirm that lab-result notification is self-service only.** The route can no longer notify a different user. If staff-initiated notification is a real workflow, it needs a capability-gated route of its own; the current endpoint deliberately does not accept the parameters that would allow it.

**Confirm the credit-ledger idempotency contract.** Repayments now require an `Idempotency-Key`, which the portal already sends. Any other client — a script, a mobile build, an integration — that posts repayments without the header will receive 400.

**Decide the Vercel branch policy.** The build gate as it stands in the working tree builds production and the recognised preview families and skips unrecognised branches. Its own docstring says "all environments build", so the code and the comment disagree. The test now pins the code's behaviour. Someone who owns deployment should decide which is intended and fix the other.

---

## Part 7 — Conflicts with pre-existing local changes

The tree already contained substantial uncommitted work before this remediation began. Where that work overlapped a finding, the existing change was treated as authoritative and left alone; the tests were corrected instead.

`scripts/vercel-build-gate.mjs` is user-modified and was **not edited**. Its behaviour skips branches outside the recognised families, its docstring says otherwise, and `scripts/vercel-build-gate.test.mjs` previously asserted the docstring. The test was rewritten to pin the code, with the inconsistency recorded in Part 6 rather than resolved unilaterally.

`.github/workflows/release.yml` is user-modified, including a provenance rewrite in the step region. Only the deployment smoke step was changed, and the surrounding provenance work was left intact.

`package.json` is a shared file. Its pre-existing user changes — the `pg` dev dependency, `test:db-acl:strict`, and the lockfile that accompanies them — were left in place. This session's edits are purely additive: a new `test:hardening` script, an extended `test:workflow-safety`, and an extended `test:security-gates`.

`scripts/check-db-acl.mjs`, `scripts/check-db-acl.test.mjs`, `scripts/check-db-acl.integration.test.mjs`, `scripts/release-provenance.mjs`, `scripts/release-provenance.test.mjs`, `apps/web/src/app/api/clinical/intelligence/advise/route.ts`, `apps/web/src/lib/clinical-intelligence/*`, `apps/pharmacy/vitest.config.ts`, `.vscode/mcp.json` and `.mcp.json` are all pre-existing local work and were not touched.

The five `apps/web` typecheck errors that existed at baseline were all in the user-modified clinical-intelligence route, which queries a `feature_flags` table missing from the generated types. Rather than editing that route, the table was added to `packages/db/src/types.ts` — a mechanical, additive change to a file that was clean in the working tree, matching the shape of the neighbouring tables.

No file was stashed, reverted, checked out, cleaned, rebased or amended. No history was rewritten. No untracked file was overwritten.

---

## Part 8 — Recommended next steps

The shortest path from this working tree to a defensible release runs in this order.

First, run `bash scripts/db-tests/run-rls-isolation.sh` on a machine with Docker and capture the output. That single run converts the largest open question in this handover from "prepared" to "proven", and it exercises the real migration file, not a copy.

Second, run `npm run verify:web` to completion somewhere with enough time, since the web production build is the one gate this session could not close.

Third, review the diff. This session modified 20 tracked files and added 16 new ones; the highest-value reads are the telemedicine route (group C, where the old code silently persisted nothing), the import guard (group D), and the repair migration (group B). The remaining changes are small and local.

Fourth, once the repair is proven and reviewed, apply `20261025120000_tenant_isolation_policy_repair.sql` to staging, re-run the harness against a restored copy of production data, and only then schedule production. The migration's own self-check will refuse to complete if the predicate is still wrong.

Fifth, take the two decisions that block deploy-behaviour questions — the import kill switch and the `PUBLIC` policies — before the next release rather than after, because both change what the product does on the day they ship.

Sixth, commit in the grouping used here: the three hardening routes with their tests, the CI and release gate work, the prepared migration with its harness and tests, and the corrected pharmacy tests. Keeping the migration in its own commit makes the production rollout and the code review separable.
