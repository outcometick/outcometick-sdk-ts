// The report archive: one zip, built by hand.
//
// One zip and not a folder of links was an explicit product decision — a
// customer should be able to drop the whole thing into a notebook and have
// every number reproducible from what is inside it.
//
// Written without a zip dependency because the format's stored (uncompressed)
// variant is about eighty lines, and this runs on the machine that executes
// untrusted code: every package on that host is attack surface, and a zip
// library is one that parses attacker-adjacent data. Deflate is skipped
// deliberately — CSVs compress well, but "the archive is 3x bigger" is a much
// cheaper problem than "the archive is subtly corrupt".

import { createHash, randomUUID } from 'node:crypto';
import { deflateRawSync, createDeflateRaw } from 'node:zlib';
import { createReadStream, createWriteStream } from 'node:fs';
import { stat, rm, mkdtemp, readFile } from 'node:fs/promises';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

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
 * A file writer that cannot take the process down.
 *
 * A WriteStream's `error` with no listener kills Node, and the obvious
 * backpressure idiom — `once('drain')` — never settles when the error comes
 * instead of the drain. A full disk (ENOSPC) while the worker writes a
 * customer's fills would then kill the worker with the run still leased.
 * Here the listener is attached at open, and every wait races the event it
 * wants against `error`, so a disk failure rejects the current step only.
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
 * STORE unless DEFLATE actually helped. One rule for both writers below, so
 * the in-memory and the streaming archive are the same bytes.
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
  // Multiplication, not `<< 16`: JavaScript's bitwise operators are signed
  // 32-bit, and 0o100644 << 16 overflows to a negative that writeUInt32LE
  // rejects outright.
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
 * Build a zip from a list of {name, data}.
 *
 * Uses DEFLATE where it helps and STORE where it does not, decided per entry by
 * measuring rather than guessing — a compressed entry that came out larger is
 * stored instead.
 *
 * Timestamps are fixed rather than taken from the clock. Two runs of the same
 * strategy over the same range must produce byte-identical output, and a zip
 * carrying "now" in every local header would break that for no benefit.
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
 * The same zip as `zip()`, written to `outPath` without holding any entry in
 * memory. An entry is `{ name, data }` (string/Buffer) or `{ name, file }`.
 *
 * The fill log of a busy strategy is hundreds of MB; building it as a string,
 * then a Buffer, then a deflated Buffer is what made the worker's memory the
 * limit on how much a strategy may trade. Each file entry is read twice — once
 * to CRC, hash and deflate it into a scratch file, once to copy the chosen
 * body — so the local header can carry real sizes exactly as `zip()` writes
 * them (no data descriptors: the format stays byte-identical).
 *
 * Returns the sha256 of every entry's raw bytes, by name.
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

/** Rows to CSV with a fixed column order, so a diff between runs is meaningful. */
/**
 * A UTF-8 byte-order mark.
 *
 * Excel opens a .csv as the system ANSI code page unless the file says
 * otherwise, and the only thing it accepts as saying otherwise is this. The
 * symptom was a calibration bucket reading `0.30 釴?0.40` — an en dash, three
 * UTF-8 bytes, read as GBK. That is not a Chinese-locale problem: it is every
 * non-ASCII byte in every one of these files, including the `tag` a strategy
 * puts on its own fills, which we do not control at all.
 *
 * Parsers that do not expect it see one stray character on the first header;
 * `encoding='utf-8-sig'` is the standard remedy. A spreadsheet that mangles
 * the whole file is the worse failure, and it is the one that was happening.
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
export const fillCsvLine = (fill) => csvLine(fill, FILL_COLUMNS);

/**
 * The whole equity curve, rounded as report.equity is; that one is thinned.
 * A generator over a sorted list of references: the curve for millions of
 * trades is never materialised as objects.
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
 * Assemble the archive a customer downloads, into `outPath`.
 *
 * THE SOURCE IS NOT IN IT. It used to be, so that a report could be tied back
 * to the exact code that produced it — "which version of my strategy was
 * this?" is the first question anyone asks a week later. That question is now
 * answered by `source_sha256` in report.json instead: the same identification,
 * without handing back a copy of the code. Shipping the strategy inside the
 * deliverable made a report something you cannot forward to anyone.
 *
 * sha256sums.txt covers every other entry, so the whole thing is verifiable
 * without trusting the transport.
 *
 * `fillsCsv` is a file already in fills.csv format (FILLS_CSV_HEADER, then one
 * fillCsvLine per row): the worker writes it while it streams the fill log off
 * disk, so the fills are never all in memory at once.
 */
export async function writeArchive({ outPath, report, trades, fillsCsv, logs }) {
  const scratch = await mkdtemp(path.join(path.dirname(outPath), '.archive-'));
  try {
    const tradesCsv = path.join(scratch, 'trades.csv');
    const equityCsv = path.join(scratch, 'equity.csv');
    await writeCsvFile(tradesCsv, trades, TRADE_COLUMNS);
    // FROM THE FULL TRADE LIST, not report.equity — that one is thinned for
    // the page. Same rows and rounding the report used to carry in full.
    await writeCsvFile(equityCsv, fullEquity(trades), ['ts_ms', 'equity']);
    const entries = [
      { name: 'report.json', data: `${JSON.stringify(report, null, 2)}\n` },
      { name: 'trades.csv', file: tradesCsv },
      { name: 'fills.csv', file: fillsCsv },
      { name: 'equity.csv', file: equityCsv },
      {
        name: 'calibration.csv',
        data: toCsv(report.calibration ?? [], ['bucket', 'implied', 'realized', 'edge_cents', 'trades']),
      },
      { name: 'coverage.json', data: `${JSON.stringify(report.coverage ?? {}, null, 2)}\n` },
      { name: 'logs.txt', data: logs ?? '' },
    ];
    // Checksums last, over everything above — computed by writeZip as it
    // writes each entry, so no entry is read a third time.
    const names = entries.map((e) => e.name);
    entries.push({
      name: 'sha256sums.txt',
      data: (sha) => `${names.map((n) => `${sha[n]}  ${n}`).join('\n')}\n`,
    });
    await writeZip(outPath, entries, { scratchDir: scratch });
    return { path: outPath, bytes: (await stat(outPath)).size };
  } catch (err) {
    // A half-written archive is garbage that can be most of a gigabyte, and
    // the stale sweep only runs at worker start: left here, one full disk
    // becomes every following run failing on the same full disk.
    await rm(outPath, { force: true });
    throw err;
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

/**
 * The archive as a Buffer, from in-memory trades and fills. For `ot run` and
 * tests; the worker uses writeArchive directly. Same bytes either way — this
 * is writeArchive with the fills spelled out to a file first.
 */
export async function buildArchive({ report, trades, fills, logs }) {
  const dir = await mkdtemp(path.join(tmpdir(), 'ot-archive-'));
  try {
    const fillsCsv = path.join(dir, 'fills.csv');
    await writeCsvFile(fillsCsv, fills ?? [], FILL_COLUMNS);
    const outPath = path.join(dir, 'report.zip');
    await writeArchive({ outPath, report, trades, fillsCsv, logs });
    return await readFile(outPath);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export { randomUUID };
