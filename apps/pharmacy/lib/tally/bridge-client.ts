/**
 * The browser's side of the local Tally bridge.
 *
 * Every export states the period it wants and the company it expects, and then
 * checks that the bridge echoes both back. A bridge left running with the
 * dates it was launched with, or a proxy that strips the echo headers, cannot
 * silently hand back another range: without a matching echo the payload is
 * refused rather than uploaded as if it covered what the operator asked for.
 */

export const BRIDGE_BASE_URL = "http://127.0.0.1:17890"
export const BRIDGE_MAX_BYTES = 25 * 1024 * 1024
export const BRIDGE_DEFAULT_FROM_DATE = "19000101"

export type TallyBridgeMode = "opening" | "closing"
/** Which part of the books one request reads. */
export type TallyBridgeScope = "all" | "masters" | "vouchers"
/** ISO calendar days, as the portal states them. */
export type TallyBridgePeriod = { from: string; to: string }

export type TallyBridgeExport = {
  xml: string
  bytes: number
  company: string
  period: TallyBridgePeriod
  mode: TallyBridgeMode
  scope: TallyBridgeScope
}

export type TallyBridgeStatus = {
  tally: "reachable" | "unreachable"
  edition: string
  company: string | null
  period: TallyBridgePeriod & { from: string; to: string }
  companies?: string[]
}

export class TallyBridgeError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 0,
  ) {
    super(message)
    this.name = "TallyBridgeError"
  }
}

const MESSAGES: Record<string, string> = {
  TALLY_BRIDGE_PERIOD_NOT_REQUESTED:
    "Enter the period the export should cover before connecting.",
  TALLY_BRIDGE_PERIOD_MISMATCH:
    "The bridge exported a different period from the one asked for. Copy the bridge command again and restart it, then retry.",
  TALLY_BRIDGE_PERIOD_UNVERIFIED:
    "The bridge did not report which period it exported, so the file cannot be matched to your request. Update and restart the bridge, then retry.",
  TALLY_BRIDGE_COMPANY_MISMATCH:
    "The bridge exported a different company from the one selected.",
  TALLY_BRIDGE_MODE_MISMATCH:
    "The bridge exported a different mode from the one selected.",
  TALLY_BRIDGE_SCOPE_MISMATCH:
    "The bridge returned a different part of the books from the one requested.",
  TALLY_BRIDGE_SCOPE_UNVERIFIED:
    "The bridge did not report which part of the books it exported. Update and restart the bridge, then retry.",
  TALLY_BRIDGE_SCOPE_INVALID:
    "The bridge does not understand the requested export scope. Update and restart the bridge.",
  TALLY_BRIDGE_EXPORT_TOO_LARGE:
    "Tally exported more than the 25 MB import limit. Narrow the period and extract in chunks.",
  TALLY_BRIDGE_COMPANIES_EMPTY:
    "Tally returned no open companies. Open the company in Tally and retry.",
}

function codeMessage(code: string): string {
  return MESSAGES[code] ?? code
}

/** `YYYY-MM-DD` to the compact form Tally and the bridge exchange. */
export function compactTallyDate(value: string): string {
  const iso = value.trim()
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso)
  if (!match) throw new TallyBridgeError("TALLY_BRIDGE_PERIOD_INVALID", codeMessage("TALLY_BRIDGE_PERIOD_INVALID"))
  return `${match[1]}${match[2]}${match[3]}`
}

function isoFromCompact(value: string): string {
  if (!/^\d{8}$/.test(value)) {
    throw new TallyBridgeError("TALLY_BRIDGE_PERIOD_UNVERIFIED", codeMessage("TALLY_BRIDGE_PERIOD_UNVERIFIED"))
  }
  return `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`
}

/**
 * The period a bridge command built from these fields would run with. The
 * command omits the variables when blank, so the bridge's own defaults apply.
 */
export function bridgePeriodFromFields(
  fromDate: string,
  toDate: string,
  today = new Date(),
): TallyBridgePeriod {
  const compact = /^\d{8}$/.test(fromDate.trim())
    ? fromDate.trim()
    : BRIDGE_DEFAULT_FROM_DATE
  const end = /^\d{8}$/.test(toDate.trim())
    ? toDate.trim()
    : [
        String(today.getFullYear()).padStart(4, "0"),
        String(today.getMonth() + 1).padStart(2, "0"),
        String(today.getDate()).padStart(2, "0"),
      ].join("")
  return { from: isoFromCompact(compact), to: isoFromCompact(end) }
}

function headerText(headers: Headers, name: string): string {
  return (headers.get(name) ?? "").trim()
}

async function bridgeError(response: Response): Promise<TallyBridgeError> {
  let code = ""
  try {
    const body = (await response.json()) as { error?: unknown }
    if (typeof body.error === "string") code = body.error
  } catch {
    // A non-JSON answer keeps the explicit status in the message below.
  }
  return new TallyBridgeError(
    code || `TALLY_BRIDGE_HTTP_${response.status}`,
    code ? codeMessage(code) : `The Tally Bridge returned HTTP ${response.status}.`,
    response.status,
  )
}

export type BridgeExportRequest = {
  token: string
  mode: TallyBridgeMode
  company: string
  period?: TallyBridgePeriod
  scope?: TallyBridgeScope
  baseUrl?: string
  fetchImpl?: typeof fetch
}

/**
 * Runs one export and refuses it unless the bridge echoes exactly the period,
 * company, mode and scope that were requested.
 */
