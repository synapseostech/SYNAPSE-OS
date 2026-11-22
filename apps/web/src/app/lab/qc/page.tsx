"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import { AlertTriangle, CheckCircle2, Lock } from "lucide-react"
import { labApi } from "../_components/client"
import { leveyJenningsPoints, previewZ, QC_LEVELS, QC_RULES, type QcAnalyteSummary, type QcMaterialRow, type QcRunRow, type QcStatus } from "@/lib/lab/qc"

type Material = QcMaterialRow & { runs: QcRunRow[]; observed: { n: number; mean: number | null; sd: number | null; cv: number | null } }
type Board = { days: number; summary: QcAnalyteSummary[]; materials: Material[]; canManage: boolean }
type BatchRun = { id: string; material_id: string; value: number; z: number; rules: string[]; status: QcStatus }
type Batch = { batchId: string; status: QcStatus; runs: BatchRun[] }

const STATUS_STYLE: Record<QcStatus, string> = {
  accepted: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
  warning: "bg-amber-500/15 text-amber-800 dark:text-amber-300",
  rejected: "bg-rose-500/15 text-rose-700 dark:text-rose-300",
}
const STATUS_LABEL: Record<QcStatus, string> = { accepted: "In control", warning: "Warning (1-2s)", rejected: "Rejected" }
const input = "rounded border border-edge bg-elevated px-2 py-1 text-sm"
const fmt = (v: number | string | null | undefined, places = 2) => (v == null || v === "" ? "—" : Number(v).toFixed(places).replace(/\.?0+$/, ""))
const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "never")

function RuleChips({ rules }: { rules: string[] }) {
  if (!rules.length) return null
  return (
    <span className="inline-flex flex-wrap gap-1">
      {rules.map((r) => (
        <span key={r} title={QC_RULES[r]?.meaning} className={`rounded px-1.5 py-0.5 font-mono text-xs ${QC_RULES[r]?.rejects ? STATUS_STYLE.rejected : STATUS_STYLE.warning}`}>
          {QC_RULES[r]?.label ?? r}
        </span>
      ))}
    </span>
  )
}

/** Levey-Jennings chart: z-score per run against the mean and ±1/2/3 SD lines. */
function LeveyJennings({ material }: { material: Material }) {
  const points = leveyJenningsPoints(material.runs)
  const mean = Number(material.target_mean)
  const sd = Number(material.target_sd)
  const W = 640, H = 190, left = 64, right = 12, top = 10, bottom = 22
  const y = (z: number) => top + ((4 - z) / 8) * (H - top - bottom)
  const x = (i: number) => left + (points.length <= 1 ? (W - left - right) / 2 : (i / (points.length - 1)) * (W - left - right))
  const lines: Array<[number, string, string]> = [
    [3, "stroke-rose-500", "+3 SD"], [2, "stroke-amber-500", "+2 SD"], [1, "stroke-current opacity-30", "+1 SD"], [0, "stroke-current opacity-60", "Mean"],
    [-1, "stroke-current opacity-30", "-1 SD"], [-2, "stroke-amber-500", "-2 SD"], [-3, "stroke-rose-500", "-3 SD"],
  ]
  return (
    <figure className="mt-2">
      <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full text-secondary-color" role="img" aria-label={`Levey-Jennings chart, ${material.analyte_name} ${material.level}, ${points.length} runs`}>
        {lines.map(([z, cls, label]) => (
          <g key={z}>
            <line x1={left} x2={W - right} y1={y(z)} y2={y(z)} className={cls} strokeWidth={z === 0 ? 1.5 : 1} strokeDasharray={Math.abs(z) === 1 ? "3 4" : undefined} />
            <text x={left - 6} y={y(z) + 3.5} textAnchor="end" className="fill-current text-[10px]">{label === "Mean" ? fmt(mean) : `${fmt(mean + z * sd)}`}</text>
          </g>
        ))}
        {points.length > 1 ? (
          <polyline fill="none" className="stroke-current opacity-50" strokeWidth={1} points={points.map((p, i) => `${x(i)},${y(p.plotZ)}`).join(" ")} />
        ) : null}
        {points.map((p, i) => (
          <circle key={p.id} cx={x(i)} cy={y(p.plotZ)} r={p.status === "rejected" ? 5 : 3.5}
            className={p.status === "rejected" ? "fill-rose-500" : p.status === "warning" ? "fill-amber-500" : "fill-emerald-600 dark:fill-emerald-400"}>
            <title>{`${when(p.runAt)}: ${fmt(p.value, 3)} (z ${fmt(p.z)})${p.rules.length ? ` · ${p.rules.map((r) => QC_RULES[r]?.label ?? r).join(", ")}` : ""}`}</title>
          </circle>
        ))}
        {!points.length ? <text x={W / 2} y={H / 2} textAnchor="middle" className="fill-current text-xs">No runs yet</text> : null}
      </svg>
      <figcaption className="text-xs text-muted-color">
        Target {fmt(mean, 3)} ± {fmt(sd, 3)} {material.unit ?? ""} · observed over {material.observed.n} accepted runs: mean {fmt(material.observed.mean, 3)}, SD {fmt(material.observed.sd, 3)}, CV {material.observed.cv == null ? "—" : `${material.observed.cv}%`}
      </figcaption>
    </figure>
  )
}

