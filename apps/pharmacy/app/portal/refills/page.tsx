"use client"

import { useEffect, useMemo, useState } from "react"
import Link from "next/link"
import { CalendarClock, CheckCircle2, MessageSquareText, Plus, UserPlus } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { useToast } from "@/hooks/use-toast"

export const dynamic = "force-dynamic"

type Refill = {
  id: string
  drug_name: string
  refill_due_date: string
  last_dispensed: string | null
  interval_days: number | null
  reminder_sent: boolean | null
  dispensed: boolean | null
  customer?: { id?: string; name?: string | null; phone?: string | null; email?: string | null } | null
}

type Customer = {
  id: string
  name: string
  phone?: string | null
  email?: string | null
}

const EMPTY_FORM = {
  customerId: "",
  drugName: "",
  lastDispensed: "",
  refillDueDate: "",
  intervalDays: "30",
}

function addDays(date: string, days: number): string {
  if (!date || !Number.isFinite(days) || days <= 0) return ""
  const base = new Date(`${date}T00:00:00`)
  if (Number.isNaN(base.getTime())) return ""
  base.setDate(base.getDate() + days)
  return base.toISOString().slice(0, 10)
}

function formatDate(value: string | null | undefined): string {
  if (!value) return "—"
  const parsed = new Date(value.length === 10 ? `${value}T00:00:00` : value)
  return Number.isNaN(parsed.getTime()) ? "—" : parsed.toLocaleDateString("en-GB")
}

