import { useCallback, useEffect, useRef, useState } from 'react'
import {
  Alert,
  FlatList,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native'
import AsyncStorage from '@react-native-async-storage/async-storage'
import * as Crypto from 'expo-crypto'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { Button } from '@/components/ui/Button'
import { EmptyState } from '@/components/ui/EmptyState'
import { LoadingBlock } from '@/components/ui/LoadingBlock'
import { TextField } from '@/components/ui/TextField'
import { useAuth } from '@/lib/auth'
import {
  ApiError,
  createPharmacyPurchase,
  createPharmacySupplier,
  createPurchaseProduct,
  fetchPharmacyPurchases,
  fetchPharmacySuppliers,
  searchPurchaseProducts,
  type PharmacyPurchase,
  type PharmacySupplier,
  type PurchaseProductMatch,
} from '@/lib/api'
import {
  buildPersistedPurchaseDraft,
  emptyNewProductDraft,
  keyForSubmit,
  looksLikeBarcode,
  parsePersistedPurchaseDraft,
  purchaseLocalStatusLabel,
  PURCHASE_DRAFT_STORAGE_KEY,
  resetPurchaseDraft,
  type NewProductDraft,
  type PurchaseLineDraft,
} from '@/lib/purchase-draft'
import { purchaseTotals } from '../../../../packages/db/src/pharmacy-purchases'
import { radii, spacing, tabBarHeight, typography, makeStyles, useTheme } from '@/lib/theme'

export default function PurchasesScreen() {
  const styles = useStyles()
  const { colors } = useTheme()
  const { token } = useAuth()
  const insets = useSafeAreaInsets()
  const [purchases, setPurchases] = useState<PharmacyPurchase[]>([])
  const [loading, setLoading] = useState(true)
  const [showNew, setShowNew] = useState(false)
  const [canCreateSupplier, setCanCreateSupplier] = useState(false)
  const [suppliers, setSuppliers] = useState<PharmacySupplier[]>([])
  const [supplierId, setSupplierId] = useState('')
  const [invoice, setInvoice] = useState('')
  const [query, setQuery] = useState('')
  const [hits, setHits] = useState<PurchaseProductMatch[]>([])
  const [searched, setSearched] = useState(false)
  const [lines, setLines] = useState<PurchaseLineDraft[]>([])
  const [qty, setQty] = useState('1')
  const [cost, setCost] = useState('')
  const [sell, setSell] = useState('')
  const [batch, setBatch] = useState('')
  const [expiry, setExpiry] = useState('')
  const [picked, setPicked] = useState<{
    id: string
    name: string
    costPrice?: number | null
    price?: number | null
  } | null>(null)
  const [saving, setSaving] = useState(false)
  const [newSupplierName, setNewSupplierName] = useState('')
  const [createProduct, setCreateProduct] = useState(false)
  const [newProduct, setNewProduct] = useState<NewProductDraft>(emptyNewProductDraft())
  const [dupes, setDupes] = useState<Array<PurchaseProductMatch & { score: number }>>([])
  const [creatingProduct, setCreatingProduct] = useState(false)
  const [draftRestored, setDraftRestored] = useState(false)
  const [localDraftBanner, setLocalDraftBanner] = useState(false)
  const receiveKeyRef = useRef<string | null>(null)

  const clearLocalDraft = useCallback(() => {
    void AsyncStorage.removeItem(PURCHASE_DRAFT_STORAGE_KEY)
    setLocalDraftBanner(false)
  }, [])

  const resetDraft = useCallback((keepSupplierList = true) => {
    const next = resetPurchaseDraft(() => Crypto.randomUUID())
    receiveKeyRef.current = next.idempotencyKey
    setSupplierId(keepSupplierList && suppliers[0] ? suppliers[0].id : '')
    setInvoice(next.invoice)
    setQuery(next.query)
    setHits([])
    setSearched(false)
    setLines([])
    setQty(next.qty)
    setCost(next.cost)
    setSell(next.sell)
    setBatch(next.batch)
    setExpiry(next.expiry)
    setPicked(null)
    setNewSupplierName('')
    setCreateProduct(false)
    setNewProduct(emptyNewProductDraft())
    setDupes([])
    clearLocalDraft()
  }, [clearLocalDraft, suppliers])

  // Restore unfinished purchase draft after app restart. Never treat as received stock.
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const raw = await AsyncStorage.getItem(PURCHASE_DRAFT_STORAGE_KEY)
        const draft = parsePersistedPurchaseDraft(raw)
        if (!draft || cancelled) return
        if (draft.lines.length === 0 && !draft.supplierId && !draft.invoice) return
        setSupplierId(draft.supplierId)
        setInvoice(draft.invoice)
        setLines(draft.lines)
        if (draft.idempotencyKey) receiveKeyRef.current = draft.idempotencyKey
        setLocalDraftBanner(true)
        setShowNew(true)
      } catch {
        /* ignore corrupt draft */
      } finally {
        if (!cancelled) setDraftRestored(true)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  // Persist incomplete entry locally. Server confirmation is still required for inventory.
  useEffect(() => {
    if (!draftRestored) return
    const payload = buildPersistedPurchaseDraft({
      supplierId,
      invoice,
      lines,
      idempotencyKey: receiveKeyRef.current,
    })
    if (!payload) {
      void AsyncStorage.removeItem(PURCHASE_DRAFT_STORAGE_KEY)
      return
    }
    void AsyncStorage.setItem(PURCHASE_DRAFT_STORAGE_KEY, JSON.stringify(payload))
  }, [draftRestored, supplierId, invoice, lines])

  const load = useCallback(async () => {
    if (!token) {
      setLoading(false)
      return
    }
    try {
      const data = await fetchPharmacyPurchases(token)
      setPurchases(data.purchases)
    } catch {
      setPurchases([])
    } finally {
      setLoading(false)
    }
  }, [token])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    if (!showNew || !token) return
    let cancelled = false
    ;(async () => {
      try {
        const data = await fetchPharmacySuppliers(token)
        if (cancelled) return
        setSuppliers(data.suppliers)
        setCanCreateSupplier(Boolean(data.canManage))
        setSupplierId((current) => current || (data.suppliers[0]?.id ?? ''))
      } catch {
        if (!cancelled) {
          setSuppliers([])
          setCanCreateSupplier(false)
        }
      }
    })()
    return () => {
      cancelled = true
    }
  }, [showNew, token])

  const openNew = async () => {
    if (!token) return
    resetDraft(false)
    setShowNew(true)
  }

  const cancelDraft = () => {
    resetDraft(false)
    setShowNew(false)
  }

  const search = async (q: string) => {
    setQuery(q)
    setPicked(null)
    if (!token || q.trim().length < 2) {
      setHits([])
      setSearched(false)
      return
    }
    try {
      const barcode = looksLikeBarcode(q) ? q.trim() : undefined
      const data = await searchPurchaseProducts(token, { q: q.trim(), barcode })
      setHits(data.matches)
      setSearched(true)
    } catch {
      setHits([])
      setSearched(true)
    }
  }

  const selectExisting = (product: {
    id: string
    name: string
    costPrice?: number | null
    price?: number | null
    barcode?: string | null
  }) => {
    setPicked(product)
    setCost(product.costPrice != null ? String(product.costPrice) : '')
    setSell(product.price != null ? String(product.price) : '')
    setCreateProduct(false)
    setDupes([])
    setHits([])
  }

  const addLine = () => {
    if (!picked) return
    const qtyNum = Number(qty)
    const costNum = Number(cost)
    if (!batch.trim() || !(qtyNum > 0) || !expiry.trim() || !cost.trim() || !(costNum >= 0)) {
      Alert.alert('Batch required', 'Enter quantity, batch number, expiry and cost.')
      return
    }
    setLines((prev) => [
      ...prev,
      {
        clientItemId: Crypto.randomUUID(),
        productId: picked.id,
        productName: picked.name,
        quantity: qty,
        unitCost: cost || '0',
        sellingPrice: sell,
        batchNumber: batch.trim(),
        expiryDate: expiry.trim(),
      },
    ])
    setPicked(null)
    setQuery('')
    setHits([])
    setSearched(false)
    setQty('1')
    setCost('')
    setSell('')
    setBatch('')
    setExpiry('')
  }

  const submitNewProduct = async (createAnyway = false) => {
    if (!token || !newProduct.name.trim()) {
      Alert.alert('Required', 'Product name is required.')
      return
    }
    setCreatingProduct(true)
    try {
      const created = await createPurchaseProduct(token, {
        name: newProduct.name.trim(),
        genericName: newProduct.genericName || undefined,
        brand: newProduct.brand || undefined,
        strength: newProduct.strength || undefined,
        dosageForm: newProduct.dosageForm || undefined,
        unit: newProduct.unit || undefined,
        barcode: newProduct.barcode || undefined,
        sku: newProduct.sku || undefined,
        manufacturer: newProduct.manufacturer || undefined,
        category: newProduct.category || undefined,
        sellingPrice: newProduct.sellingPrice ? Number(newProduct.sellingPrice) : 0,
        reorderLevel: newProduct.reorderLevel ? Number(newProduct.reorderLevel) : undefined,
        createAnyway,
      })
      selectExisting({
        id: created.product.id,
        name: created.product.name,
        costPrice: created.product.costPrice,
        price: created.product.price,
        barcode: created.product.barcode,
      })
      setNewProduct(emptyNewProductDraft())
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        const candidates = Array.isArray(err.payload.candidates) ? err.payload.candidates : []
        setDupes(candidates as Array<PurchaseProductMatch & { score: number }>)
        return
      }
      Alert.alert('Create failed', err instanceof ApiError ? err.message : 'Could not create product.')
    } finally {
      setCreatingProduct(false)
    }
  }

  const submit = async () => {
    if (!token) return
    if (!supplierId || lines.length === 0) {
      Alert.alert('Required', 'Pick a supplier and add items.')
      return
    }
    setSaving(true)
    const idempotencyKey = keyForSubmit(receiveKeyRef.current, () => Crypto.randomUUID())
    receiveKeyRef.current = idempotencyKey
    try {
      const result = await createPharmacyPurchase(token, {
        supplierId,
        supplierInvoiceNo: invoice || undefined,
        idempotencyKey,
        receiveNow: true,
        lines: lines.map((line) => ({
          clientItemId: line.clientItemId,
          productId: line.productId,
          productName: line.productName,
          quantity: Number(line.quantity),
          unitCost: Number(line.unitCost),
          batchNumber: line.batchNumber,
          expiryDate: line.expiryDate,
          sellingPrice: line.sellingPrice.trim() ? Number(line.sellingPrice) : null,
          updateSellingPrice: Boolean(line.sellingPrice.trim()),
        })),
      })
      const supplierName = suppliers.find((s) => s.id === supplierId)?.name ?? 'Supplier'
      const itemCount = lines.length
      receiveKeyRef.current = null
      clearLocalDraft()
      setShowNew(false)
      resetDraft(false)
      await load()
      if (result.replay) {
        Alert.alert('Already received — no duplicate stock was added.', `Purchase No. ${result.purchaseNo}`)
      } else {
        Alert.alert(
          'Purchase received',
          `Purchase No. ${result.purchaseNo}\nSupplier ${supplierName}\nItems ${itemCount}\nTotal ${(result.grandTotal ?? 0).toLocaleString()}`,
        )
      }
    } catch (err) {
      Alert.alert(
        'Receive failed',
        err instanceof ApiError
          ? err.message
          : 'Try again. Local draft kept — inventory is not updated until the server accepts the receipt.',
      )
    } finally {
      setSaving(false)
    }
  }

  const totals = purchaseTotals({
    lines: lines.map((line) => ({ quantity: Number(line.quantity) || 0, unitCost: Number(line.unitCost) || 0 })),
  })

  if (loading) return <LoadingBlock />

  return (
    <View style={[styles.root, { paddingBottom: insets.bottom + tabBarHeight }]}>
      <View style={styles.header}>
        <Text style={[typography.title, { color: colors.text }]}>Purchases</Text>
        <Button label="New Purchase" onPress={() => void openNew()} />
      </View>
      {localDraftBanner ? (
        <Text style={{ color: colors.textSecondary, paddingHorizontal: spacing.xl, paddingBottom: spacing.sm }}>
          {purchaseLocalStatusLabel('DRAFT')}
        </Text>
      ) : null}
      {purchases.length === 0 ? (
        <EmptyState title="No purchases yet" body="Record a walk-in purchase without creating a purchase order first." />
      ) : (
        <FlatList
          data={purchases}
          keyExtractor={(item) => item.id}
          contentContainerStyle={{ padding: spacing.lg, gap: spacing.md }}
          renderItem={({ item }) => (
            <View style={styles.card}>
              <Text style={[typography.heading, { color: colors.text }]}>{item.purchaseNo}</Text>
              <Text style={{ color: colors.textSecondary }}>{item.supplier.name}</Text>
              <Text style={{ color: colors.textMuted }}>
                {item.purchaseDate ?? ''} · {item.status} · {item.paymentStatus}
              </Text>
              <Text style={{ color: colors.text }}>{item.total.toLocaleString()} · {item.items.length} items</Text>
            </View>
          )}
        />
      )}

      <Modal visible={showNew} animationType="slide" onRequestClose={cancelDraft}>
        <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1, backgroundColor: colors.bg }}>
          <ScrollView contentContainerStyle={{ padding: spacing.xl, paddingTop: insets.top + spacing.lg, gap: spacing.md }}>
            <Text style={[typography.title, { color: colors.text }]}>New Purchase</Text>
            <Text style={{ color: colors.textSecondary }}>Supplier</Text>
            {suppliers.map((s) => (
              <Pressable key={s.id} onPress={() => setSupplierId(s.id)} style={[styles.card, supplierId === s.id && { borderColor: colors.primary }]}>
                <Text style={{ color: colors.text }}>{s.name}</Text>
              </Pressable>
            ))}
            {canCreateSupplier ? (
              <>
                <TextField label="Or create supplier" value={newSupplierName} onChangeText={setNewSupplierName} />
                <Button
                  label="Create supplier"
                  variant="ghost"
                  onPress={async () => {
                    if (!token || !newSupplierName.trim()) return
                    try {
                      const created = await createPharmacySupplier(token, { name: newSupplierName.trim() })
                      setSuppliers((prev) => [created.supplier, ...prev])
                      setSupplierId(created.supplier.id)
                      setNewSupplierName('')
                    } catch (err) {
                      Alert.alert('Supplier', err instanceof ApiError ? err.message : 'Could not create supplier.')
                    }
                  }}
                />
              </>
            ) : null}
            <TextField label="Supplier invoice" value={invoice} onChangeText={setInvoice} />
            <TextField
              label="Search product or scan barcode"
              value={query}
              onChangeText={(v) => void search(v)}
              autoCapitalize="none"
            />
            {hits.map((p) => (
              <Pressable key={p.id} onPress={() => selectExisting(p)} style={styles.card} accessibilityRole="button">
                <Text style={{ color: colors.text }}>{p.name}</Text>
                <Text style={{ color: colors.textMuted }}>Existing product{p.strength ? ` · ${p.strength}` : ''}</Text>
              </Pressable>
            ))}
            {searched && hits.length === 0 && !picked ? (
              <View style={styles.card}>
                <Text style={{ color: colors.text }}>No matching product found</Text>
                <Button
                  label="+ Create New Product"
                  variant="ghost"
                  onPress={() => {
                    setCreateProduct(true)
                    setNewProduct(emptyNewProductDraft(looksLikeBarcode(query) ? query.trim() : ''))
                    setDupes([])
                  }}
                />
              </View>
            ) : null}
            {createProduct ? (
              <View style={styles.card}>
                <Text style={[typography.heading, { color: colors.text }]}>Create new product</Text>
                <TextField label="Product name *" value={newProduct.name} onChangeText={(name) => setNewProduct({ ...newProduct, name })} />
                <TextField label="Generic name" value={newProduct.genericName} onChangeText={(genericName) => setNewProduct({ ...newProduct, genericName })} />
                <TextField label="Brand" value={newProduct.brand} onChangeText={(brand) => setNewProduct({ ...newProduct, brand })} />
                <TextField label="Strength" value={newProduct.strength} onChangeText={(strength) => setNewProduct({ ...newProduct, strength })} />
                <TextField label="Dosage form" value={newProduct.dosageForm} onChangeText={(dosageForm) => setNewProduct({ ...newProduct, dosageForm })} />
                <TextField label="Unit" value={newProduct.unit} onChangeText={(unit) => setNewProduct({ ...newProduct, unit })} />
                <TextField label="Barcode" value={newProduct.barcode} onChangeText={(barcode) => setNewProduct({ ...newProduct, barcode })} autoCapitalize="none" />
                <TextField label="SKU" value={newProduct.sku} onChangeText={(sku) => setNewProduct({ ...newProduct, sku })} autoCapitalize="none" />
                <TextField label="Manufacturer" value={newProduct.manufacturer} onChangeText={(manufacturer) => setNewProduct({ ...newProduct, manufacturer })} />
                <TextField label="Category" value={newProduct.category} onChangeText={(category) => setNewProduct({ ...newProduct, category })} />
                <TextField label="Selling price" value={newProduct.sellingPrice} onChangeText={(sellingPrice) => setNewProduct({ ...newProduct, sellingPrice })} keyboardType="numeric" />
                <TextField label="Reorder level" value={newProduct.reorderLevel} onChangeText={(reorderLevel) => setNewProduct({ ...newProduct, reorderLevel })} keyboardType="numeric" />
                {dupes.length > 0 ? (
                  <View style={{ gap: spacing.sm }}>
                    <Text style={{ color: colors.text }}>Similar products found</Text>
                    {dupes.map((d) => (
                      <View key={d.id} style={styles.card}>
                        <Text style={{ color: colors.text }}>{d.name}</Text>
                        <Text style={{ color: colors.textMuted }}>
                          {[d.strength, d.dosageForm, d.genericName || d.brandName, d.sku || d.barcode].filter(Boolean).join(' · ')}
                        </Text>
                        <Button label="Use Existing" variant="ghost" onPress={() => selectExisting(d)} />
                      </View>
                    ))}
                    <Button label={creatingProduct ? 'Creating…' : 'Create Anyway'} onPress={() => void submitNewProduct(true)} disabled={creatingProduct} />
                    <Button label="Cancel" variant="ghost" onPress={() => { setCreateProduct(false); setDupes([]); setNewProduct(emptyNewProductDraft()) }} />
                  </View>
                ) : (
                  <View style={{ gap: spacing.sm }}>
                    <Button label={creatingProduct ? 'Creating…' : 'Create product'} onPress={() => void submitNewProduct(false)} disabled={creatingProduct} />
                    <Button label="Cancel" variant="ghost" onPress={() => { setCreateProduct(false); setDupes([]) }} />
                  </View>
                )}
              </View>
            ) : null}
            {picked && (
              <View style={{ gap: spacing.sm }}>
                <Text style={{ color: colors.text }}>{picked.name}</Text>
                <TextField label="Quantity" value={qty} onChangeText={setQty} keyboardType="numeric" />
                <TextField label="Cost" value={cost} onChangeText={setCost} keyboardType="numeric" />
                <TextField label="Selling price" value={sell} onChangeText={setSell} keyboardType="numeric" />
                <TextField label="Batch" value={batch} onChangeText={setBatch} />
                <TextField label="Expiry YYYY-MM-DD" value={expiry} onChangeText={setExpiry} />
                <Button label="Add item" onPress={addLine} />
              </View>
            )}
            {lines.map((line) => (
              <Text key={line.clientItemId} style={{ color: colors.textSecondary }}>
                {line.productName} × {line.quantity} · {line.batchNumber}
                {line.sellingPrice ? ` · sell ${line.sellingPrice}` : ''}
              </Text>
            ))}
            <Text style={{ color: colors.text }}>
              {lines.length} items · Subtotal {totals.subtotal.toLocaleString()}
            </Text>
            <Text style={{ color: colors.textMuted }}>
              Receive confirms on the server. A failed attempt keeps this local draft and reuses the same idempotency key.
            </Text>
            <Button label={saving ? 'Receiving…' : 'Receive'} onPress={() => void submit()} disabled={saving} />
            <Button label="Cancel" variant="ghost" onPress={cancelDraft} />
          </ScrollView>
        </KeyboardAvoidingView>
      </Modal>
    </View>
  )
}

const useStyles = makeStyles((colors) => ({
  root: { flex: 1, backgroundColor: colors.bg },
  header: {
    paddingHorizontal: spacing.xl,
    paddingTop: spacing.lg,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  card: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.md,
    padding: spacing.md,
    backgroundColor: colors.bgSubtle,
    gap: spacing.sm,
  },
}))
