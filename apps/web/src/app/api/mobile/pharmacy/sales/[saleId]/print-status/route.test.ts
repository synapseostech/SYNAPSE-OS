import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest, NextResponse } from "next/server"

const m = vi.hoisted(() => ({
  auth: vi.fn(),
  hasCapability: true,
  capabilitiesAsked: [] as string[],
  updates: [] as Record<string, unknown>[],
  eqs: [] as [string, unknown][],
  tables: [] as string[],
  audits: [] as Record<string, unknown>[],
  auditError: null as { message: string } | null,
  sale: { data: { id: "sale" } as any, error: null as any },
}))

vi.mock("../../../../../../../lib/mobile-pharmacy-auth", () => ({
  requireMobilePharmacyAuth: (...args: unknown[]) => m.auth(...args),
  isMobileAuth: (value: any) => Boolean(value && value.userId),
  mobileHasPharmacyCapability: (_auth: unknown, capability: string) => {
    m.capabilitiesAsked.push(capability)
    return m.hasCapability
  },
}))

vi.mock("@synapse/db/admin", () => ({
  supabaseAdmin: {
    from(table: string) {
      m.tables.push(table)
      if (table === "pharmacy_pos_sales") {
        const chain: any = {
          update(values: Record<string, unknown>) {
            m.updates.push(values)
            return chain
          },
          eq(column: string, value: unknown) {
            m.eqs.push([column, value])
            return chain
          },
          select() {
            return chain
          },
          async maybeSingle() {
            return m.sale
          },
        }
        return chain
      }
      return {
        async insert(row: Record<string, unknown>) {
          m.audits.push(row)
          return { error: m.auditError }
        },
      }
    },
  },
}))

import { POST } from "./route"

const SALE_A = "11111111-1111-4111-8111-111111111111"
const SALE_B = "22222222-2222-4222-8222-222222222222"

const post = (body: unknown, saleId = SALE_A, token = "token-1") =>
  POST(
    new NextRequest(`http://localhost/api/mobile/pharmacy/sales/${saleId}/print-status`, {
      method: "POST",
      headers: token ? { authorization: `Bearer ${token}` } : {},
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ saleId }) },
  )

beforeEach(() => {
  m.auth.mockReset()
  m.auth.mockResolvedValue({
    userId: "cashier-1",
    tenantId: "tenant-1",
    role: "pharmacy_cashier",
    token: "token-1",
  })
  m.hasCapability = true
  m.capabilitiesAsked.length = 0
  m.updates.length = 0
  m.eqs.length = 0
  m.tables.length = 0
  m.audits.length = 0
  m.auditError = null
  m.sale = { data: { id: SALE_A, receipt_number: "POS-0001" }, error: null }
})

describe("POST /api/mobile/pharmacy/sales/[saleId]/print-status", () => {
  it("records a print request in the same columns and audit row as the web till", async () => {
    const res = await post({ outcome: "requested" })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({
      ok: true,
      saleId: SALE_A,
      receiptNumber: "POS-0001",
      outcome: "requested",
      printFailed: false,
      physicalPrintConfirmed: false,
      auditRecorded: true,
    })
    expect(m.eqs).toContainEqual(["id", SALE_A])
    expect(m.eqs).toContainEqual(["tenant_id", "tenant-1"])
    expect(m.updates).toHaveLength(1)
    expect(m.updates[0]).toMatchObject({ print_failed: false })
    expect(m.updates[0]).not.toHaveProperty("printed_at")
    expect(m.audits).toHaveLength(1)
    expect(m.audits[0]).toMatchObject({
      tenant_id: "tenant-1",
      profile_id: "cashier-1",
      action: "POS_RECEIPT_PRINT_REQUESTED",
      entity: "POS_SALE",
      entity_id: SALE_A,
    })
  })

  it("records the phone's print failure instead of leaving it only on the device", async () => {
    const res = await post({ outcome: "failed", reason: " no printer paired " })
    expect(res.status).toBe(200)
    expect(m.updates[0].print_failed).toBe(true)
    expect(m.audits[0].action).toBe("POS_RECEIPT_PRINT_FAILED")
    expect(String(m.audits[0].details)).toContain("reason=no printer paired")
  })

  it("never touches money, stock or the sale status", async () => {
    await post({ outcome: "failed" })
    expect(Object.keys(m.updates[0]).sort()).toEqual(["print_failed", "updated_at"])
    expect([...new Set(m.tables)].sort()).toEqual([
      "pharmacy_audit_logs",
      "pharmacy_pos_sales",
    ])
  })

  it("refuses 'printed': dismissing the OS print sheet does not prove paper came out", async () => {
    const res = await post({ outcome: "printed" })
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ code: "INVALID_PRINT_OUTCOME" })
    expect(m.tables).toEqual([])
  })

  it("requires the pos.sell capability, not just a pharmacy role", async () => {
    await post({ outcome: "requested" })
    expect(m.capabilitiesAsked).toEqual(["pos.sell"])
    m.capabilitiesAsked.length = 0
    m.tables.length = 0
    m.updates.length = 0
    m.hasCapability = false
    const res = await post({ outcome: "requested" })
    expect(res.status).toBe(403)
    expect(await res.json()).toMatchObject({ code: "FORBIDDEN" })
    expect(m.tables).toEqual([])
  })

  it("rejects a malformed sale id before touching the database", async () => {
    const res = await post({ outcome: "requested" }, "not-a-uuid")
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ code: "INVALID_SALE_ID" })
    expect(m.tables).toEqual([])
  })

  it("returns 404 for a sale in another tenant and writes no audit row", async () => {
    m.sale = { data: null, error: null }
    const res = await post({ outcome: "requested" }, SALE_B)
    expect(res.status).toBe(404)
    expect(m.audits).toEqual([])
  })

  it("reports audit failure without claiming the attempt was fully recorded", async () => {
    m.auditError = { message: "audit table unavailable" }
    const res = await post({ outcome: "requested" })
    expect(res.status).toBe(503)
    expect(await res.json()).toMatchObject({
      code: "PRINT_AUDIT_FAILED",
      attemptRecorded: true,
      outcome: "requested",
    })
  })

  it("does not record anything without an authorised session", async () => {
    m.auth.mockResolvedValue(
      NextResponse.json({ error: "Unauthorized" }, { status: 401 }),
    )
    const res = await post({ outcome: "requested" }, SALE_A, "")
    expect(res.status).toBe(401)
    expect(m.tables).toEqual([])
    expect(m.updates).toEqual([])
  })

  it("surfaces a database failure instead of claiming the print was recorded", async () => {
    m.sale = { data: null, error: { message: "connection reset" } }
    const res = await post({ outcome: "requested" })
    expect(res.status).toBe(500)
    expect(await res.json()).toMatchObject({ code: "PRINT_STATUS_WRITE_FAILED" })
  })
})
