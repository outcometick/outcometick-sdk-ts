// The submitter's own CSV, turned into rows a strategy can read.
//
// `ctx.ext('my_signal')` hands back a point-in-time view over these. They ride
// the same stream as market events and reference rows, so the same guarantee
// holds structurally: a row the replay has not reached is not in the process.
//
// This is the one data path where the CONTENT is written by the submitter. It
// is theirs and only they see it, so the risk is not what it says — it is what
// a malformed file does quietly. A column read as the wrong thing produces a
// series that is empty, or shifted in time, and neither errors.

/**
 * Which column holds the timestamp, and what unit it is in.
 *
 * Guessed from the data rather than demanded in the manifest, because a
 * required `ts_column` is a thing to get wrong on the first try — but the guess
 * is CHECKED, and a file we cannot read confidently is refused rather than
 * half-parsed. Silently picking the wrong column gives a series stamped in 1970
 * that is simply never visible, which looks like "my signal did nothing".
 */
export const TIMESTAMP_NAMES = /^(ts_ms|ts|time|timestamp|date|datetime|open_time)$/i;

/**
 * Column names the wire format owns.
 *
 * These are not stylistic. `kind` and `name` are how the worker routes a row:
 * it emits `{ kind: 'ext', name, ...row }`, so a column called `kind` makes the
 * spread overwrite it and the harness stops treating the row as a series at all
 * — `kind: 'tick'` would feed it to on_tick as a market event. A column called
 * `name` sends the row to a feed nobody declared, leaving the declared one
 * empty. And a second `ts_ms` beside a `timestamp` column silently replaces the
 * timestamp everything is ordered by.
 *
 * Refused rather than renamed: a column quietly renamed is a column the
 * strategy cannot find.
 */
export const RESERVED_COLUMNS = ['kind', 'name'];

/**
 * `ts_ms` is ours as well — but only when it is NOT the timestamp column.
 *
 * A file with `timestamp,ts_ms` used to have its ts_ms column silently
 * overwritten by the parsed time, so the strategy read a different number than
 * the one submitted. Refused rather than quietly rewritten: their data changing
 * under them is worse than being told to rename a column.
 */
export const TS_COLUMN = 'ts_ms';

export function detectTimestamp(header, firstRow) {
  const named = header.findIndex((h) => TIMESTAMP_NAMES.test(h.trim()));
  const idx = named >= 0 ? named : 0;
  const sample = String(firstRow?.[idx] ?? '').trim();
  if (!sample) return null;

  // An UNNAMED first column has to look like a time, not merely like a number.
  // An `id` or a row counter parses happily as an epoch near 1970, every row
  // then falls outside the replay window, and the strategy gets a series that
  // is declared and permanently empty — the exact "accepted then silently
  // empty" this whole path exists to avoid.
  if (named < 0 && /^\d+$/.test(sample)) {
    const asMs = sample.length >= 16 ? Number(sample) / 1000
      : sample.length >= 13 ? Number(sample)
        : Number(sample) * 1000;
    // 2000-01-01 .. 2100-01-01. Anything outside that is not a timestamp
    // someone meant to give us.
    if (!(asMs > 946_684_800_000 && asMs < 4_102_444_800_000)) return null;
  }

  // Epoch, in whatever unit. Digit count is the only signal, and it is a good
  // one: seconds are 10 digits until 2286, milliseconds 13, microseconds 16.
  if (/^\d+$/.test(sample)) {
    const scale = sample.length >= 16 ? 1e-3 : sample.length >= 13 ? 1 : 1000;
    return { idx, kind: 'epoch', scale, column: header[idx] };
  }
  // ISO. Date.parse handles the shapes people actually write; anything it
  // cannot read is refused below rather than becoming NaN.
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

    // Prototype-less: these keys come from a submitted file, and `__proto__` as
    // a column name on an ordinary object is a real thing to hand a strategy.
    const row = Object.create(null);
    for (let c = 0; c < header.length; c += 1) {
      if (c === ts.idx) continue;
      const n = numOrNull(cells[c]);
      row[header[c]] = n === null ? String(cells[c] ?? '') : n;
    }
    // LAST, so a data column that also happens to be called ts_ms cannot
    // replace the timestamp every ordering and window check depends on. It is
    // still readable by the strategy — under whatever it called the timestamp
    // column — it just is not the one we sort by.
    row.ts_ms = Math.floor(at);
    rows.push(row);
  }

  if (rows.length === 0) {
    return { rows: [], problem: 'no row had a readable timestamp', tsColumn: ts.column };
  }
  // Sorted, because PointInTimeFeed walks a monotone cursor: one row out of
  // order hides every row behind it for the rest of the run.
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
 * Every series a run declared, from the files that came with the submission.
 *
 * A series that cannot be parsed is REFUSED rather than delivered empty: an
 * empty ctx.ext() reads as "my signal never fired", and the submitter would go
 * looking at their strategy instead of their file.
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
