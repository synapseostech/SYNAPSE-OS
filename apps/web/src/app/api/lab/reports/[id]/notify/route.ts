import { NextResponse } from 'next/server'
import { z } from 'zod'
import { supabaseAdmin } from '@synapse/db/admin'
import { notifyPatientLabResult } from '@synapse/auth/mobile-push'
import { logHospitalAudit } from '@/lib/hospital-shared/audit'
import { isLabContextError, requireLabAccess } from '@/lib/lab/access'

export const dynamic = 'force-dynamic'

const bodySchema = z.object({
  channels: z.array(z.enum(['push', 'sms', 'print'])).min(1).max(3),
})

function maskPhone(phone: string | null | undefined): string | null {
  const digits = String(phone ?? '').replace(/\D/g, '')
  return digits.length >= 4 ? `•••${digits.slice(-3)}` : null
}

/**
 * Staff tell the patient that a released report is ready. Each (report
 * version, channel) is claimed once in lab_report_deliveries, so pressing the
 * button twice never sends twice. The push says only that a result is ready —
 * no test name or value leaves the server.
 *
 *   push   the patient's own Synapse app account (via their Synapse ID), if any
 *   sms    recorded as SKIPPED: no SMS provider is configured in this repo
 *   print  records that a printed copy was handed over
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireLabAccess('report.notify')
  if (isLabContextError(ctx)) return ctx
  const { id } = await params
  if (!/^[0-9a-f-]{36}$/i.test(id)) return NextResponse.json({ error: 'Lab report not found' }, { status: 404 })
  const parsed = bodySchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 })
  const channels = [...new Set(parsed.data.channels)]

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = supabaseAdmin as any
  const { data: report } = await db
    .from('lab_reports')
    .select('id, version, patient_id')
    .eq('id', id)
    .eq('tenant_id', ctx.tenantId)
    .eq('facility_id', ctx.hospitalId)
    .in('status', ['FINAL', 'AMENDED'])
    .maybeSingle()
  if (!report) return NextResponse.json({ error: 'Lab report not found' }, { status: 404 })

  const { data: patient } = await db
    .from('patients')
    .select('id, phone, person_id')
    .eq('id', report.patient_id)
    .eq('tenant_id', ctx.tenantId)
    .maybeSingle()

  // The patient's own app account: patients.person_id -> persons.synapse_id -> patient_profiles.id.
  let accountId: string | null = null
  if (channels.includes('push') && patient?.person_id) {
    const { data: person } = await db.from('persons').select('synapse_id').eq('id', patient.person_id).maybeSingle()
    if (person?.synapse_id) {
      const { data: account } = await db.from('patient_profiles').select('id').eq('synapse_id', person.synapse_id).maybeSingle()
      accountId = account?.id ?? null
    }
  }

  const rows = channels.map((channel) => {
    if (channel === 'push') {
      return accountId
        ? { channel, status: 'SENT', detail: 'Push queued to the patient app', recipient_hint: 'Synapse app' }
        : { channel, status: 'SKIPPED', detail: 'PATIENT_HAS_NO_APP_ACCOUNT', recipient_hint: null }
    }
    if (channel === 'sms') {
      return { channel, status: 'SKIPPED', detail: 'SMS_PROVIDER_NOT_CONFIGURED', recipient_hint: maskPhone(patient?.phone) }
    }
    return { channel, status: 'SENT', detail: 'Printed copy handed over', recipient_hint: null }
  })

  const { data: claimed, error } = await db
    .from('lab_report_deliveries')
    .upsert(
      rows.map((row) => ({ ...row, tenant_id: ctx.tenantId, report_id: report.id, report_version: report.version, created_by: ctx.userId })),
      { onConflict: 'report_id,report_version,channel', ignoreDuplicates: true },
    )
    .select('channel, status, detail, recipient_hint, created_at')
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  const newly = (claimed ?? []) as Array<{ channel: string; status: string }>
  if (accountId && newly.some((row) => row.channel === 'push' && row.status === 'SENT')) {
    notifyPatientLabResult({ userId: accountId })
  }
  await logHospitalAudit({ ctx, action: 'LAB_REPORT_NOTIFIED', tableName: 'lab_reports', recordId: report.id, newValue: { channels: newly } })
  const alreadyDone = channels.filter((channel) => !newly.some((row) => row.channel === channel))
  return NextResponse.json({ deliveries: newly, alreadyDone })
}
