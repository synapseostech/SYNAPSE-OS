import { useCallback, useState } from 'react'
import { Alert, Linking, Pressable, ScrollView, StyleSheet, Switch, Text, View } from 'react-native'
import { useFocusEffect, useRouter } from 'expo-router'
import { Ionicons } from '@expo/vector-icons'
import { Button } from '@/components/ui/Button'
import { Card, SectionHeader } from '@/components/ui/Card'
import { ChoiceChips } from '@/components/ui/ChoiceChips'
import { Screen } from '@/components/ui/Screen'
import { TextField } from '@/components/ui/TextField'
import { useAuth } from '@/lib/auth'
import { dayInputValue, parseDayInput } from '@/lib/dates'
import {
  addAppointmentReminder,
  addMedicineReminder,
  deleteReminder,
  listMedications,
  listReminders,
  setReminderEnabled,
  type Medication,
  type Reminder,
} from '@/lib/personal-store'
import {
  cancelReminderNotification,
  clock,
  reminderPermission,
  requestReminderPermission,
  syncReminders,
  type ReminderPermission,
} from '@/lib/reminders'
import { radii, spacing, typography, useTheme } from '@/lib/theme'

const LEAD_OPTIONS = [
  { value: '0', label: 'At the time' },
  { value: '15', label: '15 min before' },
  { value: '60', label: '1 hour before' },
  { value: '1440', label: '1 day before' },
] as const

type Lead = (typeof LEAD_OPTIONS)[number]['value']

function inDays(days: number): string {
  const date = new Date()
  date.setDate(date.getDate() + days)
  return dayInputValue(date)
}

function leadLabel(minutes: number): string {
  if (minutes <= 0) return 'at the time'
  if (minutes < 60) return `${minutes} min before`
  if (minutes < 1440) {
    const hours = Math.round(minutes / 60)
    return `${hours} hour${hours === 1 ? '' : 's'} before`
  }
  const days = Math.round(minutes / 1440)
  return `${days} day${days === 1 ? '' : 's'} before`
}

function reminderWhen(reminder: Reminder): string {
  if (reminder.kind === 'medicine') {
    return `Every day at ${clock(reminder.hour, reminder.minute)}`
  }
  if (!reminder.appointmentAt) return 'Date missing'
  const at = new Date(reminder.appointmentAt)
  if (Number.isNaN(at.getTime())) return 'Date missing'
  const when = at.toLocaleString(undefined, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  })
  return `${when} · ${leadLabel(reminder.leadMinutes)}`
}

