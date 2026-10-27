# SYNAPSE-OS — Ecosystem Audit and Improvement Roadmap

**Date:** 24 October 2026
**Repository:** `/home/ebrine/Desktop/SYNAPSE-OS`
**Branch audited:** `integration/synapse-2026-10-09` (HEAD `c9e53e37`, 22 Oct 2026; 866 commits; 25 uncommitted files; 10 ahead / 1 behind `origin/main`)
**Basis of judgement:** source code, database schema, SQL migrations, CI configuration and test suites only. Product and readiness documents were not used as evidence.
**Scope:** architecture and code health, security and clinical safety, product and UX coherence, operations and delivery.

---

## 1. Verdict

This is not an early-stage prototype. It is roughly 222,000 lines of application and package code across four deployables, 317 relational tables with row-level security enabled on every one of them, 250 test files, and a verification culture that most health-tech teams do not reach before Series B. The domain modelling is genuinely serious: golden-journey tests for OPD dispense, encounter close gating, lab result persistence, inpatient lifecycle, referrals, death pathways, FHIR R4 contracts and ICD-11 outage survival. Those are the hard things, and they are present.

The risk is not that the team cannot build. The risk is that a meaningful share of the platform's safety properties exist as *declarations* rather than *enforcements*. Three patterns recur throughout the audit:

1. **Controls are declared but not enforced at the layer that matters.** Tenant isolation is written into 317 tables, yet ten of those policies are malformed and evaluate to "any authenticated user may read this". The test that is supposed to prove tenant isolation asserts against a hardcoded JavaScript array and never touches a database. Both the control and its proof are self-referential.
2. **Clinical safety assets are built but not on the critical path.** The schema contains `patient_allergies`, `drug_interactions`, `drug_contraindications`, `drug_dose_adjustments` and `medication_safety_checks`. No file under `apps/` or `packages/` queries any of them. There is an interactions endpoint, but nothing requires the prescribe or dispense path to call it, so the check is bypassed by omission.
3. **Verification measures activity rather than correctness.** Forty-plus chained commands and 41 CI steps produce a great deal of green. Almost none of it executes against PostgreSQL with a real JWT, so the security-critical layer — RLS — has no behavioural test at all.

The good news: every one of these is fixable in days, not quarters, and the codebase is well enough structured to accept the fixes. The recommendations below are ordered by patient-harm and breach risk, not by tidiness.

### Scorecard

| Area | Grade | Headline |
|---|---|---|
| Domain modelling and clinical workflow invariants | A− | Rare depth; golden journeys cover the hard cases |
| Test volume and intent | B+ | 250 files, but overwhelmingly in-memory fakes |
| Tenant isolation (design) | B | RLS on all 317 tables; 10 policies are broken |
| Tenant isolation (proof) | F | The RLS "matrix test" cannot fail on a real policy bug |
| Clinical safety (allergy, DDI, dose) | D | Data exists, logic does not reach the dispense path |
| Authentication and session handling | C+ | Solid primitives, weak policy on OTP-only login |
| API authorization consistency | C | No default-deny; five competing auth patterns |
| Type safety | D+ | 596 `as any` casts around Supabase, two drifting schemas |
| Architecture and boundaries | B− | No cross-app imports (good); `packages/db` is a domain layer (risk) |
| Design system and accessibility | D+ | About a dozen `@synapse/ui` imports; AA contrast failures; unlabeled inputs |
| Product surface honesty | C− | 88 of 306 pages are "Coming soon"; two patient portals |
| CI/CD and release gating | C | Broad and serial; production is not gated on CI |
| Observability and incident readiness | D | No logger, no tracing, no error tracker, 360 `console.*` |
| Migration reproducibility | C− | Snapshot-plus-cutoff; not rebuildable from empty |

---

## 2. P0 — Fix before the next production release

These four findings each have a plausible path to patient harm or to a reportable data breach. None requires a rewrite.

### P0-1 — Ten RLS policies make every tenant's clinical data readable by any authenticated user

