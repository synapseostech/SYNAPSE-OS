'use client'

import { useEffect, useRef, useState } from 'react'
import type { SelectedPatient } from '../../hooks/usePatientContext'

interface PatientSearchProps {
  onSelect: (patient: SelectedPatient) => void
}

interface FoundPatient {
  id: string
  fullName: string
  mrn: string | null
  dob: string | null
  sex: string | null
  phoneLast4: string | null
  matchKind: string
}

const DEBOUNCE_MS = 250

function ageFrom(dob: string | null): string | null {
  if (!dob) return null
  const born = new Date(dob)
  if (Number.isNaN(born.getTime())) return null
  const years = Math.floor((Date.now() - born.getTime()) / (365.25 * 24 * 3600 * 1000))
  return years >= 0 ? `${years}y` : null
}

export function PatientSearch({ onSelect }: PatientSearchProps) {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<FoundPatient[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const latest = useRef(0)

  useEffect(() => {
    const q = query.trim()
    if (q.length < 2) {
      setResults([])
      setLoading(false)
      return
    }
    const seq = ++latest.current
    const timer = setTimeout(async () => {
      setLoading(true)
      setError(null)
      try {
        const res = await fetch(`/api/patients/search?q=${encodeURIComponent(q)}&limit=10`, { credentials: 'include' })
        const data = await res.json().catch(() => ({}))
        if (seq !== latest.current) return
        if (!res.ok) {
          setError(typeof data.error === 'string' ? data.error : 'Search failed')
          setResults([])
          return
        }
        setResults((data.patients ?? []) as FoundPatient[])
      } catch {
        if (seq === latest.current) setError('Search failed')
      } finally {
        if (seq === latest.current) setLoading(false)
      }
    }, DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [query])

  const showEmpty = !loading && !error && query.trim().length >= 2 && results.length === 0

  return (
    <div className="flex flex-col gap-2">
      <input
        type="search"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Name, MRN, phone or NIN"
        aria-label="Search patients by name, MRN, phone or NIN"
        className="rounded border border-edge bg-transparent px-3 py-2 text-sm text-primary-color"
      />
      {loading && <p className="text-xs opacity-60">Searching…</p>}
      {error && <p className="text-xs text-red-600">{error}</p>}
      {showEmpty && <p className="text-xs opacity-60">No patient found. Register a new one.</p>}
      {results.length > 0 && (
        <ul className="flex flex-col divide-y divide-[var(--border-subtle)] rounded border border-edge">
          {results.map((p) => {
            const facts = [p.sex, ageFrom(p.dob), p.phoneLast4 ? `phone …${p.phoneLast4}` : null].filter(Boolean).join(' · ')
            return (
              <li key={p.id}>
                <button
                  type="button"
                  onClick={() => onSelect({ id: p.id, fullName: p.fullName, mrn: p.mrn })}
                  className="w-full px-3 py-2 text-left text-sm hover:bg-surface"
                >
                  <span className="font-medium">{p.fullName}</span> {p.mrn ? <span className="opacity-70">({p.mrn})</span> : null}
                  {facts && <span className="block text-xs opacity-60">{facts}</span>}
                </button>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
