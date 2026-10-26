import { useCallback, useEffect, useState } from 'react'
import { Alert, StyleSheet, Text, View } from 'react-native'
import { ScreenShell } from '@/components/ui/ScreenShell'
import { Button } from '@/components/ui/Button'
import { Card, SectionHeader } from '@/components/ui/Card'
import { LoadingBlock } from '@/components/ui/LoadingBlock'
import { TextField } from '@/components/ui/TextField'
import { useAuth } from '@/lib/auth'
import {
  ApiError,
  closeAccountingPeriod,
  fetchAccountingPeriodReadiness,
  fetchAccountingPeriods,
  type AccountingCloseReadiness,
  type AccountingPeriod,
} from '@/lib/api'
import { spacing, typography, useTheme } from '@/lib/theme'

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

function isoLocal(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${date.getFullYear()}-${month}-${day}`
}

function previousMonthRange(): { start: string; end: string } {
  const now = new Date()
  return {
    start: isoLocal(new Date(now.getFullYear(), now.getMonth() - 1, 1)),
    end: isoLocal(new Date(now.getFullYear(), now.getMonth(), 0)),
  }
}

const SNAPSHOT_ROWS: { key: string; label: string; money?: boolean }[] = [
  { key: 'openTillSessions', label: 'Open till sessions' },
  { key: 'journalEntries', label: 'Journal entries' },
  { key: 'journalDebitTotal', label: 'Ledger debits', money: true },
  { key: 'salesCount', label: 'Sales' },
  { key: 'salesTotal', label: 'Sales value', money: true },
  { key: 'cashSalesTotal', label: 'Cash sales', money: true },
  { key: 'unmatchedBankLines', label: 'Unmatched bank lines' },
  { key: 'unmatchedBankValue', label: 'Unmatched bank value', money: true },
]

export default function AccountingPeriodsScreen() {
  const { token } = useAuth()
  const { colors } = useTheme()

  const [periods, setPeriods] = useState<AccountingPeriod[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)

  const initial = previousMonthRange()
  const [periodStart, setPeriodStart] = useState(initial.start)
  const [periodEnd, setPeriodEnd] = useState(initial.end)
  const [readiness, setReadiness] = useState<AccountingCloseReadiness | null>(null)
  const [checking, setChecking] = useState(false)
  const [closing, setClosing] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)

  const load = useCallback(async () => {
    if (!token) {
      setLoading(false)
      return
    }
    setLoading(true)
    setLoadError(null)
    try {
      const result = await fetchAccountingPeriods(token)
      setPeriods(result.periods)
    } catch (err) {
      setLoadError(
        err instanceof ApiError && err.status === 403
          ? 'Your role does not include financial reports.'
          : 'Could not load accounting periods.',
      )
    } finally {
      setLoading(false)
    }
  }, [token])

  useEffect(() => {
    void load()
  }, [load])

  const invalidate = () => {
    setReadiness(null)
    setFormError(null)
  }

  const check = async () => {
    if (!token) return
    if (!DATE_RE.test(periodStart.trim()) || !DATE_RE.test(periodEnd.trim())) {
      setFormError('Use YYYY-MM-DD for both dates.')
      return
    }
    if (periodStart.trim() > periodEnd.trim()) {
      setFormError('The period start must fall on or before the end.')
      return
    }

    setChecking(true)
    setFormError(null)
    setReadiness(null)
    try {
      const result = await fetchAccountingPeriodReadiness(
        token,
        periodStart.trim(),
        periodEnd.trim(),
      )
      setReadiness(result)
    } catch (err) {
      setFormError(
        err instanceof ApiError
          ? err.message
          : err instanceof Error
            ? err.message
            : 'Could not check the period.',
      )
    } finally {
      setChecking(false)
    }
  }

  const close = async () => {
    if (!token) return
    setClosing(true)
    setFormError(null)
    try {
      const result = await closeAccountingPeriod(token, periodStart.trim(), periodEnd.trim())
      setReadiness(null)
      Alert.alert(
        'Period closed',
        `${result.period?.periodStart ?? periodStart} to ${result.period?.periodEnd ?? periodEnd} is locked.`,
      )
      await load()
    } catch (err) {
      setFormError(
        err instanceof ApiError
          ? err.message
          : err instanceof Error
            ? err.message
            : 'Could not close the period.',
      )
    } finally {
      setClosing(false)
    }
  }

  const confirmClose = () => {
    Alert.alert(
      'Close this period?',
      'Closing cannot be undone from the app. Every posting dated inside the period will be refused afterwards; corrections must be posted in an open period.',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Close period', style: 'destructive', onPress: () => void close() },
      ],
    )
  }

  return (
    <ScreenShell title="Accounting periods" contentStyle={styles.content}>
      {loading ? (
        <LoadingBlock message="Loading periods…" />
      ) : loadError ? (
        <Card>
          <Text style={[styles.message, { color: colors.textSecondary }]}>{loadError}</Text>
        </Card>
      ) : (
        <>
          <TextField
            label="Period start"
            value={periodStart}
            onChangeText={(value) => {
              setPeriodStart(value)
              invalidate()
            }}
            placeholder="YYYY-MM-DD"
            autoCapitalize="none"
            keyboardType="numbers-and-punctuation"
          />
          <TextField
            label="Period end"
            value={periodEnd}
            onChangeText={(value) => {
              setPeriodEnd(value)
              invalidate()
            }}
            placeholder="YYYY-MM-DD"
            autoCapitalize="none"
            keyboardType="numbers-and-punctuation"
          />

          <Button label="Check readiness" onPress={() => void check()} loading={checking} />

          {readiness ? (
            <>
              <Card
                style={{
                  borderColor: readiness.readiness.ready ? colors.success : colors.errorBorder,
                  backgroundColor: readiness.readiness.ready
                    ? colors.successSoft
                    : colors.errorBg,
                }}
              >
                <Text
                  style={[
                    styles.verdict,
                    { color: readiness.readiness.ready ? colors.success : colors.error },
                  ]}
                >
                  {readiness.readiness.ready
                    ? 'Ready to close'
                    : `${readiness.readiness.blockers.length} blocker${
                        readiness.readiness.blockers.length === 1 ? '' : 's'
                      } must be resolved first`}
                </Text>
                {readiness.readiness.blockers.map((issue) => (
                  <Text key={issue.code} style={[styles.issue, { color: colors.textSecondary }]}>
                    {issue.message}
                  </Text>
                ))}
              </Card>

              {readiness.readiness.warnings.length > 0 ? (
                <Card>
                  <SectionHeader title="Warnings" />
                  {readiness.readiness.warnings.map((issue) => (
                    <Text key={issue.code} style={[styles.issue, { color: colors.textSecondary }]}>
                      {issue.message}
                    </Text>
                  ))}
                </Card>
              ) : null}

              <Card>
                <SectionHeader title="What the close records" />
                {SNAPSHOT_ROWS.map((row) => {
                  const raw = readiness.snapshot[row.key]
                  const value = Number(raw ?? 0)
                  return (
                    <View key={row.key} style={styles.snapshotRow}>
                      <Text style={[styles.snapshotLabel, { color: colors.textSecondary }]}>
                        {row.label}
                      </Text>
                      <Text style={[styles.snapshotValue, { color: colors.text }]}>
                        {Number.isFinite(value) ? value.toLocaleString() : '—'}
                      </Text>
                    </View>
                  )
                })}
                <Text style={[styles.snapshotNote, { color: colors.textMuted }]}>
                  Amounts are in the ledger currency. The snapshot is stored with the close so the
                  period can be explained later.
                </Text>
              </Card>

              <Button
                label="Close period"
                variant="danger"
                onPress={confirmClose}
                loading={closing}
                disabled={!readiness.readiness.ready || closing}
              />
            </>
          ) : null}

          {formError ? (
            <Text style={[styles.error, { color: colors.error }]}>{formError}</Text>
          ) : null}

          <SectionHeader title="Closed periods" style={styles.spacer} />
          {periods.length === 0 ? (
            <Card>
              <Text style={[styles.message, { color: colors.textMuted }]}>
                No accounting period has been closed yet.
              </Text>
            </Card>
          ) : (
            <View style={styles.list}>
              {periods.map((period) => (
                <Card key={period.id}>
                  <Text style={[styles.periodRange, { color: colors.text }]}>
                    {period.periodStart ?? '—'} to {period.periodEnd ?? '—'}
                  </Text>
                  <Text style={[styles.periodMeta, { color: colors.textMuted }]}>
                    {(period.status ?? 'unknown').replace(/_/g, ' ')}
                    {period.closedAt ? ` · closed ${period.closedAt.slice(0, 10)}` : ''}
                  </Text>
                </Card>
              ))}
            </View>
          )}

          <Text style={[styles.footnote, { color: colors.textMuted }]}>
            Closing locks every posting dated inside the period. Closing needs settings-management
            permission; checking readiness needs financial reports.
          </Text>
        </>
      )}
    </ScreenShell>
  )
}

const styles = StyleSheet.create({
  content: { gap: spacing.sm },
  verdict: { ...typography.bodyMedium, fontFamily: 'DMSans_500Medium', marginBottom: spacing.sm },
  issue: { ...typography.bodySm, lineHeight: 20, marginBottom: spacing.sm },
  snapshotRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: spacing.xs,
  },
  snapshotLabel: { ...typography.bodySm },
  snapshotValue: { ...typography.bodySm, fontFamily: 'IBMPlexMono_400Regular' },
  snapshotNote: { ...typography.caption, marginTop: spacing.sm, lineHeight: 18 },
  spacer: { marginTop: spacing.lg },
  list: { gap: spacing.sm },
  periodRange: { ...typography.bodyMedium, fontFamily: 'DMSans_500Medium' },
  periodMeta: { ...typography.caption, marginTop: 2, textTransform: 'capitalize' },
  message: { ...typography.bodySm, lineHeight: 20 },
  error: { ...typography.caption, textAlign: 'center', marginVertical: spacing.sm },
  footnote: { ...typography.caption, marginTop: spacing.md, lineHeight: 18 },
})
