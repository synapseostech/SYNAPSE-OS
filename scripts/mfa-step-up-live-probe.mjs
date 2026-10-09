#!/usr/bin/env node
/**
 * Live MFA step-up readiness probe (does NOT invent a TOTP round-trip).
 *
 * Usage:
 *   node scripts/mfa-step-up-live-probe.mjs --project-ref qfqakzmjatszisuqjwon
 */
import { createClient } from "@supabase/supabase-js"
import { execFileSync } from "node:child_process"
import { mkdirSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")

function argValue(flag) {
  const idx = process.argv.indexOf(flag)
  return idx >= 0 ? process.argv[idx + 1] : null
}

function fetchServiceRole(projectRef) {
  const raw = execFileSync(
    "npx",
    ["supabase", "projects", "api-keys", "--project-ref", projectRef, "-o", "json"],
    { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  )
  const keys = JSON.parse(raw)
  const service =
    keys.find((k) => k.name === "service_role" || k.id === "service_role") ||
    keys.find((k) => String(k.name || "").includes("service"))
  if (!service?.api_key) throw new Error("service_role key not found via supabase CLI")
  return service.api_key
}

const projectRef = argValue("--project-ref") || process.env.SUPABASE_PROJECT_REF || "qfqakzmjatszisuqjwon"
const url = (
  process.env.SUPABASE_URL ||
  process.env.NEXT_PUBLIC_SUPABASE_URL ||
  `https://${projectRef}.supabase.co`
).trim()
const key = (process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim() || fetchServiceRole(projectRef)
const db = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } })

const evidenceDir = join(root, "docs/engineering/evidence")
mkdirSync(evidenceDir, { recursive: true })
const stamp = new Date().toISOString().replace(/[:.]/g, "-")

async function readable(table) {
  const { error } = await db.from(table).select("*").limit(1)
  return !error
}

const checks = {
  mfa_enrollments_readable: await readable("mfa_enrollments"),
  synapse_sessions_readable: await readable("synapse_sessions"),
  mfa_step_up_replays_readable: await readable("mfa_step_up_replays"),
}

const { data: enrollments, error: enrollErr } = await db
  .from("mfa_enrollments")
  .select("id, user_id, verified, created_at")
  .eq("verified", true)

const verifiedEnrollments = enrollErr ? 0 : (enrollments?.length ?? 0)

// Platform admins with verified enrollment (best-effort join via profiles/roles)
let platformAdminsWithMfa = 0
let platformAdminProbe = "skipped"
try {
  const { data: admins } = await db
    .from("profiles")
    .select("id, email, is_admin, platform_control_role")
    .or("is_admin.eq.true,platform_control_role.not.is.null")
    .limit(100)
  const adminIds = new Set((admins ?? []).map((a) => a.id))
  platformAdminsWithMfa = (enrollments ?? []).filter((e) => adminIds.has(e.user_id)).length
  platformAdminProbe = "ok"
} catch (e) {
  platformAdminProbe = `failed:${e instanceof Error ? e.message : String(e)}`
}

const liveTotpRoundTrip =
  verifiedEnrollments > 0
    ? "NOT_RUN_NEEDS_LIVE_AUTHENTICATOR_CODE"
    : "NOT_RUN_NO_VERIFIED_ENROLLMENT"

const report = {
  generatedAt: new Date().toISOString(),
  supabaseProjectId: projectRef,
  journey: "mfa-step-up-live-probe",
  ok: checks.mfa_enrollments_readable && checks.synapse_sessions_readable,
  checks: {
    ...checks,
    verifiedEnrollments,
    platformAdminsWithMfa,
    platformAdminProbe,
    liveTotpRoundTrip,
    httpRouteProof: "apps/web/src/app/api/platform/mfa/step-up/route.test.ts",
    domainProof: "packages/auth/src/mfa-recency.test.ts",
  },
  notes: [
    "Schema/readiness verified. Live TOTP step-up still requires a human-held authenticator code for an enrolled platform admin — do not invent PASS.",
    "HTTP POST /api/platform/mfa/step-up is covered by Vitest (auth, malformed code, incorrect, not enrolled, success).",
  ],
}

const jsonPath = join(evidenceDir, `mfa-step-up-live-probe-${stamp}.json`)
const mdPath = join(evidenceDir, "mfa-step-up-live-probe-2026-09-12.md")
writeFileSync(jsonPath, JSON.stringify(report, null, 2))
writeFileSync(
  mdPath,
  `# MFA step-up live probe — 2026-09-12

## Result
- Schema readiness: **${report.ok ? "PASS" : "FAIL"}**
- Verified enrollments: **${verifiedEnrollments}**
- Platform admins with MFA: **${platformAdminsWithMfa}** (${platformAdminProbe})
- Live TOTP round-trip: **${liveTotpRoundTrip}**

## Proofs already in tree
- Domain: \`packages/auth/src/mfa-recency.test.ts\`
- HTTP: \`apps/web/src/app/api/platform/mfa/step-up/route.test.ts\`

## Remaining gate
Provide a 6-digit code from an enrolled platform admin authenticator to exercise \`POST /api/platform/mfa/step-up\` live. Until then, readiness is schema + HTTP mocked proof only.

## Artifact
\`${jsonPath.replace(root + "/", "")}\`
`,
)

// Console gets a non-sensitive summary only (CodeQL js/clear-text-logging #5);
// the full report lives in the evidence artifact written above.
console.log(`mfa-step-up-live-probe: ${report.ok ? "PASS" : "FAIL"} (schema readiness)`)
console.log(`wrote ${jsonPath}`)
console.log(`wrote ${mdPath}`)
process.exit(report.ok ? 0 : 1)
