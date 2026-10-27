import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextResponse } from "next/server"

const { requireMobilePharmacyAuth, isMobileAuth, mobileHasPharmacyCapability } = vi.hoisted(() => ({
  requireMobilePharmacyAuth: vi.fn(),
  isMobileAuth: vi.fn(),
  mobileHasPharmacyCapability: vi.fn(),
}))

vi.mock("../../../../../lib/mobile-pharmacy-auth", () => ({
  requireMobilePharmacyAuth: (...args: unknown[]) => requireMobilePharmacyAuth(...args),
  isMobileAuth: (...args: unknown[]) => isMobileAuth(...args),
  mobileHasPharmacyCapability: (...args: unknown[]) => mobileHasPharmacyCapability(...args),
}))

const state = {
  rows: [] as unknown[],
  profiles: [] as unknown[],
  roles: [] as unknown[],
  filters: [] as Array<[string, string, unknown]>,
  limits: [] as number[],
  fail: false,
}

vi.mock("@synapse/db/admin", () => ({
  supabaseAdmin: {
    from: (table: string) => {
      const builder: Record<string, unknown> = {}
      const self = () => builder
      builder.select = self
      builder.order = self
      builder.eq = (column: string, value: unknown) => {
        state.filters.push([table, column, value])
        return builder
      }
      builder.in = (column: string, value: unknown) => {
        state.filters.push([table, column, value])
        return builder
      }
      builder.limit = (value: number) => {
        state.limits.push(value)
        return Promise.resolve({
          data: state.rows,
          error: state.fail ? { message: "boom" } : null,
        })
      }
      builder.then = (resolve: (value: unknown) => unknown) => {
        const data =
          table === "profiles" ? state.profiles : table === "pharmacy_user_settings" ? state.roles : state.rows
        return Promise.resolve({ data, error: null }).then(resolve)
      }
      return builder
    },
  },
}))

import { GET } from "./route"

function auth(role = "pharmacy_store_manager", tenantId = "tenant-a") {
  return { userId: "user-1", tenantId, role, token: "t" }
}

function get(query = "") {
  return new Request(`https://app.test/api/mobile/pharmacy/activity-log${query}`) as never
}

describe("mobile pharmacy activity log", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    state.rows = []
    state.profiles = []
    state.roles = []
    state.filters = []
    state.limits = []
    state.fail = false
    isMobileAuth.mockImplementation(
      (value: unknown) =>
        Boolean(value) && typeof value === "object" && !(value instanceof NextResponse) && "tenantId" in (value as object),
    )
    mobileHasPharmacyCapability.mockImplementation(
      (_auth: unknown, capability: string) => capability === "audit.read",
    )
  })

  it("denies the log without the audit-read capability", async () => {
    requireMobilePharmacyAuth.mockResolvedValue(auth("pharmacy_cashier"))
    mobileHasPharmacyCapability.mockReturnValue(false)

    const res = await GET(get())

    expect(res.status).toBe(403)
    expect(state.limits).toHaveLength(0)
  })

  it("maps the audit trail with names and roles, scoped to the tenant", async () => {
    requireMobilePharmacyAuth.mockResolvedValue(auth())
    state.rows = [
      {
        id: "a1",
        profile_id: "p1",
        action: "UPDATE_PRODUCT",
        entity: "PRODUCT",
        entity_id: "prod-1",
        details: "Adjusted price",
        created_at: "2026-10-20T10:00:00.000Z",
      },
      {
        id: "a2",
        profile_id: null,
        action: "SYSTEM_SYNC",
        entity: "SYSTEM",
        entity_id: null,
        details: null,
        created_at: "2026-10-19T10:00:00.000Z",
      },
    ]
    state.profiles = [{ id: "p1", full_name: "Sam Manager", first_name: null, last_name: null, email: "sam@x" }]
    state.roles = [{ profile_id: "p1", pharmacy_role: "pharmacy_store_manager" }]

    const res = await GET(get("?entity=PRODUCT"))

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.logs[0]).toMatchObject({
      id: "a1",
      action: "UPDATE_PRODUCT",
      entity: "PRODUCT",
      user: { name: "Sam Manager", role: "STORE_MANAGER" },
    })
    expect(body.logs[1]).toMatchObject({
      id: "a2",
      userId: null,
      user: { name: "System", role: "STAFF" },
    })
    expect(state.filters).toContainEqual(["pharmacy_audit_logs", "tenant_id", "tenant-a"])
    expect(state.filters).toContainEqual(["pharmacy_audit_logs", "entity", "PRODUCT"])
  })

  it("caps the page size at 200", async () => {
    requireMobilePharmacyAuth.mockResolvedValue(auth())

    await GET(get("?limit=5000"))

    expect(state.limits[0]).toBe(200)
  })

  it("fails closed when the audit table cannot be read", async () => {
    requireMobilePharmacyAuth.mockResolvedValue(auth())
    state.fail = true

    const res = await GET(get())

    expect(res.status).toBe(500)
  })
})
