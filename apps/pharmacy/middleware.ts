import { NextResponse, type NextRequest } from 'next/server'
import { verifyToken } from '@synapse/auth/tokens'
import {
  PHARM_MFA_SATISFIED_COOKIE,
  verifyPharmMfaSatisfiedToken,
} from '@synapse/auth/mfa'
import { SESSION_COOKIE } from '@synapse/config/constants'
import { decideMutationOrigin, hasAuthCookie } from '@synapse/auth/mutation-origin'
import { evaluateEntitlement } from '@synapse/auth/billing/entitlement'

type PharmacyProfile = {
  id: string
  is_admin: boolean | null
  tenant_id: string | null
  role: string | null
  must_change_password: boolean | null
  onboarding_complete: boolean | null
}

// True PLATFORM admins (superadmins) are not tenant-scoped and must never be
// caught by the per-tenant subscription gate. NOTE: profiles.is_admin is only a
// TENANT-level owner/admin flag (e.g. a pharmacy owner) — those users MUST still
// be locked out when their tenant is unpaid, since they are the ones who pay.
function isPlatformAdmin(role: string | null | undefined): boolean {
  return role === 'platform_admin' || role === 'superadmin'
}

type PharmacyUserSettings = {
  pharmacy_role: string | null
  two_factor_enabled: boolean | null
}

type TenantRow = {
  is_active: boolean | null
  facility_type: string | null
  onboarding_completed: boolean | null
}

type OnboardingRow = {
  current_step: number | null
  onboarding_completed_at: string | null
}

function stripBom(s: string): string {
  return s.charCodeAt(0) === 0xFEFF ? s.slice(1) : s
}

function serviceRoleHeaders(): Record<string, string> | null {
  const rawUrl = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? ''
  const rawKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? ''
  const supabaseUrl = stripBom(rawUrl).trim()
  const supabaseKey = stripBom(rawKey).trim()
  if (!supabaseUrl || !supabaseKey) return null
  return {
    apikey: supabaseKey,
    Authorization: `Bearer ${supabaseKey}`,
  }
}

async function sha256Hex(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value)
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
}

async function isSessionStored(token: string, userId: string): Promise<boolean> {
  const headers = serviceRoleHeaders()
  const supabaseUrl = stripBom((process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? '').trim())
  if (!headers || !supabaseUrl) return false

  try {
    const tokenHash = await sha256Hex(token)
    const sessionUrl = new URL(`${supabaseUrl}/rest/v1/synapse_sessions`)
    sessionUrl.searchParams.set('token_hash', `eq.${tokenHash}`)
    sessionUrl.searchParams.set('select', 'user_id,expires_at,revoked_at')
    sessionUrl.searchParams.set('limit', '1')

    const response = await fetch(sessionUrl, { headers, cache: 'no-store' })
    if (!response.ok) return false

    const [session] = (await response.json()) as {
      user_id?: string | null
      expires_at?: string | null
      revoked_at?: string | null
    }[]

    if (!session || session.user_id !== userId) return false
    if (session.revoked_at) return false
    if (!session.expires_at || new Date(session.expires_at) < new Date()) return false
    return true
  } catch {
    return false
  }
}

type SynapseSession = {
  userId: string
  /** The facility the token was minted for — not the profile's home facility. */
  tenantId: string
}

async function getSynapseSession(request: NextRequest): Promise<SynapseSession | null> {
  const token = request.cookies.get(SESSION_COOKIE)?.value
  if (!token) return null
  try {
    const payload = await verifyToken(token)
    const stored = await isSessionStored(token, payload.sub)
    if (!stored) return null
    return { userId: payload.sub, tenantId: (payload.tenant_id ?? '').trim() }
  } catch {
    return null
  }
}

async function restGet<T>(table: string, filters: Record<string, string>, select: string): Promise<T | null> {
  const headers = serviceRoleHeaders()
  const supabaseUrl = stripBom((process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL ?? '').trim())
  if (!headers || !supabaseUrl) return null

  const url = new URL(`${supabaseUrl}/rest/v1/${table}`)
  for (const [key, value] of Object.entries(filters)) {
    url.searchParams.set(key, value)
  }
  url.searchParams.set('select', select)
  url.searchParams.set('limit', '1')

  try {
    const response = await fetch(url, { headers, cache: 'no-store' })
    if (!response.ok) return null
    const [row] = (await response.json()) as T[]
    return row ?? null
  } catch {
    return null
  }
}

