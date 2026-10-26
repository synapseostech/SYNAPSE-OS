import { Pressable, StyleSheet, Text, View } from 'react-native'
import { radii, spacing, typography, useTheme } from '@/lib/theme'

export type Choice<T extends string> = { value: T; label: string }

interface ChoiceChipsProps<T extends string> {
  options: ReadonlyArray<Choice<T>>
  value: T | null
  onChange: (value: T) => void
  label?: string
}

export function ChoiceChips<T extends string>({ options, value, onChange, label }: ChoiceChipsProps<T>) {
  const { colors } = useTheme()
  return (
    <View style={styles.wrap}>
      {label ? <Text style={[styles.label, { color: colors.textSecondary }]}>{label}</Text> : null}
      <View style={styles.row}>
        {options.map((option) => {
          const selected = option.value === value
          return (
            <Pressable
              key={option.value}
              onPress={() => onChange(option.value)}
              accessibilityRole="button"
              accessibilityState={{ selected }}
              style={[
                styles.chip,
                {
                  backgroundColor: selected ? colors.primarySoft : colors.bgElevated,
                  borderColor: selected ? colors.primary : colors.border,
                },
              ]}
            >
              <Text
                style={[
                  styles.chipLabel,
                  { color: selected ? colors.primary : colors.textSecondary },
                ]}
              >
                {option.label}
              </Text>
            </Pressable>
          )
        })}
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  wrap: { marginBottom: spacing.lg },
  label: {
    ...typography.label,
    marginBottom: spacing.sm,
  },
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  chip: {
    borderRadius: radii.md,
    borderWidth: 1,
    paddingHorizontal: spacing.md,
    paddingVertical: 9,
  },
  chipLabel: {
    ...typography.caption,
    fontFamily: 'DMSans_500Medium',
  },
})
