import { useState } from 'react'
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useRouter } from 'expo-router'
import { BrandWordmark } from '@/components/BrandWordmark'
import { Screen } from '@/components/ui/Screen'
import { Card } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { TextField } from '@/components/ui/TextField'
import { useAuth } from '@/lib/auth'
import { colors, radii, spacing, typography } from '@/lib/theme'

type Step = 'credentials' | 'otp'

export default function LoginScreen() {
  const [step, setStep] = useState<Step>('credentials')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [otp, setOtp] = useState('')
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const { login, verifyLoginOtp } = useAuth()
  const router = useRouter()
  const insets = useSafeAreaInsets()

  const handleCredentials = async () => {
    if (!email.trim() || !password) {
      setError('Email and password are required.')
      return
    }
    setIsLoading(true)
    setError(null)
    try {
      await login(email.trim().toLowerCase(), password)
      setStep('otp')
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Sign in failed. Try again.')
    } finally {
      setIsLoading(false)
    }
  }

  const handleOtp = async () => {
    if (otp.length !== 6) {
      setError('Enter the 6-digit code from your email.')
      return
    }
    setIsLoading(true)
    setError(null)
    try {
      await verifyLoginOtp(email.trim().toLowerCase(), otp)
      // The root gate picks the area for this account (clinical, pharmacy or personal).
      router.replace('/')
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Verification failed.')
    } finally {
      setIsLoading(false)
    }
  }

  return (
    <Screen glow>
      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      >
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
            subtitle={step === 'credentials' ? 'Sign in to your workspace' : 'Enter verification code'}
          />

          <Card style={styles.formCard} padded={false}>
            <View style={styles.formInner}>
              {step === 'credentials' ? (
                <>
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
                    label="Password"
                    value={password}
                    onChangeText={setPassword}
                    placeholder="••••••••"
                    secureTextEntry
                    autoComplete="password"
                    editable={!isLoading}
                  />
                  <Pressable
                    onPress={() => router.push('/(auth)/forgot-password' as never)}
                    style={styles.forgotBtn}
                    disabled={isLoading}
                  >
                    <Text style={styles.forgotText}>Forgot password?</Text>
                  </Pressable>
                </>
              ) : (
                <View>
                  <Text style={styles.otpLabel}>Email code</Text>
                  <TextInput
                    value={otp}
                    onChangeText={(v) => setOtp(v.replace(/\D/g, '').slice(0, 6))}
                    placeholder="000000"
                    placeholderTextColor={colors.textMuted}
                    keyboardType="number-pad"
                    maxLength={6}
                    autoFocus
                    editable={!isLoading}
                    style={styles.otpInput}
                  />
                  <Text style={styles.otpHint}>Sent to {email}</Text>
                </View>
              )}

              {error ? (
                <View style={styles.errorBox}>
                  <Text style={styles.errorText}>{error}</Text>
                </View>
              ) : null}

              <Button
                label={step === 'credentials' ? 'Continue' : 'Verify and sign in'}
                onPress={step === 'credentials' ? handleCredentials : handleOtp}
                loading={isLoading}
              />

              {step === 'otp' ? (
                <Pressable
                  onPress={() => { setStep('credentials'); setOtp(''); setError(null) }}
                  style={styles.backBtn}
                >
                  <Text style={styles.backText}>Back</Text>
                </Pressable>
              ) : null}
            </View>
          </Card>

          {step === 'credentials' ? (
            <Pressable
              onPress={() => router.push('/(auth)/signup' as never)}
              style={styles.createBtn}
              accessibilityRole="button"
              accessibilityLabel="Create an account"
            >
              <Text style={styles.createText}>
                New to Synapse? <Text style={styles.createLink}>Create an account</Text>
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
  forgotBtn: { alignSelf: 'flex-end', marginTop: -spacing.sm, marginBottom: spacing.md },
  forgotText: {
    ...typography.caption,
    color: colors.primary,
    fontFamily: 'DMSans_500Medium',
  },
  otpLabel: {
    ...typography.label,
    color: colors.textSecondary,
    fontFamily: 'DMSans_500Medium',
    marginBottom: spacing.sm,
  },
  otpInput: {
    backgroundColor: colors.bgElevated,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.border,
    color: colors.text,
    fontSize: 28,
    fontFamily: 'DMSans_700Bold',
    textAlign: 'center',
    letterSpacing: 10,
    paddingVertical: 16,
  },
  otpHint: {
    ...typography.caption,
    color: colors.textMuted,
    fontFamily: 'DMSans_400Regular',
    marginTop: spacing.sm,
    textAlign: 'center',
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
