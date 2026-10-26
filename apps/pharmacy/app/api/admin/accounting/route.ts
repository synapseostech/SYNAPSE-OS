import { NextRequest, NextResponse } from "next/server"
import { requirePharmacyPermission } from "@/lib/api-auth"
import { supabaseAdmin } from "@/lib/supabase/admin"
import {
  VOUCHER_TYPES,
  isVoucherType,
  manualVoucherSourceId,
  validateVoucher,
  type VoucherAccount,
} from "@/lib/accounting/voucher-types"

export const dynamic = "force-dynamic"

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

function isIsoDate(value: string): boolean {
  if (!DATE_RE.test(value)) return false
  const parsed = new Date(`${value}T00:00:00.000Z`)
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value
}

export async function GET(request: NextRequest) {
  try {
    const auth = await requirePharmacyPermission("reports.financial")
    if (!auth.ok) return auth.response
    const { tenantId } = auth

    const params = request.nextUrl.searchParams
    const startDate = params.get("from")
    const endDate = params.get("to") ?? new Date().toISOString().slice(0, 10)
    if (
      (startDate && !isIsoDate(startDate)) ||
      !isIsoDate(endDate) ||
      (startDate && startDate > endDate)
    ) {
      return NextResponse.json({ error: "Use valid dates in YYYY-MM-DD format, with from no later than to." }, { status: 400 })
    }

    const db = supabaseAdmin as any
    const { error: seedError } = await db.rpc("seed_pharmacy_accounting_accounts", {
      p_tenant_id: tenantId,
    })
    if (seedError) throw seedError

    const [accountsResult, balanceResult, activityResult, entriesResult, settingsResult] = await Promise.all([
      db
        .from("pharmacy_accounting_accounts")
        .select("id, code, name, account_type, normal_balance, system_key, is_system")
        .eq("tenant_id", tenantId)
        .eq("is_active", true)
        .order("code"),
      db.rpc("pharmacy_accounting_trial_balance", {
        p_tenant_id: tenantId,
        p_from: null,
        p_to: endDate,
      }),
      db.rpc("pharmacy_accounting_trial_balance", {
        p_tenant_id: tenantId,
        p_from: startDate ?? `${endDate.slice(0, 4)}-01-01`,
        p_to: endDate,
      }),
      db
        .from("pharmacy_accounting_journal_entries")
        .select(`
          id, entry_no, entry_date, source_type, source_id, description, currency, total_debit, total_credit,
          lines:pharmacy_accounting_journal_lines(
            debit, credit, account:pharmacy_accounting_accounts(code, name)
          )
        `)
        .eq("tenant_id", tenantId)
        .lte("entry_date", endDate)
        .gte("entry_date", startDate ?? `${endDate.slice(0, 4)}-01-01`)
        .order("entry_date", { ascending: false })
        .order("created_at", { ascending: false })
        .limit(50),
      db
        .from("pharmacy_settings")
        .select("currency")
        .eq("tenant_id", tenantId)
        .maybeSingle(),
    ])

    for (const result of [accountsResult, balanceResult, activityResult, entriesResult, settingsResult]) {
      if (result.error) throw result.error
    }

    return NextResponse.json({
      endDate,
      startDate: startDate ?? `${endDate.slice(0, 4)}-01-01`,
      currency: settingsResult.data?.currency ?? "UGX",
      accounts: accountsResult.data ?? [],
      trialBalance: balanceResult.data ?? [],
      periodActivity: activityResult.data ?? [],
      recentEntries: entriesResult.data ?? [],
    })
  } catch (error) {
    console.error("Pharmacy accounting GET error:", error)
    return NextResponse.json({ error: "Failed to load accounting records" }, { status: 500 })
  }
}

