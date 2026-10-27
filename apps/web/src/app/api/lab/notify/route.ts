import { NextRequest, NextResponse } from 'next/server'
import { verifyToken, validateSession } from '@synapse/auth'
import { supabaseAdmin } from '@synapse/db/admin'
import { notifyPatientLabResult } from '@synapse/auth/mobile-push'

export const dynamic = 'force-dynamic'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = () => supabaseAdmin as any

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Notify a patient that a lab result is ready.
 * Body: { patientId?: string, testName?: string, resultId?: string }
 *
 * A caller may only notify their own account. The previous version accepted an
 * arbitrary `userId` from the body and resolved a patient to
 * `patients.created_by` — the member of staff who registered the record, not
 * the patient's own login — which let any authenticated user push
 * notifications to any other user.
 */
export async function POST(req: NextRequest) {
  const auth = req.headers.get('authorization') ?? ''
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null
  if (!token) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const payload = await verifyToken(token).catch(() => null)
  if (!payload?.sub) return NextResponse.json({ error: 'Invalid token' }, { status: 401 })

  const { valid } = await validateSession(token)
  if (!valid) return NextResponse.json({ error: 'Session expired' }, { status: 401 })

  const body = (await req.json().catch(() => null)) as {
    patientId?: string
    userId?: string
    testName?: string
    resultId?: string
  } | null

  // Notifying anyone other than the authenticated caller is not supported by
  // this endpoint. Staff-initiated notifications belong on a capability-gated
  // route.
  if (body?.userId && body.userId.trim() && body.userId.trim() !== payload.sub) {
    return NextResponse.json(
      { error: 'This endpoint can only notify the authenticated account' },
      { status: 403 },
    )
  }

  const userId = payload.sub

  // When a patient record is named, it must belong to the caller's tenant.
  // "Not found" is returned for another tenant's patient so the endpoint does
  // not confirm its existence.
  const patientId = body?.patientId?.trim()
  if (patientId) {
    if (!UUID_PATTERN.test(patientId)) {
      return NextResponse.json({ error: 'Patient not found' }, { status: 404 })
    }
    const tenantId = payload.tenant_id
    if (!tenantId) return NextResponse.json({ error: 'No tenant context' }, { status: 403 })

    const { data: patient } = await db()
      .from('patients')
      .select('id')
      .eq('id', patientId)
      .eq('tenant_id', tenantId)
      .maybeSingle()
    if (!patient) return NextResponse.json({ error: 'Patient not found' }, { status: 404 })
  }

  notifyPatientLabResult({
    userId,
    testName: body?.testName ?? null,
  })

  return NextResponse.json({
    success: true,
    notifiedUserId: userId,
    resultId: body?.resultId ?? null,
  })
}
