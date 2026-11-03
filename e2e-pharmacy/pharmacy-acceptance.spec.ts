import { expect, test, type Page } from "playwright/test"
import {
  acceptanceBlocker,
  acceptanceCredentials,
  authedJson,
  expectNoForbiddenEndpoints,
  probeProduct,
  signIn,
  signOut,
  tenantBCredentials,
  watchForbiddenEndpoints,
  NOT_RUN_TENANT_B,
} from "./helpers"

/**
 * Operational acceptance for a first-customer cut-over.
 *
 * Every test here needs a running deployment AND a disposable tenant with at
 * least one sellable product. That combination only exists on the Windows
 * acceptance host, so on any other host the whole file reports
 * "NOT RUN — WINDOWS HOST REQUIRED" rather than passing vacuously.
 *
 * These tests create real sales and real refunds in the tenant they run
 * against. Run them only against the disposable acceptance tenant
 * (scripts/e2e-acceptance-isolation.mjs refuses the production project).
 */

const blocker = acceptanceBlocker()

const OPERATIONAL_PAGES: Array<{ path: string; heading: RegExp }> = [
  { path: "/portal/dashboard", heading: /dashboard|overview/i },
  { path: "/portal/pos", heading: /^Point of Sale$/ },
  { path: "/portal/refunds", heading: /refunds & returns/i },
  { path: "/portal/inventory", heading: /inventory/i },
  { path: "/portal/purchases", heading: /purchase/i },
  { path: "/portal/suppliers", heading: /supplier/i },
  { path: "/portal/customers", heading: /customer/i },
  { path: "/portal/credit-ledger", heading: /credit/i },
  { path: "/portal/reports", heading: /report/i },
  { path: "/portal/till", heading: /till|reconcil/i },
  { path: "/portal/transactions", heading: /transaction|sale/i },
]

/** A name no previous run can have used, so ledger lookups stay exact. */
function uniqueSuffix() {
  return Math.random().toString(36).slice(2, 8)
}

type TransactionRow = {
  id: string
  transactionNo: string
  clientName: string | null
  paymentMethod: string
  discount: number
}

type CreditEntry = {
  type: string
  balance_after: number | string
  customer: { name: string } | null
}

/** Open the POS and put the first sellable product in the cart. */
async function openPosWithOneItem(page: Page) {
  await page.goto("/portal/pos")
  await expect(page.getByRole("heading", { name: "Point of Sale", exact: true })).toBeVisible()

  const product = probeProduct()
  if (product) await page.getByLabel("Product search").fill(product)

  const addToCart = page.getByRole("button", { name: /^Add .+ to cart/ }).first()
  await expect(addToCart, "the acceptance tenant needs at least one sellable product").toBeVisible()
  await addToCart.click()
}

/**
 * Submit the cart and dismiss the receipt prompt.
 *
 * A credit sale, or a cash sale tendered below the total, opens the Client
 * Details dialog first; `clientName` is required in that case.
 */
async function finishSale(page: Page, clientName?: string) {
  const complete = page.getByRole("button", { name: /Complete Sale/ })
  await expect(complete).toBeEnabled()
  await complete.click()

  const clientDialog = page.getByRole("heading", { name: "Client Details" })
  const printPrompt = page.getByText("Print Receipt?")
  await expect(
    clientDialog.or(printPrompt),
    "the sale must reach the receipt step or ask for client details",
  ).toBeVisible({ timeout: 90_000 })

  if (await clientDialog.isVisible().catch(() => false)) {
    if (!clientName) throw new Error("This sale needs a client name; pass one to finishSale().")
    await page.getByLabel("Client Name").fill(clientName)
    await page.getByRole("button", { name: /^Proceed$/ }).click()
    await expect(printPrompt, "the sale must reach the receipt step").toBeVisible({ timeout: 90_000 })
  }

  // "Skip Printing" when the policy allows it, otherwise the documented
  // printer-unavailable path. Neither claims a physical receipt.
  await page.getByRole("button", { name: /Skip Printing|Printer unavailable/ }).first().click()
  await expect(printPrompt).toBeHidden()
}

