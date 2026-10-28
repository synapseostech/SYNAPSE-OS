import { NextRequest, NextResponse } from 'next/server'
import { accountStateResponse, classifyAccountState, verifyPassword, createAndSendOTP, shouldSkipOtpEmailDelivery, withMembershipSuspension, listProfileWorkspaces, pickWorkspace } from '@synapse/auth'
import { signMfaPendingToken, mfaCookieOptions, MFA_PENDING_COOKIE } from '@synapse/auth/mfa'
import { supabaseAdmin } from '@synapse/db/admin'
import { sendOtpEmail } from '../../../../lib/resend'

export const dynamic = 'force-dynamic'

const MAX_ATTEMPTS    = 10
const LOCKOUT_MINUTES = 30

export async function POST(req: NextRequest) {
  const body     = await req.json().catch(() => ({}))
  const email    = typeof body.email    === 'string' ? body.email.trim().toLowerCase()    : ''
  const password = typeof body.password === 'string' ? body.password                      : ''

  if (!email || !password) {
    return NextResponse.json({ error: 'Email and password required' }, { status: 400 })
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = supabaseAdmin as any
  const trustedTenantId = req.headers.get('x-tenant-id')?.trim() || null

  // There is one identity per email. The facility comes from the host and is
  // checked against the account's workspaces once the password is proven — the
  // profile row is never filtered by its home tenant.
  const { data: profile, error: profileErr } = await db
    .from('profiles')
    .select('id, email, role, tenant_id, synapse_id, password_hash, login_attempts, locked_until, verification_status, email_verified_at, is_deleted')
    .eq('email', email)
    .maybeSingle()

  if (profileErr || !profile) {
    return NextResponse.json({ error: 'Invalid email or password' }, { status: 401 })
  }

  if (profile.locked_until && new Date(profile.locked_until as string) > new Date()) {
    return NextResponse.json({ error: 'Account temporarily locked. Try again later.' }, { status: 429 })
  }

  const authenticated = profile.password_hash
    ? await verifyPassword(password, profile.password_hash as string)
    : false

  if (!authenticated) {
    const attempts = (profile.login_attempts as number ?? 0) + 1
    const updateData: Record<string, unknown> = { login_attempts: attempts }
    if (attempts >= MAX_ATTEMPTS) {
      const lockedUntil = new Date()
      lockedUntil.setMinutes(lockedUntil.getMinutes() + LOCKOUT_MINUTES)
      updateData['locked_until'] = lockedUntil.toISOString()
    }
    await db.from('profiles').update(updateData).eq('id', profile.id as string)
    return NextResponse.json({ error: 'Invalid email or password' }, { status: 401 })
  }

  await db
    .from('profiles')
    .update({ login_attempts: 0, locked_until: null as unknown as string })
    .eq('id', profile.id as string)

  // Credential proven above: state-specific responses are safe to return now.
  const blockedState = accountStateResponse(classifyAccountState({ ...(await withMembershipSuspension(profile)), locked_until: null }))
  if (blockedState) {
    return NextResponse.json(blockedState.body, { status: blockedState.status })
  }

  const { data: suspendedMembership } = await db
    .from('platform_memberships')
    .select('status')
    .eq('user_id', profile.id as string)
    .in('status', ['SUSPENDED', 'REVOKED'])
    .maybeSingle()

  if (suspendedMembership) {
    return NextResponse.json({ error: 'Platform access has been suspended or revoked.' }, { status: 403 })
  }

  const { data: platformMembership } = await db
    .from('platform_memberships')
    .select('platform_role, status, mfa_required')
    .eq('user_id', profile.id as string)
    .eq('status', 'ACTIVE')
    .maybeSingle()

  const isControlPlaneUser =
    profile.role === 'platform_admin' ||
    profile.role === 'platform_observer' ||
    Boolean(platformMembership)

  if (isControlPlaneUser) {
    const { data: enrollment } = await db
      .from('mfa_enrollments')
      .select('id')
      .eq('user_id', profile.id)
      .eq('verified', true)
      .maybeSingle()

    if (enrollment) {
      const preAuthToken = await signMfaPendingToken({
        sub: profile.id as string,
        email: profile.email as string,
      })

      // Set cookie directly on response — cookies().set() does not propagate in Next.js 15 Route Handlers
      const r = NextResponse.json({ mfaRequired: true })
      r.cookies.set(MFA_PENDING_COOKIE, preAuthToken, mfaCookieOptions)
      return r
    }
    // No MFA enrolled yet — fall through to OTP for initial setup
  }

  // The facility this sign-in is for. A facility host names it; otherwise the
  // home (or only) workspace is used, and an account with several must use its
  // facility address. No workspace at all is a tenant-less account (a patient),
  // which the web surface still serves.
  const workspaces = await listProfileWorkspaces(profile)
  const workspace = pickWorkspace(workspaces, trustedTenantId)

  if (trustedTenantId && !workspace) {
    return NextResponse.json(
      { error: 'This account does not have access to this facility.' },
      { status: 403 },
    )
  }
  if (!workspace && workspaces.length > 1) {
    return NextResponse.json(
      { error: 'This email belongs to more than one facility. Sign in from your facility address.' },
      { status: 409 },
    )
  }

  const e2eTenantId = workspace?.tenantId ?? (profile.tenant_id as string | null)
  const tenantRow = e2eTenantId
    ? (await db.from('tenants').select('is_synthetic, slug').eq('id', e2eTenantId).maybeSingle()).data
    : null

  const e2e = {
    email,
    isSyntheticTenant: Boolean(tenantRow?.is_synthetic),
    facilitySlug: typeof tenantRow?.slug === 'string' ? tenantRow.slug : null,
  }

  try {
    const otp = await createAndSendOTP({ channel: 'email', target: email, e2e })
    if (!shouldSkipOtpEmailDelivery(e2e)) {
      await sendOtpEmail(email, otp)
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : ''
    if (msg === 'TOO_MANY_REQUESTS') {
      return NextResponse.json(
        { error: 'Too many verification requests. Please wait before trying again.' },
        { status: 429 }
      )
    }
    if (msg.startsWith('OTP ')) {
      return NextResponse.json({ error: 'Failed to create verification code.' }, { status: 500 })
    }
    console.error('[auth/password-login] otp email failed', {
      error: msg || String(error),
    })
    return NextResponse.json({ error: 'Failed to send verification email. Please try again.' }, { status: 500 })
  }

  return NextResponse.json({ otpSent: true })
}
