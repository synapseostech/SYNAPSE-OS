import { useCallback, useState } from 'react'
import { Alert, Pressable, RefreshControl, ScrollView, StyleSheet, Switch, Text, View } from 'react-native'
import { useFocusEffect, useRouter } from 'expo-router'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { Ionicons } from '@expo/vector-icons'
import { Button } from '@/components/ui/Button'
import { ChoiceChips } from '@/components/ui/ChoiceChips'
import { TextField } from '@/components/ui/TextField'
import { useAuth } from '@/lib/auth'
import { ApiError } from '@/lib/api'
import { fetchStockTakes, openStockTake } from '@/lib/stock-take-api'
import { latestCountSheet } from '@/lib/stock-take-store'
import { formatMoney, type StockTakeView } from '@/lib/stock-take'
import { radii, spacing, typography, useTheme } from '@/lib/theme'

const STATUS_LABEL: Record<StockTakeView['status'], string> = {
  counting: 'Counting',
  review: 'In review',
  posted: 'Posted',
  cancelled: 'Cancelled',
}

export default function StockTakeHome() {
  const { token, user } = useAuth()
  const { colors } = useTheme()
  const router = useRouter()
  const insets = useSafeAreaInsets()
  const [open, setOpen] = useState<StockTakeView | null>(null)
  const [history, setHistory] = useState<StockTakeView[]>([])
  const [canManage, setCanManage] = useState(false)
  const [categories, setCategories] = useState<Array<{ name: string; products: number }>>([])
  const [loading, setLoading] = useState(true)
  const [offline, setOffline] = useState(false)
  const [showForm, setShowForm] = useState(false)
  const [scope, setScope] = useState<'all' | 'category'>('all')
  const [picked, setPicked] = useState<string[]>([])
  const [blind, setBlind] = useState(true)
  const [title, setTitle] = useState('')
  const [saving, setSaving] = useState(false)

  const load = useCallback(async () => {
    if (!token || !user) return
    try {
      const data = await fetchStockTakes(token)
      setOpen(data.open)
      setHistory(data.stockTakes.filter((t) => t.id !== data.open?.id))
      setCanManage(data.canManage)
      setCategories(data.categories ?? [])
      setOffline(false)
    } catch {
      // No signal: offer the count sheet already on this phone.
      const cached = await latestCountSheet({ tenantId: user.tenantId, userId: user.id }).catch(() => null)
      setOpen(cached && cached.stockTake.status === 'counting' ? cached.stockTake : null)
      setOffline(true)
    } finally {
      setLoading(false)
    }
  }, [token, user])

  useFocusEffect(
    useCallback(() => {
      void load()
    }, [load]),
  )

  const start = async () => {
    if (!token) return
    if (scope === 'category' && picked.length === 0) {
      Alert.alert('Choose categories', 'Pick at least one category to count.')
      return
    }
    setSaving(true)
    try {
      const { stockTake } = await openStockTake(token, {
        title: title.trim() || undefined,
        scope,
        categories: scope === 'category' ? picked : undefined,
        blind,
      })
      setShowForm(false)
      router.push(`/stock-take/${stockTake.id}` as never)
    } catch (error) {
      Alert.alert('Could not open the count', error instanceof ApiError ? error.message : 'Try again.')
    } finally {
      setSaving(false)
    }
  }

  const toggleCategory = (name: string) =>
    setPicked((current) => (current.includes(name) ? current.filter((c) => c !== name) : [...current, name]))

  return (
    <View style={[styles.root, { backgroundColor: colors.bg, paddingTop: insets.top }]}>
      <View style={styles.header}>
        <Pressable onPress={() => router.back()} hitSlop={12} accessibilityRole="button" accessibilityLabel="Go back">
          <Ionicons name="chevron-back" size={22} color={colors.primary} />
        </Pressable>
        <Text style={[styles.title, { color: colors.text }]}>Stock take</Text>
        <Pressable
          onPress={() => router.push('/quick-receive' as never)}
          hitSlop={12}
          accessibilityRole="button"
          accessibilityLabel="Quick receive"
        >
          <Ionicons name="cube-outline" size={22} color={colors.primary} />
        </Pressable>
      </View>
      <ScrollView
        contentContainerStyle={{ padding: spacing.lg, paddingBottom: insets.bottom + spacing.xxxl }}
        refreshControl={<RefreshControl refreshing={false} onRefresh={load} tintColor={colors.primary} />}
        keyboardShouldPersistTaps="handled"
      >
        {offline ? (
          <Text style={[styles.banner, { backgroundColor: colors.warningSoft, color: colors.warning }]}>
            Offline. You can keep counting on the sheet saved on this phone.
          </Text>
        ) : null}

        {open ? (
          <Pressable
            onPress={() => router.push(`/stock-take/${open.id}` as never)}
            style={[styles.openCard, { backgroundColor: colors.primarySoft, borderColor: colors.primary }]}
            accessibilityRole="button"
          >
            <Text style={[styles.caption, { color: colors.primary }]}>
              {open.reference} · {STATUS_LABEL[open.status]}
            </Text>
            <Text style={[styles.cardTitle, { color: colors.text }]}>{open.title}</Text>
            <Text style={[styles.body, { color: colors.textSecondary }]}>
              {open.scope === 'all' ? 'Whole store' : open.categories.join(', ')}
              {open.blind ? ' · blind count' : ''}
            </Text>
            <View style={styles.row}>
              <Button
                label={open.status === 'counting' ? 'Count now' : 'Open'}
                onPress={() => router.push(`/stock-take/${open.id}` as never)}
                style={{ flex: 1 }}
              />
              {open.canManage && !offline ? (
                <Button
                  label="Review"
                  variant="ghost"
                  onPress={() => router.push(`/stock-take/${open.id}/review` as never)}
                  style={{ flex: 1 }}
                />
              ) : null}
            </View>
          </Pressable>
        ) : loading ? null : (
          <View style={[styles.empty, { borderColor: colors.border }]}>
            <Ionicons name="clipboard-outline" size={28} color={colors.textMuted} />
            <Text style={[styles.body, { color: colors.textSecondary, textAlign: 'center' }]}>
              {canManage
                ? 'No count is open. Open one and every phone can join it.'
                : 'No count is open. A manager opens one, then it shows here.'}
            </Text>
          </View>
        )}

        {canManage && !open && !offline ? (
          showForm ? (
            <View style={[styles.form, { backgroundColor: colors.surface, borderColor: colors.border }]}>
              <TextField label="Name (optional)" value={title} onChangeText={setTitle} placeholder="Cut-over count" />
              <ChoiceChips
                label="What to count"
                options={[
                  { value: 'all', label: 'Whole store' },
                  { value: 'category', label: 'Some categories' },
                ]}
                value={scope}
                onChange={setScope}
              />
              {scope === 'category' ? (
                <View style={styles.chips}>
                  {categories.map((c) => {
                    const on = picked.includes(c.name)
                    return (
                      <Pressable
                        key={c.name}
                        onPress={() => toggleCategory(c.name)}
                        accessibilityRole="checkbox"
                        accessibilityState={{ checked: on }}
                        style={[
                          styles.chip,
                          {
                            backgroundColor: on ? colors.primarySoft : colors.bgElevated,
                            borderColor: on ? colors.primary : colors.border,
                          },
                        ]}
                      >
                        <Text style={[styles.chipText, { color: on ? colors.primary : colors.text }]}>
                          {c.name} · {c.products}
                        </Text>
                      </Pressable>
                    )
                  })}
                </View>
              ) : null}
              <View style={styles.switchRow}>
                <View style={{ flex: 1 }}>
                  <Text style={[styles.body, { color: colors.text }]}>Blind count</Text>
                  <Text style={[styles.small, { color: colors.textMuted }]}>
                    Counters do not see the book quantity, so they count what is there.
                  </Text>
                </View>
                <Switch value={blind} onValueChange={setBlind} />
              </View>
              <Button label="Open count" onPress={start} loading={saving} />
            </View>
          ) : (
            <Button label="Open a new count" onPress={() => setShowForm(true)} />
          )
        ) : null}

        {history.length > 0 ? (
          <Text style={[styles.section, { color: colors.textSecondary }]}>Earlier counts</Text>
        ) : null}
        {history.map((t) => {
          const summary = t.postingSummary as
            | { productsChanged?: number; netValue?: number; negativesCleared?: number }
            | null
          return (
            <View key={t.id} style={[styles.historyRow, { borderColor: colors.border }]}>
              <View style={{ flex: 1 }}>
                <Text style={[styles.body, { color: colors.text }]}>{t.title}</Text>
                <Text style={[styles.small, { color: colors.textMuted }]}>
                  {t.reference} · {STATUS_LABEL[t.status]}
                  {summary
                    ? ` · ${summary.productsChanged ?? 0} items changed · net ${formatMoney(Number(summary.netValue ?? 0))}`
                    : ''}
                </Text>
              </View>
            </View>
          )
        })}
      </ScrollView>
    </View>
  )
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
  },
  title: { ...typography.h3 },
  banner: { ...typography.bodySm, padding: spacing.md, borderRadius: radii.md, marginBottom: spacing.lg },
  openCard: { borderWidth: 1, borderRadius: radii.lg, padding: spacing.lg, gap: spacing.sm, marginBottom: spacing.xl },
  caption: { ...typography.label },
  cardTitle: { ...typography.h2 },
  body: { ...typography.body },
  small: { ...typography.bodySm },
  row: { flexDirection: 'row', gap: spacing.md, marginTop: spacing.sm },
  empty: {
    borderWidth: 1,
    borderStyle: 'dashed',
    borderRadius: radii.lg,
    padding: spacing.xl,
    alignItems: 'center',
    gap: spacing.sm,
    marginBottom: spacing.xl,
  },
  form: { borderWidth: 1, borderRadius: radii.lg, padding: spacing.lg, gap: spacing.md },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  chip: { borderWidth: 1, borderRadius: radii.full, paddingHorizontal: spacing.md, paddingVertical: spacing.sm },
  chipText: { ...typography.bodySm },
  switchRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  section: { ...typography.label, marginTop: spacing.xxl, marginBottom: spacing.sm },
  historyRow: { borderBottomWidth: StyleSheet.hairlineWidth, paddingVertical: spacing.md, flexDirection: 'row' },
})
