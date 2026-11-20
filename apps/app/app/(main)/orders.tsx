import { useCallback, useEffect, useState } from 'react'
import {
  Alert,
  FlatList,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  View,
} from 'react-native'
import { EmptyState } from '@/components/ui/EmptyState'
import { LoadingBlock } from '@/components/ui/LoadingBlock'
import { Button } from '@/components/ui/Button'
import { useAuth } from '@/lib/auth'
import { apiRequest } from '@/lib/api'
import { radii, spacing, typography, TONE_COLORS, makeStyles, useTheme } from '@/lib/theme'

interface OrderItem {
  id: string
  productName: string
  quantity: number
  unitPrice: number
  totalPrice: number
}

interface PharmacyOrder {
  id: string
  orderNo: string
  status: string
  totalAmount: number
  orderType: string
  isOnline: boolean
  claimedBy: string | null
  createdAt: string
  notes: string | null
  deliveryAddress: string | null
  customerName: string | null
  customerPhone: string | null
  items: OrderItem[]
}

interface OrdersSummary {
  pending: number
  processing: number
  total: number
}

const STATUS_COLOR: Record<string, string> = {
  get PENDING() { return TONE_COLORS.warning },
  get PROCESSING() { return TONE_COLORS.info },
  get COMPLETED() { return TONE_COLORS.green },
  get CANCELLED() { return TONE_COLORS.red },
}

export default function OrdersScreen() {
  const styles = useStyles()
  const { colors } = useTheme()
  const { token } = useAuth()
  const [orders, setOrders] = useState<PharmacyOrder[]>([])
  const [summary, setSummary] = useState<OrdersSummary | null>(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [actingId, setActingId] = useState<string | null>(null)
  const [expandedId, setExpandedId] = useState<string | null>(null)

  const load = useCallback(async () => {
    if (!token) {
      setLoading(false)
      return
    }
    try {
      const data = await apiRequest<{ orders: PharmacyOrder[]; summary: OrdersSummary }>(
        '/api/mobile/pharmacy/orders',
        { token },
      )
      setOrders(data.orders)
      setSummary(data.summary)
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

  const runAction = async (orderId: string, action: 'claim' | 'complete' | 'cancel') => {
    if (!token) return
    setActingId(orderId)
    try {
      await apiRequest('/api/mobile/pharmacy/orders', {
        method: 'PATCH',
        token,
        body: { orderId, action },
      })
      await load()
    } catch (err) {
      Alert.alert('Action failed', err instanceof Error ? err.message : 'Try again')
    } finally {
      setActingId(null)
    }
  }

  const confirmCancel = (orderId: string) => {
    Alert.alert('Cancel order?', 'This cannot be undone.', [
      { text: 'Keep', style: 'cancel' },
      { text: 'Cancel order', style: 'destructive', onPress: () => runAction(orderId, 'cancel') },
    ])
  }

  return (
    <View style={styles.container}>
      {!loading && summary ? (
        <View style={styles.summaryRow}>
          <SummaryPill label="Pending" value={summary.pending} color={colors.warning} />
          <SummaryPill label="Processing" value={summary.processing} color={TONE_COLORS.info} />
          <SummaryPill label="Shown" value={summary.total} color={colors.primary} />
        </View>
      ) : null}

      {loading ? (
        <LoadingBlock message="Loading orders…" />
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
          contentContainerStyle={styles.listContent}
          ListEmptyComponent={
            <EmptyState
              title="No orders"
              body="Online and counter orders will appear here when customers place them."
              icon="receipt"
            />
          }
          renderItem={({ item }) => {
            const expanded = expandedId === item.id
            const statusColor = STATUS_COLOR[item.status] ?? colors.textMuted
            const busy = actingId === item.id

            return (
              <Pressable
                style={({ pressed }) => [styles.card, pressed && styles.cardPressed]}
                onPress={() => setExpandedId(expanded ? null : item.id)}
              >
                <View style={styles.cardTop}>
                  <View style={styles.cardTitles}>
                    <Text style={styles.orderNo}>{item.orderNo}</Text>
                    <Text style={styles.customer} numberOfLines={1}>
                      {item.customerName ?? 'Walk-in / unknown'}
                    </Text>
                  </View>
                  <Text style={[styles.status, { color: statusColor }]}>{item.status}</Text>
                </View>

                <View style={styles.metaRow}>
                  <Text style={styles.amount}>
                    UGX {Number(item.totalAmount).toLocaleString()}
                  </Text>
                  <Text style={styles.when}>
                    {new Date(item.createdAt).toLocaleString([], {
                      day: 'numeric',
                      month: 'short',
                      hour: '2-digit',
                      minute: '2-digit',
                    })}
                  </Text>
                </View>

                {expanded ? (
                  <View style={styles.detail}>
                    {item.items.map((line) => (
                      <Text key={line.id} style={styles.line}>
                        {line.quantity}× {line.productName}
                      </Text>
                    ))}
                    {item.notes ? <Text style={styles.notes}>Note: {item.notes}</Text> : null}
                    {item.deliveryAddress ? (
                      <Text style={styles.notes}>Deliver: {item.deliveryAddress}</Text>
                    ) : null}

                    <View style={styles.actions}>
                      {item.status === 'PENDING' ? (
                        <Button
                          label="Claim"
                          onPress={() => runAction(item.id, 'claim')}
                          loading={busy}
                          style={styles.actionBtn}
                        />
                      ) : null}
                      {item.status === 'PENDING' || item.status === 'PROCESSING' ? (
                        <>
                          <Button
                            label="Complete"
                            onPress={() => runAction(item.id, 'complete')}
                            loading={busy}
                            style={styles.actionBtn}
                          />
                          <Button
                            label="Cancel"
                            onPress={() => confirmCancel(item.id)}
                            loading={busy}
                            variant="danger"
                            style={styles.actionBtn}
                          />
                        </>
                      ) : null}
                    </View>
                  </View>
                ) : (
                  <Text style={styles.tapHint}>Tap for items & actions</Text>
                )}
              </Pressable>
            )
          }}
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
  summaryRow: {
    flexDirection: 'row',
    gap: spacing.sm,
    padding: spacing.lg,
    paddingBottom: spacing.sm,
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
  cardTitles: { flex: 1 },
  orderNo: {
    ...typography.bodyMedium,
    color: colors.text,
    fontFamily: 'DMSans_700Bold',
  },
  customer: {
    ...typography.caption,
    color: colors.textSecondary,
    fontFamily: 'DMSans_400Regular',
    marginTop: 2,
  },
  status: {
    fontSize: 11,
    fontWeight: '600',
    fontFamily: 'DMSans_500Medium',
  },
  metaRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: spacing.sm,
  },
  amount: {
    ...typography.mono,
    color: colors.text,
    fontSize: 13,
  },
  when: {
    ...typography.caption,
    color: colors.textMuted,
    fontFamily: 'DMSans_400Regular',
  },
  tapHint: {
    ...typography.caption,
    color: colors.textMuted,
    fontFamily: 'DMSans_400Regular',
    marginTop: spacing.sm,
  },
  detail: { marginTop: spacing.md, gap: spacing.xs },
  line: {
    ...typography.bodySm,
    color: colors.text,
    fontFamily: 'DMSans_400Regular',
  },
  notes: {
    ...typography.caption,
    color: colors.textSecondary,
    fontFamily: 'DMSans_400Regular',
    marginTop: spacing.xs,
  },
  actions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
    marginTop: spacing.md,
  },
  actionBtn: { flexGrow: 1, minWidth: 100 },
}))
