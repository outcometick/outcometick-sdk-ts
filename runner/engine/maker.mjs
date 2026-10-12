// Conservative resting-order queue model. Aggregated levels and transaction
// prints do not reveal individual maker orders, so fills are estimates.
//
// The public sample and per-match venue API show mirrored liquidity: UP bids
// at q and DOWN asks at 1 - q share one canonical UP queue. Prints appear once
// on the taker's token, with total transaction size and one maker price; that
// price may be the best or worst of a sweep. Complementary-token prints also
// consume the canonical queue.
//
// A print spends one size budget, best price first: depletion ledger, external
// queue ahead, own order, remaining level. It reaches only prices at least as
// good as the printed price. Book removals stay in the ledger for PRINT_LAG_MS
// to prevent late prints from consuming them twice.
// New orders ignore prints within PRINT_LAG_MS of activation. Cancelled orders
// remain exposed for that period after cancellation, a stress assumption for
// late prints. Book updates shorten queue estimates to visible size but never
// fill orders; crossing books are diagnostics. Fills use the order's limit.
// No market impact: own orders do not consume visible depth.
//
// Keep in sync with otmaker.py, including floating-point operation order.
// runner/conformance checks matching rows.

import { PRICE_SCALE, toTicks, fromTicks } from './book.mjs';

/** Written into every report that has resting orders. Bump on any rule change. */
export const QUEUE_MODEL = 'polymarket-queue-v1';

/**
 * Optional probabilistic cancellation model (queue_model; engine.queue_prob
 * = {prob, n}), based on hftbacktest's ProbQueueModel. Null uses the default.
 * At archive level, ledger holds book removals unexplained by prints; unseen
 * holds print removals not yet reflected in the book. shadow = visible - unseen.
 * Prints consume ledger and add unseen. Book decreases absorb unseen before
 * ledgering the unexplained remainder as cancellations.
 * At order level, the waterfall advances ahead; unexplained decreases apply
 * est = front - (1 - p) * chg + min(0, back - p * chg).
 * Both records expire after PRINT_LAG_MS, a heuristic reconciliation window.
 * Keep in sync with otmaker.py, including the fixed + - * / operation order.
 */
export const QUEUE_PROB_VERSION = 'prob-v1';
export const QUEUE_PROBS = Object.freeze(['power', 'power2', 'power3', 'log', 'log2']);

/** The report's model name for a run's queue_prob (null = the default). */
export function queueModelName(queueProb) {
  return queueProb ? `${QUEUE_MODEL}+${QUEUE_PROB_VERSION}` : QUEUE_MODEL;
}

const PROB_INPUT_MAX = 1e15;
const LN2 = 0.6931471805599453;
const SMALL_X = 2 ** -20;

/** r^n, n a whole number >= 1, multiplied left to right. */
function powN(r, n) {
  let x = r;
  for (let i = 1; i < n; i += 1) x = x * r;
  return x;
}

/** ln(1 + x) for finite x >= 0, by + - * / alone (no library log). */
export function ln1p(x) {
  if (x === 0) return 0;
  if (x < SMALL_X) return x - x * x / 2;
  let y = 1 + x;
  let k = 0;
  while (y >= 2) { y = y / 2; k += 1; }
  const s = (y - 1) / (y + 1);
  const t = s * s;
  let h = 1 / 39;
  for (let j = 37; j >= 1; j -= 2) h = h * t + 1 / j;
  return 2 * s * h + k * LN2;
}

/**
 * Cancellation share behind an order with a ahead and b behind, in [0, 1].
 * Invalid inputs return null and skip the probabilistic update.
 * Keep in sync with queue_prob in otmaker.py.
 */
export function queueProb(model, a, b) {
  if (!(Number.isFinite(a) && Number.isFinite(b)) || !(a > 0) || !(b >= 0)
      || a > PROB_INPUT_MAX || b > PROB_INPUT_MAX) return null;
  const n = model.n;
  let p;
  if (model.prob === 'power') {
    if (a <= b) p = 1 / (1 + powN(a / b, n));
    else { const u = powN(b / a, n); p = u / (u + 1); }
  } else if (model.prob === 'power2') {
    p = powN(b / (a + b), n);
  } else if (model.prob === 'power3') {
    p = 1 - powN(a / (a + b), n);
  } else if (model.prob === 'log') {
    const lb = ln1p(b);
    p = lb / (lb + ln1p(a));
  } else if (model.prob === 'log2') {
    p = ln1p(b) / ln1p(a + b);
  } else {
    return null;
  }
  return p < 0 ? 0 : (p > 1 ? 1 : p);
}

