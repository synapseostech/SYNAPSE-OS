import { timingSafeEqual } from "node:crypto"
import { spawn } from "node:child_process"
import { existsSync } from "node:fs"
import { createConnection, isIP } from "node:net"
import { createServer } from "node:http"
import {
  runPreflight,
  TALLY_BRIDGE_CONTRACT_VERSION,
  TALLY_CONNECTOR_VERSION,
} from "./preflight.mjs"

export const TALLY_BRIDGE_PORT = 17890
/**
 * The bridge is never bound anywhere else. The setup assistant checks this
 * value rather than trusting an environment variable, so a connector that has
 * been opened to the LAN fails the check instead of reporting itself ready.
 */
export const TALLY_BRIDGE_BIND_HOST = "127.0.0.1"
export const TALLY_HTTP_PORT = 9000
export const MAX_TALLY_EXPORT_BYTES = 25 * 1024 * 1024
export const TALLY_EXPORT_TIMEOUT_MS = 60_000
export const DEFAULT_TALLY_FROM_DATE = "19000101"
export const MAX_TALLY_COMPANIES = 500

const REPORTS = ["All Masters", "Day Book"]

// Tally installs to a different folder per edition, so the executable path is
// the only signal available before anything is running.
export const TALLY_DEFAULT_EXECUTABLES = [
  { edition: "prime", executable: "C:\\Program Files\\TallyPrime\\tally.exe" },
  { edition: "prime", executable: "C:\\Program Files (x86)\\TallyPrime\\tally.exe" },
  { edition: "erp9", executable: "C:\\Tally.ERP9\\tally.exe" },
  { edition: "erp9", executable: "C:\\Program Files\\Tally.ERP9\\tally.exe" },
]

function isPrivateTarget(hostname) {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "")
  if (host === "localhost") return true
  const ipVersion = isIP(host)
  if (ipVersion === 6) {
    return host === "::1" || host.startsWith("fc") || host.startsWith("fd")
  }
  if (ipVersion !== 4) return false
  const [first, second] = host.split(".").map(Number)
  return first === 10 ||
    first === 127 ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168)
}

function validTallyDate(value, label) {
  if (!/^\d{8}$/.test(value)) throw new Error(`TALLY_BRIDGE_${label}_INVALID`)
  const year = Number(value.slice(0, 4))
  const month = Number(value.slice(4, 6))
  const day = Number(value.slice(6, 8))
  const date = new Date(Date.UTC(year, month - 1, day))
  if (
    Number.isNaN(date.getTime()) ||
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    throw new Error(`TALLY_BRIDGE_${label}_INVALID`)
  }
  return value
}

/** Accepts the two forms Tally and the portal each use, and stores YYYYMMDD. */
function tallyDateFromQuery(value, label) {
  const match = /^(\d{4})-?(\d{2})-?(\d{2})$/.exec(String(value ?? "").trim())
  if (!match) throw new Error(`TALLY_BRIDGE_${label}_INVALID`)
  return validTallyDate(`${match[1]}${match[2]}${match[3]}`, label)
}

/**
 * The period a single export request asks for. The process environment is a
 * fallback for callers that predate per-request dates; a request that states
 * only one bound is refused rather than half-applied, because silently filling
 * the other bound in would export a range nobody asked for.
 */
export function readRequestedPeriod(searchParams) {
  const from = searchParams.get("from")
  const to = searchParams.get("to")
  if (from === null && to === null) return undefined
  if (!from || !to) throw new Error("TALLY_BRIDGE_PERIOD_INCOMPLETE")
  const fromDate = tallyDateFromQuery(from, "FROM_DATE")
  const toDate = tallyDateFromQuery(to, "TO_DATE")
  if (toDate < fromDate) throw new Error("TALLY_BRIDGE_PERIOD_INVALID")
  return { fromDate, toDate }
}

function currentTallyDate(now) {
  return [
    String(now.getFullYear()).padStart(4, "0"),
    String(now.getMonth() + 1).padStart(2, "0"),
    String(now.getDate()).padStart(2, "0"),
  ].join("")
}

/** The period actually sent to Tally: the request's, else the launch default. */
export function resolveExportPeriod(config, now, requested) {
  if (requested) return { ...requested }
  return {
    fromDate: config.fromDate,
    toDate: config.toDate || currentTallyDate(now),
  }
}

