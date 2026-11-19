'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createWorkbookModel, SHEET_NAMES, fieldMap } = require('../lib/workbook-model.cjs');
const { parsePointDetail } = require('../lib/report-parser.cjs');

// Code-only model tests. No spreadsheet library, device access or real site
// captures are used. Names and addresses below are synthetic documentation data.
function fixture() {
  return { panelId: '1234', nodeName: 'PANEL_A', host: '192.0.2.10',
    startedAt: '2030-01-02T12:00:00Z', completedAt: '2030-01-02T12:01:00Z',
    points: [{ point: 'TEMP', description: 'Temperature', value: 12.5, engineeringUnit: 'DEG C', status: '-N-', priority: 'NONE', detail: { fields: [] } }],
    drivers: [], panels: [], initialColonObservations: [], warnings: [] };
}
function device(name = 'UNIT_A', applicationNumber = '100') {
  return { name, applicationNumber, master: 'YES', applicationStatus: '-N-', instance: '5678', networkNumber: '7', mac: 'IP', status: '-N-', look: { status: 'complete', fields: [] } };
}
function subpoint(deviceName = 'UNIT_A', suffix = 'Temp', value = 12.5) {
  return { device: deviceName, parent: deviceName, point: `${deviceName}:${suffix}`, suffix,
    value, engineeringUnit: 'DEG C', status: '-N-', priority: 'NONE' };
}
function driver(name = 'BACnet', app = '100', nameOfDevice = 'UNIT_A') {
  return { name, key: name === 'BACnet' ? 'B' : 'T', status: 'complete',
    devices: [device(nameOfDevice, app)], subpoints: [subpoint(nameOfDevice)] };
}
function entry(ip = '192.0.2.10', udpPort = 47808, netmask = '255.255.255.0') { return { ip, udpPort, netmask }; }
function panel(selector = '1234', ip = '192.0.2.10', entries = []) {
  return { selector, local: selector === '1234', directoryState: 'OK Online Ready',
    configuration: { status: 'complete', complete: true, nodeName: `PANEL_${selector}`, protocol: 'BACnet', ip, udpPort: 47808, fields: [] },
    bdt: { status: 'complete', complete: true, entries } };
}
function sheet(model, name) { return model.sheets.find(s => s.name === name); }
function table(model, name) {
  for (const s of model.sheets) {
    const t = s.tables.find(t => t.name === name);
    if (t) return { ...t, sheet: s };
  }
  assert.fail(`Missing table ${name}`);
}
function dataRows(t) {
  const lookup = new Map(t.sheet.cells.map(c => [`${c.row},${c.col}`, c]));
  return Array.from({ length: t.endRow - t.startRow }, (_, i) =>
    t.headers.map((_, j) => lookup.get(`${t.startRow + i + 1},${t.startColumn + j}`)));
}
function values(t) { return dataRows(t).map(row => row.map(c => c.value)); }
function records(t) { return values(t).map(row => Object.fromEntries(t.headers.map((h, i) => [h, row[i]]))); }

test('workbook model has exactly the requested three sheets, panel titles and literal-data cells', () => {
  const r = fixture(); r.points[0].value = '=1+1';
  const model = createWorkbookModel(r);
  assert.deepEqual(model.sheets.map(s => s.name), ['Panel Points', 'Subpoints', 'Panel information']);
  assert.deepEqual(model.sheets.map(s => s.name), SHEET_NAMES);
  assert.ok(model.sheets.every(s => s.title.startsWith('PANEL_A')));
  assert.equal(records(table(model, 'PanelPoints'))[0].Value, '=1+1');
  assert.ok(model.sheets.flatMap(s => s.cells).every(c => !Object.hasOwn(c, 'formula')));
});

test('colon identifiers in Panel Points cause an explicit export failure', () => {
  const r = fixture(); r.points.push({ point: 'UNIT_A:Temp' });
  assert.throws(() => createWorkbookModel(r), /colon identifier/);
});

test('explicit blank Look fields stay blank while missing fields are marked Not provided', () => {
  const r = fixture();
  r.points[0].detail.fields = [{ field: 'Descriptor', value: '', occurrence: 1 }];
  r.points.push({ point: 'STATE', value: 'No Error', status: '-N-', priority: 'NONE', detail: { fields: [] } });
  const rows = records(table(createWorkbookModel(r), 'PanelPoints'));
  assert.equal(rows[0]['Look: Descriptor'], '');
  assert.equal(rows[1]['Look: Descriptor'], 'Not provided');
  assert.equal(rows[0].Value, 12.5);
  assert.equal(rows[1].Value, 'No Error');
});

