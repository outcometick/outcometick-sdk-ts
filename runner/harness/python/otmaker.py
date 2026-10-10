"""Resting (maker) orders: a conservative queue-position model for Polymarket.

The Python mirror of runner/engine/maker.mjs. The reasoning for every rule —
the mirrored book, one print per transaction on the taker's token, the
depletion ledger, the single volume waterfall, the entry and cancel windows —
is written down there once; this file follows it rule for rule and in the order
of every floating-point operation, and runner/conformance holds the two engines
to the same rows.
"""

from __future__ import annotations

import math
import re

from otengine import PRICE_SCALE, to_ticks, from_ticks

QUEUE_MODEL = "polymarket-queue-v1"
PRINT_LAG_MS = 800
MAX_RESTING = 50
TICK_GRID = 10
MARKOUT_HORIZONS = (("markout_1s", 1_000), ("markout_10s", 10_000), ("markout_60s", 60_000))
MARKOUT_MAX_AGE_MS = 5_000

_CLIENT_ID = re.compile(r"[A-Za-z0-9_.:-]{1,64}")
_ENGINE_ID = re.compile(r"o[0-9]+")

EPS = 1e-9

FINAL = frozenset((
    "filled", "cancelled", "expired", "cancelled_no_position",
    "rejected", "rejected_post_only", "rejected_self_cross",
))

# Maker fill rows whose markouts are not final yet. See PENDING_ROWS in maker.mjs.
_PENDING_ROWS: set[int] = set()


def row_pending(row) -> bool:
    return id(row) in _PENDING_ROWS


def new_maker_stats() -> dict:
    return {
        "submitted": 0,
        "rested": 0,
        "rested_size": 0,
        "taker_on_arrival_size": 0,
        "maker_filled_size": 0,
        "maker_fills": 0,
        "orders_with_maker_fill": 0,
        "fully_filled": 0,
        "cancelled": 0,
        "cancelled_before_entry": 0,
        "cancelled_no_position": 0,
        "expired": 0,
        "rejected_invalid": 0,
        "rejected_post_only": 0,
        "rejected_self_cross": 0,
        "rejected_duplicate_id": 0,
        "cancel_noop": 0,
        "lag_suppressed_size": 0,
        "crossed_observations": 0,
    }


def add_maker_stats(total: dict, part: dict | None) -> dict:
    for k in list(total):
        total[k] += (part or {}).get(k, 0)
    return total


def canonical_of(side: str, reduce: bool, ticks: int) -> tuple[str, int]:
    if side == "UP":
        return ("asks" if reduce else "bids", ticks)
    return ("bids" if reduce else "asks", PRICE_SCALE - ticks)


def canonical_print(ev: dict) -> tuple[str, int]:
    t = to_ticks(ev["px"])
    up = ev["side"] == "UP"
    taker = ev["taker"] if up else ("SELL" if ev["taker"] == "BUY" else "BUY")
    return ("asks" if taker == "BUY" else "bids", t if up else PRICE_SCALE - t)


def _reached(kind: str, q: int, p: int) -> bool:
    return q <= p if kind == "asks" else q >= p


def _num(v) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool)


class _Order:
    __slots__ = ("id", "seq", "client_id", "order", "side", "reduce", "post_only", "tag",
                 "limit", "kind", "q", "size", "remaining", "state", "submitted_ts",
                 "activated_ts", "cancel_eff", "ahead", "ahead_at_join", "crossed", "maker_filled")


