'use client'

import Link from 'next/link'
import { useState } from 'react'
import { adviceErrorMessage, toAdviceView, type AdviceApiPayload, type AdviceView } from '@/lib/clinical-intelligence/advice-view'

type Decision = 'ACCEPT' | 'MODIFY' | 'REJECT'

type VitalsInput = { heart_rate: string; bp_systolic: string; temperature: string; respiratory_rate: string; spo2: string }

const EMPTY_VITALS: VitalsInput = { heart_rate: '', bp_systolic: '', temperature: '', respiratory_rate: '', spo2: '' }

const VITAL_LABELS: Array<[keyof VitalsInput, string]> = [
  ['heart_rate', 'HR (bpm)'],
  ['bp_systolic', 'SBP (mmHg)'],
  ['temperature', 'Temp (°C)'],
  ['respiratory_rate', 'RR (/min)'],
  ['spo2', 'SpO₂ (%)'],
]

function numericVitals(v: VitalsInput): Record<string, number> | undefined {
  const out: Record<string, number> = {}
  for (const [key] of VITAL_LABELS) {
    const n = Number(v[key])
    if (v[key].trim() !== '' && Number.isFinite(n)) out[key] = n
  }
  return Object.keys(out).length ? out : undefined
}

function List({ title, items }: { title: string; items: string[] }) {
  if (!items.length) return null
  return (
    <div>
      <div className="text-xs font-medium uppercase tracking-wide text-muted-color">{title}</div>
      <ul className="mt-1 list-disc pl-5 text-sm text-secondary-color">
        {items.map((item, i) => (
          <li key={`${title}-${i}`}>{item}</li>
        ))}
      </ul>
    </div>
  )
}

/**
 * Clinician-initiated AI suggestion panel for one encounter (Wave 1, flag-gated).
 * Nothing is requested automatically, nothing is written to the clinical note,
 * and no order, pathway or diagnosis is created from here.
 */
