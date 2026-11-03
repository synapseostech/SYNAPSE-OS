import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { allocateCartDiscount, roundMoney } from "./pos-pricing.ts"

const sum = (values: readonly number[]) => roundMoney(values.reduce((total, value) => total + value, 0))

describe("allocateCartDiscount", () => {
  it("splits a cart discount in proportion to line value", () => {
    assert.deepEqual(allocateCartDiscount([1000, 500], 150), [100, 50])
  })

  it("always sums exactly to the discount after rounding", () => {
    const allocation = allocateCartDiscount([100, 100, 100], 100)
    assert.deepEqual(allocation, [33.33, 33.33, 33.34])
    assert.equal(sum(allocation), 100)
  })

  it("keeps the taxable base independent of cart order", () => {
    // The same cart, reversed. A standard line next to an exempt line must
    // receive the same discount either way, or VAT depends on scan order.
    const forwards = allocateCartDiscount([1180, 500], 236)
    const backwards = allocateCartDiscount([500, 1180], 236).reverse()
    assert.deepEqual(forwards, backwards)
  })

  it("never discounts a line below zero when the discount exceeds the cart", () => {
    const allocation = allocateCartDiscount([300, 200], 900)
    assert.deepEqual(allocation, [300, 200])
    assert.equal(sum(allocation), 500)
  })

  it("returns zeros for no discount, an empty cart, or non-numeric input", () => {
    assert.deepEqual(allocateCartDiscount([100, 200], 0), [0, 0])
    assert.deepEqual(allocateCartDiscount([], 50), [])
    assert.deepEqual(allocateCartDiscount([0, 0], 50), [0, 0])
    assert.deepEqual(allocateCartDiscount([100], Number.NaN), [0])
    assert.deepEqual(allocateCartDiscount([100], -20), [0])
  })

  it("ignores a negative or non-finite line net rather than inflating another line", () => {
    assert.deepEqual(allocateCartDiscount([-100, 200], 20), [0, 20])
    assert.deepEqual(allocateCartDiscount([Number.NaN, 200], 20), [0, 20])
  })

  it("gives every line its share down to the cent when many lines round", () => {
    const allocation = allocateCartDiscount([1, 1, 1], 1)
    assert.equal(sum(allocation), 1)
    assert.ok(allocation.every((value) => value >= 0))
  })
})
