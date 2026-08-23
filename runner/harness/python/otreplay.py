"""The event loop and the ctx object, ported from runner/engine/replay.mjs.

Same rules as the JavaScript version and the same order of operations, because
the conformance vectors compare them row for row. In particular:

  - pending orders are drained against the book as it stood BEFORE the current
    event is applied, then again after, so a delayed order cannot fill against
    depth that arrived after it;
  - hold_s is measured from the FILL, not from the decision, because a fill that
    landed late has not been held as long;
  - instance state resets per market unless the run is in session mode, which is
    the property that lets a run be sharded at all.
"""

from __future__ import annotations

import time
from typing import Any, Callable

from otengine import Book, BudgetMonitor, Portfolio, Rec, RunAbort, make_rng

HOOK_FOR = {"tick": "on_tick", "book": "on_book", "trade": "on_trade"}


# Live books, keyed by the view that fronts them.
#
# The first version stored the Book on the view as `_b`. Python has no privacy
# and the analyser cannot blanket-refuse single-underscore attributes (a
# strategy's own `self._entered` is normal), so `ctx.book()._b.ladders[...]`
# reached the engine-owned ladder — verified: a strategy inserted a level that
# never existed and filled 1000 contracts at $0.01 in a market whose real book
# held 10 at $0.90.
#
# With the reference in a side table there is no attribute to find.
_BOOKS: dict[int, Book] = {}


class BookView:
    """A read-only view of a book — the mirror of bookView() in replay.mjs."""

    __slots__ = ("__weakref__",)

    def __init__(self, book):
        _BOOKS[id(self)] = book

    def __setattr__(self, name, value):
        raise AttributeError("the book is read-only")

    def __getattr__(self, name):
        raise AttributeError(f"{name!r} does not exist on a book view")

    @property
    def market_id(self):
        return _BOOKS[id(self)].market_id

    @property
    def ts(self):
        return _BOOKS[id(self)].ts

    def best(self, side):
        return _BOOKS[id(self)].best(side)

    def best_bid(self, side):
        return _BOOKS[id(self)].best_bid(side)

    def depth(self, side, bound=None):
        return _BOOKS[id(self)].depth(side, bound)

    def bid_depth(self, side, bound=None):
        return _BOOKS[id(self)].bid_depth(side, bound)

    def levels(self, side, n=10):
        return _BOOKS[id(self)].levels(side, n)

    def bid_levels(self, side, n=10):
        return _BOOKS[id(self)].bid_levels(side, n)

    def mid(self, side):
        return _BOOKS[id(self)].mid(side)


# Engine internals, keyed by the Ctx that fronts them.
#
# Deliberately NOT attributes on Ctx. The earlier version held `_pf`, `_book`
# and `_history` as ordinary underscore-prefixed fields, so a strategy could
# reach `ctx._pf.trades` and push a fabricated settled trade into the report —
# invent a profit, or delete a real loss, and the worker archived it as fact.
#
# Python has no true privacy, so this is defence in depth rather than a wall:
# the side table means there is no attribute to find, `__getattr__` below
# refuses the old names outright, and the static analyser already refuses
# `getattr`, `vars` and dunder attribute access, which are the ways back in.
_INTERNALS: dict[int, dict] = {}


