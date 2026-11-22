"use client"

import { useCallback, useEffect, useState } from "react"
import { formatMoney, labApi } from "../_components/client"
import { LAB_SECTIONS, LAB_SECTION_LABEL } from "@/lib/lab/sections"

type Test = { id: string; code: string; loinc_code: string | null; name: string; section: string; specimen_type: string; container: string | null; unit: string | null; price: number | null; currency: string; turnaround_minutes: number | null; is_active: boolean; components?: Component[] }
type Component = { loinc: string; name: string; unit?: string | null }

/** One component per line: LOINC, name, unit. */
function parseComponents(text: string): Component[] {
  return text.split("\n").map((l) => l.trim()).filter(Boolean).map((l) => {
    const [loinc = "", name = "", unit = ""] = l.split(",").map((x) => x.trim())
    return { loinc, name, unit: unit || null }
  })
}
type Range = { id: string; scope: "laboratory" | "national"; loinc_code: string; test_name: string; unit: string; sex: string | null; age_min_years: number | null; age_max_years: number | null; low: number; high: number; critical_low: number | null; critical_high: number | null }

const num = (v: FormDataEntryValue | null) => (v === null || String(v).trim() === "" ? null : Number(v))

export default function LabCatalogPage() {
  const [tests, setTests] = useState<Test[]>([])
  const [ranges, setRanges] = useState<Range[]>([])
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const load = useCallback(async () => {
    const [t, r] = await Promise.all([
      labApi<{ tests: Test[] }>("/api/lab/catalog?all=1"),
      labApi<{ ranges: Range[] }>("/api/lab/reference-ranges"),
    ])
    setTests(t.tests)
    setRanges(r.ranges)
  }, [])

  useEffect(() => { load().catch((e) => setError(e.message)) }, [load])

  async function run(fn: () => Promise<unknown>, done?: string) {
    setError(null)
    try {
      await fn()
      if (done) setNotice(done)
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed")
    }
  }

  return (
    <main className="clinical-page p-4 sm:p-8">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="font-display text-2xl">Catalogue and reference ranges</h1>
          <p className="mt-1 max-w-2xl text-sm text-muted-color">What the lab offers, its price and section, and the intervals results are flagged against. Your own interval replaces the national one for the same test, sex and age band.</p>
        </div>
        <button type="button" onClick={() => void run(async () => { const d = await labApi<{ added: number }>("/api/lab/catalog/seed", { method: "POST" }); setNotice(`${d.added} starter tests added (no prices).`) })} className="rounded-lg border border-edge px-3 py-2 text-sm">
          Load starter tests
        </button>
      </div>
      {notice ? <p role="status" className="mt-4 text-sm">{notice}</p> : null}
      {error ? <p role="alert" className="mt-4 text-sm text-rose-700 dark:text-rose-300">{error}</p> : null}

      <section className="mt-6 overflow-x-auto rounded-2xl border border-subtle bg-surface">
        <table className="w-full min-w-[720px] text-sm">
          <thead className="text-left text-xs text-muted-color"><tr><th className="p-3">Test</th><th>Section</th><th>Sample</th><th>Price</th><th>Turnaround</th><th>Active</th></tr></thead>
          <tbody>
            {tests.map((t) => (
              <tr key={t.id} className="border-t border-subtle">
                <td className="p-3">
                  {t.name}
                  <div className="text-xs text-muted-color">{t.code}{t.loinc_code ? ` · LOINC ${t.loinc_code}` : ""}</div>
                  <details className="mt-1 text-xs">
                    <summary className="cursor-pointer text-sky-700 dark:text-sky-300">{t.components?.length ? `Panel: ${t.components.length} tests` : "Make it a panel"}</summary>
                    <p className="mt-1 text-muted-color">One test per line: LOINC, name, unit. Ordering this test then creates one order per line on one sample.</p>
                    <textarea
                      defaultValue={(t.components ?? []).map((c) => [c.loinc, c.name, c.unit ?? ""].join(", ")).join("\n")}
                      rows={Math.max(3, (t.components?.length ?? 0) + 1)}
                      aria-label={`${t.name} panel tests`}
                      className="mt-1 w-72 rounded border border-edge bg-elevated px-2 py-1 font-mono text-xs text-primary-color"
                      onBlur={(e) => {
                        const next = parseComponents(e.target.value)
                        const same = JSON.stringify(next) === JSON.stringify((t.components ?? []).map((c) => ({ loinc: c.loinc, name: c.name, unit: c.unit ?? null })))
                        if (!same) void run(() => labApi(`/api/lab/catalog/${t.id}`, { method: "PATCH", body: { components: next } }), next.length ? `${t.name}: panel of ${next.length} tests` : `${t.name}: no longer a panel`)
                      }}
                    />
                  </details>
                </td>
                <td>{LAB_SECTION_LABEL[t.section as keyof typeof LAB_SECTION_LABEL] ?? t.section}</td>
                <td className="text-xs">{t.container ?? t.specimen_type}</td>
                <td>
                  <input type="number" min={0} defaultValue={t.price ?? ""} aria-label={`Price of ${t.name}`} placeholder="—"
                    onBlur={(e) => { const v = num(e.target.value); if (v !== t.price) void run(() => labApi(`/api/lab/catalog/${t.id}`, { method: "PATCH", body: { price: v } }), `${t.name}: ${formatMoney(v, t.currency)}`) }}
                    className="w-28 rounded border border-edge bg-elevated px-2 py-1" />
                </td>
                <td className="text-xs">{t.turnaround_minutes ? `${Math.round(t.turnaround_minutes / 60 * 10) / 10} h` : "—"}</td>
                <td><input type="checkbox" checked={t.is_active} aria-label={`${t.name} offered`} onChange={(e) => void run(() => labApi(`/api/lab/catalog/${t.id}`, { method: "PATCH", body: { isActive: e.target.checked } }))} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <form className="mt-4 grid gap-2 rounded-2xl border border-subtle bg-surface p-4 sm:grid-cols-4" onSubmit={(e) => {
        e.preventDefault()
        const f = new FormData(e.currentTarget)
        const el = e.currentTarget
        void run(() => labApi("/api/lab/catalog", { body: {
          code: f.get("code"), name: f.get("name"), section: f.get("section"), loincCode: String(f.get("loinc") ?? "").trim() || null,
          specimenType: f.get("specimen") || "blood", container: f.get("container") || null, unit: f.get("unit") || null,
          price: num(f.get("price")), turnaroundMinutes: num(f.get("tat")),
        } }).then(() => el.reset()), "Test added")
      }}>
        <h2 className="text-sm font-semibold sm:col-span-4">Add a test</h2>
        <input name="name" required placeholder="Name" className="rounded border border-edge bg-elevated px-2 py-1 text-sm" />
        <input name="code" required placeholder="Code (e.g. ESR)" className="rounded border border-edge bg-elevated px-2 py-1 text-sm" />
        <input name="loinc" placeholder="LOINC (for analysers)" className="rounded border border-edge bg-elevated px-2 py-1 text-sm" />
        <select name="section" className="rounded border border-edge bg-elevated px-2 py-1 text-sm">{LAB_SECTIONS.map((s) => <option key={s} value={s}>{LAB_SECTION_LABEL[s]}</option>)}</select>
        <input name="specimen" placeholder="Specimen (blood)" className="rounded border border-edge bg-elevated px-2 py-1 text-sm" />
        <input name="container" placeholder="Container" className="rounded border border-edge bg-elevated px-2 py-1 text-sm" />
        <input name="unit" placeholder="Unit" className="rounded border border-edge bg-elevated px-2 py-1 text-sm" />
        <input name="price" type="number" min={0} placeholder="Price" className="rounded border border-edge bg-elevated px-2 py-1 text-sm" />
        <input name="tat" type="number" min={1} placeholder="Turnaround (min)" className="rounded border border-edge bg-elevated px-2 py-1 text-sm" />
        <button type="submit" className="rounded-lg bg-orange-500 px-3 py-1.5 text-sm font-semibold text-black sm:col-span-3 sm:justify-self-start">Add test</button>
      </form>

      <h2 className="mt-8 text-lg font-semibold">Reference ranges</h2>
      <section className="mt-3 overflow-x-auto rounded-2xl border border-subtle bg-surface">
        <table className="w-full min-w-[640px] text-sm">
          <thead className="text-left text-xs text-muted-color"><tr><th className="p-3">Test</th><th>Who</th><th>Normal</th><th>Critical</th><th>Source</th><th /></tr></thead>
          <tbody>
            {ranges.map((r) => (
              <tr key={r.id} className="border-t border-subtle">
                <td className="p-3">{r.test_name}<div className="text-xs text-muted-color">LOINC {r.loinc_code}</div></td>
                <td className="text-xs">{r.sex ?? "All"}{r.age_min_years != null || r.age_max_years != null ? ` · ${r.age_min_years ?? 0}–${r.age_max_years ?? "∞"} y` : ""}</td>
                <td>{r.low}–{r.high} {r.unit}</td>
                <td className="text-xs">{r.critical_low != null ? `≤ ${r.critical_low}` : ""}{r.critical_low != null && r.critical_high != null ? " · " : ""}{r.critical_high != null ? `≥ ${r.critical_high}` : ""}</td>
                <td className="text-xs">{r.scope === "laboratory" ? "This lab" : "National pack"}</td>
                <td>{r.scope === "laboratory" ? <button type="button" onClick={() => void run(() => labApi(`/api/lab/reference-ranges?id=${r.id}`, { method: "DELETE" }))} className="text-xs text-rose-700 underline dark:text-rose-300">Remove</button> : null}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
      <form className="mt-4 grid gap-2 rounded-2xl border border-subtle bg-surface p-4 sm:grid-cols-5" onSubmit={(e) => {
        e.preventDefault()
        const f = new FormData(e.currentTarget)
        const el = e.currentTarget
        void run(() => labApi("/api/lab/reference-ranges", { body: {
          loincCode: f.get("loinc"), testName: f.get("name"), unit: f.get("unit"), sex: f.get("sex") || null,
          ageMinYears: num(f.get("amin")), ageMaxYears: num(f.get("amax")), low: num(f.get("low")), high: num(f.get("high")),
          criticalLow: num(f.get("clow")), criticalHigh: num(f.get("chigh")),
        } }).then(() => el.reset()), "Interval saved")
      }}>
        <h2 className="text-sm font-semibold sm:col-span-5">Add this lab’s interval</h2>
        <input name="name" required placeholder="Test" className="rounded border border-edge bg-elevated px-2 py-1 text-sm" />
        <input name="loinc" required placeholder="LOINC" className="rounded border border-edge bg-elevated px-2 py-1 text-sm" />
        <input name="unit" required placeholder="Unit" className="rounded border border-edge bg-elevated px-2 py-1 text-sm" />
        <select name="sex" className="rounded border border-edge bg-elevated px-2 py-1 text-sm"><option value="">All</option><option value="F">Female</option><option value="M">Male</option></select>
        <div className="flex gap-1"><input name="amin" type="number" placeholder="Age from" className="w-1/2 rounded border border-edge bg-elevated px-2 py-1 text-sm" /><input name="amax" type="number" placeholder="to" className="w-1/2 rounded border border-edge bg-elevated px-2 py-1 text-sm" /></div>
        <input name="low" required type="number" step="any" placeholder="Low" className="rounded border border-edge bg-elevated px-2 py-1 text-sm" />
        <input name="high" required type="number" step="any" placeholder="High" className="rounded border border-edge bg-elevated px-2 py-1 text-sm" />
        <input name="clow" type="number" step="any" placeholder="Critical low" className="rounded border border-edge bg-elevated px-2 py-1 text-sm" />
        <input name="chigh" type="number" step="any" placeholder="Critical high" className="rounded border border-edge bg-elevated px-2 py-1 text-sm" />
        <button type="submit" className="rounded-lg bg-orange-500 px-3 py-1.5 text-sm font-semibold text-black">Save interval</button>
      </form>
    </main>
  )
}
