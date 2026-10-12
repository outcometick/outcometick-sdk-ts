import { Strategy, Order } from "outcometick";

// Trade Binance spot moves before the settlement feed and book catch up.
//
// Measure the move relative to Binance's price at market open to cancel the
// basis between the Binance pair and Chainlink feed. Each asset needs its own
// reference feed in the manifest; missing feeds raise E_MANIFEST. Binance has
// no HYPE spot pair.
export default class BinanceLead extends Strategy {
  onMarketOpen(ctx, market) {
    this.closeTs = market.close_ts_ms;
    this.name = `${market.asset} ${market.interval}`;
    this.feed = `binance:${market.asset.toLowerCase()}usdt:spot:1s`;
    this.spotOpen = null;
    this.entry = null;
  }

  onTick(ctx, tick) {
    if (this.entry !== null || this.closeTs == null) return null;
    const spot = ctx.ref(this.feed);
    if (this.spotOpen === null) {
      // Use the first visible 1s bar as baseline. Bars carry close timestamps
      // and only bars at or after market open are supplied.
      const first = spot.last;
      if (first == null) return null;
      this.spotOpen = first.close;
    }

    const secsLeft = (this.closeTs - ctx.now) / 1000;
    if (secsLeft > ctx.p.window_s || secsLeft <= ctx.p.stop_s) return null;
    const now = spot.last;
    if (now == null) return null;

    const moveBps = (now.close / this.spotOpen - 1) * 10_000;
    if (Math.abs(moveBps) < ctx.p.min_move_bps) return null;
    const side = moveBps > 0 ? "UP" : "DOWN";

    // Enter only before the book prices in the move.
    const ask = ctx.book(tick.market_id).best(side);
    if (ask == null || ask > ctx.p.max_px) return null;

    this.entry = { side, px: ask };
    ctx.log(`${this.name} spot ${moveBps >= 0 ? "+" : ""}${moveBps.toFixed(1)}bps since open, `
      + `${secsLeft.toFixed(0)}s left: buy ${side} @ ${ask.toFixed(3)}`);
    return new Order({ side, notional: ctx.p.notional, limit: ask });
  }

  onSettle(ctx, market, outcome) {
    if (this.entry === null) return;
    const { side, px } = this.entry;
    const verdict = outcome === "TIE" ? "tie" : side === outcome ? "won" : "lost";
    ctx.log(`${this.name} settled ${outcome}: ${verdict} on ${side} @ ${px.toFixed(3)}`);
  }
}
