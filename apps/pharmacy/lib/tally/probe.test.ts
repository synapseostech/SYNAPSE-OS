import { describe, expect, it } from "vitest"
import { probeTallyExport } from "./probe"

function exportWith(inner: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<ENVELOPE>
  <HEADER><TALLYREQUEST>Export Data</TALLYREQUEST></HEADER>
  <BODY><DATA><TALLYMESSAGE xmlns:UDF="TallyUDF">${inner}</TALLYMESSAGE></DATA></BODY>
</ENVELOPE>`
}

describe("probeTallyExport", () => {
  it("counts each voucher type and says which ones the ledger import drops", () => {
    const report = probeTallyExport(
      exportWith(`
        <VOUCHER VCHTYPE="Sales"><DATE>20260201</DATE></VOUCHER>
        <VOUCHER VCHTYPE="Sales"><DATE>20260202</DATE></VOUCHER>
        <VOUCHER VCHTYPE="Purchase"><DATE>20260203</DATE></VOUCHER>
        <VOUCHER VCHTYPE="Delivery Note"><DATE>20260204</DATE></VOUCHER>
        <VOUCHER VCHTYPE="Sales Order"><DATE>20260205</DATE></VOUCHER>
      `),
    )

    expect(report.vouchers).toBe(5)
    const byType = Object.fromEntries(report.types.map((type) => [type.type, type]))
    expect(byType.Sales).toMatchObject({ vouchers: 2, stagedByLedgerImport: true })
    expect(byType.Purchase).toMatchObject({ vouchers: 1, stagedByLedgerImport: true })
    expect(byType["Delivery Note"]).toMatchObject({ vouchers: 1, stagedByLedgerImport: false })
    expect(byType["Sales Order"]).toMatchObject({ vouchers: 1, stagedByLedgerImport: false })
  })

  it("puts the dropped types first, then orders by count", () => {
    const report = probeTallyExport(
      exportWith(`
        <VOUCHER VCHTYPE="Sales"><DATE>20260201</DATE></VOUCHER>
        <VOUCHER VCHTYPE="Receipt Note"><DATE>20260202</DATE></VOUCHER>
        <VOUCHER VCHTYPE="Sales Order"><DATE>20260203</DATE></VOUCHER>
        <VOUCHER VCHTYPE="Sales Order"><DATE>20260204</DATE></VOUCHER>
      `),
    )

    expect(report.types.map((type) => type.type)).toEqual(["Sales Order", "Receipt Note", "Sales"])
  })

  it("reports a zero for every candidate tag a type never carried", () => {
    const report = probeTallyExport(
      exportWith(`
        <VOUCHER VCHTYPE="Delivery Note">
          <DATE>20260201</DATE>
          <REFERENCE>SO-1</REFERENCE>
        </VOUCHER>
      `),
    )

    const type = report.types[0]
    expect(type.linkage).toHaveLength(report.candidateTags.length)
    expect(type.linkage.find((entry) => entry.tag === "REFERENCE")?.vouchers).toBe(1)
    expect(type.linkage.find((entry) => entry.tag === "BASICORDERREF")?.vouchers).toBe(0)
  })

  it("counts cancelled vouchers without removing them from the totals", () => {
    const report = probeTallyExport(
      exportWith(`
        <VOUCHER VCHTYPE="Sales"><DATE>20260201</DATE><ISCANCELLED>Yes</ISCANCELLED></VOUCHER>
        <VOUCHER VCHTYPE="Sales"><DATE>20260202</DATE></VOUCHER>
      `),
    )

    expect(report.types[0]).toMatchObject({ vouchers: 2, cancelled: 1 })
  })

  it("reports the master counts and the company's own period", () => {
    const report = probeTallyExport(
      exportWith(`
        <COMPANY>
          <COMPANYNAME>Test Pharmacy</COMPANYNAME>
          <SVFROMDATE>20260101</SVFROMDATE>
          <SVTODATE>20261231</SVTODATE>
        </COMPANY>
        <GROUP NAME="Cash-in-hand"><PARENT>Current Assets</PARENT></GROUP>
        <LEDGER NAME="Cash"><PARENT>Cash-in-hand</PARENT></LEDGER>
        <STOCKITEM NAME="Test Item A"><BASEUNITS>Strip</BASEUNITS></STOCKITEM>
      `),
    )

    expect(report.company).toBe("Test Pharmacy")
    expect(report.period).toEqual({ from: "2026-01-01", to: "2026-12-31" })
    expect(report.masters).toMatchObject({ ledgers: 1, groups: 1, stockItems: 1 })
    expect(report.types).toEqual([])
  })

  it("refuses a file whose envelope never closed rather than reporting it as empty", () => {
    expect(() => probeTallyExport("<?xml version=\"1.0\"?><ENVELOPE><BODY>")).toThrow(/MIGRATION_/)
  })
})