/**
 * A request may name the company again; it must agree with the pin. Naming one
 * when nothing is pinned is refused, and an unpinned bridge still fails later
 * because no payload can be verified against it.
 */
export function resolveRequestedCompany(config, searchParams) {
  const pinned = String(config.company ?? "").trim()
  const requested = String(searchParams.get("company") ?? "").trim()
  if (!requested) return pinned
  if (!pinned) throw new Error("TALLY_BRIDGE_COMPANY_UNPINNED")
  if (requested.toLowerCase() !== pinned.toLowerCase()) {
    throw new Error("TALLY_BRIDGE_COMPANY_MISMATCH")
  }
  return pinned
}

const EXPORT_SCOPES = ["all", "masters", "vouchers"]

/**
 * What part of the books one export covers. `masters` is read once per
 * migration, `vouchers` once per date chunk; `all` keeps the single-file
 * behaviour. The bridge states the scope it served in an echo header, so a
 * chunk that asked for vouchers can never be recorded as masters or the reverse.
 */
export function readRequestedScope(searchParams, closingOnly) {
  const raw = String(searchParams.get("scope") ?? "").trim().toLowerCase()
  const scope = raw || (closingOnly ? "masters" : "all")
  if (!EXPORT_SCOPES.includes(scope)) throw new Error("TALLY_BRIDGE_SCOPE_INVALID")
  if (closingOnly && scope === "vouchers") throw new Error("TALLY_BRIDGE_SCOPE_CONFLICT")
  return scope
}

function parsePort(value, fallback, label) {
  const port = value === undefined || value === "" ? fallback : Number(value)
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`TALLY_BRIDGE_${label}_INVALID`)
  }
  return port
}

