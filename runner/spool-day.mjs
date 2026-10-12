// Decode daily rows into per-market event files, shared by the worker and ot run.
// Keep imports limited to Node builtins and modules shipped in the public package.
// fetch-data.mjs imports the R2 client and AWS SDK, which the package omits;
// build-packages.mjs checks this module's dependency closure.

import { createReadStream, createWriteStream } from 'node:fs';
import { appendFile, mkdir, readFile, rename, rm } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGunzip, createGzip } from 'node:zlib';
import path from 'node:path';
import { classifyPath } from '../api/lib/data-taxonomy.mjs';
import { eventsFromRow, finaliseMarket, marketUnusable } from './events.mjs';

/**
 * Rows buffered per market before appending to disk.
 * 512 rows across a few hundred markets use roughly 100 MB and about
 * 4,000 appends for a BTC day.
 */
const SPOOL_FLUSH_ROWS = 512;

/** Return ASSET|interval; the caller supplies the date to form a market-day key. */
export function marketDayKey(m) {
  const mk = m?.market ?? m;
  if (!mk?.asset) return null;
  return `${String(mk.asset).toUpperCase()}|${mk.interval ?? 'none'}`;
}

/**
 * Identify trade lines by prefix. eventsFromRow puts kind first and spoolDay
 * uses JSON.stringify; trades-superset.test.mjs checks this invariant.
 * Parsing a cached BTC day's roughly 1.4M lines measured 9.5 seconds.
 */
export const isTradeLine = (line) => line.startsWith('{"kind":"trade"');

/**
 * Read one market's event lines, decompressing gzip files while reading.
 * With dropTrades, omit cached trades not declared by the run (decodeDatasetsFor),
 * matching a decode of the run's own dataset declaration.
 */
export async function readEventLines(file, { dropTrades = false } = {}) {
  const raw = createReadStream(file);
  let input = raw;
  if (file.endsWith('.gz')) {
    const gunzip = createGunzip();
    input = gunzip;
    // pipeline propagates source errors to the gunzip reader.
    pipeline(raw, gunzip).catch((err) => { if (!gunzip.destroyed) gunzip.destroy(err); });
  } else {
    raw.on('error', () => {});
  }
  const lines = [];
  const rl = createInterface({ input, crlfDelay: Infinity });
  for await (const line of rl) {
    const t = line.trim();
    if (t && !(dropTrades && isTradeLine(t))) lines.push(t);
  }
  return lines;
}

/**
 * Daily decoding uses per-market spool files rather than holding the day.
 * A Predict BTC day with full-ladder snapshots can occupy about 6 GB parsed.
 * feed entries are {path, bytes, rows: () => AsyncIterable<row>} in read order.
 * Usable markets are written to eventsDir as <day>-<market>.jsonl.gz.
 */
// Batch JSON lines into roughly 1 MB chunks for gzip. On a two-million-line
// Polymarket BTC day, per-line zlib calls spent about 80% of wall time waiting
// on threadpool work versus 4% parsing. Without flushes, chunk boundaries
// do not change the compressed bytes.
const GZIP_CHUNK_CHARS = 1 << 20;
export function* gzipChunks(events, max = GZIP_CHUNK_CHARS) {
  let buf = '';
  for (const e of events) {
    buf += `${JSON.stringify(e)}\n`;
    if (buf.length >= max) { yield buf; buf = ''; }
  }
  if (buf) yield buf;
}

/**
 * Finalise one market's spooled events into a file or an unusable reason.
 * Shared with CLI parallel decoding (cli/parallel-decode.mjs).
 */
