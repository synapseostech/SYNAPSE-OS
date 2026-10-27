import { useState } from 'react'
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useRouter } from 'expo-router'
import { BrandWordmark } from '@/components/BrandWordmark'
import { Screen } from '@/components/ui/Screen'
import { Card } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { ChoiceChips } from '@/components/ui/ChoiceChips'
import { TextField } from '@/components/ui/TextField'
import { apiRequest, ApiError } from '@/lib/api'
import { colors, radii, spacing, typography } from '@/lib/theme'

type Step = 'form' | 'sent'
type Sex = 'female' | 'male' | 'other' | 'undisclosed'

const SEX_OPTIONS = [
  { value: 'female', label: 'Female' },
  { value: 'male', label: 'Male' },
  { value: 'other', label: 'Other' },
  { value: 'undisclosed', label: 'Prefer not to say' },
] as const satisfies ReadonlyArray<{ value: Sex; label: string }>

/** Mirrors validatePasswordStrength in @synapse/auth so the error precedes the round trip. */
function passwordProblem(password: string): string | null {
  if (password.length < 8) return 'Use at least 8 characters.'
  if (!/[A-Z]/.test(password)) return 'Add at least one uppercase letter.'
  if (!/[0-9]/.test(password)) return 'Add at least one number.'
  if (!/[^A-Za-z0-9]/.test(password)) return 'Add at least one special character.'
  return null
}

/** YYYY-MM-DD only; the server stores it as a date. */
function normaliseDob(input: string): string | null {
  const trimmed = input.trim()
  if (!trimmed) return null
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(trimmed)
  if (!match) return null
  const [, y, m, d] = match
  const date = new Date(`${y}-${m}-${d}T00:00:00`)
  if (
    Number.isNaN(date.getTime()) ||
    date.getFullYear() !== Number(y) ||
    date.getMonth() + 1 !== Number(m) ||
    date.getDate() !== Number(d) ||
    date > new Date()
  ) {
    return null
  }
  return `${y}-${m}-${d}`
}

