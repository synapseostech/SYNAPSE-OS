import { useState } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import { useRouter } from 'expo-router'
import { AuthFormShell } from '@/components/AuthFormShell'
import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { TextField } from '@/components/ui/TextField'
import { apiRequest } from '@/lib/api'
import { spacing, typography, useTheme } from '@/lib/theme'

interface RegisterResponse {
  ok: boolean
  tenantId: string
  profileId: string
  slug: string
  planSlug: string
  status: string
  trialEnds: string
  redirect: string
}

function normalizePhone(raw: string): string {
  const digits = raw.replace(/[^\d+]/g, '')
  if (digits.startsWith('+256')) return digits
  if (digits.startsWith('256')) return `+${digits}`
  if (digits.startsWith('0') && digits.length === 10) return `+256${digits.slice(1)}`
  if (/^7\d{8}$/.test(digits)) return `+256${digits}`
  return digits
}

function passwordProblem(password: string): string | null {
  if (password.length < 8) return 'Use at least 8 characters for your password.'
  if (!/[A-Z]/.test(password)) return 'Add at least one uppercase letter.'
  if (!/[0-9]/.test(password)) return 'Add at least one number.'
  if (!/[^A-Za-z0-9]/.test(password)) return 'Add at least one special character.'
  return null
}

function formatDate(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  return date.toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' })
}

