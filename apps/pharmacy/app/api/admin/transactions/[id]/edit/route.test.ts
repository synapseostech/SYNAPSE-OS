import { beforeEach, describe, expect, it, vi } from "vitest"

// An in-place edit changes prices, not the taxable mix. Recomputing tax from a
// hardcoded 0 erased the record's tax and moved net_amount, which reports sum.
const state = vi.hoisted(() => ({
  existing: {} as Record<string, unknown>,
  transactionUpdates: [] as Array<Record<string, unknown>>,
  inserts: [] as Array<{ table: string; payload: unknown }>,
}))

vi.mock("@/lib/api-auth", () => ({
  requirePharmacyTenant: async () => ({
    ok: true as const,
    tenantId: "tenant-A",
    session: { user: { id: "user-A" }, userId: "user-A", tenantId: "tenant-A" },
  }),
}))

vi.mock("@/lib/supabase/admin", () => {
  const from = (table: string) => {
    const q: any = {
      select: () => q,
      eq: () => q,
      in: () => q,
      order: () => q,
      update: (payload: Record<string, unknown>) => {
        if (table === "pharmacy_transactions") state.transactionUpdates.push(payload)
        q.applied = payload
        return q
      },
      insert: async (payload: unknown) => {
        state.inserts.push({ table, payload })
        return { error: null }
      },
      maybeSingle: async () =>
        table === "pharmacy_pos_sales"
          ? { data: null, error: null }
          : { data: state.existing, error: null },
      single: async () => ({
        data: q.applied ? { ...state.existing, ...q.applied } : state.existing,
        error: null,
      }),
      then: (resolve: (value: unknown) => unknown) => resolve({ data: [], error: null }),
    }
    return q
  }
  return { supabaseAdmin: { from } }
})

import { PUT } from "./route"

const URL_ = "http://pharm.test/api/admin/transactions/tx-1/edit"

function put(body: Record<string, unknown>) {
  return PUT(
    new Request(URL_, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        reason: "Corrected the unit price after a supplier repricing",
        paymentMethod: "cash",
        ...body,
      }),
    }) as any,
    { params: Promise.resolve({ id: "tx-1" }) },
  )
}

const baseTransaction = {
  id: "tx-1",
  tenant_id: "tenant-A",
  transaction_no: "TX-0001",
  notes: null,
  items: [{ id: "item-1", quantity: 2 }],
}

describe("transaction edit keeps the record's tax", () => {
  beforeEach(() => {
    state.transactionUpdates.length = 0
    state.inserts.length = 0
    state.existing = { ...baseTransaction }
  })

  it("re-applies the record's own effective rate to the new base", async () => {
    state.existing = {
      ...baseTransaction,
      total_amount: 1000,
      discount: 0,
      tax: 180,
      net_amount: 1180,
    }

    const res = await put({ items: [{ id: "item-1", quantity: 2, unitPrice: 600 }] })

    expect(res.status).toBe(200)
    expect(state.transactionUpdates[0]).toMatchObject({
      total_amount: 1200,
      tax: 216,
      net_amount: 1416,
    })
  })

  it("leaves an untaxed sale untaxed instead of inventing tax", async () => {
    state.existing = {
      ...baseTransaction,
      total_amount: 1000,
      discount: 0,
      tax: 0,
      net_amount: 1000,
    }

    const res = await put({ items: [{ id: "item-1", quantity: 2, unitPrice: 600 }] })

    expect(res.status).toBe(200)
    expect(state.transactionUpdates[0]).toMatchObject({
      total_amount: 1200,
      tax: 0,
      net_amount: 1200,
    })
  })

  it("applies the effective rate to the discounted base, not the gross", async () => {
    state.existing = {
      ...baseTransaction,
      total_amount: 1000,
      discount: 100,
      tax: 162,
      net_amount: 1062,
    }

    const res = await put({ items: [{ id: "item-1", quantity: 2, unitPrice: 550 }] })

    expect(res.status).toBe(200)
    // 162 / (1000 - 100) = 0.18; base 1100 - 100 = 1000; tax 180.
    expect(state.transactionUpdates[0]).toMatchObject({
      total_amount: 1100,
      discount: 100,
      tax: 180,
      net_amount: 1180,
    })
  })

  it("refuses rather than dropping tax when the record has no taxable base", async () => {
    state.existing = {
      ...baseTransaction,
      total_amount: 0,
      discount: 0,
      tax: 50,
      net_amount: 50,
    }

    const res = await put({ items: [{ id: "item-1", quantity: 2, unitPrice: 600 }] })

    expect(res.status).toBe(409)
    expect(await res.json()).toMatchObject({ code: "TAX_BASE_MISSING" })
    expect(state.transactionUpdates).toHaveLength(0)
  })
})
