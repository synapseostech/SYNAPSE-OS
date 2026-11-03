# Disposable acceptance environment: database, browser, and Tally validation

Status: **REBUILT AND RUNNING — database suites pass (2026-11-02).** The
acceptance project `jbojujxpyxsdiukmrwzs` was rebuilt from this repository's
canonical snapshot plus every migration after the snapshot cutoff (section 2.2).
The refund, RLS and concurrency suites have run against it over PostgREST.
Browser acceptance (section 6) and Tally acceptance (section 7) have not run.

This is the environment counterpart to
[`../runbooks/PRODUCTION_ACCEPTANCE_SETUP.md`](../runbooks/PRODUCTION_ACCEPTANCE_SETUP.md),
which covers the GitHub `production-acceptance` environment and the Vercel
Preview variables. Read that first for secrets placement; read this one for
target validation, the database suites, cleanup, and what a pass proves.

---

## 1. Invariants

These hold for every command in this document.

| Invariant | Enforced by |
|---|---|
| The production project `qfqakzmjatszisuqjwon` is never a target | `resolveAcceptanceTarget`, `assertDisposableDatabaseTarget`, `validateAcceptanceBaseUrl` |
| A remote project is written to only when it is the **declared** acceptance ref | `SYNAPSE_E2E_ACCEPTANCE_PROJECT_REF` must match the URL's project ref |
| Every alias that could redirect a suite elsewhere is cleared first | `run-pharmacy-db-remote.sh` unsets `SUPABASE_*`, `DATABASE_URL`, `PG*`, `SUPABASE_ACCESS_TOKEN` |
| No env file is loaded | the runners require explicitly exported variables; they never read `.env.local` or `.env.e2e-acceptance` |
| No secret is printed | target block shows binding, role and ref only |
| Validation runs before the first write | `e2e-acceptance-db-target.mjs --probe --schema` |
| Test rows are marked synthetic | tenant `is_synthetic=true`, `data_classification='synthetic'`, `environment='demo'` |
| Cleanup cannot reach real data | filter on the two synthetic columns plus an operator-supplied `--created-after` |

Two consequences worth stating plainly:

- `.env.e2e-acceptance` in the repository root **must not be sourced** for these
  runs. It is gitignored, its credentials are stale, and a stale file that
  happens to point at another project is exactly the failure mode the guards
  exist to catch.
- The Bash tool in this workspace has no DNS. Reachability probes and every
  suite run belong in a host shell (the desktop terminal tab uses host
  networking). A probe that exits 2 with `network unreachable` in the sandbox
  says nothing about the project.

---

## 2. Current state (2026-11-02)

| Check | Result |
|---|---|
| `getent hosts jbojujxpyxsdiukmrwzs.supabase.co` | resolves |
| `supabase projects list` | `synapse-e2e-acceptance`, org `rjbwiwscdgnelipidood`, created 2026-09-19 06:49:05 |
| `.env.e2e-acceptance` | present, gitignored, **current**: both keys decode to ref `jbojujxpyxsdiukmrwzs` |
| `node scripts/e2e-acceptance-db-target.mjs --probe --schema` | **exit 0**: auth `200`, REST `200`, 342 tables, 65 RPCs, 19 required objects, missing none |
| `refund` suite | **20 passed, 0 failed**, exit 0 |
| `rls` suite | **14 passed, 0 failed**, exit 0 |
| `concurrency` suite | **11 passed, 0 failed**, exit 0 |
| Direct-SQL catalog check (tables, RLS, grants, function `search_path`, triggers, ledger) | **run twice** — all tables present, no `is_admin` policy, anon EXECUTE 34; the one `search_path` regression found on the first run was fixed and the migration re-applied, and the second run is clean (section 2.3) |
| Preview deployment / browser acceptance | not recreated; **NOT RUN** |

Interpretation: the project is live, its credentials are valid, and its schema
was rebuilt from this repository on 2026-11-02 (section 2.2). The database
suites now run against a hosted PostgREST rather than only localhost/WASM.
Production was never a target.

