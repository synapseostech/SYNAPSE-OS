#!/usr/bin/env node
/**
 * Rehearses the bridge end to end, without Tally installed.
 *
 * Every other bridge test injects a fake `fetch`. This one does not: it starts a
 * real HTTP listener serving Tally-shaped XML, starts the real connector
 * (`apps/tally-bridge/src/cli.mjs`) as its own process, and drives it with the
 * same envelope, token, Origin and query the browser sends. A failure here is a
 * failure the pharmacy would have hit on the cut-over morning.
 *
 * It also runs the export through the real chunk planner, so "the period is
 * covered exactly once with no gap" is checked against the code that will
 * actually decide what to read.
 *
 * Run it anywhere Node 22.18+ is installed:
 *
 *   node scripts/tally-rehearse.mjs
 *
 * The row parser is TypeScript; a resolver hook below lets plain Node load it,
 * so the parsing steps run the same code the pharmacy imports. On a Node too old
 * for that, those steps are reported as not executed rather than silently
 * skipped.
 */

import { spawn } from "node:child_process"
import { randomBytes } from "node:crypto"
import { existsSync } from "node:fs"
import { createServer, request as httpRequest } from "node:http"
import { registerHooks } from "node:module"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import {
  DEFAULT_FIXTURES,
  loadFixtures,
  startFakeTally,
} from "../apps/tally-bridge/scripts/fake-tally.mjs"

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const BRIDGE_CLI = join(ROOT, "apps/tally-bridge/src/cli.mjs")
const PHARMACY = join(ROOT, "apps/pharmacy")

const ORIGIN = "https://pharm.synapseos.tech"
const DEFAULT_COMPANY = "Synthetic Pharmacy Ltd"
let COMPANY = DEFAULT_COMPANY
let FIXTURES_DIR = DEFAULT_FIXTURES
let FIXTURES

/**
 * A converted capture has had its company name rewritten, so the pin has to come
 * from the fixtures themselves. With a fixed pin the synthetic set would be the
 * only thing this could ever replay.
 */
function companyFromFixtures(fixtures) {
  const raw =
    /<COMPANY\b[^>]*?\bNAME="([^"]{1,400})"/i.exec(fixtures.masters)?.[1] ??
    /<COMPANYNAME>([^<]{1,400})<\/COMPANYNAME>/i.exec(fixtures.masters)?.[1]
  return raw?.trim() || DEFAULT_COMPANY
}
const PERIOD = { from: "2026-01-01", to: "2026-03-31" }
const PARTS = 3

const results = []
let failures = 0

function record(name, ok, detail = "") {
  results.push({ name, ok, detail })
  if (!ok) failures += 1
}

async function check(name, thunk) {
  try {
    const detail = await thunk()
    record(name, true, typeof detail === "string" ? detail : "")
  } catch (error) {
    record(name, false, error instanceof Error ? error.message : String(error))
  }
}

function fail(message) {
  throw new Error(message)
}

function expectEqual(actual, expected, label) {
  if (actual !== expected) fail(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
}

/** A port nothing is listening on yet, for the bridge and the fake to bind. */
function freePort() {
  return new Promise((done, reject) => {
    const probe = createServer()
    probe.once("error", reject)
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address()
      const port = typeof address === "object" && address ? address.port : 0
      probe.close(() => done(port))
    })
  })
}

function call({ port, method = "GET", path, token, origin = ORIGIN, timeoutMs = 15_000 }) {
  return new Promise((done, reject) => {
    const headers = {}
    if (token) headers["x-synapse-tally-bridge-token"] = token
    if (origin) headers.origin = origin
    const request = httpRequest(
      { host: "127.0.0.1", port, method, path, headers },
      (response) => {
        const parts = []
        response.on("data", (part) => parts.push(part))
        response.on("end", () =>
          done({
            status: response.statusCode,
            headers: response.headers,
            body: Buffer.concat(parts).toString("utf8"),
          }),
        )
      },
    )
    request.setTimeout(timeoutMs, () => request.destroy(new Error(`timed out after ${timeoutMs}ms`)))
    request.once("error", reject)
    request.end()
  })
}

function json(body) {
  try {
    return JSON.parse(body)
  } catch {
    return {}
  }
}

