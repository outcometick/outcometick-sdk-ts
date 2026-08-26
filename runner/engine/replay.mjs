// The event loop: what actually drives a strategy.
//
// Control is inverted. The strategy has no main(), no loop, no clock and no
// file handles — this module owns all of it and hands over events one at a
// time, in event-time order. Look-ahead is impossible here not because we
// filter it out but because future rows are not in the process yet: the caller
// feeds an iterator and we never read ahead of the cursor.
//
// Decode once, replay many. A market-day's events are decoded by the caller and
// handed here as an array; running the same array again with different params
// is what makes a 36-cell parameter sweep cost one market-day, and what lets
// the latency panel re-price every fill at six different delays. Both are our
// CPU, not the customer's data.

import { Book } from './book.mjs';
import { Portfolio } from './portfolio.mjs';


// Mirrors LIMITS.logLineChars / LIMITS.logBytesPerRun, and does NOT import
// them. This file is baked into the sandbox image, which contains runner/ and
// nothing else — an import of api/ resolves fine on a developer's machine and
// on the worker, and then fails inside every container with
// ERR_MODULE_NOT_FOUND. otreplay.py mirrors the same two numbers for the same
// reason. replay-limits.test.mjs asserts both copies still equal the contract.
const LOG_LINE_CHARS = 512;
const LOG_BYTES_PER_RUN = 2 * 1024 * 1024;

// A settlement recompute is a once-per-market claim, so these are generous.
// They exist because `crosschecks` rides the same result line as everything
// else: unbounded, it is an output channel with no budget. Mirrored in
// otreplay.py.
const MAX_CROSSCHECKS_PER_MARKET = 16;
const CROSSCHECK_CLAIMED_CHARS = 32;


/** Event kinds the loop understands, in the order they dispatch. */
export const EVENT_KINDS = Object.freeze(['tick', 'book', 'trade']);

/**
 * Per-event budget.
 *
 * Measured over the strategy's own hook, not the loop around it. Sustained cost
 * over budget kills the shard rather than the run: one pathological market must
 * not cost the customer the other 719.
 */
export class BudgetMonitor {
  constructor({ limitMicros = 400, sampleFloor = 2000 } = {}) {
    this.limitMicros = limitMicros;
    this.sampleFloor = sampleFloor;
    this.count = 0;
    this.breaches = 0;
    this.maxMicros = 0;
    this.totalMicros = 0;
    // The most recent `sampleFloor` events, as a ring. One monitor covers the
    // WHOLE run, so a lifetime mean is diluted by however much came before: a
    // strategy that runs 18,000 events at 8us and then 2,000 at 2,000us has a
    // lifetime mean of 207us and passes, while its last 2,000 events are
    // continuously 5x over budget. The window is what makes "sustained" local.
    this.window = new Float64Array(sampleFloor);
    this.windowSum = 0;
    this.windowAt = 0;
  }

  record(micros) {
    this.count += 1;
    this.totalMicros += micros;
    if (micros > this.maxMicros) this.maxMicros = micros;
    if (micros > this.limitMicros) this.breaches += 1;
    this.windowSum += micros - this.window[this.windowAt];
    this.window[this.windowAt] = micros;
    this.windowAt = (this.windowAt + 1) % this.window.length;
  }

  /** Mean of the most recent `sampleFloor` events. Zero until the window fills. */
  get windowMicros() {
    return this.count >= this.sampleFloor ? this.windowSum / this.window.length : 0;
  }