/**
 * Print-lag window for entry exclusion, cancel exposure and ledger expiry.
 * Public BTC-5m sample (2026-09-08) pre-print BBO absence p99.9: 702ms for
 * buys, 639ms for sells. Round the maximum up to 100ms. This one-series
 * heuristic is not a bound; include it in the report.
 */
export const PRINT_LAG_MS = 800;

/** Non-final resting orders (pending + live + cancel pending) per market. */
export const MAX_RESTING = 50;

/** Polymarket's finest tick, in PRICE_SCALE ticks (0.001). */
export const TICK_GRID = 10;

/** ASCII client ids keep JS UTF-16 and Python code-point length limits equivalent. */
const CLIENT_ID = /^[A-Za-z0-9_.:-]{1,64}$/;

/** Engine ids look like this; a client_id may not, so a cancel is never ambiguous. */
const ENGINE_ID = /^o[0-9]+$/;

/** Markout horizons, in ms after the fill. */
export const MARKOUT_HORIZONS = Object.freeze([
  Object.freeze({ key: 'markout_1s', ms: 1_000 }),
  Object.freeze({ key: 'markout_10s', ms: 10_000 }),
  Object.freeze({ key: 'markout_60s', ms: 60_000 }),
]);

/** Maximum mid-price age at a markout horizon. */
export const MARKOUT_MAX_AGE_MS = 5_000;

const EPS = 1e-9;

/**
 * Hold maker rows until their market closes so session-mode drains from other
 * markets cannot export them before markouts are final.
 */
const PENDING_ROWS = new WeakSet();
export const rowPending = (row) => PENDING_ROWS.has(row);

const FINAL = new Set([
  'filled', 'cancelled', 'expired', 'cancelled_no_position',
  'rejected', 'rejected_post_only', 'rejected_self_cross',
]);

/** Counters for the report's maker block. Keep in sync with new_maker_stats in otmaker.py. */
export function newMakerStats() {
  return {
    submitted: 0,
    rested: 0,
    rested_size: 0,
    taker_on_arrival_size: 0,
    maker_filled_size: 0,
    maker_fills: 0,
    orders_with_maker_fill: 0,
    fully_filled: 0,
    cancelled: 0,
    cancelled_before_entry: 0,
    cancelled_no_position: 0,
    expired: 0,
    rejected_invalid: 0,
    rejected_post_only: 0,
    rejected_self_cross: 0,
    rejected_duplicate_id: 0,
    cancel_noop: 0,
    lag_suppressed_size: 0,
    crossed_observations: 0,
  };
}

/** Sum one market's counters into a run total. */
export function addMakerStats(total, part) {
  for (const k of Object.keys(total)) total[k] += part?.[k] ?? 0;
  return total;
}

/**
 * Map orders to the canonical UP queue: UP buys/sells are bids/asks at q;
 * DOWN buys/sells are asks/bids at 1 - q.
 */
export function canonicalOf(side, reduce, ticks) {
  if (side === 'UP') return { kind: reduce ? 'asks' : 'bids', q: ticks };
  return { kind: reduce ? 'bids' : 'asks', q: PRICE_SCALE - ticks };
}

/** True when price `a` is strictly better than `b` on that canonical side. */
const better = (kind, a, b) => (kind === 'asks' ? a < b : a > b);

/** A canonical print: which side it consumes and at what price. */
export function canonicalPrint(ev) {
  const t = toTicks(ev.px);
  const up = ev.side === 'UP';
  const taker = up ? ev.taker : (ev.taker === 'BUY' ? 'SELL' : 'BUY');
  return { kind: taker === 'BUY' ? 'asks' : 'bids', p: up ? t : PRICE_SCALE - t };
}

/** Is canonical price `q` reached by a print at `p` consuming `kind`? */
const reached = (kind, q, p) => (kind === 'asks' ? q <= p : q >= p);

