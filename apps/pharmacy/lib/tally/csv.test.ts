import { describe, expect, it } from "vitest"
import { TallyTemplateError } from "./workbook"
import { parseTallyCsv } from "./csv"

const HEADER = "record_type,name,parent,id,type,date,voucher_id,ledger,debit,credit,narration"

function csv(...rows: string[]): string {
  return [HEADER, ...rows].join("\n")
}

describe("parseTallyCsv", () => {
  it("builds the same document shape as the workbook", () => {
    const document = parseTallyCsv(
      csv(
        "account,Test Bank,Bank Accounts,,,,,,,,",
        "account,Test Capital,Capital Account,,,,,,,,",
        "voucher,,,V-1,Journal,2026-04-01,,,,,",
        "voucher_line,,,,,,V-1,Test Bank,1000,,",
        "voucher_line,,,,,,V-1,Test Capital,,1000,",
      ),
    )

    expect(document.ledgers.map((ledger) => ledger.name)).toEqual(["Test Bank", "Test Capital"])
    expect(document.vouchers).toHaveLength(1)
    expect(document.vouchers[0]!.ledgerLines.map((line) => line.side)).toEqual(["debit", "credit"])
  })

  it("drops the quote Excel adds in front of a formula-looking value", () => {
    const document = parseTallyCsv(
      csv("account,'=Test Bank,Bank Accounts,,,,,,,,"),
    )
    expect(document.ledgers[0]!.name).toBe("=Test Bank")
  })

  it("rejects a file without a record_type column", () => {
    expect(() => parseTallyCsv("name,parent\nTest Bank,Bank Accounts")).toThrow(TallyTemplateError)
  })

  it("rejects an unknown record type instead of skipping the row", () => {
    expect(() => parseTallyCsv(csv("acount,Test Bank,Bank Accounts,,,,,,,,"))).toThrow(
      /unknown record_type/,
    )
  })

  it("rejects an empty file", () => {
    expect(() => parseTallyCsv("   ")).toThrow(/empty/)
  })

  it("accepts headers in any case and with spaces", () => {
    const document = parseTallyCsv(
      [" Record Type , Name , Parent ", "account,Test Bank,Bank Accounts"].join("\n"),
    )
    expect(document.ledgers[0]!.name).toBe("Test Bank")
    expect(document.ledgers[0]!.parent).toBe("Bank Accounts")
  })
})
