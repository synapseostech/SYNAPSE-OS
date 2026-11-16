/**
 * Import, roll back, import again — through the real portal and a real database.
 *
 * Uses a history from scripts/tally-fixtures/scale-history.mjs (any size; a
 * small one is enough). Every step goes through the portal's own routes:
 *
 *   1. stage every export file, preview the replay, apply it to completion;
 *   2. read the database: each product holds Tally's closing quantity, the
 *      imported journals balance, customers and suppliers exist;
 *   3. roll the import back: stock returns to zero and every imported
 *      journal is cancelled, so the ledger nets to nothing;
 *   4. import the same files again as a new session: the database ends where
 *      step 2 did — same quantities, same account balances — and the
 *      history screen sees one import in force and one rolled back.
 *
 * Runs only against loopback targets, with the same environment as
 * tally-scale.local.test.mjs. It seeds its own synthetic tenant and leaves it
 * in place (journal entries are immutable). Every value here is invented.
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
  ? `needs ${missing.join(", ")}`
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
    slug: `zz-rollback-${tenantId.slice(0, 8)}`,
    name: "ZZ Rollback Reimport Pharmacy",
    facility_type: "pharmacy",
    status: "active",
    is_active: true,
    is_synthetic: true,
  })
  // The pharmacy administrator role asks for an emailed code at sign-in; a
  // local stack has no mail. A store manager flagged admin reaches the same
  // Tally routes without it, as the scale journey does.
  await insert("profiles", {
    id: profileId,
    tenant_id: tenantId,
    email: EMAIL,
    full_name: "ZZ Rollback Admin",
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
  await insert("pharmacy_profiles", { tenant_id: tenantId, pharmacy_name: "ZZ Rollback Reimport Pharmacy" })
  return { tenantId }
}

const call = (page, path, body, method = "POST") =>
  page.evaluate(
    async ({ path, body, method }) => {
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
      return { status: response.status, body: parsed }
    },
    { path, body, method },
  )

/** Stage every file, preview, and apply to completion. Returns the session id. */
async function importAll(page, files, expected) {
  let sessionId = null
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
  }

  const preview = await call(page, `/api/admin/tally/${sessionId}/preview`, {
    company: expected.company,
    mode: "replay",
    batchExpiry: "not-supplied",
  })
  assert.equal(preview.status, 200, JSON.stringify(preview.body).slice(0, 2000))
  const session = await call(page, `/api/admin/tally/${sessionId}`, undefined, "GET")
  assert.deepEqual(session.body.replay?.blockers ?? [], [], "the replay has blockers")
  const blocking = (session.body.summary?.exceptions ?? []).filter((entry) => entry.severity === "blocking")
  assert.deepEqual(blocking, [], "the plan has blocking exceptions")

  let previous = ""
  for (let guard = 0; guard < 2000; guard += 1) {
    const step = await call(page, `/api/admin/tally/${sessionId}/apply`, {
      acknowledgeUnverified: true,
      acknowledgeReplay: { sequenceConfirmed: true, items: [] },
    })
    assert.equal(step.status, 200, `apply refused: ${JSON.stringify(step.body).slice(0, 1500)}`)
    if (step.body.done) return { sessionId, progress: step.body.progress }
    const position = `${step.body.progress?.stage}:${step.body.progress?.offset}`
    assert.notEqual(position, previous, `apply stopped advancing at ${position}`)
    previous = position
  }
  throw new Error("apply did not finish within 2,000 requests")
}

