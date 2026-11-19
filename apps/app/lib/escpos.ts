/**
 * ESC/POS receipt formatting for 58 mm and 80 mm thermal printers.
 *
 * Pure functions only: the bytes are built here and handed to a transport
 * (Wi-Fi/LAN on TCP 9100, or Bluetooth SPP) in `printer-transport.ts`. Keeping
 * the layout out of the transport means it is tested under `node --test` and
 * is the same whichever way the printer is reached.
 *
 * The command subset is the one every cheap ESC/POS clone (Xprinter, GOOJPRT,
 * Rongta, HOIN, MUNBYN, Epson TM-T20/T82) understands: initialise, align,
 * bold, double size, feed and partial cut. Text is sent as plain ASCII in code
 * page 437: these printers have no font for most of Unicode, and a stray "×"
 * or "−" prints as garbage, so `toPrintable` folds the receipt's typography to
 * ASCII first.
 *
 * No imports: this file must load under both Metro and `node --test`.
 */

export type PaperWidth = "58" | "80"

/** Characters per line in Font A: 32 on 58 mm paper (384 dots), 48 on 80 mm (576 dots). */
export const PAPER_COLUMNS: Record<PaperWidth, number> = { "58": 32, "80": 48 }

export interface EscPosReceiptLine {
  name: string
  genericName?: string | null
  strength?: string | null
  dosageForm?: string | null
  quantity: number
  unit?: string | null
  packageName?: string | null
  unitPrice: number
  discount: number
  lineTotal: number
  batchNumber?: string | null
  expiryDate?: string | null
}

