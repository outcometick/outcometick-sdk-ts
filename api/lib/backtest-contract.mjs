// Shared submission and runner contract, served by /v1/backtest/contract.
// Unknown languages, datasets, hooks and reference feeds are rejected.

import { FIRST_COMPLETE_DAY, BACKTEST_WINDOW_DAYS } from './coverage-window.mjs';

/** Manifest schema version. Field meanings never change within a version. */
export const SCHEMA_VERSION = 1;

/** SDK version reported by the docs page and stamped into every report. */
export const SDK_VERSION = '2.13.4';

/**
 * Sandbox image protocol version. Bump when engine, harness or result
 * protocol changes so the worker uses a compatible image.
 *
 * 1.27.0: result line carries book_age counters (taker size by book-level age).
 * 1.26.2: no behaviour change.
 * 1.26.1: correct the assumed-tick caveat.
 * 1.26.0: add spot events and readers; preserve hook error codes.
 * 1.25.1: round record CSV values after computing the record block.
 * 1.25.0: add the market-mode recorder and result channel v.
 * 1.24.0: add probabilistic queues and print/book reconciliation.
 * 1.23.0: add execution options, global scheduling and timed session lines.
 * 1.22.0: support generic markets and end lines; cap Node heap at 1536 MB.
 * 1.21.3: remove sandbox shells.
 * 1.21.2: optimise book handling, Python parsing and tick conversion.
 * 1.21.1: allow polyfill-compatible accessors when locking built-ins.
 * 1.21.0: add resting policies and maker fields; update worker first.
 * 1.20.0: merge session streams and add fee policies; update worker first.
 * 1.19.0: stream slippage accumulation and spool fills.
 * 1.18.0: omit full rows from reports and include engine sources in images.
 * 1.9.0: enforce mean per-event cost.
 * 1.8.0: require 2,000 events before evaluating event budgets.
 * 1.7.0: update only the snapshot side and select the lowest ask.
 * 1.6.0: acknowledge completed market-days.
 * 1.5.0: return results on stdout; Docker does not forward fd 3.
 */
export const SANDBOX_IMAGE_TAG = '1.27.0';

/**
 * Decoder semantics included in run identity, separate from the image tag.
 * Bump when events or market records change in runner/events.mjs, spool-day.mjs,
 * generic-data.mjs or their Python ports.
 */
export const DECODE_SEMANTICS = 1;

// ---------------------------------------------------------------------------
// Languages
// ---------------------------------------------------------------------------

/**
 * Supported runtime identifiers. Images pin runtimes and dependencies for
 * reproducible reports. Compiled languages need a separate build sandbox,
 * offline dependency cache, resource limits and runner plugin.
 */
export const LANGUAGES = Object.freeze({
  'python@3.14': Object.freeze({
    id: 'python',
    label: 'python',
    runtime: 'python 3.14 · numpy, pandas, polars, scipy',
    entrySignature: 'on_tick(ctx, tick) -> Order | None',
    // Dependencies are preinstalled; declarations accept names only.
    deps: Object.freeze(['numpy', 'pandas', 'polars', 'scipy']),
    sourceExtensions: Object.freeze(['.py', '.json']),
  }),
  'nodejs@24': Object.freeze({
    id: 'nodejs',
    label: 'node.js',
    runtime: 'node 24 · danfo, mathjs, decimal.js',
    entrySignature: 'onTick(ctx, tick) => Order | null',
    deps: Object.freeze(['danfojs-node', 'mathjs', 'decimal.js']),
    sourceExtensions: Object.freeze(['.mjs', '.js', '.json']),
  }),
});

export const KNOWN_LANGUAGES = Object.freeze(Object.keys(LANGUAGES));

/** Hook names differ per language; the semantics do not. */
export const HOOK_NAMES = Object.freeze({
  python: Object.freeze({
    on_market_open: 'on_market_open',
    on_tick: 'on_tick',
    on_book: 'on_book',
    on_trade: 'on_trade',
    on_settle: 'on_settle',
    on_timer: 'on_timer',
  }),
  nodejs: Object.freeze({
    on_market_open: 'onMarketOpen',
    on_tick: 'onTick',
    on_book: 'onBook',
    on_trade: 'onTrade',
    on_settle: 'onSettle',
    on_timer: 'onTimer',
  }),
});

