// Map SDK declarations to archive datasets. settlement resolves per market.

import { classifyPath } from './data-taxonomy.mjs';
import {
  CAPTURE_WINDOWS, DERIVED_DATASETS, KNOWN_DATASETS, BacktestRejection,
  MARKET_INTERVALS, DEFAULT_INTERVALS, MAX_LATENCY_MS, OPT_IN_DATASETS,
  DEGRADING_DATASETS,
} from './backtest-contract.mjs';

/**
 * SDK-to-archive mapping per venue. Polymarket book data combines snapshots
 * and deltas; Predict.fun uses its orderbook tree.
 */
export const ARCHIVE_DATASETS = Object.freeze({
  polymarket: Object.freeze({
    prices: Object.freeze(['prices']),
    twap30s: Object.freeze(['twap30s']),
    twap60s: Object.freeze(['twap60s']),
    book: Object.freeze(['book', 'price_change']),
    bbo: Object.freeze(['best_bid_ask']),
    spot: Object.freeze(['prices']),
    trades: Object.freeze(['last_trade_price']),
    markets: Object.freeze(['markets']),
  }),
  // Predict.fun has no bbo or spot mapping. Coverage handling follows
  // CAPTURE_WINDOWS and DEGRADING_DATASETS.
  predict: Object.freeze({
    prices: Object.freeze(['prices']),
    twap30s: Object.freeze(['twap30s']),
    twap60s: Object.freeze(['twap60s']),
    book: Object.freeze(['orderbook']),
    trades: Object.freeze(['last_trade_price']),
    markets: Object.freeze(['markets']),
  }),
});

/**
 * Always feed metadata for lifecycle strikes/outcomes and settlement lookbacks.
 */
export const ALWAYS_FED = Object.freeze(['markets']);

/**
 * Resolve settlement from the market's own lookback configuration, not its date.
 * Missing or unsupported configuration returns null for unresolved settlement.
 *
 * @param {object} market a row from the markets dataset
 * @returns {'prices'|'twap30s'|'twap60s'|null}
 */
export function resolveSettlementStream(market) {
  const cfg = market?.raw?.cryptoMarketConfig ?? market?.cryptoMarketConfig ?? null;
  // Missing configuration does not identify the instantaneous regime.
  if (!cfg || typeof cfg !== 'object') return null;
  if (!Object.prototype.hasOwnProperty.call(cfg, 'twapLookbackSeconds')) return null;

  const lookback = cfg.twapLookbackSeconds;
  // Explicit null or 0 selects instantaneous prices; absence is unresolved.
  if (lookback === null || lookback === 0) return 'prices';
  if (lookback === 30) return 'twap30s';
  if (lookback === 60) return 'twap60s';
  return null;
}

/**
 * Is a captured stream available for this venue on this day?
 *
 * Both ends are inclusive and `to: null` means "still capturing".
 */
export function isCaptured(venue, dataset, day) {
  const w = CAPTURE_WINDOWS[venue]?.[dataset];
  if (!w) return false;
  if (day < w.from) return false;
  if (w.to && day > w.to) return false;
  return true;
}

/**
 * First unavailable portion of [from, to], or null if fully captured.
 */
export function uncapturedRange(venue, dataset, from, to) {
  const w = CAPTURE_WINDOWS[venue]?.[dataset];
  if (!w) return { from, to };
  const badFrom = from < w.from ? from : null;
  const badTo = badFrom ? (to < w.from ? to : prevDay(w.from)) : null;
  if (badFrom) return { from: badFrom, to: badTo };
  if (w.to && to > w.to) return { from: nextDay(w.to), to };
  return null;
}

function shiftDay(day, delta) {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}
const prevDay = (d) => shiftDay(d, -1);
const nextDay = (d) => shiftDay(d, 1);

/**
 * Validate dataset windows, raising E_COVERAGE for the first gap. settlement
 * is exempt from this check because it resolves per market; metadata can
 * still be missing or unreadable.
 */
