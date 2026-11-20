import { useCallback, useEffect, useMemo, useState } from 'react'
import { FlatList, RefreshControl, Text, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { AvatarEditor } from '@/components/AvatarEditor'
import { Avatar } from '@/components/ui/Avatar'
import { EmptyState, ErrorState } from '@/components/ui/EmptyState'
import { LoadingBlock } from '@/components/ui/LoadingBlock'
import { SearchField } from '@/components/ui/SearchField'
import { useAuth } from '@/lib/auth'
import { fetchPharmacyUsers, type PharmacyStaffUser } from '@/lib/api'
import { formatRole } from '@/lib/roles'
import { makeStyles, radii, spacing, tabBarHeight, typography, useTheme } from '@/lib/theme'

type StaffWithManage = PharmacyStaffUser

export default function PharmacyUsersScreen() {
  const styles = useStyles()
  const { colors } = useTheme()
  const { token, user } = useAuth()
  const insets = useSafeAreaInsets()
  const [users, setUsers] = useState<StaffWithManage[]>([])
  const [canManage, setCanManage] = useState(false)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [query, setQuery] = useState('')

  const load = useCallback(async () => {
    if (!token) {
      setLoading(false)
      return
    }
    try {
      const data = await fetchPharmacyUsers(token)
      setUsers(data.users)
      setCanManage(Boolean(data.canManage))
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load staff')
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }, [token])

  useEffect(() => {
    load()
  }, [load])

  const setAvatar = useCallback((id: string, url: string | null) => {
    setUsers((prev) => prev.map((u) => (u.id === id ? { ...u, avatarUrl: url } : u)))
  }, [])

  const q = query.trim().toLowerCase()
  const visible = useMemo(
    () =>
      q
        ? users.filter((u) =>
            `${u.name} ${u.email} ${u.username ?? ''} ${u.role ?? ''}`.toLowerCase().includes(q),
          )
        : users,
    [users, q],
  )
  const activeCount = users.filter((u) => u.isActive).length

  if (loading) {
    return (
      <View style={[styles.container, styles.padded]}>
        <LoadingBlock message="Loading staff…" avatar />
      </View>
    )
  }

  if (error && users.length === 0) {
    return (
      <View style={[styles.container, styles.padded]}>
        <ErrorState
          message={error}
          onRetry={() => {
            setLoading(true)
            load()
          }}
        />
      </View>
    )
  }

  return (
    <View style={styles.container}>
      <FlatList
        data={visible}
        keyExtractor={(item) => item.id}
        keyboardShouldPersistTaps="handled"
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
        contentContainerStyle={[styles.list, { paddingBottom: insets.bottom + tabBarHeight + spacing.lg }]}
        ListEmptyComponent={
          q ? (
            <EmptyState
              icon="search"
              title="No one matches"
              body={`No staff member matches “${query.trim()}”.`}
              actionLabel="Clear search"
              onAction={() => setQuery('')}
            />
          ) : (
            <EmptyState title="No staff listed" body="Staff accounts will appear here." icon="people" />
          )
        }
        ListHeaderComponent={
          <View style={styles.header}>
            <Text style={styles.summary}>
              {users.length} staff · {activeCount} active
            </Text>
            <Text style={styles.hint}>
              {canManage
                ? 'Tap a face to set that person’s photo. Manage roles under Staff & users.'
                : 'Everyone working at this pharmacy. Set your own photo from More.'}
            </Text>
            {users.length > 5 ? (
              <SearchField
                value={query}
                onChangeText={setQuery}
                placeholder="Search staff by name, email or role"
                style={styles.search}
              />
            ) : null}
          </View>
        }
        renderItem={({ item }) => {
          const editable = canManage || item.id === user?.id
          const face = (open?: () => void, busy?: boolean) => (
            <Avatar
              name={item.name || item.email}
              uri={item.avatarUrl}
              size={48}
              status={item.isActive ? 'active' : 'inactive'}
              loading={busy}
              onPress={open}
              accessibilityLabel={`Set photo for ${item.name || 'staff member'}`}
            />
          )
          return (
            <View style={[styles.card, !item.isActive && styles.cardInactive]}>
              {editable ? (
                <AvatarEditor
                  token={token}
                  userId={item.id === user?.id ? undefined : item.id}
                  personName={item.id === user?.id ? null : item.name}
                  hasPhoto={Boolean(item.avatarUrl)}
                  onChanged={(url) => setAvatar(item.id, url)}
                >
                  {({ open, busy }) => face(open, busy)}
                </AvatarEditor>
              ) : (
                face()
              )}
              <View style={styles.copy}>
                <Text style={styles.name} numberOfLines={1}>
                  {item.name || item.email || 'Staff'}
                  {item.id === user?.id ? <Text style={styles.you}>  · You</Text> : null}
                </Text>
                <Text style={styles.meta} numberOfLines={1}>
                  {formatRole(item.role ?? 'staff')}
                  {item.username ? ` · @${item.username}` : ''}
                </Text>
                {item.email ? (
                  <Text style={styles.meta} numberOfLines={1}>
                    {item.email}
                  </Text>
                ) : null}
              </View>
              <View style={[styles.pill, { backgroundColor: item.isActive ? colors.successSoft : colors.dangerSoft }]}>
                <Text style={[styles.pillText, { color: item.isActive ? colors.success : colors.danger }]}>
                  {item.isActive ? 'Active' : 'Inactive'}
                </Text>
              </View>
            </View>
          )
        }}
      />
    </View>
  )
}

const useStyles = makeStyles((colors) => ({
  container: { flex: 1, backgroundColor: colors.bg },
  padded: { padding: spacing.lg },
  list: { padding: spacing.lg, gap: spacing.sm },
  header: { marginBottom: spacing.sm },
  summary: { ...typography.h3, color: colors.text },
  hint: { ...typography.bodySm, color: colors.textSecondary, marginTop: 2 },
  search: { marginTop: spacing.md },
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    backgroundColor: colors.surface,
    borderRadius: radii.lg,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.md,
    paddingRight: spacing.lg,
  },
  cardInactive: { opacity: 0.7 },
  copy: { flex: 1 },
  name: { color: colors.text, fontSize: 15.5, fontFamily: 'DMSans_700Bold' },
  you: { color: colors.primary, fontSize: 13, fontFamily: 'DMSans_500Medium' },
  meta: { color: colors.textSecondary, fontSize: 12.5, fontFamily: 'DMSans_400Regular', marginTop: 2 },
  pill: { borderRadius: radii.full, paddingHorizontal: 10, paddingVertical: 4 },
  pillText: { fontSize: 11.5, fontFamily: 'DMSans_700Bold' },
}))
