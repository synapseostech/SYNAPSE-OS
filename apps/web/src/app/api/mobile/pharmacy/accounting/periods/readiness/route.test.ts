import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextResponse } from "next/server"

const { requireMobilePharmacyAuth, isMobileAuth, mobileHasPharmacyCapability } = vi.hoisted(() => ({
  requireMobilePharmacyAuth: vi.fn(),
  isMobileAuth: vi.fn(),
  mobileHasPharmacyCapability: vi.fn(),
}))

vi.mock("../../../../../../../lib/mobile-pharmacy-auth", () => ({
  requireMobilePharmacyAuth: (...args: unknown[]) => requireMobilePharmacyAuth(...args),
  isMobileAuth: (...args: unknown[]) => isMobileAuth(...args),
  mobileHasPharmacyCapability: (...args: unknown[]) => mobileHasPharmacyCapability(...args),
}))

vi.mock("@synapse/db/admin", () => ({
  supabaseAdmin: { rpc: (...args: unknown[]) => rpc(...args) },
}))

import { GET } from "./route"

const rpc = vi.hoisted(() => vi.fn())

function auth(tenantId = "tenant-a") {
  return { userId: "user-1", tenantId, role: "pharmacy_admin", token: "t" }
}

function facts(overrides: Record<string, unknown> = {}) {
  return {
    periodStart: "2026-09-01",
    periodEnd: "2026-09-30",
    assessedOn: "2026-10-26",
    tillSessions: [],
    unmatchedBankLines: 0,
    unmatchedBankValue: 0,
    journalEntries: 4,
    journalDebitTotal: 95000,
    salesCount: 12,
    salesTotal: 250000,
    cashSalesTotal: 120000,
    ...overrides,
  }
}

function get(start = "2026-09-01", end = "2026-09-30") {
  return new Request(
    `https://app.test/api/mobile/pharmacy/accounting/periods/readiness?start=${start}&end=${end}`,
  ) as never
}

describe("mobile pharmacy close readiness", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    isMobileAuth.mockImplementation(
      (value: unknown) =>
        Boolean(value) &&
        typeof value === "object" &&
        !(value instanceof NextResponse) &&
        "tenantId" in (value as object),
    )
    mobileHasPharmacyCapability.mockReturnValue(true)
    rpc.mockResolvedValue({ data: facts(), error: null })
  })

  it("denies the check without the financial reports permission", async () => {
    requireMobilePharmacyAuth.mockResolvedValue(auth())
    mobileHasPharmacyCapability.mockReturnValue(false)

    const res = await GET(get())

    expect(res.status).toBe(403)
    expect(rpc).not.toHaveBeenCalled()
  })

  it("rejects an inverted date range", async () => {
    requireMobilePharmacyAuth.mockResolvedValue(auth())

    const res = await GET(get("2026-09-30", "2026-09-01"))

    expect(res.status).toBe(400)
    expect(rpc).not.toHaveBeenCalled()
  })

  it("reports a deployment gap rather than a bad request when the routine is missing", async () => {
    requireMobilePharmacyAuth.mockResolvedValue(auth())
    rpc.mockResolvedValue({ data: null, error: { code: "PGRST202", message: "not found" } })

    const res = await GET(get())

    expect(res.status).toBe(503)
  })

  it("blocks a close while a till is still open", async () => {
    requireMobilePharmacyAuth.mockResolvedValue(auth())
    rpc.mockResolvedValue({
      data: facts({
        tillSessions: [{ status: "open", openedOn: "2026-09-29", closedOn: null }],
      }),
      error: null,
    })

    const res = await GET(get())

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.readiness.ready).toBe(false)
    expect(body.readiness.blockers.map((issue: { code: string }) => issue.code)).toContain(
      "OPEN_TILL_SESSIONS",
    )
    expect(body.snapshot).toMatchObject({ openTillSessions: 1, salesCount: 12 })
  })

  it("allows a quiet period but warns that it has no activity", async () => {
    requireMobilePharmacyAuth.mockResolvedValue(auth())
    rpc.mockResolvedValue({
      data: facts({ journalEntries: 0, salesCount: 0 }),
      error: null,
    })

    const res = await GET(get())

    const body = await res.json()
    expect(body.readiness.ready).toBe(true)
    expect(body.readiness.warnings.map((issue: { code: string }) => issue.code)).toContain(
      "NO_ACTIVITY",
    )
  })

  it("passes the tenant and range to the database rule", async () => {
    requireMobilePharmacyAuth.mockResolvedValue(auth("tenant-b"))

    await GET(get())

    expect(rpc).toHaveBeenCalledWith("pharmacy_accounting_close_readiness", {
      p_tenant_id: "tenant-b",
      p_period_start: "2026-09-01",
      p_period_end: "2026-09-30",
    })
  })
})
