# SynapseOS — Remediation Verification and Closure (2026-10-25)

Scope: verify the remediation recorded in `docs/audits/REMEDIATION_HANDOVER_2026-10-25.md`, fix defects found in that work, and close the locally testable release gates. Nothing was committed, pushed, merged, deployed, or applied to any database. No remote configuration was touched. No software was installed and no service was started.

Bottom line up front: five of the six gates were executed. Three defects in the remediation itself were confirmed and fixed, plus two overstatements in the handover. Every feasible regression suite passes. This document first closed with tenant isolation unproven and the web build incomplete; both have since changed, on 2026-10-25. **The repair executed and passed on a disposable PostgreSQL 16 database, and `npm run verify:web` completed with a fresh `BUILD_ID`.** Neither result came from this sandbox, which has no Docker and could not run either. SEC-01 remains open in every deployed environment, and production isolation is unverified — see §5, §6 and §11.

---

## 1. Starting and ending state

Branch `integration/synapse-2026-10-09`, HEAD `c9e53e37fc2c6a22c1699e4d331b1a05e5ff659f` (2026-10-22). Nothing was committed, staged or stashed at any point, so the starting and ending state are identical in Git terms for this pass: 61 working-tree entries (33 modified, 28 untracked), every one of them preserved. The implementation pass in §11 added six files and edited four, taking the tree to 67 entries; nothing was deleted, reverted or stashed then either.

The handover's "Baseline commit: `485ffaf3`" was wrong. `485ffaf3` (2026-10-02, "fix(pharmacy): atomic credit ledger and till cash (DB-level)") is an ancestor of HEAD, not HEAD. The line has been corrected to name the real branch, HEAD and date.

One side effect is worth recording. Running the evidence gates rewrites the evidence they produce: `artifacts/readiness/route-integrity.json`, `web-route-manifest.json` and `db-acl-inventory.json` were modified at 10:39 by `npm run test:routes` and `npm run test:db-acl` themselves. These are tracked, generated files. They were not reverted, because reverting generated evidence to a stale state is worse than the diff.

---

## 2. Defects confirmed in the new remediation

**D1 — the repair migration omitted its role clause, and its rationale for doing so was backwards.** The ten `tenant_isolation` policies as written have no `TO` clause, which means `PUBLIC`. The migration preserved that by altering only the expressions. But `anon` has no `EXECUTE` on `public.current_tenant_id()`: `20260613104742_lock_down_auth_rls_helpers_anon_execute.sql` revokes it deliberately, and `20260613104631` grants it only to `authenticated` and `service_role`. A policy that calls a function the caller cannot execute does not deny — PostgreSQL raises `permission denied for function current_tenant_id()`. The migration's comment claimed instead that "`anon` loses nothing it actually had", which was false in the direction that matters: it described a clean denial where the actual behaviour would be an error. Fixed by adding `TO authenticated`, and the self-check now fails the migration if the role list is anything but `{authenticated}`.

**D2 — the workflow-independence test claimed something untrue, and passed only because of how it was written.** The test was named "the repair is not applied by any automatic workflow" and grepped `ci.yml`, `deploy.yml` and `release.yml` for the literal migration filename. It passed. But `deploy.yml`'s `db-acceptance` job applies *every* migration whose version is greater than `SNAPSHOT_CUTOFF=20260920190000`, via a glob loop, to the disposable Supabase stack it starts on the runner. `20261025120000` is greater than the cutoff, so the repair **is** applied automatically — to a disposable local database, never to a remote one, but the test's claim and the migration's header ("deliberately not wired into any automatic workflow") were both false. This is exactly the failure mode of a security test that asserts the shape of a file instead of a property of the system. Fixed by rewriting the test around the property that actually matters — no automatic path to a *remote* database — and by pinning the real guards: `db-production.yml` is `workflow_dispatch`-only, requires the literal `PRODUCTION` confirmation, the literal `RECONCILED` attestation and a pinned 40-character SHA, and puts `supabase db push` behind two booleans; `deploy.yml` applies migrations only through `psql -h 127.0.0.1 -p 54322` and never uses `supabase db push`, `--linked` or `SUPABASE_DB_URL`.

