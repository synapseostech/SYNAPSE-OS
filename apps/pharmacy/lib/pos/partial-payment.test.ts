import { describe, expect, it } from "vitest"
import { decodePaidAmount, encodePaymentRef, settlePayment } from "./partial-payment"

describe("settlePayment", () => {
  it("records full cash with change", () => {
    const s = settlePayment(10000, 12000)
    expect(s.isFullyPaid).toBe(true)
    expect(s.isPartial).toBe(false)
    expect(s.change).toBe(2000)
    expect(s.balanceDue).toBe(0)
  })

  it("records underpayment as balance due (partial)", () => {
    const s = settlePayment(10000, 6000)
    expect(s.isPartial).toBe(true)
    expect(s.isFullyPaid).toBe(false)
    expect(s.amountPaid).toBe(6000)
    expect(s.balanceDue).toBe(4000)
    expect(s.change).toBe(0)
  })

  it("treats zero paid as full balance due", () => {
    const s = settlePayment(8500, 0)
    expect(s.balanceDue).toBe(8500)
    expect(s.isPartial).toBe(true)
  })

  it("encodes payment ref for monitoring", () => {
    expect(encodePaymentRef({ amountPaid: 6000, balanceDue: 4000, method: "CASH" })).toBe(
      "PAID:6000|BAL:4000|M:CASH",
    )
  })
})

describe("decodePaidAmount", () => {
  it("reads the paid part out of a partial-payment tag", () => {
    expect(
      decodePaidAmount({ paymentRef: "PAID:6000|BAL:4000|M:CASH", total: 10000, method: "cash" }),
    ).toBe(6000)
  })

  it("finds the tag when earlier reference text precedes it", () => {
    expect(
      decodePaidAmount({ paymentRef: "MOBILE-REF-77|PAID:2500|BAL:7500|M:MTN", total: 10000, method: "mtn" }),
    ).toBe(2500)
  })

  it("treats a credit sale with no tag as nothing paid", () => {
    expect(decodePaidAmount({ paymentRef: null, total: 10000, method: "credit" })).toBe(0)
  })

  it("treats a sale with no tag and no credit method as fully paid", () => {
    expect(decodePaidAmount({ paymentRef: "", total: 10000, method: "cash" })).toBe(10000)
  })

  it("never reports more than the sale total even if the tag overstates it", () => {
    expect(
      decodePaidAmount({ paymentRef: "PAID:15000|BAL:0|M:CASH", total: 10000, method: "cash" }),
    ).toBe(10000)
  })
})
