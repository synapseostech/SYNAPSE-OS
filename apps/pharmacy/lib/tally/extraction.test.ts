import { describe, expect, it } from "vitest"
import {
  MASTERS_CHUNK_ID,
  createManifest,
  recordChunkResult,
  splitChunk,
  summariseExtraction,
  voucherChunkId,
  type TallyChunkKind,
  type TallyDateRange,
  type TallyMigrationManifest,
} from "./chunks"
import {
  EXTRACTION_MAX_ATTEMPTS,
  isTransientExtractionError,
  runTallyExtraction,
  type TallyExtractionSink,
  type TallyExtractionSource,
} from "./extraction"
import { TallyBridgeError } from "./bridge-client"

const period = { from: "2026-01-01", to: "2026-03-31" }

function manifestWith(parts: number): TallyMigrationManifest {
  return createManifest({
    sessionId: "session-1",
    company: "Test Pharmacy",
    mode: "opening",
    period,
    parts,
    updatedAt: "2026-10-01T00:00:00.000Z",
  })
}

type SourceCall = {
  kind: TallyChunkKind
  range: TallyDateRange
  company: string
  mode: string
}

function sourceReturning(
  reply: (input: { kind: TallyChunkKind; range: TallyDateRange }) => {
    xml: string
    bytes: number
  },
): TallyExtractionSource & { calls: SourceCall[] } {
  const calls: SourceCall[] = []
  return {
    calls,
    async exportRange(input) {
      calls.push({
        kind: input.kind,
        range: input.range,
        company: input.company,
        mode: input.mode,
      })
      return reply(input)
    },
  }
}

function voucherXml(range: TallyDateRange, count = 1): string {
  const vouchers = Array.from(
    { length: count },
    () => `<VOUCHER><DATE>${range.from.replaceAll("-", "")}</DATE></VOUCHER>`,
  ).join("")
  return `<ENVELOPE><BODY><DATA>${vouchers}</DATA></BODY></ENVELOPE>`
}

function memorySink(
  initial: TallyMigrationManifest,
  options: { reject?: (chunkId: string) => string | undefined } = {},
): TallyExtractionSink & { submitted: string[]; current: () => TallyMigrationManifest } {
  let manifest = initial
  const submitted: string[] = []
  return {
    submitted,
    current: () => manifest,
    async load() {
      return manifest
    },
    async start({ chunkId }) {
      manifest = recordChunkResult(manifest, chunkId, { status: "running" })
      return manifest
    },
    async submit(input) {
      submitted.push(input.chunkId)
      const rejection = options.reject?.(input.chunkId)
      if (rejection) {
        manifest = recordChunkResult(manifest, input.chunkId, {
          status: "failed",
          error: rejection,
        })
        return { manifest, result: { status: "failed", error: rejection } }
      }
      const recordsRead = (input.xml.match(/<VOUCHER>/g) ?? []).length
      manifest = recordChunkResult(manifest, input.chunkId, {
        status: "complete",
        recordsRead,
        ...(recordsRead > 0 ? { firstDate: input.range.from, lastDate: input.range.to } : {}),
      })
      return { manifest, result: { status: "complete", recordsRead } }
    },
    async fail({ chunkId, error }) {
      manifest = recordChunkResult(manifest, chunkId, { status: "failed", error })
      return manifest
    },
    async split({ chunkId, ranges }) {
      manifest = splitChunk(manifest, chunkId, ranges)
      return manifest
    },
  }
}

const noWait = async () => {}

