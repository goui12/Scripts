#Requires -Version 5.1
<#
.SYNOPSIS
    Discover Modbus TCP responders in the Windows IPv4 ARP cache.
.DESCRIPTION
    Requires authorization under the customer's IT/OT, vendor, and site policies.
    Read-only is NOT risk-free. See README.md before running on operational networks.
    This script sends only FC03, FC04, FC17, and FC43/14 requests. It does not
    write registers, operate equipment, expand subnets, or scan every Unit ID.
    Dot-sourcing loads functions without scanning. Normal execution prompts for
    the port unless -Port is provided and prints one line per confirmed device.
.EXAMPLE
    .\ModbusArpScanner.ps1
.EXAMPLE
    .\ModbusArpScanner.ps1 -Port 502 -ExcludeIP '192.0.2.10'
#>
[CmdletBinding()]
param(
    [ValidateRange(0, 65535)][int]$Port = 0,
    [string[]]$ExcludeIP = @(),
    [ValidateNotNullOrEmpty()]
    [ValidateScript({ ($_ -ge 1 -and $_ -le 247) -or $_ -eq 255 })]
    [int[]]$UnitId = @(255, 1),
    [ValidateRange(100, 60000)][int]$ConnectTimeoutMs = 1000,
    [ValidateRange(100, 60000)][int]$ResponseTimeoutMs = 1500,
    [ValidateRange(50, 60000)][int]$RequestDelayMs = 200,
    [ValidateRange(1, 1024)][int]$MaxRequestsPerHost = 320,
    [ValidateRange(1, 3600)][int]$MaxHostSeconds = 120
)

function ConvertFrom-ModbusArpOutput {
    [CmdletBinding()]
    param([string[]]$Lines, [string[]]$ExcludeIP = @())
    $seen = New-Object 'System.Collections.Generic.HashSet[string]'
    $excluded = New-Object 'System.Collections.Generic.HashSet[string]'
    foreach ($entry in $ExcludeIP) {
        $parsed = $null
        if (-not [Net.IPAddress]::TryParse($entry, [ref]$parsed) -or
            $parsed.AddressFamily -ne [Net.Sockets.AddressFamily]::InterNetwork) {
            throw "Invalid IPv4 exclusion: $entry"
        }
        [void]$excluded.Add($parsed.ToString())
    }
    foreach ($line in $Lines) {
        if ($line -notmatch '^\s*((?:\d{1,3}\.){3}\d{1,3})\s+([0-9a-fA-F]{2}(?:[-:][0-9a-fA-F]{2}){5})(?:\s|$)') {
            continue
        }
        $ipText = $Matches[1]
        $mac = $Matches[2] -replace '[-:]', ''
        $parsed = $null
        if (-not [Net.IPAddress]::TryParse($ipText, [ref]$parsed)) { continue }
        $octets = $parsed.GetAddressBytes()
        if ($octets.Length -ne 4 -or $octets[0] -eq 0 -or
            $octets[0] -eq 127 -or $octets[0] -ge 224 -or
            $mac -eq 'ffffffffffff' -or $mac -eq '000000000000') { continue }
        # A .255 address can be a valid host. Exclude broadcast by MAC, not suffix.
        if (([Convert]::ToInt32($mac.Substring(0, 2), 16) -band 1) -ne 0) { continue }
        $canonical = $parsed.ToString()
        if (-not $excluded.Contains($canonical) -and $seen.Add($canonical)) {
            $canonical
        }
    }
}

function Get-ModbusArpCache {
    [CmdletBinding()]
    param()
    $arp = Get-Command arp.exe -CommandType Application -ErrorAction Stop
    $lines = @(& $arp.Source -a 2>$null)
    if ($LASTEXITCODE -ne 0) { throw 'arp.exe -a failed; no scan was started.' }
    $lines
}