export default function RefillsPage() {
  const { toast } = useToast()
  const [refills, setRefills] = useState<Refill[]>([])
  const [customers, setCustomers] = useState<Customer[]>([])
  const [status, setStatus] = useState("due")
  const [isLoading, setIsLoading] = useState(true)
  const [form, setForm] = useState(EMPTY_FORM)

  async function loadRefills(nextStatus = status) {
    setIsLoading(true)
    const response = await fetch(`/api/admin/refills?status=${nextStatus}`)
    const data = await response.json()
    setRefills(Array.isArray(data) ? data : [])
    setIsLoading(false)
  }

  async function loadCustomers() {
    const response = await fetch("/api/admin/customers")
    const data = await response.json()
    setCustomers(Array.isArray(data) ? data : [])
  }

  useEffect(() => {
    loadRefills()
    loadCustomers()
    // A customer card links here with ?customerId=<id> to schedule the next refill.
    const requested = new URLSearchParams(window.location.search).get("customerId")
    if (requested) setForm((current) => ({ ...current, customerId: requested }))
  }, [])

  const selectedCustomer = useMemo(
    () => customers.find((customer) => customer.id === form.customerId) ?? null,
    [customers, form.customerId],
  )

  // Following the routine: choose when it was last dispensed and how often it
  // repeats, and the due date fills itself in.
  function applyRoutine(next: Partial<typeof form>) {
    const merged = { ...form, ...next }
    const interval = Number(merged.intervalDays)
    if (!next.refillDueDate && merged.lastDispensed) {
      const computed = addDays(merged.lastDispensed, interval)
      if (computed) merged.refillDueDate = computed
    }
    setForm(merged)
  }

  async function createReminder(event: React.FormEvent) {
    event.preventDefault()
    const response = await fetch("/api/admin/refills", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(form),
    })
    if (!response.ok) {
      const data = await response.json().catch(() => ({}))
      toast({ variant: "destructive", title: "Refill reminder not created", description: data.error })
      return
    }
    setForm({ ...EMPTY_FORM, customerId: form.customerId })
    toast({ title: "Refill reminder created" })
    loadRefills()
  }

  async function updateReminder(id: string, action: "mark_sent" | "mark_dispensed") {
    const response = await fetch("/api/admin/refills", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, action }),
    })
    if (!response.ok) {
      toast({ variant: "destructive", title: "Could not update reminder" })
      return
    }
    loadRefills()
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl sm:text-3xl font-bold text-foreground">Refill Reminders</h1>
        <p className="text-muted-foreground mt-1 text-sm">Track customers due for medication refill and follow up before adherence drops.</p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2"><Plus className="h-5 w-5 text-primary" /> New reminder</CardTitle>
        </CardHeader>
        <CardContent>
          {customers.length === 0 ? (
            <div className="flex flex-col items-start gap-3 rounded-lg border border-dashed p-6 text-sm text-muted-foreground sm:flex-row sm:items-center sm:justify-between">
              <span>No customers yet. Add one first, then schedule their refill routine here.</span>
              <Button asChild variant="outline" size="sm">
                <Link href="/portal/customers"><UserPlus className="h-4 w-4 mr-2" /> Add customer</Link>
              </Button>
            </div>
          ) : (
            <form onSubmit={createReminder} className="grid gap-4 md:grid-cols-6">
              <div className="space-y-1.5 md:col-span-2">
                <Label htmlFor="refill-customer">Customer</Label>
                <select
                  id="refill-customer"
                  className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                  value={form.customerId}
                  onChange={(event) => applyRoutine({ customerId: event.target.value })}
                  required
                >
                  <option value="">Select a customer</option>
                  {customers.map((customer) => (
                    <option key={customer.id} value={customer.id}>
                      {customer.name}{customer.phone ? ` · ${customer.phone}` : ""}
                    </option>
                  ))}
                </select>
                {selectedCustomer?.phone && (
                  <p className="text-xs text-muted-foreground">Reminders go to {selectedCustomer.phone}</p>
                )}
              </div>
              <div className="space-y-1.5 md:col-span-2">
                <Label htmlFor="refill-drug">Drug name</Label>
                <Input
                  id="refill-drug"
                  value={form.drugName}
                  onChange={(e) => setForm({ ...form, drugName: e.target.value })}
                  placeholder="Metformin 500mg"
                  required
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="refill-last">Last dispensed</Label>
                <Input
                  id="refill-last"
                  type="date"
                  value={form.lastDispensed}
                  onChange={(e) => applyRoutine({ lastDispensed: e.target.value, refillDueDate: "" })}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="refill-interval">Repeat every (days)</Label>
                <Input
                  id="refill-interval"
                  type="number"
                  min={1}
                  value={form.intervalDays}
                  onChange={(e) => applyRoutine({ intervalDays: e.target.value, refillDueDate: "" })}
                />
              </div>
              <div className="space-y-1.5 md:col-span-2">
                <Label htmlFor="refill-due">Next due date</Label>
                <Input
                  id="refill-due"
                  type="date"
                  value={form.refillDueDate}
                  onChange={(e) => setForm({ ...form, refillDueDate: e.target.value })}
                  required
                />
              </div>
              <Button type="submit" className="md:col-span-2 md:col-start-5 md:self-end">Create</Button>
            </form>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <CardTitle className="flex items-center gap-2"><CalendarClock className="h-5 w-5 text-[#E8B84B]" /> Follow-up queue</CardTitle>
          <div className="flex gap-2">
            {["due", "upcoming", "dispensed", "all"].map((item) => (
              <Button key={item} variant={status === item ? "default" : "outline"} size="sm" onClick={() => { setStatus(item); loadRefills(item) }}>
                {item}
              </Button>
            ))}
          </div>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="h-32 rounded-lg bg-muted/30" />
          ) : refills.length === 0 ? (
            <div className="rounded-lg border border-dashed p-8 text-center text-muted-foreground">No refill reminders in this queue.</div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Customer</TableHead>
                  <TableHead>Drug</TableHead>
                  <TableHead>Routine</TableHead>
                  <TableHead>Next due</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {refills.map((refill) => (
                  <TableRow key={refill.id}>
                    <TableCell>
                      <div className="font-medium">{refill.customer?.name ?? "Customer"}</div>
                      <div className="text-xs text-muted-foreground">
                        {refill.customer?.phone ?? refill.customer?.email ?? "No contact"}
                      </div>
                    </TableCell>
                    <TableCell>{refill.drug_name}</TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {refill.interval_days ? `Every ${refill.interval_days} days` : "One-off"}
                      {refill.last_dispensed && (
                        <div className="text-xs">Last dispensed {formatDate(refill.last_dispensed)}</div>
                      )}
                    </TableCell>
                    <TableCell>{formatDate(refill.refill_due_date)}</TableCell>
                    <TableCell>{refill.dispensed ? "Dispensed" : refill.reminder_sent ? "Contacted" : "Due"}</TableCell>
                    <TableCell className="text-right">
                      <div className="flex justify-end gap-2">
                        {refill.customer?.id && (
                          <Button asChild variant="ghost" size="sm">
                            <Link href={`/portal/refills?customerId=${refill.customer.id}`} title="Add another reminder for this customer">
                              <Plus className="h-4 w-4" />
                            </Link>
                          </Button>
                        )}
                        <Button variant="outline" size="sm" onClick={() => updateReminder(refill.id, "mark_sent")}><MessageSquareText className="h-4 w-4" /> Contacted</Button>
                        <Button size="sm" onClick={() => updateReminder(refill.id, "mark_dispensed")}><CheckCircle2 className="h-4 w-4" /> Dispensed</Button>
                      </div>
                    </TableCell>
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
