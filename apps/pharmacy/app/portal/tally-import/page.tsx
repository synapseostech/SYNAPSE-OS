"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import {
  AlertTriangle,
  ArrowRight,
  BookOpen,
  CheckCircle2,
  Copy,
  Download,
  FileSpreadsheet,
  Loader2,
  RefreshCw,
  Settings2,
  Terminal,
  Upload,
} from "lucide-react"
import { TallyDocumentProbe } from "@/components/tally/tally-document-probe"
import { TallySetupAssistant, type SetupConnection } from "@/components/tally/tally-setup-assistant"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { useToast } from "@/hooks/use-toast"
import { buildCompanyPinCommand, buildConnectorInstallCommand } from "@/lib/tally/bridge-command"
import { requestBridgeExport, TallyBridgeError } from "@/lib/tally/bridge-client"
import type { TallyExtractionSummary } from "@/lib/tally/chunks"
import type { TallyConsolidationReport } from "@/lib/tally/consolidate"
import { diagnosticFrom, reportTallyFailure } from "@/lib/tally/diagnostics"
import type { TallyEditionDisclosure, TallyEditionProblem } from "@/lib/tally/editions"
import { runTallyExtraction } from "@/lib/tally/extraction"
import { cutoverBlockReason, track } from "@/lib/telemetry/events"
import {
  beginLiveExtraction,
  createBridgeSource,
  createLiveSession,
  createPortalSink,
  finishLiveExtraction,
  type TallyLiveReview,
} from "@/lib/tally/live-extraction"

export const dynamic = "force-dynamic"

const MAX_UPLOAD_BYTES = 25 * 1024 * 1024
const ACCEPTED = ".xml,.xlsx,.xls,.csv"

type Counts = {
  ledgers: number
  groups: number
  stockItems: number
  vouchers: number
  postedVouchers: number
  skippedVouchers: number
  sales: number
  purchases: number
  openingLines: number
}

type Summary = {
  company?: string
  companyKey: string
  currency: string
  conversionDate: string
  mode?: "opening" | "closing"
  format: string
  counts: Counts
  opening: { date: string; totalDebit: number; totalCredit: number; difference: number }
  stock?: {
    openingValue: number | null
    closingValue: number | null
    itemsWithOpeningValue: number
    itemsWithClosingValue: number
    itemCount: number
  }
  exceptions: Array<{ code: string; message: string; detail?: string; severity: string }>
  chunkCount: number
  chunkSize: number
  warnings: string[]
  preparedAt: string
}

// The bridge answers failures with a code; these are the ones an operator can
// act on themselves.
const BRIDGE_ERRORS: Record<string, string> = {
  TALLY_BRIDGE_COMPANY_MISMATCH:
    "Tally answered for a different company from the one pinned. Open the pinned company in Tally, or pick the open company above and re-run the command, then connect again.",
  TALLY_BRIDGE_COMPANY_UNVERIFIED:
    "Tally's reply did not name the company it came from, so the export could not be checked and was refused. Send the tally-probe folder to support — this is a Tally build difference, not a mistake on this computer.",
  TALLY_BRIDGE_COMPANY_UNPINNED:
    "No company is pinned for this connector, so nothing can be checked. Set SYNAPSE_TALLY_COMPANY on the bridge, restart it, then connect again.",
  TALLY_BRIDGE_TALLY_TIMEOUT:
    "Tally took longer than one minute to answer, so the bridge stopped waiting. Nothing was imported. Export a shorter period, or send the tally-probe timing to support — the probe waits far longer than the bridge does.",
}

function bridgeMessage(error: unknown, fallback: string): string {
  if (error instanceof TallyBridgeError) return BRIDGE_ERRORS[error.code] ?? error.message
  return error instanceof Error && error.message ? error.message : fallback
}

type PreviewAccount = {
  code: string
  name: string
  sourceName: string
  accountType: string
  role: string
  systemKey?: string
  partyType?: string
  openingBalance?: number
  openingSide?: string
  unclassified: boolean
}

type PreviewStockItem = {
  sku: string
  name: string
  quantity?: number
  unit?: string
  openingValue?: number
  closingValue?: number
  batchCount: number
  receivableBatches: number
  expiredBatches: number
}

type PreviewParty = {
  kind: string
  name: string
  accountCode: string
  openingBalance?: number
  billCount: number
  nextDueDate?: string
}

type PreviewVoucher = {
  sourceId: string
  kind: string
  date: string
  number?: string
  partyName?: string
  total: number
}

type Preview = {
  accounts: PreviewAccount[]
  accountTotal: number
  parties: PreviewParty[]
  partyTotal: number
  stockItems: PreviewStockItem[]
  stockItemTotal: number
  vouchers: PreviewVoucher[]
  voucherTotal: number
  salesTotal: number
  purchasesTotal: number
}

type Progress = {
  stage: string
  offset: number
  counts: {
    accounts: number
    parties: number
    products: number
    openingJournal: number
    openingStock: number
    journals: number
    sales: number
    purchases: number
  }
  failures: Array<{ stage: string; key: string; code: string; message: string }>
  startedAt: string
  updatedAt: string
}

type ReconcileCheck = {
  id: string
  label: string
  expected: number | null
  actual: number | null
  difference: number | null
  status: "ok" | "difference" | "not-available"
  note?: string
}

type TallyPeriod = { from: string; to: string }

type ManifestEvidence = {
  requestedPeriod: TallyPeriod | null
  declaredPeriod: TallyPeriod | null
  voucherRange: { firstDate: string | null; lastDate: string | null }
  recordsRead: number
  recordsStaged: { accounts: number; parties: number; products: number; vouchers: number } | null
  independentCount: boolean
  coverage: "verified" | "unverified"
}

/** The coverage block the preview and the session reload both return. */
type ManifestView = {
  period: TallyPeriod | null
  periodSource?: "source" | "requested" | null
  declaredPeriod?: TallyPeriod | null
  coverage?: "verified" | "unverified" | null
  problems: string[]
  evidence?: ManifestEvidence | null
  manifestUpdatedAt?: string | null
  reason?: string
}

const formatPeriod = (period: TallyPeriod | null | undefined) =>
  period ? `${period.from} to ${period.to}` : null

const isIsoDay = (value: string) =>
  /^\d{4}-\d{2}-\d{2}$/.test(value) &&
  new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) === value

/**
 * The range an export names in its own file name, as the Synapse export
 * script writes it (`3-daybook-20250101-20251231.xml`). Slices have to carry
 * their own dates: one period typed into the form would make every slice claim
 * the whole migration and collide with the others.
 */
function periodFromFileName(name: string): TallyPeriod | undefined {
  const match = /(\d{4})(\d{2})(\d{2})-(\d{4})(\d{2})(\d{2})\.xml$/i.exec(name)
  if (!match) return undefined
  const from = `${match[1]}-${match[2]}-${match[3]}`
  const to = `${match[4]}-${match[5]}-${match[6]}`
  if (!isIsoDay(from) || !isIsoDay(to) || to < from) return undefined
  return { from, to }
}

/** The part of the cut-over a file holds, when its name says so. */
function kindFromFileName(name: string): "masters" | "vouchers" | undefined {
  const lower = name.toLowerCase()
  if (lower.includes("masters")) return "masters"
  if (lower.includes("daybook") || lower.includes("day-book")) return "vouchers"
  return undefined
}

/** One file already staged into the session, as the server lists it back. */
type StagedFile = {
  uploadId: string
  fileName: string
  kind: "masters" | "vouchers"
  chunkId: string
  range: TallyPeriod
  recordsRead: number
  bytes: number
  stagedAt: string
}

type BridgeCheck = {
  status: "ok" | "tally" | "token" | "bridge" | "error"
  message: string
}

/** The server's own list of what it will refuse Apply for. */
type PreflightView = {
  state: "pre-cutover" | "in-progress" | "completed" | "blocked"
  canApply: boolean
  checks: Array<{
    id: string
    label: string
    status: "pass" | "fail" | "warning" | "unavailable"
    detail: string
    blocksApply: boolean
  }>
}

const PREFLIGHT_STATE_LABEL: Record<PreflightView["state"], string> = {
  "pre-cutover": "ready to apply",
  "in-progress": "import running",
  completed: "applied",
  blocked: "blocked",
}

const STAGE_LABEL: Record<string, string> = {
  accounts: "Chart of accounts",
  parties: "Customers and suppliers",
  products: "Products",
  "opening-journal": "Opening trial balance",
  "opening-stock": "Opening stock batches",
  journals: "Historical vouchers",
  complete: "Complete",
}

