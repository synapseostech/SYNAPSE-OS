import { timingSafeEqual } from "node:crypto"
import { spawn } from "node:child_process"
import { createConnection, isIP } from "node:net"
import { createServer } from "node:http"

export const TALLY_BRIDGE_PORT = 17890
export const TALLY_HTTP_PORT = 9000
export const MAX_TALLY_EXPORT_BYTES = 25 * 1024 * 1024
export const TALLY_EXPORT_TIMEOUT_MS = 60_000
export const DEFAULT_TALLY_FROM_DATE = "19000101"

const REPORTS = ["All Masters", "Day Book"]

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
    company: env.SYNAPSE_TALLY_COMPANY?.trim() ?? "",
    tallyExecutable: env.SYNAPSE_TALLY_EXECUTABLE?.trim() ?? "",
    fromDate: validTallyDate(
      env.SYNAPSE_TALLY_FROM_DATE ?? DEFAULT_TALLY_FROM_DATE,
      "FROM_DATE",
    ),
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

export function buildTallyExportRequest(report, { company, fromDate, toDate }) {
  if (!REPORTS.includes(report)) throw new Error("TALLY_BRIDGE_REPORT_UNSUPPORTED")
  const companyTag = company
    ? `<SVCURRENTCOMPANY>${escapeXml(company)}</SVCURRENTCOMPANY>`
    : ""
  const dateTags = report === "Day Book"
    ? `<SVFROMDATE>${validTallyDate(fromDate, "FROM_DATE")}</SVFROMDATE><SVTODATE>${validTallyDate(toDate, "TO_DATE")}</SVTODATE>`
    : ""

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

function extractData(responseText, report) {
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
  if (!data?.trim()) {
    throw new Error(`TALLY_BRIDGE_${report.toUpperCase().replaceAll(" ", "_")}_EMPTY`)
  }
  return data
}

export function combineTallyExports(masterXml, voucherXml) {
  const masters = extractData(masterXml, "All Masters")
  const vouchers = extractData(voucherXml, "Day Book")
  const combined = `<ENVELOPE><HEADER><VERSION>1</VERSION><STATUS>1</STATUS></HEADER><BODY><DATA>${masters}${vouchers}</DATA></BODY></ENVELOPE>`

  if (Buffer.byteLength(combined) > MAX_TALLY_EXPORT_BYTES) {
    throw new Error("TALLY_BRIDGE_EXPORT_TOO_LARGE")
  }
  if (!/<(?:COMPANY|LEDGER|STOCKITEM|GROUP|VOUCHER)\b/i.test(combined)) {
    throw new Error("TALLY_BRIDGE_NO_IMPORTABLE_RECORDS")
  }
  return combined
}

async function fetchReport(fetchImpl, config, report, today) {
  const body = buildTallyExportRequest(report, {
    company: config.company,
    fromDate: config.fromDate,
    toDate: today,
  })
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
  return readResponseText(response)
}

function canConnectToTally(tallyUrl) {
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
) {
  await ensureTallyHttpServer(config, tallyLifecycle)
  const today = [
    String(now.getFullYear()).padStart(4, "0"),
    String(now.getMonth() + 1).padStart(2, "0"),
    String(now.getDate()).padStart(2, "0"),
  ].join("")
  const masterXml = await fetchReport(fetchImpl, config, "All Masters", today)
  const voucherXml = await fetchReport(fetchImpl, config, "Day Book", today)
  return combineTallyExports(masterXml, voucherXml)
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
  if (error.message === "TALLY_BRIDGE_TALLY_HTTP_503") return 503
  if (error.message === "TALLY_BRIDGE_EXPORT_TOO_LARGE") return 413
  if (error.message.startsWith("TALLY_BRIDGE_TALLY_")) return 502
  if (error.message.startsWith("TALLY_BRIDGE_")) return 422
  return 500
}

export function createTallyBridgeServer(config, fetchImpl = fetch, tallyLifecycle = {}) {
  let exporting = false
  return createServer(async (request, response) => {
    const origin = request.headers.origin
    if (!origin || !config.allowedOrigins.has(origin)) {
      sendJson(response, 403, { error: "Origin is not allowed." })
      return
    }

    const corsHeaders = {
      "access-control-allow-origin": origin,
      "access-control-allow-methods": "POST, OPTIONS",
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
    if (request.method !== "POST" || request.url !== "/api/tally/export") {
      sendJson(response, 404, { error: "Not found." }, corsHeaders)
      return
    }
    if (!tokenMatches(config.token, request.headers["x-synapse-tally-bridge-token"])) {
      sendJson(response, 401, { error: "Invalid bridge token." }, corsHeaders)
      return
    }
    if (Number(request.headers["content-length"] ?? 0) > 0 || request.headers["transfer-encoding"]) {
      sendJson(response, 400, { error: "This endpoint does not accept a request body." }, corsHeaders)
      return
    }
    if (exporting) {
      sendJson(response, 409, { error: "A Tally export is already running." }, corsHeaders)
      return
    }
    exporting = true
    try {
      const xml = await exportTallyCompany(config, fetchImpl, new Date(), tallyLifecycle)
      response.writeHead(200, {
        "content-type": "application/xml; charset=utf-8",
        "content-length": Buffer.byteLength(xml),
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
        "access-control-allow-origin": origin,
        "access-control-allow-methods": "POST, OPTIONS",
        "access-control-allow-headers": "content-type, x-synapse-tally-bridge-token",
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
