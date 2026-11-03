/**
 * The portal's wiring for a live extraction.
 *
 * The browser cannot reach Tally directly, and the portal server cannot reach
 * the operator's machine, so the two halves meet here: the browser asks the
 * local bridge for one range, uploads it to the signed target the server
 * issues for that range, and the server decides whether the range was read.
 * The manifest the server returns is the only state the loop trusts, so a
 * reload or a retry resumes from what the server recorded.
 */

import {
  requestBridgeExport,
  type TallyBridgeMode,
  type TallyBridgePeriod,
} from "./bridge-client"
import type { TallyExtractionSummary, TallyMigrationManifest } from "./chunks"
import type { TallyEditionDisclosure, TallyEditionProblem } from "./editions"
import type { TallyConsolidationReport } from "./consolidate"
import type {
  TallyChunkRecorded,
  TallyExtractionSink,
  TallyExtractionSource,
} from "./extraction"

export class TallyLiveError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 0,
  ) {
    super(message)
    this.name = "TallyLiveError"
  }
}

async function postJson<T>(
  url: string,
  body: unknown,
  fetchImpl: typeof fetch,
): Promise<T> {
  const response = await fetchImpl(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    cache: "no-store",
  })
  const text = await response.text()
  let parsed: { error?: unknown; code?: unknown } = {}
  try {
    parsed = text ? (JSON.parse(text) as { error?: unknown; code?: unknown }) : {}
  } catch {
    // A non-JSON body keeps the HTTP status as the whole explanation.
  }
  if (!response.ok) {
    const code = typeof parsed.code === "string" ? parsed.code : `TALLY_PORTAL_HTTP_${response.status}`
    const message =
      typeof parsed.error === "string" && parsed.error
        ? parsed.error
        : `The portal returned HTTP ${response.status}.`
    throw new TallyLiveError(code, message, response.status)
  }
  return (text ? JSON.parse(text) : {}) as T
}

/** Creates a session that has no uploaded file; every chunk lands in storage. */
export async function createLiveSession(
  fetchImpl: typeof fetch = fetch,
): Promise<{ sessionId: string }> {
  return postJson("/api/admin/tally/upload-url", { source: "bridge" }, fetchImpl)
}

export async function beginLiveExtraction(
  input: {
    sessionId: string
    company: string
    mode: TallyBridgeMode
    period: TallyBridgePeriod
    parts?: number
    restart?: boolean
    /** What the bridge reported for this machine: "prime", "erp9" or "unknown". */
    edition?: string
  },
  fetchImpl: typeof fetch = fetch,
): Promise<{ manifest: TallyMigrationManifest; summary: TallyExtractionSummary }> {
  return postJson(
    `/api/admin/tally/${input.sessionId}/extract`,
    {
      action: "begin",
      company: input.company,
      mode: input.mode,
      period: input.period,
      ...(input.parts === undefined ? {} : { parts: input.parts }),
      ...(input.edition === undefined ? {} : { edition: input.edition }),
      ...(input.restart ? { restart: true } : {}),
    },
    fetchImpl,
  )
}

export type TallyLiveManifest = {
  period: { from: string; to: string }
  periodSource: "source" | "requested"
  declaredPeriod: { from: string; to: string } | null
  coverage: "verified" | "unverified"
  problems: string[]
  evidence: unknown
  manifestUpdatedAt: string
}

export type TallyLiveReview = {
  summary: unknown
  extraction: TallyExtractionSummary
  consolidation: TallyConsolidationReport
  evidence: unknown
  coverage: "verified" | "unverified"
  manifestProblems: Array<{ code: string; message: string }>
  /** Which Tally edition was read, and what that does not prove. */
  edition?: TallyEditionDisclosure
  editionProblems?: TallyEditionProblem[]
  stock: unknown
  preview: unknown
  manifest: TallyLiveManifest
}

export async function finishLiveExtraction(
  sessionId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<TallyLiveReview> {
  return postJson(`/api/admin/tally/${sessionId}/extract`, { action: "finish" }, fetchImpl)
}

/** Masters are read once; a voucher range is one date window of the history. */
export function createBridgeSource(input: {
  token: string
  baseUrl?: string
  fetchImpl?: typeof fetch
}): TallyExtractionSource {
  return {
    async exportRange({ company, mode, kind, range }) {
      const exported = await requestBridgeExport({
        token: input.token,
        mode,
        company,
        period: range,
        scope: kind === "masters" ? "masters" : "vouchers",
        ...(input.baseUrl ? { baseUrl: input.baseUrl } : {}),
        ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}),
      })
      return { xml: exported.xml, bytes: exported.bytes }
    },
  }
}

/**
 * The portal server as the extraction sink. Every call returns the manifest
 * the server just saved, never an optimistic local copy.
 */
export function createPortalSink(input: {
  sessionId: string
  fetchImpl?: typeof fetch
}): TallyExtractionSink {
  const fetchImpl = input.fetchImpl ?? fetch
  const url = `/api/admin/tally/${input.sessionId}/extract`
  const call = <T,>(body: unknown) => postJson<T>(url, body, fetchImpl)

  return {
    async load() {
      return (await call<{ manifest: TallyMigrationManifest }>({ action: "status" })).manifest
    },
    async start({ chunkId, attempt }) {
      return (
        await call<{ manifest: TallyMigrationManifest }>({ action: "start", chunkId, attempt })
      ).manifest
    },
    async submit({ chunkId, xml }) {
      // The chunk goes straight to storage: a 20 MB body would not survive the
      // host's request limit, and the server reads it back to judge it.
      const target = await call<{ signedUrl: string; path: string }>({ action: "target", chunkId })
      const put = await fetchImpl(target.signedUrl, {
        method: "PUT",
        headers: { "Content-Type": "application/xml" },
        body: xml,
      })
      if (!put.ok) {
        throw new TallyLiveError(
          "TALLY_CHUNK_UPLOAD_FAILED",
          `Chunk ${chunkId} could not be uploaded (HTTP ${put.status}).`,
          put.status,
        )
      }
      return await call<{
        manifest: TallyMigrationManifest
        result: TallyChunkRecorded["result"]
      }>({ action: "chunk", chunkId, path: target.path })
    },
    async fail({ chunkId, error }) {
      return (
        await call<{ manifest: TallyMigrationManifest }>({ action: "fail", chunkId, error })
      ).manifest
    },
    async split({ chunkId, ranges }) {
      return (
        await call<{ manifest: TallyMigrationManifest }>({
          action: "split",
          chunkId,
          ranges,
        })
      ).manifest
    },
  }
}
