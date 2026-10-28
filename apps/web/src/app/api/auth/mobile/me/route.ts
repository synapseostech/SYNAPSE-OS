import { NextRequest, NextResponse } from 'next/server'
import { isAccountActivated, verifyToken, validateSession, withMembershipSuspension, resolveSessionScope } from '@synapse/auth'
import { supabaseAdmin } from '@synapse/db/admin'

const ROLE_KIND: Record<string, string> = {
  patient: 'patient',
  doctor: 'clinician', independent_doctor: 'clinician', clinician: 'clinician',
  clinical_officer: 'clinician', specialist: 'clinician', surgeon: 'clinician',
  anaesthetist: 'clinician', intensivist: 'clinician', cardiologist: 'clinician',
  oncologist: 'clinician', psychiatrist: 'clinician', nephrologist: 'clinician',
  art_clinician: 'clinician', obstetrician: 'clinician', paediatrician: 'clinician',
  radiologist: 'clinician', radiographer: 'clinician',
  nurse: 'nurse', theatre_nurse: 'nurse', icu_nurse: 'nurse',
  hiv_counselor: 'nurse', chw: 'nurse', social_worker: 'nurse',
  pharmacist: 'pharmacy', pharmacy_admin: 'pharmacy', pharmacy_store_manager: 'pharmacy',
  pharmacy_cashier: 'pharmacy', cashier: 'pharmacy', pharmacy_staff: 'pharmacy', pharmacy_ceo: 'pharmacy',
  lab_tech: 'lab', lab_technician: 'lab', lab_supervisor: 'lab',
  receptionist: 'reception',
  billing_officer: 'billing', claims_officer: 'billing', insurance_officer: 'billing',
  admin: 'admin', hospital_admin: 'admin', facility_admin: 'admin',
  superadmin: 'admin', super_admin: 'admin', overall_admin: 'admin', platform_admin: 'admin',
}

export async function GET(req: NextRequest) {
  const auth = req.headers.get('authorization') ?? ''
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null

  if (!token) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const payload = await verifyToken(token).catch(() => null)
  if (!payload) {
    return NextResponse.json({ error: 'Invalid token' }, { status: 401 })
  }

  const { valid } = await validateSession(token)
  if (!valid) {
    return NextResponse.json({ error: 'Session expired' }, { status: 401 })
  }

  const db = supabaseAdmin as any
  const { data: profile, error } = await db
    .from('profiles')
    .select(`
      id, email, role, tenant_id, synapse_id,
      full_name, first_name, last_name, is_admin, must_change_password,
      verification_status, email_verified_at, is_deleted
    `)
    .eq('id', payload.sub)
    .single()

  if (error || !profile) {
    return NextResponse.json({ error: 'User not found' }, { status: 404 })
  }

  if (!isAccountActivated(await withMembershipSuspension(profile))) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  // The session belongs to the facility it was minted for. A token whose
  // facility no longer resolves must not quietly become a different one. A home
  // facility token needs no read at all — this is the app's hottest request.
  const tokenTenantId = typeof payload.tenant_id === 'string' ? payload.tenant_id.trim() : ''
  const sessionScope = await resolveSessionScope(
    { id: profile.id as string, role: (profile.role as string | null) ?? '', tenant_id: profile.tenant_id as string | null },
    tokenTenantId,
  )
  if (!sessionScope) {
    return NextResponse.json({ error: 'Session expired' }, { status: 401 })
  }

  const sessionRole = sessionScope.role
  const sessionTenantId = sessionScope.tenantId

  const { data: tenant } = await db
    .from('tenants')
    .select('name')
    .eq('id', sessionTenantId || '')
    .maybeSingle()

  const joinedName = [profile.first_name, profile.last_name].filter(Boolean).join(' ')
  const fullName = (profile.full_name as string | null) ?? (joinedName || null)

  return NextResponse.json({
    id: profile.id,
    email: (profile.email as string | null) ?? '',
    role: sessionRole,
    fullName,
    synapseId: (profile.synapse_id as string | null) ?? null,
    tenantId: sessionTenantId,
    tenantName: (tenant?.name as string | null) ?? '',
    isAdmin: (profile.is_admin as boolean | null) ?? false,
    mustChangePassword: (profile.must_change_password as boolean | null) ?? false,
    dashboardKind: ROLE_KIND[sessionRole] ?? 'generic',
  })
}
