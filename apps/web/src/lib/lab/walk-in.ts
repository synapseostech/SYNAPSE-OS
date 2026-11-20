import 'server-only'

import { randomBytes } from 'node:crypto'
import { z } from 'zod'
import { supabaseAdmin } from '@synapse/db/admin'
import { chargeLabOrders, type LabChargeOutcome } from './billing'
import type { LabEngineContext } from './engine'

const uuid = z.string().uuid()

export const labWalkInSchema = z.object({
  patient: z.union([
    z.object({ id: uuid }),
    z.object({
      fullName: z.string().trim().min(2).max(200),
      dateOfBirth: z.string().date().optional().or(z.literal('')),
      sex: z.enum(['M', 'F', 'I', 'U']).optional(),
      phone: z.string().trim().max(30).optional(),
    }),
  ]),
  catalogTestIds: z.array(uuid).max(30).default([]),
  /** Tests not in the catalogue yet (name + LOINC), e.g. a referral form. */
  otherTests: z.array(z.object({ testName: z.string().trim().min(2).max(200), loincCode: z.string().trim().min(1).max(40) })).max(10).default([]),
  urgency: z.enum(['STAT', 'URGENT', 'ROUTINE']).default('ROUTINE'),
  source: z.enum(['walk_in', 'referral']).default('walk_in'),
  referralSource: z.string().trim().max(200).optional(),
  bill: z.boolean().default(true),
}).refine((v) => v.catalogTestIds.length + v.otherTests.length > 0, { message: 'Choose at least one test' })

export type LabWalkInInput = z.infer<typeof labWalkInSchema>

export type LabWalkInResult = {
  patient: { id: string; mrn: string; full_name: string | null }
  encounterId: string
  orders: Array<{ id: string; testName: string; loincCode: string | null; catalogTestId: string | null; price: number | null; currency: string | null }>
  billing: LabChargeOutcome | null
}

export class LabWalkInError extends Error {
  constructor(readonly code: string, readonly status: number) {
    super(code)
  }
}

function newMrn(ctx: LabEngineContext): string {
  const facility = ctx.hospitalId.replaceAll('-', '').slice(0, 4).toUpperCase()
  return `${facility}-${Date.now().toString(36).toUpperCase()}-${randomBytes(3).toString('hex').toUpperCase()}`
}

/**
 * Register a walk-in or referred patient and every test they asked for in one
 * transaction (`lab_create_walk_in`), then bill the priced tests to the new
 * visit's invoice.
 */
export async function createLabWalkIn(
  ctx: LabEngineContext,
  input: LabWalkInInput,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any = supabaseAdmin,
): Promise<LabWalkInResult> {
  const patient = 'id' in input.patient
    ? { id: input.patient.id }
    : {
        full_name: input.patient.fullName,
        dob: input.patient.dateOfBirth || null,
        sex: input.patient.sex ?? null,
        phone: input.patient.phone || null,
        mrn: newMrn(ctx),
      }
  const { data, error } = await db.rpc('lab_create_walk_in', {
    p: {
      tenant_id: ctx.tenantId,
      hospital_id: ctx.hospitalId,
      actor_id: ctx.userId,
      actor_role: ctx.role,
      patient,
      catalog_ids: input.catalogTestIds,
      free_tests: input.otherTests.map((t) => ({ test_name: t.testName, loinc_code: t.loincCode })),
      urgency: input.urgency,
      order_source: input.source,
      referral_source: input.referralSource ?? null,
      chief_complaint: input.source === 'referral' ? `External laboratory referral${input.referralSource ? `: ${input.referralSource}` : ''}` : 'Laboratory walk-in',
    },
  })
  if (error) {
    if (error.code === 'LB404' || /LAB_PATIENT_NOT_FOUND/.test(error.message ?? '')) throw new LabWalkInError('LAB_PATIENT_NOT_FOUND', 404)
    if (error.code === 'LB400' || /LAB_WALK_IN_NO_TESTS/.test(error.message ?? '')) throw new LabWalkInError('LAB_WALK_IN_NO_TESTS', 400)
    throw new LabWalkInError(error.message ?? 'LAB_WALK_IN_FAILED', 500)
  }
  const created = data as Omit<LabWalkInResult, 'billing'>
  const billing = input.bill
    ? await chargeLabOrders(db, ctx, {
        patientId: created.patient.id,
        encounterId: created.encounterId,
        lines: created.orders.map((o) => ({ orderId: o.id, testName: o.testName, price: o.price == null ? null : Number(o.price) })),
      })
    : null
  return { ...created, billing }
}
