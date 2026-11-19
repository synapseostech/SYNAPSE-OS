import { describe, expect, it } from 'vitest'
import {
  ADMIN_ROLES,
  MFA_MANDATORY_ROLES,
  PLATFORM_CAPABILITIES,
  PLATFORM_ROLES,
  ROLE_DESCRIPTIONS,
  STEP_UP_CAPABILITIES,
  canManageTargetRole,
  manageableRoles,
  roleCapabilities,
  roleHasCapability,
  type PlatformCapability,
} from './rbac'

const WRITE = (c: PlatformCapability) =>
  /\.(manage|invite|suspend|reactivate|revoke|password_reset|activate|override_price|purge|impersonate)$/.test(c) ||
  c === 'user.session.revoke'

describe('platform staff role model', () => {
  it('every role has a description and only known capabilities', () => {
    const known = new Set<string>(PLATFORM_CAPABILITIES)
    for (const role of PLATFORM_ROLES) {
      expect(ROLE_DESCRIPTIONS[role], role).toBeTruthy()
      for (const cap of roleCapabilities(role)) expect(known.has(cap), `${role} ${cap}`).toBe(true)
    }
  })

  it('the read-only auditor sees tenants, audit, finance, security and health, and can change nothing', () => {
    for (const cap of ['tenant.read', 'audit.read', 'finance_summary.read', 'security_summary.read', 'system_health.read', 'user.read'] as const) {
      expect(roleHasCapability('AUDITOR', cap), cap).toBe(true)
    }
    expect(roleCapabilities('AUDITOR').filter(WRITE)).toEqual([])
  })

  it('operations runs tenants but not pricing, roles, flags or purges', () => {
    for (const cap of ['tenant.read', 'tenant.manage', 'tenant.impersonate', 'user.invite', 'user.suspend', 'incident.manage'] as const) {
      expect(roleHasCapability('OPERATIONS_ADMIN', cap), cap).toBe(true)
    }
    for (const cap of ['tenant.purge', 'user.role.manage', 'platform.pricing.manage', 'feature_flag.manage', 'platform.subscriptions.activate'] as const) {
      expect(roleHasCapability('OPERATIONS_ADMIN', cap), cap).toBe(false)
    }
    // It can invite facility staff but grant no platform role.
    expect(manageableRoles('OPERATIONS_ADMIN')).toEqual([])
  })

  it('support can look up tenants but not change them', () => {
    expect(roleHasCapability('SUPPORT_ADMIN', 'tenant.read')).toBe(true)
    expect(roleHasCapability('SUPPORT_ADMIN', 'tenant.manage')).toBe(false)
    expect(roleHasCapability('SUPPORT_ADMIN', 'tenant.impersonate')).toBe(false)
  })

  it('finance manages pricing and activation, reads tenants, and cannot suspend them', () => {
    expect(roleHasCapability('FINANCE_ADMIN', 'platform.pricing.manage')).toBe(true)
    expect(roleHasCapability('FINANCE_ADMIN', 'platform.subscriptions.activate')).toBe(true)
    expect(roleHasCapability('FINANCE_ADMIN', 'tenant.read')).toBe(true)
    expect(roleHasCapability('FINANCE_ADMIN', 'tenant.manage')).toBe(false)
  })

  it('only a Super admin can permanently delete a tenant', () => {
    expect(PLATFORM_ROLES.filter((r) => roleHasCapability(r, 'tenant.purge'))).toEqual(['SUPER_ADMIN'])
  })

  it('observers hold no tenant data or write capability', () => {
    for (const role of ['STAKEHOLDER', 'BOARD_OBSERVER', 'INVESTOR_OBSERVER', 'READ_ONLY_OBSERVER'] as const) {
      expect(roleHasCapability(role, 'tenant.read'), role).toBe(false)
      expect(roleHasCapability(role, 'user.read'), role).toBe(false)
      expect(roleCapabilities(role).filter(WRITE), role).toEqual([])
    }
  })

  it('every role that can impersonate, purge or reassign roles must enrol MFA', () => {
    for (const role of PLATFORM_ROLES) {
      if (STEP_UP_CAPABILITIES.some((c) => roleHasCapability(role, c))) {
        expect(MFA_MANDATORY_ROLES, role).toContain(role)
      }
    }
  })

  it('Platform admins manage every role except Super admin, including Operations', () => {
    expect(canManageTargetRole('PLATFORM_ADMIN', 'OPERATIONS_ADMIN')).toBe(true)
    expect(canManageTargetRole('PLATFORM_ADMIN', 'SUPER_ADMIN')).toBe(false)
    expect(ADMIN_ROLES).toContain('OPERATIONS_ADMIN')
  })
})
