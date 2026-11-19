'use strict';

const fs = require('node:fs');

const REDACTED = '[REDACTED]';
const PRIVATE_KEY = /^(?:password|passwd|passphrase|credential|credentials|secret|token|community|private[-_ ]?key|username|userinitials)$/i;
const PRIVATE_FIELD = /\b(?:password|passcode|passphrase|credential|secret|token|community|private[-_ ]?key)\b/i;

/** Scrub diagnostics and snapshots without executing or interpreting server text. */
function makeSanitizer({ secrets = [], maxStringChars = 2 * 1024 * 1024 } = {}) {
  const literals = [...new Set(secrets.filter(value => typeof value === 'string' && value.length))]
    .sort((a, b) => b.length - a.length);
  function text(value) {
    let result = String(value);
    for (const secret of literals) result = result.split(secret).join(REDACTED);
    // Preserve an explicitly blank password field, but never its value.
    result = result.replace(/^(.*\b(?:password|passcode|passphrase|credential|secret|token|community|private[-_ ]?key)\b[^:\r\n]*:)([^\r\n]*)$/gim,
      (whole, label, value) => value.trim() ? `${label} ${REDACTED}` : whole);
    if (result.length > maxStringChars) {
      const keep = Math.floor((maxStringChars - 100) / 2);
      result = result.slice(0, keep) + `\n[TRUNCATED ${result.length - keep * 2} CHARACTERS]\n` + result.slice(-keep);
    }
    return result;
  }
  function clean(value, seen = new WeakSet(), depth = 0) {
    if (value == null || typeof value === 'boolean' || typeof value === 'number') return value;
    if (typeof value === 'string') return text(value);
    if (typeof value === 'bigint') return String(value);
    if (typeof value !== 'object') return text(String(value));
    if (depth > 60) return '[MAXIMUM DIAGNOSTIC DEPTH]';
    if (seen.has(value)) return '[CIRCULAR]';
    seen.add(value);
    let output;
    if (value instanceof Error) {
      output = {};
      for (const key of ['name', 'message', 'code', 'stage', 'expected', 'partialResponse', 'stack']) {
        if (value[key] !== undefined) output[key] = clean(value[key], seen, depth + 1);
      }
    } else if (Array.isArray(value)) {
      output = value.map(item => clean(item, seen, depth + 1));
    } else {
      output = {};
      const privateField = typeof value.field === 'string' && PRIVATE_FIELD.test(value.field);
      for (const [key, item] of Object.entries(value)) {
        if (PRIVATE_KEY.test(key) || (privateField && ['value', 'originalValue'].includes(key))) {
          output[key] = item === '' || item === null ? item : REDACTED;
        } else {
          output[key] = clean(item, seen, depth + 1);
        }
      }
    }
    seen.delete(value);
    return output;
  }
  clean.text = text;
  return clean;
}

/** Exclusive-create, append-only log. A log I/O failure propagates and stops collection. */
function createDiagnosticLog(filename, options = {}) {
  const sanitize = makeSanitizer(options);
  const descriptor = fs.openSync(filename, 'wx', 0o600);
  let closed = false;
  let sequence = 0;
  const logger = event => {
    if (closed) throw new Error('Diagnostic log is already closed.');
    const record = sanitize({ ...event, at: new Date().toISOString(), sequence: ++sequence });
    fs.writeSync(descriptor, JSON.stringify(record) + '\n', null, 'utf8');
  };
  logger.close = () => {
    if (!closed) { closed = true; fs.closeSync(descriptor); }
  };
  logger.sanitize = sanitize;
  logger.path = filename;
  return logger;
}

module.exports = { createDiagnosticLog, makeSanitizer };
