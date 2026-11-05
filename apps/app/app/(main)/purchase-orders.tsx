import { useCallback, useEffect, useState } from 'react'
import {
  Alert,
  FlatList,
  Modal,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { Button } from '@/components/ui/Button'
import { EmptyState } from '@/components/ui/EmptyState'
import { LoadingBlock } from '@/components/ui/LoadingBlock'
import { TextField } from '@/components/ui/TextField'
import { useAuth } from '@/lib/auth'
import {
  ApiError,
  createPharmacyPurchaseOrder,
  fetchPharmacyPurchaseOrders,
  fetchPharmacySuppliers,
  searchPosProducts,
  updatePharmacyPurchaseOrderStatus,
  type PharmacyPurchaseOrder,
  type PharmacySupplier,
} from '@/lib/api'
import { colors, radii, spacing, tabBarHeight, typography, TONE_COLORS } from '@/lib/theme'

type ReceiptDraft = Record<
  string,
  { batchNumber: string; expiryDate: string; quantity: string; costPrice: string }
>

export default function PurchaseOrdersScreen() {
  const { token } = useAuth()
  const insets = useSafeAreaInsets()
  const [orders, setOrders] = useState<PharmacyPurchaseOrder[]>([])
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [receiving, setReceiving] = useState<PharmacyPurchaseOrder | null>(null)
  const [receiptDraft, setReceiptDraft] = useState<ReceiptDraft>({})
  const [saving, setSaving] = useState(false)
  const [showCreate, setShowCreate] = useState(false)
  const [suppliers, setSuppliers] = useState<PharmacySupplier[]>([])
  const [supplierId, setSupplierId] = useState('')
  const [productQuery, setProductQuery] = useState('')
  const [productHits, setProductHits] = useState<
    Array<{ id: string; name: string; price: number; costPrice: number | null }>
  >([])
  const [lineItems, setLineItems] = useState<
    Array<{ productId: string; productName: string; quantity: number; unitPrice: number }>
  >([])

  const load = useCallback(async () => {
    if (!token) {
      setLoading(false)
      return
    }
    try {
      const data = await fetchPharmacyPurchaseOrders(token)
      setOrders(data.purchaseOrders)
    } catch {
      setOrders([])
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }, [token])

  useEffect(() => {
    load()
  }, [load])

  // Statuses that may still take stock. A cancelled order is finished, and a
  // received one is done — receiving either would create stock from a PO that
  // never went out.
  const RECEIVABLE_STATUSES = new Set(['DRAFT', 'ORDERED', 'SENT', 'PARTIALLY_RECEIVED'])
  const canReceive = (po: PharmacyPurchaseOrder) =>
    RECEIVABLE_STATUSES.has(po.status) && po.items.some((i) => i.productId)

  const openReceive = (po: PharmacyPurchaseOrder) => {
    if (!canReceive(po)) return
    const draft: ReceiptDraft = {}
    for (const item of po.items) {
      if (!item.productId) continue
      // Keyed by the PO line: a PO may list the same product twice, and keying
      // by product made the second line overwrite the first.
      draft[item.id] = {
        batchNumber: '',
        expiryDate: '',
        quantity: String(item.quantity),
        costPrice: String(item.unitPrice),
      }
    }
    setReceiptDraft(draft)
    setReceiving(po)
  }

  const submitReceive = async () => {
    if (!token || !receiving) return
    const linked = receiving.items.filter((i) => i.productId)
    const receiptItems = linked.map((item) => {
      const d = receiptDraft[item.id]
      return {
        productId: item.productId!,
        purchaseOrderItemId: item.id,
        batchNumber: d?.batchNumber?.trim() ?? '',
        expiryDate: d?.expiryDate?.trim() ?? '',
        quantity: Number(d?.quantity ?? item.quantity),
        costPrice: Number(d?.costPrice ?? item.unitPrice),
      }
    })
    const missing = receiptItems.find((r) => !r.batchNumber || !r.expiryDate)
    if (missing) {
      Alert.alert('Batch required', 'Enter batch number and expiry (YYYY-MM-DD) for every line.')
      return
    }
    setSaving(true)
    try {
      await updatePharmacyPurchaseOrderStatus(token, {
        id: receiving.id,
        status: 'RECEIVED',
        receiptItems,
      })
      setReceiving(null)
      await load()
      Alert.alert('Received', 'Stock received for this purchase order.')
    } catch (err) {
      Alert.alert('Receive failed', err instanceof ApiError ? err.message : 'Try again')
    } finally {
      setSaving(false)
    }
  }

  const openCreate = async () => {
    if (!token) return
    setShowCreate(true)
    try {
      const data = await fetchPharmacySuppliers(token)
      setSuppliers(data.suppliers)
      if (data.suppliers[0]) setSupplierId(data.suppliers[0].id)
    } catch {
      setSuppliers([])
    }
  }

  const searchProducts = async (q: string) => {
    setProductQuery(q)
    if (!token || q.trim().length < 2) {
      setProductHits([])
      return
    }
    try {
      const data = await searchPosProducts(token, q.trim())
      setProductHits(
        data.products.map((p) => ({
          id: p.id,
          name: p.name,
          price: p.price,
          costPrice: p.costPrice,
        })),
      )
    } catch {
      setProductHits([])
    }
  }

  const addLine = (p: { id: string; name: string; costPrice: number | null; price: number }) => {
    setLineItems((prev) => [
      ...prev,
      {
        productId: p.id,
        productName: p.name,
        quantity: 1,
        unitPrice: p.costPrice ?? p.price,
      },
    ])
    setProductQuery('')
    setProductHits([])
  }

  const createPo = async () => {
    if (!token) return
    if (!supplierId || lineItems.length === 0) {
      Alert.alert('Required', 'Pick a supplier and at least one product.')
      return
    }
    setSaving(true)
    try {
      await createPharmacyPurchaseOrder(token, { supplierId, items: lineItems })
      setShowCreate(false)
      setLineItems([])
      await load()
    } catch (err) {
      Alert.alert('Create failed', err instanceof ApiError ? err.message : 'Try again')
    } finally {
      setSaving(false)
    }
  }

  const statusColor = (status: string) => {
    if (status === 'RECEIVED') return TONE_COLORS.green
    if (status === 'SENT') return TONE_COLORS.gold
    if (status === 'CANCELLED') return TONE_COLORS.red
    return colors.textMuted
  }

  return (
    <View style={styles.container}>
      <View style={styles.toolbar}>
        <Pressable style={styles.toolBtn} onPress={openCreate}>
          <Text style={styles.toolBtnText}>+ New PO</Text>
        </Pressable>
      </View>

      {loading ? (
        <LoadingBlock message="Loading purchase orders…" />
      ) : (
        <FlatList
          data={orders}
          keyExtractor={(item) => item.id}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={() => {
                setRefreshing(true)
                load()
              }}
              tintColor={colors.primary}
            />
          }
          contentContainerStyle={[
            styles.list,
            { paddingBottom: insets.bottom + tabBarHeight + spacing.lg },
          ]}
          ListEmptyComponent={
            <EmptyState
              title="No purchase orders"
              body="Create a PO, then receive stock with batch and expiry."
              icon="document"
            />
          }
          renderItem={({ item }) => (
            <View style={styles.card}>
              <View style={styles.row}>
                <Text style={styles.orderNo}>{item.orderNumber}</Text>
                <Text style={[styles.status, { color: statusColor(item.status) }]}>
                  {item.status}
                </Text>
              </View>
              <Text style={styles.meta}>{item.supplier.name || 'Supplier'}</Text>
              <Text style={styles.amount}>
                UGX {Number(item.totalAmount).toLocaleString()} · {item.items.length} line
                {item.items.length === 1 ? '' : 's'}
              </Text>
              {canReceive(item) ? (
                <Pressable style={styles.receiveBtn} onPress={() => openReceive(item)}>
                  <Text style={styles.receiveText}>Receive stock</Text>
                </Pressable>
              ) : null}
            </View>
          )}
        />
      )}

      <Modal visible={!!receiving} animationType="slide" presentationStyle="pageSheet">
        <View style={[styles.modal, { paddingTop: insets.top + spacing.md }]}>
          <View style={styles.modalHeader}>
            <Text style={styles.modalTitle}>Receive {receiving?.orderNumber}</Text>
            <Pressable onPress={() => setReceiving(null)}>
              <Text style={styles.cancel}>Cancel</Text>
            </Pressable>
          </View>
          <ScrollView contentContainerStyle={styles.form} keyboardShouldPersistTaps="handled">
            <Text style={styles.hint}>
              Enter batch number and expiry (YYYY-MM-DD) for each product-linked line.
            </Text>
            {(receiving?.items ?? [])
              .filter((i) => i.productId)
              .map((item) => {
                const d = receiptDraft[item.id] ?? {
                  batchNumber: '',
                  expiryDate: '',
                  quantity: String(item.quantity),
                  costPrice: String(item.unitPrice),
                }
                return (
                  <View key={item.id} style={styles.lineCard}>
                    <Text style={styles.lineName}>{item.productName}</Text>
                    <TextField
                      label="Batch number"
                      value={d.batchNumber}
                      onChangeText={(v) =>
                        setReceiptDraft((prev) => ({
                          ...prev,
                          [item.id]: { ...d, batchNumber: v },
                        }))
                      }
                    />
                    <TextField
                      label="Expiry (YYYY-MM-DD)"
                      value={d.expiryDate}
                      onChangeText={(v) =>
                        setReceiptDraft((prev) => ({
                          ...prev,
                          [item.id]: { ...d, expiryDate: v },
                        }))
                      }
                      placeholder="2027-12-31"
                      autoCapitalize="none"
                    />
                    <TextField
                      label="Quantity"
                      value={d.quantity}
                      onChangeText={(v) =>
                        setReceiptDraft((prev) => ({
                          ...prev,
                          [item.id]: { ...d, quantity: v },
                        }))
                      }
                      keyboardType="numeric"
                    />
                    <TextField
                      label="Cost price"
                      value={d.costPrice}
                      onChangeText={(v) =>
                        setReceiptDraft((prev) => ({
                          ...prev,
                          [item.id]: { ...d, costPrice: v },
                        }))
                      }
                      keyboardType="numeric"
                    />
                  </View>
                )
              })}
            <Button label="Mark received" onPress={submitReceive} loading={saving} />
          </ScrollView>
        </View>
      </Modal>

      <Modal visible={showCreate} animationType="slide" presentationStyle="pageSheet">
        <View style={[styles.modal, { paddingTop: insets.top + spacing.md }]}>
          <View style={styles.modalHeader}>
            <Text style={styles.modalTitle}>New purchase order</Text>
            <Pressable onPress={() => setShowCreate(false)}>
              <Text style={styles.cancel}>Cancel</Text>
            </Pressable>
          </View>
          <ScrollView contentContainerStyle={styles.form} keyboardShouldPersistTaps="handled">
            <Text style={styles.label}>Supplier</Text>
            {suppliers.map((s) => (
              <Pressable
                key={s.id}
                style={[styles.chip, supplierId === s.id && styles.chipActive]}
                onPress={() => setSupplierId(s.id)}
              >
                <Text style={[styles.chipText, supplierId === s.id && styles.chipTextActive]}>
                  {s.name}
                </Text>
              </Pressable>
            ))}
            <TextField
              label="Search product"
              value={productQuery}
              onChangeText={searchProducts}
              placeholder="Name, SKU, or barcode"
            />
            {productHits.map((p) => (
              <Pressable key={p.id} style={styles.hit} onPress={() => addLine(p)}>
                <Text style={styles.hitText}>{p.name}</Text>
              </Pressable>
            ))}
            {lineItems.map((line, idx) => (
              <View key={`${line.productId}-${idx}`} style={styles.lineCard}>
                <Text style={styles.lineName}>{line.productName}</Text>
                <Text style={styles.meta}>
                  Qty {line.quantity} · UGX {line.unitPrice.toLocaleString()}
                </Text>
              </View>
            ))}
            <Button label="Create PO" onPress={createPo} loading={saving} />
          </ScrollView>
        </View>
      </Modal>
    </View>
  )
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  toolbar: { paddingHorizontal: spacing.lg, paddingVertical: spacing.md },
  toolBtn: {
    backgroundColor: colors.primarySoft,
    borderRadius: radii.md,
    paddingVertical: 12,
    paddingHorizontal: spacing.lg,
    alignSelf: 'flex-start',
  },
  toolBtnText: { color: colors.primary, fontFamily: 'DMSans_700Bold', fontSize: 14 },
  list: { paddingHorizontal: spacing.lg },
  card: {
    backgroundColor: colors.bgElevated,
    borderRadius: radii.lg,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.lg,
    marginBottom: spacing.md,
  },
  row: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  orderNo: { ...typography.bodyMedium, color: colors.text, fontFamily: 'DMSans_700Bold' },
  status: { fontFamily: 'DMSans_500Medium', fontSize: 12 },
  meta: { ...typography.bodySm, color: colors.textSecondary, marginTop: 4 },
  amount: { ...typography.bodySm, color: colors.text, marginTop: spacing.sm },
  receiveBtn: {
    marginTop: spacing.md,
    alignSelf: 'flex-start',
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: radii.sm,
    backgroundColor: colors.tealSoft,
  },
  receiveText: { color: colors.teal, fontFamily: 'DMSans_700Bold', fontSize: 13 },
  modal: { flex: 1, backgroundColor: colors.bg },
  modalHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: spacing.xl,
    paddingBottom: spacing.md,
  },
  modalTitle: { ...typography.h2, color: colors.text, fontFamily: 'DMSans_700Bold', flex: 1 },
  cancel: { color: colors.primary, fontFamily: 'DMSans_500Medium' },
  form: { padding: spacing.xl, paddingBottom: 48 },
  hint: { color: colors.textSecondary, marginBottom: spacing.lg, fontFamily: 'DMSans_400Regular' },
  lineCard: {
    backgroundColor: colors.bgElevated,
    borderRadius: radii.md,
    padding: spacing.lg,
    marginBottom: spacing.lg,
    borderWidth: 1,
    borderColor: colors.border,
  },
  lineName: { color: colors.text, fontFamily: 'DMSans_700Bold', marginBottom: spacing.md },
  label: {
    color: colors.textSecondary,
    fontFamily: 'DMSans_500Medium',
    marginBottom: spacing.sm,
  },
  chip: {
    paddingVertical: 10,
    paddingHorizontal: 14,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.border,
    marginBottom: spacing.sm,
  },
  chipActive: { borderColor: colors.primary, backgroundColor: colors.primarySoft },
  chipText: { color: colors.textSecondary, fontFamily: 'DMSans_500Medium' },
  chipTextActive: { color: colors.primary },
  hit: {
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: colors.borderSubtle,
  },
  hitText: { color: colors.text, fontFamily: 'DMSans_500Medium' },
})
