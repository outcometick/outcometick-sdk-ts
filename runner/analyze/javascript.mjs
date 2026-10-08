// Static analysis of a submitted JavaScript strategy.
//
// This is the half of the determinism guarantee that runs BEFORE anything
// executes. The other half is structural — the sandbox image has no network
// stack and no writable filesystem, so those APIs are absent rather than
// blocked. What is left over is the code that would still be non-deterministic
// inside a perfect jail: a wall-clock read, an unseeded random, a thread, an
// eval. Those are what this catches.
//
// A real parse, not a regex sweep. `Math.random` inside a string literal is not
// a call, and `// eval(` is a comment — a regex cannot tell, and a validator
// that rejects working code is worse than one that is slightly slower. The docs
// promise that a local `ot check` pass is not rejected on submit, so a false
// positive here is a broken promise.

import { parse } from 'acorn';
import { BacktestRejection } from '../../api/lib/backtest-contract.mjs';

/**
 * Globals a strategy may reference.
 *
 * Deliberately tiny. Everything a strategy legitimately needs arrives through
 * `ctx`; this list is the arithmetic and data-structure surface it needs to do
 * anything with what it is given.
 */
export const ALLOWED_GLOBALS = new Set([
  'Array', 'ArrayBuffer', 'BigInt', 'Boolean', 'DataView', 'Error', 'Float32Array',
  'Float64Array', 'Infinity', 'Int8Array', 'Int16Array', 'Int32Array', 'JSON',
  'Map', 'Math', 'NaN', 'Number', 'Object', 'Promise', 'RangeError', 'ReferenceError',
  'RegExp', 'Set', 'String', 'Symbol', 'SyntaxError', 'TypeError', 'Uint8Array',
  'Uint16Array', 'Uint32Array', 'WeakMap', 'WeakSet', 'console',
  'isFinite', 'isNaN', 'parseFloat', 'parseInt', 'structuredClone', 'undefined',
  // The SDK's own surface.
  'Strategy', 'Order',
]);
// Deliberately NOT here, and each for a reason rather than by omission:
//   globalThis  the gateway to everything else on this list's other side
//   Proxy       trap handlers make what a later line does unanalysable
//   Reflect     the reflection API this whole file exists to keep out
//   Intl        locale-dependent formatting, so not reproducible
//   Date        the wall clock; event time is ctx.now (see NONDETERMINISTIC)

/**
 * Identifiers that are non-deterministic no matter how they are reached.
 *
 * `Date` is here and it is the one people are surprised by: `new Date()` reads
 * the wall clock, and two runs of the same code then differ. Event time is on
 * `ctx.now`, which is the only clock in the process.
 */
const NONDETERMINISTIC = new Map([
  ['Date', 'the wall clock is not readable; event time is ctx.now'],
  ['performance', 'the wall clock is not readable; event time is ctx.now'],
  ['process', 'process state (pid, env, hrtime, platform) differs between workers'],
]);

/**
 * Constructs that are refused outright.
 *
 * Each one either escapes the analysis (eval, dynamic import, Function) or
 * breaks the sharding guarantee (threads, subprocesses).
 */
const FORBIDDEN_IDENTIFIERS = new Map([
  ['eval', 'eval escapes static analysis'],
  ['Function', 'the Function constructor escapes static analysis'],
  ['Worker', 'threads are not available; parallelism is across markets'],
  ['SharedArrayBuffer', 'shared memory implies threads'],
  ['Atomics', 'shared memory implies threads'],
  ['require', 'CommonJS require is not available; declare deps in the manifest'],
  ['fetch', 'there is no network in the sandbox'],
  ['XMLHttpRequest', 'there is no network in the sandbox'],
  ['WebSocket', 'there is no network in the sandbox'],
  ['setTimeout', 'the runner owns the clock and the loop'],
  ['setInterval', 'the runner owns the clock and the loop'],
  ['setImmediate', 'the runner owns the clock and the loop'],
  ['queueMicrotask', 'the runner owns the clock and the loop'],
]);

