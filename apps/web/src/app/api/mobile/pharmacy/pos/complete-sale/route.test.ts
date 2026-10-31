import { beforeEach, describe, expect, it, vi } from "vitest"

/**
 * Regression tests for the mobile POS complete-sale patient-ownership check.
 *
 * A client-supplied patient id is written under the service role by
 * `complete_pharmacy_sale`, so it must be proven to belong to the caller's
 * tenant before the sale references it. A foreign-tenant id returns 404 (not
 * 403) so other tenants' patient ids cannot be probed by status code.
 */

const s = vi.hoisted(() => ({
  tables: {} as Record<string, any[]>,
  rpcCalls: [] as { name: string; args: Record<string, unknown> }[],
}))

vi.mock("@synapse/auth", () => ({
  gateFeature: async () => null,
}))

vi.mock("@synapse/db/admin", () => {
  const from = (table: string) => {
    const rows = (s.tables[table] ??= [])
    const filters: Array<(r: any) => boolean> = []
    const q: any = {
      select: () => q,
      eq: (c: string, v: any) => (filters.push((r) => r[c] === v), q),
      in: (c: string, v: any[]) => (filters.push((r) => v.includes(r[c])), q),
      maybeSingle: async () => ({
        data: rows.filter((r) => filters.every((f) => f(r)))[0] ?? null,
        error: null,
      }),
      then: (res: any) =>
        Promise.resolve({
          data: rows.filter((r) => filters.every((f) => f(r))),
          error: null,
        }).then(res),
    }
    return q
  }
  return {
    supabaseAdmin: {
      from,
      rpc: async (name: string, args: Record<string, unknown>) => {
        s.rpcCalls.push({ name, args })
        return { data: { sale_id: "sale-1", id: "sale-1", total_amount: 10 }, error: null }
      },
    },
  }
})

vi.mock("../../../../../../lib/mobile-pharmacy-auth", () => ({
  requireMobilePharmacyAuth: async () => ({
    userId: "cashier-a",
    tenantId: "tenant-a",
    role: "pharmacy_cashier",
  }),
  isMobileAuth: () => true,
  isMobilePharmacyAdmin: () => false,
}))

vi.mock("../../../../../../lib/pharmacy-pos/idempotency", () => ({
  findSaleIdempotency: async () => null,
  readIdempotencyKey: () => null,
  storeSaleIdempotency: async () => {},
}))

vi.mock("../../../../../../lib/pharmacy-pos/sale-validation", () => ({
  extractSaleErrorCode: () => "SALE_FAILED",
  friendlySaleError: (m: string) => m,
  saleErrorHttpStatus: () => 400,
  validateSaleLine: ({ raw }: any) => ({
    ok: true,
    rpcItem: {
      product_id: raw.productId,
      unit_price: 10,
      quantity: raw.quantity ?? 1,
      discount_amount: 0,
    },
  }),
  isValidSaleQuantity: (quantity: unknown) =>
    typeof quantity === "number" && Number.isInteger(quantity) && quantity > 0,
  splitBatchSaleLine: (allocations: any[], discountAmount: number) =>
    allocations.map((allocation) => ({
      batch_id: allocation.batchId,
      quantity: allocation.quantity,
      unit_price: allocation.listPrice,
      discount_amount: discountAmount,
    })),
}))

vi.mock("@synapse/db/inventory", () => ({
  buildStockError: async () => null,
  kampalaToday: () => "2026-03-01",
  allocateFefo: (batches: any[], quantity: number) => {
    let remaining = quantity
    return batches
      .filter(
        (batch) =>
          batch.status === "active" &&
          batch.is_active !== false &&
          Number(batch.quantity) > 0 &&
          (!batch.expiry_date || batch.expiry_date >= "2026-03-01"),
      )
      .sort((a, b) => String(a.expiry_date ?? "9999").localeCompare(String(b.expiry_date ?? "9999")))
      .flatMap((batch) => {
        if (remaining <= 0) return []
        const taken = Math.min(Number(batch.quantity), remaining)
        remaining -= taken
        return [{ batchId: batch.id, quantity: taken }]
      })
  },
}))