export function readBridgeConfig(env = process.env) {
  const token = env.SYNAPSE_TALLY_BRIDGE_TOKEN?.trim() ?? ""
  if (!/^[\da-f]{64}$/i.test(token)) {
    throw new Error("SYNAPSE_TALLY_BRIDGE_TOKEN must be 64 hexadecimal characters.")
  }

  const allowedOrigins = (env.SYNAPSE_TALLY_ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean)

  if (allowedOrigins.length === 0) {
    throw new Error("SYNAPSE_TALLY_ALLOWED_ORIGINS must contain the pharmacy portal origin.")
  }
  for (const origin of allowedOrigins) {
    let parsed
    try {
      parsed = new URL(origin)
    } catch {
      throw new Error(`Invalid allowed portal origin: ${origin}`)
    }
    if (
      parsed.origin !== origin ||
      !["http:", "https:"].includes(parsed.protocol) ||
      (parsed.protocol === "http:" && !["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname))
    ) {
      throw new Error(`Allowed portal origin must be an exact HTTPS origin: ${origin}`)
    }
  }

  const tallyHost = (env.SYNAPSE_TALLY_TARGET_HOST ?? "127.0.0.1").trim()
  if (!isPrivateTarget(tallyHost)) {
    throw new Error("SYNAPSE_TALLY_TARGET_HOST must be localhost or a private LAN IP address.")
  }
  const tallyPort = parsePort(env.SYNAPSE_TALLY_TARGET_PORT, TALLY_HTTP_PORT, "TARGET_PORT")
  const tallyUrl = new URL(`http://${tallyHost.includes(":") ? `[${tallyHost}]` : tallyHost}:${tallyPort}`)

  return {
    token,
    allowedOrigins: new Set(allowedOrigins),
    tallyUrl,
    bridgePort: parsePort(env.SYNAPSE_TALLY_BRIDGE_PORT, TALLY_BRIDGE_PORT, "BRIDGE_PORT"),
    bridgeBindHost: TALLY_BRIDGE_BIND_HOST,
    company: env.SYNAPSE_TALLY_COMPANY?.trim() ?? "",
    tallyExecutable: env.SYNAPSE_TALLY_EXECUTABLE?.trim() ?? "",
    fromDate: validTallyDate(
      env.SYNAPSE_TALLY_FROM_DATE ?? DEFAULT_TALLY_FROM_DATE,
      "FROM_DATE",
    ),
    toDate: env.SYNAPSE_TALLY_TO_DATE ? validTallyDate(env.SYNAPSE_TALLY_TO_DATE, "TO_DATE") : "",
  }
}

function escapeXml(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;")
}

export function tallyEditionFromExecutable(executable) {
  const path = String(executable ?? "").toLowerCase().replaceAll("/", "\\")
  if (path.includes("\\tallyprime\\")) return "prime"
  if (path.includes("\\tally.erp9\\") || path.includes("\\tally.erp 9\\")) return "erp9"
  return "unknown"
}

export function detectTallyInstallations({ exists = existsSync } = {}) {
  return TALLY_DEFAULT_EXECUTABLES.filter((entry) => exists(entry.executable))
}

const NAMED_XML_ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" }

function decodeXmlText(value) {
  return value
    .replace(/&#x([0-9a-f]{1,6});/gi, (_, hex) => xmlCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d{1,7});/g, (_, dec) => xmlCodePoint(Number.parseInt(dec, 10)))
    .replace(/&(amp|lt|gt|quot|apos);/g, (_, name) => NAMED_XML_ENTITIES[name])
    .replace(/\s+/g, " ")
    .trim()
}

function xmlCodePoint(code) {
  return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : ""
}

/**
 * Tally answers a company list with either a NAME attribute on COMPANY or a
 * COMPANYNAME child, depending on the build, so both are read.
 */
export function parseTallyCompanyNames(xml) {
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) {
    throw new Error("TALLY_BRIDGE_COMPANIES_UNSAFE_XML")
  }
  const status = /<STATUS>\s*([01])\s*<\/STATUS>/i.exec(xml)?.[1]
  if (status !== "1") {
    throw new Error(
      status === "0"
        ? "TALLY_BRIDGE_COMPANIES_REJECTED"
        : "TALLY_BRIDGE_COMPANIES_STATUS_MISSING",
    )
  }
  const data = /<DATA(?:\s[^>]*)?>([\s\S]*?)<\/DATA>/i.exec(xml)?.[1]
  if (!data?.trim()) throw new Error("TALLY_BRIDGE_COMPANIES_EMPTY")

  const names = new Set()
  for (const match of data.matchAll(/<COMPANY\b[^>]*?\bNAME="([^"]{1,400})"/gi)) {
    const name = decodeXmlText(match[1])
    if (name) names.add(name)
  }
  for (const match of data.matchAll(/<COMPANYNAME>([^<]{1,400})<\/COMPANYNAME>/gi)) {
    const name = decodeXmlText(match[1])
    if (name) names.add(name)
  }
  if (names.size === 0) throw new Error("TALLY_BRIDGE_COMPANIES_EMPTY")
  return [...names].slice(0, MAX_TALLY_COMPANIES)
}

export function buildTallyCompanyListRequest() {
  return [
    "<ENVELOPE>",
    "<HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Collection</TYPE>",
    "<ID>List of Companies</ID></HEADER>",
    "<BODY><DESC><STATICVARIABLES>",
    "<SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>",
    "</STATICVARIABLES>",
    "<TDL><TDLMESSAGE>",
    '<COLLECTION NAME="List of Companies" ISMODIFY="No" ISFIXED="No" ISINITIALIZE="No" ISOPTION="No" ISINTERNAL="No">',
    "<TYPE>Company</TYPE>",
    "<NATIVEMETHOD>Name</NATIVEMETHOD>",
    "</COLLECTION>",
    "</TDLMESSAGE></TDL>",
    "</DESC></BODY></ENVELOPE>",
  ].join("")
}

export function buildTallyExportRequest(report, { company, fromDate, toDate }) {
  if (!REPORTS.includes(report)) throw new Error("TALLY_BRIDGE_REPORT_UNSUPPORTED")
  const companyTag = company
    ? `<SVCURRENTCOMPANY>${escapeXml(company)}</SVCURRENTCOMPANY>`
    : ""
  // Masters carry the period too: Tally only reports each ledger's and stock
  // item's closing balance when SVTODATE is part of the request, and a
  // balances-only cut-over has nothing to read without it.
  const dateTags = `<SVFROMDATE>${validTallyDate(fromDate, "FROM_DATE")}</SVFROMDATE><SVTODATE>${validTallyDate(toDate, "TO_DATE")}</SVTODATE>`

  return [
    "<ENVELOPE>",
    "<HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>DATA</TYPE>",
    `<ID>${report}</ID></HEADER>`,
    "<BODY><DESC><STATICVARIABLES>",
    companyTag,
    dateTags,
    "<SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT>",
    "</STATICVARIABLES></DESC></BODY></ENVELOPE>",
  ].join("")
}

async function readResponseText(response) {
  const declaredLength = Number(response.headers.get("content-length"))
  if (Number.isFinite(declaredLength) && declaredLength > MAX_TALLY_EXPORT_BYTES) {
    throw new Error("TALLY_BRIDGE_EXPORT_TOO_LARGE")
  }

  const decode = (bytes) => {
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(bytes)
    } catch {
      throw new Error("TALLY_BRIDGE_RESPONSE_NOT_UTF8")
    }
  }

  const reader = response.body?.getReader()
  if (!reader) {
    const bytes = Buffer.from(await response.arrayBuffer())
    if (bytes.byteLength > MAX_TALLY_EXPORT_BYTES) throw new Error("TALLY_BRIDGE_EXPORT_TOO_LARGE")
    return decode(bytes)
  }

  const chunks = []
  let total = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > MAX_TALLY_EXPORT_BYTES) {
      await reader.cancel()
      throw new Error("TALLY_BRIDGE_EXPORT_TOO_LARGE")
    }
    chunks.push(value)
  }
  return decode(Buffer.concat(chunks))
}

