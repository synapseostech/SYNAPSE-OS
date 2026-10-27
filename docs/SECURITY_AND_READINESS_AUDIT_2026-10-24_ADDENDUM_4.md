# Audit Addendum 4 — 2026-10-24 (Release-gate proposal & production-evidence prerequisites)

Supplements the main report and Addenda 1–3. No production or repository mutations were performed. No secrets were read or printed.

## 1. Current state

- Branch: `integration/synapse-2026-10-09`; HEAD `c9e53e37fc2c6a22c1699e4d331b1a05e5ff659f` (ahead 10 / behind 1 of `origin/main`).
- Pre-existing changes preserved: `.github/workflows/release.yml`, `.vscode/mcp.json`, `apps/pharmacy/vitest.config.ts`, 3 clinical-intelligence files, `scripts/release-provenance.mjs` (+test), `scripts/vercel-build-gate.mjs` (modified), `.freebuff/`, `.mcp.json` (untracked).
- This engagement's local changes: `package.json` (+`test:db-acl:strict`), `scripts/check-db-acl.mjs` (hardened), `scripts/check-db-acl.test.mjs` (new, 8 tests), and the audit report + Addenda 1–4.

## 2. Release-gate fix — proposed (NOT applied)

`.github/workflows/release.yml` currently has a single `release` job with no `environment:` block, runs `npm run db:check` but **no ACL check**, and references no `DATABASE_ACL_URL`. The protected secret is **not** configured anywhere.

**Proposed minimal diff (for review; release.yml is left untouched because it has pre-existing user modifications):**

```yaml
jobs:
  release:
    # ...existing job...
    runs-on: ubuntu-latest
+   environment: production
    env:
      # ...existing env...
    steps:
      # ...existing steps...
      - name: Schema compatibility comparison
        run: npm run db:check

+     - name: Strict live database ACL verification
+       env:
+         DATABASE_ACL_URL: ${{ secrets.DATABASE_ACL_URL }}
+       run: npm run test:db-acl:strict
```

**Prerequisites (must be satisfied before this diff is valid — do not weaken the check):**

1. A protected secret `DATABASE_ACL_URL` (PostgreSQL connection string) must exist in the `production` environment. It must never be echoed, logged, or committed.
2. **The scanner's live path is not implemented.** `--strict-live` only fails when the URL is absent and otherwise reports `live_check: PENDING_OPERATOR`; it does not connect to the database. Wiring the workflow alone would therefore fail when the URL is missing but still never actually verify ACLs. The live path must execute the read-only SQL in section 5 and fail on any `PUBLIC`/`anon`/`authenticated` EXECUTE.
3. A PostgreSQL driver (`pg`) or `psql` is required for that live path. `node_modules/pg` is **absent** locally, so the live query cannot be implemented and tested here without an approved dependency addition.

Until items 1–3 are addressed, `test:db-acl:strict` provides fail-closed behavior for missing evidence only, not positive production verification.

## 3. Local validation results (this pass)

| Command | Exit | Result |
|---|---|---|
| `node --check scripts/check-db-acl.mjs` + `.test.mjs` | 0 | syntax OK |
| `node --test scripts/check-db-acl.test.mjs` | 0 | 8/8 passed |
| `npm run test:db-acl:strict` (no URL) | 1 | `DB ACL FAIL: --strict-live requires DATABASE_ACL_URL` |
| `node scripts/check-supabase-migrations.mjs` | 0 | 190 migration files OK |
| `vitest run apps/web/src/lib/clinical-intelligence/wave1.test.ts` | 0 | 4/4 passed |

Tracked artifact `artifacts/readiness/db-acl-inventory.json` remained unchanged after all runs.

## 4. Production verification SQL — review

The seven read-only statements in Addendum 3 were re-reviewed. No demonstrable SQL errors found:

- Identity: `current_database()`, `current_user`, `version()` — valid.
- Overloads + effective EXECUTE: `aclexplode(COALESCE(proacl, acldefault('f', proowner)))` correctly surfaces implicit `PUBLIC EXECUTE` (`grantee = 0` handled by the `CASE`); `has_function_privilege` covers `public`/`anon`/`authenticated`/`service_role`. Owner and `SECURITY DEFINER` are selected; `proconfig` carries the pinned `search_path`.
- Overload existence: both `to_regprocedure` signatures match the two overloads exactly.
- Migration rows: `supabase_migrations.schema_migrations.version` is the correct Supabase catalog.
- Object existence: `to_regclass` on the clinical and accounting tables.
- RLS: `pg_class.relrowsecurity` / `relforcerowsecurity`; policies via `pg_policies`.

Optional (not an error): statement 2 can additionally select `pg_get_functiondef(p.oid)` to capture the body hash. The statements are independent; one failing does not block the others.

## 5. Fact classification

- **Source-verified:** migration files present/absent at HEAD vs `origin/main`; recovered `20260810120000` content (historical `76c36683`); `SECURITY DEFINER` + pinned `search_path` on both `receive_pharmacy_stock` overloads; caller-inventory (service-role server routes only); scanner false-PASS defect and its local fix.
- **Remotely verified:** none — no Supabase/GitHub/Vercel MCP; GitKraken sign-in blocked; no SQL Editor results in context.
- **Unknown:** production effective ACLs for `receive_pharmacy_stock`; production migration ledger rows for the two local-only migrations; production object existence.

## 6. Remaining blockers and approvals needed

1. **Approve the release.yml diff** in section 2 (add `environment: production` + strict ACL step). Impact: production release job; rollback: remove the step.
2. **Create the protected `DATABASE_ACL_URL` secret** (operator action; not an edit I can perform).
3. **Approve implementing the scanner live-query path** (+ a `pg` dependency) so the gate performs real verification; test against an isolated non-prod database first.
4. **Run the seven read-only SQL statements** and return outputs (unblocks the production ACL assessment).
5. **Approve applying** `20261007120000` and `20261022160000` via the guarded `db-production` workflow (only after reconciliation).

## 7. Readiness

**Production remains NOT READY.** Local hardening and fail-closed gating are in place and tested, but live ACL verification is not implemented and production evidence has not been supplied.