  /**
   * SUSTAINED cost, which is what the limit is for and what customers are told
   * it means ("sustained breach kills the shard"): the mean of the most recent
   * `sampleFloor` events, not the tail and not the lifetime.
   *
   * This judged the breach RATE against a 1% tolerance, and it was measuring
   * the wrong machine. The budget brackets each hook with two wall-clock reads,
   * on a 2-core box where the worker is decompressing and feeding stdin the
   * whole time and the sandbox holds one vCPU — so an event that gets
   * descheduled is recorded as an event the strategy spent 4ms in. Measured
   * inside the real image: the same strategy on an idle host averages 7.8us
   * with a 766us worst case, and under contention averages 20.9us with a 4090us
   * worst case. Nothing about the strategy changed.
   *
   * The page's own sample was rejected in production at avg 72us — a fifth of
   * its 400us budget — because 1.1% of its events had been interrupted. The
   * breaches were not even front-loaded, so a longer warm-up floor could never
   * have fixed it: measured in-image they land at events 171, 2368, 3201 and so
   * on, which is the shape of GC and scheduling, not of a slow strategy.
   *
   * The mean is what actually predicts the thing this protects — the 20-minute
   * wall clock is mean times event count — and it is not fooled by a machine
   * that takes the CPU away. A strategy that really is slow raises the mean; an
   * interrupted one does not. A single hook that never returns is still caught,
   * by the run deadline, which is where that belongs.
   *
   * WINDOWED, NOT LIFETIME. One monitor covers the whole run, so a lifetime
   * mean lets a cheap prefix pay for an expensive phase: 18,000 events at 8us
   * followed by 2,000 at 2,000us averages 207us and passes, while the strategy
   * has been 5x over budget for its last two thousand events. The window is
   * what makes "sustained" mean sustained rather than "on average, eventually".
   *
   * `breaches` and `max_micros` stay in the summary. They are good diagnostics.
   * They are not a verdict.
   *
   * KNOWN AND DELIBERATE GAP: a low-frequency, very heavy event slips through.
   * One 500ms hook among 2,000 events at 8us is a window mean of 258us, inside
   * budget; it would take 800ms to trip on its own. A per-hook hard cap would
   * close it, and it is not being added, because this limit has now been wrong
   * twice and BOTH times the same way — a one-off cost judged as a sustained
   * one, killing a strategy that was fine. Building an index on the first tick
   * is a legitimate 300ms hook. The wall clock already bounds total resource
   * use, so the cap would buy protection against a failure nobody has seen at
   * the cost of the exact mistake already made twice. Add it when a real run
   * demonstrates the need, not before.
   */
  get breached() {
    return this.count >= this.sampleFloor && this.windowMicros > this.limitMicros;
  }

  get avgMicros() { return this.count ? this.totalMicros / this.count : 0; }

  summary() {
    return {
      events: this.count,
      breaches: this.breaches,
      breach_rate: this.count ? this.breaches / this.count : 0,
      avg_micros: this.avgMicros,
      // The number the verdict is actually made on. Without it a rejection
      // shows a lifetime average comfortably inside budget and reads as a lie.
      window_micros: this.windowMicros,
      window_events: this.sampleFloor,
      max_micros: this.maxMicros,
      limit_micros: this.limitMicros,
    };
  }
}

/** Raised when a run must stop for a reason the submitter can act on. */
export class RunAbort extends Error {
  constructor(code, detail) {
    super(detail);
    this.name = 'RunAbort';
    this.code = code;
    this.detail = detail;
  }
}

/**
 * Build the object a strategy sees, plus a private handle for the loop.
 *
 * A CLOSURE, not a class with underscore-prefixed fields. The earlier version
 * held `_pf`, `_book`, `_history` and `_logs` as ordinary properties, which
 * meant a strategy could reach `ctx._pf.trades` and push a fabricated settled
 * trade straight into the report — verified: a submitted strategy could invent
 * a $990,000 profit, or delete its real losses, and the worker would archive it
 * as fact. That defeats the entire claim that the report is computed outside
 * the strategy from engine-owned facts.
 *
 * Nothing below is reachable from the returned `ctx`: the internals exist only
 * as locals captured by the methods, and `control` is kept by the loop.
 *
 * `now` is a getter for the same reason. It looks like a harmless field, but
 * `ctx.ref()` and `ctx.ext()` use it as the point-in-time cursor — a strategy
 * that could assign it would read reference rows from the future.
 */
/**
 * A read-only view of a book.
 *
 * `ctx.book()` used to hand back the LIVE Book, whose ladders are plain arrays.
 * A strategy could `unshift` a level that never existed and then fill against
 * it — verified: an order filled at $0.01 in a market whose real best ask was
 * $0.90, and the fabricated fill went into the report as fact.
 *
 * Rebuilt per call rather than cached: the underlying book changes on every
 * book event, and a stale view would be a different bug in the same place.
 */
