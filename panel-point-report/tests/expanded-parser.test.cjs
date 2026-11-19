'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  discoverDrivers, parseDeviceList, parseDeviceLook, parseSubpoints,
  parsePanelDirectory, parsePanelInfo, parseBdt, normalizeIPv4,
} = require('../lib/expanded-parser.cjs');

// Synthetic, non-customer fixtures only. The IP ranges below are documentation
// addresses. Do not commit live panel captures or credentials to this project.
const deviceMenu = '>Log, Display, Edit, Initvalues, Quit?';
const editMenu = '>Add, Modify, Copy, Delete, Look, Quit?';
const subpointMenu = '>Definitions, Subpoints, deVice, Quit?';
const panelMenu = '>Log, Display, Add, dElete, Modify, Config, Filesys, Quit?';
const rule = '-'.repeat(79);
const title = name => `01/02/2030 WED                  ${name}                    12:34`;
function deviceReport(rows, ending = true) {
  return [title('BACnet LOG REPORT'), rule, 'Search for <*>', '"Field panel"',
    ' BACnet Device Name                    Application              Device',
    '                              Master  Number Status  Instance NetNum MAC Status', rule,
    '"1234"', ...rows, ...(ending ? ['End of report', deviceMenu] : [])].join('\n');
}
function lookReport(rows) {
  return ['UNIT_A', title('BACnet LOOK REPORT'), rule, 'Search for <UNIT_A>',
    'Field                                      Value', rule, ...rows,
    'End of report', editMenu].join('\n');
}
function subpointReport(rows, ending = true) {
  return ['H', title('BACnet SUBPOINT DISPLAY REPORT'), rule, 'Search for <*:*>',
    'BACnet Device name', '   :Suffix (Description)                      Value            State   Priority',
    rule, ...rows, ...(ending ? ['End of report', subpointMenu] : [])].join('\n');
}
function panelReport(rows, ending = true) {
  return [title('FIELD PANEL CONFIGURATION REPORT'), rule, ...rows,
    ...(ending ? ['End of report', panelMenu] : [])].join('\n');
}
function directoryReport(rows) {
  return [title('FIELD PANEL LOG REPORT'), rule, '<"0" to "4194302">',
    ' Field panel                                State', rule, ...rows, 'End of report', panelMenu].join('\n');
}
function bdtReport(rows, selector = '1234', ending = true) {
  return ['D', title('BACnet BBMD Address Report'), rule, `<${selector}>`,
    'IP Address               Netmask                  UDP Port', rule, ...rows,
    ...(ending ? ['End of report', '>Display, Edit, Quit?'] : [])].join('\n');
}

test('driver discovery preserves advertised known and unambiguous mixed-case hotkeys', () => {
  assert.deepEqual(discoverDrivers('N\n>Bacnet, Tec, Uc, Modbus, Lon, oPtion, Quit? '), [
    { name: 'BACnet', key: 'B' }, { name: 'TEC', key: 'T' }, { name: 'UC', key: 'U' },
    { name: 'Modbus', key: 'M' }, { name: 'LON', key: 'L' }, { name: 'oPtion', key: 'P' },
  ]);
});

test('driver discovery refuses unknown acronyms, ambiguous menus and repeated keys', () => {
  assert.throws(() => discoverDrivers('>Bacnet, XYZ, Quit?'), /unambiguous advertised hotkey/);
  assert.throws(() => discoverDrivers('>Bacnet, Bizarre, Quit?'), /repeats hotkey/);
  assert.throws(() => discoverDrivers('>Bacnet, Quit?\n>Tec, Quit?'), /one unambiguous/);
  assert.throws(() => discoverDrivers('>Bacnet, Quit'), /one unambiguous/);
});

test('explicit sole-uppercase hotkey takes precedence over a known driver default', () => {
  assert.deepEqual(discoverDrivers('>bAcnet, modBus, tEc, Quit?'), [
    { name: 'BACnet', key: 'A' }, { name: 'Modbus', key: 'B' }, { name: 'TEC', key: 'E' },
  ]);
  assert.throws(() => discoverDrivers('>Bacnet, modBus, Quit?'), /repeats hotkey/);
});

