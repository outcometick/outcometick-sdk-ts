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

import { FIRST_COMPLETE_DAY, BACKTEST_WINDOW_DAYS } from './coverage-window.mjs';

/** Manifest schema version. Field meanings never change within a version. */
export const SCHEMA_VERSION = 1;

/** SDK version reported by the docs page and stamped into every report. */
export const SDK_VERSION = '2.0.4';

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
 * 1.19.0: no protocol change. engine/report.mjs's slippage panel became a
 * streaming accumulator (the worker spools fills to disk); stamp moved again.
 *
 * 1.18.0: no protocol change. engine/report.mjs stopped embedding full rows in
 * report.json and the image COPYs engine/, so its source stamp moved; the tag
 * moves with it so deploy-worker's fingerprint check finds a matching image.
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
export const SANDBOX_IMAGE_TAG = '1.19.0';

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
  bbo: 'Unthrottled top of book. Prices only, no sizes — it removes ladder levels the venue has since moved past, and never adds any.',
  trades: 'Every trade print on the venue.',
  markets: 'Per-market metadata, strike and settlement outcome.',
});

export const KNOWN_DATASETS = Object.freeze(Object.keys(DATASETS));

/**
 * Declarable, but NOT part of the manifest the editor seeds or the prewarm warms.
 *
 * Two reasons, and NOT coverage — see DEGRADING_DATASETS: a range that predates
 * the stream runs fine, so seeding it would not break anything.
 *
 * 1. REPORT CONTINUITY. bbo changes which ladder levels are fillable, so
 *    turning it on by default changes the fills of every manifest already
 *    written. Reports we have already delivered would stop reproducing, and
 *    the customer did not ask for a different book.
 * 2. BANDWIDTH. Archive fetch is the binding constraint (1.9-3.5 MB/s against a
 *    20-minute wall clock), and the busiest series measure +13%~+29% on top of
 *    a ~112MB market-day. That is charged to every run, including the ones
 *    that would never look at it.
 *
 * The cost of opt-in is that an opted-in run pays a full decode instead of
 * hitting the prewarm, because the prewarm warms the default shape. That is the
 * honest trade: warming both shapes doubles a cache sized in tens of GB.
 */
export const OPT_IN_DATASETS = Object.freeze(['bbo']);

/**
 * Datasets that DEGRADE instead of rejecting when the archive lacks them.
 *
 * The general rule for a captured stream is the opposite — outside its window
 * is E_COVERAGE, never a silent substitution — and that rule is right for
 * anything a strategy READS. `bbo` is different in kind: a strategy never reads
 * it. It refines the order book by deleting levels the venue has since moved
 * past, so a day without it is not a wrong answer, it is the answer this
 * product gave for its whole life before 2026-09-02.
 *
 * So a range that straddles the start of capture runs: the days that have it
 * are refined, the days that do not behave exactly as they did before. What is
 * NOT optional is saying so — `bbo_days` / `bbo_missing_days` in coverage and
 * `bbo_applied` in the report, for the same reason `fill_delay_ms` is written
 * out: two reports that used different books are otherwise identical, and
 * whoever holds the archive has no way to tell which one they have.
 */
export const DEGRADING_DATASETS = Object.freeze(['bbo']);

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
    // MEASURED, not the deploy date: collection began 2026-09-02T00:42:18.154Z,
    // so 09-02 is missing its first 42 minutes and every market that opened in
    // them has no top of book at all. Registering 09-02 would accept a run over
    // a day it can only half serve — silent degradation, which is the one thing
    // a stream added mid-archive must not do. 09-03 is the first complete day.
    bbo: Object.freeze({ from: '2026-09-03', to: null }),
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
 * The days the book cadence changed, oldest first.
 *
 * Exported for the prewarm, which has to warm one shape PER CADENCE TIER: the
 * cadence is chosen from a run's date RANGE, so a range that stops short of a
 * change and one that crosses it are two different cache entries for the same
 * day. Warming a single range therefore covers exactly one tier and silently
 * misses the others — which is what happened between 2026-08-25 and
 * 2026-09-07, when the prewarm warmed the whole sellable span (500ms) while
 * every run over recent days wanted 20ms.
 *
 * Derived from the table above rather than restated, so a new cadence entry
 * grows the warm set without anyone remembering to come here.
 */
