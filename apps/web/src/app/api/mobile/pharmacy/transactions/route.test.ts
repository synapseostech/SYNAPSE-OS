import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextResponse } from "next/server"

const { requireMobilePharmacyAuth, isMobileAuth, mobileHasPharmacyCapability } = vi.hoisted(() => ({
  requireMobilePharmacyAuth: vi.fn(),
  isMobileAuth: vi.fn(),
  mobileHasPharmacyCapability: vi.fn(),
}))

vi.mock("../../../../../lib/mobile-pharmacy-auth", () => ({
  requireMobilePharmacyAuth: (...args: unknown[]) => requireMobilePharmacyAuth(...args),
  isMobileAuth: (...args: unknown[]) => isMobileAuth(...args),
  mobileHasPharmacyCapability: (...args: unknown[]) => mobileHasPharmacyCapability(...args),
}))

const state = {
  pos: [] as unknown[],
  orders: [] as unknown[],
  revenue: [] as unknown[],
  profiles: [] as unknown[],
  settings: { currency: "UGX" } as Record<string, unknown> | null,
  filters: [] as Array<[string, string, unknown]>,
  limits: [] as number[],
  failPos: false,
}

vi.mock("@synapse/db/admin", () => ({
  supabaseAdmin: {
    from: (table: string) => {
      const builder: Record<string, unknown> = {}
      const self = () => builder
      builder.select = self
      builder.order = self
      builder.gte = self
      builder.eq = (column: string, value: unknown) => {
        state.filters.push([table, column, value])
        return builder
      }
      builder.in = (column: string, value: unknown) => {
        state.filters.push([table, column, value])
        return builder
      }
      builder.limit = (value: number) => {
        state.limits.push(value)
        const data =
          table === "pharmacy_pos_sales" ? state.pos : table === "pharmacy_transactions" ? state.orders : []
        const error = table === "pharmacy_pos_sales" && state.failPos ? { message: "boom" } : null
        return Promise.resolve({ data, error })
      }
      builder.maybeSingle = () =>
        Promise.resolve({
          data: table === "pharmacy_settings" ? state.settings : null,
          error: null,
        })
      builder.then = (resolve: (value: unknown) => unknown) => {
        const data =
          table === "pharmacy_pos_sales" ? state.revenue : table === "profiles" ? state.profiles : []
        return Promise.resolve({ data, error: null }).then(resolve)
      }
      return builder
    },
  },
}))

import { GET } from "./route"

function auth(role = "pharmacist", tenantId = "tenant-a") {
  return { userId: "user-1", tenantId, role, token: "t" }
}

function get(query = "") {
  return new Request(`https://app.test/api/mobile/pharmacy/transactions${query}`) as never
}

function capabilitySet(caps: string[]) {
  return (_auth: unknown, capability: string) => caps.includes(capability)
}

function daysAgo(days: number) {
  return new Date(Date.now() - days * 86_400_000).toISOString()
}

const posSale = {
  id: "s1",
  receipt_number: "R-1",
  status: "completed",
  subtotal: 10000,
  discount_total: 500,
  tax_amount: 0,
  total_amount: 9500,
  payment_method: "cash",
  cashier_id: "u1",
  created_at: daysAgo(6),
  items: [
    {
      id: "i1",
      quantity: 2,
      unit_price: 5000,
      discount_amount: 500,
      line_total: 9500,
      product: { id: "p1", name: "Paracetamol", sku: "PARA", cost_price: 3000 },
      batch: { batch_number: "B1", expiry_date: "2027-01-01", cost_price: 2500 },
    },
  ],
}

const orderSale = {
  id: "t1",
  transaction_no: "T-1",
  status: "COMPLETED",
  total_amount: 2000,
  net_amount: 1800,
  discount: 200,
  tax: 0,
  payment_method: "cash",
  cashier_id: null,
  created_at: daysAgo(0),
  client_name: "Walk-in",
  cashier: { full_name: "Order Clerk" },
  items: [
    {
      id: "ti1",
      quantity: 1,
      unit_price: 2000,
      cost_price: 1500,
      total_price: 1800,
      product: { id: "p2", name: "Amoxicillin", sku: "AMOX", cost_price: 1600 },
      batch: null,
    },
  ],
}

