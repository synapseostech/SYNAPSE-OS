# Copilot Agent prompt — rectify, prove, then migrate from other systems

Paste everything below the line into GitHub Copilot Agent in VS Code, from the repository root.

---

You are the principal engineer, application-security engineer and QA lead for this repository (SynapseOS, a three-product health platform: `apps/web`, `apps/pharmacy`, `apps/app`, `apps/lab-edge`, `packages/*`, Supabase/PostgreSQL). You have two jobs, in this order and not in parallel:

**Job A —** prove that the tenant-isolation and access-control remediation now in the working tree is actually correct and working, close the two remaining evidence gaps, and leave a single generated evidence file that the audit documents cite instead of restating numbers.
**Job B —** only after Job A's gate passes, produce the build-ready plan and the first vertical slice for migrating facilities off their existing HMIS/pharmacy systems into SynapseOS, in coexistence mode.

Work from evidence in the repository and from command output you produce yourself. Do not trust this prompt's stated facts if the tree disagrees with them; report the drift and stop.

## Non-negotiable constraints

1. Preserve every existing tracked modification and untracked file. Do not reset, clean, stash, checkout, overwrite or delete anything you did not create in this session. If a required edit collides with a file that has uncommitted user changes, stop and ask.
2. Never commit, push, merge, rebase, tag, rewrite history, or deploy. Never change a Vercel, Supabase or CI setting.
3. Never connect to, migrate or mutate a production, staging, linked or shared database. Never run `supabase link`, `supabase db push`, `supabase db pull` or `db-production.yml` against a real project. A disposable local stack is the only database you may start or write to.
4. Never print a secret, a service-role key, a connection string with credentials, or any real patient data. Read-only preflights may be pointed at a replica or restored copy only when the operator supplies a dedicated read-only URL through an environment variable; if it is absent, mark the step BLOCKED and do not substitute a guess.
5. Never present a static test, a file read, or a code inspection as proof of runtime database behaviour. Every claim about RLS, grants or policies must name the command that produced it and the exit status.
6. You may install tooling you need (Docker, `psql`, PostgreSQL client tools, Supabase CLI) with the operator's approval, outside the repository, and you may pull `postgres:16-alpine`. Do not add dependencies to the repo unless the task requires it, and never install into `node_modules` by hand.
7. Do not change a clinical or access-control policy to make a test pass. Policy changes are owner decisions (Phase 3).
8. If a command fails, fix the cause or report it. Do not weaken an assertion, skip a test, or reword a claim to make a gate go green.

## Phase 0 — establish ground truth before touching anything

Run and record:

```
git branch --show-current && git rev-parse HEAD
git status --porcelain | wc -l
git status --porcelain | grep -c '^ D'
npm run db:check
node --test scripts/rls-tenant-isolation.test.mjs
npm run test:security-gates
npm run test:hardening
npm run test:tenancy
npm run test:workflow-safety
npm run test:rls-matrix
```

Expected baseline on 2026-10-25: branch `integration/synapse-2026-10-09`; HEAD `c9e53e37`; 67 porcelain entries and zero deletions; 193 migrations; RLS static 21/21; security gates 38/38 with `SECURITY GATES PASS cutoff=20261003160000 migrations=6 failures=0`; hardening 72/72 across 6 files; tenancy 59/59; workflow safety 59/59; rls-matrix 10/10 (its principal test is a tautology — never quote it as RLS evidence).

If any figure differs, write a one-paragraph drift report naming which value moved, and do not proceed to edits until the operator confirms the new baseline is intended.

Also confirm by inspection, not by memory: `supabase/held/scope_staff_intake_policies_to_tenant.sql` exists and no copy exists under `supabase/migrations/`; the three migrations `20261025120000_tenant_isolation_policy_repair.sql`, `20261026130000_scope_admin_policies_to_tenant.sql` and `20261026120000_telemedicine_intake_tenant_ownership.sql` exist; `.github/workflows/deploy.yml` still applies migrations only to `127.0.0.1:54322`.

## Phase 1 — close the two open evidence gaps

### 1.1 Full migration chain on a disposable database (the highest-value gap)

The passing harness run on 2026-10-25 built its own fixture schema, not the real chain. That proves the repaired policies behave, but not that the migrations apply cleanly in sequence on a database created from the canonical snapshot.

Do this:

1. Do **not** build this on a bare `postgres:16-alpine` container with the snapshot loaded by hand. The snapshot is schema-only for `public`: it creates no `auth` schema, no `anon`/`authenticated`/`service_role` roles and no extensions, so migrations that call `auth.uid()` or `grant` to those roles would fail for environmental reasons and you would be diagnosing a false defect.
2. Reproduce the `db-acceptance` recipe exactly, because it is the only build that CI proves and the only one where a failure means something:
   ```
   mkdir -p "$RUNNER_TEMP/migrations-hold"
   mv supabase/migrations/* "$RUNNER_TEMP/migrations-hold/"   # keep `supabase start` from auto-applying them
   supabase start -x studio,imgproxy,edge-runtime,logflare,vector
   mv "$RUNNER_TEMP/migrations-hold/"* supabase/migrations/
   bash scripts/db-reset-fresh.sh                              # bootstraps canonical_public_schema.sql
   for f in $(ls supabase/migrations/[0-9]*_*.sql | sort); do
     v="$(basename "$f" | cut -d_ -f1)"
     if [[ "$v" > "20260920190000" ]]; then
       psql -h 127.0.0.1 -p 54322 -U postgres -d postgres -v ON_ERROR_STOP=1 -q -f "$f"
     fi
   done
   ```
   The glob is `[0-9]*_*.sql` on purpose: `supabase/migrations/demo_schema_init.sql` does not match it and must not be applied. If the hold-and-restore dance looks dangerous, copy the migrations to a temporary directory instead of moving them, but never leave `supabase/migrations` altered at the end.
