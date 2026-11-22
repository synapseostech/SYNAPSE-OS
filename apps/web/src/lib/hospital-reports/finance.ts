/**
 * Hospital finance dashboard from invoices, payments and insurance claims.
 * Pure: the route loads tenant-scoped rows. Amounts are in the invoice
 * currency (UGX for Ugandan facilities); rows in another currency are
 * reported separately rather than added in.
 *
 * Definitions:
 *  - Billed: invoices issued in the period (not draft, not void).
 *  - Collected: payments received in the period, by method.
 *  - Patient balance: what patients still owe on open invoices
 *    (total - insurance cover - paid), aged from the invoice date.
 *  - Insurance receivable: claims submitted and not yet paid, denied, void
 *    or written off, aged from submission.
 */

export type FinanceInvoiceRow = {
  id: string
  status: string | null
  total_amount: number | string | null
  paid_amount: number | string | null
  insurance_cover_amount: number | string | null
  currency: string | null
  created_at: string
}
export type FinanceLineRow = { invoice_id: string; item_name: string | null; total_price: number | string | null }
export type FinancePaymentRow = { amount: number | string | null; currency: string | null; payment_method: string | null; created_at: string }
export type FinanceClaimRow = {
  insurer_name: string | null
  status: string | null
  billed_amount: number | string | null
  paid_amount: number | string | null
  submitted_at: string | null
  paid_at: string | null
  denial_reason: string | null
  denial_code: string | null
}

export type AgeingBuckets = { d0_30: number; d31_60: number; d61_90: number; d90_plus: number }
export type FinanceDashboard = {
  currency: string
  period: { start: string; end: string }
  billed: number
  invoices: number
  collected: number
  collectionRate: number | null
  byMethod: { method: string; amount: number }[]
  daily: { date: string; billed: number; collected: number }[]
  topServices: { item: string; amount: number; count: number }[]
  patientBalance: { total: number; invoices: number; ageing: AgeingBuckets }
  insurance: {
    receivable: number
    ageing: AgeingBuckets
    byStatus: { status: string; count: number; billed: number }[]
    byInsurer: { insurer: string; outstanding: number; claims: number }[]
    denials: { reason: string; count: number; amount: number }[]
    paidInPeriod: number
  }
  otherCurrencyRows: number
}

const DAY = 86_400_000
const KAMPALA_MS = 3 * 3_600_000
const num = (v: unknown) => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : 0
  return Number.isFinite(n) ? n : 0
}
const round = (n: number) => Math.round(n * 100) / 100
const localDay = (iso: string) => new Date(new Date(iso).getTime() + KAMPALA_MS).toISOString().slice(0, 10)
const inRange = (iso: string | null, start: string, end: string) => Boolean(iso) && iso! >= start && iso! < end

function age(buckets: AgeingBuckets, fromIso: string, now: Date, amount: number) {
  const days = (now.getTime() - new Date(fromIso).getTime()) / DAY
  if (days <= 30) buckets.d0_30 += amount
  else if (days <= 60) buckets.d31_60 += amount
  else if (days <= 90) buckets.d61_90 += amount
  else buckets.d90_plus += amount
}
const emptyAgeing = (): AgeingBuckets => ({ d0_30: 0, d31_60: 0, d61_90: 0, d90_plus: 0 })
const roundAgeing = (a: AgeingBuckets): AgeingBuckets => ({ d0_30: round(a.d0_30), d31_60: round(a.d31_60), d61_90: round(a.d61_90), d90_plus: round(a.d90_plus) })

const OPEN_CLAIM = new Set(['submitted', 'acknowledged', 'adjudicated', 'appealed'])

