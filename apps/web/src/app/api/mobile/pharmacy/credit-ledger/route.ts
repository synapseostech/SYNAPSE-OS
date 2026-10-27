import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@synapse/db/admin'
import {
  isMobileAuth,
  mobileHasPharmacyCapability,
  requireMobilePharmacyAuth,
} from '../../../../../lib/mobile-pharmacy-auth'

export const dynamic = 'force-dynamic'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = () => supabaseAdmin as any

const PAYMENT_METHODS = new Set([
  'cash',
  'card',
  'mobile_money',
  'mobile money',
  'bank_transfer',
  'bank transfer',
])

type LedgerRow = Record<string, unknown>

/** Customer credit exposure and the ledger book, newest first. */
export async function GET(req: NextRequest) {
  const auth = await requireMobilePharmacyAuth(req)
  if (!isMobileAuth(auth)) return auth
  if (!mobileHasPharmacyCapability(auth, 'customers.credit')) {
    return NextResponse.json({ error: 'Credit ledger requires a customer credit permission' }, { status: 403 })
  }

  const { data, error } = await db()
    .from('pharmacy_credit_ledger')
    .select('*, customer:pharmacy_customers(id, name, email, phone)')
    .eq('tenant_id', auth.tenantId)
    .order('created_at', { ascending: false })
    .limit(300)

  if (error) {
    console.error('[mobile/pharmacy/credit-ledger]', error.message)
    return NextResponse.json({ error: 'Failed to load credit ledger' }, { status: 500 })
  }

  const rows = (data ?? []) as LedgerRow[]

  // The running balance lives on the newest row per customer.
  const latestByCustomer = new Map<string, { balance: number; dueDate: string | null }>()
  for (const row of rows) {
    const customerId = row.customer_id as string | null
    if (customerId && !latestByCustomer.has(customerId)) {
      latestByCustomer.set(customerId, {
        balance: Number(row.balance_after ?? 0),
        dueDate: (row.due_date as string | null) ?? null,
      })
    }
  }

  const today = new Date().toISOString().slice(0, 10)
  const balances = Array.from(latestByCustomer.values())
  const isOverdue = (row: { balance: number; dueDate: string | null }) =>
    Boolean(row.dueDate && row.dueDate < today && row.balance > 0)

  return NextResponse.json({
    summary: {
      totalOutstanding: balances.reduce((sum, row) => sum + Math.max(row.balance, 0), 0),
      overdueOutstanding: balances
        .filter(isOverdue)
        .reduce((sum, row) => sum + row.balance, 0),
      creditCustomers: balances.filter((row) => row.balance > 0).length,
      overdueCustomers: balances.filter(isOverdue).length,
    },
    entries: rows.map((row) => ({
      id: String(row.id),
      customerId: (row.customer_id as string | null) ?? null,
      customerName:
        ((row.customer as { name?: string | null } | null)?.name as string | null) ?? null,
      amount: Number(row.amount ?? 0),
      type: String(row.type ?? ''),
      balanceAfter: Number(row.balance_after ?? 0),
      dueDate: (row.due_date as string | null) ?? null,
      notes: (row.notes as string | null) ?? null,
      createdAt: (row.created_at as string | null) ?? null,
    })),
  })
}

