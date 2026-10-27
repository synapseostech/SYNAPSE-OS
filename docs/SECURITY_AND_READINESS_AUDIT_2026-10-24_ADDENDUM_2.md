# Audit Addendum 2 — 2026-10-24 (MCP discovery, scanner hardening, status)

This file supplements `SECURITY_AND_READINESS_AUDIT_2026-10-24.md` and its first addendum. No production actions were taken. No secrets were accessed or printed.

## 1. MCPs discovered and operations actually performed

| Integration | Available in session | Used? | Result |
|---|---|---|---|
| Supabase MCP | **No** | — | Not available; no catalog queries could be run via MCP. |
| GitHub (API) MCP | **No** | — | Not available. |
| Vercel MCP | **No** | — | Not available. |
| GitKraken CLI MCP (`repository_get_file_content`, etc.) | Yes | Attempted (read-only) | **Blocked** — opened a GitKraken sign-in flow; no GitHub read performed. Not authenticated in this session. |
| MSSQL MCP (`mssql_*`) | Yes | No | Inapplicable — Microsoft SQL Server, not PostgreSQL/Supabase. Deliberately not used against the Supabase project. |
| Next.js DevTools MCP | Yes | No | Requires a running Next.js dev server; not applicable to this DB/Git audit. |

**MCP gap:** there is no Supabase, GitHub-API, or Vercel MCP in this VS Code session, and GitKraken is not signed in. Database- and deployment-level verification therefore cannot be performed through connected tools here and remains operator-dependent.

## 2. SQL Editor results — not present

The read-only SQL results the operator reports obtaining in the Supabase SQL Editor are **not present in this session's context**. Per instructions, they are not being invented or interpreted as passing. Production ACLs for `receive_pharmacy_stock` remain **UNKNOWN**. The exact operator SQL remains as published in Addendum 1.

## 3. Local fix — ACL scanner hardening

Confirmed defect: `scripts/check-db-acl.mjs` reported `PASS` with `live_check: SKIPPED_NO_DATABASE_ACL_URL` (false positive) and did not model PostgreSQL's implicit default `PUBLIC EXECUTE` (`proacl IS NULL`).

Change applied (uncommitted, local only; file was not user-modified):
- Exported pure functions (`listSql`, `extractDefinerFunctions`, `publicExecuteGrants`) and added `functionsWithPossibleImplicitPublicExec` (conservative static model of default PUBLIC EXECUTE for `SECURITY DEFINER` functions never explicitly revoked from `public`/`anon`).
- Added `--strict-live` mode: exits 1 when `DATABASE_ACL_URL` is unset, so a release gate cannot pass without live evidence.
- Wrapped side effects in a direct-invocation guard so the module is importable by tests without writing `artifacts/readiness/db-acl-inventory.json`.
- Added `scripts/check-db-acl.test.mjs` (4 tests).

Verification (read-only; no artifact written):
- `node --check scripts/check-db-acl.mjs` → syntax OK.
- `node --test scripts/check-db-acl.test.mjs` → **4/4 passed, EXIT 0**.

Files changed:
- `scripts/check-db-acl.mjs` (modified)
- `scripts/check-db-acl.test.mjs` (new)

Default `test:db-acl` behavior is unchanged; CI can adopt `node scripts/check-db-acl.mjs --strict-live` for release gating once live evidence is wired in.

## 4. Clinical Intelligence — status unchanged

- Wave1 flag verified OFF by default (`apps/web/src/lib/clinical-intelligence/feature-flag.ts`, unit tests 4/4 passed earlier).
- `recordClinicianOverride` still non-persistent; `clinical_ai_advice_events` still has no writer.
- `pathway` route still gated by hospital-module access, not the Wave1 flag (advisory-only, mock, `canActivate:false`).

No new clinical tests were added this pass; existing `wave1.test.ts` coverage remains.

## 5. Pharmacy accounting — status unchanged

Static review found no confirmed double-entry correctness defect; postings balance and idempotency keys are present. DB-backed tests remain **blocked**: no Docker, no local PostgreSQL, and no `tsx`. The exact `tsx` blocker (extensionless `inventory-rpc` import under Node type-stripping) was re-confirmed previously. No accounting code was changed and no seed/posting occurred.

## 6. Migration reconciliation — status unchanged

- `20260810120000` — absent at HEAD/`origin/main`; recovered from Git history (`76c36683`) and documented in Addendum 1.
- `20261007120000` and `20261022160000` — local-only (not in `origin/main`).
- `20260810093707`, `20260810093859`, `20261003150000` — present in `origin/main`.
- No migration was applied, repaired, or marked applied.

## 7. Worktree state

Pre-existing changes preserved: 9 modified + 2 untracked (`.freebuff/`, `.mcp.json`). New files from this engagement: two audit reports + two addenda, and the scanner change + its test. Nothing staged, committed, pushed, or deployed.

## 8. Status table

| Area | Status |
|---|---|
| Security remediation | **Partial (local)** — scanner hardened + tests; RPC ACL remediation not applied (production) |
| Supabase ACLs | **Unknown** — no SQL Editor results in context; no Supabase MCP |
| Migration reconciliation | **Blocked** — remote ledger requires operator evidence |
| Clinical Intelligence | **Flag OFF verified**; override audit not persisted |
| Pharmacy accounting | **Unapplied**; static review clean; DB tests blocked (no Docker) |
| Tests and builds | db:check EXIT 0 · secrets PASS · Wave1 4/4 · ACL scanner 4/4 · pharmacy-purchases blocked (no `tsx`) |
| GitHub/CI | **Unverified via MCP** — GitKraken sign-in blocked; no GitHub MCP |
| Vercel | **Unverified** — no Vercel MCP |
| Production readiness | **Not ready** — production ACL evidence outstanding |

## 9. Outstanding approval gates

1. **Run the operator SQL** (Addendum 1) in the SQL Editor and return the four `*_execute` booleans + `acl_entries` for both `receive_pharmacy_stock` signatures, plus the `schema_migrations` rows and object-existence booleans.
2. **Apply ACL remediation** to production only after that evidence (exact migration + rollback in Addendum 1) — explicit approval required.
3. **Apply** `20261007120000` and `20261022160000` via the guarded `db-production` workflow — explicit approval required.
4. **Install `tsx`** (or authorize the extensionless-import refactor) to run the `tsx`-based suites — approval required.
