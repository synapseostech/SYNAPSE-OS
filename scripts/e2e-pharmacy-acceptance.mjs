#!/usr/bin/env node
/**
 * Runner for the pharmacy browser acceptance suites.
 *
 * Two layers, reported separately and never merged:
 *
 *   smoke        environment-independent. Proves the anonymous edge of the
 *                deployment: real sign-in form, every operational route gated,
 *                admin API answers JSON, security headers served. Runs anywhere.
 *
 *   operations   signed-in journeys on a disposable tenant: sale, refund,
 *                session expiry, tenant isolation, receipt printing, no Tally
 *                dependency. Runs only on the Windows acceptance host.
 *
 * Exit codes:
 *   0  every layer that could run passed
 *   1  a layer that ran failed
 *   2  the target or configuration was refused (production, placeholder, bad URL)
 *   3  nothing could run here — the report says why
 *
 * This script never starts against production: resolvePharmacyTarget throws
 * before a browser is launched.
 */

import { spawnSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { chromium } from "playwright-core"
import {
  NOT_RUN_WINDOWS,
  pharmacyCredentials,
  resolvePharmacyTarget,
} from "./e2e-pharmacy-target.mjs"

const CONFIG = "playwright.pharmacy.config.ts"

function parseArgs(argv) {
  const mode = argv.find((arg) => ["smoke", "operations", "all"].includes(arg)) ?? "all"
  return { mode, headed: argv.includes("--headed") }
}

async function probe(label, launchOptions) {
  try {
    const browser = await chromium.launch({ ...launchOptions, timeout: 30_000 })
    await browser.close()
    return { label, ok: true }
  } catch (error) {
    const message = String(error?.message ?? error).split("\n")[0]
    return { label, ok: false, reason: message }
  }
}

async function resolveBrowsers() {
  const executable = (process.env.SYNAPSE_PHARMACY_E2E_CHROMIUM_EXECUTABLE ?? "").trim()
  const channel = (process.env.SYNAPSE_PHARMACY_E2E_CHROME_CHANNEL ?? "chrome").trim()

  const chrome = executable
    ? await probe("chrome (executable)", { executablePath: executable })
    : channel === "chromium"
      ? await probe("chrome (bundled chromium)", {})
      : await probe("chrome (installed)", { channel: "chrome" })

  const fallback = chrome.ok || executable || channel === "chromium"
    ? null
    : await probe("chrome (bundled chromium)", {})

  const edge = await probe("edge (installed)", { channel: "msedge" })
  return { chrome, fallback, edge }
}

function readReport(path) {
  if (!existsSync(path)) return null
  try {
    return JSON.parse(readFileSync(path, "utf8"))
  } catch {
    return null
  }
}

function counts(report) {
  const stats = report?.stats
  if (!stats) return null
  return {
    passed: stats.expected ?? 0,
    failed: stats.unexpected ?? 0,
    skipped: stats.skipped ?? 0,
    flaky: stats.flaky ?? 0,
  }
}

/** Every distinct reason a test in this report declined to run. */
function skipReasons(report) {
  const reasons = new Set()
  const walk = (suites) => {
    for (const suite of suites ?? []) {
      for (const spec of suite.specs ?? []) {
        for (const test of spec.tests ?? []) {
          for (const annotation of test.annotations ?? []) {
            if (annotation.type === "skip" && annotation.description) reasons.add(annotation.description)
          }
        }
      }
      walk(suite.suites)
    }
  }
  walk(report?.suites)
  return [...reasons]
}

function runPlaywright(project, grepFile, outputFile, headed) {
  const env = { ...process.env, PLAYWRIGHT_JSON_OUTPUT_NAME: outputFile }
  const args = [
    "playwright",
    "test",
    `--config=${CONFIG}`,
    `--project=${project}`,
    // Naming the reporter on the command line is what lets
    // PLAYWRIGHT_JSON_OUTPUT_NAME choose the per-layer report file.
    "--reporter=list,json",
    grepFile,
    ...(headed ? ["--headed"] : []),
  ]
  const result = spawnSync("npx", args, { stdio: "inherit", env, shell: process.platform === "win32" })
  return result.status ?? 1
}

async function main() {
  const { mode, headed } = parseArgs(process.argv.slice(2))

  let target
  try {
    target = resolvePharmacyTarget()
  } catch (error) {
    console.error(String(error.message))
    console.error(
      "\nPHARMACY_E2E: refused before launching a browser. Point SYNAPSE_PHARMACY_E2E_BASE_URL at a disposable deployment.",
    )
    process.exit(2)
  }

  const onWindows = process.platform === "win32" || process.env.SYNAPSE_PHARMACY_E2E_ALLOW_NON_WINDOWS === "1"

  console.log("PHARMACY E2E PREFLIGHT")
  console.log(`  platform:        ${process.platform}`)
  console.log(`  target:          ${target.mode.toUpperCase()} ${target.baseURL}`)
  console.log(`  managed server:  ${target.startWebServer ? target.startCommand : "no (external)"}`)
  console.log(`  credentials:     ${pharmacyCredentials() ? "present" : "absent"}`)
  console.log(`  operations:      ${onWindows ? "eligible" : NOT_RUN_WINDOWS}`)
  console.log("")

  const browsers = await resolveBrowsers()
  const available = []
  if (browsers.chrome.ok || browsers.fallback?.ok) available.push("chrome")
  if (browsers.edge.ok) available.push("edge")

  for (const entry of [browsers.chrome, browsers.fallback, browsers.edge]) {
    if (!entry) continue
    console.log(
      entry.ok ? `  browser ${entry.label}: available` : `  browser ${entry.label}: NOT AVAILABLE — ${entry.reason}`,
    )
  }
  console.log("")

  if (!browsers.chrome.ok && browsers.fallback?.ok) {
    // The config must be told to use Playwright's own build instead of the
    // installed channel that just failed.
    process.env.SYNAPSE_PHARMACY_E2E_CHROME_CHANNEL = "chromium"
  }

  const results = []
  let status = 0

  if (available.length === 0) {
    console.error("PHARMACY_E2E: no browser could be launched on this host.")
    console.error("  Install Chrome or Edge, or run: npx playwright install chromium")
    results.push({ layer: "smoke", outcome: "NOT RUN — NO BROWSER AVAILABLE" })
    results.push({ layer: "operations", outcome: NOT_RUN_WINDOWS })
    report(results)
    process.exit(3)
  }

  if (mode === "all" || mode === "smoke") {
    for (const project of available) {
      const outputFile = `test-results/pharmacy-smoke-${project}.json`
      const code = runPlaywright(project, "pharmacy-smoke", outputFile, headed)
      const parsed = readReport(outputFile)
      results.push({
        layer: `smoke/${project}`,
        outcome: code === 0 ? "PASS" : "FAIL",
        ...(counts(parsed) ?? {}),
        skipReasons: skipReasons(parsed),
      })
      if (code !== 0) status = 1
    }
  }

  if (mode === "all" || mode === "operations") {
    if (!onWindows) {
      results.push({ layer: "operations", outcome: NOT_RUN_WINDOWS })
    } else if (!pharmacyCredentials()) {
      results.push({ layer: "operations", outcome: "NOT RUN — DISPOSABLE ACCEPTANCE TENANT CREDENTIALS REQUIRED" })
    } else {
      for (const project of available) {
        const outputFile = `test-results/pharmacy-operations-${project}.json`
        const code = runPlaywright(project, "pharmacy-acceptance", outputFile, headed)
        const parsed = readReport(outputFile)
        results.push({
          layer: `operations/${project}`,
          outcome: code === 0 ? "PASS" : "FAIL",
          ...(counts(parsed) ?? {}),
          skipReasons: skipReasons(parsed),
        })
        if (code !== 0) status = 1
      }
    }
  }

  report(results)
  process.exit(status)
}

function report(results) {
  console.log("")
  console.log("PHARMACY E2E EVIDENCE")
  for (const result of results) {
    const tally =
      result.passed === undefined
        ? ""
        : ` (${result.passed} passed, ${result.failed ?? 0} failed, ${result.skipped ?? 0} skipped)`
    console.log(`  ${result.layer.padEnd(20)} ${result.outcome}${tally}`)
    for (const reason of result.skipReasons ?? []) {
      console.log(`  ${"".padEnd(20)}   ${reason}`)
    }
  }
  console.log("")
  console.log(
    "  A smoke PASS says the deployment's anonymous edge is correct. It is not",
  )
  console.log(
    "  operational acceptance: only operations/* on the Windows host produces that.",
  )
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
