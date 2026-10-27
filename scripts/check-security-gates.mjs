#!/usr/bin/env node
/**
 * Forward-looking static security gates for SYNAPSE-OS.
 * Complements scripts/check-db-acl.mjs (which scans all history for PUBLIC/anon EXECUTE).
 *
 * Scope: migrations with timestamp >= CUTOFF (the profiles-guard wave) plus a few
 * hard-coded browser pages. Historical permissive policies / grants are inventoried
 * live in Phase A and are not re-litigated here.
 *
 * The analysis is exported as a pure function so the rules can be regression
 * tested (scripts/check-security-gates.test.mjs) against synthetic SQL. Run as a
 * CLI it writes artifacts/readiness/security-gates.json and exits non-zero on
 * any finding.
 */
import { readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const CUTOFF = '20261003160000'

const PRIVILEGED_PROFILE_COLS = new Set([
  'role', 'tenant_id', 'hospital_id', 'is_admin', 'platform_control_role',
  'password_hash', 'email', 'verification_status', 'must_change_password',
  'locked_until', 'login_attempts',
])

const ALLOWED_AUTH_EXECUTE = new Set([
  'public.current_tenant_id',
  'public.current_hospital_id',
  'public.is_platform_admin',
  'public.is_clinical_staff',
  'public.person_visible_to_tenant',
  'current_tenant_id',
  'current_hospital_id',
  'is_platform_admin',
  'is_clinical_staff',
  'person_visible_to_tenant',
])

const BROWSER_PAGES = [
  'apps/web/src/app/admin/staff/invite/page.tsx',
  'apps/web/src/app/admin/hr/payroll/page.tsx',
]

export function stripComments(sql) {
  return sql.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ')
}

/**
 * Some migrations enable RLS with a DO block that loops over a table array and
 * issues `execute format('alter table public.%I enable row level security', v_table)`.
 * That is real enforcement, so a literal-only scan would report a false positive.
 * It only counts when the same block both enables RLS dynamically and names the
 * table literally — a block that enables RLS for some other table does not cover
 * this one.
 */
export function dynamicRlsEnabled(src, table) {
  const blocks = [...src.matchAll(/do\s+\$\$([\s\S]*?)\$\$\s*;/gi)].map((match) => match[1])
  return blocks.some((block) => {
    const enablesRlsDynamically =
      /execute\s+format\(\s*'alter\s+table\s+(?:public\.)?%I\s+enable\s+row\s+level\s+security'/i.test(block)
    if (!enablesRlsDynamically) return false
    return new RegExp(`'${table}'`, 'i').test(block)
  })
}

/**
 * @param {{name: string, source: string}[]} migrations
 * @param {{path: string, source: string|null}[]} browserPages
 * @returns {{file: string, rule: string, detail: string}[]}
 */
export function analyseSources(migrations, browserPages = []) {
  const failures = []

  for (const file of migrations) {
    const raw = file.source
    const src = stripComments(raw)

    // EXECUTE to public/anon is never allowed. EXECUTE to authenticated only for allowlisted helpers.
    const grantRe = /grant\s+execute\s+on\s+function\s+([a-zA-Z0-9_.]+)\s*\([^)]*\)\s+to\s+([^;]+)/gi
    let m
    while ((m = grantRe.exec(src))) {
      const fn = m[1]
      const roles = m[2].toLowerCase().split(',').map((r) => r.trim()).filter(Boolean)
      for (const role of roles) {
        if (role === 'public' || role === 'anon') {
          failures.push({ file: file.name, rule: 'execute_grant_public_or_anon', detail: `${fn} to ${role}` })
        } else if (role === 'authenticated' && !ALLOWED_AUTH_EXECUTE.has(fn)) {
          failures.push({ file: file.name, rule: 'execute_grant_authenticated_unexpected', detail: `${fn} to authenticated` })
        }
      }
    }

    // Privileged profiles column UPDATE grants to API roles
    const colGrant = /grant\s+update\s*\(([^)]+)\)\s+on\s+(?:table\s+)?(?:public\.)?profiles\s+to\s+(anon|authenticated|public)/gi
    while ((m = colGrant.exec(src))) {
      const cols = m[1].split(',').map((c) => c.trim().replace(/"/g, '').toLowerCase())
      const bad = cols.filter((c) => PRIVILEGED_PROFILE_COLS.has(c))
      if (bad.length) {
        failures.push({ file: file.name, rule: 'privileged_profile_column_grant', detail: `${m[2]}: ${bad.join(',')}` })
      }
    }
    if (/grant\s+(all|update)\s+on\s+(?:table\s+)?(?:public\.)?profiles\s+to\s+(anon|authenticated|public)/gi.test(src)) {
      failures.push({ file: file.name, rule: 'broad_profiles_update_grant', detail: 'grant all/update on profiles to API role' })
    }

    // Permissive policies for non-service roles (require annotation to pass)
    const policyRe = /create\s+policy\s+([a-zA-Z0-9_"]+)\s+on\s+([a-zA-Z0-9_."]+)([\s\S]*?);/gi
    while ((m = policyRe.exec(raw))) {
      const cleaned = stripComments(m[0])
      const rolesMatch = /(?:\bto\s+)([a-zA-Z0-9_,\s]+?)(?:\s+using|\s+with\s+check|\s*;)/i.exec(cleaned)
      const roles = (rolesMatch?.[1] || 'public').toLowerCase()
      const isServiceOnly = roles.replace(/\s+/g, '') === 'service_role'
      const permissive = /\busing\s*\(\s*true\s*\)/i.test(cleaned) || /\bwith\s+check\s*\(\s*true\s*\)/i.test(cleaned)
      if (permissive && !isServiceOnly) {
        const annotated = /--\s*security-gate:\s*allow-permissive/i.test(raw.slice(Math.max(0, m.index - 240), m.index))
        if (!annotated) {
          failures.push({ file: file.name, rule: 'permissive_policy', detail: `${m[1]} on ${m[2]} roles=${roles.trim()}` })
        }
      }
    }

    // A tenant predicate that compares the row's own column to itself is a
    // tautology, not isolation (see SEC-01 in the 2026-10-24 programme audit).
    const tenantPolicyRe = /create\s+policy\s+"?([a-zA-Z0-9_]+)"?\s+on\s+(?:public\.)?"?([a-zA-Z0-9_]+)"?([\s\S]*?);/gi
    while ((m = tenantPolicyRe.exec(src))) {
      const body = m[3]
      const table = m[2]
      const selfReferential = new RegExp(
        `tenant_id"?\\s*=\\s*\\(\\s*select\\s+"?${table}"?\\."?tenant_id"?(?![a-z0-9_])`,
        'i',
      )
      if (selfReferential.test(body)) {
        failures.push({ file: file.name, rule: 'self_referential_tenant_policy', detail: `${m[1]} on ${table}` })
      }
    }

    // New tables must enable RLS (literally, or through a table-array DO block) or be annotated
    const createTable = /create\s+table\s+(?:if\s+not\s+exists\s+)?(?:public\.)?([a-zA-Z0-9_]+)/gi
    while ((m = createTable.exec(src))) {
      const table = m[1]
      const enabledLiterally = new RegExp(`alter\\s+table\\s+(?:if\\s+exists\\s+)?(?:public\\.)?${table}\\s+enable\\s+row\\s+level\\s+security`, 'i').test(src)
      const enabled = enabledLiterally || dynamicRlsEnabled(src, table)
      const idx = raw.search(new RegExp(`create\\s+table\\s+(?:if\\s+not\\s+exists\\s+)?(?:public\\.)?${table}`, 'i'))
      const annotated = idx >= 0 && /--\s*security-gate:\s*allow-no-rls/i.test(raw.slice(Math.max(0, idx - 240), idx))
      if (!enabled && !annotated) {
        failures.push({ file: file.name, rule: 'create_table_missing_rls', detail: table })
      }
    }
  }

  for (const page of browserPages) {
    if (page.source == null) {
      failures.push({ file: page.path, rule: 'browser_page_missing', detail: 'expected page not found' })
      continue
    }
    if (/from\(\s*['"]profiles['"]\s*\)\s*\.(update|upsert|insert)/.test(page.source) || /auth\.signUp/.test(page.source)) {
      failures.push({ file: page.path, rule: 'browser_profiles_write', detail: 'page writes profiles or calls auth.signUp' })
    }
  }

  return failures
}

function listSql(root, fromCutoff = true) {
  const migDir = join(root, 'supabase/migrations')
  return readdirSync(migDir)
    .filter((n) => /^\d+_.*\.sql$/i.test(n))
    .filter((n) => !fromCutoff || n.slice(0, 14) >= CUTOFF)
    .map((name) => ({ name, source: readFileSync(join(migDir, name), 'utf8') }))
}

function readOrNull(path) {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return null
  }
}

function main() {
  const root = process.cwd()
  const migrations = listSql(root, true)
  const browserPages = BROWSER_PAGES.map((path) => ({ path, source: readOrNull(join(root, path)) }))
  const failures = analyseSources(migrations, browserPages)

  const report = {
    generated_at: new Date().toISOString(),
    cutoff: CUTOFF,
    migrations_scanned: migrations.length,
    status: failures.length ? 'FAIL' : 'PASS',
    failure_count: failures.length,
    failures,
  }
  mkdirSync(join(root, 'artifacts/readiness'), { recursive: true })
  writeFileSync(join(root, 'artifacts/readiness/security-gates.json'), JSON.stringify(report, null, 2))

  if (failures.length) {
    console.error('SECURITY GATES FAIL')
    console.error(JSON.stringify(failures, null, 2))
    process.exit(1)
  }
  console.log(`SECURITY GATES PASS cutoff=${CUTOFF} migrations=${migrations.length} failures=0`)
}

const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (isDirectRun) main()
