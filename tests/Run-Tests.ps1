#Requires -Version 5.1
<#
Self-contained tests for Windows PowerShell 5.1 and PowerShell 7.
No Pester, ARP query, customer target, administrator rights, or Internet required.
Every actual socket is confined to IPv4 loopback (127.0.0.1), on ephemeral ports.
#>
$ErrorActionPreference = 'Stop'
$scannerPath = Join-Path (Split-Path -Parent $PSScriptRoot) 'ModbusArpScanner.ps1'
. $scannerPath

if (-not ('ModbusArpScanner.Tests.MockModbusServer' -as [type])) {
    Add-Type -Path (Join-Path $PSScriptRoot 'MockModbusServer.cs')
}

$script:passed = 0
$script:failed = 0

function Assert-True {
    param([bool]$Condition, [string]$Message = 'Expected true')
    if (-not $Condition) { throw $Message }
}

function Assert-Equal {
    param($Expected, $Actual, [string]$Message = 'Values differ')
    if ($Expected -ne $Actual) {
        throw ('{0}. Expected [{1}], got [{2}]' -f $Message, $Expected, $Actual)
    }
}

function Assert-Throws {
    param([scriptblock]$Body, [string]$Message = 'Expected an exception')
    try { & $Body | Out-Null }
    catch { return }
    throw $Message
}

function Test-Case {
    param([string]$Name, [scriptblock]$Body)
    try {
        & $Body
        $script:passed++
        Write-Host ('PASS: ' + $Name) -ForegroundColor Green
    }
    catch {
        $script:failed++
        Write-Host ('FAIL: {0}: {1}' -f $Name, $_.Exception.Message) -ForegroundColor Red
    }
}

