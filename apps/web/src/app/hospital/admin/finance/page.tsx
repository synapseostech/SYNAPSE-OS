'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { Banknote, Clock, HandCoins, Landmark, ShieldX, Wallet } from 'lucide-react'
import type { AgeingBuckets, FinanceDashboard } from '@/lib/hospital-reports/finance'

type Response = FinanceDashboard & { periodKey: string; truncated: boolean }

function money(n: number, currency: string) {
  return `${currency} ${Math.round(n).toLocaleString()}`
}

function months() {
  const out: { value: string; label: string }[] = []
  const now = new Date(Date.now() + 3 * 3_600_000)
  for (let i = 0; i < 13; i += 1) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1))
    out.push({ value: `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}`, label: d.toLocaleDateString(undefined, { month: 'long', year: 'numeric', timeZone: 'UTC' }) })
  }
  return out
}

function Ageing({ a, currency }: { a: AgeingBuckets; currency: string }) {
  const rows: [string, number][] = [['0–30 days', a.d0_30], ['31–60 days', a.d31_60], ['61–90 days', a.d61_90], ['Over 90 days', a.d90_plus]]
  const max = Math.max(1, ...rows.map(([, v]) => v))
  return (
    <ul className="space-y-2">
      {rows.map(([label, v], i) => (
        <li key={label}>
          <div className="flex justify-between text-sm"><span className="text-secondary-color">{label}</span><span className={`font-mono ${i === 3 && v > 0 ? 'text-amber-700 dark:text-amber-400' : 'text-primary-color'}`}>{money(v, currency)}</span></div>
          <div className="mt-1 h-2 overflow-hidden rounded-full bg-elevated" aria-hidden>
            <div className={`h-full rounded-full ${['bg-[#86b6ef]', 'bg-[#5598e7]', 'bg-[#2a78d6]', 'bg-[#1c5cab]'][i]}`} style={{ width: `${(v / max) * 100}%` }} />
          </div>
        </li>
      ))}
    </ul>
  )
}

function DailyChart({ daily, currency }: { daily: FinanceDashboard['daily']; currency: string }) {
  const [hover, setHover] = useState<number | null>(null)
  const W = 720
  const H = 150
  const max = Math.max(1, ...daily.flatMap((d) => [d.billed, d.collected]))
  const step = W / Math.max(1, daily.length)
  const bw = Math.max(2, step / 2 - 2)
  const h = hover != null ? daily[hover] : null
  return (
    <div>
      <div className="mb-2 flex flex-wrap items-center gap-4 text-xs text-secondary-color">
        <span className="flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-sm bg-[#2a78d6] dark:bg-[#3987e5]" /> Billed</span>
        <span className="flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-sm bg-[#eb6834] dark:bg-[#d95926]" /> Collected</span>
        <span className="ml-auto font-mono text-muted-color">{h ? `${h.date}: billed ${money(h.billed, currency)} · collected ${money(h.collected, currency)}` : 'Hover a day for amounts'}</span>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="h-40 w-full" role="img" aria-label="Billed and collected per day" onMouseLeave={() => setHover(null)}>
        <line x1={0} x2={W} y1={H - 1} y2={H - 1} stroke="var(--border-subtle)" />
        {daily.map((d, i) => {
          const x = i * step
          const bh = (v: number) => (v > 0 ? Math.max(1, (v / max) * (H - 4)) : 0)
          return (
            <g key={d.date} onMouseEnter={() => setHover(i)}>
              <rect x={x} y={0} width={step} height={H} fill={hover === i ? 'var(--shimmer-base)' : 'transparent'} />
              <rect x={x + 1} y={H - bh(d.billed)} width={bw} height={bh(d.billed)} rx={2} className="fill-[#2a78d6] dark:fill-[#3987e5]" />
              <rect x={x + 1 + bw + 1} y={H - bh(d.collected)} width={bw} height={bh(d.collected)} rx={2} className="fill-[#eb6834] dark:fill-[#d95926]" />
            </g>
          )
        })}
      </svg>
      <details className="mt-1 text-xs text-secondary-color">
        <summary className="cursor-pointer text-muted-color">Table view</summary>
        <table className="mt-2 w-full text-left font-mono"><thead className="text-muted-color"><tr><th>Day</th><th className="text-right">Billed</th><th className="text-right">Collected</th></tr></thead>
          <tbody>{daily.map((d) => <tr key={d.date}><td>{d.date}</td><td className="text-right">{Math.round(d.billed).toLocaleString()}</td><td className="text-right">{Math.round(d.collected).toLocaleString()}</td></tr>)}</tbody></table>
      </details>
    </div>
  )
}

