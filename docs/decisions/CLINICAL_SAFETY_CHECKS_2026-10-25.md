# Clinical safety checks — design and what unblocks them

Status: implemented in `apps/web/src/lib/clinical-safety/`, wired into OPD
prescribing and hospital dispensing. All checks pass. **No check may be described
as protecting patients against interactions, contraindications or dose error yet
— the catalogues behind them are empty.**

---

## 1. What exists

Four checks run on every `POST /api/opd/prescriptions` and every
`POST /api/hospital/pharmacy/dispense`, before anything is written:

| Check | Source table | Data present today |
|---|---|---|
| Allergy match (name + ATC prefix) | `patient_allergies`, `patients.allergies` | **Yes** — real patient records |
| Drug–drug interaction | `drug_interactions` | No — 0 rows |
| Contraindication vs diagnosis | `drug_contraindications` + `encounter_diagnoses` | No — 0 rows |
| Dose adjustment (renal / weight / age) | `drug_dose_adjustments` + `vitals` | No — 0 rows |

Renal function is resolved from the encounter's `vitals`: measured `egfr`, then
`creatinine_clearance`, then Cockcroft-Gault. The estimate is refused when
`creatinine` is above 20, because the column declares no unit and this deployment
records µmol/L values. A wrong clearance figure is worse than an absent one; the
domain reports `unavailable` and the clinician is told to review manually.

The result of each check is written to `medication_safety_checks`, a table that
has existed in production since before this work and had no writer. It now records
the alerts raised, the coverage states, the policy in force, and — when a
prescriber or pharmacist proceeds past a block — who overrode it and why.

## 2. Why "no alerts" is not reported as "safe"

`evaluateSafety` returns a per-domain `coverage` state alongside the alerts. A
table with zero rows is `empty`, not `loaded`; a failed read is `unavailable`. Any
such domain makes the evaluation `indeterminate`, and the API response carries
`indeterminate: true` with the domain names.

This is the difference between the checker and a ritual. A checker that returns
an empty array from an empty catalogue is indistinguishable from one that returns
an empty array from a clean patient, and the first is the one that kills someone.

## 3. Why nothing blocks by default except allergy

Policy is per-domain (`CLINICAL_SAFETY_<DOMAIN>_MODE` / `_BLOCKAT`), validated at
read time, and recorded with every check. Defaults:

- **allergy** — block at `high` (severe, anaphylaxis). The data is real.
- **interaction / contraindication / dose** — warn, block only at `critical`.
  Blocking on an empty catalogue blocks nothing today and blocks everything on the
  day of a half-reviewed first import.
- **indeterminate** — warn. Always surfaced, never silently allowed.

An override requires `safety_override_reason` (minimum 8 characters, rejected at
the schema). A short override is not a record of a clinical decision.

Whether any of these should block is a clinical governance decision. The defaults
are a starting position for the hospital to ratify, not an engineering choice.

## 4. The structural limit: nothing in the path carries a drug code

`clinical_prescriptions` stores `medication_display` — free text, no code.
`pharmacy_products` has `name`, `generic_name`, `active_ingredient` — no ATC
column. Every interaction and contraindication lookup is therefore a **name
match**, done on normalised tokens with a conservative rule: whole-token only, so
`penicillin` does not match `penicillamine`, and catalogue names under four
characters never match at all.

Consequences to accept until the data model changes:

- Synonyms across markets (paracetamol / acetaminophen, salbutamol / albuterol)
  do not match. No dictionary exists in this tree.
- A brand name that shares no token with the catalogue's generic name will not
  match. At dispense the product's `generic_name` and `active_ingredient` are
  added as aliases, which covers most of this case; at prescribe it is not
  covered at all, because the clinician's free text is all there is.

**The remediation is a data-model change, not a matching improvement:** add an
ATC-coded drug reference to `pharmacy_products` and to `clinical_prescriptions`,
and make the prescribe form pick from it. Name matching then becomes the fallback
for legacy free-text rows instead of the only mechanism.

## 5. Also found, not fixed

- `patients.allergies` (jsonb) duplicates `patient_allergies`. Both are read and
  de-duplicated by name; entries found only in the legacy column are marked
  unverified in the alert. One of the two should be retired.
- The dispense route records the chosen `product_id` on the pharmacy sale, never
  on the prescription. So a prescription cannot be traced to the product that
  satisfied it.

## 6. What must happen before this can be called a control

1. Populate the three catalogues from a named, reviewed source, with a `source`
   column value that identifies it.
2. Add the coded drug reference described in §4.
3. Ratify the enforcement policy with the hospital's clinical governance group
   and set the environment variables in each deployment.
4. Re-run `npm run test:clinical-safety`, then exercise one real prescription and
   one real dispense against a populated environment and read the
   `medication_safety_checks` rows they produce.

Until 1–4 are done, the allergy check is a control and the other three are
scaffolding that reports its own emptiness.
