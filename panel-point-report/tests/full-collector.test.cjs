'use strict';

// All identities, reports, passwords and addresses below are synthetic.
// The only sockets used by these tests bind and connect to loopback.
const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const { collectFullPanelReport } = require('../lib/full-collector.cjs');

const USER = 'test-initials';
const PASS = 'test-only-password';
const P = {
  welcome: '\n>Time, Message, Cancel, Hello? ',
  initials: '\n>Enter user initials           : ',
  password: '\n>Enter user password           : ',
  root: '\n>Point, Application, Time, Message, Cancel, System, passWord, Bye? ',
  point: '\n>Log, Display, Command, Edit, Operation, Monitor, Alarm, Trend, Quit? ',
  edit: '\n>Add, Modify, Copy, Delete, Look, Quit? ',
  pointName: '\n>Point name                    : ',
  application: '\n>Ppcl, flNdevice, Quit? ',
  drivers: '\n>Bacnet, Tec, Uc, Quit? ',
  device: '\n>Log, Display, Edit, Initvalues, Quit? ',
  ucDevice: '\n>Log, Display, Edit, Quit? ',
  bacnetName: '\n>BACnet Device name            : ',
  tecName: '\n>TEC name                      : ',
  ucName: '\n>UC name                       : ',
  display: '\n>Definitions, Subpoints, deVice, Quit? ',
  applicationNumber: '\n>Application number           : ',
  subpointName: '\n>Subpoint name                 : ',
  output: '\n>Here, Printer                 : ',
  system: '\n>Diagnostics, Users, dSt, Bacnet, Error_msgs, Hardware, Text, Quit? ',
  hardware: '\n>Fieldpanels, Ethernet, nodeNametable, Disks, Reportprinter, Licensemanager, Quit? ',
  fieldpanels: '\n>Log, Display, Add, dElete, Modify, Config, Filesys, Quit? ',
  panel: '\n>Field panel                   : ',
  firstPanel: '\n>First field panel             : ',
  lastPanel: '\n>Last field panel              : ',
  ethernet: '\n>ipSettings, Bbmd, sNmp, Telnet, Webserver, ftpupLoad, Quit? ',
  bdt: '\n>Display, Edit, Quit? ',
  logout: '\n>Are you sure (Y/N)            : ',
};
function report(title, body) {
  return ['\n01/02/2003 THU    ' + title + '    12:34', '-'.repeat(79), '', ...body, '', 'End of report', ''].join('\n');
}
function field(name, value = '') { return name.padEnd(40) + ': ' + value; }
function pointRow(name, value = '12.5 DEG C', status = '-N-', priority = 'NONE') {
  return name.padEnd(45) + value.padEnd(18) + status.padEnd(8) + priority;
}
function pointList({ allColon = false } = {}) {
  return report('POINT LOG REPORT', [
    'Search for <*:>', 'Point name',
    '   :Suffix (Description)'.padEnd(45) + 'Value/State'.padEnd(18) + 'Status'.padEnd(8) + 'Priority',
    ...(allColon ? [] : [pointRow('TEMP1 (Synthetic temperature)')]),
    'LOCAL.PROGRAM', pointRow('   :Address', '0'),
  ]);
}
function pointDetail() {
  return report('POINT LOOK REPORT', ['Search for <TEMP1:>', 'Field                  Value',
    field('Point system name', 'TEMP1'), field('Point name', 'TEMP1'), field('Point type', 'LAI'), field('Value', '12.5'),
  ]);
}
function deviceList() {
  return report('BACnet LOG REPORT', [
    'Search for <*>', '"Field panel"', ' BACnet Device Name                    Application              Device',
    '                              Master  Number Status  Instance NetNum MAC Status',
    '"424242"', ' DEVICE1                        YES  10001  -N-       60001       1  IP   -N-',
  ]);
}
function deviceLook({ application = '10001', name = 'DEVICE1', secret = '' } = {}) {
  return report('BACnet LOOK REPORT', ['Search for <DEVICE1>', 'Field                  Value',
    field('Device system name', name), field('BACnet Device name', name), field('Application number', application),
    field('BACnet Device Instance Number', '60001'), field('Descriptor'), field('Device Init Password', secret),
  ]);
}
function subpoints({ device = 'DEVICE1' } = {}) {
  return report('BACnet SUBPOINT DISPLAY REPORT', [
    'Search for <*:*>', 'BACnet Device name',
    '   :Suffix (Description)                      Value            State   Priority',
    device, pointRow('   :TEMP', '12.5 DEG C'), pointRow('   :UPTIME', '1.2345e+06 secs'), pointRow('   :STATE', 'No Error'),
  ]);
}
function configuration({ apogee = false, instance = '424242', node = 'TESTPANEL' } = {}) {
  return report('FIELD PANEL CONFIGURATION REPORT', [
    field('Field panel address', instance), field('Firmware revision', apogee ? 'Synthetic P2 APOGEE 1.0' : 'Synthetic BACnet 1.0'),
    field('Node name', node), field('IP Address', '192.  0.  2. 10'), field('Netmask', '255.255.255.0'),
    field('Battery status', 'Alive'), field('DNS Suffix'), field('Network Type', apogee ? 'Ethernet APOGEE' : 'BACnet IP ALN: 1'),
    ...(apogee ? [] : ['BACnet Device Settings', field('  Device Instance Number', instance), field('  UDP Port', '47808')]),
  ]);
}
function directory(apogee = false) {
  return report('FIELD PANEL LOG REPORT', [' <"0" to "4194302">', ' Field panel                                State',
    '  <TESTBLN>', '    <TESTSITE>', '      ' + (apogee ? 'REMOTEPANEL' : '424243') + '                           FAILED Online Ready',
    '>     ' + (apogee ? 'TESTPANEL' : '424242') + '                        OK Online Ready',
  ]);
}
function bdt(instance, entries = []) {
  return report('BACnet BBMD Address Report', [`<${instance}>`, 'IP Address               Netmask                  UDP Port',
    ...entries.map(x => `${x.ip}             ${x.netmask}             ${x.udpPort}`),
  ]);
}
function stepsFor({ allColon = false, apogee = false, localEntries = [], deviceSecret = '', direct = false } = {}) {
  const steps = [];
  const add = (input, output, tag) => steps.push({ input, output, tag });
  if (!direct) add('H', P.initials, 'hello');
  add(USER + '\r\n', P.password, 'username');
  add(PASS + '\r\n', `\nLogged on successfully Field panel <${apogee ? 'TESTPANEL' : '424242'}>\nUser: ${USER}\n${P.root}`, 'password');
  add('P', P.point); add('L', P.pointName); add('\r\n', pointList({ allColon }) + P.point, 'point-list');
  if (!allColon) {
    add('E', P.edit); add('L', P.pointName); add('TEMP1\r\n', pointDetail() + P.edit, 'point-look'); add('Q', P.point);
  }
  const fln = () => { add('#', P.root); add('A', P.application); add('N', P.drivers, 'driver-menu'); };
  fln(); fln();
  add('B', P.device, 'bacnet-menu'); add('L', P.bacnetName); add('\r\n', deviceList() + P.device, 'device-list');
  add('E', P.edit); add('L', P.bacnetName); add('DEVICE1\r\n', deviceLook({ secret: deviceSecret }) + P.edit, 'device-look'); add('Q', P.device);
  add('D', P.display); add('S', P.bacnetName); add('\r\n', P.applicationNumber); add('\r\n', P.subpointName);
  add('\r\n', P.output, 'subpoint-destination'); add('H', subpoints() + P.display, 'subpoint-report');
  fln(); add('T', P.device); add('L', P.tecName); add('\r\n', '\nE3(0x0003) - not found\n' + P.device, 'tec-empty');
  fln(); add('U', P.ucDevice); add('L', P.ucName); add('\r\n', '\nE3(0x0003) - not found\n' + P.ucDevice, 'uc-empty');
  add('#', P.root); add('S', P.system); add('H', P.hardware); add('F', P.fieldpanels);
  add('D', P.output); add('H', P.panel); add('\r\n', configuration({ apogee }) + P.fieldpanels, 'local-info');
  add('L', P.firstPanel); add('\r\n', P.lastPanel); add('\r\n', directory(apogee) + P.fieldpanels, 'directory');
  add('D', P.output); add('H', P.panel);
  add((apogee ? 'REMOTEPANEL' : '424243') + '\r\n', '\nE57(0x0039) - Destination node failed\n' + P.fieldpanels, 'remote-info');
  if (!apogee) for (const instance of ['424243', '424242']) {
    add('#', P.root); add('S', P.system); add('H', P.hardware); add('E', P.ethernet); add('B', P.panel);
    add(instance + '\r\n', P.bdt, `bdt-select-${instance}`);
    add('D', bdt(instance, instance === '424242' ? localEntries : []) + P.bdt, `bdt-${instance}`);
  }
  add('#', P.root); add('B', P.logout, 'bye'); add('Y', P.welcome, 'logout-confirm');
  return steps;
}
async function scenario({ steps = stepsFor(), initial = P.welcome, options = {} } = {}, body) {
  const peers = new Set(), commands = [], logs = [], progress = [];
  let position = 0, unexpected = null, connections = 0;
  const server = net.createServer(socket => {
    connections++; peers.add(socket); socket.on('error', () => {}); socket.on('close', () => peers.delete(socket));
    if (initial) socket.write(initial);
    let incoming = '';
    socket.on('data', bytes => {
      incoming += bytes.toString('latin1');
      while (incoming.length) {
        const step = steps[position];
        if (!step || (incoming.length < step.input.length ? !step.input.startsWith(incoming) : !incoming.startsWith(step.input))) {
          unexpected = `Unexpected input at synthetic step ${position} (${step?.tag || step?.input || 'end'})`;
          socket.destroy(); return;
        }
        if (incoming.length < step.input.length) return;
        incoming = incoming.slice(step.input.length); commands.push(step.input); position++;
        if (step.fragments) {
          let fragment = 0;
          const writeFragment = () => {
            const chunk = step.fragments[fragment++];
            const last = fragment === step.fragments.length;
            if (last && step.end) socket.end(chunk);
            else socket.write(chunk);
            if (!last) setTimeout(writeFragment, 3);
          };
          writeFragment();
        } else if (step.end) socket.end(step.output);
        else socket.write(step.output);
      }
    });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  try {
    const defaults = { host: '127.0.0.1', port: server.address().port, username: USER, password: PASS,
      timeoutMs: 300, reportTimeoutMs: 300, requestDelayMs: 0, logger: event => logs.push(event), onProgress: event => progress.push(event), ...options };
    await body({ collect: overrides => collectFullPanelReport({ ...defaults, ...overrides }), commands, logs, progress,
      get position() { return position; }, get unexpected() { return unexpected; }, get connections() { return connections; } });
  } finally {
    for (const peer of peers) peer.destroy();
    await new Promise(resolve => server.close(resolve));
  }
}

test('collects one prompt-verified session, every advertised category, panel reports and independent empty BDT outcomes', async () => {
  const steps = stepsFor();
  await scenario({ steps }, async s => {
    const r = await s.collect();
    assert.equal(s.unexpected, null);
    assert.equal(s.position, steps.length);
    assert.equal(s.connections, 1);
    assert.equal(r.schemaVersion, 2);
    assert.equal(r.nodeName, 'TESTPANEL');
    assert.equal(r.points.length, 1); assert.equal(r.points[0].detail.fields.length, 4);
    assert.equal(r.initialColonObservations.length, 1);
    assert.equal(s.commands.some(command => command.includes('LOCAL.PROGRAM:')), false);
    assert.deepEqual(r.drivers.map(d => [d.name, d.status]), [['BACnet', 'complete'], ['TEC', 'empty'], ['UC', 'empty']]);
    assert.equal(r.drivers[0].devices[0].look.fields.find(f => f.field === 'Descriptor').value, '');
    assert.equal(r.drivers[0].subpoints.length, 3);
    assert.equal(r.drivers[0].subpoints[2].value, 'No Error');
    assert.ok(r.drivers[0].subpoints.every(p => p.applicationNumber === '10001'));
    assert.equal(r.panels.length, 2);
    const remote = r.panels.find(p => !p.local), local = r.panels.find(p => p.local);
    assert.equal(remote.configuration.status, 'unavailable'); assert.equal(remote.configuration.errorCode, 57);
    assert.equal(remote.bdt.status, 'complete'); assert.deepEqual(remote.bdt.entries, []);
    assert.equal(local.configuration.ip, '192.0.2.10'); assert.equal(local.bdt.selfEntryStatus, 'not-listed');
    assert.equal(r.status, 'complete-with-warnings');
    assert.equal(s.commands.at(-1), 'Y');
    const serialized = JSON.stringify({ r, logs: s.logs, progress: s.progress });
    assert.equal(serialized.includes(PASS), false); assert.equal(serialized.includes(USER), false);
  });
});

test('all-colon point list results in zero point Look requests while remaining report collection continues', async () => {
  const steps = stepsFor({ allColon: true });
  await scenario({ steps }, async s => {
    const r = await s.collect();
    assert.deepEqual(r.points, []);
    assert.equal(r.initialColonObservations.length, 1);
    assert.equal(s.commands.includes('TEMP1\r\n'), false);
    assert.equal(s.position, steps.length);
  });
});

test('accepts direct initials prompt without an empty login attempt or guessed key', async () => {
  const steps = stepsFor({ direct: true });
  await scenario({ steps, initial: P.initials }, async s => {
    await s.collect();
    assert.equal(s.commands[0], USER + '\r\n');
    assert.equal(s.position, steps.length);
  });
});

test('retains populated BDT entries and identifies a returned self IP without inventing entries', async () => {
  const entries = [{ ip: '192.0.2.10', netmask: '255.255.255.255', udpPort: 47808 }, { ip: '192.0.2.20', netmask: '255.255.255.0', udpPort: 47809 }];
  await scenario({ steps: stepsFor({ localEntries: entries }) }, async s => {
    const r = await s.collect();
    const b = r.panels.find(p => p.local).bdt;
    assert.equal(b.selfEntryStatus, 'listed'); assert.deepEqual(b.entries, entries);
  });
});

test('uses hostname panel selectors and marks BDT not applicable when configuration explicitly identifies APOGEE', async () => {
  const steps = stepsFor({ apogee: true });
  for (const step of steps) {
    if (step.output === P.system) step.output = '\n>Diagnostics, Users, dSt, Error_msgs, Hardware, Text, Quit? ';
    if (step.output === P.hardware) step.output = '\n>Fieldpanels, Ethernet, nodeNametable, Disks, Reportprinter, Quit? ';
    if (step.output === P.fieldpanels) step.output = '\n>Log, Display, Add, dElete, Modify, Config, Quit? ';
  }
  await scenario({ steps }, async s => {
    const r = await s.collect();
    assert.equal(r.panelId, 'TESTPANEL'); assert.equal(s.commands.includes('REMOTEPANEL\r\n'), true);
    assert.ok(r.panels.every(p => p.bdt.status === 'not-applicable'));
    assert.equal(s.position, steps.length);
  });
});

test('stops immediately on unexpected driver menu and logs actual prompt without sending a subsequent selection', async () => {
  const steps = stepsFor(); const target = steps.find(x => x.tag === 'bacnet-menu'); target.output = '\n>Initialize, Delete, Quit? ';
  await scenario({ steps }, async s => {
    await assert.rejects(s.collect(), e => {
      assert.equal(e.code, 'UNEXPECTED_MENU_ACTION'); assert.match(e.partialResponse, /Initialize/); assert.equal(e.partialResult.status, 'stopped');
      assert.equal(e.stage, 'FLN device list'); return true;
    });
    assert.equal(s.position, steps.indexOf(target) + 1); assert.equal(s.commands.at(-1), 'B');
  });
});

test('captures partial response on timeout before transport buffer clearing', async () => {
  const steps = stepsFor(); const target = steps.find(x => x.tag === 'point-look'); target.output = '\nUnfinished synthetic report\n';
  await scenario({ steps, options: { reportTimeoutMs: 70 } }, async s => {
    await assert.rejects(s.collect(), e => {
      assert.match(e.partialResponse, /Unfinished synthetic report/); assert.match(e.reason, /timeout/); return true;
    });
    assert.equal(s.position, steps.indexOf(target) + 1);
    assert.match(s.logs.findLast(x => x.event === 'error').partialResponse, /Unfinished synthetic report/);
  });
});

test('missing End of report never becomes a successful list even if a familiar menu follows', async () => {
  const steps = stepsFor(); const target = steps.find(x => x.tag === 'point-list'); target.output = target.output.replace('End of report\n', 'Not End of report yet\n');
  await scenario({ steps }, async s => {
    await assert.rejects(s.collect(), { code: 'INCOMPLETE_REPORT' });
    assert.equal(s.position, steps.indexOf(target) + 1);
  });
});

test('subpoints cannot be assigned to a device absent from the verified driver list', async () => {
  const steps = stepsFor(); steps.find(x => x.tag === 'subpoint-report').output = subpoints({ device: 'UNLISTED' }) + P.display;
  await scenario({ steps }, async s => {
    await assert.rejects(s.collect(), { code: 'UNLISTED_SUBPOINT_DEVICE' });
    assert.equal(s.commands.at(-1), 'H');
  });
});

test('mismatched application number stops before Quit or another report', async () => {
  const steps = stepsFor(); const target = steps.find(x => x.tag === 'device-look'); target.output = deviceLook({ application: '20002' }) + P.edit;
  await scenario({ steps }, async s => {
    await assert.rejects(s.collect(), { code: 'AMBIGUOUS_APPLICATION' });
    assert.equal(s.position, steps.indexOf(target) + 1);
  });
});

test('mismatched selected BBMD instance stops rather than attaching report to the wrong panel', async () => {
  const steps = stepsFor(); const target = steps.find(x => x.tag === 'bdt-424243'); target.output = bdt('999999') + P.bdt;
  await scenario({ steps }, async s => {
    await assert.rejects(s.collect(), { code: 'AMBIGUOUS_PANEL' });
    assert.equal(s.position, steps.indexOf(target) + 1);
  });
});

test('known BDT error is explicitly unavailable, never an empty successful table', async () => {
  const steps = stepsFor(); steps.find(x => x.tag === 'bdt-424243').output = '\nE57(0x0039) - Destination node failed\n' + P.bdt;
  await scenario({ steps }, async s => {
    const r = await s.collect();
    const b = r.panels.find(x => !x.local).bdt;
    assert.equal(b.status, 'unavailable'); assert.equal(b.errorCode, 57); assert.deepEqual(b.entries, []);
  });
});

test('unknown panel error does not continue navigation', async () => {
  const steps = stepsFor(); const target = steps.find(x => x.tag === 'remote-info'); target.output = '\nE99(0x0063) - synthetic unknown error\n' + P.fieldpanels;
  await scenario({ steps }, async s => {
    await assert.rejects(s.collect(), { code: 'PANEL_ERROR' }); assert.equal(s.position, steps.indexOf(target) + 1);
  });
});

test('device secret fields are redacted in logs, raw reports, parsed fields and returned data', async () => {
  await scenario({ steps: stepsFor({ deviceSecret: PASS }) }, async s => {
    const r = await s.collect();
    assert.equal(JSON.stringify({ r, logs: s.logs }).includes(PASS), false);
    assert.equal(r.drivers[0].devices[0].look.fields.find(x => x.field === 'Device Init Password').value, '[REDACTED]');
  });
});

test('a password equal to a legitimate measurement never changes collected data or partial report values', async () => {
  const steps = stepsFor();
  steps.find(x => x.tag === 'password').input = 'ON\r\n';
  const list = steps.find(x => x.tag === 'point-list');
  list.output = list.output.replace('12.5 DEG C'.padEnd(18), 'ON'.padEnd(18));
  const detail = steps.find(x => x.tag === 'point-look');
  detail.output = detail.output.replace(field('Value', '12.5'), field('Value', 'ON'));
  await scenario({ steps, options: { password: 'ON' } }, async s => {
    const r = await s.collect();
    assert.equal(r.points[0].value, 'ON');
    assert.equal(r.points[0].detail.fields.find(f => f.field === 'Value').value, 'ON');
    assert.match(r.listReport, /ON/);
  });
  steps.find(x => x.tag === 'bacnet-menu').output = '\n>Initialize, Delete, Quit? ';
  await scenario({ steps, options: { password: 'ON' } }, async s => {
    await assert.rejects(s.collect(), e => {
      assert.equal(e.partialResult.points[0].value, 'ON');
      assert.equal(e.partialResult.points[0].detail.fields.find(f => f.field === 'Value').value, 'ON');
      return true;
    });
  });
});

test('an advertised conflicting or changed required hotkey stops before the key is sent', async () => {
  const steps = stepsFor(); const target = steps.find(x => x.output === P.system);
  target.output = '\n>Diagnostics, Users, hardWare, Text, Quit? ';
  await scenario({ steps }, async s => {
    await assert.rejects(s.collect(), { code: 'UNEXPECTED_MENU_ACTION' });
    assert.equal(s.position, steps.indexOf(target) + 1);
    assert.equal(s.commands.at(-1), 'S');
  });
});

test('a misleading local marker cannot attach local configuration to another directory instance', async () => {
  const steps = stepsFor(); const target = steps.find(x => x.tag === 'directory');
  target.output = target.output.replace('>     424242', '>     424244');
  await scenario({ steps }, async s => {
    await assert.rejects(s.collect(), { code: 'AMBIGUOUS_PANEL' });
    assert.equal(s.position, steps.indexOf(target) + 1);
  });
});

test('failed login never logs credentials or actual login response, and is attempted only once', async () => {
  const steps = stepsFor(); const target = steps.find(x => x.tag === 'password'); target.output = `\n${USER} ${PASS} denied\n${P.initials}`;
  await scenario({ steps }, async s => {
    await assert.rejects(s.collect(), e => {
      assert.equal(e.partialResponse, '[AUTH REDACTED]'); assert.equal(JSON.stringify(e).includes(PASS), false); return true;
    });
    assert.equal(s.commands.filter(c => c === PASS + '\r\n').length, 1);
    assert.equal(JSON.stringify(s.logs).includes(PASS), false); assert.equal(JSON.stringify(s.logs).includes(USER), false);
    assert.equal(s.position, steps.indexOf(target) + 1);
  });
});

test('logout prompt mismatch retains partial result but sends no guessed confirmation', async () => {
  const steps = stepsFor(); const target = steps.find(x => x.tag === 'bye'); target.output = '\n>Unexpected setting            : ';
  await scenario({ steps }, async s => {
    await assert.rejects(s.collect(), e => { assert.equal(e.stage, 'logout'); assert.equal(e.partialResult.panels.length, 2); return true; });
    assert.equal(s.commands.at(-1), 'B'); assert.equal(s.commands.includes('Y'), false);
  });
});

test('verified Good Bye followed immediately by EOF completes logout successfully', async () => {
  const steps = stepsFor(); const target = steps.find(x => x.tag === 'logout-confirm');
  target.output = 'Y\r\nGood Bye\r\n'; target.end = true;
  await scenario({ steps }, async s => {
    const r = await s.collect();
    assert.equal(r.status, 'complete-with-warnings');
    assert.equal(s.position, steps.length); assert.equal(s.commands.at(-1), 'Y');
    assert.ok(s.logs.some(x => x.event === 'response' && /(?:^|\n)Good Bye\n/.test(x.text)));
    assert.equal(s.logs.some(x => x.event === 'error'), false);
  });
});

test('fragmented Good Bye and final-chunk EOF are recognized without accepting partial text', async () => {
  const steps = stepsFor(); const target = steps.find(x => x.tag === 'logout-confirm');
  target.fragments = ['Y\r\nGo', 'od B', 'ye\r\n']; target.end = true;
  await scenario({ steps }, async s => {
    const r = await s.collect();
    assert.equal(r.status, 'complete-with-warnings'); assert.equal(s.position, steps.length);
  });
});

test('an explicit direct Good Bye on Bye also completes without sending an unnecessary confirmation', async () => {
  const steps = stepsFor(); steps.pop();
  const target = steps.find(x => x.tag === 'bye'); target.output = '\nGood Bye\n'; target.end = true;
  await scenario({ steps }, async s => {
    const r = await s.collect();
    assert.equal(r.status, 'complete-with-warnings'); assert.equal(s.position, steps.length);
    assert.equal(s.commands.at(-1), 'B'); assert.equal(s.commands.includes('Y'), false);
  });
});

test('logout disconnect without the complete standalone Good Bye or welcome response remains a failure', async () => {
  for (const output of ['Y\n', 'Y\nGood B', 'Y\nNot Good Bye\n', 'Y\nGood Bye not confirmed\n']) {
    const steps = stepsFor(); const target = steps.find(x => x.tag === 'logout-confirm');
    target.output = output; target.end = true;
    await scenario({ steps }, async s => {
      await assert.rejects(s.collect(), e => {
        assert.equal(e.stage, 'logout'); assert.equal(e.partialResult.status, 'stopped');
        assert.match(e.reason, /closed/); return true;
      });
      assert.equal(s.commands.at(-1), 'Y');
      assert.equal(s.logs.some(x => x.event === 'complete'), false);
    });
  }
});

test('invalid inputs are rejected before connection and callback exception contents never escape', async () => {
  const base = { host: '127.0.0.1', username: USER, password: PASS };
  await assert.rejects(collectFullPanelReport({ ...base, host: 'example.invalid' }), { code: 'INVALID_INPUT' });
  await assert.rejects(collectFullPanelReport({ ...base, maxPoints: 0 }), { code: 'INVALID_INPUT' });
  await assert.rejects(collectFullPanelReport({ ...base, password: 'bad\ninput' }), { code: 'INVALID_INPUT' });
  await assert.rejects(collectFullPanelReport({ ...base, logger: () => { throw new Error(USER + PASS); } }), e => {
    assert.equal(e.code, 'LOGGER_FAILED'); assert.equal(e.message.includes(PASS), false); assert.equal(e.message.includes(USER), false); return true;
  });
});

test('global menu characters in a reported identifier are never transmitted as a Look name', async () => {
  const steps = stepsFor(); const target = steps.find(x => x.tag === 'point-list');
  target.output = target.output.replace('TEMP1 (Synthetic temperature)', 'TEM#1 (Synthetic temperature)');
  await scenario({ steps }, async s => {
    await assert.rejects(s.collect(), { code: 'INVALID_IDENTIFIER' });
    assert.equal(s.position, steps.indexOf(target) + 1);
    assert.equal(s.commands.some(x => x.startsWith('TEM#1')), false);
  });
});

test('a vanished named device retains listed metadata and a visible unavailable Look outcome', async () => {
  const steps = stepsFor(); steps.find(x => x.tag === 'device-look').output = '\nE3(0x0003) - not found\n' + P.edit;
  await scenario({ steps }, async s => {
    const r = await s.collect();
    assert.equal(r.drivers[0].devices[0].look.status, 'unavailable');
    assert.equal(r.drivers[0].devices[0].applicationNumber, '10001');
    assert.equal(r.drivers[0].subpoints.length, 3);
    assert.equal(s.position, steps.length);
  });
});
