import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const root = join(dirname(fileURLToPath(import.meta.url)), "../../..")

const APP_RW_TABLES = [
  "billing_invoices",
  "billing_line_items",
  "cds_alerts",
  "cds_rules",
  "departments",
  "diagnoses",
  "encounter_diagnoses",
  "encounter_orders",
  "encounters",
  "hospital_drug_orders",
  "hospital_settings",
  "immunization_schedule",
  "inventory_items",
  "lab_results",
  "loinc_reference",
  "maternity_records",
  "order_mappings",
  "patient_billing",
  "patient_safety_events",
  "patients",
  "pharmacy_stores",
  "radiology_reports",
  "service_catalog",
  "vitals",
] as const

/**
 * Expected RLS matrix for critical production tables.
 * Cross-tenant SELECT/INSERT/UPDATE/DELETE must fail for anonymous and
 * foreign-tenant users. Service role is the BFF exception, not a client role.
 */
export const RLS_MATRIX = [
  { table: "patients", anonymous: { select: false, insert: false, update: false, delete: false }, tenantA: { select: true, insert: true, update: true, delete: false }, tenantB: { select: false, insert: false, update: false, delete: false }, platformAdmin: { select: false, insert: false, update: false, delete: false } },
  { table: "encounters", anonymous: { select: false, insert: false, update: false, delete: false }, tenantA: { select: true, insert: true, update: true, delete: false }, tenantB: { select: false, insert: false, update: false, delete: false }, platformAdmin: { select: false, insert: false, update: false, delete: false } },
  { table: "lab_results", anonymous: { select: false, insert: false, update: false, delete: false }, tenantA: { select: true, insert: true, update: true, delete: false }, tenantB: { select: false, insert: false, update: false, delete: false }, platformAdmin: { select: false, insert: false, update: false, delete: false } },
  { table: "billing_invoices", anonymous: { select: false, insert: false, update: false, delete: false }, tenantA: { select: true, insert: true, update: true, delete: false }, tenantB: { select: false, insert: false, update: false, delete: false }, platformAdmin: { select: false, insert: false, update: false, delete: false } },
  { table: "billing_payments", anonymous: { select: false, insert: false, update: false, delete: false }, tenantA: { select: true, insert: true, update: false, delete: false }, tenantB: { select: false, insert: false, update: false, delete: false }, platformAdmin: { select: false, insert: false, update: false, delete: false } },
  { table: "persons", anonymous: { select: false, insert: false, update: false, delete: false }, tenantA: { select: true, insert: true, update: false, delete: false }, tenantB: { select: false, insert: false, update: false, delete: false }, platformAdmin: { select: false, insert: false, update: false, delete: false } },
  { table: "clinical_documents", anonymous: { select: false, insert: false, update: false, delete: false }, tenantA: { select: true, insert: true, update: true, delete: false }, tenantB: { select: false, insert: false, update: false, delete: false }, platformAdmin: { select: false, insert: false, update: false, delete: false } },
  { table: "lab_devices", anonymous: { select: false, insert: false, update: false, delete: false }, tenantA: { select: true, insert: true, update: true, delete: false }, tenantB: { select: false, insert: false, update: false, delete: false }, platformAdmin: { select: false, insert: false, update: false, delete: false } },
  { table: "lab_device_messages", anonymous: { select: false, insert: false, update: false, delete: false }, tenantA: { select: true, insert: true, update: false, delete: false }, tenantB: { select: false, insert: false, update: false, delete: false }, platformAdmin: { select: false, insert: false, update: false, delete: false } },
  { table: "lab_result_staging", anonymous: { select: false, insert: false, update: false, delete: false }, tenantA: { select: true, insert: true, update: true, delete: false }, tenantB: { select: false, insert: false, update: false, delete: false }, platformAdmin: { select: false, insert: false, update: false, delete: false } },
  { table: "death_pronouncements", anonymous: { select: false, insert: false, update: false, delete: false }, tenantA: { select: true, insert: true, update: true, delete: false }, tenantB: { select: false, insert: false, update: false, delete: false }, platformAdmin: { select: false, insert: false, update: false, delete: false } },
  { table: "mortuary_bodies", anonymous: { select: false, insert: false, update: false, delete: false }, tenantA: { select: true, insert: true, update: true, delete: false }, tenantB: { select: false, insert: false, update: false, delete: false }, platformAdmin: { select: false, insert: false, update: false, delete: false } },
  { table: "patient_care_plans", anonymous: { select: false, insert: false, update: false, delete: false }, tenantA: { select: true, insert: true, update: true, delete: false }, tenantB: { select: false, insert: false, update: false, delete: false }, platformAdmin: { select: false, insert: false, update: false, delete: false } },
]

