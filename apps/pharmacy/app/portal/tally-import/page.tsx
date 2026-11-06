"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import {
  AlertTriangle,
  ArrowRight,
  BookOpen,
  CheckCircle2,
  Download,
  FileSpreadsheet,
  Loader2,
  RefreshCw,
  Terminal,
  Upload,
} from "lucide-react"
import { TallyDocumentProbe } from "@/components/tally/tally-document-probe"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { useToast } from "@/hooks/use-toast"
import { diagnosticFrom, reportTallyFailure } from "@/lib/tally/diagnostics"
import type { TallyEditionDisclosure, TallyEditionProblem } from "@/lib/tally/editions"
import { TALLY_SOURCE_LIMIT } from "@/lib/tally/storage"
import { cutoverBlockReason, track } from "@/lib/telemetry/events"

export const dynamic = "force-dynamic"

const MAX_UPLOAD_MB = TALLY_SOURCE_LIMIT / 1024 / 1024
const ACCEPTED = ".xml,.xlsx,.xls,.csv"

/**
 * A refused upload is answered by Storage, not by this app: its message is the
 * only thing that says whether the file was too large or the link had expired.
 */
async function uploadFailureTitle(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { message?: string; error?: string }
    const reason = body.message ?? body.error
    if (reason) return `The file could not be uploaded: ${reason}`
  } catch {
    // Not JSON — fall through to wording that claims nothing.
  }
  return "The file could not be uploaded"
}

/**
 * What the preview refusal said, beyond the one-line title. The problems list
 * is the operator's fix list; the code is what identifies the failure when the
 * server log has already aged out.
 */
function previewFailureDetail(data: {
  code?: unknown
  detail?: unknown
  problems?: unknown
}): string | undefined {
  const parts: string[] = []
  if (Array.isArray(data.problems) && data.problems.length > 0) {
    parts.push(data.problems.map(String).join("\n"))
  }
  if (typeof data.detail === "string" && data.detail) parts.push(data.detail)
  if (typeof data.code === "string" && data.code) parts.push(data.code)
  return parts.length > 0 ? parts.join("\n\n") : undefined
}

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

