import { beforeEach, describe, expect, it, vi } from "vitest"

const { from } = vi.hoisted(() => ({ from: vi.fn() }))

vi.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: { from: (...args: unknown[]) => from(...args) },
}))

import { GET } from "./route"

function tenantsQuery(result: unknown) {
  return { select: () => ({ limit: () => Promise.resolve(result) }) }
}

describe("GET /api/ready", () => {
  beforeEach(() => from.mockReset())

  it("reports ready when the database answers", async () => {
    from.mockReturnValue(tenantsQuery({ error: null }))
    const res = await GET()
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.status).toBe("ready")
    expect(body.checks.database).toMatchObject({ ok: true, detail: "tenants query succeeded" })
  })

  it("answers 503 without leaking the driver's error text", async () => {
    from.mockReturnValue(
      tenantsQuery({
        error: {
          message:
            'connection to server at "db.qfqakzmjatszisuqjwon.supabase.co" failed: password authentication failed for user "postgres"',
        },
      }),
    )
    const res = await GET()
    expect(res.status).toBe(503)
    const text = JSON.stringify(await res.json())
    expect(text).not.toMatch(/postgres|password|supabase\.co|authentication/)
    expect(JSON.parse(text).checks.database).toMatchObject({
      ok: false,
      detail: "database probe failed",
    })
  })

  it("answers 503 without leaking a thrown error", async () => {
    from.mockImplementation(() => ({
      select: () => ({
        limit: () => Promise.reject(new Error("getaddrinfo ENOTFOUND db.internal")),
      }),
    }))

    const res = await GET()
    expect(res.status).toBe(503)
    const text = JSON.stringify(await res.json())
    expect(text).not.toMatch(/ENOTFOUND|db\.internal/)
  })
})
