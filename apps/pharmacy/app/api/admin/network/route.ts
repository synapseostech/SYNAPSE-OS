import { NextRequest, NextResponse } from 'next/server'
import { requirePharmacyPermission } from "@/lib/api-auth"
import { supabaseAdmin } from '@/lib/supabase/admin'

const db = supabaseAdmin as any

// GET /api/admin/network — fetch network settings + inventory
export async function GET() {
  // Nav gates this page on MANAGE_SETTINGS; the route must match, otherwise any
  // signed-in cashier can read the network listing.
  const auth = await requirePharmacyPermission("settings.manage")
  if (!auth.ok) return auth.response
  const { tenantId } = auth

  const [{ data: tenant }, { data: inventory }] = await Promise.all([
    db.from('tenants')
      .select('is_network_member,accepts_refill_requests,network_listing_name')
      .eq('id', tenantId)
      .single(),
    db.from('pharmacy_network_inventory')
      .select('*')
      .eq('pharmacy_tenant_id', tenantId),
  ])

  return NextResponse.json({
    settings: {
      isNetworkMember: tenant?.is_network_member ?? false,
      acceptsRefillRequests: tenant?.accepts_refill_requests ?? false,
      networkListingName: tenant?.network_listing_name ?? '',
    },
    inventory: inventory ?? [],
  })
}

// POST /api/admin/network — save settings or sync
export async function POST(req: NextRequest) {
  const auth = await requirePharmacyPermission("settings.manage")
  if (!auth.ok) return auth.response
  const { tenantId } = auth

  const body = await req.json()

  // action=sync: copy active products to network inventory
  if (body.action === 'sync') {
    const { data: products, error: prodErr } = await db
      .from('pharmacy_products')
      .select('id,name,generic_name,dosage_form,strength,quantity,price,is_active')
      .eq('tenant_id', tenantId)
      .eq('is_active', true)

    if (prodErr) return NextResponse.json({ error: prodErr.message }, { status: 500 })
    if (!products || products.length === 0) {
      return NextResponse.json({ synced: 0 })
    }

    const rows = products.map((p: any) => ({
      pharmacy_tenant_id: tenantId,
      drug_name: p.name,
      generic_name: p.generic_name ?? null,
      dosage_form: p.dosage_form ?? null,
      strength: p.strength ?? null,
      quantity_in_stock: p.quantity ?? 0,
      unit_price_ugx: p.price ?? 0,
      is_available: (p.quantity ?? 0) > 0,
      last_synced_at: new Date().toISOString(),
    }))

    // Upsert — delete existing then insert fresh
    await db.from('pharmacy_network_inventory').delete().eq('pharmacy_tenant_id', tenantId)
    const { error: insErr } = await db.from('pharmacy_network_inventory').insert(rows)
    if (insErr) return NextResponse.json({ error: insErr.message }, { status: 500 })

    return NextResponse.json({ synced: rows.length })
  }

  // Default: save settings
  const { error } = await db.from('tenants').update({
    is_network_member: body.isNetworkMember,
    accepts_refill_requests: body.acceptsRefillRequests,
    network_listing_name: body.networkListingName || null,
  }).eq('id', tenantId)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}
