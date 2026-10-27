import { useCallback, useEffect, useRef, useState } from 'react'
import { Alert, Pressable, StyleSheet, Text, TextInput, View } from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import { useLocalSearchParams, useRouter } from 'expo-router'
import * as DocumentPicker from 'expo-document-picker'
import { ScreenShell } from '@/components/ui/ScreenShell'
import { Button } from '@/components/ui/Button'
import { Card, SectionHeader } from '@/components/ui/Card'
import { LoadingBlock } from '@/components/ui/LoadingBlock'
import { useAuth } from '@/lib/auth'
import {
  ApiError,
  applyTallyChunk,
  createTallyUpload,
  deleteTallySession,
  fetchTallySession,
  previewTallyImport,
  uploadTallySource,
  type TallyApplyProgress,
  type TallyPlanSummary,
  type TallyReconcileCheck,
} from '@/lib/api'
import { radii, spacing, typography, useTheme, type ThemeColors } from '@/lib/theme'

type PickedFile = { uri: string; name: string; size?: number }

type Phase = 'idle' | 'uploading' | 'previewing' | 'review' | 'applying' | 'done'

const STAGE_LABELS: Record<TallyApplyProgress['stage'], string> = {
  accounts: 'Chart of accounts',
  parties: 'Customers & suppliers',
  products: 'Stock items',
  'opening-journal': 'Opening balances',
  'opening-stock': 'Opening stock',
  journals: 'Historical vouchers',
  complete: 'Complete',
}

const STATUS_LABELS: Record<string, string> = {
  pending: 'Upload not finished',
  mapping: 'Ready to apply',
  review: 'Ready to apply',
  importing: 'Applying',
  complete: 'Complete',
  failed: 'Stopped',
}

const MAX_APPLY_CALLS = 500

const CONTENT_TYPES: Record<string, string> = {
  xml: 'application/xml',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  csv: 'text/csv',
}

function extensionOf(name: string): string {
  return name.toLowerCase().split('.').pop() ?? ''
}

function isIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const parsed = new Date(`${value}T00:00:00.000Z`)
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value
}

function money(value: number | null | undefined, currency: string): string {
  if (value === null || value === undefined || Number.isNaN(value)) return '—'
  return `${currency} ${Number(value).toLocaleString()}`
}

function statusTone(status: string, colors: ThemeColors): string {
  if (status === 'complete') return colors.success
  if (status === 'failed') return colors.error
  if (status === 'importing') return colors.info
  return colors.warning
}

