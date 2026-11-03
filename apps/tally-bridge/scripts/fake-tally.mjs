#!/usr/bin/env node
/**
 * A stand-in for the Tally HTTP endpoint, for rehearsals only.
 *
 * The bridge talks to Tally over plain HTTP on a private address. That means the
 * whole chain — request envelope, response parsing, company pinning, chunk
 * planning — can be exercised on any machine by serving Tally-shaped XML from a
 * local socket. This file is what makes `scripts/tally-rehearse.mjs` a real
 * rehearsal rather than a mock: the bridge opens a real TCP connection, sends a
 * real envelope, and reads a real response.
 *
 * It is a dev tool. It must never be copied into the connector bundle that ships
 * to a pharmacy, and it serves synthetic fixtures only.
 *
 * Fault modes exist because each one maps onto a refusal code the bridge really
 * produces, so a rehearsal can assert the code the operator will actually see:
 *
 *   ok               the fixtures, filtered to the requested period
 *   reject           <STATUS>0</STATUS>          -> *_REJECTED
 *   status-missing   no <STATUS> element         -> *_STATUS_MISSING
 *   empty            named company, empty DATA   -> *_EMPTY
 *   no-company       payload with no company     -> COMPANY_UNVERIFIED
 *   unsafe           a DOCTYPE header            -> *_UNSAFE_XML
 *   unavailable      never listens               -> TALLY_UNAVAILABLE
 *   slow             accepts, never answers      -> TALLY_TIMEOUT
 */

import { readFile } from "node:fs/promises"
import { createServer } from "node:http"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const HERE = dirname(fileURLToPath(import.meta.url))
export const DEFAULT_FIXTURES = join(HERE, "..", "fixtures", "synthetic")

export const FAKE_TALLY_MODES = [
  "ok",
  "reject",
  "status-missing",
  "empty",
  "no-company",
  "unsafe",
  "unavailable",
  "slow",
]

/** Which synthetic document a request asked for. */
export function reportForRequest(body) {
  if (body.includes("<ID>List of Companies</ID>")) return "companies"
  if (body.includes("<ID>All Masters</ID>")) return "masters"
  if (body.includes("<ID>Day Book</ID>")) return "daybook"
  return undefined
}

function compactDate(text, tag) {
  const match = new RegExp(`<${tag}>\\s*(\\d{8})\\s*</${tag}>`).exec(text)
  return match?.[1]
}

/** Tally only returns vouchers inside the period the request states. */
function filterVouchers(xml, from, to) {
  if (!from && !to) return xml
  return xml.replace(/<VOUCHER\b[^>]*>[\s\S]*?<\/VOUCHER>/g, (block) => {
    const date = compactDate(block, "DATE")
    if (!date) return block
    if (from && date < from) return ""
    if (to && date > to) return ""
    return block
  })
}

function withoutCompany(xml) {
  return xml
    .replace(/<COMPANY\b[^>]*>[\s\S]*?<\/COMPANY>/g, "")
    .replace(/<COMPANY\b[^>]*\/>/g, "")
    .replace(/<COMPANYNAME>[^<]*<\/COMPANYNAME>/g, "")
}

const COMPANY_MARKER =
  '<COMPANY NAME="Synthetic Pharmacy Ltd"><COMPANYNAME>Synthetic Pharmacy Ltd</COMPANYNAME></COMPANY>'
const REJECTED = "<ENVELOPE><HEADER><VERSION>1</VERSION><STATUS>0</STATUS></HEADER><BODY></BODY></ENVELOPE>"
const NO_STATUS = "<ENVELOPE><HEADER><VERSION>1</VERSION></HEADER><BODY></BODY></ENVELOPE>"
const EMPTY_DATA = `<ENVELOPE><HEADER><VERSION>1</VERSION><STATUS>1</STATUS></HEADER>${COMPANY_MARKER}<BODY><DATA>   </DATA></BODY></ENVELOPE>`
const UNSAFE = `<!DOCTYPE ENVELOPE SYSTEM "tally.dtd">${REJECTED}`

/**
 * The body Tally would send back for `report` under `mode`.
 *
 * `empty` keeps the company marker outside `<DATA>`, because that is the only
 * shape where "the response names its company but carries no rows" is
 * distinguishable from "the response names no company at all".
 */
