import { useCallback, useEffect, useRef, useState } from 'react'
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
import { SearchField } from '@/components/ui/SearchField'
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
  accessionNumber?: string | null
  urgency?: string
  /** Present only once the result has been released by a senior. */
  result?: { value: string | null; unit: string | null; referenceRange: string | null; flag: string | null; isCritical: boolean } | null
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

  const [query, setQuery] = useState('')
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [loadingMore, setLoadingMore] = useState(false)
  const latest = useRef(0)

  const load = useCallback(async (q = '') => {
    if (!token) {
      setLoading(false)
      return
    }
    const request = ++latest.current
    try {
      const path = q.trim() ? `/api/mobile/lab?q=${encodeURIComponent(q.trim())}` : '/api/mobile/lab'
      const data = await apiRequest<{ orders: LabOrder[]; stats: LabStats; nextCursor?: string | null }>(path, { token })
      if (request !== latest.current) return
      setOrders(data.orders)
      setNextCursor(data.nextCursor ?? null)
      if (!q.trim()) setStats(data.stats)
    } catch {
      if (request === latest.current) setOrders([])
    } finally {
      if (request === latest.current) {
        setLoading(false)
        setRefreshing(false)
      }
    }
  }, [token])

  const loadMore = useCallback(async () => {
    if (!token || !nextCursor || loadingMore) return
    setLoadingMore(true)
    try {
      const q = query.trim() ? `&q=${encodeURIComponent(query.trim())}` : ''
      const data = await apiRequest<{ orders: LabOrder[]; nextCursor?: string | null }>(
        `/api/mobile/lab?cursor=${encodeURIComponent(nextCursor)}${q}`, { token })
      setOrders((prev) => [...prev, ...data.orders.filter((o) => !prev.some((p) => p.id === o.id))])
      setNextCursor(data.nextCursor ?? null)
    } catch {
      // keep what is on screen
    } finally {
      setLoadingMore(false)
    }
  }, [token, nextCursor, loadingMore, query])

  // Search by accession (scan or type the label) or by patient name / number.
  useEffect(() => {
    const handle = setTimeout(() => { load(query) }, query ? 350 : 0)
    return () => clearTimeout(handle)
  }, [query, load])


  return (
    <View style={styles.container}>
      <SearchField
        value={query}
        onChangeText={setQuery}
        placeholder="Accession, patient name or number"
        style={styles.search}
      />
      {!loading && !query ? (
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
              onRefresh={() => { setRefreshing(true); load(query) }}
              tintColor={colors.primary}
            />
          }
          contentContainerStyle={styles.listContent}
          onEndReachedThreshold={0.4}
          onEndReached={loadMore}
          ListEmptyComponent={
            <EmptyState
              title={query ? 'Nothing found' : 'No open orders'}
              body={query ? 'Check the accession on the label, or try the patient’s name.' : 'Lab orders for your facility will appear here.'}
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
              {item.accessionNumber ? (
                <Text style={styles.mrn}>{item.accessionNumber}{item.urgency && item.urgency !== 'ROUTINE' ? ` · ${item.urgency}` : ''}</Text>
              ) : null}
              {item.result ? (
                <View style={[styles.resultRow, item.result.isCritical ? styles.resultCritical : null]}>
                  <Text style={styles.resultValue}>
                    {item.result.value}{item.result.unit ? ` ${item.result.unit}` : ''}
                  </Text>
                  <Text style={styles.resultMeta}>
                    {item.result.isCritical ? 'CRITICAL · ' : item.result.flag && item.result.flag !== 'N' ? `${item.result.flag} · ` : ''}
                    {item.result.referenceRange ?? ''}
                  </Text>
                </View>
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
  search: { marginHorizontal: spacing.lg, marginTop: spacing.lg },
  resultRow: {
    marginTop: spacing.sm,
    padding: spacing.sm,
    borderRadius: radii.md,
    backgroundColor: colors.bgSubtle,
  },
  resultCritical: { borderWidth: 1, borderColor: colors.danger },
  resultValue: { ...typography.bodyMedium, color: colors.text, fontFamily: 'DMSans_700Bold' },
  resultMeta: { ...typography.caption, color: colors.textSecondary, fontFamily: 'DMSans_400Regular', marginTop: 2 },
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
