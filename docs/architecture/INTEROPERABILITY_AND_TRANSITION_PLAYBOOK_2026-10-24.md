# Interoperability Architecture and Transition Playbook

**Date:** 24 October 2026
**Scope:** Connecting Synapse to UgandaEMR/OpenMRS, DHIS2, ALIS and Tally, with a coexistence-first transition model and bidirectional live flows.
**Basis:** source inspection of `packages/interop`, `apps/lab-edge`, `packages/db`, `apps/pharmacy` and the database schema. Vendor interface details for ALIS and Tally are stated as assumptions to be confirmed in Stage 0, not as facts.

---

## 1. The decision that determines everything else

There are two ways to sell this. The first is replacement: migrate the facility off its existing systems in one cutover and become the system of record. The second is coexistence: Synapse connects to what the facility already runs, proves agreement with it daily, and lets the facility switch off one department at a time when it chooses.

You have chosen coexistence, and that is the right call for this market. A Ugandan district hospital will not switch off UgandaEMR because a new vendor asks it to. A pharmacy will not abandon Tally in the middle of a financial year. A public lab will not stop reporting to ALIS. The saleable promise is not "replace your systems" — it is "your systems keep working, and now they talk to each other."

This changes the engineering requirement. In a replacement model, the hard problem is data migration. In a coexistence model, the hard problem is **provable agreement**: for as long as two systems both hold the same fact, you must be able to demonstrate, daily and per record, that they agree — and you must be able to prove which one is wrong when they do not. That is what "robust" has to mean here, and it is the capability the current codebase does not yet have.

The second consequence is an ownership matrix. Every domain must have exactly one system of record at every point in time. The moment two systems both believe they own prescriptions, you get double dispensing, duplicated stock movements and an audit trail that cannot be reconciled. Most failed integrations in this sector fail here, not in the protocol layer.

---

## 2. What already exists

This is a stronger starting position than the connector count suggests. The hard conceptual work — a canonical model, an adapter preference ladder, a patient index — is done. What is missing is the runtime that turns those pieces into a service.

| Capability | State today | Evidence |
|---|---|---|
| Canonical clinical model | Present: Person, Encounter, Observation, Specimen, DiagnosticReport, MedicationRequest/Dispense, AllergyIntolerance, Condition, Claim and others | `packages/interop/src/canonical.ts` |
| Integration preference ladder (API → FHIR → HL7v2 → middleware → read-only DB) | Present and enforced in code | `packages/interop/src/adapter.ts:3-11,32-36` |
| FHIR R4 read API | Present, including CapabilityStatement; **read-only, POST returns 405** | `apps/web/src/app/fhir/[resource]/route.ts:11-20` |
| FHIR write | Not implemented | same file |
| DHIS2 aggregate export | Present: rollup, privacy policy, org-unit and data-element mappings, job queue with retries, cron | `packages/interop/src/dhis2/*`, `packages/db/src/dhis2-export.ts`, `migrations 2026*` |
| OpenMRS / UgandaEMR patient extraction | Present, minimal (patient only) | `packages/interop/src/adapter.ts:46-72` |
| HL7 v2 parsing | Partial: PID-3 identifier only | `packages/interop/src/adapter.ts:74-83` |
| ASTM parsing | Partial: R-record result only | `packages/interop/src/adapter.ts:85-95` |
| Lab Edge gateway | Scaffold, v0.2.0: durable SQLite queue, MLLP framing, TCP server/client, file watch and quarantine, driver SDK | `apps/lab-edge/src/index.ts:1-12` |
| Lab ingest | Present and well designed: immutable raw message, staging only, human verification before release | `apps/web/src/app/api/lab/instrument-ingest/route.ts` |
| Patient identity / MPI | Present: scored matching (auto-link 100, review 50), crosswalk, alias handling, unsafe-merge rejection | `packages/db/src/mpi.ts`, `identity-crosswalk.ts` |
| Tally | **File staging only**: CSV/JSON discovery; `.xml` is rejected by the adapter factory | `packages/db/src/tally-migration.ts:1-70` |
| ALIS | **Nothing.** The landing page claims alignment with ALIS; no connector exists | `apps/web/src/app/page.tsx:277` |
| Double-entry accounting | Present: chart of accounts, periods, journal entries and lines, posting functions for sale, purchase, credit repayment, supplier payment, reversal, bank statement import and matching | `supabase/migrations/20261022160000_pharmacy_accounting_ledger.sql` |
| Connection registry | Table `synapse_adapters` exists with status and counters; **zero code references** | `canonical_public_schema.sql` |
| Domain event outbox | Events are written; **no generic relay or consumer worker exists** | `packages/db/src/exchange.ts`, `synapse_domain_events` |
| Machine-to-machine auth | Only the lab bridge key. FHIR requires a browser session cookie. No OAuth2 client credentials, no scoped API keys | `apps/web/src/app/fhir/_lib/serve.ts:24-25` |
| Reconciliation | Nothing cross-system. Bank-statement matching only | — |

