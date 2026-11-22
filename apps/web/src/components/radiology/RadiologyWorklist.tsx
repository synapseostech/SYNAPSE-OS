'use client'

import Link from 'next/link'
import { useCallback, useEffect, useState } from 'react'
import { AlertTriangle, CheckCircle2, FileText, Loader2, Play, RefreshCw, ScanLine } from 'lucide-react'

type Report = { id: string; status: string; findings: string | null; impression: string | null; technique: string | null; recommendation: string | null; is_critical: boolean; reported_at: string | null }
type Study = {
  id: string
  accession_number: string | null
  modality: string
  body_part: string | null
  laterality: string | null
  study_description: string | null
  clinical_indication: string | null
  priority: 'stat' | 'urgent' | 'routine'
  worklist_status: 'pending' | 'in_progress' | 'reported' | 'verified'
  created_at: string
  patients?: { full_name: string | null; mrn: string | null; sex: string | null; dob: string | null } | null
  radiology_reports?: Report[] | Report | null
}

const VIEWS = [
  ['open', 'All open'],
  ['pending', 'To start'],
  ['in_progress', 'In progress'],
  ['reported', 'To verify'],
  ['verified', 'Verified'],
] as const

const PRIORITY = { stat: 'bg-red-600 text-white', urgent: 'bg-amber-500/20 text-amber-800 dark:text-amber-300', routine: '' }
const STATUS_LABEL = { pending: 'Requested', in_progress: 'In progress', reported: 'Draft report', verified: 'Verified' }

function reportOf(s: Study): Report | null {
  const r = s.radiology_reports
  return Array.isArray(r) ? r[0] ?? null : r ?? null
}

function ageOf(dob: string | null | undefined) {
  if (!dob) return null
  const y = (Date.now() - new Date(dob).getTime()) / (365.25 * 86_400_000)
  return Number.isFinite(y) && y >= 0 ? (y < 1 ? `${Math.floor(y * 12)} mo` : `${Math.floor(y)} y`) : null
}

function ReportEditor({ study, onDone, canVerify }: { study: Study; onDone: (msg: string) => void; canVerify: boolean }) {
  const r = reportOf(study)
  const [f, setF] = useState({ technique: r?.technique ?? '', findings: r?.findings ?? '', impression: r?.impression ?? '', recommendation: r?.recommendation ?? '', is_critical: Boolean(r?.is_critical) })
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const send = async (action: 'report' | 'verify') => {
    setBusy(action)
    setError(null)
    try {
      const res = await fetch(`/api/hospital/radiology/studies/${study.id}`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, technique: f.technique, findings: f.findings, impression: f.impression, recommendation: f.recommendation, is_critical: f.is_critical }),
      })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(res.status === 403 ? 'Your role cannot do this.' : typeof body.error === 'string' ? body.error : 'Not saved')
      onDone(action === 'verify' ? 'Report verified and sent to the clinician' : 'Draft saved')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Not saved')
    } finally {
      setBusy(null)
    }
  }

  const field = (key: 'technique' | 'findings' | 'impression' | 'recommendation', label: string, rows: number, required = false) => (
    <label className="block">
      <span className="mb-1 block text-xs font-medium text-secondary-color">{label}{required ? ' *' : ''}</span>
      <textarea rows={rows} value={f[key]} onChange={(e) => setF({ ...f, [key]: e.target.value })} className="w-full rounded-xl border border-subtle bg-transparent px-3 py-2 text-sm text-primary-color focus:border-orange focus:outline-none" />
    </label>
  )

  return (
    <div className="mt-3 space-y-2 rounded-xl bg-elevated p-3">
      {field('technique', 'Technique', 2)}
      {field('findings', 'Findings', 5, true)}
      {field('impression', 'Impression', 2, true)}
      {field('recommendation', 'Recommendation', 2)}
      <label className="flex items-center gap-2 text-sm text-red-600 dark:text-red-400">
        <input type="checkbox" checked={f.is_critical} onChange={(e) => setF({ ...f, is_critical: e.target.checked })} /> Critical finding: the clinician must be called
      </label>
      {error && <p className="text-sm text-red-600 dark:text-red-400" role="alert">{error}</p>}
      <div className="flex flex-wrap gap-2">
        <button type="button" disabled={busy != null} onClick={() => send('report')} className="btn-secondary inline-flex items-center gap-1.5 !px-3 !py-1.5 text-xs">
          {busy === 'report' && <Loader2 className="h-3 w-3 animate-spin" aria-hidden />} Save draft
        </button>
        {canVerify && study.worklist_status === 'reported' && (
          <button type="button" disabled={busy != null} onClick={() => send('verify')} className="inline-flex items-center gap-1.5 rounded-xl bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-emerald-500 disabled:opacity-50">
            {busy === 'verify' ? <Loader2 className="h-3 w-3 animate-spin" aria-hidden /> : <CheckCircle2 className="h-3.5 w-3.5" aria-hidden />} Verify &amp; send
          </button>
        )}
      </div>
    </div>
  )
}

