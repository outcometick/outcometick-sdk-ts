// Report ZIP writer with fixed timestamps for reproducible output.
// Entries use Deflate when it reduces size, otherwise stored bytes.
// Implemented here to avoid an additional ZIP dependency on the runner.

import { createHash, randomUUID } from 'node:crypto';
import { deflateRawSync, createDeflateRaw } from 'node:zlib';
import { createReadStream, createWriteStream } from 'node:fs';
import { stat, rm, mkdtemp, readFile } from 'node:fs/promises';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { MARKET_COLUMNS } from './engine/report.mjs';

/** CRC-32, the checksum the zip format uses. Table built once. */
const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

/** Feed `buf` into a running CRC state; start with -1, finish with crcDone. */
function crcUpdate(c, buf) {
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return c;
}
const crcDone = (c) => (c ^ -1) >>> 0;
function crc32(buf) {
  return crcDone(crcUpdate(-1, buf));
}

/**
 * File writer with backpressure and error handling.
 * An error rejects a pending drain or finish wait, preventing unhandled stream
 * errors and waits that would otherwise never settle.
 */
export function openWriter(file) {
  const out = createWriteStream(file);
  let failed = null;
  out.on('error', (err) => { failed ??= err; });
  const waitFor = (event) => new Promise((resolve, reject) => {
    if (failed) { reject(failed); return; }
    const onErr = (err) => { out.off(event, onEvent); reject(err); };
    const onEvent = () => { out.off('error', onErr); resolve(); };
    out.once('error', onErr);
    out.once(event, onEvent);
  });
  return {
    async write(chunk) {
      if (failed) throw failed;
      if (!out.write(chunk)) await waitFor('drain');
    },
    async close() {
      if (failed) throw failed;
      const done = waitFor('finish');
      out.end();
      await done;
    },
    destroy() { out.destroy(); },
  };
}

// MS-DOS epoch: 1980-01-01 00:00:00. A constant, for reproducibility.
const DOS_TIME = 0;
const DOS_DATE = 0x0021;

/**
 * Use Deflate only for entries over 256 bytes that compress smaller.
 * Both writers use this rule to produce identical archives.
 */
const useDeflateFor = (rawLen, deflatedLen) => rawLen > 256 && deflatedLen < rawLen;

function localHeader({ nameBuf, method, crc, csize, usize }) {
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);          // version needed
  local.writeUInt16LE(0x0800, 6);      // UTF-8 names
  local.writeUInt16LE(method, 8);
  local.writeUInt16LE(DOS_TIME, 10);
  local.writeUInt16LE(DOS_DATE, 12);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(csize, 18);
  local.writeUInt32LE(usize, 22);
  local.writeUInt16LE(nameBuf.length, 26);
  local.writeUInt16LE(0, 28);
  return local;
}

function centralHeader({ nameBuf, method, crc, csize, usize, offset }) {
  const dir = Buffer.alloc(46);
  dir.writeUInt32LE(0x02014b50, 0);
  dir.writeUInt16LE(20, 4);            // version made by
  dir.writeUInt16LE(20, 6);            // version needed
  dir.writeUInt16LE(0x0800, 8);
  dir.writeUInt16LE(method, 10);
  dir.writeUInt16LE(DOS_TIME, 12);
  dir.writeUInt16LE(DOS_DATE, 14);
  dir.writeUInt32LE(crc, 16);
  dir.writeUInt32LE(csize, 20);
  dir.writeUInt32LE(usize, 24);
  dir.writeUInt16LE(nameBuf.length, 28);
  dir.writeUInt16LE(0, 30);            // extra
  dir.writeUInt16LE(0, 32);            // comment
  dir.writeUInt16LE(0, 34);            // disk
  dir.writeUInt16LE(0, 36);            // internal attrs
  // Use multiplication: a signed 32-bit shift of 0o100644 overflows,
  // and writeUInt32LE rejects the negative result.
  dir.writeUInt32LE(0o100644 * 0x10000, 38); // external attrs (0644, regular file)
  dir.writeUInt32LE(offset, 42);
  return Buffer.concat([dir, nameBuf]);
}

