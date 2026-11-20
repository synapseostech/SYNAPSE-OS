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
import { Ionicons } from '@expo/vector-icons'
import { useRouter } from 'expo-router'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { Button } from '@/components/ui/Button'
import { LoadingBlock } from '@/components/ui/LoadingBlock'
import { useAuth } from '@/lib/auth'
import { apiRequest, ApiError } from '@/lib/api'
import { radii, spacing, typography, makeStyles, useTheme } from '@/lib/theme'

interface Settings {
  pharmacyName: string
  legalName: string
  tradingName: string
  location: string
  contact: string
  email: string
  tin: string
  ndaLicenseNumber: string
  supervisingPharmacist: string
  pharmacistRegNumber: string
  branchName: string
  receiptHeader: string
  receiptFooter: string
  currency: string
  taxRate: number
  vatEnabled: boolean
  vatRate: number
  lowStockThreshold: number
  discountApprovalThresholdPct: number
  mandatoryReceiptPrint: boolean
  printerType: string
  receiptPaperWidth: '58' | '80' | 'a4'
  receiptFontScale: number
  autoPrintReceipt: boolean
}

export default function SettingsScreen() {
  const styles = useStyles()
  const { colors } = useTheme()
  const { token } = useAuth()
  const router = useRouter()
  const insets = useSafeAreaInsets()
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [canEdit, setCanEdit] = useState(false)
  const [s, setS] = useState<Settings | null>(null)

  useEffect(() => {
    let active = true
    async function load() {
      if (!token) return setLoading(false)
      try {
        const data = await apiRequest<{ settings: Settings; canEdit: boolean }>('/api/mobile/pharmacy/settings', { token })
        if (!active) return
        const raw = data.settings as Settings & { receiptPaperWidth?: string }
        const paper = String(raw.receiptPaperWidth ?? '80').toLowerCase()
        setS({
          ...raw,
          receiptPaperWidth: paper === '58' || paper === 'a4' ? paper : '80',
          receiptFontScale: Number(raw.receiptFontScale ?? 1) || 1,
          autoPrintReceipt: Boolean(raw.autoPrintReceipt),
          printerType: raw.printerType ?? 'default',
        })
        setCanEdit(data.canEdit)
      } catch {
        if (active) setS(null)
      } finally {
        if (active) setLoading(false)
      }
    }
    load()
    return () => {
      active = false
    }
  }, [token])

  const set = <K extends keyof Settings>(k: K, v: Settings[K]) => setS((prev) => (prev ? { ...prev, [k]: v } : prev))

  const save = async () => {
    if (!token || !s) return
    setSaving(true)
    try {
      await apiRequest('/api/mobile/pharmacy/settings', { method: 'POST', token, body: s })
      Alert.alert('Saved', 'Pharmacy settings updated.')
    } catch (err) {
      Alert.alert('Save failed', err instanceof ApiError ? err.message : 'Try again.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <KeyboardAvoidingView style={[styles.root, { paddingTop: insets.top }]} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <View style={styles.header}>
        <Pressable onPress={() => router.back()} hitSlop={12} style={styles.backBtn}>
          <Ionicons name="chevron-back" size={22} color={colors.primary} />
        </Pressable>
        <Text style={styles.title}>Pharmacy settings</Text>
        <View style={{ width: 48 }} />
      </View>

      {loading ? (
        <LoadingBlock message="Loading settings…" />
      ) : !s ? (
        <Text style={styles.help}>Could not load settings.</Text>
      ) : (
        <ScrollView contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + spacing.xxl }]} keyboardShouldPersistTaps="handled">
          {!canEdit ? <Text style={styles.readonlyNote}>You have read-only access to settings.</Text> : null}

          <Section title="Identity" />
          <Field label="Trading name" value={s.tradingName} onChangeText={(v) => set('tradingName', v)} editable={canEdit} />
          <Field label="Legal name" value={s.legalName} onChangeText={(v) => set('legalName', v)} editable={canEdit} />
          <Field label="TIN" value={s.tin} onChangeText={(v) => set('tin', v)} editable={canEdit} />
          <Field label="NDA licence number" value={s.ndaLicenseNumber} onChangeText={(v) => set('ndaLicenseNumber', v)} editable={canEdit} />
          <Field label="Supervising pharmacist" value={s.supervisingPharmacist} onChangeText={(v) => set('supervisingPharmacist', v)} editable={canEdit} />
          <Field label="Pharmacist registration no." value={s.pharmacistRegNumber} onChangeText={(v) => set('pharmacistRegNumber', v)} editable={canEdit} />
          <Field label="Branch name" value={s.branchName} onChangeText={(v) => set('branchName', v)} editable={canEdit} />

          <Section title="Contact" />
          <Field label="Address / location" value={s.location} onChangeText={(v) => set('location', v)} editable={canEdit} />
          <Field label="Phone" value={s.contact} onChangeText={(v) => set('contact', v)} editable={canEdit} keyboardType="phone-pad" />
          <Field label="Email" value={s.email} onChangeText={(v) => set('email', v)} editable={canEdit} keyboardType="email-address" />

          <Section title="Receipt" />
          <Field label="Receipt header" value={s.receiptHeader} onChangeText={(v) => set('receiptHeader', v)} editable={canEdit} />
          <Field label="Receipt footer" value={s.receiptFooter} onChangeText={(v) => set('receiptFooter', v)} editable={canEdit} />
          <Field label="Currency" value={s.currency} onChangeText={(v) => set('currency', v)} editable={canEdit} />

          <Section title="Policy" />
          <Field label="Low stock threshold" value={String(s.lowStockThreshold)} onChangeText={(v) => set('lowStockThreshold', Number(v) || 0)} editable={canEdit} keyboardType="numeric" />
          <Field label="Discount approval threshold (%)" value={String(s.discountApprovalThresholdPct)} onChangeText={(v) => set('discountApprovalThresholdPct', Number(v) || 0)} editable={canEdit} keyboardType="numeric" />
          <Toggle label="VAT enabled" value={s.vatEnabled} onValueChange={(v) => set('vatEnabled', v)} disabled={!canEdit} />
          {s.vatEnabled ? (
            <Field label="VAT rate (%)" value={String(s.vatRate)} onChangeText={(v) => set('vatRate', Number(v) || 0)} editable={canEdit} keyboardType="numeric" />
          ) : null}
          <Toggle label="Require receipt print" value={s.mandatoryReceiptPrint} onValueChange={(v) => set('mandatoryReceiptPrint', v)} disabled={!canEdit} />

          <Section title="Printer" />
          <Text style={styles.helpInline}>Applied to POS and receipt printouts for this pharmacy.</Text>
          <ChoiceRow
            label="Paper width"
            value={s.receiptPaperWidth}
            options={[
              { value: '58', label: '58mm' },
              { value: '80', label: '80mm' },
              { value: 'a4', label: 'A4' },
            ]}
            onChange={(v) => set('receiptPaperWidth', v as Settings['receiptPaperWidth'])}
            disabled={!canEdit}
          />
          <ChoiceRow
            label="Font size"
            value={String(s.receiptFontScale)}
            options={[
              { value: '0.9', label: 'Compact' },
              { value: '1', label: 'Standard' },
              { value: '1.15', label: 'Large' },
              { value: '1.3', label: 'XL' },
            ]}
            onChange={(v) => set('receiptFontScale', Number(v) || 1)}
            disabled={!canEdit}
          />
          <ChoiceRow
            label="Printer"
            value={s.printerType}
            options={[
              { value: 'default', label: 'System' },
              { value: 'generic-58mm', label: '58mm thermal' },
              { value: 'generic-80mm', label: '80mm thermal' },
              { value: 'bluetooth', label: 'Bluetooth' },
              { value: 'network', label: 'Network' },
            ]}
            onChange={(v) => {
              const nextPaper: Settings['receiptPaperWidth'] = v.includes('58')
                ? '58'
                : v.includes('a4') || v.includes('brother')
                  ? 'a4'
                  : v.includes('80')
                    ? '80'
                    : s.receiptPaperWidth
              setS((prev) => (prev ? { ...prev, printerType: v, receiptPaperWidth: nextPaper } : prev))
            }}
            disabled={!canEdit}
          />
          <Toggle label="Auto-print after sale" value={s.autoPrintReceipt} onValueChange={(v) => set('autoPrintReceipt', v)} disabled={!canEdit} />

          {canEdit ? <Button label="Save settings" onPress={save} loading={saving} style={{ marginTop: spacing.lg }} /> : null}
        </ScrollView>
      )}
    </KeyboardAvoidingView>
  )
}