/**
 * Property names that hand back the machinery of the language itself.
 *
 * `.constructor` is the important one: `globalThis.constructor.constructor` is
 * the Function constructor, and `Function("return process")()` reaches the
 * whole runtime — the filesystem, the environment, everything the allowlist was
 * supposed to exclude. Blocking the bare `Function` identifier alone was not
 * enough, because nobody spells it that way when they are trying to escape.
 */
const FORBIDDEN_PROPERTIES = new Set([
  'constructor',
  '__proto__',
  '__defineGetter__',
  '__defineSetter__',
  '__lookupGetter__',
  '__lookupSetter__',
]);

/**
 * The only `Object` methods a strategy may reach.
 *
 * An allowlist, because the denylist lost. Blocking `.constructor` as a member
 * access does nothing about
 *
 *   Object.getOwnPropertyDescriptor(Object.getPrototypeOf(function(){}), 'constructor').value
 *
 * which IS the Function constructor — the forbidden property arrives as a
 * string argument, not as a property access, so nothing in the member rules
 * sees it. Verified: that payload passed analysis and returned `process`.
 *
 * Everything below is data-shaping and cannot hand back a callable from the
 * prototype chain. Anything reflective — getPrototypeOf, defineProperty,
 * getOwnPropertyDescriptor(s), getOwnPropertyNames — is absent on purpose.
 */
const OBJECT_METHODS = new Set([
  'keys', 'values', 'entries', 'fromEntries', 'assign',
  'freeze', 'isFrozen', 'hasOwn', 'is',
]);

/** `Math.random` is the one member expression that is a rejection on its own. */
const FORBIDDEN_MEMBERS = new Map([
  ['Math.random', 'unseeded randomness; use ctx.random(seed)'],
  ['crypto.randomUUID', 'unseeded randomness; use ctx.random(seed)'],
  ['crypto.getRandomValues', 'unseeded randomness; use ctx.random(seed)'],
]);

/**
 * Walk every node of an ESTree AST.
 *
 * Written out rather than pulled in: the visitor is twenty lines and a
 * dependency here would itself need to be on an allowlist.
 */
function walk(node, visit, parent = null) {
  if (!node || typeof node.type !== 'string') return;
  visit(node, parent);
  for (const key of Object.keys(node)) {
    if (key === 'type' || key === 'loc' || key === 'range') continue;
    const child = node[key];
    if (Array.isArray(child)) {
      for (const c of child) if (c && typeof c.type === 'string') walk(c, visit, node);
    } else if (child && typeof child.type === 'string') {
      walk(child, visit, node);
    }
  }
}

/**
 * Fold a constant string expression to its value, or null if it is not one.
 *
 * Exists because `[]["con" + "structor"]["con" + "structor"]` is the Function
 * constructor, and checking only literal keys let it straight through. Anything
 * built from string literals and `+` is decided here; a genuinely dynamic key
 * (`obj[name]`) cannot be, and is handled by the caller.
 */
function foldString(node) {
  if (!node) return null;
  if (node.type === 'Literal') return typeof node.value === 'string' ? node.value : null;
  if (node.type === 'TemplateLiteral' && node.expressions.length === 0) {
    return node.quasis.map((q) => q.value.cooked).join('');
  }
  if (node.type === 'BinaryExpression' && node.operator === '+') {
    const left = foldString(node.left);
    const right = foldString(node.right);
    return left != null && right != null ? left + right : null;
  }
  return null;
}

/** Flatten `a.b.c` to "a.b.c", or null when it is computed (`a[x]`). */
function memberPath(node) {
  const parts = [];
  let cur = node;
  while (cur && cur.type === 'MemberExpression') {
    if (cur.computed) return null;
    if (cur.property.type !== 'Identifier') return null;
    parts.unshift(cur.property.name);
    cur = cur.object;
  }
  if (!cur || cur.type !== 'Identifier') return null;
  parts.unshift(cur.name);
  return parts.join('.');
}

