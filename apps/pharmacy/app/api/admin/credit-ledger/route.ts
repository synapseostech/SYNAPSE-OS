import { NextRequest, NextResponse } from "next/server"
import { CreditLedgerError, postCreditLedgerEntry } from "@/lib/credit-ledger"
import { requirePharmacyPermission } from "@/lib/api-auth"
import { supabaseAdmin } from "@/lib/supabase/admin"
import { tenantOwnsRecord } from "@/lib/tenant-ownership"

export async function GET() {
  try {
    const auth = await requirePharmacyPermission("customers.credit")
    if (!auth.ok) return auth.response
    const { session, tenantId } = auth

    const { data, error } = await (supabaseAdmin as any)
      .from("pharmacy_credit_ledger")
      .select("*, customer:pharmacy_customers(id, name, email, phone)")
      .eq("tenant_id", tenantId)
      .order("created_at", { ascending: false })

    if (error) throw error

    const rows = data ?? []
    const latestByCustomer = new Map<string, { balance_after: number; due_date?: string | null }>()
    for (const row of rows) {
      const customerId = row.customer_id as string | null
      if (customerId && !latestByCustomer.has(customerId)) {
        latestByCustomer.set(customerId, {
          balance_after: Number(row.balance_after ?? 0),
          due_date: row.due_date,
        })
      }
    }

    const today = new Date().toISOString().slice(0, 10)
    const balances = Array.from(latestByCustomer.values())
    const totalOutstanding = balances.reduce((sum, row) => sum + Math.max(row.balance_after, 0), 0)
    const overdueOutstanding = balances
      .filter((row) => row.due_date && row.due_date < today && row.balance_after > 0)
      .reduce((sum, row) => sum + row.balance_after, 0)

    return NextResponse.json({
      summary: {
        totalOutstanding,
        overdueOutstanding,
        creditCustomers: balances.filter((row) => row.balance_after > 0).length,
        overdueCustomers: balances.filter((row) => row.due_date && row.due_date < today && row.balance_after > 0).length,
      },
      entries: rows,
    })
  } catch (error) {
    console.error("Credit ledger GET error:", error)
    return NextResponse.json({ error: "Failed to fetch credit ledger" }, { status: 500 })
  }
}

export async function POST(request: NextRequest) {
  try {
    const auth = await requirePharmacyPermission("customers.credit")
    if (!auth.ok) return auth.response
    const { session, tenantId } = auth

    const body = await request.json()
    const customerId = String(body.customerId ?? "").trim()
    const type = String(body.type ?? "").trim()
    const amount = Number(body.amount ?? 0)
    const paymentMethod = String(body.paymentMethod ?? "cash").trim().toLowerCase()

    if (!customerId || !["credit", "repayment"].includes(type) || !Number.isFinite(amount) || amount <= 0 ||
      Math.abs(amount * 100 - Math.round(amount * 100)) > 0.000001) {
      return NextResponse.json({ error: "Customer, entry type, and positive amount are required" }, { status: 400 })
    }
    if (!["cash", "card", "mobile_money", "mobile money", "bank_transfer", "bank transfer"].includes(paymentMethod)) {
      return NextResponse.json({ error: "Choose a supported payment method." }, { status: 400 })
    }
    if (!(await tenantOwnsRecord("pharmacy_customers", tenantId, customerId))) {
      return NextResponse.json({ error: "Customer not found" }, { status: 404 })
    }
    if (body.transactionId && !(await tenantOwnsRecord("pharmacy_transactions", tenantId, body.transactionId))) {
      return NextResponse.json({ error: "Transaction not found" }, { status: 404 })
    }

    const idempotencyKey =
      request.headers.get("idempotency-key")?.trim().slice(0, 128) ||
      (typeof body.idempotencyKey === "string" ? body.idempotencyKey.trim().slice(0, 128) : "") ||
      null
    if (type === "repayment" && !idempotencyKey) {
      return NextResponse.json({ error: "An idempotency key is required for customer repayments." }, { status: 400 })
    }

    let data: Awaited<ReturnType<typeof postCreditLedgerEntry>>
    try {
      // Atomic in the DB: customer row lock + balance + overpayment check + insert.
      data = await postCreditLedgerEntry({
        tenantId,
        customerId,
        type: type as "credit" | "repayment",
        amount,
        transactionId: body.transactionId || null,
        dueDate: body.dueDate || null,
        notes: body.notes || null,
        createdBy: session.user.id,
        idempotencyKey,
        paymentMethod,
      })
    } catch (err) {
      if (err instanceof CreditLedgerError && err.code === "OVERPAYMENT") {
        const currentBalance = err.balance ?? 0
        return NextResponse.json(
          {
            error:
              currentBalance > 0
                ? `Repayment exceeds the outstanding balance of ${currentBalance}.`
                : "This customer has no outstanding balance.",
            code: "OVERPAYMENT",
            balance: currentBalance,
          },
          { status: 400 },
        )
      }
      if (err instanceof CreditLedgerError && err.code === "CUSTOMER_NOT_FOUND") {
        return NextResponse.json({ error: "Customer not found" }, { status: 404 })
      }
      if (err instanceof CreditLedgerError && err.code === "IDEMPOTENCY_CONFLICT") {
        return NextResponse.json({ error: err.message }, { status: 409 })
      }
      throw err
    }
    const balanceAfter = Number(data.balance_after)
    if (data.replayed) return NextResponse.json(data, { status: 200 })

    await supabaseAdmin.from("pharmacy_audit_logs").insert({
      tenant_id: tenantId,
      profile_id: session.user.id,
      action: "CREATE_CREDIT_LEDGER_ENTRY",
      entity: "PHARMACY_CREDIT_LEDGER",
      entity_id: data.id,
      details: `${type} entry of ${amount} recorded. Balance: ${balanceAfter}`,
    })

    return NextResponse.json(data, { status: 201 })
  } catch (error) {
    console.error("Credit ledger POST error:", error)
    return NextResponse.json({ error: "Failed to create credit ledger entry" }, { status: 500 })
  }
}
