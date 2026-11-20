/**
 * The My Health home screen in one pure function: what is due today, what is
 * coming up, the latest readings, and the quick actions that make sense for
 * this person's sections. No React Native imports, so node:test covers it.
 */
import type { HealthSections } from './health-sections'
import { formatMetric, localDay, type WearableMetric } from './wearables-core'

export type TodayMedicationInput = {
  id: string
  name: string
  dose: string | null
  takenToday: boolean
  remaining: number | null
  refillAt: number | null
}

export type TodayReminderInput = {
  kind: 'medicine' | 'appointment'
  title: string
  medicationId: string | null
  hour: number
  minute: number
  appointmentAt: string | null
  enabled: boolean
}

export type TodayVitalInput = {
  kind: 'blood_pressure' | 'glucose' | 'weight' | 'heart_rate'
  systolic: number | null
  diastolic: number | null
  value: number | null
  unit: string
  recordedAt: string
}

export type TodayWearableInput = { metric: WearableMetric; day: string; value: number }

export type TodayMedicine = {
  id: string
  name: string
  dose: string | null
  taken: boolean
  /** "08:00" from the earliest enabled reminder, when one exists. */
  time: string | null
  lowSupply: boolean
}

export type TodayAppointment = { title: string; at: string; when: string; isToday: boolean }

export type TodayReading = {
  key: string
  label: string
  value: string
  unit: string
  when: string
  source: 'logged' | 'wearable'
}

export type QuickAction = { id: string; label: string; route: string }

export type TodaySummary = {
  medicines: TodayMedicine[]
  medicinesLeft: number
  appointments: TodayAppointment[]
  readings: TodayReading[]
  quickActions: QuickAction[]
}

const pad = (n: number) => String(n).padStart(2, '0')

function relativeDay(date: Date, now: Date): string {
  const today = localDay(now)
  const day = localDay(date)
  const time = `${pad(date.getHours())}:${pad(date.getMinutes())}`
  if (day === today) return `Today ${time}`
  const tomorrow = localDay(new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1))
  if (day === tomorrow) return `Tomorrow ${time}`
  return `${date.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })} ${time}`
}

function sinceLabel(iso: string, now: Date): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  const day = localDay(date)
  if (day === localDay(now)) return 'today'
  if (day === localDay(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1))) return 'yesterday'
  return date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })
}

export function buildToday(input: {
  medications: readonly TodayMedicationInput[]
  reminders: readonly TodayReminderInput[]
  vitals: readonly TodayVitalInput[]
  wearables: readonly TodayWearableInput[]
  sections: HealthSections
  now?: Date
}): TodaySummary {
  const now = input.now ?? new Date()
  const today = localDay(now)

  const firstTime = new Map<string, number>()
  for (const reminder of input.reminders) {
    if (!reminder.enabled || reminder.kind !== 'medicine' || !reminder.medicationId) continue
    const minutes = reminder.hour * 60 + reminder.minute
    const current = firstTime.get(reminder.medicationId)
    if (current === undefined || minutes < current) firstTime.set(reminder.medicationId, minutes)
  }

  const medicines: TodayMedicine[] = input.medications
    .map((med) => {
      const minutes = firstTime.get(med.id)
      return {
        id: med.id,
        name: med.name,
        dose: med.dose,
        taken: med.takenToday,
        time: minutes === undefined ? null : `${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`,
        lowSupply: med.remaining !== null && med.refillAt !== null && med.remaining <= med.refillAt,
      }
    })
    // Not yet taken first, then by time of day, untimed last.
    .sort((a, b) => Number(a.taken) - Number(b.taken) || (a.time ?? '99').localeCompare(b.time ?? '99'))

  const horizon = now.getTime() + 7 * 86_400_000
  const appointments: TodayAppointment[] = input.reminders
    .filter((r) => r.enabled && r.kind === 'appointment' && r.appointmentAt)
    .map((r) => ({ title: r.title, date: new Date(r.appointmentAt as string), at: r.appointmentAt as string }))
    .filter(({ date }) => !Number.isNaN(date.getTime()) && date.getTime() >= now.getTime() - 60 * 60 * 1000 && date.getTime() <= horizon)
    .sort((a, b) => a.date.getTime() - b.date.getTime())
    .slice(0, 3)
    .map(({ title, date, at }) => ({ title, at, when: relativeDay(date, now), isToday: localDay(date) === today }))

  const readings: TodayReading[] = []
  const latest = (kind: TodayVitalInput['kind']) =>
    input.vitals
      .filter((v) => v.kind === kind)
      .sort((a, b) => b.recordedAt.localeCompare(a.recordedAt))[0]
  const bp = latest('blood_pressure')
  if (bp) {
    readings.push({
      key: 'bp',
      label: 'Blood pressure',
      value: `${bp.systolic ?? '—'}/${bp.diastolic ?? '—'}`,
      unit: 'mmHg',
      when: sinceLabel(bp.recordedAt, now),
      source: 'logged',
    })
  }
  const glucose = latest('glucose')
  if (glucose) {
    readings.push({
      key: 'glucose',
      label: 'Blood glucose',
      value: String(glucose.value ?? '—'),
      unit: glucose.unit,
      when: sinceLabel(glucose.recordedAt, now),
      source: 'logged',
    })
  }
  const wearable = (metric: WearableMetric, label: string, unit: string) => {
    const reading = input.wearables
      .filter((w) => w.metric === metric && w.day <= today)
      .sort((a, b) => b.day.localeCompare(a.day))[0]
    if (!reading) return
    readings.push({
      key: metric,
      label,
      value: formatMetric(metric, reading.value),
      unit,
      when: reading.day === today ? 'today' : sinceLabel(`${reading.day}T12:00:00`, now),
      source: 'wearable',
    })
  }
  wearable('steps', 'Steps', '')
  wearable('heart_rate', 'Heart rate', 'bpm')
  wearable('sleep_minutes', 'Sleep', '')

  const quickActions: QuickAction[] = [
    { id: 'reading', label: 'Log a reading', route: '/(personal)/vitals' },
    { id: 'medicine', label: 'Add a medicine', route: '/(personal)/medications' },
    { id: 'appointment', label: 'Add an appointment', route: '/(personal)/reminders' },
    { id: 'feel', label: 'How I feel', route: '/(personal)/journal' },
  ]
  if (input.sections.cycle) quickActions.push({ id: 'period', label: 'Log a period', route: '/(personal)/cycle' })
  if (input.sections.pregnancy || input.sections.mensHealth) {
    quickActions.push({ id: 'checks', label: input.sections.mensHealth ? "Men's health" : 'Pregnancy & checks', route: '/(personal)/health-checks' })
  } else {
    quickActions.push({ id: 'checks', label: 'Health checks', route: '/(personal)/health-checks' })
  }
  quickActions.push({ id: 'wearables', label: 'Watch & phone data', route: '/(personal)/wearables' })

  return {
    medicines,
    medicinesLeft: medicines.filter((m) => !m.taken).length,
    appointments,
    readings,
    quickActions,
  }
}