**What is wrong.** Ten `tenant_isolation` policies compare the row's `tenant_id` to a subquery that selects *the row's own* `tenant_id` rather than the caller's profile. In PostgreSQL a qualified reference inside a correlated subquery resolves to the outer row, so the predicate reduces to `tenant_id = tenant_id`, gated only on the caller having any row in `profiles`.

```sql
CREATE POLICY "tenant_isolation" ON "public"."encounters"
  USING (("tenant_id" = ( SELECT "encounters"."tenant_id"
     FROM "public"."profiles"
    WHERE ("profiles"."id" = "auth"."uid"()))));
```

Affected tables, all with RLS enabled and `GRANT ALL` to `authenticated`:

| Table | Line in canonical dump |
|---|---|
| `encounters` | 23366 |
| `encounter_orders` | 23360 |
| `vitals` | 23900 |
| `hospital_drug_orders` | 23408 |
| `order_items` | 23521 |
| `products` | 23701 |
| `sync_conflicts` | 23797 |
| `telemedicine_intake_cases` | 23827 |
| `telemedicine_intake_messages` | 23833 |
| `gas_cylinders` | 23378 |

The correct pattern is used everywhere else in the same file, for example `patients` at line 23623 references `profiles.tenant_id`. This looks like a find-and-replace error applied to a contiguous block, not a design decision.

**Why it matters.** Any holder of a clinician or staff JWT can read every tenant's encounters, vitals, orders and telemedicine messages through PostgREST, and can write to them. The application's own BFF layer still filters by tenant in most routes, so this is not automatically a front-door breach — but it removes the second line of defence entirely, and it converts any single route-level mistake, any leaked anon key plus a valid user token, or any direct PostgREST call into a cross-tenant PHI exposure.

**The proof is broken too.** `packages/db/src/rls-matrix.test.ts` is the gate named "RLS tenancy matrix contract". It imports no database client. It asserts that a hardcoded array, `RLS_MATRIX`, contains `tenantB.select === false`, which is true by construction. The only real assertion against the schema greps the dump for `app_rw_*` policies — it does not look at `tenant_isolation` at all. This is why CI has been green.

**Fix.** A single migration replacing the ten policies with `tenant_id = public.current_tenant_id()` in both `USING` and `WITH CHECK`. The helper already exists, is `STABLE SECURITY DEFINER`, and reads `profiles` safely (`canonical_public_schema.sql:1254`). A ready-to-review draft is in Appendix B. Review `products`, `order_items` and `gas_cylinders` against their original consumer-commerce policies first — those three historically also allowed `customer_id`-scoped access and may need a second, narrower policy rather than replacement.

**Proof it is fixed.** Replace the tautological test with a database-backed one: spin the disposable Supabase stack (the `db-acceptance` job already does this), seed two tenants, mint a JWT for tenant A's staff user, and assert that `select * from encounters` returns zero rows belonging to tenant B for all ten tables. This test must be able to fail; run it against the current schema first and watch it go red.

**Effort:** 1–2 engineer-days, including the real test.

---

### P0-2 — No allergy, interaction or dose check sits on the prescribe, dispense or sale path

**What is wrong.** `createPrescription` validates two things: the medication name is non-empty and quantity is greater than zero (`packages/db/src/prescription-bridge.ts:56-60`). `dispensePrescription` checks role, verification state and stock (`:71-84`). The dispense route then calls `complete_pharmacy_sale` (`apps/web/src/app/api/hospital/pharmacy/dispense/route.ts:100-120`). At no point is the patient's allergy list, the drug's contraindications, or any interaction pair consulted.

This is not a missing feature that was never built. The schema has `patient_allergies`, `drug_interactions`, `drug_contraindications`, `drug_dose_adjustments` and `medication_safety_checks`, and `apps/web/src/app/api/pharmacy/interactions/route.ts` exposes a working check that returns `safe: false`. The problem is that nothing requires the caller to use it. A check that is optional is not a control.

**Why it matters.** A clinician can prescribe, and a pharmacist can dispense, a drug to a patient with a recorded anaphylactic allergy, with no server-side warning and no audit of an override. This is the single most direct patient-harm path in the codebase and it is regulatory exposure in every market the platform operates in.

