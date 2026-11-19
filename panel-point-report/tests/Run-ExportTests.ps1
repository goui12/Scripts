#Requires -Version 5.1
<# Native Windows smoke tests. Synthetic replay only; no panel/network contact. #>
[CmdletBinding()]
param(
    [string]$LauncherPath = (Join-Path (Split-Path $PSScriptRoot -Parent) 'PanelPointReport.ps1'),
    [switch]$KeepArtifacts
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$script:AssertCount = 0
$script:RelNs = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
$script:Checkmark = [string][char]0x2713
$testRoot = Join-Path ([IO.Path]::GetTempPath()) ('PanelExportTests-' + [Guid]::NewGuid().ToString('N'))
$succeeded = $false

function Assert-True([bool]$Condition, [string]$Message) {
    $script:AssertCount++
    if (-not $Condition) { throw ('Assertion failed: ' + $Message) }
}
function Read-ZipText($Zip, [string]$Part) {
    $entry = $Zip.GetEntry($Part)
    if ($null -eq $entry) { throw ('Missing package part: ' + $Part) }
    $reader = New-Object IO.StreamReader($entry.Open(), [Text.Encoding]::UTF8)
    try { return $reader.ReadToEnd() } finally { $reader.Dispose() }
}
function Read-ZipXml($Zip, [string]$Part) {
    $xml = New-Object Xml.XmlDocument
    $xml.XmlResolver = $null
    $xml.LoadXml((Read-ZipText $Zip $Part))
    return ,$xml
}
function Resolve-Part([string]$BasePart, [string]$Target) {
    if ($Target.StartsWith('/')) { return $Target.Substring(1) }
    $baseUri = New-Object Uri ('https://package.invalid/' + $BasePart)
    $resolved = New-Object Uri ($baseUri, $Target)
    return [Uri]::UnescapeDataString($resolved.AbsolutePath.TrimStart('/'))
}
function Column-Number([string]$Letters) {
    $value = 0
    foreach ($letter in $Letters.ToUpperInvariant().ToCharArray()) { $value = $value * 26 + ([int]$letter - 64) }
    return $value
}
function Column-Name([int]$Value) {
    $name = ''
    while ($Value -gt 0) { $Value--; $name = [char](65 + ($Value % 26)) + $name; $Value = [int][math]::Floor($Value / 26) }
    return $name
}
function Parse-Reference([string]$Reference) {
    if ($Reference -notmatch '^([A-Z]+)([1-9][0-9]*):([A-Z]+)([1-9][0-9]*)$') { throw ('Unexpected table reference: ' + $Reference) }
    return @{ FirstColumn = (Column-Number $Matches[1]); FirstRow = [int]$Matches[2]; LastColumn = (Column-Number $Matches[3]); LastRow = [int]$Matches[4] }
}
function Cell-Text($Cell, $SharedStrings) {
    if ($null -eq $Cell) { return '' }
    $type = $Cell.GetAttribute('t')
    if ($type -eq 'inlineStr') {
        $parts = @($Cell.SelectNodes("./*[local-name()='is']//*[local-name()='t']") | ForEach-Object { $_.InnerText })
        return ($parts -join '')
    }
    $v = $Cell.SelectSingleNode("./*[local-name()='v']")
    if ($null -eq $v) { return '' }
    if ($type -eq 's') { return [string]$SharedStrings[[int]$v.InnerText] }
    return $v.InnerText
}
function Load-Workbook([string]$Filename) {
    $zip = [IO.Compression.ZipFile]::OpenRead($Filename)
    try {
        $workbook = Read-ZipXml $zip 'xl/workbook.xml'
        $rels = Read-ZipXml $zip 'xl/_rels/workbook.xml.rels'
        $types = Read-ZipXml $zip '[Content_Types].xml'
        $styles = Read-ZipXml $zip 'xl/styles.xml'
        $shared = @()
        if ($null -ne $zip.GetEntry('xl/sharedStrings.xml')) {
            $sharedXml = Read-ZipXml $zip 'xl/sharedStrings.xml'
            $shared = @($sharedXml.SelectNodes("//*[local-name()='si']") | ForEach-Object {
                (@($_.SelectNodes(".//*[local-name()='t']") | ForEach-Object { $_.InnerText }) -join '')
            })
        }
        $result = @{ Sheets = @{}; SheetNames = @(); Tables = @{}; Styles = $styles; SharedStrings = $shared; Filename = $Filename }
        $styleCount = $styles.SelectNodes("/*[local-name()='styleSheet']/*[local-name()='cellXfs']/*[local-name()='xf']").Count
        foreach ($s in $workbook.SelectNodes("//*[local-name()='sheets']/*[local-name()='sheet']")) {
            $name = $s.GetAttribute('name'); $id = $s.GetAttribute('id', $script:RelNs)
            $relation = $rels.SelectSingleNode("//*[local-name()='Relationship' and @Id='$id']")
            Assert-True ($null -ne $relation) ('Worksheet relationship exists for ' + $name)
            $part = Resolve-Part 'xl/workbook.xml' $relation.GetAttribute('Target')
            $sheetXml = Read-ZipXml $zip $part
            $cells = @{}
            foreach ($c in $sheetXml.SelectNodes("//*[local-name()='sheetData']//*[local-name()='c']")) {
                $address = $c.GetAttribute('r')
                Assert-True (-not $cells.ContainsKey($address)) ('Unique cell address ' + $name + '!' + $address)
                Assert-True ($address -match '^([A-Z]+)([1-9][0-9]*)$') ('Valid cell address ' + $address)
                Assert-True ((Column-Number $Matches[1]) -le 16384 -and [int]$Matches[2] -le 1048576) ('Cell within Excel bounds ' + $address)
                if ($c.HasAttribute('s')) { Assert-True ([int]$c.GetAttribute('s') -lt $styleCount) ('Valid cell style ' + $address) }
                $cells[$address] = $c
            }
            Assert-True ($sheetXml.SelectNodes("//*[local-name()='f']").Count -eq 0) ('No executable formulas in ' + $name)
            $sheet = @{ Name = $name; Xml = $sheetXml; Cells = $cells; Tables = @(); Part = $part }
            $result.Sheets[$name] = $sheet; $result.SheetNames += $name
            $tableParts = @($sheetXml.SelectNodes("//*[local-name()='tableParts']/*[local-name()='tablePart']"))
            if ($tableParts.Count -gt 0) {
                $sheetRelPart = [IO.Path]::GetDirectoryName($part).Replace('\','/') + '/_rels/' + [IO.Path]::GetFileName($part) + '.rels'
                $sheetRels = Read-ZipXml $zip $sheetRelPart
                foreach ($tp in $tableParts) {
                    $rid = $tp.GetAttribute('id', $script:RelNs)
                    $tr = $sheetRels.SelectSingleNode("//*[local-name()='Relationship' and @Id='$rid']")
                    Assert-True ($null -ne $tr) ('Native table relationship exists in ' + $name)
                    $tablePart = Resolve-Part $part $tr.GetAttribute('Target')
                    $tableXml = Read-ZipXml $zip $tablePart
                    $tableName = $tableXml.DocumentElement.GetAttribute('name')
                    Assert-True (-not $result.Tables.ContainsKey($tableName)) ('Unique table name ' + $tableName)
                    $rect = Parse-Reference $tableXml.DocumentElement.GetAttribute('ref')
                    $columns = @($tableXml.SelectNodes("//*[local-name()='tableColumns']/*[local-name()='tableColumn']"))
                    $headers = @($columns | ForEach-Object { $_.GetAttribute('name') })
                    Assert-True ($columns.Count -eq $rect.LastColumn - $rect.FirstColumn + 1) ('Table header width matches ' + $tableName)
                    Assert-True (@($headers | Select-Object -Unique).Count -eq $headers.Count) ('Unique headers in ' + $tableName)
                    for ($i = 0; $i -lt $headers.Count; $i++) {
                        $address = (Column-Name ($rect.FirstColumn + $i)) + [string]$rect.FirstRow
                        Assert-True ((Cell-Text $cells[$address] $shared) -ceq $headers[$i]) ('Header cell equals native table label ' + $tableName + '/' + $headers[$i])
                    }
                    for ($row = $rect.FirstRow + 1; $row -le $rect.LastRow; $row++) {
                        for ($column = $rect.FirstColumn; $column -le $rect.LastColumn; $column++) {
                            $address = (Column-Name $column) + [string]$row
                            Assert-True ($cells.ContainsKey($address)) ('Rectangular table data ' + $tableName + '!' + $address)
                        }
                    }
                    $partName = '/' + $tablePart
                    Assert-True ($null -ne $types.SelectSingleNode("//*[local-name()='Override' and @PartName='$partName']")) ('Content type declares ' + $tablePart)
                    foreach ($previous in $sheet.Tables) {
                        $p = $previous.Rect
                        $overlap = $rect.FirstRow -le $p.LastRow -and $rect.LastRow -ge $p.FirstRow -and $rect.FirstColumn -le $p.LastColumn -and $rect.LastColumn -ge $p.FirstColumn
                        Assert-True (-not $overlap) ('Native tables do not overlap: ' + $tableName)
                    }
                    $table = @{ Name = $tableName; Sheet = $sheet; Headers = $headers; Rect = $rect; Xml = $tableXml; SharedStrings = $shared }
                    $result.Tables[$tableName] = $table; $sheet.Tables += $table
                }
            }
        }
        Assert-True (($result.SheetNames -join '|') -ceq 'Panel Points|Subpoints|Panel information') 'Exactly the three requested sheet names and order'
        Assert-True ($null -eq $zip.GetEntry('xl/vbaProject.bin')) 'No macro package'
        return $result
    } finally { $zip.Dispose() }
}
function Table-Cell($Table, [int]$DataRow, [string]$Header) {
    $index = [array]::IndexOf($Table.Headers, $Header)
    if ($index -lt 0) { throw ('Missing table header ' + $Header + ' in ' + $Table.Name) }
    return $Table.Sheet.Cells[((Column-Name ($Table.Rect.FirstColumn + $index)) + [string]($Table.Rect.FirstRow + $DataRow))]
}
function Table-Text($Table, [int]$DataRow, [string]$Header) { return (Cell-Text (Table-Cell $Table $DataRow $Header) $Table.SharedStrings) }
function Find-DataRow($Table, [string]$Header, [string]$Value) {
    for ($row = 1; $row -le $Table.Rect.LastRow - $Table.Rect.FirstRow; $row++) {
        if ((Table-Text $Table $row $Header) -ceq $Value) { return $row }
    }
    throw ('Row not found: ' + $Table.Name + '/' + $Header + '=' + $Value)
}
function Find-BdtRow($Table, [string]$Ip, [string]$Port) {
    for ($row = 1; $row -le $Table.Rect.LastRow - $Table.Rect.FirstRow; $row++) {
        if ((Table-Text $Table $row 'IP') -eq $Ip -and (Table-Text $Table $row 'UDP Port') -eq $Port) { return $row }
    }
    throw ('BDT row not found: ' + $Ip + ':' + $Port)
}
function Style-Fill($Workbook, $Cell) {
    $xfs = @($Workbook.Styles.SelectNodes("/*[local-name()='styleSheet']/*[local-name()='cellXfs']/*[local-name()='xf']"))
    $fills = @($Workbook.Styles.SelectNodes("/*[local-name()='styleSheet']/*[local-name()='fills']/*[local-name()='fill']"))
    $xf = $xfs[[int]$Cell.GetAttribute('s')]
    $fill = $fills[[int]$xf.GetAttribute('fillId')]
    $color = $fill.SelectSingleNode(".//*[local-name()='fgColor']")
    if ($null -eq $color) { return '' }
    return $color.GetAttribute('rgb')
}
function Template-Styles([string]$TemplatePath) {
    $zip = [IO.Compression.ZipFile]::OpenRead($TemplatePath)
    try {
        $sheetXml = Read-ZipXml $zip 'xl/worksheets/sheet1.xml'
        $styles = @{}
        foreach ($cell in $sheetXml.SelectNodes("//*[local-name()='sheetData']//*[local-name()='c']")) {
            $label = Cell-Text $cell @()
            $styles[$label] = $cell.GetAttribute('s')
        }
        return $styles
    } finally { $zip.Dispose() }
}
function Run-Replay([string]$CaseName, [string]$FixturePath, [string]$SourceLauncher, [string]$NodePath) {
    $caseRoot = Join-Path $testRoot $CaseName
    $launcherDirectory = Join-Path $caseRoot 'launcher'
    $workingDirectory = Join-Path $caseRoot 'different-working-directory'
    $runtimeRoot = Join-Path $caseRoot 'runtime-temp'
    foreach ($directory in @($launcherDirectory, $workingDirectory, $runtimeRoot)) { [void][IO.Directory]::CreateDirectory($directory) }
    $copiedLauncher = Join-Path $launcherDirectory 'PanelPointReport.ps1'
    [IO.File]::Copy($SourceLauncher, $copiedLauncher, $false)
    $powerShellExe = if ($PSVersionTable.PSEdition -eq 'Core') { Join-Path $PSHOME 'pwsh.exe' } else { Join-Path $PSHOME 'powershell.exe' }
    $info = New-Object Diagnostics.ProcessStartInfo
    $info.FileName = $powerShellExe
    $info.Arguments = '-NoLogo -NoProfile -NonInteractive -File "' + $copiedLauncher + '" -ReplayJson "' + $FixturePath + '"'
    $info.UseShellExecute = $false; $info.CreateNoWindow = $true
    $info.RedirectStandardOutput = $true; $info.RedirectStandardError = $true
    $info.WorkingDirectory = $workingDirectory
    $info.EnvironmentVariables['TEMP'] = $runtimeRoot
    $info.EnvironmentVariables['TMP'] = $runtimeRoot
    $process = New-Object Diagnostics.Process
    $process.StartInfo = $info
    try {
        [void]$process.Start()
        $stdoutTask = $process.StandardOutput.ReadToEndAsync()
        $stderrTask = $process.StandardError.ReadToEndAsync()
        if (-not $process.WaitForExit(180000)) {
            & (Join-Path $env:SystemRoot 'System32\taskkill.exe') /PID $process.Id /T /F | Out-Null
            throw ('Replay timed out. Artifacts: ' + $caseRoot)
        }
        $stdout = $stdoutTask.GetAwaiter().GetResult(); $stderr = $stderrTask.GetAwaiter().GetResult()
        [IO.File]::WriteAllText((Join-Path $caseRoot 'process-output.txt'), $stdout + [Environment]::NewLine + $stderr, [Text.Encoding]::UTF8)
        Assert-True ($process.ExitCode -eq 0) ('Launcher replay exited successfully: ' + $CaseName + '. ' + $stdout + ' ' + $stderr)
    } finally { $process.Dispose() }
    $workbooks = @(Get-ChildItem -LiteralPath $launcherDirectory -Filter '*.xlsx' -File)
    Assert-True ($workbooks.Count -eq 1) ('Exactly one workbook beside launcher: ' + $CaseName)
    Assert-True (@(Get-ChildItem -LiteralPath $workingDirectory -File).Count -eq 0) 'No output in process working directory'
    Assert-True (@(Get-ChildItem -LiteralPath $runtimeRoot -Directory -Filter 'PanelPointReport-*').Count -eq 0) 'Temporary runtime cleaned up'
    Assert-True (@(Get-ChildItem -LiteralPath $launcherDirectory -Filter '*.partial.json' -File).Count -eq 0) 'No false partial result after successful replay'
    Assert-True (@(Get-ChildItem -LiteralPath $launcherDirectory -Filter '*.log.jsonl' -File).Count -eq 1) 'One detailed diagnostic log'
    $jsonFiles = @(Get-ChildItem -LiteralPath $launcherDirectory -Filter '*.json' -File)
    Assert-True ($jsonFiles.Count -eq 1) 'One data snapshot'
    $snapshotText = [IO.File]::ReadAllText($jsonFiles[0].FullName)
    Assert-True (-not $snapshotText.Contains('TEST-ONLY-SECRET')) 'Private device field redacted from data'
    return @{ Workbook = (Load-Workbook $workbooks[0].FullName); Directory = $caseRoot; Snapshot = ($snapshotText | ConvertFrom-Json) }
}

try {
    [void][IO.Directory]::CreateDirectory($testRoot)
    $sourceLauncher = (Resolve-Path -LiteralPath $LauncherPath).ProviderPath
    $nodeCommand = Get-Command node -ErrorAction Stop
    $fixtureDirectory = Join-Path $testRoot 'fixtures'
    $fixtureGenerator = Join-Path $PSScriptRoot 'make-export-fixtures.cjs'
    $fixtureOutput = & $nodeCommand.Source $fixtureGenerator $fixtureDirectory
    Assert-True ($LASTEXITCODE -eq 0) 'Synthetic fixtures generated successfully'
    $fixtures = ($fixtureOutput | Out-String) | ConvertFrom-Json
    $templatePath = Join-Path (Split-Path $PSScriptRoot -Parent) 'assets\workbook-template.xlsx'
    $semanticStyles = Template-Styles $templatePath
    Assert-True ($semanticStyles.ContainsKey('selfCheck') -and $semanticStyles.ContainsKey('check')) 'Template exposes semantic check styles'

    $populated = Run-Replay 'populated' $fixtures.populated $sourceLauncher $nodeCommand.Source
    $book = $populated.Workbook
    $pointTable = $book.Tables['PanelPoints']
    Assert-True ($pointTable.Rect.LastRow - $pointTable.Rect.FirstRow -eq 3) 'Three non-colon panel points'
    $temperatureRow = Find-DataRow $pointTable 'Point' 'ROOM_TEMP'
    $temperature = Table-Cell $pointTable $temperatureRow 'Value'
    Assert-True ($temperature.GetAttribute('t') -ne 'inlineStr' -and (Table-Text $pointTable $temperatureRow 'Value') -eq '21.75') 'Numeric measurements are typed numbers'
    $zeroRow = Find-DataRow $pointTable 'Point' 'ZERO'
    Assert-True ((Table-Text $pointTable $zeroRow 'Value') -eq '0') 'Numeric zero retained'
    $literalRow = Find-DataRow $pointTable 'Point' 'LITERAL'
    $literal = Table-Cell $pointTable $literalRow 'Value'
    Assert-True ($literal.GetAttribute('t') -eq 'inlineStr' -and (Table-Text $pointTable $literalRow 'Value') -ceq '=1+1') 'Leading equals remains literal text, not a formula'
    $groups = @($book.Tables.Values | Where-Object { $_.Name -match '^SubpointsGroup\d+$' })
    Assert-True ($groups.Count -eq 2) 'Same application number remains separate across drivers'
    $bacnetGroup = @($groups | Where-Object { (Table-Text $_ 1 'Driver') -eq 'BACnet' })[0]
    Assert-True ($bacnetGroup.Rect.LastRow - $bacnetGroup.Rect.FirstRow -eq 2) 'Two BACnet devices share one application table'
    foreach ($label in @('TEMP Value','TEMP Unit','TEMP Status','TEMP Priority','RUN Value','RUN Unit','RUN Status','RUN Priority')) {
        Assert-True ([array]::IndexOf($bacnetGroup.Headers, $label) -ge 0) ('Subpoint group includes ' + $label)
    }
    $deviceRow = Find-DataRow $bacnetGroup 'Device' 'DEVICE_A'
    Assert-True ((Table-Text $bacnetGroup $deviceRow 'RUN Value') -ceq 'ON') 'String measurement preserved'
    Assert-True ((Table-Text $bacnetGroup $deviceRow 'TEMP Unit') -ceq 'DEG C') 'Multiword engineering unit preserved'
    $colon = $book.Tables['OtherColonObservations']
    Assert-True ((Table-Text $colon 1 'Point') -ceq 'TEST_PROGRAM:Address') 'Colon observation kept in separate table'

    $bdt = $book.Tables['BacnetDistributionTables']
    Assert-True (($bdt.Headers[0..2] -join '|') -ceq 'IP|Netmask|UDP Port') 'BDT columns A/B/C are reserved correctly'
    Assert-True ($bdt.Rect.LastRow - $bdt.Rect.FirstRow -eq 3) 'BDT unique tuple rows deduplicate repeated entries and retain distinct ports'
    $ownRow = Find-BdtRow $bdt '192.0.2.10' '47808'
    $otherPortRow = Find-BdtRow $bdt '192.0.2.10' '47809'
    $selfCell = Table-Cell $bdt $ownRow '1001'
    Assert-True ((Table-Text $bdt $ownRow '1001') -ceq $script:Checkmark) 'Self-entry contains a Unicode checkmark'
    Assert-True ($selfCell.GetAttribute('s') -eq $semanticStyles['selfCheck']) 'Self-entry uses the semantic selfCheck style'
    $rgb = Style-Fill $book $selfCell
    Assert-True ($rgb -match '^[0-9A-Fa-f]{8}$') 'Self-entry has an explicit RGB fill'
    $red = [Convert]::ToInt32($rgb.Substring(2,2),16); $green = [Convert]::ToInt32($rgb.Substring(4,2),16); $blue = [Convert]::ToInt32($rgb.Substring(6,2),16)
    Assert-True ($green -gt $red -and $green -gt $blue) 'Self-entry fill is green'
    Assert-True ((Table-Text $bdt $ownRow '1002') -ceq $script:Checkmark) 'Shared entry checked under both reporting panels'
    Assert-True ((Table-Cell $bdt $ownRow '1002').GetAttribute('s') -eq $semanticStyles['check']) 'Non-self shared entry uses normal check style'
    Assert-True ((Table-Cell $bdt $otherPortRow '1001').GetAttribute('s') -eq $semanticStyles['check']) 'Different UDP port is not falsely marked self'
    Assert-True ((Table-Text $bdt $ownRow '1003') -ceq 'Not collected') 'Failed BDT query is explicit'
    Assert-True ((Table-Text $bdt $ownRow '1004') -ceq '') 'Successfully empty BDT query is blank in membership cells'
    $portCell = Table-Cell $bdt $ownRow 'UDP Port'
    Assert-True ($portCell.GetAttribute('t') -ne 'inlineStr') 'UDP ports are typed numeric'
    if ($semanticStyles.ContainsKey('integer')) { Assert-True ($portCell.GetAttribute('s') -eq $semanticStyles['integer']) 'UDP port uses integer display style' }

    $empty = Run-Replay 'empty' $fixtures.empty $sourceLauncher $nodeCommand.Source
    $emptyBdt = $empty.Workbook.Tables['BacnetDistributionTables']
    Assert-True ($emptyBdt.Rect.LastRow -eq $emptyBdt.Rect.FirstRow) 'Empty BDT creates a header-only table, no fake row'
    $emptyText = (@($empty.Workbook.Sheets['Panel information'].Cells.Values | ForEach-Object {
        Cell-Text $_ $empty.Workbook.SharedStrings
    }) -join "`n")
    Assert-True ($emptyText.Contains('No BDT entries were returned.')) 'Empty-result explanation is present in actual worksheet cells'
    Assert-True (-not $emptyText.Contains($script:Checkmark)) 'Empty BDT invents no self-entry checkmark'
    Assert-True ($empty.Workbook.Tables['PanelPoints'].Rect.LastRow -eq $empty.Workbook.Tables['PanelPoints'].Rect.FirstRow) 'Zero panel points remain a header-only table'
    $succeeded = $true
    Write-Host ('PASS: Native exporter smoke tests, ' + $script:AssertCount + ' assertions. No network connections were made.') -ForegroundColor Green
    if ($KeepArtifacts) { Write-Host ('Artifacts retained: ' + $testRoot) }
}
catch {
    Write-Host ('FAIL: ' + $_.Exception.Message) -ForegroundColor Red
    Write-Host ('Failure artifacts retained: ' + $testRoot)
    throw
}
finally {
    if ($succeeded -and -not $KeepArtifacts -and [IO.Directory]::Exists($testRoot)) {
        if ([IO.Path]::GetFileName($testRoot) -match '^PanelExportTests-[0-9a-f]{32}$') { [IO.Directory]::Delete($testRoot, $true) }
    }
}
