import assert from "node:assert/strict"
import { describe, it } from "node:test"
import {
  CMD,
  PAPER_COLUMNS,
  buildReceiptEscPos,
  buildReceiptOps,
  buildTestPageOps,
  bytesToBase64,
  encodeOps,
  formatMoney,
  opsToLines,
  toPrintable,
  twoColumn,
  wrapText,
  type EscPosReceipt,
} from "./escpos.ts"

const receipt = (overrides: Partial<EscPosReceipt> = {}): EscPosReceipt => ({
  receiptNumber: "RCP-000123",
  documentLabel: "SALES RECEIPT",
  isFiscal: false,
  status: "completed",
  isReprint: false,
  dateTimeKampala: "18/11/2026 14:05",
  pharmacy: {
    legalName: "Kampala Pharmacy Ltd",
    tradingName: "Kampala Pharmacy",
    address: "Plot 4, Kampala Road",
    phone: "+256 700 000000",
    tin: "1000123456",
    ndaLicenseNumber: "NDA/123",
    supervisingPharmacist: "J. Okello",
    receiptFooter: "Thank you — get well soon",
  },
  branch: "Main",
  cashier: "Sarah N.",
  patientName: null,
  currency: "UGX",
  lines: [
    {
      name: "Paracétamol",
      strength: "500mg",
      dosageForm: "Tablet",
      genericName: null,
      quantity: 2,
      unit: "strip",
      packageName: null,
      unitPrice: 1500,
      discount: 0,
      lineTotal: 3000,
      batchNumber: "B12",
      expiryDate: "2027-06",
    },
    {
      name: "Amoxicillin",
      strength: "250mg",
      dosageForm: "Capsule",
      genericName: "amoxicillin trihydrate",
      quantity: 1,
      unit: "pack",
      packageName: null,
      unitPrice: 12500,
      discount: 500,
      lineTotal: 12000,
      batchNumber: null,
      expiryDate: null,
    },
  ],
  subtotal: 15500,
  discountTotal: 500,
  taxAmount: 0,
  tax: null,
  totalAmount: 15000,
  payment: { method: "CASH", reference: null, amountReceived: 20000, change: 5000 },
  fiscal: { documentNumber: null },
  ...overrides,
})

describe("toPrintable", () => {
  it("folds receipt typography and accents to ASCII", () => {
    assert.equal(toPrintable("2 × 1,500 − 10% — “ok” Paracétamol…"), '2 x 1,500 - 10% - "ok" Paracetamol...')
  })

  it("never sends raw UTF-8 for characters the printer font lacks", () => {
    assert.equal(toPrintable("药 ok"), "? ok")
    assert.equal(toPrintable(null), "")
  })
})

describe("wrapText / twoColumn", () => {
  it("wraps on words and splits a word longer than the line", () => {
    assert.deepEqual(wrapText("alpha beta gamma", 10), ["alpha beta", "gamma"])
    assert.deepEqual(wrapText("abcdefghijkl", 5), ["abcde", "fghij", "kl"])
  })

  it("keeps the value flush right at exactly the paper width", () => {
    const [line] = twoColumn("Subtotal", "UGX 15,500", 32)
    assert.equal(line.length, 32)
    assert.ok(line.startsWith("Subtotal"))
    assert.ok(line.endsWith("UGX 15,500"))
  })

  it("wraps a long label above the value instead of cutting the amount", () => {
    const lines = twoColumn("A very long product description that will not fit", "UGX 1,250,000", 32)
    assert.ok(lines.every((l) => l.length <= 32))
    assert.ok(lines[lines.length - 1].endsWith("UGX 1,250,000"))
  })
})

describe("formatMoney", () => {
  it("groups thousands without depending on the phone's locale", () => {
    assert.equal(formatMoney(1250000, "UGX"), "UGX 1,250,000")
    assert.equal(formatMoney(12.5, "USD"), "USD 12.50")
    assert.equal(formatMoney(-500, "UGX"), "-UGX 500")
    assert.equal(formatMoney(Number.NaN, "UGX"), "UGX 0")
  })
})