function Test-ModbusTcpPort {
    [CmdletBinding()]
    param(
        [string]$IPAddress,
        [ValidateRange(1, 65535)][int]$Port,
        [int]$ConnectTimeoutMs = 1000
    )
    $client = New-Object Net.Sockets.TcpClient
    try {
        $address = [Net.IPAddress]::Parse($IPAddress)
        $pending = $client.ConnectAsync($address, $Port)
        return ($pending.Wait($ConnectTimeoutMs) -and $client.Connected)
    }
    catch { return $false }
    finally { $client.Close() }
}

function Test-ModbusReadOnlyRequest {
    param([byte[]]$RequestPdu)
    if ($null -eq $RequestPdu -or $RequestPdu.Length -eq 0) { return $false }
    switch ([int]$RequestPdu[0]) {
        { $_ -in @(3, 4) } {
            if ($RequestPdu.Length -ne 5) { return $false }
            $start = ([int]$RequestPdu[1] -shl 8) -bor [int]$RequestPdu[2]
            $quantity = ([int]$RequestPdu[3] -shl 8) -bor [int]$RequestPdu[4]
            return ($quantity -ge 1 -and $quantity -le 125 -and ($start + $quantity) -le 65536)
        }
        17 { return ($RequestPdu.Length -eq 1) }
        43 {
            return ($RequestPdu.Length -eq 4 -and $RequestPdu[1] -eq 14 -and
                $RequestPdu[2] -eq 1 -and $RequestPdu[3] -eq 0)
        }
        default { return $false }
    }
}

function ConvertFrom-ModbusPdu {
    [CmdletBinding()]
    param([byte[]]$RequestPdu, [byte[]]$ResponsePdu)
    if (-not (Test-ModbusReadOnlyRequest -RequestPdu $RequestPdu)) {
        throw 'Request is not an allowed read-only Modbus request.'
    }
    if ($null -eq $ResponsePdu -or $ResponsePdu.Length -lt 2 -or $ResponsePdu.Length -gt 253) {
        throw 'Invalid Modbus PDU size.'
    }
    $fc = [int]$RequestPdu[0]
    if ($ResponsePdu[0] -eq ($fc -bor 128)) {
        $codeIndex = 1
        if ($fc -eq 43 -and $ResponsePdu.Length -eq 3 -and $ResponsePdu[1] -eq 14) {
            $codeIndex = 2 # Legacy MEI-bearing exception format.
        }
        elseif ($ResponsePdu.Length -ne 2) { throw 'Invalid exception length.' }
        $exception = [int]$ResponsePdu[$codeIndex]
        if ($exception -notin @(1, 2, 3, 4, 5, 6, 8, 10, 11)) {
            throw 'Unknown Modbus exception code.'
        }
        return [pscustomobject]@{ Kind = 'Exception'; Values = @(); ExceptionCode = $exception }
    }
    if ($ResponsePdu[0] -ne $fc) { throw 'Response function does not match request.' }
    if ($fc -in @(3, 4)) {
        $quantity = ([int]$RequestPdu[3] -shl 8) -bor [int]$RequestPdu[4]
        if ($ResponsePdu[1] -ne (2 * $quantity) -or $ResponsePdu.Length -ne (2 + 2 * $quantity)) {
            throw 'Register response byte count does not match request.'
        }
        $values = New-Object 'System.Collections.Generic.List[int]'
        for ($offset = 2; $offset -lt $ResponsePdu.Length; $offset += 2) {
            $values.Add((([int]$ResponsePdu[$offset] -shl 8) -bor [int]$ResponsePdu[$offset + 1]))
        }
        return [pscustomobject]@{ Kind = 'Data'; Values = $values.ToArray(); ExceptionCode = $null }
    }
    if ($fc -eq 17) {
        # FC17 is a serial-line function: best-effort over TCP, no vendor assumptions.
        if ($ResponsePdu.Length -lt 4 -or $ResponsePdu[1] -lt 2 -or
            $ResponsePdu.Length -ne (2 + [int]$ResponsePdu[1])) {
            throw 'Invalid Report Server ID response.'
        }
    }
    else {
        if ($ResponsePdu.Length -lt 7 -or $ResponsePdu[1] -ne 14 -or
            $ResponsePdu[2] -ne 1 -or $ResponsePdu[3] -notin @(1, 2, 3, 129, 130, 131) -or
            $ResponsePdu[4] -notin @(0, 255)) {
            throw 'Invalid Read Device Identification response.'
        }
        $offset = 7
        for ($i = 0; $i -lt [int]$ResponsePdu[6]; $i++) {
            if ($offset + 2 -gt $ResponsePdu.Length) { throw 'Truncated identification object header.' }
            $size = [int]$ResponsePdu[$offset + 1]
            $offset += 2
            if ($offset + $size -gt $ResponsePdu.Length) { throw 'Truncated identification object.' }
            $offset += $size
        }
        if ($offset -ne $ResponsePdu.Length) { throw 'Unexpected trailing identification data.' }
    }
    [pscustomobject]@{ Kind = 'Identity'; Values = @(); ExceptionCode = $null }
}