function Invoke-MockScan {
    param(
        $Server,
        [int[]]$Units = @(255, 1),
        [int[]]$Addresses = @(0, 1),
        [int]$RequestLimit = 40,
        [int]$ResponseMs = 250,
        [int]$HostSeconds = 10
    )
    Invoke-ModbusDeviceScan -IPAddress '127.0.0.1' -Port $Server.Port `
        -UnitId $Units -SeedAddress $Addresses -NeighborhoodBudget 0 `
        -ConnectTimeoutMs 300 -ResponseTimeoutMs $ResponseMs -RequestDelayMs 0 `
        -MaxRequestsPerHost $RequestLimit -MaxHostSeconds $HostSeconds
}

function Assert-NoActiveClients {
    param($Server)
    $clock = [Diagnostics.Stopwatch]::StartNew()
    while ($Server.ActiveConnections -gt 0 -and $clock.ElapsedMilliseconds -lt 1000) {
        Start-Sleep -Milliseconds 10
    }
    Assert-Equal 0 $Server.ActiveConnections 'Scanner left a socket open'
    Assert-True $Server.AllRequestsReadOnly 'A non-read-only or broadcast request was sent'
}

Write-Host ('Testing with PowerShell ' + $PSVersionTable.PSVersion)

Test-Case 'ARP parser deduplicates interfaces, ignores headers, and accepts localized type labels' {
    $lines = @(
        'Interface: 192.0.2.1 --- 0x4',
        '  Internet Address      Physical Address      Type',
        '  192.0.2.10            00-11-22-33-44-55     dynamic',
        '  192.0.2.11            00-11-22-33-44-56     static',
        'Interface: 198.51.100.1 --- 0x5',
        '  192.0.2.10            00-11-22-33-44-55     dinamico',
        '  198.51.100.255        00:11:22:33:44:57     statisch'
    )
    $actual = @(ConvertFrom-ModbusArpOutput -Lines $lines | Sort-Object)
    Assert-Equal 3 $actual.Count
    Assert-Equal '192.0.2.10,192.0.2.11,198.51.100.255' ($actual -join ',')
}

Test-Case 'ARP parser removes broadcast, multicast, unresolved, loopback, invalid, and excluded addresses' {
    $lines = @(
        '  192.0.2.10       00-11-22-33-44-55 dynamic',
        '  192.0.2.11       00-11-22-33-44-56 static',
        '  192.0.2.255      ff-ff-ff-ff-ff-ff static',
        '  224.0.0.22       01-00-5e-00-00-16 static',
        '  255.255.255.255  ff-ff-ff-ff-ff-ff static',
        '  192.0.2.12       00-00-00-00-00-00 incomplete',
        '  127.0.0.1        00-11-22-33-44-58 static',
        '  0.0.0.0          00-11-22-33-44-59 static',
        '  999.3.4.5        00-11-22-33-44-60 static',
        '  192.0.2.13       01-00-5e-01-02-03 static',
        '  fe80::1          00-11-22-33-44-61 dynamic'
    )
    $actual = @(ConvertFrom-ModbusArpOutput -Lines $lines -ExcludeIP '192.0.2.11')
    Assert-Equal 1 $actual.Count
    Assert-Equal '192.0.2.10' $actual[0]
    Assert-Throws { ConvertFrom-ModbusArpOutput -Lines $lines -ExcludeIP 'not-an-ip' }
}

Test-Case 'Read-only allowlist rejects writes, diagnostics, invalid quantities, and register overflow' {
    foreach ($pdu in @(
        [byte[]]@(6, 0, 1, 0, 1), [byte[]]@(16, 0, 1, 0, 1, 2, 0, 1),
        [byte[]]@(5, 0, 1, 255, 0), [byte[]]@(8, 0, 1),
        [byte[]]@(3, 0, 0, 0, 0), [byte[]]@(3, 255, 255, 0, 2),
        [byte[]]@(3, 0, 0, 0, 126), [byte[]]@(43, 14, 4, 0)
    )) {
        Assert-True (-not (Test-ModbusReadOnlyRequest -RequestPdu $pdu))
    }
    Assert-True (Test-ModbusReadOnlyRequest -RequestPdu ([byte[]]@(3, 255, 255, 0, 1)))
}

Test-Case 'Register PDU parser accepts zero and correct multi-register data' {
    $r = ConvertFrom-ModbusPdu -RequestPdu ([byte[]]@(3, 0, 0, 0, 1)) -ResponsePdu ([byte[]]@(3, 2, 0, 0))
    Assert-Equal 'Data' $r.Kind
    Assert-Equal 1 @($r.Values).Count
    Assert-Equal 0 $r.Values[0]
    $r = ConvertFrom-ModbusPdu -RequestPdu ([byte[]]@(4, 0, 0, 0, 2)) -ResponsePdu ([byte[]]@(4, 4, 0, 0, 255, 255))
    Assert-Equal '0,65535' ($r.Values -join ',')
}

Test-Case 'Register PDU parser rejects wrong function, count, truncation, and extra bytes' {
    $request = [byte[]]@(3, 0, 0, 0, 1)
    foreach ($bad in @(
        [byte[]]@(4, 2, 0, 1), [byte[]]@(3, 4, 0, 1),
        [byte[]]@(3, 2, 0), [byte[]]@(3, 2, 0, 1, 0), [byte[]]@(3, 0)
    )) {
        Assert-Throws { ConvertFrom-ModbusPdu -RequestPdu $request -ResponsePdu $bad }
    }
}

Test-Case 'Canonical and explicitly supported MEI exception responses are recognized, not counted as data' {
    $r = ConvertFrom-ModbusPdu -RequestPdu ([byte[]]@(3, 0, 0, 0, 1)) -ResponsePdu ([byte[]]@(131, 2))
    Assert-Equal 'Exception' $r.Kind
    Assert-Equal 2 $r.ExceptionCode
    Assert-Equal 0 @($r.Values).Count
    $r = ConvertFrom-ModbusPdu -RequestPdu ([byte[]]@(43, 14, 1, 0)) -ResponsePdu ([byte[]]@(171, 14, 1))
    Assert-Equal 'Exception' $r.Kind
    Assert-Throws { ConvertFrom-ModbusPdu -RequestPdu ([byte[]]@(3, 0, 0, 0, 1)) -ResponsePdu ([byte[]]@(131, 2, 0)) }
    Assert-Throws { ConvertFrom-ModbusPdu -RequestPdu ([byte[]]@(3, 0, 0, 0, 1)) -ResponsePdu ([byte[]]@(131, 0)) }
    Assert-Throws { ConvertFrom-ModbusPdu -RequestPdu ([byte[]]@(43, 14, 1, 0)) -ResponsePdu ([byte[]]@(171, 1, 0)) }
}

Test-Case 'FC17 validates body length without assuming a vendor-specific ID layout' {
    foreach ($valid in @([byte[]]@(17, 2, 42, 255), [byte[]]@(17, 4, 65, 66, 0, 255))) {
        $r = ConvertFrom-ModbusPdu -RequestPdu ([byte[]]@(17)) -ResponsePdu $valid
        Assert-Equal 'Identity' $r.Kind
    }
    foreach ($bad in @([byte[]]@(17, 1, 42), [byte[]]@(17, 3, 42, 255), [byte[]]@(17, 0))) {
        Assert-Throws { ConvertFrom-ModbusPdu -RequestPdu ([byte[]]@(17)) -ResponsePdu $bad }
    }
}

Test-Case 'FC43 validates MEI, read code, conformity, more-follows flag, and object bounds' {
    $request = [byte[]]@(43, 14, 1, 0)
    $valid = [byte[]]@(43, 14, 1, 1, 0, 0, 1, 0, 4, 65, 99, 109, 101)
    Assert-Equal 'Identity' (ConvertFrom-ModbusPdu -RequestPdu $request -ResponsePdu $valid).Kind
    foreach ($bad in @(
        [byte[]]@(43, 13, 1, 1, 0, 0, 0), [byte[]]@(43, 14, 2, 1, 0, 0, 0),
        [byte[]]@(43, 14, 1, 0, 0, 0, 0), [byte[]]@(43, 14, 1, 1, 1, 0, 0),
        [byte[]]@(43, 14, 1, 1, 0, 0, 1, 0), [byte[]]@(43, 14, 1, 1, 0, 0, 1, 0, 4, 65),
        [byte[]]@(43, 14, 1, 1, 0, 0, 0, 99)
    )) {
        Assert-Throws { ConvertFrom-ModbusPdu -RequestPdu $request -ResponsePdu $bad }
    }
}

Test-Case 'TCP probe is bounded, closes its socket, and sends no Modbus payload' {
    $server = [ModbusArpScanner.Tests.MockModbusServer]::new('Normal')
    try {
        Assert-True (Test-ModbusTcpPort -IPAddress '127.0.0.1' -Port $server.Port -ConnectTimeoutMs 300)
        Assert-NoActiveClients $server
        Assert-Equal 0 $server.RequestCount
    }
    finally { $server.Dispose() }
    $listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0)
    $listener.Start()
    $closedPort = ([Net.IPEndPoint]$listener.LocalEndpoint).Port
    $listener.Stop()
    Assert-True (-not (Test-ModbusTcpPort -IPAddress '127.0.0.1' -Port $closedPort -ConnectTimeoutMs 200))
}

Test-Case 'Normal scan counts distinct function/address pairs, reuses TCP, and stops after working Unit ID' {
    $server = [ModbusArpScanner.Tests.MockModbusServer]::new('Normal')
    try {
        $r = Invoke-MockScan $server -Addresses @(0, 0, 1, 1)
        Assert-True $r.Confirmed
        Assert-Equal 4 $r.RegisterCount
        Assert-Equal 255 $r.UnitID
        Assert-Equal 1 @($server.UnitsSeen | Sort-Object -Unique).Count
        Assert-Equal 1 $server.ConnectionCount
        Assert-NoActiveClients $server
    }
    finally { $server.Dispose() }
}

Test-Case 'Zero-valued holding and input registers both count' {
    $server = [ModbusArpScanner.Tests.MockModbusServer]::new('Normal')
    try {
        $r = Invoke-MockScan $server -Addresses @(0)
        Assert-Equal 2 $r.RegisterCount
        Assert-NoActiveClients $server
    }
    finally { $server.Dispose() }
}

Test-Case 'Neighbor expansion is bounded, deduplicated, and stays inside the register range' {
    $server = [ModbusArpScanner.Tests.MockModbusServer]::new('Normal')
    try {
        $r = Invoke-ModbusDeviceScan -IPAddress '127.0.0.1' -Port $server.Port `
            -UnitId @(255) -SeedAddress @(0, 65535) -NeighborhoodBudget 2 `
            -ConnectTimeoutMs 300 -ResponseTimeoutMs 250 -RequestDelayMs 0 `
            -MaxRequestsPerHost 40 -MaxHostSeconds 10
        Assert-True $r.Confirmed
        Assert-Equal 8 $r.RegisterCount
        Assert-Equal 10 $r.RequestsSent
        Assert-NoActiveClients $server
    }
    finally { $server.Dispose() }
}

