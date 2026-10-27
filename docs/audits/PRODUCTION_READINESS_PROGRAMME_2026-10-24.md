# SYNAPSE-OS — Consolidated Production Readiness Audit

**Date:** 24 October 2026
**Repository:** `/home/ebrine/Desktop/SYNAPSE-OS` (origin `github.com/synapseostech/SYNAPSE-OS`)
**Mode:** read-only. No file in the working tree was modified, no migration applied, no database contacted, no service started, no deployment or release action taken.
**Scope:** security and identity, PostgreSQL/RLS, patient import, clinical safety, offline sync, interoperability, pharmacy/lab/finance, API/schema consistency, testing, CI/CD, reliability, and product governance.

**Status vocabulary used throughout:** VERIFIED (I read the code/SQL and confirm the behaviour) · CONFIRMED DEFECT · LIKELY DEFECT · DESIGN GAP · UNVERIFIED (cannot be established without a live system or owner decision) · BLOCKED · NOT TESTED · PASS WITH EVIDENCE.

---

## Executive summary

The platform is not close to production-safe, and the reasons are structural rather than incidental. Three of the four most serious problems share one root cause: a safety property is *declared* somewhere and never *enforced* on the path that matters. Row-level security is enabled on all 317 tables, but ten policies reduce to `tenant_id = tenant_id` and grant every authenticated user read, write and delete across every tenant. A medication-interaction engine, an allergy table and an override-audit table all exist and are referenced by nothing on the prescribing, dispensing or POS paths. A readiness matrix asserts 34 capabilities as passing, and nothing evaluates it.

The single largest exposure is confirmed and worse than previously reported. The ten `tenant_isolation` policies are `FOR ALL`, have no `WITH CHECK`, and are the only permissive policies that matter on nine of the ten tables — so the hole is not read-only. Any authenticated account can insert, update and delete encounters, vitals, drug orders and telemedicine PHI belonging to any tenant. `products`, `orders` and `consult_queue` additionally expose rows to the `anon` role, and `orders` permits anonymous UPDATE.

Patient import is contained by accident, not by design. All three write routes resolve tenant from the request body, use the service role, and check nothing beyond "is there a session". The status endpoint has no authentication at all. The reason no cross-tenant PHI has landed yet is that the insert names a column that does not exist (`date_of_birth`; the table has `dob`) and omits a NOT NULL column (`mrn`), so every row errors. That is a schema bug masking an authorization bug. Repairing the schema without repairing the authorization converts a broken importer into a live cross-tenant PHI writer.

Clinical safety is absent where it counts. `clinical_prescriptions` is written by `POST /api/opd/prescriptions` and by the offline sync applier with no allergy, interaction, duplicate-therapy or dose evaluation. The DDI pack (`synapse-ddi-pack-2026.08.2`, ~72 pairs) is imported only by three read-only advisory endpoints and by no write path; it accepts drug names but no patient, so it could not evaluate an allergy even if called. `pharmacy_products.requires_prescription` is stored and never read at sale time. There is no medication warning to override, so the override-audit substrate in `medication_safety_checks` is dead.

Financial integrity is stronger than the clinical layer and still not trustworthy. The POS sale RPC is genuinely atomic — sale, lines, FEFO batch decrement, product quantity and a balanced journal entry in one transaction. But hospital dispensing calls that same RPC (posting a cash settlement to `CASH_ON_HAND` for a payment method the client supplies) *and* creates a patient invoice for the same dispense, so one event produces two revenue records. Goods-received is a non-transactional fan-out of per-line RPC calls, so a failure mid-way leaves stock on the shelf and no payable in the books.

Release control does not exist in the sense the repository's own documentation claims. The Vercel "build gate" is a build-*skip* filter: production always builds, and it never consults CI. Production deploys run from Vercel's Git integration in parallel with CI, not after it. The release smoke test writes `BLOCKED` and exits 0 when `PRODUCTION_URL` is unset; the browser journey does the same when its base URL is unset. A unit test in the workflow-safety suite fails on this branch right now (2 pass, 1 fail, exit 1) and the deploy path does not care.

What is genuinely good, and should not be disturbed while fixing the above: the session primitives (HS256 verification plus a hashed, revocable session row — not merely decoded tokens), tenant-header sanitisation in middleware, the OPD route family's consistent use of a staff context with capabilities and tenant predicates, the lab instrument-ingest design (immutable raw message, duplicate suppression, unit-mismatch detection, staging only, never releases), the double-entry ledger schema with immutable journal lines and compensating reversals, the offline client's explicit "queued, not saved" states and server-side revalidation of pharmacy sales, and the provenance binding in the modified `release-provenance.mjs`. These are the assets the remediation should build on rather than replace.

---

## 1. Verified repository baseline

Captured 2026-10-24T15:56Z.

| Item | Value |
|---|---|
| Git root | `/home/ebrine/Desktop/SYNAPSE-OS` |
| Branch | `integration/synapse-2026-10-09` |
| HEAD | `c9e53e37fc2c6a22c1699e4d331b1a05e5ff659f` |
| HEAD commit date | 2026-10-22 17:16:43 +0300 |
| HEAD subject | `feat(pharmacy): add accounting ledger and reconciliation` |
| Upstream | `origin/main` |
| Divergence | **10 ahead, 1 behind** — matches the reported checkpoint |
| Working tree | 29 porcelain entries: 12 modified, 15 untracked files, 2 untracked directories |
| Remotes | `origin` → synapseostech/SYNAPSE-OS; `legacy-origin` → ebrinejason-sys/SYNAPSE-OS |
| Schema | 317 tables, 548 policies, 68 functions, 33 SECURITY DEFINER, 0 RESTRICTIVE policies |
| Migrations | 190 files; 24 carry timestamps from 2026-09-20 onward (after the snapshot cutoff) |
| Node/toolchain | Node 22 pinned via `.nvmrc`, `engines.node: 22.x`; npm 10.9.7 |