function Close-ModbusSession {
    param([pscustomobject]$Session)
    if ($null -ne $Session.Client) { $Session.Client.Close() }
    $Session.Client = $null
    $Session.Stream = $null
}

function Read-ModbusBytes {
    param([IO.Stream]$Stream, [int]$Count, [Diagnostics.Stopwatch]$Clock, [int]$TimeoutMs)
    $buffer = New-Object byte[] $Count
    $offset = 0
    while ($offset -lt $Count) {
        $remaining = $TimeoutMs - [int]$Clock.ElapsedMilliseconds
        if ($remaining -le 0) { throw [TimeoutException]::new('Modbus response deadline exceeded.') }
        $Stream.ReadTimeout = [Math]::Max(1, $remaining)
        $n = $Stream.Read($buffer, $offset, $Count - $offset)
        if ($n -eq 0) { throw [IO.EndOfStreamException]::new('Peer closed the TCP connection.') }
        $offset += $n
    }
    return ,$buffer
}

function Invoke-ModbusExchange {
    [CmdletBinding()]
    param([pscustomobject]$Session, [int]$UnitId, [byte[]]$RequestPdu)
    if (($UnitId -lt 1 -or $UnitId -gt 247) -and $UnitId -ne 255) { throw 'Invalid or broadcast Unit ID.' }
    if (-not (Test-ModbusReadOnlyRequest -RequestPdu $RequestPdu)) { throw 'Only read-only probe functions are allowed.' }
    if ($Session.RequestsSent -ge $Session.MaxRequestsPerHost) { $Session.StopReason = 'Request budget reached' }
    if ($Session.Clock.Elapsed.TotalSeconds -ge $Session.MaxHostSeconds) { $Session.StopReason = 'Host time budget reached' }
    if ($Session.StopReason) { return [pscustomobject]@{ Kind = 'Limit'; Values = @(); ExceptionCode = $null } }

    $phase = 'Delay'
    try {
        if ($Session.RequestsSent -gt 0 -and $Session.RequestDelayMs -gt 0) {
            $available = [int]($Session.MaxHostSeconds * 1000 - $Session.Clock.ElapsedMilliseconds)
            if ($available -le $Session.RequestDelayMs) {
                $Session.StopReason = 'Host time budget reached'
                return [pscustomobject]@{ Kind = 'Limit'; Values = @(); ExceptionCode = $null }
            }
            Start-Sleep -Milliseconds $Session.RequestDelayMs
        }
        $phase = 'Connect'
        if ($null -eq $Session.Client) {
            $Session.Client = New-Object Net.Sockets.TcpClient
            $remainingMs = [int]($Session.MaxHostSeconds * 1000 - $Session.Clock.ElapsedMilliseconds)
            if ($remainingMs -le 0) { throw [TimeoutException]::new('Host deadline exceeded.') }
            $connectTimeout = [Math]::Min($Session.ConnectTimeoutMs, $remainingMs)
            $pending = $Session.Client.ConnectAsync([Net.IPAddress]::Parse($Session.IPAddress), $Session.Port)
            if (-not $pending.Wait($connectTimeout) -or -not $Session.Client.Connected) {
                throw [TimeoutException]::new('TCP connect timed out.')
            }
            $Session.Stream = $Session.Client.GetStream()
        }
        $Session.ConnectFailures = 0
        $Session.Transaction = ($Session.Transaction % 65535) + 1
        $tx = [int]$Session.Transaction
        $length = 1 + $RequestPdu.Length
        $packet = [byte[]]@(($tx -shr 8), ($tx -band 255), 0, 0, ($length -shr 8), ($length -band 255), $UnitId)
        $packet = [byte[]]($packet + $RequestPdu)
        $remainingMs = [int]($Session.MaxHostSeconds * 1000 - $Session.Clock.ElapsedMilliseconds)
        if ($remainingMs -le 0) { throw [TimeoutException]::new('Host deadline exceeded.') }
        $timeout = [Math]::Min($Session.ResponseTimeoutMs, $remainingMs)
        $Session.Stream.WriteTimeout = [Math]::Max(1, $timeout)
        $exchangeClock = [Diagnostics.Stopwatch]::StartNew()
        $phase = 'Exchange'
        $Session.RequestsSent++
        $Session.Stream.Write($packet, 0, $packet.Length)
        $header = Read-ModbusBytes -Stream $Session.Stream -Count 7 -Clock $exchangeClock -TimeoutMs $timeout
        $returnedTx = ([int]$header[0] -shl 8) -bor [int]$header[1]
        $bodyLength = ([int]$header[4] -shl 8) -bor [int]$header[5]
        if ($returnedTx -ne $tx -or $header[2] -ne 0 -or $header[3] -ne 0 -or
            $header[6] -ne $UnitId -or $bodyLength -lt 2 -or $bodyLength -gt 254) {
            throw [FormatException]::new('Invalid Modbus TCP header.')
        }
        $pdu = Read-ModbusBytes -Stream $Session.Stream -Count ($bodyLength - 1) -Clock $exchangeClock -TimeoutMs $timeout
        return (ConvertFrom-ModbusPdu -RequestPdu $RequestPdu -ResponsePdu $pdu)
    }
    catch {
        $message = $_.Exception.Message
        Close-ModbusSession -Session $Session
        if ($phase -eq 'Connect') {
            $Session.ConnectFailures++
            if ($Session.ConnectFailures -ge 3) { $Session.StopReason = 'Repeated TCP connection failures' }
        }
        Write-Verbose ("{0}:{1} unit {2}: {3}" -f $Session.IPAddress, $Session.Port, $UnitId, $message)
        return [pscustomobject]@{ Kind = 'Error'; Values = @(); ExceptionCode = $null }
    }
}

