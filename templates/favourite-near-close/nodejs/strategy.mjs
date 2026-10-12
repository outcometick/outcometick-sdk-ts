import { Strategy, Order } from "outcometick";

// Buy the side favoured by the settlement feed near close and hold it.
//
// Compare the market's Chainlink stream (twap60s for 5m and 15m) against its
// opening strike. Enter only when the lead and ask meet the thresholds.
export default class FavouriteNearClose extends Strategy {
  onMarketOpen(ctx, market) {
    this.strike = market.strike;
    this.closeTs = market.close_ts_ms;
    this.name = `${market.asset} ${market.interval}`;
    this.entry = null;
  }

  onTick(ctx, tick) {
    // Cheap gates first: this runs on every tick of every market.
    if (this.entry !== null || this.strike == null || this.closeTs == null) return null;
    const secsLeft = (this.closeTs - ctx.now) / 1000;
    if (secsLeft > ctx.p.enter_at_s || secsLeft <= 0) return null;

    // How far the settlement feed is from the strike, in basis points.
    const leadBps = (tick.value - this.strike) / this.strike * 10_000;
    if (Math.abs(leadBps) < ctx.p.min_lead_bps) return null;
    const side = leadBps > 0 ? "UP" : "DOWN";

    const ask = ctx.book(tick.market_id).best(side);
    if (ask == null || ask < ctx.p.px_min || ask > ctx.p.px_max) return null;

    this.entry = { side, px: ask };
    ctx.log(`${this.name} ${side} leads by ${leadBps >= 0 ? "+" : ""}${leadBps.toFixed(1)}bps, `
      + `${secsLeft.toFixed(0)}s left: buy @ ${ask.toFixed(3)}`);
    // Sized in money: size = floor(notional / limit). Held to settlement.
    return new Order({ side, notional: ctx.p.notional, limit: ask });
  }

  onSettle(ctx, market, outcome) {
    if (this.entry === null) return;
    const { side, px } = this.entry;
    const verdict = outcome === "TIE" ? "tie" : side === outcome ? "won" : "lost";
    ctx.log(`${this.name} settled ${outcome}: ${verdict} on ${side} @ ${px.toFixed(3)}`);
  }
}
