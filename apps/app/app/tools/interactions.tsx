import { useState } from 'react'
import { Alert, StyleSheet, Text, View } from 'react-native'
import { ScreenShell } from '@/components/ui/ScreenShell'
import { Button } from '@/components/ui/Button'
import { TextField } from '@/components/ui/TextField'
import { useAuth } from '@/lib/auth'
import { apiRequest, ApiError } from '@/lib/api'
import { radii, spacing, typography, TONE_COLORS, makeStyles } from '@/lib/theme'

type Interaction = {
  severity: 'major' | 'moderate' | 'minor'
  drugs: string[]
  description: string
  recommendation: string
}

type CheckResult = {
  available: boolean
  status: string
  safe: boolean
  summary: string
  knowledgeVersion?: string
  interactions: Interaction[]
  explanation?: string | null
}

const SEVERITY: Record<string, string> = {
  get major() { return TONE_COLORS.red },
  get moderate() { return TONE_COLORS.warning },
  get minor() { return TONE_COLORS.green },
}

export default function InteractionsScreen() {
  const styles = useStyles()
  const { token } = useAuth()
  const [a, setA] = useState('')
  const [b, setB] = useState('')
  const [c, setC] = useState('')
  const [loading, setLoading] = useState(false)
  const [explaining, setExplaining] = useState(false)
  const [result, setResult] = useState<CheckResult | null>(null)

  const drugs = () => [a, b, c].map((s) => s.trim()).filter(Boolean)

  const run = async () => {
    if (!token) return
    const list = drugs()
    if (list.length < 2) {
      Alert.alert('Add drugs', 'Enter at least two medicine names.')
      return
    }
    setLoading(true)
    setResult(null)
    try {
      const data = await apiRequest<CheckResult>('/api/mobile/pharmacy/interactions', {
        method: 'POST',
        token,
        body: { drugs: list },
      })
      setResult(data)
    } catch (err) {
      const message =
        err instanceof ApiError
          ? err.message
          : err instanceof Error
            ? err.message
            : 'Check failed'
      setResult({
        available: false,
        status: 'unavailable',
        safe: false,
        summary: message,
        interactions: [],
      })
    } finally {
      setLoading(false)
    }
  }

  const explain = async () => {
    if (!token) return
    const list = drugs()
    if (list.length < 2) return
    setExplaining(true)
    try {
      const data = await apiRequest<CheckResult>('/api/mobile/pharmacy/interactions/explain', {
        method: 'POST',
        token,
        body: { drugs: list },
      })
      setResult((prev) => ({
        ...(prev ?? data),
        ...data,
        interactions: data.interactions?.length ? data.interactions : prev?.interactions ?? [],
      }))
    } catch (err) {
      const message =
        err instanceof ApiError
          ? err.message
          : err instanceof Error
            ? err.message
            : 'Explainer unavailable'
      Alert.alert('Explainer', message)
    } finally {
      setExplaining(false)
    }
  }

  return (
    <ScreenShell title="Interactions">
      <Text style={styles.lead}>
        Curated pack only. No match means unavailable — not safe. Explainer only narrates pack
        hits.
      </Text>

      <TextField label="Medicine 1" value={a} onChangeText={setA} placeholder="e.g. Warfarin" />
      <TextField label="Medicine 2" value={b} onChangeText={setB} placeholder="e.g. Aspirin" />
      <TextField
        label="Medicine 3 (optional)"
        value={c}
        onChangeText={setC}
        placeholder="Optional"
      />

      <Button label="Check pack" onPress={run} loading={loading} />

      {result ? (
        <View style={styles.resultBlock}>
          <View
            style={[
              styles.banner,
              {
                borderColor: result.available ? TONE_COLORS.red : TONE_COLORS.warning,
                backgroundColor: result.available
                  ? `${TONE_COLORS.red}14`
                  : `${TONE_COLORS.warning}14`,
              },
            ]}
          >
            <Text
              style={[
                styles.bannerTitle,
                { color: result.available ? TONE_COLORS.red : TONE_COLORS.warning },
              ]}
            >
              {result.available
                ? 'Interactions found — review required'
                : 'Unavailable — not cleared'}
            </Text>
            <Text style={styles.bannerBody}>{result.summary}</Text>
            {result.knowledgeVersion ? (
              <Text style={styles.pack}>Pack {result.knowledgeVersion}</Text>
            ) : null}
          </View>

          {result.interactions.map((item, idx) => (
            <View key={idx} style={styles.card}>
              <Text style={[styles.severity, { color: SEVERITY[item.severity] }]}>
                {item.severity.toUpperCase()}
              </Text>
              <Text style={styles.drugs}>{item.drugs.join(' + ')}</Text>
              <Text style={styles.desc}>{item.description}</Text>
              <Text style={styles.rec}>{item.recommendation}</Text>
            </View>
          ))}

          {result.available && result.interactions.length > 0 ? (
            <Button
              label="Explain pack hits"
              onPress={explain}
              loading={explaining}
              variant="ghost"
            />
          ) : null}

          {result.explanation ? (
            <View style={styles.explainCard}>
              <Text style={styles.explainLabel}>Counselling narration</Text>
              <Text style={styles.explainBody}>{result.explanation}</Text>
            </View>
          ) : null}
        </View>
      ) : null}
    </ScreenShell>
  )
}

const useStyles = makeStyles((colors) => ({
  lead: {
    ...typography.bodySm,
    color: colors.textSecondary,
    fontFamily: 'DMSans_400Regular',
    marginBottom: spacing.lg,
    lineHeight: 20,
  },
  resultBlock: { marginTop: spacing.xl, gap: spacing.md },
  banner: {
    borderWidth: 1,
    borderRadius: radii.lg,
    padding: spacing.lg,
  },
  bannerTitle: {
    ...typography.bodyMedium,
    fontFamily: 'DMSans_700Bold',
  },
  bannerBody: {
    ...typography.bodySm,
    color: colors.textSecondary,
    fontFamily: 'DMSans_400Regular',
    marginTop: spacing.xs,
  },
  pack: {
    ...typography.caption,
    color: colors.textMuted,
    fontFamily: 'DMSans_400Regular',
    marginTop: spacing.sm,
  },
  card: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.lg,
    padding: spacing.lg,
    backgroundColor: colors.surface,
  },
  severity: {
    fontSize: 11,
    fontFamily: 'DMSans_700Bold',
    marginBottom: 4,
  },
  drugs: {
    ...typography.bodyMedium,
    color: colors.text,
    fontFamily: 'DMSans_700Bold',
  },
  desc: {
    ...typography.bodySm,
    color: colors.textSecondary,
    fontFamily: 'DMSans_400Regular',
    marginTop: spacing.sm,
  },
  rec: {
    ...typography.caption,
    color: colors.primary,
    fontFamily: 'DMSans_500Medium',
    marginTop: spacing.sm,
  },
  explainCard: {
    borderWidth: 1,
    borderColor: `${colors.primary}44`,
    borderRadius: radii.lg,
    padding: spacing.lg,
    backgroundColor: `${colors.primary}12`,
  },
  explainLabel: {
    ...typography.caption,
    color: colors.primary,
    fontFamily: 'DMSans_700Bold',
    marginBottom: spacing.sm,
  },
  explainBody: {
    ...typography.bodySm,
    color: colors.text,
    fontFamily: 'DMSans_400Regular',
    lineHeight: 20,
  },
}))
