#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { StringDecoder } = require('node:string_decoder');
const { spawn } = require('node:child_process');
const { createDiagnosticLog, makeSanitizer } = require('./lib/diagnostic-log.cjs');

const VERSION = '0.2.0';
const MAX_SNAPSHOT_BYTES = 128 * 1024 * 1024;

function problem(message, code = 'INVALID_REQUEST') {
  const error = new Error(message); error.code = code; return error;
}

function readJson(filename) {
  if (fs.statSync(filename).size > MAX_SNAPSHOT_BYTES) throw problem('Replay snapshot exceeds 128 MiB.');
  const value = JSON.parse(fs.readFileSync(filename, 'utf8').replace(/^\uFEFF/, ''));
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw problem('Snapshot must contain a JSON object.');
  return value;
}

function validateCompleteReport(report) {
  if (!report || typeof report !== 'object' || report.schemaVersion !== 2 || !['complete', 'complete-with-warnings'].includes(report.status) ||
      !Array.isArray(report.points) || !Array.isArray(report.drivers) || !Array.isArray(report.panels) ||
      !Array.isArray(report.initialColonObservations)) {
    throw problem('Only a complete schema-version-2 panel report can be exported.', 'INCOMPLETE_REPORT');
  }
  if (report.points.some(point => typeof point.point !== 'string' || point.point.includes(':'))) {
    throw problem('Panel Points contains an invalid or colon-containing identifier.', 'INVALID_POINT_RESULT');
  }
  return report;
}

function writeJsonExclusive(filename, data) {
  fs.writeFileSync(filename, JSON.stringify(data, null, 2) + '\n', { encoding: 'utf8', flag: 'wx', mode: 0o600 });
}

function exportViaPowerShell({ dataPath, outputPath, templatePath, powershellPath, scriptPath }) {
  return new Promise((resolve, reject) => {
    const executable = powershellPath || (process.platform === 'win32' ? 'powershell.exe' : 'pwsh');
    const args = ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', scriptPath,
      '-DataPath', dataPath, '-OutputPath', outputPath, '-TemplatePath', templatePath];
    const child = spawn(executable, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let output = '';
    let timeout;
    const capture = chunk => { output = (output + chunk.toString('utf8')).slice(-131072); };
    child.stdout.on('data', capture); child.stderr.on('data', capture);
    child.once('error', error => { clearTimeout(timeout); reject(problem(`Could not start the workbook exporter: ${error.message}`, 'EXPORT_START_FAILED')); });
    child.once('close', (code, signal) => {
      clearTimeout(timeout);
      if (code !== 0) reject(problem(`Workbook exporter failed (${signal || code}). ${output.trim()}`, 'EXPORT_FAILED'));
      else resolve({ output });
    });
    timeout = setTimeout(() => { child.kill(); }, 180000);
    timeout.unref();
  });
}

