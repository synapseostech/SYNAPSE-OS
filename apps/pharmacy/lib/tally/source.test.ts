import { describe, expect, it } from "vitest"
import * as XLSX from "xlsx"
import { TallySourceError, detectTallyFormat, readTallyDocument } from "./source"

const encode = (text: string) => new TextEncoder().encode(text)

function xlsxBytes(): Uint8Array {
  const workbook = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([["key", "value"], ["company", "Test"]]), "Meta")
  XLSX.utils.book_append_sheet(
    workbook,
    XLSX.utils.aoa_to_sheet([
      ["name", "parent"],
      ["Test Bank", "Bank Accounts"],
    ]),
    "Accounts",
  )
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([["name"], ["Test Item A"]]), "StockItems")
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([["id", "type", "date"]]), "Vouchers")
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([["voucher_id", "ledger"]]), "VoucherLines")
  return new Uint8Array(XLSX.write(workbook, { type: "array", bookType: "xlsx" }) as ArrayBuffer)
}

const XML = `<?xml version="1.0"?><ENVELOPE><BODY><DATA><TALLYMESSAGE>
<COMPANY><COMPANYNAME>Test Pharmacy</COMPANYNAME><CURRENCYNAME>UGX</CURRENCYNAME></COMPANY>
</TALLYMESSAGE></DATA></BODY></ENVELOPE>`

describe("detectTallyFormat", () => {
  it("reads XML after a byte order mark and leading whitespace", () => {
    const withBom = new Uint8Array([0xef, 0xbb, 0xbf, ...encode('<?xml version="1.0"?>')])
    expect(detectTallyFormat(withBom)).toBe("xml")
    expect(detectTallyFormat(encode('\n\n  <?xml version="1.0"?>'))).toBe("xml")
  })

  it("reads a zip as xlsx only when the name says so", () => {
    const zip = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0, 0])
    expect(detectTallyFormat(zip, "export.xlsx")).toBe("xlsx")
    expect(() => detectTallyFormat(zip, "export.zip")).toThrow(TallySourceError)
  })

  it("refuses a legacy OLE workbook with a real explanation", () => {
    const ole = new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])
    expect(() => detectTallyFormat(ole, "export.xls")).toThrow(/\.xlsx/)
  })

  it("reads a flat CSV by its record_type header", () => {
    const csv = encode("record_type,name\naccount,Test Bank")
    expect(detectTallyFormat(csv)).toBe("csv")
  })

  it("refuses anything else rather than guessing", () => {
    expect(() => detectTallyFormat(encode("plain text with no header"))).toThrow(TallySourceError)
  })
})

describe("readTallyDocument", () => {
  it("parses XML through the bounded parser", () => {
    const { format, document } = readTallyDocument(encode(XML), "export.xml")
    expect(format).toBe("xml")
    expect(document.company).toBe("Test Pharmacy")
  })

  it("parses an xlsx workbook through the template reader", () => {
    const { format, document } = readTallyDocument(xlsxBytes(), "export.xlsx")
    expect(format).toBe("xlsx")
    expect(document.ledgers.map((ledger) => ledger.name)).toEqual(["Test Bank"])
    expect(document.stockItems.map((item) => item.name)).toEqual(["Test Item A"])
  })

  it("parses a CSV with a byte order mark", () => {
    const bytes = new Uint8Array([0xef, 0xbb, 0xbf, ...encode("record_type,name,parent\naccount,Test Bank,Bank Accounts")])
    const { format, document } = readTallyDocument(bytes, "export.csv")
    expect(format).toBe("csv")
    expect(document.ledgers[0]!.parent).toBe("Bank Accounts")
  })
})
