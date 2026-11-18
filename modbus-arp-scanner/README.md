# Modbus ARP Scanner

A small, dependency-free PowerShell tool for answering one practical question:

**Which devices already in this Windows computer's ARP cache respond to Modbus TCP, and how many sampled registers return data?**

The script asks which TCP port to test, checks the cached IP addresses, and runs bounded, read-only Modbus probes only against devices that accept a connection. Its normal output stays simple:

```text
Which port would you like to test? [502]: 502
IP: 192.0.2.10 is a Modbus device with data returned on 42 registers.
IP: 192.0.2.11 is a Modbus device with data returned on 0 registers.
```

*These are illustrative documentation addresses, not discovered devices.*

## Important: get approval before running

**Run this tool only on systems and networks you are explicitly authorized to test. Make sure your use follows the customer's site policies for network scanning and sending packets.**

- Agree on the permitted devices, networks, ports, and timing with the appropriate customer/site owner and IT/OT teams.
- Follow vendor restrictions, change-control requirements, and approved maintenance windows. Do not probe emergency power, life-safety, production, or other mission-critical equipment without the required approval.
- **Read-only does not mean risk-free.** Connections and requests still consume device resources, can trigger security monitoring, and may disrupt fragile or heavily loaded equipment. Stop if communications or operations change unexpectedly.
- An address appearing in your ARP cache is **not authorization** to test it. Exclude anything outside your approved scope before running.
- This is a discovery aid, not a commissioning certificate, equipment-identification guarantee, safety system, or control tool. Do not use a scan result to decide whether to start equipment, operate breakers, or enable/disable a safety-related function.

The scanner never sends Modbus write, restart, or diagnostic commands. It does not change device configuration, initiate equipment tests, or try credentials.

## Download and run

Requires **Windows PowerShell 5.1 or PowerShell 7 on Windows**. No additional modules or installations are required; administrator privileges are not normally needed.

1. Open [goui12/Scripts](https://github.com/goui12/Scripts), select **Code → Download ZIP**, and extract it. The scanner is in the `modbus-arp-scanner` folder. You can also download just [ModbusArpScanner.ps1](ModbusArpScanner.ps1).
2. Review the script and the safety notes above.
3. Open PowerShell in the extracted `modbus-arp-scanner` folder and run:

```powershell
.\ModbusArpScanner.ps1
```

Enter the authorized port when prompted. Press Enter to use **502**.

If Windows or your organization's execution policy blocks the script, follow the approved process for running it. Do not bypass organizational protections.

### Useful examples

Supply a port without the prompt:

```powershell
.\ModbusArpScanner.ps1 -Port 502
```

Keep particular IPs completely out of both the TCP and Modbus checks:

```powershell
.\ModbusArpScanner.ps1 -ExcludeIP @('192.0.2.10', '192.0.2.11')
```

Use known Unit IDs instead of the defaults:

```powershell
.\ModbusArpScanner.ps1 -Port 502 -UnitId @(1, 7)
```

Show troubleshooting details while it works:

```powershell
.\ModbusArpScanner.ps1 -Port 502 -Verbose
```

Normal output contains only the port prompt and one line per confirmed Modbus endpoint. It can be quiet while checks are in progress. Use `-Verbose` when you need to see why a device was skipped or a probe failed.

## How the scan works

1. Read a snapshot of `arp.exe -a`, retain unique unicast IPv4 neighbors, and remove broadcasts, multicast entries, and exclusions.
2. Test the selected TCP port sequentially on those addresses.
3. For open ports, try the configured Unit IDs, **255 then 1** by default. This is not a sweep of every slave address.
4. Use identification probes and bounded FC03/FC04 register reads, expanding a small neighborhood around successful addresses. Reuse connections and space out requests.
5. Validate response framing and count successfully returned registers. Apply request/time limits and stop unresponsive attempts.

The read functions are FC03 (holding registers) and FC04 (input registers). FC43/14 Device Identification and a best-effort FC17 Report Server ID compatibility probe can also provide protocol evidence; their identification data are not counted as registers. FC17 is specified for serial-line devices and is commonly unsupported over TCP.

**The scanner does not discover an entire subnet.** ARP is a local cache, not a complete device inventory. It can contain stale entries and omit reachable devices. Routed devices may not appear individually, and Windows routing determines which interface reaches a target.

## What the register count means

The count is the number of **distinct sampled function/address pairs that returned valid register data for one selected Unit ID**.

- A returned value of **zero counts**. A zero might be a valid measurement, an unused location, or a placeholder; the scanner cannot tell which.
- Holding register address 7 and input register address 7 count as **two** logical registers, even if the device mirrors their contents.
- Retries and repeated reads do not increase the count. Results from different candidate Unit IDs are not added together.
- Modbus exceptions and identification objects do **not** count as register data.
- A count of **0** means a valid Modbus response confirmed the protocol, but none of the tested registers returned data. It does not prove the device has no readable registers.
- An open TCP port with no valid Modbus reply is omitted. No output is not proof that the network contains no Modbus devices.

This is a **bounded sample**, not an exhaustive register inventory or an equipment-type detector. It can miss vendor-specific ranges, different Unit IDs, or devices with longer response times. A responding gateway does not prove that a particular downstream slave exists. Use the correct manufacturer register map before assigning names, scaling, or engineering units to values.

## Options and limits

| Parameter | Default | Purpose |
|---|---|---|
| `-Port` | Prompt; Enter selects `502` | Authorized TCP port, 1–65535 |
| `-ExcludeIP` | None | IP addresses to omit before any network check |
| `-UnitId` | `@(255, 1)` | Limited candidate Unit IDs, in order |
| `-ConnectTimeoutMs` | `1000` | TCP connection timeout |
| `-ResponseTimeoutMs` | `1500` | Modbus response timeout |
| `-RequestDelayMs` | `200` | Delay between requests |
| `-MaxRequestsPerHost` | `320` | Maximum Modbus requests per endpoint |
| `-MaxHostSeconds` | `120` | Per-endpoint investigation time limit |

Adjust limits only within the site's approved testing constraints. Larger timeouts or more probes can make the scan take substantially longer. Keep the default pacing unless the equipment owner approves otherwise.

## Privacy and local testing

The tool runs locally. It does not send telemetry, automatically upload results, or create scan logs/output files. Do not post customer addresses, credentials, screenshots, or scan output in public issues or commits.

The included automated tests use simulated **loopback-only** endpoints, not real controllers:

```powershell
.\tests\Run-Tests.ps1
```

Protocol reference: [Modbus Application Protocol Specification](https://www.modbus.org/file/secure/modbusprotocolspecification.pdf).
