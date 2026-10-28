import { NextRequest, NextResponse } from 'next/server'
import {
  accountStateResponse,
  classifyAccountState,
  verifyOTP,
  signToken,
  createSession,
  withMembershipSuspension,
  listProfileWorkspaces,
  pickWorkspace,
} from '@synapse/auth'
import { supabaseAdmin } from '@synapse/db/admin'
import { SESSION_COOKIE, SESSION_DURATION_DAYS } from '@synapse/config/constants'
import { pharmacyWorkspaces, workspaceOption } from '@/lib/workspaces'

export async function POST(req: NextRequest) {
  const body  = await req.json().catch(() => ({}))
  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : ''
  const otp   = typeof body.otp   === 'string' ? body.otp.trim()                 : ''

  if (!email || !otp || otp.length !== 6) {
    return NextResponse.json({ error: 'email and 6-digit otp required' }, { status: 400 })
  }

  const result = await verifyOTP({ target: email, otp })

  if (!result.valid) {
    const messages: Record<string, string> = {
      NOT_FOUND:         'No active verification found. Request a new code.',
      EXPIRED:           'Code has expired. Request a new code.',
      INVALID:           'Incorrect code. Please try again.',
      TOO_MANY_ATTEMPTS: 'Too many incorrect attempts. Request a new code.',
    }
    return NextResponse.json(
      { error: messages[result.error ?? 'INVALID'] ?? 'Verification failed.' },
      { status: result.error === 'TOO_MANY_ATTEMPTS' ? 429 : 401 }
    )
  }

  // Generated DB types lag the profiles columns used here; same cast as auth/login/route.ts.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: profile, error: profileErr } = await (supabaseAdmin as any)
    .from('profiles')
    .select('id, role, tenant_id, synapse_id, must_change_password, onboarding_complete, verification_status, email_verified_at, is_deleted')
    .eq('email', email)
    .single()

  if (profileErr || !profile) {
    return NextResponse.json({ error: 'Account not found.' }, { status: 404 })
  }

  // OTP proven above: block archived/suspended/unactivated identities before a session is issued.
  const blockedState = accountStateResponse(classifyAccountState(await withMembershipSuspension(profile)))
  if (blockedState) {
    return NextResponse.json(blockedState.body, { status: blockedState.status })
  }

  // The facility chosen at the password step decides which settings apply. The
  // client may repeat it; without it the home or only pharmacy is used.
  const workspaces = pharmacyWorkspaces(await listProfileWorkspaces(profile))
  if (workspaces.length === 0) {
    return NextResponse.json(
      {
        error: 'This account is not set up for the pharmacy portal. Contact your pharmacy administrator.',
        code: 'NO_PHARMACY_ACCESS',
      },
      { status: 403 },
    )
  }

  const requestedTenantId = typeof body.tenantId === 'string' ? body.tenantId.trim() : ''
  const workspace = pickWorkspace(workspaces, requestedTenantId)
  if (!workspace) {
    if (requestedTenantId) {
      return NextResponse.json(
        { error: 'This account has no access to that pharmacy.', code: 'NO_PHARMACY_ACCESS' },
        { status: 403 },
      )
    }
    // The code is already spent, so a fresh choice needs a fresh code: send the
    // user back to the password step rather than to a picker this step cannot serve.
    return NextResponse.json(
      {
        error: 'Sign in again and choose the pharmacy you are signing into.',
        code: 'CHOOSE_WORKSPACE',
        workspaces: workspaces.map(workspaceOption),
      },
      { status: 403 },
    )
  }

  // Deactivated pharmacy staff cannot sign in with an email code either.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: settings } = await (supabaseAdmin as any)
    .from('pharmacy_user_settings')
    .select('is_active')
    .eq('profile_id', profile.id)
    .eq('tenant_id', workspace.tenantId)
    .maybeSingle()
  if (settings?.is_active === false) {
    return NextResponse.json(
      { error: 'This account has been deactivated. Contact your pharmacy administrator.', code: 'ACCOUNT_INACTIVE' },
      { status: 403 },
    )
  }

  const role = workspace.role || (profile.role as string) || 'pharmacy_staff'
  const token = await signToken({
    sub:       profile.id as string,
    email,
    role,
    tenant_id: workspace.tenantId,
    app:       'pharmacy',
    synapse_id:(profile.synapse_id as string | null) ?? undefined,
  })

  await createSession({
    userId:    profile.id as string,
    token,
    app:       'pharmacy',
    ip:        req.headers.get('x-forwarded-for') ?? undefined,
    userAgent: req.headers.get('user-agent') ?? undefined,
  })

  await supabaseAdmin
    .from('profiles')
    .update({ login_attempts: 0 })
    .eq('id', profile.id as string)

  const expires = new Date()
  expires.setDate(expires.getDate() + SESSION_DURATION_DAYS)

  let redirect = '/portal/dashboard'
  if (profile.must_change_password) {
    redirect = '/change-password'
  } else if (role === 'cashier') {
    redirect = '/portal/pos'
  }
  // Do not force /onboarding here — middleware + tenant/profile flags own that gate.
  // Platform-provisioned pharmacies are already marked complete before first login.

  const response = NextResponse.json({
    ok: true,
    mustChangePassword: Boolean(profile.must_change_password),
    role,
    tenantId: workspace.tenantId,
    tenantName: workspace.name || workspace.slug,
    redirect,
  })
  response.cookies.set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure:   process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    expires,
    path:     '/',
  })

  return response
}
