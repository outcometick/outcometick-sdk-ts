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

import os
import time
from typing import Any, Callable

from otengine import Book, BudgetMonitor, Portfolio, Rec, RunAbort, contract_value, make_rng
from otmaker import MAX_RESTING, MakerBook


def write_all(fd, data, write=os.write):
    """Write every byte, or raise.

    A bare `os.write` is a SHORT write waiting to happen, and the loss is
    silent: it returns how many bytes it took and the caller that ignores the
    number simply drops the rest. Under gVisor -- which is what runs in
    production -- a write past the 64KB pipe buffer returns exactly 65536 and
    the container exits 0, so nothing anywhere reports a problem.

    That is not hypothetical. The result line carries one summary per market,
    so it passes 64KB at roughly 500 markets; a market-day of polymarket is
    ~386. Every Python run large enough to matter lost the tail of its result
    line, the worker never saw a terminating newline, and `collect()` fell back
    to a default whose markets_run is 0 -- reported to the customer as
    "no market-days were replayed". Seventeen runs, no report, every one
    refunded. Node was unaffected only because fs.writeSync loops internally.
    """
    view = memoryview(data)
    while view:
        try:
            n = write(fd, view)
        except BlockingIOError:
            # Imported here, not at the top: `select` cannot wait on a pipe on
            # Windows, and this module is also imported by the pure-Python
            # local backtest, which never writes to a descriptor at all.
            import select
            select.select([], [fd], [])
            continue
        if n <= 0:
            # Not survivable and not silent: a result channel that accepts
            # nothing means this run has no way to report anything at all.
            raise OSError("short write to the result channel")
        view = view[n:]


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


# Mirrors LIMITS.logLineChars / LIMITS.logBytesPerRun in
# api/lib/backtest-contract.mjs. Two engines disagreeing about how much a
# strategy may log is the same strategy behaving differently in two languages,
# which is the thing the conformance suite exists to prevent.
LOG_LINE_CHARS = 512
LOG_BYTES_PER_RUN = 2 * 1024 * 1024


# A settlement recompute is a once-per-market claim, so these are generous.
# `crosschecks` rides the same result line as everything else: unbounded, it is
# an output channel with no budget. Mirrors replay.mjs.
MAX_CROSSCHECKS_PER_MARKET = 16
CROSSCHECK_CLAIMED_CHARS = 32


def make_log_budget(bytes_: int = LOG_BYTES_PER_RUN, line_chars: int = LOG_LINE_CHARS) -> dict:
    """A log allowance for one run, shared by every market in it."""
    return {"bytes": bytes_, "line_chars": line_chars, "spent": 0}


