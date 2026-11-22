import { describe, expect, it } from 'vitest'
import { buildFinanceDashboard } from './finance'

const NOW = new Date('2026-11-21T09:00:00Z')
const period = { start: '2026-10-31T21:00:00.000Z', end: '2026-11-30T21:00:00.000Z' } // November, Kampala
const inv = (id: string, created: string, total: number, paid = 0, cover = 0, status = 'issued', currency = 'UGX') =>
  ({ id, status, total_amount: total, paid_amount: paid, insurance_cover_amount: cover, currency, created_at: created })

describe('finance dashboard', () => {
  const d = buildFinanceDashboard({
    now: NOW,
    period,
    invoices: [
      inv('a', '2026-11-02T08:00:00Z', 50_000, 50_000, 0, 'paid'),
      inv('b', '2026-11-20T08:00:00Z', 120_000, 20_000, 60_000, 'partially_paid'),
      inv('c', '2026-08-01T08:00:00Z', 30_000, 0), // old, unpaid: 90+ days
      inv('d', '2026-11-05T08:00:00Z', 99_000, 0, 0, 'void'),
      inv('e', '2026-11-06T08:00:00Z', 10_000, 0, 0, 'draft'),
      inv('f', '2026-11-07T08:00:00Z', 70, 0, 0, 'issued', 'USD'),
    ],
    lines: [
      { invoice_id: 'a', item_name: 'Consultation', total_price: 20_000 },
      { invoice_id: 'a', item_name: 'Malaria RDT', total_price: 30_000 },
      { invoice_id: 'b', item_name: 'Consultation', total_price: 20_000 },
      { invoice_id: 'c', item_name: 'Old item', total_price: 30_000 },
    ],
    payments: [
      { amount: 50_000, currency: 'UGX', payment_method: 'mobile_money', created_at: '2026-11-02T08:05:00Z' },
      { amount: 20_000, currency: 'UGX', payment_method: 'cash', created_at: '2026-11-20T08:05:00Z' },
      { amount: 5_000, currency: 'UGX', payment_method: 'cash', created_at: '2026-10-30T08:05:00Z' },
    ],
    claims: [
      { insurer_name: 'Demo Insurer A', status: 'submitted', billed_amount: 60_000, paid_amount: 0, submitted_at: '2026-11-20T09:00:00Z', paid_at: null, denial_reason: null, denial_code: null },
      { insurer_name: 'Demo Insurer A', status: 'adjudicated', billed_amount: 40_000, paid_amount: 10_000, submitted_at: '2026-09-10T09:00:00Z', paid_at: null, denial_reason: null, denial_code: null },
      { insurer_name: 'Demo Insurer B', status: 'denied', billed_amount: 25_000, paid_amount: 0, submitted_at: '2026-10-01T09:00:00Z', paid_at: null, denial_reason: 'Not covered by plan', denial_code: 'NC' },
      { insurer_name: 'Demo Insurer B', status: 'paid', billed_amount: 15_000, paid_amount: 15_000, submitted_at: '2026-10-01T09:00:00Z', paid_at: '2026-11-10T09:00:00Z', denial_reason: null, denial_code: null },
    ],
  })

  it('bills issued invoices in the period, not drafts, voids or other currencies', () => {
    expect(d.billed).toBe(170_000)
    expect(d.invoices).toBe(2)
    expect(d.otherCurrencyRows).toBe(1)
  })

  it('collects payments in the period by method', () => {
    expect(d.collected).toBe(70_000)
    expect(d.collectionRate).toBe(41)
    expect(d.byMethod).toEqual([{ method: 'mobile money', amount: 50_000 }, { method: 'cash', amount: 20_000 }])
  })

  it('ages what patients still owe, net of insurance cover', () => {
    expect(d.patientBalance.total).toBe(70_000) // b: 120k - 60k cover - 20k paid = 40k; c: 30k
    expect(d.patientBalance.ageing).toEqual({ d0_30: 40_000, d31_60: 0, d61_90: 0, d90_plus: 30_000 })
  })

  it('ages insurance receivables from submission and lists denials', () => {
    expect(d.insurance.receivable).toBe(90_000)
    expect(d.insurance.ageing.d0_30).toBe(60_000)
    expect(d.insurance.ageing.d61_90).toBe(30_000)
    expect(d.insurance.byInsurer[0]).toEqual({ insurer: 'Demo Insurer A', outstanding: 90_000, claims: 2 })
    expect(d.insurance.denials).toEqual([{ reason: 'Not covered by plan', count: 1, amount: 25_000 }])
    expect(d.insurance.paidInPeriod).toBe(15_000)
  })

  it('ranks services and builds a daily series in Kampala days', () => {
    expect(d.topServices[0]).toEqual({ item: 'Consultation', amount: 40_000, count: 2 })
    expect(d.topServices.map((s) => s.item)).not.toContain('Old item')
    expect(d.daily).toHaveLength(30)
    expect(d.daily.find((x) => x.date === '2026-11-02')).toEqual({ date: '2026-11-02', billed: 50_000, collected: 50_000 })
  })

  it('handles a quiet month', () => {
    const q = buildFinanceDashboard({ now: NOW, period, invoices: [], lines: [], payments: [], claims: [] })
    expect(q.collectionRate).toBeNull()
    expect(q.billed).toBe(0)
  })
})
