// packages/auth/src/workspaces.ts
//
// One Synapse identity, more than one place to work.
//
// `profiles` holds one row per email, and `profiles.tenant_id` is that account's
// home facility. Every other facility a person may enter is already expressed in
// existing tables: `staff_scope_assignments` for facility roles and
// `pharmacy_user_settings` for a pharmacy portal login (one row per tenant).
// This module merges them into the workspaces a login may mint a token for, so
// the token's tenant and role describe the facility being entered rather than
// the one the profile row happens to point at.

import { supabaseAdmin } from '@synapse/db/admin'

export type SynapseWorkspace = {
  tenantId: string
  name: string
  slug: string
  facilityType: string
  /** Role to write on a token for this facility. */
  role: string
  /** Set only where the person also has a pharmacy portal login here. */
  pharmacyRole: string | null
  permissions: string[]
  storeId: string | null
  isHome: boolean
}

/** The part of an active `staff_scope_assignments` row this module reads. */
export type WorkspaceScope = {
  tenant_id: string | null
  role: string | null
}

/** The part of a `pharmacy_user_settings` row this module reads. */
export type WorkspacePharmacySettings = {
  tenant_id: string | null
  pharmacy_role: string | null
  permissions: string[] | null
  store_id: string | null
  is_active?: boolean | null
}

export type WorkspaceTenant = {
  id: string
  name: string | null
  slug: string | null
  facility_type: string | null
}

export type WorkspaceSources = {
  homeTenantId: string | null
  homeRole: string | null
  scopes: WorkspaceScope[]
  pharmacy: WorkspacePharmacySettings[]
  tenants: WorkspaceTenant[]
}

export type WorkspaceProfile = {
  id: string
  tenant_id?: string | null
  role?: string | null
}

/**
 * Every tenant mentioned by any source, home first, de-duplicated. Exported for
 * the tenant-name lookup; `mergeWorkspaces` uses the same order.
 */
export function workspaceTenantIds(
  sources: Pick<WorkspaceSources, 'homeTenantId' | 'scopes' | 'pharmacy'>,
): string[] {
  const ids: string[] = []
  const seen = new Set<string>()
  const add = (value: string | null | undefined) => {
    const tenantId = (value ?? '').trim()
    if (!tenantId || seen.has(tenantId)) return
    seen.add(tenantId)
    ids.push(tenantId)
  }

  add(sources.homeTenantId)
  for (const scope of sources.scopes) add(scope.tenant_id)
  for (const row of sources.pharmacy) {
    if (row.is_active === false) continue
    add(row.tenant_id)
  }
  return ids
}

/**
 * Pure merge. A tenant is offered only when it can be described (a `tenants`
 * row was read), because a workspace with no facility type cannot be routed or
 * authorized. The role is the identity's own role at its home facility, and the
 * first active scope role (or the pharmacy role) everywhere else.
 */
export function mergeWorkspaces(sources: WorkspaceSources): SynapseWorkspace[] {
  const tenantsById = new Map<string, WorkspaceTenant>()
  for (const tenant of sources.tenants) tenantsById.set(tenant.id, tenant)

  const scopeRoles = new Map<string, string>()
  for (const scope of sources.scopes) {
    const tenantId = (scope.tenant_id ?? '').trim()
    const role = (scope.role ?? '').trim()
    if (!tenantId || !role || scopeRoles.has(tenantId)) continue
    scopeRoles.set(tenantId, role)
  }

  const pharmacyByTenant = new Map<string, WorkspacePharmacySettings>()
  for (const row of sources.pharmacy) {
    const tenantId = (row.tenant_id ?? '').trim()
    if (!tenantId || row.is_active === false || pharmacyByTenant.has(tenantId)) continue
    pharmacyByTenant.set(tenantId, row)
  }

  const homeTenantId = (sources.homeTenantId ?? '').trim()
  const homeRole = (sources.homeRole ?? '').trim()

  const workspaces: SynapseWorkspace[] = []
  for (const tenantId of workspaceTenantIds(sources)) {
    const tenant = tenantsById.get(tenantId)
    if (!tenant) continue

    const settings = pharmacyByTenant.get(tenantId) ?? null
    const pharmacyRole = (settings?.pharmacy_role ?? '').trim() || null
    const scopeRole = scopeRoles.get(tenantId) ?? ''
    const isHome = tenantId === homeTenantId

    workspaces.push({
      tenantId,
      name: (tenant.name ?? '').trim(),
      slug: (tenant.slug ?? '').trim(),
      facilityType: (tenant.facility_type ?? '').trim(),
      role: isHome ? homeRole || scopeRole || pharmacyRole || '' : scopeRole || pharmacyRole || '',
      pharmacyRole,
      permissions: settings?.permissions ?? [],
      storeId: settings?.store_id ?? null,
      isHome,
    })
  }

  return workspaces.sort(
    (a, b) =>
      Number(b.isHome) - Number(a.isHome) ||
      (a.name || a.slug).localeCompare(b.name || b.slug) ||
      a.tenantId.localeCompare(b.tenantId),
  )
}

/**
 * The workspace a request is for. An explicit tenant must match exactly.
 * Without one, the home facility is used; a person with no home and more than
 * one facility must choose, so this returns null rather than guessing.
 */
export function pickWorkspace(
  workspaces: SynapseWorkspace[],
  tenantId?: string | null,
): SynapseWorkspace | null {
  const wanted = (tenantId ?? '').trim()
  if (wanted) return workspaces.find((workspace) => workspace.tenantId === wanted) ?? null

  const home = workspaces.find((workspace) => workspace.isHome)
  if (home) return home
  return workspaces.length === 1 ? (workspaces[0] ?? null) : null
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = { from(table: string): any }

/**
 * Reads the workspaces for one identity. A failed scope or pharmacy read only
 * narrows the list — the other source and the home facility still stand — so a
 * transient error cannot widen anyone's access.
 */
export async function listProfileWorkspaces(
  profile: WorkspaceProfile,
  db: Db = supabaseAdmin as unknown as Db,
): Promise<SynapseWorkspace[]> {
  if (!profile?.id) return []

  const [scopeResult, pharmacyResult] = await Promise.all([
    db
      .from('staff_scope_assignments')
      .select('tenant_id, role')
      .eq('profile_id', profile.id)
      .eq('is_active', true)
      .order('created_at', { ascending: true }),
    db
      .from('pharmacy_user_settings')
      .select('tenant_id, pharmacy_role, permissions, store_id, is_active')
      .eq('profile_id', profile.id),
  ])

  const sources: WorkspaceSources = {
    homeTenantId: profile.tenant_id ?? null,
    homeRole: profile.role ?? null,
    scopes: scopeResult.error ? [] : ((scopeResult.data ?? []) as WorkspaceScope[]),
    pharmacy: pharmacyResult.error ? [] : ((pharmacyResult.data ?? []) as WorkspacePharmacySettings[]),
    tenants: [],
  }

  const tenantIds = workspaceTenantIds(sources)
  if (tenantIds.length === 0) return []

  const { data, error } = await db
    .from('tenants')
    .select('id, name, slug, facility_type')
    .in('id', tenantIds)
  // Without the tenant rows there is nothing to describe, and an undescribed
  // workspace is not one a session may be minted for.
  if (error) return []

  return mergeWorkspaces({ ...sources, tenants: (data ?? []) as WorkspaceTenant[] })
}