**Working-tree protection statement.** The following are present as uncommitted work and were not read-and-left-dirty, reverted, stashed or cleaned: `.github/workflows/release.yml`, `.vscode/mcp.json`, `apps/pharmacy/vitest.config.ts`, `apps/web/src/app/api/clinical/intelligence/advise/route.ts`, `apps/web/src/lib/clinical-intelligence/feature-flag.ts`, `apps/web/src/lib/clinical-intelligence/index.ts`, `package.json`, `package-lock.json`, `scripts/check-db-acl.mjs`, `scripts/release-provenance.mjs`, `scripts/release-provenance.test.mjs`, `scripts/vercel-build-gate.mjs`. Untracked and preserved: `.freebuff/`, `.mcp.json`, the ten `docs/SECURITY_AND_READINESS_AUDIT_2026-10-24*` documents, `docs/architecture/INTEROPERABILITY_AND_TRANSITION_PLAYBOOK_2026-10-24.md`, `docs/audits/`, `scripts/check-db-acl.integration.test.mjs`, `scripts/check-db-acl.test.mjs`.

All git commands were read-only. `GIT_OPTIONAL_LOCKS=0` was set so no index lock was attempted. No branch, tag, remote ref or worktree was altered.

**Access limitations.** Branch protection rules, rulesets, required status checks, environment protection rules, Vercel project settings, whether `vars.PRODUCTION_URL` and `vars.ENABLE_VERCEL_CLI_DEPLOY` are set, and whether the repository default `GITHUB_TOKEN` is read-only cannot be established from the repository and are marked UNVERIFIED throughout. No database was contacted, so production ACL state, whether `20261022160000` has been applied, and whether the post-snapshot revokes landed are UNVERIFIED.

---

## 2. Critical and high-risk findings, ranked

