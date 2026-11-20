import { useCallback, useEffect, useState } from 'react'
import {
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import { useRouter } from 'expo-router'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { Button } from '@/components/ui/Button'
import { EmptyState } from '@/components/ui/EmptyState'
import { LoadingBlock } from '@/components/ui/LoadingBlock'
import { useAuth } from '@/lib/auth'
import {
  getPharmacySyncStatus,
  listPharmacySyncCommands,
  syncPharmacySales,
  type OfflineOutboxListItem,
} from '@/lib/offline-store'
import { radii, spacing, typography, makeStyles, useTheme } from '@/lib/theme'

function statusCopy(item: OfflineOutboxListItem): { label: string; detail: string } {
  switch (item.status) {
    case 'queued':
    case 'syncing':
    case 'applied':
      return {
        label: 'Pending sync',
        detail: item.lastError
          ? `Retrying. Last error: ${item.lastError}`
          : 'Saved on this device. Waiting for the server acknowledgement.',
      }
    case 'conflict':
      return {
        label: 'Needs review',
        detail: item.lastError ?? 'Command id reused with different content. Do not overwrite.',
      }
    case 'rejected':
      return {
        label: 'Failed',
        detail: item.lastError ?? 'The server refused this command. Stock was not taken.',
      }
    default:
      return { label: item.status, detail: item.lastError ?? 'See command details.' }
  }
}

export default function SyncStatusScreen() {
  const styles = useStyles()
  const { colors } = useTheme()
  const { token, user } = useAuth()
  const router = useRouter()
  const insets = useSafeAreaInsets()
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [items, setItems] = useState<OfflineOutboxListItem[]>([])
  const [summary, setSummary] = useState({ pending: 0, conflicts: 0, rejected: 0 })
  const [flushNote, setFlushNote] = useState<string | null>(null)

  const load = useCallback(async () => {
    if (!user?.tenantId) {
      setLoading(false)
      return
    }
    const [list, status] = await Promise.all([
      listPharmacySyncCommands(user.tenantId),
      getPharmacySyncStatus(user.tenantId),
    ])
    setItems(list)
    setSummary(status)
  }, [user?.tenantId])

  useEffect(() => {
    load().finally(() => setLoading(false))
  }, [load])

  const retry = async () => {
    if (!token || !user?.tenantId) return
    setFlushNote(null)
    setRefreshing(true)
    try {
      const result = await syncPharmacySales(user.tenantId, token)
      setFlushNote(
        `Processed ${result.processed}. Synced ${result.acknowledged}, replayed ${result.replayed}, rejected ${result.rejected}, needs review ${result.conflicts}, still queued ${result.retrying}.`,
      )
      await load()
    } catch (error) {
      setFlushNote(error instanceof Error ? error.message : 'Sync failed')
    } finally {
      setRefreshing(false)
    }
  }

  return (
    <View style={[styles.root, { paddingTop: insets.top }]}>
      <View style={styles.header}>
        <Pressable
          onPress={() => router.back()}
          hitSlop={12}
          style={styles.backBtn}
          accessibilityRole="button"
          accessibilityLabel="Go back"
        >
          <Ionicons name="chevron-back" size={22} color={colors.primary} />
        </Pressable>
        <Text style={styles.title} accessibilityRole="header">
          Sync status
        </Text>
        <View style={{ width: 40 }} />
      </View>

      <View style={styles.summary} accessibilityRole="text" accessibilityLabel={`Pending sync ${summary.pending}. Needs review ${summary.conflicts}. Failed ${summary.rejected}.`}>
        <Text style={styles.summaryText}>Pending sync: {summary.pending}</Text>
        <Text style={styles.summaryText}>Needs review: {summary.conflicts}</Text>
        <Text style={styles.summaryText}>Failed: {summary.rejected}</Text>
      </View>

      {flushNote ? <Text style={styles.note}>{flushNote}</Text> : null}

      {loading ? (
        <LoadingBlock message="Loading commands…" />
      ) : (
        <ScrollView
          contentContainerStyle={{ paddingBottom: insets.bottom + spacing.xl }}
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={() => void retry()} tintColor={colors.primary} />
          }
        >
          {items.length === 0 ? (
            <EmptyState
              title="Synced"
              body="No pending, failed, or review commands on this device."
              icon="checkmark-circle"
            />
          ) : (
            items.map((item) => {
              const copy = statusCopy(item)
              return (
                <View
                  key={item.commandId}
                  style={styles.card}
                  accessibilityRole="text"
                  accessibilityLabel={`${copy.label}. ${copy.detail}`}
                >
                  <Text style={styles.cardLabel}>{copy.label}</Text>
                  <Text style={styles.cardMeta}>{item.commandType}</Text>
                  <Text style={styles.cardDetail}>{copy.detail}</Text>
                  <Text style={styles.cardId} selectable>
                    {item.commandId}
                  </Text>
                </View>
              )
            })
          )}
        </ScrollView>
      )}

      <View style={[styles.footer, { paddingBottom: insets.bottom + spacing.md }]}>
        <Button label="Retry sync now" onPress={() => void retry()} loading={refreshing} />
      </View>
    </View>
  )
}

const useStyles = makeStyles((colors) => ({
  root: { flex: 1, backgroundColor: colors.bg },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
  },
  backBtn: { width: 40 },
  title: { ...typography.h2, color: colors.text, fontFamily: 'DMSans_700Bold' },
  summary: {
    marginHorizontal: spacing.lg,
    marginBottom: spacing.md,
    padding: spacing.md,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.bgElevated,
    gap: 4,
  },
  summaryText: {
    ...typography.bodySm,
    color: colors.text,
    fontFamily: 'DMSans_500Medium',
  },
  note: {
    marginHorizontal: spacing.lg,
    marginBottom: spacing.sm,
    color: colors.textSecondary,
    fontFamily: 'DMSans_400Regular',
    fontSize: 13,
  },
  card: {
    marginHorizontal: spacing.lg,
    marginBottom: spacing.sm,
    padding: spacing.md,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    gap: 4,
  },
  cardLabel: { color: colors.text, fontFamily: 'DMSans_700Bold', fontSize: 15 },
  cardMeta: { color: colors.textMuted, fontFamily: 'IBMPlexMono_400Regular', fontSize: 12 },
  cardDetail: { color: colors.textSecondary, fontFamily: 'DMSans_400Regular', fontSize: 13 },
  cardId: { color: colors.textMuted, fontFamily: 'IBMPlexMono_400Regular', fontSize: 11 },
  footer: { paddingHorizontal: spacing.lg, paddingTop: spacing.sm },
}))
