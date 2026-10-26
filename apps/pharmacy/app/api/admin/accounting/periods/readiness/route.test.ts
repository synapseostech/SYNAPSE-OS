import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"

const m = vi.hoisted(() => ({
  rpc: (async () => ({ data: null, error: null })) as (
    fn: string,
    args: Record<string, unknown>,
  ) => Promise<{ data: unknown; error: unknown }>,
  calls: [] as Array<{ fn: string; args: Record<string, unknown> }>,
}))

vi.mock("@/lib/api-auth", () => ({
  requirePharmacyPermission: vi.fn(async () => ({
    ok: true,
    session: { user: { id: "u-1" } },
    tenantId: "tenant-1",
  })),
}))

vi.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: {
    rpc: async (fn: string, args: Record<string, unknown>) => {
      m.calls.push({ fn, args })
      return m.rpc(fn, args)
    },
  },
}))

import { GET } from "./route"

const get = async (start: string, end: string) => {
  const url =
    "http://localhost/api/admin/accounting/periods/readiness" +
    `?start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}`
  const res = await GET(new NextRequest(url))
  return { status: res.status, body: await res.json() }
}

const facts = (overrides: Record<string, unknown> = {}) => ({
  periodStart: "2026-09-01",
  periodEnd: "2026-09-30",
  assessedOn: "2026-10-26",
  tillSessions: [],
  unmatchedBankLines: 0,
  unmatchedBankValue: 0,
  journalEntries: 4,
  journalDebitTotal: 1200,
  salesCount: 10,
  salesTotal: 5000,
  cashSalesTotal: 4000,
  ...overrides,
})

beforeEach(() => {
  m.calls = []
  m.rpc = async () => ({ data: facts(), error: null })
})

describe("GET /api/admin/accounting/periods/readiness", () => {
  it("rejects a bad date with 400 before calling the RPC", async () => {
    const r = await get("2026-9-1", "2026-09-30")
    expect(r.status).toBe(400)
    expect(m.calls).toHaveLength(0)
  })

  it("returns 503 when the readiness RPC has not been applied (PGRST202)", async () => {
    m.rpc = async () => ({
      data: null,
      error: { code: "PGRST202", message: "Could not find the function" },
    })
    const r = await get("2026-09-01", "2026-09-30")
    expect(r.status).toBe(503)
    expect(m.calls).toHaveLength(1)
  })

  it("reports an open till as a blocker with 200", async () => {
    m.rpc = async () => ({
      data: facts({
        tillSessions: [{ status: "open", openedOn: "2026-09-30", closedOn: null }],
      }),
      error: null,
    })
    const r = await get("2026-09-01", "2026-09-30")
    expect(r.status).toBe(200)
    expect(r.body.readiness.ready).toBe(false)
    expect(r.body.readiness.blockers.map((b: { code: string }) => b.code)).toContain(
      "OPEN_TILL_SESSIONS",
    )
  })

  it("returns ready true for a clean period and echoes the snapshot", async () => {
    const r = await get("2026-09-01", "2026-09-30")
    expect(r.status).toBe(200)
    expect(r.body.readiness.ready).toBe(true)
    expect(r.body.snapshot).toMatchObject({
      salesCount: 10,
      journalEntries: 4,
      openTillSessions: 0,
    })
  })
})
