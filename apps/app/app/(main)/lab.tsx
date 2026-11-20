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

interface LabOrder {
  id: string
  patientName: string
  patientMrn: string | null
  testName: string
  status: string
  orderedAt: string
  orderedBy: string | null
}

interface LabStats {
  pending: number
  inProgress: number
  collected: number
}

export default function LabScreen() {
  const styles = useStyles()
  const { colors } = useTheme()
  const { token } = useAuth()
  const [orders, setOrders] = useState<LabOrder[]>([])
  const [stats, setStats] = useState<LabStats>({ pending: 0, inProgress: 0, collected: 0 })
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)

  const load = useCallback(async () => {
    if (!token) {
      setLoading(false)
      return
    }
    try {
      const data = await apiRequest<{ orders: LabOrder[]; stats: LabStats }>(
        '/api/mobile/lab',
        { token }
      )
      setOrders(data.orders)
      setStats(data.stats)
    } catch {
      setOrders([])
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }, [token])

  useEffect(() => { load() }, [load])

  return (
    <View style={styles.container}>
      {!loading ? (
        <View style={styles.statsRow}>
          <StatPill label="Pending" value={stats.pending} tone="warning" />
          <StatPill label="In Progress" value={stats.inProgress} tone="info" />
          <StatPill label="Collected" value={stats.collected} tone="success" />
        </View>
      ) : null}

      {loading ? (
        <LoadingBlock message="Loading lab orders…" />
      ) : (
        <FlatList
          data={orders}
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
              title="No pending orders"
              body="Lab orders assigned to your facility will appear here."
              icon="flask"
            />
          }
          renderItem={({ item }) => (
            <View style={styles.card}>
              <View style={styles.cardTop}>
                <View style={styles.testPill}>
                  <Text style={styles.testText}>{item.testName}</Text>
                </View>
                <StatusBadge status={item.status} />
              </View>
              <Text style={styles.patientName}>{item.patientName}</Text>
              {item.patientMrn ? (
                <Text style={styles.mrn}>MRN {item.patientMrn}</Text>
              ) : null}
              <View style={styles.cardFooter}>
                {item.orderedBy ? (
                  <Text style={styles.orderedBy}>Ordered by {item.orderedBy}</Text>
                ) : null}
                <Text style={styles.time}>{formatTime(item.orderedAt)}</Text>
              </View>
            </View>
          )}
        />
      )}
    </View>
  )
}

function StatPill({ label, value, tone }: { label: string; value: number; tone: 'warning' | 'info' | 'success' }) {
  const styles = useStyles()
  const { colors } = useTheme()
  const bg = tone === 'warning' ? colors.warningSoft : tone === 'info' ? colors.infoSoft : colors.successSoft
  const fg = tone === 'warning' ? colors.warning : tone === 'info' ? colors.info : colors.success
  return (
    <View style={[styles.statPill, { backgroundColor: bg }]}>
      <Text style={[styles.statValue, { color: fg }]}>{value}</Text>
      <Text style={styles.statLabel}>{label}</Text>
    </View>
  )
}

function formatTime(iso: string) {
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

const useStyles = makeStyles((colors) => ({
  container: { flex: 1, backgroundColor: colors.bg },
  statsRow: {
    flexDirection: 'row',
    gap: spacing.sm,
    padding: spacing.lg,
    paddingBottom: spacing.sm,
  },
  statPill: {
    flex: 1,
    borderRadius: radii.md,
    paddingVertical: spacing.md,
    alignItems: 'center',
  },
  statValue: {
    fontSize: 20,
    fontWeight: '700',
    fontFamily: 'DMSans_700Bold',
  },
  statLabel: {
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
  cardTop: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: spacing.sm,
    marginBottom: spacing.sm,
  },
  testPill: {
    alignSelf: 'flex-start',
    backgroundColor: colors.tealSoft,
    borderRadius: radii.full,
    paddingHorizontal: 10,
    paddingVertical: 3,
  },
  testText: {
    fontSize: 11,
    fontWeight: '600',
    color: colors.teal,
    fontFamily: 'DMSans_500Medium',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  patientName: {
    ...typography.bodyMedium,
    color: colors.text,
    fontFamily: 'DMSans_700Bold',
  },
  mrn: {
    ...typography.mono,
    color: colors.textMuted,
    fontSize: 11,
    marginTop: 3,
  },
  cardFooter: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginTop: spacing.sm,
  },
  orderedBy: {
    ...typography.caption,
    color: colors.textSecondary,
    fontFamily: 'DMSans_400Regular',
    flex: 1,
  },
  time: {
    ...typography.caption,
    color: colors.textMuted,
    fontFamily: 'DMSans_400Regular',
  },
}))
