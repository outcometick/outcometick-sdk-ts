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
export const SDK_VERSION = '1.6.1';

/**
 * The tag of the sandbox images, and the ONLY place it is written down.
 *
 * The harness is baked into the image, so this tag is really a protocol
 * version: worker and harness have to agree on how results come back. Bump it
 * whenever that agreement changes, or a host still holding the previous images
 * runs the old harness under the new worker — and the failure is silent. The
 * run completes, produces no result line, and every job is refunded while
 * looking like a strategy problem.
 *
 * 1.9.0: the per-event budget judges SUSTAINED cost — the mean — instead of the
 * rate of events over the limit. The old rule measured the machine, not the
 * strategy: the budget brackets each hook with two wall-clock reads, and the
 * sandbox holds one vCPU on a two-core box while the worker decompresses and
 * feeds stdin, so an interrupted event was recorded as an event the strategy
 * spent milliseconds in. The page's own sample was rejected in production at an
 * average of 72us against this 400us budget because 1.1% of its events had been
 * descheduled. Measured in-image: the same strategy averages 7.8us idle and
 * 20.9us under contention, worst case 766us and 4090us respectively — and the
 * slow events are scattered, not front-loaded, so 1.8.0's higher floor could
 * never have fixed it. The mean is what the wall clock is made of, and it is
 * the thing customers were already told the limit means ("sustained breach").
 * 1.8.0: the per-event budget no longer judges a strategy on its first 200
 * events. That window is where lazy imports and every first call land, so a
 * strategy that breached 7 times in 151,606 events — 0.005%, against a 1%
 * tolerance — was killed because 3 of those 7 fell inside the sample. Both
 * engines now need 2,000 events before the ratio means anything, and a
 * conformance test pins the two defaults to the same number: this value decides
 * whether a run is rejected, so a divergence is the same strategy passing in
 * one language and failing in the other. THE FLOOR LIVES IN THE IMAGE, which is
 * why this tag moves — a worker on the old image keeps judging at 200.
 * 1.7.0: a book snapshot now carries only the side it is about, because
 * Polymarket publishes one side per row and an empty ladder is a side the
 * engine resets. Both harnesses track the last ask ladder per side and take the
 * LOWEST ask rather than element zero — the archive sorts descending on one
 * venue and ascending on the other, so an index read the worst offer on one of
 * them.
 * 1.6.0: the harness acknowledges each market-day it finishes replaying, on a
 * new channel, so a watching page counts finished work instead of queued bytes.
 * 1.5.0: results moved from fd 3 to the container's stdout. Docker never
 * forwarded a fourth descriptor, so fd 3 was closed inside the container and no
 * containerised run had ever returned anything.
 */
export const SANDBOX_IMAGE_TAG = '1.11.0';

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

/**
 * How densely the venue's book stream was actually captured, over time.
 *
 * NOT PART OF THE CONTRACT DOCUMENT, and deliberately absent from every
 * customer-facing surface of the backtest. The data product discloses its own
 * capture cadence — that is the archive's business, and chainlink-data's guide
 * states it. A backtest is a different promise: it says "here is what your
 * strategy would have done", and a reader should not have to hold a table of
 * sampling rates in their head to know whether the first half of their report
 * is comparable to the second.
 *
 * So this exists to REMOVE the difference rather than to report it. See
 * bookThrottleMs: EACH ASSET in a run is replayed at the coarsest cadence its
 * own date range contains, so no asset changes density partway through and no
 * boundary is ever visible. Per asset, not per run — see makeBookThrottle for
 * why levelling a whole basket to its coarsest member was rejected.
 *
 * MIRRORS PRICE_CHANGE_THROTTLE_HISTORY and PREDICT_BOOK_THROTTLE_HISTORY in
 * chainlink-data (scripts/lib/delivery.mjs). Two copies of a fact drift — this
 * repo has the scars — so if this is ever wrong the symptom is a backtest
 * quietly replaying at the wrong density, which nothing else would catch. The
 * dates are settled history and do not move; a NEW entry is the only edit this
 * should ever need, and it has to be made in both places on the same day.
 *
 * `from` is the first day the entry applies to. The collector dates a change to
 * the day AFTER it was deployed, because the deploy day is mixed and claiming
 * the finer cadence for it would promise more than the archive holds.
 */
