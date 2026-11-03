/**
 * Fail-closed identity checks for the isolated SYNAPSE acceptance database.
 * Never print secrets. Never treat production as acceptance.
 */

export const PRODUCTION_PROJECT_REF = "qfqakzmjatszisuqjwon"
export const EXPECTED_ACCEPTANCE_PROJECT_REF = "jbojujxpyxsdiukmrwzs"
export const EXPECTED_ACCEPTANCE_PROJECT_NAME = "synapse-e2e-acceptance"

export function supabaseProjectRefFromUrl(value) {
  if (!value) return null
  try {
    const url = new URL(value)
    const match = url.hostname.match(/^([a-z0-9]+)\.supabase\.co$/i)
    return match ? match[1].toLowerCase() : null
  } catch {
    return null
  }
}

export function validateIsolatedSupabaseUrl(value, expectedRef = EXPECTED_ACCEPTANCE_PROJECT_REF) {
  if (!value) return { status: "MISSING" }
  let url
  try {
    url = new URL(value)
  } catch {
    return { status: "INVALID", reason: "Not a valid URL" }
  }
  if (url.protocol !== "https:") {
    return { status: "INVALID", reason: "Must use https://" }
  }
  const ref = supabaseProjectRefFromUrl(value)
  if (!ref) {
    return { status: "INVALID", reason: "Must be a *.supabase.co project URL" }
  }
  if (ref === PRODUCTION_PROJECT_REF) {
    return { status: "INVALID", reason: "Refuses production SYNAPSE_OS project" }
  }
  if (ref !== expectedRef.toLowerCase()) {
    return {
      status: "INVALID",
      reason: `URL is not the documented isolated acceptance project (${expectedRef})`,
    }
  }
  return { status: "FOUND", projectRef: ref }
}

export function validateAcceptanceBaseUrl(value) {
  if (!value) return { status: "MISSING" }
  let url
  try {
    url = new URL(value)
  } catch {
    return { status: "INVALID", reason: "Not a valid URL" }
  }
  if (url.protocol !== "https:") {
    return { status: "INVALID", reason: "Must use https://" }
  }
  if (url.hostname === "localhost" || url.hostname === "127.0.0.1") {
    return { status: "INVALID", reason: "Must be remote, not localhost" }
  }
  if (url.hostname.endsWith(".invalid") || url.hostname.endsWith(".example") || url.hostname.endsWith(".test")) {
    return { status: "INVALID", reason: "Must be a real Vercel Preview host, not a placeholder" }
  }
  if (url.hostname === "synapseos.tech" || url.hostname === "www.synapseos.tech") {
    return { status: "INVALID", reason: "Refuses production OS host; use isolated Preview" }
  }
  const productionLike = new Set([
    "admin.synapseos.tech",
    "pharm.synapseos.tech",
    "pharmacy.synapseos.tech",
    "demo.synapseos.tech",
    "app.synapseos.tech",
  ])
  if (productionLike.has(url.hostname)) {
    return { status: "INVALID", reason: `Refuses ${url.hostname}; use isolated Preview` }
  }
  return { status: "FOUND", hostname: url.hostname }
}

export function vercelBypassHeaders(env = process.env) {
  const bypass = (env.SYNAPSE_E2E_VERCEL_BYPASS || "").trim()
  if (!bypass) return {}
  // JSON probes use redirect:manual. The cookie-set header makes Vercel 307 to
  // the same path, which is not an SSO login redirect. Playwright still sends
  // x-vercel-set-bypass-cookie via e2e-target.mjs so the browser can keep a cookie.
  return {
    "x-vercel-protection-bypass": bypass,
  }
}

export function serviceRoleIdentity(token) {
  if (!token || token.split(".").length < 2) return { ref: null, role: null }
  try {
    const payload = token.split(".")[1]
    const pad = "=".repeat((4 - (payload.length % 4)) % 4)
    const data = JSON.parse(Buffer.from(payload + pad, "base64url").toString("utf8"))
    return {
      ref: typeof data.ref === "string" ? data.ref.toLowerCase() : null,
      role: typeof data.role === "string" ? data.role : null,
    }
  } catch {
    return { ref: null, role: null }
  }
}

export function validateServiceRoleKey(value, expectedRef = EXPECTED_ACCEPTANCE_PROJECT_REF) {
  if (!value) return { status: "MISSING" }
  if (value.length < 32) {
    return { status: "INVALID", reason: "Too short to be a service role key" }
  }
  const identity = serviceRoleIdentity(value)
  if (!identity.role || !identity.ref) {
    return { status: "INVALID", reason: "Service role token is not a readable Supabase JWT" }
  }
  if (identity.role !== "service_role") {
    return { status: "INVALID", reason: "Token role is not service_role" }
  }
  if (identity.ref === PRODUCTION_PROJECT_REF) {
    return { status: "INVALID", reason: "Refuses production SYNAPSE_OS service role" }
  }
  if (identity.ref !== expectedRef.toLowerCase()) {
    return {
      status: "INVALID",
      reason: `Service role is not bound to isolated acceptance project (${expectedRef})`,
    }
  }
  return { status: "FOUND", projectRef: identity.ref }
}

