"use client"

import { useCallback, useEffect, useState } from "react"
import { Info, RefreshCw } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { AGEING_BUCKETS, type AgeingBucketId, type AgeingRow } from "@/lib/accounting/ageing"
import { formatCurrency } from "@/lib/utils"

type AgeingSummary = {
  buckets: Record<AgeingBucketId, number>
  total: number
  rows: AgeingRow[]
}

type OutstandingPayload = {
  asOf: string
  allocation: "oldest-first"
  receivable?: AgeingSummary & { customerCount: number; currency: string }
  payable?: Array<AgeingSummary & { currency: string; supplierCount: number }>
}

const DETAIL_LIMIT = 200

function BucketTable({ summary, currency }: { summary: AgeingSummary; currency: string }) {
  return (
    <div className="overflow-x-auto">
      <Table>
        <TableHeader>
          <TableRow>
            {AGEING_BUCKETS.map((bucket) => (
              <TableHead key={bucket.id} className="text-right">{bucket.label}</TableHead>
            ))}
            <TableHead className="text-right">Total</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          <TableRow>
            {AGEING_BUCKETS.map((bucket) => (
              <TableCell key={bucket.id} className="text-right">
                {summary.buckets[bucket.id] === 0 ? "—" : formatCurrency(summary.buckets[bucket.id], currency)}
              </TableCell>
            ))}
            <TableCell className="text-right font-semibold">{formatCurrency(summary.total, currency)}</TableCell>
          </TableRow>
        </TableBody>
      </Table>
    </div>
  )
}

function DetailTable({ summary, currency }: { summary: AgeingSummary; currency: string }) {
  if (summary.rows.length === 0) return null
  const visible = summary.rows.slice(0, DETAIL_LIMIT)
  return (
    <div className="space-y-2">
      <div className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Party</TableHead>
              <TableHead>Reference</TableHead>
              <TableHead>Document date</TableHead>
              <TableHead>Due date</TableHead>
              <TableHead className="text-right">Days overdue</TableHead>
              <TableHead className="text-right">Outstanding</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {visible.map((row) => (
              <TableRow key={`${row.reference}-${row.dueDate}-${row.date}`}>
                <TableCell>{row.partyName}</TableCell>
                <TableCell className="font-mono text-xs">{row.reference}</TableCell>
                <TableCell>{row.date}</TableCell>
                <TableCell>{row.dueDate}</TableCell>
                <TableCell className="text-right">{row.daysOverdue > 0 ? row.daysOverdue : "Not due"}</TableCell>
                <TableCell className="text-right">{formatCurrency(row.amount, currency)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      {summary.rows.length > DETAIL_LIMIT ? (
        <p className="text-xs text-muted-foreground">
          Showing the oldest {DETAIL_LIMIT} of {summary.rows.length} open documents.
        </p>
      ) : null}
    </div>
  )
}

export function OutstandingTab({ asOf }: { asOf: string }) {
  const [payload, setPayload] = useState<OutstandingPayload | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const response = await fetch(`/api/admin/accounting/ageing?${new URLSearchParams({ asOf })}`)
      const data = await response.json()
      if (!response.ok) throw new Error(data.error ?? "Could not load outstanding balances.")
      setPayload(data as OutstandingPayload)
    } catch (cause) {
      setPayload(null)
      setError(cause instanceof Error ? cause.message : "Could not load outstanding balances.")
    } finally {
      setLoading(false)
    }
  }, [asOf])

  useEffect(() => {
    void load()
  }, [load])

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader className="flex-row items-start justify-between gap-4 space-y-0">
          <div>
            <CardTitle>Outstanding balances</CardTitle>
            <p className="mt-1 text-sm text-muted-foreground">Receivable and payable ageing as at {asOf}.</p>
          </div>
          <Button type="button" variant="outline" onClick={() => void load()} disabled={loading}>
            <RefreshCw className={`mr-2 h-4 w-4 ${loading ? "animate-spin" : ""}`} aria-hidden="true" />
            Refresh
          </Button>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex gap-3 rounded-lg border border-muted bg-muted/30 p-3 text-sm text-muted-foreground">
            <Info className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
            <p>
              A repayment is not linked to the invoice it settled in this ledger, so it is applied to the oldest
              open invoice first. Treat the receivable bands as an estimate. Supplier bills use the purchase date,
              because purchases carry no due date.
            </p>
          </div>
          {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
          {loading && !payload ? <div className="h-24 animate-pulse rounded bg-muted/40" /> : null}
        </CardContent>
      </Card>

      {payload?.receivable ? (
        <Card>
          <CardHeader>
            <CardTitle>Receivables · {payload.receivable.currency}</CardTitle>
            <p className="text-sm text-muted-foreground">
              {payload.receivable.customerCount} customer{payload.receivable.customerCount === 1 ? "" : "s"} with an
              open balance.
            </p>
          </CardHeader>
          <CardContent className="space-y-4">
            <BucketTable summary={payload.receivable} currency={payload.receivable.currency} />
            {payload.receivable.total === 0 ? (
              <p className="rounded-md border border-dashed p-4 text-center text-sm text-muted-foreground">
                Nothing is outstanding.
              </p>
            ) : (
              <DetailTable summary={payload.receivable} currency={payload.receivable.currency} />
            )}
          </CardContent>
        </Card>
      ) : null}

      {payload?.payable?.map((summary) => (
        <Card key={summary.currency}>
          <CardHeader>
            <CardTitle>Payables · {summary.currency}</CardTitle>
            <p className="text-sm text-muted-foreground">
              {summary.supplierCount} supplier{summary.supplierCount === 1 ? "" : "s"} with an open bill.
            </p>
          </CardHeader>
          <CardContent className="space-y-4">
            <BucketTable summary={summary} currency={summary.currency} />
            {summary.total === 0 ? (
              <p className="rounded-md border border-dashed p-4 text-center text-sm text-muted-foreground">
                Nothing is outstanding.
              </p>
            ) : (
              <DetailTable summary={summary} currency={summary.currency} />
            )}
          </CardContent>
        </Card>
      ))}

      {payload && !payload.receivable && !payload.payable ? (
        <p className="rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground">
          No outstanding balances to show.
        </p>
      ) : null}
    </div>
  )
}