function extractData(responseText, report, { allowEmpty = false } = {}) {
  if (/<!DOCTYPE|<!ENTITY/i.test(responseText)) {
    throw new Error(`TALLY_BRIDGE_${report.toUpperCase().replaceAll(" ", "_")}_UNSAFE_XML`)
  }
  const status = /<STATUS>\s*([01])\s*<\/STATUS>/i.exec(responseText)?.[1]
  if (status !== "1") {
    throw new Error(
      status === "0"
        ? `TALLY_BRIDGE_${report.toUpperCase().replaceAll(" ", "_")}_REJECTED`
        : `TALLY_BRIDGE_${report.toUpperCase().replaceAll(" ", "_")}_STATUS_MISSING`,
    )
  }
  const data = /<DATA(?:\s[^>]*)?>([\s\S]*?)<\/DATA>/i.exec(responseText)?.[1]
  if (data !== undefined && !data.trim() && allowEmpty) {
    // A narrowed voucher range may legitimately hold no voucher. Tally saying
    // so with an empty DATA element is an empty range, not a lost response; a
    // missing DATA element is still refused below.
    return ""
  }
  if (!data?.trim()) {
    throw new Error(`TALLY_BRIDGE_${report.toUpperCase().replaceAll(" ", "_")}_EMPTY`)
  }
  return data
}

/**
 * Tally answers with the company it actually used. If that is not the pinned
 * company — the name was not loaded, or someone switched company mid-run — the
 * payload is another business's books and must not reach the import.
 *
 * A response that names no company cannot be checked, and an unchecked payload
 * is indistinguishable from another company's books, so it is refused rather
 * than let through. That makes these reports unusable on any Tally build that
 * omits the company element; tally-probe.ps1 reports which builds do, so the
 * requirement is checked against a real installation rather than assumed.
 */
function assertPinnedCompany(xml, expected) {
  if (!expected) throw new Error("TALLY_BRIDGE_COMPANY_UNPINNED")
  const raw =
    /<COMPANY\b[^>]*?\bNAME="([^"]{1,400})"/i.exec(xml)?.[1] ??
    /<COMPANYNAME>([^<]{1,400})<\/COMPANYNAME>/i.exec(xml)?.[1]
  if (raw === undefined) throw new Error("TALLY_BRIDGE_COMPANY_UNVERIFIED")
  if (decodeXmlText(raw).toLowerCase() !== expected.trim().toLowerCase()) {
    throw new Error("TALLY_BRIDGE_COMPANY_MISMATCH")
  }
}

/**
 * Tally refusing a report — a STATUS of 0, a missing STATUS, a DOCTYPE — is
 * found while the export is built, and none of those answers names a company.
 * So the build has to run first. Checked the other way round, every refusal
 * would surface as COMPANY_UNVERIFIED and neither the operator's toast nor the
 * server-side log line would say what Tally actually answered.
 */
function checkedExport(xml, pinned, build) {
  const payload = build()
  assertPinnedCompany(xml, pinned)
  return payload
}

const COMPANY_MARKER = /<(?:COMPANY|COMPANYNAME)\b/i
const TALLY_DATE_ECHO = /^\d{8}$|^\d{4}-\d{2}-\d{2}$/

