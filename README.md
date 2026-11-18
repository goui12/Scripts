# Scripts

A growing collection of practical, standalone scripts by [goui12](https://github.com/goui12).

Each script has its own folder, instructions, requirements, and tests where applicable. Download only the script you need, or select **Code → Download ZIP** to get the entire collection.

## Available scripts

| Script | What it does | Platform | Instructions |
|---|---|---|---|
| [Modbus ARP Scanner](modbus-arp-scanner/ModbusArpScanner.ps1) | Prompts for a TCP port, checks the Windows ARP cache, then counts sampled registers returned by confirmed Modbus responders. Read-only and bounded. | Windows PowerShell 5.1 / PowerShell 7 on Windows | [README](modbus-arp-scanner/README.md) |

## Before running any script

Review its source and its individual README. **Follow the customer's site policies and obtain the required authorization before scanning networks, sending packets, or interacting with equipment.** Read-only requests can still affect device availability. An address appearing in an ARP cache does not grant permission to test it.

Do not publish customer IP addresses, credentials, screenshots, configuration exports, or scan results in this repository or its issues. Follow your organization's approved process if script execution is restricted; do not bypass its protections.

## Repository organization

Each tool lives in its own descriptively named folder. New tools should include:

- A standalone script and a README covering its purpose, requirements, usage, limits, and safety considerations.
- Tests where practical, using simulated or local fixtures rather than customer systems.
- An entry in the catalog above.

Shared repository settings and automated test workflows stay at the repository root. No script is run automatically just by downloading this collection.
