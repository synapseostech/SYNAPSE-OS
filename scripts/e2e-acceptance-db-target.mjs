#!/usr/bin/env node
/**
 * Validate the disposable acceptance database before any suite runs.
 *
 * Reads only explicitly supplied SYNAPSE_E2E_* values (never .env.local),
 * refuses production, a mixed target, or undeclared remote credentials, and
 * never prints a secret. --probe performs read-only HTTP checks. --schema
 * compares the PostgREST surface with the objects the pharmacy suites require;
 * that is a migration fingerprint, not a migration history.
 *
 * Exit codes: 0 valid, 1 invalid target, 2 probe failed, 3 schema incomplete.
 */
import {
  PRODUCTION_PROJECT_REF,
  resolveAcceptanceTarget,
} from "./e2e-acceptance-isolation.mjs"

const args = new Set(process.argv.slice(2))
const target = resolveAcceptanceTarget(process.env)

console.log("=".repeat(78))
console.log("DISPOSABLE ACCEPTANCE DATABASE TARGET")
console.log("=".repeat(78))

let host = "(unresolved)"
try {
  host = new URL(process.env.SYNAPSE_E2E_SUPABASE_URL).hostname
} catch {
  /* keep unresolved */
}

console.log(`  database host:      ${host}`)
console.log(`  project ref:        ${target.projectRef || "(none)"} ${target.explicitRef ? "(explicit)" : "(documented default)"}`)
console.log(`  service role:       ${target.serviceCheck?.status === "FOUND" ? `bound to ${target.serviceCheck.projectRef}, role service_role` : "NOT VALID"}`)
console.log(`  anon key:           ${target.anonCheck?.status === "FOUND" ? `bound to ${target.anonCheck.projectRef}, role anon` : "NOT VALID"}`)
console.log(`  production ref:     ${PRODUCTION_PROJECT_REF} (refused)`)

if (target.status !== "FOUND") {
  console.log()
  console.log("REFUSED: the acceptance target is not unambiguous")
  for (const problem of target.problems) console.log(`  - ${problem}`)
  process.exit(1)
}

const url = process.env.SYNAPSE_E2E_SUPABASE_URL.replace(/\/$/, "")
const anonKey = (process.env.SYNAPSE_E2E_ANON_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "").trim()
const serviceKey = (process.env.SYNAPSE_E2E_SERVICE_ROLE_KEY || "").trim()

// Supabase restricts the PostgREST OpenAPI root to service_role: the anon key
// gets 401 {"message":"Invalid API key"} there even when it is valid, which
// made a healthy project look unreachable. The service key is already required
// to be bound to this project, so the read-only schema probe uses it.
const schemaHeaders = {
  apikey: serviceKey,
  Authorization: `Bearer ${serviceKey}`,
  Accept: "application/openapi+json",
}

async function get(path, headers = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 20000)
  try {
    const response = await fetch(`${url}${path}`, { headers, signal: controller.signal, redirect: "manual" })
    const text = await response.text()
    return { status: response.status, text }
  } finally {
    clearTimeout(timer)
  }
}

let schemaDocument = null

if (args.has("--probe")) {
  console.log()
  console.log("READ-ONLY PROBES")
  try {
    const auth = await get("/auth/v1/health", { apikey: anonKey })
    console.log(`  auth health:        HTTP ${auth.status}${auth.status === 200 ? "" : " (expected 200)"}`)
    if (auth.status !== 200) process.exit(2)

    const rest = await get("/rest/v1/", schemaHeaders)
    console.log(`  rest schema:        HTTP ${rest.status}${rest.status === 200 ? "" : " (expected 200)"}`)
    if (rest.status !== 200) process.exit(2)

    const anonRead = await get("/rest/v1/tenants?select=id&limit=1", {
      apikey: anonKey,
      Authorization: `Bearer ${anonKey}`,
    })
    console.log(
      `  anon key read:      HTTP ${anonRead.status}${
        anonRead.status === 200 ? " (RLS-scoped)" : " (informational; the RLS suite is authoritative)"
      }`,
    )
    try {
      schemaDocument = JSON.parse(rest.text)
    } catch {
      console.log("  rest schema:        response is not JSON")
      process.exit(2)
    }
  } catch (error) {
    console.log(`  probe failed:       ${error.name === "AbortError" ? "timed out" : "network unreachable"}`)
    process.exit(2)
  }
}

if (args.has("--schema")) {
  if (!schemaDocument) {
    try {
      const rest = await get("/rest/v1/", schemaHeaders)
      if (rest.status !== 200) {
        console.log(`\n  schema probe:       HTTP ${rest.status} (expected 200)`)
        process.exit(2)
      }
      schemaDocument = JSON.parse(rest.text)
    } catch (error) {
      console.log(`\n  schema probe:       ${error.name === "AbortError" ? "timed out" : "not readable"}`)
      process.exit(2)
    }
  }

  const tables = new Set(Object.keys(schemaDocument.definitions ?? {}))
  const paths = schemaDocument.paths ?? {}
  const rpcs = new Set(
    Object.keys(paths)
      .filter((path) => path.startsWith("/rpc/"))
      .map((path) => path.slice("/rpc/".length)),
  )

  const requiredTables = [
    "tenants",
    "profiles",
    "pharmacy_products",
    "pharmacy_product_batches",
    "pharmacy_pos_sales",
    "pharmacy_pos_sale_items",
    "pharmacy_customers",
    "pharmacy_credit_ledger",
    "pharmacy_cashier_sessions",
    "pharmacy_import_sessions",
    "pharmacy_purchases",
    "pharmacy_suppliers",
  ]
  const requiredRpcs = [
    "complete_pharmacy_sale",
    "reverse_pharmacy_sale",
    "adjust_pharmacy_batch_stock",
    "post_pharmacy_credit_entry",
    "pharmacy_till_record_cash",
    "claim_pharmacy_tally_cutover_apply",
    "release_pharmacy_tally_cutover_apply",
  ]

  const missing = [
    ...requiredTables.filter((name) => !tables.has(name)),
    ...requiredRpcs.filter((name) => !rpcs.has(name)),
  ]

  console.log()
  console.log("SCHEMA FINGERPRINT")
  console.log(`  tables exposed:     ${tables.size}`)
  console.log(`  rpcs exposed:       ${rpcs.size}`)
  console.log(`  required objects:   ${requiredTables.length + requiredRpcs.length}`)
  console.log(`  missing:            ${missing.length ? missing.join(", ") : "none"}`)
  if (missing.length) process.exit(3)
}

console.log()
console.log(
  args.has("--probe") || args.has("--schema")
    ? "PASS: acceptance target is isolated and unambiguous; read-only probes passed"
    : "PASS: acceptance target is isolated and unambiguous (no network probe requested)",
)
