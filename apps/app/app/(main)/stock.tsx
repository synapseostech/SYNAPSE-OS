import { useCallback, useEffect, useState } from 'react'
import {
  FlatList,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  View,
} from 'react-native'
import { useRouter } from 'expo-router'
import { EmptyState } from '@/components/ui/EmptyState'
import { LoadingBlock } from '@/components/ui/LoadingBlock'
import { useAuth } from '@/lib/auth'
import { apiRequest } from '@/lib/api'
import { colors, radii, spacing, typography, TONE_COLORS } from '@/lib/theme'

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
  ok: TONE_COLORS.green,
  low: TONE_COLORS.red,
  expiring: TONE_COLORS.warning,
  expired: TONE_COLORS.red,
}

const STATUS_LABELS: Record<InventoryItem['status'], string> = {
  ok: 'In stock',
  low: 'Low stock',
  expiring: 'Expiring',
  expired: 'Expired',
}

export default function StockScreen() {
  const { token } = useAuth()
  const router = useRouter()
  const [items, setItems] = useState<InventoryItem[]>([])
  const [summary, setSummary] = useState<InventorySummary | null>(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)

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
    } catch {
      setItems([])
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }, [token])

  useEffect(() => { load() }, [load])

  return (
    <View style={styles.container}>
      {!loading && summary ? (
        <View style={styles.summaryRow}>
          <SummaryPill label="Products" value={summary.totalProducts} color={colors.primary} />
          <SummaryPill label="Low" value={summary.lowStock} color={colors.danger} />
          <SummaryPill label="Expiring" value={summary.expiringSoon} color={colors.warning} />
        </View>
      ) : null}

      <View style={styles.toolbar}>
        <Pressable
          style={({ pressed }) => [styles.toolBtn, pressed && styles.cardPressed]}
          onPress={() => router.push('/stock-new' as never)}
        >
          <Text style={styles.toolBtnText}>+ Add product</Text>
        </Pressable>
        <Pressable
          style={({ pressed }) => [styles.toolBtnGhost, pressed && styles.cardPressed]}
          onPress={() => router.push('/quick-receive' as never)}
        >
          <Text style={styles.toolBtnGhostText}>Receive</Text>
        </Pressable>
        <Pressable
          style={({ pressed }) => [styles.toolBtnGhost, pressed && styles.cardPressed]}
          onPress={() => router.push('/stock-take' as never)}
        >
          <Text style={styles.toolBtnGhostText}>Stock take</Text>
        </Pressable>
        <Pressable
          style={({ pressed }) => [styles.toolBtnGhost, pressed && styles.cardPressed]}
          onPress={() => router.push('/barcode-scan' as never)}
        >
          <Text style={styles.toolBtnGhostText}>Barcode</Text>
        </Pressable>
        <Pressable
          style={({ pressed }) => [styles.toolBtnGhost, pressed && styles.cardPressed]}
          onPress={() => router.push('/stock-import' as never)}
        >
          <Text style={styles.toolBtnGhostText}>Bulk import</Text>
        </Pressable>
      </View>

      {loading ? (
        <LoadingBlock message="Loading inventory…" />
      ) : (
        <FlatList
          data={items}
          keyExtractor={(item) => item.id}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={() => { setRefreshing(true); load() }}
              tintColor={colors.primary}
            />
          }
          contentContainerStyle={styles.listContent}
          ListEmptyComponent={
            <EmptyState
              title="No inventory yet"
              body="Add a product or import a CSV from Bulk import. Open an item to edit stock and prices."
              icon="cube"
            />
          }
          renderItem={({ item }) => (
            <Pressable
              style={({ pressed }) => [styles.card, pressed && styles.cardPressed]}
              onPress={() => router.push(`/stock-item/${item.id}` as never)}
              accessibilityRole="button"
              accessibilityLabel={`${item.name}, ${STATUS_LABELS[item.status]}, quantity ${item.quantity}`}
            >
              <View style={styles.cardTop}>
                <Text style={styles.name} numberOfLines={2}>{item.name}</Text>
                <Text style={[styles.status, { color: STATUS_COLORS[item.status] }]}>
                  {STATUS_LABELS[item.status]}
                </Text>
              </View>
              <View style={styles.metaRow}>
                <Text style={styles.qty}>Qty {item.quantity}</Text>
                <Text style={styles.reorder}>Reorder ≤ {item.reorderLevel}</Text>
              </View>
              {item.expiryDate ? (
                <Text style={styles.expiry}>Exp {item.expiryDate}</Text>
              ) : null}
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
  return (
    <View style={styles.pill}>
      <Text style={[styles.pillValue, { color }]}>{value}</Text>
      <Text style={styles.pillLabel}>{label}</Text>
    </View>
  )
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  summaryRow: {
    flexDirection: 'row',
    gap: spacing.sm,
    padding: spacing.lg,
    paddingBottom: spacing.sm,
  },
  toolbar: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.md,
  },
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
  listContent: { paddingHorizontal: spacing.lg, paddingBottom: spacing.xxxl },
  card: {
    backgroundColor: colors.surface,
    borderRadius: radii.lg,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.lg,
    marginBottom: spacing.sm,
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
    gap: spacing.lg,
    marginTop: spacing.sm,
  },
  qty: {
    ...typography.mono,
    color: colors.text,
    fontSize: 13,
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
})