class Ctx:
    """The strategy's whole world.

    Everything the runner will let a strategy touch is on this object; anything
    not here does not exist in the process.
    """

    __slots__ = ("p", "market_id", "__weakref__")

    def __init__(self, params, portfolio, market_id, log_budget, references,
                 series, rng):
        # Rec, not the bare dict the job JSON carries: the SDK documents
        # `ctx.p.entry_z` and every Python example in the docs is written
        # that way, so a plain dict makes all of them fail on the first
        # hook with "'dict' object has no attribute ...", while the
        # identical JavaScript runs. Same parity break Rec exists to stop;
        # `p` was simply missed. Subscript access keeps working.
        object.__setattr__(self, "p", Rec(params or {}))
        object.__setattr__(self, "market_id", market_id)
        _INTERNALS[id(self)] = {
            "now": 0,
            "pf": portfolio,
            "book": None,
            "history": [],
            "logs": [],
            "log_budget": log_budget,
            "refs": references or {},
            "series": series or {},
            "rng": rng,
            "crosschecks": [],
            "log_truncated": False,
            "market": None,
            # Set by MarketReplay: {orders(), cancel(id)}; None outside a replay.
            "resting": None,
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
        # Bytes for the WHOLE RUN, not lines per market -- the mirror of
        # ctx.log in engine/replay.mjs. The old shape gave every market its own
        # allowance of 10,000 unbounded lines, and polymarket has ~386 markets
        # a day, so a run could pour the archive it had just paid for into a
        # file the customer downloads.
        s = _INTERNALS[id(self)]
        budget = s["log_budget"]
        if budget["spent"] >= budget["bytes"]:
            s["log_truncated"] = True
            return
        line = f'{s["now"]} {msg}'[: budget["line_chars"]]
        # BYTES, not characters -- logs.txt is UTF-8. The JS side counts the
        # same way; a run logging Chinese would otherwise spend a third of what
        # it actually writes. The line cap stays in characters (readability);
        # the run cap is about how much data leaves with the customer.
        budget["spent"] += len(line.encode("utf-8")) + 1
        s["logs"].append(line)

    def random(self, seed: int | None = None):
        return _INTERNALS[id(self)]["rng"](seed)

    def orders(self) -> list:
        """This market's resting orders that are not final yet: copies, and no
        queue position. Mirrors ctx.orders() in replay.mjs."""
        r = _INTERNALS[id(self)]["resting"]
        return [Rec(v) for v in r["orders"]()] if r else []

    def cancel(self, order_id) -> bool:
        """Cancel a resting order by engine id or client_id, after the cancel
        latency. False when there is no such order. Mirrors replay.mjs."""
        r = _INTERNALS[id(self)]["resting"]
        return r["cancel"](order_id) if r else False

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
        # BOUNDED, for the same reason ctx.log is, and mirrored in replay.mjs.
        # `outcome` is whatever the strategy passed and this can be called on
        # every event; the whole list is serialised onto the result line, sent
        # and parsed before anything downstream can ignore it. The panel only
        # shows an aggregate, and a settlement recompute is a once-per-market
        # claim, so a cap costs nothing real.
        if len(s["crosschecks"]) >= MAX_CROSSCHECKS_PER_MARKET:
            return
        claimed = outcome if isinstance(outcome, str) else str(outcome)
        s["crosschecks"].append({
            "market_id": self.market_id,
            "claimed": claimed[:CROSSCHECK_CLAIMED_CHARS],
            "official": official,
            "match": official == outcome,
        })


class MarketReplay:
    """One market's replay, as a state machine: open, step per event, close.

    market mode drives one of these at a time; session mode drives every market
    that is open at once from a single time-ordered stream, so a strategy sharing
    one instance across markets never sees a later moment of market A before an
    earlier moment of market B. The rules and their order are exactly the ones
    replay_market has always applied -- MUST MATCH MarketReplay in
    runner/engine/replay.mjs.
    """

    def __init__(self, *, market: dict, strategy, hooks: dict,
                 portfolio: Portfolio | None = None, fill_delay_ms: int = 0,
                 log_budget: dict | None = None, budget: BudgetMonitor | None = None,
                 references=None, series=None, seed: int = 1,
                 fee_bps: float = 0, resting: dict | None = None) -> None:
        self.market_id = market["market_id"]
        self.market = market
        # Attribute access for everything a hook is handed: the docs say
        # `market.strike` and `tick.value`, and they have to be true here.
        # Pre-settle view: `outcome` is a future fact and is stripped. See the
        # matching comment in replay.mjs -- a strategy that read it in
        # on_market_open could buy the winning side and the report became
        # meaningless. Only on_settle sees it.
        self._market_rec = Rec({k: v for k, v in market.items() if k != "outcome"})
        self._settle_rec = Rec(market)
        self.pf = portfolio if portfolio is not None else Portfolio(fee_bps=fee_bps)
        self.pf.set_market_fee(self.market_id, market.get("fee"))
        self.book = Book(self.market_id)
        self.monitor = budget if budget is not None else BudgetMonitor()
        self.strategy = strategy
        self.hooks = hooks
        self.fill_delay_ms = fill_delay_ms
        self.ctx = Ctx(getattr(strategy, "p", {}) or {}, self.pf, self.market_id,
                       log_budget if log_budget is not None else make_log_budget(),
                       references, series, make_rng(seed))
        self.state = _INTERNALS[id(self.ctx)]
        self.state["book"] = self.book
        # The engine's own copy of the market, for assert_outcome.
        self.state["market"] = dict(market)
        self.state["view"] = BookView(self.book)
        self.state["resting"] = {"orders": self._orders_view, "cancel": self._request_cancel}
        # Resting-order policy; see the matching comment in replay.mjs.
        self.resting = resting
        cl = (resting or {}).get("cancelLatencyMs")
        self.cancel_latency_ms = cl if isinstance(cl, (int, float)) and not isinstance(cl, bool) \
            and cl == cl and cl not in (float("inf"), float("-inf")) else fill_delay_ms
        self.maker = MakerBook(self.market_id, self.pf) if (resting or {}).get("allowed") else None
        self.pending: list[dict] = []
        # A market with no declared close has no cutoff; the last event seen
        # becomes the close, tracked as we go rather than peeked.
        self.declared_close = market.get("close_ts_ms")
        self.close_ts = self.declared_close if self.declared_close else float("inf")
        self.seen = 0
        self.last_ts = 0
        self.ended = False

    def _schedule(self, at: int, kind: str, payload) -> None:
        i = len(self.pending)
        while i > 0 and self.pending[i - 1]["at"] > at:
            i -= 1
        self.pending.insert(i, {"at": at, "kind": kind, "payload": payload})

    def drain_until(self, ts) -> None:
        """Execute everything scheduled at or before `ts`, against this book."""
        while self.pending and self.pending[0]["at"] <= ts:
            job = self.pending.pop(0)
            if job["kind"] == "order":
                order = job["payload"]
                res = self.pf.execute(self.book, order, job["at"], self.market_id, how="exit")
                hold = order.get("hold_s") if isinstance(order, dict) else None
                if res and res["filled"] > 0 and hold and not order.get("reduce_only"):
                    self._schedule(job["at"] + int(hold) * 1000, "flatten", {"side": order.get("side")})
            elif job["kind"] == "activate":
                self.maker.activate(job["payload"], job["at"], self.book)
            elif job["kind"] == "cancel":
                self.maker.cancel(job["payload"], job["at"])
            else:
                self.pf.flatten(self.market_id, self.book, job["at"], "hold_expired")

    def _orders_view(self) -> list:
        return self.maker.views() if self.maker else []

    def _request_cancel(self, order_id) -> bool:
        if self.maker is None:
            return False
        # Resolved NOW, to the record -- see replay.mjs.
        rec = self.maker.find(order_id)
        if rec is None:
            self.maker.cancel(None, self.state["now"])
            return False
        self._schedule(self.state["now"] + self.cancel_latency_ms, "cancel", rec)
        return True

    def _call(self, canonical: str, *args):
        name = self.hooks.get(canonical)
        fn = getattr(self.strategy, name, None) if name else None
        if not callable(fn):
            return None
        t0 = time.perf_counter_ns()
        try:
            out = fn(self.ctx, *args)
        except RunAbort:
            raise
        except Exception as err:  # noqa: BLE001 - a strategy may raise anything
            raise RunAbort("E_RUNTIME", f"{canonical} threw: {err}") from err
        self.monitor.record((time.perf_counter_ns() - t0) / 1000)
        return out

    def _emit(self, out, ts: int) -> None:
        if out is None:
            return
        orders = out if isinstance(out, list) else [out]
        for order in orders:
            if order is None:
                continue
            # A COPY taken at decision time -- see replay.mjs.
            row = dict(_as_order(order))
            tif = row.get("tif")
            if tif is None:
                tif = "ioc"
            if tif == "gtc":
                self._submit_resting(row, ts)
                continue
            if tif != "ioc":
                raise RunAbort("E_MANIFEST", f'tif {_js_json(tif)} is not supported — "ioc" or "gtc".')
            self._schedule(ts + self.fill_delay_ms, "order", row)

    def _submit_resting(self, order: dict, ts: int) -> None:
        if self.maker is None:
            refusal = (self.resting or {}).get("refusal")
            raise RunAbort("E_MANIFEST", refusal if isinstance(refusal, str)
                           else "resting (gtc) orders are not available for this run")
        if order.get("hold_s") is not None:
            raise RunAbort("E_MANIFEST", "hold_s is not supported on gtc orders; exit with a reduce_only order")
        if self.maker.open_count() >= MAX_RESTING:
            raise RunAbort("E_RUNTIME", f"more than {MAX_RESTING} open resting orders in market {self.market_id}")
        rec = self.maker.submit(order, ts)
        if rec is not None:
            self._schedule(ts + self.fill_delay_ms, "activate", rec)

    def _check_budget(self) -> None:
        if self.monitor.breached:
            raise RunAbort("E_BUDGET", f"per-event budget exceeded: {self.monitor.summary()}")

    def open(self) -> None:
        self._call("on_market_open", self._market_rec)
        self._check_budget()

    def step(self, ev) -> bool:
        """Apply one event. False once the market is past its close: nothing
        past the close reaches a hook, the book, or the history."""
        if self.ended:
            return False
        self.seen += 1
        ts = ev["ts_ms"]
        self.last_ts = ts
        if ts > self.close_ts:
            self.ended = True
            return False
        state = self.state
        # Everything scheduled strictly before this event resolves against the
        # book as it stood then.
        self.drain_until(ts - 1)
        state["now"] = ts
        maker = self.maker
        if maker is not None:
            maker.finalize(ts)
            maker.resolve_markouts(ts, self.book)

        if ev.get("kind") == "book":
            # BEFORE the snapshot test, because a bound carries snapshot:false
            # and would otherwise be applied as a delta with no ladder, no price
            # and no size -- which Book.delta rejects by raising, taking the
            # whole run with it. MUST MATCH the same ordering in
            # runner/engine/replay.mjs.
            def apply():
                if ev.get("bbo"):
                    self.book.bbo(ts, ev.get("side"), ev.get("bid"), ev.get("ask"))
                elif ev.get("snapshot"):
                    self.book.snapshot(ts, ev.get("levels") or {})
                else:
                    self.book.delta(ts, ev.get("side"), ev.get("ladder"), ev.get("px"), ev.get("size"))
            if maker is not None:
                maker.book_event(ev, self.book, apply)
            else:
                apply()
        elif ev.get("kind") == "trade" and maker is not None:
            maker.trade(ev, self.book)
        self.drain_until(ts)

        ev_rec = Rec(ev)
        if ev.get("kind") == "tick":
            # A separate copy from the one the hook is handed -- see the
            # matching comment in replay.mjs.
            state["history"].append(Rec(ev))

        # A bound refines the book silently and never reaches a hook -- the
        # event has no levels/ladder/px/size, the stream is unthrottled, and
        # ctx.book() is live so the next real event already sees the refined
        # ladder. Full reasoning in replay.mjs; both engines or neither.
        hook = None if ev.get("bbo") else HOOK_FOR.get(ev.get("kind"))
        if hook and self.hooks.get(hook):
            self._emit(self._call(hook, ev_rec), ts)
        self._check_budget()
        return True

    def close(self) -> dict:
        state = self.state
        # Queued work lands AT THE CLOSE, never at its own future timestamp --
        # see the matching comment in replay.mjs. Both engines or neither.
        settle_ts = self.declared_close if self.declared_close else self.last_ts
        state["now"] = settle_ts
        self.drain_until(settle_ts)
        if self.maker is not None:
            self.maker.close(settle_ts, self.book)
        self.pending.clear()

        market = self.market
        self._call("on_settle", self._settle_rec, market.get("outcome"))
        outcome = market.get("outcome")
        settled = self.pf.settle(self.market_id, market["outcome"], settle_ts) if outcome else []
        if self.maker is not None:
            self.maker.release_rows((lambda side: contract_value(side, outcome)) if outcome else None)

        view = state.pop("view", None)
        if view is not None:
            _BOOKS.pop(id(view), None)
        _INTERNALS.pop(id(self.ctx), None)

        return {
            "market_id": self.market_id,
            "asset": market.get("asset"),
            # What the engine PULLED, not what the caller had -- see replay.mjs.
            "events": self.seen,
            "settled": settled,
            "logs": state["logs"],
            "log_truncated": state["log_truncated"],
            "crosschecks": state["crosschecks"],
            "budget": self.monitor.summary(),
            "maker": self.maker.stats if self.maker is not None else None,
        }


def replay_market(*, market: dict, events, strategy, hooks: dict,
                  portfolio: Portfolio | None = None, fill_delay_ms: int = 0,
                  log_budget: dict | None = None, budget: BudgetMonitor | None = None,
                  references=None, series=None, seed: int = 1,
                  fee_bps: float = 0, resting: dict | None = None) -> dict:
    """Replay one market start to finish.

    `events` is any ITERABLE, not necessarily a list -- the harness passes a
    generator that pulls one line off stdin per step, so the future is not in
    the process at all. Nothing here may index it or take its length.
    """
    r = MarketReplay(market=market, strategy=strategy, hooks=hooks, portfolio=portfolio,
                     fill_delay_ms=fill_delay_ms, log_budget=log_budget, budget=budget,
                     references=references, series=series, seed=seed, fee_bps=fee_bps,
                     resting=resting)
    r.open()
    for ev in events:
        if not r.step(ev):
            break
    return r.close()


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
        "post_only": getattr(order, "post_only", False),
        "client_id": getattr(order, "client_id", None),
    }


def _js_json(v) -> str:
    """JSON.stringify for the error message, so both engines word it alike."""
    import json
    try:
        return json.dumps(v, ensure_ascii=False, separators=(",", ":"))
    except (TypeError, ValueError):
        return str(v)
