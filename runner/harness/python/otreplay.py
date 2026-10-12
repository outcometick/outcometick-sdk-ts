"""Event loop and strategy context. Keep in sync with runner/engine/replay.mjs.

Pending orders run against the book before the current event, then again
after it. hold_s starts at the fill, not the decision. Strategy state resets
per market unless session mode is enabled, allowing market-mode sharding."""

from __future__ import annotations

import bisect
import json
import math
import os
import time
from typing import Any, Callable

from otengine import Book, BudgetMonitor, Portfolio, Rec, RunAbort, contract_value, js_round, make_rng
from otmaker import MAX_RESTING, MakerBook


def write_all(fd, data, write=os.write):
    """Write all of data to fd, looping over short writes.

    os.write may write less than requested. Under gVisor, pipe writes over
    64 KB return 65536; an unchecked write can truncate a large result line."""
    view = memoryview(data)
    while view:
        try:
            n = write(fd, view)
        except BlockingIOError:
            # Import here because select cannot wait on Windows pipes. Local Python
            # backtests import this module but do not write to file descriptors.
            import select
            select.select([], [fd], [])
            continue
        if n <= 0:
            # A zero-byte write leaves no usable result channel.
            raise OSError("short write to the result channel")
        view = view[n:]


HOOK_FOR = {"tick": "on_tick", "book": "on_book", "trade": "on_trade"}


# Store live books in a side table, not view attributes, to avoid exposing
# mutable engine ladders to strategies.
_BOOKS: dict[int, Book] = {}


class BookView:
    """A read-only view of a book, the mirror of bookView() in replay.mjs."""

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

    def quote_ts(self, side):
        """When each best level was last set (exchange time); None when empty."""
        return Rec(_BOOKS[id(self)].quote_ts(side))


# Keep engine state in a side table rather than on Ctx attributes.
# This is defence in depth, not a Python isolation boundary. The analyser
# also rejects reflection and dunder access; __getattr__ rejects private names.
_INTERNALS: dict[int, dict] = {}


# Keep in sync with LIMITS.logLineChars and LIMITS.logBytesPerRun in
# api/lib/backtest-contract.mjs.
LOG_LINE_CHARS = 512
LOG_BYTES_PER_RUN = 2 * 1024 * 1024


# Bound cross-check output on the shared result line. Settlement claims are
# expected once per market. Keep in sync with replay.mjs.
MAX_CROSSCHECKS_PER_MARKET = 16
CROSSCHECK_CLAIMED_CHARS = 32


def make_log_budget(bytes_: int = LOG_BYTES_PER_RUN, line_chars: int = LOG_LINE_CHARS) -> dict:
    """A log allowance for one run, shared by every market in it."""
    return {"bytes": bytes_, "line_chars": line_chars, "spent": 0}


# The settlement window ctx.twap_locked() reads, and when its projection is
# withheld. Keep in sync with replay.mjs.
TWAP_LOOKBACK_MS = {"twap30s": 30_000, "twap60s": 60_000}
SPOT_MIN_COVERAGE = 0.8
SPOT_MAX_AGE_MS = 5000


def _need_spot(ctx, what) -> None:
    """Refused unless the spot dataset was declared, needSpot in replay.mjs."""
    if not _INTERNALS[id(ctx)]["spot"]["declared"]:
        raise RunAbort("E_MANIFEST", f'{what} needs the "spot" dataset declared in the manifest')


def _push_spot(state, ev, arrived_at) -> None:
    """A spot event reaches the strategy at `arrived_at`, control.pushSpot in replay.mjs."""
    sp = state["spot"]
    sp["seen"] += 1
    sp["ts"].append(ev["ts_ms"])
    sp["val"].append(ev["value"])
    sp["arrived"].append(arrived_at)


