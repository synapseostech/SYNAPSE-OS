import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { isLabContextError, requireLabAccess } from '@/lib/lab/access'
import { createLabWalkIn, LabWalkInError } from '@/lib/lab/walk-in'

export const dynamic = 'force-dynamic'

/**
 * External referral, one test (the original form). Kept for existing callers;
 * it now goes through the same transactional registration as /api/lab/walk-in,
 * so a failure no longer leaves a patient or visit behind, and the test is billed.
 */
const referralOrderSchema = z.object({
  patientName: z.string().trim().min(2).max(200),
  dateOfBirth: z.string().date().optional().or(z.literal('')),
  sex: z.enum(['M', 'F']),
  phone: z.string().trim().max(30).optional(),
  testName: z.string().trim().min(2).max(500),
  loincCode: z.string().trim().min(1).max(40),
  urgency: z.enum(['STAT', 'URGENT', 'ROUTINE']).default('ROUTINE'),
  referralSource: z.string().trim().max(200).optional(),
})

export async function POST(request: NextRequest) {
  const ctx = await requireLabAccess('order.create')
  if (isLabContextError(ctx)) return ctx

  const parsed = referralOrderSchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 })

  try {
    const created = await createLabWalkIn(ctx, {
      patient: { fullName: parsed.data.patientName, dateOfBirth: parsed.data.dateOfBirth, sex: parsed.data.sex, phone: parsed.data.phone },
      catalogTestIds: [],
      otherTests: [{ testName: parsed.data.testName.slice(0, 200), loincCode: parsed.data.loincCode }],
      urgency: parsed.data.urgency,
      source: 'referral',
      referralSource: parsed.data.referralSource,
      bill: true,
    })
    const order = created.orders[0]
    return NextResponse.json({
      order: { id: order?.id, testName: order?.testName, loincCode: order?.loincCode, status: 'ORDERED', encounterId: created.encounterId },
      patient: created.patient,
      billing: created.billing,
    }, { status: 201 })
  } catch (err) {
    if (err instanceof LabWalkInError) return NextResponse.json({ error: err.code }, { status: err.status })
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Referral failed' }, { status: 500 })
  }
}