function Section({ title }: { title: string }) {
  const styles = useStyles()
  return <Text style={styles.section}>{title}</Text>
}

function Field({
  label,
  value,
  onChangeText,
  editable,
  keyboardType,
}: {
  label: string
  value: string
  onChangeText: (v: string) => void
  editable: boolean
  keyboardType?: 'default' | 'numeric' | 'phone-pad' | 'email-address'
}) {
  const styles = useStyles()
  const { colors } = useTheme()
  return (
    <View style={{ gap: 4 }}>
      <Text style={styles.label}>{label}</Text>
      <TextInput
        style={[styles.input, !editable && styles.inputDisabled]}
        value={value}
        onChangeText={onChangeText}
        editable={editable}
        keyboardType={keyboardType ?? 'default'}
        autoCapitalize="none"
        placeholderTextColor={colors.textMuted}
      />
    </View>
  )
}

function Toggle({ label, value, onValueChange, disabled }: { label: string; value: boolean; onValueChange: (v: boolean) => void; disabled?: boolean }) {
  const styles = useStyles()
  const { colors } = useTheme()
  return (
    <View style={styles.toggleRow}>
      <Text style={styles.toggleLabel}>{label}</Text>
      <Switch value={value} onValueChange={onValueChange} disabled={disabled} trackColor={{ true: colors.primary }} />
    </View>
  )
}

