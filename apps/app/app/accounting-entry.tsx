import { useCallback, useEffect, useMemo, useState } from 'react'
import { Alert, Pressable, StyleSheet, Text, View } from 'react-native'
import { useRouter } from 'expo-router'
import * as Crypto from 'expo-crypto'
import { ScreenShell } from '@/components/ui/ScreenShell'
import { AccountPicker } from '@/components/ui/AccountPicker'
import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { ChoiceChips } from '@/components/ui/ChoiceChips'
import { LoadingBlock } from '@/components/ui/LoadingBlock'
import { TextField } from '@/components/ui/TextField'
import { useAuth } from '@/lib/auth'
import {
  ApiError,
  fetchAccountingOverview,
  postPharmacyJournal,
  type AccountingAccount,
  type ManualVoucherType,
} from '@/lib/api'
import { spacing, typography, useTheme } from '@/lib/theme'

const VOUCHER_OPTIONS = [
  { value: 'journal', label: 'Journal' },
  { value: 'payment', label: 'Payment' },
  { value: 'receipt', label: 'Receipt' },
  { value: 'contra', label: 'Contra' },
  { value: 'credit_note', label: 'Credit note' },
  { value: 'debit_note', label: 'Debit note' },
] as const satisfies ReadonlyArray<{ value: ManualVoucherType; label: string }>

const VOUCHER_HELP: Record<ManualVoucherType, string> = {
  journal: 'Any balanced adjustment that no other voucher type describes.',
  payment: 'Money leaves a cash or bank account and settles an expense, supplier or other account.',
  receipt: 'Money arrives in a cash or bank account from a customer or another account.',
  contra: 'Money moves between cash and bank accounts only. Nothing is earned or spent.',
  credit_note: 'A customer is credited for a return or an overcharge, reducing what they owe.',
  debit_note: 'A supplier is debited for a return or an overcharge, reducing what we owe.',
}

const SIDES = [
  { value: 'debit', label: 'Debit' },
  { value: 'credit', label: 'Credit' },
] as const

type Side = (typeof SIDES)[number]['value']

