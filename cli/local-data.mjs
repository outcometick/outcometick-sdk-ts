// Read a local archive for ot run. Share runner/events.mjs and spool-day.mjs
// with the hosted reader to preserve event decoding and ordering.

import { createReadStream } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { pipeline } from 'node:stream/promises';
import { createGunzip } from 'node:zlib';
import path from 'node:path';

import { classifyPath } from '../api/lib/data-taxonomy.mjs';
import {
  archiveDatasetsForDay, fileMatchesRun, normalizeIntervals, settlementPathsFor, orderedFeed,
} from '../api/lib/backtest-datasets.mjs';
import {
  indexMarkets, parseRow, buildSlugIndex,
  sortMarketsForReplay,
  makeBookThrottle,
} from '../runner/events.mjs';
import { spoolDay } from '../runner/spool-day.mjs';
import { spoolDayParallel } from './parallel-decode.mjs';

/**
 * Return archive-relative paths for regular files, skipping symlinked files
 * and directories so the archive cannot reference files outside its root.
 */
export async function walk(root, prefix = '', depth = 0) {
  const out = [];
  // Archives are about six levels deep; bound traversal of unusually deep trees.
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
  // Use pipeline to propagate source errors to gunzip; pipe does not forward them.
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
 * Extract the UTC day from an archive filename; return null if undated.
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
export async function loadLocalDay({
  root, day, venue, assets, datasets, intervals, throttle = null, eventsDir, workers = 1, chunkBytes, stats = null,
}) {
  // `spot` is decoded from the `prices` tree into its own events (DATASETS.spot).
  const spot = (datasets ?? []).includes('spot');
  // Select datasets using their capture windows, as the hosted reader does.
  const archiveDatasets = archiveDatasetsForDay({ datasets, venue, day, from: day, to: day });
  // Share interval normalization and filtering with the hosted reader.
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

  // Use the hosted settlement-file selector, including implicit price streams.
  const feed = orderedFeed([...wanted, ...settlementPathsFor(markets.values(),
    all.filter((rel) => dayOfPath(rel) === day), { venue, assets, already: wanted })]);

  // Spool per-market events to disk to bound memory. Use parallel decoding when
  // available; null falls back to the sequential spool. stats.parallel records
  // which path ran.
  const threaded = await spoolDayParallel({
    day, markets, bySlug, throttle, eventsDir, feedPaths: feed, root, workers, chunkBytes, spot,
  });
  if (stats) stats.parallel = threaded != null;
  const { out, unusable, bboSeen } = threaded ?? await spoolDay({
    day, markets, bySlug, throttle, eventsDir, spot,
    feed: feed.map((rel) => ({ path: rel, bytes: 0, rows: () => readRows(root, rel) })),
  });

  return {
    // Use the hosted market replay order.
    markets: sortMarketsForReplay(out),
    // Files read for this day, used for coverage and input fingerprints.
    inputs: feed,
    bboKeys: [...bboSeen].filter(Boolean).sort(),
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

/** The venues a local archive holds data files for. */
export async function archiveVenues(root) {
  const venues = new Set();
  for (const rel of await walk(root)) {
    const meta = classifyPath(rel);
    if (meta.dataset !== 'other') venues.add(meta.venue);
  }
  return venues;
}

/**
 * Choose Predict for a Predict-only archive; otherwise default to Polymarket
 * when --venue is omitted.
 */
export function defaultVenue(venues) {
  return venues.size === 1 && venues.has('predict') ? 'predict' : 'polymarket';
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