| ID | Severity | Finding | Evidence | Status |
|---|---|---|---|---|
| SEC-01 | Critical | Ten `tenant_isolation` policies reduce to `tenant_id = tenant_id`; `FOR ALL`, no `WITH CHECK`, permissive only, no `TO` clause → any authenticated user reads/writes/deletes all tenants' encounters, vitals, drug orders, order items, products, sync conflicts, telemedicine cases and messages, gas cylinders | `canonical_public_schema.sql:23360,23366,23378,23408,23521,23701,23797,23827,23833,23900` | VERIFIED (independent detector, exactly 10) |
| SEC-02 | Critical | `orders`: `FOR SELECT USING (true)` and `FOR UPDATE USING (true)` → **anon** can read and modify every order. `consult_queue`: `FOR SELECT USING (true)` → public read of all queues, all tenants, despite the policy name | `:19969`, `:19973`, `:22695` | VERIFIED |
| SEC-03 | Critical | Import routes: tenant from request body, service role, authn-only; status endpoint unauthenticated | `api/import/status/[batchId]/route.ts:4-14`; `start:14-25`; `execute:9-23` | VERIFIED (status and execute read directly) |
| CE-01 | Critical | No allergy, DDI, duplicate-therapy or dose-range evaluation on prescribe (online or offline-sync), hospital dispense, pharmacy dispense or retail POS | `api/opd/prescriptions/route.ts:46-173`; `hospital/sync/apply:254-268`; `hospital/pharmacy/dispense:86-120` | VERIFIED by sweep; safety tables have zero non-test references |
| FIN-01 | Critical | Hospital dispense double-books: `complete_pharmacy_sale` posts a settlement to `CASH_ON_HAND` for a client-supplied `payment_method`, and the same handler creates a patient invoice | `dispense/route.ts:100-120, 206-231`; ledger `:432-452` | VERIFIED |
| SEC-04 | High | `products` is publicly readable and `GRANT ALL` exposes every column to `anon`, including `tenant_id`, `created_by`, `is_deleted` (soft-deleted rows stay visible) | `:19949`; grants `:25903` | VERIFIED |
| DB-01 | High | 302 tables grant `ALL` to `anon`, 316 to `authenticated`; RLS is the only control and column-level least privilege is absent | snapshot grants | VERIFIED (counts) |
| DB-02 | High | 49 functions grant `ALL` to `anon`, 15 of them SECURITY DEFINER, including `apply_encounter_amendment` (mutates signed clinical records) | snapshot | Reported by sweep; counts verified, individual grants not re-read |
| DB-03 | High | 384 of 548 snapshot policies have no origin in any migration; the ten SEC-01 policies exist only in the snapshot; `encounters` and `vitals` have no `CREATE TABLE` in any migration | snapshot vs `supabase/migrations` | Reported; policy-origin ratio consistent with 210 in-migration policies |
| DB-04 | High | `rls-matrix.test.ts` asserts against a hardcoded literal and never opens a database; it lists `encounters`/`vitals` as cross-tenant *denied* | `packages/db/src/rls-matrix.test.ts:41-67` | VERIFIED (prior audit; unchanged) |
| SEC-05 | High | Staff deactivation does not revoke sessions and `requireHospitalStaffContext` never checks `staff_scope_assignments.is_active` → a deactivated clinician keeps clinical access until token expiry | `hospital/admin/staff/[id]/route.ts:110-125`; `lib/hospital-dept/context.ts:30-75` | Reported by sweep; consistent with middleware design |
| IMP-01 | High | Import is non-idempotent: no `dedupe_key` written, `LIMIT 100` then unconditional `completed`, patient insert and row-status update not atomic | `import/execute/route.ts:25-30,47-66,69-77` | VERIFIED |
| IMP-02 | High | Import schema drift: inserts `date_of_birth` (column does not exist; table has `dob`) and omits NOT NULL `mrn` → every row errors today | `execute:47-53`; `patients` DDL `:6885-6930` | VERIFIED |
| FIN-02 | High | Goods received is a per-line fan-out of separate RPCs; failure mid-way increases stock with no payable and no journal | `packages/db/src/pharmacy-purchases.ts:551-830` | Reported by sweep |
| FIN-03 | High | Stock write-offs (damage, quarantine, recall, expiry) mutate batch quantity only; no ledger trigger exists on batch tables | `adjust_pharmacy_batch_stock`, snapshot `:287-465`; triggers at ledger `:493-738` | Reported; trigger list verified (5 tables, none on batches) |
| FIN-04 | High | Refund reverses the journal and voids the sale but never reverses `pharmacy_credit_ledger`, so the customer still owes a reversed receivable | `reverse_pharmacy_sale` snapshot `:2398-2501`; ledger `:737` | Reported |
| FIN-05 | High | POS `patientId` is format-checked only, no tenant ownership check and no FK → a sale can be attributed to any tenant's patient | `complete-sale/route.ts:61-66,217`; `pharmacy_pos_sales` `:7584` | Reported |
| SYN-01 | High | Concurrent clinical edits are silently lost: server writes `revision: 0` at four sites and never compares `baseRevision` | `hospital/sync/apply:191,220,260,334`; `sync-contract.ts:88` | VERIFIED |
| CI-01 | High | Release smoke exits 0 with `BLOCKED` when `PRODUCTION_URL` is unset | `.github/workflows/release.yml:110-113` | VERIFIED |
| CI-02 | High | Browser journey exits 0 with `BLOCKED` when no base URL is configured | `scripts/e2e-hospital-browser.mjs:10-18` | VERIFIED |
| CI-03 | High | Production deploys are not gated on CI; the Vercel "gate" always builds production and verifies nothing | `scripts/vercel-build-gate.mjs:14-23`; `vercel.json:2-6` | VERIFIED |
| CI-04 | High | `test:workflow-safety` fails on this branch (2 pass, 1 fail, exit 1) and CI does not block the deploy path | `scripts/vercel-build-gate.test.mjs:13-19`; ran it | VERIFIED (run) |
| INT-01 | High | DHIS2 drain endpoint is not scheduled; `vercel.json` registers only `billing-sweep`; the capability matrix nonetheless reports `cron-drain: passed: true` | `vercel.json:8-12`; `capability-gates.ts:319-322` | VERIFIED |
| INT-02 | High | DHIS2 push fabricates `importCount` from the request and never parses the import report → silent rejections recorded as success | `packages/interop/src/adapters/dhis2.ts:177-181` | Reported |
| INT-03 | High | lab-edge attributes every observation in a multi-accession batch to the first accession → results can stage against the wrong specimen | `apps/lab-edge/src/index.ts:529` | Reported |

### P2 and P3 (summary)

Insurance copilot IDOR on `policyId`/`encounterId` (SEC-06); `lab/notify` cross-tenant push and patient-ID probing (SEC-07); `getCurrentUser` skips activation/suspension checks that `getContext` enforces, affecting ~25 routes (SEC-08); `legacyPlatformAccess` trusts `profiles.role === 'platform_admin'` without a membership row (SEC-09); prescription cancel and pathway override write non-existent columns and silently no-op (CE-02, CE-03); offline queue persists after sign-out and only the `/lab` shell calls it (SYN-02); sync applies every command under `encounter:create` regardless of command type (SYN-03); unauthenticated Gemini/email endpoints with no rate limit (SEC-10); raw Postgres `error.message` returned to clients across many routes (SEC-11); ACL checker cannot see `GRANT ALL ... TO "anon"` and `possibleImplicitPublicExec` never fails (CI-05); `db-reset-fresh.sh` will drop any host's schema if `PGHOST` is overridden (DB-05); no workflow concurrency, one timeout, permissions in 2 of 6 workflows (CI-06).

---

## 3. Domain-by-domain audit matrix