**Fix.** Move the check into the transaction boundary, not the UI. In order: query `patient_allergies` and the curated interaction pack for the patient and drug pair; fail closed when allergy data is absent for a patient who has a prescription history; require a typed override reason for any block-level interaction; persist the check and the override into `medication_safety_checks` in the same call that creates the prescription or completes the sale. Do this in one shared package function used by OPD prescribe, hospital dispense, web POS and mobile POS — not four times.

**Proof it is fixed.** Golden tests per path: penicillin allergy plus amoxicillin must return 409 with a stable error code; overriding must require a reason and write a row; a patient with no allergy record must not silently pass.

**Effort:** 5–8 engineer-days for the shared module plus wiring and tests, assuming the interaction dataset is already loaded.

---

### P0-3 — The patient-import API lets any logged-in user write PHI into another tenant

**What is wrong.** Three routes under `apps/web/src/app/api/import/` authenticate the caller and then do nothing else:

- `start/route.ts:17-34` accepts `hospitalId` from the request body, uses `createServiceClient()` (service role, bypasses RLS) and inserts an `import_batches` row for whatever hospital was supplied.
- `upload/route.ts` and `execute/route.ts:9-53` take a `batchId`, load the batch with service role, and insert patient rows using `batch.hospital_id` / `batch.tenant_id` while only checking `if (!user) return 401`.
- `status/[batchId]/route.ts` has no authentication at all and returns batch progress.

There is no check that the caller belongs to the target hospital, holds an admin capability, or owns the batch.

**Why it matters.** This is a cross-tenant PHI write primitive available to every authenticated user of the platform, plus an unauthenticated disclosure endpoint keyed by a guessable identifier. It is exactly the class of bug that RLS would have stopped, which is why P0-1 and P0-3 compound.

**Fix.** Derive `hospital_id` and `tenant_id` from the server-side session context, never from the body. Require a hospital-admin capability. Scope `upload`, `execute` and `status` to batches owned by the caller's tenant, and require auth on `status`. If the import feature is not yet shipped to customers, disable the routes behind a flag until it is.

**Effort:** 0.5 engineer-day plus tests.

---

### P0-4 — Production deploys are not gated on CI

**What is wrong.** `scripts/vercel-build-gate.mjs:14-22` returns `skip: false` for every `VERCEL_ENV=production` deploy, with the comment "production OS/Pharmacy git deploy to main". Vercel's Git integration therefore builds and promotes `main` regardless of whether the CI workflow succeeded. The alternative CLI deploy job is disabled by default (`ENABLE_VERCEL_CLI_DEPLOY`), and `release.yml` produces evidence but deploys nothing.

**Why it matters.** Every gate in section 3 — the security assertions, the golden journeys, the secret scan — is advisory with respect to production. A red run ships. For a clinical system this is the difference between "we have controls" and "we have controls that can be skipped under deadline pressure", which is precisely when they are skipped.

**Fix.** Either make `ignoreCommand` query the GitHub Checks API for the commit and return `skip: true` unless the CI workflow is green, or move production promotion exclusively to `release.yml` behind `workflow_run: [CI]` and remove direct Git production deploys. The first is a smaller change; the second is more honest about where authority lives. Note also that `installCommand` in `vercel.json` is `npm install`, not `npm ci` — production builds are not installing from the lockfile deterministically.

**Effort:** 1 engineer-day, plus a decision on which mechanism owns promotion.

---

## 3. P1 — Next 30 days

