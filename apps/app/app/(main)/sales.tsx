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
import { radii, spacing, typography, TONE_COLORS, makeStyles, useTheme } from '@/lib/theme'

interface SaleRow {
  id: string
  receiptNumber: string
  status: string
  totalAmount: number
  paymentMethod: string | null
  createdAt: string
  cashierName: string | null
}

export default function SalesScreen() {
  const styles = useStyles()
  const { colors } = useTheme()
  const { token } = useAuth()
  const router = useRouter()
  const [sales, setSales] = useState<SaleRow[]>([])
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)

  const load = useCallback(async () => {
    if (!token) {
      setLoading(false)
      return
    }
    try {
      const data = await apiRequest<{ sales: SaleRow[] }>('/api/mobile/pharmacy/sales', { token })
      setSales(data.sales)
    } catch {
      setSales([])
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }, [token])

  useEffect(() => {
    load()
  }, [load])

  return (
    <View style={styles.container}>
      {loading ? (
        <LoadingBlock message="Loading sales…" />
      ) : (
        <FlatList
          data={sales}
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
          contentContainerStyle={styles.listContent}
          ListHeaderComponent={
            <Pressable style={styles.newSaleCta} onPress={() => router.push('/pos' as never)}>
              <Text style={styles.newSaleText}>New sale</Text>
            </Pressable>
          }
          ListEmptyComponent={
            <EmptyState
              title="No sales yet"
              body="Completed POS sales will show here. Tap New sale above to check out."
              icon="cash"
            />
          }
          renderItem={({ item }) => {
            const voided = item.status === 'VOIDED'
            return (
              <Pressable
                style={styles.card}
                onPress={() => router.push(`/receipt/${item.id}` as never)}
                accessibilityRole="button"
                accessibilityHint="Open receipt"
              >
                <View style={styles.cardTop}>
                  <Text style={styles.receipt}>{item.receiptNumber}</Text>
                  <Text style={[styles.status, { color: voided ? TONE_COLORS.red : TONE_COLORS.green }]}>
                    {item.status}
                  </Text>
                </View>
                <Text style={[styles.amount, voided && styles.amountVoided]}>
                  UGX {Number(item.totalAmount).toLocaleString()}
                </Text>
                <View style={styles.metaRow}>
                  <Text style={styles.meta}>
                    {item.paymentMethod ?? '—'}
                    {item.cashierName ? ` · ${item.cashierName}` : ''}
                  </Text>
                  <Text style={styles.meta}>
                    {new Date(item.createdAt).toLocaleString([], {
                      day: 'numeric',
                      month: 'short',
                      hour: '2-digit',
                      minute: '2-digit',
                    })}
                  </Text>
                </View>
                <Text style={styles.viewReceipt}>View receipt ›</Text>
              </Pressable>
            )
          }}
        />
      )}
    </View>
  )
}

const useStyles = makeStyles((colors) => ({
  container: { flex: 1, backgroundColor: colors.bg },
  listContent: { padding: spacing.lg, paddingBottom: spacing.xxxl },
  newSaleCta: {
    backgroundColor: colors.primary,
    borderRadius: radii.md,
    paddingVertical: spacing.md,
    alignItems: 'center',
    marginBottom: spacing.lg,
  },
  newSaleText: {
    ...typography.bodyMedium,
    color: colors.primaryForeground,
    fontFamily: 'DMSans_700Bold',
  },
  card: {
    backgroundColor: colors.surface,
    borderRadius: radii.lg,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.lg,
    marginBottom: spacing.sm,
  },
  cardTop: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: spacing.sm,
  },
  receipt: {
    ...typography.bodyMedium,
    color: colors.text,
    fontFamily: 'DMSans_700Bold',
  },
  status: {
    fontSize: 11,
    fontWeight: '600',
    fontFamily: 'DMSans_500Medium',
  },
  amount: {
    ...typography.mono,
    color: colors.text,
    fontSize: 16,
    marginTop: spacing.sm,
  },
  amountVoided: {
    textDecorationLine: 'line-through',
    color: colors.textMuted,
  },
  metaRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: spacing.sm,
    gap: spacing.sm,
  },
  meta: {
    ...typography.caption,
    color: colors.textMuted,
    fontFamily: 'DMSans_400Regular',
    flexShrink: 1,
  },
  viewReceipt: {
    ...typography.caption,
    color: colors.primary,
    fontFamily: 'DMSans_500Medium',
    marginTop: spacing.sm,
  },
}))
