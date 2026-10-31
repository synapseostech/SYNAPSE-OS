import { NextRequest, NextResponse } from "next/server"
import { requirePharmacyPermission } from "@/lib/api-auth"
import { supabaseAdmin } from "@/lib/supabase/admin"
import { tenantOwnsRecord } from "@/lib/tenant-ownership"

export async function GET(request: NextRequest) {
  try {
    const auth = await requirePharmacyPermission("pos.sell")
    if (!auth.ok) return auth.response
    const { session, tenantId } = auth

    const status = new URL(request.url).searchParams.get("status") ?? "due"
    const today = new Date().toISOString().slice(0, 10)
    let query = (supabaseAdmin as any)
      .from("refill_reminders")
      .select("*, customer:pharmacy_customers(id, name, email, phone)")
      .eq("tenant_id", tenantId)
      .order("refill_due_date", { ascending: true })

    if (status === "due") query = query.lte("refill_due_date", today).eq("dispensed", false)
    if (status === "upcoming") query = query.gt("refill_due_date", today).eq("dispensed", false)
    if (status === "dispensed") query = query.eq("dispensed", true)

    const { data, error } = await query
    if (error) throw error

    return NextResponse.json(data ?? [])
  } catch (error) {
    console.error("Refills GET error:", error)
    return NextResponse.json({ error: "Failed to fetch refill reminders" }, { status: 500 })
  }
}

export async function POST(request: NextRequest) {
  try {
    const auth = await requirePharmacyPermission("pos.sell")
    if (!auth.ok) return auth.response
    const { session, tenantId } = auth

    const body = await request.json()
    const drugName = String(body.drugName ?? "").trim()
    const refillDueDate = String(body.refillDueDate ?? "").trim()
    const customerId = String(body.customerId ?? "").trim()
    const intervalDays = Number(body.intervalDays ?? 30)

    if (!drugName || !refillDueDate || !customerId) {
      return NextResponse.json({ error: "Customer, drug, and due date are required" }, { status: 400 })
    }
    if (!(await tenantOwnsRecord("pharmacy_customers", tenantId, customerId))) {
      return NextResponse.json({ error: "Customer not found" }, { status: 404 })
    }

    const { data, error } = await supabaseAdmin
      .from("refill_reminders")
      .insert({
        tenant_id: tenantId,
        customer_id: customerId,
        drug_name: drugName,
        last_dispensed: body.lastDispensed || null,
        refill_due_date: refillDueDate,
        interval_days: Number.isFinite(intervalDays) ? intervalDays : 30,
      })
      .select()
      .single()

    if (error) throw error

    await supabaseAdmin.from("pharmacy_audit_logs").insert({
      tenant_id: tenantId,
      profile_id: session.user.id,
      action: "CREATE_REFILL_REMINDER",
      entity: "REFILL_REMINDER",
      entity_id: data.id,
      details: `Created refill reminder for ${drugName}`,
    })

    return NextResponse.json(data, { status: 201 })
  } catch (error) {
    console.error("Refills POST error:", error)
    return NextResponse.json({ error: "Failed to create refill reminder" }, { status: 500 })
  }
}

export async function PATCH(request: NextRequest) {
  try {
    const auth = await requirePharmacyPermission("pos.sell")
    if (!auth.ok) return auth.response
    const { session, tenantId } = auth

    const { id, action } = await request.json()
    if (!id || !["mark_sent", "mark_dispensed"].includes(action)) {
      return NextResponse.json({ error: "Valid id and action are required" }, { status: 400 })
    }

    const patch =
      action === "mark_sent"
        ? { reminder_sent: true, last_reminder_sent_at: new Date().toISOString() }
        : { dispensed: true, dispensed_at: new Date().toISOString() }

    const { data, error } = await supabaseAdmin
      .from("refill_reminders")
      .update(patch)
      .eq("id", id)
      .eq("tenant_id", tenantId)
      .select()
      .single()

    if (error) throw error
    return NextResponse.json(data)
  } catch (error) {
    console.error("Refills PATCH error:", error)
    return NextResponse.json({ error: "Failed to update refill reminder" }, { status: 500 })
  }
}
