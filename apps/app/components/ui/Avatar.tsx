import { StyleSheet, Text, View } from 'react-native'
import { makeStyles, useTheme } from '@/lib/theme'

interface AvatarProps {
  label: string
  size?: number
  tone?: 'primary' | 'neutral'
}

export function Avatar({ label, size = 48, tone = 'primary' }: AvatarProps) {
  const styles = useStyles()
  const { colors } = useTheme()
  const fontSize = Math.round(size * 0.38)
  return (
    <View
      style={[
        styles.base,
        {
          width: size,
          height: size,
          borderRadius: size / 2,
          backgroundColor: tone === 'primary' ? colors.primary : colors.surface,
          borderColor: tone === 'primary' ? 'rgba(249,115,22,0.4)' : colors.border,
        },
      ]}
    >
      <Text style={[styles.text, { fontSize }]}>{label}</Text>
    </View>
  )
}

const useStyles = makeStyles((colors) => ({
  base: {
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1.5,
  },
  text: {
    color: colors.white,
    fontWeight: '800',
  },
}))