### 2.1 Migration history divergence (historical, before the rebuild)

This section records why the project had to be rebuilt. It no longer describes
the current schema.


`supabase migration list --project-ref jbojujxpyxsdiukmrwzs` returns 309 rows:
**209 local-only, 100 remote-only, 0 in both.** The repository's 209
timestamped migrations and the remote `supabase_migrations.schema_migrations`
ledger share not a single version.

The remote versions are clock-time stamps (`20260919152630` … `20260923190654`)
written on 19–23 September; the repository's are round-numbered
(`20260920124500`, `20261102130200`, …). The project was created 2026-09-19
06:49 and stamped from a different migrations directory — most likely a
`db pull` of an earlier schema — not from this chain.

The consequences are not cosmetic. Comparing the 52 function names the chain
creates with the 46 RPCs PostgREST exposes:

- **absent from the project:** the whole pharmacy accounting subsystem
  (`post_pharmacy_accounting_journal`, `post_pharmacy_pos_sale_to_ledger`,
  `post_pharmacy_credit_entry`, `pharmacy_till_record_cash`,
  `pharmacy_accounting_trial_balance`, `seed_pharmacy_accounting_accounts`, …),
  the Tally cut-over lock (`claim_pharmacy_tally_cutover_apply`,
  `release_pharmacy_tally_cutover_apply`), and the tenant guards
  (`pharmacy_assert_actor`, `pharmacy_caller_tenants`);
- **present but long gone from the repository:** an earlier hospital/lab
  surface (`advance_subscription_state`, `claim_next_consult`,
  `get_available_beds`, `match_ucg_guidelines`, `resolve_tenant_from_host`, …).

So this is not a project that is a few migrations behind. It is a database from
an earlier generation of the product, and it cannot be brought to parity by
`db push`: the CLI has no way to reconcile a ledger with no shared version, and
`supabase migration repair` would only record 209 migrations as applied without
their objects existing — falsifying the ledger the suites are supposed to trust.

**The usable path is a fresh project built by `supabase db push` from this
chain** — section 3.1, Case C.

### 2.2 Rebuild method and result (2026-11-02)

The project was rebuilt through the sanctioned fresh-database path rather than
`db push`:

1. `public` and `demo` were dropped and recreated, and the foreign ledger rows
   deleted (the wipe in section 3.1, Case D — authorised for this disposable
   project only).
2. `supabase/bootstrap/canonical_public_schema.sql` (schema-only capture) was
   applied.
3. Every migration with version greater than `SNAPSHOT_CUTOFF=20260920190000`
   was applied in filename order — **41 migrations**, the last being
   `20261102130200_complete_pharmacy_sale_single_overload.sql`.
4. `scripts/db-tests/assert-function-acl-surface.sql` was run: the anon
   EXECUTE surface is the expected 34 functions.

No rows were written to `supabase_migrations.schema_migrations`. That is
deliberate: the sanctioned path defines the schema by replay, not by ledger, and
the ledger stays empty. Do not "repair" it by marking versions applied.

Two facts limit what this rebuild proves:

- **Eight migrations are untracked in Git** (`20261101090000` through
  `20261102130200`). The acceptance database has them; a CI replay that applies
  only tracked files would not produce the same schema until they are
  committed. Treat the acceptance schema as *ahead of* the documented CI chain
  until then.
- The object-level check (`--schema`) proves the objects exist now. It does not
  prove migration history and cannot report the PostgreSQL engine version.

### 2.3 Direct-SQL surface check (run 2026-11-02)

PostgREST cannot show RLS policy definitions, table grants, function
`search_path`, or triggers, so a read-only catalog check was run directly
against the acceptance pooler (`verify-acceptance-surface.sql`; it refuses the
production ref and writes nothing).