function bookView(book) {
  if (!book) return null;
  return Object.freeze({
    marketId: book.marketId,
    get ts() { return book.ts; },
    best: (side) => book.best(side),
    bestBid: (side) => book.bestBid(side),
    best_bid: (side) => book.bestBid(side),
    depth: (side, bound = null) => book.depth(side, bound),
    bidDepth: (side, bound = null) => book.bidDepth(side, bound),
    bid_depth: (side, bound = null) => book.bidDepth(side, bound),
    // .levels() already returns freshly-built pairs, so mutating the result
    // reaches nothing.
    levels: (side, n = 10) => book.levels(side, n),
    bidLevels: (side, n = 10) => book.bidLevels(side, n),
    bid_levels: (side, n = 10) => book.bidLevels(side, n),
    mid: (side) => book.mid(side),
  });
}

function createCtx({ params, portfolio, marketId, market, logBudget, references, series, rng }) {
  const history = [];
  const logs = [];
  const crosschecks = [];
  let book = null;
  let now = 0;
  let logTruncated = false;

  const refs = references ?? new Map();
  const ext = series ?? new Map();

  const tail = (window) => {
    const n = Math.max(1, Math.min(Number(window) || 1, history.length));
    return history.slice(history.length - n).map((t) => t.value);
  };

  const ctx = {
    p: params,

    get now() { return now; },

    /** The book as of this millisecond. Never a future state. */
    book(id = null) {
      if (id && id !== marketId) {
        // Cross-market reads are what session mode is for. Returning another
        // market's book would silently break the sharding guarantee.
        throw new RunAbort('E_STATE',
          `ctx.book(${id}) from market ${marketId}: cross-market state needs mode "session"`);
      }
      return bookView(book);
    },

    /** The last n ticks already seen. Never more, by construction. */
    history(n = 1) {
      const k = Math.max(0, Math.min(Number(n) || 0, history.length));
      // A COPY: handing back the live array would let a strategy rewrite the
      // series its own indicators are computed from.
      return history.slice(history.length - k).map((t) => ({ ...t }));
    },

    position() {
      // The REAL book here: this is the engine marking the position, not the
      // strategy reading it.
      return portfolio.position(marketId, book);
    },

    log(msg) {
      // BYTES FOR THE WHOLE RUN, not lines per market. The old shape — 10,000
      // lines per market, no length cap — let a run emit the archive it had
      // just paid a market-day for into a file the customer downloads. See
      // LIMITS.logBytesPerRun for the arithmetic that picks these numbers.
      if (logBudget.spent >= logBudget.bytes) { logTruncated = true; return; }
      const line = `${now} ${String(msg)}`.slice(0, logBudget.lineChars);
      // BYTES, not string length. logs.txt is UTF-8, and `.length` counts
      // UTF-16 units — so a run logging Chinese spent a third of what it
      // wrote, and the archive could reach three times the 2 MB this budget
      // advertises. The line cap stays in characters because it is about
      // being readable; the run cap is about how much data leaves with the
      // customer, and that is measured in bytes.
      logBudget.spent += Buffer.byteLength(line, 'utf8') + 1;
      logs.push(line);
    },

    /** Seeded generator — the only randomness available, and it is recorded. */
    random(seed = null) { return rng(seed); },

    /**
     * A declared reference feed as of now.
     *
     * `.last`, `.window(n)` and `.at(ts)` can never see a row stamped after
     * ctx.now, so a carelessly built signal cannot leak the future into a
     * backtest.
     */
    ref(name) {
      const feed = refs.get(name);
      if (!feed) throw new RunAbort('E_MANIFEST', `reference feed ${name} was not declared in the manifest`);
      return feed.viewAt(now);
    },

    ext(name) {
      const s = ext.get(name);
      if (!s) throw new RunAbort('E_MANIFEST', `series ${name} was not declared in the manifest`);
      return s.viewAt(now);
    },

    /** Rolling helpers over the tick history. Identical across languages. */
    zscore(value, { window = 60 } = {}) {
      const xs = tail(window);
      if (xs.length < 2) return 0;
      const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
      const variance = xs.reduce((a, b) => a + (b - mean) ** 2, 0) / xs.length;
      const sd = Math.sqrt(variance);
      return sd === 0 ? 0 : (value - mean) / sd;
    },

    sma(window = 60) {
      const xs = tail(window);
      return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
    },

    stdev(window = 60) {
      const xs = tail(window);
      if (xs.length < 2) return 0;
      const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
      return Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / xs.length);
    },

    ema(window = 60) {
      const xs = tail(window);
      if (!xs.length) return null;
      const k = 2 / (xs.length + 1);
      return xs.reduce((acc, x, i) => (i === 0 ? x : x * k + acc * (1 - k)), 0);
    },

    /**
     * Compare the strategy's own recompute against the official settlement.
     *
     * Recorded rather than enforced: a mismatch is information for the
     * cross-check panel, not grounds to fail someone's run.
     */
    assert_outcome(_market, outcome) {
      // The first argument is IGNORED for everything that matters. It used to
      // supply both `official` and `market_id`, so a strategy could call
      // ctx.assert_outcome({ market_id: realId, outcome: 'UP' }, 'UP') — or
      // simply mutate the market object it was handed — and book itself a
      // recompute match that never happened. The cross-check panel's whole
      // value is that it is the ARCHIVE's answer, not the strategy's.
      const official = market?.outcome ?? null;
      // BOUNDED, for the same reason ctx.log is. `outcome` is whatever the
      // strategy passed and this can be called on every event, so an unbounded
      // push here is an unmetered output channel wearing a different name: the
      // whole array is serialised onto the authenticated result line, sent,
      // and parsed by the worker before anything downstream gets to ignore it.
      // The panel only ever shows an aggregate, so nothing of value is lost by
      // capping — a settlement recompute is a once-per-market claim.
      if (crosschecks.length >= MAX_CROSSCHECKS_PER_MARKET) return;
      crosschecks.push({
        market_id: marketId,
        claimed: typeof outcome === 'string'
          ? outcome.slice(0, CROSSCHECK_CLAIMED_CHARS)
          : String(outcome).slice(0, CROSSCHECK_CLAIMED_CHARS),
        official,
        match: official === outcome,
      });
    },
  };

  const control = {
    setNow(v) { now = v; },
    setBook(b) { book = b; },
    // A COPY. The same object is handed to the hook, and a strategy that
    // writes to `tick.value` would otherwise be rewriting the series its own
    // zscore/sma/ema are computed from — and the report's prices with it.
    pushTick(ev) { history.push({ ...ev }); },
    logs,
    crosschecks,
    get logTruncated() { return logTruncated; },
  };

  return { ctx, control };
}

