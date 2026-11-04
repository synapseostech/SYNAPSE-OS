/**
 * The bridge, over a real socket.
 *
 * Every other test in this folder hands the client a fake `fetch`. This one
 * starts a real HTTP listener serving Tally-shaped XML, starts the real
 * connector as its own process, and lets the real client talk to it. Nothing
 * between the portal and the response is stubbed.
 *
 * The last case follows one failure all the way to the server: the code the
 * operator sees in a toast is carried into a beacon body and comes back out as
 * a single `[pharmacy][tally]` log line. That is the path the cut-over depends
 * on when Tally misbehaves on a Monday morning.
 */

import { spawn, type ChildProcess } from "node:child_process"
import { randomBytes } from "node:crypto"
import { createServer } from "node:net"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { NextRequest } from "next/server"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const m = vi.hoisted(() => ({
  auth: null as unknown,
}))

vi.mock("@/lib/api-auth", () => ({
  requirePharmacyPermission: vi.fn(async () => m.auth),
}))
vi.mock("@/lib/supabase/admin", () => ({
  get supabaseAdmin() {
    return {}
  },
}))
vi.mock("@/lib/distributed-rate-limit", () => ({
  consumeRateLimits: vi.fn(async () => ({ allowed: true, retryAfter: 0 })),
}))

import { POST as postDiagnostic } from "@/app/api/admin/tally/diagnostics/route"
import { TallyBridgeError, requestBridgeExport, type TallyBridgeExport } from "../bridge-client"
import { readTallyDocument } from "../source"
import { diagnosticFrom, reportTallyFailure } from "../diagnostics"

const HERE = dirname(fileURLToPath(import.meta.url))
const APPS = resolve(HERE, "../../../..")
const REPO = resolve(APPS, "..")
const FAKE_TALLY = resolve(APPS, "tally-bridge/scripts/fake-tally.mjs")
const BRIDGE_CLI = resolve(APPS, "tally-bridge/src/cli.mjs")

const ORIGIN = "https://pharm.synapseos.tech"
const COMPANY = "Synthetic Pharmacy Ltd"
const PERIOD = { from: "2026-01-01", to: "2026-03-31" }

const AUTHORISED = {
  ok: true,
  tenantId: "tenant-1",
  session: {
    user: { id: "user-1" },
    role: "pharmacy_admin",
    pharmacyRole: "pharmacy_admin",
    permissions: [],
    isAdmin: false,
  },
}

const children: ChildProcess[] = []

afterEach(async () => {
  while (children.length > 0) {
    const child = children.pop()
    if (!child || child.exitCode !== null || child.signalCode !== null) continue
    const exited = new Promise((done) => child.once("exit", done))
    child.kill("SIGTERM")
    await Promise.race([exited, new Promise((done) => setTimeout(done, 3000))])
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL")
  }
})

function childEnv() {
  const env = { ...process.env }
  delete env.NODE_OPTIONS
  return env
}

function spawnChild(command: string, args: string[], env: Record<string, string | undefined>) {
  const child = spawn(process.execPath, [command, ...args], {
    cwd: REPO,
    env: { ...childEnv(), ...env },
    stdio: ["ignore", "pipe", "pipe"],
  })
  children.push(child)
  return child
}

function waitForPattern(child: ChildProcess, pattern: RegExp, timeoutMs = 10_000) {
  return new Promise<RegExpExecArray>((done, reject) => {
    let seen = ""
    const timer = setTimeout(() => {
      cleanup()
      reject(new Error(`did not report readiness within ${timeoutMs}ms: ${seen.trim() || "no output"}`))
    }, timeoutMs)
    const onData = (chunk: Buffer) => {
      seen += String(chunk)
      const match = pattern.exec(seen)
      if (match) {
        cleanup()
        done(match)
      }
    }
    const onExit = (code: number | null) => {
      cleanup()
      reject(new Error(`exited with ${code} before it was ready: ${seen.trim()}`))
    }
    function cleanup() {
      clearTimeout(timer)
      child.stdout?.off("data", onData)
      child.stderr?.off("data", onData)
      child.off("exit", onExit)
    }
    child.stdout?.on("data", onData)
    child.stderr?.on("data", onData)
    child.once("exit", onExit)
  })
}

function freePort() {
  return new Promise<number>((done, reject) => {
    const probe = createServer()
    probe.once("error", reject)
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address()
      probe.close(() => done(typeof address === "object" && address ? address.port : 0))
    })
  })
}