export async function finishSpooledMarket({ day, marketId, market, events, eventsDir }) {
  const { events: inWindow, up_px: upPx, down_px: downPx } = market
    ? finaliseMarket(events, market)
    : { events: [], up_px: null, down_px: null };
  // Use the shared replay eligibility predicate.
  const why = marketUnusable(market, inWindow);
  if (why) {
    // Include asset and day so coverage can locate the gap.
    return { unusable: { market_id: marketId, asset: market?.asset ?? null, day, why } };
  }

  // Store gzip files for streaming reads and hard-linked cache reuse.
  // A measured Polymarket BTC day compressed from 573 MB to 57 MB.
  const file = `${day}-${marketId}.jsonl.gz`;
  // Write to a temporary file and rename. Existing names may be hard links
  // to cache files; writing in place would truncate the cached inode.
  const tmpFile = `${file}.${process.pid}.tmp`;
  await pipeline(
    Readable.from(gzipChunks(inWindow)),
    createGzip(),
    createWriteStream(path.join(eventsDir, tmpFile)),
  );
  await rename(path.join(eventsDir, tmpFile), path.join(eventsDir, file));
  return { out: {
    market: {
      market_id: market.market_id,
      asset: market.asset,
      interval: market.interval,
      strike: market.strike,
      outcome: market.outcome,
      open_ts_ms: market.open_ts_ms,
      close_ts_ms: market.close_ts_ms,
      // Polymarket fee metadata is used by feeFor in engine/portfolio.mjs.
      // Predict records omit the field.
      ...(market.fee !== undefined ? { fee: market.fee } : {}),
    },
    eventsFile: file,
    stream: market.stream,
    day,
    up_px: upPx,
    down_px: downPx,
  } };
}

export async function spoolDay({ day, markets, bySlug, throttle = null, eventsDir, feed, pause = null, spot = false }) {
  // Spool by market to bound memory, then sort one market at a time.
  // A BTC day with books, deltas and trades contains about two million events,
  // exceeding a 2 GB worker if held as objects.
  await mkdir(eventsDir, { recursive: true });
  const partOf = (marketId) => path.join(eventsDir, `${day}-${marketId}.part`);
  const buffers = new Map();
  const counts = new Map();
  const flush = async (key) => {
    const buf = buffers.get(key);
    if (!buf || buf.length === 0) return;
    buffers.set(key, []);
    await appendFile(partOf(key), buf.join(''));
  };
  const push = async (marketId, ev) => {
    const key = String(marketId);
    if (!markets.has(key)) return;
    let buf = buffers.get(key);
    if (!buf) { buf = []; buffers.set(key, buf); }
    buf.push(`${JSON.stringify(ev)}\n`);
    counts.set(key, (counts.get(key) ?? 0) + 1);
    if (buf.length >= SPOOL_FLUSH_ROWS) await flush(key);
  };

  // Clean up this day's partial files on failure.
  const sweepParts = async () => {
    for (const key of counts.keys()) await rm(partOf(key), { force: true }).catch(() => {});
  };

  let bytes = 0;
  // `<ASSET>|<interval>` for every market-day that produced a usable bound.
  const bboSeen = new Set();
  try {
    for (const f of feed) {
      const meta = classifyPath(f.path);
      if (meta.dataset === 'markets') continue;
      bytes += Number(f.bytes) || 0;

      for await (const row of f.rows()) {
        for (const [marketId, ev] of eventsFromRow(f.path, row, markets, bySlug, throttle, { spot })) {
          // Record BBO coverage from decoded events. File presence alone cannot
          // prove refinement when rows are empty, truncated or unreadable.
          if (ev.bbo) bboSeen.add(marketDayKey(markets.get(marketId)));
          await push(marketId, ev);
        }
      }
    }
    for (const key of [...buffers.keys()]) await flush(key);
  } catch (err) {
    await sweepParts();
    throw err;
  }

  const out = [];
  const unusable = [];
  try {
  // Check all metadata markets, including those with no decoded rows,
  // so empty markets appear in unusable coverage.
  for (const marketId of markets.keys()) {
    // Allow prewarm pauses during sorting and compression as well as archive reads.
    if (pause) await pause();
    const market = markets.get(marketId);
    const part = partOf(marketId);
    // Read and sort one market. Its spool contains a time-ordered run
    // from each source file, requiring a merge order across files.
    const events = [];
    if (counts.has(marketId)) {
      for (const line of (await readFile(part, 'utf8')).split('\n')) {
        if (!line) continue;
        try { events.push(JSON.parse(line)); } catch { /* Skip malformed spool lines. */ }
      }
      await rm(part, { force: true });
    }

    const done = await finishSpooledMarket({ day, marketId, market, events, eventsDir });
    if (done.unusable) unusable.push(done.unusable);
    else out.push(done.out);
  }
  } catch (err) {
    await sweepParts();
    throw err;
  }

  // Return unusable markets even when other markets succeeded.
  return { out, unusable, bboSeen, bytes };
}
