/**
 * Private Storage for Tally cut-over files.
 *
 * Source exports and normalised chunks never go through a request body: Vercel
 * caps those near 4.5 MB while a Tally export can reach 50 MB. The browser
 * uploads straight to this bucket with a server-signed URL, and preview/apply
 * read the object server-side with the service role.
 */

import { PHARMACY_IMPORT_BUCKET } from "@/lib/pharmacy-storage"

export const TALLY_BUCKET = PHARMACY_IMPORT_BUCKET

/**
 * One source file's ceiling. The parser in @synapse/db caps a document at the
 * same size and the bucket enforces it on every signed upload, so the three
 * must move together or a file passes one gate and fails the next.
 */
export const TALLY_SOURCE_LIMIT = 50 * 1024 * 1024
export const TALLY_JSON_LIMIT = 20 * 1024 * 1024

export type TallySourceExtension = "xml" | "xlsx" | "xls" | "csv"

export type TallyStorageClient = {
  storage: {
    getBucket: (id: string) => PromiseLike<{ data: unknown; error: { message: string } | null }>
    createBucket: (
      id: string,
      options: Record<string, unknown>,
    ) => PromiseLike<{ data: unknown; error: { message: string } | null }>
    updateBucket: (
      id: string,
      options: Record<string, unknown>,
    ) => PromiseLike<{ data: unknown; error: { message: string } | null }>
    from: (id: string) => {
      createSignedUploadUrl: (
        path: string,
        options?: Record<string, unknown>,
      ) => PromiseLike<{
        data: { signedUrl?: string; token?: string; path?: string } | null
        error: { message: string } | null
      }>
      download: (
        path: string,
      ) => PromiseLike<{ data: Blob | null; error: { message: string } | null }>
      upload: (
        path: string,
        body: Uint8Array | ArrayBuffer | string,
        options?: Record<string, unknown>,
      ) => PromiseLike<{ data: unknown; error: { message: string } | null }>
      remove: (paths: string[]) => PromiseLike<{ data: unknown; error: { message: string } | null }>
    }
  }
}

const UUID_OK = /^[0-9a-z][0-9a-z-]{7,63}$/i
const EXTENSIONS: TallySourceExtension[] = ["xml", "xlsx", "xls", "csv"]

function segment(value: string, label: string): string {
  if (!UUID_OK.test(value) || value.includes("/") || value.includes("..")) {
    throw new Error(`TALLY_PATH_SEGMENT_INVALID: ${label}`)
  }
  return value
}

/**
 * Idempotently creates the private bucket.
 * `getBucket` is checked first so a healthy second import costs one call.
 */
export async function ensureTallyBucket(db: TallyStorageClient): Promise<void> {
  const existing = await db.storage.getBucket(TALLY_BUCKET)
  if (!existing.error) {
    // Storage applies the bucket's own cap to every signed upload, so a bucket
    // created under an older, smaller limit keeps refusing files this app now
    // accepts. Raise it once rather than making the operator re-create it.
    const bucket = existing.data as {
      file_size_limit?: number | null
      allowed_mime_types?: string[] | null
    } | null
    const current = bucket?.file_size_limit
    const raise: Record<string, unknown> = {}
    if (typeof current === "number" && current > 0 && current < TALLY_SOURCE_LIMIT) {
      raise.fileSizeLimit = TALLY_SOURCE_LIMIT
    }
    // The normalised plan is stored as JSON beside the XML sources, so a bucket
    // restricted to the export types alone accepts the upload and then refuses
    // to save the plan — every preview fails after the file was already read.
    const allowed = bucket?.allowed_mime_types
    if (Array.isArray(allowed) && allowed.length > 0 && !allowed.includes("application/json")) {
      raise.allowedMimeTypes = [...allowed, "application/json"]
    }
    if (Object.keys(raise).length > 0) {
      // A project-wide Storage limit can refuse the raise. That must not fail the
      // upload outright: the file may still fit the old cap, and Storage's own
      // error is what the browser surfaces when it does not.
      await db.storage.updateBucket(TALLY_BUCKET, raise)
    }
    return
  }

  const created = await db.storage.createBucket(TALLY_BUCKET, {
    public: false,
    fileSizeLimit: TALLY_SOURCE_LIMIT,
    allowedMimeTypes: [
      "text/xml",
      "application/xml",
      "text/csv",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "application/vnd.ms-excel",
      "application/octet-stream",
    ],
  })
  // A parallel request may have created it between the two calls.
  if (created.error && !/already exists|duplicate/i.test(created.error.message)) {
    throw new Error(`TALLY_BUCKET_UNAVAILABLE: ${created.error.message}`)
  }
}

export function tallyChunkPath(
  tenantId: string,
  sessionId: string,
  name: string,
  index?: number,
): string {
  if (!/^[a-z0-9-]{1,40}$/.test(name)) throw new Error("TALLY_CHUNK_NAME_INVALID")
  const suffix = index === undefined ? "" : `-${String(index).padStart(3, "0")}`
  return `tenants/${segment(tenantId, "tenant")}/imports/${segment(sessionId, "session")}/${name}${suffix}.json`
}

/**
 * Where one extraction chunk's raw XML is kept. The name is derived from the
 * chunk id, so a retry of the same range overwrites its own object and a second
 * tab cannot leave two payloads for one chunk.
 */
