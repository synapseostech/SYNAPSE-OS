import { useCallback, useEffect, useState } from 'react'
import {
  Alert,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import { useRouter } from 'expo-router'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { Button } from '@/components/ui/Button'
import { EmptyState } from '@/components/ui/EmptyState'
import { LoadingBlock } from '@/components/ui/LoadingBlock'
import { useAuth } from '@/lib/auth'
import { apiRequest, ApiError } from '@/lib/api'
import { radii, spacing, typography, makeStyles, useTheme } from '@/lib/theme'

type Store = { id: string; name: string; store_type?: string | null }
type TransferItem = { id?: string; product_id: string; quantity: number }
type Transfer = {
  id: string
  status: string
  from_store_id: string
  to_store_id: string
  notes?: string | null
  created_at: string
  pharmacy_stock_transfer_items?: TransferItem[]
}

function statusLabel(status: string): string {
  switch (status) {
    case 'draft':
      return 'Draft — not shipped'
    case 'in_transit':
      return 'In transit — awaiting receive'
    case 'received':
      return 'Received'
    case 'cancelled':
      return 'Cancelled'
    default:
      return status.replace(/_/g, ' ')
  }
}

export default function TransfersScreen() {
  const styles = useStyles()
  const { colors } = useTheme()
  const { token } = useAuth()
  const router = useRouter()
  const insets = useSafeAreaInsets()
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [transfers, setTransfers] = useState<Transfer[]>([])
  const [stores, setStores] = useState<Store[]>([])
  const [fromStoreId, setFromStoreId] = useState('')
  const [toStoreId, setToStoreId] = useState('')
  const [productId, setProductId] = useState('')
  const [quantity, setQuantity] = useState('1')
  const [busyId, setBusyId] = useState<string | null>(null)

  const load = useCallback(async () => {
    if (!token) {
      setLoading(false)
      return
    }
    try {
      const [list, storeList] = await Promise.all([
        apiRequest<{ transfers: Transfer[] }>('/api/mobile/pharmacy/transfers', { token }),
        apiRequest<{ stores: Store[] }>('/api/mobile/pharmacy/stores', { token }),
      ])
      setTransfers(list.transfers ?? [])
      const nextStores = storeList.stores ?? []
      setStores(nextStores)
      setFromStoreId((current) => current || nextStores[0]?.id || '')
      setToStoreId((current) => current || nextStores[1]?.id || '')
    } catch {
      setTransfers([])
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }, [token])

  useEffect(() => {
    void load()
  }, [load])

  const storeName = (id: string) => stores.find((store) => store.id === id)?.name ?? id.slice(0, 8)

  const createDraft = async () => {
    if (!token) return
    const qty = Number(quantity)
    if (!fromStoreId || !toStoreId || fromStoreId === toStoreId) {
      Alert.alert('Stores required', 'Pick two different branches.')
      return
    }
    if (!productId.trim() || !(qty > 0)) {
      Alert.alert('Item required', 'Enter a product id and quantity greater than zero.')
      return
    }
    setBusyId('create')
    try {
      await apiRequest('/api/mobile/pharmacy/transfers', {
        method: 'POST',
        token,
        body: {
          fromStoreId,
          toStoreId,
          items: [{ productId: productId.trim(), quantity: qty }],
        },
      })
      setProductId('')
      await load()
    } catch (error) {
      Alert.alert('Could not create transfer', error instanceof ApiError ? error.message : 'Try again')
    } finally {
      setBusyId(null)
    }
  }

  const act = async (id: string, action: 'ship' | 'receive') => {
    if (!token) return
    setBusyId(id)
    try {
      await apiRequest(`/api/mobile/pharmacy/transfers/${id}/${action}`, { method: 'POST', token })
      await load()
    } catch (error) {
      Alert.alert(
        action === 'ship' ? 'Could not ship' : 'Could not receive',
        error instanceof ApiError ? error.message : 'Try again',
      )
    } finally {
      setBusyId(null)
    }
  }

  return (
    <View style={[styles.root, { paddingTop: insets.top }]}>
      <View style={styles.header}>
        <Pressable
          onPress={() => router.back()}
          hitSlop={12}
          accessibilityRole="button"
          accessibilityLabel="Go back"
        >
          <Ionicons name="chevron-back" size={22} color={colors.primary} />
        </Pressable>
        <Text style={styles.title} accessibilityRole="header">
          Stock transfers
        </Text>
        <View style={{ width: 22 }} />
      </View>

      {loading ? (
        <LoadingBlock message="Loading transfers…" />
      ) : (
        <ScrollView
          contentContainerStyle={{ paddingBottom: insets.bottom + spacing.xl }}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={() => {
                setRefreshing(true)
                void load()
              }}
              tintColor={colors.primary}
            />
          }
        >
          {stores.length < 2 ? (
            <EmptyState
              title="Need two branches"
              body="Create another store on the pharmacy portal before transferring stock."
              icon="business"
            />
          ) : (
            <View style={styles.composer}>
              <Text style={styles.section}>New draft</Text>
              <Text style={styles.hint}>From</Text>
              <ScrollView horizontal style={styles.chips}>
                {stores.map((store) => (
                  <Pressable
                    key={store.id}
                    onPress={() => setFromStoreId(store.id)}
                    style={[styles.chip, fromStoreId === store.id && styles.chipOn]}
                    accessibilityRole="radio"
                    accessibilityState={{ selected: fromStoreId === store.id }}
                    accessibilityLabel={`Source store ${store.name}`}
                  >
                    <Text style={[styles.chipText, fromStoreId === store.id && styles.chipTextOn]}>
                      {store.name}
                    </Text>
                  </Pressable>
                ))}
              </ScrollView>
              <Text style={styles.hint}>To</Text>
              <ScrollView horizontal style={styles.chips}>
                {stores.map((store) => (
                  <Pressable
                    key={store.id}
                    onPress={() => setToStoreId(store.id)}
                    style={[styles.chip, toStoreId === store.id && styles.chipOn]}
                    accessibilityRole="radio"
                    accessibilityState={{ selected: toStoreId === store.id }}
                    accessibilityLabel={`Destination store ${store.name}`}
                  >
                    <Text style={[styles.chipText, toStoreId === store.id && styles.chipTextOn]}>
                      {store.name}
                    </Text>
                  </Pressable>
                ))}
              </ScrollView>
              <TextInput
                style={styles.input}
                placeholder="Product id"
                placeholderTextColor={colors.textMuted}
                value={productId}
                onChangeText={setProductId}
                autoCapitalize="none"
                accessibilityLabel="Product id"
              />
              <TextInput
                style={styles.input}
                placeholder="Quantity"
                placeholderTextColor={colors.textMuted}
                value={quantity}
                onChangeText={setQuantity}
                keyboardType="number-pad"
                accessibilityLabel="Transfer quantity"
              />
              <Button
                label="Create draft transfer"
                onPress={() => void createDraft()}
                loading={busyId === 'create'}
              />
            </View>
          )}

          <Text style={[styles.section, { marginHorizontal: spacing.lg }]}>Existing</Text>
          {transfers.length === 0 ? (
            <EmptyState title="No transfers" body="Draft a transfer when two branches need stock." icon="cube" />
          ) : (
            transfers.map((transfer) => (
              <View
                key={transfer.id}
                style={styles.card}
                accessibilityRole="text"
                accessibilityLabel={`${statusLabel(transfer.status)}. From ${storeName(transfer.from_store_id)} to ${storeName(transfer.to_store_id)}.`}
              >
                <Text style={styles.cardTitle}>{statusLabel(transfer.status)}</Text>
                <Text style={styles.cardMeta}>
                  {storeName(transfer.from_store_id)} → {storeName(transfer.to_store_id)}
                </Text>
                <Text style={styles.cardMeta}>
                  {(transfer.pharmacy_stock_transfer_items ?? []).length} line(s)
                </Text>
                {transfer.status === 'draft' ? (
                  <Button
                    label="Ship (FEFO at source)"
                    onPress={() => void act(transfer.id, 'ship')}
                    loading={busyId === transfer.id}
                  />
                ) : null}
                {transfer.status === 'in_transit' ? (
                  <Button
                    label="Receive at destination"
                    onPress={() => void act(transfer.id, 'receive')}
                    loading={busyId === transfer.id}
                  />
                ) : null}
              </View>
            ))
          )}
        </ScrollView>
      )}
    </View>
  )
}

const useStyles = makeStyles((colors) => ({
  root: { flex: 1, backgroundColor: colors.bg },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
  },
  title: { ...typography.h2, color: colors.text, fontFamily: 'DMSans_700Bold' },
  section: {
    ...typography.bodyMedium,
    color: colors.primary,
    fontFamily: 'DMSans_700Bold',
    marginBottom: spacing.sm,
  },
  composer: {
    marginHorizontal: spacing.lg,
    marginBottom: spacing.lg,
    gap: spacing.sm,
  },
  hint: { color: colors.textMuted, fontFamily: 'DMSans_500Medium', fontSize: 12 },
  chips: { flexGrow: 0, marginBottom: spacing.sm },
  chip: {
    marginRight: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.border,
  },
  chipOn: { borderColor: colors.primary, backgroundColor: colors.primarySoft },
  chipText: { color: colors.textSecondary, fontFamily: 'DMSans_500Medium' },
  chipTextOn: { color: colors.primary },
  input: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    color: colors.text,
    backgroundColor: colors.bgElevated,
  },
  card: {
    marginHorizontal: spacing.lg,
    marginBottom: spacing.sm,
    padding: spacing.md,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    gap: spacing.sm,
  },
  cardTitle: { color: colors.text, fontFamily: 'DMSans_700Bold', fontSize: 15 },
  cardMeta: { color: colors.textSecondary, fontFamily: 'DMSans_400Regular', fontSize: 13 },
}))
