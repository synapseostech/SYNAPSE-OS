'use client'

import Link from 'next/link'
import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react'
import {
  differentialFromConsultation,
  extractFindings,
  interpretQualitativeResult,
  investigationCodeFor,
  type FindingMap,
  type InvestigationOutcome,
  type Vitals,
} from '@synapse/interop/differential-engine'
import { Activity, CheckCircle2, ClipboardSignature, Cloud, CloudOff, FileText, FlaskConical, Loader2, Lock, Pill, RefreshCw, Route } from 'lucide-react'
import { DifferentialPanel, type OrderableTest } from './DifferentialPanel'
import { DiagnosesCard } from './DiagnosesCard'
import { FindingsPicker } from './FindingsPicker'
import { LastVisitCard, PatientBanner, TrendsCard } from './PatientContextPanel'
import type { WorkspaceResponse } from './types'

type Fields = {
  hpi: string
  ros: string
  pmh: string
  medications: string
  allergies: string
  familySocial: string
  examination: string
  assessment: string
  plan: string
}

const FIELD_META: { key: keyof Fields; label: string; placeholder: string; rows: number }[] = [
  { key: 'hpi', label: 'History of presenting complaint', placeholder: 'Onset, duration, character, what makes it better or worse… e.g. “Hotness of body for 3 days with chills and joint pains, no cough”', rows: 4 },
  { key: 'ros', label: 'Review of systems', placeholder: 'Pertinent positives and negatives: “No diarrhoea, no burning urine”', rows: 2 },
  { key: 'pmh', label: 'Past medical & surgical history', placeholder: 'Chronic illness, admissions, operations, HIV status, pregnancies', rows: 2 },
  { key: 'medications', label: 'Current medicines', placeholder: 'Including herbal and over-the-counter', rows: 2 },
  { key: 'allergies', label: 'Allergies', placeholder: 'Drug and food allergies, with reaction', rows: 1 },
  { key: 'familySocial', label: 'Family & social history', placeholder: 'Occupation, alcohol, smoking, contacts, travel', rows: 2 },
  { key: 'examination', label: 'Examination', placeholder: 'General: pale, not jaundiced… Chest: crepitations right base… Abdomen: soft, spleen palpable', rows: 4 },
]

type VitalsDraft = Record<'bp_systolic' | 'bp_diastolic' | 'heart_rate' | 'respiratory_rate' | 'temperature_c' | 'spo2' | 'weight_kg', string>

const VITAL_FIELDS: { key: keyof VitalsDraft; label: string; unit: string; step?: string }[] = [
  { key: 'bp_systolic', label: 'BP sys', unit: 'mmHg' },
  { key: 'bp_diastolic', label: 'BP dia', unit: 'mmHg' },
  { key: 'heart_rate', label: 'Pulse', unit: '/min' },
  { key: 'respiratory_rate', label: 'Resp', unit: '/min' },
  { key: 'temperature_c', label: 'Temp', unit: '°C', step: '0.1' },
  { key: 'spo2', label: 'SpO₂', unit: '%' },
  { key: 'weight_kg', label: 'Weight', unit: 'kg', step: '0.1' },
]

function toDraft(v: WorkspaceResponse['encounter']['vitals']): VitalsDraft {
  const s = (x: unknown) => (x == null || x === '' ? '' : String(x))
  return {
    bp_systolic: s(v?.bp_systolic),
    bp_diastolic: s(v?.bp_diastolic),
    heart_rate: s(v?.heart_rate),
    respiratory_rate: s(v?.respiratory_rate),
    temperature_c: s(v?.temperature_c),
    spo2: s(v?.spo2),
    weight_kg: s(v?.weight_kg),
  }
}

function numOrNull(s: string): number | null {
  if (!s.trim()) return null
  const n = Number(s)
  return Number.isFinite(n) ? n : null
}

type SaveState = 'idle' | 'saving' | 'saved' | 'error'

