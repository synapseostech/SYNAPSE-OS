import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { summariseReceiptTax, type ReceiptTaxRow } from './pharmacy-receipt-tax.ts'

const row = (over: Partial<ReceiptTaxRow>): ReceiptTaxRow => ({
  line_total: 1000,
  vat_category: 'standard',
  tax_rate: 18,
  taxable_amount: 1000,
  tax_amount: 180,
  tax_source: 'vat',
  ...over,
})

describe('summariseReceiptTax', () => {
  it('splits a VAT sale into taxable, exempt and zero-rated parts', () => {
    assert.deepEqual(
      summariseReceiptTax([
        row({ line_total: 1000, taxable_amount: 1000, tax_amount: 180 }),
        row({ line_total: 5000, vat_category: 'exempt', taxable_amount: 0, tax_amount: 0 }),
        row({ line_total: 2000, vat_category: 'zero_rated', taxable_amount: 0, tax_amount: 0 }),
      ]),
      { source: 'vat', ratePct: 18, taxableAmount: 1000, exemptAmount: 5000, zeroRatedAmount: 2000 },
    )
  })

  it('keeps a fractional rate intact', () => {
    const tax = summariseReceiptTax([row({ tax_rate: 18.5, taxable_amount: 1000 })])
    assert.equal(tax?.ratePct, 18.5)
  })

  it('reports a sale that is entirely exempt without inventing VAT', () => {
    const tax = summariseReceiptTax([row({ vat_category: 'exempt', taxable_amount: 0, tax_amount: 0 })])
    assert.deepEqual(tax, { source: 'vat', ratePct: null, taxableAmount: 0, exemptAmount: 1000, zeroRatedAmount: 0 })
  })

  it('carries the legacy flat rate through without a category split', () => {
    const tax = summariseReceiptTax([row({ tax_source: 'legacy', line_total: 9500, tax_amount: 475 })])
    assert.deepEqual(tax, { source: 'legacy', ratePct: null, taxableAmount: 0, exemptAmount: 0, zeroRatedAmount: 0 })
  })

  it('returns null for a sale that predates line-level tax', () => {
    assert.equal(
      summariseReceiptTax([row({ tax_source: null, vat_category: null, tax_rate: null, taxable_amount: null, tax_amount: null })]),
      null,
    )
    assert.equal(summariseReceiptTax([]), null)
  })

  it('refuses a partial or mixed breakdown rather than understating it', () => {
    assert.equal(summariseReceiptTax([row({}), row({ tax_source: null })]), null)
    assert.equal(summariseReceiptTax([row({}), row({ tax_source: 'legacy' })]), null)
    assert.equal(summariseReceiptTax([row({ tax_source: 'something-else' })]), null)
  })

  it('rounds the category totals to cents', () => {
    const tax = summariseReceiptTax([
      row({ line_total: 0.15, taxable_amount: 0.15 }),
      row({ line_total: 0.15, taxable_amount: 0.15 }),
      row({ line_total: 0.15, vat_category: 'exempt' }),
    ])
    assert.equal(tax?.taxableAmount, 0.3)
    assert.equal(tax?.exemptAmount, 0.15)
  })
})
