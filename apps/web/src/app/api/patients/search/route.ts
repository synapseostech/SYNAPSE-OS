import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@synapse/db/admin'
import { isContextError } from '../../../../lib/hospital-shared'
import { isMissingRpc, requireHospitalStaffContext } from '../../../../lib/hospital-dept'

export const dynamic = 'force-dynamic'

type SearchRow = {
  id: string
  full_name: string
  mrn: string | null
  dob?: string | null
  sex?: string | null
  phone_last4?: string | null
  match_kind?: string
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (c) => `\\${c}`)
}

/** Pre-migration path (name or MRN substring), kept until 20261120140000 is applied. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function legacySearch(db: any, tenantId: string, q: string, limit: number): Promise<SearchRow[]> {
  const pattern = `%${escapeLike(q)}%`
  const [byName, byMrn] = await Promise.all([
    db.from('patients').select('id, full_name, mrn').eq('tenant_id', tenantId).eq('is_deleted', false)
      .ilike('full_name', pattern).order('full_name', { ascending: true }).limit(limit),
    db.from('patients').select('id, full_name, mrn').eq('tenant_id', tenantId).eq('is_deleted', false)
      .ilike('mrn', pattern).order('full_name', { ascending: true }).limit(limit),
  ])
  if (byName.error) throw new Error(byName.error.message)
  if (byMrn.error) throw new Error(byMrn.error.message)
  const merged = new Map<string, SearchRow>()
  for (const p of [...(byMrn.data ?? []), ...(byName.data ?? [])] as SearchRow[]) {
    if (!merged.has(p.id)) merged.set(p.id, p)
  }
  return [...merged.values()].slice(0, limit)
}

/**
 * Registration desk search: name (typo tolerant), MRN, NIN or phone in any
 * Ugandan format (07…, +2567…). One indexed query, tenant from the session.
 */
export async function GET(req: NextRequest) {
  const ctx = await requireHospitalStaffContext()
  if (isContextError(ctx)) return ctx

  const { searchParams } = new URL(req.url)
  const q = (searchParams.get('q') ?? '').trim().slice(0, 80)
  const requested = Number(searchParams.get('limit') ?? '10')
  const limit = Number.isFinite(requested) ? Math.min(Math.max(Math.trunc(requested), 1), 50) : 10

  if (q.length < 2) return NextResponse.json({ patients: [] })

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = supabaseAdmin as any
  let rows: SearchRow[]
  const { data, error } = await db.rpc('hospital_search_patients', {
    p_tenant_id: ctx.tenantId,
    p_query: q,
    p_limit: limit,
  })
  if (error) {
    if (!isMissingRpc(error)) return NextResponse.json({ error: 'Search failed' }, { status: 500 })
    try {
      rows = await legacySearch(db, ctx.tenantId, q, limit)
    } catch {
      return NextResponse.json({ error: 'Search failed' }, { status: 500 })
    }
  } else {
    rows = (data ?? []) as SearchRow[]
  }

  return NextResponse.json({
    patients: rows.map((p) => ({
      id: p.id,
      fullName: p.full_name,
      mrn: p.mrn,
      dob: p.dob ?? null,
      sex: p.sex ?? null,
      phoneLast4: p.phone_last4 ?? null,
      matchKind: p.match_kind ?? 'name',
    })),
  })
}
