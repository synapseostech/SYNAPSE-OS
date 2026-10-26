import { NextRequest, NextResponse } from "next/server"
import { requirePharmacyPermission } from "@/lib/api-auth"
import { supabaseAdmin } from "@/lib/supabase/admin"
import { applySettlements, summariseAgeing, type OpenInvoice } from "@/lib/accounting/ageing"

export const dynamic = "force-dynamic"

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const MAX_ROWS = 20_000

function isIsoDate(value: string): boolean {
  if (!DATE_RE.test(value)) return false
  const parsed = new Date(`${value}T00:00:00.000Z`)
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value
}

type LedgerRow = {
  id: string
  customer_id: string | null
  transaction_id: string | null
  amount: number | string
  type: "credit" | "repayment"
  due_date: string | null
  created_at: string
  customer: { name: string } | null
}

function isoDay(timestamp: string): string {
  return timestamp.slice(0, 10)
}

function money(value: unknown): number {
  const parsed = Number(value ?? 0)
  return Number.isFinite(parsed) ? Math.round(parsed * 100) / 100 : 0
}

export async function GET(request: NextRequest) {
  try {
    const auth = await requirePharmacyPermission("reports.financial")
    if (!auth.ok) return auth.response
    const { tenantId } = auth

    const params = request.nextUrl.searchParams
    const asOf = params.get("asOf") ?? new Date().toISOString().slice(0, 10)
    if (!isIsoDate(asOf)) {
      return NextResponse.json({ error: "Use a valid as-of date in YYYY-MM-DD format." }, { status: 400 })
    }

    const side = params.get("side") ?? "all"
    if (!["all", "receivable", "payable"].includes(side)) {
      return NextResponse.json({ error: "Side must be all, receivable or payable." }, { status: 400 })
    }

    const db = supabaseAdmin as any
    const { data: settings, error: settingsError } = await db
      .from("pharmacy_settings")
      .select("currency")
      .eq("tenant_id", tenantId)
      .maybeSingle()
    if (settingsError) throw settingsError
    const currency = String(settings?.currency ?? "UGX")

    let receivable:
      | (ReturnType<typeof summariseAgeing> & { customerCount: number; currency: string })
      | undefined
    if (side !== "payable") {
      const { data, error } = await db
        .from("pharmacy_credit_ledger")
        .select("id, customer_id, transaction_id, amount, type, due_date, created_at, customer:pharmacy_customers(name)")
        .eq("tenant_id", tenantId)
        .lte("created_at", `${asOf}T23:59:59.999Z`)
        .order("created_at", { ascending: true })
        .limit(MAX_ROWS)
      if (error) throw error

      type ReceivableGroup = {
        name: string
        invoices: OpenInvoice[]
        invoiceDates: Map<string, string>
        references: Map<string, string>
        settled: number
      }
      const groups = new Map<string, ReceivableGroup>()
      for (const row of ((data ?? []) as LedgerRow[])) {
        const key = row.customer_id ?? "walk-in"
        const group: ReceivableGroup =
          groups.get(key) ??
          { name: row.customer?.name?.trim() || "Walk-in customer", invoices: [], invoiceDates: new Map(), references: new Map(), settled: 0 }
        if (row.type === "repayment") {
          group.settled += money(row.amount)
        } else {
          group.invoices.push({
            id: row.id,
            amount: money(row.amount),
            dueDate: row.due_date ?? isoDay(row.created_at),
          })
          group.invoiceDates.set(row.id, isoDay(row.created_at))
          group.references.set(row.id, row.transaction_id ? `TXN-${row.transaction_id.slice(0, 8)}` : `CR-${row.id.slice(0, 8)}`)
        }
        groups.set(key, group)
      }

      const rows = [...groups.values()].flatMap((group) =>
        applySettlements(group.invoices, group.settled).map((invoice) => ({
          partyName: group.name,
          reference: group.references.get(invoice.id) ?? invoice.id.slice(0, 8),
          date: group.invoiceDates.get(invoice.id) ?? invoice.dueDate,
          dueDate: invoice.dueDate,
          amount: invoice.outstanding,
          asOf,
        })),
      )
      receivable = { ...summariseAgeing(rows), customerCount: groups.size, currency }
    }

    let payable: Array<ReturnType<typeof summariseAgeing> & { currency: string; supplierCount: number }> | undefined
    if (side !== "receivable") {
      const { data, error } = await db
        .from("pharmacy_purchases")
        .select("id, purchase_no, purchase_date, balance, currency, supplier:pharmacy_suppliers(name)")
        .eq("tenant_id", tenantId)
        .gt("balance", 0)
        .lte("purchase_date", asOf)
        .order("purchase_date", { ascending: true })
        .limit(MAX_ROWS)
      if (error) throw error

      const byCurrency = new Map<
        string,
        { rows: Array<{ partyName: string; reference: string; date: string; dueDate: string; amount: number; asOf: string }>; suppliers: Set<string> }
      >()
      for (const row of ((data ?? []) as Array<Record<string, any>>)) {
        const rowCurrency = String(row.currency ?? currency)
        const group = byCurrency.get(rowCurrency) ?? { rows: [], suppliers: new Set<string>() }
        group.rows.push({
          partyName: row.supplier?.name?.trim() || "Unknown supplier",
          reference: String(row.purchase_no ?? ""),
          date: row.purchase_date,
          dueDate: row.purchase_date,
          amount: money(row.balance),
          asOf,
        })
        if (row.supplier?.name) group.suppliers.add(String(row.supplier.name))
        byCurrency.set(rowCurrency, group)
      }

      payable = [...byCurrency.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([rowCurrency, group]) => ({
          ...summariseAgeing(group.rows),
          currency: rowCurrency,
          supplierCount: group.suppliers.size,
        }))
    }

    return NextResponse.json({
      asOf,
      // Repayments carry no invoice link, so they settle the oldest invoice first.
      allocation: "oldest-first",
      ...(receivable ? { receivable } : {}),
      ...(payable ? { payable } : {}),
    })
  } catch (error) {
    console.error("Pharmacy ageing GET error:", error)
    return NextResponse.json({ error: "Failed to load outstanding balances" }, { status: 500 })
  }
}
