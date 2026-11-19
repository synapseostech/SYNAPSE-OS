import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { buildToday } from './health-today'
import { defaultHealthSections } from './health-sections'

const now = new Date(2026, 10, 18, 9, 0)
const iso = (d: number, h: number, m = 0) => new Date(2026, 10, d, h, m).toISOString()

const base = {
  medications: [
    { id: 'm1', name: 'Metformin', dose: '500 mg', takenToday: true, remaining: 30, refillAt: 5 },
    { id: 'm2', name: 'Amlodipine', dose: '5 mg', takenToday: false, remaining: 3, refillAt: 5 },
    { id: 'm3', name: 'Vitamin D', dose: null, takenToday: false, remaining: null, refillAt: null },
  ],
  reminders: [
    { kind: 'medicine' as const, title: 'Amlodipine', medicationId: 'm2', hour: 20, minute: 0, appointmentAt: null, enabled: true },
    { kind: 'medicine' as const, title: 'Amlodipine', medicationId: 'm2', hour: 8, minute: 30, appointmentAt: null, enabled: true },
    { kind: 'medicine' as const, title: 'Vitamin D', medicationId: 'm3', hour: 7, minute: 0, appointmentAt: null, enabled: false },
    { kind: 'appointment' as const, title: 'Antenatal visit', medicationId: null, hour: 0, minute: 0, appointmentAt: iso(18, 14), enabled: true },
    { kind: 'appointment' as const, title: 'Dentist', medicationId: null, hour: 0, minute: 0, appointmentAt: iso(19, 10), enabled: true },
    { kind: 'appointment' as const, title: 'Last month', medicationId: null, hour: 0, minute: 0, appointmentAt: iso(1, 10), enabled: true },
    { kind: 'appointment' as const, title: 'Next year', medicationId: null, hour: 0, minute: 0, appointmentAt: new Date(2027, 5, 1).toISOString(), enabled: true },
  ],
  vitals: [
    { kind: 'blood_pressure' as const, systolic: 128, diastolic: 82, value: null, unit: 'mmHg', recordedAt: iso(17, 8) },
    { kind: 'blood_pressure' as const, systolic: 140, diastolic: 90, value: null, unit: 'mmHg', recordedAt: iso(10, 8) },
  ],
  wearables: [
    { metric: 'steps' as const, day: '2026-11-18', value: 3200 },
    { metric: 'steps' as const, day: '2026-11-17', value: 9000 },
    { metric: 'sleep_minutes' as const, day: '2026-11-18', value: 400 },
  ],
  now,
}

describe('buildToday', () => {
  it('lists medicines still to take first, at their earliest reminder time', () => {
    const today = buildToday({ ...base, sections: defaultHealthSections('female') })
    assert.deepEqual(
      today.medicines.map((m) => [m.name, m.taken, m.time, m.lowSupply]),
      [
        ['Amlodipine', false, '08:30', true],
        ['Vitamin D', false, null, false],
        ['Metformin', true, null, false],
      ],
    )
    assert.equal(today.medicinesLeft, 2)
  })

  it('shows appointments in the next week only, soonest first', () => {
    const today = buildToday({ ...base, sections: defaultHealthSections('female') })
    assert.deepEqual(
      today.appointments.map((a) => [a.title, a.when, a.isToday]),
      [
        ['Antenatal visit', 'Today 14:00', true],
        ['Dentist', 'Tomorrow 10:00', false],
      ],
    )
  })

  it('shows the latest logged and wearable readings', () => {
    const today = buildToday({ ...base, sections: defaultHealthSections('female') })
    assert.deepEqual(
      today.readings.map((r) => [r.key, r.value, r.when, r.source]),
      [
        ['bp', '128/82', 'yesterday', 'logged'],
        ['steps', '3,200', 'today', 'wearable'],
        ['sleep_minutes', '6h 40m', 'today', 'wearable'],
      ],
    )
  })

  it('tailors quick actions to the person’s sections', () => {
    const female = buildToday({ ...base, sections: defaultHealthSections('female') }).quickActions.map((a) => a.id)
    const male = buildToday({ ...base, sections: defaultHealthSections('male') })
    assert.ok(female.includes('period'))
    assert.ok(!male.quickActions.some((a) => a.id === 'period'))
    assert.equal(male.quickActions.find((a) => a.id === 'checks')?.label, "Men's health")
    assert.ok(male.quickActions.some((a) => a.id === 'wearables'))
  })

  it('copes with an empty record', () => {
    const today = buildToday({ medications: [], reminders: [], vitals: [], wearables: [], sections: defaultHealthSections(null), now })
    assert.deepEqual([today.medicines, today.appointments, today.readings], [[], [], []])
    assert.equal(today.quickActions.find((a) => a.id === 'checks')?.label, 'Health checks')
  })
})
