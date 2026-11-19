'use strict';

const net = require('node:net');
const { setTimeout: delay } = require('node:timers/promises');
const { TelnetClient } = require('./telnet-client.cjs');
const { parsePointList, parsePointDetail } = require('./report-parser.cjs');

// Only these observed menus authorize the next keystroke. In particular, a
// generic question mark or a quiet socket is never treated as completion.
const WELCOME = /(?:^|\n)>Time,[ \t]*Message,[ \t]*Cancel,[ \t]*Hello\?[ \t]*/i;
const INITIALS = /(?:^|\n)>Enter user initials[ \t]*:[ \t]*/i;
const PASSWORD = /(?:^|\n)>Enter user password[ \t]*:[ \t]*/i;
const ROOT_MENU = /(?:^|\n)>Point,[ \t]*Application,[ \t]*Time,[ \t]*Message,[ \t]*Cancel,[ \t]*System,[ \t]*passWord,[ \t]*Bye\?[ \t]*/i;
const POINT_MENU = /(?:^|\n)>Log,[ \t]*Display,[ \t]*Command,[ \t]*Edit,[ \t]*Operation,[ \t]*Monitor,[ \t]*Alarm,[ \t]*Trend,[ \t]*Quit\?[ \t]*/i;
const EDIT_MENU = /(?:^|\n)>Add,[ \t]*Modify,[ \t]*Copy,[ \t]*Delete,[ \t]*Look,[ \t]*Quit\?[ \t]*/i;
const POINT_NAME = /(?:^|\n)>Point name[ \t]*:[ \t]*/i;
const START_MENU = new RegExp(`(?:${WELCOME.source})|(?:${INITIALS.source})`, 'i');
const REPORT_END = /(?:^|\n)[ \t]*End of report\.?[ \t]*\n/i;

function problem(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function validateInteger(value, name, minimum, maximum) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw problem('INVALID_INPUT', `${name} is outside its permitted range.`);
  }
}

function validText(value, name, { allowWildcards = true } = {}) {
  if (typeof value !== 'string' || !value.length || value.length > 256 ||
      /[\x00-\x1f\x7f-\x9f]/.test(value) || /[^\x00-\xff]/.test(value)) {
    throw problem('INVALID_INPUT', `${name} must be nonempty Latin-1 text without control characters, at most 256 characters.`);
  }
  if (!allowWildcards && (value.trim() !== value || /[*?]/.test(value))) {
    throw problem('INVALID_POINT_NAME', 'A reported point identifier is ambiguous or contains search wildcards.');
  }
}

function isRule(line) { return /^[-=]{3,}$/.test(line.trim()); }

function isListFraming(line) {
  const value = line.trim();
  return !value || isRule(value) ||
    /^\d{1,2}\/\d{1,2}\/\d{2,4}[ \t]+[A-Z]{3}[ \t]+POINT LOG REPORT[ \t]+\d{1,2}:\d{2}(?::\d{2})?$/i.test(value) ||
    /^Search for <\*:>$/i.test(value) ||
    /^Point name$/i.test(value) ||
    /^:Suffix \(Description\)[ \t]+Value\/State[ \t]+Status[ \t]+Priority$/i.test(value);
}

function isDetailFraming(line, point) {
  const value = line.trim();
  return !value || value === point || isRule(value) ||
    /^\d{1,2}\/\d{1,2}\/\d{2,4}[ \t]+[A-Z]{3}[ \t]+POINT LOOK REPORT[ \t]+\d{1,2}:\d{2}(?::\d{2})?$/i.test(value) ||
    value === `Search for <${point}>` || value === `Search for <${point}:>` ||
    /^Field[ \t]+Value$/i.test(value);
}

function uniquePoints(list) {
  if (!list.complete || list.points.length === 0) {
    throw problem('INCOMPLETE_LIST', 'The point listing is incomplete or contains no recognized points.');
  }
  if (list.unparsedLines.some(line => !isListFraming(line.raw))) {
    throw problem('UNPARSED_LIST_DATA', 'The point listing contains unrecognized data lines; collection stopped rather than guessing.');
  }
  const unique = new Map();
  for (const point of list.points) {
    validText(point.point, 'Point identifier', { allowWildcards: false });
    const signature = JSON.stringify([
      point.point, point.description, point.value, point.originalValue,
      point.engineeringUnit, point.qualifier, point.status, point.priority,
      point.parent, point.suffix,
    ]);
    const existing = unique.get(point.point);
    if (existing && existing.signature !== signature) {
      throw problem('AMBIGUOUS_POINT', 'The listing contains conflicting observations for the same point identifier.');
    }
    if (!existing) unique.set(point.point, { point, signature });
  }
  return Array.from(unique.values(), item => item.point);
}

function checkDetailIdentity(detail, requestedPoint) {
  if (!detail.complete) throw problem('INCOMPLETE_DETAIL', 'A point detail report is incomplete.');
  for (const label of ['point system name', 'point name']) {
    const matching = detail.fields.filter(field => field.field.toLowerCase() === label);
    if (matching.length !== 1 || matching[0].value.trim() !== requestedPoint) {
      throw problem('AMBIGUOUS_DETAIL', 'A detail report did not identify exactly the requested point.');
    }
  }
}

/**
 * Collect a complete, read-only point log followed by non-colon point Looks.
 * Colon-containing observations are retained separately without a Look request.
 * Credentials and the login transcript are never included in returned data,
 * progress events, or error messages. No point-changing menu action is sent.
 */
