/**
 * What a bridge run actually produces, replayed end to end.
 *
 * A bridge export is three files with two different periods on them: one
 * masters file whose stated period is the span Tally was asked for (its
 * financial year), and one day book per month through the cut-over date. The
 * replay cut-off must come from the day books — the figures in the masters are
 * Tally's closing position at that cut-off — and the masters' own later period
 * must never be mistaken for it.
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

const COMPANY = "ZZ Bridge Replay Pharmacy"
const COMPANY_GUID = "3a000000-0000-4000-8000-000000000001"
const ITEM = "ZZ Bridge Paracetamol"

/** The day books stop here; the operator's -To. */
const CUTOFF = "2026-11-09"
const FIRST_VOUCHER_DATE = "2025-10-01"
/** Tally's own financial year end, later than the cut-off. */
const TALLY_PERIOD_END = "2026-12-31"

const NOW = "2026-11-09T12:00:00.000Z"

function envelope(inner: string): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    "<ENVELOPE>",
    "  <HEADER><TALLYREQUEST>Export Data</TALLYREQUEST></HEADER>",
    "  <BODY><DATA>",
    '    <TALLYMESSAGE xmlns:UDF="TallyUDF">',
    inner,
    "    </TALLYMESSAGE>",
    "  </DATA></BODY>",
    "</ENVELOPE>",
  ].join("\n")
}

function companyBlock(from: string, to: string): string {
  return [
    "      <COMPANY>",
    `        <COMPANYNAME>${COMPANY}</COMPANYNAME>`,
    `        <GUID>${COMPANY_GUID}</GUID>`,
    "        <CURRENCYNAME>UGX</CURRENCYNAME>",
    `        <SVFROMDATE>${from.replace(/-/g, "")}</SVFROMDATE>`,
    `        <SVTODATE>${to.replace(/-/g, "")}</SVTODATE>`,
    "      </COMPANY>",
  ].join("\n")
}

function ledger(name: string, parent: string, closing: number): string {
  return [
    `      <LEDGER NAME="${name}">`,
    `        <PARENT>${parent}</PARENT>`,
    "        <OPENINGBALANCE>0.00</OPENINGBALANCE>",
    `        <CLOSINGBALANCE>${closing.toFixed(2)}</CLOSINGBALANCE>`,
    "      </LEDGER>",
  ].join("\n")
}

/**
 * What `POST /api/tally/export?scope=masters` answers: the chart of accounts
 * with Tally's closing balances and the stock item's closing quantity and
 * value. The stated period is the span Tally was asked for, which ends after
 * the cut-over — precisely the property the portal must not read as the date
 * those closing figures belong to.
 */
function mastersXml(): string {
  const groups = [
    "Current Assets",
    "Cash-in-Hand",
    "Sundry Creditors",
    "Current Liabilities",
    "Sales Accounts",
    "Purchase Accounts",
  ]
  return envelope(
    [
      companyBlock(FIRST_VOUCHER_DATE, TALLY_PERIOD_END),
      ...groups.map((group) => `      <GROUP NAME="${group}"/>`),
      ledger("Cash-in-hand", "Cash-in-Hand", 600),
      ledger("Sales Accounts", "Sales Accounts", -600),
      ledger("Purchase Accounts", "Purchase Accounts", 1000),
      ledger("ZZ Supplier", "Sundry Creditors", -1000),
      '      <UNIT NAME="Strip"><SYMBOL>strip</SYMBOL></UNIT>',
      `      <STOCKITEM NAME="${ITEM}">`,
      "        <PARENT>Primary</PARENT>",
      "        <BASEUNITS>Strip</BASEUNITS>",
      "        <ISBATCHWISEON>Yes</ISBATCHWISEON>",
      "        <ISEXPIRYON>Yes</ISEXPIRYON>",
      "        <OPENINGBALANCE>0 Strip</OPENINGBALANCE>",
      "        <OPENINGRATE>0</OPENINGRATE>",
      "        <OPENINGVALUE>0.00</OPENINGVALUE>",
      "        <CLOSINGBALANCE>6 Strip</CLOSINGBALANCE>",
      "        <CLOSINGVALUE>600.00</CLOSINGVALUE>",
      "      </STOCKITEM>",
    ].join("\n"),
  )
}