async function run(request, dependencies = {}) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) throw problem('A JSON request object is required.');
  const outputDir = path.resolve(request.outputDir || '');
  if (!request.outputDir || !fs.statSync(outputDir).isDirectory()) throw problem('Output directory must already exist.');
  const sanitize = makeSanitizer({ secrets: [request.password, request.username] });
  // Measurements can legitimately equal a short/common credential (e.g. ON).
  // Collector omits login bodies; report data uses field-aware redaction only.
  const sanitizeReport = makeSanitizer();
  const say = message => (dependencies.print || console.log)(sanitize.text(message));
  const tag = request.replayJson ? 'replay' : String(request.host || 'panel').replace(/[^A-Za-z0-9_.-]/g, '_').slice(0,80);
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  const stem = `PanelReport_${tag}_${stamp}_${crypto.randomBytes(3).toString('hex')}`;
  const paths = {
    log: path.join(outputDir, `${stem}.log.jsonl`),
    data: path.join(outputDir, `${stem}.json`),
    workbook: path.join(outputDir, `${stem}.xlsx`),
    partial: path.join(outputDir, `${stem}.partial.json`),
  };
  const logger = createDiagnosticLog(paths.log, { secrets: [request.password, request.username] });
  let report;
  let stage = 'startup';
  try {
    logger({ event: 'run-start', version: VERSION, mode: request.replayJson ? 'replay' : 'live', host: request.host,
      port: request.port || 23, outputDirectory: outputDir });
    say(`Diagnostic log: ${paths.log}`);
    if (request.replayJson) {
      stage = 'replay';
      report = readJson(path.resolve(request.replayJson));
      logger({ event: 'replay-loaded', source: path.resolve(request.replayJson) });
    } else {
      stage = 'collection';
      const collect = dependencies.collect || require('./lib/full-collector.cjs').collectFullPanelReport;
      report = await collect({
        host: request.host, port: request.port === undefined ? 23 : request.port,
        username: request.username, password: request.password,
        logger,
        onProgress: progress => {
          logger({ event: 'progress', ...progress });
          const phase = progress.phase || progress.stage || 'collecting';
          const count = progress.current != null ? ` ${progress.current}/${progress.total || '?'}` : '';
          const subject = progress.point || progress.device || progress.selector || progress.driver || '';
          say(`${phase}${count}${subject ? ': ' + subject : ''}`);
        },
      });
    }
    stage = 'report validation';
    validateCompleteReport(report);
    report = sanitizeReport(report);
    const model = dependencies.createWorkbookModel || require('./lib/workbook-model.cjs').createWorkbookModel;
    report.workbookModel = model(report);
    stage = 'saving data';
    writeJsonExclusive(paths.data, report);
    logger({ event: 'data-saved', path: paths.data, pointCount: report.points.length,
      driverCount: report.drivers.length, panelCount: report.panels.length });
    stage = 'workbook export';
    const exporter = dependencies.exportWorkbook || exportViaPowerShell;
    await exporter({
      dataPath: paths.data, outputPath: paths.workbook,
      templatePath: path.join(__dirname, 'assets', 'workbook-template.xlsx'),
      scriptPath: path.join(__dirname, 'Export-PanelWorkbook.ps1'),
      powershellPath: request.powershellPath,
    });
    const stat = fs.statSync(paths.workbook);
    if (!stat.isFile() || stat.size < 100) throw problem('Exporter did not create a valid-sized workbook.', 'EXPORT_MISSING');
    const descriptor = fs.openSync(paths.workbook, 'r');
    const signature = Buffer.alloc(4);
    try { fs.readSync(descriptor, signature, 0, 4, 0); } finally { fs.closeSync(descriptor); }
    if (!signature.equals(Buffer.from([0x50,0x4b,0x03,0x04]))) throw problem('Exporter output is not an XLSX ZIP package.', 'EXPORT_INVALID');
    logger({ event: 'complete', workbook: paths.workbook, data: paths.data, warningCount: report.warnings?.length || 0 });
    say(`Workbook: ${paths.workbook}`);
    say(`Data snapshot: ${paths.data}`);
    say(`Diagnostic log: ${paths.log}`);
    if (report.warnings?.length) say(`Completed with ${report.warnings.length} warning(s). See the workbook and diagnostic log.`);
    return { status: 'complete', paths, report };
  } catch (error) {
    const detail = sanitize({ message: error.message, code: error.code || 'RUN_FAILED', stage: error.stage || stage,
      expected: error.expected, partialResponse: error.partialResponse, stack: error.stack });
    const partial = sanitizeReport(error.partialResult || report || null);
    // A failed export may leave an incomplete XLSX. Keep the diagnostic file, but
    // label it unmistakably rather than handing it off as a finished workbook.
    let incompleteWorkbook;
    if (fs.existsSync(paths.workbook)) {
      incompleteWorkbook = paths.workbook + '.incomplete';
      try { fs.renameSync(paths.workbook, incompleteWorkbook); } catch { incompleteWorkbook = paths.workbook; }
    }
    let partialPath;
    try {
      writeJsonExclusive(paths.partial, { status: 'failed', error: detail, report: partial, incompleteWorkbook });
      partialPath = paths.partial;
    } catch (saveError) {
      detail.partialSaveError = sanitize.text(saveError.message);
    }
    try { logger({ event: 'failure', ...detail, partialPath, incompleteWorkbook }); }
    catch (logError) { detail.logWriteError = sanitize.text(logError.message); }
    say(`STOPPED during ${detail.stage}: ${detail.message}`);
    if (detail.expected) say(`Expected: ${detail.expected}`);
    if (detail.partialResponse) say(`Last response: ${String(detail.partialResponse).slice(-1200)}`);
    if (partialPath) say(`Partial data: ${partialPath}`);
    if (incompleteWorkbook) say(`Incomplete workbook (do not use): ${incompleteWorkbook}`);
    say(`Diagnostic log: ${paths.log}`);
    return { status: 'failed', paths: { ...paths, partial: partialPath, incompleteWorkbook }, error: detail };
  } finally {
    logger.close();
  }
}

async function readRequest(input) {
  let text = '';
  let bytes = 0;
  const decoder = new StringDecoder('utf8');
  for await (const chunk of input) {
    bytes += Buffer.byteLength(chunk);
    if (bytes > 65536) throw problem('Input request exceeds 64 KiB.');
    text += typeof chunk === 'string' ? chunk : decoder.write(chunk);
  }
  text += decoder.end();
  return JSON.parse(text.replace(/^\uFEFF/, '').trim());
}

async function main() {
  try {
    const request = await readRequest(process.stdin);
    const outcome = await run(request);
    process.exitCode = outcome.status === 'complete' ? 0 : 1;
  } catch (error) {
    // Never echo malformed input: it may contain the user's credentials.
    console.error('Could not start panel reporting. Check that the output directory exists and the launcher is intact.');
    console.error(error.code || 'STARTUP_ERROR');
    process.exitCode = 1;
  }
}
if (require.main === module) main();
module.exports = { run, readRequest, validateCompleteReport, exportViaPowerShell, VERSION };
