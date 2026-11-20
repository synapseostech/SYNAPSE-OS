"use client"

import Link from "next/link"
import { useCallback, useEffect, useRef, useState } from "react"
import { labApi, LabApiError, openAndPrint, REJECTION_REASONS, STATUS_LABEL } from "../_components/client"
import { LAB_SECTIONS, LAB_SECTION_LABEL } from "@/lib/lab/sections"

type Order = {
  id: string
  testName: string
  loincCode: string
  section: string
  status: string
  urgency: string
  source: string
  accessionNumber: string | null
  patientName: string | null
  synapseId: string | null
  orderedAt: string
  hasResult: boolean
  resultValue: string | null
  unit: string | null
  referenceRange: string | null
  flag: string | null
  isCritical: boolean
}

const VIEWS = [
  ["open", "All open"],
  ["collection", "To collect"],
  ["reception", "To receive"],
  ["bench", "Bench"],
  ["verify", "To authorise"],
  ["released", "Released"],
  ["closed", "Rejected / cancelled"],
] as const

const URGENCY_STYLE: Record<string, string> = {
  STAT: "bg-rose-500/15 text-rose-700 dark:text-rose-300",
  URGENT: "bg-amber-500/15 text-amber-800 dark:text-amber-200",
}

export default function LabWorklistPage() {
  const [orders, setOrders] = useState<Order[]>([])
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [section, setSection] = useState("")
  const [view, setView] = useState<string>("open")
  const [q, setQ] = useState("")
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [values, setValues] = useState<Record<string, string>>({})
  const [rejecting, setRejecting] = useState<string | null>(null)
  const latest = useRef(0)

  const query = useCallback((cursor?: string | null) => {
    const params = new URLSearchParams({ view, limit: "30" })
    if (section) params.set("section", section)
    if (q.trim()) params.set("q", q.trim())
    if (cursor) params.set("cursor", cursor)
    return `/api/lab/worklist?${params.toString()}`
  }, [section, view, q])

  const refresh = useCallback(async () => {
    const request = ++latest.current
    setLoading(true)
    try {
      const data = await labApi<{ orders: Order[]; nextCursor: string | null }>(query())
      if (request !== latest.current) return
      setOrders(data.orders)
      setNextCursor(data.nextCursor)
      setError(null)
    } catch (err) {
      if (request === latest.current) setError(err instanceof Error ? err.message : "Unable to load the worklist")
    } finally {
      if (request === latest.current) setLoading(false)
    }
  }, [query])

  useEffect(() => {
    const handle = setTimeout(() => { void refresh() }, q ? 300 : 0)
    return () => clearTimeout(handle)
  }, [refresh, q])

  async function loadMore() {
    if (!nextCursor) return
    const data = await labApi<{ orders: Order[]; nextCursor: string | null }>(query(nextCursor))
    setOrders((prev) => [...prev, ...data.orders.filter((o) => !prev.some((p) => p.id === o.id))])
    setNextCursor(data.nextCursor)
  }

  async function act(order: Order, action: string, extra: Record<string, unknown> = {}) {
    setBusy(order.id)
    setError(null)
    setNotice(null)
    try {
      const data = await labApi<{ labelUrl?: string; critical?: boolean; warnings?: string[]; idempotent?: boolean }>("/api/lab/actions", {
        body: { orderId: order.id, action, ...extra },
      })
      if (action === "collect" && data.labelUrl) openAndPrint(data.labelUrl)
      if (data.critical && action === "enter_result") {
        setNotice(`CRITICAL value for ${order.patientName ?? "the patient"} (${order.testName}). Phone it to the requester now, then acknowledge it in Critical values once authorised.`)
      } else if (data.warnings?.includes("SELF_VERIFIED")) {
        setNotice("Authorised. You also entered this result; the audit trail records that one person did both.")
      }
      setRejecting(null)
      await refresh()
    } catch (err) {
      setError(err instanceof LabApiError && err.code === "LAB_STALE_ORDER"
        ? "Someone else changed this order a moment ago. The list has been refreshed."
        : err instanceof Error ? err.message : "Action failed")
      if (err instanceof LabApiError && err.code === "LAB_STALE_ORDER") await refresh()
    } finally {
      setBusy(null)
    }
  }

  return (
    <main className="clinical-page p-4 sm:p-8">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="font-display text-2xl">Worklist</h1>
          <p className="mt-1 max-w-2xl text-sm text-muted-color">
            Collect → receive → result → authorise. A senior authorises every result; verified results change only by amendment.
          </p>
        </div>
        <Link href="/lab/walk-in" className="rounded-lg bg-orange-500 px-4 py-2 text-sm font-semibold text-black">
          New walk-in or referral
        </Link>
      </div>

      <div className="mt-6 flex flex-wrap items-center gap-2">
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Scan a label or search name / patient no."
          aria-label="Search the worklist"
          className="w-full rounded-lg border border-edge bg-elevated px-3 py-2 text-sm sm:w-80"
        />
        <select value={section} onChange={(e) => setSection(e.target.value)} aria-label="Section" className="rounded-lg border border-edge bg-elevated px-3 py-2 text-sm">
          <option value="">All sections</option>
          {LAB_SECTIONS.map((s) => <option key={s} value={s}>{LAB_SECTION_LABEL[s]}</option>)}
        </select>
      </div>
      <nav className="mt-3 flex gap-1 overflow-x-auto" aria-label="Stage">
        {VIEWS.map(([key, label]) => (
          <button key={key} type="button" onClick={() => setView(key)} aria-pressed={view === key}
            className={`shrink-0 rounded-full px-3 py-1.5 text-xs ${view === key ? "bg-orange-500/15 text-orange" : "text-secondary-color hover:bg-surface"}`}>
            {label}
          </button>
        ))}
      </nav>

      {notice ? <p role="status" className="mt-4 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-sm">{notice}</p> : null}
      {error ? <p role="alert" className="mt-4 text-sm text-rose-700 dark:text-rose-300">{error}</p> : null}

      {loading && orders.length === 0 ? (
        <p className="mt-8 text-sm text-muted-color">Loading…</p>
      ) : orders.length === 0 ? (
        <p className="mt-8 text-sm text-muted-color">
          Nothing here. Orders from the hospital and walk-ins registered at the desk appear in this list.
        </p>
      ) : (
        <ul className="mt-6 space-y-3">
          {orders.map((order) => {
            const s = order.status
            const disabled = busy === order.id
            return (
              <li key={order.id} className={`rounded-2xl border bg-surface p-4 ${order.isCritical ? "border-rose-500/60" : "border-subtle"}`}>
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="font-medium">
                      {order.testName}
                      {order.urgency !== "ROUTINE" ? <span className={`ml-2 rounded px-1.5 py-0.5 text-[11px] font-semibold ${URGENCY_STYLE[order.urgency] ?? ""}`}>{order.urgency}</span> : null}
                      {order.isCritical ? <span className="ml-2 rounded bg-rose-600 px-1.5 py-0.5 text-[11px] font-semibold text-white">CRITICAL</span> : null}
                    </p>
                    <p className="text-xs text-muted-color">
                      {order.patientName ?? "Unknown patient"}{order.synapseId ? ` · ${order.synapseId}` : ""} · {LAB_SECTION_LABEL[order.section as keyof typeof LAB_SECTION_LABEL] ?? order.section}
                      {" · "}{STATUS_LABEL[s] ?? s}{order.source !== "hospital" ? ` · ${order.source.replace("_", "-")}` : ""}
                    </p>
                    {order.accessionNumber ? <p className="mt-1 font-mono text-xs text-amber-700 dark:text-amber-200">{order.accessionNumber}</p> : null}
                    {order.hasResult ? (
                      <p className="mt-2 text-sm">
                        <span className={order.isCritical ? "font-bold text-rose-700 dark:text-rose-300" : order.flag && order.flag !== "N" ? "font-semibold" : ""}>
                          {order.resultValue} {order.unit}
                        </span>
                        <span className="ml-2 text-xs text-muted-color">{order.flag && order.flag !== "N" ? `${order.flag} · ` : ""}{order.referenceRange}</span>
                      </p>
                    ) : null}
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    {["ORDERED", "COLLECTION_PENDING"].includes(s) ? (
                      <button type="button" disabled={disabled} onClick={() => act(order, "collect")} className="rounded-lg bg-orange-500 px-3 py-1.5 text-xs font-semibold text-black disabled:opacity-50">
                        Collect &amp; print label
                      </button>
                    ) : null}
                    {order.accessionNumber && !["REJECTED", "CANCELLED"].includes(s) ? (
                      <button type="button" onClick={() => openAndPrint(`/api/lab/orders/${order.id}/label`)} className="rounded-lg border border-edge px-3 py-1.5 text-xs">
                        Label
                      </button>
                    ) : null}
                    {["COLLECTED", "IN_TRANSIT"].includes(s) ? (
                      <button type="button" disabled={disabled} onClick={() => act(order, "receive")} className="rounded-lg border border-edge px-3 py-1.5 text-xs disabled:opacity-50">
                        Receive in lab
                      </button>
                    ) : null}
                    {["COLLECTED", "IN_TRANSIT", "RECEIVED", "PROCESSING"].includes(s) ? (
                      <button type="button" onClick={() => setRejecting(rejecting === order.id ? null : order.id)} className="rounded-lg border border-rose-500/40 px-3 py-1.5 text-xs text-rose-700 dark:text-rose-300">
                        Reject sample
                      </button>
                    ) : null}
                    {["RESULT_ENTERED", "VERIFICATION_PENDING"].includes(s) ? (
                      <button type="button" disabled={disabled} onClick={() => act(order, "authorise")} className="rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-50">
                        Authorise &amp; release
                      </button>
                    ) : null}
                    {s === "VERIFIED" ? (
                      <button type="button" disabled={disabled} onClick={() => act(order, "release")} className="rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-50">
                        Release
                      </button>
                    ) : null}
                    {["RELEASED", "AMENDED"].includes(s) ? (
                      <Link href={`/lab/reports?accession=${encodeURIComponent(order.accessionNumber ?? "")}`} className="rounded-lg border border-edge px-3 py-1.5 text-xs">
                        Report
                      </Link>
                    ) : null}
                  </div>
                </div>

                {["RECEIVED", "PROCESSING"].includes(s) ? (
                  <form className="mt-3 flex flex-wrap items-end gap-2" onSubmit={(e) => { e.preventDefault(); void act(order, "enter_result", { value: values[order.id] ?? "" }) }}>
                    <label className="text-xs text-muted-color">
                      Result
                      <input
                        value={values[order.id] ?? ""}
                        onChange={(e) => setValues((v) => ({ ...v, [order.id]: e.target.value }))}
                        placeholder={order.unit ?? "value or Positive / Negative"}
                        className="ml-2 w-48 rounded border border-edge bg-elevated px-2 py-1 text-sm text-primary-color"
                      />
                    </label>
                    <button type="submit" disabled={disabled || !(values[order.id] ?? "").trim()} className="rounded-lg border border-edge px-3 py-1.5 text-xs disabled:opacity-50">
                      Save result
                    </button>
                  </form>
                ) : null}

                {rejecting === order.id ? (
                  <form className="mt-3 flex flex-wrap items-end gap-2" onSubmit={(e) => {
                    e.preventDefault()
                    const form = new FormData(e.currentTarget)
                    void act(order, "reject", { reason: form.get("reason"), note: form.get("note") })
                  }}>
                    <select name="reason" className="rounded border border-edge bg-elevated px-2 py-1 text-sm" aria-label="Rejection reason">
                      {REJECTION_REASONS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                    </select>
                    <input name="note" placeholder="Note (optional)" className="rounded border border-edge bg-elevated px-2 py-1 text-sm" />
                    <button type="submit" disabled={disabled} className="rounded-lg bg-rose-600 px-3 py-1.5 text-xs font-semibold text-white">Reject — recollect</button>
                  </form>
                ) : null}
              </li>
            )
          })}
        </ul>
      )}
      {nextCursor ? (
        <button type="button" onClick={() => void loadMore()} className="mt-4 rounded-lg border border-edge px-4 py-2 text-sm">
          Load more
        </button>
      ) : null}
    </main>
  )
}
