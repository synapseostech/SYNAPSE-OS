// packages/auth/src/session-scope.ts
//
// The facility a session token is for, and the role to act there.
//
// Tokens are minted from `listProfileWorkspaces`, which reads both
// `staff_scope_assignments` and `pharmacy_user_settings`. Resolving a token must
// accept the same two sources, or a pharmacy-only workspace is minted and then
// refused on the first request.

import { supabaseAdmin } from '@synapse/db/admin'

type PgError = { message: string }

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ScopeClient = { from(table: string): any }
const scopeDb = supabaseAdmin as unknown as ScopeClient

/**
 * The role an active `staff_scope_assignments` row grants at `tenantId`, or null
 * when this account has no scope there. Fails closed: a read error is a denial.
 */
async function loadScopeRole(profileId: string, tenantId: string): Promise<string | null> {
  const { data, error } = (await scopeDb
    .from('staff_scope_assignments')
    .select('role')
    .eq('profile_id', profileId)
    .eq('tenant_id', tenantId)
    .eq('is_active', true)
    .order('created_at', { ascending: true })
    .limit(1)) as { data: Array<{ role?: string | null }> | null; error: PgError | null }
  if (error) return null
  const role = Array.isArray(data) && data.length > 0 ? data[0]?.role : null
  return typeof role === 'string' && role.trim() ? role.trim() : null
}

/**
 * The role an active `pharmacy_user_settings` row grants at `tenantId`, or null.
 * This is the source a pharmacy portal login is minted from when the person has
 * no facility scope row there.
 */
async function loadPharmacyRole(profileId: string, tenantId: string): Promise<string | null> {
  const { data, error } = (await scopeDb
    .from('pharmacy_user_settings')
    .select('pharmacy_role, is_active')
    .eq('profile_id', profileId)
    .eq('tenant_id', tenantId)
    .limit(1)) as {
    data: Array<{ pharmacy_role?: string | null; is_active?: boolean | null }> | null
    error: PgError | null
  }
  if (error) return null
  const row = Array.isArray(data) && data.length > 0 ? data[0] : null
  if (!row || row.is_active === false) return null
  const role = row.pharmacy_role
  return typeof role === 'string' && role.trim() ? role.trim() : null
}

/**
 * The facility this token is for, with the role to act in it. The profile's own
 * tenant and role are the home facility; a token minted for any other facility
 * must be backed by an active scope or pharmacy login there, otherwise the
 * session is refused.
 *
 * A token whose facility is the home one needs no read at all, which keeps the
 * common case free of extra round trips.
 */
export async function resolveSessionScope(
  profile: { id: string; role: string; tenant_id: string | null },
  tokenTenantId: string | null,
): Promise<{ tenantId: string; role: string } | null> {
  const homeTenantId = (profile.tenant_id ?? '').trim()
  const wanted = (tokenTenantId ?? '').trim()

  if (!wanted || wanted === homeTenantId) {
    return { tenantId: homeTenantId, role: profile.role }
  }

  const scopeRole = await loadScopeRole(profile.id, wanted)
  if (scopeRole) return { tenantId: wanted, role: scopeRole }

  const pharmacyRole = await loadPharmacyRole(profile.id, wanted)
  if (!pharmacyRole) return null
  return { tenantId: wanted, role: pharmacyRole }
}
