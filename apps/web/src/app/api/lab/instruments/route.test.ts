import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { NextResponse } from "next/server"

const {
  getCurrentUser,
  requireHospitalStaffContext,
  gateHospitalModule,
  logHospitalAudit,
  dbFrom,
} = vi.hoisted(() => ({
  getCurrentUser: vi.fn(),
  requireHospitalStaffContext: vi.fn(),
  gateHospitalModule: vi.fn(),
  logHospitalAudit: vi.fn(),
  dbFrom: vi.fn(),
}))

// Role groups the route now shares with the other lab screens (real module).
vi.mock("@/lib/lab/roles", () => import("../../../../lib/lab/roles"))

vi.mock("@/lib/auth/getCurrentUser", () => ({
  getCurrentUser: (...args: unknown[]) => getCurrentUser(...args),
}))

vi.mock("@/lib/hospital-dept", () => ({
  requireHospitalStaffContext: (...args: unknown[]) => requireHospitalStaffContext(...args),
}))

vi.mock("@/lib/hospital-shared", async () => {
  const { NextResponse } = await import("next/server")
  return {
    isContextError: (value: unknown): value is InstanceType<typeof NextResponse> => value instanceof NextResponse,
    gateHospitalModule: (...args: unknown[]) => gateHospitalModule(...args),
    logHospitalAudit: (...args: unknown[]) => logHospitalAudit(...args),
  }
})

vi.mock("@synapse/db/admin", () => ({
  supabaseAdmin: { from: (...args: unknown[]) => dbFrom(...args) },
}))

const TENANT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"

function staff(role = "lab_manager") {
  return { userId: "user-1", email: "mgr@example.test", role, tenantId: TENANT, hospitalId: TENANT, facilityType: "hospital", fullName: "Mgr" }
}

function chain(result: { data?: unknown; error?: unknown }) {
  const api: Record<string, unknown> = {}
  const self = () => api
  for (const method of ["select", "eq", "insert", "update", "in", "order", "limit"]) api[method] = vi.fn(self)
  api.maybeSingle = vi.fn(async () => ({ data: Array.isArray(result.data) ? null : result.data ?? null, error: result.error ?? null }))
  api.single = vi.fn(async () => ({ data: result.data ?? null, error: result.error ?? null }))
  api.then = (resolve: (value: { data: unknown; error: unknown }) => unknown, reject?: (reason: unknown) => unknown) =>
    Promise.resolve({ data: result.data ?? [], error: result.error ?? null }).then(resolve, reject)
  return api
}

describe("GET/POST /api/lab/instruments", () => {
  beforeEach(() => {
    getCurrentUser.mockResolvedValue({ id: "user-1" })
    requireHospitalStaffContext.mockResolvedValue(staff())
    gateHospitalModule.mockResolvedValue(null)
    logHospitalAudit.mockResolvedValue(undefined)
  })
  afterEach(() => vi.resetModules())

  it("derives operational health and omits configuration secrets", async () => {
    dbFrom.mockImplementation((table: string) => {
      if (table === "lab_devices") return chain({
        data: [{
          id: "dev-1",
          name: "AST-100",
          manufacturer: "SYNAPSE",
          model: "SIM",
          serial_number: "1",
          section: "haematology",
          connection_type: "ASTM",
          protocol: "ASTM",
          validation_status: "ACTIVE",
          health_status: "ONLINE",
          active: true,
          last_seen_at: new Date().toISOString(),
          last_message_at: new Date().toISOString(),
          mapping_profile: "generic-astm",
          configuration: { host: "127.0.0.1", secret: "do-not-leak" },
        }],
      })
      if (table === "lab_instrument_bridges") return chain({ data: [{ device_id: "dev-1", heartbeat_at: new Date().toISOString(), queue_summary: {}, api_key_prefix: "lbk_abc" }] })
      if (table === "lab_device_test_mappings") return chain({ data: [{ device_id: "dev-1", active: true }] })
      if (table === "lab_result_staging") return chain({ data: [] })
      return chain({ data: [] })
    })
    const { GET } = await import("./route")
    const res = await GET()
    const json = await res.json()
    expect(json.devices[0].configuration.secret).toBeUndefined()
    expect(json.devices[0].configuration.host).toBe("127.0.0.1")
    expect(json.devices[0].api_key).toBeUndefined()
    expect(json.devices[0].api_key_hash).toBeUndefined()
    expect(json.devices[0].credential_prefix).toBe("lbk_abc")
    expect(json.devices[0].operational_health).toBeTruthy()
    expect(JSON.stringify(json)).not.toMatch(/api_key_hash/)
    expect(JSON.stringify(json)).not.toMatch(/LAB_BRIDGE_HASH_SECRET/)
  })

  it("registers a device as CONFIGURED, not ACTIVE", async () => {
    dbFrom.mockImplementation(() => chain({ data: { id: "dev-2", name: "Chem", validation_status: "CONFIGURED", connection_type: "HL7_MLLP", protocol: "HL7_MLLP" } }))
    const { POST } = await import("./route")
    const res = await POST(new Request("https://os.test/api/lab/instruments", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Chem", connectionType: "HL7_MLLP", host: "10.0.0.8", port: 2575 }),
    }) as never)
    expect(res.status).toBe(201)
    const json = await res.json()
    expect(json.device.validation_status).toBe("CONFIGURED")
  })
})