// ---------------------------------------------------------------------------
// Hooks
// ---------------------------------------------------------------------------

/**
 * Runner hooks. emitsOrders indicates whether a hook may return an Order;
 * returning one from a lifecycle hook is a signature error.
 */
export const HOOKS = Object.freeze({
  on_market_open: Object.freeze({ arity: 3, emitsOrders: false, requiresDataset: null }),
  on_tick: Object.freeze({ arity: 3, emitsOrders: true, requiresDataset: 'settlement' }),
  on_book: Object.freeze({ arity: 3, emitsOrders: true, requiresDataset: 'book' }),
  on_trade: Object.freeze({ arity: 3, emitsOrders: true, requiresDataset: 'trades' }),
  on_settle: Object.freeze({ arity: 4, emitsOrders: false, requiresDataset: null }),
  // ctx.schedule(at_ms) timers require the global scheduler.
  on_timer: Object.freeze({ arity: 3, emitsOrders: true, requiresDataset: null }),
});

export const KNOWN_HOOKS = Object.freeze(Object.keys(HOOKS));

// ---------------------------------------------------------------------------
// Datasets
// ---------------------------------------------------------------------------

/**
 * SDK dataset names mapped to archive trees by backtest-datasets.mjs.
 * settlement resolves per market rather than naming a stored stream.
 */
export const DATASETS = Object.freeze({
  settlement: 'Resolves per market to the stream that market actually settled on.',
  prices: 'The 1 Hz Chainlink report stream.',
  twap30s: 'TWAP over a 30-second lookback.',
  twap60s: 'TWAP over a 60-second lookback.',
  book: 'Order-book snapshots and deltas.',
  bbo: 'Unthrottled top of book. Prices only, no sizes: it removes ladder levels the venue has since moved past, and never adds any. On whenever book is declared.',
  spot: 'The 1 Hz Chainlink stream of each market\'s asset, fed to every market of that asset whatever it settles on. Quiet: it wakes no hook; ctx.spot() and ctx.twap_locked() read it.',
  trades: 'Every trade print on the venue.',
  markets: 'Per-market metadata, strike and settlement outcome.',
});

export const KNOWN_DATASETS = Object.freeze(Object.keys(DATASETS));

/**
 * Datasets declared along with another: declaring book declares bbo, so the
 * book is refined wherever the archive has the stream (busy series add 13–29%
 * to a ~112 MB market-day). Applied by normalizeDatasets and, through
 * _contract.json, by client/backtest/__init__.py.
 */
export const IMPLIED_DATASETS = Object.freeze({ bbo: 'book' });

/**
 * Opt-in datasets excluded from the default manifest. spot adds about 86k rows
 * per asset-day for ctx.spot() and ctx.twap_locked(). It is not degrading:
 * requests outside capture raise E_COVERAGE.
 */
export const OPT_IN_DATASETS = Object.freeze(['spot']);

/**
 * Datasets allowed to be missing without rejecting a run. bbo removes stale
 * levels; days without it use the unrefined book. Report bbo_days,
 * bbo_missing_days and bbo_applied to identify these assumptions.
 */
export const DEGRADING_DATASETS = Object.freeze(['bbo']);

/**
 * Streams computed from archived inputs. Flag each derived row to distinguish
 * it from a captured stream.
 */
export const DERIVED_DATASETS = Object.freeze({
  'twap60s:derived': Object.freeze({
    from: 'prices',
    produces: 'twap60s',
    lookbackSeconds: 60,
  }),
  'twap30s:derived': Object.freeze({
    from: 'prices',
    produces: 'twap30s',
    lookbackSeconds: 30,
  }),
});

