import { describe, expect, it } from "vitest"
import {
  MASTERS_CHUNK_ID,
  TALLY_MANIFEST_VERSION,
  canApplyManifest,
  canRetryChunk,
  createManifest,
  createOpenManifest,
  dateSpan,
  ensureChunk,
  halveRange,
  isManifestLike,
  manifestProblems,
  nextChunkToRun,
  parseTallyIsoDate,
  reconcileCounts,
  recordChunkResult,
  replaceChunkResult,
  splitChunk,
  splitPeriod,
  summariseExtraction,
  voucherChunkId,
  voucherDatesOutsidePeriod,
  widenPeriod,
  type TallyDateRange,
  type TallyMigrationManifest,
} from "./chunks"

const AT = "2026-11-01T00:00:00.000Z"
const TEN_DAYS: TallyDateRange = { from: "2026-01-01", to: "2026-01-10" }

function build(parts = 1, period: TallyDateRange = TEN_DAYS): TallyMigrationManifest {
  return createManifest({
    sessionId: "session-1",
    company: "Demo Pharma",
    mode: "opening",
    period,
    parts,
    updatedAt: AT,
  })
}

function completeAll(manifest: TallyMigrationManifest): TallyMigrationManifest {
  return manifest.chunks.reduce(
    (next, chunk) => recordChunkResult(next, chunk.id, { status: "complete", recordsRead: 10 }, AT),
    manifest,
  )
}

function codes(manifest: TallyMigrationManifest): string[] {
  return manifestProblems(manifest).map((entry) => entry.code)
}

function voucherIds(manifest: TallyMigrationManifest): string[] {
  return manifest.chunks.filter((chunk) => chunk.kind === "vouchers").map((chunk) => chunk.id)
}

describe("createOpenManifest", () => {
  it("starts with the masters chunk alone, so no range pretends to be covered", () => {
    const open = createOpenManifest({
      sessionId: "session-1",
      company: "Demo Pharma",
      mode: "opening",
      period: TEN_DAYS,
      updatedAt: AT,
    })

    expect(open.chunks).toHaveLength(1)
    expect(open.chunks[0]).toMatchObject({ id: MASTERS_CHUNK_ID, kind: "masters", status: "pending" })
    expect(codes(open)).toEqual(
      expect.arrayContaining(["TALLY_CHUNK_MISSING", "TALLY_CHUNK_INCOMPLETE"]),
    )
  })
})

describe("ensureChunk", () => {
  it("appends a chunk the manifest does not have yet", () => {
    const open = createOpenManifest({
      sessionId: "session-1",
      company: "Demo Pharma",
      mode: "opening",
      period: TEN_DAYS,
      updatedAt: AT,
    })

    const next = ensureChunk(open, { kind: "vouchers", id: "vouchers:a:b", range: TEN_DAYS }, AT)

    expect(next.chunks.map((chunk) => chunk.id)).toEqual([MASTERS_CHUNK_ID, "vouchers:a:b"])
  })

  it("leaves an existing chunk untouched, so a retry cannot duplicate a range", () => {
    const manifest = build(1)

    expect(ensureChunk(manifest, {
      kind: "vouchers",
      id: voucherIds(manifest)[0]!,
      range: TEN_DAYS,
    }, AT)).toBe(manifest)
  })

  it("refuses a range that is not two real days", () => {
    const open = createOpenManifest({
      sessionId: "session-1",
      company: "Demo Pharma",
      mode: "opening",
      period: TEN_DAYS,
      updatedAt: AT,
    })

    expect(() =>
      ensureChunk(open, { kind: "vouchers", id: "vouchers:x", range: { from: "2026-02-30", to: "2026-03-01" } }, AT),
    ).toThrow()
  })
})

describe("widenPeriod", () => {
  it("grows to the union of the ranges staged so far", () => {
    const open = createOpenManifest({
      sessionId: "session-1",
      company: "Demo Pharma",
      mode: "opening",
      period: TEN_DAYS,
      updatedAt: AT,
    })

    const next = widenPeriod(open, { from: "2025-12-20", to: TEN_DAYS.to }, AT)

    expect(next.period).toEqual({ from: "2025-12-20", to: "2026-01-10" })
    expect(next.chunks[0]?.range).toEqual(next.period)
  })

  it("never narrows the period for a later, smaller range", () => {
    const manifest = build(1)
    const wide = widenPeriod(manifest, { from: "2025-12-01", to: "2026-02-01" }, AT)

    expect(widenPeriod(wide, TEN_DAYS, AT)).toBe(wide)
  })
})

