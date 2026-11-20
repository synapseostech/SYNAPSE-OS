"use client"

import { useCallback, useEffect, useState } from "react"
import { useSearchParams } from "next/navigation"
import { Suspense } from "react"
import { labApi, openAndPrint } from "../_components/client"

type Delivery = { channel: string; status: string; created_at: string }
type Report = { id: string; lab_order_id: string; accession: string; status: string; version: number; released_at: string; lab_report_deliveries?: Delivery[] }

function ReportsInner() {
  const params = useSearchParams()
  const [accession, setAccession] = useState(params.get("accession") ?? "")
  const [reports, setReports] = useState<Report[]>([])
  const [nextBefore, setNextBefore] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [amending, setAmending] = useState<string | null>(null)

  const load = useCallback(async (before?: string | null) => {
    const q = new URLSearchParams({ limit: "30" })
    if (accession.trim()) q.set("accession", accession.trim())
    if (before) q.set("before", before)
    const data = await labApi<{ reports: Report[]; nextBefore: string | null }>(`/api/lab/reports?${q}`)
    setReports((prev) => (before ? [...prev, ...data.reports] : data.reports))
    setNextBefore(data.nextBefore)
  }, [accession])

  useEffect(() => {
    const h = setTimeout(() => { load().catch((e) => setError(e.message)) }, 250)
    return () => clearTimeout(h)
  }, [load])

  async function notify(report: Report, channels: string[]) {
    setError(null)
    try {
      const data = await labApi<{ deliveries: Delivery[]; alreadyDone: string[] }>(`/api/lab/reports/${report.id}/notify`, { body: { channels } })
      const parts = data.deliveries.map((d) => `${d.channel}: ${d.status === "SENT" ? "sent" : d.status.toLowerCase()}`)
      if (data.alreadyDone.length) parts.push(`already done: ${data.alreadyDone.join(", ")}`)
      setNotice(parts.join(" · ") || "Nothing new to send.")
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not notify")
    }
  }

  async function amend(report: Report, form: FormData) {
    setError(null)
    try {
      await labApi("/api/lab/actions", { body: { orderId: report.lab_order_id, action: "amend", value: form.get("value"), reason: form.get("reason") } })
      setAmending(null)
      setNotice(`Amended report issued for ${report.accession}. The previous version stays on file.`)
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not amend")
    }
  }

  return (
    <main className="clinical-page p-4 sm:p-8">
      <h1 className="font-display text-2xl">Reports</h1>
      <p className="mt-1 max-w-2xl text-sm text-muted-color">
        Released reports. Print opens the report in a new tab; choose “Save as PDF” in the print dialog for a PDF.
      </p>
      <input value={accession} onChange={(e) => setAccession(e.target.value)} placeholder="Accession" aria-label="Accession" className="mt-4 w-full rounded-lg border border-edge bg-elevated px-3 py-2 text-sm sm:w-72" />
      {notice ? <p role="status" className="mt-4 text-sm">{notice}</p> : null}
      {error ? <p role="alert" className="mt-4 text-sm text-rose-700 dark:text-rose-300">{error}</p> : null}
      {reports.length === 0 ? <p className="mt-8 text-sm text-muted-color">No released reports{accession ? " for that accession" : ""}.</p> : (
        <ul className="mt-6 space-y-3">
          {reports.map((r) => {
            const sent = new Set((r.lab_report_deliveries ?? []).filter((d) => d.status === "SENT").map((d) => d.channel))
            return (
              <li key={r.id} className="rounded-2xl border border-subtle bg-surface p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <p className="font-mono text-sm">{r.accession}</p>
                    <p className="text-xs text-muted-color">Version {r.version}{r.status === "AMENDED" ? " · amended" : ""} · released {new Date(r.released_at).toLocaleString()}</p>
                    {sent.size ? <p className="mt-1 text-xs text-muted-color">Patient told: {[...sent].join(", ")}</p> : null}
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <button type="button" onClick={() => openAndPrint(`/api/lab/reports/${r.id}?format=html`)} className="rounded-lg bg-orange-500 px-3 py-1.5 text-xs font-semibold text-black">Print / PDF</button>
                    <button type="button" onClick={() => void notify(r, ["push", "sms"])} className="rounded-lg border border-edge px-3 py-1.5 text-xs">Tell patient</button>
                    <button type="button" onClick={() => void notify(r, ["print"])} disabled={sent.has("print")} className="rounded-lg border border-edge px-3 py-1.5 text-xs disabled:opacity-50">Handed over</button>
                    <button type="button" onClick={() => setAmending(amending === r.id ? null : r.id)} className="rounded-lg border border-amber-500/40 px-3 py-1.5 text-xs">Amend</button>
                  </div>
                </div>
                {amending === r.id ? (
                  <form className="mt-3 flex flex-wrap items-end gap-2" onSubmit={(e) => { e.preventDefault(); void amend(r, new FormData(e.currentTarget)) }}>
                    <input name="value" required placeholder="Corrected value" className="rounded border border-edge bg-elevated px-2 py-1 text-sm" />
                    <input name="reason" required minLength={3} placeholder="Reason (printed on the report)" className="w-72 rounded border border-edge bg-elevated px-2 py-1 text-sm" />
                    <button type="submit" className="rounded-lg bg-amber-600 px-3 py-1.5 text-xs font-semibold text-white">Issue amended report</button>
                  </form>
                ) : null}
              </li>
            )
          })}
        </ul>
      )}
      {nextBefore ? <button type="button" onClick={() => void load(nextBefore)} className="mt-4 rounded-lg border border-edge px-4 py-2 text-sm">Load more</button> : null}
    </main>
  )
}

export default function LabReportsPage() {
  return <Suspense fallback={null}><ReportsInner /></Suspense>
}
