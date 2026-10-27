# SYNAPSE-OS Security & Production-Readiness Audit — 2026-10-24

Read-only audit. No migrations applied, no production access, no credentials printed, no user work modified. Production ACL status remains UNKNOWN unless noted as operator-confirmed.

## 1. Executive summary

- **Overall readiness: NOT READY for production ACL remediation.** The `receive_pharmacy_stock` 13-argument overload still has no explicit `EXECUTE` revocation anywhere in the committed migration history, and production ACL evidence is absent. The static ACL scanner can produce a false PASS.
- Two migrations exist locally but are **not in `origin/main`** and therefore not part of the reviewed/remote migration history: `20261007120000_clinical_intelligence_advice_events.sql` and `20261022160000_pharmacy_accounting_ledger.sql`.
- Read-only checks run locally all pass (`db:check`, secret scan, migration-history inventory, clinical Wave1 unit tests).
- No production database, Docker, or local PostgreSQL is available for live verification.

## 2. Repository / branch / worktree state

| Item | Value |
|---|---|
| Repository root | `/home/ebrine/Desktop/SYNAPSE-OS` |
| Branch | `integration/synapse-2026-10-09` |
| HEAD | `c9e53e37fc2c6a22c1699e4d331b1a05e5ff659f` — `feat(pharmacy): add accounting ledger and reconciliation` |
| Upstream | `origin/main` (`d186f91d811d7c1f70ca051ed3167ec76ee4d032`); ahead 10, behind 1 |
| Working tree | 9 modified + 2 untracked (preserved): `.github/workflows/release.yml`, `.vscode/mcp.json`, `apps/pharmacy/vitest.config.ts`, clinical-intelligence `advise/route.ts` + `feature-flag.ts` + `index.ts`, `scripts/release-provenance.mjs` (+test), `scripts/vercel-build-gate.mjs`, untracked `.freebuff/` and `.mcp.json` |
| Toolchain | Node `v24.22.1`, npm `11.19.1` (`packageManager: npm@10.9.7`); `vitest`, `tsc`, `eslint` present; `tsx` NOT installed |
| Migrations | 190 SQL files |

Recovery note: the `/tmp/synapse-security-reconcile` worktree directory remains absent; its Git index survives and the staged patch still verifies (SHA-256 `31a2749938960543ae002d56990108e9326256afe5f46b883c268b5b358b9e11`, 37 paths). Unstaged/untracked work from that checkout remains unrecoverable (TimeShift excludes `/home/**` and `/tmp/**`).

## 3. Confirmed findings

### F1 — HIGH — `receive_pharmacy_stock` 13-arg overload ACL not revoked
- **Status:** source-confirmed; production status unverified
- **Evidence:** `supabase/migrations/20260810093356_pharmacy_inventory_authority.sql` (8-arg), `20261002120000_pharmacy_receive_stock_tenant_refs.sql` (13-arg, `SECURITY DEFINER`, pinned `search_path`, no caller auth). The only revoke, `20260810093859_pharmacy_rpc_revoke_client_execute.sql`, is dynamic by name and ran before the 13-arg overload was created by an uncommitted noon migration (`20260810120000_pharmacy_pilot_authority_hardening.sql` — absent from the repo). `20261003150000_revoke_exposed_security_definer_functions.sql` revokes 11 other functions but NOT `receive_pharmacy_stock`.
- **Impact:** Both overloads trust caller-supplied `p_tenant_id`/`p_received_by`; if either remains `PUBLIC`/`anon`/`authenticated`-executable in production, a caller could post cross-tenant receiving transactions.
- **Remediation:** additive migration revoking `EXECUTE` from `PUBLIC`, `anon`, `authenticated` on both exact signatures and granting only `service_role` (or add in-function `auth.uid()` + membership/store-scope checks if direct client execution is required).
- **Regression test:** negative anon/authenticated invocation + cross-tenant product/supplier/PO/store rejection.
- **Production approval required:** yes.

