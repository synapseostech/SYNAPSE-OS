import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@synapse/db/admin'
import {
  isMobileAuth,
  mobileHasPharmacyCapability,
  requireMobilePharmacyAuth,
} from '../../../../../../lib/mobile-pharmacy-auth'

export const dynamic = 'force-dynamic'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = () => supabaseAdmin as any

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

function isIsoDate(value: string): boolean {
  if (!DATE_RE.test(value)) return false
  const parsed = new Date(`${value}T00:00:00.000Z`)
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value
}

function toPeriod(row: Record<string, unknown>) {
  return {
    id: String(row.id),
    periodStart: row.period_start ?? null,
    periodEnd: row.period_end ?? null,
    status: row.status ?? null,
    closedAt: row.closed_at ?? null,
    closeSnapshot: row.close_snapshot ?? null,
  }
}

export async function GET(req: NextRequest) {
  const auth = await requireMobilePharmacyAuth(req)
  if (!isMobileAuth(auth)) return auth
  if (!mobileHasPharmacyCapability(auth, 'reports.financial')) {
    return NextResponse.json(
      { error: 'Accounting periods require a financial reports permission' },
      { status: 403 },
    )
  }

  const { data, error } = await db()
    .from('pharmacy_accounting_periods')
    .select('id, period_start, period_end, status, closed_at, close_snapshot')
    .eq('tenant_id', auth.tenantId)
    .order('period_start', { ascending: false })
    .limit(100)
  if (error) {
    console.error('[mobile/pharmacy/accounting/periods]', error.message)
    return NextResponse.json({ error: 'Failed to load accounting periods' }, { status: 500 })
  }

  return NextResponse.json({
    periods: (data ?? []).map((row: Record<string, unknown>) => toPeriod(row)),
  })
}

export async function POST(req: NextRequest) {
  const auth = await requireMobilePharmacyAuth(req)
  if (!isMobileAuth(auth)) return auth
  if (!mobileHasPharmacyCapability(auth, 'settings.manage')) {
    return NextResponse.json(
      { error: 'Closing a period requires settings management permission' },
      { status: 403 },
    )
  }

  try {
    const body = await req.json().catch(() => null)
    const periodStart = typeof body?.periodStart === 'string' ? body.periodStart : ''
    const periodEnd = typeof body?.periodEnd === 'string' ? body.periodEnd : ''
    if (!isIsoDate(periodStart) || !isIsoDate(periodEnd) || periodStart > periodEnd) {
      return NextResponse.json(
        { error: 'Enter a valid period in YYYY-MM-DD format.' },
        { status: 400 },
      )
    }
    if (periodEnd >= new Date().toISOString().slice(0, 10)) {
      return NextResponse.json(
        { error: 'Only a completed accounting period can be closed.' },
        { status: 400 },
      )
    }

    const { data, error } = await db().rpc('close_pharmacy_accounting_period', {
      p_tenant_id: auth.tenantId,
      p_period_start: periodStart,
      p_period_end: periodEnd,
      p_closed_by: auth.userId,
    })
    if (error) {
      const message = String(error.message ?? '')
      if (message.includes('ACCOUNTING_PERIOD_OVERLAP')) {
        return NextResponse.json(
          { error: 'This date range overlaps a period that is already closed.' },
          { status: 409 },
        )
      }
      if (message.includes('ACCOUNTING_PERIOD_NOT_ENDED')) {
        return NextResponse.json(
          { error: 'Only a completed accounting period can be closed.' },
          { status: 400 },
        )
      }
      if (message.includes('ACCOUNTING_PERIOD_OPEN_TILLS')) {
        return NextResponse.json(
          {
            error:
              'A till is still open for this period. Close every till first, or its cash will be recorded after the period is locked and the till will fail to close.',
            code: 'ACCOUNTING_PERIOD_OPEN_TILLS',
          },
          { status: 409 },
        )
      }
      throw error
    }

    return NextResponse.json(
      { ok: true, period: data ? toPeriod(data as Record<string, unknown>) : null },
      { status: 201 },
    )
  } catch (error) {
    console.error('[mobile/pharmacy/accounting/periods] close', error)
    return NextResponse.json({ error: 'Failed to close accounting period' }, { status: 500 })
  }
}