export class MakerBook {
  /**
   * @param {object} o
   * @param {string} o.marketId
   * @param {object} o.portfolio   the market's Portfolio (normalize / executeEffective / makerFill)
   * @param {number} [o.printLagMs]
   */
  constructor({ marketId, portfolio, printLagMs = PRINT_LAG_MS, queueProb = null }) {
    this.marketId = marketId;
    this.pf = portfolio;
    this.lag = printLagMs;
    /** job.engine.queue_prob; null selects the conservative model. */
    this.prob = queueProb;
    /** Prob mode: print-removed volume the book has not shown yet, per side. */
    this.unseen = { asks: [], bids: [] };
    /** Every order ever submitted in this market, by engine id. */
    this.byId = new Map();
    /** Non-final orders in submission order, avoiding per-event scans of final orders. */
    this.open = [];
    this.seq = 0;
    /** Ledger entries per canonical side: {ts, q, amount}, in arrival order. */
    this.ledger = { asks: [], bids: [] };
    this.stats = newMakerStats();
    /** Markout FIFO per horizon; time-ordered fills give time-ordered deadlines. */
    this.markoutQ = MARKOUT_HORIZONS.map(() => ({ items: [], head: 0 }));
    /** Last book event per token, for markout freshness. */
    this.tokenTs = { UP: null, DOWN: null };
    /** This market's maker fill rows, until the close releases them. */
    this.rows = [];
  }

