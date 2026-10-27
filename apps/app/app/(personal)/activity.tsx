import { useCallback, useState } from 'react'
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import { useFocusEffect } from 'expo-router'
import { Button } from '@/components/ui/Button'
import { Card, SectionHeader } from '@/components/ui/Card'
import { ChoiceChips } from '@/components/ui/ChoiceChips'
import { Screen } from '@/components/ui/Screen'
import { TextField } from '@/components/ui/TextField'
import { useAuth } from '@/lib/auth'
import {
  addActivity,
  listActivity,
  weeklyActivityMinutes,
  type ActivityEntry,
  type ActivityIntensity,
} from '@/lib/personal-store'
import { spacing, typography, useTheme } from '@/lib/theme'

const SUGGESTIONS = [
  'Walking',
  'Running',
  'Cycling',
  'Strength training',
  'Football',
  'Netball',
  'Swimming',
  'Yoga',
  'Housework',
  'Farming',
] as const

const INTENSITIES = [
  { value: 'light', label: 'Light' },
  { value: 'moderate', label: 'Moderate' },
  { value: 'vigorous', label: 'Vigorous' },
] as const

export default function PersonalActivityScreen() {
  const { user } = useAuth()
  const { colors } = useTheme()
  const [entries, setEntries] = useState<ActivityEntry[]>([])
  const [weekly, setWeekly] = useState(0)
  const [activity, setActivity] = useState('')
  const [minutes, setMinutes] = useState('')
  const [intensity, setIntensity] = useState<ActivityIntensity | null>(null)
  const [note, setNote] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const userId = user?.id

  const reload = useCallback(async () => {
    if (!userId) return
    try {
      const [list, total] = await Promise.all([
        listActivity(userId),
        weeklyActivityMinutes(userId),
      ])
      setEntries(list)
      setWeekly(total)
    } catch {
      setError('Could not read the activity saved on this device.')
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
    if (!activity.trim()) {
      setError('Say what you did.')
      return
    }
    const numeric = Number(minutes)
    if (!minutes.trim() || !Number.isFinite(numeric) || numeric <= 0) {
      setError('Enter how many minutes it lasted.')
      return
    }
    setSaving(true)
    try {
      await addActivity({ userId, activity, minutes: numeric, intensity, note })
      setActivity('')
      setMinutes('')
      setIntensity(null)
      setNote('')
      await reload()
    } catch {
      setError('Could not save the activity on this device.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Screen>
      <ScrollView contentContainerStyle={styles.scroll} showsVerticalScrollIndicator={false}>
        <Card>
          <Text style={[styles.totalLabel, { color: colors.textSecondary }]}>
            Last 7 days
          </Text>
          <View style={styles.totalRow}>
            <Text style={[styles.totalValue, { color: colors.text }]}>{weekly}</Text>
            <Text style={[styles.totalUnit, { color: colors.textMuted }]}>minutes</Text>
          </View>
          <Text style={[styles.totalNote, { color: colors.textMuted }]}>
            Total of what you have recorded here. There is no target and the app does not
            grade your week.
          </Text>
        </Card>

        <SectionHeader title="Record activity" style={styles.spacer} />
        <Card style={styles.formCard}>
          <Text style={[styles.pickLabel, { color: colors.textSecondary }]}>Common ones</Text>
          <View style={styles.suggestions}>
            {SUGGESTIONS.map((suggestion) => (
              <Pressable
                key={suggestion}
                onPress={() => setActivity(suggestion)}
                accessibilityRole="button"
                accessibilityState={{ selected: activity === suggestion }}
                style={[
                  styles.suggestion,
                  {
                    backgroundColor:
                      activity === suggestion ? colors.primarySoft : colors.bgElevated,
                    borderColor: activity === suggestion ? colors.primary : colors.border,
                  },
                ]}
              >
                <Text
                  style={[
                    styles.suggestionText,
                    { color: activity === suggestion ? colors.primary : colors.textSecondary },
                  ]}
                >
                  {suggestion}
                </Text>
              </Pressable>
            ))}
          </View>

          <TextField
            label="Activity"
            value={activity}
            onChangeText={setActivity}
            placeholder="Walk to the market"
          />
          <TextField
            label="Minutes"
            value={minutes}
            onChangeText={setMinutes}
            placeholder="30"
            keyboardType="number-pad"
          />
          <ChoiceChips
            label="Intensity (optional)"
            options={INTENSITIES}
            value={intensity}
            onChange={setIntensity}
          />
          <TextField
            label="Note (optional)"
            value={note}
            onChangeText={setNote}
            placeholder="How it felt"
          />

          {error ? <Text style={[styles.error, { color: colors.error }]}>{error}</Text> : null}

          <Button label="Save activity" onPress={save} loading={saving} />
        </Card>

        <SectionHeader title="Recent" style={styles.spacer} />
        {entries.length === 0 ? (
          <Card>
            <Text style={[styles.empty, { color: colors.textMuted }]}>
              Nothing recorded yet.
            </Text>
          </Card>
        ) : (
          <View style={styles.list}>
            {entries.map((entry) => (
              <Card key={entry.id}>
                <Text style={[styles.entryTitle, { color: colors.text }]}>
                  {entry.activity} · {entry.minutes} min
                </Text>
                <Text style={[styles.entryMeta, { color: colors.textMuted }]}>
                  {entry.loggedOn}
                  {entry.intensity ? ` · ${entry.intensity}` : ''}
                  {entry.note ? ` · ${entry.note}` : ''}
                </Text>
              </Card>
            ))}
          </View>
        )}
      </ScrollView>
    </Screen>
  )
}

const styles = StyleSheet.create({
  scroll: { padding: spacing.xxl, gap: spacing.md },
  totalLabel: { ...typography.label },
  totalRow: { flexDirection: 'row', alignItems: 'flex-end', gap: 6, marginTop: spacing.xs },
  totalValue: { ...typography.display, lineHeight: 42 },
  totalUnit: { ...typography.caption, marginBottom: 8 },
  totalNote: {
    ...typography.caption,
    fontFamily: 'DMSans_400Regular',
    lineHeight: 18,
    marginTop: spacing.sm,
  },
  spacer: { marginTop: spacing.lg },
  formCard: { gap: spacing.xs },
  pickLabel: { ...typography.label, marginBottom: spacing.sm },
  suggestions: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, marginBottom: spacing.lg },
  suggestion: {
    borderRadius: 999,
    borderWidth: 1,
    paddingHorizontal: spacing.md,
    paddingVertical: 7,
  },
  suggestionText: { ...typography.caption, fontFamily: 'DMSans_500Medium' },
  error: { ...typography.caption, marginBottom: spacing.md, textAlign: 'center' },
  empty: { ...typography.caption, fontFamily: 'DMSans_400Regular' },
  list: { gap: spacing.sm },
  entryTitle: { ...typography.bodyMedium, fontFamily: 'DMSans_500Medium' },
  entryMeta: { ...typography.caption, marginTop: 2 },
})
