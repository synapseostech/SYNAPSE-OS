<#
    SYNAPSE Tally history export

    Runs on the pharmacy computer with Tally open and the company loaded.
    It asks Tally for the whole transaction history between two dates, in
    slices small enough to import, and writes one XML file per slice plus one
    masters file. A slice Tally answers with more than 50 MB is split and
    fetched again, so every file in the folder can be imported.

    The vouchers come from the Voucher Register, not the Day Book report: on
    Tally.ERP 9 the Day Book ignores the dates it is given and answers with
    today's vouchers. The register honours them, but only when the end date is
    a month end, so slices are whole months.

    Every file names the dates it covers (3-daybook-20250101-20251231.xml), and
    the portal reads that range from the name. Add all of them to one cut-over.

    It finds Tally by itself. It asks Windows which ports Tally is listening on,
    falls back to the usual 9000-9010 and 9999, and confirms a candidate by
    asking it for the company list. It then asks Tally when the company's books
    begin, and exports from that day to today, so no date has to be given.

    -To defaults to today. A slice with no transactions is still exported,
    because it is what covers those dates. Pass -From only to override the start
    that Tally reports, or -Port when Tally listens somewhere it cannot find.

    It reads only. It changes nothing in Tally and uploads nothing: the only
    network traffic is to 127.0.0.1 on this computer.

    Tally must accept XML over HTTP first. In TallyPrime:
        F1 -> Settings -> Connectivity -> "TallyPrime acts as: Server"

    Run it by right-clicking the file and choosing "Run with PowerShell", or:
        powershell -ExecutionPolicy Bypass -File .\tally-export-history.ps1

    Examples:
        .\tally-export-history.ps1
        .\tally-export-history.ps1 -Company "Nakawa Pharmacy"
        .\tally-export-history.ps1 -Company "Nakawa Pharmacy" -From 20200401
        .\tally-export-history.ps1 -Port 9005 -NoExplorer
#>

