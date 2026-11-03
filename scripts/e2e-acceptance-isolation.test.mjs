import assert from "node:assert/strict"
import { test } from "node:test"
import {
  PRODUCTION_PROJECT_REF,
  EXPECTED_ACCEPTANCE_PROJECT_REF,
  supabaseProjectRefFromUrl,
  validateIsolatedSupabaseUrl,
  validateAcceptanceBaseUrl,
  validateServiceRoleKey,
  validateAnonKey,
  resolveAcceptanceTarget,
  interpretReadyPayload,
  vercelBypassHeaders,
} from "./e2e-acceptance-isolation.mjs"

function fakeJwt(claims) {
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url")
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url")
  return `${header}.${payload}.sig`
}

test("extracts a supabase project ref from a project URL", () => {
  assert.equal(
    supabaseProjectRefFromUrl(`https://${EXPECTED_ACCEPTANCE_PROJECT_REF}.supabase.co`),
    EXPECTED_ACCEPTANCE_PROJECT_REF,
  )
})

test("refuses production supabase as the acceptance database", () => {
  const result = validateIsolatedSupabaseUrl(`https://${PRODUCTION_PROJECT_REF}.supabase.co`)
  assert.equal(result.status, "INVALID")
  assert.match(result.reason, /production/i)
})

test("accepts the documented isolated acceptance project URL", () => {
  const result = validateIsolatedSupabaseUrl(`https://${EXPECTED_ACCEPTANCE_PROJECT_REF}.supabase.co`)
  assert.equal(result.status, "FOUND")
  assert.equal(result.projectRef, EXPECTED_ACCEPTANCE_PROJECT_REF)
})

test("doctor bypass headers omit cookie-set so JSON probes are not 307'd", () => {
  assert.deepEqual(vercelBypassHeaders({}), {})
  const headers = vercelBypassHeaders({ SYNAPSE_E2E_VERCEL_BYPASS: "bypass-secret" })
  assert.equal(headers["x-vercel-protection-bypass"], "bypass-secret")
  assert.equal(headers["x-vercel-set-bypass-cookie"], undefined)
})

test("rejects localhost and production OS hosts for browser acceptance", () => {
  assert.equal(validateAcceptanceBaseUrl("http://127.0.0.1:3011").status, "INVALID")
  assert.equal(validateAcceptanceBaseUrl("https://synapseos.tech").status, "INVALID")
  assert.equal(validateAcceptanceBaseUrl("https://admin.synapseos.tech").status, "INVALID")
  assert.equal(validateAcceptanceBaseUrl("https://pharm.synapseos.tech").status, "INVALID")
  assert.equal(validateAcceptanceBaseUrl("https://demo.synapseos.tech").status, "INVALID")
  assert.equal(
    validateAcceptanceBaseUrl("https://synpase-os-git-cursor-core-os-317939-ebrines-projects-d0493afe.vercel.app").status,
    "FOUND",
  )
})

test("service role JWT must belong to the isolated project", () => {
  const good = fakeJwt({ ref: EXPECTED_ACCEPTANCE_PROJECT_REF, role: "service_role" })
  assert.equal(validateServiceRoleKey(good).status, "FOUND")
  const prod = fakeJwt({ ref: PRODUCTION_PROJECT_REF, role: "service_role" })
  assert.equal(validateServiceRoleKey(prod).status, "INVALID")
  const anon = fakeJwt({ ref: EXPECTED_ACCEPTANCE_PROJECT_REF, role: "anon" })
  assert.equal(validateServiceRoleKey(anon).status, "INVALID")
})

test("anon key must belong to the isolated project and carry the anon role", () => {
  const good = fakeJwt({ ref: EXPECTED_ACCEPTANCE_PROJECT_REF, role: "anon" })
  assert.equal(validateAnonKey(good).status, "FOUND")
  assert.equal(validateAnonKey(fakeJwt({ ref: PRODUCTION_PROJECT_REF, role: "anon" })).status, "INVALID")
  assert.equal(validateAnonKey(fakeJwt({ ref: EXPECTED_ACCEPTANCE_PROJECT_REF, role: "service_role" })).status, "INVALID")
})

function acceptanceEnv(overrides = {}) {
  return {
    SYNAPSE_E2E_SUPABASE_URL: `https://${EXPECTED_ACCEPTANCE_PROJECT_REF}.supabase.co`,
    SYNAPSE_E2E_SERVICE_ROLE_KEY: fakeJwt({ ref: EXPECTED_ACCEPTANCE_PROJECT_REF, role: "service_role" }),
    SYNAPSE_E2E_ANON_KEY: fakeJwt({ ref: EXPECTED_ACCEPTANCE_PROJECT_REF, role: "anon" }),
    ...overrides,
  }
}