/** Deterministic PRNG. The seed is recorded in the report. */
export function makeRng(runSeed) {
  return (seed = null) => {
    // splitmix32 — small, fast, and identical to the Python harness's copy.
    let s = ((seed == null ? runSeed : Number(seed)) >>> 0);
    return () => {
      s = (s + 0x9e3779b9) >>> 0;
      let z = s;
      z = Math.imul(z ^ (z >>> 16), 0x21f0aaad) >>> 0;
      z = Math.imul(z ^ (z >>> 15), 0x735a2d97) >>> 0;
      return ((z ^ (z >>> 15)) >>> 0) / 4294967296;
    };
  };
}

/** Which hook an event dispatches to. */
const HOOK_FOR = { tick: 'on_tick', book: 'on_book', trade: 'on_trade' };

/**
 * Replay one market.
 *
 * @param {object} market      metadata: market_id, asset, strike, outcome, close_ts_ms
 * @param {Array}  events      already merged into event-time order by the caller
 * @param {object} strategy    the instance, with hooks under their canonical names
 * @param {object} opts
 * @param {number} opts.fillDelayMs  match every order this much later than the
 *   decision. Zero is "as captured"; the latency panel is this same replay at
 *   100ms, 250ms, 500ms, 1s and 2s.
 */
/**
 * A log allowance for one run.
 *
 * Bytes, not lines, and shared by every market in the run — see
 * LIMITS.logBytesPerRun for why those two choices are the whole fix.
 */
export function makeLogBudget({
  bytes = LOG_BYTES_PER_RUN,
  lineChars = LOG_LINE_CHARS,
} = {}) {
  return { bytes, lineChars, spent: 0 };
}

