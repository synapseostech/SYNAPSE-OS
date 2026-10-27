# Audit Addendum 3 — 2026-10-24 (Final local validation & remediation preparation)

Supplements the main report and Addenda 1–2. No production or repository mutations were performed. No secrets were accessed.

## 1. ACL scanner — final change and test results

`scripts/check-db-acl.mjs` (local, uncommitted):

- Exported pure functions `listSql`, `extractDefinerFunctions`, `publicExecuteGrants`; added `functionsWithPossibleImplicitPublicExec`.
- Models PostgreSQL default ACL: a `SECURITY DEFINER` function never explicitly revoked from `public`/`anon` keeps implicit `PUBLIC EXECUTE` (`proacl IS NULL`). Effective privileges are never inferred from textual grants alone; the live catalog check is the authority.
- Added `--strict-live`: exits 1 when `DATABASE_ACL_URL` is unset. The check runs **before** writing any artifact, so a strict run cannot mutate tracked readiness files.
- Side effects are guarded behind direct invocation, so unit tests import the module without writing `artifacts/readiness/db-acl-inventory.json`.
- Default `test:db-acl` behavior is preserved (static PASS/FAIL unchanged when run without `--strict-live`).

`scripts/check-db-acl.test.mjs` (new): 8 tests covering name extraction, public/anon grant detection, implicit-PUBLIC modeling (incl. `revoke all` and authenticated-only revoke), duplicate/malformed source, sorted listing, and the strict-live exit path.

**Results:**
- `node --check scripts/check-db-acl.mjs` → syntax OK.
- `node --test scripts/check-db-acl.test.mjs` → **8/8 passed, EXIT 0**.
- `npm run test:db-acl:strict` → **EXIT 1** with `DB ACL FAIL: --strict-live requires DATABASE_ACL_URL`; tracked artifact unchanged.

## 2. Release-gate integration — finding

- `package.json` `test:db-acl` = `node scripts/check-db-acl.mjs` (no `--strict-live`).
- `.github/workflows/ci.yml` (line 136) runs `npm run test:db-acl` (non-strict → fails open on missing live evidence).
- `.github/workflows/release.yml` runs `npm run db:check` only; it does not invoke the ACL scanner at all.

**Gap:** no production release gate uses strict live ACL verification.

**Local change made:** added `package.json` script `test:db-acl:strict` = `node scripts/check-db-acl.mjs --strict-live` (fail-closed). This preserves local dev (`test:db-acl` unchanged).

**Not changed:** `.github/workflows/release.yml` (pre-existing user modifications — left untouched) and `.github/workflows/ci.yml` (adding strict mode there unconditionally would break PR CI since `DATABASE_ACL_URL` is not set). Recommended follow-up (requires separate approval): in the production/release job only, run `npm run test:db-acl:strict` with `DATABASE_ACL_URL` provided from a protected secret, after `db:check`.

## 3. Migration facts — verified this pass (HEAD vs origin/main)

| Migration file | HEAD | origin/main |
|---|---|---|
| `20260810120000_pharmacy_pilot_authority_hardening.sql` | absent | absent (historical only; content recovered from `76c36683`) |
| `20260810093707_pharmacy_pilot_authority_hardening.sql` | present | present |
| `20260810093859_pharmacy_rpc_revoke_client_execute.sql` | present | present |
| `20261007120000_clinical_intelligence_advice_events.sql` | present | **absent (local-only)** |
| `20261022160000_pharmacy_accounting_ledger.sql` | present | **absent (local-only)** |

Confirmed vs hypothesis: the recovered `20260810120000` content (Addendum 1) is a **historical Git object**, not a file on the current branch; the current-branch revoke history is `20260810093707`/`20260810093859` plus the new `20261003150000` (which does not cover `receive_pharmacy_stock`).

## 4. Files changed during this pass

- `scripts/check-db-acl.mjs` — modified (strict-live reordered before artifact write; earlier pass added exports + implicit-PUBLIC model).
- `scripts/check-db-acl.test.mjs` — new (8 tests).
- `package.json` — added `test:db-acl:strict` script.
- `docs/SECURITY_AND_READINESS_AUDIT_2026-10-24_ADDENDUM_3.md` — this file.

Nothing staged, committed, pushed, or deployed. Pre-existing 9 modified + 2 untracked files preserved.

## 5. Tests run this pass (exact exit codes)

| Command | Exit | Result |
|---|---|---|
| `node --check scripts/check-db-acl.mjs` | 0 | syntax OK |
| `node --test scripts/check-db-acl.test.mjs` | 0 | 8/8 passed |
| `npm run test:db-acl:strict` | 1 | expected fail-closed (no live URL); artifact unchanged |

