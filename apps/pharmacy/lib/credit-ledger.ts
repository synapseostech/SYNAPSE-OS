import { supabaseAdmin } from "@/lib/supabase/admin"

type CreditEntryParams = {
  tenantId: string
  customerId: string
  amount: number
  type: "credit" | "repayment"
  transactionId?: string | null
  dueDate?: string | null
  notes?: string | null
  createdBy: string
  paymentMethod?: string | null
}

export async function findOrCreateCreditCustomer(
  tenantId: string,
  params: { name: string; phone?: string | null; address?: string | null; email?: string | null }
): Promise<string> {
  const phone = params.phone?.trim() || null
  const name = params.name.trim()
  if (!name) throw new Error("Customer name is required for credit sales")

  if (phone) {
    const { data: byPhone } = await supabaseAdmin
      .from("pharmacy_customers")
      .select("id")
      .eq("tenant_id", tenantId)
      .eq("phone", phone)
      .maybeSingle()
    if (byPhone?.id) return byPhone.id as string
  }

  const email =
    params.email?.trim() ||
    (phone ? `credit+${phone.replace(/\D/g, "")}@synapse.local` : `credit+${Date.now()}@synapse.local`)

  const { data: created, error } = await supabaseAdmin
    .from("pharmacy_customers")
    .insert({
      tenant_id: tenantId,
      name,
      email,
      phone,
      address: params.address?.trim() || null,
      is_active: true,
    })
    .select("id")
    .single()

  if (error || !created) {
    throw new Error(error?.message ?? "Failed to create credit customer")
  }

  return created.id as string
}

export class CreditLedgerError extends Error {
  code: "OVERPAYMENT" | "CUSTOMER_NOT_FOUND" | "INVALID_AMOUNT" | "IDEMPOTENCY_CONFLICT" | "UNKNOWN"
  balance: number | null
  constructor(code: CreditLedgerError["code"], message: string, balance: number | null = null) {
    super(message)
    this.code = code
    this.balance = balance
  }
}

/**
 * Atomic credit-ledger posting (post_pharmacy_credit_entry): the customer row is
 * locked, the running balance computed, overpayment rejected and the row inserted
 * in one DB transaction. An idempotency key makes retries/callbacks post once.
 */
export async function postCreditLedgerEntry(params: CreditEntryParams & { idempotencyKey?: string | null }) {
  const { data, error } = await supabaseAdmin.rpc("post_pharmacy_credit_entry", {
    p_tenant_id: params.tenantId,
    p_customer_id: params.customerId,
    p_type: params.type,
    p_amount: params.amount,
    p_transaction_id: params.transactionId ?? null,
    p_due_date: params.dueDate ?? null,
    p_notes: params.notes ?? null,
    p_created_by: params.createdBy,
    p_idempotency_key: params.idempotencyKey ?? null,
    p_payment_method: params.paymentMethod ?? "cash",
  })
  if (error) {
    const msg = String(error.message ?? "")
    if (msg.startsWith("OVERPAYMENT")) {
      const bal = msg.match(/balance\s+(-?[\d.]+)/)
      throw new CreditLedgerError("OVERPAYMENT", "Repayment exceeds the outstanding balance.", bal ? Number(bal[1]) : null)
    }
    if (msg.startsWith("CUSTOMER_NOT_FOUND")) throw new CreditLedgerError("CUSTOMER_NOT_FOUND", "Customer not found")
    if (msg.startsWith("INVALID_AMOUNT")) throw new CreditLedgerError("INVALID_AMOUNT", "Amount must be greater than zero")
    if (msg.startsWith("IDEMPOTENCY_CONFLICT")) {
      throw new CreditLedgerError("IDEMPOTENCY_CONFLICT", "This idempotency key was already used for a different ledger entry.")
    }
    throw new CreditLedgerError("UNKNOWN", "Failed to post credit ledger entry")
  }
  return data as { id: string; balance_after: number; replayed: boolean } & Record<string, unknown>
}
