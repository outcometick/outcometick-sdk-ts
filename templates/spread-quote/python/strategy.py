import math

from outcometick import Strategy, Order


def on_grid(x):
    """Snap to the venue's 0.001 tick (same arithmetic as the Node template)."""
    return math.floor(x * 1000 + 0.5) / 1000


class SpreadQuote(Strategy):
    """Quote both sides with resting orders and let the queue decide what fills.

    Buying UP at the best bid and buying DOWN at one minus the best ask is a
    two-sided quote on one market: the venue's book is mirrored, so a DOWN bid
    at 1 - a sits in the same queue as an UP offer at a. When both fill, the
    pair pays exactly $1 at settlement whatever the outcome, so the pair earns
    the spread, a - b. What decides the result is everything else: how often
    you are filled at all behind the queue already there, and how often you
    are filled just before the price moves through you — the markouts in the
    report's maker panel.
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
        # The last stretch: pull the quotes. Whatever is held settles at $1 / $0.
        if (self.close_ts - ctx.now) / 1000 <= ctx.p.stop_quoting_s:
            if self.quoted is not None:
                self.pull(ctx)
            return None
        book = ctx.book()
        bid, ask = book.best_bid("UP"), book.best("UP")
        if bid is None or ask is None:
            return None
        # Only quote a spread worth having, away from the extremes.
        if ask - bid < ctx.p.min_spread or bid < ctx.p.px_min or ask > ctx.p.px_max:
            if self.quoted is not None:
                self.pull(ctx)
            return None
        if self.quoted == (bid, ask):
            return None
        # Re-quote at most this often: every cancel stays exposed for a short
        # window after it lands, and chasing every flicker of the touch mostly
        # buys that exposure.
        if self.last_quote_ms is not None and ctx.now - self.last_quote_ms < ctx.p.requote_ms:
            return None
        self.pull(ctx)
        self.quoted = (bid, ask)
        self.last_quote_ms = ctx.now

        pos = ctx.position()
        orders = []
        # The cap is on the side you are LONG OF, not on gross size. ctx.position()
        # reports the larger leg; once it reaches max_inventory, only the other
        # side is quoted. Buying the other side pairs inventory off — an UP + DOWN
        # pair pays exactly $1 at settlement whatever the outcome — so both legs
        # can keep growing while what is actually at risk, their difference,
        # stays within max_inventory + size.
        if not (pos.side == "UP" and pos.size >= ctx.p.max_inventory):
            orders.append(Order(side="UP", size=ctx.p.size, limit=on_grid(bid), tif="gtc", post_only=True))
        if not (pos.side == "DOWN" and pos.size >= ctx.p.max_inventory):
            orders.append(Order(side="DOWN", size=ctx.p.size, limit=on_grid(1 - ask), tif="gtc", post_only=True))
        return orders
