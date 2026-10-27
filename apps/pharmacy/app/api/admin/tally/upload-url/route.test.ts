import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest, NextResponse } from "next/server"
import { fakeSupabase, filtersOf, type FakeOperation, type FakeResult } from "@/lib/tally/test-db"
import { TALLY_SOURCE_LIMIT } from "@/lib/tally/storage"

const m = vi.hoisted(() => ({
  auth: null as unknown,
  db: null as unknown as { client: unknown; operations: FakeOperation[] },
  uploadFails: false,
  targets: [] as Array<{ tenantId: string; sessionId: string; extension: string }>,
}))

vi.mock("@/lib/api-auth", () => ({
  requirePharmacyPermission: vi.fn(async () => m.auth),
}))
vi.mock("@/lib/supabase/admin", () => ({
  get supabaseAdmin() {
    return m.db.client
  },
}))
vi.mock("@/lib/tally/storage", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/tally/storage")>()
  return {
    ...actual,
    createTallyUploadTarget: vi.fn(async (_storage: unknown, args: { tenantId: string; sessionId: string; extension: string }) => {
      if (m.uploadFails) throw new Error("Bucket unavailable")
      m.targets.push(args)
      return {
        bucket: "pharmacy-imports",
        path: `tenants/${args.tenantId}/imports/${args.sessionId}/source.${args.extension}`,
        token: "signed-token",
      }
    }),
  }
})

import { POST } from "./route"

const AUTHORISED = {
  ok: true,
  tenantId: "tenant-1",
  session: { user: { id: "user-1" } },
}

function setup(resolve: (operation: FakeOperation) => FakeResult = () => ({ data: null, error: null })) {
  m.db = fakeSupabase(resolve)
}

function sessions(overrides: { insert?: FakeResult } = {}) {
  return (operation: FakeOperation): FakeResult => {
    if (operation.action === "insert") {
      return overrides.insert ?? { data: { id: "session-1" }, error: null }
    }
    return { data: null, error: null }
  }
}

const post = (body: unknown) =>
  POST(
    new NextRequest("http://localhost/api/admin/tally/upload-url", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  )

describe("POST /api/admin/tally/upload-url", () => {
  beforeEach(() => {
    m.auth = AUTHORISED
    m.uploadFails = false
    m.targets = []
    setup()
  })

  it("refuses a session without inventory.write before touching the database", async () => {
    m.auth = {
      ok: false,
      response: NextResponse.json({ error: "Forbidden" }, { status: 403 }),
    }

    const res = await post({ fileName: "tally.xml" })

    expect(res.status).toBe(403)
    expect(m.db.operations).toHaveLength(0)
  })

  it("refuses a file type no parser can read", async () => {
    const res = await post({ fileName: "tally.txt" })

    expect(res.status).toBe(415)
    expect(m.db.operations).toHaveLength(0)
  })

  it("rejects an empty or oversized file before creating a session", async () => {
    expect((await post({ fileName: "tally.xml", fileSize: 0 })).status).toBe(413)
    expect((await post({ fileName: "tally.xml", fileSize: TALLY_SOURCE_LIMIT + 1 })).status).toBe(413)
    expect(m.db.operations).toHaveLength(0)
  })

  it("creates a pending session and returns a signed upload target", async () => {
    setup(sessions())

    const res = await post({ fileName: "  my\u0000export.xml ", fileSize: 1_024 })
    const body = await res.json()

    expect(res.status).toBe(200)
    expect(body).toMatchObject({
      sessionId: "session-1",
      bucket: "pharmacy-imports",
      path: "tenants/tenant-1/imports/session-1/source.xml",
      token: "signed-token",
    })

    const insert = m.db.operations.find((operation) => operation.action === "insert")
    expect(insert?.payload).toMatchObject({
      tenant_id: "tenant-1",
      source_system: "Tally",
      file_name: "my export.xml",
      status: "pending",
      created_by: "user-1",
    })
    expect(m.targets).toEqual([{ tenantId: "tenant-1", sessionId: "session-1", extension: "xml" }])

    const update = m.db.operations.find((operation) => operation.action === "update")
    expect(update?.payload).toMatchObject({
      file_url: "tenants/tenant-1/imports/session-1/source.xml",
    })
    expect(filtersOf(update!)).toEqual({ id: "session-1", tenant_id: "tenant-1" })
  })

  it("fails the request when the upload path cannot be stored", async () => {
    let updates = 0
    setup((operation) => {
      if (operation.action === "insert") return { data: { id: "session-1" }, error: null }
      if (operation.action === "update") {
        updates += 1
        if (updates === 1) return { data: null, error: { message: "write failed" } }
      }
      return { data: null, error: null }
    })

    const res = await post({ fileName: "tally.xml" })
    const body = await res.json()

    expect(res.status).toBe(500)
    expect(body).toMatchObject({ error: "write failed", sessionId: "session-1" })
    expect(body.token).toBeUndefined()

    const lastUpdate = m.db.operations.filter((operation) => operation.action === "update").at(-1)
    expect(lastUpdate?.payload).toMatchObject({ status: "failed", error_message: "write failed" })
  })

  it("marks the session failed when a signed URL cannot be created", async () => {
    setup(sessions())
    m.uploadFails = true

    const res = await post({ fileName: "tally.csv" })

    expect(res.status).toBe(500)
    expect(await res.json()).toMatchObject({ error: "Bucket unavailable", sessionId: "session-1" })

    const update = m.db.operations.find((operation) => operation.action === "update")
    expect(update?.payload).toMatchObject({ status: "failed", error_message: "Bucket unavailable" })
  })
})