export default function TallyImportScreen() {
  const { token } = useAuth()
  const { colors } = useTheme()
  const router = useRouter()
  const params = useLocalSearchParams<{ id?: string }>()

  const [file, setFile] = useState<PickedFile | null>(null)
  const [conversionDate, setConversionDate] = useState('')
  const [sessionId, setSessionId] = useState<string | null>(
    typeof params.id === 'string' && params.id ? params.id : null,
  )
  const [status, setStatus] = useState<string | null>(null)
  const [summary, setSummary] = useState<TallyPlanSummary | null>(null)
  const [progress, setProgress] = useState<TallyApplyProgress | null>(null)
  const [reconcile, setReconcile] = useState<TallyReconcileCheck[] | null>(null)
  const [phase, setPhase] = useState<Phase>('idle')
  const [loadingSession, setLoadingSession] = useState(Boolean(params.id))
  const [error, setError] = useState<string | null>(null)
  const [acknowledged, setAcknowledged] = useState(false)

  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])

  const loadSession = useCallback(
    async (id: string) => {
      if (!token) return
      setLoadingSession(true)
      setError(null)
      try {
        const data = await fetchTallySession(token, id)
        if (!alive.current) return
        setStatus(data.status)
        setSummary(data.summary)
        setProgress(data.progress)
        setReconcile(data.reconcile)
        if (data.status === 'complete') {
          setPhase('done')
        } else if (data.summary) {
          setPhase('review')
        } else {
          setPhase('idle')
        }
        if (data.errorMessage) setError(data.errorMessage)
      } catch (err) {
        if (!alive.current) return
        setError(
          err instanceof ApiError && err.status === 403
            ? 'Your role does not include the Tally import permissions.'
            : err instanceof Error
              ? err.message
              : 'Could not load the import session.',
        )
      } finally {
        if (alive.current) setLoadingSession(false)
      }
    },
    [token],
  )

  useEffect(() => {
    const id = typeof params.id === 'string' && params.id ? params.id : null
    if (id) void loadSession(id)
  }, [params.id, loadSession])

  const pickFile = async () => {
    try {
      const res = await DocumentPicker.getDocumentAsync({
        type: [
          'text/xml',
          'application/xml',
          'text/csv',
          'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          'application/vnd.ms-excel',
        ],
        copyToCacheDirectory: true,
        multiple: false,
      })
      if (res.canceled || !res.assets?.length) return
      const asset = res.assets[0]
      const name = asset.name ?? 'tally-export'
      const extension = extensionOf(name)
      if (!CONTENT_TYPES[extension]) {
        Alert.alert('Unsupported file', 'Choose a Tally XML export, an .xlsx workbook, or a .csv file.')
        return
      }
      setFile({ uri: asset.uri, name, size: asset.size ?? undefined })
      setError(null)
    } catch (err) {
      Alert.alert('Could not read file', err instanceof Error ? err.message : 'Try another file.')
    }
  }

  const startImport = async () => {
    if (!token || !file) return
    const cutOver = conversionDate.trim()
    if (cutOver && !isIsoDate(cutOver)) {
      Alert.alert('Check the date', 'Enter the cut-over date as YYYY-MM-DD, or leave it empty.')
      return
    }

    setError(null)
    setSummary(null)
    setProgress(null)
    setReconcile(null)
    setPhase('uploading')

    let id: string | null = null
    try {
      // This form only shows when there is no reviewed plan, so any existing
      // session is a stale upload slot. Replace it with a fresh one.
      if (sessionId) {
        await deleteTallySession(token, sessionId).catch(() => undefined)
        if (alive.current) setSessionId(null)
      }

      const target = await createTallyUpload(token, {
        fileName: file.name,
        fileSize: file.size,
      })
      id = target.sessionId
      setSessionId(id)
      await uploadTallySource(
        target.signedUrl,
        file.uri,
        CONTENT_TYPES[extensionOf(file.name)] ?? 'application/octet-stream',
      )

      if (!alive.current) return
      setPhase('previewing')

      const preview = await previewTallyImport(token, id, cutOver || undefined)
      if (!alive.current) return
      setSummary(preview.summary)
      setStatus('review')
      setPhase('review')
    } catch (err) {
      if (!alive.current) return
      setPhase('idle')
      setError(
        err instanceof ApiError
          ? err.message
          : err instanceof Error
            ? err.message
            : 'The import could not be prepared.',
      )
    }
  }

  const runApply = async () => {
    if (!token || !sessionId) return
    setError(null)
    setPhase('applying')

    let current = progress
    for (let call = 0; call < MAX_APPLY_CALLS; call += 1) {
      if (!alive.current) return
      try {
        const result = await applyTallyChunk(token, sessionId)
        if (!alive.current) return
        current = result.progress
        setProgress(result.progress)
        setStatus(result.done ? 'complete' : 'importing')
        if (result.reconcile) setReconcile(result.reconcile)
        if (result.done) {
          setPhase('done')
          return
        }
      } catch (err) {
        if (!alive.current) return
        setPhase('review')
        setError(
          err instanceof ApiError
            ? err.message
            : err instanceof Error
              ? err.message
              : 'Apply stopped before the step finished.',
        )
        // Keep the last checkpoint visible so the operator can resume.
        if (current) setProgress(current)
        return
      }
    }

    setPhase('review')
    setError('Apply stopped after many steps. Reopen this import to continue from its checkpoint.')
  }

  const discard = () => {
    if (!token || !sessionId) return
    Alert.alert('Discard import', 'This forgets the uploaded file and its review. Nothing in the ledger is touched.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Discard',
        style: 'destructive',
        onPress: async () => {
          try {
            await deleteTallySession(token, sessionId)
            if (!alive.current) return
            setSessionId(null)
            setFile(null)
            setSummary(null)
            setProgress(null)
            setReconcile(null)
            setStatus(null)
            setPhase('idle')
          } catch (err) {
            Alert.alert(
              'Could not discard',
              err instanceof ApiError ? err.message : 'Try again in a moment.',
            )
          }
        },
      },
    ])
  }

  const currency = summary?.currency ?? 'UGX'
  const blocking = (summary?.exceptions ?? []).filter((entry) => entry.severity === 'blocking')
  const warnings = (summary?.exceptions ?? []).filter((entry) => entry.severity === 'warning')
  const openingBalanced = summary ? summary.opening.difference === 0 : false

  const canApply =
    Boolean(sessionId) &&
    Boolean(summary) &&
    phase !== 'applying' &&
    phase !== 'uploading' &&
    phase !== 'previewing' &&
    status !== 'complete' &&
    openingBalanced &&
    (blocking.length === 0 || acknowledged)

  const applyBlockedReason = !summary
    ? null
    : !openingBalanced
      ? `Opening balances differ by ${money(summary.opening.difference, currency)}. Fix the source file; it will not be plugged.`
      : blocking.length > 0 && !acknowledged
        ? 'Review the blocking exceptions below and confirm them before applying.'
        : null

  return (
    <ScreenShell title="Tally import" contentStyle={styles.content}>
      <Card style={styles.intro}>
        <Text style={[styles.introTitle, { color: colors.text }]}>Bring your Tally history across</Text>
        <Text style={[styles.introBody, { color: colors.textSecondary }]}>
          Tally XML keeps every field. Excel and CSV use the documented Tally template, so arbitrary
          Tally report layouts are refused rather than guessed at. The import writes a balanced
          opening position plus dated vouchers, and nothing is applied until the opening balances
          exactly. Account-type and SKU overrides remain in the web workspace.
        </Text>
      </Card>

      {status ? (
        <Card style={styles.statusCard}>
          <View style={styles.statusRow}>
            <Text style={[styles.statusLabel, { color: colors.textSecondary }]}>Status</Text>
            <Text style={[styles.statusValue, { color: statusTone(status, colors) }]}>
              {STATUS_LABELS[status] ?? status}
            </Text>
          </View>
          {sessionId ? (
            <Text style={[styles.sessionId, { color: colors.textMuted }]} numberOfLines={1}>
              Session {sessionId.slice(0, 8)}
            </Text>
          ) : null}
        </Card>
      ) : null}

      {loadingSession ? (
        <LoadingBlock message="Loading import…" />
      ) : (
        <>
          {!summary ? (
            <>
              <Button
                label={file ? `Selected: ${file.name} — choose another` : 'Choose Tally XML / Excel / CSV'}
                onPress={pickFile}
                variant="ghost"
                disabled={phase === 'uploading' || phase === 'previewing'}
              />

              <View style={styles.field}>
                <Text style={[styles.fieldLabel, { color: colors.textSecondary }]}>
                  Cut-over date (optional)
                </Text>
                <TextInput
                  value={conversionDate}
                  onChangeText={setConversionDate}
                  placeholder="YYYY-MM-DD"
                  placeholderTextColor={colors.textMuted}
                  autoCapitalize="none"
                  autoCorrect={false}
                  style={[
                    styles.input,
                    { color: colors.text, borderColor: colors.border, backgroundColor: colors.bgElevated },
                  ]}
                />
                <Text style={[styles.fieldHelp, { color: colors.textMuted }]}>
                  Vouchers before this date are listed as exceptions instead of double-counting.
                </Text>
              </View>

              <Button
                label={phase === 'previewing' ? 'Reading the file…' : 'Upload and preview'}
                onPress={startImport}
                loading={phase === 'uploading' || phase === 'previewing'}
                disabled={!file || !token}
              />
            </>
          ) : (
            <>
              <Card style={styles.summaryCard}>
                <Text style={[styles.company, { color: colors.text }]}>
                  {summary.company ?? 'Tally export'}
                </Text>
                <Text style={[styles.meta, { color: colors.textMuted }]}>
                  {summary.format.toUpperCase()} · {currency} · cut-over {summary.conversionDate}
                </Text>

                <View style={styles.statGrid}>
                  <Stat label="Ledgers" value={String(summary.counts.ledgers)} />
                  <Stat label="Groups" value={String(summary.counts.groups)} />
                  <Stat label="Vouchers" value={String(summary.counts.vouchers)} />
                  <Stat label="Sales" value={String(summary.counts.sales)} />
                  <Stat label="Purchases" value={String(summary.counts.purchases)} />
                  <Stat label="Opening lines" value={String(summary.counts.openingLines)} />
                </View>

                <View style={[styles.openingRow, { borderColor: colors.border }]}>
                  <Text style={[styles.openingLabel, { color: colors.textSecondary }]}>
                    Opening journal
                  </Text>
                  <Text
                    style={[
                      styles.openingValue,
                      { color: openingBalanced ? colors.success : colors.error },
                    ]}
                  >
                    Dr {money(summary.opening.totalDebit, currency)} · Cr{' '}
                    {money(summary.opening.totalCredit, currency)}
                  </Text>
                  {!openingBalanced ? (
                    <Text style={[styles.openingDiff, { color: colors.error }]}>
                      Difference {money(summary.opening.difference, currency)} — not plugged
                    </Text>
                  ) : null}
                </View>
              </Card>

              {blocking.length > 0 ? (
                <>
                  <SectionHeader title={`Blocking exceptions (${blocking.length})`} />
                  <Card style={styles.listCard}>
                    {blocking.slice(0, 8).map((entry) => (
                      <View key={`${entry.code}-${entry.message}`} style={styles.exception}>
                        <Text style={[styles.exceptionCode, { color: colors.error }]}>{entry.code}</Text>
                        <Text style={[styles.exceptionMessage, { color: colors.textSecondary }]}>
                          {entry.message}
                        </Text>
                      </View>
                    ))}
                    {blocking.length > 8 ? (
                      <Text style={[styles.more, { color: colors.textMuted }]}>
                        and {blocking.length - 8} more
                      </Text>
                    ) : null}
                    <Pressable
                      onPress={() => setAcknowledged((value) => !value)}
                      style={styles.ackRow}
                      accessibilityRole="checkbox"
                      accessibilityState={{ checked: acknowledged }}
                    >
                      <Ionicons
                        name={acknowledged ? 'checkbox' : 'square-outline'}
                        size={20}
                        color={acknowledged ? colors.primary : colors.textMuted}
                      />
                      <Text style={[styles.ackText, { color: colors.textSecondary }]}>
                        I understand these rows will be skipped or listed, not guessed.
                      </Text>
                    </Pressable>
                  </Card>
                </>
              ) : null}

              {warnings.length > 0 ? (
                <>
                  <SectionHeader title={`Warnings (${warnings.length})`} />
                  <Card style={styles.listCard}>
                    {warnings.slice(0, 5).map((entry) => (
                      <View key={`${entry.code}-${entry.message}`} style={styles.exception}>
                        <Text style={[styles.exceptionCode, { color: colors.warning }]}>
                          {entry.code}
                        </Text>
                        <Text style={[styles.exceptionMessage, { color: colors.textSecondary }]}>
                          {entry.message}
                        </Text>
                      </View>
                    ))}
                    {warnings.length > 5 ? (
                      <Text style={[styles.more, { color: colors.textMuted }]}>
                        and {warnings.length - 5} more
                      </Text>
                    ) : null}
                  </Card>
                </>
              ) : null}

              {progress ? <ProgressCard progress={progress} totalChunks={summary.chunkCount} /> : null}

              {applyBlockedReason ? (
                <Text style={[styles.blocked, { color: colors.warning }]}>{applyBlockedReason}</Text>
              ) : null}

              {phase !== 'done' ? (
                <Button
                  label={
                    phase === 'applying'
                      ? 'Applying…'
                      : status === 'importing'
                        ? 'Continue applying'
                        : 'Apply to the ledger'
                  }
                  onPress={runApply}
                  loading={phase === 'applying'}
                  disabled={!canApply}
                />
              ) : null}

              <Button
                label={phase === 'done' ? 'Open accounting' : 'Open the web workspace'}
                variant="ghost"
                onPress={() =>
                  phase === 'done' ? router.push('/accounting') : router.push('/import-assistant')
                }
              />

              {status !== 'importing' && status !== 'complete' ? (
                <Button label="Discard this import" variant="danger" onPress={discard} />
              ) : null}
            </>
          )}

          {error ? (
            <Card>
              <Text style={[styles.message, { color: colors.error }]}>{error}</Text>
            </Card>
          ) : null}

          {phase === 'done' && reconcile ? (
            <>
              <SectionHeader title="Reconciliation" />
              <Card style={styles.listCard}>
                {reconcile.map((check) => (
                  <View key={check.id} style={styles.checkRow}>
                    <View style={styles.checkCopy}>
                      <Text style={[styles.checkLabel, { color: colors.text }]}>{check.label}</Text>
                      {check.note ? (
                        <Text style={[styles.checkNote, { color: colors.textMuted }]}>{check.note}</Text>
                      ) : null}
                    </View>
                    <Text
                      style={[
                        styles.checkValue,
                        {
                          color:
                            check.status === 'ok'
                              ? colors.success
                              : check.status === 'difference'
                                ? colors.error
                                : colors.textMuted,
                        },
                      ]}
                    >
                      {check.status === 'difference'
                        ? `Diff ${money(check.difference, currency)}`
                        : check.status === 'ok'
                          ? 'OK'
                          : 'n/a'}
                    </Text>
                  </View>
                ))}
              </Card>
            </>
          ) : null}

          {phase === 'done' && (progress?.failures.length ?? 0) > 0 ? (
            <>
              <SectionHeader title={`Listed exceptions (${progress?.failures.length})`} />
              <Card style={styles.listCard}>
                {progress?.failures.slice(0, 10).map((failure) => (
                  <View key={`${failure.stage}-${failure.key}-${failure.code}`} style={styles.exception}>
                    <Text style={[styles.exceptionCode, { color: colors.warning }]}>{failure.code}</Text>
                    <Text style={[styles.exceptionMessage, { color: colors.textSecondary }]}>
                      {failure.message}
                    </Text>
                  </View>
                ))}
              </Card>
            </>
          ) : null}

        </>
      )}
    </ScreenShell>
  )
}

