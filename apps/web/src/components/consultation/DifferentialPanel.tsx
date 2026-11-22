'use client'

import { useState } from 'react'
import type { Differential, DifferentialInvestigation, DifferentialResult } from '@synapse/interop/differential-engine'
import { Brain, CheckCircle2, ChevronDown, FlaskConical, Loader2, Plus, ScanLine, Stethoscope, TriangleAlert } from 'lucide-react'
import type { LabCatalogEntry, WorkspaceDiagnosis, WorkspaceImaging, WorkspaceLabOrder } from './types'

const LIKELIHOOD = {
  high: { label: 'High', bar: 'bg-emerald-500', text: 'text-emerald-600 dark:text-emerald-400' },
  moderate: { label: 'Moderate', bar: 'bg-amber-500', text: 'text-amber-600 dark:text-amber-400' },
  low: { label: 'Low', bar: 'bg-slate-400', text: 'text-muted-color' },
} as const

export type OrderableTest =
  | { kind: 'lab'; loinc: string; name: string; catalog: LabCatalogEntry | null }
  | { kind: 'imaging'; examCode: string; name: string }

/** Engine investigation codes that map to a radiology exam (packages/db/src/radiology.ts). */
const IMAGING_EXAM_FOR: Record<string, { examCode: string; name: string }> = {
  CXR: { examCode: 'CXR', name: 'Chest X-ray' },
  ABD_US: { examCode: 'ABD_US', name: 'Abdominal ultrasound' },
  PELVIC_US: { examCode: 'PELVIC_US', name: 'Pelvic ultrasound' },
  ECHO: { examCode: 'ECHO', name: 'Echocardiogram' },
}

/** Match a suggested investigation to the lab catalogue (by code, LOINC or name) or to a radiology exam. */
export function resolveTest(inv: DifferentialInvestigation, catalog: LabCatalogEntry[]): OrderableTest | null {
  if (inv.kind === 'imaging') {
    const exam = IMAGING_EXAM_FOR[inv.code.toUpperCase()]
    return exam ? { kind: 'imaging', ...exam } : null
  }
  if (inv.kind !== 'lab') return null
  const byCode = catalog.find((c) => c.code.toUpperCase() === inv.code.toUpperCase())
  const byLoinc = inv.loinc ? catalog.find((c) => c.loinc_code === inv.loinc) : undefined
  const byName = catalog.find((c) => c.name.toLowerCase() === inv.name.toLowerCase())
  const entry = byCode ?? byLoinc ?? byName ?? null
  const loinc = entry?.loinc_code ?? inv.loinc ?? null
  if (!loinc) return null
  return { kind: 'lab', loinc, name: entry?.name ?? inv.name, catalog: entry }
}

function InvestigationRow({
  inv,
  catalog,
  orders,
  imaging,
  onOrder,
  disabled,
}: {
  inv: DifferentialInvestigation
  catalog: LabCatalogEntry[]
  orders: WorkspaceLabOrder[]
  imaging: WorkspaceImaging[]
  onOrder: (t: OrderableTest, urgent: boolean) => Promise<void>
  disabled?: boolean
}) {
  const [busy, setBusy] = useState(false)
  const test = resolveTest(inv, catalog)
  const study = test?.kind === 'imaging' ? imaging.find((s) => s.metadata?.exam_code === test.examCode) : undefined
  const labOrder = test?.kind === 'lab' ? orders.find((o) => o.loinc_code === test.loinc) : undefined
  const existing = labOrder ?? (study ? { workflow_status: study.worklist_status === 'verified' ? 'reported' : study.worklist_status, status: null } : undefined)
  const imagingReport = study?.worklist_status === 'verified' ? study.radiology_reports?.[0] : undefined
  const Icon = inv.kind === 'imaging' ? ScanLine : inv.kind === 'bedside' ? Stethoscope : FlaskConical
  const purpose = inv.purpose === 'confirm' ? 'Confirms' : inv.purpose === 'exclude' ? 'Excludes' : 'Severity'
  const result = labOrder?.results[0]

  return (
    <li className="flex items-start gap-2 py-1.5">
      <Icon className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-color" aria-hidden />
      <div className="min-w-0 flex-1">
        <div className="text-sm text-primary-color">
          {test?.name ?? inv.name}
          <span className="ml-1.5 text-[10px] uppercase tracking-wide text-muted-color">{purpose}</span>
        </div>
        <div className="text-xs text-muted-color">{inv.why}</div>
        {imagingReport && (
          <div className={`mt-0.5 text-xs font-medium ${imagingReport.is_critical ? 'text-red-500' : 'text-primary-color'}`}>
            Report: {imagingReport.impression}
          </div>
        )}
        {result && (
          <div className={`mt-0.5 text-xs font-medium ${result.is_critical ? 'text-red-500' : result.is_abnormal ? 'text-orange' : 'text-emerald-600 dark:text-emerald-400'}`}>
            Result: {String(result.result_value ?? result.value ?? result.numeric_value ?? '')} {result.unit ?? ''}
          </div>
        )}
      </div>
      {existing ? (
        <span className="shrink-0 rounded-full bg-elevated px-2 py-0.5 text-[11px] text-secondary-color">
          {(existing.workflow_status ?? existing.status ?? 'ordered').replace(/_/g, ' ')}
        </span>
      ) : test ? (
        <button
          type="button"
          disabled={disabled || busy}
          onClick={async () => {
            setBusy(true)
            try {
              await onOrder(test, false)
            } finally {
              setBusy(false)
            }
          }}
          className="shrink-0 rounded-lg border border-orange px-2 py-0.5 text-xs font-medium text-orange transition hover:bg-orange-500 hover:text-white disabled:opacity-50"
          title={test.kind === 'lab' ? (test.catalog?.price != null ? `${test.catalog.currency ?? 'UGX'} ${Number(test.catalog.price).toLocaleString()}` : 'Order from the lab') : 'Request from radiology'}
        >
          {busy ? <Loader2 className="h-3 w-3 animate-spin" aria-label="Ordering" /> : 'Order'}
        </button>
      ) : (
        <span className="shrink-0 text-[11px] text-muted-color" title={inv.kind === 'lab' ? 'Not in this facility’s lab catalogue' : 'Request it in the plan'}>
          {inv.kind === 'lab' ? 'not offered' : inv.kind}
        </span>
      )}
    </li>
  )
}

