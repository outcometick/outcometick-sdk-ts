// Positions, fills and what a trade earned.
//
// A binary outcome token is worth $1 if its side settles and $0 otherwise, and
// collateral is posted in full — so buying 500 UP at 0.54 costs $270 and
// returns either $500 or $0. Every number in the report is denominated in
// dollars of that collateral, not in contracts.
//
// Cost basis is a running average per (market, side). Not FIFO lots: the SDK
// exposes exactly one `average entry` through ctx.position(), and a report
// showing lot-level detail the strategy could not see would be describing a
// different position from the one it traded.

import { matchOrder, isSide } from './book.mjs';

/**
 * A market that settled 50:50. Predict.fun resolves end_price == start_price
 * this way: both outcome tokens pay half a dollar.
 */
export const OUTCOME_TIE = 'TIE';

/** Every official outcome a market can settle on. */
export const OUTCOMES = Object.freeze(['UP', 'DOWN', OUTCOME_TIE]);

/**
 * Settlement value of one contract, given the official outcome.
 *
 * MUST MATCH otengine.py `contract_value`, and `scripts/audit-report.py`.
 */
export const contractValue = (side, outcome) => {
  if (outcome === OUTCOME_TIE) return 0.5;
  return outcome === side ? 1 : 0;
};

const EPS = 1e-9;

/**
 * Polymarket's taker fee, as archived on each market (`raw.feeSchedule`).
 *
 * The venue charges the taker `C × rate × p × (1 − p)` in USDC, rounded to
 * five decimals, and nothing to the maker. Every fill this engine simulates is
 * a taker fill, so every fill pays it.
 *
 * AN ESTIMATE, AND SAID SO IN THE REPORT. The venue applies the formula per
 * MATCH — one taker order against one maker order — and rounds each. The
 * archive keeps book LEVELS, and a level aggregates any number of maker orders
 * whose individual sizes are gone, so the fee here is computed and rounded per
 * level taken. Same formula, same price, same size; the rounding granularity is
 * the part that cannot be reproduced.
 *
 * MUST MATCH `FEE_MODEL_PM` / `fee_for` in otengine.py.
 */
export const FEE_MODEL_PM = 'polymarket-taker-v1';

/** Round a fee to the venue's five decimals, ties toward +Infinity. */
export const roundFee = (x) => Math.round(x * 1e5) / 1e5;

/**
 * The fee for one match result under a run's fee policy.
 *
 * `policy` is `{mode:'venue'}` (each market's own schedule) or
 * `{mode:'bps', bps}` (a flat rate on notional, the override). `marketFee` is
 * the market's normalised schedule: `{model:FEE_MODEL_PM, rate}`, `{model:'none'}`
 * when the venue charges nothing, or null when we could not read one — which is
 * charged nothing and COUNTED, never guessed at.
 */
export function feeFor(policy, marketFee, res) {
  if (policy?.mode === 'bps') {
    const bps = typeof policy.bps === 'number' && Number.isFinite(policy.bps) ? policy.bps : 0;
    return (res.notional * bps) / 10_000;
  }
  if (!marketFee || marketFee.model !== FEE_MODEL_PM) return 0;
  let total = 0;
  for (const f of res.fills) total += roundFee(f.size * marketFee.rate * f.px * (1 - f.px));
  return total;
}

/**
 * One side of one market, plus the round trip currently in progress.
 *
 * The open position (`size`/`cost`) and the round trip (`entrySize`/
 * `entryNotional`/`exitSize`/`exitNotional`) are tracked separately because
 * they answer different questions: the first is what the strategy is carrying
 * right now, the second is what the per-trade row will say once it closes. A
 * position that is opened, partly closed and topped up again is one trade with
 * a blended entry, and only a separate accumulator can report that honestly.
 */
class Leg {
  constructor(side) {
    this.side = side;
    this.size = 0;
    this.cost = 0;
    this.reset();
  }

