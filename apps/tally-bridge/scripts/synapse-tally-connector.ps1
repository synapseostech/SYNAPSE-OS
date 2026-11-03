<#
.SYNOPSIS
Installs, repairs, verifies or removes the Synapse Tally Connector on Windows.

.DESCRIPTION
Prepares one Windows computer to bridge SYNAPSE Pharmacy to Tally. It installs
Node.js 22.x only when it is missing or too old, copies the connector into the
current user's profile, writes its configuration, creates Start Menu shortcuts
and runs the same prerequisite checks the portal runs.

Safety:
  * Downloads only from https://nodejs.org and verifies both the SHA-256
    checksum and the Authenticode signature before running the installer.
  * Never changes Windows Defender, the firewall, DNS or any network setting.
  * Never opens a port. The connector listens on 127.0.0.1 only.
  * Never deletes Tally data, touches Tally's databases or writes to Tally.
  * The bridge token is written to config.json and shown once in this console.
    It is never written to install.log.

.PARAMETER PortalOrigin
The pharmacy portal origin this connector will accept, for example
https://pharm.synapseos.tech. Required on first install; reused afterwards.

.PARAMETER Company
The Tally company to pin. Exports are refused without one.

.PARAMETER TallyHost
Where Tally's HTTP/XML server listens. Default 127.0.0.1.

.PARAMETER TallyPort
Tally's HTTP/XML port. Default 9000.

.PARAMETER TallyExecutable
Optional full path to tally.exe. The connector launches it only when the port
is not already answering.

.PARAMETER InstallRoot
Where the connector is installed. Default %LOCALAPPDATA%\Synapse\TallyConnector.

.PARAMETER Force
Replaces the existing configuration, including its token.

.PARAMETER VerifyOnly
Runs the prerequisite checks and exits; changes nothing.

.PARAMETER Uninstall
Stops the connector and removes its files and shortcuts. Node.js is left alone.

.EXAMPLE
powershell -ExecutionPolicy Bypass -File .\synapse-tally-connector.ps1 -PortalOrigin https://pharm.synapseos.tech -Company "Nakawa Pharmacy"

.EXAMPLE
powershell -ExecutionPolicy Bypass -File .\synapse-tally-connector.ps1 -VerifyOnly

.NOTES
Internal switches -InstallNodeOnly and -NodeInstallerPath are used by this
script when it re-launches itself elevated to run the Node.js MSI.
#>

[CmdletBinding()]
param(
    [string]$PortalOrigin = "",
    [string]$Company = "",
    [string]$TallyHost = "127.0.0.1",
    [int]$TallyPort = 9000,
    [string]$TallyExecutable = "",
    [string]$InstallRoot = "",
    [switch]$Force,
    [switch]$VerifyOnly,
    [switch]$Uninstall,
    [switch]$ShowToken,
    [switch]$InstallNodeOnly,
    [string]$NodeInstallerPath = "",
    [string]$NodeInstallerSha256 = ""
)

$ErrorActionPreference = "Stop"
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$BridgePort = 17890
$script:LogPath = $null

function Write-Step {
    param([string]$Message)
    Write-Host $Message
    Add-Log $Message
}

function Add-Log {
    param([string]$Message)
    if (-not $script:LogPath) { return }
    try {
        $stamp = (Get-Date).ToUniversalTime().ToString("yyyy-MM-dd HH:mm:ssZ")
        Add-Content -Path $script:LogPath -Value "$stamp $Message" -Encoding ASCII
    } catch {
        # A read-only or missing log file must never stop the installation.
    }
}