/**
 * Tally builds differ on where the company element sits. `packageExport` keeps
 * only `<DATA>` content, so a company stated in the envelope would be dropped
 * and the import could no longer say which books it came from.
 *
 * Only the pinned name is re-emitted, never the name the response carried, and
 * only dates the response itself echoed — a period the source did not state is
 * not evidence and must not be manufactured from the request.
 */
function echoedDate(xml, tag) {
  const raw = new RegExp(`<${tag}>\\s*([^<]{1,20}?)\\s*</${tag}>`, "i").exec(xml)?.[1]
  return raw && TALLY_DATE_ECHO.test(raw) ? raw : undefined
}

function companyElement(xml, expected) {
  const name = String(expected ?? "").trim()
  if (!name) return ""
  const from = echoedDate(xml, "SVFROMDATE")
  const to = echoedDate(xml, "SVTODATE")
  const dates = `${from ? `<SVFROMDATE>${from}</SVFROMDATE>` : ""}${to ? `<SVTODATE>${to}</SVTODATE>` : ""}`
  return `<COMPANY NAME="${escapeXml(name)}"><COMPANYNAME>${escapeXml(name)}</COMPANYNAME>${dates}</COMPANY>`
}

function packageExport(masters, vouchers, company) {
  const combined = `<ENVELOPE><HEADER><VERSION>1</VERSION><STATUS>1</STATUS></HEADER><BODY><DATA>${company}${masters}${vouchers}</DATA></BODY></ENVELOPE>`

  if (Buffer.byteLength(combined) > MAX_TALLY_EXPORT_BYTES) {
    throw new Error("TALLY_BRIDGE_EXPORT_TOO_LARGE")
  }
  if (!/<(?:COMPANY|LEDGER|STOCKITEM|GROUP|VOUCHER)\b/i.test(combined)) {
    throw new Error("TALLY_BRIDGE_NO_IMPORTABLE_RECORDS")
  }
  return combined
}

export function combineTallyExports(masterXml, voucherXml, { company } = {}) {
  const masters = extractData(masterXml, "All Masters")
  const vouchers = extractData(voucherXml, "Day Book")
  const carried = COMPANY_MARKER.test(masters) ? "" : companyElement(masterXml, company)
  return packageExport(masters, vouchers, carried)
}

/**
 * A balances-only cut-over never posts a voucher, so the Day Book is not
 * fetched at all. A multi-year history can exceed the 25 MB ceiling on its own,
 * and downloading it only to discard it would fail the cut-over for no reason.
 */
export function buildMasterOnlyExport(masterXml, { company } = {}) {
  const masters = extractData(masterXml, "All Masters")
  const carried = COMPANY_MARKER.test(masters) ? "" : companyElement(masterXml, company)
  return packageExport(masters, "", carried)
}

/**
 * One voucher range on its own, so a long history can be read chunk by chunk
 * without re-reading the masters each time. An empty range is a real answer and
 * is carried as an empty document rather than raised as a failed export; the
 * pinned company element keeps the payload attributable to these books.
 */
export function buildVoucherOnlyExport(voucherXml, { company } = {}) {
  const vouchers = extractData(voucherXml, "Day Book", { allowEmpty: true })
  const carried = COMPANY_MARKER.test(vouchers) ? "" : companyElement(voucherXml, company)
  return packageExport("", vouchers, carried)
}

async function postTallyXml(fetchImpl, config, body) {
  let response
  try {
    response = await fetchImpl(config.tallyUrl, {
      method: "POST",
      headers: {
        "content-type": "text/xml; charset=utf-8",
        accept: "text/xml",
      },
      body,
      signal: AbortSignal.timeout(TALLY_EXPORT_TIMEOUT_MS),
      redirect: "error",
    })
  } catch (error) {
    if (error instanceof Error && error.name === "TimeoutError") {
      throw new Error("TALLY_BRIDGE_TALLY_TIMEOUT")
    }
    if (error instanceof TypeError) {
      throw new Error("TALLY_BRIDGE_TALLY_UNAVAILABLE")
    }
    throw error
  }
  if (!response.ok) throw new Error(`TALLY_BRIDGE_TALLY_HTTP_${response.status}`)
  try {
    return await readResponseText(response)
  } catch (error) {
    // The timeout stays armed while the body streams. Node reports that abort
    // on the reader rather than fetch's promise, so without this it reaches the
    // operator as an unlabelled internal error.
    if (error && (error.name === "TimeoutError" || error.name === "AbortError")) {
      throw new Error("TALLY_BRIDGE_TALLY_TIMEOUT")
    }
    throw error
  }
}

