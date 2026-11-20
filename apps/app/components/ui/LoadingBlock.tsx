import { Text, View } from 'react-native'
import { makeStyles, spacing, typography } from '@/lib/theme'
import { SkeletonList } from './Skeleton'

/**
 * Loading placeholder for a screen or list. Shows skeleton rows shaped like
 * the content instead of a spinner, so the layout does not jump when data
 * arrives. `message` is kept for screen readers and as a quiet caption.
 */
export function LoadingBlock({
  message = 'Loading…',
  rows = 5,
  avatar = false,
}: {
  message?: string
  rows?: number
  avatar?: boolean
}) {
  const styles = useStyles()
  return (
    <View style={styles.wrap} accessibilityLabel={message} accessibilityRole="progressbar">
      <Text style={styles.text}>{message}</Text>
      <SkeletonList rows={rows} avatar={avatar} />
    </View>
  )
}

const useStyles = makeStyles((colors) => ({
  wrap: { paddingVertical: spacing.md, gap: spacing.sm },
  text: {
    ...typography.caption,
    color: colors.textSecondary,
    fontFamily: 'DMSans_500Medium',
  },
}))