/**
 * Captured-stream windows per venue. Requests outside a window raise E_COVERAGE
 * unless the dataset is degrading. A null end means ongoing capture.
 */
export const CAPTURE_WINDOWS = Object.freeze({
  polymarket: Object.freeze({
    prices: Object.freeze({ from: FIRST_COMPLETE_DAY.polymarket, to: null }),
    twap30s: Object.freeze({ from: '2026-08-07', to: null }),
    twap60s: Object.freeze({ from: '2026-08-07', to: null }),
    book: Object.freeze({ from: FIRST_COMPLETE_DAY.polymarket, to: null }),
    // Capture began at 2026-09-02T00:42:18.154Z; 09-03 is the first full day.
    bbo: Object.freeze({ from: '2026-09-03', to: null }),
    // The same tree as `prices`, fed differently (see DATASETS.spot).
    spot: Object.freeze({ from: FIRST_COMPLETE_DAY.polymarket, to: null }),
    trades: Object.freeze({ from: FIRST_COMPLETE_DAY.polymarket, to: null }),
    markets: Object.freeze({ from: FIRST_COMPLETE_DAY.polymarket, to: null }),
  }),
  predict: Object.freeze({
    prices: Object.freeze({ from: FIRST_COMPLETE_DAY.predict, to: null }),
    twap30s: Object.freeze({ from: '2026-08-07', to: null }),
    twap60s: Object.freeze({ from: '2026-08-07', to: null }),
    book: Object.freeze({ from: FIRST_COMPLETE_DAY.predict, to: null }),
    trades: Object.freeze({ from: FIRST_COMPLETE_DAY.predict, to: null }),
    markets: Object.freeze({ from: FIRST_COMPLETE_DAY.predict, to: null }),
  }),
});

/**
 * Historical book cadence. Replay uses the coarsest cadence in each asset's
 * range to keep density consistent. Excluded from contractDocument.
 * Keep in sync with PRICE_CHANGE_THROTTLE_HISTORY and PREDICT_BOOK_THROTTLE_HISTORY
 * in chainlink-data/scripts/lib/delivery.mjs. from is the first full day of a
 * new cadence; the mixed collector-change day uses the previous cadence.
 */
export const BOOK_CAPTURE = Object.freeze({
  polymarket: Object.freeze([
    Object.freeze({ from: '2026-06-06', defaultMs: 500, perAsset: Object.freeze({}) }),
    Object.freeze({ from: '2026-08-25', defaultMs: 500, perAsset: Object.freeze({ BTC: 20, ETH: 100 }) }),
  ]),
  predict: Object.freeze([
    Object.freeze({ from: '2026-06-12', defaultMs: 1000, perAsset: Object.freeze({}) }),
    // 0 means every upstream frame was archived.
    Object.freeze({ from: '2026-08-25', defaultMs: 0, perAsset: Object.freeze({}) }),
  ]),
});

/**
 * Cadence change days, oldest first. Prewarming needs each tier because
 * the requested range determines a day's decoded-cache shape.
 */
export function bookCadenceChangeDays(venue) {
  return (BOOK_CAPTURE[venue] ?? []).map((e) => e.from);
}

/**
 * Coarsest cadence for one asset across the range, in milliseconds.
 * Thin finer days to match; 0 means replay every row.
 */
export function bookThrottleMs({ venue, asset, from, to }) {
  const history = BOOK_CAPTURE[venue];
  if (!history) return 0;
  const a = String(asset ?? '').toUpperCase();
  let coarsest = 0;
  for (let i = 0; i < history.length; i += 1) {
    const entry = history[i];
    const next = history[i + 1];
    // Skip cadence windows outside [from, to].
    if (to < entry.from) continue;
    if (next && from >= next.from) continue;
    // Unknown assets use the coarsest cadence across assets.
    const ms = a === '*'
      ? Math.max(entry.defaultMs, ...Object.values(entry.perAsset))
      : (entry.perAsset[a] ?? entry.defaultMs);
    if (ms > coarsest) coarsest = ms;
  }
  return coarsest;
}

