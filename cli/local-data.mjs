// Reading a cloned sample archive off disk, for `ot run`.
//
// The counterpart to runner/fetch-data.mjs, which reads the same archive out of
// R2. Both go through runner/events.mjs for the row -> event mapping, because
// the docs make a promise about exactly this pair:
//
//     The identical files, same checksums, same coverage report. A backtest
//     here and a backtest on your own machine after subscribing read the same
//     bytes — that is the point of offering it.
//
// Two decoders would make that false the first time they disagreed, and the
// disagreement would be silent.

import { createReadStream } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { pipeline } from 'node:stream/promises';
import { createGunzip } from 'node:zlib';
import path from 'node:path';

import { classifyPath } from '../api/lib/data-taxonomy.mjs';
import {
  archiveDatasetsFor, fileMatchesRun, normalizeIntervals, settlementPathsFor, orderedFeed,
} from '../api/lib/backtest-datasets.mjs';
import {
  indexMarkets, eventsFromRow, finaliseMarket, parseRow, buildSlugIndex, marketUnusable,
  sortMarketsForReplay,
  makeBookThrottle,
} from '../runner/events.mjs';

/**
 * Every file under a directory, as archive-relative paths.
 *
 * Symlinks are skipped rather than followed, in both directions: a symlinked
 * directory is not descended into and a symlinked file is not read. `--data`
 * points at a directory the user cloned from the internet, and git happily
 * carries symlinks — so without this, a repo dressed up as sample data could
 * name `~/.ssh/id_rsa` as a prices file and have `ot run` read it. Very little
 * of an arbitrary file survives being parsed as archive rows, which makes this
 * a poor exfiltration channel rather than a safe one; there is no reason to
 * leave it open when the fix is to not follow the link.
 *
 * Regular files and real directories are all a genuine archive contains.
 */
