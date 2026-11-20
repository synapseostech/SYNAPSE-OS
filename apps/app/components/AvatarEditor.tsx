import { useCallback, useState, type ReactNode } from 'react'
import { Alert, Modal, Pressable, Text, View } from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { AvatarError, canPickAvatar, pickAvatar, removeAvatar, uploadAvatar, type AvatarSource } from '@/lib/avatar'
import { errorHaptic, successHaptic, tapHaptic } from '@/lib/haptics'
import { makeStyles, radii, spacing, useTheme } from '@/lib/theme'

type Options = {
  token: string | null
  /** Whose photo; omit for the signed-in user. */
  userId?: string
  /** Name shown in the sheet title when editing someone else. */
  personName?: string | null
  hasPhoto: boolean
  onChanged: (avatarUrl: string | null) => void
}

/**
 * Bottom sheet to take, choose or remove a profile photo.
 * Returns `open()`, a `busy` flag for the avatar spinner, and the sheet to render.
 */
export function useAvatarEditor({ token, userId, personName, hasPhoto, onChanged }: Options): {
  open: () => void
  busy: boolean
  sheet: ReactNode
} {
  const [visible, setVisible] = useState(false)
  const [busy, setBusy] = useState(false)

  const open = useCallback(() => {
    if (!canPickAvatar()) {
      Alert.alert('Update needed', 'Install the latest Synapse APK to add profile photos.')
      return
    }
    tapHaptic()
    setVisible(true)
  }, [])

  const run = useCallback(
    async (job: () => Promise<string | null | undefined>) => {
      if (!token) return
      setVisible(false)
      setBusy(true)
      try {
        const url = await job()
        if (url !== undefined) {
          onChanged(url)
          successHaptic()
        }
      } catch (err) {
        errorHaptic()
        const message =
          err instanceof AvatarError || err instanceof Error ? err.message : 'Could not update the photo.'
        Alert.alert('Profile photo', message)
      } finally {
        setBusy(false)
      }
    },
    [token, onChanged],
  )

  const choose = (source: AvatarSource) =>
    run(async () => {
      const uri = await pickAvatar(source)
      if (!uri) return undefined
      return uploadAvatar(token!, uri, userId)
    })

  const remove = () =>
    run(async () => {
      await removeAvatar(token!, userId)
      return null
    })

  const sheet = (
    <AvatarSheet
      visible={visible}
      title={personName ? `Photo for ${personName}` : 'Profile photo'}
      hasPhoto={hasPhoto}
      onClose={() => setVisible(false)}
      onCamera={() => choose('camera')}
      onLibrary={() => choose('library')}
      onRemove={remove}
    />
  )

  return { open, busy, sheet }
}

/** Render-prop form of useAvatarEditor, for use inside lists and headers. */
export function AvatarEditor({
  children,
  ...options
}: Options & { children: (state: { open: () => void; busy: boolean }) => ReactNode }) {
  const { open, busy, sheet } = useAvatarEditor(options)
  return (
    <>
      {children({ open, busy })}
      {sheet}
    </>
  )
}

function AvatarSheet({
  visible,
  title,
  hasPhoto,
  onClose,
  onCamera,
  onLibrary,
  onRemove,
}: {
  visible: boolean
  title: string
  hasPhoto: boolean
  onClose: () => void
  onCamera: () => void
  onLibrary: () => void
  onRemove: () => void
}) {
  const styles = useStyles()
  const { colors } = useTheme()
  const insets = useSafeAreaInsets()
  const Option = ({
    icon,
    label,
    onPress,
    danger,
  }: {
    icon: keyof typeof Ionicons.glyphMap
    label: string
    onPress: () => void
    danger?: boolean
  }) => (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      style={({ pressed }) => [styles.option, pressed && { backgroundColor: colors.surfaceHover }]}
    >
      <View style={[styles.optionIcon, { backgroundColor: danger ? colors.errorBg : colors.primarySoft }]}>
        <Ionicons name={icon} size={20} color={danger ? colors.error : colors.primary} />
      </View>
      <Text style={[styles.optionText, danger && { color: colors.error }]}>{label}</Text>
    </Pressable>
  )
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose} statusBarTranslucent>
      <Pressable style={styles.backdrop} onPress={onClose} accessibilityLabel="Close" />
      <View style={[styles.sheet, { paddingBottom: Math.max(insets.bottom, spacing.lg) }]}>
        <View style={styles.grabber} />
        <Text style={styles.title}>{title}</Text>
        <Text style={styles.hint}>Square photos look best. You can crop after choosing.</Text>
        <Option icon="camera-outline" label="Take photo" onPress={onCamera} />
        <Option icon="images-outline" label="Choose from gallery" onPress={onLibrary} />
        {hasPhoto ? <Option icon="trash-outline" label="Remove photo" onPress={onRemove} danger /> : null}
        <Pressable onPress={onClose} style={styles.cancel} accessibilityRole="button">
          <Text style={styles.cancelText}>Cancel</Text>
        </Pressable>
      </View>
    </Modal>
  )
}

const useStyles = makeStyles((colors) => ({
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)' },
  sheet: {
    backgroundColor: colors.bgElevated,
    borderTopLeftRadius: radii['2xl'],
    borderTopRightRadius: radii['2xl'],
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.sm,
    borderTopWidth: 1,
    borderColor: colors.border,
  },
  grabber: {
    alignSelf: 'center',
    width: 40,
    height: 4,
    borderRadius: 2,
    backgroundColor: colors.borderStrong,
    marginBottom: spacing.lg,
  },
  title: { color: colors.text, fontSize: 18, fontFamily: 'BricolageGrotesque_600SemiBold', paddingHorizontal: spacing.sm },
  hint: {
    color: colors.textSecondary,
    fontSize: 13,
    fontFamily: 'DMSans_400Regular',
    paddingHorizontal: spacing.sm,
    marginTop: 4,
    marginBottom: spacing.md,
  },
  option: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    minHeight: 56,
    paddingHorizontal: spacing.sm,
    borderRadius: radii.lg,
  },
  optionIcon: { width: 40, height: 40, borderRadius: radii.md, alignItems: 'center', justifyContent: 'center' },
  optionText: { color: colors.text, fontSize: 16, fontFamily: 'DMSans_500Medium' },
  cancel: { alignItems: 'center', justifyContent: 'center', minHeight: 52, marginTop: spacing.sm },
  cancelText: { color: colors.textSecondary, fontSize: 15, fontFamily: 'DMSans_700Bold' },
}))
