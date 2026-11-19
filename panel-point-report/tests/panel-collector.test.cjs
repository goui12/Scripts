'use strict';

// Synthetic reports and credentials only. Every actual socket is loopback.
const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const { collectPanelReport } = require('../lib/panel-collector.cjs');

const USER = 'fixture-user';
const PASS = 'fixture-password';
const WELCOME = '\n>Time, Message, Cancel, Hello? ';
const INITIALS = '\n>Enter user initials           :  ';
const PASSWORD = '\n>Enter user password           :  ';
const ROOT = '\n>Point, Application, Time, Message, Cancel, System, passWord, Bye? ';
const POINT = '\n>Log, Display, Command, Edit, Operation, Monitor, Alarm, Trend, Quit? ';
const EDIT = '\n>Add, Modify, Copy, Delete, Look, Quit? ';
const NAME = '\n>Point name                    :  ';

function row(name, value = '12.5 DEG C', status = '-N-', priority = 'NONE') {
  return name.padEnd(45) + value.padEnd(17) + status.padEnd(8) + priority;
}

function listing(rows = [row('POINT1 (Synthetic temperature)')]) {
  return [
    '', '01/02/2003 THU                   POINT LOG REPORT                         12:34',
    '-'.repeat(79), '', 'Search for <*:>', '', 'Point name',
    '   :Suffix (Description)'.padEnd(45) + 'Value/State'.padEnd(17) + 'Status'.padEnd(8) + 'Priority',
    '-'.repeat(79), '', ...rows, '', 'End of report', '',
  ].join('\n');
}

function detail(point, additional = []) {
  return [
    point, '', '01/02/2003 THU                   POINT LOOK REPORT                        12:35',
    '-'.repeat(79), '', `Search for <${point.includes(':') ? point : point + ':'}>`, '',
    'Field                                      Value', '-'.repeat(79), '',
    'Point system name'.padEnd(30) + ': ' + point,
    'Point name'.padEnd(30) + ': ' + point,
    'Point type'.padEnd(30) + ': LAI',
    'Descriptor'.padEnd(30) + ': SYNTHETIC TEMPERATURE',
    'Value'.padEnd(30) + ': 12.5',
    ...additional, '', 'End of report', '',
  ].join('\n');
}

function stepsFor({ names = ['POINT1'], rows, direct = false, report, details = {}, login } = {}) {
  const steps = direct ? [] : [
    { input: '\r\n', output: WELCOME },
    { input: 'H', output: INITIALS },
  ];
  steps.push(
    { input: USER + '\r\n', output: PASSWORD },
    { input: PASS + '\r\n', output: login || `\n????????\nLogged on successfully Field panel <424242>\n${USER}\n${ROOT}` },
    { input: 'P', output: POINT },
    { input: 'L', output: NAME },
    { input: '\r\n', output: (report === undefined ? listing(rows) : report) + POINT },
  );
  for (const name of names) {
    steps.push(
      { input: 'E', output: EDIT },
      { input: 'L', output: NAME },
      { input: name + '\r\n', output: (details[name] || detail(name)) + EDIT },
      { input: 'Q', output: POINT },
    );
  }
  return steps;
}

