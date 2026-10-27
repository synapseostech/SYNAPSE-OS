"use client"

import { useEffect, useState } from "react"
import Link from "next/link"
import { BrainCircuit, FileSpreadsheet, Wand2, Upload } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { useToast } from "@/hooks/use-toast"

export const dynamic = "force-dynamic"

type MappingRow = {
  source: string
  target: string
  confidence: number
  status: string
}

type ImportSession = {
  id: string
  file_name: string | null
  source_system: string | null
  status: string | null
  total_rows: number | null
  matched_rows: number | null
  flagged_rows: number | null
  ai_summary: string | null
  created_at: string | null
}

type ApplyResult = {
  success: number
  failed: number
  skipped: number
  rows: Array<{
    rowIndex: number
    status: string
    reason?: string
    productName?: string
  }>
}

const SOURCE_OPTIONS = [
  { value: "Tally", label: "Tally (CSV / Excel export)" },
  { value: "Excel", label: "Excel spreadsheet" },
  { value: "CSV", label: "Generic CSV" },
  { value: "QuickBooks", label: "QuickBooks" },
  { value: "Other", label: "Other / supplier file" },
]

export default function ImportAssistantPage() {
  const { toast } = useToast()
  const [sessions, setSessions] = useState<ImportSession[]>([])
  const [sourceSystem, setSourceSystem] = useState("Tally")
  const [fileName, setFileName] = useState("")
  const [headersText, setHeadersText] = useState("")
  const [sampleText, setSampleText] = useState("")
  const [mapping, setMapping] = useState<MappingRow[]>([])
  const [summary, setSummary] = useState("")
  const [discovery, setDiscovery] = useState("")
  const [isLoading, setIsLoading] = useState(false)
  const [isApplying, setIsApplying] = useState(false)
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(null)
  const [applyResult, setApplyResult] = useState<ApplyResult | null>(null)
  const [file, setFile] = useState<File | null>(null)

  async function loadSessions() {
    const response = await fetch("/api/admin/import-sessions")
    const data = await response.json()
    setSessions(Array.isArray(data) ? data : [])
  }

  useEffect(() => {
    loadSessions()
  }, [])

  async function analyse(event: React.FormEvent) {
    event.preventDefault()
    setIsLoading(true)
    setApplyResult(null)
    const headers = headersText.split(",").map((item) => item.trim()).filter(Boolean)
    const sampleRows = sampleText
      .split("\n")
      .map((line) => line.split(",").map((item) => item.trim()))
      .filter((row) => row.some(Boolean))

    const response = await fetch("/api/admin/import-sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sourceSystem,
        fileName: fileName || file?.name || "Manual mapping session",
        headers,
        sampleRows,
        totalRows: sampleRows.length,
      }),
    })
    const data = await response.json()
    setIsLoading(false)
    if (!response.ok) {
      toast({ variant: "destructive", title: data.error ?? "Import analysis failed" })
      return
    }
    setMapping(data.mapping ?? [])
    setSummary(data.summary ?? "")
    setDiscovery(data.discoverySummary ?? "")
    setCurrentSessionId(data.session?.id ?? null)
    toast({ title: "Import mapping ready for review" })
    loadSessions()
  }

  async function analyseFile() {
    if (!file) {
      toast({ variant: "destructive", title: "Choose a Tally / stock export file first" })
      return
    }
    setIsLoading(true)
    setApplyResult(null)
    try {
      const formData = new FormData()
      formData.append("file", file)
      formData.append("sourceSystem", sourceSystem)
      formData.append("mode", "analyse")

      const response = await fetch("/api/admin/import-sessions", {
        method: "POST",
        body: formData,
      })
      const data = await response.json()
      if (!response.ok) {
        toast({ variant: "destructive", title: data.error ?? "Could not analyse file" })
        return
      }
      setFileName(file.name)
      setHeadersText(Array.isArray(data.headers) ? data.headers.join(", ") : "")
      if (Array.isArray(data.sampleRows) && data.sampleRows.length > 0) {
        setSampleText(data.sampleRows.map((row: string[]) => row.join(", ")).join("\n"))
      } else {
        const sampleRows = (data.session?.ai_mapping as { sampleRows?: string[][] } | undefined)?.sampleRows
        if (Array.isArray(sampleRows) && sampleRows.length > 0) {
          setSampleText(sampleRows.map((row) => row.join(", ")).join("\n"))
        }
      }
      setMapping(data.mapping ?? [])
      setSummary(data.summary ?? "")
      setDiscovery(data.discoverySummary ?? "")
      setCurrentSessionId(data.session?.id ?? null)
      toast({ title: "File analysed — review mapping, then apply import" })
      loadSessions()
    } finally {
      setIsLoading(false)
    }
  }

  async function applyImport() {
    if (!currentSessionId) {
      toast({ variant: "destructive", title: "No session to apply" })
      return
    }

    const allRows = sampleText
      .split("\n")
      .map((line) => line.split(",").map((item) => item.trim()))
      .filter((row) => row.some(Boolean))

    if (allRows.length === 0) {
      toast({
        variant: "destructive",
        title: "No rows to import",
        description: "Paste sample rows or re-analyse a file that includes data rows.",
      })
      return
    }

    setIsApplying(true)
    setApplyResult(null)

    const response = await fetch(`/api/admin/import-sessions/${currentSessionId}/apply`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ allRows }),
    })

    const data = await response.json()
    setIsApplying(false)

    if (!response.ok) {
      toast({ variant: "destructive", title: data.error ?? "Import failed" })
      return
    }

    setApplyResult(data.result)
    toast({
      title: "Import complete",
      description: data.message,
    })
    loadSessions()
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl sm:text-3xl font-bold text-foreground">Auto-Migration Assistant</h1>
        <p className="text-muted-foreground mt-1 text-sm">
          Migrate stock from Tally (or other exports) into Synapse: map columns, review, then apply into inventory.
        </p>
        <div className="mt-3 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-950 dark:text-amber-100">
          <p className="font-medium">Quantity received / stock to add</p>
          <p className="mt-1 text-sm opacity-90">
            Import quantity is <strong>added</strong> to existing stock (receipt delta). Example: on-hand 50 +
            imported 100 = 150 — it does not set stock to 100. Map your export&apos;s quantity column as
            units to receive, not as a closing/opening balance overwrite. Re-applying a completed session is
            blocked. Name-only matches with conflicting strength or dosage form are rejected (e.g. Amoxicillin
            250 mg vs 500 mg).
          </p>
          <p className="mt-1 text-xs opacity-70">Internal semantic: STOCK_RECEIPT_DELTA</p>
        </div>
        <p className="mt-3 text-sm text-muted-foreground">
          Moving a whole Tally company across? Use the{" "}
          <Link href="/portal/tally-import" className="text-primary underline underline-offset-2">
            Tally cut-over workspace
          </Link>{" "}
          instead — it imports ledgers, opening balances and dated vouchers, not only stock rows.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Upload className="h-5 w-5 text-primary" />
            Step 1 — Upload Tally / stock export
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-4 md:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="source-system">Source system</Label>
              <select
                id="source-system"
                className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                value={sourceSystem}
                onChange={(e) => setSourceSystem(e.target.value)}
              >
                {SOURCE_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
              <p className="text-xs text-muted-foreground">
                Tally exports often use columns like Stock Item, Qty / Closing Stock, Group, Rate, MRP. When
                mapped to quantity, those figures are treated as stock to add (receipt delta), not a balance overwrite.
              </p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="migration-file">Export file (CSV or Excel)</Label>
              <Input
                id="migration-file"
                type="file"
                accept=".csv,.xlsx,.xls,.json"
                onChange={(e) => {
                  const next = e.target.files?.[0] ?? null
                  setFile(next)
                  if (next) setFileName(next.name)
                  setApplyResult(null)
                }}
              />
              {file && <p className="text-xs text-muted-foreground">Selected: {file.name}</p>}
            </div>
          </div>
          <Button type="button" onClick={() => void analyseFile()} disabled={isLoading || !file}>
            <Wand2 className="h-4 w-4" />
            {isLoading ? "Analysing…" : "Analyse file"}
          </Button>
          {discovery && <p className="text-sm text-muted-foreground">{discovery}</p>}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <BrainCircuit className="h-5 w-5 text-primary" />
            Step 2 — Or paste headers for a quick mapping check
          </CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={analyse} className="space-y-4">
            <div className="grid gap-4 md:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="file-name">File name</Label>
                <Input
                  id="file-name"
                  value={fileName}
                  onChange={(e) => setFileName(e.target.value)}
                  placeholder="stock-export-june.csv"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="csv-headers">CSV headers</Label>
                <Input
                  id="csv-headers"
                  value={headersText}
                  onChange={(e) => setHeadersText(e.target.value)}
                  placeholder="Stock Item, Closing Stock, Rate, MRP, Batch, Expiry"
                  required
                />
              </div>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="sample-rows">Sample / import rows</Label>
              <textarea
                id="sample-rows"
                value={sampleText}
                onChange={(e) => setSampleText(e.target.value)}
                rows={5}
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                placeholder={"Panadol 500mg, 120, 500, 800, B123, 2027-02-01"}
              />
              <p className="text-xs text-muted-foreground">
                These rows are what Apply Import will load into inventory after mapping review.
              </p>
            </div>
            <Button type="submit" disabled={isLoading}>
              <Wand2 className="h-4 w-4" />
              {isLoading ? "Analysing..." : "Generate mapping"}
            </Button>
          </form>
        </CardContent>
      </Card>

      {mapping.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <FileSpreadsheet className="h-5 w-5 text-[#E8B84B]" /> Mapping preview
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="text-sm text-muted-foreground">{summary}</p>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Source column</TableHead>
                  <TableHead>Synapse field</TableHead>
                  <TableHead>Confidence</TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {mapping.map((row) => (
                  <TableRow key={row.source}>
                    <TableCell>{row.source}</TableCell>
                    <TableCell className="font-mono text-xs">{row.target}</TableCell>
                    <TableCell>{Math.round(row.confidence * 100)}%</TableCell>
                    <TableCell>
                      {row.status === "mapped" ? (
                        <span className="text-[#22C55E]">Mapped</span>
                      ) : (
                        <span className="text-[#E8B84B]">Review</span>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>

            <div className="flex gap-2 pt-4">
              <Button
                onClick={() => void applyImport()}
                disabled={isApplying || !currentSessionId}
                className="bg-[#22C55E] hover:bg-[#22C55E]/90"
              >
                <Upload className="h-4 w-4" />
                {isApplying ? "Importing..." : "Apply Import"}
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {applyResult && (
        <Card>
          <CardHeader>
            <CardTitle>Import Results</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-3 gap-4">
              <div className="rounded-lg border p-4">
                <div className="text-2xl font-bold text-[#22C55E]">{applyResult.success}</div>
                <div className="text-sm text-muted-foreground">Success</div>
              </div>
              <div className="rounded-lg border p-4">
                <div className="text-2xl font-bold text-destructive">{applyResult.failed}</div>
                <div className="text-sm text-muted-foreground">Failed</div>
              </div>
              <div className="rounded-lg border p-4">
                <div className="text-2xl font-bold text-[#E8B84B]">{applyResult.skipped}</div>
                <div className="text-sm text-muted-foreground">Skipped</div>
              </div>
            </div>

            {applyResult.failed > 0 && (
              <div className="rounded-lg border border-destructive/50 bg-destructive/10 p-4">
                <div className="space-y-2">
                  <p className="font-semibold text-sm">Failed rows:</p>
                  <div className="max-h-48 overflow-y-auto space-y-1">
                    {applyResult.rows
                      .filter((r) => r.status === "failed")
                      .slice(0, 10)
                      .map((r) => (
                        <div key={r.rowIndex} className="text-xs text-muted-foreground">
                          Row {r.rowIndex + 1}: {r.productName || "Unknown"} - {r.reason}
                        </div>
                      ))}
                    {applyResult.rows.filter((r) => r.status === "failed").length > 10 && (
                      <div className="text-xs text-muted-foreground">
                        ... and {applyResult.rows.filter((r) => r.status === "failed").length - 10} more
                      </div>
                    )}
                  </div>
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Recent import sessions</CardTitle>
        </CardHeader>
        <CardContent>
          {sessions.length === 0 ? (
            <div className="rounded-lg border border-dashed p-8 text-center text-muted-foreground">
              No import sessions yet.
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>File</TableHead>
                  <TableHead>Source</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Matched</TableHead>
                  <TableHead>Flagged</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {sessions.map((session) => (
                  <TableRow key={session.id}>
                    <TableCell>{session.file_name ?? "Manual mapping"}</TableCell>
                    <TableCell>{session.source_system ?? "Unknown"}</TableCell>
                    <TableCell>
                      <span
                        className={`inline-flex items-center rounded-full px-2 py-1 text-xs font-medium ${
                          session.status === "complete"
                            ? "bg-[#22C55E]/10 text-[#22C55E]"
                            : session.status === "failed"
                              ? "bg-destructive/10 text-destructive"
                              : session.status === "importing"
                                ? "bg-blue-500/10 text-blue-500"
                                : "bg-[#E8B84B]/10 text-[#E8B84B]"
                        }`}
                      >
                        {session.status}
                      </span>
                    </TableCell>
                    <TableCell>{session.matched_rows ?? 0}</TableCell>
                    <TableCell>{session.flagged_rows ?? 0}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