/** The batch expiry sheet attached to this cut-over, as the server lists it. */
type StockSheetView = {
  fileName: string | null
  rows: number | null
  stagedAt: string | null
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

/** One group of staged files — masters, or one slice of the day book each. */
function StagedGroup({
  title,
  files,
  empty,
}: {
  title: string
  files: StagedFile[]
  empty: string
}) {
  return (
    <div className="space-y-1.5">
      <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        {title} — {files.length}
      </p>
      {files.length === 0 ? (
        <p className="text-xs text-muted-foreground">{empty}</p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>File</TableHead>
              <TableHead>Covers</TableHead>
              <TableHead className="text-right">Records</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {files.map((entry) => (
              <TableRow key={entry.uploadId}>
                <TableCell className="max-w-[18rem] truncate">{entry.fileName}</TableCell>
                <TableCell>
                  {entry.kind === "masters"
                    ? "Accounts, parties and stock"
                    : formatPeriod(entry.range)}
                </TableCell>
                <TableCell className="text-right">{entry.recordsRead.toLocaleString()}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  )
}

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
  const [stockSheet, setStockSheet] = useState<StockSheetView | null>(null)
  const [stockSheetBusy, setStockSheetBusy] = useState(false)
  const stockSheetInput = useRef<HTMLInputElement>(null)
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
  const [scriptPort, setScriptPort] = useState("")
  const [scriptCompany, setScriptCompany] = useState("")
  const [companyFrom, setCompanyFrom] = useState("")
  const [companyTo, setCompanyTo] = useState("")
  // A refusal that outlives the toast, so a file that was not added says why.
  const [stageError, setStageError] = useState<{
    fileName: string
    code?: string
    message: string
  } | null>(null)
  const companyInput = useRef<HTMLInputElement>(null)
  const [editionInfo, setEditionInfo] = useState<TallyEditionDisclosure | null>(null)
  const [editionProblems, setEditionProblems] = useState<TallyEditionProblem[]>([])
  const [busy, setBusy] = useState<
    "idle" | "uploading" | "preview" | "applying" | "saving"
  >("idle")

  const stagedMasters = useMemo(
    () => stagedFiles.filter((entry) => entry.kind === "masters"),
    [stagedFiles],
  )
  const stagedVouchers = useMemo(
    () => stagedFiles.filter((entry) => entry.kind !== "masters"),
    [stagedFiles],
  )
  const stagedVoucherTotal = useMemo(
    () => stagedVouchers.reduce((total, entry) => total + entry.recordsRead, 0),
    [stagedVouchers],
  )
  const stagedVoucherSpan = useMemo(() => {
    if (stagedVouchers.length === 0) return null
    const from = stagedVouchers.map((entry) => entry.range.from).sort()[0] as string
    const to = stagedVouchers.map((entry) => entry.range.to).sort().at(-1) as string
    return { from, to }
  }, [stagedVouchers])

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

  // The dates the operator entered, used only for a file that states none.
  const companyPeriod = useMemo<TallyPeriod | undefined>(() => {
    const from = companyFrom.trim()
    const to = companyTo.trim()
    return isIsoDay(from) && isIsoDay(to) && to >= from ? { from, to } : undefined
  }, [companyFrom, companyTo])

  const exportCommand = useMemo(() => {
    const company = scriptCompany.trim()
    const port = scriptPort.trim()
    return [
      "powershell -ExecutionPolicy Bypass -File .\\tally-export-history.ps1",
      company ? `-Company "${company}"` : "",
      port ? `-Port ${port}` : "",
    ]
      .filter(Boolean)
      .join(" ")
  }, [scriptCompany, scriptPort])

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

  const forgetSession = useCallback(() => {
    setSessionId(null)
    if (typeof window !== "undefined") window.localStorage.removeItem("tallySessionId")
  }, [])

  const loadSession = useCallback(
    async (id: string) => {
      const response = await fetch(`/api/admin/tally/${id}`)
      const data = await response.json()
      // A remembered session can be gone: the data reset deletes its row, and one
      // started against another database never existed here. Holding on to the id
      // makes every later upload post to a session that cannot exist.
      if (response.status === 404) {
        forgetSession()
        return
      }
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
      if (data.stockSheet !== undefined) {
        setStockSheet((data.stockSheet as StockSheetView | null) ?? null)
      }
      if (data.conversionDate) setConversionDate(data.conversionDate as string)
      if (data.mode === "closing" || data.mode === "opening") setMode(data.mode)
    },
    [forgetSession],
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

  /** Drops every review a fresh read or a newly staged file invalidates. */
  function clearReview() {
    setSummary(null)
    setPreflightView(null)
    setPreview(null)
    setProgress(null)
    setReconcile(null)
    setManifestView(null)
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
    if (selectedFile.size > TALLY_SOURCE_LIMIT) {
      toast({ variant: "destructive", title: `File is larger than ${MAX_UPLOAD_MB} MB` })
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
        toast({ variant: "destructive", title: await uploadFailureTitle(put) })
        return
      }

      rememberSession(start.sessionId as string)
      setBusy("preview")

      const previewResponse = await fetch(`/api/admin/tally/${start.sessionId}/preview`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...(conversionDate ? { conversionDate } : {}),
          ...(period ? { period } : companyPeriod ? { period: companyPeriod } : {}),
          ...(scriptCompany.trim() ? { company: scriptCompany.trim() } : {}),
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
        toast({
          variant: "destructive",
          title: data.error ?? "The file could not be read",
          description: previewFailureDetail(data),
        })
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
    const requestUpload = (sessionId: string | null) =>
      fetch("/api/admin/tally/upload-url", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          fileName: selectedFile.name,
          fileSize: selectedFile.size,
          ...(sessionId ? { sessionId } : {}),
        }),
      })

    let startResponse = await requestUpload(session)
    let start = await startResponse.json()
    // The remembered session may have been reset away. The operator already chose
    // this file, so open a new session instead of failing on the dead id.
    if (startResponse.status === 404 && session) {
      forgetSession()
      startResponse = await requestUpload(null)
      start = await startResponse.json()
    }
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

    // A slice names its own dates; the dates entered above are the fallback for
    // a file that does not, and name the one range a masters export covers.
    const period = periodFromFileName(selectedFile.name)
    const kind = kindFromFileName(selectedFile.name)
    const company = scriptCompany.trim()
    const sourcesResponse = await fetch(`/api/admin/tally/${start.sessionId}/sources`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        uploadId: start.uploadId,
        fileName: selectedFile.name,
        ...(period ? { period } : companyPeriod ? { fallbackPeriod: companyPeriod } : {}),
        ...(company ? { company } : {}),
        ...(kind ? { kind } : {}),
        ...(replace ? { replace: true } : {}),
      }),
    })
    const staged = await sourcesResponse.json()
    if (!sourcesResponse.ok) {
      if (staged.code === "TALLY_CHUNK_ALREADY_STAGED") {
        return { ok: false, replaceChunkId: String(staged.chunkId ?? "") }
      }
      const code = typeof staged.code === "string" ? staged.code : undefined
      setStageError({
        fileName: selectedFile.name,
        ...(code ? { code } : {}),
        message: String(staged.error ?? "The file could not be added"),
      })
      // The company is the one field the operator can act on from here, so a
      // file refused for want of it puts the cursor in it rather than only
      // flashing a message.
      if (code === "TALLY_COMPANY_MISSING" || code === "TALLY_COMPANY_MISMATCH") {
        companyInput.current?.focus()
        companyInput.current?.scrollIntoView({ block: "center", behavior: "smooth" })
      }
      toast({ variant: "destructive", title: staged.error ?? "The file could not be added" })
      return { ok: false }
    }
    setStageError(null)
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
    const oversize = chosen.find((entry) => entry.size > TALLY_SOURCE_LIMIT)
    if (oversize) {
      toast({
        variant: "destructive",
        title: `${oversize.name} is larger than ${MAX_UPLOAD_MB} MB`,
      })
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

  /**
   * Uploads the filled stock sheet and re-reads the cut-over with it, because
   * the batches it carries only reach the plan through a fresh preview.
   */
  async function attachStockSheet(sheetFile: File) {
    if (!sessionId) {
      toast({
        variant: "destructive",
        title: "Add the masters file first",
        description: "The stock sheet lists the items the masters hold, so stage those first.",
      })
      return
    }
    if (sheetFile.size > TALLY_SOURCE_LIMIT) {
      toast({ variant: "destructive", title: `File is larger than ${MAX_UPLOAD_MB} MB` })
      return
    }

    setStockSheetBusy(true)
    try {
      const startResponse = await fetch("/api/admin/tally/upload-url", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          fileName: sheetFile.name,
          fileSize: sheetFile.size,
          sessionId,
        }),
      })
      const start = await startResponse.json()
      if (!startResponse.ok || typeof start.signedUrl !== "string") {
        toast({
          variant: "destructive",
          title: start.error ?? "The stock sheet could not be uploaded",
        })
        return
      }

      const put = await fetch(start.signedUrl as string, {
        method: "PUT",
        headers: { "Content-Type": sheetFile.type || "application/octet-stream" },
        body: sheetFile,
      })
      if (!put.ok) {
        toast({ variant: "destructive", title: await uploadFailureTitle(put) })
        return
      }

      const response = await fetch(`/api/admin/tally/${sessionId}/stock-sheet`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ uploadId: start.uploadId, fileName: sheetFile.name }),
      })
      const data = await response.json()
      if (!response.ok) {
        toast({
          variant: "destructive",
          title: data.error ?? "The stock sheet could not be read",
          ...(Array.isArray(data.problems) && data.problems[0]
            ? { description: String(data.problems[0]) }
            : {}),
        })
        return
      }

      setStockSheet((data.stockSheet as StockSheetView | null) ?? null)
      const count = Number(data.stockSheet?.rows ?? 0)
      toast({
        title: `Stock sheet attached — ${count.toLocaleString()} row${count === 1 ? "" : "s"}`,
        ...(Array.isArray(data.problems) && data.problems[0]
          ? { description: String(data.problems[0]) }
          : {}),
      })
      await previewStaged(sessionId)
    } finally {
      setStockSheetBusy(false)
    }
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
          ...(scriptCompany.trim() ? { company: scriptCompany.trim() } : {}),
          mode,
        }),
      })
      const data = await response.json()
      if (!response.ok) {
        if (data.code === "TALLY_SOURCES_INCOMPLETE" && Array.isArray(data.problems)) {
          setStagedProblems(data.problems.map(String))
        }
        toast({
          variant: "destructive",
          title: data.error ?? "The files could not be read",
          description: previewFailureDetail(data),
        })
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
      const only = files[0] ?? null
      await uploadAndPreview(only, only ? periodFromFileName(only.name) : undefined)
      return
    }
    await stageAndPreview(files)
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
          ...(scriptCompany.trim() ? { company: scriptCompany.trim() } : {}),
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

  return (
    <div className="space-y-6">
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
        <p className="font-medium">Export from Tally on the pharmacy PC, then upload every file here.</p>
        <p className="mt-1 opacity-90">
          The export script runs beside Tally, reads the open company through its local XML/HTTP interface,
          and writes a folder of XML files — masters first, then one Day Book file per month. Nothing is
          uploaded from that PC. Bring the whole folder back here; the files are read together, once.
          Excel and CSV work only through the multi-sheet templates above; an ordinary Tally Excel report is
          not a complete company export. This is a one-time cut-over, not continuous synchronisation.
        </p>
      </div>

      <TallyDocumentProbe enabled={cutoverAccess === "ready" || cutoverAccess === "complete"} />

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Upload className="h-5 w-5 text-primary" />
            Export from Tally, then add the files
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-3 rounded-lg border p-4">
            <p className="text-sm font-medium">Company details</p>
            <p className="text-xs text-muted-foreground">
              Used when a file does not name its company. Tally&apos;s own export already names it,
              and so does the script below; enter it here for an export that does not, and every
              file you add is attributed to it.
            </p>
            <div className="grid gap-3 sm:grid-cols-3">
              <div className="space-y-1.5">
                <Label htmlFor="script-company">Tally company</Label>
                <Input
                  id="script-company"
                  ref={companyInput}
                  value={scriptCompany}
                  onChange={(event) => {
                    setScriptCompany(event.target.value)
                    // The company was the reason the last file was refused, so
                    // typing it clears that message instead of leaving it stale.
                    if (stageError?.code?.startsWith("TALLY_COMPANY")) setStageError(null)
                  }}
                  placeholder="Company name, exactly as Tally shows it"
                  autoComplete="off"
                  disabled={cutoverAccess !== "ready"}
                  aria-invalid={stageError?.code?.startsWith("TALLY_COMPANY") ? true : undefined}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="company-from">Covers from</Label>
                <Input
                  id="company-from"
                  type="date"
                  value={companyFrom}
                  onChange={(event) => setCompanyFrom(event.target.value)}
                  disabled={cutoverAccess !== "ready"}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="company-to">Covers to</Label>
                <Input
                  id="company-to"
                  type="date"
                  value={companyTo}
                  onChange={(event) => setCompanyTo(event.target.value)}
                  disabled={cutoverAccess !== "ready"}
                />
              </div>
            </div>
            <p className="text-xs text-muted-foreground">
              The dates are used only for a file that carries none of its own — the export script
              names every slice it writes. Leave the company blank and the script lists the
              companies Tally has open, then asks which one.
            </p>
          </div>

          <div className="space-y-3 rounded-lg border border-dashed p-4">
            <div className="flex items-center gap-2">
              <Terminal className="h-4 w-4 text-primary" />
              <p className="text-sm font-medium">1. Export Tally&apos;s books on the pharmacy PC</p>
            </div>
            <p className="text-xs text-muted-foreground">
              Run this on the computer that holds Tally, with the company open and signed in. It only
              reads: the files it writes stay on that computer until you copy them across.
            </p>
            <ol className="list-decimal space-y-1 pl-5 text-xs text-muted-foreground">
              <li>Download the script and save it in its own folder, for example <span className="font-mono">C:\Synapse</span>.</li>
              <li>
                Open PowerShell in that folder and run the command below. Tally&apos;s XML/HTTP server must
                be on, which is the default.
              </li>
              <li>
                Wait for the coverage report at the end. It names every month it could not read, so a gap
                is visible before anything is imported.
              </li>
              <li>
                Copy the folder it writes — <span className="font-mono">SynapseTallyExport</span> on the
                Desktop — to this computer, then choose every file in it below.
              </li>
            </ol>
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" asChild>
                <a href="/api/admin/tally/script" download>
                  <Download className="h-4 w-4" /> Download export script
                </a>
              </Button>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="script-port">Tally HTTP port (optional)</Label>
                <Input
                  id="script-port"
                  value={scriptPort}
                  onChange={(event) => setScriptPort(event.target.value)}
                  placeholder="Find it automatically"
                  inputMode="numeric"
                  autoComplete="off"
                />
                <p className="text-xs text-muted-foreground">
                  Leave blank unless the script says it could not find Tally; its first run prints the
                  port to use.
                </p>
              </div>
            </div>
            <div className="space-y-2">
              <Label>Command to run in PowerShell</Label>
              <div className="rounded-md bg-muted p-3">
                <pre className="overflow-x-auto whitespace-pre-wrap break-all text-xs">{exportCommand}</pre>
              </div>
            </div>
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

          <div className="space-y-2 rounded-lg border border-dashed p-4">
            <p className="text-sm font-medium">2. Add the files here</p>
            <p className="text-xs text-muted-foreground">
              Choose the masters file and every day-book file together. Each one is read once and
              mapped into Synapse&apos;s accounts, parties, stock and vouchers — the result is listed
              below, and nothing is posted until you review it and apply.
            </p>
          </div>

          <div className="grid gap-4 md:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="tally-file">
                Tally XML, workbook or CSV (max {MAX_UPLOAD_MB} MB each; choose several to build the history in slices)
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
                            : " · no dates in its name, so its period is unknown"
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
              {stageError && (
                <div className="space-y-1 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-xs">
                  <p className="font-medium">{stageError.message}</p>
                  <p className="text-muted-foreground">
                    {stageError.fileName}
                    {stageError.code ? ` · ${stageError.code}` : ""}
                    {stageError.code?.startsWith("TALLY_COMPANY")
                      ? " — enter the Tally company in Company details above, then add the files again."
                      : ""}
                  </p>
                </div>
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
              <StagedGroup
                title="Masters"
                files={stagedMasters}
                empty="No masters file yet — Apply needs one."
              />
              <StagedGroup
                title="Transactions"
                files={stagedVouchers}
                empty="No day-book file yet — Apply needs at least one."
              />

              {stagedVoucherSpan && (
                <p className="text-xs text-muted-foreground">
                  Covers {stagedVoucherSpan.from} → {stagedVoucherSpan.to} ·{" "}
                  {stagedVoucherTotal.toLocaleString()} voucher
                  {stagedVoucherTotal === 1 ? "" : "s"}
                </p>
              )}

              <div className="space-y-2 rounded-lg border border-dashed p-3">
                <p className="text-sm font-medium">Stock sheet — batch and expiry</p>
                <p className="text-xs text-muted-foreground">
                  Tally&apos;s export names no batch or expiry, so opening stock cannot become
                  sellable batches without them. Download the sheet — it already lists every item
                  and the quantity it opens with — type the expiry, and the batch name if Tally
                  uses one, then attach it here. A row left blank simply creates no batch.
                </p>
                <div className="flex flex-wrap gap-2">
                  <Button variant="outline" size="sm" asChild>
                    <a href={`/api/admin/tally/${sessionId}/stock-sheet`} download>
                      <Download className="h-4 w-4" /> Download stock sheet
                    </a>
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => stockSheetInput.current?.click()}
                    disabled={busy !== "idle" || stockSheetBusy}
                  >
                    {stockSheetBusy ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <FileSpreadsheet className="h-4 w-4" />
                    )}
                    Attach filled sheet
                  </Button>
                  <input
                    ref={stockSheetInput}
                    type="file"
                    accept=".xlsx,.xls"
                    className="hidden"
                    onChange={(event) => {
                      const chosen = event.target.files?.[0]
                      // Clear the input so choosing the same corrected file again
                      // still fires onChange.
                      event.target.value = ""
                      if (chosen) void attachStockSheet(chosen)
                    }}
                  />
                </div>
                {stockSheet && (
                  <p className="text-xs text-muted-foreground">
                    Attached: {stockSheet.fileName ?? "stock sheet"} ·{" "}
                    {(stockSheet.rows ?? 0).toLocaleString()} row
                    {stockSheet.rows === 1 ? "" : "s"}. The files are read again with it after
                    each attach.
                  </p>
                )}
              </div>

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