/** Waits for the bridge to print the line that means it is accepting requests. */
function waitForReady(child, timeoutMs = 10_000) {
  return new Promise((done, reject) => {
    let seen = ""
    const timer = setTimeout(() => {
      cleanup()
      reject(new Error(`bridge did not start within ${timeoutMs}ms: ${seen.trim() || "no output"}`))
    }, timeoutMs)
    const onData = (chunk) => {
      seen += String(chunk)
      if (/listening at http:\/\/127\.0\.0\.1:\d+/.test(seen)) {
        cleanup()
        done()
      }
    }
    const onExit = (code) => {
      cleanup()
      reject(new Error(`bridge exited with ${code}: ${seen.trim()}`))
    }
    function cleanup() {
      clearTimeout(timer)
      child.stdout.off("data", onData)
      child.stderr.off("data", onData)
      child.off("exit", onExit)
    }
    child.stdout.on("data", onData)
    child.stderr.on("data", onData)
    child.once("exit", onExit)
  })
}

function stopChild(child) {
  return new Promise((done) => {
    if (!child || child.exitCode !== null || child.signalCode !== null) {
      done()
      return
    }
    const timer = setTimeout(() => {
      child.kill("SIGKILL")
      done()
    }, 3_000)
    child.once("exit", () => {
      clearTimeout(timer)
      done()
    })
    child.kill("SIGTERM")
  })
}

/**
 * One bridge process against one fake Tally. Every scenario gets a fresh pair,
 * because a bridge's pin, period default and mutex are all process state and a
 * rehearsal that reuses a process is not rehearsing a cut-over morning.
 */
async function withBridge({ mode = "ok", token = randomBytes(32).toString("hex") }, run) {
  const tallyPort = await freePort()
  const bridgePort = await freePort()
  let fake
  let bridge
  try {
    if (mode !== "unavailable") {
      fake = await startFakeTally({ mode, port: tallyPort, fixtures: FIXTURES })
    }
    bridge = spawn(process.execPath, [BRIDGE_CLI], {
      cwd: ROOT,
      env: {
        ...process.env,
        SYNAPSE_TALLY_BRIDGE_TOKEN: token,
        SYNAPSE_TALLY_ALLOWED_ORIGINS: ORIGIN,
        SYNAPSE_TALLY_TARGET_HOST: "127.0.0.1",
        SYNAPSE_TALLY_TARGET_PORT: String(tallyPort),
        SYNAPSE_TALLY_BRIDGE_PORT: String(bridgePort),
        SYNAPSE_TALLY_COMPANY: COMPANY,
        SYNAPSE_TALLY_EXECUTABLE: "",
      },
      stdio: ["ignore", "pipe", "pipe"],
    })
    await waitForReady(bridge)
    return await run({ port: bridgePort, token })
  } finally {
    await stopChild(bridge)
    if (fake) await fake.close()
  }
}

function exportPath({ scope, from = PERIOD.from, to = PERIOD.to, mode = "opening", company = COMPANY }) {
  const query = new URLSearchParams({
    mode,
    scope,
    from: from.replaceAll("-", ""),
    to: to.replaceAll("-", ""),
  })
  if (company) query.set("company", company)
  return `/api/tally/export?${query.toString()}`
}

function voucherCount(xml) {
  return (xml.match(/<VOUCHER\b/g) ?? []).length
}

function refusalCode(response) {
  return json(response.body).error
}

let chunks = null

/* ------------------------------------------------------------------ planner */

async function loadPlanner() {
  try {
    return await import(join(PHARMACY, "lib/tally/chunks.ts"))
  } catch {
    return null
  }
}

/**
 * Node strips TypeScript types but still resolves specifiers as plain ESM, so
 * `import "./tally-xml"` is not found even though `./tally-xml.ts` is there.
 * Next resolves it, so this is a loader gap rather than a defect in the module.
 * Teaching the one rule here means the rehearsal runs the parser the pharmacy
 * actually ships instead of a copy that could drift from it.
 */
let resolverInstalled = false
function installTypeScriptResolver() {
  if (resolverInstalled) return
  resolverInstalled = true
  registerHooks({
    resolve(specifier, context, nextResolve) {
      try {
        return nextResolve(specifier, context)
      } catch (error) {
        if (!specifier.startsWith(".") || /\.[cm]?[jt]sx?$/.test(specifier)) throw error
        const url = new URL(`${specifier}.ts`, context.parentURL)
        if (!existsSync(fileURLToPath(url))) throw error
        return { url: url.href, shortCircuit: true }
      }
    },
  })
}

