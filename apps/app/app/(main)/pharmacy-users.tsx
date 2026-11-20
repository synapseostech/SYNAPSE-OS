import { useCallback, useEffect, useState } from 'react'
import { FlatList, RefreshControl, StyleSheet, Text, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { EmptyState } from '@/components/ui/EmptyState'
import { LoadingBlock } from '@/components/ui/LoadingBlock'
import { useAuth } from '@/lib/auth'
import { fetchPharmacyUsers, type PharmacyStaffUser } from '@/lib/api'
import { radii, spacing, tabBarHeight, typography, TONE_COLORS, makeStyles, useTheme } from '@/lib/theme'

export default function PharmacyUsersScreen() {
  const styles = useStyles()
  const { colors } = useTheme()
  const { token } = useAuth()
  const insets = useSafeAreaInsets()
  const [users, setUsers] = useState<PharmacyStaffUser[]>([])
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)

  const load = useCallback(async () => {
    if (!token) {
      setLoading(false)
      return
    }
    try {
      const data = await fetchPharmacyUsers(token)
      setUsers(data.users)
    } catch {
      setUsers([])
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }, [token])

  useEffect(() => {
    load()
  }, [load])

  if (loading) {
    return (
      <View style={styles.container}>
        <LoadingBlock message="Loading staff…" />
      </View>
    )
  }

  return (
    <View style={styles.container}>
      <FlatList
        data={users}
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
        contentContainerStyle={[
          styles.list,
          { paddingBottom: insets.bottom + tabBarHeight + spacing.lg },
        ]}
        ListEmptyComponent={
          <EmptyState title="No staff listed" body="Staff accounts will appear here." icon="inbox" />
        }
        ListHeaderComponent={
          <Text style={styles.hint}>Read-only staff directory for this pharmacy.</Text>
        }
        renderItem={({ item }) => (
          <View style={styles.card}>
            <View style={styles.row}>
              <Text style={styles.name}>{item.name || item.email || 'Staff'}</Text>
              <Text
                style={[
                  styles.badge,
                  { color: item.isActive ? TONE_COLORS.green : TONE_COLORS.red },
                ]}
              >
                {item.isActive ? 'Active' : 'Inactive'}
              </Text>
            </View>
            <Text style={styles.meta}>{item.email || '—'}</Text>
            <Text style={styles.meta}>
              {item.role?.replace(/_/g, ' ') ?? 'staff'}
              {item.username ? ` · @${item.username}` : ''}
            </Text>
          </View>
        )}
      />
    </View>
  )
}

const useStyles = makeStyles((colors) => ({
  container: { flex: 1, backgroundColor: colors.bg },
  list: { padding: spacing.lg },
  hint: {
    color: colors.textMuted,
    fontFamily: 'DMSans_400Regular',
    marginBottom: spacing.lg,
    fontSize: 13,
  },
  card: {
    backgroundColor: colors.bgElevated,
    borderRadius: radii.lg,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.lg,
    marginBottom: spacing.md,
  },
  row: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  name: { ...typography.bodyMedium, color: colors.text, fontFamily: 'DMSans_700Bold', flex: 1 },
  badge: { fontFamily: 'DMSans_500Medium', fontSize: 12 },
  meta: {
    color: colors.textSecondary,
    fontFamily: 'DMSans_400Regular',
    marginTop: 4,
    fontSize: 13,
  },
}))
