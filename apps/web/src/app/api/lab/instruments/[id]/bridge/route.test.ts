import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { NextResponse } from "next/server"

const {
  requireHospitalStaffContext,
  gateHospitalModule,
  logHospitalAudit,
  dbFrom,
} = vi.hoisted(() => ({
  requireHospitalStaffContext: vi.fn(),
  gateHospitalModule: vi.fn(),
  logHospitalAudit: vi.fn(),
  dbFrom: vi.fn(),
}))

// Role groups the route now shares with the other lab screens (real module).
vi.mock("@/lib/lab/roles", () => import("../../../../../../lib/lab/roles"))

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
const DEVICE = "11111111-1111-4111-8111-111111111111"
const HMAC = "lab-bridge-test-hmac-secret"

function chain(result: { data?: unknown; error?: unknown }) {
  const api: Record<string, unknown> = {}
  const self = () => api
  for (const method of ["select", "eq", "insert", "update"]) api[method] = vi.fn(self)
  api.maybeSingle = vi.fn(async () => ({ data: result.data ?? null, error: result.error ?? null }))
  api.single = vi.fn(async () => ({ data: result.data ?? null, error: result.error ?? null }))
  api.then = (resolve: (value: { data: unknown; error: unknown }) => unknown, reject?: (reason: unknown) => unknown) =>
    Promise.resolve({ data: result.data ?? null, error: result.error ?? null }).then(resolve, reject)
  return api
}

describe("POST /api/lab/instruments/[id]/bridge", () => {
  beforeEach(() => {
    process.env.LAB_BRIDGE_HASH_SECRET = HMAC
    requireHospitalStaffContext.mockResolvedValue({
      userId: "user-1", email: "mgr@example.test", role: "lab_manager", tenantId: TENANT, hospitalId: TENANT, facilityType: "hospital", fullName: "Mgr",
    })
    gateHospitalModule.mockResolvedValue(null)
    logHospitalAudit.mockResolvedValue(undefined)
  })
  afterEach(() => {
    delete process.env.LAB_BRIDGE_HASH_SECRET
    vi.resetModules()
  })

  it("stores a hashed credential with null api_key and returns the secret once", async () => {
    const inserts: Array<Record<string, unknown>> = []
    dbFrom.mockImplementation((table: string) => {
      if (table === "lab_devices") return chain({ data: { id: DEVICE, name: "AST-100" } })
      const api = chain({ data: { id: "bridge-new", api_key_prefix: "lbk_testprefix", created_at: "2026-09-20T21:00:00.000Z" } })
      api.insert = vi.fn((row: Record<string, unknown>) => {
        inserts.push(row)
        return api
      })
      return api
    })
    const { POST } = await import("./route")
    const res = await POST(new Request("https://os.test/api/lab/instruments/id/bridge", { method: "POST" }) as never, { params: Promise.resolve({ id: DEVICE }) })
    expect(res.status).toBe(201)
    const json = await res.json()
    expect(json.secret).toMatch(/^lbk_/)
    expect(json.prefix).toBeTruthy()
    expect(json.secret).not.toEqual(json.prefix)
    expect(inserts[0]?.api_key).toBeNull()
    expect(inserts[0]?.api_key_hash).toBeTruthy()
    expect(String(inserts[0]?.api_key_hash)).not.toEqual(json.secret)
    expect(String(inserts[0]?.api_key ?? "")).not.toMatch(/^ref:/)
  })

  it("fails closed when LAB_BRIDGE_HASH_SECRET is missing", async () => {
    delete process.env.LAB_BRIDGE_HASH_SECRET
    dbFrom.mockImplementation(() => chain({ data: { id: DEVICE, name: "AST-100" } }))
    const { POST } = await import("./route")
    const res = await POST(new Request("https://os.test/api/lab/instruments/id/bridge", { method: "POST" }) as never, { params: Promise.resolve({ id: DEVICE }) })
    expect(res.status).toBe(503)
  })
})
