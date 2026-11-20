import { useCallback, useEffect, useState } from 'react'
import { Linking, Pressable, RefreshControl, ScrollView, Text, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useRouter } from 'expo-router'
import { Ionicons } from '@expo/vector-icons'
import { LinearGradient } from 'expo-linear-gradient'
import Constants from 'expo-constants'
import { Avatar } from '@/components/ui/Avatar'
import { EmptyState, ErrorState } from '@/components/ui/EmptyState'
import { Skeleton, SkeletonStats } from '@/components/ui/Skeleton'
import { isSubscriptionLocked } from '@/lib/api'
import { useAuth } from '@/lib/auth'
import { getCachedWithTtl, setCached } from '@/lib/cache'
import { fetchDashboard, type DashboardQuickAction, type DashboardResponse, type DashboardStat } from '@/lib/dashboard'
import { tapHaptic } from '@/lib/haptics'
import { dashboardKindForRole, formatRole, type DashboardKind } from '@/lib/roles'
import { elevation, makeStyles, radii, spacing, tabBarHeight, toneColors, typography, useTheme } from '@/lib/theme'

const DASHBOARD_CACHE_KEY = '/api/mobile/dashboard'
const DASHBOARD_TTL_MS = 5 * 60 * 1000

const WEB_APP_URL = (
  (Constants.expoConfig?.extra?.webAppUrl as string | undefined) ?? 'https://www.synapseos.tech'
).replace(/\/$/, '')

type IoniconName = keyof typeof Ionicons.glyphMap

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

/** The four jobs a pharmacy does all day, one tap each from Home. */
type QuickTile = { key: string; label: string; hint: string; icon: IoniconName; route: string; tint: 'primary' | 'teal' | 'gold' | 'info' }
const PHARMACY_TILES: QuickTile[] = [
  { key: 'pos', label: 'New sale', hint: 'Open the till', icon: 'cart', route: '/pos', tint: 'primary' },
  { key: 'receive', label: 'Receive stock', hint: 'Delivery / GRN', icon: 'download', route: '/receive-stock', tint: 'teal' },
  { key: 'inventory', label: 'Check stock', hint: 'Search on hand', icon: 'cube', route: '/(main)/stock', tint: 'gold' },
  { key: 'sales', label: "Today's sales", hint: 'Receipts & reprints', icon: 'receipt', route: '/(main)/sales', tint: 'info' },
]
const TILE_KEYS = new Set(PHARMACY_TILES.map((t) => t.key).concat(['more']))

/** Where a stat tile leads, so every number on Home is tappable. */
const STAT_ROUTES: Record<string, string> = {
  sales: '/reports',
  orders: '/(main)/sales',
  low: '/(main)/stock?filter=low',
  expiring: '/(main)/stock?filter=expiring',
  online: '/(main)/orders',
  billing: '/billing',
}

function actionIcon(action: DashboardQuickAction): IoniconName {
  if (action.target.startsWith('web:') || action.target.startsWith('http')) return 'open-outline'
  const k = `${action.key} ${action.label}`.toLowerCase()
  if (k.includes('sync')) return 'cloud-upload-outline'
  if (k.includes('order')) return 'bag-handle-outline'
  if (k.includes('transfer')) return 'swap-horizontal-outline'
  if (k.includes('report')) return 'bar-chart-outline'
  if (k.includes('patient')) return 'people-outline'
  if (k.includes('appoint') || k.includes('visit')) return 'calendar-outline'
  if (k.includes('lab')) return 'flask-outline'
  if (k.includes('claim')) return 'receipt-outline'
  if (k.includes('record')) return 'document-text-outline'
  if (k.includes('med')) return 'medkit-outline'
  return 'arrow-forward'
}

