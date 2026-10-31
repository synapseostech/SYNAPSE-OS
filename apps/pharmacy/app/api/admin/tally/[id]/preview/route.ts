import { NextRequest, NextResponse } from "next/server"
import { requireTallyAdmin } from "@/lib/tally/auth"
import { CUTOVER_ALREADY_COMPLETE, findCompletedCutover } from "@/lib/tally/cutover"
import { supabaseAdmin } from "@/lib/supabase/admin"
import { normaliseTallyDocument } from "@synapse/db/tally-normalise"
import type { TallyAccountOverrides } from "@synapse/db/tally-map"
import { readTallySource, type TallyStorageClient } from "@/lib/tally/storage"
import { readTallyDocument } from "@/lib/tally/source"
import { writeTallyPlan } from "@/lib/tally/plan"
import { tallyErrorResponse } from "@/lib/tally/http"

const db = () => supabaseAdmin as any
const storage = () => ({ storage: db().storage }) as TallyStorageClient

const PREVIEW_LIMIT = 200

type MappingState = {
  format?: "xml" | "xlsx" | "xls" | "csv"
  path?: string
  bucket?: string
  conversionDate?: string
  accountOverrides?: TallyAccountOverrides
  productSkuOverrides?: Record<string, string>
}

/**
 * POST /api/admin/tally/[id]/preview
 * Parses the uploaded file, normalises it, persists the plan, and returns the
 * review payload. Nothing is written to the ledger here.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireTallyAdmin(request, "inventory.write")
  if (!auth.ok) return auth.response
  const { tenantId } = auth
  const { id } = await params

  if (await findCompletedCutover(tenantId)) {
    return NextResponse.json(CUTOVER_ALREADY_COMPLETE, { status: 409 })
  }

  const { data: session, error: loadError } = await db()
    .from("pharmacy_import_sessions")
    .select("id, status, file_name, file_url, ai_mapping")
    .eq("id", id)
    .eq("tenant_id", tenantId)
    .maybeSingle()
  if (loadError || !session) {
    return NextResponse.json({ error: "Import session not found" }, { status: 404 })
  }
  if (session.status === "importing" || session.status === "complete") {
    return NextResponse.json(
      { error: "This import has already been applied and cannot be re-previewed." },
      { status: 409 },
    )
  }

  let body: { conversionDate?: string } = {}
  try {
    const text = await request.text()
    if (text.trim()) body = JSON.parse(text) as { conversionDate?: string }
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 })
  }

  const mapping = (session.ai_mapping ?? {}) as MappingState
  const path = mapping.path ?? session.file_url
  if (!path) {
    return NextResponse.json({ error: "Upload the file before previewing it." }, { status: 409 })
  }

  try {
    const bytes = await readTallySource(storage(), path)
    const { format, document } = readTallyDocument(bytes, session.file_name ?? undefined)

    const plan = normaliseTallyDocument(document, {
      conversionDate: body.conversionDate ?? mapping.conversionDate,
      currency: document.currency,
      accountOverrides: mapping.accountOverrides,
      productSkuOverrides: mapping.productSkuOverrides,
    })

    const summary = await writeTallyPlan(storage(), tenantId, id, plan, format)

    await db()
      .from("pharmacy_import_sessions")
      .update({
        status: "review",
        total_rows: plan.counts.vouchers,
        flagged_rows: plan.exceptions.filter((entry) => entry.severity === "blocking").length,
        ai_summary: summary.exceptions[0]?.message?.slice(0, 500) ?? null,
        ai_mapping: {
          ...mapping,
          format,
          path,
          conversionDate: plan.conversionDate,
          summary,
          preparedAt: summary.preparedAt,
        },
        error_message: null,
      })
      .eq("id", id)
      .eq("tenant_id", tenantId)

    return NextResponse.json({
      summary,
      preview: {
        accounts: plan.accounts.slice(0, PREVIEW_LIMIT).map((account) => ({
          code: account.code,
          name: account.name,
          sourceName: account.sourceName,
          accountType: account.accountType,
          normalBalance: account.normalBalance,
          role: account.role,
          systemKey: account.systemKey,
          partyType: account.partyType,
          openingBalance: account.openingBalance,
          openingSide: account.openingSide,
          openingMethod: account.openingMethod,
          unclassified: account.unclassified,
        })),
        accountTotal: plan.accounts.length,
        parties: plan.parties.slice(0, PREVIEW_LIMIT).map((party) => ({
          kind: party.kind,
          name: party.name,
          accountCode: party.accountCode,
          openingBalance: party.openingBalance,
          billCount: party.bills.length,
          nextDueDate: party.bills.map((bill) => bill.dueDate).filter(Boolean).sort()[0],
        })),
        partyTotal: plan.parties.length,
        stockItems: plan.stockItems.slice(0, PREVIEW_LIMIT).map((item) => ({
          sku: item.sku,
          name: item.name,
          quantity: item.quantity,
          unit: item.unit,
          batchCount: item.batches.length,
          receivableBatches: item.batches.filter((batch) => batch.receivable).length,
          expiredBatches: item.batches.filter(
            (batch) => Boolean(batch.expiryDate) && !batch.receivable,
          ).length,
        })),
        stockItemTotal: plan.stockItems.length,
        vouchers: plan.vouchers.slice(0, PREVIEW_LIMIT).map((voucher) => ({
          sourceId: voucher.sourceId,
          kind: voucher.kind,
          date: voucher.date,
          number: voucher.number,
          partyName: voucher.partyName,
          total: voucher.lines.reduce((sum, line) => sum + line.debit, 0),
        })),
        voucherTotal: plan.vouchers.length,
        salesTotal: plan.sales.length,
        purchasesTotal: plan.purchases.length,
      },
    })
  } catch (error) {
    const response = tallyErrorResponse(error)
    if (response.status >= 400 && response.status < 500) {
      await db()
        .from("pharmacy_import_sessions")
        .update({
          status: "failed",
          error_message:
            error instanceof Error ? error.message.slice(0, 500) : "Preview failed",
        })
        .eq("id", id)
        .eq("tenant_id", tenantId)
    }
    return response
  }
}