/** The receipt snapshot fields the paper receipt needs (a subset of the mobile receipt API). */
export interface EscPosReceipt {
  receiptNumber: string
  documentLabel: string
  isFiscal: boolean
  status: string
  isReprint: boolean
  dateTimeKampala: string
  pharmacy: {
    legalName: string
    tradingName?: string | null
    address?: string | null
    phone?: string | null
    tin?: string | null
    ndaLicenseNumber?: string | null
    supervisingPharmacist?: string | null
    receiptFooter?: string | null
  }
  branch?: string | null
  cashier?: string | null
  patientName?: string | null
  currency: string
  lines: EscPosReceiptLine[]
  subtotal: number
  discountTotal: number
  taxAmount: number
  tax?: {
    source: "vat" | "legacy" | "none"
    ratePct: number | null
    taxableAmount: number
    exemptAmount: number
    zeroRatedAmount: number
  } | null
  totalAmount: number
  payment: { method: string; reference?: string | null; amountReceived?: number | null; change?: number | null }
  fiscal?: { documentNumber?: string | null } | null
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

const ESC = 0x1b
const GS = 0x1d
const LF = 0x0a

export const CMD = {
  /** ESC @ — reset to defaults. */
  init: [ESC, 0x40],
  /** ESC t 0 — code page PC437 (plain ASCII prints identically on every clone). */
  codePage437: [ESC, 0x74, 0x00],
  alignLeft: [ESC, 0x61, 0x00],
  alignCenter: [ESC, 0x61, 0x01],
  boldOn: [ESC, 0x45, 0x01],
  boldOff: [ESC, 0x45, 0x00],
  /** GS ! 0x11 — double width and height. */
  sizeDouble: [GS, 0x21, 0x11],
  /** GS ! 0x01 — double height only, keeps the column count. */
  sizeTall: [GS, 0x21, 0x01],
  sizeNormal: [GS, 0x21, 0x00],
  /** GS V 66 n — feed to the cutter, then partial cut. Printers without a cutter ignore it. */
  cut: [GS, 0x56, 0x42, 0x00],
} as const

/** A layout operation; `encodeOps` turns a list of these into printer bytes. */
export type EscPosOp =
  | { kind: "text"; text: string; align?: "left" | "center"; bold?: boolean; size?: "normal" | "tall" | "double" }
  | { kind: "rule" }
  | { kind: "feed"; lines: number }
  | { kind: "cut" }

// ---------------------------------------------------------------------------
// Text helpers
// ---------------------------------------------------------------------------

const TYPOGRAPHY: Record<string, string> = {
  "×": "x",
  "−": "-",
  "–": "-",
  "—": "-",
  "‐": "-",
  "‘": "'",
  "’": "'",
  "‚": ",",
  "“": '"',
  "”": '"',
  "„": '"',
  "…": "...",
  "•": "*",
  "·": "-",
  "€": "EUR",
  "£": "GBP",
  "µ": "u",
  "μ": "u",
  "°": "o",
  " ": " ",
  " ": " ",
  "\t": " ",
}

/**
 * Fold text to the printable ASCII a thermal printer's built-in font has:
 * known typography is replaced, accents are dropped ("Paracétamol" →
 * "Paracetamol"), and anything else becomes "?" rather than raw UTF-8 bytes.
 */
export function toPrintable(text: string | null | undefined): string {
  if (!text) return ""
  let out = ""
  for (const ch of String(text).normalize("NFKD")) {
    const code = ch.codePointAt(0) ?? 0
    if (code >= 0x300 && code <= 0x36f) continue // combining accent left by NFKD
    if (TYPOGRAPHY[ch] !== undefined) {
      out += TYPOGRAPHY[ch]
    } else if (code === 0x0a || code === 0x0d) {
      out += " "
    } else if (code >= 0x20 && code <= 0x7e) {
      out += ch
    } else {
      out += "?"
    }
  }
  return out
}

/** Word-wrap to `width` columns; words longer than a line are split. */
export function wrapText(text: string, width: number): string[] {
  const clean = toPrintable(text).replace(/ +/g, " ").trim()
  if (!clean) return []
  const lines: string[] = []
  let current = ""
  for (const word of clean.split(" ")) {
    let w = word
    while (w.length > width) {
      if (current) {
        lines.push(current)
        current = ""
      }
      lines.push(w.slice(0, width))
      w = w.slice(width)
    }
    if (!w) continue
    if (!current) current = w
    else if (current.length + 1 + w.length <= width) current += ` ${w}`
    else {
      lines.push(current)
      current = w
    }
  }
  if (current) lines.push(current)
  return lines
}

/**
 * A label on the left and a value flush right. The value is never cut; a label
 * too long to share the line wraps above it.
 */
export function twoColumn(left: string, right: string, width: number): string[] {
  const l = toPrintable(left).trim()
  const r = toPrintable(right).trim()
  if (r.length >= width) return [...wrapText(l, width), r.slice(0, width)]
  const room = width - r.length - 1
  const leftLines = wrapText(l, Math.max(room, 1))
  if (leftLines.length === 0) return [r.padStart(width)]
  const last = leftLines[leftLines.length - 1]
  if (last.length <= room) {
    return [...leftLines.slice(0, -1), last + " ".repeat(width - last.length - r.length) + r]
  }
  return [...leftLines, r.padStart(width)]
}

/** "UGX 12,500" — fixed grouping so the paper does not depend on the phone's locale. */
export function formatMoney(amount: number, currency: string): string {
  const n = Number.isFinite(amount) ? amount : 0
  const negative = n < 0
  const abs = Math.abs(n)
  const whole = Math.abs(abs - Math.round(abs)) < 0.005
  const fixed = whole ? String(Math.round(abs)) : abs.toFixed(2)
  const [intPart, frac] = fixed.split(".")
  const grouped = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ",")
  const body = frac ? `${grouped}.${frac}` : grouped
  return `${negative ? "-" : ""}${currency ? `${currency} ` : ""}${body}`
}

function formatQty(n: number): string {
  return Number.isInteger(n) ? String(n) : String(Math.round(n * 1000) / 1000)
}

// ---------------------------------------------------------------------------
// Receipt layout
// ---------------------------------------------------------------------------

export interface EscPosOptions {
  paperWidth: PaperWidth
  /** Send the cutter command at the end (default true). */
  cut?: boolean
  /** Blank lines before the cut so the last line clears the tear bar (default 3). */
  trailingFeed?: number
}

function text(t: string, extra: Omit<Extract<EscPosOp, { kind: "text" }>, "kind" | "text"> = {}): EscPosOp {
  return { kind: "text", text: t, ...extra }
}