async function fetchReport(fetchImpl, config, report, period, company) {
  const body = buildTallyExportRequest(report, {
    company,
    fromDate: period.fromDate,
    toDate: period.toDate,
  })
  return postTallyXml(fetchImpl, config, body)
}

/**
 * Read-only company discovery. It asks Tally which companies it has open and
 * returns their names; no company data leaves the machine here.
 */
export async function listTallyCompanies(
  config,
  fetchImpl = fetch,
  tallyLifecycle = {},
  { ensureServer = true } = {},
) {
  // The setup check must not start Tally as a side effect of looking, so it
  // passes ensureServer: false after its own non-launching port probe.
  if (ensureServer) await ensureTallyHttpServer(config, tallyLifecycle)
  const text = await postTallyXml(fetchImpl, config, buildTallyCompanyListRequest())
  return parseTallyCompanyNames(text)
}

export function canConnectToTally(tallyUrl) {
  return new Promise((resolve) => {
    const socket = createConnection({
      host: tallyUrl.hostname.replace(/^\[|\]$/g, ""),
      port: Number(tallyUrl.port),
    })
    socket.setTimeout(1_000)
    socket.once("connect", () => {
      socket.destroy()
      resolve(true)
    })
    socket.once("timeout", () => {
      socket.destroy()
      resolve(false)
    })
    socket.once("error", () => resolve(false))
  })
}

function launchTally(executable) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, [], {
      detached: true,
      shell: false,
      stdio: "ignore",
      windowsHide: true,
    })
    child.once("error", reject)
    child.once("spawn", () => {
      child.unref()
      resolve()
    })
  })
}

function localTallyTarget(tallyUrl) {
  const host = tallyUrl.hostname.toLowerCase().replace(/^\[|\]$/g, "")
  return host === "localhost" || host === "::1" || (isIP(host) === 4 && host.startsWith("127."))
}

export async function ensureTallyHttpServer(
  config,
  {
    probe = canConnectToTally,
    launch = launchTally,
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    attempts = 30,
  } = {},
) {
  if (await probe(config.tallyUrl)) return
  if (!config.tallyExecutable || !localTallyTarget(config.tallyUrl)) {
    throw new Error("TALLY_BRIDGE_TALLY_UNAVAILABLE")
  }

  await launch(config.tallyExecutable)
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (await probe(config.tallyUrl)) return
    await sleep(2_000)
  }
  throw new Error("TALLY_BRIDGE_TALLY_START_TIMEOUT")
}

export async function exportTallyCompany(
  config,
  fetchImpl = fetch,
  now = new Date(),
  tallyLifecycle = {},
  { closingOnly = false, scope = "all", fromDate, toDate, company } = {},
) {
  // A caller that states one bound but not the other is refused: filling the
  // missing bound from the launch default would export a range nobody asked for.
  const requested =
    fromDate !== undefined || toDate !== undefined
      ? {
          fromDate: validTallyDate(fromDate, "FROM_DATE"),
          toDate: validTallyDate(toDate, "TO_DATE"),
        }
      : undefined
  const period = resolveExportPeriod(config, now, requested)
  const pinned = String(company ?? config.company ?? "").trim()
  await ensureTallyHttpServer(config, tallyLifecycle)
  if (scope === "vouchers") {
    const voucherXml = await fetchReport(fetchImpl, config, "Day Book", period, pinned)
    return checkedExport(voucherXml, pinned, () =>
      buildVoucherOnlyExport(voucherXml, { company: pinned }),
    )
  }
  const masterXml = await fetchReport(fetchImpl, config, "All Masters", period, pinned)
  if (closingOnly || scope === "masters") {
    return checkedExport(masterXml, pinned, () =>
      buildMasterOnlyExport(masterXml, { company: pinned }),
    )
  }
  // Refused before the second fetch: a refused masters answer must not cost a
  // Day Book download the size of the whole period.
  extractData(masterXml, "All Masters")
  assertPinnedCompany(masterXml, pinned)
  const voucherXml = await fetchReport(fetchImpl, config, "Day Book", period, pinned)
  return checkedExport(voucherXml, pinned, () =>
    combineTallyExports(masterXml, voucherXml, { company: pinned }),
  )
}

