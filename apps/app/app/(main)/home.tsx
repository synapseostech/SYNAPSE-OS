import { useCallback, useEffect, useState } from 'react'
import {
  Linking,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useRouter } from 'expo-router'
import { Ionicons } from '@expo/vector-icons'
import Constants from 'expo-constants'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { Card, SectionHeader } from '@/components/ui/Card'
import { EmptyState } from '@/components/ui/EmptyState'
import { LoadingBlock } from '@/components/ui/LoadingBlock'
import { WorkspaceHeader } from '@/components/WorkspaceHeader'
import { isSubscriptionLocked } from '@/lib/api'
import { useAuth } from '@/lib/auth'
import { getCachedWithTtl, setCached } from '@/lib/cache'
import { fetchDashboard, type DashboardResponse, type DashboardQuickAction } from '@/lib/dashboard'
import { dashboardKindForRole, formatRole, type DashboardKind } from '@/lib/roles'
import { colors, radii, spacing, tabBarHeight, typography, TONE_COLORS, useTheme } from '@/lib/theme'

const DASHBOARD_CACHE_KEY = '/api/mobile/dashboard'
const DASHBOARD_TTL_MS = 5 * 60 * 1000

const WEB_APP_URL = (
  (Constants.expoConfig?.extra?.webAppUrl as string | undefined) ?? 'https://www.synapseos.tech'
).replace(/\/$/, '')

const KIND_SUBTITLE: Record<DashboardKind, string> = {
  patient: 'Your health at a glance',
  clinician: 'Your clinical workspace',
  nurse: 'Care tasks and vitals',
  pharmacy: 'Pharmacy overview',
  lab: 'Laboratory workspace',
  reception: 'Front desk overview',
  billing: 'Claims and billing',
  admin: 'Facility overview',
  generic: 'Your dashboard',
}

