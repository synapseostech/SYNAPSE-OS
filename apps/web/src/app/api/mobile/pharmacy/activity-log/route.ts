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

type AuditRow = {
  id: string
  profile_id: string | null
  action: string
  entity: string | null
  entity_id: string | null
  details: string | null
  created_at: string
}

type ProfileRow = {
  id: string
  full_name: string | null
  first_name: string | null
  last_name: string | null
  email: string | null
}

/** Tenant audit trail, newest first. Requires the audit-read capability. */
export async function GET(req: NextRequest) {
  const auth = await requireMobilePharmacyAuth(req)
  if (!isMobileAuth(auth)) return auth

  if (!mobileHasPharmacyCapability(auth, 'audit.read')) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  const params = new URL(req.url).searchParams
  const limitParam = Number(params.get('limit') ?? '100')
  const limit = Math.min(Math.max(Number.isFinite(limitParam) ? limitParam : 100, 1), 200)
  const entity = (params.get('entity') ?? '').trim()

  let query = db()
    .from('pharmacy_audit_logs')
    .select('id, profile_id, action, entity, entity_id, details, created_at')
    .eq('tenant_id', auth.tenantId)
  if (entity) query = query.eq('entity', entity)
  const { data: logs, error } = await query
    .order('created_at', { ascending: false })
    .limit(limit)

  if (error) {
    console.error('[mobile/pharmacy/activity-log]', error.message)
    return NextResponse.json({ error: 'Failed to load activity log' }, { status: 500 })
  }

  const rows = (logs ?? []) as AuditRow[]
  const profileIds = [...new Set(rows.map((row) => row.profile_id).filter(Boolean))] as string[]

  const profilesById = new Map<string, ProfileRow>()
  const roleByProfile = new Map<string, string>()
  if (profileIds.length) {
    const [profilesResult, settingsResult] = await Promise.all([
      db()
        .from('profiles')
        .select('id, full_name, first_name, last_name, email')
        .in('id', profileIds),
      db()
        .from('pharmacy_user_settings')
        .select('profile_id, pharmacy_role')
        .eq('tenant_id', auth.tenantId)
        .in('profile_id', profileIds),
    ])
    for (const profile of (profilesResult.data ?? []) as ProfileRow[]) {
      profilesById.set(profile.id, profile)
    }
    for (const setting of settingsResult.data ?? []) {
      roleByProfile.set(setting.profile_id, setting.pharmacy_role ?? '')
    }
  }

  return NextResponse.json({
    logs: rows.map((row) => {
      const profile = row.profile_id ? profilesById.get(row.profile_id) : undefined
      const name =
        profile?.full_name ||
        [profile?.first_name, profile?.last_name].filter(Boolean).join(' ') ||
        profile?.email?.split('@')[0] ||
        'System'
      const role = row.profile_id ? roleByProfile.get(row.profile_id) ?? '' : ''
      return {
        id: row.id,
        userId: row.profile_id,
        action: row.action,
        entity: row.entity,
        entityId: row.entity_id,
        details: row.details,
        createdAt: row.created_at,
        user: {
          name,
          role: role.replace('pharmacy_', '').toUpperCase() || 'STAFF',
        },
      }
    }),
  })
}
