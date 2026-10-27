import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@synapse/db/admin'
import { registerPersonForFacility } from '@synapse/db/identity-persist'
import {
  isMobileAuth,
  requireMobilePharmacyAuth,
} from '../../../../../lib/mobile-pharmacy-auth'

export const dynamic = 'force-dynamic'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = () => supabaseAdmin as any

type CustomerRow = Record<string, unknown>

function mapCustomer(row: CustomerRow, counts: { orders: number; transactions: number }) {
  return {
    id: String(row.id),
    name: String(row.name ?? ''),
    email: (row.email as string | null) ?? null,
    phone: (row.phone as string | null) ?? null,
    address: (row.address as string | null) ?? null,
    isActive: Boolean(row.is_active ?? true),
    createdAt: (row.created_at as string | null) ?? null,
    personId: (row.person_id as string | null) ?? null,
    synapseId: (row.synapse_id as string | null) ?? null,
    counts,
  }
}

/** Customer directory for the pharmacy app, with order and transaction counts. */
export async function GET(req: NextRequest) {
  const auth = await requireMobilePharmacyAuth(req)
  if (!isMobileAuth(auth)) return auth

  const [customersResult, orderResult, transactionResult] = await Promise.all([
    db()
      .from('pharmacy_customers')
      .select('*')
      .eq('tenant_id', auth.tenantId)
      .order('created_at', { ascending: false })
      .limit(500),
    db()
      .from('pharmacy_orders')
      .select('customer_id')
      .eq('tenant_id', auth.tenantId)
      .not('customer_id', 'is', null),
    db()
      .from('pharmacy_transactions')
      .select('customer_id')
      .eq('tenant_id', auth.tenantId)
      .not('customer_id', 'is', null),
  ])

  if (customersResult.error) {
    console.error('[mobile/pharmacy/customers]', customersResult.error.message)
    return NextResponse.json({ error: 'Failed to load customers' }, { status: 500 })
  }

  const orderCounts = new Map<string, number>()
  for (const row of orderResult.data ?? []) {
    const id = row.customer_id as string
    if (id) orderCounts.set(id, (orderCounts.get(id) ?? 0) + 1)
  }
  const transactionCounts = new Map<string, number>()
  for (const row of transactionResult.data ?? []) {
    const id = row.customer_id as string
    if (id) transactionCounts.set(id, (transactionCounts.get(id) ?? 0) + 1)
  }

  return NextResponse.json({
    customers: (customersResult.data ?? []).map((row: CustomerRow) =>
      mapCustomer(row, {
        orders: orderCounts.get(String(row.id)) ?? 0,
        transactions: transactionCounts.get(String(row.id)) ?? 0,
      }),
    ),
  })
}

/** Creates a customer. Mirrors the portal rules: name plus an email or phone. */
export async function POST(req: NextRequest) {
  const auth = await requireMobilePharmacyAuth(req)
  if (!isMobileAuth(auth)) return auth

  const body = (await req.json().catch(() => null)) as {
    name?: unknown
    email?: unknown
    phone?: unknown
    address?: unknown
  } | null

  const name = typeof body?.name === 'string' ? body.name.trim() : ''
  const email = typeof body?.email === 'string' ? body.email.trim() : ''
  const phone = typeof body?.phone === 'string' ? body.phone.trim() : ''
  const address = typeof body?.address === 'string' ? body.address.trim() : ''

  if (!name) return NextResponse.json({ error: 'Customer name is required' }, { status: 400 })
  if (!email && !phone) {
    return NextResponse.json(
      { error: 'Provide at least an email or phone number' },
      { status: 400 },
    )
  }

  const normalizedEmail = email || `credit+${phone.replace(/\D/g, '')}@synapse.local`

  const { data: existingEmail } = await db()
    .from('pharmacy_customers')
    .select('id')
    .eq('tenant_id', auth.tenantId)
    .eq('email', normalizedEmail)
    .maybeSingle()
  if (existingEmail) {
    return NextResponse.json({ error: 'Customer with this email already exists' }, { status: 400 })
  }

  if (phone) {
    const { data: existingPhone } = await db()
      .from('pharmacy_customers')
      .select('id')
      .eq('tenant_id', auth.tenantId)
      .eq('phone', phone)
      .maybeSingle()
    if (existingPhone) {
      return NextResponse.json({ error: 'Customer with this phone already exists' }, { status: 400 })
    }
  }

  const person = await registerPersonForFacility({
    tenantId: auth.tenantId,
    actorId: auth.userId,
    sourceSystem: 'synapse-pharm-mobile',
    demographics: {
      fullName: name,
      phone: phone || null,
      email: email || null,
      countryCode: 'UG',
    },
  }).catch((err) => {
    console.error('[mobile/pharmacy/customers] person register failed', err)
    return null
  })

  const insert = await db()
    .from('pharmacy_customers')
    .insert({
      tenant_id: auth.tenantId,
      name,
      email: normalizedEmail,
      phone: phone || null,
      address: address || null,
      ...(person ? { person_id: person.id } : {}),
    })
    .select()
    .single()

  let customer = insert.data as CustomerRow | null
  if (insert.error) {
    // Older deployments have no person_id column: retry without the link.
    if (!person || !String(insert.error.message ?? '').toLowerCase().includes('person_id')) {
      console.error('[mobile/pharmacy/customers]', insert.error.message)
      return NextResponse.json({ error: 'Failed to create customer' }, { status: 500 })
    }
    const retry = await db()
      .from('pharmacy_customers')
      .insert({
        tenant_id: auth.tenantId,
        name,
        email: normalizedEmail,
        phone: phone || null,
        address: address || null,
      })
      .select()
      .single()
    if (retry.error) {
      console.error('[mobile/pharmacy/customers]', retry.error.message)
      return NextResponse.json({ error: 'Failed to create customer' }, { status: 500 })
    }
    customer = retry.data as CustomerRow
  }

  await db().from('pharmacy_audit_logs').insert({
    tenant_id: auth.tenantId,
    profile_id: auth.userId,
    action: 'CREATE_CUSTOMER',
    entity: 'CUSTOMER',
    entity_id: customer?.id ?? null,
    details: `Created customer from mobile app: ${name}`,
  })

  return NextResponse.json(
    mapCustomer(
      { ...(customer ?? {}), synapse_id: person?.synapseId ?? null },
      { orders: 0, transactions: 0 },
    ),
    { status: 201 },
  )
}
