import { useCallback, useState } from 'react'
import { ScrollView, StyleSheet, Switch, Text, View } from 'react-native'
import { useFocusEffect } from 'expo-router'
import { Button } from '@/components/ui/Button'
import { Card, SectionHeader } from '@/components/ui/Card'
import { ChoiceChips } from '@/components/ui/ChoiceChips'
import { Screen } from '@/components/ui/Screen'
import { TextField } from '@/components/ui/TextField'
import { useAuth } from '@/lib/auth'
import { parseDayInput } from '@/lib/dates'
import {
  getHealthProfile,
  getMedicalId,
  saveHealthProfile,
  saveMedicalId,
  type HealthProfile,
  type MedicalId,
} from '@/lib/personal-store'
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

const SEX_OPTIONS = [
  { value: 'female', label: 'Female' },
  { value: 'male', label: 'Male' },
  { value: 'intersex', label: 'Intersex' },
  { value: 'undisclosed', label: 'Rather not say' },
] as const

type Sex = (typeof SEX_OPTIONS)[number]['value']

type ProfileForm = {
  dateOfBirth: string
  sex: Sex | null
  heightCm: string
  weightKg: string
  insuranceProvider: string
  insuranceNumber: string
  insurancePlan: string
  insuranceExpiry: string
  organDonor: boolean
  donorNumber: string
}

const EMPTY_PROFILE: ProfileForm = {
  dateOfBirth: '',
  sex: null,
  heightCm: '',
  weightKg: '',
  insuranceProvider: '',
  insuranceNumber: '',
  insurancePlan: '',
  insuranceExpiry: '',
  organDonor: false,
  donorNumber: '',
}

function toProfileForm(profile: HealthProfile): ProfileForm {
  const match = SEX_OPTIONS.find((option) => option.value === profile.sex)
  return {
    dateOfBirth: profile.dateOfBirth ?? '',
    sex: match ? match.value : null,
    heightCm: profile.heightCm == null ? '' : String(profile.heightCm),
    weightKg: profile.weightKg == null ? '' : String(profile.weightKg),
    insuranceProvider: profile.insuranceProvider ?? '',
    insuranceNumber: profile.insuranceNumber ?? '',
    insurancePlan: profile.insurancePlan ?? '',
    insuranceExpiry: profile.insuranceExpiry ?? '',
    organDonor: profile.organDonor,
    donorNumber: profile.donorNumber ?? '',
  }
}

