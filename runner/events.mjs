// Decode archived rows into replay events. Shared by the hosted worker and
// `ot run` so local and remote reads use the same rules.

import { classifyPath } from '../api/lib/data-taxonomy.mjs';
import { resolveSettlementStream, degradingCoverage, inputKeys } from '../api/lib/backtest-datasets.mjs';
import { bookThrottleMs } from '../api/lib/backtest-contract.mjs';
import { Book } from './engine/book.mjs';
import { OUTCOME_TIE, OUTCOMES, FEE_MODEL_PM } from './engine/portfolio.mjs';

/**
 * Coerce a field to a number, or null.
 * Check empty CSV cells before conversion: Number('') would turn missing times into 0.
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
 * Normalise market metadata across venues. Match these fields to archive rows.
 *
 * Polymarket:
 *   {slug, asset:"btc", interval_sec:900, condition_id, token_ids:[UP, DOWN],
 *    start_sec, end_sec, resolved, outcome_prices:["0","1"], strike_value, raw}
 *   strike_value is scaled by 1e18; outcome_prices[0] is the UP token.
 *
 * Predict:
 *   {category_slug, asset:"btc", interval_label:"15m", market_id:1506956,
 *    price_feed_id, price_feed_symbol, price_feed_provider, condition_id,
 *    start_sec, end_sec, start_price:"627.505", end_price:"628.265", status}
 *   Prices are decimal values; settlement compares end_price to start_price.
 */

/** `900` -> `"15m"`, `86400` -> `"1d"`. Null when the venue states it directly. */
function intervalLabel(seconds) {
  const n = num(seconds);
  if (n == null || n <= 0) return null;
  if (n % 86400 === 0) return `${n / 86400}d`;
  if (n % 3600 === 0) return `${n / 3600}h`;
  if (n % 60 === 0) return `${n / 60}m`;
  return `${n}s`;
}

/**
 * Map a Polymarket token id to its outcome side.
 * The archive orders token_ids as [UP, DOWN], confirmed on 64 resolved 15m markets.
 */
function sideOfToken(market, assetId) {
  const ids = market?.token_ids;
  if (!Array.isArray(ids) || assetId == null) return null;
  const i = ids.indexOf(String(assetId));
  if (i === 0) return 'UP';
  if (i === 1) return 'DOWN';
  return null;
}

/**
 * Read UP or DOWN from a settled binary pair, otherwise null.
 * Polymarket uses ["1","0"] for UP and ["0","1"] for DOWN.
 */
function polymarketOutcome(row) {
  if (row?.resolved !== true) return null;
  const p = row.outcome_prices;
  if (!Array.isArray(p) || p.length !== 2) return null;
  const [up, down] = p.map((x) => String(x));
  if (up === '1' && down === '0') return 'UP';
  if (up === '0' && down === '1') return 'DOWN';
  return null;
}

/**
 * Normalised taker fee schedule of a Polymarket market:
 *   {model: 'polymarket-taker-v1', rate}  fees on: C × rate × p × (1 − p)
 *   {model: 'none'}                       fees off (known zero)
 *   null                                  missing or unknown, charged 0
 * Only exponent 1 is accepted. rebateRate is separate from this taker schedule.
 * Keep in sync with _fee_of in client/backtest/decode.py.
 */
export function feeOf(row) {
  const raw = row?.raw;
  if (!raw || typeof raw !== 'object') return null;
  if (raw.feesEnabled === false) return { model: 'none' };
  if (raw.feesEnabled !== true) return null;
  const s = raw.feeSchedule;
  if (!s || typeof s !== 'object') return null;
  const rate = s.rate;
  if (typeof rate !== 'number' || !Number.isFinite(rate) || rate < 0 || rate > 1) return null;
  if (s.exponent !== 1) return null;
  return { model: FEE_MODEL_PM, rate };
}

