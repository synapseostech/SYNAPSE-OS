import { useState } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import { useRouter } from 'expo-router'
import { AuthFormShell } from '@/components/AuthFormShell'
import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { ChoiceChips } from '@/components/ui/ChoiceChips'
import { TextField } from '@/components/ui/TextField'
import { apiRequest } from '@/lib/api'
import { spacing, typography, useTheme } from '@/lib/theme'

type Gender = 'male' | 'female' | 'other'

const GENDERS = [
  { value: 'male', label: 'Male' },
  { value: 'female', label: 'Female' },
  { value: 'other', label: 'Other' },
] as const

export default function DailySignupScreen() {
  const router = useRouter()
  const { colors } = useTheme()
  const [firstName, setFirstName] = useState('')
  const [lastName, setLastName] = useState('')
  const [email, setEmail] = useState('')
  const [phone, setPhone] = useState('')
  const [dob, setDob] = useState('')
  const [gender, setGender] = useState<Gender | null>(null)
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
      await apiRequest('/api/auth/signup/patient', {
        method: 'POST',
        body: {
          first_name: firstName.trim(),
          last_name: lastName.trim(),
          email: email.trim().toLowerCase(),
          phone: phone.trim(),
          dob: dob.trim(),
          gender: gender ?? '',
          password,
        },
      })
      setSent(true)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create the account. Try again.')
    } finally {
      setIsLoading(false)
    }
  }

  if (sent) {
    return (
      <AuthFormShell subtitle="Check your email" showBack={false}>
        <View style={styles.sentWrap}>
          <Text style={[styles.sentTitle, { color: colors.text }]}>Activate your account</Text>
          <Text style={[styles.sentBody, { color: colors.textSecondary }]}>
            We sent an activation link to {email.trim().toLowerCase()}. Open it, then sign in
            here with the password you just chose. Check your spam folder if it does not
            arrive within a few minutes.
          </Text>
          <Button label="Back to sign in" onPress={() => router.replace('/(auth)/login' as never)} />
        </View>
      </AuthFormShell>
    )
  }

  return (
    <AuthFormShell subtitle="Create a daily user account">
      <TextField
        label="First name"
        value={firstName}
        onChangeText={setFirstName}
        placeholder="Amina"
        autoCapitalize="words"
        editable={!isLoading}
      />
      <TextField
        label="Last name"
        value={lastName}
        onChangeText={setLastName}
        placeholder="Okello"
        autoCapitalize="words"
        editable={!isLoading}
      />
      <TextField
        label="Email address"
        value={email}
        onChangeText={setEmail}
        placeholder="you@example.com"
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
      <TextField
        label="Date of birth (optional)"
        value={dob}
        onChangeText={setDob}
        placeholder="YYYY-MM-DD"
        keyboardType="numbers-and-punctuation"
        editable={!isLoading}
      />
      <ChoiceChips label="Sex (optional)" options={GENDERS} value={gender} onChange={setGender} />
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

      <Button label="Create account" onPress={submit} loading={isLoading} />

      <Card style={styles.noteCard}>
        <Text style={[styles.note, { color: colors.textMuted }]}>
          Health readings you log in the app are stored on this device only. They are not sent
          to a hospital or pharmacy record.
        </Text>
      </Card>

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
  noteCard: { marginTop: spacing.lg },
  note: {
    ...typography.caption,
    fontFamily: 'DMSans_400Regular',
    lineHeight: 18,
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
