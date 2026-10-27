# DB Verification — 2026-10-25

## Repository state at start
- Branch: `integration/synapse-2026-10-09`
- HEAD: `c9e53e37fc2c6a22c1699e4d331b1a05e5ff659f`
- Porcelain: `67`

## Tool versions
- Docker: `29.1.3` (server `29.1.3`)
- psql: `16.15 (Ubuntu 16.15-0ubuntu0.24.04.1)`
- pg_isready: `16.15`
- OpenSSL: `3.0.13`

## postgres:16-alpine image
- Digest: `postgres@sha256:f4610795587492cd4fb887c2dc3de301b813278bb6f616992061141b5f15ac36`
- Id: `sha256:f4610795587492cd4fb887c2dc3de301b813278bb6f616992061141b5f15ac36`

## Proof run
Command: `SYNAPSE_ALLOW_IMAGE_PULL=1 bash scripts/db-tests/run-rls-isolation.sh` (executed via `sg docker -c '…'`; output tee'd to `/tmp/rls-proof.log`).

- Exit code: **1**
- Outcome: **FAILED** — the assertion harness failed on a disposable PostgreSQL 16 container. Tenant isolation was **not** proven.

First error (step 5b, harness line 408):
```
psql:scripts/db-tests/rls-tenant-isolation.sql:408: ERROR: reproduction failed:
anon saw 2 rows in encounter_orders before the repair (expected a clean zero-row denial)
CONTEXT: PL/pgSQL function inline_code_block line 14 at RAISE
FAILED: the tenant-isolation assertions failed. Output above; nothing was proven.
```

Root cause (read from source; not fixed): step 5a sets `request.jwt.claim.sub` to tenant A (`00000000-0000-4000-8000-00000000000a`) via `set_config(..., false)`. Step 5b does `reset role; set role anon; set_config('request.jwt.claim.role','',false)` but never clears `request.jwt.claim.sub`. `auth.uid()` therefore still returns tenant A's UUID during the "anon" block, the broken `tenant_isolation` predicate (`tenant_id = (SELECT encounter_orders.tenant_id FROM profiles WHERE profiles.id = auth.uid())`) reduces to `tenant_id = tenant_id`, and anon sees 2 rows. The step's own comment states "auth.uid() is NULL", which does not match the code. This is a harness defect — it is not evidence about the migration, and it was not edited to pass.

Container cleanup: confirmed — `docker ps -a --filter label=synapse.disposable-test=true` returns no rows.

## NULL-tenant preflight
NOT RUN — awaiting a human-approved read-only target (replica / staging / restored copy, read-only credentials).

## Decisions
- D1: UNANSWERED
- D2: UNANSWERED
- D3: UNANSWERED

## What this proves
Nothing. The proof did not complete; it failed on the pre-repair anonymous-reader assertion (step 5b) because of a harness defect (unreset `request.jwt.claim.sub`). Tenant isolation remains unverified.

## What this does not prove
A green run would only prove the migrations behave as asserted on an empty disposable PostgreSQL 16 database. It would not prove anything about production data, existing migration history, application behaviour, or the held staff-policy change. This run was not green, so none of those are proven.

---

## Proof run — PASSED (appended; the failure above is kept as evidence of the sequence)

- Date: `2026-10-25`
- Host: `ebrine-Latitude-E7450`
- Docker: `29.1.3` (server `29.1.3`)
- psql: `16.15 (Ubuntu 16.15-0ubuntu0.24.04.1)`
- Image digest: `postgres@sha256:f4610795587492cd4fb887c2dc3de301b813278bb6f616992061141b5f15ac36`

Command (executed via `sg docker -c '…'`; output tee'd to `/tmp/rls-proof-passed.log`):
```
SYNAPSE_ALLOW_IMAGE_PULL=1 bash scripts/db-tests/run-rls-isolation.sh
```

- Exit code: **0**
- Final line (verbatim): `RLS tenant-isolation proof PASSED on a disposable database`

Notice list (unique):
- `SEC-01 reproduced: tenant A reads and writes tenant B rows on all ten tables`
- `anon: clean zero-row denial on nine tables, public catalogue readable (2 products) before the repair`
- `tenant_isolation repaired on public.<table>` × 10 (encounter_orders, encounters, gas_cylinders, hospital_drug_orders, order_items, products, sync_conflicts, telemedicine_intake_cases, telemedicine_intake_messages, vitals)
- `tenant isolation repaired and self-checked on all ten tables`
- `RLS tenant isolation PASSED on all ten tables (select/insert/update/delete)`
- `same-tenant read/write still works after the repair`
- `tenant B retains its own rows on all ten tables`
- `no JWT subject: zero rows on the nine, public catalogue still readable (products=2)`
- `profile with NULL tenant_id: zero rows visible`
- `platform_admin_bypass still grants cross-tenant read`
- `anon: clean deny on the nine, public read preserved on products`
- `anon cannot write products`
- `service_role still bypasses RLS`
- `policy metadata: 10 tenant_isolation policies, all scoped to authenticated`
- `admin bypass reproduced: profiles.is_admin reads and writes another tenant order_items`
- `staff-role bypass reproduced: a tenant-A clinician reads another tenant intake case and message`
- `patient intake write is unconstrained: a tenant-B patient created a tenant-A case`
- `re-application is idempotent: 10 tenant_isolation policies, all scoped to authenticated`
- `neighbouring policies untouched (platform_admin_bypass x10, Public read products)`
- `current-source state: anon gets a clean zero-row deny on products (no function-permission error)`
- `admin policy scoped to tenant: public.<table>.<name>` × 5 (products, order_items, gas_cylinders, orders, restaurants)
- `five admin policies scoped to tenant and self-checked`
- `admin policies scoped to tenant: cross-tenant access denied, same-tenant admin access preserved`
- `platform_admin_bypass still grants cross-tenant read after the admin-policy scope`
- `telemedicine intake tenant ownership triggers installed and self-checked`
- `service-role intake insert inherits tenant from the row owner`

### What this passing run proves
On an empty disposable PostgreSQL 16 database built from the harness fixture: the ten `tenant_isolation` repairs constrain SELECT/INSERT/UPDATE/DELETE to the caller's tenant; `20261026130000` closes the `Admins full access` cross-tenant read/write path (step 18); and `20261026120000` makes a service-role intake insert inherit the row owner's tenant (step 19).

### What this passing run does not prove
Nothing about production data, existing migration history, application behaviour, or the held staff-policy change (`supabase/held/scope_staff_intake_policies_to_tenant.sql`). Production remains unverified; `nulls-preflight.sql` has not run against any real database.