function endRecord(count, centralLen, centralOffset) {
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(count, 8);
  end.writeUInt16LE(count, 10);
  end.writeUInt32LE(centralLen, 12);
  end.writeUInt32LE(centralOffset, 16);
  end.writeUInt16LE(0, 20);
  return end;
}

/**
 * Build a ZIP from {name, data} entries.
 * Use Deflate when it reduces size. Fixed timestamps make output deterministic.
 */
export function zip(entries) {
  const chunks = [];
  const central = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const nameBuf = Buffer.from(name, 'utf8');
    const raw = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8');
    const deflated = raw.length > 256 ? deflateRawSync(raw, { level: 9 }) : null;
    const useDeflate = deflated != null && useDeflateFor(raw.length, deflated.length);
    const body = useDeflate ? deflated : raw;
    const h = { nameBuf, method: useDeflate ? 8 : 0, crc: crc32(raw), csize: body.length, usize: raw.length };
    const local = localHeader(h);
    chunks.push(local, nameBuf, body);
    central.push(centralHeader({ ...h, offset }));
    offset += local.length + nameBuf.length + body.length;
  }
  const centralBuf = Buffer.concat(central);
  return Buffer.concat([...chunks, centralBuf, endRecord(entries.length, centralBuf.length, offset)]);
}

/**
 * Write a ZIP to `outPath`. Entries are {name, data} (string/Buffer) or
 * {name, file}; data may also be a function of the hashes written so far.
 * File entries are streamed: first CRC, hash and compress to scratch, then copy
 * the chosen body. Known sizes avoid data descriptors and match `zip()` output.
 * Returns SHA-256 hashes of each entry's raw bytes, keyed by name.
 */
export async function writeZip(outPath, entries, { scratchDir = path.dirname(outPath) } = {}) {
  const out = openWriter(outPath);
  const write = (buf) => out.write(buf);
  const central = [];
  const sha = {};
  let offset = 0;
  try {
    for (const entry of entries) {
      const nameBuf = Buffer.from(entry.name, 'utf8');
      let h;
      if (entry.file == null) {
        const data = typeof entry.data === 'function' ? entry.data(sha) : entry.data;
        const raw = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8');
        sha[entry.name] = createHash('sha256').update(raw).digest('hex');
        const deflated = raw.length > 256 ? deflateRawSync(raw, { level: 9 }) : null;
        const useDeflate = deflated != null && useDeflateFor(raw.length, deflated.length);
        const body = useDeflate ? deflated : raw;
        h = { nameBuf, method: useDeflate ? 8 : 0, crc: crc32(raw), csize: body.length, usize: raw.length };
        await write(localHeader(h)); await write(nameBuf); await write(body);
      } else {
        const scratch = path.join(scratchDir, `.z-${randomUUID()}`);
        try {
          let crc = -1;
          let usize = 0;
          const hash = createHash('sha256');
          const tap = new Transform({
            transform(chunk, _enc, cb) {
              crc = crcUpdate(crc, chunk); usize += chunk.length; hash.update(chunk); cb(null, chunk);
            },
          });
          await pipeline(createReadStream(entry.file), tap, createDeflateRaw({ level: 9 }), createWriteStream(scratch));
          const csizeDeflated = (await stat(scratch)).size;
          const useDeflate = usize > 256 && useDeflateFor(usize, csizeDeflated);
          sha[entry.name] = hash.digest('hex');
          h = { nameBuf, method: useDeflate ? 8 : 0, crc: crcDone(crc), csize: useDeflate ? csizeDeflated : usize, usize };
          await write(localHeader(h)); await write(nameBuf);
          for await (const chunk of createReadStream(useDeflate ? scratch : entry.file)) await write(chunk);
        } finally {
          await rm(scratch, { force: true });
        }
      }
      central.push(centralHeader({ ...h, offset }));
      offset += 30 + nameBuf.length + h.csize;
    }
    const centralBuf = Buffer.concat(central);
    await write(centralBuf);
    await write(endRecord(entries.length, centralBuf.length, offset));
    await out.close();
  } catch (err) {
    out.destroy();
    throw err;
  }
  return sha;
}