/** Records a credit sale or a repayment through the same atomic DB routine as the portal. */
export async function POST(req: NextRequest) {
  const auth = await requireMobilePharmacyAuth(req)
  if (!isMobileAuth(auth)) return auth
  if (!mobileHasPharmacyCapability(auth, 'customers.credit')) {
    return NextResponse.json({ error: 'Credit ledger requires a customer credit permission' }, { status: 403 })
  }

  const body = (await req.json().catch(() => null)) as {
    customerId?: unknown
    type?: unknown
    amount?: unknown
    paymentMethod?: unknown
    dueDate?: unknown
    notes?: unknown
    idempotencyKey?: unknown
  } | null

  const customerId = typeof body?.customerId === 'string' ? body.customerId.trim() : ''
  const type = typeof body?.type === 'string' ? body.type.trim() : ''
  const amount = Number(body?.amount ?? 0)
  const paymentMethod =
    typeof body?.paymentMethod === 'string' ? body.paymentMethod.trim().toLowerCase() : 'cash'
  const dueDate = typeof body?.dueDate === 'string' && body.dueDate ? body.dueDate : null
  const notes = typeof body?.notes === 'string' && body.notes ? body.notes.slice(0, 500) : null

  if (!customerId || !['credit', 'repayment'].includes(type)) {
    return NextResponse.json({ error: 'Customer and entry type are required' }, { status: 400 })
  }
  if (!Number.isFinite(amount) || amount <= 0 || Math.abs(amount * 100 - Math.round(amount * 100)) > 0.000001) {
    return NextResponse.json({ error: 'Enter a positive amount with at most two decimals' }, { status: 400 })
  }
  if (!PAYMENT_METHODS.has(paymentMethod)) {
    return NextResponse.json({ error: 'Choose a supported payment method.' }, { status: 400 })
  }
  if (dueDate && !/^\d{4}-\d{2}-\d{2}$/.test(dueDate)) {
    return NextResponse.json({ error: 'Use YYYY-MM-DD for the due date.' }, { status: 400 })
  }

  const idempotencyKey =
    req.headers.get('idempotency-key')?.trim().slice(0, 128) ||
    (typeof body?.idempotencyKey === 'string' ? body.idempotencyKey.trim().slice(0, 128) : '') ||
    null
  if (type === 'repayment' && !idempotencyKey) {
    return NextResponse.json(
      { error: 'An idempotency key is required for customer repayments.' },
      { status: 400 },
    )
  }

  const { data: customer } = await db()
    .from('pharmacy_customers')
    .select('id')
    .eq('id', customerId)
    .eq('tenant_id', auth.tenantId)
    .maybeSingle()
  if (!customer) return NextResponse.json({ error: 'Customer not found' }, { status: 404 })

  const { data, error } = await db().rpc('post_pharmacy_credit_entry', {
    p_tenant_id: auth.tenantId,
    p_customer_id: customerId,
    p_type: type,
    p_amount: amount,
    p_transaction_id: null,
    p_due_date: dueDate,
    p_notes: notes,
    p_created_by: auth.userId,
    p_idempotency_key: idempotencyKey,
    p_payment_method: paymentMethod,
  })

  if (error) {
    const message = String(error.message ?? '')
    if (message.startsWith('OVERPAYMENT')) {
      const balance = message.match(/balance\s+(-?[\d.]+)/)
      return NextResponse.json(
        {
          error: 'Repayment exceeds the outstanding balance.',
          code: 'OVERPAYMENT',
          balance: balance ? Number(balance[1]) : null,
        },
        { status: 400 },
      )
    }
    if (message.startsWith('CUSTOMER_NOT_FOUND')) {
      return NextResponse.json({ error: 'Customer not found' }, { status: 404 })
    }
    if (message.startsWith('INVALID_AMOUNT')) {
      return NextResponse.json({ error: 'Amount must be greater than zero' }, { status: 400 })
    }
    if (message.startsWith('IDEMPOTENCY_CONFLICT')) {
      return NextResponse.json(
        { error: 'This idempotency key was already used for a different ledger entry.' },
        { status: 409 },
      )
    }
    console.error('[mobile/pharmacy/credit-ledger]', message)
    return NextResponse.json({ error: 'Failed to record the ledger entry' }, { status: 500 })
  }

  const result = (data ?? {}) as { id?: string; balance_after?: number; replayed?: boolean }

  if (!result.replayed) {
    await db().from('pharmacy_audit_logs').insert({
      tenant_id: auth.tenantId,
      profile_id: auth.userId,
      action: 'CREATE_CREDIT_LEDGER_ENTRY',
      entity: 'PHARMACY_CREDIT_LEDGER',
      entity_id: result.id ?? null,
      details: `${type} entry of ${amount} recorded from mobile. Balance: ${Number(result.balance_after ?? 0)}`,
    })
  }

  return NextResponse.json(
    {
      id: result.id ?? null,
      balanceAfter: Number(result.balance_after ?? 0),
      replayed: Boolean(result.replayed),
    },
    { status: result.replayed ? 200 : 201 },
  )
}