type LineDraft = {
  key: string
  accountId: string | null
  side: Side
  amount: string
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

function todayIso(): string {
  const now = new Date()
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
}

function newLine(side: Side): LineDraft {
  return { key: Crypto.randomUUID(), accountId: null, side, amount: '' }
}

function parseAmount(value: string): number | null {
  const trimmed = value.replace(/,/g, '').trim()
  if (!trimmed) return null
  const numeric = Number(trimmed)
  if (!Number.isFinite(numeric) || numeric <= 0) return null
  if (Math.abs(numeric * 100 - Math.round(numeric * 100)) > 0.000001) return null
  return numeric
}

export default function AccountingEntryScreen() {
  const { token } = useAuth()
  const { colors } = useTheme()
  const router = useRouter()

  const [accounts, setAccounts] = useState<AccountingAccount[]>([])
  const [currency, setCurrency] = useState('UGX')
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)

  const [voucherType, setVoucherType] = useState<ManualVoucherType>('journal')
  const [entryDate, setEntryDate] = useState(todayIso)
  const [description, setDescription] = useState('')
  const [lines, setLines] = useState<LineDraft[]>(() => [newLine('debit'), newLine('credit')])

  const [pendingKey, setPendingKey] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    if (!token) {
      setLoading(false)
      return
    }
    setLoading(true)
    setLoadError(null)
    try {
      const today = todayIso()
      const result = await fetchAccountingOverview(token, today, today)
      setAccounts(result.accounts)
      setCurrency(result.currency)
    } catch (err) {
      setLoadError(
        err instanceof ApiError && err.status === 403
          ? 'Your role does not include financial reports.'
          : 'Could not load the chart of accounts.',
      )
    } finally {
      setLoading(false)
    }
  }, [token])

  useEffect(() => {
    void load()
  }, [load])

  const resetKey = () => setPendingKey(null)

  const updateLine = (key: string, patch: Partial<LineDraft>) => {
    setLines((current) =>
      current.map((line) => (line.key === key ? { ...line, ...patch } : line)),
    )
    resetKey()
  }

  const totals = useMemo(() => {
    let debit = 0
    let credit = 0
    for (const line of lines) {
      const amount = parseAmount(line.amount)
      if (amount === null) continue
      if (line.side === 'debit') debit += amount
      else credit += amount
    }
    return { debit, credit, difference: Math.round((debit - credit) * 100) / 100 }
  }, [lines])

  const money = (value: number) => `${currency} ${value.toLocaleString()}`

  const missingFields = useMemo(() => {
    if (!description.trim()) return 'Add a description so the entry explains itself later.'
    if (!DATE_RE.test(entryDate.trim())) return 'Use YYYY-MM-DD for the entry date.'
    if (lines.length < 2) return 'An entry needs at least two lines.'
    for (const [index, line] of lines.entries()) {
      if (!line.accountId) return `Choose an account for line ${index + 1}.`
      if (parseAmount(line.amount) === null) {
        return `Enter a positive amount with at most two decimals on line ${index + 1}.`
      }
    }
    if (Math.abs(totals.difference) > 0.000001) {
      return 'Debits and credits must balance before the entry can be posted.'
    }
    return null
  }, [description, entryDate, lines, totals.difference])

  const submit = async () => {
    setError(null)
    if (!token) return
    if (missingFields) {
      setError(missingFields)
      return
    }

    const key = pendingKey ?? Crypto.randomUUID()
    if (!pendingKey) setPendingKey(key)

    setSubmitting(true)
    try {
      const result = await postPharmacyJournal(token, {
        voucherType,
        entryDate: entryDate.trim(),
        description: description.trim(),
        idempotencyKey: key,
        lines: lines.map((line) => {
          const amount = parseAmount(line.amount) ?? 0
          return {
            accountId: line.accountId as string,
            debit: line.side === 'debit' ? amount : 0,
            credit: line.side === 'credit' ? amount : 0,
          }
        }),
      })
      setPendingKey(null)
      Alert.alert(
        result.entry?.replayed ? 'Already posted' : 'Entry posted',
        result.entry?.entry_no ? `Voucher ${result.entry.entry_no}` : 'The ledger has been updated.',
        [{ text: 'Done', onPress: () => router.back() }],
      )
    } catch (err) {
      if (err instanceof ApiError) {
        setError(err.message)
      } else {
        setError(err instanceof Error ? err.message : 'Could not post the entry.')
      }
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <ScreenShell title="New journal entry" contentStyle={styles.content}>
      {loading ? (
        <LoadingBlock message="Loading chart of accounts…" />
      ) : loadError ? (
        <Card>
          <Text style={[styles.message, { color: colors.textSecondary }]}>{loadError}</Text>
        </Card>
      ) : accounts.length === 0 ? (
        <Card>
          <Text style={[styles.message, { color: colors.textSecondary }]}>
            This pharmacy has no accounting accounts yet. Open Accounting once in the web portal to
            seed the default chart, then try again.
          </Text>
        </Card>
      ) : (
        <>
          <ChoiceChips
            label="Voucher type"
            options={VOUCHER_OPTIONS}
            value={voucherType}
            onChange={(value) => {
              setVoucherType(value)
              resetKey()
            }}
          />
          <Text style={[styles.help, { color: colors.textMuted }]}>{VOUCHER_HELP[voucherType]}</Text>

          <TextField
            label="Entry date"
            value={entryDate}
            onChangeText={(value) => {
              setEntryDate(value)
              resetKey()
            }}
            placeholder="YYYY-MM-DD"
            autoCapitalize="none"
            keyboardType="numbers-and-punctuation"
          />

          <TextField
            label="Description"
            value={description}
            onChangeText={(value) => {
              setDescription(value)
              resetKey()
            }}
            placeholder="What this voucher records"
            maxLength={500}
          />

          {lines.map((line, index) => {
            return (
              <Card key={line.key} style={styles.lineCard}>
                <View style={styles.lineHeader}>
                  <Text style={[styles.lineTitle, { color: colors.textSecondary }]}>
                    Line {index + 1}
                  </Text>
                  {lines.length > 2 ? (
                    <Pressable
                      onPress={() => {
                        setLines((current) => current.filter((item) => item.key !== line.key))
                        resetKey()
                      }}
                      hitSlop={8}
                      accessibilityRole="button"
                      accessibilityLabel={`Remove line ${index + 1}`}
                    >
                      <Text style={[styles.remove, { color: colors.error }]}>Remove</Text>
                    </Pressable>
                  ) : null}
                </View>

                <View style={styles.accountField}>
                  <AccountPicker
                    accounts={accounts}
                    value={line.accountId}
                    onChange={(accountId) => updateLine(line.key, { accountId })}
                  />
                </View>

                <ChoiceChips
                  label="Side"
                  options={SIDES}
                  value={line.side}
                  onChange={(value) => updateLine(line.key, { side: value })}
                />

                <TextField
                  label="Amount"
                  value={line.amount}
                  onChangeText={(value) => updateLine(line.key, { amount: value })}
                  placeholder="0"
                  keyboardType="decimal-pad"
                  hint={currency}
                />
              </Card>
            )
          })}

          <Button
            label="Add line"
            variant="ghost"
            onPress={() => {
              setLines((current) => [...current, newLine('debit')])
              resetKey()
            }}
          />

          <Card>
            <View style={styles.totalRow}>
              <Text style={[styles.totalLabel, { color: colors.textSecondary }]}>Total debit</Text>
              <Text style={[styles.totalValue, { color: colors.text }]}>{money(totals.debit)}</Text>
            </View>
            <View style={styles.totalRow}>
              <Text style={[styles.totalLabel, { color: colors.textSecondary }]}>Total credit</Text>
              <Text style={[styles.totalValue, { color: colors.text }]}>{money(totals.credit)}</Text>
            </View>
            <View style={[styles.divider, { backgroundColor: colors.borderSubtle }]} />
            <View style={styles.totalRow}>
              <Text style={[styles.totalLabel, { color: colors.textSecondary }]}>Difference</Text>
              <Text
                style={[
                  styles.totalValue,
                  { color: totals.difference === 0 ? colors.success : colors.error },
                ]}
              >
                {money(totals.difference)}
              </Text>
            </View>
          </Card>

          {error ? <Text style={[styles.error, { color: colors.error }]}>{error}</Text> : null}

          <Button
            label="Post entry"
            onPress={submit}
            loading={submitting}
            disabled={Boolean(missingFields) || submitting}
          />

          <Text style={[styles.footnote, { color: colors.textMuted }]}>
            Posts to the same ledger as the web portal. Entries dated inside a closed period are
            refused rather than moved.
          </Text>
        </>
      )}
    </ScreenShell>
  )
}

const styles = StyleSheet.create({
  content: { gap: spacing.sm },
  help: { ...typography.caption, lineHeight: 18, marginTop: -spacing.sm, marginBottom: spacing.md },
  lineCard: { marginBottom: spacing.sm },
  lineHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: spacing.sm,
  },
  lineTitle: { ...typography.label, textTransform: 'uppercase' },
  remove: { ...typography.caption, fontFamily: 'DMSans_500Medium' },
  accountField: { marginBottom: spacing.md },
  totalRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: spacing.xs,
  },
  totalLabel: { ...typography.bodySm },
  totalValue: { ...typography.bodySm, fontFamily: 'IBMPlexMono_400Regular' },
  divider: { height: 1, marginVertical: spacing.sm },
  message: { ...typography.bodySm, lineHeight: 20 },
  error: { ...typography.caption, textAlign: 'center', marginVertical: spacing.sm },
  footnote: { ...typography.caption, marginTop: spacing.md, lineHeight: 18 },
})