param(
    [string]$Company = "",
    [string]$From = "",
    [string]$To = "",
    # 0 means "find it": Tally's listening ports first, then the usual ones.
    [int]$Port = 0,
    # One calendar month per file: a busy pharmacy month stays under the 50 MB
    # the importer accepts, so the run needs no splitting.
    [int]$MonthsPerFile = 1,
    [string]$OutDir = "$env:USERPROFILE\Desktop\SynapseTallyExport",
    [switch]$NoExplorer
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

# The importer refuses a source larger than this, so a slice above it is
# useless. Reported here rather than written and forgotten.
$LimitBytes = 50MB

function Say([string]$text, $ForegroundColor = $null) {
    if ($null -ne $ForegroundColor) {
        Write-Host $text -ForegroundColor $ForegroundColor
    } else {
        Write-Host $text
    }
}

function Fail([string]$message) {
    Write-Host ""
    Write-Host "  $message" -ForegroundColor Red
    Write-Host ""
    if ([Environment]::UserInteractive) { Read-Host "Press Enter to close" | Out-Null }
    exit 1
}

function Parse-Day([string]$value, [string]$label) {
    $parsed = [datetime]::MinValue
    $ok = [datetime]::TryParseExact(
        $value.Trim(),
        "yyyyMMdd",
        [System.Globalization.CultureInfo]::InvariantCulture,
        [System.Globalization.DateTimeStyles]::None,
        [ref]$parsed
    )
    if (-not $ok) {
        Fail "$label must be eight digits, year first - for example 20200401. Got '$value'."
    }
    return $parsed
}

function Escape-Xml([string]$value) {
    return $value.Replace("&", "&amp;").Replace("<", "&lt;").Replace(">", "&gt;").Replace('"', "&quot;")
}

function Read-HeadText([string]$path, [int]$count) {
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

# Tally names the company in most of its replies and leaves it out of some.
# A file that does not name it cannot be added to a cut-over at all, because
# nothing then says which company the migration is for. The record is written
# in place, once, and only when the reply did not carry one.
function Add-CompanyRecord([string]$path, [string]$record) {
    $head = Read-HeadText $path 65536
    if ($head -match '<COMPANY\b') { return $false }
    $text = [System.IO.File]::ReadAllText($path)
    $open = $text.IndexOf('<DATA')
    if ($open -lt 0) { return $false }
    $close = $text.IndexOf('>', $open)
    if ($close -lt 0) { return $false }
    [System.IO.File]::WriteAllText($path, $text.Insert($close + 1, $record), (New-Object System.Text.UTF8Encoding $false))
    return $true
}

function Read-TailText([string]$path, [int]$count) {
    $stream = [System.IO.File]::OpenRead($path)
    try {
        $length = [int][Math]::Min($stream.Length, $count)
        $stream.Seek(-$length, [System.IO.SeekOrigin]::End) | Out-Null
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

# Tally prints dates the way its own display settings say, not always as
# yyyyMMdd, so every shape it is known to use is tried.
function ConvertFrom-TallyDate([string]$value) {
    if (-not $value) { return $null }
    $text = $value.Trim()
    $parsed = [datetime]::MinValue
    foreach ($format in @("yyyyMMdd", "yyyy-MM-dd", "dd-MM-yyyy", "dd-MMM-yyyy", "d-MMM-yyyy", "dd/MM/yyyy", "dd MMM yyyy", "d MMM yyyy", "dd-MMM-yy", "d-MMM-yy")) {
        if ([datetime]::TryParseExact($text, $format, [System.Globalization.CultureInfo]::InvariantCulture, [System.Globalization.DateTimeStyles]::None, [ref]$parsed)) {
            return $parsed
        }
    }
    return $null
}

function Test-TcpPort([int]$candidate, [int]$timeoutMs = 400) {
    $client = New-Object System.Net.Sockets.TcpClient
    try {
        $task = $client.ConnectAsync("127.0.0.1", $candidate)
        if (-not $task.Wait($timeoutMs)) { return $false }
        return $client.Connected
    } catch {
        return $false
    } finally {
        try { $client.Close() } catch { }
    }
}

function Get-TallyCandidatePorts([int]$explicitPort) {
    $candidates = New-Object System.Collections.Generic.List[int]
    if ($explicitPort -gt 0) {
        $candidates.Add($explicitPort)
        return $candidates
    }
    # Ask Windows which ports Tally itself is listening on. Tally 9 runs as
    # tally.exe and TallyPrime as TallyPrime.exe.
    try {
        $tallyIds = @(Get-Process -Name "tally*" -ErrorAction Stop | Select-Object -ExpandProperty Id)
        if ($tallyIds.Count -gt 0) {
            $listening = Get-NetTCPConnection -State Listen -ErrorAction Stop |
                Where-Object { $tallyIds -contains $_.OwningProcess } |
                Select-Object -ExpandProperty LocalPort -Unique
            foreach ($port in $listening) {
                if (-not $candidates.Contains([int]$port)) { $candidates.Add([int]$port) }
            }
        }
    } catch {
        # Get-NetTCPConnection is absent on very old Windows; the scan covers it.
    }
    foreach ($port in @(9000, 9001, 9002, 9003, 9004, 9005, 9006, 9007, 9008, 9009, 9010, 9999)) {
        if (-not $candidates.Contains($port)) { $candidates.Add($port) }
    }
    return $candidates
}

# The first port where Tally answers is the one, and its reply is kept: the
# same request that proves the port also names the companies.
function Find-TallyEndpoint([string]$companyBody, [int]$explicitPort) {
    $tried = 0
    foreach ($candidate in (Get-TallyCandidatePorts $explicitPort)) {
        if (-not (Test-TcpPort $candidate)) { continue }
        $tried++
        Say ("  Something answers on 127.0.0.1:{0}; asking it for the company list ..." -f $candidate)
        $probe = Join-Path $script:DiagDir ("probe-{0}.xml" -f $candidate)
        $result = Invoke-Tally $companyBody $probe $candidate
        if ($result.Ok) {
            return [pscustomobject]@{ Port = $candidate; File = $probe; Tried = $tried }
        }
        Remove-Item -LiteralPath $probe -Force -ErrorAction SilentlyContinue
    }
    return [pscustomobject]@{ Port = 0; File = $null; Tried = $tried }
}

function Get-CompanyPeriod([string]$company, [string]$nativeMethod) {
    $body = '<ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Collection</TYPE><ID>Synapse Company Period</ID></HEADER><BODY><DESC><STATICVARIABLES><SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT></STATICVARIABLES><TDL><TDLMESSAGE><COLLECTION NAME="Synapse Company Period" ISMODIFY="No" ISFIXED="No" ISINITIALIZE="No" ISOPTION="No" ISINTERNAL="No"><TYPE>Company</TYPE><NATIVEMETHOD>Name</NATIVEMETHOD><NATIVEMETHOD>' +
        $nativeMethod +
        '</NATIVEMETHOD></COLLECTION></TDLMESSAGE></TDL></DESC></BODY></ENVELOPE>'
    $file = Join-Path $script:DiagDir ("company-period-{0}.xml" -f $nativeMethod.ToLowerInvariant())
    $result = Invoke-Tally $body $file
    if (-not $result.Ok) { return $null }

    $text = Get-Content -LiteralPath $file -Raw
    foreach ($match in [regex]::Matches($text, '<COMPANY\b[^>]*\bNAME="([^"]{1,400})"')) {
        $name = [System.Net.WebUtility]::HtmlDecode($match.Groups[1].Value)
        if ($name -ine $company) { continue }
        # Stop at the next company, so one company's dates are never read out of
        # the record that follows it.
        $rest = $match.Index + $match.Length
        $next = [regex]::Match($text.Substring($rest), '<COMPANY\b')
        $windowEnd = if ($next.Success) { $rest + $next.Index } else { $text.Length }
        if ($windowEnd - $match.Index -gt 4000) { $windowEnd = $match.Index + 4000 }
        $window = $text.Substring($match.Index, $windowEnd - $match.Index)
        $tag = $nativeMethod.ToUpperInvariant()
        # Either an attribute on the COMPANY tag or an element inside it.
        $attribute = [regex]::Match($window, '\b' + $tag + '\s*=\s*"([^"]+)"')
        if ($attribute.Success) {
            $parsed = ConvertFrom-TallyDate $attribute.Groups[1].Value
            if ($parsed) { return $parsed }
        }
        $element = [regex]::Match($window, '<' + $tag + '[^>]*>([^<]+)</' + $tag + '>')
        if ($element.Success) {
            $parsed = ConvertFrom-TallyDate $element.Groups[1].Value
            if ($parsed) { return $parsed }
        }
    }
    return $null
}

# When the pharmacy's books begin. TallyPrime calls it StartingFrom; older
# builds expose BooksFrom. They are asked separately because a method a build
# does not know can fail the whole request, and that must not hide the other.
function Get-BooksStart([string]$company) {
    foreach ($method in @("StartingFrom", "BooksFrom")) {
        $found = Get-CompanyPeriod $company $method
        if ($found) { return $found }
    }
    return $null
}

# The voucher dates a file holds, read from its head and tail only: a 50 MB
# export is one long line, and scanning all of it to report the range would
# cost more than the run itself.
function Get-VoucherDates([string]$path, [int]$edgeBytes = 262144) {
    $dates = New-Object System.Collections.Generic.List[datetime]
    if (-not (Test-Path -LiteralPath $path)) { return $dates }
    foreach ($chunk in @((Read-HeadText $path $edgeBytes), (Read-TailText $path $edgeBytes))) {
        foreach ($match in [regex]::Matches($chunk, '<DATE[^>]*>([^<]{4,30})</DATE>')) {
            $parsed = ConvertFrom-TallyDate $match.Groups[1].Value
            if ($parsed) { $dates.Add($parsed) }
        }
    }
    return $dates
}

function Invoke-Tally([string]$body, [string]$outFile, [int]$targetPort = 0) {
    if ($targetPort -le 0) { $targetPort = $script:Port }
    $started = Get-Date
    try {
        Invoke-WebRequest -Uri "http://127.0.0.1:$targetPort" -Method Post -Body $body `
            -OutFile $outFile -TimeoutSec 1800 -UseBasicParsing | Out-Null
    } catch {
        return [pscustomobject]@{ Ok = $false; Error = $_.Exception.Message; Seconds = 0; Bytes = 0 }
    }
    $seconds = [math]::Round(((Get-Date) - $started).TotalSeconds, 1)
    $bytes = (Get-Item -LiteralPath $outFile).Length
    # Tally answers an error with HTTP 200 and <STATUS>0</STATUS>, so the
    # envelope is the only trustworthy signal. A successful data export on
    # Tally.ERP 9 carries no STATUS at all and opens with ENVELOPE, which is
    # what a large reply is accepted on; an error page is short and says so.
    $head = Read-HeadText $outFile 4096
    $refused = $head -match "<STATUS>\s*0\s*</STATUS>" -or
        $head -match "<LINEERROR>" -or
        $head -match "Unknown Request" -or
        $head -match "<RESPONSE>[^<]*cannot be processed"
    $answered = (-not $refused) -and (
        ($head -match "<STATUS>\s*1\s*</STATUS>") -or
        (($head -match "<ENVELOPE") -and $bytes -gt 2048)
    )
    return [pscustomobject]@{ Ok = $answered; Error = $null; Seconds = $seconds; Bytes = $bytes }
}

# The master records are read in memory, not into a file: each type is asked
# for on its own and the records are joined into the one masters file the
# portal takes.
function Invoke-TallyText([string]$body, [int]$targetPort = 0) {
    if ($targetPort -le 0) { $targetPort = $script:Port }
    $response = Invoke-WebRequest -Uri "http://127.0.0.1:$targetPort" -Method Post -Body $body `
        -TimeoutSec 1800 -UseBasicParsing -DisableKeepAlive
    if ($response.Content -is [byte[]]) {
        return [System.Text.Encoding]::UTF8.GetString($response.Content)
    }
    return [string]$response.Content
}

# "All Masters" is the obvious request and the one this build answers with an
# empty envelope, so each master type is asked for as a collection instead.
# Collection attributes are single-quoted: that is valid XML and keeps the whole
# request inside one PowerShell single-quoted string, with no escapes.
function Get-MasterRecords([string]$type, [string[]]$methods) {
    $id = "Synapse $type"
    $methodXml = (@($methods) | ForEach-Object { "<NATIVEMETHOD>$_</NATIVEMETHOD>" }) -join ""
    $body = '<ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Collection</TYPE><ID>' + $id +
        '</ID></HEADER><BODY><DESC><STATICVARIABLES><SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT><SVCURRENTCOMPANY>' +
        (Escape-Xml $script:Company) +
        '</SVCURRENTCOMPANY></STATICVARIABLES><TDL><TDLMESSAGE><COLLECTION NAME=''' + $id +
        ''' ISMODIFY=''No'' ISFIXED=''No'' ISINITIALIZE=''No'' ISOPTION=''No'' ISINTERNAL=''No''><TYPE>' + $type +
        '</TYPE>' + $methodXml + '</COLLECTION></TDLMESSAGE></TDL></DESC></BODY></ENVELOPE>'

    $text = Invoke-TallyText $body
    $tag = $type.ToUpperInvariant()
    return @([regex]::Matches($text, '<' + $tag + '\b[^>]*>[\s\S]*?</' + $tag + '>') | ForEach-Object { $_.Value })
}

function Format-Size([long]$bytes) {
    if ($bytes -ge 1MB) { return ("{0:N1} MB" -f ($bytes / 1MB)) }
    if ($bytes -ge 1KB) { return ("{0:N1} KB" -f ($bytes / 1KB)) }
    return "$bytes B"
}

Say ""
Say "  SYNAPSE - export Tally history to files"
Say "  ---------------------------------------"
Say ""

# The run ends today unless -To says otherwise. It starts at the pharmacy's own
# books beginning, which is read from Tally once the company is known (below):
# the history starts before the first voucher, so a whole-calendar slice with no
# transactions is normal and still belongs to the import.
if (-not $To.Trim()) { $To = (Get-Date).ToString("yyyyMMdd") }

$endDate = Parse-Day $To "-To"
if ($From.Trim()) {
    $startDate = Parse-Day $From "-From"
    if ($startDate -gt $endDate) { Fail "-From ($From) is after -To ($To)." }
}
if ($MonthsPerFile -lt 1 -or $MonthsPerFile -gt 120) { Fail "-MonthsPerFile must be between 1 and 120." }

New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
$OutDir = (Resolve-Path -LiteralPath $OutDir).Path
# The company list is a diagnostic, not an import file. Kept in its own folder
# so that selecting every file in $OutDir never picks it up.
$DiagDir = Join-Path $OutDir "_diagnostics"
New-Item -ItemType Directory -Force -Path $DiagDir | Out-Null

# ---------------------------------------------------------------- endpoint
# Tally is found rather than assumed: -Port wins, then the ports Tally's own
# process is listening on, then the usual 9000-9010 and 9999. A candidate only
# counts once it answers the company list, so a port that is open but belongs
# to something else is passed over instead of failing the run.
Say "  Looking for Tally ..."
$companyBody = '<ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Collection</TYPE><ID>List of Companies</ID></HEADER><BODY><DESC><STATICVARIABLES><SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT></STATICVARIABLES><TDL><TDLMESSAGE><COLLECTION NAME="List of Companies" ISMODIFY="No" ISFIXED="No" ISINITIALIZE="No" ISOPTION="No" ISINTERNAL="No"><TYPE>Company</TYPE><NATIVEMETHOD>Name</NATIVEMETHOD></COLLECTION></TDLMESSAGE></TDL></DESC></BODY></ENVELOPE>'
$companyFile = Join-Path $DiagDir "companies.xml"
$endpoint = Find-TallyEndpoint $companyBody $Port

if ($endpoint.Port -le 0) {
    if ($endpoint.Tried -eq 0) {
        $where = if ($Port -gt 0) { "127.0.0.1:$Port" } else { "any port on this computer" }
        Fail ("Nothing was listening on " + $where + ".`n`n" +
            "  Open TallyPrime with the pharmacy's company, then run this again.`n" +
            "  If Tally is open but still not found, give the port it listens on:`n" +
            "    .\tally-export-history.ps1 -Port 9000")
    }
    Fail ("Something answered, but none of it was Tally.`n`n" +
        "  Check that Tally accepts XML over HTTP:`n" +
        "    TallyPrime -> F1 -> Settings -> Connectivity`n" +
        "    TallyPrime acts as : Server")
}

Move-Item -LiteralPath $endpoint.File -Destination $companyFile -Force
$Port = $endpoint.Port
Say ("  Found Tally on 127.0.0.1:{0}." -f $Port)

$companyText = Get-Content -LiteralPath $companyFile -Raw
$names = @(
    @(
        ([regex]::Matches($companyText, '<COMPANY\b[^>]*?\bNAME="([^"]{1,400})"') | ForEach-Object { $_.Groups[1].Value }) +
        ([regex]::Matches($companyText, '<COMPANYNAME>([^<]{1,400})</COMPANYNAME>') | ForEach-Object { $_.Groups[1].Value })
    ) | ForEach-Object { [System.Net.WebUtility]::HtmlDecode($_) } | Where-Object { $_ } | Select-Object -Unique
)

if ($names.Count -eq 0) {
    Fail "Tally answered but named no company. Open the pharmacy's company in Tally, then run this again."
}

Say "  Companies Tally has open:"
for ($i = 0; $i -lt $names.Count; $i++) { Say ("    {0}. {1}" -f ($i + 1), $names[$i]) }

if (-not $Company) {
    if ($names.Count -eq 1) {
        $Company = $names[0]
    } elseif ([Environment]::UserInteractive) {
        $answer = Read-Host "  Type the number of the company to export, then press Enter"
        $index = 0
        if ([int]::TryParse($answer, [ref]$index) -and $index -ge 1 -and $index -le $names.Count) {
            $Company = $names[$index - 1]
        }
    }
    if (-not $Company) {
        Fail "No company was chosen, so nothing was exported. Pass -Company `"name`"."
    }
}

if (-not ($names | Where-Object { $_ -ieq $Company })) {
    Fail "Tally has no open company named '$Company'. Names above are the ones it reports."
}

# ---------------------------------------------------------------- start date
# The pharmacy's own books beginning, so the opening balances are dated where
# the ledger really starts. -From overrides it; when Tally will not say and the
# operator cannot be asked, the run stops rather than guessing a year.
if (-not $From.Trim()) {
    Say ""
    Say "  Asking Tally when this company's books begin ..."
    $booksStart = Get-BooksStart $Company
    if ($booksStart) {
        $startDate = $booksStart.Date
        Say ("  Books begin on {0}." -f $startDate.ToString("yyyy-MM-dd"))
    } elseif ([Environment]::UserInteractive) {
        $answer = Read-Host "  Tally did not say. Type the date the books begin (YYYYMMDD), or press Enter if unsure"
        if ($answer -and $answer.Trim()) {
            $startDate = Parse-Day $answer.Trim() "start date"
        }
    }
    if (-not $startDate) {
        Fail ("Tally did not report when the books begin, and none was given, so nothing was exported.`n`n" +
            "  Run it again with the date the company's books start, for example:`n" +
            "    .\tally-export-history.ps1 -Company `"" + $Company + "`" -From 20200101")
    }
    if ($startDate -gt $endDate) {
        Fail ("The books begin on " + $startDate.ToString("yyyyMMdd") + ", after -To (" + $To + ").")
    }
    $earliest = [datetime]::ParseExact("19800101", "yyyyMMdd", [System.Globalization.CultureInfo]::InvariantCulture)
    if ($startDate -lt $earliest) {
        Fail ("Tally reports the books beginning " + $startDate.ToString("yyyyMMdd") + ", which is too early to be real. Pass -From to override it.")
    }
    $From = $startDate.ToString("yyyyMMdd")
}

Say ""
Say "  Company : $Company"
Say "  Period  : $From to $To"
Say "  Slices  : $MonthsPerFile month(s) per file"
Say "  Folder  : $OutDir"
Say ""

# ----------------------------------------------------------------- masters
# One file, taken first, holding what the import builds parties and products
# from. It carries the same range as the voucher files in its name: the portal
# reads each file's own dates from the name, so every file in the folder
# agrees on the period the cut-over covers.
$written = New-Object System.Collections.Generic.List[object]
$problems = New-Object System.Collections.Generic.List[string]
$emptySlices = New-Object System.Collections.Generic.List[string]

Say "  Writing masters (one file, balances as at $To) ..."
$mastersFile = Join-Path $OutDir "2-masters-$From-$To.xml"
# The columns the importer reads, and what to ask for when this build does not
# know one of the newer ones: Tally answers an unknown method with an empty
# collection rather than an error, and losing bills is better than losing every
# ledger. Bills carry what is still owed to a supplier or by a customer, and
# batches carry the expiry the till needs, so both are asked for.
$masterPlan = @(
    @{ Type = "Ledger"; Methods = @("Name", "Parent", "OpeningBalance", "ClosingBalance", "BillWise", "BillAllocations", "Email", "Phone", "Mobile", "Address"); Fallback = @("Name", "Parent", "OpeningBalance", "ClosingBalance") },
    @{ Type = "Group"; Methods = @("Name", "Parent"); Fallback = @("Name", "Parent") },
    @{ Type = "StockItem"; Methods = @("Name", "Parent", "BaseUnits", "OpeningBalance", "OpeningRate", "OpeningValue", "ClosingBalance", "ClosingValue", "BatchWise", "BatchAllocations"); Fallback = @("Name", "Parent", "BaseUnits", "OpeningBalance", "OpeningRate", "OpeningValue", "ClosingBalance", "ClosingValue") },
    @{ Type = "StockGroup"; Methods = @("Name", "Parent"); Fallback = @("Name", "Parent") },
    @{ Type = "Unit"; Methods = @("Name", "Symbol"); Fallback = @("Name", "Symbol") },
    @{ Type = "Godown"; Methods = @("Name", "Parent"); Fallback = @("Name", "Parent") }
)

$masterRecords = New-Object System.Collections.Generic.List[string]
$stockItemCount = 0
foreach ($entry in $masterPlan) {
    try {
        $records = @(Get-MasterRecords $entry.Type $entry.Methods)
        # Nothing at all means the build ignored a column it does not have, not
        # that the company has no rows of this type. Ask again for the columns
        # every build answering the company list knows.
        if ($records.Count -eq 0 -and (($entry.Fallback -join ",") -ne ($entry.Methods -join ","))) {
            Say ("    {0}: none with the newer columns, asking again without them" -f $entry.Type)
            $records = @(Get-MasterRecords $entry.Type $entry.Fallback)
        }
    } catch {
        Say ("    FAILED - Tally refused the {0} list: {1}" -f $entry.Type, ($_.Exception.Message)) -ForegroundColor Red
        $problems.Add("masters/$($entry.Type): " + $_.Exception.Message)
        continue
    }
    foreach ($record in $records) { $masterRecords.Add($record) }
    if ($entry.Type -eq "StockItem") { $stockItemCount = $records.Count }
    Say ("    {0,6} {1}" -f $records.Count, ($entry.Type.ToLowerInvariant()))
}

# Tally writes a stock item's rate as `2500.00/ea`. The importer reads that one
# field as a plain amount and rejects the suffix, which would price every
# product from the value Tally stores signed the other way.
$masterXml = [regex]::Replace(
    ($masterRecords -join ""),
    '(<OPENINGRATE\b[^>]*>\s*[+-]?[\d.,]+)\s*/\s*[^<]*(</OPENINGRATE>)',
    '$1$2')

if ($masterRecords.Count -eq 0) {
    Say "    FAILED - Tally returned no master records" -ForegroundColor Red
    $problems.Add("masters: Tally returned no master records")
    # A file left by an earlier run must not be mistaken for this one.
    Remove-Item -LiteralPath $mastersFile -Force -ErrorAction SilentlyContinue
} else {
    # The company record is what tells the portal which company these records
    # belong to and which period they cover. Each collection reply carries the
    # records but not the company they came from, so it is written here from
    # what Tally already reported. Without it the file cannot be staged at all:
    # nothing in the folder would say which company the cut-over is for.
    $companyRecord = '<COMPANY NAME="' + (Escape-Xml $Company) + '"><COMPANYNAME>' + (Escape-Xml $Company) +
        '</COMPANYNAME><SVFROMDATE>' + $From + '</SVFROMDATE><SVTODATE>' + $To + '</SVTODATE></COMPANY>'
    $document = '<ENVELOPE><BODY><DATA>' + $companyRecord + $masterXml + '</DATA></BODY></ENVELOPE>'
    [System.IO.File]::WriteAllText($mastersFile, $document, (New-Object System.Text.UTF8Encoding $false))
    $mastersBytes = (Get-Item -LiteralPath $mastersFile).Length
    Say ("    OK - {0}" -f (Format-Size $mastersBytes))
    $written.Add([pscustomobject]@{ File = $mastersFile; Bytes = $mastersBytes; From = ""; To = $To })
    if ($stockItemCount -eq 0) {
        # Products are created from stock items; vouchers alone import no stock.
        $problems.Add("masters: Tally returned no stock items, so no products will be created")
    }
}
Say ""

# ----------------------------------------------------------- voucher register
# The Day Book report ignores SVFROMDATE/SVTODATE on Tally.ERP 9 and answers
# with today's vouchers whatever range is asked for. The Voucher Register
# honours both, but only when SVTODATE lands on a month end, so slices are
# whole months and the files are named by those months.
$slices = New-Object System.Collections.Generic.List[object]
$cursor = $startDate
while ($cursor -le $endDate) {
    $monthStart = $cursor.AddDays(1 - $cursor.Day)
    $sliceEnd = $monthStart.AddMonths($MonthsPerFile).AddDays(-1)
    if ($sliceEnd -gt $endDate) { $sliceEnd = $endDate }
    $slices.Add([pscustomobject]@{ From = $cursor; To = $sliceEnd })
    $cursor = $sliceEnd.AddDays(1)
}

Say ("  Writing the voucher register in {0} file(s) ..." -f $slices.Count)

# Every calendar month inside a range, used when a slice is too big to import.
function Get-MonthRanges([datetime]$from, [datetime]$to) {
    $ranges = New-Object System.Collections.Generic.List[object]
    $cursor = $from
    while ($cursor -le $to) {
        $end = $cursor.AddDays([datetime]::DaysInMonth($cursor.Year, $cursor.Month) - $cursor.Day)
        if ($end -gt $to) { $end = $to }
        $ranges.Add([pscustomobject]@{ From = $cursor; To = $end })
        $cursor = $end.AddDays(1)
    }
    return $ranges
}

# A slice Tally answers with more than the importer accepts is cut down and
# fetched again, so the folder ends up holding only files that can be imported
# without a second run by hand. Whole months are tried first, because a day
# range the register does not honour would silently export the wrong dates.
function Export-Vouchers([datetime]$sliceFrom, [datetime]$sliceTo, [int]$depth) {
    $from = $sliceFrom.ToString("yyyyMMdd")
    $to = $sliceTo.ToString("yyyyMMdd")
    $label = "$from to $to"

    # The run ends today, which is rarely a month end. Tally has no vouchers
    # after today, so the request reaches to the month's last day and the file
    # keeps the real end in its name.
    $requestTo = $sliceTo
    if ($sliceTo -eq $script:endDate -and $sliceTo.Day -ne [datetime]::DaysInMonth($sliceTo.Year, $sliceTo.Month)) {
        $requestTo = $sliceTo.AddDays([datetime]::DaysInMonth($sliceTo.Year, $sliceTo.Month) - $sliceTo.Day)
    }

    $voucherBody = '<ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>DATA</TYPE><ID>Voucher Register</ID></HEADER><BODY><DESC><STATICVARIABLES><SVCURRENTCOMPANY>' +
        (Escape-Xml $script:Company) +
        '</SVCURRENTCOMPANY><SVFROMDATE>' + $from + '</SVFROMDATE><SVTODATE>' + $requestTo.ToString("yyyyMMdd") + '</SVTODATE><SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT></STATICVARIABLES></DESC></BODY></ENVELOPE>'

    $file = Join-Path $script:OutDir "3-daybook-$from-$to.xml"
    $result = Invoke-Tally $voucherBody $file

    if (-not $result.Ok) {
        $message = if ($result.Error) { $result.Error } else { "Tally reported an error; see the file" }
        Say ("    {0}  FAILED - {1}" -f $label, $message) -ForegroundColor Red
        $script:problems.Add("$label : $message")
        return
    }

    if ($result.Bytes -eq 0) {
        Say ("    {0}  Tally returned nothing" -f $label) -ForegroundColor Red
        $script:problems.Add("$label : Tally returned an empty reply")
        Remove-Item -LiteralPath $file -Force -ErrorAction SilentlyContinue
        return
    }

    if ($result.Bytes -gt $script:LimitBytes) {
        if ($depth -lt 20) {
            $months = @(Get-MonthRanges $sliceFrom $sliceTo)
            if ($months.Count -gt 1) {
                Say ("    {0}  {1} - over the limit, splitting by month" -f $label, (Format-Size $result.Bytes)) -ForegroundColor Yellow
                Remove-Item -LiteralPath $file -Force
                foreach ($month in $months) { Export-Vouchers $month.From $month.To ($depth + 1) }
                return
            }
            if ($sliceFrom -lt $sliceTo) {
                $days = [int]($sliceTo.Date - $sliceFrom.Date).TotalDays
                $mid = $sliceFrom.Date.AddDays([math]::Floor($days / 2))
                Say ("    {0}  {1} - over the limit, splitting in half" -f $label, (Format-Size $result.Bytes)) -ForegroundColor Yellow
                Remove-Item -LiteralPath $file -Force
                Export-Vouchers $sliceFrom $mid ($depth + 1)
                Export-Vouchers $mid.AddDays(1) $sliceTo ($depth + 1)
                return
            }
        }
        Say ("    {0}  {1}  TOO BIG" -f $label, (Format-Size $result.Bytes)) -ForegroundColor Red
        $script:problems.Add("$label is " + (Format-Size $result.Bytes) + ", over the 50 MB limit, even for a single day")
        return
    }

    # The same company record the masters file carries, so a reply that leaves
    # the company out can still be staged beside it.
    $companyRecord = '<COMPANY NAME="' + (Escape-Xml $script:Company) + '"><COMPANYNAME>' + (Escape-Xml $script:Company) +
        '</COMPANYNAME><SVFROMDATE>' + $from + '</SVFROMDATE><SVTODATE>' + $to + '</SVTODATE></COMPANY>'
    [void](Add-CompanyRecord $file $companyRecord)

    $script:written.Add([pscustomobject]@{ File = $file; Bytes = $result.Bytes; From = $from; To = $to })
    if (Select-String -LiteralPath $file -Pattern '<VOUCHER' -SimpleMatch -Quiet) {
        Say ("    {0}  {1} in {2}s" -f $label, (Format-Size $result.Bytes), $result.Seconds)
    } else {
        # Still a required file: its dates are part of the period the
        # cut-over has to cover, even though nothing was posted in them.
        Say ("    {0}  no transactions" -f $label)
        $script:emptySlices.Add($label)
    }
}

foreach ($slice in $slices) { Export-Vouchers $slice.From $slice.To 0 }

# ---------------------------------------------------------------- coverage
# The import needs the slices to cover the period end to end. A file that
# failed, or one left too big, would leave a hole; it is reported here rather
# than discovered at upload time.
$daybook = @($written | Where-Object { $_.From } | Sort-Object { $_.From })
if ($daybook.Count -gt 0) {
    $expected = $startDate
    foreach ($entry in $daybook) {
        $entryFrom = Parse-Day $entry.From "slice"
        $entryTo = Parse-Day $entry.To "slice"
        if ($entryFrom -gt $expected) {
            $problems.Add(("the voucher files leave {0} to {1} uncovered" -f $expected.ToString("yyyyMMdd"), $entryFrom.AddDays(-1).ToString("yyyyMMdd")))
            break
        }
        if ($entryTo -ge $expected) { $expected = $entryTo.AddDays(1) }
    }
    if ($expected -le $endDate) {
        $problems.Add(("the voucher files stop at {0}, before {1}" -f $expected.AddDays(-1).ToString("yyyyMMdd"), $To))
    }
}

# ----------------------------------------------------------------- voucher dates
# What the files actually carry, so a Tally that quietly ignored the requested
# start date is visible before the upload rather than after the rebuild.
$allDates = New-Object System.Collections.Generic.List[datetime]
foreach ($entry in ($written | Where-Object { $_.From })) {
    $allDates.AddRange([datetime[]]@(Get-VoucherDates $entry.File))
}
if ($allDates.Count -gt 0) {
    $firstVoucher = ($allDates | Measure-Object -Minimum).Minimum
    $lastVoucher = ($allDates | Measure-Object -Maximum).Maximum
    Say ""
    Say ("  Vouchers run from {0} to {1}." -f $firstVoucher.ToString("yyyy-MM-dd"), $lastVoucher.ToString("yyyy-MM-dd"))
    if ($firstVoucher -lt $startDate) {
        $problems.Add(("a voucher is dated {0}, before the books begin on {1}" -f $firstVoucher.ToString("yyyyMMdd"), $startDate.ToString("yyyyMMdd")))
    }
}

# ----------------------------------------------------------------- summary
Say ""
Say "  Files written to $OutDir"
Say ""
foreach ($entry in $written) {
    $size = (Format-Size $entry.Bytes).PadLeft(9)
    Say ("    {0}  {1}" -f $size, (Split-Path -Leaf $entry.File))
}

if ($emptySlices.Count -gt 0) {
    Say ""
    Say ("  {0} file(s) hold no transactions. Keep them: they cover those dates, and the" -f $emptySlices.Count)
    Say "  import needs every day of the period accounted for. They import as empty ranges."
}

if ($problems.Count -gt 0) {
    Say ""
    Say "  Problems:" -ForegroundColor Red
    foreach ($problem in $problems) { Say ("    - " + $problem) -ForegroundColor Red }
}

Say ""
Say "  Next: open the portal on this computer, go to the Tally cut-over import, and"
Say "  add every file named 2-* and 3-* in the folder above, then Upload and review."
Say "  The period fields can stay empty: each file's own dates are read from its name."
Say ""

Say ""
Say "  Nothing was uploaded and nothing left this computer."
Say "  These files hold real account names, addresses and phone numbers."
Say "  Treat the folder as confidential and delete it when the import is done."
Say ""

if (-not $NoExplorer) {
    try { Start-Process explorer.exe $OutDir } catch { }
}

if ($problems.Count -gt 0) { exit 1 }
exit 0