Test-Case 'Silent Unit ID 255 permits fallback to Unit ID 1' {
    $server = [ModbusArpScanner.Tests.MockModbusServer]::new('Silent255')
    try {
        $r = Invoke-MockScan $server -ResponseMs 100
        Assert-True $r.Confirmed
        Assert-Equal 4 $r.RegisterCount
        Assert-Equal 1 $r.UnitID
        Assert-True (255 -in $server.UnitsSeen -and 1 -in $server.UnitsSeen)
        Assert-NoActiveClients $server
    }
    finally { $server.Dispose() }
}

Test-Case 'Exception-only first Unit ID does not block selection of a data-bearing fallback' {
    $server = [ModbusArpScanner.Tests.MockModbusServer]::new('Exception255')
    try {
        $r = Invoke-MockScan $server
        Assert-True $r.Confirmed
        Assert-Equal 4 $r.RegisterCount
        Assert-Equal 1 $r.UnitID
        Assert-NoActiveClients $server
    }
    finally { $server.Dispose() }
}

Test-Case 'FC04-only device is found even when FC03 silently times out' {
    $server = [ModbusArpScanner.Tests.MockModbusServer]::new('FC04Only')
    try {
        $r = Invoke-MockScan $server -ResponseMs 100
        Assert-True $r.Confirmed
        Assert-Equal 2 $r.RegisterCount
        Assert-NoActiveClients $server
    }
    finally { $server.Dispose() }
}