function sendJson(response, status, value, corsHeaders = {}) {
  const body = JSON.stringify(value)
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    ...corsHeaders,
  })
  response.end(body)
}

function tokenMatches(expected, actual) {
  if (typeof actual !== "string" || actual.length !== expected.length) return false
  return timingSafeEqual(Buffer.from(expected), Buffer.from(actual))
}

function errorStatus(error) {
  if (
    error.message === "TALLY_BRIDGE_PERIOD_INCOMPLETE" ||
    error.message === "TALLY_BRIDGE_PERIOD_INVALID"
  ) {
    return 400
  }
  if (error.message === "TALLY_BRIDGE_TALLY_HTTP_503") return 503
  if (error.message === "TALLY_BRIDGE_EXPORT_TOO_LARGE") return 413
  if (error.message.startsWith("TALLY_BRIDGE_TALLY_")) return 502
  if (error.message.startsWith("TALLY_BRIDGE_")) return 422
  return 500
}

export function createTallyBridgeServer(config, fetchImpl = fetch, tallyLifecycle = {}) {
  let exporting = false
  const installations = (tallyLifecycle.detectInstallations ?? detectTallyInstallations)()
  const edition = config.tallyExecutable
    ? tallyEditionFromExecutable(config.tallyExecutable)
    : installations[0]?.edition ?? "unknown"
  return createServer(async (request, response) => {
    const origin = request.headers.origin
    if (!origin || !config.allowedOrigins.has(origin)) {
      sendJson(response, 403, { error: "Origin is not allowed." })
      return
    }

    const corsHeaders = {
      "access-control-allow-origin": origin,
      "access-control-allow-methods": "GET, POST, OPTIONS",
      "access-control-allow-headers": "content-type, x-synapse-tally-bridge-token",
      "access-control-max-age": "600",
      vary: "Origin",
    }
    if (request.headers["access-control-request-private-network"] === "true") {
      corsHeaders["access-control-allow-private-network"] = "true"
    }

    if (request.method === "OPTIONS") {
      response.writeHead(204, corsHeaders)
      response.end()
      return
    }
    const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1")
    const isExport = request.method === "POST" && requestUrl.pathname === "/api/tally/export"
    const isStatus = request.method === "GET" && requestUrl.pathname === "/api/tally/status"
    const isCompanies = request.method === "GET" && requestUrl.pathname === "/api/tally/companies"
    const isPreflight = request.method === "GET" && requestUrl.pathname === "/api/tally/preflight"
    if (!isExport && !isStatus && !isCompanies && !isPreflight) {
      sendJson(response, 404, { error: "Not found." }, corsHeaders)
      return
    }
    if (!tokenMatches(config.token, request.headers["x-synapse-tally-bridge-token"])) {
      sendJson(response, 401, { error: "Invalid bridge token." }, corsHeaders)
      return
    }

    if (isStatus) {
      // A reachability probe so the portal can name the failing layer before an
      // export runs. It reads nothing from Tally and returns no company data.
      const reachable = await (tallyLifecycle.probe ?? canConnectToTally)(config.tallyUrl)
      sendJson(
        response,
        200,
        {
          bridge: "ok",
          tally: reachable ? "reachable" : "unreachable",
          target: config.tallyUrl.origin,
          edition,
          installations: installations.map((entry) => entry.edition),
          // What an export that states no period of its own would use. The
          // portal sends its own period per request and compares the echo.
          period: {
            from: config.fromDate,
            to: config.toDate || currentTallyDate(new Date()),
          },
          company: config.company || null,
        },
        corsHeaders,
      )
      return
    }

    if (isCompanies) {
      // Discovery only: this asks Tally which companies are open. It does not
      // read balances, vouchers, or any company data.
      try {
        const companies = await listTallyCompanies(config, fetchImpl, tallyLifecycle)
        sendJson(response, 200, { companies, edition }, corsHeaders)
      } catch (error) {
        const failure = error instanceof Error ? error : new Error("TALLY_BRIDGE_COMPANIES_FAILED")
        sendJson(response, errorStatus(failure), { error: failure.message }, corsHeaders)
      }
      return
    }

    if (isPreflight) {
      // The setup assistant's "Check My Computer". Read-only: it inspects this
      // machine and asks Tally for its company list. It exports nothing, writes
      // nothing, and never starts Tally as a side effect of looking.
      if (exporting) {
        sendJson(response, 409, { error: "A Tally export is already running." }, corsHeaders)
        return
      }
      const probe = tallyLifecycle.probe ?? canConnectToTally
      const tallyReachable = await probe(config.tallyUrl)
      let companies = null
      let companyError = null
      if (tallyReachable) {
        try {
          companies = await listTallyCompanies(config, fetchImpl, tallyLifecycle, { ensureServer: false })
        } catch (error) {
          companyError = error instanceof Error ? error.message : "TALLY_BRIDGE_TALLY_UNAVAILABLE"
        }
      }
      const detect = tallyLifecycle.detectInstallations ?? detectTallyInstallations
      const found = detect()
      const detectedEdition = config.tallyExecutable
        ? tallyEditionFromExecutable(config.tallyExecutable)
        : found[0]?.edition ?? "unknown"
      const report = await runPreflight({
        config,
        connector: {
          version: TALLY_CONNECTOR_VERSION,
          contractVersion: TALLY_BRIDGE_CONTRACT_VERSION,
          bindHost: config.bridgeBindHost,
          port: config.bridgePort,
        },
        runtime: {
          nodeVersion: process.versions.node,
          execPath: process.execPath,
          cwd: process.cwd(),
          installations: found,
          edition: detectedEdition,
          companies,
          companyError,
          tallyReachable,
        },
        probes: { fetchImpl },
      })
      sendJson(response, 200, report, corsHeaders)
      return
    }

    if (Number(request.headers["content-length"] ?? 0) > 0 || request.headers["transfer-encoding"]) {
      sendJson(response, 400, { error: "This endpoint does not accept a request body." }, corsHeaders)
      return
    }

    // The period and pin are resolved per request, before the export mutex is
    // taken. A bad request must not look like a busy bridge, and a bridge left
    // running with yesterday's dates must not export yesterday's range silently.
    const closingOnly = requestUrl.searchParams.get("mode") === "closing"
    let period
    let company
    let scope
    try {
      period = resolveExportPeriod(config, new Date(), readRequestedPeriod(requestUrl.searchParams))
      company = resolveRequestedCompany(config, requestUrl.searchParams)
      scope = readRequestedScope(requestUrl.searchParams, closingOnly)
    } catch (error) {
      const message = error instanceof Error ? error.message : "TALLY_BRIDGE_PERIOD_INVALID"
      sendJson(response, errorStatus(error instanceof Error ? error : new Error(message)), { error: message }, corsHeaders)
      return
    }

    if (exporting) {
      sendJson(response, 409, { error: "A Tally export is already running." }, corsHeaders)
      return
    }
    exporting = true
    try {
      const xml = await exportTallyCompany(config, fetchImpl, new Date(), tallyLifecycle, {
        closingOnly,
        scope,
        fromDate: period.fromDate,
        toDate: period.toDate,
        company,
      })
      response.writeHead(200, {
        "content-type": "application/xml; charset=utf-8",
        "content-length": Buffer.byteLength(xml),
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
        "access-control-allow-origin": origin,
        "access-control-allow-methods": "GET, POST, OPTIONS",
        "access-control-allow-headers": "content-type, x-synapse-tally-bridge-token",
        // The portal compares these against what it asked for and refuses a
        // payload whose period or company differs; without them a successful
        // export cannot be tied to the operator's request.
        "access-control-expose-headers":
          "x-synapse-tally-company, x-synapse-tally-from, x-synapse-tally-to, x-synapse-tally-mode, x-synapse-tally-scope",
        "x-synapse-tally-company": company,
        "x-synapse-tally-from": period.fromDate,
        "x-synapse-tally-to": period.toDate,
        "x-synapse-tally-mode": closingOnly ? "closing" : "opening",
        "x-synapse-tally-scope": scope,
        vary: "Origin",
      })
      response.end(xml)
    } catch (error) {
      const message = error instanceof Error ? error.message : "TALLY_BRIDGE_EXPORT_FAILED"
      sendJson(response, errorStatus(error instanceof Error ? error : new Error(message)), { error: message }, corsHeaders)
    } finally {
      exporting = false
    }
  })
}
