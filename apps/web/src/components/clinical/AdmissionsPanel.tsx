'use client'

import { useCallback, useEffect, useState } from 'react'
import { PatientSearch } from '../hospital-dept/PatientSearch'
import type { SelectedPatient } from '../../hooks/usePatientContext'

type Bed = { id: string; ward: string; room: string | null; bed_number: string; status: string; current_patient_id: string | null }
type Inpatient = {
  id: string
  patientName: string | null
  mrn: string | null
  bedNumber: string | null
  ward: string | null
  reason: string
  admittedAt: string
}

const DISPOSITIONS = [
  ['home', 'Home'],
  ['referred', 'Referred'],
  ['transferred', 'Transferred'],
  ['left_against_advice', 'Left against advice'],
  ['absconded', 'Absconded'],
  ['died', 'Died (after death pronouncement)'],
] as const

async function readError(res: Response, fallback: string): Promise<string> {
  const data = await res.json().catch(() => ({}))
  return typeof data.error === 'string' ? data.error.replace(/_/g, ' ').toLowerCase() : fallback
}

export function AdmissionsPanel() {
  const [beds, setBeds] = useState<Bed[]>([])
  const [inpatients, setInpatients] = useState<Inpatient[]>([])
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const [patient, setPatient] = useState<SelectedPatient | null>(null)
  const [bedId, setBedId] = useState('')
  const [reason, setReason] = useState('')

  const [discharging, setDischarging] = useState<string | null>(null)
  const [disposition, setDisposition] = useState<string>('home')
  const [summary, setSummary] = useState('')

  const load = useCallback(async () => {
    const res = await fetch('/api/ipd/admissions', { credentials: 'include' })
    if (!res.ok) {
      setError(res.status === 403 ? 'Your role cannot see the ward.' : await readError(res, 'Could not load the ward'))
      return
    }
    const data = await res.json()
    setBeds(data.beds ?? [])
    setInpatients(data.inpatients ?? [])
    setError(null)
  }, [])

  useEffect(() => {
    load().catch(() => setError('Could not load the ward'))
  }, [load])

  const freeBeds = beds.filter((b) => !b.current_patient_id && b.status !== 'maintenance')

  async function admit(e: React.FormEvent) {
    e.preventDefault()
    if (!patient || !bedId || !reason.trim()) return
    setBusy(true)
    setNotice(null)
    try {
      const res = await fetch('/api/ipd/admissions', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ patient_id: patient.id, bed_id: bedId, reason: reason.trim() }),
      })
      if (!res.ok) {
        setNotice(await readError(res, 'Admission failed'))
        return
      }
      setNotice(`${patient.fullName} admitted`)
      setPatient(null)
      setBedId('')
      setReason('')
      await load()
    } finally {
      setBusy(false)
    }
  }

  async function discharge(e: React.FormEvent) {
    e.preventDefault()
    if (!discharging) return
    setBusy(true)
    setNotice(null)
    try {
      const res = await fetch(`/api/ipd/admissions/${discharging}/discharge`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ disposition, summary: summary.trim() || undefined }),
      })
      if (!res.ok) {
        setNotice(await readError(res, 'Discharge failed'))
        return
      }
      setNotice('Discharged; the bed is free again')
      setDischarging(null)
      setSummary('')
      await load()
    } finally {
      setBusy(false)
    }
  }

  return (
    <div>
      <h1 className="font-display text-2xl">Admissions</h1>
      <p className="mt-1 text-sm text-muted-color">
        {inpatients.length} admitted · {freeBeds.length} of {beds.length} beds free
      </p>
      {error ? <p className="mt-4 text-sm text-amber-700 dark:text-amber-300">{error}</p> : null}
      {notice ? <p className="mt-4 rounded-lg bg-overlay/60 px-3 py-2 text-xs" role="status">{notice}</p> : null}

      <div className="mt-6 grid gap-6 lg:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)]">
        <section aria-labelledby="inpatients">
          <h2 id="inpatients" className="text-sm font-semibold uppercase text-muted-color">On the ward</h2>
          <ul className="mt-3 divide-y divide-subtle rounded-xl border border-subtle">
            {inpatients.map((a) => (
              <li key={a.id} className="px-4 py-3 text-sm">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className="font-medium">{a.patientName ?? 'Patient'} <span className="text-xs text-muted-color">{a.mrn ?? ''}</span></p>
                    <p className="text-xs text-muted-color">
                      {a.ward ?? '—'} · bed {a.bedNumber ?? '—'} · since {new Date(a.admittedAt).toLocaleDateString()}
                    </p>
                    <p className="mt-1 text-xs">{a.reason}</p>
                  </div>
                  <button type="button" onClick={() => setDischarging(discharging === a.id ? null : a.id)}
                    className="shrink-0 rounded-lg border border-subtle px-3 py-1 text-xs">
                    Discharge
                  </button>
                </div>
                {discharging === a.id ? (
                  <form onSubmit={discharge} className="mt-3 grid gap-2 sm:grid-cols-[1fr_2fr_auto] sm:items-end">
                    <label className="text-xs text-muted-color">
                      Outcome
                      <select value={disposition} onChange={(e) => setDisposition(e.target.value)}
                        className="mt-1 block w-full rounded-lg border border-subtle bg-surface px-2 py-1.5 text-sm">
                        {DISPOSITIONS.map(([v, label]) => <option key={v} value={v}>{label}</option>)}
                      </select>
                    </label>
                    <label className="text-xs text-muted-color">
                      Discharge summary
                      <input value={summary} onChange={(e) => setSummary(e.target.value)} maxLength={4000}
                        className="mt-1 block w-full rounded-lg border border-subtle bg-surface px-2 py-1.5 text-sm" />
                    </label>
                    <button type="submit" disabled={busy} className="rounded-lg bg-teal-700 px-4 py-2 text-xs font-medium text-white disabled:opacity-50">
                      Confirm
                    </button>
                  </form>
                ) : null}
              </li>
            ))}
            {inpatients.length === 0 && !error ? (
              <li className="px-4 py-8 text-center text-sm text-muted-color">No one is admitted.</li>
            ) : null}
          </ul>
        </section>

        <section aria-labelledby="admit" className="clinical-card p-5">
          <h2 id="admit" className="text-sm font-semibold uppercase text-muted-color">Admit a patient</h2>
          <form onSubmit={admit} className="mt-3 flex flex-col gap-3 text-sm">
            {patient ? (
              <p className="flex items-center justify-between rounded-lg border border-subtle px-3 py-2">
                <span>{patient.fullName} <span className="text-xs text-muted-color">{patient.mrn ?? ''}</span></span>
                <button type="button" onClick={() => setPatient(null)} className="text-xs text-muted-color hover:underline">Change</button>
              </p>
            ) : (
              <PatientSearch onSelect={setPatient} />
            )}
            <label className="text-xs text-muted-color">
              Bed
              <select value={bedId} onChange={(e) => setBedId(e.target.value)} required
                className="mt-1 block w-full rounded-lg border border-subtle bg-surface px-2 py-1.5 text-sm">
                <option value="">Choose a free bed…</option>
                {freeBeds.map((b) => (
                  <option key={b.id} value={b.id}>{b.ward} · {b.bed_number}</option>
                ))}
              </select>
            </label>
            <label className="text-xs text-muted-color">
              Reason for admission
              <textarea value={reason} onChange={(e) => setReason(e.target.value)} required maxLength={2000} rows={3}
                className="mt-1 block w-full rounded-lg border border-subtle bg-surface px-2 py-1.5 text-sm" />
            </label>
            <button type="submit" disabled={busy || !patient || !bedId} className="self-start rounded-lg bg-teal-700 px-4 py-2 text-xs font-medium text-white disabled:opacity-50">
              {busy ? 'Saving…' : 'Admit'}
            </button>
            {beds.length === 0 && !error ? (
              <p className="text-xs text-muted-color">No beds yet. A facility admin adds wards and beds under Facility admin → Beds.</p>
            ) : null}
          </form>
        </section>
      </div>
    </div>
  )
}