Test-Case 'Illegal Function skips remaining addresses for that function' {
    $server = [ModbusArpScanner.Tests.MockModbusServer]::new('RejectFC03')
    try {
        $r = Invoke-MockScan $server -Addresses @(0, 1, 2)
        Assert-True $r.Confirmed
        Assert-Equal 3 $r.RegisterCount
        Assert-Equal 1 @($server.FunctionsSeen | Where-Object { $_ -eq 3 }).Count
        Assert-NoActiveClients $server
    }
    finally { $server.Dispose() }
}

Test-Case 'Valid exceptions confirm Modbus but return a count of zero' {
    $server = [ModbusArpScanner.Tests.MockModbusServer]::new('ExceptionOnly')
    try {
        $r = Invoke-MockScan $server
        Assert-True $r.Confirmed
        Assert-Equal 0 $r.RegisterCount
        Assert-NoActiveClients $server
    }
    finally { $server.Dispose() }
}

Test-Case 'Positive identification responses do not increase the register count' {
    $server = [ModbusArpScanner.Tests.MockModbusServer]::new('IdentityOnly')
    try {
        $r = Invoke-MockScan $server -Units @(255)
        Assert-True $r.Confirmed
        Assert-Equal 0 $r.RegisterCount
        Assert-True (43 -in $server.FunctionsSeen -and 17 -in $server.FunctionsSeen)
        Assert-NoActiveClients $server
    }
    finally { $server.Dispose() }
}

Test-Case 'Gateway failures stop blind probing of further addresses' {
    $server = [ModbusArpScanner.Tests.MockModbusServer]::new('GatewayFault')
    try {
        $r = Invoke-MockScan $server -Addresses @(0..20)
        Assert-True $r.Confirmed
        Assert-Equal 0 $r.RegisterCount
        Assert-True ($server.RequestCount -le 12) 'Gateway received too many failed probes'
        Assert-NoActiveClients $server
    }
    finally { $server.Dispose() }
}

Test-Case 'Fragmented TCP responses are assembled correctly' {
    $server = [ModbusArpScanner.Tests.MockModbusServer]::new('Fragmented')
    try {
        $r = Invoke-MockScan $server -ResponseMs 700
        Assert-True $r.Confirmed
        Assert-Equal 4 $r.RegisterCount
        Assert-NoActiveClients $server
    }
    finally { $server.Dispose() }
}

