'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { makeSanitizer, createDiagnosticLog } = require('../lib/diagnostic-log.cjs');

function directory(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'panel-log-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('sanitizer strips credential keys, literal secrets, and nonblank password field values', () => {
  const clean = makeSanitizer({ secrets: ['sample-secret', 'sample-user'] });
  const value = clean({ username: 'sample-user', password: 'sample-secret', response: 'echo sample-secret',
    fields: [{ field: 'Device Init Password', value: 'another-secret', raw: 'Device Init Password : another-secret' },
      { field: 'Device Init Password', value: '', raw: 'Device Init Password : ' },
      { field: 'Temperature', value: 0 }] });
  assert.equal(value.username, '[REDACTED]');
  assert.equal(value.password, '[REDACTED]');
  assert.equal(value.response, 'echo [REDACTED]');
  assert.equal(value.fields[0].value, '[REDACTED]');
  assert.equal(value.fields[0].raw, 'Device Init Password : [REDACTED]');
  assert.equal(value.fields[1].value, '');
  assert.equal(value.fields[2].value, 0);
  assert.doesNotMatch(JSON.stringify(value), /sample-secret|sample-user|another-secret/);
});

test('sanitizer retains false, zero, null, duplicate object references, and error context', () => {
  const clean = makeSanitizer();
  const shared = { value: 0, flag: false, missing: null };
  const error = Object.assign(new Error('Unexpected prompt'), { stage: 'device list', expected: 'End of report', partialResponse: 'actual prompt' });
  const value = clean({ a: shared, b: shared, error });
  assert.deepEqual(value.a, shared);
  assert.deepEqual(value.b, shared);
  assert.equal(value.error.stage, 'device list');
  assert.equal(value.error.partialResponse, 'actual prompt');
  assert.match(value.error.stack, /Unexpected prompt/);
});

test('report field redaction covers tokens, community strings and private keys without treating ordinary labels as secrets', () => {
  const clean = makeSanitizer();
  const fields = clean([
    { field: 'SNMP community', value: 'private-community', raw: 'SNMP community : private-community' },
    { field: 'API token', value: 'private-token', raw: 'API token : private-token' },
    { field: 'Private-key', value: 'private-key-value', raw: 'Private-key : private-key-value' },
    { field: 'Secretary room', value: 'ON', raw: 'Secretary room : ON' },
  ]);
  for (const field of fields.slice(0,3)) {
    assert.equal(field.value, '[REDACTED]'); assert.match(field.raw, /\[REDACTED\]/);
  }
  assert.equal(fields[3].value, 'ON'); assert.equal(fields[3].raw, 'Secretary room : ON');
});

test('sanitizer bounds long strings and circular structures', () => {
  const clean = makeSanitizer({ maxStringChars: 500 });
  const object = { message: 'start' + 'x'.repeat(1000) + 'finish' }; object.self = object;
  const value = clean(object);
  assert.match(value.message, /^start/);
  assert.match(value.message, /finish$/);
  assert.match(value.message, /TRUNCATED/);
  assert.ok(value.message.length <= 500);
  assert.equal(value.self, '[CIRCULAR]');
});

test('diagnostic log exclusively creates JSONL with sequence and timestamp and does not overwrite', t => {
  const filename = path.join(directory(t), 'run.log.jsonl');
  const logger = createDiagnosticLog(filename, { secrets: ['secret-example'] });
  logger({ event: 'step', expected: 'Name:' });
  logger({ event: 'error', partialResponse: 'secret-example', sequence: 999 });
  logger.close(); logger.close();
  const rows = fs.readFileSync(filename, 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(rows.map(row => row.sequence), [1, 2]);
  assert.match(rows[0].at, /^\d{4}-\d\d-\d\dT/);
  assert.equal(rows[1].partialResponse, '[REDACTED]');
  assert.throws(() => createDiagnosticLog(filename), /EEXIST/);
  assert.throws(() => logger({ event: 'late' }), /already closed/);
});