// ── Feature 1: module-level entitlement (subscription) gate ──────────────────
type SubscriptionRow = {
  status: string | null
  current_period_end: string | null
  grace_until: string | null
}

async function getTenantEntitlement(tenantId: string): Promise<{
  entitled: boolean
  status: string | null
  reason: string
}> {
  const sub = await restGet<SubscriptionRow>(
    'tenant_subscriptions',
    { tenant_id: `eq.${tenantId}` },
    'status,current_period_end,grace_until',
  )
  // restGet returns null on no-row OR on infra error; evaluateEntitlement
  // fails-open (entitled) for a null/blank status, so tenants are never locked
  // out by accident — only explicit non-entitled statuses block.
  return evaluateEntitlement({
    status: sub?.status ?? null,
    current_period_end: sub?.current_period_end ?? null,
    grace_until: sub?.grace_until ?? null,
  })
}

function isSubscriptionWriteBlocked(pathname: string, method: string): boolean {
  const m = method.toUpperCase()
  // Billing always allowed so tenants can recover.
  if (pathname.startsWith('/api/admin/billing') || pathname.startsWith('/portal/billing')) {
    return false
  }
  // Healthcare degradation: allow GET/HEAD on read/safety surfaces.
  const readSafePrefixes = [
    '/api/admin/transactions',
    '/api/admin/products',
    '/api/admin/inventory',
    '/api/admin/batches',
    '/api/admin/reports',
    '/api/admin/settings',
    '/api/admin/notifications',
    '/api/admin/activity',
    '/api/admin/audit',
    '/api/admin/dashboard',
    '/api/admin/customers',
  ]
  if (m === 'GET' || m === 'HEAD') {
    if (readSafePrefixes.some((p) => pathname === p || pathname.startsWith(p + '/'))) {
      return false
    }
  }
  // Portal page allowlist for unpaid tenants (read/safety + billing).
  const portalReadSafe = [
    '/portal/billing',
    '/portal/dashboard',
    '/portal/transactions',
    '/portal/products',
    '/portal/inventory',
    '/portal/reports',
    '/portal/customers',
    '/portal/notifications',
    '/portal/activity',
  ]
  if (!pathname.startsWith('/api/') && portalReadSafe.some((p) => pathname === p || pathname.startsWith(p + '/'))) {
    // Still block POS / refunds / users / settings mutation pages.
    if (
      pathname.startsWith('/portal/pos') ||
      pathname.startsWith('/portal/refunds') ||
      pathname.startsWith('/portal/users') ||
      pathname.startsWith('/portal/settings') ||
      pathname.startsWith('/portal/purchases')
    ) {
      return true
    }
    return false
  }
  return true
}

function subscriptionRequired402(status: string | null, reason: string): NextResponse {
  return NextResponse.json(
    {
      error: 'subscription_required',
      message:
        'Subscription inactive. Billing writes are blocked; historical records and safety reads remain available. Pay to restore full access.',
      status: status ?? 'unknown',
      reason,
      reactivate_url: '/portal/billing',
      mode: 'degraded_read',
    },
    { status: 402 },
  )
}

// ── Feature 2: custom domain → tenant resolution ─────────────────────────────
function isBaseHost(host: string): boolean {
  const h = (host.split(':')[0] ?? '').trim().toLowerCase()
  if (!h) return true
  if (h === 'localhost' || h === '127.0.0.1' || h === '0.0.0.0' || h === '::1') return true
  if (h.endsWith('.localhost')) return true
  if (h.endsWith('.vercel.app')) return true
  if (h === 'synapseos.tech' || h.endsWith('.synapseos.tech')) return true
  return false
}

async function resolveHostTenant(host: string): Promise<{ tenantId: string; domain: string } | null> {
  const h = (host.split(':')[0] ?? '').trim().toLowerCase()
  if (!h || isBaseHost(h)) return null
  const row = await restGet<{ tenant_id: string | null; domain: string }>(
    'pharmacy_custom_domains',
    { domain: `eq.${h}`, verified: 'eq.true' },
    'tenant_id,domain',
  )
  if (!row?.tenant_id) return null
  return { tenantId: row.tenant_id, domain: h }
}

function roleRequiresMfa(settings: PharmacyUserSettings | null): boolean {
  // Only gate on explicit opt-in, not role — role-based TOTP blocks first-time logins
  // where TOTP hasn't been set up yet (OTP already served as 2nd factor at login)
  return settings?.two_factor_enabled === true
}

