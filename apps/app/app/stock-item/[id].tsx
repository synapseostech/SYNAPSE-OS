import { useCallback, useEffect, useState } from 'react'
import {
  Alert,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import { useLocalSearchParams, useRouter } from 'expo-router'
import { Button } from '@/components/ui/Button'
import { TextField } from '@/components/ui/TextField'
import { LoadingBlock } from '@/components/ui/LoadingBlock'
import { useAuth } from '@/lib/auth'
import { apiRequest } from '@/lib/api'
import { colors, radii, spacing, typography, TONE_COLORS } from '@/lib/theme'

interface StockItemDetail {
  id: string
  name: string
  sku: string | null
  barcode: string | null
  category: string | null
  quantity: number
  unit: string | null
  reorderLevel: number
  price: number
  expiryDate: string | null
  status: 'ok' | 'low' | 'expiring' | 'expired'
  batchNumber: string | null
  shelfLocation: string | null
  unitCost: number | null
  currency: string | null
  batches?: Array<{
    id: string
    batchNumber: string
    quantity: number
    expiryDate: string
  }>
}

const STATUS_COLORS: Record<string, string> = {
  ok: TONE_COLORS.green,
  low: TONE_COLORS.red,
  expiring: TONE_COLORS.warning,
  expired: TONE_COLORS.red,
}

const STATUS_LABELS: Record<string, string> = {
  ok: 'In Stock',
  low: 'Low Stock',
  expiring: 'Expiring Soon',
  expired: 'Expired',
}

export default function StockItemDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>()
  const { token } = useAuth()
  const router = useRouter()
  const [item, setItem] = useState<StockItemDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [editing, setEditing] = useState(false)
  const [nameText, setNameText] = useState('')
  const [skuText, setSkuText] = useState('')
  const [categoryText, setCategoryText] = useState('')
  const [unitText, setUnitText] = useState('')
  const [priceText, setPriceText] = useState('')
  const [costText, setCostText] = useState('')
  const [qtyText, setQtyText] = useState('')
  const [reorderText, setReorderText] = useState('')
  const [batchText, setBatchText] = useState('')
  const [expiryText, setExpiryText] = useState('')
  const [reason, setReason] = useState('')
  const [saving, setSaving] = useState(false)

  const hydrate = (data: StockItemDetail) => {
    setNameText(data.name)
    setSkuText(data.sku ?? '')
    setCategoryText(data.category ?? '')
    setUnitText(data.unit ?? '')
    setPriceText(String(data.price ?? 0))
    setCostText(data.unitCost != null ? String(data.unitCost) : '')
    setQtyText(String(data.quantity))
    setReorderText(String(data.reorderLevel))
    setBatchText(data.batchNumber ?? '')
    setExpiryText(data.expiryDate ? data.expiryDate.slice(0, 10) : '')
  }

  const load = useCallback(async () => {
    if (!id || !token) {
      setLoading(false)
      return
    }
    try {
      const data = await apiRequest<{ item: StockItemDetail }>(`/api/mobile/inventory/${id}`, {
        token,
      })
      setItem(data.item)
      hydrate(data.item)
      setError(null)
    } catch {
      setError('Failed to load item')
    } finally {
      setLoading(false)
    }
  }, [id, token])

  useEffect(() => {
    load()
  }, [load])

  const save = async () => {
    if (!token || !id || !item) return
    const quantity = Number(qtyText)
    const reorderLevel = Number(reorderText)
    const price = Number(priceText)
    if (!nameText.trim()) {
      Alert.alert('Name required', 'Product name cannot be empty.')
      return
    }
    if (!Number.isFinite(quantity) || quantity < 0) {
      Alert.alert('Invalid quantity', 'Enter a whole number ≥ 0.')
      return
    }
    if (!Number.isFinite(reorderLevel) || reorderLevel < 0) {
      Alert.alert('Invalid reorder level', 'Enter a whole number ≥ 0.')
      return
    }
    if (!Number.isFinite(price) || price < 0) {
      Alert.alert('Invalid price', 'Enter a sell price ≥ 0.')
      return
    }
    setSaving(true)
    try {
      // The server refuses any quantity it cannot tie to a genuine batch, so
      // send it only when it actually changed. Sending the unchanged count
      // made editing the name or price of a catalogue-only product fail with
      // REQUIRES_BATCH.
      const quantityChanged = Math.floor(quantity) !== Number(item.quantity)
      await apiRequest(`/api/mobile/inventory/${id}`, {
        method: 'PATCH',
        token,
        body: {
          name: nameText.trim(),
          sku: skuText.trim() || undefined,
          category: categoryText.trim(),
          unit: unitText.trim() || undefined,
          price,
          costPrice: costText.trim() ? Number(costText) : undefined,
          reorderLevel: Math.floor(reorderLevel),
          reason: reason.trim() || undefined,
          ...(quantityChanged
            ? {
                quantity: Math.floor(quantity),
                batchNumber: batchText.trim() || null,
                expiryDate: expiryText.trim() || null,
              }
            : {}),
        },
      })
      setEditing(false)
      setReason('')
      await load()
    } catch (err) {
      Alert.alert('Save failed', err instanceof Error ? err.message : 'Try again')
    } finally {
      setSaving(false)
    }
  }

  if (loading) {
    return (
      <View style={styles.center}>
        <LoadingBlock message="Loading item…" />
      </View>
    )
  }

  if (error || !item) {
    return (
      <View style={styles.center}>
        <Text style={styles.errorText}>{error ?? 'Item not found'}</Text>
        <Button label="Go back" onPress={() => router.back()} variant="ghost" />
      </View>
    )
  }

  const statusColor = STATUS_COLORS[item.status] ?? colors.textMuted

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <Pressable style={styles.backRow} onPress={() => router.back()}>
        <Ionicons name="chevron-back" size={20} color={colors.primary} />
        <Text style={styles.backLabel}>Inventory</Text>
      </Pressable>

      <View style={styles.header}>
        <Text style={styles.name}>{item.name}</Text>
        <View style={[styles.statusBadge, { backgroundColor: `${statusColor}18` }]}>
          <Text style={[styles.statusText, { color: statusColor }]}>
            {STATUS_LABELS[item.status] ?? item.status}
          </Text>
        </View>
      </View>

      <View style={styles.statsRow}>
        <StatCard
          label="In Stock"
          value={String(item.quantity)}
          unit={item.unit ?? 'units'}
          color={colors.text}
        />
        <StatCard
          label="Sell price"
          value={`${item.currency ?? 'UGX'} ${Number(item.price ?? 0).toLocaleString()}`}
          unit=""
          color={colors.teal}
        />
        <StatCard
          label="Reorder At"
          value={String(item.reorderLevel)}
          unit={item.unit ?? 'units'}
          color={colors.warning}
        />
      </View>

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Product Details</Text>
        <View style={styles.card}>
          {item.sku ? <InfoRow label="SKU" value={item.sku} /> : null}
          {item.category ? <InfoRow label="Category" value={item.category} /> : null}
          {item.batchNumber ? <InfoRow label="Batch #" value={item.batchNumber} /> : null}
          {item.unitCost != null ? (
            <InfoRow
              label="Unit cost"
              value={`${item.currency ?? 'UGX'} ${item.unitCost.toLocaleString()}`}
            />
          ) : null}
          {item.expiryDate ? (
            <InfoRow
              label="Expiry date"
              value={new Date(item.expiryDate).toLocaleDateString([], {
                day: 'numeric',
                month: 'long',
                year: 'numeric',
              })}
            />
          ) : null}
        </View>
      </View>

      {(item.batches?.length ?? 0) > 0 ? (
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>FEFO batches</Text>
          <View style={styles.card}>
            {item.batches!.map((b) => (
              <InfoRow
                key={b.id}
                label={b.batchNumber}
                value={`Qty ${b.quantity} · exp ${b.expiryDate.slice(0, 10)}`}
              />
            ))}
          </View>
        </View>
      ) : null}

      {editing ? (
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Edit product & stock</Text>
          <TextField label="Name" value={nameText} onChangeText={setNameText} />
          <TextField label="SKU" value={skuText} onChangeText={setSkuText} />
          <TextField label="Category" value={categoryText} onChangeText={setCategoryText} />
          <TextField label="Unit" value={unitText} onChangeText={setUnitText} />
          <TextField
            label="Sell price (UGX)"
            value={priceText}
            onChangeText={setPriceText}
            keyboardType="decimal-pad"
          />
          <TextField
            label="Cost price (UGX)"
            value={costText}
            onChangeText={setCostText}
            keyboardType="decimal-pad"
          />
          <TextField
            label="Quantity on hand"
            value={qtyText}
            onChangeText={setQtyText}
            keyboardType="number-pad"
          />
          <TextField
            label="Reorder level"
            value={reorderText}
            onChangeText={setReorderText}
            keyboardType="number-pad"
          />
          <TextField label="Batch #" value={batchText} onChangeText={setBatchText} />
          <TextField
            label="Expiry (YYYY-MM-DD)"
            value={expiryText}
            onChangeText={setExpiryText}
            autoCapitalize="none"
          />
          <TextField
            label="Reason (optional)"
            value={reason}
            onChangeText={setReason}
            placeholder="e.g. Count correction"
          />
          <View style={styles.editActions}>
            <Button
              label="Cancel"
              onPress={() => {
                setEditing(false)
                hydrate(item)
                setReason('')
              }}
              variant="ghost"
              style={styles.editBtn}
            />
            <Button label="Save" onPress={save} loading={saving} style={styles.editBtn} />
          </View>
        </View>
      ) : (
        <>
          <Button
            label="Receive stock (batch)"
            onPress={() => router.push('/stock-receive' as never)}
            variant="ghost"
            style={styles.ctaBtn}
          />
          <Button label="Edit product / stock" onPress={() => setEditing(true)} style={styles.ctaBtn} />
        </>
      )}
    </ScrollView>
  )
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.infoRow}>
      <Text style={styles.infoLabel}>{label}</Text>
      <Text style={styles.infoValue}>{value}</Text>
    </View>
  )
}