export function bookCadenceChangeDays(venue) {
  return (BOOK_CAPTURE[venue] ?? []).map((e) => e.from);
}

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
  //
  // SIZED PER RUN, not a constant — see wallClockMsFor below. A flat twenty
  // minutes was a limit on the SMALLEST run that could not finish: replay costs
  // ~24s per market-day (measured, warm cache, 289 markets and ~1.04M events in
  // a polymarket BTC day), so twenty minutes covers about fifty of them while
  // the page was selling a ninety-day chip. The customer paid, watched it work
  // for twenty minutes, and got a refund and no report.
  //
  // These two are the inputs to that function and the only numbers to tune.
  replayBaseMs: 3 * 60 * 1000,
  // NO per-market-day rate here any more (2026-09-23): it is not one number.
  // See REPLAY_MS_PER_MARKET_DAY below — a predict market-day is ~7× the bytes
  // of a polymarket one and python replays it ~3.4× slower than nodejs, so a
  // single figure named a budget three of the four combinations could not meet.
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

/**
 * The longest range one run may cover, in CALENDAR DAYS.
 *
 * The product limit. Checked against the days that actually exist in the
 * archive — the range AFTER it is intersected — not against what was asked
 * for: requesting more days than exist has always been fine and is billed for
 * what was there, and moving the check earlier would hard-fail a page whose
 * capacity figure is a few minutes stale.
 *
 * Enforced in the API and mirrored in the editor, so nobody can build a
 * submission the queue will refuse.
 *
 * Raising it is a hardware decision, not a config one: there is one worker
 * slot and a run holds it for its whole life. It equals the sellable window
 * (`BACKTEST_WINDOW_DAYS`): a run cannot cover days outside that window, so a
 * larger number here would only be a limit nobody can reach.
 */
export const MAX_BACKTEST_DAYS = BACKTEST_WINDOW_DAYS;

/**
 * The clamp on the REPLAY BUDGET's input — not a limit on what may be run.
 *
 * The budget below grows with market-days because that is what the machine
 * spends time on, and market-days are days × assets × intervals: ninety days
 * of one asset is 90, ninety days of seven assets over two intervals is 1,260.
 * Without a clamp the second would be handed an eight-hour budget and would
 * hold the only worker slot for a working day.
 *
 * So a run larger than this still RUNS — it simply is not given proportionally
 * more time, and if it cannot finish it is refunded in full like any other
 * overrun. That is the honest failure: bounded queue damage, money back.
 */
/**
 * The most REPLAY time any single run may be given, whatever it is.
 *
 * This is the real constraint: there is one worker and one slot, so this plus
 * `fetchClockMs` is how long one run can keep everyone else waiting. Held at
 * the value the old flat coefficient produced at its clamp (180 market-days ×
 * 35s + 3 min), so the worst case is unchanged by making the rate per-load.
 */
export const MAX_REPLAY_MS = 6_480_000;   // 108 minutes

