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
import { createGunzip } from 'node:zlib';
import path from 'node:path';

import { classifyPath } from '../api/lib/data-taxonomy.mjs';
import { archiveDatasetsFor, fileMatchesRun } from '../api/lib/backtest-datasets.mjs';
import { indexMarkets, eventsFromRow, finaliseMarket, parseRow } from '../runner/events.mjs';

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
  const stream = rel.endsWith('.gz') ? raw.pipe(createGunzip()) : raw;
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
export async function loadLocalDay({ root, day, venue, assets, datasets }) {
  const archiveDatasets = archiveDatasetsFor({ datasets, venue, from: day, to: day });
  const all = await walk(root);
  const wanted = all.filter((rel) => dayOfPath(rel) === day
    && fileMatchesRun(rel, { venue, assets, archiveDatasets }));

  if (wanted.length === 0) {
    return { markets: [], reason: `no files for ${day} under ${root}` };
  }

  // Markets first: everything else is keyed by market, and the settlement
  // stream resolution needs this.
  const marketRows = [];
  for (const rel of wanted.filter((r) => classifyPath(r).dataset === 'markets')) {
    for await (const row of readRows(root, rel)) marketRows.push(row);
  }
  const markets = indexMarkets(marketRows);
  if (markets.size === 0) {
    return { markets: [], reason: `no market metadata for ${day}` };
  }

  const byMarket = new Map();
  for (const rel of wanted) {
    if (classifyPath(rel).dataset === 'markets') continue;
    for await (const row of readRows(root, rel)) {
      for (const [id, ev] of eventsFromRow(rel, row, markets)) {
        if (!markets.has(id)) continue;
        let list = byMarket.get(id);
        if (!list) { list = []; byMarket.set(id, list); }
        list.push(ev);
      }
    }
  }

  const out = [];
  for (const [marketId, events] of byMarket) {
    const market = markets.get(marketId);
    // Fail-closed, exactly as the worker does: a market whose settlement stream
    // we cannot read is dropped, not guessed at.
    if (!market || market.stream == null) continue;
    const { events: inWindow, up_px, down_px } = finaliseMarket(events, market);
    if (inWindow.length === 0) continue;
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
  return { markets: out, reason: null };
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