export function buildFinanceDashboard(input: {
  invoices: FinanceInvoiceRow[]
  lines: FinanceLineRow[]
  payments: FinancePaymentRow[]
  claims: FinanceClaimRow[]
  period: { start: string; end: string }
  currency?: string
  now?: Date
}): FinanceDashboard {
  const currency = (input.currency ?? 'UGX').toUpperCase()
  const now = input.now ?? new Date()
  const { start, end } = input.period
  const sameCurrency = (c: string | null) => (c ?? currency).toUpperCase() === currency
  let otherCurrencyRows = 0

  const live = input.invoices.filter((i) => {
    const s = String(i.status ?? '').toLowerCase()
    if (s === 'draft' || s === 'void') return false
    if (!sameCurrency(i.currency)) {
      otherCurrencyRows += 1
      return false
    }
    return true
  })
  const periodInvoices = live.filter((i) => inRange(i.created_at, start, end))
  const billed = periodInvoices.reduce((a, i) => a + num(i.total_amount), 0)

  const periodPayments = input.payments.filter((p) => {
    if (!inRange(p.created_at, start, end)) return false
    if (!sameCurrency(p.currency)) {
      otherCurrencyRows += 1
      return false
    }
    return true
  })
  const collected = periodPayments.reduce((a, p) => a + num(p.amount), 0)
  const methods = new Map<string, number>()
  for (const p of periodPayments) {
    const m = (p.payment_method ?? 'other').toLowerCase().replace(/_/g, ' ')
    methods.set(m, (methods.get(m) ?? 0) + num(p.amount))
  }

  // Daily series across the period (Kampala days).
  const days: string[] = []
  for (let t = new Date(start).getTime() + KAMPALA_MS; t < new Date(end).getTime() + KAMPALA_MS; t += DAY) {
    days.push(new Date(t).toISOString().slice(0, 10))
  }
  const daily = days.map((date) => ({
    date,
    billed: round(periodInvoices.filter((i) => localDay(i.created_at) === date).reduce((a, i) => a + num(i.total_amount), 0)),
    collected: round(periodPayments.filter((p) => localDay(p.created_at) === date).reduce((a, p) => a + num(p.amount), 0)),
  }))

  const periodIds = new Set(periodInvoices.map((i) => i.id))
  const services = new Map<string, { amount: number; count: number }>()
  for (const l of input.lines) {
    if (!periodIds.has(l.invoice_id)) continue
    const name = (l.item_name ?? 'Other').trim() || 'Other'
    const s = services.get(name) ?? { amount: 0, count: 0 }
    s.amount += num(l.total_price)
    s.count += 1
    services.set(name, s)
  }

  const patientAgeing = emptyAgeing()
  let patientTotal = 0
  let patientInvoices = 0
  for (const i of live) {
    const owed = num(i.total_amount) - num(i.insurance_cover_amount) - num(i.paid_amount)
    if (owed <= 0.005) continue
    patientTotal += owed
    patientInvoices += 1
    age(patientAgeing, i.created_at, now, owed)
  }

  const claimAgeing = emptyAgeing()
  let receivable = 0
  const byStatus = new Map<string, { count: number; billed: number }>()
  const byInsurer = new Map<string, { outstanding: number; claims: number }>()
  const denials = new Map<string, { count: number; amount: number }>()
  let paidInPeriod = 0
  for (const c of input.claims) {
    const status = String(c.status ?? 'draft').toLowerCase()
    const st = byStatus.get(status) ?? { count: 0, billed: 0 }
    st.count += 1
    st.billed += num(c.billed_amount)
    byStatus.set(status, st)
    if (c.paid_at && inRange(c.paid_at, start, end)) paidInPeriod += num(c.paid_amount)
    if (OPEN_CLAIM.has(status) && c.submitted_at) {
      const outstanding = Math.max(0, num(c.billed_amount) - num(c.paid_amount))
      receivable += outstanding
      age(claimAgeing, c.submitted_at, now, outstanding)
      const name = (c.insurer_name ?? 'Unknown insurer').trim()
      const ins = byInsurer.get(name) ?? { outstanding: 0, claims: 0 }
      ins.outstanding += outstanding
      ins.claims += 1
      byInsurer.set(name, ins)
    }
    if (status === 'denied') {
      const reason = (c.denial_reason ?? c.denial_code ?? 'No reason given').trim()
      const d = denials.get(reason) ?? { count: 0, amount: 0 }
      d.count += 1
      d.amount += num(c.billed_amount)
      denials.set(reason, d)
    }
  }

  return {
    currency,
    period: input.period,
    billed: round(billed),
    invoices: periodInvoices.length,
    collected: round(collected),
    collectionRate: billed > 0 ? Math.round((collected / billed) * 100) : null,
    byMethod: [...methods.entries()].map(([method, amount]) => ({ method, amount: round(amount) })).sort((a, b) => b.amount - a.amount),
    daily,
    topServices: [...services.entries()].map(([item, s]) => ({ item, amount: round(s.amount), count: s.count })).sort((a, b) => b.amount - a.amount).slice(0, 10),
    patientBalance: { total: round(patientTotal), invoices: patientInvoices, ageing: roundAgeing(patientAgeing) },
    insurance: {
      receivable: round(receivable),
      ageing: roundAgeing(claimAgeing),
      byStatus: [...byStatus.entries()].map(([status, s]) => ({ status, count: s.count, billed: round(s.billed) })).sort((a, b) => b.billed - a.billed),
      byInsurer: [...byInsurer.entries()].map(([insurer, s]) => ({ insurer, outstanding: round(s.outstanding), claims: s.claims })).sort((a, b) => b.outstanding - a.outstanding),
      denials: [...denials.entries()].map(([reason, d]) => ({ reason, count: d.count, amount: round(d.amount) })).sort((a, b) => b.amount - a.amount).slice(0, 8),
      paidInPeriod: round(paidInPeriod),
    },
    otherCurrencyRows,
  }
}
