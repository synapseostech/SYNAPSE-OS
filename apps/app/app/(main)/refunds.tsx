import { useCallback, useEffect, useState } from 'react'
import {
  Alert,
  FlatList,
  Modal,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { Button } from '@/components/ui/Button'
import { EmptyState } from '@/components/ui/EmptyState'
import { LoadingBlock } from '@/components/ui/LoadingBlock'
import { TextField } from '@/components/ui/TextField'
import { useAuth } from '@/lib/auth'
import {
  ApiError,
  apiRequest,
  fetchPharmacyRefunds,
  postPharmacyRefund,
} from '@/lib/api'
import { colors, radii, spacing, tabBarHeight, typography } from '@/lib/theme'

type RefundRow = {
  id: string
  receiptNumber: string
  totalAmount: number
  paymentMethod: string | null
  status: string
  reason: string | null
  voidedAt: string | null
  createdAt: string
}

type SaleHit = {
  id: string
  receiptNumber: string
  status: string
  totalAmount: number
  createdAt: string
}

export default function RefundsScreen() {
  const { token } = useAuth()
  const insets = useSafeAreaInsets()
  const [refunds, setRefunds] = useState<RefundRow[]>([])
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [showForm, setShowForm] = useState(false)
  const [receiptQuery, setReceiptQuery] = useState('')
  const [hits, setHits] = useState<SaleHit[]>([])
  const [selected, setSelected] = useState<SaleHit | null>(null)
  const [reason, setReason] = useState('')
  const [saving, setSaving] = useState(false)

  const load = useCallback(async () => {
    if (!token) {
      setLoading(false)
      return
    }
    try {
      const data = await fetchPharmacyRefunds(token)
      setRefunds(data.refunds)
    } catch {
      setRefunds([])
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }, [token])

  useEffect(() => {
    load()
  }, [load])

  const searchSales = async (q: string) => {
    setReceiptQuery(q)
    setSelected(null)
    if (!token || q.trim().length < 2) {
      setHits([])
      return
    }
    try {
      const data = await apiRequest<{ sales: SaleHit[] }>('/api/mobile/pharmacy/sales?limit=40', {
        token,
      })
      const needle = q.trim().toLowerCase()
      setHits(
        data.sales.filter(
          (s) =>
            s.status === 'COMPLETED' &&
            String(s.receiptNumber ?? '').toLowerCase().includes(needle),
        ),
      )
    } catch {
      setHits([])
    }
  }

  const submit = async () => {
    if (!token || !selected) return
    if (!reason.trim()) {
      Alert.alert('Reason required', 'Enter a refund reason.')
      return
    }
    setSaving(true)
    try {
      const result = await postPharmacyRefund(token, {
        saleId: selected.id,
        reason: reason.trim(),
        restoreAs: 'quarantined',
      })
      setShowForm(false)
      setSelected(null)
      setReason('')
      setReceiptQuery('')
      setHits([])
      await load()

      // Tell the cashier what to hand over and what it did to the customer's
      // account, not just that the sale was voided.
      const money = (value: number) => `UGX ${Number(value ?? 0).toLocaleString()}`
      const parts = [`Cash refunded ${money(result.refundAmount)}`]
      if (Number(result.receivableReversal ?? 0) > 0) {
        parts.push(`customer credit reduced by ${money(Number(result.receivableReversal))}`)
      }
      if (result.receivableUnposted) {
        parts.push('an unpaid balance remains that was never posted to the credit ledger')
      } else if (Number(result.receivableUnreversed ?? 0) > 0) {
        parts.push(`${money(Number(result.receivableUnreversed))} of the unpaid balance stays on the account`)
      }
      parts.push('Stock restored as quarantined.')
      Alert.alert('Refunded', parts.join('. '))
    } catch (err) {
      Alert.alert('Refund failed', err instanceof ApiError ? err.message : 'Try again')
    } finally {
      setSaving(false)
    }
  }

  return (
    <View style={styles.container}>
      <View style={styles.toolbar}>
        <Pressable style={styles.toolBtn} onPress={() => setShowForm(true)}>
          <Text style={styles.toolBtnText}>+ New refund</Text>
        </Pressable>
      </View>

      {loading ? (
        <LoadingBlock message="Loading refunds…" />
      ) : (
        <FlatList
          data={refunds}
          keyExtractor={(item) => item.id}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={() => {
                setRefreshing(true)
                load()
              }}
              tintColor={colors.primary}
            />
          }
          contentContainerStyle={[
            styles.list,
            { paddingBottom: insets.bottom + tabBarHeight + spacing.lg },
          ]}
          ListEmptyComponent={
            <EmptyState
              title="No voided sales"
              body="Search a receipt to process a refund. Stock restores as quarantined by default."
              icon="receipt"
            />
          }
          renderItem={({ item }) => (
            <View style={styles.card}>
              <Text style={styles.receipt}>{item.receiptNumber}</Text>
              <Text style={styles.amount}>UGX {Number(item.totalAmount).toLocaleString()}</Text>
              <Text style={styles.meta}>{item.reason ?? 'No reason recorded'}</Text>
              <Text style={styles.meta}>
                {item.voidedAt
                  ? new Date(item.voidedAt).toLocaleString()
                  : new Date(item.createdAt).toLocaleString()}
              </Text>
            </View>
          )}
        />
      )}

      <Modal visible={showForm} animationType="slide" presentationStyle="pageSheet">
        <View style={[styles.modal, { paddingTop: insets.top + spacing.md }]}>
          <View style={styles.modalHeader}>
            <Text style={styles.modalTitle}>Process refund</Text>
            <Pressable onPress={() => setShowForm(false)}>
              <Text style={styles.cancel}>Cancel</Text>
            </Pressable>
          </View>
          <ScrollView contentContainerStyle={styles.form} keyboardShouldPersistTaps="handled">
            <TextField
              label="Search receipt number"
              value={receiptQuery}
              onChangeText={searchSales}
              autoCapitalize="characters"
              placeholder="e.g. RCP-…"
            />
            {hits.map((h) => (
              <Pressable
                key={h.id}
                style={[styles.hit, selected?.id === h.id && styles.hitActive]}
                onPress={() => setSelected(h)}
              >
                <Text style={styles.hitTitle}>{h.receiptNumber}</Text>
                <Text style={styles.meta}>
                  UGX {Number(h.totalAmount).toLocaleString()} ·{' '}
                  {new Date(h.createdAt).toLocaleDateString()}
                </Text>
              </Pressable>
            ))}
            {selected ? (
              <>
                <TextField
                  label="Reason"
                  value={reason}
                  onChangeText={setReason}
                  placeholder="Customer return / wrong item…"
                />
                <Text style={styles.hint}>Stock will restore as quarantined (not sellable).</Text>
                <Button label="Confirm refund" onPress={submit} loading={saving} variant="danger" />
              </>
            ) : null}
          </ScrollView>
        </View>
      </Modal>
    </View>
  )
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  toolbar: { paddingHorizontal: spacing.lg, paddingVertical: spacing.md },
  toolBtn: {
    backgroundColor: colors.primarySoft,
    borderRadius: radii.md,
    paddingVertical: 12,
    paddingHorizontal: spacing.lg,
    alignSelf: 'flex-start',
  },
  toolBtnText: { color: colors.primary, fontFamily: 'DMSans_700Bold', fontSize: 14 },
  list: { paddingHorizontal: spacing.lg },
  card: {
    backgroundColor: colors.bgElevated,
    borderRadius: radii.lg,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.lg,
    marginBottom: spacing.md,
  },
  receipt: { color: colors.text, fontFamily: 'DMSans_700Bold', fontSize: 15 },
  amount: { color: colors.danger, fontFamily: 'DMSans_700Bold', marginTop: 4 },
  meta: { color: colors.textSecondary, fontFamily: 'DMSans_400Regular', marginTop: 4, fontSize: 13 },
  modal: { flex: 1, backgroundColor: colors.bg },
  modalHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: spacing.xl,
    paddingBottom: spacing.md,
  },
  modalTitle: { ...typography.h2, color: colors.text, fontFamily: 'DMSans_700Bold' },
  cancel: { color: colors.primary, fontFamily: 'DMSans_500Medium' },
  form: { padding: spacing.xl },
  hit: {
    padding: spacing.md,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.border,
    marginBottom: spacing.sm,
  },
  hitActive: { borderColor: colors.primary, backgroundColor: colors.primarySoft },
  hitTitle: { color: colors.text, fontFamily: 'DMSans_700Bold' },
  hint: {
    color: colors.textMuted,
    fontFamily: 'DMSans_400Regular',
    marginBottom: spacing.lg,
    fontSize: 13,
  },
})
