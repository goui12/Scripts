'use strict';

// Pure parsers for read-only terminal reports. These functions never transmit
// menu keys. Unknown text remains visible in unparsedLines for the caller to
// reject; a header or a quiet socket is not evidence of a complete report.
const { parsePointList } = require('./report-parser.cjs');

const END = /^End of report\.?$/i;
const RULE = /^[-=]{3,}$/;
const DEVICE_MENU = /^>Log,\s*Display,\s*Edit(?:,\s*Initvalues)?,\s*Quit\?\s*$/i;
const EDIT_MENU = /^>Add,\s*Modify,\s*Copy,\s*Delete,\s*Look,\s*Quit\?\s*$/i;
const SUBPOINT_MENU = /^>Definitions,\s*Subpoints,\s*deVice,\s*Quit\?\s*$/i;
const PANEL_MENU = /^>Log,\s*Display,\s*Add,\s*dElete,\s*Modify,\s*Config,\s*Filesys,\s*Quit\?\s*$/i;
const BDT_MENU = /^>Display,\s*Edit,\s*Quit\?\s*$/i;
const EMPTY_ERROR = /^E3\(0x0003\)\s*-\s*not found\s*$/i;
const SECRET_FIELD = /password|passphrase|secret|credential|community(?:\s+string)?|private\s+key/i;

function linesOf(text) {
  if (typeof text !== 'string') throw new TypeError('Report text must be a string.');
  return text.split(/\r\n|\n|\r/).map((raw, index) => ({ raw, lineNumber: index + 1 }));
}
function titleText(raw) {
  return raw.trim().replace(/^\d{1,2}\/\d{1,2}\/\d{2,4}\s+[A-Za-z]{3}\s+/, '')
    .replace(/\s+\d{1,2}:\d{2}(?::\d{2})?\s*$/, '').trim();
}
function isSearch(raw) { return /^Search for <.*>$/i.test(raw.trim()); }
function isMenu(raw, menus) { return menus.some(menu => menu.test(raw.trim())); }
function isInitialEcho(raw) { return /^\S{1,256}$/.test(raw.trim()); }
function incompleteWarnings(complete, warnings) {
  if (!complete) warnings.push('The expected report title, headers, and standalone End of report were not all observed.');
}
function emptyCategory(lines, menu) {
  const errors = lines.filter(line => EMPTY_ERROR.test(line.raw.trim()));
  if (!errors.length) return null;
  let seenError = false;
  let returned = false;
  const unparsedLines = [];
  for (const line of lines) {
    const value = line.raw.trim();
    if (!value) continue;
    if (EMPTY_ERROR.test(value)) { seenError = true; continue; }
    if (seenError && menu.test(value)) { returned = true; continue; }
    if (!seenError && isInitialEcho(value)) continue;
    unparsedLines.push(line);
  }
  const complete = errors.length === 1 && returned && !unparsedLines.length;
  return { complete, empty: complete, warnings: complete ? [] : ['An incomplete or ambiguous not-found response was observed.'], unparsedLines };
}
function makeField(field, value, line, occurrence, context = null) {
  const secret = SECRET_FIELD.test(field) && value.trim() !== '';
  return {
    field, value: secret ? '[REDACTED]' : value,
    raw: secret ? line.raw.replace(/(:)[\s\S]*$/, '$1 [REDACTED]') : line.raw,
    lineNumber: line.lineNumber, occurrence, context,
    ...(secret ? { redacted: true } : {}),
  };
}
function getField(fields, names) {
  const accepted = names.map(name => name.toLowerCase());
  const found = fields.filter(field => accepted.includes(field.field.toLowerCase()));
  const distinct = [...new Set(found.map(field => field.value.trim()))];
  return distinct.length === 1 ? distinct[0] : null;
}
function normalizeIPv4(value) {
  if (typeof value !== 'string' || !/^\s*\d{1,3}\s*\.\s*\d{1,3}\s*\.\s*\d{1,3}\s*\.\s*\d{1,3}\s*$/.test(value)) return null;
  const octets = value.split('.').map(part => Number(part.trim()));
  return octets.every(part => part >= 0 && part <= 255) ? octets.join('.') : null;
}
function parsePort(value) {
  if (typeof value !== 'string' || !/^(?:\d+|0x[\da-f]+)$/i.test(value.trim())) return null;
  const port = Number(value.trim());
  return Number.isSafeInteger(port) && port >= 1 && port <= 65535 ? port : null;
}

