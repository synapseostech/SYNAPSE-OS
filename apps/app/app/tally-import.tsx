import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
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
  stageTallySource,
  uploadTallySource,
  type TallyApplyProgress,
  type TallyApplyStage,
  type TallyBatchExpiry,
  type TallyManifestView,
  type TallyNegativeStock,
  type TallyPlanSummary,
  type TallyPreflight,
  type TallyReconcileCheck,
  type TallyReplayGate,
  type TallyStagedFile,
} from '@/lib/api'
import {
  REPLAY_REASON_MAX,
  REPLAY_REASON_MIN,
  TALLY_SOURCE_LIMIT_BYTES,
  alreadyStaged,
  isIsoDay,
  isNetworkFailure,
  kindFromFileName,
  needsStaging,
  orderForStaging,
  periodFromFileName,
  replayAcknowledgement,
  replayReasonAnswered,
  tallyContentType,
  unansweredBlockers,
  withNetworkRetry,
} from '@/lib/tally-import'
import { radii, spacing, typography, useTheme, type ThemeColors } from '@/lib/theme'

type PickedFile = { uri: string; name: string; size?: number }

type Phase = 'idle' | 'uploading' | 'previewing' | 'review' | 'applying' | 'done'

const STAGE_LABELS: Record<TallyApplyStage, string> = {
  accounts: 'Chart of accounts',
  parties: 'Customers & suppliers',
  products: 'Stock items',
  'opening-journal': 'Opening balances',
  'opening-stock': 'Opening stock',
  'stock-history': 'Replaying stock history',
  journals: 'Historical vouchers',
  'replay-closing': 'Closing check against Tally',
  complete: 'Complete',
}

const STATUS_LABELS: Record<string, string> = {
  pending: 'Files not read yet',
  mapping: 'Ready to apply',
  review: 'Ready to apply',
  importing: 'Applying',
  complete: 'Complete',
  failed: 'Stopped',
}

const MODE_LABELS: Record<string, string> = {
  opening: 'Opening balances',
  closing: 'Closing balances',
  replay: 'Full history replay',
}

const MAX_APPLY_CALLS = 500
const MAX_UPLOAD_MB = TALLY_SOURCE_LIMIT_BYTES / 1024 / 1024

function money(value: number | null | undefined, currency: string): string {
  if (value === null || value === undefined || Number.isNaN(value)) return '—'
  return `${currency} ${Number(value).toLocaleString()}`
}

function figure(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return '—'
  return Number(value).toLocaleString()
}

function statusTone(status: string, colors: ThemeColors): string {
  if (status === 'complete') return colors.success
  if (status === 'failed') return colors.error
  if (status === 'importing') return colors.info
  return colors.warning
}

function messageOf(err: unknown, fallback: string): string {
  if (err instanceof ApiError && err.status === 403) {
    return 'Your role does not include the Tally import permissions.'
  }
  return err instanceof Error ? err.message : fallback
}

function codeOf(err: unknown): string | undefined {
  return err instanceof ApiError && typeof err.payload.code === 'string' ? err.payload.code : undefined
}