async function loadRowParser() {
  installTypeScriptResolver()
  try {
    return await import(join(ROOT, "packages/db/src/tally-xml-rows.ts"))
  } catch {
    return null
  }
}

async function checkPlanner(planner) {
  if (!planner) {
    record("chunk planner", false, "could not load lib/tally/chunks.ts (run with npx tsx)")
    return
  }
  const manifest = planner.createManifest({
    sessionId: "rehearsal",
    company: COMPANY,
    mode: "opening",
    period: PERIOD,
    parts: PARTS,
    updatedAt: new Date().toISOString(),
  })
  chunks = manifest.chunks.filter((chunk) => chunk.kind === "vouchers").map((chunk) => chunk.range)

  const expected = planner.splitPeriod(PERIOD, PARTS)
  expectEqual(JSON.stringify(chunks), JSON.stringify(expected), "chunk ranges")

  if (chunks[0]?.from !== PERIOD.from) fail(`first chunk starts ${chunks[0]?.from}, not ${PERIOD.from}`)
  const last = chunks[chunks.length - 1]
  if (last?.to !== PERIOD.to) fail(`last chunk ends ${last?.to}, not ${PERIOD.to}`)
  for (let index = 1; index < chunks.length; index += 1) {
    const previous = Date.parse(`${chunks[index - 1].to}T00:00:00Z`)
    const current = Date.parse(`${chunks[index].from}T00:00:00Z`)
    if (current - previous !== 86_400_000) fail(`gap or overlap between ${chunks[index - 1].to} and ${chunks[index].from}`)
  }
  const covered = chunks.reduce((total, range) => {
    const days = (Date.parse(`${range.to}T00:00:00Z`) - Date.parse(`${range.from}T00:00:00Z`)) / 86_400_000 + 1
    return total + days
  }, 0)
  const span = (Date.parse(`${PERIOD.to}T00:00:00Z`) - Date.parse(`${PERIOD.from}T00:00:00Z`)) / 86_400_000 + 1
  expectEqual(covered, span, "days covered")
  record("chunk planner", true, `${chunks.length} ranges, ${covered} days, no gap or overlap`)
}

/* ------------------------------------------------------------------- rehearse */

