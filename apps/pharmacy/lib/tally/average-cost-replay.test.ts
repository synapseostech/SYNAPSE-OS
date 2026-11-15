/**
 * A bridge-shaped export of an Average Cost item, replayed end to end.
 *
 * Tally's default costing method is Average Cost: closing stock is valued at
 * the financial year's inward value over its inward quantity, whatever was
 * sold in between. The replay keeps its own batch values, which follow a
 * moving average when every receipt shares Tally's default "Primary Batch".
 * The two agree only while purchase prices stand still, so a real pharmacy's
 * history disagreed on almost every item and Apply could not complete.
 *
 * This test runs the file shapes tally-export-history.ps1 writes — a masters
 * file carrying COSTINGMETHOD and the company's financial-year start, and one
 * day book per month — through staging, consolidation, normalisation, the
 * replay and the reconciliation the review gate reads.
 *
 * Every value here is invented. No customer data is used.
 */

import { describe, expect, it } from "vitest"

import { normaliseTallyDocument } from "@synapse/db/tally-normalise"
import { reconcileReplay, simulateReplay } from "@synapse/db/tally-replay"
import type { TallyXmlDocument } from "@synapse/db/tally-xml-rows"

import {
  createOpenManifest,
  ensureChunk,
  recordChunkResult,
  widenPeriod,
  type TallyMigrationManifest,
} from "./chunks"
import { consolidateTallyParts } from "./consolidate"
import { describeStagedDocument } from "./manifest"
import { readTallyDocument } from "./source"

const COMPANY = "ZZ Average Cost Pharmacy"
const ITEM = "ZZ Avg Amoxicillin 250mg"
const FROM = "2025-10-01"
const CUTOFF = "2025-11-30"
const NOW = "2025-12-01T09:00:00.000Z"

function envelope(inner: string): string {
  return `<ENVELOPE><BODY><DATA>${inner}</DATA></BODY></ENVELOPE>`
}

/** The company record exactly as the export script writes it. */
function companyRecord(from: string, to: string, financialYearStart?: string): string {
  return (
    `<COMPANY NAME="${COMPANY}"><COMPANYNAME>${COMPANY}</COMPANYNAME>` +
    `<SVFROMDATE>${from.replace(/-/g, "")}</SVFROMDATE><SVTODATE>${to.replace(/-/g, "")}</SVTODATE>` +
    (financialYearStart ? `<STARTINGFROM>${financialYearStart.replace(/-/g, "")}</STARTINGFROM>` : "") +
    "</COMPANY>"
  )
}

function ledger(name: string, parent: string, closing: number): string {
  return (
    `<LEDGER NAME="${name}"><PARENT>${parent}</PARENT><OPENINGBALANCE>0.00</OPENINGBALANCE>` +
    `<CLOSINGBALANCE>${closing.toFixed(2)}</CLOSINGBALANCE></LEDGER>`
  )
}

/**
 * Tally's closing position at the cut-off. Received 10 @ 100 and 10 @ 200,
 * sold 5 between them: (1,000 + 2,000) / 20 = 150 a unit, 15 on hand, 2,250.
 */