function Get-ModbusSeedAddresses {
    @((0..31) + @(49, 50, 63, 64, 99, 100, 127, 128, 199, 200, 255, 256,
        499, 500, 511, 512, 999, 1000, 1023, 1024, 1999, 2000, 2047, 2048,
        2999, 3000, 3999, 4000, 4095, 4096, 4999, 5000, 5999, 6000,
        9999, 10000, 16383, 16384, 19999, 20000, 29999, 30000,
        39999, 40000, 40999, 41000, 49999, 50000, 59999, 60000, 65535)) |
        Sort-Object -Unique
}

function Invoke-ModbusDeviceScan {
    [CmdletBinding()]
    param(
        [string]$IPAddress,
        [ValidateRange(1, 65535)][int]$Port,
        [ValidateNotNullOrEmpty()]
        [ValidateScript({ ($_ -ge 1 -and $_ -le 247) -or $_ -eq 255 })]
        [int[]]$UnitId = @(255, 1),
        [int[]]$SeedAddress = (Get-ModbusSeedAddresses),
        [ValidateRange(0, 128)][int]$NeighborhoodBudget = 36,
        [int]$ConnectTimeoutMs = 1000,
        [int]$ResponseTimeoutMs = 1500,
        [int]$RequestDelayMs = 200,
        [int]$MaxRequestsPerHost = 320,
        [int]$MaxHostSeconds = 120
    )
    $parsed = [Net.IPAddress]::Parse($IPAddress)
    if ($parsed.AddressFamily -ne [Net.Sockets.AddressFamily]::InterNetwork) { throw 'Only IPv4 addresses are supported.' }
    foreach ($address in $SeedAddress) {
        if ($address -lt 0 -or $address -gt 65535) { throw 'Invalid probe register address.' }
    }
    $session = [pscustomobject]@{
        IPAddress = $parsed.ToString(); Port = $Port; Client = $null; Stream = $null
        Transaction = 0; RequestsSent = 0; ConnectFailures = 0; StopReason = ''
        ConnectTimeoutMs = $ConnectTimeoutMs; ResponseTimeoutMs = $ResponseTimeoutMs
        RequestDelayMs = $RequestDelayMs; MaxRequestsPerHost = $MaxRequestsPerHost
        MaxHostSeconds = $MaxHostSeconds; Clock = [Diagnostics.Stopwatch]::StartNew()
    }
    $confirmed = $false
    $selectedUnit = $null
    $registerCount = 0
    $unitsSeen = New-Object 'System.Collections.Generic.HashSet[int]'
    try {
        foreach ($unit in $UnitId) {
            if (-not $unitsSeen.Add($unit) -or $session.StopReason) { continue }
            Close-ModbusSession -Session $session
            $registers = New-Object 'System.Collections.Generic.HashSet[string]'
            $unitConfirmed = $false
            foreach ($fc in @(3, 4)) {
                if ($session.StopReason) { break }
                $queue = New-Object 'System.Collections.Generic.List[int]'
                $seen = New-Object 'System.Collections.Generic.HashSet[int]'
                foreach ($address in $SeedAddress) {
                    if ($seen.Add($address)) { $queue.Add($address) }
                }
                $extra = 0
                $failures = 0
                for ($i = 0; $i -lt $queue.Count; $i++) {
                    $address = $queue[$i]
                    $pdu = [byte[]]@($fc, ($address -shr 8), ($address -band 255), 0, 1)
                    $reply = Invoke-ModbusExchange -Session $session -UnitId $unit -RequestPdu $pdu
                    if ($reply.Kind -eq 'Limit' -or $session.StopReason) { break }
                    if ($reply.Kind -eq 'Error') {
                        $failures++
                        if ($failures -ge 2) { break }
                        continue
                    }
                    $unitConfirmed = $true
                    if ($reply.Kind -eq 'Exception') {
                        if ($reply.ExceptionCode -eq 1) { break } # Function unsupported, not address-specific.
                        if ($reply.ExceptionCode -in @(10, 11)) {
                            $failures++
                            if ($failures -ge 2) { break }
                        }
                        else { $failures = 0 }
                        continue
                    }
                    $failures = 0
                    if ($reply.Kind -eq 'Data') {
                        [void]$registers.Add(('{0}:{1}' -f $fc, $address))
                        # Neighbor reads are bounded and only follow successful register reads.
                        foreach ($delta in (-3..3)) {
                            if ($extra -ge $NeighborhoodBudget) { break }
                            $neighbor = $address + $delta
                            if ($neighbor -ge 0 -and $neighbor -le 65535 -and $seen.Add($neighbor)) {
                                $queue.Add($neighbor)
                                $extra++
                            }
                        }
                    }
                }
            }
            # These identify protocol behavior; they never add to the register count.
            foreach ($identityRequest in @(([byte[]]@(43, 14, 1, 0)), ([byte[]]@(17)))) {
                if ($session.StopReason) { break }
                $reply = Invoke-ModbusExchange -Session $session -UnitId $unit -RequestPdu $identityRequest
                if ($reply.Kind -in @('Identity', 'Exception')) { $unitConfirmed = $true }
            }
            if ($unitConfirmed) {
                $confirmed = $true
                if ($null -eq $selectedUnit) { $selectedUnit = $unit }
            }
            if ($registers.Count -gt 0) {
                $registerCount = $registers.Count
                $selectedUnit = $unit
                break # Do not multiply the count across aliases/ignored Unit IDs.
            }
        }
    }
    finally { Close-ModbusSession -Session $session }
    if (-not $session.StopReason) { $session.StopReason = 'Completed bounded probes' }
    Write-Verbose ("{0}: unit {1}, {2} requests, {3}" -f $IPAddress, $selectedUnit, $session.RequestsSent, $session.StopReason)
    [pscustomobject]@{
        IPAddress = $parsed.ToString(); Confirmed = $confirmed; RegisterCount = $registerCount
        UnitID = $selectedUnit; RequestsSent = $session.RequestsSent; StopReason = $session.StopReason
    }
}

