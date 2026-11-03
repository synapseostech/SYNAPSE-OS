import { expect, type Page, type Request } from "playwright/test"
import {
  forbiddenRuntimeEndpoints,
  pharmacyCredentials,
  pharmacyProbeProduct,
  pharmacyTenantBCredentials,
  NOT_RUN_CREDENTIALS,
  NOT_RUN_TENANT_B,
  NOT_RUN_WINDOWS,
} from "../scripts/e2e-pharmacy-target.mjs"

export { NOT_RUN_CREDENTIALS, NOT_RUN_TENANT_B, NOT_RUN_WINDOWS }

export type Credentials = { email: string; password: string; totp: string | null }

/** Credentials for the primary acceptance operator, or null when unset. */
export function acceptanceCredentials(): Credentials | null {
  return pharmacyCredentials() as Credentials | null
}

/** Credentials for a second tenant, or null when unset. */
export function tenantBCredentials(): Credentials | null {
  return pharmacyTenantBCredentials() as Credentials | null
}

/** The SKU/barcode the POS journey searches for. */
export function probeProduct(): string {
  return pharmacyProbeProduct()
}

/** True only when this process is a real Windows run or the operator opted in. */
export function windowsAcceptanceHost(): boolean {
  return process.platform === "win32" || process.env.SYNAPSE_PHARMACY_E2E_ALLOW_NON_WINDOWS === "1"
}

/**
 * Why the operational journeys cannot run here, or null when they can.
 * Ordered widest first so the report names the real blocker.
 */
export function acceptanceBlocker(): string | null {
  if (!windowsAcceptanceHost()) return NOT_RUN_WINDOWS
  if (!acceptanceCredentials()) return NOT_RUN_CREDENTIALS
  return null
}

type Settled = "navigated" | "chooser" | "otp" | "error" | "timeout"

/**
 * Wait until the sign-in page has done one of the things it can do: navigate, ask
 * which pharmacy, ask for a code, or show an error. Polling rather than
 * Promise.race so the losing waits cannot surface as unhandled rejections.
 */
async function settleSignIn(page: Page, timeoutMs = 60_000): Promise<Settled> {
  if (!new URL(page.url()).pathname.startsWith("/login")) return "navigated"
  const chooser = page.getByText("Pick the one you are signing into")
  const otpField = page.getByPlaceholder("000000")
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!new URL(page.url()).pathname.startsWith("/login")) return "navigated"
    if (await chooser.isVisible().catch(() => false)) return "chooser"
    if (await otpField.isVisible().catch(() => false)) return "otp"
    if (await page.getByText(/Connect a support engineer|Invalid|incorrect|not found/i).first().isVisible().catch(() => false)) {
      return "error"
    }
    await page.waitForTimeout(250)
  }
  return "timeout"
}

async function handleSecondFactor(page: Page, credentials: Credentials) {
  const otpField = page.getByPlaceholder("000000")
  if (!(await otpField.isVisible().catch(() => false))) return
  if (!credentials.totp) {
    throw new Error(
      "This account requires a second factor; set SYNAPSE_PHARMACY_E2E_TOTP to the fixed acceptance code.",
    )
  }
  await otpField.fill(credentials.totp)
  await page.getByRole("button", { name: /Verify/ }).click()
}

/**
 * Sign in through the real form. Handles the multi-pharmacy chooser and both
 * second-factor surfaces (the inline OTP step and /auth/2fa).
 */
export async function signIn(page: Page, credentials: Credentials) {
  await page.goto("/login")
  await page.getByLabel("Email or username").fill(credentials.email)
  await page.getByLabel("Password").fill(credentials.password)
  await page.getByRole("button", { name: "Sign in" }).click()

  let settled = await settleSignIn(page)

  if (settled === "chooser") {
    await page
      .getByText("Pick the one you are signing into")
      .locator("xpath=following-sibling::div[contains(@class,'space-y-2')]")
      .getByRole("button")
      .first()
      .click()
    settled = await settleSignIn(page)
  }

  if (settled === "otp") {
    await handleSecondFactor(page, credentials)
    settled = await settleSignIn(page)
  }

  if (settled === "error" || settled === "timeout") {
    const body = (await page.locator("body").innerText().catch(() => "")).slice(0, 400)
    throw new Error(`Sign-in did not progress (${settled}). Page said: ${body}`)
  }

  await expect(page).not.toHaveURL(/\/login/)
}

/** Sign out from the portal shell. */
export async function signOut(page: Page) {
  await page.getByRole("button", { name: /Sign Out/i }).click()
  await page.waitForURL(/\/login/)
}

/**
 * Collects requests the pharmacy must never make once it is running on its own
 * books. A hit means an operation still depends on Tally or its bridge.
 */
export function watchForbiddenEndpoints(page: Page): Request[] {
  const hits: Request[] = []
  const forbidden = forbiddenRuntimeEndpoints() as string[]
  page.on("request", (request) => {
    const url = request.url()
    if (forbidden.some((host) => url.includes(host))) hits.push(request)
  })
  return hits
}

/** Fail the test with the offending URLs rather than a bare assertion. */
export function expectNoForbiddenEndpoints(hits: Request[]) {
  expect(
    hits.map((request) => request.url()),
    "operations must not depend on Tally or the Tally bridge after cut-over",
  ).toEqual([])
}

/** Read the JSON body of an app API call made with the signed-in session. */
export async function authedJson<T>(page: Page, path: string, init?: { method?: string; body?: unknown }) {
  const response = await page.request.fetch(path, {
    method: init?.method ?? "GET",
    data: init?.body,
    headers: init?.body === undefined ? undefined : { "content-type": "application/json" },
  })
  const text = await response.text()
  let json: T = undefined as T
  try {
    json = text ? (JSON.parse(text) as T) : (undefined as T)
  } catch {
    throw new Error(`${init?.method ?? "GET"} ${path} returned non-JSON (${response.status()}): ${text.slice(0, 200)}`)
  }
  return { status: response.status(), json }
}
