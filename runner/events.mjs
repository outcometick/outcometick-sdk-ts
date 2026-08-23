// Turning archived rows into replayable events.
//
// Extracted so the two things that read the archive share ONE implementation:
// the worker (which streams it out of R2) and the `ot` CLI (which reads a
// cloned sample repo off disk). They differ only in where the bytes come from.
//
// The lesson this is applying is the one runner/conformance already enforces
// for the two engines: two implementations of the same rules drift, and the
// drift is silent. "The identical files, same checksums, same coverage report"
// is a published promise about `ot run` versus a queued run — it cannot be true
// if local and remote decode the archive differently.

import { classifyPath } from '../api/lib/data-taxonomy.mjs';
import { resolveSettlementStream } from '../api/lib/backtest-datasets.mjs';

/**
 * Coerce a field to a number, or null.
 *
 * The empty check is load-bearing: `Number('')` is 0, not NaN, and an empty CSV
 * cell is the normal case. Without it a missing `close_ts_ms` becomes 0 — a
 * market that closed at the Unix epoch — and settlement and hold expiry both
 * behave nonsensically off it.
 */
export const num = (v) => {
  if (v == null) return null;
  if (typeof v === 'string' && v.trim() === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/** `[[px, size], ...]` from either a JSON array or a "px:size|px:size" string. */
export function parseLevels(v) {
  if (Array.isArray(v)) return v;
  if (typeof v !== 'string' || !v) return [];
  if (v.startsWith('[')) {
    try { return JSON.parse(v); } catch { return []; }
  }
  return v.split('|').filter(Boolean).map((pair) => {
    const [px, size] = pair.split(':');
    return [Number(px), Number(size)];
  }).filter(([px, size]) => Number.isFinite(px) && Number.isFinite(size));
}

/**
 * Which stream backed each market, from the markets metadata.
 *
 * Fail-closed: a market whose config we cannot read gets `null` and is dropped,
 * because feeding a strategy a stream the market did not settle on is the one
 * error this product cannot make. An ABSENT config is a read failure, not
 * evidence of the pre-TWAP regime — see resolveSettlementStream.
 */
export function indexMarkets(rows) {
  const byId = new Map();
  for (const row of rows) {
    const id = row.market_id ?? row.id ?? row.condition_id;
    if (!id) continue;
    byId.set(String(id), {
      market_id: String(id),
      asset: row.asset ?? null,
      interval: row.interval ?? null,
      strike: num(row.strike),
      outcome: row.outcome === 'UP' || row.outcome === 'DOWN' ? row.outcome : null,
      open_ts_ms: num(row.open_ts_ms ?? row.start_ts_ms),
      close_ts_ms: num(row.close_ts_ms ?? row.end_ts_ms),
      stream: resolveSettlementStream(row),
      raw: row,
    });
  }
  return byId;
}

/**
 * The events one archived row produces, as [marketId, event] pairs.
 *
 * A settlement-feed row belongs to every market that settles on THAT stream —
 * which is decided per market from its own config, never from the date. One row
 * therefore fans out to many markets, and a row for a stream no market in scope
 * settles on produces nothing.
 *
 * @param {string} filePath   the archive path the row came from
 * @param {object} row
 * @param {Map} markets       from indexMarkets
 */
export function eventsFromRow(filePath, row, markets) {
  const meta = classifyPath(filePath);
  const ts = num(row.ts_ms ?? row.timestamp_ms ?? row.event_ts_ms);
  if (ts == null) return [];

  if (meta.dataset === 'prices' || meta.dataset === 'twap30s' || meta.dataset === 'twap60s') {
    const out = [];
    for (const [id, m] of markets) {
      if (m.stream !== meta.dataset) continue;
      if (m.asset && meta.asset && !String(m.asset).startsWith(meta.asset)) continue;
      out.push([id, {
        kind: 'tick',
        ts_ms: ts,
        market_id: id,
        value: num(row.value ?? row.price ?? row.answer),
        source: meta.dataset,
        // Three timestamps kept apart on every row: it is what lets a fill be
        // re-priced at an arbitrary delay instead of assumed instant.
        server_ts_ms: num(row.server_ts_ms),
        recv_ts_ms: num(row.recv_ts_ms),
      }]);
    }
    return out;
  }

  const marketId = row.market_id ?? row.asset_id ?? null;
  if (!marketId) return [];

  if (meta.dataset === 'book' || meta.dataset === 'orderbook') {
    return [[String(marketId), {
      kind: 'book',
      ts_ms: ts,
      snapshot: true,
      levels: {
        UP: { asks: parseLevels(row.up_asks), bids: parseLevels(row.up_bids) },
        DOWN: { asks: parseLevels(row.down_asks), bids: parseLevels(row.down_bids) },
      },
    }]];
  }
  if (meta.dataset === 'price_change') {
    return [[String(marketId), {
      kind: 'book',
      ts_ms: ts,
      snapshot: false,
      side: row.side === 'DOWN' ? 'DOWN' : 'UP',
      ladder: row.ladder === 'bids' ? 'bids' : 'asks',
      px: num(row.price),
      size: num(row.size),
    }]];
  }
  if (meta.dataset === 'last_trade_price') {
    return [[String(marketId), {
      kind: 'trade',
      ts_ms: ts,
      market_id: String(marketId),
      px: num(row.price),
      size: num(row.size),
      side: row.side === 'DOWN' ? 'DOWN' : 'UP',
    }]];
  }
  return [];
}

/**
 * Order one market's events and cut them at its close.
 *
 * The truncation is not tidying. The settlement feed is a per-DAY stream and
 * every row of it lands on every market settling on that stream, so a market
 * closing at 10:00 collects 14:00's rows too. Cutting here — upstream of both
 * the engine and the closing-quote scan below — is what keeps a post-close book
 * out of the strategy's view AND out of the report's baselines.
 */
export function finaliseMarket(events, market) {
  // Stable sort by event time. Ties keep insertion order, which puts a book
  // update before the tick that arrived in the same millisecond — a strategy
  // reacting to that tick should see the book as it already was.
  events.sort((a, b) => a.ts_ms - b.ts_ms);

  const close = market.close_ts_ms;
  const inWindow = close == null ? events : events.filter((e) => e.ts_ms <= close);

  // The closing quote on each side, from the events that survived the cut. The
  // report's naive baselines are priced off this.
  let upPx = null;
  let downPx = null;
  for (let i = inWindow.length - 1; i >= 0; i -= 1) {
    const ev = inWindow[i];
    if (ev.kind !== 'book' || !ev.snapshot) continue;
    upPx = ev.levels?.UP?.asks?.[0]?.[0] ?? null;
    downPx = ev.levels?.DOWN?.asks?.[0]?.[0] ?? null;
    if (upPx != null || downPx != null) break;
  }

  return { events: inWindow, up_px: upPx, down_px: downPx };
}

/** Parse one archive line, CSV or JSONL, given a header for CSV. */
export function parseRow(line, { isCsv, header }) {
  if (!isCsv) {
    try { return JSON.parse(line); } catch { return null; }
  }
  if (!header) return null;
  const cells = line.split(',');
  const row = {};
  for (let i = 0; i < header.length; i += 1) row[header[i]] = cells[i];
  return row;
}
