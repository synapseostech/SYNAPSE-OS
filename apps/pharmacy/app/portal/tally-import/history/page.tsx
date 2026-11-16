"use client"

import Link from "next/link"
import { Fragment, useCallback, useEffect, useState } from "react"
import { AlertTriangle, ArrowLeft, CheckCircle2, ChevronDown, ChevronRight, History, Loader2, Lock, RotateCcw } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import {
  TALLY_HISTORY_SOURCE_TYPES,
  TALLY_SOURCE_LABELS,
  type TallyHistoryCheck,
  type TallyHistorySession,
  type TallyHistoryEntry,
  type TallyHistoryLine,
  type TallyHistorySummary,
} from "@/lib/tally/history"

export const dynamic = "force-dynamic"

type EntriesPage = { entries: TallyHistoryEntry[]; total: number; page: number; pageSize: number }
type Loaded<T> = { state: "loading" } | { state: "error"; message: string } | { state: "empty"; message: string } | { state: "ready"; data: T }

const STATUS_TEXT: Record<TallyHistoryCheck["status"], string> = {
  match: "Matches",
  short: "Fewer than planned",
  over: "More than planned",
  unknown: "Cannot compare",
}

const MODE_TEXT: Record<TallyHistorySession["mode"], string> = {
  opening: "Opening balances + Day Book",
  closing: "Closing balances only",
  replay: "Chronological replay",
}

function sessionStatus(session: TallyHistorySession): string {
  if (session.status === "complete") return "Complete"
  if (session.status === "importing") return "Stopped part-way"
  return `Stopped (${session.status})`
}

