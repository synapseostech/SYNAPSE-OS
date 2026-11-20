import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { addLine, checkDraft, receiveTotals, remainingAfterSubmit, toReceivingBody } from "./quick-receive.ts"

const today = "2026-11-18"

describe("quick receive", () => {
  it("accepts a typical pack: boxes, batch, MM/YY expiry, cost", () => {
    const check = checkDraft({ quantity: "5x10", batchNumber: " ab 123 ", expiry: "03/28", cost: "1,200" }, today)
    assert.deepEqual(check, { ok: true, quantity: 50, batchNumber: "AB 123", expiryDate: "2028-03-31", costPrice: 1200 })
  })

  it("says which field is wrong", () => {
    const base = { quantity: "10", batchNumber: "B1", expiry: "03/28", cost: "" }
    assert.equal((checkDraft({ ...base, quantity: "0" }, today) as { field: string }).field, "quantity")
    assert.equal((checkDraft({ ...base, batchNumber: "" }, today) as { field: string }).field, "batchNumber")
    assert.equal((checkDraft({ ...base, expiry: "10/26" }, today) as { field: string }).field, "expiry")
    assert.equal((checkDraft({ ...base, expiry: "28" }, today) as { field: string }).field, "expiry")
    assert.equal((checkDraft({ ...base, cost: "abc" }, today) as { field: string }).field, "cost")
    assert.equal(checkDraft(base, today).ok, true)
  })

  it("adds a second scan of the same batch to the same line", () => {
    let lines = addLine([], { productId: "p1", productName: "Amox", batchNumber: "B1", expiryDate: "2028-03-31", quantity: 10, costPrice: 100 })
    lines = addLine(lines, { productId: "p1", productName: "Amox", batchNumber: "b1", expiryDate: "2028-03-31", quantity: 5, costPrice: null })
    lines = addLine(lines, { productId: "p1", productName: "Amox", batchNumber: "B2", expiryDate: "2028-06-30", quantity: 2, costPrice: 110 })
    assert.equal(lines.length, 2)
    assert.equal(lines.find((l) => l.batchNumber === "B1")?.quantity, 15)
    assert.equal(lines.find((l) => l.batchNumber === "B1")?.costPrice, 100)
    assert.deepEqual(receiveTotals(lines), { lines: 2, units: 17, cost: 1720 })
  })

  it("builds the receiving request and keeps refused lines for a retry", () => {
    const lines = addLine(
      addLine([], { productId: "p1", productName: "A", batchNumber: "B1", expiryDate: "2028-03-31", quantity: 1, costPrice: null }),
      { productId: "p2", productName: "B", batchNumber: "B2", expiryDate: "2028-03-31", quantity: 2, costPrice: 5 },
    )
    const body = toReceivingBody(lines, "  INV-9 ")
    assert.equal(body.supplierRef, "INV-9")
    assert.equal(body.lines.length, 2)
    assert.equal(body.lines.find((l) => l.productId === "p1")?.costPrice, undefined)
    const left = remainingAfterSubmit(lines, [
      { productId: lines[0].productId, ok: true },
      { productId: lines[1].productId, ok: false, error: "Expiry date must be in the future" },
    ])
    assert.equal(left.length, 1)
    assert.equal(left[0].productId, lines[1].productId)
    assert.equal(left[0].error, "Expiry date must be in the future")
  })
})