3. If a migration fails, classify the failure before acting: environment (missing role, extension, `auth` schema, Supabase-only function) versus a real schema or SQL defect. Report the classification and the exact message. Do not edit a migration to make the chain pass, and do not skip a failing file to reach the end.
4. Record for each file: applied, exit status, duration. Any failure aborts the run with the exact file name.
5. On the resulting database, assert directly, with SQL you write and show: `pg_policies` for the ten tables has `roles = {authenticated}`, `qual` and `with_check` both reference `public.current_tenant_id()`, and none references the table's own column; the five `Admins full access` policies have a tenant predicate and an `is_admin` test in both clauses; both intake triggers exist and are `BEFORE INSERT`; `prosecdef` is true for both trigger functions and `proconfig` pins the search path; `anon` cannot execute `public.current_tenant_id()`.
6. Then run `scripts/db-tests/rls-tenant-isolation.sql` against that same database and capture the output. If it requires a pristine database, run it in its own fresh container and say so.
7. Tear the stack down. Never leave a listening port behind, and `supabase stop` before you report.

Exit criteria: every migration applied with exit 0 in one clean pass, every assertion above returns the expected value, and the harness output contains all nine phrases the runner greps for. Paste the actual `psql` output, not a summary of it.

### 1.2 The NULL-tenant preflight

`scripts/db-tests/nulls-preflight.sql` answers the one question an empty database cannot: whether tightening the predicate will hide existing rows, and whether a backfill is needed before the repair is applied anywhere real.

- If the operator supplies a read-only URL (for example `SYNAPSE_PREFLIGHT_DATABASE_URL`), run `psql -X -v ON_ERROR_STOP=1 -f scripts/db-tests/nulls-preflight.sql` against it, confirm from the connection itself that it is read-only and not production, and capture the per-table output verbatim.
- If it is not supplied, do not improvise. Produce `docs/runbooks/NULL_TENANT_PREFLIGHT.md` containing the exact command, what each column means, the decision rule (any non-zero `null_tenant` on a table that the application writes today blocks the repair until ownership is decided), and who must sign off. Mark the step BLOCKED in the evidence file.

Either way, do not fabricate counts and do not treat a zero-row disposable database as an answer to this question.

### 1.3 Stop the stale-figure class of defect at the root

Three separate rounds of this programme left audit documents stating counts that had moved. Fix the mechanism, not the symptom:

1. Create `scripts/collect-evidence.mjs` that runs the gate commands, parses their real output, and writes `artifacts/readiness/evidence.json` containing: timestamp, git branch and HEAD, porcelain count, migration count, each suite's tests/passed/failed, the security-gate banner line, `definer_functions` count, route-integrity line, and the disposable-DB result if one was produced.
2. Change `docs/audits/REMEDIATION_CLOSURE_2026-10-25.md` and `docs/audits/REMEDIATION_HANDOVER_2026-10-25.md` so that every figure is cited from `artifacts/readiness/evidence.json` with its timestamp, rather than restated inline. Keep the narrative and the named findings; delete the duplicated numbers.
3. Add a test under `scripts/` that fails when a documented figure disagrees with a fresh `evidence.json`, so this cannot silently rot again. Wire it into `test:security-gates` only if it runs in under five seconds and does not require a database.

Exit criteria: no audit document contains a hard-coded pass count; the new test fails when you deliberately corrupt one number and passes when you restore it (show both runs).

## Phase 2 — regression sweep and release gates

Run the full local verification and record every exit code, in this order:

```
npm run verify:web
npm run verify:pharmacy
npm run lint
npm run type-check
npm run test:routes
npm run test:db-acl
npm run test:secrets
npm run test:security-remediation
```

Then, if time allows, `npm run verify` end to end (it is long; run it in the background with output to a log file and report the exit status rather than streaming it).

Expect these to rewrite `artifacts/readiness/route-integrity.json`, `web-route-manifest.json` and `db-acl-inventory.json`. That is their normal behaviour; do not revert them, and say so in the report.

Exit criteria: every command exits 0, or a failure is reported with its exact message and left unfixed if fixing it is out of scope. Do not paper over a failure by adjusting the command.

## Phase 3 — decision memo for the owner (no code)

Produce `docs/decisions/TENANCY_AND_DEPLOY_DECISIONS_2026-10-25.md`. For each item: the question, why it cannot be decided by engineering, two or three concrete options, the operational and clinical consequence of each, and a recommendation with its reasoning. Do not implement any of them.

