"use client"

import Link from "next/link"
import { useCallback, useEffect, useState } from "react"
import { AlertTriangle, Clock, FlaskConical, RefreshCw, ShieldAlert, Timer, TrendingUp, XCircle } from "lucide-react"
import type { LabDashboard } from "@/lib/lab/dashboard"
import { LAB_SECTION_LABEL } from "@/lib/lab/sections"
import { labApi, LabApiError, STATUS_LABEL } from "./_components/client"

const REFRESH_MS = 60_000

function minutes(m: number | null): string {
  if (m == null) return "–"
  if (m < 60) return `${Math.round(m)} min`
  const h = Math.floor(m / 60)
  const r = Math.round(m % 60)
  return r ? `${h} h ${r} min` : `${h} h`
}

function sectionLabel(s: string) {
  return LAB_SECTION_LABEL[s as keyof typeof LAB_SECTION_LABEL] ?? s
}

function Tile({ label, value, sub, tone, icon: Icon, href }: { label: string; value: string; sub?: string; tone?: "danger" | "warning" | "good"; icon: typeof Clock; href?: string }) {
  const toneClass = tone === "danger" ? "text-red-600 dark:text-red-400" : tone === "warning" ? "text-amber-600 dark:text-amber-400" : tone === "good" ? "text-emerald-600 dark:text-emerald-400" : "text-primary-color"
  const body = (
    <div className="clinical-card h-full p-4 transition hover:border-strong">
      <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-muted-color">
        <Icon className="h-3.5 w-3.5" aria-hidden /> {label}
      </div>
      <div className={`mt-1 font-mono text-3xl font-semibold ${toneClass}`}>{value}</div>
      {sub && <div className="mt-0.5 text-xs text-secondary-color">{sub}</div>}
    </div>
  )
  return href ? <Link href={href}>{body}</Link> : body
}

/** Ordered vs released per day: grouped bars, one y-axis, hover for exact counts. */
function VolumeChart({ volume }: { volume: LabDashboard["volume"] }) {
  const [hover, setHover] = useState<number | null>(null)
  const W = 640
  const H = 160
  const pad = { l: 28, r: 8, t: 8, b: 22 }
  const max = Math.max(1, ...volume.flatMap((v) => [v.ordered, v.released]))
  const step = (W - pad.l - pad.r) / Math.max(1, volume.length)
  const bw = Math.max(3, Math.min(14, step / 2 - 3))
  const y = (n: number) => pad.t + (H - pad.t - pad.b) * (1 - n / max)
  const ticks = [0, Math.round(max / 2), max]
  const day = (d: string) => new Date(`${d}T12:00:00Z`).toLocaleDateString(undefined, { day: "numeric", month: "short" })
  const h = hover != null ? volume[hover] : null

  return (
    <div>
      <div className="mb-2 flex items-center gap-4 text-xs text-secondary-color" aria-hidden>
        <span className="flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-sm bg-[#2a78d6] dark:bg-[#3987e5]" /> Ordered</span>
        <span className="flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-sm bg-[#eb6834] dark:bg-[#d95926]" /> Released</span>
        <span className="ml-auto font-mono text-muted-color">
          {h ? `${day(h.date)}: ${h.ordered} ordered · ${h.released} released` : "Hover a day for counts"}
        </span>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} className="h-44 w-full" role="img" aria-label={`Tests ordered and released per day, last ${volume.length} days`}>
        {ticks.map((t) => (
          <g key={t}>
            <line x1={pad.l} x2={W - pad.r} y1={y(t)} y2={y(t)} stroke="var(--border-subtle)" />
            <text x={pad.l - 6} y={y(t) + 3} textAnchor="end" fontSize="10" fill="var(--text-muted)">{t}</text>
          </g>
        ))}
        {volume.map((v, i) => {
          const x0 = pad.l + i * step + step / 2
          const bar = (n: number, x: number, cls: string) =>
            n > 0 ? <rect x={x} y={y(n)} width={bw} height={Math.max(1, y(0) - y(n))} rx={Math.min(4, bw / 2)} className={cls} /> : null
          return (
            <g key={v.date} onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)}>
              <rect x={pad.l + i * step} y={pad.t} width={step} height={H - pad.t - pad.b} fill={hover === i ? "var(--shimmer-base)" : "transparent"} />
              {bar(v.ordered, x0 - bw - 1, "fill-[#2a78d6] dark:fill-[#3987e5]")}
              {bar(v.released, x0 + 1, "fill-[#eb6834] dark:fill-[#d95926]")}
              {(i % Math.ceil(volume.length / 7) === 0 || i === volume.length - 1) && (
                <text x={x0} y={H - 6} textAnchor="middle" fontSize="10" fill="var(--text-muted)">{day(v.date)}</text>
              )}
              <title>{`${day(v.date)}: ${v.ordered} ordered, ${v.released} released`}</title>
            </g>
          )
        })}
      </svg>
      <details className="mt-1 text-xs text-secondary-color">
        <summary className="cursor-pointer text-muted-color">Table view</summary>
        <table className="mt-2 w-full text-left font-mono">
          <thead className="text-muted-color"><tr><th className="py-1">Day</th><th>Ordered</th><th>Released</th></tr></thead>
          <tbody>{volume.map((v) => <tr key={v.date}><td className="py-0.5">{day(v.date)}</td><td>{v.ordered}</td><td>{v.released}</td></tr>)}</tbody>
        </table>
      </details>
    </div>
  )
}

