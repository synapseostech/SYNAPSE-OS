import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextResponse } from "next/server"

const { requireMobilePharmacyAuth, isMobileAuth, mobileHasPharmacyCapability } = vi.hoisted(() => ({
  requireMobilePharmacyAuth: vi.fn(),
  isMobileAuth: vi.fn(),
  mobileHasPharmacyCapability: vi.fn(),
}))

vi.mock("../../../../../../lib/mobile-pharmacy-auth", () => ({
  requireMobilePharmacyAuth: (...args: unknown[]) => requireMobilePharmacyAuth(...args),
  isMobileAuth: (...args: unknown[]) => isMobileAuth(...args),
  mobileHasPharmacyCapability: (...args: unknown[]) => mobileHasPharmacyCapability(...args),
}))

const state = {
  rows: [] as unknown[],
}

const rpc = vi.hoisted(() => vi.fn())

vi.mock("@synapse/db/admin", () => ({
  supabaseAdmin: {
    rpc: (...args: unknown[]) => rpc(...args),
    from: () => {
      const builder: Record<string, unknown> = {}
      const self = () => builder
      builder.select = self
      builder.eq = self
      builder.order = self
      builder.limit = () => Promise.resolve({ data: state.rows, error: null })
      return builder
    },
  },
}))

import { GET, POST } from "./route"

function auth(role = "pharmacy_admin", tenantId = "tenant-a") {
  return { userId: "user-1", tenantId, role, token: "t" }
}

function post(body: unknown) {
  return new Request("https://app.test/api/mobile/pharmacy/accounting/periods", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }) as never
}

describe("mobile pharmacy accounting periods", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    state.rows = []
    isMobileAuth.mockImplementation(
      (value: unknown) =>
        Boolean(value) &&
        typeof value === "object" &&
        !(value instanceof NextResponse) &&
        "tenantId" in (value as object),
    )
    mobileHasPharmacyCapability.mockReturnValue(true)
  })

  it("lists periods for a role with financial reports", async () => {
    requireMobilePharmacyAuth.mockResolvedValue(auth())
    state.rows = [
      {
        id: "p1",
        period_start: "2026-09-01",
        period_end: "2026-09-30",
        status: "closed",
        closed_at: "2026-10-01T09:00:00.000Z",
        close_snapshot: { salesCount: 3 },
      },
    ]

    const res = await GET(new Request("https://app.test/api/mobile/pharmacy/accounting/periods") as never)

    expect(res.status).toBe(200)
    expect((await res.json()).periods[0]).toMatchObject({
      id: "p1",
      periodStart: "2026-09-01",
      periodEnd: "2026-09-30",
      status: "closed",
      closeSnapshot: { salesCount: 3 },
    })
  })

  it("denies the list without the financial reports permission", async () => {
    requireMobilePharmacyAuth.mockResolvedValue(auth("pharmacy_cashier"))
    mobileHasPharmacyCapability.mockReturnValue(false)

    const res = await GET(new Request("https://app.test/api/mobile/pharmacy/accounting/periods") as never)

    expect(res.status).toBe(403)
  })

  it("denies closing without settings-management permission", async () => {
    requireMobilePharmacyAuth.mockResolvedValue(auth("pharmacy_store_manager"))
    mobileHasPharmacyCapability.mockImplementation(
      (_a: unknown, cap: string) => cap === "reports.financial",
    )

    const res = await POST(post({ periodStart: "2026-09-01", periodEnd: "2026-09-30" }))

    expect(res.status).toBe(403)
    expect(rpc).not.toHaveBeenCalled()
  })

  it("refuses a period that has not ended", async () => {
    requireMobilePharmacyAuth.mockResolvedValue(auth())
    const today = new Date().toISOString().slice(0, 10)

    const res = await POST(post({ periodStart: "2026-01-01", periodEnd: today }))

    expect(res.status).toBe(400)
    expect(rpc).not.toHaveBeenCalled()
  })

  it("closes through the shared routine with the token profile as closer", async () => {
    requireMobilePharmacyAuth.mockResolvedValue(auth())
    rpc.mockResolvedValue({
      data: {
        id: "p2",
        period_start: "2026-09-01",
        period_end: "2026-09-30",
        status: "closed",
        closed_at: "2026-10-02T08:00:00.000Z",
        close_snapshot: null,
      },
      error: null,
    })

    const res = await POST(post({ periodStart: "2026-09-01", periodEnd: "2026-09-30" }))

    expect(res.status).toBe(201)
    expect(rpc).toHaveBeenCalledWith("close_pharmacy_accounting_period", {
      p_tenant_id: "tenant-a",
      p_period_start: "2026-09-01",
      p_period_end: "2026-09-30",
      p_closed_by: "user-1",
    })
    expect((await res.json()).period).toMatchObject({ id: "p2", status: "closed" })
  })

  it("maps an open till refusal to a conflict with its code", async () => {
    requireMobilePharmacyAuth.mockResolvedValue(auth())
    rpc.mockResolvedValue({ data: null, error: { message: "ACCOUNTING_PERIOD_OPEN_TILLS" } })

    const res = await POST(post({ periodStart: "2026-09-01", periodEnd: "2026-09-30" }))

    expect(res.status).toBe(409)
    expect(await res.json()).toMatchObject({ code: "ACCOUNTING_PERIOD_OPEN_TILLS" })
  })

  it("maps an overlapping period to a conflict", async () => {
    requireMobilePharmacyAuth.mockResolvedValue(auth())
    rpc.mockResolvedValue({ data: null, error: { message: "ACCOUNTING_PERIOD_OVERLAP" } })

    const res = await POST(post({ periodStart: "2026-09-01", periodEnd: "2026-09-30" }))

    expect(res.status).toBe(409)
  })
})