| Check | Result |
|---|---|
| Critical tables present | all 27 (the check initially listed `domain_event_outbox` and `plan_feature_entitlements`; neither is defined anywhere in this repository — the latter is a migration filename, the table is `plan_features`) |
| RLS enabled | every pharmacy table |
| Pharmacy policies branching on `profiles.is_admin` | **0** |
| anon EXECUTE surface | **34**, matching `assert-function-acl-surface.sql` |
| Required RPC signatures | 11 present, all `security definer`; `complete_pharmacy_sale` has a single overload |
| Triggers | append-only guards on `pharmacy_pos_sales` / `pharmacy_pos_sale_items`, accounting-post triggers, `profiles_guard_privileged_columns` |
| `supabase_migrations` ledger | **0 rows** (by design; see 2.2) |
| `pharmacy_tally_cutover_locks`, `pharmacy_till_cash_events` | RLS on, zero policies, all access revoked from `anon`/`authenticated` — service-role only, as their migrations state |

One defect was found on the first run and is now **fixed in the database and
re-verified**: `public.custom_access_token_hook` had no pinned `search_path`.
`20261102130000_pharmacy_tenant_access_hardening.sql` recreated the function
without restating the `SET search_path` that `20261003150000` had added, and
`CREATE OR REPLACE` drops it.

The file was corrected to restate `set search_path to 'public'`, and two
replay-safety guards were added at the same time. Section 7 of that migration
uses a bare `create policy` for `pharmacy_receipt_reprints` and
`pharmacy_sale_idempotency`; on a second run those statements would have raised
`policy already exists` and aborted the migration's single transaction, rolling
back the `search_path` fix with it. Both now carry `drop policy if exists`,
matching the form the file already used for `public_invite_lookup`.

On owner authorisation the corrected migration was re-applied to acceptance
(`2026-11-02`, exit 0). The only notice was `policy "public_invite_lookup" …
does not exist, skipping` — expected, because the first run had already dropped
it. Read back from the live database after the replay:

| Check | Result |
|---|---|
| `custom_access_token_hook` `proconfig` | `search_path=public` |
| Security-definer functions with no pinned `search_path` | **none** |
| Pharmacy policies reachable by `anon` or `PUBLIC` | **none** |

The migration's own section 8 self-check runs inside the transaction and aborts
on any anon/PUBLIC-reachable policy, any policy still branching on
`is_admin` / `same_tenant` / `current_tenant_id`, or `pharmacy_caller_tenants()`
losing `security definer` or anon `EXECUTE`. It committed, so those assertions
held at apply time.

The whole read-only surface check was then re-run against the post-replay
database and returned `VERIFY_SURFACE_OK` with the same figures as the first
run: 27 critical tables present with RLS on each, 0 policies branching on
`is_admin`, anon EXECUTE **34**, the 11 required RPC signatures all
`security definer`, the expected triggers, and the ledger still at 0 rows.

The tenant-isolation suite was re-run after the replay as well, because its
fixture users sign in through the auth hook that was re-pinned:

| Run | Target | Result |
|---|---|---|
| `pharmacy-rls-tenant-isolation.integration.test.ts` | `https://jbojujxpyxsdiukmrwzs.supabase.co` | **14 passed, 0 failed**, 34.61 s, exit 0 |

Observation, not a defect: `anon` and `authenticated` hold broad table-level DML
grants on most pharmacy tables. The enforcement is RLS — the `rls` suite proves
an anonymous caller reads no pharmacy rows and a tenant administrator cannot
write another tenant's. The grants were not changed.

### Checkpoint revalidation (2026-11-02)

Run after the guards in this document were added, on the same working tree:

| Check | Result |
|---|---|
| Branch / HEAD | `feat/tally-bridge-command` / `85b6732fb497` |
| `npm run verify:pharm-release` | **19/19 PASS, exit 0** |
| Pharmacy tests (stage) | **1,174 passed, 49 skipped, 0 failed** (1,171 at the checkpoint, before 3 guard tests were added) |
| `npm run test:workflow-safety` | 89/89 pass |
| `npm run test:migration-integrity` | 54/54 pass |
| `npm run test:reconciliation-evidence` | 7/7 pass |
| Pharmacy type-check / lint / `db:check` | clean (exit 0) |
| Working tree | 193 changed or untracked paths, nothing committed |

