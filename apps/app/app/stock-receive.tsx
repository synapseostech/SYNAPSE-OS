import { useState } from 'react'
import {
  Alert,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import { useRouter } from 'expo-router'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { Button } from '@/components/ui/Button'
import { TextField } from '@/components/ui/TextField'
import { useAuth } from '@/lib/auth'
import {
  ApiError,
  receivePharmacyStockMobile,
  searchPosProducts,
} from '@/lib/api'
import { radii, spacing, typography, makeStyles, useTheme } from '@/lib/theme'

type ProductHit = {
  id: string
  name: string
  sku: string | null
  barcode: string | null
  costPrice: number | null
  price: number
}

export default function StockReceiveScreen() {
  const styles = useStyles()
  const { colors } = useTheme()
  const { token } = useAuth()
  const router = useRouter()
  const insets = useSafeAreaInsets()
  const [query, setQuery] = useState('')
  const [hits, setHits] = useState<ProductHit[]>([])
  const [selected, setSelected] = useState<ProductHit | null>(null)
  const [batchNumber, setBatchNumber] = useState('')
  const [expiryDate, setExpiryDate] = useState('')
  const [quantity, setQuantity] = useState('1')
  const [costPrice, setCostPrice] = useState('')
  const [saving, setSaving] = useState(false)

  const search = async (q: string) => {
    setQuery(q)
    if (!token || q.trim().length < 2) {
      setHits([])
      return
    }
    try {
      const data = await searchPosProducts(token, q.trim())
      setHits(
        data.products.map((p) => ({
          id: p.id,
          name: p.name,
          sku: p.sku,
          barcode: p.barcode,
          costPrice: p.costPrice,
          price: p.price,
        })),
      )
    } catch {
      setHits([])
    }
  }

  const pick = (p: ProductHit) => {
    setSelected(p)
    setQuery(p.name)
    setHits([])
    if (p.costPrice != null) setCostPrice(String(p.costPrice))
  }

  const submit = async () => {
    if (!token || !selected) {
      Alert.alert('Select product', 'Search and pick a product first.')
      return
    }
    if (!batchNumber.trim() || !expiryDate.trim()) {
      Alert.alert('Batch required', 'Enter batch number and expiry (YYYY-MM-DD).')
      return
    }
    const qty = Math.floor(Number(quantity))
    if (!Number.isFinite(qty) || qty <= 0) {
      Alert.alert('Invalid quantity', 'Enter a quantity greater than 0.')
      return
    }
    setSaving(true)
    try {
      const res = await receivePharmacyStockMobile(token, {
        productId: selected.id,
        batchNumber: batchNumber.trim(),
        quantity: qty,
        expiryDate: expiryDate.trim(),
        costPrice: costPrice ? Number(costPrice) : undefined,
        reason: 'Stock received (mobile)',
      })
      if (!res.ok) {
        Alert.alert('Receive failed', res.error ?? 'Stock was not recorded.')
        return
      }
      Alert.alert('Received', `${selected.name}: +${res.received || qty}`, [
        { text: 'Done', onPress: () => router.back() },
        {
          text: 'Receive more',
          onPress: () => {
            setBatchNumber('')
            setExpiryDate('')
            setQuantity('1')
          },
        },
      ])
    } catch (err) {
      Alert.alert('Receive failed', err instanceof ApiError ? err.message : 'Try again')
    } finally {
      setSaving(false)
    }
  }

  return (
    <KeyboardAvoidingView
      style={[styles.root, { paddingTop: insets.top }]}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <View style={styles.header}>
        <Pressable onPress={() => router.back()} hitSlop={12} style={styles.backBtn}>
          <Ionicons name="chevron-back" size={22} color={colors.primary} />
        </Pressable>
        <Text style={styles.title}>Receive stock</Text>
        <Pressable onPress={() => router.push('/barcode-scan' as never)} hitSlop={12}>
          <Ionicons name="barcode-outline" size={22} color={colors.primary} />
        </Pressable>
      </View>

      <ScrollView
        contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + spacing.xxl }]}
        keyboardShouldPersistTaps="handled"
      >
        <TextField
          label="Product search"
          value={query}
          onChangeText={search}
          placeholder="Name, SKU, or barcode"
        />
        {hits.map((p) => (
          <Pressable key={p.id} style={styles.hit} onPress={() => pick(p)}>
            <Text style={styles.hitTitle}>{p.name}</Text>
            <Text style={styles.hitMeta}>
              {[p.sku, p.barcode].filter(Boolean).join(' · ') || 'No SKU'}
            </Text>
          </Pressable>
        ))}
        {selected ? (
          <Text style={styles.selected}>Selected: {selected.name}</Text>
        ) : null}

        <TextField
          label="Batch number"
          value={batchNumber}
          onChangeText={setBatchNumber}
          autoCapitalize="characters"
        />
        <TextField
          label="Expiry (YYYY-MM-DD)"
          value={expiryDate}
          onChangeText={setExpiryDate}
          placeholder="2027-12-31"
          autoCapitalize="none"
        />
        <TextField
          label="Quantity"
          value={quantity}
          onChangeText={setQuantity}
          keyboardType="numeric"
        />
        <TextField
          label="Cost price (optional)"
          value={costPrice}
          onChangeText={setCostPrice}
          keyboardType="numeric"
        />
        <Button label="Receive stock" onPress={submit} loading={saving} />
      </ScrollView>
    </KeyboardAvoidingView>
  )
}

const useStyles = makeStyles((colors) => ({
  root: { flex: 1, backgroundColor: colors.bg },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
  },
  backBtn: { width: 40 },
  title: { ...typography.h2, color: colors.text, fontFamily: 'DMSans_700Bold' },
  content: { padding: spacing.xl },
  hit: {
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: colors.borderSubtle,
  },
  hitTitle: { color: colors.text, fontFamily: 'DMSans_500Medium' },
  hitMeta: { color: colors.textMuted, fontSize: 12, marginTop: 2 },
  selected: {
    color: colors.teal,
    fontFamily: 'DMSans_500Medium',
    marginBottom: spacing.lg,
    marginTop: spacing.sm,
  },
}))
