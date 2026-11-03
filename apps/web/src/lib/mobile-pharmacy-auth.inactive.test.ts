import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest, NextResponse } from "next/server"

type Row = { profile_id: string; tenant_id: string; is_active: boolean }

const m = vi.hoisted(() => ({
  rows: [] as Row[],
  sessionValid: true,
  filters: [] as [string, unknown][],
}))

vi.mock("@synapse/auth", () => ({
  verifyToken: vi.fn(async () => ({ sub: "staff-1", role: "pharmacy_cashier", tenant_id: "t1" })),
  validateSession: vi.fn(async () => ({ valid: m.sessionValid })),
  roleHasCapability: () => false,
  isTenantEntitled: vi.fn(async () => ({ entitled: true, reason: "active", status: "active" })),
}))
// Applies the recorded eq() filters to the stored rows, so the multi-row case
// behaves the way PostgREST does: more than one match is an error, not a pick.
vi.mock("@synapse/db/admin", () => {
  const q: any = {
    select: () => q,
    eq: (column: string, value: unknown) => {
      m.filters.push([column, value])
      return q
    },
    maybeSingle: async () => {
      const matches = m.rows.filter((row) =>
        m.filters.every(([column, value]) => (row as any)[column] === value),
      )
      if (matches.length > 1) {
        return { data: null, error: { code: "PGRST116", message: "multiple rows returned" } }
      }
      return { data: matches[0] ?? null, error: null }
    },
  }
  return { supabaseAdmin: { from: () => q } }
})

import { requireMobilePharmacyAuth } from "./mobile-pharmacy-auth"

const req = () => new NextRequest("http://localhost/api/mobile/pharmacy/pos", { headers: { authorization: "Bearer tok" } })

describe("mobile pharmacy auth — deactivated staff", () => {
  beforeEach(() => {
    m.rows = []
    m.sessionValid = true
    m.filters = []
  })

  it("refuses a deactivated user even when the bearer session is still valid", async () => {
    m.rows = [{ profile_id: "staff-1", tenant_id: "t1", is_active: false }]
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
    m.rows = [{ profile_id: "staff-1", tenant_id: "t1", is_active: true }]
    const r = await requireMobilePharmacyAuth(req())
    expect(r).not.toBeInstanceOf(NextResponse)
    expect((r as { userId: string }).userId).toBe("staff-1")
  })

  it("scopes the activation lookup to the caller's tenant", async () => {
    m.rows = [{ profile_id: "staff-1", tenant_id: "t1", is_active: true }]
    await requireMobilePharmacyAuth(req())
    expect(m.filters).toContainEqual(["tenant_id", "t1"])
  })

  it("refuses a user deactivated here even when another pharmacy still has them active", async () => {
    // Two rows: the unique key is (tenant_id, profile_id). Before the tenant
    // filter was added, maybeSingle() saw both, errored, and the error was read
    // as "active" — deactivating staff at one pharmacy let them straight into it.
    m.rows = [
      { profile_id: "staff-1", tenant_id: "t1", is_active: false },
      { profile_id: "staff-1", tenant_id: "t2", is_active: true },
    ]
    const r = await requireMobilePharmacyAuth(req())
    expect(r).toBeInstanceOf(NextResponse)
    expect((r as NextResponse).status).toBe(403)
    expect(((await (r as NextResponse).json()) as { code: string }).code).toBe("ACCOUNT_INACTIVE")
  })
})