| # | Area | Finding | Evidence | Impact |
|---|---|---|---|---|
| 1 | AuthZ consistency | Middleware returns `next()` for every `/api/*` path, so there is no default-deny on the API surface. Each of 246 routes authenticates itself, using at least five different primitives (`getCurrentUser`, `requireHospitalStaffContext`, inline `verifyToken`, `mobile-pharmacy-auth`, bridge auth). `import/*` simply forgot. | `apps/web/src/middleware.ts:247,259,291,314,379,401` | Silent authorization gaps are structurally easy to introduce |
| 2 | AuthN policy | Email OTP alone issues a full 7-day session for every role except `platform_admin`, bypassing password and lockout. The send endpoint is unauthenticated and rate-limits by IP only. | `apps/web/src/app/api/auth/email-otp/verify/route.ts:60-85`; `send/route.ts:9-78` | Email-account compromise yields clinician access |
| 3 | AuthN correctness | OTP attempt cap and single-use flag are updated in separate unconditional statements, so parallel guesses can exceed the cap and one code can be redeemed twice. | `packages/auth/src/otp.ts:104-137` | Brute force and replay window |
| 4 | Crypto | Pharmacy customer passwords use unsalted SHA-256 compared with `===`; login has no rate limit and trusts `tenant_id` from the body. | `apps/pharmacy/app/api/customer/auth/route.ts:9-19,23,31` | Offline cracking; credential stuffing; wrong-tenant writes |
| 5 | Session | Mobile pharmacy trusts the role claim in a 7-day JWT; only `is_active` is re-checked, so demotions do not take effect. | `apps/web/src/lib/mobile-pharmacy-auth.ts:44-69` | Revoked privileges persist |
| 6 | Clinical audit | `logHospitalAudit` is documented as unsuitable for "security-sensitive or clinical-state transitions", yet 82 files use it and only 8 use `requireHospitalAudit`. Encounter sign, close, prescriptions, triage and dispense use the best-effort variant, which swallows failures. | `apps/web/src/lib/hospital-shared/audit.ts:17-24`; `api/opd/encounters/[id]/sign/route.ts:135` | Clinical state can change with no durable audit row |
| 7 | Offline sync | Hospital sync writes with `revision: 0` and ignores `baseRevision`, so concurrent edits are last-write-wins. Offline prescribe accepts an arbitrary `pharmacy_tenant_id`, unlike the online route. | `api/hospital/sync/apply/route.ts:192,220,261`; `packages/db/src/clinical-offline-prescribe.ts:93-104` | Silent loss of clinical edits; cross-tenant prescription drop |
| 8 | Tenant scoping | POS `patientId` is validated for shape only, not ownership, while `customerId` is checked. | `apps/pharmacy/app/api/admin/pos/complete-sale/route.ts:60-66,217` | Sale linked to another tenant's patient |
| 9 | Rate limiting | `checkRateLimit` returns success and logs a warning when Upstash is not configured; `UPSTASH_REDIS_REST_URL/TOKEN` appear in none of the three env templates. | `apps/web/src/lib/rate-limit.ts:5-10,33-36` | Abuse and AI-cost protection are off in any environment built from the template |
| 10 | Resilience | Pharmacy has 130 `fetch()` calls and zero `AbortSignal`; web has 249 and 5. | `apps/pharmacy/**` | Hung upstream blocks POS requests until the platform kills them |
| 11 | Type safety | `supabaseAdmin as any` appears 525 times and `supabase as any` 71 times, out of 709 total `as any`. The client is properly typed (`packages/db/src/admin.ts:11,23,38`), so the generated 13,287-line schema is discarded at nearly every clinical call site. | e.g. `api/opd/prescriptions/route.ts:27,79` | Column and RPC changes fail at runtime, in money and clinical paths |
| 12 | Schema drift | Two hand-managed generated type files: `packages/db/src/types.ts` (181 tables, 20 Sep) and `apps/pharmacy/types/supabase.ts` (30 tables, 16 Aug). No `db:types` script exists. | both files | Pharmacy compiles against a five-week-stale subset |
| 13 | Duplication | A money-path validator was copied and diverged: the web copy returns raw Postgres text, the pharmacy original sanitises it. Only the original has tests. | `apps/web/src/lib/pharmacy-pos/sale-validation.ts:152` vs `apps/pharmacy/lib/pos/sale-validation.ts:153-157` | Schema internals leak; rules drift |
| 14 | CI duplication | `ci.yml` and `deploy.yml` both trigger on `pull_request` and both run the full suite; seven commands are duplicated. Neither has `concurrency` or `timeout-minutes`. CI is one 41-step serial job. | `.github/workflows/{ci,deploy}.yml` | Roughly 2× CI cost; stale runs burn to the 6-hour default |
| 15 | Release evidence | Release smoke writes `{"status":"BLOCKED"}` and exits 0 when `PRODUCTION_URL` is unset. | `release.yml:117-122` | A release can be "successful" without probing production |
| 16 | Cron drift | Root `vercel.json` declares one cron; `apps/web/vercel.json` declares three. Whichever the project uses, the others never run. | `vercel.json:9-16`; `apps/web/vercel.json:5-18` | Appointment reminders, stock alerts, DHIS2 export may silently not execute |
| 17 | Migration reproducibility | 190 migrations plus a roughly 940 KB hand-amended snapshot, with the "last folded" cutoff hardcoded in CI (`SNAPSHOT_CUTOFF=20260920190000`) and a pinned baseline commit (`19ef5d0`). `db:reset` cannot replay from empty. 63 quarantined and 10 unapplied `proposed/` migrations. | `deploy.yml:94-116`; `scripts/check-migration-history.mjs:9` | Fresh environments depend on tribal knowledge; snapshot edits change what CI tests |
| 18 | Broad RLS | Thirteen write policies grant `auth.role() = 'authenticated'` with no tenant or owner predicate, concentrated in `reasoning_*` (5 `FOR ALL`) and `telemedicine_*` (insert/update). | canonical dump 22703–22820, 23014–23018 | Any authenticated user can tamper with another tenant's reasoning trail and telemedicine queue |
| 19 | Patient surface | The patient dashboard links to `/patient/records` and `/patient/appointments`, both of which render "Coming soon." A second portal at `/health/*` is real and has a layout; `/patient/*` has no layout and 11 stub routes. | `health/dashboard/page.tsx:134-135`; `patient/appointments/page.tsx` | Live navigation dead-ends for patients |
| 20 | Silent failure | The public surveillance report inserts columns that do not exist, ignores the error, and returns a report ID. | `api/surveillance/report/route.ts:16-29` | Public-health reports are discarded while the caller is told it worked |

