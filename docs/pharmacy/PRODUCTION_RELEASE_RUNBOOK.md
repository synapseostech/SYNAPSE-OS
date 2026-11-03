# Pharmacy production release runbook

How a pharmacy release is verified, approved and shipped. Written to be followed
by someone who did not build the change.

**This document does not authorise anything.** Commits, pushes, merges and
deploys are the repository owner's actions. The runbook tells the owner what to
run and what a pass looks like.

Companion documents:

- [PRODUCTION_READINESS_PROGRESS.md](./PRODUCTION_READINESS_PROGRESS.md) — what is true today
- [FIRST_CUSTOMER_CUTOVER_RUNBOOK.md](./FIRST_CUSTOMER_CUTOVER_RUNBOOK.md) — env mapping, backup, admin, opening balances, smoke tests
- [CLIENT_ONBOARDING_CHECKLIST.md](./CLIENT_ONBOARDING_CHECKLIST.md) — per-tenant setup
- [TALLY_MIGRATION_ACCEPTANCE_CRITERIA.md](./TALLY_MIGRATION_ACCEPTANCE_CRITERIA.md) — cut-over sign-off
- [deploy.md](../deploy.md) — project layout and Vercel commands
- [TALLY_CONTROLLED_WINDOWS_TEST_RUNBOOK.md](./TALLY_CONTROLLED_WINDOWS_TEST_RUNBOOK.md) — bridge on Windows
- [PHARMACY_WINDOWS_ACCEPTANCE.md](./PHARMACY_WINDOWS_ACCEPTANCE.md) — browser acceptance on the Windows host
- [DISPOSABLE_ACCEPTANCE_ENVIRONMENT.md](./DISPOSABLE_ACCEPTANCE_ENVIRONMENT.md) — isolated database, browser and Tally validation, and its cleanup

---

## 1. What ships

| Artifact | Source | Deployed by |
|---|---|---|
| Web OS (platform, hospital, lab) | `apps/web` | Vercel project `synpase-os`, root `vercel.json` |
| Pharmacy | `apps/pharmacy` | Vercel project `synapse-pharm`, root directory `apps/pharmacy` |
| Demo | `apps/web` (demo surface) | Vercel project `synapse-demo` |
| Mobile APK | `apps/app` | EAS, separately from Vercel |
| Tally bridge | `apps/tally-bridge` | Zipped for the client’s Windows PC; not deployed |

The Pharmacy app and the web OS share one database. A change that touches
`packages/db` affects both.

---

## 2. Preconditions

Before starting a release:

1. Working tree is understood — `git status` shows only the changes you intend
   to ship, and nothing you did not write.
2. The branch is based on current `main`.
3. No migration in `supabase/migrations/` is being applied by this release
   without a separate, explicit decision. A release runbook does **not**
   authorise a schema change.
4. For a Tally cut-over release, read
   `TALLY_MIGRATION_ACCEPTANCE_CRITERIA.md` first.

---

## 3. The gate

### 3.1 Deterministic release gate

```bash
npm run verify:pharm-release
```

`scripts/verify-pharm-release.mjs`. Runs, stopping at the first failure:

| Order | Check |
|---|---|
| 1 | `db:check` — migration file integrity |
| 2 | `db:history:check` — migration history against the recorded base |
| 3 | `test:migration-integrity` — history tests + RPC coverage against build inputs |
| 4 | `lint @synapse/web` |
| 5 | `lint @synapse/pharmacy` (`eslint . --max-warnings 0`) |
| 6 | `type-check @synapse/web` |
| 7 | `type-check @synapse/pharmacy` |
| 8 | `type-check @synapse/app` |
| 9 | `test @synapse/pharmacy` — unit, domain, authz, contracts |
| 10 | `test:pharmacy-skips` — every skipped test declared and classified |
| 11 | `test:tally` — Tally import parsers + bridge tests |
| 12 | `test:pharmacy-print` — shared receipt-print recorder |
| 13 | `test:pharmacy-tax` — shared tax engine + receipt tax split |
| 14 | `test:pharmacy-mobile-api` — mobile pharmacy BFF routes |
| 15 | `test:mobile-app` — mobile till pricing, purchase draft, print gate |
| 16 | `build @synapse/pharmacy` |
| 17 | `verify:web` — type-check + Next build |
| 18 | `expo export --platform android` |

The script prints `RELEASE_GATE=PASS` or `RELEASE_GATE=FAIL` and stops at the
first failure. There is no "pass with skips": a missing prerequisite is a
`FAIL`, and a test that skips without a declared class and reason in
`scripts/report-pharmacy-skips.mjs` is a `FAIL` too. The eight declared
`environment-blocked` suites still skip locally — the gate prints them, so the
release record says what did not run.

