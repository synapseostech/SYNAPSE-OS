import { useCallback, useState } from 'react'
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import { useFocusEffect, useRouter } from 'expo-router'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { BrandWordmark } from '@/components/BrandWordmark'
import { Button } from '@/components/ui/Button'
import { Card, SectionHeader } from '@/components/ui/Card'
import { Screen } from '@/components/ui/Screen'
import { useAuth } from '@/lib/auth'
import {
  listHabits,
  listVitals,
  weeklyActivityMinutes,
  type Habit,
  type VitalsReading,
} from '@/lib/personal-store'
import { radii, spacing, typography, useTheme } from '@/lib/theme'

function formatWhen(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  return date.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })
}

function readingText(reading: VitalsReading | undefined): string {
  if (!reading) return '—'
  if (reading.kind === 'blood_pressure') {
    return `${reading.systolic ?? '—'}/${reading.diastolic ?? '—'}`
  }
  return `${reading.value ?? '—'}`
}

export default function PersonalTodayScreen() {
  const { user, logout } = useAuth()
  const router = useRouter()
  const insets = useSafeAreaInsets()
  const { colors } = useTheme()
  const [bp, setBp] = useState<VitalsReading | undefined>()
  const [glucose, setGlucose] = useState<VitalsReading | undefined>()
  const [habits, setHabits] = useState<Habit[]>([])
  const [minutes, setMinutes] = useState(0)
  const [signingOut, setSigningOut] = useState(false)

  const userId = user?.id

  useFocusEffect(
    useCallback(() => {
      let active = true
      if (!userId) return
      ;(async () => {
        try {
          const [recentBp, recentGlucose, habitList, weeklyMinutes] = await Promise.all([
            listVitals(userId, 'blood_pressure', 1),
            listVitals(userId, 'glucose', 1),
            listHabits(userId),
            weeklyActivityMinutes(userId),
          ])
          if (!active) return
          setBp(recentBp[0])
          setGlucose(recentGlucose[0])
          setHabits(habitList)
          setMinutes(weeklyMinutes)
        } catch {
          // A read failure leaves the summary cards blank rather than blocking the screen.
        }
      })()
      return () => {
        active = false
      }
    }, [userId]),
  )

  const habitsToday = habits.filter((habit) => habit.loggedToday).length
  const firstName = user?.fullName?.split(' ')[0] ?? 'there'

  const signOut = async () => {
    setSigningOut(true)
    try {
      await logout()
      router.replace('/(auth)/login' as never)
    } finally {
      setSigningOut(false)
    }
  }

  return (
    <Screen glow>
      <ScrollView
        contentContainerStyle={[
          styles.scroll,
          { paddingTop: insets.top + spacing.xl, paddingBottom: spacing.xxxl },
        ]}
        showsVerticalScrollIndicator={false}
      >
        <BrandWordmark logoSize="md" subtitle="Your health, on this device" />

        <View style={styles.greeting}>
          <Text style={[styles.hello, { color: colors.text }]}>Hello, {firstName}</Text>
          <Text style={[styles.sub, { color: colors.textSecondary }]}>
            Log a reading, tick a habit or record some movement.
          </Text>
        </View>

        <SectionHeader title="Latest" />
        <View style={styles.grid}>
          <SummaryCard
            label="Blood pressure"
            value={readingText(bp)}
            unit={bp ? 'mmHg' : undefined}
            when={bp ? formatWhen(bp.recordedAt) : 'Nothing logged'}
            onPress={() => router.push('/(personal)/vitals' as never)}
          />
          <SummaryCard
            label="Blood glucose"
            value={readingText(glucose)}
            unit={glucose?.unit}
            when={glucose ? formatWhen(glucose.recordedAt) : 'Nothing logged'}
            onPress={() => router.push('/(personal)/vitals' as never)}
          />
          <SummaryCard
            label="Habits today"
            value={habits.length ? `${habitsToday}/${habits.length}` : '—'}
            when={habits.length ? 'ticked' : 'No habits yet'}
            onPress={() => router.push('/(personal)/habits' as never)}
          />
          <SummaryCard
            label="Activity, 7 days"
            value={String(minutes)}
            unit="min"
            when="last 7 days"
            onPress={() => router.push('/(personal)/activity' as never)}
          />
        </View>

        <SectionHeader title="Quick add" style={styles.spacer} />
        <View style={styles.actions}>
          <QuickAction
            label="Log a reading"
            onPress={() => router.push('/(personal)/vitals' as never)}
          />
          <QuickAction
            label="Record activity"
            onPress={() => router.push('/(personal)/activity' as never)}
          />
          <QuickAction
            label="Log a period"
            onPress={() => router.push('/(personal)/cycle' as never)}
          />
        </View>

        <Card style={styles.privacy}>
          <Text style={[styles.privacyText, { color: colors.textMuted }]}>
            Everything you log here is stored on this phone only. Nothing is sent to a hospital,
            pharmacy or insurer, and deleting the app deletes it.
          </Text>
        </Card>

        <View style={styles.account}>
          <Text style={[styles.accountEmail, { color: colors.textSecondary }]}>
            Signed in as {user?.email ?? ''}
          </Text>
          <Button label="Sign out" variant="ghost" onPress={signOut} loading={signingOut} />
        </View>
      </ScrollView>
    </Screen>
  )
}

