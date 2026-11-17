import { describe, expect, it, vi } from "vitest"

import { alreadyStaged, fetchRetrying, isNetworkFailure } from "./upload-retry"

const dropped = () => new TypeError("Failed to fetch")
const noWait = async () => {}

describe("fetchRetrying", () => {
  it("sends a request again when the connection drops, then returns the answer", async () => {
    const answer = new Response("{}", { status: 200 })
    const send = vi.fn().mockRejectedValueOnce(dropped()).mockRejectedValueOnce(dropped()).mockResolvedValue(answer)
    const waits: number[] = []

    const response = await fetchRetrying("/api/admin/tally/upload-url", { method: "POST" }, {
      fetch: send,
      wait: async (ms) => void waits.push(ms),
      delays: [10, 20, 30],
    })

    expect(response).toBe(answer)
    expect(send).toHaveBeenCalledTimes(3)
    expect(waits).toEqual([10, 20])
  })

  it("never repeats a request the server answered, even with a refusal", async () => {
    const refused = new Response(JSON.stringify({ code: "TALLY_CHUNK_ALREADY_STAGED" }), { status: 409 })
    const send = vi.fn().mockResolvedValue(refused)

    const response = await fetchRetrying("/sources", { method: "POST" }, { fetch: send, wait: noWait })

    expect(response.status).toBe(409)
    expect(send).toHaveBeenCalledTimes(1)
  })

  it("gives up after its last attempt and throws the network failure", async () => {
    const send = vi.fn().mockRejectedValue(dropped())

    await expect(
      fetchRetrying("/sources", undefined, { fetch: send, wait: noWait, delays: [1, 1, 1] }),
    ).rejects.toBeInstanceOf(TypeError)
    expect(send).toHaveBeenCalledTimes(4)
  })

  it("does not retry an error that is not a dropped connection", async () => {
    const send = vi.fn().mockRejectedValue(new Error("aborted by the page"))

    await expect(fetchRetrying("/sources", undefined, { fetch: send, wait: noWait })).rejects.toThrow(
      "aborted by the page",
    )
    expect(send).toHaveBeenCalledTimes(1)
  })
})

describe("alreadyStaged", () => {
  const staged = [{ fileName: "3-daybook-20251101-20251130.xml", bytes: 14_043_235 }]

  it("recognises a file the session holds under the same name and size", () => {
    expect(alreadyStaged({ name: "3-daybook-20251101-20251130.xml", size: 14_043_235 }, staged)).toBe(true)
  })

  it("adds a file again when its size changed, so a corrected export is not skipped", () => {
    expect(alreadyStaged({ name: "3-daybook-20251101-20251130.xml", size: 14_043_000 }, staged)).toBe(false)
    expect(alreadyStaged({ name: "3-daybook-20251201-20251231.xml", size: 14_043_235 }, staged)).toBe(false)
  })
})

describe("isNetworkFailure", () => {
  it("is the TypeError fetch throws when no answer arrived", () => {
    expect(isNetworkFailure(dropped())).toBe(true)
    expect(isNetworkFailure(new Error("other"))).toBe(false)
  })
})