function mastersXml(options: { financialYearStart?: string; costingMethod?: string }): string {
  return envelope(
    [
      companyRecord(FROM, CUTOFF, options.financialYearStart),
      '<GROUP NAME="Current Assets"/>',
      '<GROUP NAME="Cash-in-Hand"><PARENT>Current Assets</PARENT></GROUP>',
      '<GROUP NAME="Current Liabilities"/>',
      '<GROUP NAME="Sundry Creditors"><PARENT>Current Liabilities</PARENT></GROUP>',
      '<GROUP NAME="Sales Accounts"/>',
      '<GROUP NAME="Purchase Accounts"/>',
      ledger("Cash-in-hand", "Cash-in-Hand", 1000),
      ledger("Sales Accounts", "Sales Accounts", -1000),
      ledger("Purchase Accounts", "Purchase Accounts", 3000),
      ledger("ZZ Supplier", "Sundry Creditors", -3000),
      '<UNIT NAME="Nos"><SYMBOL>nos</SYMBOL></UNIT>',
      `<STOCKITEM NAME="${ITEM}"><PARENT>Primary</PARENT><BASEUNITS>Nos</BASEUNITS>` +
        (options.costingMethod ? `<COSTINGMETHOD>${options.costingMethod}</COSTINGMETHOD>` : "") +
        "<OPENINGBALANCE>0 Nos</OPENINGBALANCE><OPENINGRATE>0</OPENINGRATE><OPENINGVALUE>0.00</OPENINGVALUE>" +
        "<CLOSINGBALANCE>15 Nos</CLOSINGBALANCE><CLOSINGVALUE>2250.00</CLOSINGVALUE></STOCKITEM>",
    ].join(""),
  )
}

function stock(quantity: number, rate: number, inbound: boolean): string {
  const amount = (inbound ? 1 : -1) * quantity * rate
  return (
    `<ALLINVENTORYENTRIES.LIST><STOCKITEMNAME>${ITEM}</STOCKITEMNAME>` +
    `<ISDEEMEDPOSITIVE>${inbound ? "Yes" : "No"}</ISDEEMEDPOSITIVE><RATE>${rate.toFixed(2)}/Nos</RATE>` +
    `<AMOUNT>${amount.toFixed(2)}</AMOUNT><ACTUALQTY>${quantity} Nos</ACTUALQTY>` +
    `<BATCHALLOCATIONS.LIST><BATCHNAME>Primary Batch</BATCHNAME><ACTUALQTY>${quantity} Nos</ACTUALQTY>` +
    `<AMOUNT>${amount.toFixed(2)}</AMOUNT></BATCHALLOCATIONS.LIST></ALLINVENTORYENTRIES.LIST>`
  )
}

function voucher(
  type: string,
  guid: string,
  date: string,
  party: string,
  ledgers: Array<[string, number]>,
  inventory: string,
): string {
  return (
    `<VOUCHER VCHTYPE="${type}" GUID="${guid}"><DATE>${date.replace(/-/g, "")}</DATE><GUID>${guid}</GUID>` +
    `<VOUCHERNUMBER>${guid.slice(-4)}</VOUCHERNUMBER><PARTYLEDGERNAME>${party}</PARTYLEDGERNAME>` +
    ledgers
      .map(
        ([name, debit]) =>
          `<ALLLEDGERENTRIES.LIST><LEDGERNAME>${name}</LEDGERNAME><ISDEEMEDPOSITIVE>${debit > 0 ? "Yes" : "No"}</ISDEEMEDPOSITIVE>` +
          `<AMOUNT>${debit.toFixed(2)}</AMOUNT></ALLLEDGERENTRIES.LIST>`,
      )
      .join("") +
    inventory +
    "</VOUCHER>"
  )
}

function octoberDayBook(): string {
  return envelope(
    companyRecord("2025-10-01", "2025-10-31") +
      voucher("Purchase", "4b000000-0000-4000-8000-000000000101", "2025-10-03", "ZZ Supplier",
        [["Purchase Accounts", 1000], ["ZZ Supplier", -1000]], stock(10, 100, true)) +
      voucher("Cash Sale", "4b000000-0000-4000-8000-000000000102", "2025-10-20", "Cash-in-hand",
        [["Cash-in-hand", 1000], ["Sales Accounts", -1000]], stock(5, 200, false)),
  )
}

function novemberDayBook(): string {
  return envelope(
    companyRecord("2025-11-01", "2025-11-30") +
      voucher("Purchase", "4b000000-0000-4000-8000-000000000103", "2025-11-04", "ZZ Supplier",
        [["Purchase Accounts", 2000], ["ZZ Supplier", -2000]], stock(10, 200, true)),
  )
}

