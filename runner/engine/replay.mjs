// Event loop. Owns the clock, iteration and I/O; strategies receive events
// one at a time in event-time order. Rows are pulled from the caller's
// iterator as they are replayed. Decoded market-days can be replayed with
// different parameters.

import { Book } from './book.mjs';
import { Portfolio, contractValue } from './portfolio.mjs';
import { MakerBook, MAX_RESTING } from './maker.mjs';


// Keep in sync with LIMITS.logLineChars / logBytesPerRun and otreplay.py.
// Do not import api/: the sandbox image only contains runner/.
// replay-limits.test.mjs checks both copies against the contract.
const LOG_LINE_CHARS = 512;
const LOG_BYTES_PER_RUN = 2 * 1024 * 1024;

// Bound crosscheck output on the result line. Keep in sync with otreplay.py.
const MAX_CROSSCHECKS_PER_MARKET = 16;
const CROSSCHECK_CLAIMED_CHARS = 32;


/** Event kinds the loop understands, in the order they dispatch. */
export const EVENT_KINDS = Object.freeze(['tick', 'book', 'trade']);

/** Measure strategy-hook cost; sustained over-budget cost stops the shard. */
export class BudgetMonitor {
  constructor({ limitMicros = 400, sampleFloor = 2000 } = {}) {
    this.limitMicros = limitMicros;
    this.sampleFloor = sampleFloor;
    this.count = 0;
    this.breaches = 0;
    this.maxMicros = 0;
    this.totalMicros = 0;
    // Recent-event ring: a cheap prefix must not hide a sustained slow phase.
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
   * Judge sustained cost by the mean of the latest sampleFloor events.
   * Hook wall time includes scheduling and GC pauses; breach counts and
   * max_micros are diagnostics, not the verdict.
   * No per-hook cap: one 500ms hook among 2,000 at 8us averages 258us and
   * passes. The run deadline bounds total time and catches stalled hooks.
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
      // Window mean used for the verdict.
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

/** Context state stays in closures; control and clock remain owned by the loop. */
/** Read-only book view, rebuilt per call to reflect current state. */
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
    // Fresh pairs isolate the book from returned-array mutations.
    levels: (side, n = 10) => book.levels(side, n),
    bidLevels: (side, n = 10) => book.bidLevels(side, n),
    bid_levels: (side, n = 10) => book.bidLevels(side, n),
    mid: (side) => book.mid(side),
    // When each best level was last set, exchange time; null for an empty ladder.
    quoteTs: (side) => book.quoteTs(side),
    quote_ts: (side) => book.quoteTs(side),
  });
}

// The settlement window a TWAP-settled market's ctx.twap_locked() reads.
const TWAP_LOOKBACK_MS = Object.freeze({ twap30s: 30_000, twap60s: 60_000 });
// ctx.twap_locked().projected is null below this sample coverage, or when the
// latest spot value is older than this. Keep in sync with otreplay.py.
const SPOT_MIN_COVERAGE = 0.8;
const SPOT_MAX_AGE_MS = 5000;

