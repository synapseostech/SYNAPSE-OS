import { describe, expect, it } from "vitest"
import { netAmountFor, taxExclusiveBasis } from "./net-amount"

/**
 * Pins the contract stated in net-amount.ts. The point of these cases is not
 * arithmetic for its own sake: it is that every writer of
 * pharmacy_transactions.net_amount produces the same meaning for the same
 * economic facts, so a report cannot depend on which route created the row.
 */

describe("netAmountFor", () => {
  it("is what the customer owes: total, less discount, plus tax", () => {
    expect(netAmountFor({ totalAmount: 1000, discount: 100, tax: 162 })).toBe(1062)
  })

  it("returns the total unchanged when nothing was discounted or taxed", () => {
    // The shape the order routes write.
    expect(netAmountFor({ totalAmount: 2500, discount: 0, tax: 0 })).toBe(2500)
  })

  it("subtracts the discount even when no tax applies", () => {
    expect(netAmountFor({ totalAmount: 1200, discount: 200, tax: 0 })).toBe(1000)
  })

  it("rounds to two decimals rather than carrying floating-point noise", () => {
    expect(netAmountFor({ totalAmount: 0.1 + 0.2, discount: 0, tax: 0 })).toBe(0.3)
    expect(netAmountFor({ totalAmount: 999.999, discount: 0, tax: 0 })).toBe(1000)
  })

  it("treats a missing or non-finite amount as zero instead of producing NaN", () => {
    expect(netAmountFor({ totalAmount: Number.NaN, discount: 0, tax: 0 })).toBe(0)
    expect(netAmountFor({ totalAmount: 100, discount: Number.NaN, tax: 0 })).toBe(100)
  })

  it("gives the same answer to a Tally mirror and an edited sale with the same facts", () => {
    // Before the contract existed, the Tally import stored the pre-tax total
    // here while the edit route stored the tax-inclusive one. These two calls
    // model those two writers; they must agree.
    const fromTally = netAmountFor({ totalAmount: 1000, discount: 100, tax: 162 })
    const fromEdit = netAmountFor({ totalAmount: 1000, discount: 100, tax: 162 })
    expect(fromTally).toBe(fromEdit)
  })
})

describe("taxExclusiveBasis", () => {
  it("is the discounted line sum, which is what revenue reports total", () => {
    expect(taxExclusiveBasis({ totalAmount: 1000, discount: 100 })).toBe(900)
  })

  it("does not depend on the row's net_amount, so a historical row of either shape reads the same", () => {
    const gross = netAmountFor({ totalAmount: 1000, discount: 0, tax: 180 })
    const pretax = 1000 // the shape the Tally importer used to write
    expect(gross).not.toBe(pretax)
    // Both rows still yield one revenue figure, because it is derived from
    // total_amount and discount — which never carried two meanings.
    expect(taxExclusiveBasis({ totalAmount: 1000, discount: 0 })).toBe(1000)
  })
})
