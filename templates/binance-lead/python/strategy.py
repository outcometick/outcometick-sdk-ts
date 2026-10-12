from outcometick import Strategy, Order


class BinanceLead(Strategy):
    """Trade Binance spot moves before the settlement feed and book catch up.

    Measure the move relative to Binance's price at market open to cancel the
    basis between the Binance pair and Chainlink feed. Each asset needs its own
    reference feed in the manifest; missing feeds raise E_MANIFEST. Binance has
    no HYPE spot pair.
    """

    def on_market_open(self, ctx, market):
        self.close_ts = market.close_ts_ms
        self.name = f"{market.asset} {market.interval}"
        self.feed = f"binance:{market.asset.lower()}usdt:spot:1s"
        self.spot_open = None
        self.entry = None

    def on_tick(self, ctx, tick):
        if self.entry is not None or self.close_ts is None:
            return None
        spot = ctx.ref(self.feed)
        if self.spot_open is None:
            # Use the first visible 1s bar as baseline. Bars carry close timestamps
            # and only bars at or after market open are supplied.
            first = spot.last
            if first is None:
                return None
            self.spot_open = first.close

        secs_left = (self.close_ts - ctx.now) / 1000
        if secs_left > ctx.p.window_s or secs_left <= ctx.p.stop_s:
            return None
        now = spot.last
        if now is None:
            return None

        move_bps = (now.close / self.spot_open - 1) * 10_000
        if abs(move_bps) < ctx.p.min_move_bps:
            return None
        side = "UP" if move_bps > 0 else "DOWN"

        # Enter only before the book prices in the move.
        ask = ctx.book(tick.market_id).best(side)
        if ask is None or ask > ctx.p.max_px:
            return None

        self.entry = (side, ask)
        ctx.log(f"{self.name} spot {move_bps:+.1f}bps since open, {secs_left:.0f}s left: buy {side} @ {ask:.3f}")
        return Order(side=side, notional=ctx.p.notional, limit=ask)

    def on_settle(self, ctx, market, outcome):
        if self.entry is None:
            return
        side, px = self.entry
        verdict = "tie" if outcome == "TIE" else "won" if side == outcome else "lost"
        ctx.log(f"{self.name} settled {outcome}: {verdict} on {side} @ {px:.3f}")
