import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@synapse/db/admin'
import { logAudit } from '@synapse/db'
import {
  isMobileAuth,
  mobileHasPharmacyCapability,
  requireMobilePharmacyAuth,
} from '../../../../../lib/mobile-pharmacy-auth'

export const dynamic = 'force-dynamic'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = () => supabaseAdmin as any

const STORE_TYPES = new Set(['main', 'satellite', 'dispensary', 'warehouse', 'branch'])

function mapStore(row: Record<string, unknown>) {
  return {
    id: String(row.id),
    name: String(row.name ?? ''),
    storeType: String(row.store_type ?? 'main'),
    isActive: Boolean(row.is_active ?? true),
    isWarehouse: Boolean(row.is_warehouse ?? false),
    parentStoreId: (row.parent_store_id as string | null) ?? null,
    address: (row.address as string | null) ?? null,
    district: (row.district as string | null) ?? null,
    phone: (row.phone as string | null) ?? null,
    createdAt: (row.created_at as string | null) ?? null,
  }
}

/** Branches and satellites for the current tenant. */
export async function GET(req: NextRequest) {
  const auth = await requireMobilePharmacyAuth(req)
  if (!isMobileAuth(auth)) return auth

  if (
    !mobileHasPharmacyCapability(auth, 'settings.manage') &&
    !mobileHasPharmacyCapability(auth, 'staff.manage') &&
    !mobileHasPharmacyCapability(auth, 'inventory.read') &&
    !mobileHasPharmacyCapability(auth, 'pos.sell')
  ) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const { data, error } = await db()
    .from('pharmacy_stores')
    .select('*')
    .eq('tenant_id', auth.tenantId)
    .order('created_at', { ascending: true })

  if (error) {
    console.error('[mobile/pharmacy/branches]', error.message)
    return NextResponse.json({ error: 'Failed to load branches' }, { status: 500 })
  }

  return NextResponse.json({
    canManage: mobileHasPharmacyCapability(auth, 'settings.manage'),
    branches: (data ?? []).map((row: Record<string, unknown>) => mapStore(row)),
  })
}

/** Creates a branch. Requires the settings-manage capability. */
export async function POST(req: NextRequest) {
  const auth = await requireMobilePharmacyAuth(req)
  if (!isMobileAuth(auth)) return auth

  if (!mobileHasPharmacyCapability(auth, 'settings.manage')) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null
  const name = typeof body?.name === 'string' ? body.name.trim() : ''
  if (!name) return NextResponse.json({ error: 'Branch name is required' }, { status: 400 })

  const storeTypeRaw = String(body?.storeType ?? 'satellite').toLowerCase()
  const storeType = STORE_TYPES.has(storeTypeRaw) ? storeTypeRaw : 'satellite'

  const { data, error } = await db()
    .from('pharmacy_stores')
    .insert({
      tenant_id: auth.tenantId,
      name,
      store_type: storeType,
      is_active: true,
      is_warehouse: storeType === 'warehouse',
      parent_store_id: typeof body?.parentStoreId === 'string' ? body.parentStoreId : null,
      address: typeof body?.address === 'string' ? body.address : null,
      district: typeof body?.district === 'string' ? body.district : null,
      phone: typeof body?.phone === 'string' ? body.phone : null,
    })
    .select('*')
    .single()

  if (error) {
    console.error('[mobile/pharmacy/branches] create', error.message)
    return NextResponse.json({ error: 'Failed to create branch' }, { status: 500 })
  }

  await logAudit({
    actor_id: auth.userId,
    action: 'CREATE_PHARMACY_BRANCH',
    resource_type: 'pharmacy_store',
    resource_id: data.id,
    tenant_id: auth.tenantId,
    after_state: { name, storeType },
    app_surface: 'mobile',
  })

  return NextResponse.json(mapStore(data as Record<string, unknown>), { status: 201 })
}

/** Updates a branch. Requires the settings-manage capability. */
export async function PATCH(req: NextRequest) {
  const auth = await requireMobilePharmacyAuth(req)
  if (!isMobileAuth(auth)) return auth

  if (!mobileHasPharmacyCapability(auth, 'settings.manage')) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null
  const id = typeof body?.id === 'string' ? body.id : ''
  if (!id) return NextResponse.json({ error: 'id is required' }, { status: 400 })

  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() }
  if (typeof body?.name === 'string') {
    const name = body.name.trim()
    if (!name) return NextResponse.json({ error: 'Branch name is required' }, { status: 400 })
    patch.name = name
  }
  if (typeof body?.isActive === 'boolean') patch.is_active = body.isActive
  if (typeof body?.address === 'string') patch.address = body.address
  if (typeof body?.district === 'string') patch.district = body.district
  if (typeof body?.phone === 'string') patch.phone = body.phone
  if (typeof body?.storeType === 'string') {
    const storeType = body.storeType.toLowerCase()
    if (!STORE_TYPES.has(storeType)) {
      return NextResponse.json({ error: 'Unknown site type' }, { status: 400 })
    }
    patch.store_type = storeType
    patch.is_warehouse = storeType === 'warehouse'
  }

  const { data, error } = await db()
    .from('pharmacy_stores')
    .update(patch)
    .eq('id', id)
    .eq('tenant_id', auth.tenantId)
    .select('*')
    .single()

  if (error) {
    console.error('[mobile/pharmacy/branches] update', error.message)
    return NextResponse.json({ error: 'Failed to update branch' }, { status: 500 })
  }
  if (!data) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  await logAudit({
    actor_id: auth.userId,
    action: 'UPDATE_PHARMACY_BRANCH',
    resource_type: 'pharmacy_store',
    resource_id: id,
    tenant_id: auth.tenantId,
    app_surface: 'mobile',
  })

  return NextResponse.json(mapStore(data as Record<string, unknown>))
}