export function validateAnonKey(value, expectedRef = EXPECTED_ACCEPTANCE_PROJECT_REF) {
  if (!value) return { status: "MISSING" }
  if (value.length < 32) {
    return { status: "INVALID", reason: "Too short to be an anon key" }
  }
  const identity = serviceRoleIdentity(value)
  if (!identity.role || !identity.ref) {
    return { status: "INVALID", reason: "Anon token is not a readable Supabase JWT" }
  }
  if (identity.role !== "anon") {
    return { status: "INVALID", reason: "Token role is not anon" }
  }
  if (identity.ref === PRODUCTION_PROJECT_REF) {
    return { status: "INVALID", reason: "Refuses production SYNAPSE_OS anon key" }
  }
  if (identity.ref !== expectedRef.toLowerCase()) {
    return {
      status: "INVALID",
      reason: `Anon key is not bound to isolated acceptance project (${expectedRef})`,
    }
  }
  return { status: "FOUND", projectRef: identity.ref }
}

const PROJECT_REF_PATTERN = /^[a-z0-9]{20}$/

/**
 * Resolve the disposable acceptance database from explicitly supplied values.
 *
 * The project ref may be supplied with SYNAPSE_E2E_ACCEPTANCE_PROJECT_REF; it
 * defaults to the documented acceptance project. Every credential must agree
 * with that one ref, and no alias or direct-URL variable may name another
 * database — a shell that mixes two targets is refused rather than guessed at.
 */
export function resolveAcceptanceTarget(env = process.env) {
  const explicitRef = (env.SYNAPSE_E2E_ACCEPTANCE_PROJECT_REF || "").trim().toLowerCase()
  const expectedRef = explicitRef || EXPECTED_ACCEPTANCE_PROJECT_REF
  const problems = []

  if (!PROJECT_REF_PATTERN.test(expectedRef)) {
    problems.push("Acceptance project ref must be exactly 20 lowercase alphanumeric characters")
  } else if (expectedRef === PRODUCTION_PROJECT_REF) {
    problems.push("The supplied acceptance project ref is the production SYNAPSE_OS project")
  }

  const urlCheck = validateIsolatedSupabaseUrl(env.SYNAPSE_E2E_SUPABASE_URL, expectedRef)
  if (urlCheck.status !== "FOUND") {
    problems.push(`SYNAPSE_E2E_SUPABASE_URL: ${urlCheck.reason || urlCheck.status}`)
  }

  const serviceCheck = validateServiceRoleKey(env.SYNAPSE_E2E_SERVICE_ROLE_KEY, expectedRef)
  if (serviceCheck.status !== "FOUND") {
    problems.push(`SYNAPSE_E2E_SERVICE_ROLE_KEY: ${serviceCheck.reason || serviceCheck.status}`)
  }

  const anonValue = (env.SYNAPSE_E2E_ANON_KEY || env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "").trim()
  const anonCheck = validateAnonKey(anonValue, expectedRef)
  if (anonCheck.status === "MISSING") {
    problems.push("No anon key supplied (SYNAPSE_E2E_ANON_KEY); the RLS-under-JWT suite cannot run")
  } else if (anonCheck.status !== "FOUND") {
    problems.push(`Anon key: ${anonCheck.reason || anonCheck.status}`)
  }

  for (const key of ["SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_URL"]) {
    const alias = (env[key] || "").trim()
    if (!alias) continue
    const aliasRef = supabaseProjectRefFromUrl(alias)
    if (aliasRef !== expectedRef) {
      problems.push(`${key} names ${aliasRef || "a non-Supabase host"}, not ${expectedRef}`)
    }
  }

  for (const key of ["DATABASE_URL", "DIRECT_DATABASE_URL", "SUPABASE_DB_URL"]) {
    if ((env[key] || "").trim()) {
      problems.push(`${key} is set; direct database URLs are not accepted for acceptance runs`)
    }
  }

  if ((env.SUPABASE_ACCESS_TOKEN || "").trim()) {
    problems.push("SUPABASE_ACCESS_TOKEN is set; unset it so no CLI command can target another project")
  }

  return {
    status: problems.length === 0 ? "FOUND" : "INVALID",
    projectRef: expectedRef,
    explicitRef: Boolean(explicitRef),
    problems,
    urlCheck,
    serviceCheck,
    anonCheck,
  }
}

export function interpretReadyPayload(payload, expectedSha) {
  if (!payload || typeof payload !== "object") {
    return { status: "INVALID", reason: "Ready payload is not JSON" }
  }
  if (payload.status !== "ready") {
    return { status: "INVALID", reason: `Ready status is ${payload.status || "missing"}` }
  }
  if (!payload.checks?.database?.ok) {
    return { status: "INVALID", reason: "Ready database check is not ok" }
  }
  const sha = typeof payload.commitSha === "string" ? payload.commitSha : null
  if (expectedSha && sha && !sha.startsWith(expectedSha.slice(0, 7)) && !expectedSha.startsWith(sha.slice(0, 7))) {
    return { status: "INVALID", reason: "Preview SHA does not match EXPECTED_SHA" }
  }
  return { status: "FOUND", commitSha: sha }
}
