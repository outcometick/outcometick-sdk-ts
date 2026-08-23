#!/usr/bin/env python3
"""Static analysis of a submitted Python strategy.

The mirror of runner/analyze/javascript.mjs, and it must stay a mirror: the two
languages are advertised as having identical semantics, so a construct rejected
in one and accepted in the other is a broken promise, not a quirk.

A real parse via the stdlib `ast`, never a regex. `Math.random` in a docstring
is not a call and `# import os` is a comment; a regex cannot tell the
difference, and the docs promise that a local `ot check` pass is not rejected on
submit. A false positive here breaks that promise.

Reads a JSON job on stdin and writes a JSON verdict on stdout:

    {"files": [{"name": "strategy.py", "content": "..."}], "deps": ["numpy"]}
    -> {"ok": true, "imports": ["numpy"]}
    -> {"ok": false, "code": "E_IMPORT", "detail": "...", "file": "...", "line": 3}
"""

import ast
import json
import sys

# Modules a strategy may import beyond its declared deps. `outcometick` is the
# SDK itself; the rest are pure-computation stdlib with no clock, no I/O and no
# entropy. `random` is NOT here — seeded randomness is ctx.random.
ALWAYS_ALLOWED = {
    "outcometick",
    "math",
    "statistics",
    "itertools",
    "functools",
    "collections",
    "dataclasses",
    "enum",
    "typing",
    "decimal",
    "fractions",
    "heapq",
    "bisect",
    "array",
    "json",
    "re",
    "abc",
    "operator",
    "copy",
    "string",
}

# Imports that are refused with the reason a submitter can act on.
FORBIDDEN_IMPORTS = {
    "os": "the filesystem and the environment are not reachable",
    "sys": "interpreter state differs between workers",
    "io": "the filesystem is not reachable",
    "pathlib": "the filesystem is not reachable",
    "shutil": "the filesystem is not reachable",
    "tempfile": "the scratch tmpfs is managed by the runner",
    "subprocess": "subprocesses are not available",
    "multiprocessing": "parallelism is across markets, not inside a strategy",
    "threading": "threads are not available; parallelism is across markets",
    "concurrent": "threads are not available; parallelism is across markets",
    "asyncio": "the runner owns the loop",
    "socket": "there is no network in the sandbox",
    "ssl": "there is no network in the sandbox",
    "http": "there is no network in the sandbox",
    "urllib": "there is no network in the sandbox",
    "requests": "there is no network in the sandbox",
    "ctypes": "native extensions are not available",
    "importlib": "dynamic import escapes static analysis",
    "builtins": "reaches every builtin the allowlist refuses",
    "pickle": "pickle executes arbitrary code on load",
    "marshal": "marshal executes arbitrary code on load",
    "inspect": "reflection escapes static analysis",
    "gc": "interpreter state differs between workers",
    "resource": "interpreter state differs between workers",
    "platform": "host state differs between workers",
    "getpass": "host state differs between workers",
    "uuid": "unseeded randomness; use ctx.random(seed)",
    "secrets": "unseeded randomness; use ctx.random(seed)",
    "random": "unseeded randomness; use ctx.random(seed)",
    "time": "the wall clock is not readable; event time is ctx.now",
    "datetime": "the wall clock is not readable; event time is ctx.now",
    "calendar": "the wall clock is not readable; event time is ctx.now",
    "locale": "locale changes number formatting, which breaks byte-identical reports",
}

# Names that are a door around every other check in this file.
#
# `__builtins__.open(...)` and `__builtins__.eval(...)` reach exactly the
# builtins FORBIDDEN_CALLS refuses, and neither is a bare call nor a dunder
# ATTRIBUTE, so both slipped through. The name itself has to go.
FORBIDDEN_NAMES = {
    "__builtins__": "reaches every builtin the allowlist refuses",
    "builtins": "reaches every builtin the allowlist refuses",
    "__loader__": "the module loader reaches the filesystem",
    "__spec__": "the module loader reaches the filesystem",
    "globals": "reflection escapes static analysis",
}