foreach ($mode in @('WrongTransaction', 'WrongProtocol', 'WrongUnit', 'WrongFunction',
    'OversizedLength', 'UndersizedLength', 'Truncated', 'Banner', 'Silent')) {
    Test-Case ('Rejects TCP-open non-Modbus/malformed responder: ' + $mode) {
        $server = [ModbusArpScanner.Tests.MockModbusServer]::new($mode)
        try {
            $r = Invoke-MockScan $server -Units @(255) -ResponseMs 100
            Assert-True (-not $r.Confirmed) 'False-positive Modbus confirmation'
            Assert-Equal 0 $r.RegisterCount
            Assert-NoActiveClients $server
        }
        finally { $server.Dispose() }
    }
}

Test-Case 'Bad register byte counts never count as readable registers' {
    $server = [ModbusArpScanner.Tests.MockModbusServer]::new('WrongByteCount')
    try {
        $r = Invoke-MockScan $server -Units @(255)
        # The fixture still gives well-formed identification exceptions.
        Assert-True $r.Confirmed
        Assert-Equal 0 $r.RegisterCount
        Assert-NoActiveClients $server
    }
    finally { $server.Dispose() }
}

Test-Case 'A server closing after each reply is handled with bounded reconnects' {
    $server = [ModbusArpScanner.Tests.MockModbusServer]::new('CloseAfterReply')
    try {
        $r = Invoke-MockScan $server -Addresses @(0..5)
        Assert-True $r.Confirmed
        Assert-True ($r.RegisterCount -gt 0)
        Assert-True ($server.ConnectionCount -gt 1)
        Assert-True ($r.RequestsSent -le 40)
        Assert-NoActiveClients $server
    }
    finally { $server.Dispose() }
}

Test-Case 'Request budget caps the number of transmitted Modbus requests' {
    $server = [ModbusArpScanner.Tests.MockModbusServer]::new('Normal')
    try {
        $r = Invoke-MockScan $server -Addresses @(0..10) -RequestLimit 3
        Assert-Equal 3 $r.RequestsSent
        Assert-True ($server.RequestCount -le 3)
        Assert-Equal 3 $r.RegisterCount
        Assert-True ($r.StopReason -match 'budget')
        Assert-NoActiveClients $server
    }
    finally { $server.Dispose() }
}

Test-Case 'Whole-exchange timeout defeats slow trickle responses' {
    $server = [ModbusArpScanner.Tests.MockModbusServer]::new('SlowTrickle')
    try {
        $watch = [Diagnostics.Stopwatch]::StartNew()
        $r = Invoke-MockScan $server -Addresses @(0) -Units @(255) -RequestLimit 1 -ResponseMs 180
        $watch.Stop()
        Assert-True (-not $r.Confirmed)
        Assert-True ($watch.ElapsedMilliseconds -lt 800) 'Response deadline reset for each fragment'
        Assert-NoActiveClients $server
    }
    finally { $server.Dispose() }
}

Test-Case 'Host time budget stops a silent responder' {
    $server = [ModbusArpScanner.Tests.MockModbusServer]::new('Silent')
    try {
        $watch = [Diagnostics.Stopwatch]::StartNew()
        $r = Invoke-MockScan $server -Addresses @(0..10) -ResponseMs 500 -HostSeconds 1
        $watch.Stop()
        Assert-True (-not $r.Confirmed)
        Assert-True ($watch.ElapsedMilliseconds -lt 2500) 'Host deadline was not bounded'
        Assert-True ($r.RequestsSent -le 3)
        Assert-NoActiveClients $server
    }
    finally { $server.Dispose() }
}

Test-Case 'Broadcast Unit ID is rejected before any socket or packet' {
    $server = [ModbusArpScanner.Tests.MockModbusServer]::new('Normal')
    try {
        Assert-Throws { Invoke-MockScan $server -Units @(0) }
        Assert-Equal 0 $server.RequestCount
        Assert-Equal 0 $server.ConnectionCount
    }
    finally { $server.Dispose() }
}

