// Node.js strategy SDK. Keep in sync with runner/harness/python/outcometick.py.
// Packaged as outcometick so imports resolve from the strategy directory.
// The runner provides execution methods through ctx.

export const SIDES = Object.freeze(['UP', 'DOWN']);

/**
 * Base class for submitted strategies.
 * Hooks have no defaults, so missing declared hooks are rejected.
 */
export class Strategy {
  /** Params from the manifest, injected by the runner before the first hook. */
  p = {};
}

/**
 * An order returned by a hook for simulated execution.
 * limit is a ceiling when opening and a floor when reducing.
 */
export class Order {
  constructor({ side, size, notional = null, limit = null, holdS = null, hold_s = null,
    reduceOnly = false, reduce_only = false, tif = 'ioc', tag = null,
    postOnly = false, post_only = false, clientId = null, client_id = null } = {}) {
    // Accept UP/DOWN or a generic-market outcome label; the runner validates the label.
    if (!SIDES.includes(side) && !(typeof side === 'string' && side.trim() !== '')) {
      throw new Error(`side must be "UP", "DOWN" or an outcome label, got ${JSON.stringify(side)}`);
    }
    // Accept the SDK and wire spellings.
    const hold = holdS ?? hold_s;
    // size is in contracts. Convert notional using the limit to bound opening
    // spend when the order walks the book. A notional order requires a limit.
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
      // Round down to stay within the notional budget.
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
    // Require a numeric limit; JS and Python coercions differ.
    if (limit != null
      && !(typeof limit === 'number' && Number.isFinite(limit) && limit >= 0 && limit <= 1)) {
      // Binary token prices are in [0, 1]; reject rather than clamp.
      throw new Error(`limit must be between 0 and 1, got ${JSON.stringify(limit)}`);
    }
    // fok: all of it within the limit on arrival, or none of it. The run must
    // declare it ("fok": true in the manifest).
    if (tif !== 'ioc' && tif !== 'gtc' && tif !== 'fok') {
      throw new Error(`tif must be "ioc", "gtc" or "fok", got ${JSON.stringify(tif)}`);
    }
    const postOnlyFlag = Boolean(postOnly || post_only);
    const cid = clientId ?? client_id;
    if (tif === 'gtc') {
      // Resting orders require a limit price.
      if (limit == null) throw new Error('a gtc order needs a limit — the price it rests at');
      if (hold != null) throw new Error('hold_s is not supported on gtc orders; exit with a reduce_only order');
    } else if (postOnlyFlag || cid != null) {
      throw new Error('post_only and client_id only apply to gtc orders');
    }
    if (cid != null && !(typeof cid === 'string' && /^[A-Za-z0-9_.:-]{1,64}$/.test(cid) && !/^o[0-9]+$/.test(cid))) {
      throw new Error(`client_id must be 1-64 of A-Z a-z 0-9 _ . : - and not look like an engine id (o<digits>), got ${JSON.stringify(cid)}`);
    }
    this.side = side;
    this.size = Number(size);
    this.limit = limit == null ? null : Number(limit);
    this.hold_s = hold == null ? null : Number(hold);
    this.reduce_only = Boolean(reduceOnly || reduce_only);
    this.tif = tif;
    this.tag = tag;
    if (tif === 'gtc') {
      this.post_only = postOnlyFlag;
      this.client_id = cid ?? null;
    }
  }
}

export default { Strategy, Order, SIDES };
