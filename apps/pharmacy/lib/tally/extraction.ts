/**
 * The extraction loop.
 *
 * One session, one manifest, one range at a time. The engine never invents a
 * result: every chunk's counts, dates and failure reason come back from the
 * sink that read and stored it, and each run starts from the sink's saved
 * manifest. That is what makes a resumed run safe — a chunk already recorded
 * as complete is never asked for again, and a retry replaces its own entry.
 *
 * A transport failure is retried only when it can succeed unchanged. A chunk
 * too large for the parser is not retried as it is: it is halved and its two
 * halves take its place. A response that parsed but did not reconcile fails the
 * chunk, because re-sending the same range would produce the same answer.
 *
 * Pure orchestration; the source (local bridge) and sink (portal server) are
 * injected, so the loop is testable without either.
 */

import {
  canRetryChunk,
  halveRange,
  nextChunkToRun,
  summariseExtraction,
  type TallyChunkKind,
  type TallyDateRange,
  type TallyExtractionSummary,
  type TallyMigrationManifest,
} from "./chunks"
import { TallyBridgeError } from "./bridge-client"

export const EXTRACTION_MAX_ATTEMPTS = 3
/** Split below the bridge's own 25 MB ceiling so a big chunk is halved, not failed. */
export const EXTRACTION_MAX_CHUNK_BYTES = 20 * 1024 * 1024

export type TallyExtractionMode = "opening" | "closing"

export type TallyExtractionSource = {
  exportRange(input: {
    company: string
    mode: TallyExtractionMode
    /** Masters are read once; `vouchers` is one date range of the history. */
    kind: TallyChunkKind
    range: TallyDateRange
  }): Promise<{ xml: string; bytes: number }>
}

export type TallyChunkSubmission = {
  chunkId: string
  kind: TallyChunkKind
  range: TallyDateRange
  attempt: number
  xml: string
  bytes: number
}

export type TallyChunkRecorded = {
  manifest: TallyMigrationManifest
  result: {
    status: "complete" | "failed"
    recordsRead?: number
    firstDate?: string
    lastDate?: string
    error?: string
  }
}

/**
 * The portal server. `load` is the checkpoint: the engine re-reads it before
 * every attempt, so two tabs, a reload, or a retry after a dropped response
 * all see the same recorded state rather than an in-memory guess.
 */
export type TallyExtractionSink = {
  load(): Promise<TallyMigrationManifest>
  start(input: { chunkId: string; attempt: number }): Promise<TallyMigrationManifest>
  submit(input: TallyChunkSubmission): Promise<TallyChunkRecorded>
  fail(input: { chunkId: string; attempt: number; error: string }): Promise<TallyMigrationManifest>
  split(input: { chunkId: string; ranges: TallyDateRange[] }): Promise<TallyMigrationManifest>
}

export type TallyExtractionStop =
  | "complete"
  | "failed"
  | "attempts_exhausted"
  | "cancelled"

export type TallyExtractionResult = {
  manifest: TallyMigrationManifest
  summary: TallyExtractionSummary
  stopped: TallyExtractionStop
  chunkId?: string
}

export type TallyExtractionOptions = {
  company: string
  mode: TallyExtractionMode
  source: TallyExtractionSource
  sink: TallyExtractionSink
  maxAttempts?: number
  maxChunkBytes?: number
  signal?: AbortSignal
  wait?: (ms: number) => Promise<void>
  onProgress?: (manifest: TallyMigrationManifest, summary: TallyExtractionSummary) => void
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message.slice(0, 300)
  return "TALLY_CHUNK_FAILED"
}

function errorCode(error: unknown): string {
  if (error instanceof TallyBridgeError) return error.code
  const code = (error as { code?: unknown } | null)?.code
  return typeof code === "string" ? code : ""
}

/**
 * Whether the same request could succeed on a second attempt. A refused
 * request (`TALLY_BRIDGE_PERIOD_MISMATCH`, a bad date) never becomes valid by
 * repeating it; a busy bridge, a timeout or a dropped connection can.
 */
export function isTransientExtractionError(error: unknown): boolean {
  if (error instanceof TallyBridgeError) {
    if (error.status === 409 || error.status === 502 || error.status === 503 || error.status === 504) {
      return true
    }
    if (error.status >= 400 && error.status < 500) return false
    // No HTTP status: the bridge could not be reached at all.
    return true
  }
  if (error instanceof Error) {
    if (error.name === "AbortError") return false
    if (error.name === "TypeError" || error.name === "TimeoutError") return true
  }
  return ["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "ENOTFOUND", "EAI_AGAIN"].includes(
    errorCode(error),
  )
}

