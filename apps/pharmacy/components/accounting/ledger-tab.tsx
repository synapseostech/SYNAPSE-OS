"use client"

import { useCallback, useEffect, useState } from "react"
import { RefreshCw } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Label } from "@/components/ui/label"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { VOUCHER_KIND_LABELS, voucherKindFromSource } from "@/lib/accounting/voucher-types"
import { formatCurrency } from "@/lib/utils"

type AccountOption = { id: string; code: string; name: string }

type LedgerLine = {
  id: string
  entryId: string | null
  entryNo: string
  date: string
  sourceType: string
  sourceId: string
  entryDescription: string
  description: string
  debit: number
  credit: number
  balance: number
}

type LedgerPayload = {
  account: { id: string; code: string; name: string; accountType: string; normalBalance: "debit" | "credit" }
  currency: string
  currencies: string[]
  from: string
  to: string
  openingBalance: number
  closingBalance: number
  totalDebit: number
  totalCredit: number
  lines: LedgerLine[]
  truncated: boolean
}

export function LedgerTab({
  from,
  to,
  accounts,
}: {
  from: string
  to: string
  accounts: AccountOption[]
}) {
  const [accountId, setAccountId] = useState("")
  const [currency, setCurrency] = useState("")
  const [payload, setPayload] = useState<LedgerPayload | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    if (!accountId) {
      setPayload(null)
      setError(null)
      return
    }
    setLoading(true)
    setError(null)
    try {
      const params = new URLSearchParams({ accountId, from, to })
      if (currency) params.set("currency", currency)
      const response = await fetch(`/api/admin/accounting/ledger?${params}`)
      const data = await response.json()
      if (!response.ok) throw new Error(data.error ?? "Could not load the ledger.")
      setPayload(data as LedgerPayload)
    } catch (cause) {
      setPayload(null)
      setError(cause instanceof Error ? cause.message : "Could not load the ledger.")
    } finally {
      setLoading(false)
    }
  }, [accountId, currency, from, to])

  useEffect(() => {
    void load()
  }, [load])

  return (
    <Card>
      <CardHeader>
        <CardTitle>General ledger</CardTitle>
        <p className="text-sm text-muted-foreground">
          Opening balance through the day before {from}, every posting in the range, and the running balance.
          Balances follow the account&apos;s normal side.
        </p>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap items-end gap-3">
          <div className="space-y-1.5">
            <Label htmlFor="ledger-account">Account</Label>
            <select
              id="ledger-account"
              className="h-10 min-w-64 rounded-md border border-input bg-background px-3 text-sm"
              value={accountId}
              onChange={(event) => setAccountId(event.target.value)}
            >
              <option value="">Select an account</option>
              {accounts.map((account) => (
                <option key={account.id} value={account.id}>{account.code} · {account.name}</option>
              ))}
            </select>
          </div>
          {payload && payload.currencies.length > 1 ? (
            <div className="space-y-1.5">
              <Label htmlFor="ledger-currency">Currency</Label>
              <select
                id="ledger-currency"
                className="h-10 rounded-md border border-input bg-background px-3 text-sm"
                value={payload.currency}
                onChange={(event) => setCurrency(event.target.value)}
              >
                {payload.currencies.map((option) => <option key={option} value={option}>{option}</option>)}
              </select>
            </div>
          ) : null}
          <Button type="button" variant="outline" onClick={() => void load()} disabled={loading || !accountId}>
            <RefreshCw className={`mr-2 h-4 w-4 ${loading ? "animate-spin" : ""}`} aria-hidden="true" />
            Refresh
          </Button>
        </div>

        {!accountId ? (
          <p className="rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground">
            Choose an account to see its postings and running balance.
          </p>
        ) : null}
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        {loading && !payload ? <div className="h-24 animate-pulse rounded bg-muted/40" /> : null}

        {payload ? (
          <>
            <div className="grid gap-3 text-sm sm:grid-cols-3">
              <div className="rounded-md border p-3">
                <span className="text-muted-foreground">Opening balance</span>
                <p className="text-xl font-semibold">{formatCurrency(payload.openingBalance, payload.currency)}</p>
              </div>
              <div className="rounded-md border p-3">
                <span className="text-muted-foreground">Net movement</span>
                <p className="text-xl font-semibold">
                  {formatCurrency(payload.closingBalance - payload.openingBalance, payload.currency)}
                </p>
                <p className="text-xs text-muted-foreground">
                  {formatCurrency(payload.totalDebit, payload.currency)} debit · {formatCurrency(payload.totalCredit, payload.currency)} credit
                </p>
              </div>
              <div className="rounded-md border p-3">
                <span className="text-muted-foreground">Closing balance</span>
                <p className="text-xl font-semibold">{formatCurrency(payload.closingBalance, payload.currency)}</p>
              </div>
            </div>

            {payload.truncated ? (
              <p role="status" className="text-sm text-amber-700 dark:text-amber-300">
                Showing the first {payload.lines.length} lines. Narrow the date range to see the rest.
              </p>
            ) : null}

            {payload.lines.length === 0 ? (
              <p className="rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground">
                No postings to this account in the selected range.
              </p>
            ) : (
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Date</TableHead>
                      <TableHead>Entry</TableHead>
                      <TableHead>Voucher</TableHead>
                      <TableHead>Description</TableHead>
                      <TableHead className="text-right">Debit</TableHead>
                      <TableHead className="text-right">Credit</TableHead>
                      <TableHead className="text-right">Balance</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    <TableRow className="bg-muted/30">
                      <TableCell colSpan={4} className="font-medium">Opening balance</TableCell>
                      <TableCell />
                      <TableCell />
                      <TableCell className="text-right font-medium">{formatCurrency(payload.openingBalance, payload.currency)}</TableCell>
                    </TableRow>
                    {payload.lines.map((line) => {
                      const kind = voucherKindFromSource(line.sourceType, line.sourceId)
                      return (
                        <TableRow key={line.id}>
                          <TableCell>{line.date}</TableCell>
                          <TableCell className="font-mono">{line.entryNo}</TableCell>
                          <TableCell>{VOUCHER_KIND_LABELS[kind]}</TableCell>
                          <TableCell>
                            <p>{line.entryDescription}</p>
                            {line.description ? <p className="text-xs text-muted-foreground">{line.description}</p> : null}
                          </TableCell>
                          <TableCell className="text-right">{line.debit ? formatCurrency(line.debit, payload.currency) : "—"}</TableCell>
                          <TableCell className="text-right">{line.credit ? formatCurrency(line.credit, payload.currency) : "—"}</TableCell>
                          <TableCell className="text-right font-medium">{formatCurrency(line.balance, payload.currency)}</TableCell>
                        </TableRow>
                      )
                    })}
                    <TableRow className="bg-muted/30 font-medium">
                      <TableCell colSpan={4}>Closing balance</TableCell>
                      <TableCell className="text-right">{formatCurrency(payload.totalDebit, payload.currency)}</TableCell>
                      <TableCell className="text-right">{formatCurrency(payload.totalCredit, payload.currency)}</TableCell>
                      <TableCell className="text-right">{formatCurrency(payload.closingBalance, payload.currency)}</TableCell>
                    </TableRow>
                  </TableBody>
                </Table>
              </div>
            )}
          </>
        ) : null}
      </CardContent>
    </Card>
  )
}