test('known acronym casing retains its established shortcut without guessing unknown acronyms', () => {
  assert.deepEqual(discoverDrivers('>BACnet, TEC, UC, MODBUS, LON, Quit?'), [
    { name: 'BACnet', key: 'B' }, { name: 'TEC', key: 'T' }, { name: 'UC', key: 'U' },
    { name: 'Modbus', key: 'M' }, { name: 'LON', key: 'L' },
  ]);
  assert.throws(() => discoverDrivers('>BACnet, XYZ, Quit?'), /unambiguous advertised hotkey/);
});

test('BACnet device list maps the observed packed, multiline headings without fixed-width truncation', () => {
  const r = parseDeviceList(deviceReport([' UNIT_A                       YES  12345  -N-       24680       7  IP   -N-']), { driver: 'BACnet' });
  assert.equal(r.complete, true);
  assert.equal(r.empty, false);
  assert.deepEqual(r.unparsedLines, []);
  assert.deepEqual(r.warnings, []);
  assert.deepEqual(Object.fromEntries(['name', 'applicationNumber', 'master', 'applicationStatus', 'instance', 'networkNumber', 'mac', 'status', 'fieldPanel'].map(k => [k, r.devices[0][k]])), {
    name: 'UNIT_A', applicationNumber: '12345', master: 'YES', applicationStatus: '-N-',
    instance: '24680', networkNumber: '7', mac: 'IP', status: '-N-', fieldPanel: '1234',
  });
  assert.equal(r.devices[0].fields.length, 8);
});

test('unfamiliar driver columns survive only when headers and rows share an explicit layout', () => {
  const text = [title('TEC LOG REPORT'), rule,
    'TEC name     FLN     Address     Application Number     Status',
    'UNIT_B       2       17          4321                   -N-', 'End of report', deviceMenu].join('\n');
  const r = parseDeviceList(text, { driver: 'TEC' });
  assert.equal(r.complete, true);
  assert.deepEqual(r.unparsedLines, []);
  assert.equal(r.devices[0].applicationNumber, '4321');
  assert.equal(r.devices[0].instance, null);
  assert.equal(r.devices[0].fields.find(f => f.field === 'Address').value, '17');
});

test('malformed device rows and unsupported headers remain unparsed', () => {
  const r = parseDeviceList(deviceReport([' UNIT_A YES 12345 -N- 24680 7 IP', 'New footer data  7']));
  assert.equal(r.devices.length, 0);
  assert.equal(r.unparsedLines.length, 2);
  assert.equal(r.empty, false);
  const unfamiliar = parseDeviceList(`${title('TEC LOG REPORT')}\nUnknown packed headings\nDATA\nEnd of report`);
  assert.equal(unfamiliar.complete, false);
  assert.equal(unfamiliar.unparsedLines.length, 2);
});

test('device list requires the requested title, headers and an explicit end marker', () => {
  assert.equal(parseDeviceList(deviceReport([], false)).complete, false);
  assert.equal(parseDeviceList(deviceReport([]), { driver: 'TEC' }).complete, false);
  assert.equal(parseDeviceList('End of report').complete, false);
  assert.equal(parseDeviceList(deviceReport([])).empty, true);
});

test('identical or conflicting duplicate device identifiers remain visible to callers', () => {
  const r = parseDeviceList(deviceReport(['UNIT_A YES 123 -N- 456 1 IP -N-', 'UNIT_A NO 124 -N- 457 1 IP *F*']));
  assert.equal(r.devices.length, 2);
  assert.match(r.warnings[0], /Duplicate device identifier/);
});

test('empty category requires E3 and its expected return menu', () => {
  for (const menu of [deviceMenu, '>Log, Display, Edit, Quit?']) {
    const r = parseDeviceList(`\nE3(0x0003) - not found\n${menu}`);
    assert.equal(r.complete, true); assert.equal(r.empty, true); assert.deepEqual(r.devices, []);
  }
  assert.equal(parseDeviceList('E3(0x0003) - not found').complete, false);
  assert.equal(parseDeviceList(`E3(0x0003) - not found\nUNEXPECTED\n${deviceMenu}`).complete, false);
  assert.equal(parseDeviceList(`E3(0x0003) - not found\n${editMenu}`).complete, false);
});