This revalidates the local release gate only. It does not change the
environment status above.

---

## 3. Account actions required (owner only)

Nothing here is run by an agent, and none of it may be done without explicit
approval in the same request. **The database rebuild (step 3) is done** — it was
executed on 2026-11-02 under explicit owner authorisation for this disposable
project (section 2.2). Steps 4–6 remain.

**Warning about the linked project.** `supabase/.temp/project-ref` names
`qfqakzmjatszisuqjwon` — **production**. Any `supabase` command that omits
`--project-ref` would target production. Run `supabase link --project-ref
jbojujxpyxsdiukmrwzs` before using the CLI against acceptance, or always pass
`--project-ref` explicitly and re-check the ref in the command's output.

1. **Decide the project.** Either restore/pause-resume the existing acceptance
   project `jbojujxpyxsdiukmrwzs`, or create a replacement. A replacement means
   a new 20-character ref, and every command below takes it through
   `SYNAPSE_E2E_ACCEPTANCE_PROJECT_REF` — no code change is needed.
2. **Record the ref and the project name** in the acceptance record. The
   documented expected name is `synapse-e2e-acceptance`.
3. **Apply the pharmacy migration chain** — **DONE 2026-11-02** through the
   sanctioned fresh-database path (canonical snapshot + 41 post-cutoff
   migrations), not `db push`. The result is recorded in section 2.2. Applying
   migrations is an owner action; see the standing rule that
   `supabase/migrations/*` is read-only to agents.
4. **Collect four values** from the dashboard (Settings → API): project URL,
   anon/publishable key, service-role key, and the ref. Do not paste the
   service-role key into a file inside the repository.
5. **Re-create the Preview deployment** used for browser acceptance (or choose
   a current Preview URL), and set the Preview-scope variables listed in
   `PRODUCTION_ACCEPTANCE_SETUP.md` §4. The live team/project mapping is
   resolved in `VERCEL_PLATFORM_ENABLEMENT.md` §A; the two files that carried
   the retired team id are corrected in the working tree.
6. **Report back** the ref, the URL, the Preview base URL, and confirmation that
   the migration chain applied. Then section 4 can run.

Do not create a paid add-on, a second project, or a Vercel change as part of
this step without saying so first.

### 3.1 Restoring the project — exact steps

Which case applies is decided by the dashboard's project list, not by a guess.

**Case A — the project is listed with status *Paused*.** A pause keeps the ref
and the keys, so this is the cheap path.

1. Open the `synapse-e2e-acceptance` project → **Restore project**. Needs
   Owner/Administrator on the organisation. Takes a few minutes.
2. Confirm from a **host** shell, not the sandbox:
   `getent hosts jbojujxpyxsdiukmrwzs.supabase.co` must return an address.
   Before the restore it returns nothing.
3. Re-copy the URL and both keys from Settings → API instead of trusting
   `.env.e2e-acceptance`. A pause should not rotate keys, but "should not" is
   not evidence — the doctor decides.
4. Run `supabase db push --project-ref jbojujxpyxsdiukmrwzs`. "Already up to
   date" is the expected answer for a restored project; a list of pending
   migrations is itself the finding, because it means the schema was not what
   the repository says it was.
5. Continue at step 4 above.

**Case B — the project is absent from the list.** It was deleted, the ref is
gone, and only a replacement exists.

1. **New project.** Name `synapse-e2e-acceptance`, Free plan, same organisation
   as production, nearest region. Generate the database password and store it
   outside the repository — it is needed once, for `db push`, and cannot be
   read back from here.
2. Record the new **20-character** ref. `resolveAcceptanceTarget` rejects
   anything that is not exactly 20 lowercase alphanumerics.
3. From a host shell, with the database password:

   ```bash
   supabase db push --project-ref <new-ref>
   ```

4. Settings → API → copy the Project URL and the **legacy JWT** `anon` and
   `service_role` keys. The validators base64-decode the payload and require
   `role` to be exactly `anon` / `service_role` and `ref` to equal the target.
   A `sb_publishable_…` or `sb_secret_…` key fails as
   `Service role token is not a readable Supabase JWT`. If the new project
   offers only that key format, **stop there** — the validators need a change
   before any suite can run, and that change is not the operator's to make
   mid-run.