---

## 4. P2 — Next 90 days

**Architecture.** Six packages (`auth`, `config`, `db`, `email`, `interop`, `ui`) have no `scripts` block at all and only `packages/config` has a `tsconfig.json`, so roughly 51,000 lines of shared code is type-checked only transitively through app compiles; `turbo type-check` is green while packages are unchecked. `turbo.json` has no `test` task, so tests bypass the task graph and its cache. `packages/db` is a 40,954-line domain layer rather than a data layer — it contains provision orchestration, golden journeys, purchasing, simulation, DHIS2 export and CRM — which means a change to a clinical workflow edits the shared package and the blast radius is both products. There are no cross-app imports and no package cycles, which is a genuine strength worth protecting with a lint rule rather than rediscovering later.

There are three pharmacy implementations. `apps/pharmacy` has 87 routes with its own auth, session, rate limiting and capabilities; `apps/web` carries 31 `/api/mobile/pharmacy/*` routes; the Expo app reimplements POS and FEFO offline and imports zero workspace packages. The transaction layer converges on the `complete_pharmacy_sale` RPC, which is why this has not caused a money incident yet, but preflight validation, refunds, auth and offline logic are triplicated and will drift.

**Product and UX.** `@synapse/ui` is imported by about a dozen files — mostly layouts, theme providers and one test — and exports no Button, Card, Input or Table; every app hand-rolls primitives. Tokens diverge: web dark background `#07070A` with `0.75rem` radius, pharmacy `#121212` with `0.5rem`. Web contains 1,092 hex colour literals, 1,485 inline `style={{}}` blocks and 825 arbitrary `[#hex]` classes. `--text-muted: #60607A` on `#07070A` measures 3.31:1 and is used 435 times; brand orange on white is 2.80:1. Neither app sets `aria-invalid` anywhere; 131 `outline-none` declarations are mostly unpaired with `focus-visible`. There are zero `loading.tsx` files and one `error.tsx` across 347 pages. The "Accessibility smoke" gate greps eight files for a `SkipLink` import while a real axe script sits unwired.

