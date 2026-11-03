import { describe, expect, it, vi } from "vitest"
import { createManifest } from "./chunks"
import {
  beginLiveExtraction,
  createBridgeSource,
  createLiveSession,
  createPortalSink,
  finishLiveExtraction,
  TallyLiveError,
} from "./live-extraction"

const MANIFEST = createManifest({
  sessionId: "session-1",
  company: "Test Pharmacy",
  mode: "opening",
  period: { from: "2026-01-01", to: "2026-01-31" },
  parts: 1,
  updatedAt: "2026-01-01T00:00:00.000Z",
})

type Call = { url: string; method: string; body?: unknown; headers: Record<string, string> }

/** A fetch that records every call and answers from a queue of handlers. */
function recordingFetch(answer: (call: Call) => Response | Promise<Response>) {
  const calls: Call[] = []
  const impl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const call: Call = {
      url: String(input),
      method: init?.method ?? "GET",
      body: typeof init?.body === "string" ? init.body : undefined,
      headers: (init?.headers ?? {}) as Record<string, string>,
    }
    calls.push(call)
    return answer(call)
  }) as unknown as typeof fetch
  return { calls, impl }
}

function bridgeAnswer(call: Call): Response {
  const url = new URL(call.url)
  const scope = url.searchParams.get("scope") ?? "all"
  return new Response("<ENVELOPE/>", {
    status: 200,
    headers: {
      "x-synapse-tally-from": url.searchParams.get("from") ?? "",
      "x-synapse-tally-to": url.searchParams.get("to") ?? "",
      "x-synapse-tally-company": url.searchParams.get("company") ?? "",
      "x-synapse-tally-mode": url.searchParams.get("mode") ?? "",
      "x-synapse-tally-scope": scope,
    },
  })
}

describe("the bridge as an extraction source", () => {
  it("asks for masters once, and for the exact voucher range each time", async () => {
    const { calls, impl } = recordingFetch(bridgeAnswer)
    const source = createBridgeSource({ token: "t", fetchImpl: impl })

    await source.exportRange({
      company: "Test Pharmacy",
      mode: "opening",
      kind: "masters",
      range: { from: "2026-01-01", to: "2026-01-31" },
    })
    await source.exportRange({
      company: "Test Pharmacy",
      mode: "opening",
      kind: "vouchers",
      range: { from: "2026-01-01", to: "2026-01-15" },
    })

    const first = new URL(calls[0]!.url)
    expect(first.searchParams.get("scope")).toBe("masters")
    expect(first.searchParams.get("from")).toBe("20260101")
    expect(first.searchParams.get("to")).toBe("20260131")

    const second = new URL(calls[1]!.url)
    expect(second.searchParams.get("scope")).toBe("vouchers")
    expect(second.searchParams.get("to")).toBe("20260115")
    expect(calls[1]!.headers["x-synapse-tally-bridge-token"]).toBe("t")
  })

  it("refuses an export whose echo does not match the range that was asked for", async () => {
    const { impl } = recordingFetch(
      () =>
        new Response("<ENVELOPE/>", {
          status: 200,
          headers: {
            "x-synapse-tally-from": "20260101",
            "x-synapse-tally-to": "20260120",
            "x-synapse-tally-company": "Test Pharmacy",
            "x-synapse-tally-mode": "opening",
            "x-synapse-tally-scope": "vouchers",
          },
        }),
    )
    const source = createBridgeSource({ token: "t", fetchImpl: impl })

    await expect(
      source.exportRange({
        company: "Test Pharmacy",
        mode: "opening",
        kind: "vouchers",
        range: { from: "2026-01-01", to: "2026-01-31" },
      }),
    ).rejects.toThrow(/different period/)
  })
})

