import { NextRequest, NextResponse } from "next/server"
import { requirePharmacyPermission } from "@/lib/api-auth"
import { supabaseAdmin } from "@/lib/supabase/admin"
import {
  DAY_BOOK_KINDS,
  VOUCHER_KIND_LABELS,
  dayBookKindFilter,
  isDayBookKind,
  voucherKindFromSource,
  type DayBookKind,
} from "@/lib/accounting/voucher-types"

export const dynamic = "force-dynamic"

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const PAGE_SIZE_DEFAULT = 50
const PAGE_SIZE_MAX = 200

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
    const today = new Date().toISOString().slice(0, 10)
    const from = params.get("from") ?? `${today.slice(0, 4)}-01-01`
    const to = params.get("to") ?? today
    if (!isIsoDate(from) || !isIsoDate(to) || from > to) {
      return NextResponse.json(
        { error: "Use valid dates in YYYY-MM-DD format, with from no later than to." },
        { status: 400 },
      )
    }

    const rawKind = params.get("voucherType")
    if (rawKind && rawKind !== "all" && !isDayBookKind(rawKind)) {
      return NextResponse.json({ error: "Unknown voucher type." }, { status: 400 })
    }
    const kind = rawKind && rawKind !== "all" ? (rawKind as DayBookKind) : null

    const accountId = params.get("accountId")?.trim() || null
    if (accountId && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(accountId)) {
      return NextResponse.json({ error: "Use a valid account id." }, { status: 400 })
    }

    const page = Math.max(1, Number.parseInt(params.get("page") ?? "1", 10) || 1)
    const pageSize = Math.min(
      PAGE_SIZE_MAX,
      Math.max(1, Number.parseInt(params.get("pageSize") ?? String(PAGE_SIZE_DEFAULT), 10) || PAGE_SIZE_DEFAULT),
    )

    const db = supabaseAdmin as any

    let entryIds: string[] | null = null
    if (accountId) {
      const { data: lineRows, error: lineError } = await db
        .from("pharmacy_accounting_journal_lines")
        .select("journal_entry_id")
        .eq("tenant_id", tenantId)
        .eq("account_id", accountId)
        .limit(10_000)
      if (lineError) throw lineError
      entryIds = [...new Set(((lineRows ?? []) as Array<{ journal_entry_id: string }>).map((row) => row.journal_entry_id))]
      if (entryIds.length === 0) {
        return NextResponse.json({ from, to, page, pageSize, total: 0, entries: [], kinds: [...DAY_BOOK_KINDS] })
      }
    }

    let query = db
      .from("pharmacy_accounting_journal_entries")
      .select(
        `
          id, entry_no, entry_date, source_type, source_id, description, currency, total_debit, total_credit,
          lines:pharmacy_accounting_journal_lines(
            id, debit, credit, description,
            account:pharmacy_accounting_accounts(id, code, name)
          )
        `,
        { count: "exact" },
      )
      .eq("tenant_id", tenantId)
      .gte("entry_date", from)
      .lte("entry_date", to)
      .order("entry_date", { ascending: false })
      .order("created_at", { ascending: false })

    if (kind) query = query.or(dayBookKindFilter(kind))
    if (entryIds) query = query.in("id", entryIds)

    const offset = (page - 1) * pageSize
    const { data, error, count } = await query.range(offset, offset + pageSize - 1)
    if (error) throw error

    const entries = (data ?? []).map((entry: any) => {
      const entryKind = voucherKindFromSource(String(entry.source_type), String(entry.source_id ?? ""))
      return {
        id: entry.id,
        entryNo: entry.entry_no,
        date: entry.entry_date,
        sourceType: entry.source_type,
        voucherType: entryKind,
        voucherLabel: VOUCHER_KIND_LABELS[entryKind],
        description: entry.description,
        currency: entry.currency,
        totalDebit: Number(entry.total_debit ?? 0),
        totalCredit: Number(entry.total_credit ?? 0),
        lines: (entry.lines ?? []).map((line: any) => ({
          id: line.id,
          accountId: line.account?.id ?? null,
          accountCode: line.account?.code ?? "",
          accountName: line.account?.name ?? "",
          debit: Number(line.debit ?? 0),
          credit: Number(line.credit ?? 0),
          description: line.description ?? "",
        })),
      }
    })

    return NextResponse.json({
      from,
      to,
      page,
      pageSize,
      total: count ?? entries.length,
      entries,
      kinds: [...DAY_BOOK_KINDS],
    })
  } catch (error) {
    console.error("Pharmacy day book GET error:", error)
    return NextResponse.json({ error: "Failed to load the day book" }, { status: 500 })
  }
}
