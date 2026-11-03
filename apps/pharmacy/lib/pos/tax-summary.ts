/**
 * Period tax breakdown built from the tax persisted on each sale line.
 *
 * A sale completed before 20261102110000 has no line-level tax at all. Those
 * lines are counted as `linesMissingTaxData` rather than assumed taxable or
 * exempt, and `taxReconciliation.difference` shows exactly how much of the
 * header tax they account for, so a report never silently invents history.
 */

export interface TaxLineRow {
  line_total: number | null
  vat_category: string | null
  taxable_amount: number | null
  tax_amount: number | null
  tax_source: string | null
}

export interface TaxBreakdown {
  source: string | null
  standardTaxable: number
  standardTax: number
  exemptSales: number
  zeroRatedSales: number
  legacySales: number
  legacyTax: number
  untaxedSales: number
  lineTaxTotal: number
  linesRecorded: number
  linesMissingTaxData: number
}

export interface TaxReconciliation {
  headerTax: number
  lineTax: number
  difference: number
}

const money = (value: number) => Number(value.toFixed(2))

export function summariseLineTax(
  rows: readonly TaxLineRow[],
  headerTax: number,
): { tax: TaxBreakdown; reconciliation: TaxReconciliation } {
  const tax: TaxBreakdown = {
    source: null,
    standardTaxable: 0,
    standardTax: 0,
    exemptSales: 0,
    zeroRatedSales: 0,
    legacySales: 0,
    legacyTax: 0,
    untaxedSales: 0,
    lineTaxTotal: 0,
    linesRecorded: 0,
    linesMissingTaxData: 0,
  }

  for (const line of rows) {
    const net = Number(line.line_total ?? 0) || 0
    tax.lineTaxTotal += Number(line.tax_amount ?? 0) || 0
    if (line.tax_source == null) {
      tax.linesMissingTaxData += 1
      continue
    }
    tax.linesRecorded += 1
    if (line.tax_source === "vat") {
      if (line.vat_category === "standard") {
        tax.standardTaxable += Number(line.taxable_amount ?? 0) || 0
        tax.standardTax += Number(line.tax_amount ?? 0) || 0
      } else if (line.vat_category === "zero_rated") {
        tax.zeroRatedSales += net
      } else {
        tax.exemptSales += net
      }
    } else if (line.tax_source === "legacy") {
      tax.legacySales += net
      tax.legacyTax += Number(line.tax_amount ?? 0) || 0
    } else {
      tax.untaxedSales += net
    }
  }

  const sources = new Set(
    rows.map((l) => l.tax_source).filter((s): s is string => s != null),
  )
  tax.source = sources.size === 0 ? null : sources.size === 1 ? [...sources][0] : "mixed"

  for (const key of [
    "standardTaxable", "standardTax", "exemptSales", "zeroRatedSales",
    "legacySales", "legacyTax", "untaxedSales", "lineTaxTotal",
  ] as const) {
    tax[key] = money(tax[key])
  }

  return {
    tax,
    reconciliation: {
      headerTax: money(headerTax),
      lineTax: tax.lineTaxTotal,
      difference: money(headerTax - tax.lineTaxTotal),
    },
  }
}
