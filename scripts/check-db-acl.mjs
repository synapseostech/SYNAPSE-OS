#!/usr/bin/env node
/**
 * Static SECURITY DEFINER ACL inventory + optional strict live-evidence gate.
 * Does not mutate production. The strict live path queries PostgreSQL/Supabase
 * catalogs over a read-only connection when DATABASE_ACL_URL is set.
 *
 * --strict-live  Fail (exit 1) when DATABASE_ACL_URL is unset OR when the live
 *                catalog verification fails. Success is never implied by the
 *                mere presence of the URL.
 */

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const root = process.cwd()
const migrationsDir = join(root, "supabase/migrations")

export function listSql(dir = migrationsDir) {
  return readdirSync(dir)
    .filter((name) => name.endsWith(".sql"))
    .sort()
    .map((name) => ({ name, source: readFileSync(join(dir, name), "utf8") }))
}

export function extractDefinerFunctions(source) {
  const names = []
  const re = /create(?:\s+or\s+replace)?\s+function\s+([a-zA-Z0-9_.]+)\s*\([\s\S]*?security\s+definer/gi
  let match
  while ((match = re.exec(source))) names.push(match[1])
  return names
}

export function publicExecuteGrants(source) {
  const grants = []
  const re = /grant\s+execute\s+on\s+function\s+([a-zA-Z0-9_.]+)\s*\([^)]*\)\s+to\s+(public|anon)/gi
  let match
  while ((match = re.exec(source))) grants.push({ fn: match[1], role: match[2].toLowerCase() })
  return grants
}

/**
 * Conservative static model of PostgreSQL's default ACL: a SECURITY DEFINER
 * function that is never explicitly revoked from PUBLIC/anon anywhere in the
 * migration set keeps the default PUBLIC EXECUTE (proacl IS NULL -> acldefault
 * grants PUBLIC). Dynamic revokes (execute format('revoke ... %s ...')) are
 * invisible to this static pass, so this list can over-flag; the live catalog
 * check is authoritative.
 */
export function functionsWithPossibleImplicitPublicExec(files) {
  const definers = []
  const revokes = new Set()
  const revokeRe = /revoke\s+(?:all|execute)\s+on\s+function\s+([a-zA-Z0-9_.]+)\s*\([^)]*\)\s+from\s+([^;]+)/gi
  for (const file of files) {
    for (const fn of extractDefinerFunctions(file.source)) definers.push({ fn, file: file.name })
    let m
    while ((m = revokeRe.exec(file.source))) {
      const roles = m[2].toLowerCase()
      if (roles.includes("public") || roles.includes("anon")) revokes.add(m[1])
    }
  }
  return definers.filter((d) => !revokes.has(d.fn))
}

/**
 * Read-only catalog query for the strict live check. Returns one row per
 * public.receive_pharmacy_stock overload with effective EXECUTE privileges,
 * owner, SECURITY DEFINER flag and pinned search_path. Implicit PUBLIC EXECUTE
 * (proacl IS NULL) is handled by has_function_privilege('public', ...).
 */
export const LIVE_ACL_SQL = `
SELECT t.signature,
       t.owner,
       t.security_definer,
       COALESCE((SELECT split_part(setting, '=', 2) FROM unnest(t.proconfig) AS pc(setting)
                 WHERE pc.setting LIKE 'search_path=%' LIMIT 1), '') AS search_path,
       has_function_privilege('public', t.oid, 'EXECUTE')        AS public_execute,
       has_function_privilege('anon', t.oid, 'EXECUTE')          AS anon_execute,
       has_function_privilege('authenticated', t.oid, 'EXECUTE') AS authenticated_execute,
       has_function_privilege('service_role', t.oid, 'EXECUTE')  AS service_role_execute
FROM (
  SELECT p.oid,
         p.oid::regprocedure::text AS signature,
         pg_get_userbyid(p.proowner) AS owner,
         p.prosecdef AS security_definer,
         p.proconfig
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND p.proname = 'receive_pharmacy_stock'
) t
ORDER BY t.signature;
`

/** The authoritative 13-argument signature must exist (the 8-arg was dropped by
 *  the noon hardening migration; it is audited if present but not required). */
export const EXPECTED_REQUIRED_SIGNATURES = [
  "receive_pharmacy_stock(uuid,uuid,text,integer,date,numeric,uuid,text,numeric,uuid,uuid,uuid,text)",
]

export function normalizeSignature(sig) {
  return String(sig ?? "").replace(/\s+/g, "").replace(/^public\./, "")
}

export function validateAclUrl(url) {
  if (typeof url !== "string" || url.trim() === "") throw new Error("ACL_URL_MISSING")
  let parsed
  try {
    parsed = new URL(url)
  } catch {
    throw new Error("ACL_URL_INVALID")
  }
  if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") throw new Error("ACL_URL_NOT_POSTGRES")
  return true
}

/**
 * Pure evaluation of live catalog rows. Returns { ok, errors, signatures }.
 * Fails on: no functions, missing required overload, implicit PUBLIC EXECUTE,
 * anon/authenticated EXECUTE, missing service_role EXECUTE, unsafe owner,
 * missing SECURITY DEFINER, or a search_path that does not include 'public'.
 */