export function assertCoverage({ datasets, venue, from, to }) {
  for (const ds of datasets ?? []) {
    if (ds === 'settlement') continue;
    // Degrading datasets report coverage without blocking replay.
    if (DEGRADING_DATASETS.includes(ds)) continue;
    if (DERIVED_DATASETS[ds]) {
      // Derived availability follows the source stream.
      const src = DERIVED_DATASETS[ds].from;
      const gap = uncapturedRange(venue, src, from, to);
      if (gap) {
        throw new BacktestRejection('E_COVERAGE',
          `${ds} is derived from ${src}, which is not captured for ${gap.from}..${gap.to ?? gap.from} on ${venue}`,
          { dataset: ds, derivedFrom: src, venue, gap });
      }
      continue;
    }
    const gap = uncapturedRange(venue, ds, from, to);
    if (gap) {
      const w = CAPTURE_WINDOWS[venue]?.[ds];
      throw new BacktestRejection('E_COVERAGE',
        `${ds} is not captured for ${gap.from}..${gap.to ?? gap.from} on ${venue}`
        + (w ? ` (captured from ${w.from}${w.to ? ` to ${w.to}` : ''})` : '')
        + '. Use settlement, or a :derived stream if you specifically want today\'s rules on older dates.',
        { dataset: ds, venue, gap, capturedFrom: w?.from ?? null, capturedTo: w?.to ?? null });
    }
  }
}

/**
 * Check actual decoder inputs for an archive dataset. Inputs are
 * <path>:<sha256> entries for opened objects, not requested datasets.
 */
export function inputsInclude(inputs, archiveDataset) {
  return inputKeys(inputs, archiveDataset).size > 0;
}

/**
 * Asset/interval keys for which inputs contain this dataset. The caller
 * supplies the day. Assetless venue-wide objects contribute no keys.
 */
export function inputKeys(inputs, archiveDataset) {
  const out = new Set();
  for (const entry of inputs ?? []) {
    const raw = String(entry);
    // Split at the last colon because paths may contain colons.
    const cut = raw.lastIndexOf(':');
    const p = cut > 0 ? raw.slice(0, cut) : raw;
    const c = classifyPath(p);
    if (c.dataset !== archiveDataset) continue;
    if (!c.asset) continue;
    out.add(`${c.asset}|${c.interval ?? 'none'}`);
  }
  return out;
}

/**
 * Nominal covered and missing days from CAPTURE_WINDOWS. Actual missing
 * objects are tracked separately through decoder inputs.
 *
 * @returns {{covered: string[], missing: string[]}}
 */
export function degradingCoverage(venue, dataset, days) {
  const covered = [], missing = [];
  for (const d of days ?? []) (isCaptured(venue, dataset, d) ? covered : missing).push(d);
  return { covered, missing };
}

/**
 * Archive datasets needed by a manifest. settlement expands to all possible
 * authoritative streams before metadata is read, excluding streams with
 * no capture-window overlap.
 */
export function archiveDatasetsFor({ datasets, venue, from, to }) {
  const wanted = new Set();
  for (const ds of [...(datasets ?? []), ...ALWAYS_FED]) {
    if (ds === 'settlement') {
      for (const s of ['prices', 'twap30s', 'twap60s']) {
        if (!uncapturedRange(venue, s, from, to) || isCaptured(venue, s, to)) wanted.add(s);
      }
      continue;
    }
    const base = DERIVED_DATASETS[ds]?.from ?? ds;
    wanted.add(base);
  }
  const out = new Set();
  const map = ARCHIVE_DATASETS[venue] ?? {};
  for (const w of wanted) for (const a of map[w] ?? []) out.add(a);
  return [...out].sort();
}

/**
 * Per-day selection drops degrading streams outside their full-day window.
 * Keep the original range for settlement expansion to preserve feed selection.
 */
export function archiveDatasetsForDay({ datasets, venue, day, from, to }) {
  const usable = (datasets ?? []).filter(
    (d) => !DEGRADING_DATASETS.includes(d) || isCaptured(venue, d, day),
  );
  return archiveDatasetsFor({ datasets: usable, venue, from, to });
}

/**
 * Cache requested datasets plus trades. Trade events can be removed without
 * changing other events: stable (ts, kind, snapshot) ordering, book throttling,
 * opening baselines, bboKeys and market usability do not depend on trades.
 * See fetch-data.test.mjs. Book and bbo alter book state and cannot be removed
 * by filtering events.
 */
