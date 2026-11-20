'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import Link from 'next/link'

type LabOrder = {
  id: string
  test_name: string
  loinc_code: string
  workflow_status?: string
  status?: string
}
type Prescription = {
  id: string
  medication_display: string
  dose: string | null
  quantity: number
  status: string
}
type TimelineEvent = {
  id: string
  event_type: string
  title: string
  summary: string | null
  event_date: string
  severity: string | null
  tags: string[] | null
}
type LineItem = {
  id: string
  item_name: string
  unit_price: number
  qty: number
  total_price: number | null
}
type PaymentRow = {
  id: string
  amount: number
  payment_method: string
  receipt_number: string | null
  created_at: string
}
type Invoice = {
  id: string
  status: string
  total_amount: number
  paid_amount: number
  invoice_number: string | null
  insurance_cover_amount?: number | null
  balance_due?: number | null
}

type EncounterOrdersPanelProps = {
  slug: string
  encounterId: string
  patientId?: string | null
}

export function EncounterOrdersPanel({ slug, encounterId, patientId }: EncounterOrdersPanelProps) {
  const [labOrders, setLabOrders] = useState<LabOrder[]>([])
  const [prescriptions, setPrescriptions] = useState<Prescription[]>([])
  const [timeline, setTimeline] = useState<TimelineEvent[]>([])
  const [invoice, setInvoice] = useState<Invoice | null>(null)
  const [lineItems, setLineItems] = useState<LineItem[]>([])
  const [payments, setPayments] = useState<PaymentRow[]>([])
  const [payAmount, setPayAmount] = useState('')
  const [payMethod, setPayMethod] = useState('cash')
  const [payStatus, setPayStatus] = useState<string | null>(null)
  // One key per intended payment: a retry of the same submit (double click,
  // dropped response) is deduplicated, while a second instalment of the same
  // amount gets a fresh key after the first one succeeds.
  const payKey = useRef<string | null>(null)
  const [paying, setPaying] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    if (!encounterId) return
    const [labRes, rxRes, timelineRes, billingRes] = await Promise.all([
      fetch(`/api/opd/lab-orders?encounter_id=${encounterId}`, { credentials: 'include' }),
      fetch(`/api/opd/prescriptions?encounter_id=${encounterId}`, { credentials: 'include' }),
      fetch(`/api/hospital/timeline/encounter/${encounterId}`, { credentials: 'include' }),
      fetch(`/api/hospital/billing/encounter/${encounterId}`, { credentials: 'include' }),
    ])
    if (!labRes.ok || !rxRes.ok) {
      setError('Unable to load orders for this encounter.')
      return
    }
    const labData = await labRes.json()
    const rxData = await rxRes.json()
    setLabOrders(labData.orders ?? [])
    setPrescriptions(rxData.prescriptions ?? [])
    setError(null)
    if (timelineRes.ok) {
      const tl = await timelineRes.json()
      setTimeline(tl.events ?? [])
    }
    if (billingRes.ok) {
      const bill = await billingRes.json()
      setInvoice(bill.invoice ?? null)
      setLineItems(bill.lineItems ?? [])
      setPayments(bill.payments ?? [])
      const total = Number(bill.invoice?.total_amount ?? 0)
      const paid = Number(bill.invoice?.paid_amount ?? 0)
      const cover = Number(bill.invoice?.insurance_cover_amount ?? 0)
      const balance = Number(bill.invoice?.balance_due ?? Math.max(0, total - cover - paid))
      if (balance > 0) {
        setPayAmount((prev) => (prev ? prev : String(balance)))
      }
    }
  }, [encounterId])

  useEffect(() => {
    load().catch(() => setError('Unable to load orders.'))
  }, [load])

  async function collectPayment(e: React.FormEvent) {
    e.preventDefault()
    const amount = Number(payAmount)
    if (!amount || amount <= 0) return
    setPaying(true)
    setPayStatus(null)
    payKey.current ??= `encounter-pay:${encounterId}:${crypto.randomUUID()}`
    const idempotencyKey = payKey.current
    const res = await fetch(`/api/hospital/billing/encounter/${encounterId}/pay`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        amount,
        payment_method: payMethod,
        idempotency_key: idempotencyKey,
      }),
    })
    const data = await res.json()
    setPaying(false)
    if (!res.ok) {
      setPayStatus(typeof data.error === 'string' ? data.error : 'Payment failed')
      return
    }
    payKey.current = null
    setPayStatus(`Receipt ${data.payment?.receiptNumber ?? 'recorded'} · status ${data.payment?.status ?? 'paid'}`)
    await load()
  }

  const balanceDue =
    invoice != null
      ? Number(
          invoice.balance_due ??
            Math.max(0, Number(invoice.total_amount ?? 0) - Number(invoice.insurance_cover_amount ?? 0) - Number(invoice.paid_amount ?? 0)),
        )
      : null

  if (!encounterId) {
    return (
      <div>
        <h1 className="font-display text-2xl">Clinical orders</h1>
        <p className="mt-2 text-muted-color">Select a patient from the OPD queue to view orders and timeline.</p>
        <Link href={`/os/${slug}/clinical/queue`} className="mt-4 inline-block text-sm text-emerald-700 dark:text-emerald-300">
          ← OPD queue
        </Link>
      </div>
    )
  }

  return (
    <div>
      <Link href={`/os/${slug}/clinical/queue`} className="text-xs text-muted-color hover:text-primary-color">
        ← OPD queue
      </Link>
      <h1 className="mt-2 font-display text-2xl">Clinical orders & billing</h1>
      <p className="mt-2 text-sm text-muted-color">Encounter {encounterId.slice(0, 8)}…</p>
      {error ? <p className="mt-4 text-sm text-amber-700 dark:text-amber-300">{error}</p> : null}

      <div className="mt-4 flex flex-wrap gap-2">
        {patientId ? (
          <Link
            href={`/os/${slug}/encounters/new?patientId=${patientId}`}
            className="rounded-lg border border-emerald-500/40 px-3 py-1 text-xs text-emerald-700 dark:text-emerald-300"
          >
            Add orders
          </Link>
        ) : null}
        <Link href="/lab/orders" className="rounded-lg border border-indigo-500/40 px-3 py-1 text-xs text-indigo-700 dark:text-indigo-300">
          Lab worklist
        </Link>
        <Link
          href={`/os/${slug}/clinical/dispense`}
          className="rounded-lg border border-amber-500/40 px-3 py-1 text-xs text-amber-700 dark:text-amber-300"
        >
          Pharmacy dispense
        </Link>
      </div>

      <section className="mt-8">
        <h2 className="text-sm font-semibold uppercase text-muted-color">Invoice</h2>
        {!invoice ? (
          <p className="mt-2 text-xs text-muted-color">No invoice yet — charges appear when orders are placed.</p>
        ) : (
          <div className="clinical-card mt-3 p-4 text-sm">
            <p>
              {invoice.invoice_number ?? invoice.id.slice(0, 8)} · {invoice.status}
            </p>
            <p className="mt-1 text-muted-color">
              Total UGX {Number(invoice.total_amount).toLocaleString()} · Paid UGX{' '}
              {Number(invoice.paid_amount).toLocaleString()}
              {balanceDue != null ? ` · Balance UGX ${balanceDue.toLocaleString()}` : null}
            </p>
            <ul className="mt-3 space-y-1 text-xs text-secondary-color">
              {lineItems.map((line) => (
                <li key={line.id}>
                  {line.item_name} · {line.qty} × UGX {Number(line.unit_price).toLocaleString()}
                </li>
              ))}
            </ul>
            {balanceDue != null && balanceDue > 0 ? (
              <form onSubmit={collectPayment} className="mt-4 flex flex-wrap items-end gap-2">
                <label className="text-xs text-muted-color">
                  Amount (UGX)
                  <input
                    type="number"
                    min={1}
                    value={payAmount}
                    onChange={(e) => setPayAmount(e.target.value)}
                    className="mt-1 block w-32 rounded-lg border border-subtle bg-surface px-2 py-1.5 text-sm"
                  />
                </label>
                <label className="text-xs text-muted-color">
                  Method
                  <select
                    value={payMethod}
                    onChange={(e) => setPayMethod(e.target.value)}
                    className="mt-1 block rounded-lg border border-subtle bg-surface px-2 py-1.5 text-sm"
                  >
                    <option value="cash">Cash</option>
                    <option value="mobile_money">Mobile money</option>
                    <option value="card">Card</option>
                    <option value="bank_transfer">Bank transfer</option>
                  </select>
                </label>
                <button
                  type="submit"
                  disabled={paying}
                  className="rounded-lg px-4 py-2 text-xs font-semibold disabled:opacity-50"
                  style={{ background: 'var(--brand-orange)', color: '#07070A' }}
                >
                  {paying ? 'Collecting…' : 'Collect payment'}
                </button>
              </form>
            ) : null}
            {payStatus ? <p className="mt-2 text-xs text-emerald-700 dark:text-emerald-300">{payStatus}</p> : null}
            {payments.length > 0 ? (
              <ul className="mt-4 space-y-1 border-t border-subtle pt-3 text-xs">
                {payments.map((p) => (
                  <li key={p.id}>
                    {p.receipt_number ?? p.id.slice(0, 8)} · UGX {Number(p.amount).toLocaleString()} ·{' '}
                    {p.payment_method}
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        )}
      </section>

      <section className="mt-8">
        <h2 className="text-sm font-semibold uppercase text-muted-color">Lab orders</h2>
        <ul className="mt-3 space-y-2">
          {labOrders.map((o) => (
            <li key={o.id} className="clinical-card p-3 text-sm">
              {o.test_name} · {o.loinc_code} · {o.workflow_status ?? o.status}
            </li>
          ))}
          {labOrders.length === 0 ? <li className="text-xs text-muted-color">No lab orders.</li> : null}
        </ul>
      </section>

      <section className="mt-8">
        <h2 className="text-sm font-semibold uppercase text-muted-color">Prescriptions</h2>
        <ul className="mt-3 space-y-2">
          {prescriptions.map((rx) => (
            <li key={rx.id} className="clinical-card p-3 text-sm">
              {rx.medication_display} · qty {rx.quantity} · {rx.status}
              {rx.dose ? <span className="block text-xs text-muted-color">{rx.dose}</span> : null}
            </li>
          ))}
          {prescriptions.length === 0 ? <li className="text-xs text-muted-color">No prescriptions.</li> : null}
        </ul>
      </section>

      <section className="mt-8">
        <h2 className="text-sm font-semibold uppercase text-muted-color">Encounter timeline</h2>
        <ul className="mt-3 space-y-2">
          {timeline.map((ev) => (
            <li key={ev.id} className="clinical-card p-3 text-sm">
              <p className="font-medium">{ev.title}</p>
              {ev.summary ? <p className="text-xs text-muted-color">{ev.summary}</p> : null}
              <p className="mt-1 text-[10px] uppercase text-muted-color">
                {ev.event_type} · {new Date(ev.event_date).toLocaleString()}
              </p>
            </li>
          ))}
          {timeline.length === 0 ? <li className="text-xs text-muted-color">No timeline events yet.</li> : null}
        </ul>
      </section>
    </div>
  )
}