test('point alarming fields export under their explicit alarm section rather than Access group(s)', () => {
  const r = fixture();
  r.points[0].detail = parsePointDetail([
    'Field          Value', 'Access group(s) : <all>', 'Point enabled for alarming',
    '   OFFNORMAL event : YES', '   Notification ID : 0', 'End of report',
  ].join('\n'));
  const t = table(createWorkbookModel(r), 'PanelPoints'), row = records(t)[0];
  assert.equal(row['Look: Point enabled for alarming'], 'YES');
  assert.equal(row['Look: Point enabled for alarming / OFFNORMAL event'], 'YES');
  assert.equal(row['Look: Point enabled for alarming / Notification ID'], '0');
  assert.ok(!t.headers.some(header => /Access group\(s\).*event|Access group\(s\).*Notification/.test(header)));
});

test('field mapping never overwrites a collision with a real bracket-suffixed field name', () => {
  const fields = [{ field: 'X', value: 'first' }, { field: 'X', value: 'second' }, { field: 'X [2]', value: 'third' }];
  const mapped = fieldMap({ fields });
  assert.equal(mapped.size, 3);
  assert.deepEqual([...mapped.values()], ['first', 'second', 'third']);
});

test('section contexts and explicit occurrences keep repeated fields separate', () => {
  const mapped = fieldMap({ fields: [
    { field: 'Status', value: 'A', context: 'Interface' },
    { field: 'Status', value: 'B', context: 'Application' },
    { field: 'Status', value: 'C', context: 'Application', occurrence: 2 },
  ] });
  assert.equal(mapped.size, 3);
  assert.equal(mapped.get('Interface / Status'), 'A');
  assert.equal(mapped.get('Application / Status / #2'), 'C');
});

test('model redaction covers secret fields without replacing explicit blank secrets', () => {
  const labels = ['Password', 'Secret', 'Token', 'Credential', 'Passphrase', 'Community string', 'Private key'];
  const fields = labels.map(field => ({ field, value: 'fixture-sensitive-value' }));
  fields.push({ field: 'Empty password', value: '' });
  const mapped = fieldMap({ fields });
  assert.deepEqual(labels.map(label => mapped.get(label)), labels.map(() => '[REDACTED]'));
  assert.equal(mapped.get('Empty password'), '');
  assert.ok(!JSON.stringify([...mapped]).includes('fixture-sensitive-value'));
});

test('device groups are separated by both driver and application, not application alone', () => {
  const r = fixture();
  r.drivers = [driver('BACnet', '100', 'UNIT_A'), driver('TEC', '100', 'UNIT_B'), driver('BACnet', '200', 'UNIT_C')];
  const model = createWorkbookModel(r);
  const groups = sheet(model, 'Subpoints').tables.filter(t => t.name.startsWith('SubpointsGroup'));
  assert.equal(groups.length, 3);
  assert.deepEqual(groups.map(t => records(table(model, t.name))[0]).map(row => [row.Driver, row.Application]), [
    ['BACnet', '100'], ['TEC', '100'], ['BACnet', '200'],
  ]);
});

test('same driver/application uses one device row each with unioned suffixes and explicit missing observations', () => {
  const r = fixture(), d = driver();
  d.devices.push(device('UNIT_B'));
  d.subpoints = [subpoint('UNIT_A', 'Temp', 0), subpoint('UNIT_B', 'Mode', 'No Error')];
  d.subpoints[1].engineeringUnit = null;
  r.drivers = [d];
  const rows = records(table(createWorkbookModel(r), 'SubpointsGroup1'));
  assert.equal(rows.length, 2);
  assert.equal(rows[0]['Temp Value'], 0);
  assert.equal(rows[0]['Mode Value'], 'Not observed');
  assert.equal(rows[1]['Temp Value'], 'Not observed');
  assert.equal(rows[1]['Mode Value'], 'No Error');
  assert.equal(rows[1]['Mode Unit'], '');
  assert.equal(rows[1]['Mode Status'], '-N-');
  assert.equal(rows[1]['Mode Priority'], 'NONE');
});

test('device Look fields precede subpoint columns and preserve blanks independently of absent fields', () => {
  const r = fixture(), d = driver();
  d.devices[0].look.fields = [{ field: 'Descriptor', value: '' }];
  d.devices.push(device('UNIT_B'));
  d.subpoints.push(subpoint('UNIT_B'));
  r.drivers = [d];
  const t = table(createWorkbookModel(r), 'SubpointsGroup1'), rows = records(t);
  assert.ok(t.headers.indexOf('Device Look: Descriptor') < t.headers.indexOf('Temp Value'));
  assert.equal(rows[0]['Device Look: Descriptor'], '');
  assert.equal(rows[1]['Device Look: Descriptor'], 'Not provided');
});

