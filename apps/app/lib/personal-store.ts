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
CREATE TABLE IF NOT EXISTS personal_reminders (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  detail TEXT,
  medication_id TEXT,
  hour INTEGER NOT NULL,
  minute INTEGER NOT NULL,
  appointment_at TEXT,
  lead_minutes INTEGER NOT NULL DEFAULT 0,
  notification_id TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_personal_reminders ON personal_reminders(user_id, enabled);
CREATE TABLE IF NOT EXISTS personal_health_profile (
  user_id TEXT PRIMARY KEY NOT NULL,
  date_of_birth TEXT,
  sex TEXT,
  height_cm REAL,
  weight_kg REAL,
  insurance_provider TEXT,
  insurance_number TEXT,
  insurance_plan TEXT,
  insurance_expiry TEXT,
  organ_donor INTEGER NOT NULL DEFAULT 0,
  donor_number TEXT,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS personal_activity_goal (
  user_id TEXT PRIMARY KEY NOT NULL,
  weekly_minutes INTEGER NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS personal_medication_supply (
  medication_id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL,
  remaining INTEGER NOT NULL,
  refill_at INTEGER NOT NULL,
  updated_at TEXT NOT NULL
);
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

/** The weekly minutes the person set for themselves, or null when they set none. */
export async function getWeeklyGoal(userId: string): Promise<number | null> {
  const handle = await db()
  const row = await handle.getFirstAsync<{ weekly_minutes: number }>(
    `SELECT weekly_minutes FROM personal_activity_goal WHERE user_id = ?`,
    userId,
  )
  return row?.weekly_minutes ?? null
}

export async function saveWeeklyGoal(userId: string, minutes: number | null): Promise<void> {
  const handle = await db()
  if (minutes === null) {
    await handle.runAsync(`DELETE FROM personal_activity_goal WHERE user_id = ?`, userId)
    return
  }
  await handle.runAsync(
    `INSERT INTO personal_activity_goal (user_id, weekly_minutes, updated_at)
     VALUES (?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET
       weekly_minutes = excluded.weekly_minutes,
       updated_at = excluded.updated_at`,
    userId, Math.max(0, Math.round(minutes)), new Date().toISOString(),
  )
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

// ── Health profile ───────────────────────────────────────────────────────────

/**
 * Belt-and-braces details that are not needed in an emergency: who you are, and
 * the cover you carry. Device-local, like everything else on this screen.
 */
export type HealthProfile = {
  dateOfBirth: string | null
  sex: string | null
  heightCm: number | null
  weightKg: number | null
  insuranceProvider: string | null
  insuranceNumber: string | null
  insurancePlan: string | null
  insuranceExpiry: string | null
  organDonor: boolean
  donorNumber: string | null
  updatedAt: string | null
}

type HealthProfileRow = {
  date_of_birth: string | null
  sex: string | null
  height_cm: number | null
  weight_kg: number | null
  insurance_provider: string | null
  insurance_number: string | null
  insurance_plan: string | null
  insurance_expiry: string | null
  organ_donor: number
  donor_number: string | null
  updated_at: string
}

const EMPTY_HEALTH_PROFILE: HealthProfile = {
  dateOfBirth: null,
  sex: null,
  heightCm: null,
  weightKg: null,
  insuranceProvider: null,
  insuranceNumber: null,
  insurancePlan: null,
  insuranceExpiry: null,
  organDonor: false,
  donorNumber: null,
  updatedAt: null,
}

export async function getHealthProfile(userId: string): Promise<HealthProfile> {
  const handle = await db()
  const row = await handle.getFirstAsync<HealthProfileRow>(
    `SELECT date_of_birth, sex, height_cm, weight_kg, insurance_provider, insurance_number,
            insurance_plan, insurance_expiry, organ_donor, donor_number, updated_at
       FROM personal_health_profile WHERE user_id = ?`,
    userId,
  )
  // A copy: callers hold this in screen state and edit it before saving. Handing
  // back the module constant would let one screen edit every later empty profile.
  if (!row) return { ...EMPTY_HEALTH_PROFILE }
  return {
    dateOfBirth: row.date_of_birth,
    sex: row.sex,
    heightCm: row.height_cm,
    weightKg: row.weight_kg,
    insuranceProvider: row.insurance_provider,
    insuranceNumber: row.insurance_number,
    insurancePlan: row.insurance_plan,
    insuranceExpiry: row.insurance_expiry,
    organDonor: row.organ_donor === 1,
    donorNumber: row.donor_number,
    updatedAt: row.updated_at,
  }
}

export async function saveHealthProfile(
  userId: string,
  input: Omit<HealthProfile, 'updatedAt'>,
): Promise<void> {
  const handle = await db()
  const clean = (value: string | null) => value?.trim() || null
  await handle.runAsync(
    `INSERT INTO personal_health_profile
       (user_id, date_of_birth, sex, height_cm, weight_kg, insurance_provider, insurance_number,
        insurance_plan, insurance_expiry, organ_donor, donor_number, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET
       date_of_birth = excluded.date_of_birth,
       sex = excluded.sex,
       height_cm = excluded.height_cm,
       weight_kg = excluded.weight_kg,
       insurance_provider = excluded.insurance_provider,
       insurance_number = excluded.insurance_number,
       insurance_plan = excluded.insurance_plan,
       insurance_expiry = excluded.insurance_expiry,
       organ_donor = excluded.organ_donor,
       donor_number = excluded.donor_number,
       updated_at = excluded.updated_at`,
    userId,
    clean(input.dateOfBirth),
    clean(input.sex),
    input.heightCm,
    input.weightKg,
    clean(input.insuranceProvider),
    clean(input.insuranceNumber),
    clean(input.insurancePlan),
    clean(input.insuranceExpiry),
    input.organDonor ? 1 : 0,
    clean(input.donorNumber),
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
  /** Doses left, when the person tracks a supply. */
  remaining: number | null
  /** Warn once `remaining` reaches this many. */
  refillAt: number | null
}

type MedicationRow = {
  id: string
  name: string
  dose: string | null
  schedule: string | null
  notes: string | null
  remaining: number | null
  refill_at: number | null
}

export async function listMedications(userId: string): Promise<Medication[]> {
  const handle = await db()
  const rows = await handle.getAllAsync<MedicationRow>(
    `SELECT m.id, m.name, m.dose, m.schedule, m.notes, s.remaining, s.refill_at
       FROM personal_medications m
       LEFT JOIN personal_medication_supply s
         ON s.medication_id = m.id AND s.user_id = m.user_id
      WHERE m.user_id = ? AND m.archived = 0 ORDER BY m.created_at ASC`,
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
      remaining: row.remaining,
      refillAt: row.refill_at,
    }
  })
}

export async function addMedication(input: {
  userId: string
  name: string
  dose?: string | null
  schedule?: string | null
  notes?: string | null
  /** Doses on hand right now; omit to leave the supply untracked. */
  remaining?: number | null
  refillAt?: number | null
}): Promise<string> {
  const handle = await db()
  const id = newId()
  const now = new Date().toISOString()
  await handle.runAsync(
    `INSERT INTO personal_medications (id, user_id, name, dose, schedule, notes, created_at, archived)
     VALUES (?, ?, ?, ?, ?, ?, ?, 0)`,
    id, input.userId, input.name.trim(), input.dose?.trim() || null,
    input.schedule?.trim() || null, input.notes?.trim() || null, now,
  )
  if (input.remaining != null) {
    await setMedicationSupply(input.userId, id, input.remaining, input.refillAt ?? 5)
  }
  return id
}

export async function setMedicationSupply(
  userId: string,
  medicationId: string,
  remaining: number,
  refillAt: number,
): Promise<void> {
  const handle = await db()
  await handle.runAsync(
    `INSERT INTO personal_medication_supply (medication_id, user_id, remaining, refill_at, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(medication_id) DO UPDATE SET
       remaining = excluded.remaining,
       refill_at = excluded.refill_at,
       updated_at = excluded.updated_at`,
    medicationId, userId, Math.max(0, Math.round(remaining)),
    Math.max(0, Math.round(refillAt)), new Date().toISOString(),
  )
}

/** Removes the medication, its adherence history and its supply count. */
export async function removeMedication(userId: string, id: string): Promise<void> {
  const handle = await db()
  await handle.runAsync(`DELETE FROM personal_medication_logs WHERE user_id = ? AND medication_id = ?`, userId, id)
  await handle.runAsync(`DELETE FROM personal_medication_supply WHERE user_id = ? AND medication_id = ?`, userId, id)
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
  await handle.runAsync(
    `UPDATE personal_medication_supply
        SET remaining = MAX(remaining - 1, 0), updated_at = ?
      WHERE user_id = ? AND medication_id = ?`,
    now.toISOString(), userId, medicationId,
  )
}

// ── Reminders ────────────────────────────────────────────────────────────────

export type ReminderKind = 'medicine' | 'appointment'

export type Reminder = {
  id: string
  kind: ReminderKind
  title: string
  detail: string | null
  medicationId: string | null
  /** Local hour, 0–23. */
  hour: number
  minute: number
  /** ISO instant the appointment starts. Null for a daily medicine nudge. */
  appointmentAt: string | null
  /** Minutes before the appointment that the alert fires. */
  leadMinutes: number
  /** Identifier of the OS-level scheduled notification, when one is live. */
  notificationId: string | null
  enabled: boolean
}

type ReminderRow = {
  id: string
  kind: string
  title: string
  detail: string | null
  medication_id: string | null
  hour: number
  minute: number
  appointment_at: string | null
  lead_minutes: number
  notification_id: string | null
  enabled: number
}

export async function listReminders(userId: string): Promise<Reminder[]> {
  const handle = await db()
  const rows = await handle.getAllAsync<ReminderRow>(
    `SELECT id, kind, title, detail, medication_id, hour, minute, appointment_at,
            lead_minutes, notification_id, enabled
       FROM personal_reminders WHERE user_id = ?
       ORDER BY enabled DESC, hour ASC, minute ASC`,
    userId,
  )
  return rows.map((row) => ({
    id: row.id,
    kind: row.kind as ReminderKind,
    title: row.title,
    detail: row.detail,
    medicationId: row.medication_id,
    hour: row.hour,
    minute: row.minute,
    appointmentAt: row.appointment_at,
    leadMinutes: row.lead_minutes,
    notificationId: row.notification_id,
    enabled: row.enabled === 1,
  }))
}

export async function addMedicineReminder(input: {
  userId: string
  medicationId: string
  title: string
  hour: number
  minute: number
}): Promise<void> {
  const handle = await db()
  // One row per medicine per time. A repeat add keeps the row the device already
  // has (and its tick history) instead of scheduling a second identical alert.
  const existing = await handle.getFirstAsync<{ id: string }>(
    `SELECT id FROM personal_reminders
      WHERE user_id = ? AND kind = 'medicine' AND medication_id = ? AND hour = ? AND minute = ?
      LIMIT 1`,
    input.userId, input.medicationId, input.hour, input.minute,
  )
  if (existing) {
    await handle.runAsync(
      `UPDATE personal_reminders SET enabled = 1 WHERE user_id = ? AND id = ?`,
      input.userId, existing.id,
    )
    return
  }
  await handle.runAsync(
    `INSERT INTO personal_reminders
       (id, user_id, kind, title, detail, medication_id, hour, minute,
        appointment_at, lead_minutes, notification_id, enabled, created_at)
     VALUES (?, ?, 'medicine', ?, NULL, ?, ?, ?, NULL, 0, NULL, 1, ?)`,
    newId(), input.userId, input.title.trim(), input.medicationId,
    input.hour, input.minute, new Date().toISOString(),
  )
}

export async function addAppointmentReminder(input: {
  userId: string
  title: string
  detail?: string | null
  appointmentAt: string
  leadMinutes: number
}): Promise<void> {
  const handle = await db()
  const at = new Date(input.appointmentAt)
  await handle.runAsync(
    `INSERT INTO personal_reminders
       (id, user_id, kind, title, detail, medication_id, hour, minute,
        appointment_at, lead_minutes, notification_id, enabled, created_at)
     VALUES (?, ?, 'appointment', ?, ?, NULL, ?, ?, ?, ?, NULL, 1, ?)`,
    newId(), input.userId, input.title.trim(), input.detail?.trim() || null,
    at.getHours(), at.getMinutes(), at.toISOString(), Math.max(0, Math.round(input.leadMinutes)),
    new Date().toISOString(),
  )
}

export async function setReminderEnabled(userId: string, id: string, enabled: boolean): Promise<void> {
  const handle = await db()
  await handle.runAsync(
    `UPDATE personal_reminders SET enabled = ? WHERE user_id = ? AND id = ?`,
    enabled ? 1 : 0, userId, id,
  )
}

export async function saveReminderNotificationId(
  userId: string,
  id: string,
  notificationId: string | null,
): Promise<void> {
  const handle = await db()
  await handle.runAsync(
    `UPDATE personal_reminders SET notification_id = ? WHERE user_id = ? AND id = ?`,
    notificationId, userId, id,
  )
}

export async function deleteReminder(userId: string, id: string): Promise<void> {
  const handle = await db()
  await handle.runAsync(`DELETE FROM personal_reminders WHERE user_id = ? AND id = ?`, userId, id)
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
