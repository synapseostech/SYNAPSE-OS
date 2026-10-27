import { useCallback, useEffect, useMemo, useState } from 'react'
import { Alert, Pressable, StyleSheet, Text, View } from 'react-native'
import { useRouter } from 'expo-router'
import * as Crypto from 'expo-crypto'
import { ScreenShell } from '@/components/ui/ScreenShell'
import { Button } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { ChoiceChips } from '@/components/ui/ChoiceChips'
import { LoadingBlock } from '@/components/ui/LoadingBlock'
import { TextField } from '@/components/ui/TextField'
import { useAuth } from '@/lib/auth'
import { ApiError, apiRequest } from '@/lib/api'
import { radii, spacing, typography, useTheme } from '@/lib/theme'

type EntryType = 'credit' | 'repayment'
type PaymentMethod = 'cash' | 'mobile_money' | 'card' | 'bank_transfer'

interface Customer {
  id: string
  name: string
  email: string | null
  phone: string | null
}

interface LedgerEntry {
  customerId: string | null
  balanceAfter: number
}

const TYPES = [
  { value: 'credit', label: 'Credit sale' },
  { value: 'repayment', label: 'Repayment' },
] as const

const METHODS = [
  { value: 'cash', label: 'Cash' },
  { value: 'mobile_money', label: 'Mobile money' },
  { value: 'card', label: 'Card' },
  { value: 'bank_transfer', label: 'Bank' },
] as const

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