/** One Polymarket markets row -> the normalised record. */
function polymarketRecord(row) {
  const openMs = num(row.start_sec) == null ? null : num(row.start_sec) * 1000;
  const closeMs = num(row.end_sec) == null ? null : num(row.end_sec) * 1000;
  // strike_value uses 1e18 scaling, as does settlement full_accuracy_value.
  const strikeRaw = num(row.strike_value);
  // Require a complete settled pair. Unreadable outcomes remain null so
  // marketUnusable rejects them rather than treating them as DOWN.
  const outcome = polymarketOutcome(row);
  return {
    market_id: String(row.condition_id ?? row.slug ?? ''),
    slug: row.slug ?? null,
    asset: row.asset ? String(row.asset).toUpperCase() : null,
    interval: intervalLabel(row.interval_sec),
    strike: strikeRaw == null ? null : strikeRaw / 1e18,
    outcome,
    open_ts_ms: openMs,
    close_ts_ms: closeMs,
    stream: resolveSettlementStream(row),
    // null marks an unusable Polymarket [Up, Down] pair. Predict uses []
    // because its book rows are not routed by token id.
    token_ids: upDownPair(row.token_ids),
    fee: feeOf(row),
    raw: row,
  };
}

/** Exactly two distinct ids, as strings, or null. */
function upDownPair(ids) {
  if (!Array.isArray(ids) || ids.length !== 2) return null;
  const [up, down] = ids.map(String);
  return up !== down ? [up, down] : null;
}

/** One Predict markets row -> the normalised record. */
function predictRecord(row) {
  const openMs = num(row.start_sec) == null ? null : num(row.start_sec) * 1000;
  const closeMs = num(row.end_sec) == null ? null : num(row.end_sec) * 1000;
  const start = num(row.start_price);
  const end = num(row.end_price);
  // end_price marks settlement; status may retain its last polled value.
  // Equal start and end prices produce TIE, paying $0.50 per outcome contract.
  let outcome = null;
  if (start != null && end != null) {
    outcome = end > start ? 'UP' : end < start ? 'DOWN' : OUTCOME_TIE;
  }
  return {
    market_id: String(row.market_id ?? row.condition_id ?? ''),
    slug: row.category_slug ?? null,
    asset: row.asset ? String(row.asset).toUpperCase() : null,
    interval: row.interval_label ? String(row.interval_label) : null,
    strike: start,
    outcome,
    open_ts_ms: openMs,
    close_ts_ms: closeMs,
    // Predict settles on the price_feed_id named by the market. An unreadable
    // id leaves stream null so marketUnusable rejects it.
    stream: num(row.price_feed_id) == null ? null : 'prices',
    price_feed_id: num(row.price_feed_id),
    token_ids: [],
    raw: row,
  };
}

/**
 * Index a day's markets by the id carried in event rows.
 * Normalise both venues to the same downstream record shape.
 */
export function indexMarkets(rows, { venue = 'polymarket' } = {}) {
  const byId = new Map();
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const rec = venue === 'predict' ? predictRecord(row) : polymarketRecord(row);
    if (!rec.market_id) continue;
    byId.set(rec.market_id, rec);
  }
  return byId;
}

/**
 * Resolve event identifiers: Polymarket rows use slug rather than condition_id;
 * Predict rows use numeric market_id.
 */
function marketForRow(row, markets, bySlug) {
  const direct = row.market_id ?? row.marketId ?? null;
  if (direct != null && markets.has(String(direct))) return markets.get(String(direct));
  const slug = row.slug ?? row.category_slug ?? null;
  if (slug != null && bySlug.has(String(slug))) return bySlug.get(String(slug));
  return null;
}

/**
 * Normalise [{price,size}] or [[px,size]] to [[px,size]], dropping bad levels.
 * Prices must be in [0,1] before matching or mirroring.
 */
function ladder(levels) {
  if (!Array.isArray(levels)) return [];
  const out = [];
  for (const lv of levels) {
    const px = Array.isArray(lv) ? num(lv[0]) : num(lv?.price);
    const size = Array.isArray(lv) ? num(lv[1]) : num(lv?.size);
    if (px == null || size == null) continue;
    if (px < 0 || px > 1) continue;
    if (size <= 0) continue;
    out.push([px, size]);
  }
  return out;
}

/**
 * Mirror a UP ladder: a UP bid at 0.4 becomes a DOWN ask at 0.6.
 * Validate the mirrored price remains in [0,1].
 */
function mirror(levels) {
  const out = [];
  for (const [px, size] of levels) {
    const m = Number((1 - px).toFixed(10));
    if (!(m >= 0 && m <= 1)) continue;
    out.push([m, size]);
  }
  return out;
}

