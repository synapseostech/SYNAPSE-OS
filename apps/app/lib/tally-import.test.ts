import assert from "node:assert/strict"
import { describe, it } from "node:test"
import {
  alreadyStaged,
  chunksForDay,
  eventsForDay,
  isNetworkFailure,
  kindFromFileName,
  needsStaging,
  orderForStaging,
  periodFromFileName,
  progressThrough,
  replayAcknowledgement,
  replayReasonAnswered,
  tallyContentType,
  unansweredBlockers,
  withNetworkRetry,
  type TallyPlaybackEvent,
  type TallyPlaybackIndex,
} from "./tally-import.ts"

describe("file names", () => {
  it("reads the export script's own range", () => {
    assert.deepEqual(periodFromFileName("3-daybook-20250101-20251231.xml"), {
      from: "2025-01-01",
      to: "2025-12-31",
    })
  })

  it("reads Tally's month export as the whole calendar month", () => {
    assert.deepEqual(periodFromFileName("2024-02-full.xml"), { from: "2024-02-01", to: "2024-02-29" })
  })

  it("refuses a backwards or impossible range", () => {
    assert.equal(periodFromFileName("daybook-20251231-20250101.xml"), undefined)
    assert.equal(periodFromFileName("2025-13-full.xml"), undefined)
    assert.equal(periodFromFileName("masters.xml"), undefined)
  })

  it("names masters and day books, and leaves the rest to the server", () => {
    assert.equal(kindFromFileName("1-Masters.xml"), "masters")
    assert.equal(kindFromFileName("3-daybook-20250101-20250131.xml"), "vouchers")
    assert.equal(kindFromFileName("2025-10-full.xml"), undefined)
  })

  it("accepts every format the server does, and only those", () => {
    assert.equal(tallyContentType("export.XML"), "application/xml")
    assert.equal(tallyContentType("package.zip"), "application/zip")
    assert.equal(tallyContentType("legacy.xls"), "application/octet-stream")
    assert.equal(tallyContentType("notes.pdf"), null)
  })
})

describe("staging", () => {
  it("puts a package first so loose files join the company it names", () => {
    const ordered = orderForStaging([{ name: "a.xml" }, { name: "pkg.zip" }, { name: "b.xml" }])
    assert.deepEqual(ordered.map((entry) => entry.name), ["pkg.zip", "a.xml", "b.xml"])
  })

  it("skips a file the session already holds, by name and size", () => {
    const held = [{ fileName: "1-masters.xml", bytes: 120 }]
    assert.equal(alreadyStaged({ name: "1-masters.xml", size: 120 }, held), true)
    assert.equal(alreadyStaged({ name: "1-masters.xml", size: 121 }, held), false)
    assert.equal(alreadyStaged({ name: "1-masters.xml" }, held), false)
  })

  it("reads one file directly and stages anything more", () => {
    assert.equal(needsStaging(1, 0), false)
    assert.equal(needsStaging(2, 0), true)
    assert.equal(needsStaging(1, 3), true)
  })
})

describe("replay acknowledgement", () => {
  it("holds the server's reason length", () => {
    assert.equal(replayReasonAnswered("too short"), true)
    assert.equal(replayReasonAnswered("  short "), false)
    assert.equal(replayReasonAnswered("x".repeat(501)), false)
  })

  it("submits only usable reasons, trimmed", () => {
    assert.deepEqual(replayAcknowledgement(true, { a: "  counted at the shelf  ", b: "no" }), {
      sequenceConfirmed: true,
      items: [{ key: "a", reason: "counted at the shelf" }],
    })
  })

  it("counts blockers still without a reason", () => {
    assert.equal(unansweredBlockers([{ key: "a" }, { key: "b" }], { a: "accepted by the accountant" }), 1)
  })
})

describe("network retry", () => {
  it("retries a dropped connection, then succeeds", async () => {
    let calls = 0
    const result = await withNetworkRetry(
      async () => {
        calls += 1
        if (calls < 3) throw new Error("Network error. Check your connection and try again.")
        return "ok"
      },
      [0, 0, 0],
      async () => undefined,
    )
    assert.equal(result, "ok")
    assert.equal(calls, 3)
  })

  it("never repeats a server's answer", async () => {
    const refusal = Object.assign(new Error("Network error"), { status: 409 })
    assert.equal(isNetworkFailure(refusal), false)
    let calls = 0
    await assert.rejects(
      withNetworkRetry(
        async () => {
          calls += 1
          throw refusal
        },
        [0],
        async () => undefined,
      ),
    )
    assert.equal(calls, 1)
  })
})

describe("playback", () => {
  const index: TallyPlaybackIndex = {
    mode: "replay",
    firstDate: "2025-01-01",
    lastDate: "2025-01-03",
    eventCount: 6,
    movementCount: 4,
    chunkCount: 3,
    chunkSize: 2,
    days: [
      { date: "2025-01-01", events: 1, movements: 0, firstChunk: 0 },
      { date: "2025-01-02", events: 3, movements: 3, firstChunk: 0 },
      { date: "2025-01-03", events: 2, movements: 1, firstChunk: 2 },
    ],
  }
  const event = (id: string, date: string): TallyPlaybackEvent => ({
    id,
    date,
    type: "voucher",
    kind: "sale",
    description: id,
    debit: 1,
    credit: 1,
    lineCount: 2,
    stock: [],
    movements: 0,
  })

  it("loads a day from its first chunk to the next day's", () => {
    assert.deepEqual(chunksForDay(index, 1), [0, 1, 2])
    assert.deepEqual(chunksForDay(index, 2), [2])
    assert.deepEqual(chunksForDay(index, 9), [])
  })

  it("shows only the chosen day's events, in order", () => {
    const cache = new Map([
      [0, [event("o", "2025-01-01"), event("s1", "2025-01-02")]],
      [1, [event("s2", "2025-01-02"), event("s3", "2025-01-02")]],
      [2, [event("p1", "2025-01-03"), event("p2", "2025-01-03")]],
    ])
    assert.deepEqual(eventsForDay(index, 1, cache).map((entry) => entry.id), ["s1", "s2", "s3"])
  })

  it("counts how far through the history a day sits", () => {
    assert.deepEqual(progressThrough(index, 1), { entries: 4, ratio: 4 / 6 })
    assert.deepEqual(progressThrough(index, 2), { entries: 6, ratio: 1 })
  })
})