/**
 * Measured milliseconds of REPLAY per market-day, by venue and language.
 *
 * ALL FOUR MEASURED, 2026-09-23, with an EMPTY strategy on one real
 * market-day — so these are the floor the pipeline costs before a strategy
 * does anything at all:
 *
 *   polymarket nodejs   48.9 s   5.58M events/market-day, 278 MB
 *   polymarket python   89.8 s   (16 µs/event)
 *   predict    nodejs   39.3 s   0.49M events/market-day,  32 MB
 *   predict    python  134.6 s   (274 µs/event)
 *
 * TWO THINGS THAT LOOK WRONG AND ARE NOT. predict has an eighth of the events
 * and still costs python three times as much: its decoded event line averages
 * 2060 characters against polymarket's 134, because every predict book event
 * is a full two-sided ladder snapshot (98.7% of a decoded day's characters)
 * while polymarket sends one-sided deltas. And polymarket, with the cheapest
 * events, is not the cheapest market-day, because it has eleven times as many
 * of them since BTC went to 20ms capture on 2026-08-25.
 *
 * THE FLAT 35s WAS BELOW ITS OWN FLOOR. It came from ~24s measured on
 * polymarket nodejs before that cadence change, and nothing moved it after —
 * so it sat under the 48.9s the same shape costs today, while the clamp
 * derived from it sold 180 market-days that would need 2.4 hours against a
 * 108-minute budget. On predict/python the same constant meant
 * `135n > 180 + 35n`: no run of two market-days or more could finish
 * REGARDLESS OF THE STRATEGY, and seventeen paying customers' runs died on it
 * before anyone noticed.
 *
 * THE EMPTY-STRATEGY FLOOR WAS THE WRONG BASE FOR THE MARGIN. Re-sized
 * 2026-10-07 from what completed paid runs actually recorded (`scanned.wall_ms`
 * over `market_days`, an upper bound since it includes the fetch):
 *
 *   polymarket python   110–135 s   real days carry 5.6–6.9M events, not 5.58M,
 *                                   at 16–19 µs/event — the old 120 s sat at or
 *                                   UNDER that with the simplest template
 *   polymarket nodejs    49 s       one sample on a 5.58M day; ≈61 s at 6.9M
 *   predict    nodejs   38–63 s     a 30-day run used 98% of its 55 s budget
 *   predict    python  134–143 s
 *
 * and the worker is a VPS whose CPU slows under neighbours without showing up
 * as steal: run_ffd32e (2026-10-06, polymarket/python, the template strategy)
 * replayed at 27.5 µs/event and timed out, while the same source on
 * overlapping days twenty minutes later ran at 18.4 — 45% slower. So each rate
 * is at least 25% over the worst completed run and ~50% over a typical one,
 * which absorbs a slowdown of that size. The exact values are picked so every
 * published ceiling factors into a scope a client can actually quote (a
 * ceiling of 74 = 2 × 37 cannot be reached inside a 35-day window).
 * predict/python keeps 180 (26% over its worst) because 35 is the backtest
 * window and anything lower stops a single-shape run from covering it.
 *
 * polymarket/python RAISED AGAIN to 210 s on 2026-10-08: the same customer's
 * template-cheap strategy replayed at ~31 µs/event for hours (≈195 s on a
 * 6.3M-event day) with no prewarm running and a warm cache — the host, not
 * the code — and 175 s killed three runs. 210 covers 31 µs on a 6.8M day. Its
 * ceiling drops 36 → 30 market-days; no customer run has ever asked for more
 * than 30. The 108-minute ceiling is unchanged on purpose (one worker slot).
 *
 * MEASURE AGAIN AFTER ANY CADENCE OR DECODER CHANGE — the surprises above came
 * from a capture change that nobody thought to re-measure against. Emitting
 * predict book events as deltas is worth about 2× (measured: 4.2× the bytes,
 * 5.3× the parse, 5.7× the apply) and would bring predict's two back down.
 */
export const REPLAY_MS_PER_MARKET_DAY = Object.freeze({
  polymarket: Object.freeze({ nodejs: 84_000, python: 210_000 }),
  predict: Object.freeze({ nodejs: 80_000, python: 180_000 }),
});

/**
 * The rate for one run. Unknown venue or language gets the SLOWEST rate.
 *
 * Fail-closed, because the two failures are not symmetric: too much budget
 * costs queue time on a run that was going to finish anyway, while too little
 * sells a run that cannot produce a report and refunds it after the customer
 * has waited.
 */
