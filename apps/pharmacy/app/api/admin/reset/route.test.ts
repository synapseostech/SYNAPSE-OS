import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextResponse } from "next/server"

const { requirePharmacyAdmin, rpc, settingsMaybeSingle, tenantMaybeSingle, consumeRateLimit, logAudit, list, remove } =
  vi.hoisted(() => ({
    requirePharmacyAdmin: vi.fn(),
    rpc: vi.fn(),
    settingsMaybeSingle: vi.fn(),
    tenantMaybeSingle: vi.fn(),
    consumeRateLimit: vi.fn(),
    logAudit: vi.fn(),
    list: vi.fn(),
    remove: vi.fn(),
  }))

vi.mock("@/lib/api-auth", () => ({
  requirePharmacyAdmin: (...args: unknown[]) => requirePharmacyAdmin(...args),
}))

vi.mock("@/lib/distributed-rate-limit", () => ({
  consumeRateLimit: (...args: unknown[]) => consumeRateLimit(...args),
}))

vi.mock("@synapse/db", () => ({
  logAudit: (...args: unknown[]) => logAudit(...args),
}))

vi.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: {
    from: (table: string) => {
      if (table === "pharmacy_settings" || table === "tenants") {
        const maybeSingle = table === "pharmacy_settings" ? settingsMaybeSingle : tenantMaybeSingle
        return { select: () => ({ eq: () => ({ maybeSingle }) }) }
      }
      throw new Error(`Unexpected table ${table}`)
    },
    rpc,
    storage: { from: () => ({ list, remove }) },
  },
}))

import { POST } from "./route"

function adminAuth() {
  return {
    ok: true as const,
    tenantId: "tenant-1",
    session: {
      userId: "admin-1",
      email: "a@test.com",
      role: "pharmacy_admin",
      pharmacyRole: "pharmacy_admin",
      tenantId: "tenant-1",
      facilityType: "pharmacy",
      fullName: "Admin",
      firstName: "Ad",
      lastName: "Min",
      isAdmin: true,
      tenantName: "Care Pharmacy",
      tenantSlug: "care",
      tenantStatus: "active",
      modulesEnabled: [],
      mustChangePassword: false,
      permissions: [],
      isImpersonation: false,
      impersonatorId: null,
      storeId: null,
      profile: {
        tenant_id: "tenant-1",
        is_admin: true,
        full_name: "Admin",
        first_name: "Ad",
        last_name: "Min",
      },
      user: { id: "admin-1", email: "a@test.com" },
    },
  }
}

function post(body: unknown) {
  return POST(
    new Request("https://pharm.test/api/admin/reset", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }) as any,
  )
}

