import { Image, ImageStyle, StyleProp, StyleSheet, View, ViewStyle } from 'react-native'
import { radii, makeStyles } from '@/lib/theme'

const LOGO = require('../assets/icon.png')

type LogoSize = 'sm' | 'md' | 'lg' | 'xl'

const SIZES: Record<LogoSize, { outer: number; image: number; radius: number; ring: number }> = {
  sm: { outer: 44, image: 36, radius: 12, ring: 1.5 },
  md: { outer: 72, image: 58, radius: 18, ring: 2 },
  lg: { outer: 96, image: 78, radius: 22, ring: 2.5 },
  xl: { outer: 120, image: 98, radius: 28, ring: 3 },
}

interface SynapseLogoProps {
  size?: LogoSize
  showRing?: boolean
  style?: StyleProp<ViewStyle>
  imageStyle?: StyleProp<ImageStyle>
}

/** Brand mark with a visible ring so logo edges stay crisp on dark backgrounds. */
export function SynapseLogo({
  size = 'md',
  showRing = true,
  style,
  imageStyle,
}: SynapseLogoProps) {
  const styles = useStyles()
  const s = SIZES[size]

  return (
    <View
      style={[
        styles.wrap,
        {
          width: s.outer,
          height: s.outer,
          borderRadius: s.radius,
          borderWidth: showRing ? s.ring : 0,
        },
        style,
      ]}
    >
      <View style={[styles.inner, { width: s.image, height: s.image, borderRadius: s.radius - 4 }]}>
        <Image
          source={LOGO}
          style={[styles.image, imageStyle]}
          resizeMode="contain"
          accessibilityLabel="Synapse Health logo"
        />
      </View>
    </View>
  )
}

const useStyles = makeStyles((colors) => ({
  wrap: {
    alignItems: 'center',
    justifyContent: 'center',
    borderColor: colors.teal,
    backgroundColor: colors.bgElevated,
    shadowColor: colors.teal,
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.35,
    shadowRadius: 12,
    elevation: 8,
  },
  inner: {
    overflow: 'hidden',
    backgroundColor: '#0A1628',
  },
  image: {
    width: '100%',
    height: '100%',
  },
}))