function createCtx({ params, portfolio, marketId, market, logBudget, references, series, rng, resting = null, timers = null, stream = null, spotDeclared = false }) {
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

  // Record spot values at arrival and answer as of this context's clock.
  // Saved contexts cannot see later arrivals. Windows and deduplication use
  // feed timestamps; arrays follow arrival order.
  const lookbackMs = TWAP_LOOKBACK_MS[stream] ?? null;
  const closeTs = market?.close_ts_ms ?? null;
  const windowStart = lookbackMs != null && closeTs != null ? closeTs - lookbackMs : null;
  const spotTs = [];
  const spotVal = [];
  const spotArrived = [];
  let spotSeen = 0;
  // How many entries of a sorted array are at or before t.
  const upTo = (xs, t) => {
    let lo = 0;
    let hi = xs.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (xs[mid] <= t) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };

  // Refuse undeclared feeds rather than silently returning null.
  const needSpot = (what) => {
    if (!spotDeclared) throw new RunAbort('E_MANIFEST', `${what} needs the "spot" dataset declared in the manifest`);
  };
  const twapLocked = () => {
    needSpot('ctx.twap_locked()');
    if (windowStart == null || now < windowStart) return null;
    const k = upTo(spotArrived, now);
    // One sample per feed timestamp in [windowStart, close), the first to
    // arrive, summed in arrival order.
    let sum = 0;
    let n = 0;
    let prev = null;
    for (let i = upTo(spotTs, windowStart - 1); i < k; i += 1) {
      const ts = spotTs[i];
      if (ts >= closeTs || ts === prev) continue;
      sum += spotVal[i];
      n += 1;
      prev = ts;
    }
    if (n === 0) return null;
    const elapsed = Math.min(Math.max(now - windowStart, 0), lookbackMs);
    const value = sum / n;
    const fraction = elapsed / lookbackMs;
    const coverage = Math.min(1, n / Math.max(1, Math.floor(elapsed / 1000)));
    const lastTs = spotTs[k - 1];
    const lastVal = spotVal[k - 1];
    const fresh = now - lastTs <= SPOT_MAX_AGE_MS;
    return {
      value,
      samples: n,
      elapsed_ms: elapsed,
      elapsed_fraction: fraction,
      coverage,
      last_ts_ms: lastTs,
      projected: coverage >= SPOT_MIN_COVERAGE && fresh ? fraction * value + (1 - fraction) * lastVal : null,
    };
  };

  const ctx = {
    p: params,

    get now() { return now; },

    /** Book view at the current replay time. */
    book(id = null) {
      if (id && id !== marketId) {
        // Cross-market reads are what session mode is for. Returning another
        // market's book would silently break the sharding guarantee.
        throw new RunAbort('E_STATE',
          `ctx.book(${id}) from market ${marketId}: cross-market state needs mode "session"`);
      }
      return bookView(book);
    },

    /** The last n ticks already seen. */
    history(n = 1) {
      const k = Math.max(0, Math.min(Number(n) || 0, history.length));
      // Copy history so strategies cannot rewrite indicator inputs.
      return history.slice(history.length - k).map((t) => ({ ...t }));
    },

    position() {
      // Engine valuation uses the live book.
      return portfolio.position(marketId, book);
    },

    log(msg) {
      // Share the byte allowance across the run; cap each line's characters.
      if (logBudget.spent >= logBudget.bytes) { logTruncated = true; return; }
      const line = `${now} ${String(msg)}`.slice(0, logBudget.lineChars);
      // Count UTF-8 output bytes, not UTF-16 string length, for the run cap.
      logBudget.spent += Buffer.byteLength(line, 'utf8') + 1;
      logs.push(line);
    },

    /** Seeded generator, recorded in the report. */
    random(seed = null) { return rng(seed); },

    /** Copies of this market's non-final resting orders, without queue position. */
    orders() { return resting ? resting.orders() : []; },

    /**
     * Cancel a resting order by engine id (`o3`) or by its client_id. Takes
     * effect after the run's cancel latency; returns false when there is no
     * such order.
     */
    cancel(id) { return resting ? resting.cancel(id) : false; },

    /**
     * Wake on_timer at `at_ms`. Returns the timer's id ("t1", ...).
     * Needs the on_timer hook declared; at_ms later than now and not past the
     * market's declared close.
     */
    schedule(atMs, tag = null) {
      if (!timers) throw new RunAbort('E_MANIFEST', 'ctx.schedule needs the on_timer hook declared in the manifest');
      return timers.schedule(atMs, tag);
    },

    /** Cancel a pending timer by its id; false when there is none. */
    unschedule(id) { return timers ? timers.unschedule(id) : false; },

    /** Declared reference feed as of now, without future rows. */
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

    /**
     * The latest spot value that has reached the strategy, as
     * { value, ts_ms } (a copy), or null. Needs the `spot` dataset.
     */
    spot() {
      needSpot('ctx.spot()');
      const k = upTo(spotArrived, now);
      return k === 0 ? null : { value: spotVal[k - 1], ts_ms: spotTs[k - 1] };
    },

    /**
     * The part of the settlement TWAP window [close - lookback, close) already
     * elapsed, from the spot values seen in it, an approximation of what
     * Chainlink's average holds so far (it uses finer observations than this
     * per-second stream). null when the market does not settle on a TWAP, the
     * window has not started, or no spot value in it has arrived.
     *   value             mean of the window's spot samples seen so far
     *   samples           how many (one per feed timestamp)
     *   elapsed_ms        time since the window opened (capped at lookback)
     *   elapsed_fraction  elapsed_ms / lookback (time, not certainty)
     *   coverage          samples / elapsed seconds (capped at 1)
     *   last_ts_ms        feed time of the latest spot value seen
     *   projected         elapsed_fraction * value + (1 - elapsed_fraction) *
     *                     latest spot: the final average if the price stayed
     *                     where it is; null when coverage < 0.8 or the latest
     *                     spot is more than 5 s old
     */
    twap_locked() { return twapLocked(); },
    twapLocked() { return twapLocked(); },

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

    /** Record settlement comparisons; mismatches do not fail the run. */
    assert_outcome(_market, outcome) {
      // Official outcome and market id come from engine state, not the argument.
      const official = market?.outcome ?? null;
      // Bound strategy-supplied output before serialising the result line.
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
    get now() { return now; },
    setBook(b) { book = b; },
    // Copy ticks to protect indicator inputs and report prices.
    pushTick(ev) { history.push({ ...ev }); },
    pushSpot(ev, arrivedAt) {
      spotSeen += 1;
      spotTs.push(ev.ts_ms);
      spotVal.push(ev.value);
      spotArrived.push(arrivedAt);
    },
    get spotSeen() { return spotSeen; },
    logs,
    crosschecks,
    get logTruncated() { return logTruncated; },
  };

  return { ctx, control };
}

/** Deterministic PRNG. The seed is recorded in the report. */
export function makeRng(runSeed) {
  return (seed = null) => {
    // splitmix32; keep in sync with the Python harness.
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

/** Run log allowance in UTF-8 bytes, shared across markets. */
export function makeLogBudget({
  bytes = LOG_BYTES_PER_RUN,
  lineChars = LOG_LINE_CHARS,
} = {}) {
  return { bytes, lineChars, spent: 0 };
}

/**
 * Market state machine: open, step, close. Market mode drives one at a time;
 * session mode merges open markets into one timeline.
 * Keep in sync with MarketReplay in otreplay.py.
 */
export class MarketReplay {
  constructor({
    market, strategy, hooks,
    // The stream the market settles on (twap60s, ...): sets ctx.twap_locked()'s window.
    stream = null,
    // The run declared the spot dataset (job.spot): ctx.spot() / twap_locked() allowed.
    spotDeclared = false,
    portfolio = null,
    fillDelayMs = 0,
    /** Run log allowance shared across markets, created once by the harness. */
    logBudget = null,
    budget = null,
    references = null,
    series = null,
    seed = 1,
    feeBps = 0,
    /**
     * Resting-order policy for the run: `{ allowed, refusal, cancelLatencyMs }`,
     * decided once from the venue and the declared datasets (restingPolicyFor).
     * Absent or not allowed, a gtc order aborts the run with `refusal`.
     */
    resting = null,
    /**
     * Generic markets only: the decoder's terminal mark for an unresolved
     * market (`{UP, DOWN, source, ts_ms, age_ms}` or `{none}`). Kept here and
     * never on the market record a hook is handed; it is a future fact.
     */
    terminal = null,
    /** Run execution options (job.engine); null disables them. */
    engine = null,
    /**
     * Shared session clock {t}, advanced by the harness. Saved contexts retain
     * their own now but cannot schedule into the run's past.
     */
    clock = null,
    /**
     * Shared recorder budget {rows, limit, truncated}. Count samples as made;
     * exhaustion stops recording in all markets.
     */
    recordBudget = null,
  }) {
    this.marketId = market.market_id;
    // Generic-data branches; archive records have no kind.
    this.generic = market.kind === 'generic';
    this.terminal = this.generic ? terminal : null;
    this.pf = portfolio ?? new Portfolio({ feeBps, engine });
    this.pf.setMarketFee(this.marketId, market.fee ?? null);
    if (this.generic) this.pf.setMarketLabels(this.marketId, market.labels);
    this.engine = engine;
    if (engine?.order_rules) this.pf.setMarketRules(this.marketId, marketRules(engine.order_rules, market));
    if (engine?.mirror_depth === 'shared'
        && (engine.mirror_markets === 'all' || market.book_model === 'single_mirrored')) {
      this.pf.setMirrored(this.marketId);
    }
    this.book = new Book(this.marketId);
    this.monitor = budget ?? new BudgetMonitor();
    this.strategy = strategy;
    this.hooks = hooks;
    this.fillDelayMs = fillDelayMs;
    // Keep settlement metadata separate from the copy passed to hooks.
    this.market = { ...market };
    const timerApi = engine?.scheduler === 'global' && engine.timers === true ? {
      schedule: (at, tag) => this.#scheduleTimer(at, tag),
      unschedule: (id) => this.#unscheduleTimer(id),
    } : null;
    const { ctx, control } = createCtx({
      timers: timerApi,
      stream,
      spotDeclared,
      params: strategy.p ?? {},
      portfolio: this.pf,
      marketId: this.marketId,
      market: this.market,
      logBudget: logBudget ?? makeLogBudget(),
      references,
      series,
      rng: makeRng(seed),
      resting: {
        orders: () => (this.maker ? this.maker.views() : []),
        cancel: (id) => this.#requestCancel(id),
      },
    });
    this.ctx = ctx;
    this.control = control;
    control.setBook(this.book);
    // Global scheduler: shared timeline, timers and a lagged local book.
    this.global = engine?.scheduler === 'global';
    this.jobSeq = 0;
    if (this.global) {
      this.feedLatency = Number.isInteger(engine.feed_latency) && engine.feed_latency > 0 ? engine.feed_latency : 0;
      this.localBook = this.feedLatency > 0 ? new Book(this.marketId) : this.book;
      control.setBook(this.localBook);
      this.timerStats = { created: 0, fired: 0, dropped: 0 };
      this.timerIds = 0;
      this.clock = clock ?? { t: -Infinity };
    }

    this.resting = resting;
    this.cancelLatencyMs = Number.isFinite(resting?.cancelLatencyMs) ? resting.cancelLatencyMs : fillDelayMs;
    this.maker = resting?.allowed
      ? new MakerBook({ marketId: this.marketId, portfolio: this.pf, queueProb: engine?.queue_prob ?? null })
      : null;

    // Orders decided at T but matched at T + fillDelayMs, and hold_s expiries.
    /** @type {Array<{at:number, kind:'order'|'flatten', payload:any}>} */
    this.pending = [];

    // Resolve close before replay to cut off per-day feeds. Without a
    // declared close, use the last event seen, without reading ahead.
    this.declaredClose = this.market.close_ts_ms ?? null;
    this.closeTs = this.declaredClose ?? Number.POSITIVE_INFINITY;
    if (this.generic) {
      // Trading ends at trade_until; resolved markets pay at declaredClose,
      // which can be later. The decoder excludes events after trading ends.
      this.tradeUntil = this.market.trade_until_ts_ms;
      this.closeTs = this.tradeUntil;
      this.tradingEnded = false;
      this.closed = null;
    }
    this.seen = 0;
    this.lastTs = 0;
    this.ended = false;

    // record_ms: before a change at t, write unwritten grid points g < t.
    // Each reflects state through g. Write a final sample after the last
    // change; read only the ledger and exchange book.
    this.recordMs = Number.isInteger(engine?.record_ms) && engine.record_ms > 0 ? engine.record_ms : null;
    this.recordRows = this.recordMs ? [] : null;
    this.recordBudget = this.recordMs ? (recordBudget ?? { rows: 0, limit: Infinity, truncated: false }) : null;
    this.recNext = null;
    if (this.recordMs && typeof this.market.open_ts_ms === 'number' && Number.isFinite(this.market.open_ts_ms)) {
      this.#recordStart(this.market.open_ts_ms);
    }
  }

  /** First grid point at or after `ts`. */
  #recordStart(ts) {
    if (this.recNext == null) this.recNext = Math.ceil(ts / this.recordMs) * this.recordMs;
  }

  #recordSample(g, final) {
    const b = this.recordBudget;
    if (b.truncated) return false;
    if (b.rows + 1 > b.limit) {
      b.truncated = true;
      return false;
    }
    b.rows += 1;
    this.recordRows.push({
      ts: g,
      cash: this.pf.marketCash.get(this.marketId) ?? 0,
      marked: this.pf.marketMarked.get(this.marketId) ?? 0,
      position_value: this.pf.liquidationValue(this.marketId, this.book),
      final,
    });
    return true;
  }

  /** Before a change at `t`: every grid point g < t not yet written. */
  #recordBefore(t) {
    if (!this.recordMs || this.recNext == null) return;
    while (this.recNext < t) {
      // Budget spent: the rest of the grid is skipped, not walked.
      if (!this.#recordSample(this.recNext, false)) { this.recNext = Number.POSITIVE_INFINITY; return; }
      this.recNext += this.recordMs;
    }
  }

  /** After the last change, at `ts`: the final sample (a grid point when one falls there). */
  #recordFinal(ts) {
    if (!this.recordMs) return;
    this.#recordStart(ts);
    this.#recordBefore(ts);
    if (this.recordBudget.truncated) return;
    this.#recordSample(ts, true);
    if (this.recNext === ts) this.recNext += this.recordMs;
  }

  /** Pre-settlement views exclude outcome; on_settle receives it. */
  #preSettleMarket() {
    if (this.generic) return genericView(this.market);
    const { outcome, ...rest } = this.market;
    return rest;
  }

  #schedule(at, kind, payload) {
    const pending = this.pending;
    let i = pending.length;
    if (this.global) {
      // Saved contexts cannot schedule cancels before the run clock.
      if (at < this.clock.t) at = this.clock.t;
      // (at, rank, seq): exchange jobs before arrivals before timers at one ms;
      // insertion order within a rank.
      const rank = JOB_RANK[kind] ?? 0;
      while (i > 0 && (pending[i - 1].at > at || (pending[i - 1].at === at && pending[i - 1].rank > rank))) i -= 1;
      pending.splice(i, 0, { at, kind, payload, rank, seq: this.jobSeq++ });
      return;
    }
    while (i > 0 && pending[i - 1].at > at) i -= 1;
    pending.splice(i, 0, { at, kind, payload });
  }

  /** The earliest pending job as (at, rank, seq), or null. Global mode. */
  nextDue() {
    const j = this.pending[0];
    return j ? { at: j.at, rank: j.rank, seq: j.seq } : null;
  }

  /**
   * Run exactly the earliest pending job (global mode). ctx.now is the job's
   * own time before anything the strategy can observe happens.
   */
  runOne() {
    const job = this.pending.shift();
    if (!job) return;
    // Past the market's last tradable instant nothing runs: an order that had
    // not landed did not land, a late event is never heard, a timer is dropped.
    if (job.at > this.closeTs) {
      if (job.kind === 'timer') this.timerStats.dropped += 1;
      return;
    }
    // #schedule never files a job before the clock, so this is an invariant,
    // checked: running one would move ctx.now backwards.
    if (job.at < this.clock.t) {
      throw new RunAbort('E_RUNTIME', `engine invariant: a ${job.kind} at ${job.at} after the run reached ${this.clock.t}`);
    }
    // Spot arrivals only update spot history, without moving ctx.now or recording.
    if (job.kind === 'arrival' && job.payload.kind === 'spot') {
      this.control.pushSpot(job.payload, job.at);
      return;
    }
    this.#recordBefore(job.at);
    this.control.setNow(job.at);
    if (job.kind === 'timer') {
      this.timerStats.fired += 1;
      if (this.timerStats.fired > MAX_TIMERS_FIRED) {
        throw new RunAbort('E_RUNTIME', `more than ${MAX_TIMERS_FIRED} timers fired in market ${this.marketId}`);
      }
      const t = job.payload;
      if (this.hooks.on_timer) this.#emit(this.#call('on_timer', { id: t.id, at_ms: job.at, tag: t.tag }), job.at);
      this.#checkBudget();
      return;
    }
    if (job.kind === 'arrival') {
      this.#arrive(job.payload);
      return;
    }
    this.#runExchangeJob(job);
  }

  #scheduleTimer(atMs, tag) {
    // After the later of this market's now and the run's: a ctx kept from
    // another market must not reach back into time already processed.
    const now = Math.max(this.control.now, this.clock.t);
    if (!(typeof atMs === 'number' && Number.isSafeInteger(atMs)) || atMs <= now) {
      throw new RunAbort('E_RUNTIME', `ctx.schedule needs a whole-millisecond time after now (${now}), got ${JSON.stringify(atMs)}`);
    }
    // Only what the strategy can see bounds it: a declared close. A private
    // end of trading (generic data) silently drops later timers instead.
    const visibleClose = this.generic ? (this.market.trading_end_ts_ms ?? null) : (this.market.close_ts_ms ?? null);
    if (visibleClose != null && atMs > visibleClose) {
      throw new RunAbort('E_RUNTIME', `ctx.schedule(${atMs}) is after the market's close (${visibleClose})`);
    }
    if (tag != null && !(typeof tag === 'string' && tag.length <= 64)) {
      throw new RunAbort('E_RUNTIME', 'a timer tag must be a string of at most 64 characters');
    }
    if (this.pending.filter((j) => j.kind === 'timer').length >= MAX_PENDING_TIMERS) {
      throw new RunAbort('E_RUNTIME', `more than ${MAX_PENDING_TIMERS} pending timers in market ${this.marketId}`);
    }
    this.timerStats.created += 1;
    if (this.timerStats.created > MAX_TIMERS_CREATED) {
      throw new RunAbort('E_RUNTIME', `more than ${MAX_TIMERS_CREATED} timers scheduled in market ${this.marketId}`);
    }
    this.timerIds += 1;
    const id = `t${this.timerIds}`;
    this.#schedule(atMs, 'timer', { id, tag: tag == null ? null : String(tag) });
    return id;
  }

  #unscheduleTimer(id) {
    const i = this.pending.findIndex((j) => j.kind === 'timer' && j.payload.id === id);
    if (i < 0) return false;
    this.pending.splice(i, 1);
    return true;
  }

  /** A lagged event reaches the strategy: the local book, the history, the hook. */
  #arrive(ev) {
    if (ev.kind === 'spot') { this.control.pushSpot(ev, this.control.now); return; }
    if (ev.kind === 'book') applyEvent(this.localBook, ev, this.generic);
    if (ev.kind === 'tick') this.control.pushTick(ev);
    const hook = ev.bbo ? null : HOOK_FOR[ev.kind];
    if (hook && this.hooks[hook]) this.#emit(this.#call(hook, ev), this.control.now);
    this.#checkBudget();
  }

  /** Execute everything scheduled at or before `ts`, against this book. */
  drainUntil(ts) {
    const pending = this.pending;
    while (pending.length && pending[0].at <= ts) {
      const job = pending.shift();
      if (this.global && job.kind !== 'order' && job.kind !== 'activate' && job.kind !== 'cancel' && job.kind !== 'flatten') {
        // Global mode drains only through the scheduler (runOne); a timer or
        // arrival reached here is past the end of trading: dropped.
        if (job.kind === 'timer') this.timerStats.dropped += 1;
        continue;
      }
      this.#recordBefore(job.at);
      this.#runExchangeJob(job);
    }
  }

  #runExchangeJob(job) {
    if (job.kind === 'order') {
        const res = this.pf.execute({ book: this.book, order: job.payload, ts: job.at, marketId: this.marketId, how: 'exit' });
        // hold_s is measured from the fill, not the decision: a fill that
        // landed late has not been held as long.
        if (res?.filled > 0 && job.payload.hold_s > 0 && !job.payload.reduce_only) {
          this.#schedule(job.at + job.payload.hold_s * 1000, 'flatten', { side: job.payload.side });
        }
      } else if (job.kind === 'activate') {
        this.maker.activate(job.payload, job.at, this.book);
      } else if (job.kind === 'cancel') {
        this.maker.cancel(job.payload, job.at);
    } else {
      this.pf.flatten(this.marketId, this.book, job.at, 'hold_expired');
    }
  }

  #requestCancel(id) {
    if (!this.maker) return false;
    // Bind cancellation to its order before client_id can be reused.
    const rec = this.maker.find(id);
    // Apply full cancel latency from the run clock, including saved contexts.
    const asked = this.global ? Math.max(this.control.now, this.clock.t) : this.control.now;
    if (!rec) { this.maker.cancel(null, asked); return false; }
    this.#schedule(asked + this.cancelLatencyMs, 'cancel', rec);
    return true;
  }

  #call(name, ...args) {
    const fn = this.hooks[name] && this.strategy[this.hooks[name]];
    if (typeof fn !== 'function') return undefined;
    const t0 = process.hrtime.bigint();
    let out;
    try {
      out = fn.call(this.strategy, this.ctx, ...args);
    } catch (err) {
      // Preserve engine refusal codes; strategy exceptions become E_RUNTIME.
      // Keep in sync with _call in otreplay.py.
      if (err instanceof RunAbort) throw err;
      throw new RunAbort('E_RUNTIME', `${name} threw: ${err?.message ?? err}`);
    }
    this.monitor.record(Number(process.hrtime.bigint() - t0) / 1000);
    return out;
  }

  #emit(out, ts) {
    if (out == null) return;
    const list = Array.isArray(out) ? out : [out];
    for (const raw of list) {
      if (raw == null) continue;
      // Copy orders at decision time so in-flight contents cannot change.
      const order = typeof raw === 'object' ? { ...raw } : raw;
      // Abort for a named side outside this market.
      if (typeof order?.side === 'string' && this.pf.sideOf(order.side, this.marketId) == null) {
        const labels = this.pf.marketLabels.get(this.marketId);
        throw new RunAbort('E_RUNTIME', `order side ${JSON.stringify(order.side)} is not "UP" or "DOWN"${
          labels ? ` or an outcome of this market (${labels.map((l) => JSON.stringify(l)).join(', ')})` : ''}`);
      }
      const tif = order.tif ?? 'ioc';
      if (tif === 'fok') {
        if (!this.engine?.fok) {
          throw new RunAbort('E_MANIFEST', 'tif "fok" needs "fok": true in the manifest');
        }
        if (order.post_only === true || order.client_id != null) {
          throw new RunAbort('E_MANIFEST', 'post_only and client_id are for gtc orders, not fok');
        }
        this.#schedule(ts + this.fillDelayMs, 'order', order);
        continue;
      }
      if (tif === 'gtc') {
        this.#submitResting(order, ts);
        continue;
      }
      if (tif !== 'ioc') {
        throw new RunAbort('E_MANIFEST', `tif ${JSON.stringify(tif)} is not supported — "ioc" or "gtc".`);
      }
      this.#schedule(ts + this.fillDelayMs, 'order', order);
    }
  }

  #submitResting(order, ts) {
    if (!this.maker) {
      throw new RunAbort('E_MANIFEST', this.resting?.refusal
        ?? 'resting (gtc) orders are not available for this run');
    }
    // hold_s needs a single fill time; resting orders can fill in pieces.
    if (order.hold_s != null) {
      throw new RunAbort('E_MANIFEST', 'hold_s is not supported on gtc orders; exit with a reduce_only order');
    }
    if (this.maker.openCount() >= MAX_RESTING) {
      throw new RunAbort('E_RUNTIME', `more than ${MAX_RESTING} open resting orders in market ${this.marketId}`);
    }
    const rec = this.maker.submit(order, ts);
    if (rec) this.#schedule(ts + this.fillDelayMs, 'activate', rec);
  }

  #checkBudget() {
    if (this.monitor.breached) {
      throw new RunAbort('E_BUDGET', `per-event budget exceeded: ${JSON.stringify(this.monitor.summary())}`);
    }
  }

  open(openTs = null) {
    // Start at market open so global jobs cannot precede it.
    if (this.global && typeof openTs === 'number' && Number.isFinite(openTs)) this.control.setNow(openTs);
    // A fresh copy per call: whatever the strategy does to it reaches nothing.
    this.#call('on_market_open', this.#preSettleMarket());
    this.#checkBudget();
  }

  /**
   * Apply one event. False once the market is past its close: nothing past the
   * close reaches a hook, the book, or the history.
   */
  step(ev) {
    if (this.ended) return false;
    // Spot events update only spot/TWAP helpers: no hooks, book changes,
    // recorder, maker work or budget samples. Feed latency still applies.
    if (ev.kind === 'spot') {
      if (ev.ts_ms > this.closeTs) return false;
      if (this.global && this.feedLatency > 0) this.#schedule(ev.ts_ms + this.feedLatency, 'arrival', ev);
      else this.control.pushSpot(ev, ev.ts_ms);
      return true;
    }
    this.seen += 1;
    this.lastTs = ev.ts_ms;
    if (ev.ts_ms > this.closeTs) { this.ended = true; return false; }
    if (this.recordMs) this.#recordStart(ev.ts_ms);
    // Drain earlier jobs against the earlier book before applying this event.
    // In global mode, the harness already drained jobs across all markets.
    if (!this.global) this.drainUntil(ev.ts_ms - 1);
    this.#recordBefore(ev.ts_ms);
    this.control.setNow(ev.ts_ms);
    const maker = this.maker;
    if (maker) {
      maker.finalize(ev.ts_ms);
      maker.resolveMarkouts(ev.ts_ms, this.book);
    }

    if (ev.kind === 'book') {
      // Test bounds first: they carry snapshot:false but are not deltas.
      const apply = () => applyEvent(this.book, ev, this.generic);
      if (maker) maker.bookEvent(ev, this.book, apply);
      else apply();
    } else if (ev.kind === 'trade' && maker) {
      // Resting orders see the print before any hook does, and an order a hook
      // returns now cannot consume it (see PRINT_LAG_MS).
      maker.trade(ev, this.book);
    }
    if (!this.global) this.drainUntil(ev.ts_ms);

    // A feed latency: the strategy hears of this event later, from its own
    // (local) book; the exchange book above has already moved.
    if (this.global && this.feedLatency > 0) {
      this.#schedule(ev.ts_ms + this.feedLatency, 'arrival', ev);
      return true;
    }

    if (ev.kind === 'tick') this.control.pushTick(ev);

    // BBO bounds refine the book without on_book: they lack depth fields and
    // the unthrottled stream would multiply hook calls. The next regular event
    // sees the pruned book. Bounds only remove liquidity.
    // Keep in sync with otreplay.py.
    const hook = ev.bbo ? null : HOOK_FOR[ev.kind];
    if (hook && this.hooks[hook]) this.#emit(this.#call(hook, ev), ev.ts_ms);
    this.#checkBudget();
    return true;
  }

  /**
   * Generic markets: trading ends. Everything scheduled up to trade_until
   * executes, resting orders expire and their short markouts resolve against
   * the book as it stood, the rest is dropped; and an unresolved market's
   * open legs are valued at the decoder's mark. Idempotent: session mode calls
   * it at trade_until and close() calls it again.
   * Keep in sync with end_trading in otreplay.py.
   */
  endTrading() {
    if (!this.generic || this.tradingEnded) return;
    this.tradingEnded = true;
    this.ended = true;
    const ts = this.tradeUntil;
    this.control.setNow(ts);
    this.drainUntil(ts);
    if (this.maker) this.maker.close(ts, this.book);
    this.#dropPending();
    this.#recordBefore(ts);
    this.marked = this.market.outcome ? [] : this.pf.mark(this.marketId, this.terminal, ts);
  }

  #dropPending() {
    if (this.global) this.timerStats.dropped += this.pending.filter((j) => j.kind === 'timer').length;
    this.pending.length = 0;
  }

  /** Generic markets: end trading if not yet, then pay out (resolved) or finish (marked). */
  #closeGeneric() {
    if (this.closed) return this.closed;
    this.endTrading();
    const outcome = this.market.outcome;
    const settleTs = this.declaredClose;
    this.control.setNow(settleTs);
    let settled = this.marked;
    if (this.closeNow != null && this.closeNow > settleTs) this.control.setNow(this.closeNow);
    if (outcome) {
      // A venue settlement: on_settle is for that and only that.
      this.#call('on_settle', { ...genericView(this.market), outcome, resolved_ts_ms: this.market.resolved_ts_ms }, outcome);
      this.#recordBefore(settleTs);
      settled = this.pf.settle(this.marketId, outcome, settleTs);
    }
    this.#recordFinal(settleTs);
    if (this.maker) this.maker.releaseRows(outcome ? (side) => contractValue(side, outcome) : null);
    this.closed = {
      marketId: this.marketId,
      asset: null,
      events: this.seen,
      spot_seen: this.control.spotSeen,
      settled,
      logs: this.control.logs,
      logTruncated: this.control.logTruncated,
      crosschecks: this.control.crosschecks,
      budget: this.monitor.summary(),
      maker: this.maker ? this.maker.stats : null,
      timers: this.global ? this.timerStats : null,
      ...(this.recordMs ? { record: this.recordRows } : {}),
    };
    return this.closed;
  }

  /**
   * `nowTs` (global mode, session): the time line's own position when the close
   * is processed; on_settle never sees the clock go back, while the payout is
   * still booked at the declared close.
   */
  close(nowTs = null) {
    this.closeNow = this.global && typeof nowTs === 'number' && Number.isFinite(nowTs) ? nowTs : null;
    if (this.generic) return this.#closeGeneric();
    // Drain through close, then drop future jobs. Without a declared close,
    // use the last event seen while consuming the stream.
    const settleTs = this.declaredClose ?? this.lastTs;
    this.control.setNow(settleTs);
    this.drainUntil(settleTs);
    // Resting orders end here, pending ones included, before anything settles:
    // nothing fills after the close.
    if (this.maker) this.maker.close(settleTs, this.book);
    // Whatever is still pending never filled. Dropped, not back-dated.
    this.#dropPending();

    if (this.closeNow != null && this.closeNow > settleTs) this.control.setNow(this.closeNow);
    this.#call('on_settle', { ...this.market }, this.market.outcome);

    const outcome = this.market.outcome;
    this.#recordBefore(settleTs);
    const settled = outcome ? this.pf.settle(this.marketId, outcome, settleTs) : [];
    this.#recordFinal(settleTs);
    if (this.maker) this.maker.releaseRows(outcome ? (side) => contractValue(side, outcome) : null);

    return {
      marketId: this.marketId,
      asset: this.market.asset ?? null,
      // Count consumed events without draining the remaining stream.
      events: this.seen,
      spot_seen: this.control.spotSeen,
      settled,
      logs: this.control.logs,
      logTruncated: this.control.logTruncated,
      crosschecks: this.control.crosschecks,
      budget: this.monitor.summary(),
      maker: this.maker ? this.maker.stats : null,
      timers: this.global ? this.timerStats : null,
      ...(this.recordMs ? { record: this.recordRows } : {}),
    };
  }
}