/** Complete a cash sale through the POS form and dismiss the receipt prompt. */
async function completeCashSale(page: Page) {
  await openPosWithOneItem(page)
  await expect(page.getByLabel("Payment Method")).toHaveValue("CASH")
  // A cash tendered above the total exercises change as well as payment.
  await page.getByPlaceholder("Enter amount paid").fill("99999999")
  await finishSale(page)
}

async function latestTransaction(page: Page) {
  const { status, json } = await authedJson<{ transactions: TransactionRow[] }>(
    page,
    "/api/admin/transactions",
  )
  expect(status).toBe(200)
  expect(json.transactions.length, "the tenant must already have sales").toBeGreaterThan(0)
  return json.transactions[0]
}

async function creditLedger(page: Page) {
  const { status, json } = await authedJson<{ entries: CreditEntry[] }>(page, "/api/admin/credit-ledger")
  expect(status).toBe(200)
  return json.entries
}

/** The credit entry this sale posted for `customerName`, if any. */
async function creditEntryFor(page: Page, customerName: string) {
  const entries = await creditLedger(page)
  return entries.find((entry) => entry.customer?.name === customerName && entry.type === "credit")
}

test.describe("pharmacy operator acceptance", () => {
  test.skip(blocker !== null, blocker ?? "")

  test("signing in reaches the portal shell", async ({ page }) => {
    await signIn(page, acceptanceCredentials()!)
    await expect(page).toHaveURL(/\/portal\//)
    await expect(page.getByRole("button", { name: /Sign Out/i })).toBeVisible()
  })

  test("an expired session is sent back to sign-in", async ({ page, context }) => {
    await signIn(page, acceptanceCredentials()!)
    await page.goto("/portal/dashboard")
    await expect(page).toHaveURL(/\/portal\/dashboard/)

    await context.clearCookies()
    await page.goto("/portal/dashboard")
    await expect(page).toHaveURL(/\/login/)
  })

  test("signing out ends the session", async ({ page }) => {
    await signIn(page, acceptanceCredentials()!)
    await signOut(page)
    await page.goto("/portal/pos")
    await expect(page).toHaveURL(/\/login/)
  })

  test("every operational page renders for a signed-in operator", async ({ page }) => {
    const errors: string[] = []
    page.on("pageerror", (error) => errors.push(error.message))
    await signIn(page, acceptanceCredentials()!)

    for (const { path, heading } of OPERATIONAL_PAGES) {
      const response = await page.goto(path)
      expect(response?.status(), `${path} status`).toBe(200)
      await expect(page, `${path} must not bounce to sign-in`).toHaveURL(new RegExp(`${path}$`))
      await expect(
        page.getByRole("heading", { name: heading }).first(),
        `${path} must render its heading`,
      ).toBeVisible()
    }

    expect(errors, "operational pages must not raise uncaught client errors").toEqual([])
  })

  test("a cash sale completes without Tally or the bridge", async ({ page }) => {
    await signIn(page, acceptanceCredentials()!)
    const forbidden = watchForbiddenEndpoints(page)

    await completeCashSale(page)
    expectNoForbiddenEndpoints(forbidden)

    // The sale must be readable back through the same session.
    const latest = await latestTransaction(page)
    expect(latest.transactionNo).toBeTruthy()
  })

  test("a credit sale records a receivable on the customer account", async ({ page }) => {
    await signIn(page, acceptanceCredentials()!)
    const customer = `Acceptance Credit ${uniqueSuffix()}`

    await openPosWithOneItem(page)
    await page.getByLabel("Payment Method").selectOption("CREDIT")
    await expect(page.getByLabel("Payment Method")).toHaveValue("CREDIT")
    await finishSale(page, customer)

    const latest = await latestTransaction(page)
    expect(latest.paymentMethod, "the sale must be recorded as credit").toBe("CREDIT")

    const entry = await creditEntryFor(page, customer)
    expect(entry, "a credit sale must post to the customer's ledger").toBeTruthy()
    expect(Number(entry?.balance_after)).toBeGreaterThan(0)
  })

  test("a partial payment records the balance due against the customer", async ({ page }) => {
    await signIn(page, acceptanceCredentials()!)
    const customer = `Acceptance Partial ${uniqueSuffix()}`

    await openPosWithOneItem(page)
    await expect(page.getByLabel("Payment Method")).toHaveValue("CASH")
    await page.getByPlaceholder("Enter amount paid").fill("0.01")
    await expect(
      page.getByText(/BALANCE DUE/),
      "a tender below the total must show the balance",
    ).toBeVisible()
    await finishSale(page, customer)

    const latest = await latestTransaction(page)
    expect(latest.paymentMethod, "a part-paid cash sale is still a cash sale").toBe("CASH")

    const entry = await creditEntryFor(page, customer)
    expect(entry, "the unpaid balance must post to the customer's ledger").toBeTruthy()
    expect(Number(entry?.balance_after)).toBeGreaterThan(0)
  })

  test("a discounted sale records the discount on the transaction", async ({ page }) => {
    await signIn(page, acceptanceCredentials()!)
    await openPosWithOneItem(page)

    // The discount controls sit beside the cart line and carry no label
    // association, so reach them through the label's own container.
    const discountAmount = page
      .getByText("Discount (UGX)")
      .locator("xpath=..")
      .locator('input[type="number"]')
    await discountAmount.fill("1")
    const reason = page.getByText("Reason", { exact: true }).locator("xpath=..").locator("select")
    await reason.selectOption("damaged_pack")

    await page.getByPlaceholder("Enter amount paid").fill("99999999")
    await finishSale(page)

    const latest = await latestTransaction(page)
    expect(Number(latest.discount), "the line discount must reach the transaction").toBeGreaterThan(0)
  })

  test("a completed sale can be refunded and restates the ledger", async ({ page }) => {
    await signIn(page, acceptanceCredentials()!)
    await completeCashSale(page)

    const latest = await latestTransaction(page)
    const { status, json } = await authedJson<{ success?: boolean; error?: string }>(
      page,
      "/api/admin/refunds",
      {
        method: "POST",
        body: {
          transactionId: latest.id,
          reason: "Acceptance run: operator-requested return",
        },
      },
    )
    expect(status, `refund failed: ${json?.error ?? ""}`).toBe(200)

    const refunds = await authedJson<{ refunds: Array<{ transactionNo: string; status: string }> }>(
      page,
      "/api/admin/refunds",
    )
    expect(refunds.status).toBe(200)
    const row = refunds.json.refunds.find((entry) => entry.transactionNo === latest.transactionNo)
    expect(row, "the refund must appear in the refund history").toBeTruthy()
    expect(row?.status).toMatch(/REFUNDED|VOIDED/)
  })

  test("one tenant cannot read another tenant's sales", async ({ page }) => {
    const other = tenantBCredentials()
    test.skip(other === null, NOT_RUN_TENANT_B)

    await signIn(page, acceptanceCredentials()!)
    const own = await latestTransaction(page)
    await signOut(page)

    await signIn(page, other!)
    const foreign = await authedJson<{ transactions: Array<{ transactionNo: string }> }>(
      page,
      "/api/admin/transactions",
    )
    expect(foreign.status).toBe(200)
    expect(
      foreign.json.transactions.map((entry) => entry.transactionNo),
      "tenant B must never see tenant A's sale",
    ).not.toContain(own.transactionNo)
  })

  test("the receipt prints from the browser, not from a print daemon", async ({ page }) => {
    await signIn(page, acceptanceCredentials()!)
    await completeCashSale(page)
    const latest = await latestTransaction(page)

    // window.print must not fire on page load: a receipt the operator never
    // asked for is a print job nobody can distinguish from a real one.
    await page.addInitScript(() => {
      const w = window as unknown as { __prints: number }
      w.__prints = 0
      window.print = () => {
        w.__prints += 1
      }
    })

    await page.goto(`/receipt/${latest.id}`)
    await expect(page.locator("body")).toContainText(latest.transactionNo)

    const printsOnLoad = await page.evaluate(
      () => (window as unknown as { __prints: number }).__prints,
    )
    expect(printsOnLoad, "opening a receipt must not submit a print job").toBe(0)

    const printControl = page.getByRole("button", { name: /Print/i }).first()
    if (await printControl.isVisible().catch(() => false)) {
      await printControl.click()
      await expect
        .poll(() => page.evaluate(() => (window as unknown as { __prints: number }).__prints))
        .toBeGreaterThan(0)
    }
  })
})
