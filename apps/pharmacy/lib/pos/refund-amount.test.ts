import { describe, expect, it } from "vitest"
import { allocateRefundAmount } from "./refund-amount"

const lines = [
  { id: "a", quantity: 2, unit_price: 500 },
  { id: "b", quantity: 1, unit_price: 300 },
]
const all = [
  { id: "a", quantity: 2 },
  { id: "b", quantity: 1 },
]

describe("allocateRefundAmount", () => {
  it("returns the sum of line prices when the sale carries no tax or discount", () => {
    expect(allocateRefundAmount({ lines, refunded: all, discount: 0, tax: 0 })).toBe(1300)
  })

  it("includes the tax the customer paid on a full refund", () => {
    // 1300 base + 18% VAT = 1534 paid; the old line-sum refunded only 1300.
    expect(allocateRefundAmount({ lines, refunded: all, discount: 0, tax: 234 })).toBe(1534)
  })

  it("does not hand back the discount the customer never paid", () => {
    // 1300 base less a 200 discount = 1100 paid; the old line-sum gave back 1300.
    expect(allocateRefundAmount({ lines, refunded: all, discount: 200, tax: 0 })).toBe(1100)
  })

  it("applies both the discount and the tax together", () => {
    // (1300 - 200) * 1.18 = 1298
    expect(allocateRefundAmount({ lines, refunded: all, discount: 200, tax: 198 })).toBe(1298)
  })

  it("gives a partial refund its proportional share of what was paid", () => {
    // Only line b (300 of the 1300 base), tax-inclusive: 300 * 1534 / 1300 = 354.
    const refund = allocateRefundAmount({
      lines,
      refunded: [{ id: "b", quantity: 1 }],
      discount: 0,
      tax: 234,
    })
    expect(refund).toBe(354)
  })

  it("never refunds more than was paid when a partial request is enlarged", () => {
    const refund = allocateRefundAmount({
      lines,
      refunded: [{ id: "a", quantity: 99 }],
      discount: 0,
      tax: 234,
    })
    // Quantity is clamped to the line's own 2 units: 1000 * 1534 / 1300 = 1180.
    expect(refund).toBe(1180)
    expect(refund).toBeLessThanOrEqual(1534)
  })

  it("returns nothing for unknown lines, zero quantities, or a negative paid amount", () => {
    expect(allocateRefundAmount({ lines, refunded: [{ id: "zz", quantity: 1 }], tax: 0 })).toBe(0)
    expect(allocateRefundAmount({ lines, refunded: [{ id: "a", quantity: 0 }], tax: 0 })).toBe(0)
    expect(allocateRefundAmount({ lines, refunded: all, discount: 5000, tax: 0 })).toBe(0)
    expect(allocateRefundAmount({ lines: [], refunded: [], tax: 0 })).toBe(0)
  })
})