/**
 * Thin book updates to the coarsest captured cadence per asset in the run.
 * This avoids density changes across dates without making one asset's result
 * depend on other assets in the run.
 * Keep the first row per market in each window, as the collector does.
 * Only Polymarket price_change and Predict orderbook are thinned; settlement
 * ticks, trades and metadata are unchanged.
 */
const THROTTLED = Object.freeze({ polymarket: 'price_change', predict: 'orderbook' });

export function makeBookThrottle({ venue, assets = [], from, to }) {
  const dataset = THROTTLED[venue];
  // Use per-asset windows; unidentified assets use the coarsest window.
  const perAsset = new Map();
  for (const a of assets) {
    perAsset.set(String(a).toUpperCase(), bookThrottleMs({ venue, asset: a, from, to }));
  }
  // Resolve the unidentified-asset floor from the table even with no asset list,
  // so an empty list cannot disable throttling.
  const fallback = bookThrottleMs({ venue, asset: '*', from, to });
  const last = new Map();
  return {
    /** Nothing to do when nothing in range was throttled. */
    get active() { return dataset != null && fallback > 0; },
    /** The dataset it thins (null: none on this venue). */
    get dataset() { return dataset ?? null; },
    /** What it was made from: makeBookThrottle(spec) is a fresh gate with the same windows. */
    get spec() { return { venue, assets: [...assets], from, to }; },
    /** True until it has kept or dropped a row. */
    get untouched() { return last.size === 0; },

    /**
     * Return the window used for this asset. Decoded-cache keys use this value
     * to avoid reusing data thinned at a different cadence.
     */
    windowFor(asset) {
      if (dataset == null) return 0;
      return perAsset.get(String(asset ?? '').toUpperCase()) ?? fallback;
    },
    /**
     * Should this row be replayed?
     *
     * @param {string} ds        the archive dataset the row came from
     * @param {string} marketId  the market it belongs to
     * @param {number} ts        its event time
     * @param {string|null} asset
     */
    keep(ds, marketId, ts, asset) {
      if (ds !== dataset || fallback === 0) return true;
      const ms = perAsset.get(String(asset ?? '').toUpperCase()) ?? fallback;
      if (ms === 0) return true;
      const key = String(marketId);
      const prev = last.get(key);
      // Keep the first row in a window measured from the previous kept row.
      // A fixed time grid would differ from the collector's sampling rule.
      if (prev != null && ts - prev < ms) return false;
      last.set(key, ts);
      return true;
    },
  };
}

/**
 * Decode an archive row to [marketId, event] pairs.
 * Settlement rows fan out only to markets whose config names that stream.
 *
 * @param {string} filePath   archive path of the row
 * @param {object} row
 * @param {Map} markets       from indexMarkets
 * @param {Map} bySlug        slug -> record, built by the caller
 */
