import { useCallback, useState } from 'react'
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import { useFocusEffect, useRouter } from 'expo-router'
import { Ionicons } from '@expo/vector-icons'
import { Card, SectionHeader } from '@/components/ui/Card'
import { Screen } from '@/components/ui/Screen'
import { useAuth } from '@/lib/auth'
import { localDay } from '@/lib/personal-store'
import {
  getHealthProfile,
  getMedicalId,
  getWeeklyGoal,
  listActivity,
  listHabits,
  listMedications,
  listReminders,
  listSymptoms,
  listVitals,
  weeklyActivityMinutes,
  type ActivityEntry,
  type Habit,
  type HealthProfile,
  type MedicalId,
  type Medication,
  type Reminder,
  type SymptomEntry,
  type VitalsReading,
} from '@/lib/personal-store'
import { radii, spacing, typography, useTheme } from '@/lib/theme'

type CoachData = {
  weeklyMinutes: number
  goal: number | null
  activity: ActivityEntry[]
  habits: Habit[]
  medications: Medication[]
  symptoms: SymptomEntry[]
  reminders: Reminder[]
  bp: VitalsReading | undefined
  glucose: VitalsReading | undefined
  medicalId: MedicalId
  profile: HealthProfile
}

type Insight = {
  key: string
  icon: keyof typeof Ionicons.glyphMap
  title: string
  detail: string
  route?: string
}

function daysAgoIso(days: number): number {
  const date = new Date()
  date.setDate(date.getDate() - days)
  date.setHours(0, 0, 0, 0)
  return date.getTime()
}

function whenLabel(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return 'Recorded'
  const days = Math.floor((Date.now() - date.getTime()) / 86_400_000)
  if (days <= 0) return 'Today'
  if (days === 1) return 'Yesterday'
  if (days < 7) return `${days} days ago`
  return date.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })
}

/**
 * Reads the person's own entries back to them. Deliberately arithmetic only:
 * it compares numbers they typed, counts what they logged, and names the next
 * thing they could do. It never interprets a reading or suggests a dose.
 */