/**
 * Collect every name bound anywhere in the file.
 *
 * Used ONLY to decide whether a name that is not on the allowlist is really a
 * local. It is deliberately NOT used to excuse a FORBIDDEN name any more:
 * `onTick(ctx, t, fetch = fetch)` binds `fetch` while the default value
 * captures the real global, and the shadowing exemption then waved it through.
 * An exemption that is itself the attack is not an exemption.
 */
function collectBindings(ast) {
  return new Set(bindingCounts(ast).keys());
}

/** How many times each name is bound in the file — collectBindings, counted. */
function bindingCounts(ast) {
  const counts = new Map();
  const bound = { add: (n) => counts.set(n, (counts.get(n) ?? 0) + 1) };
  const addPattern = (p) => {
    if (!p) return;
    switch (p.type) {
      case 'Identifier': bound.add(p.name); break;
      case 'ObjectPattern': for (const prop of p.properties) addPattern(prop.value ?? prop.argument); break;
      case 'ArrayPattern': for (const el of p.elements) addPattern(el); break;
      case 'AssignmentPattern': addPattern(p.left); break;
      case 'RestElement': addPattern(p.argument); break;
      default: break;
    }
  };
  walk(ast, (n) => {
    if (n.type === 'VariableDeclarator') addPattern(n.id);
    else if (n.type === 'ClassDeclaration' || n.type === 'ClassExpression') { if (n.id) bound.add(n.id.name); }
    // A function declaration binds its own name AND its parameters. Missing the
    // parameters made `function f(Date) { return Date + 1 }` read as a wall-clock
    // access — a false positive, which is the expensive kind here.
    else if (n.type === 'FunctionDeclaration' || n.type === 'FunctionExpression'
      || n.type === 'ArrowFunctionExpression') {
      if (n.id) bound.add(n.id.name);
      for (const p of n.params) addPattern(p);
    } else if (n.type === 'CatchClause') addPattern(n.param);
    else if (n.type === 'ImportDefaultSpecifier' || n.type === 'ImportSpecifier' || n.type === 'ImportNamespaceSpecifier') {
      bound.add(n.local.name);
    } else if (n.type === 'ClassMethod' || n.type === 'MethodDefinition') {
      const fn = n.value;
      if (fn?.params) for (const p of fn.params) addPattern(p);
    } else if (n.type === 'PropertyDefinition' && n.value?.params) {
      for (const p of n.value.params) addPattern(p);
    }
  });
  return counts;
}

/**
 * Every `ctx.ref(...)` / `ctx.ext(...)` whose argument is known here.
 *
 * Only in the entry class's own declared hook methods — the one place the
 * runner is known to pass the context — on the hook's first parameter, and
 * only if that parameter is never rebound in the method: a helper with a
 * `.ref` method of its own must not be mistaken for the context. Known means a constant string, or a top-level `const` bound to one
 * and bound nowhere else in the file. Anything less certain is skipped — what
 * this reports can reject a submission.
 */
