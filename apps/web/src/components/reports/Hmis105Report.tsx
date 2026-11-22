'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { Download, Info, Loader2, Printer } from 'lucide-react'
import type { Hmis105Report as Report } from '@synapse/interop/hmis105'
import { HMIS105_AGE_BANDS } from '@synapse/interop/hmis105'

type Response = Report & { encountersInPeriod: number; truncated: boolean }

function periodOptions(): { value: string; label: string }[] {
  const out: { value: string; label: string }[] = []
  const now = new Date(Date.now() + 3 * 3_600_000)
  for (let i = 0; i < 13; i += 1) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1))
    out.push({
      value: `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}`,
      label: d.toLocaleDateString(undefined, { month: 'long', year: 'numeric', timeZone: 'UTC' }),
    })
  }
  return out
}

/**
 * HMIS 105 OPD diagnoses for a month: counts by age band and sex from coded
 * ICD-11 diagnoses, with CSV download for the records officer.
 */
export function Hmis105Report() {
  const periods = useMemo(periodOptions, [])
  const [period, setPeriod] = useState(periods[0]!.value)
  const [data, setData] = useState<Response | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [hideEmpty, setHideEmpty] = useState(true)

  const load = useCallback(async (p: string) => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch(`/api/hospital/reports/hmis105?period=${p}`, { credentials: 'include', cache: 'no-store' })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(typeof body.error === 'string' ? body.error : res.status === 403 ? 'Your role cannot view HMIS reports.' : 'Could not load the report.')
      setData(body as Response)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load the report.')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load(period)
  }, [load, period])

  const groups = useMemo(() => {
    if (!data) return []
    const rows = hideEmpty ? data.rows.filter((r) => r.total > 0) : data.rows
    const names = [...new Set(rows.map((r) => r.group))]
    return names.map((g) => ({ group: g, rows: rows.filter((r) => r.group === g) }))
  }, [data, hideEmpty])

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-primary-color">HMIS 105: OPD diagnoses</h1>
          <p className="text-sm text-secondary-color">Counted from ICD-11 diagnoses coded in consultations. One case per visit per diagnosis group.</p>
        </div>
        <div className="flex flex-wrap items-center gap-2 print:hidden">
          <label className="text-xs text-muted-color" htmlFor="hmis-period">Month</label>
          <select
            id="hmis-period"
            value={period}
            onChange={(e) => setPeriod(periods[e.target.selectedIndex]?.value ?? periods[0]!.value)}
            className="rounded-lg border border-subtle bg-surface px-2.5 py-1.5 text-sm text-primary-color"
          >
            {periods.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
          </select>
          <a href={`/api/hospital/reports/hmis105?${new URLSearchParams({ period: /^\d{6}$/.test(period) ? period : periods[0]!.value, format: 'csv' })}`} className="btn-secondary inline-flex items-center gap-1.5 !px-3 !py-1.5 text-xs">
            <Download className="h-3.5 w-3.5" aria-hidden /> CSV
          </a>
          <button type="button" onClick={() => window.print()} className="btn-secondary inline-flex items-center gap-1.5 !px-3 !py-1.5 text-xs">
            <Printer className="h-3.5 w-3.5" aria-hidden /> Print
          </button>
        </div>
      </div>

      {error && <p className="rounded-lg bg-red-500/10 px-3 py-2 text-sm text-red-600 dark:text-red-400">{error}</p>}

      {data && (
        <div className="grid gap-3 sm:grid-cols-4">
          {[
            ['Cases', data.totals.cases],
            ['Visits with a diagnosis', data.totals.encounters],
            ['Visits this month', data.encountersInPeriod],
            ['Age or sex not recorded', data.totals.unknownAgeOrSex],
          ].map(([label, value]) => (
            <div key={label} className="clinical-card p-3">
              <div className="text-xs uppercase tracking-wide text-muted-color">{label}</div>
              <div className={`font-mono text-2xl font-semibold ${label === 'Age or sex not recorded' && Number(value) > 0 ? 'text-amber-600 dark:text-amber-400' : 'text-primary-color'}`}>{value}</div>
            </div>
          ))}
        </div>
      )}

      {data && data.encountersInPeriod > 0 && data.totals.encounters < data.encountersInPeriod && (
        <p className="flex items-start gap-2 rounded-lg bg-sky-500/10 px-3 py-2 text-xs text-sky-700 dark:text-sky-300">
          <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
          {data.encountersInPeriod - data.totals.encounters} visits this month have no ICD-11 diagnosis and are not counted. Code them in the consultation screen.
        </p>
      )}

      <div className="clinical-card overflow-x-auto p-0">
        <div className="flex items-center justify-between border-b border-subtle px-4 py-2 print:hidden">
          <label className="flex items-center gap-2 text-xs text-secondary-color">
            <input type="checkbox" checked={hideEmpty} onChange={(e) => setHideEmpty(e.target.checked)} /> Hide rows with no cases
          </label>
          {loading && <Loader2 className="h-4 w-4 animate-spin text-muted-color" aria-label="Loading" />}
        </div>
        <table className="w-full min-w-[820px] text-left text-sm">
          <thead className="text-xs text-muted-color">
            <tr className="border-b border-subtle">
              <th rowSpan={2} className="px-4 py-2 align-bottom">Diagnosis</th>
              {HMIS105_AGE_BANDS.map((b) => <th key={b.key} colSpan={2} className="px-2 pt-2 text-center">{b.label}</th>)}
              <th rowSpan={2} className="px-2 text-right align-bottom">Not recorded</th>
              <th rowSpan={2} className="px-4 text-right align-bottom">Total</th>
            </tr>
            <tr className="border-b border-subtle">
              {HMIS105_AGE_BANDS.flatMap((b) => [<th key={`${b.key}m`} className="px-2 pb-2 text-center font-normal">M</th>, <th key={`${b.key}f`} className="px-2 pb-2 text-center font-normal">F</th>])}
            </tr>
          </thead>
          <tbody>
            {groups.map(({ group, rows }) => (
              <FragmentRows key={group} group={group} rows={rows} />
            ))}
            {data && groups.length === 0 && (
              <tr><td colSpan={11} className="px-4 py-6 text-center text-muted-color">No coded diagnoses for this month.</td></tr>
            )}
          </tbody>
        </table>
      </div>

      {data && data.otherDiagnoses.length > 0 && (
        <details className="clinical-card p-4 text-sm">
          <summary className="cursor-pointer text-secondary-color">Diagnoses outside the HMIS 105 groups ({data.otherDiagnoses.length} {data.otherDiagnoses.length === 1 ? "code" : "codes"})</summary>
          <ul className="mt-2 grid gap-1 font-mono text-xs sm:grid-cols-3">
            {data.otherDiagnoses.map((o) => <li key={o.code}>{o.code} × {o.count}</li>)}
          </ul>
        </details>
      )}
      <p className="text-xs text-muted-color">
        Group names follow the MoH HMIS 105 OPD diagnosis list; check them against the form your facility files this month. Working (suspected) diagnoses are counted; rule-out (differential) diagnoses are not.
      </p>
    </div>
  )
}

