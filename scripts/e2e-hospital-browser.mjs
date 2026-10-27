#!/usr/bin/env node
import { chromium } from "playwright"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"

const base = process.env.PLAYWRIGHT_BASE_URL || process.env.SYNAPSE_E2E_BASE_URL
const outDir = join(process.cwd(), "artifacts/readiness")
mkdirSync(outDir, { recursive: true })

// A smoke test with no target has verified nothing. Writing BLOCKED and exiting
// 0 would let a pipeline report success for a browser surface that was never
// opened, so the default is to fail. Local runs that deliberately skip the
// browser can opt out explicitly with SYNAPSE_E2E_SMOKE_ALLOW_BLOCKED=1.
if (!base) {
  const allowBlocked = process.env.SYNAPSE_E2E_SMOKE_ALLOW_BLOCKED === "1"
  writeFileSync(join(outDir, "hospital-browser-journey.json"), JSON.stringify({
    status: "BLOCKED",
    reason: "SYNAPSE_E2E_BASE_URL not configured",
    journey: "hospital-browser-unauthenticated-smoke",
    explicitly_allowed: allowBlocked,
    generated_at: new Date().toISOString(),
  }, null, 2))
  const message = [
    "Hospital browser surface smoke BLOCKED: neither PLAYWRIGHT_BASE_URL nor SYNAPSE_E2E_BASE_URL is set,",
    "so no browser surface was verified.",
    allowBlocked
      ? "SYNAPSE_E2E_SMOKE_ALLOW_BLOCKED=1 is set, treating this local run as an intentional skip."
      : "Refusing to report success. Set a target URL to run the smoke, or set",
    allowBlocked ? "" : "SYNAPSE_E2E_SMOKE_ALLOW_BLOCKED=1 for a local run that intentionally skips it.",
  ].filter(Boolean).join(" ")
  console.error(message)
  process.exit(allowBlocked ? 0 : 1)
}

const browser = await chromium.launch()
const page = await browser.newPage()
const failures = []

async function check(name, fn) {
  try {
    await fn()
    console.log(`PASS ${name}`)
  } catch (error) {
    failures.push({ name, error: error instanceof Error ? error.message : String(error) })
    console.error(`FAIL ${name}`, error)
  }
}

await check("login_not_coming_soon", async () => {
  const res = await page.goto(`${base}/login`, { waitUntil: "domcontentloaded" })
  if (!res || res.status() >= 500) throw new Error(`login HTTP ${res?.status()}`)
  const body = await page.textContent("body")
  if (body?.includes("Coming soon.")) throw new Error("login is a coming-soon stub")
})

await check("unauthorized_page", async () => {
  await page.goto(`${base}/unauthorized`, { waitUntil: "domcontentloaded" })
  const body = await page.textContent("body")
  if (body?.includes("Coming soon.")) throw new Error("unauthorized is a coming-soon stub")
  if (!/access denied/i.test(body ?? "")) throw new Error("unauthorized heading missing")
})

await browser.close()
const status = failures.length ? "FAIL" : "PASS"
writeFileSync(join(outDir, "hospital-browser-journey.json"), JSON.stringify({
  status,
  base,
  auth: "unauthenticated-surface-only",
  failures,
  generated_at: new Date().toISOString(),
}, null, 2))
if (failures.length) process.exit(1)
console.log("Hospital browser surface smoke PASS")
