import { useCallback, useMemo, useState } from 'react'
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native'
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { Ionicons } from '@expo/vector-icons'
import { Button } from '@/components/ui/Button'
import { useAuth } from '@/lib/auth'
import { ApiError } from '@/lib/api'
import {
  changeStockTake,
  fetchStockTakeReview,
  postStockTake,
  setStockTakeRecount,
  type ReviewProductLine,
  type StockTakeReviewTotals,
} from '@/lib/stock-take-api'
import { formatExpiry, formatMoney, formatSigned, parseCountInput, type StockTakeView } from '@/lib/stock-take'
import { radii, spacing, typography, useTheme } from '@/lib/theme'

type Filter = 'issues' | 'variance' | 'uncounted' | 'all'

const RULE_LABEL: Record<string, string> = {
  counted: 'counted',
  negative_cleared: 'below zero → 0',
  uncounted_share: 'not counted, keeps share of loose count',
  count_batch: 'new count batch (no expiry known)',
  new_batch: 'batch found on shelf',
  unchanged: 'unchanged',
}

export default function StockTakeReview() {
  const { id } = useLocalSearchParams<{ id: string }>()
  const { token } = useAuth()
  const { colors } = useTheme()
  const router = useRouter()
  const insets = useSafeAreaInsets()
  const [stockTake, setStockTake] = useState<StockTakeView | null>(null)
  const [totals, setTotals] = useState<StockTakeReviewTotals | null>(null)
  const [lines, setLines] = useState<ReviewProductLine[]>([])
  const [counters, setCounters] = useState<Record<string, string>>({})
  const [filter, setFilter] = useState<Filter>('issues')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<string | null>(null)
  const [recount, setRecount] = useState<{ line: ReviewProductLine; batchKey: string; label: string } | null>(null)
  const [recountQty, setRecountQty] = useState('')
  const [recountReason, setRecountReason] = useState('')
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    if (!token || !id) return
    try {
      const data = await fetchStockTakeReview(token, id)
      setStockTake(data.stockTake)
      setTotals(data.totals)
      setLines(data.lines)
      setCounters(data.counters)
      setError(null)
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not load the review. Check your connection.')
    } finally {
      setLoading(false)
    }
  }, [token, id])

  useFocusEffect(
    useCallback(() => {
      void load()
    }, [load]),
  )

  const visible = useMemo(() => {
    switch (filter) {
      case 'issues':
        return lines.filter(
          (l) => (!l.counted && l.negativeBook) || (l.counted && (l.variance !== 0 || l.movedSinceCount)),
        )
      case 'variance':
        return lines.filter((l) => l.counted && l.variance !== 0)
      case 'uncounted':
        return lines.filter((l) => !l.counted)
      default:
        return lines
    }
  }, [lines, filter])

  const transition = async (action: 'reopen' | 'cancel') => {
    if (!token || !id) return
    setBusy(true)
    try {
      await changeStockTake(token, id, action)
      if (action === 'reopen') router.replace(`/stock-take/${id}` as never)
      else router.replace('/stock-take' as never)
    } catch (e) {
      Alert.alert('Not changed', e instanceof ApiError ? e.message : 'Try again.')
    } finally {
      setBusy(false)
    }
  }

  const confirmPost = () => {
    if (!totals || !token || !id) return
    const warnings = [
      totals.uncountedNegative > 0
        ? `${totals.uncountedNegative} item(s) below zero were not counted and will stay below zero.`
        : null,
      totals.movedSinceCount > 0 ? `${totals.movedSinceCount} item(s) changed after they were counted.` : null,
    ].filter(Boolean)
    Alert.alert(
      'Post stock take?',
      [
        `${totals.productsWithVariance} item(s) change. Gain ${formatMoney(totals.valueGained)}, loss ${formatMoney(-totals.valueLost)}, net ${formatMoney(totals.netValue)} at cost.`,
        ...warnings,
        'This writes the adjustments to the book and cannot be undone.',
      ].join('\n\n'),
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Post',
          style: 'destructive',
          onPress: async () => {
            setBusy(true)
            try {
              const result = await postStockTake(token, id)
              const s = result.summary as { productsChanged?: number; negativesCleared?: number; netValue?: number }
              Alert.alert(
                'Posted',
                `${s.productsChanged ?? 0} item(s) adjusted, ${s.negativesCleared ?? 0} brought back from below zero. Net ${formatMoney(Number(s.netValue ?? 0))}.`,
              )
              router.replace('/stock-take' as never)
            } catch (e) {
              Alert.alert('Not posted', e instanceof ApiError ? e.message : 'Nothing was changed. Try again.')
            } finally {
              setBusy(false)
            }
          },
        },
      ],
    )
  }

  const saveRecount = async (clear: boolean) => {
    if (!recount || !token || !id) return
    const qty = clear ? null : parseCountInput(recountQty)
    if (!clear && (qty === null || Number.isNaN(qty))) {
      Alert.alert('Recount', 'Enter the quantity you counted.')
      return
    }
    if (!clear && !recountReason.trim()) {
      Alert.alert('Recount', 'Say why the figure changes (e.g. "recounted back store").')
      return
    }
    setBusy(true)
    try {
      await setStockTakeRecount(token, id, {
        productId: recount.line.productId,
        batchKey: recount.batchKey,
        overrideQty: qty,
        reason: recountReason.trim(),
      })
      setRecount(null)
      await load()
    } catch (e) {
      Alert.alert('Recount not saved', e instanceof ApiError ? e.message : 'Try again.')
    } finally {
      setBusy(false)
    }
  }

  if (loading) {
    return (
      <View style={[styles.center, { backgroundColor: colors.bg }]}>
        <ActivityIndicator color={colors.primary} />
      </View>
    )
  }

  const editable = stockTake?.status === 'counting' || stockTake?.status === 'review'

  return (
    <View style={[styles.root, { backgroundColor: colors.bg, paddingTop: insets.top }]}>
      <View style={styles.header}>
        <Pressable onPress={() => router.back()} hitSlop={12} accessibilityRole="button" accessibilityLabel="Go back">
          <Ionicons name="chevron-back" size={22} color={colors.primary} />
        </Pressable>
        <View style={{ flex: 1, alignItems: 'center' }}>
          <Text style={[styles.title, { color: colors.text }]}>Review count</Text>
          <Text style={[styles.small, { color: colors.textMuted }]}>{stockTake?.reference}</Text>
        </View>
        <Pressable onPress={() => void load()} hitSlop={12} accessibilityRole="button" accessibilityLabel="Refresh">
          <Ionicons name="refresh" size={22} color={colors.primary} />
        </Pressable>
      </View>

      {error ? <Text style={[styles.banner, { backgroundColor: colors.errorBg, color: colors.danger }]}>{error}</Text> : null}

      {totals ? (
        <View style={styles.tiles}>
          <Tile label="Counted" value={`${totals.productsCounted}/${totals.productsInScope}`} color={colors.text} />
          <Tile label="Variances" value={String(totals.productsWithVariance)} color={colors.warning} />
          <Tile label="Net value" value={formatMoney(totals.netValue)} color={totals.netValue < 0 ? colors.danger : colors.success} />
          <Tile label="Below zero fixed" value={String(totals.negativesToClear)} color={colors.teal} />
        </View>
      ) : null}
      {totals && totals.uncountedNegative > 0 ? (
        <Text style={[styles.banner, { backgroundColor: colors.dangerSoft, color: colors.danger }]}>
          {totals.uncountedNegative} item(s) are below zero and not counted yet. Count them (0 is a count) or they stay negative.
        </Text>
      ) : null}
      {totals && totals.movedSinceCount > 0 ? (
        <Text style={[styles.banner, { backgroundColor: colors.warningSoft, color: colors.warning }]}>
          {totals.movedSinceCount} item(s) changed after counting (a sale or delivery). Recount those before posting.
        </Text>
      ) : null}

      <View style={styles.filters}>
        {(
          [
            ['issues', 'Needs a look'],
            ['variance', 'Variances'],
            ['uncounted', 'Not counted'],
            ['all', 'All'],
          ] as Array<[Filter, string]>
        ).map(([value, label]) => (
          <Pressable
            key={value}
            onPress={() => setFilter(value)}
            style={[
              styles.filter,
              {
                backgroundColor: filter === value ? colors.primarySoft : 'transparent',
                borderColor: filter === value ? colors.primary : colors.border,
              },
            ]}
          >
            <Text style={[styles.filterText, { color: filter === value ? colors.primary : colors.textSecondary }]}>
              {label}
            </Text>
          </Pressable>
        ))}
      </View>

      <View style={[styles.colHead, { borderColor: colors.border }]}>
        <Text style={[styles.colLabel, { flex: 1, color: colors.textMuted }]}>Item</Text>
        <Text style={[styles.colLabel, styles.num, { color: colors.textMuted }]}>Book</Text>
        <Text style={[styles.colLabel, styles.num, { color: colors.textMuted }]}>Count</Text>
        <Text style={[styles.colLabel, styles.num, { color: colors.textMuted }]}>Var</Text>
        <Text style={[styles.colLabel, styles.value, { color: colors.textMuted }]}>Value</Text>
      </View>

      <FlatList
        data={visible}
        keyExtractor={(l) => l.productId}
        initialNumToRender={25}
        contentContainerStyle={{ paddingHorizontal: spacing.lg, paddingBottom: insets.bottom + 140 }}
        ListEmptyComponent={
          <Text style={[styles.small, { color: colors.textMuted, textAlign: 'center', marginTop: spacing.xl }]}>
            Nothing here.
          </Text>
        }
        renderItem={({ item: line }) => {
          const open = expanded === line.productId
          const varColor = line.variance > 0 ? colors.success : line.variance < 0 ? colors.danger : colors.textMuted
          return (
            <View style={[styles.line, { borderColor: colors.borderSubtle }]}>
              <Pressable
                onPress={() => setExpanded(open ? null : line.productId)}
                style={styles.lineRow}
                accessibilityRole="button"
                accessibilityState={{ expanded: open }}
              >
                <View style={{ flex: 1 }}>
                  <Text style={[styles.name, { color: colors.text }]} numberOfLines={2}>
                    {line.name}
                  </Text>
                  <Text style={[styles.tiny, { color: colors.textMuted }]} numberOfLines={1}>
                    {[
                      line.sku,
                      !line.counted ? 'not counted' : null,
                      line.multipleCounters ? 'several counters' : null,
                      line.movedSinceCount ? 'changed since count' : null,
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </Text>
                </View>
                <Text style={[styles.cell, styles.num, { color: line.negativeBook ? colors.danger : colors.text }]}>
                  {line.bookQty}
                </Text>
                <Text style={[styles.cell, styles.num, { color: colors.text }]}>{line.counted ? line.finalQty : '—'}</Text>
                <Text style={[styles.cell, styles.num, { color: varColor }]}>
                  {line.counted ? formatSigned(line.variance) : ''}
                </Text>
                <Text style={[styles.cell, styles.value, { color: varColor }]}>
                  {line.counted ? formatMoney(line.varianceValue) : ''}
                </Text>
              </Pressable>
              {open ? (
                <View style={[styles.batches, { backgroundColor: colors.bgSubtle }]}>
                  {line.batches.length === 0 ? (
                    <Text style={[styles.tiny, { color: colors.textMuted }]}>
                      Not counted. Posting leaves it at {line.bookQty}.
                    </Text>
                  ) : null}
                  {line.batches.map((b) => (
                    <View key={b.batchKey} style={styles.batchRow}>
                      <View style={{ flex: 1 }}>
                        <Text style={[styles.tiny, { color: colors.text }]}>
                          {b.batchNumber}
                          {b.expiryDate ? ` · exp ${formatExpiry(b.expiryDate)}` : ''}
                        </Text>
                        <Text style={[styles.tiny, { color: colors.textMuted }]}>
                          {RULE_LABEL[b.rule] ?? b.rule}
                          {b.counters.length
                            ? ` · ${b.counters.map((c) => `${counters[c.countedBy] ?? 'Staff'} ${c.countedQty}`).join(' + ')}`
                            : ''}
                          {b.overrideQty !== null ? ` · recount ${b.overrideQty} (${b.overrideReason})` : ''}
                        </Text>
                      </View>
                      <Text style={[styles.cell, styles.num, { color: colors.text }]}>{b.bookQty}</Text>
                      <Text style={[styles.cell, styles.num, { color: colors.text }]}>{b.finalQty}</Text>
                      {editable ? (
                        <Pressable
                          onPress={() => {
                            setRecount({ line, batchKey: b.batchKey, label: b.batchNumber })
                            setRecountQty(String(b.overrideQty ?? b.countedQty ?? b.finalQty))
                            setRecountReason(b.overrideReason ?? '')
                          }}
                          hitSlop={8}
                          accessibilityRole="button"
                          accessibilityLabel={`Recount ${b.batchNumber}`}
                        >
                          <Ionicons name="create-outline" size={18} color={colors.primary} />
                        </Pressable>
                      ) : (
                        <View style={{ width: 18 }} />
                      )}
                    </View>
                  ))}
                </View>
              ) : null}
            </View>
          )
        }}
      />

      {editable ? (
        <View
          style={[
            styles.footer,
            { backgroundColor: colors.bg, borderColor: colors.border, paddingBottom: insets.bottom + spacing.md },
          ]}
        >
          {stockTake?.status === 'review' ? (
            <>
              <Button label="Post to stock" onPress={confirmPost} loading={busy} />
              <View style={styles.footerRow}>
                <Button label="Reopen counting" variant="ghost" onPress={() => transition('reopen')} style={{ flex: 1 }} />
                <Button
                  label="Cancel count"
                  variant="danger"
                  style={{ flex: 1 }}
                  onPress={() =>
                    Alert.alert('Cancel this count?', 'Nothing is posted. Counts are kept for the record.', [
                      { text: 'Keep', style: 'cancel' },
                      { text: 'Cancel count', style: 'destructive', onPress: () => transition('cancel') },
                    ])
                  }
                />
              </View>
            </>
          ) : (
            <Text style={[styles.small, { color: colors.textSecondary, textAlign: 'center' }]}>
              Still counting. Close counting on the count screen before posting; recounts can be made now.
            </Text>
          )}
        </View>
      ) : null}

      <Modal visible={!!recount} transparent animationType="fade" onRequestClose={() => setRecount(null)}>
        <View style={[styles.modalBack, { backgroundColor: 'rgba(0,0,0,0.5)' }]}>
          <View style={[styles.modal, { backgroundColor: colors.bg, borderColor: colors.border }]}>
            <Text style={[styles.name, { color: colors.text }]}>Recount {recount?.line.name}</Text>
            <Text style={[styles.small, { color: colors.textMuted }]}>{recount?.label}. Replaces what the counters entered.</Text>
            <TextInput
              value={recountQty}
              onChangeText={setRecountQty}
              keyboardType="numbers-and-punctuation"
              selectTextOnFocus
              style={[styles.modalInput, { color: colors.text, borderColor: colors.border }]}
              accessibilityLabel="Recounted quantity"
            />
            <TextInput
              value={recountReason}
              onChangeText={setRecountReason}
              placeholder="Why (e.g. recounted back store)"
              placeholderTextColor={colors.textMuted}
              style={[styles.modalInput, { color: colors.text, borderColor: colors.border }]}
            />
            <View style={styles.footerRow}>
              <Button label="Remove recount" variant="ghost" onPress={() => saveRecount(true)} style={{ flex: 1 }} />
              <Button label="Save" onPress={() => saveRecount(false)} loading={busy} style={{ flex: 1 }} />
            </View>
          </View>
        </View>
      </Modal>
    </View>
  )
}

function Tile({ label, value, color }: { label: string; value: string; color: string }) {
  const { colors } = useTheme()
  return (
    <View style={[styles.tile, { backgroundColor: colors.surface, borderColor: colors.border }]}>
      <Text style={[styles.tileValue, { color }]} numberOfLines={1}>
        {value}
      </Text>
      <Text style={[styles.tiny, { color: colors.textMuted }]}>{label}</Text>
    </View>
  )
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: spacing.lg, paddingVertical: spacing.sm, gap: spacing.md },
  title: { ...typography.h4 },
  small: { ...typography.bodySm },
  tiny: { ...typography.caption },
  banner: { ...typography.bodySm, marginHorizontal: spacing.lg, marginBottom: spacing.sm, padding: spacing.sm, borderRadius: radii.md },
  tiles: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, paddingHorizontal: spacing.lg, marginBottom: spacing.sm },
  tile: { flexBasis: '47%', flexGrow: 1, borderWidth: 1, borderRadius: radii.md, padding: spacing.md },
  tileValue: { ...typography.stat },
  filters: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, paddingHorizontal: spacing.lg, marginBottom: spacing.sm },
  filter: { borderWidth: 1, borderRadius: radii.full, paddingHorizontal: spacing.md, paddingVertical: 6 },
  filterText: { ...typography.caption },
  colHead: { flexDirection: 'row', paddingHorizontal: spacing.lg, paddingBottom: spacing.xs, borderBottomWidth: StyleSheet.hairlineWidth, gap: spacing.xs },
  colLabel: { ...typography.label },
  num: { width: 44, textAlign: 'right' },
  value: { width: 64, textAlign: 'right' },
  cell: { ...typography.bodySm },
  line: { borderBottomWidth: StyleSheet.hairlineWidth },
  lineRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: spacing.sm, gap: spacing.xs },
  name: { ...typography.bodyMedium },
  batches: { borderRadius: radii.md, padding: spacing.sm, marginBottom: spacing.sm, gap: spacing.sm },
  batchRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs },
  footer: { position: 'absolute', left: 0, right: 0, bottom: 0, borderTopWidth: StyleSheet.hairlineWidth, padding: spacing.lg, gap: spacing.sm },
  footerRow: { flexDirection: 'row', gap: spacing.md },
  modalBack: { flex: 1, justifyContent: 'center', padding: spacing.xl },
  modal: { borderWidth: 1, borderRadius: radii.lg, padding: spacing.lg, gap: spacing.md },
  modalInput: { ...typography.body, borderWidth: 1, borderRadius: radii.md, paddingHorizontal: spacing.md, paddingVertical: spacing.sm },
})