export default function PersonalRemindersScreen() {
  const { user } = useAuth()
  const router = useRouter()
  const { colors } = useTheme()

  const [reminders, setReminders] = useState<Reminder[]>([])
  const [medications, setMedications] = useState<Medication[]>([])
  const [permission, setPermission] = useState<ReminderPermission | null>(null)

  const [medicationId, setMedicationId] = useState<string | null>(null)
  const [medHour, setMedHour] = useState(8)
  const [medMinute, setMedMinute] = useState(0)

  const [title, setTitle] = useState('')
  const [date, setDate] = useState(() => inDays(7))
  const [apptHour, setApptHour] = useState(9)
  const [apptMinute, setApptMinute] = useState(0)
  const [lead, setLead] = useState<Lead>('60')

  const [error, setError] = useState<string | null>(null)
  const [savingSchedule, setSavingSchedule] = useState(false)
  const [savingAppointment, setSavingAppointment] = useState(false)
  const [busyId, setBusyId] = useState<string | null>(null)

  const userId = user?.id

  const reload = useCallback(async () => {
    if (!userId) return
    try {
      setReminders(await syncReminders(userId))
    } catch {
      setReminders(await listReminders(userId).catch(() => []))
    }
    setMedications(await listMedications(userId).catch(() => []))
    setPermission(
      await reminderPermission().catch(() => ({ granted: false, canAskAgain: true })),
    )
  }, [userId])

  useFocusEffect(
    useCallback(() => {
      void reload()
    }, [reload]),
  )

  const allowNotifications = async () => {
    setError(null)
    const next = await requestReminderPermission().catch(() => ({ granted: false, canAskAgain: false }))
    setPermission(next)
    if (next.granted) {
      await reload()
      return
    }
    if (!next.canAskAgain) {
      await Linking.openSettings().catch(() => {})
    }
  }

  const addMedicine = async () => {
    setError(null)
    if (!userId) return
    const medication = medications.find((item) => item.id === medicationId)
    if (!medication) {
      setError('Choose which medicine this reminder is for.')
      return
    }
    setSavingSchedule(true)
    try {
      await addMedicineReminder({
        userId,
        medicationId: medication.id,
        title: medication.name,
        hour: medHour,
        minute: medMinute,
      })
      await reload()
    } catch {
      setError('Could not save the reminder on this device.')
    } finally {
      setSavingSchedule(false)
    }
  }

  const addAppointment = async () => {
    setError(null)
    if (!userId) return
    if (!title.trim()) {
      setError('Give the appointment a name, for example "Dental check-up".')
      return
    }
    const day = parseDayInput(date)
    if (!day) {
      setError('Enter the date as YYYY-MM-DD.')
      return
    }
    const startsAt = new Date(day.getFullYear(), day.getMonth(), day.getDate(), apptHour, apptMinute)
    const leadMinutes = Number(lead)
    if (startsAt.getTime() <= Date.now()) {
      setError('That date and time have already passed.')
      return
    }
    if (startsAt.getTime() - leadMinutes * 60_000 <= Date.now()) {
      setError('That is too soon for this notice — choose a later time or a shorter warning.')
      return
    }
    setSavingAppointment(true)
    try {
      await addAppointmentReminder({
        userId,
        title,
        appointmentAt: startsAt.toISOString(),
        leadMinutes,
      })
      setTitle('')
      await reload()
    } catch {
      setError('Could not save the appointment on this device.')
    } finally {
      setSavingAppointment(false)
    }
  }

  const toggle = async (reminder: Reminder, enabled: boolean) => {
    if (!userId) return
    setBusyId(reminder.id)
    try {
      await setReminderEnabled(userId, reminder.id, enabled)
      await reload()
    } catch {
      setError('Could not update the reminder on this device.')
    } finally {
      setBusyId(null)
    }
  }

  const remove = (reminder: Reminder) => {
    Alert.alert(
      'Delete reminder',
      `Delete the reminder for ${reminder.title}?`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: async () => {
            if (!userId) return
            await cancelReminderNotification(reminder)
            await deleteReminder(userId, reminder.id)
            await reload()
          },
        },
      ],
    )
  }

  const medicationOptions = medications.map((medication) => ({
    value: medication.id,
    label: medication.name,
  }))

  const activeCount = reminders.filter((reminder) => reminder.enabled).length

  return (
    <Screen>
      <ScrollView contentContainerStyle={styles.scroll} showsVerticalScrollIndicator={false}>
        {permission && !permission.granted ? (
          <Card style={styles.permissionCard}>
            <View style={styles.permissionHead}>
              <Ionicons name="notifications-off-outline" size={20} color={colors.textSecondary} />
              <Text style={[styles.permissionTitle, { color: colors.text }]}>
                Notifications are off
              </Text>
            </View>
            <Text style={[styles.permissionBody, { color: colors.textSecondary }]}>
              Reminders are saved either way, but nothing appears until you allow notifications for
              Synapse.
            </Text>
            <Button
              label={permission.canAskAgain ? 'Allow notifications' : 'Open settings'}
              onPress={allowNotifications}
            />
          </Card>
        ) : null}

        <SectionHeader title="Medicine reminder" />
        <Card style={styles.formCard}>
          {medications.length === 0 ? (
            <>
              <Text style={[styles.empty, { color: colors.textMuted }]}>
                Add a medicine first — a reminder has to point at one of your own entries.
              </Text>
              <Button
                label="Add a medicine"
                variant="ghost"
                onPress={() => router.push('/(personal)/medications' as never)}
              />
            </>
          ) : (
            <>
              <ChoiceChips
                label="Medicine"
                options={medicationOptions}
                value={medicationId}
                onChange={setMedicationId}
              />
              <TimeControls
                label="Nudge me at"
                hour={medHour}
                minute={medMinute}
                onChange={(hour, minute) => {
                  setMedHour(hour)
                  setMedMinute(minute)
                }}
              />
              <Button label="Add daily reminder" onPress={addMedicine} loading={savingSchedule} />
            </>
          )}
        </Card>

        <SectionHeader title="Appointment" style={styles.spacer} />
        <Card style={styles.formCard}>
          <TextField
            label="What is it for?"
            value={title}
            onChangeText={setTitle}
            placeholder="e.g. Dental check-up"
            autoCapitalize="sentences"
          />
          <TextField
            label="Date"
            value={date}
            onChangeText={setDate}
            placeholder="YYYY-MM-DD"
            keyboardType="numbers-and-punctuation"
            autoCorrect={false}
          />
          <TimeControls
            label="Starts at"
            hour={apptHour}
            minute={apptMinute}
            onChange={(hour, minute) => {
              setApptHour(hour)
              setApptMinute(minute)
            }}
          />
          <ChoiceChips label="Warn me" options={LEAD_OPTIONS} value={lead} onChange={setLead} />
          <Button label="Add appointment alert" onPress={addAppointment} loading={savingAppointment} />
        </Card>

        {error ? <Text style={[styles.error, { color: colors.error }]}>{error}</Text> : null}

        <SectionHeader title="Your reminders" style={styles.spacer} />
        {reminders.length === 0 ? (
          <Card>
            <Text style={[styles.empty, { color: colors.textMuted }]}>
              Nothing set. A reminder is just a nudge you write for yourself — it does not know
              your dose and will not tell you to take anything.
            </Text>
          </Card>
        ) : (
          <>
            <Text style={[styles.count, { color: colors.textSecondary }]}>
              {activeCount} of {reminders.length} switched on
            </Text>
            <View style={styles.list}>
              {reminders.map((reminder) => (
                <Pressable
                  key={reminder.id}
                  onLongPress={() => remove(reminder)}
                  accessibilityRole="button"
                  accessibilityLabel={`${reminder.title}, ${reminderWhen(reminder)}, long press to delete`}
                >
                  <Card>
                    <View style={styles.itemHead}>
                      <Ionicons
                        name={reminder.kind === 'medicine' ? 'medkit-outline' : 'calendar-outline'}
                        size={20}
                        color={colors.primary}
                      />
                      <View style={styles.itemText}>
                        <Text style={[styles.itemName, { color: colors.text }]}>
                          {reminder.title}
                        </Text>
                        <Text style={[styles.itemMeta, { color: colors.textSecondary }]}>
                          {reminderWhen(reminder)}
                        </Text>
                      </View>
                      <Switch
                        value={reminder.enabled}
                        onValueChange={(value) => toggle(reminder, value)}
                        disabled={busyId === reminder.id}
                        trackColor={{ true: colors.primary }}
                        accessibilityLabel={`${reminder.title} reminder`}
                      />
                    </View>
                    {reminder.enabled && permission && !permission.granted ? (
                      <Text style={[styles.itemWarning, { color: colors.textMuted }]}>
                        Saved, but notifications are off — this one will not appear.
                      </Text>
                    ) : null}
                  </Card>
                </Pressable>
              ))}
            </View>
          </>
        )}

        <Text style={[styles.hint, { color: colors.textMuted }]}>
          Long press a reminder to delete it. Alerts are created on this phone only; nothing about
          your medicines or appointments is sent anywhere.
        </Text>
      </ScrollView>
    </Screen>
  )
}

