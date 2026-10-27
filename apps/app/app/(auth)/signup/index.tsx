import { Ionicons } from '@expo/vector-icons'
import { useRouter } from 'expo-router'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import { AuthFormShell } from '@/components/AuthFormShell'
import { Card } from '@/components/ui/Card'
import { spacing, typography, useTheme } from '@/lib/theme'

type IoniconsName = React.ComponentProps<typeof Ionicons>['name']

type RoleOption = {
  title: string
  description: string
  icon: IoniconsName
  href: string
}

const ROLES: RoleOption[] = [
  {
    title: 'Daily user',
    description:
      'Track blood pressure, glucose, habits, cycle and activity. Personal health data stays on this device.',
    icon: 'heart-outline',
    href: '/(auth)/signup/daily',
  },
  {
    title: 'Hospital staff',
    description:
      'Apply for a clinical or administrative account. Your facility confirms your role before you can sign in.',
    icon: 'medkit-outline',
    href: '/(auth)/signup/staff',
  },
  {
    title: 'Pharmacy',
    description:
      'Create a pharmacy workspace and owner account in the app, then sign in to run the till, stock and sales.',
    icon: 'storefront-outline',
    href: '/(auth)/signup/pharmacy',
  },
]

export default function SignupIndexScreen() {
  const router = useRouter()
  const { colors } = useTheme()

  return (
    <AuthFormShell
      subtitle="Create an account"
      card={false}
      footer={
        <Pressable
          onPress={() => router.replace('/(auth)/login' as never)}
          style={styles.signIn}
          accessibilityRole="button"
        >
          <Text style={[styles.signInText, { color: colors.textSecondary }]}>
            Already have an account? <Text style={{ color: colors.primary }}>Sign in</Text>
          </Text>
        </Pressable>
      }
    >
      <Text style={[styles.intro, { color: colors.textSecondary }]}>
        Choose the account that matches how you will use Synapse.
      </Text>

      <View style={styles.list}>
        {ROLES.map((role) => (
          <Pressable
            key={role.title}
            onPress={() => router.push(role.href as never)}
            accessibilityRole="button"
            accessibilityLabel={`Create a ${role.title} account`}
            style={({ pressed }) => [pressed && styles.pressed]}
          >
            <Card>
              <View style={styles.row}>
                <View style={[styles.iconWrap, { backgroundColor: colors.primarySoft }]}>
                  <Ionicons name={role.icon} size={22} color={colors.primary} />
                </View>
                <View style={styles.textWrap}>
                  <Text style={[styles.title, { color: colors.text }]}>{role.title}</Text>
                  <Text style={[styles.description, { color: colors.textSecondary }]}>
                    {role.description}
                  </Text>
                </View>
                <Ionicons name="chevron-forward" size={18} color={colors.textMuted} />
              </View>
            </Card>
          </Pressable>
        ))}
      </View>
    </AuthFormShell>
  )
}

const styles = StyleSheet.create({
  intro: {
    ...typography.body,
    textAlign: 'center',
  },
  list: { gap: spacing.md },
  pressed: { opacity: 0.9, transform: [{ scale: 0.99 }] },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
  },
  iconWrap: {
    width: 42,
    height: 42,
    borderRadius: 21,
    alignItems: 'center',
    justifyContent: 'center',
  },
  textWrap: { flex: 1, gap: 4 },
  title: {
    ...typography.bodyMedium,
    fontFamily: 'DMSans_700Bold',
  },
  description: {
    ...typography.caption,
    fontFamily: 'DMSans_400Regular',
    lineHeight: 18,
  },
  signIn: { alignItems: 'center' },
  signInText: {
    ...typography.caption,
    fontFamily: 'DMSans_400Regular',
  },
})
