import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  FlatList,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  View,
} from 'react-native'
import { useLocalSearchParams, useRouter } from 'expo-router'
import { Ionicons } from '@expo/vector-icons'
import { EmptyState, ErrorState } from '@/components/ui/EmptyState'
import { LoadingBlock } from '@/components/ui/LoadingBlock'
import { SearchField } from '@/components/ui/SearchField'
import { selectionHaptic } from '@/lib/haptics'
import { useAuth } from '@/lib/auth'
import { apiRequest } from '@/lib/api'
import { radii, spacing, tabBarHeight, typography, TONE_COLORS, makeStyles, useTheme } from '@/lib/theme'

type StockFilter = 'all' | 'low' | 'expiring'

interface InventoryItem {
  id: string
  name: string
  quantity: number
  reorderLevel: number
  expiryDate: string | null
  status: 'ok' | 'low' | 'expiring' | 'expired'
}

interface InventorySummary {
  totalProducts: number
  lowStock: number
  expiringSoon: number
}

const STATUS_COLORS: Record<InventoryItem['status'], string> = {
  get ok() { return TONE_COLORS.green },
  get low() { return TONE_COLORS.red },
  get expiring() { return TONE_COLORS.warning },
  get expired() { return TONE_COLORS.red },
}

const STATUS_LABELS: Record<InventoryItem['status'], string> = {
  ok: 'In stock',
  low: 'Low stock',
  expiring: 'Expiring',
  expired: 'Expired',
}