/** Discover only options explicitly advertised by the FLN menu. */
function discoverDrivers(menuText) {
  const lines = linesOf(menuText);
  const candidates = lines.map(line => line.raw.trim()).filter(line => /^>.+,\s*Quit\?$/i.test(line));
  if (candidates.length !== 1) throw new Error('Expected one unambiguous FLN driver menu.');
  const labels = candidates[0].slice(1, -1).split(',').map(label => label.trim()).filter(label => !/^Quit$/i.test(label));
  if (!labels.length) throw new Error('The FLN menu advertised no driver options.');
  const known = new Map([
    ['bacnet', { name: 'BACnet', key: 'B' }], ['tec', { name: 'TEC', key: 'T' }],
    ['uc', { name: 'UC', key: 'U' }], ['modbus', { name: 'Modbus', key: 'M' }],
    ['lon', { name: 'LON', key: 'L' }],
  ]);
  const used = new Set();
  return labels.map(label => {
    const canonical = known.get(label.toLowerCase());
    const hotkeys = label.match(/[A-Z]/g) || [];
    let driver;
    // A single capital letter is the terminal's explicit shortcut, even when
    // it appears inside a familiar label. Known acronym casing is a fallback,
    // not permission to override an explicitly advertised different shortcut.
    if (hotkeys.length === 1 && /^[A-Za-z][A-Za-z0-9 _-]*$/.test(label)) {
      driver = { name: canonical?.name || label, key: hotkeys[0] };
    } else if (canonical) {
      driver = canonical;
    } else {
      throw new Error(`Cannot determine an unambiguous advertised hotkey for FLN option "${label}".`);
    }
    if (used.has(driver.key)) throw new Error(`The FLN menu repeats hotkey "${driver.key}".`);
    used.add(driver.key);
    return { ...driver };
  });
}

function fieldsFromColumns(headers, values, line) {
  const occurrences = new Map();
  return headers.map((header, index) => {
    const occurrence = (occurrences.get(header) || 0) + 1;
    occurrences.set(header, occurrence);
    return makeField(header, values[index], line, occurrence);
  });
}
function canonicalDevice(fields, line, fieldPanel) {
  const name = getField(fields, ['Device name', 'BACnet Device Name', 'TEC name', 'UC name', 'Modbus Device Name', 'LON Device Name', 'Name']);
  return {
    name,
    applicationNumber: getField(fields, ['Application Number', 'Application number', 'Application', 'App Number', 'App No', 'App']),
    master: getField(fields, ['Master', 'Master, Slave']),
    applicationStatus: getField(fields, ['Application Status']),
    instance: getField(fields, ['Device Instance', 'Device Instance Number', 'Instance']),
    networkNumber: getField(fields, ['NetNum', 'Device NetNum', 'Network Number', 'Device Network Number']),
    mac: getField(fields, ['MAC', 'Device MAC', 'MAC Address', 'Device MAC Address']),
    status: getField(fields, ['Device Status', 'Status']),
    fieldPanel, fields, raw: line.raw, lineNumber: line.lineNumber,
  };
}