| Domain | Status | Strongest evidence | Principal gap | Blocker |
|---|---|---|---|---|
| Authentication | PASS WITH EVIDENCE | `packages/auth/src/tokens.ts:39-45` verifies HS256 with issuer/audience; `sessions.ts:53-75` hashes and checks revoked/expiry | — | — |
| Authorization | CONFIRMED DEFECT | OPD route family consistent; no client-driven role escalation; profiles privileged-column guard exists | Import, insurance, lab-notify, mobile BFF | Product/security decision on capability model |
| Tenant isolation (DB) | CONFIRMED DEFECT | All 317 tables have RLS enabled | 10 tautological policies; 302 anon grants; no RESTRICTIVE policies | DBA approval to alter policies |
| Tenant isolation (HTTP) | LIKELY DEFECT | Header sanitisation blocks client tenant spoofing | Routes that resolve tenant from body (import family) | — |
| Patient import | CONFIRMED DEFECT, currently non-functional | Feature gate is genuinely fail-closed | No authz, no idempotency, no audit, schema drift | Needs containment before any repair |
| Clinical safety | CONFIRMED DEFECT | DDI pack and safety tables exist and are coherent | Nothing on the write paths; Rx flag unenforced | Clinical owner decisions (§7) |
| Offline sync | CONFIRMED DEFECT | Idempotency is sound (client `commandId`, unique `(tenant_id, idempotency_key)`, hash-mismatch rejection); states are explicit | No `baseRevision`; generic capability; queue survives sign-out | Clinical + product approval on conflict policy |
| Interoperability | SCAFFOLD / UNVERIFIED | Lab instrument ingest is production-grade; FHIR read subset works | No runtime, no scheduler, no ALIS, no Tally connector | Vendor Stage 0 |
| Pharmacy finance | CONFIRMED DEFECT | Atomic sale RPC, immutable journal lines, compensating reversals | Double-booking on dispense; non-atomic GRN; no write-off ledger; no reconciliation | Finance owner |
| Lab | IMPLEMENTED BUT UNVERIFIED | Ingest design; staging and verification enforced | Edge gateway never deployed; accession attribution bug | Deployment + Stage 0 |
| API/schema consistency | CONFIRMED DEFECT | Types largely generated from schema | Import routes and cancel/override paths disagree with DDL | — |
| Testing | CONFIRMED DEFECT | 250 test files; golden journeys are real | No DB-touching RLS test; workflow-safety red | — |
| CI/CD | CONFIRMED DEFECT | `db-production.yml` is genuinely fail-closed (SHA, HEAD equality, `PRODUCTION`, `RECONCILED`, re-run of integrity gate, post-apply probes) | Deploy path bypasses CI; smoke passes on missing config | Operator access to Vercel/GitHub |
| Observability | DESIGN GAP | `logHospitalAudit` / `requireHospitalAudit` distinction exists | No interop lag, DLQ, sync-backlog or import-failure metrics | — |
| Product governance | DESIGN GAP | Extensive docs | `capability-gates.ts` hardcodes 34 `passed: true`; nothing evaluates it | — |

---

## 4. Consolidated risk register

Each entry: ID, root cause, dependencies, verification criterion. Detail for the top findings is in §2 and the domain sections; this register exists to prevent duplicate tickets.

| ID | Root cause | Depends on | Verification criterion |
|---|---|---|---|
| R-01 (SEC-01) | Policy predicate selects the outer table's column instead of `profiles.tenant_id`; `FOR ALL` with no `WITH CHECK` | DBA approval; disposable-DB proof; app insert audit for NULL `tenant_id` | A test as tenant A cannot read/insert/update/delete tenant B rows on all ten tables; tenant A can do all four on its own |
| R-02 (SEC-02) | `USING (true)` on customer-facing tables | DBA approval; product decision on rider/queue access model | `anon` returns zero rows on `orders`, `consult_queue`; rider flow still works via an authenticated, scoped policy |
| R-03 (SEC-03) | Routes derive tenant from request and use service role | R-01 (so the fix is not undermined) | §5 test matrix |
| R-04 (CE-01) | Safety assets never wired to write paths | Clinical policy decisions §7 | Matrix §7 shows an enforced check per path, with a negative test |
| R-05 (FIN-01) | Dispense path performs two accounting representations of one event | Finance owner decision on which is authoritative | One dispense produces either a sale or an invoice, never both; ledger and billing agree in reconciliation |
| R-06 (SYN-01) | Server ignores `baseRevision` | Conflict policy decision | Two clients editing the same encounter produce one applied change and one explicit conflict record |
| R-07 (CI-01..04) | Release controls produce evidence rather than gate | Operator access | A deliberately failing CI run on `main` does not reach production; release job fails when evidence is missing |
| R-08 (DB-03) | Snapshot treated as truth, never diffed | DBA + CI change | CI fails when a rebuilt schema differs from the committed snapshot |
| R-09 (INT-01..03) | Interop implemented but never scheduled/deployed/validated | Stage 0 vendor confirmation | A scheduled job drains the queue; a DHIS2 rejection is recorded as partial, not success |
| R-10 (DB-01/DB-02) | Blanket grants; no column least privilege | DBA approval; API projection inventory | Per-table grant matrix reviewed; `anon` holds SELECT only on genuinely public objects |
| R-11 (SEC-05, SEC-08) | Two context helpers with different strictness | Security review | Deactivated user request returns 401/403 immediately after deactivation |

---

## 5. Import containment proposal (prepared, not applied)

**Target behaviour.** All four routes (`start`, `upload`, `execute`, `status/[batchId]`) evaluate a server-side switch as their first statement, before body or file parsing and before any service-role client is constructed. Missing, empty, malformed or unrecognised configuration means **disabled**. A disabled route returns 503 with `{ ok:false, code:"IMPORT_DISABLED" }` and reveals nothing about batches — including on `status`, so the endpoint cannot be used as an existence oracle.

