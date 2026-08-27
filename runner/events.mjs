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
import { bookThrottleMs } from '../api/lib/backtest-contract.mjs';
import { Book } from './engine/book.mjs';

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
 * A market's own record, normalised across venues.
 *
 * WRITTEN AGAINST THE ARCHIVE, not against a guess at it. The previous version
 * read `open_ts_ms`, `close_ts_ms`, `interval` and `outcome` — none of which
 * the archive publishes. Every market therefore came out with a null window,
 * every event was cut by the window filter, and every run in the product's life
 * reported "no market data could be read". The shapes below were taken from
 * real objects; do not adjust one without looking at one.
 *
 * Polymarket:
 *   {slug, asset:"btc", interval_sec:900, condition_id, token_ids:[UP, DOWN],
 *    start_sec, end_sec, resolved, outcome_prices:["0","1"], strike_value, raw}
 *   `strike_value` is scaled by 1e18; `outcome_prices[0]` is the UP token.
 *
 * Predict:
 *   {category_slug, asset:"btc", interval_label:"15m", market_id:1506956,
 *    price_feed_id, price_feed_symbol, price_feed_provider, condition_id,
 *    start_sec, end_sec, start_price:"627.505", end_price:"628.265", status}
 *   Prices are plain decimals and settlement is end_price vs start_price.
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
 * Which side of a Polymarket market a token id belongs to.
 *
 * VERIFIED AGAINST SETTLED MARKETS, not assumed: for 64 of 64 resolved
 * 15-minute markets on 2026-08-20, `outcome_prices[0] === '1'` coincided
 * exactly with the settlement price closing above the strike. So `token_ids[0]`
 * is UP. Getting this backwards would mirror every strategy's P&L while the
 * report still looked entirely reasonable.
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
 * UP, DOWN, or null — never a guess.
 *
 * Polymarket writes the settled pair as `["1","0"]` (the UP token paid) or
 * `["0","1"]`. Anything else is a row we cannot read.
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

/** One Polymarket markets row -> the normalised record. */
function polymarketRecord(row) {
  const openMs = num(row.start_sec) == null ? null : num(row.start_sec) * 1000;
  const closeMs = num(row.end_sec) == null ? null : num(row.end_sec) * 1000;
  // The strike is published at full accuracy, scaled by 1e18 — the same value
  // that appears in the settlement stream's `full_accuracy_value` column.
  const strikeRaw = num(row.strike_value);
  // The outcome is read from a COMPLETE binary pair, or not at all.
  //
  // `prices[0] === '1' ? UP : DOWN` made every other value a DOWN — `[]`, `['']`,
  // `['0.5']`, a drifted schema, a truncated row. A settled position is priced
  // at $1/$0 off this field, so one unreadable metadata row would have inverted
  // a market's P&L, its baseline and its crosschecks while still looking like a
  // perfectly ordinary resolved market. Fail-closed, like every other
  // settlement fact here: null, and the fetcher drops the market-day.
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
    token_ids: Array.isArray(row.token_ids) ? row.token_ids.map(String) : [],
    raw: row,
  };
}

/** One Predict markets row -> the normalised record. */
function predictRecord(row) {
  const openMs = num(row.start_sec) == null ? null : num(row.start_sec) * 1000;
  const closeMs = num(row.end_sec) == null ? null : num(row.end_sec) * 1000;
  const start = num(row.start_price);
  const end = num(row.end_price);
  // RESOLVED is the venue's own word for "this is final". An OPEN market has no
  // outcome even if both prices are present — they are live quotes then, not a
  // settlement, and treating them as one would hand a strategy the answer.
  // Same rule, and the same reason: only a RESOLVED market with two readable
  // prices has an outcome. A tie is not a guess either — the venue settles it
  // one way and we do not know which, so the market-day is dropped.
  const outcome = String(row.status).toUpperCase() === 'RESOLVED'
    && start != null && end != null && end !== start
    ? (end > start ? 'UP' : 'DOWN')
    : null;
  return {
    market_id: String(row.market_id ?? row.condition_id ?? ''),
    slug: row.category_slug ?? null,
    asset: row.asset ? String(row.asset).toUpperCase() : null,
    interval: row.interval_label ? String(row.interval_label) : null,
    strike: start,
    outcome,
    open_ts_ms: openMs,
    close_ts_ms: closeMs,
    // Predict settles on its own price feed, named by the market. There is no
    // TWAP variant in this tree, so the stream is `prices` — but WHICH file
    // that is depends on `price_feed_id`.
    //
    // FAIL-CLOSED, like every other settlement question here: a market whose
    // feed id cannot be read has no stream, so the fetcher drops the market-day
    // rather than run it against whichever price file happened to match the
    // asset. A dropped day is visible in coverage and costs the customer
    // nothing; a market settled off another feed's price is invisible and makes
    // the whole report a lie.
    stream: num(row.price_feed_id) == null ? null : 'prices',
    price_feed_id: num(row.price_feed_id),
    token_ids: [],
    raw: row,
  };
}

