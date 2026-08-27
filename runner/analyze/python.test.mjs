import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyzePythonSubmission } from './python.mjs';
import { BacktestRejection } from '../../api/lib/backtest-contract.mjs';

const OK = `from outcometick import Strategy, Order


class MeanReversion(Strategy):
    def on_market_open(self, ctx, market):
        self.entered = False

    def on_tick(self, ctx, tick):
        z = ctx.zscore(tick.value, window=180)
        if self.entered or abs(z) < ctx.p.entry_z:
            return None
        self.entered = True
        return Order(side="UP", size=ctx.p.size, limit=ctx.book().best("UP"))
`;

const py = (content, name = 'strategy.py') => [{ name, content }];

async function rejects(code, files, deps = []) {
  try {
    await analyzePythonSubmission(files, { deps });
  } catch (err) {
    assert.ok(err instanceof BacktestRejection, `expected a rejection, got ${err}`);
    assert.equal(err.code, code, `expected ${code}, got ${err.code}: ${err.detail}`);
    return err;
  }
  assert.fail(`expected ${code}, nothing thrown`);
  return null;
}

// ---------------------------------------------------------------------------
// happy path
// ---------------------------------------------------------------------------

test('a normal strategy passes', async () => {
  const { imports } = await analyzePythonSubmission(py(OK));
  assert.ok(imports.includes('outcometick'));
});

test('pure-computation stdlib is allowed without declaring it', async () => {
  const src = 'import math\nimport statistics\nfrom collections import deque\nx = math.sqrt(2)\n';
  await assert.doesNotReject(() => analyzePythonSubmission(py(src)));
});

test('a declared dep is allowed, including its submodules', async () => {
  await assert.doesNotReject(() => analyzePythonSubmission(
    py('import numpy as np\nfrom numpy.linalg import norm\n'), { deps: ['numpy'] },
  ));
});

// ---------------------------------------------------------------------------
// imports
// ---------------------------------------------------------------------------

test('an undeclared package is refused', async () => {
  const err = await rejects('E_IMPORT', py('import pandas as pd\n'));
  assert.equal(err.specifier, 'pandas');
  await assert.doesNotReject(() => analyzePythonSubmission(py('import pandas as pd\n'), { deps: ['pandas'] }));
});

test('the filesystem, subprocesses and the network are refused', async () => {
  await rejects('E_FORBIDDEN', py('import os\n'));
  await rejects('E_FORBIDDEN', py('import subprocess\n'));
  await rejects('E_FORBIDDEN', py('import socket\n'));
  await rejects('E_FORBIDDEN', py('from urllib.request import urlopen\n'));
  await rejects('E_FORBIDDEN', py('import ctypes\n'));
});

test('threads are refused — parallelism is across markets', async () => {
  await rejects('E_FORBIDDEN', py('import threading\n'));
  await rejects('E_FORBIDDEN', py('import multiprocessing\n'));
  await rejects('E_FORBIDDEN', py('import asyncio\n'));
});

test('the wall clock and unseeded randomness are non-determinism, not merely forbidden', async () => {
  // The distinct code matters: it tells the submitter to reach for ctx.now and
  // ctx.random rather than to go looking for a permission to request.
  await rejects('E_NONDETERMINISM', py('import time\n'));
  await rejects('E_NONDETERMINISM', py('from datetime import datetime\n'));
  await rejects('E_NONDETERMINISM', py('import random\n'));
  await rejects('E_NONDETERMINISM', py('import secrets\n'));
  await rejects('E_NONDETERMINISM', py('import uuid\n'));
});

test('pickle and marshal are refused — they execute on load', async () => {
  await rejects('E_FORBIDDEN', py('import pickle\n'));
  await rejects('E_FORBIDDEN', py('import marshal\n'));
});

// ---------------------------------------------------------------------------
// calls and reflection
// ---------------------------------------------------------------------------

test('escapes from static analysis are refused', async () => {
  await rejects('E_FORBIDDEN', py('x = eval("1+1")\n'));
  await rejects('E_FORBIDDEN', py('exec("x = 1")\n'));
  await rejects('E_FORBIDDEN', py('m = __import__("os")\n'));
  await rejects('E_FORBIDDEN', py('f = open("/etc/passwd")\n'));
});

test('dynamic attribute access and dunder reflection are refused', async () => {
  await rejects('E_FORBIDDEN', py('x = getattr(obj, "foo")\n'));
  const err = await rejects('E_FORBIDDEN', py('cls = ().__class__.__base__.__subclasses__()\n'));
  assert.match(err.detail, /reflection/);
});

