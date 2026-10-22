"use client"

import { useEffect, useRef, useState } from "react"
import { AlertTriangle, CreditCard, Plus, WalletCards } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { useToast } from "@/hooks/use-toast"
import { formatCurrency } from "@/lib/utils"

export const dynamic = "force-dynamic"

type LedgerEntry = {
  id: string
  customer_id: string | null
  amount: number
  type: "credit" | "repayment"
  balance_after: number
  due_date: string | null
  notes: string | null
  created_at: string | null
  customer?: { name?: string | null; phone?: string | null } | null
}

type LedgerPayload = {
  summary: {
    totalOutstanding: number
    overdueOutstanding: number
    creditCustomers: number
    overdueCustomers: number
  }
  entries: LedgerEntry[]
}

type CustomerOption = {
  id: string
  name: string
  phone?: string | null
}

export default function CreditLedgerPage() {
  const { toast } = useToast()
  const [payload, setPayload] = useState<LedgerPayload | null>(null)
  const [customers, setCustomers] = useState<CustomerOption[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [savingEntry, setSavingEntry] = useState(false)
  const [form, setForm] = useState({ customerId: "", type: "repayment", amount: "", dueDate: "", notes: "", paymentMethod: "cash" })
  const idempotencyKey = useRef<{ fingerprint: string; key: string } | null>(null)

  async function loadCustomers() {
    const response = await fetch("/api/admin/customers")
    const data = await response.json()
    setCustomers(Array.isArray(data) ? data : [])
  }

  async function loadLedger() {
    setIsLoading(true)
    const response = await fetch("/api/admin/credit-ledger")
    const data = await response.json()
    setPayload(data)
    setIsLoading(false)
  }

  useEffect(() => {
    loadCustomers()
    loadLedger()
  }, [])

  async function createEntry(event: React.FormEvent) {
    event.preventDefault()
    const body = JSON.stringify(form)
    const fingerprint = body
    if (idempotencyKey.current?.fingerprint !== fingerprint) {
      idempotencyKey.current = { fingerprint, key: crypto.randomUUID() }
    }
    setSavingEntry(true)
    try {
      const response = await fetch("/api/admin/credit-ledger", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Idempotency-Key": idempotencyKey.current.key },
        body,
      })
      const data = await response.json()
      if (!response.ok) {
        toast({ variant: "destructive", title: "Ledger entry failed", description: data.error ?? "Could not record the entry." })
        return
      }
      idempotencyKey.current = null
      setForm({ customerId: "", type: "repayment", amount: "", dueDate: "", notes: "", paymentMethod: "cash" })
      toast({ title: "Ledger entry recorded" })
      await loadLedger()
    } catch {
      toast({ variant: "destructive", title: "Ledger entry failed", description: "Check your connection and retry without changing the entry." })
    } finally {
      setSavingEntry(false)
    }
  }

  const summary = payload?.summary ?? { totalOutstanding: 0, overdueOutstanding: 0, creditCustomers: 0, overdueCustomers: 0 }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl sm:text-3xl font-bold text-foreground">Credit Ledger</h1>
        <p className="text-muted-foreground mt-1 text-sm">Monitor customers buying on credit, repayments, exposure, and overdue balances.</p>
      </div>

      <div className="grid gap-4 md:grid-cols-4">
        <Card><CardHeader><CardTitle className="text-sm text-muted-foreground">Outstanding</CardTitle></CardHeader><CardContent className="text-2xl font-bold">{formatCurrency(summary.totalOutstanding)}</CardContent></Card>
        <Card><CardHeader><CardTitle className="text-sm text-muted-foreground">Overdue</CardTitle></CardHeader><CardContent className="text-2xl font-bold text-destructive">{formatCurrency(summary.overdueOutstanding)}</CardContent></Card>
        <Card><CardHeader><CardTitle className="text-sm text-muted-foreground">Credit Customers</CardTitle></CardHeader><CardContent className="text-2xl font-bold">{summary.creditCustomers}</CardContent></Card>
        <Card><CardHeader><CardTitle className="text-sm text-muted-foreground">Overdue Customers</CardTitle></CardHeader><CardContent className="text-2xl font-bold text-[#E8B84B]">{summary.overdueCustomers}</CardContent></Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2"><Plus className="h-5 w-5 text-primary" /> Record credit or repayment</CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={createEntry} className="grid gap-4 md:grid-cols-7">
            <div className="space-y-1.5">
              <Label>Customer</Label>
              <select
                className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
                value={form.customerId}
                onChange={(e) => setForm({ ...form, customerId: e.target.value })}
                required
                aria-label="Customer"
              >
                <option value="">Select customer</option>
                {customers.map((customer) => (
                  <option key={customer.id} value={customer.id}>
                    {customer.name}
                    {customer.phone ? ` (${customer.phone})` : ""}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-1.5">
              <Label>Type</Label>
              <select className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm" value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value })} aria-label="Entry type">
                <option value="repayment">Repayment</option>
                <option value="credit">Credit</option>
              </select>
            </div>
            <div className="space-y-1.5">
              <Label>Amount</Label>
              <Input type="number" value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} required />
            </div>
            <div className="space-y-1.5">
              <Label>Payment method</Label>
              <select
                className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
                value={form.paymentMethod}
                onChange={(e) => setForm({ ...form, paymentMethod: e.target.value })}
                aria-label="Payment method"
              >
                <option value="cash">Cash</option>
                <option value="mobile_money">Mobile money</option>
                <option value="card">Card</option>
                <option value="bank_transfer">Bank transfer</option>
              </select>
            </div>
            <div className="space-y-1.5">
              <Label>Due date</Label>
              <Input type="date" value={form.dueDate} onChange={(e) => setForm({ ...form, dueDate: e.target.value })} />
            </div>
            <div className="space-y-1.5 md:col-span-2">
              <Label>Notes</Label>
              <Input value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
            </div>
            <Button type="submit" className="md:col-start-7" disabled={savingEntry}>{savingEntry ? "Recording…" : "Record"}</Button>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2"><WalletCards className="h-5 w-5 text-[#E8B84B]" /> Ledger book</CardTitle>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="h-32 rounded-lg bg-muted/30" />
          ) : (payload?.entries ?? []).length === 0 ? (
            <div className="rounded-lg border border-dashed p-8 text-center text-muted-foreground">No credit ledger entries yet.</div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Date</TableHead>
                  <TableHead>Customer</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>Amount</TableHead>
                  <TableHead>Balance</TableHead>
                  <TableHead>Due</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {payload?.entries.map((entry) => (
                  <TableRow key={entry.id}>
                    <TableCell>{entry.created_at ? new Date(entry.created_at).toLocaleDateString("en-GB") : "-"}</TableCell>
                    <TableCell>{entry.customer?.name ?? entry.customer_id}</TableCell>
                    <TableCell>{entry.type === "credit" ? <span className="text-[#E8B84B]">Credit</span> : <span className="text-[#22C55E]">Repayment</span>}</TableCell>
                    <TableCell>{formatCurrency(Number(entry.amount ?? 0))}</TableCell>
                    <TableCell>{formatCurrency(Number(entry.balance_after ?? 0))}</TableCell>
                    <TableCell>{entry.due_date ? <span className="inline-flex items-center gap-1"><AlertTriangle className="h-3 w-3" /> {new Date(entry.due_date).toLocaleDateString("en-GB")}</span> : "-"}</TableCell>
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
