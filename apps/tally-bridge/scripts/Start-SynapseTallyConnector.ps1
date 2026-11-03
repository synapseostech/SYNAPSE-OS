<#
.SYNOPSIS
Starts, checks, stops or restarts the Synapse Tally Connector.

.DESCRIPTION
The Start Menu shortcut "Synapse Tally Connector" runs this script. It reads
the configuration written by the installer, starts the connector in this
window, and shows the bridge token once so it can be pasted into the portal.

Other shortcuts run it with -Status and -Stop. You can also pass -Verify to run
the prerequisite checks without starting the bridge.

Nothing here writes to Tally, changes a firewall rule or opens a port beyond
127.0.0.1:17890.

.EXAMPLE
.\Start-SynapseTallyConnector.ps1

.EXAMPLE
.\Start-SynapseTallyConnector.ps1 -Company "Nakawa Pharmacy"

.EXAMPLE
.\Start-SynapseTallyConnector.ps1 -Status
#>

[CmdletBinding()]
param(
    [string]$Company = "",
    [switch]$Status,
    [switch]$Stop,
    [switch]$Restart,
    [switch]$Verify,
    [switch]$ShowToken
)

$ErrorActionPreference = "Stop"

function Read-ConnectorConfig {
    $path = Join-Path (Split-Path -Parent $PSScriptRoot) "config.json"
    if (-not (Test-Path $path)) {
        throw "The connector is not installed here. Run synapse-tally-connector.ps1 first."
    }
    return @{ Path = $path; Values = (Get-Content -Path $path -Raw | ConvertFrom-Json) }
}

function Resolve-NodeExe {
    $command = Get-Command node.exe -ErrorAction SilentlyContinue
    if ($command) { return $command.Source }
    $candidates = @(
        (Join-Path $env:ProgramFiles "nodejs\node.exe"),
        (Join-Path ${env:ProgramFiles(x86)} "nodejs\node.exe"),
        (Join-Path $env:LOCALAPPDATA "Programs\nodejs\node.exe")
    )
    foreach ($candidate in $candidates) {
        if ($candidate -and (Test-Path $candidate)) { return $candidate }
    }
    return $null
}

function Get-PortListener {
    param([int]$Port)
    try {
        return Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
    } catch {
        return $null
    }
}

function Get-ConnectorProcessId {
    param([int]$Port, [string]$CliPath)
    $listener = Get-PortListener -Port $Port
    if (-not $listener) { return $null }
    $process = Get-CimInstance Win32_Process -Filter "ProcessId = $($listener.OwningProcess)" -ErrorAction SilentlyContinue
    $commandLine = if ($process) { [string]$process.CommandLine } else { "" }
    if ($commandLine -notlike "*$CliPath*") { return $null }
    return $listener.OwningProcess
}

$configuration = Read-ConnectorConfig
$config = $configuration.Values
$token = [string]$config.token
$origin = @($config.allowedOrigins)[0]
$tallyHost = [string]$config.tallyTarget.host
$tallyPort = [string]$config.tallyTarget.port
$bridgePort = if ($config.bridgePort) { [int]$config.bridgePort } else { 17890 }
$pinnedCompany = if ($Company) { $Company } else { [string]$config.company }
$executable = [string]$config.executable
$installRoot = Split-Path -Parent $PSScriptRoot
$cliPath = Join-Path $installRoot "src\cli.mjs"

if ($ShowToken) {
    Write-Host "Copy this token into the portal: $token"
    Write-Host "It is shown here only and is never written to a log."
    exit 0
}

$environment = @{
    SYNAPSE_TALLY_BRIDGE_TOKEN = $token
    SYNAPSE_TALLY_ALLOWED_ORIGINS = $origin
    SYNAPSE_TALLY_TARGET_HOST = $tallyHost
    SYNAPSE_TALLY_TARGET_PORT = $tallyPort
    SYNAPSE_TALLY_COMPANY = $pinnedCompany
    SYNAPSE_TALLY_BRIDGE_PORT = [string]$bridgePort
}
if ($executable) { $environment.SYNAPSE_TALLY_EXECUTABLE = $executable }