**Terminology.** The same record is an "Encounter" in the OS, a "Visit" in the patient portal and a "Sale" in pharmacy, which has no encounter concept at all. For a product whose value proposition is continuity across three systems, that is a cognitive tax on every clinician who moves between them.

**Operations.** There is no logger, no tracing, no metrics and no error tracker; 360 `console.*` calls stand in. `/api/health/live` and `/api/ready` exist but nothing polls them. 286 routes are `force-dynamic` against one `revalidate`; 128 `select('*')` calls; six list endpoints have no limit. Playwright runs one worker, zero retries, Chromium only, with no pharmacy or mobile journey.

---

## 5. What is strong — do not break these

The point of listing strengths is to constrain the roadmap: none of the recommendations above require dismantling what works.

The domain invariants are the crown jewel. Encounter close gating, signed records, dispense verification separation of duties, idempotent sales, the offline outbox and the append-only sale path are real, tested behaviours. The FHIR R4 and ICD-11 packages, with offline outage survival tests, are the kind of interop foundation most competitors fake. RLS is enabled on all 317 tables and the correct tenant pattern exists and is used widely — the ten broken policies are an outlier, not the norm. No `service_role` key appears in client code, no `NEXT_PUBLIC_` variable is secret, JWTs use HS256 with a required secret, sessions are hashed and revocable, staff passwords use bcrypt cost 12, TOTP step-up has server-side recency and replay protection, and CSRF compares Origin and Referer hosts. Lab instrument ingest stores raw messages and stages rather than releasing results. The disposable-database acceptance job refuses to run against non-local URLs, which is exactly the discipline that prevents a test suite from writing synthetic patients into production.

The team also already knows how to write a real gate — `db-acceptance` is a genuine fail-closed job. The recommendation throughout is to apply that standard to the security layer.

---

## 6. Roadmap

### Phase 0 — Week 1: stop the bleeding (≈4 engineer-days)

| Work | Owner | Exit criterion |
|---|---|---|
| Ship the RLS repair migration (Appendix B) | Backend/DB | Migration applied to staging; `pg_policies` shows `current_tenant_id()` on all ten tables |
| Write a DB-backed cross-tenant test, confirm it fails on current schema, then passes | Backend | Test runs in `db-acceptance`, seeds two tenants, asserts zero cross-tenant rows |
| Lock down `api/import/*` (session-derived tenant, admin capability, auth on status) | Backend | Route tests prove a tenant-A user cannot touch a tenant-B batch |
| Gate production on CI, switch `npm install` → `npm ci` | Platform | A deliberately failing CI run does not promote to production |
| Freeze the 88 "Coming soon" routes out of navigation | Product | No live link resolves to a stub |

Phase 0 is deliberately small. It closes the three findings that would appear in a breach report or a coroner's inquest, and it establishes the pattern (real database test, not a constant) that Phase 1 depends on.

### Phase 1 — Days 8–30: clinical safety and truthful gates (≈20 engineer-days)

Build the shared medication-safety module and wire it into OPD prescribe, hospital dispense, web POS and mobile POS, in that order, with override reasons and persisted checks. In parallel, consolidate API authorization behind one wrapper that defaults to deny and requires an explicit `public` annotation, then migrate the 246 routes in batches. Make `requireHospitalAudit` the default on clinical transitions and treat a failure to write the audit row as a refusal to report success. Make rate limiting fail closed and add a 10-second `AbortSignal.timeout` helper to pharmacy's 130 fetch calls. Fix OTP atomicity and decide, explicitly, whether email OTP alone may issue a clinician session — if the answer is yes, document it as a deliberate risk acceptance rather than leaving it implicit.

Exit criteria for Phase 1: every clinical mutation path has an allergy interaction check with a test that proves it blocks; every API route is either wrapped or annotated public; a clinical transition cannot succeed without a durable audit row; CI contains at least one database-backed authorization test that has been observed failing.

### Phase 2 — Days 31–60: architecture and type truth (≈25 engineer-days)