export default function SignupScreen() {
  const [step, setStep] = useState<Step>('form')
  const [firstName, setFirstName] = useState('')
  const [lastName, setLastName] = useState('')
  const [email, setEmail] = useState('')
  const [phone, setPhone] = useState('')
  const [dob, setDob] = useState('')
  const [sex, setSex] = useState<Sex | null>(null)
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [isLoading, setIsLoading] = useState(false)
  const [resent, setResent] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const router = useRouter()
  const insets = useSafeAreaInsets()

  const submit = async () => {
    setError(null)

    if (!firstName.trim() || !lastName.trim()) {
      setError('Enter your first and last name.')
      return
    }
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email.trim())) {
      setError('Enter a valid email address.')
      return
    }
    const problem = passwordProblem(password)
    if (problem) {
      setError(problem)
      return
    }
    if (password !== confirm) {
      setError('The two passwords do not match.')
      return
    }
    let dateOfBirth: string | null = null
    if (dob.trim()) {
      dateOfBirth = normaliseDob(dob)
      if (!dateOfBirth) {
        setError('Enter your date of birth as YYYY-MM-DD.')
        return
      }
    }

    setIsLoading(true)
    try {
      await apiRequest<{ ok: boolean; activationRequired?: boolean }>('/api/auth/signup/patient', {
        method: 'POST',
        body: {
          first_name: firstName.trim(),
          last_name: lastName.trim(),
          email: email.trim().toLowerCase(),
          phone: phone.trim(),
          dob: dateOfBirth ?? '',
          gender: sex ?? '',
          password,
        },
      })
      // The endpoint answers identically for new and existing addresses, so the
      // screen never reveals whether an account already existed.
      setStep('sent')
    } catch (err: unknown) {
      if (err instanceof ApiError && err.status === 429) {
        setError('Too many attempts. Wait a few minutes and try again.')
      } else {
        setError(err instanceof Error ? err.message : 'Could not create the account. Try again.')
      }
    } finally {
      setIsLoading(false)
    }
  }

  const resend = async () => {
    setResent(false)
    setError(null)
    setIsLoading(true)
    try {
      await apiRequest<{ ok: boolean }>('/api/auth/activation/resend', {
        method: 'POST',
        body: { email: email.trim().toLowerCase() },
      })
      setResent(true)
    } catch {
      // The resend endpoint is generic by design; a failure here is a network or
      // rate-limit problem, not an account problem.
      setError('Could not request another email. Try again shortly.')
    } finally {
      setIsLoading(false)
    }
  }

  return (
    <Screen glow>
      <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
        <ScrollView
          contentContainerStyle={[
            styles.scroll,
            { paddingTop: insets.top + spacing.xxxl, paddingBottom: insets.bottom + spacing.xxl },
          ]}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          <BrandWordmark
            logoSize="xl"
            subtitle={step === 'form' ? 'Create your health account' : 'Confirm your email'}
          />

          {step === 'form' ? (
            <Card style={styles.formCard} padded={false}>
              <View style={styles.formInner}>
                <View style={styles.nameRow}>
                  <View style={styles.nameCol}>
                    <TextField
                      label="First name"
                      value={firstName}
                      onChangeText={setFirstName}
                      placeholder="Jane"
                      autoCapitalize="words"
                      autoComplete="given-name"
                      editable={!isLoading}
                    />
                  </View>
                  <View style={styles.nameCol}>
                    <TextField
                      label="Last name"
                      value={lastName}
                      onChangeText={setLastName}
                      placeholder="Nakato"
                      autoCapitalize="words"
                      autoComplete="family-name"
                      editable={!isLoading}
                    />
                  </View>
                </View>

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
                  autoComplete="tel"
                  editable={!isLoading}
                />
                <TextField
                  label="Date of birth (optional)"
                  value={dob}
                  onChangeText={setDob}
                  placeholder="YYYY-MM-DD"
                  keyboardType={Platform.OS === 'ios' ? 'numbers-and-punctuation' : 'default'}
                  hint="Used only to make readings age-appropriate."
                  editable={!isLoading}
                />
                <ChoiceChips
                  label="Sex (optional)"
                  options={SEX_OPTIONS}
                  value={sex}
                  onChange={setSex}
                />

                <TextField
                  label="Password"
                  value={password}
                  onChangeText={setPassword}
                  placeholder="••••••••"
                  secureTextEntry
                  autoComplete="new-password"
                  hint="At least 8 characters, with an uppercase letter, a number and a symbol."
                  editable={!isLoading}
                />
                <TextField
                  label="Confirm password"
                  value={confirm}
                  onChangeText={setConfirm}
                  placeholder="••••••••"
                  secureTextEntry
                  autoComplete="new-password"
                  editable={!isLoading}
                />

                {error ? (
                  <View style={styles.errorBox}>
                    <Text style={styles.errorText}>{error}</Text>
                  </View>
                ) : null}

                <Button label="Create account" onPress={submit} loading={isLoading} />
              </View>
            </Card>
          ) : (
            <Card style={styles.formCard} padded={false}>
              <View style={styles.formInner}>
                <Text style={[styles.sentTitle, { color: colors.text }]}>Check your inbox</Text>
                <Text style={[styles.sentBody, { color: colors.textSecondary }]}>
                  If {email.trim()} is not already registered, we sent a link to activate it. Open
                  that link, then come back and sign in.
                </Text>
                <Text style={[styles.sentHint, { color: colors.textMuted }]}>
                  Nothing arrived? Check spam, or send another email.
                </Text>

                {error ? (
                  <View style={styles.errorBox}>
                    <Text style={styles.errorText}>{error}</Text>
                  </View>
                ) : null}
                {resent ? (
                  <Text style={[styles.resentText, { color: colors.success }]}>
                    Request sent. If the address still needs activating, another email is on its way.
                  </Text>
                ) : null}

                <Button label="Resend activation email" onPress={resend} loading={isLoading} />
                <Pressable
                  onPress={() => router.replace('/(auth)/login' as never)}
                  style={styles.backBtn}
                  accessibilityRole="button"
                >
                  <Text style={styles.backText}>Back to sign in</Text>
                </Pressable>
              </View>
            </Card>
          )}

          {step === 'form' ? (
            <Pressable
              onPress={() => router.back()}
              style={styles.createBtn}
              accessibilityRole="button"
              accessibilityLabel="Back to sign in"
            >
              <Text style={styles.createText}>
                Already have an account? <Text style={styles.createLink}>Sign in</Text>
              </Text>
            </Pressable>
          ) : null}

          <Text style={styles.footer}>Synapse Health Technologies</Text>
        </ScrollView>
      </KeyboardAvoidingView>
    </Screen>
  )
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  scroll: {
    flexGrow: 1,
    justifyContent: 'center',
    paddingHorizontal: spacing.xxl,
    gap: spacing.xxxl,
  },
  formCard: { marginTop: spacing.sm },
  formInner: { padding: spacing.xxl },
  nameRow: { flexDirection: 'row', gap: spacing.md },
  nameCol: { flex: 1 },
  sentTitle: {
    ...typography.h3,
    marginBottom: spacing.md,
  },
  sentBody: {
    ...typography.body,
    lineHeight: 22,
  },
  sentHint: {
    ...typography.caption,
    marginTop: spacing.sm,
    marginBottom: spacing.lg,
  },
  resentText: {
    ...typography.caption,
    marginBottom: spacing.md,
  },
  errorBox: {
    backgroundColor: colors.errorBg,
    borderRadius: radii.sm,
    borderWidth: 1,
    borderColor: colors.errorBorder,
    padding: spacing.md,
    marginBottom: spacing.lg,
  },
  errorText: {
    ...typography.caption,
    color: colors.error,
    fontFamily: 'DMSans_400Regular',
    textAlign: 'center',
  },
  backBtn: { marginTop: spacing.lg, alignItems: 'center' },
  backText: {
    ...typography.bodyMedium,
    color: colors.primary,
    fontFamily: 'DMSans_500Medium',
  },
  createBtn: { alignItems: 'center' },
  createText: {
    ...typography.caption,
    color: colors.textSecondary,
    fontFamily: 'DMSans_400Regular',
  },
  createLink: {
    color: colors.primary,
    fontFamily: 'DMSans_500Medium',
  },
  footer: {
    textAlign: 'center',
    color: colors.textMuted,
    fontSize: 11,
    fontFamily: 'DMSans_400Regular',
    letterSpacing: 0.5,
  },
})
