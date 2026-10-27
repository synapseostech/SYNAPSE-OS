import * as Crypto from 'expo-crypto'
import * as SQLite from 'expo-sqlite'

/**
 * Device-local store for the personal (consumer) health surfaces.
 *
 * Server-side consumer tables exist (health_habits, habit_logs, menstrual_cycles),
 * but their `user_id` still references auth.users(id) while SYNAPSE accounts are
 * owned by custom auth and are not required to have an auth.users row. Writing
 * those tables from a personal account would fail the foreign key, and adding a
 * glucose column to app_vitals needs a migration. Until those land, personal
 * readings stay on this device, scoped per account id.
 */

const DATABASE_NAME = 'synapse-personal-v1.db'

const SCHEMA = `
PRAGMA journal_mode = WAL;
CREATE TABLE IF NOT EXISTS personal_vitals (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  systolic REAL,
  diastolic REAL,
  value REAL,
  unit TEXT NOT NULL,
  note TEXT,
  recorded_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_personal_vitals_user ON personal_vitals(user_id, recorded_at DESC);
CREATE TABLE IF NOT EXISTS personal_habits (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  category TEXT NOT NULL,
  target_value REAL,
  target_unit TEXT,
  created_at TEXT NOT NULL,
  archived INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS personal_habit_logs (
  id TEXT PRIMARY KEY NOT NULL,
  habit_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  value REAL,
  note TEXT,
  logged_at TEXT NOT NULL,
  logged_on TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_personal_habit_logs ON personal_habit_logs(habit_id, logged_on DESC);
CREATE TABLE IF NOT EXISTS personal_cycles (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL,
  period_start TEXT NOT NULL,
  period_end TEXT,
  flow TEXT,
  symptoms TEXT,
  notes TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_personal_cycles ON personal_cycles(user_id, period_start DESC);
CREATE TABLE IF NOT EXISTS personal_activity (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL,
  activity TEXT NOT NULL,
  minutes INTEGER NOT NULL,
  intensity TEXT,
  note TEXT,
  logged_at TEXT NOT NULL,
  logged_on TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_personal_activity ON personal_activity(user_id, logged_on DESC);
CREATE TABLE IF NOT EXISTS personal_medical_id (
  user_id TEXT PRIMARY KEY NOT NULL,
  blood_group TEXT,
  allergies TEXT,
  conditions TEXT,
  regular_medications TEXT,
  emergency_name TEXT,
  emergency_phone TEXT,
  notes TEXT,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS personal_medications (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  dose TEXT,
  schedule TEXT,
  notes TEXT,
  created_at TEXT NOT NULL,
  archived INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_personal_medications ON personal_medications(user_id, archived);
CREATE TABLE IF NOT EXISTS personal_medication_logs (
  id TEXT PRIMARY KEY NOT NULL,
  medication_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  taken_at TEXT NOT NULL,
  taken_on TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_personal_medication_logs ON personal_medication_logs(medication_id, taken_on DESC);
CREATE TABLE IF NOT EXISTS personal_symptoms (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL,
  symptom TEXT NOT NULL,
  severity INTEGER NOT NULL,
  note TEXT,
  occurred_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_personal_symptoms ON personal_symptoms(user_id, occurred_at DESC);
`

let dbPromise: Promise<SQLite.SQLiteDatabase> | null = null

function db(): Promise<SQLite.SQLiteDatabase> {
  dbPromise ??= SQLite.openDatabaseAsync(DATABASE_NAME).then(async (handle) => {
    await handle.execAsync(SCHEMA)
    return handle
  })
  return dbPromise
}