describe("replaceChunkResult", () => {
  it("replaces a finished chunk while keeping how many attempts it took", () => {
    let manifest = build(1)
    const id = voucherIds(manifest)[0]!
    manifest = recordChunkResult(manifest, id, { status: "complete", recordsRead: 4 }, AT)
    manifest = recordChunkResult(manifest, id, { status: "complete", recordsRead: 9 }, AT)
    // `complete` is final: a second result for the same chunk changes nothing.
    expect(manifest.chunks.find((chunk) => chunk.id === id)?.recordsRead).toBe(4)

    const replaced = replaceChunkResult(manifest, id, { status: "complete", recordsRead: 9 }, AT)

    // The replacement counts as another attempt, but the first start is kept.
    expect(replaced.chunks.find((chunk) => chunk.id === id)).toMatchObject({
      status: "complete",
      recordsRead: 9,
      attempts: 2,
      startedAt: AT,
    })
  })
})

describe("parseTallyIsoDate", () => {
  it("accepts real calendar days", () => {
    expect(parseTallyIsoDate("2026-01-01")).toBe(Date.UTC(2026, 0, 1))
    expect(parseTallyIsoDate("2028-02-29")).toBe(Date.UTC(2028, 1, 29))
  })

  it("rejects dates that do not exist and malformed input", () => {
    expect(() => parseTallyIsoDate("2026-02-30")).toThrow("TALLY_DATE_INVALID")
    expect(() => parseTallyIsoDate("2026-13-01")).toThrow("TALLY_DATE_INVALID")
    expect(() => parseTallyIsoDate("2026-1-5")).toThrow("TALLY_DATE_INVALID")
    expect(() => parseTallyIsoDate("20260101")).toThrow("TALLY_DATE_INVALID")
  })
})

describe("splitPeriod", () => {
  it("covers the period without gaps or overlaps", () => {
    const ranges = splitPeriod(TEN_DAYS, 3)
    expect(ranges).toEqual([
      { from: "2026-01-01", to: "2026-01-04" },
      { from: "2026-01-05", to: "2026-01-07" },
      { from: "2026-01-08", to: "2026-01-10" },
    ])
    for (let index = 1; index < ranges.length; index += 1) {
      const previous = ranges[index - 1]
      const current = ranges[index]
      expect(parseTallyIsoDate(current.from)).toBe(parseTallyIsoDate(previous.to) + 86_400_000)
    }
  })

  it("keeps leap days and month boundaries intact", () => {
    expect(splitPeriod({ from: "2028-02-28", to: "2028-03-01" }, 3)).toEqual([
      { from: "2028-02-28", to: "2028-02-28" },
      { from: "2028-02-29", to: "2028-02-29" },
      { from: "2028-03-01", to: "2028-03-01" },
    ])
  })

  it("clamps more parts than days instead of emitting empty ranges", () => {
    const ranges = splitPeriod({ from: "2026-01-01", to: "2026-01-03" }, 10)
    expect(ranges).toHaveLength(3)
    expect(ranges.every((range) => range.from === range.to)).toBe(true)
  })

  it("returns one range for a single part and rejects an invalid count", () => {
    expect(splitPeriod(TEN_DAYS, 1)).toEqual([TEN_DAYS])
    expect(() => splitPeriod(TEN_DAYS, 0)).toThrow("TALLY_CHUNK_PARTS_INVALID")
    expect(() => splitPeriod(TEN_DAYS, 1.5)).toThrow("TALLY_CHUNK_PARTS_INVALID")
  })
})

