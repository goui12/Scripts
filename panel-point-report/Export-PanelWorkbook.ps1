# Fills the artifact-authored workbook template using Windows/.NET XML and ZIP.
# No Excel installation, COM automation, downloaded package, or macro is used.
[CmdletBinding()]
param(
    [Parameter(Mandatory=$true)][string]$DataPath,
    [Parameter(Mandatory=$true)][string]$OutputPath,
    [Parameter(Mandatory=$true)][string]$TemplatePath
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$script:Ns = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
$script:RelNs = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
$script:PackageRelNs = 'http://schemas.openxmlformats.org/package/2006/relationships'
$script:Utf8 = New-Object System.Text.UTF8Encoding($false)

function Read-ZipText([System.IO.Compression.ZipArchive]$Zip, [string]$Name) {
    $entry = $Zip.GetEntry($Name)
    if ($null -eq $entry) { throw "Template part not found: $Name" }
    $reader = New-Object System.IO.StreamReader($entry.Open(), $script:Utf8)
    try { return $reader.ReadToEnd() } finally { $reader.Dispose() }
}
function Write-ZipText([System.IO.Compression.ZipArchive]$Zip, [string]$Name, [string]$Content) {
    $old = $Zip.GetEntry($Name)
    if ($null -ne $old) { $old.Delete() }
    $entry = $Zip.CreateEntry($Name, [System.IO.Compression.CompressionLevel]::Optimal)
    $writer = New-Object System.IO.StreamWriter($entry.Open(), $script:Utf8)
    try { $writer.Write($Content) } finally { $writer.Dispose() }
}
function Column-Name([int]$Index) {
    if ($Index -lt 1 -or $Index -gt 16384) { throw 'Invalid Excel column index.' }
    $name = ''
    while ($Index -gt 0) { $Index--; $name = [char](65 + ($Index % 26)) + $name; $Index = [math]::Floor($Index / 26) }
    return $name
}
function Xml-Text([object]$Value) {
    if ($null -eq $Value) { return '' }
    return [System.Security.SecurityElement]::Escape([string]$Value)
}
function Is-Numeric([object]$Value) {
    return ($Value -is [byte] -or $Value -is [int16] -or $Value -is [int32] -or $Value -is [int64] -or $Value -is [single] -or $Value -is [double] -or $Value -is [decimal])
}
function Cell-Xml($Cell, $Styles) {
    $address = (Column-Name ([int]$Cell.col)) + [string]$Cell.row
    $styleName = [string]$Cell.style
    if (-not $Styles.ContainsKey($styleName)) { throw "Unknown template cell style: $styleName" }
    $styleId = [string]$Styles[$styleName]
    if (Is-Numeric $Cell.value) {
        $number = ([double]$Cell.value).ToString('R', [System.Globalization.CultureInfo]::InvariantCulture)
        if ($number -match 'NaN|Infinity') { throw 'Invalid numeric workbook cell.' }
        return '<c r="' + $address + '" s="' + $styleId + '"><v>' + $number + '</v></c>'
    }
    # inlineStr deliberately treats leading =, +, -, and @ as literal data.
    $value = Xml-Text $Cell.value
    return '<c r="' + $address + '" s="' + $styleId + '" t="inlineStr"><is><t xml:space="preserve">' + $value + '</t></is></c>'
}

$target = [System.IO.Path]::GetFullPath($OutputPath)
if ([System.IO.File]::Exists($target)) { throw "Output already exists; refusing to overwrite: $target" }
$inputFile = [System.IO.Path]::GetFullPath($DataPath)
$templateFile = [System.IO.Path]::GetFullPath($TemplatePath)
if ($target -eq $inputFile -or $target -eq $templateFile) { throw 'Input, output, and template paths must differ.' }
$data = [System.IO.File]::ReadAllText($inputFile, $script:Utf8) | ConvertFrom-Json
if ($null -eq $data.workbookModel -or [int]$data.workbookModel.version -ne 1) { throw 'Unsupported or missing workbook layout model.' }
$model = $data.workbookModel
$expected = @('Panel Points', 'Subpoints', 'Panel information')
if (@($model.sheets).Count -ne 3) { throw 'The workbook must contain exactly three sheets.' }
for ($i=0; $i -lt 3; $i++) { if ($model.sheets[$i].name -cne $expected[$i]) { throw 'Unexpected worksheet name/order.' } }

$parent = [System.IO.Path]::GetDirectoryName($target)
if (-not [System.IO.Directory]::Exists($parent)) { throw "Output directory does not exist: $parent" }
$staging = [System.IO.Path]::Combine($parent, '.panel-export-' + [guid]::NewGuid().ToString('N') + '.tmp')
$zip = $null
$finished = $false
try {
    [System.IO.File]::Copy($templateFile, $staging, $false)
    $zip = [System.IO.Compression.ZipFile]::Open($staging, [System.IO.Compression.ZipArchiveMode]::Update)
    [xml]$templateSheet = Read-ZipText $zip 'xl/worksheets/sheet1.xml'
    $styles = @{}
    $styleNames = @('body','title','note','section','header','number','warning','error','check','selfCheck','unavailable','integer')
    for ($i=0; $i -lt $styleNames.Count; $i++) {
        $a = (Column-Name ($i+1)) + '1'
        $n = $templateSheet.SelectSingleNode("//*[local-name()='c' and @r='$a']")
        if ($null -eq $n -or -not $n.HasAttribute('s')) { throw "Template style anchor missing: $a" }
        $styles[$styleNames[$i]] = $n.GetAttribute('s')
    }
    [xml]$types = Read-ZipText $zip '[Content_Types].xml'
    $contentNs = 'http://schemas.openxmlformats.org/package/2006/content-types'
    # The template has no data tables. Every runtime table is declared once.
    $tableId = 0
    foreach ($sheet in $model.sheets) {
        $sheetIndex = [array]::IndexOf($expected, [string]$sheet.name) + 1
        $lastCell = (Column-Name ([int]$sheet.maxColumn)) + [string]$sheet.maxRow
        $b = New-Object System.Text.StringBuilder
        [void]$b.Append('<?xml version="1.0" encoding="utf-8" standalone="yes"?><worksheet xmlns="' + $script:Ns + '" xmlns:r="' + $script:RelNs + '">')
        [void]$b.Append('<dimension ref="A1:' + $lastCell + '"/><sheetViews><sheetView workbookViewId="0" showGridLines="0" zoomScale="85">')
        $top = (Column-Name ([int]$sheet.freezeColumns + 1)) + [string]([int]$sheet.freezeRows + 1)
        [void]$b.Append('<pane xSplit="' + [string]$sheet.freezeColumns + '" ySplit="' + [string]$sheet.freezeRows + '" topLeftCell="' + $top + '" activePane="bottomRight" state="frozen"/><selection pane="bottomRight" activeCell="' + $top + '" sqref="' + $top + '"/></sheetView></sheetViews><sheetFormatPr defaultRowHeight="20"/><cols>')
        foreach ($prop in $sheet.widths.PSObject.Properties | Sort-Object { [int]$_.Name }) {
            $width = ([double]$prop.Value).ToString('0.##', [System.Globalization.CultureInfo]::InvariantCulture)
            [void]$b.Append('<col min="' + $prop.Name + '" max="' + $prop.Name + '" width="' + $width + '" customWidth="1"/>')
        }
        [void]$b.Append('</cols><sheetData>')
        $currentRow = -1
        foreach ($c in $sheet.cells | Sort-Object @{Expression={[int]$_.row}}, @{Expression={[int]$_.col}}) {
            $r = [int]$c.row
            if ($r -lt 1 -or $r -gt 1048576) { throw 'Invalid worksheet row.' }
            if ($r -ne $currentRow) {
                if ($currentRow -gt 0) { [void]$b.Append('</row>') }
                $height = $sheet.rowHeights.PSObject.Properties[[string]$r]
                $heightXml = if ($null -ne $height) { ' ht="' + [string]$height.Value + '" customHeight="1"' } else { '' }
                [void]$b.Append('<row r="' + $r + '"' + $heightXml + '>')
                $currentRow = $r
            }
            [void]$b.Append((Cell-Xml $c $styles))
        }
        if ($currentRow -gt 0) { [void]$b.Append('</row>') }
        [void]$b.Append('</sheetData>')
        $notes = @($sheet.notes)
        if ($notes.Count -gt 0) {
            [void]$b.Append('<mergeCells count="' + $notes.Count + '">')
            foreach ($n in $notes) { [void]$b.Append('<mergeCell ref="' + (Column-Name ([int]$n.firstColumn)) + [string]$n.row + ':' + (Column-Name ([int]$n.lastColumn)) + [string]$n.row + '"/>') }
            [void]$b.Append('</mergeCells>')
        }
        [void]$b.Append('<pageMargins left="0.25" right="0.25" top="0.5" bottom="0.5" header="0.2" footer="0.2"/>')
        $rels = New-Object System.Text.StringBuilder
        [void]$rels.Append('<?xml version="1.0" encoding="utf-8"?><Relationships xmlns="' + $script:PackageRelNs + '">')
        $tables = @($sheet.tables)
        if ($tables.Count -gt 0) { [void]$b.Append('<tableParts count="' + $tables.Count + '">') }
        $localId = 0
        foreach ($t in $tables) {
            $tableId++; $localId++
            $ref = (Column-Name ([int]$t.startColumn)) + [string]$t.startRow + ':' + (Column-Name ([int]$t.endColumn)) + [string]$t.endRow
            $tableName = Xml-Text $t.name
            $tb = New-Object System.Text.StringBuilder
            [void]$tb.Append('<?xml version="1.0" encoding="utf-8" standalone="yes"?><table xmlns="' + $script:Ns + '" id="' + $tableId + '" name="' + $tableName + '" displayName="' + $tableName + '" ref="' + $ref + '" totalsRowShown="0"><autoFilter ref="' + $ref + '"/><tableColumns count="' + @($t.headers).Count + '">')
            $colId=0
            foreach ($h in $t.headers) { $colId++; [void]$tb.Append('<tableColumn id="' + $colId + '" name="' + (Xml-Text $h) + '"/>') }
            [void]$tb.Append('</tableColumns><tableStyleInfo name="TableStyleMedium2" showFirstColumn="0" showLastColumn="0" showRowStripes="1" showColumnStripes="0"/></table>')
            Write-ZipText $zip ('xl/tables/table' + $tableId + '.xml') $tb.ToString()
            [void]$rels.Append('<Relationship Id="rId' + $localId + '" Type="' + $script:RelNs + '/table" Target="../tables/table' + $tableId + '.xml"/>')
            [void]$b.Append('<tablePart r:id="rId' + $localId + '"/>')
            $override = $types.CreateElement('Override', $contentNs)
            $override.SetAttribute('PartName', '/xl/tables/table' + $tableId + '.xml')
            $override.SetAttribute('ContentType', 'application/vnd.openxmlformats-officedocument.spreadsheetml.table+xml')
            [void]$types.DocumentElement.AppendChild($override)
        }
        if ($tables.Count -gt 0) { [void]$b.Append('</tableParts>') }
        [void]$b.Append('</worksheet>'); [void]$rels.Append('</Relationships>')
        Write-ZipText $zip ('xl/worksheets/sheet' + $sheetIndex + '.xml') $b.ToString()
        Write-ZipText $zip ('xl/worksheets/_rels/sheet' + $sheetIndex + '.xml.rels') $rels.ToString()
    }
    Write-ZipText $zip '[Content_Types].xml' $types.OuterXml
    $zip.Dispose(); $zip = $null
    # File.Move refuses replacement if a competing run creates this target.
    [System.IO.File]::Move($staging, $target)
    $finished = $true
    Write-Output ('Workbook saved: ' + $target)
} finally {
    if ($null -ne $zip) { $zip.Dispose() }
    if (-not $finished -and [System.IO.File]::Exists($staging)) { [System.IO.File]::Delete($staging) }
}