function Test-Administrator {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object Security.Principal.WindowsPrincipal($identity)
    return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Assert-Windows {
    if ($env:OS -ne "Windows_NT") {
        throw "This installer prepares a Windows computer. The connector can be run elsewhere with Node.js 22, but this script does not support it."
    }
    if (-not $env:LOCALAPPDATA) {
        throw "LOCALAPPDATA is not set, so there is no per-user folder to install into."
    }
}

function Resolve-InstallRoot {
    if ($InstallRoot) { return $InstallRoot }
    return Join-Path $env:LOCALAPPDATA "Synapse\TallyConnector"
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

function Get-NodeVersion {
    param([string]$NodeExe)
    if (-not $NodeExe) { return $null }
    try {
        $output = & $NodeExe --version 2>$null
        if (-not $output) { return $null }
        return $output.ToString().TrimStart("v")
    } catch {
        return $null
    }
}

function New-BridgeToken {
    $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    try {
        $bytes = New-Object byte[] 32
        $rng.GetBytes($bytes)
        return -join ($bytes | ForEach-Object { $_.ToString("x2") })
    } finally {
        $rng.Dispose()
    }
}

function Assert-OfficialUrl {
    param([string]$Uri)
    $parsed = [Uri]$Uri
    if ($parsed.Scheme -ne "https" -or $parsed.Host -ne "nodejs.org" -or -not $parsed.IsDefaultPort -or $parsed.UserInfo) {
        throw "Refusing to download from $Uri. The installer only downloads from https://nodejs.org on port 443."
    }
}

# The signer must be named by the organisation field of the certificate subject,
# not by a word that happens to appear anywhere in it. Splitting on the DN
# separators and comparing the whole O= component is what makes that true.
function Test-NodeSignerSubject {
    param([string]$Subject)
    if (-not $Subject) { return $false }
    $organisations = @("OpenJS Foundation", "Node.js Foundation")
    foreach ($part in ($Subject -split ",\s*")) {
        $pair = $part.Trim()
        if ($pair.StartsWith("O=")) {
            if ($organisations -contains $pair.Substring(2)) { return $true }
        }
    }
    return $false
}

function Assert-NodeInstallerSignature {
    param([string]$MsiPath)
    $signature = Get-AuthenticodeSignature -FilePath $MsiPath
    if ($signature.Status -ne "Valid") {
        Remove-Item -Path $MsiPath -Force -ErrorAction SilentlyContinue
        throw "The Node.js installer's signature is not valid ($($signature.Status)), so it was discarded and nothing was installed."
    }
    $subject = if ($signature.SignerCertificate) { [string]$signature.SignerCertificate.Subject } else { "" }
    if (-not (Test-NodeSignerSubject $subject)) {
        Remove-Item -Path $MsiPath -Force -ErrorAction SilentlyContinue
        throw "The Node.js installer's signer '$subject' is not the Node.js Foundation, so it was discarded and nothing was installed."
    }
    Add-Log "Node.js installer signature valid: $subject"
}

function Get-NodeInstaller {
    param([string]$Destination)
    Write-Step "Looking up the current Node.js 22.x release on nodejs.org..."
    $indexUrl = "https://nodejs.org/dist/index.json"
    Assert-OfficialUrl $indexUrl
    # A redirect is refused rather than followed: the checksum list and the MSI
    # come from the same origin, so letting a redirect move either of them would
    # leave only Authenticode standing between a proxy and the installer.
    $index = Invoke-RestMethod -Uri $indexUrl -UseBasicParsing -MaximumRedirection 0
    $release = $index | Where-Object { $_.version -like "v22.*" } | Select-Object -First 1
    if (-not $release) {
        throw "nodejs.org did not list a Node.js 22.x release. Install Node.js 22.x by hand from https://nodejs.org/en/download and run this installer again."
    }
    if (-not [Environment]::Is64BitOperatingSystem) {
        throw "32-bit Windows is not supported. The connector needs the 64-bit Node.js 22.x build."
    }
    $arch = if ($env:PROCESSOR_ARCHITECTURE -eq "ARM64") { "arm64" } else { "x64" }
    $suffix = "win-$arch-msi"
    if (-not ($release.files -contains $suffix)) {
        throw "Node.js $($release.version) has no $suffix package. Install Node.js 22.x by hand from https://nodejs.org/en/download."
    }

    $fileName = "node-$($release.version)-$arch.msi"
    $versionBase = "https://nodejs.org/dist/$($release.version)"
    $msiUrl = "$versionBase/$fileName"
    $shasumsUrl = "$versionBase/SHASUMS256.txt"
    Assert-OfficialUrl $msiUrl
    Assert-OfficialUrl $shasumsUrl

    $msiPath = Join-Path $Destination $fileName
    Write-Step "Downloading $fileName..."
    Invoke-WebRequest -Uri $msiUrl -OutFile $msiPath -UseBasicParsing -MaximumRedirection 0

    Write-Step "Verifying the download against nodejs.org's SHA-256 list..."
    $shasums = Invoke-RestMethod -Uri $shasumsUrl -UseBasicParsing -MaximumRedirection 0
    $expected = $null
    foreach ($line in ($shasums -split "`n")) {
        $parts = $line.Trim() -split "\s+"
        if ($parts.Count -ge 2 -and $parts[-1] -eq $fileName) { $expected = $parts[0]; break }
    }
    if (-not $expected) {
        throw "nodejs.org's SHA-256 list does not name $fileName, so the download could not be verified."
    }
    $actual = (Get-FileHash -Path $msiPath -Algorithm SHA256).Hash.ToLower()
    if ($actual -ne $expected.ToLower()) {
        Remove-Item -Path $msiPath -Force -ErrorAction SilentlyContinue
        throw "The Node.js download did not match its published SHA-256 checksum, so it was discarded and nothing was installed."
    }
    Add-Log "Node.js download verified: $fileName $actual"

    Write-Step "Verifying the installer's Authenticode signature..."
    Assert-NodeInstallerSignature -MsiPath $msiPath

    return @{ Path = $msiPath; Sha256 = $expected.ToLower(); Version = $release.version }
}

function Install-NodePackage {
    param([string]$MsiPath, [string]$ExpectedSha256)
    if (-not (Test-Administrator)) {
        throw "Installing Node.js needs administrator rights. Run this script from an administrator PowerShell window."
    }
    if (-not (Test-Path $MsiPath)) { throw "The Node.js installer is missing at $MsiPath." }
    if ($ExpectedSha256 -notmatch "^[0-9a-fA-F]{64}$") {
        throw "The Node.js installer needs the SHA-256 it was verified with. Nothing was installed."
    }
    $actual = (Get-FileHash -Path $MsiPath -Algorithm SHA256).Hash.ToLower()
    if ($actual -ne $ExpectedSha256.ToLower()) {
        throw "The Node.js installer changed after it was verified. Nothing was installed."
    }
    # This is also the elevated half that a command line can reach directly with
    # -InstallNodeOnly, so the signature is checked here as well: a checksum
    # only proves the file is the one the caller named.
    Assert-NodeInstallerSignature -MsiPath $MsiPath
    Write-Step "Installing Node.js (Windows will not show a prompt)..."
    $process = Start-Process -FilePath "msiexec.exe" `
        -ArgumentList @("/i", "`"$MsiPath`"", "/qn", "/norestart") `
        -Wait -PassThru
    if ($process.ExitCode -ne 0 -and $process.ExitCode -ne 3010) {
        throw "The Node.js installer exited with code $($process.ExitCode). Install Node.js 22.x by hand from https://nodejs.org/en/download and run this installer again."
    }
}

function Install-NodeIfNeeded {
    $nodeExe = Resolve-NodeExe
    $version = Get-NodeVersion $nodeExe
    if ($version) {
        $major = [int]($version.Split(".")[0])
        if ($major -eq 22) {
            Write-Step "Node.js $version is already installed."
            return $nodeExe
        }
        if ($major -gt 22) {
            Write-Step "Node.js $version is installed. The connector is packaged for 22.x, but a newer runtime runs it; nothing will be changed."
            Add-Log "Node.js $version kept; packaged runtime is 22.x."
            return $nodeExe
        }
        Write-Step "Node.js $version is older than the supported 22.x runtime; it will be replaced."
    } else {
        Write-Step "Node.js was not found on this computer."
    }

    $temp = Join-Path $env:TEMP ("synapse-tally-" + [guid]::NewGuid().ToString("N"))
    New-Item -ItemType Directory -Force -Path $temp | Out-Null
    try {
        $installer = Get-NodeInstaller -Destination $temp
        if (Test-Administrator) {
            Install-NodePackage -MsiPath $installer.Path -ExpectedSha256 $installer.Sha256
        } else {
            Write-Step "Windows will ask for permission to install Node.js $($installer.Version)."
            $arguments = @(
                "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", "`"$PSCommandPath`"",
                "-InstallNodeOnly",
                "-NodeInstallerPath", "`"$($installer.Path)`"",
                "-NodeInstallerSha256", $installer.Sha256
            )
            $elevated = Start-Process -FilePath "powershell.exe" -Verb RunAs -ArgumentList $arguments -Wait -PassThru
            if ($elevated.ExitCode -ne 0) {
                throw "The elevated Node.js installation did not finish (exit code $($elevated.ExitCode)). Nothing else was changed."
            }
        }
    } finally {
        Remove-Item -Path $temp -Recurse -Force -ErrorAction SilentlyContinue
    }

    $nodeExe = Resolve-NodeExe
    $version = Get-NodeVersion $nodeExe
    if (-not $version) {
        throw "Node.js was installed but could not be found. Close this window, open a new one and run the installer again."
    }
    Write-Step "Node.js $version is installed."
    return $nodeExe
}

function Copy-ConnectorFiles {
    param([string]$SourceRoot, [string]$Destination)
    $files = @(
        "package.json",
        "src\cli.mjs",
        "src\bridge.mjs",
        "src\preflight.mjs",
        "src\check.mjs",
        "scripts\Start-SynapseTallyConnector.ps1"
    )
    foreach ($file in $files) {
        $from = Join-Path $SourceRoot $file
        if (-not (Test-Path $from)) { throw "The connector package is incomplete: $file is missing." }
        $to = Join-Path $Destination $file
        $toDirectory = Split-Path -Parent $to
        if (-not (Test-Path $toDirectory)) { New-Item -ItemType Directory -Force -Path $toDirectory | Out-Null }
        Copy-Item -Path $from -To $to -Force
    }
    $logs = Join-Path $Destination "logs"
    if (-not (Test-Path $logs)) { New-Item -ItemType Directory -Force -Path $logs | Out-Null }
}

function Protect-ConfigFile {
    param([string]$Path)
    $account = "$($env:USERDOMAIN)\$($env:USERNAME)"
    & icacls $Path /inheritance:r /grant:r "${account}:(R,W)" "SYSTEM:(F)" | Out-Null
    # A failed icacls leaves the token readable by every account that inherits
    # from the parent folder, so the installer stops instead of reporting a
    # restriction it did not apply.
    if ($LASTEXITCODE -ne 0) {
        throw "config.json could not be restricted to $account and SYSTEM (icacls exit code $LASTEXITCODE). Nothing was installed."
    }
    Add-Log "Restricted config.json to $account and SYSTEM."
}

function Read-Config {
    param([string]$Path)
    if (-not (Test-Path $Path)) { return $null }
    try {
        return Get-Content -Path $Path -Raw | ConvertFrom-Json
    } catch {
        throw "The existing configuration at $Path could not be read. Run this installer with -Force to replace it."
    }
}

function Write-Config {
    param([string]$Path, [hashtable]$Values)
    $json = $Values | ConvertTo-Json -Depth 6
    # Written without a BOM so Node's JSON.parse reads it unchanged.
    $utf8 = New-Object System.Text.UTF8Encoding($false)
    # The token is written beside its destination and restricted there first, so
    # a crash or a denied icacls never leaves a half-written or world-readable
    # token at the live path. The move is a rename in the same folder.
    $temp = "$Path.new"
    try {
        [System.IO.File]::WriteAllText($temp, $json, $utf8)
        Protect-ConfigFile -Path $temp
        Move-Item -Path $temp -To $Path -Force
    } catch {
        Remove-Item -Path $temp -Force -ErrorAction SilentlyContinue
        throw
    }
}

function New-Shortcut {
    param(
        [string]$Directory,
        [string]$Name,
        [string]$Script,
        [string]$Arguments,
        [string]$WorkingDirectory,
        [string]$Description
    )
    $path = Join-Path $Directory "$Name.lnk"
    $shell = New-Object -ComObject WScript.Shell
    $shortcut = $shell.CreateShortcut($path)
    $shortcut.TargetPath = "powershell.exe"
    $shortcut.Arguments = "-NoProfile -ExecutionPolicy Bypass -File `"$Script`" $Arguments"
    $shortcut.WorkingDirectory = $WorkingDirectory
    $shortcut.Description = $Description
    $shortcut.IconLocation = "powershell.exe,0"
    $shortcut.Save()
    Add-Log "Shortcut created: $path"
}

function Stop-ConnectorProcess {
    param([int]$Port, [string]$InstallRoot)
    $listener = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $listener) {
        Write-Step "Nothing is listening on 127.0.0.1:$Port, so there is nothing to stop."
        return
    }
    $ownerPid = $listener.OwningProcess
    $process = Get-CimInstance Win32_Process -Filter "ProcessId = $ownerPid" -ErrorAction SilentlyContinue
    $commandLine = if ($process) { [string]$process.CommandLine } else { "" }
    $expected = Join-Path $InstallRoot "src\cli.mjs"
    if ($commandLine -notlike "*$expected*") {
        Write-Warning "Port $Port is held by process $ownerPid, which is not this connector. It was left alone."
        return
    }
    Stop-Process -Id $ownerPid -Force
    Write-Step "Stopped the connector (process $ownerPid)."
}

function Invoke-Verification {
    param([string]$NodeExe, [hashtable]$Environment)
    foreach ($name in $Environment.Keys) {
        Set-Item -Path "Env:$name" -Value $Environment[$name]
    }
    $check = Join-Path $InstallRoot "src\check.mjs"
    & $NodeExe $check
    return $LASTEXITCODE
}

# The uninstall deletes its folder recursively, and -InstallRoot is a parameter,
# so the folder is only removed when it is provably the one this installer
# filled. A drive root, a Windows folder or any other directory is refused.
function Test-ConnectorInstallRoot {
    param([string]$Path)
    $resolved = [System.IO.Path]::GetFullPath($Path).TrimEnd("\")
    if ($resolved -match "^[A-Za-z]:$") { return $false }
    $sensitive = @(
        $env:LOCALAPPDATA, $env:APPDATA, $env:USERPROFILE, $env:TEMP, $env:PUBLIC,
        $env:ProgramFiles, ${env:ProgramFiles(x86)}, $env:SystemRoot
    )
    foreach ($candidate in $sensitive) {
        if ($candidate -and $resolved -eq [System.IO.Path]::GetFullPath($candidate).TrimEnd("\")) {
            return $false
        }
    }
    return (Test-Path (Join-Path $resolved "src\cli.mjs")) -and (Test-Path (Join-Path $resolved "package.json"))
}

function Uninstall-Connector {
    param([string]$InstallRoot, [int]$Port, [bool]$Confirmed)
    if (-not $Confirmed -and -not $Force) {
        $answer = Read-Host "Remove the Synapse Tally Connector from $InstallRoot? (type YES)"
        if ($answer -ne "YES") {
            Write-Step "Nothing was removed."
            return
        }
    }
    Stop-ConnectorProcess -Port $Port -InstallRoot $InstallRoot
    $startMenu = Join-Path ([Environment]::GetFolderPath("Programs")) "Synapse"
    if (Test-Path $startMenu) {
        Get-ChildItem -Path $startMenu -Filter "*.lnk" | Where-Object { $_.Name -like "*Tally Connector*" } | ForEach-Object {
            Remove-Item -Path $_.FullName -Force
            Write-Step "Removed shortcut $($_.Name)."
        }
        if (-not (Get-ChildItem -Path $startMenu -Force)) { Remove-Item -Path $startMenu -Force }
    }
    if (Test-Path $InstallRoot) {
        if (-not (Test-ConnectorInstallRoot -Path $InstallRoot)) {
            Write-Warning "Refusing to remove $InstallRoot: it is not a folder this installer filled (its src\cli.mjs and package.json are missing). Remove it by hand if that really is the connector's folder."
        } else {
            Remove-Item -Path $InstallRoot -Recurse -Force
            Write-Step "Removed $InstallRoot."
        }
    }
    Write-Step "Node.js was not removed. Remove it from Apps & features if no other programme needs it."
    Write-Step "Nothing in Tally was changed."
}

# ---------------------------------------------------------------------------

if ($InstallNodeOnly) {
    Install-NodePackage -MsiPath $NodeInstallerPath -ExpectedSha256 $NodeInstallerSha256
    exit 0
}

try {
    Assert-Windows
    $InstallRoot = Resolve-InstallRoot
    New-Item -ItemType Directory -Force -Path $InstallRoot | Out-Null
    $script:LogPath = Join-Path $InstallRoot "install.log"
    Add-Log "Synapse Tally Connector installer started."

    if ($Uninstall) {
        Uninstall-Connector -InstallRoot $InstallRoot -Port $BridgePort -Confirmed $false
        exit 0
    }

    $startScript = Join-Path $InstallRoot "scripts\Start-SynapseTallyConnector.ps1"
    $configPath = Join-Path $InstallRoot "config.json"
    $existing = Read-Config -Path $configPath

    if ($ShowToken) {
        if (-not $existing -or -not $existing.token) {
            throw "No connector configuration exists at $configPath yet."
        }
        Write-Host "Copy this token into the portal: $($existing.token)"
        Write-Host "It is shown here only; nothing writes it to install.log."
        exit 0
    }

    if ($VerifyOnly) {
        if (-not $existing) { throw "The connector is not installed yet, so there is nothing to verify." }
        $nodeExe = Resolve-NodeExe
        if (-not $nodeExe) { throw "Node.js was not found, so the connector cannot run." }
        $environment = @{
            SYNAPSE_TALLY_BRIDGE_TOKEN = [string]$existing.token
            SYNAPSE_TALLY_ALLOWED_ORIGINS = (@($existing.allowedOrigins) -join ",")
            SYNAPSE_TALLY_TARGET_HOST = [string]$existing.tallyTarget.host
            SYNAPSE_TALLY_TARGET_PORT = [string]$existing.tallyTarget.port
            SYNAPSE_TALLY_BRIDGE_PORT = [string]$BridgePort
            SYNAPSE_TALLY_COMPANY = [string]$existing.company
        }
        if ($existing.executable) { $environment.SYNAPSE_TALLY_EXECUTABLE = [string]$existing.executable }
        $code = Invoke-Verification -NodeExe $nodeExe -Environment $environment
        exit $code
    }

    if (-not $PortalOrigin) {
        if ($existing -and $existing.allowedOrigins) {
            $PortalOrigin = @($existing.allowedOrigins)[0]
        } else {
            throw "State the pharmacy portal origin, for example: -PortalOrigin https://pharm.synapseos.tech"
        }
    }
    if ($PortalOrigin -notmatch "^https://[^/]+$" -and $PortalOrigin -notmatch "^http://(localhost|127\.0\.0\.1)(:\d+)?$") {
        throw "The portal origin must be an exact HTTPS origin with no path or trailing slash, for example https://pharm.synapseos.tech"
    }

    if (-not $Company -and $existing) { $Company = [string]$existing.company }
    if (-not $TallyExecutable -and $existing -and $existing.executable) { $TallyExecutable = [string]$existing.executable }

    $nodeExe = Install-NodeIfNeeded

    $sourceRoot = Split-Path -Parent $PSScriptRoot
    $packageJson = Get-Content -Path (Join-Path $sourceRoot "package.json") -Raw | ConvertFrom-Json
    Write-Step "Installing the connector into $InstallRoot..."
    Copy-ConnectorFiles -SourceRoot $sourceRoot -Destination $InstallRoot

    if ((Test-Path $configPath) -and $Force) {
        Write-Step "Replacing the existing configuration because -Force was given."
    }
    if (-not (Test-Path $configPath) -or $Force) {
        $token = New-BridgeToken
        $values = @{
            version = 1
            token = $token
            allowedOrigins = @($PortalOrigin)
            tallyTarget = @{ host = $TallyHost; port = $TallyPort }
            bridgePort = $BridgePort
            company = $Company
            executable = $TallyExecutable
            connectorVersion = [string]$packageJson.version
            installedAt = (Get-Date).ToUniversalTime().ToString("o")
        }
        Write-Config -Path $configPath -Values $values
        $newToken = $true
    } else {
        $existing = Read-Config -Path $configPath
        $values = @{
            version = 1
            token = [string]$existing.token
            allowedOrigins = @($PortalOrigin)
            tallyTarget = @{ host = $TallyHost; port = $TallyPort }
            bridgePort = $BridgePort
            company = $Company
            executable = $TallyExecutable
            connectorVersion = [string]$packageJson.version
            installedAt = [string]$existing.installedAt
            updatedAt = (Get-Date).ToUniversalTime().ToString("o")
        }
        Write-Config -Path $configPath -Values $values
        $newToken = $false
    }

    $startMenu = Join-Path ([Environment]::GetFolderPath("Programs")) "Synapse"
    if (-not (Test-Path $startMenu)) { New-Item -ItemType Directory -Force -Path $startMenu | Out-Null }
    New-Shortcut -Directory $startMenu -Name "Synapse Tally Connector" -Script $startScript -Arguments "" -WorkingDirectory $InstallRoot -Description "Start the Synapse Tally Connector"
    New-Shortcut -Directory $startMenu -Name "Synapse Tally Connector Status" -Script $startScript -Arguments "-Status" -WorkingDirectory $InstallRoot -Description "Check whether the connector and Tally are reachable"
    New-Shortcut -Directory $startMenu -Name "Stop Synapse Tally Connector" -Script $startScript -Arguments "-Stop" -WorkingDirectory $InstallRoot -Description "Stop the Synapse Tally Connector"

    $environment = @{
        SYNAPSE_TALLY_BRIDGE_TOKEN = [string]$values.token
        SYNAPSE_TALLY_ALLOWED_ORIGINS = (@($values.allowedOrigins) -join ",")
        SYNAPSE_TALLY_TARGET_HOST = [string]$TallyHost
        SYNAPSE_TALLY_TARGET_PORT = [string]$TallyPort
        SYNAPSE_TALLY_COMPANY = [string]$Company
    }
    if ($TallyExecutable) { $environment.SYNAPSE_TALLY_EXECUTABLE = [string]$TallyExecutable }

    Write-Step ""
    Write-Step "Running the prerequisite checks..."
    $verifyCode = Invoke-Verification -NodeExe $nodeExe -Environment $environment

    Write-Step ""
    Write-Step "Installed to $InstallRoot"
    Write-Step "Start Menu: Synapse > Synapse Tally Connector"
    if ($newToken) {
        Write-Host ""
        Write-Host "Copy this token into the portal: $($values.token)" -ForegroundColor Cyan
        Write-Host "It is shown here only; nothing writes it to install.log. Recover it later with -ShowToken." -ForegroundColor Cyan
    } else {
        Write-Step "The existing token was kept. Use -ShowToken to display it."
    }
    Write-Step "The connector listens on 127.0.0.1:$BridgePort only. Tally is never written to."
    Write-Step "Uninstall later with: -Uninstall"

    Add-Log "Installer finished with verification exit code $verifyCode."
    exit $verifyCode
} catch {
    Add-Log "FAILED: $($_.Exception.Message)"
    Write-Host ""
    Write-Error $_.Exception.Message
    exit 1
}