function buildInsights(data: CoachData): Insight[] {
  const insights: Insight[] = []

  const weekStart = new Date()
  weekStart.setDate(weekStart.getDate() - 6)
  const weekStartDay = localDay(weekStart)
  const activityDays = new Set(
    data.activity.filter((entry) => entry.loggedOn >= weekStartDay).map((entry) => entry.loggedOn),
  )
  if (data.goal == null) {
    insights.push({
      key: 'goal',
      icon: 'flag-outline',
      title: 'No weekly goal set',
      detail: `You recorded ${data.weeklyMinutes} minutes in the last 7 days. Pick a target on the Activity screen if you want one.`,
      route: '/(personal)/activity',
    })
  } else if (data.weeklyMinutes >= data.goal) {
    insights.push({
      key: 'goal',
      icon: 'checkmark-circle-outline',
      title: 'You reached your own goal',
      detail: `${data.weeklyMinutes} of ${data.goal} minutes in the last 7 days, across ${activityDays.size} day${
        activityDays.size === 1 ? '' : 's'
      }.`,
      route: '/(personal)/activity',
    })
  } else {
    insights.push({
      key: 'goal',
      icon: 'flag-outline',
      title: `${data.goal - data.weeklyMinutes} minutes short of your goal`,
      detail: `${data.weeklyMinutes} of ${data.goal} minutes in the last 7 days, across ${activityDays.size} day${
        activityDays.size === 1 ? '' : 's'
      }. The goal is the one you set yourself.`,
      route: '/(personal)/activity',
    })
  }

  if (data.habits.length === 0) {
    insights.push({
      key: 'habits',
      icon: 'checkbox-outline',
      title: 'No habits set up',
      detail: 'A habit is something you tick off, such as a glass of water or an early night.',
      route: '/(personal)/habits',
    })
  } else {
    const done = data.habits.filter((habit) => habit.loggedToday).length
    const best = [...data.habits].sort((a, b) => b.streak - a.streak)[0]
    insights.push({
      key: 'habits',
      icon: 'checkbox-outline',
      title: `${done} of ${data.habits.length} habits ticked today`,
      detail:
        best && best.streak > 1
          ? `Longest current run: ${best.streak} days on ${best.name}.`
          : 'Nothing long-running yet — a tick today starts the count.',
      route: '/(personal)/habits',
    })
  }

  if (data.medications.length === 0) {
    insights.push({
      key: 'medicines',
      icon: 'medkit-outline',
      title: 'No medicines added',
      detail: 'Add what you take if you want the daily tick-off and the dose count.',
      route: '/(personal)/medications',
    })
  } else {
    const taken = data.medications.filter((medication) => medication.takenToday).length
    const weekTicks = data.medications.reduce(
      (total, medication) => total + medication.daysTakenLastWeek,
      0,
    )
    const possible = data.medications.length * 7
    insights.push({
      key: 'medicines',
      icon: 'medkit-outline',
      title: `${taken} of ${data.medications.length} medicines ticked today`,
      detail: `You ticked ${weekTicks} of ${possible} possible days in the last 7. Patients often skip without meaning to — this counts ticks, not doses taken.`,
      route: '/(personal)/medications',
    })

    const low = data.medications.filter(
      (medication) =>
        medication.remaining != null && medication.remaining <= (medication.refillAt ?? 0),
    )
    if (low.length > 0) {
      insights.push({
        key: 'supply',
        icon: 'cube-outline',
        title: low.length === 1 ? `${low[0].name} is running low` : `${low.length} medicines are running low`,
        detail: `${low
          .map((medication) => `${medication.name}: ${medication.remaining} left`)
          .join(', ')}. That is your own count, not a prescription check.`,
        route: '/(personal)/medications',
      })
    }
  }

  if (data.reminders.length > 0) {
    const on = data.reminders.filter((reminder) => reminder.enabled).length
    insights.push({
      key: 'reminders',
      icon: 'notifications-outline',
      title: `${on} reminder${on === 1 ? '' : 's'} switched on`,
      detail:
        on === data.reminders.length
          ? 'Every reminder you set is active.'
          : `${data.reminders.length - on} switched off.`,
      route: '/(personal)/reminders',
    })
  }

  const symptomCutoff = daysAgoIso(7)
  const recentSymptoms = data.symptoms.filter((entry) => {
    const at = new Date(entry.occurredAt).getTime()
    return Number.isFinite(at) && at >= symptomCutoff
  })
  if (recentSymptoms.length > 0) {
    insights.push({
      key: 'symptoms',
      icon: 'pulse-outline',
      title: `${recentSymptoms.length} symptom${recentSymptoms.length === 1 ? '' : 's'} logged this week`,
      detail: `The most recent was ${recentSymptoms[0].symptom} at severity ${recentSymptoms[0].severity} of 5, ${whenLabel(
        recentSymptoms[0].occurredAt,
      ).toLowerCase()}. The app does not judge what a symptom means.`,
      route: '/(personal)/journal',
    })
  }

  const readings: string[] = []
  if (data.bp?.recordedAt) {
    readings.push(
      `Blood pressure ${data.bp.systolic ?? '—'}/${data.bp.diastolic ?? '—'} (${whenLabel(data.bp.recordedAt).toLowerCase()})`,
    )
  }
  if (data.glucose?.recordedAt) {
    readings.push(
      `Glucose ${data.glucose.value ?? '—'}${data.glucose.unit ? ` ${data.glucose.unit}` : ''} (${whenLabel(
        data.glucose.recordedAt,
      ).toLowerCase()})`,
    )
  }
  if (readings.length > 0) {
    insights.push({
      key: 'vitals',
      icon: 'analytics-outline',
      title: 'Your latest readings',
      detail: `${readings.join('. ')}. Read back as you entered them — the app does not say whether a number is in range.`,
      route: '/(personal)/vitals',
    })
  }

  const missing: string[] = []
  if (!data.medicalId.bloodGroup) missing.push('blood group')
  if (!data.medicalId.emergencyName || !data.medicalId.emergencyPhone) missing.push('emergency contact')
  if (!data.profile.insuranceProvider) missing.push('insurance')
  if (missing.length > 0) {
    insights.push({
      key: 'profile',
      icon: 'id-card-outline',
      title: 'Your health profile is incomplete',
      detail: `Not filled in: ${missing.join(', ')}. Useful to have written down before you need it.`,
      route: '/(personal)/medical-id',
    })
  }

  return insights
}

