#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

/** Reproducibly bundle only the explicit public runtime, never site captures. */
function build({ root = __dirname, output = path.join(root, 'PanelPointReport.ps1') } = {}) {
  const files = ['cli.cjs', 'Export-PanelWorkbook.ps1', 'assets/workbook-template.xlsx',
    ...fs.readdirSync(path.join(root, 'lib')).filter(name => /^[A-Za-z0-9_-]+\.cjs$/.test(name)).map(name => 'lib/' + name)].sort();
  const payload = { version: 1, files: files.map(relative => {
    const full = path.join(root, ...relative.split('/'));
    if (!fs.statSync(full).isFile()) throw new Error(`Required runtime file is missing: ${relative}`);
    const bytes = fs.readFileSync(full);
    return { path: relative, sha256: crypto.createHash('sha256').update(bytes).digest('hex'), base64: bytes.toString('base64') };
  }) };
  const template = fs.readFileSync(path.join(root, 'launcher-template.ps1'), 'utf8');
  if (template.split('__PAYLOAD_BASE64__').length !== 2) throw new Error('Launcher template must contain exactly one payload marker.');
  const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64').match(/.{1,120}/g).join('\n');
  const standalone = template.replace('__PAYLOAD_BASE64__', encoded).replace(/\r?\n/g, '\r\n');
  // Generated build artifact, not a manually maintained source file.
  fs.writeFileSync(output, standalone, 'utf8');
  return { output, bytes: Buffer.byteLength(standalone), files: files.length,
    sha256: crypto.createHash('sha256').update(standalone).digest('hex') };
}
if (require.main === module) {
  try { console.log(JSON.stringify(build(), null, 2)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = { build };