No existing variable covers this. The nearest precedent is `SYNAPSE_ALLOW_HARD_PURGE`, a positive-enable switch defaulting to disabled (`api/platform/facilities/[id]/lifecycle/route.ts:157`). Reuse the *pattern*, not the name. The proposed name `SYNAPSE_PATIENT_IMPORT_ENABLED` is **new** and does not exist in the repository today; introducing it requires infrastructure approval because a new production variable must be set (or deliberately left unset) at deploy time.

**Second control layer.** Even when enabled globally, each request must additionally require `requireFeature(session.tenantId, 'patient_import')` and a tenant-scoped capability, so one tenant's need cannot re-open the endpoint for everyone. The feature gate is already fail-closed for unknown keys — verified: `has_feature` returns `COALESCE(v_has_plan,false)` with `IF NOT FOUND THEN RETURN false` (`20260620223902:214-218`, `20260612230655:141-143`) — so gating on a key never seeded disables import for every tenant by default, which is the intended containment posture.

**Third layer (independent of the switch).** Derive `tenantId` and `hospitalId` from `requireHospitalStaffContext()`; add `tenant_id` to every batch `select`/`update` predicate; require a session on `status`; delete the service-role client from `start` and `status` if the resulting RLS still permits the operation. A kill switch that can be flipped off is not a substitute for authorization that is correct when it is on.

**UI.** The migration page should render a disabled state when the API returns `IMPORT_DISABLED`. UI gating is secondary and must never be the enforcement point.

**Test matrix to prove containment.**

| # | Case | Expected |
|---|---|---|
| 1 | Unauthenticated start/upload/execute/status | 401; status returns no body |
| 2 | Flag unset, `""`, `"0"`, `"no"`, `"false"`, garbage | 503 `IMPORT_DISABLED` on all four |
| 3 | Flag on, tenant lacks `patient_import` | 403, no batch created |
| 4 | Cross-tenant batchId on upload/execute/status | 404, zero writes |
| 5 | Cross-tenant `hospitalId` in start body | 403 |
| 6 | Oversize file; wrong MIME; quoted CSV fields with embedded newlines | 413 / 415 / correct field count |
| 7 | Same file uploaded and executed twice | One batch, one patient per source row |
| 8 | Forced insert failure on row 5 of 20 | Batch `partial`/`failed`; rows 1–4 imported, 6–20 pending, retry resumes |
| 9 | 250-row file | All rows imported; batch not `completed` prematurely |
| 10 | Authorized happy path | Patients carry correct `tenant_id`, `mrn`, `dob`; audit rows tenant-scoped |

**Explicit warning for whoever implements this.** Do not repair IMP-02 (the `date_of_birth`/`mrn` mismatch) before SEC-03 is closed. Today the schema error is the only thing preventing a cross-tenant PHI write. Fixing the column names first removes that accidental protection.

---

## 6. RLS and disposable-test plan

**Policy inventory.** 548 policies across 317 tables; zero are `AS RESTRICTIVE`. Ten are broken (SEC-01). Three non-tenant policies grant world access (SEC-02). Effective `authenticated` access on the ten broken tables is full CRUD across all tenants; `anon` gets full SELECT on `products` and full SELECT/UPDATE on `orders`.

**Proposed remediation shape** (design only, not applied):

1. A new migration — do not edit the snapshot, which is the artefact that currently encodes the defect.
2. For each of the ten: `ALTER POLICY "tenant_isolation" ON public.<t> USING (tenant_id = public.current_tenant_id()) WITH CHECK (tenant_id = public.current_tenant_id())`, matching the pattern already used correctly on `billing_payments`, `clinical_prescriptions`, `interop_connections` and others.
3. Before applying, audit which application inserts can produce `tenant_id IS NULL`. `patients.tenant_id` is nullable and the import path writes `batch.tenant_id ?? null`; a strict `WITH CHECK` will reject those inserts, which is correct but will surface every un-scoped writer. That is the point — but it must be discovered on a disposable database, not in production.
4. Decide whether `platform_admin_bypass` remains permissive on these tables. It is a separate `FOR ALL` policy and, being permissive, ORs with the corrected predicate — acceptable only if `is_platform_admin()` is trusted; verify its definer and search path.
5. Add a CI gate that fails on any policy whose predicate is self-referential, and one that fails on `GRANT ALL ... TO "anon"` outside an allowlist.

**Disposable test harness.** `scripts/db-tests/run-isolated.sh` is partially sound: it pins `PGHOST=127.0.0.1`, binds `127.0.0.1::5432`, names its own container, and cleans up only that container. What it does *not* do is test tenant isolation — it exercises facility-invitation functions only. `scripts/check-db-acl.integration.test.mjs` refuses managed hosts and requires a `*acl_test*` database, but both guards are environment-bypassable and it tests EXECUTE privilege only. `packages/db/src/rls-matrix.test.ts` never opens a database.

**What a real isolation suite needs:** a disposable database created by name, two seeded tenants each with a patient, an encounter, a prescription and an invoice, four roles exercised (`anon`, `authenticated` tenant A, `authenticated` tenant B, `service_role`), and for each of the ten tables plus `orders`/`consult_queue`/`products`: SELECT same-tenant succeeds, SELECT cross-tenant returns zero rows, INSERT cross-tenant is rejected, UPDATE and DELETE cross-tenant affect zero rows. A skipped run must fail, not pass. Prerequisites for running it here: PostgreSQL 16 and Docker, neither of which is installed, and both explicitly out of scope for this audit.

