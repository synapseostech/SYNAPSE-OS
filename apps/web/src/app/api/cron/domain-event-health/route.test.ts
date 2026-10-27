import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"

const s = vi.hoisted(() => ({
  statusRows: [] as Array<{ status: string }>,
  oldestPending: { created_at: "" } | null,
  statusError: null as { code: string; message: string } | null,
  oldestError: null as { code: string; message: string } | null,
  /** Statuses for which the route asked PostgREST for a head-only count. */
  headCalls: [] as string[],
}))

vi.mock("@synapse/db/admin", () => {
  const from = (table: string) => {
    if (table !== "synapse_domain_events") {
      return {
        select: () => ({ eq: () => ({ order: () => ({ limit: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }) }) }),
      }
    }
    let head = false
    let statusFilter = ""
    const q: any = {
      select: (_cols?: string, opts?: { head?: boolean }) => {
        head = opts?.head === true
        return q
      },
      eq: (col: string, val: string) => {
        if (col === "status") statusFilter = val
        return q
      },
      order: () => q,
      limit: () => q,
      maybeSingle: async () => {
        if (s.oldestError) return { data: null, error: s.oldestError }
        return { data: s.oldestPending, error: null }
      },
      then: (res: any) => {
        if (head) {
          s.headCalls.push(statusFilter)
          if (s.statusError) return Promise.resolve({ data: null, error: s.statusError, count: null }).then(res)
          // A head request returns a count and no rows; the mirror of what
          // PostgREST sends.
          const count = s.statusRows.filter((row) => row.status === statusFilter).length
          return Promise.resolve({ data: null, error: null, count }).then(res)
        }
        return Promise.resolve({ data: [], error: null }).then(res)
      },
    }
    return q
  }
  return {
    supabaseAdmin: { from },
  }
})

import { GET } from "./route"

const req = (headers: Record<string, string> = {}) =>
  new NextRequest("http://localhost/api/cron/domain-event-health", { headers })
const authed = () => req({ authorization: "Bearer test-cron-secret-value" })

describe("GET /api/cron/domain-event-health", () => {
  const prevSecret = process.env.CRON_SECRET
  const prevAlert = process.env.DOMAIN_EVENT_PENDING_ALERT_MINUTES
  beforeEach(() => {
    s.statusRows = []
    s.oldestPending = null
    s.statusError = null
    s.oldestError = null
    s.headCalls = []
    process.env.CRON_SECRET = "test-cron-secret-value"
    delete process.env.DOMAIN_EVENT_PENDING_ALERT_MINUTES
  })
  afterEach(() => {
    if (prevSecret === undefined) delete process.env.CRON_SECRET
    else process.env.CRON_SECRET = prevSecret
    if (prevAlert === undefined) delete process.env.DOMAIN_EVENT_PENDING_ALERT_MINUTES
    else process.env.DOMAIN_EVENT_PENDING_ALERT_MINUTES = prevAlert
  })

  it("fails closed (503) and runs nothing when CRON_SECRET is not configured", async () => {
    delete process.env.CRON_SECRET
    const res = await GET(req({ authorization: "Bearer anything" }))
    expect(res.status).toBe(503)
    const body = await res.json()
    expect(body.error).toBe("CRON_SECRET not configured")
  })

  it("rejects a missing or wrong secret with 401 and runs nothing", async () => {
    expect((await GET(req())).status).toBe(401)
    expect((await GET(req({ authorization: "Bearer wrong" }))).status).toBe(401)
    expect((await GET(req({ "x-cron-secret": "wrong" }))).status).toBe(401)
  })

  it("returns healthy (200) when queue is empty", async () => {
    s.statusRows = []
    const res = await GET(authed())
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.statusCounts).toEqual({ pending: 0, published: 0, failed: 0, dead: 0 })
    expect(body.oldestPendingAt).toBeNull()
  })

  it("returns healthy (200) when oldest pending is within threshold", async () => {
    s.statusRows = [{ status: "pending" }, { status: "published" }, { status: "failed" }]
    const recent = new Date(Date.now() - 30 * 60_000).toISOString() // 30 minutes ago
    s.oldestPending = { created_at: recent }
    const res = await GET(authed())
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.statusCounts).toEqual({ pending: 1, published: 1, failed: 1, dead: 0 })
    expect(body.oldestPendingAt).toBe(recent)
  })

  it("returns stale (500) when oldest pending exceeds threshold", async () => {
    s.statusRows = [{ status: "pending" }, { status: "pending" }]
    const old = new Date(Date.now() - 90 * 60_000).toISOString() // 90 minutes ago
    s.oldestPending = { created_at: old }
    const res = await GET(authed())
    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body.ok).toBe(false)
    expect(body.statusCounts.pending).toBe(2)
    expect(body.oldestPendingAt).toBe(old)
  })

  it("uses custom DOMAIN_EVENT_PENDING_ALERT_MINUTES threshold", async () => {
    s.statusRows = [{ status: "pending" }]
    const old = new Date(Date.now() - 45 * 60_000).toISOString() // 45 minutes ago
    s.oldestPending = { created_at: old }
    process.env.DOMAIN_EVENT_PENDING_ALERT_MINUTES = "30" // alert at 30 minutes
    const res = await GET(authed())
    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body.ok).toBe(false)
    expect(body.alertThresholdMinutes).toBe(30)
  })

  it("returns PostgREST error code in body on status query failure", async () => {
    s.statusRows = [{ status: "pending" }]
    s.statusError = { code: "PGRST116", message: "table not found" }
    const res = await GET(authed())
    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body.code).toBe("PGRST116")
  })

  it("returns PostgREST error code in body on oldest pending query failure", async () => {
    s.statusRows = [{ status: "pending" }]
    s.oldestError = { code: "42P01", message: "relation does not exist" }
    const res = await GET(authed())
    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body.code).toBe("42P01")
  })

  it("counts with head-only requests so a backlog past the row cap is not under-reported", async () => {
    // PostgREST returns at most its configured row limit in a body. The route
    // must therefore never count rows it downloaded.
    s.statusRows = Array.from({ length: 5000 }, () => ({ status: "pending" }))
    const res = await GET(authed())
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.statusCounts.pending).toBe(5000)
    expect(s.headCalls).toEqual(["pending", "published", "failed", "dead"])
  })

  it("falls back to the 60-minute threshold when DOMAIN_EVENT_PENDING_ALERT_MINUTES is not a number", async () => {
    s.statusRows = [{ status: "pending" }]
    s.oldestPending = { created_at: new Date(Date.now() - 90 * 60_000).toISOString() }
    process.env.DOMAIN_EVENT_PENDING_ALERT_MINUTES = "ninety"
    const res = await GET(authed())
    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body.alertThresholdMinutes).toBe(60)
  })
})