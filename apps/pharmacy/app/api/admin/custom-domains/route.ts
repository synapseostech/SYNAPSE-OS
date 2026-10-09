import { NextRequest, NextResponse } from 'next/server'
import { requirePlatformAdmin } from "@/lib/api-auth"
import { supabaseAdmin } from '@/lib/supabase/admin'
import { normalizeDomain } from '@/lib/custom-domain'

// Platform-admin management of pharmacy custom domains.
//
// NOTE: this lives under /api/admin/** and is therefore subject to the Feature-1
// subscription gate in middleware.ts — but only true platform/superadmins reach
// it (they are not tenant-scoped, so they are never gated). Tenant users are
// rejected here with 403 regardless.

const PLATFORM_ROLES = new Set(['platform_admin', 'superadmin'])

function isPlatformAdmin(session: { role: string }): boolean {
  return PLATFORM_ROLES.has(session.role)
}


// eslint-disable-next-line @typescript-eslint/no-explicit-any
function db() { return supabaseAdmin as any }



export async function GET(request: NextRequest) {
  const auth = await requirePlatformAdmin()
  if (!auth.ok) return auth.response

  const tenantId = request.nextUrl.searchParams.get('tenant_id')
  let query = db()
    .from('pharmacy_custom_domains')
    .select('id, tenant_id, domain, is_primary, verified, created_at')
    .order('created_at', { ascending: false })
  if (tenantId) query = query.eq('tenant_id', tenantId)

  const { data, error } = await query
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ domains: data ?? [] })
}

export async function POST(request: NextRequest) {
  const auth = await requirePlatformAdmin()
  if (!auth.ok) return auth.response

  const body = await request.json().catch(() => null)
  if (!body) return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })

  const tenantId = typeof body.tenant_id === 'string' ? body.tenant_id : null
  const domain = normalizeDomain(body.domain)
  if (!tenantId) return NextResponse.json({ error: 'tenant_id is required' }, { status: 400 })
  if (!domain) return NextResponse.json({ error: 'Valid domain is required' }, { status: 400 })

  // Confirm the tenant exists and is a pharmacy.
  const { data: tenant } = await db()
    .from('tenants')
    .select('id, facility_type')
    .eq('id', tenantId)
    .maybeSingle()
  if (!tenant) return NextResponse.json({ error: 'Unknown tenant_id' }, { status: 404 })

  const isPrimary = body.is_primary === true
  const verified = body.verified === true

  // If marking primary, demote other primaries for the same tenant first.
  if (isPrimary) {
    await db()
      .from('pharmacy_custom_domains')
      .update({ is_primary: false })
      .eq('tenant_id', tenantId)
  }

  const { data, error } = await db()
    .from('pharmacy_custom_domains')
    .upsert(
      { tenant_id: tenantId, domain, is_primary: isPrimary, verified },
      { onConflict: 'domain' },
    )
    .select('id, tenant_id, domain, is_primary, verified, created_at')
    .single()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ domain: data }, { status: 201 })
}

// Verify / update a mapping. Body: { id?, domain?, verified?, is_primary? }
export async function PATCH(request: NextRequest) {
  const auth = await requirePlatformAdmin()
  if (!auth.ok) return auth.response

  const body = await request.json().catch(() => null)
  if (!body) return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })

  const id = typeof body.id === 'string' ? body.id : null
  const domain = body.domain != null ? normalizeDomain(body.domain) : null
  if (!id && !domain) {
    return NextResponse.json({ error: 'id or domain is required' }, { status: 400 })
  }

  const patch: Record<string, unknown> = {}
  if (typeof body.verified === 'boolean') patch.verified = body.verified
  if (typeof body.is_primary === 'boolean') patch.is_primary = body.is_primary
  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ error: 'Nothing to update (set verified and/or is_primary)' }, { status: 400 })
  }

  let query = db()
    .from('pharmacy_custom_domains')
    .update(patch)
    .select('id, tenant_id, domain, is_primary, verified, created_at')
  query = id ? query.eq('id', id) : query.eq('domain', domain)

  const { data, error } = await query.single()
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ domain: data })
}

export async function DELETE(request: NextRequest) {
  const auth = await requirePlatformAdmin()
  if (!auth.ok) return auth.response

  const id = request.nextUrl.searchParams.get('id')
  const domain = normalizeDomain(request.nextUrl.searchParams.get('domain'))
  if (!id && !domain) {
    return NextResponse.json({ error: 'id or domain query param is required' }, { status: 400 })
  }

  let query = db().from('pharmacy_custom_domains').delete()
  query = id ? query.eq('id', id) : query.eq('domain', domain)
  const { error } = await query
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}