/** Parses a measurement field; returns 'bad' when the text is not a number. */
function parseMeasurement(value: string, min: number, max: number): number | null | 'bad' {
  const text = value.trim()
  if (!text) return null
  const number = Number(text.replace(',', '.'))
  if (!Number.isFinite(number) || number < min || number > max) return 'bad'
  return Math.round(number * 10) / 10
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
  const [profile, setProfile] = useState<ProfileForm>(EMPTY_PROFILE)
  const [updatedAt, setUpdatedAt] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const [saving, setSaving] = useState(false)

  const userId = user?.id

  const reload = useCallback(async () => {
    if (!userId) return
    try {
      const [id, savedProfile] = await Promise.all([
        getMedicalId(userId),
        getHealthProfile(userId),
      ])
      setForm(toForm(id))
      setProfile(toProfileForm(savedProfile))
      setUpdatedAt(id.updatedAt ?? savedProfile.updatedAt)
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

  const setP = <K extends keyof ProfileForm>(key: K, value: ProfileForm[K]) => {
    setProfile((current) => ({ ...current, [key]: value }))
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

    const birth = profile.dateOfBirth.trim() ? parseDayInput(profile.dateOfBirth) : null
    if (profile.dateOfBirth.trim() && !birth) {
      setError('Enter the date of birth as YYYY-MM-DD.')
      return
    }
    if (birth && birth.getTime() > Date.now()) {
      setError('The date of birth is in the future.')
      return
    }
    const height = parseMeasurement(profile.heightCm, 30, 250)
    if (height === 'bad') {
      setError('Enter height in centimetres, between 30 and 250.')
      return
    }
    const weight = parseMeasurement(profile.weightKg, 2, 400)
    if (weight === 'bad') {
      setError('Enter weight in kilograms, between 2 and 400.')
      return
    }
    const expiry = profile.insuranceExpiry.trim()
    if (expiry && !parseDayInput(expiry)) {
      setError('Enter the cover end date as YYYY-MM-DD, or leave it blank.')
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
    } catch {
      setError('Could not save the medical ID on this device.')
      setSaving(false)
      return
    }
    try {
      await saveHealthProfile(userId, {
        dateOfBirth: profile.dateOfBirth,
        sex: profile.sex,
        heightCm: height,
        weightKg: weight,
        insuranceProvider: profile.insuranceProvider,
        insuranceNumber: profile.insuranceNumber,
        insurancePlan: profile.insurancePlan,
        insuranceExpiry: expiry || null,
        organDonor: profile.organDonor,
        donorNumber: profile.organDonor ? profile.donorNumber : '',
      })
      await reload()
      setSaved(true)
    } catch {
      // The medical ID row is already committed; saying the whole save failed
      // would send someone back to re-enter data that is on the device.
      setError('Medical ID saved, but the rest of the health profile could not be saved on this device.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Screen>
      <ScrollView contentContainerStyle={styles.scroll} showsVerticalScrollIndicator={false}>
        <Card>
          <Text style={[styles.lead, { color: colors.textSecondary }]}>
            The details you would want written down: what a responder needs if you could not
            answer, plus your own record of cover and measurements. You type it all in yourself —
            the app never guesses, and nothing here is sent anywhere.
          </Text>
          <Text style={[styles.updated, { color: colors.textMuted }]}>
            {formatUpdated(updatedAt)}
          </Text>
        </Card>

        <SectionHeader title="About you" style={styles.spacer} />
        <Card style={styles.formCard}>
          <TextField
            label="Date of birth"
            value={profile.dateOfBirth}
            onChangeText={(v) => setP('dateOfBirth', v)}
            placeholder="YYYY-MM-DD"
            keyboardType="numbers-and-punctuation"
            autoCorrect={false}
          />
          <ChoiceChips
            label="Sex"
            options={SEX_OPTIONS}
            value={profile.sex}
            onChange={(v) => setP('sex', v)}
          />
          <View style={styles.measureRow}>
            <View style={styles.measureField}>
              <TextField
                label="Height (cm)"
                value={profile.heightCm}
                onChangeText={(v) => setP('heightCm', v)}
                placeholder="e.g. 168"
                keyboardType="decimal-pad"
              />
            </View>
            <View style={styles.measureField}>
              <TextField
                label="Weight (kg)"
                value={profile.weightKg}
                onChangeText={(v) => setP('weightKg', v)}
                placeholder="e.g. 64.5"
                keyboardType="decimal-pad"
              />
            </View>
          </View>
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

        <SectionHeader title="Insurance" style={styles.spacer} />
        <Card style={styles.formCard}>
          <Text style={[styles.sectionNote, { color: colors.textMuted }]}>
            Kept so you can read the details back at a counter. The app does not check cover or
            send a claim anywhere.
          </Text>
          <TextField
            label="Insurer or scheme"
            value={profile.insuranceProvider}
            onChangeText={(v) => setP('insuranceProvider', v)}
            placeholder="e.g. AAR, Jubilee, NHIS"
            autoCapitalize="words"
          />
          <TextField
            label="Member or policy number"
            value={profile.insuranceNumber}
            onChangeText={(v) => setP('insuranceNumber', v)}
            placeholder="As printed on the card"
            autoCapitalize="characters"
            autoCorrect={false}
          />
          <TextField
            label="Plan (optional)"
            value={profile.insurancePlan}
            onChangeText={(v) => setP('insurancePlan', v)}
            placeholder="e.g. inpatient only"
          />
          <TextField
            label="Cover ends (optional)"
            value={profile.insuranceExpiry}
            onChangeText={(v) => setP('insuranceExpiry', v)}
            placeholder="YYYY-MM-DD"
            keyboardType="numbers-and-punctuation"
            autoCorrect={false}
            hint="The app will show this date back to you. It does not warn you before it passes."
          />
        </Card>

        <SectionHeader title="Organ donation" style={styles.spacer} />
        <Card style={styles.formCard}>
          <View style={styles.donorRow}>
            <View style={styles.donorText}>
              <Text style={[styles.donorLabel, { color: colors.text }]}>I am a registered donor</Text>
              <Text style={[styles.donorHint, { color: colors.textMuted }]}>
                This is a note for yourself. It is not a registry registration and responders do
                not read it.
              </Text>
            </View>
            <Switch
              value={profile.organDonor}
              onValueChange={(v) => setP('organDonor', v)}
              trackColor={{ true: colors.primary }}
              accessibilityLabel="Registered organ donor"
            />
          </View>
          {profile.organDonor ? (
            <TextField
              label="Donor or registry number (optional)"
              value={profile.donorNumber}
              onChangeText={(v) => setP('donorNumber', v)}
              placeholder="As printed on your donor card"
              autoCapitalize="characters"
              autoCorrect={false}
            />
          ) : null}
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

        <Button label="Save health profile" onPress={save} loading={saving} />

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
  sectionNote: {
    ...typography.caption,
    fontFamily: 'DMSans_400Regular',
    lineHeight: 18,
    marginBottom: spacing.sm,
  },
  measureRow: { flexDirection: 'row', gap: spacing.md },
  measureField: { flex: 1 },
  donorRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  donorText: { flex: 1, gap: 2 },
  donorLabel: { ...typography.bodyMedium, fontFamily: 'DMSans_500Medium' },
  donorHint: { ...typography.caption, fontFamily: 'DMSans_400Regular', lineHeight: 18 },
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
