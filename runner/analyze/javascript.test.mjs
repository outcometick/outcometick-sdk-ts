import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeJavaScript, analyzeJavaScriptSubmission } from './javascript.mjs';
import { BacktestRejection } from '../../api/lib/backtest-contract.mjs';

const OK = `import { Strategy, Order } from "outcometick";

export default class S extends Strategy {
  onMarketOpen(ctx, market) { this.entered = false; }
  onTick(ctx, tick) {
    const z = ctx.zscore(tick.value, { window: 180 });
    if (this.entered || Math.abs(z) < ctx.p.entry_z) return null;
    this.entered = true;
    return new Order({ side: z > 0 ? "DOWN" : "UP", size: ctx.p.size, limit: ctx.book().best("UP") });
  }
}`;

function rejects(code, src, deps = []) {
  try {
    analyzeJavaScript(src, 'strategy.mjs', deps);
  } catch (err) {
    assert.ok(err instanceof BacktestRejection, `expected a rejection, got ${err}`);
    assert.equal(err.code, code, `expected ${code}, got ${err.code}: ${err.detail}`);
    return err;
  }
  assert.fail(`expected ${code}, nothing thrown`);
}

// ---------------------------------------------------------------------------
// the happy path must stay happy
// ---------------------------------------------------------------------------

test('a normal strategy passes', () => {
  const { imports } = analyzeJavaScript(OK, 'strategy.mjs');
  assert.deepEqual(imports, ['outcometick']);
});

test('Math is fine; Math.random is not', () => {
  // The whole point of parsing rather than grepping: Math.abs, Math.min and
  // Math.max are the arithmetic every strategy uses.
  assert.doesNotThrow(() => analyzeJavaScript(
    'export default class S { onTick(c, t) { return Math.max(0, Math.abs(t.value)); } }', 'x.mjs',
  ));
  rejects('E_NONDETERMINISM', 'export default class S { onTick() { return Math.random(); } }');
});

test('the allowed globals really are allowed', () => {
  const src = `export default class S {
    onTick(ctx, t) {
      const m = new Map(); const s = new Set(); const j = JSON.stringify({});
      return [Number(t.value), parseInt("1", 10), Object.keys(m), Array.from(s), j];
    }
  }`;
  assert.doesNotThrow(() => analyzeJavaScript(src, 'x.mjs'));
});

// ---------------------------------------------------------------------------
// syntax
// ---------------------------------------------------------------------------

test('a syntax error is E_ENTRY and names the file', () => {
  const err = rejects('E_ENTRY', 'export default class { oops(');
  assert.match(err.detail, /^strategy\.mjs:/);
});

// ---------------------------------------------------------------------------
// imports
// ---------------------------------------------------------------------------

test('an undeclared package import is refused, and a declared one is not', () => {
  rejects('E_IMPORT', 'import fs from "node:fs";');
  rejects('E_IMPORT', 'import _ from "lodash";');
  assert.doesNotThrow(() => analyzeJavaScript('import { evaluate } from "mathjs";', 'x.mjs', ['mathjs']));
});

test('the SDK itself never needs declaring', () => {
  assert.doesNotThrow(() => analyzeJavaScript('import { Strategy } from "outcometick";', 'x.mjs', []));
});

test('re-exports are imports too', () => {
  rejects('E_IMPORT', 'export * from "node:os";');
  rejects('E_IMPORT', 'export { readFile } from "node:fs";');
});

test('the rejection names the offending specifier and line', () => {
  const err = rejects('E_IMPORT', '\n\nimport x from "node:child_process";');
  assert.equal(err.specifier, 'node:child_process');
  assert.equal(err.line, 3);
});

test('dynamic import and import.meta are refused outright', () => {
  // Neither can be resolved statically, so neither can be allowlisted.
  rejects('E_FORBIDDEN', 'export default class S { async onTick() { await import("node:fs"); } }');
  rejects('E_FORBIDDEN', 'const here = import.meta.url;');
});

// ---------------------------------------------------------------------------
// forbidden constructs
// ---------------------------------------------------------------------------