function DifferentialCard({
  d,
  rank,
  catalog,
  orders,
  imaging,
  diagnoses,
  onAddDiagnosis,
  onOrder,
  disabled,
}: {
  d: Differential
  rank: number
  catalog: LabCatalogEntry[]
  orders: WorkspaceLabOrder[]
  imaging: WorkspaceImaging[]
  diagnoses: WorkspaceDiagnosis[]
  onAddDiagnosis: (code: string, certainty: 'suspected' | 'confirmed', fromEngine: boolean) => Promise<void>
  onOrder: (t: OrderableTest, urgent: boolean) => Promise<void>
  disabled?: boolean
}) {
  // Top two open by default as the ranking changes; a tap overrides it.
  const [toggled, setToggled] = useState<boolean | null>(null)
  const open = toggled ?? rank < 2
  const setOpen = (v: boolean) => setToggled(v)
  const [busy, setBusy] = useState(false)
  const lk = LIKELIHOOD[d.likelihood]
  const chosen = diagnoses.find((x) => x.stem_code === d.icd11.code || d.icd11Alternatives.some((a) => a.code === x.stem_code))

  const add = async (code: string, certainty: 'suspected' | 'confirmed') => {
    setBusy(true)
    try {
      await onAddDiagnosis(code, certainty, true)
    } finally {
      setBusy(false)
    }
  }

  return (
    <li className={`rounded-xl border ${d.urgent ? 'border-red-500/50 bg-red-500/5' : 'border-subtle bg-surface'} p-3`}>
      <button type="button" onClick={() => setOpen(!open)} className="flex w-full items-start gap-2 text-left" aria-expanded={open}>
        <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-elevated font-mono text-[11px] text-secondary-color">{rank + 1}</span>
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
            <span className="text-sm font-semibold text-primary-color">{d.name}</span>
            {d.urgent && (
              <span className="inline-flex items-center gap-1 rounded-full bg-red-500 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-white">
                <TriangleAlert className="h-3 w-3" aria-hidden /> urgent
              </span>
            )}
          </span>
          <span className="mt-0.5 flex items-center gap-2 text-xs">
            <code className="rounded bg-elevated px-1.5 py-0.5 font-mono text-[11px] text-gold" title={d.icd11.title}>
              {d.icd11.code}
            </code>
            <span className={lk.text}>{lk.label}</span>
            {chosen && (
              <span className="inline-flex items-center gap-0.5 text-emerald-600 dark:text-emerald-400">
                <CheckCircle2 className="h-3 w-3" aria-hidden /> {chosen.certainty}
              </span>
            )}
          </span>
          <span className="mt-1.5 block h-1.5 overflow-hidden rounded-full bg-elevated" aria-hidden>
            <span className={`block h-full rounded-full ${lk.bar}`} style={{ width: `${Math.max(4, Math.round(d.relative * 100))}%` }} />
          </span>
        </span>
        <ChevronDown className={`mt-0.5 h-4 w-4 shrink-0 text-muted-color transition ${open ? 'rotate-180' : ''}`} aria-hidden />
      </button>

      {open && (
        <div className="mt-2 space-y-2 pl-7">
          {d.supporting.length > 0 && (
            <p className="text-xs text-secondary-color">
              <span className="font-medium text-emerald-600 dark:text-emerald-400">For: </span>
              {d.supporting.map((s) => s.label).join(', ')}
            </p>
          )}
          {d.against.length > 0 && (
            <p className="text-xs text-secondary-color">
              <span className="font-medium text-red-500">Against: </span>
              {d.against.map((s) => s.label).join(', ')}
            </p>
          )}
          {d.redFlags.length > 0 && (
            <p className="text-xs font-medium text-red-500">Red flags: {d.redFlags.map((r) => r.label).join(', ')}</p>
          )}
          {d.askNext.length > 0 && (
            <p className="text-xs text-muted-color">Still to check: {d.askNext.map((a) => a.label.toLowerCase()).join(', ')}</p>
          )}
          {d.pearl && <p className="rounded-lg bg-elevated px-2.5 py-1.5 text-xs text-secondary-color">{d.pearl}</p>}

          {d.investigations.length > 0 && (
            <div>
              <div className="text-[11px] font-medium uppercase tracking-wide text-muted-color">To confirm</div>
              <ul className="divide-y divide-[var(--border-subtle)]">
                {d.investigations.map((inv) => (
                  <InvestigationRow key={inv.code} inv={inv} catalog={catalog} orders={orders} imaging={imaging} onOrder={onOrder} disabled={disabled} />
                ))}
              </ul>
            </div>
          )}

          <div className="flex flex-wrap gap-1.5 pt-1">
            <button
              type="button"
              disabled={disabled || busy}
              onClick={() => add(d.icd11.code, 'suspected')}
              className="inline-flex items-center gap-1 rounded-lg border border-subtle px-2.5 py-1 text-xs text-primary-color hover:border-strong disabled:opacity-50"
            >
              <Plus className="h-3 w-3" aria-hidden /> Working diagnosis
            </button>
            <button
              type="button"
              disabled={disabled || busy}
              onClick={() => add(d.icd11.code, 'confirmed')}
              className="inline-flex items-center gap-1 rounded-lg bg-emerald-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-emerald-500 disabled:opacity-50"
            >
              <CheckCircle2 className="h-3 w-3" aria-hidden /> Confirmed
            </button>
            {d.icd11Alternatives.map((a) => (
              <button
                key={a.code}
                type="button"
                disabled={disabled || busy}
                onClick={() => add(a.code, 'suspected')}
                className="rounded-lg px-2 py-1 text-xs text-secondary-color underline decoration-dotted hover:text-primary-color disabled:opacity-50"
                title={a.title}
              >
                or {a.code} {a.when}
              </button>
            ))}
          </div>
        </div>
      )}
    </li>
  )
}

