#!/usr/bin/env node
/**
 * Seed the synthetic tenant the concurrency suite binds to.
 *
 * Unlike scripts/pharmacy-test-setup.mjs this never reads an env file and never
 * touches a real domain: every address is @synapseos.invalid, the tenant is
 * marked is_synthetic / data_classification='synthetic' / environment='demo',
 * and the target must already have passed resolveAcceptanceTarget.
 *
 *   SYNAPSE_PHARMACY_DB_REMOTE=1 \
 *   SYNAPSE_E2E_SUPABASE_URL=... SYNAPSE_E2E_SERVICE_ROLE_KEY=... \
 *   SYNAPSE_E2E_ANON_KEY=... \
 *   node scripts/db-tests/seed-pharmacy-acceptance-fixture.mjs
 *
 * Idempotent: an existing ZZ Synthetic Pharmacy tenant is reused, and a cashier
 * profile is added only when the tenant has none.
 *
 * Exit codes: 0 seeded or already present, 1 refused target, 2 REST failure.
 */
import { randomUUID } from "node:crypto"
import { resolveAcceptanceTarget } from "../e2e-acceptance-isolation.mjs"

if (process.env.SYNAPSE_PHARMACY_DB_REMOTE !== "1") {
  console.error(
    "REFUSED: set SYNAPSE_PHARMACY_DB_REMOTE=1 to confirm you mean to write fixtures\n" +
      "into a remote disposable project.",
  )
  process.exit(1)
}

const target = resolveAcceptanceTarget(process.env)
if (target.status !== "FOUND") {
  console.error("REFUSED: the acceptance target is not unambiguous")
  for (const problem of target.problems) console.error(`  - ${problem}`)
  process.exit(1)
}

const url = process.env.SYNAPSE_E2E_SUPABASE_URL.replace(/\/$/, "")
const serviceKey = process.env.SYNAPSE_E2E_SERVICE_ROLE_KEY
const TENANT_NAME = "ZZ Synthetic Pharmacy Acceptance"

async function rest(path, init = {}) {
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
  if (!response.ok) {
    throw new Error(`REST ${init.method ?? "GET"} ${path.split("?")[0]} -> HTTP ${response.status}: ${text.slice(0, 300)}`)
  }
  return text ? JSON.parse(text) : null
}

const q = (value) => encodeURIComponent(value)

async function main() {
  const existing = await rest(
    `/tenants?select=id,name,slug&name=ilike.${q("ZZ Synthetic Pharmacy%")}&order=created_at&limit=1`,
  )
  let tenant = existing?.[0] ?? null
  let created = false

  if (!tenant) {
    const slug = `zz-synthetic-${randomUUID().slice(0, 8)}`
    const rows = await rest("/tenants", {
      method: "POST",
      body: JSON.stringify({
        id: randomUUID(),
        name: TENANT_NAME,
        slug,
        facility_type: "pharmacy",
        district: "Synthetic",
        is_active: true,
        status: "active",
        plan: "starter",
        email: `acceptance.tenant.${slug}@synapseos.invalid`,
        is_synthetic: true,
        data_classification: "synthetic",
        environment: "demo",
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }),
    })
    tenant = rows[0]
    created = true
  }

  const profiles = await rest(`/profiles?select=id&tenant_id=eq.${tenant.id}&limit=1`)
  let profileId = profiles?.[0]?.id ?? null
  let profileCreated = false

  if (!profileId) {
    const rows = await rest("/profiles", {
      method: "POST",
      body: JSON.stringify({
        id: randomUUID(),
        email: `cashier.acceptance.${randomUUID().slice(0, 8)}@synapseos.invalid`,
        full_name: "Synthetic Acceptance Cashier",
        first_name: "Synthetic",
        last_name: "Cashier",
        role: "pharmacy_cashier",
        tenant_id: tenant.id,
        is_admin: false,
        must_change_password: false,
        email_verified_at: new Date().toISOString(),
        verification_status: "verified",
      }),
    })
    profileId = rows[0].id
    profileCreated = true
  }

  const plans = await rest("/subscription_plans?select=id&slug=eq.synapse_pharmacy_annual&limit=1")
  const planPresent = Boolean(plans?.[0]?.id)

  console.log(JSON.stringify({
    ok: true,
    projectRef: target.projectRef,
    tenant: { id: tenant.id, slug: tenant.slug, name: tenant.name, created },
    profile: { id: profileId, created: profileCreated },
    subscriptionPlan: planPresent
      ? "synapse_pharmacy_annual present"
      : "synapse_pharmacy_annual missing (the subscription test tolerates a null plan_id; the rest do not need it)",
    note: "Synthetic fixture rows only. Addresses use the reserved .invalid TLD.",
  }, null, 2))
}

main().catch((error) => {
  console.error(`FAILED: ${error.message}`)
  process.exit(2)
})
