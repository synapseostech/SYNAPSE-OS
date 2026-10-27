import { useCallback, useState } from 'react'
import { Alert, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import { useFocusEffect } from 'expo-router'
import { Ionicons } from '@expo/vector-icons'
import { Button } from '@/components/ui/Button'
import { Card, SectionHeader } from '@/components/ui/Card'
import { Screen } from '@/components/ui/Screen'
import { TextField } from '@/components/ui/TextField'
import { useAuth } from '@/lib/auth'
import {
  addMedication,
  listMedications,
  markMedicationTaken,
  removeMedication,
  type Medication,
} from '@/lib/personal-store'
import { radii, spacing, typography, useTheme } from '@/lib/theme'

export default function PersonalMedicationsScreen() {
  const { user } = useAuth()
  const { colors } = useTheme()
  const [name, setName] = useState('')
  const [dose, setDose] = useState('')
  const [schedule, setSchedule] = useState('')
  const [notes, setNotes] = useState('')
  const [medications, setMedications] = useState<Medication[]>([])
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [busyId, setBusyId] = useState<string | null>(null)

  const userId = user?.id

  const reload = useCallback(async () => {
    if (!userId) return
    try {
      setMedications(await listMedications(userId))
    } catch {
      setError('Could not read the medicines saved on this device.')
    }
  }, [userId])

  useFocusEffect(
    useCallback(() => {
      void reload()
    }, [reload]),
  )

  const add = async () => {
    setError(null)
    if (!userId) return
    if (!name.trim()) {
      setError('Enter the medicine name as it appears on the pack.')
      return
    }
    setSaving(true)
    try {
      await addMedication({ userId, name, dose, schedule, notes })
      setName('')
      setDose('')
      setSchedule('')
      setNotes('')
      await reload()
    } catch {
      setError('Could not save the medicine on this device.')
    } finally {
      setSaving(false)
    }
  }

  const markTaken = async (medication: Medication) => {
    if (!userId) return
    setBusyId(medication.id)
    try {
      await markMedicationTaken(userId, medication.id)
      await reload()
    } catch {
      setError('Could not record that dose on this device.')
    } finally {
      setBusyId(null)
    }
  }

  const remove = (medication: Medication) => {
    Alert.alert(
      'Remove medicine',
      `Remove ${medication.name} and its last seven days of dose history from this device?`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Remove',
          style: 'destructive',
          onPress: async () => {
            if (!userId) return
            await removeMedication(userId, medication.id)
            await reload()
          },
        },
      ],
    )
  }

  const takenToday = medications.filter((medication) => medication.takenToday).length

  return (
    <Screen>
      <ScrollView contentContainerStyle={styles.scroll} showsVerticalScrollIndicator={false}>
        <SectionHeader title="Add a medicine" />
        <Card style={styles.formCard}>
          <TextField
            label="Name"
            value={name}
            onChangeText={setName}
            placeholder="As written on the pack"
            autoCapitalize="words"
          />
          <TextField
            label="Dose (optional)"
            value={dose}
            onChangeText={setDose}
            placeholder="e.g. 500 mg, 1 tablet"
          />
          <TextField
            label="When (optional)"
            value={schedule}
            onChangeText={setSchedule}
            placeholder="e.g. morning and night, after food"
          />
          <TextField
            label="Note (optional)"
            value={notes}
            onChangeText={setNotes}
            placeholder="e.g. prescribed by Dr Achen"
          />

          {error ? <Text style={[styles.error, { color: colors.error }]}>{error}</Text> : null}

          <Button label="Add medicine" onPress={add} loading={saving} />
        </Card>

        <SectionHeader title="Your medicines" style={styles.spacer} />
        {medications.length === 0 ? (
          <Card>
            <Text style={[styles.empty, { color: colors.textMuted }]}>
              Nothing added yet. Add what you take, then tick it off after each dose.
            </Text>
          </Card>
        ) : (
          <>
            <Text style={[styles.count, { color: colors.textSecondary }]}>
              {takenToday} of {medications.length} ticked off today
            </Text>
            <View style={styles.list}>
              {medications.map((medication) => (
                <Pressable
                  key={medication.id}
                  onLongPress={() => remove(medication)}
                  accessibilityRole="button"
                  accessibilityLabel={`${medication.name}, long press to remove`}
                >
                  <Card>
                    <View style={styles.itemHead}>
                      <View style={styles.itemText}>
                        <Text style={[styles.itemName, { color: colors.text }]}>
                          {medication.name}
                        </Text>
                        {medication.dose || medication.schedule ? (
                          <Text style={[styles.itemMeta, { color: colors.textSecondary }]}>
                            {[medication.dose, medication.schedule].filter(Boolean).join(' · ')}
                          </Text>
                        ) : null}
                        {medication.notes ? (
                          <Text style={[styles.itemNote, { color: colors.textMuted }]}>
                            {medication.notes}
                          </Text>
                        ) : null}
                      </View>
                    </View>

                    <View style={styles.adherence}>
                      <View style={styles.dots}>
                        {Array.from({ length: 7 }, (_, index) => {
                          const filled = index < medication.daysTakenLastWeek
                          return (
                            <View
                              key={index}
                              style={[
                                styles.dot,
                                {
                                  backgroundColor: filled ? colors.primary : colors.bgElevated,
                                  borderColor: filled ? colors.primary : colors.border,
                                },
                              ]}
                            />
                          )
                        })}
                      </View>
                      <Text style={[styles.adherenceText, { color: colors.textMuted }]}>
                        {medication.daysTakenLastWeek} of the last 7 days
                      </Text>
                    </View>

                    {medication.takenToday ? (
                      <View style={[styles.takenPill, { borderColor: colors.border }]}>
                        <Ionicons name="checkmark-circle" size={16} color={colors.success} />
                        <Text style={[styles.takenText, { color: colors.textSecondary }]}>
                          Taken today
                        </Text>
                      </View>
                    ) : (
                      <Pressable
                        onPress={() => markTaken(medication)}
                        disabled={busyId === medication.id}
                        accessibilityRole="button"
                        accessibilityLabel={`Mark ${medication.name} taken today`}
                        style={({ pressed }) => [
                          styles.takePill,
                          { backgroundColor: colors.primarySoft, borderColor: colors.primary },
                          (pressed || busyId === medication.id) && styles.pressed,
                        ]}
                      >
                        <Ionicons name="add-circle-outline" size={16} color={colors.primary} />
                        <Text style={[styles.takeText, { color: colors.primary }]}>
                          Mark taken today
                        </Text>
                      </Pressable>
                    )}
                  </Card>
                </Pressable>
              ))}
            </View>
          </>
        )}

        <Text style={[styles.hint, { color: colors.textMuted }]}>
          Long press a medicine to remove it. The app only records what you tick — it does not
          remind you, check doses, or warn about interactions.
        </Text>
      </ScrollView>
    </Screen>
  )
}

