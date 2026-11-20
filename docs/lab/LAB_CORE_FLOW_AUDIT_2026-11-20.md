# Synapse Lab core flow: audit and changes (2026-11-20)

Scope: the laboratory system inside a hospital and as a standalone lab tenant.
Baseline: `main` at `53e6abee`. Production schema was read with read-only
`information_schema` / `pg_catalog` queries. Production holds **0** lab orders,
results, specimens and reports, so no data needs migrating.

## 1. What existed

| Area | Files | State |
| --- | --- | --- |
| State machine | `packages/db/src/lab-workflow.ts` | **Works.** 13 states, legal-transition table, idempotent collect/verify/release retries, AI actors cannot verify, verified results only change through `amend()`. |
| Hospital lab adapter | `apps/web/src/lib/hospital-lab-db.ts` | **Works, slowly.** Loads the order, loads results, runs `LabWorkflow`, then writes order, specimen, result, report, outbox, tasks and timeline as separate calls, some "best effort". One verify was ~8 round trips plus ~7 for auth. Amendments were never written to `lab_result_amendments`. |
| Action route | `api/lab/actions` | Works. Capability checked, but `lab_tech` was blocked from verify by a hard-coded role list because the DB grants `lab_tech@hospital` `result.verify`. Audit was written *after* the domain commit, so an audit failure returned 503 with the change already saved. |
| Worklist | `api/lab/worklist`, `/lab/orders` | Works. Fixed `limit(100)`, no paging, no section, two queries. |
| Verify queue | `api/lab/verify-queue`, `/lab/verify` | Works. Role check only (no capability), no paging. |
| Specimens / results lists | `api/lab/specimens`, `api/lab/results` | Work. **No capability check**: any staff role at the facility (cashier, nurse) could list them. |
| Walk-in / referral | `api/lab/referral-orders` | Works for one test. **No billing**, no catalogue, a typed-in LOINC code. |
| Cancel | `api/lab/orders/[id]/cancel` | **Broken.** Requires capability `lab.order.cancel`, which does not exist, so every caller gets 403. |
| Critical ack | `api/lab/results/[id]/critical-ack` | Works for `lab_scientist`, `lab_manager`, `hospital_admin`, clinicians. `lab_admin` (a standalone lab's admin) is refused. |
| Reference ranges | `lab_reference_ranges` table + `DEMO_REFERENCE_RANGES` constant | **Duplicated, table unused.** The engine only reads the 6 hard-coded ranges. The table is global (no tenant), so a lab cannot set its own intervals. Sex/age are never passed in. |
| Reports | `lab_reports`, `packages/db/src/lab-report.ts`, `api/lab/reports/[id]` | Works. HTML snapshot with content hash on release and amend. Shows patient **UUID** and verifier **UUID**, no facility or patient name. `/lab/reports` page is "Coming soon". PDF is `NOT_CONFIGURED`. |
| Patient notification | `api/lab/notify` | **Stub for staff.** It can only notify the caller's own account (by design after a security fix). No staff path existed; no delivery record. |
| Analyser ingest | `api/lab/instrument-ingest`, `lib/lab-bridge-auth.ts`, `apps/lab-edge` | **Works.** scrypt bridge keys with prefix lookup, device validation gate, raw message stored first, dedupe by payload hash, staging only (never releases). One mapping query **per observation**. |
| Staging review | `api/lab/staging*`, `/lab/staging` | **Broken.** List selects `reviewed_by`, `reviewed_at`, `rejection_reason` and accept/reject write `reviewed_by`, `reviewed_at`, `clinical_result_id`, none of which exist on `lab_result_staging`, so the list 500s and accept saves the result and then 500s. Accept also takes any analyte under an accession, even one whose LOINC differs from the order's test. |
| Instruments / mappings | `api/lab/instruments*`, `api/lab/mappings*` | Work, but gated on `lab_manager`, a role nothing provisions and that has no capabilities. A standalone lab's `lab_admin` is locked out. |
| Lab Edge | `apps/lab-edge` | **Works.** ASTM/HL7 parsing, MLLP, durable SQLite queue, heartbeat, simulators; `test:lab-edge` passes. Unchanged here. |
| Device intelligence | `packages/db/src/lab-device-intelligence.ts` | Works. Critical rules duplicate the reference-range critical limits (second copy). |
| QC | `/lab/qc` | Stub ("Coming soon"). Still out of scope. |
| Mobile | `api/mobile/lab`, APK `(main)/lab.tsx` | **Reads the legacy `encounter_orders` table**, not `lab_orders`, with **no capability check**: any tenant user with a token could list patients' lab orders. Shows nothing from the real lab flow. |
| Standalone lab tenants | `packages/db/src/facility-provision.ts` (`provisionLaboratoryFacility`) | Works: tenant `facility_type = laboratory`, a `hospitals` row (`facility_kind = laboratory`), `lab`, `billing` and `registration` modules, an invited `lab_admin`. No starter test catalogue, so a new lab has nothing to order. |

### Capabilities in production (module `lab`)

`lab_tech@hospital` holds `result.verify`; `lab_tech@laboratory` holds nothing;
`lab_manager` and `lab_supervisor` hold nothing; `order.cancel`, `report.*` and
`billing.*` do not exist. `doctor` can create but not read lab orders.

### Duplications

1. Reference ranges: `DEMO_REFERENCE_RANGES` (code) vs `lab_reference_ranges` (DB) vs `DEFAULT_CRITICAL_VALUE_RULES` (device intelligence).
2. Lab orders: `lab_orders` (real) vs `encounter_orders where order_type='lab'` (mobile only).
3. Raw analyser messages: `lab_device_messages` vs `lab_analyzer_messages` (legacy fallback in ingest).
4. Role allow-lists hard-coded in six routes, disagreeing with `role_capabilities`.

### Existing suites (baseline, all green)

- `npm run test:lab-actions`: 8 files, 33 tests.
- `npm run test:security-remediation`: green.
- `npx tsc --noEmit` in `apps/web`: clean.

## 2. What this change does

See the PR for the full list. In short:

- **One call per step.** `lab_access()` replaces the 5–7 auth/capability/module
  calls with one; `lab_order_bundle()` loads order, result, specimen, patient
  sex/age, the tenant's reference ranges and catalogue entry in one; and
  `lab_commit_action()` writes order, specimen, result, amendment, critical ack,
  report and the audit row in **one transaction** with an optimistic
  `expected_status` guard. The TypeScript `LabWorkflow` stays the only state
  machine.
- **Catalogue and sections.** `lab_test_catalog` (per tenant: code, LOINC, section,
  specimen, container, unit, price, turnaround). A trigger fills `lab_orders.section`
  and `catalog_test_id` from the catalogue, so hospital orders keep the existing
  contract and still land in the right section.
- **Reference ranges per tenant** with sex/age, falling back to the national pack;
  the engine now uses them and the patient's sex and age.
- **Walk-in orders** for several tests at once, with billing from the catalogue
  price (falls back to `service_catalog`).
- **Barcode labels** (Code 128, printable), **paged worklists by section**,
  **critical queue**, **printable report** (patient and facility names, print/save as PDF),
  **staff-initiated patient notification** with a delivery log.
- **Staging fixed** (missing columns added, LOINC must match the order), ingest maps
  all observations in one query.
- **Capabilities corrected** in the DB, role allow-lists removed from routes.
- **APK**: the lab tab reads `lab_orders` behind a capability check and can look a
  result up by accession or patient name.

## 3. The journey after this change

| Step | Where | Calls to the database |
| --- | --- | --- |
| Hospital order | unchanged `POST /api/opd/lab-orders`; the trigger files it under its section | unchanged |
| Walk-in / referral, several tests | `POST /api/lab/walk-in` (`/lab/walk-in`); `referral-orders` kept | 1 access + 1 registration + billing per priced test |
| Collect, print label | `collect` action, `GET /api/lab/orders/[id]/label` (Code 128, 50×25 mm) | 1 + 1 load + 1 accession + 1 commit |
| Receive / reject | `receive`, `reject` | 1 + 1 + 1 |
| Worklist by section and stage | `GET /api/lab/worklist?section&view&q&cursor` | 1 + 1 (keyset paged) |
| Result, by hand | `enter_result` (tenant ranges, patient sex/age, critical flag) | 1 + 1 + 1 |
| Result, from an analyser | lab-edge → `instrument-ingest` (one mapping query) → staging → `accept` (LOINC must match) | ingest unchanged otherwise |
| Senior authorisation | `authorise` (verify + release + report in one commit), or `verify` then `release` | 1 + 1 + 1 (+ hospital hand-off) |
| Critical values | `GET /api/lab/critical`, `POST /api/lab/results/[id]/critical-ack` | 1 + 1 each |
| Report, print / PDF | `GET /api/lab/reports`, `GET /api/lab/reports/[id]?format=html` | 1 + 1 |
| Tell the patient | `POST /api/lab/reports/[id]/notify` (push / sms / print, once each) | 1 + 3–5 |
| Amend | `amend` (new report version, old one kept) | 1 + 1 + 1 |
| Catalogue, prices, ranges | `/lab/catalog`, `/api/lab/catalog*`, `/api/lab/reference-ranges` | 1 + 1 |
| APK look-up | `GET /api/mobile/lab?q=` (accession, name, patient no.) | 1 + 1 (+3 counts on the first page) |

"1 +" is the `lab_access()` call. Before, the same guards cost 5–7 calls and a
verify cost about 8 more.

## 4. Contract with the hospital flow

Kept: inserting into `lab_orders` the way `POST /api/opd/lab-orders` does,
`department_tasks` (`lab_order` completes on release, `doctor_result_review`
is created, STAT when critical), the `LabResultReleased` outbox event, the
timeline event, `executeHospitalLabAction` / `fetchHospitalLabWorklist` names
and shapes.

Changed on purpose:

- `POST /api/lab/actions` answers 404 for an unknown order and 409 for an
  illegal step or a concurrent change (`LAB_STALE_ORDER`), instead of 400 for
  everything. It no longer answers 503 `AUDIT_REQUIRED_FAILED`: the audit row
  is in the same transaction as the change. New fields: `idempotent`,
  `reportId`, `critical`, `labelUrl`.
- New action `authorise` (verify and release in one step).
- `lab.result.verify` is removed from `lab_tech` / `lab_technician`.
- `doctor` and `clinical_officer` gain `lab.order.read`, `lab.report.read` and
  `lab.order.cancel` at hospitals.
- `lab_orders` gains `section`, `catalog_test_id`, `order_source` (default
  `hospital`) and `referral_source`; all optional for inserts.

## 5. Still not done

- **Panels.** An order carries one result value. FBC, LFT and U&E need
  component results (one row per analyte under one order); until then order the
  analytes (Hb, WBC, platelets…) separately or type a summary. Analyser results
  for a panel order cannot be accepted (the LOINC check refuses them).
- Binary PDF rendering (needs a renderer; the print view saves as PDF from any browser).
- SMS: the delivery log records `sms` as `SKIPPED` (`SMS_PROVIDER_NOT_CONFIGURED`).
- QC (Levey-Jennings, Westgard), reagent stock, turnaround-time dashboards.
- The OPD order route still prices hospital lab orders from `service_catalog`
  by name; it could read `lab_test_catalog.price` first.
- The pages were type-checked and their API calls are tested, but they have
  not been looked at in a browser.
