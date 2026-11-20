"use client"

import { useCallback, useEffect, useState } from "react"
import { labApi } from "../_components/client"

type Critical = {
  id: string
  test_name: string
  result_value: string
  unit: string | null
  reference_range: string | null
  status: string
  created_at: string
  lab_orders?: { accession_number?: string | null; referral_source?: string | null; workflow_status?: string; patients?: { full_name?: string | null; mrn?: string | null; phone?: string | null } | null } | null
}

export default function LabCriticalPage() {
  const [items, setItems] = useState<Critical[]>([])
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    const data = await labApi<{ critical: Critical[] }>("/api/lab/critical")
    setItems(data.critical)
  }, [])

  useEffect(() => { load().catch((e) => setError(e.message)) }, [load])

  async function acknowledge(item: Critical, form: FormData) {
    setError(null)
    try {
      await labApi(`/api/lab/results/${item.id}/critical-ack`, { body: { note: form.get("note") } })
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not acknowledge")
    }
  }

  return (
    <main className="clinical-page p-4 sm:p-8">
      <h1 className="font-display text-2xl">Critical values</h1>
      <p className="mt-1 max-w-2xl text-sm text-muted-color">
        Phone each critical value to the requester (or the patient, for a walk-in), then record who you told. Acknowledging is audited.
      </p>
      {error ? <p role="alert" className="mt-4 text-sm text-rose-700 dark:text-rose-300">{error}</p> : null}
      {items.length === 0 ? <p className="mt-8 text-sm text-muted-color">No unacknowledged critical values.</p> : (
        <ul className="mt-6 space-y-3">
          {items.map((item) => {
            const o = item.lab_orders
            return (
              <li key={item.id} className="rounded-2xl border border-rose-500/60 bg-surface p-4">
                <p className="font-medium">
                  <span className="font-bold text-rose-700 dark:text-rose-300">{item.result_value} {item.unit}</span> · {item.test_name}
                  <span className="ml-2 text-xs text-muted-color">{item.reference_range}</span>
                </p>
                <p className="text-xs text-muted-color">
                  {o?.patients?.full_name ?? "Patient"}{o?.patients?.mrn ? ` · ${o.patients.mrn}` : ""} · {o?.accession_number ?? ""}
                  {item.status === "preliminary" ? " · not yet authorised" : ""}
                </p>
                <p className="mt-1 text-sm">
                  Call: {o?.referral_source ?? "requesting clinician"}{o?.patients?.phone ? ` · patient ${o.patients.phone}` : ""}
                </p>
                <form className="mt-3 flex flex-wrap items-end gap-2" onSubmit={(e) => { e.preventDefault(); void acknowledge(item, new FormData(e.currentTarget)) }}>
                  <input name="note" required minLength={3} placeholder="Told whom, at what time" className="w-72 rounded border border-edge bg-elevated px-2 py-1 text-sm" />
                  <button type="submit" className="rounded-lg bg-rose-600 px-3 py-1.5 text-xs font-semibold text-white">Acknowledge</button>
                </form>
              </li>
            )
          })}
        </ul>
      )}
    </main>
  )
}
