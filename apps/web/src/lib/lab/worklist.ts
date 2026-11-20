import 'server-only'

import { supabaseAdmin } from '@synapse/db/admin'
import type { LabEngineContext } from './engine'

/**
 * Paged lab worklists in ONE query: orders with their patient and result
 * embedded, filtered by section and by the bench view, newest first, paged by
 * a keyset cursor (ordered_at, id) so page 50 costs the same as page 1. Backed
 * by lab_orders_worklist_section_idx / lab_orders_worklist_idx.
 */

import { LAB_SECTIONS } from './sections'
export { LAB_SECTIONS, type LabSection } from './sections'

export const LAB_VIEWS = {
  collection: ['ORDERED', 'COLLECTION_PENDING'],
  reception: ['COLLECTED', 'IN_TRANSIT'],
  bench: ['RECEIVED', 'PROCESSING'],
  verify: ['RESULT_ENTERED', 'VERIFICATION_PENDING', 'VERIFIED'],
  released: ['RELEASED', 'AMENDED'],
  closed: ['REJECTED', 'CANCELLED'],
  open: ['ORDERED', 'COLLECTION_PENDING', 'COLLECTED', 'IN_TRANSIT', 'RECEIVED', 'PROCESSING', 'RESULT_ENTERED', 'VERIFICATION_PENDING', 'VERIFIED'],
} as const
export type LabView = keyof typeof LAB_VIEWS | 'all'

export type LabWorklistQuery = {
  section?: string | null
  view?: string | null
  status?: string | null
  encounterId?: string | null
  q?: string | null
  cursor?: string | null
  limit?: number | null
  /** internal: second pass that matches a patient number instead of an accession */
  searchPatientNumber?: boolean
}