Generate Supabase types from the linked project in CI, delete `apps/pharmacy/types/supabase.ts`, and add a `no-restricted-syntax` rule banning `as any` on the Supabase clients with a ratchet at today's 596, reducing it directory by directory starting with `api/opd`. Add `tsconfig.json` and `type-check` to all six packages, add `test` and `lint` tasks to `turbo.json`, and record the initial error count as a baseline rather than trying to fix it in one pass. Delete the mirrored sale validator and import the tested pharmacy version from both apps. Pick one owner for pharmacy APIs and make the other surface a proxy. Extract the 46-state cart machine from the 2,455-line POS page into a reducer with tests. Consolidate error responses into a single `jsonError` helper and introduce structured logging with request IDs.

Restructure CI: keep one reusable verify workflow, make deploy consume it via `workflow_run`, add `concurrency` with `cancel-in-progress` and explicit timeouts, cache `.next` and Turbo artefacts, and split into parallel jobs (fast unit, database, browser, security) so a lint failure does not cost 40 minutes.

Exit criteria: `as any` around Supabase below 200 and trending down under rule enforcement; every workspace checkable; PR p95 time under 15 minutes; one deploy workflow.

### Phase 3 — Days 61–90: product coherence and operational maturity (≈25 engineer-days)

Collapse the two patient portals into one. Choose `/health` or `/patient`, port the real screens, delete the stubs, and add a redirect so bookmarks survive. Move Button, Input, Label, Card and Table into `packages/ui` and codemod both apps. Raise `--text-muted` to at least 4.5:1, replace `outline-none` with `focus-visible` rings, label the 40 unlabeled inputs on the five platform pages, and wire the real axe script into CI so the accessibility gate stops being theatre. Add `loading.tsx` and `error.tsx` at the route-group level in both apps.

On the operational side: introduce an error tracker and structured logs with correlation IDs across BFF → RPC → outbox; alert on clinical write failures, not just HTTP 500s; make the migration chain reproducible by generating the snapshot manifest from `db-reset-fresh.sh` instead of hardcoding a cutoff in YAML and failing CI when a migration at or below the cutoff is missing from the snapshot; resolve the cron drift by choosing one `vercel.json` as authoritative and deleting the other's crons. Decide whether cross-product SSO is a product requirement — if it is, scope it now, because retrofitting identity across three auth implementations only gets more expensive.

Exit criteria: one patient portal with no stubs; AA contrast on body text; a11y check that can fail; first error-tracker issue triaged from production; fresh environment built from a single command in under 30 minutes.

---

## 7. Metrics to track

The point of a metric here is to make regression visible without reading code.

| Metric | Today | 90-day target |
|---|---|---|
| Malformed / over-broad RLS policies | 10 + 13 | 0 |
| Database-backed cross-tenant tests | 0 | ≥ 10 tables × 4 operations |
| Clinical paths with server-side interaction checks | 0 | 4 of 4 |
| Supabase `as any` casts | 596 | < 200, ratcheted in CI |
| API routes on the shared auth wrapper | ~90 / 246 | 246 / 246 |
| Workspaces with `type-check` | 3 of 9 | 9 of 9 |
| PR p95 CI duration | 25–40 min | < 15 min |
| Production deploys with green CI | not enforced | 100% |
| "Coming soon" routes reachable from nav | 88 | 0 |
| Contrast failures on body text | 3.31:1 | ≥ 4.5:1 |

---

## Appendix A — How each claim was verified

All counts were produced from the working tree on 24 October 2026, excluding `node_modules`, `.next` and build artefacts.

