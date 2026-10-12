// Positions, fills and realised PnL, in collateral dollars.
// Binary tokens pay $1 for the winning side and $0 for the losing side.
// Average cost basis per (market, side) matches ctx.position().

import { matchOrder, isSide, toTicks, fromTicks } from './book.mjs';

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
 * Keep in sync with otengine.py `contract_value`, and `scripts/audit-report.py`.
 */
export const contractValue = (side, outcome) => {
  if (outcome === OUTCOME_TIE) return 0.5;
  return outcome === side ? 1 : 0;
};

const EPS = 1e-9;

/**
 * Polymarket taker fees from raw.feeSchedule: C × rate × p × (1 − p),
 * rounded to five decimals. Venue maker fees are zero.
 * This is an estimate: the venue rounds per maker match, while the archive
 * aggregates maker orders into levels. We round per level taken.
 * Keep in sync with FEE_MODEL_PM / fee_for in otengine.py.
 */
export const FEE_MODEL_PM = 'polymarket-taker-v1';

/** Round a fee to the venue's five decimals, ties toward +Infinity. */
export const roundFee = (x) => Math.round(x * 1e5) / 1e5;

/** Down to whole hundredths of a share; the venue's size grid; robust to float noise. */
export const floorCents = (x) => Math.floor(x * 100 + 1e-9) / 100;

/** The run-level order counters reported as `orders`. Keep in sync with new_order_stats in otengine.py. */
export function newOrderStats() { return { rejected: {}, rebates: 0 }; }

/**
 * Fee under {mode:'venue'} or flat notional {mode:'bps', bps}.
 * marketFee is {model:FEE_MODEL_PM, rate}, {model:'none'} for known zero,
 * or null for unknown. Unknown schedules are charged zero and counted.
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
 * One market side's position and round-trip totals. Separate accumulators
 * let partial exits and top-ups form one trade with a blended entry.
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

/** Position ledger: per market in market mode, shared across the range in session mode. */
export class Portfolio {
  /**
   * @param {{feeBps?:number, fees?:object}} opts
   *   fees is the run's fee policy (see feeFor). feeBps is the legacy flat
   *   notional rate, used without a policy. Both are run settings.
   */
  constructor({ feeBps = 0, fees = null, engine = null, orderStats = null } = {}) {
    // Fall back to the legacy flat rate when no policy is supplied.
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
    /** Count orders with invalid sizes or sides. */
    this.rejected = 0;
    /**
     * Generic markets only (generic-data.mjs): outcome labels by index, e.g.
     * ['Yes', 'No']. An order may name its side by label, and every row of
     * such a market carries the label. Archive markets have none.
     */
    this.marketLabels = new Map();
    /** Value of positions closed at a mark (pf.mark): never cash. */
    this.markedValue = 0;
    // Lifetime per-market cash and marked totals for record_ms, retained
    // across closes and reopens. Keep in sync with otengine.py.
    this.marketCash = new Map();
    this.marketMarked = new Map();
    // Run execution options; null disables them.
    this.engine = engine;
    this.quoteGuard = engine?.quote_guard ?? null;
    this.makerRebate = engine?.maker_rebate ?? null;
    /** marketId -> {tickTicks, minSize} under order_rules. */
    this.marketRules = new Map();
    /** Markets whose two tokens are one book and its mirror (mirror_depth). */
    this.mirrored = new Set();
    /** Shared with the harness, which reports it: {rejected: {reason: n}, rebates}. */
    this.orderStats = orderStats ?? (engine ? newOrderStats() : null);
    /** The rule a just-normalised order broke, for the caller that writes its row. */
    this.ruleReject = null;
  }

  /** Keep in sync with set_market_rules in otengine.py. */
  setMarketRules(marketId, rules) { this.marketRules.set(marketId, Object.freeze({ ...rules })); }

  setMirrored(marketId) { this.mirrored.add(marketId); }

  countReject(reason) {
    if (this.orderStats) this.orderStats.rejected[reason] = (this.orderStats.rejected[reason] ?? 0) + 1;
  }

  /** Keep in sync with set_market_labels in otengine.py. */
  setMarketLabels(marketId, labels) {
    if (Array.isArray(labels) && labels.length === 2) {
      this.marketLabels.set(marketId, Object.freeze([String(labels[0]), String(labels[1])]));
    }
  }