  /** Drop orders that became final from the open list, keeping its order. */
  #compact() {
    if (this.open.some((o) => FINAL.has(o.state))) this.open = this.open.filter((o) => !FINAL.has(o.state));
  }

  /** Non-final orders bounded by MAX_RESTING. */
  openCount() { this.#compact(); return this.open.length; }

  #active() {
    this.#compact();
    return this.open.filter((o) => o.state === 'live' || o.state === 'cancel_pending');
  }

  /**
   * Accept a gtc order at decision time. Returns the record (state `pending`)
   * or null when it was refused here (counted). The caller schedules the
   * activation at `ts + latency`.
   */
  submit(order, ts) {
    this.stats.submitted += 1;
    let clientId = null;
    if (order.client_id != null) {
      if (typeof order.client_id !== 'string' || !CLIENT_ID.test(order.client_id)
          || ENGINE_ID.test(order.client_id)) {
        this.stats.rejected_invalid += 1;
        return null;
      }
      this.#compact();
      if (this.open.some((o) => o.clientId === order.client_id)) {
        this.stats.rejected_duplicate_id += 1;
        return null;
      }
      clientId = order.client_id;
    }
    this.seq += 1;
    const rec = {
      id: `o${this.seq}`,
      seq: this.seq,
      clientId,
      order,
      side: order.side,
      reduce: Boolean(order.reduce_only),
      postOnly: order.post_only === true,
      tag: typeof order.tag === 'string' ? order.tag : null,
      limit: null,
      kind: null,
      q: null,
      size: 0,
      remaining: 0,
      state: 'pending',
      submittedTs: ts,
      activatedTs: null,
      cancelEff: null,
      ahead: 0,
      aheadAtJoin: 0,
      crossed: false,
      makerFilled: 0,
    };
    this.byId.set(rec.id, rec);
    this.open.push(rec);
    return rec;
  }

  /** Resolve `ctx.cancel(x)`: an engine id, else a non-final order's client_id. */
  find(x) {
    if (typeof x !== 'string') return null;
    if (ENGINE_ID.test(x)) return this.byId.get(x) ?? null;
    this.#compact();
    return this.open.find((o) => o.clientId === x) ?? null;
  }

  /** The order reaches the venue: validate, take what is marketable, rest the rest. */
  activate(rec, ts, book) {
    if (rec.state !== 'pending') return;
    const eff = this.pf.normalize(rec.order, this.marketId);
    // Normalise generic side labels through Portfolio.sideOf.
    if (eff) rec.side = eff.side;
    const limit = eff?.limit;
    const ticks = limit == null ? null : toTicks(limit);
    // A resting order needs a price to rest at, on the venue's grid, strictly
    // inside (0, 1). Under order_rules the grid is the market's own tick.
    const grid = this.pf.marketRules.get(this.marketId)?.tickTicks ?? TICK_GRID;
    if (!eff || limit == null || !(limit > 0 && limit < 1)
        || ticks % grid !== 0 || Math.abs(fromTicks(ticks) - limit) > EPS) {
      rec.state = 'rejected';
      this.stats.rejected_invalid += 1;
      return;
    }
    // quote_guard rejects the full order, including its resting remainder.
    if (this.pf.quoteGuard && this.pf.quoteGuardFailure(book, ts, eff)) {
      rec.state = 'rejected';
      this.pf.countReject('quote_guard');
      return;
    }
    const { kind, q } = canonicalOf(rec.side, rec.reduce, ticks);
    // Reject self-crosses against live orders. cancel_pending orders have
    // left the venue; their late-print exposure does not block re-quoting.
    const opp = kind === 'asks' ? 'bids' : 'asks';
    this.#compact();
    for (const o of this.open) {
      if (o.state !== 'live' || o.kind !== opp) continue;
      if (kind === 'bids' ? o.q <= q : o.q >= q) {
        rec.state = 'rejected_self_cross';
        this.stats.rejected_self_cross += 1;
        return;
      }
    }
    rec.limit = limit;
    rec.kind = kind;
    rec.q = q;
    rec.size = eff.size;
    rec.remaining = eff.size;

    // Test marketability on the order's token, as for IOC.
    const touch = rec.reduce ? book.bestBid(rec.side) : book.best(rec.side);
    const marketable = touch != null && (rec.reduce ? toTicks(touch) >= ticks : toTicks(touch) <= ticks);
    if (marketable) {
      if (rec.postOnly) {
        rec.state = 'rejected_post_only';
        this.stats.rejected_post_only += 1;
        return;
      }
      const res = this.pf.executeEffective({
        book, eff, ts, marketId: this.marketId, tag: rec.tag, how: 'exit', orderId: rec.id,
      });
      const filled = res?.filled ?? 0;
      this.stats.taker_on_arrival_size += filled;
      // Rest normalised size minus fills; do not reconvert original notional.
      rec.remaining = eff.size - filled;
      if (!(rec.remaining > EPS)) {
        rec.remaining = 0;
        rec.state = 'filled';
        this.stats.fully_filled += 1;
        return;
      }
    }

    rec.state = 'live';
    rec.activatedTs = ts;
    rec.ahead = book.ladders.UP[kind].sizeAtTicks(q);
    rec.aheadAtJoin = rec.ahead;
    this.stats.rested += 1;
    this.stats.rested_size += rec.remaining;
  }

  /** A cancel taking effect at `ts`. Idempotent; never extends exposure. */
  cancel(rec, ts) {
    if (!rec) { this.stats.cancel_noop += 1; return; }
    if (rec.state === 'pending') {
      // Never reached the venue: no exposure window at all.
      rec.state = 'cancelled';
      this.stats.cancelled_before_entry += 1;
      return;
    }
    if (rec.state === 'live') {
      rec.state = 'cancel_pending';
      rec.cancelEff = ts;
      return;
    }
    this.stats.cancel_noop += 1;
  }

  /**
   * Before an event at T: cancel windows that ended strictly before T close,
   * and ledger entries no print at T may use any more are dropped.
   */
  finalize(T) {
    for (const o of this.open) {
      if (o.state === 'cancel_pending' && o.cancelEff + this.lag < T) {
        o.state = 'cancelled';
        this.stats.cancelled += 1;
      }
    }
    for (const kind of ['asks', 'bids']) {
      const led = this.ledger[kind];
      if (led.length && led[0].ts + this.lag < T) {
        this.ledger[kind] = led.filter((e) => e.ts + this.lag >= T);
      }
    }
    if (this.prob) {
      for (const kind of ['asks', 'bids']) {
        const un = this.unseen[kind];
        if (un.length && un[0].ts + this.lag < T) this.unseen[kind] = un.filter((e) => e.ts + this.lag >= T);
      }
    }
  }

  /** Prob mode: unexplained-print volume at `q`, summed in arrival order. */
  #unseenAt(kind, q) {
    let sum = 0;
    for (const e of this.unseen[kind]) if (e.q === q) sum += e.amount;
    return sum;
  }

  /** True when some activated order can still be affected by book or prints. */
  tracking() { return this.open.some((o) => o.state === 'live' || o.state === 'cancel_pending'); }

  /**
   * Apply one book event through `apply`, recording what it removed from the
   * canonical ladders and shortening every queue estimate it bounds.
   */
  bookEvent(ev, book, apply) {
    if (ev.snapshot) {
      for (const side of ['UP', 'DOWN']) if (ev.levels?.[side] != null) this.tokenTs[side] = ev.ts_ms;
    } else if (ev.side === 'UP' || ev.side === 'DOWN') {
      this.tokenTs[ev.side] = ev.ts_ms;
      // A mirrored delta (generic single-book data) updates both tokens.
      if (ev.mirror === true) this.tokenTs[ev.side === 'UP' ? 'DOWN' : 'UP'] = ev.ts_ms;
    }
    if (this.prob) { this.#bookEventProb(ev, book, apply); return; }
    if (!this.tracking()) { apply(); return; }
    // DOWN-only updates leave the canonical UP queues and ledger unchanged.
    const touchesUp = ev.snapshot ? ev.levels?.UP != null : ev.side === 'UP';
    if (!touchesUp) { apply(); return; }
    const T = ev.ts_ms;
    if (!ev.snapshot && !ev.bbo) {
      // A delta states one level of one ladder: that is the only size that can
      // have dropped. Anything malformed goes straight to Book, which refuses it.
      if ((ev.ladder !== 'asks' && ev.ladder !== 'bids') || typeof ev.px !== 'number') { apply(); return; }
      const ladder = book.ladders.UP[ev.ladder];
      const q = toTicks(ev.px);
      const was = ladder.sizeAtTicks(q);
      apply();
      const drop = was - ladder.sizeAtTicks(q);
      if (drop > EPS) this.ledger[ev.ladder].push({ ts: T, q, amount: drop });
    } else {
      // A snapshot replaces the token's ladders; a bound prunes them. Diffed whole.
      const before = { asks: book.ladders.UP.asks.pairs(), bids: book.ladders.UP.bids.pairs() };
      apply();
      for (const kind of ['asks', 'bids']) {
        const after = new Map(book.ladders.UP[kind].pairs());
        for (const [q, size] of before[kind]) {
          const drop = size - (after.get(q) ?? 0);
          if (drop > EPS) this.ledger[kind].push({ ts: T, q, amount: drop });
        }
      }
    }
    for (const o of this.#active()) {
      const v = book.ladders.UP[o.kind].sizeAtTicks(o.q);
      if (v < o.ahead) o.ahead = v;
      // Count each crossing episode without filling: a size update is not
      // evidence of aggressive volume.
      const oppBest = o.kind === 'bids' ? book.ladders.UP.asks.levels[0] : book.ladders.UP.bids.levels[0];
      const crossed = oppBest != null && (o.kind === 'bids' ? oppBest.ticks <= o.q : oppBest.ticks >= o.q);
      if (crossed && !o.crossed) this.stats.crossed_observations += 1;
      o.crossed = crossed;
    }
  }

  /**
   * Prob mode's book event. From the first gtc submit on, every UP change is
   * reconciled at the archive level (unseen absorbed once per price, the rest
   * ledgered), then each active order is bounded by the visible size and, for
   * the unexplained part at its own price, moved by the probability model. A
   * bbo bound only bounds: a crossed-level prune says nothing about where in
   * the queue volume left.
   */
  #bookEventProb(ev, book, apply) {
    if (!(this.stats.submitted > 0)) { apply(); return; }
    const touchesUp = ev.snapshot ? ev.levels?.UP != null : ev.side === 'UP';
    if (!touchesUp) { apply(); return; }
    const T = ev.ts_ms;
    const changes = [];
    if (!ev.snapshot && !ev.bbo) {
      if ((ev.ladder !== 'asks' && ev.ladder !== 'bids') || typeof ev.px !== 'number') { apply(); return; }
      const ladder = book.ladders.UP[ev.ladder];
      const q = toTicks(ev.px);
      const was = ladder.sizeAtTicks(q);
      apply();
      changes.push({ kind: ev.ladder, q, prev: was, now: ladder.sizeAtTicks(q) });
    } else {
      const before = { asks: book.ladders.UP.asks.pairs(), bids: book.ladders.UP.bids.pairs() };
      apply();
      for (const kind of ['asks', 'bids']) {
        const after = new Map(book.ladders.UP[kind].pairs());
        for (const [q, size] of before[kind]) changes.push({ kind, q, prev: size, now: after.get(q) ?? 0 });
      }
    }
    const explained = new Map();
    for (const c of changes) {
      const drop = c.prev - c.now;
      if (!(drop > EPS)) continue;
      // Absorbed once per price, oldest unseen first.
      let absorbed = 0;
      for (const e of this.unseen[c.kind]) {
        if (e.q !== c.q || !(e.amount > EPS)) continue;
        const take = Math.min(drop - absorbed, e.amount);
        e.amount -= take;
        absorbed += take;
        if (!(drop - absorbed > EPS)) break;
      }
      if (absorbed > 0) this.unseen[c.kind] = this.unseen[c.kind].filter((e) => e.amount > EPS);
      const chg = drop - absorbed;
      if (chg > EPS) this.ledger[c.kind].push({ ts: T, q: c.q, amount: chg });
      explained.set(`${c.kind}:${c.q}`, { prev: c.prev, absorbed, chg });
    }
    for (const o of this.#active()) {
      const v = book.ladders.UP[o.kind].sizeAtTicks(o.q);
      const was = o.ahead;
      let next = v < was ? v : was;
      const c = ev.bbo ? null : explained.get(`${o.kind}:${o.q}`);
      if (c && c.chg > EPS) {
        const prevE = c.prev - c.absorbed;
        const front = Math.min(was, prevE);
        const back = Math.max(0, prevE - front);
        const p = queueProb(this.prob, front, back);
        if (p != null) {
          const est = front - (1 - p) * c.chg + Math.min(0, back - p * c.chg);
          const e = est > 0 ? est : 0;
          if (e < next) next = e;
        }
      }
      o.ahead = next;
      const oppBest = o.kind === 'bids' ? book.ladders.UP.asks.levels[0] : book.ladders.UP.bids.levels[0];
      const crossed = oppBest != null && (o.kind === 'bids' ? oppBest.ticks <= o.q : oppBest.ticks >= o.q);
      if (crossed && !o.crossed) this.stats.crossed_observations += 1;
      o.crossed = crossed;
    }
  }

  /** One print, through the single waterfall. */
  trade(ev, book) {
    if (this.prob) { this.#tradeProb(ev, book); return; }
    if (!this.tracking()) return;
    // Validate decoded prints here too, with the same rules in both engines.
    if (!(typeof ev.size === 'number' && Number.isFinite(ev.size) && ev.size > 0)) return;
    if (!(typeof ev.px === 'number' && ev.px >= 0 && ev.px <= 1)) return;
    if ((ev.side !== 'UP' && ev.side !== 'DOWN') || (ev.taker !== 'BUY' && ev.taker !== 'SELL')) return;
    const T = ev.ts_ms;
    const { kind, p } = canonicalPrint(ev);
    const ladder = book.ladders.UP[kind];
    const visible = new Map(ladder.pairs());

    const own = this.#active().filter((o) => o.kind === kind && reached(kind, o.q, p));
    const led = this.ledger[kind].filter((e) => reached(kind, e.q, p) && e.amount > EPS);

    // Every reached price that has anything on it, best first.
    const prices = new Set();
    for (const l of ladder.levels) if (reached(kind, l.ticks, p)) prices.add(l.ticks);
    for (const e of led) prices.add(e.q);
    for (const o of own) prices.add(o.q);
    const levels = [...prices].sort((a, b) => (kind === 'asks' ? a - b : b - a));

    let B = ev.size;
    /** External volume consumed in front of each exposed order, applied after the walk. */
    const advance = new Map();
    for (const x of levels) {
      if (!(B > EPS)) break;
      for (const e of led) {
        if (e.q !== x || !(B > EPS)) continue;
        const take = Math.min(B, e.amount);
        e.amount -= take;
        B -= take;
      }
      const here = own.filter((o) => o.q === x)
        .sort((a, b) => (a.activatedTs - b.activatedTs) || (a.seq - b.seq));
      let front = 0;
      let extUsed = 0;
      for (const o of here) {
        const seg = Math.max(0, o.ahead - front);
        const extTake = Math.min(B, seg);
        B -= extTake;
        extUsed += extTake;
        if (o.ahead > front) front = o.ahead;
        const exposed = T >= o.activatedTs + this.lag
          && (o.state === 'live' || (o.state === 'cancel_pending' && T <= o.cancelEff + this.lag));
        if (T >= o.activatedTs + this.lag) advance.set(o, extUsed);
        const take = Math.min(B, o.remaining);
        if (!(take > EPS)) continue;
        B -= take;
        if (exposed) this.#fill(o, take, T, book);
        else this.stats.lag_suppressed_size += take;
      }
      const rest = Math.max(0, (visible.get(x) ?? 0) - front);
      B -= Math.min(B, rest);
    }
    for (const [o, used] of advance) o.ahead = Math.max(0, o.ahead - used);
    for (const k of ['asks', 'bids']) {
      if (this.ledger[k].some((e) => !(e.amount > EPS))) {
        this.ledger[k] = this.ledger[k].filter((e) => e.amount > EPS);
      }
    }
  }

  /**
   * Probabilistic print handling: the counterfactual waterfall reads archive
   * state without changing it. A separate archive walk consumes ledger and
   * records unseen. Each walk has its own print-size budget.
   */
  #tradeProb(ev, book) {
    if (!(this.stats.submitted > 0)) return;
    if (!(typeof ev.size === 'number' && Number.isFinite(ev.size) && ev.size > 0)) return;
    if (!(typeof ev.px === 'number' && ev.px >= 0 && ev.px <= 1)) return;
    if ((ev.side !== 'UP' && ev.side !== 'DOWN') || (ev.taker !== 'BUY' && ev.taker !== 'SELL')) return;
    const T = ev.ts_ms;
    const { kind, p } = canonicalPrint(ev);
    const ladder = book.ladders.UP[kind];
    const visible = new Map(ladder.pairs());
    const led = this.ledger[kind].filter((e) => reached(kind, e.q, p) && e.amount > EPS);
    const shadow = (x) => Math.max(0, (visible.get(x) ?? 0) - this.#unseenAt(kind, x));
    const order = (a, b) => (kind === 'asks' ? a - b : b - a);

    // Counterfactual walk uses a ledger copy and shadow level sizes.
    const own = this.#active().filter((o) => o.kind === kind && reached(kind, o.q, p));
    if (own.length) {
      const prices = new Set();
      for (const l of ladder.levels) if (reached(kind, l.ticks, p)) prices.add(l.ticks);
      for (const e of led) prices.add(e.q);
      for (const o of own) prices.add(o.q);
      const left = led.map((e) => e.amount);
      let B = ev.size;
      const advance = new Map();
      for (const x of [...prices].sort(order)) {
        if (!(B > EPS)) break;
        for (let i = 0; i < led.length; i += 1) {
          if (led[i].q !== x || !(B > EPS)) continue;
          const take = Math.min(B, left[i]);
          left[i] -= take;
          B -= take;
        }
        const here = own.filter((o) => o.q === x)
          .sort((a, b) => (a.activatedTs - b.activatedTs) || (a.seq - b.seq));
        let front = 0;
        let extUsed = 0;
        for (const o of here) {
          const seg = Math.max(0, o.ahead - front);
          const extTake = Math.min(B, seg);
          B -= extTake;
          extUsed += extTake;
          if (o.ahead > front) front = o.ahead;
          const exposed = T >= o.activatedTs + this.lag
            && (o.state === 'live' || (o.state === 'cancel_pending' && T <= o.cancelEff + this.lag));
          if (T >= o.activatedTs + this.lag) advance.set(o, extUsed);
          const take = Math.min(B, o.remaining);
          if (!(take > EPS)) continue;
          B -= take;
          if (exposed) this.#fill(o, take, T, book);
          else this.stats.lag_suppressed_size += take;
        }
        const rest = Math.max(0, shadow(x) - front);
        B -= Math.min(B, rest);
      }
      for (const [o, used] of advance) o.ahead = Math.max(0, o.ahead - used);
    }

    // Archive walk records what the print removed.
    const prices = new Set();
    for (const l of ladder.levels) if (reached(kind, l.ticks, p)) prices.add(l.ticks);
    for (const e of led) prices.add(e.q);
    const before = new Map();
    for (const x of prices) before.set(x, shadow(x));
    let R = ev.size;
    for (const x of [...prices].sort(order)) {
      if (!(R > EPS)) break;
      for (const e of led) {
        if (e.q !== x || !(R > EPS)) continue;
        const take = Math.min(R, e.amount);
        e.amount -= take;
        R -= take;
      }
      const t = Math.min(R, before.get(x));
      if (t > EPS) this.unseen[kind].push({ ts: T, q: x, amount: t });
      R -= t;
    }
    if (this.ledger[kind].some((e) => !(e.amount > EPS))) {
      this.ledger[kind] = this.ledger[kind].filter((e) => e.amount > EPS);
    }
  }

  #fill(o, take, T, book) {
    let size = take;
    if (o.reduce) {
      // Apply reductions sequentially so fills cannot sell the same contracts twice.
      const open = this.pf.sizeOf(this.marketId, o.side);
      if (!(open > EPS)) {
        o.state = 'cancelled_no_position';
        this.stats.cancelled_no_position += 1;
        return;
      }
      size = Math.min(size, open);
    }
    const aheadAtFill = o.ahead;
    const row = this.pf.makerFill({
      marketId: this.marketId,
      side: o.side,
      reduce: o.reduce,
      size,
      px: o.limit,
      ts: T,
      tag: o.tag,
      orderId: o.id,
      extra: {
        queue_ahead_at_join: o.aheadAtJoin,
        queue_ahead_at_fill: aheadAtFill,
        time_in_queue_ms: T - o.activatedTs,
        markout_1s: null,
        markout_10s: null,
        markout_60s: null,
        markout_settle: null,
      },
    });
    PENDING_ROWS.add(row);
    this.rows.push(row);
    if (o.makerFilled === 0) this.stats.orders_with_maker_fill += 1;
    o.makerFilled += size;
    o.remaining -= size;
    this.stats.maker_fills += 1;
    this.stats.maker_filled_size += size;
    const m = { row, side: o.side, reduce: o.reduce, px: o.limit, ts: T };
    for (const q of this.markoutQ) q.items.push(m);
    if (!(o.remaining > EPS)) {
      o.remaining = 0;
      o.state = 'filled';
      this.stats.fully_filled += 1;
    }
  }

  /**
   * Resolve every markout horizon that falls strictly before `T` from the book
   * as it stands; which is the latest state at or before the horizon, since
   * the event at T has not been applied yet.
   */
  resolveMarkouts(T, book) {
    for (let k = 0; k < MARKOUT_HORIZONS.length; k += 1) {
      const h = MARKOUT_HORIZONS[k];
      const q = this.markoutQ[k];
      while (q.head < q.items.length && q.items[q.head].ts + h.ms < T) {
        const m = q.items[q.head];
        m.row[h.key] = this.#markout(m, m.ts + h.ms, book);
        q.head += 1;
      }
      if (q.head > 1024 && q.head * 2 > q.items.length) {
        q.items = q.items.slice(q.head);
        q.head = 0;
      }
    }
  }

  #markout(m, due, book) {
    const seen = this.tokenTs[m.side];
    if (seen == null || due - seen > MARKOUT_MAX_AGE_MS) return null;
    const bid = book.bestBid(m.side);
    const ask = book.best(m.side);
    if (bid == null || ask == null || !(toTicks(bid) < toTicks(ask))) return null;
    const mid = (bid + ask) / 2;
    return m.reduce ? m.px - mid : mid - m.px;
  }

  /**
   * At the close: horizons at or before it resolve from the closing book, the
   * rest stay null, and every order that is not final expires; pending ones
   * included. Nothing fills after this.
   */
  close(closeTs, book) {
    this.resolveMarkouts(closeTs + 1, book);
    for (const o of this.open) {
      if (FINAL.has(o.state)) continue;
      o.state = 'expired';
      this.stats.expired += 1;
    }
    this.open = [];
  }

  /**
   * After settlement: the terminal markout (contract value against the fill
   * price) when the outcome is known, then every row of this market is final.
   * `valueOf` is null for a market that did not settle.
   */
  releaseRows(valueOf) {
    for (const row of this.rows) {
      if (valueOf) {
        const v = valueOf(row.side);
        row.markout_settle = row.action === 'reduce' ? row.avg_px - v : v - row.avg_px;
      }
      PENDING_ROWS.delete(row);
    }
    this.rows = [];
  }

  /** What `ctx.orders()` shows: copies, no queue position. */
  views() {
    this.#compact();
    return this.open
      .map((o) => ({
        id: o.id,
        client_id: o.clientId,
        side: o.side,
        action: o.reduce ? 'reduce' : 'open',
        limit: o.limit ?? (typeof o.order.limit === 'number' ? o.order.limit : null),
        size: o.state === 'pending' ? null : o.size,
        remaining: o.state === 'pending' ? null : o.remaining,
        state: o.state,
        placed_ms: o.submittedTs,
      }));
  }
}
