import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { resolveReceiptExit } from "./receipt-print-gate.ts"

describe("resolveReceiptExit", () => {
  it("asks for a decision on a completed sale in a mandatory pharmacy", () => {
    assert.equal(resolveReceiptExit({ mandatory: true, status: "completed", outcome: null }), "decide")
  })

  it("lets the cashier leave once they asked to print", () => {
    assert.equal(
      resolveReceiptExit({ mandatory: true, status: "completed", outcome: "requested" }),
      "leave",
    )
  })

  it("lets the cashier leave once they reported no printer", () => {
    assert.equal(resolveReceiptExit({ mandatory: true, status: "completed", outcome: "failed" }), "leave")
  })

  it("never blocks a pharmacy that does not require a print", () => {
    assert.equal(resolveReceiptExit({ mandatory: false, status: "completed", outcome: null }), "leave")
  })

  it("never blocks a refunded or voided sale — there is no receipt to hand over", () => {
    for (const status of ["refunded", "voided", "cancelled", "pending"]) {
      assert.equal(resolveReceiptExit({ mandatory: true, status, outcome: null }), "leave")
    }
  })

  it("never blocks while the receipt has not loaded", () => {
    assert.equal(resolveReceiptExit({ mandatory: true, status: null, outcome: null }), "leave")
    assert.equal(resolveReceiptExit({ mandatory: true, status: undefined, outcome: null }), "leave")
  })
})