/** The receipt as layout operations. Exposed so tests can read the paper as text. */
export function buildReceiptOps(receipt: EscPosReceipt, options: EscPosOptions): EscPosOp[] {
  const width = PAPER_COLUMNS[options.paperWidth]
  const money = (n: number) => formatMoney(n, receipt.currency)
  const ops: EscPosOp[] = []
  const center = (t: string | null | undefined, extra: { bold?: boolean } = {}) => {
    for (const line of wrapText(t ?? "", width)) ops.push(text(line, { align: "center", ...extra }))
  }
  const row = (k: string, v: string, bold = false) => {
    for (const line of twoColumn(k, v, width)) ops.push(text(line, { bold }))
  }
  const plain = (t: string) => {
    for (const line of wrapText(t, width)) ops.push(text(line))
  }

  const shopName = receipt.pharmacy.tradingName || receipt.pharmacy.legalName
  // Double width halves the columns; a long name falls back to tall-only.
  const doubleWidth = Math.floor(width / 2)
  const nameLines = wrapText(shopName, doubleWidth)
  if (nameLines.length <= 2) {
    for (const line of nameLines) ops.push(text(line, { align: "center", bold: true, size: "double" }))
  } else {
    for (const line of wrapText(shopName, width)) ops.push(text(line, { align: "center", bold: true, size: "tall" }))
  }
  if (receipt.pharmacy.tradingName && receipt.pharmacy.legalName && receipt.pharmacy.tradingName !== receipt.pharmacy.legalName) {
    center(receipt.pharmacy.legalName)
  }
  center(receipt.pharmacy.address)
  center(receipt.pharmacy.phone)
  if (receipt.pharmacy.tin) center(`TIN: ${receipt.pharmacy.tin}`)
  if (receipt.pharmacy.ndaLicenseNumber) center(`NDA: ${receipt.pharmacy.ndaLicenseNumber}`)

  ops.push({ kind: "feed", lines: 1 })
  center(receipt.documentLabel, { bold: true })
  if (receipt.isReprint) center("*** REPRINT ***", { bold: true })
  if (receipt.status !== "completed") center(`*** ${receipt.status.toUpperCase()} ***`, { bold: true })

  ops.push({ kind: "rule" })
  row("Receipt", receipt.receiptNumber)
  row("Date", receipt.dateTimeKampala)
  if (receipt.branch) row("Branch", receipt.branch)
  if (receipt.cashier) row("Served by", receipt.cashier)
  if (receipt.patientName) row("Customer", receipt.patientName)
  ops.push({ kind: "rule" })

  for (const line of receipt.lines) {
    const name = [line.name, line.strength, line.dosageForm].filter(Boolean).join(" ")
    for (const l of wrapText(name, width)) ops.push(text(l, { bold: true }))
    if (line.genericName) plain(`(${line.genericName})`)
    const unit = line.packageName || line.unit || "unit"
    row(`  ${formatQty(line.quantity)} ${unit} x ${money(line.unitPrice)}`, money(line.lineTotal))
    if (line.discount > 0) row("  Discount", `-${money(line.discount)}`)
    const batch = [line.batchNumber ? `Batch ${line.batchNumber}` : null, line.expiryDate ? `Exp ${line.expiryDate}` : null]
      .filter(Boolean)
      .join(", ")
    if (batch) plain(batch)
  }

  ops.push({ kind: "rule" })
  row("Subtotal", money(receipt.subtotal))
  if (receipt.discountTotal > 0) row("Discount", `-${money(receipt.discountTotal)}`)
  const rate = receipt.tax?.ratePct != null ? ` (${receipt.tax.ratePct}%)` : ""
  if (receipt.tax && receipt.tax.source === "vat") {
    if (receipt.tax.taxableAmount > 0) row(`Taxable${rate}`, money(receipt.tax.taxableAmount))
    if (receipt.taxAmount > 0) row(`VAT${rate}`, money(receipt.taxAmount))
    if (receipt.tax.zeroRatedAmount > 0) row("Zero-rated", money(receipt.tax.zeroRatedAmount))
    if (receipt.tax.exemptAmount > 0) row("Exempt", money(receipt.tax.exemptAmount))
  } else if (receipt.taxAmount > 0) {
    row("Tax/VAT", money(receipt.taxAmount))
  }
  for (const line of twoColumn("TOTAL", money(receipt.totalAmount), width)) {
    ops.push(text(line, { bold: true, size: "tall" }))
  }
  row("Payment", receipt.payment.method)
  if (receipt.payment.reference) row("Ref", receipt.payment.reference)
  if (receipt.payment.amountReceived != null && receipt.payment.amountReceived > 0) {
    row("Received", money(receipt.payment.amountReceived))
  }
  if (receipt.payment.change != null && receipt.payment.change > 0) row("Change", money(receipt.payment.change))

  ops.push({ kind: "rule" })
  if (receipt.isFiscal) {
    center(`EFRIS FISCAL DOCUMENT${receipt.fiscal?.documentNumber ? ` ${receipt.fiscal.documentNumber}` : ""}`)
  } else {
    center("Not an EFRIS fiscal receipt")
  }
  if (receipt.pharmacy.supervisingPharmacist) center(`Pharmacist: ${receipt.pharmacy.supervisingPharmacist}`)
  center(receipt.pharmacy.receiptFooter)

  ops.push({ kind: "feed", lines: options.trailingFeed ?? 3 })
  if (options.cut !== false) ops.push({ kind: "cut" })
  return ops
}

