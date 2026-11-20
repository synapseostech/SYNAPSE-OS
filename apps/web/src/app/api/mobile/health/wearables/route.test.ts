import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"

/**
 * Staff-health privacy at the BFF. The fake database below holds rows for two
 * people at the same pharmacy: an admin and a cashier. Whatever the admin sends
 * (query params, body owner ids, their admin role), they only ever reach their
 * own rows.
 */

type Row = Record<string, unknown>

const { sessions, tables } = vi.hoisted(() => ({
  sessions: new Map<string, { sub: string; role: string; tenant_id: string; is_admin?: boolean }>(),
  tables: {
    personal_wearable_connections: [] as Row[],
    personal_wearable_daily: [] as Row[],
  } as Record<string, Row[]>,
}))

vi.mock("@synapse/auth", () => ({
  verifyToken: async (token: string) => {
    const payload = sessions.get(token)
    if (!payload) throw new Error("bad token")
    return payload
  },
  validateSession: async (token: string) => ({ valid: sessions.has(token) }),
}))

vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => undefined }),
}))

vi.mock("@synapse/db/admin", () => {
  function from(table: string) {
    const filters: Array<(row: Row) => boolean> = []
    let op: "select" | "delete" | "update" = "select"
    let patch: Row = {}
    const rows = () => tables[table] ?? (tables[table] = [])
    const builder: Record<string, unknown> = {
      select: () => builder,
      order: () => builder,
      eq: (column: string, value: unknown) => {
        filters.push((row) => row[column] === value)
        return builder
      },
      gte: (column: string, value: string) => {
        filters.push((row) => String(row[column]) >= value)
        return builder
      },
      delete: () => {
        op = "delete"
        return builder
      },
      update: (next: Row) => {
        op = "update"
        patch = next
        return builder
      },
      upsert: (input: Row | Row[], options: { onConflict: string }) => {
        const keys = options.onConflict.split(",")
        for (const row of Array.isArray(input) ? input : [input]) {
          const list = rows()
          const index = list.findIndex((existing) => keys.every((k) => existing[k] === row[k]))
          if (index >= 0) list[index] = { ...list[index], ...row }
          else list.push({ ...row })
        }
        return Promise.resolve({ data: null, error: null })
      },
      then: (resolve: (value: unknown) => unknown) => {
        const match = (row: Row) => filters.every((f) => f(row))
        if (op === "delete") {
          tables[table] = rows().filter((row) => !match(row))
          return Promise.resolve({ data: null, error: null }).then(resolve)
        }
        if (op === "update") {
          for (const row of rows()) if (match(row)) Object.assign(row, patch)
          return Promise.resolve({ data: null, error: null }).then(resolve)
        }
        return Promise.resolve({ data: rows().filter(match), error: null }).then(resolve)
      },
    }
    return builder
  }
  return { supabaseAdmin: { from } }
})

import { DELETE, GET, POST, PUT } from "./route"

const TENANT = "11111111-1111-4111-8111-111111111111"
const ADMIN = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
const CASHIER = "cccccccc-cccc-4ccc-8ccc-cccccccccccc"
const today = new Date().toISOString().slice(0, 10)

function request(method: string, token: string | null, opts: { query?: string; body?: unknown } = {}) {
  const headers: Record<string, string> = { "content-type": "application/json" }
  if (token) headers.authorization = `Bearer ${token}`
  return new NextRequest(`https://www.synapseos.tech/api/mobile/health/wearables${opts.query ?? ""}`, {
    method,
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  })
}

async function connectAndSync(token: string, steps: number) {
  await PUT(request("PUT", token, { body: { provider: "health_connect", consent: true, scopes: ["steps", "heart_rate"] } }))
  return POST(
    request("POST", token, {
      body: { provider: "health_connect", readings: [{ metric: "steps", day: today, value: steps, samples: 1 }] },
    }),
  )
}

beforeEach(() => {
  sessions.clear()
  tables.personal_wearable_connections = []
  tables.personal_wearable_daily = []
  sessions.set("admin-token", { sub: ADMIN, role: "pharmacy_admin", tenant_id: TENANT, is_admin: true })
  sessions.set("cashier-token", { sub: CASHIER, role: "pharmacy_cashier", tenant_id: TENANT })
})

