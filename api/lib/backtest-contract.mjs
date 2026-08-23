// The backtest contract: what a submission may declare, and what the runner
// promises to honour. This module is the single source of truth for both ends
// — the API validates against it, the runner builds its sandbox from it, and
// /v1/backtest/contract serves it to the SDK and the docs page.
//
// Everything here is a closed set on purpose. An unknown language, dataset,
// hook or reference feed is a rejection, never a pass-through: the whole
// premise is a sealed, deterministic replay, and "we did not recognise it so we
// ignored it" is how a strategy silently gets fed something other than what it
// asked for.

import { FIRST_COMPLETE_DAY } from './coverage-window.mjs';

/** Manifest schema version. Field meanings never change within a version. */
export const SCHEMA_VERSION = 1;

/** SDK version reported by the docs page and stamped into every report. */
export const SDK_VERSION = '1.4.1';

// ---------------------------------------------------------------------------
// Languages
// ---------------------------------------------------------------------------

/**
 * Runtimes we execute, pinned exactly. A range is not accepted: two runs of the
 * same source on different patch releases can differ in float formatting or
 * dict ordering, and the product claims byte-identical reports.
 *
 * `compiled` languages are deliberately absent for now. Compiling untrusted
 * source IS untrusted execution (build.rs, proc macros, go generate), needs a
 * vendored offline module cache, and its own resource envelope — a different
 * security problem from importing a module, not a bigger version of the same
 * one. Adding one means adding an entry here plus a runner plugin; nothing in
 * the API or the schema has to move.
 */
export const LANGUAGES = Object.freeze({
  'python@3.14': Object.freeze({
    id: 'python',
    label: 'python',
    runtime: 'python 3.14 · numpy, pandas, polars, scipy',
    entrySignature: 'on_tick(ctx, tick) -> Order | None',
    // Names only. Versions are ours and there is no install step inside the
    // sandbox — the image already holds them.
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
  }),
  nodejs: Object.freeze({
    on_market_open: 'onMarketOpen',
    on_tick: 'onTick',
    on_book: 'onBook',
    on_trade: 'onTrade',
    on_settle: 'onSettle',
  }),
});

// ---------------------------------------------------------------------------
// Hooks
// ---------------------------------------------------------------------------

/**
 * The five events the runner drives. `emits` says whether returning an Order
 * from that hook is meaningful — returning one from a lifecycle hook is a
 * signature error, not a silently dropped order.
 */
export const HOOKS = Object.freeze({
  on_market_open: Object.freeze({ arity: 3, emitsOrders: false, requiresDataset: null }),
  on_tick: Object.freeze({ arity: 3, emitsOrders: true, requiresDataset: 'settlement' }),
  on_book: Object.freeze({ arity: 3, emitsOrders: true, requiresDataset: 'book' }),
  on_trade: Object.freeze({ arity: 3, emitsOrders: true, requiresDataset: 'trades' }),
  on_settle: Object.freeze({ arity: 4, emitsOrders: false, requiresDataset: null }),
});

export const KNOWN_HOOKS = Object.freeze(Object.keys(HOOKS));

// ---------------------------------------------------------------------------
// Datasets
// ---------------------------------------------------------------------------

/**
 * Dataset names as the SDK sees them. These are NOT the archive's internal
 * dataset names — `book` covers two different venue-specific trees, and
 * `settlement` is not a stored stream at all but a per-market resolution. The
 * mapping lives in backtest-datasets.mjs so this file stays a contract.
 */
export const DATASETS = Object.freeze({
  settlement: 'Resolves per market to the stream that market actually settled on.',
  prices: 'The 1 Hz Chainlink report stream.',
  twap30s: 'TWAP over a 30-second lookback.',
  twap60s: 'TWAP over a 60-second lookback.',
  book: 'Order-book snapshots and deltas.',
  trades: 'Every trade print on the venue.',
  markets: 'Per-market metadata, strike and settlement outcome.',
});

export const KNOWN_DATASETS = Object.freeze(Object.keys(DATASETS));

