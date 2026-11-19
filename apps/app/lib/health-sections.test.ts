import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  ageOn,
  defaultHealthSections,
  healthChecksFor,
  pregnancyProgress,
  readSexAtBirth,
  resolveHealthSections,
  signupSexPayload,
} from './health-sections'

describe('health sections', () => {
  it('turns on cycle and pregnancy for female, men’s health for male', () => {
    assert.deepEqual(defaultHealthSections('female'), { cycle: true, pregnancy: true, mensHealth: false })
    assert.deepEqual(defaultHealthSections('male'), { cycle: false, pregnancy: false, mensHealth: true })
  })

  it('hides sex-specific sections by default when sex is intersex, undisclosed or unknown', () => {
    for (const sex of ['intersex', 'undisclosed', null] as const) {
      assert.deepEqual(defaultHealthSections(sex), { cycle: false, pregnancy: false, mensHealth: false })
    }
  })

  it('lets the person override any default either way', () => {
    assert.deepEqual(resolveHealthSections('male', { cycle: true }), { cycle: true, pregnancy: false, mensHealth: true })
    assert.deepEqual(resolveHealthSections('female', { pregnancy: false }), { cycle: true, pregnancy: false, mensHealth: false })
    assert.deepEqual(resolveHealthSections('intersex', { mensHealth: true, cycle: true }), {
      cycle: true,
      pregnancy: false,
      mensHealth: true,
    })
  })

  it('reads older stored values', () => {
    assert.equal(readSexAtBirth('other'), 'intersex')
    assert.equal(readSexAtBirth('female'), 'female')
    assert.equal(readSexAtBirth('Rather not say'), null)
  })
})

describe('sign-up payload', () => {
  it('sends sex separately from an optional gender identity', () => {
    assert.deepEqual(signupSexPayload('male', null, ''), { sex: 'male', gender_identity: '' })
    assert.deepEqual(signupSexPayload('female', 'non_binary', ''), { sex: 'female', gender_identity: 'Non-binary' })
    assert.deepEqual(signupSexPayload(null, 'self_describe', '  Two-spirit '), { sex: 'undisclosed', gender_identity: 'Two-spirit' })
    assert.deepEqual(signupSexPayload('intersex', 'undisclosed', ''), { sex: 'intersex', gender_identity: '' })
  })
})

describe('health checks', () => {
  const female = defaultHealthSections('female')
  const male = defaultHealthSections('male')
  const ids = (list: { id: string }[]) => list.map((c) => c.id)

  it('offers prostate and testicular checks only when men’s health is on', () => {
    assert.ok(ids(healthChecksFor(male, 52)).includes('prostate-talk'))
    assert.ok(ids(healthChecksFor(male, 30)).includes('testicular-check'))
    assert.ok(!ids(healthChecksFor(male, 30)).includes('prostate-talk'))
    assert.ok(!ids(healthChecksFor(female, 52)).includes('prostate-talk'))
  })

  it('offers cervical screening and breast checks only with the cycle sections on', () => {
    assert.ok(ids(healthChecksFor(female, 30)).includes('cervical-screening'))
    assert.ok(!ids(healthChecksFor(female, 20)).includes('cervical-screening'))
    assert.ok(!ids(healthChecksFor(male, 30)).includes('cervical-screening'))
  })

  it('always offers the general checks', () => {
    const none = { cycle: false, pregnancy: false, mensHealth: false }
    assert.deepEqual(ids(healthChecksFor(none, 40)), ['blood-pressure', 'blood-sugar'])
  })

  it('computes age on a date', () => {
    const now = new Date(2026, 10, 18)
    assert.equal(ageOn('1976-11-18', now), 50)
    assert.equal(ageOn('1976-11-19', now), 49)
    assert.equal(ageOn('nope', now), null)
  })
})

describe('pregnancy progress', () => {
  it('counts weeks from the due date', () => {
    const now = new Date(2026, 10, 18)
    // Due in 140 days → 140 days in → 20 weeks exactly.
    const due = new Date(2026, 10, 18 + 140)
    const iso = `${due.getFullYear()}-${String(due.getMonth() + 1).padStart(2, '0')}-${String(due.getDate()).padStart(2, '0')}`
    assert.deepEqual(pregnancyProgress(iso, now), { weeks: 20, days: 0, trimester: 2, daysToGo: 140 })
  })

  it('rejects due dates that cannot be a current pregnancy', () => {
    const now = new Date(2026, 10, 18)
    assert.equal(pregnancyProgress('2028-01-01', now), null)
    assert.equal(pregnancyProgress('2025-01-01', now), null)
    assert.equal(pregnancyProgress('', now), null)
  })
})
