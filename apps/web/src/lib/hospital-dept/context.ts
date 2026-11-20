import 'server-only'

import { cookies } from 'next/headers'
import { NextResponse } from 'next/server'
import { verifyToken } from '@synapse/auth/tokens'
import { hashToken, validateSession } from '@synapse/auth'
import { supabaseAdmin } from '@synapse/db/admin'
import { SESSION_COOKIE } from '@synapse/config/constants'
import type { HospitalContext } from '../hospital-shared'
import { isMissingRpc } from './rpc-errors'

type TokenPayload = { sub: string; email?: string; role?: string }

type StaffContextRow = {
  status: 'ok' | 'session_invalid' | 'no_tenant'
  user_id?: string
  email?: string | null
  role?: string | null
  full_name?: string | null
  tenant_id?: string
  hospital_id?: string | null
  facility_type?: string | null
}

const HOSPITAL_FACILITY_TYPES = ['hospital', 'laboratory']

function contextFromRow(row: StaffContextRow, payload: TokenPayload): HospitalContext | NextResponse {
  if (row.status === 'session_invalid') {
    return NextResponse.json({ error: 'Session expired' }, { status: 401 })
  }
  if (row.status !== 'ok' || !row.tenant_id) {
    return NextResponse.json({ error: 'No tenant context' }, { status: 403 })
  }
  const facilityType = String(row.facility_type ?? 'hospital')
  const role = String(row.role ?? payload.role ?? '')
  if (!HOSPITAL_FACILITY_TYPES.includes(facilityType) && role !== 'platform_admin') {
    return NextResponse.json({ error: 'Hospital or laboratory facility required' }, { status: 403 })
  }
  if (!row.hospital_id) {
    return NextResponse.json({ error: 'No hospital context' }, { status: 403 })
  }
  return {
    userId: String(row.user_id),
    email: row.email ?? payload.email ?? '',
    role,
    tenantId: row.tenant_id,
    hospitalId: row.hospital_id,
    facilityType,
    fullName: row.full_name ?? null,
  }
}

/** Pre-migration path: 3-4 sequential reads. Used only until 20261120140000 is applied. */
async function legacyStaffContext(token: string, payload: TokenPayload): Promise<HospitalContext | NextResponse> {
  const { valid, userId } = await validateSession(token)
  if (!valid || (userId && userId !== payload.sub)) {
    return NextResponse.json({ error: 'Session expired' }, { status: 401 })
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = supabaseAdmin as any
  const { data: profile } = await db
    .from('profiles')
    .select('id, email, role, full_name, tenant_id, hospital_id')
    .eq('id', payload.sub)
    .maybeSingle()

  if (!profile?.tenant_id) return contextFromRow({ status: 'no_tenant' }, payload)

  const { data: tenant } = await db
    .from('tenants')
    .select('facility_type, slug')
    .eq('id', profile.tenant_id)
    .maybeSingle()

  let hospitalId = typeof profile.hospital_id === 'string' ? profile.hospital_id : null
  if (!hospitalId && tenant?.slug) {
    const { data: hospital } = await db.from('hospitals').select('id').eq('subdomain', tenant.slug).maybeSingle()
    hospitalId = hospital?.id ?? null
  }

  return contextFromRow(
    {
      status: 'ok',
      user_id: profile.id,
      email: profile.email,
      role: profile.role,
      full_name: profile.full_name,
      tenant_id: profile.tenant_id,
      hospital_id: hospitalId,
      facility_type: tenant?.facility_type ?? 'hospital',
    },
    payload,
  )
}

/**
 * Resolves the signed-in hospital staff member: session, profile, tenant and
 * hospital in one database round trip (`hospital_staff_context`). The tenant
 * always comes from the server-side profile, never from the request.
 */
export async function requireHospitalStaffContext(): Promise<HospitalContext | NextResponse> {
  const cookieStore = await cookies()
  const token = cookieStore.get(SESSION_COOKIE)?.value
  if (!token) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const payload = (await verifyToken(token).catch(() => null)) as TokenPayload | null
  if (!payload?.sub) {
    return NextResponse.json({ error: 'Invalid session' }, { status: 401 })
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = supabaseAdmin as any
  const { data, error } = await db.rpc('hospital_staff_context', {
    p_token_hash: hashToken(token),
    p_user_id: payload.sub,
  })

  if (error) {
    if (isMissingRpc(error)) return legacyStaffContext(token, payload)
    console.error('[hospital] staff context failed', error.code, error.message)
    return NextResponse.json({ error: 'Session check failed' }, { status: 503 })
  }

  return contextFromRow((data ?? { status: 'session_invalid' }) as StaffContextRow, payload)
}
