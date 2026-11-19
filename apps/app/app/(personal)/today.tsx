import { useCallback, useState } from 'react'
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import { useFocusEffect, useRouter } from 'expo-router'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { BrandWordmark } from '@/components/BrandWordmark'
import { CompanionSlot } from '@/components/health/CompanionSlot'
import { Button } from '@/components/ui/Button'
import { Card, SectionHeader } from '@/components/ui/Card'
import { Screen } from '@/components/ui/Screen'
import { useAuth } from '@/lib/auth'
import { buildToday, type TodaySummary } from '@/lib/health-today'
import { pregnancyProgress } from '@/lib/health-sections'
import {
  listMedications,
  listReminders,
  listVitals,
  markMedicationTaken,
  type Medication,
  type Reminder,
  type VitalsReading,
} from '@/lib/personal-store'
import { useHealthSections } from '@/lib/use-health-sections'
import { useWearables } from '@/lib/use-wearables'
import { radii, spacing, typography, useTheme } from '@/lib/theme'

/**
 * My Health home: today's medicines, upcoming appointments, latest readings and
 * quick actions on one screen. The same screen opens from a patient account and
 * from a staff account; for staff it is reached from the workspace and is
 * private to them (see apps/web/src/lib/personal-health/owner.ts).
 */
export default function PersonalTodayScreen() {
  const { user, logout } = useAuth()
  const router = useRouter()
  const insets = useSafeAreaInsets()
  const { colors } = useTheme()
  const { sections, pregnancyDueDate } = useHealthSections()
  const { snapshot } = useWearables({ autoSync: true })
  const [medications, setMedications] = useState<Medication[]>([])
  const [reminders, setReminders] = useState<Reminder[]>([])
  const [vitals, setVitals] = useState<VitalsReading[]>([])
  const [signingOut, setSigningOut] = useState(false)

  const userId = user?.id
  const isStaff = Boolean(user && user.dashboardKind !== 'patient')

  const load = useCallback(async () => {
    if (!userId) return
    try {
      const [meds, rems, bp, glucose] = await Promise.all([
        listMedications(userId),
        listReminders(userId),
        listVitals(userId, 'blood_pressure', 1),
        listVitals(userId, 'glucose', 1),
      ])
      setMedications(meds)
      setReminders(rems)
      setVitals([...bp, ...glucose])
    } catch {
      // A read failure leaves sections empty rather than blocking the screen.
    }
  }, [userId])

  useFocusEffect(
    useCallback(() => {
      void load()
    }, [load]),
  )

  const today: TodaySummary = buildToday({
    medications,
    reminders,
    vitals,
    wearables: snapshot.daily,
    sections,
  })
  const pregnancy = sections.pregnancy ? pregnancyProgress(pregnancyDueDate) : null
  const firstName = user?.fullName?.split(' ')[0] ?? 'there'
  const go = (route: string) => router.push(route as never)

  const take = async (medicationId: string) => {
    if (!userId) return
    await markMedicationTaken(userId, medicationId).catch(() => {})
    await load()
  }

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
        contentContainerStyle={[styles.scroll, { paddingTop: insets.top + spacing.xl, paddingBottom: spacing.xxxl }]}
        showsVerticalScrollIndicator={false}
      >
        {isStaff ? (
          <Pressable
            onPress={() => router.replace('/(main)/home' as never)}
            accessibilityRole="button"
            accessibilityLabel={`Back to ${user?.tenantName || 'workspace'}`}
            style={styles.workspace}
            hitSlop={8}
          >
            <Ionicons name="chevron-back" size={18} color={colors.primary} />
            <Text style={[styles.workspaceText, { color: colors.primary }]}>{user?.tenantName || 'Workspace'}</Text>
          </Pressable>
        ) : null}

        <BrandWordmark logoSize="md" subtitle="My Synapse Health" />

        <View style={styles.greeting}>
          <Text style={[styles.hello, { color: colors.text }]}>Hello, {firstName}</Text>
          <Text style={[styles.sub, { color: colors.textSecondary }]}>
            {today.medicinesLeft
              ? `${today.medicinesLeft} medicine${today.medicinesLeft === 1 ? '' : 's'} left today.`
              : today.medicines.length
                ? 'All medicines taken today.'
                : 'Here is your health today.'}
          </Text>
        </View>

        {pregnancy ? (
          <Card>
            <Text style={[styles.cardLabel, { color: colors.textSecondary }]}>Pregnancy</Text>
            <Text style={[styles.cardValue, { color: colors.text }]}>
              {pregnancy.weeks} weeks · trimester {pregnancy.trimester}
            </Text>
          </Card>
        ) : null}

        <SectionHeader title="Medicines today" style={styles.spacer} />
        {today.medicines.length ? (
          <Card padded={false}>
            {today.medicines.map((med, index) => (
              <View
                key={med.id}
                style={[styles.medRow, index > 0 && { borderTopWidth: 1, borderTopColor: colors.borderSubtle }]}
              >
                <View style={styles.flex}>
                  <Text style={[styles.medName, { color: med.taken ? colors.textMuted : colors.text }]}>
                    {med.name}
                    {med.dose ? ` · ${med.dose}` : ''}
                  </Text>
                  <Text style={[styles.caption, { color: med.lowSupply ? colors.warning : colors.textMuted }]}>
                    {[med.time, med.lowSupply ? 'Running low' : null].filter(Boolean).join(' · ') || 'Any time today'}
                  </Text>
                </View>
                {med.taken ? (
                  <Ionicons name="checkmark-circle" size={26} color={colors.success} accessibilityLabel="Taken" />
                ) : (
                  <Pressable
                    onPress={() => take(med.id)}
                    accessibilityRole="button"
                    accessibilityLabel={`Mark ${med.name} taken`}
                    style={[styles.takeBtn, { borderColor: colors.primary, backgroundColor: colors.primarySoft }]}
                  >
                    <Text style={[styles.takeText, { color: colors.primary }]}>Taken</Text>
                  </Pressable>
                )}
              </View>
            ))}
          </Card>
        ) : (
          <EmptyRow text="No medicines added." action="Add one" onPress={() => go('/(personal)/medications')} />
        )}

        <SectionHeader title="Coming up" style={styles.spacer} />
        {today.appointments.length ? (
          <Card padded={false}>
            {today.appointments.map((appt, index) => (
              <View
                key={`${appt.title}-${appt.at}`}
                style={[styles.medRow, index > 0 && { borderTopWidth: 1, borderTopColor: colors.borderSubtle }]}
              >
                <Ionicons name="calendar-outline" size={20} color={appt.isToday ? colors.primary : colors.textMuted} />
                <View style={styles.flex}>
                  <Text style={[styles.medName, { color: colors.text }]}>{appt.title}</Text>
                  <Text style={[styles.caption, { color: colors.textMuted }]}>{appt.when}</Text>
                </View>
              </View>
            ))}
          </Card>
        ) : (
          <EmptyRow text="No appointments this week." action="Add one" onPress={() => go('/(personal)/reminders')} />
        )}

        <SectionHeader title="Latest readings" style={styles.spacer} />
        {today.readings.length ? (
          <View style={styles.grid}>
            {today.readings.map((reading) => (
              <Pressable
                key={reading.key}
                onPress={() => go(reading.source === 'wearable' ? '/(personal)/wearables' : '/(personal)/vitals')}
                accessibilityRole="button"
                accessibilityLabel={`${reading.label}: ${reading.value} ${reading.unit}`}
                style={({ pressed }) => [styles.tile, pressed && styles.pressed]}
              >
                <Card>
                  <View style={styles.tileHead}>
                    <Text style={[styles.cardLabel, { color: colors.textSecondary }]}>{reading.label}</Text>
                    {reading.source === 'wearable' ? (
                      <Ionicons name="watch-outline" size={14} color={colors.textMuted} />
                    ) : null}
                  </View>
                  <View style={styles.valueRow}>
                    <Text style={[styles.cardValue, { color: colors.text }]}>{reading.value}</Text>
                    {reading.unit ? <Text style={[styles.caption, { color: colors.textMuted }]}>{reading.unit}</Text> : null}
                  </View>
                  <Text style={[styles.caption, { color: colors.textMuted }]}>{reading.when}</Text>
                </Card>
              </Pressable>
            ))}
          </View>
        ) : (
          <EmptyRow
            text="No readings yet. Log one, or connect your watch."
            action="Connect"
            onPress={() => go('/(personal)/wearables')}
          />
        )}

        {/* Reserved for the AI health companion (built in a separate change). */}
        <CompanionSlot />

        <SectionHeader title="Quick actions" style={styles.spacer} />
        <View style={styles.actions}>
          {today.quickActions.map((action) => (
            <Pressable
              key={action.id}
              onPress={() => go(action.route)}
              accessibilityRole="button"
              accessibilityLabel={action.label}
              style={({ pressed }) => [
                styles.quickAction,
                { backgroundColor: colors.primarySoft, borderColor: colors.primary },
                pressed && styles.pressed,
              ]}
            >
              <Text style={[styles.quickText, { color: colors.primary }]}>{action.label}</Text>
            </Pressable>
          ))}
          <Pressable
            onPress={() => go('/(personal)/medical-id')}
            accessibilityRole="button"
            style={[styles.quickAction, { borderColor: colors.border }]}
          >
            <Text style={[styles.quickText, { color: colors.textSecondary }]}>Health profile</Text>
          </Pressable>
        </View>

        <Card style={styles.spacer}>
          <Text style={[styles.privacy, { color: colors.textMuted }]}>
            {isStaff
              ? `This is your own health, not ${user?.tenantName || 'your workplace'}'s. Your employer and facility admins cannot see it. `
              : ''}
            What you log stays on this phone. Watch readings you choose to connect are kept on Synapse for you
            alone, and you can delete them any time.
          </Text>
        </Card>

        {!isStaff ? (
          <View style={styles.account}>
            <Text style={[styles.caption, styles.center, { color: colors.textSecondary }]}>
              Signed in as {user?.email ?? ''}
            </Text>
            <Button label="Sign out" variant="ghost" onPress={signOut} loading={signingOut} />
          </View>
        ) : null}
      </ScrollView>
    </Screen>
  )
}