function Stat({ label, value }: { label: string; value: string }) {
  const { colors } = useTheme()
  return (
    <View style={[styles.stat, { backgroundColor: colors.surface, borderColor: colors.border }]}>
      <Text style={[styles.statValue, { color: colors.text }]} numberOfLines={1}>
        {value}
      </Text>
      <Text style={[styles.statLabel, { color: colors.textMuted }]}>{label}</Text>
    </View>
  )
}

function ProgressCard({ progress, totalChunks }: { progress: TallyApplyProgress; totalChunks: number }) {
  const { colors } = useTheme()
  const counts = progress.counts
  const ratio =
    progress.stage === 'journals' && totalChunks > 0
      ? Math.min(1, progress.offset / totalChunks)
      : progress.stage === 'complete'
        ? 1
        : 0

  return (
    <Card style={styles.progressCard}>
      <Text style={[styles.progressStage, { color: colors.text }]}>
        {STAGE_LABELS[progress.stage]}
      </Text>
      <View style={[styles.progressTrack, { backgroundColor: colors.borderSubtle }]}>
        <View
          style={[styles.progressFill, { backgroundColor: colors.primary, width: `${ratio * 100}%` }]}
        />
      </View>
      <Text style={[styles.progressMeta, { color: colors.textMuted }]}>
        {counts.accounts} accounts · {counts.parties} parties · {counts.products} products ·{' '}
        {counts.journals} vouchers · {counts.openingStock} batches
      </Text>
      {progress.failures.length > 0 ? (
        <Text style={[styles.progressMeta, { color: colors.warning }]}>
          {progress.failures.length} listed exception{progress.failures.length === 1 ? '' : 's'}
        </Text>
      ) : null}
    </Card>
  )
}

