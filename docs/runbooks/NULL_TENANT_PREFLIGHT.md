# NULL-Tenant Preflight — Runbook

**Status:** BLOCKED (no authorised read-only target supplied).

`scripts/db-tests/nulls-preflight.sql` answers the one question an empty disposable
database cannot: whether tightening the `tenant_isolation` predicate will hide
existing rows, and whether a backfill is required before the repair
(`20261025120000_tenant_isolation_policy_repair.sql`) is applied to any real
environment.

## The exact command

Run from the repository root, with a read-only connection supplied **only** via
environment variables in the operator's own shell (never written to a file, log,
or transcript):

```
psql -X -v ON_ERROR_STOP=1 -f scripts/db-tests/nulls-preflight.sql
```

with `PGHOST`, `PGPORT`, `PGUSER`, `PGDATABASE`, `PGPASSWORD` exported in that
shell, pointed at a **replica, staging database, or restored copy — never the
production primary**.

## What each column means

The script emits two result sets:

1. **Per-table NULL-tenant counts** — one row per table for the ten repaired
   tables (`encounter_orders`, `encounters`, `gas_cylinders`,
   `hospital_drug_orders`, `order_items`, `products`, `sync_conflicts`,
   `telemedicine_intake_cases`, `telemedicine_intake_messages`, `vitals`):
   - `t` — the table name.
   - `null_tenant` — rows where `tenant_id IS NULL`.
   - `total` — all rows.

2. **Orphaned tenancy** — for `products`, `order_items`, `encounters`, `vitals`,
   `telemedicine_intake_cases`, `telemedicine_intake_messages`: rows whose
   `tenant_id` is non-NULL but has no matching `tenants` row.

## The decision rule

- **Any non-zero `null_tenant` on a table the application writes today blocks the
  repair for that table** until ownership is decided: once the predicate becomes
  `tenant_id = public.current_tenant_id()`, a NULL-tenant row is invisible to
  every authenticated reader (and a service-role writer with no JWT leaves
  `tenant_id` NULL through `auto_set_tenant_id()`).
- **Any non-zero orphaned tenancy** indicates a data-integrity problem that must
  be resolved by the data owner before the repair, because the predicate treats
  an orphaned `tenant_id` as simply "not mine".
- A zero result across both sets means the repair can proceed without a backfill.

## Who must sign off

- **Data/database owner** — confirms the target is a replica/restored copy, not
  the production primary, and confirms the counts.
- **Product/clinical owner** — decides the ownership source for any NULL-tenant
  rows (the D3 / O3 decision): backfill from `user_id` / `patient_id` /
  `hospital_id`, or leave them and accept they disappear from tenant-scoped reads.

## Hard rules

- Never run this against the production primary.
- Never run it with credentials stored in a file or pasted into chat.
- Do not treat a zero-row disposable database as an answer to this question — it
  has no data and proves nothing about existing rows.
