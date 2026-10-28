// packages/auth/src/context.server.ts
// NEXT.JS ONLY — server components and server actions

import { cookies } from 'next/headers'
import { redirect } from 'next/navigation'
import { verifyToken, type SynapseTokenPayload } from './tokens'
import { validateSession } from './sessions'
import { supabaseAdmin } from '@synapse/db/admin'
import { SESSION_COOKIE } from '@synapse/config/constants'
import type { AppSurface, SynapseRole } from '@synapse/config/constants'
import { isAccountActivated } from './activation'
import { assertSessionMatchesHost } from './tenant-guard.server'
import { resolveSessionScope } from './session-scope'

type PgError = { message: string }

/**
 * `platform_memberships` is not in the generated `Database` type, and the
 * generated `profiles` row omits `email_verified_at`. These describe only the
 * two reads below, so the cast stays narrower than `any`.
 */
type ProfileRow = {
  id: string
  email: string | null
  role: string
  full_name: string | null
  first_name: string | null
  last_name: string | null
  tenant_id: string | null
  synapse_id: string | null
  is_admin: boolean | null
  onboarding_complete: boolean
  verification_status: string
  avatar_url: string | null
  must_change_password: boolean
  email_verified_at: string | null
  is_deleted: boolean | null
}
type MembershipRow = { platform_role: string; status: string; expires_at: string | null }
type ProfileClient = {
  from: (table: "profiles") => {
    select: (columns: string) => {
      eq: (column: "id", value: string) => {
        single: () => PromiseLike<{ data: ProfileRow | null; error: PgError | null }>
      }
    }
  }
}
type MembershipClient = {
  from: (table: "platform_memberships") => {
    select: (columns: string) => {
      eq: (column: "user_id", value: string) => {
        in: (
          column: "status",
          values: string[],
        ) => PromiseLike<{ data: MembershipRow[] | null; error: PgError | null }>
      }
    }
  }
}
const profileDb = supabaseAdmin as unknown as ProfileClient
const membershipDb = supabaseAdmin as unknown as MembershipClient

export interface SynapseContext {
  user: {
    id: string
    email: string
    role: SynapseRole
    fullName: string | null
    firstName: string | null
    lastName: string | null
    tenantId: string
    synapseId: string | null
    avatarUrl: string | null
    isAdmin: boolean
    onboardingComplete: boolean
    verificationStatus: string | null
    mustChangePassword: boolean
  }
  tenant: {
    id: string
    name: string
    slug: string
    facilityType: string
    status: string
    plan: string
    modulesEnabled: string[]
    isNetworkMember: boolean
    onboardingCompleted: boolean
  }
  app: AppSurface
  sessionId: string
  token: string
  isImpersonation: boolean
  impersonatorId: string | null
}

