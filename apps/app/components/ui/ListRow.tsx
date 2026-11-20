import type { ReactNode } from 'react'
import { Pressable, Text, View, type StyleProp, type ViewStyle } from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import { makeStyles, radii, spacing, touchTarget, useTheme } from '@/lib/theme'

type IoniconName = keyof typeof Ionicons.glyphMap

interface ListRowProps {
  title: string
  subtitle?: string | null
  icon?: IoniconName
  iconColor?: string
  /** Replaces the icon tile, e.g. an Avatar. */
  leading?: ReactNode
  /** Right-hand content, e.g. an amount or a badge. */
  trailing?: ReactNode
  onPress?: () => void
  chevron?: boolean
  accessibilityLabel?: string
  style?: StyleProp<ViewStyle>
}

/** One tappable row with a 56dp minimum height: menus, lists, settings. */
export function ListRow({
  title,
  subtitle,
  icon,
  iconColor,
  leading,
  trailing,
  onPress,
  chevron = Boolean(onPress),
  accessibilityLabel,
  style,
}: ListRowProps) {
  const styles = useStyles()
  const { colors } = useTheme()
  const tint = iconColor ?? colors.primary
  const content = (
    <>
      {leading ??
        (icon ? (
          <View style={[styles.iconTile, { backgroundColor: `${tint}1F` }]}>
            <Ionicons name={icon} size={19} color={tint} />
          </View>
        ) : null)}
      <View style={styles.copy}>
        <Text style={styles.title} numberOfLines={1}>
          {title}
        </Text>
        {subtitle ? (
          <Text style={styles.subtitle} numberOfLines={2}>
            {subtitle}
          </Text>
        ) : null}
      </View>
      {trailing}
      {chevron ? <Ionicons name="chevron-forward" size={18} color={colors.textMuted} /> : null}
    </>
  )
  if (!onPress) return <View style={[styles.row, style]}>{content}</View>
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? (subtitle ? `${title}, ${subtitle}` : title)}
      android_ripple={{ color: colors.surfaceHover }}
      style={({ pressed }) => [styles.row, pressed && { backgroundColor: colors.surfaceHover }, style]}
    >
      {content}
    </Pressable>
  )
}

const useStyles = makeStyles((colors) => ({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    minHeight: touchTarget + 8,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
  },
  iconTile: {
    width: 38,
    height: 38,
    borderRadius: radii.md,
    alignItems: 'center',
    justifyContent: 'center',
  },
  copy: { flex: 1 },
  title: { color: colors.text, fontSize: 15, fontFamily: 'DMSans_500Medium' },
  subtitle: { color: colors.textSecondary, fontSize: 12.5, fontFamily: 'DMSans_400Regular', marginTop: 2 },
}))
