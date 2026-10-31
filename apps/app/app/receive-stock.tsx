import { useState } from 'react'
import {
  Alert,
  FlatList,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import { useRouter } from 'expo-router'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { Button } from '@/components/ui/Button'
import { useAuth } from '@/lib/auth'
import { apiRequest, ApiError } from '@/lib/api'
import { colors, radii, spacing, typography } from '@/lib/theme'

interface Product {
  id: string
  name: string
  sku: string | null
}
interface Line {
  productId: string
  productName: string
  batchNumber: string
  quantity: string
  expiryDate: string
  costPrice: string
}

export default function ReceiveStockScreen() {
  const { token } = useAuth()
  const router = useRouter()
  const insets = useSafeAreaInsets()
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<Product[]>([])
  const [searching, setSearching] = useState(false)
  const [selected, setSelected] = useState<Product | null>(null)
  const [batchNumber, setBatchNumber] = useState('')
  const [quantity, setQuantity] = useState('')
  const [expiry, setExpiry] = useState('')
  const [cost, setCost] = useState('')
  const [lines, setLines] = useState<Line[]>([])
  const [submitting, setSubmitting] = useState(false)
  const [supplierRef, setSupplierRef] = useState('')

  const search = async () => {
    if (!token || !query.trim()) return
    setSearching(true)
    try {
      const data = await apiRequest<{ products: Product[] }>(`/api/mobile/pharmacy/pos/products?q=${encodeURIComponent(query)}`, { token })
      setResults(data.products.slice(0, 20))
    } catch {
      setResults([])
    } finally {
      setSearching(false)
    }
  }

  const addLine = () => {
    if (!selected) return
    if (!batchNumber.trim() || !(Number(quantity) > 0) || !expiry.trim()) {
      Alert.alert('Missing info', 'Batch number, a positive quantity and expiry date are required to receive stock.')
      return
    }
    setLines((prev) => [
      ...prev,
      { productId: selected.id, productName: selected.name, batchNumber: batchNumber.trim(), quantity, expiryDate: expiry.trim(), costPrice: cost },
    ])
    setSelected(null)
    setBatchNumber(''); setQuantity(''); setExpiry(''); setCost(''); setQuery(''); setResults([])
  }

  const submit = async () => {
    if (!token || lines.length === 0) return
    setSubmitting(true)
    try {
      const res = await apiRequest<{ ok: boolean; results: Array<{ ok: boolean; error?: string }> }>(
        '/api/mobile/pharmacy/receiving',
        {
          method: 'POST',
          token,
          body: {
            supplierRef: supplierRef || undefined,
            lines: lines.map((l) => ({
              productId: l.productId,
              batchNumber: l.batchNumber,
              quantity: Number(l.quantity),
              expiryDate: l.expiryDate,
              costPrice: l.costPrice ? Number(l.costPrice) : undefined,
            })),
          },
        },
      )
      const failed = res.results.filter((r) => !r.ok)
      if (failed.length === 0) {
        Alert.alert('Stock received', `${res.results.length} batch(es) added.`, [
          { text: 'Inventory', onPress: () => router.replace('/(main)/stock' as never) },
          { text: 'OK' },
        ])
        setLines([])
      } else {
        Alert.alert('Partly received', `${failed.length} line(s) failed: ${failed.map((f) => f.error).join('; ')}`)
      }
    } catch (err) {
      Alert.alert('Receiving failed', err instanceof ApiError ? err.message : 'Try again.')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <KeyboardAvoidingView style={[styles.root, { paddingTop: insets.top }]} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <View style={styles.header}>
        <Pressable onPress={() => router.back()} hitSlop={12} style={styles.backBtn}>
          <Ionicons name="chevron-back" size={22} color={colors.primary} />
        </Pressable>
        <Text style={styles.title}>Receive stock</Text>
        <View style={{ width: 48 }} />
      </View>

      <FlatList
        data={lines}
        keyExtractor={(_, i) => String(i)}
        contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + spacing.xxl }]}
        ListHeaderComponent={
          <View style={{ gap: spacing.sm }}>
            <Text style={styles.help}>New stock enters as a real batch. Batch number, quantity and a future expiry date are required.</Text>
            {!selected ? (
              <>
                <View style={styles.searchRow}>
                  <TextInput style={[styles.input, { flex: 1 }]} value={query} onChangeText={setQuery} placeholder="Search product" autoCapitalize="none" placeholderTextColor={colors.textMuted} onSubmitEditing={search} />
                  <Button label="Search" onPress={search} loading={searching} style={{ width: 96 }} />
                </View>
                {results.map((p) => (
                  <Pressable key={p.id} style={styles.resultRow} onPress={() => setSelected(p)}>
                    <Text style={styles.resultName}>{p.name}</Text>
                    {p.sku ? <Text style={styles.meta}>{p.sku}</Text> : null}
                  </Pressable>
                ))}
              </>
            ) : (
              <View style={styles.formCard}>
                <Text style={styles.selName}>{selected.name}</Text>
                <TextInput style={styles.input} value={batchNumber} onChangeText={setBatchNumber} placeholder="Batch number" autoCapitalize="characters" placeholderTextColor={colors.textMuted} />
                <TextInput style={styles.input} value={quantity} onChangeText={setQuantity} placeholder="Quantity" keyboardType="numeric" placeholderTextColor={colors.textMuted} />
                <TextInput style={styles.input} value={expiry} onChangeText={setExpiry} placeholder="Expiry (YYYY-MM-DD)" autoCapitalize="none" placeholderTextColor={colors.textMuted} />
                <TextInput style={styles.input} value={cost} onChangeText={setCost} placeholder="Cost price (optional)" keyboardType="numeric" placeholderTextColor={colors.textMuted} />
                <View style={styles.addActions}>
                  <Button label="Cancel" variant="ghost" onPress={() => setSelected(null)} style={{ flex: 1 }} />
                  <Button label="Add line" onPress={addLine} style={{ flex: 1 }} />
                </View>
              </View>
            )}
            {lines.length > 0 ? <Text style={styles.section}>Lines to receive ({lines.length})</Text> : null}
          </View>
        }
        renderItem={({ item }) => (
          <View style={styles.lineCard}>
            <Text style={styles.lineName}>{item.productName}</Text>
            <Text style={styles.meta}>Batch {item.batchNumber} · {item.quantity} units · exp {item.expiryDate}</Text>
          </View>
        )}
        ListFooterComponent={
          lines.length > 0 ? (
            <View style={{ gap: spacing.sm, marginTop: spacing.md }}>
              <TextInput style={styles.input} value={supplierRef} onChangeText={setSupplierRef} placeholder="Supplier invoice ref (optional)" placeholderTextColor={colors.textMuted} />
              <Button label={`Receive ${lines.length} batch(es)`} onPress={submit} loading={submitting} />
            </View>
          ) : undefined
        }
      />
    </KeyboardAvoidingView>
  )
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: spacing.lg, paddingVertical: spacing.md },
  backBtn: { width: 48 },
  title: { ...typography.h3, color: colors.text, fontFamily: 'DMSans_700Bold' },
  content: { padding: spacing.lg, gap: spacing.sm },
  help: { ...typography.bodySm, color: colors.textSecondary, fontFamily: 'DMSans_400Regular' },
  searchRow: { flexDirection: 'row', gap: spacing.sm, alignItems: 'center' },
  input: { borderWidth: 1, borderColor: colors.border, borderRadius: radii.md, padding: spacing.md, color: colors.text, backgroundColor: colors.bgElevated, fontFamily: 'DMSans_400Regular' },
  resultRow: { backgroundColor: colors.surface, borderRadius: radii.md, borderWidth: 1, borderColor: colors.border, padding: spacing.md },
  resultName: { ...typography.bodySm, color: colors.text, fontFamily: 'DMSans_500Medium' },
  meta: { ...typography.caption, color: colors.textMuted, marginTop: 2 },
  formCard: { backgroundColor: colors.surface, borderRadius: radii.lg, borderWidth: 1, borderColor: colors.border, padding: spacing.lg, gap: spacing.sm },
  selName: { ...typography.bodyMedium, color: colors.text, fontFamily: 'DMSans_700Bold' },
  addActions: { flexDirection: 'row', gap: spacing.sm },
  section: { ...typography.bodyMedium, color: colors.primary, fontFamily: 'DMSans_700Bold', marginTop: spacing.md },
  lineCard: { backgroundColor: colors.surface, borderRadius: radii.md, borderWidth: 1, borderColor: colors.border, padding: spacing.md, marginTop: spacing.xs },
  lineName: { ...typography.bodySm, color: colors.text, fontFamily: 'DMSans_500Medium' },
})
