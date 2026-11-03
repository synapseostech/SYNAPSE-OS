import { supabaseAdmin } from '@synapse/db/admin'
import {
  buildReceiptSnapshot,
  type ReceiptSaleInput,
  type ReceiptPharmacy,
  type ReceiptLineInput,
  type ReceiptSnapshot,
  type SaleStatus,
  type EfrisStatus,
} from '@synapse/db/receipt'
import { summariseReceiptTax } from './pharmacy-receipt-tax'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = () => supabaseAdmin as any

function pickStr(obj: Record<string, unknown> | null | undefined, ...keys: string[]): string | null {
  if (!obj) return null
  for (const k of keys) {
    const v = obj[k]
    if (v != null && String(v).trim()) return String(v).trim()
  }
  return null
}

/**
 * Load a sale and build an immutable receipt snapshot from sale-time data.
 * Tenant-scoped: every query is filtered by `tenantId`. Returns null when the sale
 * does not exist in this tenant (prevents cross-tenant/IDOR reads).
 */
export async function loadReceiptSnapshot(
  tenantId: string,
  saleId: string,
  opts: { isReprint?: boolean } = {},
): Promise<ReceiptSnapshot | null> {
  const { data: sale } = await db()
    .from('pharmacy_pos_sales')
    .select(
      'id, tenant_id, receipt_number, created_at, cashier_id, patient_id, status, payment_method, payment_ref, subtotal, discount_total, tax_amount, total_amount, session_id',
    )
    .eq('id', saleId)
    .eq('tenant_id', tenantId)
    .maybeSingle()

  if (!sale) return null

  // Line-level tax arrived with 20261102110000. Ask for it, but fall back to the
  // original column set when the database predates it: a missing breakdown must
  // never cost the receipt its lines.
  const baseItemColumns = 'id, product_id, batch_id, quantity, unit_price, discount_amount, line_total'
  const itemQuery = (columns: string) =>
    db()
      .from('pharmacy_pos_sale_items')
      .select(columns)
      .eq('sale_id', saleId)
      .eq('tenant_id', tenantId)

  let { data: items, error: itemsError } = await itemQuery(
    `${baseItemColumns}, vat_category, tax_rate, taxable_amount, tax_amount, tax_source`,
  )
  if (itemsError) {
    ;({ data: items } = await itemQuery(baseItemColumns))
  }

  const rows = items ?? []
  const tax = summariseReceiptTax(rows)
  const productIds = [...new Set(rows.map((r: any) => r.product_id).filter(Boolean))] as string[]
  const batchIds = [...new Set(rows.map((r: any) => r.batch_id).filter(Boolean))] as string[]

  const products = new Map<string, any>()
  if (productIds.length) {
    const { data } = await db()
      .from('pharmacy_products')
      .select('id, name, generic_name, strength, dosage_form, unit_of_measure')
      .in('id', productIds)
    for (const p of data ?? []) products.set(String(p.id), p)
  }

  const batches = new Map<string, any>()
  if (batchIds.length) {
    const { data } = await db()
      .from('pharmacy_product_batches')
      .select('id, batch_number, expiry_date, manufacturer')
      .in('id', batchIds)
    for (const b of data ?? []) batches.set(String(b.id), b)
  }

  const lines: ReceiptLineInput[] = rows.map((r: any) => {
    const p = products.get(String(r.product_id))
    const b = r.batch_id ? batches.get(String(r.batch_id)) : null
    return {
      name: p?.name ?? 'Item',
      genericName: p?.generic_name ?? null,
      strength: p?.strength ?? null,
      dosageForm: p?.dosage_form ?? null,
      quantity: Number(r.quantity ?? 0),
      unit: p?.unit_of_measure ?? null,
      unitPrice: Number(r.unit_price ?? 0),
      discount: Number(r.discount_amount ?? 0),
      batchNumber: b?.batch_number ?? null,
      expiryDate: b?.expiry_date ?? null,
      manufacturer: b?.manufacturer ?? null,
    }
  })

  // Pharmacy identity — read broadly so absent columns never break the query.
  const { data: profile } = await db()
    .from('pharmacy_profiles')
    .select('*')
    .eq('tenant_id', tenantId)
    .maybeSingle()
  const { data: settings } = await db()
    .from('pharmacy_settings')
    .select('*')
    .eq('tenant_id', tenantId)
    .maybeSingle()
  const { data: tenant } = await db()
    .from('tenants')
    .select('name')
    .eq('id', tenantId)
    .maybeSingle()

  const pharmacy: ReceiptPharmacy = {
    legalName:
      pickStr(settings, 'legal_name') ??
      pickStr(profile, 'pharmacy_name') ??
      pickStr(tenant, 'name') ??
      'Pharmacy',
    tradingName: pickStr(settings, 'trading_name') ?? pickStr(profile, 'pharmacy_name'),
    logoUrl: pickStr(settings, 'logo_url', 'logo') ?? pickStr(profile, 'logo_url'),
    address: pickStr(settings, 'address') ?? pickStr(profile, 'physical_address', 'address'),
    phone: pickStr(settings, 'phone', 'contact_phone') ?? pickStr(profile, 'contact_phone'),
    email: pickStr(settings, 'email', 'contact_email') ?? pickStr(profile, 'contact_email'),
    tin: pickStr(settings, 'tin', 'tin_number'),
    ndaLicenseNumber:
      pickStr(settings, 'nda_license_number', 'nda_number') ?? pickStr(profile, 'license_number'),
    supervisingPharmacist: pickStr(settings, 'supervising_pharmacist', 'pharmacist_name'),
    pharmacistRegNumber: pickStr(settings, 'pharmacist_registration_number', 'pharmacist_reg_number'),
    receiptHeader: pickStr(settings, 'receipt_header'),
    receiptFooter: pickStr(settings, 'receipt_footer'),
    currency: pickStr(settings, 'currency') ?? 'UGX',
  }

  // Cashier name.
  let cashier: string | null = null
  if (sale.cashier_id) {
    const { data: prof } = await db()
      .from('profiles')
      .select('full_name')
      .eq('id', sale.cashier_id)
      .maybeSingle()
    cashier = prof?.full_name ?? null
  }

  const efrisStatus = (pickStr(sale, 'efris_status') ?? 'none') as EfrisStatus

  const saleInput: ReceiptSaleInput = {
    saleId: String(sale.id),
    receiptNumber: String(sale.receipt_number ?? ''),
    createdAt: String(sale.created_at ?? new Date().toISOString()),
    branch: pickStr(settings, 'branch_name'),
    terminal: sale.session_id ? String(sale.session_id).slice(0, 8) : null,
    cashier,
    status: (String(sale.status ?? 'completed') as SaleStatus) ?? 'completed',
    paymentMethod: String(sale.payment_method ?? 'CASH'),
    paymentRef: sale.payment_ref ?? null,
    subtotal: Number(sale.subtotal ?? 0),
    discountTotal: Number(sale.discount_total ?? 0),
    taxAmount: Number(sale.tax_amount ?? 0),
    tax,
    totalAmount: Number(sale.total_amount ?? 0),
    lines,
    efris: { status: efrisStatus },
  }

  return buildReceiptSnapshot({ pharmacy, sale: saleInput, isReprint: opts.isReprint })
}

/** Best-effort audit write (pharmacy_audit_logs may not exist in every environment). */
export async function logReceiptEvent(params: {
  tenantId: string
  profileId: string
  action: string
  saleId: string
  details?: Record<string, unknown>
}): Promise<void> {
  try {
    await db()
      .from('pharmacy_audit_logs')
      .insert({
        tenant_id: params.tenantId,
        profile_id: params.profileId,
        action: params.action,
        entity: 'pharmacy_pos_sales',
        entity_id: params.saleId,
        details: params.details ?? {},
      })
  } catch {
    // non-fatal
  }
}