function Format-ModbusScanResult {
    param([pscustomobject]$Result)
    if ($Result.Confirmed) {
        'IP: {0} is a Modbus device with data returned on {1} registers.' -f $Result.IPAddress, $Result.RegisterCount
    }
}

function Invoke-ModbusArpScan {
    [CmdletBinding()]
    param(
        [ValidateRange(0, 65535)][int]$Port = 0,
        [string[]]$ExcludeIP = @(),
        [int[]]$UnitId = @(255, 1),
        [int]$ConnectTimeoutMs = 1000,
        [int]$ResponseTimeoutMs = 1500,
        [int]$RequestDelayMs = 200,
        [int]$MaxRequestsPerHost = 320,
        [int]$MaxHostSeconds = 120
    )
    if ($Port -eq 0) {
        do {
            $answer = (Read-Host 'Which port would you like to test? [502]').Trim()
            if ($answer.Length -eq 0) { $Port = 502; break }
            $choice = 0
            if ([int]::TryParse($answer, [ref]$choice) -and $choice -ge 1 -and $choice -le 65535) {
                $Port = $choice
            }
            else { Write-Warning 'Enter a TCP port number from 1 through 65535.' }
        } while ($Port -eq 0)
    }
    $targets = @(ConvertFrom-ModbusArpOutput -Lines (Get-ModbusArpCache) -ExcludeIP $ExcludeIP)
    $open = New-Object 'System.Collections.Generic.List[string]'
    foreach ($address in $targets) {
        Write-Verbose ("Checking TCP {0}:{1}" -f $address, $Port)
        if (Test-ModbusTcpPort -IPAddress $address -Port $Port -ConnectTimeoutMs $ConnectTimeoutMs) {
            $open.Add($address)
        }
    }
    Write-Verbose ("ARP targets: {0}; TCP responders: {1}" -f $targets.Count, $open.Count)
    foreach ($address in $open) {
        $result = Invoke-ModbusDeviceScan -IPAddress $address -Port $Port -UnitId $UnitId `
            -ConnectTimeoutMs $ConnectTimeoutMs -ResponseTimeoutMs $ResponseTimeoutMs `
            -RequestDelayMs $RequestDelayMs -MaxRequestsPerHost $MaxRequestsPerHost -MaxHostSeconds $MaxHostSeconds
        Format-ModbusScanResult -Result $result
    }
}

# Importing functions for tests/use does not initiate any networking.
if ($MyInvocation.InvocationName -ne '.') {
    Invoke-ModbusArpScan -Port $Port -ExcludeIP $ExcludeIP -UnitId $UnitId `
        -ConnectTimeoutMs $ConnectTimeoutMs -ResponseTimeoutMs $ResponseTimeoutMs `
        -RequestDelayMs $RequestDelayMs -MaxRequestsPerHost $MaxRequestsPerHost -MaxHostSeconds $MaxHostSeconds
}
