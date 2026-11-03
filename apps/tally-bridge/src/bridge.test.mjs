import assert from "node:assert/strict"
import { afterEach, describe, it } from "node:test"
import { execFile } from "node:child_process"
import { readFileSync } from "node:fs"
import { request as httpRequest } from "node:http"
import { join } from "node:path"
import { promisify } from "node:util"
import {
  buildMasterOnlyExport,
  buildTallyCompanyListRequest,
  buildTallyExportRequest,
  combineTallyExports,
  createTallyBridgeServer,
  detectTallyInstallations,
  ensureTallyHttpServer,
  exportTallyCompany,
  parseTallyCompanyNames,
  readBridgeConfig,
  tallyEditionFromExecutable,
} from "./bridge.mjs"
import { TALLY_BRIDGE_CONTRACT_VERSION, TALLY_CONNECTOR_VERSION } from "./preflight.mjs"

const TOKEN = "0123456789abcdef".repeat(4)
const ORIGIN = "https://pharm.synapseos.tech"
const masterReply = `<ENVELOPE><HEADER><STATUS>1</STATUS></HEADER><BODY><DATA><TALLYMESSAGE><COMPANY><COMPANYNAME>Test Pharmacy</COMPANYNAME></COMPANY><LEDGER NAME="Cash"/></TALLYMESSAGE></DATA></BODY></ENVELOPE>`
const voucherReply = `<ENVELOPE><HEADER><STATUS>1</STATUS></HEADER><BODY><DATA><TALLYMESSAGE><VOUCHER><DATE>20261001</DATE></VOUCHER></TALLYMESSAGE></DATA></BODY></ENVELOPE>`
// A pinned export also requires the Day Book to name its company. This fixture
// encodes that contract; tally-probe.ps1 confirms real Tally emits it.
const pinnedVoucherReply = voucherReply.replace("<VOUCHER>", "<COMPANY><COMPANYNAME>Test Pharmacy</COMPANYNAME></COMPANY><VOUCHER>")
const servers = []
const BRIDGE_URL = new URL("./bridge.mjs", import.meta.url).href
const run = promisify(execFile)

function stalledBody() {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("<ENVELOPE><HEADER>"))
      controller.error(new DOMException("The operation was aborted due to timeout", "TimeoutError"))
    },
  })
}

function config(overrides = {}) {
  return readBridgeConfig({
    SYNAPSE_TALLY_BRIDGE_TOKEN: TOKEN,
    SYNAPSE_TALLY_ALLOWED_ORIGINS: ORIGIN,
    SYNAPSE_TALLY_TARGET_HOST: "127.0.0.1",
    SYNAPSE_TALLY_COMPANY: "Test Pharmacy",
    ...overrides,
  })
}

async function startServer(handler, lifecycle = {}) {
  const server = createTallyBridgeServer(
    config({ SYNAPSE_TALLY_BRIDGE_PORT: "17891" }),
    handler,
    { probe: async () => true, detectInstallations: () => [], ...lifecycle },
  )
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
  servers.push(server)
  const address = server.address()
  return `http://127.0.0.1:${address.port}`
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))))
})

describe("Tally bridge configuration", () => {
  it("requires a strong token, exact web origins, and a private Tally target", () => {
    assert.throws(() => readBridgeConfig({ SYNAPSE_TALLY_ALLOWED_ORIGINS: ORIGIN }), /TOKEN/)
    assert.throws(
      () => config({ SYNAPSE_TALLY_ALLOWED_ORIGINS: "https://admin.synapseos.tech/path" }),
      /exact HTTPS origin/,
    )
    assert.throws(() => config({ SYNAPSE_TALLY_TARGET_HOST: "203.0.113.12" }), /private LAN IP/)
    assert.throws(() => config({ SYNAPSE_TALLY_TARGET_HOST: "fc.example.com" }), /private LAN IP/)
    assert.equal(config({ SYNAPSE_TALLY_TARGET_HOST: "192.168.1.22" }).tallyUrl.hostname, "192.168.1.22")
    assert.throws(() => config({ SYNAPSE_TALLY_TO_DATE: "2026-02-30" }), /TO_DATE_INVALID/)
    assert.equal(config({ SYNAPSE_TALLY_TO_DATE: "20260331" }).toDate, "20260331")
  })

  it("builds fixed XML export requests and escapes a configured company name", () => {
    const request = buildTallyExportRequest("Day Book", {
      company: `Pharmacy & <Co>`,
      fromDate: "19000101",
      toDate: "20261030",
    })
    assert.match(request, /<TALLYREQUEST>Export<\/TALLYREQUEST>/)
    assert.match(request, /<ID>Day Book<\/ID>/)
    assert.match(request, /Pharmacy &amp; &lt;Co&gt;/)
    assert.match(request, /<SVFROMDATE>19000101<\/SVFROMDATE>/)

    const masters = buildTallyExportRequest("All Masters", {
      company: "",
      fromDate: "19000101",
      toDate: "20261030",
    })
    assert.match(masters, /<SVFROMDATE>19000101<\/SVFROMDATE>/)
    assert.match(masters, /<SVTODATE>20261030<\/SVTODATE>/)

    assert.throws(
      () => buildTallyExportRequest("All Ledgers", { company: "", fromDate: "19000101", toDate: "20261030" }),
      /REPORT_UNSUPPORTED/,
    )
  })

  it("rejects unsuccessful, unsafe, or empty Tally responses", () => {
    assert.throws(
      () => combineTallyExports(masterReply.replace("<STATUS>1</STATUS>", "<STATUS>0</STATUS>"), voucherReply),
      /ALL_MASTERS_REJECTED/,
    )
    assert.throws(
      () => combineTallyExports(masterReply.replace("<DATA>", "<!DOCTYPE x><DATA>"), voucherReply),
      /UNSAFE_XML/,
    )
    assert.throws(
      () => combineTallyExports(masterReply.replace("<DATA>", "<DATA></DATA><DATA>"), voucherReply),
      /ALL_MASTERS_EMPTY/,
    )
  })

  it("identifies the Tally edition from the configured executable", () => {
    assert.equal(
      tallyEditionFromExecutable("C:\\Program Files\\TallyPrime\\tally.exe"),
      "prime",
    )
    assert.equal(tallyEditionFromExecutable("C:/Program Files/TallyPrime/tally.exe"), "prime")
    assert.equal(tallyEditionFromExecutable("C:\\Tally.ERP9\\tally.exe"), "erp9")
    assert.equal(tallyEditionFromExecutable("C:\\Other\\tally.exe"), "unknown")
    assert.equal(tallyEditionFromExecutable(""), "unknown")
  })

  it("detects an installed Tally by its default folder without launching it", () => {
    assert.deepEqual(
      detectTallyInstallations({ exists: (path) => path === "C:\\Tally.ERP9\\tally.exe" }),
      [{ edition: "erp9", executable: "C:\\Tally.ERP9\\tally.exe" }],
    )
    assert.deepEqual(detectTallyInstallations({ exists: () => false }), [])
  })

  it("parses the company list from either Tally response shape", () => {
    const byAttribute = `<ENVELOPE><HEADER><STATUS>1</STATUS></HEADER><BODY><DATA><COLLECTION><COMPANY NAME="Nakawa &amp; Sons"/><COMPANY NAME="Wandegeya"/></COLLECTION></DATA></BODY></ENVELOPE>`
    assert.deepEqual(parseTallyCompanyNames(byAttribute), ["Nakawa & Sons", "Wandegeya"])

    const byChild = `<ENVELOPE><HEADER><STATUS>1</STATUS></HEADER><BODY><DATA><TALLYMESSAGE><COMPANYNAME>Nakawa</COMPANYNAME><COMPANYNAME>Nakawa</COMPANYNAME></TALLYMESSAGE></DATA></BODY></ENVELOPE>`
    assert.deepEqual(parseTallyCompanyNames(byChild), ["Nakawa"])

    assert.throws(
      () => parseTallyCompanyNames(byAttribute.replace("<STATUS>1</STATUS>", "<STATUS>0</STATUS>")),
      /COMPANIES_REJECTED/,
    )
    assert.throws(
      () => parseTallyCompanyNames(byAttribute.replace("<DATA>", "<!DOCTYPE x><DATA>")),
      /COMPANIES_UNSAFE_XML/,
    )
    assert.throws(
      () =>
        parseTallyCompanyNames(
          `<ENVELOPE><HEADER><STATUS>1</STATUS></HEADER><BODY><DATA> </DATA></BODY></ENVELOPE>`,
        ),
      /COMPANIES_EMPTY/,
    )
  })

  it("builds a read-only company collection request", () => {
    const request = buildTallyCompanyListRequest()
    assert.match(request, /<TYPE>Collection<\/TYPE>/)
    assert.match(request, /<ID>List of Companies<\/ID>/)
    assert.match(request, /<TYPE>Company<\/TYPE>/)
    assert.doesNotMatch(request, /Import/)
  })
})

