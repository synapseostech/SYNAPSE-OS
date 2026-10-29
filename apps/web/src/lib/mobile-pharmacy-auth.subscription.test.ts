import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest, NextResponse } from "next/server"

const m = vi.hoisted(() => ({
  entitlement: null as null | (() => Promise<unknown>),
}))

vi.mock("@synapse/auth", () => ({
  verifyToken: vi.fn(async () => ({ sub: "staff-1", role: "pharmacist", tenant_id: "t1" })),
  validateSession: vi.fn(async () => ({ valid: true })),
  roleHasCapability: () => true,
  isTenantEntitled: vi.fn(() => (m.entitlement ?? (async () => ({ entitled: true, reason: "active", status: "active" })))()),
}))
vi.mock("@synapse/db/admin", () => {
  const q: any = { select: () => q, eq: () => q, maybeSingle: async () => ({ data: { is_active: true }, error: null }) }
  return { supabaseAdmin: { from: () => q } }
})

import { requireMobilePharmacyAuth } from "./mobile-pharmacy-auth"

const request = (pathname: string, method = "GET") =>
  new NextRequest(`http://localhost${pathname}`, { method, headers: { authorization: "Bearer tok" } })

const lapsed = () => ({ entitled: false, reason: "period_ended", status: "suspended" })

describe("mobile pharmacy auth — lapsed subscription", () => {
  beforeEach(() => {
    m.entitlement = null
  })

  it("refuses a write from a lapsed tenant with the billing lock", async () => {
    m.entitlement = async () => lapsed()
    const res = await requireMobilePharmacyAuth(request("/api/mobile/pharmacy/pos/complete-sale", "POST"))

    expect(res).toBeInstanceOf(NextResponse)
    expect((res as NextResponse).status).toBe(402)
    const body = (await (res as NextResponse).json()) as { error: string; subscription_status: string }
    expect(body.error).toBe("subscription_required")
    expect(body.subscription_status).toBe("suspended")
  })

  it.each(["POST", "PATCH", "PUT", "DELETE"])("refuses %s from a lapsed tenant", async (method) => {
    m.entitlement = async () => lapsed()
    const res = await requireMobilePharmacyAuth(request("/api/mobile/pharmacy/users", method))
    expect((res as NextResponse).status).toBe(402)
  })

  it("still serves reads to a lapsed tenant", async () => {
    m.entitlement = async () => lapsed()
    const res = await requireMobilePharmacyAuth(request("/api/mobile/pharmacy/sales", "GET"))
    expect(res).not.toBeInstanceOf(NextResponse)
  })

  it.each([
    "/api/mobile/pharmacy/billing",
    "/api/mobile/pharmacy/interactions",
    "/api/mobile/pharmacy/interactions/explain",
  ])("keeps %s reachable so a lapsed tenant can pay or check a safety risk", async (pathname) => {
    m.entitlement = async () => lapsed()
    const res = await requireMobilePharmacyAuth(request(pathname, "POST"))
    expect(res).not.toBeInstanceOf(NextResponse)
  })

  it("admits a write when the tenant is entitled", async () => {
    m.entitlement = async () => ({ entitled: true, reason: "active", status: "active" })
    const res = await requireMobilePharmacyAuth(request("/api/mobile/pharmacy/pos/complete-sale", "POST"))
    expect(res).not.toBeInstanceOf(NextResponse)
  })

  it("fails open when the entitlement lookup throws", async () => {
    m.entitlement = async () => {
      throw new Error("database unavailable")
    }
    const res = await requireMobilePharmacyAuth(request("/api/mobile/pharmacy/pos/complete-sale", "POST"))
    expect(res).not.toBeInstanceOf(NextResponse)
  })
})