type Bridge = { baseUrl: string; token: string }

/**
 * A fresh fake Tally and a fresh bridge process per scenario. Pinning, the
 * export mutex and the period defaults are all process state, so a reused
 * process would not be rehearsing a cut-over morning.
 */
async function withBridge(mode: string, run: (bridge: Bridge) => Promise<void>) {
  const tallyPort = await freePort()
  const bridgePort = await freePort()
  let fake: ChildProcess | undefined
  if (mode !== "unavailable") {
    fake = spawnChild(FAKE_TALLY, [], {
      SYNAPSE_FAKE_TALLY_MODE: mode,
      SYNAPSE_FAKE_TALLY_PORT: String(tallyPort),
    })
    await waitForPattern(fake, /listening on http:\/\/127\.0\.0\.1:(\d+)/)
  }
  const token = randomBytes(32).toString("hex")
  const bridge = spawnChild(BRIDGE_CLI, [], {
    SYNAPSE_TALLY_BRIDGE_TOKEN: token,
    SYNAPSE_TALLY_ALLOWED_ORIGINS: ORIGIN,
    SYNAPSE_TALLY_TARGET_HOST: "127.0.0.1",
    SYNAPSE_TALLY_TARGET_PORT: String(tallyPort),
    SYNAPSE_TALLY_BRIDGE_PORT: String(bridgePort),
    SYNAPSE_TALLY_COMPANY: COMPANY,
    SYNAPSE_TALLY_EXECUTABLE: "",
  })
  await waitForPattern(bridge, /listening at http:\/\/127\.0\.0\.1:\d+/)
  try {
    await run({ baseUrl: `http://127.0.0.1:${bridgePort}`, token })
  } finally {
    if (fake && fake.exitCode === null && fake.signalCode === null) fake.kill("SIGTERM")
  }
}

/**
 * A browser sends `Origin` on this cross-origin request; Node's fetch does not,
 * and the bridge refuses a request without one. This adds the header the
 * browser would have sent and changes nothing else — the request still goes
 * over a real socket to the real bridge.
 */
const browserFetch: typeof fetch = (input, init) =>
  fetch(input, {
    ...init,
    headers: { ...((init?.headers ?? {}) as Record<string, string>), origin: ORIGIN },
  })

function voucherCount(xml: string): number {
  return (xml.match(/<VOUCHER\b/g) ?? []).length
}

