import { Pressable, StyleSheet, Text, View } from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import { useRouter } from 'expo-router'
import { ScreenShell } from '@/components/ui/ScreenShell'
import { radii, spacing, typography, makeStyles, useTheme } from '@/lib/theme'
import { CALCULATOR_PACK_VERSION } from '@/lib/calculators'

const TOOLS = [
  {
    key: 'calculators',
    title: 'Medical calculators',
    body: 'BMI, CrCl, eGFR, weight-based dose, drip rate — deterministic formulas.',
    icon: 'calculator-outline' as const,
    href: '/tools/calculators',
  },
  {
    key: 'interactions',
    title: 'Interaction check',
    body: 'Curated pack first. Explainer narrates hits only — never clears.',
    icon: 'shield-checkmark-outline' as const,
    href: '/tools/interactions',
  },
  {
    key: 'pos',
    title: 'New sale (POS)',
    body: 'Checkout with live stock deduction.',
    icon: 'cart-outline' as const,
    href: '/pos',
  },
]

export default function ToolsHubScreen() {
  const styles = useStyles()
  const { colors } = useTheme()
  const router = useRouter()

  return (
    <ScreenShell title="Pharmacy tools">
      <Text style={styles.subtitle}>
        Clinical helpers for counter work. Calculators are formula-based (
        {CALCULATOR_PACK_VERSION}). Safety checks fail closed.
      </Text>

      <View style={styles.list}>
        {TOOLS.map((tool) => (
          <Pressable
            key={tool.key}
            style={({ pressed }) => [styles.card, pressed && styles.pressed]}
            onPress={() => router.push(tool.href as never)}
          >
            <View style={styles.iconWrap}>
              <Ionicons name={tool.icon} size={22} color={colors.primary} />
            </View>
            <View style={styles.copy}>
              <Text style={styles.cardTitle}>{tool.title}</Text>
              <Text style={styles.cardBody}>{tool.body}</Text>
            </View>
            <Ionicons name="chevron-forward" size={18} color={colors.textMuted} />
          </Pressable>
        ))}
      </View>
    </ScreenShell>
  )
}

const useStyles = makeStyles((colors) => ({
  subtitle: {
    ...typography.bodySm,
    color: colors.textSecondary,
    fontFamily: 'DMSans_400Regular',
    marginBottom: spacing.xl,
    lineHeight: 20,
  },
  list: { gap: spacing.sm },
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    padding: spacing.lg,
    borderRadius: radii.lg,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  pressed: { backgroundColor: colors.surfaceHover },
  iconWrap: {
    width: 40,
    height: 40,
    borderRadius: radii.md,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: `${colors.primary}18`,
  },
  copy: { flex: 1, minWidth: 0 },
  cardTitle: {
    ...typography.bodyMedium,
    color: colors.text,
    fontFamily: 'DMSans_700Bold',
  },
  cardBody: {
    ...typography.caption,
    color: colors.textMuted,
    fontFamily: 'DMSans_400Regular',
    marginTop: 2,
  },
}))