export default function FinancePage() {
  const opts = useMemo(months, [])
  const [period, setPeriod] = useState(opts[0]!.value)
  const [data, setData] = useState<Response | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async (p: string) => {
    try {
      const res = await fetch(`/api/hospital/reports/finance?period=${p}`, { credentials: 'include', cache: 'no-store' })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(res.status === 403 ? 'Finance is for facility administrators.' : typeof body.error === 'string' ? body.error : 'Could not load finance.')
      setData(body as Response)
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load finance.')
    }
  }, [])
  useEffect(() => { void load(period) }, [load, period])

  const c = data?.currency ?? 'UGX'
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-primary-color">Finance</h1>
          <p className="text-sm text-secondary-color">Billing, collections, what patients and insurers still owe.</p>
        </div>
        <select value={period} onChange={(e) => setPeriod(e.target.value)} aria-label="Month" className="rounded-lg border border-subtle bg-surface px-2.5 py-1.5 text-sm text-primary-color">
          {opts.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      </div>
      {error && <p className="rounded-lg bg-red-500/10 px-3 py-2 text-sm text-red-600 dark:text-red-400">{error}</p>}
      {!data && !error && <div className="clinical-card h-64 animate-pulse" aria-busy="true" />}
      {data && (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
            {[
              { icon: Banknote, label: 'Billed', value: money(data.billed, c), sub: `${data.invoices} invoices` },
              { icon: HandCoins, label: 'Collected', value: money(data.collected, c), sub: data.collectionRate == null ? 'no billing yet' : `${data.collectionRate}% of billed` },
              { icon: Wallet, label: 'Patients owe', value: money(data.patientBalance.total, c), sub: `${data.patientBalance.invoices} open invoices` },
              { icon: Landmark, label: 'Insurers owe', value: money(data.insurance.receivable, c), sub: `${money(data.insurance.paidInPeriod, c)} paid this month` },
              { icon: ShieldX, label: 'Claims denied', value: String(data.insurance.denials.reduce((a, d) => a + d.count, 0)), sub: money(data.insurance.denials.reduce((a, d) => a + d.amount, 0), c) },
            ].map(({ icon: Icon, label, value, sub }) => (
              <div key={label} className="clinical-card p-4">
                <div className="flex items-center gap-1.5 text-xs uppercase tracking-wide text-muted-color"><Icon className="h-3.5 w-3.5" aria-hidden /> {label}</div>
                <div className="mt-1 font-mono text-xl font-semibold text-primary-color">{value}</div>
                <div className="text-xs text-secondary-color">{sub}</div>
              </div>
            ))}
          </div>

          <section className="clinical-card p-4"><h2 className="mb-2 text-sm font-semibold text-primary-color">Billed and collected, by day</h2><DailyChart daily={data.daily} currency={c} /></section>

          <div className="grid gap-4 lg:grid-cols-3">
            <section className="clinical-card p-4"><h2 className="mb-3 flex items-center gap-2 text-sm font-semibold text-primary-color"><Clock className="h-4 w-4 text-orange" aria-hidden /> Patient balances by age</h2><Ageing a={data.patientBalance.ageing} currency={c} /></section>
            <section className="clinical-card p-4"><h2 className="mb-3 flex items-center gap-2 text-sm font-semibold text-primary-color"><Clock className="h-4 w-4 text-orange" aria-hidden /> Insurance claims by age</h2><Ageing a={data.insurance.ageing} currency={c} /></section>
            <section className="clinical-card p-4">
              <h2 className="mb-2 text-sm font-semibold text-primary-color">Collections by method</h2>
              <ul className="space-y-1 text-sm">{data.byMethod.map((m) => <li key={m.method} className="flex justify-between"><span className="capitalize text-secondary-color">{m.method}</span><span className="font-mono">{money(m.amount, c)}</span></li>)}{data.byMethod.length === 0 && <li className="text-muted-color">No payments this month.</li>}</ul>
            </section>
          </div>

          <div className="grid gap-4 lg:grid-cols-3">
            <section className="clinical-card p-4 lg:col-span-1">
              <h2 className="mb-2 text-sm font-semibold text-primary-color">Top services</h2>
              <ul className="space-y-1 text-sm">{data.topServices.map((s) => <li key={s.item} className="flex justify-between gap-2"><span className="truncate text-secondary-color">{s.item} <span className="text-muted-color">×{s.count}</span></span><span className="font-mono">{money(s.amount, c)}</span></li>)}{data.topServices.length === 0 && <li className="text-muted-color">No billed services this month.</li>}</ul>
            </section>
            <section className="clinical-card p-4">
              <h2 className="mb-2 text-sm font-semibold text-primary-color">Owed by insurer</h2>
              <ul className="space-y-1 text-sm">{data.insurance.byInsurer.map((i) => <li key={i.insurer} className="flex justify-between gap-2"><span className="truncate text-secondary-color">{i.insurer} <span className="text-muted-color">({i.claims})</span></span><span className="font-mono">{money(i.outstanding, c)}</span></li>)}{data.insurance.byInsurer.length === 0 && <li className="text-muted-color">No open claims.</li>}</ul>
            </section>
            <section className="clinical-card p-4">
              <h2 className="mb-2 text-sm font-semibold text-primary-color">Why claims were denied</h2>
              <ul className="space-y-1 text-sm">{data.insurance.denials.map((d) => <li key={d.reason} className="flex justify-between gap-2"><span className="truncate text-secondary-color">{d.reason} <span className="text-muted-color">({d.count})</span></span><span className="font-mono">{money(d.amount, c)}</span></li>)}{data.insurance.denials.length === 0 && <li className="text-muted-color">No denials.</li>}</ul>
            </section>
          </div>
          {(data.otherCurrencyRows > 0 || data.truncated) && (
            <p className="text-xs text-amber-700 dark:text-amber-300">
              {data.otherCurrencyRows > 0 ? `${data.otherCurrencyRows} invoices or payments in another currency are not included in these totals. ` : ''}
              {data.truncated ? 'Very busy month: figures use the first 20,000 records of each kind.' : ''}
            </p>
          )}
        </>
      )}
    </div>
  )
}