describe("extraction loop", () => {
  it("reads masters once and every voucher range exactly as the manifest states", async () => {
    const manifest = manifestWith(3)
    const sink = memorySink(manifest)
    const source = sourceReturning(({ range }) => ({
      xml: voucherXml(range, 2),
      bytes: 200,
    }))

    const result = await runTallyExtraction({
      company: "Test Pharmacy",
      mode: "opening",
      source,
      sink,
      wait: noWait,
    })

    expect(result.stopped).toBe("complete")
    expect(source.calls.map((call) => call.range)).toEqual([
      period,
      manifest.chunks[1]!.range,
      manifest.chunks[2]!.range,
      manifest.chunks[3]!.range,
    ])
    expect(source.calls.every((call) => call.company === "Test Pharmacy")).toBe(true)
    expect(result.summary.recordsRead).toBe(8)
    expect(result.summary.completeAll).toBe(true)
  })

  it("retries a transient failure without duplicating the chunk", async () => {
    let attempts = 0
    const source: TallyExtractionSource = {
      async exportRange({ range }) {
        attempts += 1
        if (attempts === 2) throw new TypeError("fetch failed")
        return { xml: voucherXml(range), bytes: 100 }
      },
    }
    const sink = memorySink(manifestWith(1))

    const result = await runTallyExtraction({
      company: "Test Pharmacy",
      mode: "opening",
      source,
      sink,
      wait: noWait,
    })

    expect(result.stopped).toBe("complete")
    const voucher = result.manifest.chunks.find((chunk) => chunk.kind === "vouchers")
    expect(voucher?.status).toBe("complete")
    expect(voucher?.attempts).toBe(2)
    expect(result.manifest.chunks.filter((chunk) => chunk.kind === "vouchers")).toHaveLength(1)
  })

  it("resumes from the saved manifest and skips completed chunks", async () => {
    let manifest = manifestWith(3)
    // A previous run read the masters and the first range.
    manifest = recordChunkResult(manifest, MASTERS_CHUNK_ID, { status: "running" })
    manifest = recordChunkResult(manifest, MASTERS_CHUNK_ID, { status: "complete", recordsRead: 4 })
    manifest = recordChunkResult(manifest, voucherChunkId(manifest.chunks[1]!.range), {
      status: "running",
    })
    manifest = recordChunkResult(manifest, voucherChunkId(manifest.chunks[1]!.range), {
      status: "complete",
      recordsRead: 9,
      firstDate: manifest.chunks[1]!.range.from,
      lastDate: manifest.chunks[1]!.range.to,
    })
    const sink = memorySink(manifest)
    const source = sourceReturning(({ range }) => ({ xml: voucherXml(range), bytes: 50 }))

    const result = await runTallyExtraction({
      company: "Test Pharmacy",
      mode: "opening",
      source,
      sink,
      wait: noWait,
    })

    expect(result.stopped).toBe("complete")
    expect(source.calls.map((call) => call.range)).toEqual([
      manifest.chunks[2]!.range,
      manifest.chunks[3]!.range,
    ])
    // The resumed records survive untouched.
    expect(result.manifest.chunks.find((chunk) => chunk.id === MASTERS_CHUNK_ID)?.recordsRead).toBe(4)
    // 4 masters + 9 from the resumed range + 1 from each of the two new ranges.
    expect(result.summary.recordsRead).toBe(15)
  })

  it("does nothing when every chunk is already complete", async () => {
    let manifest = manifestWith(2)
    for (const chunk of manifest.chunks) {
      manifest = recordChunkResult(manifest, chunk.id, { status: "complete", recordsRead: 1 })
    }
    const sink = memorySink(manifest)
    const source = sourceReturning(() => ({ xml: "<ENVELOPE/>", bytes: 10 }))

    const result = await runTallyExtraction({
      company: "Test Pharmacy",
      mode: "opening",
      source,
      sink,
      wait: noWait,
    })

    expect(result.stopped).toBe("complete")
    expect(source.calls).toHaveLength(0)
    expect(sink.submitted).toHaveLength(0)
  })

  it("stops on a chunk the server could not parse and keeps earlier chunks complete", async () => {
    const sink = memorySink(manifestWith(3), {
      reject: (chunkId) =>
        chunkId.includes("2026-03-01") ? "MIGRATION_XML_INCOMPLETE" : undefined,
    })
    const source = sourceReturning(({ range }) => ({ xml: voucherXml(range), bytes: 100 }))

    const result = await runTallyExtraction({
      company: "Test Pharmacy",
      mode: "opening",
      source,
      sink,
      wait: noWait,
    })

    expect(result.stopped).toBe("failed")
    expect(result.chunkId).toContain("2026-03-01")
    const complete = result.manifest.chunks.filter((chunk) => chunk.status === "complete")
    expect(complete.length).toBeGreaterThanOrEqual(2)
    // The failed chunk is not quietly dropped from coverage.
    expect(result.summary.completeAll).toBe(false)
    expect(result.summary.failures.map((failure) => failure.id)).toContain(result.chunkId)
  })

  it("halves a range whose response is too large and reads both halves", async () => {
    const manifest = manifestWith(1)
    const sink = memorySink(manifest)
    const source = sourceReturning(({ kind, range }) => {
      if (kind === "masters") return { xml: voucherXml(range, 0), bytes: 100 }
      const days = Math.round(
        (Date.parse(`${range.to}T00:00:00Z`) - Date.parse(`${range.from}T00:00:00Z`)) / 86_400_000,
      ) + 1
      // Only a range longer than one day is over the limit here.
      const bytes = days > 1 ? 5_000 : 100
      return { xml: voucherXml(range, days > 1 ? 50 : 1), bytes }
    })

    const result = await runTallyExtraction({
      company: "Test Pharmacy",
      mode: "opening",
      source,
      sink,
      maxChunkBytes: 1_000,
      wait: noWait,
    })

    expect(result.stopped).toBe("complete")
    const vouchers = result.manifest.chunks.filter((chunk) => chunk.kind === "vouchers")
    expect(vouchers.length).toBeGreaterThan(2)
    expect(vouchers.every((chunk) => chunk.status === "complete")).toBe(true)
    // No range was read at its oversized width and recorded anyway.
    expect(vouchers.every((chunk) => chunk.bytes <= 1_000)).toBe(true)
  })

  it("fails a one-day range that is still too large rather than truncating it", async () => {
    const manifest = createManifest({
      sessionId: "session-1",
      company: "Test Pharmacy",
      mode: "opening",
      period: { from: "2026-01-01", to: "2026-01-01" },
      updatedAt: "2026-10-01T00:00:00.000Z",
    })
    const sink = memorySink(manifest)
    const source = sourceReturning(({ kind }) =>
      kind === "masters"
        ? { xml: "<ENVELOPE/>", bytes: 100 }
        : { xml: "<ENVELOPE/>", bytes: 5_000 },
    )

    const result = await runTallyExtraction({
      company: "Test Pharmacy",
      mode: "opening",
      source,
      sink,
      maxChunkBytes: 1_000,
      wait: noWait,
    })

    expect(result.stopped).toBe("failed")
    const voucher = result.manifest.chunks.find((chunk) => chunk.kind === "vouchers")
    expect(voucher?.status).toBe("failed")
    expect(voucher?.error).toBe("TALLY_CHUNK_TOO_LARGE")
  })

  it("gives up after the attempt limit and reports the failed chunk", async () => {
    const source: TallyExtractionSource = {
      async exportRange() {
        throw new TallyBridgeError("TALLY_BRIDGE_TALLY_UNAVAILABLE", "down", 502)
      },
    }
    const sink = memorySink(manifestWith(1))

    const result = await runTallyExtraction({
      company: "Test Pharmacy",
      mode: "opening",
      source,
      sink,
      wait: noWait,
    })

    expect(result.stopped).toBe("failed")
    const masters = result.manifest.chunks.find((chunk) => chunk.id === MASTERS_CHUNK_ID)
    expect(masters?.attempts).toBe(EXTRACTION_MAX_ATTEMPTS)
    expect(masters?.status).toBe("failed")
  })

  it("does not retry a refused request", async () => {
    let attempts = 0
    const source: TallyExtractionSource = {
      async exportRange() {
        attempts += 1
        throw new TallyBridgeError("TALLY_BRIDGE_PERIOD_MISMATCH", "wrong period", 422)
      },
    }
    const sink = memorySink(manifestWith(1))

    const result = await runTallyExtraction({
      company: "Test Pharmacy",
      mode: "opening",
      source,
      sink,
      wait: noWait,
    })

    expect(result.stopped).toBe("failed")
    expect(attempts).toBe(1)
  })

  it("stops between chunks when the operator cancels", async () => {
    const controller = new AbortController()
    const source = sourceReturning(({ range }) => ({ xml: voucherXml(range), bytes: 10 }))
    const sink = memorySink(manifestWith(3))
    const originalSubmit = sink.submit.bind(sink)
    sink.submit = async (input) => {
      const recorded = await originalSubmit(input)
      controller.abort()
      return recorded
    }

    const result = await runTallyExtraction({
      company: "Test Pharmacy",
      mode: "opening",
      source,
      sink,
      signal: controller.signal,
      wait: noWait,
    })

    expect(result.stopped).toBe("cancelled")
    expect(source.calls).toHaveLength(1)
    expect(summariseExtraction(result.manifest).complete).toBe(1)
  })
})

describe("failure classification", () => {
  it("separates a retryable bridge failure from a refusal", () => {
    expect(isTransientExtractionError(new TypeError("fetch failed"))).toBe(true)
    expect(
      isTransientExtractionError(
        new TallyBridgeError("TALLY_BRIDGE_TALLY_TIMEOUT", "timeout", 502),
      ),
    ).toBe(true)
    expect(
      isTransientExtractionError(
        new TallyBridgeError("TALLY_BRIDGE_COMPANY_MISMATCH", "wrong company", 422),
      ),
    ).toBe(false)
    expect(isTransientExtractionError(new DOMException("aborted", "AbortError"))).toBe(false)
  })
})