const money = (value: number | undefined | null, currency: string) =>
  value === undefined || value === null
    ? "—"
    : `${currency} ${value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

function Stat({ label, value, tone }: { label: string; value: string; tone?: "warn" | "bad" }) {
  return (
    <div className="rounded-lg border p-4">
      <div
        className={`text-2xl font-bold ${
          tone === "bad" ? "text-destructive" : tone === "warn" ? "text-[#E8B84B]" : "text-foreground"
        }`}
      >
        {value}
      </div>
      <div className="text-sm text-muted-foreground">{label}</div>
    </div>
  )
}

export default function TallyImportPage() {
  const { toast } = useToast()
  const fileInput = useRef<HTMLInputElement>(null)

  const [files, setFiles] = useState<File[]>([])
  const [stagedFiles, setStagedFiles] = useState<StagedFile[]>([])
  const [stagedProblems, setStagedProblems] = useState<string[]>([])
  const [replacePrompt, setReplacePrompt] = useState<{ file: File; chunkId: string } | null>(null)
  const [sessionId, setSessionId] = useState<string | null>(null)
  const [summary, setSummary] = useState<Summary | null>(null)
  const [preflightView, setPreflightView] = useState<PreflightView | null>(null)
  const [preview, setPreview] = useState<Preview | null>(null)
  const [progress, setProgress] = useState<Progress | null>(null)
  const [reconcile, setReconcile] = useState<ReconcileCheck[] | null>(null)
  const [manifestView, setManifestView] = useState<ManifestView | null>(null)
  const [acknowledged, setAcknowledged] = useState(false)
  const [conversionDate, setConversionDate] = useState("")
  const [mode, setMode] = useState<"opening" | "closing">("opening")
  const [cutoverAccess, setCutoverAccess] = useState<"checking" | "ready" | "complete" | "denied" | "disabled" | "error">("checking")
  const [bridgeToken, setBridgeToken] = useState("")
  const [setupOpen, setSetupOpen] = useState(false)
  const [bridgeCheck, setBridgeCheck] = useState<BridgeCheck | null>(null)
  const [checkingBridge, setCheckingBridge] = useState(false)
  const [portalOrigin, setPortalOrigin] = useState("")
  const [tallyHost, setTallyHost] = useState("127.0.0.1")
  const [tallyPort, setTallyPort] = useState("9000")
  const [tallyExecutable, setTallyExecutable] = useState("")
  const [tallyFromDate, setTallyFromDate] = useState("")
  const [tallyToDate, setTallyToDate] = useState("")
  const [tallyCompany, setTallyCompany] = useState("")
  const [tallyCompanies, setTallyCompanies] = useState<string[]>([])
  const [bridgeEdition, setBridgeEdition] = useState("")
  const [editionInfo, setEditionInfo] = useState<TallyEditionDisclosure | null>(null)
  const [editionProblems, setEditionProblems] = useState<TallyEditionProblem[]>([])
  const [extraction, setExtraction] = useState<TallyExtractionSummary | null>(null)
  const [consolidation, setConsolidation] = useState<TallyConsolidationReport | null>(null)
  const [busy, setBusy] = useState<
    "idle" | "connecting" | "extracting" | "uploading" | "preview" | "applying" | "saving"
  >("idle")

  const blocking = useMemo(
    () => (summary?.exceptions ?? []).filter((entry) => entry.severity === "blocking"),
    [summary],
  )
  const balanced = summary ? summary.opening.difference === 0 : false
  const evidence = manifestView?.evidence ?? null
  const unverifiedCoverage = manifestView?.coverage === "unverified"
  // Unverified coverage is the operator's call, and only theirs: the checkbox
  // records it, and Apply repeats it so the server can hold the same line.
  const needsAcknowledgement = unverifiedCoverage && !acknowledged
  const canApply =
    cutoverAccess === "ready" &&
    Boolean(summary) &&
    balanced &&
    blocking.length === 0 &&
    !needsAcknowledgement &&
    busy === "idle" &&
    // The server judges a wider list than this screen; when it has spoken, its
    // answer wins. Before the session loads there is no verdict to defer to.
    preflightView?.canApply !== false

  const installCommand = useMemo(
    () =>
      buildConnectorInstallCommand({
        origin: portalOrigin,
        host: tallyHost,
        port: tallyPort,
        executable: tallyExecutable,
        company: tallyCompany,
      }),
    [portalOrigin, tallyHost, tallyPort, tallyExecutable, tallyCompany],
  )
  const pinCommand = useMemo(() => buildCompanyPinCommand(tallyCompany), [tallyCompany])

  useEffect(() => {
    setPortalOrigin(window.location.origin)
  }, [])

  useEffect(() => {
    let active = true
    void (async () => {
      try {
        const response = await fetch("/api/admin/tally/status", { cache: "no-store" })
        const data = await response.json()
        if (!active) return
        if (!response.ok) {
          if (response.status === 503 && data.code === "TALLY_CUTOVER_DISABLED") {
            setCutoverAccess("disabled")
            return
          }
          setCutoverAccess(response.status === 403 ? "denied" : "error")
          return
        }
        setCutoverAccess(
          !data.isAdmin ? "denied" : data.cutoverComplete ? "complete" : "ready",
        )
      } catch {
        if (active) setCutoverAccess("error")
      }
    })()
    return () => {
      active = false
    }
  }, [])

  const loadSession = useCallback(
    async (id: string) => {
      const response = await fetch(`/api/admin/tally/${id}`)
      const data = await response.json()
      if (!response.ok) return
      if (data.summary) setSummary(data.summary as Summary)
      setPreflightView((data.cutoverPreflight as PreflightView | null) ?? null)
      if (data.manifest !== undefined) {
        setManifestView((data.manifest as ManifestView | null) ?? null)
        setAcknowledged(Boolean(data.unverifiedAcknowledged))
      }
      if (data.progress) setProgress(data.progress as Progress)
      if (data.reconcile) setReconcile(data.reconcile as ReconcileCheck[])
      if (Array.isArray(data.sources)) setStagedFiles(data.sources as StagedFile[])
      setExtraction((data.extraction as TallyExtractionSummary | null) ?? null)
      setConsolidation((data.consolidation as TallyConsolidationReport | null) ?? null)
      if (data.conversionDate) setConversionDate(data.conversionDate as string)
      if (data.mode === "closing" || data.mode === "opening") setMode(data.mode)
    },
    [],
  )

  useEffect(() => {
    const stored = typeof window !== "undefined" ? window.localStorage.getItem("tallySessionId") : null
    if (stored) {
      setSessionId(stored)
      void loadSession(stored)
    }
  }, [loadSession])

  function rememberSession(id: string) {
    setSessionId(id)
    if (typeof window !== "undefined") window.localStorage.setItem("tallySessionId", id)
  }

  /**
   * The period the operator asked an export to cover. A bridge run always has
   * one: it reads from the "history from" date (or full history) to the
   * "balances close on" date, which the bridge defaults to today. A manual
   * upload only states one when both fields are filled, because guessing the
   * end date would flag a correct file as covering the wrong period.
   */
  function requestedPeriod(forBridge: boolean): { from: string; to: string } | undefined {
    const toIso = (value: string): string | undefined => {
      const raw = value.trim()
      if (!/^\d{8}$/.test(raw)) return undefined
      const iso = `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`
      const parsed = new Date(`${iso}T00:00:00.000Z`)
      return parsed.toISOString().slice(0, 10) === iso ? iso : undefined
    }
    const from = toIso(tallyFromDate)
    const to = toIso(tallyToDate) ?? (forBridge ? new Date().toISOString().slice(0, 10) : undefined)
    return from && to ? { from, to } : undefined
  }

  /** Drops every review a fresh read or a newly staged file invalidates. */
  function clearReview() {
    setSummary(null)
    setPreflightView(null)
    setPreview(null)
    setProgress(null)
    setReconcile(null)
    setManifestView(null)
    setExtraction(null)
    setConsolidation(null)
    setEditionInfo(null)
    setEditionProblems([])
    setAcknowledged(false)
  }

  /** Shows a preview the server accepted, whichever path produced it. */
  function showPreview(data: {
    summary?: unknown
    preview?: unknown
    manifest?: unknown
    edition?: unknown
    editionProblems?: unknown
  }) {
    const next = (data.summary as Summary | undefined) ?? null
    setSummary(next)
    setPreview((data.preview as Preview | undefined) ?? null)
    setManifestView((data.manifest as ManifestView | null | undefined) ?? null)
    setEditionInfo((data.edition as TallyEditionDisclosure | undefined) ?? null)
    setEditionProblems((data.editionProblems as TallyEditionProblem[] | undefined) ?? [])
    // A fresh preview is a fresh decision: the acknowledgement never carries
    // over from the file it was given for.
    setAcknowledged(false)
    if (!conversionDate && next?.conversionDate) setConversionDate(next.conversionDate)
  }

  async function uploadAndPreview(
    selectedFile: File | null = files[0] ?? null,
    period?: { from: string; to: string },
  ) {
    if (!selectedFile) {
      toast({ variant: "destructive", title: "Choose a Tally export first" })
      return
    }
    if (selectedFile.size > MAX_UPLOAD_BYTES) {
      toast({ variant: "destructive", title: "File is larger than 25 MB" })
      return
    }

    setBusy("uploading")
    clearReview()

    try {
      const startResponse = await fetch("/api/admin/tally/upload-url", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fileName: selectedFile.name, fileSize: selectedFile.size }),
      })
      const start = await startResponse.json()
      if (!startResponse.ok) {
        if (
          start.code === "TALLY_CUTOVER_IN_PROGRESS" &&
          typeof start.sessionId === "string"
        ) {
          rememberSession(start.sessionId)
          await loadSession(start.sessionId)
        }
        toast({ variant: "destructive", title: start.error ?? "Could not start the upload" })
        return
      }

      const put = await fetch(start.signedUrl as string, {
        method: "PUT",
        headers: {
          "Content-Type": selectedFile.name.toLowerCase().endsWith(".xls")
            ? "application/octet-stream"
            : selectedFile.type || "application/octet-stream",
        },
        body: selectedFile,
      })
      if (!put.ok) {
        toast({ variant: "destructive", title: "The file could not be uploaded" })
        return
      }

      rememberSession(start.sessionId as string)
      setBusy("preview")

      const previewResponse = await fetch(`/api/admin/tally/${start.sessionId}/preview`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...(conversionDate ? { conversionDate } : {}),
          ...(period ? { period } : {}),
          ...(bridgeEdition ? { edition: bridgeEdition } : {}),
          mode,
        }),
      })
      const data = await previewResponse.json()
      if (!previewResponse.ok) {
        if (data.code === "TALLY_FORMAT_UNSUPPORTED") {
          toast({
            variant: "destructive",
            title: "That file is not a Tally export",
            description: data.error,
          })
          return
        }
        toast({ variant: "destructive", title: data.error ?? "The file could not be read" })
        return
      }
      showPreview(data)
      toast({ title: "File read — review the mapping before applying" })
    } finally {
      setBusy("idle")
    }
  }

  type StageOutcome =
    | { ok: true; session: string; sources: StagedFile[]; problems: string[] }
    | { ok: false; replaceChunkId?: string }

  /**
   * Uploads one file and hands it to the sources endpoint, which gives it the
   * chunk its own company and period imply. Nothing is previewed here: a
   * cut-over built from slices is read once, after the last one arrives.
   */
  async function stageOne(
    selectedFile: File,
    session: string | null,
    replace: boolean,
  ): Promise<StageOutcome> {
    const startResponse = await fetch("/api/admin/tally/upload-url", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        fileName: selectedFile.name,
        fileSize: selectedFile.size,
        ...(session ? { sessionId: session } : {}),
      }),
    })
    const start = await startResponse.json()
    if (!startResponse.ok || typeof start.sessionId !== "string") {
      if (start.code === "TALLY_CUTOVER_IN_PROGRESS" && typeof start.sessionId === "string") {
        rememberSession(start.sessionId)
        await loadSession(start.sessionId)
      }
      toast({ variant: "destructive", title: start.error ?? "Could not start the upload" })
      return { ok: false }
    }

    const put = await fetch(start.signedUrl as string, {
      method: "PUT",
      headers: {
        "Content-Type": selectedFile.name.toLowerCase().endsWith(".xls")
          ? "application/octet-stream"
          : selectedFile.type || "application/octet-stream",
      },
      body: selectedFile,
    })
    if (!put.ok) {
      toast({ variant: "destructive", title: "The file could not be uploaded" })
      return { ok: false }
    }

    rememberSession(start.sessionId as string)

    // A slice names its own dates; the typed period is the fallback for a file
    // that does not, and names the one range a masters export covers.
    const period = periodFromFileName(selectedFile.name) ?? requestedPeriod(false)
    const kind = kindFromFileName(selectedFile.name)
    const sourcesResponse = await fetch(`/api/admin/tally/${start.sessionId}/sources`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        uploadId: start.uploadId,
        fileName: selectedFile.name,
        ...(period ? { period } : {}),
        ...(kind ? { kind } : {}),
        ...(replace ? { replace: true } : {}),
      }),
    })
    const staged = await sourcesResponse.json()
    if (!sourcesResponse.ok) {
      if (staged.code === "TALLY_CHUNK_ALREADY_STAGED") {
        return { ok: false, replaceChunkId: String(staged.chunkId ?? "") }
      }
      toast({ variant: "destructive", title: staged.error ?? "The file could not be added" })
      return { ok: false }
    }
    return {
      ok: true,
      session: start.sessionId as string,
      sources: Array.isArray(staged.sources) ? (staged.sources as StagedFile[]) : [],
      problems: Array.isArray(staged.manifest?.problems)
        ? (staged.manifest.problems as string[])
        : [],
    }
  }

  /** Stages every chosen file, then reads the whole set once. */
  async function stageAndPreview(chosen: File[], replace = false) {
    const oversize = chosen.find((entry) => entry.size > MAX_UPLOAD_BYTES)
    if (oversize) {
      toast({ variant: "destructive", title: `${oversize.name} is larger than 25 MB` })
      return
    }

    setReplacePrompt(null)
    setBusy("uploading")
    clearReview()

    let session = sessionId
    try {
      for (const selectedFile of chosen) {
        const result = await stageOne(selectedFile, session, replace)
        if (!result.ok) {
          if (result.replaceChunkId) {
            setReplacePrompt({ file: selectedFile, chunkId: result.replaceChunkId })
          }
          return
        }
        session = result.session
        setStagedFiles(result.sources)
        setStagedProblems(result.problems)
      }
    } finally {
      setBusy("idle")
    }

    if (!session) return
    await previewStaged(session)
  }

  /** Reads every staged file as one migration, once they have all arrived. */
  async function previewStaged(session = sessionId) {
    if (!session) return
    setBusy("preview")
    try {
      const response = await fetch(`/api/admin/tally/${session}/preview`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...(conversionDate ? { conversionDate } : {}),
          ...(bridgeEdition ? { edition: bridgeEdition } : {}),
          mode,
        }),
      })
      const data = await response.json()
      if (!response.ok) {
        if (data.code === "TALLY_SOURCES_INCOMPLETE" && Array.isArray(data.problems)) {
          setStagedProblems(data.problems.map(String))
        }
        toast({ variant: "destructive", title: data.error ?? "The files could not be read" })
        return
      }
      showPreview(data)
      toast({ title: "Files read — review the mapping before applying" })
    } finally {
      setBusy("idle")
    }
  }

  /**
   * What the main action does. One file on its own keeps the path it had
   * before: a workbook, a CSV, or a single export carrying both masters and
   * vouchers is read directly. Several files are staged one by one and read
   * together at the end.
   */
  async function uploadAndReview() {
    if (files.length === 0) {
      toast({ variant: "destructive", title: "Choose a Tally export first" })
      return
    }
    if (files.length === 1 && stagedFiles.length === 0) {
      await uploadAndPreview(files[0] ?? null, requestedPeriod(false))
      return
    }
    await stageAndPreview(files)
  }

  /** The review the server staged from the chunks, rendered like a preview. */
  function showReview(review: TallyLiveReview) {
    setSummary(review.summary as Summary)
    setPreview(review.preview as Preview)
    setExtraction(review.extraction)
    setConsolidation(review.consolidation)
    setManifestView(review.manifest as unknown as ManifestView)
    setEditionInfo(review.edition ?? null)
    setEditionProblems(review.editionProblems ?? [])
    // A new plan is a new decision: the acknowledgement never carries over.
    setAcknowledged(false)
    if (!conversionDate) {
      const staged = (review.summary as Summary | undefined)?.conversionDate
      if (staged) setConversionDate(staged)
    }
  }

  function stopMessage(result: Awaited<ReturnType<typeof runTallyExtraction>>): string {
    const failure = result.summary.failures[0]?.error
    if (result.stopped === "cancelled") return "Extraction was cancelled."
    if (result.stopped === "attempts_exhausted") {
      return "A range failed on every attempt. Nothing was applied."
    }
    return failure
      ? `The extraction stopped: ${failure}`
      : "The extraction stopped before every range was read. Nothing was applied."
  }

  /** Runs or resumes the chunked read, then stages the plan for review. */
  async function runExtraction(session: string, company: string) {
    const result = await runTallyExtraction({
      company,
      mode: "opening",
      source: createBridgeSource({ token: bridgeToken.trim() }),
      sink: createPortalSink({ sessionId: session }),
      onProgress: (_manifest, summary) => setExtraction(summary),
    })
    if (result.stopped !== "complete") {
      reportTallyFailure({
        step: "extraction",
        outcome: result.stopped,
        ...(result.stopCode ? { code: result.stopCode } : {}),
        sessionId: session,
      })
      toast({
        variant: "destructive",
        title: "Extraction did not finish",
        description: `${stopMessage(result)} Retry the unfinished ranges below.`,
      })
      return
    }
    showReview(await finishLiveExtraction(session))
    toast({ title: "Tally read — review the migration before applying" })
  }

  async function connectToTally() {
    if (!bridgeToken.trim()) {
      toast({ variant: "destructive", title: "Enter the Tally Bridge token" })
      return
    }
    const company = tallyCompany.trim()
    if (!company) {
      toast({ variant: "destructive", title: "Select the Tally company first" })
      return
    }
    const period = requestedPeriod(true)
    if (!period) {
      toast({
        variant: "destructive",
        title: "Enter the history-from date",
        description:
          "A live extraction reads the history in date ranges, so it needs a start date in YYYYMMDD form.",
      })
      return
    }

    setBusy("connecting")
    try {
      if (mode === "closing") {
        // A balances-only cut-over reads the masters once and posts no voucher.
        const exported = await requestBridgeExport({
          token: bridgeToken.trim(),
          mode,
          company,
          period,
          scope: "masters",
        })
        const source = new File([exported.xml], "tally-live-export.xml", {
          type: "application/xml",
        })
        setFiles([source])
        setBusy("idle")
        await uploadAndPreview(source, period)
        return
      }

      setSummary(null)
      setPreflightView(null)
      setPreview(null)
      setProgress(null)
      setReconcile(null)
      setManifestView(null)
      setConsolidation(null)
      setEditionInfo(null)
      setEditionProblems([])
      setAcknowledged(false)

      const session = await createLiveSession()
      rememberSession(session.sessionId)
      const begun = await beginLiveExtraction({
        sessionId: session.sessionId,
        company,
        mode,
        period,
        ...(bridgeEdition ? { edition: bridgeEdition } : {}),
      })
      setExtraction(begun.summary)

      setBusy("extracting")
      await runExtraction(session.sessionId, company)
    } catch (error) {
      reportTallyFailure({
        step: mode === "closing" ? "closing-export" : "extraction",
        outcome: "failed",
        ...diagnosticFrom(error),
      })
      toast({
        variant: "destructive",
        title: bridgeMessage(error, "Could not connect to the local Tally Bridge."),
        description:
          "Start the bridge on this computer, confirm Tally's HTTP server is enabled and the correct company is open, and check the allowed portal origin.",
      })
    } finally {
      setBusy("idle")
    }
  }

  /** Retries the ranges that failed, continuing from the server's manifest. */
  async function resumeExtraction() {
    if (!sessionId) return
    setBusy("extracting")
    try {
      await runExtraction(sessionId, tallyCompany.trim())
    } catch (error) {
      reportTallyFailure({
        step: "extraction-resume",
        outcome: "failed",
        ...diagnosticFrom(error),
        sessionId,
      })
      toast({
        variant: "destructive",
        title: bridgeMessage(error, "The extraction could not continue."),
      })
    } finally {
      setBusy("idle")
    }
  }

  async function copyCommand(text: string, label: string) {
    try {
      await navigator.clipboard.writeText(text)
      toast({ title: `${label} copied` })
    } catch {
      toast({ variant: "destructive", title: "Could not copy — select the command manually" })
    }
  }

  async function checkBridge() {
    setCheckingBridge(true)
    setBridgeCheck(null)
    try {
      const response = await fetch("http://127.0.0.1:17890/api/tally/status", {
        headers: { "x-synapse-tally-bridge-token": bridgeToken.trim() },
        cache: "no-store",
      })

      if (response.status === 401) {
        reportTallyFailure({ step: "bridge-check", outcome: "http", status: 401 })
        setBridgeCheck({
          status: "token",
          message:
            "The bridge is running, but it did not accept this token. Paste the same 64-character token it was started with.",
        })
        return
      }
      if (!response.ok) {
        reportTallyFailure({ step: "bridge-check", outcome: "http", status: response.status })
        setBridgeCheck({
          status: "error",
          message: `The bridge answered with HTTP ${response.status}.`,
        })
        return
      }

      const data = (await response.json()) as {
        tally?: string
        target?: string
        edition?: string
      }
      if (data.edition) setBridgeEdition(data.edition)
      if (data.tally === "reachable") {
        setBridgeCheck({
          status: "ok",
          message: `Bridge is running and Tally answered at ${data.target ?? "its local port"}.`,
        })
        await loadTallyCompanies()
        return
      }
      reportTallyFailure({ step: "bridge-check", outcome: "failed" })
      setBridgeCheck({
        status: "tally",
        message: `Bridge is running, but nothing answered at ${data.target ?? "Tally's HTTP port"}. Open Tally, sign in, and confirm its HTTP server is enabled.`,
      })
    } catch {
      // A cross-origin failure is opaque to the browser, so an unreachable
      // bridge and a bridge rejecting this origin are indistinguishable here.
      reportTallyFailure({ step: "bridge-check", outcome: "network" })
      setBridgeCheck({
        status: "bridge",
        message: `Nothing answered at 127.0.0.1:17890. Start the bridge on this computer, or confirm SYNAPSE_TALLY_ALLOWED_ORIGINS is ${portalOrigin || "this page's origin"}.`,
      })
    } finally {
      setCheckingBridge(false)
    }
  }

  // Read-only discovery: asks the bridge which companies Tally has open, so the
  // operator pins one instead of typing its name from memory. Best-effort — a
  // bridge without the endpoint leaves the manual field in place.
  async function loadTallyCompanies() {
    try {
      const response = await fetch("http://127.0.0.1:17890/api/tally/companies", {
        headers: { "x-synapse-tally-bridge-token": bridgeToken.trim() },
        cache: "no-store",
      })
      if (!response.ok) {
        reportTallyFailure({ step: "bridge-companies", outcome: "http", status: response.status })
        return
      }
      const data = (await response.json()) as { companies?: string[]; edition?: string }
      const companies = Array.isArray(data.companies) ? data.companies : []
      setTallyCompanies(companies)
      if (data.edition) setBridgeEdition(data.edition)
      setTallyCompany((current) =>
        current && companies.includes(current) ? current : (companies[0] ?? current),
      )
    } catch {
      // Discovery fails the same way the status probe does; the operator can type the name.
      reportTallyFailure({ step: "bridge-companies", outcome: "network" })
    }
  }

  async function saveMapping() {
    if (!sessionId) return
    setBusy("saving")
    try {
      const response = await fetch(`/api/admin/tally/${sessionId}/mapping`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ conversionDate, mode }),
      })
      const data = await response.json()
      if (!response.ok) {
        toast({ variant: "destructive", title: data.error ?? "Could not save the cut-over date" })
        return
      }
      const previewResponse = await fetch(`/api/admin/tally/${sessionId}/preview`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          conversionDate,
          mode,
          ...(bridgeEdition ? { edition: bridgeEdition } : {}),
        }),
      })
      const previewData = await previewResponse.json()
      if (!previewResponse.ok) {
        toast({ variant: "destructive", title: previewData.error ?? "Re-preview failed" })
        return
      }
      setSummary(previewData.summary as Summary)
      setPreview(previewData.preview as Preview)
      setManifestView((previewData.manifest as ManifestView | null) ?? null)
      setEditionInfo((previewData.edition as TallyEditionDisclosure | undefined) ?? null)
      setEditionProblems((previewData.editionProblems as TallyEditionProblem[] | undefined) ?? [])
      setAcknowledged(false)
      toast({ title: "Cut-over date applied" })
    } finally {
      setBusy("idle")
    }
  }

  async function apply() {
    if (!sessionId) return
    setBusy("applying")
    setReconcile(null)

    let guard = 0
    let previous = ""
    try {
      while (guard < 500) {
        guard += 1
        const response = await fetch(`/api/admin/tally/${sessionId}/apply`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ acknowledgeUnverified: acknowledged }),
        })
        const data = await response.json()
        if (!response.ok) {
          track("tally_cutover_blocked", { reason: cutoverBlockReason(data.code) })
          reportTallyFailure({
            step: "apply",
            outcome: "http",
            status: response.status,
            ...diagnosticFrom({ code: data.code }),
            sessionId,
          })
          toast({ variant: "destructive", title: data.error ?? "Apply stopped", description: data.progress ? `Stage: ${data.progress.stage}` : undefined })
          if (data.progress) setProgress(data.progress as Progress)
          return
        }

        setProgress(data.progress as Progress)

        const position = `${data.progress?.stage}:${data.progress?.offset}`
        if (data.done) {
          setCutoverAccess("complete")
          setReconcile((data.reconcile as ReconcileCheck[] | null) ?? null)
          track("tally_cutover_completed", {
            chunks: Number(summary?.chunkCount ?? 0),
            documents: Number(data.progress?.counts?.journals ?? 0),
          })
          toast({ title: "Tally cut-over applied" })
          return
        }
        if (position === previous) {
          toast({ variant: "destructive", title: "Apply stopped making progress", description: "Reload the session and continue." })
          return
        }
        previous = position
      }
      toast({ variant: "destructive", title: "Apply ran too long", description: "Reload the session to see where it stopped." })
    } catch (error) {
      // Without this the operator saw a stopped spinner and nothing else: the
      // refusal never reached the server, so it left no trace anywhere.
      reportTallyFailure({ step: "apply", outcome: "network", ...diagnosticFrom(error), sessionId })
      toast({
        variant: "destructive",
        title: "The cut-over could not continue",
        description: "The connection dropped mid-apply. Reload the session to see where it stopped.",
      })
    } finally {
      setBusy("idle")
    }
  }

  const currency = summary?.currency ?? "UGX"

  const setupConnection: SetupConnection = {
    token: bridgeToken,
    host: tallyHost,
    port: tallyPort,
    executable: tallyExecutable,
    company: tallyCompany,
  }

  // The setup assistant edits the same fields Step 1 uses, so finishing it
  // leaves the extraction ready to run with nothing retyped.
  function applySetupConnection(next: SetupConnection) {
    setBridgeToken(next.token)
    setTallyHost(next.host)
    setTallyPort(next.port)
    setTallyExecutable(next.executable)
    setTallyCompany(next.company)
    setBridgeCheck(null)
  }

  return (
    <div className="space-y-6">
      {setupOpen ? (
        <TallySetupAssistant
          origin={portalOrigin}
          connection={setupConnection}
          onChange={applySetupConnection}
          onClose={() => setSetupOpen(false)}
          onDone={() => {
            setSetupOpen(false)
            toast({
              title: "Tally connection verified",
              description: "Continue with Step 1 to read Tally and review the cut-over.",
            })
            void loadTallyCompanies()
          }}
          notify={(title, options) => toast({ title, ...options })}
        />
      ) : null}
      {cutoverAccess !== "ready" && (
        <div
          role={cutoverAccess === "error" ? "alert" : "status"}
          className="rounded-md border border-border bg-muted/40 px-4 py-3 text-sm"
        >
          {cutoverAccess === "checking" && "Checking Tally cut-over access…"}
          {cutoverAccess === "complete" &&
            "Tally cut-over is already complete for this pharmacy. The import is locked."}
          {cutoverAccess === "denied" &&
            "Only the pharmacy administrator can access the Tally cut-over workspace."}
          {cutoverAccess === "disabled" &&
            "The Tally cut-over is currently disabled for this deployment. Nothing can be uploaded or applied until it is turned back on."}
          {cutoverAccess === "error" &&
            "Could not verify Tally cut-over access. Reload the page before continuing."}
        </div>
      )}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl sm:text-3xl font-bold text-foreground">Tally cut-over</h1>
          <p className="text-muted-foreground mt-1 text-sm">
            Read Tally masters and dated voucher history into a reviewable cut-over. Nothing is written to
            Synapse until the pharmacy administrator explicitly applies the validated plan.
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" asChild>
            <a href="/api/admin/tally/template" download>
              <Download className="h-4 w-4" /> Excel template
            </a>
          </Button>
          <Button variant="outline" asChild>
            <a href="/api/admin/tally/template?format=csv" download>
              <Download className="h-4 w-4" /> CSV template
            </a>
          </Button>
        </div>
      </div>

      <div className="rounded-md border border-blue-500/40 bg-blue-500/10 px-3 py-2 text-sm">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="font-medium">Connect to the local Tally Bridge or upload an XML export.</p>
            <p className="mt-1 opacity-90">
              The bridge reads Tally&apos;s masters and vouchers over its local XML/HTTP interface, then
              sends the result through this same preview. Excel and CSV work only through the multi-sheet
              templates below; an ordinary Tally Excel report is not a complete company export. Use the stock
              import assistant for a single-sheet stock list. This is a one-time cut-over, not continuous
              synchronisation.
            </p>
          </div>
          <Button
            size="sm"
            variant="outline"
            className="bg-background/60"
            onClick={() => setSetupOpen(true)}
            disabled={cutoverAccess !== "ready"}
          >
            <Settings2 className="h-4 w-4" /> Set up Tally connection
          </Button>
        </div>
      </div>

      <TallyDocumentProbe enabled={cutoverAccess === "ready" || cutoverAccess === "complete"} />

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Upload className="h-5 w-5 text-primary" />
            Step 1 — Upload the export
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-3 rounded-lg border border-dashed p-4">
            <div className="flex items-center gap-2">
              <Terminal className="h-4 w-4 text-primary" />
              <p className="text-sm font-medium">Start the bridge on this computer</p>
            </div>
            <p className="text-xs text-muted-foreground">
              Run the installer once from the unzipped connector package. It installs Node.js 22 if it is
              missing, writes the configuration and prints the token to paste below. Open Tally, sign in, and
              select the company being cut over before running it. The bridge listens only on 127.0.0.1 and
              cannot type a Tally password or choose a company for you.
            </p>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="tally-host">Tally host</Label>
                <Input
                  id="tally-host"
                  value={tallyHost}
                  onChange={(event) => setTallyHost(event.target.value)}
                  placeholder="127.0.0.1"
                  autoComplete="off"
                />
                <p className="text-xs text-muted-foreground">
                  This PC, or the Tally PC&apos;s private IPv4 address.
                </p>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="tally-port">Tally HTTP port</Label>
                <Input
                  id="tally-port"
                  value={tallyPort}
                  onChange={(event) => setTallyPort(event.target.value)}
                  placeholder="9000"
                  inputMode="numeric"
                  autoComplete="off"
                />
                <p className="text-xs text-muted-foreground">Tally&apos;s XML/HTTP server, 9000 by default.</p>
              </div>
              <div className="space-y-1.5 sm:col-span-2">
                <Label htmlFor="tally-company">Tally company</Label>
                <div className="flex flex-wrap gap-2">
                  {tallyCompanies.length > 0 ? (
                    <select
                      id="tally-company"
                      value={tallyCompany}
                      onChange={(event) => setTallyCompany(event.target.value)}
                      disabled={cutoverAccess !== "ready" || busy !== "idle"}
                      className="h-10 min-w-64 flex-1 rounded-md border border-input bg-background px-3 py-2 text-sm"
                    >
                      {tallyCompany && !tallyCompanies.includes(tallyCompany) ? (
                        <option value={tallyCompany}>{tallyCompany}</option>
                      ) : null}
                      {tallyCompanies.map((company) => (
                        <option key={company} value={company}>
                          {company}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <Input
                      id="tally-company"
                      value={tallyCompany}
                      onChange={(event) => setTallyCompany(event.target.value)}
                      placeholder="Company name, exactly as Tally shows it"
                      autoComplete="off"
                      disabled={cutoverAccess !== "ready" || busy !== "idle"}
                      className="min-w-64 flex-1"
                    />
                  )}
                </div>
                <p className="text-xs text-muted-foreground">
                  {tallyCompanies.length > 0
                    ? `Found by Check bridge${bridgeEdition && bridgeEdition !== "unknown" ? ` on Tally ${bridgeEdition === "prime" ? "Prime" : "ERP 9"}` : ""}. The command below pins this company; run it again after changing it.`
                    : "Run Check bridge to list the companies Tally has open, or type the name exactly."}
                </p>
                {tallyCompany.trim() ? null : (
                  <p className="text-xs text-destructive">
                    Required. Without it the bridge refuses to export anything, because an export
                    that does not name its company cannot be checked.
                  </p>
                )}
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="tally-executable">Tally program path (optional)</Label>
                <Input
                  id="tally-executable"
                  value={tallyExecutable}
                  onChange={(event) => setTallyExecutable(event.target.value)}
                  placeholder="C:\Program Files\TallyPrime\tally.exe"
                  autoComplete="off"
                />
                <p className="text-xs text-muted-foreground">
                  Launched only when nothing answers on the port above.
                </p>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="tally-from-date">History from</Label>
                <Input
                  id="tally-from-date"
                  value={tallyFromDate}
                  onChange={(event) => setTallyFromDate(event.target.value)}
                  placeholder="20200401"
                  inputMode="numeric"
                  autoComplete="off"
                />
                <p className="text-xs text-muted-foreground">
                  YYYYMMDD. Required for a live extraction, which reads the history in date ranges. A
                  manual file upload can leave it blank.
                </p>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="tally-to-date">Balances close on (optional)</Label>
                <Input
                  id="tally-to-date"
                  value={tallyToDate}
                  onChange={(event) => setTallyToDate(event.target.value)}
                  placeholder="20260331"
                  inputMode="numeric"
                  autoComplete="off"
                />
                <p className="text-xs text-muted-foreground">
                  YYYYMMDD. The date Tally reports closing balances for. Leave blank for today.
                </p>
              </div>
            </div>
            <div className="space-y-2">
              <Label>Install the connector (first time on this computer)</Label>
              <div className="rounded-md bg-muted p-3">
                <pre className="overflow-x-auto whitespace-pre-wrap break-all text-xs">{installCommand}</pre>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Button variant="outline" onClick={() => void copyCommand(installCommand, "Installer command")}>
                  <Copy className="h-4 w-4" /> Copy installer
                </Button>
                <span className="text-xs text-muted-foreground">
                  Paste it into PowerShell, not Command Prompt. It prints the token once — the token is
                  generated on this computer and never leaves it.
                </span>
              </div>
            </div>
            {pinCommand ? (
              <div className="space-y-2">
                <Label>Start it later, pinned to this company</Label>
                <div className="rounded-md bg-muted p-3">
                  <pre className="overflow-x-auto whitespace-pre-wrap break-all text-xs">{pinCommand}</pre>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <Button variant="outline" onClick={() => void copyCommand(pinCommand, "Start command")}>
                    <Copy className="h-4 w-4" /> Copy start command
                  </Button>
                  <span className="text-xs text-muted-foreground">
                    The Start Menu shortcut starts it with the company the installer pinned.
                  </span>
                </div>
              </div>
            ) : null}
          </div>

          <div className="space-y-2 rounded-lg border p-4">
            <Label htmlFor="tally-bridge-token">Local Tally Bridge token</Label>
            <div className="flex flex-wrap gap-2">
              <Input
                id="tally-bridge-token"
                type="password"
                autoComplete="off"
                value={bridgeToken}
                onChange={(event) => {
                  setBridgeToken(event.target.value)
                  setBridgeCheck(null)
                }}
                placeholder="Paste the 64-character token from the Windows terminal"
                disabled={cutoverAccess !== "ready" || busy !== "idle"}
                className="min-w-64 flex-1"
              />
              <Button
                variant="outline"
                onClick={() => void connectToTally()}
                disabled={cutoverAccess !== "ready" || busy !== "idle" || !bridgeToken.trim()}
              >
                {busy === "connecting" || busy === "extracting" ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <RefreshCw className="h-4 w-4" />
                )}
                {busy === "extracting"
                  ? "Extracting…"
                  : busy === "connecting"
                    ? "Reading Tally…"
                    : "Connect and review"}
              </Button>
              <Button
                variant="ghost"
                onClick={() => void checkBridge()}
                disabled={cutoverAccess !== "ready" || busy !== "idle" || !bridgeToken.trim() || checkingBridge}
              >
                {checkingBridge ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <CheckCircle2 className="h-4 w-4" />
                )}
                Check bridge
              </Button>
            </div>
            {bridgeCheck ? (
              <p
                className={`text-xs ${
                  bridgeCheck.status === "ok"
                    ? "text-[#22C55E]"
                    : bridgeCheck.status === "tally"
                      ? "text-[#E8B84B]"
                      : "text-destructive"
                }`}
              >
                {bridgeCheck.message}
              </p>
            ) : null}
            <p className="text-xs text-muted-foreground">
              The bridge must be running on this computer. The token stays in this page only and is not saved.
              Connect reads data; it does not apply or post it.
            </p>
          </div>

          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <span className="h-px flex-1 bg-border" />
            or choose an existing export
            <span className="h-px flex-1 bg-border" />
          </div>

          <div className="space-y-1.5">
            <Label>What this export carries</Label>
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                size="sm"
                variant={mode === "opening" ? "default" : "outline"}
                onClick={() => setMode("opening")}
                disabled={cutoverAccess !== "ready" || busy !== "idle"}
              >
                Opening balances and history
              </Button>
              <Button
                type="button"
                size="sm"
                variant={mode === "closing" ? "default" : "outline"}
                onClick={() => setMode("closing")}
                disabled={cutoverAccess !== "ready" || busy !== "idle"}
              >
                Closing balances only
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              {mode === "opening"
                ? "Tally's opening balances are posted, then the Day Book vouchers are replayed on top."
                : "The balances the export closes on become the opening in Synapse, and no voucher is posted. Use this when you are starting Synapse from Tally's closing position rather than rebuilding the history."}
            </p>
          </div>

          <div className="grid gap-4 md:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="tally-file">
                Tally XML, workbook or CSV (max 25 MB each; choose several to build the history in slices)
              </Label>
              <Input
                id="tally-file"
                ref={fileInput}
                type="file"
                multiple
                accept={ACCEPTED}
                disabled={cutoverAccess !== "ready"}
                onChange={(event) => {
                  setFiles(Array.from(event.target.files ?? []))
                }}
              />
              {files.length > 0 && (
                <ul className="space-y-0.5 text-xs text-muted-foreground">
                  {files.map((entry) => {
                    const named = periodFromFileName(entry.name)
                    return (
                      <li key={`${entry.name}-${entry.size}`}>
                        {entry.name} · {(entry.size / 1024 / 1024).toFixed(2)} MB
                        {files.length > 1
                          ? named
                            ? ` · covers ${named.from} to ${named.to}`
                            : " · no dates in its name; the period fields above are used for it"
                          : ""}
                      </li>
                    )
                  })}
                </ul>
              )}
              {files.length > 1 && (
                <p className="text-xs text-muted-foreground">
                  A file whose name ends in the dates it covers, like{" "}
                  <span className="font-mono">3-daybook-20250101-20251231.xml</span>, is placed by
                  those dates. The export script on the pharmacy computer writes them that way.
                </p>
              )}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="cutover-date">
                {mode === "closing" ? "Balances as at" : "Cut-over date"}
              </Label>
              <Input
                id="cutover-date"
                type="date"
                value={conversionDate}
                onChange={(event) => setConversionDate(event.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                {mode === "closing"
                  ? "The export's closing balances are taken as at this date and become the opening in Synapse."
                  : "Balances are read as at this date. Vouchers before it are flagged, never double-posted."}
              </p>
            </div>
          </div>

          {stagedFiles.length > 0 && (
            <div className="space-y-3 rounded-lg border p-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-sm font-semibold">Files in this cut-over — {stagedFiles.length}</p>
                <p className="text-xs text-muted-foreground">
                  They are read together, once, before anything is applied.
                </p>
              </div>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>File</TableHead>
                    <TableHead>Covers</TableHead>
                    <TableHead className="text-right">Records</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {stagedFiles.map((entry) => (
                    <TableRow key={entry.uploadId}>
                      <TableCell className="max-w-[18rem] truncate">{entry.fileName}</TableCell>
                      <TableCell>
                        {entry.kind === "masters"
                          ? "Accounts, parties and stock"
                          : formatPeriod(entry.range)}
                      </TableCell>
                      <TableCell className="text-right">
                        {entry.recordsRead.toLocaleString()}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>

              {stagedProblems.length > 0 && (
                <div className="rounded-lg border border-[#E8B84B]/50 bg-[#E8B84B]/10 p-3 text-xs">
                  <p className="flex items-center gap-2 font-semibold">
                    <AlertTriangle className="h-4 w-4" />
                    Not ready to apply yet
                  </p>
                  <ul className="mt-1 space-y-1">
                    {stagedProblems.map((entry) => (
                      <li key={entry}>{entry}</li>
                    ))}
                  </ul>
                </div>
              )}

              {replacePrompt && (
                <div className="rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-xs">
                  <p className="font-semibold">A file is already staged for these dates.</p>
                  <p className="mt-1 text-muted-foreground">
                    {replacePrompt.file.name} covers the same dates as a file already in this
                    cut-over. Replace the staged one with this file?
                  </p>
                  <div className="mt-2 flex gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => void stageAndPreview([replacePrompt.file], true)}
                      disabled={busy !== "idle"}
                    >
                      Replace it
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => setReplacePrompt(null)}
                      disabled={busy !== "idle"}
                    >
                      Keep the existing file
                    </Button>
                  </div>
                </div>
              )}
            </div>
          )}

          <div className="flex flex-wrap gap-2">
            <Button onClick={() => void uploadAndReview()} disabled={cutoverAccess !== "ready" || busy !== "idle" || files.length === 0}>
              {busy === "uploading" || busy === "preview" ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <FileSpreadsheet className="h-4 w-4" />
              )}
              {busy === "uploading"
                ? "Uploading…"
                : busy === "preview"
                  ? "Reading…"
                  : files.length === 1 && stagedFiles.length === 0
                    ? "Upload and review"
                    : "Add files and review"}
            </Button>
            {stagedFiles.length > 0 && (
              <Button
                variant="outline"
                onClick={() => void previewStaged()}
                disabled={cutoverAccess !== "ready" || busy !== "idle"}
              >
                {busy === "preview" ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <RefreshCw className="h-4 w-4" />
                )}
                Read the files staged so far
              </Button>
            )}
            {sessionId && (
              <Button variant="outline" onClick={() => void loadSession(sessionId)} disabled={busy !== "idle"}>
                <RefreshCw className="h-4 w-4" /> Reload session
              </Button>
            )}
          </div>
        </CardContent>
      </Card>

      {extraction && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <RefreshCw className="h-5 w-5 text-primary" />
              Extraction — {extraction.complete} of {extraction.totalChunks} ranges read
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <Stat
                label="Ranges read"
                value={`${extraction.complete} / ${extraction.totalChunks}`}
                tone={extraction.completeAll ? undefined : "warn"}
              />
              <Stat label="Records read" value={extraction.recordsRead.toLocaleString()} />
              <Stat
                label="Ranges failed"
                value={String(extraction.failed)}
                tone={extraction.failed > 0 ? "bad" : undefined}
              />
              <Stat label="Attempts" value={String(extraction.attempts)} />
            </div>

            {extraction.coveredFrom || extraction.gaps.length > 0 ? (
              <p className="text-xs text-muted-foreground">
                {extraction.coveredFrom && extraction.coveredTo
                  ? `Dates read: ${extraction.coveredFrom} to ${extraction.coveredTo}`
                  : "No range has been read yet."}
                {extraction.gaps.length > 0
                  ? ` · ${extraction.gaps.length} stretch${extraction.gaps.length === 1 ? "" : "es"} of the period have no read range`
                  : ""}
              </p>
            ) : null}

            {extraction.gaps.length > 0 && (
              <div className="rounded-lg border border-[#E8B84B]/50 bg-[#E8B84B]/10 p-4">
                <p className="flex items-center gap-2 text-sm font-semibold">
                  <AlertTriangle className="h-4 w-4" />
                  Dates no read range covers
                </p>
                <ul className="mt-2 space-y-1 text-xs">
                  {extraction.gaps.map((gap) => (
                    <li key={`${gap.after}-${gap.before}`} className="font-mono">
                      {gap.after} → {gap.before}
                    </li>
                  ))}
                </ul>
                <p className="mt-2 text-xs text-muted-foreground">
                  Apply stays disabled until every range is read.
                </p>
              </div>
            )}

            {extraction.failures.length > 0 && (
              <div className="rounded-lg border border-destructive/40 bg-destructive/5 p-4">
                <p className="flex items-center gap-2 text-sm font-semibold">
                  <AlertTriangle className="h-4 w-4" />
                  {extraction.failures.length} range{extraction.failures.length === 1 ? "" : "s"} could not
                  be read
                </p>
                <div className="mt-2 max-h-48 space-y-1 overflow-y-auto text-xs">
                  {extraction.failures.map((failure) => (
                    <div key={failure.id}>
                      <span className="font-mono text-[10px] uppercase opacity-70">{failure.id}</span>{" "}
                      {failure.error ?? "No reason was recorded."}{" "}
                      <span className="text-muted-foreground">
                        (attempt {failure.attempts})
                      </span>
                    </div>
                  ))}
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  className="mt-3"
                  onClick={() => void resumeExtraction()}
                  disabled={busy !== "idle" || !sessionId || !bridgeToken.trim()}
                >
                  {busy === "extracting" ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <RefreshCw className="h-4 w-4" />
                  )}
                  Retry unfinished ranges
                </Button>
              </div>
            )}

            {consolidation && (
              <div className="space-y-3 rounded-lg border p-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-sm font-semibold">
                    Merged from {consolidation.parts} read{consolidation.parts === 1 ? "" : "s"}
                  </p>
                  <span
                    className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                      consolidation.reconciliation === "verified"
                        ? "bg-[#22C55E]/15 text-[#22C55E]"
                        : consolidation.reconciliation === "mismatch"
                          ? "bg-destructive/15 text-destructive"
                          : "bg-[#E8B84B]/15 text-[#E8B84B]"
                    }`}
                  >
                    {consolidation.reconciliation === "verified"
                      ? "Counted against Tally"
                      : consolidation.reconciliation === "mismatch"
                        ? "Count does not match Tally"
                        : "No independent count"}
                  </span>
                </div>
                <div className="grid gap-4 text-sm sm:grid-cols-2 lg:grid-cols-4">
                  <div>
                    <p className="text-xs uppercase tracking-wide text-muted-foreground">Master records</p>
                    <p className="text-lg font-semibold">{consolidation.masters.total.toLocaleString()}</p>
                    <p className="text-xs text-muted-foreground">
                      {consolidation.masters.duplicates} repeat
                      {consolidation.masters.duplicates === 1 ? "" : "s"} removed ·{" "}
                      {consolidation.masters.conflicts} conflict
                      {consolidation.masters.conflicts === 1 ? "" : "s"}
                    </p>
                  </div>
                  <div>
                    <p className="text-xs uppercase tracking-wide text-muted-foreground">Vouchers</p>
                    <p className="text-lg font-semibold">{consolidation.vouchers.unique.toLocaleString()}</p>
                    <p className="text-xs text-muted-foreground">
                      {consolidation.vouchers.read.toLocaleString()} read ·{" "}
                      {consolidation.vouchers.duplicates} duplicate
                      {consolidation.vouchers.duplicates === 1 ? "" : "s"} dropped
                    </p>
                  </div>
                  <div>
                    <p className="text-xs uppercase tracking-wide text-muted-foreground">Cancelled</p>
                    <p className="text-lg font-semibold">{consolidation.vouchers.cancelled.toLocaleString()}</p>
                    <p className="text-xs text-muted-foreground">Kept out of the posted history</p>
                  </div>
                  <div>
                    <p className="text-xs uppercase tracking-wide text-muted-foreground">No identifier</p>
                    <p className="text-lg font-semibold">{consolidation.vouchers.keyless.toLocaleString()}</p>
                    <p className="text-xs text-muted-foreground">
                      Kept — they cannot be proven duplicates
                    </p>
                  </div>
                </div>

                {consolidation.vouchers.unsupported.length > 0 && (
                  <div className="rounded-md bg-muted p-3">
                    <p className="text-xs font-semibold">Types this cut-over does not post</p>
                    <ul className="mt-1 space-y-1 text-xs">
                      {consolidation.vouchers.unsupported.map((entry) => (
                        <li key={entry.type}>
                          <span className="font-medium">{entry.type}</span> — {entry.count} voucher
                          {entry.count === 1 ? "" : "s"}: {entry.reason ?? "not a supported voucher type"}
                        </li>
                      ))}
                    </ul>
                    <p className="mt-1 text-xs text-muted-foreground">
                      They are counted above and stay in Tally; nothing is dropped without being listed.
                    </p>
                  </div>
                )}

                {consolidation.totals.length > 0 && (
                  <div>
                    <p className="text-xs font-semibold">
                      Amounts by type — compare these with Tally&apos;s own report
                    </p>
                    <div className="mt-1 grid gap-1 text-xs sm:grid-cols-2">
                      {consolidation.totals.map((total) => (
                        <div key={total.type} className="flex justify-between gap-4 border-b py-1">
                          <span>{total.type}</span>
                          <span className="font-mono">{money(total.amount, summary?.currency ?? "UGX")}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {consolidation.problems.length > 0 && (
                  <div className="space-y-1 text-xs text-destructive">
                    {consolidation.problems.map((problem) => (
                      <p key={problem}>{problem}</p>
                    ))}
                  </div>
                )}
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {summary && (
        <>
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <BookOpen className="h-5 w-5 text-primary" />
                Step 2 — Review {summary.company ? `· ${summary.company}` : ""}
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <p className="text-xs text-muted-foreground">
                {summary.mode === "closing"
                  ? `Balances as at ${summary.conversionDate} — no Tally voucher is posted.`
                  : `Opening balances as at ${summary.conversionDate}, then ${summary.counts.postedVouchers} vouchers replayed.`}
              </p>

              {editionInfo && (
                <div className="rounded-lg border p-3">
                  <p className="text-xs">
                    <span className="font-medium">Source edition · {editionInfo.label}</span>{" "}
                    <span className="text-muted-foreground">
                      {editionInfo.verified
                        ? "confirmed against a real installation"
                        : "not confirmed against a real installation"}
                    </span>
                  </p>
                  {editionProblems.map((problem) => (
                    <p
                      key={problem.code}
                      className="mt-1 text-xs text-amber-600 dark:text-amber-500"
                    >
                      {problem.message}
                    </p>
                  ))}
                </div>
              )}
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                <Stat label="Ledger accounts" value={String(summary.counts.ledgers)} />
                <Stat label="Stock items" value={String(summary.counts.stockItems)} />
                <Stat label="Vouchers to post" value={String(summary.counts.postedVouchers)} />
                <Stat
                  label="Vouchers skipped"
                  value={String(summary.counts.skippedVouchers)}
                  tone={summary.counts.skippedVouchers > 0 ? "warn" : undefined}
                />
              </div>

              <div className="rounded-lg border p-4">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <p className="text-sm font-medium">
                      {summary.mode === "closing" ? "Trial balance carried forward" : "Opening trial balance"} ·{" "}
                      {summary.opening.date}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      Debit {money(summary.opening.totalDebit, currency)} · Credit{" "}
                      {money(summary.opening.totalCredit, currency)}
                    </p>
                  </div>
                  <div
                    className={`text-lg font-semibold ${balanced ? "text-[#22C55E]" : "text-destructive"}`}
                  >
                    {balanced ? "Balanced" : `Out by ${money(summary.opening.difference, currency)}`}
                  </div>
                </div>
                {!balanced && (
                  <p className="mt-2 text-xs text-muted-foreground">
                    The opening journal is not posted while the two sides differ. Nothing is plugged — fix the
                    export or the account mapping and review again.
                  </p>
                )}
              </div>

              {summary.stock && (
                <div className="rounded-lg border p-4">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <p className="text-sm font-medium">Stock valuation · Tally profit and loss</p>
                    <span className="text-xs text-muted-foreground">
                      {summary.stock.itemCount} stock item
                      {summary.stock.itemCount === 1 ? "" : "s"} in the export
                    </span>
                  </div>
                  <div className="mt-3 grid gap-4 sm:grid-cols-2">
                    <div>
                      <p className="text-xs uppercase tracking-wide text-muted-foreground">Opening stock</p>
                      <p className="text-lg font-semibold">{money(summary.stock.openingValue, currency)}</p>
                      <p className="text-xs text-muted-foreground">
                        {summary.stock.itemsWithOpeningValue} of {summary.stock.itemCount} items carry an opening
                        value
                      </p>
                    </div>
                    <div>
                      <p className="text-xs uppercase tracking-wide text-muted-foreground">Closing stock</p>
                      <p className="text-lg font-semibold">{money(summary.stock.closingValue, currency)}</p>
                      <p className="text-xs text-muted-foreground">
                        {summary.stock.closingValue === null
                          ? `Not in this export — ${summary.stock.itemsWithClosingValue} of ${summary.stock.itemCount} items carry a closing value`
                          : `${summary.stock.itemsWithClosingValue} of ${summary.stock.itemCount} items carry a closing value`}
                      </p>
                    </div>
                  </div>
                  <p className="mt-3 text-xs text-muted-foreground">
                    {summary.mode === "closing"
                      ? "In closing-balances mode these figures become the opening in Synapse: the closing stock is posted as opening stock and no voucher is replayed."
                      : "These are Tally's own figures for the exported period. The cut-over posts opening stock and the history you imported; it does not post a closing balance, and nothing here is adjusted to make the two sides agree."}
                  </p>
                  {summary.stock.closingValue === null && (
                    <p className="mt-1 text-xs text-muted-foreground">
                      To see closing stock, export the stock summary, or set the Tally export period to end on the
                      cut-over date.
                    </p>
                  )}
                </div>
              )}

              {summary.exceptions.length > 0 && (
                <div className="rounded-lg border border-[#E8B84B]/50 bg-[#E8B84B]/10 p-4">
                  <p className="flex items-center gap-2 text-sm font-semibold">
                    <AlertTriangle className="h-4 w-4" />
                    {summary.exceptions.length} item
                    {summary.exceptions.length === 1 ? "" : "s"} need a decision
                  </p>
                  <div className="mt-2 max-h-64 space-y-2 overflow-y-auto">
                    {summary.exceptions.map((entry, index) => (
                      <div key={`${entry.code}-${index}`} className="text-xs">
                        <span className="font-mono text-[10px] uppercase opacity-70">{entry.code}</span>{" "}
                        <span className={entry.severity === "blocking" ? "font-medium" : ""}>{entry.message}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {manifestView && (
                <div
                  className={`rounded-lg border p-4 ${
                    unverifiedCoverage
                      ? "border-[#E8B84B]/50 bg-[#E8B84B]/10"
                      : "border-[#22C55E]/40 bg-[#22C55E]/10"
                  }`}
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="flex items-center gap-2 text-sm font-semibold">
                      <AlertTriangle className="h-4 w-4" />
                      {unverifiedCoverage
                        ? "Source completeness not independently verified"
                        : manifestView.coverage === "verified"
                          ? "Source completeness verified"
                          : "Source plan unavailable"}
                    </p>
                    <span className="text-xs text-muted-foreground">
                      Period used: {formatPeriod(manifestView.period) ?? "not established"}
                      {manifestView.periodSource === "source"
                        ? " (stated by the export)"
                        : manifestView.periodSource === "requested"
                          ? " (the period that was requested)"
                          : ""}
                    </span>
                  </div>

                  {manifestView.reason && (
                    <p className="mt-2 text-xs">{manifestView.reason}</p>
                  )}

                  <div className="mt-3 grid gap-3 text-xs sm:grid-cols-2 lg:grid-cols-3">
                    <div>
                      <p className="text-muted-foreground">Period requested</p>
                      <p className="font-medium">{formatPeriod(evidence?.requestedPeriod) ?? "Not recorded"}</p>
                    </div>
                    <div>
                      <p className="text-muted-foreground">Period stated by the export</p>
                      <p className="font-medium">{formatPeriod(evidence?.declaredPeriod) ?? "Not stated"}</p>
                    </div>
                    <div>
                      <p className="text-muted-foreground">Voucher dates actually read</p>
                      <p className="font-medium">
                        {evidence?.voucherRange.firstDate
                          ? `${evidence.voucherRange.firstDate} to ${evidence.voucherRange.lastDate}`
                          : "No voucher dates"}
                      </p>
                    </div>
                    <div>
                      <p className="text-muted-foreground">Records read</p>
                      <p className="font-medium">
                        {evidence ? evidence.recordsRead.toLocaleString() : "Not recorded"}
                      </p>
                    </div>
                    <div>
                      <p className="text-muted-foreground">Records staged</p>
                      <p className="font-medium">
                        {evidence?.recordsStaged
                          ? `${evidence.recordsStaged.accounts} accounts, ${evidence.recordsStaged.parties} parties, ${evidence.recordsStaged.products} products, ${evidence.recordsStaged.vouchers} vouchers`
                          : "Not recorded"}
                      </p>
                    </div>
                    <div>
                      <p className="text-muted-foreground">Independent source count</p>
                      <p className="font-medium">
                        {evidence?.independentCount ? "Provided" : "None supplied"}
                      </p>
                    </div>
                  </div>

                  {unverifiedCoverage ? (
                    <>
                      <p className="mt-3 text-xs">
                        Nothing counted this export independently, so Synapse cannot prove that every record in the
                        period was read. Applying accepts that risk; the coverage stays unverified and the cut-over
                        is not marked complete on that basis.
                      </p>
                      <label className="mt-3 flex cursor-pointer items-start gap-2">
                        <input
                          id="tally-unverified-ack"
                          type="checkbox"
                          checked={acknowledged}
                          onChange={(event) => setAcknowledged(event.target.checked)}
                          className="mt-0.5 rounded"
                        />
                        <span className="text-sm">
                          I have reviewed the evidence above and understand that source completeness has not been
                          independently verified.
                        </span>
                      </label>
                    </>
                  ) : (
                    manifestView.coverage === "verified" && (
                      <p className="mt-3 text-xs">
                        An independent count matched what was read for every part of this period.
                      </p>
                    )
                  )}

                  {manifestView.problems.length > 0 && (
                    <div className="mt-3 space-y-1">
                      {manifestView.problems.map((problem, index) => (
                        <p key={`${problem}-${index}`} className="text-xs text-destructive">
                          {problem}
                        </p>
                      ))}
                    </div>
                  )}
                </div>
              )}

              <div className="flex flex-wrap items-end gap-2">
                <div className="space-y-1.5">
                  <Label htmlFor="cutover-date-2">
                    {mode === "closing" ? "Balances as at" : "Cut-over date"}
                  </Label>
                  <Input
                    id="cutover-date-2"
                    type="date"
                    value={conversionDate}
                    onChange={(event) => setConversionDate(event.target.value)}
                  />
                </div>
                <Button variant="outline" onClick={() => void saveMapping()} disabled={cutoverAccess !== "ready" || busy !== "idle"}>
                  {busy === "saving" ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
                  Save and re-read
                </Button>
              </div>
            </CardContent>
          </Card>

          {preview && (
            <div className="grid gap-6 lg:grid-cols-2">
              <Card>
                <CardHeader>
                  <CardTitle className="text-base">Chart of accounts</CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="max-h-80 overflow-y-auto">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Code</TableHead>
                          <TableHead>Tally ledger</TableHead>
                          <TableHead>Type</TableHead>
                          <TableHead>Opening</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {preview.accounts.map((account) => (
                          <TableRow key={account.code}>
                            <TableCell className="font-mono text-xs">{account.code}</TableCell>
                            <TableCell>
                              {account.name}
                              {account.unclassified && (
                                <span className="ml-1 text-[10px] text-[#E8B84B]">unclassified</span>
                              )}
                            </TableCell>
                            <TableCell className="text-xs text-muted-foreground">
                              {account.accountType} · {account.role}
                            </TableCell>
                            <TableCell className="text-xs">
                              {money(account.openingBalance, currency)}{" "}
                              <span className="opacity-60">{account.openingSide}</span>
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                  <p className="mt-2 text-xs text-muted-foreground">
                    Showing {preview.accounts.length} of {preview.accountTotal}
                  </p>
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle className="text-base">Stock items</CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="max-h-80 overflow-y-auto">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>SKU</TableHead>
                          <TableHead>Item</TableHead>
                          <TableHead>Qty</TableHead>
                          <TableHead>Opening value</TableHead>
                          <TableHead>Closing value</TableHead>
                          <TableHead>Batches</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {preview.stockItems.map((item) => (
                          <TableRow key={item.sku}>
                            <TableCell className="font-mono text-xs">{item.sku}</TableCell>
                            <TableCell>{item.name}</TableCell>
                            <TableCell className="text-xs">
                              {item.quantity ?? "—"} {item.unit ?? ""}
                            </TableCell>
                            <TableCell className="text-xs">{money(item.openingValue, currency)}</TableCell>
                            <TableCell className="text-xs">{money(item.closingValue, currency)}</TableCell>
                            <TableCell className="text-xs">
                              {item.receivableBatches} receivable
                              {item.expiredBatches > 0 && (
                                <span className="text-destructive"> · {item.expiredBatches} expired</span>
                              )}
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                  <p className="mt-2 text-xs text-muted-foreground">
                    Showing {preview.stockItems.length} of {preview.stockItemTotal}. Expired opening batches stay in
                    the ledger and are not received into sellable stock.
                  </p>
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle className="text-base">Parties</CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="max-h-80 overflow-y-auto">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Name</TableHead>
                          <TableHead>Kind</TableHead>
                          <TableHead>Opening</TableHead>
                          <TableHead>Bills</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {preview.parties.map((party) => (
                          <TableRow key={`${party.kind}-${party.accountCode}`}>
                            <TableCell>{party.name}</TableCell>
                            <TableCell className="text-xs">{party.kind}</TableCell>
                            <TableCell className="text-xs">{money(party.openingBalance, currency)}</TableCell>
                            <TableCell className="text-xs">{party.billCount}</TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                  <p className="mt-2 text-xs text-muted-foreground">
                    Showing {preview.parties.length} of {preview.partyTotal}
                  </p>
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle className="text-base">Vouchers</CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="max-h-80 overflow-y-auto">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Date</TableHead>
                          <TableHead>Type</TableHead>
                          <TableHead>Number</TableHead>
                          <TableHead>Total</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {preview.vouchers.map((voucher) => (
                          <TableRow key={voucher.sourceId}>
                            <TableCell className="text-xs">{voucher.date}</TableCell>
                            <TableCell className="text-xs">{voucher.kind}</TableCell>
                            <TableCell className="text-xs">
                              {voucher.number ?? "—"}
                              {voucher.partyName && (
                                <span className="block opacity-60">{voucher.partyName}</span>
                              )}
                            </TableCell>
                            <TableCell className="text-xs">{money(voucher.total, currency)}</TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                  <p className="mt-2 text-xs text-muted-foreground">
                    Showing {preview.vouchers.length} of {preview.voucherTotal} · {preview.salesTotal} sales,{" "}
                    {preview.purchasesTotal} purchases mirror into reports
                  </p>
                </CardContent>
              </Card>
            </div>
          )}

          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <ArrowRight className="h-5 w-5 text-primary" />
                Step 3 — Apply
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <p className="text-sm text-muted-foreground">
                Apply runs in steps and saves its place after each one. You can close this page and continue
                later; every step is safe to repeat.
              </p>

              {preflightView && (
                <div className="rounded-lg border p-4">
                  <p className="text-sm font-medium">
                    Cut-over preflight — {PREFLIGHT_STATE_LABEL[preflightView.state] ?? preflightView.state}
                  </p>
                  <ul className="mt-2 space-y-1 text-xs">
                    {preflightView.checks
                      .filter((entry) => entry.status !== "pass")
                      .map((entry) => (
                        <li key={entry.id} className="flex gap-2">
                          <span
                            className={
                              entry.status === "fail" ? "text-destructive" : "text-[#E8B84B]"
                            }
                          >
                            {entry.status === "fail"
                              ? entry.blocksApply
                                ? "Blocked"
                                : "Failed"
                              : entry.status === "unavailable"
                                ? "Unverified"
                                : "Note"}
                          </span>
                          <span>
                            <span className="font-medium">{entry.label}:</span> {entry.detail}
                          </span>
                        </li>
                      ))}
                    {preflightView.checks.every((entry) => entry.status === "pass") && (
                      <li className="text-muted-foreground">Every preflight check passed.</li>
                    )}
                  </ul>
                </div>
              )}

              <div className="flex flex-wrap gap-2">
                <Button onClick={() => void apply()} disabled={!canApply}>
                  {busy === "applying" ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}
                  {busy === "applying" ? "Applying…" : "Apply cut-over"}
                </Button>
                {!balanced && (
                  <span className="self-center text-xs text-destructive">
                    Apply is blocked while the opening trial balance is out.
                  </span>
                )}
                {needsAcknowledgement && (
                  <span className="self-center text-xs text-[#E8B84B]">
                    Tick the completeness acknowledgement in Step 2 before applying.
                  </span>
                )}
              </div>

              {progress && (
                <div className="rounded-lg border p-4">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="text-sm font-medium">
                      {STAGE_LABEL[progress.stage] ?? progress.stage}
                      {progress.stage === "journals" && ` · chunk ${progress.offset + 1} of ${summary.chunkCount}`}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      Updated {new Date(progress.updatedAt).toLocaleString()}
                    </p>
                  </div>
                  <div className="mt-3 grid gap-3 sm:grid-cols-3 lg:grid-cols-6">
                    <Stat label="Accounts" value={String(progress.counts.accounts)} />
                    <Stat label="Parties" value={String(progress.counts.parties)} />
                    <Stat label="Products" value={String(progress.counts.products)} />
                    <Stat label="Vouchers" value={String(progress.counts.journals)} />
                    <Stat label="Sales" value={String(progress.counts.sales)} />
                    <Stat label="Purchases" value={String(progress.counts.purchases)} />
                  </div>
                  {progress.failures.length > 0 && (
                    <div className="mt-3">
                      <p className="text-sm font-medium text-[#E8B84B]">
                        {progress.failures.length} item{progress.failures.length === 1 ? "" : "s"} could not be imported
                      </p>
                      <div className="mt-1 max-h-48 space-y-1 overflow-y-auto">
                        {progress.failures.map((failure, index) => (
                          <div key={`${failure.code}-${index}`} className="text-xs">
                            <span className="font-mono text-[10px] uppercase opacity-70">{failure.code}</span>{" "}
                            <span className="opacity-80">{failure.key}</span> — {failure.message}
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )}
            </CardContent>
          </Card>
        </>
      )}

      {reconcile && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <CheckCircle2 className="h-5 w-5 text-[#22C55E]" />
              Reconciliation
            </CardTitle>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Check</TableHead>
                  <TableHead>Expected</TableHead>
                  <TableHead>Actual</TableHead>
                  <TableHead>Difference</TableHead>
                  <TableHead>Result</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {reconcile.map((check) => (
                  <TableRow key={check.id}>
                    <TableCell className="text-sm">{check.label}</TableCell>
                    <TableCell className="text-xs">{check.expected ?? "—"}</TableCell>
                    <TableCell className="text-xs">{check.actual ?? "—"}</TableCell>
                    <TableCell className="text-xs">{check.difference ?? "—"}</TableCell>
                    <TableCell className="text-xs">
                      {check.status === "ok" ? (
                        <span className="text-[#22C55E]">OK</span>
                      ) : check.status === "difference" ? (
                        <span className="text-destructive">Difference</span>
                      ) : (
                        <span className="text-muted-foreground">Not available</span>
                      )}
                      {check.note && (
                        <span className="mt-1 block max-w-md text-[11px] opacity-60">{check.note}</span>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            <p className="mt-3 text-xs text-muted-foreground">
              Differences are reported, never adjusted. A difference means Tally&apos;s own figures did not agree
              at the cut-over and a person needs to decide what is right.
            </p>
          </CardContent>
        </Card>
      )}
    </div>
  )
}
