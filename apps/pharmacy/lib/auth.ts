import { redirect } from 'next/navigation'
import { getContext, getContextSafe, type SynapseContext } from '@synapse/auth/context'
import { supabaseAdmin } from '@synapse/db/admin'
import { sessionHasCapability } from '@/lib/capabilities'

export type PharmacySession = {
  userId: string
  email: string
  role: string
  /** profiles.role (role above is the pharmacy role when pharmacy_user_settings sets one). */
  profileRole: string
  tenantId: string
  /** tenants.facility_type of the session tenant ('platform' for control-plane users). */
  facilityType: string
  fullName: string | null
  firstName: string | null
  lastName: string | null
  isAdmin: boolean
  tenantName: string
  tenantSlug: string
  tenantStatus: string
  modulesEnabled: string[]
  mustChangePassword: boolean
  permissions: string[]
  pharmacyRole: string
  isImpersonation: boolean
  impersonatorId: string | null
  storeId: string | null
  profile: { tenant_id: string; is_admin: boolean; full_name: string | null; first_name: string | null; last_name: string | null }
  user: { id: string; email: string }
}

/**
 * Settings for the pharmacy this session is in. A profile may hold a row per
 * pharmacy tenant, so the tenant always scopes the read; without one (a
 * control-plane session) there are no settings to apply.
 */
async function loadPharmacySettings(userId: string, tenantId: string): Promise<{
  pharmacyRole: string | null
  permissions: string[]
  mustChangePassword: boolean | null
  storeId: string | null
  isActive: boolean
}> {
  if (!tenantId) {
    return { pharmacyRole: null, permissions: [], mustChangePassword: null, storeId: null, isActive: true }
  }
  try {
    const { data } = await (supabaseAdmin as any)
      .from('pharmacy_user_settings')
      .select('pharmacy_role, permissions, must_change_password, store_id, is_active')
      .eq('profile_id', userId)
      .eq('tenant_id', tenantId)
      .maybeSingle()

    return {
      pharmacyRole: (data?.pharmacy_role as string | null) ?? null,
      permissions: Array.isArray(data?.permissions) ? (data.permissions as string[]) : [],
      mustChangePassword: (data?.must_change_password as boolean | null) ?? null,
      storeId: (data?.store_id as string | null) ?? null,
      // Only an explicit false deactivates; users without a settings row (platform) stay active.
      isActive: data?.is_active !== false,
    }
  } catch {
    return { pharmacyRole: null, permissions: [], mustChangePassword: null, storeId: null, isActive: true }
  }
}

async function toPharmacySession(ctx: SynapseContext): Promise<PharmacySession | null> {
  const settings = await loadPharmacySettings(ctx.user.id, ctx.user.tenantId)
  // Deactivated staff are refused on every request, whichever login path minted the session.
  if (!settings.isActive) return null
  const pharmacyRole = settings.pharmacyRole ?? ctx.user.role
  const isAdmin =
    ctx.user.isAdmin ||
    pharmacyRole === 'pharmacy_admin' ||
    pharmacyRole === 'pharmacy_ceo' ||
    ctx.user.role === 'pharmacy_admin'

  return {
    userId: ctx.user.id,
    email: ctx.user.email,
    role: pharmacyRole,
    profileRole: ctx.user.role,
    tenantId: ctx.user.tenantId,
    facilityType: ctx.tenant.facilityType,
    fullName: ctx.user.fullName,
    firstName: ctx.user.firstName,
    lastName: ctx.user.lastName,
    isAdmin,
    tenantName: ctx.tenant.name,
    tenantSlug: ctx.tenant.slug,
    tenantStatus: ctx.tenant.status,
    modulesEnabled: ctx.tenant.modulesEnabled,
    mustChangePassword: settings.mustChangePassword ?? ctx.user.mustChangePassword,
    permissions: settings.permissions,
    pharmacyRole,
    isImpersonation: ctx.isImpersonation,
    impersonatorId: ctx.impersonatorId,
    storeId: settings.storeId,
    profile: {
      tenant_id: ctx.user.tenantId,
      is_admin: isAdmin,
      full_name: ctx.user.fullName,
      first_name: ctx.user.firstName,
      last_name: ctx.user.lastName,
    },
    user: { id: ctx.user.id, email: ctx.user.email },
  }
}

/**
 * The pharmacy app serves pharmacy tenants (and control-plane users, who have no
 * tenant). A hospital or laboratory account is not pharmacy staff even when its
 * profile role collides with a pharmacy role (e.g. a hospital 'pharmacist') or it
 * is its own facility's admin (is_admin): without this it would get pharmacy
 * capabilities over its own non-pharmacy tenant.
 */
export function isPharmacyAppContext(facilityType: string | null | undefined): boolean {
  return facilityType === 'pharmacy' || facilityType === 'platform'
}

export async function getPharmacySession(): Promise<PharmacySession | null> {
  const ctx = await getContextSafe('pharmacy')
  if (!ctx || !isPharmacyAppContext(ctx.tenant.facilityType)) return null
  return toPharmacySession(ctx)
}

export async function requirePharmacySession(): Promise<PharmacySession> {
  const ctx: SynapseContext = await getContext('pharmacy', '/login')
  if (!isPharmacyAppContext(ctx.tenant.facilityType)) redirect('/login?error=no_pharmacy_access')
  const session = await toPharmacySession(ctx)
  if (!session) redirect('/login?error=account_inactive')
  return session
}

export function hasPharmacyPermission(session: PharmacySession, permission: string): boolean {
  return sessionHasCapability(session, permission)
}

export const isPharmacyAdmin = (session: PharmacySession): boolean =>
  session.isAdmin ||
  session.pharmacyRole === 'pharmacy_admin' ||
  session.pharmacyRole === 'pharmacy_ceo'

export const hasPermission = (session: PharmacySession, permission: string): boolean =>
  hasPharmacyPermission(session, permission)
