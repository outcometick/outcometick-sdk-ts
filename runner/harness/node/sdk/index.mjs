// The SDK surface a submitted Node.js strategy imports.
//
// The mirror of runner/harness/python/outcometick.py, and it has to exist as a
// resolvable PACKAGE rather than a file beside the harness: the docs, the
// editor sample and the analyser all say
//
//     import { Strategy, Order } from "outcometick";
//
// and Node resolves that by walking node_modules upward from the strategy's own
// directory. Without a package the documented form fails at load time inside
// the sandbox — accepted by the validator, then rejected after queueing, which
// is the worst place to find out.
//
// Deliberately tiny. Everything a strategy can actually DO arrives through
// `ctx`, which the runner constructs; there is nothing here to reach out with.

export const SIDES = Object.freeze(['UP', 'DOWN']);

/**
 * Base class for a submitted strategy.
 *
 * The hooks are not defined here on purpose. A default no-op `onTick` would
 * turn "you declared a hook you did not implement" — a rejection fixable in
 * seconds — into a run that quietly never trades and bills for an empty equity
 * curve.
 */
export class Strategy {
  /** Params from the manifest, injected by the runner before the first hook. */
  p = {};
}

/**
 * An order a hook returns. Never sent — returned, and matched by the runner
 * against the depth that was actually resting at that millisecond.
 *
 * `limit` is a bound in whichever direction protects you: a ceiling when
 * opening, a floor when reducing.
 */
export class Order {
  constructor({ side, size, notional = null, limit = null, holdS = null, hold_s = null,
    reduceOnly = false, reduce_only = false, tif = 'ioc', tag = null } = {}) {
    if (!SIDES.includes(side)) {
      throw new Error(`side must be "UP" or "DOWN", got ${JSON.stringify(side)}`);
    }
    // SIZE IN MONEY, converted here rather than in the engine.
    //
    // Position sizing is nearly always a budget, not a contract count, and the
    // conversion has exactly one honest divisor: your own limit. A contract
    // costs whatever it fills at, and a marketable order walks the book — so
    // dividing by the current best price overspends the moment there is any
    // slippage, by an amount nobody stated. Dividing by the limit is the price
    // you have already said you will not exceed, which makes "spend at most
    // this much" true rather than approximately true.
    //
    // Hence: `notional` REQUIRES `limit`. Without one there is no upper bound
    // on the fill price, so "spend $80" has no answer, and picking one for the
    // caller would be inventing a number they never wrote.
    if (notional != null) {
      if (size != null) {
        throw new Error('give size or notional, not both — they answer the same question two ways');
      }
      if (!(typeof notional === 'number' && Number.isFinite(notional) && notional > 0)) {
        throw new Error(`notional must be a positive number, got ${JSON.stringify(notional)}`);
      }
      if (limit == null) {
        throw new Error('notional needs a limit: without a price ceiling there is no way to turn a budget into a size');
      }
      const px = Number(limit);
      if (!(Number.isFinite(px) && px > 0)) {
        throw new Error(`notional needs a limit above 0, got ${JSON.stringify(limit)}`);
      }
      // FLOOR, so the spend is at most the budget rather than around it.
      const derived = Math.floor(notional / px);
      if (derived < 1) {
        throw new Error(`notional ${notional} buys no contracts at limit ${px}`);
      }
      // eslint-disable-next-line no-param-reassign
      size = derived;
    }
    if (!(typeof size === 'number' && Number.isFinite(size) && size > 0)) {
      throw new Error(`size must be a positive number, got ${JSON.stringify(size)}`);
    }
    // A NUMBER, matching the engine. `Number('0.5')` is 0.5, `Number([0.5])`
    // is 0.5 and `Number(true)` is 1 — while Python's `float([0.5])` raises,
    // so the same published SDK accepted a list in one language and threw in
    // the other. Coercion is not validation, and the two languages do not
    // coerce alike.
    if (limit != null
      && !(typeof limit === 'number' && Number.isFinite(limit) && limit >= 0 && limit <= 1)) {
      // A binary outcome token trades between 0 and 1. A limit outside that is
      // not a price, and silently clamping it would fill an order the strategy
      // never asked for.
      throw new Error(`limit must be between 0 and 1, got ${JSON.stringify(limit)}`);
    }
    if (tif !== 'ioc') {
      // Not modelled, so not accepted. See "Not supported yet" in the docs.
      throw new Error(`tif must be "ioc"; ${JSON.stringify(tif)} is not supported yet`);
    }
    this.side = side;
    this.size = Number(size);
    this.limit = limit == null ? null : Number(limit);
    // Both spellings accepted: the docs use holdS in the Node examples and
    // hold_s is the wire field. Neither should be a trap.
    const hold = holdS ?? hold_s;
    this.hold_s = hold == null ? null : Number(hold);
    this.reduce_only = Boolean(reduceOnly || reduce_only);
    this.tif = tif;
    this.tag = tag;
  }
}

export default { Strategy, Order, SIDES };