export async function requestBridgeExport(input: BridgeExportRequest): Promise<TallyBridgeExport> {
  if (!input.period) {
    throw new TallyBridgeError(
      "TALLY_BRIDGE_PERIOD_NOT_REQUESTED",
      codeMessage("TALLY_BRIDGE_PERIOD_NOT_REQUESTED"),
    )
  }
  const scope: TallyBridgeScope =
    input.scope ?? (input.mode === "closing" ? "masters" : "all")
  const fetchImpl = input.fetchImpl ?? fetch
  const base = (input.baseUrl ?? BRIDGE_BASE_URL).replace(/\/+$/, "")
  const query = new URLSearchParams({
    mode: input.mode,
    scope,
    from: compactTallyDate(input.period.from),
    to: compactTallyDate(input.period.to),
  })
  if (input.company.trim()) query.set("company", input.company.trim())

  const response = await fetchImpl(`${base}/api/tally/export?${query.toString()}`, {
    method: "POST",
    headers: { "x-synapse-tally-bridge-token": input.token.trim() },
    cache: "no-store",
  })
  if (!response.ok) throw await bridgeError(response)

  const echoedFrom = headerText(response.headers, "x-synapse-tally-from")
  const echoedTo = headerText(response.headers, "x-synapse-tally-to")
  const echoedCompany = headerText(response.headers, "x-synapse-tally-company")
  const echoedMode = headerText(response.headers, "x-synapse-tally-mode")
  const echoedScope = headerText(response.headers, "x-synapse-tally-scope")

  if (!echoedFrom || !echoedTo) {
    throw new TallyBridgeError(
      "TALLY_BRIDGE_PERIOD_UNVERIFIED",
      codeMessage("TALLY_BRIDGE_PERIOD_UNVERIFIED"),
    )
  }

  const period = { from: isoFromCompact(echoedFrom), to: isoFromCompact(echoedTo) }
  if (period.from !== input.period.from || period.to !== input.period.to) {
    throw new TallyBridgeError(
      "TALLY_BRIDGE_PERIOD_MISMATCH",
      codeMessage("TALLY_BRIDGE_PERIOD_MISMATCH"),
    )
  }
  if (input.company.trim() && echoedCompany.toLowerCase() !== input.company.trim().toLowerCase()) {
    throw new TallyBridgeError(
      "TALLY_BRIDGE_COMPANY_MISMATCH",
      codeMessage("TALLY_BRIDGE_COMPANY_MISMATCH"),
    )
  }
  if (echoedMode !== input.mode) {
    throw new TallyBridgeError("TALLY_BRIDGE_MODE_MISMATCH", codeMessage("TALLY_BRIDGE_MODE_MISMATCH"))
  }
  if (!echoedScope) {
    throw new TallyBridgeError("TALLY_BRIDGE_SCOPE_UNVERIFIED", codeMessage("TALLY_BRIDGE_SCOPE_UNVERIFIED"))
  }
  if (echoedScope !== scope) {
    throw new TallyBridgeError("TALLY_BRIDGE_SCOPE_MISMATCH", codeMessage("TALLY_BRIDGE_SCOPE_MISMATCH"))
  }

  const declared = Number(response.headers.get("content-length"))
  if (Number.isFinite(declared) && declared > BRIDGE_MAX_BYTES) {
    throw new TallyBridgeError(
      "TALLY_BRIDGE_EXPORT_TOO_LARGE",
      codeMessage("TALLY_BRIDGE_EXPORT_TOO_LARGE"),
      413,
    )
  }
  const xml = await response.text()
  const bytes = new TextEncoder().encode(xml).byteLength
  if (bytes > BRIDGE_MAX_BYTES) {
    throw new TallyBridgeError(
      "TALLY_BRIDGE_EXPORT_TOO_LARGE",
      codeMessage("TALLY_BRIDGE_EXPORT_TOO_LARGE"),
      413,
    )
  }

  return {
    xml,
    bytes,
    company: echoedCompany,
    period,
    mode: echoedMode as TallyBridgeMode,
    scope: echoedScope as TallyBridgeScope,
  }
}

export async function requestBridgeStatus(input: {
  token: string
  baseUrl?: string
  fetchImpl?: typeof fetch
}): Promise<TallyBridgeStatus> {
  const fetchImpl = input.fetchImpl ?? fetch
  const base = (input.baseUrl ?? BRIDGE_BASE_URL).replace(/\/+$/, "")
  const response = await fetchImpl(`${base}/api/tally/status`, {
    headers: { "x-synapse-tally-bridge-token": input.token.trim() },
    cache: "no-store",
  })
  if (!response.ok) throw await bridgeError(response)
  return (await response.json()) as TallyBridgeStatus
}

export async function requestBridgeCompanies(input: {
  token: string
  baseUrl?: string
  fetchImpl?: typeof fetch
}): Promise<{ companies: string[]; edition: string }> {
  const fetchImpl = input.fetchImpl ?? fetch
  const base = (input.baseUrl ?? BRIDGE_BASE_URL).replace(/\/+$/, "")
  const response = await fetchImpl(`${base}/api/tally/companies`, {
    headers: { "x-synapse-tally-bridge-token": input.token.trim() },
    cache: "no-store",
  })
  if (!response.ok) throw await bridgeError(response)
  return (await response.json()) as { companies: string[]; edition: string }
}
