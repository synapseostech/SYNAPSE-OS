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
  filters: [] as Array<[string, unknown]>,
  limits: [] as number[],
}

vi.mock("@synapse/db/admin", () => ({
  supabaseAdmin: {
    from: () => {
      const builder: Record<string, unknown> = {}
      const self = () => builder
      builder.select = self
      builder.order = self
      builder.eq = (column: string, value: unknown) => {
        state.filters.push([column, value])
        return builder
      }
      builder.limit = (value: number) => {
        state.limits.push(value)
        return Promise.resolve({ data: state.rows, error: null })
      }
      return builder
    },
  },
}))

import { GET } from "./route"

function auth(role = "pharmacist", tenantId = "tenant-a") {
  return { userId: "user-1", tenantId, role, token: "t" }
}

function get(query = "") {
  return new Request(`https://app.test/api/mobile/pharmacy/imports${query}`) as never
}

describe("mobile pharmacy import history", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    state.rows = []
    state.filters = []
    state.limits = []
    isMobileAuth.mockImplementation(
      (value: unknown) =>
        Boolean(value) && typeof value === "object" && !(value instanceof NextResponse) && "tenantId" in (value as object),
    )
  })

  it("denies import history without the inventory write permission", async () => {
    requireMobilePharmacyAuth.mockResolvedValue(auth("pharmacy_cashier"))
    mobileHasPharmacyCapability.mockReturnValue(false)

    const res = await GET(get())

    expect(res.status).toBe(403)
  })

  it("lists this tenant's sessions newest first", async () => {
    requireMobilePharmacyAuth.mockResolvedValue(auth())
    mobileHasPharmacyCapability.mockImplementation((_a: unknown, cap: string) => cap === "inventory.write")
    state.rows = [
      {
        id: "s1",
        source_system: "legacy-csv",
        file_name: "stock.csv",
        status: "complete",
        total_rows: 120,
        matched_rows: 118,
        flagged_rows: 2,
        ai_summary: "Mapped 12 columns",
        error_message: null,
        created_at: "2026-10-20T10:00:00.000Z",
        completed_at: "2026-10-20T10:05:00.000Z",
      },
    ]

    const res = await GET(get())

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.sessions[0]).toMatchObject({
      id: "s1",
      fileName: "stock.csv",
      status: "complete",
      totalRows: 120,
      matchedRows: 118,
      flaggedRows: 2,
    })
    expect(state.filters).toContainEqual(["tenant_id", "tenant-a"])
  })

  it("caps the page size at 50", async () => {
    requireMobilePharmacyAuth.mockResolvedValue(auth())
    mobileHasPharmacyCapability.mockReturnValue(true)

    await GET(get("?limit=500"))

    expect(state.limits[0]).toBe(50)
  })
})
