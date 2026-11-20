import { NextRequest, NextResponse } from 'next/server'
import { randomUUID } from 'node:crypto'
import { hashPassword } from '@synapse/auth/password'
import { supabaseAdmin } from '@synapse/db/admin'
import {
  PHARMACY_INVITE_LINK_TTL_HOURS,
  PHARMACY_RESET_LINK_TTL_HOURS,
  issuePharmacyPasswordSetupLink,
  unusablePasswordSeed,
} from '../../../../../lib/pharmacy-password-setup'
import {
  isMobileAuth,
  isMobilePharmacyAdmin,
  requireMobilePharmacyAuth,
} from '../../../../../lib/mobile-pharmacy-auth'
import { loadProfileAvatars } from '../../../../../lib/profile-avatars'

export const dynamic = 'force-dynamic'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = () => supabaseAdmin as any

const ROLE_MAP: Record<string, string> = {
  ADMIN: 'pharmacy_admin',
  CEO: 'pharmacy_ceo',
  STAFF: 'pharmacy_staff',
  pharmacy_admin: 'pharmacy_admin',
  pharmacy_ceo: 'pharmacy_ceo',
  pharmacy_staff: 'pharmacy_staff',
  pharmacy_cashier: 'pharmacy_cashier',
  pharmacist: 'pharmacist',
  pharmacy_store_manager: 'pharmacy_store_manager',
}

const ALLOWED_ROLES = new Set(Object.values(ROLE_MAP))

/** The target must be a member of the caller's pharmacy (prevents cross-tenant edits/resets). */
async function tenantMember(tenantId: string, profileId: string) {
  const { data } = await db()
    .from('pharmacy_user_settings')
    .select('profile_id')
    .eq('tenant_id', tenantId)
    .eq('profile_id', profileId)
    .maybeSingle()
  return Boolean(data)
}

/** GET — staff list for this tenant. */
export async function GET(req: NextRequest) {
  const auth = await requireMobilePharmacyAuth(req)
  if (!isMobileAuth(auth)) return auth

  const { data: settings } = await db()
    .from('pharmacy_user_settings')
    .select('profile_id, username, pharmacy_role, permissions, is_active, two_factor_enabled, created_at')
    .eq('tenant_id', auth.tenantId)
    .order('created_at', { ascending: false })

  const rows = settings ?? []
  const profileIds = rows.map((s: any) => s.profile_id)
  const profiles = new Map<string, any>()
  if (profileIds.length) {
    const { data } = await db().from('profiles').select('id, full_name, first_name, last_name, email').in('id', profileIds)
    for (const p of data ?? []) profiles.set(String(p.id), p)
  }

  const avatars = await loadProfileAvatars(db(), profileIds.map(String))

  return NextResponse.json({
    canManage: isMobilePharmacyAdmin(auth),
    users: rows.map((s: any) => {
      const p = profiles.get(String(s.profile_id))
      const name =
        p?.full_name || [p?.first_name, p?.last_name].filter(Boolean).join(' ') || p?.email?.split('@')[0] || ''
      return {
        id: s.profile_id,
        name,
        email: p?.email ?? '',
        username: s.username,
        role: s.pharmacy_role,
        isActive: s.is_active !== false,
        twoFactorEnabled: s.two_factor_enabled ?? false,
        createdAt: s.created_at,
        avatarUrl: avatars.get(String(s.profile_id)) ?? null,
      }
    }),
  })
}

/**
 * POST — invite/create a staff user. Admin only.
 * No password is generated for handover or returned: the new user receives a
 * single-use set-password link (72h) at the Pharmacy URL.
 */
