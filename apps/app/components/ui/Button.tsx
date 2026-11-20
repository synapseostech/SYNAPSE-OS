import { ActivityIndicator, Pressable, Text, View, type StyleProp, type ViewStyle } from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import { tapHaptic } from '@/lib/haptics'
import { makeStyles, radii, spacing, touchTarget, useTheme } from '@/lib/theme'

type IoniconName = keyof typeof Ionicons.glyphMap

interface ButtonProps {
  label: string
  onPress: () => void
  loading?: boolean
  disabled?: boolean
  /** primary = filled orange; secondary = tinted; ghost = outlined; danger = red tint. */
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger'
  /** md meets the 48dp touch target; lg is for the one main action on a screen. */
  size?: 'sm' | 'md' | 'lg'
  icon?: IoniconName
  /** Light tap feedback on press. On by default for primary buttons. */
  haptic?: boolean
  style?: StyleProp<ViewStyle>
}

const HEIGHT = { sm: 38, md: touchTarget, lg: 56 } as const

export function Button({
  label,
  onPress,
  loading = false,
  disabled = false,
  variant = 'primary',
  size = 'md',
  icon,
  haptic,
  style,
}: ButtonProps) {
  const styles = useStyles()
  const { colors } = useTheme()
  const isDisabled = disabled || loading
  const fg =
    variant === 'primary'
      ? colors.primaryForeground
      : variant === 'danger'
        ? colors.error
        : colors.primary

  return (
    <Pressable
      onPress={() => {
        if (haptic ?? variant === 'primary') tapHaptic()
        onPress()
      }}
      disabled={isDisabled}
      accessibilityLabel={label}
      accessibilityRole="button"
      accessibilityState={{ disabled: isDisabled, busy: loading }}
      hitSlop={size === 'sm' ? 6 : 0}
      style={({ pressed }) => [
        styles.base,
        { height: HEIGHT[size] },
        size === 'sm' && styles.small,
        variant === 'primary' && styles.primary,
        variant === 'secondary' && styles.secondary,
        variant === 'ghost' && styles.ghost,
        variant === 'danger' && styles.danger,
        pressed && !isDisabled && styles.pressed,
        isDisabled && styles.disabled,
        style,
      ]}
    >
      {loading ? (
        <ActivityIndicator color={fg} />
      ) : (
        <View style={styles.content}>
          {icon ? <Ionicons name={icon} size={size === 'lg' ? 20 : 18} color={fg} /> : null}
          <Text
            style={[styles.label, size === 'lg' && styles.labelLg, size === 'sm' && styles.labelSm, { color: fg }]}
            numberOfLines={1}
          >
            {label}
          </Text>
        </View>
      )}
    </Pressable>
  )
}

const useStyles = makeStyles((colors) => ({
  base: {
    borderRadius: radii.lg,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.lg,
  },
  small: { borderRadius: radii.md, paddingHorizontal: spacing.md },
  primary: { backgroundColor: colors.primary },
  secondary: { backgroundColor: colors.primarySoft },
  ghost: { backgroundColor: 'transparent', borderWidth: 1, borderColor: colors.border },
  danger: { backgroundColor: colors.errorBg, borderWidth: 1, borderColor: colors.errorBorder },
  pressed: { opacity: 0.85, transform: [{ scale: 0.98 }] },
  disabled: { opacity: 0.5 },
  content: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  label: { fontSize: 15, fontFamily: 'DMSans_700Bold' },
  labelLg: { fontSize: 16 },
  labelSm: { fontSize: 13, fontFamily: 'DMSans_500Medium' },
}))