export function decodeDatasetsFor({ archiveDatasets, venue }) {
  const out = new Set(archiveDatasets);
  for (const a of ARCHIVE_DATASETS[venue]?.trades ?? []) out.add(a);
  return [...out].sort();
}

/**
 * Whether cached trades and their input bytes must be excluded from replay
 * and reporting.
 */
export function omitsTrades({ archiveDatasets, venue }) {
  return (ARCHIVE_DATASETS[venue]?.trades ?? []).some((a) => !archiveDatasets.includes(a));
}

/** Is this archive dataset one of the venue's trade streams? */
export function isTradeDataset(venue, dataset) {
  return (ARCHIVE_DATASETS[venue]?.trades ?? []).includes(dataset);
}

/**
 * Additional settlement files required by decoded metadata, shared by hosted
 * and local runners for consistent feed selection.
 *
 * @param {Iterable} markets normalised records from indexMarkets
 * @param {string[]} paths all archive paths available for the day
 * @param {object} opts venue, assets in scope and paths already selected
 */
export function settlementPathsFor(markets, paths, { venue, assets, already = [] }) {
  const need = new Set();
  for (const m of markets) if (m?.stream) need.add(m.stream);
  if (need.size === 0) return [];
  const have = new Set(already);
  const inScope = new Set((assets ?? []).map((a) => String(a).toUpperCase()));
  const out = [];
  for (const p of paths) {
    if (have.has(p)) continue;
    const c = classifyPath(p);
    if (c.venue !== venue || !need.has(c.dataset)) continue;
    if (c.asset && inScope.size && !inScope.has(String(c.asset).toUpperCase())) continue;
    out.push(p);
  }
  return out.sort();
}

/**
 * Sort paths for deterministic input order. Equal-time events with equal
 * sort keys retain read order, so traversal order must not affect reports.
 */
export function orderedFeed(paths) {
  return [...paths].sort();
}

/**
 * Replay-scope filter, not an authorisation check. scope.mjs enforces
 * download permissions separately.
 */
export function fileMatchesRun(filePath, { venue, assets, archiveDatasets, intervals }) {
  const meta = classifyPath(filePath);
  if (meta.venue !== venue) return false;
  if (!archiveDatasets.includes(meta.dataset)) return false;
  // Venue-wide datasets (markets) carry no asset and are always in scope.
  if (meta.asset && assets?.length && !assets.includes(meta.asset)) return false;
  // Apply interval filters only to interval-bearing files. Continuous
  // settlement streams remain in scope with a null interval.
  if (meta.interval && intervals?.length && !intervals.includes(meta.interval)) return false;
  return true;
}

/**
 * Normalise one latency-panel delay in ms, or null to disable. Lists are
 * rejected because each delay requires a full replay.
 */
export function normalizeLatency(value) {
  if (value == null) return null;
  if (Array.isArray(value)) {
    // Reject lists rather than discarding requested delays.
    throw new BacktestRejection('E_MANIFEST',
      'latency is a single delay in milliseconds, not a list — each delay replays the whole range again');
  }
  const ms = Number(value);
  if (!Number.isInteger(ms) || ms <= 0 || ms > MAX_LATENCY_MS) {
    throw new BacktestRejection('E_MANIFEST',
      `latency must be a whole number of milliseconds between 1 and ${MAX_LATENCY_MS}, got ${JSON.stringify(value)}`);
  }
  return ms;
}

/**
 * Validate a declared cancel latency: how long after a hook calls
 * ctx.cancel() the cancel reaches the venue. Separate from `latency` (order
 * entry) because the two are different trips on a real connection. 0 is
 * allowed; absent means "same as latency".
 */
export function normalizeCancelLatency(value) {
  if (value == null) return null;
  const ms = typeof value === 'number' ? value : Number.NaN;
  if (!Number.isInteger(ms) || ms < 0 || ms > MAX_LATENCY_MS) {
    throw new BacktestRejection('E_MANIFEST',
      `cancel_latency must be a whole number of milliseconds between 0 and ${MAX_LATENCY_MS}, got ${JSON.stringify(value)}`);
  }
  return ms;
}

