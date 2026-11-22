'use client'

import Link from 'next/link'
import { useCallback, useEffect, useState } from 'react'
import { Activity, AlertOctagon, ArrowDownRight, ArrowUpRight, FileBarChart, MapPin, RefreshCw, Siren } from 'lucide-react'
import type { SurveillanceReport, SurveillanceSeries } from '@synapse/interop/epi-surveillance'

type Response = SurveillanceReport & { encounters: number; truncated: boolean }

const WINDOWS = [8, 12, 26, 52] as const

/** Weekly counts for one condition: thin bars, this week emphasised, hover for the week. */
function WeeklyBars({ s, weeks, alert }: { s: SurveillanceSeries; weeks: SurveillanceReport['weeks']; alert: boolean }) {
  const [hover, setHover] = useState<number | null>(null)
  const W = 260
  const H = 56
  const max = Math.max(1, ...s.counts)
  const step = W / s.counts.length
  const bw = Math.max(2, step - 2)
  const shown = hover ?? s.counts.length - 1
  return (
    <div>
      <div className="mb-1 flex items-baseline justify-between text-xs">
        <span className="text-muted-color">{weeks[shown]?.label}</span>
        <span className="font-mono text-primary-color">{s.counts[shown] ?? 0}</span>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="h-14 w-full" role="img" aria-label={`${s.label}: ${s.counts.join(', ')} cases per week`} onMouseLeave={() => setHover(null)}>
        {s.counts.map((c, i) => {
          const h = c === 0 ? 1 : Math.max(2, (c / max) * (H - 2))
          const last = i === s.counts.length - 1
          const cls = last && alert ? 'fill-red-600 dark:fill-red-500' : last ? 'fill-[#2a78d6] dark:fill-[#3987e5]' : 'fill-[#2a78d6]/45 dark:fill-[#3987e5]/45'
          return (
            <g key={i} onMouseEnter={() => setHover(i)}>
              <rect x={i * step} y={0} width={step} height={H} fill="transparent" />
              <rect x={i * step + 1} y={H - h} width={bw} height={h} rx={Math.min(2, bw / 2)} className={cls} />
            </g>
          )
        })}
      </svg>
    </div>
  )
}