describe("the bridge over a real socket", () => {
  it("hands the portal a verified export it can attribute", async () => {
    await withBridge("ok", async ({ baseUrl, token }) => {
      const exported = await requestBridgeExport({
        fetchImpl: browserFetch,
        token,
        baseUrl,
        mode: "opening",
        company: COMPANY,
        period: PERIOD,
        scope: "vouchers",
      })

      expect(exported.company).toBe(COMPANY)
      expect(exported.period).toEqual(PERIOD)
      expect(exported.mode).toBe("opening")
      expect(exported.scope).toBe("vouchers")
      expect(voucherCount(exported.xml)).toBe(5)
      expect(exported.bytes).toBe(new TextEncoder().encode(exported.xml).byteLength)
    })
  }, 20_000)

  it("parses what the bridge returned into the records a cut-over needs", async () => {
    await withBridge("ok", async ({ baseUrl, token }) => {
      const exported: TallyBridgeExport = await requestBridgeExport({
        fetchImpl: browserFetch,
        token,
        baseUrl,
        mode: "opening",
        company: COMPANY,
        period: PERIOD,
        scope: "vouchers",
      })
      const { format, document } = readTallyDocument(
        new TextEncoder().encode(exported.xml),
        "rehearsal.xml",
      )

      expect(format).toBe("xml")
      expect(document.company).toBe(COMPANY)
      expect(document.vouchers).toHaveLength(5)
      expect(document.warnings).toEqual([])
      const ledgerLines = document.vouchers.flatMap((voucher) => voucher.ledgerLines)
      expect(ledgerLines.length).toBeGreaterThanOrEqual(10)
      expect(ledgerLines.some((line) => line.side === "debit")).toBe(true)
      expect(ledgerLines.some((line) => line.side === "credit")).toBe(true)
    })
  }, 20_000)

  it("treats a range with no vouchers as an empty export, not a failure", async () => {
    await withBridge("ok", async ({ baseUrl, token }) => {
      const exported = await requestBridgeExport({
        fetchImpl: browserFetch,
        token,
        baseUrl,
        mode: "opening",
        company: COMPANY,
        period: { from: "2026-01-01", to: "2026-01-05" },
        scope: "vouchers",
      })

      expect(voucherCount(exported.xml)).toBe(0)
      const { document } = readTallyDocument(new TextEncoder().encode(exported.xml), "empty.xml")
      expect(document.vouchers).toHaveLength(0)
      expect(document.company).toBe(COMPANY)
    })
  }, 20_000)

  it("refuses a payload that names no company, with the code the operator sees", async () => {
    await withBridge("no-company", async ({ baseUrl, token }) => {
      const attempt = requestBridgeExport({
        fetchImpl: browserFetch,
        token,
        baseUrl,
        mode: "opening",
        company: COMPANY,
        period: PERIOD,
        scope: "vouchers",
      })

      await expect(attempt).rejects.toBeInstanceOf(TallyBridgeError)
      await expect(attempt).rejects.toMatchObject({
        code: "TALLY_BRIDGE_COMPANY_UNVERIFIED",
        status: 422,
      })
    })
  }, 20_000)

  it("turns that refusal into one server-side log line the portal can grep", async () => {
    m.auth = AUTHORISED

    // The page runs in a browser; the beacon helper is a no-op without a window.
    vi.stubGlobal("window", {})

    await withBridge("no-company", async ({ baseUrl, token }) => {
      const refusal = await requestBridgeExport({
        fetchImpl: browserFetch,
        token,
        baseUrl,
        mode: "opening",
        company: COMPANY,
        period: PERIOD,
        scope: "vouchers",
      }).catch((error: unknown) => error)

      expect(refusal).toBeInstanceOf(TallyBridgeError)

      const beacon = vi.fn(async () => new Response(null, { status: 202 }))
      vi.stubGlobal("fetch", beacon)
      reportTallyFailure({
        step: "extraction",
        outcome: "failed",
        ...diagnosticFrom(refusal),
        sessionId: "session-1",
      })
      expect(beacon).toHaveBeenCalledTimes(1)

      const [url, init] = beacon.mock.calls[0] as unknown as [string, RequestInit]
      expect(url).toBe("/api/admin/tally/diagnostics")

      vi.unstubAllGlobals()

      const logged = vi.spyOn(console, "error").mockImplementation(() => {})
      const response = await postDiagnostic(
        new NextRequest(new URL(url, "http://localhost"), {
          method: "POST",
          body: init.body as string,
        }),
      )
      expect(response.status).toBe(202)

      const lines = logged.mock.calls
        .map((call) => String(call[0]))
        .filter((line) => line.includes("tally.client.failed"))
        .map((line) => JSON.parse(line.replace("[pharmacy][tally] ", "")) as Record<string, unknown>)
      expect(lines).toHaveLength(1)
      expect(lines[0]).toMatchObject({
        event: "tally.client.failed",
        step: "extraction",
        outcome: "failed",
        code: "TALLY_BRIDGE_COMPANY_UNVERIFIED",
        status: 422,
        sessionId: "session-1",
        tenantId: "tenant-1",
      })
      logged.mockRestore()
    })
  }, 20_000)
})

describe("the bridge's own diagnostics", () => {
  beforeEach(() => {
    m.auth = AUTHORISED
  })

  it("refuses an export when Tally is not listening at all", async () => {
    await withBridge("unavailable", async ({ baseUrl, token }) => {
      const attempt = requestBridgeExport({
        fetchImpl: browserFetch,
        token,
        baseUrl,
        mode: "opening",
        company: COMPANY,
        period: PERIOD,
        scope: "masters",
      })
      await expect(attempt).rejects.toMatchObject({ code: "TALLY_BRIDGE_TALLY_UNAVAILABLE" })
    })
  }, 20_000)

  it("reports Tally as unreachable on the status probe without failing the bridge", async () => {
    await withBridge("unavailable", async ({ baseUrl, token }) => {
      const response = await browserFetch(`${baseUrl}/api/tally/status`, {
        headers: { "x-synapse-tally-bridge-token": token },
      })
      expect(response.status).toBe(200)
      await expect(response.json()).resolves.toMatchObject({
        bridge: "ok",
        tally: "unreachable",
      })
    })
  }, 20_000)
})
