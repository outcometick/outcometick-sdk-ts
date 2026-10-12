#!/usr/bin/env python3
"""Static analysis of submitted Python strategies using the stdlib ast parser.
Keep validation rules in sync with runner/analyze/javascript.mjs.

Read a JSON job on stdin and write a JSON verdict on stdout:

    {"files": [{"name": "strategy.py", "content": "..."}], "deps": ["numpy"]}
    -> {"ok": true, "imports": ["numpy"], "feeds": [{"kind": "ref", "name": "...", "file": "...", "line": 9}]}
    -> {"ok": false, "code": "E_IMPORT", "detail": "...", "file": "...", "line": 3}"""

import ast
import json
import sys

# SDK and computation modules available without declared deps.
# Use ctx.random for seeded randomness; random is excluded.
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

# Names that expose forbidden builtins or module loaders without a bare call
# or dunder attribute access.
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
    # The sandbox provides only the flat outcometick SDK module, not installed
    # submodules such as outcometick.data. Keep in sync with the JS import check.
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


def binding_counts(root):
    """How many times each name is bound anywhere under `root`."""
    binds = {}

    def bind(n):
        if n:
            binds[n] = binds.get(n, 0) + 1

    for node in ast.walk(root):
        if isinstance(node, ast.Name) and isinstance(node.ctx, (ast.Store, ast.Del)):
            bind(node.id)
        elif isinstance(node, ast.arg):
            bind(node.arg)
        elif isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            bind(node.name)
        elif isinstance(node, ast.alias):
            bind((node.asname or node.name).split(".")[0])
        # The bindings that are plain strings rather than Name nodes.
        elif isinstance(node, (ast.ExceptHandler, ast.MatchAs, ast.MatchStar)):
            bind(node.name)
        elif isinstance(node, ast.MatchMapping):
            bind(node.rest)
        elif type(node).__name__ in ("TypeVar", "ParamSpec", "TypeVarTuple"):
            bind(node.name)
    return binds


def feed_calls(tree, name, entry, hook_methods):
    """Collect known ctx.ref/ctx.ext calls and checkable ctx.p reads (kind 'param').

    Only inspect the entry class's declared hooks with an unrebound context
    parameter. Names must be string literals or uniquely bound module constants.
    Skip uncertain reads to avoid false rejections; see param_reads_checkable."""
    binds = binding_counts(tree)
    consts = {}
    for stmt in tree.body:
        target = value = None
        if isinstance(stmt, ast.Assign) and len(stmt.targets) == 1 and isinstance(stmt.targets[0], ast.Name):
            target, value = stmt.targets[0].id, stmt.value
        elif isinstance(stmt, ast.AnnAssign) and isinstance(stmt.target, ast.Name) and stmt.value is not None:
            target, value = stmt.target.id, stmt.value
        if target and binds.get(target) == 1 and isinstance(value, ast.Constant) and isinstance(value.value, str):
            consts[target] = value.value

    found = []
    # Check all files: helper modules may add params. main() combines the results.
    checkable = param_reads_checkable(tree, consts)
    if not entry or name != entry.get("file"):
        return found, checkable
    class_name = entry.get("className")
    # Require a unique class binding; the runner uses the module's final binding.
    if binds.get(class_name) != 1:
        return found, checkable
    # `self.on_tick = ...` anywhere replaces the method the runner would call.
    assigned_attrs = {n.attr for n in ast.walk(tree)
                      if isinstance(n, ast.Attribute) and isinstance(n.ctx, (ast.Store, ast.Del))}
    for cls in tree.body:
        if not (isinstance(cls, ast.ClassDef) and cls.name == class_name):
            continue
        defined = {}
        for member in cls.body:
            for n in ast.walk(member) if isinstance(member, (ast.Assign, ast.AnnAssign, ast.AugAssign)) else [member]:
                if isinstance(n, ast.Name) and isinstance(n.ctx, ast.Store):
                    defined[n.id] = defined.get(n.id, 0) + 1
            if isinstance(member, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
                defined[member.name] = defined.get(member.name, 0) + 1
        for fn in cls.body:
            if not (isinstance(fn, (ast.FunctionDef, ast.AsyncFunctionDef)) and fn.name in hook_methods):
                continue
            # Only a hook whose definition is certainly the one dispatched.
            if fn.decorator_list or defined.get(fn.name) != 1 or fn.name in assigned_attrs:
                continue
            params = fn.args.posonlyargs + fn.args.args
            if len(params) < 2:
                continue
            ctx_name = params[1].arg
            if binding_counts(fn).get(ctx_name) != 1:
                continue
            for node in ast.walk(fn):
                if not (isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute)
                        and node.func.attr in ("ref", "ext")
                        and isinstance(node.func.value, ast.Name) and node.func.value.id == ctx_name):
                    continue
                if len(node.args) != 1 or node.keywords:
                    continue
                arg = node.args[0]
                if isinstance(arg, ast.Constant) and isinstance(arg.value, str):
                    value = arg.value
                elif isinstance(arg, ast.Name) and arg.id in consts:
                    value = consts[arg.id]
                else:
                    continue
                found.append({"kind": node.func.attr, "name": value, "file": name, "line": node.lineno})
            found.extend(param_reads(fn, ctx_name, consts, name))
    # Source order: the first undeclared call in the file is the one a
    # rejection should point at.
    found.sort(key=lambda f: f["line"])
    return found, checkable


