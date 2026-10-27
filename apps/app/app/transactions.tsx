import { useCallback, useMemo, useState } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import { useFocusEffect } from 'expo-router'
import { ScreenShell } from '@/components/ui/ScreenShell'
import { Card } from '@/components/ui/Card'
import { EmptyState } from '@/components/ui/EmptyState'
import { LoadingBlock } from '@/components/ui/LoadingBlock'
import { TextField } from '@/components/ui/TextField'
import { useAuth } from '@/lib/auth'
import { ApiError, apiRequest } from '@/lib/api'
import { radii, spacing, typography, useTheme } from '@/lib/theme'

interface TransactionItem {
  id: string
  name: string
  sku: string | null
  quantity: number
  unitPrice: number
  totalPrice: number
  batchNumber: string | null
  expiryDate: string | null
}

interface Transaction {
  id: string
  source: 'pos' | 'order' | string
  status: 'COMPLETED' | 'REFUNDED' | string
  receiptNumber: string
  totalAmount: number
  netAmount: number
  discount: number
  tax: number
  paymentMethod: string | null
  cashierName: string | null
  clientName: string | null
  createdAt: string
  items: TransactionItem[]
}

interface Stats {
  today: number
  week: number
  month: number
  count: number
  todayProfit?: number
  weekProfit?: number
  monthProfit?: number
}

interface TransactionsData {
  currency: string
  transactions: Transaction[]
  stats: Stats
}

function formatWhen(iso: string): string {
  return new Date(iso).toLocaleString([], {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  })
}

export default function TransactionsScreen() {
  const { token } = useAuth()
  const { colors } = useTheme()
  const [data, setData] = useState<TransactionsData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [expandedId, setExpandedId] = useState<string | null>(null)

  const load = useCallback(async () => {
    if (!token) {
      setLoading(false)
      return
    }
    setLoading(true)
    setError(null)
    try {
      const result = await apiRequest<TransactionsData>(
        '/api/mobile/pharmacy/transactions?limit=100',
        { token },
      )
      setData(result)
    } catch (err) {
      setData(null)
      setError(
        err instanceof ApiError && err.status === 403
          ? 'Your role does not include sales history.'
          : 'Could not load transactions.',
      )
    } finally {
      setLoading(false)
    }
  }, [token])

  useFocusEffect(
    useCallback(() => {
      void load()
    }, [load]),
  )

  const currency = data?.currency ?? 'UGX'
  const money = (value: number) => `${currency} ${Number(value ?? 0).toLocaleString()}`

  const visible = useMemo(() => {
    const rows = data?.transactions ?? []
    const needle = query.trim().toLowerCase()
    if (!needle) return rows
    return rows.filter((row) =>
      [
        row.receiptNumber,
        row.clientName,
        row.cashierName,
        row.paymentMethod,
        ...row.items.map((item) => item.name),
      ]
        .filter(Boolean)
        .some((value) => String(value).toLowerCase().includes(needle)),
    )
  }, [data, query])

  return (
    <ScreenShell title="Transactions" contentStyle={styles.content}>
      {loading ? (
        <LoadingBlock message="Loading transactions…" />
      ) : error ? (
        <Card>
          <Text style={[styles.message, { color: colors.textSecondary }]}>{error}</Text>
        </Card>
      ) : !data ? null : (
        <>
          <View style={styles.stats}>
            <Stat label="Today" value={money(data.stats.today)} />
            <Stat label="Last 7 days" value={money(data.stats.week)} />
            <Stat label="Last 30 days" value={money(data.stats.month)} />
            <Stat label="Sales shown" value={String(data.stats.count)} />
          </View>

          {typeof data.stats.weekProfit === 'number' ? (
            <Card>
              <Text style={[styles.profitLabel, { color: colors.textMuted }]}>Profit</Text>
              <Text style={[styles.profitValue, { color: colors.text }]}>
                Today {money(data.stats.todayProfit ?? 0)} · 7 days {money(data.stats.weekProfit)} · 30
                days {money(data.stats.monthProfit ?? 0)}
              </Text>
            </Card>
          ) : null}

          <TextField
            label="Search"
            value={query}
            onChangeText={setQuery}
            placeholder="Receipt, customer, cashier or item"
            autoCapitalize="none"
          />

          {visible.length === 0 ? (
            <EmptyState
              icon="receipt"
              title={data.transactions.length === 0 ? 'No transactions yet' : 'No matches'}
              body={
                data.transactions.length === 0
                  ? 'Completed counter and customer sales will appear here.'
                  : 'Try a different receipt number, customer or item.'
              }
            />
          ) : (
            <View style={styles.list}>
              {visible.map((row) => {
                const expanded = row.id === expandedId
                const refunded = row.status === 'REFUNDED'
                return (
                  <Card key={row.id} padded={false}>
                    <Pressable
                      onPress={() => setExpandedId(expanded ? null : row.id)}
                      accessibilityRole="button"
                      accessibilityState={{ expanded }}
                      accessibilityHint="Show sale items"
                      style={({ pressed }) => [styles.row, pressed && { opacity: 0.85 }]}
                    >
                      <View style={styles.rowTop}>
                        <Text style={[styles.receipt, { color: colors.text }]} numberOfLines={1}>
                          {row.receiptNumber || 'No receipt number'}
                        </Text>
                        <Text
                          style={[
                            styles.status,
                            { color: refunded ? colors.error : colors.success },
                          ]}
                        >
                          {row.status}
                        </Text>
                      </View>
                      <Text
                        style={[
                          styles.amount,
                          { color: refunded ? colors.textMuted : colors.text },
                          refunded && styles.amountVoided,
                        ]}
                      >
                        {money(row.netAmount)}
                      </Text>
                      <Text style={[styles.meta, { color: colors.textMuted }]} numberOfLines={1}>
                        {row.paymentMethod ?? '—'}
                        {row.clientName ? ` · ${row.clientName}` : ''}
                        {row.cashierName ? ` · ${row.cashierName}` : ''}
                      </Text>
                      <View style={styles.metaRow}>
                        <Text style={[styles.meta, { color: colors.textMuted }]}>
                          {formatWhen(row.createdAt)} · {row.items.length} item
                          {row.items.length === 1 ? '' : 's'}
                        </Text>
                        <Text style={[styles.expand, { color: colors.primary }]}>
                          {expanded ? 'Hide items' : 'Items'}
                        </Text>
                      </View>
                    </Pressable>

                    {expanded ? (
                      <View style={[styles.items, { borderTopColor: colors.borderSubtle }]}>
                        {row.items.length === 0 ? (
                          <Text style={[styles.meta, { color: colors.textMuted }]}>
                            No line items were found for this sale.
                          </Text>
                        ) : (
                          row.items.map((item) => (
                            <View key={item.id} style={styles.itemRow}>
                              <View style={styles.itemCopy}>
                                <Text
                                  style={[styles.itemName, { color: colors.text }]}
                                  numberOfLines={2}
                                >
                                  {item.name}
                                </Text>
                                <Text style={[styles.meta, { color: colors.textMuted }]}>
                                  {item.quantity} × {money(item.unitPrice)}
                                  {item.batchNumber ? ` · batch ${item.batchNumber}` : ''}
                                  {item.expiryDate ? ` · exp ${item.expiryDate}` : ''}
                                </Text>
                              </View>
                              <Text style={[styles.itemTotal, { color: colors.textSecondary }]}>
                                {money(item.totalPrice)}
                              </Text>
                            </View>
                          ))
                        )}
                        {row.discount > 0 || row.tax > 0 ? (
                          <Text style={[styles.totals, { color: colors.textMuted }]}>
                            {row.discount > 0 ? `Discount ${money(row.discount)}` : ''}
                            {row.discount > 0 && row.tax > 0 ? ' · ' : ''}
                            {row.tax > 0 ? `Tax ${money(row.tax)}` : ''}
                          </Text>
                        ) : null}
                        <Text style={[styles.totals, { color: colors.textMuted }]}>
                          {row.source === 'order' ? 'Customer order' : 'Counter sale'} · subtotal{' '}
                          {money(row.totalAmount)}
                        </Text>
                      </View>
                    ) : null}
                  </Card>
                )
              })}
            </View>
          )}

          <Text style={[styles.footnote, { color: colors.textMuted }]}>
            Read-only history. Sales, refunds and client-name edits stay in the web portal.
          </Text>
        </>
      )}
    </ScreenShell>
  )
}

