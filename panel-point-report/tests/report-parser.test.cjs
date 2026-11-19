'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parsePointList, parsePointDetail } = require('../lib/report-parser.cjs');

// Synthetic fixtures only; do not put real customer names, addresses, equipment
// identifiers, report captures, or credentials in this public test file.

test('listing parses the supplied grammar with a numeric value and multiword unit', () => {
  const raw = 'POINT1 (Room Temp)     60.05 DEG F     -N-     NONE';
  const report = parsePointList(`${raw}\nEnd of report`);
  assert.equal(report.complete, true);
  assert.deepEqual(report.warnings, []);
  assert.deepEqual(report.unparsedLines, []);
  assert.deepEqual(report.points, [{
    point: 'POINT1', parent: null, suffix: null, description: 'Room Temp', value: 60.05,
    originalValue: '60.05 DEG F', engineeringUnit: 'DEG F',
    qualifier: null, status: '-N-', priority: 'NONE', raw, lineNumber: 1,
  }]);
});

test('zero, negatives, explicit signs, fractions, and exponents remain numeric', () => {
  const values = ['0', '-12.5', '+7', '.25', '-.25', '1e3'];
  const text = values.map((value, index) => `POINT${index} (Synthetic)     ${value}     -N-     NONE`).join('\n');
  const report = parsePointList(`${text}\nEnd of report`);
  assert.deepEqual(report.points.map(point => point.value), [0, -12.5, 7, 0.25, -0.25, 1000]);
  assert.deepEqual(report.points.map(point => point.engineeringUnit), values.map(() => null));
  assert.deepEqual(report.points.map(point => point.originalValue), values);
});

test('units with multiple words are retained and not normalized', () => {
  const report = parsePointList('POINT1 (Flow)     -2.5 cubic ft per min     ACTIVE     8\nEnd of report');
  assert.equal(report.points[0].value, -2.5);
  assert.equal(report.points[0].engineeringUnit, 'cubic ft per min');
  assert.equal(report.points[0].status, 'ACTIVE');
  assert.equal(report.points[0].priority, '8');
});

test('single-token binary and string values are preserved as strings', () => {
  const report = parsePointList([
    'POINT1 (Enable)     ON     -N-     NONE',
    'POINT2 (Mode)     AUTO     -N-     NONE',
    'End of report',
  ].join('\n'));
  assert.deepEqual(report.points.map(point => point.value), ['ON', 'AUTO']);
  assert.deepEqual(report.points.map(point => point.engineeringUnit), [null, null]);
  assert.deepEqual(report.warnings, []);
});

test('ambiguous nonnumeric value and unit columns remain intact and raise a warning', () => {
  const report = parsePointList('POINT1 (State)     NOT RUNNING STATE     -N-     NONE\nEnd of report');
  assert.equal(report.points[0].value, 'NOT RUNNING STATE');
  assert.equal(report.points[0].originalValue, 'NOT RUNNING STATE');
  assert.equal(report.points[0].engineeringUnit, null);
  assert.match(report.warnings[0], /Cannot confidently separate/);
});

test('numbers with locale-specific formatting are not guessed', () => {
  const report = parsePointList('POINT1 (Energy)     1,234.5 kWh     -N-     NONE\nEnd of report');
  assert.equal(report.points[0].value, '1,234.5 kWh');
  assert.equal(report.points[0].engineeringUnit, null);
  assert.match(report.warnings[0], /Cannot confidently separate/);
});

test('large integers, numeric overflow, and underflow are preserved without false precision', () => {
  const report = parsePointList([
    'POINT1 (Counter)     9007199254740993 count     -N-     NONE',
    'POINT2 (Counter)     1e999 count     -N-     NONE',
    'POINT3 (Small value)     1e-999 unit     -N-     NONE',
    'End of report',
  ].join('\n'));
  assert.deepEqual(report.points.map(point => point.value), ['9007199254740993', '1e999', '1e-999']);
  assert.deepEqual(report.points.map(point => point.engineeringUnit), ['count', 'count', 'unit']);
  assert.equal(report.warnings.length, 3);
  assert.match(report.warnings[0], /retained as text/);
});

test('duplicate point rows are retained and reported', () => {
  const report = parsePointList([
    'POINT1 (First observation)     0     -N-     NONE',
    'POINT1 (Second observation)     1     -N-     NONE',
    'End of report',
  ].join('\n'));
  assert.equal(report.points.length, 2);
  assert.deepEqual(report.points.map(point => point.value), [0, 1]);
  assert.match(report.warnings[0], /Duplicate point "POINT1" \(occurrence 2\)/);
});

