import { Text, View } from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import { radii, spacing, typography, makeStyles, useTheme } from '@/lib/theme'
import { Button } from './Button'

type EmptyIcon =
  | 'inbox'
  | 'search'
  | 'calendar'
  | 'medkit'
  | 'document'
  | 'cube'
  | 'checkmark-circle'
  | 'flask'
  | 'receipt'
  | 'cash'
  | 'refresh'
  | 'business'
  | 'people'
  | 'cloud-offline'
  | 'alert'

interface EmptyStateProps {
  title: string
  body: string
  icon?: EmptyIcon
  /** Optional next step, e.g. "Add product" or "Clear search". */
  actionLabel?: string
  onAction?: () => void
  tone?: 'neutral' | 'danger'
}

const ICON_MAP: Record<EmptyIcon, keyof typeof Ionicons.glyphMap> = {
  inbox: 'file-tray-outline',
  search: 'search-outline',
  calendar: 'calendar-outline',
  medkit: 'medkit-outline',
  document: 'document-text-outline',
  cube: 'cube-outline',
  'checkmark-circle': 'checkmark-circle-outline',
  flask: 'flask-outline',
  receipt: 'receipt-outline',
  cash: 'cash-outline',
  refresh: 'refresh-outline',
  business: 'briefcase-outline',
  people: 'people-outline',
  'cloud-offline': 'cloud-offline-outline',
  alert: 'alert-circle-outline',
}

export function EmptyState({ title, body, icon = 'inbox', actionLabel, onAction, tone = 'neutral' }: EmptyStateProps) {
  const styles = useStyles()
  const { colors } = useTheme()
  const danger = tone === 'danger'
  return (
    <View style={styles.wrap} accessibilityRole={danger ? 'alert' : undefined}>
      <View
        style={[
          styles.iconRing,
          danger && { backgroundColor: colors.errorBg, borderColor: colors.errorBorder },
        ]}
      >
        <Ionicons name={ICON_MAP[icon]} size={26} color={danger ? colors.error : colors.primary} />
      </View>
      <Text style={styles.title}>{title}</Text>
      <Text style={styles.body}>{body}</Text>
      {actionLabel && onAction ? (
        <Button
          label={actionLabel}
          onPress={onAction}
          variant={danger ? 'secondary' : 'primary'}
          size="md"
          style={styles.action}
        />
      ) : null}
    </View>
  )
}

/** A load failed: say what happened and offer the retry right there. */
export function ErrorState({
  message,
  onRetry,
  title = 'Could not load this',
}: {
  message: string
  onRetry?: () => void
  title?: string
}) {
  const offline = /network|connection|timed? ?out|offline|fetch/i.test(message)
  return (
    <EmptyState
      tone="danger"
      icon={offline ? 'cloud-offline' : 'alert'}
      title={offline ? 'You appear to be offline' : title}
      body={offline ? 'Check the connection and try again. Anything saved on this phone is safe.' : message}
      actionLabel={onRetry ? 'Try again' : undefined}
      onAction={onRetry}
    />
  )
}

const useStyles = makeStyles((colors) => ({
  wrap: {
    alignItems: 'center',
    paddingTop: spacing.xxxl,
    paddingHorizontal: spacing.xl,
    paddingBottom: spacing.xl,
  },
  iconRing: {
    width: 64,
    height: 64,
    borderRadius: radii.full,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.primarySoft,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: spacing.lg,
  },
  title: {
    ...typography.h3,
    color: colors.text,
    marginBottom: spacing.sm,
    textAlign: 'center',
  },
  body: {
    ...typography.bodySm,
    color: colors.textSecondary,
    fontFamily: 'DMSans_400Regular',
    textAlign: 'center',
    lineHeight: 20,
    maxWidth: 300,
  },
  action: { marginTop: spacing.xl, minWidth: 180 },
}))
