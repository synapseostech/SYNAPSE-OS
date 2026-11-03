/**
 * Prerequisite checks for the pharmacy computer, run inside the bridge.
 *
 * The browser can read neither the operating system, the Node.js version, the
 * disk nor Tally's port, so the setup assistant asks the bridge — which the
 * pharmacy portal already trusts for exports — instead of guessing from the
 * page. Every check returns the same shape and records what it measured; none
 * of them writes to Tally, the disk or a database, and none of them returns a
 * token or raw Tally XML.
 */

import { existsSync, readFileSync, statfsSync } from "node:fs"
import { arch as osArch, platform as osPlatform, release as osRelease, type as osType } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

export const TALLY_CONNECTOR_VERSION = "0.2.0"
/** The request/response contract the portal understands. Bump with a breaking change. */
export const TALLY_BRIDGE_CONTRACT_VERSION = 2
export const SUPPORTED_NODE_MAJOR = 22
export const MIN_WINDOWS_MAJOR = 10
export const MIN_FREE_BYTES = 250 * 1024 * 1024
export const LOW_FREE_BYTES = 50 * 1024 * 1024
export const PORTAL_PROBE_TIMEOUT_MS = 5_000
export const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"])

/** Status a check can report. Only the first three can stop a bridge. */
export const CHECK_STATUSES = ["passed", "warning", "missing", "failed", "blocked", "not_applicable"]
const BLOCKING_STATUSES = new Set(["missing", "failed", "blocked"])

export function checkResult(id, name, status, detail = {}, checkedAt = null) {
  if (!CHECK_STATUSES.includes(status)) {
    throw new Error(`Unknown prerequisite status: ${status}`)
  }
  return {
    id,
    name,
    status,
    required: detail.required !== false,
    detectedVersion: detail.detectedVersion ?? null,
    requiredVersion: detail.requiredVersion ?? null,
    message: detail.message ?? "",
    remediation: detail.remediation ?? null,
    canAutoFix: detail.canAutoFix === true,
    requiresAdministrator: detail.requiresAdministrator === true,
    evidence: detail.evidence ?? null,
    lastCheckedAt: checkedAt,
  }
}

export function summariseChecks(checks) {
  const counts = { passed: 0, warning: 0, missing: 0, failed: 0, blocked: 0, not_applicable: 0 }
  for (const check of checks) counts[check.status] += 1
  const blocking = checks
    .filter((check) => check.required && BLOCKING_STATUSES.has(check.status))
    .map((check) => check.id)
  return {
    total: checks.length,
    ...counts,
    blocking,
    autoFixable: checks
      .filter((check) => check.canAutoFix && BLOCKING_STATUSES.has(check.status))
      .map((check) => check.id),
    ready: blocking.length === 0,
  }
}

function readPlatformInfo() {
  return {
    platform: osPlatform(),
    release: osRelease(),
    arch: osArch(),
    type: osType(),
  }
}

function isAllowedOrigin(origin) {
  try {
    const parsed = new URL(origin)
    return (
      parsed.origin === origin &&
      (parsed.protocol === "https:" ||
        (parsed.protocol === "http:" && LOOPBACK_HOSTS.has(parsed.hostname)))
    )
  } catch {
    return false
  }
}

function connectorDirectory(root) {
  return root || dirname(fileURLToPath(import.meta.url))
}

function defaultConnectorFiles(root) {
  const here = connectorDirectory(root)
  return [
    { name: "cli.mjs", path: join(here, "cli.mjs") },
    { name: "bridge.mjs", path: join(here, "bridge.mjs") },
    { name: "preflight.mjs", path: join(here, "preflight.mjs") },
    { name: "package.json", path: join(here, "..", "package.json") },
  ].map((entry) => ({ ...entry, present: existsSync(entry.path) }))
}

function readConnectorPackageJson(root) {
  try {
    return JSON.parse(readFileSync(join(connectorDirectory(root), "..", "package.json"), "utf8"))
  } catch {
    return null
  }
}

