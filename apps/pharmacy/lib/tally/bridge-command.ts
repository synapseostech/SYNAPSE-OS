/**
 * Builds the PowerShell snippet the cut-over page hands to the operator.
 *
 * Everything the operator types into the page is interpolated into a command
 * they will paste into a shell, so each value is narrowed to the shape the
 * bridge accepts before it is quoted.
 */

export const DEFAULT_BRIDGE_ORIGIN = "https://pharm.synapseos.tech"
export const DEFAULT_BRIDGE_HOST = "127.0.0.1"
export const DEFAULT_BRIDGE_PORT = "9000"

export type BridgeCommandInput = {
  origin: string
  host: string
  port: string
  executable: string
  fromDate: string
  toDate?: string
}

function cleanHost(value: string): string {
  const host = value.trim()
  return /^(?=.{1,253}$)[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$/.test(host)
    ? host
    : DEFAULT_BRIDGE_HOST
}

function cleanPort(value: string): string {
  const port = Number(value.trim())
  return /^\d{1,5}$/.test(value.trim()) && port >= 1 && port <= 65535
    ? String(port)
    : DEFAULT_BRIDGE_PORT
}

// A Windows path may contain spaces, so it stays quoted. Quotes, backticks and
// "$" would break out of or expand inside that quoted string, so a path that
// carries one is dropped rather than repaired.
function cleanExecutable(value: string): string {
  const path = value.trim()
  return /["$`\u0000-\u001f]/.test(path) ? "" : path
}

function cleanTallyDate(value: string): string {
  return /^\d{8}$/.test(value.trim()) ? value.trim() : ""
}

export function buildBridgeCommand(input: BridgeCommandInput): string {
  const origin = input.origin.trim() || DEFAULT_BRIDGE_ORIGIN
  const lines = [
    "$rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()",
    "$bytes = New-Object byte[] 32",
    "$rng.GetBytes($bytes)",
    '$env:SYNAPSE_TALLY_BRIDGE_TOKEN = -join ($bytes | ForEach-Object { $_.ToString("x2") })',
    "$rng.Dispose()",
    "",
    `$env:SYNAPSE_TALLY_ALLOWED_ORIGINS = "${origin}"`,
    `$env:SYNAPSE_TALLY_TARGET_HOST = "${cleanHost(input.host)}"`,
    `$env:SYNAPSE_TALLY_TARGET_PORT = "${cleanPort(input.port)}"`,
  ]

  const executable = cleanExecutable(input.executable)
  if (executable) lines.push(`$env:SYNAPSE_TALLY_EXECUTABLE = "${executable}"`)

  const fromDate = cleanTallyDate(input.fromDate)
  if (fromDate) lines.push(`$env:SYNAPSE_TALLY_FROM_DATE = "${fromDate}"`)

  const toDate = cleanTallyDate(input.toDate ?? "")
  if (toDate) lines.push(`$env:SYNAPSE_TALLY_TO_DATE = "${toDate}"`)

  lines.push(
    "",
    'Write-Host "Copy this token into the portal: $env:SYNAPSE_TALLY_BRIDGE_TOKEN"',
    "node apps\\tally-bridge\\src\\cli.mjs",
  )

  return lines.join("\n")
}
