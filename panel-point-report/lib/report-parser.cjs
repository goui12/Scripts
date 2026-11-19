'use strict';

// Pure text parsers: no sockets, commands, files, or equipment interaction.
// Unknown or ambiguous text is preserved, never silently interpreted as a field.

const END_OF_REPORT = /^End of report\.?$/i;
const NUMBER_TOKEN = '[+-]?(?:\\d+(?:\\.\\d*)?|\\.\\d+)(?:[eE][+-]?\\d+)?';
const NUMBER_WITH_UNIT = new RegExp(`^(${NUMBER_TOKEN})(?:[ \\t]+(\\S(?:.*\\S)?))?$`);

function reportLines(text) {
  if (typeof text !== 'string') {
    throw new TypeError('Report text must be a string.');
  }
  return text.split(/\r\n|\n|\r/).map((raw, index) => ({
    raw,
    lineNumber: index + 1,
  }));
}

function isEndMarker(raw) {
  return END_OF_REPORT.test(raw.trim());
}

function readPointPrefix(raw) {
  const prefix = /^\s*(\S+)\s+\(/.exec(raw);
  if (!prefix) return null;
  const opening = prefix[0].length - 1;
  let depth = 1;
  for (let index = opening + 1; index < raw.length; index += 1) {
    if (raw[index] === '(') depth += 1;
    if (raw[index] === ')') depth -= 1;
    if (depth === 0) {
      // Do not join a description directly to the value column.
      if (!/^[ \t]+/.test(raw.slice(index + 1))) return null;
      return {
        point: prefix[1],
        description: raw.slice(opening + 1, index).trim(),
        tail: raw.slice(index + 1).trim(),
      };
    }
  }
  return null;
}

function readColumns(tail) {
  // The two rightmost multi-space/tab gaps delimit status and priority. This
  // also preserves spaces inside a multiword unit or a nonnumeric value.
  const gaps = Array.from(tail.matchAll(/ {2,}|\t+/g));
  if (gaps.length < 2) return null;
  const statusGap = gaps[gaps.length - 2];
  const priorityGap = gaps[gaps.length - 1];
  const originalValue = tail.slice(0, statusGap.index).trim();
  const status = tail.slice(statusGap.index + statusGap[0].length, priorityGap.index).trim();
  const priority = tail.slice(priorityGap.index + priorityGap[0].length).trim();
  if (!originalValue || !status || !priority) return null;
  return { originalValue, status, priority };
}

function parseIdentifier(text) {
  let identifier = text.trim();
  let description = null;
  const descriptionStart = identifier.indexOf(' (');
  if (descriptionStart !== -1) {
    const descriptionText = identifier.slice(descriptionStart + 1);
    let depth = 0;
    for (let index = 0; index < descriptionText.length; index += 1) {
      if (descriptionText[index] === '(') depth += 1;
      if (descriptionText[index] === ')') depth -= 1;
      if (depth < 0 || (depth === 0 && index !== descriptionText.length - 1)) return null;
    }
    if (depth !== 0 || !descriptionText.endsWith(')')) return null;
    description = descriptionText.slice(1, -1).trim();
    identifier = identifier.slice(0, descriptionStart).trim();
  }
  if (!identifier || /[()]/.test(identifier)) return null;
  const colon = identifier.indexOf(':');
  if (colon === -1 && /\s/.test(identifier)) return null;
  if (colon !== -1 && (!identifier.slice(colon + 1).trim() || /\s/.test(identifier.slice(0, colon)))) return null;
  return { identifier, description };
}

function listLayout(raw) {
  const value = raw.indexOf('Value/State');
  const status = raw.indexOf('Status', value + 1);
  const priority = raw.indexOf('Priority', status + 1);
  return value > 0 && status > value && priority > status ? { value, status, priority } : null;
}

function readFixedListRow(raw, layout) {
  const name = parseIdentifier(raw.slice(0, layout.value));
  const originalValue = raw.slice(layout.value, layout.status).trim();
  const status = raw.slice(layout.status, layout.priority).trim();
  const priority = raw.slice(layout.priority).trim();
  if (!name || !originalValue || !status || !priority) return null;
  return { ...name, originalValue, status, priority };
}

function readLooseListRow(raw) {
  const prefix = readPointPrefix(raw);
  if (prefix) {
    const columns = readColumns(prefix.tail);
    if (columns) return { identifier: prefix.point, description: prefix.description, ...columns };
  }
  const trimmed = raw.trim();
  const gap = / {2,}|\t+/.exec(trimmed);
  if (!gap) return null;
  const name = parseIdentifier(trimmed.slice(0, gap.index));
  const columns = readColumns(trimmed.slice(gap.index + gap[0].length));
  return name && columns ? { ...name, ...columns } : null;
}

function parseValue(valueColumn) {
  const qualified = /^\?\s+(.+)$/.exec(valueColumn);
  const qualifier = qualified ? '?' : null;
  const valueText = qualified ? qualified[1].trim() : valueColumn;
  const numeric = NUMBER_WITH_UNIT.exec(valueText);
  if (numeric) {
    const value = Number(numeric[1]);
    // Preserve large integers/overflow rather than silently changing their value.
    const underflowed = value === 0 && /[1-9]/.test(numeric[1].split(/[eE]/)[0]);
    if (Number.isFinite(value) && !underflowed && (!Number.isInteger(value) || Number.isSafeInteger(value))) {
      return { value, engineeringUnit: numeric[2] || null, qualifier, ambiguity: null };
    }
    return {
      value: numeric[1],
      engineeringUnit: numeric[2] || null,
      qualifier,
      ambiguity: 'Numeric value cannot be represented safely; its original token was retained as text.',
    };
  }
  return {
    value: valueText,
    engineeringUnit: null,
    qualifier,
    ambiguity: /\s/.test(valueText)
      ? 'Cannot confidently separate a nonnumeric value from an engineering unit; the entire value column was retained.'
      : null,
  };
}

/**
 * Parse a listing such as:
 * POINT1 (Room Temp)     60.05 DEG F     -N-     NONE
 *
 * `originalValue` is the complete original value/unit column, not a guessed
 * value token. `complete` reports only whether an explicit end marker appeared;
 * callers must also inspect warnings and unparsedLines for coverage limitations.
 */
function parsePointList(text) {
  const points = [];
  const warnings = [];
  const unparsedLines = [];
  const pointOccurrences = new Map();
  const lines = reportLines(text);
  let complete = false;
  let layout = null;
  let currentParent = null;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line.raw.trim()) continue;
    if (!complete && isEndMarker(line.raw)) {
      complete = true;
      continue;
    }
    if (complete) {
      unparsedLines.push(line);
      continue;
    }
    if (/^\s*[-=]+\s*$/.test(line.raw)) {
      unparsedLines.push(line);
      continue;
    }
    const detectedLayout = listLayout(line.raw);
    if (detectedLayout) {
      layout = detectedLayout;
      unparsedLines.push(line); // Keep framing text available for source review.
      continue;
    }
    const row = layout ? readFixedListRow(line.raw, layout) : readLooseListRow(line.raw);
    if (!row) {
      const candidateParent = line.raw.trim();
      if (candidateParent && !/\s|:|[()]/.test(candidateParent) && !/^[-=]+$/.test(candidateParent)) {
        let nextIndex = index + 1;
        while (nextIndex < lines.length && !lines[nextIndex].raw.trim()) nextIndex += 1;
        const nextLine = lines[nextIndex];
        const nextRow = nextLine && (layout ? readFixedListRow(nextLine.raw, layout) : readLooseListRow(nextLine.raw));
        if (nextRow && nextRow.identifier.startsWith(':')) {
          currentParent = candidateParent;
          continue;
        }
      }
      unparsedLines.push(line);
      currentParent = null;
      const looksLikeFixedRow = layout && parseIdentifier(line.raw.slice(0, layout.value)) && line.raw.slice(layout.value).trim();
      if (looksLikeFixedRow || /^\s*\S+\s+\(/.test(line.raw)) {
        warnings.push(`Line ${line.lineNumber}: Point-looking row could not be parsed without guessing.`);
      }
      continue;
    }

    let point = row.identifier;
    let parent = null;
    let suffix = null;
    if (point.startsWith(':')) {
      suffix = point.slice(1).trim();
      if (!currentParent) {
        warnings.push(`Line ${line.lineNumber}: Suffix row has no observed parent; no full identifier was guessed.`);
        unparsedLines.push(line);
        continue;
      }
      parent = currentParent;
      point = `${parent}:${suffix}`;
    } else {
      currentParent = null;
      const colon = point.indexOf(':');
      if (colon !== -1) {
        parent = point.slice(0, colon);
        suffix = point.slice(colon + 1).trim();
      }
    }

    const parsedValue = parseValue(row.originalValue);
    const occurrence = (pointOccurrences.get(point) || 0) + 1;
    pointOccurrences.set(point, occurrence);
    if (occurrence > 1) {
      warnings.push(`Line ${line.lineNumber}: Duplicate point "${point}" (occurrence ${occurrence}); every row was retained.`);
    }
    if (parsedValue.ambiguity) {
      warnings.push(`Line ${line.lineNumber}, point "${point}": ${parsedValue.ambiguity}`);
    }
    points.push({
      point,
      parent,
      suffix,
      description: row.description,
      value: parsedValue.value,
      originalValue: row.originalValue,
      engineeringUnit: parsedValue.engineeringUnit,
      qualifier: parsedValue.qualifier,
      status: row.status,
      priority: row.priority,
      raw: line.raw,
      lineNumber: line.lineNumber,
    });
  }

  if (!complete) warnings.push('No "End of report" marker found; the report is incomplete.');
  if (complete && points.length === 0) warnings.push('The report ended without any recognized point rows.');
  return { points, warnings, unparsedLines, complete };
}

