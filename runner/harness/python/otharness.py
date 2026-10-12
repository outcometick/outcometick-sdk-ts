"""Job loop shared by the sandbox harness and local Python backtests.
Keep in sync with runner/harness/node/harness.mjs.

Market mode: a header {market, stream, n, references?, series?, lags?}
followed by n event lines per market.
Session mode: {"open": {i, market, stream, references?, series?, lags?}},
{"i": k, "e": <event>} and {"close": k}, interleaved in event-time order
across markets (runner/session-feed.mjs)."""

from __future__ import annotations

import datetime as _datetime
import json
import math

from otengine import Book as _Book, BudgetMonitor, Portfolio, RunAbort, new_book_age, new_order_stats
from otfeed import build_feeds
from otmaker import add_maker_stats, new_maker_stats, row_pending
from otreplay import MarketReplay, make_log_budget, LOG_BYTES_PER_RUN, LOG_LINE_CHARS

CHANNEL_TRADE = "t"
CHANNEL_FILL = "f"
CHANNEL_LOG = "l"
CHANNEL_RESULT = "r"
# Completed-market acknowledgement, for display only.
# Keep in sync with CHANNEL.progress in protocol.mjs.
CHANNEL_PROGRESS = "p"
# The recorder, CHANNEL.record, RECORD_FIELDS and the budgets in protocol.mjs
# (a test pins the copies).
CHANNEL_RECORD = "v"
RECORD_FIELDS = ("key", "ts", "cash", "marked", "position_value", "final")
MAX_RECORD_ROWS = 1_000_000
MAX_RECORD_BYTES = 256 * 1024 * 1024


def _js_num(x) -> str:
    """Number.prototype.toString(), a copy of _number_to_string in
    client/backtest/_js.py (the harness imports nothing from outside runner/;
    a test pins the two). Record lines are written exactly as JavaScript writes
    them, so the byte budget cuts both engines at the same row."""
    if isinstance(x, bool):
        return "true" if x else "false"
    x = float(x)
    if math.isnan(x) or math.isinf(x):
        return "null"
    if x == 0:
        return "0"
    if x < 0:
        return "-" + _js_num(-x)
    r = repr(x)
    if "e" in r:
        mant, exp = r.split("e")
        e = int(exp)
    else:
        mant, e = r, 0
    if "." in mant:
        ip, fp = mant.split(".")
    else:
        ip, fp = mant, ""
    digits = (ip + fp).lstrip("0")
    lead_zeros = len(ip + fp) - len((ip + fp).lstrip("0"))
    n = len(ip) - lead_zeros + e
    digits = digits.rstrip("0") or "0"
    k = len(digits)
    if k <= n <= 21:
        return digits + "0" * (n - k)
    if 0 < n <= 21:
        return digits[:n] + "." + digits[n:]
    if -6 < n <= 0:
        return "0." + "0" * (-n) + digits
    exp_val = n - 1
    sign = "+" if exp_val >= 0 else "-"
    if k == 1:
        return f"{digits}e{sign}{abs(exp_val)}"
    return f"{digits[0]}.{digits[1:]}e{sign}{abs(exp_val)}"


def _record_payload(row) -> str:
    """One record line's JSON, as JSON.stringify writes the projected row."""
    parts = []
    for f in RECORD_FIELDS:
        v = row.get(f)
        if v is None:
            val = "null"
        elif isinstance(v, bool):
            val = "true" if v else "false"
        elif isinstance(v, (int, float)):
            val = _js_num(v)
        else:
            val = _json_string(v)
        parts.append(_json_string(f) + ":" + val)
    return "{" + ",".join(parts) + "}"


def line_bytes(channel: str, payload: str) -> int:
    """lineBytes in protocol.mjs."""
    return 32 + 1 + len(channel) + 1 + len(payload.encode("utf-8")) + 1

EXIT_OK = 0
EXIT_REJECTED = 10
EXIT_BUDGET = 11

# Bound before any submitted code runs (the harness imports this module first),
# so a strategy that rebinds json.loads at import time cannot reach the stream.
_JSON_LOADS = json.loads
_SCAN = json.JSONDecoder().scan_once