test('device Look retains every field, explicit blanks, duplicate keys and colon-containing values', () => {
  const r = parseDeviceLook(lookReport([
    'Device system name : UNIT_A', 'BACnet Device name : UNIT_A', 'Application number : 123',
    'Descriptor : ', 'BACnet Device Mac Address : 192.0.2.10:BAC0', 'Extra field : first', 'Extra field : second',
  ]));
  assert.equal(r.complete, true); assert.equal(r.name, 'UNIT_A'); assert.equal(r.applicationNumber, '123');
  assert.deepEqual(r.unparsedLines, []);
  assert.equal(r.fields.find(f => f.field === 'Descriptor').value, '');
  assert.equal(r.fields.find(f => f.field === 'BACnet Device Mac Address').value, '192.0.2.10:BAC0');
  assert.deepEqual(r.fields.filter(f => f.field === 'Extra field').map(f => f.occurrence), [1, 2]);
});

test('device Look redacts nonblank secrets from both values and raw lines but preserves explicit empty secrets', () => {
  const r = parseDeviceLook(lookReport(['Device Init Password : fixture-secret', 'Other Password : ', 'Community string : fixture-community']));
  assert.equal(r.fields[0].value, '[REDACTED]');
  assert.equal(r.fields[1].value, '');
  assert.equal(r.fields[2].value, '[REDACTED]');
  assert.ok(!JSON.stringify(r).includes('fixture-secret'));
  assert.ok(!JSON.stringify(r).includes('fixture-community'));
});

test('conflicting Look identities are not collapsed into one guessed name', () => {
  const r = parseDeviceLook(lookReport(['Device system name : UNIT_A', 'BACnet Device name : UNIT_B']));
  assert.equal(r.name, null);
  assert.equal(r.fields.length, 2);
});

test('unsupported Look lines remain visible and missing framing prevents completeness', () => {
  const r = parseDeviceLook(lookReport(['Unexpected continuation', 'Known field : value']));
  assert.equal(r.unparsedLines[0].raw, 'Unexpected continuation');
  assert.equal(parseDeviceLook('Known field : value\nEnd of report').complete, false);
  assert.equal(parseDeviceLook(`${title('BACnet LOOK REPORT')}\nKnown field : value\nEnd of report`).complete, false);
});

test('subpoint values are not truncated by the centered report header', () => {
  const raw = '   :RoomTemp                                 59.7203 DEG F      -N-     NONE';
  const r = parseSubpoints(subpointReport(['UNIT_A', raw]));
  assert.equal(r.complete, true); assert.deepEqual(r.unparsedLines, []);
  assert.equal(r.subpoints[0].device, 'UNIT_A');
  assert.equal(r.subpoints[0].point, 'UNIT_A:RoomTemp');
  assert.equal(r.subpoints[0].suffix, 'RoomTemp');
  assert.equal(r.subpoints[0].value, 59.7203);
  assert.equal(r.subpoints[0].engineeringUnit, 'DEG F');
  assert.equal(r.subpoints[0].raw, raw);
});

test('subpoints retain scientific values, multiword text, descriptions, qualifiers and fault/priority states', () => {
  const r = parseSubpoints(subpointReport(['UNIT_A',
    ' :Counter (Elapsed (seconds))    1.234e+09 secs    *F*    BN16',
    ' :Error    No Error    -N-    NONE',
    ' :Qualified    ? 0 DEG C    *F*    NONE',
  ]));
  assert.deepEqual(r.subpoints.map(p => p.value), [1234000000, 'No Error', 0]);
  assert.equal(r.subpoints[0].description, 'Elapsed (seconds)');
  assert.equal(r.subpoints[0].status, '*F*'); assert.equal(r.subpoints[0].priority, 'BN16');
  assert.equal(r.subpoints[1].engineeringUnit, null);
  assert.equal(r.subpoints[2].qualifier, '?');
  assert.equal(r.warnings.length, 1);
});

test('subpoint device blocks join each suffix only to its observed parent', () => {
  const r = parseSubpoints(subpointReport(['UNIT_A', ' :Temp    12 DEG C    -N-    NONE', 'UNIT_B', ' :Temp    13 DEG C    -N-    NONE']));
  assert.deepEqual(r.subpoints.map(p => p.point), ['UNIT_A:Temp', 'UNIT_B:Temp']);
  assert.deepEqual(r.unparsedLines, []);
});

