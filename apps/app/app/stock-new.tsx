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
import { apiRequest, ApiError } from '@/lib/api'
import { spacing, typography, makeStyles, useTheme } from '@/lib/theme'

export default function StockNewScreen() {
  const styles = useStyles()
  const { colors } = useTheme()
  const { token } = useAuth()
  const router = useRouter()
  const insets = useSafeAreaInsets()
  const [name, setName] = useState('')
  const [sku, setSku] = useState('')
  const [category, setCategory] = useState('General')
  const [unit, setUnit] = useState('Tablet')
  const [price, setPrice] = useState('')
  const [costPrice, setCostPrice] = useState('')
  const [quantity, setQuantity] = useState('0')
  const [reorderLevel, setReorderLevel] = useState('10')
  const [batchNumber, setBatchNumber] = useState('')
  const [expiryDate, setExpiryDate] = useState('')
  const [saving, setSaving] = useState(false)

  const save = async () => {
    if (!token) return
    const priceN = Number(price)
    if (!name.trim()) {
      Alert.alert('Name required', 'Enter a product name.')
      return
    }
    if (!Number.isFinite(priceN) || priceN < 0) {
      Alert.alert('Invalid price', 'Enter a sell price ≥ 0.')
      return
    }
    setSaving(true)
    try {
      const data = await apiRequest<{ ok: boolean; product: { id: string } }>(
        '/api/mobile/inventory',
        {
          method: 'POST',
          token,
          body: {
            name: name.trim(),
            sku: sku.trim() || undefined,
            category: category.trim() || 'General',
            unit: unit.trim() || 'Tablet',
            price: priceN,
            costPrice: Number(costPrice) || 0,
            quantity: Math.floor(Number(quantity) || 0),
            reorderLevel: Math.floor(Number(reorderLevel) || 10),
            batchNumber: batchNumber.trim() || undefined,
            expiryDate: expiryDate.trim() || undefined,
          },
        },
      )
      Alert.alert('Product created', name.trim(), [
        {
          text: 'Open',
          onPress: () => router.replace(`/stock-item/${data.product.id}` as never),
        },
      ])
    } catch (err) {
      Alert.alert(
        'Create failed',
        err instanceof ApiError ? err.message : err instanceof Error ? err.message : 'Try again',
      )
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
        <Text style={styles.title}>Add product</Text>
        <View style={{ width: 48 }} />
      </View>

      <ScrollView
        contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + spacing.xxl }]}
        keyboardShouldPersistTaps="handled"
      >
        <TextField label="Name *" value={name} onChangeText={setName} autoCapitalize="words" />
        <TextField
          label="SKU"
          value={sku}
          onChangeText={setSku}
          autoCapitalize="characters"
          hint="Leave blank to auto-generate"
        />
        <TextField label="Category" value={category} onChangeText={setCategory} />
        <TextField label="Unit" value={unit} onChangeText={setUnit} hint="e.g. Tablet, Bottle" />
        <TextField
          label="Sell price (UGX) *"
          value={price}
          onChangeText={setPrice}
          keyboardType="decimal-pad"
        />
        <TextField
          label="Cost price (UGX)"
          value={costPrice}
          onChangeText={setCostPrice}
          keyboardType="decimal-pad"
        />
        <TextField
          label="Quantity on hand"
          value={quantity}
          onChangeText={setQuantity}
          keyboardType="number-pad"
        />
        <TextField
          label="Reorder level"
          value={reorderLevel}
          onChangeText={setReorderLevel}
          keyboardType="number-pad"
        />
        <TextField
          label="Batch number"
          value={batchNumber}
          onChangeText={setBatchNumber}
          hint="Creates a FEFO batch when set with expiry + qty"
        />
        <TextField
          label="Expiry (YYYY-MM-DD)"
          value={expiryDate}
          onChangeText={setExpiryDate}
          autoCapitalize="none"
          placeholder="2027-06-30"
        />
        <Button label="Create product" onPress={save} loading={saving} />
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
  backBtn: { width: 48 },
  title: {
    ...typography.h3,
    color: colors.text,
    fontFamily: 'DMSans_700Bold',
  },
  content: { padding: spacing.xl },
}))
