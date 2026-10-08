import { describe, expect, it } from "vitest"
import { parseRpcStockError } from "./inventory"

describe("parseRpcStockError (CodeQL js/polynomial-redos #4)", () => {
  it("parses the RPC contract as before", () => {
    expect(parseRpcStockError("INSUFFICIENT_STOCK: Amoxicillin 500mg short by 3 units")).toEqual({
      reasonCode: "INSUFFICIENT_STOCK",
      shortBy: 3,
      productName: "Amoxicillin 500mg",
    })
    expect(parseRpcStockError("EXPIRED_ONLY: no sellable batch")).toEqual({
      reasonCode: "EXPIRED_ONLY",
      shortBy: null,
      productName: null,
    })
    expect(parseRpcStockError("something else")).toEqual({ reasonCode: null, shortBy: null, productName: null })
  })

  it("is linear on adversarial input", () => {
    const start = Date.now()
    parseRpcStockError(":" + " ".repeat(200_000))
    parseRpcStockError(":a" + " a".repeat(100_000) + " short b")
    parseRpcStockError("A".repeat(200_000) + ":")
    expect(Date.now() - start).toBeLessThan(200)
  })
})
