# Panel Point Report

A read-only Siemens panel-report collector with a PowerShell launcher. It prompts for an IP address, user initials, and a masked password, then exports panel points, FLN subpoints, panel configuration information, and BACnet distribution-table observations to an Excel workbook.

## Authorization and site safety

**Obtain authorization and follow the customer's network, cybersecurity, commissioning, and operational policies before running this script.** It opens a Telnet connection and sends report requests to a controller. Read-only requests still consume controller and network resources. Use an approved test/maintenance window where required, and stop if the equipment or network behaves unexpectedly.

Telnet transmits credentials and report data **without encryption**. Use only an approved trusted network. This script does not scan an address range, discover neighboring IPs, change point values, modify device settings, initialize devices, alter BDT entries, or change PowerShell execution policy.

Reports, JSON snapshots, and logs contain customer-site information. Keep them private and review/redact them before sharing. Authentication input and login bodies are not logged. Nonblank password fields in device reports are redacted. No credentials, target addresses, or customer captures are embedded in the public script.

## Run

Requirements:

- Windows PowerShell 5.1 or PowerShell 7 on Windows.
- An existing, site-approved Node.js installation, version 18 or newer, available as `node` on PATH.
- Permission to reach the panel's Telnet port and run scripts under your organization's existing PowerShell policy.
- Write access to the folder containing the PS1.

Download **PanelPointReport.ps1**, save it in the folder where you want the reports, open PowerShell in that folder, and run:

```powershell
.\PanelPointReport.ps1
```

Enter the panel IP address, user initials, and password when prompted. The password prompt is masked. Credentials are passed to the temporary local worker through standard input, not process arguments, environment variables, or files.

**Outputs go beside the PS1 itself**, even if PowerShell's current working directory is different. Each run uses unique filenames and does not replace an earlier report:

```text
PanelReport_<target>_<timestamp>_<unique>.xlsx
PanelReport_<target>_<timestamp>_<unique>.json
PanelReport_<target>_<timestamp>_<unique>.log.jsonl
```

The timestamp in filenames is UTC. The JSON snapshot retains the collected report data for investigation and offline re-export. Raw report timestamps are preserved independently; collection is sequential, not a simultaneous snapshot of all values.

Optional parameters:

```powershell
# The password is still requested securely.
.\PanelPointReport.ps1 -PanelIp 192.0.2.10 -UserName operator

# For a site-approved nondefault Telnet port:
.\PanelPointReport.ps1 -Port 2323

# Offline workbook recreation from a complete saved JSON report. No panel contact.
.\PanelPointReport.ps1 -ReplayJson .\PanelReport_example.json
```

The example address is reserved for documentation, not a real target. A `-Credential` parameter also accepts a PowerShell `PSCredential` object. Do not put a plaintext password in a command line or save one in a script.

If Windows blocks the PS1, follow your organization's script approval/signing process. The launcher deliberately does not bypass execution policy, elevate privileges, install software, or download dependencies. Excel does not need to be installed: the exporter fills an embedded workbook template using Windows' native XML/ZIP support.

## Workbook

The workbook contains three sheets:

| Sheet | Contents |
| --- | --- |
| **Panel Points** | Non-colon point identifiers, listing values, units, status, priority, and collected Look fields. Identifiers containing `:` are never sent to Point → Edit → Look. |
| **Subpoints** | Separate tables grouped by driver and application number. Each device has a row, with Value / Unit / Status / Priority columns for each observed subpoint. Device metadata and Look fields are retained. A separate **Other colon observations** section preserves colon entries from the initial point list. |
| **Panel information** | One row per directory panel, configuration/diagnostic fields, explicit collection outcomes, and the **BACnet Distribution Tables** matrix below. |

For the BDT matrix, rows are unique IP address / netmask / UDP port tuples; instance columns identify the panel used to request each report. A check means the selected-instance report returned that entry. A green check marks a returned entry whose IP and UDP port match that panel's successfully collected configuration. An unknown own address or port does not produce a green check. Blank membership cells mean absence only when the relevant report completed successfully. Failed or uncollected queries are labeled rather than represented as empty results. An empty report is recorded as empty; the script does not add a self-entry or infer that a remote panel is healthy.

Different devices can expose different fields. The workbook uses the union of observed fields/suffixes within a group and preserves missing values rather than substituting zero. Multiword values, engineering units, statuses, priorities, and repeated/contextual report fields are retained. Unknown formats are not silently guessed.

## Collection and supported formats

The collector waits for a recognized prompt or a complete report before sending the next key. It resets to the main menu between report branches and discovers the FLN options advertised by that panel. Empty categories returning the known `not found` response are normal. A known failed panel query remains a failed row while collection continues only from its verified return menu.

The live preflight used a BACnet panel with a populated BACnet category and empty TEC and UC categories. Populated P1/TEC, P2/APOGEE, UC, Modbus, LON, and other integration formats are **not all live-validated**. The collector captures advertised options but stops with diagnostics when a menu or report format cannot be interpreted safely. Additional anonymized representative captures can extend the parser tests without guessing on a live controller.

## When collection stops

On an unexpected prompt, incomplete report, timeout, ambiguous identifier, parser failure, or export error, the console shows the stage and diagnostic-log path. No further menu keys are sent after a fatal collection error. A `.partial.json` file retains the completed portions when possible. An incomplete XLSX, if an export created one, is labeled `.xlsx.incomplete` and is not presented as a finished workbook.

The JSONL log includes ordered timestamps, navigation stages, expected prompts, returned report text, and failure context, with credential redaction. A normal empty category differs from a failed or uncollected report. Keep the log and JSON snapshot together when requesting help, after reviewing them for site-sensitive details.

## Development

Source is split into transport, parsing, collection, logging, workbook modeling, and export components. The standalone launcher embeds only the public runtime files and checks their embedded hashes before use. Customer captures do not belong in this repository.

```powershell
# From panel-point-report; automated network tests use loopback only.
$tests = @(Get-ChildItem .\tests\*.test.cjs | ForEach-Object { $_.FullName })
node --test @tests

# Rebuild the single-file launcher after runtime/template changes.
node build-standalone.cjs

# Test native XLSX export and standalone packaging using synthetic replay data.
.\tests\Run-ExportTests.ps1
```

The standalone build includes `cli.cjs`, public `.cjs` modules under `lib`, `Export-PanelWorkbook.ps1`, and `assets/workbook-template.xlsx`. Temporary runtime files are created in a unique directory and removed after the run. Reports remain in the PS1 folder.

Inspect and test changes against synthetic/replay data before another live controller test. Do not claim coverage of an unobserved report dialect merely because a menu option is detectable.