**D3 — the handover's SEC-02 paragraph was wrong on both specifics.** It said `products`, `hospital_drug_orders` and `consult_queue` carry `PUBLIC` policies with `USING (true)`. `hospital_drug_orders` carries no such policy — only `platform_admin_bypass` and the tautology. Worse, it treated the canonical snapshot as the current state: `20261003160000_profiles_privileged_columns_guard.sql` already **drops** `Public read products`, `queue_read_by_token` and `Public read restaurants`, so in source the chain has no world-readable policy on those tables. Whether that migration is applied anywhere is a separate, unverified question. Corrected in the handover, in the migration's comment, and in the harness, which now exercises both states.

**D4 — the harness could not have falsified the defect it exists to prevent.** It created the pre-repair policies with no role clause but granted function `EXECUTE` to `PUBLIC` by default, so `anon` *could* execute `current_tenant_id()` in the harness and the `PUBLIC`-scope trap was invisible. It also never covered an authenticated caller with no JWT subject, a profile with a `NULL` tenant_id, platform-admin bypass, service-role bypass, anonymous read on `products`, or the absent-policy path. A harness missing those cases would have passed while D1 survived. Rewritten (see §3).

**D5 — the runner could silently test the wrong server.** `PGPORT="$(docker port … | awk -F: '{print $NF}')"` yields an empty string if `docker port` returns nothing, and psql then falls back to 5432 — possibly an unrelated local server. The readiness loop could fall through its 30 iterations without failing, and the script neither preflighted `psql`/`pg_isready` nor cleared inherited `PG*`/`DATABASE_URL` variables. Hardened (see §3).

**D6 — a pharmacy test passed vacuously.** Recorded for completeness: the "rejects a repayment when nothing is owed" test was getting its 400 from the missing-idempotency-key guard rather than from the overpayment branch it claimed to exercise. Rewritten in the earlier segment to send the header and assert `code === "OVERPAYMENT"`; verified green in this pass.

**Investigated and disproven — the UTF-8 BOM.** The working assumption going in was that Excel's "CSV UTF-8" output would break the importer, because `﻿` survives as part of the first header. It does not: ECMAScript's `trim()` removes U+FEFF as whitespace, so `parseCsv`'s `header.map(h => h.trim())` and `normaliseKey`'s `trim()` already handled it. No code change was made to working code; two regression tests pin the behaviour instead (`csv.test.ts`, `map-row.test.ts`), so a future switch to a non-trimming normaliser fails loudly.

---

## 3. Fixes made, with the regression test for each

The migration now issues `alter policy "tenant_isolation" on public.%I to authenticated using (…) with check (…)`. `ALTER POLICY` leaves unmentioned clauses alone, so the rollback template explicitly restores `to public` — otherwise a rollback would silently leave the policy scoped to `authenticated`. The self-check reads `roles` from `pg_policies` and raises if the set contains `public` or `anon`, or omits `authenticated`. Pinned by `rls-tenant-isolation.test.mjs`, test "the repair scopes the policy to authenticated, never to PUBLIC or anon", which also fails if anyone "fixes" this by granting `EXECUTE` to `anon` instead.

The harness (`scripts/db-tests/rls-tenant-isolation.sql`) was rebuilt around the real privilege model and now asserts, in order: that `public.profiles` does not already exist (refusing to run anywhere that looks like SynapseOS); that an authenticated tenant-A user reads and *writes* tenant-B rows on all ten tables (the reproduction); that `anon` gets a clean zero-row denial on nine tables before the repair while the public `products` catalogue still reads (corrected in §10 — the original policies inline the profile subquery, so a function-permission error is what a *bad* repair would produce, not what the defect produces); then, after applying the migration file itself with `\i`: per-table SELECT isolation with correct per-table expectations, cross-tenant INSERT rejected by `WITH CHECK`, cross-tenant UPDATE and DELETE affecting zero rows, same-tenant read/write still working, tenant B retaining its own rows, zero rows with no JWT subject, zero rows for a profile with a `NULL` tenant_id, platform-admin bypass still reaching both tenants, `anon` denying cleanly with the public catalogue intact, `anon` unable to write `products`, `service_role` still bypassing RLS, all ten policies reporting `roles = {authenticated}`, an `is_admin` user reading *and writing* another tenant's `order_items` and a tenant-A clinician reading a tenant-B intake case and message (the SEC-02 bypasses the repair does not fix, demonstrated in step 14b rather than asserted away), idempotent re-application, and neighbouring policies untouched. The absent-policy path is now fail-closed — the migration raises instead of proceeding — so it cannot be exercised inside `\i` without aborting the harness; it is pinned statically instead. It then drops "Public read products" the way `20261003160000` does and requires `anon` to get a clean zero-row deny rather than an error. Pinned by the harness tests in `rls-tenant-isolation.test.mjs`, including a structural check on the `$$` fences and a check that the revoke is applied *before* the repair so the pre-repair state is reproducible.