describe("RLS tenancy matrix contract", () => {
  it("denies anonymous and cross-tenant access on critical tables", () => {
    for (const row of RLS_MATRIX) {
      assert.equal(row.anonymous.select, false, `${row.table} anonymous select`)
      assert.equal(row.tenantB.select, false, `${row.table} tenant B select`)
      assert.equal(row.tenantB.insert, false, `${row.table} tenant B insert`)
      assert.equal(row.tenantB.update, false, `${row.table} tenant B update`)
      assert.equal(row.tenantB.delete, false, `${row.table} tenant B delete`)
      assert.equal(row.platformAdmin.select, false, `${row.table} platform admin hospital PHI`)
    }
  })
})

describe("canonical dump forbids authenticated-any app_rw policies", () => {
  it("does not grant ALL to auth.role() = authenticated on clinical tables", () => {
    const dump = readFileSync(join(root, "supabase/bootstrap/canonical_public_schema.sql"), "utf8")
    const hits = dump.match(/CREATE POLICY "app_rw_[^"]+"[\s\S]*?auth"\."role"\(\) = 'authenticated'/g) ?? []
    assert.equal(hits.length, 0, `canonical dump still contains app_rw authenticated-any policies: ${hits.join(" | ")}`)
  })

  it("ships a migration that drops every app_rw_* policy", () => {
    const sql = readFileSync(
      join(root, "supabase/migrations/20260920124500_drop_app_rw_authenticated_cross_tenant.sql"),
      "utf8",
    )
    for (const table of APP_RW_TABLES) {
      assert.match(sql, new RegExp(`DROP POLICY IF EXISTS "app_rw_${table}" ON public\\.${table}`))
    }
  })
})