export function EncounterAiPanel({ encounterId, backHref }: { encounterId: string; backHref: string }) {
  const [complaint, setComplaint] = useState('')
  const [vitals, setVitals] = useState<VitalsInput>(EMPTY_VITALS)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [view, setView] = useState<AdviceView | null>(null)
  const [editText, setEditText] = useState('')
  const [reason, setReason] = useState('')
  const [decisionState, setDecisionState] = useState<{ decision: Decision; persisted: boolean } | null>(null)
  const [deciding, setDeciding] = useState(false)

  async function requestSuggestion() {
    setLoading(true)
    setError(null)
    setView(null)
    setDecisionState(null)
    try {
      const res = await fetch('/api/clinical/intelligence/advise', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          encounterId,
          presentingComplaint: complaint.trim() || undefined,
          vitals: numericVitals(vitals),
        }),
      })
      if (!res.ok) {
        setError(adviceErrorMessage(res.status))
        return
      }
      const parsed = toAdviceView((await res.json()) as AdviceApiPayload)
      if (!parsed) {
        setError(adviceErrorMessage(500))
        return
      }
      setView(parsed)
      setEditText(parsed.headline)
    } catch {
      setError(adviceErrorMessage(0))
    } finally {
      setLoading(false)
    }
  }

  async function decide(decision: Decision) {
    if (!view) return
    setDeciding(true)
    setError(null)
    try {
      const res = await fetch('/api/clinical/intelligence/advise', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          encounterId,
          override: {
            recommendationId: view.recommendationId,
            decision,
            reason: reason.trim() || null,
            modifiedText: decision === 'MODIFY' ? editText.trim() || null : null,
          },
        }),
      })
      if (!res.ok) {
        setError(adviceErrorMessage(res.status))
        return
      }
      const body = (await res.json()) as { provenancePersisted?: boolean }
      setDecisionState({ decision, persisted: body.provenancePersisted === true })
    } catch {
      setError(adviceErrorMessage(0))
    } finally {
      setDeciding(false)
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <Link href={backHref} className="text-sm text-muted-color hover:text-primary-color">
          ← Back to encounter
        </Link>
        <h1 className="mt-1 font-display text-2xl text-primary-color">AI suggestions (Wave 1)</h1>
        <p className="mt-1 text-sm text-secondary-color">
          Advisory only. The AI cannot sign diagnoses, place orders, prescribe or start pathways. Your write-up is not changed.
        </p>
      </div>

      <section className="clinical-card space-y-3 p-4">
        <label className="block text-sm font-medium text-primary-color" htmlFor="ci-complaint">
          Presenting complaint
        </label>
        <input
          id="ci-complaint"
          className="w-full rounded-xl border border-subtle bg-base px-3 py-2 text-sm text-primary-color outline-none focus:border-strong"
          placeholder="Leave blank to use the encounter's chief complaint"
          value={complaint}
          maxLength={2000}
          onChange={(e) => setComplaint(e.target.value)}
        />
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
          {VITAL_LABELS.map(([key, label]) => (
            <label key={key} className="text-xs text-muted-color">
              {label}
              <input
                inputMode="decimal"
                className="mt-1 w-full rounded-xl border border-subtle bg-base px-2 py-1 text-sm text-primary-color outline-none focus:border-strong"
                value={vitals[key]}
                onChange={(e) => setVitals((prev) => ({ ...prev, [key]: e.target.value }))}
              />
            </label>
          ))}
        </div>
        <button
          type="button"
          onClick={requestSuggestion}
          disabled={loading}
          className="rounded-xl bg-[var(--brand-orange)] px-4 py-2 text-sm font-medium text-white disabled:opacity-40"
        >
          {loading ? 'Requesting…' : 'Request AI suggestion'}
        </button>
      </section>

      {error && (
        <div className="rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-600" role="alert">
          {error}{' '}
          <Link href={`/encounter/${encounterId}/notes`} className="underline">
            Open the write-up
          </Link>
        </div>
      )}

      {view && (
        <section className="clinical-card space-y-4 p-4" aria-label="AI suggestion">
          <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
            {view.label}
          </div>
          {view.warnings.map((w, i) => (
            <div key={`w-${i}`} className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-600">
              {w}
            </div>
          ))}
          <div>
            <div className="text-sm font-medium text-primary-color">{view.headline}</div>
            <div className="mt-1 text-xs text-muted-color">
              {view.confidenceText} · {view.sourceNote}
            </div>
            {view.reasoning && <p className="mt-2 text-sm text-secondary-color">{view.reasoning}</p>}
          </div>
          <List title="Evidence for" items={view.evidenceFor} />
          <List title="Evidence against" items={view.evidenceAgainst} />
          <List title="Suggested investigations / missing information" items={view.suggestedInvestigations} />
          <div>
            <div className="text-xs font-medium uppercase tracking-wide text-muted-color">ICD-11 candidates (verified)</div>
            {view.icd11.length ? (
              <ul className="mt-1 text-sm text-secondary-color">
                {view.icd11.map((c) => (
                  <li key={c.code}>
                    <span className="font-mono">{c.code}</span> — {c.title}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-1 text-sm text-muted-color">No verified ICD-11 candidate. Code from the write-up as usual.</p>
            )}
            {view.icd11RejectedNote && <p className="mt-1 text-xs text-muted-color">{view.icd11RejectedNote}</p>}
          </div>
          {view.pathwayNote && <p className="text-sm text-secondary-color">{view.pathwayNote}</p>}

          <div className="space-y-2 border-t border-subtle pt-4">
            <label className="block text-xs text-muted-color" htmlFor="ci-edit">
              Edit the suggestion (used only if you choose “Accept with edits”)
            </label>
            <textarea
              id="ci-edit"
              className="w-full rounded-xl border border-subtle bg-base px-3 py-2 text-sm text-primary-color outline-none focus:border-strong"
              rows={2}
              maxLength={4000}
              value={editText}
              onChange={(e) => setEditText(e.target.value)}
            />
            <label className="block text-xs text-muted-color" htmlFor="ci-reason">
              Reason (optional)
            </label>
            <input
              id="ci-reason"
              className="w-full rounded-xl border border-subtle bg-base px-3 py-2 text-sm text-primary-color outline-none focus:border-strong"
              maxLength={2000}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
            <div className="flex flex-wrap gap-2">
              {(
                [
                  ['ACCEPT', 'Accept'],
                  ['MODIFY', 'Accept with edits'],
                  ['REJECT', 'Reject'],
                ] as Array<[Decision, string]>
              ).map(([decision, label]) => (
                <button
                  key={decision}
                  type="button"
                  disabled={deciding || decisionState !== null}
                  onClick={() => decide(decision)}
                  className="rounded-xl border border-subtle px-4 py-2 text-sm text-primary-color disabled:opacity-40"
                >
                  {label}
                </button>
              ))}
            </div>
            {decisionState && (
              <p className="text-xs text-emerald-600">
                Decision recorded: {decisionState.decision}.{' '}
                {decisionState.persisted ? 'Saved to the AI audit log.' : 'Audit log not available in this environment.'} Document
                your own assessment in the write-up.
              </p>
            )}
          </div>
        </section>
      )}
    </div>
  )
}