The runner (`scripts/db-tests/run-rls-isolation.sh`) now preflights `docker`, `docker info`, `psql` and `pg_isready`; refuses to pull `postgres:16-alpine` unless `SYNAPSE_ALLOW_IMAGE_PULL=1`; parses the published port and rejects anything non-numeric; fails explicitly if the server is not ready in 60 seconds, dumping container logs; unsets inherited `PG*`/`DATABASE_URL` variables; uses pure-bash `dirname` so the empty-`PATH` fail-closed test reaches its message; and asserts the presence of specific notices in the captured log so a partially-run harness cannot report success. Pinned by "the runner cannot silently test the wrong server".

The handover and the migration header were corrected on D2 and D3, and the handover's verification table now records 16 tests rather than 8.

---

## 4. Commands run and results

Every command was run from the repository root unless stated. `EXIT` is the shell status of the command itself.

| Command | Result |
|---|---|
| `node --test scripts/rls-tenant-isolation.test.mjs` | EXIT 0 — 21/21 (grown 8 → 13 → 16 → 20 → 21 across passes; see §10, §11) |
| `npx vitest run src/lib/import/{csv,map-row}.test.ts` (from `apps/web`) | EXIT 0 — 32/32 |
| `npm run test:security-gates` | EXIT 0 — 45/45, `SECURITY GATES PASS cutoff=20261003160000 migrations=6 failures=0` |
| `npm run test:workflow-safety` | EXIT 0 — 59/59 |
| `npm run test:hardening` | EXIT 0 — 72/72 across 6 files |
| `npm run test:tenancy` | EXIT 0 — 59/59 across 6 files |
| `npm run test:rls-matrix` | EXIT 0 — 10/10 (see caveat in §7) |
| `npm run test:routes` | EXIT 0 — `Route integrity PASS pages=288 nav_links=73 roadmap=77` |
| `npm run test:db-acl` | EXIT 0 — `definer_functions=66 public_grants=0 possible_implicit_public=20 live_check=SKIPPED_NO_DATABASE_ACL_URL` |
| `npm run test:secrets` | EXIT 0 — `Secret scan PASS` |
| `npm run type-check` | EXIT 0 — 3/3 tasks successful |
| `npm run lint` | EXIT 0 — 2/2 packages, `--max-warnings 0` |
| `npx vitest run` (from `apps/pharmacy`) | EXIT 0 — 60 files passed, 5 skipped; 555 tests passed, 15 skipped |
| `npm run db:check` | EXIT 0 — 193 migration files OK |
| `npm run db:history:check` | EXIT 0 — `remoteReconciliation: BLOCKED_OPERATOR_CONTROLLED` |
| `npm run verify:web` | **NOT COMPLETED** — see §6 |
| `bash scripts/db-tests/run-rls-isolation.sh` | **NOT RUN** — exits 2 with `CANNOT PROVE`, no database available |

The five skipped pharmacy files are database-backed integration tests gated on `SUPABASE_URL`/`SUPABASE_SERVICE_ROLE_KEY`; their skip messages say so. They are not evidence of anything and are not counted as passes.

---

## 5. Was tenant isolation proven by a real local PostgreSQL test?

**Yes — once, on a disposable PostgreSQL 16 database, on 2026-10-25. Production remains unproven.** The answer was "No" when this section was written, and the reason was environmental: this sandbox has no `docker`, no `podman`, no `psql`, no `pg_isready`, no `postgres`, `initdb` or `pg_ctl`, no Docker socket, and nothing listening on 5432–5439. The migration was never applied to any shared or production database, and no connection was attempted to one.

The run therefore happened on the owner's machine, not here, through `sg docker`, so the runner could start `postgres:16-alpine` and publish its port. The first attempt failed at step 5b — `anon saw 2 rows in encounter_orders before the repair (expected a clean zero-row denial)` — and the cause was a defect in the harness, not in the migration: `auth.uid()` reads the session-scoped custom setting `request.jwt.claim.sub`, and `SET ROLE anon` does not reset custom settings, so after step 5a set the subject to tenant A every "anon" block still ran as tenant A and the tautology matched. All three anonymous blocks now clear the claim explicitly, and `scripts/rls-tenant-isolation.test.mjs` fails if a future block does not. The second run passed end to end, steps 1–19, exit 0, including everything past step 5b that had never executed: the repair applied and self-checked, cross-tenant reads and writes denied on the nine tables with no neighbouring permissive policy, `products = 2` because `"Public read products"` still exists at that point in the chain, and steps 18–19 applying `20261026130000` and `20261026120000`.