describe("Tally export", () => {
  it("does not launch Tally when its HTTP port is already available", async () => {
    let launches = 0
    await ensureTallyHttpServer(config({ SYNAPSE_TALLY_EXECUTABLE: "C:\\Tally\\tally.exe" }), {
      probe: async () => true,
      launch: async () => launches++,
    })

    assert.equal(launches, 0)
  })

  it("launches Tally only for an unavailable local target when configured", async () => {
    const launches = []
    let probes = 0
    await ensureTallyHttpServer(
      config({
        SYNAPSE_TALLY_EXECUTABLE: "C:\\Program Files\\TallyPrime\\tally.exe",
      }),
      {
        probe: async () => ++probes > 1,
        launch: async (executable) => launches.push(executable),
        sleep: async () => {},
      },
    )

    assert.deepEqual(launches, ["C:\\Program Files\\TallyPrime\\tally.exe"])
    assert.equal(probes, 2)
  })

  it("recognizes the full IPv4 loopback range as a local target", async () => {
    let launches = 0
    await assert.rejects(
      ensureTallyHttpServer(
        config({
          SYNAPSE_TALLY_EXECUTABLE: "C:\\Program Files\\TallyPrime\\tally.exe",
          SYNAPSE_TALLY_TARGET_HOST: "127.0.0.2",
        }),
        {
          probe: async () => false,
          launch: async () => launches++,
          sleep: async () => {},
          attempts: 0,
        },
      ),
      /TALLY_START_TIMEOUT/,
    )

    assert.equal(launches, 1)
  })

  it("reports when the launched Tally HTTP server never becomes available", async () => {
    let launches = 0
    let probes = 0
    await assert.rejects(
      () =>
        ensureTallyHttpServer(
          config({ SYNAPSE_TALLY_EXECUTABLE: "C:\\Tally\\tally.exe" }),
          {
            probe: async () => {
              probes += 1
              return false
            },
            launch: async () => launches++,
            sleep: async () => {},
            attempts: 2,
          },
        ),
      /TALLY_START_TIMEOUT/,
    )

    assert.equal(launches, 1)
    assert.equal(probes, 3)
  })

  it("reports a failed executable launch instead of falling back to an export attempt", async () => {
    await assert.rejects(
      () =>
        ensureTallyHttpServer(config({ SYNAPSE_TALLY_EXECUTABLE: "C:\\missing\\tally.exe" }), {
          probe: async () => false,
          launch: async () => {
            throw new Error("Executable could not be started")
          },
        }),
      /Executable could not be started/,
    )
  })

  it(
    "starts a configured local executable with the Windows process launcher",
    { skip: process.platform !== "win32" },
    async () => {
      let probes = 0
      await ensureTallyHttpServer(
        config({
          SYNAPSE_TALLY_EXECUTABLE: join(
            process.env.SystemRoot ?? "C:\\Windows",
            "System32",
            "where.exe",
          ),
        }),
        {
          probe: async () => ++probes > 1,
          sleep: async () => {},
        },
      )

      assert.equal(probes, 2)
    },
  )

  it("does not try to launch a remote Tally server", async () => {
    await assert.rejects(
      () =>
        ensureTallyHttpServer(
          config({
            SYNAPSE_TALLY_EXECUTABLE: "C:\\Program Files\\TallyPrime\\tally.exe",
            SYNAPSE_TALLY_TARGET_HOST: "192.168.1.22",
          }),
          { probe: async () => false, launch: async () => assert.fail("must not launch on this host") },
        ),
      /TALLY_UNAVAILABLE/,
    )
  })

  it("requests masters and dated Day Book sequentially and returns a combined XML file", async () => {
    const requests = []
    const now = new Date("2026-10-30T23:30:00.000Z")
    const xml = await exportTallyCompany(
      config({ SYNAPSE_TALLY_COMPANY: "Test Pharmacy" }),
      async (_url, options) => {
        requests.push({ body: options.body, redirect: options.redirect })
        return new Response(requests.length === 1 ? masterReply : pinnedVoucherReply, { status: 200 })
      },
      now,
      { probe: async () => true },
    )
    const expectedLocalDate = [
      String(now.getFullYear()).padStart(4, "0"),
      String(now.getMonth() + 1).padStart(2, "0"),
      String(now.getDate()).padStart(2, "0"),
    ].join("")

    assert.equal(requests.length, 2)
    assert.equal(typeof requests[0].body, "string")
    assert.match(requests[0].body, /<ID>All Masters<\/ID>/)
    assert.match(requests[1].body, /<ID>Day Book<\/ID>/)
    assert.match(requests[0].body, new RegExp(`<SVTODATE>${expectedLocalDate}</SVTODATE>`))
    assert.match(requests[1].body, new RegExp(`<SVTODATE>${expectedLocalDate}</SVTODATE>`))
    assert.equal(requests[0].redirect, "error")
    assert.match(xml, /<COMPANYNAME>Test Pharmacy<\/COMPANYNAME>/)
    assert.match(xml, /<VOUCHER>/)
  })

  it("does not fetch the Day Book at all for a balances-only cut-over", async () => {
    const requests = []
    const xml = await exportTallyCompany(
      config(),
      async (_url, options) => {
        requests.push(options.body)
        return new Response(masterReply, { status: 200 })
      },
      new Date("2026-10-30T00:00:00Z"),
      { probe: async () => true },
      { closingOnly: true },
    )

    assert.equal(requests.length, 1)
    assert.match(requests[0], /<ID>All Masters<\/ID>/)
    assert.doesNotMatch(xml, /<VOUCHER>/)
    assert.match(xml, /<LEDGER/)
  })

  it("refuses an export that came back for a different company", async () => {
    const other = masterReply.replace("Test Pharmacy", "Another Pharmacy")
    await assert.rejects(
      exportTallyCompany(
        config({ SYNAPSE_TALLY_COMPANY: "Test Pharmacy" }),
        async () => new Response(other),
        new Date("2026-10-30T00:00:00Z"),
        { probe: async () => true },
        { closingOnly: true },
      ),
      /TALLY_BRIDGE_COMPANY_MISMATCH/,
    )
  })

  it("refuses a masters response that does not identify its company", async () => {
    const anonymous = masterReply.replace(
      "<COMPANY><COMPANYNAME>Test Pharmacy</COMPANYNAME></COMPANY>",
      "",
    )
    await assert.rejects(
      exportTallyCompany(
        config({ SYNAPSE_TALLY_COMPANY: "Test Pharmacy" }),
        async () => new Response(anonymous),
        new Date("2026-10-30T00:00:00Z"),
        { probe: async () => true },
        { closingOnly: true },
      ),
      /TALLY_BRIDGE_COMPANY_UNVERIFIED/,
    )
  })

  it("refuses a Day Book that does not identify its company", async () => {
    let calls = 0
    await assert.rejects(
      exportTallyCompany(
        config({ SYNAPSE_TALLY_COMPANY: "Test Pharmacy" }),
        async () => new Response(++calls === 1 ? masterReply : voucherReply),
        new Date("2026-10-30T00:00:00Z"),
        { probe: async () => true },
      ),
      /TALLY_BRIDGE_COMPANY_UNVERIFIED/,
    )
  })

  it("refuses to export at all when no company is pinned", async () => {
    await assert.rejects(
      exportTallyCompany(
        config({ SYNAPSE_TALLY_COMPANY: "" }),
        async () => new Response(masterReply),
        new Date("2026-10-30T00:00:00Z"),
        { probe: async () => true },
        { closingOnly: true },
      ),
      /TALLY_BRIDGE_COMPANY_UNPINNED/,
    )
  })

  it("accepts the pinned company regardless of case or padding", async () => {
    const xml = await exportTallyCompany(
      config({ SYNAPSE_TALLY_COMPANY: "  test pharmacy " }),
      async () => new Response(masterReply),
      new Date("2026-10-30T00:00:00Z"),
      { probe: async () => true },
      { closingOnly: true },
    )
    assert.match(xml, /<COMPANYNAME>Test Pharmacy<\/COMPANYNAME>/)
  })

  it("pins both reports to SYNAPSE_TALLY_TO_DATE when it is set", async () => {
    const requests = []
    await exportTallyCompany(
      config({ SYNAPSE_TALLY_TO_DATE: "20260331" }),
      async (_url, options) => {
        requests.push({ body: options.body })
        return new Response(requests.length === 1 ? masterReply : pinnedVoucherReply, { status: 200 })
      },
      new Date("2026-10-30T12:00:00.000Z"),
      { probe: async () => true },
    )

    assert.equal(requests.length, 2)
    for (const request of requests) {
      assert.match(request.body, /<SVTODATE>20260331<\/SVTODATE>/)
    }
  })

  it("distinguishes malformed response encoding and HTTP failures from connection errors", async () => {
    await assert.rejects(
      () =>
        exportTallyCompany(
          config(),
          async () => new Response(new Uint8Array([0xff]), { status: 200 }),
          new Date("2026-10-30T12:00:00.000Z"),
          { probe: async () => true },
        ),
      /TALLY_BRIDGE_RESPONSE_NOT_UTF8/,
    )
    await assert.rejects(
      () =>
        exportTallyCompany(
          config(),
          async () => new Response("Tally unavailable", { status: 503 }),
          new Date("2026-10-30T12:00:00.000Z"),
          { probe: async () => true },
        ),
      /TALLY_BRIDGE_TALLY_HTTP_503/,
    )
  })

  it("reports a timeout that fires while the response body is still streaming", async () => {
    await assert.rejects(
      () =>
        exportTallyCompany(
          config(),
          async () => new Response(stalledBody(), { status: 200 }),
          new Date("2026-10-30T12:00:00.000Z"),
          { probe: async () => true },
        ),
      /TALLY_BRIDGE_TALLY_TIMEOUT/,
    )
  })

  it("reports a timeout that fires before the response headers arrive", async () => {
    await assert.rejects(
      () =>
        exportTallyCompany(
          config(),
          async () => {
            throw new DOMException("The operation was aborted due to timeout", "TimeoutError")
          },
          new Date("2026-10-30T12:00:00.000Z"),
          { probe: async () => true },
        ),
      /TALLY_BRIDGE_TALLY_TIMEOUT/,
    )
  })

  it("registers no timer of its own on success, HTTP error, body failure or timeout", async () => {
    const timers = () =>
      process.getActiveResourcesInfo().filter((name) => name === "Timeout").length
    const before = timers()
    const now = new Date("2026-10-30T12:00:00.000Z")
    const lifecycle = { probe: async () => true }
    let call = 0

    await exportTallyCompany(
      config(),
      async () => new Response(call++ === 0 ? masterReply : pinnedVoucherReply, { status: 200 }),
      now,
      lifecycle,
    )
    await assert.rejects(
      () => exportTallyCompany(config(), async () => new Response("no", { status: 503 }), now, lifecycle),
      /TALLY_BRIDGE_TALLY_HTTP_503/,
    )
    await assert.rejects(
      () => exportTallyCompany(config(), async () => new Response(stalledBody(), { status: 200 }), now, lifecycle),
      /TALLY_BRIDGE_TALLY_TIMEOUT/,
    )
    await assert.rejects(
      () =>
        exportTallyCompany(
          config(),
          async () => {
            throw new DOMException("The operation was aborted due to timeout", "TimeoutError")
          },
          now,
          lifecycle,
        ),
      /TALLY_BRIDGE_TALLY_TIMEOUT/,
    )

    assert.equal(timers(), before)
  })

  it("lets the process exit straight after a call instead of holding the 60s timer open", async () => {
    // Each call arms AbortSignal.timeout(60_000). If an armed timer kept the
    // event loop alive, this child would only exit when execFile killed it.
    const script = `
      import { exportTallyCompany, readBridgeConfig } from ${JSON.stringify(BRIDGE_URL)}
      const config = readBridgeConfig({
        SYNAPSE_TALLY_BRIDGE_TOKEN: ${JSON.stringify(TOKEN)},
        SYNAPSE_TALLY_ALLOWED_ORIGINS: ${JSON.stringify(ORIGIN)},
        SYNAPSE_TALLY_TARGET_HOST: "127.0.0.1",
        SYNAPSE_TALLY_COMPANY: "Test Pharmacy",
      })
      const masterReply = ${JSON.stringify(masterReply)}
      const voucherReply = ${JSON.stringify(pinnedVoucherReply)}
      let call = 0
      await exportTallyCompany(
        config,
        async () => new Response(call++ === 0 ? masterReply : voucherReply, { status: 200 }),
        new Date("2026-10-30T12:00:00.000Z"),
        { probe: async () => true },
      )
      await exportTallyCompany(
        config,
        async () => { throw new DOMException("timeout", "TimeoutError") },
        new Date("2026-10-30T12:00:00.000Z"),
        { probe: async () => true },
      ).catch(() => {})
      console.log("done")
    `

    const { stdout } = await run(process.execPath, ["--input-type=module", "-e", script], {
      timeout: 20_000,
    })
    assert.match(stdout, /done/)
  })
})

