'use strict';

// Read-only, prompt-verified collection. Menu mismatches close the connection;
// there is deliberately no guessed recovery sequence or automatic retry.
const net = require('node:net');
const { setTimeout: delay } = require('node:timers/promises');
const { TelnetClient } = require('./telnet-client.cjs');
const { parsePointList, parsePointDetail } = require('./report-parser.cjs');
const {
  discoverDrivers, parseDeviceList, parseDeviceLook, parseSubpoints,
  parsePanelDirectory, parsePanelInfo, parseBdt,
} = require('./expanded-parser.cjs');

const RX = {
  welcome: /(?:^|\n)>Time,[ \t]*Message,[ \t]*Cancel,[ \t]*Hello\?[ \t]*/i,
  initials: /(?:^|\n)>Enter user initials[ \t]*:[ \t]*/i,
  password: /(?:^|\n)>Enter user password[ \t]*:[ \t]*/i,
  root: /(?:^|\n)>Point,[ \t]*Application,[ \t]*Time,[ \t]*Message,[ \t]*Cancel,[ \t]*System,[ \t]*passWord,[ \t]*Bye\?[ \t]*/i,
  point: /(?:^|\n)>Log,[ \t]*Display,[ \t]*Command,[ \t]*Edit,[ \t]*Operation,[ \t]*Monitor,[ \t]*Alarm,[ \t]*Trend,[ \t]*Quit\?[ \t]*/i,
  edit: /(?:^|\n)>Add,[ \t]*Modify,[ \t]*Copy,[ \t]*Delete,[ \t]*Look,[ \t]*Quit\?[ \t]*/i,
  pointName: /(?:^|\n)>Point name[ \t]*:[ \t]*/i,
  application: /(?:^|\n)>Ppcl,[ \t]*flNdevices?,[ \t]*Quit\?[ \t]*/i,
  device: /(?:^|\n)>Log,[ \t]*Display,[ \t]*Edit,(?:[ \t]*Initvalues,)?[ \t]*Quit\?[ \t]*/i,
  display: /(?:^|\n)>Definitions,[ \t]*Subpoints,[ \t]*deVice,[ \t]*Quit\?[ \t]*/i,
  appNumber: /(?:^|\n)>Application number[ \t]*:[ \t]*/i,
  subpointName: /(?:^|\n)>Subpoint name[ \t]*:[ \t]*/i,
  output: /(?:^|\n)>Here,[ \t]*Printer[ \t]*:[ \t]*/i,
  system: /(?:^|\n)>Diagnostics,[ \t]*Users,[ \t]*dSt,[ \t]*Bacnet,[ \t]*Error_msgs,[ \t]*Hardware,[ \t]*Text,[ \t]*Quit\?[ \t]*/i,
  hardware: /(?:^|\n)>Fieldpanels,[ \t]*Ethernet,[ \t]*nodeNametable,[ \t]*Disks,[ \t]*Reportprinter,[ \t]*Licensemanager,[ \t]*Quit\?[ \t]*/i,
  fieldpanels: /(?:^|\n)>Log,[ \t]*Display,[ \t]*Add,[ \t]*dElete,[ \t]*Modify,[ \t]*Config,[ \t]*Filesys,[ \t]*Quit\?[ \t]*/i,
  panel: /(?:^|\n)>Field panel[ \t]*:[ \t]*/i,
  firstPanel: /(?:^|\n)>First field panel[ \t]*:[ \t]*/i,
  lastPanel: /(?:^|\n)>Last field panel[ \t]*:[ \t]*/i,
  ethernet: /(?:^|\n)>ipSettings,[ \t]*Bbmd,[ \t]*sNmp,[ \t]*Telnet,[ \t]*Webserver,[ \t]*ftpupLoad,[ \t]*Quit\?[ \t]*/i,
  bdt: /(?:^|\n)>Display,[ \t]*Edit,[ \t]*Quit\?[ \t]*/i,
  logout: /(?:^|\n)>Are you sure[ \t]*\(Y\/N\)[ \t]*:[ \t]*/i,
  goodbye: /(?:^|\n)[ \t]*Good Bye[ \t]*\n/i,
  anyPrompt: /(?:^|\n)>[^\n]*[?:][ \t]*(?=\n|$)/,
  end: /(?:^|\n)[ \t]*End of report\.?[ \t]*\n/i,
  exception: /(?:^|\n)[ \t]*E(\d+)\(0x([0-9a-f]+)\)[ \t]*-[ \t]*([^\n]*)\n/i,
};

