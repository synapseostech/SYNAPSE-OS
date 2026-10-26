import { describe, expect, it } from "vitest"
import { ageingBucket, applySettlements, daysBetween, summariseAgeing } from "./ageing"

describe("ageingBucket", () => {
  it("puts what is not yet due, and today, in the current bucket", () => {
    expect(ageingBucket(-12)).toBe("current")
    expect(ageingBucket(0)).toBe("current")
  })

  it("uses inclusive band edges", () => {
    expect(ageingBucket(1)).toBe("d1_30")
    expect(ageingBucket(30)).toBe("d1_30")
    expect(ageingBucket(31)).toBe("d31_60")
    expect(ageingBucket(60)).toBe("d31_60")
    expect(ageingBucket(61)).toBe("d61_90")
    expect(ageingBucket(90)).toBe("d61_90")
    expect(ageingBucket(91)).toBe("d90_plus")
  })
})

describe("daysBetween", () => {
  it("counts whole calendar days across a month end", () => {
    expect(daysBetween("2026-01-31", "2026-02-01")).toBe(1)
    expect(daysBetween("2024-02-28", "2024-03-01")).toBe(2)
  })

  it("does not drift with a daylight-saving change", () => {
    expect(daysBetween("2026-03-28", "2026-03-30")).toBe(2)
  })
})

describe("applySettlements", () => {
  const invoices = [
    { id: "later", amount: 300, dueDate: "2026-03-01" },
    { id: "earlier", amount: 200, dueDate: "2026-02-01" },
    { id: "oldest", amount: 100, dueDate: "2026-01-01" },
  ]

  it("settles the oldest invoice first", () => {
    expect(applySettlements(invoices, 150).map((invoice) => [invoice.id, invoice.outstanding])).toEqual([
      ["earlier", 150],
      ["later", 300],
    ])
  })

  it("drops fully settled invoices and leaves nothing outstanding", () => {
    expect(applySettlements(invoices, 600)).toEqual([])
  })

  it("ignores a settlement larger than what is owed", () => {
    expect(applySettlements([{ id: "one", amount: 50, dueDate: "2026-01-01" }], 999)).toEqual([])
  })

  it("treats a negative settlement as none", () => {
    expect(applySettlements([{ id: "one", amount: 50, dueDate: "2026-01-01" }], -10)).toEqual([
      { id: "one", amount: 50, dueDate: "2026-01-01", outstanding: 50 },
    ])
  })
})

describe("summariseAgeing", () => {
  it("totals each bucket and sorts the oldest first", () => {
    const summary = summariseAgeing([
      { partyName: "Test Party A", reference: "INV-2", date: "2026-02-01", dueDate: "2026-03-03", amount: 400, asOf: "2026-04-02" },
      { partyName: "Test Party B", reference: "INV-1", date: "2026-01-01", dueDate: "2026-01-31", amount: 100, asOf: "2026-04-02" },
      { partyName: "Test Party C", reference: "INV-3", date: "2026-04-01", dueDate: "2026-04-20", amount: 50, asOf: "2026-04-02" },
    ])

    expect(summary.buckets).toEqual({
      current: 50,
      d1_30: 400,
      d31_60: 0,
      d61_90: 100,
      d90_plus: 0,
    })
    expect(summary.total).toBe(550)
    expect(summary.rows.map((row) => row.reference)).toEqual(["INV-1", "INV-2", "INV-3"])
    expect(summary.rows[0]).toMatchObject({ daysOverdue: 61, bucket: "d61_90" })
  })

  it("rounds each line to cents before totalling", () => {
    const summary = summariseAgeing([
      { partyName: "Test Party A", reference: "INV-1", date: "2026-01-01", dueDate: "2026-01-01", amount: 10.005, asOf: "2026-01-02" },
    ])
    expect(summary.total).toBe(10.01)
  })
})