describe("packaged export metadata", () => {
  // Tally Prime answers an All Masters request with the company echo and the
  // export dates in the envelope, outside <DATA>. packageExport keeps only
  // <DATA>, so without re-emission both would be lost.
  const envelopeOnlyMasterReply = `<ENVELOPE><HEADER><VERSION>1</VERSION><STATUS>1</STATUS><SVCURRENTCOMPANY>Test Pharmacy</SVCURRENTCOMPANY><SVFROMDATE>20260401</SVFROMDATE><SVTODATE>20261031</SVTODATE></HEADER><BODY><DATA><TALLYMESSAGE><LEDGER NAME="Cash"/></TALLYMESSAGE></DATA></BODY></ENVELOPE>`

  function packagedBody(xml) {
    return /<DATA[^>]*>([\s\S]*?)<\/DATA>/i.exec(xml)?.[1] ?? ""
  }

  it("carries a company stated only in the envelope into the packaged body", () => {
    const xml = combineTallyExports(envelopeOnlyMasterReply, voucherReply, {
      company: "Test Pharmacy",
    })

    assert.match(packagedBody(xml), /<COMPANY NAME="Test Pharmacy">/)
    assert.match(packagedBody(xml), /<COMPANYNAME>Test Pharmacy<\/COMPANYNAME>/)
  })

  it("echoes only the dates the response itself stated", () => {
    const stated = combineTallyExports(envelopeOnlyMasterReply, voucherReply, {
      company: "Test Pharmacy",
    })
    assert.match(packagedBody(stated), /<SVFROMDATE>20260401<\/SVFROMDATE>/)
    assert.match(packagedBody(stated), /<SVTODATE>20261031<\/SVTODATE>/)

    const silent = combineTallyExports(
      envelopeOnlyMasterReply.replace(/<SVFROMDATE>[^<]*<\/SVFROMDATE>/, "")
        .replace(/<SVTODATE>[^<]*<\/SVTODATE>/, ""),
      voucherReply,
      { company: "Test Pharmacy" },
    )
    assert.doesNotMatch(silent, /SVFROMDATE/)
    assert.doesNotMatch(silent, /SVTODATE/)
  })

  it("re-emits the pinned company rather than the name the response carried", () => {
    const otherCompany = envelopeOnlyMasterReply.replace(
      "<SVCURRENTCOMPANY>Test Pharmacy</SVCURRENTCOMPANY>",
      "<SVCURRENTCOMPANY>Other Pharmacy</SVCURRENTCOMPANY>",
    )

    const xml = combineTallyExports(otherCompany, voucherReply, { company: "Test Pharmacy" })

    assert.match(packagedBody(xml), /<COMPANYNAME>Test Pharmacy<\/COMPANYNAME>/)
    assert.doesNotMatch(xml, /Other Pharmacy/)
  })

  it("does not duplicate a company the data already names", () => {
    const xml = combineTallyExports(masterReply, voucherReply, { company: "Test Pharmacy" })

    // masterReply already carries the company inside <DATA>; the Day Book
    // fixture does not, so one name means nothing was added twice.
    assert.equal(packagedBody(xml).match(/<COMPANYNAME>/gi)?.length, 1)
  })

  it("escapes a pinned name so the packaged file stays well formed", () => {
    const xml = combineTallyExports(envelopeOnlyMasterReply, voucherReply, {
      company: "Nakawa & Sons",
    })

    assert.match(packagedBody(xml), /<COMPANY NAME="Nakawa &amp; Sons">/)
    assert.doesNotMatch(xml, /NAME="Nakawa & Sons"/)
  })

  it("verifies a company named only inside <DATA>, including an escaped name", async () => {
    // Tally Prime can leave the envelope silent and name the company inside the
    // masters instead. The name arrives escaped, and it must both satisfy the
    // pin and survive packaging unchanged — without a second copy being added.
    const escaped = "Nakawa &amp; Sons"
    const masters = `<ENVELOPE><HEADER><STATUS>1</STATUS></HEADER><BODY><DATA><TALLYMESSAGE><COMPANY><COMPANYNAME>${escaped}</COMPANYNAME></COMPANY><LEDGER NAME="Cash"/></TALLYMESSAGE></DATA></BODY></ENVELOPE>`
    const vouchers = `<ENVELOPE><HEADER><STATUS>1</STATUS></HEADER><BODY><DATA><TALLYMESSAGE><COMPANY><COMPANYNAME>${escaped}</COMPANYNAME></COMPANY><VOUCHER><DATE>20261001</DATE></VOUCHER></TALLYMESSAGE></DATA></BODY></ENVELOPE>`

    let call = 0
    const xml = await exportTallyCompany(
      config({ SYNAPSE_TALLY_COMPANY: "Nakawa & Sons" }),
      async () => new Response(call++ === 0 ? masters : vouchers, { status: 200 }),
      new Date("2026-10-30T00:00:00Z"),
      { probe: async () => true },
    )

    assert.equal(call, 2)
    // Each report names the company once and no synthetic company is added.
    assert.equal(
      packagedBody(xml).match(/<COMPANYNAME>Nakawa &amp; Sons<\/COMPANYNAME>/g)?.length,
      2,
    )
    assert.doesNotMatch(xml, /<COMPANY NAME=/)
    assert.doesNotMatch(xml, /<COMPANYNAME>Nakawa & Sons</)
  })

  it("echoes a single stated date without inventing its pair", () => {
    const fromOnly = envelopeOnlyMasterReply.replace(/<SVTODATE>[^<]*<\/SVTODATE>/, "")

    const xml = combineTallyExports(fromOnly, voucherReply, { company: "Test Pharmacy" })

    assert.match(packagedBody(xml), /<SVFROMDATE>20260401<\/SVFROMDATE>/)
    assert.doesNotMatch(packagedBody(xml), /SVTODATE/)
  })

  it("never substitutes the period it asked for when the response states another", () => {
    // The bridge asks for 1 Apr – 31 Oct 2026 but Tally answers for 2025. The
    // packaged file must carry the source's own dates: a requested period is
    // not evidence of what the source returned.
    const request = buildTallyExportRequest("All Masters", {
      company: "Test Pharmacy",
      fromDate: "20260401",
      toDate: "20261031",
    })
    assert.match(request, /<SVFROMDATE>20260401<\/SVFROMDATE>/)

    const answered = envelopeOnlyMasterReply
      .replace("20260401", "20250101")
      .replace("20261031", "20251231")
    const xml = combineTallyExports(answered, voucherReply, { company: "Test Pharmacy" })

    assert.match(packagedBody(xml), /<SVFROMDATE>20250101<\/SVFROMDATE>/)
    assert.match(packagedBody(xml), /<SVTODATE>20251231<\/SVTODATE>/)
    assert.doesNotMatch(packagedBody(xml), /20260401|20261031/)
  })

  it("packages an ERP 9-shaped reply that names the company only inside the data", () => {
    // Tally.ERP 9 does not fill the header company echo the way Prime does;
    // the name arrives inside <DATA> and the header states no period at all.
    // Packaging must not depend on the header echo, and the pinned company
    // must still be the only one in the file. This is the documented shape,
    // not a captured ERP 9 dump — real output is still unverified.
    const erp9Masters = `<ENVELOPE><HEADER><VERSION>1</VERSION><STATUS>1</STATUS></HEADER><BODY><DATA><TALLYMESSAGE><COMPANY><COMPANYNAME>Test Pharmacy</COMPANYNAME></COMPANY><LEDGER NAME="Cash"/></TALLYMESSAGE></DATA></BODY></ENVELOPE>`
    const erp9Vouchers = `<ENVELOPE><HEADER><VERSION>1</VERSION><STATUS>1</STATUS></HEADER><BODY><DATA><TALLYMESSAGE><VOUCHER><DATE>20261001</DATE><VOUCHERNUMBER>SAL-1</VOUCHERNUMBER></VOUCHER></TALLYMESSAGE></DATA></BODY></ENVELOPE>`

    const xml = combineTallyExports(erp9Masters, erp9Vouchers, { company: "Test Pharmacy" })

    assert.equal(packagedBody(xml).match(/<COMPANYNAME>Test Pharmacy<\/COMPANYNAME>/g)?.length, 1)
    assert.match(packagedBody(xml), /<VOUCHERNUMBER>SAL-1<\/VOUCHERNUMBER>/)
    assert.doesNotMatch(packagedBody(xml), /SVFROMDATE|SVTODATE/)
  })

  it("does not write the requested dates into an export that states none", async () => {
    // The masters name their company inside <DATA> and state no dates, so the
    // live export has nothing to echo; the dates the bridge asked for must not
    // appear in the packaged file as though the source had declared them.
    const requested = config({
      SYNAPSE_TALLY_FROM_DATE: "20260401",
      SYNAPSE_TALLY_TO_DATE: "20261031",
    })
    const requests = []

    const xml = await exportTallyCompany(
      requested,
      async (_url, options) => {
        requests.push(options.body)
        return new Response(
          /<ID>All Masters<\/ID>/.test(options.body) ? masterReply : pinnedVoucherReply,
          { status: 200 },
        )
      },
      new Date("2026-10-30T00:00:00Z"),
      { probe: async () => true },
    )

    assert.equal(requests.length, 2)
    for (const body of requests) {
      assert.match(body, /<SVFROMDATE>20260401<\/SVFROMDATE>/)
      assert.match(body, /<SVTODATE>20261031<\/SVTODATE>/)
    }
    assert.doesNotMatch(packagedBody(xml), /SVFROMDATE|SVTODATE/)
  })

  it("keeps vouchers dated outside the period it asked for", () => {
    // Dropping out-of-range vouchers here would make the export look complete
    // for the requested window. They are packaged as read and flagged later by
    // the manifest review, which is where the operator can see them.
    const vouchers = `<ENVELOPE><HEADER><STATUS>1</STATUS></HEADER><BODY><DATA><TALLYMESSAGE><VOUCHER><DATE>20251231</DATE></VOUCHER><VOUCHER><DATE>20260115</DATE></VOUCHER><VOUCHER><DATE>20260315</DATE></VOUCHER></TALLYMESSAGE></DATA></BODY></ENVELOPE>`
    const january = envelopeOnlyMasterReply
      .replace("20260401", "20260101")
      .replace("20261031", "20260131")

    const xml = combineTallyExports(january, vouchers, { company: "Test Pharmacy" })

    assert.equal(packagedBody(xml).match(/<VOUCHER>/g)?.length, 3)
    assert.match(packagedBody(xml), /<DATE>20251231<\/DATE>/)
    assert.match(packagedBody(xml), /<DATE>20260315<\/DATE>/)
  })

  it("carries the same metadata through a balances-only cut-over", () => {
    const xml = buildMasterOnlyExport(envelopeOnlyMasterReply, { company: "Test Pharmacy" })

    assert.match(packagedBody(xml), /<COMPANYNAME>Test Pharmacy<\/COMPANYNAME>/)
    assert.match(packagedBody(xml), /<SVFROMDATE>20260401<\/SVFROMDATE>/)
    assert.doesNotMatch(packagedBody(xml), /<VOUCHER>/)
  })

  it("still refuses a response that names no company at all", async () => {
    // The wrapper only re-emits what it is told to pin; it must not paper over
    // a response that failed the company check.
    const unverified = envelopeOnlyMasterReply.replace(
      "<SVCURRENTCOMPANY>Test Pharmacy</SVCURRENTCOMPANY>",
      "",
    )
    await assert.rejects(
      exportTallyCompany(config(), async () => new Response(unverified, { status: 200 }), new Date(), {
        probe: async () => true,
      }),
      /TALLY_BRIDGE_COMPANY_UNVERIFIED/,
    )
  })
})

