/**
 * Continuation of a completed Tally replay.
 *
 * A pharmacy is cut over once. A later export is allowed through only as a
 * continuation of the session that closed the previous period: same company,
 * a period that starts after the checkpoint's cutoff, and a replay — never a
 * snapshot laid on top of an existing movement history.
 *
 * The guard lives here so every route asks the same question. It reads the
 * checkpoint table directly with the service client, because the answer is
 * three columns and the closing state itself is only needed by the apply
 * stage, which reads it through the RPC.
 */

import type { TallyImportMode } from "./types"

export type TallyReplayCheckpointRef = {
  id: string
  companyKey: string
  sessionId: string
  throughDate: string
}

export type ContinuationEvaluation =
  | { kind: "none" }
  | { kind: "invalid"; code: string; message: string; continueFrom?: string }
  | { kind: "valid"; checkpoint: TallyReplayCheckpointRef }

export type ContinuationInput = {
  tenantId: string
  mapping: Record<string, unknown>
  companyKey: string
  conversionDate: string
  mode?: TallyImportMode
  /** Injected for tests; the routes pass their admin client. */
  client: { from: (table: string) => any }
}

/** The session a mapping declares itself a continuation of, if any. */
export function continuationSessionOf(mapping: Record<string, unknown>): string | null {
  const value = mapping.continuationOf
  return typeof value === "string" && value.trim() ? value.trim() : null
}

async function readCheckpointRow(
  client: ContinuationInput["client"],
  tenantId: string,
  column: "session_id" | "company_key",
  value: string,
): Promise<TallyReplayCheckpointRef | null> {
  const { data, error } = await client
    .from("pharmacy_tally_replay_checkpoints")
    .select("id, company_key, session_id, through_date")
    .eq("tenant_id", tenantId)
    .eq(column, value)
    .order("through_date", { ascending: false })
    .limit(1)
    .maybeSingle()

  if (error) {
    throw new Error(`TALLY_CONTINUATION_UNAVAILABLE: ${error.message}`)
  }
  if (!data) return null
  const row = data as Record<string, unknown>
  return {
    id: String(row.id),
    companyKey: String(row.company_key ?? ""),
    sessionId: String(row.session_id ?? ""),
    throughDate: String(row.through_date ?? "").slice(0, 10),
  }
}

/**
 * Decides whether this session may run despite a completed cut-over.
 *
 * `none` means the session does not claim to continue anything and the
 * ordinary one-shot guard applies unchanged. Anything that claims a
 * continuation but does not satisfy every condition is `invalid`, and the
 * caller must refuse rather than fall back to starting a second cut-over.
 */
export async function evaluateContinuation(
  input: ContinuationInput,
): Promise<ContinuationEvaluation> {
  const declared = continuationSessionOf(input.mapping)
  if (!declared) return { kind: "none" }

  if (input.mode !== "replay") {
    return {
      kind: "invalid",
      code: "TALLY_CONTINUATION_MODE",
      message:
        "Only a full-history replay can continue a previous replay. This session imports a snapshot, which would replace the history already applied rather than extend it.",
    }
  }

  const named = await readCheckpointRow(input.client, input.tenantId, "session_id", declared)
  if (!named) {
    return {
      kind: "invalid",
      code: "TALLY_CONTINUATION_NO_CHECKPOINT",
      message:
        "The Tally session this import says it continues never closed against a checkpoint, so there is no position to continue from. Start a new full cut-over instead.",
    }
  }

  if (named.companyKey !== input.companyKey) {
    return {
      kind: "invalid",
      code: "TALLY_CONTINUATION_COMPANY",
      message: `This export is for "${input.companyKey}" but the session it continues closed "${named.companyKey}". A continuation must be the same company.`,
    }
  }

  const latest = await readCheckpointRow(input.client, input.tenantId, "company_key", named.companyKey)
  if (latest && latest.sessionId !== named.sessionId) {
    return {
      kind: "invalid",
      code: "TALLY_CONTINUATION_STALE",
      message: `"${named.companyKey}" has already been continued past ${named.throughDate}. Continue session ${latest.sessionId} (closed at ${latest.throughDate}) instead.`,
      continueFrom: latest.sessionId,
    }
  }

  if (input.conversionDate <= named.throughDate) {
    return {
      kind: "invalid",
      code: "TALLY_CONTINUATION_PERIOD",
      message: `A continuation must begin after the previous close (${named.throughDate}); this export opens on ${input.conversionDate}. Export the period that follows it.`,
    }
  }

  return { kind: "valid", checkpoint: named }
}

/** A session that names a continuation that did not close this pharmacy. */
export const TALLY_CONTINUATION_UNKNOWN = {
  error: "The Tally session this import continues did not close this pharmacy's cut-over.",
  code: "TALLY_CONTINUATION_UNKNOWN",
  humanMessage:
    "This import says it continues an earlier Tally session, but that session is not the one that completed this pharmacy's cut-over. Start a fresh cut-over instead.",
} as const

export const CONTINUATION_REFUSALS = {
  TALLY_CONTINUATION_MODE:
    "Only a full-history replay can continue a previous replay.",
  TALLY_CONTINUATION_NO_CHECKPOINT:
    "The Tally session this import continues has no checkpoint to continue from.",
  TALLY_CONTINUATION_COMPANY:
    "A continuation must be for the same company as the session it continues.",
  TALLY_CONTINUATION_STALE:
    "This company has already been continued to a later date.",
  TALLY_CONTINUATION_PERIOD:
    "A continuation must begin after the previous close.",
} as const
