import { useCallback, useState } from 'react'
import { Alert, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import { useFocusEffect } from 'expo-router'
import { Button } from '@/components/ui/Button'
import { Card, SectionHeader } from '@/components/ui/Card'
import { ChoiceChips } from '@/components/ui/ChoiceChips'
import { Screen } from '@/components/ui/Screen'
import { TextField } from '@/components/ui/TextField'
import { useAuth } from '@/lib/auth'
import {
  addCycle,
  deleteCycle,
  listCycles,
  localDay,
  type Cycle,
  type FlowIntensity,
} from '@/lib/personal-store'
import { spacing, typography, useTheme } from '@/lib/theme'

const FLOWS = [
  { value: 'spotting', label: 'Spotting' },
  { value: 'light', label: 'Light' },
  { value: 'medium', label: 'Medium' },
  { value: 'heavy', label: 'Heavy' },
] as const

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/

function averageCycleDays(cycles: Cycle[]): number | null {
  if (cycles.length < 2) return null
  const starts = cycles
    .map((cycle) => new Date(`${cycle.periodStart}T00:00:00`).getTime())
    .sort((a, b) => a - b)
  const gaps: number[] = []
  for (let i = 1; i < starts.length; i += 1) {
    const days = Math.round((starts[i] - starts[i - 1]) / 86_400_000)
    if (days > 0) gaps.push(days)
  }
  if (gaps.length === 0) return null
  return Math.round(gaps.reduce((sum, gap) => sum + gap, 0) / gaps.length)
}

function describe(cycle: Cycle): string {
  const start = cycle.periodStart
  if (!cycle.periodEnd) return `${start} · ongoing`
  return `${start} → ${cycle.periodEnd}`
}

export default function PersonalCycleScreen() {
  const { user } = useAuth()
  const { colors } = useTheme()
  const [cycles, setCycles] = useState<Cycle[]>([])
  const [start, setStart] = useState(localDay())
  const [end, setEnd] = useState('')
  const [flow, setFlow] = useState<FlowIntensity | null>(null)
  const [symptoms, setSymptoms] = useState('')
  const [notes, setNotes] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const userId = user?.id

  const reload = useCallback(async () => {
    if (!userId) return
    try {
      setCycles(await listCycles(userId))
    } catch {
      setError('Could not read the cycles saved on this device.')
    }
  }, [userId])

  useFocusEffect(
    useCallback(() => {
      void reload()
    }, [reload]),
  )

  const save = async () => {
    setError(null)
    if (!userId) return
    if (!ISO_DAY.test(start.trim())) {
      setError('Enter the first day as YYYY-MM-DD.')
      return
    }
    if (end.trim() && !ISO_DAY.test(end.trim())) {
      setError('Enter the last day as YYYY-MM-DD, or leave it empty.')
      return
    }
    if (end.trim() && end.trim() < start.trim()) {
      setError('The last day cannot be before the first day.')
      return
    }
    setSaving(true)
    try {
      await addCycle({
        userId,
        periodStart: start.trim(),
        periodEnd: end.trim() || null,
        flow,
        symptoms,
        notes,
      })
      setEnd('')
      setFlow(null)
      setSymptoms('')
      setNotes('')
      await reload()
    } catch {
      setError('Could not save the period on this device.')
    } finally {
      setSaving(false)
    }
  }

  const remove = (cycle: Cycle) => {
    Alert.alert('Delete period', `Delete the period starting ${cycle.periodStart}?`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: async () => {
          if (!userId) return
          await deleteCycle(userId, cycle.id)
          await reload()
        },
      },
    ])
  }

  const average = averageCycleDays(cycles)

  return (
    <Screen>
      <ScrollView contentContainerStyle={styles.scroll} showsVerticalScrollIndicator={false}>
        {average != null ? (
          <Card>
            <Text style={[styles.summaryLabel, { color: colors.textSecondary }]}>
              Average between logged starts
            </Text>
            <Text style={[styles.summaryValue, { color: colors.text }]}>{average} days</Text>
            <Text style={[styles.summaryNote, { color: colors.textMuted }]}>
              Calculated from {cycles.length} periods you recorded. The app does not predict
              future periods or fertile days.
            </Text>
          </Card>
        ) : null}

        <SectionHeader title="Log a period" style={average != null ? styles.spacer : undefined} />
        <Card style={styles.formCard}>
          <TextField
            label="First day"
            value={start}
            onChangeText={setStart}
            placeholder="YYYY-MM-DD"
            keyboardType="numbers-and-punctuation"
          />
          <TextField
            label="Last day (optional)"
            value={end}
            onChangeText={setEnd}
            placeholder="YYYY-MM-DD"
            keyboardType="numbers-and-punctuation"
          />
          <ChoiceChips label="Flow (optional)" options={FLOWS} value={flow} onChange={setFlow} />
          <TextField
            label="Symptoms (optional)"
            value={symptoms}
            onChangeText={setSymptoms}
            placeholder="e.g. cramps, headache"
          />
          <TextField
            label="Notes (optional)"
            value={notes}
            onChangeText={setNotes}
            placeholder="Anything else you want to remember"
          />

          {error ? <Text style={[styles.error, { color: colors.error }]}>{error}</Text> : null}

          <Button label="Save period" onPress={save} loading={saving} />
        </Card>

        <SectionHeader title="Recorded periods" style={styles.spacer} />
        {cycles.length === 0 ? (
          <Card>
            <Text style={[styles.empty, { color: colors.textMuted }]}>
              Nothing recorded yet. Everything stays on this device.
            </Text>
          </Card>
        ) : (
          <View style={styles.list}>
            {cycles.map((cycle) => (
              <Pressable
                key={cycle.id}
                onLongPress={() => remove(cycle)}
                accessibilityRole="button"
                accessibilityLabel={`${describe(cycle)}, long press to delete`}
              >
                <Card>
                  <Text style={[styles.cycleRange, { color: colors.text }]}>{describe(cycle)}</Text>
                  <Text style={[styles.cycleMeta, { color: colors.textMuted }]}>
                    {cycle.flow ? cycle.flow : 'flow not recorded'}
                    {cycle.symptoms ? ` · ${cycle.symptoms}` : ''}
                  </Text>
                </Card>
              </Pressable>
            ))}
          </View>
        )}

        <Text style={[styles.hint, { color: colors.textMuted }]}>
          Long press a period to delete it. For anything about your cycle that worries you,
          speak to a clinician.
        </Text>
      </ScrollView>
    </Screen>
  )
}

const styles = StyleSheet.create({
  scroll: { padding: spacing.xxl, gap: spacing.md },
  summaryLabel: { ...typography.label },
  summaryValue: { ...typography.stat, marginTop: spacing.xs },
  summaryNote: {
    ...typography.caption,
    fontFamily: 'DMSans_400Regular',
    lineHeight: 18,
    marginTop: spacing.sm,
  },
  spacer: { marginTop: spacing.lg },
  formCard: { gap: spacing.xs },
  error: { ...typography.caption, marginBottom: spacing.md, textAlign: 'center' },
  empty: { ...typography.caption, fontFamily: 'DMSans_400Regular', lineHeight: 18 },
  list: { gap: spacing.sm },
  cycleRange: { ...typography.bodyMedium, fontFamily: 'DMSans_500Medium' },
  cycleMeta: { ...typography.caption, marginTop: 2 },
  hint: {
    ...typography.caption,
    fontFamily: 'DMSans_400Regular',
    lineHeight: 18,
    marginTop: spacing.lg,
    textAlign: 'center',
  },
})