Read that table as a build plan, not a criticism. The DHIS2 path is roughly 70 percent finished. The identity layer is roughly 60 percent finished and is the asset most competitors lack. Tally and ALIS are greenfield but sit on top of a double-entry ledger that already produces exactly the objects Tally wants.

---

## 3. Target architecture

```
   FACILITY NETWORK                        SYNAPSE CLOUD

   UgandaEMR/OpenMRS ──FHIR/REST──┐
                                  │
   ALIS (LIS) ──HL7 v2 MLLP───────┤      ┌────────────────────────────────┐
                or REST/SFTP      ├─────▶│      Interop Control Plane     │
                                  │      │  connections · credentials     │
   DHIS2 ──────HTTPS API──────────┤      │  mappings · schedules          │
                                  │      └───────────────┬────────────────┘
   ┌──────────────────────┐       │                      │
   │  Tally Edge Agent    │──XML──┘                      ▼
   │  (LAN, port 9000)    │              ┌────────────────────────────────┐
   └──────────────────────┘              │        Message Bus             │
                                         │  queue · retry · DLQ · replay  │
   ┌──────────────────────┐              └───────────────┬────────────────┘
   │   Lab Edge Agent     │─────HTTPS──────────────────▶ │
   │  (analyzers, serial) │                              ▼
   └──────────────────────┘              ┌────────────────────────────────┐
                                         │      Synapse Clinical Core     │
                                         │  MPI · encounters · orders     │
                                         │  results · ledger · audit      │
                                         └───────────────┬────────────────┘
                                                         ▼
                                         ┌────────────────────────────────┐
                                         │   Reconciliation & Evidence    │
                                         │  daily variance · sign-off     │
                                         └────────────────────────────────┘
```

Seven components, in dependency order.

### 3.1 Connection registry

One row per tenant, per external system, per environment. Extend the existing `synapse_adapters` table rather than inventing a new one — it already has `system`, `mode`, `status`, `last_success_at`, `last_failure_at`, `messages_today`, `failed_today`. Add: `direction`, `config jsonb`, `credential_ref`, `schedule`, `owner_team`, `contract_ref`, `enabled`, `version_pinned`.

The registry is the control plane. Nothing connects that is not registered, and every message carries the connection id so that operational questions ("which connection is lagging?") have a one-query answer.

### 3.2 Credential handling

Credentials never live in the registry row. Store a reference to Supabase Vault (or an external KMS), with rotation metadata. Every credential must be revocable per tenant without redeploying. This is also where you close the machine-to-machine authentication gap: external systems need scoped, rotatable credentials that are not browser cookies.

Three credential classes are enough: OAuth2 client credentials (for systems that support it), a signed API key with scopes (for systems that do not), and a bridge key bound to a specific device or agent (already implemented for lab ingest — reuse that pattern for Tally).

### 3.3 Mapping layer

Mappings are data, not code. Each connection carries: identifier namespaces, code crosswalks, unit conversions, and value-set translations.

| Domain | Source code | Target | Notes |
|---|---|---|---|
| Patient identity | `person_identifiers` namespaces | UgandaEMR UUID, facility MRN, NIN, ALIS patient id | MPI already scores matches; require human review for first 90 days |
| Lab tests | internal catalog | LOINC, ALIS test code | `lab_device_test_mappings` already maps analyzer codes; extend to LIS codes |
| Drugs | internal product | Tally stock item, UgandaEMR concept | exact name matching is unsafe; require explicit map |
| Encounters | internal `encounter_type` | UgandaEMR encounter type, DHIS2 data set | |
| Accounts | `pharmacy_accounting_accounts.code` | Tally ledger name | one-time per facility, versioned |
| Geography | facility, district | DHIS2 org unit | hierarchy, not a flat list |

Every mapping change is versioned and auditable. A mapping is a clinical artefact: changing what "HbA1c" means in the outbound feed changes what a clinician sees elsewhere. Treat it with the same change control as a drug formulary.