vi.mock("@synapse/db/till-service", () => ({
  attachSaleToTill: async () => ({ ok: true, sessionId: null }),
  recordTillSale: async () => {},
}))

vi.mock("@synapse/db/errors", () => ({
  httpStatusForPharmacyError: () => 400,
}))

vi.mock("@synapse/auth/mobile-push", () => ({
  notifyPharmacyStock: () => {},
}))

import { POST } from "./route"

const req = (body: unknown) =>
  new Request("http://x/api/mobile/pharmacy/pos/complete-sale", {
    method: "POST",
    body: JSON.stringify(body),
  }) as any

const PATIENT_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
const PATIENT_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
const PRODUCT_A = "11111111-1111-4111-8111-111111111111"

beforeEach(() => {
  s.rpcCalls = []
  s.tables = {
    patients: [
      { id: PATIENT_A, tenant_id: "tenant-a" },
      { id: PATIENT_B, tenant_id: "tenant-b" },
    ],
    pharmacy_settings: [{ tenant_id: "tenant-a", discount_approval_threshold_pct: 5 }],
    pharmacy_products: [
      {
        id: PRODUCT_A,
        price: 10,
        name: "Paracetamol",
        is_active: true,
        tenant_id: "tenant-a",
        quantity: 100,
        reorder_level: 0,
      },
    ],
    pharmacy_product_batches: [
      {
        id: "batch-a",
        tenant_id: "tenant-a",
        product_id: PRODUCT_A,
        quantity: 100,
        expiry_date: "2027-01-01",
        status: "active",
        is_active: true,
        selling_price: 10,
      },
    ],
  }
})

const saleBody = (overrides: Record<string, unknown> = {}) => ({
  items: [{ productId: PRODUCT_A, quantity: 1 }],
  paymentMethod: "cash",
  ...overrides,
})

describe("mobile POS complete-sale patient ownership", () => {
  it("refuses a foreign-tenant patientId with 404 and never calls the RPC", async () => {
    const r = await POST(req(saleBody({ patientId: PATIENT_B })))
    expect(r.status).toBe(404)
    expect(await r.json()).toEqual({ error: "Patient not found" })
    expect(s.rpcCalls).toHaveLength(0)
  })

  it("rejects a malformed patientId with 400 INVALID_PATIENT_ID and never calls the RPC", async () => {
    const r = await POST(req(saleBody({ patientId: "not-a-uuid" })))
    expect(r.status).toBe(400)
    expect(await r.json()).toEqual({ error: "Invalid patient id", code: "INVALID_PATIENT_ID" })
    expect(s.rpcCalls).toHaveLength(0)
  })

  it("forwards a same-tenant patientId as p_patient_id", async () => {
    const r = await POST(req(saleBody({ patientId: PATIENT_A })))
    expect(r.status).toBe(200)
    expect(s.rpcCalls).toHaveLength(1)
    expect(s.rpcCalls[0].name).toBe("complete_pharmacy_sale")
    expect(s.rpcCalls[0].args.p_patient_id).toBe(PATIENT_A)
  })

  it("passes p_patient_id null when no patientId is supplied", async () => {
    const r = await POST(req(saleBody()))
    expect(r.status).toBe(200)
    expect(s.rpcCalls).toHaveLength(1)
    expect(s.rpcCalls[0].args.p_patient_id).toBeNull()
  })

  it("allocates checkout lines to the batch price before calling the sale RPC", async () => {
    const r = await POST(req(saleBody()))
    expect(r.status).toBe(200)
    expect(s.rpcCalls[0].args.p_items).toEqual([
      expect.objectContaining({
        product_id: PRODUCT_A,
        batch_id: "batch-a",
        quantity: 1,
        unit_price: 10,
      }),
    ])
  })

  it("pins the selected batch and rejects a stale client selling price", async () => {
    const r = await POST(req(saleBody({
      items: [{ productId: PRODUCT_A, quantity: 1, batchId: "batch-a", unitPrice: 12 }],
    })))
    expect(r.status).toBe(409)
    expect(await r.json()).toMatchObject({ code: "BATCH_PRICE_CHANGED" })
    expect(s.rpcCalls).toHaveLength(0)
  })
})