describe("POST /api/admin/reset", () => {
  beforeEach(() => {
    requirePharmacyAdmin.mockReset()
    rpc.mockReset()
    settingsMaybeSingle.mockReset()
    tenantMaybeSingle.mockReset()
    consumeRateLimit.mockReset()
    logAudit.mockReset()
    list.mockReset()
    remove.mockReset()

    requirePharmacyAdmin.mockResolvedValue(adminAuth())
    settingsMaybeSingle.mockResolvedValue({ data: { pharmacy_name: "Care Pharmacy" }, error: null })
    tenantMaybeSingle.mockResolvedValue({ data: { name: "Care Pharmacy" }, error: null })
    consumeRateLimit.mockResolvedValue({ allowed: true, retryAfter: 0 })
    rpc.mockResolvedValue({
      data: { dryRun: false, totalRows: 12, counts: { pharmacy_products: 10, pharmacy_sales: 2 } },
      error: null,
    })
    list.mockResolvedValue({ data: [], error: null })
    remove.mockResolvedValue({ data: [], error: null })
    logAudit.mockResolvedValue(undefined)
  })

  it("returns the auth failure unchanged", async () => {
    const denied = NextResponse.json({ error: "Admin only" }, { status: 403 })
    requirePharmacyAdmin.mockResolvedValue({ ok: false, response: denied })

    const res = await post({ confirmName: "Care Pharmacy" })

    expect(res.status).toBe(403)
    expect(rpc).not.toHaveBeenCalled()
  })

  it("a dry run counts without deleting, cleaning up or auditing", async () => {
    rpc.mockResolvedValue({
      data: { dryRun: true, totalRows: 12, counts: { pharmacy_products: 12 } },
      error: null,
    })

    const res = await post({ dryRun: true })

    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ dryRun: true, totalRows: 12 })
    expect(rpc).toHaveBeenCalledWith("purge_pharmacy_tenant_data", {
      p_tenant_id: "tenant-1",
      p_actor_id: "admin-1",
      p_dry_run: true,
    })
    expect(list).not.toHaveBeenCalled()
    expect(remove).not.toHaveBeenCalled()
    expect(logAudit).not.toHaveBeenCalled()
    expect(consumeRateLimit).not.toHaveBeenCalled()
  })

  it("refuses a mismatched name and deletes nothing", async () => {
    const res = await post({ confirmName: "Care Pharmaci" })

    expect(res.status).toBe(400)
    expect((await res.json()).code).toBe("PHARMACY_RESET_NAME_MISMATCH")
    expect(rpc).not.toHaveBeenCalled()
    expect(logAudit).not.toHaveBeenCalled()
  })

  it("requires a name on a real run", async () => {
    const res = await post({})

    expect(res.status).toBe(400)
    expect(rpc).not.toHaveBeenCalled()
  })

  it("falls back to the tenant name when the pharmacy has no settings row", async () => {
    settingsMaybeSingle.mockResolvedValue({ data: null, error: null })

    const res = await post({ confirmName: "Care Pharmacy" })

    expect(res.status).toBe(200)
    expect(rpc).toHaveBeenCalled()
  })

  it("erases on a confirmed run, removes the tenant's import files and audits", async () => {
    list.mockResolvedValueOnce({ data: [{ name: "imports", id: null }], error: null })
    list.mockResolvedValueOnce({ data: [{ name: "session-1", id: null }], error: null })
    list.mockResolvedValueOnce({
      data: [
        { name: "session.json", id: "9" },
        { name: "uploads", id: null },
      ],
      error: null,
    })
    list.mockResolvedValueOnce({ data: [{ name: "u1.xml", id: "10" }], error: null })

    const res = await post({ confirmName: "Care Pharmacy" })

    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ ok: true, dryRun: false, storageCleanup: "done" })
    expect(rpc).toHaveBeenCalledWith("purge_pharmacy_tenant_data", {
      p_tenant_id: "tenant-1",
      p_actor_id: "admin-1",
      p_dry_run: false,
    })
    expect(remove).toHaveBeenCalledWith([
      "tenants/tenant-1/imports/session-1/session.json",
      "tenants/tenant-1/imports/session-1/uploads/u1.xml",
    ])
    expect(logAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "PHARMACY_DATA_RESET",
        resource_type: "pharmacy_tenant",
        resource_id: "tenant-1",
        tenant_id: "tenant-1",
      }),
    )
  })

  it("still reports the wipe when the storage cleanup fails", async () => {
    list.mockRejectedValue(new Error("storage down"))

    const res = await post({ confirmName: "Care Pharmacy" })

    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ ok: true, storageCleanup: "failed" })
    expect(logAudit).toHaveBeenCalled()
  })

  it("reports a missing migration instead of a generic failure", async () => {
    rpc.mockResolvedValue({ data: null, error: { code: "PGRST202", message: "Could not find the function" } })

    const res = await post({ confirmName: "Care Pharmacy" })

    expect(res.status).toBe(503)
    expect((await res.json()).code).toBe("PHARMACY_RESET_MIGRATION_MISSING")
    expect(logAudit).not.toHaveBeenCalled()
  })

  it("rate limits real runs before touching anything", async () => {
    consumeRateLimit.mockResolvedValue({ allowed: false, retryAfter: 900 })

    const res = await post({ confirmName: "Care Pharmacy" })

    expect(res.status).toBe(429)
    expect(res.headers.get("Retry-After")).toBe("900")
    expect(rpc).not.toHaveBeenCalled()
  })
})
