"use client"

import Link from "next/link"
import { useParams } from "next/navigation"
import { useEffect, useMemo, useState } from "react"
import { ArrowDownRight, ArrowRight, ArrowUpRight, Printer } from "lucide-react"
import type { CumulativeSeries } from "@/lib/lab/dashboard"
import { labApi, LabApiError } from "../../_components/client"

type Response = { patient: { id: string; name: string | null; mrn: string | null; sex: string | null; dob: string | null }; series: CumulativeSeries[] }

const FLAG_STYLE = (flag: string | null, critical: boolean) =>
  critical ? "font-semibold text-red-600 dark:text-red-400" : flag && flag !== "N" ? "text-amber-700 dark:text-amber-400" : "text-primary-color"

function Trend({ s }: { s: CumulativeSeries }) {
  const nums = s.points.map((p) => p.numeric).filter((n): n is number => n != null)
  if (s.trend === "text" || nums.length < 2) return <span className="text-xs text-muted-color">{s.trend === "text" ? "" : "1 result"}</span>
  const W = 96
  const H = 26
  const min = Math.min(...nums)
  const max = Math.max(...nums)
  const span = max - min || 1
  const pts = nums.map((v, i) => `${(2 + (i * (W - 4)) / (nums.length - 1)).toFixed(1)},${(H - 3 - ((v - min) / span) * (H - 6)).toFixed(1)}`)
  const Arrow = s.trend === "rising" ? ArrowUpRight : s.trend === "falling" ? ArrowDownRight : ArrowRight
  return (
    <span className="inline-flex items-center gap-1">
      <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} aria-label={`${s.test} ${s.trend}`}>
        <polyline points={pts.join(" ")} fill="none" className="stroke-[#2a78d6] dark:stroke-[#3987e5]" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
      </svg>
      <Arrow className="h-3.5 w-3.5 text-secondary-color" aria-hidden />
    </span>
  )
}

export default function CumulativeResultsPage() {
  const { id } = useParams<{ id: string }>()
  const [data, setData] = useState<Response | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    labApi<Response>(`/api/lab/patients/${id}/results`)
      .then(setData)
      .catch((e) => setError(e instanceof LabApiError ? e.message : "Could not load results."))
  }, [id])

  // Columns: the most recent 8 result days across all tests, newest last.
  const dates = useMemo(() => {
    if (!data) return []
    const all = new Set(data.series.flatMap((s) => s.points.map((p) => p.at.slice(0, 10))))
    return [...all].sort().slice(-8)
  }, [data])

  if (error) return <div className="clinical-card p-6 text-sm text-red-600 dark:text-red-400">{error}</div>
  if (!data) return <div className="clinical-card h-64 animate-pulse" aria-busy="true" />

  const p = data.patient
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <p className="text-xs uppercase tracking-wide text-muted-color">Cumulative results</p>
          <h1 className="text-xl font-semibold text-primary-color">{p.name ?? "Patient"}</h1>
          <p className="text-sm text-secondary-color">{[p.mrn, p.sex, p.dob ? `born ${p.dob}` : null].filter(Boolean).join(" · ")}</p>
        </div>
        <div className="flex gap-2 print:hidden">
          <Link href="/lab/orders" className="btn-secondary !px-3 !py-1.5 text-xs">Back to worklist</Link>
          <button type="button" onClick={() => window.print()} className="btn-secondary inline-flex items-center gap-1.5 !px-3 !py-1.5 text-xs"><Printer className="h-3.5 w-3.5" aria-hidden /> Print</button>
        </div>
      </div>

      {data.series.length === 0 ? (
        <div className="clinical-card p-6 text-sm text-secondary-color">No authorised results for this patient yet.</div>
      ) : (
        <div className="clinical-card overflow-x-auto p-0">
          <table className="w-full min-w-[720px] text-left text-sm">
            <thead className="border-b border-subtle text-xs uppercase tracking-wide text-muted-color">
              <tr>
                <th className="sticky left-0 bg-surface px-4 py-3">Test</th>
                <th className="px-3">Trend</th>
                {dates.map((d) => (
                  <th key={d} className="px-3 text-right font-mono normal-case">{new Date(`${d}T12:00:00Z`).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "2-digit" })}</th>
                ))}
                <th className="px-4">Reference</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--border-subtle)]">
              {data.series.map((s) => (
                <tr key={s.key}>
                  <td className="sticky left-0 bg-surface px-4 py-2">
                    <div className="text-primary-color">{s.test}</div>
                    {s.unit && <div className="text-xs text-muted-color">{s.unit}</div>}
                  </td>
                  <td className="px-3"><Trend s={s} /></td>
                  {dates.map((d) => {
                    const pt = [...s.points].reverse().find((x) => x.at.slice(0, 10) === d)
                    return (
                      <td key={d} className={`px-3 text-right font-mono ${pt ? FLAG_STYLE(pt.flag, pt.critical) : "text-muted-color"}`}>
                        {pt ? (
                          <>
                            {pt.value}
                            {pt.flag && pt.flag !== "N" ? <sup className="ml-0.5 text-[10px]">{pt.critical ? "!!" : pt.flag}</sup> : null}
                          </>
                        ) : "·"}
                      </td>
                    )
                  })}
                  <td className="px-4 text-xs text-secondary-color">{s.referenceRange ?? "–"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="text-xs text-muted-color">Only authorised results are shown. H/L: above or below the reference range; !!: critical.</p>
    </div>
  )
}
