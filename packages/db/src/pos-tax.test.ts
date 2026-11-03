import { describe, it } from "node:test"
import assert from "node:assert/strict"

import {
  computePharmacySaleTax,
  roundMoney,
  taxAmountMatches,
  type TaxableLine,
} from "./pos-tax.ts"

const line = (netAmount: number, vatCategory?: string | null): TaxableLine => ({
  netAmount,
  vatCategory,
})

describe("computePharmacySaleTax — VAT enabled", () => {
  it("taxes only standard-rated lines and leaves exempt and zero-rated ones alone", () => {
    const result = computePharmacySaleTax(
      { vatEnabled: true, vatRate: 18 },
      [line(1000, "standard"), line(5000, "exempt"), line(2000, "zero_rated")],
    )
    assert.equal(result.ok, true)
    assert.equal(result.ok && result.source, "vat")
    assert.equal(result.ok && result.taxableBase, 1000)
    assert.equal(result.ok && result.taxAmount, 180)
  })

  it("treats an unclassified or unknown category as exempt rather than inventing VAT", () => {
    const result = computePharmacySaleTax(
      { vatEnabled: true, vatRate: 18 },
      [line(1000, null), line(1000, "STANDARD"), line(1000, "reduced"), line(1000, undefined)],
    )
    assert.equal(result.ok, true)
    assert.equal(result.ok && result.taxableBase, 0)
    assert.equal(result.ok && result.taxAmount, 0)
  })

  it("applies the rate to the discounted base, not the list total", () => {
    // List 2000 with a 200 discount: the tax base is 1800, not 2000.
    const result = computePharmacySaleTax(
      { vatEnabled: true, vatRate: 18 },
      [line(1800, "standard")],
    )
    assert.equal(result.ok && result.taxAmount, 324)
  })

  it("rounds to cents instead of carrying floating-point residue", () => {
    const result = computePharmacySaleTax(
      { vatEnabled: true, vatRate: 18 },
      [line(333.33, "standard")],
    )
    assert.equal(result.ok && result.taxAmount, 60)
    assert.equal(roundMoney(0.1 + 0.2), 0.3)
  })

  it("refuses an out-of-range VAT rate instead of coercing it", () => {
    for (const vatRate of [undefined, null, "", "abc", -1, 101, Number.NaN]) {
      const result = computePharmacySaleTax({ vatEnabled: true, vatRate }, [line(1000, "standard")])
      assert.equal(result.ok, false)
      assert.equal(result.ok === false && result.code, "INVALID_TAX_CONFIGURATION")
      assert.equal(result.ok === false && result.field, "vat_rate")
    }
  })

  it("charges nothing when every line is exempt", () => {
    const result = computePharmacySaleTax(
      { vatEnabled: true, vatRate: 18 },
      [line(700, "exempt"), line(300, "exempt")],
    )
    assert.equal(result.ok, true)
    assert.equal(result.ok && result.taxableBase, 0)
    assert.equal(result.ok && result.taxAmount, 0)
  })
})

describe("computePharmacySaleTax — legacy flat rate", () => {
  it("keeps an existing flat rate on the whole discounted base", () => {
    const result = computePharmacySaleTax(
      { vatEnabled: false, vatRate: 18, taxRate: 5 },
      [line(1000, "exempt"), line(500, "standard")],
    )
    assert.equal(result.ok, true)
    assert.equal(result.ok && result.source, "legacy")
    assert.equal(result.ok && result.taxableBase, 1500)
    assert.equal(result.ok && result.taxAmount, 75)
  })

  it("charges nothing when no rate is configured", () => {
    for (const settings of [null, undefined, {}, { vatEnabled: false }, { taxRate: 0 }]) {
      const result = computePharmacySaleTax(settings, [line(1000, "standard")])
      assert.equal(result.ok, true)
      assert.equal(result.ok && result.source, "none")
      assert.equal(result.ok && result.taxAmount, 0)
    }
  })

  it("refuses an invalid legacy rate", () => {
    const result = computePharmacySaleTax({ taxRate: 120 }, [line(1000)])
    assert.equal(result.ok, false)
    assert.equal(result.ok === false && result.field, "tax_rate")
  })

  it("ignores negative or non-numeric line amounts rather than crediting tax", () => {
    const result = computePharmacySaleTax(
      { taxRate: 10 },
      [line(1000), line(-500), line(Number.NaN)],
    )
    assert.equal(result.ok, true)
    assert.equal(result.ok && result.taxableBase, 1000)
    assert.equal(result.ok && result.taxAmount, 100)
  })
})