describe("buildReceiptOps", () => {
  for (const width of ["58", "80"] as const) {
    it(`never prints a line wider than ${width} mm paper`, () => {
      const lines = opsToLines(buildReceiptOps(receipt(), { paperWidth: width }), width)
      for (const line of lines) assert.ok(line.length <= PAPER_COLUMNS[width], `${line.length}: ${line}`)
    })
  }

  it("prints the sale the customer is owed: lines, totals, payment and change", () => {
    const text = opsToLines(buildReceiptOps(receipt(), { paperWidth: "80" }), "80").join("\n")
    for (const expected of [
      "Kampala Pharmacy",
      "TIN: 1000123456",
      "RCP-000123",
      "Served by",
      "Paracetamol 500mg Tablet",
      "2 strip x UGX 1,500",
      "UGX 3,000",
      "Batch B12, Exp 2027-06",
      "(amoxicillin trihydrate)",
      "-UGX 500",
      "UGX 15,000",
      "Change",
      "UGX 5,000",
      "Not an EFRIS fiscal receipt",
      "Thank you - get well soon",
    ]) {
      assert.ok(text.includes(expected), `missing ${expected}`)
    }
  })

  it("marks reprints and voided sales so they cannot pass as a fresh receipt", () => {
    const text = opsToLines(
      buildReceiptOps(receipt({ isReprint: true, status: "voided" }), { paperWidth: "58" }),
      "58",
    ).join("\n")
    assert.ok(text.includes("*** REPRINT ***"))
    assert.ok(text.includes("*** VOIDED ***"))
  })

  it("shows the VAT breakdown when the sale carried VAT", () => {
    const text = opsToLines(
      buildReceiptOps(
        receipt({
          taxAmount: 2288,
          tax: { source: "vat", ratePct: 18, taxableAmount: 12712, exemptAmount: 3000, zeroRatedAmount: 0 },
        }),
        { paperWidth: "80" },
      ),
      "80",
    ).join("\n")
    assert.ok(text.includes("VAT (18%)"))
    assert.ok(text.includes("Taxable (18%)"))
    assert.ok(text.includes("Exempt"))
    assert.ok(!text.includes("Zero-rated"))
  })

  it("prints the fiscal document number on an EFRIS receipt", () => {
    const text = opsToLines(
      buildReceiptOps(receipt({ isFiscal: true, fiscal: { documentNumber: "FDN-9" } }), { paperWidth: "80" }),
      "80",
    ).join("\n")
    assert.ok(text.includes("EFRIS FISCAL DOCUMENT FDN-9"))
  })
})

const indexOf = (haystack: Uint8Array, needle: readonly number[]) => {
  for (let i = 0; i + needle.length <= haystack.length; i++) {
    if (needle.every((b, j) => haystack[i + j] === b)) return i
  }
  return -1
}

describe("encodeOps", () => {
  it("starts with initialise + code page and ends with a cut", () => {
    const bytes = buildReceiptEscPos(receipt(), { paperWidth: "80" })
    assert.deepEqual([...bytes.slice(0, 5)], [...CMD.init, ...CMD.codePage437])
    assert.deepEqual([...bytes.slice(-4)], [...CMD.cut])
  })

  it("leaves the cut out for printers without a cutter", () => {
    const bytes = buildReceiptEscPos(receipt(), { paperWidth: "58", cut: false })
    assert.equal(indexOf(bytes, CMD.cut), -1)
  })

  it("only ever sends 7-bit text between commands", () => {
    const bytes = encodeOps([{ kind: "text", text: "Paracétamol × 2" }], "58")
    const start = indexOf(bytes, CMD.alignLeft) + CMD.alignLeft.length
    assert.equal(String.fromCharCode(...bytes.slice(start, start + 15)), "Paracetamol x 2")
    assert.ok([...bytes].every((b) => b < 0x80))
  })

  it("resets bold and size after a styled line", () => {
    const bytes = encodeOps([{ kind: "text", text: "TOTAL", bold: true, size: "double" }], "80")
    const tail = [...bytes.slice(-6)]
    assert.deepEqual(tail, [...CMD.sizeNormal, ...CMD.boldOff])
  })
})

describe("buildTestPageOps", () => {
  it("prints a full-width ruler so a wrong paper width is visible", () => {
    const lines = opsToLines(
      buildTestPageOps({ paperWidth: "58", printerLabel: "Wi-Fi 192.168.1.50:9100", printedAt: "now" }),
      "58",
    )
    assert.ok(lines.includes("12345678901234567890123456789012"))
    assert.ok(lines.some((l) => l.includes("192.168.1.50:9100")))
  })
})

describe("bytesToBase64", () => {
  it("matches the standard encoding for every padding length", () => {
    for (const s of ["", "f", "fo", "foo", "foob", "fooba", "foobar"]) {
      const bytes = Uint8Array.from([...s].map((c) => c.charCodeAt(0)))
      assert.equal(bytesToBase64(bytes), Buffer.from(s).toString("base64"))
    }
  })
})