test('Other colon observations have their own section and are not assigned to an FLN application', () => {
  const r = fixture();
  r.initialColonObservations = [{ point: 'PANEL_A:Address', value: 1234, engineeringUnit: null, status: '-N-', priority: 'NONE' }];
  const model = createWorkbookModel(r), t = table(model, 'OtherColonObservations');
  assert.equal(t.sheet.name, 'Subpoints');
  assert.equal(records(t)[0].Point, 'PANEL_A:Address');
  assert.ok(!t.headers.includes('Application'));
  assert.equal(sheet(model, 'Subpoints').tables.filter(t => t.name.startsWith('SubpointsGroup')).length, 0);
});

test('duplicate subpoint observations are rejected rather than silently taking the last value', () => {
  const r = fixture(), d = driver(); d.subpoints.push(subpoint('UNIT_A', 'Temp', 99)); r.drivers = [d];
  assert.throws(() => createWorkbookModel(r), /duplicate subpoint/);
});

test('unjoined subpoint parents and empty suffixes are rejected', () => {
  const r = fixture(), d = driver(); d.subpoints[0].device = 'MISSING_DEVICE'; r.drivers = [d];
  assert.throws(() => createWorkbookModel(r), /parent is missing/);
  d.subpoints[0] = { device: 'UNIT_A', value: 1 };
  assert.throws(() => createWorkbookModel(r), /no suffix/);
});

test('BDT rows deduplicate the exact tuple while preserving distinct netmasks and UDP ports', () => {
  const r = fixture();
  r.panels = [panel('1234', '192.0.2.10', [entry(), entry(), entry('192.0.2.10', 47809), entry('192.0.2.10', 47808, '255.255.0.0')]),
    panel('5678', '192.0.2.20', [entry()])];
  const model = createWorkbookModel(r), t = table(model, 'BacnetDistributionTables');
  assert.deepEqual(t.headers, ['IP', 'Netmask', 'UDP Port', '1234', '5678']);
  assert.equal(values(t).length, 3);
  assert.deepEqual(values(t).map(row => row.slice(0, 3)), [
    ['192.0.2.10', '255.255.255.0', 47808], ['192.0.2.10', '255.255.255.0', 47809], ['192.0.2.10', '255.255.0.0', 47808],
  ]);
  assert.equal(records(table(model, 'BdtCollectionResults'))[0]['Returned entries'], 3);
});

test('green self-entry needs returned membership and the collected own IP plus UDP port', () => {
  const r = fixture();
  r.panels = [panel('1234', '192.0.2.10', [entry(), entry('192.0.2.10', 47809), entry('192.0.2.20')]),
    panel('5678', '192.0.2.20', [entry()])];
  const rows = dataRows(table(createWorkbookModel(r), 'BacnetDistributionTables'));
  assert.equal(rows[0][3].value, '✓'); assert.equal(rows[0][3].style, 'selfCheck');
  assert.equal(rows[1][3].style, 'check'); // Same IP, different UDP port.
  assert.equal(rows[2][3].style, 'check'); // Another device's address.
  assert.equal(rows[0][4].style, 'check'); // Same returned entry is not this panel's address.
  assert.equal(rows[2][4].value, ''); assert.equal(rows[2][4].style, 'body'); // Own IP not returned by that panel.
});

test('unknown own UDP port must not produce a green self-entry', () => {
  const r = fixture(), p = panel('1234', '192.0.2.10', [entry()]);
  delete p.configuration.udpPort; r.panels = [p];
  const model = createWorkbookModel(r), cell = dataRows(table(model, 'BacnetDistributionTables'))[0][3];
  assert.equal(cell.value, '✓'); assert.equal(cell.style, 'check');
  assert.notEqual(records(table(model, 'PanelInformation'))[0]['BDT self-entry'], 'Listed');
});

test('failed configuration does not turn separately successful BDT membership into confirmed health or green self-entry', () => {
  const r = fixture(), p = panel('1234', '192.0.2.10', [entry()]);
  p.configuration.status = 'unavailable'; p.configuration.error = { message: 'Destination node failed' };
  r.panels = [p];
  const model = createWorkbookModel(r), cell = dataRows(table(model, 'BacnetDistributionTables'))[0][3];
  assert.equal(cell.value, '✓'); assert.equal(cell.style, 'check');
  const row = records(table(model, 'PanelInformation'))[0];
  assert.match(row['Configuration result'], /unavailable.*Destination node failed/);
  assert.notEqual(row['BDT self-entry'], 'Listed');
});

