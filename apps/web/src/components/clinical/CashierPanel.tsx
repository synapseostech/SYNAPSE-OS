'use client'

import { useCallback, useEffect, useRef, useState } from 'react'

type QueueInvoice = {
  id: string
  invoiceNumber: string | null
  status: string
  totalAmount: number
  paidAmount: number
  insuranceCover: number
  balanceDue: number
  encounterId: string | null
  patientName: string | null
  mrn: string | null
  createdAt: string
}

type Detail = {
  invoice: {
    id: string
    invoice_number: string | null
    status: string
    total_amount: number
    paid_amount: number
    insurance_cover_amount?: number | null
    balance_due: number
    encounter_id: string | null
  }
  lineItems: Array<{ id: string; item_name: string; qty: number; unit_price: number; total_price: number }>
  payments: Array<{ id: string; amount: number; payment_method: string; receipt_number: string | null; created_at: string }>
  patient: { fullName: string; mrn: string | null; phone: string | null } | null
  policies: Array<{ id: string; insurerName: string; memberNumber: string; scheme: string | null }>
}

const ugx = (n: number) => `UGX ${Math.round(Number(n) || 0).toLocaleString()}`

const METHODS = [
  ['cash', 'Cash'],
  ['mobile_money', 'Mobile money'],
  ['card', 'Card'],
  ['bank_transfer', 'Bank transfer'],
] as const

async function readError(res: Response, fallback: string): Promise<string> {
  const data = await res.json().catch(() => ({}))
  if (typeof data.error === 'string') return data.error.replace(/_/g, ' ').toLowerCase()
  return fallback
}

