import * as Notifications from 'expo-notifications'
import { Platform } from 'react-native'
import { listReminders, saveReminderNotificationId, type Reminder } from './personal-store'

/**
 * Local reminder scheduling for the personal area.
 *
 * Everything here is a device-local notification: no push service, no server
 * round trip, nothing about a medicine or an appointment leaves the phone. The
 * notification only says what the account itself entered — it never suggests a
 * dose or interprets a symptom.
 */

export const REMINDER_CHANNEL_ID = 'health-reminders'
const REMINDER_SOURCE = 'health-reminders'
const REMINDERS_LINK = '/personal/reminders'

export type ReminderPermission = {
  granted: boolean
  canAskAgain: boolean
}

export async function reminderPermission(): Promise<ReminderPermission> {
  const current = await Notifications.getPermissionsAsync()
  return { granted: current.granted, canAskAgain: current.canAskAgain }
}

export async function requestReminderPermission(): Promise<ReminderPermission> {
  const requested = await Notifications.requestPermissionsAsync()
  return { granted: requested.granted, canAskAgain: requested.canAskAgain }
}

export async function ensureReminderChannel(): Promise<void> {
  if (Platform.OS !== 'android') return
  await Notifications.setNotificationChannelAsync(REMINDER_CHANNEL_ID, {
    name: 'Health reminders',
    importance: Notifications.AndroidImportance.DEFAULT,
  })
}

type ReminderPlan = {
  trigger: Notifications.NotificationTriggerInput
  /**
   * What this reminder is currently meant to do, stored on the request itself.
   * Comparing it is what detects a changed time — the OS trigger object is not
   * read back reliably across platforms.
   */
  key: string
}

function planFor(reminder: Reminder): ReminderPlan | null {
  if (reminder.kind === 'medicine') {
    return {
      key: `daily:${reminder.hour}:${reminder.minute}`,
      trigger: {
        type: Notifications.SchedulableTriggerInputTypes.DAILY,
        hour: reminder.hour,
        minute: reminder.minute,
        channelId: REMINDER_CHANNEL_ID,
      },
    }
  }
  if (!reminder.appointmentAt) return null
  const startsAt = Date.parse(reminder.appointmentAt)
  if (Number.isNaN(startsAt)) return null
  const fireAt = startsAt - reminder.leadMinutes * 60_000
  if (fireAt <= Date.now()) return null
  return {
    key: `date:${fireAt}`,
    trigger: {
      type: Notifications.SchedulableTriggerInputTypes.DATE,
      date: new Date(fireAt),
      channelId: REMINDER_CHANNEL_ID,
    },
  }
}

function contentFor(reminder: Reminder, scheduleKey: string): Notifications.NotificationContentInput {
  const body =
    reminder.kind === 'medicine'
      ? reminder.detail?.trim() || 'Open the app to tick it off.'
      : reminder.detail?.trim() || 'Open the app to see the details.'
  return {
    title: reminder.kind === 'medicine' ? reminder.title : `Coming up: ${reminder.title}`,
    body,
    data: { source: REMINDER_SOURCE, reminderId: reminder.id, scheduleKey, url: REMINDERS_LINK },
  }
}

async function scheduleReminder(reminder: Reminder, plan: ReminderPlan): Promise<string | null> {
  return Notifications.scheduleNotificationAsync({
    content: contentFor(reminder, plan.key),
    trigger: plan.trigger,
  })
}

function reminderIdOf(request: Notifications.NotificationRequest): string | null {
  const data = request.content.data as Record<string, unknown> | null | undefined
  if (!data || data.source !== REMINDER_SOURCE) return null
  return typeof data.reminderId === 'string' ? data.reminderId : null
}

function scheduleKeyOf(request: Notifications.NotificationRequest): string | null {
  const data = request.content.data as Record<string, unknown> | null | undefined
  if (!data || data.source !== REMINDER_SOURCE) return null
  return typeof data.scheduleKey === 'string' ? data.scheduleKey : null
}

let syncing = false

/**
 * Brings the OS schedule in line with the rows on this device: schedules what
 * is missing, drops what was disabled or deleted, and re-schedules anything the
 * OS forgot (a reinstall clears the queue but not the database).
 *
 * Without notification permission nothing is scheduled and nothing is lost —
 * the rows stay and the next sync after permission is granted picks them up.
 */
export async function syncReminders(userId: string): Promise<Reminder[]> {
  const reminders = await listReminders(userId)
  if (syncing) return reminders
  syncing = true
  try {
    await ensureReminderChannel()
    const { granted } = await reminderPermission()
    const scheduled = await Notifications.getAllScheduledNotificationsAsync().catch(() => [])
    const live = new Map(scheduled.map((request) => [request.identifier, request]))

    for (const reminder of reminders) {
      const wanted = reminder.enabled ? planFor(reminder) : null
      const existing = reminder.notificationId ? live.get(reminder.notificationId) : undefined

      if (!wanted) {
        if (existing) {
          await Notifications.cancelScheduledNotificationAsync(existing.identifier).catch(() => {})
        }
        if (reminder.notificationId) {
          await saveReminderNotificationId(userId, reminder.id, null)
          reminder.notificationId = null
        }
        continue
      }

      if (!granted) continue
      // Same reminder at the same schedule is already queued. A stored time that
      // no longer matches — or a request written before the key existed — has to
      // be replaced, or the phone keeps firing the old alert.
      if (existing && reminderIdOf(existing) === reminder.id && scheduleKeyOf(existing) === wanted.key) {
        continue
      }

      if (existing) {
        await Notifications.cancelScheduledNotificationAsync(existing.identifier).catch(() => {})
      }
      const identifier = await scheduleReminder(reminder, wanted).catch(() => null)
      if (!identifier) continue
      await saveReminderNotificationId(userId, reminder.id, identifier)
      reminder.notificationId = identifier
    }

    const known = new Set(reminders.map((reminder) => reminder.id))
    for (const request of scheduled) {
      const reminderId = reminderIdOf(request)
      if (!reminderId || known.has(reminderId)) continue
      await Notifications.cancelScheduledNotificationAsync(request.identifier).catch(() => {})
    }
  } finally {
    syncing = false
  }
  return reminders
}

export async function cancelReminderNotification(reminder: Reminder): Promise<void> {
  if (!reminder.notificationId) return
  await Notifications.cancelScheduledNotificationAsync(reminder.notificationId).catch(() => {})
}

/** The soonest enabled reminder, as a short label, or null when there is none. */
export function nextReminderLabel(reminders: Reminder[], now: Date = new Date()): string | null {
  const upcoming: Array<{ at: number; label: string }> = []
  for (const reminder of reminders) {
    if (!reminder.enabled) continue
    if (reminder.kind === 'medicine') {
      const at = new Date(now)
      at.setHours(reminder.hour, reminder.minute, 0, 0)
      const passed = at.getTime() <= now.getTime()
      if (passed) at.setDate(at.getDate() + 1)
      upcoming.push({
        at: at.getTime(),
        label: `${passed ? 'Tomorrow' : 'Today'} ${clock(reminder.hour, reminder.minute)}`,
      })
      continue
    }
    if (!reminder.appointmentAt) continue
    const startsAt = Date.parse(reminder.appointmentAt)
    if (Number.isNaN(startsAt) || startsAt <= now.getTime()) continue
    upcoming.push({ at: startsAt, label: reminder.title })
  }
  if (upcoming.length === 0) return null
  upcoming.sort((a, b) => a.at - b.at)
  return upcoming[0].label
}

export function clock(hour: number, minute: number): string {
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`
}