test('failed BDT status overrides stale complete data and is not treated as an empty successful result', () => {
  const r = fixture(), failed = panel('5678', '192.0.2.20', [entry()]);
  failed.bdt.status = 'failed';
  r.panels = [panel('1234', '192.0.2.10', [entry()]), failed];
  const model = createWorkbookModel(r), cell = dataRows(table(model, 'BacnetDistributionTables'))[0][4];
  assert.equal(cell.value, 'Not collected'); assert.equal(cell.style, 'unavailable');
  assert.equal(records(table(model, 'BdtCollectionResults'))[1]['Returned entries'], 'Not collected');
});

test('valid empty BDT, failed query and unknown configuration are preserved independently without fake data rows', () => {
  const r = fixture(), local = panel('1234', '192.0.2.10', []), remote = panel('5678', '192.0.2.20', []);
  remote.configuration = { status: 'unavailable', fields: [] };
  remote.bdt = { status: 'unavailable', entries: [] };
  r.panels = [local, remote];
  const model = createWorkbookModel(r), matrix = table(model, 'BacnetDistributionTables');
  assert.equal(matrix.startRow, matrix.endRow);
  assert.deepEqual(values(matrix), []);
  const results = records(table(model, 'BdtCollectionResults'));
  assert.equal(results[0]['Returned entries'], 0);
  assert.equal(results[1]['Returned entries'], 'Not collected');
  const info = records(table(model, 'PanelInformation'));
  assert.equal(info[0]['BDT self-entry'], 'Not listed in returned report');
  assert.equal(info[1]['BDT self-entry'], 'Not collected');
});

test('APOGEE not-applicable panels do not become BDT instance columns', () => {
  const r = fixture(), p = panel('PANEL_B', '192.0.2.20', []);
  p.configuration.protocol = 'APOGEE'; p.bdt = { status: 'not-applicable', entries: [] };
  r.panels = [panel('1234', '192.0.2.10', []), p];
  const model = createWorkbookModel(r);
  assert.deepEqual(table(model, 'BacnetDistributionTables').headers, ['IP', 'Netmask', 'UDP Port', '1234']);
  assert.equal(values(table(model, 'BdtCollectionResults')).length, 1);
});

test('invalid BDT addresses and ports stop export rather than create plausible entries', () => {
  for (const bad of [entry('999.0.2.10'), entry('192.0.2.10', 70000), entry('192.0.2.10', 47808, 'bad')]) {
    const r = fixture(); r.panels = [panel('1234', '192.0.2.10', [bad])];
    assert.throws(() => createWorkbookModel(r), /invalid BDT entry/);
  }
});

test('table headers stay case-insensitively unique and within Excel header length limits', () => {
  const r = fixture();
  r.points[0].detail.fields = [{ field: 'NAME', value: 'upper' }, { field: 'name', value: 'lower' },
    { field: 'A'.repeat(300) + '1', value: 'one' }, { field: 'A'.repeat(300) + '2', value: 'two' }];
  const t = table(createWorkbookModel(r), 'PanelPoints');
  assert.equal(new Set(t.headers.map(h => h.toLowerCase())).size, t.headers.length);
  assert.ok(t.headers.every(h => h.length <= 255));
  assert.deepEqual(values(t)[0].slice(-4), ['upper', 'lower', 'one', 'two']);
});

test('Excel cell text and column limits cause explicit failures', () => {
  const long = fixture(); long.points[0].description = 'x'.repeat(32768);
  assert.throws(() => createWorkbookModel(long), /cell text limit/);
  const wide = fixture();
  wide.points[0].detail.fields = Array.from({ length: 16384 }, (_, i) => ({ field: `F${i}`, value: '' }));
  assert.throws(() => createWorkbookModel(wide), /column limit/);
});

test('all native tables are rectangular, uniquely named and nonoverlapping', () => {
  const r = fixture(); r.drivers = [driver()]; r.panels = [panel('1234', '192.0.2.10', [entry()])]; r.warnings = ['Synthetic warning'];
  const model = createWorkbookModel(r), names = [];
  for (const s of model.sheets) {
    for (const t of s.tables) {
      names.push(t.name);
      assert.equal(t.endColumn - t.startColumn + 1, t.headers.length);
      assert.ok(dataRows({ ...t, sheet: s }).every(row => row.every(Boolean)));
      for (const other of s.tables) if (t !== other) assert.ok(t.endRow < other.startRow || other.endRow < t.startRow);
    }
  }
  assert.equal(new Set(names.map(n => n.toLowerCase())).size, names.length);
});

test('merged note ranges are included in the sheet extent even with no device or point rows', () => {
  const r = fixture(); r.points = [];
  const model = createWorkbookModel(r);
  for (const s of model.sheets) {
    assert.ok(s.notes.every(n => n.lastColumn <= s.maxColumn && n.row <= s.maxRow));
  }
});
