/**
 * Subscription suspend/reactivate/extend require platform.subscription.manage,
 * checked through the real auth stack (JWT, synapse_sessions, platform membership,
 * RBAC). Previously any platform role, including READ_ONLY_OBSERVER, passed.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const env = vi.hoisted(() => {
  process.env.SYNAPSE_JWT_SECRET = 'synthetic-test-secret-for-subscription-authz-0123456789'
  process.env.ADMIN_EMAILS = ''
  return { token: null as string | null }
})
const state = vi.hoisted(() => ({ db: null as any }))

vi.mock('next/headers', () => ({
  cookies: async () => ({ get: (name: string) => (env.token && name ? { name, value: env.token } : undefined) }),
  headers: async () => new Headers(),
}))
vi.mock('next/navigation', () => ({
  redirect: (url: string) => { throw new Error(`NEXT_REDIRECT ${url}`) },
  notFound: () => { throw new Error('NEXT_NOT_FOUND') },
}))
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))
vi.mock('@synapse/db/admin', () => ({ supabaseAdmin: { from: (t: string) => state.db.from(t), rpc: async () => ({ data: null, error: null }) } }))
vi.mock('../../../lib/supabase/server', () => ({
  createServiceClient: () => ({ from: (t: string) => state.db.from(t) }),
  createClient: async () => ({ from: (t: string) => state.db.from(t) }),
}))

import { signToken } from '@synapse/auth/tokens'
import { hashToken } from '@synapse/auth'
import { createMemoryDb } from '../../../test-utils/memory-postgrest'
import {
  extendSubscriptionPeriod,
  reactivateSubscription,
  reassignSubscriptionPlan,
  suspendSubscription,
} from './subscription-actions'

const NOW = new Date().toISOString()
const FUTURE = new Date(Date.now() + 3600_000).toISOString()
const ACTOR = '00000000-0000-4000-8000-0000000000b1'
const TENANT = '00000000-0000-4000-8000-0000000000f1'
const PLAN_LEGACY = '00000000-0000-4000-8000-0000000000a1'
const PLAN_OS = '00000000-0000-4000-8000-0000000000a2'
const PLAN_INACTIVE = '00000000-0000-4000-8000-0000000000a3'

async function signInWith(platformRole: string) {
  const profile = {
    id: ACTOR, email: 'op@synthetic.synapse.test', full_name: 'Synthetic Operator',
    role: platformRole === 'PLATFORM_ADMIN' ? 'platform_admin' : 'staff', tenant_id: null,
    verification_status: 'verified', email_verified_at: NOW, is_deleted: false, must_change_password: false, created_at: NOW,
  }
  state.db = createMemoryDb({
    profiles: [profile],
    platform_memberships: [{ id: 'm1', user_id: ACTOR, platform_role: platformRole, status: 'ACTIVE', expires_at: null, mfa_required: false, password_change_required: false, metadata: {} }],
    mfa_enrollments: [],
    synapse_sessions: [],
    audit_log: [],
    subscription_plans: [
      { id: PLAN_LEGACY, slug: 'hospital_starter', name: 'Hospital Starter', is_active: true },
      { id: PLAN_OS, slug: 'synapse_os_basic_annual', name: 'OS Basic', is_active: true },
      { id: PLAN_INACTIVE, slug: 'hospital_professional', name: 'Hospital Professional', is_active: false },
    ],
    tenant_subscriptions: [{ id: 'sub1', tenant_id: TENANT, plan_id: PLAN_LEGACY, status: 'active', current_period_start: NOW, current_period_end: FUTURE, grace_until: null }],
  })
  const token = await signToken({ sub: ACTOR, email: profile.email, role: profile.role, tenant_id: '', app: 'web' })
  state.db.tables.synapse_sessions.push({ id: 's1', user_id: ACTOR, token_hash: hashToken(token), expires_at: FUTURE, revoked_at: null })
  env.token = token
}

function form() {
  const fd = new FormData()
  fd.set('tenantId', TENANT)
  fd.set('days', '30')
  fd.set('planId', PLAN_OS)
  return fd
}
const sub = () => state.db.tables.tenant_subscriptions[0]
const subWrites = () => state.db.log.filter((l: any) => l.table === 'tenant_subscriptions' && l.op === 'update')

describe('subscription actions authorization', () => {
  beforeEach(() => { env.token = null })

  it.each(['READ_ONLY_OBSERVER', 'SUPPORT_ADMIN', 'FINANCE_ADMIN', 'AUDITOR'])('%s cannot suspend, reactivate, extend or reassign', async (role) => {
    await signInWith(role)
    for (const action of [suspendSubscription, reactivateSubscription, extendSubscriptionPeriod, reassignSubscriptionPlan]) {
      await expect(action(form())).rejects.toThrow(/NEXT_REDIRECT \/platform\?error=forbidden/)
    }
    expect(subWrites()).toEqual([])
    expect(sub().status).toBe('active')
    expect(sub().plan_id).toBe(PLAN_LEGACY)
  })

  it('PLATFORM_ADMIN can suspend and reactivate, with audit', async () => {
    await signInWith('PLATFORM_ADMIN')
    await suspendSubscription(form())
    expect(sub().status).toBe('suspended')
    await reactivateSubscription(form())
    expect(sub().status).toBe('active')
    expect(state.db.tables.audit_log.map((a: any) => a.action)).toEqual(expect.arrayContaining(['subscription.suspended', 'subscription.reactivated']))
  })

  it('PLATFORM_ADMIN can move a tenant off a legacy plan, with audit, without touching status', async () => {
    await signInWith('PLATFORM_ADMIN')
    await reassignSubscriptionPlan(form())

    expect(sub().plan_id).toBe(PLAN_OS)
    expect(sub().status).toBe('active')

    const entry = state.db.tables.audit_log.find((a: any) => a.action === 'subscription.plan_changed')
    expect(entry?.old_value).toMatchObject({ plan_id: PLAN_LEGACY })
    expect(entry?.new_value).toMatchObject({ plan_id: PLAN_OS, plan_slug: 'synapse_os_basic_annual' })
  })

  it('refuses an inactive plan and writes nothing', async () => {
    await signInWith('PLATFORM_ADMIN')
    const fd = form()
    fd.set('planId', PLAN_INACTIVE)
    await reassignSubscriptionPlan(fd)

    expect(sub().plan_id).toBe(PLAN_LEGACY)
    expect(subWrites()).toEqual([])
  })
})
