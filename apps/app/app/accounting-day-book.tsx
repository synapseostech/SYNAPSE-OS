import { useCallback, useEffect, useMemo, useState } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import { useFocusEffect } from 'expo-router'
import { ScreenShell } from '@/components/ui/ScreenShell'
import { AccountPicker } from '@/components/ui/AccountPicker'
import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { ChoiceChips } from '@/components/ui/ChoiceChips'
import { EmptyState } from '@/components/ui/EmptyState'
import { LoadingBlock } from '@/components/ui/LoadingBlock'
import { useAuth } from '@/lib/auth'
import {
  ApiError,
  fetchAccountingDayBook,
  fetchAccountingOverview,
  type AccountingAccount,
  type AccountingDayBookEntry,
  type AccountingVoucherKind,
} from '@/lib/api'
import { RANGE_OPTIONS, isoLocal, rangeQuery, type RangeKey } from '@/lib/ranges'
import { spacing, typography, useTheme } from '@/lib/theme'

type VoucherFilter = 'all' | Exclude<AccountingVoucherKind, 'other'>

const VOUCHER_FILTERS = [
  { value: 'all', label: 'All' },
  { value: 'journal', label: 'Journal' },
  { value: 'payment', label: 'Payment' },
  { value: 'receipt', label: 'Receipt' },
  { value: 'contra', label: 'Contra' },
  { value: 'credit_note', label: 'Credit note' },
  { value: 'debit_note', label: 'Debit note' },
  { value: 'sales', label: 'Sales' },
  { value: 'purchase', label: 'Purchase' },
] as const satisfies ReadonlyArray<{ value: VoucherFilter; label: string }>

const PAGE_SIZE = 25

