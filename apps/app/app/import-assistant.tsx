import { useCallback, useState } from 'react'
import { Linking, StyleSheet, Text, View } from 'react-native'
import { useFocusEffect, useRouter } from 'expo-router'
import { ScreenShell } from '@/components/ui/ScreenShell'
import { Button } from '@/components/ui/Button'
import { Card, SectionHeader } from '@/components/ui/Card'
import { EmptyState } from '@/components/ui/EmptyState'
import { LoadingBlock } from '@/components/ui/LoadingBlock'
import { useAuth } from '@/lib/auth'
import { ApiError, apiRequest } from '@/lib/api'
import { spacing, typography, useTheme, type ThemeColors } from '@/lib/theme'

const WEB_ASSISTANT = 'https://pharm.synapseos.tech/portal/import-assistant'

interface ImportSession {
  id: string
  sourceSystem: string | null
  fileName: string | null
  status: string | null
  totalRows: number
  matchedRows: number
  flaggedRows: number
  summary: string | null
  errorMessage: string | null
  createdAt: string | null
  completedAt: string | null
}

const STATUS_LABELS: Record<string, string> = {
  pending: 'Queued',
  mapping: 'Mapping columns',
  review: 'Needs review',
  importing: 'Importing',
  complete: 'Complete',
  failed: 'Failed',
}

function statusColor(status: string | null, colors: ThemeColors): string {
  switch (status) {
    case 'complete':
      return colors.success
    case 'failed':
      return colors.error
    case 'importing':
      return colors.info
    case 'pending':
    case 'mapping':
    case 'review':
      return colors.warning
    default:
      return colors.textMuted
  }
}

export default function ImportAssistantScreen() {
  const { token } = useAuth()
  const { colors } = useTheme()
  const router = useRouter()
  const [sessions, setSessions] = useState<ImportSession[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    if (!token) {
      setLoading(false)
      return
    }
    setLoading(true)
    setError(null)
    try {
      const result = await apiRequest<{ sessions: ImportSession[] }>(
        '/api/mobile/pharmacy/imports',
        { token },
      )
      setSessions(result.sessions)
    } catch (err) {
      setSessions([])
      setError(
        err instanceof ApiError && err.status === 403
          ? 'Your role does not include inventory write permission.'
          : 'Could not load import history.',
      )
    } finally {
      setLoading(false)
    }
  }, [token])

  useFocusEffect(
    useCallback(() => {
      void load()
    }, [load]),
  )

  return (
    <ScreenShell title="Import assistant" contentStyle={styles.content}>
      <Card style={styles.intro}>
        <Text style={[styles.introTitle, { color: colors.text }]}>
          Bring your old stock list in
        </Text>
        <Text style={[styles.introBody, { color: colors.textSecondary }]}>
          Import a CSV or Excel file of products and quantities straight from this phone. For a
          full migration from another pharmacy system, the web assistant maps their columns, flags
          rows it is unsure about, and applies the batch atomically.
        </Text>
      </Card>

      <Button label="Import a stock file" onPress={() => router.push('/stock-import' as never)} />
      <Button
        label="Import a Tally cut-over"
        variant="ghost"
        onPress={() => router.push('/tally-import' as never)}
      />
      <Button
        label="Open the web import assistant"
        variant="ghost"
        onPress={() => {
          Linking.openURL(WEB_ASSISTANT).catch(() => {})
        }}
      />

      <SectionHeader title="Recent imports" style={styles.spacer} />

      {loading ? (
        <LoadingBlock message="Loading import history…" />
      ) : error ? (
        <Card>
          <Text style={[styles.message, { color: colors.textSecondary }]}>{error}</Text>
        </Card>
      ) : sessions.length === 0 ? (
        <EmptyState
          icon="cube"
          title="No imports yet"
          body="Imports you start here or in the web assistant show up in this list with their row counts."
        />
      ) : (
        <View style={styles.list}>
          {sessions.map((session) => {
            const status = session.status ?? ''
            return (
              <Card key={session.id}>
                <View style={styles.rowTop}>
                  <Text style={[styles.fileName, { color: colors.text }]} numberOfLines={1}>
                    {session.fileName ?? 'Stock import'}
                  </Text>
                  <Text style={[styles.status, { color: statusColor(session.status, colors) }]}>
                    {STATUS_LABELS[status] ?? status ?? 'Unknown'}
                  </Text>
                </View>
                <Text style={[styles.meta, { color: colors.textMuted }]}>
                  {session.sourceSystem ? `${session.sourceSystem} · ` : ''}
                  {session.createdAt ? session.createdAt.slice(0, 10) : 'No date'}
                </Text>
                <Text style={[styles.counts, { color: colors.textSecondary }]}>
                  {session.matchedRows} of {session.totalRows} rows matched
                  {session.flaggedRows > 0 ? ` · ${session.flaggedRows} flagged` : ''}
                </Text>
                {session.summary ? (
                  <Text style={[styles.summary, { color: colors.textSecondary }]}>
                    {session.summary}
                  </Text>
                ) : null}
                {session.errorMessage ? (
                  <Text style={[styles.summary, { color: colors.error }]}>{session.errorMessage}</Text>
                ) : null}
                {session.sourceSystem?.toLowerCase() === 'tally' ? (
                  <Button
                    label={session.status === 'complete' ? 'View cut-over' : 'Continue cut-over'}
                    variant="ghost"
                    style={styles.sessionAction}
                    onPress={() =>
                      router.push({ pathname: '/tally-import', params: { id: session.id } } as never)
                    }
                  />
                ) : null}
              </Card>
            )
          })}
        </View>
      )}
    </ScreenShell>
  )
}

const styles = StyleSheet.create({
  content: { gap: spacing.md },
  intro: { gap: spacing.sm },
  introTitle: { ...typography.h4, fontFamily: 'DMSans_700Bold' },
  introBody: { ...typography.bodySm, lineHeight: 21 },
  spacer: { marginTop: spacing.sm },
  list: { gap: spacing.sm },
  rowTop: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: spacing.sm },
  fileName: { ...typography.bodyMedium, fontFamily: 'DMSans_500Medium', flex: 1 },
  status: { ...typography.caption, fontFamily: 'DMSans_700Bold' },
  meta: { ...typography.caption, marginTop: 2 },
  counts: { ...typography.caption, fontFamily: 'IBMPlexMono_400Regular', marginTop: spacing.xs },
  summary: { ...typography.bodySm, marginTop: spacing.xs },
  sessionAction: { marginTop: spacing.sm },
  message: { ...typography.bodySm },
})
