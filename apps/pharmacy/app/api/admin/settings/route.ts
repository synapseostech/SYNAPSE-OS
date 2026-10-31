import { NextRequest, NextResponse } from "next/server"
import { requirePharmacyPermission, requirePharmacyTenant } from "@/lib/api-auth"
import { supabaseAdmin } from "@/lib/supabase/admin"

function normalizePaperWidth(raw: unknown, printerType?: unknown): "58" | "80" | "a4" {
  const paper = String(raw ?? "").toLowerCase()
  if (paper === "58" || paper === "80" || paper === "a4") return paper
  const printer = String(printerType ?? "").toLowerCase()
  if (printer.includes("58")) return "58"
  if (printer.includes("brother") || printer.includes("a4") || printer.includes("letter")) return "a4"
  return "80"
}

export async function GET(request: NextRequest) {
  try {
    // Branding and receipt layout, not personal data: every member of the
    // tenant prints receipts, so the read is tenant-scoped. Only settings.manage
    // may write.
    const auth = await requirePharmacyTenant()
    if (!auth.ok) return auth.response
    const { tenantId } = auth

    const { data: settings, error } = await (supabaseAdmin as any)
      .from("pharmacy_settings")
      .select("*")
      .eq("tenant_id", tenantId)
      .single()

    if (error && error.code !== "PGRST116") throw error
    if (!settings) return NextResponse.json(null)

    // Return camelCase so client-side Settings interface matches
    return NextResponse.json({
      id:                settings.id,
      tenantId:          settings.tenant_id,
      pharmacyName:      settings.pharmacy_name ?? "",
      location:          settings.location ?? "",
      contact:           settings.contact ?? "",
      email:             settings.email ?? "",
      logo:              settings.logo ?? null,
      footerText:        settings.footer_text ?? "",
      receiptHeader:     settings.receipt_header ?? "",
      receiptFooter:     settings.receipt_footer ?? "",
      currency:          settings.currency ?? "UGX",
      taxRate:           settings.tax_rate ?? 0,
      lowStockThreshold: settings.low_stock_threshold ?? 10,
      printerType:       settings.printer_type ?? "default",
      receiptPaperWidth: normalizePaperWidth(settings.receipt_paper_width, settings.printer_type),
      receiptFontScale:  Number(settings.receipt_font_scale ?? 1) || 1,
      autoPrintReceipt:  Boolean(settings.auto_print_receipt),
      discountApprovalThresholdPct: Number(settings.discount_approval_threshold_pct ?? 5),
      mandatoryReceiptPrint: settings.mandatory_receipt_print !== false,
      vatEnabled: Boolean(settings.vat_enabled),
      vatRate: Number(settings.vat_rate ?? 18),
    })
  } catch (error) {
    console.error("Get settings error:", error)
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    )
  }
}

export async function POST(request: NextRequest) {
  try {
    const auth = await requirePharmacyPermission("settings.manage")
    if (!auth.ok) return auth.response
    const { session, tenantId } = auth

    const data = await request.json()
    const printerType = data.printerType ?? "default"
    const receiptPaperWidth = normalizePaperWidth(data.receiptPaperWidth, printerType)
    const receiptFontScale = Number(data.receiptFontScale ?? 1) || 1
    const autoPrintReceipt = Boolean(data.autoPrintReceipt)

    const corePayload = {
      tenant_id: tenantId,
      pharmacy_name: data.pharmacyName,
      location: data.location,
      contact: data.contact,
      email: data.email,
      logo: data.logo,
      footer_text: data.footerText ?? "",
      receipt_header: data.receiptHeader,
      receipt_footer: data.receiptFooter,
      currency: data.currency ?? "UGX",
      tax_rate: data.taxRate ?? 0,
      low_stock_threshold: data.lowStockThreshold,
      printer_type: printerType,
    }

    const fullPayload = {
      ...corePayload,
      receipt_paper_width: receiptPaperWidth,
      receipt_font_scale: receiptFontScale,
      auto_print_receipt: autoPrintReceipt,
    }

    let settings: any = null
    let error: any = null

    ;({ data: settings, error } = await supabaseAdmin
      .from("pharmacy_settings")
      .upsert(fullPayload, { onConflict: "tenant_id" })
      .select()
      .single())

    // Live DB may not have printer preference columns yet — save core + best-effort prefs.
    if (error) {
      console.warn("Save settings with printer prefs failed; retrying core:", error.message ?? error)
      ;({ data: settings, error } = await supabaseAdmin
        .from("pharmacy_settings")
        .upsert(corePayload, { onConflict: "tenant_id" })
        .select()
        .single())
      if (!error && settings) {
        try {
          await (supabaseAdmin as any)
            .from("pharmacy_settings")
            .update({
              receipt_paper_width: receiptPaperWidth,
              receipt_font_scale: receiptFontScale,
              auto_print_receipt: autoPrintReceipt,
            })
            .eq("tenant_id", tenantId)
        } catch {
          /* columns not present yet */
        }
      }
    }

    if (error) throw error

    // Audit log
    await supabaseAdmin.from("pharmacy_audit_logs").insert({
      tenant_id: tenantId,
      profile_id: session.user.id,
      action: "UPDATE_SETTINGS",
      entity: "SETTINGS",
      entity_id: settings.id,
      details: "Updated pharmacy settings",
    })

    return NextResponse.json({
      ...settings,
      receiptPaperWidth,
      receiptFontScale,
      autoPrintReceipt,
      printerType,
    })
  } catch (error) {
    console.error("Save settings error:", error)
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    )
  }
}
