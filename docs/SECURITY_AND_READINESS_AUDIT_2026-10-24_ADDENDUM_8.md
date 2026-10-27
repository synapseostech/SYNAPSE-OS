# Audit Addendum 8 — 2026-10-24 (Driver installed; isolated harness prepared; release diff reviewed)

Supplements the main report and Addenda 1–7. No production connections or writes, no migrations/ACL changes, no secrets exposed, nothing staged/committed/pushed/deployed.

## 1. State (Phase 1)

- Branch `integration/synapse-2026-10-09`, HEAD `c9e53e37fc2c6a22c1699e4d331b1a05e5ff659f`.
- All pre-existing modifications and untracked files preserved (`.freebuff/`, `.mcp.json`, user-modified `release.yml`, etc.).

## 2. Driver installation (Phase 2 — approved and executed)

- Command: `npm install pg@8.23.1 --save-dev --no-audit --no-fund --ignore-scripts` → **EXIT 0**.
- `package.json`: added `"pg": "^8.23.1"` to `devDependencies` (plus the earlier `test:db-acl:strict` script).
- `package-lock.json`: +161 insertions — only the `pg` dependency subtree (`node_modules/pg`, `pg-cloudflare`, `pg-connection-string`, `pg-pool`, `pg-protocol`, `pg-types`, `postgres-array`, etc.). No unrelated dependency changes.
- Verified `import("pg")` resolves (`Client` is a function).

## 3. Unit tests (Phase 2)

| Command | Exit | Result |
|---|---|---|
| `node --check scripts/check-db-acl.mjs` + `.test.mjs` | 0 | syntax OK |
| `node --test scripts/check-db-acl.test.mjs` | 0 | **20/20 passed** |

Updated test: `runLiveCheckFromUrl` now (with `pg` present) attempts a loopback connection to `127.0.0.1:1`, fails closed on `ECONNREFUSED`, and asserts the password and full URL are **not** in the error message. Tracked artifact `artifacts/readiness/db-acl-inventory.json` unchanged.

## 4. Isolated integration testing (Phase 3)

**Not executed — no PostgreSQL server is available.** Verified: `postgres`, `initdb`, `pg_ctl`, `pg_isready`, `psql`, `docker`, and `podman` are all absent, and no local listener exists on 5432. Only the `pg` client driver is now installed.

Prepared: `scripts/check-db-acl.integration.test.mjs` — an opt-in harness that:
- Skips unless `ACL_INTEGRATION_URL` is set to a disposable database (`node --test` → 1 skipped, EXIT 0).
- Exercises the **real** `runLiveCheckFromUrl` path against synthetic roles/functions, covering: safe service-role-only; explicit and implicit `PUBLIC EXECUTE`; `anon` and `authenticated` grants; missing required overload; unsafe owner; unsafe `search_path`.

It has been syntax-checked but **not executed** against a database, and is therefore **not reported as passing**.

## 5. Release workflow review (Phase 4 — review only, NOT applied)

Current working-tree `.github/workflows/release.yml`: single `release` job (`runs-on: ubuntu-latest`, line 30), **no** `environment:` block, **no** `secrets.*` reference, `Schema compatibility comparison` at line 102, `Vercel deployment smoke check` at line 105.

**Proposed diff (preserves all existing user changes; not applied):**

```yaml
  release:
    runs-on: ubuntu-latest
+   environment: production
    env:
      # ...existing env...
    steps:
      # ...existing steps...
      - name: Schema compatibility comparison
        run: npm run db:check
+
+     - name: Strict live database ACL verification
+       env:
+         DATABASE_ACL_URL: ${{ secrets.DATABASE_ACL_URL }}
+       run: npm run test:db-acl:strict

      - name: Vercel deployment smoke check
```

Prerequisites: protected secret `DATABASE_ACL_URL` (PostgreSQL connection string) in the `production` environment; the strict step runs **before** the Vercel smoke/deployment actions; failure exits nonzero and aborts the job.

## 6. Files changed this task

- `package.json` — `pg` devDependency (+ earlier `test:db-acl:strict`).
- `package-lock.json` — pg subtree (+161).
- `scripts/check-db-acl.test.mjs` — URL test updated for installed driver (20 tests).
- `scripts/check-db-acl.integration.test.mjs` — new opt-in harness.
- `docs/SECURITY_AND_READINESS_AUDIT_2026-10-24_ADDENDUM_8.md` — this file.

Pre-existing modifications and untracked files preserved. Nothing staged, committed, pushed, or deployed.

## 7. Readiness

**Production remains NOT READY.** The driver is installed and the fail-closed live path is unit-tested, but the live query has not executed against any real database (no isolated server available), the release gate is not applied, and production evidence is outstanding. Remaining approvals: (1) run the opt-in harness against an approved isolated PostgreSQL, (2) create the protected `DATABASE_ACL_URL` secret and apply the `release.yml` diff, (3) return the production read-only SQL outputs.