/** What the database holds for the tenant: stock, imported-ledger balances, parties. */
async function snapshot(tenantId) {
  const products = await readAll(`pharmacy_products?select=name,quantity&tenant_id=eq.${tenantId}`)
  const accounts = await readAll(`pharmacy_accounting_accounts?select=id,code&tenant_id=eq.${tenantId}`)
  const codeOf = new Map(accounts.map((row) => [row.id, row.code]))
  const lines = await readAll(
    `pharmacy_accounting_journal_lines?select=account_id,debit,credit,pharmacy_accounting_journal_entries!inner(source_type)&tenant_id=eq.${tenantId}&pharmacy_accounting_journal_entries.source_type=like.tally*`,
  )
  const balances = {}
  for (const line of lines) {
    const code = codeOf.get(line.account_id) ?? line.account_id
    balances[code] = Math.round(((balances[code] ?? 0) + Number(line.debit) - Number(line.credit)) * 100) / 100
  }
  for (const code of Object.keys(balances)) if (balances[code] === 0) delete balances[code]
  const customers = await readAll(`pharmacy_customers?select=id&tenant_id=eq.${tenantId}`)
  const suppliers = await readAll(`pharmacy_suppliers?select=id&tenant_id=eq.${tenantId}`)
  return {
    quantities: Object.fromEntries(products.map((row) => [row.name, Number(row.quantity)])),
    balances,
    customers: customers.length,
    suppliers: suppliers.length,
  }
}

test("import, roll back and import again through the portal", { skip, timeout: 7_200_000 }, async (t) => {
  const expected = JSON.parse(readFileSync(join(DIR, "expected.json"), "utf8"))
  const files = readdirSync(DIR).filter((name) => /^[23]-.*\.xml$/.test(name)).sort()
  const { tenantId } = await seedAdministrator()
  const closing = Object.fromEntries(expected.items.map((item) => [item.name, item.quantity]))

  const browser = await chromium.launch({ headless: true, executablePath: CHROME })
  const page = await browser.newPage()
  t.after(() => browser.close())

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

  let first = null
  let imported = null

  await t.test("imports the XML history and every product holds Tally's closing quantity", async () => {
    first = await importAll(page, files, expected)
    imported = await snapshot(tenantId)
    const wrong = Object.entries(closing).filter(([name, quantity]) => imported.quantities[name] !== quantity)
    assert.equal(Object.keys(imported.quantities).length, expected.items.length, "one product per stock item")
    assert.deepEqual(wrong.slice(0, 20), [], `${wrong.length} products differ from Tally's closing`)
    assert.ok(Object.keys(imported.balances).length > 0, "the import posted no journals")
    const net = Object.values(imported.balances).reduce((sum, value) => sum + value, 0)
    assert.equal(Math.round(net * 100), 0, "the imported journals do not balance")
    assert.ok(imported.customers + imported.suppliers > 0, "no parties were mapped")
  })

  await t.test("rolls the import back: stock to zero and the imported ledger nets to nothing", async () => {
    const rollback = await call(page, `/api/admin/tally/${first.sessionId}/rollback`, {})
    assert.equal(rollback.status, 200, JSON.stringify(rollback.body).slice(0, 1500))
    assert.equal(rollback.body.done, true)
    const after = await snapshot(tenantId)
    const left = Object.entries(after.quantities).filter(([, quantity]) => quantity !== 0)
    assert.deepEqual(left.slice(0, 20), [], `${left.length} products still hold stock`)
    assert.deepEqual(after.balances, {}, "imported journals still leave a balance")
  })

  await t.test("imports the same files again and lands exactly where the first import did", async () => {
    const second = await importAll(page, files, expected)
    assert.notEqual(second.sessionId, first.sessionId)
    const again = await snapshot(tenantId)
    assert.deepEqual(again.quantities, imported.quantities, "stock differs from the first import")
    assert.deepEqual(again.balances, imported.balances, "account balances differ from the first import")
    assert.equal(again.customers, imported.customers, "customers were duplicated")
    assert.equal(again.suppliers, imported.suppliers, "suppliers were duplicated")
  })

  await t.test("the history screen shows one import in force and one rolled back", async () => {
    const history = await call(page, "/api/admin/tally/history", undefined, "GET")
    assert.equal(history.status, 200, JSON.stringify(history.body).slice(0, 1000))
    const rolledBack = history.body.sessions.filter((session) => session.reversedAt)
    const inForce = history.body.sessions.filter((session) => !session.reversedAt)
    assert.equal(rolledBack.length, 1)
    assert.equal(inForce.length, 1)
    const vouchers = history.body.checks.find((check) => check.id === "vouchers")
    assert.equal(vouchers.status, "match", JSON.stringify(vouchers))
    console.log(JSON.stringify({ tenantId, checks: history.body.checks, reversals: history.body.reversals }, null, 1))
  })
})
