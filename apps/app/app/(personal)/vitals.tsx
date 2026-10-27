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
  addVitals,
  deleteVitals,
  listVitals,
  type VitalsKind,
  type VitalsReading,
} from '@/lib/personal-store'
import { spacing, typography, useTheme } from '@/lib/theme'

const KINDS = [
  { value: 'blood_pressure', label: 'Blood pressure' },
  { value: 'glucose', label: 'Glucose' },
  { value: 'weight', label: 'Weight' },
  { value: 'heart_rate', label: 'Heart rate' },
] as const

const GLUCOSE_UNITS = [
  { value: 'mmol/L', label: 'mmol/L' },
  { value: 'mg/dL', label: 'mg/dL' },
] as const

const UNIT_FOR: Record<Exclude<VitalsKind, 'glucose'>, string> = {
  blood_pressure: 'mmHg',
  weight: 'kg',
  heart_rate: 'bpm',
}

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

function describe(reading: VitalsReading): string {
  if (reading.kind === 'blood_pressure') {
    return `${reading.systolic ?? '—'}/${reading.diastolic ?? '—'} mmHg`
  }
  return `${reading.value ?? '—'} ${reading.unit}`
}

export default function PersonalVitalsScreen() {
  const { user } = useAuth()
  const { colors } = useTheme()
  const [kind, setKind] = useState<VitalsKind>('blood_pressure')
  const [systolic, setSystolic] = useState('')
  const [diastolic, setDiastolic] = useState('')
  const [value, setValue] = useState('')
  const [glucoseUnit, setGlucoseUnit] = useState<'mmol/L' | 'mg/dL'>('mmol/L')
  const [note, setNote] = useState('')
  const [readings, setReadings] = useState<VitalsReading[]>([])
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  const userId = user?.id

  const reload = useCallback(async () => {
    if (!userId) return
    try {
      setReadings(await listVitals(userId, undefined, 40))
    } catch {
      setError('Could not read the readings saved on this device.')
    }
  }, [userId])

  useFocusEffect(
    useCallback(() => {
      void reload()
    }, [reload]),
  )

  const resetForm = () => {
    setSystolic('')
    setDiastolic('')
    setValue('')
    setNote('')
  }

  const save = async () => {
    setError(null)
    if (!userId) return

    let payload: { systolic?: number; diastolic?: number; value?: number; unit: string }
    if (kind === 'blood_pressure') {
      const sys = Number(systolic)
      const dia = Number(diastolic)
      if (!systolic.trim() || !diastolic.trim() || !Number.isFinite(sys) || !Number.isFinite(dia)) {
        setError('Enter both the systolic and diastolic numbers.')
        return
      }
      payload = { systolic: sys, diastolic: dia, unit: UNIT_FOR.blood_pressure }
    } else {
      const numeric = Number(value)
      if (!value.trim() || !Number.isFinite(numeric)) {
        setError('Enter a number for the reading.')
        return
      }
      payload =
        kind === 'glucose'
          ? { value: numeric, unit: glucoseUnit }
          : { value: numeric, unit: UNIT_FOR[kind] }
    }

    setSaving(true)
    try {
      await addVitals({ userId, kind, note, ...payload })
      resetForm()
      await reload()
    } catch {
      setError('Could not save the reading on this device.')
    } finally {
      setSaving(false)
    }
  }

  const remove = (reading: VitalsReading) => {
    Alert.alert('Delete reading', `Delete ${describe(reading)} from ${formatWhen(reading.recordedAt)}?`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: async () => {
          if (!userId) return
          await deleteVitals(userId, reading.id)
          await reload()
        },
      },
    ])
  }

  return (
    <Screen>
      <ScrollView contentContainerStyle={styles.scroll} showsVerticalScrollIndicator={false}>
        <SectionHeader title="Record a reading" />
        <Card style={styles.formCard}>
          <ChoiceChips options={KINDS} value={kind} onChange={setKind} />

          {kind === 'blood_pressure' ? (
            <View style={styles.row}>
              <View style={styles.rowItem}>
                <TextField
                  label="Systolic"
                  value={systolic}
                  onChangeText={setSystolic}
                  placeholder="120"
                  keyboardType="number-pad"
                />
              </View>
              <View style={styles.rowItem}>
                <TextField
                  label="Diastolic"
                  value={diastolic}
                  onChangeText={setDiastolic}
                  placeholder="80"
                  keyboardType="number-pad"
                />
              </View>
            </View>
          ) : (
            <TextField
              label={kind === 'glucose' ? 'Reading' : kind === 'weight' ? 'Weight' : 'Heart rate'}
              value={value}
              onChangeText={setValue}
              placeholder={kind === 'glucose' ? '5.6' : kind === 'weight' ? '68' : '72'}
              keyboardType="decimal-pad"
            />
          )}

          {kind === 'glucose' ? (
            <ChoiceChips
              label="Unit"
              options={GLUCOSE_UNITS}
              value={glucoseUnit}
              onChange={setGlucoseUnit}
            />
          ) : null}

          <TextField
            label="Note (optional)"
            value={note}
            onChangeText={setNote}
            placeholder="e.g. after breakfast"
          />

          {error ? <Text style={[styles.error, { color: colors.error }]}>{error}</Text> : null}

          <Button label="Save reading" onPress={save} loading={saving} />
        </Card>

        <SectionHeader title="Recent readings" style={styles.spacer} />
        {readings.length === 0 ? (
          <Card>
            <Text style={[styles.empty, { color: colors.textMuted }]}>
              Nothing saved yet. Readings you add here stay on this device.
            </Text>
          </Card>
        ) : (
          <View style={styles.list}>
            {readings.map((reading) => (
              <Pressable
                key={reading.id}
                onLongPress={() => remove(reading)}
                accessibilityRole="button"
                accessibilityLabel={`${describe(reading)}, long press to delete`}
              >
                <Card>
                  <View style={styles.listRow}>
                    <View style={styles.listText}>
                      <Text style={[styles.listValue, { color: colors.text }]}>
                        {describe(reading)}
                      </Text>
                      <Text style={[styles.listWhen, { color: colors.textMuted }]}>
                        {formatWhen(reading.recordedAt)}
                        {reading.note ? ` · ${reading.note}` : ''}
                      </Text>
                    </View>
                  </View>
                </Card>
              </Pressable>
            ))}
          </View>
        )}

        <Text style={[styles.hint, { color: colors.textMuted }]}>
          Long press a reading to delete it. The app does not interpret readings or warn about
          them — take any concern to a clinician.
        </Text>
      </ScrollView>
    </Screen>
  )
}

const styles = StyleSheet.create({
  scroll: { padding: spacing.xxl, gap: spacing.md },
  formCard: { gap: spacing.xs },
  row: { flexDirection: 'row', gap: spacing.md },
  rowItem: { flex: 1 },
  error: { ...typography.caption, marginBottom: spacing.md, textAlign: 'center' },
  spacer: { marginTop: spacing.lg },
  empty: { ...typography.caption, fontFamily: 'DMSans_400Regular', lineHeight: 18 },
  list: { gap: spacing.sm },
  listRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  listText: { flex: 1, gap: 2 },
  listValue: { ...typography.bodyMedium, fontFamily: 'DMSans_500Medium' },
  listWhen: { ...typography.caption },
  hint: {
    ...typography.caption,
    fontFamily: 'DMSans_400Regular',
    lineHeight: 18,
    marginTop: spacing.lg,
    textAlign: 'center',
  },
})