/** A short page that proves the address, paper width and cutter are right. */
export function buildTestPageOps(input: {
  paperWidth: PaperWidth
  printerLabel: string
  printedAt: string
  cut?: boolean
}): EscPosOp[] {
  const width = PAPER_COLUMNS[input.paperWidth]
  const ops: EscPosOp[] = [
    text("Synapse", { align: "center", bold: true, size: "double" }),
    text("Printer test", { align: "center", bold: true }),
    { kind: "rule" },
  ]
  for (const line of twoColumn("Printer", input.printerLabel, width)) ops.push(text(line))
  for (const line of twoColumn("Paper", `${input.paperWidth} mm / ${width} columns`, width)) ops.push(text(line))
  for (const line of twoColumn("Printed", input.printedAt, width)) ops.push(text(line))
  ops.push({ kind: "rule" })
  // A full-width ruler: the last digit must land on the right edge, not wrap.
  ops.push(text(Array.from({ length: width }, (_, i) => String((i + 1) % 10)).join("")))
  ops.push(text("If this line fits, the width is right.", { align: "center" }))
  ops.push({ kind: "feed", lines: 3 })
  if (input.cut !== false) ops.push({ kind: "cut" })
  return ops
}

/** The paper as plain text lines (rules drawn with "-"). For tests and previews. */
export function opsToLines(ops: EscPosOp[], paperWidth: PaperWidth): string[] {
  const width = PAPER_COLUMNS[paperWidth]
  const lines: string[] = []
  for (const op of ops) {
    if (op.kind === "text") lines.push(op.text)
    else if (op.kind === "rule") lines.push("-".repeat(width))
    else if (op.kind === "feed") for (let i = 0; i < op.lines; i++) lines.push("")
  }
  return lines
}

function asciiBytes(s: string): number[] {
  const out: number[] = []
  for (const ch of toPrintable(s)) out.push(ch.charCodeAt(0))
  return out
}

/** Encode layout operations to the bytes sent to the printer. */
export function encodeOps(ops: EscPosOp[], paperWidth: PaperWidth): Uint8Array {
  const width = PAPER_COLUMNS[paperWidth]
  const bytes: number[] = [...CMD.init, ...CMD.codePage437]
  for (const op of ops) {
    switch (op.kind) {
      case "text": {
        bytes.push(...(op.align === "center" ? CMD.alignCenter : CMD.alignLeft))
        if (op.bold) bytes.push(...CMD.boldOn)
        if (op.size === "double") bytes.push(...CMD.sizeDouble)
        else if (op.size === "tall") bytes.push(...CMD.sizeTall)
        bytes.push(...asciiBytes(op.text), LF)
        if (op.size && op.size !== "normal") bytes.push(...CMD.sizeNormal)
        if (op.bold) bytes.push(...CMD.boldOff)
        break
      }
      case "rule":
        bytes.push(...CMD.alignLeft, ...asciiBytes("-".repeat(width)), LF)
        break
      case "feed":
        for (let i = 0; i < op.lines; i++) bytes.push(LF)
        break
      case "cut":
        bytes.push(...CMD.cut)
        break
    }
  }
  return Uint8Array.from(bytes)
}

export function buildReceiptEscPos(receipt: EscPosReceipt, options: EscPosOptions): Uint8Array {
  return encodeOps(buildReceiptOps(receipt, options), options.paperWidth)
}

export function buildTestPageEscPos(input: Parameters<typeof buildTestPageOps>[0]): Uint8Array {
  return encodeOps(buildTestPageOps(input), input.paperWidth)
}

/** Base64 without Buffer/btoa, for transports that take a base64 string. */
export function bytesToBase64(bytes: Uint8Array): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"
  let out = ""
  let i = 0
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2]
    out += alphabet[(n >> 18) & 63] + alphabet[(n >> 12) & 63] + alphabet[(n >> 6) & 63] + alphabet[n & 63]
  }
  const rest = bytes.length - i
  if (rest === 1) {
    const n = bytes[i] << 16
    out += alphabet[(n >> 18) & 63] + alphabet[(n >> 12) & 63] + "=="
  } else if (rest === 2) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8)
    out += alphabet[(n >> 18) & 63] + alphabet[(n >> 12) & 63] + alphabet[(n >> 6) & 63] + "="
  }
  return out
}