test('escapes from static analysis are refused', () => {
  rejects('E_FORBIDDEN', 'export default class S { onTick() { return eval("1+1"); } }');
  rejects('E_FORBIDDEN', 'export default class S { onTick() { return new Function("return 1")(); } }');
  rejects('E_FORBIDDEN', 'const fs = require("fs");');
});

test('threads and shared memory are refused', () => {
  rejects('E_FORBIDDEN', 'new Worker("x.mjs");');
  rejects('E_FORBIDDEN', 'const b = new SharedArrayBuffer(8);');
  rejects('E_FORBIDDEN', 'Atomics.wait(a, 0, 0);');
});

test('the network is refused even though it is also absent', () => {
  // Belt and braces: the image has no network stack, but a strategy that would
  // have reached for one should be told why, not fail with a confusing DNS
  // error at run time.
  rejects('E_FORBIDDEN', 'await fetch("https://example.com");');
  rejects('E_FORBIDDEN', 'new WebSocket("wss://example.com");');
});

test('the runner owns the loop, so timers are refused', () => {
  rejects('E_FORBIDDEN', 'setTimeout(() => {}, 1);');
  rejects('E_FORBIDDEN', 'setInterval(() => {}, 1);');
});

// ---------------------------------------------------------------------------
// determinism
// ---------------------------------------------------------------------------

test('the wall clock is refused; ctx.now is the clock', () => {
  rejects('E_NONDETERMINISM', 'export default class S { onTick() { return Date.now(); } }');
  rejects('E_NONDETERMINISM', 'const t = new Date();');
  rejects('E_NONDETERMINISM', 'performance.now();');
});

test('process state is refused — it differs between workers', () => {
  rejects('E_NONDETERMINISM', 'const k = process.env.KEY;');
  rejects('E_NONDETERMINISM', 'process.hrtime.bigint();');
});

test('unseeded randomness is refused wherever it is reached from', () => {
  rejects('E_NONDETERMINISM', 'crypto.randomUUID();');
  rejects('E_NONDETERMINISM', 'crypto.getRandomValues(new Uint8Array(8));');
});

// ---------------------------------------------------------------------------
// false positives — the expensive kind of bug
// ---------------------------------------------------------------------------

test('a forbidden name in a string or a comment is not a call', () => {
  // A regex-based validator fails all three of these, and the docs promise a
  // local pass is not rejected on submit.
  assert.doesNotThrow(() => analyzeJavaScript('export const a = "Math.random() is banned";', 'x.mjs'));
  assert.doesNotThrow(() => analyzeJavaScript('// eval() would escape analysis\nexport const a = 1;', 'x.mjs'));
  assert.doesNotThrow(() => analyzeJavaScript('/* import fs from "node:fs" */ export const a = 1;', 'x.mjs'));
});

test('a property named like a banned global is not the global', () => {
  assert.doesNotThrow(() => analyzeJavaScript('export const o = { eval: 1, Date: 2, fetch: 3 };', 'x.mjs'));
  assert.doesNotThrow(() => analyzeJavaScript('export default class S { onTick(ctx) { return ctx.p.Date; } }', 'x.mjs'));
});

test('a forbidden name is refused even when it is bound locally', () => {
  // This test used to assert the OPPOSITE — that a local shadowing a banned
  // name was fine. That exemption was the attack: `onTick(ctx, t, fetch = fetch)`
  // binds the name while the DEFAULT VALUE captures the real global, and the
  // shadowing rule waved the whole thing through.
  //
  // The cost is a false positive on `function f(Date) {…}`, which renames in one
  // keystroke. The alternative was a documented way out of the allowlist.
  rejects('E_NONDETERMINISM', 'export function f(Date) { return Date + 1; }');
  rejects('E_FORBIDDEN', 'export class S { onTick(ctx, t, fetch = fetch) { return fetch("http://x"); } }');
  rejects('E_NONDETERMINISM', 'export class S { onTick(ctx, t, Date = Date) { return Date.now(); } }');

  // A name that is merely NOT on the allowlist is still fine when it is a
  // local — that is what `bound` is still for.
  assert.doesNotThrow(() => analyzeJavaScript('const helper = 1;\nexport const a = helper + 1;', 'x.mjs'));
});