export default function AccountingDayBookScreen() {
  const { token } = useAuth()
  const { colors } = useTheme()

  const [range, setRange] = useState<RangeKey>('month')
  const query = useMemo(() => rangeQuery(range), [range])
  const [voucher, setVoucher] = useState<VoucherFilter>('all')
  const [accountId, setAccountId] = useState<string | null>(null)

  const [entries, setEntries] = useState<AccountingDayBookEntry[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<string | null>(null)

  const [accounts, setAccounts] = useState<AccountingAccount[]>([])
  const [accountsError, setAccountsError] = useState<string | null>(null)

  const load = useCallback(
    async (nextPage: number, mode: 'replace' | 'append') => {
      if (!token) {
        setLoading(false)
        return
      }
      if (mode === 'replace') {
        setLoading(true)
        setError(null)
      } else {
        setLoadingMore(true)
      }
      try {
        const result = await fetchAccountingDayBook(token, {
          from: query.from,
          to: query.to,
          voucherType: voucher === 'all' ? undefined : voucher,
          accountId,
          page: nextPage,
          pageSize: PAGE_SIZE,
        })
        setTotal(result.total)
        setPage(result.page)
        setEntries((current) => (mode === 'replace' ? result.entries : [...current, ...result.entries]))
      } catch (err) {
        if (mode === 'replace') {
          setEntries([])
          setTotal(0)
        }
        setError(
          err instanceof ApiError && err.status === 403
            ? 'Your role does not include financial reports.'
            : 'Could not load the day book.',
        )
      } finally {
        setLoading(false)
        setLoadingMore(false)
      }
    },
    [token, query, voucher, accountId],
  )

  useFocusEffect(
    useCallback(() => {
      void load(1, 'replace')
    }, [load]),
  )

  const loadAccounts = useCallback(async () => {
    if (!token) return
    setAccountsError(null)
    try {
      const today = isoLocal(new Date())
      const overview = await fetchAccountingOverview(token, today, today)
      setAccounts(overview.accounts)
    } catch (err) {
      setAccountsError(
        err instanceof ApiError && err.status === 403
          ? 'Account filter needs a financial reports permission.'
          : 'Could not load the account list.',
      )
    }
  }, [token])

  useEffect(() => {
    void loadAccounts()
  }, [loadAccounts])

  const money = (value: number, currency: string) =>
    `${currency} ${Number(value ?? 0).toLocaleString()}`

  return (
    <ScreenShell title="Day book" contentStyle={styles.content}>
      <ChoiceChips label="Period" options={RANGE_OPTIONS} value={range} onChange={setRange} />
      <ChoiceChips
        label="Voucher type"
        options={VOUCHER_FILTERS}
        value={voucher}
        onChange={setVoucher}
      />

      <Text style={[styles.filterLabel, { color: colors.textSecondary }]}>Account</Text>
      <AccountPicker
        accounts={accounts}
        value={accountId}
        onChange={setAccountId}
        placeholder="Any account"
        clearLabel="Any account"
      />
      {accountsError ? (
        <Text style={[styles.note, { color: colors.textMuted }]}>{accountsError}</Text>
      ) : null}

      <Text style={[styles.summary, { color: colors.textMuted }]}>
        {query.from} to {query.to} · {total} entr{total === 1 ? 'y' : 'ies'}
      </Text>

      {loading ? (
        <LoadingBlock message="Loading day book…" />
      ) : error ? (
        <Card>
          <Text style={[styles.message, { color: colors.textSecondary }]}>{error}</Text>
        </Card>
      ) : entries.length === 0 ? (
        <EmptyState
          icon="document"
          title="No vouchers"
          body="Nothing was posted in this range with the filters you chose."
        />
      ) : (
        <View style={styles.list}>
          {entries.map((entry) => {
            const open = expanded === entry.id
            return (
              <Card key={entry.id} padded={false}>
                <Pressable
                  onPress={() => setExpanded(open ? null : entry.id)}
                  accessibilityRole="button"
                  accessibilityState={{ expanded: open }}
                  accessibilityLabel={`${open ? 'Collapse' : 'Expand'} entry ${entry.entryNo}`}
                  style={styles.entryHead}
                >
                  <Text style={[styles.entryTitle, { color: colors.text }]} numberOfLines={2}>
                    {entry.entryNo} · {entry.voucherLabel}
                  </Text>
                  <Text style={[styles.entryMeta, { color: colors.textMuted }]} numberOfLines={2}>
                    {entry.date} · {entry.description || 'No description'}
                  </Text>
                  <Text style={[styles.entryAmount, { color: colors.textSecondary }]}>
                    Dr {money(entry.totalDebit, entry.currency)} · Cr{' '}
                    {money(entry.totalCredit, entry.currency)}
                  </Text>
                </Pressable>

                {open ? (
                  <View style={[styles.lines, { borderTopColor: colors.borderSubtle }]}>
                    {entry.lines.map((line) => (
                      <View key={line.id} style={styles.lineRow}>
                        <View style={styles.lineCopy}>
                          <Text
                            style={[styles.lineAccount, { color: colors.text }]}
                            numberOfLines={2}
                          >
                            {line.accountCode} · {line.accountName}
                          </Text>
                          {line.description ? (
                            <Text
                              style={[styles.lineNote, { color: colors.textMuted }]}
                              numberOfLines={1}
                            >
                              {line.description}
                            </Text>
                          ) : null}
                        </View>
                        <Text style={[styles.lineAmount, { color: colors.textSecondary }]}>
                          {line.debit
                            ? `Dr ${money(line.debit, entry.currency)}`
                            : `Cr ${money(line.credit, entry.currency)}`}
                        </Text>
                      </View>
                    ))}
                  </View>
                ) : null}
              </Card>
            )
          })}
        </View>
      )}

      {!loading && !error && entries.length < total ? (
        <Button
          label={`Load more (${entries.length} of ${total})`}
          variant="ghost"
          loading={loadingMore}
          disabled={loadingMore}
          onPress={() => void load(page + 1, 'append')}
        />
      ) : null}

      <Text style={[styles.footnote, { color: colors.textMuted }]}>
        Newest first, one card per posting. Tap an entry to see each account it touched.
      </Text>
    </ScreenShell>
  )
}

const styles = StyleSheet.create({
  content: { gap: spacing.md },
  filterLabel: { ...typography.label, marginBottom: -spacing.sm },
  note: { ...typography.caption, marginTop: -spacing.sm },
  summary: { ...typography.caption },
  message: { ...typography.bodySm, lineHeight: 20 },
  list: { gap: spacing.sm },
  entryHead: { padding: spacing.lg, gap: 2 },
  entryTitle: { ...typography.bodyMedium, fontFamily: 'DMSans_500Medium' },
  entryMeta: { ...typography.caption, marginTop: 2 },
  entryAmount: { ...typography.caption, fontFamily: 'IBMPlexMono_400Regular', marginTop: spacing.xs },
  lines: { borderTopWidth: 1, paddingHorizontal: spacing.lg, paddingVertical: spacing.md, gap: spacing.sm },
  lineRow: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.md },
  lineCopy: { flex: 1 },
  lineAccount: { ...typography.bodySm },
  lineNote: { ...typography.caption, marginTop: 2 },
  lineAmount: { ...typography.caption, fontFamily: 'IBMPlexMono_400Regular' },
  footnote: { ...typography.caption, marginTop: spacing.sm, lineHeight: 18 },
})
