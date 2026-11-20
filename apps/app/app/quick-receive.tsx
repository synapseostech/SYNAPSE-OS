import { useRef, useState } from 'react'
import {
  Alert,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native'
import { useRouter } from 'expo-router'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { Ionicons } from '@expo/vector-icons'
import { Button } from '@/components/ui/Button'
import { ScannerModal } from '@/components/stock-take/ScannerModal'
import { useAuth } from '@/lib/auth'
import { ApiError, apiRequest, searchPosProducts } from '@/lib/api'
import {
  addLine,
  checkDraft,
  receiveTotals,
  remainingAfterSubmit,
  toReceivingBody,
  type QuickReceiveDraft,
  type QuickReceiveLine,
} from '@/lib/quick-receive'
import { formatExpiry, kampalaToday } from '@/lib/stock-take'
import { radii, spacing, typography, useTheme } from '@/lib/theme'

type Product = { id: string; name: string; sku: string | null; barcode: string | null; costPrice: number | null }

const EMPTY: QuickReceiveDraft = { quantity: '', batchNumber: '', expiry: '', cost: '' }

/**
 * Receive a delivery from the phone: scan a pack, type quantity, batch, expiry
 * and cost, scan the next. Lines post together through the GRN route, which
 * creates each batch via receive_pharmacy_stock.
 */
export default function QuickReceiveScreen() {
  const { token } = useAuth()
  const { colors } = useTheme()
  const router = useRouter()
  const insets = useSafeAreaInsets()
  const [scanning, setScanning] = useState(false)
  const [product, setProduct] = useState<Product | null>(null)
  const [query, setQuery] = useState('')
  const [hits, setHits] = useState<Product[]>([])
  const [draft, setDraft] = useState<QuickReceiveDraft>(EMPTY)
  const [fieldError, setFieldError] = useState<{ field: string; message: string } | null>(null)
  const [lines, setLines] = useState<Array<QuickReceiveLine & { error?: string }>>([])
  const [supplierRef, setSupplierRef] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const qtyRef = useRef<React.ComponentRef<typeof TextInput>>(null)

  const choose = (p: Product) => {
    setProduct(p)
    setHits([])
    setQuery('')
    // Same product again: keep the last batch and expiry, they usually repeat.
    const previous = lines.find((l) => l.productId === p.id)
    setDraft({
      quantity: '',
      batchNumber: previous?.batchNumber ?? '',
      expiry: previous ? formatExpiry(previous.expiryDate) : '',
      cost: previous?.costPrice != null ? String(previous.costPrice) : p.costPrice != null ? String(p.costPrice) : '',
    })
    setFieldError(null)
    setTimeout(() => qtyRef.current?.focus(), 250)
  }

  const lookup = async (code: string, exact: boolean) => {
    if (!token || !code.trim()) return
    try {
      const data = await searchPosProducts(token, code.trim())
      const products = data.products.map((p) => ({
        id: p.id,
        name: p.name,
        sku: p.sku,
        barcode: p.barcode,
        costPrice: p.costPrice,
      }))
      if (exact) {
        const c = code.trim().toLowerCase()
        const match = products.find(
          (p) => String(p.barcode ?? '').toLowerCase() === c || String(p.sku ?? '').toLowerCase() === c,
        )
        if (match) return choose(match)
        Alert.alert('Not in the catalogue', `No product has the code ${code}. Search by name or add the product first.`)
        return
      }
      setHits(products.slice(0, 12))
    } catch (e) {
      Alert.alert('Lookup failed', e instanceof ApiError ? e.message : 'Check your connection.')
    }
  }

  const add = (scanNext: boolean) => {
    if (!product) return
    const check = checkDraft(draft, kampalaToday())
    if (!check.ok) {
      setFieldError({ field: check.field, message: check.message })
      return
    }
    setLines((current) =>
      addLine(current, {
        productId: product.id,
        productName: product.name,
        batchNumber: check.batchNumber,
        expiryDate: check.expiryDate,
        quantity: check.quantity,
        costPrice: check.costPrice,
      }),
    )
    setProduct(null)
    setDraft(EMPTY)
    setFieldError(null)
    if (scanNext) setScanning(true)
  }

  const submit = async () => {
    if (!token || lines.length === 0) return
    setSubmitting(true)
    try {
      const res = await apiRequest<{ ok: boolean; results: Array<{ productId: string; ok: boolean; error?: string }> }>(
        '/api/mobile/pharmacy/receiving',
        { method: 'POST', token, body: toReceivingBody(lines, supplierRef) },
      )
      const left = remainingAfterSubmit(lines, res.results ?? [])
      const received = lines.length - left.length
      setLines(left)
      if (left.length === 0) {
        Alert.alert('Received', `${received} line(s) added to stock.`, [{ text: 'Done', onPress: () => router.back() }])
      } else {
        Alert.alert('Partly received', `${received} received. ${left.length} need fixing — see the red lines.`)
      }
    } catch (e) {
      // The route answers per line; a thrown error means nothing was answered.
      if (e instanceof ApiError && Array.isArray(e.payload.results)) {
        setLines(remainingAfterSubmit(lines, e.payload.results as Array<{ productId: string; ok: boolean; error?: string }>))
        Alert.alert('Not received', 'No line was accepted. See the red lines.')
      } else {
        Alert.alert('Not sent', e instanceof Error ? e.message : 'Check your connection. Your lines are kept.')
      }
    } finally {
      setSubmitting(false)
    }
  }

  const totals = receiveTotals(lines)
  const input = (field: keyof QuickReceiveDraft, props: Partial<React.ComponentProps<typeof TextInput>>) => (
    <TextInput
      value={draft[field]}
      onChangeText={(text) => setDraft((d) => ({ ...d, [field]: text }))}
      placeholderTextColor={colors.textMuted}
      style={[
        styles.input,
        {
          color: colors.text,
          backgroundColor: colors.bgElevated,
          borderColor: fieldError?.field === field ? colors.danger : colors.border,
        },
      ]}
      {...props}
    />
  )

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      style={[styles.root, { backgroundColor: colors.bg, paddingTop: insets.top }]}
    >
      <View style={styles.header}>
        <Pressable onPress={() => router.back()} hitSlop={12} accessibilityRole="button" accessibilityLabel="Go back">
          <Ionicons name="chevron-back" size={22} color={colors.primary} />
        </Pressable>
        <Text style={[styles.title, { color: colors.text }]}>Quick receive</Text>
        <View style={{ width: 22 }} />
      </View>
      <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ padding: spacing.lg, paddingBottom: insets.bottom + 120 }}>
        <TextInput
          value={supplierRef}
          onChangeText={setSupplierRef}
          placeholder="Supplier invoice / delivery note (optional)"
          placeholderTextColor={colors.textMuted}
          style={[styles.input, { color: colors.text, backgroundColor: colors.bgElevated, borderColor: colors.border, marginBottom: spacing.md }]}
        />

        {!product ? (
          <View style={styles.findRow}>
            <TextInput
              value={query}
              onChangeText={(t) => {
                setQuery(t)
                if (t.trim().length >= 2) void lookup(t, false)
                else setHits([])
              }}
              placeholder="Search product"
              placeholderTextColor={colors.textMuted}
              style={[styles.input, { flex: 1, color: colors.text, backgroundColor: colors.bgElevated, borderColor: colors.border }]}
            />
            <Pressable
              onPress={() => setScanning(true)}
              style={[styles.scanBtn, { backgroundColor: colors.primary }]}
              accessibilityRole="button"
              accessibilityLabel="Scan a pack"
            >
              <Ionicons name="barcode-outline" size={24} color={colors.primaryForeground} />
            </Pressable>
          </View>
        ) : null}
        {hits.map((p) => (
          <Pressable key={p.id} onPress={() => choose(p)} style={[styles.hit, { borderColor: colors.borderSubtle }]}>
            <Text style={[styles.body, { color: colors.text }]}>{p.name}</Text>
            <Text style={[styles.small, { color: colors.textMuted }]}>{[p.sku, p.barcode].filter(Boolean).join(' · ')}</Text>
          </Pressable>
        ))}

        {product ? (
          <View style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.primary }]}>
            <View style={styles.cardHead}>
              <Text style={[styles.name, { color: colors.text, flex: 1 }]}>{product.name}</Text>
              <Pressable onPress={() => setProduct(null)} hitSlop={10} accessibilityLabel="Change product">
                <Ionicons name="close" size={20} color={colors.textMuted} />
              </Pressable>
            </View>
            <View style={styles.grid}>
              <View style={styles.cell}>
                <Text style={[styles.label, { color: colors.textSecondary }]}>Quantity</Text>
                {input('quantity', { ref: qtyRef, placeholder: '10 or 5x20', keyboardType: 'numbers-and-punctuation' })}
              </View>
              <View style={styles.cell}>
                <Text style={[styles.label, { color: colors.textSecondary }]}>Batch no.</Text>
                {input('batchNumber', { placeholder: 'On the pack', autoCapitalize: 'characters' })}
              </View>
              <View style={styles.cell}>
                <Text style={[styles.label, { color: colors.textSecondary }]}>Expiry</Text>
                {input('expiry', { placeholder: 'MM/YY', keyboardType: 'numbers-and-punctuation' })}
              </View>
              <View style={styles.cell}>
                <Text style={[styles.label, { color: colors.textSecondary }]}>Unit cost</Text>
                {input('cost', { placeholder: 'optional', keyboardType: 'decimal-pad' })}
              </View>
            </View>
            {fieldError ? <Text style={[styles.small, { color: colors.danger }]}>{fieldError.message}</Text> : null}
            <View style={styles.actions}>
              <Button label="Add" variant="ghost" onPress={() => add(false)} style={{ flex: 1 }} />
              <Button label="Add & scan next" onPress={() => add(true)} style={{ flex: 1.5 }} />
            </View>
          </View>
        ) : null}

        {lines.length > 0 ? (
          <Text style={[styles.section, { color: colors.textSecondary }]}>
            {totals.lines} line(s) · {totals.units} units · cost {Math.round(totals.cost).toLocaleString('en-US')}
          </Text>
        ) : null}
        {lines.map((l) => (
          <View key={l.key} style={[styles.lineRow, { borderColor: l.error ? colors.danger : colors.borderSubtle }]}>
            <View style={{ flex: 1 }}>
              <Text style={[styles.body, { color: colors.text }]}>{l.productName}</Text>
              <Text style={[styles.small, { color: colors.textMuted }]}>
                {l.batchNumber} · exp {formatExpiry(l.expiryDate)}
                {l.costPrice != null ? ` · @${l.costPrice}` : ''}
              </Text>
              {l.error ? <Text style={[styles.small, { color: colors.danger }]}>{l.error}</Text> : null}
            </View>
            <Text style={[styles.qty, { color: colors.text }]}>{l.quantity}</Text>
            <Pressable
              onPress={() => setLines((ls) => ls.filter((x) => x.key !== l.key))}
              hitSlop={10}
              accessibilityRole="button"
              accessibilityLabel={`Remove ${l.productName}`}
            >
              <Ionicons name="trash-outline" size={18} color={colors.textMuted} />
            </Pressable>
          </View>
        ))}
      </ScrollView>

      {lines.length > 0 ? (
        <View style={[styles.footer, { backgroundColor: colors.bg, borderColor: colors.border, paddingBottom: insets.bottom + spacing.md }]}>
          <Button label={`Receive ${totals.units} units into stock`} onPress={submit} loading={submitting} />
        </View>
      ) : null}

      <ScannerModal
        visible={scanning}
        title="Scan delivery"
        hint={lines.length ? `${totals.lines} line(s) so far` : undefined}
        onScanned={(code) => {
          setScanning(false)
          void lookup(code, true)
        }}
        onClose={() => setScanning(false)}
      />
    </KeyboardAvoidingView>
  )
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: spacing.lg, paddingVertical: spacing.md },
  title: { ...typography.h3 },
  body: { ...typography.body },
  small: { ...typography.bodySm },
  name: { ...typography.h4 },
  label: { ...typography.label, marginBottom: spacing.xs },
  input: { ...typography.body, borderWidth: 1, borderRadius: radii.md, paddingHorizontal: spacing.md, paddingVertical: spacing.sm },
  findRow: { flexDirection: 'row', gap: spacing.sm },
  scanBtn: { width: 52, borderRadius: radii.md, alignItems: 'center', justifyContent: 'center' },
  hit: { paddingVertical: spacing.md, borderBottomWidth: StyleSheet.hairlineWidth },
  card: { borderWidth: 1, borderRadius: radii.lg, padding: spacing.lg, gap: spacing.md, marginTop: spacing.md },
  cardHead: { flexDirection: 'row', alignItems: 'center' },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.md },
  cell: { flexBasis: '46%', flexGrow: 1 },
  actions: { flexDirection: 'row', gap: spacing.md },
  section: { ...typography.label, marginTop: spacing.xl, marginBottom: spacing.sm },
  lineRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, paddingVertical: spacing.md, borderBottomWidth: 1 },
  qty: { ...typography.h3 },
  footer: { position: 'absolute', left: 0, right: 0, bottom: 0, padding: spacing.lg, borderTopWidth: StyleSheet.hairlineWidth },
})
