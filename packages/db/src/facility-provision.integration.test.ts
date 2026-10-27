import { describe, it, expect } from 'vitest'
import { provisionFacility, resumeFacilityProvision } from './facility-provision'
import { hashFacilityInviteToken } from './facility-invite-token'

type Row = Record<string, unknown>
type FakeResult = { data: unknown; error: { message: string } | null }
type FakeQuery = {
  select: () => FakeQuery
  eq: (column: string, value: unknown) => FakeQuery
  in: (column: string, values: unknown[]) => FakeQuery
  order: () => FakeQuery
  limit: (count: number) => FakeQuery
  maybeSingle: () => FakeQuery
  single: () => FakeQuery
  insert: (values: unknown) => FakeQuery
  update: (values: unknown) => FakeQuery
  upsert: (values: unknown, options?: { onConflict?: string }) => FakeQuery
  then: (resolve: (value: FakeResult) => void) => Promise<void>
}

// In-memory PostgREST adapter: exercises the real orchestration and persisted effects.
function database() {
  const tables: Record<string, Row[]> = {
    subscription_plans: [
      { id: 'os-basic', slug: 'synapse_os_basic_annual', facility_type: 'hospital', is_active: true },
      { id: 'os-lab', slug: 'synapse_os_lab_addon_annual', facility_type: 'hospital', is_active: true },
      { id: 'lab-annual', slug: 'synapse_lab_annual', facility_type: 'laboratory', is_active: true },
      { id: 'enterprise', slug: 'synapse_enterprise', facility_type: 'hospital', is_active: true },
      { id: 'pharm-annual', slug: 'synapse_pharmacy_annual', facility_type: 'pharmacy', is_active: true },
      // Empty legacy shells. Provisioning must not select these.
      { id: 'hospital-plan', slug: 'hospital_starter', facility_type: 'hospital', is_active: true },
      { id: 'pharmacy-plan', slug: 'pharmacy_starter', facility_type: 'pharmacy', is_active: true },
    ],
  }
  let failure = ''
  const db = {
    tables,
    failAt(table: string) { failure = table },
    from(table: string) {
      const rows = tables[table] ??= []
      const filters: Array<(row: Row) => boolean> = []
      let mode = 'select', payload: unknown, conflict = '', single = false, max = Infinity
      const q: FakeQuery = {
        select() { return q }, eq(k: string, v: unknown) { filters.push(r => r[k] === v); return q },
        in(k: string, v: unknown[]) { filters.push(r => v.includes(r[k])); return q },
        order() { return q }, limit(n: number) { max = n; return q },
        maybeSingle() { single = true; return q }, single() { single = true; return q },
        insert(v: unknown) { mode = 'insert'; payload = v; return q },
        update(v: unknown) { mode = 'update'; payload = v; return q },
        upsert(v: unknown, opts: { onConflict?: string } = {}) { mode = 'upsert'; payload = v; conflict = opts.onConflict ?? 'id'; return q },
        then(resolve: (value: FakeResult) => void) {
          if (failure === table && mode !== 'select') return Promise.resolve({ data: null, error: { message: 'Synthetic injected failure' } }).then(resolve)
          let result = rows.filter(r => filters.every(f => f(r)))
          if (mode === 'insert' || mode === 'upsert') {
            const batch = (Array.isArray(payload) ? payload : [payload]) as Row[]
            result = batch.map(v => {
              const existing = mode === 'upsert' && rows.find(r => conflict.split(',').every(k => r[k] === v[k]))
              if (existing) return Object.assign(existing, v)
              const row = { id: crypto.randomUUID(), created_at: new Date().toISOString(), ...v }
              rows.push(row); return row
            })
          } else if (mode === 'update') result.forEach(r => Object.assign(r, payload as Row))
          result = result.slice(0, max)
          return Promise.resolve({ data: single ? result[0] ?? null : result, error: null }).then(resolve)
        },
      }
      return q
    },
  }
  return db
}
const input = (type: 'hospital' | 'clinic' | 'pharmacy' | 'laboratory', suffix = 'a') => ({
  facilityType: type, facilityName: `SYNAPSE ACCEPTANCE ${type} ${suffix}`, slug: `acceptance-${type}-${suffix}`,
  adminName: 'Synthetic Admin', adminEmail: `${type}-${suffix}@example.test`, createdBy: 'platform-admin',
  mode: 'SYNTHETIC_ACCEPTANCE' as const,
})
describe('facility orchestration with persisted effects', () => {
  it.each(['hospital', 'pharmacy', 'laboratory'] as const)('%s remains inactive on invitation failure and retries without duplicate resources', async type => {
    const db = database(); db.failAt('facility_invitations')
    const failed = await provisionFacility(db, input(type))
    expect(failed.ok).toBe(false)
    expect(db.tables.facility_provisioning_steps.some(r => r.step === "invitation" && r.status === "FAILED")).toBe(true)
    expect(db.tables.tenants[0].is_active).toBe(false)
    db.failAt('')
    const retried = await resumeFacilityProvision(db, failed.runId, 'platform-admin')
    expect(retried.ok).toBe(true)
    expect(db.tables.tenants).toHaveLength(1)
    expect(db.tables.tenants[0].facility_type).toBe(type)
    expect(db.tables.facility_invitations).toHaveLength(1)
    expect(db.tables.tenant_subscriptions).toHaveLength(1)
    const expectedPlan = type === 'pharmacy' ? 'pharm-annual' : type === 'laboratory' ? 'lab-annual' : 'os-basic'
    expect(db.tables.tenant_subscriptions[0].plan_id).toBe(expectedPlan)
    expect(db.tables.tenant_subscriptions[0].plan_id).not.toBe('hospital-plan')
    expect(db.tables.tenants[0].is_active).toBe(true)
    if (type === 'pharmacy') expect(db.tables.facility_provisioning_runs[0].failure_code).toBeNull()
    const counts = Object.fromEntries(Object.entries(db.tables).map(([k, v]) => [k, v.length]))
    db.tables.facility_provisioning_runs[0].failure_code = 'STALE_FAILURE'
    const replayed = await provisionFacility(db, input(type))
    // Secrets are stored only as a SHA-256 hash: the retry's emailed token matches the
    // stored hash, plaintext is never persisted, and a replay cannot re-reveal it.
    expect(db.tables.facility_invitations[0].invite_token).toBeNull()
    // Pharmacy replays return no secret; the hospital/lab workflow re-runs its steps and
    // rotates the still-open invite (old link stops working, new one is re-sent).
    if (type === 'pharmacy') expect(replayed.inviteToken).toBeNull()
    const liveToken = replayed.inviteToken ?? retried.inviteToken!
    expect(db.tables.facility_invitations[0].token_hash).toBe(hashFacilityInviteToken(liveToken))
    expect(replayed.inviteStatus).toBe(db.tables.facility_invitations[0].status)
    expect(db.tables.facility_provisioning_runs[0].failure_code).toBeNull()
    expect(Object.fromEntries(Object.entries(db.tables).map(([k, v]) => [k, v.length]))).toEqual(counts)
  })
  it('gives a hospital, clinic and laboratory a seven-day trial', async () => {
    for (const type of ['hospital', 'clinic', 'laboratory'] as const) {
      const db = database()
      const result = await provisionFacility(db, { ...input(type), mode: 'REAL' })
      expect(result.ok).toBe(true)
      const sub = db.tables.tenant_subscriptions[0]
      expect(sub.status).toBe('trialing')
      // Entitlement evaluates current_period_end, so it must track trial_ends.
      expect(sub.current_period_end).toBe(sub.trial_ends)
      const days = (Date.parse(sub.trial_ends as string) - Date.now()) / 86_400_000
      expect(days).toBeGreaterThan(6.9)
      expect(days).toBeLessThan(7.1)
    }
  })
  it('laboratory keeps its tenant link, exact lean modules, and lab administrator', async () => {
    const db = database()
    const result = await provisionFacility(db, input('laboratory'))
    expect(result.ok).toBe(true)
    expect((db.tables.hospitals[0].settings as { tenant_id?: unknown }).tenant_id).toBe(result.tenantId)
    expect(db.tables.hospitals[0].facility_kind).toBe('laboratory')
    expect(db.tables.hospital_modules.map(r => r.module_key).sort()).toEqual(['billing', 'core', 'lab', 'registration', 'reports'])
    expect(db.tables.profiles).toHaveLength(1)
    expect(db.tables.profiles[0].role).toBe('lab_admin')
    expect(db.tables.facility_invitations[0].role).toBe('lab_admin')
  })
  it('two synthetic hospitals retain distinct names, slugs, departments, and staff', async () => {
    const db = database()
    const a = await provisionFacility(db, input('hospital', 'a'))
    const b = await provisionFacility(db, input('hospital', 'b'))
    expect(a.ok && b.ok).toBe(true)
    expect(a.tenantId).not.toBe(b.tenantId)
    for (const tenantId of [a.tenantId, b.tenantId]) expect(db.tables.departments.filter(r => r.tenant_id === tenantId).some(r => r.name === 'Laboratory')).toBe(true)
  })
  it.each(['facility_locations', 'tenant_subscriptions', 'facility_domain_records'])('a %s failure cannot activate a hospital', async table => {
    const db = database(); db.failAt(table)
    const result = await provisionFacility(db, input('hospital'))
    expect(result.ok).toBe(false)
    expect(db.tables.tenants[0].is_active).toBe(false)
  })
  it('creates a pending domain record without claiming external DNS verification', async () => {
    const db = database()
    const result = await provisionFacility(db, input('clinic'))
    expect(result.ok).toBe(true)
    expect(db.tables.facility_domain_records).toHaveLength(1)
    expect(db.tables.facility_domain_records[0]).toMatchObject({
      tenant_id: result.tenantId,
      hostname: 'acceptance-clinic-a.synapseos.tech',
      status: 'REQUESTED',
    })
  })
  it('subscribes a hospital with the lab add-on to the OS + Lab plan, and enterprise to the custom plan', async () => {
    const withLab = database()
    const lab = await provisionFacility(withLab, { ...input('hospital', 'lab'), includeLab: true })
    expect(lab.ok).toBe(true)
    expect(withLab.tables.tenant_subscriptions[0].plan_id).toBe('os-lab')

    const custom = database()
    const enterprise = await provisionFacility(custom, { ...input('hospital', 'ent'), tier: 'enterprise' })
    expect(enterprise.ok).toBe(true)
    expect(custom.tables.tenant_subscriptions[0].plan_id).toBe('enterprise')
  })
  it('rejects reserved facility slugs before creating a tenant', async () => {
    const db = database()
    const result = await provisionFacility(db, { ...input('clinic'), slug: 'admin' })
    expect(result.ok).toBe(false)
    expect(result.error).toContain('reserved')
    expect(db.tables.tenants ?? []).toHaveLength(0)
  })
  it('pharmacy provisioning never falls back to a legacy plan when the annual plan is missing', async () => {
    const db = database()
    db.tables.subscription_plans = db.tables.subscription_plans.filter((p: Row) => p.slug !== 'synapse_pharmacy_annual')
    const result = await provisionFacility(db, input('pharmacy'))
    expect(result.ok).toBe(false)
    expect(db.tables.tenant_subscriptions ?? []).toHaveLength(0)
    expect(result.steps.find(s => s.step === 'subscription')?.errorCode).toBe('PHARMACY_PLAN_MISSING')
  })
})