### F2 — MEDIUM — ACL scanner fails open on missing live evidence
- **Status:** confirmed
- **Evidence:** `scripts/check-db-acl.mjs` scans migration text only; `status` ignores `live_check`. Committed `artifacts/readiness/db-acl-inventory.json` shows `status: PASS` with `live_check: SKIPPED_NO_DATABASE_ACL_URL` and zero detected grants. Implicit default `PUBLIC EXECUTE` (`proacl IS NULL` → `acldefault`) is not modeled.
- **Impact:** A release gate can report PASS without any live catalog evidence.
- **Remediation:** add effective-ACL computation via `aclexplode(COALESCE(proacl, acldefault('f', proowner)))`, separate static vs live evidence, fail closed when live evidence is absent, and record exact signatures.
- **Regression test:** fixtures with implicit default ACL must not PASS; missing live evidence must FAIL.
- **Production approval required:** yes (scanner shipped in CI).

### F3 — MEDIUM — Missing CSP and HSTS headers
- **Status:** confirmed
- **Evidence:** `apps/web/next.config.ts` `headers()` sets `X-Frame-Options`, `X-Content-Type-Options`, `Referrer-Policy`, `Permissions-Policy`, `X-Robots-Tag`; no `Content-Security-Policy` and no `Strict-Transport-Security`.
- **Impact:** Reduced clickjacking/transport hardening depth.
- **Remediation:** add CSP and HSTS headers in `next.config.ts`.
- **Regression test:** config unit test asserting the header set.
- **Production approval required:** no (code-only), but deploy approval is separate.

### F4 — MEDIUM (defense-in-depth) — service-role key used in edge middleware
- **Status:** confirmed (source)
- **Evidence:** `apps/web/src/middleware.ts` `resolvePharmacyCustomDomain` reads `SUPABASE_SERVICE_ROLE_KEY` (falling back to the anon key) to query PostgREST from the Edge runtime.
- **Impact:** Service-role secret embedded in the edge bundle widens blast radius if the edge deployment leaks; fallback to anon key is inconsistent.
- **Remediation:** move custom-domain resolution to a server route/function using the server-side service client, or use a scoped key.
- **Regression test:** unit test that middleware no longer references `SUPABASE_SERVICE_ROLE_KEY`.
- **Production approval required:** yes (runtime behavior).

### F5 — LOW — Clinician override audit not persisted
- **Status:** confirmed
- **Evidence:** `recordClinicianOverride` (`apps/web/src/lib/clinical-intelligence/safety.ts`) returns an in-memory object; the route does not write it. `clinical_ai_advice_events` is created by `20261007120000_...` but has no application writer.
- **Impact:** Wave 1 overrides are not audited/persisted.
- **Remediation:** persist override rows via the service-role writer, or remove the unused table until a writer exists.
- **Regression test:** route test asserting an override row is written.
- **Production approval required:** yes (data + migration).

### F6 — LOW — Clinical `pathway` route not gated by the Wave1 feature flag
- **Status:** confirmed
- **Evidence:** `apps/web/src/app/api/clinical/intelligence/pathway/route.ts` gates on `requireHospitalStaffContext()` + `gateHospitalModule(..., "clinical")`, not `isClinicalIntelligenceWave1Enabled()`. Response is deterministic/mock with `canActivate:false`, `canOrder:false`.
- **Impact:** Inconsistent gating between `advise` (flag) and `pathway` (module gate); low risk because the pathway response is advisory-only and mocked.
- **Remediation:** apply the same feature-flag policy, or document the intended difference.
- **Regression test:** assert both routes respect the flag.
- **Production approval required:** no (code-only).

### F7 — INFO — Accounting ledger migration contains a data-writing statement
- **Status:** confirmed (source)
- **Evidence:** final line of `20261022160000_pharmacy_accounting_ledger.sql`: `select public.seed_pharmacy_accounting_accounts(id) from public.tenants where facility_type = 'pharmacy';` seeds system accounts. It does not backfill historical activity (documented intent).
- **Impact:** Data change on apply (account rows only), not applied anywhere yet.
- **Remediation:** keep seed isolated to system accounts; ensure it is not run against production until reconciliation is approved.
- **Regression test:** N/A (manual).
- **Production approval required:** yes.