---

## 7. Clinical and offline safety matrix

| Path | Allergy | DDI | Dose | Server-enforced | Override audited | Verdict |
|---|---|---|---|---|---|---|
| Prescribe online (`api/opd/prescriptions`) | none | none | presence only | tenant/encounter/patient only | n/a | CONFIRMED DEFECT |
| Prescribe via offline sync (`hospital/sync/apply`) | none | none | presence only | tenant/actor; wrong capability | n/a | CONFIRMED DEFECT |
| Hospital dispense | none | none | none | state machine + stock | n/a | CONFIRMED DEFECT |
| Pharmacy portal dispense | none | none | none | state machine | n/a | CONFIRMED DEFECT |
| Retail POS | none | none | n/a | price/stock; Rx flag not enforced | n/a | LIKELY DEFECT |
| Advisory DDI endpoint | n/a | pack only, no patient | no | fail-closed | not recorded | DESIGN GAP |

**Offline behaviour.** Pending versus confirmed is honestly represented in the UI ("Queued offline — not server-saved until reconnect"). Pharmacy sales are revalidated server-side at sync, with the client's `commandId` as the idempotency key and a payload-hash mismatch rejection. Clinical prescriptions are applied without revalidation. `baseRevision` is never compared; four apply sites hardcode `revision: 0`. The sync route authorises every command type under `encounter:create`, so an actor who may create encounters but not prescribe can push a prescription. The encrypted web queue is parked rather than cleared on sign-out, and only the `/lab` shell invokes sign-out at all.

**Decisions only a clinician or product owner can make** (these are questions, not recommendations):

1. Is a documented anaphylaxis allergy a hard stop, or a warning with a recorded reason?
2. Which DDI severity blocks — is `major` a stop or a pharmacist-review?
3. Is a ~72-pair pack an acceptable formulary scope for release, or is a licensed feed required?
4. Are dose-range, weight-based paediatric and renal adjustment in scope now or explicitly deferred?
5. Who may override, and is a reason plus countersign mandatory?
6. Must an offline prescription be re-screened before it reaches the pharmacy queue?
7. May an encounter close while an unscreened prescription is active?
8. What is the retention rule for the parked offline PHI queue on a shared device?

---

## 8. Interoperability and migration matrix

| Integration | Classification | Evidence | What Stage 0 must confirm |
|---|---|---|---|
| FHIR read (lab subset) | PRODUCTION-CAPABLE, VERIFIED | `fhir/_lib/serve.ts:33-195`; POST returns 405 | Nothing in code; write is unimplemented by design |
| Lab instrument ingest | PRODUCTION-CAPABLE, VERIFIED | `api/lab/instrument-ingest/route.ts:14-234` | Deployed? bridge keys issued? |
| Lab Edge gateway | IMPLEMENTED BUT UNVERIFIED | `apps/lab-edge/src/index.ts`; no deployment config | Whether any site runs it; fix accession attribution first |
| DHIS2 rollup + privacy export | IMPLEMENTED, unit-tested | `dhis2/{rollup,privacy-export}.ts` | Mappings seeded per facility |
| DHIS2 scheduling | **NOT SCHEDULED** | `vercel.json` crons list only billing-sweep | Whether an external scheduler exists |
| DHIS2 push | IMPLEMENTED BUT UNVERIFIED | `adapters/dhis2.ts:177-181` fabricates success count | DHIS2 version and import-report format |
| OpenMRS / UgandaEMR | SCAFFOLD ONLY | `adapter.ts:46-72`; no HTTP client; adapter constructed only in a test | FHIR R4 module present? Which version? |
| HL7v2 / ASTM (interop pkg) | SCAFFOLD ONLY | `adapter.ts:74-95` parses tokens only | — |
| Tally | SCAFFOLD ONLY | `tally-migration.ts:65-70` rejects `.xml`; CSV/JSON only | TallyPrime vs ERP 9; HTTP/XML vs file licence |
| ALIS | PLANNED | Only a mock in `simulation.ts` and marketing copy | Protocol, accession ownership |
| MPI / identity | SCAFFOLD ONLY | `mpi.ts` scores with `Math.max`, `shouldAutoMerge` returns false, no product caller | Matching policy and review workflow |
| `synapse_adapters` | UNSUPPORTED (dead table) | 0 TypeScript references | — |
| Outbox relay | SCAFFOLD ONLY | `exchange.ts` is an in-memory Map; no consumer worker | — |
| Machine-to-machine auth | PARTIAL | Lab bridge key only; FHIR requires a browser session | Credential model decision |

**Migration requirements (Tally and otherwise).** No migration may claim a field until the source format and target schema both prove it. The staged pipeline must be: source inspection → mapping → validation → dry run → human review → controlled commit → reconciliation → auditable rollback. TallyPrime and Tally.ERP 9 must be assessed separately, including version detection, company/ledger mapping, voucher types, stock items, units, batches, expiry, opening balances, historical vouchers, credit and partial payments, taxes, party balances and references. None of that exists today beyond CSV/JSON staging. Patient identity matching must never merge on name similarity alone; `shouldAutoMerge` returning false is the correct safety default, but `confidence` taking the maximum rather than accumulating evidence means a name+DOB+sex triple scores 70 and never reaches the 100 auto-link threshold — so the ladder is inert even if it were wired in.

