import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const { lookupLabBridge, dbFrom } = vi.hoisted(() => ({
  lookupLabBridge: vi.fn(),
  dbFrom: vi.fn(),
}))

vi.mock("@/lib/lab-bridge-auth", () => ({
  lookupLabBridge: (...args: unknown[]) => lookupLabBridge(...args),
  lookupLabBridgeDetailed: async (presented: string) => {
    const bridge = await lookupLabBridge(presented)
    return bridge ? { ok: true, bridge } : { ok: false, reason: "invalid" }
  },
}))

vi.mock("@synapse/db/admin", () => ({
  supabaseAdmin: { from: (...args: unknown[]) => dbFrom(...args) },
}))

const TENANT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
const DEVICE = "device-1"
const BRIDGE = { id: "bridge-1", tenant_id: TENANT, is_active: true, device_id: DEVICE }

function chain(result: { data?: unknown; error?: unknown }) {
  const api: Record<string, unknown> = {}
  const self = () => api
  for (const method of ["select", "eq", "insert", "update", "order", "limit"]) api[method] = vi.fn(self)
  api.maybeSingle = vi.fn(async () => ({ data: result.data ?? null, error: result.error ?? null }))
  api.then = (resolve: (value: { data: unknown; error: unknown }) => unknown, reject?: (reason: unknown) => unknown) =>
    Promise.resolve({ data: result.data ?? null, error: result.error ?? null }).then(resolve, reject)
  return api
}

describe("POST /api/lab/instrument-ingest", () => {
  beforeEach(() => {
    lookupLabBridge.mockResolvedValue(BRIDGE)
  })
  afterEach(() => vi.resetModules())

  it("rejects an invalid bridge key", async () => {
    lookupLabBridge.mockResolvedValue(null)
    const { POST } = await import("./route")
    const res = await POST(new Request("https://os.test/api/lab/instrument-ingest", {
      method: "POST",
      headers: { "content-type": "application/json", "x-lab-bridge-key": "bad" },
      body: JSON.stringify({ deviceId: DEVICE, rawPayload: "R|1|^^^WBC|6.8" }),
    }) as never)
    expect(res.status).toBe(401)
  })

  it("quarantines a bad ASTM checksum instead of staging a result", async () => {
    dbFrom.mockImplementation((table: string) => {
      if (table === "lab_devices") return chain({ data: { id: DEVICE, tenant_id: TENANT, active: true, validation_status: "ACTIVE" } })
      return chain({ data: { id: "msg-1" } })
    })
    const { POST } = await import("./route")
    const framed = `\u00021H|\\^&\u0003FF\r`
    const res = await POST(new Request("https://os.test/api/lab/instrument-ingest", {
      method: "POST",
      headers: { "content-type": "application/json", "x-lab-bridge-key": "secret" },
      body: JSON.stringify({ deviceId: DEVICE, protocol: "ASTM", rawPayload: framed }),
    }) as never)
    expect(res.status).toBe(422)
    const json = await res.json()
    expect(json.quarantined).toBe(true)
  })

  it("does not ingest when the device is only CONNECTED", async () => {
    dbFrom.mockImplementation((table: string) => {
      if (table === "lab_devices") return chain({ data: { id: DEVICE, tenant_id: TENANT, active: true, validation_status: "CONNECTED" } })
      return chain({ data: null })
    })
    const { POST } = await import("./route")
    const res = await POST(new Request("https://os.test/api/lab/instrument-ingest", {
      method: "POST",
      headers: { "content-type": "application/json", "x-lab-bridge-key": "secret" },
      body: JSON.stringify({ deviceId: DEVICE, rawPayload: "R|1|^^^WBC|6.8" }),
    }) as never)
    expect(res.status).toBe(403)
  })

  it("returns DUPLICATE for the same payload hash", async () => {
    dbFrom.mockImplementation((table: string) => {
      if (table === "lab_devices") return chain({ data: { id: DEVICE, tenant_id: TENANT, active: true, validation_status: "ACTIVE" } })
      if (table === "lab_device_messages") return chain({ data: { id: "existing-msg" } })
      return chain({ data: null })
    })
    const { POST } = await import("./route")
    const res = await POST(new Request("https://os.test/api/lab/instrument-ingest", {
      method: "POST",
      headers: { "content-type": "application/json", "x-lab-bridge-key": "secret" },
      body: JSON.stringify({ deviceId: DEVICE, rawPayload: "R|1|^^^WBC|6.8", protocol: "ASTM" }),
    }) as never)
    const json = await res.json()
    expect(json.duplicate).toBe(true)
    expect(json.match).toBe("DUPLICATE")
  })

  it("looks every analyte's mapping up in one query and stages each one", async () => {
    const { queryMock } = await import("../../../../lib/lab/testing/db-mock")
    let messageCalls = 0
    const mappingQueries: ReturnType<typeof queryMock>[] = []
    const staging: ReturnType<typeof queryMock>[] = []
    dbFrom.mockImplementation((table: string) => {
      if (table === "lab_devices") return queryMock({ data: { id: DEVICE, tenant_id: TENANT, active: true, validation_status: "ACTIVE" } }).builder
      if (table === "lab_device_messages") return queryMock({ data: messageCalls++ === 0 ? null : { id: "msg-new" } }).builder
      if (table === "lab_specimens") return queryMock({ data: { id: "spec", lab_order_id: "order-1", patient_id: "p" } }).builder
      if (table === "lab_device_test_mappings") {
        const q = queryMock({ data: [
          { analyzer_code: "WBC", loinc_code: "6690-2", analyzer_name: "WBC", unit: "10*9/L" },
          { analyzer_code: "HGB", loinc_code: "718-7", analyzer_name: "Haemoglobin", unit: "g/dL" },
        ] })
        mappingQueries.push(q)
        return q.builder
      }
      if (table === "lab_result_staging") { const q = queryMock({ data: null }); staging.push(q); return q.builder }
      return queryMock({ data: null }).builder
    })
    const { POST } = await import("./route")
    const res = await POST(new Request("https://os.test/api/lab/instrument-ingest", {
      method: "POST",
      headers: { "content-type": "application/json", "x-lab-bridge-key": "secret" },
      body: JSON.stringify({
        deviceId: DEVICE, rawPayload: "OBX|1|NM|WBC||6.8", protocol: "hl7", accessionNumber: "LAB-20261121-000001",
        observations: [
          { analyzerCode: "WBC", value: "6.8", unit: "10*9/L" },
          { analyzerCode: "HGB", value: "13.1", unit: "g/dL" },
          { analyzerCode: "XYZ", value: "1" },
        ],
      }),
    }) as never)
    expect(res.status).toBe(200)
    expect(mappingQueries).toHaveLength(1)
    const inCalls = mappingQueries[0]!.calls.filter((c) => c.method === "in")
    expect(inCalls).toEqual([{ method: "in", args: ["analyzer_code", ["WBC", "HGB", "XYZ"]] }])
    const rows = staging[0]!.calls.find((c) => c.method === "insert")!.args[0] as Array<Record<string, unknown>>
    expect(rows.map((r) => [r.analyzer_code, r.mapped_loinc, r.status])).toEqual([
      ["WBC", "6690-2", "READY_FOR_REVIEW"],
      ["HGB", "718-7", "READY_FOR_REVIEW"],
      ["XYZ", null, "UNMAPPED"],
    ])
  })
})