def _LOADS(s):
    """Parse JSON with the C scanner as a fast path.

    json.loads whitespace matching and decoding cost about 13 s per BTC
    market-day in profiling. Use scanner output only when it consumes the
    whole line from index 0; otherwise fall back to json.loads for its errors
    and whitespace handling."""
    try:
        obj, end = _SCAN(s, 0)
    except (StopIteration, ValueError):
        return _JSON_LOADS(s)
    return obj if end == len(s) else _JSON_LOADS(s)

# Captured JSON writer helpers avoid strategy-rebound module attributes.
# Keep in sync with stringify in harness.mjs.
_ESCAPES = {
    '"': '\\"', "\\": "\\\\", "\n": "\\n", "\r": "\\r",
    "\t": "\\t", "\b": "\\b", "\f": "\\f",
}


def _json_string(value):
    out = ['"']
    for ch in str(value):
        esc = _ESCAPES.get(ch)
        if esc is not None:
            out.append(esc)
        elif ch < " ":
            out.append("\\u%04x" % ord(ch))
        else:
            out.append(ch)
    out.append('"')
    return "".join(out)


def _DUMPS(value):
    if value is None:
        return "null"
    if value is True:
        return "true"
    if value is False:
        return "false"
    if isinstance(value, (int, float)):
        if isinstance(value, float) and (value != value or value in (float("inf"), float("-inf"))):
            return "null"
        return repr(value) if isinstance(value, float) else str(value)
    if isinstance(value, str):
        return _json_string(value)
    if isinstance(value, (list, tuple)):
        return "[" + ",".join(_DUMPS(v) for v in value) + "]"
    if isinstance(value, dict):
        return "{" + ",".join(
            _json_string(k) + ":" + _DUMPS(v) for k, v in value.items()
        ) + "}"
    return _json_string(value)


TRADE_FIELDS = (
    "market_id", "side", "size", "entry_px", "exit_px", "pnl", "fees",
    "opened_ms", "closed_ms", "how", "outcome",
)
# Generic markets add these; archive rows never carry a label.
# Keep in sync with GENERIC_TRADE_FIELDS in runner/harness/node/harness.mjs.
GENERIC_TRADE_FIELDS = TRADE_FIELDS + (
    "label", "mark_px", "marked_size", "marked_pnl", "mark_source",
    "mark_ts_ms", "mark_age_ms", "mark_missing",
)
FILL_FIELDS = (
    "ts_ms", "market_id", "side", "action", "requested", "filled", "unfilled",
    "avg_px", "worst_px", "quoted_px", "levels_walked", "fee", "realised", "tag",
    "liquidity", "order_id", "queue_ahead_at_join", "queue_ahead_at_fill", "time_in_queue_ms",
    "markout_1s", "markout_10s", "markout_60s", "markout_settle",
)
GENERIC_FILL_FIELDS = FILL_FIELDS + ("label",)


def project_row(row, fields):
    """Copy a row to a plain dict of primitives.

    Coerced field by field so a property, a subclass with a custom __repr__ or
    an object with a rebound method cannot ride along into the output.
    """
    out = {}
    for f in fields:
        v = row.get(f) if isinstance(row, dict) else getattr(row, f, None)
        if v is None:
            out[f] = None
        elif isinstance(v, bool):
            out[f] = bool(v)
        elif isinstance(v, (int, float)):
            out[f] = float(v) if isinstance(v, float) else int(v)
        else:
            out[f] = str(v)
    return out


def fee_policy(job: dict) -> dict:
    """The run's fee policy: `job.fees` when the writer sent one, else the
    legacy flat `feeBps`."""
    fees = job.get("fees")
    if isinstance(fees, dict) and fees.get("mode") in ("venue", "bps"):
        return fees
    return {"mode": "bps", "bps": job.get("feeBps", 0)}


_NO_RESTING = "resting (gtc) orders are not available for this run"


def engine_policy(job: dict):
    """Keep in sync with enginePolicy in runner/harness/node/harness.mjs."""
    e = job.get("engine")
    return e if isinstance(e, dict) else None


