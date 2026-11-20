import { useState } from 'react'
import { Alert, Linking, Pressable, ScrollView, Text, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useRouter } from 'expo-router'
import Constants from 'expo-constants'
import { Ionicons } from '@expo/vector-icons'
import { AvatarEditor } from '@/components/AvatarEditor'
import { Avatar } from '@/components/ui/Avatar'
import { Button } from '@/components/ui/Button'
import { Card, Divider } from '@/components/ui/Card'
import { EmptyState } from '@/components/ui/EmptyState'
import { ListRow } from '@/components/ui/ListRow'
import { SearchField } from '@/components/ui/SearchField'
import { useAuth } from '@/lib/auth'
import { PHARMACY_DESTINATIONS, matchDestination, type DestinationGroup } from '@/lib/destinations'
import { selectionHaptic } from '@/lib/haptics'
import { dashboardKindForRole, formatRole } from '@/lib/roles'
import {
  makeStyles,
  radii,
  spacing,
  tabBarHeight,
  typography,
  useTheme,
  type ThemePreference,
} from '@/lib/theme'

const WEB_APP_URL = (
  (Constants.expoConfig?.extra?.webAppUrl as string | undefined) ?? 'https://www.synapseos.tech'
).replace(/\/$/, '')

const PHARM_PORTAL = 'https://pharm.synapseos.tech/portal'

type IoniconName = React.ComponentProps<typeof Ionicons>['name']


export default function ProfileScreen() {
  const styles = useStyles()
  const { user, token, logout, refreshUser } = useAuth()
  const router = useRouter()
  const insets = useSafeAreaInsets()
  const { colors, preference, setPreference, scheme } = useTheme()
  const kind = dashboardKindForRole(user?.role)
  const [query, setQuery] = useState('')
  // Shown straight after an upload, before /me returns the fresh URL.
  const [localAvatar, setLocalAvatar] = useState<string | null | undefined>(undefined)
  const avatarUrl = localAvatar !== undefined ? localAvatar : (user?.avatarUrl ?? null)

  const handleLogout = () => {
    Alert.alert('Sign out', 'Are you sure you want to sign out?', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Sign out',
        style: 'destructive',
        onPress: async () => {
          await logout()
          router.replace('/(auth)/login')
        },
      },
    ])
  }

  const openUrl = (url: string) => {
    Linking.openURL(url).catch(() => {})
  }

  const openWebPortal = () => {
    if (kind === 'pharmacy') {
      openUrl(`${PHARM_PORTAL}/dashboard`)
      return
    }
    const path =
      kind === 'patient'
        ? '/health/dashboard'
        : user?.role === 'platform_admin'
          ? '/platform'
          : '/login'
    openUrl(`${WEB_APP_URL}${path}`)
  }

  const go = (route: string) => router.push(route as never)

  const visibleGroups = query.trim()
    ? PHARMACY_DESTINATIONS.map((g) => ({ ...g, items: g.items.filter((i) => matchDestination(i, g, query)) })).filter(
        (g) => g.items.length > 0,
      )
    : PHARMACY_DESTINATIONS

  const themeOptions: Array<{ key: ThemePreference; label: string; icon: IoniconName }> = [
    { key: 'system', label: 'System', icon: 'phone-portrait-outline' },
    { key: 'light', label: 'Light', icon: 'sunny-outline' },
    { key: 'dark', label: 'Dark', icon: 'moon-outline' },
  ]

  const tintColor = (t: DestinationGroup['tint']) =>
    t === 'teal' ? colors.teal : t === 'gold' ? colors.gold : t === 'info' ? colors.info : t === 'success' ? colors.success : colors.primary

  return (
    <ScrollView
      style={styles.root}
      contentContainerStyle={{
        paddingHorizontal: spacing.xl,
        paddingTop: insets.top + spacing.lg,
        paddingBottom: insets.bottom + tabBarHeight + spacing.xl,
      }}
      keyboardShouldPersistTaps="handled"
      showsVerticalScrollIndicator={false}
    >
      <View style={styles.hero}>
        <AvatarEditor
          token={token}
          hasPhoto={Boolean(avatarUrl)}
          onChanged={(url) => {
            setLocalAvatar(url)
            void refreshUser()
          }}
        >
          {({ open, busy }) => (
            <Avatar
              name={user?.fullName ?? user?.email}
              uri={avatarUrl}
              size={84}
              editable
              loading={busy}
              onPress={open}
            />
          )}
        </AvatarEditor>
        <View style={styles.heroCopy}>
          <Text style={styles.name} numberOfLines={2}>
            {user?.fullName ?? 'Unknown user'}
          </Text>
          <Text style={styles.email} numberOfLines={1}>
            {user?.email}
          </Text>
          <View style={styles.chips}>
            <View style={styles.roleChip}>
              <Text style={styles.roleChipText}>{formatRole(user?.role ?? '')}</Text>
            </View>
          </View>
        </View>
      </View>

      <Card padded={false}>
        <InfoRow
          icon="business-outline"
          label="Workspace"
          value={user?.tenantName || (kind === 'patient' ? 'Personal Health' : '—')}
        />
        <Divider />
        <InfoRow icon="finger-print-outline" label="Synapse ID" value={user?.synapseId ?? '—'} mono />
      </Card>

      {kind === 'pharmacy' ? (
        <>
          <SearchField
            value={query}
            onChangeText={setQuery}
            placeholder="Find a tool — e.g. refunds, GRN, Tally"
            style={styles.search}
          />
          {visibleGroups.map((g) => (
            <View key={g.title} style={styles.sectionWrap}>
              <Text style={styles.sectionTitle}>{g.title}</Text>
              <Card padded={false}>
                {g.items.map((item, idx) => (
                  <View key={item.label}>
                    {idx > 0 ? <Divider /> : null}
                    <ListRow
                      title={item.label}
                      subtitle={item.subtitle}
                      icon={item.icon}
                      iconColor={tintColor(g.tint)}
                      onPress={() => (item.action === 'web-portal' ? openWebPortal() : item.route ? go(item.route) : undefined)}
                    />
                  </View>
                ))}
              </Card>
            </View>
          ))}
          {visibleGroups.length === 0 ? (
            <EmptyState
              icon="search"
              title="No tool matches"
              body={`Nothing called “${query.trim()}”. Try another word.`}
              actionLabel="Clear search"
              onAction={() => setQuery('')}
            />
          ) : null}
        </>
      ) : (
        <View style={styles.actions}>
          <Button label="Open web portal" onPress={openWebPortal} variant="ghost" icon="globe-outline" />
        </View>
      )}

      <Text style={styles.sectionTitle}>Appearance</Text>
      <View style={styles.segment} accessibilityRole="radiogroup">
        {themeOptions.map((opt) => {
          const active = preference === opt.key
          return (
            <Pressable
              key={opt.key}
              onPress={() => {
                selectionHaptic()
                setPreference(opt.key)
              }}
              accessibilityRole="radio"
              accessibilityState={{ selected: active }}
              style={[styles.segmentItem, active && styles.segmentItemActive]}
            >
              <Ionicons name={opt.icon} size={16} color={active ? colors.primary : colors.textSecondary} />
              <Text style={[styles.segmentText, active && { color: colors.primary }]}>{opt.label}</Text>
            </Pressable>
          )
        })}
      </View>
      <Text style={styles.themeHint}>
        Using {scheme} mode{preference === 'system' ? ' (follows device)' : ''}
      </Text>

      <Text style={styles.sectionTitle}>Account</Text>
      <Card padded={false}>
        {/* Staff own a personal health record on the same login, private to them. */}
        <ListRow
          title="My health (private to you)"
          icon="heart-outline"
          onPress={() => router.push('/(personal)/today' as never)}
        />
        <Divider />
        <ListRow
          title="Change password"
          icon="key-outline"
          onPress={() => router.push('/change-password' as never)}
        />
        <Divider />
        <ListRow
          title="Sign out"
          icon="log-out-outline"
          iconColor={colors.error}
          chevron={false}
          onPress={handleLogout}
        />
      </Card>

      <View style={styles.footer}>
        <Ionicons name="shield-checkmark-outline" size={14} color={colors.textMuted} />
        <Text style={styles.version}>
          Synapse Health Technologies · v{Constants.expoConfig?.version ?? ''}
        </Text>
      </View>
    </ScrollView>
  )
}

