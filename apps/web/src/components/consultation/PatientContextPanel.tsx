'use client'

import type { ContinuitySummary } from '@synapse/db/patient-continuity'
import { AlertTriangle, CalendarClock, ClipboardList, FlaskConical, History, Info, Pill, ShieldAlert, Siren } from 'lucide-react'
import { Sparkline } from './Sparkline'

function fmtDate(iso: string | null | undefined) {
  if (!iso) return '–'
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? '–' : d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })
}

function ageLabel(age: number | null) {
  if (age == null) return null
  if (age < 1) return `${Math.max(0, Math.round(age * 12))} mo`
  return `${Math.floor(age)} y`
}

export function PatientBanner({ summary, dangerSigns }: { summary: ContinuitySummary; dangerSigns: { id: string; label: string }[] }) {
  const p = summary.patient
  const initials = (p.name ?? '?').split(/\s+/).map((s) => s[0]).filter(Boolean).slice(0, 2).join('').toUpperCase()
  return (
    <section className="clinical-card overflow-hidden" aria-label="Patient">
      <div className="flex items-center gap-3 p-4">
        <div className="bg-brand-gradient flex h-12 w-12 shrink-0 items-center justify-center rounded-full text-base font-semibold text-black" aria-hidden>
          {initials}
        </div>
        <div className="min-w-0">
          <h1 className="truncate text-lg font-semibold text-primary-color">{p.name ?? 'Unnamed patient'}</h1>
          <p className="text-sm text-secondary-color">
            {[ageLabel(p.ageYears), p.sex === 'F' ? 'Female' : p.sex === 'M' ? 'Male' : null, p.pregnant ? 'Pregnant' : null, p.mrn]
              .filter(Boolean)
              .join(' · ')}
          </p>
          <p className="text-xs text-muted-color">
            {summary.visitCount === 0 ? 'First visit' : `${summary.visitCount} previous visit${summary.visitCount > 1 ? 's' : ''} · since ${fmtDate(summary.firstSeen)}`}
            {p.bloodGroup ? ` · Blood group ${p.bloodGroup}` : ''}
          </p>
        </div>
      </div>

      {dangerSigns.length > 0 && (
        <div className="flex items-start gap-2 border-t border-subtle bg-red-500/10 px-4 py-2.5 text-sm text-red-500" role="alert">
          <Siren className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          <span>
            <strong>Danger signs:</strong> {dangerSigns.map((d) => d.label).join(', ')}
          </span>
        </div>
      )}

      <div className="flex flex-wrap gap-1.5 border-t border-subtle px-4 py-3">
        {summary.allergies.length === 0 ? (
          <span className="rounded-full border border-subtle px-2.5 py-0.5 text-xs text-muted-color">No known allergies recorded</span>
        ) : (
          summary.allergies.map((a) => (
            <span key={a.allergen} className="inline-flex items-center gap-1 rounded-full bg-red-500/15 px-2.5 py-0.5 text-xs font-medium text-red-500" title={a.reaction ?? undefined}>
              <ShieldAlert className="h-3 w-3" aria-hidden /> {a.allergen}
              {a.severity ? ` (${a.severity})` : ''}
            </span>
          ))
        )}
        {summary.chronicConditions.map((c) => (
          <span key={c} className="rounded-full border border-gold px-2.5 py-0.5 text-xs text-gold">
            {c}
          </span>
        ))}
      </div>
    </section>
  )
}

const ALERT_STYLE = {
  danger: 'bg-red-500/10 text-red-500',
  warning: 'bg-amber-500/10 text-amber-600 dark:text-amber-400',
  info: 'bg-sky-500/10 text-sky-600 dark:text-sky-400',
} as const