if ($Status) {
    $url = "http://127.0.0.1:$bridgePort/api/tally/status"
    try {
        $response = Invoke-RestMethod -Uri $url -Method Get -TimeoutSec 10 -Headers @{
            Origin = $origin
            "x-synapse-tally-bridge-token" = $token
        }
    } catch {
        $statusCode = $null
        if ($_.Exception.Response) { $statusCode = [int]$_.Exception.Response.StatusCode }
        if ($statusCode -eq 401) {
            Write-Host "Connector: running, but it rejected this token." -ForegroundColor Red
        } elseif ($statusCode -eq 403) {
            Write-Host "Connector: running, but it does not allow $origin." -ForegroundColor Red
        } else {
            Write-Host "Connector: not running on 127.0.0.1:$bridgePort." -ForegroundColor Yellow
            Write-Host "Start it from the Start Menu: Synapse > Synapse Tally Connector."
        }
        exit 1
    }
    $tallyState = if ($response.tally -eq "reachable") { "reachable" } else { "not reachable" }
    Write-Host "Connector: running on 127.0.0.1:$bridgePort"
    Write-Host "Tally:     $tallyState at $($response.target)"
    Write-Host "Edition:   $($response.edition)"
    Write-Host "Company:   $(if ($response.company) { $response.company } else { 'none pinned' })"
    Write-Host "Period:    $($response.period.from) to $($response.period.to)"
    if ($response.tally -ne "reachable") {
        Write-Host "Open Tally, then load the company you want to bridge."
        exit 1
    }
    exit 0
}

if ($Verify) {
    $nodeExe = Resolve-NodeExe
    if (-not $nodeExe) { throw "Node.js was not found. Run the installer again." }
    foreach ($name in $environment.Keys) { Set-Item -Path "Env:$name" -Value $environment[$name] }
    & $nodeExe (Join-Path $installRoot "src\check.mjs")
    exit $LASTEXITCODE
}

$shouldStop = $Stop -or $Restart
if ($shouldStop) {
    $ownerPid = Get-ConnectorProcessId -Port $bridgePort -CliPath $cliPath
    if ($ownerPid) {
        Stop-Process -Id $ownerPid -Force
        Write-Host "Stopped the connector (process $ownerPid)."
    } elseif (Get-PortListener -Port $bridgePort) {
        Write-Host "Port $bridgePort is held by another programme. It was left alone." -ForegroundColor Yellow
    } else {
        Write-Host "The connector is not running."
    }
    if ($Stop) { exit 0 }
}

if (-not $Restart) {
    $existingPid = Get-ConnectorProcessId -Port $bridgePort -CliPath $cliPath
    if ($existingPid) {
        Write-Host "The connector is already running (process $existingPid)." -ForegroundColor Yellow
        Write-Host "Use -Status to check it, -Restart to restart it, or -Stop to stop it."
        exit 0
    }
    if (Get-PortListener -Port $bridgePort) {
        throw "Port $bridgePort is held by another programme, so the connector cannot start."
    }
}

$nodeExe = Resolve-NodeExe
if (-not $nodeExe) {
    throw "Node.js was not found. Run synapse-tally-connector.ps1 again."
}

foreach ($name in $environment.Keys) { Set-Item -Path "Env:$name" -Value $environment[$name] }
New-Item -ItemType Directory -Force -Path (Join-Path $installRoot "logs") | Out-Null
$logPath = Join-Path $installRoot ("logs\bridge-" + (Get-Date).ToString("yyyyMMdd") + ".log")

Write-Host "Synapse Tally Connector" -ForegroundColor Green
Write-Host "  Tally:    http://${tallyHost}:$tallyPort"
Write-Host "  Company:  $(if ($pinnedCompany) { $pinnedCompany } else { 'none pinned - the portal will ask you to pin one' })"
Write-Host "  Portal:   $origin"
Write-Host "  Local:    http://127.0.0.1:$bridgePort (this computer only)"
Write-Host ""
Write-Host "Copy this token into the portal: $token" -ForegroundColor Cyan
Write-Host "It is shown here only and is never written to the log." -ForegroundColor Cyan
Write-Host ""
Write-Host "Leave this window open while Tally is bridged. Ctrl+C stops the connector."
Write-Host ""

& $nodeExe $cliPath 2>&1 | Tee-Object -FilePath $logPath -Append
exit $LASTEXITCODE
