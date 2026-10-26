import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@synapse/db/admin'
import {
  assessCloseReadiness,
  closeSnapshot,
  type CloseReadinessFacts,
  type TillSessionFacts,
} from '@synapse/db/accounting-close-readiness'
import {
  isMobileAuth,
  mobileHasPharmacyCapability,
  requireMobilePharmacyAuth,
} from '../../../../../../../lib/mobile-pharmacy-auth'

export const dynamic = 'force-dynamic'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = () => supabaseAdmin as any

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

function isIsoDate(value: string): boolean {
  if (!DATE_RE.test(value)) return false
  const parsed = new Date(`${value}T00:00:00.000Z`)
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value
}

function num(value: unknown): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}

function toFacts(row: Record<string, unknown>): CloseReadinessFacts {
  const sessions = Array.isArray(row.tillSessions) ? row.tillSessions : []
  return {
    periodStart: String(row.periodStart ?? ''),
    periodEnd: String(row.periodEnd ?? ''),
    today: String(row.assessedOn ?? ''),
    tillSessions: sessions
      .filter(
        (session): session is Record<string, unknown> =>
          Boolean(session) && typeof session === 'object',
      )
      .map(
        (session): TillSessionFacts => ({
          status: String(session.status ?? ''),
          openedOn: String(session.openedOn ?? ''),
          closedOn: session.closedOn == null ? null : String(session.closedOn),
        }),
      ),
    unmatchedBankLines: num(row.unmatchedBankLines),
    unmatchedBankValue: num(row.unmatchedBankValue),
    journalEntries: num(row.journalEntries),
    journalDebitTotal: num(row.journalDebitTotal),
    salesCount: num(row.salesCount),
    salesTotal: num(row.salesTotal),
    cashSalesTotal: num(row.cashSalesTotal),
  }
}

/**
 * Read-only readiness check, so an operator sees what closing would strand
 * before committing to a close that cannot be undone.
 */
export async function GET(req: NextRequest) {
  const auth = await requireMobilePharmacyAuth(req)
  if (!isMobileAuth(auth)) return auth
  if (!mobileHasPharmacyCapability(auth, 'reports.financial')) {
    return NextResponse.json(
      { error: 'The close readiness check requires a financial reports permission' },
      { status: 403 },
    )
  }

  const periodStart = new URL(req.url).searchParams.get('start') ?? ''
  const periodEnd = new URL(req.url).searchParams.get('end') ?? ''
  if (!isIsoDate(periodStart) || !isIsoDate(periodEnd) || periodStart > periodEnd) {
    return NextResponse.json(
      { error: 'Enter a valid period in YYYY-MM-DD format.' },
      { status: 400 },
    )
  }

  try {
    const { data, error } = await db().rpc('pharmacy_accounting_close_readiness', {
      p_tenant_id: auth.tenantId,
      p_period_start: periodStart,
      p_period_end: periodEnd,
    })
    if (error) {
      const message = String(error.message ?? '')
      // PGRST202 means 20261026190000 has not been applied on this deployment.
      if (String(error.code ?? '') === 'PGRST202' || message.includes('Could not find the function')) {
        console.error('[mobile/pharmacy/accounting/periods/readiness] RPC missing', error)
        return NextResponse.json(
          { error: 'The close readiness check is not available on this deployment.' },
          { status: 503 },
        )
      }
      throw error
    }

    if (!data || typeof data !== 'object') {
      return NextResponse.json(
        { error: 'The close readiness check returned no data.' },
        { status: 502 },
      )
    }

    const facts = toFacts(data as Record<string, unknown>)
    return NextResponse.json({
      readiness: assessCloseReadiness(facts),
      snapshot: closeSnapshot(facts),
    })
  } catch (error) {
    console.error('[mobile/pharmacy/accounting/periods/readiness]', error)
    return NextResponse.json(
      { error: 'Failed to check accounting period readiness.' },
      { status: 500 },
    )
  }
}
