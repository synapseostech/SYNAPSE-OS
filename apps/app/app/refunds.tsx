import { useCallback, useEffect, useState } from 'react'
import { FlatList, Pressable, StyleSheet, Text, View } from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import { useRouter } from 'expo-router'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { LoadingBlock } from '@/components/ui/LoadingBlock'
import { EmptyState } from '@/components/ui/EmptyState'
import { useAuth } from '@/lib/auth'
import { apiRequest } from '@/lib/api'
import { radii, spacing, typography, makeStyles, useTheme } from '@/lib/theme'

interface Refund {
  id: string
  receiptNumber: string
  amount: number
  paymentMethod: string | null
  reason: string | null
  voidedAt: string | null
}

export default function RefundsScreen() {
  const styles = useStyles()
  const { colors } = useTheme()
  const { token } = useAuth()
  const router = useRouter()
  const insets = useSafeAreaInsets()
  const [refunds, setRefunds] = useState<Refund[]>([])
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    if (!token) return setLoading(false)
    try {
      const data = await apiRequest<{ refunds: Refund[] }>('/api/mobile/pharmacy/refunds', { token })
      setRefunds(data.refunds)
    } catch {
      setRefunds([])
    } finally {
      setLoading(false)
    }
  }, [token])

  useEffect(() => {
    load()
  }, [load])

  return (
    <View style={[styles.root, { paddingTop: insets.top }]}>
      <View style={styles.header}>
        <Pressable onPress={() => router.back()} hitSlop={12} style={styles.backBtn}>
          <Ionicons name="chevron-back" size={22} color={colors.primary} />
        </Pressable>
        <Text style={styles.title}>Refunds</Text>
        <View style={{ width: 48 }} />
      </View>

      {loading ? (
        <LoadingBlock message="Loading refunds…" />
      ) : (
        <FlatList
          data={refunds}
          keyExtractor={(r) => r.id}
          contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + spacing.xxl }]}
          ListHeaderComponent={<Text style={styles.help}>To refund a sale, open it from Sales history and tap Refund. Processed refunds appear here.</Text>}
          ListEmptyComponent={<EmptyState title="No refunds" body="Voided / refunded sales will show here." icon="refresh" />}
          renderItem={({ item }) => (
            <Pressable style={styles.card} onPress={() => router.push(`/receipt/${item.id}` as never)}>
              <View style={styles.rowTop}>
                <Text style={styles.receipt}>{item.receiptNumber}</Text>
                <Text style={styles.amount}>UGX {item.amount.toLocaleString()}</Text>
              </View>
              <Text style={styles.meta}>{item.reason ?? 'Refund'}{item.voidedAt ? ` · ${new Date(item.voidedAt).toLocaleDateString()}` : ''}</Text>
            </Pressable>
          )}
        />
      )}
    </View>
  )
}

const useStyles = makeStyles((colors) => ({
  root: { flex: 1, backgroundColor: colors.bg },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: spacing.lg, paddingVertical: spacing.md },
  backBtn: { width: 48 },
  title: { ...typography.h3, color: colors.text, fontFamily: 'DMSans_700Bold' },
  content: { padding: spacing.lg, gap: spacing.sm },
  help: { ...typography.bodySm, color: colors.textSecondary, marginBottom: spacing.sm },
  card: { backgroundColor: colors.surface, borderRadius: radii.lg, borderWidth: 1, borderColor: colors.border, padding: spacing.lg },
  rowTop: { flexDirection: 'row', justifyContent: 'space-between' },
  receipt: { ...typography.bodyMedium, color: colors.text, fontFamily: 'DMSans_700Bold' },
  amount: { ...typography.bodySm, color: colors.textSecondary, fontFamily: 'IBMPlexMono_400Regular' },
  meta: { ...typography.caption, color: colors.textMuted, marginTop: 4 },
}))
