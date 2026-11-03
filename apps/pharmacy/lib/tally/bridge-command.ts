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
  company?: string
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

// A company name is free text, so it is narrowed to something that cannot close
// the quoting or expand inside it; a name carrying one is dropped, not repaired.
function cleanCompany(value: string): string {
  const name = value.trim()
  return /["$`\u0000-\u001f]/.test(name) ? "" : name.slice(0, 200)
}

/**
 * A PowerShell single-quoted literal. Nothing expands inside single quotes, so
 * only the closing quote itself has to be doubled; that is what keeps a company
 * name — which Tally, not this page, decides — from ending the argument early.
 */
function quotePowerShellLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}

// A name carrying a control character is dropped rather than repaired: a
// repaired name would pin a different company from the one Tally shows.
function cleanCommandText(value: string): string {
  const text = value.trim()
  return /[\u0000-\u001f\u007f]/.test(text) || text.length > 200 ? "" : text
}

// The origin is pasted into the command too, so only the shape the installer
// accepts is allowed through.
function cleanOrigin(value: string): string {
  const origin = value.trim()
  return /^https:\/\/[A-Za-z0-9.-]+(:\d{1,5})?$/.test(origin) ||
    /^http:\/\/(localhost|127\.0\.0\.1)(:\d{1,5})?$/.test(origin)
    ? origin
    : ""
}

/** The installer command shown on the setup assistant's Install step. */
export function buildConnectorInstallCommand(input: { origin: string; company?: string }): string {
  const parts = ["powershell -ExecutionPolicy Bypass -File .\\synapse-tally-connector.ps1"]
  const origin = cleanOrigin(input.origin)
  parts.push(origin ? `-PortalOrigin ${origin}` : "-PortalOrigin <this page's origin>")
  const company = cleanCommandText(input.company ?? "")
  if (company) parts.push(`-Company ${quotePowerShellLiteral(company)}`)
  return parts.join(" ")
}

/** The command that pins one company for the installed connector. */
export function buildCompanyPinCommand(company: string): string | null {
  const name = cleanCommandText(company)
  if (!name) return null
  return `& "$env:LOCALAPPDATA\\Synapse\\TallyConnector\\scripts\\Start-SynapseTallyConnector.ps1" -Company ${quotePowerShellLiteral(name)}`
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

  const company = cleanCompany(input.company ?? "")
  if (company) lines.push(`$env:SYNAPSE_TALLY_COMPANY = "${company}"`)

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