/**
 * Resting-order policy shared by both harnesses. Polymarket needs book depth
 * for initial queue size and trades for queue advancement. Predict.fun has
 * no trade stream and cannot support resting orders.
 * Keep in sync with resting_policy_for in client/backtest/datasets.py.
 */
export function restingPolicyFor({ manifest, venue }) {
  const refuse = (refusal) => ({ allowed: false, refusal, cancelLatencyMs: 0 });
  if (venue !== 'polymarket') {
    return refuse('resting (gtc) orders need a trade stream to advance the queue; '
      + `the ${venue} archive has order-book snapshots only, so only ioc orders run there`);
  }
  const datasets = manifest?.datasets ?? [];
  const missing = ['book', 'trades'].filter((d) => !datasets.includes(d));
  if (missing.length) {
    return refuse(`resting (gtc) orders need the ${missing.map((d) => `"${d}"`).join(' and ')} `
      + `dataset${missing.length > 1 ? 's' : ''} — add ${missing.length > 1 ? 'them' : 'it'} to datasets in the manifest`);
  }
  return {
    allowed: true,
    refusal: null,
    cancelLatencyMs: manifest.cancel_latency ?? manifest.latency ?? 0,
  };
}

// ---------------------------------------------------------------------------
// Execution options default to off, preserving the default job and report shape.
// Keep in sync with client/backtest/datasets.py.

/** Enable fill-or-kill orders and declare their output columns before replay. */
export function normalizeFok(value) {
  if (value == null || value === false) return false;
  if (value === true) return true;
  throw new BacktestRejection('E_MANIFEST', `fok must be true or false, got ${JSON.stringify(value)}`);
}

/** `order_rules`: null | "venue" (from the market's own metadata) | "assumed"
 * (archive Polymarket: tick 0.001 and minimum 5 shares, measured, not read). */
export function normalizeOrderRules(value) {
  if (value == null) return null;
  if (value === 'venue' || value === 'assumed') return value;
  throw new BacktestRejection('E_MANIFEST',
    `order_rules must be "venue" or "assumed", got ${JSON.stringify(value)}`);
}

/** `maker_rebate`: the fraction of the taker fee credited to a resting fill. */
export function normalizeMakerRebate(value) {
  if (value == null) return null;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new BacktestRejection('E_MANIFEST',
      `maker_rebate must be a number between 0 and 1, got ${JSON.stringify(value)}`);
  }
  return value;
}

/** `quote_guard`: max_age_ms and/or ask_sum: [lo, hi], plus optional include_exits. */
export function normalizeQuoteGuard(value) {
  if (value == null) return null;
  const bad = (why) => new BacktestRejection('E_MANIFEST', `quote_guard ${why}`);
  if (typeof value !== 'object' || Array.isArray(value)) throw bad('must be an object');
  for (const k of Object.keys(value)) {
    if (k !== 'max_age_ms' && k !== 'ask_sum' && k !== 'include_exits') throw bad(`has an unknown key ${JSON.stringify(k)}`);
  }
  const out = {};
  if (value.max_age_ms != null) {
    const ms = value.max_age_ms;
    if (typeof ms !== 'number' || !Number.isInteger(ms) || ms < 0 || ms > 86_400_000) {
      throw bad('max_age_ms must be a whole number of milliseconds between 0 and 86400000');
    }
    out.max_age_ms = ms;
  }
  if (value.ask_sum != null) {
    const r = value.ask_sum;
    const num = (x) => typeof x === 'number' && Number.isFinite(x);
    if (!Array.isArray(r) || r.length !== 2 || !num(r[0]) || !num(r[1]) || r[0] < 0 || r[0] > r[1] || r[1] > 2) {
      throw bad('ask_sum must be [lo, hi] with 0 <= lo <= hi <= 2');
    }
    out.ask_sum = [r[0], r[1]];
  }
  if (!Object.keys(out).length) throw bad('needs max_age_ms or ask_sum');
  // Exits are not guarded unless asked: a guard that blocks an exit holds the
  // position to settlement, which is a bigger bet than a stale exit price.
  if (value.include_exits != null) {
    if (typeof value.include_exits !== 'boolean') throw bad('include_exits must be true or false');
    if (value.include_exits) out.include_exits = true;
  }
  return out;
}