describe("local HTTP bridge", () => {
  it("only serves the exact portal origin and a valid token", async () => {
    const calls = []
    const base = await startServer(async (_url, options) => {
      calls.push(options.body)
      return new Response(calls.length === 1 ? masterReply : pinnedVoucherReply, { status: 200 })
    })

    const wrongOrigin = await fetch(`${base}/api/tally/export`, {
      method: "POST",
      headers: { origin: "https://evil.example", "x-synapse-tally-bridge-token": TOKEN },
    })
    assert.equal(wrongOrigin.status, 403)

    const wrongToken = await fetch(`${base}/api/tally/export`, {
      method: "POST",
      headers: { origin: ORIGIN, "x-synapse-tally-bridge-token": "bad" },
    })
    assert.equal(wrongToken.status, 401)

    const accepted = await fetch(`${base}/api/tally/export`, {
      method: "POST",
      headers: { origin: ORIGIN, "x-synapse-tally-bridge-token": TOKEN },
    })
    assert.equal(accepted.status, 200)
    assert.equal(accepted.headers.get("access-control-allow-origin"), ORIGIN)
    assert.match(await accepted.text(), /<VOUCHER>/)
    assert.equal(calls.length, 2)
  })

  it("sends the period each request states and echoes it back", async () => {
    const requests = []
    const base = await startServer(async (_url, options) => {
      requests.push(options.body)
      return new Response(
        /<ID>All Masters<\/ID>/.test(options.body) ? masterReply : pinnedVoucherReply,
        { status: 200 },
      )
    })

    const response = await fetch(`${base}/api/tally/export?from=2026-01-01&to=2026-01-31`, {
      method: "POST",
      headers: { origin: ORIGIN, "x-synapse-tally-bridge-token": TOKEN },
    })

    assert.equal(response.status, 200)
    assert.equal(requests.length, 2)
    for (const body of requests) {
      assert.match(body, /<SVFROMDATE>20260101<\/SVFROMDATE>/)
      assert.match(body, /<SVTODATE>20260131<\/SVTODATE>/)
    }
    // The portal compares these against what it asked for before accepting
    // the payload; an export with no echo cannot be tied to the request.
    assert.equal(response.headers.get("x-synapse-tally-from"), "20260101")
    assert.equal(response.headers.get("x-synapse-tally-to"), "20260131")
    assert.equal(response.headers.get("x-synapse-tally-company"), "Test Pharmacy")
    assert.equal(response.headers.get("x-synapse-tally-mode"), "opening")
  })

  it("uses the request's start date even when the process was launched with another", async () => {
    const requests = []
    const base = await startServer(async (_url, options) => {
      requests.push(options.body)
      return new Response(
        /<ID>All Masters<\/ID>/.test(options.body) ? masterReply : pinnedVoucherReply,
        { status: 200 },
      )
    })

    const response = await fetch(`${base}/api/tally/export?from=20260401&to=20261031`, {
      method: "POST",
      headers: { origin: ORIGIN, "x-synapse-tally-bridge-token": TOKEN },
    })

    assert.equal(response.status, 200)
    assert.match(requests[0], /<SVFROMDATE>20260401<\/SVFROMDATE>/)
    assert.doesNotMatch(requests[0], /<SVFROMDATE>19000101<\/SVFROMDATE>/)
  })

  it("uses the request's end date even when the process was launched with another", async () => {
    const requests = []
    const base = await startServer(async (_url, options) => {
      requests.push(options.body)
      return new Response(
        /<ID>All Masters<\/ID>/.test(options.body) ? masterReply : pinnedVoucherReply,
        { status: 200 },
      )
    })

    const response = await fetch(`${base}/api/tally/export?from=20260401&to=20261231`, {
      method: "POST",
      headers: { origin: ORIGIN, "x-synapse-tally-bridge-token": TOKEN },
    })

    assert.equal(response.status, 200)
    assert.match(requests[1], /<SVTODATE>20261231<\/SVTODATE>/)
    assert.equal(response.headers.get("x-synapse-tally-to"), "20261231")
  })

  it("does not silently inherit the launch period when a request states none", async () => {
    // A request with no period still exports the launch default, but the echo
    // makes that visible so the portal can refuse a range nobody asked for.
    const requests = []
    const base = await startServer(async (_url, options) => {
      requests.push(options.body)
      return new Response(
        /<ID>All Masters<\/ID>/.test(options.body) ? masterReply : pinnedVoucherReply,
        { status: 200 },
      )
    })

    const response = await fetch(`${base}/api/tally/export`, {
      method: "POST",
      headers: { origin: ORIGIN, "x-synapse-tally-bridge-token": TOKEN },
    })

    assert.equal(response.status, 200)
    assert.match(requests[0], /<SVFROMDATE>19000101<\/SVFROMDATE>/)
    assert.equal(response.headers.get("x-synapse-tally-from"), "19000101")
  })

  it("refuses half a period instead of filling the missing bound in", async () => {
    const calls = []
    const base = await startServer(async (_url, options) => {
      calls.push(options.body)
      return new Response(masterReply)
    })

    for (const query of ["from=20260101", "to=20260131", "from=20260101&to=", "from=&to=20260131"]) {
      const response = await fetch(`${base}/api/tally/export?${query}`, {
        method: "POST",
        headers: { origin: ORIGIN, "x-synapse-tally-bridge-token": TOKEN },
      })
      assert.equal(response.status, 400, query)
      assert.deepEqual(await response.json(), { error: "TALLY_BRIDGE_PERIOD_INCOMPLETE" })
    }
    assert.equal(calls.length, 0)
  })

  it("refuses an impossible or reversed period before asking Tally", async () => {
    const calls = []
    const base = await startServer(async (_url, options) => {
      calls.push(options.body)
      return new Response(masterReply)
    })

    const impossible = await fetch(`${base}/api/tally/export?from=2026-02-30&to=2026-03-01`, {
      method: "POST",
      headers: { origin: ORIGIN, "x-synapse-tally-bridge-token": TOKEN },
    })
    assert.equal(impossible.status, 422)

    const reversed = await fetch(`${base}/api/tally/export?from=20260401&to=20260331`, {
      method: "POST",
      headers: { origin: ORIGIN, "x-synapse-tally-bridge-token": TOKEN },
    })
    assert.equal(reversed.status, 400)
    assert.deepEqual(await reversed.json(), { error: "TALLY_BRIDGE_PERIOD_INVALID" })
    assert.equal(calls.length, 0)
  })

  it("keeps the company pinned when a request names it", async () => {
    const calls = []
    const base = await startServer(async (_url, options) => {
      calls.push(options.body)
      return new Response(
        /<ID>All Masters<\/ID>/.test(options.body) ? masterReply : pinnedVoucherReply,
        { status: 200 },
      )
    })

    const accepted = await fetch(
      `${base}/api/tally/export?from=20260401&to=20261031&company=test%20pharmacy`,
      { method: "POST", headers: { origin: ORIGIN, "x-synapse-tally-bridge-token": TOKEN } },
    )
    assert.equal(accepted.status, 200)
    assert.equal(accepted.headers.get("x-synapse-tally-company"), "Test Pharmacy")

    const refused = await fetch(
      `${base}/api/tally/export?from=20260401&to=20261031&company=Other%20Pharmacy`,
      { method: "POST", headers: { origin: ORIGIN, "x-synapse-tally-bridge-token": TOKEN } },
    )
    assert.equal(refused.status, 422)
    assert.deepEqual(await refused.json(), { error: "TALLY_BRIDGE_COMPANY_MISMATCH" })
    // Two calls from the accepted export; the refused one reached Tally zero times.
    assert.equal(calls.length, 2)
  })

  it("reads masters once and one voucher range per request when asked", async () => {
    const calls = []
    const base = await startServer(async (_url, options) => {
      calls.push(options.body)
      return new Response(
        /<ID>All Masters<\/ID>/.test(options.body) ? masterReply : pinnedVoucherReply,
        { status: 200 },
      )
    })

    const masters = await fetch(
      `${base}/api/tally/export?scope=masters&from=20260101&to=20260131`,
      { method: "POST", headers: { origin: ORIGIN, "x-synapse-tally-bridge-token": TOKEN } },
    )
    assert.equal(masters.status, 200)
    assert.equal(masters.headers.get("x-synapse-tally-scope"), "masters")
    assert.equal(calls.length, 1)
    assert.doesNotMatch(await masters.text(), /<VOUCHER>/)

    const vouchers = await fetch(
      `${base}/api/tally/export?scope=vouchers&from=20260201&to=20260228`,
      { method: "POST", headers: { origin: ORIGIN, "x-synapse-tally-bridge-token": TOKEN } },
    )
    assert.equal(vouchers.status, 200)
    assert.equal(vouchers.headers.get("x-synapse-tally-scope"), "vouchers")
    assert.equal(vouchers.headers.get("x-synapse-tally-from"), "20260201")
    assert.equal(calls.length, 2)
    assert.match(calls[1], /<ID>Day Book<\/ID>/)
    assert.doesNotMatch(calls[1], /<ID>All Masters<\/ID>/)
    assert.match(await vouchers.text(), /<VOUCHER>/)
  })

  it("carries an empty voucher range as an empty document, not a failed export", async () => {
    // A narrowed range may legitimately hold no voucher. Tally answering with
    // an empty DATA must not fail the chunk, which would block the migration
    // on a quiet month for good.
    const emptyDayBook =
      "<ENVELOPE><HEADER><STATUS>1</STATUS></HEADER><BODY><DATA><COMPANY><COMPANYNAME>Test Pharmacy</COMPANYNAME></COMPANY></DATA></BODY></ENVELOPE>"
    const base = await startServer(async () => new Response(emptyDayBook, { status: 200 }))

    const response = await fetch(`${base}/api/tally/export?scope=vouchers&from=20260201&to=20260228`, {
      method: "POST",
      headers: { origin: ORIGIN, "x-synapse-tally-bridge-token": TOKEN },
    })

    assert.equal(response.status, 200)
    const body = await response.text()
    assert.match(body, /<COMPANYNAME>Test Pharmacy<\/COMPANYNAME>/)
    assert.doesNotMatch(body, /<VOUCHER>/)
  })

  it("refuses a scope the bridge cannot serve", async () => {
    const calls = []
    const base = await startServer(async (_url, options) => {
      calls.push(options.body)
      return new Response(masterReply)
    })

    const unknown = await fetch(`${base}/api/tally/export?scope=everything`, {
      method: "POST",
      headers: { origin: ORIGIN, "x-synapse-tally-bridge-token": TOKEN },
    })
    assert.equal(unknown.status, 422)
    assert.deepEqual(await unknown.json(), { error: "TALLY_BRIDGE_SCOPE_INVALID" })

    // A closing cut-over never reads the Day Book, so asking it for vouchers is
    // a contradiction rather than something to guess around.
    const conflict = await fetch(`${base}/api/tally/export?mode=closing&scope=vouchers`, {
      method: "POST",
      headers: { origin: ORIGIN, "x-synapse-tally-bridge-token": TOKEN },
    })
    assert.equal(conflict.status, 422)
    assert.deepEqual(await conflict.json(), { error: "TALLY_BRIDGE_SCOPE_CONFLICT" })
    assert.equal(calls.length, 0)
  })

  it("answers a mid-body timeout with 502 and only the documented code", async () => {
    const base = await startServer(async () => new Response(stalledBody(), { status: 200 }))

    const response = await fetch(`${base}/api/tally/export`, {
      method: "POST",
      headers: { origin: ORIGIN, "x-synapse-tally-bridge-token": TOKEN },
    })

    assert.equal(response.status, 502)
    // Exactly one field with the mapped code: no raw Node error text reaches
    // the operator, and the portal can map this key to a sentence.
    assert.deepEqual(await response.json(), { error: "TALLY_BRIDGE_TALLY_TIMEOUT" })
  })

  it("answers the browser private-network preflight only for an allowed origin", async () => {
    const base = await startServer(async () => new Response(masterReply))
    const response = await fetch(`${base}/api/tally/export`, {
      method: "OPTIONS",
      headers: {
        origin: ORIGIN,
        "access-control-request-method": "POST",
        "access-control-request-private-network": "true",
      },
    })

    assert.equal(response.status, 204)
    assert.equal(response.headers.get("access-control-allow-private-network"), "true")
  })

  it("reports reachability without running an export", async () => {
    const base = await startServer(async () => {
      throw new Error("the status probe must not export")
    })

    const response = await fetch(`${base}/api/tally/status`, {
      headers: { origin: ORIGIN, "x-synapse-tally-bridge-token": TOKEN },
    })

    assert.equal(response.status, 200)
    const status = await response.json()
    assert.deepEqual(
      { ...status, period: undefined },
      {
        bridge: "ok",
        tally: "reachable",
        target: "http://127.0.0.1:9000",
        edition: "unknown",
        installations: [],
        company: "Test Pharmacy",
        period: undefined,
      },
    )
    // The launch default a request with no period of its own would use.
    assert.equal(status.period.from, "19000101")
    assert.match(status.period.to, /^\d{8}$/)
  })

  it("reports Tally as unreachable when its HTTP server does not answer", async () => {
    const base = await startServer(async () => new Response(masterReply), {
      probe: async () => false,
    })

    const response = await fetch(`${base}/api/tally/status`, {
      headers: { origin: ORIGIN, "x-synapse-tally-bridge-token": TOKEN },
    })

    assert.equal(response.status, 200)
    assert.equal((await response.json()).tally, "unreachable")
  })

  it("guards the status probe with the same origin and token as the export", async () => {
    const base = await startServer(async () => new Response(masterReply))

    const wrongOrigin = await fetch(`${base}/api/tally/status`, {
      headers: { origin: "https://evil.example", "x-synapse-tally-bridge-token": TOKEN },
    })
    assert.equal(wrongOrigin.status, 403)

    const wrongToken = await fetch(`${base}/api/tally/status`, {
      headers: { origin: ORIGIN, "x-synapse-tally-bridge-token": "bad" },
    })
    assert.equal(wrongToken.status, 401)
  })

  it("reports the detected Tally edition in status", async () => {
    const base = await startServer(async () => new Response(masterReply), {
      detectInstallations: () => [
        { edition: "prime", executable: "C:\\Program Files\\TallyPrime\\tally.exe" },
      ],
    })

    const response = await fetch(`${base}/api/tally/status`, {
      headers: { origin: ORIGIN, "x-synapse-tally-bridge-token": TOKEN },
    })
    const body = await response.json()

    assert.equal(body.edition, "prime")
    assert.deepEqual(body.installations, ["prime"])
  })

  it("reads only the masters when the page asks for closing balances", async () => {
    let calls = 0
    const base = await startServer(async () => {
      calls += 1
      return new Response(calls === 1 ? masterReply : pinnedVoucherReply, { status: 200 })
    })

    const response = await fetch(`${base}/api/tally/export?mode=closing`, {
      method: "POST",
      headers: { origin: ORIGIN, "x-synapse-tally-bridge-token": TOKEN },
    })

    assert.equal(response.status, 200)
    assert.equal(calls, 1)
    assert.doesNotMatch(await response.text(), /<VOUCHER>/)
  })

  it("lists the open Tally companies and refuses without the token", async () => {
    const companyReply = `<ENVELOPE><HEADER><STATUS>1</STATUS></HEADER><BODY><DATA><COLLECTION><COMPANY NAME="Nakawa Pharmacy"/><COMPANY NAME="Wandegeya &amp; Sons"/></COLLECTION></DATA></BODY></ENVELOPE>`
    const base = await startServer(async () => new Response(companyReply))

    const accepted = await fetch(`${base}/api/tally/companies`, {
      headers: { origin: ORIGIN, "x-synapse-tally-bridge-token": TOKEN },
    })
    assert.equal(accepted.status, 200)
    assert.deepEqual(await accepted.json(), {
      companies: ["Nakawa Pharmacy", "Wandegeya & Sons"],
      edition: "unknown",
    })

    const refused = await fetch(`${base}/api/tally/companies`, {
      headers: { origin: ORIGIN, "x-synapse-tally-bridge-token": "bad" },
    })
    assert.equal(refused.status, 401)
  })

  it("rejects request bodies rather than exposing a general-purpose local proxy", async () => {
    const base = await startServer(async () => new Response(masterReply))
    const response = await fetch(`${base}/api/tally/export`, {
      method: "POST",
      headers: {
        origin: ORIGIN,
        "x-synapse-tally-bridge-token": TOKEN,
        "content-type": "application/json",
      },
      body: JSON.stringify({ url: "http://127.0.0.1:22" }),
    })
    assert.equal(response.status, 400)
    assert.match((await response.json()).error, /does not accept a request body/)
  })
})