export async function POST(request: NextRequest) {
  try {
    const auth = await requirePharmacyPermission("reports.financial")
    if (!auth.ok) return auth.response
    const { session, tenantId } = auth

    const body = await request.json().catch(() => null)
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return NextResponse.json({ error: "A journal entry is required." }, { status: 400 })
    }

    const description = typeof body.description === "string" ? body.description.trim() : ""
    const entryDate = typeof body.entryDate === "string" ? body.entryDate : ""
    const idempotencyKey =
      request.headers.get("idempotency-key")?.trim() ||
      (typeof body.idempotencyKey === "string" ? body.idempotencyKey.trim() : "")
    const lines = Array.isArray(body.lines) ? body.lines : []
    const rawVoucherType = body.voucherType ?? "journal"
    if (!isVoucherType(rawVoucherType)) {
      return NextResponse.json(
        { error: `Voucher type must be one of: ${VOUCHER_TYPES.join(", ")}.` },
        { status: 400 },
      )
    }
    const voucherType = rawVoucherType

    if (!description || description.length > 500 || !isIsoDate(entryDate)) {
      return NextResponse.json({ error: "A description (up to 500 characters) and valid entry date are required." }, { status: 400 })
    }
    if (!idempotencyKey || idempotencyKey.length > 128) {
      return NextResponse.json({ error: "A valid idempotency key is required." }, { status: 400 })
    }
    if (lines.length < 2 || lines.length > 100) {
      return NextResponse.json({ error: "A journal entry needs between 2 and 100 lines." }, { status: 400 })
    }
    if (lines.some((line: unknown) => !line || typeof line !== "object" || Array.isArray(line))) {
      return NextResponse.json({ error: "Journal lines must be objects." }, { status: 400 })
    }

    const normalizedLines = lines.map((line: Record<string, unknown>) => ({
      account_id: typeof line.accountId === "string" ? line.accountId : "",
      debit: Number(line.debit ?? 0),
      credit: Number(line.credit ?? 0),
      description: typeof line.description === "string" ? line.description.trim().slice(0, 300) : "",
    }))
    if (normalizedLines.some((line: { account_id: string; debit: number; credit: number }) =>
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(line.account_id) ||
      !Number.isFinite(line.debit) || !Number.isFinite(line.credit) || line.debit < 0 || line.credit < 0 ||
      Math.abs(line.debit * 100 - Math.round(line.debit * 100)) > 0.000001 ||
      Math.abs(line.credit * 100 - Math.round(line.credit * 100)) > 0.000001 ||
      (line.debit > 0 && line.credit > 0) || (line.debit === 0 && line.credit === 0)
    )) {
      return NextResponse.json({ error: "Each line needs a valid account and a positive debit or credit, not both." }, { status: 400 })
    }

    const db = supabaseAdmin as any
    const accountIds: string[] = [
      ...new Set<string>(normalizedLines.map((line: { account_id: string }) => line.account_id)),
    ]

    const [{ data: settings, error: settingsError }, { data: accountRows, error: accountsError }] =
      await Promise.all([
        db.from("pharmacy_settings").select("currency").eq("tenant_id", tenantId).maybeSingle(),
        db
          .from("pharmacy_accounting_accounts")
          .select("id, code, name, system_key")
          .eq("tenant_id", tenantId)
          .eq("is_active", true)
          .in("id", accountIds),
      ])
    if (settingsError) throw settingsError
    if (accountsError) throw accountsError

    const accounts = new Map<string, VoucherAccount>(
      ((accountRows ?? []) as VoucherAccount[]).map((account) => [account.id.toLowerCase(), account]),
    )
    if (accountIds.some((id: string) => !accounts.has(id.toLowerCase()))) {
      return NextResponse.json(
        { error: "One of the selected accounts is not in this pharmacy's chart of accounts." },
        { status: 400 },
      )
    }

    const voucherCheck = validateVoucher(voucherType, normalizedLines, accounts)
    if (!voucherCheck.ok) {
      return NextResponse.json({ error: voucherCheck.error }, { status: 400 })
    }

    const { data, error } = await db.rpc("post_pharmacy_accounting_journal", {
      p_tenant_id: tenantId,
      p_source_type: "manual",
      p_source_id: manualVoucherSourceId(voucherType, idempotencyKey),
      p_entry_date: entryDate,
      p_description: description,
      p_currency: settings?.currency ?? "UGX",
      p_created_by: session.user.id,
      p_lines: normalizedLines,
    })
    if (error) {
      const message = String(error.message ?? "")
      if (message.includes("ACCOUNTING_PERIOD_CLOSED")) {
        return NextResponse.json({ error: "That accounting period is closed; post a dated adjustment in an open period." }, { status: 409 })
      }
      if (message.includes("ACCOUNTING_UNBALANCED") || message.includes("ACCOUNTING_INVALID_LINE") ||
        message.includes("ACCOUNTING_ACCOUNT_NOT_FOUND") || message.includes("ACCOUNTING_LINES_REQUIRED")) {
        return NextResponse.json({ error: "The journal is not balanced or contains an invalid account line." }, { status: 400 })
      }
      throw error
    }

    return NextResponse.json(
      { ok: true, voucherType, entry: data },
      { status: data?.replayed ? 200 : 201 },
    )
  } catch (error) {
    console.error("Pharmacy accounting POST error:", error)
    return NextResponse.json({ error: "Failed to post accounting journal entry" }, { status: 500 })
  }
}
