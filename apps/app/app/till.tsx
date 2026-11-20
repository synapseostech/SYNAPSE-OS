import { useCallback, useEffect, useState } from 'react'
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import { useRouter } from 'expo-router'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { LoadingBlock } from '@/components/ui/LoadingBlock'
import { useAuth } from '@/lib/auth'
import { apiRequest } from '@/lib/api'
import { radii, spacing, typography, makeStyles, useTheme } from '@/lib/theme'

type TillSession = {
  id: string
  status: string
  openingFloat: number
  cashPaymentTotal: number
  cashRefundTotal: number
  cashIn: number
  cashOut: number
  expectedCash: number
  openedAt: string
}

export default function TillScreen() {
  const styles = useStyles()
  const { colors } = useTheme()
  const { token } = useAuth()
  const router = useRouter()
  const insets = useSafeAreaInsets()
  const [session, setSession] = useState<TillSession | null>(null)
  const [loading, setLoading] = useState(true)
  const [openingFloat, setOpeningFloat] = useState('0')
  const [countedCash, setCountedCash] = useState('')
  const [varianceReason, setVarianceReason] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    if (!token) return setLoading(false)
    try {
      const data = await apiRequest<{ session: TillSession | null }>('/api/mobile/pharmacy/till', { token })
      setSession(data.session)
    } catch {
      setSession(null)
    } finally {
      setLoading(false)
    }
  }, [token])

  useEffect(() => {
    void load()
  }, [load])

  async function act(body: Record<string, unknown>) {
    if (!token) return
    setBusy(true)
    setError(null)
    try {
      const data = await apiRequest<{ session: TillSession }>('/api/mobile/pharmacy/till', {
        method: 'POST',
        token,
        body,
      })
      setSession(data.session)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Till action failed')
    } finally {
      setBusy(false)
    }
  }

  return (
    <View style={[styles.root, { paddingTop: insets.top }]}>
      <View style={styles.header}>
        <Pressable
          onPress={() => router.back()}
          hitSlop={12}
          style={styles.backBtn}
          accessibilityRole="button"
          accessibilityLabel="Go back"
        >
          <Ionicons name="chevron-back" size={22} color={colors.primary} />
        </Pressable>
        <Text style={styles.title} accessibilityRole="header">
          Till
        </Text>
        <View style={{ width: 48 }} />
      </View>

      {loading ? (
        <LoadingBlock message="Loading till…" />
      ) : (
        <View style={[styles.content, { paddingBottom: insets.bottom + spacing.xxl }]}>
          {error ? <Text style={styles.error}>{error}</Text> : null}
          {session ? (
            <>
              <Text style={styles.status}>Status: {session.status.toUpperCase()}</Text>
              <Text style={styles.meta}>Opening float: {session.openingFloat}</Text>
              <Text style={styles.meta}>Cash sales: {session.cashPaymentTotal}</Text>
              <Text style={styles.meta}>Cash refunds: {session.cashRefundTotal}</Text>
              <Text style={styles.meta}>Expected cash: {session.expectedCash}</Text>
              <TextInput
                style={styles.input}
                keyboardType="numeric"
                value={countedCash}
                onChangeText={setCountedCash}
                placeholder="Counted cash"
                accessibilityLabel="Counted cash"
              />
              <TextInput
                style={styles.input}
                value={varianceReason}
                onChangeText={setVarianceReason}
                placeholder="Variance reason if count differs"
                accessibilityLabel="Variance reason"
              />
              <Pressable
                style={styles.button}
                disabled={busy}
                onPress={() =>
                  act({
                    action: 'close',
                    sessionId: session.id,
                    countedCash: Number(countedCash),
                    varianceReason,
                  })
                }
                accessibilityRole="button"
                accessibilityLabel="Close till"
              >
                <Text style={styles.buttonText}>Close till</Text>
              </Pressable>
            </>
          ) : (
            <>
              <Text style={styles.help}>Open a till before selling. One open session per cashier.</Text>
              <TextInput
                style={styles.input}
                keyboardType="numeric"
                value={openingFloat}
                onChangeText={setOpeningFloat}
                placeholder="Opening cash float"
                accessibilityLabel="Opening cash float"
              />
              <Pressable
                style={styles.button}
                disabled={busy}
                onPress={() => act({ action: 'open', openingFloat: Number(openingFloat) })}
                accessibilityRole="button"
                accessibilityLabel="Open till"
              >
                <Text style={styles.buttonText}>Open till</Text>
              </Pressable>
            </>
          )}
        </View>
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
  backBtn: { width: 48, height: 44, justifyContent: 'center' },
  title: { ...typography.h3, color: colors.text, fontFamily: 'DMSans_700Bold' },
  content: { paddingHorizontal: spacing.lg, gap: spacing.md },
  help: { ...typography.bodySm, color: colors.textSecondary },
  status: { ...typography.bodyMedium, color: colors.text },
  meta: { ...typography.caption, color: colors.textMuted },
  error: { ...typography.bodySm, color: colors.danger },
  input: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    color: colors.text,
    minHeight: 44,
  },
  button: {
    backgroundColor: colors.primary,
    borderRadius: radii.md,
    minHeight: 48,
    alignItems: 'center',
    justifyContent: 'center',
  },
  buttonText: { color: colors.primaryForeground, fontWeight: '600' },
}))
