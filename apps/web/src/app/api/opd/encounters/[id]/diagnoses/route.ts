import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@synapse/db/admin'
import { encounterDiagnosisRow } from '@synapse/db/encounter-diagnosis'
import { lookupIcd11Code as lookupStem } from '@synapse/interop/icd11-index'
import { isContextError, requireHospitalCapability, gateHospitalModule, logHospitalAudit } from '@/lib/hospital-shared'
import { requireHospitalStaffContext } from '@/lib/hospital-dept'

export const dynamic = 'force-dynamic'

const COLUMNS = 'id, encounter_id, tenant_id, stem_code, cluster_code, title, certainty, diagnosis_type, foundation_uri, linearization_uri, icd_release, selected_by, suggested_by, created_at'

/**
 * Clinician-selected ICD-11 on the existing encounter_diagnoses table.
 * Gated by opd.prescription.create, which doctor and clinical_officer already
 * hold and reception/nursing do not. Cache lookup only — no WHO call.
 */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const ctx = await requireHospitalStaffContext()
  if (isContextError(ctx)) return ctx

  const cap = await requireHospitalCapability(ctx, 'prescription', 'read', 'opd')
  if (cap) return cap

  const moduleBlock = await gateHospitalModule(ctx.tenantId, ctx.hospitalId, 'opd')
  if (moduleBlock) return moduleBlock

  const { id: encounterId } = await params
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = supabaseAdmin as any
  const { data: encounter, error: loadError } = await db
    .from('encounters')
    .select('id')
    .eq('id', encounterId)
    .eq('tenant_id', ctx.tenantId)
    .eq('hospital_id', ctx.hospitalId)
    .maybeSingle()
  if (loadError) return NextResponse.json({ error: loadError.message }, { status: 500 })
  if (!encounter) return NextResponse.json({ error: 'Encounter not found' }, { status: 404 })

  const { data, error } = await db
    .from('encounter_diagnoses')
    .select(COLUMNS)
    .eq('encounter_id', encounterId)
    .eq('tenant_id', ctx.tenantId)
    .eq('is_deleted', false)
    .order('created_at', { ascending: true })
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ diagnoses: data ?? [] })
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const ctx = await requireHospitalStaffContext()
  if (isContextError(ctx)) return ctx

  const cap = await requireHospitalCapability(ctx, 'prescription', 'create', 'opd')
  if (cap) return cap

  const moduleBlock = await gateHospitalModule(ctx.tenantId, ctx.hospitalId, 'opd')
  if (moduleBlock) return moduleBlock

  const { id: encounterId } = await params
  const body = await req.json().catch(() => null)
  const stem = String(body?.stem_code ?? body?.stemCode ?? '').trim()
  const certainty = ['confirmed', 'suspected', 'differential'].includes(body?.certainty) ? body.certainty : 'confirmed'
  const diagnosisType = ['primary', 'secondary', 'comorbidity', 'complication'].includes(body?.diagnosis_type)
    ? body.diagnosis_type
    : 'primary'
  const suggestedBy = body?.suggested_by === 'synapse_intelligence' ? 'synapse_intelligence' : 'clinician'

  const entity = lookupStem(stem)
  if (!entity) {
    return NextResponse.json({ error: 'Unknown ICD-11 code', stem_code: stem }, { status: 422 })
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = supabaseAdmin as any
  const { data: encounter, error: loadError } = await db
    .from('encounters')
    .select('id, patient_id, is_signed')
    .eq('id', encounterId)
    .eq('tenant_id', ctx.tenantId)
    .eq('hospital_id', ctx.hospitalId)
    .maybeSingle()
  if (loadError) return NextResponse.json({ error: loadError.message }, { status: 500 })
  if (!encounter) return NextResponse.json({ error: 'Encounter not found' }, { status: 404 })
  if (encounter.is_signed) {
    return NextResponse.json({ error: 'Encounter is signed' }, { status: 409 })
  }

  const { data: existing, error: existingError } = await db
    .from('encounter_diagnoses')
    .select(COLUMNS)
    .eq('encounter_id', encounterId)
    .eq('tenant_id', ctx.tenantId)
    .eq('stem_code', entity.stemCode)
    .eq('is_deleted', false)
    .maybeSingle()
  if (existingError) return NextResponse.json({ error: existingError.message }, { status: 500 })
  if (existing) {
    // Same code again with a new certainty or type (e.g. suspected -> confirmed
    // once the result is back): update in place.
    if (existing.certainty === certainty && existing.diagnosis_type === diagnosisType) {
      return NextResponse.json({ diagnosis: existing, idempotent: true })
    }
    const { data: updated, error: updateError } = await db
      .from('encounter_diagnoses')
      .update({ certainty, diagnosis_type: diagnosisType, updated_at: new Date().toISOString() })
      .eq('id', existing.id)
      .eq('tenant_id', ctx.tenantId)
      .select(COLUMNS)
      .single()
    if (updateError) return NextResponse.json({ error: updateError.message }, { status: 500 })
    await logHospitalAudit({
      ctx,
      action: 'UPDATE',
      tableName: 'encounter_diagnoses',
      recordId: existing.id,
      oldValue: { certainty: existing.certainty, diagnosis_type: existing.diagnosis_type },
      newValue: { certainty, diagnosis_type: diagnosisType, patient_id: encounter.patient_id },
    })
    return NextResponse.json({ diagnosis: updated, idempotent: false })
  }

  const row = encounterDiagnosisRow({
    encounterId,
    tenantId: ctx.tenantId,
    selectedBy: ctx.userId,
    stemCode: entity.stemCode,
    title: entity.title,
    foundationUri: entity.foundationUri,
    linearizationUri: entity.linearizationUri,
    release: entity.release,
    certainty,
    diagnosisType,
    suggestedBy,
  })
  const { data: inserted, error: insertError } = await db
    .from('encounter_diagnoses')
    .insert(row)
    .select(COLUMNS)
    .single()
  if (insertError) return NextResponse.json({ error: insertError.message }, { status: 500 })

  await logHospitalAudit({
    ctx,
    action: 'INSERT',
    tableName: 'encounter_diagnoses',
    recordId: inserted.id,
    newValue: { stem_code: entity.stemCode, title: entity.title, patient_id: encounter.patient_id },
  })

  return NextResponse.json({ diagnosis: inserted, idempotent: false }, { status: 201 })
}

