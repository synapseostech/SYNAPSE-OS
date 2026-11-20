'use client'

import { useEffect, useRef, useState } from 'react'
import { CheckCircle2, Loader2, Search, X } from 'lucide-react'
import type { WorkspaceDiagnosis } from './types'

type Hit = { stemCode: string; title: string; isLeaf?: boolean; isResidual?: boolean }

export function DiagnosesCard({
  diagnoses,
  onAdd,
  onRemove,
  disabled,
}: {
  diagnoses: WorkspaceDiagnosis[]
  onAdd: (code: string, certainty: 'suspected' | 'confirmed', fromEngine: boolean) => Promise<void>
  onRemove: (code: string) => Promise<void>
  disabled?: boolean
}) {
  const [q, setQ] = useState('')
  const [hits, setHits] = useState<Hit[]>([])
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    if (timer.current) clearTimeout(timer.current)
    const term = q.trim()
    if (term.length < 2) {
      setHits([])
      return
    }
    timer.current = setTimeout(async () => {
      setLoading(true)
      try {
        const res = await fetch(`/api/terminology/icd11/search?q=${encodeURIComponent(term)}&limit=12`, { credentials: 'include' })
        const body = await res.json().catch(() => ({}))
        setHits(res.ok && Array.isArray(body.hits) ? body.hits : [])
      } finally {
        setLoading(false)
      }
    }, 220)
    return () => {
      if (timer.current) clearTimeout(timer.current)
    }
  }, [q])

  const run = async (key: string, fn: () => Promise<void>) => {
    setBusy(key)
    try {
      await fn()
    } finally {
      setBusy(null)
    }
  }

  return (
    <section className="clinical-card p-4" aria-label="Diagnoses">
      <h2 className="text-sm font-semibold text-primary-color">Diagnoses (ICD-11)</h2>

      {diagnoses.length > 0 ? (
        <ul className="mt-2 space-y-1.5">
          {diagnoses.map((d) => (
            <li key={d.stem_code} className="flex items-start gap-2 rounded-lg bg-elevated px-2.5 py-1.5">
              <code className="mt-0.5 font-mono text-[11px] text-gold">{d.stem_code}</code>
              <span className="min-w-0 flex-1 text-sm text-primary-color">
                {d.title}
                <span className={`ml-1.5 text-[11px] ${d.certainty === 'confirmed' ? 'text-emerald-600 dark:text-emerald-400' : 'text-amber-600 dark:text-amber-400'}`}>
                  {d.certainty === 'confirmed' ? 'confirmed' : 'working'}
                </span>
              </span>
              {d.certainty !== 'confirmed' && (
                <button
                  type="button"
                  disabled={disabled || busy != null}
                  onClick={() => run(`c-${d.stem_code}`, () => onAdd(d.stem_code, 'confirmed', d.suggested_by === 'synapse_intelligence'))}
                  className="text-emerald-600 hover:text-emerald-500 disabled:opacity-50 dark:text-emerald-400"
                  title="Mark confirmed"
                  aria-label={`Confirm ${d.title}`}
                >
                  {busy === `c-${d.stem_code}` ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}
                </button>
              )}
              <button
                type="button"
                disabled={disabled || busy != null}
                onClick={() => run(`r-${d.stem_code}`, () => onRemove(d.stem_code))}
                className="text-muted-color hover:text-red-500 disabled:opacity-50"
                aria-label={`Remove ${d.title}`}
              >
                {busy === `r-${d.stem_code}` ? <Loader2 className="h-4 w-4 animate-spin" /> : <X className="h-4 w-4" />}
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-1 text-xs text-muted-color">None yet. Pick from the likely diagnoses or search the full WHO list.</p>
      )}

      <div className="relative mt-3">
        <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-muted-color" aria-hidden />
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          disabled={disabled}
          placeholder="Search ICD-11: name, code or shorthand (UTI, PUD, HTN)"
          className="w-full rounded-xl border border-subtle bg-transparent py-2 pl-8 pr-8 text-sm text-primary-color placeholder:text-muted-color focus:border-orange focus:outline-none"
          aria-label="Search ICD-11"
        />
        {loading && <Loader2 className="absolute right-2.5 top-2.5 h-4 w-4 animate-spin text-muted-color" aria-hidden />}
      </div>
      {hits.length > 0 && (
        <ul className="mt-1 max-h-72 overflow-auto rounded-xl border border-subtle" role="listbox">
          {hits.map((h) => (
            <li key={h.stemCode} className="flex items-center gap-2 border-b border-subtle px-2.5 py-1.5 last:border-0">
              <code className="w-16 shrink-0 font-mono text-[11px] text-gold">{h.stemCode}</code>
              <span className={`min-w-0 flex-1 text-sm ${h.isLeaf === false ? 'text-secondary-color' : 'text-primary-color'}`}>{h.title}</span>
              <button
                type="button"
                disabled={disabled || busy != null}
                onClick={() =>
                  run(`a-${h.stemCode}`, async () => {
                    await onAdd(h.stemCode, 'suspected', false)
                    setQ('')
                  })
                }
                className="shrink-0 rounded-lg border border-subtle px-2 py-0.5 text-xs text-primary-color hover:border-strong disabled:opacity-50"
              >
                {busy === `a-${h.stemCode}` ? <Loader2 className="h-3 w-3 animate-spin" /> : 'Add'}
              </button>
            </li>
          ))}
        </ul>
      )}
      <p className="mt-2 text-[11px] text-muted-color">ICD-11 © World Health Organization. Full MMS 2026-01, works offline.</p>
    </section>
  )
}
