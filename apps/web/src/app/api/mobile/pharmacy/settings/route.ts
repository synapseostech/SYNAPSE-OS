import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@synapse/db/admin'
import {
  isMobileAuth,
  isMobilePharmacyAdmin,
  requireMobilePharmacyAuth,
} from '../../../../../lib/mobile-pharmacy-auth'

export const dynamic = 'force-dynamic'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = () => supabaseAdmin as any

/** Pharmacy settings incl. receipt identity (TIN, NDA licence, supervising pharmacist). */
export async function GET(req: NextRequest) {
  const auth = await requireMobilePharmacyAuth(req)
  if (!isMobileAuth(auth)) return auth

  const { data: s } = await db()
    .from('pharmacy_settings')
    .select('*')
    .eq('tenant_id', auth.tenantId)
    .maybeSingle()

  return NextResponse.json({
    settings: {
      pharmacyName: s?.pharmacy_name ?? '',
      legalName: s?.legal_name ?? '',
      tradingName: s?.trading_name ?? '',
      location: s?.location ?? '',
      contact: s?.contact ?? '',
      email: s?.email ?? '',
      logoUrl: s?.logo_url ?? s?.logo ?? null,
      tin: s?.tin ?? '',
      ndaLicenseNumber: s?.nda_license_number ?? '',
      supervisingPharmacist: s?.supervising_pharmacist ?? '',
      pharmacistRegNumber: s?.pharmacist_registration_number ?? '',
      branchName: s?.branch_name ?? '',
      receiptHeader: s?.receipt_header ?? '',
      receiptFooter: s?.receipt_footer ?? s?.footer_text ?? '',
      currency: s?.currency ?? 'UGX',
      taxRate: Number(s?.tax_rate ?? 0),
      vatEnabled: Boolean(s?.vat_enabled),
      vatRate: Number(s?.vat_rate ?? 18),
      lowStockThreshold: Number(s?.low_stock_threshold ?? 10),
      discountApprovalThresholdPct: Number(s?.discount_approval_threshold_pct ?? 5),
      mandatoryReceiptPrint: s?.mandatory_receipt_print !== false,
      printerType: s?.printer_type ?? 'default',
      receiptPaperWidth: (() => {
        const paper = String(s?.receipt_paper_width ?? '').toLowerCase()
        if (paper === '58' || paper === '80' || paper === 'a4') return paper
        return String(s?.printer_type ?? '').includes('58') ? '58' : '80'
      })(),
      receiptFontScale: Number(s?.receipt_font_scale ?? 1) || 1,
      autoPrintReceipt: Boolean(s?.auto_print_receipt),
    },
    canEdit: isMobilePharmacyAdmin(auth),
  })
}

/** Save settings. Admin-only. Core columns always saved; receipt-identity columns saved
 *  additively (guarded) so this works before/after the identity migration is applied. */
export async function POST(req: NextRequest) {
  const auth = await requireMobilePharmacyAuth(req)
  if (!isMobileAuth(auth)) return auth
  if (!isMobilePharmacyAdmin(auth)) {
    return NextResponse.json({ error: 'Admin role required' }, { status: 403 })
  }

  const d = (await req.json().catch(() => ({}))) as Record<string, unknown>

  // Rates are percentages: 18 means 18%. Reject an impossible one here instead
  // of letting the upsert fail on the numeric column and surface as a 500.
  const invalidRate = (raw: unknown): boolean => {
    if (raw === undefined || raw === null || raw === '') return false
    const value = Number(raw)
    return !Number.isFinite(value) || value < 0 || value > 100
  }
  if (invalidRate(d.taxRate) || invalidRate(d.vatRate)) {
    return NextResponse.json(
      { error: 'Tax rates must be between 0 and 100', code: 'INVALID_TAX_RATE' },
      { status: 422 },
    )
  }
  const supplied = (raw: unknown) => raw !== undefined && raw !== null && raw !== ''

  const core = {
    tenant_id: auth.tenantId,
    pharmacy_name: d.pharmacyName ?? null,
    location: d.location ?? null,
    contact: d.contact ?? null,
    email: d.email ?? null,
    receipt_header: d.receiptHeader ?? null,
    receipt_footer: d.receiptFooter ?? null,
    footer_text: d.receiptFooter ?? null,
    currency: d.currency ?? 'UGX',
    // Only when supplied: a screen without the field used to write 0 and
    // silently switch a configured rate off.
    ...(supplied(d.taxRate) ? { tax_rate: Number(d.taxRate) } : {}),
    low_stock_threshold: d.lowStockThreshold ?? 10,
    printer_type: d.printerType ?? 'default',
  }

  const { error } = await db().from('pharmacy_settings').upsert(core, { onConflict: 'tenant_id' })
  if (error) {
    console.error('[mobile/pharmacy/settings]', error.message)
    return NextResponse.json({ error: 'Failed to save settings' }, { status: 500 })
  }

  // Receipt-identity + policy columns (present after the identity migration).
  try {
    await db()
      .from('pharmacy_settings')
      .update({
        legal_name: d.legalName ?? null,
        trading_name: d.tradingName ?? null,
        logo_url: d.logoUrl ?? null,
        tin: d.tin ?? null,
        nda_license_number: d.ndaLicenseNumber ?? null,
        supervising_pharmacist: d.supervisingPharmacist ?? null,
        pharmacist_registration_number: d.pharmacistRegNumber ?? null,
        branch_name: d.branchName ?? null,
        // Same rule as tax_rate: absent means "leave it alone". A mobile save
        // that never showed VAT used to switch it off and reset the rate.
        ...(typeof d.vatEnabled === 'boolean' ? { vat_enabled: d.vatEnabled } : {}),
        ...(supplied(d.vatRate) ? { vat_rate: Number(d.vatRate) } : {}),
        discount_approval_threshold_pct: d.discountApprovalThresholdPct ?? 5,
        mandatory_receipt_print: d.mandatoryReceiptPrint !== false,
        receipt_paper_width: (() => {
          const paper = String(d.receiptPaperWidth ?? '80').toLowerCase()
          return paper === '58' || paper === 'a4' ? paper : '80'
        })(),
        receipt_font_scale: Number(d.receiptFontScale ?? 1) || 1,
        auto_print_receipt: Boolean(d.autoPrintReceipt),
      })
      .eq('tenant_id', auth.tenantId)
  } catch {
    // Columns not present yet — core settings still saved.
  }

  try {
    await db().from('pharmacy_audit_logs').insert({
      tenant_id: auth.tenantId,
      profile_id: auth.userId,
      action: 'UPDATE_SETTINGS',
      entity: 'pharmacy_settings',
      details: { source: 'mobile' },
    })
  } catch {
    /* non-fatal */
  }

  return NextResponse.json({ ok: true })
}

/** Alias — some older native helpers used PATCH. */
export async function PATCH(req: NextRequest) {
  return POST(req)
}
