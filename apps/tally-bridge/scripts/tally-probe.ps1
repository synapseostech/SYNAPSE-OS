<#
    SYNAPSE Tally probe

    Runs on the pharmacy computer while Tally is open and signed in.
    It asks Tally four questions, writes the answers to a folder, and prints a
    short report. It changes nothing in Tally. It sends nothing anywhere: the
    only network traffic is to 127.0.0.1 on this computer, and nothing is
    uploaded. The folder is left on the desktop for a person to send by hand.

    Run it by right-clicking the file and choosing "Run with PowerShell", or:
        powershell -ExecutionPolicy Bypass -File .\tally-probe.ps1
#>

param(
    [string]$Company = "",
    [string]$From = "19000101",
    [string]$To = "",
    [int]$Port = 9000,
    [string]$OutDir = "$env:USERPROFILE\Desktop\SynapseTallyProbe"
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

# Mirrors the importer's ceilings, so the verdict is the importer's verdict.
$LimitBytes = 25MB
$LimitTags = 2000000
$LimitRecords = 250000
$AnalysisLimit = 64MB

$Today = (Get-Date).ToString("yyyyMMdd")
if ([string]::IsNullOrWhiteSpace($To)) { $To = $Today }

New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
$Report = Join-Path $OutDir "tally-probe-report.txt"
$Lines = New-Object System.Collections.Generic.List[string]
$Problems = New-Object System.Collections.Generic.List[string]
$Warnings = New-Object System.Collections.Generic.List[string]

function Say($text) { Write-Host $text; $Lines.Add([string]$text) }
function Add-Problem($text) { $Problems.Add([string]$text); Say "   ! $text" }
function Add-Warning($text) { $Warnings.Add([string]$text); Say "   ~ $text" }

function Finish([int]$code) {
    Say ""
    Say "8. Errors and warnings"
    if ($Problems.Count -eq 0 -and $Warnings.Count -eq 0) {
        Say "   none"
    } else {
        foreach ($item in $Problems) { Say "   ERROR   $item" }
        foreach ($item in $Warnings) { Say "   WARNING $item" }
    }
    Say ""
    Say "Nothing was uploaded and nothing left this computer."
    Say "Send the whole folder back: $OutDir"
    Say "File 1 holds company names only. Files 2 and 3 hold account and voucher"
    Say "details, so send them only if your policy allows; the report alone answers"
    Say "most of the questions."
    $Lines | Set-Content -Path $Report -Encoding UTF8
    Start-Process explorer.exe $OutDir
    exit $code
}

function Escape-Xml([string]$value) {
    $value.Replace("&", "&amp;").Replace("<", "&lt;").Replace(">", "&gt;").Replace('"', "&quot;")
}

function Read-Head([string]$path, [int]$count) {
    $stream = [System.IO.File]::OpenRead($path)
    try {
        $length = [int][Math]::Min($stream.Length, $count)
        $buffer = [byte[]]::new($length)
        $read = 0
        while ($read -lt $length) {
            $n = $stream.Read($buffer, $read, $length - $read)
            if ($n -le 0) { break }
            $read += $n
        }
        return [System.Text.Encoding]::UTF8.GetString($buffer, 0, $read)
    } finally { $stream.Close() }
}

function Read-Analysable([string]$path) {
    $stream = [System.IO.File]::OpenRead($path)
    try {
        $length = [int][Math]::Min($stream.Length, $AnalysisLimit)
        $buffer = [byte[]]::new($length)
        $read = 0
        while ($read -lt $length) {
            $n = $stream.Read($buffer, $read, $length - $read)
            if ($n -le 0) { break }
            $read += $n
        }
        return [pscustomobject]@{
            Text = [System.Text.Encoding]::UTF8.GetString($buffer, 0, $read)
            Bytes = $read
            Partial = $stream.Length -gt $length
        }
    } finally { $stream.Close() }
}

# Counts a pattern across the whole file without loading it into memory. The
# overlap must exceed the longest pattern, or a match split across two reads is
# lost; 64 characters covers every pattern used here.
function Count-PatternInFile([string]$path, [string]$pattern) {
    $overlap = 64
    $bufferSize = 4MB
    $decoder = [System.Text.UTF8Encoding]::new($false)
    $stream = [System.IO.File]::OpenRead($path)
    $count = 0
    $carry = ""
    try {
        $buffer = [byte[]]::new($bufferSize)
        while ($true) {
            $read = $stream.Read($buffer, 0, $bufferSize)
            if ($read -le 0) { break }
            $text = $carry + $decoder.GetString($buffer, 0, $read)
            # A match that could still straddle the boundary is left in the
            # carry for the next pass, so every match is counted exactly once.
            $safe = $text.Length - $overlap
            if ($safe -lt 0) { $safe = 0 }
            foreach ($match in [regex]::Matches($text, $pattern, "IgnoreCase")) {
                if ($match.Index -lt $safe) { $count++ }
            }
            $carry = $text.Substring($safe)
        }
        $count += ([regex]::Matches($carry, $pattern, "IgnoreCase")).Count
        return $count
    } finally { $stream.Close() }
}

function Count-Tag([string]$text, [string]$name) {
    return ([regex]::Matches($text, '<' + $name + '(?=[\s/>])', "IgnoreCase")).Count
}

function Get-CompanyIdentity([string]$text) {
    $match = [regex]::Match($text, '<COMPANY\b[^>]*?\bNAME="([^"]{1,400})"', "IgnoreCase")
    if ($match.Success) { return [System.Net.WebUtility]::HtmlDecode($match.Groups[1].Value) }
    $match = [regex]::Match($text, '<COMPANYNAME>([^<]{1,400})</COMPANYNAME>', "IgnoreCase")
    if ($match.Success) { return [System.Net.WebUtility]::HtmlDecode($match.Groups[1].Value) }
    return ""
}

# Every field whose name looks like a balance, as a tag or as an attribute.
# This reports what Tally actually emits instead of checking a guess.
function Get-BalanceNames([string]$text) {
    $found = @{}
    foreach ($match in [regex]::Matches($text, '<([A-Za-z0-9_]+)')) {
        $name = $match.Groups[1].Value.ToUpper()
        if ($name -match 'OPEN|CLOS') {
            if ($found.ContainsKey($name)) { $found[$name] = $found[$name] + 1 } else { $found[$name] = 1 }
        }
    }
    foreach ($match in [regex]::Matches($text, '([A-Za-z0-9_]+)\s*=\s*"')) {
        $name = $match.Groups[1].Value.ToUpper()
        if ($name -match 'OPEN|CLOS') {
            if ($found.ContainsKey($name)) { $found[$name] = $found[$name] + 1 } else { $found[$name] = 1 }
        }
    }
    return $found
}

# The record types the importer counts toward its 250,000 ceiling.
function Get-MasterRecordCount($counts) {
    if (-not $counts) { return 0 }
    $total = 0
    foreach ($key in @("LEDGER", "GROUP", "STOCKITEM", "STOCKGROUP", "UNIT", "GODOWN")) {
        $total += [int]$counts[$key]
    }
    return $total
}

function Invoke-Tally([string]$body, [string]$outFile) {
    $started = Get-Date
    try {
        Invoke-WebRequest -Uri "http://127.0.0.1:$Port" -Method Post -Body $body `
            -OutFile $outFile -TimeoutSec 1800 -UseBasicParsing | Out-Null
    } catch {
        return [pscustomobject]@{ Ok = $false; Error = $_.Exception.Message; Seconds = 0; Bytes = 0 }
    }
    $seconds = [math]::Round(((Get-Date) - $started).TotalSeconds, 1)
    $bytes = (Get-Item $outFile).Length
    $answered = (Read-Head $outFile 4096) -match "<STATUS>\s*1\s*</STATUS>"
    return [pscustomobject]@{ Ok = $answered; Error = $null; Seconds = $seconds; Bytes = $bytes }
}

function Find-TallyInstallations {
    $candidates = @(
        @{ Path = "C:\Program Files\TallyPrime\tally.exe"; Edition = "TallyPrime" },
        @{ Path = "C:\Program Files (x86)\TallyPrime\tally.exe"; Edition = "TallyPrime" },
        @{ Path = "C:\Tally.ERP9\tally.exe"; Edition = "Tally.ERP 9" },
        @{ Path = "C:\Program Files\Tally.ERP9\tally.exe"; Edition = "Tally.ERP 9" }
    )
    $found = @()
    foreach ($entry in $candidates) {
        $path = $entry.Path
        if (-not (Test-Path -LiteralPath $path)) { continue }
        $product = ""
        $file = ""
        try {
            $info = [System.Diagnostics.FileVersionInfo]::GetVersionInfo($path)
            $product = $info.ProductVersion
            $file = $info.FileVersion
        } catch { }
        $found += [pscustomobject]@{ Path = $path; Edition = $entry.Edition; Product = $product; File = $file }
    }
    return $found
}

# ---------------------------------------------------------------- header
Say "SYNAPSE Tally probe"
Say "Computer : $env:COMPUTERNAME"
Say "Tally at : http://127.0.0.1:$Port"
Say "Period   : $From to $To"
Say "Folder   : $OutDir"
Say ""

# ---------------------------------------------------------------- 1. edition
Say "1. Which Tally is installed?"
$installations = @(Find-TallyInstallations)
if ($installations.Count -eq 0) {
    Add-Warning "Tally was not found in the usual install folders, so the edition and version could not be read."
    Say "   Ask the dealer for the Tally edition and version and write it on this report."
    $edition = "unknown"
    $version = "unknown"
} else {
    foreach ($install in $installations) {
        Say "   Found   : $($install.Path)"
        Say "   Edition : $($install.Edition)"
        Say "   Version : $($install.Product) (file $($install.File))"
    }
    $edition = $installations[0].Edition
    $version = $installations[0].Product
}
Say ""

# ---------------------------------------------------------------- 2. gateway
Say "2. Is Tally answering on port $Port?"
$reachable = $false
try {
    $client = New-Object System.Net.Sockets.TcpClient
    $reachable = $client.ConnectAsync("127.0.0.1", $Port).Wait(3000)
    $client.Close()
} catch { $reachable = $false }

if (-not $reachable) {
    Add-Problem "nothing is listening on port $Port."
    Say ""
    Say "   Open Tally, sign in, and switch its HTTP server on:"
    Say "   F1 > Settings > Advanced Configuration > enable the HTTP/gateway server on port $Port."
    Say "   Then start this probe again."
    Finish 1
}
Say "   YES"
Say ""

# ---------------------------------------------------------------- 3. companies
Say "3. Which companies does Tally have open?"
$companyBody = '<ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Collection</TYPE><ID>List of Companies</ID></HEADER><BODY><DESC><STATICVARIABLES><SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT></STATICVARIABLES><TDL><TDLMESSAGE><COLLECTION NAME="List of Companies" ISMODIFY="No" ISFIXED="No" ISINITIALIZE="No" ISOPTION="No" ISINTERNAL="No"><TYPE>Company</TYPE><NATIVEMETHOD>Name</NATIVEMETHOD></COLLECTION></TDLMESSAGE></TDL></DESC></BODY></ENVELOPE>'
$companyFile = Join-Path $OutDir "1-companies.xml"
$companyResult = Invoke-Tally $companyBody $companyFile

$names = @()
if ($companyResult.Ok) {
    $raw = Read-Analysable $companyFile
    $text = $raw.Text
    $names = @(
        @(
            ([regex]::Matches($text, '<COMPANY\b[^>]*?\bNAME="([^"]{1,400})"') | ForEach-Object { $_.Groups[1].Value }) +
            ([regex]::Matches($text, '<COMPANYNAME>([^<]{1,400})</COMPANYNAME>') | ForEach-Object { $_.Groups[1].Value })
        ) | ForEach-Object { [System.Net.WebUtility]::HtmlDecode($_) } | Where-Object { $_ } | Select-Object -Unique
    )
}

if (-not $companyResult.Ok) {
    Add-Problem "Tally did not answer the company list: $($companyResult.Error)"
    Say "   This is the one thing to report back with the folder."
    Say ""
} elseif ($names.Count -eq 0) {
    Add-Problem "Tally answered but named no company. No company is open in Tally."
    Say ""
} else {
    $label = if ($names.Count -eq 1) { "company" } else { "companies" }
    Say "   YES - $($names.Count) $label"
    for ($i = 0; $i -lt $names.Count; $i++) { Say "     $($i + 1). $($names[$i])" }
    Say ""
}

# ---------------------------------------------------------------- 4. selected
if (-not $Company) {
    if ($names.Count -eq 1) {
        $Company = $names[0]
    } elseif ($names.Count -gt 1) {
        $answer = Read-Host "Type the number of the company to test, then press Enter"
        $index = 0
        if ([int]::TryParse($answer, [ref]$index) -and $index -ge 1 -and $index -le $names.Count) {
            $Company = $names[$index - 1]
        }
    }
}

if (-not $Company) {
    Add-Problem "no company was chosen, so nothing could be read."
    Say "   Open the pharmacy's company in Tally, then run the probe again."
    Finish 1
}

Say "4. Company under test"
Say "   $Company"
$known = $names | Where-Object { $_ -ieq $Company }
if ($names.Count -gt 0 -and -not $known) {
    Add-Warning "the chosen company is not in the list Tally returned; the test may fail."
}
Say ""

# ---------------------------------------------------------------- 5. masters
Say "5. Account and stock masters (this changes nothing)."
$mastersBody = '<ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>DATA</TYPE><ID>All Masters</ID></HEADER><BODY><DESC><STATICVARIABLES><SVCURRENTCOMPANY>' +
    (Escape-Xml $Company) +
    '</SVCURRENTCOMPANY><SVFROMDATE>' + $From + '</SVFROMDATE><SVTODATE>' + $To + '</SVTODATE><SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT></STATICVARIABLES></DESC></BODY></ENVELOPE>'
$mastersFile = Join-Path $OutDir "2-masters.xml"
$mastersResult = Invoke-Tally $mastersBody $mastersFile

$mastersIdentity = ""
$mastersCounts = $null
$mastersBalances = @{}
$mastersTags = 0
$mastersPartial = $false
$mastersSampleBytes = 0
if ($mastersResult.Ok) {
    $analysed = Read-Analysable $mastersFile
    $mastersPartial = $analysed.Partial
    $mastersSampleBytes = $analysed.Bytes
    $mastersTags = ([regex]::Matches($analysed.Text, '<[A-Za-z/]')).Count
    $mastersIdentity = Get-CompanyIdentity $analysed.Text
    $mastersBalances = Get-BalanceNames $analysed.Text
    $mastersCounts = [ordered]@{
        COMPANY = Count-Tag $analysed.Text "COMPANY"
        LEDGER = Count-Tag $analysed.Text "LEDGER"
        GROUP = Count-Tag $analysed.Text "GROUP"
        STOCKITEM = Count-Tag $analysed.Text "STOCKITEM"
        STOCKGROUP = Count-Tag $analysed.Text "STOCKGROUP"
        UNIT = Count-Tag $analysed.Text "UNIT"
        GODOWN = Count-Tag $analysed.Text "GODOWN"
        VOUCHERTYPE = Count-Tag $analysed.Text "VOUCHERTYPE"
        CURRENCY = Count-Tag $analysed.Text "CURRENCY"
    }
    Say "   YES - $([math]::Round($mastersResult.Bytes / 1MB, 1)) MB in $($mastersResult.Seconds) s"
    if ($mastersResult.Seconds -gt 60) {
        Add-Warning "the masters took $($mastersResult.Seconds) s. The bridge gives up after 60 s per request, so this response cannot come through the bridge as it stands."
    }
    if ($mastersPartial) { Add-Warning "the masters are larger than 64 MB; structure was read from the first 64 MB only." }
    Say ""
    Say "   Records in the response:"
    foreach ($key in $mastersCounts.Keys) {
        Say "     $key : $($mastersCounts[$key])"
    }
    Say "     total importable records : $(Get-MasterRecordCount $mastersCounts)"
    Say ""
    Say "   Does the response name its company?"
    if ($mastersIdentity) {
        Say "     YES - `"$mastersIdentity`""
        if ($mastersIdentity -ine $Company) {
            Add-Problem "the masters came back for `"$mastersIdentity`", not `"$Company`"."
        }
    } else {
        Add-Problem "the masters response does not name its company. The import refuses this."
    }
    Say ""
    Say "   Balance fields Tally actually returned:"
    if ($mastersBalances.Count -eq 0) {
        Say "     none - no opening or closing field appears in the masters."
    } else {
        foreach ($name in ($mastersBalances.Keys | Sort-Object)) {
            Say "     $name : $($mastersBalances[$name])"
        }
    }
} else {
    Add-Problem "the masters could not be read: $($mastersResult.Error)"
}
Say ""

# ---------------------------------------------------------------- 6. day book
Say "6. Transaction history (this changes nothing)."
$vouchersBody = '<ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>DATA</TYPE><ID>Day Book</ID></HEADER><BODY><DESC><STATICVARIABLES><SVCURRENTCOMPANY>' +
    (Escape-Xml $Company) +
    '</SVCURRENTCOMPANY><SVFROMDATE>' + $From + '</SVFROMDATE><SVTODATE>' + $To + '</SVTODATE><SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT></STATICVARIABLES></DESC></BODY></ENVELOPE>'
$vouchersFile = Join-Path $OutDir "3-day-book.xml"
$vouchersResult = Invoke-Tally $vouchersBody $vouchersFile

$voucherCount = 0
$vouchersIdentity = ""
$voucherTags = 0
$voucherSampleBytes = 0
$voucherPartial = $false
if ($vouchersResult.Ok) {
    $voucherCount = Count-PatternInFile $vouchersFile '<VOUCHER(?=[\s/>])'
    $analysedVouchers = Read-Analysable $vouchersFile
    $voucherPartial = $analysedVouchers.Partial
    $voucherSampleBytes = $analysedVouchers.Bytes
    $voucherTags = ([regex]::Matches($analysedVouchers.Text, '<[A-Za-z/]')).Count
    $vouchersIdentity = Get-CompanyIdentity $analysedVouchers.Text

    Say "   YES - $([math]::Round($vouchersResult.Bytes / 1MB, 1)) MB in $($vouchersResult.Seconds) s"
    if ($vouchersResult.Seconds -gt 60) {
        Add-Warning "the history took $($vouchersResult.Seconds) s. The bridge gives up after 60 s per request, so this response cannot come through the bridge as it stands."
    }
    Say "     vouchers in the whole file : $voucherCount"
    Say ""
    Say "   Does the response name its company?"
    if ($vouchersIdentity) {
        Say "     YES - `"$vouchersIdentity`""
        if ($vouchersIdentity -ine $Company) {
            Add-Problem "the history came back for `"$vouchersIdentity`", not `"$Company`"."
        }
    } else {
        Add-Problem "the history response does not name its company. The import refuses this."
    }
    Say ""
    Say "   Voucher types present (first 64 MB):"
    $types = @{}
    foreach ($match in [regex]::Matches($analysedVouchers.Text, '<VOUCHERTYPENAME>([^<]{1,80})</VOUCHERTYPENAME>')) {
        $name = $match.Groups[1].Value.Trim()
        if ($name) {
            if ($types.ContainsKey($name)) { $types[$name] = $types[$name] + 1 } else { $types[$name] = 1 }
        }
    }
    if ($types.Count -eq 0) {
        Say "     none named; the request returned no voucher types."
    } else {
        foreach ($name in ($types.Keys | Sort-Object)) { Say "     $name : $($types[$name])" }
    }
    if ($voucherPartial) { Add-Warning "the history is larger than 64 MB; the type list covers the first 64 MB only." }
} else {
    Add-Problem "the history could not be read: $($vouchersResult.Error)"
}
Say ""