/**
 * A derived stream is computed from one we hold rather than captured. It is
 * always flagged as derived on every row, and may never be presented as the
 * captured stream — the honesty of the archive is the product.
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
 * When each captured stream actually starts, per venue.
 *
 * Requesting a captured stream outside its window is E_COVERAGE — never a
 * silent substitution, and never an approximation. A customer who asked for
 * twap60s and got 1 Hz reports back would draw a conclusion about a settlement
 * rule that did not exist yet.
 *
 * `null` end means "still being captured".
 */
export const CAPTURE_WINDOWS = Object.freeze({
  polymarket: Object.freeze({
    prices: Object.freeze({ from: FIRST_COMPLETE_DAY.polymarket, to: null }),
    twap30s: Object.freeze({ from: '2026-08-07', to: null }),
    twap60s: Object.freeze({ from: '2026-08-07', to: null }),
    book: Object.freeze({ from: FIRST_COMPLETE_DAY.polymarket, to: null }),
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

// ---------------------------------------------------------------------------
// Reference feeds (external data, resolved before the run)
// ---------------------------------------------------------------------------

/**
 * Outside data never arrives as a call from strategy code — the sandbox has no
 * network, and a live fetch would make the same source produce different
 * reports on different days. Feeds are resolved into a dataset ahead of the run
 * and replayed on the same clock as everything else.
 *
 * Binance klines are pre-downloaded from data.binance.vision, which publishes
 * one zip per symbol per day; see scripts/fetch-binance-reference.mjs.
 */
export const REFERENCE_FEEDS = Object.freeze({
  'binance:{symbol}:spot:1s': Object.freeze({ kind: 'klines', market: 'spot', interval: '1s' }),
  'binance:{symbol}:spot:100ms': Object.freeze({ kind: 'klines', market: 'spot', interval: '100ms', assets: Object.freeze(['BTC', 'ETH']) }),
  'binance:{symbol}:perp:1s': Object.freeze({ kind: 'klines', market: 'perp', interval: '1s' }),
  'binance:{symbol}:funding': Object.freeze({ kind: 'funding', market: 'perp', interval: null }),
});

/** Symbols we carry a reference feed for. */
export const REFERENCE_SYMBOLS = Object.freeze(['btcusdt', 'ethusdt', 'solusdt', 'xrpusdt']);

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
 * `market` shards by market-day across workers, which is what makes a
 * market-day cheap. `session` feeds one instance every market in the range as a
 * single ordered stream — it cannot be sharded, so it runs slower and bills at
 * a multiple.
 */
export const MODES = Object.freeze({
  market: Object.freeze({ shardable: true, rateMultiplier: 1 }),
  session: Object.freeze({ shardable: false, rateMultiplier: 3 }),
});

export const KNOWN_MODES = Object.freeze(Object.keys(MODES));

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

/**
 * Hard limits, enforced by the API on submission and by the sandbox at run
 * time. The API copy of a limit is a fast rejection, not the security boundary
 * — the sandbox enforces every one of these again.
 */
export const LIMITS = Object.freeze({
  maxFiles: 6,
  maxTotalSourceBytes: 256 * 1024,
  maxFileNameLength: 96,
  maxSeriesBytes: 32 * 1024 * 1024,
  maxSeriesCount: 4,
  perEventBudgetMicros: 400,
  memoryBytes: 8 * 1024 * 1024 * 1024,
  vcpu: 4,
  wallClockMs: 20 * 60 * 1000,
  logLinesPerMarketDay: 10_000,
  maxParams: 64,
  maxSweepCells: 256,
  archiveRetentionDays: 90,
});

// ---------------------------------------------------------------------------
// Rejection codes
// ---------------------------------------------------------------------------

/**
 * Every rejection a submission can earn before anything is billed. `ot check`
 * runs the same validator and returns the same codes — the docs promise that a
 * local pass is not rejected on submit, so these must stay in one place.
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
});

export const KNOWN_REJECTION_CODES = Object.freeze(Object.keys(REJECTION_CODES));

/**
 * A rejection carries its code so the CLI, the API and the page all speak the
 * same language. Thrown rather than returned wherever validation is deep enough
 * that threading a result out would obscure the check.
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

/** The whole contract, in the shape /v1/backtest/contract serves it. */
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
    rejectionCodes: REJECTION_CODES,
  };
}
