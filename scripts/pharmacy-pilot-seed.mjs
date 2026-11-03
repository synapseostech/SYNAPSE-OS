/**
 * Synapse Pharm — realistic pilot seed for staging / dry-runs.
 *
 * Creates (or refreshes inventory on) a dedicated tenant:
 *   slug: pharm-synapse-pilot
 *   name: Synapse Pilot Pharmacy
 *
 * Staff password for all seeded accounts: PilotDemo2026!
 *
 * Usage:
 *   node scripts/pharmacy-pilot-seed.mjs
 *   node scripts/pharmacy-pilot-seed.mjs --reset-inventory
 *   npm run seed:pharmacy-pilot
 *
 * Requires SUPABASE_URL (or NEXT_PUBLIC_SUPABASE_URL) + SUPABASE_SERVICE_ROLE_KEY
 * in env or apps/pharmacy/.env.local / apps/web/.env.local.
 */
import { readFileSync } from "node:fs"
import { resolve, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { createRequire } from "node:module"

const require = createRequire(import.meta.url)
const bcrypt = require("bcryptjs")

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = resolve(__dirname, "..")

const PILOT_SLUG = "pharm-synapse-pilot"
const PILOT_NAME = "Synapse Pilot Pharmacy"
const PILOT_PASSWORD = "PilotDemo2026!"
const DISTRICT = "Kampala"

function loadEnv(file) {
  try {
    const text = readFileSync(resolve(root, file), "utf8")
    for (const line of text.split("\n")) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith("#")) continue
      const eq = trimmed.indexOf("=")
      if (eq === -1) continue
      const key = trimmed.slice(0, eq).trim()
      let val = trimmed.slice(eq + 1).trim()
      if (
        (val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))
      ) {
        val = val.slice(1, -1)
      }
      if (!process.env[key]) process.env[key] = val
    }
  } catch {
    /* optional */
  }
}

loadEnv("apps/web/.env.local")
loadEnv("apps/pharmacy/.env.local")

const supabaseUrl = (
  process.env.SUPABASE_URL ??
  process.env.NEXT_PUBLIC_SUPABASE_URL ??
  ""
).trim()
const serviceKey = (process.env.SUPABASE_SERVICE_ROLE_KEY ?? "").trim()

if (!supabaseUrl || !serviceKey) {
  console.error(
    "Missing SUPABASE_URL / NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY",
  )
  process.exit(1)
}

const headers = {
  apikey: serviceKey,
  Authorization: `Bearer ${serviceKey}`,
  "Content-Type": "application/json",
  Prefer: "return=representation",
}

async function rest(path, options = {}) {
  const res = await fetch(`${supabaseUrl}/rest/v1/${path}`, {
    ...options,
    headers: { ...headers, ...options.headers },
  })
  const text = await res.text()
  let data = null
  try {
    data = text ? JSON.parse(text) : null
  } catch {
    data = text
  }
  if (!res.ok) {
    const msg =
      typeof data === "object" && data?.message
        ? data.message
        : text || res.statusText
    throw new Error(`${options.method || "GET"} ${path}: ${msg}`)
  }
  return data
}

