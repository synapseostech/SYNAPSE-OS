#!/usr/bin/env node
/**
 * Preflight configuration check for SYNAPSE-OS production acceptance.
 *
 * Validates required environment secrets without printing their values.
 * Proves isolated DB identity and live health/ready before seed or browser work.
 * Exits non-zero if any required configuration is MISSING or INVALID.
 */

import {
  EXPECTED_ACCEPTANCE_PROJECT_REF,
  interpretReadyPayload,
  validateAcceptanceBaseUrl,
  validateIsolatedSupabaseUrl,
  validateServiceRoleKey,
  vercelBypassHeaders,
} from "./e2e-acceptance-isolation.mjs"

// A replacement project is supported: SYNAPSE_E2E_ACCEPTANCE_PROJECT_REF wins
// over the documented ref, and both validators refuse production regardless.
const DECLARED_ACCEPTANCE_REF = (process.env.SYNAPSE_E2E_ACCEPTANCE_PROJECT_REF || EXPECTED_ACCEPTANCE_PROJECT_REF)
  .trim()
  .toLowerCase()

const checks = {
  SYNAPSE_E2E_BASE_URL: {
    source: "VERCEL",
    description: "Remote acceptance deployment URL",
    required: true,
    validate: (value) => validateAcceptanceBaseUrl(value),
  },
  SYNAPSE_E2E_EMAIL: {
    source: "OPERATOR_CREATED",
    description: "E2E staff email credential",
    required: true,
    validate: (value) => {
      if (!value) return { status: "MISSING" }
      if (!value.includes("@")) {
        return { status: "INVALID", reason: "Not a valid email format" }
      }
      if (!value.endsWith("@synapseos.invalid")) {
        return { status: "INVALID", reason: "Must be a synthetic @synapseos.invalid E2E identity" }
      }
      return { status: "FOUND" }
    },
  },
  SYNAPSE_E2E_PASSWORD: {
    source: "OPERATOR_CREATED",
    description: "E2E staff password",
    required: true,
    validate: (value) => {
      if (!value) return { status: "MISSING" }
      if (value.length < 12) {
        return { status: "INVALID", reason: "Must be at least 12 characters" }
      }
      return { status: "FOUND" }
    },
  },
  SYNAPSE_E2E_FIXED_OTP: {
    source: "OPERATOR_CREATED",
    description: "Fixed 6-digit OTP for synthetic tenant auth",
    required: true,
    validate: (value) => {
      if (!value) return { status: "MISSING" }
      if (!/^\d{6}$/.test(value)) {
        return { status: "INVALID", reason: "Must be exactly 6 digits" }
      }
      return { status: "FOUND" }
    },
  },
  SYNAPSE_E2E_SUPABASE_URL: {
    source: "SUPABASE",
    description: "Isolated E2E database URL (seed only)",
    required: true,
    validate: (value) => validateIsolatedSupabaseUrl(value, DECLARED_ACCEPTANCE_REF),
  },
  SYNAPSE_E2E_SERVICE_ROLE_KEY: {
    source: "SUPABASE",
    description: "Service role key for seeding (seed only)",
    required: true,
    validate: (value) => validateServiceRoleKey(value, DECLARED_ACCEPTANCE_REF),
  },
  SYNAPSE_E2E_REMOTE_HOST_READY: {
    source: "ATTESTATION",
    description: "Operator attestation that remote Vercel deployment has E2E gates configured",
    required: true,
    validate: (value) => {
      if (!value) return { status: "MISSING" }
      if (value !== "true") {
        return { status: "INVALID", reason: 'Must be exactly "true"' }
      }
      return { status: "FOUND" }
    },
  },
}

console.log("=" .repeat(80))
console.log("SYNAPSE-OS Production Acceptance Configuration Doctor")
console.log("=" .repeat(80))
console.log()
console.log("Checking environment configuration for isolated acceptance testing...")
console.log()

let allValid = true
const results = []

for (const [key, config] of Object.entries(checks)) {
  const value = process.env[key]
  const result = config.validate(value)
  
  const line = {
    variable: key,
    status: result.status,
    source: config.source,
    description: config.description,
    reason: result.reason,
  }
  
  results.push(line)
  
  if (result.status !== "FOUND") {
    allValid = false
  }
}

const maxVarLen = Math.max(...results.map((r) => r.variable.length))
const maxStatusLen = Math.max(...results.map((r) => r.status.length))
const maxSourceLen = Math.max(...results.map((r) => r.source.length))

console.log("Configuration Variables:")
console.log("-".repeat(80))
for (const result of results) {
  const statusSymbol = result.status === "FOUND" ? "✓" : "✗"
  const statusColor = result.status === "FOUND" ? "" : ""
  
  console.log(
    `${statusSymbol} ${result.variable.padEnd(maxVarLen)} | ${result.status.padEnd(maxStatusLen)} | ${result.source.padEnd(maxSourceLen)} | ${result.description}`,
  )
  
  if (result.reason) {
    console.log(`  → ${result.reason}`)
  }
}

console.log()
console.log("=" .repeat(80))