export default function DashboardScreen() {
  const styles = useStyles()
  const { colors, scheme } = useTheme()
  const tones = toneColors(colors)
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
  }, [token, fetchFresh])

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
    return () => {
      cancelled = true
    }
  }, [load, fetchFresh, user?.id])

  const onRefresh = () => {
    setRefreshing(true)
    load()
  }

  const go = (route: string) => {
    tapHaptic()
    router.push(route as never)
  }

  const handleAction = (action: DashboardQuickAction) => {
    tapHaptic()
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
  const isPharmacy = kind === 'pharmacy'
  const firstName = user?.fullName?.split(' ')[0] ?? null
  const stats = data?.summary.stats ?? []
  const listSection = data?.summary.list ?? null
  const quickActions = data?.quickActions ?? []
  const tenantName = data?.tenantName || user?.tenantName
  const bottomPad = insets.bottom + tabBarHeight + spacing.xl

  const salesStat = isPharmacy ? stats.find((s) => s.key === 'sales') : undefined
  const countStat = isPharmacy ? stats.find((s) => s.key === 'orders') : undefined
  const otherStats = stats.filter((s) => s !== salesStat && s !== countStat)
  const shortcuts = isPharmacy ? quickActions.filter((a) => !TILE_KEYS.has(a.key)) : quickActions

  const tint = (t: QuickTile['tint']) =>
    t === 'teal' ? colors.teal : t === 'gold' ? colors.gold : t === 'info' ? colors.info : colors.primary

  return (
    <ScrollView
      style={styles.root}
      contentContainerStyle={[styles.content, { paddingTop: insets.top + spacing.md, paddingBottom: bottomPad }]}
      refreshControl={
        <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.primary} colors={[colors.primary]} />
      }
      showsVerticalScrollIndicator={false}
    >
      {/* Top bar: who, where, and search one tap away */}
      <View style={styles.topBar}>
        <Avatar
          name={user?.fullName ?? user?.email}
          uri={user?.avatarUrl}
          size={44}
          onPress={() => go('/(main)/profile')}
          accessibilityLabel="Open your profile"
        />
        <View style={styles.topCopy}>
          <Text style={styles.greeting} numberOfLines={1}>
            Good {timeOfDay()}
            {firstName ? `, ${firstName}` : ''}
          </Text>
          <Text style={styles.tenant} numberOfLines={1}>
            {tenantName ? `${tenantName} · ` : ''}
            {formatRole(user?.role)}
          </Text>
        </View>
        <Pressable
          onPress={() => go('/search')}
          style={({ pressed }) => [styles.iconBtn, pressed && styles.pressed]}
          accessibilityRole="button"
          accessibilityLabel="Search products and screens"
          hitSlop={6}
        >
          <Ionicons name="search" size={20} color={colors.text} />
        </Pressable>
      </View>

      {isPharmacy ? (
        <Pressable
          onPress={() => go('/search')}
          style={({ pressed }) => [styles.searchBar, pressed && styles.pressed]}
          accessibilityRole="search"
          accessibilityLabel="Search products, receipts and tools"
        >
          <Ionicons name="search" size={18} color={colors.textSecondary} />
          <Text style={styles.searchText}>Search products, tools…</Text>
          <Ionicons name="barcode-outline" size={20} color={colors.primary} />
        </Pressable>
      ) : (
        <Text style={styles.kindSubtitle}>{KIND_SUBTITLE[kind]}</Text>
      )}

      {/* Today's takings — the number a pharmacy owner opens the app for */}
      {isPharmacy ? (
        loading ? (
          <View style={[styles.hero, { backgroundColor: colors.surface }]}>
            <Skeleton width="40%" height={12} />
            <Skeleton width="70%" height={34} style={{ marginTop: spacing.md }} />
            <Skeleton width="30%" height={12} style={{ marginTop: spacing.md }} />
          </View>
        ) : salesStat ? (
          <Pressable
            onPress={() => go('/reports')}
            accessibilityRole="button"
            accessibilityLabel={`Today's takings ${salesStat.value}. Open reports`}
            style={({ pressed }) => [pressed && styles.pressed]}
          >
            <LinearGradient
              colors={scheme === 'dark' ? ['#2A1406', '#16161B'] : ['#FFE8D6', '#FFFFFF']}
              start={{ x: 0, y: 0 }}
              end={{ x: 1, y: 1 }}
              style={[styles.hero, elevation(1, scheme)]}
            >
              <View style={styles.heroTop}>
                <Text style={styles.heroLabel}>Today’s takings</Text>
                <View style={styles.heroLink}>
                  <Text style={styles.heroLinkText}>Reports</Text>
                  <Ionicons name="chevron-forward" size={14} color={colors.primary} />
                </View>
              </View>
              <Text style={styles.heroValue} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.6}>
                {salesStat.value}
              </Text>
              {countStat ? (
                <Text style={styles.heroSub}>
                  {countStat.value} {countStat.value === '1' ? 'sale' : 'sales'} so far today
                </Text>
              ) : null}
            </LinearGradient>
          </Pressable>
        ) : null
      ) : null}

      {isPharmacy ? (
        <View style={styles.tiles}>
          {PHARMACY_TILES.map((t) => {
            const c = tint(t.tint)
            return (
              <View key={t.key} style={styles.tileWrap}>
                <Pressable
                  onPress={() => go(t.route)}
                  accessibilityRole="button"
                  accessibilityLabel={`${t.label}. ${t.hint}`}
                  android_ripple={{ color: `${c}22` }}
                  style={({ pressed }) => [styles.tile, pressed && styles.pressed]}
                >
                  <View style={[styles.tileIcon, { backgroundColor: `${c}1F` }]}>
                    <Ionicons name={t.icon} size={22} color={c} />
                  </View>
                  <Text style={styles.tileLabel}>{t.label}</Text>
                  <Text style={styles.tileHint}>{t.hint}</Text>
                </Pressable>
              </View>
            )
          })}
        </View>
      ) : null}

      {loading ? (
        <View style={styles.section}>
          <SkeletonStats count={isPharmacy ? 2 : 4} />
        </View>
      ) : error && !data ? (
        <ErrorState
          message={error}
          onRetry={() => {
            setLoading(true)
            load()
          }}
        />
      ) : (
        <>
          {otherStats.length > 0 ? (
            <View style={styles.section}>
              {isPharmacy ? <Text style={styles.sectionTitle}>At a glance</Text> : null}
              <View style={styles.statsGrid}>
                {otherStats.map((s) => (
                  <StatTile
                    key={s.key}
                    stat={s}
                    color={tones[s.tone as keyof typeof tones] ?? colors.textMuted}
                    onPress={STAT_ROUTES[s.key] && isPharmacy ? () => go(STAT_ROUTES[s.key]!) : undefined}
                  />
                ))}
              </View>
            </View>
          ) : null}

          {listSection && listSection.items.length > 0 ? (
            <View style={styles.section}>
              <View style={styles.sectionRow}>
                <Text style={styles.sectionTitle}>{listSection.title}</Text>
                {isPharmacy ? (
                  <Pressable onPress={() => go('/(main)/stock?filter=low')} hitSlop={8} accessibilityRole="button">
                    <Text style={styles.sectionLink}>See all</Text>
                  </Pressable>
                ) : null}
              </View>
              <View style={styles.card}>
                {listSection.items.map((item, idx) => {
                  const c = tones[(item.tone ?? 'muted') as keyof typeof tones] ?? colors.textMuted
                  return (
                    <View key={item.id} style={[styles.listRow, idx > 0 && styles.listRowBorder]}>
                      <View style={[styles.listDot, { backgroundColor: c }]} />
                      <View style={styles.listBody}>
                        <Text style={styles.listTitle} numberOfLines={1}>
                          {item.title}
                        </Text>
                        {item.subtitle ? (
                          <Text style={styles.listSubtitle} numberOfLines={2}>
                            {item.subtitle}
                          </Text>
                        ) : null}
                      </View>
                      {item.meta ? (
                        <Text style={[styles.listMeta, { color: c }]} numberOfLines={1}>
                          {formatMeta(item.meta)}
                        </Text>
                      ) : null}
                    </View>
                  )
                })}
              </View>
            </View>
          ) : null}

          {shortcuts.length > 0 ? (
            <View style={styles.section}>
              <Text style={styles.sectionTitle}>{isPharmacy ? 'Shortcuts' : 'Quick actions'}</Text>
              <View style={styles.shortcuts}>
                {shortcuts.map((a) => (
                  <Pressable
                    key={a.key}
                    onPress={() => handleAction(a)}
                    accessibilityRole="button"
                    accessibilityLabel={a.label}
                    style={({ pressed }) => [styles.shortcut, pressed && styles.pressed]}
                  >
                    <Ionicons name={actionIcon(a)} size={16} color={colors.primary} />
                    <Text style={styles.shortcutText} numberOfLines={1}>
                      {a.label}
                    </Text>
                  </Pressable>
                ))}
              </View>
            </View>
          ) : null}

          {!isPharmacy && stats.length === 0 && quickActions.length === 0 && !listSection ? (
            <EmptyState
              title="You're all set"
              body="Nothing needs your attention right now. Pull down to refresh."
              icon="checkmark-circle"
            />
          ) : null}
        </>
      )}

      {/* One login spans the ecosystem: staff accounts still own a personal
          health record, so it is reachable from their workspace. */}
      <Pressable
        style={({ pressed }) => [styles.personalCard, pressed && styles.pressed]}
        onPress={() => go('/(personal)/today')}
        accessibilityRole="button"
        accessibilityLabel="Open my health"
      >
        <View style={styles.personalIcon}>
          <Ionicons name="heart" size={16} color={colors.primary} />
        </View>
        <View style={styles.listBody}>
          <Text style={styles.listTitle}>My health</Text>
          <Text style={styles.listSubtitle}>Reminders, medicines and your coach</Text>
        </View>
        <Ionicons name="chevron-forward" size={18} color={colors.textMuted} />
      </Pressable>
    </ScrollView>
  )
}