export function eventsFromRow(filePath, row, markets, bySlug = null, throttle = null, { spot = false } = {}) {
  const meta = classifyPath(filePath);
  const slugIndex = bySlug ?? buildSlugIndex(markets);

  if (meta.dataset === 'prices' || meta.dataset === 'twap30s' || meta.dataset === 'twap60s') {
    // Polymarket uses feed_ts_ms/value. Predict uses publish_time/price,
    // with publish_time in seconds (server_ts is also seconds; recv_ms is ms).
    const pubSec = num(row.publish_time);
    const ts = num(row.feed_ts_ms ?? row.ts_ms ?? row.timestamp_ms ?? row.event_ts_ms)
      ?? (pubSec == null ? null : pubSec * 1000);
    if (ts == null) return [];
    const value = num(row.value ?? row.price ?? row.answer);
    if (value == null) return [];
    const serverSec = num(row.server_ts);
    const out = [];
    for (const [id, m] of markets) {
      if (m.stream !== meta.dataset) continue;
      if (m.asset && meta.asset && String(m.asset) !== String(meta.asset)) continue;
      // Require matching readable feed ids; each Predict market uses its own feed.
      if (m.price_feed_id != null) {
        const rowFeed = num(row.price_feed_id);
        if (rowFeed == null || rowFeed !== m.price_feed_id) continue;
      }
      // Clip settlement fan-out to each market's window before allocating events.
      // A BTC day with 75,250 twap60s rows and 384 markets would otherwise
      // allocate about 29 million events before filtering.
      if (m.open_ts_ms != null && ts < m.open_ts_ms) continue;
      if (m.close_ts_ms != null && ts > m.close_ts_ms) continue;
      out.push([id, {
        kind: 'tick',
        ts_ms: ts,
        market_id: id,
        value,
        source: meta.dataset,
        // Keep feed, receive and event times separate for latency modelling.
        server_ts_ms: num(row.server_ts_ms) ?? (serverSec == null ? null : serverSec * 1000),
        recv_ts_ms: num(row.recv_ts_ms ?? row.recv_ms),
      }]);
    }
    // When declared, send the 1 Hz Polymarket spot stream to all markets of
    // its asset within their windows. It is separate from settlement ticks
    // and sorts before them at equal timestamps.
    if (spot && meta.dataset === 'prices' && meta.venue === 'polymarket' && meta.asset) {
      const serverMs = num(row.server_ts_ms) ?? (serverSec == null ? null : serverSec * 1000);
      const recvMs = num(row.recv_ts_ms ?? row.recv_ms);
      for (const [id, m] of markets) {
        if (!m.asset || String(m.asset) !== String(meta.asset)) continue;
        if (m.open_ts_ms != null && ts < m.open_ts_ms) continue;
        if (m.close_ts_ms != null && ts > m.close_ts_ms) continue;
        out.push([id, { kind: 'spot', ts_ms: ts, market_id: id, value, server_ts_ms: serverMs, recv_ts_ms: recvMs }]);
      }
    }
    return out;
  }

  const market = marketForRow(row, markets, slugIndex);
  if (!market) return [];
  const id = market.market_id;
  const ts = num(row.event_ts_ms ?? row.update_ts_ms ?? row.ts_ms ?? row.timestamp_ms);
  if (ts == null) return [];
  // Apply the shared book throttle during decoding (see makeBookThrottle).
  if (throttle && !throttle.keep(meta.dataset, id, ts, market.asset)) return [];
  const payload = row.payload ?? row;

  if (meta.dataset === 'orderbook') {
    // Predict supplies a UP ladder; derive DOWN by mirroring it.
    // In 28,677 sampled rows, no bid met or exceeded the best ask.
    const asks = ladder(payload.asks);
    const bids = ladder(payload.bids);
    return [[id, {
      kind: 'book',
      ts_ms: ts,
      snapshot: true,
      levels: {
        UP: { asks, bids },
        DOWN: { asks: mirror(bids), bids: mirror(asks) },
      },
    }]];
  }

  if (meta.dataset === 'book') {
    // Polymarket rows describe one outcome, identified by asset_id.
    // Ignore tokens outside this market.
    const side = sideOfToken(market, row.asset_id ?? payload.asset_id);
    if (!side) return [];
    // Include only the named side. Book.snapshot resets each supplied side,
    // so an empty ladder for the other side would erase it.
    return [[id, {
      kind: 'book',
      ts_ms: ts,
      snapshot: true,
      side,
      levels: { [side]: { asks: ladder(payload.asks), bids: ladder(payload.bids) } },
    }]];
  }

  if (meta.dataset === 'best_bid_ask') {
    // BBO prices have no sizes. Use them only to prune stale levels, never to
    // add liquidity. Emit a book event with bbo=true so on_book sees the
    // refined ladder through the existing hook.
    const side = sideOfToken(market, row.asset_id ?? payload.asset_id);
    if (!side) return [];
    const bid = num(payload.best_bid);
    const ask = num(payload.best_ask);
    // Ignore malformed bounds: an invalid deletion bound could empty a ladder.
    // Dropping the row leaves the existing book usable without BBO refinement.
    if (bid == null || ask == null) return [];
    if (bid < 0 || bid > 1 || ask < 0 || ask > 1) return [];
    if (bid > ask) return [];
    // Bounds include 0 and 1. A best bid of 0 removes all positive bids;
    // the complementary best ask of 1 removes asks below 1.
    return [[id, {
      kind: 'book',
      ts_ms: ts,
      snapshot: false,
      bbo: true,
      side,
      bid,
      ask,
    }]];
  }

  if (meta.dataset === 'price_change') {
    // A delta carries a batch, each entry naming its own token and ladder side.
    const changes = Array.isArray(payload.price_changes) ? payload.price_changes : [];
    const out = [];
    for (const ch of changes) {
      const side = sideOfToken(market, ch.asset_id);
      if (!side) continue;
      const px = num(ch.price);
      const size = num(ch.size);
      if (px == null || size == null) continue;
      // Apply the snapshot price-range validation to delta levels too.
      if (px < 0 || px > 1 || size < 0) continue;
      out.push([id, {
        kind: 'book',
        ts_ms: ts,
        snapshot: false,
        side,
        // BUY updates the bid ladder; SELL updates the ask ladder.
        ladder: String(ch.side).toUpperCase() === 'SELL' ? 'asks' : 'bids',
        px,
        size,
      }]);
    }
    return out;
  }

  if (meta.dataset === 'last_trade_price') {
    const side = sideOfToken(market, row.asset_id ?? payload.asset_id);
    if (!side) return [];
    const px = num(payload.price);
    const size = num(payload.size);
    // Validate trade prices and sizes before exposing them to strategies.
    if (px == null || px < 0 || px > 1) return [];
    if (size == null || size <= 0) return [];
    return [[id, {
      kind: 'trade',
      ts_ms: ts,
      market_id: id,
      px,
      size,
      side,
      // The taker's direction, kept separate from which outcome traded.
      taker: String(payload.side).toUpperCase() === 'SELL' ? 'SELL' : 'BUY',
    }]];
  }

  return [];
}