async function walk(root, prefix = '', depth = 0) {
  const out = [];
  // A real archive is nested about six deep. The bound is what stops a
  // symlink-free cycle or a pathologically deep tree from spinning here.
  if (depth > 12) return out;
  let entries;
  try {
    entries = await readdir(path.join(root, prefix), { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const rel = prefix ? `${prefix}/${e.name}` : e.name;
    if (e.isSymbolicLink()) continue;
    if (e.isDirectory()) out.push(...await walk(root, rel, depth + 1));
    else if (e.isFile()) out.push(rel);
  }
  return out;
}

/** Stream one local archive file, gunzipping if needed, yielding parsed rows. */
async function* readRows(root, rel) {
  const full = path.join(root, rel);
  const raw = createReadStream(full);
  // `pipeline`, not `raw.pipe(...)`, for the same reason the queue's reader
  // uses it: `.pipe()` does not forward errors, so a failure on `raw` — a
  // truncated file, a disk that went away mid-read — emits 'error' on a stream
  // nobody is listening to, which in Node is process death rather than an
  // exception. That exact shape killed the worker in production; the risk is
  // lower on a local file, but the wrong pattern is not worth keeping a second
  // copy of.
  let stream = raw;
  if (rel.endsWith('.gz')) {
    const gunzip = createGunzip();
    stream = gunzip;
    pipeline(raw, gunzip).catch((err) => {
      if (!gunzip.destroyed) gunzip.destroy(err);
    });
  } else {
    raw.on('error', () => {});
  }
  const rl = createInterface({ input: stream, crlfDelay: Infinity });

  const isCsv = rel.includes('.csv');
  let header = null;
  for await (const line of rl) {
    const s = line.trim();
    if (!s) continue;
    if (isCsv && header === null) { header = s.split(','); continue; }
    const row = parseRow(s, { isCsv, header });
    if (row) yield row;
  }
}

/**
 * Which UTC day a sample archive path belongs to.
 *
 * The sample repos name files with the day in them, the same as the archive.
 * A file we cannot date is skipped rather than guessed at — a mis-dated file
 * would put one day's events into another day's market.
 */
export function dayOfPath(rel) {
  const m = /(\d{4}-\d{2}-\d{2})/.exec(rel);
  return m ? m[1] : null;
}

/**
 * Load one day out of a local archive.
 *
 * Returns the same shape fetchMarketDays does, so `ot run` and the worker feed
 * the harness identically.
 */
export async function loadLocalDay({ root, day, venue, assets, datasets, intervals, throttle = null }) {
  const archiveDatasets = archiveDatasetsFor({ datasets, venue, from: day, to: day });
  // Same normalisation, same default, same two filters as the queue. `ot run`
  // promises the identical files and checksums; an interval narrowing applied
  // on one side only would break that on the very first 15m market.
  const wantIntervals = normalizeIntervals(intervals ?? null);
  const all = await walk(root);
  const wanted = all.filter((rel) => dayOfPath(rel) === day
    && fileMatchesRun(rel, { venue, assets, archiveDatasets, intervals: wantIntervals }));

  if (wanted.length === 0) {
    return { markets: [], reason: `no files for ${day} under ${root}` };
  }

  // Markets first: everything else is keyed by market, and the settlement
  // stream resolution needs this.
  const marketRows = [];
  for (const rel of wanted.filter((r) => classifyPath(r).dataset === 'markets')) {
    for await (const row of readRows(root, rel)) marketRows.push(row);
  }
  // Same normalisation the queue uses. `ot run` promising "the identical files,
  // same checksums" only holds while both sides decode the archive identically,
  // so the venue has to reach the decoder here too.
  const indexed = indexMarkets(marketRows, { venue });
  const inScope = new Set((assets ?? []).map((a) => String(a).toUpperCase()));
  const wantIv = new Set(wantIntervals.map(String));
  const markets = new Map();
  for (const [id, m] of indexed) {
    if (m.asset && inScope.size && !inScope.has(String(m.asset).toUpperCase())) continue;
    if (m.interval && wantIv.size && !wantIv.has(String(m.interval))) continue;
    markets.set(id, m);
  }
  if (markets.size === 0) {
    return { markets: [], reason: `no market metadata for ${day}` };
  }
  const bySlug = buildSlugIndex(markets);

  // The settlement files these markets need, from the SAME function the queue
  // uses. Selecting them here separately is how "it runs locally but not in the
  // queue" happens — and it had already happened: without this, a strategy
  // asking for `prices` read nothing at all locally while the queue produced a
  // report, off the identical archive.
  const feed = orderedFeed([...wanted, ...settlementPathsFor(markets.values(),
    all.filter((rel) => dayOfPath(rel) === day), { venue, assets, already: wanted })]);

  const byMarket = new Map();
  for (const rel of feed) {
    if (classifyPath(rel).dataset === 'markets') continue;
    for await (const row of readRows(root, rel)) {
      for (const [id, ev] of eventsFromRow(rel, row, markets, bySlug, throttle)) {
        if (!markets.has(id)) continue;
        let list = byMarket.get(id);
        if (!list) { list = []; byMarket.set(id, list); }
        list.push(ev);
      }
    }
  }

  const out = [];
  const unusable = [];
  // EVERY market in the metadata, exactly as the worker does. Iterating only
  // the ones that produced events skipped the emptiest case — a market that
  // exists in the archive and decodes to nothing — which is precisely the gap
  // this is here to expose, and skipping it locally would put the divergence
  // back after it had just been removed.
  for (const marketId of markets.keys()) {
    const market = markets.get(marketId);
    const events = byMarket.get(marketId) ?? [];
    const { events: inWindow, up_px, down_px } = market
      ? finaliseMarket(events, market)
      : { events: [], up_px: null, down_px: null };
    // THE SAME predicate the queue applies, not a local copy of it. A rule that
    // lives in one reader and not the other is how `ot run` ends up replaying a
    // market the queue drops — and a market-making strategy, which never reads
    // the settlement price, is precisely the case that would never notice.
    const why = marketUnusable(market, inWindow);
    if (why) {
      unusable.push({ market_id: marketId, asset: market?.asset ?? null, day, why });
      continue;
    }
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
      events: inWindow,
      stream: market.stream,
      day,
      up_px,
      down_px,
    });
  }
  return {
    // THE SAME ORDER THE QUEUE FEEDS — see sortMarketsForReplay. A local replay
    // that emitted its logs in a different order than the queue would break the
    // one promise `ot run` makes: the identical files from the identical
    // archive.
    markets: sortMarketsForReplay(out),
    unusable,
    reason: out.length === 0 && unusable.length
      ? `${unusable.length} market(s) unusable: ${unusable[0].why}`
      : null,
  };
}

/** Days a local archive appears to hold, sorted. */
export async function localDays(root) {
  const all = await walk(root);
  const days = new Set();
  for (const rel of all) {
    const d = dayOfPath(rel);
    if (d) days.add(d);
  }
  return [...days].sort();
}

/** Does this look like a cloned sample archive at all? */
export async function looksLikeArchive(root) {
  try {
    const s = await stat(root);
    if (!s.isDirectory()) return false;
  } catch {
    return false;
  }
  const all = await walk(root);
  return all.some((rel) => classifyPath(rel).dataset !== 'other');
}