test('a method named onTick on the class is not a bare identifier', () => {
  assert.doesNotThrow(() => analyzeJavaScript(OK, 'strategy.mjs'));
});

// ---------------------------------------------------------------------------
// whole-submission checks
// ---------------------------------------------------------------------------

test('a relative import must resolve to a submitted file', () => {
  const files = [
    { name: 'strategy.mjs', content: 'import { z } from "./signals.mjs";\nexport default class S {}' },
    { name: 'signals.mjs', content: 'export const z = 1;' },
  ];
  assert.doesNotThrow(() => analyzeJavaScriptSubmission(files));

  const missing = [files[0]];
  try {
    analyzeJavaScriptSubmission(missing);
    assert.fail('expected a rejection');
  } catch (err) {
    assert.equal(err.code, 'E_ENTRY');
    assert.match(err.detail, /was not submitted/);
  }
});

test('an extensionless relative import resolves against the submitted names', () => {
  const files = [
    { name: 'strategy.mjs', content: 'import { z } from "./signals";\nexport default class S {}' },
    { name: 'signals.mjs', content: 'export const z = 1;' },
  ];
  assert.doesNotThrow(() => analyzeJavaScriptSubmission(files));
});

test('every submitted js file is analysed, not just the entry', () => {
  const files = [
    { name: 'strategy.mjs', content: 'export default class S {}' },
    { name: 'helper.mjs', content: 'export const t = Date.now();' },
  ];
  try {
    analyzeJavaScriptSubmission(files);
    assert.fail('expected a rejection');
  } catch (err) {
    assert.equal(err.code, 'E_NONDETERMINISM');
    assert.equal(err.file, 'helper.mjs');
  }
});

test('non-source files are left alone', () => {
  const files = [
    { name: 'strategy.mjs', content: 'export default class S {}' },
    { name: 'outcometick.json', content: '{"schema":1}' },
    { name: 'signal.csv', content: 'ts_ms,v\n1,2\n' },
  ];
  assert.doesNotThrow(() => analyzeJavaScriptSubmission(files));
});

// ---------------------------------------------------------------------------
// the allowlist, and the escape it exists to close
// ---------------------------------------------------------------------------

test('the Function constructor is refused however it is spelled', () => {
  // Blocking the bare `Function` identifier was not enough: nobody spells it
  // that way when they are escaping. globalThis.constructor.constructor IS the
  // Function constructor, and Function("return process")() reaches the whole
  // runtime — filesystem, environment, everything the allowlist excludes.
  rejects('E_FORBIDDEN', 'const F = globalThis.constructor.constructor; F("return process")();');
  rejects('E_FORBIDDEN', 'const F = ({}).constructor.constructor;');
  rejects('E_FORBIDDEN', 'const F = [].constructor;');
  rejects('E_FORBIDDEN', 'const F = "".constructor;');
  // And by computed access, which is the same door with a different handle.
  rejects('E_FORBIDDEN', 'const F = ({})["constructor"];');
});

test('prototype pollution handles are refused', () => {
  rejects('E_FORBIDDEN', 'const p = ({}).__proto__;');
  rejects('E_FORBIDDEN', 'obj.__defineGetter__("x", () => 1);');
});

test('globalThis itself is not reachable', () => {
  rejects('E_FORBIDDEN', 'const g = globalThis;');
});

test('a global nobody thought to name is refused, because the list is an allowlist', () => {
  // The previous version enumerated what was FORBIDDEN, so every global that
  // had not been thought of — and every one added by a future runtime — walked
  // straight through.
  rejects('E_FORBIDDEN', 'Reflect.get({}, "x");');
  rejects('E_FORBIDDEN', 'const w = WebAssembly;');
  rejects('E_FORBIDDEN', 'new Intl.NumberFormat();');
  rejects('E_FORBIDDEN', 'const b = Buffer.from("x");');
  rejects('E_FORBIDDEN', 'const p = new Proxy({}, {});');
});

