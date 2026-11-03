import { expect, test } from "playwright/test"

/**
 * Environment-independent browser checks for the pharmacy portal.
 *
 * These need a running app but no database session, so they execute on any host
 * and in CI. They prove the anonymous edge of the deployment: the sign-in form
 * is real, every operational route is gated, the admin API answers JSON rather
 * than an HTML redirect, and the security headers are served.
 *
 * They are NOT operational acceptance. A signed-in sale, refund or report is
 * covered by pharmacy-acceptance.spec.ts, which needs a disposable tenant and
 * therefore a Windows acceptance host.
 */

/** Operational surfaces a cut-over pharmacy uses. Every one must be gated. */
const GATED_ROUTES = [
  "/portal/dashboard",
  "/portal/pos",
  "/portal/refunds",
  "/portal/inventory",
  "/portal/inventory/integrity",
  "/portal/purchases",
  "/portal/suppliers",
  "/portal/customers",
  "/portal/credit-ledger",
  "/portal/reports",
  "/portal/till",
  "/portal/transactions",
  "/portal/accounting",
  "/portal/tally-import",
  "/portal/settings",
  "/portal/users",
]

test.describe("pharmacy anonymous edge", () => {
  test("the sign-in page is a real form, not a placeholder", async ({ page }) => {
    const response = await page.goto("/login")
    expect(response?.status()).toBe(200)

    await expect(page.getByLabel("Email or username")).toBeVisible()
    await expect(page.getByLabel("Password")).toBeVisible()
    await expect(page.getByRole("button", { name: "Sign in" })).toBeEnabled()
    await expect(page.locator("body")).not.toContainText("Coming soon")
  })

  test("the sign-in form refuses an empty submission in the browser", async ({ page }) => {
    await page.goto("/login")
    await page.getByRole("button", { name: "Sign in" }).click()
    // Both fields are `required`; the browser blocks submit and the URL stays put.
    await expect(page).toHaveURL(/\/login/)
    await expect(page.getByLabel("Email or username")).toBeVisible()
  })

  for (const route of GATED_ROUTES) {
    test(`${route} sends an anonymous visitor to sign-in`, async ({ page }) => {
      await page.goto(route)
      await expect(page).toHaveURL(/\/login/)
      await expect(page.getByLabel("Password")).toBeVisible()
    })
  }

  test("no operational chrome leaks to an anonymous visitor", async ({ page }) => {
    await page.goto("/portal/pos")
    await expect(page).toHaveURL(/\/login/)
    await expect(page.getByRole("heading", { name: "Point of Sale", exact: true })).toHaveCount(0)
    await expect(page.getByRole("button", { name: /Complete Sale/ })).toHaveCount(0)
  })

  test("the admin API answers JSON to an anonymous caller, never an HTML redirect", async ({ page }) => {
    for (const path of ["/api/admin/dashboard", "/api/admin/reports", "/api/admin/inventory"]) {
      const response = await page.request.get(path, { maxRedirects: 0 })
      expect(response.status(), `${path} status`).toBeGreaterThanOrEqual(400)
      expect(response.status(), `${path} status`).toBeLessThan(500)
      expect(
        response.headers()["content-type"] ?? "",
        `${path} must not answer with HTML`,
      ).toContain("application/json")
    }
  })

  test("the sign-in page carries the deployment security headers", async ({ page }) => {
    const response = await page.goto("/login")
    const headers = response?.headers() ?? {}
    expect(headers["x-frame-options"]).toBe("SAMEORIGIN")
    expect(headers["x-content-type-options"]).toBe("nosniff")
    expect(headers["referrer-policy"]).toBe("strict-origin-when-cross-origin")
  })

  test("the sign-in page raises no uncaught client errors", async ({ page }) => {
    const errors: string[] = []
    page.on("pageerror", (error) => errors.push(error.message))
    await page.goto("/login")
    await expect(page.getByLabel("Password")).toBeVisible()
    expect(errors).toEqual([])
  })
})
