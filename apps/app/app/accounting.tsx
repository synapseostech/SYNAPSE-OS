import { useCallback, useMemo, useState } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import { useFocusEffect, useRouter } from 'expo-router'
import { ScreenShell } from '@/components/ui/ScreenShell'
import { Button } from '@/components/ui/Button'
import { Card, SectionHeader } from '@/components/ui/Card'
import { EmptyState } from '@/components/ui/EmptyState'
import { LoadingBlock } from '@/components/ui/LoadingBlock'
import { useAuth } from '@/lib/auth'
import { ApiError, fetchAccountingOverview, type AccountingOverview } from '@/lib/api'
import { RANGE_OPTIONS, rangeQuery, type RangeKey } from '@/lib/ranges'
import { radii, spacing, typography, useTheme } from '@/lib/theme'

export default function AccountingScreen() {
  const { token } = useAuth()
  const { colors } = useTheme()
  const router = useRouter()
  const [range, setRange] = useState<RangeKey>('month')
  const [data, setData] = useState<AccountingOverview | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const query = useMemo(() => rangeQuery(range), [range])

  const load = useCallback(async () => {
    if (!token) {
      setLoading(false)
      return
    }
    setLoading(true)
    setError(null)
    try {
      setData(await fetchAccountingOverview(token, query.from, query.to))
    } catch (err) {
      setData(null)
      setError(
        err instanceof ApiError && err.status === 403
          ? 'Your role does not include financial reports.'
          : 'Could not load accounting records.',
      )
    } finally {
      setLoading(false)
    }
  }, [token, query])

  useFocusEffect(
    useCallback(() => {
      void load()
    }, [load]),
  )

  const currency = data?.currency ?? 'UGX'
  const money = (value: number | string) =>
    `${currency} ${Number(value ?? 0).toLocaleString()}`

  const totalDebit = (data?.trialBalance ?? []).reduce((sum, row) => sum + Number(row.debit ?? 0), 0)
  const totalCredit = (data?.trialBalance ?? []).reduce((sum, row) => sum + Number(row.credit ?? 0), 0)
  const periodRows = (data?.periodActivity ?? []).filter(
    (row) => Number(row.debit ?? 0) !== 0 || Number(row.credit ?? 0) !== 0,
  )

  return (
    <ScreenShell title="Accounting" contentStyle={styles.content}>
      <View style={styles.chips}>
        {RANGE_OPTIONS.map((option) => {
          const active = option.value === range
          return (
            <Pressable
              key={option.value}
              onPress={() => setRange(option.value)}
              accessibilityRole="button"
              accessibilityState={{ selected: active }}
              style={[
                styles.chip,
                {
                  borderColor: active ? colors.primary : colors.border,
                  backgroundColor: active ? colors.primarySoft : colors.bgElevated,
                },
              ]}
            >
              <Text
                style={[styles.chipText, { color: active ? colors.primary : colors.textSecondary }]}
              >
                {option.label}
              </Text>
            </Pressable>
          )
        })}
      </View>

      {loading ? (
        <LoadingBlock message="Loading accounts…" />
      ) : error ? (
        <Card>
          <Text style={[styles.message, { color: colors.textSecondary }]}>{error}</Text>
        </Card>
      ) : !data ? null : (
        <>
          <Text style={[styles.rangeLine, { color: colors.textMuted }]}>
            {data.from} to {data.to}
          </Text>

          <View style={styles.actions}>
            <Button
              label="New entry"
              onPress={() => router.push('/accounting-entry' as never)}
              style={styles.action}
            />
            <Button
              label="Periods"
              variant="ghost"
              onPress={() => router.push('/accounting-periods' as never)}
              style={styles.action}
            />
          </View>

          <View style={styles.actions}>
            <Button
              label="Day book"
              variant="ghost"
              onPress={() => router.push('/accounting-day-book' as never)}
              style={styles.action}
            />
            <Button
              label="Ledger"
              variant="ghost"
              onPress={() => router.push('/accounting-ledger' as never)}
              style={styles.action}
            />
          </View>

          <View style={styles.actions}>
            <Button
              label="Outstanding"
              variant="ghost"
              onPress={() => router.push('/accounting-ageing' as never)}
              style={styles.action}
            />
            <Button
              label="Bank rec"
              variant="ghost"
              onPress={() => router.push('/accounting-reconciliation' as never)}
              style={styles.action}
            />
          </View>

          <View style={styles.stats}>
            <Stat label="Total debit" value={money(totalDebit)} />
            <Stat label="Total credit" value={money(totalCredit)} />
            <Stat label="Accounts" value={String(data.trialBalance.length)} />
          </View>

          <SectionHeader title="Trial balance" style={styles.spacer} />
          {data.trialBalance.length === 0 ? (
            <Card>
              <Text style={[styles.message, { color: colors.textMuted }]}>
                No journal entries have been posted yet.
              </Text>
            </Card>
          ) : (
            <Card padded={false}>
              {data.trialBalance.map((row, index) => (
                <View key={row.account_id}>
                  {index > 0 ? (
                    <View style={[styles.divider, { backgroundColor: colors.borderSubtle }]} />
                  ) : null}
                  <Row
                    left={`${row.code ?? ''} · ${row.name ?? ''}`}
                    sub={(row.account_type ?? '').replace(/_/g, ' ')}
                    right={money(row.balance)}
                  />
                </View>
              ))}
            </Card>
          )}

          <SectionHeader title="Period activity" style={styles.spacer} />
          {periodRows.length === 0 ? (
            <Card>
              <Text style={[styles.message, { color: colors.textMuted }]}>
                Nothing posted in this period.
              </Text>
            </Card>
          ) : (
            <Card padded={false}>
              {periodRows.map((row, index) => (
                <View key={`${row.account_id}-${index}`}>
                  {index > 0 ? (
                    <View style={[styles.divider, { backgroundColor: colors.borderSubtle }]} />
                  ) : null}
                  <Row
                    left={`${row.code ?? ''} · ${row.name ?? ''}`}
                    sub={`Dr ${money(row.debit)} · Cr ${money(row.credit)}`}
                    right={money(row.balance)}
                  />
                </View>
              ))}
            </Card>
          )}

          <SectionHeader title="Recent journal entries" style={styles.spacer} />
          {data.recentEntries.length === 0 ? (
            <EmptyState
              icon="document"
              title="No journal entries"
              body="Sales, purchases and repayments post here automatically once they are recorded."
            />
          ) : (
            <View style={styles.list}>
              {data.recentEntries.map((entry) => (
                <Card key={entry.id}>
                  <Text style={[styles.entryTitle, { color: colors.text }]} numberOfLines={2}>
                    {entry.description || entry.sourceType || 'Journal entry'}
                  </Text>
                  <Text style={[styles.entryMeta, { color: colors.textMuted }]}>
                    {entry.entryNo ?? '—'} · {entry.entryDate ?? '—'}
                    {entry.sourceType ? ` · ${entry.sourceType.replace(/_/g, ' ')}` : ''}
                  </Text>
                  <Text style={[styles.entryAmount, { color: colors.textSecondary }]}>
                    Dr {money(entry.totalDebit)} · Cr {money(entry.totalCredit)}
                  </Text>
                </Card>
              ))}
            </View>
          )}

          <Text style={[styles.footnote, { color: colors.textMuted }]}>
            Vouchers posted here and periods closed here use the same ledger as the web portal.
            Closed periods refuse further postings rather than moving them.
          </Text>
        </>
      )}
    </ScreenShell>
  )
}

