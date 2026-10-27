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
