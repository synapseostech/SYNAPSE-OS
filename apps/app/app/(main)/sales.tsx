import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  FlatList,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  View,
} from 'react-native'
import { useRouter } from 'expo-router'
import { Ionicons } from '@expo/vector-icons'
import { Button } from '@/components/ui/Button'
import { EmptyState, ErrorState } from '@/components/ui/EmptyState'
import { LoadingBlock } from '@/components/ui/LoadingBlock'
import { useAuth } from '@/lib/auth'
import { apiRequest } from '@/lib/api'
import { radii, spacing, tabBarHeight, typography, makeStyles, useTheme } from '@/lib/theme'

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

  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    if (!token) {
      setLoading(false)
      return
    }
    try {
      const data = await apiRequest<{ sales: SaleRow[] }>('/api/mobile/pharmacy/sales', { token })
      setSales(data.sales)
      setError(null)
    } catch (err) {
      setSales([])
      setError(err instanceof Error ? err.message : 'Could not load sales')
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }, [token])

  useEffect(() => {
    load()
  }, [load])

  // Today's takings from the rows already loaded: completed sales only.
  const today = useMemo(() => {
    const start = new Date()
    start.setHours(0, 0, 0, 0)
    let total = 0
    let count = 0
    for (const s of sales) {
      if (new Date(s.createdAt) < start) continue
      if (!isCompleted(s.status)) continue
      total += Number(s.totalAmount) || 0
      count += 1
    }
    return { total, count }
  }, [sales])

  return (
    <View style={styles.container}>
      {loading ? (
        <View style={styles.listContent}>
          <LoadingBlock message="Loading sales…" rows={6} />
        </View>
      ) : error && sales.length === 0 ? (
        <ErrorState
          message={error}
          onRetry={() => {
            setLoading(true)
            load()
          }}
        />
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
              colors={[colors.primary]}
            />
          }
          contentContainerStyle={styles.listContent}
          ListHeaderComponent={
            <View>
              <View style={styles.summary}>
                <View style={styles.summaryCopy}>
                  <Text style={styles.summaryLabel}>Today</Text>
                  <Text style={styles.summaryValue} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.7}>
                    UGX {today.total.toLocaleString()}
                  </Text>
                  <Text style={styles.summarySub}>
                    {today.count} completed {today.count === 1 ? 'sale' : 'sales'} in this list
                  </Text>
                </View>
                <Button label="New sale" icon="cart" onPress={() => router.push('/pos' as never)} />
              </View>
              {sales.length > 0 ? <Text style={styles.sectionTitle}>Recent receipts</Text> : null}
            </View>
          }
          ListEmptyComponent={
            <EmptyState
              title="No sales yet"
              body="Completed POS sales will show here."
              icon="cash"
              actionLabel="Start a sale"
              onAction={() => router.push('/pos' as never)}
            />
          }
          renderItem={({ item }) => {
            const voided = item.status === 'VOIDED' || !isCompleted(item.status)
            const tone = isCompleted(item.status) ? colors.success : colors.danger
            return (
              <Pressable
                style={({ pressed }) => [styles.card, pressed && { backgroundColor: colors.surfaceHover }]}
                onPress={() => router.push(`/receipt/${item.id}` as never)}
                accessibilityRole="button"
                accessibilityLabel={`Receipt ${item.receiptNumber}, UGX ${Number(item.totalAmount).toLocaleString()}, ${statusLabel(item.status)}`}
                accessibilityHint="Open receipt"
              >
                <View style={[styles.payIcon, { backgroundColor: `${tone}1F` }]}>
                  <Ionicons name={paymentIcon(item.paymentMethod)} size={18} color={tone} />
                </View>
                <View style={styles.cardBody}>
                  <View style={styles.cardTop}>
                    <Text style={styles.receipt}>{item.receiptNumber}</Text>
                    <Text style={[styles.amount, voided && styles.amountVoided]}>
                      {Number(item.totalAmount).toLocaleString()}
                    </Text>
                  </View>
                  <View style={styles.metaRow}>
                    <Text style={styles.meta} numberOfLines={1}>
                      {paymentLabel(item.paymentMethod)}
                      {item.cashierName ? ` · ${item.cashierName}` : ''}
                    </Text>
                    <Text style={[styles.meta, styles.when]} numberOfLines={1}>
                      {!isCompleted(item.status) ? (
                        <Text style={{ color: tone }}>{statusLabel(item.status)} · </Text>
                      ) : null}
                      {new Date(item.createdAt).toLocaleString([], {
                        day: 'numeric',
                        month: 'short',
                        hour: 'numeric',
                        minute: '2-digit',
                      })}
                    </Text>
                  </View>
                </View>
                <Ionicons name="chevron-forward" size={16} color={colors.textMuted} />
              </Pressable>
            )
          }}
        />
      )}
    </View>
  )
}

