'use strict';

// Synthetic replay fixtures only. Documentation-range IPs; no customer captures.
const fs = require('node:fs');
const path = require('node:path');

function field(field, value, context = []) { return { field, value, context, occurrence: 1 }; }
function point(point, value, engineeringUnit = '') {
  return { point, description: point === 'LITERAL' ? '=1+1' : 'Synthetic export test', value,
    originalValue: String(value), engineeringUnit, status: '-N-', priority: 'NONE', qualifier: '',
    detail: { complete: true, fields: [field('Point system name', point), field('Point name', point), field('Descriptor', '')] } };
}
function device(name, applicationNumber, instance, mac) {
  return { name, applicationNumber, master: 'YES', applicationStatus: '-N-', instance, networkNumber: '3', mac, status: '-N-',
    look: { status: 'complete', complete: true, fields: [field('Device system name', name), field('Descriptor', ''), field('Device Init Password', 'TEST-ONLY-SECRET')] } };
}
function subpoint(device, suffix, value, engineeringUnit = '', status = '-N-', priority = 'NONE') {
  return { device, parent: device, point: `${device}:${suffix}`, suffix, value, engineeringUnit, status, priority, qualifier: '' };
}
function configuration(selector, ip) {
  return { status: 'complete', complete: true, nodeName: `TEST_PANEL_${selector}`, instance: selector,
    protocol: 'BACnet', ip, udpPort: 47808,
    fields: [field('Node name', `TEST_PANEL_${selector}`), field('Firmware revision', 'SYNTHETIC BACnet'),
      field('IP address', ip), field('UDP port', '47808', ['BACnet IP ALN Settings']), field('Battery status', 'Alive')] };
}
function makePopulated() {
  const own = { ip: '192.0.2.10', netmask: '255.255.255.0', udpPort: 47808 };
  const shared = { ip: '192.0.2.20', netmask: '255.255.255.0', udpPort: 47808 };
  const distinctPort = { ip: '192.0.2.10', netmask: '255.255.255.0', udpPort: 47809 };
  return {
    schemaVersion: 2, status: 'complete-with-warnings', host: '192.0.2.10', port: 23,
    panelId: '1001', nodeName: 'SYNTHETIC_EXPORT_TEST', startedAt: '2026-01-01T12:00:00Z', completedAt: '2026-01-01T12:01:00Z',
    points: [point('ROOM_TEMP', 21.75, 'DEG C'), point('LITERAL', '=1+1'), point('ZERO', 0)],
    initialColonObservations: [point('TEST_PROGRAM:Address', 1001)],
    drivers: [
      { name: 'BACnet', key: 'B', status: 'complete',
        devices: [device('DEVICE_A', '7001', '20001', '192.0.2.50:BAC0'), device('DEVICE_B', '7001', '20002', '192.0.2.51:BAC0')],
        subpoints: [subpoint('DEVICE_A', 'TEMP', 21.75, 'DEG C'), subpoint('DEVICE_A', 'RUN', 'ON'),
          subpoint('DEVICE_B', 'TEMP', 22.5, 'DEG C', '*F*', 'BN16'), subpoint('DEVICE_B', 'RUN', 'OFF')] },
      { name: 'TEC', key: 'T', status: 'complete', devices: [device('TEC_DEVICE', '7001', '', '7')],
        subpoints: [subpoint('TEC_DEVICE', 'TEMP', 19.25, 'DEG C')] },
      { name: 'UC', key: 'U', status: 'empty', devices: [], subpoints: [] },
    ],
    panels: [
      { selector: '1001', local: true, protocol: 'BACnet', directoryState: 'OK Online Ready', configuration: configuration('1001', '192.0.2.10'),
        bdt: { status: 'complete', complete: true, entries: [own, shared, distinctPort, shared] } },
      { selector: '1002', local: false, protocol: 'BACnet', directoryState: 'OK Online Ready', configuration: configuration('1002', '192.0.2.20'),
        bdt: { status: 'complete', complete: true, entries: [own, shared] } },
      { selector: '1003', local: false, protocol: 'BACnet', directoryState: 'FAILED Online Ready',
        configuration: { status: 'unavailable', error: 'E57 - Destination node failed', fields: [] },
        bdt: { status: 'unavailable', error: 'Synthetic query failure', entries: [] } },
      { selector: '1004', local: false, protocol: 'BACnet', directoryState: 'OK Online Ready', configuration: configuration('1004', '192.0.2.40'),
        bdt: { status: 'complete', complete: true, entries: [] } },
    ],
    warnings: ['A synthetic remote configuration and BDT query were unavailable. This deliberately long warning verifies that the exported workbook retains readable wrapped text instead of clipping the collection outcome or pretending an unsuccessful query returned an empty list.'],
  };
}
function makeEmpty() {
  return {
    schemaVersion: 2, status: 'complete', host: '192.0.2.10', port: 23, panelId: '1001', nodeName: 'SYNTHETIC_EMPTY_TEST',
    startedAt: '2026-01-01T12:00:00Z', completedAt: '2026-01-01T12:01:00Z', points: [],
    initialColonObservations: [point('TEST_PROGRAM:Address', 1001)], drivers: [],
    panels: [{ selector: '1001', local: true, protocol: 'BACnet', directoryState: 'OK Online Ready',
      configuration: configuration('1001', '192.0.2.10'), bdt: { status: 'complete', complete: true, entries: [] } }], warnings: [],
  };
}
function writeFixtures(directory) {
  fs.mkdirSync(directory, { recursive: true });
  const result = {};
  for (const [name, data] of [['populated', makePopulated()], ['empty', makeEmpty()]]) {
    const filename = path.join(directory, `${name}.json`);
    fs.writeFileSync(filename, JSON.stringify(data, null, 2) + '\n', { flag: 'wx', encoding: 'utf8' });
    result[name] = filename;
  }
  return result;
}
if (require.main === module) {
  if (!process.argv[2]) throw new Error('Provide the disposable fixture output directory.');
  console.log(JSON.stringify(writeFixtures(path.resolve(process.argv[2]))));
}
module.exports = { makePopulated, makeEmpty, writeFixtures };