export async function POST(req: NextRequest) {
  const auth = await requireMobilePharmacyAuth(req)
  if (!isMobileAuth(auth)) return auth
  if (!isMobilePharmacyAdmin(auth)) return NextResponse.json({ error: 'Admin role required' }, { status: 403 })

  const { name, email, username, role } = (await req.json().catch(() => ({}))) as Record<string, string>
  if (!name || !email || !role) return NextResponse.json({ error: 'name, email and role are required' }, { status: 400 })

  const pharmacyRole = ROLE_MAP[role] ?? 'pharmacy_staff'
  const emailLc = email.toLowerCase()

  const { data: existing } = await db().from('profiles').select('id').eq('email', emailLc).maybeSingle()
  if (existing) return NextResponse.json({ error: 'A user with this email already exists' }, { status: 400 })

  const passwordHash = await hashPassword(unusablePasswordSeed())
  const now = new Date().toISOString()
  const newId = randomUUID()

  const { error: profErr } = await db().from('profiles').insert({
    id: newId,
    email: emailLc,
    full_name: name,
    password_hash: passwordHash,
    role: pharmacyRole,
    tenant_id: auth.tenantId,
    verification_status: 'verified',
    email_verified_at: now,
    is_deleted: false,
    must_change_password: true,
    created_at: now,
    updated_at: now,
  })
  if (profErr) {
    console.error('[mobile/pharmacy/users] profile insert', profErr.message)
    return NextResponse.json({ error: 'Failed to create user' }, { status: 500 })
  }

  const { error: setErr } = await db().from('pharmacy_user_settings').insert({
    tenant_id: auth.tenantId,
    profile_id: newId,
    username: username ? username.toLowerCase() : null,
    pharmacy_role: pharmacyRole,
    permissions: [],
    must_change_password: true,
    is_active: true,
    created_by: auth.userId,
    created_at: now,
    updated_at: now,
  })
  if (setErr) {
    await db().from('profiles').delete().eq('id', newId)
    return NextResponse.json({ error: 'Failed to create user settings' }, { status: 500 })
  }

  let emailSent = false
  const link = await issuePharmacyPasswordSetupLink(newId, PHARMACY_INVITE_LINK_TTL_HOURS)
  if (link) {
    try {
      const { sendInvite } = await import('@synapse/email')
      await sendInvite({ to: emailLc, name, facilityName: 'Synapse Pharmacy', role: pharmacyRole, inviteUrl: link.url })
      emailSent = true
    } catch (err) {
      console.error('[mobile/pharmacy/users] invite email not delivered', err instanceof Error ? err.name : 'error')
    }
  }

  try {
    await db().from('pharmacy_audit_logs').insert({
      tenant_id: auth.tenantId,
      profile_id: auth.userId,
      action: 'CREATE_USER',
      entity: 'USER',
      entity_id: newId,
      details: { name, email: emailLc, role: pharmacyRole, source: 'mobile' },
    })
  } catch {
    /* non-fatal */
  }

  return NextResponse.json({
    ok: true,
    user: { id: newId, name, email: emailLc, role: pharmacyRole },
    inviteSent: emailSent,
    emailSent,
  })
}

/** PATCH — disable/reactivate, change role/name, or reset password. Admin only. */
export async function PATCH(req: NextRequest) {
  const auth = await requireMobilePharmacyAuth(req)
  if (!isMobileAuth(auth)) return auth
  if (!isMobilePharmacyAdmin(auth)) return NextResponse.json({ error: 'Admin role required' }, { status: 403 })

  const { id, name, role, isActive, resetPassword } = (await req.json().catch(() => ({}))) as Record<string, unknown>
  if (!id || typeof id !== 'string') return NextResponse.json({ error: 'User id required' }, { status: 400 })

  if (!(await tenantMember(auth.tenantId, id))) return NextResponse.json({ error: 'User not found' }, { status: 404 })

  if (resetPassword) {
    // Revoke the old password + sessions, then email a single-use set-password link.
    // The new password is chosen by the user; nothing is returned to the admin.
    const now = new Date().toISOString()
    const { data: target } = await db().from('profiles').select('email, full_name').eq('id', id).eq('tenant_id', auth.tenantId).maybeSingle()
    if (!target?.email) return NextResponse.json({ error: 'User not found' }, { status: 404 })
    await db().from('profiles').update({ password_hash: await hashPassword(unusablePasswordSeed()), must_change_password: true, updated_at: now }).eq('id', id).eq('tenant_id', auth.tenantId)
    try {
      await db().from('pharmacy_user_settings').update({ must_change_password: true }).eq('tenant_id', auth.tenantId).eq('profile_id', id)
      await db().from('synapse_sessions').delete().eq('user_id', id)
    } catch {
      /* non-fatal */
    }
    let emailSent = false
    const link = await issuePharmacyPasswordSetupLink(id, PHARMACY_RESET_LINK_TTL_HOURS)
    if (link) {
      try {
        const { sendPasswordReset } = await import('@synapse/email')
        await sendPasswordReset({ to: target.email, name: target.full_name ?? target.email, resetUrl: link.url })
        emailSent = true
      } catch (err) {
        console.error('[mobile/pharmacy/users] reset email not delivered', err instanceof Error ? err.name : 'error')
      }
    }
    try {
      await db().from('pharmacy_audit_logs').insert({
        tenant_id: auth.tenantId, profile_id: auth.userId, action: 'RESET_PASSWORD', entity: 'USER', entity_id: id,
        details: { source: 'mobile', link_emailed: emailSent },
      })
    } catch {
      /* non-fatal */
    }
    return NextResponse.json({ ok: true, resetLinkSent: emailSent, emailSent })
  }

  const update: Record<string, unknown> = { updated_at: new Date().toISOString() }
  if (role) {
    const mapped = ROLE_MAP[String(role)]
    if (!mapped || !ALLOWED_ROLES.has(mapped)) return NextResponse.json({ error: 'Invalid role' }, { status: 400 })
    update.pharmacy_role = mapped
  }
  if (isActive !== undefined) update.is_active = Boolean(isActive)
  const { error } = await db().from('pharmacy_user_settings').update(update).eq('tenant_id', auth.tenantId).eq('profile_id', id)
  if (error) return NextResponse.json({ error: 'Failed to update user' }, { status: 500 })
  if (typeof name === 'string' && name) {
    await db().from('profiles').update({ full_name: name, updated_at: new Date().toISOString() }).eq('id', id).eq('tenant_id', auth.tenantId)
  }
  return NextResponse.json({ ok: true })
}