test('a missing end marker is incomplete even when all available rows parse', () => {
  const report = parsePointList('POINT1 (Temp)     60.05 DEG F     -N-     NONE');
  assert.equal(report.points.length, 1);
  assert.equal(report.complete, false);
  assert.ok(report.warnings.some(warning => /incomplete/.test(warning)));
});

test('empty input is incomplete and an end marker without data does not invent points', () => {
  assert.equal(parsePointList('').complete, false);
  const report = parsePointList('End of report');
  assert.equal(report.complete, true);
  assert.deepEqual(report.points, []);
  assert.match(report.warnings[0], /without any recognized point rows/);
});

test('only a standalone end marker establishes completion', () => {
  const report = parsePointList('POINT1 (End of report)     1     -N-     NONE\nNot the End of report yet');
  assert.equal(report.complete, false);
  assert.equal(report.points.length, 1);
  assert.equal(report.unparsedLines[0].raw, 'Not the End of report yet');
});

test('unknown and malformed lines preserve source text and line numbers', () => {
  const lines = [
    'Point listing header',
    '',
    'POINT1 (Temperature)  12 DEG C  -N-',
    'POINT2 (Unclosed description  8  -N-  NONE',
    'End of report',
  ];
  const report = parsePointList(lines.join('\n'));
  assert.equal(report.complete, true);
  assert.equal(report.points.length, 0);
  assert.deepEqual(report.unparsedLines, [
    { lineNumber: 1, raw: lines[0] },
    { lineNumber: 3, raw: lines[2] },
    { lineNumber: 4, raw: lines[3] },
  ]);
  assert.ok(report.warnings.some(warning => /Point-looking row/.test(warning)));
});

test('tabs, CRLF, nested description parentheses, and source spacing are supported', () => {
  const raw = '  POINT1 (Room (North))\t0 DEG C\t-N-\tNONE';
  const report = parsePointList(`${raw}\r\n  End of report.  \r\n`);
  assert.equal(report.complete, true);
  assert.equal(report.points[0].description, 'Room (North)');
  assert.equal(report.points[0].raw, raw);
  assert.equal(report.points[0].value, 0);
});

test('content after the end marker is retained as unparsed, never added to the report', () => {
  const trailing = 'POINT2 (Unrelated)     99     -N-     NONE';
  const report = parsePointList(`POINT1 (Temp)     0     -N-     NONE\nEnd of report\n${trailing}`);
  assert.deepEqual(report.points.map(point => point.point), ['POINT1']);
  assert.deepEqual(report.unparsedLines, [{ lineNumber: 3, raw: trailing }]);
});

function listHeader() {
  return '   :Suffix (Description)'.padEnd(46) + 'Value/State'.padEnd(17) + 'Status'.padEnd(8) + 'Priority';
}

function listRow(name, value, status = '-N-', priority = 'NONE') {
  return name.padEnd(46) + value.padEnd(17) + status.padEnd(10) + priority.padEnd(6);
}

test('observed fixed-width layout reconstructs grouped suffixes and keeps parent/suffix columns', () => {
  const report = parsePointList([
    'POINT LOG REPORT', listHeader(), '-'.repeat(79), '',
    'DEMO_PANEL', listRow('  :Address', '12345'), '',
    'DEMO_LOGIC', listRow('  :PPCL Address', '0'), '',
    listRow('POINT1', 'OFF', '*F*', 'BN16'),
    listRow('POINT2 (Room Temp)', '60.05 DEG F'), '',
    'DEMO_INTERFACE', listRow('  :Temperature', '60.123 DEG F'),
    'End of report',
  ].join('\n'));
  assert.equal(report.complete, true);
  assert.deepEqual(report.warnings, []);
  assert.deepEqual(report.points.map(point => [point.point, point.parent, point.suffix]), [
    ['DEMO_PANEL:Address', 'DEMO_PANEL', 'Address'],
    ['DEMO_LOGIC:PPCL Address', 'DEMO_LOGIC', 'PPCL Address'],
    ['POINT1', null, null],
    ['POINT2', null, null],
    ['DEMO_INTERFACE:Temperature', 'DEMO_INTERFACE', 'Temperature'],
  ]);
  assert.equal(report.points[2].description, null);
  assert.equal(report.points[2].value, 'OFF');
  assert.equal(report.points[2].engineeringUnit, null);
  assert.equal(report.points[2].status, '*F*');
  assert.equal(report.points[3].description, 'Room Temp');
  assert.equal(report.unparsedLines.length, 3); // Title, column header, separator.
});