test('missing-parent, malformed and non-colon subpoint rows are not guessed', () => {
  const r = parseSubpoints(subpointReport([' :Temp    12 DEG C    -N-    NONE',
    'LOCAL_POINT    12 DEG C    -N-    NONE', ' :Malformed    12 DEG C    -N-']));
  assert.equal(r.subpoints.length, 0);
  assert.equal(r.unparsedLines.length, 3);
  assert.equal(r.empty, false);
});

test('subpoint empty and incomplete outcomes stay distinct', () => {
  assert.equal(parseSubpoints(subpointReport([])).empty, true);
  assert.equal(parseSubpoints(subpointReport([], false)).complete, false);
  assert.equal(parseSubpoints(`E3(0x0003) - not found\n${subpointMenu}`).empty, true);
  assert.equal(parseSubpoints('End of report').complete, false);
});

test('data after report completion is not appended to captured subpoints', () => {
  const r = parseSubpoints(`${subpointReport(['UNIT_A', ' :Temp    12 DEG C    -N-    NONE'])}\nUNIT_A:Extra    1    -N-    NONE`);
  assert.equal(r.subpoints.length, 1);
  assert.equal(r.unparsedLines.length, 1);
});

test('panel directory preserves complete state text and local marker without inventing state columns', () => {
  const r = parsePanelDirectory(directoryReport(['  <TESTBLN>', '    <SITE>',
    '      4567                           FAILED Online  Ready',
    '>     1234                           OK     Online  Ready']));
  assert.equal(r.complete, true); assert.deepEqual(r.unparsedLines, []);
  assert.equal(r.panels[0].directoryState, 'FAILED Online  Ready');
  assert.equal(r.panels[1].local, true); assert.equal(r.panels[1].selector, '1234');
  assert.equal(r.panels[1].instance, '1234'); assert.equal(r.panels[1].name, null);
  assert.deepEqual(r.panels[1].scope, ['TESTBLN', 'SITE']);
});

test('hostname directory selectors remain names rather than fabricated BACnet instances', () => {
  const r = parsePanelDirectory(directoryReport(['>     PANEL_A                        OK     Online  Ready']));
  assert.equal(r.panels[0].selector, 'PANEL_A');
  assert.equal(r.panels[0].name, 'PANEL_A'); assert.equal(r.panels[0].instance, null);
});

test('panel directory reports unknown lines, duplicates and multiple local markers', () => {
  const r = parsePanelDirectory(directoryReport(['> 1234   OK', '> 1234   FAILED', 'Unsupported footer']));
  assert.equal(r.panels.length, 2);
  assert.equal(r.warnings.length, 2);
  assert.equal(r.unparsedLines[0].raw, 'Unsupported footer');
});

test('panel information preserves all fields, section contexts, blanks and multiline notes', () => {
  const r = parsePanelInfo(panelReport([
    'Field panel address : 1234', 'Firmware revision : TEST V1.0 BACnet',
    'Network Type : BACnet IP ALN: 7 (Alnnode)', 'Node name : PANEL_A', 'DNS Suffix : ',
    '  IP Address : 192.  0.  2. 10', 'MAC Address : 00:00:5E:00:53:01',
    'BACnet Device Settings', '  Device Instance Number : 1234', '  Description : Test device',
    'BACnet IP ALN Settings : Enabled', '  UDP Port : 47808', '  Description : Test network',
    'BACnet MSTP ALN Settings : Disabled', '  (Note This is the first part,', '   followed by the second part)',
    'FLN Settings', '  Fln Type : P1',
  ]));
  assert.equal(r.complete, true); assert.deepEqual(r.unparsedLines, []);
  assert.equal(r.protocol, 'BACnet'); assert.equal(r.nodeName, 'PANEL_A'); assert.equal(r.instance, '1234');
  assert.equal(r.ip, '192.0.2.10'); assert.equal(r.udpPort, 47808);
  assert.equal(r.fields.find(f => f.field === 'DNS Suffix').value, '');
  assert.equal(r.fields.find(f => f.field === 'Network Type').value, 'BACnet IP ALN: 7 (Alnnode)');
  assert.deepEqual(r.fields.filter(f => f.field === 'Description').map(f => f.context), ['BACnet Device Settings', 'BACnet IP ALN Settings']);
  assert.equal(r.fields.find(f => f.field === 'Note').context, 'BACnet MSTP ALN Settings');
  assert.match(r.fields.find(f => f.field === 'Note').value, /second part\)$/);
});