describe("createManifest", () => {
  it("puts one masters chunk before the voucher ranges, all pending", () => {
    const manifest = build(2)
    expect(manifest.version).toBe(TALLY_MANIFEST_VERSION)
    expect(manifest.chunks[0]?.id).toBe(MASTERS_CHUNK_ID)
    expect(voucherIds(manifest)).toEqual([
      voucherChunkId({ from: "2026-01-01", to: "2026-01-05" }),
      voucherChunkId({ from: "2026-01-06", to: "2026-01-10" }),
    ])
    expect(manifest.chunks.every((chunk) => chunk.status === "pending")).toBe(true)
  })

  it("records the edition the bridge reported, and omits it when none was", () => {
    const withEdition = createManifest({
      sessionId: "session-1",
      company: "Demo Pharma",
      mode: "opening",
      period: TEN_DAYS,
      updatedAt: AT,
      edition: "erp9",
    })
    expect(withEdition.edition).toBe("erp9")
    expect("edition" in build(2)).toBe(false)
  })

  it("refuses to build a manifest without a session or a company", () => {
    expect(() =>
      createManifest({
        sessionId: " ",
        company: "Demo Pharma",
        mode: "opening",
        period: TEN_DAYS,
        updatedAt: AT,
      }),
    ).toThrow("TALLY_MANIFEST_SESSION_MISSING")
    expect(() =>
      createManifest({
        sessionId: "session-1",
        company: "",
        mode: "opening",
        period: TEN_DAYS,
        updatedAt: AT,
      }),
    ).toThrow("TALLY_MANIFEST_COMPANY_MISSING")
  })
})

describe("manifestProblems", () => {
  it("accepts a complete, contiguous session", () => {
    const done = completeAll(build(3))
    expect(manifestProblems(done)).toEqual([])
    expect(canApplyManifest(done).ok).toBe(true)
  })

  it("does not depend on the order chunks are stored in", () => {
    const done = completeAll(build(3))
    const shuffled = { ...done, chunks: [...done.chunks].reverse() }
    expect(manifestProblems(shuffled)).toEqual([])
  })

  it("blocks while any chunk is unfinished", () => {
    expect(codes(build(2))).toContain("TALLY_CHUNK_INCOMPLETE")
  })

  it("blocks a failed chunk and keeps the failure reason", () => {
    const manifest = build(2)
    const [firstVoucher] = voucherIds(manifest)
    const failed = recordChunkResult(
      manifest,
      firstVoucher ?? "",
      { status: "failed", error: "TALLY_BRIDGE_TIMEOUT" },
      AT,
    )
    const problems = manifestProblems(failed)
    expect(problems.map((entry) => entry.code)).toContain("TALLY_CHUNK_FAILED")
    expect(problems.find((entry) => entry.code === "TALLY_CHUNK_FAILED")?.message).toContain(
      "TALLY_BRIDGE_TIMEOUT",
    )
  })

  it("blocks a missing middle range", () => {
    const done = completeAll(build(3))
    const withoutMiddle = {
      ...done,
      chunks: done.chunks.filter((_, index) => index !== 2),
    }
    expect(codes(withoutMiddle)).toContain("TALLY_CHUNK_GAP")
  })

  it("blocks overlapping ranges", () => {
    const done = completeAll(build(3))
    const overlapping = {
      ...done,
      chunks: done.chunks.map((chunk, index) =>
        index === 3 ? { ...chunk, range: { from: "2026-01-07", to: "2026-01-10" } } : chunk,
      ),
    }
    expect(codes(overlapping)).toContain("TALLY_CHUNK_OVERLAP")
  })

  it("blocks a range outside the agreed period", () => {
    const done = completeAll(build(2))
    const widened = {
      ...done,
      chunks: done.chunks.map((chunk, index) =>
        index === 1 ? { ...chunk, range: { from: "2025-12-31", to: chunk.range.to } } : chunk,
      ),
    }
    expect(codes(widened)).toContain("TALLY_CHUNK_OUT_OF_RANGE")
  })

  it("blocks a duplicated chunk id", () => {
    const done = completeAll(build(2))
    const duplicated = { ...done, chunks: [...done.chunks, done.chunks[2]] }
    expect(codes(duplicated)).toContain("TALLY_CHUNK_DUPLICATE_ID")
  })

  it("blocks a session with no masters or more than one", () => {
    const done = completeAll(build(2))
    const noMasters = {
      ...done,
      chunks: done.chunks.filter((chunk) => chunk.kind !== "masters"),
    }
    expect(codes(noMasters)).toContain("TALLY_MASTERS_MISSING")

    const twoMasters = { ...done, chunks: [...done.chunks, done.chunks[0]] }
    expect(codes(twoMasters)).toContain("TALLY_MASTERS_DUPLICATE")
  })

  it("reports an unreadable period instead of throwing", () => {
    const broken = { ...build(1), period: { from: "2026-02-30", to: "2026-03-01" } }
    expect(codes(broken)).toContain("TALLY_PERIOD_INVALID")
  })

  it("blocks a manifest written by another version", () => {
    const done = completeAll(build(2))
    const unknown = {
      ...done,
      version: TALLY_MANIFEST_VERSION + 1,
    } as unknown as TallyMigrationManifest
    expect(codes(unknown)).toContain("TALLY_MANIFEST_VERSION")
  })
})

