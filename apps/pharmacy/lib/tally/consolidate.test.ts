import { describe, expect, it } from "vitest"
import type {
  TallyLedger,
  TallyLedgerLine,
  TallyVoucher,
  TallyXmlDocument,
} from "@synapse/db/tally-xml-rows"
import { consolidateTallyParts, TallyConsolidationError, tallyVoucherKey } from "./consolidate"

const period = { from: "2026-01-01", to: "2026-01-10" }

function ledger(overrides: Partial<TallyLedger> & { name: string }): TallyLedger {
  return { isBillWise: false, bills: [], ...overrides }
}

function line(amount: number, ledgerName = "Sales"): TallyLedgerLine {
  return {
    ledgerName,
    amount,
    side: amount < 0 ? "credit" : "debit",
    isParty: false,
    bills: [],
  }
}

function voucher(overrides: Partial<TallyVoucher> & { type: string }): TallyVoucher {
  return { isCancelled: false, ledgerLines: [], inventoryLines: [], ...overrides }
}

function document(overrides: Partial<TallyXmlDocument> = {}): TallyXmlDocument {
  return {
    company: "Test Pharmacy",
    financialPeriod: period,
    groups: [],
    ledgers: [],
    stockGroups: [],
    stockItems: [],
    units: [],
    godowns: [],
    vouchers: [],
    warnings: [],
    ...overrides,
  }
}