# Reads that resolve on the dict itself, never on a param: `ctx.p.get(...)`.
DICT_ATTRS = frozenset(dir(dict))


def _is_p(node):
    return isinstance(node, ast.Attribute) and node.attr == "p"


def _const_str(node, consts):
    if isinstance(node, ast.Constant) and isinstance(node.value, str):
        return node.value
    if isinstance(node, ast.Name) and node.id in consts:
        return consts[node.id]
    return None


def param_reads_checkable(tree, consts):
    """Return whether param reads are checkable and which names the file guards.

    Missing Rec params raise at runtime. Writes, aliases, helper calls, iteration,
    **ctx.p or unsupported dict methods can change or guard params, so disable
    checks for those uses. Skip names guarded by literal in, .keys(), .get()
    or hasattr checks."""
    guarded = set()
    parents = {}
    for node in ast.walk(tree):
        for child in ast.iter_child_nodes(node):
            parents[id(child)] = node
    for node in ast.walk(tree):
        if not _is_p(node):
            continue
        if not isinstance(node.ctx, ast.Load):
            return False, guarded
        up = parents.get(id(node))
        if isinstance(up, (ast.Attribute, ast.Subscript)) and up.value is node:
            if not isinstance(up.ctx, ast.Load):
                return False, guarded
            if isinstance(up, ast.Attribute) and up.attr in DICT_ATTRS:
                call = parents.get(id(up))
                if not (isinstance(call, ast.Call) and call.func is up):
                    return False, guarded
                if up.attr == "get":
                    # `ctx.p.get("x")` can guard a later `ctx.p.x`.
                    key = _const_str(call.args[0], consts) if call.args else None
                    if key is None:
                        return False, guarded
                    guarded.add(key)
                    continue
                # `x in ctx.p.keys()` tests a name like `x in ctx.p` does. Any
                # other dict method, iterating items() included, could
                # guard a name unseen, or put one there.
                comp = parents.get(id(call))
                if not (up.attr == "keys" and isinstance(comp, ast.Compare) and call in comp.comparators
                        and _guard_compare(comp, call, consts, guarded)):
                    return False, guarded
            continue
        if isinstance(up, ast.Compare) and node in up.comparators:
            if not _guard_compare(up, node, consts, guarded):
                return False, guarded
            continue
        if isinstance(up, ast.Call) and isinstance(up.func, ast.Name) and up.func.id in ("hasattr", "getattr") \
                and up.args and up.args[0] is node:
            key = _const_str(up.args[1], consts) if len(up.args) > 1 else None
            if key is None or key in DICT_ATTRS:
                return False, guarded
            guarded.add(key)
            continue
        return False, guarded
    return True, guarded


