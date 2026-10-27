import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextResponse } from "next/server"

const { requireMobilePharmacyAuth, isMobileAuth, mobileHasPharmacyCapability, logAudit } = vi.hoisted(
  () => ({
    requireMobilePharmacyAuth: vi.fn(),
    isMobileAuth: vi.fn(),
    mobileHasPharmacyCapability: vi.fn(),
    logAudit: vi.fn(),
  }),
)

vi.mock("../../../../../lib/mobile-pharmacy-auth", () => ({
  requireMobilePharmacyAuth: (...args: unknown[]) => requireMobilePharmacyAuth(...args),
  isMobileAuth: (...args: unknown[]) => isMobileAuth(...args),
  mobileHasPharmacyCapability: (...args: unknown[]) => mobileHasPharmacyCapability(...args),
}))

vi.mock("@synapse/db", () => ({
  logAudit: (...args: unknown[]) => logAudit(...args),
}))

const state = {
  rows: [] as unknown[],
  created: null as Record<string, unknown> | null,
  updated: null as Record<string, unknown> | null,
  inserts: [] as Array<Record<string, unknown>>,
  patches: [] as Array<Record<string, unknown>>,
  filters: [] as Array<[string, unknown]>,
  fail: false,
}

vi.mock("@synapse/db/admin", () => ({
  supabaseAdmin: {
    from: () => {
      const builder: Record<string, unknown> = {}
      let mode: "insert" | "update" | null = null
      const self = () => builder
      builder.select = self
      builder.order = self
      builder.eq = (column: string, value: unknown) => {
        state.filters.push([column, value])
        return builder
      }
      builder.insert = (row: Record<string, unknown>) => {
        mode = "insert"
        state.inserts.push(row)
        return builder
      }
      builder.update = (patch: Record<string, unknown>) => {
        mode = "update"
        state.patches.push(patch)
        return builder
      }
      builder.single = () =>
        Promise.resolve({
          data: mode === "insert" ? state.created : state.updated,
          error: state.fail ? { message: "boom" } : null,
        })
      builder.then = (resolve: (value: unknown) => unknown) =>
        Promise.resolve({
          data: state.rows,
          error: state.fail ? { message: "boom" } : null,
        }).then(resolve)
      return builder
    },
  },
}))

import { GET, PATCH, POST } from "./route"

function auth(role = "pharmacist", tenantId = "tenant-a") {
  return { userId: "user-1", tenantId, role, token: "t" }
}

function request(method: string, body?: unknown) {
  return new Request("https://app.test/api/mobile/pharmacy/branches", {
    method,
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }) as never
}

function capabilitySet(caps: string[]) {
  return (_auth: unknown, capability: string) => caps.includes(capability)
}

const branchRow = {
  id: "b1",
  name: "Kampala Main",
  store_type: "main",
  is_active: true,
  is_warehouse: false,
  parent_store_id: null,
  address: null,
  district: "Kampala",
  phone: "0770000000",
  created_at: "2026-10-01T00:00:00.000Z",
}

describe("mobile pharmacy branches", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    state.rows = []
    state.created = null
    state.updated = null
    state.inserts = []
    state.patches = []
    state.filters = []
    state.fail = false
    isMobileAuth.mockImplementation(
      (value: unknown) =>
        Boolean(value) && typeof value === "object" && !(value instanceof NextResponse) && "tenantId" in (value as object),
    )
  })

  it("denies the branch list to a role without site permissions", async () => {
    requireMobilePharmacyAuth.mockResolvedValue(auth("pharmacy_staff"))
    mobileHasPharmacyCapability.mockReturnValue(false)

    const res = await GET(request("GET"))

    expect(res.status).toBe(403)
  })

  it("lists this tenant's branches", async () => {
    requireMobilePharmacyAuth.mockResolvedValue(auth())
    mobileHasPharmacyCapability.mockImplementation(capabilitySet(["inventory.read"]))
    state.rows = [branchRow]

    const res = await GET(request("GET"))

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.branches[0]).toMatchObject({
      id: "b1",
      name: "Kampala Main",
      storeType: "main",
      district: "Kampala",
      isActive: true,
    })
    expect(state.filters).toContainEqual(["tenant_id", "tenant-a"])
  })

  it("refuses creation without the settings capability", async () => {
    requireMobilePharmacyAuth.mockResolvedValue(auth())
    mobileHasPharmacyCapability.mockImplementation(capabilitySet(["inventory.read"]))

    const res = await POST(request("POST", { name: "Ntinda" }))

    expect(res.status).toBe(403)
    expect(state.inserts).toHaveLength(0)
  })

  it("requires a branch name", async () => {
    requireMobilePharmacyAuth.mockResolvedValue(auth())
    mobileHasPharmacyCapability.mockImplementation(capabilitySet(["settings.manage"]))

    const res = await POST(request("POST", { name: "   " }))

    expect(res.status).toBe(400)
    expect(state.inserts).toHaveLength(0)
  })

  it("creates a warehouse branch and audits it", async () => {
    requireMobilePharmacyAuth.mockResolvedValue(auth())
    mobileHasPharmacyCapability.mockImplementation(capabilitySet(["settings.manage"]))
    state.created = { ...branchRow, id: "b2", name: "Central Store", store_type: "warehouse", is_warehouse: true }

    const res = await POST(
      request("POST", { name: "Central Store", storeType: "warehouse", district: "Wakiso" }),
    )

    expect(res.status).toBe(201)
    expect(state.inserts[0]).toMatchObject({
      tenant_id: "tenant-a",
      name: "Central Store",
      store_type: "warehouse",
      is_warehouse: true,
      district: "Wakiso",
    })
    expect(logAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        actor_id: "user-1",
        action: "CREATE_PHARMACY_BRANCH",
        tenant_id: "tenant-a",
      }),
    )
  })

  it("rejects an unknown site type on update", async () => {
    requireMobilePharmacyAuth.mockResolvedValue(auth())
    mobileHasPharmacyCapability.mockImplementation(capabilitySet(["settings.manage"]))

    const res = await PATCH(request("PATCH", { id: "b1", storeType: "castle" }))

    expect(res.status).toBe(400)
    expect(state.patches).toHaveLength(0)
  })

  it("updates a branch scoped to the tenant and audits it", async () => {
    requireMobilePharmacyAuth.mockResolvedValue(auth())
    mobileHasPharmacyCapability.mockImplementation(capabilitySet(["settings.manage"]))
    state.updated = { ...branchRow, is_active: false }

    const res = await PATCH(request("PATCH", { id: "b1", isActive: false, district: "Entebbe" }))

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toMatchObject({ id: "b1", isActive: false })
    expect(state.patches[0]).toMatchObject({ is_active: false, district: "Entebbe" })
    expect(state.filters).toContainEqual(["id", "b1"])
    expect(state.filters).toContainEqual(["tenant_id", "tenant-a"])
    expect(logAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "UPDATE_PHARMACY_BRANCH", resource_id: "b1" }),
    )
  })
})