### 3.4 Message bus

The piece that does not exist today. Requirements:

**Durable.** Written before the network call, not after. The outbox pattern is already modelled in `packages/db/src/exchange.ts`; it needs to be persisted and relayed.

**Idempotent.** Every message carries a stable key derived from `(connection, domain, aggregate, version)`. Reuse `sync_idempotency_keys`. The receiving system may see the same message twice; the effect must be applied once.

**Ordered per aggregate.** Per-patient and per-encounter ordering, with a sequence number. Never rely on arrival order across patients — that is a throughput trap.

**Leased and retried.** Workers claim jobs with a lease, so a crashed worker does not strand a message. Exponential backoff with jitter, a maximum attempt count, then dead-letter. The DHIS2 job queue already implements this shape; generalise it.

**Replayable.** Any message can be re-driven from the store after a mapping fix. This is not a luxury: in every real integration, the first month is spent replaying messages after discovering that the mapping was wrong.

**Observable.** Per-connection lag, throughput, error rate, DLQ depth, oldest unprocessed message. Surface it in the admin UI next to the connection.

### 3.5 Reconciliation engine

This is the component that makes coexistence sellable, and it is absent today. For each domain, produce a daily variance report:

| Domain | Synapse | Counterpart | Comparison key | Tolerance |
|---|---|---|---|---|
| Patients registered | count by day | UgandaEMR | `person_identifiers` | 0 unexplained |
| Encounters | count by day and type | UgandaEMR | encounter external id | 0 unexplained |
| Lab orders | count by day | ALIS | accession number | 0 unexplained |
| Lab results released | count and value hash | ALIS | accession + test | 0 unexplained |
| Sales | count and gross | Tally | voucher id | 0 amount variance |
| Stock on hand | quantity by product | Tally | stock item + batch | ≤ 0.5% by value |
| Ledger | trial balance | Tally | account code | 0 by period |

"Unexplained" is the operative word. Variance is allowed only when it is itemised, attributed to a known cause (late entry, cancelled order, price change) and signed off. A report that says "99.2% matched" without listing the 0.8% is not evidence; it is reassurance.

### 3.6 Identity crosswalk

You have the scoring logic. What is missing is operational discipline: an explicit namespace per external system, a review queue for matches between 50 and 100, and a rule that no cross-system link is auto-created for a patient with an existing allergy record or an active prescription until a human confirms it. A wrong link in a pharmacy context means dispensing to the wrong person.

### 3.7 Audit and disclosure log

Every outbound disclosure needs a record: which connection, which patient, which data elements, which legal basis, which human or system authorised it, and when. `person_consents` and the audit helpers exist; they need to be wired to the outbound path, and the audit write must be required rather than best-effort for disclosures — the same distinction already drawn in `logHospitalAudit` versus `requireHospitalAudit`.

---

## 4. Per-system connector specification

### 4.1 UgandaEMR / OpenMRS

**Interface, in preference order.** FHIR R4 if the deployment has the FHIR module (OpenMRS 3.x typically does); otherwise OpenMRS REST `/ws/rest/v1`; read-only database access only as a last resort and never for writes. The existing preference ladder already encodes this — enforce it in the registry so nobody can quietly choose the database route.

**What flows.** Patients and encounters inbound; observations and lab results inbound; lab orders and dispense records outbound if Synapse owns those domains. Do not attempt to mirror everything. The realistic scope for a first deployment is: patient demographics, encounter headers, diagnoses, lab orders, lab results.

**Ownership.** In a typical district hospital, UgandaEMR owns the clinical note and Synapse owns pharmacy and lab. Make that explicit in the ownership matrix. If Synapse is also used for OPD, decide per department rather than per facility.

**Identity.** UgandaEMR UUID is the primary external identifier; facility MRN and NIN are secondary. Never use name plus date of birth as a join key, even though the MPI can score it — use it only to propose review candidates.

**Failure behaviour.** If UgandaEMR is down, Synapse must continue to function and queue outbound messages. A clinical system that stops because a secondary system is unavailable is worse than no integration.

### 4.2 DHIS2

**What flows.** Aggregate only. Patient-level data never leaves Synapse for DHIS2. The existing privacy export policy enforces this; keep it non-negotiable and test it.

