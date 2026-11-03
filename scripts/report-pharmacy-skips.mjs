#!/usr/bin/env node
/**
 * Classify every skipped test in the pharmacy suite.
 *
 * vitest exits 0 when a suite skips itself, so `Tests 1117 passed | 49 skipped`
 * and `Tests 1166 passed` both look like a green gate. This runner reads the
 * JSON report and fails when a test skips for a reason nobody declared here.
 *
 * Classes:
 *   environment-blocked  needs a database, a browser or a Windows host the run
 *                        did not have. Mandatory once the host exists.
 *   optional             not needed for a first-customer cutover
 *   deferred             known work that has not been written yet
 *
 * A declared file that runs is not an error: CI's db-acceptance job supplies a
 * database and those files stop skipping. An undeclared skip is an error,
 * because it means coverage was lost without a decision being recorded.
 *
 * Usage: node scripts/report-pharmacy-skips.mjs [path/to/vitest-report.json]
 * Without a path it runs the suite first, with the JSON reporter.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const pharmacy = join(root, 'apps/pharmacy')

/** Every file allowed to skip, with the class and the reason it is allowed. */
export const DECLARED_SKIPS = {
  'lib/pharmacy-refund-rpc.integration.test.ts': {
    class: 'environment-blocked',
    reason:
      'Refund, receivable, store-credit and stock-restoration RPCs through the service-role client. Needs a disposable Supabase stack (SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY); Docker is unreachable here. Same functions are proven at SQL level by scripts/db-tests/run-pharmacy-db-pglite.mjs financial.',
  },
  'lib/pharmacy-rls-tenant-isolation.integration.test.ts': {
    class: 'environment-blocked',
    reason:
      'Row security under a real user JWT. Needs a disposable Supabase stack plus NEXT_PUBLIC_SUPABASE_ANON_KEY to mint the token; no GoTrue here.',
  },
  'lib/platform/hospital-tenant-isolation.test.ts': {
    class: 'environment-blocked',
    reason: 'Hospital tenancy reads. Needs a disposable Supabase stack.',
  },
  'lib/platform/hospital-rbac-negative.integration.test.ts': {
    class: 'environment-blocked',
    reason: 'Hospital role denial. Needs a disposable Supabase stack.',
  },
  'lib/platform/hospital-billing-payment.integration.test.ts': {
    class: 'environment-blocked',
    reason: 'Hospital billing payment. Needs a disposable Supabase stack.',
  },
  'lib/platform/hospital-dispense-idempotency.integration.test.ts': {
    class: 'environment-blocked',
    reason: 'Dispense idempotency. Needs a disposable Supabase stack.',
  },
  'lib/platform/malaria-golden-journey.integration.test.ts': {
    class: 'environment-blocked',
    reason: 'Cross-module clinical journey. Needs a disposable Supabase stack.',
  },
  'lib/pos/sale-ledger.local.test.ts': {
    class: 'environment-blocked',
    reason: 'Sale history through a running local stack. Needs LOCAL_API_URL and LOCAL_SERVICE_ROLE_KEY.',
  },
}

const CLASSES = new Set(['environment-blocked', 'optional', 'deferred'])

/**
 * Reduce a vitest JSON report to per-file skip counts.
 * @returns {{ rows: Array<{ file: string, skipped: number, total: number }>, skippedTotal: number }}
 */
export function collectSkips(report) {
  const rows = []
  let skippedTotal = 0
  for (const suite of report.testResults ?? []) {
    const assertions = suite.assertionResults ?? []
    const skipped = assertions.filter((a) => a.status === 'skipped').length
    if (!skipped) continue
    skippedTotal += skipped
    rows.push({ file: suite.name, skipped, total: assertions.length })
  }
  return { rows, skippedTotal }
}

/**
 * Match report rows against the declarations.
 * @returns {{ declared: Array<object>, undeclared: Array<object>, countMismatch: boolean }}
 */
export function classifySkips(report, declared = DECLARED_SKIPS, rootDir = pharmacy) {
  const { rows, skippedTotal } = collectSkips(report)
  const byRelative = new Map(rows.map((row) => [row.file.slice(rootDir.length + 1), row]))

  const declaredRows = Object.entries(declared).map(([file, entry]) => ({
    file,
    class: entry.class,
    reason: entry.reason,
    observed: byRelative.get(file) ?? null,
  }))
  const undeclared = Object.keys(declared).length
    ? rows
        .filter((row) => !declared[row.file.slice(rootDir.length + 1)])
        .map((row) => ({ file: row.file.slice(rootDir.length + 1), skipped: row.skipped }))
    : rows.map((row) => ({ file: row.file.slice(rootDir.length + 1), skipped: row.skipped }))

  return {
    declared: declaredRows,
    undeclared,
    invalid: Object.entries(declared)
      .filter(([, entry]) => !CLASSES.has(entry.class) || !entry.reason?.trim())
      .map(([file]) => file),
    skippedTotal,
    countMismatch:
      typeof report.numPendingTests === 'number' && skippedTotal !== report.numPendingTests,
  }
}

function runSuite() {
  const output = join(tmpdir(), `pharmacy-skips-${process.pid}.json`)
  rmSync(output, { force: true })
  const result = spawnSync(
    'npx',
    ['vitest', 'run', '--reporter=json', `--outputFile=${output}`],
    {
      cwd: pharmacy,
      stdio: 'inherit',
      shell: process.platform === 'win32',
    },
  )
  return { status: result.status ?? 1, output }
}

function main() {
  const given = process.argv[2]
  let status = 0
  let output = given ? resolve(given) : null

  if (!output) {
    const run = runSuite()
    status = run.status
    output = run.output
  }

  if (!existsSync(output)) {
    console.error(
      `\n[skips] the suite produced no JSON report at ${output}. No classification was made.`,
    )
    process.exit(2)
  }

  const report = JSON.parse(readFileSync(output, 'utf8'))
  const { declared, undeclared, invalid, skippedTotal, countMismatch } = classifySkips(report)

  console.log('\n[skips] pharmacy suite skip classification')
  console.log(`  ${report.numPassedTests ?? 0} passed, ${skippedTotal} skipped, ${report.numFailedTests ?? 0} failed`)
  for (const entry of declared) {
    const seen = entry.observed ? `${entry.observed.skipped} skipped` : 'ran'
    console.log(`  ${entry.class.padEnd(20)} ${entry.file} — ${seen}`)
  }

  if (invalid.length) {
    console.error('\n[skips] FAIL: declarations without a known class or a reason:')
    for (const file of invalid) console.error(`  ${file}`)
    process.exit(1)
  }

  if (countMismatch) {
    console.error(
      `\n[skips] FAIL: the report counts ${report.numPendingTests} pending tests but the files account for ${skippedTotal}. The classifier cannot be trusted.`,
    )
    process.exit(1)
  }

  if (undeclared.length) {
    console.error('\n[skips] FAIL: tests skipped without a declared reason:')
    for (const entry of undeclared) console.error(`  ${entry.file} (${entry.skipped})`)
    console.error(
      '\nDeclare each one in scripts/report-pharmacy-skips.mjs with its class and reason, or make it run.',
    )
    process.exit(1)
  }

  if (status !== 0) {
    console.error('\n[skips] FAIL: the suite itself did not pass. Classification is moot.')
    process.exit(status)
  }

  console.log('\n[skips] every skip is declared. A skip is still not a pass.')
}

const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (isDirectRun) main()

export { CLASSES }
