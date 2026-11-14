import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest, NextResponse } from "next/server"
import { fakeSupabase, filtersOf, type FakeOperation, type FakeResult } from "@/lib/tally/test-db"
import type { TallyPlaybackEvent, TallyPlaybackIndex } from "@/lib/tally/types"

const m = vi.hoisted(() => ({
  auth: null as unknown,
  db: null as unknown as { client: unknown; operations: FakeOperation[] },
  readChunk: vi.fn(),
}))

vi.mock("@/lib/tally/auth", () => ({ requireTallyAdmin: vi.fn(async () => m.auth) }))
vi.mock("@/lib/supabase/admin", () => ({
  get supabaseAdmin() {
    return m.db.client
  },
}))
vi.mock("@/lib/tally/plan", () => ({ readTallyPlaybackChunk: m.readChunk }))

import { GET } from "./route"

const AUTHORISED = { ok: true, tenantId: "tenant-1", actorId: "user-1" }

const INDEX: TallyPlaybackIndex = {
  mode: "opening",
  firstDate: "2026-01-03",
  lastDate: "2026-01-09",
  eventCount: 3,
  movementCount: 0,
  chunkCount: 2,
  chunkSize: 2,
  days: [
    { date: "2026-01-03", events: 2, movements: 0, firstChunk: 0 },
    { date: "2026-01-09", events: 1, movements: 0, firstChunk: 1 },
  ],
}

const EVENTS: TallyPlaybackEvent[] = [
  {
    id: "SAL-0001",
    date: "2026-01-03",
    type: "voucher",
    kind: "sales",
    number: "SAL-0001",
    description: "Cash sale",
    debit: 100,
    credit: 0,
    lineCount: 1,
    stock: [{ item: "Test Item A", quantity: 2, direction: "out" }],
    movements: 0,
  },
]

function sessionRow(mapping: Record<string, unknown>) {
  return { id: "session-1", ai_mapping: mapping }
}

function setup(session: unknown) {
  m.db = fakeSupabase(
    (operation): FakeResult =>
      operation.action === "select"
        ? { data: session, error: null }
        : { data: null, error: null },
  )
}

const params = { params: Promise.resolve({ id: "session-1" }) }
const get = (query = "") =>
  GET(new NextRequest(`http://localhost/api/admin/tally/session-1/playback${query}`), params)

describe("GET /api/admin/tally/[id]/playback", () => {
  beforeEach(() => {
    m.auth = AUTHORISED
    m.readChunk.mockReset().mockResolvedValue(EVENTS)
    setup(sessionRow({ summary: { playback: INDEX } }))
  })

  it("refuses a session without inventory.read", async () => {
    m.auth = { ok: false, response: NextResponse.json({ error: "Forbidden" }, { status: 403 }) }

    const res = await get("?chunk=0")

    expect(res.status).toBe(403)
    expect(m.readChunk).not.toHaveBeenCalled()
  })

  it("scopes the session to the tenant", async () => {
    await get("?chunk=0")

    const select = m.db.operations.find((operation) => operation.action === "select")
    expect(filtersOf(select!)).toEqual({ id: "session-1", tenant_id: "tenant-1" })
  })

  it("404s a session it cannot see", async () => {
    setup(null)

    const res = await get("?chunk=0")

    expect(res.status).toBe(404)
  })

  it("asks for a preview before there is anything to walk", async () => {
    setup(sessionRow({}))

    const res = await get("?chunk=0")
    const body = await res.json()

    expect(res.status).toBe(409)
    expect(body.code).toBe("TALLY_PLAYBACK_NOT_PREPARED")
  })

  it("says a closing cut-over has no dated history", async () => {
    setup(sessionRow({ summary: { preparedAt: "2026-01-01T00:00:00.000Z" } }))

    const res = await get("?chunk=0")
    const body = await res.json()

    expect(res.status).toBe(409)
    expect(body.code).toBe("TALLY_PLAYBACK_EMPTY")
  })

  it("rejects a chunk that is not a whole number", async () => {
    const res = await get("?chunk=first")

    expect(res.status).toBe(400)
    expect((await res.json()).code).toBe("TALLY_PLAYBACK_CHUNK_INVALID")
    expect(m.readChunk).not.toHaveBeenCalled()
  })

  it("rejects a chunk past the end", async () => {
    const res = await get("?chunk=2")

    expect(res.status).toBe(400)
    expect((await res.json()).code).toBe("TALLY_PLAYBACK_CHUNK_OUT_OF_RANGE")
  })

  it("says a page was never saved rather than showing an empty day", async () => {
    m.readChunk.mockResolvedValue(null)

    const res = await get("?chunk=0")

    expect(res.status).toBe(409)
    expect((await res.json()).code).toBe("TALLY_PLAYBACK_CHUNK_MISSING")
  })

  it("returns one page and says whether it is the last", async () => {
    const first = await get("?chunk=0")
    const body = await first.json()

    expect(first.status).toBe(200)
    expect(first.headers.get("Cache-Control")).toBe("no-store")
    expect(body).toMatchObject({
      chunk: 0,
      totalChunks: 2,
      chunkSize: 2,
      mode: "opening",
      firstDate: "2026-01-03",
      lastDate: "2026-01-09",
      last: false,
      events: EVENTS,
    })
    expect(m.readChunk).toHaveBeenCalledWith(expect.anything(), "tenant-1", "session-1", 0)

    m.readChunk.mockResolvedValue([])
    const final = await get("?chunk=1")
    expect((await final.json()).last).toBe(true)
  })

  it("defaults to the first page", async () => {
    const res = await get()

    expect(res.status).toBe(200)
    expect(m.readChunk).toHaveBeenCalledWith(expect.anything(), "tenant-1", "session-1", 0)
  })
})
