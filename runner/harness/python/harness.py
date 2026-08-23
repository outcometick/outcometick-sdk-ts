#!/usr/bin/env python3
"""The Python harness. Runs INSIDE the sandbox, in the same process as the
submitted strategy.

The mirror of runner/harness/node/harness.mjs: same job file, same output files,
same exit codes. The worker does not know or care which language produced a
run's logs, which is what stops the report shape depending on the customer's
choice of language.

    python3 harness.py <job-dir>      job on stdin, results on fd 3
"""

from __future__ import annotations

import hashlib
import hmac
import importlib.util
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from otengine import BudgetMonitor, Portfolio, RunAbort  # noqa: E402
from otreplay import replay_market  # noqa: E402

# Results go out over FD 3, authenticated — see the long note in protocol.mjs.
# /out used to be a writable bind mount, and a strategy declaring the allowed
# `pandas` could rewrite trades.jsonl from on_settle, after being told the
# official outcome.
RESULT_FD = 3
CHANNEL_TRADE = "t"
CHANNEL_FILL = "f"
CHANNEL_LOG = "l"
CHANNEL_RESULT = "r"

EXIT_OK = 0
EXIT_REJECTED = 10
EXIT_BUDGET = 11

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


def load_strategy_class(src_dir: str, entry: dict):
    """Import the submitted module and resolve the class by EXACT name.

    No discovery. A module that exports one class under a different name is a
    rejection rather than a guess — guessing is how a run silently executes
    something other than what the submitter meant.

    Note this is the one place the submitted code is executed at import time,
    which is exactly why the static analyser refuses import-time side effects
    and why this runs inside the sandbox rather than in the validator.
    """
    file_name = entry["file"]
    path = os.path.join(src_dir, file_name)
    module_name = os.path.splitext(os.path.basename(file_name))[0]
    spec = importlib.util.spec_from_file_location(module_name, path)
    if spec is None or spec.loader is None:
        raise RunAbort("E_ENTRY", f"could not load {file_name}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[module_name] = module
    try:
        spec.loader.exec_module(module)
    except Exception as err:  # noqa: BLE001
        raise RunAbort("E_ENTRY", f"could not load {file_name}: {err}") from err

    klass = getattr(module, entry["className"], None)
    if not isinstance(klass, type):
        exported = [k for k in vars(module) if not k.startswith("_") and isinstance(vars(module)[k], type)]
        detail = f'{file_name} does not define a class named {entry["className"]}'
        if exported:
            detail += f'; it defines {", ".join(sorted(exported))}'
        raise RunAbort("E_ENTRY", detail)
    return klass


def check_hooks(klass, hooks: dict) -> None:
    """A declared-but-missing hook is a rejection, found before anything runs."""
    for canonical, name in hooks.items():
        fn = getattr(klass, name, None)
        if not callable(fn):
            raise RunAbort(
                "E_HOOK_SIG",
                f"{canonical} was declared but {name}() is not defined on the class",
            )


# The parser, bound at import — BEFORE any strategy is loaded.
#
# `import json` is on the strategy allowlist and `json.loads = ...` passes
# static analysis, so an unbound lookup would let a strategy see every row the
# harness decodes. Defence in depth behind the streaming below.
_LOADS = json.loads


def read_line(stream):
    """One line off the job stream, or None at end.

    The job arrives on stdin rather than as files, and events are pulled ONE AT
    A TIME as the replay loop asks for them — see the long note on
    syncLineReader in harness.mjs. The previous version decoded a whole
    market's events before replay started, which put the future in the process
    and only required the strategy to intercept `json.loads` at import time to
    steal it.
    """
    line = stream.readline()
    if not line:
        return None
    return line.rstrip("\n")


def main() -> int:
    if len(sys.argv) < 2:
        sys.stderr.write("usage: harness.py <job-dir>   (job on stdin, results on fd 3)\n")
        return 2
    job_dir = sys.argv[1]

    stream = sys.stdin
    first = read_line(stream)
    if first is None:
        sys.stderr.write("no job on stdin\n")
        return 2
    job = _LOADS(first)
    src_dir = os.path.join(job_dir, "src")

    limits = job.get("limits") or {}
    monitor = BudgetMonitor(limit_micros=limits.get("perEventBudgetMicros", 400))

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

    output_key = str(job.get("outputKey") or "")
    if not output_key:
        sys.stderr.write("no output key in the job\n")
        return 2
    key_bytes = output_key.encode("utf-8")

    def emit(channel, payload):
        mac = hmac.new(
            key_bytes, f"{channel} {payload}".encode("utf-8"), hashlib.sha256
        ).hexdigest()[:32]
        os.write(RESULT_FD, f"{mac} {channel} {payload}\n".encode("utf-8"))

    class _Logs:
        @staticmethod
        def write(text):
            emit(CHANNEL_LOG, text.replace("\n", " ").rstrip())

    logs_fh = _Logs()

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
            # Keep memory flat across hundreds of market-days.
            del pf.trades[before["trades"]:]
            del pf.fills[before["fills"]:]

    try:
        klass = load_strategy_class(src_dir, job["entry"])
        check_hooks(klass, job.get("hooks") or {})
    except RunAbort as err:
        result["rejection"] = {"code": err.code, "detail": err.detail}
        return finish(EXIT_REJECTED)

    shared = Portfolio(fee_bps=job.get("feeBps", 0)) if job.get("mode") == "session" else None
    shared_instance = None

    # Markets stream in, one at a time, for as long as the worker sends them.
    while True:
        header = read_line(stream)
        if header is None:
            break
        try:
            entry = _LOADS(header)
        except json.JSONDecodeError as err:
            logs_fh.write(f"[runner] malformed market header: {err}\n")
            break

        # Pulled one at a time as replay asks. Nothing here holds more than the
        # current row — that is what makes "future rows are not in the process"
        # literally true rather than approximately true.
        counters = {"n": int(entry.get("n") or 0), "seen": 0, "last_book": None}

        def event_stream():
            while counters["n"] > 0:
                counters["n"] -= 1
                line = read_line(stream)
                if line is None:
                    return
                try:
                    ev = _LOADS(line)
                except json.JSONDecodeError:
                    # Corruption in OUR data, not the strategy's problem.
                    continue
                counters["seen"] += 1
                if ev.get("kind") == "book" and ev.get("snapshot"):
                    counters["last_book"] = ev
                yield ev

        def drain_rest():
            """Consume what replay did not, so the stream stays framed."""
            while counters["n"] > 0:
                counters["n"] -= 1
                if read_line(stream) is None:
                    return

        pf = shared if shared is not None else Portfolio(fee_bps=job.get("feeBps", 0))
        if shared is not None:
            if shared_instance is None:
                shared_instance = klass()
            instance = shared_instance
        else:
            instance = klass()
        # A fresh copy per instance — see the matching comment in harness.mjs.
        instance.p = dict(job.get("params") or {})

        before = {"trades": len(pf.trades), "fills": len(pf.fills)}

        try:
            out = replay_market(
                market=entry["market"],
                events=event_stream(),
                strategy=instance,
                hooks=job.get("hooks") or {},
                portfolio=pf,
                fill_delay_ms=job.get("fillDelayMs", 0),
                log_limit=limits.get("logLinesPerMarketDay", 10_000),
                budget=monitor,
                seed=job.get("seed", 1),
                fee_bps=job.get("feeBps", 0),
            )
        except RunAbort as err:
            drain_rest()
            result["rejection"] = {
                "code": err.code,
                "detail": f'{entry["market"]["market_id"]}: {err.detail}',
            }
            flush(pf, before, entry["market"]["market_id"])
            return finish(EXIT_BUDGET if err.code == "E_BUDGET" else EXIT_REJECTED)
        except Exception as err:  # noqa: BLE001
            result["rejection"] = {
                "code": "E_RUNTIME",
                "detail": f'{entry["market"]["market_id"]}: {err}',
            }
            return finish(EXIT_REJECTED)

        drain_rest()
        result["markets_run"] += 1
        result["events_seen"] += counters["seen"]
        if out["log_truncated"]:
            result["log_truncated"] = True
        for line in out["logs"]:
            logs_fh.write(f'{entry["market"]["market_id"]} {line}\n')
        result["crosschecks"].extend(out["crosschecks"])

        # Tracked as the stream went past; there is no array left to scan.
        lb = counters["last_book"] or {}
        levels = lb.get("levels") or {}
        up_asks = (levels.get("UP") or {}).get("asks") or []
        down_asks = (levels.get("DOWN") or {}).get("asks") or []
        up_px = up_asks[0][0] if up_asks else None
        down_px = down_asks[0][0] if down_asks else None
        result["market_summaries"].append({
            "market_id": entry["market"]["market_id"],
            "asset": entry["market"].get("asset"),
            "interval": entry["market"].get("interval"),
            "outcome": entry["market"].get("outcome"),
            "up_px": up_px,
            "down_px": down_px,
            "stream": entry.get("stream"),
        })

        if shared is None:
            flush(pf, before, entry["market"]["market_id"])
            result["fees_paid"] += pf.fees_paid

    if shared is not None:
        flush(shared, {"trades": 0, "fills": 0}, None)
        result["fees_paid"] = shared.fees_paid

    return finish(EXIT_OK)


if __name__ == "__main__":
    sys.exit(main())
