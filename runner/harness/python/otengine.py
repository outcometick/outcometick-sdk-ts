"""Python matching engine. Keep in sync with runner/engine/*.mjs.

Matching runs in-process to avoid per-event IPC within the 400 us budget.
runner/conformance checks both implementations against shared vectors;
update the JavaScript implementation and vectors when changing rules.

Price quantisation uses JavaScript tie-breaking: Math.round rounds ties
toward positive infinity, while Python round uses half-even."""

from __future__ import annotations

import math
import operator

from typing import Any, Callable, Iterable

SIDES = ("UP", "DOWN")
PRICE_SCALE = 10_000
EPS = 1e-9


class Rec(dict):
    """Record supporting attribute and subscript access for strategy-visible data."""

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
    """Match JavaScript Math.round: ties go toward positive infinity."""
    # Avoid floor(x + 0.5), which can round the sum at half-tick boundaries
    # or odd integers above 2**52.
    f = math.floor(x)
    return f + 1 if x - f >= 0.5 else f


# Cache repeated price conversions by value, bounded to 65536 entries.
# The conversion is pure; exclude NaN because it cannot be a reusable key.
_TICKS: dict = {}
_first = operator.itemgetter(0)


def js_to_fixed10(x: float) -> float:
    """`Number(x.toFixed(10))`: ties away from zero on the exact binary value.

    Python round uses half-even; 1/2048 is a tie at ten decimal digits.
    Keep in sync with mirror() in events.mjs.
    """
    from decimal import Decimal, ROUND_HALF_UP
    return float(Decimal(x).quantize(Decimal(1).scaleb(-10), rounding=ROUND_HALF_UP)) + 0.0


