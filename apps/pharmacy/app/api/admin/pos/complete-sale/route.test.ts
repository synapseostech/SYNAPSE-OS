import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextResponse } from "next/server"

const {
  requirePharmacyPermission,
  gateFeature,
  findSaleIdempotency,
  storeSaleIdempotency,
  rpc,
  productMaybeSingle,
  settingsMaybeSingle,
  attachSaleToTill,
  recordTillSale,
  batchRows,
} = vi.hoisted(() => ({
  batchRows: { current: [] as Record<string, unknown>[] },
  attachSaleToTill: vi.fn(),
  recordTillSale: vi.fn(),
  requirePharmacyPermission: vi.fn(),
  gateFeature: vi.fn(),
  findSaleIdempotency: vi.fn(),
  storeSaleIdempotency: vi.fn(),
  rpc: vi.fn(),
  productMaybeSingle: vi.fn(),
  settingsMaybeSingle: vi.fn(),
}))

vi.mock("@/lib/api-auth", () => ({
  requirePharmacyPermission: (...args: unknown[]) => requirePharmacyPermission(...args),
}))

vi.mock("@synapse/auth/features", () => ({
  gateFeature: (...args: unknown[]) => gateFeature(...args),
}))

vi.mock("@/lib/pos/till-service", () => ({
  attachSaleToTill: (...args: unknown[]) => attachSaleToTill(...args),
  recordTillSale: (...args: unknown[]) => recordTillSale(...args),
}))

vi.mock("@/lib/pos/idempotency", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/pos/idempotency")>()
  return {
    ...actual,
    findSaleIdempotency: (...args: unknown[]) => findSaleIdempotency(...args),
    storeSaleIdempotency: (...args: unknown[]) => storeSaleIdempotency(...args),
  }
})

vi.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: {
    from: (table: string) => {
      if (table === "pharmacy_settings") {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: settingsMaybeSingle,
            }),
          }),
        }
      }
      if (table === "patients") {
        const filters: Record<string, unknown> = {}
        const q: any = {
          select: () => q,
          eq: (k: string, v: unknown) => ((filters[k] = v), q),
          maybeSingle: async () => ({
            data: filters.id === "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa" && filters.tenant_id === "tenant-1" ? { id: "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa" } : null,
            error: null,
          }),
        }
        return q
      }
      if (table === "pharmacy_customers") {
        const filters: Record<string, unknown> = {}
        const q: any = {
          select: () => q,
          eq: (k: string, v: unknown) => ((filters[k] = v), q),
          maybeSingle: async () => ({
            data: filters.id === "cust-own" && filters.tenant_id === "tenant-1" ? { id: "cust-own" } : null,
            error: null,
          }),
        }
        return q
      }
      if (table === "pharmacy_products") {
        return {
          select: () => ({
            eq: (_col: string, _val: unknown) => {
              // Product lookup: .eq(id).eq(tenant).maybeSingle()
              // Reorder scan: .eq(tenant).in(ids)
              return {
                eq: () => ({ maybeSingle: productMaybeSingle }),
                in: () => Promise.resolve({ data: [], error: null }),
                maybeSingle: productMaybeSingle,
              }
            },
          }),
        }
      }
      if (table === "pharmacy_product_batches") {
        const q: any = {
          select: () => q,
          eq: () => q,
          gt: () => q,
          then: (resolve: (value: unknown) => unknown) =>
            Promise.resolve({
              data: batchRows.current,
              error: null,
            }).then(resolve),
        }
        return q
      }
      return {
        select: () => ({
          eq: () => ({
            in: () => Promise.resolve({ data: [], error: null }),
          }),
        }),
      }
    },
    rpc,
  },
}))

import { POST } from "./route"
import { signDiscountApproval } from "@/lib/pos/discount-approval"

process.env.SYNAPSE_JWT_SECRET = process.env.SYNAPSE_JWT_SECRET || "test-only-secret-not-real-000000000000"

function sessionAuth() {
  return {
    ok: true as const,
    tenantId: "tenant-1",
    session: {
      userId: "cashier-1",
      email: "c@test.com",
      role: "pharmacy_cashier",
      pharmacyRole: "pharmacy_cashier",
      tenantId: "tenant-1",
      fullName: "Cashier",
      firstName: "Cash",
      lastName: "Ier",
      isAdmin: false,
      tenantName: "Care",
      tenantSlug: "care",
      tenantStatus: "active",
      modulesEnabled: [],
      mustChangePassword: false,
      permissions: [],
      isImpersonation: false,
      impersonatorId: null,
      storeId: null,
      profile: {
        tenant_id: "tenant-1",
        is_admin: false,
        full_name: "Cashier",
        first_name: "Cash",
        last_name: "Ier",
      },
      user: { id: "cashier-1", email: "c@test.com" },
    },
  }
}