# ---------------------------------------------------------------- capacity
Say "7. Can this history be imported as one file?"
if (-not $mastersResult.Ok -and -not $vouchersResult.Ok) {
    Say "   UNKNOWN - nothing was read."
} else {
    if (-not $mastersResult.Ok -or -not $vouchersResult.Ok) {
        Add-Warning "one of the two reads failed, so these figures cover only what was read. Do not treat this as a size verdict."
    }
    $combined = [long]$mastersResult.Bytes + [long]$vouchersResult.Bytes
    Say "   Size    : $([math]::Round($combined / 1MB, 1)) MB together; the limit is $([math]::Round($LimitBytes / 1MB, 0)) MB."
    if ($combined -gt $LimitBytes) {
        Add-Problem "the export is larger than the size limit, so it cannot be imported as one file."
    } else {
        Say "             fits."
    }

    $sampleBytes = [long]$mastersSampleBytes + [long]$voucherSampleBytes
    $sampleTags = [long]$mastersTags + [long]$voucherTags
    $estimatedTags = $sampleTags
    if ($sampleBytes -gt 0 -and $combined -gt $sampleBytes) {
        $estimatedTags = [long][math]::Round(($sampleTags / $sampleBytes) * $combined)
    }
    Say "   Tags    : about $estimatedTags; the limit is $LimitTags."
    if ($estimatedTags -gt $LimitTags) {
        Add-Problem "the file has more tags than the importer accepts, so it is refused outright (not imported partly)."
    } else {
        Say "             fits."
    }

    $masterRecords = Get-MasterRecordCount $mastersCounts
    $estimatedRecords = [long]$masterRecords + [long]$voucherCount
    Say "   Records : about $estimatedRecords; the limit is $LimitRecords."
    if ($estimatedRecords -gt $LimitRecords) {
        Add-Problem "the file has more records than the importer accepts. Reading stops at $LimitRecords records; the plan records that the export was cut short and Apply refuses it, so no partial migration can be applied. Do not import this file as it stands."
    } else {
        Say "             fits."
    }

    if ($combined -gt $LimitBytes -or $estimatedTags -gt $LimitTags -or $estimatedRecords -gt $LimitRecords) {
        Say ""
        Say "   VERDICT: BLOCKED. The full history does not fit in one import today."
        Say "   Splitting by date is NOT a workaround: each upload starts a separate"
        Say "   import, and nothing combines them into one checked migration."
    } else {
        Say ""
        Say "   VERDICT: the full history fits in one import."
    }
}
Say ""

# ---------------------------------------------------------------- answers
Say "Answers at a glance"
Say "   edition=$edition"
Say "   version=$version"
Say "   port_answering=$reachable"
Say "   companies=$($names.Count)"
Say "   selected=$Company"
Say "   masters_ok=$($mastersResult.Ok)"
Say "   masters_names_company=$([bool]$mastersIdentity)"
Say "   masters_balance_fields=$(($mastersBalances.Keys | Sort-Object) -join ',')"
Say "   daybook_ok=$($vouchersResult.Ok)"
Say "   daybook_names_company=$([bool]$vouchersIdentity)"
Say "   vouchers=$voucherCount"
Say "   masters_bytes=$($mastersResult.Bytes)"
Say "   masters_seconds=$($mastersResult.Seconds)"
Say "   daybook_bytes=$($vouchersResult.Bytes)"
Say "   daybook_seconds=$($vouchersResult.Seconds)"

Finish 0
