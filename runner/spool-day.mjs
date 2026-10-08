// Decoding a day's rows into per-market event files, and reading one market
// back. Shared by the worker (runner/fetch-data.mjs, reading the mirror) and
// `ot run` (cli/local-data.mjs, reading a local archive).
//
// A SEPARATE MODULE ON PURPOSE: fetch-data.mjs imports the R2 mirror client and
// with it @aws-sdk, which the public npm package does not ship. This file may
// import only node builtins and modules that are themselves in the package
// (events.mjs, data-taxonomy.mjs) — build-packages.mjs checks the closure.

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
 * Rows buffered per market before they are appended to its spool file.
 *
 * The trade-off is between held memory and syscalls: 512 rows across a few
 * hundred markets is on the order of a hundred megabytes resident, and about
 * four thousand appends for a day of BTC. Both are comfortable; holding the
 * day instead is not.
 */
const SPOOL_FLUSH_ROWS = 512;

/**
 * `<ASSET>|<interval>` — the market-day key without its date, which the caller
 * already knows. Joined with the day it is the `asset|day|interval` the run is
 * billed on, so coverage and billing speak about the same unit.
 */
function marketDayKey(m) {
  const mk = m?.market ?? m;
  if (!mk?.asset) return null;
  return `${String(mk.asset).toUpperCase()}|${mk.interval ?? 'none'}`;
}

/**
 * Is this stored event line a trade?
 *
 * By prefix, not by parsing: a cached polymarket BTC day is ~1.4M lines and
 * parsing each one is the 9.5s/day the decoded cache exists to remove. It holds
 * because spoolDay writes `JSON.stringify(event)` and eventsFromRow builds every
 * event with `kind` as its FIRST key — pinned by a test in trades-superset.test.mjs.
 */
export const isTradeLine = (line) => line.startsWith('{"kind":"trade"');

/**
 * One market's event lines, read back from the file spoolDay wrote. Gunzipped
 * as they are read; only this market is ever resident. Shared by the worker's
 * job stream and `ot run`.
 *
 * `dropTrades`: the day was decoded with trades the run did not declare (see
 * decodeDatasetsFor) — leave them out, so the strategy is fed exactly what a
 * decode of its own declaration would have produced.
 */
