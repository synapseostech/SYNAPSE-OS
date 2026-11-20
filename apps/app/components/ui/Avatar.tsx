import { useState } from 'react'
import { ActivityIndicator, Pressable, Text, View, type StyleProp, type ViewStyle } from 'react-native'
import { Image } from 'expo-image'
import { Ionicons } from '@expo/vector-icons'
import { useTheme } from '@/lib/theme'

interface AvatarProps {
  /** Full name; the avatar shows up to two initials and picks a stable colour from it. */
  name?: string | null
  /** Pre-computed label (legacy). Used when no name is given. */
  label?: string
  /** Profile picture URL. Falls back to initials when absent or it fails to load. */
  uri?: string | null
  size?: number
  tone?: 'primary' | 'neutral' | 'auto'
  /** Shows a small camera badge, for the user's own avatar. */
  editable?: boolean
  loading?: boolean
  /** Small green/grey dot (e.g. active staff). */
  status?: 'active' | 'inactive'
  onPress?: () => void
  accessibilityLabel?: string
  style?: StyleProp<ViewStyle>
}

/** Warm, legible hues that sit on both the dark and light palettes. */
const HUES = ['#F97316', '#1FA6A6', '#E8B84B', '#4C9DFF', '#3DD68C', '#C084FC', '#F2555A', '#FB7E3C']

export function initialsFor(name: string | null | undefined): string {
  const parts = (name ?? '').trim().split(/[\s@._-]+/).filter(Boolean)
  if (parts.length === 0) return '?'
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase()
  return (parts[0]![0]! + parts[parts.length - 1]![0]!).toUpperCase()
}

function hueFor(seed: string): string {
  let h = 0
  for (let i = 0; i < seed.length; i += 1) h = (h * 31 + seed.charCodeAt(i)) >>> 0
  return HUES[h % HUES.length]!
}

export function Avatar({
  name,
  label,
  uri,
  size = 48,
  tone = 'auto',
  editable = false,
  loading = false,
  status,
  onPress,
  accessibilityLabel,
  style,
}: AvatarProps) {
  const { colors } = useTheme()
  const [failed, setFailed] = useState<string | null>(null)
  const text = name ? initialsFor(name) : (label ?? '?')
  const showImage = Boolean(uri) && failed !== uri
  const hue =
    tone === 'primary' ? colors.primary : tone === 'neutral' ? colors.textSecondary : hueFor(name ?? label ?? '?')
  const radius = size / 2
  const badge = Math.max(18, Math.round(size * 0.32))

  const body = (
    <View style={[{ width: size, height: size }, style]}>
      <View
        style={{
          width: size,
          height: size,
          borderRadius: radius,
          overflow: 'hidden',
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: `${hue}26`,
          borderWidth: 1.5,
          borderColor: `${hue}66`,
        }}
      >
        {showImage ? (
          <Image
            source={{ uri: uri! }}
            style={{ width: size, height: size }}
            contentFit="cover"
            transition={180}
            cachePolicy="memory-disk"
            onError={() => setFailed(uri ?? null)}
            accessibilityIgnoresInvertColors
          />
        ) : (
          <Text
            style={{
              color: hue,
              fontSize: Math.round(size * (text.length > 1 ? 0.36 : 0.42)),
              fontFamily: 'DMSans_700Bold',
              letterSpacing: 0.5,
            }}
          >
            {text}
          </Text>
        )}
        {loading ? (
          <View
            style={{
              position: 'absolute',
              top: 0,
              left: 0,
              right: 0,
              bottom: 0,
              alignItems: 'center',
              justifyContent: 'center',
              backgroundColor: 'rgba(7,7,10,0.55)',
            }}
          >
            <ActivityIndicator color="#FFFFFF" />
          </View>
        ) : null}
      </View>
      {editable ? (
        <View
          style={{
            position: 'absolute',
            right: -2,
            bottom: -2,
            width: badge,
            height: badge,
            borderRadius: badge / 2,
            backgroundColor: colors.primary,
            borderWidth: 2,
            borderColor: colors.bg,
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <Ionicons name="camera" size={Math.round(badge * 0.55)} color={colors.primaryForeground} />
        </View>
      ) : status ? (
        <View
          style={{
            position: 'absolute',
            right: 0,
            bottom: 0,
            width: Math.max(10, size * 0.24),
            height: Math.max(10, size * 0.24),
            borderRadius: size,
            backgroundColor: status === 'active' ? colors.success : colors.textMuted,
            borderWidth: 2,
            borderColor: colors.surface,
          }}
        />
      ) : null}
    </View>
  )

  if (!onPress) return body
  return (
    <Pressable
      onPress={onPress}
      hitSlop={8}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? (editable ? 'Change profile photo' : name ?? 'Avatar')}
      style={({ pressed }) => [pressed && { opacity: 0.8 }]}
    >
      {body}
    </Pressable>
  )
}