What that result proves: the `ALTER POLICY … TO authenticated` and the compiled `WITH CHECK` behave as intended on PostgreSQL 16; the repaired `WITH CHECK` rejects cross-tenant inserts; `anon` receives a clean zero-row denial and not `permission denied for function`; and the residual bypasses (an `is_admin` user, a clinician holding a staff role) are reproduced as notices by step 14b rather than assumed away.

What remains unproven is narrower, and it is about production data rather than SQL behaviour: that the migrations apply cleanly to the production schema and its real policy set; that no existing row carries a `NULL` or orphaned `tenant_id` and would vanish from every authenticated reader once the predicate tightens; and that no production writer depends on the pre-repair behaviour. The read-only preflight `scripts/db-tests/nulls-preflight.sql` answers the second question and has still not been run against any authorised target. A disposable database built from the snapshot and the migration chain is strong evidence about the SQL and no evidence at all about the data.

---

## 6. Did the web production build complete?

**Yes, on 2026-10-25 — after this section was first written as "No".** `scripts/verify-web-build.mjs` (type-check for `@synapse/web`, then `sync-web-public`, then `next build`) exited 0 and wrote `apps/web/.next/BUILD_ID` = `znUjguphgKrqcZ3WaKwsg`, with `.next` repopulated between 12:37 and 12:40. That script and the `build --workspace @synapse/web` invocation compile the same source through the same Next.js 15.5.19 toolchain, so the earlier failures were an artefact of how the build was invoked — foreground runs killed at the 168-second command ceiling, and `setsid nohup` children reaped when their calling shell returned — not a property of the codebase.

What the result does and does not establish: it is a completed production build of this working tree, so the current revision is corroborated locally. It is not the artifact CI or Vercel will build, and it does not make production deploys gated on CI (B3). At the time of the first three attempts `apps/web/.next` held no `BUILD_ID` at all and its directory mtime was 2026-10-22 16:09; that was true then and is no longer true.

Kept for the record, the earlier attempts: the foreground `npm run build --workspace @synapse/web` reached Next.js startup, reported `Environments: .env.local` and the `serverActions` experiment, and was killed at the 168-second command ceiling with no compilation output (exit 124); two detached `setsid nohup` attempts were reaped and left no exit marker, their logs stopping inside the type-check step.

---

## 7. Remaining release blockers

Keeping the five evidence categories apart, as required:

*Source migration existence.* The repair, the `20261003160000` guard, `20261026120000` and `20261026130000` all exist and `db:check` accepts all 193 files. This is the only category with a positive answer that needs no caveat.

*Migration application.* Unknown. `db:history:check` reports `BLOCKED_OPERATOR_CONTROLLED` because no linked database is reachable; the count of migrations present in any remote ledger is unverified.

*Effective grants.* Unknown. The static inventory reports 0 public grants and 20 possible implicit public grants, and the live check is skipped for want of `DATABASE_ACL_URL`.

*Effective RLS behaviour.* Proven on a disposable PostgreSQL 16 database on 2026-10-25; unproven on production, per §5.

*Application-level behaviour.* Verified by test only, in the places tested, against in-memory fakes.

**B1 — SEC-01 is open in every deployed environment.** The ten tautological policies are unchanged wherever the repair has not been applied. Nothing in this pass changed that.

**B2 — the repair is proven on a disposable database only.** It executed and passed on a disposable PostgreSQL 16 database on 2026-10-25; production application remains unverified. CI's `db-acceptance` job will still execute it against the disposable stack on the next push to main.

**B3 — production deploys are still not gated on CI.** The Vercel Git integration builds on its own trigger and does not wait for GitHub Actions. The only CI-gated deploy path is `deploy.yml`'s `deploy-vercel` job, which requires `needs: [verify, db-acceptance]` *and* `vars.ENABLE_VERCEL_CLI_DEPLOY == 'true'`. Whether production traffic moves through that job or through Git integration is a dashboard fact that source cannot answer. `vercel-build-gate.mjs` builds unconditionally whenever `VERCEL_ENV=production` and never inspects the branch, so the production branch itself is a Vercel project setting with no representation in the repository.