function InfoRow({ icon, label, value, mono }: { icon: IoniconName; label: string; value: string; mono?: boolean }) {
  const styles = useStyles()
  const { colors } = useTheme()
  return (
    <View style={styles.row}>
      <Ionicons name={icon} size={16} color={colors.textSecondary} />
      <Text style={styles.rowLabel}>{label}</Text>
      <Text style={[styles.rowValue, mono && styles.mono]} numberOfLines={2} selectable>
        {value}
      </Text>
    </View>
  )
}

const useStyles = makeStyles((colors) => ({
  root: { flex: 1, backgroundColor: colors.bg },
  hero: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.lg,
    marginBottom: spacing.xl,
  },
  heroCopy: { flex: 1 },
  name: { ...typography.h2, color: colors.text },
  email: { ...typography.bodySm, color: colors.textSecondary, marginTop: 2 },
  chips: { flexDirection: 'row', marginTop: spacing.sm },
  roleChip: {
    backgroundColor: colors.goldSoft,
    borderRadius: radii.full,
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  roleChipText: { color: colors.gold, fontSize: 12, fontFamily: 'DMSans_700Bold' },
  search: { marginTop: spacing.xl },
  sectionWrap: { marginTop: spacing.sm },
  sectionTitle: {
    ...typography.label,
    color: colors.textSecondary,
    marginBottom: spacing.sm,
    marginTop: spacing.xl,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.lg,
    paddingVertical: 14,
    gap: spacing.md,
  },
  rowLabel: { color: colors.textSecondary, fontSize: 14, fontFamily: 'DMSans_400Regular' },
  rowValue: {
    flex: 1,
    textAlign: 'right',
    color: colors.text,
    fontSize: 14,
    fontFamily: 'DMSans_500Medium',
  },
  mono: { fontFamily: 'IBMPlexMono_500Medium', fontSize: 12.5 },
  segment: {
    flexDirection: 'row',
    padding: 4,
    gap: 4,
    borderRadius: radii.lg,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
  },
  segmentItem: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    minHeight: 44,
    borderRadius: radii.md,
  },
  segmentItemActive: { backgroundColor: colors.primarySoft },
  segmentText: { color: colors.textSecondary, fontSize: 13, fontFamily: 'DMSans_700Bold' },
  themeHint: { ...typography.caption, color: colors.textMuted, marginTop: spacing.sm },
  actions: { gap: spacing.sm, marginTop: spacing.xl },
  footer: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    marginTop: spacing.xxl,
  },
  version: { ...typography.caption, color: colors.textMuted },
}))
