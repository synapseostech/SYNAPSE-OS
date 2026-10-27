# Audit Addendum 7 — 2026-10-24 (Driver dependency proposal & privilege-model review)

Supplements the main report and Addenda 1–6. No production or repository mutations. No dependency was installed, no lockfile was changed, and no network access occurred. No database connection was attempted.

## 1. Current state

- Branch `integration/synapse-2026-10-09`, HEAD `c9e53e37fc2c6a22c1699e4d331b1a05e5ff659f`.
- All pre-existing modifications and untracked files preserved.
- `pg` is **not** present in `package-lock.json` (neither direct nor transitive).

## 2. Proposed dependency change (prepared, NOT applied)

- Cached locally: `pg@8.23.1` tarball is present in the npm cache (`.../pg/-/pg-8.23.1.tgz`).
- Compatibility: project `engines.node` is `22.x`; `pg` 8.x supports Node ≥ 8 — compatible.

**package.json diff (for review only):**

```jsonc
// devDependencies
+ "pg": "^8.23.1"
```

**Lockfile:** updating `package-lock.json` requires `npm install` (e.g., `npm install pg@8.23.1 --save-dev`), which mutates the lockfile and may hit the registry for metadata. That action is **not performed** and requires explicit approval.

## 3. Privilege-model review (live ACL query)

- `has_function_privilege('public', t.oid, 'EXECUTE')` correctly captures implicit `PUBLIC EXECUTE`: when `proacl IS NULL`, PostgreSQL applies `acldefault('f', owner)`, which grants `EXECUTE` to `PUBLIC`, and `has_function_privilege` reports it.
- `has_function_privilege('anon'|'authenticated'|'service_role', t.oid, 'EXECUTE')` uses role **names**, not OIDs, and accounts for `PUBLIC` inheritance (all roles are members of `PUBLIC`) and role membership via the ACL-mask `ANY` evaluation. A grant to `authenticated` does not make `anon_execute` true because `anon` is not a member of `authenticated`.
- Overlap note: when `PUBLIC` holds `EXECUTE`, both `PUBLIC_EXECUTE` and `ANON_EXECUTE`/`AUTHENTICATED_EXECUTE` errors can appear together. This is intentional — all are unsafe signals; it is not a privilege-model defect.
- `search_path` is evaluated against the function's actual `proconfig` (extracted value, exact `public` required). A missing or unsafe `search_path` fails.
- The evaluator fails on any omitted privilege column (`INCOMPLETE_ACL_ROW`), so a safe result cannot pass because a catalog field was absent.

## 4. Tests (this pass)

| Command | Exit | Result |
|---|---|---|
| `node --check scripts/check-db-acl.mjs` + `.test.mjs` | 0 | syntax OK |
| `node --test scripts/check-db-acl.test.mjs` | 0 | **20/20 passed** |

New test this pass: `LIVE_ACL_SQL` contract (role-name literals, not OIDs; covers `public`/`anon`/`authenticated`/`service_role`, `prosecdef`, `search_path`; no manual `acldefault` call).

Tracked artifact `artifacts/readiness/db-acl-inventory.json` unchanged.

## 5. Isolated integration verification — did NOT run

No approved non-production PostgreSQL instance, `psql`, or Docker is available, and `pg` is not installed. The strict-live path has therefore not executed its catalog query against any real database. A reproducible isolated test matrix is documented in Addendum 6. No production connection was attempted as a substitute.

## 6. Files changed this pass

- `scripts/check-db-acl.test.mjs` — added SQL-contract test (20 total).
- `docs/SECURITY_AND_READINESS_AUDIT_2026-10-24_ADDENDUM_7.md` — this file.

## 7. Remaining uncertainties

- Exact production `receive_pharmacy_stock` owner/ACL/search_path (unverified).
- Whether production contains one or both overloads (expected 13-arg only, unverified).
- Whether `pg@8.23.1` lockfile regeneration will pull additional metadata from the registry (requires a network-capable, approved install).

## 8. Smallest approval required

Approve `npm install pg@8.23.1 --save-dev` (driver from cache; regenerates the lockfile). After that: run the strict gate against a disposable non-production database, then create the protected `DATABASE_ACL_URL` secret and apply the prepared `release.yml` diff.

## 9. Readiness

**Production remains NOT READY.** Live-verification logic is implemented, privilege-model-reviewed, and covered by 20 unit tests, but it has not run against any real database and the release gate is not wired.