function FragmentRows({ group, rows }: { group: string; rows: Report['rows'] }) {
  return (
    <>
      <tr className="bg-elevated">
        <td colSpan={11} className="px-4 py-1.5 text-xs font-semibold uppercase tracking-wide text-secondary-color">{group}</td>
      </tr>
      {rows.map((r) => {
        const unknown = r.bands.unknown.M + r.bands.unknown.F + r.bands.unknown.U + HMIS105_AGE_BANDS.reduce((a, b) => a + r.bands[b.key].U, 0)
        return (
          <tr key={r.key} className="border-b border-subtle last:border-0">
            <td className="px-4 py-1.5 text-primary-color">
              {r.label}
              {r.notifiable && r.total > 0 && <span className="ml-2 rounded bg-red-500/15 px-1 text-[10px] font-semibold text-red-700 dark:text-red-300">notify</span>}
            </td>
            {HMIS105_AGE_BANDS.flatMap((b) => [
              <td key={`${b.key}m`} className="px-2 text-center font-mono">{r.bands[b.key].M || <span className="text-muted-color">·</span>}</td>,
              <td key={`${b.key}f`} className="px-2 text-center font-mono">{r.bands[b.key].F || <span className="text-muted-color">·</span>}</td>,
            ])}
            <td className={`px-2 text-right font-mono ${unknown ? 'text-amber-600 dark:text-amber-400' : 'text-muted-color'}`}>{unknown || '·'}</td>
            <td className="px-4 text-right font-mono font-semibold">{r.total}</td>
          </tr>
        )
      })}
    </>
  )
}
