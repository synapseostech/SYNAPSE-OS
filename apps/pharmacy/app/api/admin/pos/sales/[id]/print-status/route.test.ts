import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest, NextResponse } from "next/server"

const m = vi.hoisted(() => ({
  auth: vi.fn(),
  updates: [] as Record<string, unknown>[],
  eqs: [] as [string, unknown][],
  tables: [] as string[],
  audits: [] as Record<string, unknown>[],
  auditError: null as { message: string } | null,
  sale: { data: { id: "11111111-1111-4111-8111-111111111111", receipt_number: "POS-0001" } as any, error: null as any },
}))

vi.mock("@/lib/api-auth", () => ({
  requirePharmacyPermission: (...args: unknown[]) => m.auth(...args),
}))

vi.mock("@/lib/supabase/admin", () => {
  const supabaseAdmin = {
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
  }
  return { supabaseAdmin }
})

import { POST } from "./route"

const SALE_A = "11111111-1111-4111-8111-111111111111"
const SALE_B = "22222222-2222-4222-8222-222222222222"

const post = (body: unknown, id = SALE_A) =>
  POST(
    new NextRequest(`http://localhost/api/admin/pos/sales/${id}/print-status`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id }) },
  )

describe("POST /api/admin/pos/sales/[id]/print-status", () => {
  beforeEach(() => {
    m.auth.mockReset()
    m.auth.mockResolvedValue({
      ok: true,
      tenantId: "tenant-1",
      session: { user: { id: "cashier-1" } },
    })
    m.updates.length = 0
    m.eqs.length = 0
    m.tables.length = 0
    m.audits.length = 0
    m.auditError = null
    m.sale = { data: { id: SALE_A, receipt_number: "POS-0001" }, error: null }
  })

  it("records a print request for the tenant and audits the cashier", async () => {
    const res = await post({ outcome: "requested" })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({
      ok: true,
      saleId: SALE_A,
      receiptNumber: "POS-0001",
      printFailed: false,
      auditRecorded: true,
      physicalPrintConfirmed: false,
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

  it("records a failed print with the cashier's reason instead of hiding it", async () => {
    const res = await post({ outcome: "failed", reason: "  paper jam " })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ ok: true, printFailed: true })
    expect(m.updates[0].print_failed).toBe(true)
    expect(m.audits[0].action).toBe("POS_RECEIPT_PRINT_FAILED")
    expect(String(m.audits[0].details)).toContain("reason=paper jam")
  })

  it("records a default reason when the cashier gives none", async () => {
    await post({ outcome: "failed" })
    expect(String(m.audits[0].details)).toContain("reason=printer unavailable")
  })

  it("writes only print-tracking columns, never money, stock or status", async () => {
    await post({ outcome: "requested" })
    expect(Object.keys(m.updates[0]).sort()).toEqual([
      "print_failed",
      "updated_at",
    ])
    expect(m.tables.filter((table) => table !== "pharmacy_pos_sales" && table !== "pharmacy_audit_logs")).toEqual([])
  })

  it("reports the outcome it recorded so the till knows what was claimed", async () => {
    const res = await post({ outcome: "requested" })
    expect(await res.json()).toMatchObject({ outcome: "requested", printFailed: false })
  })

  it("refuses 'printed': a browser cannot prove paper came out", async () => {
    const res = await post({ outcome: "printed" })
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ code: "INVALID_PRINT_OUTCOME" })
    expect(m.tables).toEqual([])
  })

  it("rejects an unknown outcome before touching the database", async () => {
    const res = await post({ outcome: "success" })
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ code: "INVALID_PRINT_OUTCOME" })
    expect(m.tables).toEqual([])
    expect(m.audits).toEqual([])
  })

  it("rejects a malformed sale id with 400 rather than letting the cast fail as a 500", async () => {
    const res = await post({ outcome: "requested" }, "not-a-uuid")
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ code: "INVALID_SALE_ID" })
    expect(m.tables).toEqual([])
  })

  it("returns 404 for a sale that is not in this tenant and writes no audit row", async () => {
    m.sale = { data: null, error: null }
    const res = await post({ outcome: "requested" }, SALE_B)
    expect(res.status).toBe(404)
    expect(m.audits).toEqual([])
  })

  it("surfaces a database failure instead of claiming the print was recorded", async () => {
    m.sale = { data: null, error: { message: "connection reset" } }
    const res = await post({ outcome: "requested" })
    expect(res.status).toBe(500)
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

  it("does not record anything without an authorised cashier", async () => {
    m.auth.mockResolvedValue({
      ok: false,
      response: NextResponse.json({ error: "Unauthorized" }, { status: 401 }),
    })
    const res = await post({ outcome: "requested" })
    expect(res.status).toBe(401)
    expect(m.tables).toEqual([])
    expect(m.updates).toEqual([])
  })

  it("requires the POS sell capability, not just any signed-in session", async () => {
    await post({ outcome: "requested" })
    expect(m.auth).toHaveBeenCalledWith("pos.sell")
  })
})