/**
 * `feed_latency`: ms between an event happening on the venue and the strategy
 * seeing it. Zero or absent disables feed latency.
 */
export function normalizeFeedLatency(value) {
  if (value == null || value === 0) return null;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > MAX_LATENCY_MS) {
    throw new BacktestRejection('E_MANIFEST',
      `feed_latency must be a whole number of milliseconds between 0 and ${MAX_LATENCY_MS}, got ${JSON.stringify(value)}`);
  }
  return value;
}

/**
 * `queue_model`: a probabilistic estimate of where in the queue unexplained
 * book decreases came from, or null for the conservative default.
 * {prob: "power"|"power2"|"power3", n: 1..10} or {prob: "log"|"log2"}. The
 * names are QUEUE_PROBS in runner/engine/maker.mjs (a test pins the two).
 */
export const QUEUE_PROB_FUNCS = Object.freeze(['power', 'power2', 'power3', 'log', 'log2']);
export function normalizeQueueModel(value) {
  if (value == null) return null;
  const bad = () => new BacktestRejection('E_MANIFEST',
    'queue_model must be {"prob": "power"|"power2"|"power3", "n": 1..10} or {"prob": "log"|"log2"}, got '
    + JSON.stringify(value));
  if (typeof value !== 'object' || Array.isArray(value)) throw bad();
  const keys = Object.keys(value);
  const prob = value.prob;
  if (!QUEUE_PROB_FUNCS.includes(prob)) throw bad();
  if (prob.startsWith('power')) {
    if (keys.some((k) => k !== 'prob' && k !== 'n')) throw bad();
    if (!Number.isInteger(value.n) || value.n < 1 || value.n > 10) throw bad();
    return { prob, n: value.n };
  }
  if (keys.some((k) => k !== 'prob')) throw bad();
  return { prob, n: null };
}

/**
 * `record_ms`: the recorder's grid in whole milliseconds, 1000..3_600_000
 * Absent disables recording. Market mode only (enginePolicyFor refuses session).
 */
export const RECORD_MS_MIN = 1000;
export const RECORD_MS_MAX = 3_600_000;
export function normalizeRecordMs(value) {
  if (value == null) return null;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < RECORD_MS_MIN || value > RECORD_MS_MAX) {
    throw new BacktestRejection('E_MANIFEST',
      `record_ms must be a whole number of milliseconds between ${RECORD_MS_MIN} and ${RECORD_MS_MAX}, got ${JSON.stringify(value)}`);
  }
  return value;
}

/**
 * A conservative upper bound on the rows a record_ms run writes (market samples
 * + account points; protocol.mjs MAX_RECORD_ROWS): per market-day, the
 * interval's markets x (points across one market + 3 for its ends and FINAL),
 * plus the account grid across the days. Used at submit to refuse a scope the
 * recorder could not finish, naming the smallest record_ms that fits.
 */
const RECORD_MARKETS_PER_DAY = Object.freeze({ '5m': 288, '15m': 96 });
const RECORD_INTERVAL_MS = Object.freeze({ '5m': 300_000, '15m': 900_000 });
export function recordRowsBound({ recordMs, assets, days, intervals }) {
  let rows = 0;
  for (const iv of intervals ?? []) {
    const per = RECORD_MARKETS_PER_DAY[iv] ?? 288;
    const len = RECORD_INTERVAL_MS[iv] ?? 300_000;
    rows += assets * days * per * (Math.ceil(len / recordMs) + 3);
  }
  return rows + Math.ceil((days * 86_400_000) / recordMs) + 2;
}
export function assertRecordFits({ recordMs, assets, days, intervals, maxRows }) {
  if (recordMs == null) return;
  const fits = (r) => recordRowsBound({ recordMs: r, assets, days, intervals }) <= maxRows;
  if (fits(recordMs)) return;
  let lo = recordMs;
  let hi = RECORD_MS_MAX;
  if (!fits(hi)) {
    throw new BacktestRejection('E_SCOPE', `record_ms cannot cover ${days} day(s) x ${assets} asset(s) within the ${maxRows}-row limit; record a smaller scope`);
  }
  while (lo + 1 < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (fits(mid)) hi = mid; else lo = mid;
  }
  throw new BacktestRejection('E_SCOPE',
    `record_ms ${recordMs} would write about ${recordRowsBound({ recordMs, assets, days, intervals })} rows over this scope `
    + `(limit ${maxRows}); use record_ms ${hi} or more, or a smaller scope`);
}