**B4 — the repair does not, on its own, isolate the ten tables.** Permissive policies are OR'd, and `platform_admin_bypass` (intended) and the telemedicine `*_user_read` / `*_user_update` policies, which test only whether the caller holds a staff role, remain in the chain and are dropped by nothing. An `is_admin` user in tenant A still reads tenant B's products, order items and gas cylinders on the repair alone, and any clinician still reads every tenant's telemedicine cases and messages. `20261026130000_scope_admin_policies_to_tenant.sql` closes the `is_admin` path by adding `tenant_id = public.current_tenant_id()` and an `is_admin` existence test to both clauses of the five `Admins full access …` policies; it is prepared and unapplied. The staff-role path is the subject of the held file and is not closed by anything in the applied chain. The repair removes the anonymous and unaffiliated-user path; it does not achieve the isolation the audit described.

**B5 — telemedicine intake wrote no tenant; closed in source, unapplied.** The route persists through the service-role client with no JWT, so `auto_set_tenant_id()` leaves `tenant_id` NULL on both tables. Three changes now address it: the route resolves the caller's tenant from `profiles`, ignores any tenant in the request body, and threads the *case's* tenant into appended messages; `20261026120000_telemedicine_intake_tenant_ownership.sql` adds `BEFORE INSERT` triggers that fill `tenant_id` from the case owner or the parent case, so a service-role write can no longer land NULL; and the route warns when no tenant resolves rather than failing silently. None of this is applied to any deployed database, and O3 — which tenant a patient-initiated case belongs to when the patient has no profile tenant — is still an owner decision.

**B6 — the local build artifact is not the released one.** `apps/web/.next` now carries `BUILD_ID` = `znUjguphgKrqcZ3WaKwsg` from `verify:web` on 2026-10-25, so the working tree does compile. That does not corroborate release provenance: the deployed artifact is built by CI or Vercel from a commit, not from this tree, and nothing in the repository ties the two together.

**B7 — `npm run test:rls-matrix` is not RLS evidence.** Its principal test asserts a hand-written `RLS_MATRIX` table against itself; it cannot fail if the database contradicts it. It passes, and it should not be quoted as proof of behaviour. Its companion tests, which read the canonical dump and the `app_rw_*` drop migration, are real.

---

## 8. Minimum owner decisions required

**O1 — authorize one disposable PostgreSQL run.** Done: authorised, executed and passed on 2026-10-25 (§5, §11). What still needs an owner is a read-only authorised target for `scripts/db-tests/nulls-preflight.sql` — a replica, staging, or a restored copy — because the NULL-tenant question is a question about production data, not about SQL behaviour.

**O2 — should `profiles.is_admin` and staff-role policies be tenant-scoped?** Tightening them changes which records a facility administrator and a clinician can see, which is a clinical-workflow decision, not a repair.

**O3 — do patient-initiated telemedicine cases belong to a tenant, and which?** Until this is answered the intake route cannot write a `tenant_id`, and B5 cannot be closed.

**O4 — should the unused tables be removed?** No application code references `products`, `consult_queue` or `restaurants`; they are commerce-era schema. Dropping them removes the whole SEC-02 surface on those tables more cleanly than policy surgery.

**O5 — must production Vercel deploys wait for CI?** Either the Git integration is disconnected and `ENABLE_VERCEL_CLI_DEPLOY` becomes the only path, or deployment protection is configured to require the check. Source cannot decide this.

---

## 9. Files changed during this pass

Changed by this pass (7):

| File | Change |
|---|---|
| `supabase/migrations/20261025120000_tenant_isolation_policy_repair.sql` | `TO authenticated`; roles self-check; corrected anon and products rationale; verified rollback template; honest statement of where the migration runs |
| `scripts/rls-tenant-isolation.test.mjs` | 16 tests (was 8); added role-scope, harness-fidelity, structural, runner-safety and workflow-property tests; rewrote the overclaiming workflow test |
| `scripts/db-tests/rls-tenant-isolation.sql` | Rebuilt: real privilege model, clean pre-repair anon denial, SEC-02 neighbour policies and step 14b bypass demonstrations, both snapshot and post-guard states |
| `scripts/db-tests/run-rls-isolation.sh` | Port validation, hard readiness failure, client-tool preflight, env isolation, image-pull authorization, log assertions |
| `apps/web/src/lib/import/csv.test.ts` | BOM regression test |
| `apps/web/src/lib/import/map-row.test.ts` | BOM regression test |
| `docs/audits/REMEDIATION_HANDOVER_2026-10-25.md` | Corrected baseline commit, SEC-02 scope, snapshot-vs-chain state, workflow claim, test count |

