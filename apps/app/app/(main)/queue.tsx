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
import { Ionicons } from '@expo/vector-icons'
import { EmptyState } from '@/components/ui/EmptyState'
import { LoadingBlock } from '@/components/ui/LoadingBlock'
import { StatusBadge } from '@/components/ui/StatusBadge'
import { useAuth } from '@/lib/auth'
import { apiRequest } from '@/lib/api'
import { radii, spacing, typography, makeStyles, useTheme } from '@/lib/theme'

interface QueueItem {
  encounterId: string
  status: string
  chiefComplaint: string | null
  clinicalStage: string | null
  createdAt: string
  patient: {
    id: string
    fullName: string
    mrn: string | null
  } | null
}

interface QueueStats {
  waiting: number
  inProgress: number
  completed: number
}


export default function QueueScreen() {
  const styles = useStyles()
  const { colors } = useTheme()
  const { token } = useAuth()
  const router = useRouter()
  const [queue, setQueue] = useState<QueueItem[]>([])
  const [stats, setStats] = useState<QueueStats>({ waiting: 0, inProgress: 0, completed: 0 })
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)

  const load = useCallback(async () => {
    if (!token) {
      setLoading(false)
      return
    }
    try {
      const data = await apiRequest<{ queue: QueueItem[]; stats: QueueStats }>(
        '/api/mobile/queue',
        { token }
      )
      setQueue(data.queue)
      setStats(data.stats)
    } catch {
      setQueue([])
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }, [token])

  useEffect(() => { load() }, [load])

  const openEncounter = (item: QueueItem) => {
    router.push(`/encounter/${item.encounterId}` as never)
  }

  return (
    <View style={styles.container}>
      {!loading ? (
        <View style={styles.statsRow}>
          <StatPill label="Waiting" value={stats.waiting} tone="warning" />
          <StatPill label="In progress" value={stats.inProgress} tone="info" />
          <StatPill label="Done" value={stats.completed} tone="success" />
        </View>
      ) : null}

      {loading ? (
        <LoadingBlock message="Loading queue…" />
      ) : (
        <FlatList
          data={queue}
          keyExtractor={(item) => item.encounterId}
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
              title="Queue is clear"
              body="No encounters scheduled for today. Pull down to refresh."
              icon="checkmark-circle"
            />
          }
          renderItem={({ item }) => (
            <Pressable
              style={({ pressed }) => [styles.card, pressed && styles.cardPressed]}
              onPress={() => openEncounter(item)}
            >
              <View style={styles.cardTop}>
                <Text style={styles.patientName}>
                  {item.patient?.fullName ?? 'Unknown patient'}
                </Text>
                <StatusBadge status={item.status} />
              </View>
              {item.patient?.mrn ? (
                <Text style={styles.mrn}>MRN {item.patient.mrn}</Text>
              ) : null}
              {item.chiefComplaint ? (
                <Text style={styles.complaint} numberOfLines={2}>{item.chiefComplaint}</Text>
              ) : null}
              <Text style={styles.time}>{formatTime(item.createdAt)}</Text>
            </Pressable>
          )}
        />
      )}
    </View>
  )
}

function StatPill({
  label,
  value,
  tone,
}: {
  label: string
  value: number
  tone: 'warning' | 'info' | 'success'
}) {
  const styles = useStyles()
  const { colors } = useTheme()
  const bg =
    tone === 'warning' ? colors.warningSoft : tone === 'info' ? colors.infoSoft : colors.successSoft
  const fg =
    tone === 'warning' ? colors.warning : tone === 'info' ? colors.info : colors.success

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
    ...typography.stat,
    fontSize: 20,
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
  cardPressed: { backgroundColor: colors.surfaceHover },
  cardTop: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: spacing.sm,
  },
  patientName: {
    ...typography.bodyMedium,
    color: colors.text,
    fontFamily: 'DMSans_700Bold',
    flex: 1,
  },
  mrn: {
    ...typography.mono,
    color: colors.textMuted,
    fontSize: 11,
    marginTop: 4,
  },
  complaint: {
    ...typography.bodySm,
    color: colors.textSecondary,
    fontFamily: 'DMSans_400Regular',
    marginTop: spacing.sm,
  },
  time: {
    ...typography.caption,
    color: colors.textMuted,
    fontFamily: 'DMSans_400Regular',
    marginTop: spacing.sm,
  },
}))
