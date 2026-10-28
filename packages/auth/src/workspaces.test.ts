import { describe, expect, it } from 'vitest'
import {
  mergeWorkspaces,
  pickWorkspace,
  workspaceTenantIds,
  type WorkspaceSources,
  type WorkspaceTenant,
} from './workspaces'

const tenants: WorkspaceTenant[] = [
  { id: 'home', name: 'Kampala Clinic', slug: 'kampala', facility_type: 'hospital' },
  { id: 'pharm', name: 'Main Pharmacy', slug: 'main-pharm', facility_type: 'pharmacy' },
  { id: 'lab', name: 'Central Lab', slug: 'central-lab', facility_type: 'lab' },
]

function sources(overrides: Partial<WorkspaceSources> = {}): WorkspaceSources {
  return {
    homeTenantId: 'home',
    homeRole: 'doctor',
    scopes: [],
    pharmacy: [],
    tenants,
    ...overrides,
  }
}

describe('workspaceTenantIds', () => {
  it('lists the home tenant first and de-duplicates', () => {
    expect(
      workspaceTenantIds(
        sources({
          scopes: [{ tenant_id: 'pharm', role: 'pharmacist' }, { tenant_id: 'home', role: 'doctor' }],
          pharmacy: [{ tenant_id: 'home', pharmacy_role: 'pharmacy_admin', permissions: [], store_id: null }],
        }),
      ),
    ).toEqual(['home', 'pharm'])
  })

  it('drops blank ids and deactivated pharmacy rows', () => {
    expect(
      workspaceTenantIds(
        sources({
          homeTenantId: '  ',
          scopes: [{ tenant_id: null, role: 'nurse' }],
          pharmacy: [
            { tenant_id: 'lab', pharmacy_role: 'pharmacy_staff', permissions: [], store_id: null, is_active: false },
          ],
        }),
      ),
    ).toEqual([])
  })
})

describe('mergeWorkspaces', () => {
  it('gives home the profile role and other facilities their scope role', () => {
    const workspaces = mergeWorkspaces(
      sources({ scopes: [{ tenant_id: 'lab', role: 'lab_tech' }] }),
    )

    expect(workspaces.map((w) => [w.tenantId, w.role, w.isHome])).toEqual([
      ['home', 'doctor', true],
      ['lab', 'lab_tech', false],
    ])
  })

  it('keeps the home first, then sorts by name', () => {
    const workspaces = mergeWorkspaces(
      sources({
        scopes: [
          { tenant_id: 'lab', role: 'lab_tech' },
          { tenant_id: 'pharm', role: 'pharmacist' },
        ],
      }),
    )

    expect(workspaces.map((w) => w.tenantId)).toEqual(['home', 'lab', 'pharm'])
  })

  it('falls back to the pharmacy role where no scope exists', () => {
    const [workspace] = mergeWorkspaces(
      sources({
        homeTenantId: null,
        homeRole: null,
        pharmacy: [{ tenant_id: 'pharm', pharmacy_role: 'pharmacy_admin', permissions: ['inventory.read'], store_id: 's1' }],
      }),
    )

    expect(workspace).toMatchObject({
      tenantId: 'pharm',
      role: 'pharmacy_admin',
      pharmacyRole: 'pharmacy_admin',
      permissions: ['inventory.read'],
      storeId: 's1',
      isHome: false,
    })
  })

  it('prefers the first scope role when a tenant has several', () => {
    const [workspace] = mergeWorkspaces(
      sources({
        homeTenantId: null,
        homeRole: null,
        scopes: [
          { tenant_id: 'pharm', role: 'pharmacist' },
          { tenant_id: 'pharm', role: 'pharmacy_cashier' },
        ],
      }),
    )

    expect(workspace?.role).toBe('pharmacist')
  })

  it('offers nothing for a tenant whose row could not be read', () => {
    expect(
      mergeWorkspaces(
        sources({
          scopes: [{ tenant_id: 'unreadable', role: 'doctor' }],
          tenants: tenants.filter((t) => t.id !== 'unreadable'),
        }),
      ).map((w) => w.tenantId),
    ).toEqual(['home'])
  })

  it('ignores a deactivated pharmacy row', () => {
    const [, workspace] = mergeWorkspaces(
      sources({
        scopes: [{ tenant_id: 'pharm', role: 'pharmacist' }],
        pharmacy: [
          { tenant_id: 'pharm', pharmacy_role: 'pharmacy_admin', permissions: [], store_id: null, is_active: false },
        ],
      }),
    )

    expect(workspace?.pharmacyRole).toBeNull()
    expect(workspace?.role).toBe('pharmacist')
  })
})

describe('pickWorkspace', () => {
  const workspaces = mergeWorkspaces(
    sources({ scopes: [{ tenant_id: 'lab', role: 'lab_tech' }, { tenant_id: 'pharm', role: 'pharmacist' }] }),
  )

  it('honours an explicit facility', () => {
    expect(pickWorkspace(workspaces, 'pharm')?.role).toBe('pharmacist')
  })

  it('refuses an explicit facility this identity has no scope in', () => {
    expect(pickWorkspace(workspaces, 'elsewhere')).toBeNull()
  })

  it('uses the home facility when none is named', () => {
    expect(pickWorkspace(workspaces)?.tenantId).toBe('home')
  })

  it('uses the only facility when the identity has no home', () => {
    const single = mergeWorkspaces(
      sources({
        homeTenantId: null,
        homeRole: null,
        scopes: [{ tenant_id: 'lab', role: 'lab_tech' }],
      }),
    )

    expect(pickWorkspace(single)?.tenantId).toBe('lab')
  })

  it('does not guess between several facilities without a home', () => {
    const many = mergeWorkspaces(
      sources({
        homeTenantId: null,
        homeRole: null,
        scopes: [{ tenant_id: 'lab', role: 'lab_tech' }, { tenant_id: 'pharm', role: 'pharmacist' }],
      }),
    )

    expect(pickWorkspace(many)).toBeNull()
  })
})
