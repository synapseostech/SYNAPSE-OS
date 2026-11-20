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
import {
  GENDER_OPTIONS,
  SEX_AT_BIRTH_OPTIONS,
  signupSexPayload,
  type GenderIdentity,
  type SexAtBirth,
} from '@/lib/health-sections'
import { colors, radii, spacing, typography, makeStyles, useTheme } from '@/lib/theme'

type Step = 'form' | 'sent'

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
  const styles = useStyles()
  const { colors } = useTheme()
  const [step, setStep] = useState<Step>('form')
  const [firstName, setFirstName] = useState('')
  const [lastName, setLastName] = useState('')
  const [email, setEmail] = useState('')
  const [phone, setPhone] = useState('')
  const [dob, setDob] = useState('')
  const [sex, setSex] = useState<SexAtBirth | null>(null)
  const [gender, setGender] = useState<GenderIdentity | null>(null)
  const [selfDescribed, setSelfDescribed] = useState('')
  const [showMore, setShowMore] = useState(false)
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
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
          ...signupSexPayload(sex, gender, selfDescribed),
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
                  label="Password"
                  value={password}
                  onChangeText={setPassword}
                  placeholder="••••••••"
                  secureTextEntry={!showPassword}
                  autoComplete="new-password"
                  hint="8+ characters with an uppercase letter, a number and a symbol."
                  editable={!isLoading}
                />
                <Pressable
                  onPress={() => setShowPassword((v) => !v)}
                  accessibilityRole="button"
                  style={styles.inlineLink}
                >
                  <Text style={styles.inlineLinkText}>{showPassword ? 'Hide password' : 'Show password'}</Text>
                </Pressable>

                <ChoiceChips
                  label="Sex at birth"
                  options={SEX_AT_BIRTH_OPTIONS}
                  value={sex}
                  onChange={setSex}
                />
                <Text style={styles.chipHint}>
                  Shows the health sections that apply to you, like cycle and pregnancy or prostate checks.
                  You can change them any time.
                </Text>

                <Pressable
                  onPress={() => setShowMore((v) => !v)}
                  accessibilityRole="button"
                  accessibilityState={{ expanded: showMore }}
                  style={styles.inlineLink}
                >
                  <Text style={styles.inlineLinkText}>
                    {showMore ? 'Hide optional details' : 'Add phone, birthday or gender (optional)'}
                  </Text>
                </Pressable>

                {showMore ? (
                  <View>
                    <TextField
                      label="Phone"
                      value={phone}
                      onChangeText={setPhone}
                      placeholder="+256 7XX XXX XXX"
                      keyboardType="phone-pad"
                      autoComplete="tel"
                      editable={!isLoading}
                    />
                    <TextField
                      label="Date of birth"
                      value={dob}
                      onChangeText={setDob}
                      placeholder="YYYY-MM-DD"
                      keyboardType={Platform.OS === 'ios' ? 'numbers-and-punctuation' : 'default'}
                      hint="Makes reminders and readings age-appropriate."
                      editable={!isLoading}
                    />
                    <ChoiceChips label="Gender" options={GENDER_OPTIONS} value={gender} onChange={setGender} />
                    {gender === 'self_describe' ? (
                      <TextField
                        label="How do you describe your gender?"
                        value={selfDescribed}
                        onChangeText={setSelfDescribed}
                        editable={!isLoading}
                      />
                    ) : null}
                  </View>
                ) : null}

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

const useStyles = makeStyles((colors) => ({
  flex: { flex: 1 },
  scroll: {
    flexGrow: 1,
    justifyContent: 'center',
    paddingHorizontal: spacing.xxl,
    gap: spacing.xxxl,
  },
  formCard: { marginTop: spacing.sm },
  formInner: { padding: spacing.xxl },
  inlineLink: { alignSelf: 'flex-start', marginTop: -spacing.sm, marginBottom: spacing.lg },
  inlineLinkText: { ...typography.caption, color: colors.primary, fontFamily: 'DMSans_500Medium' },
  chipHint: { ...typography.caption, color: colors.textMuted, marginTop: -spacing.sm, marginBottom: spacing.lg },
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
}))
