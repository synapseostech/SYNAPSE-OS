import { describe, expect, it } from "vitest"
import { parseBankStatementCsv } from "./bank-statement"

describe("parseBankStatementCsv", () => {
  it("normalizes ISO dates, parenthesized withdrawals, and optional references", () => {
    const rows = parseBankStatementCsv(
      [
        "Date,Description,Amount,Reference",
        "2026-10-20,Customer deposit,125000.50,TX-1",
        "21/10/2026,Supplier payment,(25000.00),TX-2",
      ].join("\n"),
      "UGX",
    )

    expect(rows).toEqual([
      {
        lineNumber: 2,
        date: "2026-10-20",
        description: "Customer deposit",
        reference: "TX-1",
        amount: 125000.5,
        currency: "UGX",
      },
      {
        lineNumber: 3,
        date: "2026-10-21",
        description: "Supplier payment",
        reference: "TX-2",
        amount: -25000,
        currency: "UGX",
      },
    ])
  })

  it("converts separate debit and credit columns into signed bank amounts", () => {
    const rows = parseBankStatementCsv(
      [
        "Transaction Date,Narration,Debit,Credit",
        "2026-10-20,Card settlement,,7400",
        "2026-10-21,Utility payment,3500,",
      ].join("\n"),
      "UGX",
    )

    expect(rows.map((row) => row.amount)).toEqual([7400, -3500])
  })

  it("rejects invalid rows and unsupported CSV layouts", () => {
    expect(() => parseBankStatementCsv("Date,Description,Amount\n2026-02-30,Sale,100", "UGX"))
      .toThrow(/row 2/i)
    expect(() => parseBankStatementCsv("Date,Amount\n2026-10-20,100", "UGX"))
      .toThrow(/needs Date, Description and Amount/i)
  })
})
