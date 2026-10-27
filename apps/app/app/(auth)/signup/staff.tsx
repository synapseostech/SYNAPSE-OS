import { useState } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import { useRouter } from 'expo-router'
import { AuthFormShell } from '@/components/AuthFormShell'
import { Button } from '@/components/ui/Button'
import { ChoiceChips } from '@/components/ui/ChoiceChips'
import { TextField } from '@/components/ui/TextField'
import { apiRequest } from '@/lib/api'
import { spacing, typography, useTheme } from '@/lib/theme'

type Specialty = 'doctor' | 'nursing' | 'pharmacy' | 'laboratory' | 'radiology' | 'other'

const SPECIALTIES = [
  { value: 'doctor', label: 'Doctor' },
  { value: 'nursing', label: 'Nursing' },
  { value: 'pharmacy', label: 'Pharmacy' },
  { value: 'laboratory', label: 'Laboratory' },
  { value: 'radiology', label: 'Radiology' },
  { value: 'other', label: 'Other' },
] as const

export default function StaffSignupScreen() {
  const router = useRouter()
  const { colors } = useTheme()
  const [firstName, setFirstName] = useState('')
  const [lastName, setLastName] = useState('')
  const [email, setEmail] = useState('')
  const [phone, setPhone] = useState('')
  const [specialty, setSpecialty] = useState<Specialty | null>(null)
  const [licenseNumber, setLicenseNumber] = useState('')
  const [years, setYears] = useState('')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [sent, setSent] = useState(false)

  const submit = async () => {
    setError(null)
    if (!firstName.trim() || !lastName.trim() || !email.trim()) {
      setError('First name, last name and email are required.')
      return
    }
    if (!specialty) {
      setError('Choose your specialty.')
      return
    }
    if (!licenseNumber.trim()) {
      setError('Enter your practising licence number.')
      return
    }
    if (password.length < 8) {
      setError('Use at least 8 characters for your password.')
      return
    }
    if (password !== confirm) {
      setError('The passwords do not match.')
      return
    }
    setIsLoading(true)
    try {
      await apiRequest('/api/auth/signup/professional', {
        method: 'POST',
        body: {
          first_name: firstName.trim(),
          last_name: lastName.trim(),
          email: email.trim().toLowerCase(),
          phone: phone.trim(),
          gender: '',
          password,
          specialty,
          license_number: licenseNumber.trim(),
          years_experience: years.trim(),
        },
      })
      setSent(true)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not submit the application. Try again.')
    } finally {
      setIsLoading(false)
    }
  }

  if (sent) {
    return (
      <AuthFormShell subtitle="Application received" showBack={false}>
        <View style={styles.sentWrap}>
          <Text style={[styles.sentTitle, { color: colors.text }]}>Check your email</Text>
          <Text style={[styles.sentBody, { color: colors.textSecondary }]}>
            We sent an activation link to {email.trim().toLowerCase()}. After you activate it,
            your hospital confirms your role and attaches you to its workspace before you can
            sign in.
          </Text>
          <Button label="Back to sign in" onPress={() => router.replace('/(auth)/login' as never)} />
        </View>
      </AuthFormShell>
    )
  }

  return (
    <AuthFormShell subtitle="Apply for a hospital account">
      <TextField
        label="First name"
        value={firstName}
        onChangeText={setFirstName}
        placeholder="Grace"
        autoCapitalize="words"
        editable={!isLoading}
      />
      <TextField
        label="Last name"
        value={lastName}
        onChangeText={setLastName}
        placeholder="Nabirye"
        autoCapitalize="words"
        editable={!isLoading}
      />
      <TextField
        label="Email address"
        value={email}
        onChangeText={setEmail}
        placeholder="you@hospital.org"
        keyboardType="email-address"
        autoCapitalize="none"
        autoComplete="email"
        editable={!isLoading}
      />
      <TextField
        label="Phone (optional)"
        value={phone}
        onChangeText={setPhone}
        placeholder="+256 7XX XXX XXX"
        keyboardType="phone-pad"
        editable={!isLoading}
      />
      <ChoiceChips label="Specialty" options={SPECIALTIES} value={specialty} onChange={setSpecialty} />
      <TextField
        label="Practising licence number"
        value={licenseNumber}
        onChangeText={setLicenseNumber}
        placeholder="e.g. UMDPC/12345"
        autoCapitalize="characters"
        editable={!isLoading}
      />
      <TextField
        label="Years of experience (optional)"
        value={years}
        onChangeText={setYears}
        placeholder="0"
        keyboardType="number-pad"
        editable={!isLoading}
      />
      <TextField
        label="Password"
        value={password}
        onChangeText={setPassword}
        placeholder="At least 8 characters"
        secureTextEntry
        autoComplete="new-password"
        editable={!isLoading}
      />
      <TextField
        label="Confirm password"
        value={confirm}
        onChangeText={setConfirm}
        placeholder="Repeat your password"
        secureTextEntry
        editable={!isLoading}
      />

      {error ? (
        <View style={[styles.errorBox, { backgroundColor: colors.errorBg, borderColor: colors.errorBorder }]}>
          <Text style={[styles.errorText, { color: colors.error }]}>{error}</Text>
        </View>
      ) : null}

      <Button label="Submit application" onPress={submit} loading={isLoading} />

      <Pressable
        onPress={() => router.replace('/(auth)/login' as never)}
        style={styles.signIn}
        accessibilityRole="button"
      >
        <Text style={[styles.signInText, { color: colors.textSecondary }]}>
          Already have an account? <Text style={{ color: colors.primary }}>Sign in</Text>
        </Text>
      </Pressable>
    </AuthFormShell>
  )
}

const styles = StyleSheet.create({
  sentWrap: { gap: spacing.lg },
  sentTitle: {
    ...typography.title,
    fontSize: 20,
  },
  sentBody: {
    ...typography.body,
    lineHeight: 22,
  },
  errorBox: {
    borderRadius: 8,
    borderWidth: 1,
    padding: spacing.md,
    marginBottom: spacing.lg,
  },
  errorText: {
    ...typography.caption,
    textAlign: 'center',
  },
  signIn: { alignItems: 'center', marginTop: spacing.lg },
  signInText: {
    ...typography.caption,
    fontFamily: 'DMSans_400Regular',
  },
})