/** Same-millisecond order of a market's jobs in global mode. Keep in sync with otreplay.py. */
const JOB_RANK = Object.freeze({ order: 0, activate: 0, cancel: 0, flatten: 0, arrival: 1, timer: 2 });
export const MAX_PENDING_TIMERS = 64;
export const MAX_TIMERS_CREATED = 10_000;
export const MAX_TIMERS_FIRED = 100_000;

/** One book event against a book, with the generic-data rules where they differ. */
function applyEvent(book, ev, generic) {
  if (ev.bbo) book.bbo(ev.ts_ms, ev.side, ev.bid, ev.ask, generic ? { inclusive: true } : undefined);
  else if (ev.snapshot) book.snapshot(ev.ts_ms, ev.levels);
  else if (generic && ev.mirror === true) book.deltaMirrored(ev.ts_ms, ev.side, ev.ladder, ev.px, ev.size);
  else book.delta(ev.ts_ms, ev.side, ev.ladder, ev.px, ev.size);
}

/**
 * Market rules {tickTicks, minSize}: assumed constants or venue metadata.
 * Validate metadata here too. Keep in sync with market_rules in otreplay.py.
 */
function marketRules(rules, market) {
  const tick = rules.mode === 'venue' ? market.tick_size : rules.tick;
  const minSize = rules.mode === 'venue' ? market.min_size : rules.min_size;
  const tickTicks = typeof tick === 'number' ? Math.round(tick * 10_000) : Number.NaN;
  if (!(tick > 0) || !(tickTicks >= 1) || Math.abs(tickTicks - tick * 10_000) > 1e-6
      || !(typeof minSize === 'number' && Number.isFinite(minSize) && minSize > 0)) {
    throw new RunAbort('E_RUNTIME', `market ${market.market_id}: order_rules need a tick on a 0.0001 grid and a positive minimum size`);
  }
  return { tickTicks, minSize };
}

/**
 * Deep-copy a whitelist for generic pre-settlement views. Exclude outcome,
 * resolution time/source and trading ends derived from resolution.
 * Keep in sync with generic_view in otreplay.py.
 */
const GENERIC_VIEW = [
  'market_id', 'kind', 'venue', 'question', 'slug', 'token_ids', 'labels', 'fee',
  'tick_size', 'min_size', 'trading_end_ts_ms', 'open_ts_ms',
];

export function genericView(market) {
  const out = {};
  for (const k of GENERIC_VIEW) {
    const v = market[k];
    out[k] = v == null ? null : (typeof v === 'object' ? JSON.parse(JSON.stringify(v)) : v);
  }
  // The name archive strategies read. Only a declared trading end; never one
  // derived from the resolution, which would date the outcome.
  out.close_ts_ms = market.trading_end_ts_ms ?? null;
  return out;
}

/**
 * Replay from any iterable. The harness pulls stdin one line at a time;
 * do not index, measure length or read ahead in events.
 */
export function replayMarket(args) {
  const r = new MarketReplay(args);
  r.open();
  for (const ev of args.events) {
    if (!r.step(ev)) break;
  }
  return r.close();
}