export async function readEventLines(file, { dropTrades = false } = {}) {
  const raw = createReadStream(file);
  let input = raw;
  if (file.endsWith('.gz')) {
    const gunzip = createGunzip();
    input = gunzip;
    // `pipeline`, not `.pipe` — an error on `raw` with nothing listening is
    // process death.
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
 * Decode one day's feed into per-market event files, and judge each market.
 *
 * SHARED by the queue (fetchDay, reading the mirror) and `ot run`
 * (loadLocalDay, reading a local archive): the two differ only in where the
 * rows come from. Every event is appended to its market's spool file as it is
 * decoded and the day is never held in memory — `ot run` used to hold it, and
 * one day of Predict BTC (full-ladder snapshots, ~12KB each once parsed) is
 * ~6GB of heap. Sharing the function, not copying it, is the point: the CLI and
 * the worker have drifted apart nine times, every time over a rule written twice.
 *
 * `feed` is [{ path, bytes, rows: () => AsyncIterable<row> }], in read order.
 * Writes `<day>-<market>.jsonl.gz` into `eventsDir` for every usable market.
 */
export async function spoolDay({ day, markets, bySlug, throttle = null, eventsDir, feed, pause = null }) {
  // SPOOLED TO DISK, not accumulated in memory.
  //
  // One day of one asset is about two million events once the book, its deltas
  // and the trades are all in scope — measured, on 2026-08-20 for BTC. Holding
  // them as objects to sort at the end is well over the 2GB a worker has, and
  // the failure is an out-of-memory kill mid-run rather than a slow day. Each
  // event is appended to its market's own file as it is read; the sort then
  // happens one market at a time, where the working set is a few thousand rows.
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

  // Any spool this day created is this day's to clean up. A read that throws
  // half way leaves the caller free to carry on with the next day — but not to
  // carry on with a directory full of partial files nothing will ever read.
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
        for (const [marketId, ev] of eventsFromRow(f.path, row, markets, bySlug, throttle)) {
          // COVERAGE IS A FACT ABOUT EVENTS, NOT ABOUT FILES. Recorded here,
          // where an event actually exists, rather than from the feed list.
          // An object that is present but empty, truncated, or whose every row
          // is dropped as unreadable leaves the replay on the old book — and a
          // file-level flag would report it as refined. That is harder to spot
          // than a missing object, because nothing about the run looks unusual.
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
  // EVERY market in the metadata, not only the ones that produced a row.
  //
  // Iterating the spool skipped the emptiest case of all: a market that exists
  // in the archive but decoded to nothing never reached `counts`, so it was
  // never judged, never counted as dropped, and — if any other market that day
  // succeeded — never appeared in coverage either. The market with no data at
  // all was the one market we said nothing about.
  for (const marketId of markets.keys()) {
    // A checkpoint for the prewarm: this half reads, sorts and gzips every
    // market of the day after the archive is fully read, so a gate on the
    // archive bytes alone would not cover it.
    if (pause) await pause();
    const market = markets.get(marketId);
    const part = partOf(marketId);
    // Read back ONE market and sort it. The spool is a concatenation of
    // time-ordered runs, one per source file, so it needs ordering — but only
    // this market's worth is ever resident.
    const events = [];
    if (counts.has(marketId)) {
      for (const line of (await readFile(part, 'utf8')).split('\n')) {
        if (!line) continue;
        try { events.push(JSON.parse(line)); } catch { /* a torn line is not a fact */ }
      }
      await rm(part, { force: true });
    }

    const { events: inWindow, up_px: upPx, down_px: downPx } = market
      ? finaliseMarket(events, market)
      : { events: [], up_px: null, down_px: null };
    // ONE predicate, shared with `ot run` — see marketUnusable.
    const why = marketUnusable(market, inWindow);
    if (why) {
      // asset and day travel with it: billing is per market-day, so the caller
      // cannot decide anything about a gap it cannot locate.
      unusable.push({ market_id: marketId, asset: market?.asset ?? null, day, why });
      continue;
    }

    // GZIPPED ON DISK, always — the reader gunzips as it feeds and never keeps
    // a plain copy. Measured: a polymarket BTC market-day is 573 MB of decoded
    // events that gzip to 57 MB, and `OT_KEEP_WORKDIR` holds every run's copy,
    // so this is the difference between a sixteen-day run leaving 9 GB behind
    // and leaving 0.9. It also makes a cache hit a hard link rather than a
    // decompress-and-rewrite.
    const file = `${day}-${marketId}.jsonl.gz`;
    // WRITTEN TO A TEMP NAME AND RENAMED, never opened in place. A cache hit
    // hard-links cache files into this same directory under these same names,
    // so an in-place write here would truncate the CACHE's inode — corrupting
    // a stored day while its manifest stayed valid, and serving the wreckage
    // to every later run. Renaming replaces the name, never the bytes behind
    // someone else's link.
    const tmpFile = `${file}.${process.pid}.tmp`;
    await pipeline(
      Readable.from(inWindow.map((e) => `${JSON.stringify(e)}\n`)),
      createGzip(),
      createWriteStream(path.join(eventsDir, tmpFile)),
    );
    await rename(path.join(eventsDir, tmpFile), path.join(eventsDir, file));
    out.push({
      market: {
        market_id: market.market_id,
        asset: market.asset,
        interval: market.interval,
        strike: market.strike,
        outcome: market.outcome,
        open_ts_ms: market.open_ts_ms,
        close_ts_ms: market.close_ts_ms,
      },
      eventsFile: file,
      stream: market.stream,
      day,
      up_px: upPx,
      down_px: downPx,
    });
  }
  } catch (err) {
    await sweepParts();
    throw err;
  }

  // Reported whether or not the day produced anything.
  //
  // Returning this only when the day was a total loss meant one good market hid
  // every dropped one: coverage said the market-day was scanned, the customer
  // was billed for it, and the markets we could not price simply vanished from
  // the report. A partial gap is still a gap, and it is a fact the customer is
  // owed.
  return { out, unusable, bboSeen, bytes };
}