export default function DashboardScreen() {
  const { user, token } = useAuth()
  const router = useRouter()
  const insets = useSafeAreaInsets()
  const [data, setData] = useState<DashboardResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const fetchFresh = useCallback(async () => {
    if (!token || !user?.id) return
    const cacheKey = `synapse_cache:${user.id}:${DASHBOARD_CACHE_KEY}`
    const res = await fetchDashboard(token)
    setData(res)
    setError(null)
    await setCached(cacheKey, res, DASHBOARD_TTL_MS, user.id)
  }, [token, user?.id])

  const load = useCallback(async () => {
    if (!token) {
      setLoading(false)
      return
    }
    try {
      await fetchFresh()
    } catch (err) {
      // The API layer already navigates to the billing screen on a 402.
      if (isSubscriptionLocked(err)) return
      setError(err instanceof Error ? err.message : 'Failed to load dashboard')
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }, [token, fetchFresh, router])

  useEffect(() => {
    let cancelled = false

    async function loadWithCache() {
      if (!user?.id) {
        await load()
        return
      }
      const cacheKey = `synapse_cache:${user.id}:${DASHBOARD_CACHE_KEY}`
      const cached = await getCachedWithTtl<DashboardResponse>(cacheKey, DASHBOARD_TTL_MS)
      if (cancelled) return

      if (cached) {
        setData(cached.data)
        setLoading(false)
        if (cached.stale) fetchFresh().catch(() => {})
        return
      }

      await load()
    }

    loadWithCache()
    return () => { cancelled = true }
  }, [load, fetchFresh, user?.id])

  const onRefresh = () => {
    setRefreshing(true)
    load()
  }

  const handleAction = (action: DashboardQuickAction) => {
    if (action.target.startsWith('http')) {
      Linking.openURL(action.target).catch(() => {})
      return
    }
    const [scheme, ...rest] = action.target.split(':')
    const path = rest.join(':')
    if (scheme === 'app') {
      router.push(path as never)
    } else {
      Linking.openURL(`${WEB_APP_URL}${path}`).catch(() => {})
    }
  }

  const kind = data?.dashboardKind ?? dashboardKindForRole(user?.role)
  const firstName = user?.fullName?.split(' ')[0] ?? null
  const stats = data?.summary.stats ?? []
  const listSection = data?.summary.list ?? null
  const quickActions = data?.quickActions ?? []
  const bottomPad = insets.bottom + tabBarHeight + spacing.lg
  const { colors: themeColors } = useTheme()

  return (
    <ScrollView
      style={[styles.root, { backgroundColor: themeColors.bg }]}
      contentContainerStyle={[styles.content, { paddingTop: insets.top + spacing.lg, paddingBottom: bottomPad }]}
      refreshControl={
        <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={themeColors.primary} />
      }
      showsVerticalScrollIndicator={false}
    >
      <WorkspaceHeader
        user={user}
        subtitle={KIND_SUBTITLE[kind]}
        showLogo
      />

      <View style={styles.headerRow}>
        <View style={styles.headerCopy}>
          <Text style={styles.greeting}>
            Good {timeOfDay()}
            {firstName ? ', ' : ''}
            {firstName ? <Text style={styles.greetingName}>{firstName}</Text> : null}
          </Text>
        </View>
        <Badge label={formatRole(user?.role)} tone="gold" />
      </View>

      {(data?.tenantName || user?.tenantName) ? (
        <View style={styles.tenantRow}>
          <Ionicons name="business-outline" size={14} color={colors.teal} />
          <Text style={styles.tenant}>{data?.tenantName || user?.tenantName}</Text>
        </View>
      ) : null}

      {/* One login spans the ecosystem: staff accounts still own a personal
          health record, so it is reachable from their workspace. */}
      <Pressable
        style={({ pressed }) => [styles.personalCard, pressed && styles.actionPressed]}
        onPress={() => router.push('/(personal)/today' as never)}
        accessibilityRole="button"
        accessibilityLabel="Open my health"
      >
        <View style={styles.actionIcon}>
          <Ionicons name="heart-outline" size={16} color={colors.primary} />
        </View>
        <View style={styles.listBody}>
          <Text style={styles.actionText}>My health</Text>
          <Text style={styles.listSubtitle}>Reminders, medicines and your coach</Text>
        </View>
        <Ionicons name="chevron-forward" size={18} color={colors.textMuted} />
      </Pressable>

      {loading ? (
        <LoadingBlock message="Loading your dashboard…" />
      ) : error ? (
        <Card style={styles.errorCard}>
          <Text style={styles.errorText}>{error}</Text>
          <Button
            label="Try again"
            onPress={() => { setLoading(true); load() }}
            variant="ghost"
            style={styles.retryBtn}
          />
        </Card>
      ) : (
        <>
          {stats.length > 0 ? (
            <View style={styles.statsGrid}>
              {stats.map((s) => (
                <View key={s.key} style={styles.statWrap}>
                  <View style={styles.statCard}>
                    <Text style={[styles.statValue, { color: TONE_COLORS[s.tone] ?? colors.textMuted }]}>
                      {s.value}
                    </Text>
                    <Text style={styles.statLabel} numberOfLines={2}>{s.label}</Text>
                  </View>
                </View>
              ))}
            </View>
          ) : null}

          {quickActions.length > 0 ? (
            <View style={styles.section}>
              <SectionHeader title="Quick actions" />
              <View style={styles.actionsWrap}>
                {quickActions.map((a) => (
                  <Pressable
                    key={a.key}
                    style={({ pressed }) => [styles.actionBtn, pressed && styles.actionPressed]}
                    onPress={() => handleAction(a)}
                  >
                    <View style={styles.actionLeft}>
                      <View style={styles.actionIcon}>
                        <Ionicons
                          name={a.target.startsWith('web:') ? 'open-outline' : 'arrow-forward'}
                          size={16}
                          color={colors.primary}
                        />
                      </View>
                      <Text style={styles.actionText}>{a.label}</Text>
                    </View>
                    <Ionicons name="chevron-forward" size={18} color={colors.textMuted} />
                  </Pressable>
                ))}
              </View>
            </View>
          ) : null}

          {listSection && listSection.items.length > 0 ? (
            <View style={styles.section}>
              <SectionHeader title={listSection.title} />
              {listSection.items.map((item) => (
                <View key={item.id} style={styles.listCard}>
                  <View style={[styles.listAccent, { backgroundColor: TONE_COLORS[item.tone ?? 'muted'] }]} />
                  <View style={styles.listBody}>
                    <Text style={styles.listTitle}>{item.title}</Text>
                    {item.subtitle ? (
                      <Text style={styles.listSubtitle} numberOfLines={2}>{item.subtitle}</Text>
                    ) : null}
                  </View>
                  {item.meta ? (
                    <Text style={[styles.listMeta, { color: TONE_COLORS[item.tone ?? 'muted'] }]}>
                      {formatMeta(item.meta)}
                    </Text>
                  ) : null}
                </View>
              ))}
            </View>
          ) : stats.length === 0 && quickActions.length === 0 ? (
            <EmptyState
              title="You're all set"
              body="Nothing needs your attention right now. Pull down to refresh."
              icon="checkmark-circle"
            />
          ) : null}
        </>
      )}
    </ScrollView>
  )
}

function timeOfDay() {
  const h = new Date().getHours()
  if (h < 12) return 'morning'
  if (h < 17) return 'afternoon'
  return 'evening'
}

function formatMeta(meta: string) {
  return meta.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  content: { paddingHorizontal: spacing.xl, flexGrow: 1 },

  headerRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: spacing.md,
  },
  headerCopy: { flex: 1 },
  greeting: {
    ...typography.title,
    color: colors.text,
    fontFamily: 'DMSans_700Bold',
  },
  greetingName: { color: colors.primary },
  subtitle: {
    ...typography.caption,
    color: colors.textSecondary,
    fontFamily: 'DMSans_400Regular',
    marginTop: spacing.xs,
  },
  tenantRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginTop: spacing.md,
  },
  tenant: {
    ...typography.caption,
    color: colors.textMuted,
    fontFamily: 'DMSans_500Medium',
  },

  personalCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    backgroundColor: colors.surface,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: spacing.lg,
    paddingVertical: 14,
    marginTop: spacing.lg,
  },
  errorCard: { marginTop: spacing.xxl, alignItems: 'center' },
  errorText: {
    ...typography.body,
    color: colors.error,
    fontFamily: 'DMSans_400Regular',
    textAlign: 'center',
    marginBottom: spacing.md,
  },
  retryBtn: { alignSelf: 'stretch' },

  statsGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    marginTop: spacing.xxl,
    marginHorizontal: -5,
  },
  statWrap: { width: '50%', paddingHorizontal: 5, paddingBottom: 10 },
  statCard: {
    backgroundColor: colors.surface,
    borderRadius: radii.lg,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.lg,
    minHeight: 92,
  },
  statValue: {
    ...typography.stat,
    fontFamily: 'DMSans_700Bold',
  },
  statLabel: {
    ...typography.caption,
    color: colors.textSecondary,
    fontFamily: 'DMSans_400Regular',
    marginTop: spacing.xs,
    fontSize: 12,
  },

  section: { marginTop: spacing.xxxl },
  actionsWrap: { gap: spacing.sm },
  actionBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: colors.surface,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: spacing.lg,
    paddingVertical: 14,
  },
  actionPressed: { backgroundColor: colors.surfaceHover },
  actionLeft: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, flex: 1 },
  actionIcon: {
    width: 32,
    height: 32,
    borderRadius: radii.sm,
    backgroundColor: colors.primarySoft,
    alignItems: 'center',
    justifyContent: 'center',
  },
  actionText: {
    ...typography.bodyMedium,
    color: colors.text,
    fontFamily: 'DMSans_500Medium',
    flex: 1,
  },

  listCard: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.surface,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.lg,
    marginBottom: spacing.sm,
    overflow: 'hidden',
  },
  listAccent: { width: 3, height: '100%', minHeight: 36, borderRadius: 2, marginRight: spacing.md },
  listBody: { flex: 1 },
  listTitle: {
    ...typography.bodyMedium,
    color: colors.text,
    fontFamily: 'DMSans_500Medium',
    fontWeight: '600',
  },
  listSubtitle: {
    ...typography.caption,
    color: colors.textSecondary,
    fontFamily: 'DMSans_400Regular',
    marginTop: 3,
  },
  listMeta: {
    fontSize: 11,
    fontWeight: '700',
    fontFamily: 'DMSans_700Bold',
    marginLeft: spacing.sm,
  },
})