test('explicit APOGEE firmware uses hostname and does not turn its address into a BACnet instance', () => {
  const r = parsePanelInfo(panelReport(['Field panel address : 17', 'Firmware revision : Test Ethernet-APOGEE V1', 'Node name : PANEL_B']));
  assert.equal(r.protocol, 'APOGEE'); assert.equal(r.nodeName, 'PANEL_B'); assert.equal(r.instance, null);
});

test('unknown or contradictory panel protocol indicators are not guessed', () => {
  assert.equal(parsePanelInfo(panelReport(['Firmware revision : Unknown'])).protocol, null);
  const r = parsePanelInfo(panelReport(['Firmware revision : Test BACnet', 'Network Type : P2']));
  assert.equal(r.protocol, null); assert.match(r.warnings[0], /conflicting/);
});

test('incomplete notes and unexpected panel data remain unparsed', () => {
  const r = parsePanelInfo(panelReport(['Odd report row', '(Note Not finished', 'Continuation']));
  assert.equal(r.unparsedLines.length, 3);
  assert.equal(r.fields.length, 0);
  assert.equal(parsePanelInfo(panelReport(['Known field : value'], false)).complete, false);
});

test('panel canonical addresses reject invalid octets and preserve raw fields', () => {
  const r = parsePanelInfo(panelReport(['IP Address : 999.1.2.3', 'UDP Port : 70000']));
  assert.equal(r.ip, null); assert.equal(r.udpPort, null);
  assert.equal(r.warnings.length, 2);
  assert.equal(r.fields[0].value, '999.1.2.3');
});

test('BDT accepts a complete empty selected-instance report without inventing a self-entry', () => {
  const r = parseBdt(bdtReport([]));
  assert.equal(r.complete, true); assert.deepEqual(r.entries, []);
  assert.equal(r.instance, '1234'); assert.equal(r.panelSelector, '1234');
  assert.deepEqual(r.unparsedLines, []);
});

test('BDT normalizes padded addresses and deduplicates only the exact IP/netmask/port tuple', () => {
  const r = parseBdt(bdtReport([
    '192.  0.  2. 10    255.255.255.  0    47808',
    '192.0.2.10        255.255.255.0       47808',
    '192.0.2.10        255.255.255.0       47809',
    '192.0.2.10        255.255.0.0         0xBAC0',
  ]));
  assert.equal(r.entries.length, 3); assert.equal(r.warnings.length, 1);
  assert.deepEqual(r.entries[0], { ip: '192.0.2.10', netmask: '255.255.255.0', udpPort: 47808 });
  assert.equal(r.entries[1].udpPort, 47809);
  assert.equal(r.entries[2].netmask, '255.255.0.0');
});

test('BDT malformed data and conflicting selected-instance labels remain unparsed', () => {
  const r = parseBdt(bdtReport(['999.0.2.10  255.255.255.0  47808', '192.0.2.10  255.255.255.0  BAC0', '<5678>']));
  assert.equal(r.entries.length, 0); assert.equal(r.unparsedLines.length, 3);
});

test('BDT requires its title, selected-panel identity, headings and explicit end marker', () => {
  assert.equal(parseBdt(bdtReport([], '1234', false)).complete, false);
  assert.equal(parseBdt('End of report').complete, false);
  assert.equal(parseBdt(bdtReport([]).replace('<1234>', '')).complete, false);
  assert.equal(parseBdt(bdtReport([]).replace('IP Address               Netmask                  UDP Port', '')).complete, false);
});

test('IPv4 normalization rejects ambiguous or non-IPv4 text', () => {
  assert.equal(normalizeIPv4(' 192. 000. 002.010 '), '192.0.2.10');
  for (const value of ['192.0.2', '192.0.2.256', '1.2.3.4:47808', '::1', '1.2.3.-1', null]) assert.equal(normalizeIPv4(value), null);
});

test('all parser entry points reject non-string reports', () => {
  for (const fn of [discoverDrivers, parseDeviceList, parseDeviceLook, parseSubpoints, parsePanelDirectory, parsePanelInfo, parseBdt]) assert.throws(() => fn(null), TypeError);
});
