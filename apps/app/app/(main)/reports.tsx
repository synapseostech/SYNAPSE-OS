import { useCallback, useState } from 'react'
import {
  Alert,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import * as FileSystem from 'expo-file-system/legacy'
import * as Sharing from 'expo-sharing'
import { Button } from '@/components/ui/Button'
import { LoadingBlock } from '@/components/ui/LoadingBlock'
import { TextField } from '@/components/ui/TextField'
import { useAuth } from '@/lib/auth'
import { ApiError, fetchPharmacyReport } from '@/lib/api'
import { colors, radii, spacing, tabBarHeight, typography } from '@/lib/theme'

const REPORT_TYPES = [
  { key: 'sales', label: 'Sales' },
  { key: 'inventory', label: 'Inventory' },
  { key: 'low-stock', label: 'Low stock' },
  { key: 'expiry', label: 'Expiry' },
  { key: 'refunds', label: 'Refunds' },
] as const

type ReportType = (typeof REPORT_TYPES)[number]['key']

function todayIsoDate() {
  return new Date().toISOString().slice(0, 10)
}

function monthAgoIsoDate() {
  const d = new Date()
  d.setMonth(d.getMonth() - 1)
  return d.toISOString().slice(0, 10)
}

export default function ReportsScreen() {
  const { token } = useAuth()
  const insets = useSafeAreaInsets()
  const [type, setType] = useState<ReportType>('sales')
  const [from, setFrom] = useState(monthAgoIsoDate())
  const [to, setTo] = useState(todayIsoDate())
  const [loading, setLoading] = useState(false)
  const [result, setResult] = useState<Record<string, unknown> | null>(null)

  const run = useCallback(async () => {
    if (!token) return
    setLoading(true)
    try {
      const data = await fetchPharmacyReport(token, type, from, to)
      setResult(data)
    } catch (err) {
      setResult(null)
      Alert.alert('Report failed', err instanceof ApiError ? err.message : 'Try again')
    } finally {
      setLoading(false)
    }
  }, [token, type, from, to])

  const share = async () => {
    if (!result) return
    try {
      const dir = FileSystem.cacheDirectory
      if (!dir) {
        Alert.alert('Share unavailable', 'File cache is not available on this device.')
        return
      }
      const path = `${dir}pharmacy-report-${type}.json`
      await FileSystem.writeAsStringAsync(path, JSON.stringify(result, null, 2))
      if (await Sharing.isAvailableAsync()) {
        await Sharing.shareAsync(path, {
          mimeType: 'application/json',
          dialogTitle: 'Share pharmacy report',
        })
      } else {
        Alert.alert('Sharing unavailable', 'Report saved locally but sharing is not supported.')
      }
    } catch (err) {
      Alert.alert('Share failed', err instanceof Error ? err.message : 'Try again')
    }
  }

  const summary = (result?.summary as Record<string, unknown> | undefined) ?? null

  return (
    <ScrollView
      style={styles.root}
      contentContainerStyle={{
        padding: spacing.xl,
        paddingBottom: insets.bottom + tabBarHeight + spacing.lg,
      }}
      keyboardShouldPersistTaps="handled"
    >
      <Text style={styles.heading}>Report type</Text>
      <View style={styles.chips}>
        {REPORT_TYPES.map((t) => (
          <Pressable
            key={t.key}
            style={[styles.chip, type === t.key && styles.chipActive]}
            onPress={() => setType(t.key)}
          >
            <Text style={[styles.chipText, type === t.key && styles.chipTextActive]}>
              {t.label}
            </Text>
          </Pressable>
        ))}
      </View>

      <TextField label="From (YYYY-MM-DD)" value={from} onChangeText={setFrom} autoCapitalize="none" />
      <TextField label="To (YYYY-MM-DD)" value={to} onChangeText={setTo} autoCapitalize="none" />
      <Button label="Run report" onPress={run} loading={loading} />

      {loading ? <LoadingBlock message="Building report…" /> : null}

      {summary ? (
        <View style={styles.card}>
          <Text style={styles.cardTitle}>Summary</Text>
          {Object.entries(summary).map(([k, v]) => (
            <View key={k} style={styles.row}>
              <Text style={styles.key}>{k}</Text>
              <Text style={styles.val}>
                {typeof v === 'number' ? v.toLocaleString() : String(v ?? '—')}
              </Text>
            </View>
          ))}
          <Button label="Share JSON" onPress={share} variant="ghost" style={{ marginTop: spacing.md }} />
        </View>
      ) : null}

      {result && type === 'sales' && Array.isArray(result.transactions) ? (
        <View style={styles.card}>
          <Text style={styles.cardTitle}>Recent transactions</Text>
          {(result.transactions as Array<Record<string, unknown>>).slice(0, 20).map((tx) => (
            <View key={String(tx.id)} style={styles.item}>
              <Text style={styles.itemTitle}>{String(tx.receiptNumber ?? tx.id)}</Text>
              <Text style={styles.itemMeta}>
                UGX {Number(tx.totalAmount ?? 0).toLocaleString()} · {String(tx.paymentMethod ?? '—')}
              </Text>
            </View>
          ))}
        </View>
      ) : null}

      {result &&
      (type === 'low-stock' || type === 'inventory') &&
      Array.isArray(result.lowStockProducts) ? (
        <View style={styles.card}>
          <Text style={styles.cardTitle}>Low stock</Text>
          {(result.lowStockProducts as Array<Record<string, unknown>>).slice(0, 30).map((p) => (
            <View key={String(p.id)} style={styles.item}>
              <Text style={styles.itemTitle}>{String(p.name)}</Text>
              <Text style={styles.itemMeta}>Qty {Number(p.quantity ?? 0)}</Text>
            </View>
          ))}
        </View>
      ) : null}

      {result &&
      (type === 'expiry' || type === 'inventory') &&
      Array.isArray(result.expiringProducts) ? (
        <View style={styles.card}>
          <Text style={styles.cardTitle}>Expiring</Text>
          {(result.expiringProducts as Array<Record<string, unknown>>).slice(0, 30).map((p) => (
            <View key={String(p.id)} style={styles.item}>
              <Text style={styles.itemTitle}>{String(p.name)}</Text>
              <Text style={styles.itemMeta}>{String(p.expiryDate ?? '—').slice(0, 10)}</Text>
            </View>
          ))}
        </View>
      ) : null}

      {result && type === 'refunds' && Array.isArray(result.refunds) ? (
        <View style={styles.card}>
          <Text style={styles.cardTitle}>Refunds</Text>
          {(result.refunds as Array<Record<string, unknown>>).slice(0, 30).map((r) => (
            <View key={String(r.id)} style={styles.item}>
              <Text style={styles.itemTitle}>{String(r.receiptNumber)}</Text>
              <Text style={styles.itemMeta}>
                UGX {Number(r.totalAmount ?? 0).toLocaleString()} · {String(r.reason ?? '—')}
              </Text>
            </View>
          ))}
        </View>
      ) : null}
    </ScrollView>
  )
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  heading: {
    ...typography.label,
    color: colors.textSecondary,
    marginBottom: spacing.sm,
    fontFamily: 'DMSans_500Medium',
  },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, marginBottom: spacing.xl },
  chip: {
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: radii.md,
    borderWidth: 1,
    borderColor: colors.border,
  },
  chipActive: { borderColor: colors.primary, backgroundColor: colors.primarySoft },
  chipText: { color: colors.textSecondary, fontFamily: 'DMSans_500Medium', fontSize: 13 },
  chipTextActive: { color: colors.primary },
  card: {
    marginTop: spacing.xl,
    backgroundColor: colors.bgElevated,
    borderRadius: radii.lg,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.lg,
  },
  cardTitle: {
    ...typography.bodyMedium,
    color: colors.text,
    fontFamily: 'DMSans_700Bold',
    marginBottom: spacing.md,
  },
  row: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: 6,
    gap: spacing.md,
  },
  key: { color: colors.textSecondary, fontFamily: 'DMSans_400Regular', flex: 1 },
  val: { color: colors.text, fontFamily: 'DMSans_500Medium' },
  item: { paddingVertical: 8, borderTopWidth: 1, borderTopColor: colors.borderSubtle },
  itemTitle: { color: colors.text, fontFamily: 'DMSans_500Medium' },
  itemMeta: { color: colors.textMuted, fontFamily: 'DMSans_400Regular', marginTop: 2, fontSize: 12 },
})