Test-Case 'Exchange write guard rejects prohibited requests before opening a socket' {
    $server = [ModbusArpScanner.Tests.MockModbusServer]::new('Normal')
    $session = [pscustomobject]@{
        IPAddress = '127.0.0.1'; Port = $server.Port; Client = $null; Stream = $null
        Transaction = 0; RequestsSent = 0; ConnectFailures = 0; StopReason = ''
        ConnectTimeoutMs = 300; ResponseTimeoutMs = 250; RequestDelayMs = 0
        MaxRequestsPerHost = 10; MaxHostSeconds = 5
        Clock = [Diagnostics.Stopwatch]::StartNew()
    }
    try {
        foreach ($request in @(
            [byte[]]@(6, 0, 0, 0, 1), [byte[]]@(16, 0, 0, 0, 1, 2, 0, 1),
            [byte[]]@(5, 0, 0, 255, 0), [byte[]]@(8, 0, 1)
        )) {
            Assert-Throws { Invoke-ModbusExchange -Session $session -UnitId 1 -RequestPdu $request }
        }
        Assert-Equal 0 $session.RequestsSent
        Assert-True ($null -eq $session.Client)
        Assert-Equal 0 $server.ConnectionCount
        Assert-Equal 0 $server.RequestCount
    }
    finally {
        Close-ModbusSession -Session $session
        $server.Dispose()
    }
}

Test-Case 'Formatting is exactly one requested line per confirmed endpoint' {
    $result = [pscustomobject]@{ IPAddress = '192.0.2.10'; Confirmed = $true; RegisterCount = 4 }
    $actual = @(Format-ModbusScanResult -Result $result)
    Assert-Equal 1 $actual.Count
    Assert-Equal 'IP: 192.0.2.10 is a Modbus device with data returned on 4 registers.' $actual[0]
    $result.RegisterCount = 0
    Assert-Equal 'IP: 192.0.2.10 is a Modbus device with data returned on 0 registers.' (Format-ModbusScanResult -Result $result)
    $result.Confirmed = $false
    Assert-Equal 0 @(Format-ModbusScanResult -Result $result).Count
}

# Pipeline-level proof without calling ARP or opening any socket. These local
# function replacements are confined to this test scope and restored afterward.
Test-Case 'ARP pipeline scans only open, non-excluded targets and performs all port checks first' {
    $originalArp = (Get-Item Function:Get-ModbusArpCache).ScriptBlock
    $originalPort = (Get-Item Function:Test-ModbusTcpPort).ScriptBlock
    $originalScan = (Get-Item Function:Invoke-ModbusDeviceScan).ScriptBlock
    $script:events = New-Object 'System.Collections.Generic.List[string]'
    try {
        function Get-ModbusArpCache {
            @(' 192.0.2.10 00-11-22-33-44-55 dynamic',
              ' 192.0.2.11 00-11-22-33-44-56 dynamic',
              ' 192.0.2.12 00-11-22-33-44-57 dynamic')
        }
        function Test-ModbusTcpPort {
            param($IPAddress, $Port, $ConnectTimeoutMs)
            $script:events.Add(('port:' + $IPAddress))
            return ($IPAddress -eq '192.0.2.10')
        }
        function Invoke-ModbusDeviceScan {
            param($IPAddress, $Port, $UnitId, $ConnectTimeoutMs, $ResponseTimeoutMs,
                $RequestDelayMs, $MaxRequestsPerHost, $MaxHostSeconds)
            $script:events.Add(('scan:' + $IPAddress))
            [pscustomobject]@{ IPAddress = $IPAddress; Confirmed = $true; RegisterCount = 2 }
        }
        $actual = @(Invoke-ModbusArpScan -Port 1502 -ExcludeIP '192.0.2.12')
        Assert-Equal 'port:192.0.2.10,port:192.0.2.11,scan:192.0.2.10' ($script:events -join ',')
        Assert-Equal 1 $actual.Count
        Assert-Equal 'IP: 192.0.2.10 is a Modbus device with data returned on 2 registers.' $actual[0]
    }
    finally {
        Set-Item Function:Get-ModbusArpCache $originalArp
        Set-Item Function:Test-ModbusTcpPort $originalPort
        Set-Item Function:Invoke-ModbusDeviceScan $originalScan
    }
}

Write-Host ('{0} passed; {1} failed. All network tests used loopback only.' -f $script:passed, $script:failed)
if ($script:failed -gt 0) { exit 1 }
exit 0