async function collectPanelReport({
  host,
  port = 23,
  username,
  password,
  timeoutMs = 10000,
  reportTimeoutMs = 60000,
  requestDelayMs = 200,
  onProgress,
} = {}) {
  if (typeof host !== 'string' || net.isIP(host) !== 4) {
    throw problem('INVALID_INPUT', 'Host must be a literal IPv4 address.');
  }
  validateInteger(port, 'Port', 1, 65535);
  validateInteger(timeoutMs, 'Prompt timeout', 50, 300000);
  validateInteger(reportTimeoutMs, 'Report timeout', 50, 600000);
  validateInteger(requestDelayMs, 'Request delay', 0, 60000);
  validText(username, 'Username');
  validText(password, 'Password');
  if (onProgress !== undefined && typeof onProgress !== 'function') {
    throw problem('INVALID_INPUT', 'onProgress must be a function when supplied.');
  }

  const client = new TelnetClient();
  const startedAt = new Date().toISOString();
  const warnings = [];
  let stage = 'connection';
  let previousSend = 0;
  const progress = data => { if (onProgress) onProgress(data); };
  const send = async text => {
    const remaining = previousSend + requestDelayMs - Date.now();
    if (remaining > 0) await delay(remaining);
    client.send(text);
    previousSend = Date.now();
  };
  const wait = regex => client.waitFor(regex, { timeoutMs });
  const readReport = () => client.waitFor(REPORT_END, { timeoutMs: reportTimeoutMs });

  try {
    progress({ phase: 'connecting' });
    await client.connect(host, port, timeoutMs);
    stage = 'login';
    // Some panels wait for Enter before presenting Hello. Others immediately
    // present the initials prompt. A short wake-up timer sends Enter at most
    // once if neither explicit opening prompt has arrived; it is not a report
    // completion heuristic and does not perform an automatic login retry.
    const openingWait = wait(START_MENU);
    const wakeTimer = setTimeout(() => {
      try { client.send('\r\n'); previousSend = Date.now(); }
      catch { /* The pending prompt wait reports any connection failure. */ }
    }, Math.min(150, Math.max(10, Math.floor(timeoutMs / 2))));
    let opening;
    try { opening = await openingWait; }
    finally { clearTimeout(wakeTimer); }
    if (WELCOME.test(opening)) {
      await send('H');
      await wait(INITIALS);
    }
    await send(username + '\r\n');
    await wait(PASSWORD);
    await send(password + '\r\n');
    const login = await wait(ROOT_MENU);
    const identifiers = [...login.matchAll(/Field panel[ \t]*<([0-9]+)>/gi)].map(match => match[1]);
    const uniqueIdentifiers = new Set(identifiers);
    if (!/Logged on successfully/i.test(login) || uniqueIdentifiers.size !== 1) {
      throw problem('AMBIGUOUS_PANEL', 'The authenticated session did not identify one field panel.');
    }
    const panelId = identifiers[0];

    stage = 'point listing';
    progress({ phase: 'listing', panelId });
    await send('P');
    await wait(POINT_MENU);
    await send('L');
    await wait(POINT_NAME);
    await send('\r\n');
    const listReport = await readReport();
    await wait(POINT_MENU);
    const parsedList = parsePointList(listReport);
    const listedPoints = uniquePoints(parsedList);
    // Colon identifiers are subpoints, not local points for this Look pass.
    // Keep their list observations for later report integration without sending
    // any of those identifiers to the point Look prompt.
    const initialColonObservations = listedPoints.filter(point => point.point.includes(':'));
    const selectedPoints = listedPoints.filter(point => !point.point.includes(':'));
    warnings.push(...parsedList.warnings);
    if (listedPoints.length !== parsedList.points.length) {
      warnings.push('Identical repeated point-list rows were deduplicated before detail collection.');
    }

    const points = [];
    for (let index = 0; index < selectedPoints.length; index++) {
      stage = 'point details';
      const point = selectedPoints[index];
      progress({ phase: 'detail', current: index + 1, total: selectedPoints.length, point: point.point });
      await send('E');
      await wait(EDIT_MENU);
      await send('L');
      await wait(POINT_NAME);
      await send(point.point + '\r\n');
      const detailReport = await readReport();
      const detailCapturedAt = new Date().toISOString();
      await wait(EDIT_MENU);
      const detail = parsePointDetail(detailReport);
      checkDetailIdentity(detail, point.point);
      const unfamiliar = detail.unparsedLines.filter(line => !isDetailFraming(line.raw, point.point));
      if (unfamiliar.length) {
        warnings.push(`Point ${point.point}: ${unfamiliar.length} detail lines were retained without field/value parsing.`);
      }
      points.push({ ...point, detailReport, detail, detailCapturedAt });
      await send('Q');
      await wait(POINT_MENU);
    }
    const result = {
      schemaVersion: 1,
      host,
      port,
      panelId,
      startedAt,
      completedAt: new Date().toISOString(),
      listReport,
      points,
      initialColonObservations,
      warnings,
    };
    progress({ phase: 'complete', total: points.length, warningCount: warnings.length });
    return result;
  } catch (error) {
    // Do not propagate server text, prompt captures, supplied credentials, or
    // callback exceptions into an error object/cause that a CLI might log.
    const allowedCodes = new Set([
      'INVALID_INPUT', 'INVALID_POINT_NAME', 'INCOMPLETE_LIST', 'UNPARSED_LIST_DATA',
      'AMBIGUOUS_POINT', 'INCOMPLETE_DETAIL', 'AMBIGUOUS_DETAIL', 'AMBIGUOUS_PANEL',
    ]);
    const code = allowedCodes.has(error.code) ? error.code : 'COLLECTION_STOPPED';
    const stopped = problem(code, `Panel collection stopped during ${stage}. The expected complete, unambiguous response was not received; no further menu keys were sent.`);
    stopped.stage = stage;
    throw stopped;
  } finally {
    client.close();
  }
}

module.exports = { collectPanelReport };
