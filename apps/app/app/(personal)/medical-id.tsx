import { useCallback, useState } from 'react'
import { ScrollView, StyleSheet, Text } from 'react-native'
import { useFocusEffect } from 'expo-router'
import { Button } from '@/components/ui/Button'
import { Card, SectionHeader } from '@/components/ui/Card'
import { ChoiceChips } from '@/components/ui/ChoiceChips'
import { Screen } from '@/components/ui/Screen'
import { TextField } from '@/components/ui/TextField'
import { useAuth } from '@/lib/auth'
import { getMedicalId, saveMedicalId, type MedicalId } from '@/lib/personal-store'
import { spacing, typography, useTheme } from '@/lib/theme'

const BLOOD_GROUPS = [
  { value: 'A+', label: 'A+' },
  { value: 'A-', label: 'A−' },
  { value: 'B+', label: 'B+' },
  { value: 'B-', label: 'B−' },
  { value: 'AB+', label: 'AB+' },
  { value: 'AB-', label: 'AB−' },
  { value: 'O+', label: 'O+' },
  { value: 'O-', label: 'O−' },
  { value: 'unknown', label: 'Not known' },
] as const

type BloodGroup = (typeof BLOOD_GROUPS)[number]['value']

type Form = {
  bloodGroup: BloodGroup | null
  allergies: string
  conditions: string
  regularMedications: string
  emergencyName: string
  emergencyPhone: string
  notes: string
}

const EMPTY_FORM: Form = {
  bloodGroup: null,
  allergies: '',
  conditions: '',
  regularMedications: '',
  emergencyName: '',
  emergencyPhone: '',
  notes: '',
}

function toForm(id: MedicalId): Form {
  const stored = id.bloodGroup
  const match = BLOOD_GROUPS.find((group) => group.value === stored)
  return {
    bloodGroup: match ? match.value : null,
    allergies: id.allergies ?? '',
    conditions: id.conditions ?? '',
    regularMedications: id.regularMedications ?? '',
    emergencyName: id.emergencyName ?? '',
    emergencyPhone: id.emergencyPhone ?? '',
    notes: id.notes ?? '',
  }
}

function formatUpdated(iso: string | null): string {
  if (!iso) return 'Not filled in yet'
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return 'Saved'
  return `Last saved ${date.toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  })}`
}

