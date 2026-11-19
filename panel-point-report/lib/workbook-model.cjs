'use strict';

// Data/layout model shared by the native PowerShell template filler and QA.
// All strings are data, never executable spreadsheet formulas.
const MAX_ROWS = 1048576;
const MAX_COLS = 16384;
const MISSING = 'Not provided';
const SHEET_NAMES = ['Panel Points', 'Subpoints', 'Panel information'];

function text(value) { return value == null ? '' : String(value); }
function safeValue(value) {
  if (value === undefined || value === null) return '';
  if (typeof value === 'number') return Number.isFinite(value) ? value : String(value);
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  const s = String(value);
  if (s.length > 32767) throw new Error('A report field exceeds the Excel cell text limit; see raw JSON.');
  return s.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '');
}
function numericStyle(value) { return typeof value === 'number' ? (Number.isInteger(value) ? 'integer' : 'number') : 'body'; }
function fieldsOf(record) {
  const data = record?.fields || record?.detail?.fields || record?.look?.fields || record?.look?.detail?.fields || [];
  return Array.isArray(data) ? data : [];
}
function fieldKey(field) {
  const ctx = Array.isArray(field.context) ? field.context.join(' / ') : text(field.context);
  return [ctx, text(field.field), (field.occurrence || 1) > 1 ? `#${field.occurrence}` : ''].filter(Boolean).join(' / ');
}
function fieldMap(record) {
  const entries = new Map();
  const counts = new Map();
  for (const f of fieldsOf(record)) {
    let key = fieldKey(f);
    if (!key) continue;
    const n = (counts.get(key) || 0) + 1;
    counts.set(key, n);
    const base = key;
    if (n > 1) key += ` [${n}]`;
    let collision = n;
    while (entries.has(key)) key = `${base} [${++collision}]`;
    // Empty reported values remain empty; missing fields get MISSING instead.
    entries.set(key, /password|secret|token|credential|passphrase|community|private[ _-]?key/i.test(text(f.field)) && text(f.value).trim() ? '[REDACTED]' : safeValue(f.value));
  }
  return entries;
}
function unionKeys(maps) { return [...new Set(maps.flatMap(m => [...m.keys()]))]; }
function headersUnique(headers) {
  const used = new Set();
  return headers.map((value, i) => {
    const base = text(value).trim() || `Field ${i + 1}`;
    let out = base.slice(0, 240), count = 1;
    while (used.has(out.toLowerCase())) out = `${base.slice(0, 228)} [${++count}]`;
    used.add(out.toLowerCase());
    return out;
  });
}
function statusText(value) {
  if (typeof value === 'string') return value;
  return text(value?.message || value?.status || value?.code);
}
function collected(value) {
  return value === 'complete' || value === 'ok' || value === 'success' || value === 'collected' || value === 'empty';
}
function successful(record) {
  if (!record) return false;
  const status = record.status ?? parsed(record).status;
  return status == null ? parsed(record).complete === true : collected(status);
}
function parsed(record) { return record?.parsed || record?.data || record || {}; }
function ipv4(value) {
  const s = text(value).replace(/\s+/g, '');
  const a = s.split('.');
  if (a.length !== 4 || a.some(x => !/^\d{1,3}$/.test(x) || +x > 255)) return '';
  return a.map(Number).join('.');
}
function sheet(name, title, context) {
  return { name, title, context, cells: [], tables: [], widths: {}, rowHeights: {}, freezeRows: 6, freezeColumns: 1, nextRow: 6 };
}
function cell(s, row, col, value, style = 'body') {
  if (row < 1 || row > MAX_ROWS || col < 1 || col > MAX_COLS) throw new Error('Workbook exceeds Excel worksheet dimensions.');
  s.cells.push({ row, col, value: safeValue(value), style });
}
function note(s, value, style = 'note') {
  const row = s.nextRow++;
  cell(s, row, 1, value, style);
  // Long notes use a merged area outside all native Excel tables.
  s.rowHeights[row] = value.length > 160 ? 44 : 30;
  s.notes = s.notes || [];
  s.notes.push({ row, firstColumn: 1, lastColumn: 8 });
}
function table(s, name, title, rawHeaders, rows, opts = {}) {
  if (title) { cell(s, s.nextRow, 1, title, 'section'); s.sectionRows = [...(s.sectionRows || []), s.nextRow++]; }
  if (opts.note) note(s, opts.note);
  const headers = headersUnique(rawHeaders);
  if (headers.length > MAX_COLS) throw new Error(`Table ${name} exceeds Excel's column limit.`);
  const startRow = s.nextRow;
  headers.forEach((h, j) => { cell(s, startRow, j + 1, h, 'header'); s.widths[j + 1] = Math.max(s.widths[j + 1] || 0, opts.widths?.[j] || 20); });
  s.rowHeights[startRow] = opts.headerHeight || 48;
  rows.forEach((row, i) => {
    if (row.length !== headers.length) throw new Error(`Table ${name} contains a nonrectangular row.`);
    row.forEach((v, j) => cell(s, startRow + i + 1, j + 1, v, opts.styles?.[i]?.[j] || numericStyle(v)));
  });
  // Header-only native tables are valid and do not manufacture a data record.
  s.tables.push({ name, startRow, endRow: startRow + rows.length, startColumn: 1, endColumn: headers.length, headers });
  s.nextRow = startRow + rows.length + 3;
  return { startRow, endRow: startRow + rows.length };
}
function base(s) {
  cell(s, 2, 1, s.title, 'title');
  cell(s, 3, 1, s.context, 'note');
  s.rowHeights[2] = 28; s.rowHeights[3] = 30;
  s.notes = [{ row: 3, firstColumn: 1, lastColumn: 8 }];
}
function pointRows(points) {
  const maps = points.map(p => fieldMap(p.detail || p));
  const keys = unionKeys(maps);
  const headers = ['Point', 'Description', 'Value', 'Engineering unit', 'Status', 'Priority', 'Qualifier', 'Look result', ...keys.map(k => `Look: ${k}`)];
  const rows = points.map((p, i) => [p.point || p.name, p.description, p.value, p.engineeringUnit, p.status, p.priority, p.qualifier, p.detail?.status || (p.detail?.complete === false ? 'Not collected' : p.detail ? 'complete' : 'Not collected'), ...keys.map(k => maps[i].has(k) ? maps[i].get(k) : MISSING)].map(safeValue));
  return { headers, rows };
}

