import { NextRequest, NextResponse } from 'next/server'
import {
  accountStateResponse,
  classifyAccountState,
  verifyPassword,
  createAndSendOTP,
  signToken,
  createSession,
  withMembershipSuspension,
  listProfileWorkspaces,
  pickWorkspace,
  type SynapseWorkspace,
} from '@synapse/auth'
import { supabaseAdmin } from '@synapse/db/admin'
import { sendOTP } from '@synapse/email'
import { SESSION_COOKIE, SESSION_DURATION_DAYS } from '@synapse/config/constants'
import { pharmacyWorkspaces, workspaceOption } from '@/lib/workspaces'

const MAX_ATTEMPTS = 10
const LOCKOUT_MINUTES = 30

// Control-plane staff have no home pharmacy. The portal serves them through the
// platform branch of getContext, so they sign in without a tenant workspace.
const PLATFORM_ROLES = new Set(['platform_admin', 'platform_observer', 'superadmin', 'super_admin'])

type ProfileRow = {
  id: string
  email: string
  full_name: string | null
  role: string | null
  tenant_id: string | null
  synapse_id: string | null
  password_hash: string | null
  login_attempts: number | null
  locked_until: string | null
  verification_status: string | null
  email_verified_at: string | null
  is_deleted: boolean | null
  must_change_password: boolean | null
  onboarding_complete: boolean | null
}

function identifierLooksLikeEmail(value: string): boolean {
  return value.includes('@')
}

function roleRequiresLoginOtp(role: string | null, pharmacyRole: string | null, twoFactorEnabled: boolean | null): boolean {
  // Explicit staff opt-in still honors TOTP/email OTP.
  if (twoFactorEnabled === true) return true
  const r = (pharmacyRole || role || '').toLowerCase()
  // Pharmacy admins keep email OTP as second factor. Other staff: password only.
  return r === 'pharmacy_admin' || r === 'pharmacy_ceo' || r === 'admin'
}

async function resolveProfileByIdentifier(identifier: string): Promise<ProfileRow | null> {
  const db = supabaseAdmin as any
  if (identifierLooksLikeEmail(identifier)) {
    const { data } = await db
      .from('profiles')
      .select(
        'id, email, full_name, role, tenant_id, synapse_id, password_hash, login_attempts, locked_until, verification_status, email_verified_at, is_deleted, must_change_password, onboarding_complete',
      )
      .eq('email', identifier)
      .maybeSingle()
    return (data as ProfileRow | null) ?? null
  }

  const { data: settingsRows } = await db
    .from('pharmacy_user_settings')
    .select('profile_id')
    .eq('username', identifier)
    .eq('is_active', true)
    .limit(2)

  if (!settingsRows?.length) return null
  if (settingsRows.length > 1) {
    // Username is only unique per tenant — require email when ambiguous.
    return null
  }

  const { data } = await db
    .from('profiles')
    .select(
      'id, email, full_name, role, tenant_id, synapse_id, password_hash, login_attempts, locked_until, verification_status, email_verified_at, is_deleted, must_change_password, onboarding_complete',
    )
    .eq('id', settingsRows[0].profile_id)
    .maybeSingle()

  return (data as ProfileRow | null) ?? null
}

/** The tenant-less workspace a control-plane account signs into, or null. */
function platformWorkspaceFor(profile: ProfileRow): SynapseWorkspace | null {
  const role = (profile.role ?? '').trim()
  if (!PLATFORM_ROLES.has(role)) return null
  return {
    tenantId: '',
    name: 'Synapse Platform',
    slug: 'platform',
    facilityType: 'platform',
    role,
    pharmacyRole: null,
    permissions: [],
    storeId: null,
    isHome: true,
  }
}