function feedCalls(ast, name, entryClass, hookMethods) {
  const counts = bindingCounts(ast);
  const consts = new Map();
  for (const stmt of ast.body) {
    const decl = stmt.type === 'ExportNamedDeclaration' ? stmt.declaration : stmt;
    if (decl?.type !== 'VariableDeclaration' || decl.kind !== 'const') continue;
    for (const d of decl.declarations) {
      if (d.id.type !== 'Identifier' || counts.get(d.id.name) !== 1) continue;
      const v = foldString(d.init);
      if (v != null) consts.set(d.id.name, v);
    }
  }
  const found = [];
  const hooks = new Set(hookMethods);
  // The runner takes the module's EXPORT of that name. Only a class that is
  // the sole binding of the name, and that no `export { X as S }` can replace,
  // is certainly the one run.
  if (counts.get(entryClass) !== 1) return found;
  let aliased = false;
  walk(ast, (n) => {
    if (n.type === 'ExportSpecifier' && n.exported?.name === entryClass && n.local?.name !== entryClass) aliased = true;
  });
  if (aliased) return found;
  const entry = ast.body
    .map((stmt) => (stmt.type === 'ExportNamedDeclaration' || stmt.type === 'ExportDefaultDeclaration'
      ? stmt.declaration : stmt))
    .find((d) => d && (d.type === 'ClassDeclaration' || d.type === 'ClassExpression') && d.id?.name === entryClass);
  if (!entry) return found;
  // `this.onTick = ...` anywhere replaces the method the runner would call.
  const assignedProps = new Set();
  walk(ast, (n) => {
    if (n.type === 'AssignmentExpression' && n.left.type === 'MemberExpression') {
      const p = n.left.computed ? foldString(n.left.property) : n.left.property.name;
      if (p != null) assignedProps.add(p);
    }
  });
  // Every spelling of a member name counts: `onTick`, `"onTick"`, `["onTick"]`.
  // A computed key that cannot be folded could be any name, so the class is
  // skipped outright.
  const memberCount = new Map();
  for (const m of entry.body.body) {
    if (!m.key) continue;
    const k = m.computed ? foldString(m.key)
      : m.key.type === 'Identifier' ? m.key.name
        : m.key.type === 'Literal' ? String(m.key.value) : null;
    if (k == null) {
      if (m.computed) return found;
      continue;
    }
    memberCount.set(k, (memberCount.get(k) ?? 0) + 1);
  }
  for (const m of entry.body.body) {
    if (m.type !== 'MethodDefinition' || m.kind !== 'method' || m.static || m.computed) continue;
    if (m.key.type !== 'Identifier' || !hooks.has(m.key.name)) continue;
    // Only a hook whose definition is certainly the one dispatched.
    if (memberCount.get(m.key.name) !== 1 || assignedProps.has(m.key.name)) continue;
    const ctxParam = m.value.params[0];
    if (ctxParam?.type !== 'Identifier') continue;
    const ctxName = ctxParam.name;
    if (bindingCounts(m.value).get(ctxName) !== 1) continue;
    // A declaration count does not see `ctx = other`; any assignment to the
    // name, plain or destructuring, and the method is skipped.
    let reassigned = false;
    const hits = (p) => {
      if (!p) return false;
      switch (p.type) {
        case 'Identifier': return p.name === ctxName;
        case 'ObjectPattern': return p.properties.some((x) => hits(x.value ?? x.argument));
        case 'ArrayPattern': return p.elements.some(hits);
        case 'AssignmentPattern': return hits(p.left);
        case 'RestElement': return hits(p.argument);
        default: return false;
      }
    };
    walk(m.value.body, (n) => {
      if ((n.type === 'AssignmentExpression' && hits(n.left))
        || (n.type === 'UpdateExpression' && hits(n.argument))
        || ((n.type === 'ForInStatement' || n.type === 'ForOfStatement') && hits(n.left))) reassigned = true;
    });
    if (reassigned) continue;
    walk(m.value.body, (n) => {
      if (n.type !== 'CallExpression' || n.callee.type !== 'MemberExpression') return;
      const { object, property, computed } = n.callee;
      const method = computed ? foldString(property) : property.name;
      if ((method !== 'ref' && method !== 'ext')) return;
      if (object.type !== 'Identifier' || object.name !== ctxName) return;
      if (n.arguments.length !== 1) return;
      const arg = n.arguments[0];
      const value = arg.type === 'Identifier' ? consts.get(arg.name) ?? null : foldString(arg);
      if (value == null) return;
      found.push({ kind: method, name: value, file: name, line: n.loc?.start?.line ?? null });
    });
  }
  return found.sort((a, b) => (a.line ?? 0) - (b.line ?? 0));
}

