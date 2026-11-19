/**
 * Server-action tests for the staff screen (/platform/access) and the tenant
 * control centre (/platform/tenants/[id]): the capability each needs, the
 * authenticator step-up on sensitive staff changes, and the audit record.
 * Capabilities come from the real rbac.ts; the session, step-up proof and
 * database are faked.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const m = vi.hoisted(() => ({
  role: 'PLATFORM_ADMIN' as string,
  stepUp: false,
  rows: {} as Record<string, Record<string, unknown> | null>,
  writes: [] as Array<{ table: string; op: string; values: unknown }>,
  events: [] as Array<{ action: string; tenantId?: string | null; metadata?: Record<string, unknown> }>,
}))

const { fakeAuth, fakeDb } = vi.hoisted(() => ({
  fakeAuth: async () => {
    const rbac = await vi.importActual<typeof import('../../lib/platform/rbac')>('../../lib/platform/rbac')
    return {
      requirePlatformAccess: async (cap?: string) => {
        if (cap && !rbac.roleHasCapability(m.role as never, cap as never)) throw new Error(`NEXT_REDIRECT forbidden ${cap}`)
        return { id: 'actor-1', sessionId: 'sess-1', email: 'a@p.test', platformRole: m.role }
      },
    }
  },
  fakeDb: () => {
    const chain = (table: string): any => {
      const q: any = new Proxy(
        {},
        {
          get(_t, prop) {
            if (prop === 'then') return (resolve: (v: unknown) => void) => resolve({ data: [], error: null })
            if (prop === 'maybeSingle' || prop === 'single') return async () => ({ data: m.rows[table] ?? null, error: null })
            if (prop === 'update' || prop === 'insert' || prop === 'upsert' || prop === 'delete') {
              return (values: unknown) => {
                m.writes.push({ table, op: String(prop), values })
                return q
              }
            }
            return () => q
          },
        },
      )
      return q
    }
    return { from: (t: string) => chain(t) }
  },
}))

vi.mock('@/lib/platform/auth', fakeAuth)
vi.mock('../../lib/platform/auth', fakeAuth)
vi.mock('@/lib/platform/step-up', () => ({
  stepUpResult: async () => (m.stepUp ? null : { ok: false, code: 'MFA_STEP_UP_REQUIRED', error: 'step up' }),
}))
vi.mock('@synapse/db/admin', () => ({ supabaseAdmin: fakeDb() }))
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))
vi.mock('@synapse/auth', () => ({ hashPassword: vi.fn(), revokeAllUserSessions: vi.fn(async () => undefined), validatePasswordStrength: vi.fn() }))
vi.mock('@synapse/auth/account-suspension', () => ({ isAccountSuspensionMarker: () => false }))
vi.mock('@/lib/platform/access-audit', () => ({
  logPlatformAccessEvent: vi.fn(async (e: { action: string }) => (m.events.push({ action: e.action }), 'corr')),
}))
vi.mock('@/lib/auth/password-reset.server', () => ({ sendUserPasswordReset: vi.fn() }))
vi.mock('@/lib/platform/access-email', () => ({ sendPlatformInviteEmail: vi.fn(), sendPlatformRoleChangedEmail: vi.fn(async () => undefined) }))
vi.mock('@/lib/platform/rbac', () => vi.importActual('../../lib/platform/rbac'))
vi.mock('@/lib/platform/membership.server', async () => {
  const rbac = await vi.importActual<typeof import('../../lib/platform/rbac')>('../../lib/platform/rbac')
  return {
    assertCanManageRole: (actor: never, target: never) => {
      if (!rbac.canManageTargetRole(actor, target)) throw new Error(`Not authorized to manage role ${target}.`)
    },
    validatePlatformRole: (v: string) => {
      if (!rbac.isPlatformRole(v)) throw new Error('bad role')
      return v
    },
    platformRoleRequiresMfa: (r: never) => rbac.MFA_MANDATORY_ROLES.includes(r),
    getPlatformMember: async (userId: string) => ({
      id: 'mem-1',
      userId,
      platformRole: 'READ_ONLY_OBSERVER',
      status: 'ACTIVE',
      mfaRequired: false,
      profile: { email: 't@p.test', fullName: 'Target' },
    }),
    generateInviteToken: () => 'tok',
    hashInviteToken: () => 'hash',
    listPlatformMembers: async () => [],
  }
})
// Tenant actions
vi.mock('resend', () => ({ Resend: class { emails = { send: async () => ({ error: null }) } } }))
vi.mock('@synapse/db/facility-provision', () => ({ facilityInviteUrl: () => 'https://x/invite' }))
vi.mock('../../lib/platform/facility-invitations.server', () => ({
  createFacilityInvitation: vi.fn(async () => ({ ok: true, invitationId: 'inv-2', token: 't', email: 's@t.test', tenantName: 'T', expiresAt: 'x' })),
  markFacilityInvitationDeliveryFailed: vi.fn(),
  markFacilityInvitationSent: vi.fn(),
}))
vi.mock('../../lib/resend', () => ({ sendHospitalStaffInviteEmail: vi.fn(async () => undefined) }))
vi.mock('./_lib/platform-data', () => ({
  logPlatformEvent: vi.fn(async (e: { action: string; tenantId?: string | null; metadata?: Record<string, unknown> }) => {
    m.events.push(e)
  }),
}))

const fd = (fields: Record<string, string>) => {
  const f = new FormData()
  for (const [k, v] of Object.entries(fields)) f.set(k, v)
  return f
}

beforeEach(() => {
  m.role = 'PLATFORM_ADMIN'
  m.stepUp = false
  m.rows = {}
  m.writes = []
  m.events = []
})

describe('staff screen actions', () => {
  it('changing a role needs a fresh authenticator code and writes nothing without it', async () => {
    const { changePlatformMemberRole } = await import('./access/actions')
    const r = await changePlatformMemberRole(fd({ user_id: 'u-2', platform_role: 'OPERATIONS_ADMIN', reason: 'promoted' }))
    expect(r).toMatchObject({ ok: false, code: 'MFA_STEP_UP_REQUIRED' })
    expect(m.writes).toEqual([])
  })

  it('with the step-up a Platform admin can make someone Operations; MFA becomes mandatory and it is audited', async () => {
    m.stepUp = true
    const { changePlatformMemberRole } = await import('./access/actions')
    const r = await changePlatformMemberRole(fd({ user_id: 'u-2', platform_role: 'OPERATIONS_ADMIN', reason: 'promoted' }))
    expect(r).toEqual({ ok: true })
    expect(m.writes).toEqual([
      expect.objectContaining({ table: 'platform_memberships', op: 'update', values: expect.objectContaining({ platform_role: 'OPERATIONS_ADMIN', mfa_required: true }) }),
    ])
    expect(m.events.map((e) => e.action)).toContain('PLATFORM_MEMBER_ROLE_CHANGED')
  })

  it('a Platform admin cannot grant Super admin even with the step-up', async () => {
    m.stepUp = true
    const { changePlatformMemberRole } = await import('./access/actions')
    await expect(changePlatformMemberRole(fd({ user_id: 'u-2', platform_role: 'SUPER_ADMIN', reason: 'x' }))).rejects.toThrow(/SUPER_ADMIN/)
    expect(m.writes).toEqual([])
  })

  it.each(['OPERATIONS_ADMIN', 'SUPPORT_ADMIN', 'AUDITOR', 'SECURITY_ADMIN'])('%s cannot change roles at all', async (role) => {
    m.role = role
    m.stepUp = true
    const { changePlatformMemberRole } = await import('./access/actions')
    await expect(changePlatformMemberRole(fd({ user_id: 'u-2', platform_role: 'AUDITOR', reason: 'x' }))).rejects.toThrow(/forbidden user.role.manage/)
  })

  it('revoking a membership and resetting MFA also need the step-up', async () => {
    const { revokePlatformMembership, resetPlatformMemberMfa } = await import('./access/actions')
    expect(await revokePlatformMembership(fd({ user_id: 'u-2', reason: 'left' }))).toMatchObject({ code: 'MFA_STEP_UP_REQUIRED' })
    expect(await resetPlatformMemberMfa(fd({ user_id: 'u-2', reason: 'lost phone' }))).toMatchObject({ code: 'MFA_STEP_UP_REQUIRED' })
    expect(m.writes).toEqual([])
  })

  it('inviting someone into an admin-grade role needs the step-up', async () => {
    const { invitePlatformMember } = await import('./access/actions')
    const r = await invitePlatformMember(fd({ email: 'new@p.test', full_name: 'New Person', platform_role: 'OPERATIONS_ADMIN' }))
    expect(r).toMatchObject({ code: 'MFA_STEP_UP_REQUIRED' })
    expect(m.writes).toEqual([])
  })
})

describe('tenant control actions', () => {
  const tenantId = '00000000-0000-4000-8000-000000000001'

  it('reset onboarding needs tenant.manage', async () => {
    const { resetTenantOnboarding } = await import('./tenants/[id]/actions')
    for (const role of ['SUPPORT_ADMIN', 'AUDITOR', 'FINANCE_ADMIN']) {
      m.role = role
      await expect(resetTenantOnboarding(tenantId, 'x'), role).rejects.toThrow(/forbidden tenant.manage/)
    }
    expect(m.writes).toEqual([])
  })

  it('reset onboarding needs a reason, then reopens the wizard and records it in the tenant audit trail', async () => {
    m.role = 'OPERATIONS_ADMIN'
    m.rows.tenants = { onboarding_completed: true, onboarding_step: 6, facility_type: 'pharmacy' }
    const { resetTenantOnboarding } = await import('./tenants/[id]/actions')
    expect(await resetTenantOnboarding(tenantId, '  ')).toEqual({ ok: false, error: 'A reason is required.' })
    expect(m.writes).toEqual([])

    const r = await resetTenantOnboarding(tenantId, 'owner asked to redo setup')
    expect(r.ok).toBe(true)
    expect(m.writes.map((w) => w.table)).toEqual(['tenants', 'pharmacy_onboarding'])
    expect(m.writes[0]!.values).toMatchObject({ onboarding_completed: false, onboarding_step: 0 })
    expect(m.events).toEqual([
      expect.objectContaining({ action: 'TENANT_ONBOARDING_RESET', tenantId, metadata: expect.objectContaining({ reason: 'owner asked to redo setup' }) }),
    ])
  })

  it('resending a facility invitation needs user.invite, revokes the old token and is audited', async () => {
    const { resendFacilityInvitation } = await import('./tenants/[id]/actions')
    m.role = 'AUDITOR'
    await expect(resendFacilityInvitation(tenantId, 'inv-1')).rejects.toThrow(/forbidden user.invite/)

    m.role = 'OPERATIONS_ADMIN'
    m.rows.facility_invitations = { id: 'inv-1', tenant_id: tenantId, email: 's@t.test', full_name: 'S', role: 'lab_scientist', status: 'EXPIRED' }
    m.rows.tenants = { slug: 'lab', facility_type: 'laboratory' }
    const r = await resendFacilityInvitation(tenantId, 'inv-1')
    expect(r.ok).toBe(true)
    expect(m.writes[0]).toMatchObject({ table: 'facility_invitations', op: 'update', values: expect.objectContaining({ status: 'REVOKED' }) })
    expect(m.events.map((e) => e.action)).toEqual(['TENANT_INVITE_RESENT'])
  })

  it('resending a pharmacy onboarding invite needs tenant.manage', async () => {
    const { resendPharmacyInvite } = await import('./tenants/[id]/actions')
    m.role = 'SUPPORT_ADMIN'
    await expect(resendPharmacyInvite(tenantId)).rejects.toThrow(/forbidden tenant.manage/)
  })
})