class Ctx:
    """The strategy's whole world.

    Everything the runner will let a strategy touch is on this object; anything
    not here does not exist in the process.
    """

    __slots__ = ("p", "market_id", "__weakref__")

    def __init__(self, params, portfolio, market_id, log_limit, references,
                 series, rng):
        object.__setattr__(self, "p", params)
        object.__setattr__(self, "market_id", market_id)
        _INTERNALS[id(self)] = {
            "now": 0,
            "pf": portfolio,
            "book": None,
            "history": [],
            "logs": [],
            "log_limit": log_limit,
            "refs": references or {},
            "series": series or {},
            "rng": rng,
            "crosschecks": [],
            "log_truncated": False,
            "market": None,
        }

    @property
    def now(self):
        """Read-only: ctx.ref()/ctx.ext() use it as the point-in-time cursor,
        so a strategy that could assign it would read future rows."""
        return _INTERNALS[id(self)]["now"]

    def __getattr__(self, name):
        # Every name, including `_s` — which used to be a convenience property
        # and was therefore a documented route to the live Portfolio and Book.
        # The internals live in a module-level table keyed by id(self); there is
        # no attribute on this object that leads to them.
        raise AttributeError(
            f"{name!r} does not exist on ctx; a strategy reaches the engine "
            "only through the documented methods"
        )

    def __setattr__(self, name, value):
        raise AttributeError("ctx is read-only")


    def book(self, market_id: str | None = None) -> Book | None:
        if market_id and market_id != self.market_id:
            # Cross-market reads are what session mode is for. Answering here
            # would silently break the sharding guarantee.
            raise RunAbort(
                "E_STATE",
                f'ctx.book({market_id}) from market {self.market_id}: '
                'cross-market state needs mode "session"',
            )
        return _INTERNALS[id(self)]["view"]

    def history(self, n: int = 1) -> list[dict]:
        hist = _INTERNALS[id(self)]["history"]
        k = max(0, min(int(n or 0), len(hist)))
        # COPIES: handing back the live rows would let a strategy rewrite the
        # series its own indicators are computed from.
        return [Rec(row) for row in hist[len(hist) - k:]]

    def position(self) -> dict:
        s = _INTERNALS[id(self)]
        return s["pf"].position(self.market_id, s["book"])

    def log(self, msg: Any) -> None:
        s = _INTERNALS[id(self)]
        if len(s["logs"]) >= s["log_limit"]:
            s["log_truncated"] = True
            return
        s["logs"].append(f'{s["now"]} {msg}')

    def random(self, seed: int | None = None):
        return _INTERNALS[id(self)]["rng"](seed)

    def ref(self, name: str):
        feed = _INTERNALS[id(self)]["refs"].get(name)
        if feed is None:
            raise RunAbort("E_MANIFEST", f"reference feed {name} was not declared in the manifest")
        return feed.view_at(self.now)

    def ext(self, name: str):
        entry = _INTERNALS[id(self)]["series"].get(name)
        if entry is None:
            raise RunAbort("E_MANIFEST", f"series {name} was not declared in the manifest")
        return entry.view_at(self.now)

    # ---- rolling helpers. Numerically identical to the JavaScript versions. ----

    def _tail(self, window: int) -> list[float]:
        hist = _INTERNALS[id(self)]["history"]
        n = max(1, min(int(window or 1), len(hist)))
        return [t.get("value") for t in hist[len(hist) - n:]]

    def zscore(self, value: float, window: int = 60) -> float:
        xs = self._tail(window)
        if len(xs) < 2:
            return 0.0
        mean = sum(xs) / len(xs)
        variance = sum((x - mean) ** 2 for x in xs) / len(xs)
        sd = variance ** 0.5
        return 0.0 if sd == 0 else (value - mean) / sd

    def sma(self, window: int = 60):
        xs = self._tail(window)
        return (sum(xs) / len(xs)) if xs else None

    def stdev(self, window: int = 60) -> float:
        xs = self._tail(window)
        if len(xs) < 2:
            return 0.0
        mean = sum(xs) / len(xs)
        return (sum((x - mean) ** 2 for x in xs) / len(xs)) ** 0.5

    def ema(self, window: int = 60):
        xs = self._tail(window)
        if not xs:
            return None
        k = 2 / (len(xs) + 1)
        acc = 0.0
        for i, x in enumerate(xs):
            acc = x if i == 0 else x * k + acc * (1 - k)
        return acc

    def assert_outcome(self, _market: Any, outcome: Any) -> None:
        """Record a cross-check. Never fails the run — it is information.

        The first argument is IGNORED for everything that matters: it used to
        supply both `official` and `market_id`, so a strategy could book itself
        a recompute match that never happened. The panel's whole value is that
        it is the ARCHIVE's answer. Mirrors replay.mjs.
        """
        s = _INTERNALS[id(self)]
        official = (s["market"] or {}).get("outcome")
        s["crosschecks"].append({
            "market_id": self.market_id,
            "claimed": outcome,
            "official": official,
            "match": official == outcome,
        })