export function renderReply({ report, mode, fixtures, requestBody = "" }) {
  if (mode === "reject") return REJECTED
  if (mode === "status-missing") return NO_STATUS
  if (mode === "empty") return EMPTY_DATA
  if (mode === "unsafe") return UNSAFE

  const source = fixtures[report] ?? ""
  const body = mode === "no-company" ? withoutCompany(source) : source
  if (report !== "daybook") return body
  return filterVouchers(
    body,
    compactDate(requestBody, "SVFROMDATE"),
    compactDate(requestBody, "SVTODATE"),
  )
}

export async function loadFixtures(directory = DEFAULT_FIXTURES) {
  const load = async (name) =>
    readFile(resolve(directory, `${name}.xml`), "utf8")
  const [companies, masters, daybook] = await Promise.all([
    load("companies"),
    load("masters"),
    load("daybook"),
  ])
  return { companies, masters, daybook }
}

/**
 * Starts the fake and resolves once it is listening. `port: 0` picks a free
 * port, which is what every caller should use — the real Tally port may be in
 * use, and a rehearsal must never depend on a fixed one.
 */
export async function startFakeTally(options = {}) {
  const {
    mode = "ok",
    port = 0,
    host = "127.0.0.1",
    fixtures,
    slowMs = 65_000,
  } = options
  if (!FAKE_TALLY_MODES.includes(mode)) {
    throw new Error(`Unknown fake Tally mode: ${mode}`)
  }
  const data = fixtures ?? (await loadFixtures())

  const server = createServer((request, response) => {
    const reject = (status, message) => {
      response.writeHead(status, { "content-type": "text/plain; charset=utf-8" })
      response.end(message)
    }
    if (request.method !== "POST" || request.url !== "/") {
      reject(400, "fake Tally only answers POST /")
      return
    }
    const parts = []
    request.on("error", () => {})
    request.on("data", (part) => parts.push(part))
    request.on("end", () => {
      const body = Buffer.concat(parts).toString("utf8")
      const report = reportForRequest(body)
      if (!report) {
        reject(400, "fake Tally does not know that request")
        return
      }
      if (mode === "slow") {
        // Accept the connection and never answer, so the bridge's export
        // timeout is what ends the request.
        setTimeout(() => response.destroy(), slowMs).unref()
        return
      }
      const xml = renderReply({ report, mode, fixtures: data, requestBody: body })
      response.writeHead(200, {
        "content-type": "text/xml; charset=utf-8",
        "content-length": Buffer.byteLength(xml),
      })
      response.end(xml)
    })
  })

  await new Promise((done, fail) => {
    server.once("error", fail)
    server.listen(port, host, done)
  })
  const address = server.address()
  return {
    host,
    port: typeof address === "object" && address ? address.port : port,
    mode,
    fixtures: data,
    url: `http://${host}:${typeof address === "object" && address ? address.port : port}`,
    close: () => new Promise((done) => server.close(() => done())),
  }
}

async function main() {
  const mode = (process.env.SYNAPSE_FAKE_TALLY_MODE ?? "ok").trim() || "ok"
  const port = Number(process.env.SYNAPSE_FAKE_TALLY_PORT ?? "9000")

  if (mode === "unavailable") {
    console.log(`Synapse fake Tally: mode=unavailable, not listening (port ${port})`)
    return
  }

  const fixtures = await loadFixtures(
    process.env.SYNAPSE_FAKE_TALLY_FIXTURES?.trim() || DEFAULT_FIXTURES,
  )
  const fake = await startFakeTally({
    mode,
    port,
    fixtures,
    slowMs: Number(process.env.SYNAPSE_FAKE_TALLY_SLOW_MS ?? "65000"),
  })
  console.log(
    `Synapse fake Tally listening on ${fake.url} (mode=${mode}, fixtures=${process.env.SYNAPSE_FAKE_TALLY_FIXTURES ?? DEFAULT_FIXTURES})`,
  )
  const stop = () => fake.close().then(() => process.exit())
  process.once("SIGINT", stop)
  process.once("SIGTERM", stop)
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main().catch((error) => {
    console.error("Synapse fake Tally failed:", error.message)
    process.exitCode = 1
  })
}