describe("/api/mobile/health/wearables", () => {
  it("refuses requests without a valid session", async () => {
    expect((await GET(request("GET", null))).status).toBe(401)
    expect((await GET(request("GET", "forged"))).status).toBe(401)
    expect((await POST(request("POST", null, { body: { provider: "health_connect", readings: [] } }))).status).toBe(401)
    expect((await DELETE(request("DELETE", null, { query: "?provider=health_connect" }))).status).toBe(401)
  })

  it("refuses readings until the owner has consented", async () => {
    const res = await POST(
      request("POST", "cashier-token", {
        body: { provider: "health_connect", readings: [{ metric: "steps", day: today, value: 100 }] },
      }),
    )
    expect(res.status).toBe(409)
    expect((await res.json()).code).toBe("CONSENT_REQUIRED")
    expect(tables.personal_wearable_daily).toHaveLength(0)
  })

  it("requires explicit consent and at least one scope", async () => {
    expect((await PUT(request("PUT", "cashier-token", { body: { provider: "health_connect", scopes: ["steps"] } }))).status).toBe(400)
    expect((await PUT(request("PUT", "cashier-token", { body: { provider: "health_connect", consent: true, scopes: [] } }))).status).toBe(400)
    expect((await PUT(request("PUT", "cashier-token", { body: { provider: "fitbit_cloud", consent: true, scopes: ["steps"] } }))).status).toBe(400)
  })

  it("stores only consented metrics, under the session owner", async () => {
    await PUT(request("PUT", "cashier-token", { body: { provider: "health_connect", consent: true, scopes: ["steps"] } }))
    const res = await POST(
      request("POST", "cashier-token", {
        body: {
          provider: "health_connect",
          owner_profile_id: ADMIN,
          readings: [
            { metric: "steps", day: today, value: 4200, owner_profile_id: ADMIN },
            { metric: "heart_rate", day: today, value: 70 },
            { metric: "steps", day: "not-a-day", value: 1 },
            { metric: "steps", day: today, value: -5 },
          ],
        },
      }),
    )
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ saved: 1, rejected: 3 })
    expect(tables.personal_wearable_daily).toEqual([
      expect.objectContaining({ owner_profile_id: CASHIER, metric: "steps", value: 4200 }),
    ])
  })

  it("never shows a staff member's readings to their facility admin", async () => {
    await connectAndSync("cashier-token", 9000)
    await connectAndSync("admin-token", 1200)

    for (const query of ["", `?ownerId=${CASHIER}`, `?userId=${CASHIER}`, `?owner_profile_id=${CASHIER}`, `?tenantId=${TENANT}`]) {
      const res = await GET(request("GET", "admin-token", { query }))
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.daily.map((d: { value: number }) => d.value)).toEqual([1200])
      expect(JSON.stringify(body)).not.toContain("9000")
    }

    const own = await (await GET(request("GET", "cashier-token"))).json()
    expect(own.daily.map((d: { value: number }) => d.value)).toEqual([9000])
    expect(own.connections).toHaveLength(1)
  })

  it("an admin cannot delete or overwrite a colleague's data", async () => {
    await connectAndSync("cashier-token", 9000)

    await DELETE(request("DELETE", "admin-token", { query: `?provider=health_connect&ownerId=${CASHIER}` }))
    await POST(
      request("POST", "admin-token", {
        body: { provider: "health_connect", owner_profile_id: CASHIER, readings: [{ metric: "steps", day: today, value: 1 }] },
      }),
    )

    const own = await (await GET(request("GET", "cashier-token"))).json()
    expect(own.daily.map((d: { value: number }) => d.value)).toEqual([9000])
  })

  it("disconnect deletes the owner's consent and readings", async () => {
    await connectAndSync("cashier-token", 9000)
    const res = await DELETE(request("DELETE", "cashier-token", { query: "?provider=health_connect" }))
    expect(res.status).toBe(200)
    expect(tables.personal_wearable_daily.filter((r) => r.owner_profile_id === CASHIER)).toHaveLength(0)
    expect(tables.personal_wearable_connections.filter((r) => r.owner_profile_id === CASHIER)).toHaveLength(0)
  })

  it("marks responses private so shared proxies never cache health data", async () => {
    const res = await GET(request("GET", "cashier-token"))
    expect(res.headers.get("cache-control")).toBe("private, no-store")
  })
})