/** `mirror_depth: "shared"`: both tokens consume the same single-book depth. */
export function normalizeMirrorDepth(value) {
  if (value == null) return null;
  if (value === 'shared') return value;
  throw new BacktestRejection('E_MANIFEST', `mirror_depth must be "shared", got ${JSON.stringify(value)}`);
}

/** The venue constants behind `order_rules: "assumed"` (archive Polymarket). */
export const ASSUMED_ORDER_RULES = Object.freeze({ tick: 0.001, min_size: 5, size_step: 0.01 });

/**
 * The engine options a run hands both harnesses as `job.engine`, or null when
 * every option is off (the job then carries no `engine` key at all).
 *
 * `data`: 'archive' (the outcometick archive, hosted or `ot run`) or 'generic'
 * (the user's own data, local only). Combinations that cannot be honoured are
 * refused here, worded for the person fixing the manifest.
 */
export function enginePolicyFor({ manifest, venue, data = 'archive' }) {
  const fok = normalizeFok(manifest?.fok);
  const rules = normalizeOrderRules(manifest?.order_rules);
  const rebate = normalizeMakerRebate(manifest?.maker_rebate);
  const guard = normalizeQuoteGuard(manifest?.quote_guard);
  const mirror = normalizeMirrorDepth(manifest?.mirror_depth);
  const feedLatency = normalizeFeedLatency(manifest?.feed_latency);
  const queue = normalizeQueueModel(manifest?.queue_model);
  const recordMs = normalizeRecordMs(manifest?.record_ms);
  const timers = (manifest?.hooks ?? []).includes('on_timer');
  const global = timers || feedLatency != null;
  if (!fok && rules == null && rebate == null && guard == null && mirror == null && !global && queue == null && recordMs == null) return null;
  const refuse = (why) => { throw new BacktestRejection('E_MANIFEST', why); };
  let orderRules = null;
  if (rules === 'venue') {
    if (data !== 'generic') {
      refuse('order_rules "venue" needs each market\'s tick and minimum size, which archive markets do not carry; '
        + 'use "assumed" (tick 0.001, minimum 5 shares — measured on the archive, not read per market)');
    }
    orderRules = { mode: 'venue' };
  } else if (rules === 'assumed') {
    if (data === 'generic') refuse('order_rules "assumed" is for archive markets; your own data carries its tick and minimum — use "venue"');
    if (venue !== 'polymarket') refuse(`order_rules "assumed" is Polymarket's; the ${venue} archive publishes no order rules`);
    orderRules = { mode: 'assumed', ...ASSUMED_ORDER_RULES };
  }
  if (rebate != null && manifest?.fee_bps != null) {
    refuse('maker_rebate is a share of the venue\'s taker fee; it cannot be combined with a flat fee_bps');
  }
  if (mirror != null && data === 'archive' && venue === 'polymarket') {
    refuse('mirror_depth "shared" is for single-book markets (Predict.fun); Polymarket publishes two separate books');
  }
  if (recordMs != null && (manifest?.mode ?? 'market') !== 'market') {
    refuse('record_ms needs mode "market": in a session one portfolio is shared by every market, and this recorder samples one market at a time');
  }
  if (queue != null && data === 'archive' && venue !== 'polymarket') {
    refuse(`queue_model is for resting (gtc) orders, which need a trade stream; the ${venue} archive has none`);
  }
  return {
    fok,
    order_rules: orderRules,
    maker_rebate: rebate,
    quote_guard: guard,
    // Archive Predict: every market is one book and its mirror. Generic data:
    // only markets the pmdata entry marked single_mirrored (MarketReplay checks).
    mirror_depth: mirror,
    mirror_markets: mirror == null ? null : (data === 'archive' ? 'all' : 'single_mirrored'),
    // Timers and feed latency require a shared timeline across markets.
    ...(global ? { scheduler: 'global', timers, feed_latency: feedLatency ?? 0 } : {}),
    // Omit undeclared queue settings to preserve the default job shape.
    ...(queue != null ? { queue_prob: queue } : {}),
    // Market-mode mark-to-market grid.
    ...(recordMs != null ? { record_ms: recordMs } : {}),
  };
}

