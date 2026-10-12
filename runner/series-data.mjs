// Parse user-supplied CSV series for ctx.ext(name). Rows join the replay
// stream at their visibility time, alongside market and reference events.
// Reject ambiguous timestamps and reserved columns before replay.

/**
 * Infer and validate the timestamp column and unit.
 * Reject ambiguous input rather than returning an empty or time-shifted series.
 */
export const TIMESTAMP_NAMES = /^(ts_ms|ts|time|timestamp|date|datetime|open_time)$/i;

/**
 * Reserve routing fields kind and name. In {kind: 'ext', name, ...row},
 * these columns would overwrite the event type or destination feed.
 * Reject collisions rather than silently renaming user columns.
 */
export const RESERVED_COLUMNS = ['kind', 'name'];

/**
 * Reserve ts_ms unless it is the selected timestamp column, so normalising
 * time cannot overwrite a separate user value.
 */
export const TS_COLUMN = 'ts_ms';

export function detectTimestamp(header, firstRow) {
  const named = header.findIndex((h) => TIMESTAMP_NAMES.test(h.trim()));
  const idx = named >= 0 ? named : 0;
  const sample = String(firstRow?.[idx] ?? '').trim();
  if (!sample) return null;

  // An unnamed first column must resemble a timestamp. Small numeric ids
  // or counters would parse near epoch 0 and fall outside the replay window.
  if (named < 0 && /^\d+$/.test(sample)) {
    const asMs = sample.length >= 16 ? Number(sample) / 1000
      : sample.length >= 13 ? Number(sample)
        : Number(sample) * 1000;
    // Accept inferred timestamps between 2000-01-01 and 2100-01-01.
    if (!(asMs > 946_684_800_000 && asMs < 4_102_444_800_000)) return null;
  }

  // Infer epoch units by digit count: seconds 10, milliseconds 13, microseconds 16.
  if (/^\d+$/.test(sample)) {
    const scale = sample.length >= 16 ? 1e-3 : sample.length >= 13 ? 1 : 1000;
    return { idx, kind: 'epoch', scale, column: header[idx] };
  }
  // Use Date.parse for ISO timestamps; reject unparseable values below.
  if (Number.isFinite(Date.parse(sample))) return { idx, kind: 'iso', scale: 1, column: header[idx] };
  return null;
}

const numOrNull = (v) => {
  const s = String(v ?? '').trim();
  if (s === '') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
};

/** Split a CSV line. Quoted fields are supported; embedded newlines are not. */
function splitLine(line) {
  const out = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const c = line[i];
    if (quoted) {
      if (c === '"') {
        if (line[i + 1] === '"') { cur += '"'; i += 1; } else quoted = false;
      } else cur += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur);
  return out;
}

/**
 * Parse one submitted series.
 *
 * @returns {{rows: object[], problem: string|null, tsColumn: string|null}}
 */
export function parseSeries(csv, { maxRows = 2_000_000 } = {}) {
  const lines = String(csv ?? '').split(/\r?\n/).filter((l) => l.trim() !== '');
  if (lines.length < 2) return { rows: [], problem: 'needs a header row and at least one row of data', tsColumn: null };

  const header = splitLine(lines[0]).map((h) => h.trim());
  if (header.some((h) => h === '')) return { rows: [], problem: 'a column has no name', tsColumn: null };
  if (new Set(header).size !== header.length) {
    return { rows: [], problem: 'two columns share a name', tsColumn: null };
  }
  const clash = header.find((h) => RESERVED_COLUMNS.includes(h.toLowerCase()));
  if (clash) {
    return {
      rows: [],
      problem: `column ${JSON.stringify(clash)} is reserved — rename it`
        + ' (kind and name are how a row is routed to your feed)',
      tsColumn: null,
    };
  }

  const first = splitLine(lines[1]);
  const ts = detectTimestamp(header, first);
  if (ts && header.some((h, i) => i !== ts.idx && h.toLowerCase() === TS_COLUMN)) {
    return {
      rows: [],
      problem: `column "${TS_COLUMN}" is the timestamp we key off — it cannot also be a data column`
        + ` (this file uses ${JSON.stringify(header[ts.idx])} for the timestamp)`,
      tsColumn: null,
    };
  }
  if (!ts) {
    return {
      rows: [],
      problem: `could not read a timestamp from the first column (${JSON.stringify(header[0])})`
        + ' — name it ts_ms, ts, time, timestamp, date or datetime, or put epoch/ISO values in column one',
      tsColumn: null,
    };
  }

  const rows = [];
  let dropped = 0;
  for (let i = 1; i < lines.length; i += 1) {
    if (rows.length >= maxRows) return { rows: [], problem: `over ${maxRows} rows`, tsColumn: ts.column };
    const cells = splitLine(lines[i]);
    const raw = String(cells[ts.idx] ?? '').trim();
    const at = ts.kind === 'epoch' ? Number(raw) * ts.scale : Date.parse(raw);
    if (!Number.isFinite(at)) { dropped += 1; continue; }

    // Use a null prototype so submitted keys such as __proto__ remain data.
    const row = Object.create(null);
    for (let c = 0; c < header.length; c += 1) {
      if (c === ts.idx) continue;
      const n = numOrNull(cells[c]);
      row[header[c]] = n === null ? String(cells[c] ?? '') : n;
    }
    // Store the selected timestamp as integer ts_ms; omit its source column.
    row.ts_ms = Math.floor(at);
    rows.push(row);
  }

  if (rows.length === 0) {
    return { rows: [], problem: 'no row had a readable timestamp', tsColumn: ts.column };
  }
  // PointInTimeFeed needs sorted rows for its monotone cursor.
  rows.sort((a, b) => a.ts_ms - b.ts_ms);
  return {
    rows,
    problem: dropped > 0 && dropped >= rows.length
      ? `${dropped} of ${dropped + rows.length} rows had no readable timestamp`
      : null,
    tsColumn: ts.column,
    dropped,
  };
}

/**
 * Load all declared series from submission files.
 * Reject parse failures instead of exposing an empty ctx.ext() feed.
 */
export function loadSeries(declared, files) {
  const byName = new Map(files.map((f) => [f.name, f.content]));
  const rowsByName = {};
  const problems = [];

  for (const s of declared ?? []) {
    const csv = byName.get(s.file);
    if (csv == null) {
      problems.push({ name: s.name, file: s.file, problem: 'file was not submitted' });
      continue;
    }
    const out = parseSeries(csv);
    if (out.problem && out.rows.length === 0) {
      problems.push({ name: s.name, file: s.file, problem: out.problem });
      continue;
    }
    rowsByName[s.name] = out.rows;
    if (out.dropped > 0) {
      problems.push({ name: s.name, file: s.file, problem: `${out.dropped} row(s) had no readable timestamp`, fatal: false });
    }
  }
  return { rowsByName, problems };
}