**Scope.** Monthly HMIS returns (105, 108 and the facility's applicable set), plus the aggregate indicators the facility already reports. The rollup and data-element mapping machinery exists; the gaps are a mapping management interface, org-unit hierarchy sync, period-close handling, and failure alerting.

**Cadence.** Nightly incremental plus an explicit month-end run. Idempotency key is `(orgUnit, period, dataElement, categoryOptionCombo)`.

**Risk.** DHIS2 rejections are usually silent in practice — the payload is accepted and the value is wrong because a data element was mapped to the wrong category. Reconciliation here means comparing submitted totals against Synapse's own aggregate for the same period, and alerting on divergence before submission, not after.

### 4.3 ALIS

This is the least certain connector because the interface is not documented in the repository. Stage 0 must answer three questions before design: what protocol ALIS exposes, who owns the accession number, and whether results can be pushed or must be pulled.

**Interface, in preference order.** HL7 v2.5.1 over MLLP is the most likely and the best fit: `OML^O21` or `ORM^O01` outbound for orders, `ORU^R01` inbound for results, `ACK` in both directions. If ALIS exposes a REST API, use it. If neither, SFTP file drop with a defined filename and directory convention, which is slower but workable and common in public-sector deployments.

**Order flow.** Synapse creates the lab order and allocates the accession number; ALIS echoes it. One system must own accession allocation, and it should be the one that prints the barcode on the specimen. If ALIS insists on allocating, store both identifiers and crosswalk them — do not attempt to rewrite ALIS behaviour during a pilot.

**Result flow.** Result arrives → stored immutably with the raw message → matched to order by accession → staged → verified by a human → released. The existing ingest path already does exactly this and must not be shortcut for ALIS. The temptation to auto-release results from a "trusted" LIS is the single most dangerous shortcut in this project.

**Units and reference ranges.** ALIS will send units; Synapse must not silently convert. Reject and stage on unit mismatch, using the existing `detectUnitMismatch` guard rather than coercing.

**Coexistence implication.** In public facilities, ALIS is likely the system of record for lab results. Plan for Synapse to receive rather than own results there, and to own orders and clinical context.

### 4.4 Tally

Tally is the accounting system of record for most pharmacies in the region, and it will remain so. The correct posture is to feed it, not fight it.

**Interface.** Tally Prime and ERP 9 accept XML over HTTP on a local port (typically 9000), XML file exchange, or ODBC. The HTTP interface is LAN-only in practice, which means the connector cannot live in the cloud — it must run as an edge agent in the pharmacy, exactly like Lab Edge. Reuse that deployment model: a small service on a LAN machine, outbound-only HTTPS to Synapse, durable local queue.

**What flows out.** Sales vouchers, purchase vouchers, journal vouchers, receipts, payments and credit notes. The source is already ideal: `pharmacy_accounting_journal_entries` and `pharmacy_accounting_journal_lines` are balanced, immutable and posted by dedicated functions. Map journal lines to Tally ledger names once per facility, then send vouchers with a deterministic GUID so Tally rejects duplicates.

**What flows in.** Ledger masters, stock item masters, opening balances, and bank statements. Bank statement import already exists on the Synapse side; the missing piece is the Tally-side export convention.

**What must not flow.** Do not let Tally edit clinical or inventory truth directly. Stock adjustments originating in Tally should arrive as a proposed adjustment that a pharmacist approves, not as a silent overwrite.

**Reconciliation.** Trial balance per period, and stock valuation weekly. If the pharmacy also runs a POS that posts to Tally, pick one source of truth for sales and make the other read-only — double-posting to Tally is the most common way these projects break a customer's books.

### 4.5 Other pharmacy and HMIS systems

Do not build bespoke connectors. Build a generic tabular adapter on top of the existing `import_column_mappings` and `pharmacy_import_sessions` tables: upload, discover columns, propose a mapping, require human confirmation, stage, then commit. That covers the long tail — the small POS packages, the Excel-run inventory, the lab that emails a CSV — without a new codebase per vendor.

---

## 5. Transition playbook

The playbook is the product. A facility will judge you on whether the transition felt controlled, not on whether the protocol was elegant.

### Stage 0 — Interface discovery (1 week per system)

Produce a one-page interface sheet per system: vendor and version, protocol, authentication, endpoints, data owner, maintenance windows, escalation contact, and whether the vendor charges for API access. Do not design before this is signed off by the facility's IT owner. Half of integration overruns are caused by discovering in week six that the "API" is a read-only report.

**Exit:** interface sheet signed by facility IT and, where relevant, the vendor.

### Stage 1 — Ownership matrix (3 days)

For each domain — patient identity, registration, clinical notes, orders, results, dispensing, inventory, accounting, statutory reporting — name exactly one system of record, one system of entry, and any read-only consumers. This document prevents the argument that otherwise happens in month three.

**Exit:** matrix signed by the facility's clinical lead and finance lead, not just IT.

### Stage 2 — Crosswalk and mapping (1–2 weeks)

Build the identifier namespaces and code maps against real sample data, not a specification. Load 200 real records and measure match rates. Every unmapped code is either mapped or explicitly excluded with a reason.

**Exit:** ≥ 99 percent of sampled patients and encounters matched or explicitly excluded; every clinical code mapped or rejected with a documented reason.

### Stage 3 — Shadow read (2 weeks)

Import from the legacy system read-only. Write nothing back. The facility keeps working exactly as before. You are measuring mapping accuracy under real conditions.

**Exit:** two consecutive weeks where the reconciliation report shows no unexplained variance in patients and encounters. Clinical users spot-check a sample and confirm the imported record matches what they see in the legacy system.

### Stage 4 — Dual-write with daily reconciliation (2–4 weeks)

Synapse becomes the system of entry for the domains it owns and pushes to the counterpart. Both systems hold the same facts. A daily variance report goes to a named person at the facility, not just to your team.

**Exit:** 14 consecutive days under tolerance, with zero unexplained clinical-category variance, and the facility's own staff able to read and act on the report unaided.

### Stage 5 — Departmental cutover

Cut over one department at a time, and never two in the same week. Lab first or pharmacy first — whichever the facility trusts more. Each cutover has a freeze window agreed in advance, a named owner on both sides, a rollback trigger defined as a number rather than a feeling, and a post-cutover review 72 hours later.

**Exit:** one full business cycle (including a month-end where finance is involved) with the legacy system read-only for that department and no workaround spreadsheets in use.

### Stage 6 — Freeze and archive

Legacy system set to read-only, full extract archived with a hash manifest, audit trail sealed. Retention period agreed in writing, consistent with the Uganda Data Protection and Privacy Act 2019 and the facility's own records policy.

### Stage 7 — Decommission

Contract notice, credential revocation, certificate of destruction where required, and removal of the connector from the registry. A connector that stays registered after decommission is a live credential nobody is watching.

### Rollback

Rollback must be possible at every stage without data loss. Stage 3 rolls back by deleting imported data. Stage 4 rolls back by stopping the outbound feed and reconciling the tail. Stage 5 rolls back by re-enabling the legacy write path within the freeze window and replaying the day's messages. Keep dual-write running for 30 days after cutover precisely so that Stage 5 rollback remains available.

The failure mode to design against is not "the connector is down". It is "the connector was silently wrong for three weeks and nobody noticed". That is why reconciliation is a stage gate and not a dashboard.

---

## 6. What "robust" must mean in engineering terms

| Property | Requirement | Current state |
|---|---|---|
| Idempotency | Every message has a stable key; effects are applied once | Partial (`sync_idempotency_keys`, sale RPC) |
| Ordering | Per-patient and per-encounter sequence, independent of arrival | Absent |
| At-least-once delivery | Durable outbox written before send | Modelled, not persisted |
| Exactly-once effect | Upsert or guarded insert at the receiver | Partial |
| Conflict policy | Field-level merge plus review queue for clinical data; never last-write-wins | Absent — sync writes `revision: 0` |
| Backpressure | Per-partner rate limits and queue depth limits | Absent |
| Circuit breaking | Stop calling a failing system; surface state | Absent |
| Poison handling | Quarantine, alert, replay after fix | Partial (lab quarantine exists) |
| Offline tolerance | Edge agents buffer and resume | Present in Lab Edge |
| Time handling | Store UTC, render Africa/Kampala, tolerate skew | Present |
| Partial batch failure | Per-row outcome, resumable | Present in `import_batches` |
| Replay | Re-drive any message after a mapping fix | Absent |

The conflict policy deserves emphasis. Last-write-wins is acceptable for a stock count and unacceptable for a prescription. The existing hospital sync writes `revision: 0` and ignores `baseRevision`, which means concurrent clinical edits are silently lost today — before any external system is connected. Interoperability multiplies that risk by the number of systems in the room.

---

## 7. Security and compliance for integrations

Machine-to-machine authentication is the largest gap. The FHIR API requires a browser session (`apps/web/src/app/fhir/_lib/serve.ts:23-25`), so no external system can call it without impersonating a user. Lab ingest is the only surface with a service credential, and it is a good model: hashed at rest, bound to a device, rotatable.

Minimum bar before connecting any external system:

Scoped credentials per connection, hashed at rest, rotatable without downtime, and revocable per tenant. Tenant isolation enforced on every message path — which requires fixing the ten malformed RLS policies and the import routes identified in the 24 October audit first, because external connectors will write through exactly those paths. Consent checked on outbound disclosure, not just recorded. Field-level minimisation per connector: DHIS2 gets aggregates, Tally gets financial data with no patient identifiers, ALIS gets the clinical minimum needed to run a test. Every disclosure logged with legal basis, and the log write required rather than best-effort. Payload logging limited to hashes and metadata; raw PHI payloads belong in the immutable message store with its own retention rule, not in application logs.

---

## 8. 90-day build plan

Sequenced so that each step produces something demonstrable and nothing depends on a vendor response arriving on time.

| Weeks | Work | Why this order |
|---|---|---|
| 1–2 | Fix import-route security and the ten RLS policies; add machine-to-machine credential primitive; publish interface sheets | Connectors write through these paths; they must be safe first |
| 2–4 | Connection registry on top of `synapse_adapters`; credential vault; generic message store and relay with retry, DLQ and replay | Everything else plugs into this |
| 3–5 | Reconciliation engine and report template for patients, orders and ledger | Needed for Stage 3/4 of any pilot; also the sales demo |
| 4–7 | Tally edge connector: journal entries → vouchers, masters inbound | Easiest to prove, highest perceived value, no clinical risk |
| 5–8 | ALIS connector: start with whichever interface Stage 0 confirms; order out, result in, staged and verified | Lab is where the facility feels the transition most |
| 6–9 | UgandaEMR FHIR read plus Observation write-back | Clinical continuity story |
| 8–10 | DHIS2 mapping management and month-end close | Turns an existing 70 percent into a sellable capability |
| 10–12 | Dual-run pilot at one facility with daily sign-off | Proves the playbook, not just the software |

Two engineers for twelve weeks delivers the runtime, Tally and one lab path. Each additional partner engagement needs an integration engineer on site for Stage 0 and Stage 5; that is a delivery cost, not an engineering one, and should be priced accordingly.

---

## 9. Metrics

Track these from the first pilot, because they are also the sales evidence.

Message success rate per connection (target > 99.5 percent excluding counterpart downtime). p95 end-to-end latency for order-to-result and sale-to-voucher. DLQ depth and oldest message age (target zero at daily close). Reconciliation variance per domain per day, with the count of unexplained items explicitly separated from explained ones. Percentage of patients auto-matched versus human-reviewed. Time to onboard a new facility end to end. Time to add a new connector of an existing type. Number of workaround spreadsheets in use at the facility — the honest measure of whether the transition actually happened.

---

## 10. What not to do

Do not build a connector per customer. The long tail is a tabular adapter with saved mappings, and it should stay that way.

Do not sync writes by database replication. Read-only replicas are acceptable as a last-resort inbound source; writes through a replica will corrupt invariants you cannot see.

Do not let two systems own the same field. Pick one, and make the other read-only for that field.

Do not auto-release results from any LIS, however trusted. Staging and human verification is the control that makes the lab integration defensible.

Do not put Tally in the cloud path. It lives on a LAN; the agent goes to it.

Do not use an LLM to map clinical codes without human approval. Proposing a mapping is fine; applying one silently is not.

Do not promise "full interoperability". Promise specific flows with named systems, proved by a reconciliation report. That is what a procurement committee can actually evaluate, and it is what you can actually deliver.

---

## Appendix — Open questions to resolve before build

Does ALIS expose HL7 v2, REST, or only file exchange, and who allocates accession numbers? Does the UgandaEMR deployment have the FHIR module, and which version? Does the facility's Tally licence permit HTTP/XML access, or is it file-export only? Which system is the facility's accounting system of record if they run both Tally and a POS that posts to it? Is DHIS2 reporting done by the facility or by the district on its behalf? What is the facility's retention obligation for legacy records after decommission?

Each answer changes a connector's design. None of them should be guessed.

---

*Prepared from source inspection on 24 October 2026. No files were modified. Vendor interface details for ALIS and Tally are assumptions pending Stage 0 confirmation.*