export function localDay(date: Date = new Date()): string {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

function newId(): string {
  return Crypto.randomUUID()
}

// ── Vitals ───────────────────────────────────────────────────────────────────

export type VitalsKind = 'blood_pressure' | 'glucose' | 'weight' | 'heart_rate'

export type VitalsReading = {
  id: string
  kind: VitalsKind
  systolic: number | null
  diastolic: number | null
  value: number | null
  unit: string
  note: string | null
  recordedAt: string
}

type VitalsRow = {
  id: string
  kind: string
  systolic: number | null
  diastolic: number | null
  value: number | null
  unit: string
  note: string | null
  recorded_at: string
}

export async function listVitals(userId: string, kind?: VitalsKind, limit = 30): Promise<VitalsReading[]> {
  const handle = await db()
  const rows = kind
    ? await handle.getAllAsync<VitalsRow>(
        `SELECT id, kind, systolic, diastolic, value, unit, note, recorded_at
           FROM personal_vitals WHERE user_id = ? AND kind = ?
           ORDER BY recorded_at DESC LIMIT ?`,
        userId, kind, limit,
      )
    : await handle.getAllAsync<VitalsRow>(
        `SELECT id, kind, systolic, diastolic, value, unit, note, recorded_at
           FROM personal_vitals WHERE user_id = ?
           ORDER BY recorded_at DESC LIMIT ?`,
        userId, limit,
      )
  return rows.map((row) => ({
    id: row.id,
    kind: row.kind as VitalsKind,
    systolic: row.systolic,
    diastolic: row.diastolic,
    value: row.value,
    unit: row.unit,
    note: row.note,
    recordedAt: row.recorded_at,
  }))
}

export async function addVitals(input: {
  userId: string
  kind: VitalsKind
  systolic?: number | null
  diastolic?: number | null
  value?: number | null
  unit: string
  note?: string | null
  recordedAt?: string
}): Promise<VitalsReading> {
  const handle = await db()
  const reading: VitalsReading = {
    id: newId(),
    kind: input.kind,
    systolic: input.systolic ?? null,
    diastolic: input.diastolic ?? null,
    value: input.value ?? null,
    unit: input.unit,
    note: input.note?.trim() || null,
    recordedAt: input.recordedAt ?? new Date().toISOString(),
  }
  await handle.runAsync(
    `INSERT INTO personal_vitals (id, user_id, kind, systolic, diastolic, value, unit, note, recorded_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    reading.id, input.userId, reading.kind, reading.systolic, reading.diastolic,
    reading.value, reading.unit, reading.note, reading.recordedAt,
  )
  return reading
}

export async function deleteVitals(userId: string, id: string): Promise<void> {
  const handle = await db()
  await handle.runAsync(`DELETE FROM personal_vitals WHERE user_id = ? AND id = ?`, userId, id)
}

// ── Habits ───────────────────────────────────────────────────────────────────

export type HabitCategory = 'exercise' | 'sleep' | 'hydration' | 'meditation' | 'custom'

export type Habit = {
  id: string
  name: string
  category: HabitCategory
  targetValue: number | null
  targetUnit: string | null
  streak: number
  loggedToday: boolean
  loggedDays: string[]
}

type HabitRow = {
  id: string
  name: string
  category: string
  target_value: number | null
  target_unit: string | null
}

type HabitLogRow = { habit_id: string; logged_on: string }

export async function listHabits(userId: string): Promise<Habit[]> {
  const handle = await db()
  const habits = await handle.getAllAsync<HabitRow>(
    `SELECT id, name, category, target_value, target_unit
       FROM personal_habits WHERE user_id = ? AND archived = 0 ORDER BY created_at ASC`,
    userId,
  )
  if (habits.length === 0) return []
  const logs = await handle.getAllAsync<HabitLogRow>(
    `SELECT habit_id, logged_on FROM personal_habit_logs WHERE user_id = ? ORDER BY logged_on DESC`,
    userId,
  )
  const byHabit = new Map<string, string[]>()
  for (const log of logs) {
    const days = byHabit.get(log.habit_id) ?? []
    if (!days.includes(log.logged_on)) days.push(log.logged_on)
    byHabit.set(log.habit_id, days)
  }
  const today = localDay()
  return habits.map((row) => {
    const days = (byHabit.get(row.id) ?? []).slice().sort().reverse()
    return {
      id: row.id,
      name: row.name,
      category: row.category as HabitCategory,
      targetValue: row.target_value,
      targetUnit: row.target_unit,
      streak: streakFrom(days, today),
      loggedToday: days.includes(today),
      loggedDays: days,
    }
  })
}

function streakFrom(descendingDays: string[], today: string): number {
  if (descendingDays.length === 0) return 0
  const days = new Set(descendingDays)
  const cursor = new Date(`${today}T00:00:00`)
  if (!days.has(localDay(cursor))) cursor.setDate(cursor.getDate() - 1)
  let streak = 0
  while (days.has(localDay(cursor))) {
    streak += 1
    cursor.setDate(cursor.getDate() - 1)
  }
  return streak
}

export async function addHabit(input: {
  userId: string
  name: string
  category: HabitCategory
  targetValue?: number | null
  targetUnit?: string | null
}): Promise<void> {
  const handle = await db()
  await handle.runAsync(
    `INSERT INTO personal_habits (id, user_id, name, category, target_value, target_unit, created_at, archived)
     VALUES (?, ?, ?, ?, ?, ?, ?, 0)`,
    newId(), input.userId, input.name.trim(), input.category,
    input.targetValue ?? null, input.targetUnit?.trim() || null, new Date().toISOString(),
  )
}

export async function archiveHabit(userId: string, id: string): Promise<void> {
  const handle = await db()
  await handle.runAsync(`UPDATE personal_habits SET archived = 1 WHERE user_id = ? AND id = ?`, userId, id)
}

export async function logHabit(input: {
  userId: string
  habitId: string
  value?: number | null
  note?: string | null
}): Promise<void> {
  const handle = await db()
  const now = new Date()
  await handle.runAsync(
    `INSERT INTO personal_habit_logs (id, habit_id, user_id, value, note, logged_at, logged_on)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    newId(), input.habitId, input.userId, input.value ?? null, input.note?.trim() || null,
    now.toISOString(), localDay(now),
  )
}

// ── Cycle ────────────────────────────────────────────────────────────────────

export type FlowIntensity = 'spotting' | 'light' | 'medium' | 'heavy'

export type Cycle = {
  id: string
  periodStart: string
  periodEnd: string | null
  flow: FlowIntensity | null
  symptoms: string | null
  notes: string | null
}

type CycleRow = {
  id: string
  period_start: string
  period_end: string | null
  flow: string | null
  symptoms: string | null
  notes: string | null
}

export async function listCycles(userId: string, limit = 24): Promise<Cycle[]> {
  const handle = await db()
  const rows = await handle.getAllAsync<CycleRow>(
    `SELECT id, period_start, period_end, flow, symptoms, notes
       FROM personal_cycles WHERE user_id = ? ORDER BY period_start DESC LIMIT ?`,
    userId, limit,
  )
  return rows.map((row) => ({
    id: row.id,
    periodStart: row.period_start,
    periodEnd: row.period_end,
    flow: (row.flow as FlowIntensity | null) ?? null,
    symptoms: row.symptoms,
    notes: row.notes,
  }))
}

export async function addCycle(input: {
  userId: string
  periodStart: string
  periodEnd?: string | null
  flow?: FlowIntensity | null
  symptoms?: string | null
  notes?: string | null
}): Promise<void> {
  const handle = await db()
  await handle.runAsync(
    `INSERT INTO personal_cycles (id, user_id, period_start, period_end, flow, symptoms, notes, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    newId(), input.userId, input.periodStart, input.periodEnd || null, input.flow ?? null,
    input.symptoms?.trim() || null, input.notes?.trim() || null, new Date().toISOString(),
  )
}

export async function deleteCycle(userId: string, id: string): Promise<void> {
  const handle = await db()
  await handle.runAsync(`DELETE FROM personal_cycles WHERE user_id = ? AND id = ?`, userId, id)
}

// ── Activity ─────────────────────────────────────────────────────────────────

export type ActivityIntensity = 'light' | 'moderate' | 'vigorous'

export type ActivityEntry = {
  id: string
  activity: string
  minutes: number
  intensity: ActivityIntensity | null
  note: string | null
  loggedOn: string
}

type ActivityRow = {
  id: string
  activity: string
  minutes: number
  intensity: string | null
  note: string | null
  logged_on: string
}

export async function listActivity(userId: string, limit = 30): Promise<ActivityEntry[]> {
  const handle = await db()
  const rows = await handle.getAllAsync<ActivityRow>(
    `SELECT id, activity, minutes, intensity, note, logged_on
       FROM personal_activity WHERE user_id = ? ORDER BY logged_at DESC LIMIT ?`,
    userId, limit,
  )
  return rows.map((row) => ({
    id: row.id,
    activity: row.activity,
    minutes: row.minutes,
    intensity: (row.intensity as ActivityIntensity | null) ?? null,
    note: row.note,
    loggedOn: row.logged_on,
  }))
}

export async function addActivity(input: {
  userId: string
  activity: string
  minutes: number
  intensity?: ActivityIntensity | null
  note?: string | null
}): Promise<void> {
  const handle = await db()
  const now = new Date()
  await handle.runAsync(
    `INSERT INTO personal_activity (id, user_id, activity, minutes, intensity, note, logged_at, logged_on)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    newId(), input.userId, input.activity.trim(), Math.round(input.minutes),
    input.intensity ?? null, input.note?.trim() || null, now.toISOString(), localDay(now),
  )
}

export async function weeklyActivityMinutes(userId: string): Promise<number> {
  const handle = await db()
  const since = new Date()
  since.setDate(since.getDate() - 6)
  const row = await handle.getFirstAsync<{ total: number | null }>(
    `SELECT SUM(minutes) AS total FROM personal_activity
      WHERE user_id = ? AND logged_on >= ?`,
    userId, localDay(since),
  )
  return row?.total ?? 0
}

// ── Medical ID ───────────────────────────────────────────────────────────────

/**
 * Emergency information a responder would need. Kept device-local like the rest
 * of the personal surfaces; nothing here is shared with a hospital automatically.
 */
export type MedicalId = {
  bloodGroup: string | null
  allergies: string | null
  conditions: string | null
  regularMedications: string | null
  emergencyName: string | null
  emergencyPhone: string | null
  notes: string | null
  updatedAt: string | null
}

type MedicalIdRow = {
  blood_group: string | null
  allergies: string | null
  conditions: string | null
  regular_medications: string | null
  emergency_name: string | null
  emergency_phone: string | null
  notes: string | null
  updated_at: string
}

const EMPTY_MEDICAL_ID: MedicalId = {
  bloodGroup: null,
  allergies: null,
  conditions: null,
  regularMedications: null,
  emergencyName: null,
  emergencyPhone: null,
  notes: null,
  updatedAt: null,
}

export async function getMedicalId(userId: string): Promise<MedicalId> {
  const handle = await db()
  const row = await handle.getFirstAsync<MedicalIdRow>(
    `SELECT blood_group, allergies, conditions, regular_medications,
            emergency_name, emergency_phone, notes, updated_at
       FROM personal_medical_id WHERE user_id = ?`,
    userId,
  )
  if (!row) return EMPTY_MEDICAL_ID
  return {
    bloodGroup: row.blood_group,
    allergies: row.allergies,
    conditions: row.conditions,
    regularMedications: row.regular_medications,
    emergencyName: row.emergency_name,
    emergencyPhone: row.emergency_phone,
    notes: row.notes,
    updatedAt: row.updated_at,
  }
}

export async function saveMedicalId(userId: string, input: Omit<MedicalId, 'updatedAt'>): Promise<void> {
  const handle = await db()
  const clean = (value: string | null) => value?.trim() || null
  await handle.runAsync(
    `INSERT INTO personal_medical_id
       (user_id, blood_group, allergies, conditions, regular_medications,
        emergency_name, emergency_phone, notes, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET
       blood_group = excluded.blood_group,
       allergies = excluded.allergies,
       conditions = excluded.conditions,
       regular_medications = excluded.regular_medications,
       emergency_name = excluded.emergency_name,
       emergency_phone = excluded.emergency_phone,
       notes = excluded.notes,
       updated_at = excluded.updated_at`,
    userId,
    clean(input.bloodGroup),
    clean(input.allergies),
    clean(input.conditions),
    clean(input.regularMedications),
    clean(input.emergencyName),
    clean(input.emergencyPhone),
    clean(input.notes),
    new Date().toISOString(),
  )
}

// ── Medications ──────────────────────────────────────────────────────────────

export type Medication = {
  id: string
  name: string
  dose: string | null
  schedule: string | null
  notes: string | null
  takenToday: boolean
  /** Days taken in the last 7, 0–7. */
  daysTakenLastWeek: number
}

type MedicationRow = {
  id: string
  name: string
  dose: string | null
  schedule: string | null
  notes: string | null
}

export async function listMedications(userId: string): Promise<Medication[]> {
  const handle = await db()
  const rows = await handle.getAllAsync<MedicationRow>(
    `SELECT id, name, dose, schedule, notes FROM personal_medications
      WHERE user_id = ? AND archived = 0 ORDER BY created_at ASC`,
    userId,
  )
  if (rows.length === 0) return []

  const since = new Date()
  since.setDate(since.getDate() - 6)
  const logs = await handle.getAllAsync<{ medication_id: string; taken_on: string }>(
    `SELECT medication_id, taken_on FROM personal_medication_logs
      WHERE user_id = ? AND taken_on >= ?`,
    userId, localDay(since),
  )
  const days = new Map<string, Set<string>>()
  for (const log of logs) {
    const set = days.get(log.medication_id) ?? new Set<string>()
    set.add(log.taken_on)
    days.set(log.medication_id, set)
  }
  const today = localDay()
  return rows.map((row) => {
    const taken = days.get(row.id) ?? new Set<string>()
    return {
      id: row.id,
      name: row.name,
      dose: row.dose,
      schedule: row.schedule,
      notes: row.notes,
      takenToday: taken.has(today),
      daysTakenLastWeek: taken.size,
    }
  })
}

export async function addMedication(input: {
  userId: string
  name: string
  dose?: string | null
  schedule?: string | null
  notes?: string | null
}): Promise<void> {
  const handle = await db()
  await handle.runAsync(
    `INSERT INTO personal_medications (id, user_id, name, dose, schedule, notes, created_at, archived)
     VALUES (?, ?, ?, ?, ?, ?, ?, 0)`,
    newId(), input.userId, input.name.trim(), input.dose?.trim() || null,
    input.schedule?.trim() || null, input.notes?.trim() || null, new Date().toISOString(),
  )
}

/** Removes the medication and its adherence history for this account. */
export async function removeMedication(userId: string, id: string): Promise<void> {
  const handle = await db()
  await handle.runAsync(`DELETE FROM personal_medication_logs WHERE user_id = ? AND medication_id = ?`, userId, id)
  await handle.runAsync(`DELETE FROM personal_medications WHERE user_id = ? AND id = ?`, userId, id)
}

export async function markMedicationTaken(userId: string, medicationId: string): Promise<void> {
  const handle = await db()
  const now = new Date()
  const today = localDay(now)
  // One row per medication per day: tapping twice must not inflate adherence.
  const existing = await handle.getFirstAsync<{ id: string }>(
    `SELECT id FROM personal_medication_logs
      WHERE user_id = ? AND medication_id = ? AND taken_on = ? LIMIT 1`,
    userId, medicationId, today,
  )
  if (existing) return
  await handle.runAsync(
    `INSERT INTO personal_medication_logs (id, medication_id, user_id, taken_at, taken_on)
     VALUES (?, ?, ?, ?, ?)`,
    newId(), medicationId, userId, now.toISOString(), today,
  )
}

// ── Symptoms ─────────────────────────────────────────────────────────────────

export type SymptomEntry = {
  id: string
  symptom: string
  /** 1 (mild) to 5 (severe). */
  severity: number
  note: string | null
  occurredAt: string
}

type SymptomRow = {
  id: string
  symptom: string
  severity: number
  note: string | null
  occurred_at: string
}

export async function listSymptoms(userId: string, limit = 40): Promise<SymptomEntry[]> {
  const handle = await db()
  const rows = await handle.getAllAsync<SymptomRow>(
    `SELECT id, symptom, severity, note, occurred_at FROM personal_symptoms
      WHERE user_id = ? ORDER BY occurred_at DESC LIMIT ?`,
    userId, limit,
  )
  return rows.map((row) => ({
    id: row.id,
    symptom: row.symptom,
    severity: row.severity,
    note: row.note,
    occurredAt: row.occurred_at,
  }))
}

export async function addSymptom(input: {
  userId: string
  symptom: string
  severity: number
  note?: string | null
  occurredAt?: string
}): Promise<void> {
  const handle = await db()
  const severity = Math.min(5, Math.max(1, Math.round(input.severity)))
  await handle.runAsync(
    `INSERT INTO personal_symptoms (id, user_id, symptom, severity, note, occurred_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    newId(), input.userId, input.symptom.trim(), severity,
    input.note?.trim() || null, input.occurredAt ?? new Date().toISOString(),
  )
}

export async function deleteSymptom(userId: string, id: string): Promise<void> {
  const handle = await db()
  await handle.runAsync(`DELETE FROM personal_symptoms WHERE user_id = ? AND id = ?`, userId, id)
}