async function scenario({ steps = stepsFor(), initial = '', options = {} } = {}, body) {
  const sockets = new Set();
  const commands = [];
  let stepIndex = 0;
  let connectionCount = 0;
  let unexpected = null;
  const server = net.createServer(socket => {
    connectionCount++;
    sockets.add(socket);
    socket.on('error', () => {});
    socket.on('close', () => sockets.delete(socket));
    let incoming = '';
    if (initial) socket.write(initial);
    socket.on('data', bytes => {
      incoming += bytes.toString('latin1');
      while (incoming.length) {
        const step = steps[stepIndex];
        if (!step || (incoming.length < step.input.length && !step.input.startsWith(incoming)) ||
            (incoming.length >= step.input.length && !incoming.startsWith(step.input))) {
          unexpected = 'Unexpected navigation sequence';
          socket.destroy();
          return;
        }
        if (incoming.length < step.input.length) return;
        incoming = incoming.slice(step.input.length);
        commands.push(step.input);
        stepIndex++;
        socket.write(step.output);
      }
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const settings = {
    host: '127.0.0.1', port: server.address().port,
    username: USER, password: PASS,
    timeoutMs: 500, reportTimeoutMs: 500, requestDelayMs: 0,
    ...options,
  };
  try {
    await body({
      collect: overrides => collectPanelReport({ ...settings, ...overrides }),
      commands,
      get connectionCount() { return connectionCount; },
      get completedSteps() { return stepIndex; },
      get unexpected() { return unexpected; },
    });
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => server.close(resolve));
  }
}

test('collects only non-colon points and retains subpoint observations without Look requests', async () => {
  const names = ['POINT1'];
  const rows = [row('POINT1 (Synthetic temperature)'), 'GROUP', row('  :Present Value', 'ON')];
  const steps = stepsFor({ names, rows });
  const progress = [];
  await scenario({ steps }, async state => {
    const result = await state.collect({ onProgress: event => progress.push(event) });
    assert.equal(state.unexpected, null);
    assert.equal(state.completedSteps, steps.length);
    assert.deepEqual(state.commands, steps.map(step => step.input));
    assert.equal(result.schemaVersion, 1);
    assert.equal(result.panelId, '424242');
    assert.deepEqual(result.points.map(point => point.point), names);
    assert.equal(result.points[0].value, 12.5);
    assert.equal(result.initialColonObservations.length, 1);
    assert.equal(result.initialColonObservations[0].point, 'GROUP:Present Value');
    assert.equal(result.initialColonObservations[0].value, 'ON');
    assert.equal(result.initialColonObservations[0].suffix, 'Present Value');
    assert.equal(Object.hasOwn(result.initialColonObservations[0], 'detail'), false);
    assert.equal(state.commands.some(command => command.includes(':')), false);
    assert.equal(progress.some(event => event.phase === 'detail' && event.point.includes(':')), false);
    assert.ok(result.listReport.endsWith('End of report\n'));
    assert.equal(result.points[0].detail.complete, true);
    assert.ok(Number.isFinite(Date.parse(result.points[0].detailCapturedAt)));
    assert.ok(Date.parse(result.completedAt) >= Date.parse(result.startedAt));
    assert.equal(Object.hasOwn(result, 'username'), false);
    assert.equal(Object.hasOwn(result, 'password'), false);
    assert.equal(JSON.stringify(result).includes(USER), false);
    assert.equal(JSON.stringify(result).includes(PASS), false);
    assert.equal(JSON.stringify(progress).includes(USER), false);
    assert.equal(JSON.stringify(progress).includes(PASS), false);
    assert.equal(progress.at(-1).phase, 'complete');
    assert.deepEqual(result.warnings, []);
  });
});

test('completes an all-colon listing with zero Look requests and preserves every observation', async () => {
  const rows = ['GROUP', row('  :Present Value', 'ON'), row('OTHER:Value', '0')];
  const steps = stepsFor({ names: [], rows });
  const progress = [];
  await scenario({ steps }, async state => {
    const result = await state.collect({ onProgress: event => progress.push(event) });
    assert.equal(state.unexpected, null);
    assert.equal(state.completedSteps, steps.length);
    assert.deepEqual(result.points, []);
    assert.deepEqual(result.initialColonObservations.map(point => point.point), ['GROUP:Present Value', 'OTHER:Value']);
    assert.equal(result.initialColonObservations[1].value, 0);
    assert.equal(state.commands.includes('E'), false);
    assert.equal(state.commands.some(command => command.includes(':')), false);
    assert.equal(progress.some(event => event.phase === 'detail'), false);
    assert.equal(progress.at(-1).phase, 'complete');
    assert.equal(progress.at(-1).total, 0);
    assert.deepEqual(result.warnings, []);
  });
});

test('accepts an immediate initials prompt without an empty login attempt', async () => {
  const steps = stepsFor({ direct: true });
  await scenario({ steps, initial: INITIALS }, async state => {
    const result = await state.collect();
    assert.equal(result.points.length, 1);
    assert.equal(state.commands[0], USER + '\r\n');
    assert.equal(state.commands.includes('H'), false);
    assert.equal(state.completedSteps, steps.length);
  });
});

test('stops on an unsupported point menu without sending another menu action', async () => {
  const steps = stepsFor();
  steps.find(step => step.input === 'P').output = '\n>Command, Delete, Quit? ';
  await scenario({ steps, options: { timeoutMs: 80 } }, async state => {
    await assert.rejects(state.collect(), error => {
      assert.equal(error.stage, 'point listing');
      assert.equal(error.code, 'COLLECTION_STOPPED');
      assert.equal(error.message.includes(USER), false);
      assert.equal(error.message.includes(PASS), false);
      assert.equal(error.cause, undefined);
      return true;
    });
    assert.equal(state.commands.at(-1), 'P');
    assert.equal(state.commands.includes('E'), false);
  });
});

test('stops rather than using an incomplete list or a non-standalone end marker', async () => {
  const report = listing().replace('End of report\n', 'Not the End of report yet\n');
  await scenario({ steps: stepsFor({ report }), options: { reportTimeoutMs: 80 } }, async state => {
    await assert.rejects(state.collect(), /point listing/);
    assert.equal(state.commands.includes('E'), false);
  });
});

test('rejects unknown list data lines before requesting any point details', async () => {
  const report = listing([row('POINT1'), 'UNKNOWN DATA THAT CANNOT BE PARSED']);
  await scenario({ steps: stepsFor({ report }) }, async state => {
    await assert.rejects(state.collect(), { code: 'UNPARSED_LIST_DATA' });
    assert.equal(state.commands.includes('E'), false);
  });
});

test('rejects a control-bearing point identifier without transmitting it', async () => {
  const malicious = 'GROUP:bad\tname';
  await scenario({ steps: stepsFor({ rows: [row(malicious)] }) }, async state => {
    await assert.rejects(state.collect(), { code: 'INVALID_INPUT' });
    assert.equal(state.commands.includes('E'), false);
    assert.equal(state.commands.some(command => command.includes(malicious)), false);
  });
});

test('rejects point search wildcards rather than expanding the lookup scope', async () => {
  await scenario({ steps: stepsFor({ rows: [row('POINT*')] }) }, async state => {
    await assert.rejects(state.collect(), { code: 'INVALID_POINT_NAME' });
    assert.equal(state.commands.includes('E'), false);
  });
});

test('deduplicates identical list rows but rejects conflicting duplicate observations', async () => {
  await scenario({ steps: stepsFor({ rows: [row('POINT1'), row('POINT1')] }) }, async state => {
    const result = await state.collect();
    assert.equal(result.points.length, 1);
    assert.ok(result.warnings.some(warning => /deduplicated/.test(warning)));
    assert.equal(state.commands.filter(command => command === 'E').length, 1);
  });
  await scenario({ steps: stepsFor({ rows: [row('POINT1', '1'), row('POINT1', '2')] }) }, async state => {
    await assert.rejects(state.collect(), { code: 'AMBIGUOUS_POINT' });
    assert.equal(state.commands.includes('E'), false);
  });
});

test('rejects a detail report identifying a different point', async () => {
  await scenario({ steps: stepsFor({ details: { POINT1: detail('OTHER_POINT') } }) }, async state => {
    await assert.rejects(state.collect(), { code: 'AMBIGUOUS_DETAIL' });
    assert.equal(state.commands.at(-1), 'POINT1\r\n');
    assert.equal(state.commands.includes('Q'), false);
  });
});

test('rejects duplicate identity fields instead of accepting a multi-match detail report', async () => {
  const duplicated = detail('POINT1', ['Point name'.padEnd(30) + ': POINT1']);
  await scenario({ steps: stepsFor({ details: { POINT1: duplicated } }) }, async state => {
    await assert.rejects(state.collect(), { code: 'AMBIGUOUS_DETAIL' });
    assert.equal(state.commands.includes('Q'), false);
  });
});

test('requires the edit menu after a detail report before sending Quit', async () => {
  const steps = stepsFor();
  steps.find(step => step.input === 'POINT1\r\n').output = detail('POINT1');
  await scenario({ steps, options: { timeoutMs: 80 } }, async state => {
    await assert.rejects(state.collect(), /point details/);
    assert.equal(state.commands.at(-1), 'POINT1\r\n');
    assert.equal(state.commands.includes('Q'), false);
  });
});

test('preserves unknown detail fields and unfamiliar lines with a warning', async () => {
  const additional = ['Future vendor field'.padEnd(30) + ': alpha beta', 'Unrecognized continuation retained'];
  await scenario({ steps: stepsFor({ details: { POINT1: detail('POINT1', additional) } }) }, async state => {
    const result = await state.collect();
    const parsed = result.points[0].detail;
    assert.ok(parsed.fields.some(field => field.field === 'Future vendor field' && field.value === 'alpha beta'));
    assert.ok(parsed.unparsedLines.some(line => line.raw === 'Unrecognized continuation retained'));
    assert.ok(result.warnings.some(warning => /1 detail lines/.test(warning)));
  });
});

test('rejects missing or conflicting panel identities after one login attempt', async () => {
  const login = `Logged on successfully Field panel <424242>\nField panel <888888>${ROOT}`;
  await scenario({ steps: stepsFor({ login }) }, async state => {
    await assert.rejects(state.collect(), { code: 'AMBIGUOUS_PANEL' });
    assert.equal(state.commands.filter(command => command === PASS + '\r\n').length, 1);
    assert.equal(state.commands.includes('P'), false);
  });
});

test('validates credentials, addresses, ports, and limits before connecting', async () => {
  await scenario({}, async state => {
    for (const options of [
      { username: 'bad\r\nvalue' }, { password: 'bad\x00value' },
      { username: '' }, { host: 'example.invalid' }, { host: '::1' },
      { port: 0 }, { port: 65536 }, { requestDelayMs: -1 },
      { timeoutMs: 0 }, { reportTimeoutMs: 0 }, { onProgress: true },
    ]) {
      await assert.rejects(state.collect(options), { code: 'INVALID_INPUT' });
    }
    assert.equal(state.connectionCount, 0);
    assert.equal(state.commands.length, 0);
  });
});

test('does not expose callback exception text or credentials through errors', async () => {
  await scenario({}, async state => {
    await assert.rejects(state.collect({ onProgress() { throw new Error(USER + PASS); } }), error => {
      assert.equal(error.message.includes(USER), false);
      assert.equal(error.message.includes(PASS), false);
      assert.equal(error.cause, undefined);
      return true;
    });
    assert.equal(state.connectionCount, 0);
  });
});
