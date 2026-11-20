import { beforeEach, describe, expect, it, vi } from 'vitest'
import { dbMock } from '../../../../lib/lab/testing/db-mock'

/**
 * The instrument, mapping and staging screens still gate by role. They used to
 * name `lab_manager` (a role nothing provisions) and leave out `lab_admin`, so
 * a standalone laboratory's own administrator was refused. These checks pin the
 * shared role groups in lib/lab/roles.ts.
 */
vi.mock('server-only', () => ({}))
const state = vi.hoisted(() => ({ role: 'lab_admin', db: null as unknown as { rpc: unknown; from: unknown } }))
vi.mock('@/lib/lab/roles', () => import('../../../../lib/lab/roles'))
vi.mock('@/lib/auth/getCurrentUser', () => ({ getCurrentUser: async () => ({ id: 'u', role: state.role, email: null }) }))
vi.mock('@/lib/hospital-dept', () => ({
  requireHospitalStaffContext: async () => ({ userId: '91456280-e996-4ff3-84ba-cada261d5062', role: state.role, tenantId: '0edb651a-232a-4289-9b3d-ae5bb1bac2cb', hospitalId: 'h', facilityType: 'laboratory', email: '', fullName: null }),
}))
vi.mock('@/lib/hospital-shared', async () => {
  const { NextResponse } = await import('next/server')
  return {
    isContextError: (v: unknown) => v instanceof NextResponse,
    gateHospitalModule: async () => null,
    requireHospitalCapability: async () => null,
    logHospitalAudit: vi.fn(),
  }
})
vi.mock('@synapse/db/admin', () => ({ supabaseAdmin: { rpc: (...a: unknown[]) => (state.db.rpc as (...x: unknown[]) => unknown)(...a), from: (...a: unknown[]) => (state.db.from as (...x: unknown[]) => unknown)(...a) } }))

import { POST as rejectStaging } from '../staging/[id]/reject/route'
import { POST as reprocessStaging } from '../staging/[id]/reprocess/route'
import { GET as matchCandidates, POST as matchAccession } from '../staging/[id]/match-accession/route'
import { GET as listStaging } from '../staging/route'
import { GET as listMappings, POST as createMapping } from '../mappings/route'
import { PATCH as patchMapping } from '../mappings/[id]/route'
import { GET as getInstrument, PATCH as patchInstrument } from '../instruments/[id]/route'
import { GET as instrumentMessages } from '../instruments/[id]/messages/route'

const ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const p = { params: Promise.resolve({ id: ID }) }
const body = (b: unknown) => new Request(`http://x?accession=LAB-1&id=${ID}`, { method: 'POST', body: JSON.stringify(b) })

const senior: Array<[string, () => Promise<Response>]> = [
  ['staging list', () => listStaging()],
  ['staging reject', () => rejectStaging(body({ reason: 'wrong patient' }) as never, p)],
  ['staging reprocess', () => reprocessStaging(body({}), p)],
  ['staging match', () => matchAccession(body({ accessionNumber: 'LAB-1' }), p)],
  ['mapping create', () => createMapping(body({ deviceId: ID, analyzerCode: 'WBC', loincCode: '6690-2' }))],
  ['mapping patch', () => patchMapping(body({ active: false }), p)],
]
const staff: Array<[string, () => Promise<Response>]> = [
  ['match candidates', () => matchCandidates(body({}))],
  ['mapping list', () => listMappings(body({}))],
  ['instrument detail', () => getInstrument(body({}) as never, p)],
  ['instrument messages', () => instrumentMessages(body({}) as never, p)],
]
const manager: Array<[string, () => Promise<Response>]> = [
  ['instrument patch', () => patchInstrument(body({ name: 'Sysmex' }) as never, p)],
]

beforeEach(() => { state.db = dbMock({ tables: {} }).db })

describe('lab role gates', () => {
  it.each([...senior, ...staff, ...manager])('%s: a standalone lab admin is let through', async (_name, call) => {
    state.role = 'lab_admin'
    expect((await call()).status).not.toBe(403)
  })
  it.each([...senior, ...staff, ...manager])('%s: a pharmacy cashier is refused', async (_name, call) => {
    state.role = 'cashier'
    expect((await call()).status).toBe(403)
  })
  it.each(senior)('%s: a bench technician is refused', async (_name, call) => {
    state.role = 'lab_tech'
    expect((await call()).status).toBe(403)
  })
  it.each(manager)('%s: a scientist cannot reconfigure devices', async (_name, call) => {
    state.role = 'lab_scientist'
    expect((await call()).status).toBe(403)
  })
  it.each(staff)('%s: a technician (either spelling) can read', async (_name, call) => {
    for (const role of ['lab_tech', 'lab_technician']) {
      state.role = role
      expect((await call()).status).not.toBe(403)
    }
  })
})