/**
 * Analyse one JavaScript source file.
 *
 * @param {string} source
 * @param {string} name       file name, for the error message
 * @param {string[]} allowedDeps  package names the manifest declared
 * @returns {{imports: string[], feeds: {kind: string, name: string, file: string, line: number|null}[]}}
 * @throws {BacktestRejection}
 */
export function analyzeJavaScript(source, name, allowedDeps = [], { entryClass = null, hookMethods = [] } = {}) {
  let ast;
  try {
    ast = parse(source, { ecmaVersion: 2023, sourceType: 'module', locations: true });
  } catch (err) {
    throw new BacktestRejection('E_ENTRY', `${name}: ${err.message}`);
  }

  const bound = collectBindings(ast);
  const imports = [];
  const at = (n) => `${name}:${n.loc?.start?.line ?? '?'}`;

  walk(ast, (node, parent) => {
    // ---- imports ----
    if (node.type === 'ImportDeclaration' || node.type === 'ExportAllDeclaration'
      || (node.type === 'ExportNamedDeclaration' && node.source)) {
      const spec = node.source.value;
      imports.push(spec);
      // Relative imports are the submitter's own files, checked separately
      // against the submitted file list.
      if (String(spec).startsWith('.')) return;
      if (spec === 'outcometick') return;
      if (!allowedDeps.includes(spec)) {
        throw new BacktestRejection('E_IMPORT',
          `${at(node)}: import of ${JSON.stringify(spec)} is not on the allowlist`
          + (allowedDeps.length ? `; declared deps are ${allowedDeps.join(', ')}` : ' and no deps were declared'),
          { file: name, line: node.loc?.start?.line ?? null, specifier: spec });
      }
      return;
    }

    // A dynamic import takes a runtime expression, so no static analysis can
    // say what it loads. Refused rather than approximated.
    if (node.type === 'ImportExpression') {
      throw new BacktestRejection('E_FORBIDDEN',
        `${at(node)}: dynamic import() escapes static analysis`,
        { file: name, line: node.loc?.start?.line ?? null });
    }

    if (node.type === 'MetaProperty') {
      throw new BacktestRejection('E_FORBIDDEN',
        `${at(node)}: import.meta exposes the filesystem and the module loader`,
        { file: name, line: node.loc?.start?.line ?? null });
    }

    // ---- member expressions ----
    if (node.type === 'MemberExpression') {
      // Reached by name (`x.constructor`) or by computed string
      // (`x["constructor"]`) — both are the same door.
      const prop = node.computed
        ? foldString(node.property)
        : (node.property.type === 'Identifier' ? node.property.name : null);
      if (prop && FORBIDDEN_PROPERTIES.has(prop)) {
        throw new BacktestRejection('E_FORBIDDEN',
          `${at(node)}: .${prop} — reaches the runtime through the language's own machinery`,
          { file: name, line: node.loc?.start?.line ?? null });
      }
      // Reflective escape hatches on Object, by allowlist.
      if (!node.computed && node.object.type === 'Identifier'
        && node.object.name === 'Object' && !bound.has('Object')
        && prop && !OBJECT_METHODS.has(prop)) {
        throw new BacktestRejection('E_FORBIDDEN',
          `${at(node)}: Object.${prop} — reflection reaches the runtime through the`
          + ` prototype chain. Available: ${[...OBJECT_METHODS].join(', ')}.`,
          { file: name, line: node.loc?.start?.line ?? null });
      }

      const path = memberPath(node);
      if (path && FORBIDDEN_MEMBERS.has(path) && !bound.has(path.split('.')[0])) {
        throw new BacktestRejection('E_NONDETERMINISM',
          `${at(node)}: ${path} — ${FORBIDDEN_MEMBERS.get(path)}`,
          { file: name, line: node.loc?.start?.line ?? null });
      }
      return;
    }

    // ---- bare identifiers ----
    if (node.type !== 'Identifier') return;
    // Property names, labels, keys and declarations are not references.
    if (parent?.type === 'MemberExpression' && parent.property === node && !parent.computed) return;
    if (parent?.type === 'Property' && parent.key === node && !parent.computed) return;
    if (parent?.type === 'PropertyDefinition' && parent.key === node && !parent.computed) return;
    if (parent?.type === 'MethodDefinition' && parent.key === node && !parent.computed) return;
    if (parent?.type === 'LabeledStatement' || parent?.type === 'BreakStatement' || parent?.type === 'ContinueStatement') return;

    // Checked BEFORE the `bound` exemption, and regardless of it — a parameter
    // or local named after a forbidden global is refused wherever it appears.
    // The cost is a false positive on `function f(Date) {…}`, which renames in
    // one keystroke; the alternative is a documented way out of the allowlist.
    if (FORBIDDEN_IDENTIFIERS.has(node.name)) {
      throw new BacktestRejection('E_FORBIDDEN',
        `${at(node)}: ${node.name} — ${FORBIDDEN_IDENTIFIERS.get(node.name)}.`
        + ' It cannot be used as a name either; rename the variable or parameter.',
        { file: name, line: node.loc?.start?.line ?? null });
    }
    if (NONDETERMINISTIC.has(node.name)) {
      throw new BacktestRejection('E_NONDETERMINISM',
        `${at(node)}: ${node.name} — ${NONDETERMINISTIC.get(node.name)}.`
        + ' It cannot be used as a name either; rename the variable or parameter.',
        { file: name, line: node.loc?.start?.line ?? null });
    }

    if (bound.has(node.name)) return;
    // An ALLOWLIST, not a denylist. ALLOWED_GLOBALS was previously declared and
    // never consulted, which meant every global nobody had thought to name —
    // Reflect, Proxy, WebAssembly, Intl, Atomics via another spelling — passed
    // straight through. Enumerating what is permitted is the only version of
    // this that does not lose to the next name someone thinks of.
    if (!ALLOWED_GLOBALS.has(node.name)) {
      throw new BacktestRejection('E_FORBIDDEN',
        `${at(node)}: ${node.name} is not available; a strategy reaches the outside only through ctx`,
        { file: name, line: node.loc?.start?.line ?? null });
    }
  });

  return { imports, feeds: entryClass ? feedCalls(ast, name, entryClass, hookMethods) : [] };
}