def engine_fill_fields(engine) -> tuple:
    """Keep in sync with engineFillFields in runner/harness/node/harness.mjs."""
    if not engine:
        return ()
    out = ()
    if engine.get("fok") or engine.get("order_rules") or engine.get("quote_guard"):
        out += ("reject_reason",)
    if engine.get("maker_rebate") is not None:
        out += ("rebate",)
    return out


def resting_policy(job: dict) -> dict:
    """The run's resting-order policy as the writer decided it; anything
    malformed is "not allowed". Keep in sync with restingPolicy in the Node harness."""
    r = job.get("resting")
    if not isinstance(r, dict):
        return {"allowed": False, "refusal": _NO_RESTING, "cancelLatencyMs": 0}
    cl = r.get("cancelLatencyMs")
    ok = isinstance(cl, (int, float)) and not isinstance(cl, bool) and math.isfinite(cl) and cl >= 0
    return {
        "allowed": r.get("allowed") is True,
        "refusal": r.get("refusal") if isinstance(r.get("refusal"), str) else _NO_RESTING,
        "cancelLatencyMs": cl if ok else job.get("fillDelayMs", 0),
    }


def _log_prefix(market: dict) -> str:
    # Opening time first, then a short id, Keep in sync with the Node harness.
    sid = str(market.get("market_id") or "")[:10]
    opened = market.get("open_ts_ms")
    if opened is None:
        return sid
    dt = _datetime.datetime.fromtimestamp(opened / 1000, _datetime.timezone.utc)
    return f"{dt.strftime('%Y-%m-%d %H:%M')} {sid}"


class _Market:
    """What the loop tracks for one open market, besides the replay itself."""

    __slots__ = ("entry", "replay", "seen", "book", "open_quotes", "feed_rows", "before", "open_ts", "clock")

    def __init__(self, entry: dict, clock: dict | None = None) -> None:
        self.entry = entry
        # Global scheduler: the run's clock (one per session, else per market).
        self.clock = clock if clock is not None else {"t": float("-inf")}
        self.replay = None
        self.seen = 0
        # Reconstruct opening quotes with the engine's Book for worker baselines.
        self.book = _Book(entry["market"]["market_id"])
        self.open_quotes = None
        self.feed_rows: dict = {}
        self.before = None
        self.open_ts = None

    def rows_for(self, name):
        return self.feed_rows.setdefault(name, [])

    def observe(self, ev) -> bool:
        """Account for one line of this market's stream. False for a feed row,
        which is consumed here and never reaches a hook."""
        kind = ev.get("kind")
        if kind in ("ref", "ext"):
            row = {k: v for k, v in ev.items() if k not in ("kind", "name")}
            self.rows_for(ev.get("name")).append(row)
            return False
        # A spot value is quiet, not counted as an event seen (harness.mjs).
        if kind != "spot":
            self.seen += 1
        # Stop maintaining this book once opening quotes are known; replay has its
        # own book. Keep in sync with observe() in runner/harness/node/harness.mjs.
        if kind == "book" and self.open_quotes is None:
            if ev.get("snapshot"):
                self.book.snapshot(ev.get("ts_ms") or 0, ev.get("levels") or {})
            elif ev.get("side") and ev.get("ladder"):
                if ev.get("mirror") is True and self.entry["market"].get("kind") == "generic":
                    self.book.delta_mirrored(ev.get("ts_ms") or 0, ev["side"], ev["ladder"], ev.get("px"), ev.get("size"))
                else:
                    self.book.delta(ev.get("ts_ms") or 0, ev["side"], ev["ladder"], ev.get("px"), ev.get("size"))
            up, down = self.book.best("UP"), self.book.best("DOWN")
            if up is not None and down is not None:
                self.open_quotes = (up, down)
        return True