5. Export the replacement ref in every shell that will run a suite:

   ```bash
   export SYNAPSE_E2E_ACCEPTANCE_PROJECT_REF=<new-ref>
   ```

   Every script follows it; no source change is required. Also update the four
   values in the GitHub `production-acceptance` environment.
6. Continue at step 4 above, then recreate the Preview deployment in step 5.

**Case C — the project is listed, resolves, and accepts its keys, but its schema
does not match the repository.** This was the state before the rebuild on
2026-11-02 (section 2.1). Do not delete the old project to "start clean" — it is
still the only copy of whatever was in it, and deleting is not reversible.

1. **Create a replacement**, same name `synapse-e2e-acceptance`, Free plan, same
   organisation (`rjbwiwscdgnelipidood`), West EU (Ireland). Record the new
   20-character ref and the database password outside the repository.
2. From a host shell: `supabase db push --project-ref <new-ref>`. A fresh
   ledger means all 209 migrations apply in order, and the output should end at
   `20261102130200`. Anything that stops earlier is a genuine failure of the
   chain and must be read, not worked around.
3. Re-copy the URL and both legacy JWT keys from Settings → API, re-export
   `SYNAPSE_E2E_ACCEPTANCE_PROJECT_REF`, and update
   `EXPECTED_ACCEPTANCE_PROJECT_REF` in `scripts/e2e-acceptance-isolation.mjs`
   and the four values in the GitHub `production-acceptance` environment.
4. Re-run `node scripts/e2e-acceptance-db-target.mjs --probe --schema`; exit 0
   is the gate. Then seed the synthetic fixture and run section 5.

**Case D — keep the ref and rebuild the database in place.** Preferable to Case C
when the project's only contents are synthetic, because the ref stays
`jbojujxpyxsdiukmrwzs` and `.env.e2e-acceptance`, the documented default and the
GitHub environment need no changes. Verified 2026-11-02: 3 tenants
(`is_synthetic=true`, `data_classification='synthetic'`), 10 profiles, 2
products, 6 sales, and zero rows in every other pharmacy table.

There is no CLI reset for a hosted project — `supabase db reset` only targets the
local stack — so the wipe is done once from the dashboard SQL editor.

1. Dashboard → project → **SQL Editor**, run:

   ```sql
   drop schema if exists public cascade;
   create schema public;
   drop schema if exists demo cascade;

   grant usage on schema public to anon, authenticated, service_role;
   grant all on schema public to postgres;
   alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
   alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
   alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;

   delete from supabase_migrations.schema_migrations;
   ```

   This removes the older-generation schema and the 100 foreign ledger rows.
   `auth` users and storage objects are untouched; the profiles that referenced
   them are gone, which is harmless because the RLS suite creates its own users.
   If the drop reports a dependent extension, stop and report the exact error
   rather than forcing it with `cascade` tricks.

2. From a host shell, into the now-empty ledger:

   ```bash
   supabase db push --project-ref jbojujxpyxsdiukmrwzs
   ```

   All 209 apply in order. The last version applied must be `20261102130200`.

3. `node scripts/e2e-acceptance-db-target.mjs --probe --schema` must exit 0.
   Section 5 follows.

**Before the first suite, in the shell that will run it:**

```bash
unset SUPABASE_ACCESS_TOKEN        # run it in a separate shell for `db push`
node scripts/e2e-acceptance-db-target.mjs --probe --schema
```

Exit 0 is the only acceptable result. `resolveAcceptanceTarget` refuses a
shell carrying `SUPABASE_ACCESS_TOKEN`, `DATABASE_URL`, `DIRECT_DATABASE_URL`
or `SUPABASE_DB_URL`, because any of them could point a suite at a database
the declared ref does not name.

---

## 4. Environment contract

Export all of these in a **clean host shell**. Never source `.env.local`.