export function evaluateLiveAcl(rows) {
  if (!Array.isArray(rows)) return { ok: false, errors: ["ACL_LIVE_INVALID_RESULT"], signatures: [] }
  if (rows.length === 0) {
    return { ok: false, errors: ["ACL_LIVE_NO_FUNCTIONS: public.receive_pharmacy_stock not found"], signatures: [] }
  }

  const allowedOwners = new Set(
    (process.env.ACL_EXPECTED_OWNERS ?? "postgres,supabase_admin").split(",").map((s) => s.trim()).filter(Boolean),
  )

  const errors = []
  const seen = new Set()
  for (const row of rows) {
    const sig = normalizeSignature(row.signature)
    seen.add(sig)
    for (const field of ["public_execute", "anon_execute", "authenticated_execute", "security_definer", "service_role_execute"]) {
      if (typeof row[field] !== "boolean") errors.push(`INCOMPLETE_ACL_ROW: ${sig} missing ${field}`)
    }
    if (row.security_definer !== true) errors.push(`NOT_SECURITY_DEFINER: ${sig}`)
    if (row.public_execute) errors.push(`PUBLIC_EXECUTE: ${sig}`)
    if (row.anon_execute) errors.push(`ANON_EXECUTE: ${sig}`)
    if (row.authenticated_execute) errors.push(`AUTHENTICATED_EXECUTE: ${sig}`)
    if (row.service_role_execute !== true) errors.push(`SERVICE_ROLE_NOT_EXECUTE: ${sig}`)
    if (!allowedOwners.has(row.owner)) errors.push(`UNSAFE_OWNER: ${sig} owner=${row.owner}`)
    const sp = String(row.search_path ?? "").trim()
    if (sp === "") errors.push(`SEARCH_PATH_MISSING: ${sig}`)
    else if (sp !== "public") errors.push(`SEARCH_PATH_UNSAFE: ${sig} search_path=${sp}`)
  }

  for (const expected of EXPECTED_REQUIRED_SIGNATURES) {
    if (!seen.has(normalizeSignature(expected))) errors.push(`MISSING_EXPECTED_OVERLOAD: ${expected}`)
  }

  return { ok: errors.length === 0, errors, signatures: [...seen] }
}

/**
 * Opens a read-only PostgreSQL connection and evaluates live ACLs. Never logs
 * or persists the URL. Requires the optional `pg` driver; fails closed with
 * PG_CLIENT_MISSING when it is absent.
 */
export async function runLiveCheckFromUrl(url) {
  validateAclUrl(url)
  let pg
  try {
    pg = await import("pg")
  } catch {
    throw new Error("PG_CLIENT_MISSING")
  }
  const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 5000 })
  try {
    await client.connect()
    await client.query("SET statement_timeout = '15s'")
    await client.query("BEGIN TRANSACTION READ ONLY")
    try {
      const res = await client.query(LIVE_ACL_SQL)
      return evaluateLiveAcl(res.rows)
    } finally {
      await client.query("ROLLBACK").catch(() => {})
    }
  } finally {
    await client.end().catch(() => {})
  }
}

async function main() {
  const strictLive = process.argv.includes("--strict-live")
  const liveUrl = process.env.DATABASE_ACL_URL
  const files = listSql()
  const definers = []
  const publicGrants = []
  for (const file of files) {
    for (const fn of extractDefinerFunctions(file.source)) definers.push({ file: file.name, fn })
    for (const grant of publicExecuteGrants(file.source)) publicGrants.push({ file: file.name, ...grant })
  }

  const allowedPublic = new Set([
    // Intentionally empty: privileged internals must not be PUBLIC/anon executable.
  ])

  const unexpected = publicGrants.filter((row) => !allowedPublic.has(`${row.fn}:${row.role}`))
  const possibleImplicitPublic = functionsWithPossibleImplicitPublicExec(files)

  let liveCheck = liveUrl ? "PENDING_OPERATOR" : "SKIPPED_NO_DATABASE_ACL_URL"

  if (strictLive) {
    if (!liveUrl) {
      console.error("DB ACL FAIL: --strict-live requires DATABASE_ACL_URL (live catalog evidence)")
      process.exit(1)
    }
    let live
    try {
      live = await runLiveCheckFromUrl(liveUrl)
    } catch (err) {
      console.error("DB ACL FAIL (live): " + String(err && err.message ? err.message : err))
      process.exit(1)
    }
    if (!live.ok) {
      console.error("DB ACL FAIL (live): " + live.errors.join("; "))
      process.exit(1)
    }
    liveCheck = "VERIFIED"
  }

  const status = unexpected.length ? "FAIL" : "PASS"
  const report = {
    generated_at: new Date().toISOString(),
    security_definer_count: definers.length,
    public_or_anon_execute_grants: publicGrants,
    unexpected_public_execute: unexpected,
    possible_implicit_public_exec: possibleImplicitPublic,
    status,
    live_check: liveCheck,
    strict_live: strictLive,
  }

  mkdirSync(join(root, "artifacts/readiness"), { recursive: true })
  writeFileSync(join(root, "artifacts/readiness/db-acl-inventory.json"), JSON.stringify({ ...report, functions: definers }, null, 2))

  if (unexpected.length) {
    console.error("DB ACL FAIL: unexpected PUBLIC/anon EXECUTE on SECURITY DEFINER candidates")
    console.error(JSON.stringify(unexpected, null, 2))
    process.exit(1)
  }

  console.log(`DB ACL static PASS definer_functions=${definers.length} public_grants=${publicGrants.length} possible_implicit_public=${possibleImplicitPublic.length} live_check=${liveCheck}`)
}

// Only run side effects when invoked directly (keeps the module importable by tests).
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch((err) => {
    console.error("DB ACL FAIL: " + String(err && err.message ? err.message : err))
    process.exit(1)
  })
}
