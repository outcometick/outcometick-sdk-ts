// Order books and taker matching. Consume visible depth at the current event
// time; excess size remains unfilled. Resting orders use maker.mjs.
// Prices are outcome-token dollars (0..1), also implied probabilities.
// UP and DOWN each have separate bid and ask ladders. Resolve archive
// ambiguity conservatively, against the strategy.

/** The two outcome tokens of an Up/Down market. */
export const SIDES = Object.freeze(['UP', 'DOWN']);
export const isSide = (s) => SIDES.includes(s);

/** Quantise prices to 1e-4 for integer comparisons without float noise. */
export const PRICE_SCALE = 10_000;
export const toTicks = (px) => Math.round(px * PRICE_SCALE);
export const fromTicks = (t) => t / PRICE_SCALE;

/** One token's ladder, best first: +1 for ascending asks, -1 for descending bids. */
class Ladder {
  constructor(dir) {
    this.dir = dir; // +1 asks (ascending), -1 bids (descending)
    /** @type {Array<{ticks:number,size:number}>} best-first */
    this.levels = [];
  }

  #order(a, b) { return this.dir > 0 ? a - b : b - a; }

  /** Replace the whole ladder (a snapshot). */
  reset(levels, ts = 0) {
    this.levels = (levels ?? [])
      .map(([px, size]) => ({ ticks: toTicks(px), size: Number(size), ts }))
      .filter((l) => l.size > 0 && Number.isFinite(l.ticks))
      .sort((a, b) => this.#order(a.ticks, b.ticks));
  }

  /** Apply a size delta; non-positive size removes the level. Store ts for pruning. */
  apply(px, size, ts = 0) {
    const ticks = toTicks(px);
    const n = Number(size);
    const i = this.levels.findIndex((l) => l.ticks === ticks);
    if (!(n > 0)) {
      if (i >= 0) this.levels.splice(i, 1);
      return;
    }
    if (i >= 0) { this.levels[i].size = n; this.levels[i].ts = ts; return; }
    let j = this.levels.length;
    while (j > 0 && this.#order(this.levels[j - 1].ticks, ticks) > 0) j -= 1;
    this.levels.splice(j, 0, { ticks, size: n, ts });
  }

  /**
   * Remove levels better than bound and older than ts. Size-free BBO bounds
   * remove stale liquidity but cannot add it. Same-ms levels survive unless
   * inclusive is set, making tied bounds and deltas independent of arrival order.
   * Filter the best-price prefix because its age test is not prefix-aligned.
   */
  prune(bound, ts, inclusive = false) {
    // Require a finite numeric price in [0, 1]: coercion differs across engines,
    // and malformed bounds can empty a ladder. Keep in sync with otengine.py
    // and scripts/audit-report.py.
    if (typeof bound !== 'number' || !Number.isFinite(bound)) return 0;
    if (bound < 0 || bound > 1) return 0;
    const cap = toTicks(bound);
    let removed = 0;
    const kept = [];
    for (const l of this.levels) {
      // Generic data preserves venue order, including same-ms predecessors.
      if (this.#order(l.ticks, cap) < 0 && (inclusive ? l.ts <= ts : l.ts < ts)) { removed += 1; continue; }
      kept.push(l);
    }
    if (removed) this.levels = kept;
    return removed;
  }

  /** Best resting price, or null when empty. */
  best() { return this.levels.length ? fromTicks(this.levels[0].ticks) : null; }

  /** When the best level was last set (its ts), or null when empty. */
  bestTs() { return this.levels.length ? this.levels[0].ts : null; }

  /** Remove up to size at ticks from the shared mirrored level. */
  reduceAt(ticks, size) {
    const i = this.levels.findIndex((l) => l.ticks === ticks);
    if (i < 0) return;
    this.levels[i].size -= Math.min(size, this.levels[i].size);
    if (this.levels[i].size <= 0) this.levels.splice(i, 1);
  }

  /**
   * Size resting at prices at least as good as `bound`.
   *
   * "At least as good" is direction-aware: for asks that means at or below the
   * bound, for bids at or above it. Omit the bound for the whole ladder.
   */
  depth(bound = null) {
    const cap = bound == null ? null : toTicks(bound);
    let total = 0;
    for (const l of this.levels) {
      if (cap != null && this.#order(l.ticks, cap) > 0) break;
      total += l.size;
    }
    return total;
  }

  view(n = 10) { return this.levels.slice(0, n).map((l) => [fromTicks(l.ticks), l.size]); }

  /** Visible size resting at exactly `ticks`, 0 when there is no such level. */
  sizeAtTicks(ticks) {
    for (const l of this.levels) if (l.ticks === ticks) return l.size;
    return 0;
  }

  /** Visible size at prices strictly better than ticks. */
  depthBetterTicks(ticks) {
    let total = 0;
    for (const l of this.levels) {
      if (this.#order(l.ticks, ticks) >= 0) break;
      total += l.size;
    }
    return total;
  }

  /** Best-first [ticks, size] pairs for maker-ledger diffs. */
  pairs() { return this.levels.map((l) => [l.ticks, l.size]); }

  /** Consume up to `size` from the best end, respecting `bound`. */
  take(size, bound) {
    const cap = bound == null ? null : toTicks(bound);
    const fills = [];
    // When each consumed level was last set, parallel to fills (book_age).
    const levelTs = [];
    let remaining = size;
    let notional = 0;
    while (remaining > 0 && this.levels.length > 0) {
      const level = this.levels[0];
      if (cap != null && this.#order(level.ticks, cap) > 0) break;
      const take = Math.min(remaining, level.size);
      const px = fromTicks(level.ticks);
      fills.push({ px, size: take });
      levelTs.push(level.ts);
      notional += px * take;
      remaining -= take;
      level.size -= take;
      if (level.size <= 0) this.levels.shift();
    }
    return { fills, remaining, notional, levelTs };
  }
}

/** A single market's book: two tokens, each with bids and asks. */
export class Book {
  constructor(marketId) {
    this.marketId = marketId;
    this.ts = 0;
    this.ladders = {
      UP: { asks: new Ladder(1), bids: new Ladder(-1) },
      DOWN: { asks: new Ladder(1), bids: new Ladder(-1) },
    };
  }

  /** Replace one or both tokens wholesale. */
  snapshot(ts, levels) {
    this.ts = ts;
    for (const side of SIDES) {
      const l = levels?.[side];
      if (!l) continue;
      this.ladders[side].asks.reset(l.asks, ts);
      this.ladders[side].bids.reset(l.bids, ts);
    }
  }

  delta(ts, side, kind, px, size) {
    this.ts = ts;
    if (!isSide(side)) throw new Error(`unknown side ${side}`);
    if (kind !== 'asks' && kind !== 'bids') throw new Error(`unknown ladder ${kind}`);
    this.ladders[side][kind].apply(px, size, ts);
  }

  /**
   * Prune stale levels using size-free BBO bounds; no liquidity is added.
   * bid = 0 removes positive bids; its binary complement is ask = 1.
   * @returns {number} levels removed
   */
  bbo(ts, side, bid, ask, { inclusive = false } = {}) {
    this.ts = ts;
    if (!isSide(side)) throw new Error(`unknown side ${side}`);
    const l = this.ladders[side];
    return l.asks.prune(ask, ts, inclusive) + l.bids.prune(bid, ts, inclusive);
  }

  /**
   * Update both tokens of a mirrored single book atomically (pmdata data,
   * client/backtest/generic.py). A bid at q mirrors an ask at 1 - q.
   */
  deltaMirrored(ts, side, kind, px, size) {
    this.delta(ts, side, kind, px, size);
    const other = side === 'UP' ? 'DOWN' : 'UP';
    const m = Number((1 - px).toFixed(10));
    if (!(m >= 0 && m <= 1)) return;
    this.delta(ts, other, kind === 'asks' ? 'bids' : 'asks', m, size);
  }

  /** Best ask for buying side; exits use bestBid. */
  best(side) { return this.ladders[side]?.asks.best() ?? null; }

  bestBid(side) { return this.ladders[side]?.bids.best() ?? null; }

  /** Visible size available to buy at or under `bound`. */
  depth(side, bound = null) { return this.ladders[side]?.asks.depth(bound) ?? 0; }

  bidDepth(side, bound = null) { return this.ladders[side]?.bids.depth(bound) ?? 0; }

  levels(side, n = 10) { return this.ladders[side]?.asks.view(n) ?? []; }

  bidLevels(side, n = 10) { return this.ladders[side]?.bids.view(n) ?? []; }

  /**
   * {bid, ask}: exchange timestamps of best levels, null when empty.
   * Keep in sync with quote_ts in otengine.py.
   */
  quoteTs(side) {
    const l = this.ladders[side];
    return l ? { bid: l.bids.bestTs(), ask: l.asks.bestTs() } : { bid: null, ask: null };
  }

  /** Remove consumed liquidity from the opposite mirrored ladder at 1 - px. */
  consumeMirror(side, kind, px, size) {
    const other = side === 'UP' ? 'DOWN' : 'UP';
    const m = Number((1 - px).toFixed(10));
    if (!(m >= 0 && m <= 1)) return;
    this.ladders[other][kind === 'asks' ? 'bids' : 'asks'].reduceAt(toTicks(m), size);
  }

  /** Mid price of a token, or null when either ladder is empty. */
  mid(side) {
    const a = this.best(side);
    const b = this.bestBid(side);
    return a == null || b == null ? null : (a + b) / 2;
  }

  get empty() {
    return SIDES.every((s) => this.ladders[s].asks.levels.length === 0
      && this.ladders[s].bids.levels.length === 0);
  }
}

/**
 * Match a taker order, consuming depth so later orders cannot reuse it.
 * limit is a ceiling for buys and a floor for reduce-only sells.
 * @param {Book} book
 * @param {{side:string,size:number,limit:number|null,reduce_only?:boolean}} order
 */
export function matchOrder(book, order) {
  const size = Number(order.size);
  const blank = { fills: [], levelTs: [], filled: 0, unfilled: Math.max(0, size || 0), notional: 0, avgPx: null, worstPx: null, quotedPx: null, reduceOnly: Boolean(order.reduce_only) };
  if (!isSide(order.side) || !(size > 0)) return blank;

  const reducing = Boolean(order.reduce_only);
  const ladder = reducing ? book.ladders[order.side].bids : book.ladders[order.side].asks;
  const quotedPx = ladder.best();

  const { fills, remaining, notional, levelTs } = ladder.take(size, order.limit ?? null);
  // Sum consumed sizes: subtraction from huge requests loses small fills
  // to float precision (1e308 - 1000 == 1e308). Keep in sync with otengine.py.
  const filled = fills.reduce((a, f) => a + f.size, 0);

  return {
    fills,
    levelTs,
    filled,
    unfilled: remaining,
    notional,
    avgPx: filled > 0 ? notional / filled : null,
    worstPx: fills.length ? fills[fills.length - 1].px : null,
    // Touch price used as the slippage benchmark.
    quotedPx,
    reduceOnly: reducing,
  };
}