Regenerated as a side effect of running the gates, not edited: `artifacts/readiness/route-integrity.json`, `artifacts/readiness/web-route-manifest.json`, `artifacts/readiness/db-acl-inventory.json`.

Files changed in the later implementation pass (§11), not in this table: `supabase/migrations/20261026120000_telemedicine_intake_tenant_ownership.sql` (new), `supabase/migrations/20261026130000_scope_admin_policies_to_tenant.sql` (new), `supabase/held/scope_staff_intake_policies_to_tenant.sql` (new, held, moved out of the applied chain), `scripts/db-tests/nulls-preflight.sql` (new), `apps/web/src/app/api/tele/intake/route.ts` and its test, `apps/web/src/app/api/mobile/pharmacy/pos/complete-sale/route.ts` and its new test, and `scripts/db-tests/rls-tenant-isolation.sql` with `scripts/rls-tenant-isolation.test.mjs` for the JWT-claim fix.

Pre-existing work from the earlier remediation, verified but not re-authored here: the import guard and four import routes, telemedicine intake route and page, lab-notify and insurance-copilot changes, POS and credit-ledger changes, `packages/db/src/types.ts`, the CI and release-gate changes, and the new tests under `apps/web/src/app/api/`, `apps/web/src/lib/insurance/`, `scripts/release-*`, `scripts/e2e-*`.

---

## 10. Addendum — harness-correction pass, 2026-10-25

A focused pass over the migration, the harness and its runner found seven defects in the *verification* apparatus — none of them a database result, because no database exists here. They are recorded because each one would have produced a false verdict on the first real run.

**The pre-repair anonymous assertion was wrong.** The harness expected `permission denied for function current_tenant_id()` before the repair. Impossible: the original policies inline the profile subquery, `auth.uid()` is NULL for `anon`, the subquery returns no row and the predicate is NULL — a clean zero-row denial. Expecting an error would have failed the run for a reason that never existed. Now asserted as zero rows on nine tables with `products = 2`, and the function-permission trap is attributed where it belongs: to a repair that changes the predicate but omits `to authenticated`.

**The `products` expectation after `\i` ignored a surviving policy.** `"Public read products"` is `USING (true)` at that point in the chain, so a correct repair still leaves two rows visible to tenant A and to an unauthenticated session. The loop asserted zero and would have aborted on correct behaviour. Now per-table expectations (`2` for `products`, `1`/`0` elsewhere), with related assertions left untouched.

**The self-check was negative-only.** It rejected a surviving self-reference and a missing `WITH CHECK`, so `USING (true)` would have passed every check. It now also requires `position('current_tenant_id' in r.qual) = 0` and the same for `with_check`.

**Hygiene.** The migration's alterations and its self-check are now a single `do $$ … $$;` statement, which is atomic under every applier — psql autocommit, `psql -v ON_ERROR_STOP=1 -f`, `\i`, and `supabase db push`. Explicit `begin;`/`commit;` was rejected on review: the Supabase CLI already wraps each migration file, so a `COMMIT` inside the file would end that wrapper early. A missing policy now aborts (`raise exception` over the collected `v_missing` array) instead of emitting a notice and continuing with a partial repair; re-application stays idempotent because `ALTER POLICY` is.

**Fixture fidelity.** The harness models `Admins full access products/items/cylinders` (verified against the snapshot) and the six `telemedicine_intake_*_user_*` policies (verified against `canonical_public_schema.sql:23051–23087`), plus `auth.role()`. Step 14b proves, after a correct repair, that an `is_admin` user in tenant A reads *and writes* tenant B's `order_items`; that a tenant-A clinician reads a tenant-B intake case and its message; and that a tenant-B patient can create an intake case labelled with tenant A's `tenant_id`, because `telemedicine_intake_cases_user_insert` carries no tenant clause and permissive `WITH CHECK` policies are OR'd. The runner now refuses to report success unless all three notices appear. These are the residual exposures of §7, reproduced rather than described, and no clinical or administrative access rule was altered to make them go away.

**NULL tenancy.** The migration header now carries a read-only pre-flight (per-table `count(*) filter (where tenant_id is null)` plus an orphan-tenancy check) that has not been run against any database, and states the product decision it implies: a `NULL`-tenant row is invisible to every authenticated reader once the predicate tightens, and a service-role writer with no JWT leaves `tenant_id` NULL through `auto_set_tenant_id()`.