/** slug -> record, for the event rows that name a market that way. */
export function buildSlugIndex(markets) {
  const bySlug = new Map();
  for (const m of markets.values()) if (m.slug) bySlug.set(String(m.slug), m);
  return bySlug;
}

/**
 * Build the shared coverage schema for local and hosted runs.
 * Fields a local run cannot determine remain present with null values.
 */
export function buildCoverage({
  marketDaysRequested = null,
  marketDaysScanned,
  marketsReportedByRunner = null,
  missing = [],
  referenceDeclared = [],
  referenceMissing = [],
  streams = {},
  droppedRows = 0,
  unreconciledRows = 0,
  /**
   * Always report whether bbo was declared and where it was decoded.
   * These fields identify which markets used refined books.
   */
  bboDeclared = false,
  bboDays = [],
  bboMissingDays = [],
  bboPartialDays = [],
  local = false,
  source = null,
}) {
  return {
    market_days_requested: marketDaysRequested,
    market_days_scanned: marketDaysScanned,
    // Replay counts reported by the sandbox.
    markets_reported_by_runner: marketsReportedByRunner,
    // Include archive gaps in the report.
    missing,
    // Unreadable reference days, separate from missing archive data.
    reference_declared: referenceDeclared,
    reference_missing: referenceMissing,
    streams,
    dropped_rows: droppedRows,
    // Report harness rows that do not match a supplied market.
    unreconciled_rows: unreconciledRows,
    // Days without decoded BBO refinement, including dates before capture began.
    bbo_declared: bboDeclared,
    bbo_days: bboDays,
    bbo_missing_days: bboMissingDays,
    // Partial dates name the asset|interval entries without refinement.
    // Full, missing and partial lists partition the scanned dates.
    bbo_partial_days: bboPartialDays,
    // Append the local source directory only for local runs.
    ...(local ? { local: true, source } : {}),
  };
}

/**
 * Summarise decoded BBO coverage over the markets actually scanned.
 * Missing refinement does not necessarily indicate missing archive data;
 * some dates precede BBO capture. Shared by local and hosted runs.
 */
export { inputKeys };

