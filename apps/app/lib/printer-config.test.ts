import assert from "node:assert/strict"
import { describe, it } from "node:test"
import {
  DEFAULT_PRINTER_CONFIG,
  isBluetoothAddress,
  isPrinterReady,
  parsePrinterAddress,
  parsePrinterConfig,
  serialisePrinterConfig,
  shouldOpenReceiptAfterSale,
} from "./printer-config.ts"

describe("parsePrinterAddress", () => {
  it("defaults to the raw printing port 9100", () => {
    assert.deepEqual(parsePrinterAddress("192.168.1.50"), { ok: true, host: "192.168.1.50", port: 9100 })
  })

  it("reads a port typed after the address, and a separate port field wins", () => {
    assert.deepEqual(parsePrinterAddress(" 10.0.0.7:9101 "), { ok: true, host: "10.0.0.7", port: 9101 })
    assert.deepEqual(parsePrinterAddress("10.0.0.7:9101", "9100"), { ok: true, host: "10.0.0.7", port: 9100 })
  })

  it("accepts a local hostname and strips a pasted scheme", () => {
    assert.deepEqual(parsePrinterAddress("tcp://Counter-Printer.local/"), {
      ok: true,
      host: "counter-printer.local",
      port: 9100,
    })
  })

  it("refuses addresses that cannot be dialled", () => {
    for (const bad of ["", "256.1.1.1", "192.168.1", "192.168.1.50:0", "192.168.1.50:70000", "printer name"]) {
      assert.equal(parsePrinterAddress(bad).ok, false, bad)
    }
  })
})

describe("printer config storage", () => {
  it("round-trips a saved printer", () => {
    const config = {
      ...DEFAULT_PRINTER_CONFIG,
      kind: "bluetooth" as const,
      paperWidth: "58" as const,
      bluetoothAddress: "66:22:B3:10:4C:8E",
      bluetoothName: "MTP-II",
      autoPrint: true,
    }
    assert.deepEqual(parsePrinterConfig(serialisePrinterConfig(config)), config)
  })

  it("falls back to the system dialog on missing or corrupt storage", () => {
    assert.deepEqual(parsePrinterConfig(null), DEFAULT_PRINTER_CONFIG)
    assert.deepEqual(parsePrinterConfig("{not json"), DEFAULT_PRINTER_CONFIG)
    assert.equal(parsePrinterConfig('{"kind":"laser","port":"x"}').kind, "system")
    assert.equal(parsePrinterConfig('{"kind":"network","port":99999}').port, 9100)
  })

  it("knows when a configured printer can actually be reached", () => {
    assert.equal(isPrinterReady(DEFAULT_PRINTER_CONFIG), true)
    assert.equal(isPrinterReady({ ...DEFAULT_PRINTER_CONFIG, kind: "network", host: "" }), false)
    assert.equal(isPrinterReady({ ...DEFAULT_PRINTER_CONFIG, kind: "network", host: "192.168.0.9" }), true)
    assert.equal(isPrinterReady({ ...DEFAULT_PRINTER_CONFIG, kind: "bluetooth", bluetoothAddress: "nope" }), false)
    assert.equal(isBluetoothAddress("66:22:b3:10:4c:8e"), true)
  })
})

describe("shouldOpenReceiptAfterSale", () => {
  it("opens the receipt when the pharmacy requires a print or anyone turned auto-print on", () => {
    const base = { mandatoryReceiptPrint: false, pharmacyAutoPrint: false, deviceAutoPrint: false }
    assert.equal(shouldOpenReceiptAfterSale(base), false)
    assert.equal(shouldOpenReceiptAfterSale({ ...base, mandatoryReceiptPrint: true }), true)
    assert.equal(shouldOpenReceiptAfterSale({ ...base, pharmacyAutoPrint: true }), true)
    assert.equal(shouldOpenReceiptAfterSale({ ...base, deviceAutoPrint: true }), true)
  })
})