```
# RLS: self-referential policy detection
python3 - <<'PY'
import re
s=open('supabase/bootstrap/canonical_public_schema.sql').read()
for m in re.finditer(r'CREATE POLICY\s+"([^"]+)"\s+ON\s+"public"\."([^"]+)"(.*?);', s, re.S):
    sel=re.search(r'SELECT\s+"([^"]+)"\.', m.group(3))
    if sel and sel.group(1)==m.group(2) and 'auth' in m.group(3):
        print(m.group(2), s[:m.start()].count("\n")+1)
PY
# → 10 tables, lines 23360–23900

# RLS test does not touch a database
grep -nE "createClient|psql|DATABASE_URL" packages/db/src/rls-matrix.test.ts   # → no matches

# Safety tables are never queried by application code
grep -rl "patient_allergies" apps packages | grep -v node_modules
# → only packages/db/src/types.ts and one FK-actor test

# Type erasure
grep -rn "supabaseAdmin as any" apps packages | grep -v node_modules | wc -l   # → 525
grep -rn "supabase as any" apps packages | grep -v node_modules | wc -l        # → 71

# Inventory
find apps/web/src/app/api -name route.ts | wc -l        # → 246
find apps/web/src/app -name page.tsx | wc -l            # → 306
grep -rl "Coming soon" apps/web/src/app --include=page.tsx | wc -l  # → 88
find apps -name "loading.tsx" -not -path "*/node_modules/*" | wc -l # → 0

# Deploy gate
sed -n '14,22p' scripts/vercel-build-gate.mjs   # production always returns skip:false

# Rate limiting
sed -n '33,36p' apps/web/src/lib/rate-limit.ts  # returns {success:true} when Redis absent

# Fetch timeouts
grep -rn "fetch(" apps/pharmacy --include=*.ts --include=*.tsx \
  --exclude-dir=node_modules --exclude-dir=.next | wc -l   # → 130
grep -rn "AbortSignal\|AbortController" apps/pharmacy --include=*.ts \
  --exclude-dir=node_modules --exclude-dir=.next | wc -l   # → 0
```

Contrast ratios were computed from the sRGB relative-luminance formula: `#60607A` on `#07070A` = 3.31:1; `#F97316` on `#FFFFFF` = 2.80:1.

**Limits of this audit.** No production database was queried, so the RLS finding is established against the canonical snapshot dated 19 September 2026 plus all migrations after the cutoff. Before shipping the fix, run `select tablename, qual from pg_policies where policyname = 'tenant_isolation'` against production to confirm the live policies match the snapshot. No runtime load testing, pen testing or dependency CVE triage was performed; `npm audit` output is collected in CI but not gated. The audit read code only, so any control that lives entirely in Vercel or Supabase dashboard configuration is outside its view.

---

## Appendix B — Draft migration (review only, not applied)

This is a starting point for review, not a drop-in. Confirm the three consumer-commerce tables against their original intent before applying, and run it on a disposable stack first.

```sql
-- 20261024120000_fix_self_referential_tenant_isolation.sql
BEGIN;

-- Encounter, vitals, order and telemedicine tables: tenant-scoped clinical data.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'encounters','encounter_orders','vitals','hospital_drug_orders',
    'sync_conflicts','telemedicine_intake_cases','telemedicine_intake_messages'
  ] LOOP
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON public.%I', t);
    EXECUTE format($f$
      CREATE POLICY tenant_isolation ON public.%I
        FOR ALL TO authenticated
        USING (tenant_id = public.current_tenant_id())
        WITH CHECK (tenant_id = public.current_tenant_id())
    $f$, t);
  END LOOP;
END $$;

-- Consumer-commerce tables: review whether customer_id-scoped access
-- must be preserved alongside tenant scoping before applying.
--   products, order_items, gas_cylinders

-- Guard: fail the migration if any tenant_isolation policy still
-- references its own table instead of profiles.
DO $$
DECLARE bad int;
BEGIN
  SELECT count(*) INTO bad
  FROM pg_policies p
  WHERE p.policyname = 'tenant_isolation'
    AND p.qual ~ ('SELECT "' || p.tablename || '"');
  IF bad > 0 THEN
    RAISE EXCEPTION 'self-referential tenant policies remain: %', bad;
  END IF;
END $$;

COMMIT;
```

The guard at the end is the part worth keeping permanently: it converts "we fixed it once" into "it cannot regress silently", which is the same lesson as replacing the RLS matrix test.

---

*Prepared from source inspection on 24 October 2026. No files were modified and no migrations were applied.*
