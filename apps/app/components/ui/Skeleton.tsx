import { useEffect, useRef } from 'react'
import { Animated, Easing, View, type DimensionValue, type StyleProp, type ViewStyle } from 'react-native'
import { makeStyles, radii, spacing, useTheme } from '@/lib/theme'

/** One shared pulse keeps every placeholder on screen in step. */
let sharedPulse: Animated.Value | null = null
let users = 0
let loop: Animated.CompositeAnimation | null = null

function usePulse() {
  if (!sharedPulse) sharedPulse = new Animated.Value(0)
  const pulse = sharedPulse
  useEffect(() => {
    users += 1
    if (users === 1) {
      loop = Animated.loop(
        Animated.sequence([
          Animated.timing(pulse, { toValue: 1, duration: 750, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
          Animated.timing(pulse, { toValue: 0, duration: 750, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
        ]),
      )
      loop.start()
    }
    return () => {
      users -= 1
      if (users === 0) loop?.stop()
    }
  }, [pulse])
  return pulse
}

type SkeletonProps = {
  width?: DimensionValue
  height?: number
  radius?: number
  style?: StyleProp<ViewStyle>
}

/** Placeholder block shaped like the content that is loading. */
export function Skeleton({ width = '100%', height = 14, radius = radii.sm, style }: SkeletonProps) {
  const { colors } = useTheme()
  const pulse = usePulse()
  const opacity = pulse.interpolate({ inputRange: [0, 1], outputRange: [0.45, 0.9] })
  return (
    <Animated.View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={[{ width, height, borderRadius: radius, backgroundColor: colors.surfaceHover, opacity }, style]}
    />
  )
}

/** A list row: leading circle, two text lines and a trailing value. */
export function SkeletonRow({ avatar = false }: { avatar?: boolean }) {
  const styles = useStyles()
  return (
    <View style={styles.row}>
      {avatar ? <Skeleton width={40} height={40} radius={20} /> : null}
      <View style={styles.rowCopy}>
        <Skeleton width="62%" height={14} />
        <Skeleton width="38%" height={11} />
      </View>
      <Skeleton width={56} height={14} />
    </View>
  )
}

export function SkeletonList({ rows = 6, avatar = false }: { rows?: number; avatar?: boolean }) {
  const styles = useStyles()
  return (
    <View style={styles.list} accessibilityLabel="Loading" accessibilityRole="progressbar">
      {Array.from({ length: rows }, (_, i) => (
        <SkeletonRow key={i} avatar={avatar} />
      ))}
    </View>
  )
}

/** Two-by-two stat tiles, as on the home screen. */
export function SkeletonStats({ count = 4 }: { count?: number }) {
  const styles = useStyles()
  return (
    <View style={styles.stats}>
      {Array.from({ length: count }, (_, i) => (
        <View key={i} style={styles.statWrap}>
          <View style={styles.stat}>
            <Skeleton width="55%" height={22} />
            <Skeleton width="75%" height={11} />
          </View>
        </View>
      ))}
    </View>
  )
}

const useStyles = makeStyles((colors) => ({
  list: { gap: spacing.sm, paddingTop: spacing.sm },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    padding: spacing.lg,
    borderRadius: radii.lg,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  rowCopy: { flex: 1, gap: spacing.sm },
  stats: { flexDirection: 'row', flexWrap: 'wrap', marginHorizontal: -5 },
  statWrap: { width: '50%', paddingHorizontal: 5, paddingBottom: 10 },
  stat: {
    gap: spacing.md,
    padding: spacing.lg,
    minHeight: 92,
    borderRadius: radii.lg,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
}))
