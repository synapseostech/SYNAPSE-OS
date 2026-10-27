# Audit Addendum — 2026-10-24 (corrects & extends the main report)

This file corrects and extends `SECURITY_AND_READINESS_AUDIT_2026-10-24.md`. It does not overwrite that report.

## A. Correction to finding F1 (`receive_pharmacy_stock`)

**The earlier statement that no `EXECUTE` revocation exists anywhere in history is incorrect.** The original 13-argument migration was recovered read-only from Git history and shows the opposite:

- File: `supabase/migrations/20260810120000_pharmacy_pilot_authority_hardening.sql`
- Recoverable at commit `76c36683` (also `1c07a8a8`); removed from the tree at `19ef5d04` ("ops: reconcile production migration ledger and land invitation hardening").
- The migration:
  1. Drops **both** overloads:
     - `drop function if exists public.receive_pharmacy_stock(uuid,uuid,text,integer,date,numeric,uuid,text)` (8-arg)
     - `drop function if exists public.receive_pharmacy_stock(uuid,uuid,text,integer,date,numeric,uuid,text,numeric,uuid,uuid,uuid,text)` (13-arg)
  2. Recreates **only** the 13-arg overload (`SECURITY DEFINER`, `SET search_path TO 'public'`).
  3. Ends with a "Least privilege — privileged pharmacy RPCs are service_role only" block that dynamically runs, for `receive_pharmacy_stock` (and 4 others):
     - `revoke all on function %s from public`
     - `revoke all on function %s from anon`
     - `revoke all on function %s from authenticated`
     - `grant execute on function %s to service_role`

**Consequence (source-derived inference, not a verified production fact):**
- The 13-arg overload was created together with a least-privilege revoke, so it should NOT have default `PUBLIC EXECUTE` in production.
- The 8-arg overload was **dropped** by this migration, so production likely has only the 13-arg overload. The live-journey scripts that pass 8 arguments resolve to the 13-arg overload via its default parameters.
- Production ledger evidence: the repo contains `20260810093707_pharmacy_pilot_authority_hardening.sql`, which is "Materialized from production supabase_migrations.schema_migrations" (project `qfqakzmjatszisuqjwon`, 2026-09-11 read-only dump) and verifies `to_regprocedure('public.receive_pharmacy_stock(uuid,uuid,text,integer,date,numeric,uuid,text,numeric,uuid,uuid,uuid,text)') IS NOT NULL` as true. This is a **verified production fact from a materialized dump**: production had the 13-arg overload on 2026-09-11.

**Corrected severity:** downgrade the F1 hypothesis from "likely PUBLIC EXECUTE" to **"intended and migrated as service-role-only per recovered source; current production ACL still UNKNOWN until operator evidence."** The residual risk is that the 13-arg body trusts caller-supplied `p_tenant_id`/`p_received_by` (no `auth.uid()`), so the service-role-only boundary remains the only caller control.

Static vs verified vs unknown:
- **Static source fact:** the noon migration drops the 8-arg and creates the 13-arg with service-role-only revoke.
- **Verified production fact (materialized dump):** production ledger contains version `20260810093707` and the 13-arg function existed on 2026-09-11.
- **Unknown:** whether production still has only the 13-arg overload, and its current effective ACL.

## B. Corrected operator SQL (supersedes section 8 of the main report)