// ---------------------------------------------------------------------------
// Reference feeds (external data, resolved before the run)
// ---------------------------------------------------------------------------

/**
 * Reference feeds are resolved before replay and use the event clock; the
 * sandbox has no network. scripts/fetch-binance.mjs fetches published Binance
 * feeds; --check verifies availability.
 */
export const REFERENCE_FEEDS = Object.freeze({
  // spot/daily/klines/<SYM>/1s/ and /1m/.
  'binance:{symbol}:spot:1s': Object.freeze({ kind: 'klines', market: 'spot', interval: '1s' }),
  'binance:{symbol}:spot:1m': Object.freeze({ kind: 'klines', market: 'spot', interval: '1m' }),
});

/**
 * Supported Binance spot symbols. HYPE has a perpetual pair, not a spot pair.
 */
export const REFERENCE_SYMBOLS = Object.freeze([
  'btcusdt', 'ethusdt', 'solusdt', 'xrpusdt', 'bnbusdt', 'dogeusdt',
]);

/** `binance:btcusdt:spot:1s` -> {feed, symbol} or null if it is not a feed we carry. */
export function parseReferenceFeed(name) {
  const s = String(name ?? '').trim().toLowerCase();
  const parts = s.split(':');
  if (parts[0] !== 'binance' || parts.length < 3) return null;
  const symbol = parts[1];
  if (!REFERENCE_SYMBOLS.includes(symbol)) return null;
  const pattern = ['binance', '{symbol}', ...parts.slice(2)].join(':');
  const feed = REFERENCE_FEEDS[pattern];
  if (!feed) return null;
  if (feed.assets && !feed.assets.includes(symbol.replace(/usdt$/, '').toUpperCase())) return null;
  return { canonical: s, pattern, symbol, ...feed };
}

// ---------------------------------------------------------------------------
// Run modes
// ---------------------------------------------------------------------------

/**
 * market uses independent market-day instances; session uses one instance
 * with a merged stream. shardable describes capability, not current distribution.
 */
/**
 * Both modes use the same worker resource limits.
 */
/**
 * Supported backtest intervals are 5m and 15m, defaulting to 5m. Other
 * archived durations are not supported market intervals here.
 */
/**
 * Maximum latency-panel delay in ms. The panel is off by default and accepts
 * one delay, requiring another full replay.
 */
export const MAX_LATENCY_MS = 10_000;

export const MARKET_INTERVALS = Object.freeze(['5m', '15m']);
export const DEFAULT_INTERVALS = Object.freeze(['5m']);

export const MODES = Object.freeze({
  market: Object.freeze({ shardable: true }),
  session: Object.freeze({ shardable: false }),
});

export const KNOWN_MODES = Object.freeze(Object.keys(MODES));

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

/**
 * Submission and sandbox limits. API checks provide early rejection;
 * runtime isolation is the security boundary.
 */
export const LIMITS = Object.freeze({
  maxFiles: 6,
  maxTotalSourceBytes: 256 * 1024,
  maxFileNameLength: 96,
  // Series have separate byte limits. A 90-day minute series is about 2.7 MB;
  // the 4 MB cap bounds strings in the JSON submission body.
  maxSeriesBytes: 4 * 1024 * 1024,
  maxSeriesCount: 4,
  perEventBudgetMicros: 400,
  /**
 * Diagnostic output limits per line and per run, bounding replay log size.
 */
  logLineChars: 512,
  logBytesPerRun: 2 * 1024 * 1024,
  // On the 2-vCPU, 4-GB worker, reserve one core for event feeding and memory
  // for the worker, Docker and gVisor. Strategies and numerical libraries
  // run single-threaded.
  memoryBytes: 2 * 1024 * 1024 * 1024,
  vcpu: 1,
  // Replay timing starts with strategy execution. wallClockMsFor uses
  // this base and per-shape rates; fetching has a separate clock.
  replayBaseMs: 3 * 60 * 1000,
  // Fetch timeout bounds slot occupancy, including stalled reads.
  // Cold Polymarket BTC data is about 112 MB/day at 1.9–3.5 MB/s;
  // 30 days takes 27–50 minutes. Longer ranges rely on prewarming.
  fetchClockMs: 60 * 60 * 1000,
  maxParams: 64,
  maxSweepCells: 256,
  archiveRetentionDays: 7,
});

