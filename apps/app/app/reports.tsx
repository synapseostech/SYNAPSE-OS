import { useCallback, useEffect, useState, type ReactNode } from 'react'
import {
  Alert,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import { useRouter } from 'expo-router'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import * as FileSystem from 'expo-file-system/legacy'
import * as Sharing from 'expo-sharing'
import { Button } from '@/components/ui/Button'
import { LoadingBlock } from '@/components/ui/LoadingBlock'
import { useAuth } from '@/lib/auth'
import { apiRequest } from '@/lib/api'
import { colors, radii, spacing, typography } from '@/lib/theme'

interface ReportData {
  period: string
  from: string
  to: string
  summary: {
    totalSales: number
    transactionCount: number
    averageTransaction: number
    totalDiscount: number
    totalTax: number
    grossProfit: number
    profitMargin: number
  }
  paymentMix: { method: string; total: number; count: number }[]
  topProducts: { name: string; quantity: number; revenue: number; cost: number }[]
  lowStock: { name: string; sellable: number; reorderLevel: number }[]
  expiring: { name: string; expiryDate: string; days: number }[]
}

const PERIODS = [
  { key: 'today', label: 'Today' },
  { key: 'week', label: '7 days' },
  { key: 'month', label: '30 days' },
]

export default function ReportsScreen() {
  const { token } = useAuth()
  const router = useRouter()
  const insets = useSafeAreaInsets()
  const [period, setPeriod] = useState('today')
  const [data, setData] = useState<ReportData | null>(null)
  const [loading, setLoading] = useState(true)
  const [exporting, setExporting] = useState(false)

  const money = (n: number) => `UGX ${Number(n).toLocaleString()}`

  const load = useCallback(async () => {
    if (!token) return setLoading(false)
    setLoading(true)
    try {
      const d = await apiRequest<ReportData>(`/api/mobile/pharmacy/reports?period=${period}`, { token })
      setData(d)
    } catch {
      setData(null)
    } finally {
      setLoading(false)
    }
  }, [token, period])

  useEffect(() => {
    load()
  }, [load])

  const exportCsv = async () => {
    if (!data) return
    setExporting(true)
    try {
      const lines: string[] = []
      lines.push(`Synapse Pharm report,${data.period},${data.from},${data.to}`)
      lines.push('')
      lines.push('Summary,Value')
      lines.push(`Total sales,${data.summary.totalSales}`)
      lines.push(`Transactions,${data.summary.transactionCount}`)
      lines.push(`Average transaction,${data.summary.averageTransaction}`)
      lines.push(`Discounts,${data.summary.totalDiscount}`)
      lines.push(`Tax,${data.summary.totalTax}`)
      lines.push(`Gross profit,${data.summary.grossProfit}`)
      lines.push(`Profit margin %,${data.summary.profitMargin}`)
      lines.push('')
      lines.push('Payment method,Total,Count')
      ;(data.paymentMix ?? []).forEach((p) => lines.push(`${p.method},${p.total},${p.count}`))
      lines.push('')
      lines.push('Top product,Quantity,Revenue')
      ;(data.topProducts ?? []).forEach((p) => lines.push(`${p.name.replace(/,/g, ' ')},${p.quantity},${p.revenue}`))
      lines.push('')
      lines.push('Low stock,Sellable,Reorder level')
      ;(data.lowStock ?? []).forEach((p) => lines.push(`${p.name.replace(/,/g, ' ')},${p.sellable},${p.reorderLevel}`))
      lines.push('')
      lines.push('Expiring soon,Expiry,Days left')
      ;(data.expiring ?? []).forEach((p) => lines.push(`${p.name.replace(/,/g, ' ')},${p.expiryDate},${p.days}`))

      const dir = FileSystem.cacheDirectory
      if (!dir) {
        Alert.alert('Export unavailable', 'File cache is not available on this device.')
        return
      }
      const uri = `${dir}synapse-report-${period}.csv`
      await FileSystem.writeAsStringAsync(uri, lines.join('\n'), {
        encoding: 'utf8',
      })
      if (await Sharing.isAvailableAsync()) {
        await Sharing.shareAsync(uri, { mimeType: 'text/csv', dialogTitle: 'Share report' })
      } else {
        Alert.alert('Saved', `Report saved to ${uri}`)
      }
    } catch (err) {
      Alert.alert('Export failed', err instanceof Error ? err.message : 'Try again.')
    } finally {
      setExporting(false)
    }
  }

  return (
    <View style={[styles.root, { paddingTop: insets.top }]}>
      <View style={styles.header}>
        <Pressable onPress={() => router.back()} hitSlop={12} style={styles.backBtn}>
          <Ionicons name="chevron-back" size={22} color={colors.primary} />
        </Pressable>
        <Text style={styles.title}>Reports</Text>
        <View style={{ width: 48 }} />
      </View>

      <View style={styles.periods}>
        {PERIODS.map((p) => (
          <Pressable key={p.key} onPress={() => setPeriod(p.key)} style={[styles.chip, period === p.key && styles.chipActive]}>
            <Text style={[styles.chipText, period === p.key && styles.chipTextActive]}>{p.label}</Text>
          </Pressable>
        ))}
      </View>

      {loading ? (
        <LoadingBlock message="Building report…" />
      ) : !data ? (
        <Text style={styles.help}>Could not load report.</Text>
      ) : (
        <ScrollView contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + spacing.xxl }]}>
          <View style={styles.cards}>
            <Stat label="Total sales" value={money(data.summary.totalSales)} />
            <Stat label="Transactions" value={String(data.summary.transactionCount)} />
            <Stat label="Avg sale" value={money(data.summary.averageTransaction)} />
            <Stat label="Gross profit" value={money(data.summary.grossProfit)} />
            <Stat label="Margin" value={`${data.summary.profitMargin}%`} />
            <Stat label="Discounts" value={money(data.summary.totalDiscount)} />
          </View>

          <Group title="Payment methods">
            {(data.paymentMix ?? []).length === 0 ? <Text style={styles.help}>No sales in this period.</Text> : null}
            {(data.paymentMix ?? []).map((p) => (
              <Row key={p.method} left={p.method} right={`${money(p.total)} · ${p.count}`} />
            ))}
          </Group>

          <Group title="Top products">
            {(data.topProducts ?? []).map((p) => (
              <Row key={p.name} left={`${p.name} ×${p.quantity}`} right={money(p.revenue)} />
            ))}
          </Group>

          <Group title={`Low stock (${(data.lowStock ?? []).length})`}>
            {(data.lowStock ?? []).map((p) => (
              <Row key={p.name} left={p.name} right={`${p.sellable} / reorder ${p.reorderLevel}`} tone="warn" />
            ))}
          </Group>

          <Group title={`Expiring ≤90d (${(data.expiring ?? []).length})`}>
            {(data.expiring ?? []).map((p, i) => (
              <Row key={`${p.name}-${i}`} left={p.name} right={`${p.expiryDate} (${p.days}d)`} tone="warn" />
            ))}
          </Group>

          <Button label="Export CSV" onPress={exportCsv} loading={exporting} style={{ marginTop: spacing.lg }} />
        </ScrollView>
      )}
    </View>
  )
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.stat}>
      <Text style={styles.statValue}>{value}</Text>
      <Text style={styles.statLabel}>{label}</Text>
    </View>
  )
}
function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <View style={styles.group}>
      <Text style={styles.groupTitle}>{title}</Text>
      {children}
    </View>
  )
}
function Row({ left, right, tone }: { left: string; right: string; tone?: 'warn' }) {
  return (
    <View style={styles.dataRow}>
      <Text style={styles.rowLeft} numberOfLines={1}>{left}</Text>
      <Text style={[styles.rowRight, tone === 'warn' && { color: colors.primary }]}>{right}</Text>
    </View>
  )
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: spacing.lg, paddingVertical: spacing.md },
  backBtn: { width: 48 },
  title: { ...typography.h3, color: colors.text, fontFamily: 'DMSans_700Bold' },
  periods: { flexDirection: 'row', gap: spacing.sm, paddingHorizontal: spacing.lg, paddingBottom: spacing.sm },
  chip: { paddingVertical: spacing.xs, paddingHorizontal: spacing.md, borderRadius: radii.md, borderWidth: 1, borderColor: colors.border },
  chipActive: { backgroundColor: colors.primary, borderColor: colors.primary },
  chipText: { ...typography.caption, color: colors.textSecondary },
  chipTextActive: { color: colors.primaryForeground, fontFamily: 'DMSans_700Bold' },
  content: { padding: spacing.lg, gap: spacing.md },
  cards: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  stat: { width: '31%', backgroundColor: colors.surface, borderRadius: radii.md, borderWidth: 1, borderColor: colors.border, padding: spacing.md },
  statValue: { ...typography.bodyMedium, color: colors.text, fontFamily: 'IBMPlexMono_500Medium' },
  statLabel: { ...typography.caption, color: colors.textMuted, marginTop: 2 },
  group: { backgroundColor: colors.surface, borderRadius: radii.lg, borderWidth: 1, borderColor: colors.border, padding: spacing.md, gap: spacing.xs },
  groupTitle: { ...typography.bodyMedium, color: colors.primary, fontFamily: 'DMSans_700Bold', marginBottom: spacing.xs },
  dataRow: { flexDirection: 'row', justifyContent: 'space-between', gap: spacing.sm, paddingVertical: 3 },
  rowLeft: { ...typography.bodySm, color: colors.text, flex: 1 },
  rowRight: { ...typography.bodySm, color: colors.textSecondary, fontFamily: 'IBMPlexMono_400Regular' },
  help: { ...typography.bodySm, color: colors.textMuted },
})
