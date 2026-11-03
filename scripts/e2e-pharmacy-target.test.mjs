import assert from "node:assert/strict"
import { test } from "node:test"
import {
  DEFAULT_LOCAL_BASE_URL,
  forbiddenRuntimeEndpoints,
  pharmacyCredentials,
  pharmacyProbeProduct,
  pharmacyTenantBCredentials,
  resolvePharmacyTarget,
  validatePharmacyTarget,
} from "./e2e-pharmacy-target.mjs"

test("production hosts are refused, including every documented portal host", () => {
  for (const host of [
    "https://synapseos.tech",
    "https://www.synapseos.tech",
    "https://pharm.synapseos.tech",
    "https://pharmacy.synapseos.tech",
    "https://admin.synapseos.tech",
  ]) {
    const result = validatePharmacyTarget(host)
    assert.equal(result.status, "REFUSED", `${host} should be refused`)
  }
})

test("the production Supabase project URL is never accepted as an app target", () => {
  const result = validatePharmacyTarget("https://qfqakzmjatszisuqjwon.supabase.co")
  // Refused either as a *.supabase.co host without a production name, or as the
  // production ref itself — both must refuse, never accept.
  assert.equal(result.status, "REFUSED")
})

test("loopback is accepted and identified as such", () => {
  for (const value of ["http://127.0.0.1:3002", "http://localhost:3002", "http://[::1]:3002"]) {
    const result = validatePharmacyTarget(value)
    assert.equal(result.status, "FOUND", value)
    assert.equal(result.kind, "loopback", value)
  }
})

test("a preview deployment is accepted as a remote target", () => {
  const result = validatePharmacyTarget("https://synapse-pharm-git-feat-abc.vercel.app")
  assert.equal(result.status, "FOUND")
  assert.equal(result.kind, "remote")
  assert.equal(result.url, "https://synapse-pharm-git-feat-abc.vercel.app")
})

test("placeholders and non-http protocols are rejected", () => {
  assert.equal(validatePharmacyTarget("https://pharmacy.example").status, "INVALID")
  assert.equal(validatePharmacyTarget("https://pharmacy.test").status, "INVALID")
  assert.equal(validatePharmacyTarget("ftp://127.0.0.1:3002").status, "INVALID")
  assert.equal(validatePharmacyTarget("not a url").status, "INVALID")
  assert.equal(validatePharmacyTarget("").status, "MISSING")
})

test("no configured base URL means a local server on the pharmacy port", () => {
  const target = resolvePharmacyTarget({})
  assert.equal(target.mode, "local")
  assert.equal(target.baseURL, DEFAULT_LOCAL_BASE_URL)
  assert.equal(target.startWebServer, true)
  assert.match(target.startCommand, /@synapse\/pharmacy/)
})

test("an explicit base URL suppresses the managed web server", () => {
  const target = resolvePharmacyTarget({
    SYNAPSE_PHARMACY_E2E_BASE_URL: "https://synapse-pharm-preview.vercel.app",
  })
  assert.equal(target.mode, "remote")
  assert.equal(target.startWebServer, false)
})

test("an external local server can be used without being started by Playwright", () => {
  const target = resolvePharmacyTarget({
    SYNAPSE_PHARMACY_E2E_BASE_URL: "http://127.0.0.1:3002",
    SYNAPSE_PHARMACY_E2E_EXTERNAL_SERVER: "1",
  })
  assert.equal(target.mode, "remote")
  assert.equal(target.startWebServer, false)
})

test("a production base URL fails before any browser can open", () => {
  assert.throws(
    () => resolvePharmacyTarget({ SYNAPSE_PHARMACY_E2E_BASE_URL: "https://pharm.synapseos.tech" }),
    /PHARMACY_E2E_TARGET_REFUSED/,
  )
})

test("credentials are only returned when both halves are present", () => {
  assert.equal(pharmacyCredentials({}), null)
  assert.equal(pharmacyCredentials({ SYNAPSE_PHARMACY_E2E_EMAIL: "a@b.c" }), null)
  assert.equal(pharmacyCredentials({ SYNAPSE_PHARMACY_E2E_PASSWORD: "x" }), null)
  assert.deepEqual(
    pharmacyCredentials({ SYNAPSE_PHARMACY_E2E_EMAIL: "a@b.c", SYNAPSE_PHARMACY_E2E_PASSWORD: "x" }),
    { email: "a@b.c", password: "x", totp: null },
  )
})

test("a badly shaped fixed OTP is refused rather than silently dropped", () => {
  assert.throws(
    () =>
      pharmacyCredentials({
        SYNAPSE_PHARMACY_E2E_EMAIL: "a@b.c",
        SYNAPSE_PHARMACY_E2E_PASSWORD: "x",
        SYNAPSE_PHARMACY_E2E_TOTP: "12345",
      }),
    /6-digit/,
  )
})

test("tenant B credentials are independent of the primary operator", () => {
  assert.equal(pharmacyTenantBCredentials({}), null)
  assert.deepEqual(
    pharmacyTenantBCredentials({
      SYNAPSE_PHARMACY_E2E_TENANT_B_EMAIL: "b@b.c",
      SYNAPSE_PHARMACY_E2E_TENANT_B_PASSWORD: "y",
    }),
    { email: "b@b.c", password: "y", totp: null },
  )
})

test("the POS probe product is empty unless the operator names one", () => {
  assert.equal(pharmacyProbeProduct({}), "")
  assert.equal(pharmacyProbeProduct({ SYNAPSE_PHARMACY_E2E_PRODUCT: "  PAR-001 " }), "PAR-001")
})

test("the Tally bridge port is forbidden during normal operations", () => {
  const hosts = forbiddenRuntimeEndpoints({})
  assert.ok(hosts.includes("127.0.0.1:9000"))
  assert.ok(hosts.includes("localhost:9000"))
})

test("an extra forbidden host is appended, never replacing the defaults", () => {
  const hosts = forbiddenRuntimeEndpoints({ SYNAPSE_PHARMACY_E2E_FORBIDDEN_HOST: "bridge.internal:8443" })
  assert.equal(hosts.length, 3)
  assert.ok(hosts.includes("bridge.internal:8443"))
  assert.ok(hosts.includes("127.0.0.1:9000"))
})