/**
 * Maximum calendar-day span after intersecting with available archive days.
 * Shared by API and editor and bounded by BACKTEST_WINDOW_DAYS.
 */
export const MAX_BACKTEST_DAYS = BACKTEST_WINDOW_DAYS;

/**
 * Replay budgets grow with market-days (days × assets × intervals) up to
 * a fixed ceiling; larger runs receive no additional replay time.
 */
/**
 * Replay-time ceiling per run. Together with fetchClockMs, this bounds
 * worker-slot occupancy.
 */
export const MAX_REPLAY_MS = 6_480_000;   // 108 minutes

/**
 * Replay budgets in ms per market-day. Empty-strategy worker measurements:
 * Polymarket Node 48.9 s (5.58M events, 278 MB), Python 89.8 s;
 * Predict Node 39.3 s (0.49M events, 32 MB), Python 134.6 s.
 * Predict full-ladder events are larger and cost more to parse in Python.
 * Completed runs measured 110–135 s for Polymarket Python, 49 s for Node,
 * 38–63 s for Predict Node and 134–143 s for Python. Rates include headroom
 * for host contention and queue work; a Polymarket Python resting-order
 * template measured 198 s including fetch on one BTC day.
 * Re-measure after capture-cadence or decoder changes.
 */
export const REPLAY_MS_PER_MARKET_DAY = Object.freeze({
  polymarket: Object.freeze({ nodejs: 84_000, python: 260_000 }),
  predict: Object.freeze({ nodejs: 80_000, python: 180_000 }),
});

/**
 * Replay rate for a shape. Unknown venues and absent languages use the
 * slowest applicable rate; non-Python language strings select Node.
 */
export function replayMsPerMarketDay({ venue, language } = {}) {
  const rates = (byVenue) => Object.values(byVenue);
  const byVenue = REPLAY_MS_PER_MARKET_DAY[venue];
  // Absent language selects the slowest applicable rate.
  const known = language === undefined || language === null
    ? null
    : (String(language).startsWith('python') ? 'python' : 'nodejs');
  if (!byVenue) {
    const all = Object.values(REPLAY_MS_PER_MARKET_DAY)
      .flatMap((v) => (known ? [v[known]] : rates(v)));
    return Math.max(...all);
  }
  return known ? byVenue[known] : Math.max(...rates(byVenue));
}

/**
 * Market-day ceiling derived from replay limit, base time and shape rate.
 */
export function budgetClampMarketDays(shape = {}) {
  return Math.floor((MAX_REPLAY_MS - LIMITS.replayBaseMs) / replayMsPerMarketDay(shape));
}

/**
 * Replay budget by size and shape, capped at the market-day ceiling.
 * Fetching uses the separate fetchClockMs budget.
 */
export function wallClockMsFor(marketDays, shape = {}) {
  const n = Number.isFinite(marketDays) && marketDays > 0 ? Math.ceil(marketDays) : 1;
  return LIMITS.replayBaseMs
    + replayMsPerMarketDay(shape) * Math.min(n, budgetClampMarketDays(shape));
}

/**
 * Public replay-time ceiling. Passing Infinity to wallClockMsFor would
 * select its one-market-day fallback, not the ceiling.
 */
export const MAX_WALL_CLOCK_MS = MAX_REPLAY_MS;

/**
 * Conservative ceiling across all shapes. Use MAX_MARKET_DAYS_BY_SHAPE
 * when venue and runtime are known.
 */
export const BUDGET_CLAMP_MARKET_DAYS = budgetClampMarketDays();

/**
 * Ceilings keyed by venue and full language id, derived from replay rates.
 */