/** Remove a diagnosis from an unsigned encounter (soft delete, audited). */
export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const ctx = await requireHospitalStaffContext()
  if (isContextError(ctx)) return ctx

  const cap = await requireHospitalCapability(ctx, 'prescription', 'create', 'opd')
  if (cap) return cap

  const moduleBlock = await gateHospitalModule(ctx.tenantId, ctx.hospitalId, 'opd')
  if (moduleBlock) return moduleBlock

  const { id: encounterId } = await params
  const stem = String(new URL(req.url).searchParams.get('stem_code') ?? '').trim()
  if (!stem) return NextResponse.json({ error: 'stem_code is required' }, { status: 400 })

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = supabaseAdmin as any
  const { data: encounter, error: loadError } = await db
    .from('encounters')
    .select('id, patient_id, is_signed')
    .eq('id', encounterId)
    .eq('tenant_id', ctx.tenantId)
    .eq('hospital_id', ctx.hospitalId)
    .maybeSingle()
  if (loadError) return NextResponse.json({ error: loadError.message }, { status: 500 })
  if (!encounter) return NextResponse.json({ error: 'Encounter not found' }, { status: 404 })
  if (encounter.is_signed) return NextResponse.json({ error: 'Encounter is signed' }, { status: 409 })

  const { data: removed, error } = await db
    .from('encounter_diagnoses')
    .update({ is_deleted: true, updated_at: new Date().toISOString() })
    .eq('encounter_id', encounterId)
    .eq('tenant_id', ctx.tenantId)
    .eq('stem_code', stem)
    .eq('is_deleted', false)
    .select('id')
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  for (const row of removed ?? []) {
    await logHospitalAudit({
      ctx,
      action: 'DELETE',
      tableName: 'encounter_diagnoses',
      recordId: row.id,
      newValue: { stem_code: stem, patient_id: encounter.patient_id },
    })
  }
  return NextResponse.json({ removed: (removed ?? []).length })
}