test('ordinary dunders a strategy legitimately writes are allowed', async () => {
  // __init__ on the class is normal; rejecting it would fail every strategy
  // that has one.
  await assert.doesNotReject(() => analyzePythonSubmission(py(
    'class S:\n    def __init__(self):\n        self.x = 1\n',
  )));
});

// ---------------------------------------------------------------------------
// false positives
// ---------------------------------------------------------------------------

test('a forbidden name in a comment or a docstring is not a call', async () => {
  await assert.doesNotReject(() => analyzePythonSubmission(py(
    '# import os would be refused\n"""eval() escapes analysis"""\nx = 1\n',
  )));
});

test('a forbidden builtin is refused even as a parameter or a local', async () => {
  // This asserted the opposite until the default-argument capture was found:
  // `def on_tick(self, ctx, tick, getattr=getattr)` binds the name while the
  // DEFAULT captures the real builtin, and the shadowing exemption let it
  // through — straight to `getattr(ctx, "_s")` and the live engine state.
  await rejects('E_FORBIDDEN', py('def f(open):\n    return open + 1\n'));
  await rejects('E_FORBIDDEN', py(
    'class S:\n    def on_tick(self, ctx, tick, getattr=getattr):\n        return getattr(ctx, "_s")\n',
  ));
  await rejects('E_FORBIDDEN', py(
    'class S:\n    def on_tick(self, ctx, tick, eval=eval):\n        return eval("1")\n',
  ));
  // And captured by assignment rather than by parameter.
  await rejects('E_FORBIDDEN', py('g = getattr\nx = g(object, "x")\n'));
});

test('a syntax error is E_ENTRY with the line', async () => {
  const err = await rejects('E_ENTRY', py('def f(\n'));
  assert.equal(err.file, 'strategy.py');
  assert.ok(err.line >= 1);
});

// ---------------------------------------------------------------------------
// whole submission
// ---------------------------------------------------------------------------

test('every submitted py file is analysed, not just the entry', async () => {
  const err = await rejects('E_FORBIDDEN', [
    { name: 'strategy.py', content: OK },
    { name: 'signals.py', content: 'import os\n' },
  ]);
  assert.equal(err.file, 'signals.py');
});

test('a relative import must resolve to a submitted file', async () => {
  await assert.doesNotReject(() => analyzePythonSubmission([
    { name: 'strategy.py', content: 'from .signals import zscore\n' },
    { name: 'signals.py', content: 'def zscore(a):\n    return a\n' },
  ]));
  await rejects('E_ENTRY', [
    { name: 'strategy.py', content: 'from .signals import zscore\n' },
  ]);
});

test('non-python files are left alone', async () => {
  await assert.doesNotReject(() => analyzePythonSubmission([
    { name: 'strategy.py', content: OK },
    { name: 'outcometick.json', content: '{"schema":1}' },
    { name: 'signal.csv', content: 'ts_ms,v\n1,2\n' },
  ]));
});

// ---------------------------------------------------------------------------
// parity with the JavaScript analyser
// ---------------------------------------------------------------------------

test('both languages refuse the same categories', async () => {
  // The two runtimes are advertised as having identical semantics. A construct
  // rejected in one and accepted in the other is a broken promise.
  const { analyzeJavaScript } = await import('./javascript.mjs');
  const jsRejects = (src) => {
    try { analyzeJavaScript(src, 'x.mjs'); return null; } catch (e) { return e.code; }
  };

  assert.equal(jsRejects('eval("1")'), 'E_FORBIDDEN');
  await rejects('E_FORBIDDEN', py('eval("1")\n'));

  assert.equal(jsRejects('Date.now()'), 'E_NONDETERMINISM');
  await rejects('E_NONDETERMINISM', py('import time\n'));

  assert.equal(jsRejects('Math.random()'), 'E_NONDETERMINISM');
  await rejects('E_NONDETERMINISM', py('import random\n'));

  assert.equal(jsRejects('await fetch("http://x")'), 'E_FORBIDDEN');
  await rejects('E_FORBIDDEN', py('import socket\n'));
});

test('__builtins__ is refused — it is a door around every builtin check', async () => {
  // The analyser rejected bare open()/eval(), but __builtins__.open(...) is
  // neither a bare call nor a dunder ATTRIBUTE, so it walked straight past both
  // checks and reached the filesystem.
  await rejects('E_FORBIDDEN', py('__builtins__.open("/etc/passwd")\n'));
  await rejects('E_FORBIDDEN', py('__builtins__.eval("1+1")\n'));
  await rejects('E_FORBIDDEN', py('__builtins__.__import__("os")\n'));
  await rejects('E_FORBIDDEN', py('import builtins\n'));
  await rejects('E_FORBIDDEN', py('x = __loader__\n'));
});