export function tallyChunkSourcePath(tenantId: string, sessionId: string, chunkId: string): string {
  const name = chunkId.toLowerCase().replace(/[^a-z0-9-]+/g, "-")
  if (!/^[a-z0-9-]{1,40}$/.test(name)) throw new Error("TALLY_CHUNK_NAME_INVALID")
  return `tenants/${segment(tenantId, "tenant")}/imports/${segment(sessionId, "session")}/chunks/${name}.xml`
}

/**
 * Where the operator's filled stock sheet is kept. It sits beside the chunks
 * but is not one of them: it adds batch expiries to the masters, and never
 * counts towards the migration's coverage.
 */
export function tallyStockSheetPath(tenantId: string, sessionId: string): string {
  return `tenants/${segment(tenantId, "tenant")}/imports/${segment(sessionId, "session")}/stock-sheet.xlsx`
}

export async function writeTallySourceBytes(
  db: TallyStorageClient,
  path: string,
  bytes: Uint8Array,
  contentType = "application/xml",
): Promise<number> {
  if (bytes.byteLength > TALLY_SOURCE_LIMIT) throw new Error("TALLY_CHUNK_TOO_LARGE")
  const { error } = await db.storage.from(TALLY_BUCKET).upload(path, bytes, {
    contentType,
    upsert: true,
  })
  if (error) throw new Error(`TALLY_CHUNK_WRITE_FAILED: ${error.message}`)
  return bytes.byteLength
}

export async function writeTallySourceText(
  db: TallyStorageClient,
  path: string,
  xml: string,
): Promise<number> {
  return writeTallySourceBytes(db, path, new TextEncoder().encode(xml))
}

export type TallyUploadTarget = {
  bucket: string
  path: string
  token: string
  signedUrl: string
}

/**
 * Where an uploaded file waits before its chunk id is known. The id is derived
 * from the file's own company and period, which only parsing can reveal, so the
 * bytes land here first and are copied to `tallyChunkSourcePath` afterwards.
 */
export function tallyStagedSourcePath(
  tenantId: string,
  sessionId: string,
  uploadId: string,
  extension: TallySourceExtension,
): string {
  if (!EXTENSIONS.includes(extension)) throw new Error("TALLY_FILE_TYPE_UNSUPPORTED")
  return `tenants/${segment(tenantId, "tenant")}/imports/${segment(sessionId, "session")}/uploads/${segment(uploadId, "upload")}.${extension}`
}

export async function createTallyStagedUploadTarget(
  db: TallyStorageClient,
  input: {
    tenantId: string
    sessionId: string
    uploadId: string
    extension: TallySourceExtension
  },
): Promise<TallyUploadTarget> {
  await ensureTallyBucket(db)
  const path = tallyStagedSourcePath(
    input.tenantId,
    input.sessionId,
    input.uploadId,
    input.extension,
  )
  const { data, error } = await db.storage.from(TALLY_BUCKET).createSignedUploadUrl(path, {
    upsert: true,
  })
  if (error || !data?.signedUrl) {
    throw new Error(`TALLY_UPLOAD_URL_FAILED: ${error?.message ?? "no signed url"}`)
  }
  return { bucket: TALLY_BUCKET, path, token: data.token ?? "", signedUrl: data.signedUrl }
}

/**
 * A signed URL the browser PUTs one chunk's XML to, so a 20 MB payload never
 * travels through a request body the hosting platform caps near 4.5 MB.
 */
export async function createTallyChunkUploadTarget(
  db: TallyStorageClient,
  input: { tenantId: string; sessionId: string; chunkId: string },
): Promise<TallyUploadTarget> {
  await ensureTallyBucket(db)
  const path = tallyChunkSourcePath(input.tenantId, input.sessionId, input.chunkId)
  const { data, error } = await db.storage.from(TALLY_BUCKET).createSignedUploadUrl(path, {
    upsert: true,
  })
  if (error || !data?.signedUrl) {
    throw new Error(`TALLY_UPLOAD_URL_FAILED: ${error?.message ?? "no signed url"}`)
  }
  return { bucket: TALLY_BUCKET, path, token: data.token ?? "", signedUrl: data.signedUrl }
}

export async function readTallySource(
  db: TallyStorageClient,
  path: string,
  limit = TALLY_SOURCE_LIMIT,
): Promise<Uint8Array> {
  const { data, error } = await db.storage.from(TALLY_BUCKET).download(path)
  if (error || !data) throw new Error(`TALLY_FILE_MISSING: ${error?.message ?? path}`)
  const bytes = new Uint8Array(await data.arrayBuffer())
  if (bytes.byteLength === 0) throw new Error("MIGRATION_EMPTY_FILE")
  if (bytes.byteLength > limit) throw new Error("MIGRATION_FILE_TOO_LARGE")
  return bytes
}

export async function writeTallyJson(
  db: TallyStorageClient,
  path: string,
  value: unknown,
): Promise<void> {
  const body = JSON.stringify(value)
  if (body.length > TALLY_JSON_LIMIT) throw new Error("TALLY_CHUNK_TOO_LARGE")
  const { error } = await db.storage.from(TALLY_BUCKET).upload(path, body, {
    contentType: "application/json",
    upsert: true,
  })
  if (error) throw new Error(`TALLY_CHUNK_WRITE_FAILED: ${error.message}`)
}

export async function readTallyJson<T>(
  db: TallyStorageClient,
  path: string,
): Promise<T | null> {
  const { data, error } = await db.storage.from(TALLY_BUCKET).download(path)
  if (error || !data) return null
  const text = await data.text()
  if (!text) return null
  try {
    return JSON.parse(text) as T
  } catch {
    return null
  }
}
