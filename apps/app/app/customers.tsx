import { useCallback, useEffect, useMemo, useState } from 'react'
import { StyleSheet, Text, View } from 'react-native'
import { ScreenShell } from '@/components/ui/ScreenShell'
import { Button } from '@/components/ui/Button'
import { Card, SectionHeader } from '@/components/ui/Card'
import { EmptyState } from '@/components/ui/EmptyState'
import { LoadingBlock } from '@/components/ui/LoadingBlock'
import { TextField } from '@/components/ui/TextField'
import { useAuth } from '@/lib/auth'
import { ApiError, apiRequest } from '@/lib/api'
import { spacing, typography, useTheme } from '@/lib/theme'

interface Customer {
  id: string
  name: string
  email: string | null
  phone: string | null
  address: string | null
  isActive: boolean
  counts: { orders: number; transactions: number }
}

function displayEmail(email: string | null): string | null {
  if (!email) return null
  if (email.startsWith('credit+') && email.endsWith('@synapse.local')) return null
  return email
}

export default function CustomersScreen() {
  const { token } = useAuth()
  const { colors } = useTheme()
  const [customers, setCustomers] = useState<Customer[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [query, setQuery] = useState('')

  const [adding, setAdding] = useState(false)
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [phone, setPhone] = useState('')
  const [address, setAddress] = useState('')
  const [saving, setSaving] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)

  const load = useCallback(async () => {
    if (!token) {
      setLoading(false)
      return
    }
    setLoading(true)
    setLoadError(null)
    try {
      const result = await apiRequest<{ customers: Customer[] }>('/api/mobile/pharmacy/customers', {
        token,
      })
      setCustomers(result.customers)
    } catch (err) {
      setCustomers([])
      setLoadError(
        err instanceof ApiError && err.status === 403
          ? 'Your role does not include customer records.'
          : 'Could not load customers.',
      )
    } finally {
      setLoading(false)
    }
  }, [token])

  useEffect(() => {
    void load()
  }, [load])

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase()
    if (!needle) return customers
    return customers.filter((customer) =>
      [customer.name, customer.phone, customer.email, customer.address]
        .filter(Boolean)
        .some((value) => String(value).toLowerCase().includes(needle)),
    )
  }, [customers, query])

  const closeForm = () => {
    setAdding(false)
    setName('')
    setEmail('')
    setPhone('')
    setAddress('')
    setFormError(null)
  }

  const save = async () => {
    setFormError(null)
    if (!token) return
    if (!name.trim()) {
      setFormError('Enter the customer name.')
      return
    }
    if (!email.trim() && !phone.trim()) {
      setFormError('Add an email or a phone number.')
      return
    }
    setSaving(true)
    try {
      const created = await apiRequest<Customer>('/api/mobile/pharmacy/customers', {
        method: 'POST',
        token,
        body: {
          name: name.trim(),
          email: email.trim() || null,
          phone: phone.trim() || null,
          address: address.trim() || null,
        },
      })
      setCustomers((current) => [created, ...current])
      closeForm()
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'Could not save the customer.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <ScreenShell
      title="Customers"
      contentStyle={styles.content}
      footer={
        <Button
          label={adding ? 'Cancel' : 'Add customer'}
          onPress={() => (adding ? closeForm() : setAdding(true))}
          variant={adding ? 'ghost' : 'primary'}
        />
      }
    >
      {adding ? (
        <>
          <SectionHeader title="New customer" />
          <Card style={styles.formCard}>
            <TextField label="Name" value={name} onChangeText={setName} placeholder="Full name" />
            <TextField
              label="Phone"
              value={phone}
              onChangeText={setPhone}
              placeholder="07…"
              keyboardType="phone-pad"
            />
            <TextField
              label="Email"
              value={email}
              onChangeText={setEmail}
              placeholder="name@example.com"
              autoCapitalize="none"
              keyboardType="email-address"
            />
            <TextField
              label="Address (optional)"
              value={address}
              onChangeText={setAddress}
              placeholder="Village, town"
            />
            {formError ? (
              <Text style={[styles.error, { color: colors.error }]}>{formError}</Text>
            ) : null}
            <Button label="Save customer" onPress={save} loading={saving} />
          </Card>
          <Text style={[styles.hint, { color: colors.textMuted }]}>
            A Synapse identity is created with the customer so their history follows them between
            facilities.
          </Text>
        </>
      ) : loading ? (
        <LoadingBlock message="Loading customers…" />
      ) : loadError ? (
        <Card>
          <Text style={[styles.message, { color: colors.textSecondary }]}>{loadError}</Text>
        </Card>
      ) : customers.length === 0 ? (
        <EmptyState
          icon="people"
          title="No customers yet"
          body="Add the people and businesses who buy from you, then record credit against them."
        />
      ) : (
        <>
          <TextField
            label="Search"
            value={query}
            onChangeText={setQuery}
            placeholder="Name, phone or email"
            autoCapitalize="none"
          />
          <Text style={[styles.count, { color: colors.textMuted }]}>
            {filtered.length} of {customers.length}
          </Text>
          <View style={styles.list}>
            {filtered.map((customer) => {
              const mail = displayEmail(customer.email)
              return (
                <Card key={customer.id}>
                  <View style={styles.rowTop}>
                    <Text style={[styles.name, { color: colors.text }]} numberOfLines={1}>
                      {customer.name}
                    </Text>
                    {!customer.isActive ? (
                      <Text style={[styles.inactive, { color: colors.warning }]}>Inactive</Text>
                    ) : null}
                  </View>
                  <Text style={[styles.meta, { color: colors.textMuted }]} numberOfLines={1}>
                    {[customer.phone, mail].filter(Boolean).join(' · ') || 'No contact details'}
                  </Text>
                  {customer.address ? (
                    <Text style={[styles.meta, { color: colors.textMuted }]} numberOfLines={1}>
                      {customer.address}
                    </Text>
                  ) : null}
                  <Text style={[styles.counts, { color: colors.textSecondary }]}>
                    {customer.counts.orders} orders · {customer.counts.transactions} transactions
                  </Text>
                </Card>
              )
            })}
          </View>
        </>
      )}
    </ScreenShell>
  )
}

const styles = StyleSheet.create({
  content: { gap: spacing.md },
  formCard: { gap: spacing.xs },
  list: { gap: spacing.sm },
  rowTop: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: spacing.sm },
  name: { ...typography.bodyMedium, fontFamily: 'DMSans_500Medium', flex: 1 },
  inactive: { ...typography.caption, fontFamily: 'DMSans_700Bold' },
  meta: { ...typography.caption, marginTop: 2 },
  counts: { ...typography.caption, fontFamily: 'IBMPlexMono_400Regular', marginTop: spacing.xs },
  count: { ...typography.caption },
  hint: { ...typography.caption, lineHeight: 18 },
  error: { ...typography.caption, textAlign: 'center', marginBottom: spacing.md },
  message: { ...typography.bodySm },
})