export default function PersonalMedicalIdScreen() {
  const { user } = useAuth()
  const { colors } = useTheme()
  const [form, setForm] = useState<Form>(EMPTY_FORM)
  const [updatedAt, setUpdatedAt] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const [saving, setSaving] = useState(false)

  const userId = user?.id

  const reload = useCallback(async () => {
    if (!userId) return
    try {
      const id = await getMedicalId(userId)
      setForm(toForm(id))
      setUpdatedAt(id.updatedAt)
    } catch {
      setError('Could not read the medical ID saved on this device.')
    }
  }, [userId])

  useFocusEffect(
    useCallback(() => {
      void reload()
    }, [reload]),
  )

  const set = <K extends keyof Form>(key: K, value: Form[K]) => {
    setForm((current) => ({ ...current, [key]: value }))
    setSaved(false)
  }

  const save = async () => {
    setError(null)
    if (!userId) return
    const phone = form.emergencyPhone.trim()
    if (phone && !/^[+0-9][0-9 ()-]{5,}$/.test(phone)) {
      setError('Enter the emergency phone number in digits, with an optional leading +.')
      return
    }
    setSaving(true)
    try {
      await saveMedicalId(userId, {
        bloodGroup: form.bloodGroup ?? null,
        allergies: form.allergies,
        conditions: form.conditions,
        regularMedications: form.regularMedications,
        emergencyName: form.emergencyName,
        emergencyPhone: form.emergencyPhone,
        notes: form.notes,
      })
      await reload()
      setSaved(true)
    } catch {
      setError('Could not save the medical ID on this device.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Screen>
      <ScrollView contentContainerStyle={styles.scroll} showsVerticalScrollIndicator={false}>
        <Card>
          <Text style={[styles.lead, { color: colors.textSecondary }]}>
            What a responder would need to know if you were unable to answer. You type it in
            yourself — the app never guesses, and nothing here is sent anywhere.
          </Text>
          <Text style={[styles.updated, { color: colors.textMuted }]}>
            {formatUpdated(updatedAt)}
          </Text>
        </Card>

        <SectionHeader title="Blood group" style={styles.spacer} />
        <Card style={styles.formCard}>
          <ChoiceChips options={BLOOD_GROUPS} value={form.bloodGroup} onChange={(v) => set('bloodGroup', v)} />
        </Card>

        <SectionHeader title="Clinical" style={styles.spacer} />
        <Card style={styles.formCard}>
          <TextField
            label="Allergies"
            value={form.allergies}
            onChangeText={(v) => set('allergies', v)}
            placeholder="e.g. penicillin, peanuts"
            multiline
            style={styles.multiline}
            hint="One per line reads best on a lock screen."
          />
          <TextField
            label="Ongoing conditions"
            value={form.conditions}
            onChangeText={(v) => set('conditions', v)}
            placeholder="e.g. asthma, type 2 diabetes"
            multiline
            style={styles.multiline}
          />
          <TextField
            label="Regular medicines"
            value={form.regularMedications}
            onChangeText={(v) => set('regularMedications', v)}
            placeholder="Name and strength, as written on the pack"
            multiline
            style={styles.multiline}
            hint="Include the dose you actually take. Ask a pharmacist if you are unsure."
          />
        </Card>

        <SectionHeader title="Emergency contact" style={styles.spacer} />
        <Card style={styles.formCard}>
          <TextField
            label="Name"
            value={form.emergencyName}
            onChangeText={(v) => set('emergencyName', v)}
            placeholder="Who should be called"
            autoCapitalize="words"
          />
          <TextField
            label="Phone"
            value={form.emergencyPhone}
            onChangeText={(v) => set('emergencyPhone', v)}
            placeholder="+256 7XX XXX XXX"
            keyboardType="phone-pad"
            autoComplete="tel"
          />
        </Card>

        <SectionHeader title="Anything else" style={styles.spacer} />
        <Card style={styles.formCard}>
          <TextField
            label="Notes"
            value={form.notes}
            onChangeText={(v) => set('notes', v)}
            placeholder="e.g. pacemaker, anticoagulant, organ donor"
            multiline
            style={styles.multiline}
          />
        </Card>

        {error ? <Text style={[styles.error, { color: colors.error }]}>{error}</Text> : null}
        {saved ? (
          <Text style={[styles.saved, { color: colors.success }]}>Saved on this device.</Text>
        ) : null}

        <Button label="Save medical ID" onPress={save} loading={saving} />

        <Text style={[styles.hint, { color: colors.textMuted }]}>
          The app does not interpret these details, check them against any record, or share them
          with a hospital, pharmacy or insurer. Deleting the app deletes them.
        </Text>
      </ScrollView>
    </Screen>
  )
}

const styles = StyleSheet.create({
  scroll: { padding: spacing.xxl, gap: spacing.md },
  lead: { ...typography.body, lineHeight: 22 },
  updated: { ...typography.caption, marginTop: spacing.md },
  formCard: { gap: spacing.xs },
  multiline: { minHeight: 84, textAlignVertical: 'top', paddingTop: 14 },
  spacer: { marginTop: spacing.lg },
  error: { ...typography.caption, marginBottom: spacing.md, textAlign: 'center' },
  saved: { ...typography.caption, marginBottom: spacing.md, textAlign: 'center' },
  hint: {
    ...typography.caption,
    fontFamily: 'DMSans_400Regular',
    lineHeight: 18,
    marginTop: spacing.lg,
    textAlign: 'center',
  },
})
