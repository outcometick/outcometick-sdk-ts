from outcometick import Strategy, Order


class BinanceLead(Strategy):
    """Take the side Binance spot is pointing at before the book catches up.

    The market settles on a Chainlink TWAP, which follows spot with a lag. So
    when Binance has already moved decisively since the open, the settlement
    feed and the book may not have priced it yet. The move is measured
    RELATIVE to Binance's own price at the start of the market, which cancels
    the gap between e.g. BTCUSDT on Binance and BTC/USD on Chainlink.

    Each market reads the spot feed of its own coin, so the manifest must
    declare one per coin you run ("reference"; the web editor adds them as you
    pick coins). An undeclared feed stops the run with E_MANIFEST rather than
    trading one coin on another's move. Binance has no HYPE spot pair.
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
            # The baseline: the first 1s bar visible in this market. Bars are
            # stamped at their CLOSE and only bars from the open on are sent,
            # so this is the bar that closed in the market's first second.
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

        # Only worth it while the book has NOT priced the move in yet.
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