function addDays(isoDate, days) {
  const d = new Date(`${isoDate}T12:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

const today = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Africa/Kampala",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
}).format(new Date())

/** Catalog: Uganda counter realities — FEFO scenarios baked into batches. */
const CATALOG = [
  {
    sku: "PARA-500",
    name: "Paracetamol 500mg tablets",
    genericName: "Paracetamol",
    strength: "500mg",
    dosageForm: "tablet",
    category: "Analgesic",
    price: 100,
    cost: 40,
    reorder: 50,
    requiresPrescription: false,
    batches: [
      { batch: "PARA-EXP", qty: 20, expiry: addDays(today, -30), cost: 35 }, // expired — FEFO must skip
      { batch: "PARA-SOON", qty: 40, expiry: addDays(today, 45), cost: 38 },
      { batch: "PARA-OK", qty: 120, expiry: addDays(today, 400), cost: 40 },
    ],
  },
  {
    sku: "AMOX-250",
    name: "Amoxicillin 250mg capsules",
    genericName: "Amoxicillin",
    strength: "250mg",
    dosageForm: "capsule",
    category: "Antibiotic",
    price: 350,
    cost: 180,
    reorder: 30,
    requiresPrescription: true,
    batches: [
      { batch: "AMOX-A", qty: 60, expiry: addDays(today, 120), cost: 175 },
      { batch: "AMOX-B", qty: 80, expiry: addDays(today, 300), cost: 180 },
    ],
  },
  {
    sku: "ORS-20",
    name: "ORS sachets (WHO formula)",
    genericName: "Oral rehydration salts",
    strength: "20.5g",
    dosageForm: "sachet",
    category: "Rehydration",
    price: 500,
    cost: 220,
    reorder: 40,
    requiresPrescription: false,
    batches: [{ batch: "ORS-1", qty: 200, expiry: addDays(today, 500), cost: 220 }],
  },
  {
    sku: "AL-20-120",
    name: "Artemether/Lumefantrine 20/120mg",
    genericName: "Artemether + Lumefantrine",
    strength: "20/120mg",
    dosageForm: "tablet",
    category: "Antimalarial",
    price: 4500,
    cost: 2800,
    reorder: 20,
    requiresPrescription: true,
    batches: [
      { batch: "AL-NEAR", qty: 15, expiry: addDays(today, 60), cost: 2750 },
      { batch: "AL-FAR", qty: 50, expiry: addDays(today, 360), cost: 2800 },
    ],
  },
  {
    sku: "MET-400",
    name: "Metronidazole 400mg tablets",
    genericName: "Metronidazole",
    strength: "400mg",
    dosageForm: "tablet",
    category: "Antibiotic",
    price: 200,
    cost: 90,
    reorder: 40,
    requiresPrescription: true,
    batches: [{ batch: "MET-1", qty: 100, expiry: addDays(today, 280), cost: 90 }],
  },
  {
    sku: "IBU-400",
    name: "Ibuprofen 400mg tablets",
    genericName: "Ibuprofen",
    strength: "400mg",
    dosageForm: "tablet",
    category: "Analgesic",
    price: 150,
    cost: 60,
    reorder: 40,
    requiresPrescription: false,
    batches: [
      { batch: "IBU-LOW", qty: 8, expiry: addDays(today, 200), cost: 58 }, // low stock vs reorder
      { batch: "IBU-MAIN", qty: 25, expiry: addDays(today, 450), cost: 60 },
    ],
  },
  {
    sku: "CET-10",
    name: "Cetirizine 10mg tablets",
    genericName: "Cetirizine",
    strength: "10mg",
    dosageForm: "tablet",
    category: "Antihistamine",
    price: 250,
    cost: 110,
    reorder: 20,
    requiresPrescription: false,
    batches: [{ batch: "CET-1", qty: 90, expiry: addDays(today, 320), cost: 110 }],
  },
  {
    sku: "ZINC-20",
    name: "Zinc sulphate 20mg dispersible",
    genericName: "Zinc sulphate",
    strength: "20mg",
    dosageForm: "tablet",
    category: "Supplement",
    price: 300,
    cost: 140,
    reorder: 30,
    requiresPrescription: false,
    batches: [{ batch: "ZN-1", qty: 150, expiry: addDays(today, 600), cost: 140 }],
  },
  {
    sku: "MVIT-SYR",
    name: "Multivitamin syrup 100ml",
    genericName: "Multivitamins",
    strength: "100ml",
    dosageForm: "syrup",
    category: "Supplement",
    price: 8000,
    cost: 4200,
    reorder: 10,
    requiresPrescription: false,
    batches: [{ batch: "MV-1", qty: 24, expiry: addDays(today, 240), cost: 4200 }],
  },
  {
    sku: "SYR-5ML",
    name: "Disposable syringe 5ml",
    genericName: "Syringe",
    strength: "5ml",
    dosageForm: "device",
    category: "Consumable",
    price: 300,
    cost: 120,
    reorder: 100,
    requiresPrescription: false,
    // expiry_date is NOT NULL on pharmacy_product_batches — use far-future for consumables
    batches: [{ batch: "SYR-1", qty: 500, expiry: "2099-12-31", cost: 120 }],
  },
]

/**
 * profiles.role is constrained (pharmacy_admin|pharmacy_staff|pharmacy_ceo|pharmacist|…).
 * pharmacy_user_settings.pharmacy_role carries the capability role used by auth.
 */
const STAFF = [
  {
    email: "pilot.admin@synapseos.tech",
    fullName: "Pilot Admin",
    profileRole: "pharmacy_admin",
    pharmacyRole: "pharmacy_admin",
    isAdmin: true,
  },
  {
    email: "pilot.cashier@synapseos.tech",
    fullName: "Pilot Cashier",
    profileRole: "pharmacy_staff",
    pharmacyRole: "pharmacy_cashier",
    isAdmin: false,
  },
  {
    email: "pilot.pharmacist@synapseos.tech",
    fullName: "Pilot Pharmacist",
    profileRole: "pharmacist",
    pharmacyRole: "pharmacist",
    isAdmin: false,
  },
  {
    email: "pilot.inventory@synapseos.tech",
    fullName: "Pilot Inventory",
    profileRole: "pharmacy_staff",
    pharmacyRole: "inventory_officer",
    isAdmin: false,
  },
  {
    email: "pilot.manager@synapseos.tech",
    fullName: "Pilot Manager",
    profileRole: "pharmacy_staff",
    pharmacyRole: "pharmacy_store_manager",
    isAdmin: false,
  },
]

async function ensureTenant() {
  const existing = await rest(
    `tenants?slug=eq.${PILOT_SLUG}&select=id,name,slug,status&limit=1`,
  )
  if (existing?.length) return existing[0]

  const tenantId = crypto.randomUUID()
  const created = await rest("tenants", {
    method: "POST",
    body: JSON.stringify({
      id: tenantId,
      slug: PILOT_SLUG,
      name: PILOT_NAME,
      facility_type: "pharmacy",
      district: DISTRICT,
      is_active: true,
      status: "active",
      plan: "starter",
      email: STAFF[0].email,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }),
  })
  return created?.[0] ?? { id: tenantId, slug: PILOT_SLUG, name: PILOT_NAME }
}

/**
 * A tenant with no `tenant_subscriptions` row fails every `has_feature()` check,
 * so the seeded pharmacy could not complete a sale. Onboarding must create this
 * row; the seed does the same for the pilot tenant.
 */
async function ensureSubscription(tenantId) {
  const existing = await rest(
    `tenant_subscriptions?tenant_id=eq.${tenantId}&select=id,status,plan_id&limit=1`,
  )
  if (existing?.length) return existing[0]

  const plans = await rest(
    "subscription_plans?slug=eq.synapse_pharmacy_annual&select=id,slug&limit=1",
  )
  const plan = plans?.[0]
  if (!plan) throw new Error("Plan synapse_pharmacy_annual is missing from this project")

  const rows = await rest("tenant_subscriptions", {
    method: "POST",
    body: JSON.stringify({
      tenant_id: tenantId,
      plan_id: plan.id,
      status: "active",
      starts_at: new Date().toISOString(),
      current_period_start: new Date().toISOString(),
      current_period_end: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(),
    }),
  })
  return rows?.[0] ?? { tenant_id: tenantId, plan_id: plan.id, status: "active" }
}

async function ensureStaff(tenantId, passwordHash) {
  const out = []
  for (const person of STAFF) {
    const rows = await rest(
      `profiles?email=eq.${encodeURIComponent(person.email)}&select=id,email,tenant_id&limit=1`,
    )
    let profileId = rows?.[0]?.id
    if (!profileId) {
      profileId = crypto.randomUUID()
      // `rest` is the HTTP helper at module scope; a local `...rest` here
      // shadowed it and made every call below throw "rest is not a function".
      const [first, ...nameRest] = person.fullName.split(" ")
      await rest("profiles", {
        method: "POST",
        body: JSON.stringify({
          id: profileId,
          email: person.email,
          full_name: person.fullName,
          first_name: first,
          last_name: nameRest.join(" ") || "Pilot",
          role: person.profileRole,
          tenant_id: tenantId,
          is_admin: person.isAdmin,
          password_hash: passwordHash,
          must_change_password: false,
          email_verified_at: new Date().toISOString(),
          verification_status: "verified",
        }),
      })
    } else {
      await rest(`profiles?id=eq.${profileId}`, {
        method: "PATCH",
        headers: { Prefer: "return=minimal" },
        body: JSON.stringify({
          tenant_id: tenantId,
          role: person.profileRole,
          is_admin: person.isAdmin,
          password_hash: passwordHash,
          must_change_password: false,
          email_verified_at: new Date().toISOString(),
        }),
      })
    }

    const settings = await rest(
      `pharmacy_user_settings?profile_id=eq.${profileId}&select=id&limit=1`,
    )
    if (!settings?.length) {
      await rest("pharmacy_user_settings", {
        method: "POST",
        body: JSON.stringify({
          profile_id: profileId,
          tenant_id: tenantId,
          pharmacy_role: person.pharmacyRole,
          permissions: [],
          is_active: true,
          must_change_password: false,
        }),
      })
    } else {
      await rest(`pharmacy_user_settings?profile_id=eq.${profileId}`, {
        method: "PATCH",
        headers: { Prefer: "return=minimal" },
        body: JSON.stringify({
          tenant_id: tenantId,
          pharmacy_role: person.pharmacyRole,
          is_active: true,
          must_change_password: false,
        }),
      })
    }

    out.push({ ...person, role: person.pharmacyRole, profileId })
  }
  return out
}

async function ensureStore(tenantId) {
  const stores = await rest(
    `pharmacy_stores?tenant_id=eq.${tenantId}&is_active=eq.true&select=id,name&limit=1`,
  )
  if (stores?.length) return stores[0]
  const created = await rest("pharmacy_stores", {
    method: "POST",
    body: JSON.stringify({
      tenant_id: tenantId,
      name: `${PILOT_NAME} — Main Branch`,
      store_type: "main",
      is_active: true,
    }),
  })
  return created?.[0]
}

async function ensureSettings(tenantId) {
  const rows = await rest(
    `pharmacy_settings?tenant_id=eq.${tenantId}&select=id&limit=1`,
  )
  const payload = {
    tenant_id: tenantId,
    pharmacy_name: PILOT_NAME,
    location: `${DISTRICT}, Uganda`,
    contact: "+256700000001",
    email: STAFF[0].email,
    currency: "UGX",
    tax_rate: 0,
    vat_enabled: false,
    vat_rate: 18,
    discount_approval_threshold_pct: 5,
    low_stock_threshold: 20,
    receipt_header: PILOT_NAME,
    receipt_footer: "Thank you — Africa/Kampala time",
    updated_at: new Date().toISOString(),
  }
  if (!rows?.length) {
    await rest("pharmacy_settings", {
      method: "POST",
      body: JSON.stringify(payload),
    })
  } else {
    await rest(`pharmacy_settings?tenant_id=eq.${tenantId}`, {
      method: "PATCH",
      headers: { Prefer: "return=minimal" },
      body: JSON.stringify(payload),
    })
  }
}

async function ensureSuppliers(tenantId) {
  const names = [
    { name: "Joint Medical Store", phone: "+256414510000", contact_person: "JMS Desk" },
    { name: "National Medical Stores", phone: "+256414340000", contact_person: "NMS Desk" },
  ]
  const ids = []
  for (const s of names) {
    const existing = await rest(
      `pharmacy_suppliers?tenant_id=eq.${tenantId}&name=eq.${encodeURIComponent(s.name)}&select=id&limit=1`,
    )
    if (existing?.length) {
      ids.push(existing[0].id)
      continue
    }
    const created = await rest("pharmacy_suppliers", {
      method: "POST",
      body: JSON.stringify({
        tenant_id: tenantId,
        ...s,
        address: DISTRICT,
        is_active: true,
      }),
    })
    ids.push(created?.[0]?.id)
  }
  return ids
}

async function ensureCustomers(tenantId) {
  const customers = [
    { name: "Walk-in Customer", phone: "+256700111222" },
    { name: "Nakato Grace", phone: "+256701222333", email: "nakato.pilot@example.com" },
    { name: "Okello Credit Account", phone: "+256702333444" },
  ]
  for (const c of customers) {
    const q = c.phone
      ? `pharmacy_customers?tenant_id=eq.${tenantId}&phone=eq.${encodeURIComponent(c.phone)}&select=id&limit=1`
      : `pharmacy_customers?tenant_id=eq.${tenantId}&name=eq.${encodeURIComponent(c.name)}&select=id&limit=1`
    const existing = await rest(q)
    if (existing?.length) continue
    await rest("pharmacy_customers", {
      method: "POST",
      body: JSON.stringify({
        tenant_id: tenantId,
        name: c.name,
        phone: c.phone ?? null,
        email: c.email ?? null,
        is_active: true,
      }),
    })
  }
}

async function resetInventory(tenantId) {
  // Delete batches then products for this tenant only (pilot slug guard done by caller).
  await rest(`pharmacy_product_batches?tenant_id=eq.${tenantId}`, {
    method: "DELETE",
    headers: { Prefer: "return=minimal" },
  })
  await rest(`pharmacy_products?tenant_id=eq.${tenantId}`, {
    method: "DELETE",
    headers: { Prefer: "return=minimal" },
  })
}

async function seedCatalog(tenantId, supplierId) {
  let productCount = 0
  let batchCount = 0

  for (const item of CATALOG) {
    const existing = await rest(
      `pharmacy_products?tenant_id=eq.${tenantId}&sku=eq.${encodeURIComponent(item.sku)}&select=id&limit=1`,
    )
    if (existing?.length) {
      productCount += 1
      continue
    }

    const qty = item.batches.reduce((s, b) => s + b.qty, 0)
    // Earliest non-expired for product.expiry_date display
    const liveExpiries = item.batches
      .map((b) => b.expiry)
      .filter((e) => e && e >= today)
      .sort()
    const created = await rest("pharmacy_products", {
      method: "POST",
      body: JSON.stringify({
        tenant_id: tenantId,
        name: item.name,
        sku: item.sku,
        barcode: `600${item.sku.replace(/[^0-9A-Z]/gi, "").slice(0, 10)}`,
        category: item.category,
        generic_name: item.genericName,
        active_ingredient: item.genericName,
        strength: item.strength,
        dosage_form: item.dosageForm,
        unit_of_measure: "unit",
        price: item.price,
        cost_price: item.cost,
        quantity: qty,
        reorder_level: item.reorder,
        requires_prescription: item.requiresPrescription,
        supplier_id: supplierId ?? null,
        expiry_date: liveExpiries[0] ?? item.batches[0]?.expiry ?? null,
        is_active: true,
        manufacturer: "Pilot Seed Co.",
      }),
    })
    const productId = created?.[0]?.id
    if (!productId) continue
    productCount += 1

    for (const b of item.batches) {
      await rest("pharmacy_product_batches", {
        method: "POST",
        body: JSON.stringify({
          tenant_id: tenantId,
          product_id: productId,
          batch_number: b.batch,
          quantity: b.qty,
          initial_quantity: b.qty,
          expiry_date: b.expiry,
          cost_price: b.cost,
          is_active: true,
          manufacturer: "Pilot Seed Co.",
          received_date: new Date().toISOString(),
          notes:
            b.expiry && b.expiry < today
              ? "SEED: expired batch — FEFO must skip"
              : b.expiry && addDays(today, 90) >= b.expiry
                ? "SEED: near-expiry"
                : "SEED: healthy stock",
        }),
      })
      batchCount += 1
    }
  }

  return { productCount, batchCount }
}

async function main() {
  const reset = process.argv.includes("--reset-inventory")
  const passwordHash = await bcrypt.hash(PILOT_PASSWORD, 12)

  const tenant = await ensureTenant()
  const tenantId = tenant.id
  console.log(`Tenant: ${tenant.name} (${tenant.slug}) ${tenantId}`)

  try {
    await rest("pharmacy_profiles", {
      method: "POST",
      body: JSON.stringify({
        tenant_id: tenantId,
        pharmacy_name: PILOT_NAME,
        district: DISTRICT,
        contact_email: STAFF[0].email,
        default_domain: `https://pharm.synapseos.tech/synapse-pilot`,
        is_network_visible: false,
        migration_status: "ready",
      }),
    })
  } catch {
    /* may already exist */
  }

  const subscription = await ensureSubscription(tenantId)
  console.log(`Subscription: ${subscription.status} ${subscription.plan_id}`)

  const staff = await ensureStaff(tenantId, passwordHash)
  const store = await ensureStore(tenantId)
  await ensureSettings(tenantId)
  const supplierIds = await ensureSuppliers(tenantId)
  await ensureCustomers(tenantId)

  if (reset) {
    console.log("Resetting pilot inventory…")
    await resetInventory(tenantId)
  }

  const { productCount, batchCount } = await seedCatalog(tenantId, supplierIds[0])

  console.log(
    JSON.stringify(
      {
        ok: true,
        tenantId,
        slug: PILOT_SLUG,
        store,
        products: productCount,
        batches: batchCount,
        password: PILOT_PASSWORD,
        loginUrl: "https://pharm.synapseos.tech/login",
        staff: staff.map((s) => ({
          email: s.email,
          role: s.role,
          profileId: s.profileId,
        })),
        scenarios: [
          "POS sell as pilot.cashier@synapseos.tech",
          "FEFO: Paracetamol should pick PARA-SOON before PARA-OK; skip PARA-EXP",
          "Discount >5% needs pilot.manager@ or pilot.admin@",
          "Inventory adjust as pilot.inventory@ — cashier should 403",
          "Ibuprofen is near reorder for low-stock alerts",
        ],
      },
      null,
      2,
    ),
  )
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
})
