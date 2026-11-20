"use client"

import { useEffect, useState } from "react"
import Link from "next/link"
import { LabAiAnalysis } from "@/components/lab/LabAiAnalysis"

type VerifyItem = {
  orderId: string
  testName: string
  loincCode: string
  accessionNumber: string | null
  patientName: string | null
  status: string
  result: {
    id: string
    resultValue: string
    unit: string | null
    referenceRange: string | null
    isCritical: boolean
    isAbnormal: boolean
    flag: string | null
    analyzer: string | null
    source: string | null
    enteredAt: string | null
  } | null
}

export default function LabVerifyPage() {
  const [items, setItems] = useState<VerifyItem[]>([])
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)

  async function refresh() {
    const res = await fetch("/api/lab/verify-queue", { cache: "no-store" })
    if (!res.ok) {
      setError("Lab scientist / verifier access required.")
      return
    }
    const data = (await res.json()) as { items: VerifyItem[] }
    setItems(data.items ?? [])
    setError(null)
  }

  useEffect(() => {
    refresh().catch(() => setError("Unable to load verification queue"))
  }, [])

  async function act(orderId: string, action: "verify" | "release" | "authorise") {
    setBusy(orderId)
    setError(null)
    try {
      const res = await fetch("/api/lab/actions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ orderId, action }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? "action_failed")
      await refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : "action_failed")
    } finally {
      setBusy(null)
    }
  }

  return (
    <main className="clinical-page p-8">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="font-display text-2xl">Result verification</h1>
          <p className="mt-2 max-w-2xl text-sm text-muted-color">
            Human verification only. Review instrument flags, reference ranges, and critical values before release.
            AI cannot verify.
          </p>
        </div>
        <Link href="/lab/results" className="text-sm text-[#E8B84B] hover:underline">
          All results
        </Link>
      </div>

      {error ? <p className="mt-4 text-sm text-amber-300">{error}</p> : null}

      {items.length === 0 ? (
        <p className="mt-8 text-sm text-muted-color">No results awaiting verification.</p>
      ) : (
        <ul className="mt-8 space-y-4">
          {items.map((item) => (
            <li key={item.orderId} className="rounded-2xl border border-subtle bg-surface p-5">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <p className="font-medium">
                    {item.testName} · {item.loincCode}
                  </p>
                  <p className="text-xs text-muted-color">
                    {item.patientName ?? "Patient"} · {item.status}
                  </p>
                  {item.accessionNumber ? (
                    <p className="mt-1 font-mono text-xs text-amber-700 dark:text-amber-200">{item.accessionNumber}</p>
                  ) : null}
                </div>
                <div className="flex gap-2">
                  {item.status === "VERIFICATION_PENDING" || item.status === "RESULT_ENTERED" ? (
                    <button
                      type="button"
                      disabled={busy === item.orderId}
                      onClick={() => act(item.orderId, "authorise")}
                      className="rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-50"
                    >
                      Authorise &amp; release
                    </button>
                  ) : null}
                  {item.status === "VERIFICATION_PENDING" || item.status === "RESULT_ENTERED" ? (
                    <button
                      type="button"
                      disabled={busy === item.orderId}
                      onClick={() => act(item.orderId, "verify")}
                      className="rounded-lg bg-orange-500 px-3 py-1.5 text-xs font-semibold text-black disabled:opacity-50"
                    >
                      Verify only
                    </button>
                  ) : null}
                  {item.status === "VERIFIED" ? (
                    <button
                      type="button"
                      disabled={busy === item.orderId}
                      onClick={() => act(item.orderId, "release")}
                      className="rounded-lg border border-emerald-500/40 bg-emerald-500/10 px-3 py-1.5 text-xs font-semibold text-emerald-300 disabled:opacity-50"
                    >
                      Release
                    </button>
                  ) : null}
                </div>
              </div>

              {item.result ? (
                <dl className="mt-4 grid gap-2 text-sm sm:grid-cols-2 lg:grid-cols-3">
                  <div>
                    <dt className="text-xs text-muted-color">Value</dt>
                    <dd className="font-medium">
                      {item.result.resultValue} {item.result.unit}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-xs text-muted-color">Reference</dt>
                    <dd>{item.result.referenceRange ?? "—"}</dd>
                  </div>
                  <div>
                    <dt className="text-xs text-muted-color">Flags</dt>
                    <dd>
                      {item.result.isCritical ? "CRITICAL " : ""}
                      {item.result.isAbnormal ? item.result.flag ?? "ABN" : "N"}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-xs text-muted-color">Instrument</dt>
                    <dd>{item.result.analyzer ?? "manual"}</dd>
                  </div>
                  <div>
                    <dt className="text-xs text-muted-color">Source</dt>
                    <dd>{item.result.source ?? "MANUAL"}</dd>
                  </div>
                  <div>
                    <dt className="text-xs text-muted-color">Entered</dt>
                    <dd>
                      {item.result.enteredAt ? new Date(item.result.enteredAt).toLocaleString() : "—"}
                    </dd>
                  </div>
                </dl>
              ) : (
                <p className="mt-3 text-sm text-amber-300">No durable result row — re-enter result.</p>
              )}
              {item.result ? <LabAiAnalysis resultId={item.result.id} /> : null}
            </li>
          ))}
        </ul>
      )}
    </main>
  )
}