# Names that escape analysis or read the wall clock, called bare.
FORBIDDEN_CALLS = {
    "eval": ("E_FORBIDDEN", "eval escapes static analysis"),
    "exec": ("E_FORBIDDEN", "exec escapes static analysis"),
    "compile": ("E_FORBIDDEN", "compile escapes static analysis"),
    "__import__": ("E_FORBIDDEN", "dynamic import escapes static analysis"),
    "open": ("E_FORBIDDEN", "the filesystem is not reachable"),
    "input": ("E_FORBIDDEN", "there is no stdin"),
    "globals": ("E_FORBIDDEN", "reflection escapes static analysis"),
    "locals": ("E_FORBIDDEN", "reflection escapes static analysis"),
    "vars": ("E_FORBIDDEN", "reflection escapes static analysis"),
    "getattr": ("E_FORBIDDEN", "dynamic attribute access escapes static analysis"),
    "setattr": ("E_FORBIDDEN", "dynamic attribute access escapes static analysis"),
    "delattr": ("E_FORBIDDEN", "dynamic attribute access escapes static analysis"),
}


class Reject(Exception):
    def __init__(self, code, detail, file=None, line=None, **extra):
        super().__init__(detail)
        self.payload = {"ok": False, "code": code, "detail": detail}
        if file:
            self.payload["file"] = file
        if line:
            self.payload["line"] = line
        self.payload.update(extra)


def root_module(name):
    """`numpy.linalg` is allowed by declaring `numpy`; the root is what counts."""
    return (name or "").split(".")[0]


def check_import(module, name, line, deps, relative_ok):
    root = root_module(module)
    if not root:
        # A bare relative import (`from . import x`) has no module name. The
        # submitted-file check upstream is what validates those.
        if relative_ok:
            return
        raise Reject("E_IMPORT", "relative import outside the submission", name, line)
    if root in FORBIDDEN_IMPORTS:
        code = (
            "E_NONDETERMINISM"
            if root in {"random", "secrets", "uuid", "time", "datetime", "calendar", "locale", "gc", "resource", "platform", "getpass"}
            else "E_FORBIDDEN"
        )
        raise Reject(code, f"{name}:{line}: import {root} — {FORBIDDEN_IMPORTS[root]}", name, line)
    # `outcometick` is allowed as the SDK module and nothing else. In the
    # sandbox it is a single flat module -- Strategy and Order -- so
    # `outcometick.data` resolves to nothing there, even though pip installs it
    # as a real submodule. Allowing it because the ROOT matches would mean
    # `ot check` passing a strategy that dies on import after being queued,
    # which is the exact failure the "if it passes locally it will not be
    # rejected on submit" promise exists to prevent.
    #
    # The JavaScript analyser has always compared the whole specifier, so
    # `outcometick/data` was already refused there. This is the Python half of
    # the same rule.
    if root == "outcometick" and module != "outcometick":
        raise Reject(
            "E_IMPORT",
            f"{name}:{line}: import of {module!r} — only 'outcometick' itself is "
            "available to a strategy; the sandbox has no network and no submodules",
            name,
            line,
            specifier=module,
        )
    if root in ALWAYS_ALLOWED or root in deps:
        return
    raise Reject(
        "E_IMPORT",
        f"{name}:{line}: import of {root!r} is not on the allowlist"
        + (f"; declared deps are {', '.join(deps)}" if deps else " and no deps were declared"),
        name,
        line,
        specifier=root,
    )


