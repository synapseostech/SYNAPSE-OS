#!/usr/bin/env node
/**
 * collect-evidence.mjs — run the local gate commands, parse their real output,
 * and write artifacts/readiness/evidence.json so audit documents cite one
 * generated source instead of restating numbers that rot.
 *
 * Read-only with respect to source: it only runs commands that read the tree.
 * It writes artifacts/readiness/evidence.json and refreshes the delimited
 * evidence block in the two audit documents below. Nothing else.
 */
import { spawnSync } from "node:child_process"
import { writeFileSync, mkdirSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { renderEvidenceBlock, replaceEvidenceBlock } from "./lib/evidence-block.mjs"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")
let tmpCounter = 0

function run(cmd) {
  const started = Date.now()
  // Redirect to a file rather than capturing pipes: vitest's summary table is
  // flaky when its stderr interleaves with a pipe, but deterministic to a file.
  const tmp = join(tmpdir(), `synapse-evidence-${process.pid}-${tmpCounter++}.log`)
  const r = spawnSync(`exec ${cmd} > "${tmp}" 2>&1`, {
    cwd: root,
    shell: true,
    encoding: "utf8",
    env: { ...process.env, FORCE_COLOR: "0" },
  })
  let all = ""
  try {
    // Strip ANSI colour codes: vitest can emit them even to a redirected file.
    all = readFileSync(tmp, "utf8").replace(/\x1b\[[0-9;]*m/g, "")
  } catch {
    /* keep empty */
  }
  return {
    cmd,
    all,
    exitCode: r.status ?? -1,
    durationMs: Date.now() - started,
  }
}

/**
 * node:test prints different summaries depending on the reporter it picks:
 * the spec reporter (a TTY) uses `ℹ tests N`, the TAP reporter (a redirected
 * file, which is what this script always uses) uses `# tests N`. Both must
 * parse, or every node:test suite records `null` and the figures look absent
 * rather than wrong.
 */
function parseNodeTestCounts(text) {
  const g = (key) => {
    const m =
      text.match(new RegExp(`^ℹ\\s+${key}\\s+(\\d+)\\s*$`, "m")) ??
      text.match(new RegExp(`^#\\s+${key}\\s+(\\d+)\\s*$`, "m"))
    return m ? Number(m[1]) : null
  }
  return {
    tests: g("tests"),
    pass: g("pass"),
    fail: g("fail"),
  }
}

/** vitest prints `Test Files  N passed (N)` and `Tests  N passed (N)`. */
function parseVitestCounts(text) {
  const files = text.match(/Test Files\s+(\d+)\s+passed\s+\((\d+)\)/)
  const tests = text.match(/Tests\s+(\d+)\s+passed\s+\((\d+)\)/)
  // Fallback: sum per-file "(N tests)" lines when the summary table is absent.
  const perFile = [...text.matchAll(/\((\d+)\s+tests?\)/g)].map((m) => Number(m[1]))
  const perFileSum = perFile.length > 0 ? perFile.reduce((a, b) => a + b, 0) : null
  return {
    files: files ? Number(files[1]) : perFile.length > 0 ? perFile.length : null,
    filesTotal: files ? Number(files[2]) : perFile.length > 0 ? perFile.length : null,
    tests: tests ? Number(tests[1]) : perFileSum,
    testsTotal: tests ? Number(tests[2]) : perFileSum,
  }
}

const migrationCount = (() => {
  const r = run("npm run db:check")
  const m = r.all.match(/(\d+)\s+migration files OK/)
  return { count: m ? Number(m[1]) : null, exitCode: r.exitCode }
})()

const rlsStatic = run("node --test scripts/rls-tenant-isolation.test.mjs")

const securityGates = run("npm run test:security-gates")
const hardening = run("npm run test:hardening")
const tenancy = run("npm run test:tenancy")
const workflowSafety = run("npm run test:workflow-safety")
const rlsMatrix = run("npm run test:rls-matrix")
const dbAcl = run("npm run test:db-acl")
const routes = run("npm run test:routes")

const dbAclLine = dbAcl.all.match(
  /DB ACL static PASS definer_functions=(\d+) public_grants=(\d+) possible_implicit_public=(\d+) live_check=(\S+)/,
)
const routeLine = routes.all.match(/Route integrity PASS pages=(\d+) nav_links=(\d+) roadmap=(\d+)/)
const securityBanner = securityGates.all.match(/SECURITY GATES PASS cutoff=\S+ migrations=\d+ failures=\d+/)?.[0] ?? null

const evidence = {
  timestamp: new Date().toISOString(),
  git: {
    branch: run("git branch --show-current").all.trim(),
    head: run("git rev-parse HEAD").all.trim(),
  },
  migrationCount,
  suites: {
    "rls-tenant-isolation": { ...parseNodeTestCounts(rlsStatic.all), exitCode: rlsStatic.exitCode },
    "security-gates": {
      ...parseNodeTestCounts(securityGates.all),
      banner: securityBanner,
      exitCode: securityGates.exitCode,
    },
    hardening: { ...parseVitestCounts(hardening.all), exitCode: hardening.exitCode },
    tenancy: { ...parseVitestCounts(tenancy.all), exitCode: tenancy.exitCode },
    "workflow-safety": { ...parseNodeTestCounts(workflowSafety.all), exitCode: workflowSafety.exitCode },
    "rls-matrix": { ...parseNodeTestCounts(rlsMatrix.all), exitCode: rlsMatrix.exitCode },
  },
  dbAcl: dbAclLine
    ? {
        definerFunctions: Number(dbAclLine[1]),
        publicGrants: Number(dbAclLine[2]),
        possibleImplicitPublic: Number(dbAclLine[3]),
        liveCheck: dbAclLine[4],
        exitCode: dbAcl.exitCode,
      }
    : { raw: dbAcl.stdout.trim(), exitCode: dbAcl.exitCode },
  routeIntegrity: routeLine
    ? { pages: Number(routeLine[1]), navLinks: Number(routeLine[2]), roadmap: Number(routeLine[3]), exitCode: routes.exitCode }
    : { raw: routes.stdout.trim(), exitCode: routes.exitCode },
  disposableDb: process.env.SYNAPSE_DISPOSABLE_RESULT
    ? JSON.parse(process.env.SYNAPSE_DISPOSABLE_RESULT)
    : { result: "not_provided", note: "set SYNAPSE_DISPOSABLE_RESULT to a JSON object documenting a disposable-DB run" },
}

mkdirSync(join(root, "artifacts", "readiness"), { recursive: true })
writeFileSync(join(root, "artifacts", "readiness", "evidence.json"), JSON.stringify(evidence, null, 2) + "\n")

// Rewrite only the delimited block in the audit documents; nothing else is
// written. The audit documents must carry the evidence markers or this fails.
const block = renderEvidenceBlock(evidence)
for (const doc of [
  "docs/audits/REMEDIATION_CLOSURE_2026-10-25.md",
  "docs/audits/REMEDIATION_HANDOVER_2026-10-25.md",
]) {
  const docPath = join(root, doc)
  const text = readFileSync(docPath, "utf8")
  writeFileSync(docPath, replaceEvidenceBlock(text, block))
}

process.stdout.write(JSON.stringify(evidence, null, 2) + "\n")
