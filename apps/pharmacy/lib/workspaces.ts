import type { SynapseWorkspace } from '@synapse/auth'

/**
 * Workspaces the pharmacy portal can sign into. The middleware and
 * `isPharmacyAppContext` only accept a pharmacy facility (or the platform
 * workspace for control-plane staff), so anything else must not be offered here
 * — a workspace this portal then refuses would be an unreachable dead end.
 */
export function pharmacyWorkspaces(workspaces: SynapseWorkspace[]): SynapseWorkspace[] {
  return workspaces.filter(
    (workspace) => workspace.facilityType === 'pharmacy' || workspace.facilityType === 'platform',
  )
}

/** The facility-picker shape sent before a session exists. No roles or permissions. */
export function workspaceOption(workspace: SynapseWorkspace) {
  return {
    tenantId: workspace.tenantId,
    name: workspace.name || workspace.slug,
    slug: workspace.slug,
  }
}
