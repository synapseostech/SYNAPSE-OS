import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextResponse } from "next/server"

const { requireMobilePharmacyAuth, isMobileAuth, gateFeature } = vi.hoisted(() => ({
  requireMobilePharmacyAuth: vi.fn(),
  isMobileAuth: vi.fn(),
  gateFeature: vi.fn(),
}))

vi.mock("../../../../../../lib/mobile-pharmacy-auth", () => ({
  requireMobilePharmacyAuth: (...args: unknown[]) => requireMobilePharmacyAuth(...args),
  isMobileAuth: (...args: unknown[]) => isMobileAuth(...args),
}))

vi.mock("@synapse/auth", () => ({
  gateFeature: (...args: unknown[]) => gateFeature(...args),
}))

const state = {
  products: [] as Array<Record<string, unknown>>,
  filters: [] as Array<{ column: string; value: unknown }>,
  select: "",
}

vi.mock("@synapse/db/admin", () => ({
  supabaseAdmin: {
    from: () => {
      const builder: Record<string, unknown> = {}
      const self = () => builder
      builder.select = (columns: string) => {
        state.select = columns
        return builder
      }
      builder.eq = (column: string, value: unknown) => {
        state.filters.push({ column, value })
        return builder
      }
      builder.order = self
      builder.limit = () => Promise.resolve({ data: state.products, error: null })
      return builder
    },
  },
}))

vi.mock("@synapse/db/inventory", () => ({
  summarizeInventory: () => ({
    sellableQuantity: 4,
    physicalQuantity: 4,
    expiredQuantity: 0,
    unbatchedQuantity: 0,
    hasPhantomStock: false,
  }),
  kampalaToday: () => "2026-11-01",
  normaliseBatch: (batch: Record<string, unknown>) => batch,
  isSellableBatch: () => true,
}))

import { GET } from "./route"

function request(url: string) {
  return new Request(url) as unknown as Parameters<typeof GET>[0]
}

function auth(tenantId = "tenant-a") {
  return { kind: "mobile", userId: "user-1", tenantId }
}

function product(overrides: Record<string, unknown> = {}) {
  return {
    id: "product-1",
    name: "Paracetamol 500mg",
    sku: "PCM-500",
    barcode: null,
    price: 1000,
    cost_price: 500,
    quantity: 4,
    unit_of_measure: "tablet",
    requires_prescription: false,
    is_active: true,
    vat_category: "standard",
    pharmacy_product_packages: [],
    pharmacy_product_batches: [
      {
        id: "batch-1",
        batch_number: "B1",
        quantity: 4,
        expiry_date: "2027-01-01",
        selling_price: 1000,
      },
    ],
    ...overrides,
  }
}

describe("mobile POS catalogue VAT classification", () => {
  beforeEach(() => {
    state.products = []
    state.filters = []
    state.select = ""
    requireMobilePharmacyAuth.mockReset()
    isMobileAuth.mockReset()
    gateFeature.mockReset()
    requireMobilePharmacyAuth.mockResolvedValue(auth())
    isMobileAuth.mockReturnValue(true)
    gateFeature.mockResolvedValue(null)
  })

  it("returns each product's VAT category so the till can quote the same tax", async () => {
    state.products = [product(), product({ id: "product-2", vat_category: "exempt" })]

    const response = await GET(request("https://app.test/api/mobile/pharmacy/pos/products"))
    expect(response.status).toBe(200)
    const body = (await response.json()) as { products: Array<{ id: string; vatCategory: string | null }> }

    expect(body.products.find((p) => p.id === "product-1")?.vatCategory).toBe("standard")
    expect(body.products.find((p) => p.id === "product-2")?.vatCategory).toBe("exempt")
    expect(state.select).toContain("vat_category")
  })

  it("reports an unclassified product as null rather than assuming it is taxable", async () => {
    state.products = [product({ vat_category: null })]

    const response = await GET(request("https://app.test/api/mobile/pharmacy/pos/products"))
    const body = (await response.json()) as { products: Array<{ vatCategory: string | null }> }
    expect(body.products[0]?.vatCategory).toBeNull()
  })

  it("scopes the catalogue to the authenticated tenant", async () => {
    requireMobilePharmacyAuth.mockResolvedValue(auth("tenant-b"))
    state.products = [product()]

    await GET(request("https://app.test/api/mobile/pharmacy/pos/products"))
    expect(state.filters).toContainEqual({ column: "tenant_id", value: "tenant-b" })
  })

  it("returns the auth failure instead of a catalogue", async () => {
    const refusal = NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    requireMobilePharmacyAuth.mockResolvedValue(refusal)
    isMobileAuth.mockReturnValue(false)

    const response = await GET(request("https://app.test/api/mobile/pharmacy/pos/products"))
    expect(response.status).toBe(401)
  })

  it("returns the feature gate's refusal when POS selling is disabled", async () => {
    gateFeature.mockResolvedValue(NextResponse.json({ error: "Feature disabled" }, { status: 403 }))

    const response = await GET(request("https://app.test/api/mobile/pharmacy/pos/products"))
    expect(response.status).toBe(403)
  })
})