export default function PharmacySignupScreen() {
  const router = useRouter()
  const { colors } = useTheme()

  const [pharmacyName, setPharmacyName] = useState('')
  const [licenseNumber, setLicenseNumber] = useState('')
  const [district, setDistrict] = useState('')
  const [physicalAddress, setPhysicalAddress] = useState('')
  const [fullName, setFullName] = useState('')
  const [phone, setPhone] = useState('+256')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [consent, setConsent] = useState(false)
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<RegisterResponse | null>(null)

  const validate = (): string | null => {
    if (!pharmacyName.trim()) return 'Pharmacy name is required.'
    if (!licenseNumber.trim()) return 'NDA / Pharmacy Board licence number is required.'
    if (!district.trim()) return 'Enter the district where the pharmacy is registered.'
    if (!physicalAddress.trim()) return 'Physical address is required.'
    if (!fullName.trim()) return 'Owner full name is required.'
    if (!/^\+2567\d{8}$/.test(normalizePhone(phone))) {
      return 'Phone must be +2567XXXXXXXX.'
    }
    if (!email.includes('@')) return 'Enter a valid email address.'
    const problem = passwordProblem(password)
    if (problem) return problem
    if (password !== confirm) return 'The passwords do not match.'
    if (!consent) return 'You must consent under the PDPO to continue.'
    return null
  }

  const submit = async () => {
    const problem = validate()
    if (problem) {
      setError(problem)
      return
    }
    setError(null)
    setIsLoading(true)
    try {
      const response = await apiRequest<RegisterResponse>('/api/auth/register', {
        method: 'POST',
        service: 'pharmacy',
        body: {
          pharmacyName: pharmacyName.trim(),
          licenseNumber: licenseNumber.trim(),
          district: district.trim(),
          physicalAddress: physicalAddress.trim(),
          fullName: fullName.trim(),
          phone: normalizePhone(phone),
          email: email.trim().toLowerCase(),
          password,
          pdpoConsent: consent,
        },
      })
      setResult(response)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create the account. Try again.')
    } finally {
      setIsLoading(false)
    }
  }

  if (result) {
    return (
      <AuthFormShell subtitle="Pharmacy workspace created" showBack={false}>
        <View style={styles.sentWrap}>
          <Ionicons name="checkmark-circle" size={44} color={colors.success} />
          <Text style={[styles.sentTitle, { color: colors.text }]}>Your workspace is ready</Text>
          <Text style={[styles.sentBody, { color: colors.textSecondary }]}>
            {pharmacyName.trim()} was created with a 7-day trial
            {result.trialEnds ? ` ending ${formatDate(result.trialEnds)}` : ''}. Sign in with{' '}
            {email.trim().toLowerCase()}; we will email a one-time code to confirm it is you.
          </Text>
          {result.slug ? (
            <Card>
              <Text style={[styles.slugLabel, { color: colors.textMuted }]}>Workspace ID</Text>
              <Text style={[styles.slugValue, { color: colors.text }]}>{result.slug}</Text>
            </Card>
          ) : null}
          <Button
            label="Sign in"
            onPress={() => router.replace('/(auth)/login' as never)}
          />
        </View>
      </AuthFormShell>
    )
  }

  return (
    <AuthFormShell subtitle="Create a pharmacy account">
      <Text style={[styles.intro, { color: colors.textSecondary }]}>
        Create the pharmacy workspace and its owner account. You can add staff, branches and stock
        after signing in.
      </Text>

      <TextField
        label="Pharmacy name"
        value={pharmacyName}
        onChangeText={setPharmacyName}
        placeholder="e.g. CityCare Pharmacy"
        autoCapitalize="words"
        editable={!isLoading}
      />
      <TextField
        label="NDA / Pharmacy Board licence number"
        value={licenseNumber}
        onChangeText={setLicenseNumber}
        placeholder="Licence number"
        autoCapitalize="characters"
        editable={!isLoading}
      />
      <TextField
        label="District"
        value={district}
        onChangeText={setDistrict}
        placeholder="e.g. Kampala"
        hint="Use the district name as it appears in Uganda's official list."
        autoCapitalize="words"
        editable={!isLoading}
      />
      <TextField
        label="Physical address"
        value={physicalAddress}
        onChangeText={setPhysicalAddress}
        placeholder="Plot, street, area"
        multiline
        editable={!isLoading}
      />
      <TextField
        label="Owner full name"
        value={fullName}
        onChangeText={setFullName}
        placeholder="Owner or superintendent name"
        autoCapitalize="words"
        editable={!isLoading}
      />
      <TextField
        label="Phone (+256)"
        value={phone}
        onChangeText={setPhone}
        placeholder="+2567XXXXXXXX"
        keyboardType="phone-pad"
        editable={!isLoading}
      />
      <TextField
        label="Email address"
        value={email}
        onChangeText={setEmail}
        placeholder="owner@example.com"
        keyboardType="email-address"
        autoCapitalize="none"
        autoComplete="email"
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

      <Pressable
        onPress={() => setConsent((value) => !value)}
        disabled={isLoading}
        style={styles.consentRow}
        accessibilityRole="checkbox"
        accessibilityState={{ checked: consent, disabled: isLoading }}
        accessibilityLabel="Consent to data processing under the PDPO"
      >
        <Ionicons
          name={consent ? 'checkbox' : 'square-outline'}
          size={22}
          color={consent ? colors.primary : colors.textMuted}
        />
        <Text style={[styles.consentText, { color: colors.textSecondary }]}>
          I consent to Synapse Health Technologies Limited processing this pharmacy&apos;s data
          under Uganda&apos;s Data Protection and Privacy Act (PDPO).
        </Text>
      </Pressable>

      {error ? (
        <View
          style={[
            styles.errorBox,
            { backgroundColor: colors.errorBg, borderColor: colors.errorBorder },
          ]}
        >
          <Text style={[styles.errorText, { color: colors.error }]}>{error}</Text>
        </View>
      ) : null}

      <Button label="Create pharmacy account" onPress={submit} loading={isLoading} />

      <Card style={styles.noteCard}>
        <Text style={[styles.note, { color: colors.textMuted }]}>
          The workspace starts on a 7-day trial. Plan changes, billing and full reports stay in the
          web portal.
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
  intro: {
    ...typography.bodySm,
    lineHeight: 20,
    marginBottom: spacing.lg,
  },
  sentWrap: { gap: spacing.lg, alignItems: 'center' },
  sentTitle: {
    ...typography.title,
    fontSize: 20,
    textAlign: 'center',
  },
  sentBody: {
    ...typography.body,
    lineHeight: 22,
    textAlign: 'center',
  },
  slugLabel: {
    ...typography.caption,
    textAlign: 'center',
  },
  slugValue: {
    ...typography.bodyMedium,
    fontFamily: 'IBMPlexMono_500Medium',
    marginTop: spacing.xs,
    textAlign: 'center',
  },
  consentRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.md,
    marginBottom: spacing.lg,
  },
  consentText: {
    ...typography.caption,
    flex: 1,
    lineHeight: 18,
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
