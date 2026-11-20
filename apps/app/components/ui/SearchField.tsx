import { forwardRef, type ComponentRef } from 'react'
import { Pressable, TextInput, View, type StyleProp, type TextInputProps, type ViewStyle } from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import { makeStyles, radii, spacing, touchTarget, useTheme } from '@/lib/theme'

type Props = Omit<TextInputProps, 'style' | 'onChangeText' | 'value'> & {
  value: string
  onChangeText: (text: string) => void
  /** Optional trailing action, e.g. a barcode scanner. */
  trailingIcon?: keyof typeof Ionicons.glyphMap
  onTrailingPress?: () => void
  trailingLabel?: string
  style?: StyleProp<ViewStyle>
}

/** Rounded search input with a clear button and an optional trailing action. */
export const SearchField = forwardRef<ComponentRef<typeof TextInput>, Props>(function SearchField(
  { value, onChangeText, trailingIcon, onTrailingPress, trailingLabel, style, placeholder = 'Search', ...rest },
  ref,
) {
  const styles = useStyles()
  const { colors } = useTheme()
  return (
    <View style={[styles.wrap, style]}>
      <Ionicons name="search" size={18} color={colors.textSecondary} />
      <TextInput
        ref={ref}
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={colors.textSecondary}
        style={styles.input}
        returnKeyType="search"
        autoCorrect={false}
        autoCapitalize="none"
        clearButtonMode="never"
        accessibilityLabel={placeholder}
        {...rest}
      />
      {value ? (
        <Pressable
          onPress={() => onChangeText('')}
          hitSlop={10}
          accessibilityRole="button"
          accessibilityLabel="Clear search"
          style={styles.iconBtn}
        >
          <Ionicons name="close-circle" size={18} color={colors.textSecondary} />
        </Pressable>
      ) : null}
      {trailingIcon && onTrailingPress ? (
        <Pressable
          onPress={onTrailingPress}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel={trailingLabel ?? 'Search action'}
          style={[styles.iconBtn, styles.trailing]}
        >
          <Ionicons name={trailingIcon} size={20} color={colors.primary} />
        </Pressable>
      ) : null}
    </View>
  )
})

const useStyles = makeStyles((colors) => ({
  wrap: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    minHeight: touchTarget,
    paddingLeft: spacing.md,
    paddingRight: spacing.xs,
    borderRadius: radii.lg,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  input: {
    flex: 1,
    color: colors.text,
    fontSize: 15,
    fontFamily: 'DMSans_400Regular',
    paddingVertical: spacing.sm,
  },
  iconBtn: { padding: spacing.sm },
  trailing: {
    borderLeftWidth: 1,
    borderLeftColor: colors.border,
    paddingLeft: spacing.md,
  },
}))