export default function CreditEntryScreen() {
  const { token } = useAuth()
  const { colors } = useTheme()
  const router = useRouter()

  const [customers, setCustomers] = useState<Customer[]>([])
  const [balances, setBalances] = useState<Record<string, number>>({})
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)

  const [type, setType] = useState<EntryType>('credit')
  const [query, setQuery] = useState('')
  const [customerId, setCustomerId] = useState<string | null>(null)
  const [amount, setAmount] = useState('')
  const [method, setMethod] = useState<PaymentMethod>('cash')
  const [dueDate, setDueDate] = useState('')
  const [notes, setNotes] = useState('')

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
    const [customerResult, ledgerResult] = await Promise.allSettled([
      apiRequest<{ customers: Customer[] }>('/api/mobile/pharmacy/customers', { token }),
      apiRequest<{ entries: LedgerEntry[] }>('/api/mobile/pharmacy/credit-ledger', { token }),
    ])

    if (customerResult.status === 'fulfilled') {
      setCustomers(customerResult.value.customers)
    } else {
      const err = customerResult.reason
      setLoadError(
        err instanceof ApiError && err.status === 403
          ? 'Your role does not include the customer credit permission.'
          : 'Could not load customers.',
      )
    }

    if (ledgerResult.status === 'fulfilled') {
      const latest: Record<string, number> = {}
      for (const entry of ledgerResult.value.entries) {
        if (entry.customerId && !(entry.customerId in latest)) {
          latest[entry.customerId] = entry.balanceAfter
        }
      }
      setBalances(latest)
    } else {
      setBalances({})
    }

    setLoading(false)
  }, [token])

  useEffect(() => {
    void load()
  }, [load])

  const matches = useMemo(() => {
    const needle = query.trim().toLowerCase()
    return customers
      .filter((customer) => (type === 'repayment' ? (balances[customer.id] ?? 0) > 0 : true))
      .filter((customer) => {
        if (!needle) return true
        return [customer.name, customer.phone, customer.email]
          .filter(Boolean)
          .some((value) => String(value).toLowerCase().includes(needle))
      })
      .slice(0, 8)
  }, [customers, balances, query, type])

  const selected = customers.find((customer) => customer.id === customerId) ?? null

  const resetKey = () => setPendingKey(null)

  const submit = async () => {
    setError(null)
    if (!token) return
    if (!customerId) {
      setError('Choose the customer this entry belongs to.')
      return
    }
    const numeric = Number(amount.replace(/,/g, ''))
    if (!amount.trim() || !Number.isFinite(numeric) || numeric <= 0) {
      setError('Enter an amount greater than zero.')
      return
    }
    if (Math.abs(numeric * 100 - Math.round(numeric * 100)) > 0.000001) {
      setError('Amounts can have at most two decimals.')
      return
    }
    if (dueDate.trim() && !DATE_RE.test(dueDate.trim())) {
      setError('Use YYYY-MM-DD for the due date.')
      return
    }

    // Keep one key per attempt so a lost response replays instead of double-posting.
    const key = type === 'repayment' ? pendingKey ?? Crypto.randomUUID() : null
    if (key) setPendingKey(key)

    setSubmitting(true)
    try {
      const result = await apiRequest<{ balanceAfter: number; replayed: boolean }>(
        '/api/mobile/pharmacy/credit-ledger',
        {
          method: 'POST',
          token,
          body: {
            customerId,
            type,
            amount: numeric,
            paymentMethod: method,
            dueDate: dueDate.trim() || null,
            notes: notes.trim() || null,
            ...(key ? { idempotencyKey: key } : {}),
          },
        },
      )
      setPendingKey(null)
      Alert.alert(
        result.replayed ? 'Already recorded' : 'Entry recorded',
        `New balance: UGX ${Number(result.balanceAfter ?? 0).toLocaleString()}`,
        [{ text: 'Done', onPress: () => router.back() }],
      )
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.payload.code === 'OVERPAYMENT' && typeof err.payload.balance === 'number') {
          setError(
            `Repayment is more than the outstanding balance (UGX ${err.payload.balance.toLocaleString()}).`,
          )
        } else {
          setError(err.message)
        }
      } else {
        setError(err instanceof Error ? err.message : 'Could not record the entry.')
      }
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <ScreenShell title="Credit entry" contentStyle={styles.content}>
      {loading ? (
        <LoadingBlock message="Loading customers…" />
      ) : loadError ? (
        <Card>
          <Text style={[styles.message, { color: colors.textSecondary }]}>{loadError}</Text>
        </Card>
      ) : (
        <>
          <ChoiceChips
            label="Entry type"
            options={TYPES}
            value={type}
            onChange={(value) => {
              setType(value)
              setCustomerId(null)
              resetKey()
            }}
          />

          <TextField
            label="Find customer"
            value={query}
            onChangeText={setQuery}
            placeholder="Name or phone"
            autoCapitalize="none"
          />

          {type === 'repayment' && matches.length === 0 ? (
            <Text style={[styles.message, { color: colors.textMuted }]}>
              No customer has an outstanding balance to repay.
            </Text>
          ) : (
            <View style={styles.picker}>
              {matches.map((customer) => {
                const active = customer.id === customerId
                const balance = balances[customer.id] ?? 0
                return (
                  <Pressable
                    key={customer.id}
                    onPress={() => {
                      setCustomerId(customer.id)
                      resetKey()
                    }}
                    accessibilityRole="button"
                    accessibilityState={{ selected: active }}
                    style={[
                      styles.option,
                      {
                        borderColor: active ? colors.primary : colors.border,
                        backgroundColor: active ? colors.primarySoft : colors.bgElevated,
                      },
                    ]}
                  >
                    <Text
                      style={[styles.optionName, { color: active ? colors.primary : colors.text }]}
                      numberOfLines={1}
                    >
                      {customer.name}
                    </Text>
                    <Text style={[styles.optionMeta, { color: colors.textMuted }]} numberOfLines={1}>
                      {customer.phone ?? customer.email ?? 'No contact'}
                      {balance > 0 ? ` · owes UGX ${balance.toLocaleString()}` : ''}
                    </Text>
                  </Pressable>
                )
              })}
            </View>
          )}

          {selected ? (
            <Text style={[styles.selected, { color: colors.textSecondary }]}>
              Recording against {selected.name}
            </Text>
          ) : null}

          <TextField
            label={`Amount${type === 'repayment' ? '' : ' on credit'}`}
            value={amount}
            onChangeText={(value) => {
              setAmount(value)
              resetKey()
            }}
            placeholder="0"
            keyboardType="decimal-pad"
          />

          <ChoiceChips
            label="Payment method"
            options={METHODS}
            value={method}
            onChange={(value) => {
              setMethod(value)
              resetKey()
            }}
          />

          <TextField
            label={type === 'credit' ? 'Due date (optional)' : 'Payment date (optional)'}
            value={dueDate}
            onChangeText={(value) => {
              setDueDate(value)
              resetKey()
            }}
            placeholder="YYYY-MM-DD"
            autoCapitalize="none"
            keyboardType="numbers-and-punctuation"
          />

          <TextField
            label="Note (optional)"
            value={notes}
            onChangeText={setNotes}
            placeholder="What this covers"
            maxLength={500}
          />

          {error ? <Text style={[styles.error, { color: colors.error }]}>{error}</Text> : null}

          <Button label="Record entry" onPress={submit} loading={submitting} />

          <Text style={[styles.footnote, { color: colors.textMuted }]}>
            Entries post to the same ledger as the web portal and adjust the customer balance
            atomically.
          </Text>
        </>
      )}
    </ScreenShell>
  )
}

const styles = StyleSheet.create({
  content: { gap: spacing.sm },
  picker: { gap: spacing.sm, marginBottom: spacing.md },
  option: { borderWidth: 1, borderRadius: radii.md, paddingHorizontal: spacing.lg, paddingVertical: spacing.md },
  optionName: { ...typography.bodyMedium, fontFamily: 'DMSans_500Medium' },
  optionMeta: { ...typography.caption, marginTop: 2 },
  selected: { ...typography.caption, marginBottom: spacing.md },
  message: { ...typography.bodySm },
  error: { ...typography.caption, textAlign: 'center', marginBottom: spacing.md },
  footnote: { ...typography.caption, marginTop: spacing.md, lineHeight: 18 },
})
