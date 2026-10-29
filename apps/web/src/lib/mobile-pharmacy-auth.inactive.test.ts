import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest, NextResponse } from "next/server"

const m = vi.hoisted(() => ({ settings: null as Record<string, unknown> | null, sessionValid: true }))

vi.mock("@synapse/auth", () => ({
  verifyToken: vi.fn(async () => ({ sub: "staff-1", role: "pharmacy_cashier", tenant_id: "t1" })),
  validateSession: vi.fn(async () => ({ valid: m.sessionValid })),
  roleHasCapability: () => false,
  isTenantEntitled: vi.fn(async () => ({ entitled: true, reason: "active", status: "active" })),
}))
vi.mock("@synapse/db/admin", () => {
  const q: any = { select: () => q, eq: () => q, maybeSingle: async () => ({ data: m.settings, error: null }) }
  return { supabaseAdmin: { from: () => q } }
})

import { requireMobilePharmacyAuth } from "./mobile-pharmacy-auth"

const req = () => new NextRequest("http://localhost/api/mobile/pharmacy/pos", { headers: { authorization: "Bearer tok" } })

describe("mobile pharmacy auth — deactivated staff", () => {
  beforeEach(() => {
    m.settings = null
    m.sessionValid = true
  })

  it("refuses a deactivated user even when the bearer session is still valid", async () => {
    m.settings = { is_active: false }
    const r = await requireMobilePharmacyAuth(req())
    expect(r).toBeInstanceOf(NextResponse)
    expect((r as NextResponse).status).toBe(403)
    expect(((await (r as NextResponse).json()) as { code: string }).code).toBe("ACCOUNT_INACTIVE")
  })

  it("refuses a revoked session (deactivation deletes sessions)", async () => {
    m.sessionValid = false
    const r = await requireMobilePharmacyAuth(req())
    expect((r as NextResponse).status).toBe(401)
  })

  it("an active (or reactivated) user is admitted", async () => {
    m.settings = { is_active: true }
    const r = await requireMobilePharmacyAuth(req())
    expect(r).not.toBeInstanceOf(NextResponse)
    expect((r as { userId: string }).userId).toBe("staff-1")
  })
})
