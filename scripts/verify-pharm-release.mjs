#!/usr/bin/env node
/**
 * Deterministic SYNAPSE Pharm release gate.
 *
 * LOCAL (default):
 *   npm run verify:pharm-release
 *   Required in-repo checks only. PASS or FAIL. No PASS_WITH_SKIPS: the
 *   pharmacy suite's skips are classified by
 *   scripts/report-pharmacy-skips.mjs, and a skip nobody declared fails the
 *   gate instead of passing quietly.
 *
 * LIVE:
 *   npm run verify:pharm-release:live
 *   Local checks + live probes. Requires SYNAPSE_PHARM_LIVE=1.
 *   A skip or missing live credential is FAIL, not PASS.
 */
import { spawnSync } from 'node:child_process'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const live = process.argv.includes('--live') || process.env.SYNAPSE_PHARM_RELEASE_LIVE === '1'
const results = []

function run(name, command, args, { env = {}, cwd = root } = {}) {
  console.log(`\n[verify:pharm-release] ${name}`)
  const started = Date.now()
  const result = spawnSync(command, args, {
    stdio: 'inherit',
    shell: process.platform === 'win32',
    cwd,
    env: { ...process.env, ...env },
  })
  const status = result.status ?? 1
  const ms = Date.now() - started
  const outcome = status === 0 ? 'PASS' : 'FAIL'
  results.push({ name, outcome, status, ms })
  console.log(`[verify:pharm-release] ${name} ${outcome} (${ms}ms)`)
  if (status !== 0) {
    printSummary('FAIL')
    process.exit(status)
  }
  return true
}

function printSummary(final) {
  console.log('\n[verify:pharm-release] summary')
  for (const row of results) {
    console.log(`  ${row.outcome.padEnd(8)} ${row.name}`)
  }
  console.log(`\nRELEASE_GATE=${final}`)
}

run('db:check (migration integrity)', 'npm', ['run', 'db:check'])
run('db:history:check (migration history)', 'npm', ['run', 'db:history:check'])
run('test:migration-integrity (history + RPC coverage)', 'npm', ['run', 'test:migration-integrity'])
run('test:workflow-safety (CI gate + deploy provenance)', 'npm', ['run', 'test:workflow-safety'])
run('lint @synapse/web', 'npm', ['run', 'lint', '--workspace', '@synapse/web'])
run('lint @synapse/pharmacy', 'npm', ['run', 'lint', '--workspace', '@synapse/pharmacy'])
run('type-check @synapse/web', 'npm', ['run', 'type-check', '--workspace', '@synapse/web'])
run('type-check @synapse/pharmacy', 'npm', ['run', 'type-check', '--workspace', '@synapse/pharmacy'])
run('type-check @synapse/app', 'npm', ['run', 'type-check', '--workspace', '@synapse/app'])
run('test @synapse/pharmacy (unit/domain/authz/contracts)', 'npm', ['run', 'test', '--workspace', '@synapse/pharmacy'])
run('test:pharmacy-skips (every skip declared and classified)', 'npm', ['run', 'test:pharmacy-skips'])
run('test:tally (Tally import parsers + bridge)', 'npm', ['run', 'test:tally'])
run('test:pharmacy-print (shared receipt-print recorder)', 'npm', ['run', 'test:pharmacy-print'])
run('test:pharmacy-tax (shared tax engine + receipt tax split)', 'npm', ['run', 'test:pharmacy-tax'])
run('test:pharmacy-mobile-api (mobile pharmacy BFF routes)', 'npm', ['run', 'test:pharmacy-mobile-api'])
run('test:mobile-app (mobile till pricing, purchase draft, receipt print gate)', 'npm', ['run', 'test:mobile-app'])
run('build @synapse/pharmacy', 'npm', ['run', 'build', '--workspace', '@synapse/pharmacy'])
run('verify:web (type-check + Next build)', 'npm', ['run', 'verify:web'])
run('expo export --platform android', 'npm', ['run', 'export:android', '--workspace', '@synapse/app'])

if (live) {
  run('live RLS/RPC/schema probes', 'node', ['scripts/verify-pharm-live.mjs'], {
    env: { SYNAPSE_PHARM_LIVE: process.env.SYNAPSE_PHARM_LIVE ?? '1' },
  })
}

printSummary('PASS')
process.exit(0)