test("resolves the documented acceptance project when no ref is supplied", () => {
  const target = resolveAcceptanceTarget(acceptanceEnv())
  assert.equal(target.status, "FOUND", target.problems.join("; "))
  assert.equal(target.projectRef, EXPECTED_ACCEPTANCE_PROJECT_REF)
  assert.equal(target.explicitRef, false)
})

test("accepts an explicitly supplied project ref only when every credential agrees", () => {
  const other = "abcdefghijklmnopqrst"
  const target = resolveAcceptanceTarget({
    SYNAPSE_E2E_ACCEPTANCE_PROJECT_REF: other,
    SYNAPSE_E2E_SUPABASE_URL: `https://${other}.supabase.co`,
    SYNAPSE_E2E_SERVICE_ROLE_KEY: fakeJwt({ ref: other, role: "service_role" }),
    SYNAPSE_E2E_ANON_KEY: fakeJwt({ ref: other, role: "anon" }),
  })
  assert.equal(target.status, "FOUND", target.problems.join("; "))
  assert.equal(target.projectRef, other)

  const mismatched = resolveAcceptanceTarget({
    ...acceptanceEnv(),
    SYNAPSE_E2E_ACCEPTANCE_PROJECT_REF: other,
  })
  assert.equal(mismatched.status, "INVALID")
  assert.ok(mismatched.problems.some((problem) => problem.includes("SYNAPSE_E2E_SUPABASE_URL")))
})

test("refuses production even when it is declared as the acceptance target", () => {
  const target = resolveAcceptanceTarget({
    SYNAPSE_E2E_ACCEPTANCE_PROJECT_REF: PRODUCTION_PROJECT_REF,
    SYNAPSE_E2E_SUPABASE_URL: `https://${PRODUCTION_PROJECT_REF}.supabase.co`,
    SYNAPSE_E2E_SERVICE_ROLE_KEY: fakeJwt({ ref: PRODUCTION_PROJECT_REF, role: "service_role" }),
    SYNAPSE_E2E_ANON_KEY: fakeJwt({ ref: PRODUCTION_PROJECT_REF, role: "anon" }),
  })
  assert.equal(target.status, "INVALID")
  assert.ok(target.problems.some((problem) => /production/i.test(problem)))
})

test("refuses a shell that mixes the acceptance project with another target", () => {
  const alias = resolveAcceptanceTarget(
    acceptanceEnv({ SUPABASE_URL: `https://${PRODUCTION_PROJECT_REF}.supabase.co` }),
  )
  assert.equal(alias.status, "INVALID")
  assert.ok(alias.problems.some((problem) => problem.includes("SUPABASE_URL")))

  const direct = resolveAcceptanceTarget(
    acceptanceEnv({ DATABASE_URL: "postgresql://user:pass@db.example.test/postgres" }),
  )
  assert.equal(direct.status, "INVALID")
  assert.ok(direct.problems.some((problem) => problem.includes("DATABASE_URL")))

  const token = resolveAcceptanceTarget(acceptanceEnv({ SUPABASE_ACCESS_TOKEN: "sbp_test" }))
  assert.equal(token.status, "INVALID")
  assert.ok(token.problems.some((problem) => problem.includes("SUPABASE_ACCESS_TOKEN")))
})

test("refuses a malformed declared ref and a missing anon key", () => {
  const malformed = resolveAcceptanceTarget(
    acceptanceEnv({ SYNAPSE_E2E_ACCEPTANCE_PROJECT_REF: "not-a-ref" }),
  )
  assert.equal(malformed.status, "INVALID")

  const noAnon = acceptanceEnv()
  delete noAnon.SYNAPSE_E2E_ANON_KEY
  const missing = resolveAcceptanceTarget(noAnon)
  assert.equal(missing.status, "INVALID")
  assert.ok(missing.problems.some((problem) => problem.includes("anon key")))
})

test("ready payload fails closed without a live database", () => {
  assert.equal(interpretReadyPayload({ status: "not_ready", checks: { database: { ok: false } } }).status, "INVALID")
  const ok = interpretReadyPayload({ status: "ready", checks: { database: { ok: true } }, commitSha: "9cd6c4d" }, "9cd6c4d1448f")
  assert.equal(ok.status, "FOUND")
})