async function issueSession(
  req: NextRequest,
  profile: ProfileRow,
  email: string,
  workspace: SynapseWorkspace,
) {
  const role = workspace.role || profile.role || 'pharmacy_staff'
  const token = await signToken({
    sub: profile.id,
    email,
    role,
    tenant_id: workspace.tenantId,
    app: 'pharmacy',
    synapse_id: profile.synapse_id ?? undefined,
  })

  await createSession({
    userId: profile.id,
    token,
    app: 'pharmacy',
    ip: req.headers.get('x-forwarded-for') ?? undefined,
    userAgent: req.headers.get('user-agent') ?? undefined,
  })

  const expires = new Date()
  expires.setDate(expires.getDate() + SESSION_DURATION_DAYS)

  let redirect = '/portal/dashboard'
  if (profile.must_change_password) {
    redirect = '/change-password'
  } else if (role === 'cashier') {
    redirect = '/portal/pos'
  }

  const response = NextResponse.json({
    ok: true,
    sessionIssued: true,
    mustChangePassword: Boolean(profile.must_change_password),
    role,
    tenantId: workspace.tenantId,
    tenantName: workspace.name || workspace.slug,
    redirect,
  })
  response.cookies.set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    expires,
    path: '/',
  })
  return response
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}))
  const rawIdentifier =
    typeof body.identifier === 'string'
      ? body.identifier
      : typeof body.email === 'string'
        ? body.email
        : typeof body.username === 'string'
          ? body.username
          : ''
  const identifier = rawIdentifier.trim().toLowerCase()
  const password = typeof body.password === 'string' ? body.password : ''

  if (!identifier || !password) {
    return NextResponse.json({ error: 'Email or username and password required' }, { status: 400 })
  }

  const db = supabaseAdmin as any
  const profile = await resolveProfileByIdentifier(identifier)

  if (!profile) {
    return NextResponse.json({ error: 'Invalid email/username or password' }, { status: 401 })
  }

  const email = String(profile.email ?? '').toLowerCase()

  if (profile.locked_until && new Date(profile.locked_until) > new Date()) {
    return NextResponse.json(
      { error: 'Account temporarily locked. Try again later.' },
      { status: 429 },
    )
  }

  const authenticated = profile.password_hash
    ? await verifyPassword(password, profile.password_hash)
    : false

  if (!authenticated) {
    const attempts = (profile.login_attempts ?? 0) + 1
    const updateData: { login_attempts: number; locked_until?: string } = { login_attempts: attempts }
    if (attempts >= MAX_ATTEMPTS) {
      const lockedUntil = new Date()
      lockedUntil.setMinutes(lockedUntil.getMinutes() + LOCKOUT_MINUTES)
      updateData.locked_until = lockedUntil.toISOString()
    }
    await db.from('profiles').update(updateData).eq('id', profile.id)
    return NextResponse.json({ error: 'Invalid email/username or password' }, { status: 401 })
  }

  await db
    .from('profiles')
    .update({ login_attempts: 0, locked_until: null as unknown as string })
    .eq('id', profile.id)

  // Credential proven above: state-specific responses are safe to return now.
  const blockedState = accountStateResponse(classifyAccountState({ ...(await withMembershipSuspension(profile)), locked_until: null }))
  if (blockedState) {
    return NextResponse.json(blockedState.body, { status: blockedState.status })
  }

  // One identity may work at more than one pharmacy, so the facility is chosen
  // before anything is issued. The client may name it on a repeat call.
  const workspaces = pharmacyWorkspaces(await listProfileWorkspaces(profile))
  const platformWorkspace = workspaces.length === 0 ? platformWorkspaceFor(profile) : null
  if (workspaces.length === 0 && !platformWorkspace) {
    return NextResponse.json(
      {
        error: 'This account is not set up for the pharmacy portal. Contact your pharmacy administrator.',
        code: 'NO_PHARMACY_ACCESS',
      },
      { status: 403 },
    )
  }

  const requestedTenantId = typeof body.tenantId === 'string' ? body.tenantId.trim() : ''

  if (!requestedTenantId && !platformWorkspace && workspaces.length > 1) {
    return NextResponse.json(
      {
        error: 'This email works at more than one pharmacy. Choose where you are signing in.',
        code: 'CHOOSE_WORKSPACE',
        chooseWorkspace: true,
        workspaces: workspaces.map(workspaceOption),
      },
      { status: 409 },
    )
  }

  const workspace = platformWorkspace ?? pickWorkspace(workspaces, requestedTenantId)
  if (!workspace) {
    return NextResponse.json(
      { error: 'This account has no access to that pharmacy.', code: 'NO_PHARMACY_ACCESS' },
      { status: 403 },
    )
  }

  // The platform workspace has no facility, so its settings (if any) are the
  // account's own row rather than a tenant-scoped one.
  const settingsQuery = db
    .from('pharmacy_user_settings')
    .select('pharmacy_role, two_factor_enabled, is_active')
    .eq('profile_id', profile.id)
  const { data: settings } = workspace.tenantId
    ? await settingsQuery.eq('tenant_id', workspace.tenantId).maybeSingle()
    : await settingsQuery.maybeSingle()

  // Password already proven, so naming the state does not enable enumeration.
  if (settings && (settings as { is_active?: boolean | null }).is_active === false) {
    return NextResponse.json(
      { error: 'This account has been deactivated. Contact your pharmacy administrator.', code: 'ACCOUNT_INACTIVE' },
      { status: 403 },
    )
  }

  const pharmacyRole = (settings?.pharmacy_role as string | null) ?? null
  const twoFactorEnabled = (settings?.two_factor_enabled as boolean | null) ?? null

  if (!roleRequiresLoginOtp(workspace.role, pharmacyRole, twoFactorEnabled)) {
    return issueSession(req, profile, email, workspace)
  }

  // Pharmacy admin (or opted-in staff): gate with email OTP as second factor
  try {
    const otp = await createAndSendOTP({ channel: 'email', target: email })
    await sendOTP({
      to: email,
      name: profile.full_name ?? email,
      otp,
      purpose: 'login',
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : ''
    if (msg === 'TOO_MANY_REQUESTS') {
      return NextResponse.json(
        { error: 'Too many verification requests. Please wait before trying again.' },
        { status: 429 },
      )
    }
    return NextResponse.json({ error: 'Failed to send verification code.' }, { status: 500 })
  }

  return NextResponse.json({
    otpSent: true,
    email,
    tenantId: workspace.tenantId,
    tenantName: workspace.name || workspace.slug,
  })
}