/**
 * Index the markets of one day, keyed by the id its event rows carry.
 *
 * Both venues get the SAME record shape, because everything downstream — the
 * engine, the SDK, the report — is venue-agnostic. The differences are absorbed
 * here and nowhere else.
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
 * Look up a market from the identifiers an event row actually carries.
 *
 * Polymarket event rows name the market by `slug` — NOT by the `condition_id`
 * the markets tree is keyed on — so a straight id lookup finds nothing. Predict
 * rows carry the numeric `market_id` directly.
 */
function marketForRow(row, markets, bySlug) {
  const direct = row.market_id ?? row.marketId ?? null;
  if (direct != null && markets.has(String(direct))) return markets.get(String(direct));
  const slug = row.slug ?? row.category_slug ?? null;
  if (slug != null && bySlug.has(String(slug))) return bySlug.get(String(slug));
  return null;
}

/**
 * `[{price, size}]` or `[[px, size]]` -> `[[px, size]]`, unusable entries dropped.
 *
 * An outcome token pays 0 or 1, so a price outside that range is not a cheap
 * quote — it is a row we cannot read. Dropped rather than passed on: the engine
 * matches against the best price it is given, so a negative one becomes the
 * best bid in the book and quietly poisons every fill after it. Mirroring makes
 * it worse, turning one bad row into a bad row on the other side too.
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
 * The mirror of a UP-side ladder: a bid at 0.4 for UP is an ask at 0.6 for DOWN.
 *
 * Only reachable with prices already inside [0, 1], so the result is too — but
 * asserted rather than assumed, because this is the step that would turn one
 * unnoticed bad row into a negative price the engine treats as the best in the
 * book.
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
 * Thin a venue's book stream to one cadence for the whole run.
 *
 * The archive was captured at different densities at different times, and a run
 * spanning a change would otherwise fill differently in its first month than in
 * its last — with nothing in the report saying why, because the backtest
 * deliberately does not make a reader think about capture rates at all. So the
 * finer days are thinned to match the coarsest one in range, and there is no
 * boundary left to notice.
 *
 * THE SAME RULE THE COLLECTOR APPLIES: at most one row per market per window,
 * keeping the first. A thinned day is therefore byte-for-byte the shape a
 * coarser day already has, rather than an approximation of one.
 *
 * ONE CADENCE PER ASSET PER RUN — NOT ONE PER RUN. The window is the coarsest
 * THAT ASSET had anywhere in the range, so a single asset's series never
 * changes density partway through, which is the artefact a reader could
 * actually notice. Levelling every asset to the run-wide coarsest was the other
 * candidate and is worse on both counts that matter:
 *
 *   - It makes a result depend on the basket. The same BTC strategy over the
 *     same days would return different numbers because SOL was also ticked,
 *     and "why did adding an asset change my BTC P&L" has no honest answer.
 *   - It throws away the finer data almost always. Every 500ms asset in a
 *     basket would drag BTC back to 500ms, so the 20ms capture would go unused
 *     in any multi-asset run — while accuracy is the whole reason it exists.
 *
 * Different assets legitimately differ in density anyway: BTC's book really
 * does move more than DOGE's. What is not legitimate is the SAME book changing
 * density on a date, and that is what this removes.
 *
 * Only the delta/snapshot stream is thinned — Polymarket's `price_change` and
 * Predict's `orderbook`. Settlement ticks, trades and market metadata were
 * never throttled and are not touched.
 */
const THROTTLED = Object.freeze({ polymarket: 'price_change', predict: 'orderbook' });

