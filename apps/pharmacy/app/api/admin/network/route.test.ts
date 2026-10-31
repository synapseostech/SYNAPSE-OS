import { describe, expect, it, vi } from "vitest"

// The portal nav gates this page on MANAGE_SETTINGS. The route must enforce the
// same capability, otherwise any signed-in member can rewrite the network
// membership and replace the network inventory listing.
const { asked, from } = vi.hoisted(() => ({ asked: [] as string[], from: vi.fn() }))
vi.mock("@/lib/api-auth", () => ({
  requirePharmacyPermission: async (permission: string) => {
    asked.push(permission)
    return { ok: false as const, response: new Response("Forbidden", { status: 403 }) }
  },
}))
vi.mock("@/lib/supabase/admin", () => ({ supabaseAdmin: { from } }))

import { GET, POST } from "./route"

describe("network route capability gate", () => {
  it("GET requires settings.manage and never reaches the database when denied", async () => {
    const res = await GET()
    expect(res.status).toBe(403)
    expect(asked).toContain("settings.manage")
    expect(from).not.toHaveBeenCalled()
  })

  it("POST requires settings.manage and never reaches the database when denied", async () => {
    asked.length = 0
    const req = new Request("http://pharm.test/api", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ isNetworkMember: true, acceptsRefillRequests: true }),
    }) as any

    const res = await POST(req)
    expect(res.status).toBe(403)
    expect(asked).toContain("settings.manage")
    expect(from).not.toHaveBeenCalled()
  })
})
