"""The SDK surface a submitted Python strategy imports.

Deliberately tiny. `Strategy` is a base class that exists so `entry` can be
checked against something, and `Order` is a value object. Everything a strategy
can actually DO arrives through `ctx`, which the runner constructs — there is no
way to reach the outside from here, because there is nothing here to reach it
with.
"""

from __future__ import annotations

import math

# Named explicitly so `from __future__ import annotations` does not leak
# `annotations` into the package's public surface — this module is also
# published to PyPI, where dir(outcometick) is what a user reads as the API.
__all__ = ("Strategy", "Order", "SIDES")

SIDES = ("UP", "DOWN")


class Strategy:
    """Base class for a submitted strategy.

    The hooks are not defined here on purpose. A default no-op `on_tick` would
    turn "you declared a hook you did not implement" — a rejection the submitter
    can fix in seconds — into a run that quietly never trades and bills for an
    empty equity curve.
    """

    #: Params from the manifest, injected by the runner before the first hook.
    p: dict = {}


class Order:
    """An order a hook returns. Never sent — returned, and matched by the runner
    against the depth that was actually resting at that millisecond.

    `limit` is a bound in whichever direction protects you: a ceiling when
    opening, a floor when reducing.
    """

    __slots__ = ("side", "size", "limit", "hold_s", "reduce_only", "tif", "tag")

    def __init__(self, side, size=None, limit=None, hold_s=None, reduce_only=False,
                 tif="ioc", tag=None, notional=None):
        if side not in SIDES:
            raise ValueError(f'side must be "UP" or "DOWN", got {side!r}')
        # SIZING IN MONEY -- this is about the `notional` argument below.
        # `size` is CONTRACTS (see OrderSizing in index.d.ts); it is not
        # money, and reading this heading as if it were is the one wrong
        # turn this comment can cause. Mirrors index.mjs exactly -- see
        # the reasoning there.
        # Position sizing is nearly always a budget, and the only honest
        # divisor is your own limit: a contract costs whatever it fills at, so
        # dividing by the current best price overspends the moment there is any
        # slippage. `notional` therefore REQUIRES `limit`.
        if notional is not None:
            if size is not None:
                raise ValueError(
                    "give size or notional, not both -- they answer the same question two ways")
            if not (isinstance(notional, (int, float)) and not isinstance(notional, bool)
                    and math.isfinite(notional) and notional > 0):
                raise ValueError(f"notional must be a positive number, got {notional!r}")
            if limit is None:
                raise ValueError(
                    "notional needs a limit: without a price ceiling there is no way"
                    " to turn a budget into a size")
            px = float(limit)
            if not (math.isfinite(px) and px > 0):
                raise ValueError(f"notional needs a limit above 0, got {limit!r}")
            # FLOOR, so the spend is at most the budget rather than around it.
            # floor(a / b), NOT a // b — see otengine.py. Python's float
            # floor-division disagrees with Math.floor(a / b) on decimal
            # boundaries: 80 // 0.64 is 124, Math.floor(80 / 0.64) is 125.
            derived = math.floor(notional / px)
            if derived < 1:
                raise ValueError(f"notional {notional} buys no contracts at limit {px}")
            size = derived
        # FINITE, and not a bool. Node's Order uses Number.isFinite here, so
        # without this `Order(size=float("inf"))` constructs in Python and
        # throws in JS -- the published SDK behaving differently in the two
        # languages it ships for.
        if not (isinstance(size, (int, float)) and not isinstance(size, bool)
                and math.isfinite(size) and size > 0):
            raise ValueError(f"size must be a positive number, got {size!r}")
        # A NUMBER, matching the engine and index.mjs. float('0.5') and
        # Number('0.5') both give 0.5, but float([0.5]) raises where
        # Number([0.5]) gives 0.5 -- the same published SDK behaving
        # differently in the two languages it ships for.
        if limit is not None and not (
                isinstance(limit, (int, float)) and not isinstance(limit, bool)
                and math.isfinite(limit) and 0 <= float(limit) <= 1):
            # A binary outcome token trades between 0 and 1. A limit outside
            # that is not a price, and silently clamping it would fill an order
            # the strategy never asked for.
            raise ValueError(f"limit must be between 0 and 1, got {limit!r}")
        if tif != "ioc":
            # Not modelled, so not accepted. See "Not supported yet" in the docs.
            raise ValueError(f'tif must be "ioc"; {tif!r} is not supported yet')
        self.side = side
        self.size = float(size)
        self.limit = None if limit is None else float(limit)
        self.hold_s = None if hold_s is None else int(hold_s)
        self.reduce_only = bool(reduce_only)
        self.tif = tif
        self.tag = tag

    def __repr__(self) -> str:
        return (f"Order(side={self.side!r}, size={self.size}, limit={self.limit}, "
                f"reduce_only={self.reduce_only})")