function RecordRun({ summary, onSaved }: { summary: QcAnalyteSummary; onSaved: (batch: Batch) => Promise<void> }) {
  const [values, setValues] = useState<Record<string, string>>({})
  const [comment, setComment] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function save() {
    const results = summary.levels
      .filter((m) => (values[m.id] ?? "").trim() !== "")
      .map((m) => ({ materialId: m.id, value: Number(values[m.id]) }))
    if (!results.length) return setError("Enter at least one control value")
    if (results.some((r) => !Number.isFinite(r.value))) return setError("Control values must be numbers")
    setBusy(true)
    setError(null)
    try {
      const { batch } = await labApi<{ batch: Batch }>("/api/lab/qc/runs", { body: { results, ...(comment.trim() ? { comment: comment.trim() } : {}) } })
      setValues({})
      setComment("")
      await onSaved(batch)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save")
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="mt-3 rounded-xl border border-subtle bg-elevated/40 p-3">
      <p className="text-sm font-semibold">Record a run</p>
      <div className="mt-2 flex flex-wrap items-end gap-3">
        {summary.levels.map((m) => {
          const z = values[m.id] ? previewZ(Number(values[m.id]), Number(m.target_mean), Number(m.target_sd)) : null
          return (
            <label key={m.id} className="text-xs">
              <span className="block text-muted-color">{m.level} · lot {m.lot_number}</span>
              <input inputMode="decimal" aria-label={`${summary.analyteName} ${m.level} value`} value={values[m.id] ?? ""} onChange={(e) => setValues({ ...values, [m.id]: e.target.value })} className={`${input} w-28`} />
              <span className={`ml-2 font-mono ${z != null && Math.abs(z) > 3 ? "text-rose-600" : z != null && Math.abs(z) > 2 ? "text-amber-600" : "text-muted-color"}`}>
                {z == null ? "" : `z ${z > 0 ? "+" : ""}${z}`}
              </span>
            </label>
          )
        })}
        <label className="text-xs">
          <span className="block text-muted-color">Comment (optional)</span>
          <input value={comment} maxLength={500} onChange={(e) => setComment(e.target.value)} className={`${input} w-56`} />
        </label>
        <button type="button" disabled={busy} onClick={() => void save()} className="rounded-lg bg-orange-500 px-3 py-1.5 text-sm font-semibold text-black disabled:opacity-50">
          {busy ? "Saving…" : "Save run"}
        </button>
      </div>
      {error ? <p role="alert" className="mt-2 text-sm text-rose-700 dark:text-rose-300">{error}</p> : null}
    </div>
  )
}

function CorrectiveAction({ run, onSaved }: { run: QcRunRow; onSaved: () => Promise<void> }) {
  const [open, setOpen] = useState(false)
  const [text, setText] = useState("")
  const [error, setError] = useState<string | null>(null)
  if (run.corrective_action) return <span className="text-xs">{run.corrective_action}</span>
  if (!open) return <button type="button" onClick={() => setOpen(true)} className="text-xs text-orange underline">Record corrective action</button>
  return (
    <span className="flex flex-wrap items-center gap-2">
      <input autoFocus aria-label="Corrective action" placeholder="Recalibrated; new control vial; reran" value={text} onChange={(e) => setText(e.target.value)} className={`${input} w-64`} />
      <button type="button" className="rounded border border-edge px-2 py-1 text-xs" onClick={() => void labApi(`/api/lab/qc/runs/${run.id}/corrective-action`, { body: { action: text } }).then(onSaved).catch((e) => setError(e.message))}>Save</button>
      {error ? <span role="alert" className="text-xs text-rose-700 dark:text-rose-300">{error}</span> : null}
    </span>
  )
}

function ControlSetup({ onSaved }: { onSaved: () => Promise<void> }) {
  const [error, setError] = useState<string | null>(null)
  async function submit(form: HTMLFormElement) {
    const f = new FormData(form)
    const s = (k: string) => String(f.get(k) ?? "").trim()
    setError(null)
    try {
      await labApi("/api/lab/qc/materials", {
        body: {
          loincCode: s("loincCode"), analyteName: s("analyteName"), unit: s("unit") || null, materialName: s("materialName"),
          lotNumber: s("lotNumber"), level: s("level"), targetMean: Number(s("targetMean")), targetSd: Number(s("targetSd")),
          expiresOn: s("expiresOn") || null,
        },
      })
      form.reset()
      await onSaved()
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save")
    }
  }
  return (
    <form onSubmit={(e) => { e.preventDefault(); void submit(e.currentTarget) }} className="mt-3 grid gap-2 rounded-2xl border border-subtle bg-surface p-4 sm:grid-cols-5">
      <p className="text-sm font-semibold sm:col-span-5">Add a control level</p>
      <input name="analyteName" required placeholder="Analyte (Haemoglobin)" className={input} />
      <input name="loincCode" required placeholder="LOINC (718-7)" pattern="\d{1,7}-\d" className={input} />
      <input name="unit" placeholder="Unit (g/dL)" className={input} />
      <input name="materialName" required placeholder="Control material" className={input} />
      <input name="lotNumber" required placeholder="Lot number" className={input} />
      <select name="level" className={input} defaultValue="L1">{QC_LEVELS.map((l) => <option key={l}>{l}</option>)}</select>
      <input name="targetMean" required inputMode="decimal" placeholder="Target mean" className={input} />
      <input name="targetSd" required inputMode="decimal" placeholder="Target SD" className={input} />
      <label className="text-xs text-muted-color">Lot expires<input name="expiresOn" type="date" className={`${input} ml-2`} /></label>
      <button type="submit" className="rounded-lg bg-orange-500 px-3 py-1.5 text-sm font-semibold text-black sm:justify-self-start">Add control</button>
      <p className="text-xs text-muted-color sm:col-span-5">Use the manufacturer&apos;s mean and SD until the lab has about 20 runs of its own, then adopt the observed values shown under each chart.</p>
      {error ? <p role="alert" className="text-sm text-rose-700 dark:text-rose-300 sm:col-span-5">{error}</p> : null}
    </form>
  )
}

function ControlRow({ material, canManage, onSaved }: { material: Material; canManage: boolean; onSaved: () => Promise<void> }) {
  const [error, setError] = useState<string | null>(null)
  const patch = (body: Record<string, unknown>) => labApi(`/api/lab/qc/materials/${material.id}`, { method: "PATCH", body }).then(onSaved).catch((e) => setError(e.message))
  const canAdopt = material.observed.n >= 20 && material.observed.mean != null && material.observed.sd != null && material.observed.sd > 0
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs text-muted-color">
      <span>{material.material_name} · lot {material.lot_number}{material.expires_on ? ` · expires ${material.expires_on}` : ""}</span>
      {canManage ? (
        <>
          {canAdopt ? (
            <button type="button" className="rounded border border-edge px-2 py-0.5" onClick={() => {
              if (window.confirm(`Set the target to the observed mean ${material.observed.mean} and SD ${material.observed.sd}? Past runs keep the target they were judged against.`)) void patch({ targetMean: material.observed.mean, targetSd: material.observed.sd })
            }}>Adopt observed mean and SD</button>
          ) : null}
          <button type="button" className="rounded border border-edge px-2 py-0.5" onClick={() => {
            const note = material.last_run_status === "rejected" ? " Its last run was rejected: switching it off lifts the release lock it holds." : ""
            if (window.confirm(`Switch off ${material.analyte_name} ${material.level} lot ${material.lot_number}?${note}`)) void patch({ isActive: false })
          }}>Switch off</button>
        </>
      ) : null}
      {error ? <span role="alert" className="text-rose-700 dark:text-rose-300">{error}</span> : null}
    </div>
  )
}

