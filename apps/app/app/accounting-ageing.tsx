import { useEffect, useState } from 'react'
import { StyleSheet, Text, View } from 'react-native'
import { ScreenShell } from '@/components/ui/ScreenShell'
import { Card, SectionHeader } from '@/components/ui/Card'
import { ChoiceChips } from '@/components/ui/ChoiceChips'
import { EmptyState } from '@/components/ui/EmptyState'
import { LoadingBlock } from '@/components/ui/LoadingBlock'
import { TextField } from '@/components/ui/TextField'
import { useAuth } from '@/lib/auth'
import {
  ApiError,
  fetchAccountingAgeing,
  type AccountingAgeing,
  type AccountingAgeingSummary,
} from '@/lib/api'
import { isoLocal } from '@/lib/ranges'
import { radii, spacing, typography, useTheme } from '@/lib/theme'

type Side = 'all' | 'receivable' | 'payable'

const SIDES = [
  { value: 'all', label: 'Both' },
  { value: 'receivable', label: 'Receivable' },
  { value: 'payable', label: 'Payable' },
] as const satisfies ReadonlyArray<{ value: Side; label: string }>

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

export default function AccountingAgeingScreen() {
  const { token } = useAuth()
  const { colors } = useTheme()

  const [asOf, setAsOf] = useState(() => isoLocal(new Date()))
  const [side, setSide] = useState<Side>('all')
  const [data, setData] = useState<AccountingAgeing | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const validDate = DATE_RE.test(asOf.trim())

  useEffect(() => {
    if (!token) {
      setLoading(false)
      return
    }
    if (!validDate) {
      setData(null)
      setError(null)
      setLoading(false)
      return
    }
    let cancelled = false
    setLoading(true)
    setError(null)
    fetchAccountingAgeing(token, { asOf: asOf.trim(), side })
      .then((result) => {
        if (!cancelled) setData(result)
      })
      .catch((err) => {
        if (cancelled) return
        setData(null)
        setError(
          err instanceof ApiError && err.status === 403
            ? 'Your role does not include financial reports.'
            : 'Could not load outstanding balances.',
        )
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [token, asOf, validDate, side])

  const money = (value: number, currency: string) =>
    `${currency} ${Number(value ?? 0).toLocaleString()}`

  return (
    <ScreenShell title="Outstanding" contentStyle={styles.content}>
      <ChoiceChips label="Show" options={SIDES} value={side} onChange={setSide} />

      <TextField
        label="As of"
        value={asOf}
        onChangeText={setAsOf}
        placeholder="YYYY-MM-DD"
        autoCapitalize="none"
        keyboardType="numbers-and-punctuation"
        hint="Balances at the end of this day"
      />
      {!validDate ? (
        <Text style={[styles.note, { color: colors.textMuted }]}>Use YYYY-MM-DD for the date.</Text>
      ) : null}

      {loading ? (
        <LoadingBlock message="Loading outstanding balances…" />
      ) : error ? (
        <Card>
          <Text style={[styles.message, { color: colors.textSecondary }]}>{error}</Text>
        </Card>
      ) : !data ? null : (
        <>
          {data.receivable ? (
            <>
              <SectionHeader
                title={`Receivables · ${data.receivable.currency}`}
                style={styles.spacer}
              />
              <Text style={[styles.note, { color: colors.textMuted }]}>
                {data.receivable.customerCount} customer
                {data.receivable.customerCount === 1 ? '' : 's'} with an open balance.
              </Text>
              <BucketRows
                summary={data.receivable}
                currency={data.receivable.currency}
                definitions={data.bucketDefinitions}
              />
              {data.receivable.total === 0 ? (
                <Card>
                  <Text style={[styles.message, { color: colors.textMuted }]}>
                    Nothing is outstanding.
                  </Text>
                </Card>
              ) : (
                <DetailList
                  summary={data.receivable}
                  currency={data.receivable.currency}
                  money={money}
                />
              )}
            </>
          ) : null}

          {data.payable?.map((summary) => (
            <View key={summary.currency}>
              <SectionHeader title={`Payables · ${summary.currency}`} style={styles.spacer} />
              <Text style={[styles.note, { color: colors.textMuted }]}>
                {summary.supplierCount} supplier{summary.supplierCount === 1 ? '' : 's'} with an
                open bill.
              </Text>
              <BucketRows
                summary={summary}
                currency={summary.currency}
                definitions={data.bucketDefinitions}
              />
              {summary.total === 0 ? (
                <Card>
                  <Text style={[styles.message, { color: colors.textMuted }]}>
                    Nothing is outstanding.
                  </Text>
                </Card>
              ) : (
                <DetailList summary={summary} currency={summary.currency} money={money} />
              )}
            </View>
          ))}

          {!data.receivable && !data.payable ? (
            <EmptyState
              icon="document"
              title="Nothing outstanding"
              body="There are no open customer balances or supplier bills to age."
            />
          ) : null}

          <Text style={[styles.footnote, { color: colors.textMuted }]}>
            A repayment is not linked to the invoice it settled, so it is applied to the oldest open
            invoice first. Treat the receivable bands as an estimate. Supplier bills age from the
            purchase date, because purchases carry no due date.
          </Text>
        </>
      )}
    </ScreenShell>
  )
}

function BucketRows({
  summary,
  currency,
  definitions,
}: {
  summary: AccountingAgeingSummary
  currency: string
  definitions: AccountingAgeing['bucketDefinitions']
}) {
  const { colors } = useTheme()
  const money = (value: number) =>
    value === 0 ? '—' : `${currency} ${Number(value ?? 0).toLocaleString()}`

  return (
    <Card padded={false}>
      {definitions.map((bucket, index) => (
        <View key={bucket.id}>
          {index > 0 ? (
            <View style={[styles.divider, { backgroundColor: colors.borderSubtle }]} />
          ) : null}
          <View style={styles.bucketRow}>
            <Text style={[styles.bucketLabel, { color: colors.textSecondary }]}>
              {bucket.label}
            </Text>
            <Text style={[styles.bucketValue, { color: colors.text }]}>
              {money(summary.buckets[bucket.id])}
            </Text>
          </View>
        </View>
      ))}
      <View style={[styles.divider, { backgroundColor: colors.border }]} />
      <View style={styles.bucketRow}>
        <Text style={[styles.bucketTotalLabel, { color: colors.text }]}>Total</Text>
        <Text style={[styles.bucketTotalValue, { color: colors.text }]}>
          {money(summary.total)}
        </Text>
      </View>
    </Card>
  )
}

function DetailList({
  summary,
  currency,
  money,
}: {
  summary: AccountingAgeingSummary
  currency: string
  money: (value: number, currency: string) => string
}) {
  const { colors } = useTheme()
  return (
    <>
      <Card padded={false}>
        {summary.rows.map((row, index) => (
          <View key={`${row.reference}-${row.dueDate}-${row.date}-${index}`}>
            {index > 0 ? (
              <View style={[styles.divider, { backgroundColor: colors.borderSubtle }]} />
            ) : null}
            <View style={styles.row}>
              <View style={styles.rowCopy}>
                <Text style={[styles.rowTitle, { color: colors.text }]} numberOfLines={1}>
                  {row.partyName}
                </Text>
                <Text style={[styles.rowSub, { color: colors.textMuted }]} numberOfLines={1}>
                  {row.reference || '—'} · due {row.dueDate ?? row.date}
                </Text>
                <Text
                  style={[
                    styles.rowSub,
                    { color: row.daysOverdue > 0 ? colors.warning : colors.textMuted },
                  ]}
                  numberOfLines={1}
                >
                  {row.daysOverdue > 0 ? `${row.daysOverdue} days overdue` : 'Not due'}
                </Text>
              </View>
              <Text style={[styles.rowAmount, { color: colors.text }]}>
                {money(row.amount, currency)}
              </Text>
            </View>
          </View>
        ))}
      </Card>
      {summary.truncated ? (
        <Text style={[styles.note, { color: colors.warning }]}>
          Showing the oldest {summary.rows.length} of {summary.rowCount} open documents.
        </Text>
      ) : null}
    </>
  )
}

const styles = StyleSheet.create({
  content: { gap: spacing.md },
  spacer: { marginTop: spacing.sm },
  note: { ...typography.caption, marginTop: -spacing.sm, lineHeight: 18 },
  message: { ...typography.bodySm, lineHeight: 20 },
  divider: { height: 1, marginHorizontal: spacing.lg },
  bucketRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
  },
  bucketLabel: { ...typography.bodySm },
  bucketValue: { ...typography.bodySm, fontFamily: 'IBMPlexMono_400Regular' },
  bucketTotalLabel: { ...typography.bodySm, fontFamily: 'DMSans_500Medium' },
  bucketTotalValue: { ...typography.bodySm, fontFamily: 'IBMPlexMono_500Medium' },
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, padding: spacing.lg },
  rowCopy: { flex: 1 },
  rowTitle: { ...typography.bodySm, fontFamily: 'DMSans_500Medium' },
  rowSub: { ...typography.caption, marginTop: 2 },
  rowAmount: { ...typography.bodySm, fontFamily: 'IBMPlexMono_400Regular' },
  footnote: { ...typography.caption, marginTop: spacing.md, lineHeight: 18 },
})
