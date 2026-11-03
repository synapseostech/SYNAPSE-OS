import { describe, expect, it } from "vitest"
import { summariseLineTax, type TaxLineRow } from "./tax-summary"

const line = (over: Partial<TaxLineRow>): TaxLineRow => ({
  line_total: 1000,
  vat_category: "standard",
  taxable_amount: 1000,
  tax_amount: 0,
  tax_source: "vat",
  ...over,
})

describe("summariseLineTax", () => {
  it("splits a VAT period into standard, exempt and zero-rated sales", () => {
    const { tax, reconciliation } = summariseLineTax(
      [
        line({ line_total: 1000, taxable_amount: 1000, tax_amount: 180 }),
        line({ line_total: 5000, vat_category: "exempt", taxable_amount: 0 }),
        line({ line_total: 2000, vat_category: "zero_rated", taxable_amount: 0 }),
      ],
      180,
    )
    expect(tax).toMatchObject({
      source: "vat",
      standardTaxable: 1000,
      standardTax: 180,
      exemptSales: 5000,
      zeroRatedSales: 2000,
      lineTaxTotal: 180,
      linesRecorded: 3,
      linesMissingTaxData: 0,
    })
    expect(reconciliation).toEqual({ headerTax: 180, lineTax: 180, difference: 0 })
  })

  it("reports the legacy flat-rate period separately from VAT", () => {
    const { tax } = summariseLineTax(
      [line({ tax_source: "legacy", vat_category: "exempt", tax_amount: 50 })],
      50,
    )
    expect(tax).toMatchObject({ source: "legacy", legacySales: 1000, legacyTax: 50, standardTax: 0 })
  })

  it("marks a period that spans a settings change as mixed", () => {
    const { tax } = summariseLineTax(
      [line({ tax_amount: 180 }), line({ tax_source: "legacy", tax_amount: 50 })],
      230,
    )
    expect(tax.source).toBe("mixed")
  })

  it("counts pre-migration lines as missing instead of assuming they were untaxed", () => {
    const { tax, reconciliation } = summariseLineTax(
      [
        line({ line_total: 1000, taxable_amount: null, tax_amount: null, tax_source: null }),
        line({ line_total: 2000, taxable_amount: 2000, tax_amount: 360 }),
      ],
      360,
    )
    expect(tax.linesMissingTaxData).toBe(1)
    expect(tax.linesRecorded).toBe(1)
    expect(tax.untaxedSales).toBe(0)
    expect(reconciliation).toEqual({ headerTax: 360, lineTax: 360, difference: 0 })
  })

  it("surfaces a header that its lines cannot account for, rather than hiding it", () => {
    const { reconciliation } = summariseLineTax([line({ tax_amount: 100 })], 180)
    expect(reconciliation).toEqual({ headerTax: 180, lineTax: 100, difference: 80 })
  })

  it("returns an empty breakdown for a period with no sales", () => {
    const { tax, reconciliation } = summariseLineTax([], 0)
    expect(tax).toMatchObject({ source: null, lineTaxTotal: 0, linesRecorded: 0 })
    expect(reconciliation).toEqual({ headerTax: 0, lineTax: 0, difference: 0 })
  })
})