console.log()
console.log("Deployment Identity & Isolation:")
const baseUrl = process.env.SYNAPSE_E2E_BASE_URL || ""
let baseHost = "(missing)"
try { baseHost = new URL(baseUrl).hostname } catch { /* keep missing */ }
const isolated = validateIsolatedSupabaseUrl(process.env.SYNAPSE_E2E_SUPABASE_URL || "", DECLARED_ACCEPTANCE_REF)
const service = validateServiceRoleKey(process.env.SYNAPSE_E2E_SERVICE_ROLE_KEY || "", DECLARED_ACCEPTANCE_REF)
const sha = (process.env.EXPECTED_SHA || process.env.GITHUB_SHA || "").trim() || "(not provided)"
console.log(`  Deployment host:          ${baseHost}`)
console.log(`  Environment:              ${process.env.SYNAPSE_E2E_ACCEPTANCE_ENV === "true" ? "acceptance" : "(not attested)"}`)
console.log(`  Expected Git SHA:         ${sha}`)
console.log(`  Supabase project ref:     ${isolated.projectRef || isolated.reason || isolated.status}`)
console.log(`  Service-role project ref: ${service.projectRef || service.reason || service.status}`)
console.log(`  Production isolation:     ${isolated.status === "FOUND" && service.status === "FOUND" ? "PASS" : "FAIL"}`)
console.log()

if (!allValid) {
  console.log("❌ PREFLIGHT FAILED: Configuration is incomplete or invalid")
  console.log()
  console.log("Required GitHub Environment Secrets (production-acceptance):")
  console.log("  - SYNAPSE_E2E_BASE_URL")
  console.log("  - SYNAPSE_E2E_EMAIL")
  console.log("  - SYNAPSE_E2E_PASSWORD")
  console.log("  - SYNAPSE_E2E_FIXED_OTP")
  console.log("  - SYNAPSE_E2E_SUPABASE_URL")
  console.log("  - SYNAPSE_E2E_SERVICE_ROLE_KEY")
  console.log("  - SYNAPSE_E2E_REMOTE_HOST_READY")
  console.log()
  console.log("Required Vercel Preview Variables (for SYNAPSE_E2E_BASE_URL deployment):")
  console.log("  - SYNAPSE_E2E_AUTH=true")
  console.log("  - SYNAPSE_E2E_ACCEPTANCE_ENV=true")
  console.log("  - SYNAPSE_E2E_FIXED_OTP=(same value as GitHub secret)")
  console.log()
  console.log("Setup Instructions:")
  console.log("  1. See docs/runbooks/PRODUCTION_ACCEPTANCE_SETUP.md for detailed setup")
  console.log("  2. See docs/evidence/GOLDEN_JOURNEY_WAVE3.md for operator checklist")
  console.log()
  console.log("=" .repeat(80))
  process.exit(1)
}

async function probeJson(url, headers) {
  const response = await fetch(url, { headers, redirect: "manual", cache: "no-store" })
  const text = await response.text()
  let json = null
  try {
    json = JSON.parse(text)
  } catch {
    json = null
  }
  return { status: response.status, json, location: response.headers.get("location") }
}

const headers = vercelBypassHeaders()
const base = process.env.SYNAPSE_E2E_BASE_URL.replace(/\/$/, "")
const expectedSha = (process.env.EXPECTED_SHA || process.env.GITHUB_SHA || "").trim() || null

try {
  const live = await probeJson(`${base}/api/health/live`, headers)
  if (live.status === 401 || live.status === 403 || (live.status >= 300 && live.status < 400)) {
    console.log("❌ PREFLIGHT FAILED: health/live is not reachable on the isolated Preview")
    console.log("  → SSO or redirect blocked the probe. Set SYNAPSE_E2E_VERCEL_BYPASS if Preview protection is on.")
    process.exit(1)
  }
  if (live.status !== 200 || live.json?.status !== "live") {
    console.log("❌ PREFLIGHT FAILED: /api/health/live is not live")
    console.log(`  → HTTP ${live.status} status=${live.json?.status || "missing"}`)
    process.exit(1)
  }
  console.log(`✓ /api/health/live              | FOUND    | LIVE        | Isolated Preview health`)

  const ready = await probeJson(`${base}/api/ready`, headers)
  const readyCheck = interpretReadyPayload(ready.json, expectedSha)
  if (ready.status !== 200 || readyCheck.status !== "FOUND") {
    console.log("❌ PREFLIGHT FAILED: /api/ready did not prove an isolated ready environment")
    console.log(`  → HTTP ${ready.status} ${readyCheck.reason || ""}`)
    process.exit(1)
  }
  const shaNote = readyCheck.commitSha ? `sha=${readyCheck.commitSha.slice(0, 7)}` : "sha=unknown"
  console.log(`✓ /api/ready                    | FOUND    | READY       | ${shaNote}`)
  console.log(`✓ isolated project              | FOUND    | ${DECLARED_ACCEPTANCE_REF} | not production`)
  console.log(`  Git SHA (ready):              ${readyCheck.commitSha || "(missing from /api/ready)"}`)
  console.log(`  Database host/ref:            ${isolated.projectRef}`)
} catch (error) {
  console.log("❌ PREFLIGHT FAILED: live isolation probes could not run")
  console.log(`  → ${error instanceof Error ? error.message : "probe failed"}`)
  process.exit(1)
}

console.log()
console.log("✅ PREFLIGHT PASSED: Isolated acceptance configuration and live probes are valid")
console.log()
console.log("Next Steps:")
console.log("  - Run live journey: npm run journey:hospital-golden-live")
console.log("  - Run browser tests: npm run test:e2e:hospital:smoke")
console.log("  - See docs/evidence/GOLDEN_JOURNEY_WAVE3.md for full checklist")
console.log()
console.log("=" .repeat(80))