test('the arithmetic a real strategy needs is still allowed', () => {
  // The allowlist is only correct if it does not reject working code. Math in
  // particular was missing when the list was first enforced.
  const src = `export class S {
    onTick(ctx, t) {
      const a = Math.max(0, Math.abs(t.value));
      const b = Number.parseFloat("1.5") + parseInt("2", 10);
      const c = JSON.stringify({ a, b });
      const d = new Map([["k", 1]]).get("k");
      const e = Array.from(new Set([1, 2])).map(String);
      const f = Object.keys({ a: 1 }).length + (isNaN(a) ? 0 : 1);
      console.log(c, d, e, f);
      return null;
    }
  }`;
  assert.doesNotThrow(() => analyzeJavaScript(src, 'x.mjs'));
});

test('a computed constructor key is folded and refused', () => {
  // ["con" + "structor"] is the same door as .constructor, and checking only
  // literal keys let it through. Anything built from string literals is decided
  // statically; a genuinely dynamic key cannot be, and the container is what
  // stands behind that.
  rejects('E_FORBIDDEN', 'const F = []["con" + "structor"]["con" + "structor"];');
  rejects('E_FORBIDDEN', 'const F = ({})[`constructor`];');
  rejects('E_FORBIDDEN', 'const p = ({})["__" + "proto__"];');
});

test('ordinary indexing is untouched by that check', () => {
  // The fix must not reject array access, which every strategy does.
  assert.doesNotThrow(() => analyzeJavaScript(
    'export default class S { onTick(ctx, t) { const h = ctx.history(5); return h[h.length - 1]; } }', 'x.mjs',
  ));
  assert.doesNotThrow(() => analyzeJavaScript(
    'export default class S { onTick(ctx) { const k = "size"; return ctx.p[k]; } }', 'x.mjs',
  ));
});

test('reflective Object methods are refused — the denylist lost here', () => {
  // Blocking `.constructor` as a member access does nothing about
  //   Object.getOwnPropertyDescriptor(Object.getPrototypeOf(function(){}), 'constructor').value
  // which IS the Function constructor: the forbidden property arrives as a
  // STRING ARGUMENT, so no member rule ever sees it. Verified — that payload
  // passed analysis and returned `process`.
  rejects('E_FORBIDDEN',
    'export class S { onTick() { const F = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(function(){}), "constructor").value; return F("return process")(); } }');
  rejects('E_FORBIDDEN', 'const p = Object.getPrototypeOf({});');
  rejects('E_FORBIDDEN', 'Object.setPrototypeOf({}, null);');
  rejects('E_FORBIDDEN', 'Object.defineProperty({}, "x", { value: 1 });');
  rejects('E_FORBIDDEN', 'Object.getOwnPropertyNames({});');
  rejects('E_FORBIDDEN', 'Object.getOwnPropertySymbols({});');
});

test('the Object methods a strategy actually uses still work', () => {
  // The allowlist is only correct if it does not reject working code.
  const src = `export class S {
    onTick(ctx, t) {
      const k = Object.keys(ctx.p);
      const v = Object.values(ctx.p);
      const e = Object.entries(ctx.p);
      const o = Object.assign({}, ctx.p);
      const f = Object.fromEntries(e);
      const z = Object.freeze({ a: 1 });
      return [k, v, e, o, f, z, Object.hasOwn(o, "size"), Object.is(1, 1)].length ? null : null;
    }
  }`;
  assert.doesNotThrow(() => analyzeJavaScript(src, 'x.mjs'));
});

test('a local named Object is the local, not the global', () => {
  // `bound` still does its original job for names that are merely not on the
  // allowlist — it is only the FORBIDDEN names it no longer excuses.
  assert.doesNotThrow(() => analyzeJavaScript(
    'export function f(Object) { return Object.anything; }', 'x.mjs',
  ));
});