export function DifferentialPanel({
  result,
  catalog,
  orders,
  imaging,
  diagnoses,
  onAddDiagnosis,
  onOrder,
  disabled,
}: {
  result: DifferentialResult
  catalog: LabCatalogEntry[]
  orders: WorkspaceLabOrder[]
  imaging: WorkspaceImaging[]
  diagnoses: WorkspaceDiagnosis[]
  onAddDiagnosis: (code: string, certainty: 'suspected' | 'confirmed', fromEngine: boolean) => Promise<void>
  onOrder: (t: OrderableTest, urgent: boolean) => Promise<void>
  disabled?: boolean
}) {
  return (
    <section aria-label="Likely diagnoses" aria-live="polite">
      <div className="mb-2 flex items-center justify-between">
        <h2 className="flex items-center gap-2 text-sm font-semibold text-primary-color">
          <Brain className="h-4 w-4 text-orange" aria-hidden /> Likely diagnoses
        </h2>
        <span className="text-[11px] text-muted-color">{result.findingCount} finding{result.findingCount === 1 ? '' : 's'}</span>
      </div>
      {result.differentials.length === 0 ? (
        <p className="rounded-xl border border-dashed border-subtle p-4 text-sm text-muted-color">
          Type the complaint and history, or tap findings. Likely diagnoses appear here as you go.
        </p>
      ) : (
        <ol className="space-y-2">
          {result.differentials.map((d, i) => (
            <DifferentialCard
              key={d.id}
              d={d}
              rank={i}
              catalog={catalog}
              orders={orders}
              imaging={imaging}
              diagnoses={diagnoses}
              onAddDiagnosis={onAddDiagnosis}
              onOrder={onOrder}
              disabled={disabled}
            />
          ))}
        </ol>
      )}
      <p className="mt-2 text-[11px] leading-snug text-muted-color">
        Decision support ({result.engine}). It ranks; you diagnose. Codes are WHO ICD-11 MMS 2026-01.
      </p>
    </section>
  )
}