Remaining blockers: `tsx` not installed (pharmacy-purchases suite); no Docker/local Postgres (DB-backed tests); no Supabase/GitHub/Vercel MCP in session.

## 6. Reviewed read-only production SQL (PostgreSQL/Supabase compatible)

Run each statement independently; a failure in one does not block the others. Confirm the SQL Editor is connected to the intended project before interpreting results.

```sql
-- 1. Identity
SELECT current_database() AS database, current_user AS session_user, version();

-- 2. receive_pharmacy_stock overloads + effective EXECUTE (incl. implicit PUBLIC via acldefault)
WITH target AS (
  SELECT p.oid, p.proowner,
         p.oid::regprocedure::text AS signature,
         pg_get_userbyid(p.proowner) AS owner,
         p.prosecdef AS security_definer, p.proconfig, p.proacl
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'receive_pharmacy_stock'
),
acl AS (
  SELECT t.oid,
         CASE WHEN x.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(x.grantee) END AS grantee,
         x.privilege_type, x.is_grantable
  FROM target t
  CROSS JOIN LATERAL aclexplode(COALESCE(t.proacl, acldefault('f', t.proowner))) x
)
SELECT t.signature, t.owner, t.security_definer, t.proconfig,
       jsonb_agg(jsonb_build_object('grantee', a.grantee, 'privilege', a.privilege_type,
                                    'grantable', a.is_grantable)
                 ORDER BY a.grantee, a.privilege_type) AS acl_entries,
       has_function_privilege('public', t.oid, 'EXECUTE')        AS public_execute,
       has_function_privilege('anon', t.oid, 'EXECUTE')          AS anon_execute,
       has_function_privilege('authenticated', t.oid, 'EXECUTE') AS authenticated_execute,
       has_function_privilege('service_role', t.oid, 'EXECUTE')  AS service_role_execute
FROM target t JOIN acl a ON a.oid = t.oid
GROUP BY t.oid, t.signature, t.owner, t.security_definer, t.proconfig
ORDER BY t.signature;

-- 3. Overload existence
SELECT to_regprocedure('public.receive_pharmacy_stock(uuid,uuid,text,integer,date,numeric,uuid,text)') IS NOT NULL AS eight_arg_exists,
       to_regprocedure('public.receive_pharmacy_stock(uuid,uuid,text,integer,date,numeric,uuid,text,numeric,uuid,uuid,uuid,text)') IS NOT NULL AS thirteen_arg_exists;

-- 4. Migration ledger rows
SELECT version FROM supabase_migrations.schema_migrations
WHERE version IN ('20260810093707','20260810093859','20261003150000','20261007120000','20261022160000')
ORDER BY version;

-- 5. Feature-migration object existence
SELECT to_regclass('public.clinical_ai_advice_events') IS NOT NULL           AS advice_events_exists,
       to_regclass('public.pharmacy_accounting_accounts') IS NOT NULL        AS accounting_accounts_exists,
       to_regclass('public.pharmacy_accounting_journal_entries') IS NOT NULL AS journal_entries_exists;

-- 6. RLS state on the feature tables
SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public'
  AND c.relname IN ('clinical_ai_advice_events','pharmacy_accounting_accounts',
                    'pharmacy_accounting_journal_entries','pharmacy_accounting_journal_lines',
                    'pharmacy_accounting_periods','pharmacy_bank_statement_imports',
                    'pharmacy_bank_statement_lines')
ORDER BY c.relname;

-- 7. Policies on the feature tables
SELECT tablename, policyname, cmd, roles, qual, with_check
FROM pg_policies
WHERE schemaname = 'public'
  AND tablename IN ('clinical_ai_advice_events','pharmacy_accounting_accounts',
                    'pharmacy_accounting_journal_entries','pharmacy_accounting_journal_lines')
ORDER BY tablename, policyname;
```

## 7. Actions still requiring explicit approval

1. Run the SQL in section 6 and return the outputs.
2. Apply the `receive_pharmacy_stock` ACL remediation to production (exact migration + rollback in Addendum 1) — only after evidence.
3. Apply `20261007120000` and `20261022160000` via the guarded `db-production` workflow.
4. Add `test:db-acl:strict` to the production release job with `DATABASE_ACL_URL` from a protected secret.
5. Install `tsx` (or authorize the extensionless-import refactor) to run `tsx`-based suites.

## 8. Readiness assessment

**Production remains NOT READY.** The scanner now fails closed locally and is covered by 8 tests, but production `receive_pharmacy_stock` effective permissions and migration state have not been verified (no SQL Editor results in context, no Supabase MCP). Do not interpret the absence of live evidence as a verified ACL PASS.