describe("voucherDatesOutsidePeriod", () => {
  it("accepts every date inside the range, boundaries included", () => {
    expect(
      voucherDatesOutsidePeriod(["2026-01-01", "2026-01-05", "2026-01-10"], TEN_DAYS),
    ).toEqual([])
  })

  it("returns each offending day once, in order", () => {
    expect(
      voucherDatesOutsidePeriod(
        ["2025-12-31", "2026-01-05", "2026-01-11", "2025-12-31", undefined],
        TEN_DAYS,
      ),
    ).toEqual(["2025-12-31", "2026-01-11"])
  })

  it("treats an unreadable date as outside rather than guessing", () => {
    expect(voucherDatesOutsidePeriod(["not-a-date"], TEN_DAYS)).toEqual(["not-a-date"])
  })
})

describe("isManifestLike", () => {
  it("accepts a manifest this module produced", () => {
    expect(isManifestLike(completeAll(build(2)))).toBe(true)
  })

  it("rejects anything the validators could throw on", () => {
    const done = completeAll(build(1))
    expect(isManifestLike(null)).toBe(false)
    expect(isManifestLike({ ...done, chunks: "nope" })).toBe(false)
    expect(isManifestLike({ ...done, sessionId: 7 })).toBe(false)
    expect(isManifestLike({ ...done, period: { from: "2026-01-01" } })).toBe(false)
    expect(isManifestLike({ ...done, chunks: [{ id: "x" }] })).toBe(false)
  })

  it("rejects a manifest that does not say where its period came from", () => {
    const done = completeAll(build(1))
    expect(isManifestLike({ ...done, periodSource: "guessed" })).toBe(false)
    expect(isManifestLike({ ...done, periodSource: undefined })).toBe(false)
  })

  it("rejects a chunk with an unknown reconciliation state", () => {
    const done = completeAll(build(1))
    const chunks = done.chunks.map((chunk) => ({ ...chunk, reconciliation: "probably" }))
    expect(isManifestLike({ ...done, chunks })).toBe(false)
  })

  it("accepts the recorded edition and rejects one it cannot name", () => {
    const done = completeAll(build(1))
    expect(isManifestLike({ ...done, edition: "prime" })).toBe(true)
    expect(isManifestLike({ ...done, edition: "erp9" })).toBe(true)
    expect(isManifestLike({ ...done, edition: "unknown" })).toBe(true)
    expect(isManifestLike({ ...done, edition: undefined })).toBe(true)
    expect(isManifestLike({ ...done, edition: "tally" })).toBe(false)
    expect(isManifestLike({ ...done, edition: 9 })).toBe(false)
  })

  it("refuses a version 1 manifest so it is re-previewed rather than trusted", () => {
    const legacy = { ...completeAll(build(1)), version: 1 } as unknown as TallyMigrationManifest
    expect(isManifestLike(legacy)).toBe(true)
    expect(manifestProblems(legacy).map((entry) => entry.code)).toContain("TALLY_MANIFEST_VERSION")
  })
})

describe("reconcileCounts", () => {
  it("is unverified without an independent count", () => {
    expect(reconcileCounts(120)).toBe("unverified")
  })

  it("verifies only an exact match", () => {
    expect(reconcileCounts(120, 120)).toBe("verified")
    expect(reconcileCounts(119, 120)).toBe("mismatch")
    expect(reconcileCounts(121, 120)).toBe("mismatch")
  })
})

