import { ReactNode } from 'react'
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  type StyleProp,
  type ViewStyle,
} from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import { useRouter } from 'expo-router'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { spacing, typography, makeStyles, useTheme } from '@/lib/theme'

type Props = {
  title: string
  children: ReactNode
  /** When false, children fill remaining space (e.g. lists). Default true. */
  scroll?: boolean
  footer?: ReactNode
  rightAction?: ReactNode
  contentStyle?: StyleProp<ViewStyle>
  onBack?: () => void
}

/**
 * Phone-safe shell: top inset, optional keyboard avoid, scroll with bottom inset,
 * so primary actions stay reachable on small screens.
 */
export function ScreenShell({
  title,
  children,
  scroll = true,
  footer,
  rightAction,
  contentStyle,
  onBack,
}: Props) {
  const styles = useStyles()
  const { colors } = useTheme()
  const router = useRouter()
  const insets = useSafeAreaInsets()
  const bottomPad = Math.max(insets.bottom, spacing.md) + spacing.lg

  const header = (
    <View style={[styles.header, { paddingTop: Math.max(insets.top, spacing.sm) }]}>
      <Pressable
        onPress={onBack ?? (() => router.back())}
        hitSlop={12}
        style={styles.backBtn}
        accessibilityRole="button"
        accessibilityLabel="Go back"
      >
        <Ionicons name="chevron-back" size={22} color={colors.primary} />
      </Pressable>
      <Text style={styles.title} numberOfLines={1}>
        {title}
      </Text>
      <View style={styles.right}>{rightAction ?? <View style={{ width: 48 }} />}</View>
    </View>
  )

  const body = scroll ? (
    <ScrollView
      style={styles.flex}
      contentContainerStyle={[styles.scrollContent, { paddingBottom: bottomPad }, contentStyle]}
      keyboardShouldPersistTaps="handled"
      keyboardDismissMode="on-drag"
      showsVerticalScrollIndicator={false}
    >
      {children}
    </ScrollView>
  ) : (
    <View style={[styles.flex, contentStyle]}>{children}</View>
  )

  return (
    <View style={styles.root}>
      {header}
      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        keyboardVerticalOffset={Platform.OS === 'ios' ? 8 : 0}
      >
        {body}
        {footer ? (
          <View style={[styles.footer, { paddingBottom: bottomPad }]}>{footer}</View>
        ) : null}
      </KeyboardAvoidingView>
    </View>
  )
}

const useStyles = makeStyles((colors) => ({
  root: { flex: 1, backgroundColor: colors.bg },
  flex: { flex: 1 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.borderSubtle,
    backgroundColor: colors.bg,
  },
  backBtn: { width: 48, alignItems: 'flex-start' },
  title: {
    ...typography.h3,
    color: colors.text,
    fontFamily: 'DMSans_700Bold',
    flex: 1,
    textAlign: 'center',
  },
  right: { width: 48, alignItems: 'flex-end' },
  scrollContent: {
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.lg,
  },
  footer: {
    borderTopWidth: 1,
    borderTopColor: colors.border,
    backgroundColor: colors.surface,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
  },
}))