describe("setup assistant preflight", () => {
  const companyReply = `<ENVELOPE><HEADER><STATUS>1</STATUS></HEADER><BODY><DATA><COLLECTION><COMPANY NAME="Test Pharmacy"/></COLLECTION></DATA></BODY></ENVELOPE>`

  it("answers the prerequisite report only for the portal origin and a valid token", async () => {
    const base = await startServer(async () => new Response(companyReply))

    const noOrigin = await fetch(`${base}/api/tally/preflight`, {
      headers: { "x-synapse-tally-bridge-token": TOKEN },
    })
    assert.equal(noOrigin.status, 403)

    const wrongToken = await fetch(`${base}/api/tally/preflight`, {
      headers: { origin: ORIGIN, "x-synapse-tally-bridge-token": "bad" },
    })
    assert.equal(wrongToken.status, 401)

    const accepted = await fetch(`${base}/api/tally/preflight`, {
      headers: { origin: ORIGIN, "x-synapse-tally-bridge-token": TOKEN },
    })
    assert.equal(accepted.status, 200)
    const report = await accepted.json()
    assert.equal(report.connector.version, TALLY_CONNECTOR_VERSION)
    assert.equal(report.connector.contractVersion, TALLY_BRIDGE_CONTRACT_VERSION)
    assert.ok(report.checks.some((check) => check.id === "tally_company_open"))
  })

  it("asks Tally only for its company list, never for an export", async () => {
    const requests = []
    const base = await startServer(async (url, init) => {
      requests.push({ url: String(url), body: String(init?.body ?? "") })
      return new Response(companyReply)
    })

    const response = await fetch(`${base}/api/tally/preflight`, {
      headers: { origin: ORIGIN, "x-synapse-tally-bridge-token": TOKEN },
    })
    assert.equal(response.status, 200)
    const report = await response.json()

    const toTally = requests.filter((request) => request.url.startsWith("http://127.0.0.1:9000"))
    assert.equal(toTally.length, 1)
    assert.match(toTally[0].body, /<ID>List of Companies<\/ID>/)
    assert.doesNotMatch(toTally[0].body, /Day Book|All Masters/)

    // The one other outbound request is a bodiless GET of the portal origin.
    const toPortal = requests.filter((request) => request.url === ORIGIN)
    assert.equal(toPortal.length, 1)
    assert.equal(toPortal[0].body, "")

    assert.equal(report.checks.find((check) => check.id === "tally_company_open").status, "passed")
  })

  it("never returns the bridge token or raw Tally XML", async () => {
    const base = await startServer(async () => new Response(companyReply))
    const response = await fetch(`${base}/api/tally/preflight`, {
      headers: { origin: ORIGIN, "x-synapse-tally-bridge-token": TOKEN },
    })
    const body = await response.text()

    assert.equal(body.includes(TOKEN), false)
    assert.equal(/<ENVELOPE|<TALLYMESSAGE|<COLLECTION/i.test(body), false)
  })

  it("refuses a preflight while an export is running", async () => {
    let release
    let firstCall
    const gate = new Promise((resolve) => {
      release = resolve
    })
    const started = new Promise((resolve) => {
      firstCall = resolve
    })
    const base = await startServer(async () => {
      firstCall()
      await gate
      return new Response(masterReply)
    })

    const exported = fetch(`${base}/api/tally/export?mode=masters&from=20261001&to=20261031`, {
      method: "POST",
      headers: { origin: ORIGIN, "x-synapse-tally-bridge-token": TOKEN },
    })
    await started

    const refused = await fetch(`${base}/api/tally/preflight`, {
      headers: { origin: ORIGIN, "x-synapse-tally-bridge-token": TOKEN },
    })
    assert.equal(refused.status, 409)
    assert.match((await refused.json()).error, /already running/)

    release()
    await exported
  })
})