describe("chunk evidence", () => {
  it("blocks a chunk whose independent count disagrees with what was read", () => {
    const manifest = build(1)
    const [chunkId] = voucherIds(manifest)
    const mismatched = recordChunkResult(
      manifest,
      chunkId ?? "",
      { status: "complete", recordsRead: 3, expectedRecords: 5 },
      AT,
    )

    expect(codes(mismatched)).toContain("TALLY_CHUNK_MISMATCH")
    expect(canApplyManifest(mismatched).ok).toBe(false)
  })

  it("accepts a chunk whose count matches, and marks it verified", () => {
    const manifest = build(1)
    const [chunkId] = voucherIds(manifest)
    const verified = recordChunkResult(
      recordChunkResult(manifest, MASTERS_CHUNK_ID, { status: "complete", recordsRead: 0, expectedRecords: 0 }, AT),
      chunkId ?? "",
      { status: "complete", recordsRead: 12, expectedRecords: 12 },
      AT,
    )

    expect(codes(verified)).toEqual([])
    expect(verified.chunks.every((chunk) => chunk.reconciliation === "verified")).toBe(true)
    expect(canApplyManifest(verified).ok).toBe(true)
  })

  it("discloses an unverified chunk without refusing it", () => {
    const done = completeAll(build(1))
    const check = canApplyManifest(done)

    expect(check.ok).toBe(true)
    expect(check.problems).toEqual([])
    expect(check.unverified.map((entry) => entry.code)).toEqual([
      "TALLY_CHUNK_UNVERIFIED",
      "TALLY_CHUNK_UNVERIFIED",
    ])
  })

  it("blocks a chunk whose recorded dates fall outside its own range", () => {
    const manifest = build(2)
    const [chunkId] = voucherIds(manifest)
    const outside = recordChunkResult(
      manifest,
      chunkId ?? "",
      { status: "complete", recordsRead: 1, firstDate: "2026-02-01", lastDate: "2026-02-01" },
      AT,
    )

    expect(codes(outside)).toContain("TALLY_CHUNK_DATES_OUTSIDE")
  })

  it("flags a manifest that does not say where its period came from", () => {
    const broken = { ...completeAll(build(1)), periodSource: "guessed" } as unknown as TallyMigrationManifest
    expect(codes(broken)).toContain("TALLY_PERIOD_SOURCE")
  })

  it("flags a manifest with no company", () => {
    const broken = { ...completeAll(build(1)), company: "  " }
    expect(codes(broken)).toContain("TALLY_MANIFEST_COMPANY")
  })
})

describe("dateSpan", () => {
  it("returns the earliest and latest readable day", () => {
    expect(dateSpan(["2026-01-05", "2026-01-01", "2026-01-09", undefined])).toEqual({
      firstDate: "2026-01-01",
      lastDate: "2026-01-09",
    })
  })

  it("ignores unreadable dates and returns nothing for an empty list", () => {
    expect(dateSpan(["not-a-date"])).toEqual({})
    expect(dateSpan([])).toEqual({})
  })
})

