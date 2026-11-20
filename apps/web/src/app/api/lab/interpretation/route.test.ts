import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { NextResponse } from "next/server"

const { requireHospitalStaffContext, gateHospitalModule, dbFrom } = vi.hoisted(() => ({
  requireHospitalStaffContext: vi.fn(),
  gateHospitalModule: vi.fn(),
  dbFrom: vi.fn(),
}))

// Role groups the route now shares with the other lab screens (real module).
vi.mock("@/lib/lab/roles", () => import("../../../../lib/lab/roles"))

vi.mock("@/lib/hospital-dept", () => ({
  requireHospitalStaffContext: (...args: unknown[]) => requireHospitalStaffContext(...args),
}))

vi.mock("@/lib/hospital-shared", async () => {
  const { NextResponse } = await import("next/server")
  return {
    isContextError: (value: unknown): value is InstanceType<typeof NextResponse> => value instanceof NextResponse,
    gateHospitalModule: (...args: unknown[]) => gateHospitalModule(...args),
  }
})

vi.mock("@synapse/db/admin", () => ({
  supabaseAdmin: { from: (...args: unknown[]) => dbFrom(...args) },
}))

const TENANT = "11111111-1111-4111-8111-111111111111"
const RESULT = "22222222-2222-4222-8222-222222222222"
const ORDER = "33333333-3333-4333-8333-333333333333"

function staff(role = "lab_scientist") {
  return { userId: "user-1", email: "lab@example.test", role, tenantId: TENANT, hospitalId: TENANT, facilityType: "hospital", fullName: "Lab" }
}

function tableMock(handlers: Record<string, { data?: unknown; error?: unknown }>) {
  return (table: string) => {
    const handler = handlers[table] ?? { data: null, error: null }
    const api: Record<string, unknown> = {}
    const self = () => api
    for (const method of ["select", "eq", "order", "limit", "insert", "update"]) api[method] = vi.fn(self)
    api.maybeSingle = vi.fn(async () => ({ data: handler.data ?? null, error: handler.error ?? null }))
    return api
  }
}

describe("POST /api/lab/interpretation", () => {
  beforeEach(() => {
    requireHospitalStaffContext.mockResolvedValue(staff())
    gateHospitalModule.mockResolvedValue(null)
    dbFrom.mockImplementation(tableMock({
      lab_results: { data: { id: RESULT, test_name: "WBC", result_value: "17.6", abnormal_flag: "H", is_critical: true, lab_order_id: ORDER } },
      lab_orders: { data: { patient_id: "patient-1", encounter_id: "enc-1" } },
    }))
  })
  afterEach(() => vi.resetModules())

  it("returns structured lab analysis and never grants verify/release authority", async () => {
    const { POST } = await import("./route")
    const res = await POST(new Request("https://os.test/api/lab/interpretation", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ resultId: RESULT }),
    }) as never)
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.label).toMatch(/Does not verify or release/)
    expect(json.recommendation.task).toBe("lab_interpretation")
    expect(json.analysis.summary).toBeTruthy()
    expect(json.analysis.provenance).toBeTruthy()
  })

  it("rejects forbidden AI authority actions and caller-supplied foreign tenants", async () => {
    const { POST } = await import("./route")
    const forbidden = await POST(new Request("https://os.test/api/lab/interpretation", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ resultId: RESULT, forbiddenAction: "release_lab_result" }),
    }) as never)
    expect(forbidden.status).toBe(403)

    const tenant = await POST(new Request("https://os.test/api/lab/interpretation", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ resultId: RESULT, tenantId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" }),
    }) as never)
    expect(tenant.status).toBe(403)
  })
})