class MakerBook:
    def __init__(self, market_id: str, portfolio, print_lag_ms: int = PRINT_LAG_MS) -> None:
        self.market_id = market_id
        self.pf = portfolio
        self.lag = print_lag_ms
        self.by_id: dict[str, _Order] = {}
        # Non-final orders in submission order -- see `open` in maker.mjs.
        self.open: list[_Order] = []
        self.seq = 0
        self.ledger: dict[str, list[list]] = {"asks": [], "bids": []}  # [ts, q, amount]
        self.stats = new_maker_stats()
        # One FIFO per horizon, sorted by due time -- see markoutQ in maker.mjs.
        self.markout_q = [{"items": [], "head": 0} for _ in MARKOUT_HORIZONS]
        self.token_ts = {"UP": None, "DOWN": None}
        self.rows: list[dict] = []

    def _compact(self) -> None:
        if any(o.state in FINAL for o in self.open):
            self.open = [o for o in self.open if o.state not in FINAL]

    def open_count(self) -> int:
        self._compact()
        return len(self.open)

    def _active(self) -> list[_Order]:
        self._compact()
        return [o for o in self.open if o.state in ("live", "cancel_pending")]

    def submit(self, order: dict, ts: int):
        self.stats["submitted"] += 1
        client_id = None
        cid = order.get("client_id")
        if cid is not None:
            if (not isinstance(cid, str) or not _CLIENT_ID.fullmatch(cid)
                    or _ENGINE_ID.fullmatch(cid)):
                self.stats["rejected_invalid"] += 1
                return None
            self._compact()
            if any(o.client_id == cid for o in self.open):
                self.stats["rejected_duplicate_id"] += 1
                return None
            client_id = cid
        self.seq += 1
        rec = _Order()
        rec.id = f"o{self.seq}"
        rec.seq = self.seq
        rec.client_id = client_id
        rec.order = order
        rec.side = order.get("side")
        rec.reduce = bool(order.get("reduce_only"))
        rec.post_only = order.get("post_only") is True
        tag = order.get("tag")
        rec.tag = tag if isinstance(tag, str) else None
        rec.limit = None
        rec.kind = None
        rec.q = None
        rec.size = 0
        rec.remaining = 0
        rec.state = "pending"
        rec.submitted_ts = ts
        rec.activated_ts = None
        rec.cancel_eff = None
        rec.ahead = 0
        rec.ahead_at_join = 0
        rec.crossed = False
        rec.maker_filled = 0
        self.by_id[rec.id] = rec
        self.open.append(rec)
        return rec

    def find(self, x):
        if not isinstance(x, str):
            return None
        if _ENGINE_ID.fullmatch(x):
            return self.by_id.get(x)
        self._compact()
        return next((o for o in self.open if o.client_id == x), None)

    def activate(self, rec: _Order, ts: int, book) -> None:
        if rec.state != "pending":
            return
        eff = self.pf.normalize(rec.order, self.market_id)
        limit = eff.get("limit") if eff is not None else None
        ticks = None if limit is None else to_ticks(limit)
        if (eff is None or limit is None or not (0 < limit < 1)
                or ticks % TICK_GRID != 0 or abs(from_ticks(ticks) - limit) > EPS):
            rec.state = "rejected"
            self.stats["rejected_invalid"] += 1
            return
        kind, q = canonical_of(rec.side, rec.reduce, ticks)
        opp = "bids" if kind == "asks" else "asks"
        self._compact()
        for o in self.open:
            # Only live orders -- see activate in maker.mjs.
            if o.state != "live" or o.kind != opp:
                continue
            if (o.q <= q) if kind == "bids" else (o.q >= q):
                rec.state = "rejected_self_cross"
                self.stats["rejected_self_cross"] += 1
                return
        rec.limit = limit
        rec.kind = kind
        rec.q = q
        rec.size = eff["size"]
        rec.remaining = eff["size"]

        touch = book.best_bid(rec.side) if rec.reduce else book.best(rec.side)
        marketable = touch is not None and (
            to_ticks(touch) >= ticks if rec.reduce else to_ticks(touch) <= ticks)
        if marketable:
            if rec.post_only:
                rec.state = "rejected_post_only"
                self.stats["rejected_post_only"] += 1
                return
            res = self.pf.execute_effective(book, eff, ts, self.market_id, rec.tag, "exit", rec.id)
            filled = res["filled"] if res else 0
            self.stats["taker_on_arrival_size"] += filled
            rec.remaining = eff["size"] - filled
            if not rec.remaining > EPS:
                rec.remaining = 0
                rec.state = "filled"
                self.stats["fully_filled"] += 1
                return

        rec.state = "live"
        rec.activated_ts = ts
        rec.ahead = book.ladders["UP"][kind].size_at_ticks(q)
        rec.ahead_at_join = rec.ahead
        self.stats["rested"] += 1
        self.stats["rested_size"] += rec.remaining

    def cancel(self, rec, ts: int) -> None:
        if rec is None:
            self.stats["cancel_noop"] += 1
            return
        if rec.state == "pending":
            rec.state = "cancelled"
            self.stats["cancelled_before_entry"] += 1
            return
        if rec.state == "live":
            rec.state = "cancel_pending"
            rec.cancel_eff = ts
            return
        self.stats["cancel_noop"] += 1

    def finalize(self, T: int) -> None:
        for o in self.open:
            if o.state == "cancel_pending" and o.cancel_eff + self.lag < T:
                o.state = "cancelled"
                self.stats["cancelled"] += 1
        for kind in ("asks", "bids"):
            led = self.ledger[kind]
            if led and led[0][0] + self.lag < T:
                self.ledger[kind] = [e for e in led if e[0] + self.lag >= T]

    def tracking(self) -> bool:
        return any(o.state in ("live", "cancel_pending") for o in self.open)

    def book_event(self, ev: dict, book, apply) -> None:
        if ev.get("snapshot"):
            levels = ev.get("levels") or {}
            for side in ("UP", "DOWN"):
                if levels.get(side) is not None:
                    self.token_ts[side] = ev["ts_ms"]
        elif ev.get("side") in ("UP", "DOWN"):
            self.token_ts[ev["side"]] = ev["ts_ms"]
        if not self.tracking():
            apply()
            return
        # Only events that can change the UP ladders -- see bookEvent in maker.mjs.
        touches_up = (ev.get("levels") or {}).get("UP") is not None if ev.get("snapshot") else ev.get("side") == "UP"
        if not touches_up:
            apply()
            return
        T = ev["ts_ms"]
        if not ev.get("snapshot") and not ev.get("bbo"):
            kind = ev.get("ladder")
            px = ev.get("px")
            if kind not in ("asks", "bids") or not _num(px):
                apply()
                return
            ladder = book.ladders["UP"][kind]
            q = to_ticks(px)
            was = ladder.size_at_ticks(q)
            apply()
            drop = was - ladder.size_at_ticks(q)
            if drop > EPS:
                self.ledger[kind].append([T, q, drop])
        else:
            up = book.ladders["UP"]
            before = {"asks": up["asks"].pairs(), "bids": up["bids"].pairs()}
            apply()
            for kind in ("asks", "bids"):
                after = {q: s for q, s in book.ladders["UP"][kind].pairs()}
                for q, size in before[kind]:
                    drop = size - after.get(q, 0)
                    if drop > EPS:
                        self.ledger[kind].append([T, q, drop])
        for o in self._active():
            v = book.ladders["UP"][o.kind].size_at_ticks(o.q)
            if v < o.ahead:
                o.ahead = v
            opp_levels = book.ladders["UP"]["asks" if o.kind == "bids" else "bids"].levels
            opp_best = opp_levels[0] if opp_levels else None
            crossed = opp_best is not None and (
                opp_best[0] <= o.q if o.kind == "bids" else opp_best[0] >= o.q)
            if crossed and not o.crossed:
                self.stats["crossed_observations"] += 1
            o.crossed = crossed

    def trade(self, ev: dict, book) -> None:
        if not self.tracking():
            return
        size = ev.get("size")
        px = ev.get("px")
        if not (_num(size) and math.isfinite(size) and size > 0):
            return
        if not (_num(px) and 0 <= px <= 1):
            return
        if ev.get("side") not in ("UP", "DOWN") or ev.get("taker") not in ("BUY", "SELL"):
            return
        T = ev["ts_ms"]
        kind, p = canonical_print(ev)
        ladder = book.ladders["UP"][kind]
        visible = {q: s for q, s in ladder.pairs()}

        own = [o for o in self._active() if o.kind == kind and _reached(kind, o.q, p)]
        led = [e for e in self.ledger[kind] if _reached(kind, e[1], p) and e[2] > EPS]

        prices = set()
        for lvl in ladder.levels:
            if _reached(kind, lvl[0], p):
                prices.add(lvl[0])
        for e in led:
            prices.add(e[1])
        for o in own:
            prices.add(o.q)
        levels = sorted(prices) if kind == "asks" else sorted(prices, reverse=True)

        B = size
        advance: list[list] = []
        for x in levels:
            if not B > EPS:
                break
            for e in led:
                if e[1] != x or not B > EPS:
                    continue
                take = min(B, e[2])
                e[2] -= take
                B -= take
            here = sorted((o for o in own if o.q == x), key=lambda o: (o.activated_ts, o.seq))
            front = 0
            ext_used = 0
            for o in here:
                seg = max(0, o.ahead - front)
                ext_take = min(B, seg)
                B -= ext_take
                ext_used += ext_take
                if o.ahead > front:
                    front = o.ahead
                exposed = T >= o.activated_ts + self.lag and (
                    o.state == "live" or (o.state == "cancel_pending" and T <= o.cancel_eff + self.lag))
                if T >= o.activated_ts + self.lag:
                    advance.append([o, ext_used])
                take = min(B, o.remaining)
                if not take > EPS:
                    continue
                B -= take
                if exposed:
                    self._fill(o, take, T)
                else:
                    self.stats["lag_suppressed_size"] += take
            rest = max(0, visible.get(x, 0) - front)
            B -= min(B, rest)
        for o, used in advance:
            o.ahead = max(0, o.ahead - used)
        for k in ("asks", "bids"):
            if any(not e[2] > EPS for e in self.ledger[k]):
                self.ledger[k] = [e for e in self.ledger[k] if e[2] > EPS]

    def _fill(self, o: _Order, take: float, T: int) -> None:
        size = take
        if o.reduce:
            open_ = self.pf.size_of(self.market_id, o.side)
            if not open_ > EPS:
                o.state = "cancelled_no_position"
                self.stats["cancelled_no_position"] += 1
                return
            size = min(size, open_)
        ahead_at_fill = o.ahead
        row = self.pf.maker_fill(
            self.market_id, o.side, o.reduce, size, o.limit, T, o.tag, o.id,
            {
                "queue_ahead_at_join": o.ahead_at_join,
                "queue_ahead_at_fill": ahead_at_fill,
                "time_in_queue_ms": T - o.activated_ts,
                "markout_1s": None,
                "markout_10s": None,
                "markout_60s": None,
                "markout_settle": None,
            },
        )
        _PENDING_ROWS.add(id(row))
        self.rows.append(row)
        if o.maker_filled == 0:
            self.stats["orders_with_maker_fill"] += 1
        o.maker_filled += size
        o.remaining -= size
        self.stats["maker_fills"] += 1
        self.stats["maker_filled_size"] += size
        m = {"row": row, "side": o.side, "reduce": o.reduce, "px": o.limit, "ts": T}
        for q in self.markout_q:
            q["items"].append(m)
        if not o.remaining > EPS:
            o.remaining = 0
            o.state = "filled"
            self.stats["fully_filled"] += 1

    def resolve_markouts(self, T: int, book) -> None:
        for k, (key, ms) in enumerate(MARKOUT_HORIZONS):
            q = self.markout_q[k]
            items = q["items"]
            while q["head"] < len(items) and items[q["head"]]["ts"] + ms < T:
                m = items[q["head"]]
                m["row"][key] = self._markout(m, m["ts"] + ms, book)
                q["head"] += 1
            if q["head"] > 1024 and q["head"] * 2 > len(items):
                q["items"] = items[q["head"]:]
                q["head"] = 0

    def _markout(self, m: dict, due: int, book):
        seen = self.token_ts[m["side"]]
        if seen is None or due - seen > MARKOUT_MAX_AGE_MS:
            return None
        bid = book.best_bid(m["side"])
        ask = book.best(m["side"])
        if bid is None or ask is None or not to_ticks(bid) < to_ticks(ask):
            return None
        mid = (bid + ask) / 2
        return m["px"] - mid if m["reduce"] else mid - m["px"]

    def close(self, close_ts: int, book) -> None:
        self.resolve_markouts(close_ts + 1, book)
        for o in self.open:
            if o.state in FINAL:
                continue
            o.state = "expired"
            self.stats["expired"] += 1
        self.open = []

    def release_rows(self, value_of) -> None:
        for row in self.rows:
            if value_of is not None:
                v = value_of(row["side"])
                row["markout_settle"] = row["avg_px"] - v if row["action"] == "reduce" else v - row["avg_px"]
            _PENDING_ROWS.discard(id(row))
        self.rows = []

    def views(self) -> list[dict]:
        out = []
        self._compact()
        for o in self.open:
            lim = o.order.get("limit")
            out.append({
                "id": o.id,
                "client_id": o.client_id,
                "side": o.side,
                "action": "reduce" if o.reduce else "open",
                "limit": o.limit if o.limit is not None else (lim if _num(lim) else None),
                "size": None if o.state == "pending" else o.size,
                "remaining": None if o.state == "pending" else o.remaining,
                "state": o.state,
                "placed_ms": o.submitted_ts,
            })
        return out
