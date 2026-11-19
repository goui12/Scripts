'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Readable } = require('node:stream');
const { run, readRequest, validateCompleteReport } = require('../cli.cjs');
const { build } = require('../build-standalone.cjs');

function directory(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'panel-cli-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function report() {
  return { schemaVersion: 2, status: 'complete', host: '192.0.2.10', points: [{ point: 'ROOM_TEMP', value: 0 }],
    drivers: [], panels: [], initialColonObservations: [], warnings: [] };
}
function fakeExporter({ outputPath }) {
  const bytes = Buffer.alloc(256); bytes.set([0x50,0x4b,0x03,0x04]);
  fs.writeFileSync(outputPath, bytes, { flag: 'wx' });
}
function dependencies(overrides = {}) {
  return { collect: async () => report(), createWorkbookModel: () => ({ sheets: [] }),
    exportWorkbook: fakeExporter, print() {}, ...overrides };
}

test('CLI saves complete snapshot, workbook and diagnostics in the requested directory', async t => {
  const outputDir = directory(t);
  const messages = [];
  let collectionRequest;
  const result = await run({ outputDir, host: '192.0.2.10', username: 'operator-example', password: 'secret-example' },
    dependencies({ print: value => messages.push(value), collect: async options => {
      collectionRequest = options;
      options.logger({ event: 'response', text: 'Ready' });
      options.onProgress({ phase: 'point', current: 1, total: 1, point: 'ROOM_TEMP' });
      return report();
    } }));
  assert.equal(result.status, 'complete');
  assert.equal(collectionRequest.username, 'operator-example');
  assert.equal(collectionRequest.password, 'secret-example');
  for (const key of ['workbook', 'data', 'log']) assert.equal(path.dirname(result.paths[key]), outputDir);
  const data = JSON.parse(fs.readFileSync(result.paths.data, 'utf8'));
  assert.deepEqual(data.workbookModel, { sheets: [] });
  assert.equal(data.points[0].value, 0);
  assert.equal(fs.existsSync(result.paths.partial), false);
  const outputs = messages.join('\n') + fs.readFileSync(result.paths.log, 'utf8') + fs.readFileSync(result.paths.data, 'utf8');
  assert.doesNotMatch(outputs, /operator-example|secret-example/);
  assert.match(outputs, /Diagnostic log:/);
});

test('collector failure preserves scrubbed partial context and never invokes exporter', async t => {
  const outputDir = directory(t);
  let exported = false;
  const result = await run({ outputDir, host: '192.0.2.10', username: 'operator-example', password: 'secret-example' }, dependencies({
    collect: async () => { throw Object.assign(new Error('Off-path secret-example'), {
      stage: 'BACnet subpoints', expected: 'Here, Printer:', partialResponse: 'Wrong: secret-example',
      partialResult: { schemaVersion: 2, status: 'incomplete', password: 'secret-example', points: [] },
    }); },
    exportWorkbook: async () => { exported = true; },
  }));
  assert.equal(result.status, 'failed');
  assert.equal(exported, false);
  assert.equal(fs.existsSync(result.paths.workbook), false);
  const partial = JSON.parse(fs.readFileSync(result.paths.partial, 'utf8'));
  assert.equal(partial.error.stage, 'BACnet subpoints');
  assert.equal(partial.error.expected, 'Here, Printer:');
  assert.equal(partial.report.password, '[REDACTED]');
  assert.doesNotMatch(fs.readFileSync(result.paths.log, 'utf8') + JSON.stringify(partial), /secret-example/);
});

test('a common credential never corrupts legitimate point or raw-report values', async t => {
  const outputDir = directory(t);
  const result = await run({ outputDir, host: '192.0.2.10', username: 'operator-example', password: 'ON' }, dependencies({
    collect: async options => {
      options.logger({ event: 'response', text: 'Login echo ON' });
      return { ...report(), points: [{ point: 'FAN', value: 'ON', detailReport: 'State : ON\nDevice Init Password : private-device-secret\n' }] };
    },
  }));
  const data = JSON.parse(fs.readFileSync(result.paths.data, 'utf8'));
  assert.equal(data.points[0].value, 'ON');
  assert.match(data.points[0].detailReport, /State : ON/);
  assert.doesNotMatch(data.points[0].detailReport, /private-device-secret/);
  assert.doesNotMatch(fs.readFileSync(result.paths.log, 'utf8'), /Login echo ON/);
});

test('export failure preserves data and labels a partial workbook incomplete', async t => {
  const outputDir = directory(t);
  const result = await run({ outputDir, host: '192.0.2.10' }, dependencies({ exportWorkbook: async options => {
    fs.writeFileSync(options.outputPath, 'unfinished'); throw new Error('Exporter stopped');
  } }));
  assert.equal(result.status, 'failed');
  assert.equal(result.error.stage, 'workbook export');
  assert.equal(fs.existsSync(result.paths.data), true);
  assert.equal(fs.existsSync(result.paths.workbook), false);
  assert.equal(fs.existsSync(result.paths.incompleteWorkbook), true);
  assert.match(result.paths.incompleteWorkbook, /\.xlsx\.incomplete$/);
});