/**
 * Analyse a whole submission, and check that relative imports resolve to files
 * that were actually submitted.
 *
 * A relative import of a file that is not there fails at run time, after the
 * credits are held. Catching it here keeps the "a rejection costs nothing"
 * promise true.
 */
export function analyzeJavaScriptSubmission(files, { deps = [], entry = null, hookMethods = [] } = {}) {
  const names = new Set(files.map((f) => f.name));
  const all = [];
  const feeds = [];
  for (const f of files) {
    if (!/\.(mjs|js)$/.test(f.name)) continue;
    const { imports, feeds: fileFeeds } = analyzeJavaScript(f.content, f.name, deps,
      entry && f.name === entry.file ? { entryClass: entry.className, hookMethods } : {});
    feeds.push(...fileFeeds);
    for (const spec of imports) {
      if (!String(spec).startsWith('.')) continue;
      const resolved = spec.replace(/^\.\//, '');
      const candidates = [resolved, `${resolved}.mjs`, `${resolved}.js`];
      if (!candidates.some((c) => names.has(c))) {
        throw new BacktestRejection('E_ENTRY',
          `${f.name} imports ${JSON.stringify(spec)}, which was not submitted`,
          { file: f.name, specifier: spec });
      }
    }
    all.push(...imports);
  }
  return { imports: [...new Set(all)], feeds };
}
