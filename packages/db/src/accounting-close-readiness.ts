/**
 * Period close readiness.
 *
 * `close_pharmacy_accounting_period` closes a period and then refuses every
 * posting dated inside it (`ACCOUNTING_PERIOD_CLOSED`). That is the right
 * control, but it was applied blind: the operator got no signal until something
 * downstream broke.
 *
 * The failure that matters most is a till session still open at close. Its cash
 * events are written when the till closes, not when the sale happened, so a
 * supervisor who closes the month on the 1st and has a cashier close the 30th's
 * till on the 2nd locks that till out of its own period. The cashier sees
 * `ACCOUNTING_PERIOD_CLOSED` on the till close screen, the day's cash never
 * reaches the ledger, and the variance sits unexplained.
 *
 * This module decides readiness from facts, so the rule can be tested without a
 * database and the same rule is mirrored in SQL. It does not query anything.
 */

export interface TillSessionFacts {
  status: string
  /** Business date (Africa/Kampala) the session was opened. */
  openedOn: string
  /** Business date it was closed, or null while open. */
  closedOn: string | null
}

export interface CloseReadinessFacts {
  periodStart: string
  periodEnd: string
  /** Today's business date in Africa/Kampala. */
  today: string
  tillSessions: TillSessionFacts[]
  unmatchedBankLines: number
  unmatchedBankValue: number
  journalEntries: number
  journalDebitTotal: number
  salesCount: number
  salesTotal: number
  cashSalesTotal: number
}

export type ReadinessSeverity = "blocker" | "warning"

export interface ReadinessIssue {
  code: string
  severity: ReadinessSeverity
  /** Written for the person at the counter, not for a log. */
  message: string
  value?: number
}

export interface CloseReadiness {
  ready: boolean
  issues: ReadinessIssue[]
  blockers: ReadinessIssue[]
  warnings: ReadinessIssue[]
}

/**
 * Whether a session prevents closing `periodEnd`.
 *
 * A session blocks when it has not been closed and it was opened on or before
 * the period end — because its cash will be recorded at close time and may fall
 * inside the period. A till opened after the period end belongs to a later
 * period and does not block this one.
 */
export function tillBlocksPeriodClose(session: TillSessionFacts, periodEnd: string): boolean {
  if (session.status === "closed") return false
  if (session.closedOn !== null) return false
  return session.openedOn <= periodEnd
}

function fmt(value: number): string {
  return new Intl.NumberFormat("en-UG", { maximumFractionDigits: 0 }).format(value)
}

export function assessCloseReadiness(facts: CloseReadinessFacts): CloseReadiness {
  const issues: ReadinessIssue[] = []

  if (!facts.periodStart || !facts.periodEnd || facts.periodStart > facts.periodEnd) {
    issues.push({
      code: "PERIOD_RANGE_INVALID",
      severity: "blocker",
      message: "The period start and end do not form a valid range.",
    })
  } else if (facts.periodEnd >= facts.today) {
    issues.push({
      code: "PERIOD_NOT_ENDED",
      severity: "blocker",
      message: "Only a completed accounting period can be closed.",
    })
  }

  const openTills = facts.tillSessions.filter((session) => tillBlocksPeriodClose(session, facts.periodEnd))
  if (openTills.length > 0) {
    issues.push({
      code: "OPEN_TILL_SESSIONS",
      severity: "blocker",
      value: openTills.length,
      message:
        `${openTills.length} till ${openTills.length === 1 ? "session is" : "sessions are"} still open for this period. ` +
        "Close every till first, or its cash will be recorded after the period is locked and the till will fail to close.",
    })
  }

  if (facts.unmatchedBankLines > 0) {
    issues.push({
      code: "UNMATCHED_BANK_LINES",
      severity: "warning",
      value: facts.unmatchedBankLines,
      message:
        `${facts.unmatchedBankLines} bank statement ${facts.unmatchedBankLines === 1 ? "line" : "lines"} worth ` +
        `UGX ${fmt(facts.unmatchedBankValue)} ${facts.unmatchedBankLines === 1 ? "is" : "are"} not matched. ` +
        "The ledger still balances; the bank position is unverified.",
    })
  }

  if (facts.journalEntries === 0 && facts.salesCount === 0) {
    issues.push({
      code: "NO_ACTIVITY",
      severity: "warning",
      message: "This period contains no sales and no journal entries. Confirm that is expected before locking it.",
    })
  }

  const blockers = issues.filter((issue) => issue.severity === "blocker")
  return {
    ready: blockers.length === 0,
    issues,
    blockers,
    warnings: issues.filter((issue) => issue.severity === "warning"),
  }
}

/**
 * The evidence a close records, so the period can be explained later.
 *
 * This is deliberately the raw facts and not the assessment. The warnings above
 * are a rendering of these numbers; storing the rendering would let the copy
 * drift away from the data it describes. `pharmacy_accounting_close_readiness`
 * returns the same keys, and the close SQL stores them verbatim.
 */
export interface CloseSnapshot {
  periodStart: string
  periodEnd: string
  assessedOn: string
  openTillSessions: number
  journalEntries: number
  journalDebitTotal: number
  salesCount: number
  salesTotal: number
  cashSalesTotal: number
  unmatchedBankLines: number
  unmatchedBankValue: number
}

export function closeSnapshot(facts: CloseReadinessFacts): CloseSnapshot {
  return {
    periodStart: facts.periodStart,
    periodEnd: facts.periodEnd,
    assessedOn: facts.today,
    openTillSessions: facts.tillSessions.filter((session) => tillBlocksPeriodClose(session, facts.periodEnd)).length,
    journalEntries: facts.journalEntries,
    journalDebitTotal: facts.journalDebitTotal,
    salesCount: facts.salesCount,
    salesTotal: facts.salesTotal,
    cashSalesTotal: facts.cashSalesTotal,
    unmatchedBankLines: facts.unmatchedBankLines,
    unmatchedBankValue: facts.unmatchedBankValue,
  }
}
