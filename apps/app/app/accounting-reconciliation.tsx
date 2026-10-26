import { useCallback, useEffect, useState } from 'react'
import { Alert, Pressable, StyleSheet, Text, View } from 'react-native'
import { useRouter } from 'expo-router'
import { ScreenShell } from '@/components/ui/ScreenShell'
import { Button } from '@/components/ui/Button'
import { Card, SectionHeader } from '@/components/ui/Card'
import { EmptyState } from '@/components/ui/EmptyState'
import { LoadingBlock } from '@/components/ui/LoadingBlock'
import { useAuth } from '@/lib/auth'
import {
  ApiError,
  fetchBankReconciliation,
  matchBankStatementLine,
  type BankReconciliation,
  type BankStatementLine,
} from '@/lib/api'
import { radii, spacing, typography, useTheme } from '@/lib/theme'

export default function AccountingReconciliationScreen() {
  const { token } = useAuth()
  const { colors } = useTheme()
  const router = useRouter()

  const [data, setData] = useState<BankReconciliation | null>(null)
  const [lines, setLines] = useState<BankStatementLine[]>([])
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [matchError, setMatchError] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<string | null>(null)
  const [matching, setMatching] = useState<string | null>(null)
  const [refreshKey, setRefreshKey] = useState(0)

  const apply = useCallback((result: BankReconciliation, append: boolean) => {
    setData(result)
    setLines((previous) => {
      const base = append ? previous : []
      const seen = new Set(base.map((line) => line.id))
      return [...base, ...result.lines.filter((line) => !seen.has(line.id))]
    })
  }, [])

  useEffect(() => {
    if (!token) {
      setLoading(false)
      return
    }
    let cancelled = false
    setLoading(true)
    setError(null)
    fetchBankReconciliation(token, 1)
      .then((result) => {
        if (!cancelled) apply(result, false)
      })
      .catch((err) => {
        if (cancelled) return
        setData(null)
        setLines([])
        setError(
          err instanceof ApiError && err.status === 403
            ? 'Your role does not include financial reports.'
            : 'Could not load bank statements.',
        )
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [token, refreshKey, apply])

  const loadMore = async () => {
    if (!token || !data) return
    setLoadingMore(true)
    setMatchError(null)
    try {
      const next = await fetchBankReconciliation(token, data.page + 1)
      apply(next, true)
    } catch {
      setMatchError('Could not load older statement lines.')
    } finally {
      setLoadingMore(false)
    }
  }

  const confirmMatch = (line: BankStatementLine, journalLineId: string, label: string) => {
    if (!token) return
    Alert.alert(
      'Match statement line?',
      `Link "${line.description}" to ${label}. This records the reconciliation.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Match',
          onPress: () => {
            setMatching(line.id)
            setMatchError(null)
            matchBankStatementLine(token, { statementLineId: line.id, journalLineId })
              .then(() => {
                setExpanded(null)
                setRefreshKey((key) => key + 1)
              })
              .catch((err) => {
                setMatchError(
                  err instanceof ApiError && err.status === 400
                    ? "That entry no longer matches this line's amount or currency."
                    : err instanceof ApiError && err.status === 409
                      ? 'This line or that entry has already been matched.'
                      : 'Could not match that line.',
                )
              })
              .finally(() => setMatching(null))
          },
        },
      ],
    )
  }

  const money = (value: number, currency: string) =>
    `${currency} ${Number(value ?? 0).toLocaleString()}`

  const loaded = lines.length
  const total = data?.totalLines ?? 0

  return (
    <ScreenShell title="Bank reconciliation" contentStyle={styles.content}>
      <Button
        label="Import statement"
        onPress={() => router.push('/accounting-reconciliation-import' as never)}
      />

      {loading ? (
        <LoadingBlock message="Loading bank statements…" />
      ) : error ? (
        <Card>
          <Text style={[styles.message, { color: colors.textSecondary }]}>{error}</Text>
        </Card>
      ) : !data || total === 0 ? (
        <EmptyState
          icon="document"
          title="No statement imported"
          body="Import a CSV of your bank statement to reconcile its lines against the ledger."
        />
      ) : (
        <>
          <Card>
            <View style={styles.summaryRow}>
              <Text style={[styles.summaryLabel, { color: colors.textSecondary }]}>
                Statement lines
              </Text>
              <Text style={[styles.summaryValue, { color: colors.text }]}>
                {total.toLocaleString()}
              </Text>
            </View>
            <View style={styles.summaryRow}>
              <Text style={[styles.summaryLabel, { color: colors.textSecondary }]}>
                Unmatched (this page)
              </Text>
              <Text style={[styles.summaryValue, { color: colors.warning }]}>
                {data.unmatchedOnPage.toLocaleString()}
              </Text>
            </View>
            <View style={styles.summaryRow}>
              <Text style={[styles.summaryLabel, { color: colors.textSecondary }]}>
                Matched (this page)
              </Text>
              <Text style={[styles.summaryValue, { color: colors.success }]}>
                {data.matchedOnPage.toLocaleString()}
              </Text>
            </View>
            {data.imports[0] ? (
              <Text style={[styles.summaryNote, { color: colors.textMuted }]}>
                {data.imports.length} import{data.imports.length === 1 ? '' : 's'} · latest{' '}
                {data.imports[0].fileName || 'unnamed'}
              </Text>
            ) : null}
          </Card>

          {matchError ? (
            <Text style={[styles.note, { color: colors.warning }]}>{matchError}</Text>
          ) : null}

          <SectionHeader title="Statement lines" style={styles.spacer} />

          <Card padded={false}>
            {lines.map((line, index) => {
              const open = expanded === line.id
              const matchable = !line.matched && line.candidates.length > 0
              return (
                <View key={line.id}>
                  {index > 0 ? (
                    <View style={[styles.divider, { backgroundColor: colors.borderSubtle }]} />
                  ) : null}
                  <Pressable
                    onPress={() => setExpanded(open ? null : line.id)}
                    disabled={!matchable}
                    accessibilityRole={matchable ? 'button' : undefined}
                    accessibilityState={matchable ? { expanded: open } : undefined}
                    style={styles.row}
                  >
                    <View style={styles.rowCopy}>
                      <Text style={[styles.rowTitle, { color: colors.text }]} numberOfLines={2}>
                        {line.description || '—'}
                      </Text>
                      <Text style={[styles.rowSub, { color: colors.textMuted }]} numberOfLines={1}>
                        {line.date} · {line.fileName || 'statement'} #{line.lineNumber}
                        {line.reference ? ` · ${line.reference}` : ''}
                      </Text>
                      <Text
                        style={[
                          styles.rowStatus,
                          { color: line.matched ? colors.success : colors.textMuted },
                        ]}
                      >
                        {line.matched
                          ? 'Matched'
                          : line.candidates.length === 0
                            ? 'No exact match'
                            : `${line.candidates.length} exact match${line.candidates.length === 1 ? '' : 'es'}`}
                      </Text>
                    </View>
                    <Text style={[styles.rowAmount, { color: colors.text }]}>
                      {money(line.amount, line.currency)}
                    </Text>
                  </Pressable>

                  {open && matchable ? (
                    <View style={[styles.candidates, { backgroundColor: colors.bgElevated }]}>
                      {line.candidates.map((candidate) => (
                        <Pressable
                          key={candidate.journalLineId}
                          onPress={() =>
                            confirmMatch(
                              line,
                              candidate.journalLineId,
                              `${candidate.entryNo || 'journal entry'} (${candidate.entryDate})`,
                            )
                          }
                          disabled={matching === line.id}
                          accessibilityRole="button"
                          accessibilityLabel={`Match to ${candidate.entryNo}`}
                          style={({ pressed }) => [styles.candidate, pressed && styles.pressed]}
                        >
                          <View style={styles.rowCopy}>
                            <Text style={[styles.candidateTitle, { color: colors.text }]}>
                              {candidate.entryNo || 'Journal entry'}
                            </Text>
                            <Text
                              style={[styles.rowSub, { color: colors.textMuted }]}
                              numberOfLines={1}
                            >
                              {candidate.entryDate} · {candidate.description || '—'}
                            </Text>
                          </View>
                          <Text style={[styles.candidateAmount, { color: colors.text }]}>
                            {matching === line.id
                              ? 'Matching…'
                              : money(candidate.amount, candidate.currency)}
                          </Text>
                        </Pressable>
                      ))}
                    </View>
                  ) : null}
                </View>
              )
            })}
          </Card>

          {loaded < total ? (
            <Button
              label={`Load older lines (${loaded.toLocaleString()} of ${total.toLocaleString()})`}
              variant="ghost"
              loading={loadingMore}
              onPress={loadMore}
            />
          ) : null}

          <Text style={[styles.footnote, { color: colors.textMuted }]}>
            Only entries with the same amount and currency are offered, because the ledger does not
            record which invoice or repayment a bank entry settled.
          </Text>
        </>
      )}
    </ScreenShell>
  )
}

const styles = StyleSheet.create({
  content: { gap: spacing.md },
  spacer: { marginTop: spacing.sm },
  note: { ...typography.caption, lineHeight: 18 },
  message: { ...typography.bodySm, lineHeight: 20 },
  divider: { height: 1, marginHorizontal: spacing.lg },
  summaryRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: spacing.xs,
  },
  summaryLabel: { ...typography.bodySm },
  summaryValue: { ...typography.bodySm, fontFamily: 'IBMPlexMono_500Medium' },
  summaryNote: { ...typography.caption, marginTop: spacing.sm },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
  },
  rowCopy: { flex: 1 },
  rowTitle: { ...typography.bodySm, fontFamily: 'DMSans_500Medium' },
  rowSub: { ...typography.caption, marginTop: 2 },
  rowStatus: { ...typography.caption, marginTop: 2 },
  rowAmount: { ...typography.bodySm, fontFamily: 'IBMPlexMono_400Regular' },
  candidates: {
    marginHorizontal: spacing.lg,
    marginBottom: spacing.md,
    borderRadius: radii.md,
    paddingHorizontal: spacing.md,
  },
  candidate: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingVertical: spacing.md,
  },
  candidateTitle: { ...typography.bodySm, fontFamily: 'DMSans_500Medium' },
  candidateAmount: { ...typography.bodySm, fontFamily: 'IBMPlexMono_400Regular' },
  pressed: { opacity: 0.6 },
  footnote: { ...typography.caption, marginTop: spacing.md, lineHeight: 18 },
})
