/**
 * The in-app update prompt.
 *
 * - A required APK update covers the app: the installed version is older than
 *   the server still supports, so continuing could fail against the API.
 * - An optional APK update and a downloaded over-the-air update show as a
 *   banner the user can act on or dismiss.
 */
import { Pressable, StyleSheet, Text, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useAppUpdates } from '@/lib/use-app-updates'
import { fonts, useTheme } from '@/lib/theme'

export function UpdatePrompt() {
  const { apk, restartReady, installApk, dismissApk, restartNow } = useAppUpdates()
  const { colors } = useTheme()
  const insets = useSafeAreaInsets()

  if (apk.kind === 'required') {
    return (
      <View style={[styles.cover, { backgroundColor: colors.bg, paddingTop: insets.top + 48 }]}>
        <Text style={[styles.coverTitle, { color: colors.text }]}>Update Synapse to continue</Text>
        <Text style={[styles.body, { color: colors.textSecondary }]}>
          Version {apk.version} is required. This version is no longer supported. Your data on this device
          stays where it is.
        </Text>
        {apk.notes ? <Text style={[styles.body, { color: colors.textSecondary }]}>{apk.notes}</Text> : null}
        <Pressable
          accessibilityRole="button"
          onPress={installApk}
          style={({ pressed }) => [styles.primary, { backgroundColor: colors.primary, opacity: pressed ? 0.85 : 1 }]}
        >
          <Text style={[styles.primaryText, { color: colors.primaryForeground }]}>Download update</Text>
        </Pressable>
        <Text style={[styles.hint, { color: colors.textSecondary }]}>
          When the download finishes, open it and tap Install. Android may ask you to allow installs from this
          source once.
        </Text>
      </View>
    )
  }

  const banner =
    apk.kind === 'optional'
      ? {
          title: `Synapse ${apk.version} is available`,
          body: apk.notes ?? 'Tap Update to download it. Your data stays on this device.',
          action: 'Update',
          onPress: installApk,
          onDismiss: dismissApk,
        }
      : restartReady
        ? {
            title: 'An update is ready',
            body: 'Restart Synapse to start using it.',
            action: 'Restart',
            onPress: restartNow,
            onDismiss: undefined,
          }
        : null
  if (!banner) return null

  return (
    <View
      pointerEvents="box-none"
      style={[styles.bannerWrap, { bottom: insets.bottom + 72 }]}
      accessibilityLiveRegion="polite"
    >
      <View style={[styles.banner, { backgroundColor: colors.bgElevated, borderColor: colors.borderStrong }]}>
        <View style={styles.bannerText}>
          <Text style={[styles.bannerTitle, { color: colors.text }]}>{banner.title}</Text>
          <Text style={[styles.hint, { color: colors.textSecondary }]} numberOfLines={2}>
            {banner.body}
          </Text>
        </View>
        <Pressable
          accessibilityRole="button"
          onPress={banner.onPress}
          style={({ pressed }) => [styles.action, { backgroundColor: colors.primary, opacity: pressed ? 0.85 : 1 }]}
        >
          <Text style={[styles.actionText, { color: colors.primaryForeground }]}>{banner.action}</Text>
        </Pressable>
        {banner.onDismiss ? (
          <Pressable accessibilityRole="button" accessibilityLabel="Not now" onPress={banner.onDismiss} hitSlop={12}>
            <Text style={[styles.dismiss, { color: colors.textSecondary }]}>✕</Text>
          </Pressable>
        ) : null}
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  cover: { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, paddingHorizontal: 24, gap: 16, zIndex: 100 },
  coverTitle: { fontFamily: fonts.heading, fontSize: 24, lineHeight: 30 },
  body: { fontFamily: fonts.body, fontSize: 16, lineHeight: 24 },
  hint: { fontFamily: fonts.body, fontSize: 13, lineHeight: 18 },
  primary: { borderRadius: 12, paddingVertical: 14, alignItems: 'center', marginTop: 8 },
  primaryText: { fontFamily: fonts.bodyBold, fontSize: 16 },
  bannerWrap: { position: 'absolute', left: 12, right: 12, zIndex: 50 },
  banner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    borderWidth: 1,
    borderRadius: 14,
    paddingVertical: 12,
    paddingHorizontal: 14,
  },
  bannerText: { flex: 1, gap: 2 },
  bannerTitle: { fontFamily: fonts.bodyBold, fontSize: 15 },
  action: { borderRadius: 10, paddingVertical: 8, paddingHorizontal: 14 },
  actionText: { fontFamily: fonts.bodyBold, fontSize: 14 },
  dismiss: { fontSize: 16, paddingHorizontal: 4 },
})