def _guard_compare(comp, right, consts, guarded):
    """`"x" in ctx.p`: record the name. False when it cannot be known."""
    i = comp.comparators.index(right)
    if not isinstance(comp.ops[i], (ast.In, ast.NotIn)):
        return False
    key = _const_str(comp.comparators[i - 1] if i else comp.left, consts)
    if key is None:
        return False
    guarded.add(key)
    return True


def param_reads(fn, ctx_name, consts, name):
    """`ctx.p.x` / `ctx.p["x"]` reads in one hook, outside try and with bodies
    and anything that runs deferred (nested def / lambda / generator)."""
    shielded = set()
    for node in ast.walk(fn):
        body = []
        if isinstance(node, (ast.Try, getattr(ast, "TryStar", ast.Try))) and node.handlers:
            body = node.body
        elif isinstance(node, (ast.With, ast.AsyncWith)):
            # Any context manager's __exit__ can swallow the error (suppress is
            # only the common one).
            body = node.body
        if node is not fn and isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.Lambda,
                                                ast.ClassDef, ast.GeneratorExp)):
            # Runs later, or never, from wherever it is called: no telling
            # whether that is inside a try.
            body = [node]
        for stmt in body:
            shielded.update(id(n) for n in ast.walk(stmt))
    found = []
    for node in ast.walk(fn):
        if id(node) in shielded or not isinstance(getattr(node, "ctx", None), ast.Load):
            continue
        if not (isinstance(node, (ast.Attribute, ast.Subscript)) and _is_p(node.value)
                and isinstance(node.value.value, ast.Name) and node.value.value.id == ctx_name):
            continue
        if isinstance(node, ast.Attribute):
            key = None if node.attr in DICT_ATTRS else node.attr
        else:
            key = _const_str(node.slice, consts)
        if key is None:
            continue
        found.append({"kind": "param", "name": key, "file": name, "line": node.lineno})
    return found


def analyze_source(source, name, deps, entry=None, hook_methods=()):
    try:
        tree = ast.parse(source, filename=name)
    except SyntaxError as err:
        raise Reject("E_ENTRY", f"{name}:{err.lineno}: {err.msg}", name, err.lineno) from err

    imports = []
    # Bound names distinguish locals from unknown module globals. Forbidden
    # builtins remain rejected: default parameters can capture the builtin.
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
            # Check parameter names and default expressions separately.
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
            # Reject attributes named after forbidden builtins, regardless of receiver.
            if node.attr in FORBIDDEN_CALLS:
                code, why = FORBIDDEN_CALLS[node.attr]
                raise Reject(
                    code,
                    f"{name}:{node.lineno}: .{node.attr} — {why}",
                    name,
                    node.lineno,
                )
            # Allow private attributes on self for strategy state. Other receivers may
            # expose engine internals, such as ctx._pf or ctx.book()._b.
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

    feeds, checkable = feed_calls(tree, name, entry, set(hook_methods))
    return imports, feeds, checkable


def main():
    try:
        job = json.load(sys.stdin)
    except json.JSONDecodeError as err:
        print(json.dumps({"ok": False, "code": "E_MANIFEST", "detail": f"bad job: {err}"}))
        return 2

    files = job.get("files") or []
    deps = set(job.get("deps") or [])
    entry = job.get("entry")
    hook_methods = job.get("hookMethods") or []
    names = {f.get("name") for f in files}
    all_imports = []
    all_feeds = []
    params_ok, guarded = True, set()

    try:
        for f in files:
            name = f.get("name") or ""
            if not name.endswith(".py"):
                continue
            imports, feeds, (ok, file_guarded) = analyze_source(f.get("content") or "", name, deps, entry, hook_methods)
            all_feeds.extend(feeds)
            params_ok = params_ok and ok
            guarded |= file_guarded
            for spec in imports:
                if not spec.startswith("."):
                    continue
                # Relative imports must resolve within the submitted files.
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

    all_feeds = [f for f in all_feeds
                 if f["kind"] != "param" or (params_ok and f["name"] not in guarded)]
    print(json.dumps({"ok": True, "imports": sorted(set(all_imports)), "feeds": all_feeds}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