function SummaryCard({
  label,
  value,
  unit,
  when,
  onPress,
}: {
  label: string
  value: string
  unit?: string
  when: string
  onPress: () => void
}) {
  const { colors } = useTheme()
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`${label}: ${value}`}
      style={({ pressed }) => [styles.summaryWrap, pressed && styles.pressed]}
    >
      <Card>
        <Text style={[styles.summaryLabel, { color: colors.textSecondary }]}>{label}</Text>
        <View style={styles.summaryValueRow}>
          <Text style={[styles.summaryValue, { color: colors.text }]}>{value}</Text>
          {unit ? (
            <Text style={[styles.summaryUnit, { color: colors.textMuted }]}>{unit}</Text>
          ) : null}
        </View>
        <Text style={[styles.summaryWhen, { color: colors.textMuted }]}>{when}</Text>
      </Card>
    </Pressable>
  )
}

function QuickAction({ label, onPress }: { label: string; onPress: () => void }) {
  const { colors } = useTheme()
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      style={({ pressed }) => [
        styles.quickAction,
        { backgroundColor: colors.primarySoft, borderColor: colors.primary },
        pressed && styles.pressed,
      ]}
    >
      <Text style={[styles.quickActionText, { color: colors.primary }]}>{label}</Text>
    </Pressable>
  )
}

const styles = StyleSheet.create({
  scroll: { paddingHorizontal: spacing.xxl, gap: spacing.md },
  greeting: { marginTop: spacing.xl, gap: spacing.xs },
  hello: { ...typography.h2 },
  sub: { ...typography.body },
  spacer: { marginTop: spacing.lg },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.md },
  summaryWrap: { width: '48%', flexGrow: 1 },
  summaryLabel: { ...typography.label },
  summaryValueRow: { flexDirection: 'row', alignItems: 'flex-end', gap: 4, marginTop: spacing.sm },
  summaryValue: { ...typography.stat },
  summaryUnit: { ...typography.caption, marginBottom: 4 },
  summaryWhen: { ...typography.caption, marginTop: spacing.xs },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  quickAction: {
    borderRadius: radii.md,
    borderWidth: 1,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
  },
  quickActionText: { ...typography.bodyMedium, fontFamily: 'DMSans_500Medium' },
  pressed: { opacity: 0.9, transform: [{ scale: 0.99 }] },
  privacy: { marginTop: spacing.lg },
  privacyText: { ...typography.caption, fontFamily: 'DMSans_400Regular', lineHeight: 18 },
  account: { marginTop: spacing.xl, gap: spacing.md },
  accountEmail: { ...typography.caption, textAlign: 'center' },
})