const styles = StyleSheet.create({
  scroll: { padding: spacing.xxl, gap: spacing.md },
  formCard: { gap: spacing.xs },
  error: { ...typography.caption, marginBottom: spacing.md, textAlign: 'center' },
  spacer: { marginTop: spacing.lg },
  empty: { ...typography.caption, fontFamily: 'DMSans_400Regular', lineHeight: 18 },
  count: { ...typography.caption, marginBottom: spacing.sm },
  list: { gap: spacing.sm },
  itemHead: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  itemText: { flex: 1, gap: 2 },
  itemName: { ...typography.bodyMedium, fontFamily: 'DMSans_500Medium' },
  itemMeta: { ...typography.caption },
  itemNote: { ...typography.caption, marginTop: 2 },
  adherence: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, marginTop: spacing.md },
  dots: { flexDirection: 'row', gap: 6 },
  dot: { width: 10, height: 10, borderRadius: 5, borderWidth: 1 },
  adherenceText: { ...typography.caption },
  takenPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    borderTopWidth: 1,
    marginTop: spacing.md,
    paddingTop: spacing.md,
  },
  takenText: { ...typography.caption },
  takePill: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    borderRadius: radii.md,
    borderWidth: 1,
    paddingVertical: spacing.sm,
    marginTop: spacing.md,
  },
  takeText: { ...typography.caption, fontFamily: 'DMSans_500Medium' },
  pressed: { opacity: 0.9 },
  hint: {
    ...typography.caption,
    fontFamily: 'DMSans_400Regular',
    lineHeight: 18,
    marginTop: spacing.lg,
    textAlign: 'center',
  },
})