class Ctx:
    """Strategy context with point-in-time accessors.

    Keep in sync with the JavaScript context in replay.mjs."""

    __slots__ = ("p", "market_id", "__weakref__")

    def __init__(self, params, portfolio, market_id, log_budget, references,
                 series, rng):
        # Rec supports both ctx.p.entry_z and subscript access, matching JS params.
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
            # Set by MarketReplay in global mode with on_timer: {schedule, unschedule}.
            "timers": None,
            # The spot dataset, see createCtx in replay.mjs. MarketReplay sets
            # the window; _push_spot updates the rest as spot events arrive.
            "spot": {"ts": [], "val": [], "arrived": [], "seen": 0,
                     "start": None, "close": None, "lookback": None, "declared": False},
        }

    @property
    def now(self):
        """Read-only: ctx.ref()/ctx.ext() use it as the point-in-time cursor,
        so a strategy that could assign it would read future rows."""
        return _INTERNALS[id(self)]["now"]

    def __getattr__(self, name):
        # Engine internals live in the side table; no private attribute exposes them.
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
        # Return copies so strategies cannot rewrite indicator history.
        return [Rec(row) for row in hist[len(hist) - k:]]

    def position(self) -> dict:
        s = _INTERNALS[id(self)]
        return s["pf"].position(self.market_id, s["book"])

    def log(self, msg: Any) -> None:
        # Share the byte allowance across the run. Keep in sync with ctx.log in replay.mjs.
        s = _INTERNALS[id(self)]
        budget = s["log_budget"]
        if budget["spent"] >= budget["bytes"]:
            s["log_truncated"] = True
            return
        line = f'{s["now"]} {msg}'[: budget["line_chars"]]
        # Count UTF-8 bytes for the run budget and characters for the line cap.
        # Keep in sync with the JS logger.
        budget["spent"] += len(line.encode("utf-8")) + 1
        s["logs"].append(line)

    def random(self, seed: int | None = None):
        return _INTERNALS[id(self)]["rng"](seed)

    def orders(self) -> list:
        """This market's resting orders that are not final yet: copies, and no
        queue position. Mirrors ctx.orders() in replay.mjs."""
        r = _INTERNALS[id(self)]["resting"]
        return [Rec(v) for v in r["orders"]()] if r else []

    def schedule(self, at_ms, tag=None):
        """Wake on_timer at `at_ms`; returns the timer id. Keep in sync with ctx.schedule in replay.mjs."""
        t = _INTERNALS[id(self)]["timers"]
        if t is None:
            raise RunAbort("E_MANIFEST", "ctx.schedule needs the on_timer hook declared in the manifest")
        return t["schedule"](at_ms, tag)

    def unschedule(self, timer_id) -> bool:
        t = _INTERNALS[id(self)]["timers"]
        return t["unschedule"](timer_id) if t is not None else False

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

    def spot(self):
        """The latest spot value that has reached the strategy, as
        {value, ts_ms}, or None. Needs the `spot` dataset. See replay.mjs."""
        _need_spot(self, "ctx.spot()")
        st = _INTERNALS[id(self)]
        sp = st["spot"]
        k = bisect.bisect_right(sp["arrived"], st["now"])
        return None if k == 0 else Rec({"value": sp["val"][k - 1], "ts_ms": sp["ts"][k - 1]})

    def twap_locked(self):
        """The elapsed part of the settlement TWAP window, from the spot values
        seen in it, an approximation; field by field in replay.mjs."""
        _need_spot(self, "ctx.twap_locked()")
        st = _INTERNALS[id(self)]
        sp = st["spot"]
        now = st["now"]
        if sp["start"] is None or now < sp["start"]:
            return None
        ts_list, val_list = sp["ts"], sp["val"]
        k = bisect.bisect_right(sp["arrived"], now)
        total = 0.0
        n = 0
        prev = None
        for i in range(bisect.bisect_right(ts_list, sp["start"] - 1), k):
            ts = ts_list[i]
            if ts >= sp["close"] or ts == prev:
                continue
            total += val_list[i]
            n += 1
            prev = ts
        if n == 0:
            return None
        lookback = sp["lookback"]
        elapsed = min(max(now - sp["start"], 0), lookback)
        value = total / n
        fraction = elapsed / lookback
        coverage = min(1.0, n / max(1, elapsed // 1000))
        last_ts, last_val = ts_list[k - 1], val_list[k - 1]
        fresh = now - last_ts <= SPOT_MAX_AGE_MS
        return Rec({
            "value": value,
            "samples": n,
            "elapsed_ms": elapsed,
            "elapsed_fraction": fraction,
            "coverage": coverage,
            "last_ts_ms": last_ts,
            "projected": (fraction * value + (1 - fraction) * last_val
                          if coverage >= SPOT_MIN_COVERAGE and fresh else None),
        })

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
        """Record an outcome cross-check without failing the run on a mismatch.

        The market argument is ignored; use the engine's market id and official
        outcome. Keep in sync with replay.mjs."""
        s = _INTERNALS[id(self)]
        official = (s["market"] or {}).get("outcome")
        # Bound claims and their values before serialising the shared result line.
        # Keep in sync with replay.mjs.
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
    """Market replay state machine: open, step per event, close.

    Market mode drives one instance at a time; session mode interleaves open
    markets in event-time order with shared strategy state.
    Keep in sync with MarketReplay in runner/engine/replay.mjs."""

    def __init__(self, *, market: dict, strategy, hooks: dict,
                 portfolio: Portfolio | None = None, fill_delay_ms: int = 0,
                 log_budget: dict | None = None, budget: BudgetMonitor | None = None,
                 references=None, series=None, seed: int = 1,
                 fee_bps: float = 0, resting: dict | None = None, terminal=None, engine=None,
                 clock: dict | None = None, record_budget: dict | None = None, stream=None,
                 spot_declared: bool = False) -> None:
        self.market_id = market["market_id"]
        self.market = market
        # generic-data.mjs; see the matching comment in replay.mjs.
        self.generic = market.get("kind") == "generic"
        self.terminal = terminal if self.generic else None
        # Use attribute-access records for hooks. Strip outcome before settlement
        # to prevent look-ahead; only on_settle receives it.
        if self.generic:
            self._market_rec = Rec(generic_view(market))
            settle = generic_view(market)
            settle["outcome"] = market.get("outcome")
            settle["resolved_ts_ms"] = market.get("resolved_ts_ms")
            self._settle_rec = Rec(settle)
        else:
            self._market_rec = Rec({k: v for k, v in market.items() if k != "outcome"})
            self._settle_rec = Rec(market)
        self.pf = portfolio if portfolio is not None else Portfolio(fee_bps=fee_bps, engine=engine)
        self.pf.set_market_fee(self.market_id, market.get("fee"))
        if self.generic:
            self.pf.set_market_labels(self.market_id, market.get("labels"))
            # Own data is not thinned: book_age counts archive markets only (replay.mjs).
            self.pf.exclude_book_age(self.market_id)
        self.engine = engine
        if engine and engine.get("order_rules"):
            self.pf.set_market_rules(self.market_id, market_rules(engine["order_rules"], market))
        if engine and engine.get("mirror_depth") == "shared" and (
                engine.get("mirror_markets") == "all" or market.get("book_model") == "single_mirrored"):
            self.pf.set_mirrored(self.market_id)
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
        self.state["spot"]["declared"] = bool(spot_declared)
        lookback = TWAP_LOOKBACK_MS.get(stream)
        close = market.get("close_ts_ms")
        if lookback is not None and close is not None:
            self.state["spot"].update(start=close - lookback, close=close, lookback=lookback)
        # Phase 2b global scheduler, see replay.mjs.
        self.global_ = isinstance(engine, dict) and engine.get("scheduler") == "global"
        self.job_seq = 0
        self.local_book = self.book
        if self.global_:
            fl = engine.get("feed_latency")
            self.feed_latency = fl if isinstance(fl, int) and not isinstance(fl, bool) and fl > 0 else 0
            if self.feed_latency > 0:
                self.local_book = Book(self.market_id)
                self.state["book"] = self.local_book
            self.timer_stats = {"created": 0, "fired": 0, "dropped": 0}
            self.timer_ids = 0
            # The run's clock {"t"}, advanced only by the harness, see replay.mjs.
            self.clock = clock if clock is not None else {"t": float("-inf")}
            if engine.get("timers") is True:
                self.state["timers"] = {"schedule": self._schedule_timer, "unschedule": self._unschedule_timer}
        self.state["view"] = BookView(self.local_book)
        self.state["resting"] = {"orders": self._orders_view, "cancel": self._request_cancel}
        # Resting-order policy; see the matching comment in replay.mjs.
        self.resting = resting
        cl = (resting or {}).get("cancelLatencyMs")
        self.cancel_latency_ms = cl if isinstance(cl, (int, float)) and not isinstance(cl, bool) \
            and cl == cl and cl not in (float("inf"), float("-inf")) else fill_delay_ms
        self.maker = MakerBook(self.market_id, self.pf, queue_prob=(engine or {}).get("queue_prob")) \
            if (resting or {}).get("allowed") else None
        self.pending: list[dict] = []
        # A market with no declared close has no cutoff; the last event seen
        # becomes the close, tracked as we go rather than peeked.
        self.declared_close = market.get("close_ts_ms")
        self.close_ts = self.declared_close if self.declared_close else float("inf")
        self.seen = 0
        self.last_ts = 0
        self.ended = False
        # Phase 3b recorder, see replay.mjs.
        rm = (engine or {}).get("record_ms")
        self.record_ms = rm if isinstance(rm, int) and not isinstance(rm, bool) and rm > 0 else None
        self.record_rows = [] if self.record_ms else None
        # The run's row budget, shared by every market, see replay.mjs.
        self.record_budget = ((record_budget if record_budget is not None
                               else {"rows": 0, "limit": math.inf, "truncated": False})
                              if self.record_ms else None)
        self.rec_next = None
        op = market.get("open_ts_ms")
        if self.record_ms and isinstance(op, (int, float)) and not isinstance(op, bool) and math.isfinite(op):
            self._record_start(op)
        if self.generic:
            self.trade_until = market.get("trade_until_ts_ms")
            self.close_ts = self.trade_until
            self.trading_ended = False
            self.closed = None
            self.marked = []

    def _schedule(self, at: int, kind: str, payload) -> None:
        i = len(self.pending)
        if self.global_:
            # Nothing lands before what the run has processed, see replay.mjs.
            if at < self.clock["t"]:
                at = self.clock["t"]
            rank = _JOB_RANK.get(kind, 0)
            while i > 0 and (self.pending[i - 1]["at"] > at
                             or (self.pending[i - 1]["at"] == at and self.pending[i - 1]["rank"] > rank)):
                i -= 1
            self.pending.insert(i, {"at": at, "kind": kind, "payload": payload, "rank": rank, "seq": self.job_seq})
            self.job_seq += 1
            return
        while i > 0 and self.pending[i - 1]["at"] > at:
            i -= 1
        self.pending.insert(i, {"at": at, "kind": kind, "payload": payload})

    def next_due(self):
        """Keep in sync with nextDue in replay.mjs."""
        if not self.pending:
            return None
        j = self.pending[0]
        return {"at": j["at"], "rank": j["rank"], "seq": j["seq"]}

    def run_one(self) -> None:
        """Keep in sync with runOne in replay.mjs."""
        if not self.pending:
            return
        job = self.pending.pop(0)
        if job["at"] > self.close_ts:
            if job["kind"] == "timer":
                self.timer_stats["dropped"] += 1
            return
        if job["at"] < self.clock["t"]:
            raise RunAbort("E_RUNTIME", f"engine invariant: a {job['kind']} at {job['at']} after the run reached {self.clock['t']}")
        # A spot value arriving is quiet here too, see runOne in replay.mjs.
        if job["kind"] == "arrival" and job["payload"].get("kind") == "spot":
            _push_spot(self.state, job["payload"], job["at"])
            return
        self._record_before(job["at"])
        self.state["now"] = job["at"]
        if job["kind"] == "timer":
            self.timer_stats["fired"] += 1
            if self.timer_stats["fired"] > MAX_TIMERS_FIRED:
                raise RunAbort("E_RUNTIME", f"more than {MAX_TIMERS_FIRED} timers fired in market {self.market_id}")
            t = job["payload"]
            if self.hooks.get("on_timer"):
                self._emit(self._call("on_timer", Rec({"id": t["id"], "at_ms": job["at"], "tag": t["tag"]})), job["at"])
            self._check_budget()
            return
        if job["kind"] == "arrival":
            self._arrive(job["payload"])
            return
        self._run_exchange_job(job)

    def _schedule_timer(self, at_ms, tag):
        # After the later of this market's now and the run's, see replay.mjs.
        now = max(self.state["now"], self.clock["t"])
        ok = isinstance(at_ms, int) and not isinstance(at_ms, bool) and abs(at_ms) <= 9007199254740991
        if isinstance(at_ms, float) and at_ms.is_integer() and abs(at_ms) <= 9007199254740991:
            at_ms, ok = int(at_ms), True
        if not ok or at_ms <= now:
            raise RunAbort("E_RUNTIME", f"ctx.schedule needs a whole-millisecond time after now ({now}), got {_js_json(at_ms)}")
        visible = self.market.get("trading_end_ts_ms") if self.generic else self.market.get("close_ts_ms")
        if visible is not None and at_ms > visible:
            raise RunAbort("E_RUNTIME", f"ctx.schedule({at_ms}) is after the market's close ({visible})")
        if tag is not None and not (isinstance(tag, str) and len(tag.encode("utf-16-le")) // 2 <= 64):
            raise RunAbort("E_RUNTIME", "a timer tag must be a string of at most 64 characters")
        if sum(1 for j in self.pending if j["kind"] == "timer") >= MAX_PENDING_TIMERS:
            raise RunAbort("E_RUNTIME", f"more than {MAX_PENDING_TIMERS} pending timers in market {self.market_id}")
        self.timer_stats["created"] += 1
        if self.timer_stats["created"] > MAX_TIMERS_CREATED:
            raise RunAbort("E_RUNTIME", f"more than {MAX_TIMERS_CREATED} timers scheduled in market {self.market_id}")
        self.timer_ids += 1
        tid = f"t{self.timer_ids}"
        self._schedule(at_ms, "timer", {"id": tid, "tag": tag})
        return tid

    def _unschedule_timer(self, timer_id) -> bool:
        for i, j in enumerate(self.pending):
            if j["kind"] == "timer" and j["payload"]["id"] == timer_id:
                del self.pending[i]
                return True
        return False

    def _arrive(self, ev) -> None:
        """A lagged event reaches the strategy. Keep in sync with #arrive in replay.mjs."""
        kind = ev.get("kind")
        if kind == "spot":
            _push_spot(self.state, ev, self.state["now"])
            return
        if kind == "book":
            apply_event(self.local_book, ev, self.generic)
        if kind == "tick":
            self.state["history"].append(Rec(ev))
        bbo = ev.get("bbo")
        hook = None if bbo else HOOK_FOR.get(kind)
        if hook and self.hooks.get(hook):
            self._emit(self._call(hook, Rec(ev)), self.state["now"])
        self._check_budget()

    def _drop_pending(self) -> None:
        if self.global_:
            self.timer_stats["dropped"] += sum(1 for j in self.pending if j["kind"] == "timer")
        self.pending.clear()

    def drain_until(self, ts) -> None:
        """Execute everything scheduled at or before `ts`, against this book."""
        while self.pending and self.pending[0]["at"] <= ts:
            job = self.pending.pop(0)
            if self.global_ and job["kind"] not in ("order", "activate", "cancel", "flatten"):
                if job["kind"] == "timer":
                    self.timer_stats["dropped"] += 1
                continue
            self._record_before(job["at"])
            self._run_exchange_job(job)

    def _run_exchange_job(self, job) -> None:
        if True:
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
        # Resolved now, to the record, see replay.mjs.
        rec = self.maker.find(order_id)
        # Asked now in the run's time, see replay.mjs.
        asked = max(self.state["now"], self.clock["t"]) if self.global_ else self.state["now"]
        if rec is None:
            self.maker.cancel(None, asked)
            return False
        self._schedule(asked + self.cancel_latency_ms, "cancel", rec)
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
            # A copy taken at decision time, see replay.mjs.
            row = dict(_as_order(order))
            side = row.get("side")
            if isinstance(side, str) and self.pf.side_of(side, self.market_id) is None:
                labels = self.pf.market_labels.get(self.market_id)
                extra = (" or an outcome of this market (" + ", ".join(_js_json(lb) for lb in labels) + ")") if labels else ""
                raise RunAbort("E_RUNTIME", f'order side {_js_json(side)} is not "UP" or "DOWN"{extra}')
            tif = row.get("tif")
            if tif is None:
                tif = "ioc"
            if tif == "fok":
                if not (self.engine and self.engine.get("fok")):
                    raise RunAbort("E_MANIFEST", 'tif "fok" needs "fok": true in the manifest')
                if row.get("post_only") is True or row.get("client_id") is not None:
                    raise RunAbort("E_MANIFEST", "post_only and client_id are for gtc orders, not fok")
                self._schedule(ts + self.fill_delay_ms, "order", row)
                continue
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

    def open(self, open_ts=None) -> None:
        if self.global_ and isinstance(open_ts, (int, float)) and not isinstance(open_ts, bool) \
                and open_ts == open_ts and open_ts not in (float("inf"), float("-inf")):
            self.state["now"] = open_ts
        self._call("on_market_open", self._market_rec)
        self._check_budget()

    def _record_start(self, ts) -> None:
        if self.rec_next is None:
            self.rec_next = math.ceil(ts / self.record_ms) * self.record_ms

    def _record_sample(self, g, final) -> bool:
        b = self.record_budget
        if b["truncated"]:
            return False
        if b["rows"] + 1 > b["limit"]:
            b["truncated"] = True
            return False
        b["rows"] += 1
        self.record_rows.append({
            "ts": g,
            "cash": self.pf.market_cash.get(self.market_id, 0),
            "marked": self.pf.market_marked.get(self.market_id, 0),
            "position_value": self.pf.liquidation_value(self.market_id, self.book),
            "final": final,
        })
        return True

    def _record_before(self, t) -> None:
        if not self.record_ms or self.rec_next is None:
            return
        while self.rec_next < t:
            if not self._record_sample(self.rec_next, False):
                self.rec_next = math.inf
                return
            self.rec_next += self.record_ms

    def _record_final(self, ts) -> None:
        if not self.record_ms:
            return
        self._record_start(ts)
        self._record_before(ts)
        if self.record_budget["truncated"]:
            return
        self._record_sample(ts, True)
        if self.rec_next == ts:
            self.rec_next += self.record_ms

    def step(self, ev) -> bool:
        """Apply one event. False once the market is past its close: nothing
        past the close reaches a hook, the book, or the history."""
        if self.ended:
            return False
        # quiet (the spot dataset), see step in replay.mjs.
        if ev.get("kind") == "spot":
            if ev["ts_ms"] > self.close_ts:
                return False
            if self.global_ and self.feed_latency > 0:
                self._schedule(ev["ts_ms"] + self.feed_latency, "arrival", ev)
            else:
                _push_spot(self.state, ev, ev["ts_ms"])
            return True
        self.seen += 1
        ts = ev["ts_ms"]
        self.last_ts = ts
        if ts > self.close_ts:
            self.ended = True
            return False
        state = self.state
        if self.record_ms:
            self._record_start(ts)
        # Everything scheduled strictly before this event resolves against the
        # book as it stood then. (Global mode: the harness scheduler did.)
        if not self.global_:
            self.drain_until(ts - 1)
        self._record_before(ts)
        state["now"] = ts
        maker = self.maker
        if maker is not None:
            maker.finalize(ts)
            maker.resolve_markouts(ts, self.book)

        kind = ev.get("kind")
        bbo = ev.get("bbo")
        if kind == "book":
            # Handle bounds before snapshots: snapshot:false bounds have no delta
            # ladder, price or size. Keep in sync with runner/engine/replay.mjs.
            def apply():
                apply_event(self.book, ev, self.generic)
            if maker is not None:
                maker.book_event(ev, self.book, apply)
            else:
                apply()
        elif kind == "trade" and maker is not None:
            maker.trade(ev, self.book)
        if not self.global_:
            self.drain_until(ts)
        if self.global_ and self.feed_latency > 0:
            self._schedule(ts + self.feed_latency, "arrival", ev)
            return True

        ev_rec = Rec(ev)
        if kind == "tick":
            # A separate copy from the one the hook is handed, see the
            # matching comment in replay.mjs.
            state["history"].append(Rec(ev))

        # Bounds refine the book without invoking hooks. They carry no depth;
        # the next hook sees the refined book. Keep in sync with replay.mjs.
        hook = None if bbo else HOOK_FOR.get(kind)
        if hook and self.hooks.get(hook):
            self._emit(self._call(hook, ev_rec), ts)
        self._check_budget()
        return True

    def end_trading(self) -> None:
        """Generic markets: trading ends. Keep in sync with endTrading in replay.mjs."""
        if not self.generic or self.trading_ended:
            return
        self.trading_ended = True
        self.ended = True
        ts = self.trade_until
        self.state["now"] = ts
        self.drain_until(ts)
        if self.maker is not None:
            self.maker.close(ts, self.book)
        self._drop_pending()
        self._record_before(ts)
        self.marked = [] if self.market.get("outcome") else self.pf.mark(self.market_id, self.terminal, ts)

    def _close_generic(self) -> dict:
        if self.closed is not None:
            return self.closed
        self.end_trading()
        state = self.state
        outcome = self.market.get("outcome")
        settle_ts = self.declared_close
        state["now"] = settle_ts
        settled = self.marked
        if self.close_now is not None and self.close_now > settle_ts:
            state["now"] = self.close_now
        if outcome:
            self._call("on_settle", self._settle_rec, outcome)
            self._record_before(settle_ts)
            settled = self.pf.settle(self.market_id, outcome, settle_ts)
        self._record_final(settle_ts)
        if self.maker is not None:
            self.maker.release_rows((lambda side: contract_value(side, outcome)) if outcome else None)
        view = state.pop("view", None)
        if view is not None:
            _BOOKS.pop(id(view), None)
        _INTERNALS.pop(id(self.ctx), None)
        self.closed = {
            "market_id": self.market_id,
            "asset": None,
            "events": self.seen,
            "spot_seen": self.state["spot"]["seen"],
            "settled": settled,
            "logs": state["logs"],
            "log_truncated": state["log_truncated"],
            "crosschecks": state["crosschecks"],
            "budget": self.monitor.summary(),
            "maker": self.maker.stats if self.maker is not None else None,
            "timers": self.timer_stats if self.global_ else None,
            **({"record": self.record_rows} if self.record_ms else {}),
        }
        return self.closed

    def close(self, now_ts=None) -> dict:
        self.close_now = now_ts if (self.global_ and isinstance(now_ts, (int, float))
                                    and not isinstance(now_ts, bool) and now_ts == now_ts) else None
        if self.generic:
            return self._close_generic()
        state = self.state
        # Clamp queued work to the close. Keep in sync with replay.mjs.
        settle_ts = self.declared_close if self.declared_close else self.last_ts
        state["now"] = settle_ts
        self.drain_until(settle_ts)
        if self.maker is not None:
            self.maker.close(settle_ts, self.book)
        self._drop_pending()

        market = self.market
        if self.close_now is not None and self.close_now > settle_ts:
            state["now"] = self.close_now
        self._call("on_settle", self._settle_rec, market.get("outcome"))
        outcome = market.get("outcome")
        self._record_before(settle_ts)
        settled = self.pf.settle(self.market_id, market["outcome"], settle_ts) if outcome else []
        self._record_final(settle_ts)
        if self.maker is not None:
            self.maker.release_rows((lambda side: contract_value(side, outcome)) if outcome else None)

        view = state.pop("view", None)
        if view is not None:
            _BOOKS.pop(id(view), None)
        _INTERNALS.pop(id(self.ctx), None)

        return {
            "market_id": self.market_id,
            "asset": market.get("asset"),
            # Count events consumed by replay. Keep in sync with replay.mjs.
            "events": self.seen,
            "spot_seen": self.state["spot"]["seen"],
            "settled": settled,
            "logs": state["logs"],
            "log_truncated": state["log_truncated"],
            "crosschecks": state["crosschecks"],
            "budget": self.monitor.summary(),
            "maker": self.maker.stats if self.maker is not None else None,
            "timers": self.timer_stats if self.global_ else None,
            **({"record": self.record_rows} if self.record_ms else {}),
        }


# Same-millisecond order of a market's jobs in global mode. Keep in sync with replay.mjs.
_JOB_RANK = {"order": 0, "activate": 0, "cancel": 0, "flatten": 0, "arrival": 1, "timer": 2}
MAX_PENDING_TIMERS = 64
MAX_TIMERS_CREATED = 10_000
MAX_TIMERS_FIRED = 100_000


def apply_event(book, ev, generic) -> None:
    """Keep in sync with applyEvent in replay.mjs."""
    ts = ev["ts_ms"]
    if ev.get("bbo"):
        book.bbo(ts, ev.get("side"), ev.get("bid"), ev.get("ask"), generic)
    elif ev.get("snapshot"):
        book.snapshot(ts, ev.get("levels") or {})
    elif generic and ev.get("mirror") is True:
        book.delta_mirrored(ts, ev.get("side"), ev.get("ladder"), ev.get("px"), ev.get("size"))
    else:
        book.delta(ts, ev.get("side"), ev.get("ladder"), ev.get("px"), ev.get("size"))


def market_rules(rules: dict, market: dict) -> dict:
    """Keep in sync with marketRules in replay.mjs."""
    venue = rules.get("mode") == "venue"
    tick = market.get("tick_size") if venue else rules.get("tick")
    min_size = market.get("min_size") if venue else rules.get("min_size")
    ok_num = lambda v: isinstance(v, (int, float)) and not isinstance(v, bool) and v == v and v not in (float("inf"), float("-inf"))  # noqa: E731
    tick_ticks = js_round(tick * 10_000) if ok_num(tick) else None
    if (not ok_num(tick) or not tick > 0 or tick_ticks is None or not tick_ticks >= 1
            or abs(tick_ticks - tick * 10_000) > 1e-6 or not ok_num(min_size) or not min_size > 0):
        raise RunAbort("E_RUNTIME", f"market {market.get('market_id')}: order_rules need a tick on a 0.0001 grid "
                                    "and a positive minimum size")
    return {"tickTicks": tick_ticks, "minSize": min_size}


_GENERIC_VIEW = (
    "market_id", "kind", "venue", "question", "slug", "token_ids", "labels", "fee",
    "tick_size", "min_size", "trading_end_ts_ms", "open_ts_ms",
)


def generic_view(market: dict) -> dict:
    """A deep copy of a generic market's whitelist. Keep in sync with genericView in replay.mjs."""
    out = {}
    for k in _GENERIC_VIEW:
        v = market.get(k)
        out[k] = None if v is None else (json.loads(json.dumps(v)) if isinstance(v, (dict, list)) else v)
    out["close_ts_ms"] = market.get("trading_end_ts_ms")
    return out


def replay_market(*, market: dict, events, strategy, hooks: dict,
                  portfolio: Portfolio | None = None, fill_delay_ms: int = 0,
                  log_budget: dict | None = None, budget: BudgetMonitor | None = None,
                  references=None, series=None, seed: int = 1,
                  fee_bps: float = 0, resting: dict | None = None) -> dict:
    """Replay one market start to finish.

    events is any iterable, including a generator reading stdin per step.
    Do not index it or request its length; replay consumes it incrementally.
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
