// Resting (maker) orders: a conservative queue-position model for Polymarket.
//
// Every number this module produces is a fill nobody can verify against the
// venue — the archive has aggregated book levels and one print per
// transaction, not the maker orders inside a level. So, like book.mjs, its
// bias is fixed: where the archive is ambiguous, resolve AGAINST the strategy.
// A resting-order backtest that is generous about queue position overstates
// market-making returns by multiples, which is the whole reason this engine
// refused GTC for so long.
//
// WHAT THE ARCHIVE ACTUALLY SAYS (measured on the public sample + the venue's
// own per-match trade API, 2026-10-11):
//
//  - The book is MIRRORED. A bid for UP at q and an ask for DOWN at 1−q are one
//    queue, published twice with the same size. So every own order is placed in
//    ONE canonical queue, the UP token's view: an UP bid at q and a DOWN
//    reduce-only ask at 1−q compete for the same volume.
//  - A trade prints ONCE, on the TAKER's token, with the taker's direction and
//    TOTAL size, at one maker price — the best or the worst of a sweep, which
//    the print does not say. Half the prints in a measured market were mint
//    matches (a DOWN buyer taking resting UP bids), so a resting UP bid is
//    consumed by DOWN prints at 1−p as well. A single-token model misses them.
//  - Prints can arrive after the book already shows the trade. So the volume a
//    book update removed is held in a DEPLETION LEDGER for PRINT_LAG_MS and
//    deducted, at its original price, from the print that explains it — never
//    treated as gone, which would let that print reach an order behind it.
//
// THE RULES, each conservative on its own:
//
//  - A print reaches only prices at least as good as its own price: the taker
//    certainly traded there, and nothing beyond it is assumed.
//  - One sequential waterfall per print: at each reached price, best first,
//    ledger volume, then the external queue in front of each own order, the
//    order itself, then the rest of the level — all out of ONE budget, the
//    print's size. Own fills plus everything else never exceed what printed.
//  - A new order ignores every print stamped within PRINT_LAG_MS of its
//    activation: that print may describe a match from before it existed.
//  - A cancelled order stays exposed for PRINT_LAG_MS after the cancel takes
//    effect: a print in that window may describe a match from before the
//    cancel. A stress assumption, and documented as one.
//  - Book updates only ever SHORTEN the queue estimate by the visible size at
//    the order's level (what is in front of us and still resting is visible).
//    They never fill: a crossing book is counted as a diagnostic.
//  - Fills are at the order's own limit. No market impact: our orders never
//    consume visible depth.
//
// MUST MATCH otmaker.py, rule for rule and in the order of every floating-point
// operation; runner/conformance holds the two to the same rows.

import { PRICE_SCALE, toTicks, fromTicks } from './book.mjs';

/** Written into every report that has resting orders. Bump on any rule change. */
export const QUEUE_MODEL = 'polymarket-queue-v1';

/**
 * How long a print may trail the book update that already showed its trade.
 *
 * One constant with three uses: the entry exclusion, the cancel exposure and
 * the ledger's lifetime. Chosen from the pre-print BBO absence duration on
 * observed transitions in the public BTC-5m sample day (2026-09-08): p99.9 was
 * 702ms for taker buys and 639ms for taker sells, so max of the two rounded up
 * to 100ms. A heuristic from one series, not a bound, and stated in every
 * report.
 */
export const PRINT_LAG_MS = 800;

/** Non-final resting orders (pending + live + cancel pending) per market. */
export const MAX_RESTING = 50;

/** Polymarket's finest tick, in PRICE_SCALE ticks (0.001). */
export const TICK_GRID = 10;

/**
 * What a client_id may look like. ASCII on purpose: a length limit means
 * different things to JavaScript (UTF-16 units) and Python (code points), and
 * the two engines must refuse exactly the same ids.
 */
const CLIENT_ID = /^[A-Za-z0-9_.:-]{1,64}$/;

/** Engine ids look like this; a client_id may not, so a cancel is never ambiguous. */
const ENGINE_ID = /^o[0-9]+$/;

/** Markout horizons, in ms after the fill. */
export const MARKOUT_HORIZONS = Object.freeze([
  Object.freeze({ key: 'markout_1s', ms: 1_000 }),
  Object.freeze({ key: 'markout_10s', ms: 10_000 }),
  Object.freeze({ key: 'markout_60s', ms: 60_000 }),
]);

/** A mid older than this at the horizon is not a mid. */
export const MARKOUT_MAX_AGE_MS = 5_000;