export default function EpidemiologyPage() {
  const [weeks, setWeeks] = useState<number>(12)
  const [data, setData] = useState<Response | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  const load = useCallback(async (w: number) => {
    setLoading(true)
    try {
      const res = await fetch(`/api/hospital/reports/surveillance?weeks=${w}`, { credentials: 'include', cache: 'no-store' })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(res.status === 401 ? 'Sign in to see surveillance.' : res.status === 403 ? 'Your role cannot view surveillance reports.' : typeof body.error === 'string' ? body.error : 'Could not load surveillance.')
      setData(body as Response)
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load surveillance.')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load(weeks)
  }, [load, weeks])

  const alertKeys = new Set(data?.alerts.map((a) => a.key) ?? [])
  const change = data ? data.totals.thisWeek - data.totals.lastWeek : 0

  return (
    <main className="clinical-page mx-auto max-w-7xl space-y-5 px-4 py-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-xl font-semibold text-primary-color"><Activity className="h-5 w-5 text-orange" aria-hidden /> Surveillance</h1>
          <p className="text-sm text-secondary-color">Cases by epidemiological week (Monday start) from coded diagnoses at this facility. Alerts support the IDSR focal person; they do not replace the guidelines.</p>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex rounded-lg border border-subtle p-0.5" role="group" aria-label="Weeks shown">
            {WINDOWS.map((w) => (
              <button key={w} type="button" onClick={() => setWeeks(w)} className={`rounded-md px-2.5 py-1 text-xs font-medium ${weeks === w ? 'bg-orange-500 text-white' : 'text-secondary-color hover:text-primary-color'}`}>{w} wk</button>
            ))}
          </div>
          <button type="button" onClick={() => load(weeks)} className="btn-secondary inline-flex items-center !px-2.5 !py-1.5" aria-label="Refresh"><RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} /></button>
          <Link href="/doctor/reports" className="btn-secondary inline-flex items-center gap-1.5 !px-3 !py-1.5 text-xs"><FileBarChart className="h-3.5 w-3.5" aria-hidden /> HMIS 105</Link>
        </div>
      </div>

      {error && <p className="rounded-lg bg-red-500/10 px-3 py-2 text-sm text-red-600 dark:text-red-400">{error}</p>}
      {!data && !error && <div className="clinical-card h-64 animate-pulse" aria-busy="true" />}

      {data && (
        <>
          {data.alerts.length > 0 ? (
            <section aria-label="Alerts" className="space-y-2">
              {data.alerts.map((a) => (
                <div key={a.key} role="alert" className={`flex items-start gap-3 rounded-xl border p-3 ${a.level === 'immediate' ? 'border-red-500/50 bg-red-500/10' : 'border-amber-500/50 bg-amber-500/10'}`}>
                  {a.level === 'immediate' ? <Siren className="mt-0.5 h-5 w-5 shrink-0 text-red-600 dark:text-red-400" aria-hidden /> : <AlertOctagon className="mt-0.5 h-5 w-5 shrink-0 text-amber-600 dark:text-amber-400" aria-hidden />}
                  <div>
                    <div className="text-sm font-semibold text-primary-color">{a.label} <span className="ml-1 text-xs font-medium uppercase text-secondary-color">{a.level === 'immediate' ? 'Immediately notifiable' : 'Above threshold'}</span></div>
                    <div className="text-sm text-secondary-color">{a.message}</div>
                  </div>
                </div>
              ))}
            </section>
          ) : (
            <p className="rounded-xl border border-emerald-500/40 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-700 dark:text-emerald-300">No alerts this week.</p>
          )}

          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <div className="clinical-card p-4"><div className="text-xs uppercase tracking-wide text-muted-color">Cases this week</div><div className="font-mono text-3xl font-semibold text-primary-color">{data.totals.thisWeek}</div><div className="text-xs text-secondary-color">{data.weeks.at(-1)?.label}, so far</div></div>
            <div className="clinical-card p-4"><div className="text-xs uppercase tracking-wide text-muted-color">Last week</div><div className="font-mono text-3xl font-semibold text-primary-color">{data.totals.lastWeek}</div><div className="flex items-center gap-1 text-xs text-secondary-color">{change >= 0 ? <ArrowUpRight className="h-3 w-3" aria-hidden /> : <ArrowDownRight className="h-3 w-3" aria-hidden />}{Math.abs(change)} {change >= 0 ? 'more' : 'fewer'} this week</div></div>
            <div className="clinical-card p-4"><div className="text-xs uppercase tracking-wide text-muted-color">Cases, {data.weeks.length} weeks</div><div className="font-mono text-3xl font-semibold text-primary-color">{data.totals.cases}</div><div className="text-xs text-secondary-color">{data.encounters} visits</div></div>
            <div className="clinical-card p-4"><div className="text-xs uppercase tracking-wide text-muted-color">Alerts</div><div className={`font-mono text-3xl font-semibold ${data.alerts.length ? 'text-red-600 dark:text-red-400' : 'text-emerald-600 dark:text-emerald-400'}`}>{data.alerts.length}</div><div className="text-xs text-secondary-color">this week</div></div>
          </div>

          <section aria-label="Weekly cases by condition">
            <h2 className="mb-2 text-sm font-semibold text-primary-color">Weekly cases by condition</h2>
            {data.series.length === 0 ? (
              <p className="clinical-card p-6 text-sm text-muted-color">No coded diagnoses in this period.</p>
            ) : (
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {data.series.slice(0, 18).map((s) => (
                  <div key={s.key} className={`clinical-card p-3 ${alertKeys.has(s.key) ? 'border-red-500/50' : ''}`}>
                    <div className="flex items-start justify-between gap-2">
                      <div className="text-sm font-medium text-primary-color">{s.label}</div>
                      {s.notifiable && <span className="shrink-0 rounded bg-red-500/15 px-1 text-[10px] font-semibold text-red-700 dark:text-red-300">notifiable</span>}
                    </div>
                    <div className="text-xs text-muted-color">{s.total} in {data.weeks.length} weeks · last week {s.lastWeek}</div>
                    <WeeklyBars s={s} weeks={data.weeks} alert={alertKeys.has(s.key)} />
                  </div>
                ))}
              </div>
            )}
            <details className="mt-2 text-xs text-secondary-color">
              <summary className="cursor-pointer text-muted-color">Table view</summary>
              <div className="mt-2 overflow-x-auto">
                <table className="w-full min-w-[640px] text-left font-mono">
                  <thead className="text-muted-color"><tr><th className="py-1 pr-3 font-sans">Condition</th>{data.weeks.map((w) => <th key={w.start} className="px-1 text-right">{w.label.slice(5)}</th>)}</tr></thead>
                  <tbody>{data.series.map((s) => <tr key={s.key}><td className="py-0.5 pr-3 font-sans">{s.label}</td>{s.counts.map((c, i) => <td key={i} className="px-1 text-right">{c || '·'}</td>)}</tr>)}</tbody>
                </table>
              </div>
            </details>
          </section>

          <section className="clinical-card p-4" aria-label="Cases by district">
            <h2 className="flex items-center gap-2 text-sm font-semibold text-primary-color"><MapPin className="h-4 w-4 text-orange" aria-hidden /> Where patients come from</h2>
            <p className="text-xs text-muted-color">By the district recorded at registration.</p>
            <div className="mt-2 overflow-x-auto">
              <table className="w-full min-w-[480px] text-left text-sm">
                <thead className="text-xs uppercase tracking-wide text-muted-color"><tr><th className="py-2 pr-3">District</th><th className="pr-3 text-right">Cases</th><th>Leading conditions</th></tr></thead>
                <tbody className="divide-y divide-[var(--border-subtle)]">
                  {data.districts.map((d) => (
                    <tr key={d.district}>
                      <td className={`py-2 pr-3 ${d.district === 'Not recorded' ? 'text-muted-color' : 'text-primary-color'}`}>{d.district}</td>
                      <td className="pr-3 text-right font-mono">{d.total}</td>
                      <td className="text-secondary-color">{d.byCategory.slice(0, 3).map((c) => `${data.series.find((s) => s.key === c.key)?.label ?? c.key} (${c.count})`).join(', ')}</td>
                    </tr>
                  ))}
                  {data.districts.length === 0 && <tr><td colSpan={3} className="py-3 text-muted-color">No cases in this period.</td></tr>}
                </tbody>
              </table>
            </div>
          </section>
          {data.truncated && <p className="text-xs text-amber-700 dark:text-amber-300">Very busy period: figures use the most recent 30,000 visits.</p>}
        </>
      )}
    </main>
  )
}
