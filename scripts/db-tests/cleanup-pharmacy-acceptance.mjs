#!/usr/bin/env node
/**
 * Remove the synthetic tenants an acceptance run created.
 *
 * Scope is deliberately narrow: only tenants that are is_synthetic=true WITH
 * data_classification='synthetic' AND created at or after an operator-supplied
 * timestamp. Anything else is untouched. The script is a dry run unless
 * --apply is passed, and --apply needs --confirm-project with the exact ref.
 *
 *   SYNAPSE_PHARMACY_DB_REMOTE=1 \
 *   SYNAPSE_E2E_ACCEPTANCE_PROJECT_REF=<ref> SYNAPSE_E2E_SUPABASE_URL=... \
 *   SYNAPSE_E2E_SERVICE_ROLE_KEY=... SYNAPSE_E2E_ANON_KEY=... \
 *   node scripts/db-tests/cleanup-pharmacy-acceptance.mjs \
 *     --created-after 2026-11-02T00:00:00Z [--apply --confirm-project <ref>]
 *
 * Deleting the whole disposable project stays the authoritative cleanup; this
 * script exists so a project that must be kept can still be reset. Auth users
 * that the RLS/refund suites create are removed by those suites' own teardown.
 *
 * Exit codes: 0 done or nothing to do, 1 refused, 2 REST failure, 3 blocked by
 * foreign keys (delete the disposable project instead).
 */
import { resolveAcceptanceTarget } from "../e2e-acceptance-isolation.mjs"

const args = process.argv.slice(2)
const flag = (name) => {
  const index = args.indexOf(name)
  return index >= 0 ? args[index + 1] ?? "" : ""
}
const apply = args.includes("--apply")
const createdAfter = flag("--created-after")
const confirmProject = flag("--confirm-project")
const MAX_ROWS = 20

const refuse = (message) => {
  console.error(`REFUSED: ${message}`)
  process.exit(1)
}

if (process.env.SYNAPSE_PHARMACY_DB_REMOTE !== "1") {
  refuse("set SYNAPSE_PHARMACY_DB_REMOTE=1 to confirm this targets a remote disposable project.")
}

const target = resolveAcceptanceTarget(process.env)
if (target.status !== "FOUND") {
  console.error("REFUSED: the acceptance target is not unambiguous")
  for (const problem of target.problems) console.error(`  - ${problem}`)
  process.exit(1)
}

if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?Z$/.test(createdAfter)) {
  refuse("--created-after must be an ISO-8601 UTC timestamp, e.g. 2026-11-02T00:00:00Z")
}
const cutoff = new Date(createdAfter)
if (Number.isNaN(cutoff.getTime())) refuse("--created-after is not a valid date")

if (apply && confirmProject !== target.projectRef) {
  refuse(`--apply needs --confirm-project ${target.projectRef} (the validated target ref).`)
}

const url = process.env.SYNAPSE_E2E_SUPABASE_URL.replace(/\/$/, "")
const serviceKey = process.env.SYNAPSE_E2E_SERVICE_ROLE_KEY

async function rest(path, init = {}) {
  try {
    const response = await fetch(`${url}/rest/v1${path}`, {
      ...init,
      headers: {
        apikey: serviceKey,
        Authorization: `Bearer ${serviceKey}`,
        "Content-Type": "application/json",
        Prefer: "return=representation",
        ...(init.headers ?? {}),
      },
    })
    const text = await response.text()
    return { response, text }
  } catch (error) {
    // Unreachable project, paused project, or no DNS in this shell.
    return { response: { ok: false, status: "network" }, text: error?.cause?.code ?? error?.message ?? "fetch failed" }
  }
}

const scope =
  `/tenants?select=id,name,slug,created_at` +
  `&is_synthetic=eq.true&data_classification=eq.synthetic` +
  `&created_at=gte.${encodeURIComponent(cutoff.toISOString())}` +
  `&order=created_at`

const listed = await rest(scope)
if (!listed.response.ok) {
  console.error(`FAILED: could not list synthetic tenants -> HTTP ${listed.response.status}: ${listed.text.slice(0, 300)}`)
  process.exit(2)
}
const tenants = JSON.parse(listed.text || "[]")

console.log(`target:         project ${target.projectRef}`)
console.log(`scope:          is_synthetic=true AND data_classification='synthetic' AND created_at >= ${cutoff.toISOString()}`)
console.log(`matched:        ${tenants.length} tenant(s)`)

for (const tenant of tenants) {
  console.log(`  ${tenant.id}  ${tenant.created_at}  ${tenant.name} (${tenant.slug})`)
}

if (tenants.length === 0) {
  console.log("\nnothing to remove")
  process.exit(0)
}

if (tenants.length > MAX_ROWS) {
  refuse(`${tenants.length} tenants match, more than the ${MAX_ROWS} this script will delete in one pass. Narrow --created-after or delete the disposable project.`)
}

if (!apply) {
  console.log("\nDRY RUN: nothing was deleted. Re-run with --apply --confirm-project " + target.projectRef)
  process.exit(0)
}

const ids = tenants.map((tenant) => tenant.id).join(",")
const deleted = await rest(`/tenants?id=in.(${ids})`, { method: "DELETE" })

if (deleted.response.status === 409) {
  console.error(
    "\nBLOCKED: a foreign key still references these tenants, so a partial delete was refused.\n" +
      "The authoritative cleanup is to delete the disposable Supabase project.\n" +
      `Detail: ${deleted.text.slice(0, 400)}`,
  )
  process.exit(3)
}
if (!deleted.response.ok) {
  console.error(`FAILED: delete -> HTTP ${deleted.response.status}: ${deleted.text.slice(0, 300)}`)
  process.exit(2)
}

const after = await rest(scope)
if (!after.response.ok) {
  console.error(`FAILED: could not verify the result -> HTTP ${after.response.status}`)
  process.exit(2)
}
const remaining = JSON.parse(after.text || "[]")
console.log(`deleted:        ${tenants.length} tenant(s)`)
console.log(`remaining:      ${remaining.length} in scope`)
process.exit(remaining.length === 0 ? 0 : 2)