function ChoiceRow({
  label,
  value,
  options,
  onChange,
  disabled,
}: {
  label: string
  value: string
  options: Array<{ value: string; label: string }>
  onChange: (v: string) => void
  disabled?: boolean
}) {
  const styles = useStyles()
  return (
    <View style={{ gap: 6 }}>
      <Text style={styles.label}>{label}</Text>
      <View style={styles.choiceRow}>
        {options.map((opt) => {
          const active = opt.value === value
          return (
            <Pressable
              key={opt.value}
              disabled={disabled}
              onPress={() => onChange(opt.value)}
              style={[styles.choiceChip, active && styles.choiceChipActive, disabled && { opacity: 0.5 }]}
            >
              <Text style={[styles.choiceText, active && styles.choiceTextActive]}>{opt.label}</Text>
            </Pressable>
          )
        })}
      </View>
    </View>
  )
}

const useStyles = makeStyles((colors) => ({
  root: { flex: 1, backgroundColor: colors.bg },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: spacing.lg, paddingVertical: spacing.md },
  backBtn: { width: 48 },
  title: { ...typography.h3, color: colors.text, fontFamily: 'DMSans_700Bold' },
  content: { padding: spacing.xl, gap: spacing.sm },
  readonlyNote: { ...typography.caption, color: colors.textMuted, fontFamily: 'DMSans_400Regular', marginBottom: spacing.sm },
  section: { ...typography.bodyMedium, color: colors.primary, fontFamily: 'DMSans_700Bold', marginTop: spacing.lg },
  label: { ...typography.caption, color: colors.textSecondary, fontFamily: 'DMSans_500Medium' },
  help: { ...typography.bodySm, color: colors.textSecondary, textAlign: 'center', marginTop: spacing.xxl },
  helpInline: { ...typography.caption, color: colors.textMuted, fontFamily: 'DMSans_400Regular', marginBottom: spacing.xs },
  input: { borderWidth: 1, borderColor: colors.border, borderRadius: radii.md, padding: spacing.md, color: colors.text, backgroundColor: colors.bgElevated, fontFamily: 'DMSans_400Regular' },
  inputDisabled: { opacity: 0.6 },
  toggleRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: spacing.sm },
  toggleLabel: { ...typography.bodySm, color: colors.text, flex: 1, fontFamily: 'DMSans_500Medium' },
  choiceRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs },
  choiceChip: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    backgroundColor: colors.bgElevated,
  },
  choiceChipActive: { borderColor: colors.primary, backgroundColor: colors.primary + '18' },
  choiceText: { ...typography.caption, color: colors.textSecondary, fontFamily: 'DMSans_500Medium' },
  choiceTextActive: { color: colors.primary, fontFamily: 'DMSans_700Bold' },
}))
