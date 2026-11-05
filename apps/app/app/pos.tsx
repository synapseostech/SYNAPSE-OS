import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
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
  TextInput,
  useWindowDimensions,
  View,
} from 'react-native'
import AsyncStorage from '@react-native-async-storage/async-storage'
import { Ionicons } from '@expo/vector-icons'
import { useRouter, useLocalSearchParams } from 'expo-router'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { Button } from '@/components/ui/Button'
import { EmptyState } from '@/components/ui/EmptyState'
import { LoadingBlock } from '@/components/ui/LoadingBlock'
import { useAuth } from '@/lib/auth'
import { apiRequest, ApiError } from '@/lib/api'
import {
  cachePharmacyCatalogue,
  commitPharmacySale,
  getPharmacySellableMap,
  getPharmacySyncStatus,
  loadCachedPharmacyCatalogue,
  newPharmacyCommandId,
  OfflineStockError,
  syncPharmacySales,
} from '@/lib/offline-store'
import { SyncPayloadConflictError } from '../../../packages/db/src/sync-runtime'
import { computePharmacySaleTax } from '../../../packages/db/src/pos-tax'
import type { PharmacyTaxSettings } from '../../../packages/db/src/pos-tax'
import { allocateCartDiscount, roundMoney } from '@/lib/pos-pricing'
import { colors, radii, spacing, typography, TONE_COLORS } from '@/lib/theme'

const CART_DRAFT_KEY = 'synapse.pharmacy.pos.draft.v1'
const TAX_SETTINGS_KEY = 'synapse.pharmacy.pos.tax.v1'

type PosProduct = {
  id: string
  name: string
  sku: string | null
  barcode: string | null
  price: number
  quantity: number
  sellableQuantity?: number
  unit: string
  requiresPrescription: boolean
  vatCategory?: string | null
  packages: Array<{
    id: string
    name: string
    unitsPerPackage: number
    price: number
    isDefault: boolean
  }>
  batches: Array<{
    id: string
    batchNumber: string
    quantity: number
    expiryDate: string
    sellingPrice?: number
  }>
}

type CartLine = {
  key: string
  productId: string
  name: string
  unitPrice: number
  quantity: number
  batchId: string | null
  batchLabel: string | null
  packageLabel: string | null
  discountAmount: number
  unitsPerPackage: number
  /** `pharmacy_products.vat_category`; null on a draft written before VAT preview. */
  vatCategory?: string | null
}

type SaleResult = {
  sale_id?: string
  receipt_number?: string
  total_amount?: number
  status?: string
}

type LowStockItem = {
  id: string
  name: string
  quantity: number
  reorderLevel: number
}

type PickerOption = {
  label: string
  detail?: string
  onPress: () => void
}

type PickerSheet = {
  title: string
  message?: string
  options: PickerOption[]
}

const PAYMENTS = [
  { key: 'CASH', label: 'Cash' },
  { key: 'MOBILE_MONEY', label: 'Mobile money' },
  { key: 'CARD', label: 'Card' },
] as const

function newCommandId() {
  return newPharmacyCommandId()
}

function syncBannerLabel(
  banner: 'pending' | 'offline' | 'conflict' | 'rejected' | 'stale',
): string {
  switch (banner) {
    case 'pending':
      return 'Pending sync. Sale saved on this device. Tap for command list.'
    case 'offline':
      return 'Offline. Selling from cached stock. Receipts stay pending until synced.'
    case 'stale':
      return 'Cached stock is stale. Reconnect before selling offline. Tap for status.'
    case 'conflict':
      return 'Needs review. A synced command has a payload conflict. Tap for details.'
    case 'rejected':
      return 'Failed. A command was rejected by the server. Tap for details.'
  }
}

/**
 * Re-price restored cart lines against the catalogue the server just returned.
 * A line whose chosen batch is gone keeps its quantity and falls back to FEFO
 * allocation, because the server rejects a batch id it can no longer honour.
 */
function repriceCartLines(lines: CartLine[], products: PosProduct[]): CartLine[] {
  const byId = new Map(products.map((product) => [product.id, product]))
  return lines.map((line) => {
    const product = byId.get(line.productId)
    if (!product) return line
    const batch = line.batchId
      ? (product.batches.find((b) => b.id === line.batchId) ?? null)
      : null
    return {
      ...line,
      unitPrice: batch ? (batch.sellingPrice ?? product.price) : product.price,
      batchId: batch?.id ?? null,
      batchLabel: batch?.batchNumber ?? null,
    }
  })
}

function sellableQuantityFromCatalogue(product: {
  sellableQuantity?: number
  batches?: Array<{ quantity: number }>
}): number {
  if (Number.isFinite(product.sellableQuantity)) return Number(product.sellableQuantity)
  return (product.batches ?? []).reduce((sum, batch) => sum + Math.max(0, batch.quantity), 0)
}

