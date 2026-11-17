/**
 * Keeps a Tally export's staging going through a dropped connection.
 *
 * A laptop that changes networks aborts every request in flight, and a full
 * export is fifteen ~20 MB uploads, so one interruption used to stop the whole
 * set silently. Each staging step is safe to repeat: an upload target is fresh
 * per request, the signed upload overwrites, and the sources route accepts the
 * same bytes again as an idempotent retry.
 */

/** How long to wait before each new attempt when the connection drops mid-request. */
export const NETWORK_RETRY_DELAYS_MS = [2_000, 5_000, 10_000]

/** `fetch` rejects with a TypeError only when no response arrived at all. */
export function isNetworkFailure(error: unknown): boolean {
  return error instanceof TypeError
}

type Fetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
type Wait = (ms: number) => Promise<void>

const wait: Wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * `fetch`, sent again when no answer arrived. A request the server answered,
 * even with a refusal, is returned as it is and never repeated.
 */
export async function fetchRetrying(
  input: RequestInfo | URL,
  init?: RequestInit,
  options: { fetch?: Fetch; wait?: Wait; delays?: number[] } = {},
): Promise<Response> {
  const send = options.fetch ?? fetch
  const pause = options.wait ?? wait
  const delays = options.delays ?? NETWORK_RETRY_DELAYS_MS
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await send(input, init)
    } catch (error) {
      if (!isNetworkFailure(error) || attempt >= delays.length) throw error
      await pause(delays[attempt]!)
    }
  }
}

/** A chosen file the session already holds: the same name, and the same size in bytes. */
export function alreadyStaged(
  file: { name: string; size: number },
  staged: ReadonlyArray<{ fileName: string; bytes: number }>,
): boolean {
  return staged.some((entry) => entry.fileName === file.name && entry.bytes === file.size)
}