const styles = StyleSheet.create({
  content: { gap: spacing.md },
  intro: { gap: spacing.sm },
  introTitle: { ...typography.h4, fontFamily: 'DMSans_700Bold' },
  introBody: { ...typography.bodySm, lineHeight: 21 },
  statusCard: { gap: spacing.xs },
  statusRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  statusLabel: { ...typography.caption },
  statusValue: { ...typography.caption, fontFamily: 'DMSans_700Bold' },
  sessionId: { ...typography.caption, fontFamily: 'IBMPlexMono_400Regular' },
  field: { gap: spacing.xs },
  fieldLabel: { ...typography.caption, fontFamily: 'DMSans_500Medium' },
  fieldHelp: { ...typography.caption, lineHeight: 17 },
  input: {
    borderWidth: 1,
    borderRadius: radii.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    ...typography.bodySm,
    fontFamily: 'IBMPlexMono_400Regular',
  },
  summaryCard: { gap: spacing.sm },
  company: { ...typography.h4, fontFamily: 'DMSans_700Bold' },
  meta: { ...typography.caption },
  statGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, marginTop: spacing.xs },
  stat: { width: '31%', borderWidth: 1, borderRadius: radii.md, padding: spacing.sm },
  statValue: { ...typography.bodyMedium, fontFamily: 'IBMPlexMono_500Medium' },
  statLabel: { ...typography.caption, marginTop: 2 },
  openingRow: { borderTopWidth: 1, paddingTop: spacing.sm, gap: 2 },
  openingLabel: { ...typography.caption, fontFamily: 'DMSans_500Medium' },
  openingValue: { ...typography.bodySm, fontFamily: 'IBMPlexMono_400Regular' },
  openingDiff: { ...typography.caption, fontFamily: 'DMSans_700Bold' },
  listCard: { gap: spacing.sm },
  exception: { gap: 2 },
  exceptionCode: { ...typography.caption, fontFamily: 'IBMPlexMono_500Medium' },
  exceptionMessage: { ...typography.bodySm, lineHeight: 19 },
  more: { ...typography.caption },
  ackRow: { flexDirection: 'row', gap: spacing.sm, alignItems: 'center', marginTop: spacing.xs },
  ackText: { ...typography.caption, flex: 1, lineHeight: 18 },
  blocked: { ...typography.caption, lineHeight: 18 },
  progressCard: { gap: spacing.sm },
  progressStage: { ...typography.bodyMedium, fontFamily: 'DMSans_500Medium' },
  progressTrack: { height: 6, borderRadius: 3, overflow: 'hidden' },
  progressFill: { height: 6, borderRadius: 3 },
  progressMeta: { ...typography.caption, lineHeight: 18 },
  checkRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  checkCopy: { flex: 1 },
  checkLabel: { ...typography.bodySm },
  checkNote: { ...typography.caption, marginTop: 2 },
  checkValue: { ...typography.caption, fontFamily: 'IBMPlexMono_500Medium' },
  message: { ...typography.bodySm },
})