def run_job(job: dict, load_class, next_line, emit) -> int:
    """Run one job. Returns the exit code; every result leaves through `emit`.

    load_class()   -> the strategy class, or raises RunAbort (E_ENTRY / E_HOOK_SIG)
    next_line()    -> the next stream line without its newline, or None at end
    emit(ch, text) -> deliver one output line on a channel
    """
    limits = job.get("limits") or {}
    monitor = BudgetMonitor(limit_micros=limits.get("perEventBudgetMicros", 400))
    log_budget = make_log_budget(
        limits.get("logBytesPerRun", LOG_BYTES_PER_RUN),
        limits.get("logLineChars", LOG_LINE_CHARS),
    )
    fees = fee_policy(job)
    resting = resting_policy(job)
    engine = engine_policy(job)
    order_stats = new_order_stats() if engine else None
    # Taker size by the age of the level it took, see harness.mjs.
    book_age = new_book_age()
    fill_extras = engine_fill_fields(engine)
    hooks = job.get("hooks") or {}
    session = job.get("mode") == "session"

    result = {
        "markets_run": 0,
        "events_seen": 0,
        "fees_paid": 0,
        "log_truncated": False,
        "budget": None,
        "market_summaries": [],
        "crosschecks": [],
        "rejection": None,
        "maker": None,
    }

    def log(text):
        emit(CHANNEL_LOG, text.replace("\n", " ").rstrip())

    # The recorder, see emitRecord in harness.mjs.
    record = {"rows": 0, "bytes": 0, "truncated": False, "instance": 0} if engine and engine.get("record_ms") else None
    # Counted where samples are made, see recordBudget in harness.mjs.
    record_budget = {"rows": 0, "limit": MAX_RECORD_ROWS, "truncated": False} if record is not None else None

    def emit_record(entry, rows):
        if record_budget["truncated"]:
            record["truncated"] = True
            return
        inst = entry.get("instance")
        key = (f"{entry['market']['market_id']}#"
               f"{inst if isinstance(inst, int) and not isinstance(inst, bool) else record['instance']}")
        record["instance"] += 1
        for r in rows or []:
            if record["truncated"]:
                return
            payload = _record_payload(project_row({"key": key, **r}, RECORD_FIELDS))
            nbytes = line_bytes(CHANNEL_RECORD, payload)
            if record["rows"] + 1 > MAX_RECORD_ROWS or record["bytes"] + nbytes > MAX_RECORD_BYTES:
                record["truncated"] = True
                return
            record["rows"] += 1
            record["bytes"] += nbytes
            emit(CHANNEL_RECORD, payload)

    def finish(code: int) -> int:
        result["budget"] = monitor.summary()
        if record is not None:
            result["record"] = {"rows": record["rows"], "bytes": record["bytes"], "truncated": record["truncated"] or record_budget["truncated"]}
        if order_stats is not None:
            result["orders"] = order_stats
        if book_age["fills"] > 0:
            result["book_age"] = book_age
        emit(CHANNEL_RESULT, _DUMPS(result))
        return code

    def flush(pf: Portfolio, before: dict, market_id) -> None:
        for row in pf.trades[before["trades"]:]:
            emit(CHANNEL_TRADE, _DUMPS(project_row(row, GENERIC_TRADE_FIELDS if "label" in row else TRADE_FIELDS)))
        # A session drain holds back maker rows of markets still open, see
        # flush in the Node harness.
        held = []
        for row in pf.fills[before["fills"]:]:
            if market_id is True and row_pending(row):
                held.append(row)
                continue
            base = GENERIC_FILL_FIELDS if "label" in row else FILL_FIELDS
            emit(CHANNEL_FILL, _DUMPS(project_row(row, base + fill_extras if fill_extras else base)))
        if market_id:
            del pf.trades[before["trades"]:]
            del pf.fills[before["fills"]:]
            pf.fills.extend(held)

    try:
        klass = load_class()
    except RunAbort as err:
        result["rejection"] = {"code": err.code, "detail": err.detail}
        return finish(EXIT_REJECTED)

    shared = Portfolio(fees=fees, engine=engine, order_stats=order_stats, book_age=book_age) if session else None
    shared_instance = None

    def start(m: _Market) -> None:
        """Build the replay for a market and open it (on_market_open)."""
        nonlocal shared_instance
        entry = m.entry
        pf = shared if shared is not None else Portfolio(fees=fees, engine=engine, order_stats=order_stats,
                                                         book_age=book_age)
        if shared is not None:
            if shared_instance is None:
                shared_instance = klass()
            instance = shared_instance
        else:
            instance = klass()
        # A fresh copy per market: writing to ctx.p in one market must not
        # change behaviour in the next.
        instance.p = dict(job.get("params") or {})
        m.before = {"trades": len(pf.trades), "fills": len(pf.fills)}
        refs = entry.get("references") or []
        series = entry.get("series") or []
        m.replay = MarketReplay(
            market=entry["market"],
            stream=entry.get("stream"),
            spot_declared=job.get("spot") is True,
            strategy=instance,
            hooks=hooks,
            portfolio=pf,
            fill_delay_ms=job.get("fillDelayMs", 0),
            log_budget=log_budget,
            budget=monitor,
            seed=job.get("seed", 1),
            references=build_feeds(refs, {n: m.rows_for(n) for n in refs}, entry.get("lags") or {}),
            series=build_feeds(series, {n: m.rows_for(n) for n in series}, entry.get("lags") or {}),
            resting=resting,
            terminal=entry.get("terminal"),
            engine=engine,
            clock=m.clock,
            record_budget=record_budget,
        )
        m.replay.open(m.open_ts)

    def finished(m: _Market, out: dict) -> None:
        """Book-keeping once a market has been replayed and settled."""
        entry = m.entry
        result["markets_run"] += 1
        result["events_seen"] += m.seen
        emit(CHANNEL_PROGRESS, _DUMPS({"n": result["markets_run"]}))
        if out["log_truncated"] and not result["log_truncated"]:
            result["log_truncated"] = True
            emit(CHANNEL_LOG, "[runner] log budget spent -- the rest of this"
                 " run's ctx.log output was dropped. ctx.log is for reading,"
                 " not for exporting; see the SDK docs for the limit.")
        prefix = _log_prefix(entry["market"])
        for line in out["logs"]:
            log(f"{prefix} {line}\n")
        result["crosschecks"].extend(out["crosschecks"])
        if out.get("maker"):
            result["maker"] = add_maker_stats(result["maker"] or new_maker_stats(), out["maker"])
        if engine and engine.get("timers") and out.get("timers"):
            t = result.setdefault("timers", {"created": 0, "fired": 0, "dropped": 0})
            for k in ("created", "fired", "dropped"):
                t[k] += out["timers"].get(k, 0)
        # The spot dataset, see `finished` in harness.mjs.
        if job.get("spot") is True:
            s = result.setdefault("spot", {"markets": 0, "markets_without": 0})
            if out.get("spot_seen", 0) > 0:
                s["markets"] += 1
            else:
                s["markets_without"] += 1
        oq = m.open_quotes
        result["market_summaries"].append({
            "market_id": entry["market"]["market_id"],
            "asset": entry["market"].get("asset"),
            "interval": entry["market"].get("interval"),
            "outcome": entry["market"].get("outcome"),
            "up_px": oq[0] if oq else None,
            "down_px": oq[1] if oq else None,
            "stream": entry.get("stream"),
        })
        if record is not None and shared is None:
            emit_record(entry, out.get("record"))
        if shared is None:
            flush(m.replay.pf, m.before, entry["market"]["market_id"])
            result["fees_paid"] += m.replay.pf.fees_paid
        else:
            # Drain session logs without changing positions or accumulated fees,
            # keeping emitted-row memory bounded.
            flush(shared, {"trades": 0, "fills": 0}, True)

    def rejected(m: _Market | None, err: Exception) -> int:
        mid = m.entry["market"]["market_id"] if m else "?"
        if isinstance(err, RunAbort):
            result["rejection"] = {"code": err.code, "detail": f"{mid}: {err.detail}"}
            if shared is not None:
                flush(shared, {"trades": 0, "fills": 0}, True)
            elif m is not None and m.replay is not None:
                flush(m.replay.pf, m.before, mid)
            return finish(EXIT_BUDGET if err.code == "E_BUDGET" else EXIT_REJECTED)
        result["rejection"] = {"code": "E_RUNTIME", "detail": f"{mid}: {err}"}
        return finish(EXIT_REJECTED)

    is_global = bool(engine) and engine.get("scheduler") == "global"
    if session:
        code = _run_session(next_line, start, finished, rejected, log, is_global)
        if code is not None:
            return code
        flush(shared, {"trades": 0, "fills": 0}, None)
        result["fees_paid"] = shared.fees_paid
        return finish(EXIT_OK)

    while True:
        header = next_line()
        if header is None:
            break
        try:
            entry = _LOADS(header)
        except json.JSONDecodeError as err:
            log(f"[runner] malformed market header: {err}\n")
            break
        m = _Market(entry)
        m.open_ts = (entry.get("market") or {}).get("open_ts_ms")
        remaining = {"n": int(entry.get("n") or 0)}
        one = [(m, 0)]
        lags = entry.get("lags") or {}

        def event_stream(m=m, remaining=remaining, one=one, lags=lags):
            while remaining["n"] > 0:
                remaining["n"] -= 1
                line = next_line()
                if line is None:
                    return
                try:
                    ev = _LOADS(line)
                except json.JSONDecodeError:
                    continue
                if is_global:
                    # Keep in sync with the Node harness: feed rows at stamp + lag.
                    if ev.get("kind") in ("ref", "ext"):
                        lag = lags.get(ev.get("name"))
                        ok = isinstance(lag, (int, float)) and not isinstance(lag, bool) and lag == lag
                        t = float(ev.get("ts_ms")) + (lag if ok else 0)
                    else:
                        t = ev.get("ts_ms")
                    if isinstance(t, (int, float)) and t > m.replay.close_ts:
                        return
                    run_due(one, t, False)
                    advance_clock(m.clock, t)
                if m.observe(ev):
                    yield ev

        def drain_rest(remaining=remaining):
            """Consume what replay did not, so the stream stays framed."""
            while remaining["n"] > 0:
                remaining["n"] -= 1
                if next_line() is None:
                    return

        try:
            start(m)
            for ev in event_stream():
                if not m.replay.step(ev):
                    break
            if is_global:
                r = m.replay
                end = r.trade_until if r.generic else (r.declared_close if r.declared_close else r.last_ts)
                run_due(one, end, True)
                advance_clock(m.clock, end)
            out = m.replay.close()
        except Exception as err:  # noqa: BLE001
            drain_rest()
            return rejected(m, err)
        drain_rest()
        finished(m, out)

    return finish(EXIT_OK)


