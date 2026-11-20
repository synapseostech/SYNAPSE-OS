# Hospital core patient journey: audit and fixes (2026-11-20)

Scope: a small Ugandan hospital or clinic on the free tiers (Supabase free, Vercel Hobby, functions in dub1).
Branch `claude/hospital-core-flow-70352d`, migration `20261120140000_hospital_core_journey.sql` (prepared, not applied).

Production was inspected read-only (schema, capability rows, plan features, row counts). It has three hospital
tenants and **no clinical rows yet** (patients, encounters, invoices, lab orders and prescriptions are all 0), so
nothing here migrates data.

## 1. What exists

| Area | Where | State before this change |
|---|---|---|
| Hospital shell | `app/os/[slug]/*` (dashboard, patients, encounters/new, clinical/{queue,nursing,orders,dispense,tasks}) | The real staff UI. Tenant access checked in `layout.tsx`. |
| Facility admin | `app/hospital/admin/*` + `api/hospital/admin/*` | Departments, wards, beds, services, staff, payroll, modules, audit. Works. |
| Legacy role dashboards | `app/doctor/*`, `app/nurse/*`, `app/encounter/*`, `app/dept/*` (28 specialty pages) | Mostly placeholders or demo screens. They duplicate `os/[slug]/clinical/*`. Not linked from the hospital nav. |
| Emergency, mortuary | `app/emergency/triage`, `app/mortuary`, `api/mortuary/*`, `api/clinical/death-pronouncements/*` | Death and mortuary pathways have tests (`test:death-pathways`). ED is a partial slice. |
| OPD API | `api/opd/{triage,vitals,queue,prescriptions,lab-orders,encounters/[id]/*,results/*}` | Encounter, vitals, ICD-11 diagnoses, write-up, sign, close, disposition, Rx, lab orders. Capability-gated. |
| Billing API | `api/hospital/billing/encounter/[id]` (+ `/pay`) | Charges materialised from encounter, lab and dispense; payment collection. |
| Dispense | `api/hospital/pharmacy/dispense` | Verify, then `complete_pharmacy_sale` (stock decrement, idempotent per prescription). |
| Admission | `api/ipd/admissions` | Bed assignment and an admission task. No record of its own, no discharge. |
| Domain libs | `packages/db/src/{clinical-journey,work-queue*,clinical-charge,clinical-payment,encounter-*,inpatient-lifecycle,mpi}.ts` | Pure domain plus best-effort persistence, with golden-journey tests. |
| Interop | `packages/interop` | ICD-11 terminology, FHIR R4, runtime. Used by the diagnoses route. |

## 2. Journey status

