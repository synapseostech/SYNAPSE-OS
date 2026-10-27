import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest, NextResponse } from "next/server"
import { fakeSupabase, type FakeOperation, type FakeResult } from "@/lib/tally/test-db"

const m = vi.hoisted(() => ({
  cookieAuth: null as unknown,
  verifyToken: vi.fn(),
  validateSession: vi.fn(),
  db: null as unknown as { client: unknown; operations: FakeOperation[] },
}))

vi.mock("@/lib/api-auth", () => ({
  requirePharmacyPermission: vi.fn(async () => m.cookieAuth),
}))
vi.mock("@/lib/supabase/admin", () => ({
  get supabaseAdmin() {
    return m.db.client
  },
}))
vi.mock("@synapse/auth", () => ({
  verifyToken: m.verifyToken,
  validateSession: m.validateSession,
}))

import { requireTallyPermission } from "./auth"

const ADMIN_TOKEN = {
  sub: "user-1",
  role: "pharmacy_admin",
  tenant_id: "tenant-1",
}

function settings(data: Record<string, unknown> | null): FakeResult {
  return { data, error: null }
}

function setup(result: FakeResult) {
  m.db = fakeSupabase((): FakeResult => result)
}

function request(headers: Record<string, string> = {}) {
  return new NextRequest("http://localhost/api/admin/tally/upload-url", {
    method: "POST",
    headers,
  })
}

const bearer = () => request({ authorization: "Bearer token-1" })

describe("requireTallyPermission", () => {
  beforeEach(() => {
    m.cookieAuth = null
    m.verifyToken.mockReset().mockResolvedValue(ADMIN_TOKEN)
    m.validateSession.mockReset().mockResolvedValue({ valid: true })
    setup(settings({ pharmacy_role: "pharmacy_admin", permissions: [], is_active: true }))
  })

  it("keeps the portal cookie path, including the settings role", async () => {
    m.cookieAuth = {
      ok: true,
      tenantId: "tenant-1",
      session: {
        user: { id: "user-1" },
        role: "pharmacy_admin",
        pharmacyRole: "pharmacy_store_manager",
        permissions: ["inventory.write"],
        isAdmin: false,
      },
    }

    const auth = await requireTallyPermission(request(), "inventory.write")

    expect(auth).toMatchObject({
      ok: true,
      tenantId: "tenant-1",
      actorId: "user-1",
      role: "pharmacy_admin",
      pharmacyRole: "pharmacy_store_manager",
    })
    expect(m.db.operations).toHaveLength(0)
  })

  it("passes a cookie refusal straight through", async () => {
    const response = NextResponse.json({ error: "Forbidden" }, { status: 403 })
    m.cookieAuth = { ok: false, response }

    const auth = await requireTallyPermission(request(), "inventory.write")

    expect(auth.ok).toBe(false)
    if (!auth.ok) expect(auth.response.status).toBe(403)
  })

  it("accepts a bearer token with a pharmacy role and the capability", async () => {
    const auth = await requireTallyPermission(bearer(), "inventory.write")

    expect(auth).toMatchObject({
      ok: true,
      tenantId: "tenant-1",
      actorId: "user-1",
      pharmacyRole: "pharmacy_admin",
    })
    expect(m.validateSession).toHaveBeenCalledWith("token-1")
  })

  it("falls back to the token role when there are no settings", async () => {
    setup(settings(null))

    const auth = await requireTallyPermission(bearer(), "reports.financial")

    expect(auth.ok).toBe(true)
  })

  it("rejects a token that is not a pharmacy role", async () => {
    m.verifyToken.mockResolvedValue({ ...ADMIN_TOKEN, role: "patient" })

    const auth = await requireTallyPermission(bearer(), "inventory.write")

    expect(auth.ok).toBe(false)
    if (!auth.ok) expect(auth.response.status).toBe(403)
  })

  it("rejects a deactivated pharmacy account", async () => {
    setup(settings({ pharmacy_role: "pharmacy_admin", permissions: [], is_active: false }))

    const auth = await requireTallyPermission(bearer(), "inventory.write")

    expect(auth.ok).toBe(false)
    if (!auth.ok) {
      expect(auth.response.status).toBe(403)
      expect(await auth.response.json()).toMatchObject({ code: "ACCOUNT_INACTIVE" })
    }
  })

  it("rejects a token with no tenant", async () => {
    m.verifyToken.mockResolvedValue({ sub: "user-1", role: "pharmacy_admin" })

    const auth = await requireTallyPermission(bearer(), "inventory.write")

    expect(auth.ok).toBe(false)
    if (!auth.ok) expect(auth.response.status).toBe(403)
  })

  it("refuses a role without the capability", async () => {
    m.verifyToken.mockResolvedValue({ ...ADMIN_TOKEN, role: "pharmacy_cashier" })
    setup(settings({ pharmacy_role: "pharmacy_cashier", permissions: [], is_active: true }))

    const auth = await requireTallyPermission(bearer(), "inventory.write")

    expect(auth.ok).toBe(false)
    if (!auth.ok) expect(auth.response.status).toBe(403)
  })

  it("honours an explicit permission grant", async () => {
    m.verifyToken.mockResolvedValue({ ...ADMIN_TOKEN, role: "pharmacy_cashier" })
    setup(settings({ pharmacy_role: "pharmacy_cashier", permissions: ["MANAGE_INVENTORY"], is_active: true }))

    const auth = await requireTallyPermission(bearer(), "inventory.write")

    expect(auth.ok).toBe(true)
  })

  it("rejects an unverifiable token", async () => {
    m.verifyToken.mockRejectedValue(new Error("bad signature"))

    const auth = await requireTallyPermission(bearer(), "inventory.write")

    expect(auth.ok).toBe(false)
    if (!auth.ok) {
      expect(auth.response.status).toBe(401)
      expect(await auth.response.json()).toEqual({ error: "Invalid token" })
    }
  })

  it("rejects an expired session", async () => {
    m.validateSession.mockResolvedValue({ valid: false })

    const auth = await requireTallyPermission(bearer(), "inventory.write")

    expect(auth.ok).toBe(false)
    if (!auth.ok) expect(auth.response.status).toBe(401)
  })
})