export function ConsultationWorkspace({ encounterId }: { encounterId: string }) {
  const [data, setData] = useState<WorkspaceResponse | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [fields, setFields] = useState<Fields | null>(null)
  const [tapped, setTapped] = useState<FindingMap>({})
  const [vitals, setVitals] = useState<VitalsDraft>(toDraft(null))
  const [vitalsDirty, setVitalsDirty] = useState(false)
  const [vitalsSaving, setVitalsSaving] = useState(false)
  const [save, setSave] = useState<SaveState>('idle')
  const [notice, setNotice] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null)
  const dirty = useRef(false)
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const load = useCallback(
    async (opts?: { keepEdits?: boolean }) => {
      const res = await fetch(`/api/opd/encounters/${encounterId}/workspace`, { credentials: 'include', cache: 'no-store' })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) {
        setLoadError(typeof body.error === 'string' ? body.error : `Could not load (HTTP ${res.status})`)
        return
      }
      const ws = body as WorkspaceResponse
      if (!ws?.encounter || !ws.summary) {
        setLoadError('The server returned an incomplete record. Reload, and report it if it happens again.')
        return
      }
      setData(ws)
      if (!opts?.keepEdits) {
        const w = ws.encounter.writeup
        setFields({ hpi: w.hpi, ros: w.ros, pmh: w.pmh, medications: w.medications, allergies: w.allergies, familySocial: w.familySocial, examination: w.examination, assessment: w.assessment, plan: w.plan })
        setTapped(ws.encounter.findings ?? {})
        setVitals(toDraft(ws.encounter.vitals))
        setVitalsDirty(false)
      }
    },
    [encounterId],
  )

  useEffect(() => {
    void load()
  }, [load])

  const locked = Boolean(data?.encounter.isSigned)
  const context = useMemo(
    () => ({ ageYears: data?.summary.patient.ageYears ?? null, sex: data?.summary.patient.sex ?? null, pregnant: data?.summary.patient.pregnant ?? null }),
    [data?.summary.patient.ageYears, data?.summary.patient.sex, data?.summary.patient.pregnant],
  )

  const noteText = useMemo(() => {
    if (!fields) return ''
    return [data?.encounter.chiefComplaint ?? '', fields.hpi, fields.ros, fields.pmh, fields.medications, fields.familySocial, fields.examination].join('\n')
  }, [fields, data?.encounter.chiefComplaint])
  const deferredText = useDeferredValue(noteText)

  const engineVitals: Vitals = useMemo(
    () => ({
      temperatureC: numOrNull(vitals.temperature_c),
      heartRate: numOrNull(vitals.heart_rate),
      respiratoryRate: numOrNull(vitals.respiratory_rate),
      spo2: numOrNull(vitals.spo2),
      bpSystolic: numOrNull(vitals.bp_systolic),
      bpDiastolic: numOrNull(vitals.bp_diastolic),
    }),
    [vitals],
  )

  // Today's qualitative results (MRDT negative, GeneXpert positive…) feed back
  // into the ranking, so the list narrows as results arrive.
  const outcomes = useMemo<InvestigationOutcome[]>(() => {
    const out: InvestigationOutcome[] = []
    for (const o of data?.encounter.labOrders ?? []) {
      const code = investigationCodeFor(o)
      const r = o.results[0]
      if (!code || !r) continue
      const positive = interpretQualitativeResult(r.result_value ?? r.value)
      if (positive != null) out.push({ code, positive })
    }
    return out
  }, [data?.encounter.labOrders])

  const fromText = useMemo(() => extractFindings(deferredText), [deferredText])
  const result = useMemo(
    () => differentialFromConsultation({ text: deferredText, tapped, vitals: engineVitals, context, limit: 8, outcomes }),
    [deferredText, tapped, engineVitals, context, outcomes],
  )

  // Autosave the write-up and findings 1.2 s after the last change.
  const persist = useCallback(async () => {
    if (!fields || locked) return
    setSave('saving')
    const res = await fetch(`/api/opd/encounters/${encounterId}/write-up`, {
      method: 'PUT',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...fields,
        findings: tapped,
        differential: result.differentials.slice(0, 5).map((d) => ({ id: d.id, code: d.icd11.code, score: d.score })),
      }),
    }).catch(() => null)
    if (res?.ok) {
      dirty.current = false
      setSave('saved')
    } else {
      setSave('error')
    }
  }, [encounterId, fields, tapped, result.differentials, locked])

  const persistRef = useRef(persist)
  persistRef.current = persist
  const markDirty = () => {
    dirty.current = true
    setSave('idle')
    if (saveTimer.current) clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(() => void persistRef.current(), 1200)
  }

  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => {
      if (dirty.current) {
        e.preventDefault()
        e.returnValue = ''
      }
    }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [])

  const flash = (kind: 'ok' | 'error', text: string) => {
    setNotice({ kind, text })
    setTimeout(() => setNotice(null), 4000)
  }

  const saveVitals = async () => {
    if (!data) return
    const payload: Record<string, unknown> = { encounter_id: encounterId, patient_id: data.encounter.patientId }
    for (const f of VITAL_FIELDS) {
      const n = numOrNull(vitals[f.key])
      if (n != null) payload[f.key] = n
    }
    setVitalsSaving(true)
    try {
      const res = await fetch('/api/opd/vitals', { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        flash('error', typeof body.error === 'string' ? body.error : 'Vitals not saved: check the values')
        return
      }
      setVitalsDirty(false)
      flash('ok', 'Vitals saved')
      await load({ keepEdits: true })
    } finally {
      setVitalsSaving(false)
    }
  }

  const addDiagnosis = async (code: string, certainty: 'suspected' | 'confirmed', fromEngine: boolean) => {
    const res = await fetch(`/api/opd/encounters/${encounterId}/diagnoses`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ stem_code: code, certainty, suggested_by: fromEngine ? 'synapse_intelligence' : 'clinician' }),
    })
    const body = await res.json().catch(() => ({}))
    if (!res.ok) {
      flash('error', typeof body.error === 'string' ? body.error : 'Diagnosis not saved')
      return
    }
    flash('ok', `${code} ${certainty === 'confirmed' ? 'confirmed' : 'added'}`)
    await load({ keepEdits: true })
  }

  const removeDiagnosis = async (code: string) => {
    const res = await fetch(`/api/opd/encounters/${encounterId}/diagnoses?stem_code=${encodeURIComponent(code)}`, { method: 'DELETE', credentials: 'include' })
    if (!res.ok) {
      flash('error', 'Could not remove the diagnosis')
      return
    }
    await load({ keepEdits: true })
  }

  const orderTest = async (t: OrderableTest, urgent: boolean) => {
    if (!data) return
    if (t.kind === 'imaging') {
      // The indication goes with the request: complaint plus the diagnoses being considered.
      const considering = result.differentials.slice(0, 2).map((d) => `?${d.name}`).join(', ')
      const indication = [data.encounter.chiefComplaint, considering].filter(Boolean).join('. ') || t.name
      const res = await fetch('/api/hospital/radiology/orders', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ encounter_id: encounterId, exam_code: t.examCode, clinical_indication: indication.slice(0, 2000), priority: urgent ? 'urgent' : 'routine' }),
      })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) {
        flash('error', body.error === 'module_disabled' ? 'Radiology is not switched on for this hospital' : typeof body.error === 'string' ? body.error : `${t.name} not requested`)
        return
      }
      flash('ok', `${t.name} requested from radiology`)
      await load({ keepEdits: true })
      return
    }
    const res = await fetch('/api/opd/lab-orders', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ encounter_id: encounterId, patient_id: data.encounter.patientId, loinc_code: t.loinc, test_name: t.name, urgency: urgent ? 'URGENT' : 'ROUTINE' }),
    })
    const body = await res.json().catch(() => ({}))
    if (!res.ok) {
      flash('error', typeof body.error === 'string' ? body.error : `${t.name} not ordered`)
      return
    }
    flash('ok', `${t.name} sent to the lab`)
    await load({ keepEdits: true })
  }

  const insertAssessment = () => {
    if (!data || !fields) return
    const dx = data.encounter.diagnoses
    const lines = dx.length
      ? dx.map((d) => `${d.title} (ICD-11 ${d.stem_code})${d.certainty === 'confirmed' ? '' : ', working diagnosis'}`)
      : result.differentials.slice(0, 3).map((d) => `?${d.name} (ICD-11 ${d.icd11.code})`)
    const text = `${lines.join('\n')}`
    setFields({ ...fields, assessment: fields.assessment ? `${fields.assessment}\n${text}` : text })
    markDirty()
  }

  if (loadError) {
    return (
      <main className="clinical-page mx-auto max-w-3xl px-4 py-10">
        <div className="clinical-card p-6">
          <h1 className="text-lg font-semibold text-primary-color">Consultation could not open</h1>
          <p className="mt-2 text-sm text-secondary-color">{loadError}</p>
          <button type="button" onClick={() => { setLoadError(null); void load() }} className="btn-secondary mt-4 inline-flex items-center gap-2 text-sm">
            <RefreshCw className="h-4 w-4" aria-hidden /> Try again
          </button>
        </div>
      </main>
    )
  }

  if (!data || !fields) {
    return (
      <main className="clinical-page px-4 py-6" aria-busy="true">
        <div className="mx-auto grid max-w-[1600px] gap-4 xl:grid-cols-[320px_minmax(0,1fr)_380px]">
          {[0, 1, 2].map((i) => (
            <div key={i} className="clinical-card h-96 animate-pulse" />
          ))}
        </div>
      </main>
    )
  }

  const enc = data.encounter
  const SaveIcon = save === 'saving' ? Loader2 : save === 'error' ? CloudOff : save === 'saved' ? CheckCircle2 : Cloud

  return (
    <main className="clinical-page px-3 pb-16 pt-4 sm:px-4">
      <div className="mx-auto max-w-[1600px]">
        <header className="mb-4 flex flex-wrap items-center gap-3">
          <div className="min-w-0 flex-1">
            <p className="text-xs uppercase tracking-wide text-muted-color">Consultation · {enc.visitDate ? new Date(enc.visitDate).toLocaleString() : ''}</p>
            <p className="truncate text-base text-primary-color">
              <span className="text-muted-color">Complaint: </span>
              {enc.chiefComplaint || 'not recorded at triage'}
            </p>
          </div>
          <span className={`inline-flex items-center gap-1.5 text-xs ${save === 'error' ? 'text-red-500' : 'text-muted-color'}`} role="status">
            {locked ? (
              <>
                <Lock className="h-3.5 w-3.5" aria-hidden /> Signed: read only
              </>
            ) : (
              <>
                <SaveIcon className={`h-3.5 w-3.5 ${save === 'saving' ? 'animate-spin' : ''}`} aria-hidden />
                {save === 'saving' ? 'Saving…' : save === 'saved' ? 'Saved' : save === 'error' ? 'Not saved: retrying on next change' : 'Autosave on'}
              </>
            )}
          </span>
          <nav className="flex flex-wrap gap-1.5" aria-label="Encounter steps">
            <Link href={`/encounter/${encounterId}/orders`} className="btn-secondary inline-flex items-center gap-1.5 !px-3 !py-1.5 text-xs">
              <Pill className="h-3.5 w-3.5" aria-hidden /> Prescribe
            </Link>
            <Link href={`/encounter/${encounterId}/disposition`} className="btn-secondary inline-flex items-center gap-1.5 !px-3 !py-1.5 text-xs">
              <Route className="h-3.5 w-3.5" aria-hidden /> Disposition
            </Link>
            <Link href={`/encounter/${encounterId}/history`} className="btn-secondary inline-flex items-center gap-1.5 !px-3 !py-1.5 text-xs">
              <FileText className="h-3.5 w-3.5" aria-hidden /> Timeline
            </Link>
            <Link href={`/encounter/${encounterId}/sign`} className="btn-primary inline-flex items-center gap-1.5 !px-3 !py-1.5 text-xs">
              <ClipboardSignature className="h-3.5 w-3.5" aria-hidden /> Sign
            </Link>
          </nav>
        </header>

        {result.differentials[0] && (
          <a
            href="#likely-diagnoses"
            className="fixed inset-x-3 bottom-3 z-40 flex items-center gap-2 rounded-2xl border border-subtle bg-surface px-4 py-2.5 shadow-lg xl:hidden"
          >
            <span className="text-[11px] uppercase tracking-wide text-muted-color">Likely</span>
            <span className="min-w-0 flex-1 truncate text-sm font-semibold text-primary-color">{result.differentials[0].name}</span>
            <code className="font-mono text-[11px] text-gold">{result.differentials[0].icd11.code}</code>
            {result.dangerSigns.length > 0 && <span className="rounded-full bg-red-500 px-1.5 text-[10px] font-semibold text-white">!</span>}
          </a>
        )}

        {notice && (
          <div className={`fixed bottom-4 left-1/2 z-50 -translate-x-1/2 rounded-xl px-4 py-2 text-sm shadow-lg ${notice.kind === 'ok' ? 'bg-emerald-600 text-white' : 'bg-red-600 text-white'}`} role="status">
            {notice.text}
          </div>
        )}

        <div className="grid gap-4 xl:grid-cols-[320px_minmax(0,1fr)_380px]">
          {/* Left: who is this patient and what happened before */}
          <aside className="space-y-4 xl:sticky xl:top-4 xl:max-h-[calc(100vh-2rem)] xl:overflow-y-auto">
            <PatientBanner summary={data.summary} dangerSigns={result.dangerSigns} />
            <LastVisitCard summary={data.summary} />
            <TrendsCard summary={data.summary} />
          </aside>

          {/* Centre: today's history and examination */}
          <section className="space-y-4" aria-label="History and examination">
            <div className="clinical-card p-4">
              <div className="mb-3 flex items-center justify-between gap-2">
                <h2 className="flex items-center gap-2 text-sm font-semibold text-primary-color">
                  <Activity className="h-4 w-4 text-orange" aria-hidden /> Vitals
                </h2>
                {vitalsDirty && !locked && (
                  <button type="button" onClick={saveVitals} disabled={vitalsSaving} className="btn-primary inline-flex items-center gap-1.5 !px-3 !py-1 text-xs">
                    {vitalsSaving && <Loader2 className="h-3 w-3 animate-spin" aria-hidden />} Save vitals
                  </button>
                )}
              </div>
              <div className="grid grid-cols-4 gap-2 sm:grid-cols-7">
                {VITAL_FIELDS.map((f) => {
                  const flagged = result.findings[
                    f.key === 'temperature_c' ? 'v_fever' : f.key === 'spo2' ? 'v_hypoxia' : f.key === 'heart_rate' ? 'v_tachycardia' : f.key === 'respiratory_rate' ? 'v_tachypnoea' : f.key === 'bp_systolic' ? 'v_bp_high' : 'v_hypotension'
                  ] === 'present' && f.key !== 'weight_kg' && f.key !== 'bp_diastolic'
                  return (
                    <label key={f.key} className={`rounded-xl border px-2 py-1.5 ${flagged ? 'border-orange-500/60 bg-orange-500/5' : 'border-subtle'}`}>
                      <span className="block text-[10px] uppercase tracking-wide text-muted-color">{f.label}</span>
                      <input
                        inputMode="decimal"
                        type="number"
                        step={f.step ?? '1'}
                        value={vitals[f.key]}
                        disabled={locked}
                        onChange={(e) => {
                          setVitals({ ...vitals, [f.key]: e.target.value })
                          setVitalsDirty(true)
                        }}
                        className={`w-full bg-transparent font-mono text-base font-semibold focus:outline-none ${flagged ? 'text-orange' : 'text-primary-color'}`}
                        aria-label={`${f.label} (${f.unit})`}
                      />
                      <span className="block text-[10px] text-muted-color">{f.unit}</span>
                    </label>
                  )
                })}
              </div>
            </div>

            <div className="clinical-card p-4">
              <h2 className="mb-3 text-sm font-semibold text-primary-color">History & examination</h2>
              <div className="space-y-3">
                {FIELD_META.map((f) => (
                  <label key={f.key} className="block">
                    <span className="mb-1 block text-xs font-medium text-secondary-color">{f.label}</span>
                    <textarea
                      rows={f.rows}
                      value={fields[f.key]}
                      disabled={locked}
                      placeholder={f.placeholder}
                      onChange={(e) => {
                        setFields({ ...fields, [f.key]: e.target.value })
                        markDirty()
                      }}
                      className="w-full resize-y rounded-xl border border-subtle bg-transparent px-3 py-2 text-sm text-primary-color placeholder:text-muted-color focus:border-orange focus:outline-none"
                    />
                  </label>
                ))}
              </div>
            </div>

            <div className="clinical-card p-4">
              <h2 className="mb-1 text-sm font-semibold text-primary-color">Findings</h2>
              <p className="mb-3 text-xs text-muted-color">Tap once for present, twice for absent (a pertinent negative). Dashed chips were read from your notes.</p>
              <FindingsPicker
                tapped={tapped}
                fromText={fromText}
                askNext={result.askNext}
                disabled={locked}
                onChange={(next) => {
                  setTapped(next)
                  markDirty()
                }}
              />
            </div>

            <div className="clinical-card p-4">
              <div className="mb-2 flex items-center justify-between gap-2">
                <h2 className="text-sm font-semibold text-primary-color">Assessment & plan</h2>
                {!locked && (
                  <button type="button" onClick={insertAssessment} className="text-xs text-orange hover:underline">
                    Insert diagnoses
                  </button>
                )}
              </div>
              {(['assessment', 'plan'] as const).map((k) => (
                <label key={k} className="mt-2 block">
                  <span className="mb-1 block text-xs font-medium text-secondary-color">{k === 'assessment' ? 'Assessment' : 'Plan (investigations, treatment, follow-up)'}</span>
                  <textarea
                    rows={3}
                    value={fields[k]}
                    disabled={locked}
                    onChange={(e) => {
                      setFields({ ...fields, [k]: e.target.value })
                      markDirty()
                    }}
                    className="w-full resize-y rounded-xl border border-subtle bg-transparent px-3 py-2 text-sm text-primary-color placeholder:text-muted-color focus:border-orange focus:outline-none"
                  />
                </label>
              ))}
            </div>
          </section>

          {/* Right: what it probably is, and how to prove it */}
          <aside id="likely-diagnoses" className="scroll-mt-4 space-y-4 xl:sticky xl:top-4 xl:max-h-[calc(100vh-2rem)] xl:overflow-y-auto">
            <div className="clinical-card p-4">
              <DifferentialPanel
                result={result}
                catalog={data.labCatalog}
                orders={enc.labOrders}
                imaging={enc.imaging ?? []}
                diagnoses={enc.diagnoses}
                onAddDiagnosis={addDiagnosis}
                onOrder={orderTest}
                disabled={locked}
              />
            </div>
            <DiagnosesCard diagnoses={enc.diagnoses} onAdd={addDiagnosis} onRemove={removeDiagnosis} disabled={locked} />
            <section className="clinical-card p-4" aria-label="Investigations ordered today">
              <h2 className="flex items-center gap-2 text-sm font-semibold text-primary-color">
                <FlaskConical className="h-4 w-4 text-orange" aria-hidden /> Ordered today
              </h2>
              {enc.labOrders.length === 0 && (enc.imaging ?? []).length === 0 ? (
                <p className="mt-1 text-xs text-muted-color">Nothing yet. Order from a diagnosis above.</p>
              ) : (
                <ul className="mt-2 space-y-1.5">
                  {enc.labOrders.map((o) => {
                    const r = o.results[0]
                    return (
                      <li key={o.id} className="flex items-start justify-between gap-2 text-sm">
                        <span className="min-w-0">
                          <span className="text-primary-color">{o.test_name}</span>
                          {o.accession_number && <span className="ml-1.5 font-mono text-[11px] text-muted-color">{o.accession_number}</span>}
                          {r && (
                            <span className={`block text-xs ${r.is_critical ? 'font-semibold text-red-500' : r.is_abnormal ? 'text-orange' : 'text-emerald-600 dark:text-emerald-400'}`}>
                              {String(r.result_value ?? r.value ?? r.numeric_value ?? '')} {r.unit ?? ''}
                            </span>
                          )}
                        </span>
                        <span className="shrink-0 rounded-full bg-elevated px-2 py-0.5 text-[11px] text-secondary-color">{(o.workflow_status ?? o.status ?? 'ordered').replace(/_/g, ' ')}</span>
                      </li>
                    )
                  })}
                  {(enc.imaging ?? []).map((st) => {
                    const rep = st.worklist_status === 'verified' ? st.radiology_reports?.[0] : undefined
                    return (
                      <li key={st.id} className="flex items-start justify-between gap-2 text-sm">
                        <span className="min-w-0">
                          <span className="text-primary-color">{st.study_description ?? st.modality}</span>
                          {st.accession_number && <span className="ml-1.5 font-mono text-[11px] text-muted-color">{st.accession_number}</span>}
                          {rep && (
                            <a href={`/api/hospital/radiology/studies/${st.id}/report`} target="_blank" rel="noopener" className={`block text-xs underline decoration-dotted ${rep.is_critical ? 'font-semibold text-red-500' : 'text-primary-color'}`}>
                              {rep.impression}
                            </a>
                          )}
                        </span>
                        <span className="shrink-0 rounded-full bg-elevated px-2 py-0.5 text-[11px] text-secondary-color">{st.worklist_status === 'verified' ? 'reported' : st.worklist_status.replace(/_/g, ' ')}</span>
                      </li>
                    )
                  })}
                </ul>
              )}
            </section>
          </aside>
        </div>
      </div>
    </main>
  )
}
