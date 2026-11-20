import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@synapse/db/admin'
import { isContextError, requireHospitalCapability, gateHospitalModule, logHospitalAudit } from '../../../../../../../lib/hospital-shared'
import {
  requireHospitalStaffContext,
  invoiceCoverSchema,
  isMissingRpc,
  rpcDomainError,
} from '../../../../../../../lib/hospital-dept'

export const dynamic = 'force-dynamic'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Applies (or, with cover_amount 0, removes) insurance cover on an invoice.
 * The patient then owes total - cover - paid, and a draft insurance claim for
 * the cover is kept in step with the invoice. One transaction.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireHospitalStaffContext()
  if (isContextError(ctx)) return ctx

  const cap = await requireHospitalCapability(ctx, 'insurance', 'apply', 'billing')
  if (cap) return cap

  const moduleBlock = await gateHospitalModule(ctx.tenantId, ctx.hospitalId, 'billing')
  if (moduleBlock) return moduleBlock

  const { id } = await params
  if (!UUID.test(id)) return NextResponse.json({ error: 'Invoice not found' }, { status: 404 })

  const parsed = invoiceCoverSchema.safeParse(await req.json().catch(() => null))
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 })
  const body = parsed.data

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = supabaseAdmin as any
  const { data, error } = await db.rpc('hospital_apply_invoice_cover', {
    p_tenant_id: ctx.tenantId,
    p_hospital_id: ctx.hospitalId,
    p_invoice_id: id,
    p_cover_amount: body.cover_amount,
    p_actor_id: ctx.userId,
    p_policy_id: body.policy_id ?? null,
    p_insurer_name: body.insurer_name ?? null,
    p_member_number: body.member_number ?? null,
    p_scheme: body.scheme ?? null,
  })

  if (error) {
    if (isMissingRpc(error)) {
      return NextResponse.json({ error: 'insurance_not_enabled', message: 'Apply migration 20261120140000 first.' }, { status: 503 })
    }
    const mapped = rpcDomainError(error)
    if (mapped.status === 500) console.error('[billing/cover] rpc failed', error.code, error.message)
    return NextResponse.json({ error: mapped.code }, { status: mapped.status })
  }

  await logHospitalAudit({
    ctx,
    action: 'UPDATE',
    tableName: 'billing_invoices',
    recordId: id,
    newValue: {
      insurance_cover_amount: data?.insuranceCover ?? body.cover_amount,
      insurance_policy_id: data?.policyId ?? null,
      insurance_claim_id: data?.claimId ?? null,
    },
  })

  return NextResponse.json({ cover: data })
}