def to_ticks(px: float) -> int:
    t = _TICKS.get(px)
    if t is None:
        t = js_round(px * PRICE_SCALE)
        if px == px and len(_TICKS) < 65536:
            _TICKS[px] = t
    return t


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
        # Best-first [ticks, size, ts] levels. ts is the archive update time;
        # pruning preserves same-millisecond levels to avoid ambiguous ordering.
        self.levels: list[list[int | float]] = []

    def _worse(self, a: int, b: int) -> int:
        return (a - b) if self.direction > 0 else (b - a)

    def reset(self, levels: Iterable[Any], ts: int = 0) -> None:
        rows = []
        for entry in levels or ():
            px, size = entry[0], float(entry[1])
            if size > 0:
                rows.append([to_ticks(float(px)), size, ts])
        # Best first. reverse=True keeps the sort stable (equal ticks stay in
        # archive order), same as negating the key did.
        rows.sort(key=_first, reverse=self.direction < 0)
        self.levels = rows

    def apply(self, px: float, size: float, ts: int = 0) -> None:
        ticks = to_ticks(float(px))
        n = float(size)
        for i, level in enumerate(self.levels):
            if level[0] == ticks:
                if n > 0:
                    level[1] = n
                    level[2] = ts
                else:
                    self.levels.pop(i)
                return
        if not n > 0:
            return
        j = len(self.levels)
        while j > 0 and self._worse(self.levels[j - 1][0], ticks) > 0:
            j -= 1
        self.levels.insert(j, [ticks, n, ts])

    def prune(self, bound: float | None, ts: int, inclusive: bool = False) -> int:
        """Remove levels better than bound and older than ts.

        Top-of-book bounds contain no sizes, so they can remove stale depth but
        cannot add liquidity. Strict age comparison preserves same-millisecond
        deltas regardless of tie order. inclusive enables same-time pruning for
        generic data, whose sequence order is known.
        Keep in sync with Ladder.prune in runner/engine/book.mjs."""
        # Require a number, excluding bool, to match JS Number.isFinite.
        if not isinstance(bound, (int, float)) or isinstance(bound, bool):
            return 0
        b = float(bound)
        if b != b or b in (float("inf"), float("-inf")):
            return 0
        # Reject bounds outside [0, 1] before pruning binary-token depth.
        if b < 0.0 or b > 1.0:
            return 0
        cap = to_ticks(b)
        kept = []
        removed = 0
        for level in self.levels:
            # `inclusive`: generic data only, see Ladder.prune in book.mjs.
            if self._worse(level[0], cap) < 0 and (level[2] <= ts if inclusive else level[2] < ts):
                removed += 1
                continue
            kept.append(level)
        if removed:
            self.levels = kept
        return removed

    def best_ts(self):
        """When the best level was last set, or None. Keep in sync with bestTs in book.mjs."""
        return self.levels[0][2] if self.levels else None

    def reduce_at(self, ticks: int, size: float) -> None:
        """Keep in sync with Ladder.reduceAt in book.mjs."""
        for i, level in enumerate(self.levels):
            if level[0] == ticks:
                level[1] -= min(size, level[1])
                if level[1] <= 0:
                    del self.levels[i]
                return

    def best(self) -> float | None:
        return from_ticks(self.levels[0][0]) if self.levels else None

    def depth(self, bound: float | None = None) -> float:
        cap = None if bound is None else to_ticks(float(bound))
        total = 0.0
        for ticks, size, _ts in self.levels:
            if cap is not None and self._worse(ticks, cap) > 0:
                break
            total += size
        return total

    def view(self, n: int = 10) -> list[list[float]]:
        return [[from_ticks(t), s] for t, s, _ts in self.levels[:n]]

    def size_at_ticks(self, ticks: int) -> float:
        """Visible size resting at exactly `ticks`, 0 when there is no such level."""
        for t, s, _ts in self.levels:
            if t == ticks:
                return s
        return 0

    def depth_better_ticks(self, ticks: int) -> float:
        """Visible size at prices strictly better than `ticks`."""
        total = 0
        for t, s, _ts in self.levels:
            if self._worse(t, ticks) >= 0:
                break
            total += s
        return total

    def pairs(self) -> list[list[float]]:
        """Best-first [ticks, size] pairs, what the maker ledger diffs across a book event."""
        return [[t, s] for t, s, _ts in self.levels]

    def take(self, size: float, bound: float | None):
        cap = None if bound is None else to_ticks(float(bound))
        fills: list[dict[str, float]] = []
        # When each consumed level was last set, parallel to fills (book_age).
        level_ts: list = []
        remaining = float(size)
        notional = 0.0
        while remaining > 0 and self.levels:
            level = self.levels[0]
            if cap is not None and self._worse(level[0], cap) > 0:
                break
            take = min(remaining, level[1])
            px = from_ticks(level[0])
            fills.append({"px": px, "size": take})
            level_ts.append(level[2])
            notional += px * take
            remaining -= take
            level[1] -= take
            if level[1] <= 0:
                self.levels.pop(0)
        return fills, remaining, notional, level_ts


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
            self.ladders[side]["asks"].reset(spec.get("asks"), ts)
            self.ladders[side]["bids"].reset(spec.get("bids"), ts)

    def delta(self, ts: int, side: str, kind: str, px: float, size: float) -> None:
        self.ts = ts
        if side not in SIDES:
            raise ValueError(f"unknown side {side}")
        if kind not in ("asks", "bids"):
            raise ValueError(f"unknown ladder {kind}")
        self.ladders[side][kind].apply(px, size, ts)

    def bbo(self, ts: int, side: str, bid: float | None, ask: float | None, inclusive: bool = False) -> int:
        """Apply top-of-book bounds by deleting stale depth, without adding levels.

        bid and ask carry no sizes, so bounds only shrink the stated token's book.
        A bid of 0 removes better bids; its paired ask of 1 on the other token
        follows UP + DOWN = 1, as observed in the archive.
        Keep in sync with Book.bbo in runner/engine/book.mjs."""
        self.ts = ts
        if side not in SIDES:
            raise ValueError(f"unknown side {side}")
        lad = self.ladders[side]
        return lad["asks"].prune(ask, ts, inclusive) + lad["bids"].prune(bid, ts, inclusive)

    def delta_mirrored(self, ts: int, side: str, kind: str, px: float, size: float) -> None:
        """A single-book delta applied to both tokens in one step.

        Keep in sync with Book.deltaMirrored in runner/engine/book.mjs.
        """
        self.delta(ts, side, kind, px, size)
        other = "DOWN" if side == "UP" else "UP"
        m = js_to_fixed10(1 - px)
        if not (0 <= m <= 1):
            return
        self.delta(ts, other, "bids" if kind == "asks" else "asks", m, size)

    def quote_ts(self, side: str) -> dict:
        """Keep in sync with Book.quoteTs in book.mjs."""
        lad = self.ladders.get(side)
        if not lad:
            return {"bid": None, "ask": None}
        return {"bid": lad["bids"].best_ts(), "ask": lad["asks"].best_ts()}

    def consume_mirror(self, side: str, kind: str, px: float, size: float) -> None:
        """Keep in sync with Book.consumeMirror in book.mjs."""
        other = "DOWN" if side == "UP" else "UP"
        m = js_to_fixed10(1 - px)
        if not (0 <= m <= 1):
            return
        self.ladders[other]["bids" if kind == "asks" else "asks"].reduce_at(to_ticks(m), size)

    def best(self, side: str) -> float | None:
        """The price to buy that outcome at, the best ask."""
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

    `limit` is a ceiling when opening and a floor when reducing, a bound in
    whichever direction protects the trader.
    """
    size = float(order.get("size") or 0)
    reducing = bool(order.get("reduce_only"))
    side = order.get("side")
    blank = {
        "fills": [], "level_ts": [], "filled": 0.0, "unfilled": max(0.0, size),
        "notional": 0.0, "avg_px": None, "worst_px": None,
        "quoted_px": None, "reduce_only": reducing,
    }
    if side not in SIDES or not size > 0:
        return blank

    ladder = book.ladders[side]["bids" if reducing else "asks"]
    quoted = ladder.best()
    fills, remaining, notional, level_ts = ladder.take(size, order.get("limit"))
    # Sum quantities taken rather than subtracting remaining from requested.
    # At float precision, 1e308 - 1000 is still 1e308. Keep in sync with book.mjs.
    filled = sum(f["size"] for f in fills)
    return {
        "fills": fills,
        "level_ts": level_ts,
        "filled": filled,
        "unfilled": remaining,
        "notional": notional,
        "avg_px": (notional / filled) if filled > 0 else None,
        "worst_px": fills[-1]["px"] if fills else None,
        "quoted_px": quoted,
        "reduce_only": reducing,
    }


OUTCOME_TIE = "TIE"

# Estimate Polymarket taker fees per book level, not per venue match.
# Keep in sync with feeFor in runner/engine/portfolio.mjs.
FEE_MODEL_PM = "polymarket-taker-v1"


def floor_cents(x: float) -> float:
    """Keep in sync with floorCents in portfolio.mjs."""
    return math.floor(x * 100 + 1e-9) / 100


def new_order_stats() -> dict:
    """Keep in sync with newOrderStats in portfolio.mjs."""
    return {"rejected": {}, "rebates": 0}


# book_age bucket upper bounds in ms. Keep in sync with BOOK_AGE_BOUNDS_MS in portfolio.mjs.
BOOK_AGE_BOUNDS_MS = (1000, 5000, 30000)


def new_book_age() -> dict:
    """Keep in sync with newBookAge in portfolio.mjs."""
    return {"fills": 0, "size_micro": 0, "by_age_micro": [0, 0, 0, 0], "max_age_ms": 0}


def _count_book_age(s: dict, ts, res: dict) -> None:
    """Keep in sync with countBookAge in portfolio.mjs."""
    s["fills"] += 1
    for f, level_ts in zip(res["fills"], res["level_ts"]):
        micro = js_round(f["size"] * 1e6)
        age = max(0, ts - level_ts)
        b = 0
        while b < len(BOOK_AGE_BOUNDS_MS) and age >= BOOK_AGE_BOUNDS_MS[b]:
            b += 1
        s["by_age_micro"][b] += micro
        s["size_micro"] += micro
        if age > s["max_age_ms"]:
            s["max_age_ms"] = age


def round_fee(x: float) -> float:
    return js_round(x * 1e5) / 1e5


def fee_for(policy, market_fee, res) -> float:
    if isinstance(policy, dict) and policy.get("mode") == "bps":
        bps = policy.get("bps")
        ok = isinstance(bps, (int, float)) and not isinstance(bps, bool) and math.isfinite(bps)
        bps = float(bps) if ok else 0.0
        return (res["notional"] * bps) / 10_000
    if not isinstance(market_fee, dict) or market_fee.get("model") != FEE_MODEL_PM:
        return 0.0
    rate = market_fee["rate"]
    total = 0.0
    for f in res["fills"]:
        total += round_fee(f["size"] * rate * f["px"] * (1 - f["px"]))
    return total


def contract_value(side: str, outcome: str) -> float:
    # A tie settles 50:50: both outcome tokens pay half a dollar. Keep in sync with
    # portfolio.mjs `contractValue`.
    if outcome == OUTCOME_TIE:
        return 0.5
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
    def __init__(self, fee_bps: float = 0, fees: dict | None = None, engine=None, order_stats=None,
                 book_age=None) -> None:
        # `fees` is the run's policy; absent, the legacy flat `fee_bps` is.
        self.fee_policy = fees if fees is not None else {"mode": "bps", "bps": float(fee_bps or 0)}
        self.market_fees: dict[str, dict | None] = {}
        self.legs: dict[str, dict[str, Leg]] = {}
        self.trades: list[dict] = []
        self.fills: list[dict] = []
        self.cash = 0.0
        self.fees_paid = 0.0
        self.rejected = 0
        # Generic markets only: outcome labels by index. See portfolio.mjs.
        self.market_labels: dict[str, tuple] = {}
        self.marked_value = 0.0
        # Per market, the same sums as cash / marked_value, see portfolio.mjs.
        self.market_cash: dict = {}
        self.market_marked: dict = {}
        # Execution options (job.engine). See portfolio.mjs.
        self.engine = engine
        self.quote_guard = (engine or {}).get("quote_guard") if isinstance(engine, dict) else None
        self.maker_rebate = (engine or {}).get("maker_rebate") if isinstance(engine, dict) else None
        self.market_rules: dict = {}
        self.mirrored: set = set()
        self.order_stats = order_stats if order_stats is not None else (new_order_stats() if engine else None)
        self.rule_reject = None
        # Shared with the harness (new_book_age), or None. See portfolio.mjs.
        self.book_age = book_age
        self.book_age_excluded: set = set()

    def exclude_book_age(self, market_id) -> None:
        self.book_age_excluded.add(market_id)

    def set_market_rules(self, market_id, rules) -> None:
        self.market_rules[market_id] = dict(rules)

    def set_mirrored(self, market_id) -> None:
        self.mirrored.add(market_id)

    def count_reject(self, reason) -> None:
        if self.order_stats is not None:
            rj = self.order_stats["rejected"]
            rj[reason] = rj.get(reason, 0) + 1

    def _rule_rejection(self, reason, eff):
        self.rejected += 1
        self.count_reject(reason)
        self.rule_reject = {"reason": reason, "eff": eff}
        return None

    def quote_guard_failure(self, book, ts, eff):
        """Keep in sync with quoteGuardFailure in portfolio.mjs."""
        g = self.quote_guard
        if not g or (eff.get("reduce_only") and not g.get("include_exits")):
            return None
        up, down = book.best("UP"), book.best("DOWN")
        if g.get("ask_sum") is not None:
            if up is None or down is None:
                return "quote_guard"
            total = up + down
            lo, hi = g["ask_sum"]
            if total < lo - EPS or total > hi + EPS:
                return "quote_guard"
        if g.get("max_age_ms") is not None:
            for side in ("UP", "DOWN"):
                q = book.quote_ts(side)
                for t in (q["bid"], q["ask"]):
                    if t is None or ts - t > g["max_age_ms"]:
                        return "quote_guard"
        return None

    def _reject_row(self, ts, market_id, eff, tag, order_id, reason) -> dict:
        res = {"fills": [], "filled": 0, "unfilled": float(eff.get("size") or 0), "notional": 0,
               "avg_px": None, "worst_px": None, "quoted_px": None}
        row = self._fill_row(ts, market_id, eff, res, tag, 0.0, 0.0, order_id)
        row["reject_reason"] = reason
        self.fills.append(row)
        return res

    def refuse(self, ts, market_id, eff, tag, order_id, reason):
        """Keep in sync with refuse in portfolio.mjs."""
        self.count_reject(reason)
        return self._reject_row(ts, market_id, eff, tag, order_id, reason)

    def set_market_labels(self, market_id: str, labels) -> None:
        """Keep in sync with setMarketLabels in portfolio.mjs."""
        if isinstance(labels, (list, tuple)) and len(labels) == 2:
            self.market_labels[market_id] = (str(labels[0]), str(labels[1]))

    def side_of(self, side, market_id: str):
        """UP/DOWN, or a label on a market with labels; else None. Keep in sync with sideOf."""
        if isinstance(side, str) and side in SIDES:
            return side
        labels = self.market_labels.get(market_id)
        if labels is None or not isinstance(side, str):
            return None
        s = side.strip().lower()
        if s == labels[0].strip().lower():
            return "UP"
        if s == labels[1].strip().lower():
            return "DOWN"
        return None

    def _label(self, market_id, side, row) -> None:
        labels = self.market_labels.get(market_id)
        if labels is not None:
            row["label"] = labels[0 if side == "UP" else 1]

    def _legs(self, market_id: str) -> dict[str, Leg]:
        legs = self.legs.get(market_id)
        if legs is None:
            legs = {"UP": Leg("UP"), "DOWN": Leg("DOWN")}
            self.legs[market_id] = legs
        return legs

    def set_market_fee(self, market_id: str, fee) -> None:
        """Record a market's fee schedule before any of its orders execute.

        Copy the schedule to isolate engine fees from strategy changes to
        market.fee. Keep in sync with setMarketFee in portfolio.mjs.
        """
        self.market_fees[market_id] = (
            {"model": fee.get("model"), "rate": fee.get("rate")} if isinstance(fee, dict) else None
        )

    def size_of(self, market_id: str, side: str) -> float:
        return self._legs(market_id)[side].size

    def liquidation_value(self, market_id: str, book) -> float:
        """liquidationValue in portfolio.mjs."""
        legs = self.legs.get(market_id)
        if legs is None:
            return 0
        v = 0
        for side in ("UP", "DOWN"):
            leg = legs[side]
            if not leg.size > EPS:
                continue
            bid = book.best_bid(side)
            if bid is not None:
                v += leg.size * bid
        return v

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
        # Mark at the bid, where an open position could be closed.
        mark = book.best_bid(lead.side) if book else None
        unrealised = 0.0 if mark is None else (mark - lead.avg_entry) * lead.size
        return Rec(side=lead.side, size=lead.size, avg_entry=lead.avg_entry,
                   unrealised=unrealised, realised=realised,
                   both=len(open_legs) == 2)

    def execute(self, book: Book, order: dict, ts: int, market_id: str,
                tag: str | None = None, how: str = "exit", order_id: str | None = None):
        eff = self.normalize(order, market_id)
        if eff is None:
            if self.rule_reject is not None:
                self._reject_row(ts, market_id, self.rule_reject["eff"], tag, order_id, self.rule_reject["reason"])
            return None
        return self.execute_effective(book, eff, ts, market_id, tag, how, order_id)

    def normalize(self, order: dict, market_id: str):
        """The one validator. Keep in sync with normalize in portfolio.mjs."""
        self.rule_reject = None
        side = self.side_of(order.get("side"), market_id) if isinstance(order, dict) else None
        if side is None:
            self.rejected += 1
            return None

        leg = self._legs(market_id)[side]

        # Count invalid orders and return None rather than failing the run.
        # Keep in sync with normalize in portfolio.mjs.
        def _finite(v):
            # Require numeric values; JS and Python coercions differ.
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

        rules = self.market_rules.get(market_id)
        if has_notional:
            budget = _finite(order.get("notional"))
            if budget is None or budget <= 0 or limit is None or limit <= 0:
                self.rejected += 1
                return None
            # Check overflow before floor: 1e308 / 0.01 is inf.
            # Use floor(a / b), not Python float floor-division, to match JavaScript:
            # 80 // 0.64 is 124, while floor(80 / 0.64) is 125.
            q = budget / limit
            if not math.isfinite(q):
                self.rejected += 1
                return None
            size = floor_cents(q) if rules is not None else float(math.floor(q))
        else:
            size = _finite(order.get("size"))
        if size is None or not size > 0:
            self.rejected += 1
            return None
        if order.get("reduce_only"):
            size = min(size, leg.size)
            if rules is not None:
                size = floor_cents(size)
            if not size > EPS:
                self.rejected += 1
                return None

        # Venue order rules, Keep in sync with portfolio.mjs.
        if rules is not None:
            eff = {**order, "side": side, "size": size, "limit": limit}
            cents = size * 100
            if abs(cents - js_round(cents)) > 1e-6:
                return self._rule_rejection("size_step", eff)
            if size < rules["minSize"] - EPS:
                return self._rule_rejection("below_min_size", eff)
            if limit is not None:
                t = to_ticks(limit)
                if t % rules["tickTicks"] != 0 or abs(from_ticks(t) - limit) > EPS:
                    return self._rule_rejection("off_tick", eff)

        # Use the derived size after the reduce_only clamp for both matching and
        # fill-row requested quantity. Keep in sync with portfolio.mjs.
        return {**order, "side": side, "size": size, "limit": limit}

    def execute_effective(self, book: Book, order: dict, ts: int, market_id: str,
                          tag: str | None = None, how: str = "exit", order_id: str | None = None):
        """Take liquidity for an order `normalize` already accepted."""
        if self.quote_guard:
            why = self.quote_guard_failure(book, ts, order)
            if why:
                return self.refuse(ts, market_id, order, tag, order_id, why)
        if order.get("tif") == "fok":
            avail = (book.bid_depth(order["side"], order.get("limit")) if order.get("reduce_only")
                     else book.depth(order["side"], order.get("limit")))
            if avail + EPS < order["size"]:
                return self.refuse(ts, market_id, order, tag, order_id, "fok_unfilled")
        res = match_order(book, order)
        if res["filled"] > 0 and market_id in self.mirrored:
            kind = "bids" if order.get("reduce_only") else "asks"
            for f in res["fills"]:
                book.consume_mirror(order["side"], kind, f["px"], f["size"])
        if res["filled"] <= 0:
            self.fills.append(self._fill_row(ts, market_id, order, res, tag, 0.0, 0.0, order_id))
            return res
        if self.book_age is not None and market_id not in self.book_age_excluded:
            _count_book_age(self.book_age, ts, res)

        fee = fee_for(self.fee_policy, self.market_fees.get(market_id), res)
        realised = self._apply(market_id, order["side"], bool(order.get("reduce_only")),
                               res["filled"], res["notional"], fee, ts, how)
        self.fills.append(self._fill_row(ts, market_id, order, res, tag, realised, fee, order_id))
        return res

    def maker_fill(self, market_id: str, side: str, reduce: bool, size: float, px: float, ts: int,
                   tag=None, order_id=None, extra=None) -> dict:
        """One maker fill of a resting order. Keep in sync with makerFill in portfolio.mjs."""
        notional = px * size
        policy = self.fee_policy
        if isinstance(policy, dict) and policy.get("mode") == "bps":
            bps = policy.get("bps")
            ok = isinstance(bps, (int, float)) and not isinstance(bps, bool) and math.isfinite(bps)
            fee = (notional * (bps if ok else 0)) / 10_000
        else:
            fee = 0
        # maker_rebate, Keep in sync with makerFill in portfolio.mjs.
        rebate = None
        if self.maker_rebate is not None:
            rebate = 0
            mf = self.market_fees.get(market_id)
            if isinstance(policy, dict) and policy.get("mode") == "venue" and isinstance(mf, dict) \
                    and mf.get("model") == FEE_MODEL_PM:
                rebate = round_fee(self.maker_rebate * fee_for(policy, mf, {"fills": [{"px": px, "size": size}],
                                                                           "notional": notional}))
            fee -= rebate
            if self.order_stats is not None:
                self.order_stats["rebates"] += rebate
        realised = self._apply(market_id, side, reduce, size, notional, fee, ts, "exit")
        row = {
            "ts_ms": ts,
            "market_id": market_id,
            "side": side,
            "action": "reduce" if reduce else "open",
            "requested": size,
            "filled": size,
            "unfilled": 0,
            "avg_px": px,
            "worst_px": px,
            "quoted_px": px,
            "levels_walked": 0,
            "fee": fee,
            "realised": realised,
            "tag": tag,
            "liquidity": "maker",
            "order_id": order_id,
        }
        if extra:
            row.update(extra)
        self._label(market_id, side, row)
        if rebate is not None:
            row["rebate"] = rebate
        self.fills.append(row)
        return row

    def _apply(self, market_id, side, reduce, filled, notional, fee, ts, how):
        """Book a filled quantity against the leg; the realised PnL of the fill."""
        leg = self._legs(market_id)[side]
        self.fees_paid += fee
        realised = 0.0

        if reduce:
            basis = leg.avg_entry or 0.0
            realised = notional - basis * filled - fee
            leg.size -= filled
            leg.cost -= basis * filled
            if leg.size <= EPS:
                leg.size = 0.0
                leg.cost = 0.0
            leg.realised += realised
            leg.fees += fee
            leg.exit_size += filled
            leg.exit_notional += notional
            self.cash += notional - fee
            self.market_cash[market_id] = self.market_cash.get(market_id, 0) + (notional - fee)
            if leg.size == 0.0:
                self._close_trade(market_id, leg, ts, how)
        else:
            if leg.size <= EPS and leg.entry_ts is None:
                leg.entry_ts = ts
            leg.size += filled
            leg.cost += notional
            leg.entry_size += filled
            leg.entry_notional += notional
            leg.fees += fee
            # Include the entry fee in round-trip realised PnL. Keep in sync with portfolio.mjs.
            leg.realised -= fee
            self.cash -= notional + fee
            self.market_cash[market_id] = self.market_cash.get(market_id, 0) - (notional + fee)
        return realised

    def _fill_row(self, ts, market_id, order, res, tag, realised, fee, order_id=None) -> dict:
        row = {
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
            "liquidity": "taker",
            "order_id": order_id,
        }
        self._label(market_id, order.get("side"), row)
        return row

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
        self._label(market_id, leg.side, row)
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
            # Settlement pays the terminal contract value without a trading fee.
            value = contract_value(side, outcome) * leg.size
            leg.realised += value - leg.cost
            leg.exit_size += leg.size
            leg.exit_notional += value
            self.cash += value
            self.market_cash[market_id] = self.market_cash.get(market_id, 0) + value
            before = len(self.trades)
            self._close_trade(market_id, leg, ts, "settled", outcome=outcome)
            closed.append(self.trades[before])
            leg.size = 0.0
            leg.cost = 0.0
        return closed

    def mark(self, market_id: str, terminal, ts: int) -> list[dict]:
        """Value an unresolved market's open legs at its mark; cash unchanged.

        Keep in sync with Portfolio.mark in portfolio.mjs.
        """
        legs = self.legs.get(market_id)
        if not legs:
            return []
        closed = []
        valued = isinstance(terminal, dict) and terminal.get("none") is None
        for side in SIDES:
            leg = legs[side]
            if leg.size <= EPS:
                continue
            v = terminal.get(side) if valued else None
            px = v if isinstance(v, (int, float)) and not isinstance(v, bool) else None
            q = leg.size
            basis = leg.cost
            value = 0 if px is None else px * q
            leg.realised += value - basis
            leg.exit_size += q
            leg.exit_notional += value
            self.marked_value += value
            self.market_marked[market_id] = self.market_marked.get(market_id, 0) + value
            before = len(self.trades)
            self._close_trade(
                market_id, leg, ts, "marked",
                outcome=None,
                mark_px=px,
                marked_size=q,
                marked_pnl=value - basis,
                mark_source=terminal.get("source") if valued else None,
                mark_ts_ms=terminal.get("ts_ms") if valued else None,
                mark_age_ms=terminal.get("age_ms") if valued else None,
                mark_missing=None if valued else ((terminal or {}).get("none") or "no_quote"),
            )
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
    """Monitor mean hook cost over a rolling event window.
    Keep in sync with BudgetMonitor in engine/replay.mjs.

    Individual timings include host scheduling delays, so use the window mean
    rather than a breach count. A cheap prefix must not dilute a later costly
    phase. The run deadline handles hooks that do not return."""

    def __init__(self, limit_micros: float = 400, sample_floor: int = 2000) -> None:
        self.limit_micros = limit_micros
        self.sample_floor = sample_floor
        self.count = 0
        self.breaches = 0
        self.max_micros = 0.0
        self.total_micros = 0.0
        # Keep the latest sample_floor timings in a ring so earlier cheap events
        # do not dilute the current window.
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
            # Report the window mean used for the budget decision.
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
