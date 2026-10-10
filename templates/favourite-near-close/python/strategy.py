from outcometick import Strategy, Order


class FavouriteNearClose(Strategy):
    """Buy the side that is winning on the settlement feed, late, and hold it.

    An up/down market settles on its own Chainlink stream (twap60s for 5m and
    15m markets) against the price at the open -- the strike. That stream is
    exactly what on_tick delivers, so `tick.value - market.strike` is how far
    the side in front is ahead RIGHT NOW, measured in the number that decides
    the market. In the last seconds that lead rarely flips; the question is
    whether the book still sells the winning side cheaply enough to be worth it.
    """

    def on_market_open(self, ctx, market):
        self.strike = market.strike
        self.close_ts = market.close_ts_ms
        self.name = f"{market.asset} {market.interval}"
        self.entry = None

    def on_tick(self, ctx, tick):
        # Cheap gates first: this runs on every tick of every market.
        if self.entry is not None or self.strike is None or self.close_ts is None:
            return None
        secs_left = (self.close_ts - ctx.now) / 1000
        if secs_left > ctx.p.enter_at_s or secs_left <= 0:
            return None

        # How far the settlement feed is from the strike, in basis points.
        lead_bps = (tick.value - self.strike) / self.strike * 10_000
        if abs(lead_bps) < ctx.p.min_lead_bps:
            return None
        side = "UP" if lead_bps > 0 else "DOWN"

        ask = ctx.book(tick.market_id).best(side)
        if ask is None or not ctx.p.px_min <= ask <= ctx.p.px_max:
            return None

        self.entry = (side, ask)
        ctx.log(f"{self.name} {side} leads by {lead_bps:+.1f}bps, {secs_left:.0f}s left: buy @ {ask:.3f}")
        # Sized in money: size = floor(notional / limit). Held to settlement.
        return Order(side=side, notional=ctx.p.notional, limit=ask)

    def on_settle(self, ctx, market, outcome):
        if self.entry is None:
            return
        side, px = self.entry
        verdict = "tie" if outcome == "TIE" else "won" if side == outcome else "lost"
        ctx.log(f"{self.name} settled {outcome}: {verdict} on {side} @ {px:.3f}")