/** An oversized response is recoverable by reading a narrower range. */
export function isSplittableExtractionError(error: unknown): boolean {
  return errorCode(error) === "TALLY_BRIDGE_EXPORT_TOO_LARGE"
}

function retryDelay(attempt: number): number {
  return Math.min(attempt * 1_000, 5_000)
}

const defaultWait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

function progress(
  options: TallyExtractionOptions,
  manifest: TallyMigrationManifest,
): void {
  options.onProgress?.(manifest, summariseExtraction(manifest))
}

function finish(
  options: TallyExtractionOptions,
  manifest: TallyMigrationManifest,
  stopped: TallyExtractionStop,
  chunkId?: string,
): TallyExtractionResult {
  const summary = summariseExtraction(manifest)
  options.onProgress?.(manifest, summary)
  return { manifest, summary, stopped, ...(chunkId ? { chunkId } : {}) }
}

/**
 * Runs — or resumes — every unfinished chunk. Complete chunks are never
 * re-read, failed ones only while they have attempts left.
 */
export async function runTallyExtraction(
  options: TallyExtractionOptions,
): Promise<TallyExtractionResult> {
  const maxAttempts = options.maxAttempts ?? EXTRACTION_MAX_ATTEMPTS
  const maxChunkBytes = options.maxChunkBytes ?? EXTRACTION_MAX_CHUNK_BYTES
  const wait = options.wait ?? defaultWait

  let manifest = await options.sink.load()

  while (true) {
    if (options.signal?.aborted) return finish(options, manifest, "cancelled")

    const chunk = nextChunkToRun(manifest)
    if (!chunk) return finish(options, manifest, "complete")
    if (chunk.status === "failed" && !canRetryChunk(chunk, maxAttempts)) {
      return finish(options, manifest, "attempts_exhausted", chunk.id)
    }

    const attempt = chunk.attempts + 1
    manifest = await options.sink.start({ chunkId: chunk.id, attempt })

    let payload: { xml: string; bytes: number }
    try {
      payload = await options.source.exportRange({
        company: options.company,
        mode: options.mode,
        kind: chunk.kind,
        range: chunk.range,
      })
    } catch (error) {
      const message = errorMessage(error)

      if (isSplittableExtractionError(error)) {
        try {
          const ranges = halveRange(chunk.range)
          manifest = await options.sink.split({ chunkId: chunk.id, ranges })
          progress(options, manifest)
          continue
        } catch {
          // A one-day range cannot be halved; the ceiling is real.
          manifest = await options.sink.fail({ chunkId: chunk.id, attempt, error: message })
          return finish(options, manifest, "failed", chunk.id)
        }
      }

      manifest = await options.sink.fail({ chunkId: chunk.id, attempt, error: message })
      progress(options, manifest)

      if (isTransientExtractionError(error) && attempt < maxAttempts) {
        await wait(retryDelay(attempt))
        continue
      }
      return finish(options, manifest, "failed", chunk.id)
    }

    if (payload.bytes > maxChunkBytes) {
      try {
        const ranges = halveRange(chunk.range)
        manifest = await options.sink.split({ chunkId: chunk.id, ranges })
        progress(options, manifest)
        continue
      } catch {
        manifest = await options.sink.fail({
          chunkId: chunk.id,
          attempt,
          error: "TALLY_CHUNK_TOO_LARGE",
        })
        return finish(options, manifest, "failed", chunk.id)
      }
    }

    let recorded: TallyChunkRecorded
    try {
      recorded = await options.sink.submit({
        chunkId: chunk.id,
        kind: chunk.kind,
        range: chunk.range,
        attempt,
        xml: payload.xml,
        bytes: payload.bytes,
      })
    } catch (error) {
      // The response may have been lost after the record landed, so the
      // manifest is reloaded before the chunk is called failed. A chunk that
      // is already complete stays complete and is not read again.
      try {
        manifest = await options.sink.load()
      } catch {
        // Keep the local manifest; the failure below is still recorded.
      }
      if (manifest.chunks.find((entry) => entry.id === chunk.id)?.status === "complete") {
        progress(options, manifest)
        continue
      }
      manifest = await options.sink.fail({
        chunkId: chunk.id,
        attempt,
        error: errorMessage(error),
      })
      progress(options, manifest)
      if (attempt < maxAttempts) {
        await wait(retryDelay(attempt))
        continue
      }
      return finish(options, manifest, "failed", chunk.id)
    }

    manifest = recorded.manifest
    progress(options, manifest)

    // A chunk the server could not parse or reconcile is not retried here:
    // sending the same range would return the same answer.
    if (recorded.result.status === "failed") {
      return finish(options, manifest, "failed", chunk.id)
    }
  }
}
