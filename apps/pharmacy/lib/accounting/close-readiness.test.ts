import { describe, expect, it } from "vitest"

import {
  assessCloseReadiness,
  closeSnapshot,
  tillBlocksPeriodClose,
  type CloseReadinessFacts,
} from "./close-readiness"

const facts = (overrides: Partial<CloseReadinessFacts> = {}): CloseReadinessFacts => ({
  periodStart: "2026-09-01",
  periodEnd: "2026-09-30",
  today: "2026-10-25",
  tillSessions: [],
  unmatchedBankLines: 0,
  unmatchedBankValue: 0,
  journalEntries: 12,
  journalDebitTotal: 4_500_000,
  salesCount: 40,
  salesTotal: 4_200_000,
  cashSalesTotal: 2_100_000,
  ...overrides,
})

const codes = (result: ReturnType<typeof assessCloseReadiness>) => result.issues.map((issue) => issue.code)

describe("tillBlocksPeriodClose", () => {
  it("blocks on a till still open from inside the period", () => {
    expect(tillBlocksPeriodClose({ status: "open", openedOn: "2026-09-30", closedOn: null }, "2026-09-30")).toBe(true)
  })

  it("blocks on a till opened before the period and never closed", () => {
    expect(tillBlocksPeriodClose({ status: "active", openedOn: "2026-08-14", closedOn: null }, "2026-09-30")).toBe(true)
  })

  it("does not block on a till opened after the period end", () => {
    expect(tillBlocksPeriodClose({ status: "open", openedOn: "2026-10-01", closedOn: null }, "2026-09-30")).toBe(false)
  })

  it("does not block on a closed session, whatever its dates", () => {
    expect(tillBlocksPeriodClose({ status: "closed", openedOn: "2026-09-30", closedOn: "2026-09-30" }, "2026-09-30")).toBe(
      false,
    )
  })

  it("does not block on a session marked open but carrying a close date", () => {
    expect(tillBlocksPeriodClose({ status: "open", openedOn: "2026-09-30", closedOn: "2026-09-30" }, "2026-09-30")).toBe(
      false,
    )
  })
})

describe("assessCloseReadiness", () => {
  it("is ready when the period is past and every till is closed", () => {
    const result = assessCloseReadiness(
      facts({ tillSessions: [{ status: "closed", openedOn: "2026-09-12", closedOn: "2026-09-12" }] }),
    )
    expect(result.ready).toBe(true)
    expect(result.blockers).toEqual([])
  })

  it("blocks while a till is still open, and says what happens if you close anyway", () => {
    const result = assessCloseReadiness(
      facts({
        tillSessions: [
          { status: "open", openedOn: "2026-09-30", closedOn: null },
          { status: "closed", openedOn: "2026-09-12", closedOn: "2026-09-12" },
        ],
      }),
    )
    expect(result.ready).toBe(false)
    const issue = result.blockers.find((row) => row.code === "OPEN_TILL_SESSIONS")
    expect(issue?.value).toBe(1)
    expect(issue?.message).toContain("fail to close")
  })

  it("does not count tills from a later period as blockers", () => {
    const result = assessCloseReadiness(
      facts({ tillSessions: [{ status: "open", openedOn: "2026-10-02", closedOn: null }] }),
    )
    expect(result.ready).toBe(true)
  })

  it("blocks a period that has not finished", () => {
    const result = assessCloseReadiness(facts({ periodEnd: "2026-10-31" }))
    expect(result.ready).toBe(false)
    expect(codes(result)).toContain("PERIOD_NOT_ENDED")
  })

  it("treats the current day as unfinished", () => {
    const result = assessCloseReadiness(facts({ periodEnd: "2026-10-25", today: "2026-10-25" }))
    expect(result.ready).toBe(false)
    expect(codes(result)).toContain("PERIOD_NOT_ENDED")
  })

  it("blocks an inverted or empty range", () => {
    const inverted = assessCloseReadiness(facts({ periodStart: "2026-09-30", periodEnd: "2026-09-01" }))
    expect(inverted.ready).toBe(false)
    expect(codes(inverted)).toContain("PERIOD_RANGE_INVALID")
    expect(inverted.warnings).toEqual([])
  })

  it("warns about unmatched bank lines without blocking the close", () => {
    const result = assessCloseReadiness(facts({ unmatchedBankLines: 3, unmatchedBankValue: 780_000 }))
    expect(result.ready).toBe(true)
    expect(result.warnings.map((row) => row.code)).toContain("UNMATCHED_BANK_LINES")
    expect(result.warnings[0]?.message).toContain("UGX 780,000")
  })

  it("uses the singular when one line is unmatched", () => {
    const result = assessCloseReadiness(facts({ unmatchedBankLines: 1, unmatchedBankValue: 50_000 }))
    expect(result.warnings[0]?.message).toContain("1 bank statement line")
    expect(result.warnings[0]?.message).toContain("is not matched")
  })

  it("warns about an empty period so nobody locks one by accident", () => {
    const result = assessCloseReadiness(facts({ journalEntries: 0, salesCount: 0, salesTotal: 0 }))
    expect(result.ready).toBe(true)
    expect(result.warnings.map((row) => row.code)).toContain("NO_ACTIVITY")
  })

  it("reports every problem at once rather than one at a time", () => {
    const result = assessCloseReadiness(
      facts({
        periodEnd: "2026-12-31",
        tillSessions: [{ status: "open", openedOn: "2026-12-30", closedOn: null }],
        unmatchedBankLines: 2,
        unmatchedBankValue: 100_000,
      }),
    )
    expect(result.issues.map((row) => row.code)).toEqual([
      "PERIOD_NOT_ENDED",
      "OPEN_TILL_SESSIONS",
      "UNMATCHED_BANK_LINES",
    ])
    expect(result.blockers).toHaveLength(2)
    expect(result.warnings).toHaveLength(1)
  })
})

describe("closeSnapshot", () => {
  it("records what the period looked like when it was signed off", () => {
    const snapshot = closeSnapshot(
      facts({
        tillSessions: [
          { status: "closed", openedOn: "2026-09-01", closedOn: "2026-09-01" },
          { status: "open", openedOn: "2026-09-30", closedOn: null },
        ],
        unmatchedBankLines: 1,
        unmatchedBankValue: 25_000,
      }),
    )

    expect(snapshot).toEqual({
      periodStart: "2026-09-01",
      periodEnd: "2026-09-30",
      assessedOn: "2026-10-25",
      openTillSessions: 1,
      journalEntries: 12,
      journalDebitTotal: 4_500_000,
      salesCount: 40,
      salesTotal: 4_200_000,
      cashSalesTotal: 2_100_000,
      unmatchedBankLines: 1,
      unmatchedBankValue: 25_000,
    })
  })

  it("records facts only, so the stored evidence cannot drift from the data", () => {
    const input = facts({ unmatchedBankLines: 4, unmatchedBankValue: 1_000 })
    const snapshot = closeSnapshot(input)

    // Warnings are derived at read time from these numbers. Persisting the
    // rendered message would freeze copy that later changes.
    expect(Object.keys(snapshot)).not.toContain("warnings")
    expect(snapshot.unmatchedBankLines).toBe(input.unmatchedBankLines)
  })
})
