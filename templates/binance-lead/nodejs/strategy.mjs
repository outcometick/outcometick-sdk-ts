import { Strategy, Order } from "outcometick";

// Take the side Binance spot is pointing at before the book catches up.
//
// The market settles on a Chainlink TWAP, which follows spot with a lag. So
// when Binance has already moved decisively since the open, the settlement
// feed and the book may not have priced it yet. The move is measured RELATIVE
// to Binance's own price at the start of the market, which cancels the gap
// between e.g. BTCUSDT on Binance and BTC/USD on Chainlink.
//
// Each market reads the spot feed of its own coin, so the manifest must declare
// one per coin you run ("reference"; the web editor adds them as you pick
// coins). An undeclared feed stops the run with E_MANIFEST rather than trading
// one coin on another's move. Binance has no HYPE spot pair.
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
      // The baseline: the first 1s bar visible in this market. Bars are
      // stamped at their CLOSE and only bars from the open on are sent, so
      // this is the bar that closed in the market's first second.
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

    // Only worth it while the book has NOT priced the move in yet.
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
