"use client"

import { useRef, useState } from "react"
import { FileSearch, Loader2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import type { TallyProbeReport } from "@/lib/tally/probe"

/**
 * Gate 0 for the document-chain archive (TALLY_DOCUMENT_CHAIN_DESIGN.md §13).
 *
 * The design cannot be built until someone checks whether Tally's register
 * carries order and inventory documents, and which linkage fields survive the
 * XML. This reads one export and answers both, plus the per-type counts the
 * archive would later be reconciled against.
 *
 * The file never leaves the browser except as this one read-only request; no
 * import session is created and nothing is written to the ledger.
 */

const LIMIT_BYTES = 4 * 1024 * 1024

type State =
  | { status: "idle" }
  | { status: "reading" }
  | { status: "error"; message: string }
  | { status: "done"; report: TallyProbeReport; fileName: string }

function tagSummary(tags: TallyProbeReport["types"][number]["linkage"]): string {
  const present = tags.filter((entry) => entry.vouchers > 0)
  if (present.length === 0) return "none"
  return present.map((entry) => `${entry.tag} ${entry.vouchers}`).join(" · ")
}

export function TallyDocumentProbe({ enabled = true }: { enabled?: boolean }) {
  const [state, setState] = useState<State>({ status: "idle" })
  const inputRef = useRef<HTMLInputElement>(null)

  async function probe(file: File) {
    if (file.size > LIMIT_BYTES) {
      setState({
        status: "error",
        message: "That file is too large to probe. Use one report or one month, not a whole company export.",
      })
      return
    }
    setState({ status: "reading" })
    let xml: string
    try {
      xml = await file.text()
    } catch {
      setState({ status: "error", message: "The selected file could not be read." })
      return
    }
    try {
      const response = await fetch("/api/admin/tally/probe", {
        method: "POST",
        headers: { "content-type": "text/xml" },
        body: xml,
      })
      const body = (await response.json().catch(() => null)) as
        | { report?: TallyProbeReport; error?: string }
        | null
      if (!response.ok || !body?.report) {
        setState({ status: "error", message: body?.error ?? "The export could not be read." })
        return
      }
      setState({ status: "done", report: body.report, fileName: file.name })
    } catch {
      setState({ status: "error", message: "The probe request failed. Check the connection and try again." })
    }
  }

  const report = state.status === "done" ? state.report : undefined
  const dropped = report?.types.filter((type) => !type.stagedByLedgerImport) ?? []

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <FileSearch className="h-5 w-5 text-muted-foreground" />
          Probe an export before you cut over
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm text-muted-foreground">
          Read one Tally export — a per-type register or a single month — and see which document types it
          contains and which linkage fields it carries. Nothing is imported, and no cut-over session is
          created. Use this before deciding whether orders, delivery notes and receipt notes can be
          archived.
        </p>

        <div className="flex flex-wrap items-center gap-2">
          <input
            ref={inputRef}
            type="file"
            accept=".xml,text/xml,application/xml"
            className="hidden"
            onChange={(event) => {
              const file = event.target.files?.[0]
              event.target.value = ""
              if (file) void probe(file)
            }}
          />
          <Button
            variant="outline"
            size="sm"
            onClick={() => inputRef.current?.click()}
            disabled={!enabled || state.status === "reading"}
          >
            {state.status === "reading" ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <FileSearch className="h-4 w-4" />
            )}
            Choose an XML export
          </Button>
          {state.status === "done" && (
            <span className="text-xs text-muted-foreground">{state.fileName}</span>
          )}
        </div>

        {state.status === "error" && (
          <p role="alert" className="text-sm text-destructive">
            {state.message}
          </p>
        )}

        {report && (
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-4">
              <div>
                <div className="text-muted-foreground text-xs">Company</div>
                <div className="font-medium">{report.company ?? "not named"}</div>
              </div>
              <div>
                <div className="text-muted-foreground text-xs">Period</div>
                <div className="font-medium">
                  {report.period.from ?? "?"} → {report.period.to ?? "?"}
                </div>
              </div>
              <div>
                <div className="text-muted-foreground text-xs">Vouchers</div>
                <div className="font-medium">{report.vouchers}</div>
              </div>
              <div>
                <div className="text-muted-foreground text-xs">Records read</div>
                <div className="font-medium">
                  {report.masters.ledgers} ledgers · {report.masters.stockItems} items
                </div>
              </div>
            </div>

            {report.truncated && (
              <p role="alert" className="text-sm text-destructive">
                The export hit the record limit, so the counts below cover only what was read. Probe a
                shorter period.
              </p>
            )}

            <div className="rounded-md border">
              <table className="w-full text-sm">
                <thead className="bg-muted/40 text-left text-xs uppercase text-muted-foreground">
                  <tr>
                    <th className="px-3 py-2">Voucher type</th>
                    <th className="px-3 py-2 text-right">Vouchers</th>
                    <th className="px-3 py-2 text-right">Cancelled</th>
                    <th className="px-3 py-2">Ledger import</th>
                  </tr>
                </thead>
                <tbody>
                  {report.types.length === 0 && (
                    <tr>
                      <td colSpan={4} className="px-3 py-3 text-muted-foreground">
                        No vouchers in this file.
                      </td>
                    </tr>
                  )}
                  {report.types.map((type) => (
                    <tr key={type.type} className="border-t">
                      <td className="px-3 py-2 font-medium">{type.type}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{type.vouchers}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{type.cancelled}</td>
                      <td className="px-3 py-2">
                        {type.stagedByLedgerImport ? (
                          <span className="text-muted-foreground">staged</span>
                        ) : (
                          <span className="text-destructive">not imported</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {dropped.length > 0 && (
              <div className="space-y-2">
                <h3 className="text-sm font-medium">Linkage fields on the types the ledger import drops</h3>
                <p className="text-xs text-muted-foreground">
                  A count of 0 means the tag is absent from every voucher of that type — which is the answer,
                  not an error.
                </p>
                <ul className="space-y-1 text-sm">
                  {dropped.map((type) => (
                    <li key={type.type}>
                      <span className="font-medium">{type.type}</span>{" "}
                      <span className="text-muted-foreground">{tagSummary(type.linkage)}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {report.warnings.length > 0 && (
              <p className="text-xs text-muted-foreground">
                Parser warnings: {report.warnings.join(", ")}
              </p>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  )
}