export default function LabQcPage() {
  const [board, setBoard] = useState<Board | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [last, setLast] = useState<Batch | null>(null)
  const [open, setOpen] = useState<string | null>(null)

  const load = useCallback(async () => {
    setBoard(await labApi<Board>("/api/lab/qc"))
  }, [])
  useEffect(() => { load().catch((e) => setError(e.message)) }, [load])

  const byId = useMemo(() => new Map((board?.materials ?? []).map((m) => [m.id, m])), [board])
  const locked = board?.summary.filter((s) => s.locked) ?? []
  const notRun = board?.summary.filter((s) => !s.locked && s.notRunToday) ?? []

  return (
    <main className="clinical-page p-4 sm:p-8">
      <h1 className="font-display text-2xl">Quality control</h1>
      <p className="mt-1 max-w-3xl text-sm text-muted-color">
        Run your controls, and each value is checked against the Westgard rules (1-2s warning; 1-3s, 2-2s, R-4s, 4-1s and 10x reject).
        While a control is rejected, results for that test cannot be authorised or released. Fix the cause, record what you did, and run the control again.
      </p>

      {error ? <p role="alert" className="mt-4 text-sm text-rose-700 dark:text-rose-300">{error}</p> : null}

      {locked.length ? (
        <div role="alert" className="mt-4 flex items-start gap-2 rounded-2xl border border-rose-500/40 bg-rose-500/10 p-4 text-sm">
          <Lock className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          <p><strong>Results on hold:</strong> {locked.map((s) => `${s.analyteName} (${s.failedLevels.join(", ")})`).join("; ")}. Results for these tests cannot be authorised until their controls pass.</p>
        </div>
      ) : null}
      {notRun.length ? (
        <p className="mt-3 flex items-center gap-2 text-sm text-amber-800 dark:text-amber-300">
          <AlertTriangle className="h-4 w-4" aria-hidden /> Not run today: {notRun.map((s) => s.analyteName).join(", ")}
        </p>
      ) : null}

      {last ? (
        <div role="status" className={`mt-4 rounded-2xl p-4 text-sm ${STATUS_STYLE[last.status]}`}>
          <p className="font-semibold">{last.status === "rejected" ? "Run rejected: do not report patient results for this test." : last.status === "warning" ? "Warning: within limits, but check before reporting." : "Run accepted."}</p>
          <ul className="mt-1 space-y-1">
            {last.runs.map((r) => {
              const m = byId.get(r.material_id)
              return (
                <li key={r.id} className="flex flex-wrap items-center gap-2">
                  <span>{m ? `${m.analyte_name} ${m.level}` : "Control"}: {fmt(r.value, 3)} (z {r.z > 0 ? "+" : ""}{fmt(r.z)})</span>
                  <RuleChips rules={r.rules} />
                  {r.rules.filter((x) => QC_RULES[x]?.rejects).map((x) => <span key={x} className="text-xs">{QC_RULES[x]?.meaning}</span>)}
                </li>
              )
            })}
          </ul>
        </div>
      ) : null}

      {board && !board.summary.length ? (
        <p className="mt-6 text-sm text-muted-color">No controls are set up yet.{board.canManage ? " Add the control levels for each analyte below." : " Ask a lab scientist or lab administrator to set them up."}</p>
      ) : null}

      <div className="mt-6 space-y-4">
        {board?.summary.map((s) => {
          const state: QcStatus = s.locked ? "rejected" : s.levels.some((m) => m.last_run_status === "warning") ? "warning" : "accepted"
          const expanded = open === s.loincCode
          return (
            <section key={s.loincCode} aria-labelledby={`qc-${s.loincCode}`} className="rounded-2xl border border-subtle bg-surface p-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <h2 id={`qc-${s.loincCode}`} className="text-lg font-semibold">{s.analyteName} <span className="font-mono text-xs text-muted-color">{s.loincCode}</span></h2>
                  <p className="text-xs text-muted-color">Last run {when(s.lastRunAt)}{s.expiringSoon.length ? ` · expiring within 14 days: ${s.expiringSoon.join(", ")}` : ""}</p>
                </div>
                <div className="flex items-center gap-2">
                  <span className={`inline-flex items-center gap-1 rounded-full px-2 py-1 text-xs font-semibold ${STATUS_STYLE[state]}`}>
                    {state === "rejected" ? <Lock className="h-3 w-3" aria-hidden /> : state === "accepted" ? <CheckCircle2 className="h-3 w-3" aria-hidden /> : <AlertTriangle className="h-3 w-3" aria-hidden />}
                    {s.locked ? "Results on hold" : STATUS_LABEL[state]}
                  </span>
                  <button type="button" aria-expanded={expanded} onClick={() => setOpen(expanded ? null : s.loincCode)} className="rounded-lg border border-edge px-3 py-1 text-sm">
                    {expanded ? "Hide charts" : "Charts and log"}
                  </button>
                </div>
              </div>

              <RecordRun summary={s} onSaved={async (batch) => { setLast(batch); await load() }} />

              {expanded ? s.levels.map((level) => {
                const m = byId.get(level.id)
                if (!m) return null
                return (
                  <div key={m.id} className="mt-4 border-t border-subtle pt-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <h3 className="text-sm font-semibold">{m.level}</h3>
                      <ControlRow material={m} canManage={board.canManage} onSaved={load} />
                    </div>
                    <LeveyJennings material={m} />
                    <div className="mt-2 overflow-x-auto">
                      <table className="w-full min-w-[640px] text-sm">
                        <thead><tr className="text-left text-xs text-muted-color"><th className="p-2">When</th><th className="p-2">Value</th><th className="p-2">z</th><th className="p-2">Result</th><th className="p-2">Corrective action</th></tr></thead>
                        <tbody>
                          {m.runs.slice(0, 15).map((r) => (
                            <tr key={r.id} className="border-t border-subtle">
                              <td className="p-2 text-xs">{when(r.run_at)}</td>
                              <td className="p-2 font-mono">{fmt(r.value, 3)}</td>
                              <td className="p-2 font-mono">{fmt(r.z_score)}</td>
                              <td className="p-2"><span className={`rounded px-1.5 py-0.5 text-xs ${STATUS_STYLE[r.status]}`}>{STATUS_LABEL[r.status]}</span> <RuleChips rules={(r.rules ?? []).filter((x) => x !== "1_2s")} />{r.comment ? <span className="ml-1 text-xs text-muted-color">{r.comment}</span> : null}</td>
                              <td className="p-2">{r.status === "rejected" ? <CorrectiveAction run={r} onSaved={load} /> : null}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )
              }) : null}
            </section>
          )
        })}
      </div>

      {board?.canManage ? (
        <>
          <h2 className="mt-8 text-lg font-semibold">Set up controls</h2>
          <ControlSetup onSaved={load} />
        </>
      ) : null}
    </main>
  )
}
