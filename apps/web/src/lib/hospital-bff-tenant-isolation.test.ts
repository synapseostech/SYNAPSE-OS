import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

const root = join(dirname(fileURLToPath(import.meta.url)), "../../../..")

function src(rel: string) {
  return readFileSync(join(root, rel), "utf8")
}

describe("hospital OS data boundary", () => {
  it("does not query patients through the anon SSR client", () => {
    expect(src("apps/web/src/app/os/[slug]/patients/page.tsx")).not.toMatch(/createClient/)
    expect(src("apps/web/src/app/os/[slug]/patients/[id]/page.tsx")).not.toMatch(/createClient/)
    expect(src("apps/web/src/app/os/[slug]/dashboard/page.tsx")).not.toMatch(/createServiceClient/)
    expect(src("apps/web/src/lib/hospital-os-data.ts")).toMatch(/eq\("tenant_id", tenantId\)/)
    expect(src("apps/web/src/lib/supabase/client.ts")).not.toMatch(/SERVICE_ROLE/)
  })
})

describe("hospital BFF explicit tenant filters", () => {
  const files = [
    "apps/web/src/app/api/patients/search/route.ts",
    "apps/web/src/app/api/opd/queue/route.ts",
    "apps/web/src/app/api/nurse/ward/route.ts",
    "apps/web/src/app/api/emergency/queue/route.ts",
    "apps/web/src/app/api/opd/encounters/[id]/write-up/route.ts",
    "apps/web/src/app/api/opd/lab-orders/route.ts",
    "apps/web/src/app/api/opd/prescriptions/route.ts",
    "apps/web/src/app/api/hospital/billing/encounter/[id]/route.ts",
    "apps/web/src/app/api/hospital/billing/encounter/[id]/pay/route.ts",
    "apps/web/src/app/api/hospital/pharmacy/dispense/route.ts",
    "apps/web/src/app/api/hospital/pharmacy/purchases/route.ts",
    "apps/web/src/app/api/lab/orders/[id]/cancel/route.ts",
    "apps/web/src/app/api/clinical/documents/route.ts",
    "apps/web/src/app/api/patient/consent/route.ts",
    "apps/web/src/app/api/lab/instruments/route.ts",
    "apps/web/src/app/api/lab/interpretation/route.ts",
    "apps/web/src/app/api/clinical/death-pronouncements/route.ts",
    "apps/web/src/app/api/mortuary/bodies/route.ts",
    "apps/web/src/app/api/mortuary/tag/[bodyNumber]/route.ts",
    "apps/web/src/app/api/opd/encounters/[id]/disposition/route.ts",
    "apps/web/src/app/api/clinical/pathways/care-plans/route.ts",
    "apps/web/src/app/api/hospital/billing/invoices/route.ts",
    "apps/web/src/app/api/hospital/billing/invoices/[id]/route.ts",
    "apps/web/src/app/api/hospital/billing/invoices/[id]/cover/route.ts",
    "apps/web/src/app/api/ipd/admissions/route.ts",
    "apps/web/src/app/api/ipd/admissions/[id]/discharge/route.ts",
  ]

  // Routes may delegate the tenant filter to a shared loader that takes ctx.tenantId.
  const loaders: Record<string, string> = {
    "loadInvoice(db, ctx.tenantId": "apps/web/src/lib/hospital-billing.ts",
  }

  it("scopes representative hospital healthcare queries by ctx.tenantId", () => {
    for (const file of files) {
      const text = src(file)
      expect(text, file).toMatch(/ctx\.tenantId/)
      const delegated = Object.entries(loaders).find(([call]) => text.includes(call))
      if (delegated) {
        expect(src(delegated[1]), delegated[1]).toMatch(/eq\('tenant_id', tenantId\)/)
      } else {
        expect(text, file).toMatch(/tenant_id/)
      }
    }
  })

  it("does not look up patients by id alone on OPD/nurse/emergency queues", () => {
    for (const file of [
      "apps/web/src/app/api/opd/queue/route.ts",
      "apps/web/src/app/api/nurse/ward/route.ts",
      "apps/web/src/app/api/emergency/queue/route.ts",
    ]) {
      const text = src(file)
      expect(text, file).toMatch(/from\('patients'\)[\s\S]{0,180}eq\('tenant_id', ctx\.tenantId\)/)
    }
  })
})

describe("mobile pharmacy purchase tenant filters", () => {
  const files = [
    "apps/web/src/app/api/mobile/pharmacy/purchases/route.ts",
    "apps/web/src/app/api/mobile/pharmacy/purchases/products/route.ts",
    "apps/web/src/app/api/mobile/pharmacy/suppliers/route.ts",
  ]

  it("derives tenant from auth and never from client tenant_id", () => {
    for (const file of files) {
      const text = src(file)
      expect(text, file).toMatch(/auth\.tenantId/)
      expect(text, file).toMatch(/tenant_id/)
      expect(text, file).not.toMatch(/body\.tenantId|body\.tenant_id/)
    }
  })
})
