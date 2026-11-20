import { useCallback, useEffect, useState } from 'react'
import {
  Linking,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import { useRouter } from 'expo-router'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { Button } from '@/components/ui/Button'
import { LoadingBlock } from '@/components/ui/LoadingBlock'
import { useAuth } from '@/lib/auth'
import { apiRequest } from '@/lib/api'
import { radii, spacing, typography, TONE_COLORS, makeStyles, useTheme } from '@/lib/theme'

interface Subscription {
  status: string
  planName: string | null
  priceUgx: number | null
  billingCycle: string | null
  trialEnds: string | null
  currentPeriodEnd: string | null
  graceUntil: string | null
  lastPaymentAt: string | null
}
interface Payment {
  id: string
  amount_ugx: number
  status: string
  method: string | null
  created_at: string
}
interface Plan {
  slug?: string
  name?: string
  price_ugx?: number
  billing_cycle?: string
}

const PHARM_BILLING = 'https://pharm.synapseos.tech/portal/billing'
const ACTIVE = new Set(['active', 'trial', 'trialing'])

export default function BillingScreen() {
  const styles = useStyles()
  const { colors } = useTheme()
  const { token } = useAuth()
  const router = useRouter()
  const insets = useSafeAreaInsets()
  const [sub, setSub] = useState<Subscription | null>(null)
  const [payments, setPayments] = useState<Payment[]>([])
  const [plans, setPlans] = useState<Plan[]>([])
  const [loading, setLoading] = useState(true)

  const money = (n: number | null | undefined) => `UGX ${Number(n ?? 0).toLocaleString()}`
  const date = (s: string | null | undefined) => (s ? new Date(s).toLocaleDateString() : '—')

  const load = useCallback(async () => {
    if (!token) return setLoading(false)
    try {
      const data = await apiRequest<{ subscription: Subscription | null; payments: Payment[]; plans: Plan[] }>(
        '/api/mobile/pharmacy/billing',
        { token },
      )
      setSub(data.subscription)
      setPayments(data.payments ?? [])
      setPlans(data.plans ?? [])
    } catch {
      setSub(null)
    } finally {
      setLoading(false)
    }
  }, [token])

  useEffect(() => {
    load()
  }, [load])

  const status = sub?.status ?? 'unknown'
  const isActive = ACTIVE.has(status)

  return (
    <View style={[styles.root, { paddingTop: insets.top }]}>
      <View style={styles.header}>
        <Pressable onPress={() => router.back()} hitSlop={12} style={styles.backBtn}>
          <Ionicons name="chevron-back" size={22} color={colors.primary} />
        </Pressable>
        <Text style={styles.title}>Billing</Text>
        <View style={{ width: 48 }} />
      </View>

      {loading ? (
        <LoadingBlock message="Loading subscription…" />
      ) : (
        <ScrollView contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + spacing.xxl }]}>
          <View style={styles.statusCard}>
            <Text style={[styles.statusBadge, { color: isActive ? TONE_COLORS.green : TONE_COLORS.red }]}>
              {status.toUpperCase()}
            </Text>
            <Text style={styles.planName}>{sub?.planName ?? 'No active plan'}</Text>
            {sub?.priceUgx ? <Text style={styles.price}>{money(sub.priceUgx)} / {sub.billingCycle ?? 'month'}</Text> : null}
            <View style={styles.divider} />
            <Row k="Renews" v={date(sub?.currentPeriodEnd)} />
            {sub?.trialEnds ? <Row k="Trial ends" v={date(sub.trialEnds)} /> : null}
            {sub?.graceUntil ? <Row k="Grace until" v={date(sub.graceUntil)} /> : null}
            <Row k="Last payment" v={date(sub?.lastPaymentAt)} />
          </View>

          {!isActive ? (
            <Text style={styles.lockNote}>
              Your subscription is not active. Renew to restore full access.
            </Text>
          ) : null}

          <Button
            label={isActive ? 'Manage / renew payment' : 'Renew subscription'}
            onPress={() => Linking.openURL(PHARM_BILLING).catch(() => {})}
          />
          <Text style={styles.gatewayNote}>Payments are processed securely by our payment provider.</Text>

          <Text style={styles.section}>Plans</Text>
          {plans.map((p, i) => (
            <View key={p.slug ?? i} style={styles.planRow}>
              <Text style={styles.rowLeft}>{p.name ?? p.slug}</Text>
              <Text style={styles.rowRight}>{money(p.price_ugx)}/{p.billing_cycle ?? 'mo'}</Text>
            </View>
          ))}

          <Text style={styles.section}>Payment history</Text>
          {payments.length === 0 ? <Text style={styles.help}>No payments yet.</Text> : null}
          {payments.map((p) => (
            <View key={p.id} style={styles.planRow}>
              <Text style={styles.rowLeft}>{date(p.created_at)} · {p.method ?? '—'}</Text>
              <Text style={styles.rowRight}>{money(p.amount_ugx)} · {p.status}</Text>
            </View>
          ))}
        </ScrollView>
      )}
    </View>
  )
}

function Row({ k, v }: { k: string; v: string }) {
  const styles = useStyles()
  return (
    <View style={styles.kv}>
      <Text style={styles.kvKey}>{k}</Text>
      <Text style={styles.kvVal}>{v}</Text>
    </View>
  )
}

const useStyles = makeStyles((colors) => ({
  root: { flex: 1, backgroundColor: colors.bg },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: spacing.lg, paddingVertical: spacing.md },
  backBtn: { width: 48 },
  title: { ...typography.h3, color: colors.text, fontFamily: 'DMSans_700Bold' },
  content: { padding: spacing.lg, gap: spacing.md },
  statusCard: { backgroundColor: colors.surface, borderRadius: radii.lg, borderWidth: 1, borderColor: colors.border, padding: spacing.lg },
  statusBadge: { ...typography.caption, fontFamily: 'DMSans_700Bold' },
  planName: { ...typography.h3, color: colors.text, marginTop: spacing.xs, fontFamily: 'DMSans_700Bold' },
  price: { ...typography.bodySm, color: colors.textSecondary, marginTop: 2 },
  divider: { height: 1, backgroundColor: colors.border, marginVertical: spacing.md },
  kv: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 2 },
  kvKey: { ...typography.bodySm, color: colors.textSecondary },
  kvVal: { ...typography.bodySm, color: colors.text, fontFamily: 'IBMPlexMono_400Regular' },
  lockNote: { ...typography.bodySm, color: TONE_COLORS.red, fontFamily: 'DMSans_500Medium' },
  gatewayNote: { ...typography.caption, color: colors.textMuted, textAlign: 'center' },
  section: { ...typography.bodyMedium, color: colors.primary, fontFamily: 'DMSans_700Bold', marginTop: spacing.md },
  planRow: { flexDirection: 'row', justifyContent: 'space-between', backgroundColor: colors.surface, borderRadius: radii.md, borderWidth: 1, borderColor: colors.border, padding: spacing.md },
  rowLeft: { ...typography.bodySm, color: colors.text, flex: 1 },
  rowRight: { ...typography.bodySm, color: colors.textSecondary, fontFamily: 'IBMPlexMono_400Regular' },
  help: { ...typography.bodySm, color: colors.textMuted },
}))