test('replay creates a new workbook and never calls a network collector', async t => {
  const outputDir = directory(t);
  const source = path.join(outputDir, 'source.json');
  fs.writeFileSync(source, JSON.stringify(report()));
  const result = await run({ outputDir, replayJson: source }, dependencies({ collect: async () => { throw new Error('Must not connect'); } }));
  assert.equal(result.status, 'complete');
  assert.notEqual(result.paths.data, source);
  assert.deepEqual(JSON.parse(fs.readFileSync(source, 'utf8')), report());
});

test('incomplete and colon-containing replay datasets are rejected before export', async t => {
  const outputDir = directory(t);
  for (const data of [{ ...report(), status: 'failed' }, { ...report(), points: [{ point: 'DEVICE:TEMP' }] }]) {
    const source = path.join(outputDir, `source-${Math.random()}.json`); fs.writeFileSync(source, JSON.stringify(data));
    let exported = false;
    const result = await run({ outputDir, replayJson: source }, dependencies({ exportWorkbook: async () => { exported = true; } }));
    assert.equal(result.status, 'failed'); assert.equal(exported, false);
  }
});

test('repeated runs never overwrite prior output files', async t => {
  const outputDir = directory(t);
  const first = await run({ outputDir, host: '192.0.2.10' }, dependencies());
  const second = await run({ outputDir, host: '192.0.2.10' }, dependencies());
  assert.notEqual(first.paths.log, second.paths.log);
  assert.notEqual(first.paths.data, second.paths.data);
  assert.equal(fs.readdirSync(outputDir).length, 6);
});

test('fake successful export without an XLSX signature is rejected', async t => {
  const outputDir = directory(t);
  const result = await run({ outputDir, host: '192.0.2.10' }, dependencies({ exportWorkbook: async ({ outputPath }) => fs.writeFileSync(outputPath, 'x'.repeat(256)) }));
  assert.equal(result.status, 'failed');
  assert.equal(result.error.code, 'EXPORT_INVALID');
});

test('readRequest handles split UTF-8, BOM and input bounds without echoing content', async () => {
  const bytes = Buffer.from('\uFEFF{"username":"opérator"}', 'utf8');
  const chunks = Array.from(bytes, byte => Buffer.from([byte]));
  assert.deepEqual(await readRequest(Readable.from(chunks)), { username: 'opérator' });
  await assert.rejects(readRequest(Readable.from([Buffer.alloc(65537)])), /exceeds 64 KiB/);
});

test('valid reports must use schema 2 and separate panel points from colon observations', () => {
  assert.equal(validateCompleteReport(report()).status, 'complete');
  assert.equal(validateCompleteReport({ ...report(), status: 'complete-with-warnings' }).status, 'complete-with-warnings');
  assert.throws(() => validateCompleteReport({ ...report(), schemaVersion: 1 }), /schema-version-2/);
  assert.throws(() => validateCompleteReport({ ...report(), status: 'collecting' }), /schema-version-2/);
  assert.throws(() => validateCompleteReport({ ...report(), points: [{ point: 'DEVICE:TEMP' }] }), /colon-containing/);
});

test('completed reports with expected unavailable-query warnings still export', async t => {
  const outputDir = directory(t);
  const result = await run({ outputDir, host: '192.0.2.10' }, dependencies({
    collect: async () => ({ ...report(), status: 'complete-with-warnings', warnings: ['A listed panel did not return configuration.'] }),
  }));
  assert.equal(result.status, 'complete');
  assert.equal(result.report.status, 'complete-with-warnings');
  assert.equal(fs.existsSync(result.paths.workbook), true);
});

test('standalone bundle contains only allowlisted runtime paths with deterministic hashes', t => {
  const root = directory(t);
  fs.mkdirSync(path.join(root, 'lib')); fs.mkdirSync(path.join(root, 'assets')); fs.mkdirSync(path.join(root, 'captures'));
  for (const file of ['cli.cjs', 'Export-PanelWorkbook.ps1', 'assets/workbook-template.xlsx', 'lib/example.cjs']) fs.writeFileSync(path.join(root, file), 'runtime-data');
  fs.writeFileSync(path.join(root, 'captures', 'secret.txt'), 'not-public');
  fs.writeFileSync(path.join(root, 'launcher-template.ps1'), "@'\n__PAYLOAD_BASE64__\n'@\n");
  const first = build({ root }); const second = build({ root });
  assert.equal(first.sha256, second.sha256);
  const script = fs.readFileSync(first.output, 'utf8');
  const base64 = script.split(/\r?\n/).slice(1,-2).join('');
  const payload = JSON.parse(Buffer.from(base64, 'base64').toString('utf8'));
  assert.equal(payload.files.length, 4);
  assert.equal(payload.files.some(file => /captures|secret/.test(file.path)), false);
  assert.ok(payload.files.every(file => /^[0-9a-f]{64}$/.test(file.sha256)));
});