function StatTile({ stat, color, onPress }: { stat: DashboardStat; color: string; onPress?: () => void }) {
  const styles = useStyles()
  const body = (
    <>
      <Text style={[styles.statValue, { color }]} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.6}>
        {stat.value}
      </Text>
      <Text style={styles.statLabel} numberOfLines={2}>
        {stat.label}
      </Text>
    </>
  )
  return (
    <View style={styles.statWrap}>
      {onPress ? (
        <Pressable
          onPress={onPress}
          accessibilityRole="button"
          accessibilityLabel={`${stat.label}: ${stat.value}`}
          style={({ pressed }) => [styles.statCard, pressed && styles.pressed]}
        >
          {body}
        </Pressable>
      ) : (
        <View style={styles.statCard}>{body}</View>
      )}
    </View>
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

const useStyles = makeStyles((colors) => ({
  root: { flex: 1, backgroundColor: colors.bg },
  content: { paddingHorizontal: spacing.lg, flexGrow: 1 },
  pressed: { opacity: 0.85, transform: [{ scale: 0.985 }] },

  topBar: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  topCopy: { flex: 1 },
  greeting: { ...typography.h3, color: colors.text, fontFamily: 'BricolageGrotesque_700Bold', fontSize: 19 },
  tenant: { ...typography.caption, color: colors.textSecondary, marginTop: 1 },
  iconBtn: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
  },
  kindSubtitle: { ...typography.bodySm, color: colors.textSecondary, marginTop: spacing.lg },

  searchBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    marginTop: spacing.lg,
    minHeight: 48,
    paddingHorizontal: spacing.md,
    borderRadius: radii.lg,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  searchText: { flex: 1, color: colors.textSecondary, fontSize: 15, fontFamily: 'DMSans_400Regular' },

  hero: {
    marginTop: spacing.lg,
    borderRadius: radii.xl,
    padding: spacing.xl,
    borderWidth: 1,
    borderColor: colors.primarySoft,
  },
  heroTop: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  heroLabel: { ...typography.label, color: colors.textSecondary },
  heroLink: { flexDirection: 'row', alignItems: 'center', gap: 2 },
  heroLinkText: { color: colors.primary, fontSize: 13, fontFamily: 'DMSans_700Bold' },
  heroValue: {
    fontFamily: 'BricolageGrotesque_700Bold',
    fontSize: 36,
    lineHeight: 44,
    letterSpacing: -0.6,
    color: colors.text,
    marginTop: spacing.sm,
  },
  heroSub: { ...typography.bodySm, color: colors.textSecondary, marginTop: 2 },

  tiles: { flexDirection: 'row', flexWrap: 'wrap', marginTop: spacing.md, marginHorizontal: -5 },
  tileWrap: { width: '50%', padding: 5 },
  tile: {
    minHeight: 112,
    borderRadius: radii.xl,
    padding: spacing.lg,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    overflow: 'hidden',
  },
  tileIcon: {
    width: 42,
    height: 42,
    borderRadius: radii.lg,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: spacing.md,
  },
  tileLabel: { color: colors.text, fontSize: 16, fontFamily: 'DMSans_700Bold' },
  tileHint: { color: colors.textSecondary, fontSize: 12.5, fontFamily: 'DMSans_400Regular', marginTop: 2 },

  section: { marginTop: spacing.xl },
  sectionRow: { flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between' },
  sectionTitle: { ...typography.label, color: colors.textSecondary, marginBottom: spacing.sm },
  sectionLink: { color: colors.primary, fontSize: 13, fontFamily: 'DMSans_700Bold' },

  statsGrid: { flexDirection: 'row', flexWrap: 'wrap', marginHorizontal: -5 },
  statWrap: { width: '50%', paddingHorizontal: 5, paddingBottom: 10 },
  statCard: {
    backgroundColor: colors.surface,
    borderRadius: radii.lg,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.lg,
    minHeight: 86,
  },
  statValue: { fontFamily: 'BricolageGrotesque_700Bold', fontSize: 24, lineHeight: 30 },
  statLabel: { ...typography.caption, color: colors.textSecondary, marginTop: 2 },

  card: {
    backgroundColor: colors.surface,
    borderRadius: radii.lg,
    borderWidth: 1,
    borderColor: colors.border,
    overflow: 'hidden',
  },
  listRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, padding: spacing.lg },
  listRowBorder: { borderTopWidth: 1, borderTopColor: colors.borderSubtle },
  listDot: { width: 8, height: 8, borderRadius: 4 },
  listBody: { flex: 1 },
  listTitle: { color: colors.text, fontSize: 15, fontFamily: 'DMSans_500Medium' },
  listSubtitle: { ...typography.caption, color: colors.textSecondary, marginTop: 2 },
  listMeta: { fontSize: 11.5, fontFamily: 'DMSans_700Bold', maxWidth: 110, textAlign: 'right' },

  shortcuts: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  shortcut: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    minHeight: 40,
    paddingHorizontal: spacing.md,
    borderRadius: radii.full,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
  },
  shortcutText: { color: colors.text, fontSize: 13.5, fontFamily: 'DMSans_500Medium' },

  personalCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    backgroundColor: colors.surface,
    borderRadius: radii.lg,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: spacing.lg,
    paddingVertical: 14,
    marginTop: spacing.xl,
  },
  personalIcon: {
    width: 34,
    height: 34,
    borderRadius: radii.md,
    backgroundColor: colors.primarySoft,
    alignItems: 'center',
    justifyContent: 'center',
  },
}))
