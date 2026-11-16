"use client"

import { useEffect, useState } from "react"
import { useRouter } from "next/navigation"
import Link from "next/link"
import { BrainCircuit, FileSpreadsheet, Loader2, Upload } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { useToast } from "@/hooks/use-toast"
import { classifyImportFiles } from "@/lib/import-classify"
import { putImportHandoff } from "@/lib/import-handoff"

export const dynamic = "force-dynamic"

const ACCEPTED = ".xml,.zip,.csv,.xlsx,.xls,.json"

type ImportSession = {
  id: string
  file_name: string | null
  source_system: string | null
  status: string | null
  total_rows: number | null
  flagged_rows: number | null
  created_at: string | null
}

/**
 * The one door into importing.
 *
 * Which workspace a file opens is read from the file, never asked: a Tally
 * export is a cut-over, a spreadsheet or CSV is a stock import. Choosing the
 * wrong one is not an operator error to guard against with a question — it is
 * a classification the names already answer.
 */
export default function ImportPage() {
  const router = useRouter()
  const { toast } = useToast()
  const [files, setFiles] = useState<File[]>([])
  const [sessions, setSessions] = useState<ImportSession[]>([])
  const [checking, setChecking] = useState(false)
  const [blocked, setBlocked] = useState<string | null>(null)

  useEffect(() => {
    void (async () => {
      try {
        const response = await fetch("/api/admin/import-sessions")
        if (!response.ok) return
        const data = await response.json()
        setSessions(Array.isArray(data) ? data : [])
      } catch {
        // The list is context, not the task: a failed read leaves it empty.
      }
    })()
  }, [])

  async function open() {
    const chosen = classifyImportFiles(files.map((entry) => entry.name))
    if (!chosen.target) {
      setBlocked(chosen.error)
      toast({ variant: "destructive", title: chosen.error })
      return
    }
    setBlocked(null)

    if (chosen.target === "assistant") {
      putImportHandoff("assistant", files)
      router.push("/portal/import-assistant")
      return
    }

    setChecking(true)
    try {
      const response = await fetch("/api/admin/tally/status", { cache: "no-store" })
      const data = await response.json().catch(() => ({}))
      if (!response.ok) {
        setBlocked(
          typeof data.error === "string"
            ? data.error
            : "The Tally cut-over could not be reached. Try again, or import a stock file instead.",
        )
        return
      }
      if (!data.isAdmin) {
        setBlocked(
          "The Tally cut-over is run by a pharmacy administrator. This account can import stock files; ask an administrator to open this Tally export.",
        )
        return
      }
      putImportHandoff("tally", files)
      router.push("/portal/tally-import")
    } catch {
      setBlocked("The Tally cut-over could not be reached. Check the connection and try again.")
    } finally {
      setChecking(false)
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl sm:text-3xl font-bold text-foreground">Import</h1>
        <p className="text-muted-foreground mt-1 text-sm">
          Upload what you have. Synapse reads the file and opens the right workspace: a Tally
          export becomes a cut-over with ledgers, balances and dated vouchers; a spreadsheet, CSV
          or JSON becomes a stock import you review before it is applied.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Upload className="h-5 w-5 text-primary" />
            Choose a file
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="import-file">File to import</Label>
            <Input
              id="import-file"
              type="file"
              multiple
              accept={ACCEPTED}
              onChange={(event) => {
                setFiles(Array.from(event.target.files ?? []))
                setBlocked(null)
              }}
            />
            <p className="text-xs text-muted-foreground">
              A Tally export is <span className="font-mono">.xml</span> or a{" "}
              <span className="font-mono">.zip</span> package. A stock file is{" "}
              <span className="font-mono">.csv</span>,{" "}
              <span className="font-mono">.xlsx</span>, <span className="font-mono">.xls</span> or{" "}
              <span className="font-mono">.json</span>. Add several Tally exports together to build
              the history in slices; a Tally export and a stock file are never read as one import.
            </p>
          </div>

          {files.length > 0 && (
            <ul className="space-y-0.5 text-xs text-muted-foreground">
              {files.map((entry) => (
                <li key={`${entry.name}-${entry.size}`}>
                  {entry.name} · {(entry.size / 1024 / 1024).toFixed(2)} MB
                </li>
              ))}
            </ul>
          )}

          {blocked && (
            <div className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-xs">
              <p className="font-medium">{blocked}</p>
            </div>
          )}

          <Button type="button" onClick={() => void open()} disabled={checking || files.length === 0}>
            {checking ? <Loader2 className="h-4 w-4 animate-spin" /> : <BrainCircuit className="h-4 w-4" />}
            {checking ? "Checking access…" : "Open import"}
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <FileSpreadsheet className="h-5 w-5 text-primary" />
            Recent import sessions
          </CardTitle>
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
                  <TableHead>Rows</TableHead>
                  <TableHead>Flagged</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {sessions.map((session) => (
                  <TableRow key={session.id}>
                    <TableCell>{session.file_name ?? "Untitled"}</TableCell>
                    <TableCell>{session.source_system ?? "Unknown"}</TableCell>
                    <TableCell className="text-xs">{session.status ?? "—"}</TableCell>
                    <TableCell>{session.total_rows ?? 0}</TableCell>
                    <TableCell>{session.flagged_rows ?? 0}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
          <p className="mt-3 text-xs text-muted-foreground">
            A Tally cut-over in progress stays in its own workspace —{" "}
            <Link href="/portal/tally-import" className="text-primary underline underline-offset-2">
              open the cut-over
            </Link>
            , and what an applied one wrote is in the{" "}
            <Link href="/portal/tally-import/history" className="text-primary underline underline-offset-2">
              Tally import history
            </Link>
            . Stock files can also be analyzed directly in the{" "}
            <Link
              href="/portal/import-assistant"
              className="text-primary underline underline-offset-2"
            >
              import assistant
            </Link>
            .
          </p>
        </CardContent>
      </Card>
    </div>
  )
}
