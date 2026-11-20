"use client"

import Link from "next/link"
import { useEffect, useMemo, useState } from "react"
import { formatMoney, labApi } from "../_components/client"
import { LAB_SECTION_LABEL } from "@/lib/lab/sections"

type CatalogTest = { id: string; code: string; name: string; section: string; specimen_type: string; container: string | null; price: number | null; currency: string; turnaround_minutes: number | null }
type Created = {
  patient: { id: string; mrn: string; full_name: string | null }
  orders: Array<{ id: string; testName: string; price: number | null }>
  billing: { invoiceId: string | null; total: number; charged: string[]; unpriced: string[]; warnings: string[] } | null
}

const EMPTY_PATIENT = { fullName: "", dateOfBirth: "", sex: "F", phone: "" }

export default function LabWalkInPage() {
  const [tests, setTests] = useState<CatalogTest[]>([])
  const [filter, setFilter] = useState("")
  const [picked, setPicked] = useState<string[]>([])
  const [patient, setPatient] = useState(EMPTY_PATIENT)
  const [source, setSource] = useState<"walk_in" | "referral">("walk_in")
  const [referralSource, setReferralSource] = useState("")
  const [urgency, setUrgency] = useState("ROUTINE")
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [created, setCreated] = useState<Created | null>(null)

  useEffect(() => {
    labApi<{ tests: CatalogTest[] }>("/api/lab/catalog").then((d) => setTests(d.tests)).catch((e) => setError(e.message))
  }, [])

  const shown = useMemo(() => {
    const f = filter.trim().toLowerCase()
    return f ? tests.filter((t) => t.name.toLowerCase().includes(f) || t.code.toLowerCase().includes(f)) : tests
  }, [tests, filter])
  const chosen = tests.filter((t) => picked.includes(t.id))
  const total = chosen.reduce((sum, t) => sum + (t.price ?? 0), 0)
  const unpriced = chosen.filter((t) => t.price == null)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setSaving(true)
    setError(null)
    try {
      const data = await labApi<Created>("/api/lab/walk-in", {
        body: {
          patient: { fullName: patient.fullName, dateOfBirth: patient.dateOfBirth, sex: patient.sex, phone: patient.phone || undefined },
          catalogTestIds: picked,
          urgency,
          source,
          referralSource: referralSource || undefined,
        },
      })
      setCreated(data)
      setPatient(EMPTY_PATIENT)
      setPicked([])
      setReferralSource("")
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not register the patient")
    } finally {
      setSaving(false)
    }
  }

  return (
    <main className="clinical-page p-4 sm:p-8">
      <h1 className="font-display text-2xl">Walk-in or referral</h1>
      <p className="mt-1 max-w-2xl text-sm text-muted-color">Register the patient and every test in one step. Priced tests go on the visit invoice.</p>

      {created ? (
        <section role="status" className="mt-6 rounded-2xl border border-emerald-500/40 bg-emerald-500/10 p-4 text-sm">
          <p className="font-medium">{created.patient.full_name} registered as {created.patient.mrn}: {created.orders.length} test{created.orders.length === 1 ? "" : "s"} ordered.</p>
          {created.billing?.invoiceId ? <p className="mt-1">Invoice total {formatMoney(created.billing.total)}.</p> : null}
          {created.billing?.unpriced.length ? <p className="mt-1 text-amber-800 dark:text-amber-200">Not billed (no price set): {created.billing.unpriced.join(", ")}. Set prices in Catalogue.</p> : null}
          <Link href="/lab/orders?view=collection" className="mt-2 inline-block text-orange underline">Go to collection</Link>
        </section>
      ) : null}
      {error ? <p role="alert" className="mt-4 text-sm text-rose-700 dark:text-rose-300">{error}</p> : null}

      <form onSubmit={submit} className="mt-6 grid gap-6 lg:grid-cols-[1fr_1.2fr]">
        <section className="space-y-3 rounded-2xl border border-subtle bg-surface p-4">
          <h2 className="text-sm font-semibold">Patient</h2>
          <label className="block text-xs text-muted-color">Full name<input required minLength={2} value={patient.fullName} onChange={(e) => setPatient({ ...patient, fullName: e.target.value })} className="mt-1 w-full rounded-lg border border-edge bg-elevated px-3 py-2 text-sm text-primary-color" /></label>
          <div className="grid grid-cols-2 gap-3">
            <label className="block text-xs text-muted-color">Date of birth<input type="date" value={patient.dateOfBirth} onChange={(e) => setPatient({ ...patient, dateOfBirth: e.target.value })} className="mt-1 w-full rounded-lg border border-edge bg-elevated px-3 py-2 text-sm text-primary-color" /></label>
            <label className="block text-xs text-muted-color">Sex<select value={patient.sex} onChange={(e) => setPatient({ ...patient, sex: e.target.value })} className="mt-1 w-full rounded-lg border border-edge bg-elevated px-3 py-2 text-sm text-primary-color"><option value="F">Female</option><option value="M">Male</option><option value="I">Intersex</option><option value="U">Not stated</option></select></label>
          </div>
          <label className="block text-xs text-muted-color">Phone (for results)<input value={patient.phone} onChange={(e) => setPatient({ ...patient, phone: e.target.value })} className="mt-1 w-full rounded-lg border border-edge bg-elevated px-3 py-2 text-sm text-primary-color" /></label>
          <div className="grid grid-cols-2 gap-3">
            <label className="block text-xs text-muted-color">Visit<select value={source} onChange={(e) => setSource(e.target.value as "walk_in" | "referral")} className="mt-1 w-full rounded-lg border border-edge bg-elevated px-3 py-2 text-sm text-primary-color"><option value="walk_in">Walk-in</option><option value="referral">Referred</option></select></label>
            <label className="block text-xs text-muted-color">Urgency<select value={urgency} onChange={(e) => setUrgency(e.target.value)} className="mt-1 w-full rounded-lg border border-edge bg-elevated px-3 py-2 text-sm text-primary-color"><option value="ROUTINE">Routine</option><option value="URGENT">Urgent</option><option value="STAT">STAT</option></select></label>
          </div>
          <label className="block text-xs text-muted-color">Requested by (clinician / clinic)<input value={referralSource} onChange={(e) => setReferralSource(e.target.value)} className="mt-1 w-full rounded-lg border border-edge bg-elevated px-3 py-2 text-sm text-primary-color" /></label>
        </section>

        <section className="rounded-2xl border border-subtle bg-surface p-4">
          <div className="flex items-center justify-between gap-3">
            <h2 className="text-sm font-semibold">Tests</h2>
            <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Find a test" aria-label="Find a test" className="w-40 rounded-lg border border-edge bg-elevated px-2 py-1 text-sm" />
          </div>
          {tests.length === 0 ? (
            <p className="mt-4 text-sm text-muted-color">No tests in the catalogue yet. <Link href="/lab/catalog" className="underline">Set up the catalogue</Link>.</p>
          ) : (
            <ul className="mt-3 max-h-80 space-y-1 overflow-y-auto">
              {shown.map((t) => (
                <li key={t.id}>
                  <label className="flex cursor-pointer items-center justify-between gap-3 rounded-lg px-2 py-1.5 text-sm hover:bg-elevated">
                    <span className="flex items-center gap-2">
                      <input type="checkbox" checked={picked.includes(t.id)} onChange={(e) => setPicked((p) => e.target.checked ? [...p, t.id] : p.filter((id) => id !== t.id))} />
                      {t.name}
                      <span className="text-xs text-muted-color">{LAB_SECTION_LABEL[t.section as keyof typeof LAB_SECTION_LABEL] ?? t.section} · {t.container ?? t.specimen_type}</span>
                    </span>
                    <span className="text-xs">{formatMoney(t.price, t.currency)}</span>
                  </label>
                </li>
              ))}
            </ul>
          )}
          <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-subtle pt-3 text-sm">
            <span>{chosen.length} test{chosen.length === 1 ? "" : "s"} · total {formatMoney(total)}{unpriced.length ? ` (+${unpriced.length} unpriced)` : ""}</span>
            <button type="submit" disabled={saving || !chosen.length || patient.fullName.trim().length < 2} className="rounded-lg bg-orange-500 px-4 py-2 text-sm font-semibold text-black disabled:opacity-50">
              {saving ? "Registering…" : "Register and order"}
            </button>
          </div>
        </section>
      </form>
    </main>
  )
}