  reset() {
    this.entrySize = 0;
    this.entryNotional = 0;
    this.exitSize = 0;
    this.exitNotional = 0;
    this.realised = 0;
    this.fees = 0;
    this.entryTs = null;
  }

  get avgEntry() { return this.size > EPS ? this.cost / this.size : null; }

  get tradeEntryPx() { return this.entrySize > EPS ? this.entryNotional / this.entrySize : null; }

  get tradeExitPx() { return this.exitSize > EPS ? this.exitNotional / this.exitSize : null; }
}

/**
 * The book of positions for one market-day.
 *
 * Scoped to a market on purpose: in the default mode instance state resets per
 * market so runs can be sharded, and a portfolio spanning markets would quietly
 * make that impossible. Session mode uses one of these across the whole range.
 */
export class Portfolio {
  /**
   * @param {{feeBps?:number, fees?:object}} opts
   *   `fees` is the run's fee policy (see feeFor); `feeBps` is the legacy flat
   *   rate on notional, used only when no policy is given. Either is a RUN-level
   *   setting, not a strategy param: what a venue charges is not something a
   *   strategy gets to assume, and a strategy that set it to zero would be
   *   reporting its own fee holiday.
   */
  constructor({ feeBps = 0, fees = null } = {}) {
    // `fees` is the run's policy. Absent, the legacy run-level `feeBps` is the
    // policy — what every caller passed before venue fees existed.
    this.feePolicy = fees ?? { mode: 'bps', bps: Number(feeBps) || 0 };
    /** @type {Map<string, object|null>} each market's normalised fee schedule */
    this.marketFees = new Map();
    /** @type {Map<string,{UP:Leg,DOWN:Leg}>} */
    this.legs = new Map();
    this.trades = [];
    this.fills = [];
    /** Realised cash flow, net of fees. Negative while a position is open. */
    this.cash = 0;
    this.feesPaid = 0;
    /** Orders that could not be sized or sided — reported, never silent. */
    this.rejected = 0;
  }

