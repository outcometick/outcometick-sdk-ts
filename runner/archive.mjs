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
import { deflateRawSync } from 'node:zlib';

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

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
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

  // MS-DOS epoch: 1980-01-01 00:00:00. A constant, for reproducibility.
  const DOS_TIME = 0;
  const DOS_DATE = 0x0021;

  for (const { name, data } of entries) {
    const nameBuf = Buffer.from(name, 'utf8');
    const raw = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8');
    const deflated = raw.length > 256 ? deflateRawSync(raw, { level: 9 }) : null;
    const useDeflate = deflated != null && deflated.length < raw.length;
    const body = useDeflate ? deflated : raw;
    const method = useDeflate ? 8 : 0;
    const crc = crc32(raw);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);          // version needed
    local.writeUInt16LE(0x0800, 6);      // UTF-8 names
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);

    chunks.push(local, nameBuf, body);

    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(0x02014b50, 0);
    dir.writeUInt16LE(20, 4);            // version made by
    dir.writeUInt16LE(20, 6);            // version needed
    dir.writeUInt16LE(0x0800, 8);
    dir.writeUInt16LE(method, 10);
    dir.writeUInt16LE(DOS_TIME, 12);
    dir.writeUInt16LE(DOS_DATE, 14);
    dir.writeUInt32LE(crc, 16);
    dir.writeUInt32LE(body.length, 20);
    dir.writeUInt32LE(raw.length, 24);
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
    central.push(dir, nameBuf);

    offset += local.length + nameBuf.length + body.length;
  }

  const centralBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([...chunks, centralBuf, end]);
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
];

/**
 * Assemble the archive a customer downloads.
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
 */
export async function buildArchive({ runId, report, trades, fills, logs }) {
  const entries = [
    { name: 'report.json', data: `${JSON.stringify(report, null, 2)}\n` },
    { name: 'trades.csv', data: toCsv(trades, TRADE_COLUMNS) },
    { name: 'fills.csv', data: toCsv(fills, FILL_COLUMNS) },
    { name: 'equity.csv', data: toCsv(report.equity ?? [], ['ts_ms', 'equity']) },
    {
      name: 'calibration.csv',
      data: toCsv(report.calibration ?? [], ['bucket', 'implied', 'realized', 'edge_cents', 'trades']),
    },
    { name: 'coverage.json', data: `${JSON.stringify(report.coverage ?? {}, null, 2)}\n` },
    { name: 'logs.txt', data: logs ?? '' },
  ];

  // Checksums last, over everything above.
  const sums = entries
    .map(({ name, data }) => {
      const buf = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8');
      return `${createHash('sha256').update(buf).digest('hex')}  ${name}`;
    })
    .join('\n');
  entries.push({ name: 'sha256sums.txt', data: `${sums}\n` });

  return zip(entries);
}

export { randomUUID };