test('fixed-width qualified values keep the question-mark qualifier separate from numeric zero', () => {
  const report = parsePointList([
    listHeader(),
    listRow('POINT1 (Stage)', '? 0'),
    listRow('POINT2 (Timer)', '1.234e+07 secs'),
    'End of report',
  ].join('\n'));
  assert.equal(report.points[0].value, 0);
  assert.equal(report.points[0].qualifier, '?');
  assert.equal(report.points[0].originalValue, '? 0');
  assert.equal(report.points[0].engineeringUnit, null);
  assert.equal(report.points[1].value, 12340000);
  assert.equal(report.points[1].engineeringUnit, 'secs');
  assert.equal(report.points[1].qualifier, null);
  assert.deepEqual(report.warnings, []);
});

test('multiple suffixes can share an observed parent but never inherit through a standalone point', () => {
  const orphan = listRow('  :Unresolved', '1');
  const report = parsePointList([
    listHeader(), 'DEMO_PARENT', listRow('  :First', '1'), listRow('  :Second', '2'),
    listRow('POINT1', 'OFF'), orphan, 'End of report',
  ].join('\n'));
  assert.deepEqual(report.points.map(point => point.point), ['DEMO_PARENT:First', 'DEMO_PARENT:Second', 'POINT1']);
  assert.ok(report.unparsedLines.some(line => line.raw === orphan));
  assert.ok(report.warnings.some(warning => /no observed parent/.test(warning)));
});

test('duplicate grouped suffix rows remain visible and cause a duplicate warning', () => {
  const report = parsePointList([
    listHeader(), 'DEMO_PARENT', listRow('  :Value', '1'), listRow('  :Value', '2'), 'End of report',
  ].join('\n'));
  assert.equal(report.points.length, 2);
  assert.deepEqual(report.points.map(point => point.point), ['DEMO_PARENT:Value', 'DEMO_PARENT:Value']);
  assert.ok(report.warnings.some(warning => /Duplicate point/.test(warning)));
});

test('a fixed-width incomplete row is preserved without guessing its missing priority', () => {
  const partial = 'POINT1'.padEnd(46) + '0'.padEnd(17) + '-N-';
  const report = parsePointList(`${listHeader()}\n${partial}\nEnd of report`);
  assert.equal(report.points.length, 0);
  assert.ok(report.unparsedLines.some(line => line.raw === partial));
  assert.ok(report.warnings.some(warning => /Point-looking row/.test(warning)));
});

test('description-free loose rows and explicit complete suffix identifiers are supported', () => {
  const report = parsePointList('POINT1     OFF     -N-     NONE\nDEMO_PARENT:PPCL Address     0     -N-     NONE\nEnd of report');
  assert.deepEqual(report.points.map(point => point.point), ['POINT1', 'DEMO_PARENT:PPCL Address']);
  assert.equal(report.points[0].description, null);
  assert.equal(report.points[1].suffix, 'PPCL Address');
});

test('detail fallback retains every colon field in order without a fixed field list', () => {
  const report = parsePointDetail([
    'Point name: POINT1',
    'Description: Synthetic fixture',
    'Unknown future field: value: with another colon',
    'Blank optional field:',
    'End of report',
  ].join('\n'));
  assert.equal(report.complete, true);
  assert.deepEqual(report.fields.map(field => [field.field, field.value]), [
    ['Point name', 'POINT1'],
    ['Description', 'Synthetic fixture'],
    ['Unknown future field', 'value: with another colon'],
    ['Blank optional field', ''],
  ]);
  assert.deepEqual(report.unparsedLines, []);
});

test('detail duplicate keys preserve occurrence, raw text, and source order', () => {
  const raw = '  Priority : 8  ';
  const report = parsePointDetail(`Priority: NONE\n${raw}\nEnd of report`);
  assert.equal(report.fields.length, 2);
  assert.deepEqual(report.fields.map(field => field.occurrence), [1, 2]);
  assert.equal(report.fields[1].raw, raw);
  assert.equal(report.fields[1].lineNumber, 2);
  assert.equal(report.fields[1].value, '8');
  assert.equal(report.fields[1].context, null);
});

test('detail unsupported lines and continuations are preserved instead of guessed', () => {
  const report = parsePointDetail('Synthetic section\nField: first line\n  continuation text\n: no key\nEnd of report');
  assert.equal(report.fields.length, 1);
  assert.equal(report.fields[0].value, 'first line');
  assert.deepEqual(report.unparsedLines, [
    { lineNumber: 1, raw: 'Synthetic section' },
    { lineNumber: 3, raw: '  continuation text' },
    { lineNumber: 4, raw: ': no key' },
  ]);
});

test('detail parsing never implies completion without an explicit end marker', () => {
  const report = parsePointDetail('Point name: POINT1\nValue: 0');
  assert.equal(report.complete, false);
  assert.equal(report.fields.length, 2);
  assert.equal(report.fields[1].value, '0');
});

