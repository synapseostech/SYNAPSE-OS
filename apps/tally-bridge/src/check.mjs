/**
 * `node src/check.mjs` — the same prerequisite checks the portal runs, printed
 * for a terminal. The installer's verification step and a support call use it
 * when the bridge is not running yet.
 *
 * It reads the launch configuration, so it needs the same environment
 * variables as the bridge. The token is read and validated but never printed.
 */

import {
  canConnectToTally,
  detectTallyInstallations,
  listTallyCompanies,
  readBridgeConfig,
  tallyEditionFromExecutable,
} from "./bridge.mjs"
import {
  runPreflight,
  TALLY_BRIDGE_CONTRACT_VERSION,
  TALLY_CONNECTOR_VERSION,
} from "./preflight.mjs"

const MARKS = {
  passed: "[ok]  ",
  warning: "[warn]",
  missing: "[miss]",
  failed: "[fail]",
  blocked: "[blk] ",
  not_applicable: "[n/a] ",
}

let config
try {
  config = readBridgeConfig()
} catch (error) {
  console.error(error instanceof Error ? error.message : "The bridge configuration is invalid.")
  process.exit(2)
}

const tallyReachable = await canConnectToTally(config.tallyUrl)
let companies = null
let companyError = null
if (tallyReachable) {
  try {
    companies = await listTallyCompanies(config, fetch, {}, { ensureServer: false })
  } catch (error) {
    companyError = error instanceof Error ? error.message : "TALLY_BRIDGE_TALLY_UNAVAILABLE"
  }
}

const installations = detectTallyInstallations()
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
    installations,
    edition: config.tallyExecutable
      ? tallyEditionFromExecutable(config.tallyExecutable)
      : installations[0]?.edition ?? "unknown",
    companies,
    companyError,
    tallyReachable,
  },
  probes: { fetchImpl: fetch },
})

console.log(`Synapse Tally Connector ${report.connector.version} (contract ${report.connector.contractVersion})`)
console.log(`Checked ${report.checkedAt}`)
for (const check of report.checks) {
  const mark = MARKS[check.status] ?? "[????]"
  console.log(`${mark} ${check.name}: ${check.message}`)
  if (check.remediation && check.status !== "passed") {
    console.log(`       → ${check.remediation}`)
  }
}

const { summary } = report
console.log(
  `\n${summary.passed} passed, ${summary.warning} warning, ${summary.missing} missing, ` +
    `${summary.failed} failed, ${summary.blocked} blocked, ${summary.not_applicable} not applicable.`,
)
if (summary.ready) {
  console.log("This computer is ready to connect to Tally.")
} else {
  console.log(`Not ready. Still blocking: ${summary.blocking.join(", ")}.`)
  process.exitCode = 1
}