export async function getContext(
  app: AppSurface = 'web',
  redirectTo = '/login'
): Promise<SynapseContext> {
  const cookieStore = await cookies()
  const token = cookieStore.get(SESSION_COOKIE)?.value

  if (!token) redirect(redirectTo)

  let payload: SynapseTokenPayload | undefined
  try {
    payload = await verifyToken(token)
  } catch {
    redirect(redirectTo)
  }
  if (!payload) redirect(redirectTo)

  const { valid, sessionId } = await validateSession(token)
  if (!valid) redirect(redirectTo)

  const tokenPayload = payload

  const { data: profile, error: profileError } = await profileDb
    .from('profiles')
    .select(`
      id, email, role, full_name, first_name, last_name,
      tenant_id, synapse_id, is_admin, onboarding_complete,
      verification_status, avatar_url, must_change_password,
      email_verified_at, is_deleted
    `)
    .eq('id', tokenPayload.sub)
    .single()

  if (profileError || !profile) redirect(redirectTo)

  // One membership read serves both the account-suspension marker (a SUSPENDED
  // platform_memberships row, see account-suspension.ts) and the platform scope below.
  const { data: membershipRows, error: membershipError } = await membershipDb
    .from('platform_memberships')
    .select('platform_role, status, expires_at')
    .eq('user_id', profile.id as string)
    .in('status', ['ACTIVE', 'SUSPENDED'])
  if (membershipError) redirect(redirectTo) // fail closed
  const memberships = (membershipRows ?? []) as Array<{ platform_role: string; status: string; expires_at: string | null }>
  const membershipSuspended = memberships.some((m) => m.status === 'SUSPENDED')

  if (!isAccountActivated({ ...profile, membership_suspended: membershipSuspended })) redirect(redirectTo)

  const sessionScope = await resolveSessionScope(
    { id: profile.id as string, role: profile.role as string, tenant_id: profile.tenant_id as string | null },
    tokenPayload.tenant_id ?? null,
  )
  if (!sessionScope) redirect(redirectTo)

  await assertSessionMatchesHost({
    role: sessionScope.role,
    sessionTenantId: sessionScope.tenantId || null,
  })

  const user = {
    id: profile.id as string,
    email: profile.email as string,
    role: sessionScope.role as SynapseRole,
    fullName: profile.full_name as string | null,
    firstName: profile.first_name as string | null,
    lastName: profile.last_name as string | null,
    tenantId: sessionScope.tenantId,
    synapseId: profile.synapse_id as string | null,
    avatarUrl: profile.avatar_url as string | null,
    isAdmin: (profile.is_admin as boolean) ?? false,
    onboardingComplete: (profile.onboarding_complete as boolean) ?? false,
    verificationStatus: profile.verification_status as string | null,
    mustChangePassword: (profile.must_change_password as boolean) ?? false,
  }

  const isImpersonation = tokenPayload.is_impersonation === true
  const impersonatorId = tokenPayload.impersonator_id ?? null

  // Platform admins and control-plane members are not scoped to a tenant
  const platformMembership = memberships.find((m) => m.status === 'ACTIVE') ?? null

  const platformMembershipActive =
    platformMembership &&
    (!platformMembership.expires_at || new Date(platformMembership.expires_at as string) > new Date())

  if (
    profile.role === 'platform_admin' ||
    profile.role === 'superadmin' ||
    profile.role === 'platform_observer' ||
    platformMembershipActive
  ) {
    return {
      user,
      tenant: {
        id: '',
        name: 'Synapse Platform',
        slug: 'platform',
        facilityType: 'platform',
        status: 'active',
        plan: 'platform',
        modulesEnabled: [] as string[],
        isNetworkMember: false,
        onboardingCompleted: true,
      },
      app,
      sessionId: sessionId as string,
      token,
      isImpersonation,
      impersonatorId,
    }
  }

  if (!sessionScope.tenantId) redirect(redirectTo)

  const { data: tenant, error: tenantError } = await supabaseAdmin
    .from('tenants')
    .select(`
      id, name, slug, facility_type, status, plan,
      modules_enabled, is_network_member, onboarding_completed
    `)
    .eq('id', sessionScope.tenantId)
    .single()

  if (tenantError || !tenant) redirect(redirectTo)

  const tenantRow = tenant

  return {
    user,
    tenant: {
      id: tenantRow.id as string,
      name: tenantRow.name as string,
      slug: tenantRow.slug as string,
      facilityType: tenantRow.facility_type as string,
      status: tenantRow.status as string,
      plan: tenantRow.plan as string,
      modulesEnabled: (tenantRow.modules_enabled as string[]) ?? [],
      isNetworkMember: (tenantRow.is_network_member as boolean) ?? false,
      onboardingCompleted: (tenantRow.onboarding_completed as boolean) ?? false,
    },
    app,
    sessionId: sessionId as string,
    token,
    isImpersonation,
    impersonatorId,
  }
}

export async function getContextSafe(app: AppSurface = 'web'): Promise<SynapseContext | null> {
  try {
    return await getContext(app, '__synapse_never_redirect__')
  } catch {
    return null
  }
}