describe("recordChunkResult", () => {
  it("replaces the entry instead of appending a retry", () => {
    const manifest = build(1)
    const [chunkId] = voucherIds(manifest)
    const started = recordChunkResult(manifest, chunkId ?? "", { status: "running" }, AT)
    const failed = recordChunkResult(
      started,
      chunkId ?? "",
      { status: "failed", error: "TIMEOUT" },
      AT,
    )
    const complete = recordChunkResult(
      failed,
      chunkId ?? "",
      { status: "complete", recordsRead: 42, bytes: 2048, checksum: "abc123" },
      AT,
    )

    expect(complete.chunks).toHaveLength(manifest.chunks.length)
    const chunk = complete.chunks.find((entry) => entry.id === chunkId)
    expect(chunk).toMatchObject({
      status: "complete",
      attempts: 2,
      recordsRead: 42,
      bytes: 2048,
      checksum: "abc123",
      finishedAt: AT,
      error: undefined,
    })
  })

  it("treats a replayed completion as a no-op", () => {
    const done = completeAll(build(1))
    const replay = recordChunkResult(done, MASTERS_CHUNK_ID, { status: "complete" }, AT)
    expect(replay).toBe(done)
  })

  it("never backfills the extraction count from the parsed count", () => {
    const done = recordChunkResult(
      build(1),
      MASTERS_CHUNK_ID,
      { status: "complete", recordsRead: 9 },
      AT,
    )
    expect(done.chunks[0]?.extractedRecords).toBeUndefined()
    expect(isManifestLike(done)).toBe(true)
  })

  it("stamps the start when a chunk completes without a running step", () => {
    const done = recordChunkResult(build(1), MASTERS_CHUNK_ID, { status: "complete" }, AT)
    expect(done.chunks[0]?.startedAt).toBe(AT)
  })

  it("refuses an unknown chunk id", () => {
    expect(() =>
      recordChunkResult(build(1), "vouchers:1999-01-01:1999-01-31", { status: "running" }, AT),
    ).toThrow("TALLY_CHUNK_UNKNOWN")
  })
})

describe("nextChunkToRun", () => {
  it("reads masters before any voucher range", () => {
    const manifest = build(2)
    expect(nextChunkToRun(manifest)?.id).toBe(MASTERS_CHUNK_ID)
  })

  it("then works through the ranges in date order, even when stored shuffled", () => {
    const manifest = build(3)
    const mastersDone = recordChunkResult(manifest, MASTERS_CHUNK_ID, { status: "complete" }, AT)
    const [first, second, third] = voucherIds(mastersDone)
    const withSecondDone = recordChunkResult(
      mastersDone,
      second ?? "",
      { status: "complete" },
      AT,
    )
    const shuffled = { ...withSecondDone, chunks: [...withSecondDone.chunks].reverse() }

    expect(nextChunkToRun(shuffled)?.id).toBe(first)
    const bothDone = recordChunkResult(shuffled, first ?? "", { status: "complete" }, AT)
    expect(nextChunkToRun(bothDone)?.id).toBe(third)
  })

  it("returns a failed range so the migration can retry it", () => {
    const manifest = build(3)
    const mastersDone = recordChunkResult(manifest, MASTERS_CHUNK_ID, { status: "complete" }, AT)
    const [first, second] = voucherIds(mastersDone)
    const failed = recordChunkResult(mastersDone, second ?? "", { status: "failed" }, AT)
    expect(nextChunkToRun(failed)?.id).toBe(first)

    const firstDone = recordChunkResult(failed, first ?? "", { status: "complete" }, AT)
    expect(nextChunkToRun(firstDone)?.id).toBe(second)
  })

  it("returns nothing once every chunk is complete", () => {
    expect(nextChunkToRun(completeAll(build(2)))).toBeUndefined()
  })
})

