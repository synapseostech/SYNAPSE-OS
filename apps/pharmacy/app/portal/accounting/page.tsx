"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useSearchParams } from "next/navigation"
import { AlertTriangle, BookOpen, Plus, RefreshCw, Trash2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { DayBookTab } from "@/components/accounting/day-book-tab"
import { LedgerTab } from "@/components/accounting/ledger-tab"
import { OutstandingTab } from "@/components/accounting/outstanding-tab"
import {
  VOUCHER_KIND_LABELS,
  VOUCHER_TYPES,
  VOUCHER_TYPE_HELP,
  VOUCHER_TYPE_LABELS,
  isVoucherType,
  voucherKindFromSource,
  type VoucherType,
} from "@/lib/accounting/voucher-types"
import { formatCurrency } from "@/lib/utils"
import { summarizeCurrencies, type AccountBalance } from "@/lib/accounting/reporting"
import { exactBankCandidates, parseBankStatementCsv, type BankStatementRow } from "@/lib/accounting/bank-statement"
import { usePharmacySession } from "@/hooks/use-pharmacy-session"
import { sessionHasCapability } from "@/lib/capabilities"

export const dynamic = "force-dynamic"

type JournalEntry = {
  id: string
  entry_no: string
  entry_date: string
  source_type: string
  source_id: string
  description: string
  currency: string
  total_debit: number
  total_credit: number
  lines: Array<{
    debit: number
    credit: number
    account: { code: string; name: string } | null
  }>
}

type ChartAccount = {
  id: string
  code: string
  name: string
  account_type: AccountBalance["account_type"]
  normal_balance: AccountBalance["normal_balance"]
  is_system: boolean
}

type AccountingPayload = {
  startDate: string
  endDate: string
  currency: string
  accounts: ChartAccount[]
  trialBalance: AccountBalance[]
  periodActivity: AccountBalance[]
  recentEntries: JournalEntry[]
  periods: AccountingPeriod[]
}

type PeriodCloseSnapshot = {
  salesCount?: number | null
  salesTotal?: number | null
  journalEntries?: number | null
  openTillSessions?: number | null
  unmatchedBankLines?: number | null
}

type AccountingPeriod = {
  id: string
  period_start: string
  period_end: string
  status: "open" | "closed"
  closed_at: string | null
  close_snapshot: PeriodCloseSnapshot | null
}

type ReadinessIssue = {
  code: string
  severity: "blocker" | "warning"
  message: string
  value?: number
}

type CloseReadinessPayload = {
  readiness: {
    ready: boolean
    issues: ReadinessIssue[]
    blockers: ReadinessIssue[]
    warnings: ReadinessIssue[]
  }
  snapshot: {
    openTillSessions: number
    journalEntries: number
    salesCount: number
    unmatchedBankLines: number
  }
}

type BankStatementLine = Omit<BankStatementRow, "date" | "lineNumber"> & {
  id: string
  import_id: string
  statement_date: string
  matched_journal_line_id: string | null
  matched_at: string | null
  import: { file_name: string } | null
}

type BankMatchCandidate = {
  journal_line_id: string
  journal_entry_id: string
  entry_no: string
  entry_date: string
  description: string
  currency: string
  amount: number
}

type BankReconciliationPayload = {
  imports: Array<{ id: string; file_name: string; currency: string; imported_at: string }>
  lines: BankStatementLine[]
  candidates: BankMatchCandidate[]
  totalLines: number
  page: number
}

export default function AccountingPage() {
  const today = new Date().toISOString().slice(0, 10)
  const { user } = usePharmacySession()
  const canClosePeriods = user ? sessionHasCapability({
    isAdmin: user.isAdmin,
    pharmacyRole: user.pharmacyRole,
    permissions: user.permissions,
  }, "settings.manage") : false
  const [startDate, setStartDate] = useState(`${today.slice(0, 4)}-01-01`)
  const [endDate, setEndDate] = useState(today)
  const [payload, setPayload] = useState<AccountingPayload | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [journalDate, setJournalDate] = useState(today)
  const searchParams = useSearchParams()
  const requestedVoucher = searchParams.get("voucher")
  const [voucherType, setVoucherType] = useState<VoucherType>(
    isVoucherType(requestedVoucher) ? requestedVoucher : "journal",
  )
  const [activeTab, setActiveTab] = useState("overview")
  const [journalDescription, setJournalDescription] = useState("")
  const [journalLines, setJournalLines] = useState([
    { accountId: "", debit: "", credit: "", description: "" },
    { accountId: "", debit: "", credit: "", description: "" },
  ])
  const [posting, setPosting] = useState(false)
  const [postingError, setPostingError] = useState<string | null>(null)
  const [postingMessage, setPostingMessage] = useState<string | null>(null)
  const [periodStart, setPeriodStart] = useState("")
  const [periodEnd, setPeriodEnd] = useState("")
  const [periodError, setPeriodError] = useState<string | null>(null)
  const [periodMessage, setPeriodMessage] = useState<string | null>(null)
  const [readiness, setReadiness] = useState<CloseReadinessPayload | null>(null)
  const [readinessError, setReadinessError] = useState<string | null>(null)
  const [checkingReadiness, setCheckingReadiness] = useState(false)
  const [bankReconciliation, setBankReconciliation] = useState<BankReconciliationPayload | null>(null)
  const [bankFile, setBankFile] = useState<File | null>(null)
  const [bankError, setBankError] = useState<string | null>(null)
  const [bankMessage, setBankMessage] = useState<string | null>(null)
  const [bankImporting, setBankImporting] = useState(false)
  const [matchingLineId, setMatchingLineId] = useState<string | null>(null)
  const [matchSelections, setMatchSelections] = useState<Record<string, string>>({})
  const [bankPage, setBankPage] = useState(1)
  const bankImportIdempotency = useRef<{ fingerprint: string; key: string } | null>(null)

  const loadAccounting = useCallback(async (reconciliationPage = bankPage) => {
    setLoading(true)
    setError(null)
    try {
      const params = new URLSearchParams({ from: startDate, to: endDate })
      const [response, periodsResponse, bankResponse] = await Promise.all([
        fetch(`/api/admin/accounting?${params}`),
        fetch("/api/admin/accounting/periods"),
        fetch(`/api/admin/accounting/reconciliation?page=${reconciliationPage}`),
      ])
      const [data, periodsData, bankData] = await Promise.all([
        response.json(),
        periodsResponse.json(),
        bankResponse.json(),
      ])
      if (!response.ok) throw new Error(data.error ?? "Could not load accounting records.")
      if (!periodsResponse.ok) throw new Error(periodsData.error ?? "Could not load accounting periods.")
      if (!bankResponse.ok) throw new Error(bankData.error ?? "Could not load bank reconciliation records.")
      setPayload({ ...data, periods: periodsData.periods ?? [] } as AccountingPayload)
      setBankReconciliation(bankData as BankReconciliationPayload)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not load accounting records.")
    } finally {
      setLoading(false)
    }
  }, [bankPage, endDate, startDate])

  useEffect(() => {
    void loadAccounting()
  }, [loadAccounting])

  // F4–F7 land here with the voucher already chosen; show the form, not the tabs.
  useEffect(() => {
    if (!isVoucherType(requestedVoucher)) return
    setVoucherType(requestedVoucher)
    setActiveTab("overview")
  }, [requestedVoucher])

  // Closing a period is irreversible and used to be blind. Ask the server what it
  // would refuse before the button becomes available.
  const readinessKey = canClosePeriods && periodStart && periodEnd && periodStart <= periodEnd
    ? `${periodStart}:${periodEnd}`
    : ""
  useEffect(() => {
    if (!readinessKey) {
      setReadiness(null)
      setReadinessError(null)
      return
    }
    const controller = new AbortController()
    const [start, end] = readinessKey.split(":")
    setCheckingReadiness(true)
    setReadinessError(null)
    void (async () => {
      try {
        const params = new URLSearchParams({ start, end })
        const response = await fetch(`/api/admin/accounting/periods/readiness?${params}`, {
          signal: controller.signal,
        })
        const data = await response.json()
        if (!response.ok) throw new Error(data.error ?? "Could not check close readiness.")
        setReadiness(data as CloseReadinessPayload)
      } catch (cause) {
        if (controller.signal.aborted) return
        setReadiness(null)
        setReadinessError(cause instanceof Error ? cause.message : "Could not check close readiness.")
      } finally {
        if (!controller.signal.aborted) setCheckingReadiness(false)
      }
    })()
    return () => controller.abort()
  }, [readinessKey])

  const summaries = useMemo(
    () => summarizeCurrencies(payload?.trialBalance ?? [], payload?.periodActivity ?? []),
    [payload],
  )

  async function postJournal(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setPosting(true)
    setPostingError(null)
    setPostingMessage(null)
    try {
      const response = await fetch("/api/admin/accounting", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": crypto.randomUUID(),
        },
        body: JSON.stringify({
          entryDate: journalDate,
          voucherType,
          description: journalDescription,
          lines: journalLines.map((line) => ({
            accountId: line.accountId,
            debit: line.debit || 0,
            credit: line.credit || 0,
            description: line.description,
          })),
        }),
      })
      const data = await response.json()
      if (!response.ok) throw new Error(data.error ?? "Could not post journal entry.")
      setJournalDescription("")
      setJournalLines([
        { accountId: "", debit: "", credit: "", description: "" },
        { accountId: "", debit: "", credit: "", description: "" },
      ])
      setPostingMessage(`Posted ${VOUCHER_TYPE_LABELS[voucherType].toLowerCase()} ${data.entry?.entry_no ?? ""}.`)
      await loadAccounting()
    } catch (cause) {
      setPostingError(cause instanceof Error ? cause.message : "Could not post journal entry.")
    } finally {
      setPosting(false)
    }
  }

  async function closePeriod(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setPeriodError(null)
    setPeriodMessage(null)
    if (!window.confirm(`Close ${periodStart} through ${periodEnd}? This action is permanent and blocks future postings dated in this range.`)) return

    try {
      const response = await fetch("/api/admin/accounting/periods", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ periodStart, periodEnd }),
      })
      const data = await response.json()
      if (!response.ok) throw new Error(data.error ?? "Could not close accounting period.")
      setPeriodMessage(`Closed ${periodStart} through ${periodEnd}.`)
      setPeriodStart("")
      setPeriodEnd("")
      await loadAccounting()
    } catch (cause) {
      setPeriodError(cause instanceof Error ? cause.message : "Could not close accounting period.")
    }
  }

  async function importBankStatement() {
    if (!bankFile || !payload) return
    setBankImporting(true)
    setBankError(null)
    setBankMessage(null)
    const fingerprint = `${bankFile.name}:${bankFile.size}:${bankFile.lastModified}`
    if (bankImportIdempotency.current?.fingerprint !== fingerprint) {
      bankImportIdempotency.current = { fingerprint, key: crypto.randomUUID() }
    }
    try {
      const rows: BankStatementRow[] = parseBankStatementCsv(await bankFile.text(), payload.currency)
      if (rows.length > 5000) throw new Error("Import up to 5,000 statement rows at a time.")
      const response = await fetch("/api/admin/accounting/reconciliation", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": bankImportIdempotency.current.key,
        },
        body: JSON.stringify({
          fileName: bankFile.name,
          currency: payload.currency,
          rows,
        }),
      })
      const data = await response.json()
      if (!response.ok) throw new Error(data.error ?? "Could not import bank statement.")
      setBankMessage(data.import?.replayed ? "This statement was already imported." : `Imported ${rows.length} statement lines.`)
      setBankFile(null)
      bankImportIdempotency.current = null
      if (bankPage === 1) await loadAccounting(1)
      else setBankPage(1)
    } catch (cause) {
      setBankError(cause instanceof Error ? cause.message : "Could not import bank statement.")
    } finally {
      setBankImporting(false)
    }
  }

  async function matchBankLine(statementLineId: string) {
    const journalLineId = matchSelections[statementLineId]
    if (!journalLineId) return
    setMatchingLineId(statementLineId)
    setBankError(null)
    setBankMessage(null)
    try {
      const response = await fetch("/api/admin/accounting/reconciliation", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ statementLineId, journalLineId }),
      })
      const data = await response.json()
      if (!response.ok) throw new Error(data.error ?? "Could not match statement line.")
      setBankMessage("Bank statement line reconciled.")
      setMatchSelections((current) => {
        const next = { ...current }
        delete next[statementLineId]
        return next
      })
      await loadAccounting()
    } catch (cause) {
      setBankError(cause instanceof Error ? cause.message : "Could not match statement line.")
    } finally {
      setMatchingLineId(null)
    }
  }

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <BookOpen className="h-6 w-6 text-primary" aria-hidden="true" />
            <h1 className="text-2xl font-bold text-foreground sm:text-3xl">Accounting</h1>
          </div>
          <p className="mt-1 text-sm text-muted-foreground">
            Accrual ledger, trial balance and financial performance for your pharmacy.
          </p>
        </div>
        <div className="flex items-end gap-2">
          <div className="space-y-1">
            <Label htmlFor="accounting-from">From</Label>
            <Input id="accounting-from" type="date" value={startDate} max={endDate} onChange={(event) => setStartDate(event.target.value)} />
          </div>
          <div className="space-y-1">
            <Label htmlFor="accounting-to">To</Label>
            <Input id="accounting-to" type="date" value={endDate} min={startDate} max={today} onChange={(event) => setEndDate(event.target.value)} />
          </div>
          <Button type="button" onClick={() => void loadAccounting()} disabled={loading} aria-label="Refresh accounting reports">
            <RefreshCw className={`mr-2 h-4 w-4 ${loading ? "animate-spin" : ""}`} aria-hidden="true" />
            Refresh
          </Button>
        </div>
      </header>

      <div className="flex gap-3 rounded-lg border border-amber-500/40 bg-amber-500/10 p-4 text-sm text-amber-900 dark:text-amber-100">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
        <p>
          This ledger starts recording new completed sales and received purchases after accounting is enabled.
          Earlier activity has not been backfilled. Before relying on these statements, post verified balances
          as an opening journal against Opening balance equity at the agreed conversion date.
        </p>
      </div>

      {error && <p role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">{error}</p>}

      <Tabs value={activeTab} onValueChange={setActiveTab} className="space-y-4">
        <TabsList>
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="day-book">Day book</TabsTrigger>
          <TabsTrigger value="ledger">General ledger</TabsTrigger>
          <TabsTrigger value="outstanding">Outstanding</TabsTrigger>
        </TabsList>

        <TabsContent value="overview">
      <Card>
        <CardHeader>
          <CardTitle>New voucher</CardTitle>
          <p className="text-sm text-muted-foreground">
            Record a balanced entry in {payload?.currency ?? "the pharmacy currency"} using the same voucher types as Tally.
            Posted entries are immutable.
          </p>
        </CardHeader>
        <CardContent>
          <form onSubmit={postJournal} className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-4">
              <div className="space-y-1.5">
                <Label htmlFor="journal-date">Entry date</Label>
                <Input id="journal-date" type="date" max={today} value={journalDate} onChange={(event) => setJournalDate(event.target.value)} required />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="journal-voucher-type">Voucher type</Label>
                <select
                  id="journal-voucher-type"
                  className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
                  value={voucherType}
                  onChange={(event) => setVoucherType(event.target.value as VoucherType)}
                >
                  {VOUCHER_TYPES.map((option) => (
                    <option key={option} value={option}>{VOUCHER_TYPE_LABELS[option]}</option>
                  ))}
                </select>
              </div>
              <div className="space-y-1.5 sm:col-span-2">
                <Label htmlFor="journal-description">Description</Label>
                <Input id="journal-description" value={journalDescription} maxLength={500} onChange={(event) => setJournalDescription(event.target.value)} required />
              </div>
            </div>
            <p className="text-sm text-muted-foreground">{VOUCHER_TYPE_HELP[voucherType]}</p>
            <div className="space-y-3">
              {journalLines.map((line, index) => (
                <div key={index} className="grid gap-3 rounded-lg border p-3 sm:grid-cols-[minmax(12rem,2fr)_minmax(6rem,1fr)_minmax(6rem,1fr)_minmax(10rem,1.5fr)_auto]">
                  <div className="space-y-1.5">
                    <Label htmlFor={`journal-account-${index}`}>Account</Label>
                    <select
                      id={`journal-account-${index}`}
                      className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
                      value={line.accountId}
                      onChange={(event) => setJournalLines((current) => current.map((item, row) => row === index ? { ...item, accountId: event.target.value } : item))}
                      required
                    >
                      <option value="">Select account</option>
                      {(payload?.accounts ?? []).map((account) => (
                        <option key={account.id} value={account.id}>{account.code} · {account.name}</option>
                      ))}
                    </select>
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor={`journal-debit-${index}`}>Debit</Label>
                    <Input id={`journal-debit-${index}`} type="number" min="0" step="0.01" value={line.debit} onChange={(event) => setJournalLines((current) => current.map((item, row) => row === index ? { ...item, debit: event.target.value, credit: event.target.value ? "" : item.credit } : item))} />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor={`journal-credit-${index}`}>Credit</Label>
                    <Input id={`journal-credit-${index}`} type="number" min="0" step="0.01" value={line.credit} onChange={(event) => setJournalLines((current) => current.map((item, row) => row === index ? { ...item, credit: event.target.value, debit: event.target.value ? "" : item.debit } : item))} />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor={`journal-line-description-${index}`}>Line note</Label>
                    <Input id={`journal-line-description-${index}`} value={line.description} maxLength={300} onChange={(event) => setJournalLines((current) => current.map((item, row) => row === index ? { ...item, description: event.target.value } : item))} />
                  </div>
                  <div className="flex items-end">
                    <Button type="button" variant="outline" size="icon" aria-label={`Remove journal line ${index + 1}`} disabled={journalLines.length <= 2} onClick={() => setJournalLines((current) => current.filter((_, row) => row !== index))}>
                      <Trash2 className="h-4 w-4" aria-hidden="true" />
                    </Button>
                  </div>
                </div>
              ))}
            </div>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <Button type="button" variant="outline" onClick={() => setJournalLines((current) => [...current, { accountId: "", debit: "", credit: "", description: "" }])}>
                <Plus className="mr-2 h-4 w-4" aria-hidden="true" /> Add line
              </Button>
              <Button type="submit" disabled={posting || !payload?.accounts.length}>
                {posting ? "Posting…" : `Post ${VOUCHER_TYPE_LABELS[voucherType].toLowerCase()}`}
              </Button>
            </div>
            {postingError && <p role="alert" className="text-sm text-destructive">{postingError}</p>}
            {postingMessage && <p role="status" className="text-sm text-emerald-600">{postingMessage}</p>}
          </form>
        </CardContent>
      </Card>

      <section aria-label="Financial summary" className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {summaries.map((summary) => (
          <Card key={summary.currency}>
            <CardHeader className="pb-2"><CardTitle className="text-sm text-muted-foreground">{summary.currency} · Net income</CardTitle></CardHeader>
            <CardContent className="text-2xl font-bold">{formatCurrency(summary.netIncome, summary.currency)}</CardContent>
          </Card>
        ))}
        {summaries.length === 0 && (
          <Card><CardHeader className="pb-2"><CardTitle className="text-sm text-muted-foreground">Net income</CardTitle></CardHeader><CardContent className="text-sm text-muted-foreground">{loading ? "Loading…" : "No posted activity in this period."}</CardContent></Card>
        )}
      </section>

      <Card>
        <CardHeader><CardTitle>Chart of accounts</CardTitle></CardHeader>
        <CardContent>
          {loading ? <div className="h-24 animate-pulse rounded bg-muted/40" /> : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader><TableRow><TableHead>Code</TableHead><TableHead>Account</TableHead><TableHead>Type</TableHead><TableHead>Balance side</TableHead><TableHead>Setup</TableHead></TableRow></TableHeader>
                <TableBody>
                  {(payload?.accounts ?? []).map((account) => (
                    <TableRow key={account.id}>
                      <TableCell className="font-mono">{account.code}</TableCell>
                      <TableCell>{account.name}</TableCell>
                      <TableCell className="capitalize">{account.account_type}</TableCell>
                      <TableCell className="capitalize">{account.normal_balance}</TableCell>
                      <TableCell>{account.is_system ? "System" : "Custom"}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Bank statement reconciliation</CardTitle>
          <p className="text-sm text-muted-foreground">
            Import a CSV using Date, Description and Amount columns (or separate Debit and Credit columns). Positive amounts are deposits; negative amounts are withdrawals.
          </p>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap items-end gap-3">
            <div className="min-w-64 flex-1 space-y-1.5">
              <Label htmlFor="bank-statement-file">Bank statement CSV · {payload?.currency ?? "currency"}</Label>
              <Input id="bank-statement-file" type="file" accept=".csv,text/csv" onChange={(event) => {
                const file = event.target.files?.[0] ?? null
                if (file && file.size > 1_000_000) {
                  setBankFile(null)
                  setBankError("Bank statement CSV files must be 1 MB or smaller.")
                  return
                }
                setBankFile(file)
                setBankError(null)
                setBankMessage(null)
              }} />
            </div>
            <Button type="button" onClick={() => void importBankStatement()} disabled={!bankFile || bankImporting || loading}>
              {bankImporting ? "Importing…" : "Import statement"}
            </Button>
          </div>
          {bankError && <p role="alert" className="text-sm text-destructive">{bankError}</p>}
          {bankMessage && <p role="status" className="text-sm text-emerald-600">{bankMessage}</p>}
          <div className="grid gap-3 sm:grid-cols-3 text-sm">
            <div className="rounded-md border p-3"><span className="text-muted-foreground">Statement lines</span><p className="text-xl font-semibold">{bankReconciliation?.totalLines ?? 0}</p></div>
            <div className="rounded-md border p-3"><span className="text-muted-foreground">Matched on page</span><p className="text-xl font-semibold">{bankReconciliation?.lines.filter((line) => line.matched_journal_line_id).length ?? 0}</p></div>
            <div className="rounded-md border p-3"><span className="text-muted-foreground">Unmatched on page</span><p className="text-xl font-semibold">{bankReconciliation?.lines.filter((line) => !line.matched_journal_line_id).length ?? 0}</p></div>
          </div>
          {!bankReconciliation?.lines.length ? (
            <p className="rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground">No bank statements imported yet.</p>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Date</TableHead><TableHead>Statement detail</TableHead><TableHead>Amount</TableHead><TableHead>Bank journal match</TableHead><TableHead></TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {bankReconciliation.lines.map((line) => {
                    const exactCandidates = exactBankCandidates(line, bankReconciliation.candidates)
                    return (
                      <TableRow key={line.id}>
                        <TableCell>{line.statement_date}</TableCell>
                        <TableCell>
                          <p>{line.description}</p>
                          <p className="text-xs text-muted-foreground">{line.reference || line.import?.file_name || "Statement line"}</p>
                        </TableCell>
                        <TableCell>{formatCurrency(Number(line.amount), line.currency)}</TableCell>
                        <TableCell>
                          {line.matched_journal_line_id ? (
                            <span className="text-emerald-700 dark:text-emerald-300">Matched</span>
                          ) : (
                            <select
                              className="h-10 min-w-64 rounded-md border border-input bg-background px-3 text-sm"
                              aria-label={`Journal match for ${line.description}`}
                              value={matchSelections[line.id] ?? ""}
                              onChange={(event) => setMatchSelections((current) => ({ ...current, [line.id]: event.target.value }))}
                            >
                              <option value="">{exactCandidates.length ? "Select exact amount" : "No exact bank entries"}</option>
                              {exactCandidates.map((candidate) => (
                                <option key={candidate.journal_line_id} value={candidate.journal_line_id}>
                                  {candidate.entry_date} · {candidate.entry_no} · {candidate.description}
                                </option>
                              ))}
                            </select>
                          )}
                        </TableCell>
                        <TableCell>
                          {!line.matched_journal_line_id && (
                            <Button type="button" size="sm" variant="outline" disabled={!matchSelections[line.id] || matchingLineId === line.id} onClick={() => void matchBankLine(line.id)}>
                              {matchingLineId === line.id ? "Matching…" : "Match"}
                            </Button>
                          )}
                        </TableCell>
                      </TableRow>
                    )
                  })}
                </TableBody>
              </Table>
            </div>
          )}
          <p className="text-xs text-muted-foreground">
            Only exact amount and currency matches are offered. Imported statement rows remain unchanged; reconciliation records the linked journal line and who matched it.
          </p>
          {Boolean(bankReconciliation?.totalLines) && (
            <div className="flex items-center justify-between">
              <Button type="button" variant="outline" disabled={bankPage <= 1 || loading} onClick={() => setBankPage((page) => page - 1)}>
                Previous
              </Button>
              <span className="text-sm text-muted-foreground">
                Page {bankPage} of {Math.ceil((bankReconciliation?.totalLines ?? 0) / 300)}
              </span>
              <Button type="button" variant="outline" disabled={loading || bankPage >= Math.ceil((bankReconciliation?.totalLines ?? 0) / 300)} onClick={() => setBankPage((page) => page + 1)}>
                Next
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      {summaries.map((summary) => {
        const accounts = (payload?.trialBalance ?? []).filter((row) => row.currency === summary.currency)
        const periodAccounts = (payload?.periodActivity ?? []).filter((row) => row.currency === summary.currency)
        return (
          <section key={summary.currency} className="space-y-4" aria-label={`${summary.currency} financial reports`}>
            <h2 className="text-lg font-semibold">{summary.currency} statements</h2>
            <div className="grid gap-4 md:grid-cols-3">
              <Card><CardHeader className="pb-2"><CardTitle className="text-sm text-muted-foreground">Revenue · selected period</CardTitle></CardHeader><CardContent className="text-xl font-semibold">{formatCurrency(summary.revenue, summary.currency)}</CardContent></Card>
              <Card><CardHeader className="pb-2"><CardTitle className="text-sm text-muted-foreground">Expenses · selected period</CardTitle></CardHeader><CardContent className="text-xl font-semibold">{formatCurrency(summary.expenses, summary.currency)}</CardContent></Card>
              <Card><CardHeader className="pb-2"><CardTitle className="text-sm text-muted-foreground">Assets · through {endDate}</CardTitle></CardHeader><CardContent className="text-xl font-semibold">{formatCurrency(summary.assets, summary.currency)}</CardContent></Card>
            </div>

            <Card>
              <CardHeader>
                <CardTitle>VAT summary · selected period</CardTitle>
                <p className="text-sm text-muted-foreground">Ledger totals for review; verify tax category and filing treatment with your tax adviser.</p>
              </CardHeader>
              <CardContent className="grid gap-4 sm:grid-cols-3">
                <div><p className="text-sm text-muted-foreground">Output VAT</p><p className="text-lg font-semibold">{formatCurrency(summary.outputVat, summary.currency)}</p></div>
                <div><p className="text-sm text-muted-foreground">Input VAT</p><p className="text-lg font-semibold">{formatCurrency(summary.inputVat, summary.currency)}</p></div>
                <div><p className="text-sm text-muted-foreground">Net VAT position</p><p className="text-lg font-semibold">{formatCurrency(summary.outputVat - summary.inputVat, summary.currency)}</p></div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader><CardTitle>Trial balance · through {endDate}</CardTitle></CardHeader>
              <CardContent>
                {loading ? <div className="h-24 animate-pulse rounded bg-muted/40" /> : accounts.length === 0 ? (
                  <p className="py-6 text-center text-sm text-muted-foreground">No journal entries have been posted yet.</p>
                ) : (
                  <div className="overflow-x-auto">
                    <Table>
                      <TableHeader><TableRow><TableHead>Code</TableHead><TableHead>Account</TableHead><TableHead>Type</TableHead><TableHead className="text-right">Debits</TableHead><TableHead className="text-right">Credits</TableHead><TableHead className="text-right">Balance</TableHead></TableRow></TableHeader>
                      <TableBody>
                        {accounts.map((row) => (
                          <TableRow key={row.account_id}>
                            <TableCell className="font-mono">{row.code}</TableCell>
                            <TableCell>{row.name}</TableCell>
                            <TableCell className="capitalize">{row.account_type}</TableCell>
                            <TableCell className="text-right">{formatCurrency(Number(row.debit), summary.currency)}</TableCell>
                            <TableCell className="text-right">{formatCurrency(Number(row.credit), summary.currency)}</TableCell>
                            <TableCell className="text-right font-medium">{formatCurrency(Number(row.balance), summary.currency)}</TableCell>
                          </TableRow>
                        ))}
                        <TableRow className="font-bold">
                          <TableCell colSpan={3}>Total</TableCell>
                          <TableCell className="text-right">{formatCurrency(accounts.reduce((sum, row) => sum + Number(row.debit), 0), summary.currency)}</TableCell>
                          <TableCell className="text-right">{formatCurrency(accounts.reduce((sum, row) => sum + Number(row.credit), 0), summary.currency)}</TableCell>
                          <TableCell />
                        </TableRow>
                      </TableBody>
                    </Table>
                  </div>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader><CardTitle>Recent journal entries · {startDate} to {endDate}</CardTitle></CardHeader>
              <CardContent>
                {loading ? <div className="h-24 animate-pulse rounded bg-muted/40" /> : (
                  <div className="overflow-x-auto">
                    <Table>
                      <TableHeader><TableRow><TableHead>Date</TableHead><TableHead>Entry</TableHead><TableHead>Description</TableHead><TableHead>Source</TableHead><TableHead className="text-right">Debit</TableHead><TableHead className="text-right">Credit</TableHead></TableRow></TableHeader>
                      <TableBody>
                        {(payload?.recentEntries ?? []).filter((entry) => entry.entry_date >= startDate).map((entry) => (
                          <TableRow key={entry.id}>
                            <TableCell>{new Date(`${entry.entry_date}T00:00:00`).toLocaleDateString("en-GB")}</TableCell>
                            <TableCell className="font-mono">{entry.entry_no}</TableCell>
                            <TableCell>{entry.description}</TableCell>
                            <TableCell>{VOUCHER_KIND_LABELS[voucherKindFromSource(entry.source_type, entry.source_id)]}</TableCell>
                            <TableCell className="text-right">{formatCurrency(Number(entry.total_debit), entry.currency)}</TableCell>
                            <TableCell className="text-right">{formatCurrency(Number(entry.total_credit), entry.currency)}</TableCell>
                          </TableRow>
                        ))}
                        {(payload?.recentEntries ?? []).filter((entry) => entry.entry_date >= startDate).length === 0 && (
                          <TableRow><TableCell colSpan={6} className="py-6 text-center text-muted-foreground">No journal entries in this period.</TableCell></TableRow>
                        )}
                      </TableBody>
                    </Table>
                  </div>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader><CardTitle>Balance sheet · through {endDate}</CardTitle></CardHeader>
              <CardContent>
                <div className="overflow-x-auto">
                  <Table>
                    <TableHeader><TableRow><TableHead>Section</TableHead><TableHead className="text-right">Balance</TableHead></TableRow></TableHeader>
                    <TableBody>
                      <TableRow><TableCell>Total assets</TableCell><TableCell className="text-right">{formatCurrency(summary.assets, summary.currency)}</TableCell></TableRow>
                      <TableRow><TableCell>Total liabilities</TableCell><TableCell className="text-right">{formatCurrency(summary.liabilities, summary.currency)}</TableCell></TableRow>
                      <TableRow><TableCell>Equity including accumulated earnings</TableCell><TableCell className="text-right">{formatCurrency(summary.equity, summary.currency)}</TableCell></TableRow>
                      <TableRow className="font-bold"><TableCell>Liabilities + equity</TableCell><TableCell className="text-right">{formatCurrency(summary.liabilities + summary.equity, summary.currency)}</TableCell></TableRow>
                    </TableBody>
                  </Table>
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader><CardTitle>Profit &amp; loss · selected period</CardTitle></CardHeader>
              <CardContent>
                <div className="overflow-x-auto">
                  <Table>
                    <TableHeader><TableRow><TableHead>Account</TableHead><TableHead>Type</TableHead><TableHead className="text-right">Period balance</TableHead></TableRow></TableHeader>
                    <TableBody>
                      {periodAccounts.filter((row) => row.account_type === "income" || row.account_type === "expense").map((row) => (
                        <TableRow key={row.account_id}>
                          <TableCell>{row.code} · {row.name}</TableCell>
                          <TableCell className="capitalize">{row.account_type}</TableCell>
                          <TableCell className="text-right">{formatCurrency(Number(row.balance) * (row.account_type === "income" && row.normal_balance === "debit" ? -1 : 1), summary.currency)}</TableCell>
                        </TableRow>
                      ))}
                      <TableRow className="font-bold"><TableCell colSpan={2}>Net income</TableCell><TableCell className="text-right">{formatCurrency(summary.netIncome, summary.currency)}</TableCell></TableRow>
                    </TableBody>
                  </Table>
                </div>
              </CardContent>
            </Card>
          </section>
        )
      })}

      <Card>
        <CardHeader>
          <CardTitle>Accounting periods</CardTitle>
          <p className="text-sm text-muted-foreground">Closed periods cannot be reopened; create adjusting entries in a later open period.</p>
        </CardHeader>
        <CardContent className="space-y-5">
          {canClosePeriods && (
            <div className="space-y-3">
              <form onSubmit={closePeriod} className="flex flex-wrap items-end gap-3 rounded-lg border p-3">
                <div className="space-y-1.5">
                  <Label htmlFor="close-period-start">Period starts</Label>
                  <Input id="close-period-start" type="date" value={periodStart} max={periodEnd || today} onChange={(event) => setPeriodStart(event.target.value)} required />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="close-period-end">Period ends</Label>
                  <Input id="close-period-end" type="date" value={periodEnd} min={periodStart} max={today} onChange={(event) => setPeriodEnd(event.target.value)} required />
                </div>
                <Button
                  type="submit"
                  // Fail closed: with both dates set, the close stays unavailable
                  // until a readiness check has actually said yes. An unanswered
                  // check is not a pass.
                  disabled={checkingReadiness || (readinessKey !== "" && (readiness === null || !readiness.readiness.ready))}
                >
                  Close period
                </Button>
              </form>
              {checkingReadiness && <p className="text-sm text-muted-foreground">Checking whether this period can be closed…</p>}
              {readinessError && <p role="alert" className="text-sm text-destructive">{readinessError}</p>}
              {readiness && readiness.readiness.blockers.length > 0 && (
                <div role="alert" className="rounded-lg border border-destructive/40 bg-destructive/5 p-3">
                  <p className="flex items-center gap-2 text-sm font-medium text-destructive">
                    <AlertTriangle className="h-4 w-4" aria-hidden="true" />
                    This period cannot be closed yet
                  </p>
                  <ul className="mt-2 space-y-1 text-sm text-destructive">
                    {readiness.readiness.blockers.map((issue) => (
                      <li key={issue.code}>{issue.message}</li>
                    ))}
                  </ul>
                </div>
              )}
              {readiness && readiness.readiness.ready && (
                <div className="rounded-lg border p-3">
                  <p className="text-sm font-medium">
                    Ready to close {periodStart} through {periodEnd}
                  </p>
                  <p className="mt-1 text-sm text-muted-foreground">
                    {readiness.snapshot.salesCount} sale{readiness.snapshot.salesCount === 1 ? "" : "s"},{" "}
                    {readiness.snapshot.journalEntries} journal entr{readiness.snapshot.journalEntries === 1 ? "y" : "ies"}.
                    These figures are recorded with the close.
                  </p>
                  {readiness.readiness.warnings.map((issue) => (
                    <p key={issue.code} className="mt-1 flex items-start gap-2 text-sm text-amber-700">
                      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                      {issue.message}
                    </p>
                  ))}
                </div>
              )}
            </div>
          )}
          {periodError && <p role="alert" className="text-sm text-destructive">{periodError}</p>}
          {periodMessage && <p role="status" className="text-sm text-emerald-600">{periodMessage}</p>}
          {(payload?.periods ?? []).length === 0 ? (
            <p className="text-sm text-muted-foreground">No accounting periods have been closed.</p>
          ) : (
            <Table>
              <TableHeader><TableRow><TableHead>From</TableHead><TableHead>Through</TableHead><TableHead>Status</TableHead><TableHead>Closed on</TableHead><TableHead>Recorded at close</TableHead></TableRow></TableHeader>
              <TableBody>
                {(payload?.periods ?? []).map((period) => (
                  <TableRow key={period.id}>
                    <TableCell>{period.period_start}</TableCell>
                    <TableCell>{period.period_end}</TableCell>
                    <TableCell className="capitalize">{period.status}</TableCell>
                    <TableCell>{period.closed_at ? new Date(period.closed_at).toLocaleString("en-GB") : "—"}</TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {period.close_snapshot ? (
                        <div className="space-y-0.5">
                          <p>
                            {Number(period.close_snapshot.salesCount ?? 0)} sale{Number(period.close_snapshot.salesCount ?? 0) === 1 ? "" : "s"} ·{" "}
                            {formatCurrency(Number(period.close_snapshot.salesTotal ?? 0), payload?.currency ?? "UGX")}
                          </p>
                          <p>
                            {Number(period.close_snapshot.journalEntries ?? 0)} journal entr{Number(period.close_snapshot.journalEntries ?? 0) === 1 ? "y" : "ies"} ·{" "}
                            {Number(period.close_snapshot.openTillSessions ?? 0)} open till{Number(period.close_snapshot.openTillSessions ?? 0) === 1 ? "" : "s"} ·{" "}
                            {Number(period.close_snapshot.unmatchedBankLines ?? 0)} unmatched bank line{Number(period.close_snapshot.unmatchedBankLines ?? 0) === 1 ? "" : "s"}
                          </p>
                        </div>
                      ) : "—"}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
        </TabsContent>

        <TabsContent value="day-book">
          <DayBookTab from={startDate} to={endDate} accounts={payload?.accounts ?? []} />
        </TabsContent>

        <TabsContent value="ledger">
          <LedgerTab from={startDate} to={endDate} accounts={payload?.accounts ?? []} />
        </TabsContent>

        <TabsContent value="outstanding">
          <OutstandingTab asOf={endDate} />
        </TabsContent>
      </Tabs>
    </div>
  )
}
