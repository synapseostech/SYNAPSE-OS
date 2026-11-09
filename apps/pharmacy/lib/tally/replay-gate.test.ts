import { describe, expect, it } from "vitest"
import {
  REPLAY_REASON_MIN,
  evaluateReplayGate,
  parseReplayAcknowledgement,
  replayBlockers,
  replayFindingKey,
} from "./replay-gate"
import type { TallyReplayFinding } from "@synapse/db/tally-replay"
import type { TallyReplayTarget } from "./types"

const PREPARED_AT = "2026-01-01T00:00:00.000Z"
const ROW_KEY = "reconcile:stock_item:Panadol 500mg"
const REASON = "Tally's stock summary was taken before the last return was posted."

function target(overrides: Partial<TallyReplayTarget> = {}): TallyReplayTarget {
  return {
    preparedAt: PREPARED_AT,
    conversionDate: "2026-01-01",
    cutoffDate: "2026-01-10",
    ordering: "date-then-export-order",
    eventCount: 3,
    movementCount: 2,
    perDay: [{ date: "2026-01-05", events: 2, movements: 2, kinds: { purchase: 1, sales: 1 } }],
    reconciliation: [
      {
        scope: "stock_item",
        key: "Panadol 500mg",
        expected: 90,
        actual: 80,
        difference: -10,
        status: "difference",
        tolerance: 0,
        sourceIds: ["v-1"],
      },
      {
        scope: "account",
        key: "Cash",
        expected: 100,
        actual: 100,
        difference: 0,
        status: "match",
        tolerance: 0.01,
        sourceIds: [],
      },
      {
        scope: "stock_item",
        key: "Amoxil 250mg (value)",
        expected: null,
        actual: 5,
        difference: null,
        status: "not-available",
        tolerance: 0.01,
        sourceIds: [],
      },
    ],
    totals: { match: 1, difference: 1, notAvailable: 1 },
    blocking: 1,
    warnings: 0,
    findings: [],
    simulated: {
      accounts: {},
      items: [],
      sourceIdsByItem: {},
      sourceIdsByAccount: {},
      eventCount: 3,
    },
    ...overrides,
  }
}

function saved(
  items: Array<{ key: string; reason: string }>,
  overrides: Record<string, unknown> = {},
) {
  return {
    preparedAt: PREPARED_AT,
    sequenceConfirmed: true,
    acknowledgedAt: "2026-01-01T01:00:00.000Z",
    acknowledgedBy: "user-1",
    items,
    ...overrides,
  }
}

function finding(overrides: Partial<TallyReplayFinding> = {}): TallyReplayFinding {
  return {
    code: "REPLAY_NEGATIVE_STOCK",
    severity: "blocking",
    date: "2026-01-07",
    sourceId: "v-9",
    movementId: "v-9:L0:B0",
    stockItemName: "Panadol 500mg",
    quantityBefore: 2,
    quantityAfter: -3,
    message: "Stock went negative on a sale.",
    ...overrides,
  }
}

describe("replayBlockers", () => {
  it("names a real difference and no figure the export does not carry", () => {
    const blockers = replayBlockers(target())

    expect(blockers).toHaveLength(1)
    expect(blockers[0]).toMatchObject({
      key: ROW_KEY,
      kind: "difference",
      expected: 90,
      actual: 80,
      difference: -10,
    })
    // A row Tally states no figure for is never treated as agreement.
    expect(blockers.some((blocker) => blocker.key.includes("Amoxil"))).toBe(false)
  })

  it("names a blocking finding at the movement that caused it", () => {
    const blockers = replayBlockers(target({ findings: [finding()] }))

    expect(blockers.map((blocker) => blocker.key)).toContain(replayFindingKey(finding(), 0))
    expect(blockers.find((blocker) => blocker.kind === "finding")).toMatchObject({
      label: "Panadol 500mg · 2026-01-07",
      actual: -3,
    })
  })

  it("leaves a warning finding out of the blockers", () => {
    const blockers = replayBlockers(
      target({ findings: [finding({ severity: "warning", code: "REPLAY_EXPIRED_BATCH_CONSUMED" })] }),
    )

    expect(blockers).toHaveLength(1)
  })
})