export function replayMarket({
  market, events, strategy, hooks,
  portfolio = null,
  fillDelayMs = 0,
  /**
   * The run's remaining log allowance, SHARED ACROSS MARKETS.
   *
   * Passed in rather than created here, because a per-market allowance is what
   * the old limit was and what made the log channel an export route: 386
   * markets a day each got their own budget. One object for the whole run is
   * the fix — the harness makes it once and hands the same one to every market.
   */
  logBudget = null,
  budget = null,
  references = null,
  series = null,
  seed = 1,
  feeBps = 0,
}) {
  const marketId = market.market_id;
  const pf = portfolio ?? new Portfolio({ feeBps });
  const book = new Book(marketId);
  const monitor = budget ?? new BudgetMonitor();
  // The engine keeps its OWN copy and hands the strategy a different one.
  // Both halves matter: settlement reads `outcome` from here, so a strategy
  // that mutated the object it was handed would have forged not just the
  // cross-check panel but its own PnL — every position settling the way it
  // said rather than the way the venue did.
  const engineMarket = { ...market };

  /**
   * What a hook is allowed to see about the market, BEFORE it settles.
   *
   * `outcome` is a future fact and it is stripped. It arrived here because the
   * worker's market metadata carries the settled result — so a strategy could
   * read `market.outcome` in on_market_open, buy the winning side at whatever
   * it was quoted at, and every number in the report became meaningless.
   * Verified: a 900% return on a market the strategy was simply told the answer
   * to. This is not an output-forgery hole; it is the documented SDK input
   * handing over the answer.
   *
   * Only on_settle sees it, which is exactly what the docs say: "on_settle …
   * carrying the official outcome and strike".
   */
  const preSettleMarket = () => {
    const { outcome, ...rest } = engineMarket;
    return rest;
  };
  const { ctx, control } = createCtx({
    params: strategy.p ?? {},
    portfolio: pf,
    marketId,
    market: engineMarket,
    logBudget: logBudget ?? makeLogBudget(),
    references,
    series,
    rng: makeRng(seed),
  });
  control.setBook(book);

  // Orders decided at T but matched at T + fillDelayMs, and hold_s expiries.
  /** @type {Array<{at:number, kind:'order'|'flatten', payload:any}>} */
  const pending = [];
  const schedule = (at, kind, payload) => {
    let i = pending.length;
    while (i > 0 && pending[i - 1].at > at) i -= 1;
    pending.splice(i, 0, { at, kind, payload });
  };

  const drainUntil = (ts) => {
    while (pending.length && pending[0].at <= ts) {
      const job = pending.shift();
      if (job.kind === 'order') {
        const res = pf.execute({ book, order: job.payload, ts: job.at, marketId, how: 'exit' });
        // hold_s is measured from the FILL, not the decision: a fill that
        // landed late has not been held as long.
        if (res?.filled > 0 && job.payload.hold_s > 0 && !job.payload.reduce_only) {
          schedule(job.at + job.payload.hold_s * 1000, 'flatten', { side: job.payload.side });
        }
      } else {
        pf.flatten(marketId, book, job.at, 'hold_expired');
      }
    }
  };

  const call = (name, ...args) => {
    const fn = hooks[name] && strategy[hooks[name]];
    if (typeof fn !== 'function') return undefined;
    const t0 = process.hrtime.bigint();
    let out;
    try {
      out = fn.call(strategy, ctx, ...args);
    } catch (err) {
      throw new RunAbort('E_RUNTIME', `${name} threw: ${err?.message ?? err}`);
    }
    monitor.record(Number(process.hrtime.bigint() - t0) / 1000);
    return out;
  };

  const emit = (out, ts) => {
    if (out == null) return;
    const list = Array.isArray(out) ? out : [out];
    for (const order of list) {
      if (order == null) continue;
      // `gtc` was advertised in the SDK reference and silently executed as a
      // single IOC attempt: if the book did not fill at that instant the order
      // vanished, even though the documented semantics say it rests until the
      // market closes. That is a wrong fill, slippage and PnL number for an
      // order type we told customers we supported.
      //
      // Refused rather than approximated, which is the same call the docs
      // already make about resting orders: "we would rather ship it late than
      // ship it flattering."
      const tif = order.tif ?? 'ioc';
      if (tif !== 'ioc') {
        throw new RunAbort('E_MANIFEST',
          `tif ${JSON.stringify(tif)} is not supported — only "ioc". Resting orders need a`
          + ' queue-position model, and guessing at one inflates returns by multiples.');
      }
      schedule(ts + fillDelayMs, 'order', order);
    }
  };

  // A fresh copy per call: whatever the strategy does to it reaches nothing.
  call('on_market_open', preSettleMarket());
  if (monitor.breached) {
    throw new RunAbort('E_BUDGET', `per-event budget exceeded: ${JSON.stringify(monitor.summary())}`);
  }

  // `events` is any ITERABLE, not necessarily an array.
  //
  // The harness passes a generator that pulls one line off stdin per step, so
  // the future is not in the process at all — which is what the docs claim and
  // what was previously only approximately true. Nothing below may index it,
  // take its length, or look ahead in it.

  // The market's close, resolved BEFORE the loop because the loop has to stop
  // there.
  //
  // The settlement feed is a per-DAY stream, and fetch-data hands every row of
  // it to every market that settles on that stream — so a market closing at
  // 10:00 was still being shown ticks from 14:00. A strategy could watch the
  // price that decides its own settlement, hours after its market had closed,
  // and log it. That is look-ahead in its purest form, and it survived the
  // pending-order cutoff because that fixed the ORDERS and not the EVENTS.
  // A market with no close time in the archive has no cutoff to apply; the
  // last event seen becomes the close, tracked as we go rather than peeked.
  const declaredClose = engineMarket.close_ts_ms ?? null;
  const closeTs = declaredClose ?? Number.POSITIVE_INFINITY;
  let seen = 0;
  let lastTs = 0;

  for (const ev of events) {
    seen += 1;
    lastTs = ev.ts_ms;
    // Nothing past the close reaches a hook, the book, or the history.
    if (ev.ts_ms > closeTs) break;
    // Everything scheduled strictly BEFORE this event resolves against the book
    // as it stood then — draining after applying the event would fill a delayed
    // order against depth that arrived after it.
    drainUntil(ev.ts_ms - 1);
    control.setNow(ev.ts_ms);

    if (ev.kind === 'book') {
      if (ev.snapshot) book.snapshot(ev.ts_ms, ev.levels);
      else book.delta(ev.ts_ms, ev.side, ev.ladder, ev.px, ev.size);
    }
    drainUntil(ev.ts_ms);

    if (ev.kind === 'tick') control.pushTick(ev);

    const hook = HOOK_FOR[ev.kind];
    if (hook && hooks[hook]) emit(call(hook, ev), ev.ts_ms);

    if (monitor.breached) {
      throw new RunAbort('E_BUDGET', `per-event budget exceeded: ${JSON.stringify(monitor.summary())}`);
    }
  }

  // Anything still queued lands AT THE CLOSE — not at its own future
  // timestamp. Draining to Infinity executed a delayed order stamped after the
  // market had already closed, producing trade rows with opened_ms later than
  // closed_ms and letting late fills trade against a book that no longer
  // existed. An order that had not landed by the close did not land.
  // With no declared close, the last event seen IS the close — tracked as the
  // stream went past, because there is no array to look back into.
  const settleTs = declaredClose ?? lastTs;
  control.setNow(settleTs);
  drainUntil(settleTs);
  // Whatever is still pending never filled. Dropped, not back-dated.
  pending.length = 0;

  call('on_settle', { ...engineMarket }, engineMarket.outcome);

  const settled = engineMarket.outcome ? pf.settle(marketId, engineMarket.outcome, settleTs) : [];

  return {
    marketId,
    asset: engineMarket.asset ?? null,
    // What the engine PULLED, not what the caller had. With a stream the
    // latter is unknowable without draining, and not draining is the point.
    events: seen,
    settled,
    logs: control.logs,
    logTruncated: control.logTruncated,
    crosschecks: control.crosschecks,
    budget: monitor.summary(),
  };
}
