import * as Clipboard from 'expo-clipboard'
import { ReactNode } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import { radii, spacing, typography, makeStyles } from '@/lib/theme'

// ─── DetailRow ───────────────────────────────────────────────────────────────

interface DetailRowProps {
  label: string
  value: string | null | undefined
  highlight?: boolean
  mono?: boolean
  copyable?: boolean
}

export function DetailRow({
  label,
  value,
  highlight = false,
  mono = false,
  copyable = false,
}: DetailRowProps) {
  const styles = useStyles()
  if (value === null || value === undefined) return null

  async function handleLongPress() {
    if (copyable) {
      await Clipboard.setStringAsync(value as string)
    }
  }

  const valueStyle = [
    styles.value,
    highlight && styles.valueHighlight,
    mono && styles.valueMono,
  ]

  return (
    <Pressable
      onLongPress={copyable ? handleLongPress : undefined}
      delayLongPress={400}
      style={({ pressed }) => [styles.row, copyable && pressed && styles.rowPressed]}
    >
      <Text style={styles.label}>{label}</Text>
      <Text style={valueStyle}>{value}</Text>
    </Pressable>
  )
}

// ─── DetailSection ───────────────────────────────────────────────────────────

interface DetailSectionProps {
  title: string
  children: ReactNode
}

export function DetailSection({ title, children }: DetailSectionProps) {
  const styles = useStyles()
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>{title}</Text>
      <View style={styles.card}>{children}</View>
    </View>
  )
}

// ─── Styles ──────────────────────────────────────────────────────────────────

const useStyles = makeStyles((colors) => ({
  // DetailRow
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.lg,
    borderBottomWidth: 1,
    borderBottomColor: colors.borderSubtle,
  },
  rowPressed: {
    backgroundColor: colors.surfaceHover,
  },
  label: {
    ...typography.bodySm,
    color: colors.textSecondary,
    fontFamily: 'DMSans_400Regular',
    flex: 1,
  },
  value: {
    ...typography.bodyMedium,
    color: colors.text,
    fontFamily: 'DMSans_500Medium',
    flexShrink: 1,
    textAlign: 'right',
    marginLeft: spacing.md,
  },
  valueHighlight: {
    color: colors.warning,
  },
  valueMono: {
    ...typography.mono,
    fontFamily: 'monospace',
    color: colors.text,
  },

  // DetailSection
  section: {
    marginBottom: spacing.xxl,
  },
  sectionTitle: {
    ...typography.label,
    color: colors.textSecondary,
    fontFamily: 'DMSans_500Medium',
    marginBottom: spacing.md,
  },
  card: {
    backgroundColor: colors.surface,
    borderRadius: radii.lg,
    borderWidth: 1,
    borderColor: colors.border,
    overflow: 'hidden',
  },
}))
