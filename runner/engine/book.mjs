// The order book, and how a returned Order becomes fills.
//
// This is the module the slippage panel is a report of, so its bias is fixed:
// where the archive is ambiguous, resolve AGAINST the strategy. An optimistic
// matcher is what makes a backtest flatter, and a flattering backtest is worth
// less than no backtest.
//
// Three rules that are not negotiable:
//
//  - An order fills against the depth that was RESTING at that millisecond.
//    Not the best price during the second, not the next tick's price.
//  - Size beyond the visible depth walks the book and the shortfall is
//    reported. It is never assumed to fill at the top of book.
//  - We only ever take. Posting a quote and waiting to be filled needs a
//    queue-position model, and guessing at it inflates market-making returns by
//    multiples — so it is refused rather than modelled badly.
//
// Prices are outcome-token prices in dollars, 0..1. A binary market quotes a
// probability, so "price" and "implied probability" are the same number.
//
// SHAPE: a binary market has TWO tradeable tokens (UP, DOWN), and each has its
// own bid and ask ladder. Buying UP lifts UP's asks; getting out of UP sells
// into UP's bids. An earlier version of this file modelled one ladder per token
// and could not express an exit at all.

/** The two outcome tokens of an Up/Down market. */
export const SIDES = Object.freeze(['UP', 'DOWN']);
export const isSide = (s) => SIDES.includes(s);

/**
 * Prices are quantised to 1e-4 before any comparison.
 *
 * Venue tick sizes are 0.01 or 0.001 and the archive carries floats. Letting
 * `0.1 + 0.2 > 0.3` decide whether an order fills is exactly the
 * non-determinism this product promises does not exist, so every comparison
 * downstream is on integers.
 */
export const PRICE_SCALE = 10_000;
export const toTicks = (px) => Math.round(px * PRICE_SCALE);
export const fromTicks = (t) => t / PRICE_SCALE;

/**
 * One ladder — all the resting size on one side of one token.
 *
 * `dir` is the direction "better" runs in: asks are best-cheapest (+1, sorted
 * ascending, walk from the front), bids are best-dearest (-1, sorted
 * descending). Keeping both in one class with a direction is what stops the
 * bid path and the ask path drifting into two slightly different matchers.
 */
class Ladder {
  constructor(dir) {
    this.dir = dir; // +1 asks (ascending), -1 bids (descending)
    /** @type {Array<{ticks:number,size:number}>} best-first */
    this.levels = [];
  }

  #order(a, b) { return this.dir > 0 ? a - b : b - a; }

  /** Replace the whole ladder (a snapshot). */
  reset(levels) {
    this.levels = (levels ?? [])
      .map(([px, size]) => ({ ticks: toTicks(px), size: Number(size) }))
      .filter((l) => l.size > 0 && Number.isFinite(l.ticks))
      .sort((a, b) => this.#order(a.ticks, b.ticks));
  }

  /** Apply one delta. A size of zero removes the level. */
  apply(px, size) {
    const ticks = toTicks(px);
    const n = Number(size);
    const i = this.levels.findIndex((l) => l.ticks === ticks);
    if (!(n > 0)) {
      if (i >= 0) this.levels.splice(i, 1);
      return;
    }
    if (i >= 0) { this.levels[i].size = n; return; }
    let j = this.levels.length;
    while (j > 0 && this.#order(this.levels[j - 1].ticks, ticks) > 0) j -= 1;
    this.levels.splice(j, 0, { ticks, size: n });
  }

  /** Best resting price, or null when empty. */
  best() { return this.levels.length ? fromTicks(this.levels[0].ticks) : null; }

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

  /** Consume up to `size` from the best end, respecting `bound`. */
  take(size, bound) {
    const cap = bound == null ? null : toTicks(bound);
    const fills = [];
    let remaining = size;
    let notional = 0;
    while (remaining > 0 && this.levels.length > 0) {
      const level = this.levels[0];
      if (cap != null && this.#order(level.ticks, cap) > 0) break;
      const take = Math.min(remaining, level.size);
      const px = fromTicks(level.ticks);
      fills.push({ px, size: take });
      notional += px * take;
      remaining -= take;
      level.size -= take;
      if (level.size <= 0) this.levels.shift();
    }
    return { fills, remaining, notional };
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
      this.ladders[side].asks.reset(l.asks);
      this.ladders[side].bids.reset(l.bids);
    }
  }

  delta(ts, side, kind, px, size) {
    this.ts = ts;
    if (!isSide(side)) throw new Error(`unknown side ${side}`);
    if (kind !== 'asks' && kind !== 'bids') throw new Error(`unknown ladder ${kind}`);
    this.ladders[side][kind].apply(px, size);
  }

  /**
   * `book.best(side)` — the price to BUY that outcome at, i.e. the best ask.
   *
   * This is the number a strategy means by "the price of UP", and it is what
   * the SDK examples pass as a buy limit. The bid is reachable through
   * `bestBid`, which is what an exit prices against.
   */
  best(side) { return this.ladders[side]?.asks.best() ?? null; }

  bestBid(side) { return this.ladders[side]?.bids.best() ?? null; }

  /** Visible size available to buy at or under `bound`. */
  depth(side, bound = null) { return this.ladders[side]?.asks.depth(bound) ?? 0; }

  bidDepth(side, bound = null) { return this.ladders[side]?.bids.depth(bound) ?? 0; }

  levels(side, n = 10) { return this.ladders[side]?.asks.view(n) ?? []; }

  bidLevels(side, n = 10) { return this.ladders[side]?.bids.view(n) ?? []; }

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
 * Match a taker order against resting depth, consuming what it takes.
 *
 * Consuming matters: two orders returned from the same event must not both fill
 * against the same depth, or "close and reverse in one event" prices the
 * reversal off size the close already ate.
 *
 * `limit` is a bound in whichever direction protects the trader — a CEILING
 * when opening (nothing fills above it) and a FLOOR when reducing (nothing
 * fills below it). The SDK reference states only the buy case; a floor is the
 * only reading of a sell limit that is not simply harmful, since the alternative
 * would let an exit dump into an empty book at any price.
 *
 * @param {Book} book
 * @param {{side:string,size:number,limit:number|null,reduce_only?:boolean}} order
 */
export function matchOrder(book, order) {
  const size = Number(order.size);
  const blank = { fills: [], filled: 0, unfilled: Math.max(0, size || 0), notional: 0, avgPx: null, worstPx: null, quotedPx: null, reduceOnly: Boolean(order.reduce_only) };
  if (!isSide(order.side) || !(size > 0)) return blank;

  const reducing = Boolean(order.reduce_only);
  const ladder = reducing ? book.ladders[order.side].bids : book.ladders[order.side].asks;
  const quotedPx = ladder.best();

  const { fills, remaining, notional } = ladder.take(size, order.limit ?? null);
  const filled = size - remaining;

  return {
    fills,
    filled,
    unfilled: remaining,
    notional,
    avgPx: filled > 0 ? notional / filled : null,
    worstPx: fills.length ? fills[fills.length - 1].px : null,
    // The counterfactual the slippage panel measures against: what the whole
    // size would have cost at the price on the screen when the order was sent.
    quotedPx,
    reduceOnly: reducing,
  };
}
