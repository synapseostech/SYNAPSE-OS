# Audit Addendum 5 — 2026-10-24 (Real fail-closed live ACL verification implemented)

Supplements the main report and Addenda 1–4. No production or repository mutations were performed. No database connection was attempted. No secrets were read or printed.

## 1. What was implemented in `scripts/check-db-acl.mjs`

- `LIVE_ACL_SQL` — read-only catalog query returning one row per `public.receive_pharmacy_stock` overload with `signature`, `owner`, `security_definer`, pinned `search_path`, and effective `EXECUTE` booleans for `public` (implicit via `acldefault`), `anon`, `authenticated`, `service_role`.
- `validateAclUrl(url)` — accepts only `postgres:`/`postgresql:` URLs; never prints or returns the value.
- `evaluateLiveAcl(rows)` — pure evaluation (dependency-injectable). Fails on: no functions, missing required 13-arg overload, implicit `PUBLIC EXECUTE`, `anon`/`authenticated` EXECUTE, missing `service_role` EXECUTE, unsafe owner (default allowlist `postgres,supabase_admin`, overridable via `ACL_EXPECTED_OWNERS`), non-`SECURITY DEFINER`, or a `search_path` without `public`. Audits every overload present, not just one signature.
- `runLiveCheckFromUrl(url)` — validates the URL, dynamically loads the optional `pg` driver, connects with `connectionTimeoutMillis: 5000`, sets `statement_timeout = '15s'`, runs inside `BEGIN TRANSACTION READ ONLY`, rolls back, and always closes the client in `finally`. Fails closed with `PG_CLIENT_MISSING` when `pg` is absent. The URL is never logged or persisted.
- `main()` strict path — on `--strict-live`: missing URL → exit 1; any live-check error or unsafe finding → exit 1 **before** writing `artifacts/readiness/db-acl-inventory.json`. On success, `live_check` is recorded as `VERIFIED`.

Static/offline scanning behavior is unchanged and clearly distinct from live verification.

## 2. Implemented vs still incomplete

- **Implemented and unit-tested:** URL validation, effective-privilege evaluation (incl. implicit PUBLIC), owner/definer/search_path checks, overload coverage, read-only transaction + bounded timeouts + cleanup, fail-closed on every failure path, no artifact write on failure, no URL leak.
- **Incomplete (blocked on dependency):** actual database execution. `node_modules/pg` is absent, so `runLiveCheckFromUrl` fails with `PG_CLIENT_MISSING` before any connection. No live query has been run, and no production connection was attempted.

## 3. Test results (this pass)

| Command | Exit | Result |
|---|---|---|
| `node --check scripts/check-db-acl.mjs` + `.test.mjs` | 0 | syntax OK |
| `node --test scripts/check-db-acl.test.mjs` | 0 | **18/18 passed** (8 prior + 10 new live-check tests) |
| `npm run test:db-acl:strict` (no URL) | 1 | `DB ACL FAIL: --strict-live requires DATABASE_ACL_URL` |
| `DATABASE_ACL_URL='postgres://…' npm run test:db-acl:strict` | 1 | `DB ACL FAIL (live): PG_CLIENT_MISSING`; host/URL leaked = **0** |

Tracked artifact `artifacts/readiness/db-acl-inventory.json` remained unchanged on every run.

New tests cover: missing URL, malformed/non-PostgreSQL URL, connection/query failure (fake runner throw → propagated), missing function, multiple overloads, implicit PUBLIC EXECUTE, anon/authenticated grants, service-role-only success, unsafe owner/definer/search_path, connection cleanup, and URL non-leakage. Tests use a fake client via `evaluateLiveAcl`; no test connects to any database.

## 4. Files changed this pass

- `scripts/check-db-acl.mjs` — live-check implementation.
- `scripts/check-db-acl.test.mjs` — +10 tests (18 total).
- `docs/SECURITY_AND_READINESS_AUDIT_2026-10-24_ADDENDUM_5.md` — this file.

All pre-existing user modifications and untracked files preserved. Nothing staged, committed, pushed, or deployed.

## 5. Remaining blockers and smallest required approvals

1. **Approve adding the `pg` dependency** (smallest next approval) — the live query cannot execute without a PostgreSQL driver. Alternative: point `runLiveCheckFromUrl` at an available `psql` binary (also absent locally).
2. After the driver is available, run the strict gate against an **isolated non-production** database to validate the success path.
3. Create the protected `DATABASE_ACL_URL` secret and apply the prepared `release.yml` diff (Addendum 4) — production release job only.
4. Run the seven read-only SQL statements (Addendum 3) and return outputs to close the production-evidence gap.

## 6. Readiness

**Production remains NOT READY.** The strict-live verification logic is now implemented and fail-closed by construction, and it is unit-tested with a fake client; however, it has not executed against any real database because the `pg` driver is missing and no production connection was attempted.