def run_due(markets, t, inclusive) -> None:
    """Keep in sync with runDue in runner/harness/node/harness.mjs."""
    if not isinstance(t, (int, float)) or isinstance(t, bool) or t != t:
        return
    while True:
        best = None
        for m, k in markets:
            r = m.replay
            d = r.next_due() if r is not None and hasattr(r, "next_due") else None
            if d is None or (d["at"] > t if inclusive else d["at"] >= t):
                continue
            if best is None or (d["at"], d["rank"], k, d["seq"]) < (best[0]["at"], best[0]["rank"], best[2], best[0]["seq"]):
                best = (d, m, k)
        if best is None:
            return
        advance_clock(best[1].clock, best[0]["at"])
        best[1].replay.run_one()


def advance_clock(clock, t) -> None:
    """The run has reached `t`. Keep in sync with advanceClock in harness.mjs."""
    if clock is None or not isinstance(t, (int, float)) or isinstance(t, bool) or t != t:
        return
    if isinstance(t, float) and t.is_integer():
        t = int(t)
    if t > clock["t"]:
        clock["t"] = t

def _session_global(msg, active, ending, start, finished, rejected, clock):
    """One session line under the global scheduler, Keep in sync with sessionGlobal."""
    def everyone():
        return [(m, k) for k, m in active.items()] + [(m, k) for k, m in ending.items()]

    t = msg.get("t") if isinstance(msg.get("t"), (int, float)) and not isinstance(msg.get("t"), bool) else None
    if "open" in msg:
        entry = msg["open"]
        m = _Market(entry, clock)
        m.open_ts = t
        try:
            if t is not None:
                run_due(everyone(), t, False)
            advance_clock(clock, t)
            active[entry.get("i")] = m
            start(m)
        except Exception as err:  # noqa: BLE001
            return rejected(m, err)
        return None
    if "end" in msg:
        m = active.get(msg["end"])
        if m is None:
            return None
        try:
            run_due(everyone(), t if t is not None else m.replay.trade_until, True)
            advance_clock(clock, t if t is not None else m.replay.trade_until)
            active.pop(msg["end"], None)
            ending[msg["end"]] = m
            m.replay.end_trading()
        except Exception as err:  # noqa: BLE001
            return rejected(m, err)
        return None
    if "close" in msg:
        m = active.get(msg["close"])
        if m is None:
            m = ending.get(msg["close"])
        if m is None:
            return None
        try:
            r = m.replay
            run_due(everyone(), t if t is not None else (r.declared_close if r.declared_close else r.last_ts), True)
            advance_clock(clock, t if t is not None else (r.declared_close if r.declared_close else r.last_ts))
            active.pop(msg["close"], None)
            ending.pop(msg["close"], None)
            out = r.close(t)
        except Exception as err:  # noqa: BLE001
            return rejected(m, err)
        finished(m, out)
        return None
    m = active.get(msg.get("i"))
    ev = msg.get("e")
    if m is None or not isinstance(ev, dict):
        return None
    try:
        if t is not None:
            run_due(everyone(), t, False)
        advance_clock(m.clock, t)
        if m.observe(ev):
            m.replay.step(ev)
    except Exception as err:  # noqa: BLE001
        return rejected(m, err)
    return None


