#Requires -Version 5.1
<#
.SYNOPSIS
Collects read-only panel reports and creates a three-sheet XLSX workbook.
.DESCRIPTION
Run only with authorization and in accordance with customer network/site policies.
Telnet is unencrypted. Use only an approved trusted network.
Outputs are saved beside this PS1, not in its temporary runtime folder.
Requires an existing Node.js 18+ installation. Does not install software or alter
PowerShell execution policy. All runtime files are embedded in this launcher.
.PARAMETER ReplayJson
Rebuilds a workbook from a complete saved report without connecting to a panel.
#>
[CmdletBinding()]
param(
    [string]$PanelIp,
    [string]$UserName,
    [System.Management.Automation.PSCredential]$Credential,
    [ValidateRange(1, 65535)][int]$Port = 23,
    [string]$ReplayJson
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$runtimeDirectory = $null
$secretPointer = [IntPtr]::Zero
$plainPassword = $null
$requestJson = $null
$originalOutputEncoding = $OutputEncoding
$runExitCode = 1
$outputDirectory = $PSScriptRoot

# Generated payload. Regenerate with node build-standalone.cjs after source edits.
$embeddedPayload = @'
__PAYLOAD_BASE64__
'@

try {
    if ([string]::IsNullOrWhiteSpace($PSScriptRoot)) {
        throw 'Save this PS1 to a directory before running it.'
    }
    $outputDirectory = [IO.Path]::GetFullPath($PSScriptRoot)
    $nodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue
    if ($null -eq $nodeCommand) { $nodeCommand = Get-Command node -ErrorAction SilentlyContinue }
    if ($null -eq $nodeCommand -or $nodeCommand.CommandType -ne 'Application') {
        throw 'Node.js 18 or newer is required. Ask your IT/site administrator to install an approved version, then run this script again.'
    }
    $nodePath = $nodeCommand.Source
    $versionText = (& $nodePath --version | Out-String).Trim()
    if ($LASTEXITCODE -ne 0 -or $versionText -notmatch '^v(\d+)\.') { throw 'Could not read the installed Node.js version.' }
    if ([int]$Matches[1] -lt 18) { throw ('Node.js 18+ is required. Found ' + $versionText + '.') }

    Write-Host 'Panel Point Report - read-only collection'
    Write-Host 'Follow customer site policies for network access and sending packets.' -ForegroundColor Yellow
    Write-Host 'Telnet sends credentials and reports without encryption. Use an approved trusted network.' -ForegroundColor Yellow
    Write-Host ('Output directory: ' + $outputDirectory)

    $request = @{ outputDir = $outputDirectory; port = $Port }
    # Use the already-running approved PowerShell host for the exporter. No
    # execution-policy overrides are applied, including for the embedded helper.
    if ($PSVersionTable.PSEdition -eq 'Core') { $request.powershellPath = Join-Path $PSHOME 'pwsh.exe' }
    else { $request.powershellPath = Join-Path $PSHOME 'powershell.exe' }

    if (-not [string]::IsNullOrWhiteSpace($ReplayJson)) {
        $resolvedReplay = Resolve-Path -LiteralPath $ReplayJson
        if ($resolvedReplay.Provider.Name -ne 'FileSystem') { throw 'ReplayJson must be a local filesystem path.' }
        $request.replayJson = $resolvedReplay.ProviderPath
        Write-Host 'Replay mode: no network connection will be made.'
    }
    else {
        if ([string]::IsNullOrWhiteSpace($PanelIp)) { $PanelIp = Read-Host 'Panel IP address' }
        $parsedAddress = $null
        if (-not [Net.IPAddress]::TryParse($PanelIp, [ref]$parsedAddress) -or
            $parsedAddress.AddressFamily -ne [Net.Sockets.AddressFamily]::InterNetwork -or
            $PanelIp -notmatch '^\d{1,3}(\.\d{1,3}){3}$') {
            throw 'Enter a literal IPv4 address, for example 192.0.2.10.'
        }
        if ($null -ne $Credential) {
            $UserName = $Credential.UserName
            $securePassword = $Credential.Password
        }
        else {
            if ([string]::IsNullOrWhiteSpace($UserName)) { $UserName = Read-Host 'User initials' }
            $securePassword = Read-Host 'Password' -AsSecureString
        }
        $secretPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($securePassword)
        try { $plainPassword = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($secretPointer) }
        finally {
            [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($secretPointer)
            $secretPointer = [IntPtr]::Zero
        }
        $request.host = $PanelIp
        $request.username = $UserName
        $request.password = $plainPassword
    }

    $payloadBytes = [Convert]::FromBase64String($embeddedPayload)
    $payloadJson = [Text.Encoding]::UTF8.GetString($payloadBytes)
    $payload = $payloadJson | ConvertFrom-Json
    if ($payload.version -ne 1 -or $payload.files.Count -eq 0) { throw 'Embedded runtime payload is invalid.' }
    $runtimeDirectory = Join-Path ([IO.Path]::GetTempPath()) ('PanelPointReport-' + [Guid]::NewGuid().ToString('N'))
    [void][IO.Directory]::CreateDirectory($runtimeDirectory)
    $runtimePrefix = [IO.Path]::GetFullPath($runtimeDirectory) + [IO.Path]::DirectorySeparatorChar
    foreach ($entry in $payload.files) {
        if ($entry.path -notmatch '^[A-Za-z0-9_.-]+(/[A-Za-z0-9_.-]+)*$' -or
            @($entry.path -split '/' | Where-Object { $_ -eq '.' -or $_ -eq '..' }).Count -ne 0) {
            throw 'Embedded runtime contains an unsafe path.'
        }
        $relativePath = $entry.path.Replace('/', [IO.Path]::DirectorySeparatorChar)
        $targetPath = [IO.Path]::GetFullPath((Join-Path $runtimeDirectory $relativePath))
        if (-not $targetPath.StartsWith($runtimePrefix, [StringComparison]::OrdinalIgnoreCase)) {
            throw 'Embedded runtime path escaped its temporary directory.'
        }
        $bytes = [Convert]::FromBase64String($entry.base64)
        $sha = [Security.Cryptography.SHA256]::Create()
        try { $actualHash = ([BitConverter]::ToString($sha.ComputeHash($bytes))).Replace('-', '').ToLowerInvariant() }
        finally { $sha.Dispose() }
        if ($actualHash -ne $entry.sha256) { throw ('Embedded runtime checksum failed for ' + $entry.path) }
        [void][IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($targetPath))
        $stream = [IO.File]::Open($targetPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
        try { $stream.Write($bytes, 0, $bytes.Length) } finally { $stream.Dispose() }
    }
    $cliPath = Join-Path $runtimeDirectory 'cli.cjs'
    if (-not [IO.File]::Exists($cliPath)) { throw 'Embedded CLI is missing.' }
    $requestJson = $request | ConvertTo-Json -Compress -Depth 10
    # Standard input, rather than process arguments, environment variables or
    # files, carries credentials to the short-lived local Node process.
    $OutputEncoding = New-Object Text.UTF8Encoding($false)
    $requestJson | & $nodePath $cliPath
    $runExitCode = $LASTEXITCODE
    if ($runExitCode -eq 0) { Write-Host 'Report complete.' -ForegroundColor Green }
    else { Write-Host 'Reporting stopped. Review the diagnostic log path printed above.' -ForegroundColor Red }
}
catch {
    # Do not include the invocation or request object: it may contain secrets.
    $failureMessage = $_.Exception.Message
    $failureStack = $_.ScriptStackTrace
    foreach ($privateText in @($plainPassword, $UserName)) {
        if (-not [string]::IsNullOrEmpty($privateText)) {
            $failureMessage = $failureMessage.Replace($privateText, '[REDACTED]')
            if ($null -ne $failureStack) { $failureStack = $failureStack.Replace($privateText, '[REDACTED]') }
        }
    }
    Write-Host ('Could not complete reporting: ' + $failureMessage) -ForegroundColor Red
    try {
        if ([string]::IsNullOrWhiteSpace($outputDirectory)) { throw 'No script output directory is available.' }
        $launcherLogPath = Join-Path $outputDirectory ('PanelReport_launcher_' + [DateTime]::UtcNow.ToString('yyyyMMddTHHmmssfffZ') + '_' + [Guid]::NewGuid().ToString('N').Substring(0, 6) + '.log.jsonl')
        $launcherRecord = @{ at = [DateTime]::UtcNow.ToString('o'); event = 'launcher-failure'; stage = 'launcher';
            message = $failureMessage; stack = $failureStack; script = $PSCommandPath }
        $launcherLogText = ($launcherRecord | ConvertTo-Json -Compress -Depth 5) + [Environment]::NewLine
        $launcherLogBytes = [Text.Encoding]::UTF8.GetBytes($launcherLogText)
        $launcherStream = [IO.File]::Open($launcherLogPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
        try { $launcherStream.Write($launcherLogBytes, 0, $launcherLogBytes.Length) } finally { $launcherStream.Dispose() }
        Write-Host ('Diagnostic log: ' + $launcherLogPath)
    }
    catch {
        Write-Host ('A startup diagnostic log could not be written beside this PS1: ' + $_.Exception.Message) -ForegroundColor Yellow
    }
    $runExitCode = 1
}
finally {
    $OutputEncoding = $originalOutputEncoding
    if ($secretPointer -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($secretPointer) }
    $plainPassword = $null
    $requestJson = $null
    $request = $null
    $Credential = $null
    $securePassword = $null
    if ($null -ne $runtimeDirectory -and [IO.Directory]::Exists($runtimeDirectory)) {
        # Delete only this invocation's exact, newly-created runtime directory.
        $tempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd([IO.Path]::DirectorySeparatorChar)
        $parentPath = [IO.Directory]::GetParent($runtimeDirectory).FullName.TrimEnd([IO.Path]::DirectorySeparatorChar)
        if ($parentPath -eq $tempRoot -and [IO.Path]::GetFileName($runtimeDirectory) -match '^PanelPointReport-[0-9a-f]{32}$') {
            try { [IO.Directory]::Delete($runtimeDirectory, $true) }
            catch { Write-Warning ('Temporary runtime could not be removed: ' + $runtimeDirectory) }
        }
    }
}
exit $runExitCode