// Raw request so the tests control header casing, duplicate headers and
// headers `fetch` would otherwise normalise. The asset under test is a real
// listening socket, so these are runtime checks, not source reads.
function rawFetch(base, path, { method = "GET", headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const request = httpRequest(new URL(path, base), { method, headers }, (response) => {
      const chunks = []
      response.on("data", (chunk) => chunks.push(chunk))
      response.on("end", () =>
        resolve({
          status: response.statusCode,
          headers: response.headers,
          body: Buffer.concat(chunks).toString("utf8"),
        }),
      )
    })
    request.on("error", reject)
    request.end()
  })
}

describe("connector security — Tally stays read-only", () => {
  const companyReply = `<ENVELOPE><HEADER><STATUS>1</STATUS></HEADER><BODY><DATA><COLLECTION><COMPANY NAME="Test Pharmacy"/></COLLECTION></DATA></BODY></ENVELOPE>`

  // Any one of these in a request the bridge sends to Tally would be a write,
  // an import, or a change to Tally's own state rather than a read.
  const writeMarkers = [
    [/<TALLYREQUEST>(?!Export<\/TALLYREQUEST>)/i, "a Tally request other than Export"],
    [/<ACTION\b/i, "an ACTION element"],
    [/IMPORTDATA/i, "IMPORTDATA"],
    [/<IMPORT\b/i, "an import element"],
    [/ISMODIFY\s*=\s*"Yes"/i, "ISMODIFY with a Yes value"],
    [/<TALLYMESSAGE\b/i, "a TALLYMESSAGE payload"],
    [/<MASTER\b/i, "a MASTER element"],
    [/<SVCURRENTDATE>/i, "a current-date override"],
  ]

  it("issues only read-only Tally requests through every interface", async () => {
    const requests = []
    const base = await startServer(async (url, init) => {
      requests.push({ url: String(url), body: String(init?.body ?? "") })
      if (/List of Companies/.test(String(init?.body ?? ""))) return new Response(companyReply)
      return new Response(/Day Book/.test(String(init?.body ?? "")) ? pinnedVoucherReply : masterReply)
    })

    const calls = [
      ["POST", "/api/tally/export"],
      ["POST", "/api/tally/export?mode=closing"],
      ["POST", "/api/tally/export?scope=masters&from=20260101&to=20260131"],
      ["POST", "/api/tally/export?scope=vouchers&from=20260101&to=20260131"],
      ["GET", "/api/tally/companies"],
      ["GET", "/api/tally/preflight"],
    ]
    for (const [method, path] of calls) {
      const response = await rawFetch(base, path, {
        method,
        headers: { origin: ORIGIN, "x-synapse-tally-bridge-token": TOKEN },
      })
      assert.ok(response.status < 400, `${method} ${path} -> ${response.status}: ${response.body}`)
    }

    // Only the three documented read requests may ever be sent to Tally.
    const reports = new Set()
    for (const request of requests) {
      if (!request.body) continue
      assert.match(request.body, /<TALLYREQUEST>Export<\/TALLYREQUEST>/, request.body)
      assert.match(request.body, /<TYPE>(DATA|Collection)<\/TYPE>/, request.body)
      const id = /<ID>([^<]+)<\/ID>/.exec(request.body)?.[1]
      assert.ok(["All Masters", "Day Book", "List of Companies"].includes(id), `report: ${id}`)
      reports.add(id)
      for (const [pattern, label] of writeMarkers) {
        assert.equal(pattern.test(request.body), false, `${label}: ${request.body}`)
      }
    }
    // Every interface was actually exercised, so the assertions above covered
    // all three request builders rather than a subset of them.
    assert.deepEqual([...reports].sort(), ["All Masters", "Day Book", "List of Companies"])
  })

  it("cannot be steered to another report or a write action by the query string", async () => {
    const bodies = []
    const base = await startServer(async (_url, init) => {
      bodies.push(String(init?.body ?? ""))
      return new Response(/Day Book/.test(String(init?.body ?? "")) ? pinnedVoucherReply : masterReply)
    })

    const response = await rawFetch(
      base,
      "/api/tally/export?scope=masters&report=Import%20Data&id=Import%20Data&action=create&tallyrequest=Import",
      {
        method: "POST",
        headers: { origin: ORIGIN, "x-synapse-tally-bridge-token": TOKEN },
      },
    )

    assert.equal(response.status, 200)
    assert.equal(bodies.length, 1)
    assert.match(bodies[0], /<ID>All Masters<\/ID>/)
    for (const [pattern, label] of writeMarkers) {
      assert.equal(pattern.test(bodies[0]), false, label)
    }
  })

  it("never posts anywhere except the configured Tally origin", async () => {
    const requests = []
    const base = await startServer(async (url, init) => {
      requests.push({ url: String(url), body: String(init?.body ?? "") })
      return new Response(/List of Companies/.test(String(init?.body ?? "")) ? companyReply : masterReply)
    })

    for (const [method, path] of [
      ["POST", "/api/tally/export?mode=closing"],
      ["GET", "/api/tally/companies"],
      ["GET", "/api/tally/preflight"],
    ]) {
      await rawFetch(base, path, {
        method,
        headers: { origin: ORIGIN, "x-synapse-tally-bridge-token": TOKEN },
      })
    }

    const toTally = requests.filter((request) => request.body)
    assert.ok(toTally.length >= 2)
    for (const request of toTally) {
      const url = new URL(request.url)
      assert.equal(url.origin, "http://127.0.0.1:9000", `unexpected host: ${request.url}`)
      assert.equal(url.pathname, "/", `unexpected path: ${request.url}`)
    }
    // The setup check's reachability probe is the only other outbound call, and
    // it is a bodiless GET of the configured portal origin.
    for (const request of requests.filter((entry) => !entry.body)) {
      assert.equal(request.url, ORIGIN)
    }
  })
})