function amount(value: number, currency: string): string {
  return `${currency} ${value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

function count(value: number | null): string {
  return value === null ? "—" : value.toLocaleString()
}

function day(value: string | null): string {
  return value ? new Date(value).toLocaleString() : "—"
}

async function readJson(response: Response): Promise<{ ok: boolean; status: number; body: any }> {
  const body = await response.json().catch(() => ({}))
  return { ok: response.ok, status: response.status, body }
}

export default function TallyHistoryPage() {
  const [summary, setSummary] = useState<Loaded<TallyHistorySummary>>({ state: "loading" })
  const [entries, setEntries] = useState<Loaded<EntriesPage>>({ state: "loading" })
  const [type, setType] = useState("")
  const [from, setFrom] = useState("")
  const [to, setTo] = useState("")
  const [page, setPage] = useState(1)
  const [open, setOpen] = useState<string | null>(null)
  const [lines, setLines] = useState<Record<string, Loaded<TallyHistoryLine[]>>>({})

  useEffect(() => {
    let active = true
    void (async () => {
      try {
        const { ok, status, body } = await readJson(await fetch("/api/admin/tally/history", { cache: "no-store" }))
        if (!active) return
        if (ok) setSummary({ state: "ready", data: body as TallyHistorySummary })
        else if (status === 404) setSummary({ state: "empty", message: body.error ?? "Nothing has been imported yet." })
        else setSummary({ state: "error", message: body.error ?? "The import history could not be loaded." })
      } catch {
        if (active) setSummary({ state: "error", message: "The import history could not be loaded." })
      }
    })()
    return () => {
      active = false
    }
  }, [])

  const loadEntries = useCallback(async () => {
    setEntries({ state: "loading" })
    const params = new URLSearchParams({ page: String(page) })
    if (type) params.set("type", type)
    if (from) params.set("from", from)
    if (to) params.set("to", to)
    try {
      const { ok, body } = await readJson(
        await fetch(`/api/admin/tally/history/entries?${params}`, { cache: "no-store" }),
      )
      setEntries(
        ok
          ? { state: "ready", data: body as EntriesPage }
          : { state: "error", message: body.error ?? "The imported vouchers could not be loaded." },
      )
    } catch {
      setEntries({ state: "error", message: "The imported vouchers could not be loaded." })
    }
  }, [type, from, to, page])

  useEffect(() => {
    void loadEntries()
  }, [loadEntries])

  const toggle = async (id: string) => {
    if (open === id) {
      setOpen(null)
      return
    }
    setOpen(id)
    if (lines[id]?.state === "ready") return
    setLines((current) => ({ ...current, [id]: { state: "loading" } }))
    try {
      const { ok, body } = await readJson(await fetch(`/api/admin/tally/history/entries/${id}`, { cache: "no-store" }))
      setLines((current) => ({
        ...current,
        [id]: ok
          ? { state: "ready", data: body.lines as TallyHistoryLine[] }
          : { state: "error", message: body.error ?? "The voucher lines could not be loaded." },
      }))
    } catch {
      setLines((current) => ({ ...current, [id]: { state: "error", message: "The voucher lines could not be loaded." } }))
    }
  }

  const setFilter = (apply: () => void) => {
    apply()
    setPage(1)
    setOpen(null)
  }

  const currency = summary.state === "ready" ? summary.data.sessions[0]?.currency ?? "UGX" : "UGX"
  const pages = entries.state === "ready" ? Math.max(1, Math.ceil(entries.data.total / entries.data.pageSize)) : 1

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-2xl sm:text-3xl font-bold text-foreground">
            <History className="h-6 w-6 text-primary" /> Tally import history
          </h1>
          <p className="text-muted-foreground mt-1 text-sm">
            Everything the Tally cut-over brought into Synapse, voucher by voucher. These records are read-only;
            correct a mistake with a new entry, never by editing imported history.
          </p>
        </div>
        <Button variant="outline" asChild>
          <Link href="/portal/tally-import">
            <ArrowLeft className="h-4 w-4" /> Tally cut-over
          </Link>
        </Button>
      </div>

      {summary.state === "loading" && (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading the import record…
        </p>
      )}
      {(summary.state === "error" || summary.state === "empty") && (
        <div role={summary.state === "error" ? "alert" : "status"} className="rounded-md border bg-muted/40 px-4 py-3 text-sm">
          {summary.message}
        </div>
      )}

      {summary.state === "ready" && (
        <>
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Lock className="h-5 w-5 text-primary" />
                {summary.data.sessions[0]?.company ?? "Tally company"}
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <p className="text-sm">
                <span className="font-medium">{summary.data.journalsInForce.toLocaleString()}</span> imported journal
                {summary.data.journalsInForce === 1 ? "" : "s"} in force
                {summary.data.reversals > 0 &&
                  ` · ${summary.data.reversals.toLocaleString()} reversed by a rollback`}
              </p>
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Import</TableHead>
                      <TableHead>Mode</TableHead>
                      <TableHead>Period</TableHead>
                      <TableHead>Completed</TableHead>
                      <TableHead className="text-right">Not imported</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {summary.data.sessions.map((session) => (
                      <TableRow key={session.id}>
                        <TableCell>
                          <div className="flex flex-wrap items-center gap-2 font-medium">
                            {sessionStatus(session)}
                            {session.reversedAt && (
                              <span className="inline-flex items-center gap-1 rounded bg-muted px-1.5 py-0.5 text-xs">
                                <RotateCcw className="h-3 w-3" aria-hidden /> Rolled back {day(session.reversedAt)}
                              </span>
                            )}
                            {session.continuationOf && (
                              <span className="rounded bg-muted px-1.5 py-0.5 text-xs">Continuation</span>
                            )}
                          </div>
                          <div className="break-all text-xs text-muted-foreground">{session.fileName ?? "—"}</div>
                        </TableCell>
                        <TableCell className="whitespace-nowrap">{MODE_TEXT[session.mode]}</TableCell>
                        <TableCell className="whitespace-nowrap">
                          {session.period
                            ? `${session.period.from} to ${session.period.to}`
                            : session.conversionDate
                              ? `From ${session.conversionDate}`
                              : "—"}
                        </TableCell>
                        <TableCell className="whitespace-nowrap">{day(session.completedAt)}</TableCell>
                        <TableCell className="text-right">{session.failureCount.toLocaleString()}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Did everything land?</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <p className="text-xs text-muted-foreground">
                “Planned” is what the reviewed plans of the imports in force said they would write, “Reported” is
                what their applies said they wrote, and “In Synapse now” is counted from the ledger as you open
                this page, net of any rollback.
              </p>
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Check</TableHead>
                      <TableHead className="text-right">Planned</TableHead>
                      <TableHead className="text-right">Reported</TableHead>
                      <TableHead className="text-right">In Synapse now</TableHead>
                      <TableHead>Result</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {summary.data.checks.map((check) => (
                      <TableRow key={check.id}>
                        <TableCell>
                          {check.label}
                          {check.note && <div className="text-xs text-muted-foreground">{check.note}</div>}
                        </TableCell>
                        <TableCell className="text-right">{count(check.planned)}</TableCell>
                        <TableCell className="text-right">{count(check.applied)}</TableCell>
                        <TableCell className="text-right">{check.found.toLocaleString()}</TableCell>
                        <TableCell>
                          <span className="inline-flex items-center gap-1">
                            {check.status === "match" ? (
                              <CheckCircle2 className="h-4 w-4 text-green-600" aria-hidden />
                            ) : (
                              <AlertTriangle className="h-4 w-4 text-amber-600" aria-hidden />
                            )}
                            {STATUS_TEXT[check.status]}
                          </span>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </CardContent>
          </Card>

          {summary.data.failureCount > 0 && (
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <AlertTriangle className="h-5 w-5 text-amber-600" />
                  {summary.data.failureCount.toLocaleString()} item{summary.data.failureCount === 1 ? "" : "s"} not imported
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="max-h-80 overflow-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        {summary.data.sessions.length > 1 && <TableHead>Import</TableHead>}
                        <TableHead>Stage</TableHead>
                        <TableHead>Tally item</TableHead>
                        <TableHead>Reason</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {summary.data.failures.map((failure, index) => (
                        <TableRow key={`${failure.key}-${index}`}>
                          {summary.data.sessions.length > 1 && (
                            <TableCell className="font-mono text-xs">{failure.sessionId.slice(0, 8)}</TableCell>
                          )}
                          <TableCell className="whitespace-nowrap">{failure.stage}</TableCell>
                          <TableCell className="break-all font-mono text-xs">{failure.key}</TableCell>
                          <TableCell>
                            <span className="font-mono text-xs text-muted-foreground">{failure.code}</span> {failure.message}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
                {summary.data.failureCount > summary.data.failures.length && (
                  <p className="mt-2 text-xs text-muted-foreground">
                    Showing the first {summary.data.failures.length.toLocaleString()}.
                  </p>
                )}
              </CardContent>
            </Card>
          )}
        </>
      )}

      {summary.state !== "empty" && (
        <Card>
          <CardHeader>
            <CardTitle>Imported Day Book</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {summary.state === "ready" && (
              <div className="flex flex-wrap gap-2">
                <Button
                  size="sm"
                  variant={type === "" ? "default" : "outline"}
                  onClick={() => setFilter(() => setType(""))}
                >
                  All imported ({(summary.data.journalsInForce + summary.data.reversals).toLocaleString()})
                </Button>
                {summary.data.ledger
                  .filter((row) => row.count > 0)
                  .map((row) => (
                    <Button
                      key={row.sourceType}
                      size="sm"
                      variant={type === row.sourceType ? "default" : "outline"}
                      onClick={() => setFilter(() => setType(row.sourceType))}
                    >
                      {row.label} ({row.count.toLocaleString()})
                    </Button>
                  ))}
              </div>
            )}
            <div className="grid gap-3 sm:grid-cols-3">
              <div className="space-y-1.5">
                <Label htmlFor="history-type">Voucher type</Label>
                <select
                  id="history-type"
                  className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                  value={type}
                  onChange={(event) => setFilter(() => setType(event.target.value))}
                >
                  <option value="">All types</option>
                  {TALLY_HISTORY_SOURCE_TYPES.map((sourceType) => (
                    <option key={sourceType} value={sourceType}>
                      {TALLY_SOURCE_LABELS[sourceType]}
                    </option>
                  ))}
                </select>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="history-from">From</Label>
                <Input
                  id="history-from"
                  type="date"
                  value={from}
                  onChange={(event) => setFilter(() => setFrom(event.target.value))}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="history-to">To</Label>
                <Input
                  id="history-to"
                  type="date"
                  value={to}
                  onChange={(event) => setFilter(() => setTo(event.target.value))}
                />
              </div>
            </div>

            {entries.state === "loading" && (
              <p className="flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" /> Loading vouchers…
              </p>
            )}
            {entries.state === "error" && (
              <div role="alert" className="rounded-md border bg-muted/40 px-4 py-3 text-sm">
                {entries.message}
              </div>
            )}
            {entries.state === "ready" && entries.data.entries.length === 0 && (
              <p className="text-sm text-muted-foreground">No imported vouchers match these filters.</p>
            )}
            {entries.state === "ready" && entries.data.entries.length > 0 && (
              <>
                <div className="overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead className="w-8" />
                        <TableHead>Date</TableHead>
                        <TableHead>Type</TableHead>
                        <TableHead>Voucher</TableHead>
                        <TableHead className="text-right">Amount</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {entries.data.entries.map((entry) => {
                        const expanded = open === entry.id
                        const detail = lines[entry.id]
                        return (
                          <Fragment key={entry.id}>
                            <TableRow className="cursor-pointer" onClick={() => void toggle(entry.id)}>
                              <TableCell>
                                <button
                                  type="button"
                                  aria-expanded={expanded}
                                  aria-label={expanded ? "Hide voucher lines" : "Show voucher lines"}
                                  className="text-muted-foreground"
                                >
                                  {expanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                                </button>
                              </TableCell>
                              <TableCell className="whitespace-nowrap">{entry.date}</TableCell>
                              <TableCell className="whitespace-nowrap">
                                {entry.label}
                                {entry.reversed && (
                                  <span className="ml-2 inline-flex items-center gap-1 rounded bg-muted px-1.5 py-0.5 text-xs">
                                    <RotateCcw className="h-3 w-3" aria-hidden /> Reversed
                                  </span>
                                )}
                              </TableCell>
                              <TableCell>
                                <div>{entry.description}</div>
                                <div className="font-mono text-xs text-muted-foreground">{entry.entryNo}</div>
                              </TableCell>
                              <TableCell className="whitespace-nowrap text-right">
                                {amount(entry.total, entry.currency || currency)}
                              </TableCell>
                            </TableRow>
                            {expanded && (
                              <TableRow>
                                <TableCell />
                                <TableCell colSpan={4} className="bg-muted/30">
                                  {(!detail || detail.state === "loading") && (
                                    <span className="flex items-center gap-2 text-sm text-muted-foreground">
                                      <Loader2 className="h-4 w-4 animate-spin" /> Loading lines…
                                    </span>
                                  )}
                                  {detail?.state === "error" && <span className="text-sm">{detail.message}</span>}
                                  {detail?.state === "ready" && (
                                    <table className="w-full text-sm">
                                      <thead>
                                        <tr className="text-left text-muted-foreground">
                                          <th className="py-1 font-normal">Account</th>
                                          <th className="py-1 text-right font-normal">Debit</th>
                                          <th className="py-1 text-right font-normal">Credit</th>
                                        </tr>
                                      </thead>
                                      <tbody>
                                        {detail.data.map((line) => (
                                          <tr key={line.id}>
                                            <td className="py-1">
                                              <span className="font-mono text-xs text-muted-foreground">{line.accountCode ?? "?"}</span>{" "}
                                              {line.accountName ?? "Unknown account"}
                                              {line.description && (
                                                <span className="block text-xs text-muted-foreground">{line.description}</span>
                                              )}
                                            </td>
                                            <td className="py-1 text-right">{line.debit ? amount(line.debit, entry.currency || currency) : ""}</td>
                                            <td className="py-1 text-right">{line.credit ? amount(line.credit, entry.currency || currency) : ""}</td>
                                          </tr>
                                        ))}
                                      </tbody>
                                    </table>
                                  )}
                                  <p className="mt-2 font-mono text-xs text-muted-foreground">Tally reference {entry.sourceId}</p>
                                </TableCell>
                              </TableRow>
                            )}
                          </Fragment>
                        )
                      })}
                    </TableBody>
                  </Table>
                </div>
                <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
                  <span className="text-muted-foreground">
                    {entries.data.total.toLocaleString()} voucher{entries.data.total === 1 ? "" : "s"} · page {entries.data.page} of {pages}
                  </span>
                  <div className="flex gap-2">
                    <Button size="sm" variant="outline" disabled={page <= 1} onClick={() => setPage((value) => value - 1)}>
                      Previous
                    </Button>
                    <Button size="sm" variant="outline" disabled={page >= pages} onClick={() => setPage((value) => value + 1)}>
                      Next
                    </Button>
                  </div>
                </div>
              </>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  )
}