**Verified correction to the playbook.** The playbook states the DHIS2 path is "about 70 percent finished" and that the lab result path is sound. Both hold for code completeness, but neither holds operationally: the DHIS2 worker is unscheduled, its success metric is fabricated, and the edge gateway has never been deployed. The playbook's warning that DHIS2 rejections are "usually silent in practice" is confirmed in this codebase — the adapter does not parse the import report at all.

---

## 9. CI/CD and release-gate review

**Verified from source.** The Vercel `ignoreCommand` contract is inverted relative to its name: exit 1 means build, exit 0 means cancel. Production always returns `skip:false`, so production always builds; nothing consults CI, git diff, lockfiles or test results. `vercel.json` sets `buildCommand` and the gate but the deploy is Vercel's Git integration, which runs in parallel with `ci.yml`. `deploy.yml` is a verification job plus an opt-in CLI deploy gated on `vars.ENABLE_VERCEL_CLI_DEPLOY == 'true'`, disabled by default; it is the only path where `needs: [verify, db-acceptance]` applies. `release.yml` triggers on `workflow_run: [CI]`, which is necessarily after the Vercel deploy. The pharmacy project has no `ignoreCommand` at all.

Two smoke paths pass on missing configuration (`release.yml:110-113`, `e2e-hospital-browser.mjs:10-18`), and `health-smoke.mjs` never sets a non-zero exit code. Only `verify-pharm-release.mjs` is fail-closed, and no workflow invokes it. `test:security-gates` and `test:db-acl:strict` are defined in `package.json` and referenced by no workflow. `db:check` is described in `release.yml` as a "Schema compatibility comparison" but only checks filenames, emptiness and duplicate versions.

**Run evidence.** `node --test scripts/vercel-build-gate.test.mjs` → 3 tests, 2 pass, 1 fail, exit 1. The failing assertion ("OS preview git deploys always build") also fails against the committed version of the gate, so this is a pre-existing red step on the branch, not something the local modification introduced. It is nonetheless a CI step (`ci.yml:129`) and the deploy path ignores it.

**Requires operator access and remains UNVERIFIED.** Whether `CI / required` is a required status check on `main`; whether direct pushes to `main` are permitted; environment protection and required reviewers for `production` and `production-acceptance`; the repository default `GITHUB_TOKEN` permission; whether `vars.PRODUCTION_URL` and `vars.ENABLE_VERCEL_CLI_DEPLOY` are set; each Vercel project's root directory and any dashboard-level ignored-build override; whether production promotion is manual.

**Recommended gate shape.** A release must fail closed on missing evidence: no `PRODUCTION_URL` means fail, not `BLOCKED`; a skipped browser journey means fail; `test:security-gates` and `test:db-acl:strict` run in the blocking job; provenance binds a *successful* CI run for the exact SHA; and the deploy path waits for that gate rather than racing it. Until those land, the production release hold stays in place.

---

## 10. Prioritised remediation roadmap

**Wave 0 — Immediate containment (days, not weeks)**

Close SEC-01 (ten policies) and SEC-02 (`orders`, `consult_queue`) with a reviewed migration proved on a disposable database. Deploy the import kill switch (§5) independently of the authorization fix, so either one alone reduces exposure. Add authentication to `import/status`. Keep the production release hold. *Exit:* cross-tenant access tests pass for all affected tables; import returns 503 everywhere; no release has shipped.

**Wave 1 — Identity and database assurance**

Repair the import authorization and idempotency properly (tenant from context, `dedupe_key`, atomic execute, audit rows), then and only then fix the `patients` schema mismatch. Bring `requireHospitalStaffContext` and `getCurrentUser` to one strictness level; revoke sessions on deactivation. Close the insurance and lab-notify IDORs. Build the real isolation test suite; make the ACL checker fail on `GRANT ALL`; wire `test:security-gates` into CI; guard `db-reset-fresh.sh`. *Exit:* tenant isolation proven by test, not by assertion; deactivation takes effect immediately.

**Wave 2 — Clinical and financial integrity**

Wire allergy and DDI into prescribe, sync-prescribe and both dispense paths, with override recording, once the clinical decisions in §7 are answered. Enforce `requires_prescription` at the point of sale. Resolve the dispense double-booking (one authoritative accounting representation). Make goods-received atomic; post write-offs to the ledger; reverse credit on refund; tenant-check `patientId` and add the FK. Honour `baseRevision` and add an explicit conflict record; tighten the sync capability. *Exit:* a negative test exists for every safety path; ledger and stock reconcile for a full month.

**Wave 3 — Migration and interoperability**

Stage 0 interface discovery for ALIS, Tally and the target UgandaEMR deployment. Build the connector runtime (registry, credentials, mappings, durable bus, reconciliation) before any connector. Fix the DHIS2 scheduler and import-report parsing first, since those are cheapest and already 80 percent built. Tally edge agent next (no clinical risk). *Exit:* one reconciliation report signed off by a facility.

**Wave 4 — Release engineering and reliability**

Fail-closed release gate; required checks enforced by branch rules; schema-drift detection in CI; concurrency, timeouts, permissions, retention; CodeQL no longer `continue-on-error`; monitoring for import failures, sync backlog, DHIS2 queue depth and reconciliation variance. *Exit:* a deliberately failing CI run cannot reach production, demonstrated rather than asserted.