export default function StockScreen() {
  const styles = useStyles()
  const { colors } = useTheme()
  const { token } = useAuth()
  const router = useRouter()
  const [items, setItems] = useState<InventoryItem[]>([])
  const [summary, setSummary] = useState<InventorySummary | null>(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    if (!token) {
      setLoading(false)
      return
    }
    try {
      const data = await apiRequest<{ items: InventoryItem[]; summary: InventorySummary }>(
        '/api/mobile/inventory',
        { token }
      )
      setItems(data.items)
      setSummary(data.summary)
      setError(null)
    } catch (err) {
      setItems([])
      setError(err instanceof Error ? err.message : 'Could not load inventory')
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }, [token])

  useEffect(() => { load() }, [load])

  const params = useLocalSearchParams<{ filter?: string }>()
  const [filter, setFilter] = useState<StockFilter>(
    params.filter === 'low' || params.filter === 'expiring' ? params.filter : 'all',
  )
  const [query, setQuery] = useState('')
  useEffect(() => {
    if (params.filter === 'low' || params.filter === 'expiring' || params.filter === 'all') setFilter(params.filter)
  }, [params.filter])

  const q = query.trim().toLowerCase()
  const visible = useMemo(
    () =>
      items.filter((item) => {
        if (filter === 'low' && item.status !== 'low') return false
        if (filter === 'expiring' && item.status !== 'expiring' && item.status !== 'expired') return false
        return !q || item.name.toLowerCase().includes(q)
      }),
    [items, filter, q],
  )

  const chips: Array<{ key: StockFilter; label: string; count?: number; color: string }> = [
    { key: 'all', label: 'All', count: summary?.totalProducts, color: colors.primary },
    { key: 'low', label: 'Low', count: summary?.lowStock, color: colors.danger },
    { key: 'expiring', label: 'Expiring', count: summary?.expiringSoon, color: colors.warning },
  ]

  const tools: Array<{ label: string; icon: keyof typeof Ionicons.glyphMap; route: string; primary?: boolean }> = [
    { label: 'Add', icon: 'add', route: '/stock-new', primary: true },
    { label: 'Receive', icon: 'download-outline', route: '/stock-receive' },
    { label: 'Scan', icon: 'barcode-outline', route: '/barcode-scan' },
    { label: 'Import', icon: 'cloud-upload-outline', route: '/stock-import' },
  ]

  return (
    <View style={styles.container}>
      <View style={styles.top}>
        <SearchField
          value={query}
          onChangeText={setQuery}
          placeholder="Search products on hand"
          trailingIcon="barcode-outline"
          trailingLabel="Scan a barcode"
          onTrailingPress={() => router.push('/barcode-scan' as never)}
        />
        <View style={styles.chipRow} accessibilityRole="tablist">
          {chips.map((c) => {
            const active = filter === c.key
            return (
              <Pressable
                key={c.key}
                onPress={() => {
                  selectionHaptic()
                  setFilter(c.key)
                }}
                accessibilityRole="tab"
                accessibilityState={{ selected: active }}
                style={[styles.chip, active && { backgroundColor: `${c.color}1F`, borderColor: c.color }]}
              >
                <Text style={[styles.chipText, active && { color: c.color }]}>{c.label}</Text>
                {c.count !== undefined && !loading ? (
                  <Text style={[styles.chipCount, { color: active ? c.color : colors.textSecondary }]}>{c.count}</Text>
                ) : null}
              </Pressable>
            )
          })}
        </View>
        <View style={styles.toolbar}>
          {tools.map((t) => (
            <Pressable
              key={t.label}
              onPress={() => router.push(t.route as never)}
              accessibilityRole="button"
              accessibilityLabel={t.label === 'Add' ? 'Add product' : t.label === 'Import' ? 'Bulk import' : t.label}
              style={({ pressed }) => [styles.tool, t.primary && styles.toolPrimary, pressed && styles.cardPressed]}
            >
              <Ionicons name={t.icon} size={18} color={t.primary ? colors.primaryForeground : colors.primary} />
              <Text style={[styles.toolText, t.primary && { color: colors.primaryForeground }]}>{t.label}</Text>
            </Pressable>
          ))}
        </View>
      </View>

      {loading ? (
        <View style={styles.listContent}>
          <LoadingBlock message="Loading inventory…" rows={7} />
        </View>
      ) : error && items.length === 0 ? (
        <ErrorState
          message={error}
          onRetry={() => {
            setLoading(true)
            load()
          }}
        />
      ) : (
        <FlatList
          data={visible}
          keyExtractor={(item) => item.id}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag"
          initialNumToRender={14}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={() => { setRefreshing(true); load() }}
              tintColor={colors.primary}
              colors={[colors.primary]}
            />
          }
          contentContainerStyle={styles.listContent}
          ListEmptyComponent={
            q || filter !== 'all' ? (
              <EmptyState
                title={q ? 'No product matches' : filter === 'low' ? 'Nothing is low' : 'Nothing is expiring'}
                body={q ? `Nothing on hand matches “${query.trim()}”.` : 'Good news — every product is above its reorder level and in date.'}
                icon={q ? 'search' : 'checkmark-circle'}
                actionLabel={q ? 'Clear search' : 'Show all'}
                onAction={() => {
                  setQuery('')
                  setFilter('all')
                }}
              />
            ) : (
              <EmptyState
                title="No inventory yet"
                body="Add a product or import a CSV from Bulk import. Open an item to edit stock and prices."
                icon="cube"
                actionLabel="Add product"
                onAction={() => router.push('/stock-new' as never)}
              />
            )
          }
          renderItem={({ item }) => (
            <Pressable
              style={({ pressed }) => [styles.card, pressed && styles.cardPressed]}
              onPress={() => router.push(`/stock-item/${item.id}` as never)}
              accessibilityRole="button"
              accessibilityLabel={`${item.name}, ${STATUS_LABELS[item.status]}, quantity ${item.quantity}`}
            >
              <View style={[styles.statusBar, { backgroundColor: STATUS_COLORS[item.status] }]} />
              <View style={styles.cardBody}>
                <Text style={styles.name} numberOfLines={2}>{item.name}</Text>
                <View style={styles.metaRow}>
                  <Text style={[styles.status, { color: STATUS_COLORS[item.status] }]}>
                    {STATUS_LABELS[item.status]}
                  </Text>
                  {item.expiryDate ? <Text style={styles.expiry}>Exp {item.expiryDate}</Text> : null}
                </View>
              </View>
              <View style={styles.qtyBox}>
                <Text style={[styles.qty, item.quantity <= item.reorderLevel && { color: colors.danger }]}>
                  {item.quantity}
                </Text>
                <Text style={styles.reorder}>min {item.reorderLevel}</Text>
              </View>
            </Pressable>
          )}
        />
      )}
    </View>
  )
}

