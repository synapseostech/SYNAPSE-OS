'use server'

import { revalidatePath } from 'next/cache'
import { Resend } from 'resend'
import { supabaseAdmin } from '@synapse/db/admin'
import { facilityInviteUrl } from '@synapse/db/facility-provision'
import { requirePlatformAccess } from '../../../../lib/platform/auth'
import {
  createFacilityInvitation,
  markFacilityInvitationDeliveryFailed,
  markFacilityInvitationSent,
} from '../../../../lib/platform/facility-invitations.server'
import { sendHospitalStaffInviteEmail } from '../../../../lib/resend'
import { logPlatformEvent } from '../../_lib/platform-data'

type Result = { ok: true; message: string } | { ok: false; error: string }

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
}

/**
 * Re-send a pharmacy's onboarding invite (same link, expiry pushed out 72h)
 * to the pharmacy admin on record.
 */
export async function resendPharmacyInvite(tenantId: string): Promise<Result> {
  const actor = await requirePlatformAccess('tenant.manage')
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = supabaseAdmin as any

  const { data: onboarding } = await db
    .from('pharmacy_onboarding')
    .select('invite_token, admin_email, admin_name, onboarding_completed_at')
    .eq('tenant_id', tenantId)
    .maybeSingle()
  if (!onboarding?.invite_token) return { ok: false, error: 'This pharmacy has no onboarding invite to resend.' }
  if (onboarding.onboarding_completed_at) return { ok: false, error: 'Onboarding is already complete; reset onboarding first.' }

  const { data: tenant } = await db.from('tenants').select('name').eq('id', tenantId).maybeSingle()
  const { data: admin } = await db
    .from('profiles')
    .select('email, full_name')
    .eq('tenant_id', tenantId)
    .eq('role', 'pharmacy_admin')
    .maybeSingle()
  const email = (admin?.email as string | undefined) ?? (onboarding.admin_email as string | undefined)
  if (!email) return { ok: false, error: 'No pharmacy admin email on record.' }
  const fullName = (admin?.full_name as string | undefined) ?? (onboarding.admin_name as string | undefined) ?? ''

  const expiresAt = new Date(Date.now() + 72 * 60 * 60 * 1000).toISOString()
  await db
    .from('pharmacy_onboarding')
    .update({ invite_expires_at: expiresAt, invite_sent_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    .eq('tenant_id', tenantId)

  const baseUrl = process.env.NEXT_PUBLIC_PHARMACY_APP_URL ?? 'https://pharm.synapseos.tech'
  const inviteUrl = `${baseUrl}/invite/${encodeURIComponent(String(onboarding.invite_token))}`
  const pharmacyName = escapeHtml(String(tenant?.name ?? 'your pharmacy'))
  const firstName = escapeHtml(fullName.split(' ')[0] || 'there')

  if (!process.env.RESEND_API_KEY) return { ok: false, error: 'Email is not configured (RESEND_API_KEY).' }
  const resend = new Resend(process.env.RESEND_API_KEY)
  const sent = await resend.emails.send({
    from: 'Synapse OS <noreply@synapseos.tech>',
    to: email,
    subject: `Reminder: set up ${String(tenant?.name ?? 'your pharmacy')} on Synapse`,
    html: `<div style="font-family:sans-serif;max-width:520px;margin:0 auto;padding:24px;">
      <h2>Hi ${firstName},</h2>
      <p>Here is your link to set up <strong>${pharmacyName}</strong> on Synapse. It works for 72 hours.</p>
      <a href="${escapeHtml(inviteUrl)}" style="display:inline-block;background:#F97316;color:#fff;padding:12px 28px;border-radius:8px;text-decoration:none;font-weight:bold;">Set up my account</a>
      <p style="color:#999;font-size:12px;margin-top:16px;">${escapeHtml(inviteUrl)}</p>
    </div>`,
  })
  if (sent.error) return { ok: false, error: `Email failed: ${sent.error.message}` }

  await logPlatformEvent({
    actorId: actor.id,
    actorRole: actor.platformRole,
    action: 'TENANT_INVITE_RESENT',
    entityType: 'tenant',
    entityId: tenantId,
    tenantId,
    metadata: { kind: 'pharmacy_onboarding', email, expires_at: expiresAt },
  })
  revalidatePath(`/platform/tenants/${tenantId}`)
  return { ok: true, message: `Invite resent to ${email}.` }
}

/**
 * Re-send a facility staff invitation. Tokens are stored hashed and are
 * single-use, so the old invitation is revoked and a fresh one is issued.
 */
export async function resendFacilityInvitation(tenantId: string, invitationId: string): Promise<Result> {
  const actor = await requirePlatformAccess('user.invite')
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = supabaseAdmin as any
  const { data: invite } = await db
    .from('facility_invitations')
    .select('id, tenant_id, email, full_name, role, department_id, status')
    .eq('id', invitationId)
    .eq('tenant_id', tenantId)
    .maybeSingle()
  if (!invite) return { ok: false, error: 'Invitation not found for this tenant.' }
  if (!['PENDING', 'SENT', 'EXPIRED', 'FAILED'].includes(String(invite.status))) {
    return { ok: false, error: `An invitation that is ${String(invite.status).toLowerCase()} cannot be resent.` }
  }

  await db
    .from('facility_invitations')
    .update({ status: 'REVOKED', revoked_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    .eq('id', invitationId)

  const created = await createFacilityInvitation({
    tenantId,
    email: String(invite.email),
    fullName: String(invite.full_name ?? ''),
    role: String(invite.role),
    departmentId: (invite.department_id as string | null) ?? null,
    actorId: actor.id,
  })
  if (!created.ok) return { ok: false, error: created.error }

  const { data: tenant } = await db.from('tenants').select('slug, facility_type').eq('id', tenantId).maybeSingle()
  const facilityType = (tenant?.facility_type === 'pharmacy' ? 'pharmacy' : tenant?.facility_type === 'hospital' ? 'hospital' : 'laboratory') as
    | 'pharmacy'
    | 'hospital'
    | 'laboratory'
  const appUrl = process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, '') ?? 'https://synapseos.tech'
  const inviteUrl = facilityInviteUrl(facilityType, String(tenant?.slug ?? 'facility'), created.token, { appUrl })
  let delivered = true
  try {
    await sendHospitalStaffInviteEmail({
      to: created.email,
      hospitalName: created.tenantName,
      staffName: String(invite.full_name ?? ''),
      role: String(invite.role),
      inviteUrl,
    })
    await markFacilityInvitationSent(created.invitationId)
  } catch (err) {
    delivered = false
    await markFacilityInvitationDeliveryFailed(created.invitationId, err instanceof Error ? err.message : 'invite_email_send_failed')
  }

  await logPlatformEvent({
    actorId: actor.id,
    actorRole: actor.platformRole,
    action: 'TENANT_INVITE_RESENT',
    entityType: 'tenant',
    entityId: tenantId,
    tenantId,
    metadata: { kind: 'facility_invitation', email: created.email, replaced: invitationId, invitation_id: created.invitationId, delivered },
  })
  revalidatePath(`/platform/tenants/${tenantId}`)
  return delivered
    ? { ok: true, message: `New invitation sent to ${created.email}.` }
    : { ok: false, error: `A new invitation was created for ${created.email} but the email failed to send.` }
}

/**
 * Send a tenant back to the start of onboarding (the wizard reopens; no data
 * is deleted). Needs a reason, and is recorded in the tenant's audit trail.
 */
export async function resetTenantOnboarding(tenantId: string, reason: string): Promise<Result> {
  const actor = await requirePlatformAccess('tenant.manage')
  const why = reason.trim()
  if (!why) return { ok: false, error: 'A reason is required.' }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = supabaseAdmin as any
  const { data: before } = await db
    .from('tenants')
    .select('onboarding_completed, onboarding_step, facility_type')
    .eq('id', tenantId)
    .maybeSingle()
  if (!before) return { ok: false, error: 'Tenant not found.' }

  const { error } = await db
    .from('tenants')
    .update({ onboarding_completed: false, onboarding_step: 0, updated_at: new Date().toISOString() })
    .eq('id', tenantId)
  if (error) return { ok: false, error: error.message }

  if (before.facility_type === 'pharmacy') {
    await db
      .from('pharmacy_onboarding')
      .update({ current_step: 0, onboarding_completed_at: null, updated_at: new Date().toISOString() })
      .eq('tenant_id', tenantId)
  }

  await logPlatformEvent({
    actorId: actor.id,
    actorRole: actor.platformRole,
    action: 'TENANT_ONBOARDING_RESET',
    entityType: 'tenant',
    entityId: tenantId,
    tenantId,
    oldValue: { onboarding_completed: before.onboarding_completed, onboarding_step: before.onboarding_step },
    metadata: { reason: why, onboarding_completed: false, onboarding_step: 0 },
  })
  revalidatePath(`/platform/tenants/${tenantId}`)
  revalidatePath('/platform/tenants')
  return { ok: true, message: 'Onboarding reset. The tenant will see the setup wizard again.' }
}
