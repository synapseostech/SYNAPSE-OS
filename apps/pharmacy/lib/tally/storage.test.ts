import { describe, expect, it } from "vitest"
import { ensureTallyBucket, TALLY_SOURCE_LIMIT, type TallyStorageClient } from "./storage"

function clientFor(bucket: Record<string, unknown> | null) {
  const updates: Record<string, unknown>[] = []
  const client = {
    storage: {
      getBucket: async () => ({ data: bucket, error: bucket ? null : { message: "not found" } }),
      createBucket: async () => ({ data: {}, error: null }),
      updateBucket: async (_id: string, options: Record<string, unknown>) => {
        updates.push(options)
        return { data: {}, error: null }
      },
      from: () => ({
        createSignedUploadUrl: async () => ({ data: { signedUrl: "url", token: "t" }, error: null }),
        download: async () => ({ data: null, error: null }),
        upload: async () => ({ data: {}, error: null }),
        remove: async () => ({ data: {}, error: null }),
      }),
    },
  } as unknown as TallyStorageClient
  return { client, updates }
}

describe("ensureTallyBucket", () => {
  it("lets the plan be stored in a bucket that only allowed the export types", async () => {
    const { client, updates } = clientFor({
      file_size_limit: TALLY_SOURCE_LIMIT,
      allowed_mime_types: ["application/xml", "text/csv"],
    })
    await ensureTallyBucket(client)
    expect(updates).toEqual([
      { allowedMimeTypes: ["application/xml", "text/csv", "application/json"] },
    ])
  })

  it("leaves a bucket that already takes JSON alone", async () => {
    const { client, updates } = clientFor({
      file_size_limit: TALLY_SOURCE_LIMIT,
      allowed_mime_types: ["application/xml", "application/json"],
    })
    await ensureTallyBucket(client)
    expect(updates).toHaveLength(0)
  })

  it("raises an old size cap and the type list in one call", async () => {
    const { client, updates } = clientFor({
      file_size_limit: 25 * 1024 * 1024,
      allowed_mime_types: ["application/xml"],
    })
    await ensureTallyBucket(client)
    expect(updates).toEqual([
      {
        fileSizeLimit: TALLY_SOURCE_LIMIT,
        allowedMimeTypes: ["application/xml", "application/json"],
      },
    ])
  })

  it("does not touch a bucket with no type restriction", async () => {
    const { client, updates } = clientFor({
      file_size_limit: TALLY_SOURCE_LIMIT,
      allowed_mime_types: null,
    })
    await ensureTallyBucket(client)
    expect(updates).toHaveLength(0)
  })
})
