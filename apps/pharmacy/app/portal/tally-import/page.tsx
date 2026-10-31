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
  Terminal,
  Upload,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { useToast } from "@/hooks/use-toast"

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
  format: string
  counts: Counts
  opening: { date: string; totalDebit: number; totalCredit: number; difference: number }
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

type BridgeCheck = {
  status: "ok" | "tally" | "token" | "bridge" | "error"
  message: string
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

  const [file, setFile] = useState<File | null>(null)
  const [sessionId, setSessionId] = useState<string | null>(null)
  const [summary, setSummary] = useState<Summary | null>(null)
  const [preview, setPreview] = useState<Preview | null>(null)
  const [progress, setProgress] = useState<Progress | null>(null)
  const [reconcile, setReconcile] = useState<ReconcileCheck[] | null>(null)
  const [conversionDate, setConversionDate] = useState("")
  const [cutoverAccess, setCutoverAccess] = useState<"checking" | "ready" | "complete" | "denied" | "disabled" | "error">("checking")
  const [bridgeToken, setBridgeToken] = useState("")
  const [bridgeCheck, setBridgeCheck] = useState<BridgeCheck | null>(null)
  const [checkingBridge, setCheckingBridge] = useState(false)
  const [portalOrigin, setPortalOrigin] = useState("")
  const [busy, setBusy] = useState<"idle" | "connecting" | "uploading" | "preview" | "applying" | "saving">("idle")

  const blocking = useMemo(
    () => (summary?.exceptions ?? []).filter((entry) => entry.severity === "blocking"),
    [summary],
  )
  const balanced = summary ? summary.opening.difference === 0 : false
  const canApply =
    cutoverAccess === "ready" &&
    Boolean(summary) &&
    balanced &&
    blocking.length === 0 &&
    busy === "idle"

  const bridgeCommand =
    `$env:SYNAPSE_TALLY_BRIDGE_TOKEN="<64-hex-token>"; ` +
    `$env:SYNAPSE_TALLY_ALLOWED_ORIGINS="${portalOrigin || "https://pharm.synapseos.tech"}"; ` +
    `node apps\\tally-bridge\\src\\cli.mjs`

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
      if (data.progress) setProgress(data.progress as Progress)
      if (data.reconcile) setReconcile(data.reconcile as ReconcileCheck[])
      if (data.conversionDate) setConversionDate(data.conversionDate as string)
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

  async function uploadAndPreview(selectedFile: File | null = file) {
    if (!selectedFile) {
      toast({ variant: "destructive", title: "Choose a Tally export first" })
      return
    }
    if (selectedFile.size > MAX_UPLOAD_BYTES) {
      toast({ variant: "destructive", title: "File is larger than 25 MB" })
      return
    }

    setBusy("uploading")
    setSummary(null)
    setPreview(null)
    setProgress(null)
    setReconcile(null)

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
        body: JSON.stringify(conversionDate ? { conversionDate } : {}),
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
      setSummary(data.summary as Summary)
      setPreview(data.preview as Preview)
      if (!conversionDate && data.summary?.conversionDate) {
        setConversionDate(data.summary.conversionDate as string)
      }
      toast({ title: "File read — review the mapping before applying" })
    } finally {
      setBusy("idle")
    }
  }

  async function connectToTally() {
    if (!bridgeToken.trim()) {
      toast({ variant: "destructive", title: "Enter the Tally Bridge token" })
      return
    }

    setBusy("connecting")
    try {
      const response = await fetch("http://127.0.0.1:17890/api/tally/export", {
        method: "POST",
        headers: { "x-synapse-tally-bridge-token": bridgeToken.trim() },
        cache: "no-store",
      })
      const payload = await response.text()
      if (!response.ok) {
        let message = `Tally Bridge returned HTTP ${response.status}.`
        try {
          const error = JSON.parse(payload) as { error?: string }
          if (error.error) message = error.error
        } catch {
          // Keep the explicit HTTP response when the local bridge did not return JSON.
        }
        throw new Error(message)
      }

      const source = new File([payload], "tally-live-export.xml", {
        type: "application/xml",
      })
      if (source.size > MAX_UPLOAD_BYTES) {
        throw new Error("Tally export exceeds the 25 MB import limit. Narrow the export period and try again.")
      }
      setFile(source)
      setBusy("idle")
      await uploadAndPreview(source)
    } catch (error) {
      toast({
        variant: "destructive",
        title: error instanceof Error ? error.message : "Could not connect to the local Tally Bridge.",
        description:
          "Start the bridge on this computer, confirm Tally's HTTP server is enabled and the correct company is open, and check the allowed portal origin.",
      })
      setBusy("idle")
    }
  }

  async function copyBridgeCommand() {
    try {
      await navigator.clipboard.writeText(bridgeCommand)
      toast({ title: "Bridge command copied" })
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
        setBridgeCheck({
          status: "token",
          message:
            "The bridge is running, but it did not accept this token. Paste the same 64-character token it was started with.",
        })
        return
      }
      if (!response.ok) {
        setBridgeCheck({
          status: "error",
          message: `The bridge answered with HTTP ${response.status}.`,
        })
        return
      }

      const data = (await response.json()) as { tally?: string; target?: string }
      if (data.tally === "reachable") {
        setBridgeCheck({
          status: "ok",
          message: `Bridge is running and Tally answered at ${data.target ?? "its local port"}.`,
        })
        return
      }
      setBridgeCheck({
        status: "tally",
        message: `Bridge is running, but nothing answered at ${data.target ?? "Tally's HTTP port"}. Open Tally, sign in, and confirm its HTTP server is enabled.`,
      })
    } catch {
      // A cross-origin failure is opaque to the browser, so an unreachable
      // bridge and a bridge rejecting this origin are indistinguishable here.
      setBridgeCheck({
        status: "bridge",
        message: `Nothing answered at 127.0.0.1:17890. Start the bridge on this computer, or confirm SYNAPSE_TALLY_ALLOWED_ORIGINS is ${portalOrigin || "this page's origin"}.`,
      })
    } finally {
      setCheckingBridge(false)
    }
  }

  async function saveMapping() {
    if (!sessionId) return
    setBusy("saving")
    try {
      const response = await fetch(`/api/admin/tally/${sessionId}/mapping`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ conversionDate }),
      })
      const data = await response.json()
      if (!response.ok) {
        toast({ variant: "destructive", title: data.error ?? "Could not save the cut-over date" })
        return
      }
      const previewResponse = await fetch(`/api/admin/tally/${sessionId}/preview`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ conversionDate }),
      })
      const previewData = await previewResponse.json()
      if (!previewResponse.ok) {
        toast({ variant: "destructive", title: previewData.error ?? "Re-preview failed" })
        return
      }
      setSummary(previewData.summary as Summary)
      setPreview(previewData.preview as Preview)
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
        const response = await fetch(`/api/admin/tally/${sessionId}/apply`, { method: "POST" })
        const data = await response.json()
        if (!response.ok) {
          toast({ variant: "destructive", title: data.error ?? "Apply stopped", description: data.progress ? `Stage: ${data.progress.stage}` : undefined })
          if (data.progress) setProgress(data.progress as Progress)
          return
        }

        setProgress(data.progress as Progress)

        const position = `${data.progress?.stage}:${data.progress?.offset}`
        if (data.done) {
          setCutoverAccess("complete")
          setReconcile((data.reconcile as ReconcileCheck[] | null) ?? null)
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
        <p className="font-medium">Connect to the local Tally Bridge or upload an XML export.</p>
        <p className="mt-1 opacity-90">
          The bridge requests All Masters and the Day Book over Tally&apos;s local XML/HTTP interface, then sends
          the result through this same preview. Excel and CSV work only through the multi-sheet templates below;
          an ordinary Tally Excel report is not a complete company export. Use the stock import assistant for a
          single-sheet stock list. This is a one-time cut-over, not continuous synchronisation.
        </p>
      </div>

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
              Node.js 22 is required and there is nothing to install. Run this from the repository root.
              Open Tally, sign in, and select the company being cut over before running it.
              The bridge listens only on 127.0.0.1 and cannot type a Tally password or choose a company for you.
            </p>
            <div className="rounded-md bg-muted p-3">
              <pre className="overflow-x-auto whitespace-pre-wrap break-all text-xs">{bridgeCommand}</pre>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Button variant="outline" onClick={() => void copyBridgeCommand()}>
                <Copy className="h-4 w-4" /> Copy command
              </Button>
              <span className="text-xs text-muted-foreground">
                Replace the token placeholder with the one you paste below.
              </span>
            </div>
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
                {busy === "connecting" ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <RefreshCw className="h-4 w-4" />
                )}
                {busy === "connecting" ? "Reading Tally…" : "Connect and review"}
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

          <div className="grid gap-4 md:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="tally-file">Tally XML, workbook or CSV (max 25 MB)</Label>
              <Input
                id="tally-file"
                ref={fileInput}
                type="file"
                accept={ACCEPTED}
                disabled={cutoverAccess !== "ready"}
                onChange={(event) => {
                  const next = event.target.files?.[0] ?? null
                  setFile(next)
                }}
              />
              {file && (
                <p className="text-xs text-muted-foreground">
                  {file.name} · {(file.size / 1024 / 1024).toFixed(2)} MB
                </p>
              )}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="cutover-date">Cut-over date</Label>
              <Input
                id="cutover-date"
                type="date"
                value={conversionDate}
                onChange={(event) => setConversionDate(event.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                Balances are read as at this date. Vouchers before it are flagged, never double-posted.
              </p>
            </div>
          </div>

          <div className="flex flex-wrap gap-2">
            <Button onClick={() => void uploadAndPreview()} disabled={cutoverAccess !== "ready" || busy !== "idle" || !file}>
              {busy === "uploading" || busy === "preview" ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <FileSpreadsheet className="h-4 w-4" />
              )}
              {busy === "uploading" ? "Uploading…" : busy === "preview" ? "Reading…" : "Upload and review"}
            </Button>
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
                    <p className="text-sm font-medium">Opening trial balance · {summary.opening.date}</p>
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

              <div className="flex flex-wrap items-end gap-2">
                <div className="space-y-1.5">
                  <Label htmlFor="cutover-date-2">Cut-over date</Label>
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
