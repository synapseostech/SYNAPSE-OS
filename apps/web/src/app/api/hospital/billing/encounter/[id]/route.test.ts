import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { NextResponse } from "next/server"

const {
  requireHospitalStaffContext,
  requireHospitalCapability,
  gateHospitalModule,
  materializeEncounterCharges,
  dbFrom,
} = vi.hoisted(() => ({
  requireHospitalStaffContext: vi.fn(),
  requireHospitalCapability: vi.fn(),
  gateHospitalModule: vi.fn(),
  materializeEncounterCharges: vi.fn(),
  dbFrom: vi.fn(),
}))

vi.mock("server-only", () => ({}))

vi.mock("@/lib/hospital-dept", () => ({
  requireHospitalStaffContext: (...args: unknown[]) => requireHospitalStaffContext(...args),
}))

vi.mock("@/lib/hospital-shared", async () => {
  const { NextResponse } = await import("next/server")
  return {
    isContextError: (value: unknown): value is InstanceType<typeof NextResponse> =>
      value instanceof NextResponse,
    requireHospitalCapability: (...args: unknown[]) => requireHospitalCapability(...args),
    gateHospitalModule: (...args: unknown[]) => gateHospitalModule(...args),
  }
})

vi.mock("@synapse/db/admin", () => ({
  supabaseAdmin: { from: (...args: unknown[]) => dbFrom(...args) },
}))

vi.mock("@synapse/db/clinical-charge", () => ({
  materializeEncounterCharges: (...args: unknown[]) => materializeEncounterCharges(...args),
}))

const TENANT_A = "0edb651a-232a-4289-9b3d-ae5bb1bac2cb"
const TENANT_B = "200dfeb5-4c09-4a5d-8d46-14aa4b78a6ec"
const ENCOUNTER = "72603ece-b91a-45ad-a6bc-c59bff1162db"
const PATIENT = "19bc626f-f51a-4bd5-aefd-7a4534babfeb"
const INVOICE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
const USER = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee"

function staff(role: string, tenantId = TENANT_A) {
  return {
    userId: USER,
    email: `${role}@example.test`,
    role,
    tenantId,
    hospitalId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    facilityType: "hospital",
    fullName: role,
  }
}

function invoiceQuery(data: unknown) {
  return {
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    order: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
    maybeSingle: vi.fn().mockResolvedValue({ data, error: null }),
  }
}

describe("GET /api/hospital/billing/encounter/[id]", () => {
  beforeEach(() => {
    requireHospitalCapability.mockResolvedValue(null)
    gateHospitalModule.mockResolvedValue(null)
    materializeEncounterCharges.mockResolvedValue({
      encounterFound: true,
      patientId: PATIENT,
      invoiceId: INVOICE,
      warnings: [],
    })
  })

  afterEach(() => {
    vi.clearAllMocks()
    vi.resetModules()
  })

  it("404s when the encounter is not in the caller tenant", async () => {
    requireHospitalStaffContext.mockResolvedValue(staff("billing_officer", TENANT_B))
    materializeEncounterCharges.mockResolvedValue({
      encounterFound: false,
      patientId: null,
      invoiceId: null,
      warnings: [],
    })
    const { GET } = await import("./route")
    const res = await GET(new Request("https://synapseos.tech/api/hospital/billing/encounter/" + ENCOUNTER), {
      params: Promise.resolve({ id: ENCOUNTER }),
    })
    expect(res.status).toBe(404)
    expect(materializeEncounterCharges).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ tenantId: TENANT_B, encounterId: ENCOUNTER }),
    )
    expect(dbFrom).not.toHaveBeenCalled()
  })

  it("returns the materialized invoice scoped by ctx.tenantId", async () => {
    requireHospitalStaffContext.mockResolvedValue(staff("billing_officer", TENANT_A))
    const invoice = {
      id: INVOICE,
      encounter_id: ENCOUNTER,
      patient_id: PATIENT,
      tenant_id: TENANT_A,
      total_amount: 34800,
      paid_amount: 0,
      status: "draft",
    }
    const lines = [
      { id: "1", item_name: "OPD Consultation", unit_price: 10000, qty: 1, total_price: 10000 },
    ]
    dbFrom.mockImplementation((table: string) => {
      if (table === "billing_invoices") return invoiceQuery(invoice)
      if (table === "billing_line_items") {
        return {
          select: vi.fn().mockReturnThis(),
          eq: vi.fn().mockReturnThis(),
          order: vi.fn().mockReturnThis(),
          limit: vi.fn().mockResolvedValue({ data: lines, error: null }),
        }
      }
      return {
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        order: vi.fn().mockReturnThis(),
        limit: vi.fn().mockResolvedValue({ data: [], error: null }),
      }
    })
    const { GET } = await import("./route")
    const res = await GET(new Request("https://synapseos.tech/api/hospital/billing/encounter/" + ENCOUNTER), {
      params: Promise.resolve({ id: ENCOUNTER }),
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.invoice.id).toBe(INVOICE)
    expect(body.invoice.encounter_id).toBe(ENCOUNTER)
    expect(body.lineItems).toHaveLength(1)
    expect(body.invoice.balance_due).toBe(34800)
    expect(materializeEncounterCharges).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ tenantId: TENANT_A, encounterId: ENCOUNTER }),
    )
  })
})
