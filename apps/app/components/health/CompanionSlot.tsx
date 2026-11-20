import { Ionicons } from '@expo/vector-icons'
import { StyleSheet, Text, View } from 'react-native'
import { Card } from '@/components/ui/Card'
import { spacing, typography, useTheme } from '@/lib/theme'

/**
 * Reserved place on the My Health home screen for the AI health companion,
 * which is built separately. Replace the body of this component (or render the
 * companion entry point in its place) without touching the screen layout. It
 * renders nothing until `ready` is true, so the slot is invisible today.
 */
export function CompanionSlot({ ready = false }: { ready?: boolean }) {
  const { colors } = useTheme()
  if (!ready) return <View testID="ai-companion-slot" />
  return (
    <Card>
      <View testID="ai-companion-slot" style={styles.row}>
        <Ionicons name="sparkles-outline" size={18} color={colors.primary} />
        <Text style={[styles.text, { color: colors.textSecondary }]}>Your health companion</Text>
      </View>
    </Card>
  )
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  text: { ...typography.bodyMedium },
})
