/**
 * Target and credential resolution for the pharmacy browser acceptance suite.
 *
 * Fail-closed: a base URL is only accepted when it resolves, is http(s), is not
 * a placeholder TLD, and is not production. Loopback is accepted because the
 * environment-independent smoke layer runs against a local server; the
 * operational journeys additionally require credentials and a disposable tenant.
 *
 * Nothing here reads or prints a secret. Credentials are only checked for
 * presence and shape.
 */

import {
  PRODUCTION_PROJECT_REF,
  supabaseProjectRefFromUrl,
} from "./e2e-acceptance-isolation.mjs"

/** Printed verbatim when the suite cannot run in this environment. */
export const NOT_RUN_WINDOWS = "NOT RUN — WINDOWS HOST REQUIRED"

export const NOT_RUN_CREDENTIALS =
  "NOT RUN — DISPOSABLE ACCEPTANCE TENANT CREDENTIALS REQUIRED"

export const NOT_RUN_TENANT_B = "NOT RUN — TENANT B CREDENTIALS REQUIRED"

export const DEFAULT_LOCAL_BASE_URL = "http://127.0.0.1:3002"

/** Production hosts. Acceptance must never point here. */
const PRODUCTION_HOSTS = new Set([
  "synapseos.tech",
  "www.synapseos.tech",
  "admin.synapseos.tech",
  "pharm.synapseos.tech",
  "pharmacy.synapseos.tech",
  "app.synapseos.tech",
  "demo.synapseos.tech",
])

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]", "::1"])

const PLACEHOLDER_SUFFIXES = [".invalid", ".example", ".test", ".localhost"]

function trimmed(value) {
  return typeof value === "string" ? value.trim() : ""
}

export function isLoopbackHost(hostname) {
  return LOOPBACK_HOSTS.has(String(hostname || "").toLowerCase())
}

function isProductionHost(hostname) {
  const host = String(hostname || "").toLowerCase()
  if (!host) return false
  if (PRODUCTION_HOSTS.has(host)) return true
  return host.endsWith(".synapseos.tech")
}

/**
 * Decide whether a base URL may be used for acceptance.
 * Returns one of: MISSING, INVALID, REFUSED, FOUND.
 */
export function validatePharmacyTarget(value) {
  const raw = trimmed(value)
  if (!raw) return { status: "MISSING" }

  let url
  try {
    url = new URL(raw)
  } catch {
    return { status: "INVALID", reason: "Not a valid URL" }
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { status: "INVALID", reason: `Unsupported protocol ${url.protocol}` }
  }

  const host = url.hostname.toLowerCase()
  if (PLACEHOLDER_SUFFIXES.some((suffix) => host.endsWith(suffix))) {
    return { status: "INVALID", reason: `${host} is a placeholder host, not a deployment` }
  }
  if (isProductionHost(host)) {
    return { status: "REFUSED", reason: `Refuses production host ${host}` }
  }

  // A Supabase project URL passed as the app base URL is a configuration error,
  // and pointing acceptance at the production project is refused outright.
  const ref = supabaseProjectRefFromUrl(raw)
  if (ref === PRODUCTION_PROJECT_REF) {
    return { status: "REFUSED", reason: "Refuses the production Supabase project as an app target" }
  }

  return {
    status: "FOUND",
    hostname: host,
    kind: isLoopbackHost(host) ? "loopback" : "remote",
    url: url.toString().replace(/\/$/, ""),
  }
}

/**
 * @returns {{ mode: "local"|"remote", baseURL: string, host: string,
 *            startWebServer: boolean, startCommand: string }}
 */
export function resolvePharmacyTarget(env = process.env) {
  const configured =
    trimmed(env.SYNAPSE_PHARMACY_E2E_BASE_URL) ||
    trimmed(env.PLAYWRIGHT_PHARMACY_BASE_URL)

  const startCommand =
    trimmed(env.SYNAPSE_PHARMACY_E2E_START_COMMAND) ||
    "npm run dev --workspace @synapse/pharmacy"

  const raw = configured || DEFAULT_LOCAL_BASE_URL
  const check = validatePharmacyTarget(raw)
  if (check.status !== "FOUND") {
    // Refuse before a browser is launched so a misconfiguration can never
    // become traffic against production.
    throw new Error(
      `PHARMACY_E2E_TARGET_${check.status}: ${check.reason ?? "base URL missing"}`,
    )
  }

  return {
    mode: configured ? "remote" : "local",
    baseURL: check.url,
    host: check.hostname,
    startWebServer: !configured && trimmed(env.SYNAPSE_PHARMACY_E2E_EXTERNAL_SERVER) !== "1",
    startCommand,
  }
}

/** Credentials for the primary acceptance operator, or null when incomplete. */
export function pharmacyCredentials(env = process.env) {
  const email = trimmed(env.SYNAPSE_PHARMACY_E2E_EMAIL)
  const password = trimmed(env.SYNAPSE_PHARMACY_E2E_PASSWORD)
  if (!email || !password) return null
  const totp = trimmed(env.SYNAPSE_PHARMACY_E2E_TOTP)
  if (totp && !/^\d{6}$/.test(totp)) {
    throw new Error("SYNAPSE_PHARMACY_E2E_TOTP must be the 6-digit fixed acceptance code")
  }
  return { email, password, totp: totp || null }
}

/** Credentials for a second tenant, used by the isolation journey. */
export function pharmacyTenantBCredentials(env = process.env) {
  const email = trimmed(env.SYNAPSE_PHARMACY_E2E_TENANT_B_EMAIL)
  const password = trimmed(env.SYNAPSE_PHARMACY_E2E_TENANT_B_PASSWORD)
  if (!email || !password) return null
  return { email, password, totp: trimmed(env.SYNAPSE_PHARMACY_E2E_TENANT_B_TOTP) || null }
}

/** The barcode or SKU the POS journey searches for. */
export function pharmacyProbeProduct(env = process.env) {
  return trimmed(env.SYNAPSE_PHARMACY_E2E_PRODUCT) || ""
}

/**
 * Endpoints that must never be contacted during normal pharmacy operations
 * after cut-over. A sale that needs Tally is not a cut-over sale.
 */
export function forbiddenRuntimeEndpoints(env = process.env) {
  const extra = trimmed(env.SYNAPSE_PHARMACY_E2E_FORBIDDEN_HOST)
  const hosts = ["127.0.0.1:9000", "localhost:9000"]
  if (extra) hosts.push(extra)
  return hosts
}
