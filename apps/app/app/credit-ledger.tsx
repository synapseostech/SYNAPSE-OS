import { useCallback, useState } from 'react'
import { StyleSheet, Text, View } from 'react-native'
import { useFocusEffect, useRouter } from 'expo-router'
import { ScreenShell } from '@/components/ui/ScreenShell'
import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { EmptyState } from '@/components/ui/EmptyState'
import { LoadingBlock } from '@/components/ui/LoadingBlock'
import { useAuth } from '@/lib/auth'
import { ApiError, apiRequest } from '@/lib/api'
import { radii, spacing, typography, useTheme } from '@/lib/theme'

interface LedgerSummary {
  totalOutstanding: number
  overdueOutstanding: number
  creditCustomers: number
  overdueCustomers: number
}

interface LedgerEntry {
  id: string
  customerId: string | null
  customerName: string | null
  amount: number
  type: string
  balanceAfter: number
  dueDate: string | null
  notes: string | null
  createdAt: string | null
}

interface LedgerData {
  summary: LedgerSummary
  entries: LedgerEntry[]
}

function todayIso(): string {
  const now = new Date()
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
}

export default function CreditLedgerScreen() {
  const { token } = useAuth()
  const { colors } = useTheme()
  const router = useRouter()
  const [data, setData] = useState<LedgerData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    if (!token) {
      setLoading(false)
      return
    }
    setLoading(true)
    setError(null)
    try {
      const result = await apiRequest<LedgerData>('/api/mobile/pharmacy/credit-ledger', { token })
      setData(result)
    } catch (err) {
      setData(null)
      setError(
        err instanceof ApiError && err.status === 403
          ? 'Your role does not include the customer credit permission.'
          : 'Could not load the credit ledger.',
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

  const money = (value: number) => `UGX ${Number(value ?? 0).toLocaleString()}`
  const today = todayIso()

  return (
    <ScreenShell
      title="Credit ledger"
      contentStyle={styles.content}
      footer={<Button label="Record entry" onPress={() => router.push('/credit-entry' as never)} />}
    >
      {loading ? (
        <LoadingBlock message="Loading credit accounts…" />
      ) : error ? (
        <Card>
          <Text style={[styles.message, { color: colors.textSecondary }]}>{error}</Text>
        </Card>
      ) : !data ? null : (
        <>
          <View style={styles.stats}>
            <Stat label="Outstanding" value={money(data.summary.totalOutstanding)} tone="primary" />
            <Stat label="Overdue" value={money(data.summary.overdueOutstanding)} tone="danger" />
            <Stat label="With credit" value={String(data.summary.creditCustomers)} />
            <Stat label="Overdue customers" value={String(data.summary.overdueCustomers)} tone="danger" />
          </View>

          <Text style={[styles.heading, { color: colors.textSecondary }]}>
            {data.entries.length === 0
              ? 'No ledger entries'
              : `${data.entries.length} most recent entries`}
          </Text>

          {data.entries.length === 0 ? (
            <EmptyState
              icon="cash"
              title="Nothing on credit yet"
              body="Record a credit sale when a customer takes goods on account, then log repayments here."
            />
          ) : (
            <View style={styles.list}>
              {data.entries.map((entry) => {
                const isRepayment = entry.type === 'repayment'
                const overdue =
                  !isRepayment && entry.balanceAfter > 0 && Boolean(entry.dueDate && entry.dueDate < today)
                return (
                  <Card key={entry.id}>
                    <View style={styles.entryTop}>
                      <Text style={[styles.entryName, { color: colors.text }]} numberOfLines={1}>
                        {entry.customerName ?? 'Customer'}
                      </Text>
                      <Text
                        style={[
                          styles.entryAmount,
                          { color: isRepayment ? colors.success : colors.text },
                        ]}
                      >
                        {isRepayment ? '−' : '+'}
                        {money(entry.amount)}
                      </Text>
                    </View>
                    <Text style={[styles.entryMeta, { color: colors.textMuted }]}>
                      {isRepayment ? 'Repayment' : 'Credit sale'} · balance {money(entry.balanceAfter)}
                      {entry.dueDate ? ` · due ${entry.dueDate}` : ''}
                      {entry.createdAt ? ` · ${entry.createdAt.slice(0, 10)}` : ''}
                    </Text>
                    {overdue ? (
                      <Text style={[styles.overdue, { color: colors.error }]}>Overdue</Text>
                    ) : null}
                    {entry.notes ? (
                      <Text style={[styles.notes, { color: colors.textSecondary }]}>{entry.notes}</Text>
                    ) : null}
                  </Card>
                )
              })}
            </View>
          )}
        </>
      )}
    </ScreenShell>
  )
}

function Stat({
  label,
  value,
  tone,
}: {
  label: string
  value: string
  tone?: 'primary' | 'danger'
}) {
  const { colors } = useTheme()
  const color =
    tone === 'primary' ? colors.primary : tone === 'danger' ? colors.error : colors.text
  return (
    <View style={[styles.stat, { backgroundColor: colors.surface, borderColor: colors.border }]}>
      <Text style={[styles.statValue, { color }]} numberOfLines={1}>
        {value}
      </Text>
      <Text style={[styles.statLabel, { color: colors.textMuted }]}>{label}</Text>
    </View>
  )
}

const styles = StyleSheet.create({
  content: { gap: spacing.md },
  stats: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  stat: {
    width: '48%',
    borderWidth: 1,
    borderRadius: radii.md,
    padding: spacing.md,
  },
  statValue: { ...typography.bodyMedium, fontFamily: 'IBMPlexMono_500Medium' },
  statLabel: { ...typography.caption, marginTop: 2 },
  heading: { ...typography.label, marginTop: spacing.sm },
  list: { gap: spacing.sm },
  entryTop: { flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between', gap: spacing.sm },
  entryName: { ...typography.bodyMedium, fontFamily: 'DMSans_500Medium', flex: 1 },
  entryAmount: { ...typography.bodyMedium, fontFamily: 'IBMPlexMono_500Medium' },
  entryMeta: { ...typography.caption, marginTop: spacing.xs },
  overdue: { ...typography.caption, fontFamily: 'DMSans_700Bold', marginTop: spacing.xs },
  notes: { ...typography.bodySm, marginTop: spacing.xs },
  message: { ...typography.bodySm },
})
