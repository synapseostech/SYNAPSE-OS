import 'server-only'

import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@synapse/db/admin'
import { requireHospitalStaffContext } from '../hospital-dept/context'
import {
  isContextError,
  requireHospitalCapability,
  type HospitalContext,
} from '../hospital-shared'

/**
 * Server-side kill switch for patient import.
 *
 * Positive-enable, matching the existing `SYNAPSE_ALLOW_HARD_PURGE` convention.
 * Any value other than an explicit truthy token — including unset, empty,
 * `"0"`, `"false"` or a typo — means import is disabled. This is a NEW
 * variable; it does not exist elsewhere in the repository.
 */
export const PATIENT_IMPORT_FLAG = 'SYNAPSE_ALLOW_PATIENT_IMPORT'

const TRUTHY = new Set(['1', 'true', 'yes', 'on'])

export function patientImportEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return TRUTHY.has(String(env[PATIENT_IMPORT_FLAG] ?? '').trim().toLowerCase())
}

export function importDisabledResponse(): NextResponse {
  return NextResponse.json(
    { ok: false, code: 'IMPORT_DISABLED', error: 'Patient import is disabled on this deployment.' },
    { status: 503 },
  )
}

export type ImportContext = HospitalContext

/**
 * Gate order matters: the kill switch is evaluated before any body parsing,
 * session lookup or service-role client construction, so a disabled
 * deployment cannot be exercised at all.
 */
export async function requireImportContext(): Promise<ImportContext | NextResponse> {
  if (!patientImportEnabled()) return importDisabledResponse()

  const ctx = await requireHospitalStaffContext()
  if (isContextError(ctx)) return ctx

  const cap = await requireHospitalCapability(ctx, 'patient', 'write', 'clinical')
  if (cap) return cap

  return ctx
}

export function isImportContextError(value: ImportContext | NextResponse): value is NextResponse {
  return value instanceof NextResponse
}

export type ImportBatch = {
  id: string
  tenant_id: string | null
  hospital_id: string | null
  status: string
  total_rows: number
}

/**
 * Load a batch only if it belongs to the caller's tenant.
 *
 * A batch from another tenant is reported as "not found" rather than
 * "forbidden" so the endpoint does not confirm the existence of other
 * facilities' imports.
 */
export async function loadOwnedBatch(
  batchId: string,
  tenantId: string,
): Promise<ImportBatch | null> {
  if (!isUuid(batchId)) return null

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = supabaseAdmin as any
  const { data, error } = await db
    .from('import_batches')
    .select('id, tenant_id, hospital_id, status, total_rows')
    .eq('id', batchId)
    .eq('tenant_id', tenantId)
    .maybeSingle()

  if (error || !data) return null
  return data as ImportBatch
}

export function notFoundBatch(): NextResponse {
  return NextResponse.json({ error: 'Batch not found' }, { status: 404 })
}

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
}