describe("connector security — origin and CORS gate", () => {
  const companyReply = `<ENVELOPE><HEADER><STATUS>1</STATUS></HEADER><BODY><DATA><COLLECTION><COMPANY NAME="Test Pharmacy"/></COLLECTION></DATA></BODY></ENVELOPE>`

  const rejectedOrigins = [
    ["a missing Origin", undefined],
    ["a literal null Origin", "null"],
    ["the right host on another port", "https://pharm.synapseos.tech:8443"],
    ["a host that merely starts with the allowed one", "https://pharm.synapseos.tech.evil.example"],
    ["the allowed host as a path on someone else's", "https://evil.example/pharm.synapseos.tech"],
    ["the right host over http", "http://pharm.synapseos.tech"],
    ["the right host with a trailing slash", "https://pharm.synapseos.tech/"],
    ["a differently-cased host", "https://PHARM.synapseos.tech"],
    ["a malformed value", "not an origin"],
    ["a file: origin", "file://"],
  ]

  it("refuses every origin that is not the exact allowed one, even with a valid token", async () => {
    const calls = []
    const base = await startServer(async (_url, init) => {
      calls.push(String(init?.body ?? ""))
      return new Response(companyReply)
    })

    for (const [label, origin] of rejectedOrigins) {
      for (const path of ["/api/tally/status", "/api/tally/companies", "/api/tally/preflight"]) {
        const headers = { "x-synapse-tally-bridge-token": TOKEN }
        if (origin !== undefined) headers.origin = origin
        const response = await rawFetch(base, path, { headers })
        assert.equal(response.status, 403, `${label} on ${path}`)
        assert.equal(response.headers["access-control-allow-origin"], undefined, label)
        assert.deepEqual(JSON.parse(response.body), { error: "Origin is not allowed." })
      }
    }
    // Not one of those requests reached Tally.
    assert.equal(calls.length, 0)
  })

  it("does not accept Referer, Host or a query parameter in place of Origin", async () => {
    const base = await startServer(async () => new Response(companyReply))

    const refererOnly = await rawFetch(base, "/api/tally/companies", {
      headers: { referer: ORIGIN, "x-synapse-tally-bridge-token": TOKEN },
    })
    assert.equal(refererOnly.status, 403)

    const queryOnly = await rawFetch(
      base,
      `/api/tally/companies?origin=${encodeURIComponent(ORIGIN)}`,
      { headers: { "x-synapse-tally-bridge-token": TOKEN } },
    )
    assert.equal(queryOnly.status, 403)

    // A spoofed Host does not help either: the gate reads only Origin.
    const spoofedHost = await rawFetch(base, "/api/tally/companies", {
      headers: {
        host: "pharm.synapseos.tech",
        referer: ORIGIN,
        "x-synapse-tally-bridge-token": TOKEN,
      },
    })
    assert.equal(spoofedHost.status, 403)
  })

  it("answers a preflight from an untrusted origin without granting anything", async () => {
    const base = await startServer(async () => new Response(companyReply))

    for (const origin of ["https://evil.example", "null", undefined]) {
      const headers = {
        "access-control-request-method": "POST",
        "access-control-request-private-network": "true",
      }
      if (origin !== undefined) headers.origin = origin
      const response = await rawFetch(base, "/api/tally/export", { method: "OPTIONS", headers })
      assert.equal(response.status, 403)
      assert.equal(response.headers["access-control-allow-origin"], undefined)
      assert.equal(response.headers["access-control-allow-private-network"], undefined)
    }
  })

  it("grants private-network access only when the browser asked for it", async () => {
    const base = await startServer(async () => new Response(masterReply))

    const asked = await rawFetch(base, "/api/tally/export", {
      method: "OPTIONS",
      headers: {
        origin: ORIGIN,
        "access-control-request-method": "POST",
        "access-control-request-private-network": "true",
      },
    })
    assert.equal(asked.status, 204)
    assert.equal(asked.headers["access-control-allow-private-network"], "true")
    assert.equal(asked.headers["access-control-allow-origin"], ORIGIN)

    const notAsked = await rawFetch(base, "/api/tally/export", {
      method: "OPTIONS",
      headers: { origin: ORIGIN, "access-control-request-method": "POST" },
    })
    assert.equal(notAsked.status, 204)
    assert.equal(notAsked.headers["access-control-allow-private-network"], undefined)

    const saidNo = await rawFetch(base, "/api/tally/export", {
      method: "OPTIONS",
      headers: {
        origin: ORIGIN,
        "access-control-request-private-network": "false",
      },
    })
    assert.equal(saidNo.headers["access-control-allow-private-network"], undefined)
  })

  it("marks responses as varying by Origin so a cache cannot cross the gate", async () => {
    const base = await startServer(async () => new Response(companyReply))

    const allowed = await rawFetch(base, "/api/tally/companies", {
      headers: { origin: ORIGIN, "x-synapse-tally-bridge-token": TOKEN },
    })
    assert.equal(allowed.status, 200)
    assert.equal(allowed.headers["access-control-allow-origin"], ORIGIN)
    assert.match(allowed.headers.vary ?? "", /origin/i)
    assert.equal(allowed.headers["cache-control"], "no-store")
  })
})