function replay(options: { financialYearStart?: string; costingMethod?: string }) {
  const files = [
    { name: "2-masters-20251001-20251130.xml", xml: mastersXml(options) },
    { name: "3-daybook-20251001-20251031.xml", xml: octoberDayBook() },
    { name: "3-daybook-20251101-20251130.xml", xml: novemberDayBook() },
  ]
  let manifest: TallyMigrationManifest | undefined
  const parts: TallyXmlDocument[] = []
  for (const file of files) {
    const { document } = readTallyDocument(new TextEncoder().encode(file.xml), file.name)
    const described = describeStagedDocument(document, { company: COMPANY })
    if (!described.ok) throw new Error(`${described.code}: ${described.message}`)
    manifest =
      manifest ??
      createOpenManifest({
        sessionId: "session-average-cost",
        company: described.company,
        companySource: described.companySource,
        mode: "replay",
        period: described.range,
        periodSource: described.periodSource,
        updatedAt: NOW,
      })
    manifest = ensureChunk(manifest, { kind: described.kind, id: described.chunkId, range: described.range }, NOW)
    manifest = widenPeriod(manifest, described.range, NOW, described.kind)
    manifest = recordChunkResult(
      manifest,
      described.chunkId,
      {
        status: "complete",
        recordsRead: described.recordsRead,
        ...(described.firstDate ? { firstDate: described.firstDate } : {}),
        ...(described.lastDate ? { lastDate: described.lastDate } : {}),
      },
      NOW,
    )
    parts.push(document)
  }
  if (!manifest) throw new Error("no files staged")
  const document = consolidateTallyParts(parts, { period: manifest.period, company: COMPANY }).document
  const plan = normaliseTallyDocument(document, { mode: "replay", today: CUTOFF, batchExpiry: "not-supplied" })
  const reconciliation = reconcileReplay(simulateReplay(plan), plan)
  const row = (key: string) => reconciliation.rows.find((entry) => entry.key === key)
  return { plan, reconciliation, row }
}

describe("Average Cost item in a bridge-shaped export", () => {
  it("carries the costing method and the financial-year start from the masters into the plan", () => {
    const { plan } = replay({ financialYearStart: "2025-07-01", costingMethod: "Avg. Cost" })
    expect(plan.financialYearStart).toBe("2025-07-01")
    expect(plan.stockItems.find((item) => item.sourceName === ITEM)?.costingMethod).toBe("Avg. Cost")
  })

  it("reaches Tally's closing value, so nothing blocks Apply", () => {
    const { reconciliation, row } = replay({ financialYearStart: "2025-07-01", costingMethod: "Avg. Cost" })
    expect(row(ITEM)).toMatchObject({ expected: 15, actual: 15, status: "match" })
    expect(row(`${ITEM} (value)`)).toMatchObject({
      expected: 2250,
      actual: 2250,
      status: "match",
      basis: "average-cost",
    })
    expect(row("stock value")).toMatchObject({ expected: 2250, actual: 2250, status: "match" })
    expect(reconciliation.rows.filter((entry) => entry.status === "difference")).toEqual([])
    expect(reconciliation.blocking).toBe(0)
  })

  it("is the difference the replay used to report: batch values say 2,500", () => {
    // No costing method stated: the replay keeps its own batch values, which
    // is what every export read before this change was compared on.
    const { reconciliation, row } = replay({ financialYearStart: "2025-07-01" })
    expect(row(`${ITEM} (value)`)).toMatchObject({ actual: 2500, status: "difference", basis: "batch" })
    expect(reconciliation.blocking).toBeGreaterThan(0)
  })

  it("does not compare the value when the export does not say when the financial year begins", () => {
    const { reconciliation, row } = replay({ costingMethod: "Avg. Cost" })
    expect(row(ITEM)?.status).toBe("match")
    expect(row(`${ITEM} (value)`)?.status).toBe("not-available")
    expect(row(`${ITEM} (value)`)?.note).toMatch(/financial year/)
    expect(reconciliation.blocking).toBe(0)
  })
})