export default function PersonalCoachScreen() {
  const { user } = useAuth()
  const router = useRouter()
  const { colors } = useTheme()
  const [data, setData] = useState<CoachData | null>(null)
  const [error, setError] = useState<string | null>(null)

  const userId = user?.id

  useFocusEffect(
    useCallback(() => {
      let active = true
      if (!userId) return
      ;(async () => {
        try {
          const [
            weeklyMinutes,
            goal,
            activity,
            habits,
            medications,
            symptoms,
            reminders,
            bp,
            glucose,
            medicalId,
            profile,
          ] = await Promise.all([
            weeklyActivityMinutes(userId),
            getWeeklyGoal(userId),
            listActivity(userId),
            listHabits(userId),
            listMedications(userId),
            listSymptoms(userId),
            listReminders(userId),
            listVitals(userId, 'blood_pressure', 1),
            listVitals(userId, 'glucose', 1),
            getMedicalId(userId),
            getHealthProfile(userId),
          ])
          if (!active) return
          setData({
            weeklyMinutes,
            goal,
            activity,
            habits,
            medications,
            symptoms,
            reminders,
            bp: bp[0],
            glucose: glucose[0],
            medicalId,
            profile,
          })
        } catch {
          if (active) setError('Could not read what you have logged on this device.')
        }
      })()
      return () => {
        active = false
      }
    }, [userId]),
  )

  const insights = data ? buildInsights(data) : []
  const today = new Date().toLocaleDateString(undefined, { day: 'numeric', month: 'short' })

  return (
    <Screen>
      <ScrollView contentContainerStyle={styles.scroll} showsVerticalScrollIndicator={false}>
        <Card style={styles.leadCard}>
          <View style={styles.leadHead}>
            <Ionicons name="sparkles-outline" size={22} color={colors.primary} />
            <Text style={[styles.leadTitle, { color: colors.text }]}>Your week, read back</Text>
          </View>
          <Text style={[styles.leadBody, { color: colors.textSecondary }]}>
            The coach counts and compares the entries you made on this phone. It does not predict
            anything, does not interpret a reading, and does not give medical advice.
          </Text>
        </Card>

        {error ? <Text style={[styles.error, { color: colors.error }]}>{error}</Text> : null}

        <SectionHeader title={`As of ${today}`} style={styles.spacer} />
        {insights.length === 0 ? (
          <Card>
            <Text style={[styles.empty, { color: colors.textMuted }]}>
              Nothing to read back yet. Log a reading, tick a habit or record some movement and
              this screen will show what you recorded.
            </Text>
          </Card>
        ) : (
          <View style={styles.list}>
            {insights.map((insight) => (
              <Pressable
                key={insight.key}
                onPress={() => (insight.route ? router.push(insight.route as never) : undefined)}
                disabled={!insight.route}
                accessibilityRole={insight.route ? 'button' : undefined}
                accessibilityLabel={`${insight.title}. ${insight.detail}`}
                style={({ pressed }) => [
                  styles.insight,
                  { backgroundColor: colors.surface, borderColor: colors.border },
                  pressed && styles.pressed,
                ]}
              >
                <View style={[styles.insightIcon, { backgroundColor: colors.primarySoft }]}>
                  <Ionicons name={insight.icon} size={20} color={colors.primary} />
                </View>
                <View style={styles.insightText}>
                  <Text style={[styles.insightTitle, { color: colors.text }]}>{insight.title}</Text>
                  <Text style={[styles.insightDetail, { color: colors.textSecondary }]}>
                    {insight.detail}
                  </Text>
                </View>
                {insight.route ? (
                  <Ionicons name="chevron-forward" size={18} color={colors.textMuted} />
                ) : null}
              </Pressable>
            ))}
          </View>
        )}

        <Card style={styles.boundary}>
          <Text style={[styles.boundaryTitle, { color: colors.text }]}>What it will not do</Text>
          <Text style={[styles.boundaryText, { color: colors.textSecondary }]}>
            It will not tell you a dose, say whether a reading is safe, judge a symptom, or suggest
            stopping a medicine. For any of those, ask a pharmacist or a clinician. If something
            feels urgent, contact emergency services rather than this app.
          </Text>
        </Card>
      </ScrollView>
    </Screen>
  )
}

const styles = StyleSheet.create({
  scroll: { padding: spacing.xxl, gap: spacing.md },
  leadCard: { gap: spacing.sm },
  leadHead: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  leadTitle: { ...typography.h3 },
  leadBody: { ...typography.body, lineHeight: 22 },
  error: { ...typography.caption, marginTop: spacing.md, textAlign: 'center' },
  spacer: { marginTop: spacing.lg },
  empty: { ...typography.caption, fontFamily: 'DMSans_400Regular', lineHeight: 18 },
  list: { gap: spacing.sm },
  insight: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.md,
    borderRadius: radii.lg,
    borderWidth: 1,
    padding: spacing.lg,
  },
  insightIcon: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
  },
  insightText: { flex: 1, gap: 3 },
  insightTitle: { ...typography.bodyMedium, fontFamily: 'DMSans_500Medium' },
  insightDetail: { ...typography.caption, fontFamily: 'DMSans_400Regular', lineHeight: 18 },
  boundary: { marginTop: spacing.lg, gap: spacing.sm },
  boundaryTitle: { ...typography.bodyMedium, fontFamily: 'DMSans_500Medium' },
  boundaryText: { ...typography.caption, fontFamily: 'DMSans_400Regular', lineHeight: 18 },
  pressed: { opacity: 0.9 },
})