describe("connector security — token gate", () => {
  const companyReply = `<ENVELOPE><HEADER><STATUS>1</STATUS></HEADER><BODY><DATA><COLLECTION><COMPANY NAME="Test Pharmacy"/></COLLECTION></DATA></BODY></ENVELOPE>`
  const endpoints = [
    ["GET", "/api/tally/status"],
    ["GET", "/api/tally/companies"],
    ["GET", "/api/tally/preflight"],
    ["POST", "/api/tally/export"],
  ]

  it("requires the token on every endpoint and reads it only from the header", async () => {
    const calls = []
    const base = await startServer(async (_url, init) => {
      calls.push(String(init?.body ?? ""))
      return new Response(companyReply)
    })

    const badTokens = [
      ["no token", undefined],
      ["one character short", TOKEN.slice(1)],
      ["one character long", `${TOKEN}0`],
      ["a different token of the right length", "f".repeat(64)],
      ["an empty token", ""],
    ]

    for (const [label, token] of badTokens) {
      for (const [method, path] of endpoints) {
        const headers = { origin: ORIGIN }
        if (token !== undefined) headers["x-synapse-tally-bridge-token"] = token
        const response = await rawFetch(base, path, { method, headers })
        assert.equal(response.status, 401, `${label} on ${method} ${path}`)
        assert.deepEqual(JSON.parse(response.body), { error: "Invalid bridge token." })
        assert.equal(response.headers["access-control-allow-origin"], ORIGIN)
      }
    }

    // A token in the query string is not a token.
    const inQuery = await rawFetch(base, `/api/tally/companies?token=${TOKEN}`, {
      headers: { origin: ORIGIN },
    })
    assert.equal(inQuery.status, 401)

    // Two duplicate header lines become one mismatched value, not a bypass.
    const duplicated = await new Promise((resolve, reject) => {
      const request = httpRequest(
        new URL("/api/tally/companies", base),
        { headers: { origin: ORIGIN } },
        (response) => {
          response.resume()
          response.on("end", () => resolve(response.statusCode))
        },
      )
      request.on("error", reject)
      request.setHeader("x-synapse-tally-bridge-token", [TOKEN, "f".repeat(64)])
      request.end()
    })
    assert.equal(duplicated, 401)

    assert.equal(calls.length, 0, "no rejected request may reach Tally")
  })

  it("rejects an unknown path before it reads the token", async () => {
    const base = await startServer(async () => new Response(companyReply))

    const unknown = await rawFetch(base, "/api/tally/proxy", {
      headers: { origin: ORIGIN, "x-synapse-tally-bridge-token": TOKEN },
    })
    assert.equal(unknown.status, 404)

    // The two endpoints that exist are reachable with their own method only.
    const wrongMethod = await rawFetch(base, "/api/tally/status", {
      method: "POST",
      headers: { origin: ORIGIN, "x-synapse-tally-bridge-token": TOKEN },
    })
    assert.equal(wrongMethod.status, 404)
  })
})

describe("connector security — loopback binding", () => {
  it("cannot be told to listen on a public interface", () => {
    const configured = config({ SYNAPSE_TALLY_BRIDGE_HOST: "0.0.0.0", SYNAPSE_TALLY_BIND_HOST: "0.0.0.0" })
    assert.equal(configured.bridgeBindHost, "127.0.0.1")

    const cli = readFileSync(new URL("./cli.mjs", import.meta.url), "utf8")
    assert.match(cli, /server\.listen\(config\.bridgePort, config\.bridgeBindHost/)
    assert.equal(cli.includes("0.0.0.0"), false)
  })

  it("reachable only at the loopback address it reports", async () => {
    const base = await startServer(async () => new Response(masterReply))
    assert.match(base, /^http:\/\/127\.0\.0\.1:\d+$/)
  })
})
