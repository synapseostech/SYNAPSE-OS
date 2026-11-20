import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@synapse/db/admin'
import { isContextError, requireHospitalCapability, gateHospitalModule, logHospitalAudit } from '../../../../../../lib/hospital-shared'
import {
  requireHospitalStaffContext,
  dischargeSchema,
  isMissingRpc,
  rpcDomainError,
} from '../../../../../../lib/hospital-dept'

export const dynamic = 'force-dynamic'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Discharges an inpatient: closes the admission, frees the bed and completes
 * the admission task in one transaction. A death goes through the death
 * pronouncement pathway first; `died` here only records the outcome.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireHospitalStaffContext()
  if (isContextError(ctx)) return ctx

  const cap = await requireHospitalCapability(ctx, 'admission', 'discharge', 'ipd')
  if (cap) return cap

  const moduleBlock = await gateHospitalModule(ctx.tenantId, ctx.hospitalId, 'ipd')
  if (moduleBlock) return moduleBlock

  const { id } = await params
  if (!UUID.test(id)) return NextResponse.json({ error: 'ADMISSION_NOT_FOUND' }, { status: 404 })

  const parsed = dischargeSchema.safeParse(await req.json().catch(() => null))
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 })

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = supabaseAdmin as any
  const { data, error } = await db.rpc('hospital_discharge_patient', {
    p_tenant_id: ctx.tenantId,
    p_hospital_id: ctx.hospitalId,
    p_admission_id: id,
    p_actor_id: ctx.userId,
    p_disposition: parsed.data.disposition,
    p_summary: parsed.data.summary ?? null,
  })

  if (error) {
    if (isMissingRpc(error)) {
      return NextResponse.json({ error: 'discharge_not_enabled', message: 'Apply migration 20261120140000 first.' }, { status: 503 })
    }
    const mapped = rpcDomainError(error)
    if (mapped.status === 500) console.error('[ipd/discharge] rpc failed', error.code, error.message)
    return NextResponse.json({ error: mapped.code }, { status: mapped.status })
  }

  await logHospitalAudit({
    ctx,
    action: 'UPDATE',
    tableName: 'hospital_admissions',
    recordId: id,
    newValue: { status: 'discharged', disposition: parsed.data.disposition },
  })

  return NextResponse.json({ discharge: data })
}
