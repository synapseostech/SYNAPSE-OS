import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ActivityIndicator,
  Alert,
  AppState,
  FlatList,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native'
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { Ionicons } from '@expo/vector-icons'
import { CountSheet, type CountLineChange } from '@/components/stock-take/CountSheet'
import { ScannerModal } from '@/components/stock-take/ScannerModal'
import { useAuth } from '@/lib/auth'
import { ApiError } from '@/lib/api'
import { changeStockTake } from '@/lib/stock-take-api'
import {
  flushCounts,
  listCountEntries,
  loadCountSheet,
  saveCount,
  type Scope,
} from '@/lib/stock-take-store'
import type { CachedSheet } from '@/lib/stock-take-store-core'
import {
  countProgress,
  countedTotal,
  describeSyncState,
  filterItems,
  findByScan,
  searchItems,
  type ItemFilter,
  type LocalCountEntry,
  type StockTakeItem,
} from '@/lib/stock-take'
import { radii, spacing, typography, useTheme } from '@/lib/theme'

const SYNC_INTERVAL_MS = 20_000

export default function CountScreen() {
  const { id } = useLocalSearchParams<{ id: string }>()
  const { token, user } = useAuth()
  const { colors } = useTheme()
  const router = useRouter()
  const insets = useSafeAreaInsets()
  const scope: Scope | null = useMemo(
    () => (user ? { tenantId: user.tenantId, userId: user.id } : null),
    [user],
  )

  const [sheet, setSheet] = useState<CachedSheet | null>(null)
  const [entries, setEntries] = useState<LocalCountEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [online, setOnline] = useState<boolean | null>(null)
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<ItemFilter>('todo')
  const [selected, setSelected] = useState<StockTakeItem | null>(null)
  const [fromScan, setFromScan] = useState(false)
  const [scanning, setScanning] = useState(false)
  const [busy, setBusy] = useState(false)
  const [lastSaved, setLastSaved] = useState<string | null>(null)
  const mounted = useRef(true)

  const refreshEntries = useCallback(async () => {
    if (!scope || !id) return
    const list = await listCountEntries(scope, id)
    if (mounted.current) setEntries(list)
  }, [scope, id])

  const sync = useCallback(async () => {
    if (!token || !scope || !id) return
    const result = await flushCounts(token, scope, id)
    if (!mounted.current) return
    setOnline(!result.error || result.closed)
    if (result.closed) {
      setSheet((s) => (s ? { ...s, stockTake: { ...s.stockTake, status: 'review' } } : s))
    }
    await refreshEntries()
  }, [token, scope, id, refreshEntries])

  const load = useCallback(
    async (refresh: boolean) => {
      if (!token || !scope || !id) return
      const result = await loadCountSheet(token, scope, id, { refresh })
      if (!mounted.current) return
      if (!result.sheet) {
        Alert.alert('Count not found', result.error ?? 'This count is no longer available.')
        router.back()
        return
      }
      setSheet(result.sheet)
      setOnline(!result.offline)
      await refreshEntries()
      setLoading(false)
    },
    [token, scope, id, refreshEntries, router],
  )

  useEffect(() => {
    mounted.current = true
    // Always try for a fresh sheet first; the saved one is the fallback.
    void load(true).then(() => sync())
    return () => {
      mounted.current = false
    }
  }, [load, sync])

  useFocusEffect(
    useCallback(() => {
      const timer = setInterval(() => void sync(), SYNC_INTERVAL_MS)
      const sub = AppState.addEventListener('change', (state) => {
        if (state === 'active') void sync()
      })
      return () => {
        clearInterval(timer)
        sub.remove()
      }
    }, [sync]),
  )

  const items = sheet?.items ?? []
  const stockTake = sheet?.stockTake
  const readOnly = stockTake?.status !== 'counting'
  const progress = countProgress(items, entries)
  const visible = useMemo(() => {
    const base = query.trim() ? searchItems(items, query, 200) : filterItems(items, entries, filter)
    return query.trim() ? base : base.slice(0, 400)
  }, [items, entries, filter, query])

  const onScanned = (code: string) => {
    const hits = findByScan(items, code)
    if (hits.length === 1) {
      setScanning(false)
      setFromScan(true)
      setSelected(hits[0])
      return
    }
    setScanning(false)
    if (hits.length > 1) {
      setQuery(code)
      Alert.alert('Several items share this code', 'Pick the right one from the list.')
      return
    }
    Alert.alert(
      'Not on this count sheet',
      `Nothing in this count has the code ${code}. Search by name, or add the product in Stock first.`,
      [
        { text: 'Search', onPress: () => setQuery('') },
        { text: 'Scan again', onPress: () => setScanning(true) },
      ],
    )
  }

  const onSave = async (changes: CountLineChange[], scanNext: boolean) => {
    const item = selected
    if (!item || !scope || !id) return
    try {
      for (const change of changes) {
        await saveCount(scope, {
          stockTakeId: id,
          productId: item.id,
          batchId: change.batchId,
          newBatchNumber: change.newBatchNumber,
          newExpiryDate: change.newExpiryDate,
          countedQty: change.countedQty,
        })
      }
    } catch {
      Alert.alert('Not saved', 'The count could not be saved on this phone. Try again.')
      return
    }
    setSelected(null)
    setLastSaved(item.name)
    await refreshEntries()
    void sync()
    if (scanNext) setScanning(true)
  }

  const closeCounting = () => {
    if (!token || !id) return
    Alert.alert(
      'Close counting?',
      'Phones stop sending counts. Make sure everyone has synced. You can reopen it from the review.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Close and review',
          onPress: async () => {
            setBusy(true)
            try {
              await sync()
              await changeStockTake(token, id, 'close')
              router.replace(`/stock-take/${id}/review` as never)
            } catch (error) {
              Alert.alert('Could not close', error instanceof ApiError ? error.message : 'Try again.')
            } finally {
              setBusy(false)
            }
          },
        },
      ],
    )
  }

  if (loading || !stockTake) {
    return (
      <View style={[styles.center, { backgroundColor: colors.bg }]}>
        <ActivityIndicator color={colors.primary} />
        <Text style={[styles.small, { color: colors.textMuted, marginTop: spacing.md }]}>
          Downloading the count sheet…
        </Text>
      </View>
    )
  }

  const filters: Array<{ value: ItemFilter; label: string }> = [
    { value: 'todo', label: `To count ${progress.total - progress.counted}` },
    { value: 'done', label: `Counted ${progress.counted}` },
    ...(stockTake.showBook ? [{ value: 'negative' as const, label: 'Below zero' }] : []),
    { value: 'all', label: 'All' },
  ]

  return (
    <View style={[styles.root, { backgroundColor: colors.bg, paddingTop: insets.top }]}>
      <View style={styles.header}>
        <Pressable onPress={() => router.back()} hitSlop={12} accessibilityRole="button" accessibilityLabel="Go back">
          <Ionicons name="chevron-back" size={22} color={colors.primary} />
        </Pressable>
        <View style={{ flex: 1, alignItems: 'center' }}>
          <Text style={[styles.title, { color: colors.text }]} numberOfLines={1}>
            {stockTake.title}
          </Text>
          <Text style={[styles.small, { color: colors.textMuted }]}>{stockTake.reference}</Text>
        </View>
        <Pressable
          onPress={() => void load(true).then(() => sync())}
          hitSlop={12}
          accessibilityRole="button"
          accessibilityLabel="Refresh count sheet"
        >
          <Ionicons name="refresh" size={22} color={colors.primary} />
        </Pressable>
      </View>

      <View style={styles.progressWrap}>
        <View style={[styles.bar, { backgroundColor: colors.bgSubtle }]}>
          <View style={[styles.barFill, { width: `${progress.percent}%`, backgroundColor: colors.success }]} />
        </View>
        <Text style={[styles.small, { color: colors.textSecondary }]}>
          {progress.counted} of {progress.total} counted by you · {describeSyncState(progress, online)}
        </Text>
        {lastSaved ? (
          <Text style={[styles.small, { color: colors.success }]} numberOfLines={1}>
            Saved {lastSaved}
          </Text>
        ) : null}
        {readOnly ? (
          <Text style={[styles.banner, { backgroundColor: colors.warningSoft, color: colors.warning }]}>
            Counting has closed. {stockTake.canManage ? 'Open the review to post or reopen it.' : 'Ask the manager to reopen it to add counts.'}
          </Text>
        ) : null}
      </View>

      <View style={styles.searchRow}>
        <View style={[styles.search, { backgroundColor: colors.bgElevated, borderColor: colors.border }]}>
          <Ionicons name="search" size={18} color={colors.textMuted} />
          <TextInput
            value={query}
            onChangeText={setQuery}
            placeholder="Name, SKU or barcode"
            placeholderTextColor={colors.textMuted}
            style={[styles.searchInput, { color: colors.text }]}
            autoCorrect={false}
            returnKeyType="search"
          />
          {query ? (
            <Pressable onPress={() => setQuery('')} hitSlop={8} accessibilityLabel="Clear search">
              <Ionicons name="close-circle" size={18} color={colors.textMuted} />
            </Pressable>
          ) : null}
        </View>
        <Pressable
          onPress={() => setScanning(true)}
          disabled={readOnly}
          style={[styles.scanBtn, { backgroundColor: readOnly ? colors.bgSubtle : colors.primary }]}
          accessibilityRole="button"
          accessibilityLabel="Scan a barcode"
        >
          <Ionicons name="barcode-outline" size={24} color={colors.primaryForeground} />
        </Pressable>
      </View>

      {!query ? (
        <View style={styles.filters}>
          {filters.map((f) => (
            <Pressable
              key={f.value}
              onPress={() => setFilter(f.value)}
              style={[
                styles.filter,
                {
                  backgroundColor: filter === f.value ? colors.primarySoft : 'transparent',
                  borderColor: filter === f.value ? colors.primary : colors.border,
                },
              ]}
              accessibilityRole="button"
              accessibilityState={{ selected: filter === f.value }}
            >
              <Text style={[styles.filterText, { color: filter === f.value ? colors.primary : colors.textSecondary }]}>
                {f.label}
              </Text>
            </Pressable>
          ))}
        </View>
      ) : null}

      <FlatList
        data={visible}
        keyExtractor={(item) => item.id}
        keyboardShouldPersistTaps="handled"
        initialNumToRender={20}
        windowSize={7}
        contentContainerStyle={{ paddingHorizontal: spacing.lg, paddingBottom: insets.bottom + 96 }}
        ListEmptyComponent={
          <Text style={[styles.small, { color: colors.textMuted, textAlign: 'center', marginTop: spacing.xxl }]}>
            {query ? 'No item matches.' : filter === 'todo' ? 'Everything here is counted.' : 'Nothing to show.'}
          </Text>
        }
        renderItem={({ item }) => {
          const mine = countedTotal(entries, item.id)
          const rejected = entries.some((e) => e.productId === item.id && e.syncState === 'rejected')
          return (
            <Pressable
              onPress={() => {
                setFromScan(false)
                setSelected(item)
              }}
              style={({ pressed }) => [
                styles.item,
                { borderColor: colors.borderSubtle, opacity: pressed ? 0.7 : 1 },
              ]}
              accessibilityRole="button"
            >
              <View style={{ flex: 1 }}>
                <Text style={[styles.itemName, { color: colors.text }]} numberOfLines={2}>
                  {item.name}
                </Text>
                <Text style={[styles.small, { color: colors.textMuted }]} numberOfLines={1}>
                  {[item.sku, item.category].filter(Boolean).join(' · ')}
                  {item.batches.length ? ` · ${item.batches.length} batch${item.batches.length > 1 ? 'es' : ''}` : ''}
                  {stockTake.showBook && item.bookQty !== undefined ? ` · book ${item.bookQty}` : ''}
                </Text>
                {rejected ? (
                  <Text style={[styles.small, { color: colors.danger }]}>
                    Not accepted: {entries.find((e) => e.productId === item.id && e.lastError)?.lastError}
                  </Text>
                ) : null}
              </View>
              {mine !== null ? (
                <View style={[styles.countPill, { backgroundColor: colors.successSoft }]}>
                  <Text style={[styles.countText, { color: colors.success }]}>{mine}</Text>
                </View>
              ) : item.negativeBook ? (
                <View style={[styles.countPill, { backgroundColor: colors.dangerSoft }]}>
                  <Text style={[styles.countText, { color: colors.danger }]}>{item.bookQty}</Text>
                </View>
              ) : (
                <Ionicons name="chevron-forward" size={18} color={colors.textMuted} />
              )}
            </Pressable>
          )
        }}
      />

      {stockTake.canManage ? (
        <View
          style={[
            styles.footer,
            { backgroundColor: colors.bg, borderColor: colors.border, paddingBottom: insets.bottom + spacing.md },
          ]}
        >
          {stockTake.status === 'counting' ? (
            <Pressable
              onPress={closeCounting}
              disabled={busy}
              style={[styles.footerBtn, { backgroundColor: colors.primary }]}
              accessibilityRole="button"
            >
              <Text style={[styles.footerText, { color: colors.primaryForeground }]}>
                {busy ? 'Closing…' : 'Close counting & review'}
              </Text>
            </Pressable>
          ) : (
            <Pressable
              onPress={() => router.push(`/stock-take/${id}/review` as never)}
              style={[styles.footerBtn, { backgroundColor: colors.primary }]}
              accessibilityRole="button"
            >
              <Text style={[styles.footerText, { color: colors.primaryForeground }]}>Open review</Text>
            </Pressable>
          )}
        </View>
      ) : null}

      <ScannerModal
        visible={scanning}
        title="Scan to count"
        hint={`${progress.counted} of ${progress.total} counted`}
        onScanned={onScanned}
        onClose={() => setScanning(false)}
      />
      <CountSheet
        item={selected}
        entries={entries}
        showBook={stockTake.showBook}
        readOnly={readOnly}
        fromScan={fromScan}
        onSave={onSave}
        onClose={() => setSelected(null)}
      />
    </View>
  )
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: spacing.lg, paddingVertical: spacing.sm, gap: spacing.md },
  title: { ...typography.h4 },
  small: { ...typography.bodySm },
  progressWrap: { paddingHorizontal: spacing.lg, gap: spacing.xs, marginBottom: spacing.sm },
  bar: { height: 6, borderRadius: radii.full, overflow: 'hidden' },
  barFill: { height: 6 },
  banner: { ...typography.bodySm, padding: spacing.sm, borderRadius: radii.md, marginTop: spacing.xs },
  searchRow: { flexDirection: 'row', gap: spacing.sm, paddingHorizontal: spacing.lg, marginBottom: spacing.sm },
  search: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    borderWidth: 1,
    borderRadius: radii.md,
    paddingHorizontal: spacing.md,
  },
  searchInput: { flex: 1, ...typography.body, paddingVertical: spacing.sm },
  scanBtn: { width: 52, borderRadius: radii.md, alignItems: 'center', justifyContent: 'center' },
  filters: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, paddingHorizontal: spacing.lg, marginBottom: spacing.sm },
  filter: { borderWidth: 1, borderRadius: radii.full, paddingHorizontal: spacing.md, paddingVertical: 6 },
  filterText: { ...typography.caption },
  item: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, paddingVertical: spacing.md, borderBottomWidth: StyleSheet.hairlineWidth },
  itemName: { ...typography.bodyMedium },
  countPill: { minWidth: 44, paddingHorizontal: spacing.sm, paddingVertical: 4, borderRadius: radii.full, alignItems: 'center' },
  countText: { ...typography.h4 },
  footer: { position: 'absolute', left: 0, right: 0, bottom: 0, borderTopWidth: StyleSheet.hairlineWidth, paddingHorizontal: spacing.lg, paddingTop: spacing.md },
  footerBtn: { borderRadius: radii.md, paddingVertical: spacing.md, alignItems: 'center' },
  footerText: { ...typography.bodyMedium },
})