test('a forbidden builtin reached as an attribute of anything is refused', async () => {
  // The receiver does not matter: if we cannot see what it is, we cannot allow
  // the call.
  await rejects('E_FORBIDDEN', py('obj.open("/etc/passwd")\n'));
  await rejects('E_FORBIDDEN', py('mod.eval("1")\n'));
});

test('reaching into an engine object private attribute is refused', async () => {
  // ctx.book()._b was the live Book, and Python has no privacy — a strategy
  // inserted a level that never existed and filled 1000 contracts at $0.01 in a
  // market whose real book held 10 at $0.90.
  await rejects('E_FORBIDDEN', py('b = ctx.book()._b\n'));
  await rejects('E_FORBIDDEN', py('x = ctx._pf.trades\n'));
  await rejects('E_FORBIDDEN', py('y = obj._anything\n'));
});

test('a strategy own private attributes are still fine', async () => {
  // The rule cannot be a blanket one: self._entered is ordinary Python and
  // refusing it would reject working strategies.
  await assert.doesNotReject(() => analyzePythonSubmission(py(
    'class S:\n'
    + '    def on_market_open(self, ctx, market):\n'
    + '        self._entered = False\n'
    + '        self._n = 0\n\n'
    + '    def on_tick(self, ctx, tick):\n'
    + '        self._n += 1\n'
    + '        return None\n',
  )));
});

test('outcometick is importable as the SDK, never as a package prefix', async () => {
  // In the sandbox `outcometick` is one flat module — Strategy and Order. pip
  // additionally ships `outcometick.data`, the HTTP client for the data
  // subscription, which resolves to nothing inside a container that has no
  // network. Allowing it because the ROOT segment matched would mean `ot check`
  // passing a strategy that dies on import after being queued.
  //
  // The JavaScript analyser compares the whole specifier and always refused
  // `outcometick/data`; this is the Python half of the same rule.
  const strategy = (imp) => [{
    name: 'strategy.py',
    content: `${imp}\n\n\nclass S:\n    def on_tick(self, ctx, t):\n        return None\n`,
  }];

  for (const imp of ['from outcometick.data import DataClient', 'import outcometick.data']) {
    const err = await analyzePythonSubmission(strategy(imp), { deps: [] })
      .then(() => null, (e) => e);
    assert.ok(err, `${imp} should be rejected`);
    assert.equal(err.code, 'E_IMPORT');
    assert.match(err.detail, /only 'outcometick' itself/);
  }

  // The SDK itself stays importable, both spellings.
  for (const imp of ['from outcometick import Strategy, Order', 'import outcometick']) {
    await analyzePythonSubmission(strategy(imp), { deps: [] });
  }
});

// The docs tell people to split a strategy across files. That instruction is
// only true in one spelling.
//
// `/docs/sdk` used to say nothing at all about multi-file submissions; when the
// section was written the first draft said "relative imports between them
// work" and showed `from helpers import cheaper`, which this analyser rejects
// with E_IMPORT — a bare module name is not on the allowlist and there is no
// way for the reader to guess that the dot is the difference. These two cases
// are what that paragraph now promises, so they are pinned here: a doc sentence
// nothing enforces is a doc sentence that drifts.
test('a sibling file is importable relatively, and only relatively', async () => {
  const files = [
    {
      name: 'strategy.py',
      content: `from outcometick import Strategy, Order
from .helpers import cheaper


class Demo(Strategy):
    def on_tick(self, ctx, tick):
        return None
`,
    },
    { name: 'helpers.py', content: 'def cheaper(a, b):\n    return a\n' },
  ];
  const { imports } = await analyzePythonSubmission(files, { deps: [] });
  assert.ok(Array.isArray(imports), 'the relative form must be accepted');
});

test('the same import without the dot is rejected', async () => {
  const files = [
    {
      name: 'strategy.py',
      content: `from outcometick import Strategy, Order
from helpers import cheaper


class Demo(Strategy):
    def on_tick(self, ctx, tick):
        return None
`,
    },
    { name: 'helpers.py', content: 'def cheaper(a, b):\n    return a\n' },
  ];
  await rejects('E_IMPORT', files);
});