describe("consolidating chunk documents", () => {
  it("merges the masters of every part and keeps one copy of a repeated record", () => {
    const masters = document({
      ledgers: [ledger({ guid: "g-1", name: "Cash" }), ledger({ guid: "g-2", name: "Sales" })],
    })
    // The same masters arrive again in the first voucher range.
    const first = document({
      ledgers: [ledger({ guid: "g-1", name: "Cash" }), ledger({ guid: "g-3", name: "Debtors" })],
    })

    const { report } = consolidateTallyParts([masters, first], { period })

    expect(report.masters.ledgers).toBe(3)
    expect(report.masters.duplicates).toBe(1)
    expect(report.masters.conflicts).toBe(0)
    expect(report.masters.total).toBe(3)
    expect(report.problems).toEqual([])
  })

  it("counts a repeated master record with different content as a conflict and keeps the first", () => {
    const masters = document({ ledgers: [ledger({ guid: "g-1", name: "Cash", phone: "1" })] })
    const other = document({ ledgers: [ledger({ guid: "g-1", name: "Cash", phone: "2" })] })

    const { document: merged, report } = consolidateTallyParts([masters, other], { period })

    expect(report.masters.duplicates).toBe(1)
    expect(report.masters.conflicts).toBe(1)
    expect(merged.ledgers[0]?.phone).toBe("1")
    expect(report.problems[0]).toMatch(/^TALLY_CONSOLIDATION_CONFLICT:/)
  })

  it("keeps one copy of a voucher a retried range delivered twice", () => {
    const sale = voucher({ guid: "v-1", type: "Sales", number: "S-1", date: "2026-01-02" })
    const first = document({ vouchers: [sale] })
    const retried = document({ vouchers: [{ ...sale }] })
    const later = document({
      vouchers: [voucher({ guid: "v-2", type: "Sales", number: "S-2", date: "2026-01-05" })],
    })

    const { document: merged, report } = consolidateTallyParts([first, retried, later], { period })

    expect(report.vouchers.read).toBe(3)
    expect(report.vouchers.unique).toBe(2)
    expect(report.vouchers.duplicates).toBe(1)
    expect(merged.vouchers.map((entry) => entry.guid)).toEqual(["v-1", "v-2"])
  })

  it("dedupes on the remote id when the build has no guid, and on number and date when it has neither", () => {
    const byRemote = voucher({ remoteId: "R-9", type: "Purchase", date: "2026-01-03" })
    const byNumber = voucher({ type: "Sales", number: "S-7", date: "2026-01-04" })

    expect(tallyVoucherKey(byRemote)).toBe("remote:r-9")
    expect(tallyVoucherKey(byNumber)).toBe("number:s-7:2026-01-04")
    expect(tallyVoucherKey(voucher({ type: "Sales", date: "2026-01-04" }))).toBeUndefined()

    const { report } = consolidateTallyParts(
      [
        document({ vouchers: [byRemote, byNumber] }),
        document({ vouchers: [{ ...byRemote }, { ...byNumber }] }),
      ],
      { period },
    )

    expect(report.vouchers.unique).toBe(2)
    expect(report.vouchers.duplicates).toBe(2)
  })

  it("keeps a voucher with no identifier rather than guessing it is a duplicate", () => {
    const keyless = voucher({ type: "Journal", date: "2026-01-06" })
    const { document: merged, report } = consolidateTallyParts(
      [document({ vouchers: [keyless] }), document({ vouchers: [{ ...keyless }] })],
      { period },
    )

    expect(report.vouchers.keyless).toBe(2)
    expect(report.vouchers.duplicates).toBe(0)
    expect(merged.vouchers).toHaveLength(2)
  })

  it("reports the stretch of the promised period that no voucher falls on", () => {
    const { report } = consolidateTallyParts(
      [
        document({
          vouchers: [
            voucher({ guid: "v-1", type: "Sales", date: "2026-01-01" }),
            voucher({ guid: "v-2", type: "Sales", date: "2026-01-09" }),
          ],
        }),
      ],
      { period },
    )

    expect(report.dates.first).toBe("2026-01-01")
    expect(report.dates.last).toBe("2026-01-09")
    // The gap is measured against the promised period to 2026-01-10, not
    // against the range the vouchers happen to span.
    expect(report.dates.gaps).toEqual([
      { from: "2026-01-02", to: "2026-01-08" },
      { from: "2026-01-10", to: "2026-01-10" },
    ])
  })

  it("lists the voucher types it cannot post, with their counts and a reason", () => {
    const { report } = consolidateTallyParts(
      [
        document({
          vouchers: [
            voucher({ guid: "v-1", type: "Sales", date: "2026-01-01" }),
            voucher({ guid: "v-2", type: "Sales", date: "2026-01-02" }),
            voucher({ guid: "v-3", type: "Sales Order", date: "2026-01-03" }),
            voucher({ guid: "v-4", type: "Stock Journal", date: "2026-01-04" }),
          ],
        }),
      ],
      { period },
    )

    expect(report.vouchers.types.map((entry) => entry.type)).toEqual([
      "Sales",
      "Sales Order",
      "Stock Journal",
    ])
    expect(report.vouchers.unsupported.map((entry) => entry.count)).toEqual([1, 1])
    expect(report.vouchers.unsupported.every((entry) => entry.reason?.length)).toBe(true)
    // Nothing is dropped from the document; the types are disclosed, not hidden.
    expect(report.vouchers.unique).toBe(4)
  })

  it("sums each type's amounts so a person can compare them with Tally's report", () => {
    const { report } = consolidateTallyParts(
      [
        document({
          vouchers: [
            voucher({
              guid: "v-1",
              type: "Sales",
              date: "2026-01-01",
              ledgerLines: [line(-100), line(100, "Debtors")],
            }),
            voucher({
              guid: "v-2",
              type: "Sales",
              date: "2026-01-02",
              ledgerLines: [line(-50), line(50, "Debtors")],
            }),
          ],
        }),
      ],
      { period },
    )

    expect(report.totals).toEqual([{ type: "Sales", amount: 300 }])
  })

  it("stays unverified when nothing independent counted the source", () => {
    const { report } = consolidateTallyParts(
      [document({ vouchers: [voucher({ guid: "v-1", type: "Sales", date: "2026-01-01" })] })],
      { period },
    )

    expect(report.reconciliation).toBe("unverified")
    expect(report.problems).toEqual([])
  })

  it("is verified only when an independent count agrees, and a mismatch when it does not", () => {
    const parts = [
      document({
        ledgers: [ledger({ guid: "g-1", name: "Cash" })],
        vouchers: [
          voucher({ guid: "v-1", type: "Sales", date: "2026-01-01" }),
          voucher({ guid: "v-2", type: "Sales", date: "2026-01-02" }),
        ],
      }),
    ]

    expect(consolidateTallyParts(parts, { period, expectedVouchers: 2 }).report.reconciliation).toBe(
      "verified",
    )

    const mismatch = consolidateTallyParts(parts, { period, expectedVouchers: 3 }).report
    expect(mismatch.reconciliation).toBe("mismatch")
    expect(mismatch.problems[0]).toMatch(/^TALLY_CONSOLIDATION_VOUCHER_MISMATCH:/)
  })

  it("refuses to combine parts that name different companies", () => {
    expect(() =>
      consolidateTallyParts(
        [document({ company: "Test Pharmacy" }), document({ company: "Other Pharmacy" })],
        { period },
      ),
    ).toThrow(TallyConsolidationError)
  })

  it("refuses parts that name no company and an empty set of parts", () => {
    expect(() => consolidateTallyParts([document({ company: undefined })], { period })).toThrow(
      /TALLY_CONSOLIDATION_COMPANY_MISSING/,
    )
    expect(() => consolidateTallyParts([], { period })).toThrow(/TALLY_CONSOLIDATION_EMPTY/)
  })

  it("takes companyless parts under the company the operator entered", () => {
    const { document: merged, report } = consolidateTallyParts(
      [document({ company: undefined }), document({ company: undefined })],
      { period, company: "Api-Cure Pharma Ltd" },
    )

    expect(merged.company).toBe("Api-Cure Pharma Ltd")
    expect(report.company).toBe("Api-Cure Pharma Ltd")
  })

  it("refuses a part that names a company other than the one entered", () => {
    expect(() =>
      consolidateTallyParts([document({ company: "Test Pharmacy" })], {
        period,
        company: "Other Pharmacy",
      }),
    ).toThrow(/TALLY_CONSOLIDATION_COMPANY_MISMATCH/)
  })

  it("carries a truncated part forward as a problem instead of a complete migration", () => {
    const { report } = consolidateTallyParts(
      [
        document({
          vouchers: [voucher({ guid: "v-1", type: "Sales", date: "2026-01-01" })],
          truncated: { reason: "RECORD_LIMIT", limit: 1, recordsProcessed: 1 },
        }),
      ],
      { period },
    )

    expect(report.truncated?.recordsProcessed).toBe(1)
    expect(report.problems.some((entry) => entry.startsWith("TALLY_CONSOLIDATION_TRUNCATED"))).toBe(
      true,
    )
  })

  it("merges warnings without repeating one", () => {
    const { report } = consolidateTallyParts(
      [
        document({ warnings: ["DATE_UNREADABLE"] }),
        document({ warnings: ["DATE_UNREADABLE", "UNKNOWN_ENTITY"] }),
      ],
      { period },
    )

    expect(report.warnings).toEqual(["DATE_UNREADABLE", "UNKNOWN_ENTITY"])
  })
})
