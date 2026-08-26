"""The matching engine, ported from runner/engine/*.mjs.

Why a port and not a call: the per-event budget is 400 microseconds, and an IPC
round trip per event over hundreds of millions of events is not close to
affordable. So Python strategies get a Python engine.

Two implementations of the same rules is a drift risk, and the mitigation is
runner/conformance: golden vectors generated from the JavaScript engine that
BOTH harnesses must reproduce exactly. If you change anything in here, change
the JavaScript too and regenerate the vectors — a report that depends on which
language the customer wrote in is worthless.

The one subtle thing is rounding. JavaScript's Math.round breaks ties upward
(Math.round(0.5) == 1, Math.round(-0.5) == -0) while Python's round() uses
banker's rounding (round(0.5) == 0). Prices are quantised through this, so
using the native round here would put fills on a different tick than the
JavaScript engine for every exact half. js_round below is the compatible one and
is the only rounding this module uses.
"""

from __future__ import annotations

import math

from typing import Any, Callable, Iterable

SIDES = ("UP", "DOWN")
PRICE_SCALE = 10_000
EPS = 1e-9


class Rec(dict):
    """A record a strategy reads with attribute access.

    The SDK documents `tick.value`, `market.strike` and `pos.size` — the same
    spelling in both languages. Events arrive from JSON as dicts, so without
    this a Python strategy written straight from the docs fails with
    "'dict' object has no attribute 'value'" on its first tick, while the
    identical JavaScript works. That is an API-parity break, not a papercut.

    Subscript access still works, so a strategy written either way is fine.
    """

    __slots__ = ()

    def __getattr__(self, name):
        try:
            return self[name]
        except KeyError:
            raise AttributeError(
                f"{name!r} is not on this record; it has {', '.join(sorted(self))}"
            ) from None

    def __setattr__(self, name, value):
        self[name] = value


def js_round(x: float) -> int:
    """Math.round from JavaScript: ties go toward +Infinity, not to even.

    Not a stylistic choice. round(0.5) is 0 in Python and 1 in JavaScript, so
    the native function would quantise a price landing exactly on a half-tick to
    a different level than the JS engine — a silent, data-dependent divergence
    in what fills.
    """
    return math.floor(x + 0.5)


def to_ticks(px: float) -> int:
    return js_round(px * PRICE_SCALE)


def from_ticks(t: int) -> float:
    return t / PRICE_SCALE


class Ladder:
    """One side of one outcome token's book.

    `direction` is which way "better" runs: +1 for asks (cheapest first), -1 for
    bids (dearest first).
    """

    __slots__ = ("direction", "levels")

    def __init__(self, direction: int) -> None:
        self.direction = direction
        self.levels: list[list[int | float]] = []  # [ticks, size], best first

    def _worse(self, a: int, b: int) -> int:
        return (a - b) if self.direction > 0 else (b - a)

    def reset(self, levels: Iterable[Any]) -> None:
        rows = []
        for entry in levels or ():
            px, size = entry[0], float(entry[1])
            if size > 0:
                rows.append([to_ticks(float(px)), size])
        rows.sort(key=lambda r: r[0] * (1 if self.direction > 0 else -1))
        self.levels = rows

    def apply(self, px: float, size: float) -> None:
        ticks = to_ticks(float(px))
        n = float(size)
        for i, level in enumerate(self.levels):
            if level[0] == ticks:
                if n > 0:
                    level[1] = n
                else:
                    self.levels.pop(i)
                return
        if not n > 0:
            return
        j = len(self.levels)
        while j > 0 and self._worse(self.levels[j - 1][0], ticks) > 0:
            j -= 1
        self.levels.insert(j, [ticks, n])

    def best(self) -> float | None:
        return from_ticks(self.levels[0][0]) if self.levels else None

    def depth(self, bound: float | None = None) -> float:
        cap = None if bound is None else to_ticks(float(bound))
        total = 0.0
        for ticks, size in self.levels:
            if cap is not None and self._worse(ticks, cap) > 0:
                break
            total += size
        return total

    def view(self, n: int = 10) -> list[list[float]]:
        return [[from_ticks(t), s] for t, s in self.levels[:n]]

    def take(self, size: float, bound: float | None):
        cap = None if bound is None else to_ticks(float(bound))
        fills: list[dict[str, float]] = []
        remaining = float(size)
        notional = 0.0
        while remaining > 0 and self.levels:
            level = self.levels[0]
            if cap is not None and self._worse(level[0], cap) > 0:
                break
            take = min(remaining, level[1])
            px = from_ticks(level[0])
            fills.append({"px": px, "size": take})
            notional += px * take
            remaining -= take
            level[1] -= take
            if level[1] <= 0:
                self.levels.pop(0)
        return fills, remaining, notional


