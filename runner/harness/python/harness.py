#!/usr/bin/env python3
"""The Python harness. Runs INSIDE the sandbox, in the same process as the
submitted strategy.

The mirror of runner/harness/node/harness.mjs: same job file, same output files,
same exit codes. The worker does not know or care which language produced a
run's logs, which is what stops the report shape depending on the customer's
choice of language.

    python3 harness.py <job-dir>      job on stdin, results on stdout
"""

from __future__ import annotations

import builtins
import hashlib
import hmac
import importlib.util
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from otengine import RunAbort  # noqa: E402
from otreplay import write_all  # noqa: E402
from otharness import run_job  # noqa: E402

# Results go out over stdout, authenticated — see the long note in protocol.mjs.
# /out used to be a writable bind mount, and a strategy declaring the allowed
# `pandas` could rewrite trades.jsonl from on_settle, after being told the
# official outcome.
# The authenticated result channel.
#
# Docker hands a container stdin/stdout/stderr and nothing else. The worker
# spawns `docker run` with a fourth pipe, but that fd belongs to the docker
# CLIENT — inside the container fd 3 is closed, and every write to it failed
# with EBADF. That is why no containerised run had ever produced a result.
#
# So the real stdout is duplicated to a private fd and fd 1 is pointed at
# /dev/null, HERE, before any strategy code is imported: results leave over the
# container's stdout, and a strategy's print() goes nowhere. Which was already
# the intent — the worker used to discard stdout for exactly that reason.
#
# /proc/self/fd/<n> stays addressable. The MAC is what makes forgery
# impossible, and always was.
RESULT_FD = os.dup(1)
_devnull = os.open(os.devnull, os.O_WRONLY)
os.dup2(_devnull, 1)
os.close(_devnull)


def _print_is_gone(*_args, **_kwargs):
    """print() writes to /dev/null now; say so once, on stderr.

    Not silent: a strategy author whose print() vanishes without a word will
    spend an afternoon on it. `ot run` shows stderr.
    """
    if not _print_is_gone.warned:
        _print_is_gone.warned = True
        try:
            sys.stderr.write("harness: print() output is discarded -- use ctx.log() instead\n")
        except Exception:
            pass  # stderr is not worth crashing a run over


_print_is_gone.warned = False
builtins.print = _print_is_gone


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
        sys.stderr.write("usage: harness.py <job-dir>   (job on stdin, results on stdout)\n")
        return 2
    job_dir = sys.argv[1]

    stream = sys.stdin
    first = read_line(stream)
    if first is None:
        sys.stderr.write("no job on stdin\n")
        return 2
    job = _LOADS(first)
    src_dir = os.path.join(job_dir, "src")

    output_key = str(job.get("outputKey") or "")
    if not output_key:
        sys.stderr.write("no output key in the job\n")
        return 2
    key_bytes = output_key.encode("utf-8")

    def emit(channel, payload):
        mac = hmac.new(
            key_bytes, f"{channel} {payload}".encode("utf-8"), hashlib.sha256
        ).hexdigest()[:32]
        write_all(RESULT_FD, f"{mac} {channel} {payload}\n".encode("utf-8"))

    def load_class():
        klass = load_strategy_class(src_dir, job["entry"])
        check_hooks(klass, job.get("hooks") or {})
        return klass

    return run_job(job, load_class, lambda: read_line(stream), emit)


if __name__ == "__main__":
    sys.exit(main())
