/**
 * The Gate 0 probe (docs/pharmacy/TALLY_DOCUMENT_CHAIN_DESIGN.md §13).
 *
 * The document-chain archive is gated on three questions that only a real
 * export can answer: whether Tally's register carries order and inventory
 * documents at all (Q1), which linkage fields survive the XML (Q2), and what
 * counts the archive must reconcile against (Q3). This module answers all
 * three from one uploaded file and records no value from the company's books —
 * counts and tag names only.
 *
 * It is read-only by construction: the input is parsed, nothing is written,
 * and no import session is created.
 */

import { classifyTallyVoucherType, tallyVoucherSourceType } from "@synapse/db/tally-map"
import type { TallyVoucherKind } from "@synapse/db/tally-map"
import { parseTallyXmlRows, TALLY_LINKAGE_TAGS } from "@synapse/db/tally-xml-rows"
import type { TallyXmlDocument } from "@synapse/db/tally-xml-rows"

export type TallyProbeTagCoverage = {
  tag: string
  /** How many vouchers of this type carried the tag. */
  vouchers: number
}

export type TallyProbeVoucherType = {
  type: string
  kind: TallyVoucherKind
  vouchers: number
  cancelled: number
  /**
   * False means the ledger import will report this type as unsupported and
   * stage nothing from it — order, delivery note, receipt note, rejection and
   * stock journal all land here today.
   */
  stagedByLedgerImport: boolean
  linkage: TallyProbeTagCoverage[]
}

export type TallyProbeReport = {
  company?: string
  period: { from?: string; to?: string }
  vouchers: number
  masters: {
    ledgers: number
    groups: number
    stockItems: number
    stockGroups: number
    units: number
    godowns: number
  }
  /** Sorted: the types the ledger import drops first, then by count. */
  types: TallyProbeVoucherType[]
  /** Every linkage tag the probe looks for, so an absent row is stated, not implied. */
  candidateTags: readonly string[]
  warnings: string[]
  truncated: boolean
}

export function buildTallyProbeReport(document: TallyXmlDocument): TallyProbeReport {
  const byType = new Map<
    string,
    { kind: TallyVoucherKind; vouchers: number; cancelled: number; tags: Map<string, number> }
  >()

  for (const voucher of document.vouchers) {
    const type = voucher.type?.trim() || "(no type)"
    const entry = byType.get(type) ?? {
      kind: classifyTallyVoucherType(type),
      vouchers: 0,
      cancelled: 0,
      tags: new Map<string, number>(),
    }
    entry.vouchers++
    if (voucher.isCancelled) entry.cancelled++
    for (const tag of voucher.linkage ?? []) {
      entry.tags.set(tag, (entry.tags.get(tag) ?? 0) + 1)
    }
    byType.set(type, entry)
  }

  const types: TallyProbeVoucherType[] = [...byType.entries()]
    .map(([type, entry]) => ({
      type,
      kind: entry.kind,
      vouchers: entry.vouchers,
      cancelled: entry.cancelled,
      stagedByLedgerImport: tallyVoucherSourceType(entry.kind) !== undefined,
      // A zero is as useful as a count here: it says the tag is absent, which
      // is the answer Q2 is asking for.
      linkage: TALLY_LINKAGE_TAGS.map((tag) => ({ tag, vouchers: entry.tags.get(tag) ?? 0 })),
    }))
    .sort((left, right) => {
      if (left.stagedByLedgerImport !== right.stagedByLedgerImport) {
        return left.stagedByLedgerImport ? 1 : -1
      }
      return right.vouchers - left.vouchers || left.type.localeCompare(right.type)
    })

  return {
    company: document.company,
    period: document.financialPeriod,
    vouchers: document.vouchers.length,
    masters: {
      ledgers: document.ledgers.length,
      groups: document.groups.length,
      stockItems: document.stockItems.length,
      stockGroups: document.stockGroups.length,
      units: document.units.length,
      godowns: document.godowns.length,
    },
    types,
    candidateTags: TALLY_LINKAGE_TAGS,
    warnings: document.warnings,
    truncated: document.truncated !== undefined,
  }
}

/** Parses and probes one export. Throws the parser's own code on bad input. */
export function probeTallyExport(xml: string, fileName = "probe.xml"): TallyProbeReport {
  return buildTallyProbeReport(parseTallyXmlRows(xml, fileName))
}