function StatCard({
  label,
  value,
  unit,
  color,
}: {
  label: string
  value: string
  unit: string
  color: string
}) {
  return (
    <View style={styles.statCard}>
      <Text style={[styles.statValue, { color }]} numberOfLines={1}>
        {value}
      </Text>
      {unit ? <Text style={styles.statUnit}>{unit}</Text> : null}
      <Text style={styles.statLabel}>{label}</Text>
    </View>
  )
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  content: { padding: spacing.xl, paddingBottom: spacing.xxxl * 2 },
  center: {
    flex: 1,
    backgroundColor: colors.bg,
    justifyContent: 'center',
    alignItems: 'center',
    padding: spacing.xxl,
    gap: spacing.lg,
  },
  errorText: {
    ...typography.body,
    color: colors.error,
    fontFamily: 'DMSans_400Regular',
    textAlign: 'center',
  },
  backRow: { flexDirection: 'row', alignItems: 'center', marginBottom: spacing.xl, gap: 4 },
  backLabel: {
    ...typography.bodyMedium,
    color: colors.primary,
    fontFamily: 'DMSans_500Medium',
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    gap: spacing.md,
    marginBottom: spacing.xxl,
  },
  name: { ...typography.h2, color: colors.text, fontFamily: 'DMSans_700Bold', flex: 1 },
  statusBadge: { borderRadius: radii.full, paddingHorizontal: 10, paddingVertical: 4 },
  statusText: { fontSize: 12, fontWeight: '600', fontFamily: 'DMSans_500Medium' },
  statsRow: { flexDirection: 'row', gap: spacing.sm, marginBottom: spacing.xxl },
  statCard: {
    flex: 1,
    backgroundColor: colors.surface,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.md,
    alignItems: 'center',
  },
  statValue: { fontSize: 14, fontWeight: '700', fontFamily: 'DMSans_700Bold' },
  statUnit: {
    ...typography.caption,
    color: colors.textMuted,
    fontFamily: 'DMSans_400Regular',
    marginTop: 1,
  },
  statLabel: {
    ...typography.caption,
    color: colors.textSecondary,
    fontFamily: 'DMSans_400Regular',
    marginTop: 2,
  },
  section: { marginBottom: spacing.xxl },
  sectionTitle: {
    ...typography.label,
    color: colors.textMuted,
    fontFamily: 'DMSans_500Medium',
    marginBottom: spacing.sm,
  },
  card: {
    backgroundColor: colors.surface,
    borderRadius: radii.lg,
    borderWidth: 1,
    borderColor: colors.border,
    overflow: 'hidden',
  },
  infoRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    padding: spacing.lg,
    borderBottomWidth: 1,
    borderBottomColor: colors.borderSubtle,
    gap: spacing.md,
  },
  infoLabel: {
    ...typography.bodySm,
    color: colors.textSecondary,
    fontFamily: 'DMSans_400Regular',
  },
  infoValue: {
    ...typography.bodySm,
    color: colors.text,
    fontFamily: 'DMSans_500Medium',
    flex: 1,
    textAlign: 'right',
  },
  ctaBtn: { marginTop: spacing.sm },
  editActions: { flexDirection: 'row', gap: spacing.sm },
  editBtn: { flex: 1 },
})
