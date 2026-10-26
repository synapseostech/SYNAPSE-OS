"use client"

import { Fragment, useCallback, useEffect, useState } from "react"
import { ChevronDown, ChevronRight, RefreshCw } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Label } from "@/components/ui/label"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { VOUCHER_KIND_LABELS, type VoucherKind } from "@/lib/accounting/voucher-types"
import { formatCurrency } from "@/lib/utils"

type AccountOption = { id: string; code: string; name: string }

type DayBookLine = {
  id: string
  accountId: string | null
  accountCode: string
  accountName: string
  debit: number
  credit: number
  description: string
}

type DayBookEntry = {
  id: string
  entryNo: string
  date: string
  sourceType: string
  voucherType: VoucherKind
  voucherLabel: string
  description: string
  currency: string
  totalDebit: number
  totalCredit: number
  lines: DayBookLine[]
}

type DayBookPayload = {
  from: string
  to: string
  page: number
  pageSize: number
  total: number
  entries: DayBookEntry[]
}

const KINDS: VoucherKind[] = [
  "journal",
  "payment",
  "receipt",
  "contra",
  "credit_note",
  "debit_note",
  "sales",
  "purchase",
]

const PAGE_SIZE = 50

export function DayBookTab({
  from,
  to,
  accounts,
}: {
  from: string
  to: string
  accounts: AccountOption[]
}) {
  const [kind, setKind] = useState<"all" | VoucherKind>("all")
  const [accountId, setAccountId] = useState("")
  const [page, setPage] = useState(1)
  const [payload, setPayload] = useState<DayBookPayload | null>(null)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const params = new URLSearchParams({ from, to, page: String(page), pageSize: String(PAGE_SIZE) })
      if (kind !== "all") params.set("voucherType", kind)
      if (accountId) params.set("accountId", accountId)
      const response = await fetch(`/api/admin/accounting/day-book?${params}`)
      const data = await response.json()
      if (!response.ok) throw new Error(data.error ?? "Could not load the day book.")
      setPayload(data as DayBookPayload)
    } catch (cause) {
      setPayload(null)
      setError(cause instanceof Error ? cause.message : "Could not load the day book.")
    } finally {
      setLoading(false)
    }
  }, [accountId, from, kind, page, to])

  useEffect(() => {
    void load()
  }, [load])

  function changeKind(value: "all" | VoucherKind) {
    setKind(value)
    setPage(1)
  }

  function changeAccount(value: string) {
    setAccountId(value)
    setPage(1)
  }

  function toggle(entryId: string) {
    setExpanded((current) => {
      const next = new Set(current)
      if (next.has(entryId)) next.delete(entryId)
      else next.add(entryId)
      return next
    })
  }

  const pages = Math.max(1, Math.ceil((payload?.total ?? 0) / PAGE_SIZE))

  return (
    <Card>
      <CardHeader>
        <CardTitle>Day book</CardTitle>
        <p className="text-sm text-muted-foreground">
          Every entry between {from} and {to}, newest first. Expand an entry to see each side of the posting.
        </p>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap items-end gap-3">
          <div className="space-y-1.5">
            <Label htmlFor="day-book-type">Voucher type</Label>
            <select
              id="day-book-type"
              className="h-10 min-w-44 rounded-md border border-input bg-background px-3 text-sm"
              value={kind}
              onChange={(event) => changeKind(event.target.value as "all" | VoucherKind)}
            >
              <option value="all">All vouchers</option>
              {KINDS.map((option) => (
                <option key={option} value={option}>{VOUCHER_KIND_LABELS[option]}</option>
              ))}
            </select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="day-book-account">Account</Label>
            <select
              id="day-book-account"
              className="h-10 min-w-56 rounded-md border border-input bg-background px-3 text-sm"
              value={accountId}
              onChange={(event) => changeAccount(event.target.value)}
            >
              <option value="">Any account</option>
              {accounts.map((account) => (
                <option key={account.id} value={account.id}>{account.code} · {account.name}</option>
              ))}
            </select>
          </div>
          <Button type="button" variant="outline" onClick={() => void load()} disabled={loading}>
            <RefreshCw className={`mr-2 h-4 w-4 ${loading ? "animate-spin" : ""}`} aria-hidden="true" />
            Refresh
          </Button>
          <p className="ml-auto text-sm text-muted-foreground">
            {payload ? `${payload.total} entr${payload.total === 1 ? "y" : "ies"}` : ""}
          </p>
        </div>

        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        {loading && !payload ? <div className="h-24 animate-pulse rounded bg-muted/40" /> : null}

        {payload && payload.entries.length === 0 ? (
          <p className="rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground">
            No vouchers match this range and filter.
          </p>
        ) : null}

        {payload && payload.entries.length > 0 ? (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-8" />
                  <TableHead>Date</TableHead>
                  <TableHead>Entry</TableHead>
                  <TableHead>Voucher</TableHead>
                  <TableHead>Description</TableHead>
                  <TableHead className="text-right">Debit</TableHead>
                  <TableHead className="text-right">Credit</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {payload.entries.map((entry) => {
                  const isOpen = expanded.has(entry.id)
                  return (
                    <Fragment key={entry.id}>
                      <TableRow>
                        <TableCell>
                          <Button
                            type="button"
                            size="icon"
                            variant="ghost"
                            aria-label={`${isOpen ? "Collapse" : "Expand"} entry ${entry.entryNo}`}
                            aria-expanded={isOpen}
                            onClick={() => toggle(entry.id)}
                          >
                            {isOpen ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                          </Button>
                        </TableCell>
                        <TableCell>{entry.date}</TableCell>
                        <TableCell className="font-mono">{entry.entryNo}</TableCell>
                        <TableCell>{entry.voucherLabel}</TableCell>
                        <TableCell>{entry.description}</TableCell>
                        <TableCell className="text-right">{formatCurrency(entry.totalDebit, entry.currency)}</TableCell>
                        <TableCell className="text-right">{formatCurrency(entry.totalCredit, entry.currency)}</TableCell>
                      </TableRow>
                      {isOpen && (
                        <TableRow>
                          <TableCell />
                          <TableCell colSpan={6} className="bg-muted/30">
                            <Table>
                              <TableHeader>
                                <TableRow>
                                  <TableHead>Account</TableHead>
                                  <TableHead>Note</TableHead>
                                  <TableHead className="text-right">Debit</TableHead>
                                  <TableHead className="text-right">Credit</TableHead>
                                </TableRow>
                              </TableHeader>
                              <TableBody>
                                {entry.lines.map((line) => (
                                  <TableRow key={line.id}>
                                    <TableCell>{line.accountCode} · {line.accountName}</TableCell>
                                    <TableCell className="text-muted-foreground">{line.description || "—"}</TableCell>
                                    <TableCell className="text-right">{line.debit ? formatCurrency(line.debit, entry.currency) : "—"}</TableCell>
                                    <TableCell className="text-right">{line.credit ? formatCurrency(line.credit, entry.currency) : "—"}</TableCell>
                                  </TableRow>
                                ))}
                              </TableBody>
                            </Table>
                          </TableCell>
                        </TableRow>
                      )}
                    </Fragment>
                  )
                })}
              </TableBody>
            </Table>
          </div>
        ) : null}

        {payload && payload.total > PAGE_SIZE ? (
          <div className="flex items-center justify-between">
            <Button type="button" variant="outline" disabled={page <= 1 || loading} onClick={() => setPage((current) => Math.max(1, current - 1))}>
              Previous
            </Button>
            <span className="text-sm text-muted-foreground">Page {page} of {pages}</span>
            <Button type="button" variant="outline" disabled={loading || page >= pages} onClick={() => setPage((current) => current + 1)}>
              Next
            </Button>
          </div>
        ) : null}
      </CardContent>
    </Card>
  )
}
