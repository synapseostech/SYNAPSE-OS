import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

// Guards the capability seed in 20261120140000_hospital_core_journey.sql
// (which promoted supabase/proposed/20260928_opd_encounter_sign_disposition_capabilities):
// every capability these routes check must be created there, and the grants a
// small clinic depends on must stay in place.
const repo = join(__dirname, '../../../..')
const migration = readFileSync(join(repo, 'supabase/migrations/20261120140000_hospital_core_journey.sql'), 'utf8')
  .toLowerCase()
  .replace(/--.*$/gm, '')
const api = join(repo, 'apps/web/src/app/api')

const ROUTES: Array<[string, string, string, string]> = [
  ['opd/encounters/[id]/sign/route.ts', 'opd', 'encounter', 'sign'],
  ['opd/encounters/[id]/disposition/route.ts', 'opd', 'encounter', 'disposition'],
  ['opd/encounters/[id]/close/route.ts', 'opd', 'encounter', 'close'],
  ['opd/results/[resultId]/review/route.ts', 'opd', 'result', 'review'],
  ['opd/prescriptions/[id]/cancel/route.ts', 'opd', 'prescription', 'cancel'],
  ['hospital/billing/invoices/[id]/cover/route.ts', 'billing', 'insurance', 'apply'],
  ['ipd/admissions/[id]/discharge/route.ts', 'ipd', 'admission', 'discharge'],
]

const grants = new Set(
  [...migration.matchAll(/\('([a-z_]+)',\s*'hospital',\s*'([a-z_]+)',\s*'([a-z_]+)',\s*'([a-z_]+)'\)/g)].map(
    (m) => `${m[1]}:${m[2]}.${m[3]}.${m[4]}`,
  ),
)

describe('hospital capability seed', () => {
  it.each(ROUTES)('%s checks a capability the migration creates', (file, module, resource, action) => {
    const src = readFileSync(join(api, file), 'utf8')
    expect(src).toMatch(new RegExp(`requireHospitalCapability\\(ctx, '${resource}', '${action}', '${module}'\\)`))
    expect(migration).toMatch(new RegExp(`\\('${module}',\\s+'${resource}',\\s+'${action}'`))
  })

  it.each([
    'doctor:opd.encounter.sign',
    'clinical_officer:opd.encounter.sign',
    'doctor:lab.order.read',
    'nurse:opd.triage.assign',
    'cashier:billing.payment.record',
    'cashier:billing.insurance.apply',
    'clinical_officer:ipd.admission.create',
    'doctor:ipd.admission.discharge',
  ])('grants %s', (grant) => {
    expect(grants.has(grant)).toBe(true)
  })

  it('keeps role separation: reception, cashier and nurses never sign, discharge or prescribe', () => {
    for (const role of ['receptionist', 'cashier', 'nurse', 'billing_officer']) {
      for (const cap of ['opd.encounter.sign', 'ipd.admission.discharge', 'opd.prescription.cancel', 'opd.encounter.close']) {
        expect(grants.has(`${role}:${cap}`), `${role}:${cap}`).toBe(false)
      }
    }
  })
})
