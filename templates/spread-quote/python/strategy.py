import math

from outcometick import Strategy, Order


def on_grid(x):
    """Snap to the venue's 0.001 tick (same arithmetic as the Node template)."""
    return math.floor(x * 1000 + 0.5) / 1000


class SpreadQuote(Strategy):
    """Quote both sides with resting orders.

    An UP bid at b and a DOWN bid at 1-a share one mirrored book. If both fill,
    the pair pays $1 at settlement, earning a-b before costs. Queue position
    controls fills; maker markouts measure adverse selection.
    """

    def on_market_open(self, ctx, market):
        self.close_ts = market.close_ts_ms
        self.quoted = None
        self.last_quote_ms = None

    def pull(self, ctx):
        for o in ctx.orders():
            if o.state == "live":
                ctx.cancel(o.id)
        self.quoted = None

    def on_book(self, ctx, ev):
        if self.close_ts is None:
            return None
        # Cancel quotes near close; held tokens settle at $1 or $0.
        if (self.close_ts - ctx.now) / 1000 <= ctx.p.stop_quoting_s:
            if self.quoted is not None:
                self.pull(ctx)
            return None
        book = ctx.book()
        bid, ask = book.best_bid("UP"), book.best("UP")
        if bid is None or ask is None:
            return None
        # Require a minimum spread and prices away from the extremes.
        if ask - bid < ctx.p.min_spread or bid < ctx.p.px_min or ask > ctx.p.px_max:
            if self.quoted is not None:
                self.pull(ctx)
            return None
        if self.quoted == (bid, ask):
            return None
        # Limit requoting: the queue model retains exposure for a late-print window
        # after cancellation takes effect.
        if self.last_quote_ms is not None and ctx.now - self.last_quote_ms < ctx.p.requote_ms:
            return None
        self.pull(ctx)
        self.quoted = (bid, ask)
        self.last_quote_ms = ctx.now

        pos = ctx.position()
        orders = []
        # ctx.position() reports the larger open leg. At the cap, quote only
        # the opposite side to reduce the imbalance. Matched UP/DOWN pairs pay $1
        # at settlement; gross holdings can grow while the imbalance stays within
        # max_inventory + size.
        if not (pos.side == "UP" and pos.size >= ctx.p.max_inventory):
            orders.append(Order(side="UP", size=ctx.p.size, limit=on_grid(bid), tif="gtc", post_only=True))
        if not (pos.side == "DOWN" and pos.size >= ctx.p.max_inventory):
            orders.append(Order(side="DOWN", size=ctx.p.size, limit=on_grid(1 - ask), tif="gtc", post_only=True))
        return orders
