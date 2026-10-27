/**
 * Private Storage for Tally cut-over files.
 *
 * Source exports and normalised chunks never go through a request body: Vercel
 * caps those near 4.5 MB while a Tally export can reach 25 MB. The browser
 * uploads straight to this bucket with a server-signed URL, and preview/apply
 * read the object server-side with the service role.
 */

export const TALLY_BUCKET = "pharmacy-imports"
export const TALLY_SOURCE_LIMIT = 25 * 1024 * 1024
export const TALLY_JSON_LIMIT = 20 * 1024 * 1024

export type TallySourceExtension = "xml" | "xlsx" | "csv"

export type TallyStorageClient = {
  storage: {
    getBucket: (id: string) => PromiseLike<{ data: unknown; error: { message: string } | null }>
    createBucket: (
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
const EXTENSIONS: TallySourceExtension[] = ["xml", "xlsx", "csv"]

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
  if (!existing.error) return

  const created = await db.storage.createBucket(TALLY_BUCKET, {
    public: false,
    fileSizeLimit: TALLY_SOURCE_LIMIT,
    allowedMimeTypes: [
      "text/xml",
      "application/xml",
      "text/csv",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "application/octet-stream",
    ],
  })
  // A parallel request may have created it between the two calls.
  if (created.error && !/already exists|duplicate/i.test(created.error.message)) {
    throw new Error(`TALLY_BUCKET_UNAVAILABLE: ${created.error.message}`)
  }
}

export function tallySourcePath(
  tenantId: string,
  sessionId: string,
  extension: TallySourceExtension,
): string {
  if (!EXTENSIONS.includes(extension)) throw new Error("TALLY_FILE_TYPE_UNSUPPORTED")
  return `tenants/${segment(tenantId, "tenant")}/imports/${segment(sessionId, "session")}/source.${extension}`
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

export type TallyUploadTarget = {
  bucket: string
  path: string
  token: string
  signedUrl: string
}

export async function createTallyUploadTarget(
  db: TallyStorageClient,
  input: { tenantId: string; sessionId: string; extension: TallySourceExtension },
): Promise<TallyUploadTarget> {
  await ensureTallyBucket(db)
  const path = tallySourcePath(input.tenantId, input.sessionId, input.extension)
  const { data, error } = await db.storage.from(TALLY_BUCKET).createSignedUploadUrl(path, {
    upsert: true,
  })
  if (error || !data?.signedUrl) {
    throw new Error(`TALLY_UPLOAD_URL_FAILED: ${error?.message ?? "no signed url"}`)
  }
  return {
    bucket: TALLY_BUCKET,
    path,
    token: data.token ?? "",
    signedUrl: data.signedUrl,
  }
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