Ordering constraint that is easy to get wrong: Wave 0's RLS fix must precede Wave 1's import repair, because the import repair will start writing tenant-scoped rows through paths that are currently unguarded. And Wave 1's schema repair must not precede the import authorization fix, for the reason stated in §5.

---

## 11. Proposed patch inventory

**Can be prepared locally, low risk, no clinical or financial semantics:** authenticate `import/status`; add the import kill switch helper and wire it into four routes; add rate limits and body caps to unauthenticated endpoints; replace raw `error.message` returns with generic messages; add `tenant_id` predicates to the insurance queries; guard `db-reset-fresh.sh` against non-loopback hosts; fix the failing workflow-safety assertion; fix the two column-name mismatches (cancel, pathway override) *after* the surrounding authorization work.

**Requires DBA and security approval before any execution:** the ten-policy RLS migration; `orders`/`consult_queue` policy replacement; `products` public projection (view or column-restricted API); revoking `GRANT ALL` from `anon` outside an explicit allowlist; function EXECUTE revocation where the snapshot still shows `anon`.

**Requires clinical or finance approval:** every item in Wave 2. None of it should be written until the §7 decisions are recorded, because the code encodes policy (what blocks, who overrides) that engineering must not invent.

**Requires infrastructure/operator approval and cannot be done from the repository:** Vercel deploy gating, required status checks, environment protection, new production variables, scheduler for DHIS2, deployment of lab-edge.

**Must remain blocked:** any production migration, any release, any data import, any vendor connectivity, and anything that would make the currently-broken patient insert succeed before SEC-03 is closed.

---

## 12. Commands and tests actually executed

| Command | Result |
|---|---|
| `git rev-parse --show-toplevel / --abbrev-ref HEAD / HEAD` | root, branch and SHA as in §1 |
| `git log -1 --format='%H %ci %s'` | `c9e53e3…`, 2026-10-22 17:16:43 +0300 |
| `git status --short --branch` | 29 entries; ahead 10 / behind 1 |
| `git rev-list --left-right --count origin/main...HEAD` | `1  10` |
| `git diff --stat`, `git diff --cached --stat` | 12 files, +685/−87; nothing staged |
| `git show HEAD:scripts/vercel-build-gate.mjs` | committed preview-branch logic, compared to working tree |
| Policy detector (Python, `-I`, reading the snapshot as text) | exactly 10 self-referential policies, all `FOR ALL`, all without `WITH CHECK` |
| `grep -c` over the snapshot | 317 tables, 548 policies, 68 functions, 33 SECURITY DEFINER, 0 RESTRICTIVE |
| grant counts | 302 table grants to `anon`, 316 to `authenticated`, 49 function grants to `anon` |
| `node --test scripts/vercel-build-gate.test.mjs` | 3 tests, 2 pass, 1 fail, **exit 1** |

Not run, deliberately: any database test, any migration or ACL script, any Playwright/E2E journey, any test requiring credentials or network, any build. `npm test` and `npm run verify` were not executed; they require installed tooling and, in the DB cases, a database. Build success was not treated as evidence of readiness anywhere in this report.

---

## 13. Decision register

| # | Decision | Owner |
|---|---|---|
| D1 | Approve the ten-policy RLS correction and its `WITH CHECK` semantics, including what happens to rows with NULL `tenant_id` | DBA + security |
| D2 | Choose the `orders` / `consult_queue` access model (rider auth, queue token) so `USING (true)` can be removed without breaking the flow | Product |
| D3 | Choose public product catalogue exposure: security-invoker view vs column-restricted API | Product + DBA |
| D4 | Approve introducing `SYNAPSE_PATIENT_IMPORT_ENABLED` (new variable) and its default-off posture in production | Infrastructure + security |
| D5 | Clinical safety policy, all eight questions in §7 | Clinical lead |
| D6 | Whether one dispense is a sale or an invoice, never both | Finance |
| D7 | Conflict policy for concurrent clinical edits and the offline-queue retention rule | Clinical + product |
| D8 | Confirm production migration state: is `20261022160000` applied, and do the five accounting triggers exist? | DBA |
| D9 | Confirm whether any external scheduler drains `/api/cron/dhis2-export` | Infrastructure |
| D10 | Release-hold ownership and the evidence required to lift it | Engineering leadership |
| D11 | ALIS and Tally interface facts (protocol, accession ownership, licence tier) | Vendor + delivery |
| D12 | Uganda DPA 2019 obligations for cross-system disclosure and retention — legal review, not inferred here | Legal |

---

## 14. Recommended next action

**Prepare, do not apply, a single migration that corrects the ten `tenant_isolation` policies, and prove it on a disposable database.** It is one artefact, roughly ten statements, with no product behaviour change for legitimate tenants and the widest exposure reduction available per unit of effort. It closes cross-tenant read, write and delete on encounters, vitals, drug orders and telemedicine PHI simultaneously.

Approval needed: DBA and security owner (D1), plus a disposable PostgreSQL instance to prove the four-role matrix before anything touches production. Until that approval exists, nothing further should be changed in the tree — in particular, do not repair the broken patient insert, because it is currently the only barrier to a cross-tenant PHI write.

---

*Prepared read-only on 24 October 2026. No file was modified, no migration applied, no database contacted, no deployment or release action taken. Working-tree changes were preserved exactly as found.*