### F8 — INFO — Accounting functions trust caller-supplied tenant/actor IDs
- **Status:** confirmed (source)
- **Evidence:** `post_pharmacy_accounting_journal`, `close_pharmacy_accounting_period`, `import_pharmacy_bank_statement`, `match_pharmacy_bank_statement_line`, `seed_pharmacy_accounting_accounts` are `SECURITY DEFINER` with explicit `revoke ... from public, anon, authenticated` and `grant execute to service_role`; tables are `revoke all ...; grant select to service_role`.
- **Impact:** Acceptable boundary given service-role-only execution; same trust-the-caller-ID pattern as F1.
- **Remediation:** optionally add in-function tenant/membership assertions for defense-in-depth.
- **Production approval required:** yes if changed.

## 4. Phase C/D/E/F detail

### receive_pharmacy_stock (Phase C)
- Overloads: 8-arg `(uuid,uuid,text,integer,date,numeric,uuid,text)` and 13-arg `(uuid,uuid,text,integer,date,numeric,uuid,text,numeric,uuid,uuid,uuid,text)`.
- Both `SECURITY DEFINER`, `SET search_path TO 'public'`.
- Neither validates `auth.uid()`, role, tenant membership, or store scope; both trust caller-supplied IDs. The 13-arg adds tenant-ownership checks on referenced supplier/PO/store/product IDs (reference integrity, not caller auth).
- Callers: all server routes use `supabaseAdmin` (service role) with server-side auth (`requirePharmacyTenant`/`requirePharmacyPermission`/`requireStoreScope`, `requireMobilePharmacyAuth` + role/capability). The mobile app routes through `/api/mobile/...`; no direct client-side RPC. The 8-arg overload is used by `scripts/hospital-golden-live-journey.mjs` and `scripts/opd-dispense-live-journey.mjs` (service role).
- ACL status: **UNKNOWN** for both in production.

### Clinical Intelligence (Phase D)
- Migration `20261007120000` creates `clinical_ai_advice_events` (RLS enabled, no policies, no explicit grants) — **local-only** (not in `origin/main`), flagged "DO NOT apply to production until ops approval."
- Feature flag defaults OFF (`isClinicalIntelligenceWave1Enabled` requires `1/true/on/yes`); unit tests confirm (`wave1.test.ts`, 4 passing). The uncommitted working-tree change adds a tenant-scoped `feature_flags` check (`clinical_intelligence_wave1` key) backed by the existing `feature_flags` table.
- Advisory-only enforced by system prompt, `assertNotForbidden`, `advisory: true`, mock fallback when providers unconfigured, and `recordClinicianOverride` (non-persistent).
- No application code currently writes to `clinical_ai_advice_events`.

### Pharmacy accounting ledger (Phase E)
- `20261022160000` is **local-only** (not in `origin/main`), idempotent (`if not exists`), balanced double-entry with `check (total_debit = total_credit)`, immutable journal entries/lines via `reject_pharmacy_accounting_mutation` trigger, advisory-xact locking for period/journal serialization, idempotency keys + content hashes for bank imports, and source-type/source-id uniqueness for replay safety.
- Tenant isolation: all tables `tenant_id`-scoped with RLS enabled; grants are service-role select-only; writes only via `SECURITY DEFINER` functions with explicit `revoke ... from public, anon, authenticated`.
- No local PostgreSQL/Docker available to run DB-backed integration tests; a manual verification plan is required before applying.

### Migration-history reconciliation (Phase F)
- `git diff --name-status origin/main..HEAD -- supabase/migrations` shows only two local additions: `20261007120000_clinical_intelligence_advice_events.sql` and `20261022160000_pharmacy_accounting_ledger.sql`.
- `20261003150000_revoke_exposed_security_definer_functions.sql` and `20261003160000_profiles_privileged_columns_guard.sql` are already in `origin/main`.
- `scripts/check-migration-history.mjs` (EXIT 0) inventories 190 migrations against baseline `19ef5d0`, warns on all files added since baseline, and reports `remoteReconciliation: BLOCKED_OPERATOR_CONTROLLED`.
- Production DB workflow `.github/workflows/db-production.yml` is `workflow_dispatch`-only, protected `production` environment, requires `PRODUCTION` + `RECONCILED` confirmation strings and a reviewed `source_sha`; dry-run precedes apply. Migrations are not auto-applied.

