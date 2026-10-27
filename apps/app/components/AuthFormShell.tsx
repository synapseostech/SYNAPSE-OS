import { ReactNode } from 'react'
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useRouter } from 'expo-router'
import { BrandWordmark } from '@/components/BrandWordmark'
import { Screen } from '@/components/ui/Screen'
import { Card } from '@/components/ui/Card'
import { spacing, typography, useTheme } from '@/lib/theme'

interface AuthFormShellProps {
  subtitle: string
  children: ReactNode
  footer?: ReactNode
  showBack?: boolean
  /** Wrap the children in the standard form card. Off when the children are cards themselves. */
  card?: boolean
}

export function AuthFormShell({ subtitle, children, footer, showBack = true, card = true }: AuthFormShellProps) {
  const insets = useSafeAreaInsets()
  const router = useRouter()
  const { colors } = useTheme()

  return (
    <Screen glow>
      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      >
        <ScrollView
          contentContainerStyle={[
            styles.scroll,
            { paddingTop: insets.top + spacing.xxl, paddingBottom: insets.bottom + spacing.xxl },
          ]}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          {showBack ? (
            <Pressable
              onPress={() => router.back()}
              style={styles.backBtn}
              accessibilityRole="button"
              accessibilityLabel="Go back"
            >
              <Text style={[styles.backText, { color: colors.primary }]}>Back</Text>
            </Pressable>
          ) : null}

          <BrandWordmark logoSize="lg" subtitle={subtitle} />

          {card ? (
            <Card style={styles.formCard} padded={false}>
              <View style={styles.formInner}>{children}</View>
            </Card>
          ) : (
            children
          )}

          {footer}
          <Text style={[styles.footer, { color: colors.textMuted }]}>Synapse Health Technologies</Text>
        </ScrollView>
      </KeyboardAvoidingView>
    </Screen>
  )
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  scroll: {
    flexGrow: 1,
    justifyContent: 'center',
    paddingHorizontal: spacing.xxl,
    gap: spacing.xxl,
  },
  backBtn: { alignSelf: 'flex-start' },
  backText: {
    ...typography.bodyMedium,
    fontFamily: 'DMSans_500Medium',
  },
  formCard: { marginTop: spacing.sm },
  formInner: { padding: spacing.xxl },
  footer: {
    textAlign: 'center',
    fontSize: 11,
    fontFamily: 'DMSans_400Regular',
    letterSpacing: 0.5,
  },
})
