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

/** Recent stock import sessions for this pharmacy, newest first. */
export async function GET(req: NextRequest) {
  const auth = await requireMobilePharmacyAuth(req)
  if (!isMobileAuth(auth)) return auth
  if (!mobileHasPharmacyCapability(auth, 'inventory.write')) {
    return NextResponse.json({ error: 'Import history requires an inventory write permission' }, { status: 403 })
  }

  const limit = Math.min(Number(new URL(req.url).searchParams.get('limit') ?? '20') || 20, 50)

  const { data, error } = await db()
    .from('pharmacy_import_sessions')
    .select(
      'id, source_system, file_name, status, total_rows, matched_rows, flagged_rows, ai_summary, error_message, created_at, completed_at',
    )
    .eq('tenant_id', auth.tenantId)
    .order('created_at', { ascending: false })
    .limit(limit)

  if (error) {
    console.error('[mobile/pharmacy/imports]', error.message)
    return NextResponse.json({ error: 'Failed to load import history' }, { status: 500 })
  }

  return NextResponse.json({
    sessions: (data ?? []).map((row: Record<string, unknown>) => ({
      id: String(row.id),
      sourceSystem: row.source_system ?? null,
      fileName: row.file_name ?? null,
      status: row.status ?? null,
      totalRows: Number(row.total_rows ?? 0),
      matchedRows: Number(row.matched_rows ?? 0),
      flaggedRows: Number(row.flagged_rows ?? 0),
      summary: row.ai_summary ?? null,
      errorMessage: row.error_message ?? null,
      createdAt: row.created_at ?? null,
      completedAt: row.completed_at ?? null,
    })),
  })
}
