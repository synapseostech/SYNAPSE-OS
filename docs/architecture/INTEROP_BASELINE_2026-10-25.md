# Interoperability baseline — 2026-10-25

Read-only inventory of the interoperability assets as they exist in this tree.
This is the factual ground for Job B; it contains no recommendations, no
connector design, and no code.

| Claim | Verdict | Evidence (file:line) |
| --- | --- | --- |
| `synapse_adapters` exists in the schema | Confirmed | `supabase/bootstrap/canonical_public_schema.sql:9319` (CREATE TABLE), `:9332` (mode check), `:11824–11825` (PK), `:22971` (RLS), `:26155–26156` (grants) |
| `synapse_adapters` has zero code references outside SQL | Confirmed | The only non-schema occurrences are SQL artifacts (`artifacts/readiness/consolidated_migrations_for_e2e.sql:11107`, `artifacts/readiness/remote-schema-migrations-data-2026-09-11.sql:9226`) and a quarantined migration (`supabase/migrations_quarantine_local_only_2026-09-11/20260828120000_project_golden_intelligence_icd11.sql:65`). No `.ts`/`.tsx`/`.mjs`/`.js` reference. |
| `domain_events` has an outbox relay worker | **Refuted** | `synapse_domain_events` is written in-process (`apps/web/src/lib/platform/simulation-runtime.ts:243,311`; `packages/db/src/work-queue-persist.ts:112`) and read by an API (`apps/web/src/app/api/platform/events/route.ts:22`). The outbox is in-memory (`packages/db/src/exchange.ts:1–3`). No relay/worker drains it: `vercel.json` lists only the `billing-sweep` cron. |
| FHIR surface is read-only | Confirmed | Only GET handlers exist: `apps/web/src/app/fhir/[resource]/route.ts` (search) and `apps/web/src/app/fhir/[resource]/[id]/route.ts` (read), both delegating to `apps/web/src/app/fhir/_lib/serve.ts`. No POST/PUT/DELETE handler. |
| FHIR surface is cookie-authenticated only | Confirmed | `apps/web/src/app/fhir/_lib/serve.ts:22–27` requires a user via `getCurrentUser()`; `apps/web/src/lib/auth/getCurrentUser.ts:17–18` reads the session from `cookies()` (`SESSION_COOKIE`). No API-key/token path. |
| DHIS2 export exists | Confirmed | `apps/web/src/app/api/cron/dhis2-export/route.ts:10` ("Nightly DHIS2 export worker — drains pending/failed aggregate jobs"); machinery in `packages/db/src/dhis2-export.ts`. |
| DHIS2 drain is unscheduled | Confirmed | `vercel.json` `crons` contains only `/api/cron/billing-sweep` (`15 21 * * *`). No cron entry for `dhis2-export`; no in-repo scheduler. |
| Tally support is CSV/JSON staging only and rejects `.xml` | Confirmed | `packages/db/src/tally-migration.ts:69–72` — `adapterFor()` returns `TallyJsonAdapter` for `.json`, `TallySpreadsheetAdapter` for `.csv`, and throws `MIGRATION_UNSUPPORTED_FILE_TYPE` otherwise. `"tally-xml"` appears in the `MigrationFormat` type (`:2`) but no adapter implements it, so `.xml` is rejected. |
| An ALIS connector exists | **Refuted** | The only ALIS code is a simulation adapter: `packages/interop/src/adapters/simulation.ts:100–107` (`createSimulationAdapter("alis")` → "Mock ALIS", `simulation: true`). `apps/web/src/app/platform/integrations/page.tsx:52` states the adapters "are not live eAFYA, ALIS, UgandaEMR or DHIS2 integrations." No live ALIS connector. |

## One-paragraph summary

The canonical model, the adapter ladder and the export paths exist; the connector
runtime does not. `synapse_adapters` is schema-only, `domain_events` is written
and read in-process with no relay worker, FHIR is a read-only cookie-authenticated
subset (Observation, Specimen, DiagnosticReport), DHIS2 export exists but its drain
is unscheduled, Tally is CSV/JSON file staging only, and ALIS is a mock adapter.
There is no live connector to any external system in this tree.
