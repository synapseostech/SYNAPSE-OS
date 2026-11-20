'use client'

import { useMemo, useState } from 'react'
import { FINDINGS, FINDING_IDS, type BodySystem, type FindingId, type FindingMap, type FindingState } from '@synapse/interop/differential-engine'
import { Check, Minus, Sparkles } from 'lucide-react'

const SYSTEMS: { id: BodySystem | 'all'; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'general', label: 'General' },
  { id: 'respiratory', label: 'Chest' },
  { id: 'ent', label: 'ENT' },
  { id: 'gastrointestinal', label: 'Abdomen' },
  { id: 'genitourinary', label: 'GU' },
  { id: 'obstetric', label: 'Obstetric' },
  { id: 'neurological', label: 'Neuro' },
  { id: 'cardiovascular', label: 'CVS' },
  { id: 'endocrine', label: 'Endocrine' },
  { id: 'skin', label: 'Skin' },
  { id: 'musculoskeletal', label: 'MSK' },
  { id: 'eye', label: 'Eye' },
]

const GROUPS = [
  { id: 'symptom', label: 'Symptoms' },
  { id: 'sign', label: 'Examination' },
  { id: 'history', label: 'History & risk' },
] as const

function next(state: FindingState | undefined): FindingState | undefined {
  if (!state) return 'present'
  if (state === 'present') return 'absent'
  return undefined
}

function Chip({
  id,
  tapped,
  fromText,
  highlight,
  onToggle,
  disabled,
}: {
  id: FindingId
  tapped?: FindingState
  fromText?: FindingState
  highlight?: boolean
  onToggle: (id: FindingId) => void
  disabled?: boolean
}) {
  const state = tapped ?? fromText
  const base = 'inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs transition focus:outline-none focus-visible:ring-2 focus-visible:ring-orange-500'
  const look =
    state === 'present'
      ? 'border-emerald-500/50 bg-emerald-500/15 text-emerald-700 dark:text-emerald-300'
      : state === 'absent'
        ? 'border-red-500/40 bg-red-500/10 text-red-600 line-through decoration-1 dark:text-red-300'
        : highlight
          ? 'border-orange bg-orange-500/10 text-orange'
          : 'border-subtle text-secondary-color hover:border-strong hover:text-primary-color'
  const auto = !tapped && fromText ? 'border-dashed' : ''
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={() => onToggle(id)}
      className={`${base} ${look} ${auto}`}
      aria-pressed={state === 'present' ? true : state === 'absent' ? 'mixed' : false}
      title={!tapped && fromText ? 'Read from your notes. Tap to confirm or change.' : 'Tap: present → absent → clear'}
    >
      {state === 'present' && <Check className="h-3 w-3" aria-hidden />}
      {state === 'absent' && <Minus className="h-3 w-3" aria-hidden />}
      {highlight && !state && <Sparkles className="h-3 w-3" aria-hidden />}
      {FINDINGS[id].label}
    </button>
  )
}

export function FindingsPicker({
  tapped,
  fromText,
  askNext,
  onChange,
  disabled,
}: {
  tapped: FindingMap
  fromText: FindingMap
  askNext: { id: FindingId; label: string }[]
  onChange: (next: FindingMap) => void
  disabled?: boolean
}) {
  const [system, setSystem] = useState<BodySystem | 'all'>('all')
  const [query, setQuery] = useState('')
  const ask = useMemo(() => new Set(askNext.map((a) => a.id)), [askNext])

  const toggle = (id: FindingId) => {
    const current = tapped[id] ?? fromText[id]
    const value = next(current)
    const out: FindingMap = { ...tapped }
    // Clearing a tapped finding falls back to what the notes say, if anything.
    if (value) out[id] = value
    else delete out[id]
    onChange(out)
  }

  const visible = FINDING_IDS.filter((id) => {
    const f = FINDINGS[id]
    if (f.group === 'vital') return false
    if (system !== 'all' && f.system !== system) return false
    if (query && !f.label.toLowerCase().includes(query.toLowerCase())) return false
    return true
  })

  return (
    <div>
      {askNext.length > 0 && (
        <div className="mb-3 rounded-xl border border-orange-500/40 bg-orange-500/5 p-3">
          <div className="mb-2 flex items-center gap-1.5 text-xs font-medium text-orange">
            <Sparkles className="h-3.5 w-3.5" aria-hidden /> Ask or examine next: these separate the leading diagnoses
          </div>
          <div className="flex flex-wrap gap-1.5">
            {askNext.map((a) => (
              <Chip key={a.id} id={a.id} tapped={tapped[a.id]} fromText={fromText[a.id]} highlight onToggle={toggle} disabled={disabled} />
            ))}
          </div>
        </div>
      )}

      <div className="mb-2 flex flex-wrap items-center gap-1.5">
        {SYSTEMS.map((s) => (
          <button
            key={s.id}
            type="button"
            onClick={() => setSystem(s.id)}
            className={`rounded-lg px-2.5 py-1 text-xs font-medium transition ${system === s.id ? 'bg-orange-500 text-white' : 'bg-elevated text-secondary-color hover:text-primary-color'}`}
          >
            {s.label}
          </button>
        ))}
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Filter findings…"
          className="ml-auto w-36 rounded-lg border border-subtle bg-transparent px-2.5 py-1 text-xs text-primary-color placeholder:text-muted-color focus:border-orange focus:outline-none"
          aria-label="Filter findings"
        />
      </div>

      {GROUPS.map((g) => {
        const items = visible.filter((id) => FINDINGS[id].group === g.id)
        if (!items.length) return null
        return (
          <div key={g.id} className="mt-2">
            <div className="mb-1 text-[11px] font-medium uppercase tracking-wide text-muted-color">{g.label}</div>
            <div className="flex flex-wrap gap-1.5">
              {items.map((id) => (
                <Chip key={id} id={id} tapped={tapped[id]} fromText={fromText[id]} highlight={ask.has(id)} onToggle={toggle} disabled={disabled} />
              ))}
            </div>
          </div>
        )
      })}
    </div>
  )
}