export default function LabDashboardPage() {
  const [data, setData] = useState<(LabDashboard & { truncated?: boolean }) | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      setData(await labApi<LabDashboard & { truncated?: boolean }>("/api/lab/dashboard"))
      setError(null)
    } catch (e) {
      setError(e instanceof LabApiError ? e.message : "Could not load the dashboard.")
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
    const t = setInterval(() => { if (document.visibilityState === "visible") void load() }, REFRESH_MS)
    return () => clearInterval(t)
  }, [load])

  if (error && !data) {
    return (
      <div className="clinical-card p-6">
        <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
        <button type="button" onClick={load} className="btn-secondary mt-3 text-sm">Try again</button>
      </div>
    )
  }
  if (!data) {
    return <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-6" aria-busy="true">{Array.from({ length: 6 }, (_, i) => <div key={i} className="clinical-card h-28 animate-pulse" />)}</div>
  }

  const open = data.stages.reduce((a, s) => a + s.count, 0)
  const maxStage = Math.max(1, ...data.stages.map((s) => s.count))
  const within = data.tat.withinTargetPct

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h1 className="text-xl font-semibold text-primary-color">Laboratory dashboard</h1>
          <p className="text-sm text-secondary-color">Live: refreshes every minute. Turnaround is order to authorisation, against each test’s target in the catalogue.</p>
        </div>
        <button type="button" onClick={load} className="btn-secondary inline-flex items-center gap-2 !px-3 !py-1.5 text-xs" disabled={loading}>
          <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} aria-hidden /> {new Date(data.generatedAt).toLocaleTimeString()}
        </button>
      </div>

      {data.truncated && <p className="rounded-lg bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">Very busy fortnight: figures use the most recent 6,000 orders.</p>}

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <Tile icon={FlaskConical} label="Open now" value={String(open)} sub={`${data.today.ordered} ordered today · ${data.today.stat} STAT`} href="/lab/orders" />
        <Tile icon={AlertTriangle} label="Overdue" value={String(data.overdueTotal)} tone={data.overdueTotal ? "warning" : "good"} sub="past their turnaround target" />
        <Tile icon={ShieldAlert} label="Critical, not phoned" value={String(data.criticalOpen)} tone={data.criticalOpen ? "danger" : "good"} sub="awaiting acknowledgement" href="/lab/critical" />
        <Tile icon={Timer} label="Median turnaround" value={minutes(data.tat.medianMinutes)} sub={`90% within ${minutes(data.tat.p90Minutes)} · ${data.tat.sample} tests`} />
        <Tile icon={Clock} label="Within target" value={within == null ? "–" : `${within}%`} tone={within == null ? undefined : within >= 90 ? "good" : within >= 75 ? "warning" : "danger"} sub={`last ${data.windowDays} days`} />
        <Tile icon={XCircle} label="Rejected" value={String(data.rejections.total)} tone={data.rejections.total ? "warning" : undefined} sub={`${data.today.rejected} today · ${data.today.released} released today`} />
      </div>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)]">
        <section className="clinical-card p-4" aria-label="Work by stage">
          <h2 className="text-sm font-semibold text-primary-color">Where the work is</h2>
          <ul className="mt-3 space-y-2.5">
            {data.stages.map((s) => (
              <li key={s.key}>
                <div className="flex items-baseline justify-between text-sm">
                  <span className="text-secondary-color">{s.label}</span>
                  <span className="font-mono text-primary-color">{s.count}{s.stat ? <span className="ml-1.5 text-xs text-red-600 dark:text-red-400">{s.stat} STAT</span> : null}</span>
                </div>
                <div className="mt-1 h-2 overflow-hidden rounded-full bg-elevated" aria-hidden>
                  <div className="h-full rounded-full bg-[#2a78d6] dark:bg-[#3987e5]" style={{ width: `${(s.count / maxStage) * 100}%` }} />
                </div>
              </li>
            ))}
          </ul>
        </section>

        <section className="clinical-card p-4" aria-label="Volume">
          <h2 className="mb-2 flex items-center gap-2 text-sm font-semibold text-primary-color"><TrendingUp className="h-4 w-4 text-orange" aria-hidden /> Volume, last {data.windowDays} days</h2>
          <VolumeChart volume={data.volume} />
        </section>
      </div>

      <section className="clinical-card p-4" aria-label="Overdue samples">
        <h2 className="text-sm font-semibold text-primary-color">Overdue now{data.overdueTotal > data.overdue.length ? ` (most late ${data.overdue.length} of ${data.overdueTotal})` : ""}</h2>
        {data.overdue.length === 0 ? (
          <p className="mt-2 text-sm text-emerald-700 dark:text-emerald-400">Nothing is past its target. Well done.</p>
        ) : (
          <div className="mt-2 overflow-x-auto">
            <table className="w-full min-w-[640px] text-left text-sm">
              <thead className="text-xs uppercase tracking-wide text-muted-color">
                <tr><th className="py-2 pr-3">Accession</th><th className="pr-3">Test</th><th className="pr-3">Patient</th><th className="pr-3">Section</th><th className="pr-3">Stage</th><th className="pr-3 text-right">Open</th><th className="text-right">Late by</th></tr>
              </thead>
              <tbody className="divide-y divide-[var(--border-subtle)]">
                {data.overdue.map((o) => (
                  <tr key={o.id}>
                    <td className="py-2 pr-3 font-mono text-xs">{o.accession ?? "not collected"}</td>
                    <td className="pr-3 text-primary-color">
                      {o.test}
                      {o.urgency !== "ROUTINE" && <span className="ml-1.5 rounded bg-red-500/15 px-1 text-[10px] font-semibold text-red-700 dark:text-red-300">{o.urgency}</span>}
                    </td>
                    <td className="pr-3 text-secondary-color">{o.patient ?? "–"}</td>
                    <td className="pr-3 text-secondary-color">{sectionLabel(o.section)}</td>
                    <td className="pr-3 text-secondary-color">{STATUS_LABEL[o.stage] ?? o.stage}</td>
                    <td className="pr-3 text-right font-mono">{minutes(o.minutesOpen)}</td>
                    <td className="text-right font-mono text-amber-700 dark:text-amber-400">{minutes(o.minutesOpen - o.targetMinutes)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <div className="grid gap-4 lg:grid-cols-3">
        <section className="clinical-card p-4 lg:col-span-2" aria-label="By section">
          <h2 className="text-sm font-semibold text-primary-color">By section</h2>
          <div className="mt-2 overflow-x-auto">
            <table className="w-full min-w-[480px] text-left text-sm">
              <thead className="text-xs uppercase tracking-wide text-muted-color"><tr><th className="py-2 pr-3">Section</th><th className="pr-3 text-right">Open</th><th className="pr-3 text-right">Overdue</th><th className="pr-3 text-right">Released today</th><th className="text-right">Median TAT</th></tr></thead>
              <tbody className="divide-y divide-[var(--border-subtle)]">
                {data.sections.map((s) => (
                  <tr key={s.section}>
                    <td className="py-2 pr-3"><Link href={`/lab/orders?section=${encodeURIComponent(s.section)}`} className="text-primary-color hover:underline">{sectionLabel(s.section)}</Link></td>
                    <td className="pr-3 text-right font-mono">{s.open}</td>
                    <td className={`pr-3 text-right font-mono ${s.overdue ? "text-amber-700 dark:text-amber-400" : ""}`}>{s.overdue}</td>
                    <td className="pr-3 text-right font-mono">{s.releasedToday}</td>
                    <td className="text-right font-mono">{minutes(s.medianTatMinutes)}</td>
                  </tr>
                ))}
                {data.sections.length === 0 && <tr><td colSpan={5} className="py-3 text-muted-color">No orders in the last {data.windowDays} days.</td></tr>}
              </tbody>
            </table>
          </div>
        </section>

        <section className="clinical-card p-4" aria-label="Top tests and rejections">
          <h2 className="text-sm font-semibold text-primary-color">Most requested</h2>
          <ol className="mt-2 space-y-1 text-sm">
            {data.topTests.map((t) => (
              <li key={t.test} className="flex justify-between gap-2"><span className="truncate text-secondary-color">{t.test}</span><span className="font-mono text-primary-color">{t.count}</span></li>
            ))}
            {data.topTests.length === 0 && <li className="text-muted-color">No orders yet.</li>}
          </ol>
          {data.rejections.reasons.length > 0 && (
            <>
              <h3 className="mt-4 text-xs font-medium uppercase tracking-wide text-muted-color">Why samples were rejected</h3>
              <ul className="mt-1 space-y-1 text-sm">
                {data.rejections.reasons.map((r) => (
                  <li key={r.reason} className="flex justify-between gap-2"><span className="capitalize text-secondary-color">{r.reason}</span><span className="font-mono">{r.count}</span></li>
                ))}
              </ul>
            </>
          )}
        </section>
      </div>
    </div>
  )
}
