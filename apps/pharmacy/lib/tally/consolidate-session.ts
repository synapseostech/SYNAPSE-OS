/**
 * Turns a session's stored chunks into the plan Apply will post.
 *
 * Both ways into a cut-over end here: the bridge, which extracts chunk by
 * chunk, and a multi-file upload, which stages one uploaded file per chunk.
 * Keeping the read-merge-normalise sequence in one place is what stops the two
 * from drifting — a change to how chunks become a document lands for both.
 */

import { normaliseTallyDocument } from "@synapse/db/tally-normalise"
import type { TallyAccountOverrides } from "@synapse/db/tally-map"
import { applyTallyStockSheet, type TallyStockSheet, type TallyStockSheetMerge } from "./stock-sheet"
import { consolidateTallyParts, type TallyConsolidation } from "./consolidate"
import { readTallyDocument } from "./source"
import {
  readTallySource,
  tallyChunkSourcePath,
  TALLY_SOURCE_LIMIT,
  type TallyStorageClient,
} from "./storage"
import type { TallyMigrationManifest } from "./chunks"

/** One chunk's own ceiling: whatever the upload accepted, preview must be able to read. */
export const TALLY_CHUNK_LIMIT = TALLY_SOURCE_LIMIT

export type TallyConsolidatedPlan = {
  plan: ReturnType<typeof normaliseTallyDocument>
  consolidation: TallyConsolidation
  /** Set when a stock sheet was merged into the document. */
  stockSheet?: TallyStockSheetMerge
}

/** Every stored chunk, read and merged into one document. Nothing is normalised. */
export async function readStoredDocument(
  client: TallyStorageClient,
  input: {
    tenantId: string
    sessionId: string
    manifest: TallyMigrationManifest
  },
): Promise<TallyConsolidation> {
  const parts = []
  for (const chunk of input.manifest.chunks) {
    const bytes = await readTallySource(
      client,
      tallyChunkSourcePath(input.tenantId, input.sessionId, chunk.id),
      TALLY_CHUNK_LIMIT,
    )
    parts.push(readTallyDocument(bytes, `${chunk.id}.xml`).document)
  }

  return consolidateTallyParts(parts, {
    period: input.manifest.period,
    company: input.manifest.company,
  })
}

export async function consolidateStoredChunks(
  client: TallyStorageClient,
  input: {
    tenantId: string
    sessionId: string
    manifest: TallyMigrationManifest
    conversionDate?: string
    accountOverrides?: TallyAccountOverrides
    productSkuOverrides?: Record<string, string>
    /** Batch expiries the operator typed, merged before normalising. */
    stockSheet?: TallyStockSheet
  },
): Promise<TallyConsolidatedPlan> {
  const consolidation = await readStoredDocument(client, input)
  const merge = input.stockSheet
    ? applyTallyStockSheet(consolidation.document, input.stockSheet)
    : undefined
  const document = merge?.document ?? consolidation.document

  const plan = normaliseTallyDocument(document, {
    conversionDate: input.conversionDate,
    mode: input.manifest.mode,
    currency: document.currency,
    accountOverrides: input.accountOverrides,
    productSkuOverrides: input.productSkuOverrides,
  })

  return { plan, consolidation: { ...consolidation, document }, ...(merge ? { stockSheet: merge } : {}) }
}