def replay_market(*, market: dict, events: list, strategy, hooks: dict,
                  portfolio: Portfolio | None = None, fill_delay_ms: int = 0,
                  log_limit: int = 10_000, budget: BudgetMonitor | None = None,
                  references=None, series=None, seed: int = 1,
                  fee_bps: float = 0) -> dict:
    market_id = market["market_id"]
    # Attribute access for everything a hook is handed: the docs say
    # `market.strike` and `tick.value`, and they have to be true here.
    # Pre-settle view: `outcome` is a future fact and is stripped. See the
    # matching comment in replay.mjs — a strategy that read it in
    # on_market_open could buy the winning side and the report became
    # meaningless. Only on_settle sees it.
    market_rec = Rec({k: v for k, v in market.items() if k != "outcome"})
    settle_rec = Rec(market)
    pf = portfolio if portfolio is not None else Portfolio(fee_bps=fee_bps)
    book = Book(market_id)
    monitor = budget if budget is not None else BudgetMonitor()
    ctx = Ctx(getattr(strategy, "p", {}) or {}, pf, market_id, log_limit,
              references, series, make_rng(seed))
    state = _INTERNALS[id(ctx)]
    state["book"] = book
    # The engine's own copy of the market, for assert_outcome.
    state["market"] = dict(market)
    state["view"] = BookView(book)

    pending: list[dict] = []

    def schedule(at: int, kind: str, payload) -> None:
        i = len(pending)
        while i > 0 and pending[i - 1]["at"] > at:
            i -= 1
        pending.insert(i, {"at": at, "kind": kind, "payload": payload})

    def drain_until(ts) -> None:
        while pending and pending[0]["at"] <= ts:
            job = pending.pop(0)
            if job["kind"] == "order":
                order = job["payload"]
                res = pf.execute(book, order, job["at"], market_id, how="exit")
                hold = order.get("hold_s") if isinstance(order, dict) else None
                if res and res["filled"] > 0 and hold and not order.get("reduce_only"):
                    schedule(job["at"] + int(hold) * 1000, "flatten", {"side": order.get("side")})
            else:
                pf.flatten(market_id, book, job["at"], "hold_expired")

    def call(canonical: str, *args):
        name = hooks.get(canonical)
        fn = getattr(strategy, name, None) if name else None
        if not callable(fn):
            return None
        t0 = time.perf_counter_ns()
        try:
            out = fn(ctx, *args)
        except RunAbort:
            raise
        except Exception as err:  # noqa: BLE001 - a strategy may raise anything
            raise RunAbort("E_RUNTIME", f"{canonical} threw: {err}") from err
        monitor.record((time.perf_counter_ns() - t0) / 1000)
        return out

    def emit(out, ts: int) -> None:
        if out is None:
            return
        orders = out if isinstance(out, list) else [out]
        for order in orders:
            if order is None:
                continue
            row = _as_order(order)
            # Mirrors replay.mjs: refused rather than silently executed as a
            # one-shot IOC.
            tif = row.get("tif") or "ioc"
            if tif != "ioc":
                raise RunAbort(
                    "E_MANIFEST",
                    f'tif {tif!r} is not supported — only "ioc". Resting orders need a '
                    "queue-position model, and guessing at one inflates returns by multiples.",
                )
            schedule(ts + fill_delay_ms, "order", row)

    call("on_market_open", market_rec)
    if monitor.breached:
        raise RunAbort("E_BUDGET", f"per-event budget exceeded: {monitor.summary()}")

    # `events` is any ITERABLE, not necessarily a list — the harness passes a
    # generator that pulls one line off stdin per step, so the future is not in
    # the process at all. Nothing below may index it or take its length.
    #
    # A market with no declared close has no cutoff; the last event seen becomes
    # the close, tracked as we go rather than peeked.
    declared_close = market.get("close_ts_ms")
    close_ts = declared_close if declared_close else float("inf")
    seen = 0
    last_ts = 0

    for ev in events:
        seen += 1
        ts = ev["ts_ms"]
        last_ts = ts
        # Nothing past the close reaches a hook, the book, or the history.
        if ts > close_ts:
            break
        # Everything scheduled strictly before this event resolves against the
        # book as it stood then.
        drain_until(ts - 1)
        state["now"] = ts

        if ev.get("kind") == "book":
            if ev.get("snapshot"):
                book.snapshot(ts, ev.get("levels") or {})
            else:
                book.delta(ts, ev.get("side"), ev.get("ladder"), ev.get("px"), ev.get("size"))
        drain_until(ts)

        ev_rec = Rec(ev)
        if ev.get("kind") == "tick":
            # A separate copy from the one the hook is handed — see the matching
            # comment in replay.mjs.
            state["history"].append(Rec(ev))

        hook = HOOK_FOR.get(ev.get("kind"))
        if hook and hooks.get(hook):
            emit(call(hook, ev_rec), ts)

        if monitor.breached:
            raise RunAbort("E_BUDGET", f"per-event budget exceeded: {monitor.summary()}")

    # Queued work lands AT THE CLOSE, never at its own future timestamp — see
    # the matching comment in replay.mjs. Both engines or neither.
    settle_ts = declared_close if declared_close else last_ts
    state["now"] = settle_ts
    drain_until(settle_ts)
    pending.clear()

    call("on_settle", settle_rec, market.get("outcome"))
    settled = pf.settle(market_id, market["outcome"], settle_ts) if market.get("outcome") else []

    view = state.pop("view", None)
    if view is not None:
        _BOOKS.pop(id(view), None)
    _INTERNALS.pop(id(ctx), None)

    return {
        "market_id": market_id,
        "asset": market.get("asset"),
        # What the engine PULLED, not what the caller had — see replay.mjs.
        "events": seen,
        "settled": settled,
        "logs": state["logs"],
        "log_truncated": state["log_truncated"],
        "crosschecks": state["crosschecks"],
        "budget": monitor.summary(),
    }


def _as_order(order) -> dict:
    """Accept either an Order object or a plain dict from a strategy."""
    if isinstance(order, dict):
        return order
    return {
        "side": getattr(order, "side", None),
        "size": getattr(order, "size", 0),
        "limit": getattr(order, "limit", None),
        "hold_s": getattr(order, "hold_s", None),
        "reduce_only": getattr(order, "reduce_only", False),
        "tif": getattr(order, "tif", "ioc"),
        "tag": getattr(order, "tag", None),
    }