export default function TallyImportScreen() {
  const { token } = useAuth()
  const { colors } = useTheme()
  const router = useRouter()
  const params = useLocalSearchParams<{ id?: string }>()

  const [files, setFiles] = useState<PickedFile[]>([])
  const [conversionDate, setConversionDate] = useState('')
  const [company, setCompany] = useState('')
  const [sessionId, setSessionId] = useState<string | null>(
    typeof params.id === 'string' && params.id ? params.id : null,
  )
  const [status, setStatus] = useState<string | null>(null)
  const [summary, setSummary] = useState<TallyPlanSummary | null>(null)
  const [progress, setProgress] = useState<TallyApplyProgress | null>(null)
  const [reconcile, setReconcile] = useState<TallyReconcileCheck[] | null>(null)
  const [staged, setStaged] = useState<TallyStagedFile[]>([])
  const [stagedProblems, setStagedProblems] = useState<string[]>([])
  const [manifest, setManifest] = useState<TallyManifestView | null>(null)
  const [preflight, setPreflight] = useState<TallyPreflight | null>(null)
  const [replayGate, setReplayGate] = useState<TallyReplayGate | null>(null)
  const [phase, setPhase] = useState<Phase>('idle')
  const [stagingNote, setStagingNote] = useState<string | null>(null)
  const [loadingSession, setLoadingSession] = useState(Boolean(params.id))
  const [error, setError] = useState<string | null>(null)
  // The operator's own statements; never inferred from the file.
  const [acknowledged, setAcknowledged] = useState(false)
  const [coverageAcknowledged, setCoverageAcknowledged] = useState(false)
  const [sequenceConfirmed, setSequenceConfirmed] = useState(false)
  const [replayReasons, setReplayReasons] = useState<Record<string, string>>({})
  const [batchExpiry, setBatchExpiry] = useState<TallyBatchExpiry>('source')
  const [negativeStock, setNegativeStock] = useState<TallyNegativeStock>('refused')

  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])

  const clearReview = () => {
    setSummary(null)
    setProgress(null)
    setReconcile(null)
    setManifest(null)
    setPreflight(null)
    setReplayGate(null)
    setStagedProblems([])
    setAcknowledged(false)
    setCoverageAcknowledged(false)
    setSequenceConfirmed(false)
    setReplayReasons({})
  }

  const loadSession = useCallback(
    async (id: string) => {
      if (!token) return
      setLoadingSession(true)
      setError(null)
      try {
        const data = await fetchTallySession(token, id)
        if (!alive.current) return
        setSessionId(id)
        setStatus(data.status)
        setSummary(data.summary)
        setProgress(data.progress)
        setReconcile(data.reconcile)
        setStaged(data.sources ?? [])
        setManifest(data.manifest ?? null)
        setPreflight(data.cutoverPreflight ?? null)
        setCoverageAcknowledged(Boolean(data.unverifiedAcknowledged))
        const gate = data.replay ?? null
        setReplayGate(gate)
        setSequenceConfirmed(gate?.sequenceConfirmed ?? false)
        setReplayReasons(
          gate ? Object.fromEntries(gate.acknowledged.map((item) => [item.key, item.reason])) : {},
        )
        if (data.summary?.batchExpiry) setBatchExpiry(data.summary.batchExpiry)
        setNegativeStock(data.summary?.negativeStock === 'allowed' ? 'allowed' : 'refused')
        if (data.summary?.company && !company) setCompany(data.summary.company)
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
        if (err instanceof ApiError && err.status === 404) {
          // The session is gone (reset or another database): start clean.
          setSessionId(null)
          setStatus(null)
          setStaged([])
          clearReview()
          setPhase('idle')
          return
        }
        setError(messageOf(err, 'Could not load the import session.'))
      } finally {
        if (alive.current) setLoadingSession(false)
      }
    },
    // `company` is only read to avoid overwriting what the operator typed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [token],
  )

  useEffect(() => {
    const id = typeof params.id === 'string' && params.id ? params.id : null
    if (id) void loadSession(id)
  }, [params.id, loadSession])

  const pickFiles = async () => {
    try {
      const res = await DocumentPicker.getDocumentAsync({
        type: [
          'text/xml',
          'application/xml',
          'text/csv',
          'text/comma-separated-values',
          'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          'application/vnd.ms-excel',
          'application/zip',
          'application/x-zip-compressed',
          // Some Android file managers label XML and ZIP exports generically.
          'application/octet-stream',
        ],
        copyToCacheDirectory: true,
        multiple: true,
      })
      if (res.canceled || !res.assets?.length) return
      const picked: PickedFile[] = []
      const refused: string[] = []
      for (const asset of res.assets) {
        const name = asset.name ?? 'tally-export'
        if (!tallyContentType(name)) {
          refused.push(name)
          continue
        }
        picked.push({ uri: asset.uri, name, size: asset.size ?? undefined })
      }
      if (refused.length > 0) {
        Alert.alert(
          'Some files were left out',
          `${refused.join(', ')} — choose Tally XML exports, a zipped export package, an .xlsx/.xls workbook, or a .csv template.`,
        )
      }
      const oversize = picked.find((entry) => (entry.size ?? 0) > TALLY_SOURCE_LIMIT_BYTES)
      if (oversize) {
        Alert.alert('File too large', `${oversize.name} is larger than ${MAX_UPLOAD_MB} MB.`)
        return
      }
      if (picked.length > 0) {
        setFiles(picked)
        setError(null)
        setStagingNote(null)
      }
    } catch (err) {
      Alert.alert('Could not read file', err instanceof Error ? err.message : 'Try another file.')
    }
  }

  /** The replay choices, sent only once the session is known to be a replay. */
  const replayOptions = (mode: string | undefined) =>
    mode === 'replay' ? { batchExpiry, negativeStock } : {}

  /** Reads the session's files as one migration and opens the review. */
  const runPreview = async (id: string, extra: { period?: { from: string; to: string } } = {}) => {
    if (!token) return
    setPhase('previewing')
    const cutOver = conversionDate.trim()
    const preview = await previewTallyImport(token, id, {
      ...(cutOver ? { conversionDate: cutOver } : {}),
      ...(company.trim() ? { company: company.trim() } : {}),
      ...(extra.period ? { period: extra.period } : {}),
      ...replayOptions(summary?.mode),
    })
    if (!alive.current) return
    clearReview()
    setSummary(preview.summary)
    setManifest(preview.manifest ?? null)
    setStatus('review')
    setPhase('review')
    // The replay's gate and the preflight are computed on the session read.
    await loadSession(id)
  }

  /** Uploads one file to Storage and returns where the server can find it. */
  const uploadOne = async (file: PickedFile, joinSession: string | null) => {
    if (!token) throw new Error('Sign in again to continue.')
    const target = await withNetworkRetry(() =>
      createTallyUpload(token, {
        fileName: file.name,
        fileSize: file.size,
        ...(joinSession ? { sessionId: joinSession } : {}),
      }),
    )
    await withNetworkRetry(() =>
      uploadTallySource(target.signedUrl, file.uri, tallyContentType(file.name) ?? 'application/octet-stream'),
    )
    return target
  }

  /** One file on its own: a workbook, a CSV, or one export with masters and vouchers. */
  const importSingle = async (file: PickedFile) => {
    if (!token) return
    // With nothing staged and no review, any existing session is a stale slot.
    if (sessionId && staged.length === 0 && !summary) {
      await deleteTallySession(token, sessionId).catch(() => undefined)
      if (alive.current) setSessionId(null)
    }
    setPhase('uploading')
    setStagingNote(`Uploading ${file.name}…`)
    const target = await uploadOne(file, null)
    if (!alive.current) return
    setSessionId(target.sessionId)
    setStagingNote(null)
    await runPreview(target.sessionId, { period: periodFromFileName(file.name) })
  }

  /**
   * Several files, or more files for a session that already holds some: each is
   * staged under its own company and period, then the whole set is read once.
   * A masters file that names no company is held back until a file that does
   * has named the cut-over.
   */
  const importStaged = async (chosen: PickedFile[], replace = false) => {
    if (!token) return
    setPhase('uploading')
    let session = sessionId
    let held = staged
    const unnamed: PickedFile[] = []

    const stageOne = async (file: PickedFile, deferUnnamed: boolean) => {
      const target = await uploadOne(file, session)
      session = target.sessionId
      if (alive.current) setSessionId(target.sessionId)
      const period = periodFromFileName(file.name)
      const kind = kindFromFileName(file.name)
      try {
        const result = await withNetworkRetry(() =>
          stageTallySource(token, target.sessionId, {
            uploadId: target.uploadId ?? '',
            fileName: file.name,
            ...(period ? { period } : {}),
            ...(company.trim() ? { company: company.trim() } : {}),
            ...(kind ? { kind } : {}),
            ...(replace ? { replace: true } : {}),
          }),
        )
        held = result.sources
        if (alive.current) {
          setStaged(result.sources)
          setStagedProblems(result.manifest?.problems ?? [])
        }
        return 'staged' as const
      } catch (err) {
        const code = codeOf(err)
        if (code === 'TALLY_COMPANY_MISSING' && deferUnnamed) return 'unnamed' as const
        if (code === 'TALLY_CHUNK_ALREADY_STAGED') return 'duplicate' as const
        throw err
      }
    }

    let current: PickedFile | null = null
    try {
      const ordered = orderForStaging(chosen)
      for (let i = 0; i < ordered.length; i += 1) {
        const file = ordered[i] as PickedFile
        if (!replace && alreadyStaged(file, held)) continue
        current = file
        setStagingNote(`Adding ${i + 1} of ${ordered.length}: ${file.name}`)
        const outcome = await stageOne(file, true)
        if (!alive.current) return
        if (outcome === 'duplicate') {
          setPhase(summary ? 'review' : 'idle')
          setStagingNote(null)
          Alert.alert(
            'That period is already staged',
            `${file.name} covers a range this import already holds. Replace the staged copy with this file?`,
            [
              { text: 'Keep the staged one', style: 'cancel' },
              { text: 'Replace', style: 'destructive', onPress: () => void importStaged([file], true) },
            ],
          )
          return
        }
        if (outcome === 'unnamed') {
          unnamed.push(file)
          if (unnamed.length >= 2 && !company.trim()) {
            throw new ApiError(
              'These files name no Tally company. Enter the company exactly as Tally shows it, then add them again.',
              422,
              { code: 'TALLY_COMPANY_MISSING' },
            )
          }
        }
      }
      for (const file of unnamed) {
        current = file
        setStagingNote(`Adding ${file.name}`)
        await stageOne(file, false)
        if (!alive.current) return
      }
    } catch (err) {
      if (!alive.current) return
      setPhase(summary ? 'review' : 'idle')
      setStagingNote(null)
      const name = current?.name ?? 'a file'
      setError(
        isNetworkFailure(err)
          ? `The connection dropped while adding ${name}. Files already added are kept: choose the same files and add them again to continue.`
          : `${name}: ${messageOf(err, 'The file could not be added.')}`,
      )
      return
    }

    setStagingNote(null)
    if (session) {
      try {
        await runPreview(session)
      } catch (err) {
        if (!alive.current) return
        setPhase('idle')
        setError(
          codeOf(err) === 'TALLY_SOURCES_INCOMPLETE'
            ? `${messageOf(err, 'The staged files do not cover the whole period yet.')} Add the missing files, then read them again.`
            : messageOf(err, 'The files could not be read.'),
        )
        const problems = err instanceof ApiError ? err.payload.problems : undefined
        if (Array.isArray(problems)) setStagedProblems(problems.map(String))
      }
    }
  }

  const startImport = async () => {
    if (!token || files.length === 0) return
    const cutOver = conversionDate.trim()
    if (cutOver && !isIsoDay(cutOver)) {
      Alert.alert('Check the date', 'Enter the cut-over date as YYYY-MM-DD, or leave it empty.')
      return
    }
    setError(null)
    try {
      if (needsStaging(files.length, staged.length)) {
        await importStaged(files)
      } else {
        await importSingle(files[0] as PickedFile)
      }
      if (alive.current) setFiles([])
    } catch (err) {
      if (!alive.current) return
      setPhase(summary ? 'review' : 'idle')
      setStagingNote(null)
      const code = codeOf(err)
      if (code === 'TALLY_CUTOVER_IN_PROGRESS' && err instanceof ApiError) {
        const existing = err.payload.sessionId
        if (typeof existing === 'string') {
          setError('A Tally cut-over is already in progress for this pharmacy. It has been reopened below.')
          await loadSession(existing)
          return
        }
      }
      setError(messageOf(err, 'The import could not be prepared.'))
    }
  }

  /** Reads the staged files again, e.g. after changing a replay choice. */
  const readAgain = async () => {
    if (!sessionId) return
    setError(null)
    try {
      await runPreview(sessionId)
    } catch (err) {
      if (!alive.current) return
      setPhase(summary ? 'review' : 'idle')
      setError(messageOf(err, 'The files could not be read.'))
    }
  }

  const isReplay = summary?.mode === 'replay'
  const unverifiedCoverage = manifest?.coverage === 'unverified'

  const runApply = async () => {
    if (!token || !sessionId) return
    setError(null)
    setPhase('applying')

    const acknowledgement = {
      acknowledgeUnverified: coverageAcknowledged,
      ...(isReplay
        ? { acknowledgeReplay: replayAcknowledgement(sequenceConfirmed, replayReasons) }
        : {}),
    }

    let current = progress
    let previous = ''
    for (let call = 0; call < MAX_APPLY_CALLS; call += 1) {
      if (!alive.current) return
      try {
        const result = await applyTallyChunk(token, sessionId, acknowledgement)
        if (!alive.current) return
        current = result.progress
        setProgress(result.progress)
        setStatus(result.done ? 'complete' : 'importing')
        if (result.reconcile) setReconcile(result.reconcile)
        if (result.done) {
          setPhase('done')
          return
        }
        const position = `${result.progress.stage}:${result.progress.offset}`
        if (position === previous) {
          setPhase('review')
          setError('Apply stopped making progress. Reopen this import and continue from its checkpoint.')
          return
        }
        previous = position
      } catch (err) {
        if (!alive.current) return
        setPhase('review')
        setError(messageOf(err, 'Apply stopped before the step finished.'))
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
    Alert.alert(
      'Discard import',
      'This forgets the uploaded files and their review. Nothing in the ledger is touched.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Discard',
          style: 'destructive',
          onPress: async () => {
            try {
              await deleteTallySession(token, sessionId)
              if (!alive.current) return
              setSessionId(null)
              setFiles([])
              setStaged([])
              setStatus(null)
              clearReview()
              setBatchExpiry('source')
              setNegativeStock('refused')
              setPhase('idle')
            } catch (err) {
              Alert.alert('Could not discard', messageOf(err, 'Try again in a moment.'))
            }
          },
        },
      ],
    )
  }

  const currency = summary?.currency ?? 'UGX'
  const blocking = (summary?.exceptions ?? []).filter((entry) => entry.severity === 'blocking')
  const warnings = (summary?.exceptions ?? []).filter((entry) => entry.severity === 'warning')
  const openingBalanced = summary ? summary.opening.difference === 0 : false
  const replayRows = summary?.replay?.reconciliation ?? []
  const replayOpenRows = useMemo(() => replayRows.filter((row) => row.status !== 'match'), [replayRows])
  const unanswered = replayGate ? unansweredBlockers(replayGate.blockers, replayReasons) : 0
  const replayNeedsReview = isReplay && (!sequenceConfirmed || !replayGate || unanswered > 0)
  const failingPreflight = (preflight?.checks ?? []).filter(
    (check) => check.blocksApply && check.status !== 'pass',
  )
  // The server judged the sequence before this screen's checkbox; Apply sends it.
  const onlySequenceBlocks =
    preflight?.canApply === false &&
    failingPreflight.length > 0 &&
    failingPreflight.every((check) => check.id === 'replay-sequence')
  const preflightBlocks = preflight?.canApply === false && !onlySequenceBlocks
  const busy = phase === 'applying' || phase === 'uploading' || phase === 'previewing'
  const replayChoicesChanged =
    isReplay &&
    ((summary?.batchExpiry ?? 'source') !== batchExpiry ||
      (summary?.negativeStock === 'allowed' ? 'allowed' : 'refused') !== negativeStock)

  const canApply =
    Boolean(sessionId) &&
    Boolean(summary) &&
    !busy &&
    status !== 'complete' &&
    openingBalanced &&
    (blocking.length === 0 || acknowledged) &&
    (!unverifiedCoverage || coverageAcknowledged) &&
    !replayNeedsReview &&
    !replayChoicesChanged &&
    !preflightBlocks

  const applyBlockedReason = !summary
    ? null
    : !openingBalanced
      ? `Opening balances differ by ${money(summary.opening.difference, currency)}. Fix the source file; it will not be plugged.`
      : replayChoicesChanged
        ? 'You changed a replay choice. Read the files again before applying.'
        : blocking.length > 0 && !acknowledged
          ? 'Review the blocking exceptions below and confirm them before applying.'
          : unverifiedCoverage && !coverageAcknowledged
            ? 'Confirm that the export covers the whole period before applying.'
            : isReplay && !replayGate
              ? 'The replay review is still loading.'
              : isReplay && unanswered > 0
                ? `Write a reason for ${unanswered} replay difference${unanswered === 1 ? '' : 's'} before applying.`
                : isReplay && !sequenceConfirmed
                  ? 'Confirm the replay order before applying.'
                  : preflightBlocks
                    ? `The cut-over preflight refuses Apply: ${failingPreflight.map((check) => check.label).join(', ')}.`
                    : null

  const stagedVouchers = staged.filter((entry) => entry.kind !== 'masters')
  const stagedSpan =
    staged.length > 0
      ? {
          from: staged.map((entry) => entry.range.from).sort()[0],
          to: staged.map((entry) => entry.range.to).sort().at(-1),
        }
      : null
  const canAddFiles = status !== 'importing' && status !== 'complete'

  const filePicker = (
    <>
      <Button
        label={
          files.length === 0
            ? staged.length > 0
              ? 'Choose more Tally files'
              : 'Choose Tally XML, ZIP, Excel or CSV'
            : files.length === 1
              ? `Selected: ${files[0]?.name} — choose again`
              : `Selected ${files.length} files — choose again`
        }
        onPress={pickFiles}
        variant="ghost"
        disabled={busy}
      />
      {files.length > 1 ? (
        <Text style={[styles.fieldHelp, { color: colors.textMuted }]} numberOfLines={4}>
          {files.map((entry) => entry.name).join(' · ')}
        </Text>
      ) : null}
    </>
  )

  return (
    <ScreenShell title="Tally import" contentStyle={styles.content}>
      <Card style={styles.intro}>
        <Text style={[styles.introTitle, { color: colors.text }]}>Bring your Tally history across</Text>
        <Text style={[styles.introBody, { color: colors.textSecondary }]}>
          Choose the folder of XML files the Synapse export script wrote (masters plus one Day Book per
          month), a zipped export package, or a single export. Every file is read, the whole history
          is replayed in date order, and the result is checked against Tally&apos;s own closing
          figures before anything is written.
        </Text>
        <Button
          label="Import history and rollback"
          variant="ghost"
          onPress={() => router.push('/tally-history' as never)}
        />
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
          {staged.length > 0 ? (
            <Card style={styles.listCard}>
              <Text style={[styles.checkLabel, { color: colors.text }]}>
                {staged.length} file{staged.length === 1 ? '' : 's'} staged ·{' '}
                {stagedVouchers.reduce((total, entry) => total + entry.recordsRead, 0).toLocaleString()}{' '}
                vouchers
              </Text>
              {stagedSpan ? (
                <Text style={[styles.meta, { color: colors.textMuted }]}>
                  {stagedSpan.from} to {stagedSpan.to} ·{' '}
                  {staged.some((entry) => entry.kind === 'masters') ? 'masters included' : 'no masters yet'}
                </Text>
              ) : null}
              {stagedProblems.slice(0, 4).map((problem) => (
                <Text key={problem} style={[styles.exceptionMessage, { color: colors.warning }]}>
                  {problem}
                </Text>
              ))}
            </Card>
          ) : null}

          {!summary ? (
            <>
              {filePicker}

              <View style={styles.field}>
                <Text style={[styles.fieldLabel, { color: colors.textSecondary }]}>
                  Tally company (optional)
                </Text>
                <TextInput
                  value={company}
                  onChangeText={setCompany}
                  placeholder="Exactly as Tally shows it"
                  placeholderTextColor={colors.textMuted}
                  autoCorrect={false}
                  style={[
                    styles.input,
                    { color: colors.text, borderColor: colors.border, backgroundColor: colors.bgElevated },
                  ]}
                />
                <Text style={[styles.fieldHelp, { color: colors.textMuted }]}>
                  Only used when a file names no company of its own, such as a masters export.
                </Text>
              </View>

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
                  Leave empty to use the export&apos;s own period.
                </Text>
              </View>

              {stagingNote ? (
                <Text style={[styles.fieldHelp, { color: colors.textSecondary }]}>{stagingNote}</Text>
              ) : null}

              <Button
                label={
                  phase === 'previewing'
                    ? 'Reading the files… (a full history can take a few minutes)'
                    : files.length > 1 || staged.length > 0
                      ? 'Add files and review'
                      : 'Upload and preview'
                }
                onPress={startImport}
                loading={phase === 'uploading' || phase === 'previewing'}
                disabled={files.length === 0 || !token}
              />

              {staged.length > 0 && files.length === 0 && sessionId ? (
                <Button
                  label="Read the files staged so far"
                  variant="ghost"
                  onPress={readAgain}
                  disabled={busy}
                />
              ) : null}
            </>
          ) : (
            <>
              <Card style={styles.summaryCard}>
                <Text style={[styles.company, { color: colors.text }]}>
                  {summary.company ?? 'Tally export'}
                </Text>
                <Text style={[styles.meta, { color: colors.textMuted }]}>
                  {MODE_LABELS[summary.mode ?? 'opening'] ?? summary.mode} · {currency} · cut-over{' '}
                  {summary.conversionDate}
                </Text>

                <View style={styles.statGrid}>
                  <Stat label="Ledgers" value={String(summary.counts.ledgers)} />
                  <Stat label="Stock items" value={String(summary.counts.stockItems)} />
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

              {summary.playback && sessionId ? (
                <Button
                  label={`Play back the history (${summary.playback.firstDate} → ${summary.playback.lastDate})`}
                  variant="ghost"
                  onPress={() =>
                    router.push({ pathname: '/tally-playback', params: { id: sessionId } } as never)
                  }
                />
              ) : null}

              {isReplay ? (
                <>
                  <SectionHeader title="Replay choices" />
                  <Card style={styles.listCard}>
                    <Text style={[styles.exceptionMessage, { color: colors.textSecondary }]}>
                      Answer these about your Tally company, not about this file. Read the files again
                      after changing one.
                    </Text>
                    <Toggle
                      checked={batchExpiry === 'not-supplied'}
                      onToggle={() =>
                        setBatchExpiry((value) => (value === 'not-supplied' ? 'source' : 'not-supplied'))
                      }
                      disabled={busy || status === 'complete'}
                      title="This export carries no batch expiry dates"
                      body="Imported stock keeps Tally's batch names with no expiry, so it cannot be expiry-tracked. Leave off if the export states expiries."
                    />
                    <Toggle
                      checked={negativeStock === 'allowed'}
                      onToggle={() =>
                        setNegativeStock((value) => (value === 'allowed' ? 'refused' : 'allowed'))
                      }
                      disabled={busy || status === 'complete'}
                      title="This Tally company allowed negative stock"
                      body="The replay then carries each negative exactly as Tally did and lists it as a warning. Left off, each negative blocks Apply."
                    />
                    {replayChoicesChanged ? (
                      <Button
                        label={phase === 'previewing' ? 'Reading the files…' : 'Read the files again'}
                        onPress={readAgain}
                        loading={phase === 'previewing'}
                        disabled={busy}
                      />
                    ) : null}
                  </Card>

                  <SectionHeader
                    title={`Against Tally — ${(replayRows.length - replayOpenRows.length).toLocaleString()} of ${replayRows.length.toLocaleString()} rows match`}
                  />
                  <Card style={styles.listCard}>
                    {replayRows.length > 0 && replayOpenRows.length === 0 ? (
                      <Text style={[styles.exceptionMessage, { color: colors.success }]}>
                        Every closing figure the export carries was reached exactly.
                      </Text>
                    ) : null}
                    {replayOpenRows.slice(0, 15).map((row) => (
                      <View key={`${row.scope}:${row.key}`} style={styles.exception}>
                        <Text style={[styles.checkLabel, { color: colors.text }]}>
                          {row.key}{' '}
                          <Text style={{ color: colors.textMuted }}>{row.scope.replace('_', ' ')}</Text>
                        </Text>
                        <Text style={[styles.exceptionMessage, { color: colors.textSecondary }]}>
                          {row.status === 'not-available'
                            ? `Not in the export${row.note ? ` — ${row.note}` : ''}`
                            : `Tally ${figure(row.expected)} · replay ${figure(row.actual)} · diff ${figure(row.difference)}`}
                          {row.firstDivergence
                            ? ` · first differs ${row.firstDivergence.date}`
                            : ''}
                        </Text>
                      </View>
                    ))}
                    {replayOpenRows.length > 15 ? (
                      <Text style={[styles.more, { color: colors.textMuted }]}>
                        and {replayOpenRows.length - 15} more — the web workspace downloads the full report
                      </Text>
                    ) : null}
                  </Card>

                  {replayGate && replayGate.blockers.length > 0 ? (
                    <>
                      <SectionHeader title={`Differences to answer (${replayGate.blockers.length})`} />
                      <Card style={styles.listCard}>
                        {replayGate.blockers.slice(0, 30).map((blocker) => {
                          const reason = replayReasons[blocker.key] ?? ''
                          return (
                            <View key={blocker.key} style={styles.exception}>
                              <Text style={[styles.checkLabel, { color: colors.text }]}>
                                {blocker.label}
                              </Text>
                              <Text style={[styles.exceptionMessage, { color: colors.textSecondary }]}>
                                {blocker.message}
                              </Text>
                              <TextInput
                                value={reason}
                                onChangeText={(text) =>
                                  setReplayReasons((currentReasons) => ({
                                    ...currentReasons,
                                    [blocker.key]: text,
                                  }))
                                }
                                placeholder={`Why this is accepted — at least ${REPLAY_REASON_MIN} characters`}
                                placeholderTextColor={colors.textMuted}
                                maxLength={REPLAY_REASON_MAX}
                                editable={!busy}
                                multiline
                                style={[
                                  styles.input,
                                  styles.reasonInput,
                                  {
                                    color: colors.text,
                                    borderColor:
                                      reason.trim() && !replayReasonAnswered(reason)
                                        ? colors.error
                                        : colors.border,
                                    backgroundColor: colors.bgElevated,
                                  },
                                ]}
                              />
                            </View>
                          )
                        })}
                        {replayGate.blockers.length > 30 ? (
                          <Text style={[styles.more, { color: colors.warning }]}>
                            {replayGate.blockers.length - 30} more differences need a reason. Answer
                            them in the web workspace, then return here to apply.
                          </Text>
                        ) : null}
                      </Card>
                    </>
                  ) : null}

                  <Card>
                    <Toggle
                      checked={sequenceConfirmed}
                      onToggle={() => setSequenceConfirmed((value) => !value)}
                      disabled={busy || status === 'complete'}
                      title="I confirm the replay order"
                      body="Tally date order, with same-day vouchers in export order, is the order this history should be rebuilt in."
                    />
                  </Card>
                </>
              ) : null}

              {unverifiedCoverage ? (
                <Card>
                  <Toggle
                    checked={coverageAcknowledged}
                    onToggle={() => setCoverageAcknowledged((value) => !value)}
                    disabled={busy || status === 'complete'}
                    title="I confirm this export covers the whole period"
                    body="The export did not state its own voucher count, so completeness could not be proven from the file."
                  />
                </Card>
              ) : null}

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
                    <Toggle
                      checked={acknowledged}
                      onToggle={() => setAcknowledged((value) => !value)}
                      disabled={busy}
                      title="I understand these rows will be skipped or listed, not guessed."
                    />
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

              {failingPreflight.length > 0 ? (
                <>
                  <SectionHeader title="Cut-over preflight" />
                  <Card style={styles.listCard}>
                    {failingPreflight.map((check) => (
                      <View key={check.id} style={styles.exception}>
                        <Text style={[styles.checkLabel, { color: colors.error }]}>{check.label}</Text>
                        <Text style={[styles.exceptionMessage, { color: colors.textSecondary }]}>
                          {check.detail}
                        </Text>
                      </View>
                    ))}
                  </Card>
                </>
              ) : null}

              {progress ? <ProgressCard progress={progress} totalChunks={summary.chunkCount} /> : null}

              {applyBlockedReason && phase !== 'done' ? (
                <Text style={[styles.blocked, { color: colors.warning }]}>{applyBlockedReason}</Text>
              ) : null}

              {phase !== 'done' ? (
                <Button
                  label={
                    phase === 'applying'
                      ? 'Applying… keep this screen open'
                      : status === 'importing'
                        ? 'Continue applying'
                        : 'Apply to the ledger'
                  }
                  onPress={runApply}
                  loading={phase === 'applying'}
                  disabled={!canApply}
                />
              ) : null}

              {canAddFiles && phase !== 'applying' ? (
                <>
                  {filePicker}
                  {files.length > 0 ? (
                    <Button
                      label="Add these files and read again"
                      variant="ghost"
                      onPress={startImport}
                      loading={phase === 'uploading' || phase === 'previewing'}
                    />
                  ) : null}
                  {stagingNote ? (
                    <Text style={[styles.fieldHelp, { color: colors.textSecondary }]}>{stagingNote}</Text>
                  ) : null}
                </>
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

function Toggle({
  checked,
  onToggle,
  disabled,
  title,
  body,
}: {
  checked: boolean
  onToggle: () => void
  disabled?: boolean
  title: string
  body?: string
}) {
  const { colors } = useTheme()
  return (
    <Pressable
      onPress={onToggle}
      disabled={disabled}
      style={[styles.ackRow, disabled ? styles.disabled : null]}
      accessibilityRole="checkbox"
      accessibilityState={{ checked, disabled }}
    >
      <Ionicons
        name={checked ? 'checkbox' : 'square-outline'}
        size={20}
        color={checked ? colors.primary : colors.textMuted}
      />
      <View style={styles.checkCopy}>
        <Text style={[styles.ackTitle, { color: colors.text }]}>{title}</Text>
        {body ? <Text style={[styles.ackText, { color: colors.textSecondary }]}>{body}</Text> : null}
      </View>
    </Pressable>
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
        {STAGE_LABELS[progress.stage] ?? progress.stage}
      </Text>
      <View style={[styles.progressTrack, { backgroundColor: colors.borderSubtle }]}>
        <View
          style={[styles.progressFill, { backgroundColor: colors.primary, width: `${ratio * 100}%` }]}
        />
      </View>
      <Text style={[styles.progressMeta, { color: colors.textMuted }]}>
        {counts.accounts} accounts · {counts.parties} parties · {counts.products} products ·{' '}
        {counts.journals} vouchers · {counts.openingStock} batches
        {counts.stockMovements ? ` · ${counts.stockMovements.toLocaleString()} movements replayed` : ''}
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
  reasonInput: { fontFamily: 'DMSans_400Regular', minHeight: 44, marginTop: spacing.xs },
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
  ackRow: { flexDirection: 'row', gap: spacing.sm, alignItems: 'flex-start', marginTop: spacing.xs },
  ackTitle: { ...typography.bodySm, fontFamily: 'DMSans_500Medium' },
  ackText: { ...typography.caption, lineHeight: 18, marginTop: 2 },
  disabled: { opacity: 0.55 },
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