export function makeBookThrottle({ venue, assets = [], from, to }) {
  const dataset = THROTTLED[venue];
  // One window per asset in scope, and the coarsest of them for anything whose
  // asset we cannot tell — a row we cannot attribute must not be thinned less
  // than the rows we can.
  const perAsset = new Map();
  for (const a of assets) {
    perAsset.set(String(a).toUpperCase(), bookThrottleMs({ venue, asset: a, from, to }));
  }
  // The floor for anything we cannot attribute — including the case where the
  // caller passed no asset list at all. Deriving it from `assets` made an empty
  // list mean "no throttling", which is fail-OPEN: a local `ot run` would then
  // replay denser than the queue does, and "it passed locally" would stop
  // meaning anything. `'*'` asks the table directly.
  const fallback = bookThrottleMs({ venue, asset: '*', from, to });
  const last = new Map();
  return {
    /** Nothing to do when nothing in range was throttled. */
    get active() { return dataset != null && fallback > 0; },

    /**
     * The window this gate will actually use for an asset.
     *
     * Asked rather than recomputed: the decoded-day cache is keyed on the
     * cadence a day was thinned at, and a caller working that out for itself
     * would be a second implementation of the rule that decides it — which is
     * how a cache ends up serving a 500ms day to a run that asked for 20ms.
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
      // The FIRST row in each window, exactly as the collector keeps it. A
      // window is measured from the row that opened it, not from a fixed grid:
      // a grid would keep a different row than the collector did on a day it
      // was actually throttling, and the two would disagree about the same day.
      if (prev != null && ts - prev < ms) return false;
      last.set(key, ts);
      return true;
    },
  };
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
 * @param {Map} bySlug        slug -> record, built once by the caller
 */
export function eventsFromRow(filePath, row, markets, bySlug = null, throttle = null) {
  const meta = classifyPath(filePath);
  const slugIndex = bySlug ?? buildSlugIndex(markets);

  if (meta.dataset === 'prices' || meta.dataset === 'twap30s' || meta.dataset === 'twap60s') {
    // Polymarket: `feed_ts_ms,value,...`. Predict: `...,publish_time,server_ts,price,recv_ms`
    // with publish_time in SECONDS. Reading only one of the two spellings is
    // how a whole venue ends up with no ticks at all.
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
      // Predict publishes one file per feed, and a market settles on its own.
      // STRICT EQUALITY, so an unreadable id on either side drops the row
      // instead of letting it through: the old condition only rejected when
      // BOTH sides parsed, so a price file with a missing or drifted column fed
      // every market of that asset — not an empty report, but plausible-looking
      // ticks from the wrong feed.
      if (m.price_feed_id != null) {
        const rowFeed = num(row.price_feed_id);
        if (rowFeed == null || rowFeed !== m.price_feed_id) continue;
      }
      // WINDOWED AT EMIT, not afterwards.
      //
      // The settlement stream is a whole day — 75,250 rows for twap60s — and a
      // day of BTC is roughly 384 markets once 5- and 15-minute books are both
      // in scope. Fanning every row out to every market and trimming later is
      // 29 million objects held at once, which is an out-of-memory kill on a
      // 2GB worker rather than a slow day. A market wants the ticks inside its
      // own window and nothing else, so that is what it is given.
      if (m.open_ts_ms != null && ts < m.open_ts_ms) continue;
      if (m.close_ts_ms != null && ts > m.close_ts_ms) continue;
      out.push([id, {
        kind: 'tick',
        ts_ms: ts,
        market_id: id,
        value,
        source: meta.dataset,
        // Three timestamps kept apart on every row: it is what lets a fill be
        // re-priced at an arbitrary delay instead of assumed instant.
        server_ts_ms: num(row.server_ts_ms) ?? (serverSec == null ? null : serverSec * 1000),
        recv_ts_ms: num(row.recv_ts_ms ?? row.recv_ms),
      }]);
    }
    return out;
  }

  const market = marketForRow(row, markets, slugIndex);
  if (!market) return [];
  const id = market.market_id;
  const ts = num(row.event_ts_ms ?? row.update_ts_ms ?? row.ts_ms ?? row.timestamp_ms);
  if (ts == null) return [];
  // Applied HERE, once, so both readers get it by decoding rather than by each
  // remembering to. See makeBookThrottle.
  if (throttle && !throttle.keep(meta.dataset, id, ts, market.asset)) return [];
  const payload = row.payload ?? row;

  if (meta.dataset === 'orderbook') {
    // ONE normalised ladder per Predict market, on the UP side: 28,677 rows
    // sampled and not one had a bid at or above the best ask, which is what a
    // single book looks like. DOWN is its mirror, never a second stream.
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
    // Polymarket publishes ONE SIDE PER ROW, named by asset_id. Merging the two
    // is the reader's job; a row that names a token this market does not own is
    // not ours.
    const side = sideOfToken(market, row.asset_id ?? payload.asset_id);
    if (!side) return [];
    // ONLY THE SIDE THIS ROW IS ABOUT. An empty object for the other side is
    // not "no information" to the engine — `Book.snapshot` resets whichever
    // sides it is given, and an empty ladder is a side it was given. Sending
    // both meant a UP snapshot wiped DOWN, the next DOWN snapshot wiped UP, and
    // a strategy only ever saw whichever side arrived last. Omitting the key
    // leaves that side untouched, in both engines.
    return [[id, {
      kind: 'book',
      ts_ms: ts,
      snapshot: true,
      side,
      levels: { [side]: { asks: ladder(payload.asks), bids: ladder(payload.bids) } },
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
      // Same range rule as a snapshot: a delta is applied to the same ladder,
      // so letting one through here would reach the engine by the other door.
      if (px < 0 || px > 1 || size < 0) continue;
      out.push([id, {
        kind: 'book',
        ts_ms: ts,
        snapshot: false,
        side,
        // BUY sits on the bid ladder, SELL on the ask ladder. The venue names
        // the taker's direction, not the book side, so this mapping is the
        // whole meaning of the row.
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
    // The same rule the book gets. A trade is a public SDK input a strategy
    // sizes its own orders off, so a null or negative one is a bad signal, not
    // a harmless field.
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
 * The coverage block, in ONE shape.
 *
 * The docs promise a local run and a queued run produce "the identical files,
 * same checksums, same coverage report". They already shared the decoder and
 * the feed list; the coverage object was still built twice, so `ot run` emitted
 * five keys where the queue emitted ten, and anyone diffing the two saw a
 * schema difference rather than an answer. A field a local run genuinely cannot
 * know is present and null, which is a different statement from absent.
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
  local = false,
  source = null,
}) {
  return {
    market_days_requested: marketDaysRequested,
    market_days_scanned: marketDaysScanned,
    // Reported for transparency, never used to bill: this one comes from inside
    // the sandbox.
    markets_reported_by_runner: marketsReportedByRunner,
    // Gaps are published, never smoothed over. This is the number the whole
    // product's credibility rests on.
    missing,
    // Reference days we could not read. Separate from `missing`, which is about
    // OUR archive: a customer needs to know which of the two was short, because
    // only one of them is something they paid us for.
    reference_declared: referenceDeclared,
    reference_missing: referenceMissing,
    streams,
    dropped_rows: droppedRows,
    // Rows the harness produced that do not describe a market the caller
    // supplied. Published rather than swallowed.
    unreconciled_rows: unreconciledRows,
    // Local-only, and last: a queued run has no source directory to name.
    ...(local ? { local: true, source } : {}),
  };
}

/**
 * The billing unit: one asset on one UTC day.
 *
 * SHARED, because a run's size is a number the customer is charged for and
 * shown. `ot run` counted MARKETS here and called them market-days — a single
 * day of BTC 15-minute markets is ninety-six of them — so a local report claimed
 * a run a hundred times larger than the queue would bill for, off the same
 * archive.
 */
export function countMarketDays(markets) {
  // THE BILLING UNIT: one asset, one UTC day, one market length.
  //
  // The interval is in the key because asking for 5m and 15m replays two
  // disjoint sets of markets over the same days — twice the data, twice the
  // work, twice the price. The quote multiplies by the same thing; if these
  // two ever disagree, `completeRun` refunds the difference and the customer
  // is charged whichever is smaller, silently.
  return new Set(markets.map(
    (m) => `${m.market?.asset ?? 'unknown'}|${m.day}|${m.market?.interval ?? 'none'}`,
  )).size;
}

/** How many markets settled on each stream. Shared for the same reason. */
export function countStreams(items) {
  const out = {};
  for (const m of items) {
    const s = m?.stream ?? 'unknown';
    out[s] = (out[s] ?? 0) + 1;
  }
  return out;
}

/**
 * Why a market cannot be replayed, or null if it can.
 *
 * ONE PREDICATE, because both readers have to agree about which markets exist.
 * A rule written in the worker and not in `ot run` is the same drift the feed
 * selection and the decoder each already produced: the local run replays a
 * market the queue drops, and a market-making strategy — which never looks at
 * the settlement price — is exactly the case that would never notice.
 *
 * Every reason here is fail-closed. A dropped market-day is visible in coverage
 * and costs the customer nothing; a market replayed without its settlement
 * stream, or settled off an outcome we could not read, is invisible and makes
 * the report wrong.
 */
/**
 * Put one day's markets in the order they will be replayed.
 *
 * ASSET, THEN OPENING TIME, THEN ID — and shared, because `ot run` and the
 * queue both feed markets to a strategy and a difference here is a difference
 * in what a reader sees from the same archive.
 *
 * The decoder produces market_id order, which is a hash and therefore
 * unrelated to time. Nothing about a RESULT depends on it — state is reset at
 * every on_market_open, which is what lets these be sharded — but `ctx.log`
 * from every market lands in one stream, and a human reads that stream as a
 * timeline. In hash order its timestamps jump hours in both directions for no
 * visible reason.
 *
 * Asset before time so each market-day stays a CONTIGUOUS block:
 * `marketDayPrefix` counts a market-day done when its last market is done, and
 * interleaving two assets pushes both of their last markets to the end of the
 * run — a progress bar that sits still and then jumps, which is the "looks
 * stuck" this channel exists to remove.
 *
 * The id breaks ties because many strikes open at the same instant, and an
 * unstable order would make two runs of the same strategy over the same days
 * emit their logs differently.
 */
export function sortMarketsForReplay(markets, { mode = 'market' } = {}) {
  const byId = (a, b) => {
    const ai = String(a.market?.market_id ?? '');
    const bi = String(b.market?.market_id ?? '');
    return ai < bi ? -1 : (ai > bi ? 1 : 0);
  };
  const byTime = (a, b) => (a.market?.open_ts_ms ?? 0) - (b.market?.open_ts_ms ?? 0);

  // SESSION MODE IS ONE STREAM, so it is ordered by time and by nothing else.
  //
  // Session shares one instance and one Portfolio across every market in the
  // range — the docs call it "one ordered stream across the range" — which
  // makes the feed order part of the RESULT, not just of the log. Its equity
  // curve, its position and its P&L accumulate in whatever order markets
  // arrive. Feeding it asset-major would build that curve by walking all of
  // BTC and then going back in time to walk all of ETH: not a sequence that
  // ever happened, and not a number anyone can act on.
  //
  // Before this function existed, session got market_id order — a hash. The
  // "ordered stream" in the docs was ordered by nothing at all.
  if (mode === 'session') return markets.sort((a, b) => byTime(a, b) || byId(a, b));

  // Market mode: each market is independent (state resets at every
  // on_market_open), so the order changes no result — only what a human reads.
  // Asset-major keeps each market-day a CONTIGUOUS block, which is what
  // marketDayPrefix needs: it counts a market-day done when its LAST market is
  // done, and interleaving assets pushes every asset's last market to the end
  // of the run — a progress bar that sits still and then jumps.
  return markets.sort((a, b) => {
    const aa = a.market?.asset ?? '';
    const ba = b.market?.asset ?? '';
    if (aa !== ba) return aa < ba ? -1 : 1;
    return byTime(a, b) || byId(a, b);
  });
}

export function marketUnusable(market, inWindow) {
  if (!market) return 'no market metadata';
  // WHICH ASSET IS THIS? Every layer above needs the answer and none of them
  // can work it out later: the billing key is `asset|day|interval`, the book
  // cadence is chosen per asset, and — since the decoded day became per-asset —
  // a market with no asset belongs to no cache entry in particular. Predict
  // publishes ONE venue-wide markets file, and the per-asset row filter is
  // `if (m.asset && …)`, so a row missing its category lands in every asset's
  // read at once, each carrying a different slice of its events under the same
  // name. Keeping any one of those replays a market with half its data and
  // nothing to say so.
  //
  // Decided HERE because this is the one function both the queue and `ot run`
  // ask. The first version of this rule lived in the queue's merge step, which
  // meant the local runner kept the market, and a single-asset run — which has
  // nothing to merge — replayed it out of the cache anyway.
  if (!market.asset) return 'market has no asset';
  if (market.stream == null) return 'settlement stream could not be resolved';
  if (market.outcome !== 'UP' && market.outcome !== 'DOWN') {
    return 'outcome could not be read';
  }
  if (!inWindow || inWindow.length === 0) return 'no events inside the market window';
  // Book rows alone make the window non-empty, so without this a day whose
  // settlement file was missing came back as scanned and billable while
  // `on_tick` never fired.
  if (!inWindow.some((e) => e.kind === 'tick')) {
    return `no settlement ticks on ${market.stream}`;
  }
  return null;
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
  // Sorted by event time, and TIES BROKEN BY KIND — never by insertion order.
  //
  // Insertion order is the order the archive files happened to be read in: the
  // catalog's order for the queue, the directory's for `ot run`. So a book
  // update and a tick stamped the same millisecond could arrive either way
  // round, and a strategy reacting to that tick would price against a book it
  // had not been shown yet. Worse, the two readers could disagree — the same
  // archive producing two different reports, which is exactly what `ot run`
  // promises cannot happen.
  //
  // The order within a millisecond is part of the contract: the book is brought
  // up to date, then what traded on it, then the tick a strategy reacts to. A
  // hook sees the world as it already was, never as it is about to be.
  //
  // Within `book`, a full snapshot comes before a delta: a snapshot is the
  // state AT that moment and a delta refines it, so applying them the other way
  // round throws the delta away. The remaining ties are between rows of the
  // same kind from the same file, where the archive's own order is the answer
  // and the caller reads files in a fixed order — see the feed selection.
  const RANK = { book: 0, trade: 1, tick: 2, ref: 3, ext: 4 };
  const rank = (e) => RANK[e?.kind] ?? 9;
  const sub = (e) => (e?.kind === 'book' && e.snapshot !== true ? 1 : 0);
  events.sort((a, b) => (a.ts_ms - b.ts_ms) || (rank(a) - rank(b)) || (sub(a) - sub(b)));

  // BOTH ENDS. The upper cut was here from the start; the lower one was not,
  // and only the settlement fan-out applied it. So a book or trade row printed
  // before the market opened was replayed to the strategy and priced the
  // "opening" baseline — a quote from before there was anything to quote.
  const open = market.open_ts_ms;
  const close = market.close_ts_ms;
  const inWindow = events.filter((e) => (open == null || e.ts_ms >= open)
    && (close == null || e.ts_ms <= close));

  // The closing quote on each side, from the events that survived the cut. The
  // report's naive baselines are priced off this.
  //
  // Walked back PER SIDE. Polymarket publishes one side per row, so the last
  // snapshot in the file is a single token's book and the other side's entry is
  // empty — taking both from one row left every DOWN baseline null, and a null
  // baseline silently drops a comparison the report claims to make.
  // The price each side could first have been BOUGHT at — the entry a naive
  // baseline would have taken.
  //
  // The opening quote, not the closing one. "Always buy UP" means buying when
  // the market opens and holding to settlement, so pricing it at the close
  // compares the strategy against a trade nobody could make: by then the
  // outcome is decided, "the favourite" is simply the winner, and the panel
  // labelled `always_favourite` becomes a perfect strategy at no cost. Measured
  // on a real day, the closing ask also does not exist for the winning side in
  // 384 of 388 markets — nobody offers a certain winner below a dollar — so the
  // baselines were computed over 1% of the markets they claimed to cover.
  //
  // Advanced through the SAME Book the engine uses, so the two cannot disagree
  // about what the book was. Reading a raw ladder instead was wrong twice over:
  // element zero is the worst offer on a venue that publishes descending, and
  // stopping at the last snapshot ignored every delta after it.
  const book = new Book();
  let upPx = null;
  let downPx = null;
  for (const ev of inWindow) {
    if (ev.kind !== 'book') continue;
    if (ev.snapshot) book.snapshot(ev.ts_ms, ev.levels);
    else if (ev.side && ev.ladder) book.delta(ev.ts_ms, ev.side, ev.ladder, ev.px, ev.size);
    // BOTH SIDES FROM ONE BOOK STATE, captured together.
    //
    // Polymarket publishes one side per row, so locking each side the moment it
    // first appears mixes a UP price from one instant with a DOWN price from
    // another — and `always_favourite`, which picks the dearer of the two, then
    // compares prices that never coexisted. Waiting until the book quotes both
    // is the first moment the comparison is about a real market.
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

// Merging point-in-time feeds into a market's event stream.
//
// MOVED HERE FROM THE WORKER, and the move is not cosmetic. `ot run` needs this
// to replay a submitter's own CSV locally, and the npm package ships from an
// explicit file list — importing it from `worker.mjs` meant the published CLI
// would load a module that is not in the tarball, and would drag `pg` and the
// AWS SDK with it if it were. It worked in this repo and nowhere else.

/**
 * Merge one market-day's events with the reference rows that fall inside it.
 *
 * Both sides are already in time order, so this is a merge rather than a sort:
 * a sort over a day of 1s klines plus a day of book updates is millions of
 * comparisons per market, repeated for every market on that day.
 *
 * Rows are clipped to the market's own window. A reference row from outside it
 * would reach a strategy replaying a market that had already closed — and on
 * the next market, the feed's monotone cursor would have already walked past
 * it, so it would be silently invisible instead. Neither is a thing to ship.
 */
/**
 * First index whose ts_ms is >= `at`, over rows already sorted by ts_ms.
 *
 * Rows with a non-finite ts_ms sort to the end via the comparator that built
 * the list, so they are handled by the caller rather than here.
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
  // A bound only when there IS one. `Number(null)` is 0, not NaN, so a market
  // whose close time is null — an empty cell normalises to null, and some
  // streams carry no window at all — would require every reference row to be
  // stamped at or before the epoch. Every one of them would be dropped, and the
  // strategy would get an empty ctx.ref() with nothing anywhere saying why.
  const bound = (v) => {
    // Empty string too: `Number('')` is also 0. An empty CSV cell reaching here
    // as '' rather than null is the same bug wearing different clothes.
    if (v == null || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };
  const openMs = bound(market?.open_ts_ms);
  const closeMs = bound(market?.close_ts_ms);


  // One flat, time-ordered list of ref lines across every declared feed.
  //
  // The rows are already sorted, so the window is found by BINARY SEARCH rather
  // than by scanning. It matters at the top end: a submitted series is held for
  // the whole run, and a 90-day BTC 1h scope is 2160 markets — scanning half a
  // million rows for each of them, six times over for the latency curve, turns
  // a linear job into a quadratic one against a 20-minute budget.
  const refs = [];
  for (const [name, rows] of Object.entries(rowsByName ?? {})) {
    const list = rows ?? [];
    // A LAGGED row stamped before the open can still become visible inside the
    // market: declared lag L means a row at t is readable at t+L, so a market
    // opening at 10:00 with L=60s must be sent the row stamped 09:59:30. Slicing
    // from the open dropped it, and the feed's monotone cursor had already
    // walked past it by the next market — invisible for the whole run, with
    // nothing saying so.
    const lag = Number(lags?.[name]) || 0;
    // Rows stamped before the open can still become readable inside it.
    const from = openMs == null ? 0 : lowerBound(list, openMs - lag);
    for (let i = from; i < list.length; i += 1) {
      const r = list[i];
      if (!Number.isFinite(r?.ts_ms)) continue;
      // ORDERED BY WHEN IT BECOMES READABLE, not by when it is stamped.
      //
      // A lagged row is not knowable until ts_ms + lag, and "the future is not
      // in this process" has to mean exactly that: PointInTimeFeed would hide
      // it either way, but queueing it at ts_ms puts it on stdin — and into the
      // harness's array — before the events it is supposed to trail. Filtered
      // is not the same as absent, and absent is the promise.
      const visibleAt = r.ts_ms + lag;
      // Sorted by ts_ms, so lag being constant per feed means visibleAt is
      // sorted too: the first row past the close ends this feed.
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
    // The event's timestamp, without parsing the whole row: these lines are
    // JSON objects whose ts_ms is a plain number, and a day of book updates is
    // an expensive thing to parse twice.
    const m = /"ts_ms"\s*:\s*(\d+)/.exec(line);
    const ts = m ? Number(m[1]) : Number.POSITIVE_INFINITY;
    // Strictly before: a reference row stamped at the same millisecond as a
    // market event goes AFTER it, so a strategy handling that event cannot
    // already see a bar that closed on the same tick.
    while (i < refs.length && refs[i][0] < ts) out.push(refs[i++][1]);
    out.push(line);
  }
  while (i < refs.length) out.push(refs[i++][1]);
  return out;
}
