# Tenancy and Deployment Decisions — 2026-10-25

Status: **OPEN — owner decision required.** Nothing in this memo is an instruction to
deploy; every item below is a question only the operator can answer. The technical
evidence each question rests on is generated into `artifacts/readiness/evidence.json`
(timestamp `2026-10-25T11:30:49.880Z`, HEAD `c9e53e37fc2c6a22c1699e4d331b1a05e5ff659f`)
and guarded by `scripts/evidence-drift.test.mjs`.

---

## 1. The decisions (O2–O5)

### O2 — should `profiles.is_admin` and the staff-role policies be tenant-scoped?

- **Question.** Tightening these changes which records a facility administrator and a
  clinician can see. Is cross-facility visibility by an `is_admin` or a staff-role
  holder a legitimate clinical workflow, or an isolation defect?
- **Prepared assets.** `20261026130000_scope_admin_policies_to_tenant.sql` is prepared
  and unapplied for the `is_admin` half; `supabase/held/scope_staff_intake_policies_to_tenant.sql`
  is held and unapplied for the staff half and must stay outside every applying glob
  until this is answered.
- **Recommendation (default).** Treat both as isolation defects: scope them to
  `tenant_id = public.current_tenant_id()`. If cross-facility visibility is a real
  workflow, name the specific roles and records that need it and authorise an explicit,
  audited exception rather than leaving broad read policies in place.

### O3 — do patient-initiated telemedicine cases belong to a tenant, and which?

- **Question.** When a patient has no `profiles.tenant_id`, the intake route cannot
  resolve a tenant for the case. Which tenant owns such a case?
- **Consequence.** Until answered, B5 cannot be fully closed: the route now warns
  rather than fails silently, but the ownership question is a data-model decision the
  source cannot make.
- **Options.** (a) The facility the patient was onboarded under (derive from
  `user_id` / `patient_id`); (b) a designated "unaffiliated" tenant; (c) reject the
  case until a tenant is assigned at triage.
- **Recommendation (default).** Derive from the patient's onboarding facility; where
  none exists, reject with a clear triage step. This preserves tenant integrity and
  surfaces the gap instead of writing a NULL tenant.

### O4 — should the commerce-era tables be dropped rather than repaired?

- **Question.** `products`, `consult_queue` and `restaurants` have no application-code
  references. Should they be dropped, removing the whole SEC-02 surface on them?
- **Recommendation (default).** Drop them in a migration after confirming no external
  consumer (analytics, reporting, HMIS export) reads them. Dropping is cleaner than
  policy surgery and removes the residual `USING (true)` surface the repair can only
  partially close.

### O5 — must production Vercel deploys wait for CI?

- **Question.** Does the production deploy path require the CI check to pass?
- **Options.** (a) Disconnect the Git integration and make `ENABLE_VERCEL_CLI_DEPLOY`
  the only path; (b) configure Vercel deployment protection to require the check.
- **Recommendation (default).** Require the check (b). The source cannot enforce this;
  it is a hosting-platform setting only the operator can change.

---

## 2. Deployment prerequisite chain

No migration is applied to any deployed environment by this work. The order below is
the only path with an attestation gate; it is intentionally manual.

1. **NULL-tenant preflight.** Run `psql -X -v ON_ERROR_STOP=1 -f scripts/db-tests/nulls-preflight.sql`
   against an authorised read-only target (replica, staging, or restored copy) and
   record per-table NULL counts — see `docs/runbooks/NULL_TENANT_PREFLIGHT.md`. This
   decides whether a backfill is required before the repair can be applied anywhere
   real. **Blocker until run.**
2. **Decide O2 and O3** (§1) before `supabase/held/scope_staff_intake_policies_to_tenant.sql`
   is reinstated with a fresh timestamp prefix.
3. **Stage the repair.** Schedule `20261025120000`, `20261026130000` and
   `20261026120000` for staging via `db-production.yml` manual dispatch, which requires
   the literal `PRODUCTION` confirmation, the literal `RECONCILED` attestation, and a
   pinned 40-character SHA.
4. **Decide O4** before the repair reaches production, so the drop lands with the
   policy change rather than after it.
5. **Decide O5** so the released artifact is the CI-built one, not a local build.

---

## 3. Known residual finding (A5) — resolved at the root

A5 was a **bootstrap defect, not a migration defect**, and it is fixed. The
canonical snapshot grants `current_tenant_id()` only to `authenticated` and
`service_role` (`canonical_public_schema.sql:24148–24150`) and revokes `PUBLIC`.
The disposable stack diverged because `scripts/db-reset-fresh.sh` ran
`ALTER DEFAULT PRIVILEGES … GRANT ALL ON FUNCTIONS TO postgres, anon,
authenticated, service_role` before applying the snapshot, so every function the
snapshot created — including `service_role`-only RPCs such as
`adjust_pharmacy_batch_stock` — carried an `anon` grant that the snapshot's
`REVOKE … FROM PUBLIC` could not remove. The fix drops `anon` from that one
FUNCTIONS line only; TABLE and SEQUENCE defaults are unchanged, and explicit
`GRANT … TO "anon"` statements in the snapshot still apply. Rebuilt and
re-verified on 2026-10-25: `has_function_privilege('anon', …)` is now `f` for
`current_tenant_id` and `adjust_pharmacy_batch_stock`, and `t` for
`authenticated`; the RLS harness still passes. Pinned by
`scripts/db-reset-fresh.test.mjs`. No migration was added for this.