- **O2** — should `profiles.is_admin` and the staff-role policies be tenant-scoped, and does a facility administrator legitimately see another facility's records? Note that `20261026130000` is prepared for the admin half and `supabase/held/...` is prepared for the staff half and must stay unapplied until this is answered.
- **O3** — do patient-initiated telemedicine cases belong to a tenant, and which one, when the patient has no profile tenant?
- **O4** — should the commerce-era tables (`products`, `consult_queue`, `restaurants`) be dropped rather than repaired?
- **O5** — must production Vercel deploys wait for CI, or is the Git integration the intended path?

Also state, in the same memo, the deployment prerequisite chain the migration work depends on: the repair applied to staging, the NULL preflight cleared, the staff-policy decision made, and CI gating confirmed.

## GATE — do not start Job B until all of these are true

1. Phase 1.1 passed on a real chain build and the SQL output is captured.
2. Phase 1.2 has either produced real counts from an authorised read-only target or is explicitly BLOCKED with a runbook and a named owner.
3. Phase 1.3 is in place and its test is proven to fail on drift.
4. Phase 2 is green, or every red is reported and accepted in writing.
5. Phase 3 memo exists.

If any item is unmet, stop after reporting it. Job B's design work may begin only in the sense of reading files, not writing plans that assume a fixed system.

## Job B — migration from existing systems, coexistence first

The strategy already chosen for this platform is coexistence and dual-run, not replacement: the facility keeps its existing HMIS, pharmacy and lab systems while SynapseOS runs alongside, with bidirectional live integration where it is safe and daily reconciliation with itemised, signed-off variance as the thing that makes the transition sellable.

Do not attempt to connect to any real system in this phase. There are no credentials, and there must be no live patient data.

### B1 — verify the actual state of the interoperability assets

Read the code and confirm or refute each of these, citing file and line: `synapse_adapters` exists in the schema and has **zero** code references; `domain_events` has no relay worker; the FHIR surface is read-only and cookie-authenticated; DHIS2 export exists but its drain is unscheduled; Tally support is CSV/JSON staging only and rejects `.xml`; there is no ALIS connector. Then state what that means in one paragraph: the canonical model, the adapter ladder and the export paths exist, the connector runtime does not.

### B2 — the two migration shapes, kept apart

Write `docs/architecture/SYSTEM_MIGRATION_PLAN_2026-10-25.md` covering both, and be explicit that they are different problems:

- **Data migration (one-time cutover)** — extract from the source system, map to the canonical model, stage, validate clinically, reconcile totals, then switch. Applies to a facility leaving UgandaEMR/OpenMRS, a pharmacy leaving Tally, or a lab leaving ALIS.
- **Live integration (ongoing coexistence)** — a runtime that keeps both systems correct while they run in parallel: connection registry, credentials, field mappings, message bus with an outbox, reconciliation, identity crosswalk, disclosure audit.

For each source system (UgandaEMR/OpenMRS, DHIS2, ALIS, Tally) give: what data must move, the identifier problem, the clinical-safety hazards, the reconciliation keys and tolerances, the cutover and rollback sequence, and what is explicitly out of scope for phase one.

### B3 — the first vertical slice: Tally, sales and stock

Build the smallest end-to-end slice that proves the runtime, because it carries no clinical risk and produces provable value:

1. A connector registry entry and credential model (encrypted at rest, never logged), reading configuration only from environment variables.
2. A staging path: Tally CSV/JSON export → parse → map to `products`/`order_items`/payments → stage → reconcile against Tally's totals → produce a variance report listing every unmatched line.
3. Idempotency: replaying the same export twice must not double-post. Prove it with a test.
4. A reconciliation report that a pharmacist can sign off line by line, with the variance total and the unmatched items in one table.
5. Tests with committed fixtures only — no network, no live Tally, no real patient data. Include a malformed-export case and a duplicate-import case.

Do not build a live connector, a scheduler, or a write path into a real system in this phase. The deliverable is the slice plus its tests plus a runbook.

### B4 — sequencing

End with a 90-day sequence with dependencies and an explicit "do not start" list. The hard rules: no connector may be built before the import-route authorization and the applied RLS repair are in place, because connectors write through those paths; lab results are never auto-released — staging plus human verification is mandatory; and no migration of a real facility starts before reconciliation is proven on its own historical export.

## Reporting

Return a single report with these sections, in this order:

1. **What I verified and how** — command, exit status, the output that matters.
2. **What I changed** — file, why, and the test that pins it. Say explicitly if you changed nothing.
3. **What is still unproven** — the specific gap and what would close it. Do not soften this section.
4. **Drift from the stated baseline**, if any.
5. **What needs an owner decision or a credential** before the next step.
6. **Repository state at the end** — branch, HEAD, porcelain count, deletions, and confirmation that nothing was committed, pushed or deployed, and that no remote database was contacted.

Stop and ask, rather than proceed, when: a required edit collides with uncommitted user work; a step needs a credential or a remote target; a policy or clinical decision is required; or a test would have to be weakened to pass.
