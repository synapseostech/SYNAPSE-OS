# Clinical Intelligence — Wave 1

**Status:** implemented behind feature flag `CLINICAL_INTELLIGENCE_WAVE1` (**default OFF**).
**Rule:** AI advises; clinician decides. No auto-enable in production.

## What shipped
- Context engine → `PatientContextPacket` (tenant from session only; encounter resolved inside the caller's tenant)
- Provider router: OpenRouter (Google free models + optional NVIDIA via OpenRouter), DeepSeek, mock.
  Every live call is time-bounded (20 s) and failures are classified
  (`timeout`, `rate_limited`, `unavailable`, `invalid_response`, `auth`, `not_configured`).
  There is no direct Google API route; Google models are reached through OpenRouter.
- Strict model-output validation (`model-output.ts`): a recommendation string is required, lists and text are
  bounded, confidence must be finite, pathway ids must exist in the governed catalog.
- ICD-11: model hints are verified by **exact** stem match against the trusted cache. Prefixes, truncated
  stems and unknown codes are rejected and only counted. The recommendation never carries a code: the clinician
  selects from `icd11Candidates`.
- Graceful degradation: provider failure or unusable output → deterministic advisory with `degraded: true`
  and `degradedReason`; normal clinical documentation is unaffected.
- Output labelling: `origin: "ai_suggestion"`, `clinicianDocumentation: false`, `humanOverrideRequired: true`,
  and `safety.canActivatePathway/canPlaceOrder/canSignDiagnosis` are always `false`.
- API: `POST /api/clinical/intelligence/advise`
  - **503** when the flag is OFF, before any auth, DB or provider call
  - hospital staff session + `encounter:create` (OPD) capability required (cashier/receptionist roles → 403)
  - zod-validated body; caller-supplied `tenantId` rejected; foreign encounter → 404
  - clinician decision limited to `ACCEPT | MODIFY | REJECT | DEFER`
  - rate limit keyed per clinician
  - `forceMock` honoured only when `CLINICAL_INTELLIGENCE_ALLOW_FORCE_MOCK=1` and not on Vercel production
- Provenance: advice and override events are appended to `clinical_ai_advice_events` when the table exists;
  if the migration is not applied the request still succeeds with `provenancePersisted: false`.

## Migration `20261007120000_clinical_intelligence_advice_events.sql` (NOT applied to production)
- Tenant-scoped; FKs to tenants, profiles (clinician), patients, encounters.
- Trigger enforces that clinician, patient and encounter belong to the row's tenant (and encounter↔patient match).
- Append-only: UPDATE / DELETE / TRUNCATE rejected by trigger and revoked from `service_role`.
- RLS enabled with no policies; all privileges revoked from `anon` / `authenticated`.
- Indexes: (tenant, created_at), (tenant, encounter, created_at), patient, clinician, recommendation id.
- Behaviour verified on a disposable Postgres (19 cases): `docs/clinical-intelligence/advice-events-behavior-test.sql`.
- Operational note: rows reference patients/encounters, so hard-deleting a patient or tenant with advice
  history is blocked by FK (by design for audit integrity).
- Rollback (only while unused): `drop table if exists public.clinical_ai_advice_events; drop function if exists public.clinical_ai_advice_events_guard();`

## Tests
`npm run test:clinical-intelligence` (wired into CI): flag-OFF behaviour, RBAC, tenant isolation, override
validation/persistence, provider timeout / 429 / 503 / invalid JSON / fallback / no-provider (all mocked;
no patient data leaves the test process), ICD-11 exact verification, pathway restriction.

## Enable (non-prod / explicit ops only)
```bash
CLINICAL_INTELLIGENCE_WAVE1=true
# optional: CLINICAL_AI_PROVIDER=nvidia
# OPENROUTER_API_KEY=...  and/or DEEPSEEK_API_KEY=...
```

## Non-goals (Wave 1)
- Activating pathways, placing orders, signing diagnoses, prescribing, certifying death
- Writing clinician documentation from AI output
- Production flag enable without ops approval
- Applying the advice-events migration to production without approval