function Stat({ label, value }: { label: string; value: string }) {
  const { colors } = useTheme()
  return (
    <View style={[styles.stat, { backgroundColor: colors.surface, borderColor: colors.border }]}>
      <Text style={[styles.statValue, { color: colors.text }]} numberOfLines={1}>
        {value}
      </Text>
      <Text style={[styles.statLabel, { color: colors.textMuted }]}>{label}</Text>
    </View>
  )
}

function Row({ left, sub, right }: { left: string; sub?: string; right: string }) {
  const { colors } = useTheme()
  return (
    <View style={styles.row}>
      <View style={styles.rowCopy}>
        <Text style={[styles.rowLeft, { color: colors.text }]} numberOfLines={2}>
          {left}
        </Text>
        {sub ? (
          <Text style={[styles.rowSub, { color: colors.textMuted }]} numberOfLines={1}>
            {sub}
          </Text>
        ) : null}
      </View>
      <Text style={[styles.rowRight, { color: colors.textSecondary }]}>{right}</Text>
    </View>
  )
}

const styles = StyleSheet.create({
  content: { gap: spacing.md },
  chips: { flexDirection: 'row', gap: spacing.sm },
  chip: { flex: 1, borderWidth: 1, borderRadius: radii.md, paddingVertical: spacing.sm, alignItems: 'center' },
  chipText: { ...typography.caption },
  rangeLine: { ...typography.caption },
  actions: { flexDirection: 'row', gap: spacing.sm },
  action: { flex: 1 },
  stats: { flexDirection: 'row', gap: spacing.sm },
  stat: { flex: 1, borderWidth: 1, borderRadius: radii.md, padding: spacing.md },
  statValue: { ...typography.bodyMedium, fontFamily: 'IBMPlexMono_500Medium' },
  statLabel: { ...typography.caption, marginTop: 2 },
  spacer: { marginTop: spacing.sm },
  divider: { height: 1, marginHorizontal: spacing.lg },
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, padding: spacing.lg },
  rowCopy: { flex: 1 },
  rowLeft: { ...typography.bodySm },
  rowSub: { ...typography.caption, marginTop: 2, textTransform: 'capitalize' },
  rowRight: { ...typography.bodySm, fontFamily: 'IBMPlexMono_400Regular' },
  message: { ...typography.bodySm },
  list: { gap: spacing.sm },
  entryTitle: { ...typography.bodyMedium, fontFamily: 'DMSans_500Medium' },
  entryMeta: { ...typography.caption, marginTop: 2 },
  entryAmount: { ...typography.caption, fontFamily: 'IBMPlexMono_400Regular', marginTop: spacing.xs },
  footnote: { ...typography.caption, marginTop: spacing.md, lineHeight: 18 },
})