class Book:
    """A binary market: two outcome tokens, each with bids and asks."""

    __slots__ = ("market_id", "ts", "ladders")

    def __init__(self, market_id: str) -> None:
        self.market_id = market_id
        self.ts = 0
        self.ladders = {
            side: {"asks": Ladder(1), "bids": Ladder(-1)} for side in SIDES
        }

    def snapshot(self, ts: int, levels: dict[str, Any]) -> None:
        self.ts = ts
        for side in SIDES:
            spec = (levels or {}).get(side)
            if not spec:
                continue
            self.ladders[side]["asks"].reset(spec.get("asks"))
            self.ladders[side]["bids"].reset(spec.get("bids"))

    def delta(self, ts: int, side: str, kind: str, px: float, size: float) -> None:
        self.ts = ts
        if side not in SIDES:
            raise ValueError(f"unknown side {side}")
        if kind not in ("asks", "bids"):
            raise ValueError(f"unknown ladder {kind}")
        self.ladders[side][kind].apply(px, size)

    def best(self, side: str) -> float | None:
        """The price to BUY that outcome at — the best ask."""
        lad = self.ladders.get(side)
        return lad["asks"].best() if lad else None

    def best_bid(self, side: str) -> float | None:
        lad = self.ladders.get(side)
        return lad["bids"].best() if lad else None

    def depth(self, side: str, bound: float | None = None) -> float:
        lad = self.ladders.get(side)
        return lad["asks"].depth(bound) if lad else 0.0

    def bid_depth(self, side: str, bound: float | None = None) -> float:
        lad = self.ladders.get(side)
        return lad["bids"].depth(bound) if lad else 0.0

    def levels(self, side: str, n: int = 10):
        lad = self.ladders.get(side)
        return lad["asks"].view(n) if lad else []

    def bid_levels(self, side: str, n: int = 10):
        lad = self.ladders.get(side)
        return lad["bids"].view(n) if lad else []

    def mid(self, side: str) -> float | None:
        a, b = self.best(side), self.best_bid(side)
        return None if a is None or b is None else (a + b) / 2


def match_order(book: Book, order: dict) -> dict:
    """Match a taker order, consuming what it takes.

    `limit` is a ceiling when opening and a floor when reducing — a bound in
    whichever direction protects the trader.
    """
    size = float(order.get("size") or 0)
    reducing = bool(order.get("reduce_only"))
    side = order.get("side")
    blank = {
        "fills": [], "filled": 0.0, "unfilled": max(0.0, size),
        "notional": 0.0, "avg_px": None, "worst_px": None,
        "quoted_px": None, "reduce_only": reducing,
    }
    if side not in SIDES or not size > 0:
        return blank

    ladder = book.ladders[side]["bids" if reducing else "asks"]
    quoted = ladder.best()
    fills, remaining, notional = ladder.take(size, order.get("limit"))
    # SUMMED FROM WHAT WAS TAKEN, not derived as `size - remaining`. Mirrors
    # book.mjs: `remaining` is the requested size with each level subtracted
    # from it, and at float precision 1e308 - 1000 is still 1e308 -- so a huge
    # but finite order consumed the whole ladder while reporting filled 0. No
    # position, no cash, no trade row, and an empty book for everything after
    # it. Adding up the levels taken cannot drift from what was removed.
    filled = sum(f["size"] for f in fills)
    return {
        "fills": fills,
        "filled": filled,
        "unfilled": remaining,
        "notional": notional,
        "avg_px": (notional / filled) if filled > 0 else None,
        "worst_px": fills[-1]["px"] if fills else None,
        "quoted_px": quoted,
        "reduce_only": reducing,
    }


def contract_value(side: str, outcome: str) -> int:
    return 1 if outcome == side else 0


