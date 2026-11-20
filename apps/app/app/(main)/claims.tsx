import { useCallback, useEffect, useState } from 'react'
import {
  FlatList,
  RefreshControl,
  StyleSheet,
  Text,
  View,
} from 'react-native'
import { EmptyState } from '@/components/ui/EmptyState'
import { LoadingBlock } from '@/components/ui/LoadingBlock'
import { StatusBadge } from '@/components/ui/StatusBadge'
import { useAuth } from '@/lib/auth'
import { apiRequest } from '@/lib/api'
import { radii, spacing, typography, makeStyles, useTheme } from '@/lib/theme'

interface Claim {
  id: string
  patientName: string
  amount: number
  currency: string
  insurer: string | null
  status: string
  submittedAt: string | null
  serviceDate: string | null
}

interface ClaimsSummary {
  total: number
  pending: number
  approved: number
  rejected: number
  totalAmount: number
}

export default function ClaimsScreen() {
  const styles = useStyles()
  const { colors } = useTheme()
  const { token } = useAuth()
  const [claims, setClaims] = useState<Claim[]>([])
  const [summary, setSummary] = useState<ClaimsSummary | null>(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)

  const load = useCallback(async () => {
    if (!token) {
      setLoading(false)
      return
    }
    try {
      const data = await apiRequest<{ claims: Claim[]; summary: ClaimsSummary }>(
        '/api/mobile/claims',
        { token }
      )
      setClaims(data.claims)
      setSummary(data.summary)
    } catch {
      setClaims([])
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }, [token])

  useEffect(() => { load() }, [load])

  return (
    <View style={styles.container}>
      {!loading && summary ? (
        <View style={styles.summaryCard}>
          <View style={styles.summaryRow}>
            <SummaryItem label="Total" value={summary.total} color={colors.text} />
            <SummaryItem label="Pending" value={summary.pending} color={colors.warning} />
            <SummaryItem label="Approved" value={summary.approved} color={colors.success} />
            <SummaryItem label="Rejected" value={summary.rejected} color={colors.danger} />
          </View>
          {summary.totalAmount > 0 ? (
            <Text style={styles.totalAmount}>
              Total: UGX {summary.totalAmount.toLocaleString()}
            </Text>
          ) : null}
        </View>
      ) : null}

      {loading ? (
        <LoadingBlock message="Loading claims…" />
      ) : (
        <FlatList
          data={claims}
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
              title="No claims yet"
              body="Submitted insurance claims will appear here."
              icon="receipt"
            />
          }
          renderItem={({ item }) => (
            <View style={styles.card}>
              <View style={styles.cardTop}>
                <Text style={styles.patientName} numberOfLines={1}>{item.patientName}</Text>
                <StatusBadge status={item.status} />
              </View>
              <View style={styles.metaRow}>
                <Text style={styles.amount}>
                  {item.currency ?? 'UGX'} {item.amount.toLocaleString()}
                </Text>
                {item.insurer ? (
                  <Text style={styles.insurer}>{item.insurer}</Text>
                ) : null}
              </View>
              {item.serviceDate ? (
                <Text style={styles.date}>Service: {formatDate(item.serviceDate)}</Text>
              ) : null}
              {item.submittedAt ? (
                <Text style={styles.date}>Submitted: {formatDate(item.submittedAt)}</Text>
              ) : null}
            </View>
          )}
        />
      )}
    </View>
  )
}

function SummaryItem({ label, value, color }: { label: string; value: number; color: string }) {
  const styles = useStyles()
  return (
    <View style={styles.summaryItem}>
      <Text style={[styles.summaryValue, { color }]}>{value}</Text>
      <Text style={styles.summaryLabel}>{label}</Text>
    </View>
  )
}

function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' })
}

const useStyles = makeStyles((colors) => ({
  container: { flex: 1, backgroundColor: colors.bg },
  summaryCard: {
    margin: spacing.lg,
    marginBottom: spacing.sm,
    backgroundColor: colors.surface,
    borderRadius: radii.lg,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.lg,
  },
  summaryRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  summaryItem: { alignItems: 'center' },
  summaryValue: {
    fontSize: 20,
    fontWeight: '700',
    fontFamily: 'DMSans_700Bold',
  },
  summaryLabel: {
    ...typography.caption,
    color: colors.textSecondary,
    fontFamily: 'DMSans_400Regular',
    marginTop: 2,
  },
  totalAmount: {
    ...typography.bodySm,
    color: colors.textMuted,
    fontFamily: 'DMSans_400Regular',
    marginTop: spacing.md,
    textAlign: 'right',
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
  cardTop: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: spacing.sm,
    marginBottom: spacing.sm,
  },
  patientName: {
    ...typography.bodyMedium,
    color: colors.text,
    fontFamily: 'DMSans_700Bold',
    flex: 1,
  },
  metaRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  amount: {
    ...typography.mono,
    color: colors.primary,
    fontSize: 15,
  },
  insurer: {
    ...typography.caption,
    color: colors.teal,
    fontFamily: 'DMSans_500Medium',
  },
  date: {
    ...typography.caption,
    color: colors.textMuted,
    fontFamily: 'DMSans_400Regular',
    marginTop: 4,
  },
}))