function SummaryPill({
  label,
  value,
  color,
}: {
  label: string
  value: number
  color: string
}) {
  const styles = useStyles()
  return (
    <View style={styles.pill}>
      <Text style={[styles.pillValue, { color }]}>{value}</Text>
      <Text style={styles.pillLabel}>{label}</Text>
    </View>
  )
}

const useStyles = makeStyles((colors) => ({
  container: { flex: 1, backgroundColor: colors.bg },
  top: { paddingHorizontal: spacing.lg, paddingTop: spacing.md, gap: spacing.md, paddingBottom: spacing.sm },
  chipRow: { flexDirection: 'row', gap: spacing.sm },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    minHeight: 38,
    paddingHorizontal: spacing.md,
    borderRadius: radii.full,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  chipText: { color: colors.text, fontSize: 13.5, fontFamily: 'DMSans_500Medium' },
  chipCount: { fontSize: 12.5, fontFamily: 'IBMPlexMono_500Medium' },
  tool: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    minHeight: 44,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  toolPrimary: { backgroundColor: colors.primary, borderColor: colors.primary },
  toolText: { color: colors.text, fontSize: 13, fontFamily: 'DMSans_700Bold' },
  statusBar: { width: 4, alignSelf: 'stretch', borderRadius: 2 },
  cardBody: { flex: 1 },
  qtyBox: { alignItems: 'flex-end', minWidth: 56 },
  summaryRow: {
    flexDirection: 'row',
    gap: spacing.sm,
    padding: spacing.lg,
    paddingBottom: spacing.sm,
  },
  toolbar: { flexDirection: 'row', gap: spacing.sm },
  toolBtn: {
    minWidth: '30%',
    flexGrow: 1,
    backgroundColor: colors.primary,
    borderRadius: radii.md,
    paddingVertical: spacing.md,
    alignItems: 'center',
  },
  toolBtnText: {
    ...typography.bodyMedium,
    color: '#fff',
    fontFamily: 'DMSans_700Bold',
  },
  toolBtnGhost: {
    minWidth: '30%',
    flexGrow: 1,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.border,
    paddingVertical: spacing.md,
    alignItems: 'center',
    backgroundColor: colors.surface,
  },
  toolBtnGhostText: {
    ...typography.bodyMedium,
    color: colors.text,
    fontFamily: 'DMSans_500Medium',
  },
  pill: {
    flex: 1,
    backgroundColor: colors.surface,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.border,
    paddingVertical: spacing.md,
    alignItems: 'center',
  },
  pillValue: {
    ...typography.stat,
    fontSize: 20,
    fontFamily: 'DMSans_700Bold',
  },
  pillLabel: {
    ...typography.caption,
    color: colors.textSecondary,
    fontFamily: 'DMSans_400Regular',
    marginTop: 2,
  },
  listContent: { paddingHorizontal: spacing.lg, paddingTop: spacing.xs, paddingBottom: spacing.xxxl + tabBarHeight },
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    backgroundColor: colors.surface,
    borderRadius: radii.lg,
    borderWidth: 1,
    borderColor: colors.border,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.md,
    marginBottom: spacing.sm,
    minHeight: 64,
  },
  cardPressed: { backgroundColor: colors.surfaceHover },
  cardTop: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    gap: spacing.sm,
  },
  name: {
    ...typography.bodyMedium,
    color: colors.text,
    fontFamily: 'DMSans_500Medium',
    flex: 1,
  },
  status: {
    fontSize: 11,
    fontWeight: '600',
    fontFamily: 'DMSans_500Medium',
  },
  metaRow: {
    flexDirection: 'row',
    gap: spacing.md,
    marginTop: 3,
  },
  qty: {
    fontFamily: 'BricolageGrotesque_700Bold',
    color: colors.text,
    fontSize: 20,
    lineHeight: 24,
  },
  reorder: {
    ...typography.caption,
    color: colors.textMuted,
    fontFamily: 'DMSans_400Regular',
  },
  expiry: {
    ...typography.caption,
    color: colors.warning,
    fontFamily: 'DMSans_400Regular',
    marginTop: spacing.xs,
  },
}))