function createWorkbookModel(report) {
  if (!report || typeof report !== 'object' || !Array.isArray(report.points)) throw new Error('A collected report with a points array is required.');
  const title = text(report.nodeName || report.panelName || report.panelId || 'Field panel');
  const captured = text(report.completedAt || report.startedAt);
  const context = `Panel ${report.panelId || 'unreported'}; source ${report.host || 'replay'}; captured ${captured}. Read-only snapshot, not simultaneous measurements.`;
  const sheets = SHEET_NAMES.map(name => sheet(name, `${title} — ${name}`, context));
  sheets.forEach(base);
  const [pointsSheet, subSheet, infoSheet] = sheets;
  const points = report.points.filter(p => !text(p.point || p.name).includes(':'));
  if (points.length !== report.points.length) throw new Error('Panel Points contains a colon identifier; export stopped.');
  const pointData = pointRows(points);
  table(pointsSheet, 'PanelPoints', '', pointData.headers, pointData.rows, { widths: [30, 34, 17, 17, 12, 12, 12] });
  pointsSheet.freezeColumns = 2;
  note(pointsSheet, `Blank cells are explicitly blank in the report. "${MISSING}" means that field was absent. All original text and unfamiliar fields remain in the accompanying JSON.`);

  const drivers = report.drivers || [];
  table(subSheet, 'DriverInventory', 'Integrated driver discovery', ['Driver', 'Menu key', 'Collection result', 'Devices', 'Subpoints'], drivers.map(d => [d.name, d.key, statusText(d.status), (d.devices || []).length, (d.subpoints || []).length]), { widths: [28, 12, 28, 14, 14], headerHeight: 32 });
  const groups = new Map();
  for (const d of drivers) {
    const devices = d.devices || [];
    const deviceNames = new Set(devices.map(x => text(x.name || x.deviceName)));
    for (const sub of d.subpoints || []) {
      const parent = text(sub.device || sub.deviceName || sub.parent);
      if (!deviceNames.has(parent)) throw new Error('A subpoint parent is missing from the device inventory; export stopped instead of guessing its application.');
    }
    for (const device of devices) {
      const name = text(device.name || device.deviceName);
      const app = text(device.applicationNumber ?? device.application ?? '') || 'Not reported';
      const key = `${d.name}\u0000${app}`;
      if (!groups.has(key)) groups.set(key, { driver: d.name, app, items: [] });
      groups.get(key).items.push({ device, subpoints: (d.subpoints || []).filter(p => text(p.device || p.deviceName || p.parent) === name) });
    }
  }
  let groupNumber = 0;
  for (const group of groups.values()) {
    const logMaps = group.items.map(({ device }) => fieldMap(device));
    const logKeys = unionKeys(logMaps);
    const maps = group.items.map(({ device }) => fieldMap(device.look || device.detail || device));
    const allKeys = unionKeys(maps);
    const suffixes = [...new Set(group.items.flatMap(x => x.subpoints.map(p => text(p.suffix || p.point?.split(':').slice(1).join(':')))))];
    if (suffixes.some(x => !x)) throw new Error('A subpoint has no suffix; export stopped.');
    const metadata = ['Device', 'Driver', 'Application', 'Master', 'Application status', 'Instance', 'Network number', 'MAC', 'Device status', 'Look result'];
    const headers = [...metadata, ...logKeys.map(k => `Device log: ${k}`), ...allKeys.map(k => `Device Look: ${k}`), ...suffixes.flatMap(s => [`${s} Value`, `${s} Unit`, `${s} Status`, `${s} Priority`])];
    const rows = group.items.map(({ device, subpoints }, i) => {
      const bySuffix = new Map();
      for (const p of subpoints) {
        const suffix = text(p.suffix || p.point?.split(':').slice(1).join(':'));
        if (bySuffix.has(suffix)) throw new Error('A device has duplicate subpoint observations; export stopped.');
        bySuffix.set(suffix, p);
      }
      return [device.name || device.deviceName, group.driver, group.app, device.master, device.applicationStatus, device.instance, device.networkNumber, device.mac, device.status, statusText(device.look?.status || device.lookStatus || 'complete'),
        ...logKeys.map(k => logMaps[i].has(k) ? logMaps[i].get(k) : MISSING),
        ...allKeys.map(k => maps[i].has(k) ? maps[i].get(k) : MISSING),
        ...suffixes.flatMap(s => { const p = bySuffix.get(s); return p ? [p.value, p.engineeringUnit, p.status, p.priority] : ['Not observed', '', '', '']; })].map(safeValue);
    });
    table(subSheet, `SubpointsGroup${++groupNumber}`, `${group.driver} — application ${group.app}`, headers, rows, { widths: [30, 16, 16, 14, 18, 18, 18, 24, 18, 22], note: 'One row per device. Each subpoint has Value, Unit, Status and Priority columns. Not observed is not zero. Device Look fields precede the subpoint columns.' });
  }
  subSheet.freezeColumns = 1;
  subSheet.freezeRows = 3;
  const colon = report.initialColonObservations || [];
  const colonData = pointRows(colon.map(p => ({ ...p, detail: { fields: [] } })));
  table(subSheet, 'OtherColonObservations', 'Other colon observations', colonData.headers.slice(0, 7), colonData.rows.map(r => r.slice(0, 7)), { widths: [32, 32, 18, 18, 12, 12, 12], note: 'From the original panel-point listing. These include panel/program address observations and are not assumed to be FLN devices. No Point Look was sent for these identifiers.' });

  const panels = report.panels || [];
  const configurations = panels.map(p => parsed(p.configuration));
  const panelMaps = configurations.map(fieldMap);
  const configKeys = unionKeys(panelMaps);
  const configHeaders = ['Panel selector', 'Local panel', 'Directory state', 'Configuration result', 'Node name', 'Protocol', 'IP address', 'UDP port', 'BDT result', 'BDT self-entry', ...configKeys.map(k => `Configuration: ${k}`)];
  const panelRows = panels.map((p, i) => {
    const c = configurations[i];
    const configOk = successful(p.configuration);
    const ip = configOk ? ipv4(c.ip || p.ip) : '';
    const bdt = parsed(p.bdt);
    const bdtOk = successful(p.bdt);
    const own = bdtOk ? (ip ? (c.udpPort == null ? 'Unknown — UDP port not collected' : (bdt.entries || []).some(e => ipv4(e.ip) === ip && +e.udpPort === +c.udpPort) ? 'Listed' : 'Not listed in returned report') : 'Unknown — panel IP not collected') : 'Not collected';
    return [p.selector, p.local ? 'Yes' : 'No', p.directoryState, statusText(p.configuration?.status) + (p.configuration?.errorCode ? ` (E${p.configuration.errorCode})` : '') + (p.configuration?.error ? `: ${statusText(p.configuration.error)}` : ''), c.nodeName || p.nodeName, c.protocol || p.protocol, ip || 'Not collected', c.udpPort ?? '', statusText(p.bdt?.status || 'Not collected'), own,
      ...configKeys.map(k => panelMaps[i].has(k) ? panelMaps[i].get(k) : MISSING)].map(safeValue);
  });
  const panelStyles = panelRows.map(row => row.map((v, j) => j === 3 && /failed|unavailable|error/i.test(text(v)) ? 'error' : j === 9 && /Not listed|Unknown|Not collected/.test(text(v)) ? 'warning' : numericStyle(v)));
  table(infoSheet, 'PanelInformation', '', configHeaders, panelRows, { widths: [22, 14, 28, 40, 28, 18, 22, 14, 22, 36], styles: panelStyles });
  infoSheet.freezeColumns = 1;
  cell(infoSheet, infoSheet.nextRow++, 1, 'BACnet Distribution Tables', 'section');
  note(infoSheet, 'Check = entry returned by that instance. Green check = returned entry matches that panel’s successfully collected IP and UDP port. Blank = absent from a successfully read table. Not collected = the query was unsuccessful or not applicable.');
  note(infoSheet, 'An empty report does not establish remote-panel health. Missing self-entries are reported without changing configuration. Rows are unique IP, Netmask and UDP Port combinations.');
  const bacnetPanels = panels.filter((p, i) => text(configurations[i].protocol || p.protocol).toLowerCase() === 'bacnet' || (p.bdt && !/not[ _-]applicable/i.test(statusText(p.bdt.status))));
  const bdtMaps = bacnetPanels.map(p => {
    const b = parsed(p.bdt), ok = successful(p.bdt);
    const entries = new Map();
    if (ok) for (const e of b.entries || []) {
      const ip = ipv4(e.ip), netmask = ipv4(e.netmask), port = Number(e.udpPort);
      if (!ip || !netmask || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error('An invalid BDT entry cannot be exported.');
      entries.set(`${ip}|${netmask}|${port}`, { ip, netmask, udpPort: port });
    }
    return { ok, entries };
  });
  const bdtEntries = new Map();
  bdtMaps.forEach(m => m.entries.forEach((v, k) => bdtEntries.set(k, v)));
  const bdtRows = [], bdtStyles = [];
  for (const [key, e] of bdtEntries) {
    const row = [e.ip, e.netmask, e.udpPort], styles = ['body', 'body', 'integer'];
    bacnetPanels.forEach((p, i) => {
      const m = bdtMaps[i], c = parsed(p.configuration);
      const member = m.ok && m.entries.has(key);
      const self = member && successful(p.configuration) && ipv4(c.ip || p.ip) === e.ip && c.udpPort != null && +c.udpPort === e.udpPort;
      row.push(!m.ok ? 'Not collected' : member ? '✓' : '');
      styles.push(!m.ok ? 'unavailable' : self ? 'selfCheck' : member ? 'check' : 'body');
    });
    bdtRows.push(row); bdtStyles.push(styles);
  }
  table(infoSheet, 'BacnetDistributionTables', '', ['IP', 'Netmask', 'UDP Port', ...bacnetPanels.map(p => text(p.selector))], bdtRows, { widths: [22, 22, 14, ...bacnetPanels.map(() => 22)], styles: bdtStyles, headerHeight: 32 });
  if (!bdtRows.length) note(infoSheet, 'No BDT entries were returned. No synthetic entry rows or self-entry checkmarks have been added.', 'warning');
  table(infoSheet, 'BdtCollectionResults', 'BDT collection results', ['Panel instance', 'Query result', 'Returned entries', 'Configuration result'], bacnetPanels.map((p, i) => [p.selector, statusText(p.bdt?.status || 'Not collected'), bdtMaps[i].ok ? bdtMaps[i].entries.size : 'Not collected', statusText(p.configuration?.status)]), { widths: [22, 30, 22, 38], headerHeight: 32 });
  const warnings = [...new Set((report.warnings || []).map(statusText))].filter(Boolean);
  if (warnings.length) {
    cell(infoSheet, infoSheet.nextRow++, 1, 'Collection warnings', 'section');
    for (const warning of warnings) note(infoSheet, warning, 'warning');
  }
  // Sheet-wide widths must not let a short lower table shrink wide metadata.
  for (const s of sheets) {
    s.widths[1] = Math.min(s.widths[1] || 28, s.name === 'Panel information' ? 28 : 34);
    for (const t of s.tables) {
      const minimum = s.rowHeights[t.startRow] || 32;
      const requiredHeader = Math.max(...t.headers.map((h, i) => Math.ceil(h.length / Math.max(8, (s.widths[i + 1] || 20) - 2)))) * 14 + 8;
      s.rowHeights[t.startRow] = Math.min(180, Math.max(minimum, requiredHeader));
    }
    const noteRows = new Set((s.notes || []).map(n => n.row));
    for (const c of s.cells) {
      if (typeof c.value !== 'string' || !c.value || noteRows.has(c.row) || ['title', 'section', 'header'].includes(c.style)) continue;
      const width = Math.max(8, (s.widths[c.col] || 20) - 2);
      const lines = c.value.split('\n').reduce((n, line) => n + Math.max(1, Math.ceil(line.length / width)), 0);
      s.rowHeights[c.row] = Math.min(409, Math.max(s.rowHeights[c.row] || 20, lines * 14 + 6));
    }
    s.maxRow = Math.max(...s.cells.map(c => c.row));
    s.maxColumn = Math.max(...s.cells.map(c => c.col), ...(s.notes || []).map(n => n.lastColumn));
    delete s.nextRow;
  }
  return { version: 1, title, capturedAt: captured, sourceHost: text(report.host), sheets };
}

module.exports = { createWorkbookModel, SHEET_NAMES, fieldMap, ipv4 };