export function replayMsPerMarketDay({ venue, language } = {}) {
  const rates = (byVenue) => Object.values(byVenue);
  const byVenue = REPLAY_MS_PER_MARKET_DAY[venue];
  // AN ABSENT LANGUAGE IS NOT nodejs. It used to fall through to the fast
  // rate, so a quote that did not carry the runtime — which the public /quote
  // route did not — answered as if every submission were nodejs, and a python
  // one was then refused at /submit against a different number. Unknown means
  // unknown: take the slowest thing it could turn out to be.
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
 * How many market-days one run of this shape can actually replay in its budget.
 *
 * DERIVED, not declared. It used to be a constant 180, which was only correct
 * for the one combination the flat rate was measured on; for the others it
 * named a size the run could never finish, so the quote accepted it, charged
 * it, ran it for the whole budget and refunded it. Now the ceiling is the
 * fixed thing and the count falls out of the rate — so a slower shape is sold
 * less, rather than sold something it cannot deliver.
 */
export function budgetClampMarketDays(shape = {}) {
  return Math.floor((MAX_REPLAY_MS - LIMITS.replayBaseMs) / replayMsPerMarketDay(shape));
}

/**
 * How long a run's REPLAY may take, given its size AND its shape.
 *
 * Sized on the WARM path, because the fetch has its own budget —
 * `fetchClockMs` — and a slow archive read is our pipe being slow, not the
 * strategy. A run whose days are cold spends that time under the fetch clock
 * and arrives here with the same work to do.
 */
export function wallClockMsFor(marketDays, shape = {}) {
  const n = Number.isFinite(marketDays) && marketDays > 0 ? Math.ceil(marketDays) : 1;
  return LIMITS.replayBaseMs
    + replayMsPerMarketDay(shape) * Math.min(n, budgetClampMarketDays(shape));
}

/**
 * The ceiling that follows from the numbers above. For copy and for docs.
 *
 * The same for every shape by construction — that is what `MAX_REPLAY_MS` is —
 * so the public "up to N minutes" stays one number. Stated directly rather
 * than derived through `wallClockMsFor`: passing it an infinite size returns
 * the budget for ONE market-day, because an infinite count is not a finite
 * number and falls to the guard. (It did, and printed 3.9 minutes.)
 */
export const MAX_WALL_CLOCK_MS = MAX_REPLAY_MS;

/**
 * The clamp a client can rely on WITHOUT knowing its shape: the slowest one.
 *
 * Do not read this as "the size we sell". It is the floor across every shape,
 * so a client that only has this number will under-ask on three of the four —
 * which is why `MAX_MARKET_DAYS_BY_SHAPE` is published beside it and why the
 * quote's refusal names the shape it applied. A single scalar here was how the
 * flat 180 survived: one number that was true for one combination and a lie
 * for the rest.
 */
export const BUDGET_CLAMP_MARKET_DAYS = budgetClampMarketDays();

/**
 * Every clamp, keyed by the exact strings a submission carries: the venue and
 * the full language id (`python@3.14`, not `python`). Derived from the rate
 * table, so it cannot drift from what the quote actually enforces.
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
  // The only one `ot check` cannot produce: it means the run started and did not
  // finish. Used in eleven places across the API, the CLI and the worker long before
  // it was declared here — so the docs table, which renders these keys, never listed
  // the one code a customer was most likely to be holding when they came to look it up.
  E_RUNTIME: 'The run started but could not finish — the sandbox crashed, the feed to it was'
    + ' cut short, or the replay ended early. Nothing was billed.',
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
    // THE CEILINGS A CLIENT HAS TO KNOW BEFORE IT BUILDS A REQUEST. They are
    // not in LIMITS because LIMITS describes the sandbox — what one strategy
    // gets — and these describe what one RUN may ask for. A client that cannot
    // read them discovers them as a 422 on the paid path.
    maxBacktestDays: MAX_BACKTEST_DAYS,
    // The scalar is the floor across every shape; the table is what a client
    // should actually size against. Publishing only the scalar would have a
    // polymarket/nodejs customer asking for 35 market-days when 96 is real.
    maxMarketDays: BUDGET_CLAMP_MARKET_DAYS,
    maxMarketDaysByShape: MAX_MARKET_DAYS_BY_SHAPE,
    rejectionCodes: REJECTION_CODES,
  };
}