export function bboCoverage({ venue, datasets, markets, applied = null }) {
  if (!(datasets ?? []).includes('bbo')) {
    return { bboDeclared: false, bboDays: [], bboMissingDays: [], bboPartialDays: [] };
  }
  // Require decode measurements; capture schedules cannot prove rows were replayed.
  if (!applied) {
    throw new Error('bboCoverage: `applied` is required when the manifest declares bbo '
      + '— coverage must be measured from what was decoded, never inferred from the capture window');
  }

  // Measure asset|day|interval coverage so one asset cannot stand in for another.
  const byDay = new Map();
  for (const m of markets ?? []) {
    const day = m?.day;
    if (!day) continue;
    if (!byDay.has(day)) byDay.set(day, new Set());
    byDay.get(day).add(`${m.market?.asset ?? 'unknown'}|${m.market?.interval ?? 'none'}`);
  }

  const full = [], none = [], partial = [];
  for (const day of [...byDay.keys()].sort()) {
    const scanned = [...byDay.get(day)];
    const got = applied.get(day) ?? new Set();
    const without = scanned.filter((k) => !got.has(k)).sort();
    if (without.length === 0) full.push(day);
    else if (without.length === scanned.length) none.push(day);
    // Name the unrefined asset|interval entries for partial dates.
    else partial.push({ day, without });
  }
  return { bboDeclared: true, bboDays: full, bboMissingDays: none, bboPartialDays: partial };
}

/** Count distinct asset|UTC day|interval combinations, shared by both readers. */
export function countMarketDays(markets) {
  // Include interval: 5m and 15m contain disjoint market sets.
  return new Set(markets.map(
    (m) => `${m.market?.asset ?? 'unknown'}|${m.day}|${m.market?.interval ?? 'none'}`,
  )).size;
}

/** Count markets by settlement stream. */
export function countStreams(items) {
  const out = {};
  for (const m of items) {
    const s = m?.stream ?? 'unknown';
    out[s] = (out[s] ?? 0) + 1;
  }
  return out;
}

/**
 * Shared replay eligibility checks for local and hosted readers.
 * Return a reason for missing metadata, outcomes, or required events.
 */
/**
 * Order markets deterministically. Market mode groups by asset, then opening
 * time and id; session mode uses opening time and id across assets.
 * Grouping keeps market-days contiguous for marketDayPrefix progress counts.
 */
export function sortMarketsForReplay(markets, { mode = 'market' } = {}) {
  const byId = (a, b) => {
    const ai = String(a.market?.market_id ?? '');
    const bi = String(b.market?.market_id ?? '');
    return ai < bi ? -1 : (ai > bi ? 1 : 0);
  };
  const byTime = (a, b) => (a.market?.open_ts_ms ?? 0) - (b.market?.open_ts_ms ?? 0);

  // Session state is shared across markets, so opening order must follow time.
  if (mode === 'session') return markets.sort((a, b) => byTime(a, b) || byId(a, b));

  // Market mode resets strategy state per market. Asset grouping keeps
  // market-day completion contiguous for progress reporting.
  return markets.sort((a, b) => {
    const aa = a.market?.asset ?? '';
    const ba = b.market?.asset ?? '';
    if (aa !== ba) return aa < ba ? -1 : 1;
    return byTime(a, b) || byId(a, b);
  });
}

export function marketUnusable(market, inWindow) {
  if (!market) return 'no market metadata';
  // An asset is required for cadence, coverage and per-asset cache attribution.
  // Without it, venue-wide Predict metadata could enter multiple asset reads
  // with different subsets of events.
  if (!market.asset) return 'market has no asset';
  // Polymarket book and trade rows need two distinct [Up, Down] token ids.
  // Reject null pairs; Predict records use [] and route without token ids.
  if (market.token_ids === null) return 'market has no usable [Up, Down] token ids';
  if (market.stream == null) return 'settlement stream could not be resolved';
  if (!OUTCOMES.includes(market.outcome)) {
    return 'outcome could not be read';
  }
  // Do not use trades to determine eligibility: decoded caches include them
  // even when the run does not declare them.
  if (!inWindow || !inWindow.some((e) => e.kind !== 'trade')) return 'no events inside the market window';
  // Require settlement ticks; book rows alone cannot drive on_tick.
  if (!inWindow.some((e) => e.kind === 'tick')) {
    return `no settlement ticks on ${market.stream}`;
  }
  return null;
}

/**
 * Sort events and clip to the market's inclusive opening and closing bounds.
 * Apply the same window to replay events and baseline quotes.
 */