/** Imaging worklist: request -> exam -> report -> verify. The server enforces who may do each step. */
export function RadiologyWorklist({ initialView = 'open', title = 'Imaging worklist' }: { initialView?: string; title?: string }) {
  const [view, setView] = useState(initialView)
  const [studies, setStudies] = useState<Study[] | null>(null)
  const [role, setRole] = useState<string>('')
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [open, setOpen] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)

  const load = useCallback(async (v: string) => {
    try {
      const res = await fetch(`/api/hospital/radiology/worklist?view=${encodeURIComponent(v)}`, { credentials: 'include', cache: 'no-store' })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(res.status === 403 ? (body.error === 'module_disabled' ? 'Radiology is not switched on for this hospital (Admin → Modules).' : 'Your role cannot see the imaging worklist.') : 'Could not load the worklist.')
      setStudies(body.studies ?? [])
      setRole(String(body.role ?? ''))
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load the worklist.')
    }
  }, [])

  useEffect(() => {
    const fromUrl = new URLSearchParams(window.location.search).get('view')
    if (fromUrl && VIEWS.some(([k]) => k === fromUrl)) setView(fromUrl)
  }, [])
  useEffect(() => { void load(view) }, [load, view])

  const done = (msg: string) => {
    setNotice(msg)
    setOpen(null)
    setTimeout(() => setNotice(null), 4000)
    void load(view)
  }

  const start = async (s: Study) => {
    setBusy(s.id)
    const res = await fetch(`/api/hospital/radiology/studies/${s.id}`, { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'start' }) })
    setBusy(null)
    if (res.ok) {
      setOpen(s.id)
      done('Exam started')
    } else {
      const body = await res.json().catch(() => ({}))
      setNotice(typeof body.error === 'string' ? body.error : 'Could not start')
    }
  }

  const canVerify = ['radiologist', 'hospital_admin', 'platform_admin'].includes(role)

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-xl font-semibold text-primary-color"><ScanLine className="h-5 w-5 text-orange" aria-hidden /> {title}</h1>
          <p className="text-sm text-secondary-color">Request → exam → report → radiologist verifies. STAT first.</p>
        </div>
        <button type="button" onClick={() => load(view)} className="btn-secondary inline-flex items-center !px-2.5 !py-1.5" aria-label="Refresh"><RefreshCw className="h-3.5 w-3.5" /></button>
      </div>
      <div className="flex flex-wrap gap-1.5" role="tablist">
        {VIEWS.map(([k, label]) => (
          <button key={k} type="button" role="tab" aria-selected={view === k} onClick={() => setView(k)} className={`rounded-lg px-3 py-1.5 text-xs font-medium ${view === k ? 'bg-orange-500 text-white' : 'bg-elevated text-secondary-color hover:text-primary-color'}`}>{label}</button>
        ))}
      </div>
      {notice && <p className="rounded-lg bg-emerald-500/10 px-3 py-2 text-sm text-emerald-700 dark:text-emerald-300" role="status">{notice}</p>}
      {error && <p className="rounded-lg bg-red-500/10 px-3 py-2 text-sm text-red-600 dark:text-red-400">{error}</p>}
      {!studies && !error && <div className="clinical-card h-40 animate-pulse" aria-busy="true" />}
      {studies && studies.length === 0 && <p className="clinical-card p-6 text-sm text-muted-color">Nothing here.</p>}
      <ul className="space-y-3">
        {(studies ?? []).map((s) => {
          const r = reportOf(s)
          return (
            <li key={s.id} className={`clinical-card p-4 ${r?.is_critical ? 'border-red-500/60' : ''}`}>
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="font-medium text-primary-color">
                    {s.study_description ?? s.modality}{s.laterality ? ` (${s.laterality})` : ''}
                    {s.priority !== 'routine' && <span className={`ml-2 rounded px-1.5 py-0.5 text-[11px] font-semibold uppercase ${PRIORITY[s.priority]}`}>{s.priority}</span>}
                    {r?.is_critical && <span className="ml-2 inline-flex items-center gap-1 rounded bg-red-600 px-1.5 py-0.5 text-[11px] font-semibold text-white"><AlertTriangle className="h-3 w-3" aria-hidden /> CRITICAL</span>}
                  </p>
                  <p className="text-xs text-muted-color">
                    {s.patients?.full_name ?? 'Patient'}{s.patients?.mrn ? ` · ${s.patients.mrn}` : ''}{s.patients?.sex ? ` · ${s.patients.sex}` : ''}{ageOf(s.patients?.dob) ? ` · ${ageOf(s.patients?.dob)}` : ''} · {STATUS_LABEL[s.worklist_status]} · <span className="font-mono">{s.accession_number}</span>
                  </p>
                  {s.clinical_indication && <p className="mt-1 text-sm text-secondary-color"><span className="text-muted-color">Indication: </span>{s.clinical_indication}</p>}
                  {r?.impression && s.worklist_status !== 'pending' && <p className="mt-1 text-sm text-primary-color"><span className="text-muted-color">Impression: </span>{r.impression}</p>}
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  {s.worklist_status === 'pending' && (
                    <button type="button" disabled={busy === s.id} onClick={() => start(s)} className="inline-flex items-center gap-1.5 rounded-lg bg-orange-500 px-3 py-1.5 text-xs font-semibold text-black disabled:opacity-50">
                      <Play className="h-3.5 w-3.5" aria-hidden /> Start exam
                    </button>
                  )}
                  {['in_progress', 'reported'].includes(s.worklist_status) && (
                    <button type="button" onClick={() => setOpen(open === s.id ? null : s.id)} className="btn-secondary !px-3 !py-1.5 text-xs">
                      {s.worklist_status === 'reported' ? (canVerify ? 'Review & verify' : 'Edit draft') : 'Write report'}
                    </button>
                  )}
                  {r && (
                    <a href={`/api/hospital/radiology/studies/${s.id}/report`} target="_blank" rel="noopener" className="inline-flex items-center gap-1 rounded-lg border border-edge px-3 py-1.5 text-xs">
                      <FileText className="h-3.5 w-3.5" aria-hidden /> {s.worklist_status === 'verified' ? 'Report' : 'Preview'}
                    </a>
                  )}
                </div>
              </div>
              {open === s.id && <ReportEditor study={s} onDone={done} canVerify={canVerify} />}
            </li>
          )
        })}
      </ul>
      <p className="text-xs text-muted-color">Exams are requested from the consultation screen. <Link href="/radiology/reports" className="underline">Verified reports</Link></p>
    </div>
  )
}