class Leg:
    """One side of one market, plus the round trip in progress."""

    __slots__ = ("side", "size", "cost", "entry_size", "entry_notional",
                 "exit_size", "exit_notional", "realised", "fees", "entry_ts")

    def __init__(self, side: str) -> None:
        self.side = side
        self.size = 0.0
        self.cost = 0.0
        self.reset()

    def reset(self) -> None:
        self.entry_size = 0.0
        self.entry_notional = 0.0
        self.exit_size = 0.0
        self.exit_notional = 0.0
        self.realised = 0.0
        self.fees = 0.0
        self.entry_ts = None

    @property
    def avg_entry(self):
        return (self.cost / self.size) if self.size > EPS else None

    @property
    def trade_entry_px(self):
        return (self.entry_notional / self.entry_size) if self.entry_size > EPS else None

    @property
    def trade_exit_px(self):
        return (self.exit_notional / self.exit_size) if self.exit_size > EPS else None


class Portfolio:
    def __init__(self, fee_bps: float = 0) -> None:
        self.fee_bps = float(fee_bps or 0)
        self.legs: dict[str, dict[str, Leg]] = {}
        self.trades: list[dict] = []
        self.fills: list[dict] = []
        self.cash = 0.0
        self.fees_paid = 0.0
        self.rejected = 0

    def _legs(self, market_id: str) -> dict[str, Leg]:
        legs = self.legs.get(market_id)
        if legs is None:
            legs = {"UP": Leg("UP"), "DOWN": Leg("DOWN")}
            self.legs[market_id] = legs
        return legs

    def size_of(self, market_id: str, side: str) -> float:
        return self._legs(market_id)[side].size

    def position(self, market_id: str, book: Book | None = None) -> dict:
        legs = self._legs(market_id)
        realised = legs["UP"].realised + legs["DOWN"].realised
        open_legs = [leg for leg in (legs["UP"], legs["DOWN"]) if leg.size > EPS]
        if not open_legs:
            return Rec(side=None, size=0.0, avg_entry=None,
                       unrealised=0.0, realised=realised, both=False)
        if len(open_legs) == 1:
            lead = open_legs[0]
        else:
            lead = legs["UP"] if legs["UP"].size >= legs["DOWN"].size else legs["DOWN"]
        # Marked against the BID: the bid is where the position could actually
        # be closed. Marking at the ask reports a profit that cannot be taken.
        mark = book.best_bid(lead.side) if book else None
        unrealised = 0.0 if mark is None else (mark - lead.avg_entry) * lead.size
        return Rec(side=lead.side, size=lead.size, avg_entry=lead.avg_entry,
                   unrealised=unrealised, realised=realised,
                   both=len(open_legs) == 2)

    def execute(self, book: Book, order: dict, ts: int, market_id: str,
                tag: str | None = None, how: str = "exit"):
        if not isinstance(order, dict) or order.get("side") not in SIDES:
            self.rejected += 1
            return None

        leg = self._legs(market_id)[order["side"]]

        # ONE PLACE THAT DECIDES WHETHER AN ORDER IS USABLE.
        # Mirrors portfolio.mjs line for line -- see the reasoning there. Every
        # unusable order is COUNTED AND RETURNS None, never raised: ValueError
        # or OverflowError here would turn "reject one order" into "fail the
        # whole run", which is the same input producing two different outcomes
        # in two engines that are supposed to be one engine.
        def _finite(v):
            # A NUMBER, not something float() is willing to turn into one.
            # Mirrors portfolio.mjs: coercion is not validation, and the two
            # languages coerce differently -- float("10") and Number("10") both
            # give 10, but float([10]) raises where Number([10]) gives 10. One
            # strategy, one input, two outcomes.
            if isinstance(v, bool) or not isinstance(v, (int, float)):
                return None
            f = float(v)
            return f if math.isfinite(f) else None

        has_size = order.get("size") is not None
        has_notional = order.get("notional") is not None
        if has_size == has_notional:
            self.rejected += 1
            return None

        limit = None
        if order.get("limit") is not None:
            limit = _finite(order.get("limit"))
            if limit is None or limit < 0 or limit > 1:
                self.rejected += 1
                return None

        if has_notional:
            budget = _finite(order.get("notional"))
            if budget is None or budget <= 0 or limit is None or limit <= 0:
                self.rejected += 1
                return None
            # The QUOTIENT can overflow from two finite inputs: 1e308 / 0.01 is
            # inf, and math.floor(inf) raises. Checked before the floor.
            #
            # floor(a / b), NOT a // b: Python's float floor-division is not
            # the same function -- 80 // 0.64 is 124 where Math.floor(80 / 0.64)
            # is 125, and 1 // 0.1 is 9.
            q = budget / limit
            if not math.isfinite(q):
                self.rejected += 1
                return None
            size = float(math.floor(q))
        else:
            size = _finite(order.get("size"))
        if size is None or not size > 0:
            self.rejected += 1
            return None
        if order.get("reduce_only"):
            size = min(size, leg.size)
            if not size > EPS:
                self.rejected += 1
                return None

        # One effective order from here on -- AFTER the reduce_only clamp, so
        # the row reports what was actually requested of the book rather than
        # what the strategy asked for before clamping. The derived size has to
        # reach the fill row as well as the match: it did not, and a
        # notional-only order produced a row whose `requested` was NaN, which
        # the parser dropped. The fill happened; only its record vanished.
        # Mirrors portfolio.mjs.
        order = {**order, "size": size, "limit": limit}

        res = match_order(book, order)
        if res["filled"] <= 0:
            self.fills.append(self._fill_row(ts, market_id, order, res, tag, 0.0, 0.0))
            return res

        fee = (res["notional"] * self.fee_bps) / 10_000
        self.fees_paid += fee
        realised = 0.0

        if order.get("reduce_only"):
            basis = leg.avg_entry or 0.0
            realised = res["notional"] - basis * res["filled"] - fee
            leg.size -= res["filled"]
            leg.cost -= basis * res["filled"]
            if leg.size <= EPS:
                leg.size = 0.0
                leg.cost = 0.0
            leg.realised += realised
            leg.fees += fee
            leg.exit_size += res["filled"]
            leg.exit_notional += res["notional"]
            self.cash += res["notional"] - fee
            if leg.size == 0.0:
                self._close_trade(market_id, leg, ts, how)
        else:
            if leg.size <= EPS and leg.entry_ts is None:
                leg.entry_ts = ts
            leg.size += res["filled"]
            leg.cost += res["notional"]
            leg.entry_size += res["filled"]
            leg.entry_notional += res["notional"]
            leg.fees += fee
            # The ENTRY fee belongs in the round trip's realised PnL — see the
            # matching comment in portfolio.mjs. Both engines or neither.
            leg.realised -= fee
            self.cash -= res["notional"] + fee

        self.fills.append(self._fill_row(ts, market_id, order, res, tag, realised, fee))
        return res

    def _fill_row(self, ts, market_id, order, res, tag, realised, fee) -> dict:
        return {
            "ts_ms": ts,
            "market_id": market_id,
            "side": order.get("side"),
            "action": "reduce" if order.get("reduce_only") else "open",
            "requested": float(order.get("size") or 0),
            "filled": res["filled"],
            "unfilled": res["unfilled"],
            "avg_px": res["avg_px"],
            "worst_px": res["worst_px"],
            "quoted_px": res["quoted_px"],
            "levels_walked": len(res["fills"]),
            "fee": fee,
            "realised": realised,
            "tag": tag if tag is not None else order.get("tag"),
        }

    def _close_trade(self, market_id, leg: Leg, ts, how, **extra) -> None:
        row = {
            "market_id": market_id,
            "side": leg.side,
            "size": leg.exit_size,
            "entry_px": leg.trade_entry_px,
            "exit_px": leg.trade_exit_px,
            "pnl": leg.realised,
            "fees": leg.fees,
            "opened_ms": leg.entry_ts,
            "closed_ms": ts,
            "how": how,
        }
        row.update(extra)
        self.trades.append(row)
        leg.reset()

    def settle(self, market_id: str, outcome: str, ts: int) -> list[dict]:
        legs = self.legs.get(market_id)
        if not legs:
            return []
        closed = []
        for side in SIDES:
            leg = legs[side]
            if leg.size <= EPS:
                continue
            # Priced at $1/$0: a binary market's terminal value is a fact, not
            # a quote. No fee — nothing is traded, the market pays out.
            value = contract_value(side, outcome) * leg.size
            leg.realised += value - leg.cost
            leg.exit_size += leg.size
            leg.exit_notional += value
            self.cash += value
            before = len(self.trades)
            self._close_trade(market_id, leg, ts, "settled", outcome=outcome)
            closed.append(self.trades[before])
            leg.size = 0.0
            leg.cost = 0.0
        return closed

    def flatten(self, market_id: str, book: Book, ts: int, how: str = "hold_expired") -> None:
        legs = self.legs.get(market_id)
        if not legs:
            return
        for side in SIDES:
            leg = legs[side]
            if leg.size <= EPS:
                continue
            self.execute(
                book,
                {"side": side, "size": leg.size, "limit": None, "reduce_only": True},
                ts, market_id, tag=how, how=how,
            )

    def equity(self, books: dict[str, Book] | None = None) -> float:
        open_value = 0.0
        for market_id, legs in self.legs.items():
            book = (books or {}).get(market_id)
            for side in SIDES:
                leg = legs[side]
                if leg.size <= EPS:
                    continue
                mark = book.best_bid(side) if book else None
                open_value += leg.cost if mark is None else mark * leg.size
        return self.cash + open_value