describe("chunk finality and splitting", () => {
  it("never demotes a completed chunk when a duplicate result arrives", () => {
    let manifest = build(1)
    const chunkId = manifest.chunks[1]!.id
    manifest = recordChunkResult(manifest, chunkId, { status: "complete", recordsRead: 5 }, AT)

    const lateFailure = recordChunkResult(manifest, chunkId, { status: "failed", error: "late" }, AT)
    const lateRunning = recordChunkResult(manifest, chunkId, { status: "running" }, AT)

    expect(lateFailure.chunks[1]?.status).toBe("complete")
    expect(lateFailure.chunks[1]?.recordsRead).toBe(5)
    expect(lateRunning.chunks[1]?.status).toBe("complete")
    expect(lateRunning.chunks[1]?.attempts).toBe(manifest.chunks[1]?.attempts)
  })

  it("halves an even and an odd range without a gap or an overlap", () => {
    const even = halveRange({ from: "2026-01-01", to: "2026-01-10" })
    expect(even).toEqual([
      { from: "2026-01-01", to: "2026-01-05" },
      { from: "2026-01-06", to: "2026-01-10" },
    ])

    const odd = halveRange({ from: "2026-01-01", to: "2026-01-11" })
    expect(odd).toEqual([
      { from: "2026-01-01", to: "2026-01-06" },
      { from: "2026-01-07", to: "2026-01-11" },
    ])
    expect(odd[0].to < odd[1].from).toBe(true)
  })

  it("refuses to halve a single day", () => {
    expect(() => halveRange({ from: "2026-01-01", to: "2026-01-01" })).toThrow(
      "TALLY_CHUNK_RANGE_MINIMAL",
    )
  })

  it("replaces the split chunk's id so it cannot be read twice", () => {
    const manifest = build(1)
    const original = manifest.chunks[1]!
    const halves = halveRange(original.range)

    const split = splitChunk(manifest, original.id, halves)

    expect(split.chunks.map((chunk) => chunk.id)).toEqual([
      MASTERS_CHUNK_ID,
      voucherChunkId(halves[0]),
      voucherChunkId(halves[1]),
    ])
    expect(split.chunks.some((chunk) => chunk.id === original.id)).toBe(false)
    expect(split.chunks.filter((chunk) => chunk.kind === "vouchers").every((chunk) => chunk.status === "pending")).toBe(true)
    // The manifest still describes exactly the same, fully covered period; the
    // halves are pending, which is a gap in the run, not in the ranges.
    expect(
      manifestProblems(split).filter((problem) => problem.code !== "TALLY_CHUNK_INCOMPLETE"),
    ).toEqual([])
  })

  it("refuses a split that would duplicate an existing range", () => {
    const manifest = build(2)
    const [first, second] = manifest.chunks.slice(1)
    expect(() => splitChunk(manifest, first!.id, [first!.range, second!.range])).toThrow(
      "TALLY_CHUNK_DUPLICATE_ID",
    )
  })

  it("refuses to split the masters chunk", () => {
    const manifest = build(1)
    expect(() =>
      splitChunk(manifest, MASTERS_CHUNK_ID, [
        { from: "2026-01-01", to: "2026-01-05" },
        { from: "2026-01-06", to: "2026-01-10" },
      ]),
    ).toThrow("TALLY_CHUNK_NOT_SPLITTABLE")
  })

  it("retries a failed chunk only while attempts remain", () => {
    let manifest = build(1)
    const chunkId = manifest.chunks[1]!.id
    manifest = recordChunkResult(manifest, chunkId, { status: "failed", error: "busy" }, AT)

    expect(canRetryChunk(manifest.chunks[1]!, 3)).toBe(true)
    expect(canRetryChunk({ ...manifest.chunks[1]!, attempts: 3 }, 3)).toBe(false)
    expect(canRetryChunk(manifest.chunks[0]!, 3)).toBe(false)
  })

  it("reports a gap where a chunk failed instead of a period that looks covered", () => {
    let manifest = build(3)
    const [first, second, third] = manifest.chunks.slice(1)
    manifest = recordChunkResult(manifest, MASTERS_CHUNK_ID, { status: "complete", recordsRead: 7 }, AT)
    manifest = recordChunkResult(manifest, first!.id, { status: "complete", recordsRead: 2 }, AT)
    manifest = recordChunkResult(manifest, second!.id, { status: "failed", error: "timeout" }, AT)
    manifest = recordChunkResult(manifest, third!.id, { status: "complete", recordsRead: 3 }, AT)

    const summary = summariseExtraction(manifest)

    expect(summary.completeAll).toBe(false)
    expect(summary.complete).toBe(3)
    expect(summary.failed).toBe(1)
    expect(summary.gaps).toEqual([{ after: first!.range.to, before: third!.range.from }])
    expect(summary.coveredFrom).toBe(first!.range.from)
    expect(summary.coveredTo).toBe(third!.range.to)
    // The failed transition counts as the chunk's first attempt.
    expect(summary.failures).toEqual([{ id: second!.id, attempts: 1, error: "timeout" }])
    // Records are counted from completed chunks only, never from the plan.
    expect(summary.recordsRead).toBe(12)
  })

  it("does not claim an extraction count nobody produced", () => {
    let manifest = build(1)
    manifest = recordChunkResult(manifest, manifest.chunks[1]!.id, { status: "complete", recordsRead: 4 }, AT)

    expect(summariseExtraction(manifest).recordsExtracted).toBeNull()
  })
})
