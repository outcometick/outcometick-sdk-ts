"""The SDK surface a submitted Python strategy imports.

Deliberately tiny. `Strategy` is a base class that exists so `entry` can be
checked against something, and `Order` is a value object. Everything a strategy
can actually DO arrives through `ctx`, which the runner constructs — there is no
way to reach the outside from here, because there is nothing here to reach it
with.
"""

from __future__ import annotations

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

    def __init__(self, side, size, limit=None, hold_s=None, reduce_only=False,
                 tif="ioc", tag=None):
        if side not in SIDES:
            raise ValueError(f'side must be "UP" or "DOWN", got {side!r}')
        if not (isinstance(size, (int, float)) and size > 0):
            raise ValueError(f"size must be a positive number, got {size!r}")
        if limit is not None and not (0 <= float(limit) <= 1):
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
