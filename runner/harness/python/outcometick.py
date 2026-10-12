"""Python strategy SDK: Strategy is the base class and Order is a value object.
The runner provides execution methods through ctx.
Keep in sync with runner/harness/node/sdk/index.mjs."""

from __future__ import annotations

import math
import re

# Export only the SDK names, excluding the future-import annotations binding.
__all__ = ("Strategy", "Order", "SIDES")

SIDES = ("UP", "DOWN")

_CLIENT_ID = re.compile(r"[A-Za-z0-9_.:-]{1,64}")
_ENGINE_ID = re.compile(r"o[0-9]+")


class Strategy:
    """Base class for submitted strategies.

    Hooks have no default implementations, so missing declared hooks are rejected."""

    #: Params from the manifest, injected by the runner before the first hook.
    p: dict = {}


class Order:
    """An order returned by a hook for simulated execution by the runner.

    limit is a price ceiling when opening and a floor when reducing."""

    __slots__ = ("side", "size", "limit", "hold_s", "reduce_only", "tif", "tag", "post_only", "client_id")

    def __init__(self, side, size=None, limit=None, hold_s=None, reduce_only=False,
                 tif="ioc", tag=None, notional=None, post_only=False, client_id=None):
        # "UP" / "DOWN", or an outcome label on generic data, see index.mjs.
        if side not in SIDES and not (isinstance(side, str) and side.strip() != ""):
            raise ValueError(f'side must be "UP", "DOWN" or an outcome label, got {side!r}')
        # size is in contracts. Convert notional using the limit to bound opening
        # spend when the order walks the book. A notional order requires a limit.
        # Keep in sync with index.mjs.
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
            # Use floor(a / b) to match JavaScript, not Python float floor-division:
            # 80 // 0.64 is 124, while floor(80 / 0.64) is 125.
            derived = math.floor(notional / px)
            if derived < 1:
                raise ValueError(f"notional {notional} buys no contracts at limit {px}")
            size = derived
        # Require finite numeric sizes, excluding bool, to match the JS SDK.
        if not (isinstance(size, (int, float)) and not isinstance(size, bool)
                and math.isfinite(size) and size > 0):
            raise ValueError(f"size must be a positive number, got {size!r}")
        # Require a numeric limit; JS and Python coercions differ.
        if limit is not None and not (
                isinstance(limit, (int, float)) and not isinstance(limit, bool)
                and math.isfinite(limit) and 0 <= float(limit) <= 1):
            # Binary token prices are in [0, 1]; reject rather than clamp.
            raise ValueError(f"limit must be between 0 and 1, got {limit!r}")
        # fok: all of it within the limit, or none of it, see index.mjs.
        if tif not in ("ioc", "gtc", "fok"):
            raise ValueError(f'tif must be "ioc", "gtc" or "fok", got {tif!r}')
        # GTC requires a limit and disallows hold_s because fills may be partial.
        # post_only and client_id apply only to GTC. Keep in sync with index.mjs.
        if tif == "gtc":
            if limit is None:
                raise ValueError("a gtc order needs a limit — the price it rests at")
            if hold_s is not None:
                raise ValueError("hold_s is not supported on gtc orders; exit with a reduce_only order")
        elif post_only or client_id is not None:
            raise ValueError("post_only and client_id only apply to gtc orders")
        if client_id is not None and not (isinstance(client_id, str) and _CLIENT_ID.fullmatch(client_id)
                                          and not _ENGINE_ID.fullmatch(client_id)):
            raise ValueError("client_id must be 1-64 of A-Z a-z 0-9 _ . : - and not look like an engine id "
                             f"(o<digits>), got {client_id!r}")
        self.side = side
        self.size = float(size)
        self.limit = None if limit is None else float(limit)
        self.hold_s = None if hold_s is None else int(hold_s)
        self.reduce_only = bool(reduce_only)
        self.tif = tif
        self.tag = tag
        self.post_only = bool(post_only) if tif == "gtc" else False
        self.client_id = client_id if tif == "gtc" else None

    def __repr__(self) -> str:
        extra = f", tif='gtc', client_id={self.client_id!r}" if self.tif == "gtc" else ""
        return (f"Order(side={self.side!r}, size={self.size}, limit={self.limit}, "
                f"reduce_only={self.reduce_only}{extra})")