  /**
   * An order's side as the engine's UP/DOWN: UP/DOWN themselves, or; on a
   * market with labels; a label, matched exactly after trimming and
   * case-folding. Anything else is null (counted by the caller).
   */
  sideOf(side, marketId) {
    if (isSide(side)) return side;
    const labels = this.marketLabels.get(marketId);
    if (!labels || typeof side !== 'string') return null;
    const s = side.trim().toLowerCase();
    if (s === labels[0].trim().toLowerCase()) return 'UP';
    if (s === labels[1].trim().toLowerCase()) return 'DOWN';
    return null;
  }

  #label(marketId, side) {
    const labels = this.marketLabels.get(marketId);
    return labels ? { label: labels[side === 'UP' ? 0 : 1] } : null;
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
   * Copy fees before execution, isolating them from strategy mutations of
   * market.fee. Keep in sync with set_market_fee in otengine.py.
   */
  setMarketFee(marketId, fee) {
    this.marketFees.set(marketId, fee && typeof fee === 'object'
      ? Object.freeze({ model: fee.model, rate: fee.rate })
      : null);
  }

  sizeOf(marketId, side) { return this.#legs(marketId)[side]?.size ?? 0; }

  /**
   * Recorder value at best bid, ignoring depth; no bid values a leg at zero.
   * Keep in sync with liquidation_value in otengine.py.
   */
  liquidationValue(marketId, book) {
    const l = this.legs.get(marketId);
    if (!l) return 0;
    let v = 0;
    for (const side of ['UP', 'DOWN']) {
      const leg = l[side];
      if (!(leg.size > EPS)) continue;
      const bid = book.bestBid(side);
      if (bid != null) v += leg.size * bid;
    }
    return v;
  }

  /** Report the larger open leg through ctx.position(); both flags a hedge. */
  position(marketId, book = null) {
    const l = this.#legs(marketId);
    const open = [l.UP, l.DOWN].filter((x) => x.size > EPS);
    const realised = l.UP.realised + l.DOWN.realised;
    if (open.length === 0) {
      return { side: null, size: 0, avg_entry: null, unrealised: 0, realised, both: false };
    }
    const lead = open.length === 1 ? open[0] : (l.UP.size >= l.DOWN.size ? l.UP : l.DOWN);
    // Mark at bid, where the position could be sold.
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
    if (!eff) {
      // A rule the venue would refuse it on: written as a row, with the reason.
      if (this.ruleReject) this.#rejectRow({ ts, marketId, eff: this.ruleReject.eff, tag, orderId, reason: this.ruleReject.reason });
      return null;
    }
    return this.executeEffective({ book, eff, ts, marketId, tag, how, orderId });
  }

  /**
   * Validate IOC and resting orders into one effective order. Invalid orders
   * return null and increment rejected. Keep in sync with normalize in otengine.py.
   */
  normalize(order, marketId) {
    this.ruleReject = null;
    const side = this.sideOf(order?.side, marketId);
    if (side == null) { this.rejected += 1; return null; }

    const leg = this.#legs(marketId)[side];

    // Reject invalid orders without aborting the run. Require numeric values:
    // JS and Python coercion differ for strings, booleans and arrays.
    // runner/conformance checks both engines against these input rules.
    const finite = (v) => (
      typeof v === 'number' && Number.isFinite(v) ? v : null
    );

    const hasSize = order.size != null;
    const hasNotional = order.notional != null;
    // Size and notional are mutually exclusive.
    if (hasSize === hasNotional) { this.rejected += 1; return null; }

    // A supplied limit must be a finite price in [0, 1].
    let limit = null;
    if (order.limit != null) {
      limit = finite(order.limit);
      if (limit == null || limit < 0 || limit > 1) { this.rejected += 1; return null; }
    }

    const rules = this.marketRules.get(marketId) ?? null;
    let size;
    if (hasNotional) {
      // Convert here for plain-object orders too. Divide by the limit, not
      // the touch price, to preserve the spending cap under slippage.
      const budget = finite(order.notional);
      if (budget == null || budget <= 0 || limit == null || limit <= 0) {
        this.rejected += 1; return null;
      }
      // Finite inputs can overflow on division; check before flooring.
      const q = budget / limit;
      if (!Number.isFinite(q)) { this.rejected += 1; return null; }
      // Order rules use 0.01-share steps; otherwise use whole contracts.
      size = rules ? floorCents(q) : Math.floor(q);
    } else {
      size = finite(order.size);
    }
    if (size == null || !(size > 0)) { this.rejected += 1; return null; }

    // reduce_only is clamped to what is open. A strategy asking to close more
    // than it holds must not accidentally open the other way.
    if (order.reduce_only) {
      size = Math.min(size, leg.size);
      // Partial fills can leave a position off the size grid; an exit can only
      // be sent on it, so it is floored to the grid (then checked like any order).
      if (rules) size = floorCents(size);
      if (!(size > EPS)) { this.rejected += 1; return null; }
    }

    // Venue order rules (order_rules), on the size that would actually be sent.
    if (rules) {
      const eff = { ...order, side, size, limit };
      const cents = size * 100;
      if (Math.abs(cents - Math.round(cents)) > 1e-6) return this.#ruleRejection('size_step', eff);
      if (size < rules.minSize - EPS) return this.#ruleRejection('below_min_size', eff);
      if (limit != null) {
        const t = toTicks(limit);
        if (t % rules.tickTicks !== 0 || Math.abs(fromTicks(t) - limit) > EPS) return this.#ruleRejection('off_tick', eff);
      }
    }

    // Use derived size for matching and fill rows. Keep in sync with otengine.py.
    return { ...order, side, size, limit };
  }

  #ruleRejection(reason, eff) {
    this.rejected += 1;
    this.countReject(reason);
    this.ruleReject = { reason, eff };
    return null;
  }