function TimeControls({
  label,
  hour,
  minute,
  onChange,
}: {
  label: string
  hour: number
  minute: number
  onChange: (hour: number, minute: number) => void
}) {
  const { colors } = useTheme()
  const shift = (deltaMinutes: number) => {
    const total = (hour * 60 + minute + deltaMinutes + 1440) % 1440
    onChange(Math.floor(total / 60), total % 60)
  }
  return (
    <View style={styles.timeWrap}>
      <Text style={[styles.timeLabel, { color: colors.textSecondary }]}>
        {label} · {clock(hour, minute)}
      </Text>
      <View style={styles.timeRow}>
        <Stepper
          label="Hour"
          value={String(hour).padStart(2, '0')}
          onDecrement={() => shift(-60)}
          onIncrement={() => shift(60)}
        />
        <Stepper
          label="Minute"
          value={String(minute).padStart(2, '0')}
          onDecrement={() => shift(-5)}
          onIncrement={() => shift(5)}
        />
      </View>
    </View>
  )
}

function Stepper({
  label,
  value,
  onDecrement,
  onIncrement,
}: {
  label: string
  value: string
  onDecrement: () => void
  onIncrement: () => void
}) {
  const { colors } = useTheme()
  return (
    <View style={styles.stepper}>
      <Text style={[styles.stepperLabel, { color: colors.textMuted }]}>{label}</Text>
      <View style={styles.stepperRow}>
        <Pressable
          onPress={onDecrement}
          hitSlop={10}
          accessibilityRole="button"
          accessibilityLabel={`Decrease ${label.toLowerCase()}`}
        >
          <Ionicons name="remove-circle-outline" size={28} color={colors.primary} />
        </Pressable>
        <Text style={[styles.stepperValue, { color: colors.text }]}>{value}</Text>
        <Pressable
          onPress={onIncrement}
          hitSlop={10}
          accessibilityRole="button"
          accessibilityLabel={`Increase ${label.toLowerCase()}`}
        >
          <Ionicons name="add-circle-outline" size={28} color={colors.primary} />
        </Pressable>
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  scroll: { padding: spacing.xxl, gap: spacing.md },
  permissionCard: { gap: spacing.md },
  permissionHead: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  permissionTitle: { ...typography.bodyMedium, fontFamily: 'DMSans_500Medium' },
  permissionBody: { ...typography.caption, fontFamily: 'DMSans_400Regular', lineHeight: 18 },
  formCard: { gap: spacing.xs },
  empty: { ...typography.caption, fontFamily: 'DMSans_400Regular', lineHeight: 18 },
  spacer: { marginTop: spacing.lg },
  error: { ...typography.caption, marginTop: spacing.md, textAlign: 'center' },
  count: { ...typography.caption, marginBottom: spacing.sm },
  list: { gap: spacing.sm },
  itemHead: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  itemText: { flex: 1, gap: 2 },
  itemName: { ...typography.bodyMedium, fontFamily: 'DMSans_500Medium' },
  itemMeta: { ...typography.caption },
  itemWarning: { ...typography.caption, marginTop: spacing.sm },
  timeWrap: { marginBottom: spacing.lg },
  timeLabel: { ...typography.label, marginBottom: spacing.sm },
  timeRow: { flexDirection: 'row', gap: spacing.xl },
  stepper: { gap: 4 },
  stepperLabel: { ...typography.caption },
  stepperRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  stepperValue: { ...typography.bodyMedium, fontFamily: 'DMSans_500Medium', minWidth: 30, textAlign: 'center' },
  hint: {
    ...typography.caption,
    fontFamily: 'DMSans_400Regular',
    lineHeight: 18,
    marginTop: spacing.lg,
    textAlign: 'center',
  },
})
