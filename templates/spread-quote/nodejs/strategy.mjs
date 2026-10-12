import { Strategy, Order } from "outcometick";

// Snap to the venue's 0.001 tick (same arithmetic as the Python template).
const onGrid = (x) => Math.floor(x * 1000 + 0.5) / 1000;

// Quote both sides with resting orders.
//
// An UP bid at b and a DOWN bid at 1-a share one mirrored book. If both fill,
// the pair pays $1 at settlement, earning a-b before costs. Queue position
// controls fills; maker markouts measure adverse selection.
export default class SpreadQuote extends Strategy {
  onMarketOpen(ctx, market) {
    this.closeTs = market.close_ts_ms;
    this.quoted = null;
    this.lastQuoteMs = null;
  }

  pull(ctx) {
    for (const o of ctx.orders()) if (o.state === "live") ctx.cancel(o.id);
    this.quoted = null;
  }

  onBook(ctx, ev) {
    if (this.closeTs == null) return null;
    // Cancel quotes near close; held tokens settle at $1 or $0.
    if ((this.closeTs - ctx.now) / 1000 <= ctx.p.stop_quoting_s) {
      if (this.quoted !== null) this.pull(ctx);
      return null;
    }
    const book = ctx.book();
    const bid = book.bestBid("UP");
    const ask = book.best("UP");
    if (bid == null || ask == null) return null;
    // Require a minimum spread and prices away from the extremes.
    if (ask - bid < ctx.p.min_spread || bid < ctx.p.px_min || ask > ctx.p.px_max) {
      if (this.quoted !== null) this.pull(ctx);
      return null;
    }
    if (this.quoted !== null && this.quoted[0] === bid && this.quoted[1] === ask) return null;
    // Limit requoting: the queue model retains exposure for a late-print window
    // after cancellation takes effect.
    if (this.lastQuoteMs != null && ctx.now - this.lastQuoteMs < ctx.p.requote_ms) return null;
    this.pull(ctx);
    this.quoted = [bid, ask];
    this.lastQuoteMs = ctx.now;

    const pos = ctx.position();
    const orders = [];
    // ctx.position() reports the larger open leg. At the cap, quote only
    // the opposite side to reduce the imbalance. Matched UP/DOWN pairs pay $1
    // at settlement; gross holdings can grow while the imbalance stays within
    // max_inventory + size.
    if (!(pos.side === "UP" && pos.size >= ctx.p.max_inventory)) {
      orders.push(new Order({ side: "UP", size: ctx.p.size, limit: onGrid(bid), tif: "gtc", postOnly: true }));
    }
    if (!(pos.side === "DOWN" && pos.size >= ctx.p.max_inventory)) {
      orders.push(new Order({ side: "DOWN", size: ctx.p.size, limit: onGrid(1 - ask), tif: "gtc", postOnly: true }));
    }
    return orders;
  }
}
