import { Strategy, Order } from "outcometick";

// Snap to the venue's 0.001 tick (same arithmetic as the Python template).
const onGrid = (x) => Math.floor(x * 1000 + 0.5) / 1000;

// Quote both sides with resting orders and let the queue decide what fills.
//
// Buying UP at the best bid and buying DOWN at one minus the best ask is a
// two-sided quote on one market: the venue's book is mirrored, so a DOWN bid at
// 1 - a sits in the same queue as an UP offer at a. When both fill, the pair
// pays exactly $1 at settlement whatever the outcome, so the pair earns the
// spread, a - b. What decides the result is everything else: how often you are
// filled at all behind the queue already there, and how often you are filled
// just before the price moves through you — the markouts in the report's maker
// panel.
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
    // The last stretch: pull the quotes. Whatever is held settles at $1 / $0.
    if ((this.closeTs - ctx.now) / 1000 <= ctx.p.stop_quoting_s) {
      if (this.quoted !== null) this.pull(ctx);
      return null;
    }
    const book = ctx.book();
    const bid = book.bestBid("UP");
    const ask = book.best("UP");
    if (bid == null || ask == null) return null;
    // Only quote a spread worth having, away from the extremes.
    if (ask - bid < ctx.p.min_spread || bid < ctx.p.px_min || ask > ctx.p.px_max) {
      if (this.quoted !== null) this.pull(ctx);
      return null;
    }
    if (this.quoted !== null && this.quoted[0] === bid && this.quoted[1] === ask) return null;
    // Re-quote at most this often: every cancel stays exposed for a short window
    // after it lands, and chasing every flicker of the touch mostly buys that
    // exposure.
    if (this.lastQuoteMs != null && ctx.now - this.lastQuoteMs < ctx.p.requote_ms) return null;
    this.pull(ctx);
    this.quoted = [bid, ask];
    this.lastQuoteMs = ctx.now;

    const pos = ctx.position();
    const orders = [];
    // The cap is on the side you are LONG OF, not on gross size. ctx.position()
    // reports the larger leg; once it reaches max_inventory, only the other side
    // is quoted. Buying the other side pairs inventory off — an UP + DOWN pair
    // pays exactly $1 at settlement whatever the outcome — so both legs can keep
    // growing while what is actually at risk, their difference, stays within
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