export type LabWorklistItem = {
  id: string
  tenantId: string
  patientId: string
  encounterId: string
  loincCode: string
  testName: string
  section: string
  urgency: string
  status: string
  source: string
  accessionNumber: string | null
  specimenId: string | null
  orderedAt: string
  patientName: string | null
  synapseId: string | null
  patientSex: string | null
  patientDob: string | null
  hasResult: boolean
  resultId: string | null
  resultValue: string | null
  unit: string | null
  referenceRange: string | null
  flag: string | null
  isCritical: boolean
  criticalAcknowledged: boolean
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function encodeCursor(orderedAt: string, id: string): string {
  return Buffer.from(`${orderedAt}|${id}`, 'utf8').toString('base64url')
}

export function decodeCursor(cursor: string | null | undefined): { orderedAt: string; id: string } | null {
  if (!cursor) return null
  try {
    const [orderedAt = '', id = ''] = Buffer.from(cursor, 'base64url').toString('utf8').split('|')
    if (!id || !UUID.test(id) || Number.isNaN(Date.parse(orderedAt))) return null
    return { orderedAt: new Date(orderedAt).toISOString(), id }
  } catch {
    return null
  }
}

/** Characters PostgREST treats as syntax inside or()/ilike filters. */
function safeSearch(q: string): string {
  return q.replace(/[^\p{L}\p{N} .'-]/gu, '').trim().slice(0, 60)
}

export async function fetchLabWorklist(
  ctx: LabEngineContext,
  query: LabWorklistQuery = {},
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any = supabaseAdmin,
): Promise<{ orders: LabWorklistItem[]; nextCursor: string | null; error?: string }> {
  const limit = Math.min(Math.max(Number(query.limit) || 25, 1), 100)
  const patientEmbed = query.q && (query.searchPatientNumber || !/\d/.test(query.q)) ? 'patients!inner(full_name, mrn, sex, dob)' : 'patients(full_name, mrn, sex, dob)'
  let request = db
    .from('lab_orders')
    .select(
      `id, tenant_id, encounter_id, patient_id, loinc_code, test_name, section, urgency, workflow_status, order_source, accession_number, specimen_id, ordered_at, ${patientEmbed}, lab_results(id, result_value, unit, reference_range, abnormal_flag, is_critical, critical_scientist_ack_at)`,
    )
    .eq('tenant_id', ctx.tenantId)
    .eq('is_synthetic', false)

  if (query.section && (LAB_SECTIONS as readonly string[]).includes(query.section)) {
    request = request.eq('section', query.section)
  }
  const view = (query.view ?? 'all') as LabView
  if (query.status) request = request.eq('workflow_status', query.status)
  else if (view !== 'all' && view in LAB_VIEWS) request = request.in('workflow_status', [...LAB_VIEWS[view as keyof typeof LAB_VIEWS]])
  if (query.encounterId && UUID.test(query.encounterId)) request = request.eq('encounter_id', query.encounterId)

  if (query.q) {
    const q = safeSearch(query.q)
    if (q) {
      // An accession (FAC-YYYYMMDD-000123) or any code with digits matches the
      // specimen label; anything else searches the patient's name or number.
      if (query.searchPatientNumber) {
        request = request.ilike('patients.mrn', `${q}%`)
      } else if (/\d/.test(q) && /^[A-Za-z0-9-]{4,40}$/.test(q)) {
        request = request.ilike('accession_number', `${q}%`)
      } else {
        request = request.or(`full_name.ilike.%${q}%,mrn.ilike.${q}%`, { referencedTable: 'patients' })
      }
    }
  }

  const cursor = decodeCursor(query.cursor)
  if (cursor) {
    request = request.or(`ordered_at.lt.${cursor.orderedAt},and(ordered_at.eq.${cursor.orderedAt},id.lt.${cursor.id})`)
  }

  const { data, error } = await request
    .order('ordered_at', { ascending: false })
    .order('id', { ascending: false })
    .limit(limit + 1)
  if (error) return { orders: [], nextCursor: null, error: error.message }

  const rows = (data ?? []) as Record<string, unknown>[]
  // Nothing under that accession: the code may be a patient number instead.
  if (!rows.length && query.q && /\d/.test(query.q) && !query.searchPatientNumber && !cursor) {
    return fetchLabWorklist(ctx, { ...query, searchPatientNumber: true }, db)
  }
  const page = rows.slice(0, limit)
  const orders = page.map((row): LabWorklistItem => {
    const patient = row.patients as { full_name?: string | null; mrn?: string | null; sex?: string | null; dob?: string | null } | null
    const results = (row.lab_results as Record<string, unknown>[] | null) ?? []
    const result = results[0] ?? null
    return {
      id: String(row.id),
      tenantId: String(row.tenant_id),
      patientId: String(row.patient_id),
      encounterId: String(row.encounter_id),
      loincCode: String(row.loinc_code ?? ''),
      testName: String(row.test_name),
      section: String(row.section ?? 'general'),
      urgency: String(row.urgency),
      status: String(row.workflow_status ?? 'ORDERED'),
      source: String(row.order_source ?? 'hospital'),
      accessionNumber: (row.accession_number as string | null) ?? null,
      specimenId: (row.specimen_id as string | null) ?? null,
      orderedAt: String(row.ordered_at),
      patientName: patient?.full_name?.trim() || null,
      synapseId: patient?.mrn ?? null,
      patientSex: patient?.sex ?? null,
      patientDob: patient?.dob ?? null,
      hasResult: Boolean(result),
      resultId: result ? String(result.id) : null,
      resultValue: result ? String(result.result_value ?? '') : null,
      unit: (result?.unit as string | null) ?? null,
      referenceRange: (result?.reference_range as string | null) ?? null,
      flag: (result?.abnormal_flag as string | null) ?? null,
      isCritical: Boolean(result?.is_critical),
      criticalAcknowledged: Boolean(result?.critical_scientist_ack_at),
    }
  })
  const last = page[page.length - 1]
  const nextCursor = rows.length > limit && last ? encodeCursor(String(last.ordered_at), String(last.id)) : null
  return { orders, nextCursor }
}
