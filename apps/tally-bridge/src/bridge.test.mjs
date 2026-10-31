import assert from "node:assert/strict"
import { afterEach, describe, it } from "node:test"
import { join } from "node:path"
import {
  buildTallyExportRequest,
  combineTallyExports,
  createTallyBridgeServer,
  ensureTallyHttpServer,
  exportTallyCompany,
  readBridgeConfig,
} from "./bridge.mjs"

const TOKEN = "0123456789abcdef".repeat(4)
const ORIGIN = "https://pharm.synapseos.tech"
const masterReply = `<ENVELOPE><HEADER><STATUS>1</STATUS></HEADER><BODY><DATA><TALLYMESSAGE><COMPANY><COMPANYNAME>Test Pharmacy</COMPANYNAME></COMPANY><LEDGER NAME="Cash"/></TALLYMESSAGE></DATA></BODY></ENVELOPE>`
const voucherReply = `<ENVELOPE><HEADER><STATUS>1</STATUS></HEADER><BODY><DATA><TALLYMESSAGE><VOUCHER><DATE>20261001</DATE></VOUCHER></TALLYMESSAGE></DATA></BODY></ENVELOPE>`
const servers = []

function config(overrides = {}) {
  return readBridgeConfig({
    SYNAPSE_TALLY_BRIDGE_TOKEN: TOKEN,
    SYNAPSE_TALLY_ALLOWED_ORIGINS: ORIGIN,
    SYNAPSE_TALLY_TARGET_HOST: "127.0.0.1",
    ...overrides,
  })
}

async function startServer(handler) {
  const server = createTallyBridgeServer(
    config({ SYNAPSE_TALLY_BRIDGE_PORT: "17891" }),
    handler,
    { probe: async () => true },
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
        return new Response(requests.length === 1 ? masterReply : voucherReply, { status: 200 })
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
    assert.match(requests[1].body, new RegExp(`<SVTODATE>${expectedLocalDate}</SVTODATE>`))
    assert.equal(requests[0].redirect, "error")
    assert.match(xml, /<COMPANYNAME>Test Pharmacy<\/COMPANYNAME>/)
    assert.match(xml, /<VOUCHER>/)
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
})

describe("local HTTP bridge", () => {
  it("only serves the exact portal origin and a valid token", async () => {
    const calls = []
    const base = await startServer(async (_url, options) => {
      calls.push(options.body)
      return new Response(calls.length === 1 ? masterReply : voucherReply, { status: 200 })
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