  #legs(marketId) {
    let l = this.legs.get(marketId);
    if (!l) {
      l = { UP: new Leg('UP'), DOWN: new Leg('DOWN') };
      this.legs.set(marketId, l);
    }
    return l;
  }

  /**
   * Record a market's fee schedule before any of its orders execute.
   *
   * COPIED, never kept by reference: the same object reaches the strategy as
   * `market.fee`, and a strategy that wrote `market.fee.rate = 0` in
   * on_market_open would otherwise have traded fee-free while the report still
   * said it paid the venue's rate. MUST MATCH set_market_fee in otengine.py.
   */
  setMarketFee(marketId, fee) {
    this.marketFees.set(marketId, fee && typeof fee === 'object'
      ? Object.freeze({ model: fee.model, rate: fee.rate })
      : null);
  }

  sizeOf(marketId, side) { return this.#legs(marketId)[side]?.size ?? 0; }

  /**
   * What ctx.position() reports: the leg the strategy is actually carrying.
   *
   * When both legs are open — a hedge — the larger is reported, since a
   * strategy asking "am I long?" is asking about exposure. `both` is set so a
   * strategy that does hedge can tell the difference.
   */
  position(marketId, book = null) {
    const l = this.#legs(marketId);
    const open = [l.UP, l.DOWN].filter((x) => x.size > EPS);
    const realised = l.UP.realised + l.DOWN.realised;
    if (open.length === 0) {
      return { side: null, size: 0, avg_entry: null, unrealised: 0, realised, both: false };
    }
    const lead = open.length === 1 ? open[0] : (l.UP.size >= l.DOWN.size ? l.UP : l.DOWN);
    // Marked against the BID, because the bid is where the position could
    // actually be closed. Marking at the ask reports a profit that cannot be
    // realised, which is how a paper curve beats a real one.
    const mark = book?.bestBid(lead.side) ?? null;
    return {
      side: lead.side,
      size: lead.size,
      avg_entry: lead.avgEntry,
      unrealised: mark == null ? 0 : (mark - lead.avgEntry) * lead.size,
      realised,
      both: open.length === 2,
    };
  }

  /**
   * Apply one order returned by a strategy.
   *
   * Returns the match result, or null when the order was not executable at all.
   */
  execute({ book, order, ts, marketId, tag = null, how = 'exit', orderId = null }) {
    const eff = this.normalize(order, marketId);
    if (!eff) return null;
    return this.executeEffective({ book, eff, ts, marketId, tag, how, orderId });
  }

  /**
   * The one validator: an order a hook returned, as the effective order the
   * engine will act on, or null — counted in `rejected` — when it is unusable.
   * Resting (gtc) orders go through this too, so a shape that is refused as an
   * IOC is refused as a resting order. MUST MATCH normalize in otengine.py.
   */
  normalize(order, marketId) {
    if (!isSide(order?.side)) { this.rejected += 1; return null; }

    const leg = this.#legs(marketId)[order.side];

    // ONE PLACE THAT DECIDES WHETHER AN ORDER IS USABLE.
    //
    // This was three separate checks bolted on one at a time, and each time a
    // new shape of bad input walked past the ones already there — an infinite
    // notional, then a size and a notional together, then a bad `limit` on a
    // plain size order. Whack-a-mole on a consumption point is how you end up
    // with an engine that rejects what it happens to have been asked about.
    //
    // Every unusable order is COUNTED AND RETURNS NULL. Never thrown: a bad
    // order is one order, and otengine.py raising ValueError/OverflowError on
    // the same input turned "reject one order" into "fail the whole run" —
    // same input, two different outcomes, in a product whose whole promise is
    // that the two engines are the same engine. That mirror is held to this
    // table by runner/conformance.
    // A NUMBER, not something Number() is willing to turn into one.
    //
    // Coercion is not validation: `Number('10')` is 10, `Number([10])` is 10,
    // `Number(true)` is 1. Python's `float()` agrees about the string and the
    // bool and RAISES on the list — so `{ size: [10] }` filled ten contracts
    // in JS and was rejected in Python, from one strategy, on one input.
    //
    // The SDK's Order requires a number and the docs say a number. Anything
    // else is a mistake in the strategy, and a mistake that fills is worse
    // than one that is counted.
    const finite = (v) => (
      typeof v === 'number' && Number.isFinite(v) ? v : null
    );

    const hasSize = order.size != null;
    const hasNotional = order.notional != null;
    // Contradictory instructions. Choosing one silently would trade a contract
    // count while the author believed they had set a spending cap.
    if (hasSize === hasNotional) { this.rejected += 1; return null; }

    // A limit is optional, but a limit that is PRESENT must be a price: an
    // outcome token trades in [0, 1], and `limit: 2` or `limit: Infinity`
    // means "pay anything" — which is what it silently did.
    let limit = null;
    if (order.limit != null) {
      limit = finite(order.limit);
      if (limit == null || limit < 0 || limit > 1) { this.rejected += 1; return null; }
    }

    let size;
    if (hasNotional) {
      // MONEY -> CONTRACTS, here rather than in the SDK's Order constructor:
      // a hook may return a plain object literal — most of the JS examples do
      // — and one that never passed through `new Order()` would carry a
      // `notional` nobody converted.
      //
      // The divisor is the limit, never the current best price: a contract
      // costs whatever it fills at and a marketable order walks the book, so
      // dividing by the touch overspends the moment there is any slippage.
      const budget = finite(order.notional);
      if (budget == null || budget <= 0 || limit == null || limit <= 0) {
        this.rejected += 1; return null;
      }
      // The QUOTIENT can overflow from two finite inputs: 1e308 / 0.01 is
      // Infinity. Checked before the floor, because that is where Python
      // raises.
      const q = budget / limit;
      if (!Number.isFinite(q)) { this.rejected += 1; return null; }
      size = Math.floor(q);
    } else {
      size = finite(order.size);
    }
    if (size == null || !(size > 0)) { this.rejected += 1; return null; }

    // reduce_only is clamped to what is open. A strategy asking to close more
    // than it holds must not accidentally open the other way.
    if (order.reduce_only) {
      size = Math.min(size, leg.size);
      if (!(size > EPS)) { this.rejected += 1; return null; }
    }

    // ONE effective order from here on: the derived size has to reach the fill
    // row as well as the match. It did not, and the row's `requested` came out
    // as NaN for a notional-only order — the fill was executed (the fee was
    // identical) but the ROW was rejected by the parser and never emitted, so
    // the run silently lost its fill log. otengine.py does the same.
    return { ...order, size, limit };
  }

  /** Take liquidity for an order `normalize` already accepted. */
  executeEffective({ book, eff, ts, marketId, tag = null, how = 'exit', orderId = null }) {
    const res = matchOrder(book, eff);
    if (res.filled <= 0) {
      this.fills.push(this.#fillRow({ ts, marketId, order: eff, res, tag, realised: 0, fee: 0, orderId }));
      return res;
    }

    const fee = feeFor(this.feePolicy, this.marketFees.get(marketId) ?? null, res);
    const realised = this.#apply(marketId, eff.side, Boolean(eff.reduce_only), res.filled, res.notional, fee, ts, how);
    this.fills.push(this.#fillRow({ ts, marketId, order: eff, res, tag, realised, fee, orderId }));
    return res;
  }

  /**
   * One maker fill of a resting order: `size` contracts at the order's own
   * limit `px`. The caller has already clamped a reduce-only fill to the open
   * leg. Returns the fill row so the engine can attach queue and markout fields.
   *
   * The fee: nothing under venue fees — Polymarket charges the maker nothing,
   * and its maker rebate is paid from a pool, not per fill, so it is not
   * modelled. Under the flat `bps` override the rate applies to maker notional
   * too: it is a flat rate on notional by definition.
   * MUST MATCH maker_fill in otengine.py.
   */
  makerFill({ marketId, side, reduce, size, px, ts, tag = null, orderId = null, extra = null }) {
    const notional = px * size;
    const policy = this.feePolicy;
    const fee = policy?.mode === 'bps'
      ? (notional * (typeof policy.bps === 'number' && Number.isFinite(policy.bps) ? policy.bps : 0)) / 10_000
      : 0;
    const realised = this.#apply(marketId, side, reduce, size, notional, fee, ts, 'exit');
    const row = {
      ts_ms: ts,
      market_id: marketId,
      side,
      action: reduce ? 'reduce' : 'open',
      requested: size,
      filled: size,
      unfilled: 0,
      avg_px: px,
      worst_px: px,
      quoted_px: px,
      levels_walked: 0,
      fee,
      realised,
      tag,
      liquidity: 'maker',
      order_id: orderId,
      ...(extra ?? {}),
    };
    this.fills.push(row);
    return row;
  }

  /** Book a filled quantity against the leg. Returns the realised PnL of the fill. */
  #apply(marketId, side, reduce, filled, notional, fee, ts, how) {
    const leg = this.#legs(marketId)[side];
    this.feesPaid += fee;
    let realised = 0;

    if (reduce) {
      const basis = leg.avgEntry ?? 0;
      realised = notional - basis * filled - fee;
      leg.size -= filled;
      leg.cost -= basis * filled;
      if (leg.size <= EPS) { leg.size = 0; leg.cost = 0; }
      leg.realised += realised;
      leg.fees += fee;
      leg.exitSize += filled;
      leg.exitNotional += notional;
      this.cash += notional - fee;
      if (leg.size === 0) this.#closeTrade(marketId, leg, ts, how);
    } else {
      if (leg.size <= EPS && leg.entryTs == null) leg.entryTs = ts;
      leg.size += filled;
      leg.cost += notional;
      leg.entrySize += filled;
      leg.entryNotional += notional;
      leg.fees += fee;
      // The ENTRY fee is part of what this round trip cost, so it belongs in
      // the trade's realised PnL. Without this line trade.pnl carried only the
      // exit fee, net_pnl was the sum of those, and the headline figure
      // understated costs by every entry fee in the run — a wrong number, on
      // the first panel a paying customer looks at.
      leg.realised -= fee;
      this.cash -= notional + fee;
    }
    return realised;
  }

  #fillRow({ ts, marketId, order, res, tag, realised, fee, orderId = null }) {
    return {
      ts_ms: ts,
      market_id: marketId,
      side: order.side,
      action: order.reduce_only ? 'reduce' : 'open',
      requested: Number(order.size),
      filled: res.filled,
      unfilled: res.unfilled,
      avg_px: res.avgPx,
      worst_px: res.worstPx,
      // The price on the screen when the order was sent. quoted vs avg IS the
      // slippage panel.
      quoted_px: res.quotedPx,
      levels_walked: res.fills.length,
      fee,
      realised,
      tag: tag ?? order.tag ?? null,
      liquidity: 'taker',
      order_id: orderId,
    };
  }

  #closeTrade(marketId, leg, ts, how, extra = {}) {
    this.trades.push({
      market_id: marketId,
      side: leg.side,
      size: leg.exitSize,
      entry_px: leg.tradeEntryPx,
      exit_px: leg.tradeExitPx,
      pnl: leg.realised,
      fees: leg.fees,
      opened_ms: leg.entryTs,
      closed_ms: ts,
      how,
      ...extra,
    });
    leg.reset();
  }

  /**
   * Settle every open leg in a market at the official outcome.
   *
   * Priced at $1/$0 rather than at the last book — a binary market's terminal
   * value is a fact, not a quote. No fee: nothing is traded, the market pays
   * out.
   */
  settle(marketId, outcome, ts) {
    const legs = this.legs.get(marketId);
    if (!legs) return [];
    const closed = [];
    for (const side of ['UP', 'DOWN']) {
      const leg = legs[side];
      if (leg.size <= EPS) continue;
      const value = contractValue(side, outcome) * leg.size;
      leg.realised += value - leg.cost;
      leg.exitSize += leg.size;
      leg.exitNotional += value;
      this.cash += value;

      const before = this.trades.length;
      this.#closeTrade(marketId, leg, ts, 'settled', { outcome });
      closed.push(this.trades[before]);

      leg.size = 0;
      leg.cost = 0;
    }
    return closed;
  }

  /**
   * Force-close every open leg against the book — what hold_s expiry does.
   *
   * A flatten that cannot fill (an empty bid side) leaves the position open and
   * settlement resolves it. Reported rather than forced through at an invented
   * price.
   */
  flatten(marketId, book, ts, how = 'hold_expired') {
    const legs = this.legs.get(marketId);
    if (!legs) return;
    for (const side of ['UP', 'DOWN']) {
      const leg = legs[side];
      if (leg.size <= EPS) continue;
      this.execute({
        book, ts, marketId, how, tag: how,
        order: { side, size: leg.size, limit: null, reduce_only: true },
      });
    }
  }

  /**
   * Realised cash plus every open position marked to the bid.
   *
   * `cash` is negative by the cost of anything open, so adding the mark back is
   * what makes this an equity figure rather than a cash figure. With no book to
   * mark against, open positions are held at cost — never at a guess.
   */
  equity(books = null) {
    let open = 0;
    for (const [marketId, legs] of this.legs) {
      const book = books?.get?.(marketId) ?? null;
      for (const side of ['UP', 'DOWN']) {
        const leg = legs[side];
        if (leg.size <= EPS) continue;
        const mark = book?.bestBid(side) ?? null;
        open += mark == null ? leg.cost : mark * leg.size;
      }
    }
    return this.cash + open;
  }
}
