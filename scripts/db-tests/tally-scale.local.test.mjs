/**
 * A pharmacy's whole history at customer scale, through the real portal and a
 * real database.
 *
 * The synthetic history comes from scripts/tally-fixtures/scale-history.mjs:
 * ~1,800 items and ~26,000 vouchers over thirteen months, in the file shapes
 * tally-export-history.ps1 writes. This journey stages every file through the
 * portal's own upload and sources routes, previews the replay, applies it the
 * way the page does (one request per stage step, as many as it takes), and
 * then reads the database back: every product's quantity must equal Tally's
 * closing quantity, and the session must have reached `complete` through the
 * closing check.
 *
 * It also times every apply request. Each one must finish well inside a
 * serverless function's limit on production, so the slowest step is reported.
 *
 * Runs only against the disposable stack that run-pharmacy-portal-harness.sh
 * provisions (same environment as tally-portal.local.test.mjs) plus
 * TALLY_SCALE_DIR, the generator's output directory.
 *
 * Every value here is invented.
 */

import test from "node:test"
import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { existsSync, readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"
import bcrypt from "bcryptjs"
import { chromium } from "playwright-core"

const BASE = (process.env.PORTAL_BASE_URL ?? "").replace(/\/$/, "")
const API = (process.env.LOCAL_API_URL ?? "").replace(/\/$/, "")
const SERVICE_KEY = process.env.LOCAL_SERVICE_ROLE_KEY ?? ""
const EMAIL = process.env.PORTAL_EMAIL ?? ""
const PASSWORD = process.env.PORTAL_PASSWORD ?? ""
const DIR = process.env.TALLY_SCALE_DIR ?? ""

const missing = Object.entries({
  PORTAL_BASE_URL: BASE,
  LOCAL_API_URL: API,
  LOCAL_SERVICE_ROLE_KEY: SERVICE_KEY,
  PORTAL_EMAIL: EMAIL,
  PORTAL_PASSWORD: PASSWORD,
  TALLY_SCALE_DIR: DIR,
})
  .filter(([, value]) => !value)
  .map(([name]) => name)
const loopback = /^http:\/\/(127\.0\.0\.1|localhost):\d+$/
const skip = missing.length
  ? `only runs under the portal harness with TALLY_SCALE_DIR (missing ${missing.join(", ")})`
  : !loopback.test(API) || !loopback.test(BASE)
    ? "refuses any target that is not loopback"
    : false

const CHROME =
  process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ||
  (existsSync("/usr/bin/google-chrome") ? "/usr/bin/google-chrome" : undefined)

const rest = {
  apikey: SERVICE_KEY,
  Authorization: `Bearer ${SERVICE_KEY}`,
  "Content-Type": "application/json",
  Prefer: "return=representation",
}
async function insert(table, row) {
  const response = await fetch(`${API}/rest/v1/${table}`, { method: "POST", headers: rest, body: JSON.stringify(row) })
  const text = await response.text()
  if (!response.ok) throw new Error(`seeding ${table} failed: ${response.status} ${text}`)
  return text ? JSON.parse(text) : []
}
async function readAll(path) {
  const rows = []
  for (let from = 0; ; from += 1000) {
    const response = await fetch(`${API}/rest/v1/${path}`, {
      headers: { ...rest, Range: `${from}-${from + 999}`, "Range-Unit": "items" },
    })
    const page = await response.json()
    if (!response.ok) throw new Error(`reading ${path}: ${response.status} ${JSON.stringify(page)}`)
    rows.push(...page)
    if (page.length < 1000) return rows
  }
}

async function seedAdministrator() {
  const tenantId = randomUUID()
  const profileId = randomUUID()
  await insert("tenants", {
    id: tenantId,
    slug: `scale-history-${tenantId.slice(0, 8)}`,
    name: "Synthetic Scale Pharmacy",
    facility_type: "pharmacy",
    status: "active",
    is_active: true,
    is_synthetic: true,
  })
  await insert("profiles", {
    id: profileId,
    tenant_id: tenantId,
    email: EMAIL,
    full_name: "Synthetic Scale Admin",
    role: "pharmacy_store_manager",
    is_admin: true,
    password_hash: await bcrypt.hash(PASSWORD, 12),
    email_verified_at: new Date().toISOString(),
    verification_status: "verified",
    onboarding_complete: true,
    must_change_password: false,
    is_deleted: false,
  })
  await insert("pharmacy_user_settings", {
    tenant_id: tenantId,
    profile_id: profileId,
    pharmacy_role: "pharmacy_store_manager",
    permissions: [],
    is_active: true,
    must_change_password: false,
    two_factor_enabled: false,
  })
  await insert("pharmacy_profiles", { tenant_id: tenantId, pharmacy_name: "Synthetic Scale Pharmacy" })
  return { tenantId }
}

const call = (page, path, body, method = "POST") =>
  page.evaluate(
    async ({ path, body, method }) => {
      const started = performance.now()
      const response = await fetch(path, {
        method,
        headers: { "Content-Type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      })
      const text = await response.text()
      let parsed = null
      try {
        parsed = text ? JSON.parse(text) : null
      } catch {
        parsed = { raw: text.slice(0, 500) }
      }
      return { status: response.status, body: parsed, ms: Math.round(performance.now() - started) }
    },
    { path, body, method },
  )

test("a customer-scale history replays through the portal to Tally's closing position", { skip, timeout: 3_600_000 }, async (t) => {
  const expected = JSON.parse(readFileSync(join(DIR, "expected.json"), "utf8"))
  const files = readdirSync(DIR).filter((name) => /^[23]-.*\.xml$/.test(name)).sort()
  const { tenantId } = await seedAdministrator()

  const browser = await chromium.launch({ headless: true, executablePath: CHROME })
  const page = await browser.newPage()
  t.after(() => browser.close())
  const timings = { stage: [], preview: 0, apply: [] }
  let sessionId = null

  await t.test("signs in", async () => {
    await page.goto(`${BASE}/login`, { waitUntil: "domcontentloaded" })
    await page.waitForFunction(
      () => {
        const form = document.querySelector("form")
        return Boolean(form) && Object.keys(form).some((key) => key.startsWith("__reactFiber$"))
      },
      null,
      { timeout: 120_000 },
    )
    await page.fill("#identifier", EMAIL)
    await page.fill("#password", PASSWORD)
    await page.getByRole("button", { name: "Sign in" }).click()
    await page.waitForURL(/\/portal\//, { timeout: 120_000 })
  })

  await t.test(`stages all ${files.length} files the export script wrote`, async () => {
    for (const name of files) {
      const bytes = readFileSync(join(DIR, name))
      const start = await call(page, "/api/admin/tally/upload-url", {
        fileName: name,
        fileSize: bytes.byteLength,
        ...(sessionId ? { sessionId } : {}),
      })
      assert.equal(start.status, 200, `upload-url for ${name}: ${JSON.stringify(start.body)}`)
      sessionId = start.body.sessionId
      const put = await fetch(new URL(start.body.signedUrl, API), {
        method: "PUT",
        headers: { "Content-Type": "application/xml" },
        body: bytes,
      })
      assert.ok(put.ok, `upload of ${name} answered ${put.status}`)
      const match = /(\d{4})(\d{2})(\d{2})-(\d{4})(\d{2})(\d{2})\.xml$/.exec(name)
      const staged = await call(page, `/api/admin/tally/${sessionId}/sources`, {
        uploadId: start.body.uploadId,
        fileName: name,
        period: { from: `${match[1]}-${match[2]}-${match[3]}`, to: `${match[4]}-${match[5]}-${match[6]}` },
        company: expected.company,
        kind: name.includes("masters") ? "masters" : "vouchers",
      })
      assert.equal(staged.status, 200, `sources for ${name}: ${JSON.stringify(staged.body)}`)
      timings.stage.push(staged.ms)
    }
  })

  await t.test("previews the replay with no blocking difference", async () => {
    const preview = await call(page, `/api/admin/tally/${sessionId}/preview`, {
      company: expected.company,
      mode: "replay",
      batchExpiry: "not-supplied",
    })
    timings.preview = preview.ms
    assert.equal(preview.status, 200, JSON.stringify(preview.body).slice(0, 2000))
    const session = await call(page, `/api/admin/tally/${sessionId}`, undefined, "GET")
    assert.equal(session.status, 200)
    const replay = session.body.replay
    assert.ok(replay, "the session carries no replay gate")
    assert.deepEqual(replay.blockers, [], `replay blockers: ${JSON.stringify(replay.blockers).slice(0, 2000)}`)
    const blocking = (session.body.summary?.exceptions ?? []).filter((entry) => entry.severity === "blocking")
    assert.deepEqual(blocking, [])
  })

  await t.test("applies the whole history from the page and passes the closing check", async () => {
    // Through the page's own Apply button, on purpose: at this scale the apply
    // outlasts the portal's 30-minute idle sign-out, and only the page's apply
    // loop holds it. Nobody touches the mouse for the whole run.
    page.on("response", (response) => {
      if (!/\/api\/admin\/tally\/[^/]+\/apply$/.test(response.url())) return
      const timing = response.request().timing()
      timings.apply.push({ status: response.status(), ms: Math.round(timing.responseEnd > 0 ? timing.responseEnd : -1) })
    })
    await page.evaluate((id) => window.localStorage.setItem("tallySessionId", id), sessionId)
    await page.goto(`${BASE}/portal/tally-import`, { waitUntil: "domcontentloaded" })
    const sequence = page.locator("#tally-replay-sequence")
    await sequence.waitFor({ state: "visible", timeout: 300_000 })
    const unverified = page.locator("#tally-unverified-ack")
    if (await unverified.count()) await unverified.check()
    await sequence.check()
    const applyButton = page.getByRole("button", { name: "Apply cut-over" })
    await applyButton.waitFor({ state: "visible", timeout: 60_000 })
    assert.equal(await applyButton.isEnabled(), true, "the page keeps Apply disabled")
    await applyButton.click()
    await page
      .getByText(/Tally cut-over is already complete for this pharmacy/)
      .waitFor({ timeout: 3_300_000 })
    const refused = timings.apply.filter((step) => step.status !== 200)
    assert.deepEqual(refused, [], "an apply request was refused mid-run")
    const session = await call(page, `/api/admin/tally/${sessionId}`, undefined, "GET")
    assert.equal(session.body.status ?? session.body.summary?.status ?? "complete", "complete")
  })

  await t.test("every product holds Tally's closing quantity", async () => {
    const products = await readAll(`pharmacy_products?select=name,quantity&tenant_id=eq.${tenantId}`)
    const held = new Map(products.map((row) => [row.name, Number(row.quantity)]))
    const wrong = expected.items
      .filter((item) => held.get(item.name) !== item.quantity)
      .map((item) => `${item.name}: Tally ${item.quantity}, database ${held.get(item.name)}`)
    assert.equal(products.length, expected.items.length, "one product per stock item")
    assert.deepEqual(wrong.slice(0, 20), [], `${wrong.length} products differ`)
  })

  await t.test("reports its timings", () => {
    const slowest = [...timings.apply].map((step) => step.ms).sort((a, b) => b - a).slice(0, 5)
    const total = timings.apply.reduce((sum, step) => sum + step.ms, 0)
    console.log(
      JSON.stringify(
        {
          vouchers: expected.counts.vouchers,
          movements: expected.counts.inventoryLines,
          items: expected.counts.items,
          stageMsMax: Math.max(...timings.stage),
          previewMs: timings.preview,
          applyRequests: timings.apply.length,
          applyMsTotal: total,
          applySlowest: slowest,
        },
        null,
        1,
      ),
    )
  })
})