const BOOK_CAPTURE = Object.freeze({
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
 * The cadence ONE ASSET replays at within a run: the COARSEST its date range
 * contains. Ask per asset; there is no run-wide answer by design.
 *
 * A range that crosses a change gets the older, sparser setting for all of it.
 * That is the only choice that makes a single report self-consistent without
 * making the reader aware of anything: fine days are thinned to match coarse
 * ones, rather than a report where the same strategy fills differently in its
 * first month than its last and nothing says why.
 *
 * Returns 0 when nothing in the range was throttled, which means "replay every
 * row" and is the case the whole mechanism disappears in.
 */
export function bookThrottleMs({ venue, asset, from, to }) {
  const history = BOOK_CAPTURE[venue];
  if (!history) return 0;
  const a = String(asset ?? '').toUpperCase();
  let coarsest = 0;
  for (let i = 0; i < history.length; i += 1) {
    const entry = history[i];
    const next = history[i + 1];
    // Does [from, to] overlap the window this entry governs?
    if (to < entry.from) continue;
    if (next && from >= next.from) continue;
    // `'*'` asks for the coarsest window ANY asset had — the answer for a row
    // whose asset could not be determined, which must never be thinned less
    // than the rows that could be.
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
 * Outside data never arrives as a call from strategy code — the sandbox has no
 * network, and a live fetch would make the same source produce different
 * reports on different days. Feeds are resolved into a dataset ahead of the run
 * and replayed on the same clock as everything else.
 *
 * Binance publishes these at data.binance.vision; scripts/fetch-binance.mjs
 * pulls them onto the worker ahead of time.
 *
 * EVERY ENTRY HERE IS ONE BINANCE ACTUALLY PUBLISHES. That is not a truism: the
 * first version of this table offered `spot:100ms` and `perp:1s`, and Binance
 * publishes neither — no 100ms klines at all, and futures klines stop at 1m. A
 * strategy declaring one would have passed validation, queued, been billed, and
 * received an empty feed with no error. Checked against the archive, not
 * assumed; `scripts/fetch-binance.mjs --check` re-checks.
 */
export const REFERENCE_FEEDS = Object.freeze({
  // spot/daily/klines/<SYM>/1s/ and /1m/.
  'binance:{symbol}:spot:1s': Object.freeze({ kind: 'klines', market: 'spot', interval: '1s' }),
  'binance:{symbol}:spot:1m': Object.freeze({ kind: 'klines', market: 'spot', interval: '1m' }),
});

/**
 * Symbols we carry a reference feed for — the assets we sell backtests on that
 * Binance also lists ON SPOT.
 *
 * No HYPE: Binance has no HYPEUSDT spot pair. It has a perp one, and an earlier
 * version of this table offered perp feeds for that reason — dropped, because
 * spot is what these strategies are pricing against and a perp mark is a
 * different number wearing the same name.
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
 * `market` shards by market-day across workers, which is what makes a
 * market-day cheap. `session` feeds one instance every market in the range as a
 * single ordered stream — it cannot be sharded, so it runs slower and bills at
 * a multiple.
 */
/**
 * The two ways a strategy sees the range. NEITHER COSTS MORE THAN THE OTHER.
 *
 * `session` used to bill at 3x, on the stated grounds that it "cannot be
 * sharded, so it runs slower". That reason was not true: `shardable` is read
 * nowhere outside this table and its tests — `market` mode has never actually
 * been sharded, so both modes occupy one worker for the same time. Charging
 * three times for a cost difference that does not exist is the one thing a
 * product sold on honest reporting cannot do. Owner's call, 2026-08-25: the
 * multiplier is gone. A market-day costs a credit, whichever mode reads it.
 *
 * If sharding is ever built, price it then — from the difference it actually
 * makes, not from the difference it was supposed to make.
 */
/**
 * The market intervals a backtest can ask for.
 *
 * A CLOSED set, and short on purpose: the archive contains prediction markets
 * at 5m and 15m and at no other length. Everything else the catalog carries at
 * other intervals -- 1s through 1mo -- is klines, which is Binance spot price
 * data, not a market anyone can take a position in.
 *
 * The default is 5m alone rather than both, because the two settle on the same
 * stream but behave nothing alike, and a run that quietly mixed them was
 * answering a question nobody asked.
 */
/**
 * The fill delay a run may ask the latency panel to re-price at.
 *
 * ONE delay, and OFF BY DEFAULT. Each one is another full replay of the range:
 * with the five that used to be built in, five sixths of a run's wall clock
 * went on a six-row table nobody had asked for, and a sixteen market-day run
 * could not finish inside its twenty-minute budget at all.
 *
 * The panel is worth having -- a strategy that only makes money at zero
 * latency loses it in production -- but it is a question the submitter asks,
 * one delay at a time, rather than one every run answers by default.
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
 * Hard limits, enforced by the API on submission and by the sandbox at run
 * time. The API copy of a limit is a fast rejection, not the security boundary
 * — the sandbox enforces every one of these again.
 */
export const LIMITS = Object.freeze({
  maxFiles: 6,
  maxTotalSourceBytes: 256 * 1024,
  maxFileNameLength: 96,
  // A series is the submitter's own CSV, and it rides in with the source — so
  // its budget has to be its own. It used to be 32MB while the whole submission
  // was capped at 256KB, which meant the advertised number was thirty times
  // what could actually be sent: a 90-day minute series is ~2.7MB and 256KB is
  // eight days of one.
  //
  // 8MB is 90 days of minute data on four series with room over. Kept well
  // under a body a JSON parse can hold comfortably, because these arrive as
  // strings in the submit payload.
  // 4MB, sized on the longest range we actually sell: 90 days of minute data is
  // ~2.7MB. 8MB was room for nothing anyone can ask for, and it doubled the
  // request body the API has to hold — on a box with 800MB free that also
  // carries live Stripe keys and the production database tunnel.
  //
  // This is the interim number. A series belongs in R2 by a presigned PUT from
  // the browser, not in a JSON body routed through this machine; when that
  // lands, the body limit goes back to 16kb and this cap stops mattering.
  maxSeriesBytes: 4 * 1024 * 1024,
  maxSeriesCount: 4,
  perEventBudgetMicros: 400,
  /**
   * What `ctx.log` may emit, per line and per run.
   *
   * ctx.log is for reading, not for exporting. The limit used to be 10,000
   * lines PER MARKET with no length cap at all — and polymarket has ~386
   * markets a day, so a run could emit millions of arbitrarily long lines into
   * logs.txt, which the customer then downloads. That is the archive itself
   * leaving through a channel priced at nothing.
   *
   * The numbers are chosen against the subscription, which is what the same
   * bytes cost through the front door: $5/month for 30 rolling days across
   * seven assets is $0.0238 per market-day. A decoded market-day is 573 MB, so
   * at a 2 MB budget, exporting one through the log channel takes 287 runs —
   * about $2.87 of credits, or 121x what it costs to simply buy it. And 287
   * repeat purchases of the same market-day by one subject is the loudest
   * pattern in the ledger.
   *
   * Legitimate use is nowhere near it: sixteen market-days logging one line per
   * market is 0.59 MB, which leaves more than triple the headroom.
   */
  logLineChars: 512,
  logBytesPerRun: 2 * 1024 * 1024,
  // What the worker box actually has, not what sounds generous. It is a 2 vCPU
  // / 4 GB VPS: `--cpus=4` is refused outright by the daemon ("range of CPUs is
  // from 0.01 to 2.00"), so the advertised 4 vCPU / 8 GB could never have run a
  // single container. Nobody bought under those numbers — credits have no
  // Stripe price yet — but /docs/sdk was printing them.
  //
  // 1 vCPU is not a cut, it is the truth: a strategy is single-threaded by
  // construction (the analysers reject threading and Worker, and the images
  // pin OMP_NUM_THREADS and friends to 1), so the second core was never
  // reachable from inside. It stays with the worker, which has to keep feeding
  // events down stdin while the sandbox runs. 2 GB leaves room for the worker,
  // the docker daemon and gVisor's own footprint.
  memoryBytes: 2 * 1024 * 1024 * 1024,
  vcpu: 1,
  // The REPLAY budget: it starts when the strategy does, not when the run is
  // leased. Downloading the archive is our pipe being slow, not the customer's
  // strategy being slow, and charging their execution budget for our network
  // is backwards — a 30-day run spent all twenty minutes fetching and was
  // killed without replaying an event.
  wallClockMs: 20 * 60 * 1000,
  // The FETCH budget, separate and bounded. Not unbounded, because there is one
  // worker and one slot: a stalled R2 read used to sit inside the fetch while
  // the heartbeat kept renewing the lease, so nobody could reclaim the run and
  // the customer's credits stayed held on a wedged machine. That incident is
  // why the clock covers the fetch at all; this keeps the bound and stops it
  // being taken out of the strategy's time.
  //
  // 60, MEASURED, and sized for the DEFAULT range rather than the longest one.
  // A polymarket BTC market-day is ~112 MB and R2 to the worker runs 1.9–3.5
  // MB/s, so cold: 30 days is 27–50 minutes, 60 days is 54–98, 90 days is
  // 81–147. No budget covers 90 days cold without letting one run hold the
  // only worker slot for over two hours, so the honest position is that long
  // ranges depend on the cache being warm — which is what the prewarm is for.
  // A cold long run fails inside its budget and is refunded in full, rather
  // than being allowed to monopolise the queue.
  fetchClockMs: 60 * 60 * 1000,
  maxParams: 64,
  maxSweepCells: 256,
  archiveRetentionDays: 7,
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