## 5. Test results (Phase G)

| Command | Exit | Result |
|---|---|---|
| `node scripts/check-supabase-migrations.mjs` | 0 | 190 migration files OK |
| `node scripts/check-secrets.mjs` | 0 | Secret scan PASS |
| `node scripts/check-migration-history.mjs` | 0 | 190 files inventoried; warnings "added since 19ef5d0"; reconciliation BLOCKED_OPERATOR_CONTROLLED |
| `vitest run apps/web/src/lib/clinical-intelligence/wave1.test.ts` | 0 | 4/4 passed |
| `tsx --test packages/db/src/pharmacy-purchases.test.ts` | n/a | NOT run — `tsx` not installed; declined auto-install |

## 6. Local files changed

None beyond this new report. No code, migration, or configuration file was modified. User's uncommitted work was preserved.

## 7. Remaining uncertainties and blockers

- Production ACLs for `receive_pharmacy_stock` (both overloads) — UNKNOWN.
- Whether `clinical_ai_advice_events` / accounting objects exist in production — UNKNOWN.
- Whether the uncommitted `20260810120000_pharmacy_pilot_authority_hardening.sql` ever granted/revoked anything on the 13-arg signature — UNKNOWN (file absent).
- `tsx`-based test suites not runnable without installing `tsx`.
- No local PostgreSQL/Docker for DB-backed tests.

## 8. Exact read-only SQL needed from an authorized operator

Run only against the verified production project (`qfqakzmjatszisuqjwon` is the expected identifier; confirm before running). This was not run.

```sql
SELECT current_database() AS db, session_user,
       p.oid::regprocedure::text AS signature,
       pg_get_userbyid(p.proowner) AS owner,
       p.prosecdef AS security_definer,
       p.proconfig, p.proacl,
       has_function_privilege('anon', p.oid, 'EXECUTE') AS anon_execute,
       has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authenticated_execute,
       has_function_privilege('service_role', p.oid, 'EXECUTE') AS service_role_execute
FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public'
  AND p.proname IN ('receive_pharmacy_stock',
                    'post_pharmacy_accounting_journal',
                    'import_pharmacy_bank_statement')
ORDER BY signature;

SELECT version FROM supabase_migrations.schema_migrations
WHERE version IN ('20261007120000','20261022160000','20261003150000')
ORDER BY version;

SELECT to_regclass('public.clinical_ai_advice_events') IS NOT NULL AS advice_events_exists,
       to_regclass('public.pharmacy_accounting_journal_entries') IS NOT NULL AS ledger_exists;
```

Also needed: the production `schema_migrations` row(s) for `20260810120000_pharmacy_pilot_authority_hardening` (or the file content if retained), to determine the 13-arg overload's original grants.

## 9. Proposed production changes (separate from audit)

1. **ACL remediation migration** for `receive_pharmacy_stock` — revoke `EXECUTE` from `PUBLIC`/`anon`/`authenticated` on both signatures, grant `service_role`; fail closed if the 8-arg signature is absent; operator-driven decision for the 13-arg.
2. **Apply** `20261007120000` and `20261022160000` only via the `db-production` workflow after operator reconciliation.
3. **Scanner upgrade** — live effective-ACL check, `acldefault` detection, fail-closed on missing live evidence.
4. **Headers** — add CSP and HSTS to `next.config.ts`.
5. **Clinical override persistence** — persist override audit rows (or remove the unused table).
6. **Middleware** — remove service-role key from edge middleware.

Each requires its own approval and rollback plan before execution.

## 10. Prioritized next actions

1. Obtain the operator ACL evidence (SQL above) — highest value.
2. Confirm the production `20260810120000` ledger record/grants.
3. Decide the `receive_pharmacy_stock` remediation policy (service-role-only vs in-function checks).
4. Reconcile and schedule the two local-only migrations via the production DB workflow.
5. Upgrade `check-db-acl.mjs` and its tests; add CSP/HSTS.
6. Resolve the `tsx` toolchain so DB domain tests can run in CI locally.