function parseDeviceList(text, { driver } = {}) {
  const lines = linesOf(text);
  const empty = emptyCategory(lines, DEVICE_MENU);
  if (empty) return { ...empty, devices: [] };
  const devices = [], warnings = [], unparsedLines = [];
  let title = false, ended = false, header = false, bacnetLayout = false;
  let headers = null, fieldPanel = null;
  const expectedName = typeof driver === 'string' ? driver : driver?.name;
  for (const line of lines) {
    const value = line.raw.trim();
    if (!value) continue;
    if (ended) { if (!isMenu(value, [DEVICE_MENU])) unparsedLines.push(line); continue; }
    const heading = /^(.+?) LOG REPORT$/i.exec(titleText(value));
    if (heading && (!expectedName || heading[1].toLowerCase() === expectedName.toLowerCase())) { title = true; continue; }
    if (!title) { if (!isInitialEcho(value)) unparsedLines.push(line); continue; }
    if (END.test(value)) { ended = true; continue; }
    if (RULE.test(value) || isSearch(value)) continue;
    if (/^"Field panel"$/i.test(value)) continue;
    const panel = /^"([^"\r\n]+)"$/.exec(value);
    if (panel) { fieldPanel = panel[1]; continue; }
    if (/^BACnet Device Name\s+Application\s+Device$/i.test(value)) continue;
    if (/^Master\s+Number\s+Status\s+Instance\s+NetNum\s+MAC\s+Status$/i.test(value)) {
      headers = ['Device name', 'Master', 'Application Number', 'Application Status', 'Device Instance', 'NetNum', 'MAC', 'Device Status'];
      bacnetLayout = true; header = true; continue;
    }
    // Other driver layouts are accepted only when one explicit header row and
    // each data row have the same multi-space/tab-delimited column structure.
    // Packed/multiline layouts not evidenced here remain unparsed.
    const columns = value.split(/ {2,}|\t+/).map(part => part.trim());
    if (!header && columns.length >= 2 && /^(?:(?:BACnet\s+Device|TEC|UC|Modbus\s+Device|LON\s+Device|Device)\s+)?Name$/i.test(columns[0])) {
      headers = columns; header = true; continue;
    }
    if (!header) { unparsedLines.push(line); continue; }
    let values;
    if (bacnetLayout) {
      const row = /^(\S+)\s+(YES|NO)\s+(\d+)\s+(\S+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(\S+)$/i.exec(value);
      if (row) values = row.slice(1);
    } else if (columns.length === headers.length) values = columns;
    if (!values) { unparsedLines.push(line); continue; }
    const fields = fieldsFromColumns(headers, values, line);
    const device = canonicalDevice(fields, line, fieldPanel);
    if (!device.name) { unparsedLines.push(line); continue; }
    devices.push(device);
  }
  const seen = new Set();
  for (const device of devices) {
    if (seen.has(device.name)) warnings.push(`Duplicate device identifier "${device.name}" was retained.`);
    seen.add(device.name);
  }
  const complete = title && header && ended;
  incompleteWarnings(complete, warnings);
  return { complete, empty: complete && !devices.length && !unparsedLines.length, devices, warnings, unparsedLines };
}