/**
 * Observed colon-delimited fields and the exact standalone enabled-alarming
 * statement are interpreted. Unknown labels and repeated keys remain in source order. Within the observed
 * Field/Value layout, indentation records a child field's context. No fixed
 * field list, value type, or continuation grammar is inferred; unsupported
 * lines remain in unparsedLines for review.
 */
function parsePointDetail(text) {
  const fields = [];
  const unparsedLines = [];
  const occurrences = new Map();
  const contextStack = [];
  const lines = reportLines(text);
  const detailHeader = /^\s*Field[ \t]{2,}Value\s*$/;
  const hasStructuredHeader = lines.some(line => detailHeader.test(line.raw));
  let complete = false;
  let structuredLayout = false;

  for (const line of lines) {
    if (!line.raw.trim()) continue;
    if (!complete && isEndMarker(line.raw)) {
      complete = true;
      continue;
    }
    if (complete) {
      unparsedLines.push(line);
      continue;
    }
    if (detailHeader.test(line.raw)) {
      structuredLayout = true;
      unparsedLines.push(line);
      continue;
    }
    if (hasStructuredHeader && !structuredLayout) {
      unparsedLines.push(line);
      continue;
    }
    if (/^\s*\d{1,2}\/\d{1,2}\/\d{4}\s+[A-Za-z]{3}\s+POINT LOOK REPORT\s+\d{1,2}:\d{2}\s*$/.test(line.raw)) {
      unparsedLines.push(line);
      continue;
    }
    // Search echoes contain colons inside the point identifier, but are not
    // detail fields. Leave them visible without treating them as data.
    if (/^\s*Search for <.*>\s*$/.test(line.raw)) {
      unparsedLines.push(line);
      continue;
    }
    // This observed standalone statement is a section, not a continuation of
    // Access group(s). Preserve it as an explicit affirmative field, and let
    // the same indentation logic attach its event/notification children.
    // Do not infer YES/NO from spelling, case or wording variants.
    const alarmStatement = structuredLayout && line.raw.trim() === 'Point enabled for alarming';
    const match = alarmStatement
      ? [line.raw, /^(\s*)/.exec(line.raw)[1], 'Point enabled for alarming', 'YES']
      : /^(\s*)([^:]+?)\s*:\s*(.*?)\s*$/.exec(line.raw);
    if (!match || !match[2].trim()) {
      unparsedLines.push(line);
      // An unknown section/continuation may change the hierarchy. Do not carry
      // a previous field's context across it and mislabel subsequent children.
      if (structuredLayout) contextStack.length = 0;
      continue;
    }
    const indentation = structuredLayout ? match[1].replace(/\t/g, '        ').length : 0;
    while (contextStack.length && contextStack[contextStack.length - 1].indentation >= indentation) {
      contextStack.pop();
    }
    const context = contextStack.length ? contextStack.map(entry => entry.field).join(' / ') : null;
    const field = match[2].trim();
    const occurrence = (occurrences.get(field) || 0) + 1;
    occurrences.set(field, occurrence);
    fields.push({
      field,
      value: match[3],
      raw: line.raw,
      lineNumber: line.lineNumber,
      occurrence,
      context,
    });
    contextStack.push({ field, indentation });
  }
  return { fields, unparsedLines, complete };
}

module.exports = { parsePointList, parsePointDetail };
