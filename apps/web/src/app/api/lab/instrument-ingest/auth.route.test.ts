import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { issueBridgeSecret } from "@synapse/db/lab-device-intelligence"

const HMAC = "lab-bridge-test-hmac-secret"
const TENANT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
const DEVICE = "11111111-1111-4111-8111-111111111111"
const OTHER_DEVICE = "22222222-2222-4222-8222-222222222222"
const issued = issueBridgeSecret(HMAC)

const { dbFrom } = vi.hoisted(() => ({ dbFrom: vi.fn() }))

vi.mock("@synapse/db/admin", () => ({
  supabaseAdmin: { from: (...args: unknown[]) => dbFrom(...args) },
}))

vi.mock("@/lib/lab-bridge-auth", async () => await import("../../../../lib/lab-bridge-auth"))

type Row = Record<string, unknown>

function mockFrom(rowsByTable: Record<string, Row[]>) {
  return (table: string) => {
    const rows = rowsByTable[table] ?? []
    const filters: Array<{ kind: string; col: string; val: unknown }> = []
    const api: Record<string, unknown> = {}
    const self = () => api
    for (const method of ["select", "insert", "update", "order", "limit"]) api[method] = vi.fn(self)
    api.eq = vi.fn((col: string, val: unknown) => { filters.push({ kind: "eq", col, val }); return api })
    api.is = vi.fn((col: string, val: unknown) => { filters.push({ kind: "is", col, val }); return api })
    api.not = vi.fn((col: string, _op: string, val: unknown) => { filters.push({ kind: "not", col, val }); return api })
    const filtered = () => rows.filter((row) => filters.every((filter) => {
      const value = row[filter.col]
      if (filter.kind === "eq") return value === filter.val
      if (filter.kind === "is") return (value ?? null) === filter.val
      if (filter.kind === "not" && filter.val === null) return value != null
      return true
    }))
    api.maybeSingle = vi.fn(async () => ({ data: filtered()[0] ?? null, error: null }))
    // Bridge credential lookups are list queries (prefix candidates); honour filters there.
    api.then = (resolve: (value: { data: unknown; error: unknown }) => unknown, reject?: (reason: unknown) => unknown) =>
      Promise.resolve({ data: table === "lab_instrument_bridges" ? filtered() : rows, error: null }).then(resolve, reject)
    return api
  }
}

const modernBridge = {
  id: "bridge-modern",
  tenant_id: TENANT,
  name: "edge",
  is_active: true,
  device_id: DEVICE,
  revoked_at: null,
  api_key: null,
  api_key_hash: issued.hash,
  api_key_prefix: issued.prefix,
}

const device = { id: DEVICE, tenant_id: TENANT, active: true, validation_status: "ACTIVE" }

describe("instrument ingest / heartbeat credential enforcement", () => {
  beforeEach(() => {
    process.env.LAB_BRIDGE_HASH_SECRET = HMAC
  })
  afterEach(() => {
    delete process.env.LAB_BRIDGE_HASH_SECRET
  })

  it("accepts a valid modern secret for ingest and heartbeat", async () => {
    dbFrom.mockImplementation(mockFrom({
      lab_instrument_bridges: [modernBridge],
      lab_devices: [device],
      lab_device_messages: [],
      lab_result_staging: [],
    }))
    const ingest = await import("./route")
    const heartbeat = await import("../edge/heartbeat/route")
    const ingestRes = await ingest.POST(new Request("https://os.test/api/lab/instrument-ingest", {
      method: "POST",
      headers: { "content-type": "application/json", "x-lab-bridge-key": issued.secret },
      body: JSON.stringify({ deviceId: DEVICE, rawPayload: "R|1|^^^WBC|6.8", protocol: "ASTM" }),
    }) as never)
    expect(ingestRes.status).toBeLessThan(500)
    expect(ingestRes.status).not.toBe(401)

    const hb = await heartbeat.POST(new Request("https://os.test/api/lab/edge/heartbeat", {
      method: "POST",
      headers: { "content-type": "application/json", "x-lab-bridge-key": issued.secret },
      body: JSON.stringify({ deviceId: DEVICE, serviceState: "RUNNING", timestamp: new Date().toISOString() }),
    }) as never)
    expect(hb.status).not.toBe(401)
  })

  it("rejects reconstructed placeholder, prefix, and wrong device", async () => {
    dbFrom.mockImplementation(mockFrom({
      lab_instrument_bridges: [modernBridge],
      lab_devices: [device],
    }))
    const ingest = await import("./route")
    const heartbeat = await import("../edge/heartbeat/route")
    const placeholder = `ref:${DEVICE}:${issued.prefix}`
    for (const key of [placeholder, issued.prefix, "ref:random:value"]) {
      const ingestRes = await ingest.POST(new Request("https://os.test/api/lab/instrument-ingest", {
        method: "POST",
        headers: { "content-type": "application/json", "x-lab-bridge-key": key },
        body: JSON.stringify({ deviceId: DEVICE, rawPayload: "R|1|^^^WBC|6.8" }),
      }) as never)
      expect(ingestRes.status, key).toBe(401)
      const hb = await heartbeat.POST(new Request("https://os.test/api/lab/edge/heartbeat", {
        method: "POST",
        headers: { "content-type": "application/json", "x-lab-bridge-key": key },
        body: JSON.stringify({ deviceId: DEVICE, serviceState: "RUNNING" }),
      }) as never)
      expect(hb.status, key).toBe(401)
    }

    const wrongDevice = await ingest.POST(new Request("https://os.test/api/lab/instrument-ingest", {
      method: "POST",
      headers: { "content-type": "application/json", "x-lab-bridge-key": issued.secret },
      body: JSON.stringify({ deviceId: OTHER_DEVICE, rawPayload: "R|1|^^^WBC|6.8" }),
    }) as never)
    expect(wrongDevice.status).toBe(403)
  })

  it("rejects a revoked modern secret", async () => {
    dbFrom.mockImplementation(mockFrom({
      lab_instrument_bridges: [{ ...modernBridge, is_active: false, revoked_at: "2026-09-20T21:00:00.000Z" }],
      lab_devices: [device],
    }))
    const ingest = await import("./route")
    const res = await ingest.POST(new Request("https://os.test/api/lab/instrument-ingest", {
      method: "POST",
      headers: { "content-type": "application/json", "x-lab-bridge-key": issued.secret },
      body: JSON.stringify({ deviceId: DEVICE, rawPayload: "R|1|^^^WBC|6.8" }),
    }) as never)
    expect(res.status).toBe(401)
  })
})
