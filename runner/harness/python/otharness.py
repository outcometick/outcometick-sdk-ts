"""How a job is run: the loop between the job stream and the replay engine.

Shared by the sandbox harness (harness.py, which owns stdin/stdout and loads
the submitted file) and the pure-Python local backtest (outcometick.backtest,
which hands over a class from a notebook and an in-memory stream). One loop, so
a local run and a queued run cannot differ in how markets are framed, how the
session portfolio is shared, how logs are prefixed or how the result is
counted. The mirror of the loop in runner/harness/node/harness.mjs.

The stream is the one the worker writes (runner/stdin-writer.mjs callers):

  market mode    a header {market, stream, n, references?, series?, lags?}
                 followed by exactly n event lines, per market.
  session mode   {"open": {i, market, stream, references?, series?, lags?}},
                 {"i": k, "e": <event>} and {"close": k}, in ONE time order
                 across every market (runner/session-feed.mjs). Markets that
                 overlap are replayed interleaved, so a strategy instance shared
                 across them never sees a later moment of one before an earlier
                 moment of another.
"""

from __future__ import annotations

import datetime as _datetime
import json

from otengine import Book as _Book, BudgetMonitor, Portfolio, RunAbort
from otfeed import build_feeds
from otreplay import MarketReplay, make_log_budget, LOG_BYTES_PER_RUN, LOG_LINE_CHARS

CHANNEL_TRADE = "t"
CHANNEL_FILL = "f"
CHANNEL_LOG = "l"
CHANNEL_RESULT = "r"
# "I have finished replaying market-day N." Display only, and the mirror of
# CHANNEL.progress in protocol.mjs -- see the long note there. Both engines or
# neither: runner/conformance compares them line by line.
CHANNEL_PROGRESS = "p"

EXIT_OK = 0
EXIT_REJECTED = 10
EXIT_BUDGET = 11

# Bound before any submitted code runs (the harness imports this module first),
# so a strategy that rebinds json.loads at import time cannot reach the stream.
_LOADS = json.loads

# Our own JSON writer — the mirror of `stringify` in harness.mjs, and for the
# same reason: the harness shares a process with the submitted code, so anything
# reached through a module attribute at call time is reachable by the strategy
# too. Nothing below looks anything up.
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
FILL_FIELDS = (
    "ts_ms", "market_id", "side", "action", "requested", "filled", "unfilled",
    "avg_px", "worst_px", "quoted_px", "levels_walked", "fee", "realised", "tag",
)


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


def _log_prefix(market: dict) -> str:
    # Opening time first, then a short id -- MUST MATCH the Node harness.
    sid = str(market.get("market_id") or "")[:10]
    opened = market.get("open_ts_ms")
    if opened is None:
        return sid
    dt = _datetime.datetime.fromtimestamp(opened / 1000, _datetime.timezone.utc)
    return f"{dt.strftime('%Y-%m-%d %H:%M')} {sid}"


class _Market:
    """What the loop tracks for one open market, besides the replay itself."""

    __slots__ = ("entry", "replay", "seen", "book", "open_quotes", "feed_rows", "before")

    def __init__(self, entry: dict) -> None:
        self.entry = entry
        self.replay = None
        self.seen = 0
        # The book as the ENGINE sees it, advanced by the same class, for the
        # opening quotes the worker prices baselines off.
        self.book = _Book(entry["market"]["market_id"])
        self.open_quotes = None
        self.feed_rows: dict = {}
        self.before = None

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
        self.seen += 1
        if kind == "book" and ev.get("snapshot"):
            self.book.snapshot(ev.get("ts_ms") or 0, ev.get("levels") or {})
        elif kind == "book" and ev.get("side") and ev.get("ladder"):
            self.book.delta(ev.get("ts_ms") or 0, ev["side"], ev["ladder"], ev.get("px"), ev.get("size"))
        if kind == "book" and self.open_quotes is None:
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
    }

    def log(text):
        emit(CHANNEL_LOG, text.replace("\n", " ").rstrip())

    def finish(code: int) -> int:
        result["budget"] = monitor.summary()
        emit(CHANNEL_RESULT, _DUMPS(result))
        return code

    def flush(pf: Portfolio, before: dict, market_id) -> None:
        for row in pf.trades[before["trades"]:]:
            emit(CHANNEL_TRADE, _DUMPS(project_row(row, TRADE_FIELDS)))
        for row in pf.fills[before["fills"]:]:
            emit(CHANNEL_FILL, _DUMPS(project_row(row, FILL_FIELDS)))
        if market_id:
            del pf.trades[before["trades"]:]
            del pf.fills[before["fills"]:]

    try:
        klass = load_class()
    except RunAbort as err:
        result["rejection"] = {"code": err.code, "detail": err.detail}
        return finish(EXIT_REJECTED)

    shared = Portfolio(fees=fees) if session else None
    shared_instance = None

    def start(m: _Market) -> None:
        """Build the replay for a market and open it (on_market_open)."""
        nonlocal shared_instance
        entry = m.entry
        pf = shared if shared is not None else Portfolio(fees=fees)
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
            strategy=instance,
            hooks=hooks,
            portfolio=pf,
            fill_delay_ms=job.get("fillDelayMs", 0),
            log_budget=log_budget,
            budget=monitor,
            seed=job.get("seed", 1),
            references=build_feeds(refs, {n: m.rows_for(n) for n in refs}, entry.get("lags") or {}),
            series=build_feeds(series, {n: m.rows_for(n) for n in series}, entry.get("lags") or {}),
        )
        m.replay.open()

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
        if shared is None:
            flush(m.replay.pf, m.before, entry["market"]["market_id"])
            result["fees_paid"] += m.replay.pf.fees_paid
        else:
            # Session: drain what the shared portfolio has written so far --
            # its positions and running fee total stay -- so a long session
            # holds one market's worth of rows, not the whole run's.
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

    if session:
        code = _run_session(next_line, start, finished, rejected, log)
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
        remaining = {"n": int(entry.get("n") or 0)}

        def event_stream(m=m, remaining=remaining):
            while remaining["n"] > 0:
                remaining["n"] -= 1
                line = next_line()
                if line is None:
                    return
                try:
                    ev = _LOADS(line)
                except json.JSONDecodeError:
                    continue
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
            out = m.replay.close()
        except Exception as err:  # noqa: BLE001
            drain_rest()
            return rejected(m, err)
        drain_rest()
        finished(m, out)

    return finish(EXIT_OK)


def _run_session(next_line, start, finished, rejected, log):
    """The session stream: every open market replayed from one time order.

    Returns an exit code if the run ended early, None when the stream ended
    cleanly with every market closed.
    """
    active: dict = {}

    def settle_earlier(except_, ts):
        """Before ANY hook at instant `ts` -- an opening, an event, a closing --
        every other open market settles what it had scheduled strictly earlier.
        MUST MATCH settleEarlier in runner/harness/node/harness.mjs."""
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
        if "close" in msg:
            m = active.get(msg["close"])
            if m is None:
                continue
            try:
                # The instant it settles at: its declared close, or the last
                # event it saw when it has none (MarketReplay.close does the same).
                r = m.replay
                settle_earlier(m, r.declared_close if r.declared_close else r.last_ts)
                active.pop(msg["close"], None)
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
    for m in list(active.values()):
        try:
            out = m.replay.close()
        except Exception as err:  # noqa: BLE001
            return rejected(m, err)
        finished(m, out)
    return None