| Variable | Needed by | Notes |
|---|---|---|
| `SYNAPSE_PHARMACY_DB_REMOTE=1` | database runners | per-invocation opt-in; without it every writer refuses |
| `SYNAPSE_E2E_ACCEPTANCE_PROJECT_REF` | everything | 20 lowercase alphanumerics; must equal the URL's ref |
| `SYNAPSE_E2E_SUPABASE_URL` | everything | `https://<ref>.supabase.co` |
| `SYNAPSE_E2E_SERVICE_ROLE_KEY` | database suites | JWT with `role=service_role` and `ref=<ref>` |
| `SYNAPSE_E2E_ANON_KEY` | RLS suite, target probe | JWT with `role=anon` and `ref=<ref>` |
| `SYNAPSE_E2E_BASE_URL` | browser suite | remote Preview URL, never localhost or `*.synapseos.tech` |
| `SYNAPSE_E2E_EMAIL` / `_PASSWORD` / `_FIXED_OTP` | browser suite | the disposable operator account |
| `SYNAPSE_E2E_VERCEL_BYPASS` | browser suite | only when Preview protection is on |

`SYNAPSE_E2E_ANON_KEY` is **not** needed by the browser/doctor path (the browser
talks to Next.js API routes, not PostgREST) but **is** required by the RLS
suite. Keeping both keys in one shell is what makes the single target block
meaningful.

Validate before anything else:

```bash
node scripts/e2e-acceptance-db-target.mjs
```

Exit 0 with no network calls, exit 1 on a refused target, 2 on a failed probe,
3 on a schema gap:

```bash
node scripts/e2e-acceptance-db-target.mjs --probe --schema
```

`--schema` compares the PostgREST OpenAPI document against the tables and RPCs
the suites call. It proves the objects exist **now**; it is not a migration
history, and it cannot report the PostgreSQL engine version.

---

## 5. Database suites on the hosted project

```bash
npm run db:pharmacy:remote                  # refund, rls, concurrency (via the script below)
bash scripts/db-tests/run-pharmacy-db-remote.sh refund rls # selected suites
```

`npm run db:acceptance:target`, `npm run db:acceptance:seed` and
`npm run db:acceptance:cleanup` are the same entry points as the direct
`node scripts/…` invocations in §4, §5 and §8.

What each suite covers, and what moves cleanly from localhost:

| Suite | Covered | Remote-ready |
|---|---|---|
| `refund` | `reverse_pharmacy_sale`, `adjust_pharmacy_batch_stock`, refund/stock reversal | yes — provisions its own fixtures, tears them down |
| `rls` | tenant isolation under a real signed-in JWT, role enforcement, deactivation and soft delete | yes — creates and deletes its own auth users |
| `concurrency` | last-unit oversell, idempotent retries, concurrent credit ledger postings, till cash, duplicate payment activation | yes — after the synthetic tenant is seeded |
| `reconciliation` | accounting/inventory evidence files | not a database suite; run `npm run db:reconciliation:check` |
| purchases / suppliers / customer balances | route-level tests with synthetic fixtures | **no database-level suite exists, local or remote** — do not claim coverage from any run |

The concurrency suite binds to a tenant named `ZZ Synthetic Pharmacy…`. Seed it
with the seeder rather than `scripts/pharmacy-test-setup.mjs`, because the
latter loads env files and uses real domains:

```bash
node scripts/db-tests/seed-pharmacy-acceptance-fixture.mjs
```

It is idempotent, uses `@synapseos.invalid` addresses, and marks the tenant
`is_synthetic` / `synthetic` / `demo`.

Record for each run: project ref, target-check exit code, suite totals, and the
exit code of the runner. Engine version and migration history must be read in
the dashboard SQL editor by the owner — if that is not done, write
`not captured`, not a guess.

---

## 6. Browser acceptance on the hosted project

Prerequisites in `PRODUCTION_ACCEPTANCE_SETUP.md` (GitHub environment, Preview
variables, doctor). The runner refuses `*.synapseos.tech`, localhost, and the
production Supabase project, and probes for a browser before starting.

