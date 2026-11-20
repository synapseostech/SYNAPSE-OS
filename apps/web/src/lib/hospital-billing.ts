import 'server-only'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = any

const INVOICE_COLUMNS =
  'id, invoice_number, status, currency, total_amount, paid_amount, patient_id, encounter_id, created_at, updated_at'
const INSURANCE_COLUMNS = 'insurance_cover_amount, insurance_policy_id, insurer_id, insurance_claim_id'

export type InvoiceRow = {
  id: string
  invoice_number: string | null
  status: string
  currency: string
  total_amount: number
  paid_amount: number
  patient_id: string | null
  encounter_id: string | null
  created_at: string
  updated_at: string
  insurance_cover_amount?: number | null
  insurance_policy_id?: string | null
  insurer_id?: string | null
  insurance_claim_id?: string | null
}

/** 42703 undefined_column: the insurance columns are not migrated yet. */
function isMissingColumn(error: { code?: string } | null | undefined): boolean {
  return error?.code === '42703' || error?.code === 'PGRST204'
}

/** Patient share still owed: total less insurance cover less payments. */
export function patientBalance(invoice: Pick<InvoiceRow, 'total_amount' | 'paid_amount' | 'insurance_cover_amount'>): number {
  const due = Number(invoice.total_amount ?? 0) - Number(invoice.insurance_cover_amount ?? 0) - Number(invoice.paid_amount ?? 0)
  return Math.max(0, Math.round(due * 100) / 100)
}

/**
 * Latest invoice for an encounter, or a given invoice, always inside the tenant.
 * Insurance columns are read when present, so this works before and after
 * 20261120140000.
 */
export async function loadInvoice(
  db: Db,
  tenantId: string,
  where: { invoiceId: string } | { encounterId: string },
): Promise<{ invoice: InvoiceRow | null; error: string | null }> {
  const run = (columns: string) => {
    let q = db.from('billing_invoices').select(columns).eq('tenant_id', tenantId).eq('is_deleted', false)
    q = 'invoiceId' in where ? q.eq('id', where.invoiceId) : q.eq('encounter_id', where.encounterId)
    return q.order('created_at', { ascending: false }).limit(1).maybeSingle()
  }
  let { data, error } = await run(`${INVOICE_COLUMNS}, ${INSURANCE_COLUMNS}`)
  if (error && isMissingColumn(error)) ({ data, error } = await run(INVOICE_COLUMNS))
  if (error) return { invoice: null, error: error.message }
  return { invoice: (data as InvoiceRow | null) ?? null, error: null }
}

/** Line items and payments of one invoice, read in parallel. */
export async function loadInvoiceLinesAndPayments(db: Db, tenantId: string, invoiceId: string) {
  const [lines, payments] = await Promise.all([
    db
      .from('billing_line_items')
      .select('id, item_name, unit_price, qty, total_price, notes, created_at')
      .eq('tenant_id', tenantId)
      .eq('invoice_id', invoiceId)
      .eq('is_deleted', false)
      .order('created_at', { ascending: true })
      .limit(200),
    db
      .from('billing_payments')
      .select('id, amount, currency, payment_method, payment_ref, receipt_number, created_at')
      .eq('tenant_id', tenantId)
      .eq('invoice_id', invoiceId)
      .eq('is_deleted', false)
      .order('created_at', { ascending: true })
      .limit(100),
  ])
  if (lines.error) return { error: lines.error.message as string }
  if (payments.error) return { error: payments.error.message as string }
  return { lineItems: lines.data ?? [], payments: payments.data ?? [], error: null }
}