function union(...patterns) { return new RegExp(patterns.map(x => `(?:${x.source})`).join('|'), 'i'); }
function escapeRegex(value) { return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
function problem(code, message) { return Object.assign(new Error(message), { code }); }
function menuPattern(actions, ending = '?') {
  const pattern = new RegExp(`(?:^|\\n)>[^\\n:?]*${ending === '?' ? '\\?' : ':'}[ \\t]*`);
  pattern.actions = actions;
  return pattern;
}
function validateMenu(raw, actions) {
  const menus = [...raw.matchAll(/(?:^|\n)>([^\n:?]+)[?:][ \t]*/g)];
  const tokens = menus.at(-1)?.[1].split(',').map(x => x.trim());
  if (!tokens || tokens.some(x => !x)) throw problem('UNEXPECTED_MENU_ACTION', 'A complete action menu was not returned.');
  for (const [names, key] of actions) {
    const aliases = (Array.isArray(names) ? names : [names]).map(x => x.toLowerCase());
    const matches = tokens.filter(x => aliases.includes(x.toLowerCase()));
    const capitals = matches[0]?.match(/[A-Z]/g) || [];
    if (matches.length !== 1 || capitals.length !== 1 || capitals[0] !== key) {
      throw problem('UNEXPECTED_MENU_ACTION', `The menu does not unambiguously advertise ${aliases[0]} with hotkey ${key}.`);
    }
    // A second advertised capital carrying the same key would make selection
    // ambiguous. Do not infer first letters for unfamiliar menu options.
    if (tokens.some(x => x !== matches[0] && (x.match(/[A-Z]/g) || []).includes(key))) {
      throw problem('UNEXPECTED_MENU_ACTION', `The menu advertises an ambiguous ${key} hotkey.`);
    }
  }
}
// Required actions, not an exact list of unrelated firmware-specific options.
// Every selected key is verified against the actual advertised capitalization.
RX.root = menuPattern([['Point', 'P'], ['Application', 'A'], ['System', 'S'], ['Bye', 'B']]);
RX.point = menuPattern([['Log', 'L'], ['Edit', 'E'], ['Quit', 'Q']]);
RX.edit = menuPattern([['Look', 'L'], ['Quit', 'Q']]);
RX.application = menuPattern([[['flNdevice', 'flNdevices'], 'N']]);
RX.device = menuPattern([['Log', 'L'], ['Display', 'D'], ['Edit', 'E'], ['Quit', 'Q']]);
RX.display = menuPattern([['Subpoints', 'S'], ['Quit', 'Q']]);
RX.system = menuPattern([['Hardware', 'H']]);
RX.hardware = menuPattern([['Fieldpanels', 'F']]);
RX.hardwareEthernet = menuPattern([['Ethernet', 'E']]);
RX.fieldpanels = menuPattern([['Log', 'L'], ['Display', 'D']]);
RX.ethernet = menuPattern([['Bbmd', 'B']]);
RX.bdt = menuPattern([['Display', 'D'], ['Quit', 'Q']]);
RX.output = menuPattern([['Here', 'H']], ':');
function integer(value, name, minimum, maximum) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw problem('INVALID_INPUT', `${name} is outside its permitted range.`);
  }
}
function literal(value, name, { identifier = false } = {}) {
  if (typeof value !== 'string' || !value || value.length > 256 || /[\x00-\x1f\x7f-\x9f]|[^\x00-\xff]/.test(value)) {
    throw problem('INVALID_INPUT', `${name} must be nonempty Latin-1 text without control characters, at most 256 characters.`);
  }
  if (identifier && (value !== value.trim() || /[*?#]/.test(value))) {
    throw problem('INVALID_IDENTIFIER', `${name} is ambiguous or contains search wildcards/global menu keys.`);
  }
}
function framing(line) {
  const value = line.trim();
  return !value || /^[-=]{3,}$/.test(value) || /^Search for <.*>$/.test(value) ||
    /^\d{1,2}\/\d{1,2}\/\d{2,4}[ \t]+[A-Z]{3}[ \t]+POINT (?:LOG|LOOK) REPORT[ \t]+\d{1,2}:\d{2}(?::\d{2})?$/i.test(value) ||
    /^Point name$/i.test(value) || /^Field[ \t]+Value$/i.test(value) ||
    /^:Suffix \(Description\)[ \t]+Value\/State[ \t]+Status[ \t]+Priority$/i.test(value);
}
function fieldValue(fields, labels) {
  const normalized = new Set(labels.map(x => x.toLowerCase()));
  const found = (fields || []).filter(x => normalized.has(String(x.field).toLowerCase()));
  return found.map(x => String(x.value).trim());
}

async function collectFullPanelReport({
  host, port = 23, username, password,
  timeoutMs = 10000, reportTimeoutMs = 60000, requestDelayMs = 200,
  maxPoints = 20000, maxDevices = 2000, maxPanels = 1024,
  onProgress, logger,
} = {}) {
  if (typeof host !== 'string' || net.isIP(host) !== 4) throw problem('INVALID_INPUT', 'Host must be a literal IPv4 address.');
  integer(port, 'Port', 1, 65535);
  integer(timeoutMs, 'Prompt timeout', 50, 300000);
  integer(reportTimeoutMs, 'Report timeout', 50, 600000);
  integer(requestDelayMs, 'Request delay', 0, 60000);
  integer(maxPoints, 'Maximum point count', 1, 100000);
  integer(maxDevices, 'Maximum device count', 1, 20000);
  integer(maxPanels, 'Maximum panel count', 1, 10000);
  literal(username, 'Username'); literal(password, 'Password');
  for (const [name, fn] of [['onProgress', onProgress], ['logger', logger]]) {
    if (fn !== undefined && typeof fn !== 'function') throw problem('INVALID_INPUT', `${name} must be a function when supplied.`);
  }

  const result = {
    schemaVersion: 2, host, port, panelId: null, nodeName: null,
    startedAt: new Date().toISOString(), completedAt: null, status: 'collecting',
    listReport: '', points: [], initialColonObservations: [], drivers: [], panels: [], warnings: [],
  };
  let stage = 'connection';
  let expected = 'TCP connection';
  let partialResponse = '';
  let previousSend = 0;
  let sensitive = true;
  const secretField = /password|passphrase|secret|credential|token|community(?:\s+string)?|private\s+key/i;
  const scrubFields = value => String(value || '')
    .split('\n').map(line => {
      const field = /^([^:\n]+):(.*)$/.exec(line);
      return field && secretField.test(field[1]) && field[2].trim() ? `${field[1]}: [REDACTED]` : line;
    }).join('\n');
  const scrubDiagnostic = value => scrubFields(value).split(password).join('[REDACTED]').split(username).join('[REDACTED]');
  const cleanData = value => {
    if (typeof value === 'string') return scrubFields(value);
    if (Array.isArray(value)) return value.map(cleanData);
    if (value && typeof value === 'object') {
      const object = Object.fromEntries(Object.entries(value).map(([key, item]) => [key,
        secretField.test(key) && typeof item === 'string' && item.trim() ? '[REDACTED]' : cleanData(item)]));
      if (typeof object.field === 'string' && secretField.test(object.field) && typeof object.value === 'string' && object.value.trim()) object.value = '[REDACTED]';
      return object;
    }
    return value;
  };
  const cleanDiagnostic = value => {
    if (typeof value === 'string') return scrubDiagnostic(value);
    if (Array.isArray(value)) return value.map(cleanDiagnostic);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, cleanDiagnostic(item)]));
    return value;
  };
  const emit = event => {
    if (logger) {
      try { logger({ at: new Date().toISOString(), stage, ...cleanDiagnostic(event) }); }
      catch { throw problem('LOGGER_FAILED', 'The diagnostic logger could not accept an event.'); }
    }
  };
  const progress = event => {
    if (onProgress) {
      try { onProgress(cleanDiagnostic(event)); }
      catch { throw problem('PROGRESS_CALLBACK_FAILED', 'The progress callback failed.'); }
    }
  };
  const setStage = (value, meta = {}) => { stage = value; progress({ phase: value, ...meta }); };
  const client = new TelnetClient({ onFailure: snapshot => {
    partialResponse = sensitive ? '[AUTH REDACTED]' : scrubDiagnostic(snapshot.partial);
  } });

  const wait = async (pattern, label, waitMs = timeoutMs) => {
    expected = label;
    const raw = await client.waitFor(union(pattern, RX.anyPrompt), { timeoutMs: waitMs });
    partialResponse = sensitive ? '[AUTH REDACTED]' : scrubDiagnostic(raw);
    emit({ event: 'response', expected: label, text: partialResponse });
    if (!pattern.test(raw)) throw problem('UNEXPECTED_PROMPT', `Expected ${label}; received a different prompt.`);
    if (pattern.actions) validateMenu(raw, pattern.actions);
    return raw;
  };
  const send = async (text, action) => {
    emit({ event: 'step', action, sent: sensitive ? '[AUTH REDACTED]' : text, expected });
    const remaining = previousSend + requestDelayMs - Date.now();
    if (remaining > 0) await delay(remaining);
    client.send(text); previousSend = Date.now();
  };
  const step = async (text, pattern, label, action = text) => {
    expected = label;
    await send(text, action);
    return wait(pattern, label);
  };
  const reset = () => step('#', RX.root, 'main panel menu', 'Return to main menu');
  const checked = (parsed, label) => {
    if (!parsed || !parsed.complete) throw problem('INCOMPLETE_REPORT', `${label} was not complete.`);
    if (parsed.unparsedLines?.length) throw problem('UNPARSED_REPORT_DATA', `${label} contains unrecognized data lines.`);
    result.warnings.push(...(parsed.warnings || []).map(x => `${label}: ${typeof x === 'string' ? x : JSON.stringify(x)}`));
    return parsed;
  };
  const report = async (menu, label, allowedErrors = []) => {
    expected = `${label}: End of report or recognized error`;
    const raw = await client.waitFor(union(RX.end, RX.exception, RX.anyPrompt), { timeoutMs: reportTimeoutMs });
    partialResponse = scrubDiagnostic(raw);
    emit({ event: 'response', expected, text: partialResponse });
    const exception = RX.exception.exec(raw);
    if (!RX.end.test(raw) && !exception) throw problem('INCOMPLETE_REPORT', `${label} returned to a menu without an End of report marker.`);
    await wait(menu, `${label}: return menu`);
    if (exception) {
      const code = Number(exception[1]);
      if (!allowedErrors.includes(code)) throw problem('PANEL_ERROR', `${label} returned an unexpected panel error E${code}.`);
      return { rawReport: scrubFields(raw), status: 'unavailable', errorCode: code, error: scrubFields(exception[3].trim()), capturedAt: new Date().toISOString() };
    }
    return { rawReport: scrubFields(raw), status: 'complete', capturedAt: new Date().toISOString() };
  };
  const warning = message => { result.warnings.push(message); emit({ event: 'warning', message }); };
  const fieldpanels = async () => {
    await reset(); await step('S', RX.system, 'System menu');
    await step('H', RX.hardware, 'Hardware menu'); await step('F', RX.fieldpanels, 'Fieldpanels menu');
  };
  const panelConfiguration = async selector => {
    await step('D', RX.output, 'report destination');
    await step('H', RX.panel, 'field-panel selector');
    await send(selector + '\r\n', selector ? 'Select field panel' : 'Select local field panel');
    const captured = await report(RX.fieldpanels, 'panel configuration', [3, 57]);
    if (captured.status === 'unavailable') return captured;
    return { ...checked(parsePanelInfo(captured.rawReport), 'Panel configuration'), ...captured };
  };

  try {
    progress({ phase: 'connecting' });
    emit({ event: 'connection', host, port });
    await client.connect(host, port, timeoutMs);
    setStage('login');
    const opening = wait(union(RX.welcome, RX.initials), 'welcome menu or initials prompt');
    const wake = setTimeout(() => {
      try { client.send('#'); previousSend = Date.now(); }
      catch { /* Pending wait owns failure reporting. */ }
    }, Math.min(150, Math.max(10, Math.floor(timeoutMs / 2))));
    let openingText;
    try { openingText = await opening; } finally { clearTimeout(wake); }
    if (RX.welcome.test(openingText)) await step('H', RX.initials, 'initials prompt', 'Hello');
    await step(username + '\r\n', RX.password, 'password prompt', 'Submit initials');
    const login = await step(password + '\r\n', RX.root, 'authenticated main menu', 'Submit password');
    const ids = [...login.matchAll(/Field panel[ \t]*<([^<>\r\n]+)>/gi)].map(x => x[1].trim());
    if (!/Logged on successfully/i.test(login) || new Set(ids).size !== 1) throw problem('AMBIGUOUS_PANEL', 'Login did not identify exactly one field panel.');
    literal(ids[0], 'Authenticated panel identifier', { identifier: true });
    result.panelId = ids[0];
    sensitive = false;
    partialResponse = '';
    emit({ event: 'authenticated', panelId: result.panelId });

    setStage('point listing');
    await step('P', RX.point, 'Point menu'); await step('L', RX.pointName, 'point-name prompt');
    await send('\r\n', 'List all points');
    const pointList = await report(RX.point, 'point list', [3]);
    result.listReport = pointList.rawReport;
    let selectedPoints = [];
    if (pointList.status === 'unavailable') warning('Point list returned E3: no matching points.');
    else {
      const parsed = parsePointList(pointList.rawReport);
      if (!parsed.complete || parsed.unparsedLines.some(x => !framing(x.raw))) throw problem('UNPARSED_REPORT_DATA', 'Point list is incomplete or contains unrecognized data.');
      if (parsed.points.length > maxPoints) throw problem('LIMIT_EXCEEDED', 'Point count exceeds the configured collection limit.');
      result.warnings.push(...parsed.warnings);
      const unique = new Map();
      for (const point of parsed.points) {
        literal(point.point, 'Point identifier', { identifier: true });
        const key = point.point.toLowerCase();
        const signature = JSON.stringify([point.point, point.description, point.value, point.engineeringUnit, point.status, point.priority, point.qualifier]);
        if (unique.has(key) && unique.get(key).signature !== signature) throw problem('AMBIGUOUS_POINT', 'Conflicting duplicate point observations were returned.');
        if (!unique.has(key)) unique.set(key, { point, signature });
      }
      const all = [...unique.values()].map(x => x.point);
      result.initialColonObservations = all.filter(x => x.point.includes(':'));
      selectedPoints = all.filter(x => !x.point.includes(':'));
    }
    for (let i = 0; i < selectedPoints.length; i++) {
      const point = selectedPoints[i];
      setStage('point details', { current: i + 1, total: selectedPoints.length, point: point.point });
      await step('E', RX.edit, 'point Edit menu'); await step('L', RX.pointName, 'point-name prompt');
      await send(point.point + '\r\n', 'Look at listed point');
      const captured = await report(RX.edit, 'point Look', [3]);
      if (captured.status === 'unavailable') {
        result.points.push({ ...point, detail: { complete: false, fields: [], ...captured }, detailReport: captured.rawReport });
        warning(`Point ${point.point}: Look returned E3; current listing observation was retained.`);
      } else {
        const detail = parsePointDetail(captured.rawReport);
        for (const label of ['point system name', 'point name']) {
          const names = fieldValue(detail.fields, [label]);
          if (names.length !== 1 || names[0] !== point.point) throw problem('AMBIGUOUS_DETAIL', 'Point Look does not identify exactly the requested point.');
        }
        if (!detail.complete) throw problem('INCOMPLETE_REPORT', 'Point Look was incomplete.');
        const unfamiliar = detail.unparsedLines.filter(x => x.raw.trim() !== point.point && !framing(x.raw));
        if (unfamiliar.length) warning(`Point ${point.point}: ${unfamiliar.length} unfamiliar Look lines were retained in raw data.`);
        result.points.push({ ...point, detail, detailReport: captured.rawReport, detailCapturedAt: captured.capturedAt });
      }
      await step('Q', RX.point, 'Point menu', 'Quit point Edit menu');
    }

    setStage('FLN discovery');
    await reset(); await step('A', RX.application, 'Application menu');
    const driverMenu = await step('N', RX.anyPrompt, 'FLN driver menu');
    const drivers = discoverDrivers(driverMenu);
    if (!Array.isArray(drivers) || drivers.length > 24) throw problem('UNSUPPORTED_DRIVER_MENU', 'FLN driver menu was not unambiguous.');
    for (const advertised of drivers) {
      const driver = { name: advertised.name, key: advertised.key, status: 'collecting', devices: [], subpoints: [] };
      result.drivers.push(driver);
      setStage('FLN device list', { driver: driver.name });
      await reset(); await step('A', RX.application, 'Application menu');
      const discoveredAgain = discoverDrivers(await step('N', RX.anyPrompt, 'FLN driver menu'));
      if (!discoveredAgain.some(x => x.key === driver.key && x.name === driver.name)) throw problem('DRIVER_MENU_CHANGED', 'An advertised driver changed during collection.');
      literal(driver.key, 'Driver hotkey', { identifier: true });
      if (!/^[A-Za-z0-9]$/.test(driver.key)) throw problem('INVALID_IDENTIFIER', 'Driver hotkey is not one character.');
      const deviceName = new RegExp(`(?:^|\\n)>(?:${escapeRegex(driver.name)}[ \\t]+(?:Device[ \\t]+)?name|Device[ \\t]+name)[ \\t]*:[ \\t]*`, 'i');
      await step(driver.key, RX.device, `${driver.name} device menu`, 'Select advertised driver');
      await step('L', deviceName, `${driver.name} device-name prompt`);
      await send('\r\n', 'List all devices in driver category');
      const listed = await report(RX.device, `${driver.name} device list`, [3]);
      driver.rawList = listed.rawReport;
      if (listed.status === 'unavailable') { driver.status = 'empty'; driver.emptyReason = 'E3 - not found'; continue; }
      const parsedList = checked(parseDeviceList(listed.rawReport, { driver: driver.name }), `${driver.name} device list`);
      if (parsedList.devices.length > maxDevices) throw problem('LIMIT_EXCEEDED', 'Device count exceeds the configured collection limit.');
      const deviceMap = new Map();
      for (const listedDevice of parsedList.devices) {
        literal(listedDevice.name, 'Device identifier', { identifier: true });
        const key = listedDevice.name.toLowerCase();
        if (deviceMap.has(key)) throw problem('AMBIGUOUS_DEVICE', 'Duplicate device names were returned within a driver.');
        const device = { ...listedDevice, driver: driver.name, look: null };
        driver.devices.push(device); deviceMap.set(key, device);
      }
      for (let i = 0; i < driver.devices.length; i++) {
        const device = driver.devices[i];
        setStage('FLN device details', { driver: driver.name, device: device.name, current: i + 1, total: driver.devices.length });
        await step('E', RX.edit, 'device Edit menu'); await step('L', deviceName, 'device-name prompt');
        await send(device.name + '\r\n', 'Look at listed device');
        const captured = await report(RX.edit, `${driver.name} device Look`, [3]);
        if (captured.status === 'unavailable') { device.look = captured; warning(`Device ${device.name}: Look returned E3.`); }
        else {
          const look = checked(parseDeviceLook(captured.rawReport), `${driver.name} device Look`);
          const names = fieldValue(look.fields, ['Device system name', `${driver.name} Device name`, `${driver.name} name`, 'Device name']);
          if (!names.length || names.some(x => x.toLowerCase() !== device.name.toLowerCase())) throw problem('AMBIGUOUS_DEVICE', 'Device Look does not identify exactly the requested device.');
          const applications = fieldValue(look.fields, ['Application number']);
          if (applications.length > 1 || (applications[0] && device.applicationNumber && applications[0] !== device.applicationNumber)) throw problem('AMBIGUOUS_APPLICATION', 'Application number changed between device list and Look.');
          device.applicationNumber = applications[0] || device.applicationNumber || null;
          device.look = { ...look, ...captured };
        }
        await step('Q', RX.device, 'device menu', 'Quit device Edit menu');
      }
      setStage('FLN subpoints', { driver: driver.name });
      await step('D', RX.display, 'device Display menu');
      await step('S', deviceName, 'subpoint device-name filter');
      await step('\r\n', RX.appNumber, 'subpoint application filter', 'All devices');
      await step('\r\n', RX.subpointName, 'subpoint-name filter', 'All applications');
      await step('\r\n', RX.output, 'subpoint report destination', 'All subpoints');
      await send('H', 'Display subpoint report here');
      const captured = await report(RX.display, `${driver.name} subpoints`, [3]);
      driver.rawSubpoints = captured.rawReport;
      if (captured.status === 'unavailable') warning(`${driver.name}: subpoint display returned E3 despite a device listing.`);
      else {
        const parsed = checked(parseSubpoints(captured.rawReport), `${driver.name} subpoints`);
        const seen = new Set();
        for (const subpoint of parsed.subpoints) {
          const device = deviceMap.get(subpoint.device.toLowerCase());
          if (!device) throw problem('UNLISTED_SUBPOINT_DEVICE', 'A subpoint report refers to a device not present in its driver list.');
          const key = `${device.name.toLowerCase()}\u0000${subpoint.suffix.toLowerCase()}`;
          if (seen.has(key)) throw problem('AMBIGUOUS_SUBPOINT', 'A duplicate subpoint was returned for one device.');
          seen.add(key);
          driver.subpoints.push({ ...subpoint, driver: driver.name, applicationNumber: device.applicationNumber });
        }
      }
      driver.status = 'complete';
    }

    setStage('local panel configuration');
    await fieldpanels();
    const localInfo = await panelConfiguration('');
    if (localInfo.status !== 'complete') throw problem('LOCAL_CONFIGURATION_UNAVAILABLE', 'Local panel configuration was unavailable; protocol selection cannot be verified.');
    if (!['BACnet', 'APOGEE'].includes(localInfo.protocol)) throw problem('UNSUPPORTED_PROTOCOL', 'Local firmware/network type did not establish BACnet or APOGEE protocol.');
    if (localInfo.protocol === 'BACnet' && (!localInfo.instance ||
        (/^\d+$/.test(result.panelId) && result.panelId !== localInfo.instance))) {
      throw problem('AMBIGUOUS_PANEL', 'The local configuration does not establish the authenticated BACnet panel instance.');
    }
    result.nodeName = localInfo.nodeName || null;
    setStage('panel directory');
    await step('L', RX.firstPanel, 'first field-panel filter');
    await step('\r\n', RX.lastPanel, 'last field-panel filter', 'First panel default');
    await send('\r\n', 'Last panel default');
    const directory = await report(RX.fieldpanels, 'panel directory');
    result.panelDirectoryReport = directory.rawReport;
    const parsedDirectory = checked(parsePanelDirectory(directory.rawReport), 'Panel directory');
    if (parsedDirectory.panels.length > maxPanels) throw problem('LIMIT_EXCEEDED', 'Panel count exceeds the configured collection limit.');
    const seenPanels = new Set();
    let locals = 0;
    for (const listedPanel of parsedDirectory.panels) {
      literal(listedPanel.selector, 'Panel selector', { identifier: true });
      const key = listedPanel.selector.toLowerCase();
      if (seenPanels.has(key)) throw problem('AMBIGUOUS_PANEL', 'The panel directory contains duplicate selectors.');
      seenPanels.add(key);
      const local = listedPanel.local || listedPanel.selector === localInfo.instance || listedPanel.selector.toLowerCase() === String(localInfo.nodeName || '').toLowerCase();
      if (local && ((localInfo.protocol === 'BACnet' && listedPanel.selector !== localInfo.instance) ||
          (localInfo.protocol === 'APOGEE' && localInfo.nodeName && listedPanel.selector.toLowerCase() !== localInfo.nodeName.toLowerCase()))) {
        throw problem('AMBIGUOUS_PANEL', 'The directory local marker disagrees with the verified local configuration.');
      }
      if (local) locals++;
      if (locals > 1) throw problem('AMBIGUOUS_PANEL', 'More than one directory row identifies the local panel.');
      result.panels.push({ ...listedPanel, local: !!local, configuration: local ? localInfo : { status: 'not-collected', fields: [] }, bdt: { status: 'not-collected', entries: [] } });
    }
    if (!locals) {
      const selector = localInfo.protocol === 'BACnet' ? localInfo.instance : localInfo.nodeName;
      if (!selector) throw problem('AMBIGUOUS_PANEL', 'The local panel is absent from the directory and has no usable selector.');
      result.panels.push({ selector, local: true, directoryState: 'Not present in returned directory', configuration: localInfo, bdt: { status: 'not-collected', entries: [] } });
      warning('The verified local panel was not present in the returned panel directory.');
    }
    for (const panel of result.panels) {
      if (panel.local) continue;
      setStage('panel configuration', { panel: panel.selector });
      panel.configuration = await panelConfiguration(panel.selector);
      if (panel.configuration.status !== 'complete') warning(`Panel ${panel.selector}: configuration unavailable (E${panel.configuration.errorCode}).`);
      else if (!['BACnet', 'APOGEE'].includes(panel.configuration.protocol)) throw problem('UNSUPPORTED_PROTOCOL', 'A returned panel configuration does not establish its protocol.');
      else if (panel.configuration.protocol === 'BACnet' && panel.configuration.instance !== panel.selector) throw problem('AMBIGUOUS_PANEL', 'Configuration instance differs from the selected directory panel.');
      else if (panel.configuration.protocol === 'APOGEE' && panel.configuration.nodeName && panel.configuration.nodeName.toLowerCase() !== panel.selector.toLowerCase()) throw problem('AMBIGUOUS_PANEL', 'Configuration hostname differs from the selected directory panel.');
    }
    for (const panel of result.panels) {
      const protocol = panel.configuration.protocol || localInfo.protocol;
      if (protocol === 'APOGEE') { panel.bdt = { status: 'not-applicable', entries: [], reason: 'APOGEE panel' }; continue; }
      if (protocol !== 'BACnet' || !/^\d+$/.test(panel.selector) || Number(panel.selector) > 4194302) throw problem('UNSUPPORTED_PANEL_SELECTOR', 'A BACnet BDT query requires a verified numeric instance selector.');
      setStage('BACnet distribution table', { panel: panel.selector });
      await reset(); await step('S', RX.system, 'System menu'); await step('H', RX.hardwareEthernet, 'Hardware Ethernet action');
      await step('E', RX.ethernet, 'Ethernet menu'); await step('B', RX.panel, 'BBMD field-panel selector');
      await step(panel.selector + '\r\n', RX.bdt, 'BBMD Display/Edit/Quit menu', 'Select BBMD panel instance');
      await send('D', 'Display BBMD address report');
      const captured = await report(RX.bdt, 'BBMD address report', [3, 57]);
      if (captured.status === 'unavailable') {
        panel.bdt = { ...captured, entries: [] }; warning(`Panel ${panel.selector}: BDT unavailable (E${captured.errorCode}).`);
      } else {
        const parsed = checked(parseBdt(captured.rawReport), 'BBMD address report');
        if (parsed.instance && parsed.instance !== panel.selector) throw problem('AMBIGUOUS_PANEL', 'BBMD report identifies a different panel instance.');
        panel.bdt = { ...parsed, ...captured };
        panel.bdt.selfEntryStatus = panel.configuration.ip && panel.configuration.udpPort
          ? (parsed.entries.some(x => x.ip === panel.configuration.ip && x.udpPort === panel.configuration.udpPort) ? 'listed' : 'not-listed')
          : 'unknown-endpoint';
        if (panel.configuration.status !== 'complete') warning(`Panel ${panel.selector}: the returned BDT report does not establish panel health; configuration was unavailable.`);
      }
    }

    setStage('logout');
    await reset();
    const logout = await step('B', union(RX.logout, RX.welcome, RX.goodbye), 'logout confirmation, welcome menu, or Good Bye', 'Bye');
    // Some firmware closes TCP immediately after the explicit Good Bye line.
    // Match that line before EOF; a disconnect by itself is never success.
    if (RX.logout.test(logout)) await step('Y', union(RX.welcome, RX.goodbye), 'unauthenticated welcome menu or Good Bye', 'Confirm session logout');
    result.status = result.warnings.length ? 'complete-with-warnings' : 'complete';
    result.completedAt = new Date().toISOString();
    emit({ event: 'complete', pointCount: result.points.length, driverCount: result.drivers.length, panelCount: result.panels.length, warningCount: result.warnings.length });
    progress({ phase: 'complete', pointCount: result.points.length, driverCount: result.drivers.length, panelCount: result.panels.length, warningCount: result.warnings.length });
    return cleanData(result);
  } catch (error) {
    const knownCode = typeof error.code === 'string' && /^[A-Z_]+$/.test(error.code) ? error.code : 'COLLECTION_STOPPED';
    result.status = 'stopped';
    result.completedAt = new Date().toISOString();
    const reason = stage === 'login' ? 'Authentication did not complete with a verified panel identity.' : scrubDiagnostic(error.message).slice(0,1000);
    const stopped = problem(knownCode, `Collection stopped during ${stage}. ${reason} Expected ${expected}. No further menu keys were sent; the connection was closed. See the diagnostic log for the received response.`);
    stopped.stage = stage;
    stopped.expected = expected;
    stopped.reason = reason;
    stopped.partialResponse = sensitive ? '[AUTH REDACTED]' : scrubDiagnostic(partialResponse);
    stopped.partialResult = cleanData(result);
    try { emit({ event: 'error', code: stopped.code, message: stopped.message, expected, partialResponse: stopped.partialResponse }); }
    catch { /* Logger failure must not prevent safe connection cleanup. */ }
    throw stopped;
  } finally {
    client.close();
  }
}

module.exports = { collectFullPanelReport };
