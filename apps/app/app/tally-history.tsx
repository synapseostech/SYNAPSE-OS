import { useCallback, useEffect, useState } from 'react'
import { Alert, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native'
import { useRouter } from 'expo-router'
import { ScreenShell } from '@/components/ui/ScreenShell'
import { Button } from '@/components/ui/Button'
import { Card, SectionHeader } from '@/components/ui/Card'
import { EmptyState } from '@/components/ui/EmptyState'
import { LoadingBlock } from '@/components/ui/LoadingBlock'
import { useAuth } from '@/lib/auth'
import {
  ApiError,
  fetchTallyHistory,
  rollbackTallyImport,
  type TallyHistoryCheck,
  type TallyHistorySession,
  type TallyHistorySummary,
} from '@/lib/api'
import { spacing, typography, useTheme, type ThemeColors } from '@/lib/theme'

const MODE_LABELS: Record<string, string> = {
  opening: 'Opening balances',
  closing: 'Closing balances',
  replay: 'Full history replay',
}

function day(value: string | null | undefined): string {
  return value ? value.slice(0, 10) : '—'
}

function checkTone(status: TallyHistoryCheck['status'], colors: ThemeColors): string {
  if (status === 'match') return colors.success
  if (status === 'unknown') return colors.textMuted
  return colors.error
}

/**
 * What every Tally import wrote, beside what the ledger holds now, and the
 * one way to undo an applied import: reversing entries and inverse stock
 * movements, never deletions.
 */
export default function TallyHistoryScreen() {
  const { token } = useAuth()
  const { colors } = useTheme()
  const router = useRouter()
  const [history, setHistory] = useState<TallyHistorySummary | null>(null)
  const [empty, setEmpty] = useState(false)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [rollingBack, setRollingBack] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    if (!token) return
    setError(null)
    try {
      const data = await fetchTallyHistory(token)
      setHistory(data)
      setEmpty(false)
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) {
        setHistory(null)
        setEmpty(true)
      } else {
        setError(
          err instanceof ApiError && err.status === 403
            ? 'Your role cannot read the Tally import history.'
            : err instanceof Error
              ? err.message
              : 'The import history could not be loaded.',
        )
      }
    }
  }, [token])

  useEffect(() => {
    void load().finally(() => setLoading(false))
  }, [load])

  const refresh = async () => {
    setRefreshing(true)
    await load()
    setRefreshing(false)
  }

  const confirmRollback = (session: TallyHistorySession) => {
    if (!token) return
    Alert.alert(
      'Roll back this import?',
      `Every journal from ${session.company ?? 'this import'} gets a reversing entry and every stock movement an inverse one. Nothing is deleted, and the pharmacy can be imported again afterwards. The server refuses if any trading has happened since the cut-over.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Roll back',
          style: 'destructive',
          onPress: async () => {
            setRollingBack(session.id)
            setError(null)
            try {
              const result = await rollbackTallyImport(token, session.id)
              Alert.alert(
                result.alreadyReversed ? 'Already rolled back' : 'Import rolled back',
                result.alreadyReversed
                  ? `This import was rolled back on ${day(result.reversedAt)}.`
                  : `${(result.stock?.movementsReversed ?? 0).toLocaleString()} stock movements and ${(result.journalsReversed ?? 0).toLocaleString()} journals were reversed.`,
              )
              await load()
            } catch (err) {
              setError(
                err instanceof ApiError && err.status === 403
                  ? 'Rolling back needs the inventory adjustment and financial reports permissions.'
                  : err instanceof Error
                    ? err.message
                    : 'The rollback did not finish. It is safe to try again.',
              )
            } finally {
              setRollingBack(null)
            }
          },
        },
      ],
    )
  }

  if (loading) {
    return (
      <ScreenShell title="Tally import history">
        <LoadingBlock message="Loading import history…" />
      </ScreenShell>
    )
  }

  return (
    <ScreenShell title="Tally import history" scroll={false} contentStyle={styles.shell}>
      <ScrollView
        contentContainerStyle={styles.content}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} />}
      >
        {error ? (
          <Card>
            <Text style={[styles.body, { color: colors.error }]}>{error}</Text>
          </Card>
        ) : null}

        {empty ? (
          <EmptyState
            title="No Tally import applied yet"
            body="Once an import is applied, what it wrote and what the ledger holds now are shown here side by side."
          />
        ) : null}

        {history ? (
          <>
            <Card style={styles.card}>
              <Text style={[styles.title, { color: colors.text }]}>
                {history.journalsInForce.toLocaleString()} imported journals in force
              </Text>
              <Text style={[styles.meta, { color: colors.textMuted }]}>
                {history.reversals > 0
                  ? `${history.reversals.toLocaleString()} reversed by a rollback · `
                  : ''}
                {history.failureCount.toLocaleString()} listed exception
                {history.failureCount === 1 ? '' : 's'}
              </Text>
            </Card>

            <SectionHeader title="Planned, applied and in the ledger now" />
            <Card style={styles.card}>
              {history.checks.map((check) => (
                <View key={check.id} style={styles.checkRow}>
                  <View style={styles.checkCopy}>
                    <Text style={[styles.body, { color: colors.text }]}>{check.label}</Text>
                    <Text style={[styles.meta, { color: colors.textMuted }]}>
                      planned {check.planned ?? '—'} · applied {check.applied ?? '—'} · found{' '}
                      {check.found}
                    </Text>
                    {check.note ? (
                      <Text style={[styles.meta, { color: colors.textMuted }]}>{check.note}</Text>
                    ) : null}
                  </View>
                  <Text style={[styles.status, { color: checkTone(check.status, colors) }]}>
                    {check.status}
                  </Text>
                </View>
              ))}
            </Card>

            <SectionHeader title="Imports" />
            {history.sessions.map((session) => {
              const canRollBack = session.status === 'complete' && !session.reversedAt
              return (
                <Card key={session.id} style={styles.card}>
                  <Text style={[styles.title, { color: colors.text }]}>
                    {session.company ?? session.fileName ?? 'Tally import'}
                  </Text>
                  <Text style={[styles.meta, { color: colors.textMuted }]}>
                    {MODE_LABELS[session.mode] ?? session.mode} ·{' '}
                    {session.period
                      ? `${session.period.from} → ${session.period.to}`
                      : `cut-over ${day(session.conversionDate)}`}
                  </Text>
                  <Text style={[styles.meta, { color: colors.textSecondary }]}>
                    {session.status === 'complete' ? `Applied ${day(session.completedAt)}` : session.status}
                    {session.appliedCounts?.journals !== undefined
                      ? ` · ${session.appliedCounts.journals.toLocaleString()} vouchers`
                      : ''}
                    {session.appliedCounts?.stockMovements
                      ? ` · ${session.appliedCounts.stockMovements.toLocaleString()} movements`
                      : ''}
                    {session.failureCount > 0 ? ` · ${session.failureCount} exceptions` : ''}
                  </Text>
                  {session.reversedAt ? (
                    <Text style={[styles.meta, { color: colors.warning }]}>
                      Rolled back {day(session.reversedAt)}
                    </Text>
                  ) : null}
                  <View style={styles.actions}>
                    <Button
                      label="Play back"
                      variant="ghost"
                      onPress={() =>
                        router.push({ pathname: '/tally-playback', params: { id: session.id } } as never)
                      }
                    />
                    {canRollBack ? (
                      <Button
                        label="Roll back this import"
                        variant="danger"
                        loading={rollingBack === session.id}
                        disabled={rollingBack !== null}
                        onPress={() => confirmRollback(session)}
                      />
                    ) : null}
                  </View>
                </Card>
              )
            })}
          </>
        ) : null}

        <Button
          label="Start or continue a Tally import"
          variant="ghost"
          onPress={() => router.push('/tally-import' as never)}
        />
      </ScrollView>
    </ScreenShell>
  )
}

const styles = StyleSheet.create({
  shell: { flex: 1 },
  content: { gap: spacing.md, paddingBottom: spacing.xl },
  card: { gap: spacing.xs },
  title: { ...typography.bodyMedium, fontFamily: 'DMSans_700Bold' },
  body: { ...typography.bodySm },
  meta: { ...typography.caption, lineHeight: 17 },
  checkRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, paddingVertical: 2 },
  checkCopy: { flex: 1 },
  status: { ...typography.caption, fontFamily: 'IBMPlexMono_500Medium' },
  actions: { gap: spacing.xs, marginTop: spacing.xs },
})
