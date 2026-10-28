import { NextRequest, NextResponse } from 'next/server'
import { accountStateResponse, classifyAccountState, verifyOTP, signToken, createSession, withMembershipSuspension, listProfileWorkspaces, pickWorkspace } from '@synapse/auth'
import { signMfaPendingToken, mfaCookieOptions, MFA_PENDING_COOKIE } from '@synapse/auth/mfa'
import { getPostLoginPath } from '@synapse/auth/redirects'
import { supabaseAdmin } from '@synapse/db/admin'
import { SESSION_COOKIE, SESSION_DURATION_DAYS } from '@synapse/config/constants'

export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest) {
  const body  = await req.json().catch(() => ({}))
  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : ''
  const otp   = typeof body.otp   === 'string' ? body.otp.trim()                : ''

  if (!email || !otp || otp.length !== 6) {
    return NextResponse.json({ error: 'email and 6-digit otp required' }, { status: 400 })
  }

  const result = await verifyOTP({ target: email, otp })

  if (!result.valid) {
    const messages: Record<string, string> = {
      NOT_FOUND: 'No active verification found. Request a new code.',
      EXPIRED: 'Code has expired. Request a new code.',
      INVALID: 'Incorrect code. Please try again.',
      TOO_MANY_ATTEMPTS: 'Too many incorrect attempts. Request a new code.',
    }
    return NextResponse.json(
      { error: messages[result.error ?? 'INVALID'] ?? 'Verification failed.' },
      { status: result.error === 'TOO_MANY_ATTEMPTS' ? 429 : 401 }
    )
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const trustedTenantId = req.headers.get('x-tenant-id')?.trim() || null

  // One identity per email; the facility is resolved from the host below rather
  // than by filtering the profile row by its home tenant.
  const { data: profile, error: profileErr } = await (supabaseAdmin as any)
    .from('profiles')
    .select('id, role, tenant_id, synapse_id, verification_status, email_verified_at, is_deleted, must_change_password, onboarding_complete')
    .eq('email', email)
    .maybeSingle()

  if (profileErr || !profile) {
    return NextResponse.json({ error: 'Account not found.' }, { status: 404 })
  }

  // Credential proven above: state-specific responses are safe to return now.
  const blockedState = accountStateResponse(classifyAccountState({ ...(await withMembershipSuspension(profile)), locked_until: null }))
  if (blockedState) {
    return NextResponse.json(blockedState.body, { status: blockedState.status })
  }

  // platform_admin requires TOTP as third factor
  if (profile.role === 'platform_admin') {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: enrollment } = await (supabaseAdmin as any)
      .from('mfa_enrollments')
      .select('id, verified')
      .eq('user_id', profile.id)
      .eq('verified', true)
      .maybeSingle()

    const preAuthToken = await signMfaPendingToken({
      sub: profile.id as string,
      email,
    })

    // Set cookie directly on response — cookies().set() does not propagate in Next.js 15 Route Handlers
    const mfaResponse = NextResponse.json(enrollment ? { mfaRequired: true } : { mfaSetupRequired: true })
    mfaResponse.cookies.set(MFA_PENDING_COOKIE, preAuthToken, mfaCookieOptions)
    return mfaResponse
  }

  // The facility this sign-in is for: the host's workspace, else the home (or
  // only) one. A tenant-less account (a patient) still signs in to the web.
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

  const sessionRole = workspace?.role || profile.role
  const sessionTenantId = workspace?.tenantId ?? (profile.tenant_id as string | null)

  // Non-platform_admin: issue full session immediately
  const token = await signToken({
    sub:        profile.id,
    email,
    role:       sessionRole,
    tenant_id:  sessionTenantId,
    app:        'web',
    synapse_id: profile.synapse_id ?? undefined,
  })

  await createSession({
    userId:    profile.id,
    token,
    app:       'web',
    ip:        req.headers.get('x-forwarded-for') ?? undefined,
    userAgent: req.headers.get('user-agent') ?? undefined,
  })

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await (supabaseAdmin as any)
    .from('profiles')
    .update({ login_attempts: 0 })
    .eq('id', profile.id)

  const expires = new Date()
  expires.setDate(expires.getDate() + SESSION_DURATION_DAYS)

  // Set cookie directly on response — cookies().set() does not propagate in Next.js 15 Route Handlers
  let pharmacyOnboardingStep: number | null = null
  let tenantFacilityType: string | null = null

  if (sessionTenantId) {
    const [{ data: tenant }, { data: pharmOnboarding }] = await Promise.all([
      (supabaseAdmin as any)
        .from('tenants')
        .select('facility_type, onboarding_completed')
        .eq('id', sessionTenantId)
        .maybeSingle(),
      (supabaseAdmin as any)
        .from('pharmacy_onboarding')
        .select('current_step')
        .eq('tenant_id', sessionTenantId)
        .maybeSingle(),
    ])
    tenantFacilityType = tenant?.facility_type ?? null
    pharmacyOnboardingStep = pharmOnboarding?.current_step ?? null
  }

  const redirectTo = getPostLoginPath({
    role: sessionRole,
    mustChangePassword: Boolean(profile.must_change_password),
    emailVerified: Boolean(profile.email_verified_at),
    onboardingComplete: Boolean(profile.onboarding_complete),
    pharmacyOnboardingStep,
    tenantFacilityType,
    pharmacyAppUrl: process.env.NEXT_PUBLIC_PHARMACY_APP_URL,
  })

  const response = NextResponse.json({ ok: true, redirectTo })
  response.cookies.set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    expires,
    path: '/',
  })
  return response
}