function ledgerEntry(name: string, debit: number): string {
  return [
    "        <ALLLEDGERENTRIES.LIST>",
    `          <LEDGERNAME>${name}</LEDGERNAME>`,
    `          <ISDEEMEDPOSITIVE>${debit > 0 ? "Yes" : "No"}</ISDEEMEDPOSITIVE>`,
    `          <AMOUNT>${debit.toFixed(2)}</AMOUNT>`,
    "        </ALLLEDGERENTRIES.LIST>",
  ].join("\n")
}

function stockEntry(
  quantity: number,
  rate: number,
  inbound: boolean,
  batch?: { name: string; expiry: string },
): string {
  const amount = inbound ? quantity * rate : -quantity * rate
  return [
    "        <ALLINVENTORYENTRIES.LIST>",
    `          <STOCKITEMNAME>${ITEM}</STOCKITEMNAME>`,
    `          <ISDEEMEDPOSITIVE>${inbound ? "Yes" : "No"}</ISDEEMEDPOSITIVE>`,
    `          <RATE>${rate.toFixed(2)}/Strip</RATE>`,
    `          <AMOUNT>${amount.toFixed(2)}</AMOUNT>`,
    `          <ACTUALQTY>${quantity} Strip</ACTUALQTY>`,
    ...(batch
      ? [
          "          <BATCHALLOCATIONS.LIST>",
          `            <BATCHNAME>${batch.name}</BATCHNAME>`,
          `            <EXPIRYDATE>${batch.expiry.replace(/-/g, "")}</EXPIRYDATE>`,
          `            <ACTUALQTY>${quantity} Strip</ACTUALQTY>`,
          `            <AMOUNT>${amount.toFixed(2)}</AMOUNT>`,
          "          </BATCHALLOCATIONS.LIST>",
        ]
      : []),
    "        </ALLINVENTORYENTRIES.LIST>",
  ].join("\n")
}

function voucher(body: {
  type: string
  guid: string
  date: string
  number: string
  party: string
  narration: string
  ledgers: Array<[string, number]>
  stock: string
}): string {
  return [
    `      <VOUCHER VCHTYPE="${body.type}" GUID="${body.guid}">`,
    `        <DATE>${body.date.replace(/-/g, "")}</DATE>`,
    `        <GUID>${body.guid}</GUID>`,
    `        <VOUCHERNUMBER>${body.number}</VOUCHERNUMBER>`,
    `        <PARTYLEDGERNAME>${body.party}</PARTYLEDGERNAME>`,
    `        <NARRATION>${body.narration}</NARRATION>`,
    ...body.ledgers.map(([name, debit]) => ledgerEntry(name, debit)),
    body.stock,
    "      </VOUCHER>",
  ].join("\n")
}

/** 10 units received at 100.00 on 2025-10-05. */
function firstDayBookXml(): string {
  return envelope(
    [
      companyBlock(FIRST_VOUCHER_DATE, "2026-10-31"),
      voucher({
        type: "Purchase",
        guid: "3a000000-0000-4000-8000-000000000101",
        date: "2025-10-05",
        number: "PUR-0001",
        party: "ZZ Supplier",
        narration: "Synthetic purchase",
        ledgers: [
          ["Purchase Accounts", 1000],
          ["ZZ Supplier", -1000],
        ],
        stock: stockEntry(10, 100, true, { name: "BRG-2401", expiry: "2027-01-31" }),
      }),
    ].join("\n"),
  )
}

/** 4 units sold at 150.00 on 2026-11-02, after the first file's month. */
function lastDayBookXml(): string {
  return envelope(
    [
      companyBlock("2026-11-01", CUTOFF),
      voucher({
        type: "Sales",
        guid: "3a000000-0000-4000-8000-000000000102",
        date: "2026-11-02",
        number: "SAL-0001",
        party: "Cash-in-hand",
        narration: "Synthetic sale",
        ledgers: [
          ["Cash-in-hand", 600],
          ["Sales Accounts", -600],
        ],
        stock: stockEntry(4, 150, false),
      }),
    ].join("\n"),
  )
}

/**
 * Stages the files exactly as the sources route does: describe, open the
 * manifest from the first file, ensure the chunk, widen the period, then record
 * the completed read.
 */