function EmptyRow({ text, action, onPress }: { text: string; action: string; onPress: () => void }) {
  const { colors } = useTheme()
  return (
    <Card>
      <View style={styles.emptyRow}>
        <Text style={[styles.caption, styles.flex, { color: colors.textMuted }]}>{text}</Text>
        <Pressable onPress={onPress} accessibilityRole="button" hitSlop={8}>
          <Text style={[styles.link, { color: colors.primary }]}>{action}</Text>
        </Pressable>
      </View>
    </Card>
  )
}

const styles = StyleSheet.create({
  scroll: { paddingHorizontal: spacing.xxl, gap: spacing.md },
  flex: { flex: 1 },
  center: { textAlign: 'center' },
  workspace: { flexDirection: 'row', alignItems: 'center', gap: 2, alignSelf: 'flex-start' },
  workspaceText: { ...typography.bodyMedium },
  greeting: { marginTop: spacing.lg, gap: spacing.xs },
  hello: { ...typography.h2 },
  sub: { ...typography.body },
  spacer: { marginTop: spacing.lg },
  cardLabel: { ...typography.label },
  cardValue: { ...typography.stat },
  caption: { ...typography.caption },
  link: { ...typography.bodyMedium },
  medRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, padding: spacing.lg },
  medName: { ...typography.bodyMedium },
  takeBtn: { borderWidth: 1, borderRadius: radii.md, paddingHorizontal: spacing.md, paddingVertical: spacing.sm },
  takeText: { ...typography.bodyMedium },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.md },
  tile: { width: '47%', flexGrow: 1 },
  tileHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  valueRow: { flexDirection: 'row', alignItems: 'flex-end', gap: 4, marginTop: spacing.sm },
  emptyRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  quickAction: { borderRadius: radii.md, borderWidth: 1, paddingHorizontal: spacing.lg, paddingVertical: spacing.md },
  quickText: { ...typography.bodyMedium },
  pressed: { opacity: 0.9, transform: [{ scale: 0.99 }] },
  privacy: { ...typography.caption, lineHeight: 18 },
  account: { marginTop: spacing.xl, gap: spacing.md },
})