def _run_session(next_line, start, finished, rejected, log, is_global=False):
    """The session stream: every open market replayed from one time order.

    Returns an exit code if the run ended early, None when the stream ended
    cleanly with every market closed.
    """
    active: dict = {}
    # Generic markets past `end` and before `close`, see runSession.
    ending: dict = {}
    # Global scheduler: one clock for every market of the session.
    clock = {"t": float("-inf")}

    def settle_earlier(except_, ts):
        """Drain strictly earlier work in other markets before a hook at ts.
        Keep in sync with settleEarlier in runner/harness/node/harness.mjs."""
        if not isinstance(ts, (int, float)) or isinstance(ts, bool) or ts != ts or ts in (float("inf"), float("-inf")):
            return
        for other in active.values():
            if other is not except_ and not other.replay.ended:
                other.replay.drain_until(ts - 1)

    while True:
        line = next_line()
        if line is None:
            break
        try:
            msg = _LOADS(line)
        except json.JSONDecodeError as err:
            log(f"[runner] malformed session line: {err}\n")
            break
        if not isinstance(msg, dict):
            continue
        if is_global:
            code = _session_global(msg, active, ending, start, finished, rejected, clock)
            if code is not None:
                return code
            continue
        if "open" in msg:
            entry = msg["open"]
            m = _Market(entry)
            try:
                settle_earlier(None, (entry.get("market") or {}).get("open_ts_ms"))
                active[entry.get("i")] = m
                start(m)
            except Exception as err:  # noqa: BLE001
                return rejected(m, err)
            continue
        if "end" in msg:
            m = active.get(msg["end"])
            if m is None:
                continue
            try:
                settle_earlier(m, m.replay.trade_until)
                active.pop(msg["end"], None)
                ending[msg["end"]] = m
                m.replay.end_trading()
            except Exception as err:  # noqa: BLE001
                return rejected(m, err)
            continue
        if "close" in msg:
            m = active.get(msg["close"])
            if m is None:
                m = ending.get(msg["close"])
            if m is None:
                continue
            try:
                # The instant it settles at: its declared close, or the last
                # event it saw when it has none (MarketReplay.close does the same).
                r = m.replay
                settle_earlier(m, r.declared_close if r.declared_close else r.last_ts)
                active.pop(msg["close"], None)
                ending.pop(msg["close"], None)
                out = r.close()
            except Exception as err:  # noqa: BLE001
                return rejected(m, err)
            finished(m, out)
            continue
        m = active.get(msg.get("i"))
        ev = msg.get("e")
        if m is None or not isinstance(ev, dict):
            continue
        if not m.observe(ev):
            continue
        try:
            settle_earlier(m, ev.get("ts_ms"))
            m.replay.step(ev)
        except Exception as err:  # noqa: BLE001
            return rejected(m, err)
    # A stream that ended with markets still open was cut short; close them so
    # what did happen is reported, and the worker's count catches the rest.
    for m in list(active.values()) + list(ending.values()):
        try:
            out = m.replay.close()
        except Exception as err:  # noqa: BLE001
            return rejected(m, err)
        finished(m, out)
    return None
