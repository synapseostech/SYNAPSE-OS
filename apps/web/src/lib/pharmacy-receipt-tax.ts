import type { ReceiptTaxBreakdown } from '@synapse/db/receipt'

export interface ReceiptTaxRow {
  line_total?: number | string | null
  vat_category?: string | null
  tax_rate?: number | string | null
  taxable_amount?: number | string | null
  tax_amount?: number | string | null
  tax_source?: string | null
}

const round = (value: number) => Number(value.toFixed(2))

/**
 * Composition of the tax charged, from the figures frozen on each sale line.
 *
 * Returns null unless every line carries a tax snapshot: a partial breakdown
 * would understate the exempt or zero-rated part of the sale, so those receipts
 * fall back to the header "Tax/VAT" row instead of showing a split that lies.
 */
export function summariseReceiptTax(rows: ReadonlyArray<ReceiptTaxRow>): ReceiptTaxBreakdown | null {
  if (!rows.length) return null
  if (rows.some((r) => r.tax_source == null)) return null

  const sources = new Set(rows.map((r) => String(r.tax_source)))
  if (sources.size !== 1) return null

  const source = [...sources][0]
  if (source !== 'vat' && source !== 'legacy' && source !== 'none') return null

  let ratePct: number | null = null
  let taxableAmount = 0
  let exemptAmount = 0
  let zeroRatedAmount = 0

  for (const row of rows) {
    if (source !== 'vat') continue
    const net = Number(row.line_total ?? 0)
    if (row.vat_category === 'standard') {
      taxableAmount += Number(row.taxable_amount ?? 0)
      if (ratePct == null && row.tax_rate != null) ratePct = Number(row.tax_rate)
    } else if (row.vat_category === 'zero_rated') {
      zeroRatedAmount += net
    } else {
      exemptAmount += net
    }
  }

  return {
    source,
    ratePct,
    taxableAmount: round(taxableAmount),
    exemptAmount: round(exemptAmount),
    zeroRatedAmount: round(zeroRatedAmount),
  }
}