const EPS = 1e-9;

/**
 * Maker fill rows whose markouts are not final yet. In session mode one
 * portfolio serves every open market and the harness drains its rows whenever
 * any market closes — a row from a market still open would leave with its
 * markouts unset. The harness holds back rows for which this is true; the
 * market's own close releases them.
 */
const PENDING_ROWS = new WeakSet();
export const rowPending = (row) => PENDING_ROWS.has(row);

const FINAL = new Set([
  'filled', 'cancelled', 'expired', 'cancelled_no_position',
  'rejected', 'rejected_post_only', 'rejected_self_cross',
]);

/** Counters for the report's maker block. MUST MATCH new_maker_stats in otmaker.py. */
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
 * Where an own order sits in the canonical (UP) queue.
 *
 * Buying UP at q is a canonical bid at q; selling UP is a canonical ask. Buying
 * DOWN at q is economically selling UP at 1−q — a canonical ask at 1−q — and
 * selling DOWN is a canonical bid at 1−q.
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
  constructor({ marketId, portfolio, printLagMs = PRINT_LAG_MS }) {
    this.marketId = marketId;
    this.pf = portfolio;
    this.lag = printLagMs;
    /** Every order ever submitted in this market, by engine id. */
    this.byId = new Map();
    /**
     * The orders that are not final, in submission order. Everything that runs
     * per event iterates THIS, not every order the market has seen: a strategy
     * re-quoting each second leaves hundreds of final orders behind.
     */
    this.open = [];
    this.seq = 0;
    /** Ledger entries per canonical side: {ts, q, amount}, in arrival order. */
    this.ledger = { asks: [], bids: [] };
    this.stats = newMakerStats();
    /**
     * Fill rows waiting for their markouts, one FIFO per horizon. Fills happen
     * in time order and every horizon is a fixed offset, so each queue is
     * sorted by due time and resolves from its head.
     */
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

  /** Non-final orders, the thing MAX_RESTING bounds. */
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
    const limit = eff?.limit;
    const ticks = limit == null ? null : toTicks(limit);
    // A resting order needs a price to rest at, on the venue's grid, strictly
    // inside (0, 1).
    if (!eff || limit == null || !(limit > 0 && limit < 1)
        || ticks % TICK_GRID !== 0 || Math.abs(fromTicks(ticks) - limit) > EPS) {
      rec.state = 'rejected';
      this.stats.rejected_invalid += 1;
      return;
    }
    const { kind, q } = canonicalOf(rec.side, rec.reduce, ticks);
    // Our own orders may not cross each other: on the venue they would trade
    // with each other (a mint or merge at a loss), which no strategy means.
    // Only LIVE orders count. A cancel_pending order has left the venue — its
    // exposure window is our pessimism about late prints, not a quote still
    // resting — so re-quoting through a just-cancelled price is legitimate.
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

    // Marketable on arrival, judged on the order's OWN token exactly as an IOC
    // would be: a bid crossing the ask, a reduce crossing the bid.
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
      // What is left rests — the normalised size minus what filled, never a
      // fresh conversion of the original notional.
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
    }
    if (!this.tracking()) { apply(); return; }
    // Only the canonical (UP) ladders matter, and most events cannot touch
    // them: a DOWN delta or snapshot leaves UP as it was — and so every queue
    // estimate and every ledger entry. Half of all book events end here.
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
      // A visible level on the other side at or through our price: the archive
      // and our hypothetical order disagree. Counted once per episode, never
      // filled — an absolute size is not arriving aggressive volume.
      const oppBest = o.kind === 'bids' ? book.ladders.UP.asks.levels[0] : book.ladders.UP.bids.levels[0];
      const crossed = oppBest != null && (o.kind === 'bids' ? oppBest.ticks <= o.q : oppBest.ticks >= o.q);
      if (crossed && !o.crossed) this.stats.crossed_observations += 1;
      o.crossed = crossed;
    }
  }

  /** One print, through the single waterfall. */
  trade(ev, book) {
    if (!this.tracking()) return;
    // The decoder already refuses these; this is the second door, so both
    // engines agree on the same rule rather than on whatever each tolerates.
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

  #fill(o, take, T, book) {
    let size = take;
    if (o.reduce) {
      // Sequential, against what is open right now — two reduce orders filled
      // by one print cannot sell the same contracts.
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
   * as it stands — which is the latest state at or before the horizon, since
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
   * rest stay null, and every order that is not final expires — pending ones
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