export function CashierPanel() {
  const [status, setStatus] = useState<'open' | 'paid'>('open')
  const [invoices, setInvoices] = useState<QueueInvoice[]>([])
  const [nextBefore, setNextBefore] = useState<string | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [detail, setDetail] = useState<Detail | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const [amount, setAmount] = useState('')
  const [method, setMethod] = useState<string>('cash')
  const [reference, setReference] = useState('')
  const payKey = useRef<string | null>(null)

  const [coverAmount, setCoverAmount] = useState('')
  const [policyId, setPolicyId] = useState('')
  const [insurer, setInsurer] = useState('')
  const [member, setMember] = useState('')

  const loadQueue = useCallback(
    async (before?: string | null) => {
      const qs = new URLSearchParams({ status, limit: '25' })
      if (before) qs.set('before', before)
      const res = await fetch(`/api/hospital/billing/invoices?${qs}`, { credentials: 'include' })
      if (!res.ok) {
        setError(res.status === 403 ? 'Your role cannot see invoices.' : await readError(res, 'Could not load invoices'))
        return
      }
      const data = await res.json()
      setInvoices((prev) => (before ? [...prev, ...(data.invoices ?? [])] : data.invoices ?? []))
      setNextBefore(data.nextBefore ?? null)
      setError(null)
    },
    [status],
  )

  const loadDetail = useCallback(async (id: string) => {
    const res = await fetch(`/api/hospital/billing/invoices/${id}`, { credentials: 'include' })
    if (!res.ok) {
      setError(await readError(res, 'Could not load invoice'))
      return
    }
    const data = (await res.json()) as Detail
    setDetail(data)
    setAmount(data.invoice.balance_due > 0 ? String(data.invoice.balance_due) : '')
    setPolicyId(data.policies[0]?.id ?? '')
    setCoverAmount(data.invoice.insurance_cover_amount ? String(data.invoice.insurance_cover_amount) : '')
  }, [])

  useEffect(() => {
    loadQueue().catch(() => setError('Could not load invoices'))
  }, [loadQueue])

  useEffect(() => {
    if (selected) loadDetail(selected).catch(() => setError('Could not load invoice'))
    else setDetail(null)
  }, [selected, loadDetail])

  async function refresh() {
    await loadQueue()
    if (selected) await loadDetail(selected)
  }

  async function takePayment(e: React.FormEvent) {
    e.preventDefault()
    if (!detail?.invoice.encounter_id) return
    const value = Number(amount)
    if (!value || value <= 0) return
    setBusy(true)
    setNotice(null)
    payKey.current ??= `cashier:${detail.invoice.id}:${crypto.randomUUID()}`
    try {
      const res = await fetch(`/api/hospital/billing/encounter/${detail.invoice.encounter_id}/pay`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          amount: value,
          payment_method: method,
          payment_ref: reference.trim() || undefined,
          idempotency_key: payKey.current,
        }),
      })
      if (!res.ok) {
        setNotice(await readError(res, 'Payment failed'))
        return
      }
      const data = await res.json()
      payKey.current = null
      setReference('')
      setNotice(`Receipt ${data.payment?.receiptNumber ?? ''} · balance ${ugx(data.payment?.balanceDue ?? 0)}`)
      await refresh()
    } finally {
      setBusy(false)
    }
  }

  async function applyCover(e: React.FormEvent) {
    e.preventDefault()
    if (!detail) return
    setBusy(true)
    setNotice(null)
    const body: Record<string, unknown> = { cover_amount: Number(coverAmount) || 0 }
    if (policyId) body.policy_id = policyId
    else {
      body.insurer_name = insurer.trim()
      body.member_number = member.trim()
    }
    try {
      const res = await fetch(`/api/hospital/billing/invoices/${detail.invoice.id}/cover`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!res.ok) {
        setNotice(await readError(res, 'Could not apply insurance'))
        return
      }
      const data = await res.json()
      setNotice(
        Number(data.cover?.insuranceCover) > 0
          ? `Insurance covers ${ugx(data.cover.insuranceCover)} · draft claim ready for the claims desk`
          : 'Insurance cover removed',
      )
      await refresh()
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
      <section aria-labelledby="cashier-queue">
        <div className="flex items-center justify-between">
          <h1 id="cashier-queue" className="font-display text-2xl">Cashier</h1>
          <div className="flex gap-1 text-xs" role="tablist" aria-label="Invoice status">
            {(['open', 'paid'] as const).map((s) => (
              <button
                key={s}
                role="tab"
                aria-selected={status === s}
                onClick={() => {
                  setStatus(s)
                  setSelected(null)
                }}
                className={`rounded-lg border px-3 py-1 ${status === s ? 'border-teal-600 text-teal-700 dark:text-teal-300' : 'border-subtle text-muted-color'}`}
              >
                {s === 'open' ? 'To pay' : 'Paid'}
              </button>
            ))}
          </div>
        </div>
        {error ? <p className="mt-4 text-sm text-amber-700 dark:text-amber-300">{error}</p> : null}
        <ul className="mt-4 divide-y divide-subtle rounded-xl border border-subtle">
          {invoices.map((inv) => (
            <li key={inv.id}>
              <button
                type="button"
                onClick={() => setSelected(inv.id)}
                aria-current={selected === inv.id}
                className={`flex w-full items-center justify-between gap-3 px-4 py-3 text-left text-sm hover:bg-overlay/40 ${selected === inv.id ? 'bg-overlay/60' : ''}`}
              >
                <span>
                  <span className="font-medium">{inv.patientName ?? 'Unknown patient'}</span>
                  <span className="block text-xs text-muted-color">
                    {inv.mrn ?? '—'} · {inv.invoiceNumber ?? inv.id.slice(0, 8)} · {new Date(inv.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                  </span>
                </span>
                <span className="text-right">
                  <span className="font-mono">{ugx(inv.balanceDue)}</span>
                  {inv.insuranceCover > 0 ? <span className="block text-xs text-muted-color">insured {ugx(inv.insuranceCover)}</span> : null}
                </span>
              </button>
            </li>
          ))}
          {invoices.length === 0 && !error ? (
            <li className="px-4 py-8 text-center text-sm text-muted-color">{status === 'open' ? 'Nothing to collect.' : 'No paid invoices yet.'}</li>
          ) : null}
        </ul>
        {nextBefore ? (
          <button type="button" onClick={() => loadQueue(nextBefore)} className="mt-3 text-xs text-teal-700 hover:underline dark:text-teal-300">
            Load more
          </button>
        ) : null}
      </section>

      <section aria-label="Invoice detail">
        {!detail ? (
          <p className="mt-12 text-sm text-muted-color">Select an invoice to take payment or apply insurance.</p>
        ) : (
          <div className="clinical-card p-5 text-sm">
            <h2 className="font-display text-lg">{detail.patient?.fullName ?? 'Patient'}</h2>
            <p className="text-xs text-muted-color">
              {detail.patient?.mrn ?? '—'} · {detail.invoice.invoice_number ?? detail.invoice.id.slice(0, 8)} · {detail.invoice.status.replace('_', ' ')}
            </p>

            <table className="mt-4 w-full text-xs">
              <tbody className="divide-y divide-subtle">
                {detail.lineItems.map((l) => (
                  <tr key={l.id}>
                    <td className="py-1.5">{l.item_name}</td>
                    <td className="py-1.5 text-right text-muted-color">{l.qty} × {ugx(l.unit_price)}</td>
                    <td className="py-1.5 text-right font-mono">{ugx(l.total_price)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <dl className="mt-3 grid grid-cols-2 gap-y-1 text-xs">
              <dt className="text-muted-color">Total</dt>
              <dd className="text-right font-mono">{ugx(detail.invoice.total_amount)}</dd>
              <dt className="text-muted-color">Insurance</dt>
              <dd className="text-right font-mono">− {ugx(detail.invoice.insurance_cover_amount ?? 0)}</dd>
              <dt className="text-muted-color">Paid</dt>
              <dd className="text-right font-mono">− {ugx(detail.invoice.paid_amount)}</dd>
              <dt className="font-semibold">Patient owes</dt>
              <dd className="text-right font-mono font-semibold">{ugx(detail.invoice.balance_due)}</dd>
            </dl>

            {notice ? <p className="mt-4 rounded-lg bg-overlay/60 px-3 py-2 text-xs" role="status">{notice}</p> : null}

            {detail.invoice.balance_due > 0 && detail.invoice.encounter_id ? (
              <form onSubmit={takePayment} className="mt-5 grid gap-2 sm:grid-cols-[1fr_1fr_1fr_auto] sm:items-end">
                <label className="text-xs text-muted-color">
                  Amount (UGX)
                  <input type="number" min={1} max={detail.invoice.balance_due} value={amount} onChange={(e) => setAmount(e.target.value)}
                    className="mt-1 block w-full rounded-lg border border-subtle bg-surface px-2 py-1.5 text-sm" required />
                </label>
                <label className="text-xs text-muted-color">
                  Method
                  <select value={method} onChange={(e) => setMethod(e.target.value)} className="mt-1 block w-full rounded-lg border border-subtle bg-surface px-2 py-1.5 text-sm">
                    {METHODS.map(([v, label]) => <option key={v} value={v}>{label}</option>)}
                  </select>
                </label>
                <label className="text-xs text-muted-color">
                  Reference
                  <input value={reference} onChange={(e) => setReference(e.target.value)} placeholder={method === 'mobile_money' ? 'MoMo transaction ID' : 'Optional'}
                    className="mt-1 block w-full rounded-lg border border-subtle bg-surface px-2 py-1.5 text-sm" maxLength={120} />
                </label>
                <button type="submit" disabled={busy} className="rounded-lg bg-teal-700 px-4 py-2 text-xs font-medium text-white disabled:opacity-50">
                  {busy ? 'Saving…' : 'Take payment'}
                </button>
              </form>
            ) : null}

            <details className="mt-6" open={Boolean(detail.invoice.insurance_cover_amount)}>
              <summary className="cursor-pointer text-xs font-semibold uppercase text-muted-color">Insurance</summary>
              <form onSubmit={applyCover} className="mt-3 grid gap-2 sm:grid-cols-2">
                {detail.policies.length ? (
                  <label className="text-xs text-muted-color sm:col-span-2">
                    Policy
                    <select value={policyId} onChange={(e) => setPolicyId(e.target.value)} className="mt-1 block w-full rounded-lg border border-subtle bg-surface px-2 py-1.5 text-sm">
                      {detail.policies.map((p) => (
                        <option key={p.id} value={p.id}>{p.insurerName} · {p.memberNumber}{p.scheme ? ` · ${p.scheme}` : ''}</option>
                      ))}
                      <option value="">New insurer or member number…</option>
                    </select>
                  </label>
                ) : null}
                {!policyId ? (
                  <>
                    <label className="text-xs text-muted-color">
                      Insurer
                      <input value={insurer} onChange={(e) => setInsurer(e.target.value)} placeholder="e.g. Jubilee, AAR, UAP Old Mutual"
                        className="mt-1 block w-full rounded-lg border border-subtle bg-surface px-2 py-1.5 text-sm" />
                    </label>
                    <label className="text-xs text-muted-color">
                      Member number
                      <input value={member} onChange={(e) => setMember(e.target.value)}
                        className="mt-1 block w-full rounded-lg border border-subtle bg-surface px-2 py-1.5 text-sm" />
                    </label>
                  </>
                ) : null}
                <label className="text-xs text-muted-color">
                  Insurer pays (UGX)
                  <input type="number" min={0} value={coverAmount} onChange={(e) => setCoverAmount(e.target.value)}
                    className="mt-1 block w-full rounded-lg border border-subtle bg-surface px-2 py-1.5 text-sm" required />
                </label>
                <div className="flex items-end">
                  <button type="submit" disabled={busy} className="rounded-lg border border-teal-600 px-4 py-2 text-xs font-medium text-teal-700 disabled:opacity-50 dark:text-teal-300">
                    {Number(coverAmount) === 0 ? 'Remove cover' : 'Apply cover'}
                  </button>
                </div>
              </form>
            </details>

            {detail.payments.length ? (
              <section className="mt-6">
                <h3 className="text-xs font-semibold uppercase text-muted-color">Receipts</h3>
                <ul className="mt-2 space-y-1 text-xs">
                  {detail.payments.map((p) => (
                    <li key={p.id} className="flex justify-between">
                      <span>{p.receipt_number ?? p.id.slice(0, 8)} · {p.payment_method.replace('_', ' ')}</span>
                      <span className="font-mono">{ugx(p.amount)}</span>
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}
          </div>
        )}
      </section>
    </div>
  )
}