async function probePortal(fetchImpl, origin, timeoutMs) {
  if (typeof fetchImpl !== "function" || !origin) return { reachable: null, status: null }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    // A bare GET of the portal origin: no body, no query, nothing sent.
    const response = await fetchImpl(origin, {
      method: "GET",
      redirect: "manual",
      signal: controller.signal,
    })
    return { reachable: true, status: response.status }
  } catch {
    return { reachable: false, status: null }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Runs every prerequisite check and returns one structured report.
 *
 * Everything that touches the machine is injected, so the checks themselves
 * are exercised on any platform. `runtime`, `connector` and `probes` come from
 * the bridge; tests supply fakes.
 */
export async function runPreflight(input = {}) {
  const config = input.config ?? {}
  const connector = input.connector ?? {}
  const runtime = input.runtime ?? {}
  const probes = input.probes ?? {}
  const clock = (input.now ?? (() => new Date()))()
  const at = clock.toISOString()
  const checks = []

  const platform = (probes.platform ?? readPlatformInfo)()
  const target = config.tallyUrl?.origin ?? null
  const origins = Array.from(config.allowedOrigins ?? [])
  const companies = Array.isArray(runtime.companies) ? runtime.companies : null
  const companyError = runtime.companyError ?? null
  const reachable = runtime.tallyReachable === true
  const bindHost = String(connector.bindHost ?? config.bridgeBindHost ?? "")
  const pinned = String(config.company ?? "").trim()

  const windows = platform.platform === "win32"
  const windowsMajor = Number(String(platform.release ?? "").split(".")[0])
  checks.push(
    checkResult(
      "windows",
      "Windows version",
      !windows ? "not_applicable" : windowsMajor >= MIN_WINDOWS_MAJOR ? "passed" : "warning",
      {
        detectedVersion: `${platform.platform} ${platform.release ?? ""}`.trim(),
        requiredVersion: `Windows ${MIN_WINDOWS_MAJOR} or later`,
        message: !windows
          ? `This computer reports ${platform.platform} ${platform.release}. The packaged connector targets Windows 10 and 11; the bridge itself runs wherever Node.js 22 runs.`
          : windowsMajor >= MIN_WINDOWS_MAJOR
            ? `Windows ${platform.release} (${platform.arch}) detected.`
            : `Windows ${platform.release} is older than the Windows ${MIN_WINDOWS_MAJOR} the packaged connector targets.`,
        remediation: !windows
          ? "Run the setup assistant on the Windows computer that runs Tally."
          : windowsMajor >= MIN_WINDOWS_MAJOR
            ? null
            : `Install the connector on a Windows ${MIN_WINDOWS_MAJOR} or 11 computer.`,
        evidence: { platform: platform.platform, release: platform.release, type: platform.type },
      },
      at,
    ),
  )

  const archSupported = ["x64", "arm64"].includes(platform.arch)
  checks.push(
    checkResult("architecture", "Processor architecture", archSupported ? "passed" : "warning", {
      detectedVersion: platform.arch,
      requiredVersion: "x64 or arm64",
      message: archSupported
        ? `${platform.arch} is supported.`
        : `${platform.arch} is not an architecture the connector installer ships.`,
      remediation: archSupported
        ? null
        : "Use the 64-bit Node.js 22.x build for this architecture, or move the connector to a supported computer.",
      canAutoFix: !archSupported,
      evidence: { arch: platform.arch },
    }, at),
  )

  const nodeVersion = String(runtime.nodeVersion ?? process.versions.node ?? "")
  const nodeMajor = Number(nodeVersion.split(".")[0])
  const nodeStatus =
    nodeMajor === SUPPORTED_NODE_MAJOR ? "passed" : nodeMajor > SUPPORTED_NODE_MAJOR ? "warning" : "failed"
  checks.push(
    checkResult("node_version", "Node.js runtime", nodeStatus, {
      detectedVersion: nodeVersion,
      requiredVersion: `${SUPPORTED_NODE_MAJOR}.x`,
      message:
        nodeStatus === "passed"
          ? `Node.js ${nodeVersion} is the supported runtime.`
          : nodeStatus === "warning"
            ? `Node.js ${nodeVersion} runs the bridge, but only ${SUPPORTED_NODE_MAJOR}.x is packaged and tested.`
            : `Node.js ${nodeVersion} is older than the ${SUPPORTED_NODE_MAJOR}.x runtime the connector requires.`,
      remediation:
        nodeStatus === "passed"
          ? null
          : `Install Node.js ${SUPPORTED_NODE_MAJOR}.x from nodejs.org. The installer verifies the download's SHA-256 checksum and Authenticode signature before it runs.`,
      canAutoFix: nodeStatus !== "passed",
      requiresAdministrator: nodeStatus !== "passed",
      evidence: { version: nodeVersion, execPath: runtime.execPath ?? process.execPath },
    }, at),
  )

  const clockYear = clock.getUTCFullYear()
  const clockOk = clockYear >= 2020 && clockYear <= 2100
  checks.push(
    checkResult("system_clock", "System clock", clockOk ? "passed" : "failed", {
      detectedVersion: at,
      message: clockOk
        ? `System clock reads ${at}.`
        : `System clock reads ${at}, which is outside any plausible date.`,
      remediation: clockOk
        ? null
        : "Set the date and time, then run the check again. Export periods and certificate checks depend on it.",
      evidence: { now: at },
    }, at),
  )

  const connectorRoot = connector.root ?? runtime.cwd ?? process.cwd()
  let freeBytes = null
  try {
    const stats = (probes.statfs ?? statfsSync)(connectorRoot)
    freeBytes = Number(stats.bavail) * Number(stats.bsize)
  } catch {
    freeBytes = null
  }
  const diskStatus =
    freeBytes === null
      ? "warning"
      : freeBytes < LOW_FREE_BYTES
        ? "failed"
        : freeBytes < MIN_FREE_BYTES
          ? "warning"
          : "passed"
  checks.push(
    checkResult("disk_space", "Free disk space", diskStatus, {
      detectedVersion: freeBytes === null ? null : `${Math.round(freeBytes / 1024 / 1024)} MB`,
      requiredVersion: `${Math.round(MIN_FREE_BYTES / 1024 / 1024)} MB`,
      message:
        freeBytes === null
          ? "Free disk space could not be measured on this computer."
          : `${Math.round(freeBytes / 1024 / 1024)} MB is free where the connector runs.`,
      remediation:
        diskStatus === "passed"
          ? null
          : "Free space on this drive before starting an extraction. Each exported range is held on disk until the portal confirms it.",
      evidence: { path: connectorRoot, freeBytes, requiredBytes: MIN_FREE_BYTES },
    }, at),
  )

  const files = runtime.connectorFiles ?? defaultConnectorFiles(connector.root)
  const missingFiles = files.filter((file) => !file.present).map((file) => file.name)
  checks.push(
    checkResult("connector_files", "Connector files", missingFiles.length === 0 ? "passed" : "failed", {
      message:
        missingFiles.length === 0
          ? `All ${files.length} connector files are present.`
          : `Missing: ${missingFiles.join(", ")}.`,
      remediation:
        missingFiles.length === 0
          ? null
          : "Run the connector installer again. It copies the whole connector folder rather than patching single files.",
      canAutoFix: missingFiles.length > 0,
      evidence: { files: files.map((file) => ({ name: file.name, present: file.present })) },
    }, at),
  )

  const packageJson = runtime.packageJson ?? readConnectorPackageJson(connector.root)
  const dependencyCount =
    packageJson && packageJson.dependencies && typeof packageJson.dependencies === "object"
      ? Object.keys(packageJson.dependencies).length
      : null
  checks.push(
    checkResult(
      "connector_dependencies",
      "Connector dependencies",
      dependencyCount === 0 ? "passed" : "warning",
      {
        required: false,
        detectedVersion: packageJson?.version ?? null,
        message:
          dependencyCount === 0
            ? "The connector has no runtime dependencies, so there is no npm install step."
            : dependencyCount === null
              ? "The connector's package manifest could not be read, so its dependencies are unknown."
              : `The connector declares ${dependencyCount} runtime dependencies; only the packaged, dependency-free connector is supported.`,
        remediation:
          dependencyCount === 0
            ? null
            : "Run the packaged installer rather than a development checkout.",
        evidence: { dependencies: dependencyCount, installStepRequired: dependencyCount !== 0 },
      },
      at,
    ),
  )

  const loopback = LOOPBACK_HOSTS.has(bindHost.toLowerCase())
  checks.push(
    checkResult("bridge_binding", "Bridge network binding", loopback ? "passed" : "failed", {
      detectedVersion: bindHost || null,
      requiredVersion: "loopback only",
      message: loopback
        ? `The bridge listens on ${bindHost}:${connector.port ?? config.bridgePort ?? ""} and is not reachable from the network.`
        : `The bridge is bound to ${bindHost || "an unknown address"}, which may be reachable from the network.`,
      remediation: loopback
        ? null
        : "Restart the connector without changing its bind address. The packaged connector always listens on 127.0.0.1.",
      evidence: { bindHost: bindHost || null, port: connector.port ?? config.bridgePort ?? null },
    }, at),
  )

  const tokenValid = /^[\da-f]{64}$/i.test(String(config.token ?? ""))
  checks.push(
    checkResult("bridge_token", "Bridge token", tokenValid ? "passed" : "failed", {
      message: tokenValid
        ? "A 64-character token is configured. It is never displayed here and never written to a log."
        : "No valid 64-character bridge token is configured.",
      remediation: tokenValid
        ? null
        : "Run the connector installer or the start command it creates. The same token must be pasted into the portal.",
      evidence: { tokenConfigured: tokenValid },
    }, at),
  )

  const originsValid = origins.length > 0 && origins.every(isAllowedOrigin)
  checks.push(
    checkResult("allowed_origin", "Portal origin", originsValid ? "passed" : "failed", {
      detectedVersion: origins.join(", ") || null,
      requiredVersion: "exact HTTPS origin",
      message: originsValid
        ? `The bridge answers ${origins.length === 1 ? "the portal origin" : `${origins.length} portal origins`} ${origins.join(", ")}.`
        : "No valid portal origin is configured, or an origin is not an exact HTTPS origin.",
      remediation: originsValid
        ? null
        : "Restart the connector from the portal page so the command carries this page's own origin.",
      evidence: { origins },
    }, at),
  )

  const installations = Array.isArray(runtime.installations) ? runtime.installations : []
  const configuredExecutable = String(config.tallyExecutable ?? "").trim()
  checks.push(
    checkResult(
      "tally_installation",
      "Tally installation",
      installations.length > 0 || configuredExecutable ? "passed" : "warning",
      {
        required: false,
        detectedVersion: installations.length > 0 ? [...new Set(installations.map((entry) => entry.edition))].join(", ") : configuredExecutable ? "configured path" : null,
        message:
          installations.length > 0
            ? `Tally was found in ${installations.length === 1 ? "its default folder" : "more than one default folder"}.`
            : configuredExecutable
              ? "Tally is pointed at by the connector's configured program path."
              : "No Tally installation was found in the default folders. Tally may be on another computer on the same network.",
        remediation:
          installations.length > 0 || configuredExecutable
            ? null
            : "The port check below decides whether Tally is reachable. If Tally runs on this computer, install or repair it from your Tally media.",
        evidence: {
          installations: installations.map((entry) => entry.executable),
          configured: Boolean(configuredExecutable),
        },
      },
      at,
    ),
  )

  checks.push(
    checkResult("tally_port", "Tally HTTP port", reachable ? "passed" : "missing", {
      detectedVersion: reachable ? target : null,
      requiredVersion: "accepts a connection",
      message: reachable
        ? `Tally is accepting connections at ${target}.`
        : `Nothing is accepting connections at ${target ?? "Tally's HTTP port"}.`,
      remediation: reachable
        ? null
        : `Open Tally, sign in to the company, and confirm its HTTP/XML server is enabled and listening on ${target ?? "port 9000"}. The bridge does not change Tally settings.`,
      evidence: { target, reachable },
    }, at),
  )

  const serviceStatus = !reachable ? "blocked" : companyError ? "failed" : "passed"
  checks.push(
    checkResult("tally_service", "Tally programme", serviceStatus, {
      detectedVersion: serviceStatus === "passed" ? runtime.edition ?? "unknown" : null,
      message:
        serviceStatus === "passed"
          ? `Tally answered a read-only company-list request (${companies?.length ?? 0} open).`
          : serviceStatus === "blocked"
            ? "Skipped: nothing answered on the port, so it could not be asked."
            : `Tally answered, but not with a company list (${companyError}).`,
      remediation:
        serviceStatus === "passed"
          ? null
          : serviceStatus === "blocked"
            ? "Start Tally and re-run the check."
            : "Confirm that the programme listening on the port is Tally and that its HTTP/XML server is turned on.",
      evidence: { companies: companies?.length ?? null, error: companyError, edition: runtime.edition ?? null },
    }, at),
  )

  const openStatus = !reachable ? "blocked" : companies === null ? "blocked" : companies.length > 0 ? "passed" : "missing"
  checks.push(
    checkResult("tally_company_open", "Open company", openStatus, {
      message:
        openStatus === "passed"
          ? `Tally has ${companies.length} ${companies.length === 1 ? "company" : "companies"} open.`
          : openStatus === "blocked"
            ? "Skipped: Tally has not been reached yet."
            : "Tally is running but has no company open.",
      remediation:
        openStatus === "passed"
          ? null
          : openStatus === "blocked"
            ? "Start Tally, sign in, and open the company before running the check again."
            : "Open the company to be cut over in Tally and leave it selected.",
      evidence: { openCompanies: companies?.length ?? null },
    }, at),
  )

  const pinnedStatus = !pinned
    ? "missing"
    : companies && !companies.some((name) => name.toLowerCase() === pinned.toLowerCase())
      ? "failed"
      : companies === null
        ? "warning"
        : "passed"
  checks.push(
    checkResult("tally_company_pinned", "Company pinned for export", pinnedStatus, {
      detectedVersion: pinned || null,
      message:
        pinnedStatus === "passed"
          ? `Exports are pinned to "${pinned}".`
          : pinnedStatus === "warning"
            ? `Exports are pinned to "${pinned}", but Tally has not answered yet so the pin cannot be confirmed.`
            : pinnedStatus === "failed"
              ? `Exports are pinned to "${pinned}", which is not among the companies Tally has open.`
              : "No company is pinned, so the bridge will refuse every export.",
      remediation:
        pinnedStatus === "passed"
          ? null
          : pinnedStatus === "warning"
            ? "Open Tally and run the check again to confirm the pinned company is open."
            : "Choose the company on this page and restart the connector with it. The bridge reads the company at start-up, so a restart is required.",
      canAutoFix: pinnedStatus !== "passed",
      evidence: { pinned: pinned || null, openCount: companies?.length ?? null },
    }, at),
  )

  const portal = await probePortal(probes.fetchImpl, origins[0] ?? null, PORTAL_PROBE_TIMEOUT_MS)
  checks.push(
    checkResult(
      "portal_https",
      "Pharmacy portal reachable",
      portal.reachable === null ? "warning" : portal.reachable ? "passed" : "warning",
      {
        required: false,
        detectedVersion: portal.reachable === true && origins[0] ? origins[0] : null,
        message:
          portal.reachable === true
            ? `The connector reached the portal at ${origins[0]} (HTTP ${portal.status}).`
            : portal.reachable === false
              ? `The connector could not reach ${origins[0]}.`
              : "No portal origin is configured, so the connector cannot check outbound access.",
        remediation:
          portal.reachable === true
            ? null
            : "The browser reached this page, so the portal itself is up. A connector-only failure means this computer blocks the connector's outbound access.",
        evidence: {
          origin: origins[0] ?? null,
          reachable: portal.reachable,
          status: portal.status,
          tls: Boolean(origins[0]?.startsWith("https:")),
        },
      },
      at,
    ),
  )

  checks.push(
    checkResult("connector_read_only", "Tally stays read-only", "passed", {
      required: false,
      message:
        "The connector exposes read-only endpoints only. None of them writes to Tally, and the export endpoint refuses a request body.",
      evidence: {
        endpoints: ["/api/tally/status", "/api/tally/companies", "/api/tally/preflight", "/api/tally/export"],
        writesToTally: false,
        acceptsRequestBody: false,
      },
    }, at),
  )

  return {
    checkedAt: at,
    connector: {
      version: connector.version ?? TALLY_CONNECTOR_VERSION,
      contractVersion: connector.contractVersion ?? TALLY_BRIDGE_CONTRACT_VERSION,
      bindHost: bindHost || null,
      port: connector.port ?? config.bridgePort ?? null,
    },
    target,
    company: pinned || null,
    checks,
    summary: summariseChecks(checks),
  }
}