async function rehearseHappyPath() {
  const exportCall = (port, token, params) =>
    call({ port, method: "POST", path: exportPath(params), token })
  let total = 0
  await withBridge({ mode: "ok" }, async ({ port, token }) => {
    const status = await call({ port, path: "/api/tally/status", token })
    await check("status reports the bridge and Tally reachable", async () => {
      expectEqual(status.status, 200, "status code")
      const body = json(status.body)
      expectEqual(body.bridge, "ok", "bridge")
      expectEqual(body.tally, "reachable", "tally")
      expectEqual(body.company, COMPANY, "pinned company")
      return `edition=${body.edition}`
    })

    const companies = await call({ port, path: "/api/tally/companies", token })
    await check("company discovery returns the fixture companies", async () => {
      expectEqual(companies.status, 200, "status code")
      const names = json(companies.body).companies ?? []
      if (!names.includes(COMPANY)) fail(`company list did not include ${COMPANY}`)
      return `${names.length} companies`
    })

    await check("a request without the token is refused", async () => {
      const response = await call({ port, path: "/api/tally/status" })
      expectEqual(response.status, 401, "status code")
      return "401"
    })

    await check("a request from another origin is refused", async () => {
      const response = await call({ port, path: "/api/tally/status", token, origin: "https://elsewhere.example" })
      expectEqual(response.status, 403, "status code")
      return "403"
    })

    await check("a mismatched company is refused before Tally is read", async () => {
      const response = await exportCall(port, token, { scope: "masters", company: "Someone Else" })
      expectEqual(response.status, 422, "status code")
      expectEqual(refusalCode(response), "TALLY_BRIDGE_COMPANY_MISMATCH", "refusal code")
      return "TALLY_BRIDGE_COMPANY_MISMATCH"
    })

    const masters = await exportCall(port, token, { scope: "masters" })
    await check("masters export echoes company, period, mode and scope", async () => {
      expectEqual(masters.status, 200, "status code")
      expectEqual(masters.headers["x-synapse-tally-company"], COMPANY, "company echo")
      expectEqual(masters.headers["x-synapse-tally-from"], "20260101", "from echo")
      expectEqual(masters.headers["x-synapse-tally-to"], "20260331", "to echo")
      expectEqual(masters.headers["x-synapse-tally-mode"], "opening", "mode echo")
      expectEqual(masters.headers["x-synapse-tally-scope"], "masters", "scope echo")
      if (!/<LEDGER\b/.test(masters.body) || !/<STOCKITEM\b/.test(masters.body)) {
        fail("masters export carried no ledgers or stock items")
      }
      if (/<VOUCHER\b/.test(masters.body)) fail("a masters-only export carried vouchers")
      return `${(masters.body.match(/<LEDGER\b/g) ?? []).length} ledgers, ${(masters.body.match(/<STOCKITEM\b/g) ?? []).length} stock items`
    })

    const whole = await exportCall(port, token, { scope: "vouchers" })
    const wholeCount = voucherCount(whole.body)
    await check("the whole-period voucher export reads every voucher", async () => {
      expectEqual(whole.status, 200, "status code")
      expectEqual(whole.headers["x-synapse-tally-scope"], "vouchers", "scope echo")
      if (wholeCount !== 5) fail(`expected 5 synthetic vouchers, read ${wholeCount}`)
      return `${wholeCount} vouchers`
    })

    if (!chunks) {
      record("walking the chunks", false, "the chunk planner did not produce ranges")
      return
    }

    const walked = []
    for (const [index, range] of chunks.entries()) {
      const response = await exportCall(port, token, { scope: "vouchers", ...range })
      if (response.status !== 200) fail(`chunk ${index + 1} (${range.from}..${range.to}) returned ${response.status}: ${refusalCode(response)}`)
      expectEqual(response.headers["x-synapse-tally-from"], range.from.replaceAll("-", ""), `chunk ${index + 1} from echo`)
      expectEqual(response.headers["x-synapse-tally-to"], range.to.replaceAll("-", ""), `chunk ${index + 1} to echo`)
      walked.push({ range, xml: response.body, count: voucherCount(response.body) })
    }
    total = walked.reduce((sum, chunk) => sum + chunk.count, 0)
    await check("walking the chunks reads the whole period exactly once", async () => {
      expectEqual(total, wholeCount, `vouchers across chunks vs one read (${walked.map((chunk) => chunk.count).join(" + ")})`)
      return `${walked.map((chunk) => chunk.count).join(" + ")} = ${total}`
    })

    const parser = await loadRowParser()
    if (!parser) {
      record("row parser", false, "could not load packages/db/src/tally-xml-rows.ts")
      return
    }
    await check("the row parser reads the same records the bridge returned", async () => {
      const document = parser.parseTallyXmlRows(whole.body, "rehearsal-vouchers.xml")
      expectEqual(document.vouchers.length, wholeCount, "parsed vouchers")
      expectEqual(document.company, COMPANY, "parsed company")
      const ledgerLines = document.vouchers.reduce((sum, voucher) => sum + voucher.ledgerLines.length, 0)
      if (ledgerLines < document.vouchers.length) fail("a voucher parsed with no ledger lines")
      return `${document.vouchers.length} vouchers, ${ledgerLines} ledger lines, ${document.warnings.length} warnings`
    })

    await check("the parser reads the masters export", async () => {
      const document = parser.parseTallyXmlRows(masters.body, "rehearsal-masters.xml")
      expectEqual(document.company, COMPANY, "parsed company")
      expectEqual(document.ledgers.length, 7, "parsed ledgers")
      expectEqual(document.stockItems.length, 3, "parsed stock items")
      expectEqual(document.currency, "UGX", "parsed currency")
      return `${document.ledgers.length} ledgers, ${document.stockItems.length} stock items`
    })
  })
}