```bash
node scripts/e2e-acceptance-doctor.mjs
npm run test:e2e:pharmacy -- --project=smoke
npm run test:e2e:pharmacy -- --project=operations
```

The 22 `smoke` journeys are environment-independent. The 11 `operations`
journeys need a Windows host (or `SYNAPSE_PHARMACY_E2E_ALLOW_NON_WINDOWS=1`)
**and** the credentials above. `docs/pharmacy/PHARMACY_WINDOWS_ACCEPTANCE.md`
lists the journeys and the evidence to capture. Capture failures with
diagnostics and no customer data.

---

## 7. Tally cut-over validation (synthetic only)

The cut-over lifecycle runs on the same isolated tenant with synthetic
fixtures: import creation, edition/company/period detection, extraction,
mapping, preview, reconciliation, approval, import, verification, cutover, and
post-cutover refusal by both Tally and the bridge. Then the ordinary pharmacy
journeys must still pass with Tally and the bridge stopped — that is the
Tally-independence bar.

This cannot be represented as TallyPrime or ERP 9 acceptance. Real-edition
acceptance needs the Windows host runbooks
(`TALLY_CONTROLLED_WINDOWS_TEST_RUNBOOK.md`,
`TALLY_PRIME_ERP9_ACCEPTANCE.md`) with a live Tally installation.

---

## 8. Cleanup

The authoritative cleanup is to delete the disposable project in the Supabase
dashboard (Project Settings → General → Delete project). Do that when a run is
finished and no evidence needs to survive.

If the project must be kept, reset it with the scoped script:

```bash
node scripts/db-tests/cleanup-pharmacy-acceptance.mjs \
  --created-after 2026-11-02T00:00:00Z            # dry run, prints matches
```

Add `--apply --confirm-project <ref>` to delete. The script only matches
tenants that are simultaneously `is_synthetic=true`,
`data_classification='synthetic'`, and created at or after the timestamp; it
refuses more than 20 matches, refuses the production ref, and exits 3 with
instructions if a foreign key blocks the delete.

Auth users created by the `rls` and `refund` suites are removed by those
suites' teardown. Verify the auth user count in the dashboard after a run; if
teardown failed, delete the users by their `acceptance.` / `zz-` email prefix.

---

## 9. What a pass proves — and does not

A green run of section 5 on a declared, migrated project proves:

- the migration chain produces the objects the suites call;
- the refund, RLS and concurrency behaviours hold on a hosted PostgreSQL and
  PostgREST, not just in PGlite/WASM;
- fixture writes are confined to a synthetic tenant and are reversible.

It does **not** prove:

- migration history matches the repository (the fingerprint is a snapshot);
- engine parity with production (the version must be read from the dashboard);
- purchases, suppliers, or customer-balance behaviour at the database level —
  those areas have route-level tests only, so neither a local nor a remote run
  covers them;
- browser journeys, until section 6 has actually run;
- Tally acceptance, which is section 7 and cannot be synthetic.

Do not convert any of these into a "verified" claim on the basis of a local or
PGlite run.

---

## 10. Acceptance record template

```text
Date:
Branch / HEAD:
Acceptance project ref:                  (explicit | documented default)
Project name:
Migration method:                        supabase db push --project-ref <ref>
Engine version:                          (dashboard, or "not captured")
Migration history captured:              yes / no

Target check:        exit 0 / refused / probe failed / schema gap
refund suite:        n passed, n failed, exit code
rls suite:           n passed, n failed, exit code
concurrency suite:   n passed, n failed, exit code
seeded tenant id:    (synthetic, is_synthetic=true)

Browser smoke:       n passed, n failed, base URL
Browser operations:  n passed, n failed, or NOT RUN (reason)
Tally synthetic:     stages passed, or NOT RUN (reason)
Post-cutover pharmacy journeys: n passed, n failed, or NOT RUN

Cleanup:             project deleted / scoped cleanup / kept for evidence
Skipped or unexecuted:
Known failures:
```