test('detail fields after the end marker are not merged into the finished report', () => {
  const report = parsePointDetail('Point name: POINT1\nEnd of report\nPoint name: POINT2');
  assert.equal(report.fields.length, 1);
  assert.deepEqual(report.unparsedLines, [{ lineNumber: 3, raw: 'Point name: POINT2' }]);
});

test('observed detail framing is not confused with fields and blank fields stay explicit', () => {
  const report = parsePointDetail([
    'DEMO_PARENT:POINT1',
    '01/02/2020 THU                   POINT LOOK REPORT                        08:09',
    'Search for <POINT1:>',
    'Field                                      Value',
    '-'.repeat(79),
    'Point system name             : POINT1',
    'Instance Number               : 7 (BAC_12345_AI_7)',
    'Access group(s)               : ',
    'Point address                 : 12345 0 00 03',
    '   HOA switch number          : Not defined',
    'Sensor type                   : Current',
    'End of report',
    '>Add, Modify, Copy, Delete, Look, Quit?',
  ].join('\n'));
  assert.equal(report.complete, true);
  assert.equal(report.fields.length, 6);
  assert.equal(report.fields[1].value, '7 (BAC_12345_AI_7)');
  assert.equal(report.fields[2].value, '');
  assert.equal(report.fields[4].field, 'HOA switch number');
  assert.equal(report.fields[4].context, 'Point address');
  assert.equal(report.fields[5].context, null);
  assert.ok(!report.fields.some(field => field.field.startsWith('Search for')));
  assert.equal(report.unparsedLines.length, 6);
});

test('structured detail indentation preserves context and repeated key occurrences', () => {
  const report = parsePointDetail([
    'Field          Value',
    'Address : First',
    '   State : ON',
    'Address : Second',
    '   State : OFF',
    'End of report',
  ].join('\n'));
  assert.deepEqual(report.fields.map(field => [field.field, field.occurrence, field.context]), [
    ['Address', 1, null], ['State', 1, 'Address'],
    ['Address', 2, null], ['State', 2, 'Address'],
  ]);
});

test('the exact enabled-alarming statement owns its event and notification fields', () => {
  const statement = 'Point enabled for alarming               ';
  const report = parsePointDetail([
    'Field                                      Value',
    'Access group(s)               : <all>', statement,
    '   OFFNORMAL event            : YES',
    '   NORMAL event               : NO',
    '   FAULT event                : YES',
    '   Notification ID            : 0',
    '   Alarm Message number       : 0',
    'Totalize                      : NO',
    'Point address                 : 1234 0 00 00',
    '   HOA switch number          : Not defined',
    'End of report',
  ].join('\n'));
  const enabled = report.fields.find(field => field.field === 'Point enabled for alarming');
  assert.equal(enabled.value, 'YES');
  assert.equal(enabled.raw, statement);
  assert.equal(enabled.context, null);
  assert.equal(enabled.lineNumber, 3);
  assert.deepEqual(report.fields.filter(field => /event$|Notification ID|Alarm Message number/.test(field.field)).map(field => field.context),
    Array(5).fill('Point enabled for alarming'));
  assert.equal(report.fields.find(field => field.field === 'Totalize').context, null);
  assert.equal(report.fields.find(field => field.field === 'HOA switch number').context, 'Point address');
  assert.ok(!report.unparsedLines.some(line => line.raw === statement));
});

test('unobserved alarming statement variants remain unknown and cannot inherit an unrelated field context', () => {
  for (const statement of ['Point disabled for alarming', 'Point Enabled for alarming', 'Point enabled for alarming?', 'Point enabled  for alarming']) {
    const report = parsePointDetail([
      'Field          Value', 'Access group(s) : <all>', statement,
      '   OFFNORMAL event : YES', 'End of report',
    ].join('\n'));
    assert.ok(report.unparsedLines.some(line => line.raw === statement));
    assert.ok(!report.fields.some(field => field.field === 'Point enabled for alarming'));
    assert.equal(report.fields.find(field => field.field === 'OFFNORMAL event').context, null);
  }
  const unframed = parsePointDetail('Point enabled for alarming\nEnd of report');
  assert.equal(unframed.fields.length, 0);
  assert.equal(unframed.unparsedLines[0].raw, 'Point enabled for alarming');
});

test('parsers reject non-string input instead of inventing a report', () => {
  for (const input of [null, undefined, 0, {}, Buffer.from('End of report')]) {
    assert.throws(() => parsePointList(input), TypeError);
    assert.throws(() => parsePointDetail(input), TypeError);
  }
});
