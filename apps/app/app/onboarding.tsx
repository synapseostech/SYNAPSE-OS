import { useEffect, useState } from 'react'
import {
  Alert,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from 'react-native'
import { useRouter } from 'expo-router'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { Button } from '@/components/ui/Button'
import { LoadingBlock } from '@/components/ui/LoadingBlock'
import { useAuth } from '@/lib/auth'
import { apiRequest, ApiError } from '@/lib/api'
import { radii, spacing, typography, makeStyles, useTheme } from '@/lib/theme'

const STEPS = [
  { number: 1, label: 'Pharmacy profile' },
  { number: 2, label: 'Store setup' },
  { number: 3, label: 'Products' },
  { number: 4, label: 'Network' },
  { number: 5, label: 'Finish' },
]

interface OnboardingData {
  tenantName: string
  address: string
  district: string
  phone: string
  licenseNumber: string
  licenseExpiry: string
  currentStep: number
  completed: boolean
  storeName: string
  storeType: string
}

interface ProductRow {
  name: string
  category: string
  quantity: string
  price: string
  reorderLevel: string
}

export default function OnboardingScreen() {
  const styles = useStyles()
  const { token } = useAuth()
  const router = useRouter()
  const insets = useSafeAreaInsets()
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [step, setStep] = useState(1)

  // Step 1
  const [address, setAddress] = useState('')
  const [district, setDistrict] = useState('')
  const [phone, setPhone] = useState('')
  const [licenseNumber, setLicenseNumber] = useState('')
  const [licenseExpiry, setLicenseExpiry] = useState('')
  const [tenantName, setTenantName] = useState('')
  // Step 2
  const [storeName, setStoreName] = useState('')
  const [storeType, setStoreType] = useState('main')
  // Step 3
  const [products, setProducts] = useState<ProductRow[]>([])
  // Step 4
  const [isNetworkMember, setIsNetworkMember] = useState(false)
  const [acceptsRefillRequests, setAcceptsRefillRequests] = useState(false)
  const [networkListingName, setNetworkListingName] = useState('')

  useEffect(() => {
    let active = true
    async function load() {
      if (!token) {
        setLoading(false)
        return
      }
      try {
        const d = await apiRequest<OnboardingData>('/api/mobile/pharmacy/onboarding', { token })
        if (!active) return
        setTenantName(d.tenantName)
        setAddress(d.address)
        setDistrict(d.district)
        setPhone(d.phone)
        setLicenseNumber(d.licenseNumber)
        setLicenseExpiry(d.licenseExpiry)
        setStoreName(d.storeName)
        setStoreType(d.storeType || 'main')
        setNetworkListingName(d.tenantName)
        if (d.completed) {
          router.replace('/(main)/home' as never)
          return
        }
        setStep(Math.min(Math.max(d.currentStep || 1, 1), 5))
      } catch {
        // stay on step 1
      } finally {
        if (active) setLoading(false)
      }
    }
    load()
    return () => {
      active = false
    }
  }, [token, router])

  const saveStep = async (n: number, data: Record<string, unknown>) => {
    if (!token) return
    setSaving(true)
    try {
      const res = await apiRequest<{ nextStep: number | 'dashboard' }>('/api/mobile/pharmacy/onboarding', {
        method: 'POST',
        token,
        body: { step: n, data },
      })
      if (res.nextStep === 'dashboard') {
        router.replace('/(main)/home' as never)
        return
      }
      setStep(res.nextStep)
    } catch (err) {
      Alert.alert('Could not save', err instanceof ApiError ? err.message : 'Try again.')
    } finally {
      setSaving(false)
    }
  }

  const next = () => {
    if (step === 1) {
      if (!address.trim() || !district.trim() || !phone.trim()) {
        Alert.alert('Missing info', 'Address, district and phone are required.')
        return
      }
      saveStep(1, { address, district, phone, licenseNumber, licenseExpiry })
    } else if (step === 2) {
      if (!storeName.trim()) {
        Alert.alert('Missing info', 'Enter a store name.')
        return
      }
      saveStep(2, { storeName, storeType })
    } else if (step === 3) {
      saveStep(3, { products: products.filter((p) => p.name.trim()) })
    } else if (step === 4) {
      saveStep(4, { isNetworkMember, acceptsRefillRequests, networkListingName })
    } else if (step === 5) {
      saveStep(5, {})
    }
  }

  const addProduct = () =>
    setProducts((prev) => [...prev, { name: '', category: '', quantity: '', price: '', reorderLevel: '' }])
  const updateProduct = (i: number, key: keyof ProductRow, val: string) =>
    setProducts((prev) => prev.map((p, idx) => (idx === i ? { ...p, [key]: val } : p)))

  if (loading) return <LoadingBlock message="Loading onboarding…" />

  return (
    <KeyboardAvoidingView
      style={[styles.root, { paddingTop: insets.top }]}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <View style={styles.header}>
        <Text style={styles.title}>Finish setup</Text>
        <Text style={styles.stepLabel}>
          Step {step} of 5 · {STEPS[step - 1]?.label}
        </Text>
        <View style={styles.progressTrack}>
          <View style={[styles.progressFill, { width: `${(step / 5) * 100}%` }]} />
        </View>
      </View>

      <ScrollView contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + spacing.xxl }]} keyboardShouldPersistTaps="handled">
        {step === 1 && (
          <>
            {tenantName ? <Text style={styles.readonly}>{tenantName}</Text> : null}
            <Field label="Physical address" value={address} onChangeText={setAddress} />
            <Field label="District" value={district} onChangeText={setDistrict} />
            <Field label="Phone" value={phone} onChangeText={setPhone} keyboardType="phone-pad" />
            <Field label="NDA licence number (optional)" value={licenseNumber} onChangeText={setLicenseNumber} />
            <Field label="Licence expiry (YYYY-MM-DD, optional)" value={licenseExpiry} onChangeText={setLicenseExpiry} />
          </>
        )}

        {step === 2 && (
          <>
            <Field label="Store / branch name" value={storeName} onChangeText={setStoreName} />
            <Text style={styles.label}>Store type</Text>
            <View style={styles.chips}>
              {['main', 'dispensary', 'satellite'].map((t) => (
                <Pressable key={t} onPress={() => setStoreType(t)} style={[styles.chip, storeType === t && styles.chipActive]}>
                  <Text style={[styles.chipText, storeType === t && styles.chipTextActive]}>{t}</Text>
                </Pressable>
              ))}
            </View>
          </>
        )}

        {step === 3 && (
          <>
            <Text style={styles.help}>Add a few starting products, or skip and add them later.</Text>
            {products.map((p, i) => (
              <View key={i} style={styles.productCard}>
                <Field label="Name" value={p.name} onChangeText={(v) => updateProduct(i, 'name', v)} />
                <Field label="Category" value={p.category} onChangeText={(v) => updateProduct(i, 'category', v)} />
                <View style={styles.row}>
                  <View style={styles.rowItem}>
                    <Field label="Qty" value={p.quantity} onChangeText={(v) => updateProduct(i, 'quantity', v)} keyboardType="numeric" />
                  </View>
                  <View style={styles.rowItem}>
                    <Field label="Price" value={p.price} onChangeText={(v) => updateProduct(i, 'price', v)} keyboardType="numeric" />
                  </View>
                </View>
              </View>
            ))}
            <Button label="Add product" onPress={addProduct} variant="ghost" />
          </>
        )}

        {step === 4 && (
          <>
            <ToggleRow label="Join the Synapse pharmacy network" value={isNetworkMember} onValueChange={setIsNetworkMember} />
            <ToggleRow label="Accept refill requests" value={acceptsRefillRequests} onValueChange={setAcceptsRefillRequests} />
            {isNetworkMember ? (
              <Field label="Network listing name" value={networkListingName} onChangeText={setNetworkListingName} />
            ) : null}
          </>
        )}

        {step === 5 && (
          <View style={styles.doneBox}>
            <Text style={styles.doneTitle}>You're ready</Text>
            <Text style={styles.help}>Finish to open your pharmacy dashboard.</Text>
          </View>
        )}
      </ScrollView>

      <View style={[styles.footer, { paddingBottom: insets.bottom + spacing.md }]}>
        {step === 3 ? (
          <Button label="Skip" onPress={() => saveStep(3, { products: [] })} variant="ghost" style={styles.footerBtn} />
        ) : null}
        <Button
          label={step === 5 ? 'Finish setup' : 'Continue'}
          onPress={next}
          loading={saving}
          style={styles.footerBtn}
        />
      </View>
    </KeyboardAvoidingView>
  )
}