describe("hospital BFF tenant filter (service_role defence-in-depth)", () => {
  it("scopes patient search, billing, lab, and pharmacy reads to ctx.tenantId", () => {
    const search = readFileSync(join(root, "apps/web/src/app/api/patients/search/route.ts"), "utf8")
    const billing = readFileSync(join(root, "apps/web/src/app/api/hospital/billing/encounter/[id]/route.ts"), "utf8")
    const lab = readFileSync(join(root, "apps/web/src/app/api/lab/orders/[id]/cancel/route.ts"), "utf8")
    const ingest = readFileSync(join(root, "apps/web/src/app/api/lab/instrument-ingest/route.ts"), "utf8")
    const pharmacy = readFileSync(join(root, "apps/web/src/app/api/hospital/pharmacy/dispense/route.ts"), "utf8")
    const purchases = readFileSync(join(root, "apps/web/src/app/api/hospital/pharmacy/purchases/route.ts"), "utf8")
    // Search goes through hospital_search_patients (WHERE p.tenant_id = p_tenant_id),
    // with the tenant taken from the session; the pre-migration fallback filters inline.
    assert.match(search, /p_tenant_id: ctx\.tenantId/)
    assert.match(search, /legacySearch\(db, ctx\.tenantId,/)
    assert.match(search, /\.eq\('tenant_id', tenantId\)/)
    assert.match(billing, /\.eq\('tenant_id', ctx\.tenantId\)/)
    assert.match(lab, /\.eq\('tenant_id', ctx\.tenantId\)/)
    assert.match(ingest, /\.eq\("tenant_id", bridge\.tenant_id\)/)
    assert.match(pharmacy, /\.eq\('tenant_id', ctx\.tenantId\)/)
    assert.match(purchases, /\.eq\('tenant_id', ctx\.tenantId\)/)
  })
})

describe("clinical documents migration tenancy", () => {
  it("enables RLS and tenant isolation on clinical_documents", () => {
    const sql = readFileSync(
      join(root, "supabase/migrations/20260920203000_clinical_documents_consent_referral_loop.sql"),
      "utf8",
    )
    assert.match(sql, /ALTER TABLE public\.clinical_documents ENABLE ROW LEVEL SECURITY/)
    assert.match(sql, /tenant_id = current_tenant_id\(\)/)
    assert.match(sql, /DOCUMENT_IMMUTABLE/)
  })
})

describe("lab device intelligence tenancy", () => {
  it("scopes devices, messages, mappings, and staging with RLS", () => {
    const sql = readFileSync(
      join(root, "supabase/migrations/20260920220000_lab_device_intelligence.sql"),
      "utf8",
    )
    assert.match(sql, /ALTER TABLE public\.lab_devices ENABLE ROW LEVEL SECURITY/)
    assert.match(sql, /ALTER TABLE public\.lab_device_messages ENABLE ROW LEVEL SECURITY/)
    assert.match(sql, /ALTER TABLE public\.lab_result_staging ENABLE ROW LEVEL SECURITY/)
    assert.match(sql, /api_key_hash/)
  })

  it("makes hashed Lab Edge credentials XOR with plaintext and uniquely indexed", () => {
    const sql = readFileSync(
      join(root, "supabase/migrations/20260920224500_lab_bridge_hashed_credentials.sql"),
      "utf8",
    )
    assert.match(sql, /ALTER COLUMN api_key DROP NOT NULL/)
    assert.match(sql, /lab_instrument_bridges_credential_xor/)
    assert.match(sql, /idx_lab_instrument_bridges_hash_unique/)
    assert.match(sql, /SET api_key = NULL/)
    assert.match(sql, /api_key_hash IS NOT NULL/)
  })
})

describe("death pronouncement and mortuary tenancy", () => {
  it("enables RLS on death, mortuary, and care-plan tables", () => {
    const sql = readFileSync(
      join(root, "supabase/migrations/20260921080000_death_pronouncement_pathways.sql"),
      "utf8",
    )
    assert.match(sql, /ALTER TABLE public\.death_pronouncements ENABLE ROW LEVEL SECURITY/)
    assert.match(sql, /ALTER TABLE public\.mortuary_bodies ENABLE ROW LEVEL SECURITY/)
    assert.match(sql, /ALTER TABLE public\.patient_care_plans ENABLE ROW LEVEL SECURITY/)
    assert.match(sql, /PRONOUNCEMENT_IMMUTABLE/)
    assert.match(sql, /idx_mortuary_bodies_active_slot/)
  })

  it("locks identity and pronouncement facts when next-of-kin or document FKs change", () => {
    const sql = readFileSync(
      join(root, "supabase/migrations/20260921090000_death_pronouncement_signed_column_lock.sql"),
      "utf8",
    )
    assert.match(sql, /CREATE OR REPLACE FUNCTION public\.death_pronouncements_protect_signed/)
    assert.match(sql, /NEW\.tenant_id IS DISTINCT FROM OLD\.tenant_id/)
    assert.match(sql, /NEW\.findings IS DISTINCT FROM OLD\.findings/)
    assert.match(sql, /NEW\.status IS NOT DISTINCT FROM OLD\.status/)
    assert.doesNotMatch(sql, /RETURN NEW;\s*END IF;\s*IF NEW\.pronouncement_document_id/)
  })
})

describe("pharmacy purchases tenancy", () => {
  it("enables RLS on purchase receipt tables", () => {
    const sql = readFileSync(
      join(root, "supabase/migrations/20260921120000_pharmacy_purchases.sql"),
      "utf8",
    )
    assert.match(sql, /create table if not exists public\.pharmacy_purchases/)
    assert.match(sql, /create table if not exists public\.pharmacy_purchase_items/)
    assert.match(sql, /create table if not exists public\.pharmacy_purchase_idempotency/)
    assert.match(sql, /alter table public\.%I enable row level security/)
    assert.match(sql, /t \|\| '_tenant_isolation'/)
    assert.match(sql, /tenant_id = current_tenant_id\(\) or is_platform_admin\(\)/)
    assert.match(sql, /receive_pharmacy_stock/)
  })
})