| Step | Works end to end? | Finding |
|---|---|---|
| Registration | Yes | Duplicate check on name+DOB, phone and NIN with a 409 and a reasoned override. |
| Patient search | **Partly** | Name or MRN substring only, so you could not find a patient by phone or NIN at the desk. Two queries per keystroke, no debounce, and responses could arrive out of order. |
| Triage and vitals | **No for nurses** | `opd.triage.assign` was granted only to `doctor`, so nurses got a 403 recording OPD vitals. |
| Consultation, diagnosis (ICD-11) and Rx | **Sign, close and disposition: no** | `opd.encounter.sign/close/disposition`, `opd.result.review` and `opd.prescription.cancel` **do not exist in production**, so these routes returned 403 for every role. A fix had been prepared in `supabase/proposed/20260928_…` and never applied. |
| Lab orders | **Clinicians could not read them** | `lab.order.read` was granted only to lab roles, so the encounter orders panel was empty for doctors. The order and result contract with the lab (`lab_orders` + `/api/lab/*`) is unchanged. |
| Dispensing | Yes, in-house | Dispensing must come from the hospital tenant's own `pharmacy_products`. A prescription cannot be filled by a separate Synapse Pharm tenant (see follow-ups). |
| Billing and cashier | **No** | No cashier screen ("Billing" linked to the clinical orders page). `cashier` could read invoices but not take payments. The payment was a JS read, then insert, then update: two tills could both collect the same balance. Receipt numbers were 4 random digits. The panel's idempotency key was `encounter:amount:method`, so a second instalment of the same amount was silently dropped. |
| Insurance | **No** | `insurance_policies`, `insurance_providers` and `insurance_claims` exist, but nothing linked an invoice to cover. The patient's share was always 100%. |
| Admission and discharge | **Partly** | Bed occupancy was updated without checking the affected row count, so a double booking failed silently. There was no admission record and no discharge, so a bed stayed occupied forever. No UI. |
| Platform roles (#43) | Yes | `platform_admin` passes the staff context into any tenant. Hospital capability checks are not bypassed (P0-003), so platform staff do not get clinical rights automatically. |

Plan entitlements, which are a product decision and not changed here: `SYNAPSE OS Basic` has
`registration, opd, dispensing, billing, reports`. That plan does **not** include `lab` or `ipd`, and no plan has
`ipd` or `claims`. Lab orders therefore return 402 unless the tenant is on the OS + Lab add-on (or has a
`tenant_feature_overrides` row), and admissions return 402 everywhere.

## 3. Cost per request (before)

Every hospital API call made these round trips before doing any work, all sequential, from dub1 to eu-west-1:

1. the session (`synapse_sessions`)
2. the profile
3. the tenant
4. the hospital (when the profile has no `hospital_id`)
5. `has_capability`, once per check
6. `hospital_modules`
7. `platform_billing_config` (the module registry)
8. `has_feature`

That is 7 to 9 calls per request. Billing GET then read **every active product of the tenant** on each view, to
price dispensed drugs.

## 4. What this change does

**Database** (one migration, idempotent, all functions `SECURITY DEFINER`, pinned `search_path`, service_role only):

- **Capability seed.** Promotes the proposed OPD seed: sign, close, disposition, result review and Rx cancel for
  doctor and clinical officer; `lab.order.read/cancel` for clinicians; triage for nurses. Adds:
  - `billing.payment.record` and the new `billing.insurance.apply` for cashier
  - `billing.insurance.apply` for billing and claims officers
  - `ipd.admission.create` for clinical officers
  - `ipd.admission.read` for clinicians
  - the new `ipd.admission.discharge` for clinicians

  Reception, cashier and nurses still cannot sign, close, prescribe or discharge (a test checks this).
- **`hospital_staff_context(token_hash, user_id)`** returns session, profile, tenant and hospital in one call.
- **`hospital_search_patients`** matches on MRN (exact or prefix), NIN, phone and name, in one indexed query.
  - Phone matching uses the last 9 digits, so `0772…`, `+256 772…` and `256772…` all match.
  - Name matching is substring plus trigram, so a typo like "Okelo Jon" still finds "Okello John".
  - New indexes: `(tenant_id, upper(mrn))`, `(tenant_id, upper(nin))` and `(tenant_id, phone9)`.
- **Insurance on invoices.** New columns: `insurance_policy_id`, `insurer_id`, `insurance_cover_amount` and
  `insurance_claim_id`, each FK indexed. `hospital_apply_invoice_cover`:
  - reuses or creates the insurer and the patient's policy
  - checks the policy is active and not expired
  - caps the cover at the open balance
  - keeps one **draft `insurance_claims` row** in step, with the primary ICD-11 code
  - refuses changes once the claim is submitted

  The patient then owes total − cover − paid.
- **`hospital_record_payment`**: one transaction does all of this:
  - locks the invoice row
  - honours the idempotency key
  - draws a per-tenant daily receipt sequence (`RCP-YYYYMMDD-0001`, Kampala date)
  - updates paid and status
  - completes the billing task once the invoice is settled
- **`hospital_admissions`** gets a partial unique index for one active admission per patient and one per bed.
  RLS uses `(select public.current_tenant_id())`.
  - `hospital_admit_patient` row-locks the bed.
  - `hospital_discharge_patient` closes the admission, frees the bed and completes the admission task.
- Indexes added: cashier queue `(tenant_id, status, created_at desc)`, policies `(tenant_id, patient_id, status)`,
  and an index on every new FK.

**Server** (`apps/web`):

- `requireHospitalStaffContext` makes one RPC. Role-level capability answers, module toggles, the registry and plan
  features are memoised per warm instance for 60 s (the registry for 5 min). **Only grants are cached**, so a denial
  is always re-checked, a new grant shows at once, and a revocation takes up to 60 s. The session and the user's
  role are never cached. A warm request now makes **1** gate call instead of 7 to 9.
- Every new RPC has a fallback until the migration is applied: the old path is kept where one existed, and new
  features return a clear 503.
- `GET /api/patients/search` and the patients page use the new search.
- `POST …/encounter/[id]/pay` uses the atomic RPC.
- New routes:
  - `GET /api/hospital/billing/invoices`: the cashier queue, keyset-paged, one query with the patient embedded
  - `GET /api/hospital/billing/invoices/[id]`
  - `POST /api/hospital/billing/invoices/[id]/cover`
  - `POST /api/ipd/admissions/[id]/discharge`
- `POST /api/ipd/admissions` admits atomically, and its GET lists current inpatients.
- The charge materialiser reads only the products whose name shares a word with a dispensed drug, and none at all
  when nothing was dispensed.
- The tenant always comes from the server-side profile. No route reads `tenant_id` from the body or query
  (a test checks this).

**UI**:

- `/os/[slug]/billing` is the cashier screen: queue, invoice, take payment (cash, MoMo with reference, card, bank),
  insurance cover, receipts.
- `/os/[slug]/admissions` shows the ward board, an admit form with patient search and free beds, and discharge with
  an outcome.
- Patient search is debounced and shows sex, age and the last 4 digits of the phone.
- The nav adds Admissions for clinicians and nurses, and Billing for cashier, billing and claims roles.
- The encounter panel takes the insurance share into account and uses one idempotency key per payment.

## 5. Tests

- `npm run test:hospital-core` (vitest, 79 tests) covers every route touched:
  - patients search
  - cashier queue, invoice detail and cover
  - pay
  - admissions and discharge
  - staff context
  - capability cache
  - capability-seed coverage
  - tenant isolation
  - charge materialiser
- `npm run test:hospital-core-db` applies the migration twice to a disposable PostgreSQL 16 and checks the rules.
  It runs in Docker, or on local binaries when Docker is not available. Checks:
  - search: tenant scope, the phone formats, NIN, MRN prefix, LIKE escaping, trigram
  - cover: claim creation and reuse, over-cover, cross-tenant access
  - payments: idempotency before and after settlement, sequential receipts, overpayment, billing-task completion
  - admission: bed and patient locks; discharge frees the bed and completes the task
  - grants are service_role only
  - RLS on admissions
- Existing suites still pass: `test:tenancy`, `test:control-plane`, `test:death-pathways`, `test:lab-actions`,
  `test:clinical-*`, the golden journeys, `test:migration-integrity`, `test:security-gates`, `test:db-acl`,
  `test:routes` and `test:evidence-drift`. `tsc --noEmit` is clean in `apps/web`.

## 6. Not done (follow-ups)

- **Cross-tenant e-prescription to a Synapse Pharm tenant.** Today dispensing has to come from the hospital's own
  stock. Filling a hospital prescription at a separate network pharmacy needs a consent-scoped share and a
  pharmacy-side queue.
- **Claims desk.** Draft claims are created. Submitting them, adjudication and remittance stay in the existing
  insurance copilot and appeals screens, with no new UI here.
- **Legacy `app/doctor`, `app/nurse`, `app/encounter` and `app/dept/*` pages** duplicate the OS shell. They should be
  retired or redirected once the owner confirms nobody uses them.
- **Triage RPC.** `POST /api/opd/triage` still writes the encounter and the vitals as two calls. A failed vitals
  insert is reported (`vitalsRecorded: false`), not rolled back.
