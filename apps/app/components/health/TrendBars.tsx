import { StyleSheet, Text, View } from 'react-native'
import { spacing, typography, useTheme } from '@/lib/theme'

/** A small seven-day bar chart. Empty days are drawn as a stub, not a zero. */
export function TrendBars({
  points,
  accessibilityLabel,
}: {
  points: Array<{ day: string; value: number | null }>
  accessibilityLabel: string
}) {
  const { colors } = useTheme()
  const peak = Math.max(1, ...points.map((p) => p.value ?? 0))
  return (
    <View accessible accessibilityLabel={accessibilityLabel} style={styles.wrap}>
      {points.map((point) => {
        const weekday = new Date(`${point.day}T12:00:00`).toLocaleDateString('en-GB', { weekday: 'narrow' })
        return (
          <View key={point.day} style={styles.col}>
            <View style={styles.track}>
              <View
                style={[
                  styles.bar,
                  {
                    height: `${point.value ? Math.max(6, (point.value / peak) * 100) : 4}%`,
                    backgroundColor: point.value ? colors.primary : colors.border,
                  },
                ]}
              />
            </View>
            <Text style={[styles.day, { color: colors.textMuted }]}>{weekday}</Text>
          </View>
        )
      })}
    </View>
  )
}

const styles = StyleSheet.create({
  wrap: { flexDirection: 'row', gap: spacing.xs, marginTop: spacing.md },
  col: { flex: 1, alignItems: 'center', gap: 4 },
  track: { height: 48, width: '100%', justifyContent: 'flex-end' },
  bar: { width: '100%', borderRadius: 4 },
  day: { ...typography.caption, fontSize: 10 },
})
