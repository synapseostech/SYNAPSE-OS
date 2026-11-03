import { describe, expect, it } from "vitest"
import {
  PRINTER_UNAVAILABLE_MESSAGE,
  normalizePrintFailureReason,
  parseReceiptPrintOutcome,
  resolveReceiptPrintPolicy,
} from "./receipt-print"

describe("receipt print policy", () => {
  it("enforces an attempt when settings have not loaded, matching the DB default", () => {
    expect(resolveReceiptPrintPolicy(null)).toEqual({
      requiresAttempt: true,
      autoPrint: false,
      allowSkip: false,
    })
    expect(resolveReceiptPrintPolicy(undefined).allowSkip).toBe(false)
  })

  it("enforces an attempt when the setting is explicitly on", () => {
    expect(
      resolveReceiptPrintPolicy({ mandatoryReceiptPrint: true, autoPrintReceipt: false }),
    ).toEqual({ requiresAttempt: true, autoPrint: false, allowSkip: false })
  })

  it("mandatory print supersedes auto-print, because auto-print has no failure exit", () => {
    expect(
      resolveReceiptPrintPolicy({ mandatoryReceiptPrint: true, autoPrintReceipt: true }),
    ).toEqual({ requiresAttempt: true, autoPrint: false, allowSkip: false })
  })

  it("offers a dismissible prompt when the setting is off", () => {
    expect(
      resolveReceiptPrintPolicy({ mandatoryReceiptPrint: false, autoPrintReceipt: false }),
    ).toEqual({ requiresAttempt: false, autoPrint: false, allowSkip: true })
  })

  it("auto-prints without a prompt when the setting is off and auto-print is on", () => {
    expect(
      resolveReceiptPrintPolicy({ mandatoryReceiptPrint: false, autoPrintReceipt: true }),
    ).toEqual({ requiresAttempt: false, autoPrint: true, allowSkip: true })
  })
})

describe("receipt print outcome", () => {
  it("accepts only the two outcomes a browser can attest to", () => {
    expect(parseReceiptPrintOutcome("requested")).toBe("requested")
    expect(parseReceiptPrintOutcome("failed")).toBe("failed")
    expect(parseReceiptPrintOutcome("success")).toBeNull()
    expect(parseReceiptPrintOutcome("")).toBeNull()
    expect(parseReceiptPrintOutcome(undefined)).toBeNull()
  })

  it("refuses 'printed': window.print() cannot prove paper came out", () => {
    expect(parseReceiptPrintOutcome("printed")).toBeNull()
  })

  it("defaults and caps the failure reason", () => {
    expect(normalizePrintFailureReason("  paper jam ")).toBe("paper jam")
    expect(normalizePrintFailureReason("   ")).toBe("printer unavailable")
    expect(normalizePrintFailureReason({})).toBe("printer unavailable")
    expect(normalizePrintFailureReason("x".repeat(500))).toHaveLength(200)
  })

  it("tells the cashier the sale is safe and how to recover the receipt", () => {
    expect(PRINTER_UNAVAILABLE_MESSAGE).toMatch(/sale is saved/i)
    expect(PRINTER_UNAVAILABLE_MESSAGE).toMatch(/reprint/i)
    expect(PRINTER_UNAVAILABLE_MESSAGE).toMatch(/no money/i)
  })
})
