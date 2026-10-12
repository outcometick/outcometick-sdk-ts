#!/usr/bin/env python3
"""Python sandbox entrypoint, running in the strategy's process.
Keep job framing, authenticated output and exit codes in sync with
runner/harness/node/harness.mjs.

    python3 harness.py <job-dir>      job on stdin, results on stdout"""

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

# Duplicate stdout for authenticated results before importing strategy code,
# then redirect fd 1 to /dev/null to discard strategy output. Docker exposes
# only stdin/stdout/stderr, so results use stdout rather than a fourth pipe.
# /proc/self/fd remains addressable; MACs protect result authenticity.
# See protocol.mjs for the protocol and its limits.
RESULT_FD = os.dup(1)
_devnull = os.open(os.devnull, os.O_WRONLY)
os.dup2(_devnull, 1)
os.close(_devnull)


def _print_is_gone(*_args, **_kwargs):
    """Warn once on stderr that print() is discarded. ot run displays stderr."""
    if not _print_is_gone.warned:
        _print_is_gone.warned = True
        try:
            sys.stderr.write("harness: print() output is discarded -- use ctx.log() instead\n")
        except Exception:
            pass  # stderr is not worth crashing a run over


_print_is_gone.warned = False
builtins.print = _print_is_gone


def load_strategy_class(src_dir: str, entry: dict):
    """Import the submitted module and resolve the class named in the manifest.

    Import executes submitted code, so this runs inside the sandbox, not in
    the static validator."""
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


# Capture the parser before loading strategy code to prevent json.loads
# rebinding from intercepting the job stream.
_LOADS = json.loads


def read_line(stream):
    """Read one job-stream line, or return None at EOF.

    Replay pulls events as needed rather than decoding a whole market up front."""
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