function makeRequest(body: unknown, headers?: Record<string, string>) {
  return new Request("https://pharm.test/api/admin/pos/complete-sale", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(headers ?? {}) },
    body: JSON.stringify(body),
  }) as any
}

describe("POST /api/admin/pos/complete-sale", () => {
  beforeEach(() => {
    requirePharmacyPermission.mockReset()
    gateFeature.mockReset()
    findSaleIdempotency.mockReset()
    storeSaleIdempotency.mockReset()
    rpc.mockReset()
    productMaybeSingle.mockReset()
    settingsMaybeSingle.mockReset()

    attachSaleToTill.mockReset()
    recordTillSale.mockReset()
    attachSaleToTill.mockResolvedValue({ ok: true, sessionId: "till-1" })
    recordTillSale.mockResolvedValue(undefined)
    requirePharmacyPermission.mockResolvedValue(sessionAuth())
    gateFeature.mockResolvedValue(null)
    settingsMaybeSingle.mockResolvedValue({
      data: { discount_approval_threshold_pct: 5 },
      error: null,
    })
    productMaybeSingle.mockResolvedValue({
      data: { id: "p1", price: 1000, name: "Paracetamol", is_active: true },
      error: null,
    })
    findSaleIdempotency.mockResolvedValue(null)
    storeSaleIdempotency.mockResolvedValue(undefined)
    batchRows.current = [{
      id: "batch-1",
      batch_number: "BATCH-1",
      quantity: 100,
      expiry_date: "2099-12-31",
      cost_price: 500,
      selling_price: 1000,
      manufacturer: null,
      is_active: true,
      status: "active",
    }]
  })

  it("rejects empty cart", async () => {
    const res = await POST(makeRequest({ items: [], paymentMethod: "cash" }))
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ error: "Cart is empty" })
  })

  it("rejects missing payment method", async () => {
    const res = await POST(
      makeRequest({ items: [{ productId: "p1", quantity: 1, unitPrice: 1000 }] }),
    )
    expect(res.status).toBe(400)
  })

  it("replays prior sale when Idempotency-Key matches", async () => {
    findSaleIdempotency.mockResolvedValue({
      saleId: "sale-9",
      response: { id: "sale-9", receipt_number: "R-9" },
    })
    const res = await POST(
      makeRequest(
        {
          items: [{ productId: "p1", quantity: 1, unitPrice: 1000 }],
          paymentMethod: "cash",
        },
        { "Idempotency-Key": "retry-1" },
      ),
    )
    expect(res.status).toBe(200)
    expect(res.headers.get("X-Idempotent-Replay")).toBe("true")
    const body = await res.json()
    expect(body.idempotentReplay).toBe(true)
    expect(body.sale).toEqual({ id: "sale-9", receipt_number: "R-9" })
    expect(rpc).not.toHaveBeenCalled()
  })

  it("uses session user as cashier and ignores client staffId", async () => {
    rpc.mockResolvedValue({
      data: { id: "sale-1", receipt_number: "R-1" },
      error: null,
    })
    const res = await POST(
      makeRequest({
        items: [{ productId: "p1", quantity: 2, unitPrice: 1000 }],
        paymentMethod: "cash",
        staffId: "someone-else",
        idempotencyKey: "k-new",
      }),
    )
    expect(res.status).toBe(200)
    expect(rpc).toHaveBeenCalledWith(
      "complete_pharmacy_sale",
      expect.objectContaining({
        p_cashier_id: "cashier-1",
        p_confirmed_by: "cashier-1",
        p_payment_method: "cash",
        p_session_id: "till-1",
      }),
    )
    expect(storeSaleIdempotency).toHaveBeenCalledWith(
      expect.objectContaining({ key: "k-new", tenantId: "tenant-1" }),
    )
  })

  it("maps insufficient stock to 409", async () => {
    rpc.mockResolvedValue({
      data: null,
      error: { message: "INSUFFICIENT_STOCK: only 0 left" },
    })
    const res = await POST(
      makeRequest({
        items: [{ productId: "p1", quantity: 1, unitPrice: 1000 }],
        paymentMethod: "mobile_money",
      }),
    )
    expect(res.status).toBe(409)
    const body = await res.json()
    expect(body.code).toBe("INSUFFICIENT_STOCK")
  })

  it("sells an out-of-stock product through the overdraft line", async () => {
    batchRows.current = []
    rpc.mockResolvedValue({ data: { id: "sale-1", receipt_number: "R-1" }, error: null })

    const res = await POST(
      makeRequest({
        items: [{ productId: "p1", quantity: 2, unitPrice: 1000 }],
        paymentMethod: "cash",
        amountPaid: 2000,
      }),
    )

    expect(res.status).toBe(200)
    expect(rpc).toHaveBeenCalledWith(
      "complete_pharmacy_sale",
      expect.objectContaining({
        p_items: [
          expect.objectContaining({
            product_id: "p1",
            quantity: 2,
            unit_price: 1000,
            batch_id: null,
            allow_overdraft: true,
          }),
        ],
      }),
    )
  })

  it("charges the shortfall at the catalog price when a batch runs out", async () => {
    batchRows.current = [{
      id: "batch-1",
      batch_number: "BATCH-1",
      quantity: 1,
      expiry_date: "2099-12-31",
      cost_price: 500,
      selling_price: 1200,
      manufacturer: null,
      is_active: true,
      status: "active",
    }]
    rpc.mockResolvedValue({ data: { id: "sale-1", receipt_number: "R-1" }, error: null })

    const res = await POST(
      makeRequest({
        items: [{ productId: "p1", quantity: 3 }],
        paymentMethod: "cash",
        amountPaid: 5000,
      }),
    )

    expect(res.status).toBe(200)
    expect(rpc).toHaveBeenCalledWith(
      "complete_pharmacy_sale",
      expect.objectContaining({
        p_items: [
          expect.objectContaining({
            quantity: 3,
            batch_id: null,
            allow_overdraft: true,
            unit_price: expect.closeTo(1066.67, 2),
          }),
        ],
      }),
    )
  })

  it("forbids cashiers without pos.sell", async () => {
    requirePharmacyPermission.mockResolvedValue({
      ok: false,
      response: NextResponse.json({ error: "Missing capability: pos.sell" }, { status: 403 }),
    })
    const res = await POST(
      makeRequest({
        items: [{ productId: "p1", quantity: 1, unitPrice: 1000 }],
        paymentMethod: "cash",
      }),
    )
    expect(res.status).toBe(403)
  })

  describe("server-side discount approval (vertical escalation)", () => {
    const discounted = { productId: "p1", quantity: 1, unitPrice: 1000, discountAmount: 300, discountReason: "loyal" }

    it("rejects a cashier-supplied raw supervisor id (forged approval)", async () => {
      const res = await POST(makeRequest({ items: [discounted], paymentMethod: "cash", discountApprovedBy: "supervisor-1" }))
      expect(res.status).toBe(403)
      expect((await res.json()).code).toBe("DISCOUNT_APPROVAL_REQUIRED")
      expect(rpc).not.toHaveBeenCalled()
    })

    it.each([
      ["another cashier", { tenantId: "tenant-1", cashierId: "cashier-2" }],
      ["another tenant", { tenantId: "tenant-2", cashierId: "cashier-1" }],
    ])("rejects an approval token minted for %s", async (_l, scope) => {
      const token = signDiscountApproval({ ...scope, supervisorId: "supervisor-1" })
      const res = await POST(makeRequest({ items: [discounted], paymentMethod: "cash", discountApprovedBy: token }))
      expect(res.status).toBe(403)
      expect(rpc).not.toHaveBeenCalled()
    })

    it("accepts a valid token and records the verified supervisor as approver", async () => {
      rpc.mockResolvedValue({ data: { id: "sale-2", receipt_number: "R-2" }, error: null })
      const token = signDiscountApproval({ tenantId: "tenant-1", cashierId: "cashier-1", supervisorId: "supervisor-1" })
      const res = await POST(makeRequest({ items: [discounted], paymentMethod: "cash", discountApprovedBy: token }))
      expect(res.status).toBe(200)
      const args = rpc.mock.calls[0][1]
      expect(JSON.stringify(args)).toContain("supervisor-1")
    })
  })

  describe("credit customer reference (cross-tenant)", () => {
    it("rejects a customerId outside the caller tenant before the sale", async () => {
      const res = await POST(makeRequest({
        items: [{ productId: "p1", quantity: 1, unitPrice: 1000 }], paymentMethod: "credit", customerId: "cust-other-tenant",
      }))
      expect(res.status).toBe(404)
      expect(rpc).not.toHaveBeenCalled()
    })
  })

  it("rejects a non-UUID cartId with 400 before calling the RPC", async () => {
    const res = await POST(
      makeRequest({ items: [{ productId: "p1", quantity: 1, unitPrice: 1000 }], paymentMethod: "cash", cartId: "not-a-uuid" }),
    )
    expect(res.status).toBe(400)
    expect((await res.json()).code).toBe("INVALID_CART_ID")
    expect(rpc).not.toHaveBeenCalled()
  })

  it("does not echo raw database error text to the client", async () => {
    rpc.mockResolvedValue({ data: null, error: { message: 'relation "pharmacy_pos_sales" violates constraint xyz_internal' } })
    const res = await POST(
      makeRequest({ items: [{ productId: "p1", quantity: 1, unitPrice: 1000 }], paymentMethod: "cash", amountPaid: 1000 }),
    )
    expect(res.status).toBe(500)
    const text = JSON.stringify(await res.json())
    expect(text).not.toMatch(/relation|constraint|xyz_internal/)
  })

  it("does not credit the till when the sale RPC fails", async () => {
    rpc.mockResolvedValue({ data: null, error: { message: "INSUFFICIENT_STOCK: not enough" } })
    const res = await POST(makeRequest({ items: [{ productId: "p1", quantity: 1 }], paymentMethod: "CASH", amountPaid: 1000 }))
    expect(res.status).toBe(409)
    for (const call of attachSaleToTill.mock.calls) expect((call[0] as { amount: number }).amount).toBe(0)
    expect(recordTillSale).not.toHaveBeenCalled()
  })

  it("credits the till with cash actually received after a successful partial sale", async () => {
    rpc.mockResolvedValue({ data: { sale_id: "s1", receipt_number: "R-1" }, error: null })
    const res = await POST(
      makeRequest({ items: [{ productId: "p1", quantity: 3 }], paymentMethod: "CASH", amountPaid: 1000, clientName: "Walk in" }),
    )
    expect(res.status).toBe(200)
    expect(recordTillSale).toHaveBeenCalledTimes(1)
    expect(recordTillSale.mock.calls[0][0]).toMatchObject({ sessionId: "till-1", paymentMethod: "CASH", amount: 1000 })
    // Keyed by the committed sale id so the DB can dedupe the cash event.
    expect(recordTillSale.mock.calls[0][0]).toMatchObject({ saleId: "s1", actorId: "cashier-1" })
  })

  it("an idempotent replay (retry with same key) adds no cash to the till", async () => {
    findSaleIdempotency.mockResolvedValue({ saleId: "s1", response: { sale_id: "s1" } })
    const res = await POST(
      makeRequest({ items: [{ productId: "p1", quantity: 1 }], paymentMethod: "CASH", amountPaid: 1000 }, { "Idempotency-Key": "retry-2" }),
    )
    expect(res.status).toBe(200)
    expect(rpc).not.toHaveBeenCalled()
    expect(recordTillSale).not.toHaveBeenCalled()
    for (const call of attachSaleToTill.mock.calls) expect((call[0] as { amount: number }).amount).toBe(0)
  })

  it("a credit sale posts the ledger with an idempotency key derived from the sale id", async () => {
    rpc.mockImplementation(async (fn: string) =>
      fn === "complete_pharmacy_sale"
        ? { data: { sale_id: "s2", receipt_number: "R-2" }, error: null }
        : { data: { id: "e-1", balance_after: 3000, replayed: false }, error: null },
    )
    const res = await POST(
      makeRequest({ items: [{ productId: "p1", quantity: 3 }], paymentMethod: "CREDIT", amountPaid: 0, customerId: "cust-own", clientName: "Jane" }),
    )
    expect(res.status).toBe(200)
    const credit = rpc.mock.calls.find((c) => c[0] === "post_pharmacy_credit_entry")
    expect(credit?.[1]).toMatchObject({ p_idempotency_key: "pos-sale:s2", p_type: "credit", p_amount: 3000 })
  })

  describe("patient reference (cross-tenant)", () => {
    it("rejects a patientId that does not belong to the caller's tenant", async () => {
      const res = await POST(
        makeRequest({
          items: [{ productId: "p1", quantity: 1, unitPrice: 1000 }],
          paymentMethod: "cash",
          patientId: "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb",
        }),
      )
      expect(res.status).toBe(404)
      expect((await res.json()).code).toBe("PATIENT_NOT_FOUND")
      expect(rpc).not.toHaveBeenCalled()
    })

    it("passes an owned patientId through to the sale RPC", async () => {
      rpc.mockResolvedValue({ data: { sale_id: "s3", receipt_number: "R-3" }, error: null })
      const res = await POST(
        makeRequest({
          items: [{ productId: "p1", quantity: 1, unitPrice: 1000 }],
          paymentMethod: "cash",
          patientId: "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa",
        }),
      )
      expect(res.status).toBe(200)
      expect(rpc).toHaveBeenCalledWith(
        "complete_pharmacy_sale",
        expect.objectContaining({ p_patient_id: "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa" }),
      )
    })
  })
})