function Field({
  label,
  value,
  onChangeText,
  keyboardType,
}: {
  label: string
  value: string
  onChangeText: (v: string) => void
  keyboardType?: 'default' | 'numeric' | 'phone-pad'
}) {
  const styles = useStyles()
  const { colors } = useTheme()
  return (
    <View style={{ gap: 4 }}>
      <Text style={styles.label}>{label}</Text>
      <TextInput
        style={styles.input}
        value={value}
        onChangeText={onChangeText}
        keyboardType={keyboardType ?? 'default'}
        autoCapitalize="none"
        placeholderTextColor={colors.textMuted}
      />
    </View>
  )
}

function ToggleRow({ label, value, onValueChange }: { label: string; value: boolean; onValueChange: (v: boolean) => void }) {
  const styles = useStyles()
  const { colors } = useTheme()
  return (
    <View style={styles.toggleRow}>
      <Text style={styles.toggleLabel}>{label}</Text>
      <Switch value={value} onValueChange={onValueChange} trackColor={{ true: colors.primary }} />
    </View>
  )
}

const useStyles = makeStyles((colors) => ({
  root: { flex: 1, backgroundColor: colors.bg },
  header: { paddingHorizontal: spacing.xl, paddingTop: spacing.md, gap: spacing.xs },
  title: { ...typography.h2, color: colors.text, fontFamily: 'BricolageGrotesque_700Bold' },
  stepLabel: { ...typography.caption, color: colors.textSecondary, fontFamily: 'DMSans_500Medium' },
  progressTrack: { height: 6, backgroundColor: colors.border, borderRadius: 3, marginTop: spacing.sm, overflow: 'hidden' },
  progressFill: { height: 6, backgroundColor: colors.primary, borderRadius: 3 },
  content: { padding: spacing.xl, gap: spacing.md },
  readonly: { ...typography.bodyMedium, color: colors.text, fontFamily: 'DMSans_700Bold' },
  help: { ...typography.bodySm, color: colors.textSecondary, fontFamily: 'DMSans_400Regular' },
  label: { ...typography.caption, color: colors.textSecondary, fontFamily: 'DMSans_500Medium' },
  input: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.md,
    padding: spacing.md,
    color: colors.text,
    backgroundColor: colors.bgElevated,
    fontFamily: 'DMSans_400Regular',
  },
  chips: { flexDirection: 'row', gap: spacing.sm, flexWrap: 'wrap' },
  chip: { paddingVertical: spacing.sm, paddingHorizontal: spacing.md, borderRadius: radii.md, borderWidth: 1, borderColor: colors.border },
  chipActive: { backgroundColor: colors.primary, borderColor: colors.primary },
  chipText: { ...typography.caption, color: colors.textSecondary, textTransform: 'capitalize' },
  chipTextActive: { color: colors.primaryForeground, fontFamily: 'DMSans_700Bold' },
  productCard: { borderWidth: 1, borderColor: colors.border, borderRadius: radii.md, padding: spacing.md, gap: spacing.sm },
  row: { flexDirection: 'row', gap: spacing.sm },
  rowItem: { flex: 1 },
  toggleRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: spacing.md, paddingVertical: spacing.sm },
  toggleLabel: { ...typography.bodySm, color: colors.text, flex: 1, fontFamily: 'DMSans_500Medium' },
  doneBox: { alignItems: 'center', gap: spacing.sm, paddingVertical: spacing.xxl },
  doneTitle: { ...typography.h3, color: colors.text, fontFamily: 'DMSans_700Bold' },
  footer: { flexDirection: 'row', gap: spacing.sm, padding: spacing.lg, borderTopWidth: 1, borderTopColor: colors.border },
  footerBtn: { flex: 1 },
}))