function isCompleted(status: string) {
  return /^(completed|paid|complete)$/i.test(status)
}

function statusLabel(status: string) {
  const s = status.replace(/_/g, ' ').toLowerCase()
  return s.charAt(0).toUpperCase() + s.slice(1)
}

const PAYMENT_LABELS: Record<string, string> = {
  cash: 'Cash',
  mobile_money: 'Mobile money',
  momo: 'Mobile money',
  card: 'Card',
  credit: 'On credit',
  insurance: 'Insurance',
  bank: 'Bank transfer',
  bank_transfer: 'Bank transfer',
  mixed: 'Split payment',
}

function paymentLabel(method: string | null) {
  if (!method) return '—'
  return PAYMENT_LABELS[method.toLowerCase()] ?? statusLabel(method)
}

function paymentIcon(method: string | null): keyof typeof Ionicons.glyphMap {
  const m = (method ?? '').toLowerCase()
  if (m.includes('mobile') || m === 'momo') return 'phone-portrait-outline'
  if (m.includes('card')) return 'card-outline'
  if (m.includes('credit')) return 'book-outline'
  if (m.includes('insur')) return 'shield-checkmark-outline'
  if (m.includes('bank')) return 'business-outline'
  return 'cash-outline'
}

const useStyles = makeStyles((colors) => ({
  container: { flex: 1, backgroundColor: colors.bg },
  listContent: { padding: spacing.lg, paddingBottom: spacing.xxxl + tabBarHeight },
  summary: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    padding: spacing.lg,
    borderRadius: radii.xl,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.primarySoft,
  },
  summaryCopy: { flex: 1 },
  summaryLabel: { ...typography.label, color: colors.textSecondary },
  summaryValue: { fontFamily: 'BricolageGrotesque_700Bold', fontSize: 26, lineHeight: 32, color: colors.text, marginTop: 2 },
  summarySub: { ...typography.caption, color: colors.textSecondary },
  sectionTitle: { ...typography.label, color: colors.textSecondary, marginTop: spacing.xl, marginBottom: spacing.sm },
  payIcon: { width: 38, height: 38, borderRadius: radii.md, alignItems: 'center', justifyContent: 'center' },
  cardBody: { flex: 1 },
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
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    backgroundColor: colors.surface,
    borderRadius: radii.lg,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.md,
    marginBottom: spacing.sm,
    minHeight: 64,
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
    fontSize: 15,
  },
  amountVoided: {
    textDecorationLine: 'line-through',
    color: colors.textMuted,
  },
  metaRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: 3,
    gap: spacing.sm,
  },
  meta: {
    ...typography.caption,
    color: colors.textMuted,
    fontFamily: 'DMSans_400Regular',
    flexShrink: 1,
  },
  when: { flexShrink: 0 },
  viewReceipt: {
    ...typography.caption,
    color: colors.primary,
    fontFamily: 'DMSans_500Medium',
    marginTop: spacing.sm,
  },
}))