const FAULTS = [
  {
    mode: "reject",
    expect: "TALLY_BRIDGE_ALL_MASTERS_REJECTED",
    why: "Tally answered STATUS 0",
  },
  {
    mode: "status-missing",
    expect: "TALLY_BRIDGE_ALL_MASTERS_STATUS_MISSING",
    why: "the answer carried no STATUS element",
  },
  {
    mode: "empty",
    expect: "TALLY_BRIDGE_ALL_MASTERS_EMPTY",
    why: "the answer named its company but carried no rows",
  },
  {
    mode: "no-company",
    expect: "TALLY_BRIDGE_COMPANY_UNVERIFIED",
    why: "the answer named no company, so it could be another business's books",
  },
  {
    mode: "unsafe",
    expect: "TALLY_BRIDGE_ALL_MASTERS_UNSAFE_XML",
    why: "the answer carried a DOCTYPE",
  },
  {
    mode: "unavailable",
    expect: "TALLY_BRIDGE_TALLY_UNAVAILABLE",
    why: "nothing was listening on the Tally port",
  },
  {
    mode: "slow",
    expect: "TALLY_BRIDGE_TALLY_TIMEOUT",
    why: "Tally accepted the request and never answered",
  },
]

async function rehearseFault(fault) {
  await withBridge({ mode: fault.mode }, async ({ port, token }) => {
    const timeoutMs = fault.mode === "slow" ? 90_000 : 15_000
    const response = await call({ port, method: "POST", path: exportPath({ scope: "masters" }), token, timeoutMs })
    await check(`fault ${fault.mode} refuses with ${fault.expect}`, async () => {
      expectEqual(refusalCode(response), fault.expect, `refusal code`)
      if (response.status === 200) fail("a fault mode returned a payload")
      return `${response.status} ${fault.expect} — ${fault.why}`
    })
  })
}

async function rehearseCompanyListFaults() {
  for (const [mode, expected] of [
    ["reject", "TALLY_BRIDGE_COMPANIES_REJECTED"],
    ["status-missing", "TALLY_BRIDGE_COMPANIES_STATUS_MISSING"],
    ["empty", "TALLY_BRIDGE_COMPANIES_EMPTY"],
    ["unsafe", "TALLY_BRIDGE_COMPANIES_UNSAFE_XML"],
  ]) {
    await withBridge({ mode }, async ({ port, token }) => {
      const response = await call({ port, path: "/api/tally/companies", token })
      await check(`fault ${mode} refuses the company list with ${expected}`, async () => {
        expectEqual(refusalCode(response), expected, "refusal code")
        return `${response.status} ${expected}`
      })
    })
  }
}

/* ----------------------------------------------------------------------- main */

function print() {
  const width = Math.max(...results.map((entry) => entry.name.length), 10)
  console.log("")
  for (const entry of results) {
    console.log(`${entry.ok ? "PASS" : "FAIL"}  ${entry.name.padEnd(width)}  ${entry.detail}`)
  }
  console.log("")
  console.log(`${results.filter((entry) => entry.ok).length} passed, ${failures} failed`)
  console.log(`fixtures: ${FIXTURES_DIR}`)
  console.log("This rehearses the connector, not Tally itself: no real books were read.")
}

async function main() {
  // The pharmacy package has no "type": "module", so importing its .ts planner
  // prints a module-type warning that says nothing about this rehearsal.
  process.removeAllListeners("warning")
  process.on("warning", (warning) => {
    if (warning.code === "MODULE_TYPELESS_PACKAGE_JSON") return
    console.error(`warning: ${warning.message}`)
  })

  FIXTURES_DIR = process.env.SYNAPSE_FAKE_TALLY_FIXTURES?.trim() || DEFAULT_FIXTURES
  FIXTURES = await loadFixtures(FIXTURES_DIR)
  COMPANY = companyFromFixtures(FIXTURES)

  console.log(`Rehearsing the Tally bridge against fixtures in ${FIXTURES_DIR}`)
  console.log(`period ${PERIOD.from}..${PERIOD.to}, ${PARTS} voucher chunks, company "${COMPANY}"`)
  console.log("")

  const planner = await loadPlanner()
  await checkPlanner(planner)

  await rehearseHappyPath()
  await rehearseCompanyListFaults()
  for (const fault of FAULTS) {
    if (fault.mode === "slow") console.log("… waiting up to 60s for the bridge export timeout")
    await rehearseFault(fault)
  }

  print()
  process.exitCode = failures === 0 ? 0 : 1
}

main().catch((error) => {
  console.error("Rehearsal could not run:", error instanceof Error ? error.stack : error)
  process.exitCode = 1
})