describe("evaluateReplayGate", () => {
  it("cannot apply a replay nobody has reviewed", () => {
    const gate = evaluateReplayGate(target(), undefined)

    expect(gate).toMatchObject({ sequenceConfirmed: false, canApply: false })
    expect(gate.missing).toHaveLength(1)
  })

  it("cannot apply until the sequence is confirmed", () => {
    const gate = evaluateReplayGate(target(), saved([{ key: ROW_KEY, reason: REASON }], {
      sequenceConfirmed: false,
    }))

    expect(gate.sequenceConfirmed).toBe(false)
    expect(gate.missing).toHaveLength(0)
    expect(gate.canApply).toBe(false)
  })

  it("counts a reason shorter than the floor as no answer at all", () => {
    const gate = evaluateReplayGate(
      target(),
      saved([{ key: ROW_KEY, reason: "x".repeat(REPLAY_REASON_MIN - 1) }]),
    )

    expect(gate.acknowledged).toHaveLength(0)
    expect(gate.missing.map((blocker) => blocker.key)).toEqual([ROW_KEY])
    expect(gate.canApply).toBe(false)
  })

  it("accepts a confirmed sequence with a reason for every difference", () => {
    const gate = evaluateReplayGate(target(), saved([{ key: ROW_KEY, reason: REASON }]))

    expect(gate.canApply).toBe(true)
    expect(gate.missing).toHaveLength(0)
    expect(gate.acknowledged).toEqual([{ key: ROW_KEY, reason: REASON }])
  })

  it("ignores an answer given for another preview", () => {
    const gate = evaluateReplayGate(
      target(),
      saved([{ key: ROW_KEY, reason: REASON }], { preparedAt: "2025-12-31T00:00:00.000Z" }),
    )

    expect(gate.canApply).toBe(false)
    expect(gate.sequenceConfirmed).toBe(false)
    expect(gate.missing).toHaveLength(1)
  })

  it("refuses, rather than ignores, an answer for a key this replay does not carry", () => {
    const gate = evaluateReplayGate(
      target(),
      saved([
        { key: ROW_KEY, reason: REASON },
        { key: "reconcile:account:Bank", reason: REASON },
      ]),
    )

    expect(gate.unknown).toEqual(["reconcile:account:Bank"])
    expect(gate.acknowledged.map((item) => item.key)).toEqual([ROW_KEY])
  })

  it("takes the first of two answers for the same difference", () => {
    const gate = evaluateReplayGate(
      target(),
      saved([
        { key: ROW_KEY, reason: REASON },
        { key: ROW_KEY, reason: "A second, different explanation of the same row." },
      ]),
    )

    expect(gate.acknowledged).toHaveLength(1)
    expect(gate.acknowledged[0]?.reason).toBe(REASON)
  })
})

describe("parseReplayAcknowledgement", () => {
  it("refuses an acknowledgement that does not confirm the sequence", () => {
    const parsed = parseReplayAcknowledgement({ sequenceConfirmed: false, items: [] })

    expect(parsed).toMatchObject({ ok: false, code: "TALLY_REPLAY_SEQUENCE_UNCONFIRMED" })
  })

  it("refuses a reason shorter than the floor", () => {
    const parsed = parseReplayAcknowledgement({
      sequenceConfirmed: true,
      items: [{ key: ROW_KEY, reason: "nope" }],
    })

    expect(parsed).toMatchObject({ ok: false, code: "TALLY_REPLAY_REASON_TOO_SHORT" })
  })

  it("refuses the same difference answered twice", () => {
    const parsed = parseReplayAcknowledgement({
      sequenceConfirmed: true,
      items: [
        { key: ROW_KEY, reason: REASON },
        { key: ROW_KEY, reason: REASON },
      ],
    })

    expect(parsed).toMatchObject({ ok: false, code: "TALLY_REPLAY_ACK_DUPLICATE" })
  })

  it("trims each reason and returns what it accepted", () => {
    const parsed = parseReplayAcknowledgement({
      sequenceConfirmed: true,
      items: [{ key: ROW_KEY, reason: `  ${REASON}  ` }],
    })

    expect(parsed).toEqual({
      ok: true,
      sequenceConfirmed: true,
      items: [{ key: ROW_KEY, reason: REASON }],
    })
  })
})
