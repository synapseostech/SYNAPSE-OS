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
import { consolidateTallyParts, type TallyConsolidation } from "./consolidate"
import { readTallyDocument } from "./source"
import {
  readTallySource,
  tallyChunkSourcePath,
  type TallyStorageClient,
} from "./storage"
import type { TallyMigrationManifest } from "./chunks"

/** One chunk's own ceiling. The bucket is wider; this is what the parser can take. */
export const TALLY_CHUNK_LIMIT = 20 * 1024 * 1024

export type TallyConsolidatedPlan = {
  plan: ReturnType<typeof normaliseTallyDocument>
  consolidation: TallyConsolidation
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
  },
): Promise<TallyConsolidatedPlan> {
  const parts = []
  for (const chunk of input.manifest.chunks) {
    const bytes = await readTallySource(
      client,
      tallyChunkSourcePath(input.tenantId, input.sessionId, chunk.id),
      TALLY_CHUNK_LIMIT,
    )
    parts.push(readTallyDocument(bytes, `${chunk.id}.xml`).document)
  }

  const consolidation = consolidateTallyParts(parts, { period: input.manifest.period })
  const plan = normaliseTallyDocument(consolidation.document, {
    conversionDate: input.conversionDate,
    mode: input.manifest.mode,
    currency: consolidation.document.currency,
    accountOverrides: input.accountOverrides,
    productSkuOverrides: input.productSkuOverrides,
  })

  return { plan, consolidation }
}