export const MAX_MARKET_DAYS_BY_SHAPE = Object.freeze(
  Object.fromEntries(Object.keys(REPLAY_MS_PER_MARKET_DAY).map((venue) => [
    venue,
    Object.freeze(Object.fromEntries(Object.keys(LANGUAGES).map((language) => [
      language,
      budgetClampMarketDays({ venue, language }),
    ]))),
  ])),
);

// ---------------------------------------------------------------------------
// Rejection codes
// ---------------------------------------------------------------------------

/**
 * Shared validation and runtime rejection codes for API, CLI and runner.
 */
export const REJECTION_CODES = Object.freeze({
  E_MANIFEST: 'Missing or malformed outcometick.json, or a schema version we do not know.',
  E_ENTRY: 'entry does not resolve to a class in the named file, or the class does not implement the SDK base.',
  E_HOOK_SIG: 'A declared hook has the wrong arity or returns a type that is not Order or nothing.',
  E_IMPORT: 'An import outside the allowlist, transitive ones included. The offending chain is printed.',
  E_FORBIDDEN: 'Threads, subprocess, eval, dynamic import, reflection or a native extension found at import time.',
  E_NONDETERMINISM: 'Unseeded randomness or a wall-clock read. Use ctx.random and ctx.now.',
  E_STATE: 'Instance state is not serialisable, so the market-day cannot be moved between workers.',
  E_BUDGET: 'Per-event budget exceeded on the smoke run. Nothing was billed.',
  E_COVERAGE: 'A captured stream was requested outside the window it was captured in.',
  E_LIMIT: 'A submission limit was exceeded — file count, total source size or series size.',
  E_SCOPE: 'The requested venue, asset or date range is not something we can serve.',
  // Failure after execution starts.
  E_RUNTIME: 'The run started but could not finish — the sandbox crashed, the feed to it was'
    + ' cut short, or the replay ended early. Nothing was billed.',
});

export const KNOWN_REJECTION_CODES = Object.freeze(Object.keys(REJECTION_CODES));

/**
 * Error carrying a shared code, detail and optional structured fields.
 */
export class BacktestRejection extends Error {
  constructor(code, detail, extra = {}) {
    if (!REJECTION_CODES[code]) throw new Error(`unknown rejection code ${code}`);
    super(detail || REJECTION_CODES[code]);
    this.name = 'BacktestRejection';
    this.code = code;
    this.detail = detail || REJECTION_CODES[code];
    Object.assign(this, extra);
  }

  toJSON() {
    const { code, detail, ...rest } = this;
    return { code: this.code, detail: this.detail, ...stripNoise(rest) };
  }
}

function stripNoise(o) {
  const out = {};
  for (const [k, v] of Object.entries(o)) {
    if (k === 'name' || k === 'message' || k === 'stack') continue;
    out[k] = v;
  }
  return out;
}

/**
 * Contract document served by /v1/backtest/contract.
 */
export function contractDocument() {
  return {
    schema: SCHEMA_VERSION,
    sdkVersion: SDK_VERSION,
    languages: Object.fromEntries(Object.entries(LANGUAGES).map(([k, v]) => [k, {
      label: v.label, runtime: v.runtime, entrySignature: v.entrySignature, deps: [...v.deps],
    }])),
    hooks: HOOKS,
    hookNames: HOOK_NAMES,
    datasets: DATASETS,
    derivedDatasets: DERIVED_DATASETS,
    captureWindows: CAPTURE_WINDOWS,
    referenceFeeds: REFERENCE_FEEDS,
    referenceSymbols: [...REFERENCE_SYMBOLS],
    modes: MODES,
    limits: LIMITS,
    // Run-scope ceilings, separate from per-strategy sandbox limits.
    maxBacktestDays: MAX_BACKTEST_DAYS,
    // Use the shape table when runtime is known; the scalar is conservative.
    maxMarketDays: BUDGET_CLAMP_MARKET_DAYS,
    maxMarketDaysByShape: MAX_MARKET_DAYS_BY_SHAPE,
    rejectionCodes: REJECTION_CODES,
  };
}