function parseFields(text, kind) {
  const lines = linesOf(text), fields = [], warnings = [], unparsedLines = [], sections = [];
  const occurrences = new Map();
  let title = false, ended = false, structuredHeader = false, section = null, note = null;
  const menus = kind === 'panel' ? [PANEL_MENU] : [EDIT_MENU];
  const add = (field, value, line, context) => {
    const occurrence = (occurrences.get(field) || 0) + 1;
    occurrences.set(field, occurrence);
    fields.push(makeField(field, value, line, occurrence, context));
  };
  for (const line of lines) {
    const value = line.raw.trim();
    if (!value) continue;
    if (ended) { if (!isMenu(value, menus)) unparsedLines.push(line); continue; }
    const heading = titleText(value);
    if ((kind === 'panel' && /^FIELD PANEL CONFIGURATION REPORT$/i.test(heading)) ||
        (kind === 'device' && /^(?!POINT\b).+ LOOK REPORT$/i.test(heading))) { title = true; continue; }
    if (!title) { if (!isInitialEcho(value)) unparsedLines.push(line); continue; }
    if (END.test(value)) {
      if (note) { unparsedLines.push(...note.lines); note = null; }
      ended = true; continue;
    }
    if (RULE.test(value) || isSearch(value)) continue;
    if (/^Field\s{2,}Value$/i.test(value)) { structuredHeader = true; continue; }
    if (kind === 'device' && !structuredHeader) { unparsedLines.push(line); continue; }
    if (note) {
      note.lines.push(line);
      note.depth += (value.match(/\(/g) || []).length - (value.match(/\)/g) || []).length;
      if (note.depth === 0) {
        add('Note', note.lines.map(item => item.raw.trim()).join(' '), { raw: note.lines.map(item => item.raw).join('\n'), lineNumber: note.lines[0].lineNumber }, note.context);
        note = null;
      }
      continue;
    }
    if (/^\(Note\b/i.test(value)) {
      const depth = (value.match(/\(/g) || []).length - (value.match(/\)/g) || []).length;
      if (depth === 0) add('Note', value, line, section);
      else if (depth > 0) note = { lines: [line], depth, context: section };
      else unparsedLines.push(line);
      continue;
    }
    const fieldMatch = /^(\s*)([^:]+?)\s*:\s*(.*?)\s*$/.exec(line.raw);
    if (fieldMatch) {
      const label = fieldMatch[2].trim();
      const indent = fieldMatch[1].length;
      if (!indent) section = null;
      add(label, fieldMatch[3], line, section);
      if (/Settings$/i.test(label)) section = label;
      continue;
    }
    if (/^[\w /#()-]+Settings$/i.test(value)) {
      section = value; sections.push({ name: value, raw: line.raw, lineNumber: line.lineNumber }); continue;
    }
    unparsedLines.push(line);
  }
  if (note) unparsedLines.push(...note.lines);
  const complete = title && ended && (kind === 'panel' || structuredHeader);
  incompleteWarnings(complete, warnings);
  return { complete, fields, sections, warnings, unparsedLines };
}

function parseDeviceLook(text) {
  const result = parseFields(text, 'device');
  return {
    ...result,
    name: getField(result.fields, ['Device system name', 'BACnet Device name', 'TEC name', 'UC name', 'Device name']),
    applicationNumber: getField(result.fields, ['Application number']),
    instance: getField(result.fields, ['BACnet Device Instance Number', 'Device Instance Number']),
  };
}

function parseSubpoints(text) {
  const lines = linesOf(text);
  const empty = emptyCategory(lines, SUBPOINT_MENU);
  if (empty) return { ...empty, subpoints: [] };
  const unparsedLines = [], prepared = [];
  let title = false, header = false, ended = false;
  for (const line of lines) {
    const value = line.raw.trim();
    prepared.push('');
    if (!value) continue;
    if (ended) { if (!isMenu(value, [SUBPOINT_MENU])) unparsedLines.push(line); continue; }
    if (/^.+ SUBPOINT DISPLAY REPORT$/i.test(titleText(value))) { title = true; continue; }
    if (!title) { if (!isInitialEcho(value)) unparsedLines.push(line); continue; }
    if (END.test(value)) { ended = true; prepared[prepared.length - 1] = line.raw; continue; }
    if (RULE.test(value) || isSearch(value)) continue;
    if (/^(?:BACnet Device|TEC|UC|Modbus Device|LON Device|Device) name$/i.test(value)) continue;
    if (/^:Suffix \(Description\)\s+Value(?:\/State)?\s+(?:State|Status)\s+Priority$/i.test(value)) { header = true; continue; }
    if (!header) { unparsedLines.push(line); continue; }
    prepared[prepared.length - 1] = line.raw;
  }
  // Intentionally use the parser's gap-delimited mode: the display header is
  // centered one character to the right of its actual value column on observed
  // firmware. Fixed slicing at that header would truncate a leading digit.
  const parsed = parsePointList(prepared.join('\n'));
  const subpoints = [];
  for (const point of parsed.points) {
    if (!point.parent || !point.suffix) { unparsedLines.push({ raw: point.raw, lineNumber: point.lineNumber }); continue; }
    subpoints.push({ ...point, device: point.parent });
  }
  unparsedLines.push(...parsed.unparsedLines);
  unparsedLines.sort((a, b) => a.lineNumber - b.lineNumber);
  const warnings = parsed.warnings.filter(warning => !/No "End of report"|without any recognized point rows/.test(warning));
  const complete = title && header && ended;
  incompleteWarnings(complete, warnings);
  return { complete, empty: complete && !subpoints.length && !unparsedLines.length, subpoints, warnings, unparsedLines };
}

function parsePanelDirectory(text) {
  const panels = [], warnings = [], unparsedLines = [], lines = linesOf(text);
  let title = false, header = false, ended = false;
  const scope = [];
  for (const line of lines) {
    const value = line.raw.trim();
    if (!value) continue;
    if (ended) { if (!isMenu(value, [PANEL_MENU])) unparsedLines.push(line); continue; }
    if (/^FIELD PANEL LOG REPORT$/i.test(titleText(value))) { title = true; continue; }
    if (!title) { if (!isInitialEcho(value)) unparsedLines.push(line); continue; }
    if (END.test(value)) { ended = true; continue; }
    if (RULE.test(value) || /^<".*" to ".*">$/i.test(value)) continue;
    if (/^Field panel\s{2,}State$/i.test(value)) { header = true; continue; }
    const group = /^(\s*)<([^<>]+)>\s*$/.exec(line.raw);
    if (group) {
      const indent = group[1].length;
      while (scope.length && scope[scope.length - 1].indent >= indent) scope.pop();
      scope.push({ name: group[2], indent });
      continue;
    }
    if (!header) { unparsedLines.push(line); continue; }
    const row = /^\s*(>)?\s*(\S+)\s{2,}(\S(?:.*\S)?)\s*$/.exec(line.raw);
    if (!row) { unparsedLines.push(line); continue; }
    const selector = row[2];
    panels.push({ selector, name: /^\d+$/.test(selector) ? null : selector, instance: /^\d+$/.test(selector) ? selector : null,
      local: !!row[1], directoryState: row[3].trim(), scope: scope.map(item => item.name), raw: line.raw, lineNumber: line.lineNumber });
  }
  const seen = new Set();
  for (const panel of panels) {
    if (seen.has(panel.selector)) warnings.push(`Duplicate panel selector "${panel.selector}" was retained.`);
    seen.add(panel.selector);
  }
  if (panels.filter(panel => panel.local).length > 1) warnings.push('More than one directory row is marked as the local panel.');
  const complete = title && header && ended;
  incompleteWarnings(complete, warnings);
  return { complete, panels, warnings, unparsedLines };
}

function parsePanelInfo(text) {
  const result = parseFields(text, 'panel');
  const firmware = getField(result.fields, ['Firmware revision']);
  const networkType = getField(result.fields, ['Network Type']);
  const protocols = new Set();
  for (const value of [firmware, networkType]) {
    if (/\bBACnet\b/i.test(value || '')) protocols.add('BACnet');
    if (/\bAPOGEE\b|\bP2\b/i.test(value || '')) protocols.add('APOGEE');
  }
  const protocol = protocols.size === 1 ? [...protocols][0] : null;
  if (protocols.size > 1) result.warnings.push('Firmware and network fields give conflicting BACnet/APOGEE protocol indicators.');
  const instance = getField(result.fields, ['Device Instance Number', 'BACnet Device Instance Number']) ||
    (protocol === 'BACnet' ? getField(result.fields, ['Field panel address']) : null);
  const ipText = getField(result.fields, ['IP Address']);
  const udpText = getField(result.fields, ['UDP Port']);
  const ip = ipText === null ? null : normalizeIPv4(ipText);
  const udpPort = udpText === null ? null : parsePort(udpText);
  if (ipText !== null && ip === null) result.warnings.push('The reported IP Address is not a valid, unambiguous IPv4 address.');
  if (udpText !== null && udpPort === null) result.warnings.push('The reported UDP Port is not a valid, unambiguous port.');
  return { ...result, nodeName: getField(result.fields, ['Node name', 'Host name', 'Hostname']), instance, protocol, ip, udpPort };
}

function parseBdt(text) {
  const lines = linesOf(text), entries = [], warnings = [], unparsedLines = [];
  let title = false, header = false, ended = false, instance = null, panelSelector = null;
  const tuples = new Set();
  const address = '(\\d{1,3}\\s*\\.\\s*\\d{1,3}\\s*\\.\\s*\\d{1,3}\\s*\\.\\s*\\d{1,3})';
  const rowPattern = new RegExp(`^${address}\\s+${address}\\s+(\\S+)\\s*$`);
  for (const line of lines) {
    const value = line.raw.trim();
    if (!value) continue;
    if (ended) { if (!isMenu(value, [BDT_MENU])) unparsedLines.push(line); continue; }
    if (/^BACnet BBMD Address Report$/i.test(titleText(value))) { title = true; continue; }
    if (!title) { if (!isInitialEcho(value)) unparsedLines.push(line); continue; }
    if (END.test(value)) { ended = true; continue; }
    if (RULE.test(value)) continue;
    const selected = /^<([^<>]+)>$/.exec(value);
    if (selected) {
      if (panelSelector !== null && panelSelector !== selected[1]) unparsedLines.push(line);
      panelSelector = selected[1]; instance = /^\d+$/.test(panelSelector) ? panelSelector : null; continue;
    }
    if (/^IP Address\s{2,}Netmask\s{2,}UDP Port$/i.test(value)) { header = true; continue; }
    if (!header) { unparsedLines.push(line); continue; }
    const row = rowPattern.exec(value);
    const ip = row && normalizeIPv4(row[1]);
    const netmask = row && normalizeIPv4(row[2]);
    const udpPort = row && parsePort(row[3]);
    if (!row || !ip || !netmask || udpPort === null) { unparsedLines.push(line); continue; }
    const key = `${ip}|${netmask}|${udpPort}`;
    if (tuples.has(key)) { warnings.push(`Duplicate BDT entry ${key} was deduplicated.`); continue; }
    tuples.add(key); entries.push({ ip, netmask, udpPort });
  }
  const complete = title && header && ended && panelSelector !== null;
  incompleteWarnings(complete, warnings);
  return { complete, entries, warnings, unparsedLines, instance, panelSelector };
}

module.exports = { discoverDrivers, parseDeviceList, parseDeviceLook, parseSubpoints, parsePanelDirectory, parsePanelInfo, parseBdt, normalizeIPv4 };
