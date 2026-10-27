import { describe, expect, it } from "vitest"
import {
  FIXTURE_COMPANY,
  FIXTURE_CURRENCY,
  FIXTURE_PERIOD,
  buildFixtureCsv,
  buildFixtureWorkbook,
  buildFixtureXml,
} from "./fixtures"
import { readTallyDocument } from "./source"
import type { TallyXmlDocument } from "@synapse/db/tally-xml-rows"

function encode(text: string): Uint8Array {
  return new TextEncoder().encode(text)
}

function money(value: number): number {
  return Math.round(value * 100) / 100
}

function voucherTotals(document: TallyXmlDocument) {
  return document.vouchers.map((voucher) => {
    const debit = money(
      voucher.ledgerLines
        .filter((line) => line.side === "debit")
        .reduce((total, line) => total + line.amount, 0),
    )
    const credit = money(
      voucher.ledgerLines
        .filter((line) => line.side === "credit")
        .reduce((total, line) => total + line.amount, 0),
    )
    return { number: voucher.number, type: voucher.type, date: voucher.date, debit, credit }
  })
}

function openingTotal(document: TallyXmlDocument): number {
  return money(
    document.ledgers.reduce((total, ledger) => total + (ledger.openingBalance ?? 0), 0),
  )
}

const xml = readTallyDocument(encode(buildFixtureXml()), "fixture.xml")
const workbook = readTallyDocument(buildFixtureWorkbook(), "fixture.xlsx")
const csv = readTallyDocument(encode(buildFixtureCsv()), "fixture.csv")

describe("Tally fixtures", () => {
  it("detects each delivered format from its bytes", () => {
    expect(xml.format).toBe("xml")
    expect(workbook.format).toBe("xlsx")
    expect(csv.format).toBe("csv")
  })

  it("carries the same masters in every format", () => {
    for (const { document } of [xml, workbook, csv]) {
      expect(document.company).toBe(FIXTURE_COMPANY)
      expect(document.currency).toBe(FIXTURE_CURRENCY)
      expect(document.financialPeriod).toEqual(FIXTURE_PERIOD)
      expect(document.ledgers.map((ledger) => ledger.name)).toHaveLength(8)
      expect(document.stockItems.map((item) => item.name)).toEqual(["Test Item A", "Test Item B"])
      expect(openingTotal(document)).toBe(0)
    }
  })

  it("carries the same six vouchers in every format", () => {
    const expected = [
      "JRN-0001",
      "SAL-0001",
      "PUR-0001",
      "RCT-0001",
      "PAY-0001",
      "CNT-0001",
    ]
    for (const { document } of [xml, workbook, csv]) {
      expect(document.vouchers.map((voucher) => voucher.number)).toEqual(expected)
    }
  })

  it("posts balanced vouchers in every format", () => {
    for (const { document } of [xml, workbook, csv]) {
      for (const voucher of voucherTotals(document)) {
        expect(`${voucher.number}:${voucher.debit}`).toBe(`${voucher.number}:${voucher.credit}`)
      }
    }
  })

  it("agrees between the XML export and the normalised worksheet", () => {
    expect(voucherTotals(workbook.document)).toEqual(voucherTotals(xml.document))
    expect(voucherTotals(csv.document)).toEqual(voucherTotals(xml.document))
  })

  it("keeps the party ledger and its bill allocation", () => {
    const party = xml.document.ledgers.find((ledger) => ledger.name === "Test Party A")
    expect(party?.parent).toBe("Sundry Debtors")
    expect(party?.isBillWise).toBe(true)
    expect(workbook.document.ledgers.find((ledger) => ledger.name === "Test Party A")?.bills).toEqual([
      { name: "SAL-0001", billType: "New Ref", amount: 100_000, creditPeriodDays: 30 },
    ])
  })

  it("carries the expiry date so opening stock can be received", () => {
    const line = xml.document.vouchers.find((voucher) => voucher.number === "SAL-0001")
      ?.inventoryLines[0]
    expect(line?.stockItemName).toBe("Test Item A")
    expect(line?.quantity).toBe(40)
    expect(line?.batches[0]).toMatchObject({
      batchName: "Test Batch A",
      expiryDate: "2027-06-30",
      godown: "Main Location",
    })
  })

  it("uses only synthetic party and product names", () => {
    const names = [
      FIXTURE_COMPANY,
      ...xml.document.ledgers.map((ledger) => ledger.name),
      ...xml.document.stockItems.map((item) => item.name),
    ]
    for (const name of names) {
      expect(name === FIXTURE_COMPANY || /^(Test |Cash|Bank|Sales|Purchase|Stock|Opening)/.test(name)).toBe(true)
    }
  })
})