class RunAbort(Exception):
    def __init__(self, code: str, detail: str) -> None:
        super().__init__(detail)
        self.code = code
        self.detail = detail


class BudgetMonitor:
    """Per-event budget. The mirror of BudgetMonitor in engine/replay.mjs.

    SUSTAINED cost, which is what the limit is for and what customers are told
    it means. The mean, not the tail.

    This judged the breach rate against a 1% tolerance, and it was measuring the
    wrong machine: the budget brackets each hook with two wall-clock reads, on a
    2-core box where the worker decompresses and feeds stdin the whole time, so
    an event that gets descheduled is recorded as an event the strategy spent
    4ms in. Measured inside the real image, the same strategy averages 7.8us on
    an idle host and 20.9us under contention, with worst cases of 766us and
    4090us. Nothing about the strategy changed.

    The page's own sample was rejected in production at avg 72us, a fifth of its
    400us budget, because 1.1% of its events had been interrupted -- and those
    breaches were scattered (events 171, 2368, 3201), not front-loaded, so no
    warm-up floor could have fixed it.

    The mean predicts the thing this protects: the 20-minute wall clock is mean
    times event count. A hook that never returns is caught by the run deadline,
    which is where that belongs.

    Windowed, not lifetime: one monitor covers the whole run, so a lifetime mean
    lets a cheap prefix pay for an expensive phase.
    """

    def __init__(self, limit_micros: float = 400, sample_floor: int = 2000) -> None:
        self.limit_micros = limit_micros
        self.sample_floor = sample_floor
        self.count = 0
        self.breaches = 0
        self.max_micros = 0.0
        self.total_micros = 0.0
        # The most recent sample_floor events, as a ring. One monitor covers the
        # whole run, so a lifetime mean is diluted by everything that came
        # before: 18,000 events at 8us then 2,000 at 2,000us averages 207us and
        # passes, while the last two thousand are continuously 5x over budget.
        self._window = [0.0] * sample_floor
        self._window_sum = 0.0
        self._window_at = 0

    def record(self, micros: float) -> None:
        self.count += 1
        self.total_micros += micros
        if micros > self.max_micros:
            self.max_micros = micros
        if micros > self.limit_micros:
            self.breaches += 1
        self._window_sum += micros - self._window[self._window_at]
        self._window[self._window_at] = micros
        self._window_at = (self._window_at + 1) % len(self._window)

    @property
    def window_micros(self) -> float:
        """Mean of the most recent sample_floor events. Zero until it fills."""
        if self.count < self.sample_floor:
            return 0.0
        return self._window_sum / len(self._window)

    @property
    def breached(self) -> bool:
        return self.count >= self.sample_floor and self.window_micros > self.limit_micros

    def summary(self) -> dict:
        return {
            "events": self.count,
            "breaches": self.breaches,
            "breach_rate": (self.breaches / self.count) if self.count else 0,
            "avg_micros": (self.total_micros / self.count) if self.count else 0,
            # The number the verdict is made on. Without it a rejection shows a
            # lifetime average inside budget and reads as a lie.
            "window_micros": self.window_micros,
            "window_events": self.sample_floor,
            "max_micros": self.max_micros,
            "limit_micros": self.limit_micros,
        }


def make_rng(run_seed: int) -> Callable[[int | None], Callable[[], float]]:
    """splitmix32, identical to the JavaScript implementation."""

    def factory(seed: int | None = None):
        state = (run_seed if seed is None else int(seed)) & 0xFFFFFFFF

        def nxt() -> float:
            nonlocal state
            state = (state + 0x9E3779B9) & 0xFFFFFFFF
            z = state
            z = ((z ^ (z >> 16)) * 0x21F0AAAD) & 0xFFFFFFFF
            z = ((z ^ (z >> 15)) * 0x735A2D97) & 0xFFFFFFFF
            return ((z ^ (z >> 15)) & 0xFFFFFFFF) / 4294967296

        return nxt

    return factory