/** Escape one CSV field. */
function csvField(v) {
  if (v == null) return '';
  const s = String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** CSV rows use a fixed column order for reproducible diffs. */
/**
 * UTF-8 BOM for spreadsheet encoding detection, including non-ASCII tags.
 * Python readers can use encoding="utf-8-sig" to strip it from the first header.
 */
const BOM = '\uFEFF';

export function toCsv(rows, columns) {
  const out = [columns.join(',')];
  for (const row of rows) out.push(columns.map((c) => csvField(row[c])).join(','));
  return `${BOM}${out.join('\n')}\n`;
}

const TRADE_COLUMNS = [
  'market_id', 'side', 'size', 'entry_px', 'exit_px', 'pnl', 'fees',
  'opened_ms', 'closed_ms', 'how', 'outcome',
];
const FILL_COLUMNS = [
  'ts_ms', 'market_id', 'side', 'action', 'requested', 'filled', 'unfilled',
  'avg_px', 'worst_px', 'quoted_px', 'levels_walked', 'fee', 'realised', 'tag',
  'liquidity', 'order_id', 'queue_ahead_at_join', 'queue_ahead_at_fill', 'time_in_queue_ms',
  'markout_1s', 'markout_10s', 'markout_60s', 'markout_settle',
];

// Generic-data runs append valuation columns; archive runs use the base columns.
const GENERIC_TRADE_COLUMNS = [
  ...TRADE_COLUMNS, 'label', 'mark_px', 'marked_size', 'marked_pnl', 'mark_source',
  'mark_ts_ms', 'mark_age_ms', 'mark_missing',
];
const isGeneric = (report) => report?.data_kind === 'generic';

/**
 * Fix fills.csv columns before writing: base fields, `label` for generic data,
 * and fields enabled by enginePolicyFor.
 * Keep in sync with engineFillFields in the harnesses.
 */
export function fillColumnsFor({ generic = false, engine = null } = {}) {
  const cols = [...FILL_COLUMNS];
  if (generic) cols.push('label');
  if (engine && (engine.fok || engine.order_rules || engine.quote_guard)) cols.push('reject_reason');
  if (engine && engine.maker_rebate != null) cols.push('rebate');
  return cols;
}

/** The same, read back from a finished report. */
const fillColumnsOf = (report) => fillColumnsFor({
  generic: isGeneric(report),
  engine: report?.orders ? {
    fok: report.orders.fok, order_rules: report.orders.order_rules, quote_guard: report.orders.quote_guard,
    maker_rebate: report.orders.maker_rebate == null ? null : report.orders.maker_rebate.rate,
  } : null,
});

/** One CSV line in the format toCsv writes. */
const csvLine = (row, columns) => columns.map((c) => csvField(row[c])).join(',');

/**
 * `toCsv`, written to a file row by row instead of built as one string.
 * Byte-identical output: BOM + header, '\n' between rows, trailing '\n'.
 */
export async function writeCsvFile(file, rows, columns) {
  const out = openWriter(file);
  try {
    await out.write(`${BOM}${columns.join(',')}`);
    for (const row of rows) await out.write(`\n${csvLine(row, columns)}`);
    await out.write('\n');
    await out.close();
  } catch (err) {
    out.destroy();
    throw err;
  }
}

export const FILLS_CSV_HEADER = `${BOM}${FILL_COLUMNS.join(',')}`;
/** A fill as one fills.csv line (no newline), for writers that stream. */
export const fillCsvLine = (fill, columns = FILL_COLUMNS) => csvLine(fill, columns);
/** The header line for a run's own columns (fillColumnsFor). */
export const fillsCsvHeader = (columns) => `${BOM}${columns.join(',')}`;

/**
 * Generate the full equity curve with report.equity rounding.
 * Sort trade references and yield points without materialising the curve.
 */
function* fullEquity(trades) {
  const closed = (trades ?? []).filter((t) => Number.isFinite(t.pnl));
  const ordered = closed.sort((a, b) => (a.closed_ms ?? 0) - (b.closed_ms ?? 0));
  let acc = 0;
  for (const t of ordered) {
    acc += t.pnl;
    yield { ts_ms: t.closed_ms, equity: Number.isFinite(acc) ? Number(acc.toFixed(2)) : null };
  }
}

/**
 * Write the report archive to `outPath`. Strategy source is identified by
 * source_sha256 in report.json and is not included.
 * sha256sums.txt covers all other entries.
 * `fillsCsv` is an existing file with FILLS_CSV_HEADER and fillCsvLine rows,
 * allowing fills to be streamed from disk.
 */
export async function writeArchive({ outPath, report, trades, fillsCsv, logs, markets = null, record = null }) {
  const scratch = await mkdtemp(path.join(path.dirname(outPath), '.archive-'));
  try {
    const tradesCsv = path.join(scratch, 'trades.csv');
    const equityCsv = path.join(scratch, 'equity.csv');
    await writeCsvFile(tradesCsv, trades, isGeneric(report) ? GENERIC_TRADE_COLUMNS : TRADE_COLUMNS);
    // Use the full trade list; report.equity is thinned for display.
    await writeCsvFile(equityCsv, fullEquity(trades), ['ts_ms', 'equity']);
    const entries = [
      { name: 'report.json', data: `${JSON.stringify(report, null, 2)}\n` },
      { name: 'trades.csv', file: tradesCsv },
      { name: 'fills.csv', file: fillsCsv },
      { name: 'equity.csv', file: equityCsv },
      // Include all replayed markets, including those with no trades, when supplied.
      ...(markets ? [{ name: 'markets.csv', data: toCsv(markets, MARKET_COLUMNS) }] : []),
      // Include account and per-instance time-grid valuations when recording produced points.
      ...(record?.points?.length ? [
        { name: 'record.csv', data: toCsv(record.points, ['ts', 'value', 'position_value', 'open_positions']) },
        { name: 'record_markets.csv', data: toCsv(record.samples, ['key', 'ts', 'cash', 'marked', 'position_value', 'final']) },
      ] : []),
      {
        name: 'calibration.csv',
        data: toCsv(report.calibration ?? [], ['bucket', 'implied', 'realized', 'edge_cents', 'trades']),
      },
      { name: 'coverage.json', data: `${JSON.stringify(report.coverage ?? {}, null, 2)}\n` },
      { name: 'logs.txt', data: logs ?? '' },
    ];
    // Append checksums after writeZip has hashed the other entries, avoiding another read.
    const names = entries.map((e) => e.name);
    entries.push({
      name: 'sha256sums.txt',
      data: (sha) => `${names.map((n) => `${sha[n]}  ${n}`).join('\n')}\n`,
    });
    await writeZip(outPath, entries, { scratchDir: scratch });
    return { path: outPath, bytes: (await stat(outPath)).size };
  } catch (err) {
    // Remove incomplete archives immediately so failed writes do not fill the disk.
    await rm(outPath, { force: true });
    throw err;
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

/**
 * Return the archive as a Buffer from in-memory trades and fills.
 * Uses writeArchive after writing fills to a temporary file, producing the same bytes.
 */
export async function buildArchive({ report, trades, fills, logs, markets = null, record = null }) {
  const dir = await mkdtemp(path.join(tmpdir(), 'ot-archive-'));
  try {
    const fillsCsv = path.join(dir, 'fills.csv');
    await writeCsvFile(fillsCsv, fills ?? [], fillColumnsOf(report));
    const outPath = path.join(dir, 'report.zip');
    await writeArchive({ outPath, report, trades, fillsCsv, logs, markets, record });
    return await readFile(outPath);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export { randomUUID };