describe("the portal as an extraction sink", () => {
  it("uploads a chunk to its signed target and then records its path", async () => {
    const { calls, impl } = recordingFetch((call) => {
      if (call.url === "https://storage.test/upload") return new Response(null, { status: 200 })
      const body = JSON.parse(String(call.body)) as { action: string }
      if (body.action === "target") {
        return Response.json({
          bucket: "pharmacy-imports",
          path: "tenants/t/imports/session-1/chunks/masters.xml",
          token: "signed",
          signedUrl: "https://storage.test/upload",
        })
      }
      return Response.json({
        manifest: MANIFEST,
        result: { status: "complete", recordsRead: 3 },
      })
    })
    const sink = createPortalSink({ sessionId: "session-1", fetchImpl: impl })

    const recorded = await sink.submit({
      chunkId: "masters",
      kind: "masters",
      range: { from: "2026-01-01", to: "2026-01-31" },
      attempt: 1,
      xml: "<ENVELOPE/>",
      bytes: 11,
    })

    expect(recorded.result.status).toBe("complete")
    expect(calls.map((call) => call.method)).toEqual(["POST", "PUT", "POST"])
    expect(calls[1]!.url).toBe("https://storage.test/upload")
    expect(calls[1]!.body).toBe("<ENVELOPE/>")
    expect(JSON.parse(String(calls[2]!.body))).toEqual({
      action: "chunk",
      chunkId: "masters",
      path: "tenants/t/imports/session-1/chunks/masters.xml",
    })
  })

  it("never records a chunk whose upload failed", async () => {
    const { calls, impl } = recordingFetch((call) => {
      if (call.url === "https://storage.test/upload") {
        return new Response("nope", { status: 403 })
      }
      return Response.json({ signedUrl: "https://storage.test/upload", path: "p" })
    })
    const sink = createPortalSink({ sessionId: "session-1", fetchImpl: impl })

    await expect(
      sink.submit({
        chunkId: "masters",
        kind: "masters",
        range: { from: "2026-01-01", to: "2026-01-31" },
        attempt: 1,
        xml: "<ENVELOPE/>",
        bytes: 11,
      }),
    ).rejects.toMatchObject({ code: "TALLY_CHUNK_UPLOAD_FAILED" })
    expect(calls).toHaveLength(2)
    expect(calls.every((call) => call.url !== "/api/admin/tally/session-1/extract" || JSON.parse(String(call.body)).action === "target")).toBe(true)
  })

  it("sends the manifest actions the server expects", async () => {
    const { calls, impl } = recordingFetch(() => Response.json({ manifest: MANIFEST }))
    const sink = createPortalSink({ sessionId: "session-1", fetchImpl: impl })

    await sink.load()
    await sink.start({ chunkId: "masters", attempt: 2 })
    await sink.fail({ chunkId: "masters", attempt: 2, error: "boom" })
    await sink.split({
      chunkId: "vouchers:2026-01-01:2026-01-31",
      ranges: [
        { from: "2026-01-01", to: "2026-01-16" },
        { from: "2026-01-17", to: "2026-01-31" },
      ],
    })

    expect(calls.map((call) => JSON.parse(String(call.body)))).toEqual([
      { action: "status" },
      { action: "start", chunkId: "masters", attempt: 2 },
      { action: "fail", chunkId: "masters", error: "boom" },
      {
        action: "split",
        chunkId: "vouchers:2026-01-01:2026-01-31",
        ranges: [
          { from: "2026-01-01", to: "2026-01-16" },
          { from: "2026-01-17", to: "2026-01-31" },
        ],
      },
    ])
  })
})

describe("the portal session calls", () => {
  it("creates a session with no file, and states the company and period it will read", async () => {
    const { calls, impl } = recordingFetch((call) =>
      call.url === "/api/admin/tally/upload-url"
        ? Response.json({ sessionId: "session-1" })
        : Response.json({ manifest: MANIFEST, summary: { completeAll: false } }),
    )

    expect(await createLiveSession(impl)).toEqual({ sessionId: "session-1" })
    await beginLiveExtraction(
      {
        sessionId: "session-1",
        company: "Test Pharmacy",
        mode: "opening",
        period: { from: "2026-01-01", to: "2026-01-31" },
      },
      impl,
    )

    expect(JSON.parse(String(calls[0]!.body))).toEqual({ source: "bridge" })
    expect(JSON.parse(String(calls[1]!.body))).toMatchObject({
      action: "begin",
      company: "Test Pharmacy",
      mode: "opening",
      period: { from: "2026-01-01", to: "2026-01-31" },
    })
  })

  it("reports why the server refused to stage an incomplete extraction", async () => {
    const { impl } = recordingFetch(() =>
      Response.json(
        { error: "Every chunk must be read before this extraction can be reviewed.", code: "TALLY_EXTRACTION_INCOMPLETE" },
        { status: 409 },
      ),
    )

    await expect(finishLiveExtraction("session-1", impl)).rejects.toMatchObject({
      name: "TallyLiveError",
      code: "TALLY_EXTRACTION_INCOMPLETE",
      status: 409,
    })
    await expect(finishLiveExtraction("session-1", impl)).rejects.toBeInstanceOf(TallyLiveError)
  })
})