function Stat({ label, value }: { label: string; value: string }) {
  const { colors } = useTheme()
  return (
    <View style={[styles.stat, { backgroundColor: colors.surface, borderColor: colors.border }]}>
      <Text style={[styles.statValue, { color: colors.text }]} numberOfLines={1}>
        {value}
      </Text>
      <Text style={[styles.statLabel, { color: colors.textMuted }]}>{label}</Text>
    </View>
  )
}

const styles = StyleSheet.create({
  content: { gap: spacing.md },
  stats: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  stat: { width: '48%', borderWidth: 1, borderRadius: radii.md, padding: spacing.md },
  statValue: { ...typography.caption, fontFamily: 'IBMPlexMono_500Medium' },
  statLabel: { ...typography.caption, marginTop: 2 },
  profitLabel: { ...typography.caption },
  profitValue: { ...typography.bodySm, fontFamily: 'IBMPlexMono_400Regular', marginTop: 2 },
  list: { gap: spacing.sm },
  row: { padding: spacing.lg },
  rowTop: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: spacing.sm },
  receipt: { ...typography.bodyMedium, fontFamily: 'DMSans_700Bold', flex: 1 },
  status: { fontSize: 11, fontWeight: '600', fontFamily: 'DMSans_500Medium' },
  amount: { ...typography.mono, fontSize: 16, marginTop: spacing.sm },
  amountVoided: { textDecorationLine: 'line-through' },
  meta: { ...typography.caption, marginTop: 2 },
  metaRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: spacing.sm },
  expand: { ...typography.caption, fontFamily: 'DMSans_500Medium' },
  items: { borderTopWidth: 1, paddingHorizontal: spacing.lg, paddingVertical: spacing.md, gap: spacing.sm },
  itemRow: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.md },
  itemCopy: { flex: 1 },
  itemName: { ...typography.bodySm },
  itemTotal: { ...typography.caption, fontFamily: 'IBMPlexMono_400Regular' },
  totals: { ...typography.caption },
  message: { ...typography.bodySm },
  footnote: { ...typography.caption, marginTop: spacing.md, lineHeight: 18 },
})