export default function PosScreen() {
  const { token, user } = useAuth()
  const router = useRouter()
  const params = useLocalSearchParams<{ barcode?: string }>()
  const insets = useSafeAreaInsets()
  const { height: windowHeight } = useWindowDimensions()
  const cartMaxHeight = Math.min(Math.round(windowHeight * 0.36), 300)
  const [query, setQuery] = useState('')
  const [debounced, setDebounced] = useState('')
  const [products, setProducts] = useState<PosProduct[]>([])
  const [loading, setLoading] = useState(true)
  const [cart, setCart] = useState<CartLine[]>([])
  const [payment, setPayment] = useState<(typeof PAYMENTS)[number]['key']>('CASH')
  const [autoPrintReceipt, setAutoPrintReceipt] = useState(false)
  // Matches the database default (true): until settings load, a sale must
  // still end in an explicit print decision rather than a silent skip.
  const [mandatoryReceiptPrint, setMandatoryReceiptPrint] = useState(true)
  // null until the settings have been read at least once; a sale is blocked
  // rather than quoted at zero tax when the device cannot know the rate.
  const [taxSettings, setTaxSettings] = useState<PharmacyTaxSettings | null>(null)
  const [cartDiscount, setCartDiscount] = useState('')
  const [discountReason, setDiscountReason] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [picker, setPicker] = useState<PickerSheet | null>(null)
  const [lastSale, setLastSale] = useState<SaleResult | null>(null)
  const [lowStock, setLowStock] = useState<LowStockItem[]>([])
  const idempotencyRef = useRef(newCommandId())
  const [draftRestored, setDraftRestored] = useState(false)
  const [syncBanner, setSyncBanner] = useState<
    null | 'pending' | 'offline' | 'conflict' | 'rejected' | 'stale'
  >(null)
  const [catalogueStale, setCatalogueStale] = useState(false)

  useEffect(() => {
    const t = setTimeout(() => setDebounced(query.trim()), 280)
    return () => clearTimeout(t)
  }, [query])

  // Restore unfinished cart draft (local only — never treated as a completed sale).
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const raw = await AsyncStorage.getItem(CART_DRAFT_KEY)
        if (!raw || cancelled) return
        const parsed = JSON.parse(raw) as {
          cart?: CartLine[]
          payment?: (typeof PAYMENTS)[number]['key']
          cartDiscount?: string
          discountReason?: string
          idempotencyKey?: string
        }
        if (Array.isArray(parsed.cart) && parsed.cart.length > 0) {
          setCart(parsed.cart)
          if (parsed.payment) setPayment(parsed.payment)
          if (parsed.cartDiscount) setCartDiscount(parsed.cartDiscount)
          if (parsed.discountReason) setDiscountReason(parsed.discountReason)
          if (parsed.idempotencyKey && /^[0-9a-f-]{36}$/i.test(parsed.idempotencyKey)) {
            idempotencyRef.current = parsed.idempotencyKey
          }
        }
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

  useEffect(() => {
    const code = typeof params.barcode === 'string' ? params.barcode.trim() : ''
    if (!code) return
    setQuery(code)
  }, [params.barcode])

  // Persist draft cart locally. Financial completion still requires server confirmation.
  useEffect(() => {
    if (!draftRestored) return
    const payload = {
      cart,
      payment,
      cartDiscount,
      discountReason,
      idempotencyKey: idempotencyRef.current,
      updatedAt: new Date().toISOString(),
    }
    if (cart.length === 0) {
      void AsyncStorage.removeItem(CART_DRAFT_KEY)
      return
    }
    void AsyncStorage.setItem(CART_DRAFT_KEY, JSON.stringify(payload))
  }, [cart, payment, cartDiscount, discountReason, draftRestored])

  // Load pharmacy preferences once: receipt printing, and the tax settings the
  // till needs to quote the same VAT the server will charge. The tax settings
  // are cached so an offline sale still quotes the right total.
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      if (!token) return
      try {
        const data = await apiRequest<{
          settings?: {
            autoPrintReceipt?: boolean
            mandatoryReceiptPrint?: boolean
            vatEnabled?: boolean
            vatRate?: number
            taxRate?: number
          }
        }>('/api/mobile/pharmacy/settings', { token })
        if (cancelled) return
        setAutoPrintReceipt(Boolean(data.settings?.autoPrintReceipt))
        setMandatoryReceiptPrint(data.settings?.mandatoryReceiptPrint !== false)
        const tax: PharmacyTaxSettings = {
          vatEnabled: Boolean(data.settings?.vatEnabled),
          vatRate: data.settings?.vatRate ?? null,
          taxRate: data.settings?.taxRate ?? null,
        }
        setTaxSettings(tax)
        void AsyncStorage.setItem(TAX_SETTINGS_KEY, JSON.stringify(tax))
      } catch {
        // Offline or transient failure: fall back to the last known settings
        // rather than quoting a total the server will change.
        const cached = await AsyncStorage.getItem(TAX_SETTINGS_KEY).catch(() => null)
        if (cancelled || !cached) return
        try {
          setTaxSettings(JSON.parse(cached) as PharmacyTaxSettings)
        } catch {
          /* corrupt cache: leave null and block the sale */
        }
      }
    })()
    return () => {
      cancelled = true
    }
  }, [token])

  const load = useCallback(async () => {
    if (!token || !user?.tenantId) {
      setLoading(false)
      return
    }
    try {
      const path =
        debounced.length > 0
          ? `/api/mobile/pharmacy/pos/products?q=${encodeURIComponent(debounced)}&limit=60`
          : '/api/mobile/pharmacy/pos/products?limit=60'
      const data = await apiRequest<{ products: PosProduct[] }>(path, { token })
      setProducts(data.products)
      setCatalogueStale(false)
      if (debounced.length === 0) {
        await cachePharmacyCatalogue(user.tenantId, data.products)
      }
      const remaining = await getPharmacySellableMap(user.tenantId)
      setProducts((current) =>
        current.map((product) => ({
          ...product,
          quantity: remaining.get(product.id) ?? sellableQuantityFromCatalogue(product),
        })),
      )
      const status = await getPharmacySyncStatus(user.tenantId)
      if (status.conflicts > 0) setSyncBanner('conflict')
      else if (status.rejected > 0) setSyncBanner('rejected')
      else if (status.pending > 0) setSyncBanner('pending')
      else setSyncBanner(null)
    } catch {
      const cached = await loadCachedPharmacyCatalogue(user.tenantId)
      if (cached) {
        const remaining = await getPharmacySellableMap(user.tenantId)
        setProducts(
          cached.products
            .filter((product) => {
              if (!debounced) return true
              const q = debounced.toLowerCase()
              return (
                product.name.toLowerCase().includes(q) ||
                String(product.sku ?? '').toLowerCase().includes(q) ||
                String(product.barcode ?? '').toLowerCase().includes(q)
              )
            })
            .map((product) => ({
              ...product,
              quantity: remaining.get(product.id) ?? sellableQuantityFromCatalogue(product),
              unit: product.unit ?? 'unit',
              requiresPrescription: product.requiresPrescription ?? false,
              packages: product.packages ?? [],
            })),
        )
        setCatalogueStale(cached.stale)
        setSyncBanner(cached.stale ? 'stale' : 'offline')
      } else {
        setProducts([])
        setSyncBanner('stale')
        setCatalogueStale(true)
      }
    } finally {
      setLoading(false)
    }
  }, [token, user?.tenantId, debounced])

  useEffect(() => {
    setLoading(true)
    load()
  }, [load])

  // `persistSale` refuses to record a sale without a stock snapshot under four
  // hours old, and `load` only refreshed it while the search box was empty — so
  // a cashier searching for products could reach a point where every sale was
  // rejected as "cached stock is stale" while the phone was still online.
  const refreshStockSnapshot = useCallback(async (): Promise<PosProduct[] | null> => {
    if (!token || !user?.tenantId) return null
    try {
      const data = await apiRequest<{ products: PosProduct[] }>(
        '/api/mobile/pharmacy/pos/products?limit=150',
        { token },
      )
      await cachePharmacyCatalogue(user.tenantId, data.products)
      return data.products
    } catch {
      return null
    }
  }, [token, user?.tenantId])

  // Keep each cart line's VAT classification in step with the catalogue. This
  // repairs a draft restored from a build that did not record it, and picks up
  // a reclassification without the cashier re-adding the product.
  useEffect(() => {
    if (products.length === 0) return
    const categoryOf = new Map(products.map((product) => [product.id, product.vatCategory ?? null]))
    setCart((prev) => {
      let changed = false
      const next = prev.map((line) => {
        const category = categoryOf.get(line.productId)
        if (!category || category === line.vatCategory) return line
        changed = true
        return { ...line, vatCategory: category }
      })
      return changed ? next : prev
    })
  }, [products])

  const subtotal = useMemo(
    () => cart.reduce((s, line) => s + line.unitPrice * line.quantity, 0),
    [cart],
  )
  const discountN = Math.max(0, Number(cartDiscount) || 0)
  // Per-line net after the cart discount, allocated in proportion to value so
  // the taxable base does not depend on which line the cashier added first.
  const lineNets = useMemo(
    () => cart.map((line) => roundMoney(line.unitPrice * line.quantity)),
    [cart],
  )
  const discountAllocation = useMemo(
    () => allocateCartDiscount(lineNets, discountN),
    [lineNets, discountN],
  )
  const total = Math.max(0, roundMoney(subtotal - discountN))
  // The same function the sale route and `complete_pharmacy_sale` use, so the
  // figure quoted here is the figure the server stores.
  const saleTax = useMemo(
    () =>
      computePharmacySaleTax(
        taxSettings,
        cart.map((line, idx) => ({
          netAmount: roundMoney((lineNets[idx] ?? 0) - (discountAllocation[idx] ?? 0)),
          vatCategory: line.vatCategory,
        })),
      ),
    [taxSettings, cart, lineNets, discountAllocation],
  )
  const taxAmount = saleTax.ok ? saleTax.taxAmount : 0
  const grandTotal = roundMoney(total + taxAmount)

  const pushLine = (line: Omit<CartLine, 'key' | 'discountAmount'>) => {
    setLastSale(null)
    setCart((prev) => [
      ...prev,
      {
        ...line,
        key: `${line.productId}-${line.batchId ?? 'nb'}-${line.packageLabel ?? 'u'}-${Date.now()}`,
        discountAmount: 0,
      },
    ])
  }

  const chooseBatchThenAdd = (
    p: PosProduct,
    opts: { units: number; packageLabel: string | null },
  ) => {
    const batches = p.batches
    const finish = (batchId: string | null, batchLabel: string | null) => {
      const selectedBatch = batches.find((batch) => batch.id === batchId)
      pushLine({
        productId: p.id,
        name: p.name,
        unitPrice: selectedBatch?.sellingPrice ?? p.price,
        quantity: opts.units,
        batchId,
        batchLabel,
        packageLabel: opts.packageLabel,
        unitsPerPackage: opts.packageLabel ? opts.units : 1,
        vatCategory: p.vatCategory ?? null,
      })
    }
    if (batches.length <= 1) {
      finish(batches[0]?.id ?? null, batches[0] ? `${batches[0].batchNumber}` : null)
      return
    }
    // Android's Alert keeps only three buttons (buttons.slice(0, 3)), which
    // dropped Cancel and every batch past the third. The sheet keeps them all.
    setPicker({
      title: 'Pick FEFO batch',
      message: 'Batches are sorted earliest expiry first.',
      options: batches.map((b) => ({
        label: b.batchNumber,
        detail: `${b.quantity} @ UGX ${(b.sellingPrice ?? p.price).toLocaleString()} · exp ${String(b.expiryDate).slice(0, 10)}`,
        onPress: () => finish(b.id, b.batchNumber),
      })),
    })
  }

  const addProduct = (p: PosProduct) => {
    const pkgs = p.packages.filter((x) => x.unitsPerPackage > 0 && x.price >= 0)
    if (pkgs.length === 0) {
      chooseBatchThenAdd(p, { units: 1, packageLabel: null })
      return
    }
    const fefoUnitPrice = p.batches[0]?.sellingPrice ?? p.price
    // Out of stock is not a blocker: the sale takes the balance negative.
    setPicker({
      title: p.quantity <= 0 ? 'Sell below zero stock' : 'Sell as',
      message: p.name,
      options: [
        {
          label: 'Unit',
          detail: `from UGX ${fefoUnitPrice.toLocaleString()}`,
          onPress: () => chooseBatchThenAdd(p, { units: 1, packageLabel: null }),
        },
        ...pkgs.map((pkg) => ({
          label: `${pkg.name} (${pkg.unitsPerPackage})`,
          detail: `from UGX ${(fefoUnitPrice * pkg.unitsPerPackage).toLocaleString()}`,
          onPress: () =>
            chooseBatchThenAdd(p, {
              units: pkg.unitsPerPackage,
              packageLabel: pkg.name,
            }),
        })),
      ],
    })
  }

  const bumpQty = (key: string, delta: number) => {
    setCart((prev) =>
      prev
        .map((l) => {
          if (l.key !== key) return l
          const step = l.packageLabel ? l.unitsPerPackage : 1
          return { ...l, quantity: l.quantity + delta * step }
        })
        .filter((l) => l.quantity > 0),
    )
  }

  const clearCart = () => {
    setCart([])
    setCartDiscount('')
    setDiscountReason('')
    setSyncBanner(null)
    idempotencyRef.current = newCommandId()
    void AsyncStorage.removeItem(CART_DRAFT_KEY)
  }

  const completeSale = async () => {
    if (!token || !user?.id || !user.tenantId || cart.length === 0 || submitting) return
    if (discountN > 0 && !discountReason.trim()) {
      Alert.alert('Discount reason', 'Enter a reason when applying a cart discount.')
      return
    }
    if (!taxSettings) {
      Alert.alert(
        'Tax settings unavailable',
        "Reconnect once so the till can read this pharmacy's tax settings. Selling without them could quote a total the server will not accept.",
      )
      return
    }
    if (!saleTax.ok) {
      Alert.alert('Tax settings invalid', saleTax.detail)
      return
    }
    setSubmitting(true)
    try {
      // The offline guard needs a snapshot under four hours old. If this phone
      // still has a connection, refresh it here rather than turning the cashier
      // away; only a failed refresh means the sale really has to wait.
      const cached = await loadCachedPharmacyCatalogue(user.tenantId)
      if (catalogueStale || !cached || cached.stale) {
        const refreshed = await refreshStockSnapshot()
        if (!refreshed) {
          setSyncBanner('stale')
          setCatalogueStale(true)
          Alert.alert(
            'Stock cache stale',
            'Reconnect and refresh inventory before selling. Offline sales are blocked when the snapshot is older than 4 hours.',
          )
          return
        }
        setCatalogueStale(false)
        setSyncBanner(null)
      }
      const items = cart.map((l, idx) => ({
        productId: l.productId,
        quantity: l.quantity,
        unitPrice: l.unitPrice,
        discountAmount: discountAllocation[idx] ?? 0,
        discountReason: (discountAllocation[idx] ?? 0) > 0 ? discountReason.trim() : undefined,
        batchId: l.batchId,
      }))
      const soldCart = cart
      const soldDiscount = cartDiscount
      const soldReason = discountReason
      const command = await commitPharmacySale({
        tenantId: user.tenantId,
        actorId: user.id,
        commandId: idempotencyRef.current,
        payload: {
          paymentMethod: payment,
          paymentStatus: payment === 'CASH' ? 'captured' : 'offline_unverified',
          taxAmount,
          items,
        },
      })
      setCart([])
      setCartDiscount('')
      setDiscountReason('')
      setSyncBanner('pending')
      idempotencyRef.current = newCommandId()
      void AsyncStorage.removeItem(CART_DRAFT_KEY)
      setLastSale({
        receipt_number: 'PENDING SYNC',
        status: 'pending',
        total_amount: grandTotal,
      })

      const summary = await syncPharmacySales(user.tenantId, token)
      const item = summary.items.find((entry) => entry.commandId === command.commandId)
      const result = item?.response as
        | { sale?: SaleResult; lowStock?: LowStockItem[] }
        | undefined
      if (item?.outcome === 'applied' || item?.outcome === 'replay') {
        const sale = result?.sale ?? {}
        setLastSale(sale)
        setLowStock(result?.lowStock ?? [])
        setSyncBanner(null)
        load()
        const saleId = sale.sale_id
        // A mandatory print opens the receipt with its print decision bar;
        // that screen keeps a failure exit ("printer unavailable") after the
        // print attempt, so auto-opening the print sheet cannot strand the
        // cashier the way it would on the web till.
        if (saleId && (mandatoryReceiptPrint || autoPrintReceipt)) {
          router.push(
            `/receipt/${saleId}?autoprint=1${mandatoryReceiptPrint ? '&mandatory=1' : ''}` as never,
          )
        } else if ((result?.lowStock ?? []).length > 0) {
          const names = result!.lowStock!.slice(0, 3).map((p) => p.name).join(', ')
          Alert.alert(
            'Sale synced',
            `${sale.receipt_number ?? 'Receipt'} saved.\nNow at/below reorder: ${names}`,
          )
        }
        return
      }
      if (item?.outcome === 'conflict') {
        setSyncBanner('conflict')
        Alert.alert(
          'Needs review',
          'This command id was reused with different content. The original sale was kept. Open Sync status.',
        )
        return
      }
      if (item?.outcome === 'rejected') {
        // The server refused it and took no stock, so give the cart back
        // instead of making the cashier ring the whole sale up again. A price
        // or allocation change rejects the same prices again, so re-price the
        // lines from the catalogue before handing them back.
        const fresh = await refreshStockSnapshot()
        setCart(fresh ? repriceCartLines(soldCart, fresh) : soldCart)
        setCartDiscount(soldDiscount)
        setDiscountReason(soldReason)
        setLastSale(null)
        setSyncBanner('rejected')
        Alert.alert(
          'Sale rejected',
          `${item.error ?? 'The server refused this sale. Stock was not taken.'}\nThe items are back in the cart${fresh ? ' at current prices' : ''}.`,
        )
        return
      }
      Alert.alert(
        'Pending sync',
        payment === 'CASH'
          ? 'Sale is saved on this device. Receipt is pending until the command syncs. Cash recorded locally.'
          : 'Sale is saved on this device. Card/mobile-money is unverified until the command syncs. Do not treat this as provider success.',
      )
    } catch (err) {
      if (err instanceof OfflineStockError) {
        Alert.alert(
          err.code === 'OFFLINE_STOCK_STALE' ? 'Stock cache stale' : 'Insufficient stock',
          err.message,
        )
        if (err.code === 'OFFLINE_STOCK_STALE') setSyncBanner('stale')
        return
      }
      if (err instanceof SyncPayloadConflictError) {
        setSyncBanner('conflict')
        Alert.alert(
          'Needs review',
          'The same command id was used with a different cart. Human review is required. Open Sync status.',
        )
        return
      }
      const message =
        err instanceof ApiError
          ? err.message
          : err instanceof Error
            ? err.message
            : 'Sale failed'
      Alert.alert('Sale failed', message)
    } finally {
      setSubmitting(false)
    }
  }

  const confirmSale = () => {
    if (cart.length === 0) return
    Alert.alert(
      'Complete sale?',
      `UGX ${grandTotal.toLocaleString()} · ${PAYMENTS.find((p) => p.key === payment)?.label}${
        discountN > 0 ? ` · discount ${discountN.toLocaleString()}` : ''
      }`,
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Complete', onPress: () => void completeSale() },
      ],
    )
  }

  return (
    <KeyboardAvoidingView
      style={[styles.root, { paddingTop: insets.top }]}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <View style={styles.header}>
        <Pressable
          onPress={() => router.back()}
          hitSlop={12}
          style={styles.backBtn}
          accessibilityRole="button"
          accessibilityLabel="Go back"
        >
          <Ionicons name="chevron-back" size={22} color={colors.primary} />
        </Pressable>
        <Text style={styles.title} accessibilityRole="header">
          New sale
        </Text>
        <View style={styles.headerActions}>
          <Pressable
            onPress={() => router.push('/till' as never)}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel="Open till session"
          >
            <Ionicons name="wallet-outline" size={22} color={colors.primary} />
          </Pressable>
          <Pressable
            onPress={() => router.push('/barcode-scan?returnTo=pos' as never)}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel="Scan barcode"
          >
            <Ionicons name="barcode-outline" size={22} color={colors.primary} />
          </Pressable>
          {cart.length > 0 ? (
            <Pressable
              onPress={clearCart}
              hitSlop={8}
              accessibilityRole="button"
              accessibilityLabel="Clear cart"
            >
              <Text style={styles.clear}>Clear</Text>
            </Pressable>
          ) : (
            <View style={{ width: 48 }} />
          )}
        </View>
      </View>

      {syncBanner ? (
        <Pressable
          style={[
            styles.pendingBanner,
            syncBanner === 'conflict' || syncBanner === 'rejected' || syncBanner === 'stale'
              ? styles.reviewBanner
              : null,
          ]}
          onPress={() => router.push('/sync-status' as never)}
          accessibilityRole="button"
          accessibilityLabel={syncBannerLabel(syncBanner)}
        >
          <Text style={styles.pendingText}>{syncBannerLabel(syncBanner)}</Text>
        </Pressable>
      ) : null}

      {lastSale ? (
        <View style={styles.receiptCard}>
          <View style={styles.receiptBanner}>
            <Ionicons name="checkmark-circle" size={18} color={TONE_COLORS.green} />
            <Text style={styles.receiptText}>
              {lastSale.receipt_number ?? 'Sale'} · UGX{' '}
              {Number(lastSale.total_amount ?? 0).toLocaleString()}
            </Text>
          </View>
          {lowStock.length > 0 ? (
            <Text style={styles.lowStockNote}>
              Low after sale: {lowStock.map((p) => `${p.name} (${p.quantity})`).join(', ')}
            </Text>
          ) : null}
          <View style={styles.receiptActions}>
            {lastSale.sale_id ? (
              <Pressable
                style={styles.receiptAction}
                onPress={() => router.push(`/receipt/${lastSale.sale_id}` as never)}
              >
                <Text style={styles.receiptActionText}>View receipt</Text>
              </Pressable>
            ) : null}
            <Pressable style={styles.receiptAction} onPress={() => setLastSale(null)}>
              <Text style={styles.receiptActionText}>New sale</Text>
            </Pressable>
            <Pressable
              style={styles.receiptAction}
              onPress={() => router.push('/(main)/sales' as never)}
            >
              <Text style={styles.receiptActionText}>Sales history</Text>
            </Pressable>
            <Pressable
              style={styles.receiptAction}
              onPress={() => router.push('/tools' as never)}
            >
              <Text style={styles.receiptActionText}>Tools</Text>
            </Pressable>
          </View>
        </View>
      ) : null}

      <View style={styles.searchWrap}>
        <Ionicons name="search" size={16} color={colors.textMuted} />
        <TextInput
          style={styles.search}
          placeholder="Search name, SKU, barcode"
          placeholderTextColor={colors.textMuted}
          value={query}
          onChangeText={setQuery}
          autoCorrect={false}
          autoCapitalize="none"
          accessibilityLabel="Product search"
          accessibilityHint="Search by name, SKU, or barcode"
        />
      </View>

      <View style={styles.listArea}>
        {loading ? (
          <LoadingBlock message="Loading products…" />
        ) : (
          <FlatList
            data={products}
            keyExtractor={(item) => item.id}
            keyboardShouldPersistTaps="handled"
            contentContainerStyle={styles.listContent}
            style={styles.flex}
            ListEmptyComponent={
              <EmptyState
                title="No products"
                body="Try another search, or add stock from Inventory."
                icon="cube"
              />
            }
            renderItem={({ item }) => (
              <Pressable
                style={({ pressed }) => [styles.productRow, pressed && styles.pressed]}
                onPress={() => addProduct(item)}
                accessibilityRole="button"
                accessibilityLabel={`Add ${item.name}, quantity ${item.quantity}, ${item.price} shillings`}
              >
                <View style={styles.productCopy}>
                  <Text style={styles.productName} numberOfLines={2}>
                    {item.name}
                  </Text>
                  <Text style={styles.productMeta}>
                    Qty {item.quantity}
                    {item.sku ? ` · ${item.sku}` : ''}
                  </Text>
                </View>
                <Text style={styles.productPrice}>{item.price.toLocaleString()}</Text>
              </Pressable>
            )}
          />
        )}
      </View>

      <View
        style={[
          styles.cartPanel,
          {
            maxHeight: cart.length > 0 ? cartMaxHeight : undefined,
            paddingBottom: Math.max(insets.bottom, spacing.md),
          },
        ]}
      >
        {cart.length === 0 ? (
          <Text style={styles.cartEmpty}>Tap a product to add it to the cart</Text>
        ) : (
          <>
            <ScrollView
              style={styles.cartScroll}
              nestedScrollEnabled
              keyboardShouldPersistTaps="handled"
            >
              {cart.map((line) => (
                <View key={line.key} style={styles.cartLine}>
                  <View style={styles.cartCopy}>
                    <Text style={styles.cartName} numberOfLines={1}>
                      {line.name}
                    </Text>
                    <Text style={styles.cartMeta}>
                      UGX {line.unitPrice.toLocaleString()} × {line.quantity}
                      {line.packageLabel ? ` · ${line.packageLabel}` : ''}
                      {line.batchLabel ? ` · ${line.batchLabel}` : ''}
                    </Text>
                  </View>
                  <View style={styles.qtyControls}>
                    <Pressable
                      onPress={() => bumpQty(line.key, -1)}
                      style={styles.qtyBtn}
                      accessibilityRole="button"
                      accessibilityLabel={`Decrease ${line.name}`}
                    >
                      <Ionicons name="remove" size={16} color={colors.text} />
                    </Pressable>
                    <Text style={styles.qtyValue} accessibilityLabel={`Quantity ${line.quantity}`}>
                      {line.quantity}
                    </Text>
                    <Pressable
                      onPress={() => bumpQty(line.key, 1)}
                      style={styles.qtyBtn}
                      accessibilityRole="button"
                      accessibilityLabel={`Increase ${line.name}`}
                    >
                      <Ionicons name="add" size={16} color={colors.text} />
                    </Pressable>
                  </View>
                </View>
              ))}
            </ScrollView>

            <View style={styles.discountRow}>
              <TextInput
                style={styles.discountInput}
                placeholder="Discount UGX"
                placeholderTextColor={colors.textMuted}
                keyboardType="number-pad"
                value={cartDiscount}
                onChangeText={setCartDiscount}
              />
              <TextInput
                style={[styles.discountInput, styles.discountReason]}
                placeholder="Reason (if discount)"
                placeholderTextColor={colors.textMuted}
                value={discountReason}
                onChangeText={setDiscountReason}
              />
            </View>

            <View style={styles.payRow}>
              {PAYMENTS.map((p) => (
                <Pressable
                  key={p.key}
                  onPress={() => setPayment(p.key)}
                  style={[styles.payChip, payment === p.key && styles.payChipOn]}
                  accessibilityRole="radio"
                  accessibilityState={{ selected: payment === p.key }}
                  accessibilityLabel={`Payment method ${p.label}`}
                >
                  <Text
                    style={[styles.payChipText, payment === p.key && styles.payChipTextOn]}
                    numberOfLines={1}
                  >
                    {p.label}
                  </Text>
                </Pressable>
              ))}
            </View>

            {taxAmount > 0 ? (
              <View style={styles.taxRow}>
                <Text style={styles.taxLabel}>
                  VAT{saleTax.ok && saleTax.ratePct > 0 ? ` (${saleTax.ratePct}%)` : ''}
                  {saleTax.ok && saleTax.taxableBase < total ? ' on taxable items' : ''}
                </Text>
                <Text style={styles.taxValue}>UGX {taxAmount.toLocaleString()}</Text>
              </View>
            ) : null}

            <View style={styles.totalRow}>
              <Text style={styles.totalLabel}>
                {discountN > 0 ? `Total (−${discountN.toLocaleString()})` : 'Total'}
              </Text>
              <Text style={styles.totalValue}>UGX {grandTotal.toLocaleString()}</Text>
            </View>

            <Button
              label="Complete sale"
              onPress={confirmSale}
              loading={submitting}
              disabled={cart.length === 0}
            />
          </>
        )}
      </View>

      <Modal
        visible={picker !== null}
        transparent
        animationType="fade"
        onRequestClose={() => setPicker(null)}
      >
        <Pressable
          style={styles.sheetBackdrop}
          onPress={() => setPicker(null)}
          accessibilityRole="button"
          accessibilityLabel="Dismiss"
        >
          <Pressable style={styles.sheet} onPress={(e) => e.stopPropagation()}>
            <Text style={styles.sheetTitle} accessibilityRole="header">
              {picker?.title}
            </Text>
            {picker?.message ? <Text style={styles.sheetMessage}>{picker.message}</Text> : null}
            <ScrollView style={styles.sheetList} keyboardShouldPersistTaps="handled">
              {picker?.options.map((opt, i) => (
                <Pressable
                  key={`${opt.label}-${i}`}
                  style={styles.sheetOption}
                  onPress={() => {
                    const run = opt.onPress
                    setPicker(null)
                    run()
                  }}
                  accessibilityRole="button"
                  accessibilityLabel={opt.detail ? `${opt.label}, ${opt.detail}` : opt.label}
                >
                  <Text style={styles.sheetOptionLabel}>{opt.label}</Text>
                  {opt.detail ? <Text style={styles.sheetOptionDetail}>{opt.detail}</Text> : null}
                </Pressable>
              ))}
            </ScrollView>
            <Pressable
              style={styles.sheetCancel}
              onPress={() => setPicker(null)}
              accessibilityRole="button"
              accessibilityLabel="Cancel"
            >
              <Text style={styles.sheetCancelText}>Cancel</Text>
            </Pressable>
          </Pressable>
        </Pressable>
      </Modal>
    </KeyboardAvoidingView>
  )
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
  },
  backBtn: { width: 48 },
  headerActions: { flexDirection: 'row', alignItems: 'center', gap: 8, minWidth: 88, justifyContent: 'flex-end' },
  title: {
    ...typography.h3,
    color: colors.text,
    fontFamily: 'DMSans_700Bold',
  },
  clear: {
    ...typography.bodyMedium,
    color: colors.danger,
    fontFamily: 'DMSans_500Medium',
    width: 48,
    textAlign: 'right',
  },
  pendingBanner: {
    marginHorizontal: spacing.lg,
    marginBottom: spacing.sm,
    padding: spacing.md,
    borderRadius: radii.md,
    backgroundColor: colors.warningSoft,
    borderWidth: 1,
    borderColor: colors.warning,
  },
  pendingText: {
    ...typography.caption,
    color: colors.text,
    fontFamily: 'DMSans_500Medium',
  },
  reviewBanner: {
    backgroundColor: colors.dangerSoft,
    borderColor: colors.danger,
  },
  receiptBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  receiptCard: {
    marginHorizontal: spacing.lg,
    marginBottom: spacing.sm,
    padding: spacing.md,
    borderRadius: radii.md,
    backgroundColor: `${TONE_COLORS.green}14`,
    borderWidth: 1,
    borderColor: `${TONE_COLORS.green}33`,
    gap: spacing.sm,
  },
  receiptText: {
    ...typography.bodySm,
    color: colors.text,
    fontFamily: 'DMSans_500Medium',
    flex: 1,
  },
  lowStockNote: {
    ...typography.caption,
    color: colors.warning,
    fontFamily: 'DMSans_400Regular',
  },
  receiptActions: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  receiptAction: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: radii.sm,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
  },
  receiptActionText: {
    ...typography.caption,
    color: colors.primary,
    fontFamily: 'DMSans_500Medium',
  },
  searchWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    marginHorizontal: spacing.lg,
    marginBottom: spacing.sm,
    paddingHorizontal: spacing.md,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.bgElevated,
  },
  search: {
    flex: 1,
    ...typography.body,
    color: colors.text,
    paddingVertical: 12,
    fontFamily: 'DMSans_400Regular',
  },
  listArea: { flex: 1, minHeight: 120 },
  flex: { flex: 1 },
  listContent: { paddingHorizontal: spacing.lg, paddingBottom: spacing.lg, flexGrow: 1 },
  productRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingVertical: spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: colors.borderSubtle,
  },
  pressed: { opacity: 0.7 },
  productCopy: { flex: 1, minWidth: 0 },
  productName: {
    ...typography.bodyMedium,
    color: colors.text,
    fontFamily: 'DMSans_500Medium',
  },
  productMeta: {
    ...typography.caption,
    color: colors.textMuted,
    fontFamily: 'DMSans_400Regular',
    marginTop: 2,
  },
  productPrice: {
    ...typography.mono,
    color: colors.text,
    fontSize: 13,
  },
  cartPanel: {
    borderTopWidth: 1,
    borderTopColor: colors.border,
    backgroundColor: colors.surface,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
  },
  cartScroll: { flexGrow: 0, maxHeight: 120 },
  cartEmpty: {
    ...typography.bodySm,
    color: colors.textMuted,
    fontFamily: 'DMSans_400Regular',
    textAlign: 'center',
    paddingVertical: spacing.md,
  },
  cartLine: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    marginBottom: spacing.sm,
  },
  cartCopy: { flex: 1, minWidth: 0 },
  cartName: {
    ...typography.bodySm,
    color: colors.text,
    fontFamily: 'DMSans_500Medium',
  },
  cartMeta: {
    ...typography.caption,
    color: colors.textMuted,
    fontFamily: 'DMSans_400Regular',
  },
  discountRow: {
    flexDirection: 'row',
    gap: spacing.sm,
    marginBottom: spacing.sm,
  },
  discountInput: {
    flex: 1,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    color: colors.text,
    ...typography.bodySm,
    backgroundColor: colors.bgElevated,
  },
  discountReason: { flex: 1.4 },
  qtyControls: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  qtyBtn: {
    width: 32,
    height: 32,
    borderRadius: radii.sm,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.bgElevated,
  },
  qtyValue: {
    ...typography.mono,
    minWidth: 22,
    textAlign: 'center',
    color: colors.text,
  },
  payRow: { flexDirection: 'row', gap: spacing.sm, marginVertical: spacing.sm },
  payChip: {
    flex: 1,
    minWidth: 0,
    paddingVertical: 8,
    paddingHorizontal: 4,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: 'center',
  },
  payChipOn: {
    borderColor: colors.primary,
    backgroundColor: `${colors.primary}18`,
  },
  payChipText: {
    ...typography.caption,
    color: colors.textSecondary,
    fontFamily: 'DMSans_500Medium',
    fontSize: 11,
  },
  payChipTextOn: { color: colors.primary },
  taxRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: spacing.xs,
    gap: spacing.sm,
  },
  taxLabel: {
    ...typography.caption,
    color: colors.textSecondary,
    fontFamily: 'DMSans_500Medium',
  },
  taxValue: {
    ...typography.mono,
    fontSize: 12,
    color: colors.textSecondary,
    fontFamily: 'IBMPlexMono_500Medium',
    flexShrink: 1,
  },
  totalRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: spacing.md,
    gap: spacing.sm,
  },
  totalLabel: {
    ...typography.bodyMedium,
    color: colors.textSecondary,
    fontFamily: 'DMSans_500Medium',
  },
  totalValue: {
    ...typography.mono,
    fontSize: 16,
    color: colors.text,
    fontFamily: 'IBMPlexMono_500Medium',
    flexShrink: 1,
  },
  sheetBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.55)',
    justifyContent: 'flex-end',
  },
  sheet: {
    backgroundColor: colors.surface,
    borderTopLeftRadius: radii.lg,
    borderTopRightRadius: radii.lg,
    paddingHorizontal: spacing.md,
    paddingTop: spacing.md,
    paddingBottom: spacing.lg,
    maxHeight: '80%',
  },
  sheetTitle: {
    ...typography.bodyMedium,
    fontSize: 17,
    color: colors.text,
    fontFamily: 'DMSans_600SemiBold',
  },
  sheetMessage: {
    ...typography.caption,
    color: colors.textSecondary,
    marginTop: 2,
  },
  sheetList: { marginTop: spacing.sm },
  sheetOption: {
    paddingVertical: spacing.sm,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
  },
  sheetOptionLabel: {
    ...typography.bodyMedium,
    color: colors.text,
    fontFamily: 'DMSans_500Medium',
  },
  sheetOptionDetail: {
    ...typography.caption,
    color: colors.textSecondary,
    fontFamily: 'IBMPlexMono_400Regular',
    marginTop: 1,
  },
  sheetCancel: {
    marginTop: spacing.md,
    paddingVertical: spacing.sm,
    alignItems: 'center',
    borderRadius: radii.md,
    backgroundColor: colors.bgSubtle,
  },
  sheetCancelText: {
    ...typography.bodyMedium,
    color: colors.textSecondary,
    fontFamily: 'DMSans_500Medium',
  },
})