async function pharmMfaSatisfied(request: NextRequest, userId: string): Promise<boolean> {
  const token = request.cookies.get(PHARM_MFA_SATISFIED_COOKIE)?.value
  if (!token) return false
  return verifyPharmMfaSatisfiedToken(token, userId)
}

async function runPharmacyAccessChecks(params: {
  request: NextRequest
  profile: PharmacyProfile
  tenantId: string
  pathname: string
  isPublicPath: boolean
  isMfaPage: boolean
}): Promise<NextResponse | null> {
  const { request, profile, tenantId, pathname, isPublicPath, isMfaPage } = params

  if (!tenantId && !profile.is_admin && !isPlatformAdmin(profile.role)) {
    return NextResponse.redirect(new URL('/login?error=no_pharmacy_access', request.url))
  }

  // Facility admins (is_admin) of hospital/laboratory tenants are not pharmacy staff;
  // only control-plane roles skip the pharmacy-tenant check.
  if (tenantId && !isPlatformAdmin(profile.role)) {
    const tenant = await restGet<TenantRow>(
      'tenants',
      { id: `eq.${tenantId}` },
      'is_active,facility_type'
    )

    if (!tenant || tenant.is_active === false || tenant.facility_type !== 'pharmacy') {
      return NextResponse.redirect(new URL('/login?error=account_inactive', request.url))
    }
  }

  const userSettings = await restGet<PharmacyUserSettings>(
    'pharmacy_user_settings',
    { profile_id: `eq.${profile.id}` },
    'pharmacy_role,two_factor_enabled'
  )

  const requiresMfa = roleRequiresMfa(userSettings)

  if (isMfaPage) {
    if (!requiresMfa) {
      return NextResponse.redirect(new URL('/portal/dashboard', request.url))
    }
    return null
  }

  if (!isPublicPath && requiresMfa) {
    const satisfied = await pharmMfaSatisfied(request, profile.id)
    if (!satisfied) {
      const url = new URL('/auth/2fa', request.url)
      url.searchParams.set('next', pathname)
      return NextResponse.redirect(url)
    }
  }

  // Force password change before any protected page is reachable.
  // isPublicPath already covers /change-password so this won't loop.
  if (!isPublicPath && profile.must_change_password) {
    return NextResponse.redirect(new URL('/change-password', request.url))
  }

  // Platform-provisioned pharmacies mark tenants.onboarding_completed=true and
  // profiles.onboarding_complete=true before first login. Do not force the
  // optional license/store wizard when provisioning already finished.
  if (!isPublicPath && tenantId && !profile.onboarding_complete) {
    const tenantOnboarding = await restGet<TenantRow>(
      'tenants',
      { id: `eq.${tenantId}` },
      'is_active,facility_type,onboarding_completed',
    )
    if (!tenantOnboarding?.onboarding_completed) {
      const onboarding = await restGet<OnboardingRow>(
        'pharmacy_onboarding',
        { tenant_id: `eq.${tenantId}` },
        'current_step,onboarding_completed_at',
      )

      const wizardIncomplete =
        !!onboarding &&
        !onboarding.onboarding_completed_at &&
        (onboarding.current_step ?? 0) < 5

      if (wizardIncomplete) {
        // Heal legacy platform-provisioned tenants that already have a store but
        // were left at current_step < 5 without onboarding_completed_at.
        const existingStore = await restGet<{ id: string }>(
          'pharmacy_stores',
          { tenant_id: `eq.${tenantId}` },
          'id',
        )
        if (!existingStore) {
          return NextResponse.redirect(new URL('/onboarding', request.url))
        }
      }
    }
  }

  return null
}

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl
  const originDecision = decideMutationOrigin({
    method: request.method,
    host: request.headers.get('host'),
    origin: request.headers.get('origin'),
    referer: request.headers.get('referer'),
    secFetchSite: request.headers.get('sec-fetch-site'),
    hasSessionCookie: hasAuthCookie(request.cookies.getAll().filter((c) => c.value).map((c) => c.name)),
  })
  if (!originDecision.allow) {
    return NextResponse.json({ error: 'cross_origin_mutation_blocked' }, { status: 403 })
  }

  // ── Feature 2: resolve a custom domain → tenant and forward it as headers.
  // Base/managed hosts are skipped (default behavior unchanged). We always strip
  // any inbound x-tenant-* headers so they can't be spoofed by the client.
  const host = request.headers.get('host') ?? ''
  const requestHeaders = new Headers(request.headers)
  requestHeaders.delete('x-tenant-id')
  requestHeaders.delete('x-tenant-domain')
  if (host && !isBaseHost(host)) {
    const resolved = await resolveHostTenant(host)
    if (resolved) {
      requestHeaders.set('x-tenant-id', resolved.tenantId)
      requestHeaders.set('x-tenant-domain', resolved.domain)
    }
  }
  const passThrough = () => NextResponse.next({ request: { headers: requestHeaders } })

  // API routes must never be HTML-redirected (POST → login/onboarding → 405).
  // Route handlers enforce auth and return JSON.
  if (pathname.startsWith('/api/')) {
    // Feature 1: the admin module is fully gated behind an active subscription.
    // Billing/auth/public/customer APIs stay reachable so a locked tenant can pay.
    if (pathname.startsWith('/api/admin/')) {
      const session = await getSynapseSession(request)
      if (session) {
        const profile = await restGet<PharmacyProfile>(
          'profiles',
          { id: `eq.${session.userId}` },
          'id,is_admin,tenant_id,role',
        )
        // Only true platform/superadmins bypass; tenant-scoped users (incl. the
        // pharmacy's own owner-admin) are gated when the subscription is unpaid.
        if (profile && session.tenantId && !isPlatformAdmin(profile.role)) {
          const ent = await getTenantEntitlement(session.tenantId)
          if (!ent.entitled && isSubscriptionWriteBlocked(pathname, request.method)) {
            return subscriptionRequired402(ent.status, ent.reason)
          }
        }
      }
      // No valid session → let the route handler return its own 401.
    }
    return passThrough()
  }

  const session = await getSynapseSession(request)
  const synapseValid = session !== null
  const isAuthenticated = synapseValid

  const isMarketingPage = pathname === '/' || pathname.startsWith('/register')
  const isAuthPage = pathname.startsWith('/login') || pathname.startsWith('/auth')
  const isPublicApi =
    pathname.startsWith('/api/public') ||
    pathname.startsWith('/api/auth/') ||
    pathname.startsWith('/api/customer/') ||
    pathname === '/api/auth/cloud-verify'
  const isMfaPage = pathname === '/auth/2fa'
  const isOnboardingPage = pathname.startsWith('/onboarding')
  const isInvitePage = pathname.startsWith('/invite')
  const isChangePasswordPage = pathname.startsWith('/change-password')
  const isForgotPasswordPage = pathname.startsWith('/forgot-password')
  const isResetPasswordPage = pathname.startsWith('/reset-password')

  const isPublicPath =
    isMarketingPage ||
    isAuthPage ||
    isPublicApi ||
    isInvitePage ||
    isOnboardingPage ||
    isChangePasswordPage ||
    isForgotPasswordPage ||
    isResetPasswordPage

  if (!isAuthenticated && !isPublicPath) {
    return NextResponse.redirect(new URL('/login', request.url))
  }

  if (synapseValid && session) {
    const profile = await restGet<PharmacyProfile>(
      'profiles',
      { id: `eq.${session.userId}` },
      'id,is_admin,tenant_id,role,must_change_password,onboarding_complete'
    )

    if (profile) {
      if (isAuthenticated && isAuthPage && !isMfaPage) {
        if (profile.must_change_password) {
          return NextResponse.redirect(new URL('/change-password', request.url))
        }
        return NextResponse.redirect(new URL('/portal/dashboard', request.url))
      }

      const redirect = await runPharmacyAccessChecks({
        request,
        profile,
        tenantId: session.tenantId,
        pathname,
        isPublicPath,
        isMfaPage,
      })
      if (redirect) return redirect

      // Healthcare degradation: unpaid tenants keep billing + read/safety portal pages.
      // Elective commercial writes (POS, refunds, purchasing, user admin) stay locked.
      const isPortalPath = pathname.startsWith('/portal')
      const isBillingPage = pathname.startsWith('/portal/billing')
      if (isPortalPath && !isBillingPage && session.tenantId && !isPlatformAdmin(profile.role)) {
        const ent = await getTenantEntitlement(session.tenantId)
        if (!ent.entitled && isSubscriptionWriteBlocked(pathname, request.method)) {
          const url = new URL('/portal/billing', request.url)
          url.searchParams.set('billing', 'past_due')
          url.searchParams.set('mode', 'degraded_read')
          return NextResponse.redirect(url)
        }
      }
    }
  }

  return passThrough()
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|.*\\.png$|.*\\.svg$|.*\\.ico$).*)'],
}