describe("mobile pharmacy transactions", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    state.pos = []
    state.orders = []
    state.revenue = []
    state.profiles = []
    state.settings = { currency: "UGX" }
    state.filters = []
    state.limits = []
    state.failPos = false
    isMobileAuth.mockImplementation(
      (value: unknown) =>
        Boolean(value) && typeof value === "object" && !(value instanceof NextResponse) && "tenantId" in (value as object),
    )
  })

  it("denies history without a sales or operational-reports capability", async () => {
    requireMobilePharmacyAuth.mockResolvedValue(auth("pharmacy_cashier"))
    mobileHasPharmacyCapability.mockReturnValue(false)

    const res = await GET(get())

    expect(res.status).toBe(403)
  })

  it("merges POS and order sales newest first with cashier names", async () => {
    requireMobilePharmacyAuth.mockResolvedValue(auth())
    mobileHasPharmacyCapability.mockImplementation(capabilitySet(["pos.sell"]))
    state.pos = [posSale]
    state.orders = [orderSale]
    state.profiles = [{ id: "u1", full_name: "Ada Cashier" }]

    const res = await GET(get())

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.transactions).toHaveLength(2)
    expect(body.transactions[0]).toMatchObject({
      id: "t1",
      source: "order",
      receiptNumber: "T-1",
      clientName: "Walk-in",
      cashierName: "Order Clerk",
    })
    expect(body.transactions[1]).toMatchObject({
      id: "s1",
      source: "pos",
      receiptNumber: "R-1",
      cashierName: "Ada Cashier",
      totalAmount: 10000,
      netAmount: 9500,
    })
    expect(body.transactions[1].items[0]).toMatchObject({
      name: "Paracetamol",
      quantity: 2,
      unitPrice: 5000,
      totalPrice: 9500,
      batchNumber: "B1",
    })
    expect(state.filters).toContainEqual(["pharmacy_pos_sales", "tenant_id", "tenant-a"])
    expect(state.filters).toContainEqual(["pharmacy_transactions", "tenant_id", "tenant-a"])
  })

  it("buckets completed POS revenue into today, week and month", async () => {
    requireMobilePharmacyAuth.mockResolvedValue(auth())
    mobileHasPharmacyCapability.mockImplementation(capabilitySet(["pos.sell"]))
    state.revenue = [
      { total_amount: 1000, created_at: daysAgo(0) },
      { total_amount: 2000, created_at: daysAgo(3) },
      { total_amount: 3000, created_at: daysAgo(20) },
    ]

    const res = await GET(get())

    const body = await res.json()
    expect(body.stats).toMatchObject({ today: 1000, week: 3000, month: 6000, count: 0 })
    expect(body.stats).not.toHaveProperty("todayProfit")
  })

  it("includes profit only for roles with financial reports", async () => {
    requireMobilePharmacyAuth.mockResolvedValue(auth("pharmacy_store_manager"))
    mobileHasPharmacyCapability.mockImplementation(
      capabilitySet(["pos.sell", "reports.operational", "reports.financial"]),
    )
    state.pos = [posSale]
    state.orders = [orderSale]

    const res = await GET(get())

    const body = await res.json()
    expect(body.transactions[0]).not.toHaveProperty("profit")
    expect(body.stats.todayProfit).toBe(500)
    expect(body.stats.weekProfit).toBe(5500)
    expect(body.stats.monthProfit).toBe(5500)
  })

  it("caps the page size at 100", async () => {
    requireMobilePharmacyAuth.mockResolvedValue(auth())
    mobileHasPharmacyCapability.mockImplementation(capabilitySet(["pos.sell"]))

    await GET(get("?limit=500"))

    expect(state.limits[0]).toBe(100)
  })

  it("fails closed when POS history cannot be read", async () => {
    requireMobilePharmacyAuth.mockResolvedValue(auth())
    mobileHasPharmacyCapability.mockImplementation(capabilitySet(["pos.sell"]))
    state.failPos = true

    const res = await GET(get())

    expect(res.status).toBe(500)
  })
})
