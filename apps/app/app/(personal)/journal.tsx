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
  addSymptom,
  deleteSymptom,
  listSymptoms,
  type SymptomEntry,
} from '@/lib/personal-store'
import { radii, spacing, typography, useTheme } from '@/lib/theme'

const SEVERITY = [
  { value: '1', label: '1 Mild' },
  { value: '2', label: '2' },
  { value: '3', label: '3 Moderate' },
  { value: '4', label: '4' },
  { value: '5', label: '5 Severe' },
] as const

type Severity = (typeof SEVERITY)[number]['value']

const COMMON = ['Headache', 'Fatigue', 'Nausea', 'Pain', 'Cough', 'Rash']

function formatWhen(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  return date.toLocaleString(undefined, {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  })
}

export default function PersonalJournalScreen() {
  const { user } = useAuth()
  const { colors } = useTheme()
  const [symptom, setSymptom] = useState('')
  const [severity, setSeverity] = useState<Severity>('3')
  const [note, setNote] = useState('')
  const [entries, setEntries] = useState<SymptomEntry[]>([])
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  const userId = user?.id

  const reload = useCallback(async () => {
    if (!userId) return
    try {
      setEntries(await listSymptoms(userId))
    } catch {
      setError('Could not read the journal saved on this device.')
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
    if (!symptom.trim()) {
      setError('Describe what you noticed — a word or two is enough.')
      return
    }
    setSaving(true)
    try {
      await addSymptom({ userId, symptom, severity: Number(severity), note })
      setSymptom('')
      setNote('')
      setSeverity('3')
      await reload()
    } catch {
      setError('Could not save the entry on this device.')
    } finally {
      setSaving(false)
    }
  }

  const remove = (entry: SymptomEntry) => {
    Alert.alert(
      'Delete entry',
      `Delete "${entry.symptom}" from ${formatWhen(entry.occurredAt)}?`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: async () => {
            if (!userId) return
            await deleteSymptom(userId, entry.id)
            await reload()
          },
        },
      ],
    )
  }

  return (
    <Screen>
      <ScrollView contentContainerStyle={styles.scroll} showsVerticalScrollIndicator={false}>
        <SectionHeader title="How do you feel?" />
        <Card style={styles.formCard}>
          <TextField
            label="What did you notice?"
            value={symptom}
            onChangeText={setSymptom}
            placeholder="e.g. headache behind the eyes"
            autoCapitalize="sentences"
          />

          <View style={styles.chipRow}>
            {COMMON.map((word) => {
              const selected = symptom.trim().toLowerCase() === word.toLowerCase()
              return (
                <Pressable
                  key={word}
                  onPress={() => setSymptom(word)}
                  accessibilityRole="button"
                  accessibilityState={{ selected }}
                  style={[
                    styles.chip,
                    {
                      backgroundColor: selected ? colors.primarySoft : colors.bgElevated,
                      borderColor: selected ? colors.primary : colors.border,
                    },
                  ]}
                >
                  <Text
                    style={[
                      styles.chipText,
                      { color: selected ? colors.primary : colors.textSecondary },
                    ]}
                  >
                    {word}
                  </Text>
                </Pressable>
              )
            })}
          </View>

          <ChoiceChips label="How strong is it?" options={SEVERITY} value={severity} onChange={setSeverity} />

          <TextField
            label="Anything else (optional)"
            value={note}
            onChangeText={setNote}
            placeholder="e.g. started after lunch, eased with rest"
            multiline
            style={styles.multiline}
          />

          {error ? <Text style={[styles.error, { color: colors.error }]}>{error}</Text> : null}

          <Button label="Add to journal" onPress={save} loading={saving} />
        </Card>

        <SectionHeader title="Recent entries" style={styles.spacer} />
        {entries.length === 0 ? (
          <Card>
            <Text style={[styles.empty, { color: colors.textMuted }]}>
              Nothing written yet. A short note each day is easier to take to an appointment than a
              memory.
            </Text>
          </Card>
        ) : (
          <View style={styles.list}>
            {entries.map((entry) => (
              <Pressable
                key={entry.id}
                onLongPress={() => remove(entry)}
                accessibilityRole="button"
                accessibilityLabel={`${entry.symptom}, strength ${entry.severity} of 5, long press to delete`}
              >
                <Card>
                  <View style={styles.entryHead}>
                    <Text style={[styles.entryName, { color: colors.text }]}>{entry.symptom}</Text>
                    <View style={[styles.severityPill, { borderColor: colors.border }]}>
                      <Text style={[styles.severityText, { color: colors.textSecondary }]}>
                        {entry.severity}/5
                      </Text>
                    </View>
                  </View>
                  <Text style={[styles.entryWhen, { color: colors.textMuted }]}>
                    {formatWhen(entry.occurredAt)}
                  </Text>
                  {entry.note ? (
                    <Text style={[styles.entryNote, { color: colors.textSecondary }]}>
                      {entry.note}
                    </Text>
                  ) : null}
                </Card>
              </Pressable>
            ))}
          </View>
        )}

        <Text style={[styles.hint, { color: colors.textMuted }]}>
          Long press an entry to delete it. This is your own record — the app does not diagnose
          anything from it, and nobody else can see it.
        </Text>
      </ScrollView>
    </Screen>
  )
}

const styles = StyleSheet.create({
  scroll: { padding: spacing.xxl, gap: spacing.md },
  formCard: { gap: spacing.xs },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, marginBottom: spacing.lg },
  chip: { borderRadius: radii.md, borderWidth: 1, paddingHorizontal: spacing.md, paddingVertical: 6 },
  chipText: { ...typography.caption, fontFamily: 'DMSans_500Medium' },
  multiline: { minHeight: 72, textAlignVertical: 'top', paddingTop: 14 },
  error: { ...typography.caption, marginBottom: spacing.md, textAlign: 'center' },
  spacer: { marginTop: spacing.lg },
  empty: { ...typography.caption, fontFamily: 'DMSans_400Regular', lineHeight: 18 },
  list: { gap: spacing.sm },
  entryHead: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  entryName: { ...typography.bodyMedium, fontFamily: 'DMSans_500Medium', flex: 1 },
  severityPill: { borderRadius: radii.sm, borderWidth: 1, paddingHorizontal: spacing.sm, paddingVertical: 2 },
  severityText: { ...typography.caption },
  entryWhen: { ...typography.caption, marginTop: spacing.xs },
  entryNote: { ...typography.caption, marginTop: spacing.sm, lineHeight: 18 },
  hint: {
    ...typography.caption,
    fontFamily: 'DMSans_400Regular',
    lineHeight: 18,
    marginTop: spacing.lg,
    textAlign: 'center',
  },
})