`db:history:check` reports `remoteReconciliation` as
`BLOCKED_OPERATOR_CONTROLLED`; that is expected in a local run and is not a
failure. It means the remote ledger was not compared, because that requires an
operator decision.

**It does not prove** a deployment works, and it does not prove a migration is
safe against a real database. It proves the code compiles, lints, type-checks
and passes its suites on this machine.

### 3.2 Live gate (optional, requires database access)

```bash
npm run verify:pharm-release:live
```

Runs the local gate and then `scripts/verify-pharm-live.mjs`, which probes a
real database. It refuses to start unless `SYNAPSE_PHARM_LIVE=1` and both
`NEXT_PUBLIC_SUPABASE_URL`/`SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are
set. The isolation probes (`SYNAPSE_PHARM_LIVE_TENANT_A_JWT`,
`SYNAPSE_PHARM_LIVE_TENANT_B_JWT`, `SYNAPSE_PHARM_LIVE_ANON_KEY`) are required
for the tenancy results to mean anything; when they are absent the gate is
`FAIL`, not `PASS`.

Never point this at production. It writes.

### 3.3 CI

`.github/workflows/ci.yml` runs on pull requests and pushes to `main`: migration
checks, the domain suites, web lint/type-check/build, "Pharmacy verification",
the Tally import parsers and control-plane tests.

CI is the real merge gate. Vercel’s `ignoreCommand` is a branch filter and does
not run tests — see [deploy.md](../deploy.md).

---

## 4. Deployment

Follow [deploy.md](../deploy.md) for project identifiers and commands. Order:

1. Database changes (if any) — **separate approval**, applied before the apps
   that depend on them.
2. `synpase-os` (web).
3. `synapse-pharm` (pharmacy).
4. Mobile APK via EAS, if `apps/app` changed.
5. Tally bridge package, only when the connector contract version changed (see
   `TALLY_CONNECTOR_INSTALLATION.md`).

Shipping pharmacy before web is safe; the reverse is not, because web routes
assume the shared schema.

---

## 5. Post-deploy checks

| Check | How | Pass |
|---|---|---|
| Pharmacy readiness | `GET https://<pharmacy-host>/api/ready` | `200`, `status: "ready"`, `checks.database.ok: true` |
| Web health | `npm run health:smoke` | exits 0 |
| Build identity | `/api/ready` `commitSha` equals the deployed commit | equal |
| Login | Sign in as a staff user on the pharmacy host | reaches POS |
| One sale | Complete a test sale on a scratch tenant | receipt printed, stock decremented |

`/api/ready` deliberately returns `database probe failed` with no driver detail.
Find the cause in the function logs, not the response body.

---

## 6. Rollback

Vercel keeps previous deployments:

1. Redeploy the previous known-good deployment from the Vercel project.
2. Confirm `/api/ready` on the restored deployment.
3. If the release changed the schema, the rollback must be planned **before**
   the deploy — application rollback alone does not undo a migration.

Do not "fix forward" a failed release by pushing to `main` without re-running
the gate.

---

## 7. Stop conditions

Stop and escalate, do not improvise, if:

- the release gate fails and the fix is not a one-line, reviewed change;
- a migration would need to run against a shared database;
- `/api/ready` returns `503` after deploy;
- the Tally cut-over is already complete in the tenant
  (`CUTOVER_ALREADY_COMPLETE`) and the release expects to re-import;
- any step requires a secret that is not already in the environment.

---

## 8. Release record

Fill this in per release and keep it with the change.

| Field | Value |
|---|---|
| Release date | |
| Commit SHA | |
| Branch | |
| Gate output (`RELEASE_GATE=`) | |
| Bridge tests | |
| Approver | |
| Deployments (project → deployment id) | |
| Post-deploy check result | |
| Rollback plan | |
| Notes / known gaps | |

---

## 9. What this runbook cannot tell you

- Whether the client’s Tally data is correct. That is
  `TALLY_MIGRATION_ACCEPTANCE_CRITERIA.md`.
- Whether the Windows bridge works on the client’s PC. That is the controlled
  Windows test, and until it has been run Gate D is `NOT TESTED`.
- Whether the product is independent of Tally. That is the disconnect test.
- Whether an operator can sign in, sell, refund and print in a browser. That is
  `PHARMACY_WINDOWS_ACCEPTANCE.md`, and it needs a Windows host and a
  disposable tenant.