/** The highest flat fee override a manifest may declare: 10% of notional. */
export const MAX_FEE_BPS = 1000;

/**
 * Normalise a flat fee in basis points. null selects the venue schedule;
 * 0 is an explicit zero-fee override.
 */
export function normalizeFeeBps(value) {
  if (value == null) return null;
  const n = typeof value === 'number' ? value : Number.NaN;
  if (!Number.isFinite(n) || n < 0 || n > MAX_FEE_BPS) {
    throw new BacktestRejection('E_MANIFEST',
      `fee_bps must be a number of basis points between 0 and ${MAX_FEE_BPS}, got ${JSON.stringify(value)}`);
  }
  return n;
}

/**
 * Fee policy for both harnesses. envFeeBps (OT_FEE_BPS or --fee-bps) overrides
 * the manifest, which overrides the venue schedule.
 */
export function feePolicyFor({ manifest, envFeeBps = null }) {
  if (envFeeBps != null && envFeeBps !== '') {
    const bps = Number(envFeeBps);
    if (Number.isFinite(bps) && bps >= 0) return { mode: 'bps', bps };
  }
  if (manifest?.fee_bps != null) return { mode: 'bps', bps: manifest.fee_bps };
  return { mode: 'venue' };
}

/**
 * Validate a declared interval list, returning it normalised.
 *
 * Absent means the default (5m), not "everything": see MARKET_INTERVALS.
 */
export function normalizeIntervals(list) {
  if (list == null) return [...DEFAULT_INTERVALS];
  if (!Array.isArray(list) || list.length === 0) {
    throw new BacktestRejection('E_MANIFEST',
      `intervals must be a non-empty array; known: ${MARKET_INTERVALS.join(', ')}`);
  }
  const out = [];
  for (const raw of list) {
    const iv = String(raw ?? '').trim();
    if (!MARKET_INTERVALS.includes(iv)) {
      throw new BacktestRejection('E_MANIFEST',
        `unknown interval ${JSON.stringify(iv)}; known: ${MARKET_INTERVALS.join(', ')}`);
    }
    if (!out.includes(iv)) out.push(iv);
  }
  // Sorted so the same request always produces the same decoded-cache identity.
  return out.sort();
}

/** Validate a declared dataset list, returning it normalised. */
export function normalizeDatasets(list) {
  if (!Array.isArray(list) || list.length === 0) {
    throw new BacktestRejection('E_MANIFEST', 'datasets must be a non-empty array');
  }
  const out = [];
  for (const raw of list) {
    const ds = String(raw ?? '').trim();
    if (!KNOWN_DATASETS.includes(ds) && !DERIVED_DATASETS[ds]) {
      throw new BacktestRejection('E_MANIFEST',
        `unknown dataset ${JSON.stringify(ds)}; known: ${[...KNOWN_DATASETS, ...Object.keys(DERIVED_DATASETS)].join(', ')}`);
    }
    if (!out.includes(ds)) out.push(ds);
  }
  return out;
}

/**
 * Default cache shape, derived from the contract without explicit
 * settlement streams or opt-in datasets.
 */
const SETTLEMENT_STREAMS = new Set(['prices', 'twap30s', 'twap60s']);
export const PREWARM_DATASETS = Object.freeze(
  KNOWN_DATASETS.filter((d) => !SETTLEMENT_STREAMS.has(d) && !OPT_IN_DATASETS.includes(d)),
);

/**
 * Default prewarm shape and eligible opt-in variants. Per-day selection
 * collapses variants to one cache entry when their extra stream is unavailable.
 * NOT_WARMED excludes variants that duplicate too much cached data.
 */
// spot variants duplicate decoded days and are not prewarmed.
export const NOT_WARMED = Object.freeze(['spot']);
export const PREWARM_SHAPES = Object.freeze([
  PREWARM_DATASETS,
  ...OPT_IN_DATASETS.filter((d) => !NOT_WARMED.includes(d)).map((d) => Object.freeze([...PREWARM_DATASETS, d])),
]);