export function LastVisitCard({ summary }: { summary: ContinuitySummary }) {
  const lv = summary.lastVisit
  if (!lv) {
    return (
      <section className="clinical-card p-4" aria-label="Last visit">
        <h2 className="flex items-center gap-2 text-sm font-semibold text-primary-color">
          <History className="h-4 w-4 text-orange" aria-hidden /> Last visit
        </h2>
        <p className="mt-2 text-sm text-secondary-color">No earlier visit at this facility. Take a full history.</p>
      </section>
    )
  }
  return (
    <section className="clinical-card p-4" aria-label="Last visit">
      <div className="flex items-start justify-between gap-2">
        <h2 className="flex items-center gap-2 text-sm font-semibold text-primary-color">
          <History className="h-4 w-4 text-orange" aria-hidden /> Last visit
        </h2>
        <span className="flex items-center gap-1 text-xs text-muted-color">
          <CalendarClock className="h-3.5 w-3.5" aria-hidden />
          {fmtDate(lv.date)} · {lv.daysAgo === 0 ? 'today' : `${lv.daysAgo} d ago`}
        </span>
      </div>

      {lv.complaint && <p className="mt-2 text-sm text-primary-color">“{lv.complaint}”</p>}

      {lv.diagnoses.length > 0 && (
        <ul className="mt-2 space-y-1">
          {lv.diagnoses.map((d) => (
            <li key={d.code} className="flex items-baseline gap-2 text-sm">
              <code className="rounded bg-elevated px-1.5 py-0.5 font-mono text-[11px] text-gold">{d.code}</code>
              <span className="text-primary-color">{d.title}</span>
              {d.certainty && d.certainty !== 'confirmed' && <span className="text-xs text-muted-color">({d.certainty})</span>}
            </li>
          ))}
        </ul>
      )}

      {lv.vitals && (
        <p className="mt-2 font-mono text-xs text-secondary-color">
          {[lv.vitals.bp && `BP ${lv.vitals.bp}`, lv.vitals.temp != null && `T ${lv.vitals.temp}°C`, lv.vitals.hr != null && `HR ${lv.vitals.hr}`, lv.vitals.spo2 != null && `SpO₂ ${lv.vitals.spo2}%`, lv.vitals.weight != null && `${lv.vitals.weight} kg`]
            .filter(Boolean)
            .join(' · ')}
        </p>
      )}

      {lv.medications.length > 0 && (
        <div className="mt-3">
          <div className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-muted-color">
            <Pill className="h-3.5 w-3.5" aria-hidden /> Given
          </div>
          <p className="mt-1 text-sm text-secondary-color">{lv.medications.join(' · ')}</p>
        </div>
      )}

      {(lv.results.length > 0 || lv.pendingTests.length > 0) && (
        <div className="mt-3">
          <div className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-muted-color">
            <FlaskConical className="h-3.5 w-3.5" aria-hidden /> Tests
          </div>
          <ul className="mt-1 space-y-0.5 text-sm">
            {lv.results.map((r, i) => (
              <li key={`${r.name}-${i}`} className={r.critical ? 'font-semibold text-red-500' : r.abnormal ? 'text-orange' : 'text-secondary-color'}>
                {r.name}: <span className="font-mono">{r.value}</span> {r.unit}
                {r.critical ? ' · critical' : r.abnormal ? ' · abnormal' : ''}
              </li>
            ))}
            {lv.pendingTests.map((t, i) => (
              <li key={`p-${t.name}-${i}`} className="text-muted-color">
                {t.name}: <em>no result yet</em> ({t.status.replace(/_/g, ' ')})
              </li>
            ))}
          </ul>
        </div>
      )}

      {lv.plan && (
        <div className="mt-3 rounded-lg bg-elevated p-2.5 text-sm text-secondary-color">
          <span className="font-medium text-primary-color">Plan: </span>
          {lv.plan}
        </div>
      )}

      {summary.alerts.length > 0 && (
        <ul className="mt-3 space-y-1.5">
          {summary.alerts.map((a, i) => {
            const Icon = a.level === 'info' ? Info : AlertTriangle
            return (
              <li key={i} className={`flex items-start gap-2 rounded-lg px-2.5 py-1.5 text-xs ${ALERT_STYLE[a.level]}`}>
                <Icon className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden /> {a.text}
              </li>
            )
          })}
        </ul>
      )}

      {summary.workPlan.length > 0 && (
        <div className="mt-3 border-t border-subtle pt-3">
          <div className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-muted-color">
            <ClipboardList className="h-3.5 w-3.5" aria-hidden /> Today’s work plan
          </div>
          <ol className="mt-1.5 list-decimal space-y-1 pl-5 text-sm text-primary-color">
            {summary.workPlan.map((w, i) => (
              <li key={i}>{w}</li>
            ))}
          </ol>
        </div>
      )}
    </section>
  )
}

export function TrendsCard({ summary }: { summary: ContinuitySummary }) {
  const all = [...summary.vitalTrends, ...summary.labTrends].filter((s) => s.points.length > 0)
  return (
    <section className="clinical-card p-4" aria-label="Trends">
      <h2 className="text-sm font-semibold text-primary-color">Trends</h2>
      {all.length === 0 ? (
        <p className="mt-2 text-sm text-muted-color">Trends appear after vitals or results are recorded at two or more visits.</p>
      ) : (
        <div className="mt-2 divide-y divide-[var(--border-subtle)]">
          {all.map((s) => (
            <div key={s.key} className="py-2">
              <Sparkline series={s} />
            </div>
          ))}
        </div>
      )}
      {summary.recurringProblems.length > 0 && (
        <div className="mt-3 border-t border-subtle pt-3">
          <div className="text-xs font-medium uppercase tracking-wide text-muted-color">Problem history</div>
          <ul className="mt-1.5 space-y-1">
            {summary.recurringProblems.map((r) => (
              <li key={r.code} className="flex items-center justify-between gap-2 text-sm">
                <span className="truncate text-secondary-color">
                  <code className="mr-1.5 font-mono text-[11px] text-gold">{r.code}</code>
                  {r.title}
                </span>
                <span className="shrink-0 rounded-full bg-elevated px-2 text-xs text-muted-color">×{r.count}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {summary.visits.length > 1 && (
        <details className="mt-3 border-t border-subtle pt-3">
          <summary className="cursor-pointer text-xs font-medium uppercase tracking-wide text-muted-color">All visits ({summary.visits.length})</summary>
          <ul className="mt-2 space-y-1.5">
            {summary.visits.map((v) => (
              <li key={v.encounterId} className="text-sm">
                <a href={`/encounter/${v.encounterId}`} className="text-secondary-color hover:text-primary-color">
                  <span className="font-mono text-xs text-muted-color">{fmtDate(v.date)}</span> · {v.complaint ?? '—'}
                  {v.diagnoses.length > 0 && <span className="text-muted-color"> → {v.diagnoses.join(', ')}</span>}
                </a>
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  )
}