Results of that correction pass were static file checks only: the RLS suite stood at 16 tests at the time (13 before it), and the gate reported `migrations=4`. The counts moved afterwards — the authoritative, machine-generated figures are those recorded in `artifacts/readiness/evidence.json` and cited in §11, not any number restated here.

---

## 11. Addendum — implementation pass and the first real database run, 2026-10-25

This section records what happened after §10 was written, because §5, §6, B4, B5, B6, O1, §9's file list and "Next action" all described the state before it.

**The harness ran, failed for its own reason, was fixed, and passed.** The disposable-DB run executed for the first time on the owner's machine (Docker via `sg docker`; this sandbox still has neither). It failed at step 5b: `reproduction failed: anon saw 2 rows in encounter_orders before the repair`. The migration was not at fault — `SET ROLE` does not reset the session-scoped `request.jwt.claim.sub`, so "anon" inherited tenant A's subject and the tautology matched. All three anonymous blocks now clear the claim, and the static test fails if a future block does not. The second run passed, exit 0, through step 19.

**Two prepared migrations, one genuinely held file, one unrun preflight.** `20261026120000_telemedicine_intake_tenant_ownership.sql` adds SECURITY DEFINER `BEFORE INSERT` triggers that fill `telemedicine_intake_cases.tenant_id` from the owner and `telemedicine_intake_messages.tenant_id` from the parent case, with `EXECUTE` revoked from public and self-checks on `pg_trigger` and `pg_proc`. `20261026130000_scope_admin_policies_to_tenant.sql` scopes the five `Admins full access …` policies to `authenticated` and `current_tenant_id()` in both `USING` and `WITH CHECK`, altering in place rather than dropping and recreating, and aborts if any expected policy is missing. The staff-intake policies are **held and not applied**: the file lives at `supabase/held/scope_staff_intake_policies_to_tenant.sql`, outside every glob, and the static test asserts both that it exists there and that it is absent from `supabase/migrations/`. `scripts/db-tests/nulls-preflight.sql` is read-only and has not been run against any database.

**A hazard worth naming.** The held file was first written into `supabase/migrations/` with a timestamp prefix, where `deploy.yml`'s glob would have applied it on the next push to main and `supabase db push` would have shipped it. A "HELD" banner is not a control; sitting outside every applying glob is.

**Application fixes.** `api/tele/intake` resolves the caller's tenant from `profiles`, ignores a body-supplied tenant, and threads the owned case's tenant into appended messages rather than the caller's current one. `api/mobile/pharmacy/pos/complete-sale` UUID-validates then tenant-owns the patient id before calling the RPC, and returns 404 rather than 403 for a foreign id so it does not confirm existence. Both are covered: 10 intake tests, 4 POS tests.

**Results at the end of this pass.** The figures are generated into `artifacts/readiness/evidence.json` and reproduced in the block below; no count is restated by hand, and `scripts/evidence-drift.test.mjs` asserts the block matches the file exactly.

<!-- evidence:begin -->
source: artifacts/readiness/evidence.json
timestamp: 2026-10-31T17:02:42.789Z
git.branch: feat/clinical-intelligence-land
git.head: dd5c68d276d130f43b3b7516f67f3d7fa58a87b2
migrationCount: 201
suites.rls-tenant-isolation.tests: 21
suites.security-gates.banner: SECURITY GATES PASS cutoff=20261003160000 migrations=14 failures=0
suites.security-gates.exitCode: 0
suites.hardening.tests: 74
suites.tenancy.tests: 59
suites.workflow-safety.tests: 60
suites.rls-matrix.tests: 10
dbAcl.definerFunctions: 73
dbAcl.publicGrants: 0
dbAcl.possibleImplicitPublic: 21
dbAcl.liveCheck: SKIPPED_NO_DATABASE_ACL_URL
routeIntegrity.pages: 289
routeIntegrity.navLinks: 73
routeIntegrity.roadmap: 77
disposableDb.result: not_provided
<!-- evidence:end -->

`npm run verify:web` completed with a fresh `BUILD_ID` (see §6). Nothing was committed, pushed, merged, deployed, or applied to any deployed database, and no production connection was attempted.

---

## 12. Addendum — A5 root cause: bootstrap default privileges, 2026-10-25