def analyze_source(source, name, deps):
    try:
        tree = ast.parse(source, filename=name)
    except SyntaxError as err:
        raise Reject("E_ENTRY", f"{name}:{err.lineno}: {err.msg}", name, err.lineno) from err

    imports = []
    # Names bound anywhere in the file.
    #
    # Used ONLY to decide that a module-level global reference is really a
    # local. It is deliberately NOT used to excuse a forbidden builtin any
    # more: `def on_tick(self, ctx, tick, getattr=getattr)` binds the name
    # `getattr` while the DEFAULT VALUE captures the real builtin, and the
    # shadowing exemption then waved the whole thing through. A rule whose
    # exemption is itself the attack is not a rule.
    bound = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Name) and isinstance(node.ctx, (ast.Store, ast.Del)):
            bound.add(node.id)
        elif isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            bound.add(node.name)
            args = getattr(node, "args", None)
            if args:
                for a in list(args.posonlyargs) + list(args.args) + list(args.kwonlyargs):
                    bound.add(a.arg)
                if args.vararg:
                    bound.add(args.vararg.arg)
                if args.kwarg:
                    bound.add(args.kwarg.arg)
        elif isinstance(node, (ast.Import, ast.ImportFrom)):
            for alias in node.names:
                bound.add(alias.asname or root_module(alias.name))

    for node in ast.walk(tree):
        if isinstance(node, ast.arg) and node.arg in FORBIDDEN_CALLS:
            # `def f(open=open)` — the parameter NAME is an ast.arg and the
            # default is an ast.Name, so both halves need refusing.
            code, why = FORBIDDEN_CALLS[node.arg]
            raise Reject(
                code,
                f"{name}:{node.lineno}: a parameter named {node.arg!r} — {why}",
                name,
                node.lineno,
            )

        if isinstance(node, ast.Import):
            for alias in node.names:
                imports.append(alias.name)
                check_import(alias.name, name, node.lineno, deps, relative_ok=False)
        elif isinstance(node, ast.ImportFrom):
            if node.level and node.level > 0:
                # Relative: the submitter's own module. Recorded so the caller
                # can check it was actually submitted.
                imports.append("." * node.level + (node.module or ""))
                continue
            imports.append(node.module or "")
            check_import(node.module, name, node.lineno, deps, relative_ok=False)

        elif isinstance(node, ast.Name):
            # Regardless of binding: see the note on `bound` above.
            if node.id in FORBIDDEN_CALLS:
                code, why = FORBIDDEN_CALLS[node.id]
                raise Reject(
                    code,
                    f"{name}:{node.lineno}: {node.id} — {why}. It cannot be used "
                    "as a name either; rename the variable or parameter.",
                    name,
                    node.lineno,
                )
            if node.id in FORBIDDEN_NAMES:
                raise Reject(
                    "E_FORBIDDEN",
                    f"{name}:{node.lineno}: {node.id} — {FORBIDDEN_NAMES[node.id]}",
                    name,
                    node.lineno,
                )

        elif isinstance(node, ast.Attribute):
            # An attribute whose NAME is a forbidden builtin, however it was
            # reached: obj.open(...), obj.eval(...). The receiver does not
            # matter — if we cannot see what it is, we cannot allow the call.
            if node.attr in FORBIDDEN_CALLS:
                code, why = FORBIDDEN_CALLS[node.attr]
                raise Reject(
                    code,
                    f"{name}:{node.lineno}: .{node.attr} — {why}",
                    name,
                    node.lineno,
                )
            # A private attribute on anything that is not `self`.
            #
            # Not a blanket rule: `self._entered` is ordinary Python and
            # refusing it would reject working strategies. But `ctx._pf`,
            # `ctx.book()._b` and `obj._anything` are reaching into something
            # that belongs to the engine.
            if (
                node.attr.startswith("_")
                and not node.attr.startswith("__")
                and not (isinstance(node.value, ast.Name) and node.value.id == "self")
            ):
                raise Reject(
                    "E_FORBIDDEN",
                    f"{name}:{node.lineno}: .{node.attr} — private attributes of engine "
                    "objects are not reachable; use the documented methods",
                    name,
                    node.lineno,
                )
            # Dunder attribute access is the standard escape hatch out of any
            # allowlist: __class__, __globals__, __subclasses__.
            if node.attr.startswith("__") and node.attr.endswith("__") and node.attr not in {"__init__", "__name__", "__doc__"}:
                raise Reject(
                    "E_FORBIDDEN",
                    f"{name}:{node.lineno}: {node.attr} — reflection escapes static analysis",
                    name,
                    node.lineno,
                )

    return imports


def main():
    try:
        job = json.load(sys.stdin)
    except json.JSONDecodeError as err:
        print(json.dumps({"ok": False, "code": "E_MANIFEST", "detail": f"bad job: {err}"}))
        return 2

    files = job.get("files") or []
    deps = set(job.get("deps") or [])
    names = {f.get("name") for f in files}
    all_imports = []

    try:
        for f in files:
            name = f.get("name") or ""
            if not name.endswith(".py"):
                continue
            imports = analyze_source(f.get("content") or "", name, deps)
            for spec in imports:
                if not spec.startswith("."):
                    continue
                # A relative import must resolve to a file that was submitted,
                # or the run fails after the credits are held.
                target = spec.lstrip(".")
                if target and f"{target}.py" not in names:
                    raise Reject(
                        "E_ENTRY",
                        f"{name} imports {spec!r}, which was not submitted",
                        name,
                    )
            all_imports.extend(imports)
    except Reject as r:
        print(json.dumps(r.payload))
        return 1

    print(json.dumps({"ok": True, "imports": sorted(set(all_imports))}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