This query detects implicit `PUBLIC` EXECUTE (when `proacl IS NULL`, PostgreSQL's default `acldefault('f', owner)` grants EXECUTE to PUBLIC) and lists the effective ACL entries. Run only in the SQL Editor against the verified project; confirm the project ref before interpreting results. Not executed here.

```sql
WITH target AS (
  SELECT p.oid, p.proowner,
         p.oid::regprocedure::text AS signature,
         pg_get_userbyid(p.proowner) AS owner,
         p.prosecdef AS security_definer,
         p.proconfig,
         p.proacl,
         pg_get_functiondef(p.oid) AS definition
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND p.proname = 'receive_pharmacy_stock'
),
acl AS (
  SELECT t.oid,
         CASE WHEN x.grantee = 0 THEN 'PUBLIC'
              ELSE pg_get_userbyid(x.grantee) END AS grantee,
         x.privilege_type, x.is_grantable
  FROM target t
  CROSS JOIN LATERAL aclexplode(COALESCE(t.proacl, acldefault('f', t.proowner))) x
)
SELECT current_database() AS db, session_user,
       t.signature, t.owner, t.security_definer, t.proconfig,
       COALESCE(
         jsonb_agg(jsonb_build_object('grantee', a.grantee,
                                      'privilege', a.privilege_type,
                                      'grantable', a.is_grantable)
                   ORDER BY a.grantee, a.privilege_type)
         FILTER (WHERE a.oid IS NOT NULL), '[]'::jsonb) AS acl_entries,
       has_function_privilege('public',        t.oid, 'EXECUTE') AS public_execute,
       has_function_privilege('anon',          t.oid, 'EXECUTE') AS anon_execute,
       has_function_privilege('authenticated', t.oid, 'EXECUTE') AS authenticated_execute,
       has_function_privilege('service_role',  t.oid, 'EXECUTE') AS service_role_execute,
       t.definition
FROM target t
LEFT JOIN acl a ON a.oid = t.oid
GROUP BY t.oid, t.signature, t.owner, t.security_definer, t.proconfig, t.definition
ORDER BY t.signature;

-- Exact-signature existence (operator must report both):
SELECT to_regprocedure('public.receive_pharmacy_stock(uuid,uuid,text,integer,date,numeric,uuid,text)') IS NOT NULL AS eight_arg_exists,
       to_regprocedure('public.receive_pharmacy_stock(uuid,uuid,text,integer,date,numeric,uuid,text,numeric,uuid,uuid,uuid,text)') IS NOT NULL AS thirteen_arg_exists;

-- Migration ledger rows:
SELECT version FROM supabase_migrations.schema_migrations
WHERE version IN ('20260810093707','20260810093859','20261007120000','20261022160000','20261003150000')
ORDER BY version;

-- Local-only migration objects:
SELECT to_regclass('public.clinical_ai_advice_events') IS NOT NULL            AS advice_events_exists,
       to_regclass('public.pharmacy_accounting_journal_entries') IS NOT NULL  AS accounting_ledger_exists;
```

## C. Missing migration record `20260810120000`

- File is **absent** at HEAD and in `origin/main`; present only in history (`76c36683`, `1c07a8a8`, removed at `19ef5d04`).
- Its production ledger equivalent is version `20260810093707` (per the materialized record). No migration-history repair was performed and none is proposed.

## D. Pharmacy-purchases tests — exact blocker

- `tsx` is **not installed** anywhere in the workspace (searched `node_modules/.bin` and up to depth 7). I declined to auto-install it.
- Node's built-in `--experimental-strip-types --test packages/db/src/pharmacy-purchases.test.ts` **fails** with `ERR_MODULE_NOT_FOUND` for `packages/db/src/inventory-rpc` because the import in `pharmacy-purchases.ts` omits the `.ts` extension, which Node's ESM loader requires.
- Result: `tests 1, pass 0, fail 1` (import failure, not a logic failure). Running the suite requires either installing `tsx` (approval needed) or adding explicit `.ts` extensions across the import graph (code change, not performed).

## E. Supabase connection state

- Local link metadata exists: `supabase/.temp/project-ref` = `qfqakzmjatszisuqjwon`. This is an identifier, not a credential; it was not used to connect.
- The `supabase` CLI binary is not present in `node_modules/.bin`, and no authenticated read-only connection is established in this session.
- **No catalog queries were executed against production.** The SQL in section B is for you to run in the SQL Editor.

## F. Worktree state (unchanged)

No code, migration, or configuration files were modified. This addendum is a new file. The pre-existing 9 modified + 2 untracked files remain untouched. No staging, committing, pushing, deploying, or migration changes occurred.