function stageBridgeRun(): { manifest: TallyMigrationManifest; parts: TallyXmlDocument[] } {
  const files = [
    { name: "2-masters-20251001-20261231.xml", xml: mastersXml() },
    { name: "3-daybook-20251001-20261031.xml", xml: firstDayBookXml() },
    { name: "3-daybook-20261101-20261109.xml", xml: lastDayBookXml() },
  ]

  let manifest: TallyMigrationManifest | undefined
  const parts: TallyXmlDocument[] = []

  for (const file of files) {
    const bytes = new TextEncoder().encode(file.xml)
    const { document } = readTallyDocument(bytes, file.name)
    const described = describeStagedDocument(document, { company: COMPANY })
    if (!described.ok) throw new Error(`${described.code}: ${described.message}`)

    manifest =
      manifest ??
      createOpenManifest({
        sessionId: "session-bridge-replay",
        company: described.company,
        companySource: described.companySource,
        mode: "replay",
        period: described.range,
        periodSource: described.periodSource,
        ...(described.declaredPeriod ? { declaredPeriod: described.declaredPeriod } : {}),
        updatedAt: NOW,
      })

    manifest = ensureChunk(
      manifest,
      { kind: described.kind, id: described.chunkId, range: described.range },
      NOW,
    )
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
  return { manifest, parts }
}

function consolidatedDocument(): TallyXmlDocument {
  const { manifest, parts } = stageBridgeRun()
  return consolidateTallyParts(parts, { period: manifest.period, company: COMPANY }).document
}

describe("bridge-shaped export", () => {
  it("takes the replay period from the day books, not from the masters file", () => {
    const { manifest, parts } = stageBridgeRun()

    expect(parts[0]?.financialPeriod).toEqual({
      from: FIRST_VOUCHER_DATE,
      to: TALLY_PERIOD_END,
    })

    expect(manifest.period).toEqual({ from: FIRST_VOUCHER_DATE, to: CUTOFF })
    const mastersChunk = manifest.chunks.find((chunk) => chunk.kind === "masters")
    expect(mastersChunk?.range).toEqual({ from: FIRST_VOUCHER_DATE, to: CUTOFF })
  })

  it("replays the run to Tally's own closing position with no blocking difference", () => {
    const plan = normaliseTallyDocument(consolidatedDocument(), {
      mode: "replay",
      today: CUTOFF,
    })

    // The cut-off is the last day book's end; no separate entry was supplied.
    expect(plan.cutoffDate).toBe(CUTOFF)
    expect(
      plan.exceptions.filter(
        (exception) =>
          exception.code === "REPLAY_PERIOD_MISMATCH" ||
          exception.code === "REPLAY_PERIOD_REQUIRED" ||
          exception.code === "REPLAY_PERIOD_INVALID",
      ),
    ).toEqual([])
    expect(plan.exceptions.filter((exception) => exception.severity === "blocking")).toEqual([])

    const simulation = simulateReplay(plan)
    const reconciliation = reconcileReplay(simulation, plan)

    expect(reconciliation.blocking).toBe(0)

    const row = (scope: string, key: string) =>
      reconciliation.rows.find((entry) => entry.scope === scope && entry.key === key)

    expect(row("stock_item", ITEM)).toMatchObject({
      expected: 6,
      actual: 6,
      status: "match",
    })
    expect(row("stock_item", `${ITEM} (value)`)).toMatchObject({
      expected: 600,
      actual: 600,
      status: "match",
    })
    expect(row("stock_total", "stock value")).toMatchObject({
      expected: 600,
      actual: 600,
      status: "match",
    })

    for (const name of ["Cash-in-hand", "Sales Accounts", "Purchase Accounts", "ZZ Supplier"]) {
      const account = reconciliation.rows.find(
        (entry) => entry.scope === "account" && entry.key.endsWith(` ${name}`),
      )
      expect(account, name).toMatchObject({ status: "match" })
    }

    // Every ledger and stock row on the export is compared, not left unproven.
    expect(
      reconciliation.rows.filter((entry) => entry.status === "not-available"),
    ).toEqual([])
  })

  it("refuses to compare balances when the cut-off is forced to Tally's period end", () => {
    const plan = normaliseTallyDocument(consolidatedDocument(), {
      mode: "replay",
      cutoffDate: TALLY_PERIOD_END,
      today: CUTOFF,
    })

    const mismatch = plan.exceptions.find(
      (exception) => exception.code === "REPLAY_PERIOD_MISMATCH",
    )
    expect(mismatch?.severity).toBe("blocking")
    expect(mismatch?.message).toContain(CUTOFF)
    expect(mismatch?.message).toContain(TALLY_PERIOD_END)
  })
})