describe("per-line tax (the shape persisted on pharmacy_pos_sale_items)", () => {
  it("classifies every line and taxes only the standard-rated ones", () => {
    const result = computePharmacySaleTax(
      { vatEnabled: true, vatRate: 18 },
      [line(1000, "standard"), line(5000, "exempt"), line(2000, "zero_rated")],
    )
    assert.equal(result.ok, true)
    if (!result.ok) return
    assert.deepEqual(
      result.lines.map((l) => [l.vatCategory, l.ratePct, l.taxableAmount, l.taxAmount]),
      [
        ["standard", 18, 1000, 180],
        ["exempt", 0, 0, 0],
        ["zero_rated", 0, 0, 0],
      ],
    )
    assert.equal(result.taxableBase, result.lines.reduce((s, l) => s + l.taxableAmount, 0))
    assert.equal(result.taxAmount, result.lines.reduce((s, l) => s + l.taxAmount, 0))
  })

  it("rounds each line to cents and sums the rounded lines", () => {
    // 0.15 at 18% is 0.027 per line: 0.03 each, so the header is 0.09 — not the
    // 0.08 a whole-sale base would round to. The stored lines must add up.
    const result = computePharmacySaleTax(
      { vatEnabled: true, vatRate: 18 },
      [line(0.15, "standard"), line(0.15, "standard"), line(0.15, "standard")],
    )
    assert.equal(result.ok, true)
    if (!result.ok) return
    assert.deepEqual(result.lines.map((l) => l.taxAmount), [0.03, 0.03, 0.03])
    assert.equal(result.taxAmount, 0.09)
  })

  it("applies the legacy flat rate to every line whatever its category", () => {
    const result = computePharmacySaleTax(
      { vatEnabled: false, taxRate: 5 },
      [line(1000, "exempt"), line(500, "standard")],
    )
    assert.equal(result.ok, true)
    if (!result.ok) return
    assert.deepEqual(result.lines.map((l) => l.ratePct), [5, 5])
    assert.deepEqual(result.lines.map((l) => l.taxAmount), [50, 25])
  })

  it("still records the category when no tax is configured", () => {
    const result = computePharmacySaleTax({ vatEnabled: false }, [line(800, "zero_rated"), line(200, "standard")])
    assert.equal(result.ok, true)
    if (!result.ok) return
    assert.deepEqual(result.lines.map((l) => l.vatCategory), ["zero_rated", "standard"])
    assert.deepEqual(result.lines.map((l) => l.taxAmount), [0, 0])
  })
})

describe("taxAmountMatches", () => {
  it("accepts the server value and a one-cent drift", () => {
    assert.equal(taxAmountMatches(180, 180), true)
    assert.equal(taxAmountMatches("180.00", 180), true)
    assert.equal(taxAmountMatches(180.005, 180), true)
  })

  it("rejects a manipulated, negative, excessive or missing amount", () => {
    assert.equal(taxAmountMatches(-300, 180), false)
    assert.equal(taxAmountMatches(0, 180), false)
    assert.equal(taxAmountMatches(100000, 180), false)
    assert.equal(taxAmountMatches(undefined, 180), false)
    assert.equal(taxAmountMatches("abc", 180), false)
  })
})