export function finaliseMarket(events, market) {
  // Equal timestamps sort by spot, book, trade, tick, ref, ext, independent
  // of source-file read order. Book snapshots precede deltas so deltas are
  // not overwritten. Remaining ties retain input order. Spot comes first
  // so same-millisecond hooks can read it.
  const RANK = { spot: -1, book: 0, trade: 1, tick: 2, ref: 3, ext: 4 };
  const rank = (e) => RANK[e?.kind] ?? 9;
  const sub = (e) => (e?.kind === 'book' && e.snapshot !== true ? 1 : 0);
  events.sort((a, b) => (a.ts_ms - b.ts_ms) || (rank(a) - rank(b)) || (sub(a) - sub(b)));

  // Clip both ends so pre-open data cannot reach hooks or price baselines.
  const open = market.open_ts_ms;
  const close = market.close_ts_ms;
  const inWindow = events.filter((e) => (open == null || e.ts_ms >= open)
    && (close == null || e.ts_ms <= close));

  // Find the first simultaneous UP and DOWN asks for opening baselines.
  // Use the engine's Book to apply snapshots, deltas and BBO bounds consistently.
  const book = new Book();
  let upPx = null;
  let downPx = null;
  for (const ev of inWindow) {
    if (ev.kind !== 'book') continue;
    // Keep these branches and their order in sync with engine/replay.mjs.
    if (ev.bbo) book.bbo(ev.ts_ms, ev.side, ev.bid, ev.ask);
    else if (ev.snapshot) book.snapshot(ev.ts_ms, ev.levels);
    else if (ev.side && ev.ladder) book.delta(ev.ts_ms, ev.side, ev.ladder, ev.px, ev.size);
    // Capture both prices from one book state. Independent per-side captures
    // could compare quotes that never coexisted.
    const up = book.best('UP');
    const down = book.best('DOWN');
    if (up != null && down != null) { upPx = up; downPx = down; break; }
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

// Point-in-time feed merging lives here so the public CLI does not import
// worker.mjs or its PostgreSQL and AWS dependencies.

/**
 * Merge time-ordered market events with reference rows inside the market window.
 * Use a linear merge after selecting and ordering the reference rows.
 */
/**
 * Find the first index with ts_ms >= at in sorted rows.
 * The caller handles non-finite timestamps, which sort to the end.
 */
function lowerBound(rows, at) {
  let lo = 0;
  let hi = rows.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (Number(rows[mid]?.ts_ms) < at) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export function mergeReferenceRows(eventLines, rowsByName, market, kind = 'ref', lags = null) {
  // Missing bounds remain null; numeric conversion would turn null into epoch 0.
  const bound = (v) => {
    // Empty CSV cells also convert to 0, so treat them as missing bounds.
    if (v == null || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };
  const openMs = bound(market?.open_ts_ms);
  const closeMs = bound(market?.close_ts_ms);


  // Binary-search each sorted feed's window to avoid rescanning the full
  // series for every market.
  const refs = [];
  for (const [name, rows] of Object.entries(rowsByName ?? {})) {
    const list = rows ?? [];
    // A row stamped at t becomes readable at t + lag. Include pre-open rows
    // whose visibility time falls inside the market window.
    const lag = Number(lags?.[name]) || 0;
    // Search by the source timestamp after subtracting the lag.
    const from = openMs == null ? 0 : lowerBound(list, openMs - lag);
    for (let i = from; i < list.length; i += 1) {
      const r = list[i];
      if (!Number.isFinite(r?.ts_ms)) continue;
      // Schedule at ts_ms + lag so the harness receives rows only when readable.
      const visibleAt = r.ts_ms + lag;
      // A constant per-feed lag preserves order; stop at the first row past close.
      if (closeMs != null && visibleAt > closeMs) break;
      if (openMs != null && visibleAt < openMs) continue;
      refs.push([visibleAt, JSON.stringify({ kind, name, ...r })]);
    }
  }
  if (refs.length === 0) return eventLines;
  refs.sort((a, b) => a[0] - b[0]);

  const out = [];
  let i = 0;
  for (const line of eventLines) {
    // Read the numeric ts_ms field without parsing each event again.
    const m = /"ts_ms"\s*:\s*(\d+)/.exec(line);
    const ts = m ? Number(m[1]) : Number.POSITIVE_INFINITY;
    // At equal visibility times, reference rows follow market events so
    // a hook cannot see a bar closing on the same tick.
    while (i < refs.length && refs[i][0] < ts) out.push(refs[i++][1]);
    out.push(line);
  }
  while (i < refs.length) out.push(refs[i++][1]);
  return out;
}
