import { ActivityIndicator, StyleSheet, Text, View } from 'react-native'
import { spacing, typography, makeStyles, useTheme } from '@/lib/theme'

export function LoadingBlock({ message = 'Loading…' }: { message?: string }) {
  const styles = useStyles()
  const { colors } = useTheme()
  return (
    <View style={styles.wrap}>
      <ActivityIndicator color={colors.primary} size="large" />
      <Text style={styles.text}>{message}</Text>
    </View>
  )
}

const useStyles = makeStyles((colors) => ({
  wrap: {
    paddingVertical: spacing.xxxl * 2,
    alignItems: 'center',
    gap: spacing.lg,
  },
  text: {
    ...typography.bodyMedium,
    color: colors.textSecondary,
  },
}))
