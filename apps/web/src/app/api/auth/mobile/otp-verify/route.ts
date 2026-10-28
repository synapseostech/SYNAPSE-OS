import { NextRequest, NextResponse } from 'next/server'
import { verifyOTP, signToken, createSession, AccountSuspendedError, ACCOUNT_UNAVAILABLE_ERROR, listProfileWorkspaces, pickWorkspace } from '@synapse/auth'
import { supabaseAdmin } from '@synapse/db/admin'
import { SESSION_DURATION_DAYS } from '@synapse/config/constants'

const MOBILE_SESSION_DAYS = 3

const ROLE_KIND: Record<string, string> = {
  patient: 'patient',
  doctor: 'clinician', nurse: 'nurse', pharmacist: 'pharmacy', pharmacy_admin: 'pharmacy',
  pharmacy_store_manager: 'pharmacy', pharmacy_cashier: 'pharmacy', cashier: 'pharmacy',
  pharmacy_staff: 'pharmacy', pharmacy_ceo: 'pharmacy',
  lab_tech: 'lab', receptionist: 'reception', billing_officer: 'billing',
  admin: 'admin', hospital_admin: 'admin', platform_admin: 'admin',
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}))
  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : ''
  const otp = typeof body.otp === 'string' ? body.otp.trim() : ''

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

  const db = supabaseAdmin as any
  const { data: profile, error: profileErr } = await db
    .from('profiles')
    .select(`
      id, email, role, tenant_id, synapse_id,
      full_name, first_name, last_name, is_admin, must_change_password,
      email_verified_at, is_deleted
    `)
    .eq('email', email)
    .single()

  if (profileErr || !profile) {
    return NextResponse.json({ error: 'Account not found.' }, { status: 404 })
  }

  // The facility chosen at the password step, echoed back by the app. The code
  // is already spent, so a workspace that no longer resolves refuses the
  // session rather than asking for a choice that would need a new code.
  const workspaces = await listProfileWorkspaces(profile)
  const requestedTenantId = typeof body.tenantId === 'string' ? body.tenantId.trim() : ''
  const workspace = pickWorkspace(workspaces, requestedTenantId)

  if (requestedTenantId && !workspace) {
    return NextResponse.json(
      { error: 'Your access to that facility has changed. Sign in again.', code: 'NO_WORKSPACE' },
      { status: 403 },
    )
  }
  if (!workspace && workspaces.length > 1) {
    return NextResponse.json(
      { error: 'Sign in again and choose the facility you are signing into.', code: 'CHOOSE_WORKSPACE' },
      { status: 403 },
    )
  }

  const sessionRole = workspace?.role || profile.role
  const sessionTenantId = workspace?.tenantId ?? (profile.tenant_id ?? '')

  const token = await signToken({
    sub: profile.id,
    email,
    role: sessionRole,
    tenant_id: sessionTenantId,
    app: 'mobile',
    synapse_id: profile.synapse_id ?? undefined,
  })

  const expiresAt = new Date()
  expiresAt.setDate(expiresAt.getDate() + MOBILE_SESSION_DAYS)

  try {
    await createSession({
      userId: profile.id,
      token,
      app: 'mobile',
      ip: req.headers.get('x-forwarded-for') ?? undefined,
      userAgent: req.headers.get('user-agent') ?? undefined,
    })
  } catch (error) {
    // Suspended between the password step and this step: same response as the login gate.
    if (error instanceof AccountSuspendedError) {
      return NextResponse.json({ error: ACCOUNT_UNAVAILABLE_ERROR, code: 'ACCOUNT_UNAVAILABLE' }, { status: 403 })
    }
    throw error
  }

  await db.from('profiles').update({ login_attempts: 0 }).eq('id', profile.id)

  const { data: tenant } = await db
    .from('tenants')
    .select('name')
    .eq('id', sessionTenantId || '')
    .maybeSingle()

  const joinedName = [profile.first_name, profile.last_name].filter(Boolean).join(' ')
  const fullName = (profile.full_name as string | null) ?? (joinedName || null)

  return NextResponse.json({
    token,
    expiresAt: expiresAt.toISOString(),
    user: {
      id: profile.id,
      email,
      role: sessionRole,
      fullName,
      synapseId: profile.synapse_id ?? null,
      tenantId: sessionTenantId,
      tenantName: (tenant?.name as string | null) ?? '',
      isAdmin: (profile.is_admin as boolean | null) ?? false,
      mustChangePassword: (profile.must_change_password as boolean | null) ?? false,
      dashboardKind: ROLE_KIND[sessionRole] ?? 'generic',
    },
  })
}