**A5 was a bootstrap defect, not a migration defect, and it is now fixed at the root.** The first chain build reported that `anon` could execute `public.current_tenant_id()`. The snapshot is not at fault: `canonical_public_schema.sql:24148–24150` does exactly the right thing — `REVOKE ALL ON FUNCTION public.current_tenant_id() FROM PUBLIC`, then `GRANT ALL` to `authenticated` and `service_role` only, with no `anon` grant anywhere in the file. The chain is not at fault either: `20260613104742` is pre-cutoff by design and its effect is supposed to be baked into the snapshot.

The defect was in `scripts/db-reset-fresh.sh`, which ran, before applying the snapshot:

```
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON FUNCTIONS TO postgres, anon, authenticated, service_role;
```

`ALTER DEFAULT PRIVILEGES` attaches an ACL entry to every function created afterwards by the executing role, so each `CREATE FUNCTION` in the snapshot came out with an `anon` grant. The snapshot's `REVOKE … FROM PUBLIC` removes the `PUBLIC` pseudo-grant — a different entry — and does not touch `anon`'s. Production never ran that script, so production has the state the snapshot describes and the disposable stack did not.

That makes A5 a symptom of something larger than A5: **fresh and CI databases granted `anon` EXECUTE on every function the snapshot creates**, including ones the snapshot deliberately restricts to `service_role` — `adjust_pharmacy_batch_stock` is revoked from PUBLIC and granted to `service_role` only, and on a bootstrapped database `anon` could call it. So `db-acceptance` had been proving things about a database whose function ACLs were materially weaker than production's, and any anon-permission claim from that stack was void. This is stated by construction — the mechanism is the ordering of `ALTER DEFAULT PRIVILEGES` before `CREATE FUNCTION` — not as a suspicion.

**The remedy is in the bootstrap, not a new migration:**

```
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON FUNCTIONS TO postgres, authenticated, service_role;
```

Dropping `anon` loses nothing legitimate: every function that should be anon-callable already carries an explicit `GRANT … TO "anon"` in the snapshot, and explicit grants still apply. The TABLE and SEQUENCE default-privilege lines are unchanged. A four-function revoke migration was deliberately rejected: it would fix four symbols, leave the other sixty-odd divergent, and turn a bootstrap bug into permanent chain history.

**How this was verified.** The disposable stack was rebuilt from scratch with the same `db-acceptance` recipe (`FRESH_BOOTSTRAP_OK`; 24/24 post-cutoff migrations exit 0). Assertions A1–A4 pass as before, and A5 now passes:

- `select has_function_privilege('anon', 'public.current_tenant_id()', 'EXECUTE');` → `f`
- `select has_function_privilege('anon', 'public.adjust_pharmacy_batch_stock(uuid,uuid,integer,text,text,uuid,uuid,text,date,numeric,text)', 'EXECUTE');` → `f`
- the same call for `authenticated` → `t`

`scripts/db-tests/run-rls-isolation.sh` was then re-run on a fresh disposable container: exit 0, "RLS tenant-isolation proof PASSED on a disposable database". No local dev or test flow broke; the narrowed default only removes a grant nothing legitimate relied on. A static guard, `scripts/db-reset-fresh.test.mjs` (wired into `test:security-gates`), fails if `anon` reappears in the FUNCTIONS default-privilege line.

**Why the fixture harness never caught this.** `rls-tenant-isolation.sql` revokes `anon`'s EXECUTE itself as part of its own fixture, so it models the intended state rather than inheriting the bootstrap's. Phase 1.1 was the only check positioned to catch the bootstrap divergence, and it did.

---

## Next action

The disposable-database proof is done; nothing further here is a static exercise. Three owner-controlled actions remain, in order.

First, run `psql -X -v ON_ERROR_STOP=1 -f scripts/db-tests/nulls-preflight.sql` against an authorised read-only target — a replica, staging, or a restored copy — and record the per-table NULL counts. That decides whether the repair needs a backfill before it can be applied anywhere real, and it is the one question a disposable empty database cannot answer.

Second, schedule `20261025120000`, `20261026130000` and `20261026120000` for staging. The only path with an attestation gate is `db-production.yml`'s manual dispatch, which requires the literal `PRODUCTION` confirmation, the literal `RECONCILED` attestation and a pinned 40-character SHA; nothing in this pass touched it.

Third, decide O2 and O3 before `supabase/held/scope_staff_intake_policies_to_tenant.sql` is reinstated with a fresh timestamp prefix. Until the staff-role policies are scoped, the repair narrows the exposure in B4 but does not close it, and SEC-01 should not be marked fixed on the strength of the disposable run alone.
