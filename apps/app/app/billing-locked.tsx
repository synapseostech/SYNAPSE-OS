import { StyleSheet, Text, View } from 'react-native'
import { useLocalSearchParams, useRouter } from 'expo-router'
import { Ionicons } from '@expo/vector-icons'
import { Button } from '@/components/ui/Button'
import { useAuth } from '@/lib/auth'
import { radii, spacing, typography, makeStyles, useTheme } from '@/lib/theme'

/**
 * Shown when the server answers HTTP 402 (subscription suspended / lapsed).
 * The lock is server-side; this screen only explains it and offers recovery.
 */
export default function BillingLockedScreen() {
  const styles = useStyles()
  const { colors } = useTheme()
  const router = useRouter()
  const { user, logout } = useAuth()
  const params = useLocalSearchParams<{ message?: string }>()

  const message =
    (typeof params.message === 'string' && params.message) ||
    'This facility’s subscription is not active. An administrator can renew it from the billing page.'

  return (
    <View style={styles.root}>
      <View style={styles.iconWrap}>
        <Ionicons name="card-outline" size={40} color={colors.primary} />
      </View>

      <Text style={styles.title}>Subscription needs attention</Text>
      {user?.tenantName ? <Text style={styles.tenant}>{user.tenantName}</Text> : null}
      <Text style={styles.message}>{message}</Text>

      <View style={styles.actions}>
        <Button
          label="View billing & renew"
          onPress={() => router.push('/billing' as never)}
        />
        <Button
          label="Check again"
          variant="ghost"
          onPress={() => router.replace('/(main)/home')}
        />
        <Button
          label="Sign out"
          variant="ghost"
          onPress={() => {
            logout().finally(() => router.replace('/(auth)/login'))
          }}
        />
      </View>

      <Text style={styles.footnote}>
        Your data is safe and nothing has been deleted. Access resumes as soon as the
        subscription is renewed.
      </Text>
    </View>
  )
}

const useStyles = makeStyles((colors) => ({
  root: {
    flex: 1,
    backgroundColor: colors.bg,
    justifyContent: 'center',
    paddingHorizontal: spacing.xl,
    gap: spacing.sm,
  },
  iconWrap: {
    alignSelf: 'center',
    width: 72,
    height: 72,
    borderRadius: radii.full,
    backgroundColor: colors.bgSubtle,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: spacing.md,
  },
  title: {
    ...typography.h2,
    color: colors.text,
    textAlign: 'center',
  },
  tenant: {
    ...typography.caption,
    color: colors.textMuted,
    textAlign: 'center',
  },
  message: {
    ...typography.body,
    color: colors.textMuted,
    textAlign: 'center',
    marginTop: spacing.sm,
  },
  actions: {
    marginTop: spacing.xl,
    gap: spacing.sm,
  },
  footnote: {
    ...typography.caption,
    color: colors.textMuted,
    textAlign: 'center',
    marginTop: spacing.lg,
  },
}))
