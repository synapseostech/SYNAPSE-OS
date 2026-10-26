import { useCallback, useEffect, useMemo, useState } from 'react'
import { StyleSheet, Text, View } from 'react-native'
import { ScreenShell } from '@/components/ui/ScreenShell'
import { AccountPicker } from '@/components/ui/AccountPicker'
import { Card, SectionHeader } from '@/components/ui/Card'
import { ChoiceChips } from '@/components/ui/ChoiceChips'
import { EmptyState } from '@/components/ui/EmptyState'
import { LoadingBlock } from '@/components/ui/LoadingBlock'
import { useAuth } from '@/lib/auth'
import {
  ApiError,
  fetchAccountingLedger,
  fetchAccountingOverview,
  type AccountingAccount,
  type AccountingLedger,
} from '@/lib/api'
import { RANGE_OPTIONS, isoLocal, rangeQuery, type RangeKey } from '@/lib/ranges'
import { radii, spacing, typography, useTheme } from '@/lib/theme'

export default function AccountingLedgerScreen() {
  const { token } = useAuth()
  const { colors } = useTheme()

  const [accounts, setAccounts] = useState<AccountingAccount[]>([])
  const [accountsLoading, setAccountsLoading] = useState(true)
  const [accountsError, setAccountsError] = useState<string | null>(null)

  const [accountId, setAccountId] = useState<string | null>(null)
  const [range, setRange] = useState<RangeKey>('month')
  const query = useMemo(() => rangeQuery(range), [range])
  const [currency, setCurrency] = useState<string | null>(null)

  const [ledger, setLedger] = useState<AccountingLedger | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const loadAccounts = useCallback(async () => {
    if (!token) {
      setAccountsLoading(false)
      return
    }
    setAccountsLoading(true)
    setAccountsError(null)
    try {
      const today = isoLocal(new Date())
      const overview = await fetchAccountingOverview(token, today, today)
      setAccounts(overview.accounts)
    } catch (err) {
      setAccountsError(
        err instanceof ApiError && err.status === 403
          ? 'Your role does not include financial reports.'
          : 'Could not load the chart of accounts.',
      )
    } finally {
      setAccountsLoading(false)
    }
  }, [token])

  useEffect(() => {
    void loadAccounts()
  }, [loadAccounts])

  useEffect(() => {
    if (!token || !accountId) {
      setLedger(null)
      setLoading(false)
      setError(null)
      return
    }
    let cancelled = false
    setLoading(true)
    setError(null)
    fetchAccountingLedger(token, {
      accountId,
      from: query.from,
      to: query.to,
      currency: currency ?? undefined,
    })
      .then((result) => {
        if (!cancelled) setLedger(result)
      })
      .catch((err) => {
        if (cancelled) return
        setLedger(null)
        setError(
          err instanceof ApiError && err.status === 403
            ? 'Your role does not include financial reports.'
            : err instanceof ApiError && err.status === 404
              ? 'That account is not in this chart of accounts.'
              : 'Could not load the account ledger.',
        )
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [token, accountId, query, currency])

  const money = (value: number, code: string) =>
    `${code} ${Number(value ?? 0).toLocaleString()}`

  return (
    <ScreenShell title="General ledger" contentStyle={styles.content}>
      <ChoiceChips label="Period" options={RANGE_OPTIONS} value={range} onChange={setRange} />

      <Text style={[styles.filterLabel, { color: colors.textSecondary }]}>Account</Text>
      <AccountPicker
        accounts={accounts}
        value={accountId}
        onChange={(next) => {
          setAccountId(next)
          setCurrency(null)
        }}
        placeholder="Choose an account"
      />
      {accountsError ? (
        <Text style={[styles.note, { color: colors.textMuted }]}>{accountsError}</Text>
      ) : null}

      {accountsLoading ? (
        <LoadingBlock message="Loading chart of accounts…" />
      ) : !accountId ? (
        <Card>
          <Text style={[styles.message, { color: colors.textSecondary }]}>
            Choose an account to see its opening balance, every posting in the range and the
            running balance.
          </Text>
        </Card>
      ) : loading ? (
        <LoadingBlock message="Loading ledger…" />
      ) : error ? (
        <Card>
          <Text style={[styles.message, { color: colors.textSecondary }]}>{error}</Text>
        </Card>
      ) : !ledger ? null : (
        <>
          <Text style={[styles.accountLine, { color: colors.text }]}>
            {ledger.account.code} · {ledger.account.name}
          </Text>
          <Text style={[styles.note, { color: colors.textMuted }]}>
            Balances follow the account's {ledger.account.normalBalance} side.
          </Text>

          {ledger.currencies.length > 1 ? (
            <ChoiceChips
              label="Currency"
              options={ledger.currencies.map((code) => ({ value: code, label: code }))}
              value={ledger.currency}
              onChange={setCurrency}
            />
          ) : null}

          <View style={styles.stats}>
            <Stat label="Opening" value={money(ledger.openingBalance, ledger.currency)} />
            <Stat
              label="Net movement"
              value={money(ledger.closingBalance - ledger.openingBalance, ledger.currency)}
            />
            <Stat label="Closing" value={money(ledger.closingBalance, ledger.currency)} />
          </View>

          <Text style={[styles.note, { color: colors.textMuted }]}>
            {money(ledger.totalDebit, ledger.currency)} debit ·{' '}
            {money(ledger.totalCredit, ledger.currency)} credit in {query.from} to {query.to}
          </Text>

          {ledger.truncated ? (
            <Text style={[styles.warning, { color: colors.warning }]}>
              Showing the first {ledger.lines.length} postings. Narrow the period to see the rest.
            </Text>
          ) : null}

          <SectionHeader title="Postings" style={styles.spacer} />
          {ledger.lines.length === 0 ? (
            <EmptyState
              icon="document"
              title="No postings"
              body="Nothing has touched this account in the selected period."
            />
          ) : (
            <Card padded={false}>
              {ledger.lines.map((line, index) => (
                <View key={line.id}>
                  {index > 0 ? (
                    <View style={[styles.divider, { backgroundColor: colors.borderSubtle }]} />
                  ) : null}
                  <View style={styles.row}>
                    <View style={styles.rowCopy}>
                      <Text style={[styles.rowTitle, { color: colors.text }]} numberOfLines={1}>
                        {line.date} · {line.entryNo}
                      </Text>
                      <Text style={[styles.rowSub, { color: colors.textMuted }]} numberOfLines={2}>
                        {line.entryDescription || line.sourceType.replace(/_/g, ' ')}
                        {line.description ? ` · ${line.description}` : ''}
                      </Text>
                      <Text style={[styles.rowSub, { color: colors.textMuted }]} numberOfLines={1}>
                        {line.debit
                          ? `Dr ${money(line.debit, ledger.currency)}`
                          : `Cr ${money(line.credit, ledger.currency)}`}
                      </Text>
                    </View>
                    <Text style={[styles.rowBalance, { color: colors.text }]}>
                      {money(line.balance, ledger.currency)}
                    </Text>
                  </View>
                </View>
              ))}
            </Card>
          )}

          <Text style={[styles.footnote, { color: colors.textMuted }]}>
            Opening balance runs through the day before the period starts. The same ledger the web
            portal shows.
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

const styles = StyleSheet.create({
  content: { gap: spacing.md },
  filterLabel: { ...typography.label, marginBottom: -spacing.sm },
  note: { ...typography.caption, marginTop: -spacing.sm, lineHeight: 18 },
  warning: { ...typography.caption, lineHeight: 18 },
  message: { ...typography.bodySm, lineHeight: 20 },
  accountLine: { ...typography.bodyMedium, fontFamily: 'DMSans_500Medium' },
  stats: { flexDirection: 'row', gap: spacing.sm },
  stat: { flex: 1, borderWidth: 1, borderRadius: radii.md, padding: spacing.md },
  statValue: { ...typography.bodyMedium, fontFamily: 'IBMPlexMono_500Medium' },
  statLabel: { ...typography.caption, marginTop: 2 },
  spacer: { marginTop: spacing.sm },
  divider: { height: 1, marginHorizontal: spacing.lg },
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, padding: spacing.lg },
  rowCopy: { flex: 1, gap: 2 },
  rowTitle: { ...typography.bodySm, fontFamily: 'DMSans_500Medium' },
  rowSub: { ...typography.caption },
  rowBalance: { ...typography.bodySm, fontFamily: 'IBMPlexMono_400Regular' },
  footnote: { ...typography.caption, marginTop: spacing.md, lineHeight: 18 },
})
