import { NextRequest, NextResponse } from 'next/server'
import { accountStateResponse, classifyAccountState, verifyPassword, createAndSendOTP, withMembershipSuspension, listProfileWorkspaces, pickWorkspace } from '@synapse/auth'
import { supabaseAdmin } from '@synapse/db/admin'
import { sendOtpEmail } from '@/lib/resend'

const MAX_ATTEMPTS = 10
const LOCKOUT_MINUTES = 30

/** Step 1: password verify → email OTP (no session until otp-verify). */
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}))
  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : ''
  const password = typeof body.password === 'string' ? body.password : ''

  if (!email || !password) {
    return NextResponse.json({ error: 'Email and password required' }, { status: 400 })
  }

  const db = supabaseAdmin as any
  const { data: profile, error: profileErr } = await db
    .from('profiles')
    .select('id, email, role, tenant_id, password_hash, login_attempts, locked_until, verification_status, email_verified_at, is_deleted')
    .eq('email', email)
    .single()

  if (profileErr || !profile) {
    return NextResponse.json({ error: 'Invalid email or password' }, { status: 401 })
  }

  if (profile.locked_until && new Date(profile.locked_until) > new Date()) {
    return NextResponse.json({ error: 'Account temporarily locked. Try again later.' }, { status: 429 })
  }

  const authenticated = profile.password_hash
    ? await verifyPassword(password, profile.password_hash)
    : false

  if (!authenticated) {
    const attempts = (profile.login_attempts ?? 0) + 1
    const update: Record<string, unknown> = { login_attempts: attempts }
    if (attempts >= MAX_ATTEMPTS) {
      const until = new Date()
      until.setMinutes(until.getMinutes() + LOCKOUT_MINUTES)
      update.locked_until = until.toISOString()
    }
    await db.from('profiles').update(update).eq('id', profile.id)
    return NextResponse.json({ error: 'Invalid email or password' }, { status: 401 })
  }

  await db.from('profiles').update({ login_attempts: 0, locked_until: null }).eq('id', profile.id)

  // Credential proven above: state-specific responses are safe to return now.
  const blockedState = accountStateResponse(classifyAccountState({ ...(await withMembershipSuspension(profile)), locked_until: null }))
  if (blockedState) {
    return NextResponse.json(blockedState.body, { status: blockedState.status })
  }

  // One identity may work at, or belong to, more than one facility. The choice
  // is made before a code is sent so the verify step does not burn the code
  // asking for it.
  const workspaces = await listProfileWorkspaces(profile)
  const requestedTenantId = typeof body.tenantId === 'string' ? body.tenantId.trim() : ''
  const workspace = pickWorkspace(workspaces, requestedTenantId)

  if (requestedTenantId && !workspace) {
    return NextResponse.json(
      { error: 'This account has no access to that facility.', code: 'NO_WORKSPACE' },
      { status: 403 },
    )
  }
  if (!requestedTenantId && workspaces.length > 1) {
    return NextResponse.json(
      {
        error: 'This email works at more than one facility. Choose where you are signing in.',
        code: 'CHOOSE_WORKSPACE',
        chooseWorkspace: true,
        workspaces: workspaces.map((option) => ({
          tenantId: option.tenantId,
          name: option.name || option.slug,
          slug: option.slug,
        })),
      },
      { status: 409 },
    )
  }

  let otp: string
  try {
    otp = await createAndSendOTP({ channel: 'email', target: email })
  } catch (error) {
    const msg = error instanceof Error ? error.message : ''
    if (msg === 'TOO_MANY_REQUESTS') {
      return NextResponse.json({ error: 'Too many verification requests. Please wait.' }, { status: 429 })
    }
    return NextResponse.json({ error: 'Failed to create verification code.' }, { status: 500 })
  }

  try {
    await sendOtpEmail(email, otp)
  } catch (error) {
    console.error('[auth/mobile/login] otp email failed', error)
    return NextResponse.json({ error: 'Failed to send verification email.' }, { status: 500 })
  }

  return NextResponse.json({
    otpSent: true,
    tenantId: workspace?.tenantId ?? '',
    tenantName: workspace ? workspace.name || workspace.slug : '',
  })
}