  /**
   * Why the quote guard refuses a taker order right now, or null. Opening
   * orders only unless the guard says include_exits: by default an exit is
   * never trapped by it. Keep in sync with quote_guard_failure in otengine.py.
   */
  quoteGuardFailure(book, ts, eff) {
    const g = this.quoteGuard;
    if (!g || (eff.reduce_only && !g.include_exits)) return null;
    const up = book.best('UP');
    const down = book.best('DOWN');
    if (g.ask_sum) {
      if (up == null || down == null) return 'quote_guard';
      const sum = up + down;
      if (sum < g.ask_sum[0] - EPS || sum > g.ask_sum[1] + EPS) return 'quote_guard';
    }
    if (g.max_age_ms != null) {
      for (const side of ['UP', 'DOWN']) {
        const q = book.quoteTs(side);
        for (const t of [q.bid, q.ask]) {
          if (t == null || ts - t > g.max_age_ms) return 'quote_guard';
        }
      }
    }
    return null;
  }

  #rejectRow({ ts, marketId, eff, tag, orderId, reason }) {
    const res = { fills: [], filled: 0, unfilled: Number(eff.size), notional: 0, avgPx: null, worstPx: null, quotedPx: null };
    const row = this.#fillRow({ ts, marketId, order: eff, res, tag, realised: 0, fee: 0, orderId });
    row.reject_reason = reason;
    this.fills.push(row);
  }

  /** A taker order that did not execute, written as its row with the reason. */
  refuse({ ts, marketId, eff, tag = null, orderId = null, reason }) {
    this.countReject(reason);
    const res = { fills: [], filled: 0, unfilled: Number(eff.size), notional: 0, avgPx: null, worstPx: null, quotedPx: null };
    const row = this.#fillRow({ ts, marketId, order: eff, res, tag, realised: 0, fee: 0, orderId });
    row.reject_reason = reason;
    this.fills.push(row);
    return res;
  }

  /** Take liquidity for an order `normalize` already accepted. */
  executeEffective({ book, eff, ts, marketId, tag = null, how = 'exit', orderId = null }) {
    if (this.quoteGuard) {
      const why = this.quoteGuardFailure(book, ts, eff);
      if (why) return this.refuse({ ts, marketId, eff, tag, orderId, reason: why });
    }
    if (eff.tif === 'fok') {
      // All of it within the limit, or none of it; measured before anything is taken.
      const avail = eff.reduce_only ? book.bidDepth(eff.side, eff.limit) : book.depth(eff.side, eff.limit);
      if (avail + EPS < eff.size) return this.refuse({ ts, marketId, eff, tag, orderId, reason: 'fok_unfilled' });
    }
    const res = matchOrder(book, eff);
    if (res.filled > 0 && this.mirrored.has(marketId)) {
      const kind = eff.reduce_only ? 'bids' : 'asks';
      for (const f of res.fills) book.consumeMirror(eff.side, kind, f.px, f.size);
    }
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
   * Fill size contracts at the resting limit px. Caller clamps reduce-only
   * fills to the open leg. Return the row for queue and markout fields.
   * Venue maker fees are zero; flat bps applies to maker notional too.
   * Optional rebates estimate the venue's daily pool payments.
   * Keep in sync with maker_fill in otengine.py.
   */
  makerFill({ marketId, side, reduce, size, px, ts, tag = null, orderId = null, extra = null }) {
    const notional = px * size;
    const policy = this.feePolicy;
    let fee = policy?.mode === 'bps'
      ? (notional * (typeof policy.bps === 'number' && Number.isFinite(policy.bps) ? policy.bps : 0)) / 10_000
      : 0;
    // Estimate rebates as a share of known taker fees, credited as negative
    // fees. Actual rebates are paid pro rata from a daily pool.
    let rebate = null;
    if (this.makerRebate != null) {
      rebate = 0;
      const mf = this.marketFees.get(marketId) ?? null;
      if (policy?.mode === 'venue' && mf?.model === FEE_MODEL_PM) {
        rebate = roundFee(this.makerRebate * feeFor(policy, mf, { fills: [{ px, size }], notional }));
      }
      fee -= rebate;
      if (this.orderStats) this.orderStats.rebates += rebate;
    }
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
      ...this.#label(marketId, side),
      ...(rebate != null ? { rebate } : {}),
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
      this.marketCash.set(marketId, (this.marketCash.get(marketId) ?? 0) + (notional - fee));
      if (leg.size === 0) this.#closeTrade(marketId, leg, ts, how);
    } else {
      if (leg.size <= EPS && leg.entryTs == null) leg.entryTs = ts;
      leg.size += filled;
      leg.cost += notional;
      leg.entrySize += filled;
      leg.entryNotional += notional;
      leg.fees += fee;
      // Include entry fees in the round trip's realised PnL.
      leg.realised -= fee;
      this.cash -= notional + fee;
      this.marketCash.set(marketId, (this.marketCash.get(marketId) ?? 0) - (notional + fee));
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
      // Decision-time touch price for slippage against avg_px.
      quoted_px: res.quotedPx,
      levels_walked: res.fills.length,
      fee,
      realised,
      tag: tag ?? order.tag ?? null,
      liquidity: 'taker',
      order_id: orderId,
      ...this.#label(marketId, order.side),
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
      ...this.#label(marketId, leg.side),
    });
    leg.reset();
  }

  /** Settle at contract value ($1/$0, or $0.50 for TIE), without fees. */
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
      this.marketCash.set(marketId, (this.marketCash.get(marketId) ?? 0) + value);

      const before = this.trades.length;
      this.#closeTrade(marketId, leg, ts, 'settled', { outcome });
      closed.push(this.trades[before]);

      leg.size = 0;
      leg.cost = 0;
    }
    return closed;
  }

  /**
   * Close unresolved legs at terminal valuation without moving cash. Keep
   * valued PnL in marked_pnl; size and exit_px cover the whole round trip.
   * terminal is {UP, DOWN, source, ts_ms, age_ms} from external data, or
   * {none: reason}. No mark means zero, the long-only loss bound.
   * Keep in sync with mark in otengine.py.
   */
  mark(marketId, terminal, ts) {
    const legs = this.legs.get(marketId);
    if (!legs) return [];
    const closed = [];
    const valued = terminal && terminal.none == null;
    for (const side of ['UP', 'DOWN']) {
      const leg = legs[side];
      if (leg.size <= EPS) continue;
      const px = valued && typeof terminal[side] === 'number' ? terminal[side] : null;
      const q = leg.size;
      const basis = leg.cost;
      const value = px == null ? 0 : px * q;
      leg.realised += value - basis;
      leg.exitSize += q;
      leg.exitNotional += value;
      this.markedValue += value;
      this.marketMarked.set(marketId, (this.marketMarked.get(marketId) ?? 0) + value);

      const before = this.trades.length;
      this.#closeTrade(marketId, leg, ts, 'marked', {
        outcome: null,
        mark_px: px,
        marked_size: q,
        marked_pnl: value - basis,
        mark_source: valued ? terminal.source ?? null : null,
        mark_ts_ms: valued ? terminal.ts_ms ?? null : null,
        mark_age_ms: valued ? terminal.age_ms ?? null : null,
        mark_missing: valued ? null : (terminal?.none ?? 'no_quote'),
      });
      closed.push(this.trades[before]);

      leg.size = 0;
      leg.cost = 0;
    }
    return closed;
  }

  /**
   * Force-close every open leg against the book; what hold_s expiry does.
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

  /** Cash plus open positions marked to bid; without a book, carry them at cost. */
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
